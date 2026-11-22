import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";

/** A Claude session synced into a chat that a process other than this server holds open. */
export const PluginLiveCliSession = Schema.Struct({
  threadId: ThreadId,
  sessionId: Schema.String,
  owner: Schema.Literals(["terminal", "other"]),
  status: Schema.Literals(["busy", "idle", "shell", "unknown"]),
  name: Schema.NullOr(Schema.String),
  inTmux: Schema.Boolean,
  backgroundWorkKept: Schema.Boolean,
});
export type PluginLiveCliSession = typeof PluginLiveCliSession.Type;

export const CliSessionTakeOverInput = Schema.Struct({ threadId: ThreadId });
export type CliSessionTakeOverInput = typeof CliSessionTakeOverInput.Type;

export const CliSessionContinueInput = Schema.Struct({ threadId: ThreadId });
export type CliSessionContinueInput = typeof CliSessionContinueInput.Type;

/** `copy`: no pane to type into, so the client offers `command` for the user to run. */
export const CliSessionContinueResult = Schema.Struct({
  delivery: Schema.Literals(["sent", "copy"]),
  command: Schema.String,
  paneLabel: Schema.NullOr(Schema.String),
});
export type CliSessionContinueResult = typeof CliSessionContinueResult.Type;

export const CliSessionErrorReason = Schema.Literals([
  "not-attached",
  "not-idle",
  "not-in-tmux",
  "pane-changed",
  "still-open",
  "run-active",
  "background-pending",
  "no-session",
  "tmux-failed",
]);
export type CliSessionErrorReason = typeof CliSessionErrorReason.Type;

const CLI_SESSION_ERROR_MESSAGES = {
  "not-attached": "This session is not open in a terminal.",
  "not-idle": "The terminal session is busy. Try again once it is idle.",
  "not-in-tmux": "The terminal session is not running inside tmux.",
  "pane-changed": "The terminal pane no longer runs this session.",
  "still-open": "The terminal session did not exit in time.",
  "run-active": "A turn is still running in this chat.",
  "background-pending":
    "Background work is still running in this chat. Try again once it finishes.",
  "no-session": "This chat has no Claude session to continue.",
  "tmux-failed": "Couldn't send keys to the terminal.",
} as const satisfies Record<CliSessionErrorReason, string>;

export class CliSessionError extends Schema.TaggedError<CliSessionError>()("CliSessionError", {
  reason: CliSessionErrorReason,
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    return CLI_SESSION_ERROR_MESSAGES[this.reason];
  }
}
