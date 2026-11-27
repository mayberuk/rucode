import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import {
  type CodexExecCommand,
  codexRunThreadId,
  parseCodexExecCommand,
} from "@t3tools/shared/codexExecRun";
import { type DrainableWorker, makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  makeSubagentChildThread,
  subagentThreadTitle,
} from "@t3tools/provider-core/server/subagentProjection";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TxRef from "effect/TxRef";

import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import {
  type CodexRunRequest,
  matchRollout,
  type RolloutCandidate,
  rolloutDayDirs,
} from "./rolloutMatch.ts";
import { readRollout, readRolloutHead, type RolloutItem } from "./rolloutReader.ts";
import { type CodexRun, readSyncState, type SyncState, writeSyncState } from "./syncState.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CODEX_INSTANCE = defaultInstanceIdForDriver(CODEX_DRIVER);
const RETRY_INTERVAL = Duration.seconds(2);
// Codex writes `session_meta` within this window of the command starting (see `matchRollout`).
const SEARCH_WINDOW_MS = 120_000;
const EARLIEST_MTIME_MS = 30_000;
// `session_meta` carries the base instructions, which run to tens of KB.
const HEAD_BYTES = 1024 * 1024;
const PROMPT_FILE_MAX_BYTES = 1024 * 1024;
const IDLE_EXPIRY_MS = 30 * 60 * 1000;
const ROLLOUT_FILE = /^rollout-.*\.jsonl$/;
const RUN_PREFIX = "codex-run:";

export class CodexSessionSync extends Context.Service<
  CodexSessionSync,
  {
    /** Resolves once every committed domain event and every job it queued has been handled. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/codexSessions/CodexSessionSync") {}

type Job =
  | { readonly _tag: "Match"; readonly childThreadId: ThreadId }
  | { readonly _tag: "Tail"; readonly childThreadId: ThreadId }
  | { readonly _tag: "Expire"; readonly childThreadId: ThreadId };

interface Search {
  readonly parentThreadId: ThreadId;
  readonly parentNodeId: NodeId | null;
  readonly command: string;
  readonly parsed: CodexExecCommand;
  readonly startedAtMs: number;
  resolved?: { readonly parent: OrchestrationV2AppThread; readonly request: CodexRunRequest };
}

interface FoundRollout {
  readonly candidate: RolloutCandidate;
  readonly head: Uint8Array;
  readonly inode: number;
}

const rootNodeIdOf = (childThreadId: ThreadId) => NodeId.make(`${childThreadId}:root`);

const toDateTime = (value: string | null, fallback: DateTime.Utc) => {
  if (value === null) return fallback;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.toUtc(parsed.value) : fallback;
};

const inodeOf = (info: FileSystem.File.Info) =>
  Option.match(info.ino, { onNone: () => -1, onSome: Number });

function itemEvents(input: {
  readonly childThreadId: ThreadId;
  readonly inode: number;
  readonly item: RolloutItem;
  readonly now: DateTime.Utc;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const { childThreadId, item } = input;
  const at = toDateTime(item.at, input.now);
  const nodeId = rootNodeIdOf(childThreadId);
  const id = TurnItemId.make(`${RUN_PREFIX}${childThreadId}:${item.id}`);
  const eventId = `codex-sync:${childThreadId}:${input.inode}:${item.offset}`;
  const base = {
    id,
    threadId: childThreadId,
    runId: null,
    nodeId,
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
  };
  const scope = { threadId: childThreadId, nodeId, providerInstanceId: CODEX_INSTANCE };
  const itemEvent = (payload: OrchestrationV2TurnItem): OrchestrationV2DomainEvent => ({
    ...scope,
    id: EventId.make(eventId),
    type: "turn-item.updated",
    occurredAt: at,
    payload,
  });
  switch (item.kind) {
    case "user":
    case "assistant": {
      const messageId = MessageId.make(`${RUN_PREFIX}${childThreadId}:${item.id}`);
      const message: OrchestrationV2DomainEvent = {
        ...scope,
        id: EventId.make(`${eventId}:message`),
        type: "message.updated",
        occurredAt: at,
        payload: {
          createdBy: "agent",
          creationSource: "provider",
          id: messageId,
          threadId: childThreadId,
          runId: null,
          nodeId,
          role: item.kind,
          text: item.text,
          attachments: [],
          streaming: false,
          createdAt: at,
          updatedAt: at,
        },
      };
      return [
        message,
        itemEvent(
          item.kind === "user"
            ? {
                ...base,
                createdBy: "agent",
                creationSource: "provider",
                type: "user_message",
                messageId,
                inputIntent: "turn_start",
                text: item.text,
                attachments: [],
              }
            : { ...base, type: "assistant_message", messageId, text: item.text, streaming: false },
        ),
      ];
    }
    case "reasoning":
      return [itemEvent({ ...base, type: "reasoning", text: item.text, streaming: false })];
    case "command":
      return [
        itemEvent({
          ...base,
          status: item.status,
          type: "command_execution",
          input: item.command,
          output: item.output,
          ...(item.exitCode === null ? {} : { exitCode: item.exitCode }),
          ...(item.status === "failed" ? { outputIndicatesFailure: true } : {}),
        }),
      ];
    case "file_change": {
      const paths = item.paths.filter((path) => path.trim() !== "");
      const [fileName] = paths;
      if (fileName === undefined) return [];
      // The rollout names the changed paths but not whether each was added, deleted or edited.
      return [
        itemEvent({
          ...base,
          type: "file_change",
          fileName,
          changes: paths.map((path) => ({ operation: "update", path })),
        }),
      ];
    }
  }
}

const make = Effect.gen(function* () {
  const eventSink = yield* EventSink.EventSinkV2;
  const projection = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDir = yield* HostProcess.HomeDirectory;
  const environment = yield* HostProcess.Environment;
  const serviceScope = yield* Effect.scope;

  const expandHome = (value: string) =>
    value === "~" ? homeDir : value.startsWith("~/") ? path.join(homeDir, value.slice(2)) : value;
  // A `codex exec` run from a shell inherits the user's environment, not the provider settings.
  const configuredHome = environment.CODEX_HOME;
  const codexHome =
    configuredHome === undefined || configuredHome === ""
      ? path.join(homeDir, ".codex")
      : path.resolve(expandHome(configuredHome));
  const sessionsDir = path.join(codexHome, "sessions");

  let state: SyncState = yield* readSyncState(config.stateDir);
  let stateDirty = false;
  const searches = new Map<ThreadId, Search>();
  const ignored = new Set<ThreadId>();
  const watches = new Map<ThreadId, Scope.Closeable>();
  const grewAt = new Map<ThreadId, number>();
  // Runs whose items this process has not yet checked against the projection; see `tail`.
  const unverified = new Set<ThreadId>();
  const seenSequence = yield* TxRef.make(0);

  const saveState = Effect.suspend(() => {
    if (!stateDirty) return Effect.void;
    stateDirty = false;
    return writeSyncState(config.stateDir, state).pipe(
      Effect.catchTags({
        CodexSessionSyncStateWriteError: (cause) =>
          Effect.logWarning("codex session sync could not save its cursor", { cause }),
      }),
    );
  });
  const updateRun = (childThreadId: ThreadId, run: CodexRun) => {
    state = { runs: { ...state.runs, [childThreadId]: run } };
    stateDirty = true;
  };

  const logFailure = (job: Job) => (cause: Cause.Cause<unknown>) => {
    if (job._tag === "Match") searches.delete(job.childThreadId);
    return Effect.logWarning(`codex session sync could not ${job._tag.toLowerCase()} a run`, {
      childThreadId: job.childThreadId,
      cause,
    });
  };
  const worker: DrainableWorker<Job> = yield* makeDrainableWorker((job: Job) => {
    switch (job._tag) {
      case "Match":
        return match(job.childThreadId).pipe(Effect.catchCause(logFailure(job)));
      case "Tail":
        return tail(job.childThreadId).pipe(Effect.catchCause(logFailure(job)));
      case "Expire":
        return expire(job.childThreadId).pipe(Effect.catchCause(logFailure(job)));
    }
  });

  const schedule = (delayMs: number, job: Job) =>
    Effect.sleep(Duration.millis(delayMs)).pipe(
      Effect.andThen(worker.enqueue(job)),
      Effect.forkIn(serviceScope),
      Effect.asVoid,
    );

  /** Bytes `[start, end)`, or fewer when the file shrank meanwhile. */
  const readRange = Effect.fnUntraced(function* (filePath: string, start: number, end: number) {
    const file = yield* fs.open(filePath, { flag: "r" });
    const bytes = new Uint8Array(end - start);
    let filled = 0;
    while (filled < bytes.length) {
      const read = yield* file.read(bytes.subarray(filled), {
        position: BigInt(start + filled),
      });
      if (read === 0) break;
      filled += read;
    }
    return bytes.subarray(0, filled);
  }, Effect.scoped);

  const stopTailing = Effect.fn("CodexSessionSync.stopTailing")(function* (
    childThreadId: ThreadId,
  ) {
    const scope = watches.get(childThreadId);
    grewAt.delete(childThreadId);
    if (scope === undefined) return;
    watches.delete(childThreadId);
    yield* Scope.close(scope, Exit.void);
  });

  const markDone = Effect.fn("CodexSessionSync.markDone")(function* (childThreadId: ThreadId) {
    const run = state.runs[childThreadId];
    if (run !== undefined) updateRun(childThreadId, { ...run, state: "done" });
    yield* stopTailing(childThreadId);
    yield* saveState;
  });

  const startTailing = Effect.fn("CodexSessionSync.startTailing")(function* (
    childThreadId: ThreadId,
  ) {
    const run = state.runs[childThreadId];
    if (run?.state !== "tailing" || run.filePath === null || watches.has(childThreadId)) return;
    const scope = yield* Scope.make();
    watches.set(childThreadId, scope);
    grewAt.set(childThreadId, yield* Clock.currentTimeMillis);
    yield* fs.watch(run.filePath).pipe(
      Stream.runForEach(() => worker.enqueue({ _tag: "Tail", childThreadId })),
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(scope),
    );
    yield* worker.enqueue({ _tag: "Tail", childThreadId });
    yield* schedule(IDLE_EXPIRY_MS, { _tag: "Expire", childThreadId });
  });

  /** Writes the child's root node with a terminal status, unless it already has one. */
  const endRootNode = Effect.fn("CodexSessionSync.endRootNode")(function* (
    childThreadId: ThreadId,
    status: "completed" | "interrupted",
    completedAt: DateTime.Utc,
  ) {
    const { nodes } = yield* projection.getThreadRecords(childThreadId, ["nodes"]);
    const root = nodes.find((node) => node.id === rootNodeIdOf(childThreadId));
    if (root === undefined || root.status !== "running") return [];
    const event: OrchestrationV2DomainEvent = {
      id: EventId.make(`codex-sync:${childThreadId}:root:${status}`),
      type: "node.updated",
      threadId: childThreadId,
      nodeId: root.id,
      providerInstanceId: CODEX_INSTANCE,
      occurredAt: completedAt,
      payload: { ...root, status, completedAt },
    };
    return [event];
  });

  const isLiveChild = (childThreadId: ThreadId) =>
    projection
      .findThread(childThreadId)
      .pipe(Effect.map((thread) => thread !== null && thread.deletedAt === null));

  /** Reads what the rollout gained since the cursor and appends it to the child thread. */
  const tail = Effect.fn("CodexSessionSync.tail")(function* (childThreadId: ThreadId) {
    const run = state.runs[childThreadId];
    if (run?.state !== "tailing" || run.filePath === null) return;
    const info = yield* fs.stat(run.filePath).pipe(Effect.option);
    if (Option.isNone(info)) return;
    const size = Number(info.value.size);
    const inode = inodeOf(info.value);
    // A replaced or shorter file is re-read from the start, skipping items the thread already has.
    const resume = run.inode === inode && run.offset <= size;
    if (!resume) unverified.add(childThreadId);
    const start = resume ? run.offset : 0;
    if (start === size) {
      if (!resume) {
        updateRun(childThreadId, { ...run, inode, offset: size });
        yield* saveState;
      }
      return;
    }
    const bytes = yield* readRange(run.filePath, start, size);
    const read = readRollout(bytes, start);
    if (read.offset === start) return;
    grewAt.set(childThreadId, yield* Clock.currentTimeMillis);
    if (!(yield* isLiveChild(childThreadId))) return yield* markDone(childThreadId);

    const now = yield* DateTime.now;
    let items = read.items;
    // Replayed lines would reuse event ids that are already stored, and the write would fail.
    if (unverified.has(childThreadId)) {
      const written = yield* Effect.forEach(items, (item) =>
        projection
          .getTurnItem({
            threadId: childThreadId,
            itemId: TurnItemId.make(`${RUN_PREFIX}${childThreadId}:${item.id}`),
          })
          .pipe(Effect.map((existing) => existing !== null)),
      );
      items = items.filter((_, index) => !written[index]);
    }
    const events = items.flatMap((item) => itemEvents({ childThreadId, inode, item, now }));
    if (read.completed) {
      const lastAt = read.items.at(-1)?.at ?? null;
      events.push(...(yield* endRootNode(childThreadId, "completed", toDateTime(lastAt, now))));
    }
    if (events.length > 0) yield* eventSink.write({ events });
    unverified.delete(childThreadId);
    updateRun(childThreadId, { ...run, inode, offset: read.offset });
    if (read.completed) return yield* markDone(childThreadId);
    yield* saveState;
  });

  const expire = Effect.fn("CodexSessionSync.expire")(function* (childThreadId: ThreadId) {
    if (state.runs[childThreadId]?.state !== "tailing") return;
    yield* tail(childThreadId);
    if (state.runs[childThreadId]?.state !== "tailing") return;
    const now = yield* Clock.currentTimeMillis;
    const due = (grewAt.get(childThreadId) ?? now) + IDLE_EXPIRY_MS;
    if (now < due) return yield* schedule(due - now, { _tag: "Expire", childThreadId });
    if (yield* isLiveChild(childThreadId)) {
      const events = yield* endRootNode(childThreadId, "interrupted", yield* DateTime.now);
      if (events.length > 0) yield* eventSink.write({ events });
    }
    yield* markDone(childThreadId);
  });

  const resolveSearch = Effect.fn("CodexSessionSync.resolveSearch")(function* (search: Search) {
    const parent = yield* projection.findThread(search.parentThreadId);
    if (parent === null || parent.deletedAt !== null) return null;
    const base =
      parent.worktreePath ??
      Option.getOrNull(yield* projects.getShell(parent.projectId))?.workspaceRoot ??
      null;
    if (base === null) return null;
    const cwd =
      search.parsed.cd === null
        ? path.resolve(base)
        : path.resolve(base, expandHome(search.parsed.cd));
    const source = search.parsed.prompt;
    let prompt: string | null = null;
    if (source?.kind === "inline") {
      prompt = source.text;
    } else if (source?.kind === "file") {
      const promptPath = path.resolve(cwd, expandHome(source.path));
      const fits = yield* fs.stat(promptPath).pipe(
        Effect.map((info) => info.type === "File" && Number(info.size) <= PROMPT_FILE_MAX_BYTES),
        Effect.orElseSucceed(() => false),
      );
      prompt = fits
        ? yield* fs.readFileString(promptPath).pipe(
            Effect.map((text) => text.trim()),
            Effect.orElseSucceed(() => null),
          )
        : null;
    }
    return { parent, request: { cwd, startedAtMs: search.startedAtMs, prompt } };
  });

  const listRollouts = Effect.fn("CodexSessionSync.listRollouts")(function* (
    startedAtMs: number,
    claimed: ReadonlySet<string>,
  ) {
    const found: Array<FoundRollout> = [];
    for (const dir of rolloutDayDirs(sessionsDir, startedAtMs)) {
      const files = yield* fs
        .readDirectory(dir)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const file of files) {
        const filePath = path.join(dir, file);
        if (!ROLLOUT_FILE.test(file) || claimed.has(filePath)) continue;
        const info = yield* fs.stat(filePath).pipe(Effect.option);
        if (Option.isNone(info) || info.value.type !== "File") continue;
        const modifiedAt = Option.match(info.value.mtime, {
          onNone: () => startedAtMs,
          onSome: (date) => date.getTime(),
        });
        if (modifiedAt < startedAtMs - EARLIEST_MTIME_MS) continue;
        const head = yield* readRange(
          filePath,
          0,
          Math.min(Number(info.value.size), HEAD_BYTES),
        ).pipe(Effect.option);
        if (Option.isNone(head)) continue;
        const { meta, firstPrompt } = readRolloutHead(head.value);
        if (meta === null) continue;
        found.push({
          candidate: { filePath, meta, firstPrompt },
          head: head.value,
          inode: inodeOf(info.value),
        });
      }
    }
    return found;
  });

  /** Creates the read-only child thread for a matched rollout and starts tailing it. */
  const adopt = Effect.fn("CodexSessionSync.adopt")(function* (
    childThreadId: ThreadId,
    search: Search,
    parent: OrchestrationV2AppThread,
    rollout: FoundRollout,
  ) {
    const now = yield* DateTime.now;
    const rootNodeId = rootNodeIdOf(childThreadId);
    const model =
      readRollout(rollout.head, 0).model ??
      DEFAULT_MODEL_BY_PROVIDER[CODEX_DRIVER] ??
      DEFAULT_MODEL;
    const created = makeSubagentChildThread({
      parentThread: parent,
      childThreadId,
      parentNodeId: search.parentNodeId ?? rootNodeId,
      activeProviderThreadId: null,
      providerInstanceId: CODEX_INSTANCE,
      modelSelection: { instanceId: CODEX_INSTANCE, model },
      title: subagentThreadTitle({
        parentTitle: parent.title,
        prompt: rollout.candidate.firstPrompt ?? search.command,
        ordinal: 1,
      }),
      now,
      createdBy: "agent",
      creationSource: "provider",
    });
    const childThread = search.parentNodeId === null ? { ...created, forkedFrom: null } : created;
    const rootNode: OrchestrationV2ExecutionNode = {
      id: rootNodeId,
      threadId: childThreadId,
      runId: null,
      parentNodeId: null,
      rootNodeId,
      kind: "root_turn",
      status: "running",
      countsForRun: false,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: toDateTime(rollout.candidate.meta.startedAt, now),
      completedAt: null,
    };
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`codex-sync:${childThreadId}:created`),
          type: "thread.created",
          threadId: childThreadId,
          providerInstanceId: CODEX_INSTANCE,
          occurredAt: now,
          payload: childThread,
        },
        {
          id: EventId.make(`codex-sync:${childThreadId}:root:running`),
          type: "node.updated",
          threadId: childThreadId,
          nodeId: rootNodeId,
          providerInstanceId: CODEX_INSTANCE,
          occurredAt: now,
          payload: rootNode,
        },
      ],
    });
    searches.delete(childThreadId);
    updateRun(childThreadId, {
      filePath: rollout.candidate.filePath,
      inode: rollout.inode,
      offset: 0,
      state: "tailing",
      parentThreadId: search.parentThreadId,
    });
    yield* saveState;
    yield* startTailing(childThreadId);
  });

  const match = Effect.fn("CodexSessionSync.match")(function* (childThreadId: ThreadId) {
    const search = searches.get(childThreadId);
    if (search === undefined) return;
    if (search.resolved === undefined) {
      // A child that exists, even deleted, was adopted before; a deleted one stays deleted.
      const resolved =
        (yield* projection.findThread(childThreadId)) === null
          ? yield* resolveSearch(search)
          : null;
      if (resolved === null) {
        searches.delete(childThreadId);
        ignored.add(childThreadId);
        return;
      }
      search.resolved = resolved;
    }
    const { parent, request } = search.resolved;
    const claimed = new Set(
      Object.values(state.runs).flatMap((run) => (run.filePath === null ? [] : [run.filePath])),
    );
    const rollouts = yield* listRollouts(search.startedAtMs, claimed);
    const filePath = matchRollout(
      request,
      rollouts.map((rollout) => rollout.candidate),
      claimed,
    );
    const rollout = rollouts.find((found) => found.candidate.filePath === filePath);
    if (rollout !== undefined) return yield* adopt(childThreadId, search, parent, rollout);
    if ((yield* Clock.currentTimeMillis) < search.startedAtMs + SEARCH_WINDOW_MS) {
      return yield* schedule(Duration.toMillis(RETRY_INTERVAL), { _tag: "Match", childThreadId });
    }
    searches.delete(childThreadId);
    updateRun(childThreadId, {
      filePath: null,
      inode: -1,
      offset: 0,
      state: "unmatched",
      parentThreadId: search.parentThreadId,
    });
    yield* saveState;
  });

  // Runs for every committed domain event; untraced so the hot path opens no span per event.
  const onEvent = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
    if (event.type !== "turn-item.updated") return;
    const item = event.payload;
    if (
      item.type !== "command_execution" ||
      !item.input.includes("codex") ||
      item.id.startsWith(RUN_PREFIX)
    ) {
      return;
    }
    const childThreadId = codexRunThreadId(event.threadId, item.id);
    if (
      searches.has(childThreadId) ||
      ignored.has(childThreadId) ||
      state.runs[childThreadId] !== undefined
    ) {
      return;
    }
    const parsed = parseCodexExecCommand(item.input);
    if (parsed === null || parsed.ephemeral) return;
    searches.set(childThreadId, {
      parentThreadId: event.threadId,
      parentNodeId: item.nodeId,
      command: item.input,
      parsed,
      startedAtMs: DateTime.toEpochMillis(item.startedAt ?? event.occurredAt),
    });
    yield* worker.enqueue({ _tag: "Match", childThreadId });
  });

  // Taken before the consumer forks, so a command committed while it subscribes is not skipped.
  const startSequence = yield* eventSink.latestSequence().pipe(Effect.option);
  yield* Stream.unwrap(
    Effect.gen(function* () {
      const afterSequence = Option.isSome(startSequence)
        ? startSequence.value
        : yield* eventSink.latestSequence();
      yield* TxRef.set(seenSequence, afterSequence);
      return eventSink.stream({ afterSequence });
    }),
  ).pipe(
    Stream.runForEach((stored) =>
      onEvent(stored.event).pipe(Effect.andThen(TxRef.set(seenSequence, stored.sequence))),
    ),
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  );

  // Resume what was being tailed when the server stopped.
  for (const [key, run] of Object.entries(state.runs)) {
    if (run.state !== "tailing") continue;
    const childThreadId = ThreadId.make(key);
    unverified.add(childThreadId);
    yield* startTailing(childThreadId);
  }

  const awaitSeen = (sequence: number) =>
    TxRef.get(seenSequence).pipe(
      Effect.flatMap((seen) => (seen >= sequence ? Effect.void : Effect.txRetry)),
      Effect.tx,
    );
  const latestSequence = eventSink.latestSequence().pipe(Effect.orElseSucceed(() => 0));
  const drain = Effect.gen(function* () {
    let target = yield* latestSequence;
    while (true) {
      yield* awaitSeen(target);
      yield* worker.drain;
      const latest = yield* latestSequence;
      if (latest === target) return;
      target = latest;
    }
  });

  return CodexSessionSync.of({ drain });
});

export const layer = Layer.effect(CodexSessionSync, make);
