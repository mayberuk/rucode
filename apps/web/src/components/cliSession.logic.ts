import {
  CliSessionError,
  type CliSessionErrorReason,
  type PluginLiveCliSession,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { msg } from "gt-react";

/** Continue in terminal resumes a Claude Code session, so only Claude threads offer it. */
export function isClaudeThread(
  thread: {
    readonly runtime: { readonly providerInstanceId: ProviderInstanceId } | null;
    readonly modelSelection: { readonly instanceId: ProviderInstanceId };
  },
  providers: ReadonlyArray<{ readonly instanceId: ProviderInstanceId; readonly driver: string }>,
): boolean {
  const instanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  return providers.find((provider) => provider.instanceId === instanceId)?.driver === "claudeAgent";
}

/** The server can only exit an idle Claude in a tmux pane it can verify; other owners have no pane. */
export function cliSessionTakeOver(
  session: Pick<PluginLiveCliSession, "owner" | "status" | "inTmux">,
): "hidden" | "available" | "unavailable" {
  if (session.owner !== "terminal") return "hidden";
  return session.status === "idle" && session.inTmux ? "available" : "unavailable";
}

const REFUSALS = {
  "not-attached": msg("This chat is no longer open in a terminal."),
  "not-idle": msg("The terminal session is busy. Try again once it is idle."),
  "not-in-tmux": msg("The terminal session is not running inside tmux."),
  "pane-changed": msg("The terminal pane no longer runs this session."),
  "still-open": msg("The terminal session did not exit in time."),
  "run-active": msg("A turn is still running in this chat."),
  "background-pending": msg(
    "Background work is still running in this chat. Try again once it finishes.",
  ),
  "no-session": msg("This chat has no Claude session to continue."),
  "tmux-failed": msg("Couldn't send keys to the terminal."),
} satisfies Record<CliSessionErrorReason, string>;

const isCliSessionError = Schema.is(CliSessionError);

/** The server's refusal as a message for `useMessages`, or null for any other failure. */
export function cliSessionRefusal(error: unknown): string | null {
  return isCliSessionError(error) ? REFUSALS[error.reason] : null;
}
