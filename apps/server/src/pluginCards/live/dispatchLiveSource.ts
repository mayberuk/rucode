import type { PluginLiveInitiative, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type {
  PluginCardSourceServices,
  PluginLiveSource,
  PluginLiveSourceFactory,
} from "../core/PluginCardSource.ts";
import { PluginThreadIndex } from "../core/PluginThreadIndex.ts";
import { listDecisionRecords } from "../dispatch/decisionRecord.ts";
import { type DispatchInitiativeState, readInitiativeState } from "../dispatch/initiativeState.ts";
import { type DispatchLiveInitiative, listLiveInitiatives } from "../dispatch/liveRegistry.ts";
import { type RunFeedCursor, readRunFeed, runFeedPath } from "../dispatch/runFeed.ts";
import { mapRunToThread } from "../dispatch/threadMapping.ts";
import {
  type FoldedRuns,
  foldRunRows,
  isRegistryFileName,
  isRunFeedFileName,
  keptRuns,
  liveChildren,
  summarizeInitiative,
} from "./dispatchLiveSummary.ts";

export interface DispatchLiveSourceOptions {
  readonly initiativesRoot: string;
  readonly runFeedPath: string;
  /** `/proc` in production; when it is absent every unsettled run counts as alive. */
  readonly procRoot: string;
}

const LEDGER_FILE = "ledger.jsonl";
const CHANGE_QUIET_PERIOD = Duration.millis(250);

interface CachedInitiative {
  readonly ledgerSize: number | null;
  readonly ledgerMtime: number | null;
  readonly state: DispatchInitiativeState | null;
}

interface SourceState {
  readonly cursor: RunFeedCursor | null;
  readonly runs: FoldedRuns;
  readonly threads: ReadonlyMap<string, ThreadId | null>;
  readonly initiatives: ReadonlyMap<string, CachedInitiative>;
}

const compareStrings = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

const sameSlugs = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((slug, index) => slug === right[index]);

export const makeDispatchLiveSource = Effect.fn("DispatchLive.makeSource")(function* (
  options: DispatchLiveSourceOptions,
): Effect.fn.Return<PluginLiveSource, never, PluginCardSourceServices | Scope.Scope> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const index = yield* PluginThreadIndex;
  const permit = yield* Semaphore.make(1);
  const state = yield* Ref.make<SourceState>({
    cursor: null,
    runs: new Map(),
    threads: new Map(),
    initiatives: new Map(),
  });
  const openSlugs = yield* SubscriptionRef.make<ReadonlyArray<string>>([]);
  const unavailableSlugs = new Set<string>();

  const pidAliveSet = Effect.fnUntraced(function* (runs: FoldedRuns) {
    const procPresent = yield* fs.exists(options.procRoot).pipe(Effect.orElseSucceed(() => false));
    const pids = new Set(
      [...runs.values()].flatMap((run) => (run.settled === null ? [run.opened.pid] : [])),
    );
    const alive = new Set<number>();
    for (const pid of pids) {
      const exists =
        !procPresent ||
        (yield* fs
          .exists(path.join(options.procRoot, String(pid)))
          .pipe(Effect.orElseSucceed(() => true)));
      if (exists) alive.add(pid);
    }
    return alive;
  });

  const ledgerStat = (slug: string) =>
    fs.stat(path.join(options.initiativesRoot, slug, LEDGER_FILE)).pipe(
      Effect.map((info) => ({
        ledgerSize: Number(info.size),
        ledgerMtime: Option.match(info.mtime, { onNone: () => null, onSome: (at) => at.getTime() }),
      })),
      Effect.orElseSucceed(() => ({ ledgerSize: null, ledgerMtime: null })),
    );

  const initiativeState = Effect.fn("DispatchLive.initiativeState")(function* (
    slug: string,
    cached: CachedInitiative | undefined,
  ) {
    const stat = yield* ledgerStat(slug);
    if (
      cached !== undefined &&
      cached.ledgerSize === stat.ledgerSize &&
      cached.ledgerMtime === stat.ledgerMtime
    ) {
      return cached;
    }
    const read = yield* readInitiativeState(slug);
    if (read === null && !unavailableSlugs.has(slug)) {
      unavailableSlugs.add(slug);
      yield* Effect.logWarning("dp initiative show is unavailable for this initiative", { slug });
    } else if (read !== null) {
      unavailableSlugs.delete(slug);
    }
    return { ...stat, state: read } satisfies CachedInitiative;
  });

  const openDecisionCount = Effect.fn("DispatchLive.openDecisionCount")(function* (
    entry: DispatchLiveInitiative,
  ) {
    const checkouts = new Set([
      ...(entry.repos ?? []).flatMap((repo) => [repo.root, ...repo.worktrees]),
      ...(entry.orchestratorCwd ? [entry.orchestratorCwd] : []),
    ]);
    let count = 0;
    for (const checkout of checkouts) {
      for (const record of yield* listDecisionRecords(checkout)) {
        if (record.state !== "open") continue;
        if (record.initiative === undefined || record.initiative === "") count += 1;
        else if (record.initiative === entry.slug) count += 1;
      }
    }
    return count;
  });

  const orchestratorThread = Effect.fn("DispatchLive.orchestratorThread")(function* (
    entry: DispatchLiveInitiative,
  ) {
    if (entry.orchestratorSession) {
      const thread = yield* index.threadForClaudeSession(entry.orchestratorSession);
      if (thread !== null) return thread;
    }
    return entry.orchestratorPid === undefined
      ? null
      : yield* index.threadForPid(entry.orchestratorPid);
  });

  const snapshot = permit.withPermits(1)(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const previous = yield* Ref.get(state);

      const feed = yield* readRunFeed(options.runFeedPath, previous.cursor);
      const folded = foldRunRows(previous.runs, feed.rows);
      const alive = yield* pidAliveSet(folded);
      const pidAlive = (pid: number) => alive.has(pid);
      const kept = keptRuns(folded, { now, pidAlive });

      // A run's environment, which names its chat, disappears once its pid exits.
      const threads = new Map<string, ThreadId | null>();
      for (const { key, run, state: runState } of kept) {
        const cached = previous.threads.get(key);
        if (cached !== undefined && (cached !== null || runState !== "running")) {
          threads.set(key, cached);
        } else if (runState === "running") {
          threads.set(key, yield* mapRunToThread(run.opened, index));
        }
      }
      const children = liveChildren(folded, {
        now,
        pidAlive,
        threadIdFor: (key) => threads.get(key) ?? null,
      });

      const open = (yield* listLiveInitiatives(options.initiativesRoot)).filter(
        (entry) => !entry.closed,
      );
      const cache = new Map<string, CachedInitiative>();
      const initiatives: Array<PluginLiveInitiative> = [];
      for (const entry of open) {
        const cached = yield* initiativeState(entry.slug, previous.initiatives.get(entry.slug));
        cache.set(entry.slug, cached);
        if (cached.state?.closed === true) continue;
        initiatives.push(
          summarizeInitiative(entry, cached.state, {
            now,
            openDecisions: yield* openDecisionCount(entry),
            orchestratorThreadId: yield* orchestratorThread(entry),
            children,
          }),
        );
      }

      yield* Ref.set(state, {
        cursor: feed.cursor,
        runs: new Map(kept.map(({ key, run }) => [key, run])),
        threads,
        initiatives: cache,
      });
      yield* SubscriptionRef.set(
        openSlugs,
        open.map((entry) => entry.slug).toSorted(compareStrings),
      );

      return {
        initiatives: initiatives.toSorted((left, right) => compareStrings(left.slug, right.slug)),
        children: children.toSorted((left, right) => compareStrings(left.id, right.id)),
      };
    }),
  );

  const watchDirectory = (dir: string, accept: (name: string) => boolean) =>
    fs.watch(dir).pipe(
      Stream.filter((event) => accept(path.basename(event.path))),
      Stream.catchCause((cause) =>
        Stream.fromEffect(
          Effect.logWarning("dispatch live source could not watch a directory", {
            path: dir,
            cause,
          }),
        ).pipe(Stream.drain),
      ),
    );

  const feedName = path.basename(options.runFeedPath);
  const ledgerWatches = SubscriptionRef.changes(openSlugs).pipe(
    Stream.changesWith(sameSlugs),
    Stream.switchMap((slugs) =>
      Stream.mergeAll(
        slugs.map((slug) =>
          watchDirectory(path.join(options.initiativesRoot, slug), (name) => name === LEDGER_FILE),
        ),
        { concurrency: "unbounded" },
      ),
    ),
  );

  const changes = Stream.mergeAll(
    [
      watchDirectory(path.join(options.initiativesRoot, ".live"), isRegistryFileName),
      watchDirectory(path.dirname(options.runFeedPath), (name) =>
        isRunFeedFileName(name, feedName),
      ),
      ledgerWatches,
    ],
    { concurrency: "unbounded" },
  ).pipe(Stream.debounce(CHANGE_QUIET_PERIOD), Stream.as(undefined));

  return { id: "dispatch.live", snapshot, changes } satisfies PluginLiveSource;
});

export const dispatchLiveSource: PluginLiveSourceFactory = Effect.suspend(() =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const env = yield* HostProcess.Environment;
    return yield* makeDispatchLiveSource({
      initiativesRoot: env.DISPATCH_INITIATIVES_ROOT || path.join(home, ".claude", "initiatives"),
      runFeedPath: runFeedPath(env, home),
      procRoot: "/proc",
    });
  }),
);
