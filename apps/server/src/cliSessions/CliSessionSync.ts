import {
  ClaudeSettings,
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_RUNTIME_MODE,
  defaultInstanceIdForDriver,
  EventId,
  isRuntimeModeAbove,
  type MessageId,
  type PluginLiveCliSession,
  ProjectId,
  ProviderDriverKind,
  type ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import { type DrainableWorker, makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";
import { isActiveRun } from "../orchestration-v2/CommandPolicy.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { externalMessageId } from "../orchestration-v2/ExternalHistory.ts";
import {
  type ExternalSessionHolder,
  ExternalSessionHolds,
} from "../orchestration-v2/ExternalSessionHolds.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import { importedThreadRows } from "../project/AgentSessionImporter.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ClaudeSessionRegistry from "./ClaudeSessionRegistry.ts";
import { CliSessionsLive } from "./cliSessionsLiveSource.ts";
import { pairSessionIdsIn, placeSession, transcriptOrigin } from "./sessionPlacement.ts";
import { readSyncState, type SyncState, writeSyncState } from "./syncState.ts";
import { readTranscript, type TranscriptEntry } from "./transcriptReader.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CLAUDE_INSTANCE = defaultInstanceIdForDriver(CLAUDE_DRIVER);
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BACKFILL_WINDOW = Duration.days(14);
// A session last touched this recently is probably still in use, so it starts unsettled.
const RECENT_ACTIVITY = Duration.hours(2);
const KEPT_NEWEST_ENTRIES = 200;
const BACKGROUND_KEPT_NOTICE =
  "rucode is still running background work in this session; its result may be written while the session is open in the terminal";

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const isThreadDeleted = Schema.is(Orchestrator.OrchestratorThreadDeletedError);
const isRunActive = Schema.is(Orchestrator.OrchestratorThreadRunActiveError);

/** Writes the held-session snapshot that admission (`ExternalSessionHolds`) and clients read. */
export class CliSessionHolds extends Context.Service<
  CliSessionHolds,
  {
    readonly publishHolds: (
      holds: ReadonlyMap<ThreadId, ExternalSessionHolder>,
    ) => Effect.Effect<void>;
    readonly publishLive: (sessions: ReadonlyArray<PluginLiveCliSession>) => Effect.Effect<void>;
  }
>()("t3/cliSessions/CliSessionSync/CliSessionHolds") {}

/**
 * One in-memory snapshot behind three readers. The orchestrator reads `ExternalSessionHolds` once
 * at construction, so this layer must be provided beneath the orchestration and plugin-card layers.
 */
export const layerHolds = Layer.effectContext(
  Effect.gen(function* () {
    const snapshot: { holds: ReadonlyMap<ThreadId, ExternalSessionHolder> } = { holds: new Map() };
    const holdVersion = yield* SubscriptionRef.make(0);
    const live = yield* SubscriptionRef.make<ReadonlyArray<PluginLiveCliSession>>([]);
    const holds = CliSessionHolds.of({
      publishHolds: Effect.fn("CliSessionHolds.publishHolds")(function* (next) {
        if (Equal.equals([...snapshot.holds], [...next])) return;
        snapshot.holds = next;
        yield* SubscriptionRef.update(holdVersion, (version) => version + 1);
      }),
      publishLive: Effect.fn("CliSessionHolds.publishLive")(function* (sessions) {
        if (Equal.equals(yield* SubscriptionRef.get(live), sessions)) return;
        yield* SubscriptionRef.set(live, sessions);
      }),
    });
    return Context.make(CliSessionHolds, holds).pipe(
      Context.add(ExternalSessionHolds, {
        heldBy: (threadId) => snapshot.holds.get(threadId) ?? null,
        // Emits once on subscribe too, so a reader never misses a change made while subscribing.
        changes: SubscriptionRef.changes(holdVersion).pipe(Stream.as(undefined)),
      }),
      Context.add(CliSessionsLive, {
        current: SubscriptionRef.get(live),
        changes: SubscriptionRef.changes(live).pipe(Stream.as(undefined)),
      }),
    );
  }),
);

export class CliSessionSync extends Context.Service<
  CliSessionSync,
  {
    /** Resolves once every queued registry, transcript and run change has been handled. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/cliSessions/CliSessionSync") {}

type Job =
  | { readonly _tag: "Refresh" }
  | { readonly _tag: "Tail"; readonly sessionId: string }
  | { readonly _tag: "Backfill" };

const toDateTime = (value: string | null, fallback: DateTime.Utc) => {
  if (value === null) return fallback;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.toUtc(parsed.value) : fallback;
};

/** The first human entry and the newest entries, so a long session imports at a bounded size. */
export function keptEntries(entries: ReadonlyArray<TranscriptEntry>): {
  readonly entries: ReadonlyArray<TranscriptEntry>;
  readonly omitted: number;
} {
  if (entries.length <= KEPT_NEWEST_ENTRIES + 1) return { entries, omitted: 0 };
  const newest = entries.slice(-KEPT_NEWEST_ENTRIES);
  const firstHuman = entries.findIndex((entry) => entry.role === "user");
  const kept =
    firstHuman === -1 || firstHuman >= entries.length - KEPT_NEWEST_ENTRIES
      ? newest
      : [entries[firstHuman]!, ...newest];
  return { entries: kept, omitted: entries.length - kept.length };
}

const omittedNotice = (count: number) =>
  `${count} earlier ${count === 1 ? "message was" : "messages were"} not imported. This thread keeps the first user message and the most recent history. The original session transcript is unchanged.`;

const make = Effect.gen(function* () {
  const registry = yield* ClaudeSessionRegistry.ClaudeSessionRegistry;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projection = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const projects = yield* ProjectService.ProjectService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const holds = yield* CliSessionHolds;
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDir = yield* HostProcess.HomeDirectory;
  const hostEnvironment = yield* HostProcess.Environment;

  const claudeHome = yield* Effect.gen(function* () {
    const current = yield* settings.getSettings.pipe(Effect.option);
    const instance = Option.isSome(current)
      ? current.value.providerInstances[CLAUDE_INSTANCE]
      : undefined;
    const claude =
      instance === undefined || instance.driver === CLAUDE_DRIVER
        ? Option.getOrUndefined(decodeClaudeSettings(instance?.config ?? {}))
        : undefined;
    const configured = instance?.environment?.findLast(
      (variable) => variable.name === "CLAUDE_CONFIG_DIR",
    )?.value;
    const configDir =
      typeof configured === "string" ? configured : hostEnvironment.CLAUDE_CONFIG_DIR;
    return yield* resolveClaudeHomePath(
      { homePath: claude?.homePath ?? "" },
      configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: configDir },
    );
  });
  const projectsDir = path.join(claudeHome, "projects");
  const pairsDir = path.join(homeDir, ".claude", "initiatives", ".pairs");

  // A server run from a dev worktree defaults off, so it does not adopt the developer's sessions.
  const devWorktree = yield* fs.stat(path.join(path.dirname(config.baseDir), ".git")).pipe(
    Effect.map((info) => info.type === "File"),
    Effect.orElseSucceed(() => false),
  );
  const isEnabled = settings.getSettings.pipe(
    Effect.map((current) => current.claudeTerminalSessions ?? !devWorktree),
    Effect.orElseSucceed(() => false),
  );

  let state: SyncState = yield* readSyncState(config.stateDir);
  let stateDirty = false;
  const skipped = new Set<string>();
  const watches = new Map<string, Scope.Closeable>();
  const waitingOnRun = new Map<ThreadId, string>();
  const pendingRelease = new Set<ThreadId>();
  const backgroundKept = new Set<ThreadId>();
  let heldThreads = new Set<ThreadId>();

  const saveState = Effect.suspend(() => {
    if (!stateDirty) return Effect.void;
    stateDirty = false;
    return writeSyncState(config.stateDir, state).pipe(
      Effect.catchTags({
        CliSessionSyncStateWriteError: (cause) =>
          Effect.logWarning("cli session sync could not save its cursor", { cause }),
      }),
    );
  });
  const updateSession = (sessionId: string, next: SyncState["sessions"][string] | null) => {
    const { [sessionId]: _previous, ...rest } = state.sessions;
    state = { ...state, sessions: next === null ? rest : { ...rest, [sessionId]: next } };
    stateDirty = true;
  };

  const claudeSessionThreads = Effect.fn("CliSessionSync.claudeSessionThreads")(function* () {
    type Row = { readonly thread_id: string; readonly session_id: string };
    const nativeId = sql`json_extract(provider_thread.payload_json, '$.nativeThreadRef.nativeId')`;
    const rows = yield* sql<Row>`
      SELECT DISTINCT provider_thread.thread_id AS thread_id, ${nativeId} AS session_id
      FROM orchestration_v2_projection_provider_threads AS provider_thread
      JOIN orchestration_v2_projection_threads AS thread
        ON thread.thread_id = provider_thread.thread_id
        AND thread.active_provider_thread_id = provider_thread.provider_thread_id
      WHERE provider_thread.driver = ${CLAUDE_DRIVER}
        AND typeof(${nativeId}) = 'text'
        AND thread.deleted_at IS NULL
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.tapError((cause) =>
        Effect.logWarning("cli session sync could not look up Claude sessions", { cause }),
      ),
      Effect.orElseSucceed((): ReadonlyArray<Row> => []),
    );
    // Forks can share a session id; an ambiguous session maps to no thread but still counts as known.
    const sessions = new Map<string, ThreadId | null>();
    for (const row of rows) {
      sessions.set(
        row.session_id,
        sessions.has(row.session_id) ? null : ThreadId.make(row.thread_id),
      );
    }
    return sessions;
  });

  const findTranscript = Effect.fn("CliSessionSync.findTranscript")(function* (sessionId: string) {
    const dirs = yield* fs
      .readDirectory(projectsDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const found = yield* Effect.filter(
      dirs.map((dir) => path.join(projectsDir, dir, `${sessionId}.jsonl`)),
      (candidate) =>
        fs.stat(candidate).pipe(
          Effect.map((info) => info.type === "File"),
          Effect.orElseSucceed(() => false),
        ),
      { concurrency: 16 },
    );
    return found.length === 1 ? found[0]! : null;
  });

  const linkedWorktreeOf = Effect.fn("CliSessionSync.linkedWorktreeOf")(function* (cwd: string) {
    const dotGit = yield* fs.readFileString(path.join(cwd, ".git")).pipe(Effect.option);
    const pointer = Option.isSome(dotGit) ? /^gitdir:\s*(.+)$/m.exec(dotGit.value) : null;
    if (pointer === null) return null;
    const gitDir = path.resolve(cwd, pointer[1]!.trim());
    const commonDir = yield* fs.readFileString(path.join(gitDir, "commondir")).pipe(Effect.option);
    if (Option.isNone(commonDir)) return null;
    const mainGitDir = path.resolve(gitDir, commonDir.value.trim());
    if (path.basename(mainGitDir) !== ".git") return null;
    const head = yield* fs
      .readFileString(path.join(gitDir, "HEAD"))
      .pipe(Effect.orElseSucceed(() => ""));
    return {
      mainCheckout: path.dirname(mainGitDir),
      branch: /^ref: refs\/heads\/(.+)$/.exec(head.trim())?.[1] ?? null,
    };
  });

  const pairSessionIds = Effect.fn("CliSessionSync.pairSessionIds")(function* () {
    const pairs = yield* fs
      .readDirectory(pairsDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const records = yield* Effect.forEach(pairs, (pair) =>
      fs
        .readFileString(path.join(pairsDir, pair, "record.json"))
        .pipe(Effect.orElseSucceed(() => "")),
    );
    return new Set(records.flatMap(pairSessionIdsIn));
  });

  const ceiling = settings.managedPolicy?.limits?.maxRuntimeMode;
  const runtimeMode =
    ceiling !== undefined && isRuntimeModeAbove(DEFAULT_RUNTIME_MODE, ceiling)
      ? ceiling
      : DEFAULT_RUNTIME_MODE;

  const append = Effect.fn("CliSessionSync.append")(function* (input: {
    readonly commandId: string;
    readonly threadId: ThreadId;
    readonly sessionId: string;
    readonly leafUuid: string | null;
    readonly live: boolean;
    readonly entries: ReadonlyArray<TranscriptEntry>;
    readonly notices?: ReadonlyArray<{ readonly key: string; readonly text: string }>;
    readonly title?: { readonly value: string; readonly expected: string } | null;
  }) {
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.external-history.append",
      commandId: CommandId.make(input.commandId),
      threadId: input.threadId,
      sessionId: input.sessionId,
      leafUuid: input.leafUuid,
      activity: input.live ? "live" : "backfill",
      entries: input.entries.map((entry) => ({
        uuid: entry.uuid,
        role: entry.role,
        text: entry.text,
        createdAt: toDateTime(entry.createdAt, now),
      })),
      notices: input.notices ?? [],
      title: input.title ?? null,
    });
  });

  const stopTailing = Effect.fn("CliSessionSync.stopTailing")(function* (sessionId: string) {
    const scope = watches.get(sessionId);
    if (scope === undefined) return;
    watches.delete(sessionId);
    yield* Scope.close(scope, Exit.void);
  });

  const worker: DrainableWorker<Job> = yield* makeDrainableWorker((job: Job) => {
    switch (job._tag) {
      case "Refresh":
        return refresh();
      case "Tail":
        return tail(job.sessionId);
      case "Backfill":
        return backfill();
    }
  });

  const startTailing = Effect.fn("CliSessionSync.startTailing")(function* (sessionId: string) {
    const synced = state.sessions[sessionId];
    if (synced === undefined || watches.has(sessionId)) return;
    const scope = yield* Scope.make();
    watches.set(sessionId, scope);
    yield* fs.watch(synced.filePath).pipe(
      Stream.runForEach(() => worker.enqueue({ _tag: "Tail", sessionId })),
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(scope),
    );
  });

  /** Reads what the transcript gained since the cursor and appends it to the thread. */
  const tail = Effect.fn("CliSessionSync.tail")(function* (sessionId: string) {
    const synced = state.sessions[sessionId];
    if (synced === undefined || !(yield* isEnabled)) return;
    const info = yield* fs.stat(synced.filePath).pipe(Effect.option);
    if (Option.isNone(info)) return;
    const size = Number(info.value.size);
    const inode = Option.match(info.value.ino, { onNone: () => -1, onSome: Number });
    // A replaced file, a shorter file or a lost cursor re-reads from the start; uuid ids make
    // that idempotent, and only entries after the last one already synced are offered.
    const resume = synced.inode === inode && synced.offset <= size;
    const start = resume ? synced.offset : 0;
    if (start === size) {
      if (!resume) updateSession(sessionId, { ...synced, inode, offset: size });
      return;
    }
    const bytes = yield* fs.readFile(synced.filePath).pipe(
      Effect.map((all) => all.subarray(start, size)),
      Effect.option,
    );
    if (Option.isNone(bytes)) return;
    const read = readTranscript(bytes.value, start);
    let entries = read.entries;
    if (!resume && entries.length > 0) {
      const messageIds = entries.flatMap((entry) =>
        entry.role === "reasoning" ? [] : [externalMessageId(synced.threadId, entry.uuid)],
      );
      const existing = yield* projection
        .getMessagesById(synced.threadId, messageIds)
        .pipe(Effect.orElseSucceed((): ReadonlyMap<MessageId, unknown> => new Map()));
      const lastExisting = entries.findLastIndex((entry) =>
        existing.has(externalMessageId(synced.threadId, entry.uuid)),
      );
      // Nothing synced yet: a thread rucode created, whose earlier history it already holds.
      entries = lastExisting === -1 ? [] : entries.slice(lastExisting + 1);
    }
    const title =
      read.title !== null && synced.syncedTitle !== null && read.title !== synced.syncedTitle
        ? { value: read.title, expected: synced.syncedTitle }
        : null;
    if (entries.length > 0 || title !== null) {
      const attachments = yield* SubscriptionRef.get(registry.attachments);
      const outcome = yield* append({
        commandId: `cli-sync:${sessionId}:${inode}:${start}-${read.offset}`,
        threadId: synced.threadId,
        sessionId,
        leafUuid: read.leafUuid,
        live: attachments.has(sessionId),
        entries,
        title,
      }).pipe(
        Effect.as("appended" as const),
        Effect.catch((cause) => {
          if (isThreadDeleted(cause)) return Effect.succeed("deleted" as const);
          if (isRunActive(cause)) return Effect.succeed("run-active" as const);
          return Effect.logWarning("cli session sync could not append history", {
            sessionId,
            cause,
          }).pipe(Effect.as("failed" as const));
        }),
      );
      if (outcome === "deleted") {
        skipped.add(sessionId);
        updateSession(sessionId, null);
        yield* stopTailing(sessionId);
        return yield* saveState;
      }
      if (outcome === "run-active") {
        waitingOnRun.set(synced.threadId, sessionId);
        return;
      }
      if (outcome === "failed") return;
    }
    waitingOnRun.delete(synced.threadId);
    updateSession(sessionId, {
      ...synced,
      inode,
      offset: read.offset,
      syncedTitle: title === null ? synced.syncedTitle : title.value,
    });
    yield* saveState;
  });

  /** Creates the thread for a terminal session and imports its history. */
  const adopt = Effect.fn("CliSessionSync.adopt")(function* (input: {
    readonly sessionId: string;
    readonly filePath: string | null;
    readonly attachment: ClaudeSessionRegistry.Attachment | null;
  }) {
    const { sessionId, attachment } = input;
    const threadId = ThreadId.make(`import:${CLAUDE_INSTANCE}:${sessionId}`);
    const existing = yield* projection.findThread(threadId).pipe(Effect.orElseSucceed(() => null));
    if (existing !== null) {
      // A deleted thread stays deleted; a live one is tailed from where its history ends.
      if (existing.deletedAt !== null) {
        skipped.add(sessionId);
      }
      return;
    }
    const filePath = input.filePath ?? (yield* findTranscript(sessionId));
    // A session that has not written its first prompt has no transcript yet; look again later.
    if (filePath === null) return;
    const info = yield* fs.stat(filePath).pipe(Effect.option);
    const bytes = yield* fs.readFile(filePath).pipe(Effect.option);
    if (Option.isNone(info) || Option.isNone(bytes)) return;
    const origin = transcriptOrigin(bytes.value);
    // Sessions rucode started are its own threads, even after a resume in a terminal.
    if (origin === null || origin.entrypoint !== "cli") {
      skipped.add(sessionId);
      return;
    }
    const cwd = origin.cwd ?? attachment?.cwd ?? null;
    if (cwd === null || !path.isAbsolute(cwd)) {
      skipped.add(sessionId);
      return;
    }
    const read = readTranscript(bytes.value, 0);
    const placement = placeSession({
      sessionId,
      cwd: path.resolve(cwd),
      homeDir,
      projects: (yield* projects.listShells()).map((project) => ({
        id: project.id,
        workspaceRoot: project.workspaceRoot,
      })),
      linkedWorktree: yield* linkedWorktreeOf(cwd),
      names: [attachment?.name ?? null, read.agentName, read.customTitle],
      pairSessionIds: yield* pairSessionIds(),
    });
    if (placement._tag === "Skip") {
      skipped.add(sessionId);
      return;
    }
    const projectId =
      placement._tag === "Project"
        ? placement.projectId
        : (yield* projects.bootstrap({
            commandId: CommandId.make(`cli-sync:project:${sessionId}`),
            projectId: ProjectId.make(`cli-sync:${sessionId}`),
            title: path.basename(placement.workspaceRoot),
            workspaceRoot: placement.workspaceRoot,
          })).project.id;
    const worktree = placement._tag === "Project" ? placement.worktree : null;

    const now = yield* DateTime.now;
    const firstAt = toDateTime(read.entries[0]?.createdAt ?? null, now);
    const lastAt = toDateTime(read.entries.at(-1)?.createdAt ?? null, now);
    const recent = DateTime.isGreaterThan(DateTime.addDuration(lastAt, RECENT_ACTIVITY), now);
    const providerThreadId = idAllocator.derive.providerThread({
      driver: CLAUDE_DRIVER,
      providerInstanceId: CLAUDE_INSTANCE,
      nativeThreadId: sessionId,
    });
    const mode = runtimeMode;
    const { appThread, providerThread } = importedThreadRows({
      threadId,
      projectId,
      title: read.title ?? "",
      providerInstanceId: CLAUDE_INSTANCE,
      driver: CLAUDE_DRIVER,
      model: DEFAULT_MODEL_BY_PROVIDER[CLAUDE_DRIVER] ?? DEFAULT_MODEL,
      runtimeMode: mode,
      worktree,
      providerThreadId,
      nativeThreadId: sessionId,
      createdAt: firstAt,
      updatedAt: lastAt,
      settled: attachment === null && !recent,
    });
    const committed = yield* eventSink.write({
      unlessNativeThreadOwned: providerThread,
      events: [
        {
          id: EventId.make(`cli-sync:thread:${threadId}:created`),
          type: "thread.created",
          threadId,
          providerInstanceId: CLAUDE_INSTANCE,
          occurredAt: firstAt,
          payload: appThread,
        },
        {
          id: EventId.make(`cli-sync:provider-thread:${providerThreadId}`),
          type: "provider-thread.updated",
          threadId,
          driver: CLAUDE_DRIVER,
          providerInstanceId: CLAUDE_INSTANCE,
          occurredAt: lastAt,
          payload: providerThread,
        },
      ],
    });
    if (committed.length === 0) {
      skipped.add(sessionId);
      return;
    }
    const cwdForResume = worktree?.path ?? cwd;
    yield* runtimes.upsert(
      {
        threadId,
        providerName: CLAUDE_DRIVER,
        providerInstanceId: CLAUDE_INSTANCE,
        adapterKey: CLAUDE_DRIVER,
        runtimeMode: mode,
        status: "stopped",
        lastSeenAt: DateTime.formatIso(lastAt),
        resumeCursor: { threadId, resume: sessionId },
        runtimePayload: { cwd: cwdForResume },
      },
      { onConflict: "ignore" },
    );
    const inode = Option.match(info.value.ino, { onNone: () => -1, onSome: Number });
    // Onboarding import then reports this transcript as already imported.
    yield* runtimes.recordImportedTranscript({
      threadId,
      source: {
        provider: "claudeAgent",
        providerInstanceId: CLAUDE_INSTANCE,
        providerSessionId: sessionId,
        filePath,
        size: Number(info.value.size),
        mtimeMs: Option.match(info.value.mtime, { onNone: () => null, onSome: (d) => d.getTime() }),
        device: Number(info.value.dev),
        inode: Option.match(info.value.ino, { onNone: () => null, onSome: String }),
        birthtimeMs: Option.match(info.value.birthtime, {
          onNone: () => null,
          onSome: (d) => d.getTime(),
        }),
      },
    });
    const kept = keptEntries(read.entries);
    if (kept.omitted > 0) {
      yield* append({
        commandId: `cli-sync:${sessionId}:adopt-notice`,
        threadId,
        sessionId,
        leafUuid: read.leafUuid,
        live: false,
        entries: [],
        notices: [{ key: "earlier-omitted", text: omittedNotice(kept.omitted) }],
      });
    }
    yield* append({
      commandId: `cli-sync:${sessionId}:${inode}:0-${read.offset}`,
      threadId,
      sessionId,
      leafUuid: read.leafUuid,
      live: false,
      entries: kept.entries,
    });
    updateSession(sessionId, {
      threadId,
      filePath,
      inode,
      offset: read.offset,
      syncedTitle: appThread.title,
      pane: null,
    });
    yield* saveState;
  });

  /** Releases rucode's own process on a session a terminal opened, unless work is pending. */
  const release = Effect.fn("CliSessionSync.release")(function* (threadId: ThreadId) {
    const records = yield* projection
      .getThreadRecords(threadId, ["providerThreads"])
      .pipe(Effect.option);
    if (Option.isNone(records)) return;
    const sessionIds = new Set<ProviderSessionId>();
    for (const providerThread of records.value.providerThreads) {
      if (providerThread.appThreadId === threadId && providerThread.providerSessionId !== null) {
        sessionIds.add(providerThread.providerSessionId);
      }
    }
    const backgroundPending = projection.getThreadRecords(threadId, ["providerThreads"]).pipe(
      Effect.map(({ providerThreads }) =>
        providerThreads.some(
          (providerThread) =>
            providerThread.providerSessionId !== null &&
            sessionIds.has(providerThread.providerSessionId) &&
            (providerThread.pendingBackgroundTasks ?? []).length > 0,
        ),
      ),
      // An unreadable thread keeps its process; the next registry change tries again.
      Effect.orElseSucceed(() => true),
    );
    let kept = false;
    for (const providerSessionId of sessionIds) {
      if (!(yield* providerSessions.isLive(providerSessionId))) continue;
      const released = yield* providerSessions
        .releaseUnlessBusy({
          providerSessionId,
          ownProviderThreadIds: [],
          throughRunOrdinal: 0,
          keepIf: backgroundPending,
          reason: "external_writer",
          detail: "The session was opened in another Claude Code process.",
        })
        .pipe(Effect.orElseSucceed(() => false));
      if (!released) kept = true;
    }
    if (kept) pendingRelease.add(threadId);
    else pendingRelease.delete(threadId);
    if (!kept || !(yield* backgroundPending)) {
      backgroundKept.delete(threadId);
      return;
    }
    backgroundKept.add(threadId);
    // The notice key is unique per thread, so repeating the append adds nothing.
    yield* append({
      commandId: `cli-sync:${threadId}:background-kept`,
      threadId,
      sessionId: [...sessionIds][0] ?? threadId,
      leafUuid: null,
      live: false,
      entries: [],
      notices: [{ key: "background-kept", text: BACKGROUND_KEPT_NOTICE }],
    }).pipe(Effect.ignore);
  });

  const refresh = Effect.fn("CliSessionSync.refresh")(function* () {
    const attachments = yield* SubscriptionRef.get(registry.attachments);
    const enabled = yield* isEnabled;
    let threads = yield* claudeSessionThreads();
    let adopted = false;
    if (enabled) {
      for (const attachment of attachments.values()) {
        const { sessionId } = attachment;
        if (
          attachment.owner !== "terminal" ||
          threads.has(sessionId) ||
          skipped.has(sessionId) ||
          state.sessions[sessionId] !== undefined ||
          !SESSION_ID_PATTERN.test(sessionId)
        ) {
          continue;
        }
        yield* adopt({ sessionId, filePath: null, attachment }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("cli session sync could not adopt a session", { sessionId, cause }),
          ),
        );
        adopted = true;
      }
    }
    // A thread adopted just now is held from the start, not from the next registry change.
    if (adopted) threads = yield* claudeSessionThreads();

    const held = new Map<ThreadId, ExternalSessionHolder>();
    const heldSessions: Array<{
      readonly threadId: ThreadId;
      readonly attachment: ClaudeSessionRegistry.Attachment;
    }> = [];
    for (const attachment of attachments.values()) {
      const threadId = threads.get(attachment.sessionId) ?? null;
      if (threadId === null || attachment.owner === "rucode") continue;
      held.set(threadId, { owner: attachment.owner, name: attachment.name });
      heldSessions.push({ threadId, attachment });
    }
    // Admission sees the hold before rucode's own process is let go.
    yield* holds.publishHolds(held);
    for (const threadId of held.keys()) {
      if (!heldThreads.has(threadId) || pendingRelease.has(threadId)) yield* release(threadId);
    }
    for (const threadId of heldThreads) {
      if (held.has(threadId)) continue;
      pendingRelease.delete(threadId);
      backgroundKept.delete(threadId);
    }
    heldThreads = new Set(held.keys());

    if (enabled) {
      for (const { threadId, attachment } of heldSessions) {
        if (state.sessions[attachment.sessionId] !== undefined) continue;
        const filePath = yield* findTranscript(attachment.sessionId);
        if (filePath === null) continue;
        // A cursor of -1 forces the first read to start over, offering only unsynced entries.
        updateSession(attachment.sessionId, {
          threadId,
          filePath,
          inode: -1,
          offset: 0,
          syncedTitle: null,
          pane: null,
        });
      }
    }
    // A foreign process writes a transcript only while it holds the session: watch those, and
    // read once more when a hold ends to catch its last records.
    for (const sessionId of watches.keys()) {
      if (attachments.has(sessionId)) continue;
      yield* stopTailing(sessionId);
      yield* worker.enqueue({ _tag: "Tail", sessionId });
    }
    for (const attachment of attachments.values()) {
      const synced = state.sessions[attachment.sessionId];
      if (synced === undefined) continue;
      if (enabled && !watches.has(attachment.sessionId)) {
        yield* startTailing(attachment.sessionId);
        yield* worker.enqueue({ _tag: "Tail", sessionId: attachment.sessionId });
      }
      if (attachment.pane !== null) {
        const socket = yield* registry.socketOf(attachment.pid);
        // `name` is the tmux session, which the hand-off targets with the socket.
        const pane =
          socket === null
            ? null
            : { socket, pane: attachment.pane.pane, name: attachment.pane.session };
        if (pane !== null && !Equal.equals(pane, synced.pane)) {
          updateSession(attachment.sessionId, { ...state.sessions[attachment.sessionId]!, pane });
        }
      }
    }
    if (enabled && state.backfilledAt === null) yield* worker.enqueue({ _tag: "Backfill" });
    yield* saveState;
    yield* holds.publishLive(
      heldSessions.map(({ threadId, attachment }) => ({
        threadId,
        sessionId: attachment.sessionId,
        owner: attachment.owner === "terminal" ? "terminal" : "other",
        status: attachment.status,
        name: attachment.name,
        inTmux: attachment.pane !== null,
        backgroundWorkKept: backgroundKept.has(threadId),
      })),
    );
  });

  /** Once per environment: adopt terminal sessions from the last two weeks. */
  const backfill = Effect.fn("CliSessionSync.backfill")(function* () {
    if (state.backfilledAt !== null || !(yield* isEnabled)) return;
    const now = yield* DateTime.now;
    const cutoff = DateTime.toEpochMillis(now) - Duration.toMillis(BACKFILL_WINDOW);
    const threads = yield* claudeSessionThreads();
    const attachments = yield* SubscriptionRef.get(registry.attachments);
    const dirs = yield* fs
      .readDirectory(projectsDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const dir of dirs) {
      const files = yield* fs
        .readDirectory(path.join(projectsDir, dir))
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const sessionId = file.slice(0, -".jsonl".length);
        if (
          !SESSION_ID_PATTERN.test(sessionId) ||
          threads.has(sessionId) ||
          skipped.has(sessionId) ||
          state.sessions[sessionId] !== undefined
        ) {
          continue;
        }
        const filePath = path.join(projectsDir, dir, file);
        const modified = yield* fs.stat(filePath).pipe(
          Effect.map((info) =>
            Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }),
          ),
          Effect.orElseSucceed(() => 0),
        );
        if (modified < cutoff) continue;
        yield* adopt({ sessionId, filePath, attachment: attachments.get(sessionId) ?? null }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("cli session sync could not adopt a session", { sessionId, cause }),
          ),
        );
      }
    }
    state = { ...state, backfilledAt: DateTime.formatIso(now) };
    stateDirty = true;
    yield* saveState;
  });

  yield* SubscriptionRef.changes(registry.attachments).pipe(
    Stream.runForEach(() => worker.enqueue({ _tag: "Refresh" })),
    Effect.forkScoped,
  );
  yield* Stream.unwrap(settings.subscribeChanges).pipe(
    Stream.runForEach(() => worker.enqueue({ _tag: "Refresh" })),
    Effect.forkScoped,
  );
  yield* orchestrator.streamDomainEvents.pipe(
    Stream.runForEach((event) => {
      if (event.type === "run.updated") {
        if (isActiveRun(event.payload)) return Effect.void;
        const waiting = waitingOnRun.get(event.threadId);
        return Effect.all([
          waiting === undefined
            ? Effect.void
            : worker.enqueue({ _tag: "Tail", sessionId: waiting }),
          pendingRelease.has(event.threadId) ? worker.enqueue({ _tag: "Refresh" }) : Effect.void,
        ]);
      }
      // A new or rebound Claude thread can change which thread a held session belongs to.
      const remapped =
        event.type === "thread.created" ||
        event.type === "thread.deleted" ||
        (event.type === "provider-thread.updated" && event.payload.driver === CLAUDE_DRIVER);
      if (!remapped) return Effect.void;
      return SubscriptionRef.get(registry.attachments).pipe(
        Effect.flatMap((attachments) =>
          attachments.size === 0 ? Effect.void : worker.enqueue({ _tag: "Refresh" }),
        ),
      );
    }),
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  );
  // Catch up on what terminals wrote while the server was down.
  for (const sessionId of Object.keys(state.sessions)) {
    yield* worker.enqueue({ _tag: "Tail", sessionId });
  }
  yield* worker.enqueue({ _tag: "Refresh" });

  return CliSessionSync.of({ drain: worker.drain });
});

export const layer = Layer.effect(CliSessionSync, make);
