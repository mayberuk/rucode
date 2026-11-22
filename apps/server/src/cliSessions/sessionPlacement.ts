import type { ProjectId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface PlacementProject {
  readonly id: ProjectId;
  readonly workspaceRoot: string;
}

export interface SessionPlacementInput {
  readonly sessionId: string;
  readonly cwd: string;
  readonly homeDir: string;
  readonly projects: ReadonlyArray<PlacementProject>;
  /** Set when `cwd` is a linked git worktree; `mainCheckout` is its repository's main checkout. */
  readonly linkedWorktree: { readonly mainCheckout: string; readonly branch: string | null } | null;
  /** Registry name, transcript agent name and custom title; any may be null. */
  readonly names: ReadonlyArray<string | null>;
  readonly pairSessionIds: ReadonlySet<string>;
}

export type SessionPlacement =
  | {
      readonly _tag: "Project";
      readonly projectId: ProjectId;
      readonly worktree: { readonly path: string; readonly branch: string | null } | null;
    }
  | { readonly _tag: "NewProject"; readonly workspaceRoot: string }
  | { readonly _tag: "Skip"; readonly reason: "pair-session" | "temporary" | "outside-home" };

// dp names a supervisor/driver pair's sessions with these suffixes; not every pair has a record.
const PAIR_NAME_PATTERN = /-(drv|driver|sup|super|supervisor)$/;
const SESSION_ID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const trimSlashes = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);
const isWithin = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/**
 * Resuming runs Claude in the thread's cwd and Claude files transcripts by cwd, so a session
 * joins a project only when the thread's effective cwd can equal the session's cwd exactly.
 */
export function placeSession(input: SessionPlacementInput): SessionPlacement {
  if (
    input.pairSessionIds.has(input.sessionId) ||
    input.names.some((name) => name !== null && PAIR_NAME_PATTERN.test(name.trim()))
  ) {
    return { _tag: "Skip", reason: "pair-session" };
  }
  const cwd = trimSlashes(input.cwd);
  const projectAt = (root: string) =>
    input.projects.find((project) => trimSlashes(project.workspaceRoot) === root);
  const exact = projectAt(cwd);
  if (exact !== undefined) return { _tag: "Project", projectId: exact.id, worktree: null };
  if (input.linkedWorktree !== null) {
    const main = projectAt(trimSlashes(input.linkedWorktree.mainCheckout));
    if (main !== undefined) {
      return {
        _tag: "Project",
        projectId: main.id,
        worktree: { path: cwd, branch: input.linkedWorktree.branch },
      };
    }
  }
  if (isWithin(cwd, "/tmp") || isWithin(cwd, "/private/tmp")) {
    return { _tag: "Skip", reason: "temporary" };
  }
  const home = trimSlashes(input.homeDir);
  if (cwd === home || !isWithin(cwd, home)) return { _tag: "Skip", reason: "outside-home" };
  return { _tag: "NewProject", workspaceRoot: cwd };
}

/** Session ids anywhere in a dp pair record, whatever fields hold them. */
export const pairSessionIdsIn = (recordText: string): ReadonlyArray<string> =>
  [...recordText.matchAll(SESSION_ID_PATTERN)].map((match) => match[0].toLowerCase());

const decodeOrigin = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      entrypoint: Schema.optional(Schema.String),
      cwd: Schema.optional(Schema.String),
    }),
  ),
);

/** The entrypoint and cwd of the first complete record that names an entrypoint. */
export function transcriptOrigin(
  bytes: Uint8Array,
): { readonly entrypoint: string; readonly cwd: string | null } | null {
  const decoder = new TextDecoder();
  let start = 0;
  for (let end = bytes.indexOf(0x0a); end !== -1; end = bytes.indexOf(0x0a, start)) {
    const record = Option.getOrUndefined(decodeOrigin(decoder.decode(bytes.subarray(start, end))));
    start = end + 1;
    if (record?.entrypoint !== undefined) {
      return { entrypoint: record.entrypoint, cwd: record.cwd ?? null };
    }
  }
  return null;
}
