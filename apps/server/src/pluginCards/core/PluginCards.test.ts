import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type PluginCard,
  type PluginCardAction,
  type PluginCardError,
  type PluginLiveDecision,
  type PluginLiveState,
  type PluginThreadCards,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../../processRunner.ts";
import type { DispatchDecisionLive, DispatchDecisionSource } from "../dispatch/decisionSource.ts";
import type {
  PluginCardSource,
  RecognizableCommand,
  ResolvedPluginCard,
} from "./PluginCardSource.ts";
import * as PluginCards from "./PluginCards.ts";
import * as PluginThreadIndex from "./PluginThreadIndex.ts";
import * as ThreadCommands from "./threadCommands.ts";

const THREAD = ThreadId.make("thread-1");
const DEBOUNCE = "150 millis";

const command = (ordinal: number, text: string): ThreadCommands.ThreadCommandItem => ({
  threadId: THREAD,
  turnItemId: TurnItemId.make(`item-${ordinal}`),
  ordinal,
  command: text,
  output: null,
  exitCode: 0,
  cwd: "/repo",
  completedAt: null,
});

const pushCard = (
  branch: string,
  actions: ReadonlyArray<PluginCardAction> = [],
): ResolvedPluginCard => ({
  kind: "gitty.push",
  updatedAt: "2026-11-21T10:00:00.000Z",
  actions,
  data: { branch, batches: [], mergeRequest: null },
});

/**
 * Recognises `push <key>` commands as `gitty.push:<key>` and resolves each key from `cards`.
 * Every resolve is reported on `resolves`, and `changes` drains `signals`.
 */
const makeHarness = Effect.fnUntraced(function* (options?: {
  readonly existing?: ReadonlyArray<ThreadCommands.ThreadCommandItem>;
  readonly mapped?: ReadonlyArray<PluginCard>;
  readonly source?: Partial<PluginCardSource>;
  readonly decisionSource?: DispatchDecisionSource;
}) {
  const cards = new Map<string, ResolvedPluginCard | null>();
  const resolves = yield* Queue.unbounded<string>();
  const signals = yield* Queue.unbounded<void>();
  const completions = yield* Queue.unbounded<ThreadCommands.ThreadCommandItem>();
  const source: PluginCardSource = {
    id: "fake",
    recognize: (item: RecognizableCommand) =>
      [...item.command.matchAll(/push (\S+)/g)].map((match) => ({
        kind: "gitty.push" as const,
        key: match[1]!,
      })),
    resolve: (ref) => Queue.offer(resolves, ref.key).pipe(Effect.as(cards.get(ref.key) ?? null)),
    cardsForThread: () => Effect.succeed(options?.mapped ?? []),
    changes: Stream.fromQueue(signals),
    ...options?.source,
  };
  const threadCommands = Layer.succeed(ThreadCommands.ThreadCommands, {
    list: () => Effect.succeed(options?.existing ?? []),
    follow: () =>
      Effect.succeed({
        existing: options?.existing ?? [],
        completed: Stream.fromQueue(completions),
      }),
  });
  const service = yield* PluginCards.make({
    cardSources: [Effect.succeed(source)],
    liveSources: [],
    decisionSource:
      options?.decisionSource === undefined ? null : Effect.succeed(options.decisionSource),
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        threadCommands,
        Layer.mock(PluginThreadIndex.PluginThreadIndex)({}),
        Layer.mock(ProcessRunner.ProcessRunner)({}),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        NodeServices.layer,
      ),
    ),
  );
  const snapshots = yield* Queue.unbounded<PluginThreadCards>();
  const subscribe = Stream.runForEach(service.subscribeThread(THREAD), (snapshot) =>
    Queue.offer(snapshots, snapshot),
  ).pipe(Effect.forkScoped);
  return { service, cards, resolves, signals, completions, snapshots, subscribe };
});

const placements = (snapshot: PluginThreadCards) =>
  snapshot.cards.map((card) => ({ id: card.id, placement: card.placement }));

const atItem = (ordinal: number) => ({
  type: "turnItem" as const,
  turnItemId: TurnItemId.make(`item-${ordinal}`),
});

it.effect("places a recognised card after the command that produced it", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ existing: [command(1, "push main")] });
    harness.cards.set("main", pushCard("main"));
    harness.cards.set("feature", pushCard("feature"));
    yield* harness.subscribe;

    const initial = yield* Queue.take(harness.snapshots);
    assert.strictEqual(initial.threadId, THREAD);
    assert.deepStrictEqual(placements(initial), [{ id: "gitty.push:main", placement: atItem(1) }]);
    assert.deepStrictEqual(initial.cards[0], {
      ...pushCard("main"),
      id: "gitty.push:main",
      threadId: THREAD,
      placement: atItem(1),
    });

    yield* Queue.offer(harness.completions, command(4, "push feature"));
    yield* TestClock.adjust(DEBOUNCE);
    assert.deepStrictEqual(placements(yield* Queue.take(harness.snapshots)), [
      { id: "gitty.push:main", placement: atItem(1) },
      { id: "gitty.push:feature", placement: atItem(4) },
    ]);
  }),
);

it.effect("places a card named by several commands once, after the earliest", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      existing: [command(5, "push main"), command(2, "push main"), command(8, "push main")],
    });
    harness.cards.set("main", pushCard("main"));
    yield* harness.subscribe;

    assert.deepStrictEqual(placements(yield* Queue.take(harness.snapshots)), [
      { id: "gitty.push:main", placement: atItem(2) },
    ]);

    // A command that finished earlier but was reported late moves the card up.
    yield* Queue.offer(harness.completions, command(1, "push main && push main"));
    yield* TestClock.adjust(DEBOUNCE);
    assert.deepStrictEqual(placements(yield* Queue.take(harness.snapshots)), [
      { id: "gitty.push:main", placement: atItem(1) },
    ]);
  }),
);

it.effect("sends no snapshot when a change leaves the thread's cards as they were", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ existing: [command(1, "push main")] });
    harness.cards.set("main", pushCard("main"));
    yield* harness.subscribe;
    yield* Queue.take(harness.snapshots);
    yield* Queue.take(harness.resolves);

    yield* Queue.offer(harness.signals, undefined);
    yield* TestClock.adjust(DEBOUNCE);
    yield* Queue.take(harness.resolves);
    // A later command that recognises nothing new triggers no work either.
    yield* Queue.offer(harness.completions, command(3, "push main"));
    yield* Queue.offer(harness.completions, command(4, "echo done"));
    yield* TestClock.adjust(DEBOUNCE);

    harness.cards.set("main", pushCard("main-renamed"));
    yield* Queue.offer(harness.signals, undefined);
    yield* TestClock.adjust(DEBOUNCE);
    const next = yield* Queue.take(harness.snapshots);
    assert.strictEqual(next.cards[0]?.kind, "gitty.push");
    assert.deepStrictEqual(next.cards[0]?.data, pushCard("main-renamed").data);
    assert.strictEqual(yield* Queue.size(harness.snapshots), 0);
  }),
);

it.effect("leaves out only the card whose source resolves to nothing", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      existing: [command(1, "push gone"), command(2, "push main")],
    });
    harness.cards.set("main", pushCard("main"));
    harness.cards.set("gone", null);
    yield* harness.subscribe;
    assert.deepStrictEqual(placements(yield* Queue.take(harness.snapshots)), [
      { id: "gitty.push:main", placement: atItem(2) },
    ]);
  }),
);

it.effect("keeps a mapped card at its command when a command also names it", () =>
  Effect.gen(function* () {
    const mapped = (branch: string, at: string): PluginCard => ({
      ...pushCard(branch),
      kind: "gitty.push",
      data: { branch, batches: [], mergeRequest: null },
      id: `gitty.push:${branch}`,
      threadId: THREAD,
      placement: { type: "time", at },
    });
    const harness = yield* makeHarness({
      existing: [command(3, "push main")],
      mapped: [
        mapped("later", "2026-11-21T12:00:00.000Z"),
        mapped("main", "2026-11-20T00:00:00.000Z"),
        mapped("earlier", "2026-11-21T09:00:00.000Z"),
      ],
    });
    harness.cards.set("main", pushCard("main"));
    yield* harness.subscribe;
    assert.deepStrictEqual(placements(yield* Queue.take(harness.snapshots)), [
      { id: "gitty.push:main", placement: atItem(3) },
      {
        id: "gitty.push:earlier",
        placement: { type: "time", at: "2026-11-21T09:00:00.000Z" },
      },
      { id: "gitty.push:later", placement: { type: "time", at: "2026-11-21T12:00:00.000Z" } },
    ]);
  }),
);

const failureReason = <A>(effect: Effect.Effect<A, PluginCardError>) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => (Result.isFailure(result) ? result.failure.reason : "succeeded")),
  );

it.effect("routes actions and assets to the card's source, and refuses unknown ones", () =>
  Effect.gen(function* () {
    const ran: Array<string> = [];
    const harness = yield* makeHarness({
      existing: [command(1, "push main")],
      source: {
        runAction: (card, actionId) => Effect.sync(() => void ran.push(`${card.id}/${actionId}`)),
        readAsset: (_card, assetId) =>
          Effect.succeed({
            mediaType: "image/png",
            bytes: new Uint8Array(assetId === "too-big" ? 4 * 1024 * 1024 + 1 : 4 * 1024 * 1024),
          }),
      },
    });
    harness.cards.set(
      "main",
      pushCard("main", [
        { id: "retry", label: "Retry", type: "command" },
        { id: "say", label: "Say", type: "message", message: "hello" },
      ]),
    );
    const { service } = harness;
    const cardId = "gitty.push:main";

    yield* service.runAction({ threadId: THREAD, cardId, actionId: "retry" });
    assert.deepStrictEqual(ran, ["gitty.push:main/retry"]);
    assert.strictEqual(
      yield* failureReason(service.runAction({ threadId: THREAD, cardId, actionId: "say" })),
      "unknown-action",
    );
    assert.strictEqual(
      yield* failureReason(service.runAction({ threadId: THREAD, cardId, actionId: "missing" })),
      "unknown-action",
    );
    assert.strictEqual(
      (yield* service.readAsset({ threadId: THREAD, cardId, assetId: "fits" })).bytes.byteLength,
      4 * 1024 * 1024,
    );
    assert.strictEqual(
      yield* failureReason(service.readAsset({ threadId: THREAD, cardId, assetId: "too-big" })),
      "unknown-asset",
    );
    assert.deepStrictEqual(ran, ["gitty.push:main/retry"]);
  }),
);

it.effect("refuses actions and assets for a card the thread does not have", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      existing: [command(1, "push main")],
      source: {
        runAction: () => Effect.die("an unknown card must not reach its source"),
        readAsset: () => Effect.die("an unknown card must not reach its source"),
      },
    });
    harness.cards.set("main", pushCard("main", [{ id: "retry", label: "Retry", type: "command" }]));
    harness.cards.set("dropped", null);
    const { service } = harness;
    for (const cardId of ["gitty.push:other", "gitty.push:dropped", "gitty.push"]) {
      assert.strictEqual(
        yield* failureReason(service.runAction({ threadId: THREAD, cardId, actionId: "retry" })),
        "unknown-card",
      );
      assert.strictEqual(
        yield* failureReason(service.readAsset({ threadId: THREAD, cardId, assetId: "shot" })),
        "unknown-card",
      );
    }
  }),
);

const liveDecision = (id: string, threadId: ThreadId | null): PluginLiveDecision => ({
  cardId: `dispatch.decision:/repo#${id}`,
  decisionId: id,
  dir: "/repo",
  kind: "batch-approval",
  question: `Approve ${id}?`,
  initiative: null,
  part: "core",
  threadId,
  needsPerson: false,
  raisedAt: "2026-11-21T10:00:00Z",
  applyAfter: null,
});

/**
 * Serves `state.live` as its live fragment and `mapped` as THREAD's cards. Each run of `changes`
 * is a subscriber, announced on `subscribed`; `signal` reaches every subscriber, and each one
 * reports on `consumed` once it has pulled the signal.
 */
const makeDecisionSource = Effect.fnUntraced(function* (mapped: ReadonlyArray<PluginCard>) {
  const subscribers: Array<Queue.Queue<void>> = [];
  const subscribed = yield* Queue.unbounded<void>();
  const consumed = yield* Queue.unbounded<void>();
  const changes = Stream.unwrap(
    Effect.gen(function* () {
      const feed = yield* Queue.unbounded<void>();
      subscribers.push(feed);
      yield* Queue.offer(subscribed, undefined);
      return Stream.fromQueue(feed).pipe(Stream.tap(() => Queue.offer(consumed, undefined)));
    }),
  );
  const signal = Effect.forEach(subscribers, (feed) => Queue.offer(feed, undefined), {
    discard: true,
  });
  const state: { live: DispatchDecisionLive } = { live: { decisions: [], waitingThreadIds: [] } };
  const source: DispatchDecisionSource = {
    id: "dispatch",
    recognize: () => [],
    resolve: () => Effect.succeed(null),
    cardsForThread: (threadId) => Effect.succeed(threadId === THREAD ? mapped : []),
    changes,
    live: Effect.sync(() => state.live),
    findDecision: () => Effect.succeed(null),
    setProgress: () => Effect.void,
  };
  return { source, signal, subscribed, consumed, state };
});

it.effect("fills the live state's open decisions and waiting chats from the decision source", () =>
  Effect.gen(function* () {
    const other = ThreadId.make("thread-2");
    const decisions = yield* makeDecisionSource([]);
    decisions.state.live = {
      decisions: [
        liveDecision("d-2", other),
        liveDecision("d-1", THREAD),
        liveDecision("d-3", null),
      ],
      waitingThreadIds: [other, THREAD, other],
    };
    const { service } = yield* makeHarness({ decisionSource: decisions.source });
    const states = yield* Queue.unbounded<PluginLiveState>();
    yield* Stream.runForEach(service.subscribeLive, (state) => Queue.offer(states, state)).pipe(
      Effect.forkScoped,
    );

    const first = yield* Queue.take(states);
    // Thread snapshots and the live state each subscribe to the source's changes.
    yield* Queue.take(decisions.subscribed);
    yield* Queue.take(decisions.subscribed);
    assert.deepStrictEqual(
      first.decisions.map((decision) => decision.decisionId),
      ["d-1", "d-2", "d-3"],
    );
    assert.deepStrictEqual(first.waitingThreadIds, [THREAD, other]);
    assert.deepStrictEqual([first.initiatives, first.children], [[], []]);

    decisions.state.live = { decisions: [liveDecision("d-3", null)], waitingThreadIds: [] };
    yield* decisions.signal;
    yield* Queue.take(decisions.consumed);
    yield* Queue.take(decisions.consumed);
    yield* TestClock.adjust(DEBOUNCE);
    const next = yield* Queue.take(states);
    assert.deepStrictEqual(
      next.decisions.map((decision) => decision.decisionId),
      ["d-3"],
    );
    assert.deepStrictEqual(next.waitingThreadIds, []);
  }),
);

it.effect("adds the decision source's mapped cards to the chat and routes answers to it", () =>
  Effect.gen(function* () {
    const mapped: PluginCard = {
      ...pushCard("decision"),
      kind: "gitty.push",
      data: { branch: "decision", batches: [], mergeRequest: null },
      id: "gitty.push:decision",
      threadId: THREAD,
      placement: { type: "time", at: "2026-11-21T09:00:00.000Z" },
    };
    const decisions = yield* makeDecisionSource([mapped]);
    const harness = yield* makeHarness({ decisionSource: decisions.source });
    yield* harness.subscribe;
    assert.deepStrictEqual(
      (yield* Queue.take(harness.snapshots)).cards.map((card) => card.id),
      ["gitty.push:decision"],
    );
    assert.strictEqual(
      yield* failureReason(
        harness.service.answerDecision({
          threadId: THREAD,
          cardId: "dispatch.decision:/repo#d-1",
          optionKey: "go",
        }),
      ),
      "unknown-card",
    );
  }),
);

it.effect("answers no decision when the server runs without the decision source", () =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness();
    assert.strictEqual(
      yield* failureReason(
        service.answerDecision({
          threadId: THREAD,
          cardId: "dispatch.decision:/repo#d-1",
          optionKey: "go",
        }),
      ),
      "unavailable",
    );
  }),
);
