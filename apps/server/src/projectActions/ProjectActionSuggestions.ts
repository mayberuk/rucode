import {
  ProjectActionsSuggestError,
  type ProjectActionsSuggestInput,
  type ProjectActionsSuggestResult,
  type ProjectId,
  TextGenerationError,
} from "@t3tools/contracts";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HashSet from "effect/HashSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { gatherProjectActionContext } from "./ProjectActionContext.ts";
import * as Ledger from "./ProjectActionSuggestionLedger.ts";
import { acceptProjectActionCandidates } from "./ProjectActionSuggestionPolicy.ts";

export class ProjectActionSuggestions extends Context.Service<
  ProjectActionSuggestions,
  {
    readonly suggest: (
      input: ProjectActionsSuggestInput,
    ) => Effect.Effect<ProjectActionsSuggestResult, ProjectActionsSuggestError>;
  }
>()("t3/projectActions/ProjectActionSuggestions") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const ledger = yield* Ledger.ProjectActionSuggestionLedger;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const inFlight = yield* Ref.make(HashSet.empty<ProjectId>());

  const readSettings = serverSettings.getSettings.pipe(
    Effect.mapError(
      () => new ProjectActionsSuggestError({ message: "Could not read project settings." }),
    ),
  );

  const suggest: ProjectActionSuggestions["Service"]["suggest"] = Effect.fn(
    "ProjectActionSuggestions.suggest",
  )(function* ({ projectId, trigger }) {
    const settings = yield* readSettings;
    const resolved = resolveProjectSettings(settings, projectId).settings;
    if (!resolved.suggestProjectActions) return { _tag: "Skipped", reason: "disabled" } as const;

    const found = yield* projects
      .getById(projectId)
      .pipe(
        Effect.mapError(
          () => new ProjectActionsSuggestError({ message: "Could not read the project." }),
        ),
      );
    if (Option.isNone(found))
      return yield* new ProjectActionsSuggestError({ message: "Project not found." });
    const project = found.value;

    const run = Effect.scoped(
      Effect.gen(function* () {
        if (trigger === "auto" && (yield* ledger.has(projectId))) {
          return { _tag: "Skipped", reason: "already-offered" } as const;
        }
        const current = resolveProjectScripts(settings, project);
        yield* ledger.record(projectId);
        if (trigger === "auto" && current.length > 0) {
          return { _tag: "Skipped", reason: "has-actions" } as const;
        }

        const projectContext = yield* gatherProjectActionContext(project.workspaceRoot).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        // The CLI would load the untrusted repo's CLAUDE.md, AGENTS.md and settings; the context is already in the prompt.
        const isolatedCwd = yield* fileSystem
          .makeTempDirectoryScoped({ prefix: "t3code-project-actions-" })
          .pipe(
            Effect.mapError(
              () => new ProjectActionsSuggestError({ message: "Could not prepare suggestions." }),
            ),
          );
        const generated = yield* (
          textGeneration.generateProjectActions?.({
            cwd: isolatedCwd,
            projectName: project.title,
            projectContext,
            existingCommands: current.map((script) => script.command),
            modelSelection: resolved.textGenerationModelSelection,
            projectId,
          }) ??
          Effect.fail(
            new TextGenerationError({
              operation: "generateProjectActions",
              detail:
                "This model's provider cannot suggest project actions. Choose another model for generated text in Settings.",
            }),
          )
        ).pipe(
          Effect.tapError(() =>
            Effect.logWarning("Project action generation failed.", { projectId }),
          ),
          Effect.mapError((error) => new ProjectActionsSuggestError({ message: error.detail })),
        );
        const accepted = acceptProjectActionCandidates(generated.actions, current);
        if (accepted.length === 0) return { _tag: "NoneFound" } as const;

        const fresh = yield* readSettings;
        const freshCurrent = resolveProjectScripts(fresh, project);
        const finalAccepted = acceptProjectActionCandidates(accepted, freshCurrent);
        if (finalAccepted.length === 0) return { _tag: "NoneFound" } as const;

        yield* serverSettings
          .updateSettings({
            projectSettingsOverrides: {
              [projectId]: {
                ...fresh.projectSettingsOverrides[projectId],
                defaultProjectScripts: [...freshCurrent, ...finalAccepted],
              },
            },
          })
          .pipe(
            Effect.mapError(
              () => new ProjectActionsSuggestError({ message: "Could not save project actions." }),
            ),
          );
        return { _tag: "Added", scripts: finalAccepted } as const;
      }),
    );

    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const claimed = yield* Ref.modify(inFlight, (projects) =>
          HashSet.has(projects, projectId)
            ? [false, projects]
            : [true, HashSet.add(projects, projectId)],
        );
        if (!claimed) return { _tag: "Skipped", reason: "in-progress" } as const;
        return yield* restore(run).pipe(
          Effect.ensuring(Ref.update(inFlight, HashSet.remove(projectId))),
        );
      }),
    );
  });

  return ProjectActionSuggestions.of({ suggest });
});

export const layer = Layer.effect(ProjectActionSuggestions, make);
