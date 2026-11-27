import type { ThreadId } from "@t3tools/contracts";

export type SpawnDecision =
  | { readonly _tag: "TopLevel" }
  | { readonly _tag: "Child"; readonly parentThreadId: ThreadId }
  | { readonly _tag: "AwaitingParent"; readonly parentSessionId: string }
  | { readonly _tag: "Hidden"; readonly reason: "throwaway-checkout" };

export interface SpawnInput {
  readonly sessionId: string;
  /** Parent id from the ancestry-checked launch signal. */
  readonly parentSessionId: string | null;
  /** The `CLAUDE_CODE_SESSION_ID` inherited by the server itself. */
  readonly serverSessionId: string | null;
  readonly cwd: string;
  readonly homeDir: string;
  /** The cwd equals a registered project's root. */
  readonly atProjectRoot: boolean;
  readonly sessionThreads: ReadonlyMap<string, ThreadId | null>;
}

const THROWAWAY_CHECKOUT_PATTERN = /^[^.].*\.([A-Za-z0-9]{6})$/;

const trimSlashes = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);

export function decideSpawn(input: SpawnInput): SpawnDecision {
  const { parentSessionId, serverSessionId, sessionId } = input;
  if (
    parentSessionId !== null &&
    parentSessionId !== serverSessionId &&
    parentSessionId !== sessionId
  ) {
    const parentThreadId = input.sessionThreads.get(parentSessionId);
    return parentThreadId === undefined || parentThreadId === null
      ? { _tag: "AwaitingParent", parentSessionId }
      : { _tag: "Child", parentThreadId };
  }

  if (!input.atProjectRoot && looksLikeThrowawayCheckout(input.cwd, input.homeDir)) {
    return { _tag: "Hidden", reason: "throwaway-checkout" };
  }
  return { _tag: "TopLevel" };
}

/** Best-effort check for a `mktemp` name like `acme-spike.xDsmKz` below home. */
export function looksLikeThrowawayCheckout(cwd: string, homeDir: string): boolean {
  const directory = trimSlashes(cwd);
  const home = trimSlashes(homeDir);
  const homePrefix = home === "/" ? home : `${home}/`;
  if (home === "" || !directory.startsWith(homePrefix)) return false;

  return directory
    .slice(homePrefix.length)
    .split("/")
    .some((component) => {
      const suffix = THROWAWAY_CHECKOUT_PATTERN.exec(component)?.[1];
      return suffix !== undefined && /[A-Z]/.test(suffix) && /[a-z]/.test(suffix);
    });
}
