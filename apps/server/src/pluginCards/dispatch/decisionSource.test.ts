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
import type { RecognizableCommand } from "../core/PluginCardSource.ts";
import { PluginThreadIndex } from "../core/PluginThreadIndex.ts";
import { makeDispatchDecisionSource } from "./decisionSource.ts";

const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");
const THREAD_C = ThreadId.make("thread-c");
const THREAD_D = ThreadId.make("thread-d");
const SESSIONS: Record<string, ThreadId> = {
  "session-a": THREAD_A,
  "session-b": THREAD_B,
  "session-c": THREAD_C,
  "session-d": THREAD_D,
};
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

/** A decision thread A's own Claude session raised. */
const raisedByA = (id: string, overrides: Record<string, unknown> = {}) =>
  decisionRecord(id, { grantSession: "session-a", ...overrides });

const registryEntry = (slug: string, overrides: Record<string, unknown>) => ({
  slug,
  closed: false,
  totalWave: 1,
  totalRunning: 1,
  totalSettled: 0,
  totalCostUsd: 0,
  reportedCostUsd: 0,
  started: "2026-11-21T09:00:00Z",
  touched: "2026-11-21T09:00:00Z",
  liveUntil: "2026-11-21T11:00:00Z",
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
 * Checkout `a` is only thread A's working directory and checkout `b` is shared by A and B. Only a
 * proven link maps a decision: `session-a` to `session-d` are threads A to D, `pids` names chats by
 * process, and `commands` are each chat's finished commands.
 */
const setup = Effect.fnUntraced(function* (options?: {
  readonly transcriptFor?: ThreadId;
  readonly firstRaise?: boolean;
  /** Passes the root as DISPATCH_INITIATIVES_ROOT instead of as an option. */
  readonly rootFromEnv?: boolean;
  /** Written to checkout `a` before any watcher starts. */
  readonly seed?: ReadonlyArray<ReturnType<typeof decisionRecord>>;
  readonly commands?: (checkouts: {
    readonly checkoutA: string;
    readonly checkoutB: string;
  }) => Partial<Record<ThreadId, ReadonlyArray<RecognizableCommand>>>;
  readonly pids?: Record<number, ThreadId>;
  /** Run feed text, given the checkouts. */
  readonly runFeed?: (checkouts: { readonly checkoutA: string }) => string;
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
    const runFeedPath = path.join(root, "state", "runs.jsonl");
    yield* fs.makeDirectory(path.dirname(runFeedPath), { recursive: true });
    yield* fs.writeFileString(runFeedPath, options?.runFeed?.({ checkoutA }) ?? "");
    const commands = options?.commands?.({ checkoutA, checkoutB }) ?? {};

    const lookup = {
      threadForClaudeSession: (session: string) => Effect.succeed(SESSIONS[session] ?? null),
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
      threadForPid: (pid: number) => Effect.succeed(options?.pids?.[pid] ?? null),
      claudeTranscript: (threadId) =>
        Effect.succeed(
          threadId === options?.transcriptFor
            ? { sessionId: "s-1", transcriptPath: path.join(root, "s-1.jsonl") }
            : null,
        ),
      checkouts: Effect.succeed([checkoutA, checkoutB]),
    });
    const source = yield* makeDispatchDecisionSource({
      ...(options?.rootFromEnv === true ? {} : { initiativesRoot }),
      runFeedPath,
      commandsOf: (threadId) => Effect.succeed(commands[threadId] ?? []),
    }).pipe(
      Effect.provide(Layer.mergeAll(index, Layer.mock(ProcessRunner.ProcessRunner)({}))),
      Effect.provideService(
        HostProcess.Environment,
        options?.rootFromEnv === true ? { DISPATCH_INITIATIVES_ROOT: initiativesRoot } : {},
      ),
    );
    const writeRegistry = (entry: ReturnType<typeof registryEntry>) =>
      fs.writeFileString(
        path.join(initiativesRoot, ".live", `${entry.slug}.json`),
        JSON.stringify(entry),
      );
    return {
      source,
      writeRegistry,
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

const command = (
  text: string,
  output: string | null = null,
  cwd = "/repo",
): RecognizableCommand => ({
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
    yield* write(checkoutA, raisedByA("mine-open"));
    yield* write(
      checkoutA,
      raisedByA("mine-answered", {
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
    assert.deepStrictEqual(live.decisions, []);
    assert.deepStrictEqual(live.waitingThreadIds, [THREAD_B]);
    assert.strictEqual(lookupReads(), 1);
  }),
);

it.effect("resolves a recognised decision, answerable only in the chat it maps to", () =>
  Effect.gen(function* () {
    const { source, checkoutA, checkoutB, write } = yield* setup({ transcriptFor: THREAD_A });
    yield* write(checkoutA, raisedByA("mine", { applyAfter: "0001-01-01T00:00:00Z" }));
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
    yield* write(checkoutA, raisedByA("mine"));
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
      seed: [raisedByA("mine")],
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
      raisedByA("mine", { state: "answered", choice: "go", chosenBy: "person" }),
    );
    yield* Queue.take(events);
    yield* TestClock.adjust("250 millis");
    yield* Queue.take(changed);
    assert.isNull(decisionCards(yield* source.cardsForThread(THREAD_A))[0]?.data.answer);

    yield* source.setProgress(THREAD_A, cardId, null);
    yield* write(checkoutA, raisedByA("mine"));
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
        seed: [raisedByA("mine")],
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
      raisedByA("mine", { state: "answered", choice: "go", chosenBy: "person" }),
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
    yield* write(checkoutA, raisedByA("first", { needsPerson: true }));
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
      seed: [raisedByA("mine")],
    });
    const watched = new Set<string>();
    for (let count = 0; count < 3; count++) watched.add(yield* Queue.take(ready));
    assert.isTrue(watched.has(decisionsDir(checkoutA)));
    assert.isTrue(watched.has(`${initiativesRoot}/.live`));
  }),
);

it.effect(
  "gives a chat that is the only thread in a checkout none of the decisions other sessions raised there",
  () =>
    Effect.gen(function* () {
      const { source, checkoutA, write, writeRegistry } = yield* setup({
        transcriptFor: THREAD_A,
      });
      yield* writeRegistry(
        registryEntry("devbox-offload", {
          orchestratorSession: "cli-orchestrator",
          orchestratorCwd: checkoutA,
          repos: [{ root: checkoutA, worktrees: [] }],
        }),
      );
      yield* write(
        checkoutA,
        decisionRecord("cli-needs", { grantSession: "cli-session", needsPerson: true }),
      );
      yield* write(checkoutA, decisionRecord("cli-initiative", { initiative: "devbox-offload" }));
      yield* write(
        checkoutA,
        decisionRecord("cli-answered", { state: "answered", choice: "go", chosenBy: "person" }),
      );

      assert.deepStrictEqual(yield* source.cardsForThread(THREAD_A), []);
      assert.deepStrictEqual((yield* source.live).waitingThreadIds, []);
    }),
);

it.effect("marks a chat waiting only for a decision without a default", () =>
  Effect.gen(function* () {
    const { source, checkoutA, checkoutB, write } = yield* setup({
      commands: ({ checkoutA }) => ({
        [THREAD_A]: [
          command(
            "dp decision raise --needs-person --kind guard-failure",
            "decision raised-here: needs a person, no default (options retry, abort)\n",
            checkoutA,
          ),
        ],
      }),
    });
    yield* write(checkoutB, decisionRecord("ordinary", { grantSession: "session-d" }));
    yield* write(
      checkoutB,
      decisionRecord("needs", { grantSession: "session-b", needsPerson: true, default: "" }),
    );
    yield* write(
      checkoutB,
      decisionRecord("protected", { grantSession: "session-c", protection: "outward" }),
    );
    yield* write(
      checkoutA,
      decisionRecord("raised-here", { grantSession: "", needsPerson: true, default: "" }),
    );

    assert.deepStrictEqual((yield* source.live).waitingThreadIds, [THREAD_A, THREAD_B, THREAD_C]);
  }),
);

it.effect("recognises a decision id in dp design output as raised here", () =>
  Effect.gen(function* () {
    const { source } = yield* setup();
    const refs = source.recognize(
      command(
        "dp design run --part web --dir /work/web",
        [
          "web: findings (1 high, 0 medium, 0 low): layout overflow; decision design-web-w1",
          "spend-cap decision spend-cap-api-w1",
          "",
        ].join("\n"),
      ),
    );
    assert.deepStrictEqual(refs, [
      { kind: "dispatch.decision", key: "/work/web#design-web-w1", owns: true },
      { kind: "dispatch.decision", key: "/work/web#spend-cap-api-w1", owns: true },
    ]);
    assert.deepStrictEqual(
      source.recognize(
        command("dp wave status core", "core: parked; decision cap-core-w2\n", "/work/x"),
      ),
      [{ kind: "dispatch.decision", key: "/work/x#cap-core-w2", owns: true }],
    );
  }),
);

it.effect("marks raise and wait refs as owning, and show and answer refs as not", () =>
  Effect.gen(function* () {
    const { source } = yield* setup();
    const owns = (text: string, output: string | null = null) =>
      source.recognize(command(text, output)).map((ref) => ref.owns === true);
    assert.deepStrictEqual(
      owns("dp decision raise --kind x", "decision r-1: default stop after 2026-11-21T10:05:00Z\n"),
      [true],
    );
    assert.deepStrictEqual(owns("dp decision wait d-1"), [true]);
    assert.deepStrictEqual(owns("dp decision show d-1"), [false]);
    assert.deepStrictEqual(owns("dp decision answer d-1 go"), [false]);
  }),
);

it.effect("maps an unbound decision to the chat whose process opened its run", () =>
  Effect.gen(function* () {
    const opened = (dir: string, run: string, pid: number, ts: string) =>
      `${JSON.stringify({
        schema: "dp-run/1",
        ts,
        event: "run-opened",
        run,
        dir,
        part: "core",
        wave: 1,
        spec: ".claude/plans/core.md",
        pid,
        phases: 2,
      })}\n`;
    const { source, checkoutA, write } = yield* setup({
      transcriptFor: THREAD_B,
      pids: { 1111: THREAD_A, 4242: THREAD_B, 2004: THREAD_C },
      // Six runs for one dir, part and wave: only the newest five are kept.
      runFeed: ({ checkoutA }) =>
        [
          opened(checkoutA, "r-oldest", 1111, "2026-11-21T09:00:00Z"),
          opened(checkoutA, "r-1", 4242, "2026-11-21T09:59:00Z"),
          opened(checkoutA, "r-2", 2001, "2026-11-21T10:01:00Z"),
          opened(checkoutA, "r-3", 2002, "2026-11-21T10:02:00Z"),
          opened(checkoutA, "r-4", 2003, "2026-11-21T10:03:00Z"),
          opened(checkoutA, "r-5", 2004, "2026-11-21T10:04:00Z"),
        ].join(""),
    });
    yield* write(checkoutA, decisionRecord("spend-cap", { default: "stop" }));
    yield* write(checkoutA, decisionRecord("before-cap", { raisedAt: "2026-11-21T09:30:00Z" }));
    yield* write(checkoutA, decisionRecord("newest", { raisedAt: "2026-11-21T10:10:00Z" }));
    const cards = decisionCards(yield* source.cardsForThread(THREAD_B));
    assert.deepStrictEqual(
      cards.map((card) => [card.id, card.data.answerable]),
      [[`dispatch.decision:${checkoutA}#spend-cap`, "yes"]],
    );
    assert.deepStrictEqual(
      decisionCards(yield* source.cardsForThread(THREAD_C)).map((card) => card.id),
      [`dispatch.decision:${checkoutA}#newest`],
    );
    assert.deepStrictEqual(yield* source.cardsForThread(THREAD_A), []);
  }),
);
