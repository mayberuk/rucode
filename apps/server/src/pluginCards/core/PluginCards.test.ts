import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type PluginCard,
  type PluginCardAction,
  type PluginCardError,
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

import * as ProcessRunner from "../../processRunner.ts";
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
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        threadCommands,
        Layer.mock(PluginThreadIndex.PluginThreadIndex)({}),
        Layer.mock(ProcessRunner.ProcessRunner)({}),
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
