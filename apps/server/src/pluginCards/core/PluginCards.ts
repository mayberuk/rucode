import {
  type PluginCard,
  type PluginCardActionInput,
  type PluginCardAsset,
  type PluginCardAssetInput,
  PluginCardError,
  type PluginDecisionAnswerInput,
  type PluginDecisionAnswerResult,
  type PluginLiveState,
  type PluginThreadCards,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  type DispatchDecisionLive,
  type DispatchDecisionSource,
  makeDispatchDecisionSource,
} from "../dispatch/decisionSource.ts";
import { pluginLiveSources } from "../live/index.ts";
import { pluginCardSources } from "../sources/index.ts";
import type {
  PluginCardRef,
  PluginCardSource,
  PluginCardSourceFactory,
  PluginCardSourceServices,
  PluginLiveSource,
  PluginLiveSourceFactory,
} from "./PluginCardSource.ts";
import * as DecisionAnswerFlow from "./decisionAnswerFlow.ts";
import * as PluginThreadIndex from "./PluginThreadIndex.ts";
import * as ThreadCommands from "./threadCommands.ts";

/** Card images travel base64-encoded in one RPC response, so they stay small. */
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const REFRESH_DEBOUNCE = Duration.millis(150);
const RESOLVE_CONCURRENCY = 8;

const builtInLiveSources: ReadonlyArray<PluginLiveSourceFactory> = [];
const noDecisions: DispatchDecisionLive = { decisions: [], waitingThreadIds: [] };

export class PluginCards extends Context.Service<
  PluginCards,
  {
    readonly subscribeThread: (
      threadId: ThreadId,
    ) => Stream.Stream<PluginThreadCards, PluginCardError>;
    readonly subscribeLive: Stream.Stream<PluginLiveState, PluginCardError>;
    readonly answerDecision: (
      input: PluginDecisionAnswerInput,
    ) => Effect.Effect<PluginDecisionAnswerResult, PluginCardError>;
    readonly runAction: (input: PluginCardActionInput) => Effect.Effect<void, PluginCardError>;
    readonly readAsset: (
      input: PluginCardAssetInput,
    ) => Effect.Effect<PluginCardAsset, PluginCardError>;
  }
>()("t3/pluginCards/core/PluginCards") {}

const unavailableError = new PluginCardError({ reason: "unavailable" });

/** For a server built without the service. */
export const unavailable: PluginCards["Service"] = {
  subscribeThread: () => Stream.fail(unavailableError),
  subscribeLive: Stream.fail(unavailableError),
  answerDecision: () => Effect.fail(unavailableError),
  runAction: () => Effect.fail(unavailableError),
  readAsset: () => Effect.fail(unavailableError),
};

interface Anchor {
  readonly source: PluginCardSource;
  readonly ref: PluginCardRef;
  readonly turnItemId: TurnItemId;
  readonly ordinal: number;
}

interface PlacedCard {
  readonly card: PluginCard;
  readonly source: PluginCardSource;
  /** Turn item ordinal, or null for a card placed by time. */
  readonly ordinal: number | null;
}

const cardIdOf = (ref: PluginCardRef) => `${ref.kind}:${ref.key}`;

const compareStrings = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

const byId =
  <A>(id: (value: A) => string) =>
  (left: A, right: A) =>
    compareStrings(id(left), id(right));

const placementAt = (card: PluginCard) => (card.placement.type === "time" ? card.placement.at : "");

/** Anchored cards in turn item order, then time-placed cards in time order. */
const comparePlaced = (left: PlacedCard, right: PlacedCard): number => {
  if (left.ordinal !== right.ordinal) {
    if (left.ordinal === null) return 1;
    if (right.ordinal === null) return -1;
    return left.ordinal - right.ordinal;
  }
  return (
    compareStrings(placementAt(left.card), placementAt(right.card)) ||
    compareStrings(left.card.id, right.card.id)
  );
};

export const make = Effect.fn("PluginCards.make")(function* (options?: {
  readonly cardSources?: ReadonlyArray<PluginCardSourceFactory>;
  readonly liveSources?: ReadonlyArray<PluginLiveSourceFactory>;
  /** Null leaves dispatch decisions out, and answering them unavailable. */
  readonly decisionSource?: Effect.Effect<
    DispatchDecisionSource,
    never,
    PluginCardSourceServices | Scope.Scope
  > | null;
}) {
  const threadCommands = yield* ThreadCommands.ThreadCommands;
  const services = yield* Effect.context<PluginCardSourceServices>();
  const decisionSource =
    options?.decisionSource === null
      ? null
      : yield* (
          options?.decisionSource ?? makeDispatchDecisionSource({ commandsOf: threadCommands.list })
        );
  const cardSources: ReadonlyArray<PluginCardSource> = [
    ...(decisionSource === null ? [] : [decisionSource]),
    ...(yield* Effect.all(options?.cardSources ?? pluginCardSources)),
  ];
  const liveSources: ReadonlyArray<PluginLiveSource> = yield* Effect.all(
    options?.liveSources ?? [...builtInLiveSources, ...pluginLiveSources],
  );

  // A source must not throw, but one that does must not take every chat's cards with it.
  const guard = <A>(
    effect: Effect.Effect<A, never, PluginCardSourceServices>,
    fallback: A,
    source: string,
  ) =>
    effect.pipe(
      Effect.provideContext(services),
      Effect.catchDefect((cause) =>
        Effect.logWarning("plugin card source failed", { source, cause }).pipe(Effect.as(fallback)),
      ),
    );

  const sourceChanges = yield* PubSub.unbounded<ThreadId | null>();
  for (const source of cardSources) {
    if (source.changes === undefined) continue;
    yield* source.changes.pipe(
      Stream.runForEach(() => PubSub.publish(sourceChanges, null)),
      (run) => guard(run, undefined, source.id),
      Effect.forkScoped,
    );
  }

  if (decisionSource !== null) {
    yield* decisionSource.progressChanges.pipe(
      Stream.runForEach((threadId) => PubSub.publish(sourceChanges, threadId)),
      Effect.forkScoped({ startImmediately: true }),
    );
  }

  /**
   * Anchors each recognised card at its earliest command, owned when any command owns it. True when
   * an anchor was added, moved or became owned.
   */
  const recognize = Effect.fnUntraced(function* (
    recognized: Map<string, Anchor>,
    command: ThreadCommands.ThreadCommandItem,
  ) {
    let changed = false;
    for (const source of cardSources) {
      const refs = yield* Effect.try({
        try: () => source.recognize(command),
        catch: (cause) => new PluginCardError({ reason: "source-failed", cause }),
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("plugin card source failed", {
            source: source.id,
            cause: error.cause,
          }).pipe(Effect.as<ReadonlyArray<PluginCardRef>>([])),
        ),
      );
      for (const ref of refs) {
        const id = cardIdOf(ref);
        const existing = recognized.get(id);
        const owns = ref.owns === true || existing?.ref.owns === true;
        if (existing !== undefined && existing.ordinal <= command.ordinal) {
          if (owns === (existing.ref.owns === true)) continue;
          recognized.set(id, { ...existing, ref: { ...existing.ref, owns } });
        } else {
          recognized.set(id, {
            source,
            ref: owns ? { ...ref, owns } : ref,
            turnItemId: command.turnItemId,
            ordinal: command.ordinal,
          });
        }
        changed = true;
      }
    }
    return changed;
  });

  const placeCards = Effect.fnUntraced(function* (
    threadId: ThreadId,
    recognized: ReadonlyMap<string, Anchor>,
  ) {
    const mapped = yield* Effect.forEach(
      cardSources,
      (source) =>
        source.cardsForThread === undefined
          ? Effect.succeed([])
          : guard(source.cardsForThread(threadId), [], source.id).pipe(
              Effect.map((cards) => cards.map((card) => ({ card, source }))),
            ),
      { concurrency: RESOLVE_CONCURRENCY },
    );

    const mappedDecisions = new Set(
      mapped.flatMap((cards) =>
        cards.flatMap(({ card, source }) => (source === decisionSource ? [card.id] : [])),
      ),
    );

    const anchored = yield* Effect.forEach(
      [...recognized].filter(
        ([id, anchor]) => anchor.source !== decisionSource || !mappedDecisions.has(id),
      ),
      ([id, anchor]) =>
        guard(anchor.source.resolve(anchor.ref, threadId), null, anchor.source.id).pipe(
          Effect.map((resolved): PlacedCard | null =>
            resolved === null
              ? null
              : {
                  card: {
                    ...resolved,
                    id,
                    threadId,
                    placement: { type: "turnItem", turnItemId: anchor.turnItemId },
                  },
                  source: anchor.source,
                  ordinal: anchor.ordinal,
                },
          ),
        ),
      { concurrency: RESOLVE_CONCURRENCY },
    );
    const placed = new Map<string, PlacedCard>();
    for (const entry of anchored) {
      if (entry !== null) placed.set(entry.card.id, entry);
    }
    for (const { card, source } of mapped.flat()) {
      if (placed.has(card.id)) continue;
      const anchor = recognized.get(card.id);
      placed.set(
        card.id,
        anchor === undefined
          ? { card: { ...card, threadId }, source, ordinal: null }
          : {
              card: {
                ...card,
                threadId,
                placement: { type: "turnItem", turnItemId: anchor.turnItemId },
              },
              source,
              ordinal: anchor.ordinal,
            },
      );
    }
    return [...placed.values()].toSorted(comparePlaced);
  });

  const currentCards = Effect.fnUntraced(function* (threadId: ThreadId) {
    const recognized = new Map<string, Anchor>();
    for (const command of yield* threadCommands.list(threadId)) {
      yield* recognize(recognized, command);
    }
    return yield* placeCards(threadId, recognized);
  });

  const subscribeThread = (threadId: ThreadId): Stream.Stream<PluginThreadCards, PluginCardError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const signals = yield* PubSub.subscribe(sourceChanges);
        const { existing, completed } = yield* threadCommands.follow(threadId);
        const recognized = new Map<string, Anchor>();
        for (const command of existing) yield* recognize(recognized, command);
        const snapshot = placeCards(threadId, recognized).pipe(
          Effect.map((placed) => ({ threadId, cards: placed.map((entry) => entry.card) })),
        );
        const recognizedChanges = completed.pipe(
          Stream.filterEffect((command) => recognize(recognized, command)),
          Stream.as(undefined),
        );
        const sourceRefreshes = Stream.fromSubscription(signals).pipe(
          Stream.filter((changedThread) => changedThread === null || changedThread === threadId),
          Stream.as(undefined),
        );
        const refreshes = Stream.merge(recognizedChanges, sourceRefreshes).pipe(
          Stream.debounce(REFRESH_DEBOUNCE),
          Stream.mapEffect(() => snapshot),
        );
        return Stream.concat(Stream.fromEffect(snapshot), refreshes).pipe(
          Stream.changesWith((left, right) => Equal.equals(left, right)),
        );
      }).pipe(Effect.withSpan("PluginCards.subscribeThread", { attributes: { threadId } })),
    );

  const findCard = Effect.fn("PluginCards.findCard")(function* (
    threadId: ThreadId,
    cardId: string,
  ) {
    const placed = (yield* currentCards(threadId)).find((entry) => entry.card.id === cardId);
    if (placed === undefined) return yield* new PluginCardError({ reason: "unknown-card" });
    return placed;
  });

  const runAction = Effect.fn("PluginCards.runAction")(function* (input: PluginCardActionInput) {
    const { card, source } = yield* findCard(input.threadId, input.cardId);
    const action = card.actions.find((candidate) => candidate.id === input.actionId);
    if (action?.type !== "command" || source.runAction === undefined) {
      return yield* new PluginCardError({ reason: "unknown-action" });
    }
    yield* source.runAction(card, input.actionId).pipe(Effect.provideContext(services));
  });

  const readAsset = Effect.fn("PluginCards.readAsset")(function* (input: PluginCardAssetInput) {
    const { card, source } = yield* findCard(input.threadId, input.cardId);
    if (source.readAsset === undefined) {
      return yield* new PluginCardError({ reason: "unknown-asset" });
    }
    const asset = yield* source
      .readAsset(card, input.assetId)
      .pipe(Effect.provideContext(services));
    if (asset.bytes.byteLength > MAX_ASSET_BYTES) {
      return yield* new PluginCardError({
        reason: "unknown-asset",
        detail: "It is larger than 4 MiB.",
      });
    }
    return asset;
  });

  const live = yield* SubscriptionRef.make<PluginLiveState | null>(null);
  const liveRefreshPermit = yield* Semaphore.make(1);
  const refreshLive = liveRefreshPermit
    .withPermits(1)(
      Effect.gen(function* () {
        const [fragments, decisionFragment] = yield* Effect.all(
          [
            Effect.forEach(
              liveSources,
              (source) => guard(source.snapshot, { initiatives: [], children: [] }, source.id),
              { concurrency: "unbounded" },
            ),
            decisionSource === null
              ? Effect.succeed(noDecisions)
              : guard(decisionSource.live, noDecisions, decisionSource.id),
          ],
          { concurrency: "unbounded" },
        );
        const content: Omit<PluginLiveState, "asOf"> = {
          initiatives: fragments
            .flatMap((fragment) => fragment.initiatives)
            .toSorted(byId((initiative) => initiative.slug)),
          children: fragments
            .flatMap((fragment) => fragment.children)
            .toSorted(byId((child) => child.id)),
          decisions: decisionFragment.decisions.toSorted(byId((decision) => decision.cardId)),
          waitingThreadIds: [...new Set(decisionFragment.waitingThreadIds)].toSorted(),
        };
        const current = yield* SubscriptionRef.get(live);
        if (current !== null) {
          const { asOf: _asOf, ...previous } = current;
          if (Equal.equals(previous, content)) return;
        }
        const asOf = DateTime.formatIso(yield* DateTime.now);
        yield* SubscriptionRef.set(live, { asOf, ...content });
      }),
    )
    .pipe(Effect.withSpan("PluginCards.refreshLive"));

  yield* Stream.mergeAll(
    [
      ...liveSources.map((source) => source.changes),
      ...(decisionSource === null ? [] : [decisionSource.changes]),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Stream.debounce(REFRESH_DEBOUNCE),
    Stream.runForEach(() => refreshLive),
    (run) => guard(Effect.andThen(refreshLive, run), undefined, "live"),
    Effect.forkScoped,
  );

  const subscribeLive: Stream.Stream<PluginLiveState, PluginCardError> = SubscriptionRef.changes(
    live,
  ).pipe(Stream.filter((state): state is PluginLiveState => state !== null));

  const ownsDecision = Effect.fn("PluginCards.ownsDecision")(function* (
    threadId: ThreadId,
    cardId: string,
  ) {
    const card = (yield* currentCards(threadId)).find((entry) => entry.card.id === cardId)?.card;
    return card?.kind === "dispatch.decision" && card.data.answerable === "yes";
  });

  const answerFlow =
    decisionSource === null ? null : yield* DecisionAnswerFlow.make(decisionSource, ownsDecision);

  return PluginCards.of({
    subscribeThread,
    subscribeLive,
    answerDecision: answerFlow === null ? unavailable.answerDecision : answerFlow.answer,
    runAction,
    readAsset,
  });
});

export const layer = Layer.effect(PluginCards, make()).pipe(
  Layer.provide(Layer.mergeAll(PluginThreadIndex.layer, ThreadCommands.layer)),
);
