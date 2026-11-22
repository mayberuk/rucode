import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";

export interface ExternalSessionHolder {
  readonly owner: "terminal" | "other";
  readonly name: string | null;
}

export interface ExternalSessionHoldsValue {
  /** Synchronous read of the current snapshot: dispatch consults it inside the command lock. */
  readonly heldBy: (threadId: ThreadId) => ExternalSessionHolder | null;
}

/**
 * Threads whose provider session another process has open. Turns stay off them so two writers
 * never branch one session. Services read it once at construction, so provide it under them.
 */
export const ExternalSessionHolds = Context.Reference<ExternalSessionHoldsValue>(
  "t3/orchestration-v2/ExternalSessionHolds",
  { defaultValue: () => ({ heldBy: () => null }) },
);

export const externalSessionHeldMessage = (holder: ExternalSessionHolder): string =>
  holder.owner === "terminal"
    ? "This session is open in a terminal. Close it there to continue here."
    : "This session is open in another Claude Code process. Close it there to continue here.";
