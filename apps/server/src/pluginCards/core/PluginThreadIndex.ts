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
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStoreV2 from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
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

  const threadForClaudeSession = Effect.fn("PluginThreadIndex.threadForClaudeSession")(function* (
    sessionId: string,
  ) {
    const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT DISTINCT provider_thread.thread_id AS thread_id
      FROM orchestration_v2_projection_provider_threads AS provider_thread
      JOIN orchestration_v2_projection_threads AS thread
        ON thread.thread_id = provider_thread.thread_id
        AND thread.active_provider_thread_id = provider_thread.provider_thread_id
      WHERE provider_thread.driver = ${CLAUDE_DRIVER}
        AND json_extract(provider_thread.payload_json, '$.nativeThreadRef.nativeId') = ${sessionId}
        AND thread.deleted_at IS NULL
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.tapError((cause) =>
        Effect.logWarning("plugin cards could not look up a Claude session", { cause }),
      ),
      Effect.orElseSucceed((): ReadonlyArray<{ readonly thread_id: string }> => []),
    );
    // Forks can share a session id; an ambiguous match maps to no chat.
    if (rows.length !== 1) return null;
    return Option.getOrNull(decodeThreadId(rows[0]!.thread_id));
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

  const checkouts = Effect.gen(function* () {
    const directories = new Set<string>();
    for (const entry of yield* readDirectories) {
      if (entry.projectRoot !== null) directories.add(path.resolve(entry.projectRoot));
      if (entry.worktreePath !== null) directories.add(path.resolve(entry.worktreePath));
    }
    return [...directories].toSorted();
  }).pipe(Effect.withSpan("PluginThreadIndex.checkouts"));

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
    const context = yield* projection.getThreadProviderContext(threadId).pipe(Effect.option);
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
  });
});

export const layer = Layer.effect(PluginThreadIndex, make());
