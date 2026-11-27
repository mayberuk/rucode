import type { ProjectId, ProjectScript } from "@t3tools/contracts";

import type { ProjectScriptActionResult } from "./ProjectScriptsControl";

export type SuggestTrigger = "auto" | "manual";

export type ProjectActionSuggestOutcome =
  | {
      readonly _tag: "Added";
      readonly projectId: ProjectId;
      readonly scripts: ReadonlyArray<ProjectScript>;
    }
  | { readonly _tag: "Skipped" }
  | { readonly _tag: "NoneFound" }
  | { readonly _tag: "Failed"; readonly message: string };

export interface ProjectActionSuggestionsController {
  readonly available: boolean;
  readonly projectId: ProjectId | null;
  readonly projectName: string | null;
  readonly suggesting: boolean;
  readonly autoAttempted: boolean;
  readonly suggest: (trigger: SuggestTrigger) => Promise<ProjectActionSuggestOutcome>;
  readonly undo: (
    projectId: ProjectId,
    added: ReadonlyArray<ProjectScript>,
  ) => Promise<ProjectScriptActionResult>;
}

export function shouldAutoSuggest(input: {
  available: boolean;
  scriptCount: number;
  autoAttempted: boolean;
  suggesting: boolean;
}): boolean {
  return input.available && input.scriptCount === 0 && !input.autoAttempted && !input.suggesting;
}

export function scriptsAfterUndo(
  current: ReadonlyArray<ProjectScript>,
  added: ReadonlyArray<ProjectScript>,
): ReadonlyArray<ProjectScript> {
  return current.filter(
    (script) =>
      !added.some(
        (suggestion) => suggestion.id === script.id && suggestion.command === script.command,
      ),
  );
}

export type ProjectActionSuggestionNotice =
  | {
      readonly kind: "added";
      readonly projectId: ProjectId;
      readonly scripts: ReadonlyArray<ProjectScript>;
    }
  | { readonly kind: "none-found" }
  | { readonly kind: "failed"; readonly message: string };

export function suggestionNoticeFor(
  trigger: SuggestTrigger,
  outcome: ProjectActionSuggestOutcome,
): ProjectActionSuggestionNotice | null {
  switch (outcome._tag) {
    case "Added":
      return outcome.scripts.length > 0
        ? { kind: "added", projectId: outcome.projectId, scripts: outcome.scripts }
        : null;
    case "Skipped":
      return null;
    case "NoneFound":
      return trigger === "manual" ? { kind: "none-found" } : null;
    case "Failed":
      return trigger === "manual" ? { kind: "failed", message: outcome.message } : null;
  }
}
