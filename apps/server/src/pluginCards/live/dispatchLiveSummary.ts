import type { PluginLiveChild, PluginLiveInitiative, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import type { DispatchInitiativeState } from "../dispatch/initiativeState.ts";
import { planWaves, SETTLED_PART_STATUSES } from "../dispatch/initiativeWaves.ts";
import type { DispatchLiveInitiative } from "../dispatch/liveRegistry.ts";
import type { DispatchRunFeedRow } from "../dispatch/runFeed.ts";

type RunOpened = Extract<DispatchRunFeedRow, { readonly event: "run-opened" }>;
type RunSettled = Extract<DispatchRunFeedRow, { readonly event: "run-settled" }>;

interface FoldedRun {
  readonly opened: RunOpened;
  readonly settled: RunSettled | null;
}

/** Keyed by `${run}:${pid}`: a resumed run keeps its run id under a new pid. */
export type FoldedRuns = ReadonlyMap<string, FoldedRun>;

const SETTLED_RUN_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_CHILDREN = 100;
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REGISTRY_SUFFIX = ".json";

const runKey = (row: { readonly run: string; readonly pid: number }) => `${row.run}:${row.pid}`;

export const foldRunRows = (
  runs: FoldedRuns,
  rows: ReadonlyArray<DispatchRunFeedRow>,
): FoldedRuns => {
  const next = new Map(runs);
  for (const row of rows) {
    if (row.event === "run-opened") {
      next.set(runKey(row), { opened: row, settled: next.get(runKey(row))?.settled ?? null });
    } else if (row.event === "run-settled") {
      const run = next.get(runKey(row));
      // A settle row whose open row was rotated away has nothing to attach to.
      if (run !== undefined) next.set(runKey(row), { ...run, settled: row });
    }
  }
  return next;
};

const parseMillis = (iso: string): number | null =>
  Option.getOrNull(Option.map(DateTime.make(iso), DateTime.toEpochMillis));

const isoOfMillis = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

const toUtcIso = (iso: string): string | null => {
  const millis = parseMillis(iso);
  return millis === null ? null : isoOfMillis(millis);
};

const childState = (
  run: FoldedRun,
  pidAlive: (pid: number) => boolean,
): PluginLiveChild["state"] => {
  if (run.settled === null) return pidAlive(run.opened.pid) ? "running" : "aborted";
  switch (run.settled.outcome) {
    case "passed":
      return "settled";
    case "aborted":
      return "aborted";
    default:
      return "failed";
  }
};

interface LiveRunOptions {
  readonly now: number;
  readonly pidAlive: (pid: number) => boolean;
}

/** Running runs, and runs that ended in the last 24 hours. */
export const keptRuns = (runs: FoldedRuns, { now, pidAlive }: LiveRunOptions) =>
  [...runs].flatMap(([key, run]) => {
    const state = childState(run, pidAlive);
    const updatedAt = run.settled?.ts ?? run.opened.ts;
    const endedAt = parseMillis(updatedAt);
    if (state !== "running" && (endedAt === null || now - endedAt > SETTLED_RUN_WINDOW_MS)) {
      return [];
    }
    return [{ key, run, state, updatedAt }];
  });

export const liveChildren = (
  runs: FoldedRuns,
  options: LiveRunOptions & { readonly threadIdFor: (key: string) => ThreadId | null },
): ReadonlyArray<PluginLiveChild> =>
  keptRuns(runs, options)
    .toSorted(
      (left, right) =>
        (parseMillis(right.run.opened.ts) ?? 0) - (parseMillis(left.run.opened.ts) ?? 0),
    )
    .slice(0, MAX_CHILDREN)
    .map(({ key, run, state, updatedAt }) => ({
      id: key,
      kind: "run",
      initiative: run.opened.initiative || null,
      part: run.opened.part,
      wave: run.opened.wave,
      phase: null,
      state,
      threadId: options.threadIdFor(key),
      dir: run.opened.dir,
      startedAt: toUtcIso(run.opened.ts),
      updatedAt: toUtcIso(updatedAt),
      costUsd: null,
    }));

export const spendOf = (entry: DispatchLiveInitiative): PluginLiveInitiative["spend"] => {
  // dp folds the orchestrator's own spend into reportedCostUsd, so it is the fuller figure.
  const usd =
    entry.reportedCostUsd > 0
      ? entry.reportedCostUsd
      : entry.totalCostUsd > 0
        ? entry.totalCostUsd
        : null;
  switch (entry.totalCostState) {
    case "final":
      return { usd, state: "exact" };
    case "estimated":
      return { usd, state: "estimated" };
    case "incomplete":
      return { usd, state: "incomplete" };
    default:
      return { usd, state: usd === null ? "unknown" : "estimated" };
  }
};

export const summarizeInitiative = (
  entry: DispatchLiveInitiative,
  state: DispatchInitiativeState | null,
  options: {
    readonly now: number;
    readonly openDecisions: number;
    readonly orchestratorThreadId: ThreadId | null;
    readonly children: ReadonlyArray<PluginLiveChild>;
  },
): PluginLiveInitiative => {
  const parts = state?.parts ?? [];
  const plan = state === null ? null : planWaves(state);
  const current = plan?.current ?? entry.totalWave;
  const total = plan?.total ?? entry.totalWave;
  const currentParts = parts.filter((part) => plan?.displayOf(part.wave) === current);
  const liveUntil = parseMillis(entry.liveUntil);
  const running = liveUntil !== null && liveUntil > options.now ? entry.totalRunning : 0;
  return {
    slug: entry.slug,
    title: state?.initiative.title ?? null,
    closed: entry.closed || state?.closed === true,
    wave: {
      current,
      total,
      partsSettled: currentParts.filter((part) => SETTLED_PART_STATUSES.has(part.status)).length,
      partsTotal: currentParts.length,
    },
    settled: { count: entry.totalSettled, total: entry.totalSettled + running },
    running,
    openDecisions: options.openDecisions,
    spend: spendOf(entry),
    orchestratorThreadId: options.orchestratorThreadId,
    asOf: toUtcIso(entry.touched) ?? isoOfMillis(options.now),
    parts: parts.map((part) => ({
      id: part.id,
      title: part.title,
      wave: plan?.displayOf(part.wave) ?? part.wave,
      status: part.status,
      threadIds: [
        ...new Set(
          options.children.flatMap((child) =>
            child.initiative === entry.slug && child.part === part.id && child.threadId !== null
              ? [child.threadId]
              : [],
          ),
        ),
      ],
    })),
  };
};

export const isInitiativeSlug = (slug: string) => SLUG_PATTERN.test(slug);

export const isRegistryFileName = (name: string) =>
  name.endsWith(REGISTRY_SUFFIX) && isInitiativeSlug(name.slice(0, -REGISTRY_SUFFIX.length));

/** `feedName` is the feed's own file name, which `DP_RUN_FEED` can change. */
export const isRunFeedFileName = (name: string, feedName = "runs.jsonl") =>
  name === feedName || name === `${feedName}.1`;
