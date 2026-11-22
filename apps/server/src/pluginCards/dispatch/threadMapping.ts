import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { DispatchDecisionRecord } from "./decisionRecord.ts";
import type { DispatchLiveInitiative } from "./liveRegistry.ts";
import type { DispatchRunFeedRow } from "./runFeed.ts";

export type RunOpenedRow = Extract<DispatchRunFeedRow, { readonly event: "run-opened" }>;

export interface DispatchThreadLookup {
  readonly threadForClaudeSession: (sessionId: string) => Effect.Effect<ThreadId | null>;
  readonly threadForPid: (pid: number) => Effect.Effect<ThreadId | null>;
}

const trimSlash = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);

export const initiativeThread = Effect.fn("DispatchReader.initiativeThread")(function* (
  entry: DispatchLiveInitiative,
  lookup: DispatchThreadLookup,
) {
  if (entry.orchestratorSession) {
    const thread = yield* lookup.threadForClaudeSession(entry.orchestratorSession);
    if (thread !== null) return thread;
  }
  return entry.orchestratorPid === undefined
    ? null
    : yield* lookup.threadForPid(entry.orchestratorPid);
});

/** The latest run opened in the decision's checkout for its part and wave, by the time it was raised. */
const openingRun = (record: DispatchDecisionRecord, runs: Iterable<RunOpenedRow>) => {
  const raisedAt = Date.parse(record.raisedAt);
  const dir = trimSlash(record.dir);
  let latest: { readonly row: RunOpenedRow; readonly at: number } | null = null;
  for (const row of runs) {
    const at = Date.parse(row.ts);
    if (
      trimSlash(row.dir) !== dir ||
      row.part !== record.part ||
      row.wave !== record.wave ||
      !(at <= raisedAt) ||
      (latest !== null && latest.at > at)
    ) {
      continue;
    }
    latest = { row, at };
  }
  return latest?.row ?? null;
};

/**
 * Maps only through links the chat alone produced: the grant's Claude session, the named
 * initiative's orchestrator, then the process that opened the decision's run. `remembered` keeps a
 * chat found through a run, keyed `<dir>#<id>`, because the run's environment goes when it exits.
 */
export const mapDecisionToThread = Effect.fn("DispatchReader.mapDecisionToThread")(function* (
  record: DispatchDecisionRecord,
  initiatives: ReadonlyArray<DispatchLiveInitiative>,
  lookup: DispatchThreadLookup,
  runs: Iterable<RunOpenedRow>,
  remembered?: Map<string, ThreadId>,
) {
  if (record.grantSession !== undefined && record.grantSession !== "") {
    const thread = yield* lookup.threadForClaudeSession(record.grantSession);
    if (thread !== null) return thread;
  }
  const entry =
    record.initiative === undefined || record.initiative === ""
      ? undefined
      : initiatives.find((initiative) => initiative.slug === record.initiative);
  if (entry !== undefined) {
    const thread = yield* initiativeThread(entry, lookup);
    if (thread !== null) return thread;
  }
  const key = `${record.dir}#${record.id}`;
  const known = remembered?.get(key);
  if (known !== undefined) return known;
  const run = openingRun(record, runs);
  const thread = run === null ? null : yield* lookup.threadForPid(run.pid);
  if (thread !== null) remembered?.set(key, thread);
  return thread;
});

export const mapRunToThread = Effect.fn("DispatchReader.mapRunToThread")(function* (
  row: { readonly pid: number },
  lookup: Pick<DispatchThreadLookup, "threadForPid">,
) {
  return yield* lookup.threadForPid(row.pid);
});
