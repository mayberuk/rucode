import { describe, expect, it, vi } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type Project,
  ProjectId,
  type ProjectScript,
  ProviderInstanceId,
  TextGenerationError,
} from "@t3tools/contracts";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as Ledger from "./ProjectActionSuggestionLedger.ts";
import * as Suggestions from "./ProjectActionSuggestions.ts";

const platform = Layer.merge(NodeServices.layer, NodeCrypto.layer);
const projectId = ProjectId.make("acme-app");
const otherProjectId = ProjectId.make("acme-tools");
const auto = { projectId, trigger: "auto" } as const;
const manual = { projectId, trigger: "manual" } as const;
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "acme-model",
};
const projectTest = { name: "Run Tests", command: "npm test", icon: "test" } as const;
const projectBuild = { name: "Build App", command: "npm run build", icon: "build" } as const;
const projectLint = { name: "Run Lint", command: "npm run lint", icon: "lint" } as const;
const expectedTest = {
  ...projectTest,
  id: "run-tests",
  runOnWorktreeCreate: false,
  runOnSettle: false,
  stopOnSettle: false,
} satisfies ProjectScript;
const existingTest = { ...expectedTest, id: "existing-test", runOnSettle: true };
const expectedBuild = {
  ...projectBuild,
  id: "build-app",
  runOnWorktreeCreate: false,
  runOnSettle: false,
  stopOnSettle: false,
} satisfies ProjectScript;
const expectedLint = {
  ...projectLint,
  id: "run-lint",
  runOnWorktreeCreate: false,
  runOnSettle: false,
  stopOnSettle: false,
} satisfies ProjectScript;

type Generate = NonNullable<TextGeneration.TextGeneration["Service"]["generateProjectActions"]>;

const makeHarness = Effect.fn("ProjectActionSuggestionsTest.makeHarness")(function* (
  options: {
    readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
    readonly generate?: Generate;
    readonly unsupported?: boolean;
    readonly scripts?: readonly ProjectScript[];
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "project-action-suggestions-" });
  const workspaceRoot = path.join(directory, "acme-app");
  yield* fs.makeDirectory(workspaceRoot);
  yield* fs.writeFileString(
    path.join(workspaceRoot, "package.json"),
    JSON.stringify({ packageManager: "npm@11.0.0", scripts: { test: "node --test" } }),
  );
  const ledgerPath = path.join(directory, "project-action-suggestions.json");
  const project: Project = {
    id: projectId,
    title: "Acme App",
    workspaceRoot,
    defaultModelSelection: null,
    scripts: options.scripts ?? [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };
  const generate = vi.fn<Generate>(
    options.generate ?? (() => Effect.succeed({ actions: [projectTest] })),
  );
  const getById = vi.fn<ProjectService.ProjectService["Service"]["getById"]>((id) => {
    if (id === projectId) return Effect.succeedSome(project);
    if (id === otherProjectId) return Effect.succeedSome({ ...project, id: otherProjectId });
    return Effect.succeedNone;
  });
  const unusedGeneration = () => Effect.die("Unexpected text generation operation");
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectService.ProjectService)({ getById }),
    Layer.succeed(TextGeneration.TextGeneration, {
      generateBranchName: unusedGeneration,
      generateCommitMessage: unusedGeneration,
      generatePrContent: unusedGeneration,
      generateReviewGuide: unusedGeneration,
      generateThreadTitle: unusedGeneration,
      generateTranscriptionPostProcessing: unusedGeneration,
      ...(options.unsupported ? {} : { generateProjectActions: generate }),
    }),
    ServerSettings.layerTest(options.settings),
  );
  return {
    generate,
    getById,
    ledgerPath,
    project,
    layer: Suggestions.layer.pipe(
      Layer.provideMerge(Ledger.layerAt(ledgerPath)),
      Layer.provideMerge(dependencies),
    ),
  };
});

const readScripts = Effect.fn("ProjectActionSuggestionsTest.readScripts")(function* (
  project: Project,
) {
  const settings = yield* ServerSettings.ServerSettingsService;
  return resolveProjectScripts(yield* settings.getSettings, project);
});

describe("ProjectActionSuggestions", () => {
  it.effect("offers an empty project with its summary and writes at most three inert actions", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        settings: {
          projectSettingsOverrides: {
            [projectId]: { textGenerationModelSelection: modelSelection },
          },
        },
        generate: () =>
          Effect.succeed({
            actions: [
              { name: "Check App", command: "npm run check", icon: "unknown" },
              projectTest,
              projectBuild,
              projectLint,
              { name: "Start App", command: "npm run dev", icon: "play" },
            ],
          }),
      });
      yield* Effect.gen(function* () {
        const service = yield* Suggestions.ProjectActionSuggestions;
        const ledger = yield* Ledger.ProjectActionSuggestionLedger;
        const scripts = [expectedTest, expectedBuild, expectedLint];
        expect(yield* service.suggest(auto)).toStrictEqual({ _tag: "Added", scripts });
        expect(yield* readScripts(harness.project)).toEqual(scripts);
        expect(yield* ledger.has(projectId)).toBe(true);
        expect(harness.generate.mock.calls).toEqual([
          [
            {
              cwd: harness.project.workspaceRoot,
              projectName: "Acme App",
              projectContext:
                "Project: acme-app\n\nPackage manager: npm\n\npackage.json scripts:\ntest: node --test",
              existingCommands: [],
              modelSelection,
              projectId,
            },
          ],
        ]);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(platform)),
  );

  it.effect("skips a repeat automatic request after Undo, including after a restart", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const service = yield* Suggestions.ProjectActionSuggestions;
        const settings = yield* ServerSettings.ServerSettingsService;
        expect(yield* service.suggest(auto)).toEqual({ _tag: "Added", scripts: [expectedTest] });
        yield* settings.updateSettings({
          projectSettingsOverrides: { [projectId]: { defaultProjectScripts: [] } },
        });
        expect(yield* service.suggest(auto)).toEqual({
          _tag: "Skipped",
          reason: "already-offered",
        });
        const restarted = yield* Suggestions.ProjectActionSuggestions.pipe(
          Effect.flatMap((suggestions) => suggestions.suggest(auto)),
          Effect.provide(Suggestions.layer.pipe(Layer.provide(Ledger.layerAt(harness.ledgerPath)))),
        );
        expect(restarted).toEqual({ _tag: "Skipped", reason: "already-offered" });
        expect(yield* readScripts(harness.project)).toEqual([]);
        expect(harness.generate).toHaveBeenCalledTimes(1);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(platform)),
  );

  it.effect("records an automatic skip when the project already has actions", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        settings: { projectSettingsFolded: false },
        scripts: [existingTest],
      });
      yield* Effect.gen(function* () {
        const service = yield* Suggestions.ProjectActionSuggestions;
        const ledger = yield* Ledger.ProjectActionSuggestionLedger;
        expect(yield* service.suggest(auto)).toEqual({ _tag: "Skipped", reason: "has-actions" });
        expect(yield* ledger.has(projectId)).toBe(true);
        expect(yield* readScripts(harness.project)).toEqual([existingTest]);
        expect(harness.generate).toHaveBeenCalledTimes(0);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(platform)),
  );

  it.effect.each([
    { name: "environment", settings: { suggestProjectActions: false } },
    {
      name: "project",
      settings: {
        suggestProjectActions: true,
        projectSettingsOverrides: { [projectId]: { suggestProjectActions: false } },
      },
    },
  ])("skips both triggers when disabled for the $name", ({ settings }) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ settings });
      yield* Effect.gen(function* () {
        const service = yield* Suggestions.ProjectActionSuggestions;
        const ledger = yield* Ledger.ProjectActionSuggestionLedger;
        expect(yield* service.suggest(auto)).toEqual({ _tag: "Skipped", reason: "disabled" });
        expect(yield* service.suggest(manual)).toEqual({ _tag: "Skipped", reason: "disabled" });
        expect(yield* ledger.has(projectId)).toBe(false);
        expect(harness.getById).toHaveBeenCalledTimes(0);
        expect(harness.generate).toHaveBeenCalledTimes(0);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(platform)),
  );

  it.effect("honors a project's opt-in over an environment opt-out", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        settings: {
          suggestProjectActions: false,
          projectSettingsOverrides: { [projectId]: { suggestProjectActions: true } },
        },
      });
      yield* Effect.gen(function* () {
        const service = yield* Suggestions.ProjectActionSuggestions;
        expect(yield* service.suggest(auto)).toEqual({ _tag: "Added", scripts: [expectedTest] });
        expect(harness.generate).toHaveBeenCalledTimes(1);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(platform)),
  );

  it.effect("manually appends only unique actions after an automatic offer", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        settings: {
          projectSettingsOverrides: {
            [projectId]: { suggestProjectActions: true, defaultProjectScripts: [existingTest] },
          },
        },
        generate: () =>
          Effect.succeed({
            actions: [
              { ...projectTest, name: "Check App" },
              { ...projectTest, name: "RUN TESTS", command: "npm run check" },
              projectBuild,
              { ...projectBuild, name: "Compile App" },
            ],
          }),
      });
      yield* Effect.gen(function* () {
        const service = yield* Suggestions.ProjectActionSuggestions;
        const settings = yield* ServerSettings.ServerSettingsService;
        expect(yield* service.suggest(auto)).toEqual({ _tag: "Skipped", reason: "has-actions" });
        expect(yield* service.suggest(manual)).toEqual({ _tag: "Added", scripts: [expectedBuild] });
        expect(yield* readScripts(harness.project)).toEqual([existingTest, expectedBuild]);
        expect((yield* settings.getSettings).projectSettingsOverrides[projectId]).toEqual({
          suggestProjectActions: true,
          defaultProjectScripts: [existingTest, expectedBuild],
        });
        expect(harness.generate).toHaveBeenCalledTimes(1);
        expect(harness.generate.mock.calls[0]?.[0].existingCommands).toEqual(["npm test"]);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(platform)),
  );

  it.effect.each([
    { name: "empty output", actions: [] },
    { name: "rejected output", actions: [{ ...projectTest, icon: "unknown" }] },
  ])("returns NoneFound for $name without writing a project override", ({ actions }) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ generate: () => Effect.succeed({ actions }) });
      yield* Effect.gen(function* () {
        const service = yield* Suggestions.ProjectActionSuggestions;
        const ledger = yield* Ledger.ProjectActionSuggestionLedger;
        const settings = yield* ServerSettings.ServerSettingsService;
        using updateSettings = vi.spyOn(settings, "updateSettings");
        expect(yield* service.suggest(manual)).toEqual({ _tag: "NoneFound" });
        expect((yield* settings.getSettings).projectSettingsOverrides).toEqual({});
        expect(updateSettings).not.toHaveBeenCalled();
        expect(yield* ledger.has(projectId)).toBe(true);
        expect(yield* service.suggest(auto)).toEqual({
          _tag: "Skipped",
          reason: "already-offered",
        });
        expect(harness.generate).toHaveBeenCalledTimes(1);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(platform)),
  );

  it.effect.each([
    {
      name: "model failure",
      request: auto,
      scripts: [],
      detail: "Model unavailable.",
    },
    {
      name: "invalid structured output",
      request: manual,
      scripts: [existingTest],
      detail: "Invalid structured output.",
    },
  ])("preserves actions and the offer after $name", ({ scripts, request, detail }) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        settings: { defaultProjectScripts: scripts },
        generate: () =>
          Effect.fail(new TextGenerationError({ operation: "generateProjectActions", detail })),
      });
      yield* Effect.gen(function* () {
        const service = yield* Suggestions.ProjectActionSuggestions;
        const ledger = yield* Ledger.ProjectActionSuggestionLedger;
        expect(yield* service.suggest(request).pipe(Effect.flip)).toMatchObject({
          _tag: "ProjectActionsSuggestError",
          message: detail,
        });
        expect(yield* readScripts(harness.project)).toEqual(scripts);
        expect(yield* ledger.has(projectId)).toBe(true);
        expect(yield* service.suggest(auto)).toEqual({
          _tag: "Skipped",
          reason: "already-offered",
        });
        expect(harness.generate).toHaveBeenCalledTimes(1);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(platform)),
  );

  it.effect("returns a typed error when the generator lacks action support", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ unsupported: true });
      yield* Effect.gen(function* () {
        const service = yield* Suggestions.ProjectActionSuggestions;
        const ledger = yield* Ledger.ProjectActionSuggestionLedger;
        expect(yield* service.suggest(manual).pipe(Effect.flip)).toMatchObject({
          _tag: "ProjectActionsSuggestError",
          message:
            "This model's provider cannot suggest project actions. Choose another model for generated text in Settings.",
        });
        expect(yield* readScripts(harness.project)).toEqual([]);
        expect(yield* ledger.has(projectId)).toBe(true);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(platform)),
  );

  it.effect("does not record or call the model for a missing project", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const service = yield* Suggestions.ProjectActionSuggestions;
        const ledger = yield* Ledger.ProjectActionSuggestionLedger;
        const missing = ProjectId.make("acme-missing");
        expect(
          yield* service.suggest({ ...manual, projectId: missing }).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "ProjectActionsSuggestError",
          message: "Project not found.",
        });
        expect(yield* ledger.has(missing)).toBe(false);
        expect(harness.generate).toHaveBeenCalledTimes(0);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(platform)),
  );

  it.effect("marks the offer before generation and skips a second call for the same project", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        generate: (input) =>
          input.projectId === projectId
            ? Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(finish)),
                Effect.as({ actions: [projectTest] }),
              )
            : Effect.succeed({ actions: [projectBuild] }),
      });
      yield* Effect.gen(function* () {
        const service = yield* Suggestions.ProjectActionSuggestions;
        const ledger = yield* Ledger.ProjectActionSuggestionLedger;
        const first = yield* service.suggest(auto).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        expect(yield* ledger.has(projectId)).toBe(true);
        expect(yield* service.suggest(manual)).toEqual({ _tag: "Skipped", reason: "in-progress" });
        expect(harness.generate).toHaveBeenCalledTimes(1);
        expect(yield* service.suggest({ ...manual, projectId: otherProjectId })).toEqual({
          _tag: "Added",
          scripts: [expectedBuild],
        });
        yield* Deferred.succeed(finish, undefined);
        expect(yield* Fiber.join(first)).toEqual({ _tag: "Added", scripts: [expectedTest] });
        expect(harness.generate).toHaveBeenCalledTimes(2);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(platform)),
  );

  it.effect("allows a manual retry after the running request is interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        generate: () => Effect.succeed({ actions: [projectTest] }),
      });
      harness.generate.mockImplementationOnce(() =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      );
      yield* Effect.gen(function* () {
        const service = yield* Suggestions.ProjectActionSuggestions;
        const first = yield* service.suggest(auto).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(first);
        expect(yield* service.suggest(auto)).toEqual({
          _tag: "Skipped",
          reason: "already-offered",
        });
        expect(yield* service.suggest(manual)).toEqual({ _tag: "Added", scripts: [expectedTest] });
        expect(harness.generate).toHaveBeenCalledTimes(2);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(platform)),
  );

  it.effect.each([
    { name: "some", actions: [projectTest, projectBuild], added: [expectedBuild] },
    { name: "all", actions: [projectTest], added: [] },
  ])(
    "keeps edits made during generation when $name suggestions become duplicates",
    ({ actions, added }) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          generate: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
              Effect.as({ actions }),
            ),
        });
        yield* Effect.gen(function* () {
          const service = yield* Suggestions.ProjectActionSuggestions;
          const settings = yield* ServerSettings.ServerSettingsService;
          const running = yield* service.suggest(manual).pipe(Effect.forkScoped);
          yield* Deferred.await(started);
          const edited = { suggestProjectActions: true, defaultProjectScripts: [existingTest] };
          yield* settings.updateSettings({ projectSettingsOverrides: { [projectId]: edited } });
          using updateSettings = vi.spyOn(settings, "updateSettings");
          yield* Deferred.succeed(finish, undefined);
          expect(yield* Fiber.join(running)).toEqual(
            added.length === 0 ? { _tag: "NoneFound" } : { _tag: "Added", scripts: added },
          );
          expect((yield* settings.getSettings).projectSettingsOverrides[projectId]).toEqual({
            ...edited,
            defaultProjectScripts: [existingTest, ...added],
          });
          expect(updateSettings).toHaveBeenCalledTimes(added.length === 0 ? 0 : 1);
        }).pipe(Effect.provide(harness.layer));
      }).pipe(Effect.provide(platform)),
  );
});

describe("ProjectActionSuggestionLedger", () => {
  it.effect.each([
    { name: "a missing file", contents: undefined },
    { name: "malformed JSON", contents: "{" },
    { name: "an invalid ledger", contents: '{"offered":{"acme-app":123}}' },
  ])("reads $name as empty and saves offers with ISO times", ({ contents }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "project-action-ledger-" });
      const ledgerPath = path.join(root, "project-action-suggestions.json");
      if (contents !== undefined) yield* fs.writeFileString(ledgerPath, contents);
      yield* TestClock.setTime(0);
      yield* Effect.gen(function* () {
        const ledger = yield* Ledger.ProjectActionSuggestionLedger;
        expect(yield* ledger.has(projectId)).toBe(false);
        yield* Effect.all([ledger.record(projectId), ledger.record(otherProjectId)], {
          concurrency: "unbounded",
        });
        expect(JSON.parse(yield* fs.readFileString(ledgerPath))).toEqual({
          offered: {
            "acme-app": "1970-01-01T00:00:00.000Z",
            "acme-tools": "1970-01-01T00:00:00.000Z",
          },
        });
        expect(yield* ledger.has(projectId)).toBe(true);
        expect(yield* ledger.has(otherProjectId)).toBe(true);
        expect(yield* fs.readDirectory(root)).toEqual(["project-action-suggestions.json"]);
      }).pipe(Effect.provide(Ledger.layerAt(ledgerPath)));
    }).pipe(Effect.provide(platform)),
  );

  it.effect("continues to suggest when the ledger file cannot be replaced", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const harness = yield* makeHarness();
      yield* fs.makeDirectory(harness.ledgerPath);
      yield* Effect.gen(function* () {
        const service = yield* Suggestions.ProjectActionSuggestions;
        const ledger = yield* Ledger.ProjectActionSuggestionLedger;
        expect(yield* service.suggest(auto)).toEqual({ _tag: "Added", scripts: [expectedTest] });
        expect(yield* readScripts(harness.project)).toEqual([expectedTest]);
        expect(yield* ledger.has(projectId)).toBe(false);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(platform)),
  );
});
