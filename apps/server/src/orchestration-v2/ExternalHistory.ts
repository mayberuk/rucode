import {
  EventId,
  MessageId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2TurnItem,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

type ExternalHistoryAppend = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: "thread.external-history.append" }
>;
export type ExternalHistoryEntry = ExternalHistoryAppend["entries"][number];
export type ExternalHistoryNotice = ExternalHistoryAppend["notices"][number];

const firstByKey = <A>(items: ReadonlyArray<A>, key: (item: A) => string): ReadonlyArray<A> => {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(key(item))) return false;
    seen.add(key(item));
    return true;
  });
};

/** The first entry per uuid and notice per key, in transcript order. */
export function distinctExternalHistory(command: ExternalHistoryAppend): {
  readonly entries: ReadonlyArray<ExternalHistoryEntry>;
  readonly notices: ReadonlyArray<ExternalHistoryNotice>;
} {
  return {
    entries: firstByKey(command.entries, (entry) => entry.uuid),
    notices: firstByKey(command.notices, (notice) => notice.key),
  };
}

const EXTERNAL_HISTORY_ITEM_PREFIX = "cli-sync:";

export const externalMessageId = (threadId: ThreadId, uuid: string) =>
  MessageId.make(`${threadId}:cli:${uuid}`);

export const externalEntryItemId = (threadId: ThreadId, uuid: string) =>
  TurnItemId.make(`${EXTERNAL_HISTORY_ITEM_PREFIX}turn-item:${threadId}:${uuid}`);

export const externalNoticeItemId = (threadId: ThreadId, key: string) =>
  TurnItemId.make(`${EXTERNAL_HISTORY_ITEM_PREFIX}notice:${threadId}:${key}`);

/**
 * Synced items carry no run but are positioned in the range of the run named on their event,
 * which the event sink allocates at commit. Other run-less items keep the range ahead of every run.
 */
export const isExternalHistoryItemId = (id: TurnItemId): boolean =>
  id.startsWith(EXTERNAL_HISTORY_ITEM_PREFIX);

/** The latest run that has started; history written after it sorts after its items. */
export function externalHistoryRangeRun(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal" | "status">>,
): RunId | undefined {
  return runs.reduce<Pick<OrchestrationV2Run, "id" | "ordinal"> | undefined>(
    (latest, run) =>
      run.status === "queued" || (latest !== undefined && latest.ordinal >= run.ordinal)
        ? latest
        : run,
    undefined,
  )?.id;
}

const runlessItemFields = (threadId: ThreadId, at: DateTime.Utc) => ({
  threadId,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  // The event sink assigns the position when it commits.
  ordinal: 0,
  status: "completed" as const,
  title: null,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
});

export function externalEntryEvents(input: {
  readonly threadId: ThreadId;
  readonly entry: ExternalHistoryEntry;
  readonly rangeRunId: RunId | undefined;
  readonly occurredAt: DateTime.Utc;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const { threadId, entry, rangeRunId, occurredAt } = input;
  const itemId = externalEntryItemId(threadId, entry.uuid);
  const common = { ...runlessItemFields(threadId, entry.createdAt), id: itemId };
  const itemEvent = (payload: OrchestrationV2TurnItem): OrchestrationV2DomainEvent => ({
    id: EventId.make(itemId),
    type: "turn-item.updated",
    threadId,
    ...(rangeRunId === undefined ? {} : { runId: rangeRunId }),
    occurredAt,
    payload,
  });
  if (entry.role === "reasoning") {
    return [itemEvent({ ...common, type: "reasoning", text: entry.text, streaming: false })];
  }
  const messageId = externalMessageId(threadId, entry.uuid);
  const message: OrchestrationV2ConversationMessage = {
    createdBy: entry.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId,
    runId: null,
    nodeId: null,
    role: entry.role,
    text: entry.text,
    attachments: [],
    streaming: false,
    createdAt: entry.createdAt,
    updatedAt: entry.createdAt,
  };
  return [
    {
      id: EventId.make(`cli-sync:message:${threadId}:${entry.uuid}`),
      type: "message.updated",
      threadId,
      occurredAt,
      payload: message,
    },
    itemEvent(
      entry.role === "user"
        ? {
            ...common,
            createdBy: "user",
            creationSource: "server",
            type: "user_message",
            messageId,
            inputIntent: "turn_start",
            text: entry.text,
            attachments: [],
          }
        : { ...common, type: "assistant_message", messageId, text: entry.text, streaming: false },
    ),
  ];
}

export function externalNoticeEvent(input: {
  readonly threadId: ThreadId;
  readonly notice: ExternalHistoryNotice;
  readonly rangeRunId: RunId | undefined;
  readonly occurredAt: DateTime.Utc;
}): OrchestrationV2DomainEvent {
  const id = externalNoticeItemId(input.threadId, input.notice.key);
  return {
    id: EventId.make(id),
    type: "turn-item.updated",
    threadId: input.threadId,
    ...(input.rangeRunId === undefined ? {} : { runId: input.rangeRunId }),
    occurredAt: input.occurredAt,
    payload: {
      ...runlessItemFields(input.threadId, input.occurredAt),
      id,
      type: "system_notice",
      message: input.notice.text,
    },
  };
}

/** What new work does to a thread with a settled override; undefined when it has none. */
export function unsettledByNewWork(
  thread: OrchestrationV2AppThread,
  now: DateTime.Utc,
): OrchestrationV2AppThread | undefined {
  if (thread.settledOverride === null) return undefined;
  return {
    ...thread,
    settledOverride: null,
    settledAt: null,
    unsettledAt: thread.settledOverride === "active" ? (thread.unsettledAt ?? null) : now,
    updatedAt: now,
  };
}

/** The session's title while the user has not renamed the thread, and the newest entry's time. */
export function externalHistoryThreadUpdate(
  thread: OrchestrationV2AppThread,
  input: {
    readonly title: ExternalHistoryAppend["title"];
    readonly newestEntryAt: DateTime.Utc | undefined;
  },
): OrchestrationV2AppThread | undefined {
  const title =
    input.title !== null &&
    thread.title === input.title.expected &&
    thread.title !== input.title.value
      ? input.title.value
      : undefined;
  const updatedAt =
    input.newestEntryAt !== undefined &&
    DateTime.isGreaterThan(input.newestEntryAt, thread.updatedAt)
      ? input.newestEntryAt
      : undefined;
  if (title === undefined && updatedAt === undefined) return undefined;
  return {
    ...thread,
    ...(title === undefined ? {} : { title }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}
