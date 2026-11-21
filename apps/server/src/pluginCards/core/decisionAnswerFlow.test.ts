import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, it } from "@effect/vitest";
import {
  type DispatchDecisionCard,
  type OrchestrationV2ThreadShell,
  type PluginCardError,
  type PluginDecisionAnswerProgress,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { makeDispatchDecisionSource } from "../dispatch/decisionSource.ts";
import * as DecisionAnswerFlow from "./decisionAnswerFlow.ts";
import { PluginThreadIndex } from "./PluginThreadIndex.ts";

const THREAD = ThreadId.make("thread-1");
const OTHER_THREAD = ThreadId.make("thread-2");
const PROJECT = ProjectId.make("project-1");
const RAISED_AT = "2026-11-21T10:00:00Z";
const ANSWER_TEXT = "Decision d-1: Retry the phase (retry)";

const decisionRecord = (overrides: Record<string, unknown> = {}) => ({
  schema: "decision/1",
  id: "d-1",
  kind: "guard-failure",
  part: "core",
  wave: 2,
  phase: "3",
  question: "The guard failed. What now?",
  options: [
    { key: "retry", label: "Retry the phase", command: "dp retry" },
    { key: "abort", label: "Abort", command: "" },
  ],
  default: "",
  defaultReason: "",
  raisedAt: RAISED_AT,
  applyAfter: "0001-01-01T00:00:00Z",
  state: "open",
  choice: "",
  chosenBy: "",
  resolvedAt: "",
  needsPerson: true,
  ...overrides,
});

const userLine = (uuid: string, text: string, timestamp: string) =>
  `${JSON.stringify({
    type: "user",
    uuid,
    timestamp,
    sessionId: "s-1",
    message: { role: "user", content: [{ type: "text", text }] },
  })}\n`;

const dpOutput = (code: number, stderr = ""): ProcessRunner.ProcessRunOutput => ({
  stdout: "",
  stderr,
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const QUOTE_INVALID = dpOutput(
  4,
  "dp: line u-posted-1 in the transcript is marked isMeta\nERROR_CODE=chat_quote_invalid\n",
);

/** Real file watching, reporting each installed transcript watcher on `ready`. */
const watchingFileSystem = (ready: Queue.Queue<string>) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return {
        ...fs,
        watch: (path: string, options?: FileSystem.WatchOptions) =>
          fs.watch(path, {
            ...options,
            onReady: () => {
              options?.onReady?.();
              if (path.endsWith(".jsonl")) Queue.offerUnsafe(ready, path);
            },
          }),
      } satisfies FileSystem.FileSystem;
    }),
  ).pipe(Layer.provide(NodeFileSystem.layer));

interface HarnessOptions {
  readonly knownCheckout?: boolean;
  readonly record?: Record<string, unknown>;
  /** The chat the decision's directory maps to; null leaves it unmapped. */
  readonly mapTo?: ThreadId | null;
  readonly transcript?: boolean;
  readonly dpInstalled?: boolean;
  readonly delivery?: ThreadManagementService.ThreadManagementSendResult["delivery"];
  /** Whether a send writes the person's line to the transcript, as Claude does. */
  readonly appendOnSend?: boolean;
  /** Holds each send until it is opened. */
  readonly sendGate?: Deferred.Deferred<void>;
  readonly dpResults?: Array<ProcessRunner.ProcessRunOutput>;
}

const harness = Effect.fnUntraced(function* (options: HarnessOptions = {}) {
  const ready = yield* Queue.unbounded<string>();
  const layers = Layer.mergeAll(watchingFileSystem(ready), NodePath.layer);
  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-decision-answer-" });
    const checkout = path.join(root, "repo");
    const decisionsDir = path.join(checkout, ".claude", "work", "decisions");
    yield* fs.makeDirectory(decisionsDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(decisionsDir, "d-1.json"),
      JSON.stringify(decisionRecord(options.record)),
    );
    const transcriptPath = path.join(root, "projects", "repo", "s-1.jsonl");
    yield* fs.makeDirectory(path.dirname(transcriptPath), { recursive: true });
    // The same words, said before this answer was sent, must not be quoted.
    yield* fs.writeFileString(
      transcriptPath,
      userLine("u-old", ANSWER_TEXT, "2026-11-21T10:10:00Z"),
    );
    const bin = path.join(root, "bin");
    yield* fs.makeDirectory(bin);
    yield* fs.writeFileString(path.join(bin, "dp"), "", { mode: 0o755 });

    const mapTo = options.mapTo === undefined ? THREAD : options.mapTo;
    const index = Layer.succeed(PluginThreadIndex, {
      threadForClaudeSession: () => Effect.succeed(null),
      threadsForDir: (dir) => Effect.succeed(dir === checkout && mapTo !== null ? [mapTo] : []),
      threadForPid: () => Effect.succeed(null),
      claudeTranscript: (threadId) =>
        Effect.succeed(
          options.transcript !== false && threadId === THREAD
            ? { sessionId: "s-1", transcriptPath }
            : null,
        ),
      checkouts: Effect.succeed(options.knownCheckout === false ? [] : [checkout]),
      decisionLookup: Effect.succeed({
        checkouts: [checkout],
        threadForClaudeSession: () => Effect.succeed(null),
        threadsForDir: (dir: string) =>
          Effect.succeed(dir === checkout && mapTo !== null ? [mapTo] : []),
      }),
      decisionMappingChanges: Stream.empty,
    });

    const sends: Array<ThreadManagementService.ThreadManagementSendInput> = [];
    const sendStarted = yield* Queue.unbounded<void>();
    const threadManagement = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: () =>
        Effect.succeed({ projectId: PROJECT } as unknown as OrchestrationV2ThreadShell),
      sendToThread: (input) =>
        Effect.gen(function* () {
          sends.push(input);
          yield* Queue.offer(sendStarted, undefined);
          if (options.sendGate !== undefined) yield* Deferred.await(options.sendGate);
          if (options.appendOnSend !== false) {
            yield* fs.writeFileString(
              transcriptPath,
              userLine(`u-posted-${sends.length}`, input.text, "2026-11-21T10:30:00Z"),
              { flag: "a" },
            );
          }
          return {
            delivery: options.delivery ?? "started",
          } as unknown as ThreadManagementService.ThreadManagementSendResult;
        }).pipe(Effect.orDie),
    });

    const dpRuns = yield* Queue.unbounded<ProcessRunner.ProcessRunInput>();
    const dpResults = [...(options.dpResults ?? [])];
    const runner = Layer.mock(ProcessRunner.ProcessRunner)({
      run: (input) => Queue.offer(dpRuns, input).pipe(Effect.as(dpResults.shift() ?? dpOutput(0))),
    });

    const services = Layer.mergeAll(index, threadManagement, runner);
    const source = yield* makeDispatchDecisionSource({
      initiativesRoot: path.join(root, "initiatives"),
    }).pipe(Effect.provide(services));
    const progress = yield* Queue.unbounded<PluginDecisionAnswerProgress | null>();
    const flow = yield* DecisionAnswerFlow.make({
      ...source,
      setProgress: (threadId, cardId, next) =>
        source
          .setProgress(threadId, cardId, next)
          .pipe(Effect.andThen(Queue.offer(progress, next))),
    }).pipe(
      Effect.provide(services),
      Effect.provideService(HostProcess.Environment, {
        PATH: options.dpInstalled === false ? path.join(root, "empty") : bin,
      }),
    );
    const card = Effect.map(
      source.cardsForThread(THREAD),
      (cards) => (cards as ReadonlyArray<DispatchDecisionCard>)[0],
    );
    return {
      flow,
      cardId: `dispatch.decision:${checkout}#d-1`,
      checkout,
      transcriptPath,
      dpPath: path.join(bin, "dp"),
      sends,
      sendStarted,
      dpRuns,
      progress,
      ready,
      card,
      append: (line: string) => fs.writeFileString(transcriptPath, line, { flag: "a" }),
    };
  }).pipe(Effect.provide(layers));
});

type Harness = Effect.Success<ReturnType<typeof harness>>;

const answer = (h: Harness, optionKey = "retry", threadId = THREAD) =>
  h.flow.answer({ threadId, cardId: h.cardId, optionKey });

const failureOf = <A>(effect: Effect.Effect<A, PluginCardError>) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => (Result.isFailure(result) ? result.failure.reason : "succeeded")),
  );

const takeProgress = (h: Harness, count: number) =>
  Effect.forEach(Array.from({ length: count }), () => Queue.take(h.progress));

const expectedDpArgs = (h: Harness, key: string, uuid: string) => [
  "decision",
  "answer",
  "d-1",
  key,
  "--dir",
  h.checkout,
  "--actor",
  "person",
  "--from-turn",
  `${h.transcriptPath}:${uuid}`,
  "--json",
];

it.effect("posts one message naming the decision and option, then quotes its line to dp", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    assert.deepStrictEqual(yield* answer(h), { delivery: "started" });

    const run = yield* Queue.take(h.dpRuns);
    assert.deepStrictEqual(
      h.sends.map((send) => [
        send.threadId,
        send.projectId,
        send.text,
        send.mode,
        send.createdBy,
        send.creationSource,
      ]),
      [[THREAD, PROJECT, ANSWER_TEXT, "auto", "user", "web"]],
    );
    assert.deepStrictEqual(h.sends[0]?.attachments, []);
    assert.strictEqual(run.command, h.dpPath);
    assert.deepStrictEqual(run.args, expectedDpArgs(h, "retry", "u-posted-1"));
    assert.strictEqual(run.cwd, h.checkout);

    assert.deepStrictEqual(
      (yield* takeProgress(h, 3)).map((step) => step?.status ?? null),
      ["posting", "recording", null],
    );
    assert.isNull((yield* h.card)?.data.answer);
  }),
);

it.effect.each([
  { delivery: "queued", expected: "queued" },
  { delivery: "steered", expected: "started" },
] as const)("reports a $delivery send as $expected", ({ delivery, expected }) =>
  Effect.gen(function* () {
    const h = yield* harness({ delivery });
    assert.deepStrictEqual(yield* answer(h), { delivery: expected });
    yield* Queue.take(h.dpRuns);
  }),
);

it.effect.each([
  {
    name: "an answered decision",
    options: { record: { state: "answered", choice: "abort" } },
    reason: "decision-closed",
  },
  {
    name: "a defaulted decision",
    options: { record: { state: "defaulted", choice: "abort" } },
    reason: "decision-closed",
  },
  { name: "an unknown option", options: {}, key: "skip", reason: "unknown-option" },
  {
    name: "a decision outside known checkouts",
    options: { knownCheckout: false },
    reason: "unknown-card",
  },
  {
    name: "a decision mapped to another chat",
    options: { mapTo: OTHER_THREAD },
    reason: "not-this-chat",
  },
  { name: "an unmapped decision", options: { mapTo: null }, reason: "not-this-chat" },
  {
    name: "a chat with no Claude transcript",
    options: { transcript: false },
    reason: "terminal-only",
  },
  { name: "a missing dp", options: { dpInstalled: false }, reason: "dp-missing" },
] satisfies ReadonlyArray<{
  name: string;
  options: HarnessOptions;
  key?: string;
  reason: PluginCardError["reason"];
}>)("refuses $name with $reason and posts nothing", ({ options, key, reason }) =>
  Effect.gen(function* () {
    const h = yield* harness(options);
    assert.strictEqual(yield* failureOf(answer(h, key)), reason);
    assert.deepStrictEqual(h.sends, []);
    assert.strictEqual(yield* Queue.size(h.dpRuns), 0);
    assert.strictEqual(yield* Queue.size(h.progress), 0);
  }),
);

it.effect("refuses a card that names no decision on disk", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    for (const cardId of [
      `dispatch.decision:${h.checkout}#d-404`,
      "dispatch.decision:no-key",
      "gitty.push:x",
    ]) {
      assert.strictEqual(
        yield* failureOf(h.flow.answer({ threadId: THREAD, cardId, optionKey: "retry" })),
        "unknown-card",
      );
    }
    assert.deepStrictEqual(h.sends, []);
  }),
);

it.effect("asks for the answer from the chat that asked, not the chat it maps to", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    assert.strictEqual(yield* failureOf(answer(h, "retry", OTHER_THREAD)), "not-this-chat");
    assert.deepStrictEqual(h.sends, []);
  }),
);

it.effect("keeps the decision open and shows dp's reason when dp refuses the quote", () =>
  Effect.gen(function* () {
    const h = yield* harness({ dpResults: [QUOTE_INVALID] });
    yield* answer(h);
    yield* Queue.take(h.dpRuns);
    const failed = {
      optionKey: "retry",
      status: "failed",
      reason: "chat-quote-invalid",
      detail: "dp: line u-posted-1 in the transcript is marked isMeta",
    } as const;
    assert.deepStrictEqual((yield* takeProgress(h, 3))[2], failed);
    const card = yield* h.card;
    assert.strictEqual(card?.data.state, "open");
    assert.deepStrictEqual(card?.data.answer, failed);
  }),
);

it.effect("reports a dp that cannot be run as dp-failed", () =>
  Effect.gen(function* () {
    const h = yield* harness({ dpResults: [dpOutput(2)] });
    yield* answer(h);
    const last = (yield* takeProgress(h, 3))[2];
    assert.deepStrictEqual(
      [last?.status, last?.reason, last?.detail],
      ["failed", "dp-failed", "dp exited with code 2."],
    );
  }),
);

it.effect("retries a refused answer by quoting the same line again, without a second post", () =>
  Effect.gen(function* () {
    const h = yield* harness({ dpResults: [QUOTE_INVALID, dpOutput(0)] });
    yield* answer(h);
    const first = yield* Queue.take(h.dpRuns);
    yield* takeProgress(h, 3);

    assert.deepStrictEqual(yield* answer(h), { delivery: "reused" });
    const second = yield* Queue.take(h.dpRuns);
    assert.deepStrictEqual(second.args, first.args);
    assert.deepStrictEqual(second.args, expectedDpArgs(h, "retry", "u-posted-1"));
    assert.strictEqual(h.sends.length, 1);
    assert.deepStrictEqual(
      (yield* takeProgress(h, 2)).map((step) => step?.status ?? null),
      ["recording", null],
    );
  }),
);

it.effect("posts again when the retry picks a different option", () =>
  Effect.gen(function* () {
    const h = yield* harness({ dpResults: [QUOTE_INVALID, dpOutput(0)] });
    yield* answer(h);
    yield* Queue.take(h.dpRuns);
    yield* takeProgress(h, 3);

    assert.deepStrictEqual(yield* answer(h, "abort"), { delivery: "started" });
    const second = yield* Queue.take(h.dpRuns);
    assert.deepStrictEqual(
      h.sends.map((send) => send.text),
      [ANSWER_TEXT, "Decision d-1: Abort (abort)"],
    );
    assert.deepStrictEqual(second.args, expectedDpArgs(h, "abort", "u-posted-2"));
  }),
);

it.effect("still quotes a message that reaches the transcript after 14 minutes", () =>
  Effect.gen(function* () {
    const h = yield* harness({ appendOnSend: false, delivery: "queued" });
    assert.deepStrictEqual(yield* answer(h), { delivery: "queued" });
    assert.strictEqual(yield* Queue.take(h.ready), h.transcriptPath);
    yield* TestClock.adjust("14 minutes");
    yield* h.append(userLine("u-late", ANSWER_TEXT, "2026-11-21T10:45:00Z"));
    const run = yield* Queue.take(h.dpRuns);
    assert.deepStrictEqual(run.args, expectedDpArgs(h, "retry", "u-late"));
  }),
);

it.effect(
  "fails with message-not-in-transcript when the message has not appeared in 15 minutes",
  () =>
    Effect.gen(function* () {
      const h = yield* harness({ appendOnSend: false });
      yield* answer(h);
      assert.strictEqual(yield* Queue.take(h.ready), h.transcriptPath);
      yield* TestClock.adjust("15 minutes");
      const last = (yield* takeProgress(h, 3))[2];
      assert.deepStrictEqual([last?.status, last?.reason], ["failed", "message-not-in-transcript"]);
      assert.strictEqual(yield* Queue.size(h.dpRuns), 0);
      assert.strictEqual((yield* h.card)?.data.state, "open");

      // Nothing was quoted, so a retry posts afresh.
      assert.deepStrictEqual(yield* answer(h), { delivery: "started" });
      assert.strictEqual(h.sends.length, 2);
    }),
);

it.effect("refuses a second answer while the first is in progress, and posts once", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const h = yield* harness({ sendGate: gate });
    const first = yield* answer(h).pipe(Effect.forkChild);
    yield* Queue.take(h.sendStarted);
    assert.strictEqual(yield* failureOf(answer(h)), "answer-in-progress");
    assert.strictEqual(yield* failureOf(answer(h, "abort")), "answer-in-progress");
    yield* Deferred.succeed(gate, undefined);
    assert.deepStrictEqual(yield* Fiber.join(first), { delivery: "started" });
    yield* Queue.take(h.dpRuns);
    assert.strictEqual(h.sends.length, 1);
  }),
);

it.effect("keeps watching for a posted answer after the request is interrupted", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const h = yield* harness({
      sendGate: gate,
      appendOnSend: false,
      dpResults: [QUOTE_INVALID, dpOutput(0)],
    });
    const request = yield* answer(h).pipe(Effect.forkChild);
    yield* Queue.take(h.sendStarted);
    yield* Fiber.interrupt(request);
    assert.strictEqual(yield* failureOf(answer(h, "skip")), "answer-in-progress");

    yield* Deferred.succeed(gate, undefined);
    assert.strictEqual(yield* Queue.take(h.ready), h.transcriptPath);
    yield* h.append(userLine("u-interrupted", ANSWER_TEXT, "2026-11-21T10:30:00Z"));
    const first = yield* Queue.take(h.dpRuns);
    assert.deepStrictEqual(first.args, expectedDpArgs(h, "retry", "u-interrupted"));
    assert.strictEqual((yield* takeProgress(h, 3))[2]?.reason, "chat-quote-invalid");

    assert.deepStrictEqual(yield* answer(h), { delivery: "reused" });
    assert.deepStrictEqual((yield* Queue.take(h.dpRuns)).args, first.args);
    assert.strictEqual(h.sends.length, 1);
  }),
);

it.effect("frees the decision for another answer once a refusal or a recording ends", () =>
  Effect.gen(function* () {
    const h = yield* harness({ dpResults: [QUOTE_INVALID] });
    assert.strictEqual(yield* failureOf(answer(h, "skip")), "unknown-option");
    yield* answer(h);
    yield* Queue.take(h.dpRuns);
    yield* takeProgress(h, 3);
    assert.deepStrictEqual(yield* answer(h), { delivery: "reused" });
  }),
);
