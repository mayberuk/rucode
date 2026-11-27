import {
  decisionWaitsOnPerson,
  type DispatchDecisionCard,
  type DispatchDecisionCardData,
  type PluginDecisionAnswerProgress,
  type PluginLiveDecision,
  type PluginLiveState,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ExternalSessionHolds } from "../../orchestration-v2/ExternalSessionHolds.ts";
import type {
  PluginCardRef,
  PluginCardSource,
  PluginCardSourceServices,
  RecognizableCommand,
} from "../core/PluginCardSource.ts";
import { PluginThreadIndex } from "../core/PluginThreadIndex.ts";
import {
  type DispatchDecisionRecord,
  listDecisionRecords,
  toDecisionCardData,
} from "./decisionRecord.ts";
import { dispatchInitiativesRoot, listLiveInitiatives } from "./liveRegistry.ts";
import { readRunFeed, type RunFeedCursor, runFeedPath } from "./runFeed.ts";
import {
  type DispatchThreadLookup,
  mapDecisionToThread,
  type RunOpenedRow,
} from "./threadMapping.ts";

const CARD_KIND = "dispatch.decision";
const CHANGE_DEBOUNCE = Duration.millis(250);
const READ_CONCURRENCY = 8;
/** Run rows kept per checkout, part and wave, so a long-running server's memory stays flat. */
const RUNS_PER_PART_WAVE = 5;

export type DispatchDecisionLive = Pick<PluginLiveState, "decisions" | "waitingThreadIds">;

export interface MappedDecision {
  readonly record: DispatchDecisionRecord;
  readonly threadId: ThreadId | null;
}

export interface DispatchDecisionSource extends PluginCardSource {
  readonly changes: Stream.Stream<void, never, PluginCardSourceServices>;
  /** Open decisions across known checkouts, and the chats they wait on. */
  readonly live: Effect.Effect<DispatchDecisionLive>;
  readonly progressChanges: Stream.Stream<ThreadId>;
  /** Re-reads the record behind a decision card id from disk; null when it is gone. */
  readonly findDecision: (cardId: string) => Effect.Effect<MappedDecision | null>;
  /** Null clears it. Shown on the card while the decision is open. */
  readonly setProgress: (
    threadId: ThreadId,
    cardId: string,
    progress: PluginDecisionAnswerProgress | null,
  ) => Effect.Effect<void>;
}

export const decisionCardId = (dir: string, decisionId: string) =>
  `${CARD_KIND}:${dir}#${decisionId}`;

const parseKey = (key: string) => {
  const cut = key.lastIndexOf("#");
  if (cut <= 0 || cut === key.length - 1) return null;
  return { dir: key.slice(0, cut), id: key.slice(cut + 1) };
};

const parseCardId = (cardId: string) => {
  const prefix = `${CARD_KIND}:`;
  return cardId.startsWith(prefix) ? parseKey(cardId.slice(prefix.length)) : null;
};

export const canonicalDecisionCardId = (cardId: string, path: Path.Path) => {
  const key = parseCardId(cardId);
  return key === null || !path.isAbsolute(key.dir)
    ? null
    : decisionCardId(path.resolve(key.dir), key.id);
};

const DP_DECISION = /(?:^|[\s;&|(/])dp\s+decision\s+(raise|wait|answer|show)(?=$|[\s;&|)])/g;
const DP_RUN = /(?:^|[\s;&|(/])dp\s+(?:design|wave)(?=$|[\s;&|)])/g;
const RAISED_LINE = /^decision (\S+): (?:default |needs a person)/gm;
// dp design and dp wave report a decision they raised as "…; decision <id>" or "spend-cap decision <id>".
const RUN_RAISED = /(?:; |^spend-cap )decision (\w(?:[\w.-]*\w)?)/gm;
const decodeRaisedJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String })),
);

/** Shell words up to the end of the simple command, honouring quotes and backslashes. */
const shellWords = (text: string): ReadonlyArray<string> => {
  const words: Array<string> = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  const flush = () => {
    if (started) words.push(current);
    current = "";
    started = false;
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote !== null) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < text.length) current += text[++index];
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\" && index + 1 < text.length) {
      current += text[++index];
      started = true;
    } else if (char === "\n" || char === ";" || char === "&" || char === "|" || char === ")") {
      break;
    } else if (/\s/.test(char)) {
      flush();
    } else {
      current += char;
      started = true;
    }
  }
  flush();
  return words;
};

const isFlag = (word: string) => word.length > 1 && word.startsWith("-");

// dp takes positionals before flags, and Go's flag package accepts one or two dashes.
const parseDecisionArgs = (words: ReadonlyArray<string>) => {
  const firstFlag = words.findIndex(isFlag);
  const positionals = firstFlag === -1 ? words : words.slice(0, firstFlag);
  let dir: string | null = null;
  for (let index = Math.max(firstFlag, 0); index < words.length; index++) {
    const match = /^--?dir(?:=(.*))?$/.exec(words[index]!);
    if (match === null) continue;
    dir = match[1] ?? words[index + 1] ?? null;
  }
  return { id: positionals[0] ?? null, dir };
};

const raisedIds = (output: string | null): ReadonlyArray<string> => {
  if (output === null) return [];
  const json = decodeRaisedJson(output.trim());
  if (Option.isSome(json)) return [json.value.id];
  return [...output.matchAll(RAISED_LINE)].map((match) => match[1]!);
};

export interface DispatchDecisionSourceOptions {
  readonly initiativesRoot?: string;
  readonly runFeedPath?: string;
  /** A chat's finished commands, to find the chat that raised a decision no session maps. */
  readonly commandsOf?: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<RecognizableCommand>>;
}

export const makeDispatchDecisionSource = Effect.fn("PluginCards.makeDispatchDecisionSource")(
  function* (options?: DispatchDecisionSourceOptions) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const index = yield* PluginThreadIndex;
    const holds = yield* ExternalSessionHolds;
    const scope = yield* Scope.Scope;
    const home = yield* HostProcess.HomeDirectory;
    const env = yield* HostProcess.Environment;
    const initiativesRoot = options?.initiativesRoot ?? (yield* dispatchInitiativesRoot);
    const runFeed = options?.runFeedPath ?? runFeedPath(env, home);
    const commandsOf =
      options?.commandsOf ?? (() => Effect.succeed<ReadonlyArray<RecognizableCommand>>([]));
    const services = yield* Effect.context<PluginCardSourceServices>();

    const signals = yield* PubSub.unbounded<void>();
    const diskEvents = yield* PubSub.sliding<void>(1);
    const diskChanged = PubSub.publish(diskEvents, undefined).pipe(Effect.asVoid);
    const progressEvents = yield* PubSub.unbounded<ThreadId>();
    const progress = new Map<string, PluginDecisionAnswerProgress>();

    const resolveDir = (cwd: string, dir: string | null) => {
      if (dir === null || dir === "") return path.resolve(cwd);
      if (dir === "~" || dir.startsWith("~/")) return path.resolve(home, dir.slice(2));
      return path.resolve(cwd, dir);
    };

    const argsAfter = (command: RecognizableCommand, match: RegExpMatchArray) =>
      parseDecisionArgs(shellWords(command.command.slice(match.index! + match[0].length)));

    const recognize = (command: RecognizableCommand): ReadonlyArray<PluginCardRef> => {
      const refs: Array<PluginCardRef> = [];
      const raiseDirs: Array<string> = [];
      for (const match of command.command.matchAll(DP_DECISION)) {
        const verb = match[1]!;
        const args = argsAfter(command, match);
        const dir = resolveDir(command.cwd, args.dir);
        if (verb === "raise") raiseDirs.push(dir);
        else if (args.id !== null) {
          refs.push({ kind: CARD_KIND, key: `${dir}#${args.id}`, owns: verb === "wait" });
        }
      }
      if (raiseDirs.length > 0) {
        raisedIds(command.output).forEach((id, position) => {
          const dir = raiseDirs[Math.min(position, raiseDirs.length - 1)]!;
          refs.push({ kind: CARD_KIND, key: `${dir}#${id}`, owns: true });
        });
      }
      const runDirs = new Set(
        Array.from(command.command.matchAll(DP_RUN), (match) =>
          resolveDir(command.cwd, argsAfter(command, match).dir),
        ),
      );
      if (runDirs.size > 0 && command.output !== null) {
        for (const match of command.output.matchAll(RUN_RAISED)) {
          for (const dir of runDirs) {
            refs.push({ kind: CARD_KIND, key: `${dir}#${match[1]!}`, owns: true });
          }
        }
      }
      return refs;
    };

    const watchers = new Map<
      string,
      { readonly token: object; readonly fiber: Fiber.Fiber<void> }
    >();
    let watchedChildren = new Map<string, Set<string> | null>();
    const watchPermit = yield* Semaphore.make(1);

    const isDirectory = (dir: string) =>
      fs.stat(dir).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      );

    const watch = Effect.fn("PluginCards.watchDecisions")(function* (dir: string) {
      const token = {};
      const ready = yield* Deferred.make<void>();
      const fiber = yield* fs
        .watch(dir, {
          onReady: () => {
            Deferred.doneUnsafe(ready, Effect.void);
          },
        })
        .pipe(
          Stream.filter((event) => {
            const children = watchedChildren.get(dir);
            return children === null || children?.has(path.resolve(dir, event.path)) === true;
          }),
          Stream.runForEach(() => diskChanged),
          Effect.ignoreCause({ log: true }),
          Effect.ensuring(
            Effect.sync(() => {
              if (watchers.get(dir)?.token === token) watchers.delete(dir);
              Deferred.doneUnsafe(ready, Effect.void);
            }),
          ),
          Effect.forkIn(scope),
        );
      watchers.set(dir, { token, fiber });
      yield* Deferred.await(ready);
    });

    const syncWatchers = Effect.fn("PluginCards.syncDecisionWatchers")(
      function* (checkouts: ReadonlyArray<string>) {
        const targets = [
          path.join(initiativesRoot, ".live"),
          ...checkouts.map((checkout) => path.join(checkout, ".claude", "work", "decisions")),
        ];
        const wanted = new Map<string, Set<string> | null>();
        for (const target of targets) {
          let dir = target;
          let child = null;
          while (!(yield* isDirectory(dir))) {
            const parent = path.dirname(dir);
            if (parent === dir) break;
            child = dir;
            dir = parent;
          }
          if (child === null) wanted.set(dir, null);
          else if (wanted.get(dir) !== null) {
            const children = wanted.get(dir) ?? new Set<string>();
            children.add(child);
            wanted.set(dir, children);
          }
        }
        watchedChildren = wanted;
        for (const [dir, children] of wanted) {
          if (watchers.has(dir)) continue;
          yield* watch(dir);
          // A missing child can appear between selecting its ancestor and installing the watch.
          if (children !== null && Option.isSome(yield* Effect.findFirst(children, isDirectory))) {
            yield* diskChanged;
          }
        }
        for (const [dir, watcher] of watchers) {
          if (wanted.has(dir)) continue;
          watchers.delete(dir);
          yield* Fiber.interrupt(watcher.fiber);
        }
      },
      (effect) => watchPermit.withPermits(1)(effect),
    );

    const readDecision = Effect.fn("PluginCards.readDecision")(function* (dir: string, id: string) {
      const records = yield* listDecisionRecords(dir);
      return records.find((record) => record.id === id) ?? null;
    });

    let runCursor: RunFeedCursor | null = null;
    const runs = new Map<string, Array<RunOpenedRow>>();
    const runPermit = yield* Semaphore.make(1);
    const runThreads = new Map<string, ThreadId>();
    const raisers = new Map<string, ReadonlyArray<ThreadId>>();

    const openedRuns = runPermit.withPermits(1)(
      Effect.gen(function* () {
        const feed = yield* readRunFeed(runFeed, runCursor);
        runCursor = feed.cursor;
        for (const row of feed.rows) {
          if (row.event !== "run-opened") continue;
          const key = `${row.wave}\0${row.part}\0${path.resolve(row.dir)}`;
          const kept = [...(runs.get(key) ?? []), row]
            .toSorted((left, right) => Date.parse(left.ts) - Date.parse(right.ts))
            .slice(-RUNS_PER_PART_WAVE);
          runs.set(key, kept);
        }
        return [...runs.values()].flat();
      }),
    );

    const mapRecord = Effect.fn("PluginCards.mapDecision")(function* (
      record: DispatchDecisionRecord,
    ) {
      const initiatives = yield* listLiveInitiatives(initiativesRoot);
      return yield* mapDecisionToThread(record, initiatives, index, yield* openedRuns, runThreads);
    });

    const scan = Effect.gen(function* () {
      const lookup = yield* index.decisionLookup;
      yield* syncWatchers(lookup.checkouts);
      const initiatives = yield* listLiveInitiatives(initiativesRoot);
      const opened = yield* openedRuns;
      const records = (yield* Effect.forEach(lookup.checkouts, listDecisionRecords, {
        concurrency: READ_CONCURRENCY,
      })).flat();
      const byId = new Map(
        records.map((record) => [decisionCardId(record.dir, record.id), record]),
      );
      const threadLookup: DispatchThreadLookup = {
        threadForClaudeSession: lookup.threadForClaudeSession,
        threadForPid: index.threadForPid,
      };
      const mapRecord = Effect.fnUntraced(function* (record: DispatchDecisionRecord) {
        return {
          record,
          threadId: yield* mapDecisionToThread(
            record,
            initiatives,
            threadLookup,
            opened,
            runThreads,
          ),
        };
      });
      const open = yield* Effect.forEach(
        records.filter((record) => record.state === "open"),
        mapRecord,
      );
      const openThreads = new Map(open.map(({ record, threadId }) => [record, threadId]));
      const byThread = yield* Effect.cached(
        Effect.gen(function* () {
          const cards = new Map<ThreadId, Array<DispatchDecisionRecord>>();
          for (const record of records) {
            const threadId =
              record.state === "open"
                ? (openThreads.get(record) ?? null)
                : (yield* mapRecord(record)).threadId;
            if (threadId === null) continue;
            const existing = cards.get(threadId);
            if (existing === undefined) cards.set(threadId, [record]);
            else existing.push(record);
          }
          return cards;
        }),
      );
      return { checkouts: new Set(lookup.checkouts), byId, byThread, mapRecord, open };
    }).pipe(Effect.provideContext(services), Effect.withSpan("PluginCards.scanDecisions"));

    const [snapshot, invalidate] = yield* Effect.cachedInvalidateWithTTL(scan, Duration.infinity);

    const answerableIn = Effect.fnUntraced(function* (threadId: ThreadId, owner: ThreadId | null) {
      if (owner !== threadId || holds.heldBy(threadId) !== null) return "terminal-only" as const;
      return (yield* index.claudeTranscript(threadId)) === null
        ? ("terminal-only" as const)
        : ("yes" as const);
    });

    const cardData = (
      record: DispatchDecisionRecord,
      answerable: DispatchDecisionCardData["answerable"],
    ) => {
      const answer =
        record.state === "open"
          ? (progress.get(decisionCardId(record.dir, record.id)) ?? null)
          : null;
      const data = toDecisionCardData(record, answer, answerable);
      return {
        kind: CARD_KIND,
        updatedAt: data.resolvedAt ?? data.raisedAt,
        actions: [],
        data,
      } as const;
    };

    const resolve = Effect.fn("PluginCards.resolveDecision")(function* (
      ref: PluginCardRef,
      threadId: ThreadId,
    ) {
      const key = ref.kind === CARD_KIND ? parseKey(ref.key) : null;
      if (key === null) return null;
      const scanned = yield* snapshot;
      if (scanned.checkouts.has(key.dir)) {
        const record = scanned.byId.get(decisionCardId(key.dir, key.id));
        if (record === undefined) return null;
        const { threadId: mapped } = yield* scanned.mapRecord(record);
        const owner = mapped ?? (ref.owns === true ? threadId : null);
        return cardData(record, yield* answerableIn(threadId, owner));
      }
      const record = yield* readDecision(key.dir, key.id);
      return record === null ? null : cardData(record, "terminal-only");
    }, Effect.provideContext(services));

    const cardsForThread = Effect.fn("PluginCards.decisionCardsForThread")(function* (
      threadId: ThreadId,
    ) {
      const mine = (yield* (yield* snapshot).byThread).get(threadId);
      if (mine === undefined) return [];
      const answerable = yield* answerableIn(threadId, threadId);
      return mine.map((record): DispatchDecisionCard => ({
        ...cardData(record, answerable),
        id: decisionCardId(record.dir, record.id),
        threadId,
        placement: { type: "time", at: record.raisedAt },
      }));
    });

    // Only chats working in the decision's directory are read; sharing it proves nothing.
    const raisingThreads = Effect.fnUntraced(function* (record: DispatchDecisionRecord) {
      const cardId = decisionCardId(record.dir, record.id);
      const known = raisers.get(cardId);
      if (known !== undefined) return known;
      const key = `${record.dir}#${record.id}`;
      const found: Array<ThreadId> = [];
      for (const candidate of yield* index.threadsForDir(record.dir)) {
        const commands = yield* commandsOf(candidate);
        const owns = commands.some((command) =>
          recognize(command).some((ref) => ref.owns === true && ref.key === key),
        );
        if (owns) found.push(candidate);
      }
      if (found.length > 0) raisers.set(cardId, found);
      return found;
    });

    const live = Effect.gen(function* () {
      const { open } = yield* snapshot;
      const waiting = new Set<ThreadId>();
      const decisions: Array<PluginLiveDecision> = [];
      for (const { record, threadId } of open) {
        const data = toDecisionCardData(record, null, "yes");
        const owners = threadId === null ? yield* raisingThreads(record) : [threadId];
        if (decisionWaitsOnPerson(data)) {
          for (const owner of owners) waiting.add(owner);
        }
        const owner = owners[0];
        decisions.push({
          cardId: decisionCardId(record.dir, record.id),
          decisionId: data.decisionId,
          dir: data.dir,
          kind: data.decisionKind,
          question: data.question,
          initiative: data.initiative,
          part: data.part,
          threadId:
            owner !== undefined && (yield* answerableIn(owner, owner)) === "yes" ? owner : null,
          needsPerson: data.needsPerson,
          raisedAt: data.raisedAt,
          applyAfter: data.applyAfter,
        });
      }
      return {
        decisions: decisions.toSorted((left, right) =>
          left.cardId < right.cardId ? -1 : left.cardId > right.cardId ? 1 : 0,
        ),
        waitingThreadIds: [...waiting].toSorted(),
      } satisfies DispatchDecisionLive;
    }).pipe(Effect.withSpan("PluginCards.decisionLive"));

    const findDecision = Effect.fn("PluginCards.findDecision")(function* (cardId: string) {
      const canonical = canonicalDecisionCardId(cardId, path);
      const key = canonical === null ? null : parseCardId(canonical);
      if (key === null || !(yield* index.checkouts).includes(key.dir)) return null;
      const record = yield* readDecision(key.dir, key.id);
      if (record === null) return null;
      return { record, threadId: yield* mapRecord(record) } satisfies MappedDecision;
    }, Effect.provideContext(services));

    const setProgress = (
      threadId: ThreadId,
      cardId: string,
      next: PluginDecisionAnswerProgress | null,
    ) =>
      // A successful dp write can precede the debounced file notification.
      (next === null ? invalidate : Effect.void).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (next === null) progress.delete(cardId);
            else progress.set(cardId, next);
          }),
        ),
        Effect.andThen(PubSub.publish(progressEvents, threadId)),
        Effect.asVoid,
      );

    yield* Stream.merge(Stream.fromPubSub(diskEvents), index.decisionMappingChanges).pipe(
      Stream.debounce(CHANGE_DEBOUNCE),
      Stream.runForEach(() =>
        invalidate.pipe(
          Effect.andThen(snapshot),
          Effect.andThen(PubSub.publish(signals, undefined)),
        ),
      ),
      Effect.forkIn(scope, { startImmediately: true }),
    );
    yield* index.checkouts.pipe(Effect.flatMap(syncWatchers), Effect.forkIn(scope));

    return {
      id: "dispatch",
      recognize,
      resolve,
      cardsForThread,
      changes: Stream.fromPubSub(signals),
      progressChanges: Stream.fromPubSub(progressEvents),
      live,
      findDecision,
      setProgress,
    } satisfies DispatchDecisionSource;
  },
);
