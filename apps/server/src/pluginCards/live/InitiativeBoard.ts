import { PluginCardError, type PluginInitiativeBoard } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ProcessRunner from "../../processRunner.ts";
import { listDecisionRecords } from "../dispatch/decisionRecord.ts";
import { type DispatchInitiativeState, readInitiativeState } from "../dispatch/initiativeState.ts";
import { DispatchLiveInitiative, dispatchInitiativesRoot } from "../dispatch/liveRegistry.ts";
import {
  partWorktree,
  readSpecPhases,
  readSpendCeiling,
  readWorktreeBranch,
} from "../dispatch/partRecords.ts";
import { DispatchLiveSnapshot, type DispatchLivePart } from "../sources/dispatchWaveSnapshot.ts";
import { runLocalJson } from "../sources/shared/runLocal.ts";
import { isInitiativeSlug } from "./dispatchLiveSummary.ts";
import { buildInitiativeBoard, type PartRecords } from "./initiativeBoardSummary.ts";

export class InitiativeBoard extends Context.Service<
  InitiativeBoard,
  {
    readonly subscribe: (slug: string) => Stream.Stream<PluginInitiativeBoard, PluginCardError>;
  }
>()("t3/pluginCards/live/InitiativeBoard") {}

const unavailableError = new PluginCardError({ reason: "unavailable" });

export const unavailable: InitiativeBoard["Service"] = {
  subscribe: () => Stream.fail(unavailableError),
};

export interface InitiativeBoardOptions {
  readonly initiativesRoot: string;
  /** `/proc` in production; when it is absent every run with an `.alive` marker counts as alive. */
  readonly procRoot: string;
}

const LEDGER_FILE = "ledger.jsonl";
const PAIR_RECORD_FILE = "record.json";
const CHANGE_QUIET_PERIOD = Duration.millis(250);
// A run's process exiting touches no watched file, so liveness is re-read on a timer.
const RECHECK_INTERVAL = Duration.seconds(30);
const DP_TIMEOUT = Duration.seconds(15);
const WAVE_LIVE_CONCURRENCY = 4;
const STAMPED_WAVE_FILE = /^wave-run-.+\.json/;
const WATCHED_WAVE_FILE = /^wave-run-\d+\.json(\.gate|\.alive)?$/;
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["running", "gating"]);

const decodeRegistry = Schema.decodeUnknownOption(Schema.fromJsonString(DispatchLiveInitiative));
const decodeAliveMarker = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ pid: Schema.Number })),
);

const sourceFailed = new PluginCardError({ reason: "source-failed" });

type BoardContent = Omit<PluginInitiativeBoard, "asOf">;
type SpecPhases = NonNullable<PartRecords["specPhases"]>;

interface CachedLedger {
  readonly size: number | null;
  readonly mtime: number | null;
  readonly state: DispatchInitiativeState;
}

interface CachedWaveLive {
  /** `null` until `dp wave live` has succeeded for the worktree, so a failed read is retried. */
  readonly stamp: string | null;
  readonly parts: ReadonlyArray<DispatchLivePart>;
}

interface WatchedCheckouts {
  readonly workDirs: ReadonlyArray<string>;
  readonly decisionDirs: ReadonlyArray<string>;
}

const sameWatched = (left: WatchedCheckouts, right: WatchedCheckouts) =>
  left.workDirs.join("\n") === right.workDirs.join("\n") &&
  left.decisionDirs.join("\n") === right.decisionDirs.join("\n");

const mtimeOf = (info: FileSystem.File.Info) =>
  Option.match(info.mtime, { onNone: () => null, onSome: (at) => at.getTime() });

export const makeInitiativeBoard = Effect.fn("InitiativeBoard.make")(function* (
  options: InitiativeBoardOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner
  >();
  const root = options.initiativesRoot;

  const watchDirectory = (dir: string, accept: (name: string) => boolean) =>
    fs.watch(dir).pipe(
      Stream.filter((event) => accept(path.basename(event.path))),
      // Most checkouts have no decisions directory and a part may have no work directory yet.
      Stream.catchCause((cause) =>
        Stream.fromEffect(
          Effect.logDebug("initiative board could not watch a directory", { path: dir, cause }),
        ).pipe(Stream.drain),
      ),
    );

  const isPidAlive = Effect.fnUntraced(function* (marker: string, procPresent: boolean) {
    const text = yield* fs.readFileString(marker).pipe(Effect.option);
    const pid = Option.flatMap(text, decodeAliveMarker);
    if (Option.isNone(pid)) return "?";
    if (!procPresent) return "+";
    const exists = yield* fs
      .exists(path.join(options.procRoot, String(pid.value.pid)))
      .pipe(Effect.orElseSucceed(() => true));
    return exists ? "+" : "-";
  });

  const waveRunStamp = Effect.fn("InitiativeBoard.waveRunStamp")(function* (
    worktree: string,
    procPresent: boolean,
  ) {
    const work = path.join(worktree, ".claude", "work");
    const names = yield* fs.readDirectory(work).pipe(Effect.orElseSucceed(() => []));
    const rows: Array<string> = [];
    for (const name of names.filter((entry) => STAMPED_WAVE_FILE.test(entry)).toSorted()) {
      const file = path.join(work, name);
      const info = yield* fs.stat(file).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "File") continue;
      const alive = name.endsWith(".alive") ? yield* isPidAlive(file, procPresent) : "";
      rows.push(`${name}:${Number(info.value.size)}:${mtimeOf(info.value)}${alive}`);
    }
    return rows.join("\n");
  });

  const openSubscription = Effect.fn("InitiativeBoard.subscribe")(function* (slug: string) {
    if (!isInitiativeSlug(slug)) return yield* sourceFailed;
    const initiativeDir = path.join(root, slug);
    const ledgerPath = path.join(initiativeDir, LEDGER_FILE);
    const hasLedger = yield* fs.exists(ledgerPath).pipe(Effect.orElseSucceed(() => false));
    if (!hasLedger) return yield* sourceFailed;

    const registryPath = path.join(root, ".live", `${slug}.json`);
    let ledger: CachedLedger | null = null;
    let waveLive: ReadonlyMap<string, CachedWaveLive> = new Map();
    const specPhases = new Map<string, SpecPhases>();
    let registryWarned = false;
    const watched = yield* SubscriptionRef.make<WatchedCheckouts>({
      workDirs: [],
      decisionDirs: [],
    });
    const active = yield* SubscriptionRef.make(false);

    const readRegistry = Effect.gen(function* () {
      const text = yield* fs.readFileString(registryPath).pipe(Effect.option);
      if (Option.isNone(text)) return null;
      const entry = decodeRegistry(text.value);
      if (Option.isSome(entry)) {
        registryWarned = false;
        return entry.value;
      }
      if (!registryWarned) {
        registryWarned = true;
        yield* Effect.logWarning("dispatch live registry entry is unreadable", {
          path: registryPath,
        });
      }
      return null;
    });

    const readLedger = Effect.gen(function* () {
      const stat = yield* fs.stat(ledgerPath).pipe(
        Effect.map((info) => ({ size: Number(info.size), mtime: mtimeOf(info) })),
        Effect.orElseSucceed(() => ({ size: null, mtime: null })),
      );
      if (ledger !== null && ledger.size === stat.size && ledger.mtime === stat.mtime) {
        return ledger.state;
      }
      const state = yield* readInitiativeState(slug);
      if (state === null) return null;
      ledger = { ...stat, state };
      return state;
    });

    const readWaveLive = Effect.fn("InitiativeBoard.readWaveLive")(function* (
      worktrees: ReadonlyArray<string>,
    ) {
      const procPresent = yield* fs
        .exists(options.procRoot)
        .pipe(Effect.orElseSucceed(() => false));
      const next = new Map<string, CachedWaveLive>();
      yield* Effect.forEach(
        worktrees,
        Effect.fnUntraced(function* (worktree) {
          const stamp = yield* waveRunStamp(worktree, procPresent);
          const cached = waveLive.get(worktree);
          if (cached !== undefined && cached.stamp === stamp) {
            next.set(worktree, cached);
            return;
          }
          if (stamp === "") {
            next.set(worktree, { stamp, parts: [] });
            return;
          }
          const snapshot = yield* runLocalJson(DispatchLiveSnapshot, {
            command: "dp",
            args: ["wave", "live", "--dir", worktree, "--json"],
            cwd: worktree,
            timeout: DP_TIMEOUT,
          });
          if (snapshot === null) {
            yield* Effect.logWarning("dp wave live is unreadable for a part worktree", {
              slug,
              worktree,
            });
            next.set(worktree, cached ?? { stamp: null, parts: [] });
            return;
          }
          next.set(worktree, { stamp, parts: snapshot.parts });
        }),
        { concurrency: WAVE_LIVE_CONCURRENCY, discard: true },
      );
      waveLive = next;
      return next;
    });

    const readSpec = Effect.fnUntraced(function* (worktree: string, partId: string) {
      const key = path.join(worktree, ".claude", "plans", `${partId}.md`);
      const cached = specPhases.get(key);
      if (cached !== undefined) return cached;
      const phases = yield* readSpecPhases(worktree, partId, null);
      if (phases !== null) specPhases.set(key, phases);
      return phases;
    });

    const readBoard = Effect.gen(function* () {
      const registry = yield* readRegistry;
      const state = yield* readLedger;
      if (state === null) return null;
      const ceilingUsd = yield* readSpendCeiling(root, slug);

      const located = yield* Effect.forEach(state.parts, (part) =>
        partWorktree({
          partId: part.id,
          registry,
          gateRecord:
            state.progress.findLast((row) => row.part === part.id && row.gate !== null)?.gate
              ?.record ?? null,
        }).pipe(Effect.map((worktree) => ({ part, worktree }))),
      );
      const worktrees = [
        ...new Set(located.flatMap(({ worktree }) => (worktree === null ? [] : [worktree]))),
      ].toSorted();
      const live = yield* readWaveLive(worktrees);

      const records = new Map<string, PartRecords>();
      for (const { part, worktree } of located) {
        if (worktree === null) continue;
        const entries = (live.get(worktree)?.parts ?? []).filter((entry) => entry.part === part.id);
        records.set(part.id, {
          branch: yield* readWorktreeBranch(worktree),
          waveLive: entries,
          specPhases: entries.length === 0 ? yield* readSpec(worktree, part.id) : null,
        });
      }

      const checkouts = [
        ...new Set([
          ...(registry?.repos ?? []).flatMap((repo) => [repo.root, ...repo.worktrees]),
          ...(registry?.orchestratorCwd ? [registry.orchestratorCwd] : []),
          ...worktrees,
        ]),
      ].toSorted();
      const openDecisions = (yield* Effect.forEach(checkouts, listDecisionRecords))
        .flat()
        .filter((record) => record.state === "open" && record.initiative === slug);

      const board = buildInitiativeBoard({
        slug,
        state,
        registry,
        ceilingUsd,
        records,
        openDecisions,
      });
      yield* SubscriptionRef.set(watched, {
        workDirs: worktrees.map((worktree) => path.join(worktree, ".claude", "work")),
        decisionDirs: checkouts.map((checkout) =>
          path.join(checkout, ".claude", "work", "decisions"),
        ),
      });
      yield* SubscriptionRef.set(
        active,
        board.waves.some((wave) => wave.parts.some((part) => ACTIVE_STATUSES.has(part.status))),
      );
      return board;
    });

    const stamp = (board: BoardContent) =>
      Effect.map(DateTime.now, (now): PluginInitiativeBoard => ({
        ...board,
        asOf: DateTime.formatIso(now),
      }));

    const firstBoard = yield* readBoard;
    if (firstBoard === null) {
      yield* Effect.logWarning("dp initiative show is unavailable for this initiative", { slug });
      return yield* sourceFailed;
    }
    let lastBoard = firstBoard;
    const first = yield* stamp(firstBoard);

    const refresh = Effect.gen(function* () {
      const board = yield* readBoard;
      if (board === null) {
        yield* Effect.logWarning(
          "dp initiative show is unavailable; keeping the last initiative board",
          { slug },
        );
        return Option.none<PluginInitiativeBoard>();
      }
      if (Equal.equals(lastBoard, board)) return Option.none<PluginInitiativeBoard>();
      lastBoard = board;
      return Option.some(yield* stamp(board));
    }).pipe(Effect.withSpan("InitiativeBoard.refresh"));

    const checkoutWatches = SubscriptionRef.changes(watched).pipe(
      Stream.changesWith(sameWatched),
      Stream.switchMap(({ workDirs, decisionDirs }) =>
        Stream.mergeAll(
          [
            ...workDirs.map((dir) => watchDirectory(dir, (name) => WATCHED_WAVE_FILE.test(name))),
            ...decisionDirs.map((dir) => watchDirectory(dir, (name) => name.endsWith(".json"))),
          ],
          { concurrency: "unbounded" },
        ),
      ),
    );

    // Stream.tick fires at once; the refresh that armed this timer is already fresh, so skip it.
    const rechecks = SubscriptionRef.changes(active).pipe(
      Stream.changesWith((left, right) => left === right),
      Stream.switchMap((on) =>
        on ? Stream.tick(RECHECK_INTERVAL).pipe(Stream.drop(1)) : Stream.empty,
      ),
    );

    const fileChanges = Stream.mergeAll(
      [
        watchDirectory(initiativeDir, (name) => name === LEDGER_FILE),
        watchDirectory(path.join(root, ".live"), (name) => name === `${slug}.json`),
        watchDirectory(path.join(root, ".pairs", slug), (name) => name === PAIR_RECORD_FILE),
        checkoutWatches,
      ],
      { concurrency: "unbounded" },
    ).pipe(Stream.as(undefined), Stream.debounce(CHANGE_QUIET_PERIOD));

    // The recheck bypasses the debounce: a steady stream of file events must not starve it.
    const later = Stream.merge(fileChanges, rechecks).pipe(
      Stream.mapEffect(() => refresh),
      Stream.filter(Option.isSome),
      Stream.map((board) => board.value),
    );
    return Stream.concat(Stream.succeed(first), later);
  });

  return {
    subscribe: (slug) => Stream.unwrap(openSubscription(slug)).pipe(Stream.provideContext(context)),
  } satisfies InitiativeBoard["Service"];
});

export const layer = Layer.effect(
  InitiativeBoard,
  Effect.gen(function* () {
    return yield* makeInitiativeBoard({
      initiativesRoot: yield* dispatchInitiativesRoot,
      procRoot: "/proc",
    });
  }),
);
