import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";
import { ProjectScript } from "./project.ts";

export const ProjectActionSuggestionTrigger = Schema.Literals(["auto", "manual"]);
export type ProjectActionSuggestionTrigger = typeof ProjectActionSuggestionTrigger.Type;

export const ProjectActionsSuggestInput = Schema.Struct({
  projectId: ProjectId,
  trigger: ProjectActionSuggestionTrigger,
});
export type ProjectActionsSuggestInput = typeof ProjectActionsSuggestInput.Type;

export const ProjectActionsSkipReason = Schema.Literals([
  "disabled",
  "already-offered",
  "has-actions",
  "in-progress",
]);
export type ProjectActionsSkipReason = typeof ProjectActionsSkipReason.Type;

export const ProjectActionsSuggestResult = Schema.Union([
  Schema.TaggedStruct("Added", { scripts: Schema.Array(ProjectScript) }),
  Schema.TaggedStruct("Skipped", { reason: ProjectActionsSkipReason }),
  Schema.TaggedStruct("NoneFound", {}),
]);
export type ProjectActionsSuggestResult = typeof ProjectActionsSuggestResult.Type;

export class ProjectActionsSuggestError extends Schema.TaggedError<ProjectActionsSuggestError>()(
  "ProjectActionsSuggestError",
  { message: Schema.String },
) {}
