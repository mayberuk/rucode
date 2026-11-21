import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, it } from "@effect/vitest";
import { type DispatchDecisionCard, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProcessRunner from "../../processRunner.ts";
import { PluginThreadIndex } from "../core/PluginThreadIndex.ts";
import { makeDispatchDecisionSource } from "./decisionSource.ts";

const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");
const RAISED_AT = "2026-11-21T10:00:00.123456789Z";

const decisionRecord = (id: string, overrides: Record<string, unknown> = {}) => ({
  schema: "decision/1",
  id,
  kind: "batch-approval",
  part: "core",
  wave: 1,
  phase: "",
  question: `Approve ${id}?`,
  options: [
    { key: "go", label: "Go", command: "" },
    { key: "stop", label: "Stop", command: "dp stop" },
  ],
  default: "stop",
  defaultReason: "",
  raisedAt: RAISED_AT,
  applyAfter: "2026-11-21T10:05:00Z",
  state: "open",
  choice: "",
  chosenBy: "",
  resolvedAt: "",
  ...overrides,
});

/** Real file watching, reporting each installed watcher on `ready` and each event on `events`. */
const watchingFileSystem = (ready: Queue.Queue<string>, events: Queue.Queue<string>) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return {
        ...fs,
        watch: (path: string, options?: FileSystem.WatchOptions) =>
          fs
            .watch(path, {
              ...options,
              onReady: () => {
                options?.onReady?.();
                Queue.offerUnsafe(ready, path);
              },
            })
            .pipe(Stream.tap(() => Queue.offer(events, path))),
      } satisfies FileSystem.FileSystem;
    }),
  ).pipe(Layer.provide(NodeFileSystem.layer));

/**
 * Checkout `a` is only thread A's, so its decisions map there by directory. Checkout `b` is shared
 * by both threads, so only a session match maps a decision there: `session-b` is thread B's.
 */
const setup = Effect.fnUntraced(function* (options?: {
  readonly transcriptFor?: ThreadId;
  readonly firstRaise?: boolean;
  /** Passes the root as DISPATCH_INITIATIVES_ROOT instead of as an option. */
  readonly rootFromEnv?: boolean;
  /** Written to checkout `a` before any watcher starts. */
  readonly seed?: ReadonlyArray<ReturnType<typeof decisionRecord>>;
}) {
  const ready = yield* Queue.unbounded<string>();
  const events = yield* Queue.unbounded<string>();
  const fsLayer = watchingFileSystem(ready, events);
  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-decision-source-" });
    const checkoutA = path.join(root, "a");
    const checkoutB = path.join(root, "b");
    const initiativesRoot = path.join(root, "initiatives");
    const decisionsDir = (checkout: string) => path.join(checkout, ".claude", "work", "decisions");
    for (const dir of [
      options?.firstRaise === true ? checkoutA : decisionsDir(checkoutA),
      decisionsDir(checkoutB),
      path.join(initiativesRoot, ".live"),
    ]) {
      yield* fs.makeDirectory(dir, { recursive: true });
    }
    const makeDecisionsDir = (checkout: string) =>
      fs.makeDirectory(decisionsDir(checkout), { recursive: true });
    const write = (checkout: string, record: ReturnType<typeof decisionRecord>) =>
      fs.writeFileString(
        path.join(decisionsDir(checkout), `${record.id}.json`),
        JSON.stringify(record),
      );

    for (const record of options?.seed ?? []) yield* write(checkoutA, record);

    const lookup = {
      threadForClaudeSession: (session: string) =>
        Effect.succeed(session === "session-b" ? THREAD_B : null),
      threadsForDir: (dir: string) =>
        Effect.succeed(
          dir === checkoutA ? [THREAD_A] : dir === checkoutB ? [THREAD_A, THREAD_B] : [],
        ),
    };
    let lookupReads = 0;
    const index = Layer.succeed(PluginThreadIndex, {
      ...lookup,
      decisionLookup: Effect.sync(() => {
        lookupReads++;
        return { ...lookup, checkouts: [checkoutA, checkoutB] };
      }),
      decisionMappingChanges: Stream.empty,
      threadForPid: () => Effect.succeed(null),
      claudeTranscript: (threadId) =>
        Effect.succeed(
          threadId === options?.transcriptFor
            ? { sessionId: "s-1", transcriptPath: path.join(root, "s-1.jsonl") }
            : null,
        ),
      checkouts: Effect.succeed([checkoutA, checkoutB]),
    });
    const source = yield* makeDispatchDecisionSource(
      options?.rootFromEnv === true ? undefined : { initiativesRoot },
    ).pipe(
      Effect.provide(Layer.mergeAll(index, Layer.mock(ProcessRunner.ProcessRunner)({}))),
      Effect.provideService(
        HostProcess.Environment,
        options?.rootFromEnv === true ? { DISPATCH_INITIATIVES_ROOT: initiativesRoot } : {},
      ),
    );
    return {
      source,
      checkoutA,
      checkoutB,
      initiativesRoot,
      decisionsDir,
      makeDecisionsDir,
      write,
      ready,
      events,
      lookupReads: () => lookupReads,
    };
  }).pipe(Effect.provide(Layer.mergeAll(fsLayer, NodePath.layer)));
});

const command = (text: string, output: string | null = null, cwd = "/repo") => ({
  threadId: THREAD_A,
  turnItemId: TurnItemId.make("item-1"),
  command: text,
  output,
  exitCode: 0,
  cwd,
  completedAt: null,
});

const decisionCards = (cards: ReadonlyArray<unknown>) =>
  cards as ReadonlyArray<DispatchDecisionCard>;

it.effect("recognises dp decision raise, wait, answer and show, keyed by directory and id", () =>
  Effect.gen(function* () {
    const { source } = yield* setup();
    const keys = (text: string, output: string | null = null) =>
      source.recognize(command(text, output)).map((ref) => `${ref.kind} ${ref.key}`);

    assert.deepStrictEqual(
      keys(
        "dp decision raise --dir /work/x --kind batch-approval --option go=Go",
        "decision batch-approval-core-w1: default stop after 2026-11-21T10:05:00Z\n",
      ),
      ["dispatch.decision /work/x#batch-approval-core-w1"],
    );
    assert.deepStrictEqual(
      keys(
        "dp decision raise -needs-person -kind guard-failure",
        "decision guard-np-1: needs a person, no default (options retry, abort)\n",
      ),
      ["dispatch.decision /repo#guard-np-1"],
    );
    assert.deepStrictEqual(
      keys(
        "dp decision raise --json",
        JSON.stringify({ id: "raised-json", state: "open" }, null, 2),
      ),
      ["dispatch.decision /repo#raised-json"],
    );
    assert.deepStrictEqual(
      keys("dp decision raise --kind x", "dp: no options\nERROR_CODE=arg_error\n"),
      [],
    );
    assert.deepStrictEqual(keys("cd /repo && dp decision wait d-1 --dir=sub"), [
      "dispatch.decision /repo/sub#d-1",
    ]);
    assert.deepStrictEqual(keys("dp decision answer d-2 go -dir /abs --actor person"), [
      "dispatch.decision /abs#d-2",
    ]);
    assert.deepStrictEqual(keys(`~/.local/bin/dp decision show d-3 --dir "/a b"`), [
      "dispatch.decision /a b#d-3",
    ]);
    assert.deepStrictEqual(keys("dp decision wait d-4; dp decision answer d-5 stop --dir /o"), [
      "dispatch.decision /repo#d-4",
      "dispatch.decision /o#d-5",
    ]);
    assert.deepStrictEqual(keys("dp decision list --open"), []);
    assert.deepStrictEqual(keys("dp decision due"), []);
    assert.deepStrictEqual(keys("mydp decision wait d-6"), []);
    assert.deepStrictEqual(keys("dp decision wait --deadline-seconds 5"), []);
  }),
);

it.effect("gives a chat only the decisions that map to it, placed when they were raised", () =>
  Effect.gen(function* () {
    const { source, checkoutA, checkoutB, write, lookupReads } = yield* setup({
      transcriptFor: THREAD_A,
    });
    yield* write(checkoutA, decisionRecord("mine-open"));
    yield* write(
      checkoutA,
      decisionRecord("mine-answered", {
        state: "answered",
        choice: "go",
        chosenBy: "person",
        raisedAt: "2026-11-21T09:00:00Z",
        resolvedAt: "2026-11-21T09:01:00Z",
      }),
    );
    yield* write(
      checkoutB,
      decisionRecord("theirs", { grantSession: "session-b", needsPerson: true }),
    );
    yield* write(checkoutB, decisionRecord("unmapped"));

    const mine = decisionCards(yield* source.cardsForThread(THREAD_A));
    assert.deepStrictEqual(
      mine.map((card) => [card.id, card.threadId, card.placement, card.updatedAt, card.data.state]),
      [
        [
          `dispatch.decision:${checkoutA}#mine-answered`,
          THREAD_A,
          { type: "time", at: "2026-11-21T09:00:00Z" },
          "2026-11-21T09:01:00Z",
          "answered",
        ],
        [
          `dispatch.decision:${checkoutA}#mine-open`,
          THREAD_A,
          { type: "time", at: RAISED_AT },
          RAISED_AT,
          "open",
        ],
      ],
    );
    assert.deepStrictEqual(
      mine.map((card) => card.data.answerable),
      ["yes", "yes"],
    );

    const theirs = decisionCards(yield* source.cardsForThread(THREAD_B));
    assert.deepStrictEqual(
      theirs.map((card) => [card.id, card.data.answerable]),
      [[`dispatch.decision:${checkoutB}#theirs`, "terminal-only"]],
    );

    const live = yield* source.live;
    assert.deepStrictEqual(
      live.decisions.map((decision) => [decision.cardId, decision.threadId, decision.needsPerson]),
      [
        [`dispatch.decision:${checkoutA}#mine-open`, THREAD_A, false],
        [`dispatch.decision:${checkoutB}#theirs`, THREAD_B, true],
        [`dispatch.decision:${checkoutB}#unmapped`, null, false],
      ],
    );
    assert.deepStrictEqual(live.waitingThreadIds, [THREAD_A, THREAD_B]);
    assert.strictEqual(lookupReads(), 1);
  }),
);

it.effect("resolves a recognised decision, answerable only in the chat it maps to", () =>
  Effect.gen(function* () {
    const { source, checkoutA, checkoutB, write } = yield* setup({ transcriptFor: THREAD_A });
    yield* write(checkoutA, decisionRecord("mine", { applyAfter: "0001-01-01T00:00:00Z" }));
    yield* write(checkoutB, decisionRecord("theirs", { grantSession: "session-b" }));
    const ref = (dir: string, id: string) => ({
      kind: "dispatch.decision" as const,
      key: `${dir}#${id}`,
    });

    const mine = yield* source.resolve(ref(checkoutA, "mine"), THREAD_A);
    assert.strictEqual(mine?.kind, "dispatch.decision");
    if (mine?.kind !== "dispatch.decision") return;
    assert.deepStrictEqual(
      [
        mine.data.decisionId,
        mine.data.dir,
        mine.data.applyAfter,
        mine.data.answerable,
        mine.data.answer,
      ],
      ["mine", checkoutA, null, "yes", null],
    );
    assert.deepStrictEqual(mine.actions, []);
    const found = yield* source.findDecision(`dispatch.decision:${checkoutA}/.#mine`);
    assert.strictEqual(found?.record.dir, checkoutA);
    assert.strictEqual(found?.threadId, THREAD_A);

    const elsewhere = yield* source.resolve(ref(checkoutB, "theirs"), THREAD_A);
    assert.strictEqual(
      elsewhere?.kind === "dispatch.decision" ? elsewhere.data.answerable : null,
      "terminal-only",
    );
    assert.isNull(yield* source.resolve(ref(checkoutA, "missing"), THREAD_A));
    assert.isNull(
      yield* source.resolve({ kind: "gitty.push", key: `${checkoutA}#mine` }, THREAD_A),
    );
  }),
);

it.effect("marks a mapped chat with no Claude transcript terminal-only", () =>
  Effect.gen(function* () {
    const { source, checkoutA, write } = yield* setup();
    yield* write(checkoutA, decisionRecord("mine"));
    const cards = decisionCards(yield* source.cardsForThread(THREAD_A));
    assert.deepStrictEqual(
      cards.map((card) => card.data.answerable),
      ["terminal-only"],
    );
  }),
);

it.effect("shows answer progress on an open decision's card and drops it once resolved", () =>
  Effect.gen(function* () {
    const { source, checkoutA, write, ready, events } = yield* setup({
      transcriptFor: THREAD_A,
      seed: [decisionRecord("mine")],
    });
    for (let count = 0; count < 3; count++) yield* Queue.take(ready);
    const changed = yield* Queue.unbounded<void>();
    yield* Stream.runForEach(source.changes, () => Queue.offer(changed, undefined)).pipe(
      Effect.forkScoped({ startImmediately: true }),
    );
    const cardId = `dispatch.decision:${checkoutA}#mine`;
    const progress = {
      optionKey: "go",
      status: "failed" as const,
      reason: "chat-quote-invalid" as const,
      detail: "dp: line is marked isMeta",
    };
    const progressThreads = yield* Queue.unbounded<ThreadId>();
    yield* Stream.runForEach(source.progressChanges, (threadId) =>
      Queue.offer(progressThreads, threadId),
    ).pipe(Effect.forkScoped({ startImmediately: true }));
    yield* source.setProgress(THREAD_A, cardId, progress);
    assert.strictEqual(yield* Queue.take(progressThreads), THREAD_A);
    assert.strictEqual(yield* Queue.size(changed), 0);
    assert.deepStrictEqual(
      decisionCards(yield* source.cardsForThread(THREAD_A))[0]?.data.answer,
      progress,
    );

    yield* write(
      checkoutA,
      decisionRecord("mine", { state: "answered", choice: "go", chosenBy: "person" }),
    );
    yield* Queue.take(events);
    yield* TestClock.adjust("250 millis");
    yield* Queue.take(changed);
    assert.isNull(decisionCards(yield* source.cardsForThread(THREAD_A))[0]?.data.answer);

    yield* source.setProgress(THREAD_A, cardId, null);
    yield* write(checkoutA, decisionRecord("mine"));
    yield* Queue.take(events);
    yield* TestClock.adjust("250 millis");
    yield* Queue.take(changed);
    assert.isNull(decisionCards(yield* source.cardsForThread(THREAD_A))[0]?.data.answer);
  }),
);

it.effect("signals a change after a record is edited on disk, and reads the edit", () =>
  Effect.gen(function* () {
    const { source, checkoutA, decisionsDir, initiativesRoot, write, ready, events } = yield* setup(
      {
        transcriptFor: THREAD_A,
        seed: [decisionRecord("mine")],
      },
    );
    const watched = new Set<string>();
    for (let count = 0; count < 3; count++) watched.add(yield* Queue.take(ready));
    assert.isTrue(watched.has(decisionsDir(checkoutA)));
    assert.isTrue(watched.has(`${initiativesRoot}/.live`));

    const changed = yield* Queue.unbounded<void>();
    yield* Stream.runForEach(source.changes, () => Queue.offer(changed, undefined)).pipe(
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* write(
      checkoutA,
      decisionRecord("mine", { state: "answered", choice: "go", chosenBy: "person" }),
    );
    assert.strictEqual(yield* Queue.take(events), decisionsDir(checkoutA));
    yield* TestClock.adjust("249 millis");
    assert.strictEqual(yield* Queue.size(changed), 0);
    yield* TestClock.adjust("1 millis");
    yield* Queue.take(changed);

    assert.deepStrictEqual(
      decisionCards(yield* source.cardsForThread(THREAD_A)).map((card) => card.data.state),
      ["answered"],
    );
    const live = yield* source.live;
    assert.deepStrictEqual([live.decisions, live.waitingThreadIds], [[], []]);
  }),
);

it.effect("notices a checkout's first decision raised outside the chat", () =>
  Effect.gen(function* () {
    const { source, checkoutA, makeDecisionsDir, write, ready, events } = yield* setup({
      firstRaise: true,
    });
    yield* Queue.take(ready);
    assert.strictEqual(yield* Queue.take(ready), checkoutA);

    const changed = yield* Queue.unbounded<void>();
    yield* Stream.runForEach(source.changes, () => Queue.offer(changed, undefined)).pipe(
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* makeDecisionsDir(checkoutA);
    yield* write(checkoutA, decisionRecord("first"));
    yield* Queue.take(events);
    yield* TestClock.adjust("250 millis");
    yield* Queue.take(changed);
    assert.deepStrictEqual((yield* source.live).waitingThreadIds, [THREAD_A]);
  }),
);

it.effect("watches the registry under DISPATCH_INITIATIVES_ROOT, like the live source", () =>
  Effect.gen(function* () {
    const { checkoutA, decisionsDir, initiativesRoot, ready } = yield* setup({
      rootFromEnv: true,
      seed: [decisionRecord("mine")],
    });
    const watched = new Set<string>();
    for (let count = 0; count < 3; count++) watched.add(yield* Queue.take(ready));
    assert.isTrue(watched.has(decisionsDir(checkoutA)));
    assert.isTrue(watched.has(`${initiativesRoot}/.live`));
  }),
);
