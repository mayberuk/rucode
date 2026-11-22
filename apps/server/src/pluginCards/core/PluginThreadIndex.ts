import {
  ClaudeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStoreV2 from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import { AGENT_THREAD_ENV } from "../../preview/PortScanner.ts";
import { resolveClaudeHomePath } from "../../provider/Drivers/ClaudeHome.ts";
import * as ServerSettings from "../../serverSettings.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
// Claude names transcripts `<sessionId>.jsonl`; anything else could escape the projects directory.
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

export class PluginThreadIndex extends Context.Service<
  PluginThreadIndex,
  {
    readonly threadForClaudeSession: (sessionId: string) => Effect.Effect<ThreadId | null>;
    /** Non-archived threads whose effective working directory equals `dir`. */
    readonly threadsForDir: (dir: string) => Effect.Effect<ReadonlyArray<ThreadId>>;
    /** Null off Linux, or when the process names no existing thread. */
    readonly threadForPid: (pid: number) => Effect.Effect<ThreadId | null>;
    readonly claudeTranscript: (
      threadId: ThreadId,
    ) => Effect.Effect<{ readonly sessionId: string; readonly transcriptPath: string } | null>;
    readonly decisionLookup: Effect.Effect<{
      readonly checkouts: ReadonlyArray<string>;
      readonly threadForClaudeSession: (sessionId: string) => Effect.Effect<ThreadId | null>;
    }>;
    readonly decisionMappingChanges: Stream.Stream<void>;
    /** Project roots and worktree paths of non-archived threads. */
    readonly checkouts: Effect.Effect<ReadonlyArray<string>>;
  }
>()("t3/pluginCards/core/PluginThreadIndex") {}

const parseEnvironThreadId = (raw: string): string | null => {
  const prefix = `${AGENT_THREAD_ENV}=`;
  const value = raw
    .split("\0")
    .find((entry) => entry.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
  return value ? value : null;
};

export const make = Effect.fn("PluginThreadIndex.make")(function* (options?: {
  readonly procRoot?: string;
}) {
  const procRoot = options?.procRoot ?? "/proc";
  const sql = yield* SqlClient.SqlClient;
  const projection = yield* ProjectionStoreV2.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const eventStore = yield* OrchestrationEventStore.OrchestrationEventStore;
  const settings = yield* ServerSettings.ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostEnvironment = yield* HostProcess.Environment;
  const homeDirectory = yield* HostProcess.HomeDirectory;

  const liveThreadId = Effect.fnUntraced(function* (raw: string) {
    const threadId = decodeThreadId(raw);
    if (Option.isNone(threadId)) return null;
    const thread = yield* projection
      .findThread(threadId.value)
      .pipe(Effect.orElseSucceed(() => null));
    return thread !== null && thread.deletedAt === null ? thread.id : null;
  });

  const readClaudeSessions = Effect.fn("PluginThreadIndex.readClaudeSessions")(function* (
    sessionId?: string,
  ) {
    type Row = { readonly thread_id: string; readonly session_id: string };
    const nativeId = sql`json_extract(provider_thread.payload_json, '$.nativeThreadRef.nativeId')`;
    return yield* sql<Row>`
      SELECT DISTINCT provider_thread.thread_id AS thread_id, ${nativeId} AS session_id
      FROM orchestration_v2_projection_provider_threads AS provider_thread
      JOIN orchestration_v2_projection_threads AS thread
        ON thread.thread_id = provider_thread.thread_id
        AND thread.active_provider_thread_id = provider_thread.provider_thread_id
      WHERE provider_thread.driver = ${CLAUDE_DRIVER}
        AND ${sessionId === undefined ? sql`typeof(${nativeId}) = 'text'` : sql`${nativeId} = ${sessionId}`}
        AND thread.deleted_at IS NULL
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.tapError((cause) =>
        Effect.logWarning("plugin cards could not look up Claude sessions", { cause }),
      ),
      Effect.orElseSucceed((): ReadonlyArray<Row> => []),
    );
  });

  const threadForClaudeSession = Effect.fn("PluginThreadIndex.threadForClaudeSession")(function* (
    sessionId: string,
  ) {
    const rows = yield* readClaudeSessions(sessionId);
    // Forks can share a session id; an ambiguous match maps to no chat.
    return rows.length === 1 ? Option.getOrNull(decodeThreadId(rows[0]!.thread_id)) : null;
  });

  const activeDirectories = Effect.fnUntraced(function* () {
    const snapshot = yield* projection.getShellSnapshot({ location: "active" });
    const roots = new Map(
      (yield* projects.listShells()).map((project) => [project.id, project.workspaceRoot]),
    );
    return snapshot.threads.map((thread) => ({
      threadId: thread.id,
      worktreePath: thread.worktreePath,
      projectRoot: roots.get(thread.projectId) ?? null,
    }));
  });

  const readDirectories = activeDirectories().pipe(
    Effect.tapError((cause) =>
      Effect.logWarning("plugin cards could not read thread directories", { cause }),
    ),
    Effect.orElseSucceed(
      (): ReadonlyArray<{
        readonly threadId: ThreadId;
        readonly worktreePath: string | null;
        readonly projectRoot: string | null;
      }> => [],
    ),
  );

  const threadsForDir = Effect.fn("PluginThreadIndex.threadsForDir")(function* (dir: string) {
    const target = path.resolve(dir);
    return (yield* readDirectories).flatMap((entry) => {
      const effective = entry.worktreePath ?? entry.projectRoot;
      return effective !== null && path.resolve(effective) === target ? [entry.threadId] : [];
    });
  });

  const checkouts = readDirectories.pipe(
    Effect.map((entries) => {
      const found = new Set<string>();
      for (const { projectRoot, worktreePath } of entries) {
        if (projectRoot !== null) found.add(path.resolve(projectRoot));
        if (worktreePath !== null) found.add(path.resolve(worktreePath));
      }
      return [...found].toSorted();
    }),
    Effect.withSpan("PluginThreadIndex.checkouts"),
  );

  const decisionLookup = Effect.gen(function* () {
    const known = yield* checkouts;
    const sessions = new Map<string, ThreadId | null>();
    for (const { session_id, thread_id } of yield* readClaudeSessions()) {
      sessions.set(
        session_id,
        sessions.has(session_id) ? null : Option.getOrNull(decodeThreadId(thread_id)),
      );
    }
    return {
      checkouts: known,
      threadForClaudeSession: (sessionId: string) =>
        Effect.succeed(sessions.get(sessionId) ?? null),
    };
  }).pipe(Effect.withSpan("PluginThreadIndex.decisionLookup"));

  const mappingCursor = yield* Effect.result(eventStore.latestApplicationSequence);
  const decisionMappingChanges = Stream.unwrap(
    Effect.fromResult(mappingCursor).pipe(
      Effect.map((afterSequence) =>
        eventStore.streamProjectedApplicationEvents({
          afterSequence,
          project: ({ sequence }) => ({ sequence }),
          filter: (stored) => {
            if ("aggregateKind" in stored) {
              return (
                stored.type !== "project.meta-updated" || stored.payload.workspaceRoot !== undefined
              );
            }
            switch (stored.event.type) {
              case "thread.created":
              case "thread.archived":
              case "thread.unarchived":
              case "thread.deleted":
              case "thread.metadata-updated":
              case "thread.provider-switched":
                return true;
              case "provider-thread.updated":
                return stored.event.payload.driver === CLAUDE_DRIVER;
              default:
                return false;
            }
          },
        }),
      ),
    ),
  ).pipe(
    Stream.as(undefined),
    Stream.catchCause((cause) =>
      Stream.fromEffect(
        Effect.logWarning("plugin cards stopped following thread mapping changes", { cause }),
      ).pipe(Stream.drain),
    ),
  );

  const threadForPid = Effect.fn("PluginThreadIndex.threadForPid")(function* (pid: number) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    const environ = yield* fs
      .readFileString(path.join(procRoot, String(pid), "environ"))
      .pipe(Effect.option);
    if (Option.isNone(environ)) return null;
    const raw = parseEnvironThreadId(environ.value);
    return raw === null ? null : yield* liveThreadId(raw);
  });

  const claudeConfigDir = Effect.fnUntraced(function* (instanceId: ProviderInstanceId) {
    const current = yield* settings.getSettings.pipe(Effect.option);
    if (Option.isNone(current)) return null;
    const instance = current.value.providerInstances[instanceId];
    if (instance !== undefined && instance.driver !== CLAUDE_DRIVER) return null;
    const config = decodeClaudeSettings(instance?.config ?? {});
    if (Option.isNone(config)) return null;
    const configured = instance?.environment?.findLast(
      (variable) => variable.name === "CLAUDE_CONFIG_DIR",
    )?.value;
    const configDir =
      typeof configured === "string" ? configured : hostEnvironment.CLAUDE_CONFIG_DIR;
    return yield* resolveClaudeHomePath(
      config.value,
      configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: configDir },
    ).pipe(
      Effect.provideService(HostProcess.HomeDirectory, homeDirectory),
      Effect.provideService(Path.Path, path),
    );
  });

  const claudeTranscript = Effect.fn("PluginThreadIndex.claudeTranscript")(function* (
    threadId: ThreadId,
  ) {
    const known = yield* projection.findThread(threadId).pipe(Effect.option);
    if (Option.isNone(known) || known.value === null) return null;
    // The store reads provider threads only for a target instance.
    const context = yield* projection
      .getThreadProviderContext(threadId, known.value.providerInstanceId)
      .pipe(Effect.option);
    if (Option.isNone(context)) return null;
    const { thread, providerThreads } = context.value;
    const providerThread = providerThreads.find(
      (candidate) => candidate.id === thread.activeProviderThreadId,
    );
    const sessionId = providerThread?.nativeThreadRef?.nativeId;
    if (
      providerThread === undefined ||
      providerThread.driver !== CLAUDE_DRIVER ||
      sessionId == null ||
      !SESSION_ID_PATTERN.test(sessionId)
    ) {
      return null;
    }
    const configDir = yield* claudeConfigDir(providerThread.providerInstanceId);
    if (configDir === null) return null;
    const projectsDir = path.join(configDir, "projects");
    const entries = yield* fs
      .readDirectory(projectsDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const found = yield* Effect.forEach(
      entries,
      (entry) => {
        const candidate = path.join(projectsDir, entry, `${sessionId}.jsonl`);
        return fs.stat(candidate).pipe(
          Effect.map((info) => (info.type === "File" ? [candidate] : [])),
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        );
      },
      { concurrency: 16 },
    );
    const transcripts = found.flat();
    // Two copies of one session cannot be told apart, so neither is quoted.
    return transcripts.length === 1 ? { sessionId, transcriptPath: transcripts[0]! } : null;
  });

  return PluginThreadIndex.of({
    threadForClaudeSession,
    threadsForDir,
    threadForPid,
    claudeTranscript,
    checkouts,
    decisionLookup,
    decisionMappingChanges,
  });
});

export const layer = Layer.effect(PluginThreadIndex, make());
