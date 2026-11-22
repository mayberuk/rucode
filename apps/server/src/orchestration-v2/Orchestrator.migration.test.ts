import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { importedThreadRows } from "../project/AgentSessionImporter.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { shouldPrepareLegacyImportHandoff } from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

it("reissues imported context until a V2 run completes", () => {
  assert.isTrue(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 2,
      hasNativeHistory: true,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: true,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: undefined,
      hasCompletedRun: false,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 0,
    }),
  );
});

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CLAUDE_INSTANCE = ProviderInstanceId.make("claudeAgent");
const claudeAdapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId: CLAUDE_INSTANCE,
  driver: CLAUDE,
  getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("The effect worker is off, so no provider session opens"),
};

/** An imported thread holding one run-less message, then the handoffs its first turn prepared. */
const firstTurnOfImportedThread = (input: { readonly nativeSession: boolean }) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("imported-thread");
    const { appThread, providerThread } = importedThreadRows({
      threadId,
      projectId: ProjectId.make("imported-project"),
      title: "Imported session",
      providerInstanceId: CLAUDE_INSTANCE,
      driver: CLAUDE,
      model: "claude-haiku-4-5",
      runtimeMode: "full-access",
      worktree: null,
      providerThreadId: ProviderThreadId.make("imported-provider-thread"),
      nativeThreadId: "0b7c2a1e-5f3d-4c1a-9e8b-1d2f3a4b5c6d",
      createdAt: now,
      updatedAt: now,
      settled: false,
    });
    const itemId = TurnItemId.make("imported-item");
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("imported-thread-created"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: input.nativeSession ? appThread : { ...appThread, activeProviderThreadId: null },
        },
        {
          id: EventId.make("imported-item"),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: itemId,
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "user_message",
            createdBy: "user",
            creationSource: "web",
            inputIntent: "turn_start",
            messageId: MessageId.make("imported-message"),
            text: "IMPORTED_MARKER",
            attachments: [],
          },
        },
        ...(input.nativeSession
          ? [
              {
                id: EventId.make("imported-provider-thread"),
                type: "provider-thread.updated" as const,
                threadId,
                driver: CLAUDE,
                providerInstanceId: CLAUDE_INSTANCE,
                occurredAt: now,
                payload: providerThread,
              },
            ]
          : []),
      ],
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("imported-first-turn"),
      threadId,
      messageId: MessageId.make("imported-first-turn"),
      text: "Carry on",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return { handoffs: projection.contextHandoffs, run: projection.runs[0] };
  }).pipe(
    Effect.provide(
      ProviderReplayHarness.layerWithRegistry(
        { name: "imported-first-turn" },
        ProviderAdapterRegistry.layerFromAdapters([claudeAdapter]),
        { runEffectWorker: false },
      ),
    ),
  );

it.effect("a first turn that resumes the native session sends no imported history", () =>
  Effect.gen(function* () {
    const { handoffs, run } = yield* firstTurnOfImportedThread({ nativeSession: true });
    assert.deepEqual(handoffs, []);
    assert.isNull(run?.contextHandoffId ?? null);
  }),
);

it.effect("a first turn with no native session carries the imported history", () =>
  Effect.gen(function* () {
    const { handoffs, run } = yield* firstTurnOfImportedThread({ nativeSession: false });
    assert.lengthOf(handoffs, 1);
    assert.equal(run?.contextHandoffId, handoffs[0]?.id);
    assert.include(handoffs[0]?.summaryText, "IMPORTED_MARKER");
  }),
);
