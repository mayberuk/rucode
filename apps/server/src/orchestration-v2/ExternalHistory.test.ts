import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import { ExternalSessionHolds } from "./ExternalSessionHolds.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed: the effect worker is off"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const heldThreadId = ThreadId.make("thread:external-held");
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "external-history" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ).pipe(
    Layer.provide(
      Layer.succeed(ExternalSessionHolds, {
        heldBy: (threadId) =>
          threadId === heldThreadId ? { owner: "terminal", name: "fix-login" } : null,
      }),
    ),
  ),
);

const at = (iso: string) => DateTime.makeUnsafe(iso);

const createThread = (threadId: ThreadId, title = "Imported session") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:external-history"),
      title,
      modelSelection: { instanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const append = (
  threadId: ThreadId,
  id: string,
  fields: Partial<
    Omit<
      Extract<OrchestrationV2ServerCommand, { type: "thread.external-history.append" }>,
      "type" | "threadId"
    >
  > = {},
): OrchestrationV2ServerCommand => ({
  type: "thread.external-history.append",
  commandId: CommandId.make(`append:${threadId}:${id}`),
  threadId,
  sessionId: "session-external",
  leafUuid: null,
  activity: "backfill",
  entries: [],
  notices: [],
  title: null,
  ...fields,
});

const twoEntries = [
  { uuid: "u-1", role: "user", text: "Fix the login bug", createdAt: at("2026-11-20T10:00:00Z") },
  { uuid: "a-1", role: "assistant", text: "Fixed it.", createdAt: at("2026-11-20T10:01:00Z") },
] as const;

const storedEventCount = (commandId: CommandId) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    return (yield* Stream.runCollect(sink.readByCommandId({ commandId }))).length;
  });

const records = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.getThreadRecords(threadId, ["messages", "turnItems", "runs"]);
  });

it.layer(layerTest)("external history", (it) => {
  it.effect("appends entries after existing items, once per transcript uuid", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:external-append");
      yield* createThread(threadId);
      const existingAt = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:external-append:existing"),
            type: "turn-item.updated",
            threadId,
            occurredAt: existingAt,
            payload: {
              id: TurnItemId.make("turn-item:external-append:existing"),
              threadId,
              runId: null,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 7,
              status: "completed",
              title: null,
              startedAt: existingAt,
              completedAt: existingAt,
              updatedAt: existingAt,
              type: "system_notice",
              message: "Imported earlier",
            },
          },
        ],
      });

      const command = append(threadId, "first", { entries: twoEntries });
      yield* orchestrator.dispatch(command);
      yield* orchestrator.dispatch(command);
      yield* orchestrator.dispatch(append(threadId, "reread", { entries: twoEntries }));

      const { messages, turnItems, thread } = yield* records(threadId);
      assert.deepEqual(
        messages.map((message) => [message.id, message.role, message.text]),
        [
          [MessageId.make(`${threadId}:cli:u-1`), "user", "Fix the login bug"],
          [MessageId.make(`${threadId}:cli:a-1`), "assistant", "Fixed it."],
        ],
      );
      const existing = turnItems[0]!.ordinal;
      assert.deepEqual(
        turnItems.map((item) => [item.type, item.ordinal, item.runId]),
        [
          ["system_notice", existing, null],
          ["user_message", existing + 1, null],
          ["assistant_message", existing + 2, null],
        ],
      );
      assert.ok(DateTime.Equivalence(thread.updatedAt, at("2026-11-20T10:01:00Z")));
    }),
  );

  it.effect("adds each notice key once, after the entries it came with", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:external-notice");
      yield* createThread(threadId);
      const notices = [{ key: "earlier", text: "12 earlier messages were not imported" }];
      yield* orchestrator.dispatch(append(threadId, "first", { entries: twoEntries, notices }));
      yield* orchestrator.dispatch(append(threadId, "again", { notices }));
      const { turnItems } = yield* records(threadId);
      assert.deepEqual(
        turnItems.toSorted((a, b) => a.ordinal - b.ordinal).map((item) => item.type),
        ["user_message", "assistant_message", "system_notice"],
      );
    }),
  );

  it.effect("sorts history written after a finished T3 Code run below that run's items", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:external-after-run");
      yield* createThread(threadId);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`send:${threadId}`),
        threadId,
        messageId: MessageId.make(`message:${threadId}`),
        text: "From T3 Code",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const [run] = (yield* records(threadId)).runs;
      yield* sink.write({
        events: [
          {
            id: EventId.make(`event:${threadId}:complete`),
            type: "run.updated",
            threadId,
            runId: run!.id,
            providerInstanceId: run!.providerInstanceId,
            occurredAt: yield* DateTime.now,
            payload: { ...run!, status: "completed" },
          },
        ],
      });

      yield* orchestrator.dispatch(append(threadId, "after-run", { entries: twoEntries }));
      const { turnItems } = yield* records(threadId);
      assert.deepEqual(
        turnItems
          .toSorted((a, b) => a.ordinal - b.ordinal)
          .map((item) => [item.type, item.runId === null ? "cli" : "run"]),
        [
          ["user_message", "run"],
          ["user_message", "cli"],
          ["assistant_message", "cli"],
        ],
      );
    }),
  );

  it.effect("unsettles on live human activity and leaves backfill settled", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const live = ThreadId.make("thread:external-live");
      const backfill = ThreadId.make("thread:external-backfill");
      for (const threadId of [live, backfill]) {
        yield* createThread(threadId);
        yield* orchestrator.dispatch({
          type: "thread.settle",
          commandId: CommandId.make(`settle:${threadId}`),
          threadId,
        });
      }
      yield* orchestrator.dispatch(append(live, "live", { activity: "live", entries: twoEntries }));
      yield* orchestrator.dispatch(append(backfill, "backfill", { entries: twoEntries }));
      assert.isNull((yield* records(live)).thread.settledOverride);
      assert.equal((yield* records(backfill)).thread.settledOverride, "settled");
    }),
  );

  it.effect("lands messages on an archived thread and keeps it archived", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:external-archived");
      yield* createThread(threadId);
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make(`archive:${threadId}`),
        threadId,
      });
      yield* orchestrator.dispatch(
        append(threadId, "archived", { activity: "live", entries: twoEntries }),
      );
      const { messages, thread } = yield* records(threadId);
      assert.lengthOf(messages, 2);
      assert.isNotNull(thread.archivedAt);
    }),
  );

  it.effect("refuses a deleted thread without recording anything", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:external-deleted");
      yield* createThread(threadId);
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make(`delete:${threadId}`),
        threadId,
      });
      const refused = yield* orchestrator
        .dispatch(append(threadId, "deleted", { entries: twoEntries }))
        .pipe(Effect.flip);
      assert.equal(refused._tag, "OrchestratorThreadDeletedError");
      assert.equal(yield* storedEventCount(CommandId.make(`append:${threadId}:deleted`)), 0);
    }),
  );

  it.effect("applies the session title only while the thread still has the expected one", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:external-title");
      yield* createThread(threadId, "Fix the login bug");
      yield* orchestrator.dispatch(
        append(threadId, "named", {
          title: { value: "login-fix", expected: "Fix the login bug" },
        }),
      );
      assert.equal((yield* records(threadId)).thread.title, "login-fix");

      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`rename:${threadId}`),
        threadId,
        title: "My name",
      });
      yield* orchestrator.dispatch(
        append(threadId, "renamed-in-terminal", {
          title: { value: "login-fix-2", expected: "login-fix" },
        }),
      );
      assert.equal((yield* records(threadId)).thread.title, "My name");
    }),
  );

  it.effect("refuses a turn on a held session before anything commits", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const freeThreadId = ThreadId.make("thread:external-free");
      for (const threadId of [heldThreadId, freeThreadId]) yield* createThread(threadId);
      const send = (threadId: ThreadId) =>
        ({
          type: "message.dispatch",
          commandId: CommandId.make(`send:${threadId}`),
          threadId,
          messageId: MessageId.make(`message:${threadId}`),
          text: "Keep going",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        }) as const;

      const refused = yield* orchestrator.dispatch(send(heldThreadId)).pipe(Effect.flip);
      assert.ok(refused._tag === "OrchestratorSessionHeldExternallyError");
      assert.deepEqual(
        [refused.threadId, refused.owner, refused.sessionName],
        [heldThreadId, "terminal", "fix-login"],
      );
      const held = yield* records(heldThreadId);
      assert.lengthOf(held.runs, 0);
      assert.lengthOf(held.messages, 0);
      assert.equal(yield* storedEventCount(CommandId.make(`send:${heldThreadId}`)), 0);

      yield* orchestrator.dispatch(send(freeThreadId));
      assert.lengthOf((yield* records(freeThreadId)).runs, 1);
    }),
  );

  it.effect("waits out a T3 Code run instead of interleaving with it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:external-busy");
      yield* createThread(threadId);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`send:${threadId}`),
        threadId,
        messageId: MessageId.make(`message:${threadId}`),
        text: "Start",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const refused = yield* orchestrator
        .dispatch(append(threadId, "busy", { entries: twoEntries }))
        .pipe(Effect.flip);
      assert.equal(refused._tag, "OrchestratorThreadRunActiveError");
      assert.lengthOf((yield* records(threadId)).messages, 1);
    }),
  );
});
