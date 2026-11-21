import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { DispatchDecisionRecord } from "./decisionRecord.ts";
import type { DispatchLiveInitiative } from "./liveRegistry.ts";

export interface DispatchThreadLookup {
  readonly threadForClaudeSession: (sessionId: string) => Effect.Effect<ThreadId | null>;
  readonly threadsForDir: (dir: string) => Effect.Effect<ReadonlyArray<ThreadId>>;
  readonly threadForPid: (pid: number) => Effect.Effect<ThreadId | null>;
}

const trimSlash = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);

const contains = (root: string, dir: string) => {
  const base = trimSlash(root);
  const target = trimSlash(dir);
  return target === base || target.startsWith(`${base}/`);
};

const initiativeHolds = (initiative: DispatchLiveInitiative, dir: string) =>
  (initiative.orchestratorCwd !== undefined && contains(initiative.orchestratorCwd, dir)) ||
  (initiative.repos ?? []).some(
    (repo) =>
      contains(repo.root, dir) || repo.worktrees.some((worktree) => contains(worktree, dir)),
  );

// A repo outlives its initiatives, so matching by directory looks only at open ones and must be unique.
const initiativeFor = (
  record: DispatchDecisionRecord,
  initiatives: ReadonlyArray<DispatchLiveInitiative>,
) => {
  if (record.initiative !== undefined && record.initiative !== "") {
    return initiatives.find((initiative) => initiative.slug === record.initiative);
  }
  const holding = initiatives.filter(
    (initiative) => !initiative.closed && initiativeHolds(initiative, record.dir),
  );
  return holding.length === 1 ? holding[0] : undefined;
};

const uniqueThreadForDir = Effect.fnUntraced(function* (lookup: DispatchThreadLookup, dir: string) {
  const threads = yield* lookup.threadsForDir(dir);
  return threads.length === 1 ? (threads[0] ?? null) : null;
});

export const mapDecisionToThread = Effect.fn("DispatchReader.mapDecisionToThread")(function* (
  record: DispatchDecisionRecord,
  initiatives: ReadonlyArray<DispatchLiveInitiative>,
  lookup: DispatchThreadLookup,
) {
  if (record.grantSession !== undefined && record.grantSession !== "") {
    const thread = yield* lookup.threadForClaudeSession(record.grantSession);
    if (thread !== null) return thread;
  }
  const session = initiativeFor(record, initiatives)?.orchestratorSession;
  if (session !== undefined && session !== "") {
    const thread = yield* lookup.threadForClaudeSession(session);
    if (thread !== null) return thread;
  }
  return yield* uniqueThreadForDir(lookup, record.dir);
});

export const mapRunToThread = Effect.fn("DispatchReader.mapRunToThread")(function* (
  row: { readonly dir: string; readonly pid: number },
  lookup: DispatchThreadLookup,
) {
  const thread = yield* lookup.threadForPid(row.pid);
  if (thread !== null) return thread;
  return yield* uniqueThreadForDir(lookup, row.dir);
});
