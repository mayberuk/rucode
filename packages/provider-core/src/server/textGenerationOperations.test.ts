import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderInstallationGate from "../../../../apps/server/src/provider/ProviderInstallationGate.ts";
import * as ProviderInstanceRegistry from "../../../../apps/server/src/provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../../../../apps/server/src/serverSettings.ts";
import * as SourceControlProviderRegistry from "../../../../apps/server/src/sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "../../../../apps/server/src/textGeneration/TextGeneration.ts";
import * as TextGenerators from "../../../../apps/server/src/textGeneration/TextGenerators.ts";
import type { ProviderInstance } from "./driver.ts";
import { decodeJsonReply, fromRunner } from "./textGenerationOperations.ts";
import { ProjectActionsOutput } from "./textGenerationPrompts.ts";

// regression: #23726 a reply that echoes the schema key replaced the seed title with "title"
it.effect("fails a thread title reply that is only the schema key", () =>
  Effect.gen(function* () {
    const textGeneration = fromRunner("Stub", (request) =>
      decodeJsonReply(request, "Stub", '{"title":"title","needsRefinement":false}'),
    );

    const outcome = yield* textGeneration
      .generateThreadTitle({
        cwd: process.cwd(),
        message: "$implement Issue #140",
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: "anthropic/claude-haiku-4-5",
        },
      })
      .pipe(Effect.match({ onFailure: (error) => error, onSuccess: (result) => result }));

    assert.instanceOf(outcome, TextGenerationError);
    assert.strictEqual(outcome.operation, "generateThreadTitle");
  }),
);

const projectActionsInput = {
  cwd: "/home/user/acme/app",
  projectName: "acme-app",
  projectContext: "package.json scripts\ndev: acme-dev\ntest: acme-test\nbuild: acme-build",
  existingCommands: ["pnpm run lint"],
  modelSelection: { instanceId: ProviderInstanceId.make("acme-provider"), model: "acme-model" },
};

it.effect("sends the project actions request once and trims both ends of every field", () =>
  Effect.gen(function* () {
    let requests = 0;
    const textGeneration = fromRunner("TextGenerator", (request) => {
      requests += 1;
      assert.strictEqual(request.operation, "generateProjectActions");
      assert.strictEqual(request.cwd, "/home/user/acme/app");
      assert.deepEqual(request.modelSelection, {
        instanceId: ProviderInstanceId.make("acme-provider"),
        model: "acme-model",
      });
      assert.include(
        request.prompt,
        "BEGIN PROJECT CONTEXT\npackage.json scripts\ndev: acme-dev\ntest: acme-test\nbuild: acme-build\nEND PROJECT CONTEXT",
      );
      assert.include(request.prompt, '"pnpm run lint"');
      assert.strictEqual<unknown>(request.outputSchema, ProjectActionsOutput);
      return decodeJsonReply(
        request,
        "Stub",
        '{"actions":[{"name":"  Start App  ","command":"  pnpm run dev  ","icon":"  play  "},{"name":"  Run Tests  ","command":"  pnpm run test  ","icon":"  test  "},{"name":"  Build App  ","command":"  pnpm run build  ","icon":"  build  "}]}',
      );
    });

    assert.deepEqual(yield* textGeneration.generateProjectActions(projectActionsInput), {
      actions: [
        { name: "Start App", command: "pnpm run dev", icon: "play" },
        { name: "Run Tests", command: "pnpm run test", icon: "test" },
        { name: "Build App", command: "pnpm run build", icon: "build" },
      ],
    });
    assert.strictEqual(requests, 1);
  }),
);

it.effect("returns an empty action list from a valid reply", () =>
  Effect.gen(function* () {
    const textGeneration = fromRunner("TextGenerator", (request) =>
      decodeJsonReply(request, "Stub", '{"actions":[]}'),
    );

    assert.deepEqual(yield* textGeneration.generateProjectActions(projectActionsInput), {
      actions: [],
    });
  }),
);

it.effect("preserves all four schema-valid entries including duplicate and unknown icons", () =>
  Effect.gen(function* () {
    const textGeneration = fromRunner("TextGenerator", (request) =>
      decodeJsonReply(
        request,
        "Stub",
        '{"actions":[{"name":"Run Tests","command":"make test","icon":"test"},{"name":"Run Tests","command":"make test","icon":"test"},{"name":"Lint App","command":"make lint","icon":"unknown"},{"name":" ","command":" ","icon":" "}]}',
      ),
    );

    assert.deepEqual(yield* textGeneration.generateProjectActions(projectActionsInput), {
      actions: [
        { name: "Run Tests", command: "make test", icon: "test" },
        { name: "Run Tests", command: "make test", icon: "test" },
        { name: "Lint App", command: "make lint", icon: "unknown" },
        { name: "", command: "", icon: "" },
      ],
    });
  }),
);

it.effect(
  "sends repeated concurrent project actions requests independently through the runner",
  () =>
    Effect.gen(function* () {
      let requests = 0;
      const textGeneration = fromRunner("TextGenerator", (request) => {
        requests += 1;
        return decodeJsonReply(
          request,
          "Stub",
          '{"actions":[{"name":"Start App","command":"pnpm run dev","icon":"play"}]}',
        );
      });

      assert.deepEqual(
        yield* Effect.all(
          [
            textGeneration.generateProjectActions(projectActionsInput),
            textGeneration.generateProjectActions(projectActionsInput),
          ],
          { concurrency: 2 },
        ),
        [
          { actions: [{ name: "Start App", command: "pnpm run dev", icon: "play" }] },
          { actions: [{ name: "Start App", command: "pnpm run dev", icon: "play" }] },
        ],
      );
      assert.strictEqual(requests, 2);
    }),
);

it.effect.each([
  ["non-JSON text", "No structured reply"],
  ["empty text", ""],
  ["broken JSON", '{"actions":[}'],
  ["missing actions", "{}"],
  ["non-array actions", '{"actions":{}}'],
  ["missing name", '{"actions":[{"command":"make test","icon":"test"}]}'],
  ["missing command", '{"actions":[{"name":"Run Tests","icon":"test"}]}'],
  ["missing icon", '{"actions":[{"name":"Run Tests","command":"make test"}]}'],
  ["non-string name", '{"actions":[{"name":3,"command":"make test","icon":"test"}]}'],
  ["non-string command", '{"actions":[{"name":"Run Tests","command":false,"icon":"test"}]}'],
  ["non-string icon", '{"actions":[{"name":"Run Tests","command":"make test","icon":null}]}'],
] as const)("rejects a project actions reply with %s", ([, reply]) =>
  Effect.gen(function* () {
    const textGeneration = fromRunner("TextGenerator", (request) =>
      decodeJsonReply(request, "Stub", reply),
    );

    const error = yield* Effect.flip(textGeneration.generateProjectActions(projectActionsInput));

    assert.instanceOf(error, TextGenerationError);
    assert.strictEqual(error.operation, "generateProjectActions");
  }),
);

it.effect.each([false, true])("server project actions with provider support %s", (supported) =>
  Effect.gen(function* () {
    let modelCalls = 0;
    const { generateProjectActions, ...otherOperations } = fromRunner(
      "TextGenerator",
      (request) => {
        modelCalls += 1;
        return decodeJsonReply(
          request,
          "Stub",
          '{"actions":[{"name":"Run Tests","command":"make test","icon":"test"}]}',
        );
      },
    );
    const service = yield* TextGeneration.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            listInstances: Effect.succeed([]),
            getInstance: (id) => {
              assert.strictEqual(id, ProviderInstanceId.make("acme-provider"));
              return Effect.succeed({
                textGeneration: {
                  ...otherOperations,
                  ...(supported ? { generateProjectActions } : {}),
                },
              } as ProviderInstance);
            },
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({}),
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            resolveLink: () =>
              Effect.die("Project actions should not resolve source control links"),
          }),
          Layer.mock(TextGenerators.TextGenerators)({ runner: () => Effect.undefined }),
          ProviderInstallationGate.layer,
        ),
      ),
    );
    if (!service.generateProjectActions) {
      return yield* Effect.die("The server must implement generateProjectActions");
    }
    const result = service.generateProjectActions(projectActionsInput);

    if (supported) {
      assert.deepEqual(yield* result, {
        actions: [{ name: "Run Tests", command: "make test", icon: "test" }],
      });
      assert.strictEqual(modelCalls, 1);
    } else {
      const error = yield* Effect.flip(result);
      assert.instanceOf(error, TextGenerationError);
      assert.strictEqual(error.operation, "generateProjectActions");
      assert.strictEqual(
        error.detail,
        "This model's provider cannot suggest project actions. Choose another model for generated text in Settings.",
      );
      assert.strictEqual(modelCalls, 0);
    }
  }),
);
