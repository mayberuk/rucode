import type {
  DispatchDecisionCard,
  DispatchDecisionCardData,
  PluginDecisionAnswerProgress,
  PluginLiveDecision,
  PluginLiveState,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
import { listLiveInitiatives } from "./liveRegistry.ts";
import { mapDecisionToThread } from "./threadMapping.ts";

const CARD_KIND = "dispatch.decision";
const CHANGE_DEBOUNCE = Duration.millis(250);
const READ_CONCURRENCY = 8;

export type DispatchDecisionLive = Pick<PluginLiveState, "decisions" | "waitingThreadIds">;

export interface MappedDecision {
  readonly record: DispatchDecisionRecord;
  readonly threadId: ThreadId | null;
}

export interface DispatchDecisionSource extends PluginCardSource {
  readonly changes: Stream.Stream<void, never, PluginCardSourceServices>;
  /** Open decisions across known checkouts, and the chats they wait on. */
  readonly live: Effect.Effect<DispatchDecisionLive>;
  /** Re-reads the record behind a decision card id from disk; null when it is gone. */
  readonly findDecision: (cardId: string) => Effect.Effect<MappedDecision | null>;
  /** Null clears it. Shown on the card while the decision is open. */
  readonly setProgress: (
    cardId: string,
    progress: PluginDecisionAnswerProgress | null,
  ) => Effect.Effect<void>;
}

const decisionCardId = (dir: string, decisionId: string) => `${CARD_KIND}:${dir}#${decisionId}`;

const parseKey = (key: string) => {
  const cut = key.lastIndexOf("#");
  if (cut <= 0 || cut === key.length - 1) return null;
  return { dir: key.slice(0, cut), id: key.slice(cut + 1) };
};

const DP_DECISION = /(?:^|[\s;&|(/])dp\s+decision\s+(raise|wait|answer|show)(?=$|[\s;&|)])/g;
const RAISED_LINE = /^decision (\S+): (?:default |needs a person)/gm;
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

export const makeDispatchDecisionSource = Effect.fn("PluginCards.makeDispatchDecisionSource")(
  function* (options?: { readonly initiativesRoot?: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const index = yield* PluginThreadIndex;
    const scope = yield* Scope.Scope;
    const home = yield* HostProcess.HomeDirectory;
    const initiativesRoot = options?.initiativesRoot ?? path.join(home, ".claude", "initiatives");
    const services = yield* Effect.context<PluginCardSourceServices>();

    const signals = yield* PubSub.unbounded<void>();
    const signal = PubSub.publish(signals, undefined).pipe(Effect.asVoid);
    const progress = new Map<string, PluginDecisionAnswerProgress>();

    const resolveDir = (cwd: string, dir: string | null) => {
      if (dir === null || dir === "") return path.resolve(cwd);
      if (dir === "~" || dir.startsWith("~/")) return path.resolve(home, dir.slice(2));
      return path.resolve(cwd, dir);
    };

    const recognize = (command: RecognizableCommand): ReadonlyArray<PluginCardRef> => {
      const refs: Array<PluginCardRef> = [];
      const raiseDirs: Array<string> = [];
      for (const match of command.command.matchAll(DP_DECISION)) {
        const verb = match[1]!;
        const args = parseDecisionArgs(
          shellWords(command.command.slice(match.index + match[0].length)),
        );
        const dir = resolveDir(command.cwd, args.dir);
        if (verb === "raise") raiseDirs.push(dir);
        else if (args.id !== null) refs.push({ kind: CARD_KIND, key: `${dir}#${args.id}` });
      }
      if (raiseDirs.length > 0) {
        raisedIds(command.output).forEach((id, position) => {
          const dir = raiseDirs[Math.min(position, raiseDirs.length - 1)]!;
          refs.push({ kind: CARD_KIND, key: `${dir}#${id}` });
        });
      }
      return refs;
    };

    const watchers = new Map<
      string,
      { readonly token: object; readonly fiber: Fiber.Fiber<void> }
    >();
    const watchPermit = yield* Semaphore.make(1);

    const isDirectory = (dir: string) =>
      fs.stat(dir).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      );

    const watch = Effect.fnUntraced(function* (dir: string) {
      const token = {};
      const fiber = yield* fs.watch(dir).pipe(
        Stream.runForEach(() => signal),
        Effect.ignoreCause({ log: true }),
        Effect.ensuring(
          Effect.sync(() => {
            if (watchers.get(dir)?.token === token) watchers.delete(dir);
          }),
        ),
        Effect.forkIn(scope),
      );
      watchers.set(dir, { token, fiber });
    });

    // A decisions directory appears on the first raise in a checkout, so each read re-checks the set.
    const syncWatchers = (checkouts: ReadonlyArray<string>) =>
      watchPermit.withPermits(1)(
        Effect.gen(function* () {
          const wanted = new Set([
            path.join(initiativesRoot, ".live"),
            ...checkouts.map((checkout) => path.join(checkout, ".claude", "work", "decisions")),
          ]);
          for (const [dir, watcher] of watchers) {
            if (wanted.has(dir)) continue;
            watchers.delete(dir);
            yield* Fiber.interrupt(watcher.fiber);
          }
          for (const dir of wanted) {
            if (watchers.has(dir) || !(yield* isDirectory(dir))) continue;
            yield* watch(dir);
          }
        }),
      );

    const readDecision = Effect.fnUntraced(function* (dir: string, id: string) {
      const records = yield* listDecisionRecords(dir);
      return records.find((record) => record.id === id) ?? null;
    });

    const mapRecord = Effect.fnUntraced(function* (record: DispatchDecisionRecord) {
      const initiatives = yield* listLiveInitiatives(initiativesRoot);
      return yield* mapDecisionToThread(record, initiatives, index);
    });

    const scan = Effect.gen(function* () {
      const checkouts = yield* index.checkouts;
      yield* syncWatchers(checkouts);
      const initiatives = yield* listLiveInitiatives(initiativesRoot);
      const records = yield* Effect.forEach(checkouts, listDecisionRecords, {
        concurrency: READ_CONCURRENCY,
      });
      return yield* Effect.forEach(
        records.flat(),
        (record) =>
          mapDecisionToThread(record, initiatives, index).pipe(
            Effect.map((threadId): MappedDecision => ({ record, threadId })),
          ),
        { concurrency: READ_CONCURRENCY },
      );
    }).pipe(Effect.provideContext(services));

    const answerableIn = Effect.fnUntraced(function* (threadId: ThreadId, mapped: ThreadId | null) {
      if (mapped !== threadId) return "terminal-only" as const;
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
      const record = yield* readDecision(key.dir, key.id);
      if (record === null) return null;
      const mapped = yield* mapRecord(record);
      return cardData(record, yield* answerableIn(threadId, mapped));
    }, Effect.provideContext(services));

    const cardsForThread = Effect.fn("PluginCards.decisionCardsForThread")(function* (
      threadId: ThreadId,
    ) {
      const mine = (yield* scan).filter((entry) => entry.threadId === threadId);
      if (mine.length === 0) return [];
      const answerable = yield* answerableIn(threadId, threadId);
      return mine.map(({ record }): DispatchDecisionCard => ({
        ...cardData(record, answerable),
        id: decisionCardId(record.dir, record.id),
        threadId,
        placement: { type: "time", at: record.raisedAt },
      }));
    });

    const live = Effect.gen(function* () {
      const open = (yield* scan).filter((entry) => entry.record.state === "open");
      const decisions = open
        .map(({ record, threadId }): PluginLiveDecision => ({
          cardId: decisionCardId(record.dir, record.id),
          decisionId: record.id,
          dir: record.dir,
          kind: record.kind,
          question: record.question,
          initiative:
            record.initiative === undefined || record.initiative === "" ? null : record.initiative,
          part: record.part,
          threadId,
          needsPerson: record.needsPerson === true,
          raisedAt: record.raisedAt,
          applyAfter: toDecisionCardData(record, null, "yes").applyAfter,
        }))
        .toSorted((left, right) =>
          left.cardId < right.cardId ? -1 : left.cardId > right.cardId ? 1 : 0,
        );
      const waitingThreadIds = [
        ...new Set(open.flatMap(({ threadId }) => (threadId === null ? [] : [threadId]))),
      ].toSorted();
      return { decisions, waitingThreadIds } satisfies DispatchDecisionLive;
    }).pipe(Effect.withSpan("PluginCards.decisionLive"));

    const findDecision = Effect.fn("PluginCards.findDecision")(function* (cardId: string) {
      const prefix = `${CARD_KIND}:`;
      const key = cardId.startsWith(prefix) ? parseKey(cardId.slice(prefix.length)) : null;
      if (key === null) return null;
      const record = yield* readDecision(key.dir, key.id);
      if (record === null) return null;
      return { record, threadId: yield* mapRecord(record) } satisfies MappedDecision;
    }, Effect.provideContext(services));

    const setProgress = (cardId: string, next: PluginDecisionAnswerProgress | null) =>
      Effect.suspend(() => {
        if (next === null) progress.delete(cardId);
        else progress.set(cardId, next);
        return signal;
      });

    yield* index.checkouts.pipe(Effect.flatMap(syncWatchers), Effect.forkIn(scope));

    return {
      id: "dispatch",
      recognize,
      resolve,
      cardsForThread,
      changes: Stream.fromPubSub(signals).pipe(Stream.debounce(CHANGE_DEBOUNCE)),
      live,
      findDecision,
      setProgress,
    } satisfies DispatchDecisionSource;
  },
);
