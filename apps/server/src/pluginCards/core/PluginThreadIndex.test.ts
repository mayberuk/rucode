import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type OrchestrationProjectShell,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStoreV2 from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as PluginThreadIndex from "./PluginThreadIndex.ts";

const LIVE_THREAD = ThreadId.make("thread-live");
const DELETED_THREAD = ThreadId.make("thread-deleted");
const PROJECT = ProjectId.make("project-1");
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const SESSION = "0b7c2a1e-5f3d-4c1a-9e8b-1d2f3a4b5c6d";

// Fixtures carry only the fields the index reads.
const appThread = (id: ThreadId, deletedAt: DateTime.Utc | null) =>
  ({ id, deletedAt }) as unknown as OrchestrationV2AppThread;
const shellThread = (id: string, worktreePath: string | null) =>
  ({
    id: ThreadId.make(id),
    projectId: PROJECT,
    worktreePath,
  }) as unknown as OrchestrationV2ThreadShell;

interface Fixture {
  readonly activeThreads?: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly providerThread?: {
    readonly driver: ProviderDriverKind;
    readonly instanceId: string;
    readonly sessionId: string;
  };
  /** Under the test's temp root. */
  readonly claudeHomePath?: string;
}

const withIndex = <A, E>(
  fixture: Fixture,
  body: (
    index: PluginThreadIndex.PluginThreadIndex["Service"],
    root: string,
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-thread-index-" });
    const activeProviderThreadId = ProviderThreadId.make("provider-thread-1");
    const projection = Layer.mock(ProjectionStoreV2.ProjectionStoreV2)({
      findThread: (threadId) =>
        Effect.succeed(
          threadId === LIVE_THREAD
            ? appThread(LIVE_THREAD, null)
            : threadId === DELETED_THREAD
              ? appThread(DELETED_THREAD, DateTime.makeUnsafe(0))
              : null,
        ),
      getShellSnapshot: (options) =>
        Effect.succeed({
          schemaVersion: 1,
          snapshotSequence: 0,
          threads: options?.location === "active" ? (fixture.activeThreads ?? []) : [],
          archivedThreads: [],
        }),
      getThreadProviderContext: (threadId) =>
        Effect.succeed({
          thread: { id: threadId, activeProviderThreadId } as unknown as OrchestrationV2AppThread,
          providerSessions: [],
          providerThreads:
            fixture.providerThread === undefined
              ? []
              : [
                  {
                    id: activeProviderThreadId,
                    driver: fixture.providerThread.driver,
                    providerInstanceId: ProviderInstanceId.make(fixture.providerThread.instanceId),
                    nativeThreadRef: {
                      driver: fixture.providerThread.driver,
                      nativeId: fixture.providerThread.sessionId,
                      strength: "strong",
                    },
                  } as unknown as ProjectionStoreV2.ProjectionThreadProviderContext["providerThreads"][number],
                ],
        }),
    });
    const projects = Layer.mock(ProjectStore.ProjectStoreV2)({
      listShells: () =>
        Effect.succeed([
          { id: PROJECT, workspaceRoot: `${root}/repo` } as unknown as OrchestrationProjectShell,
        ]),
    });
    const settings = Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances:
          fixture.claudeHomePath === undefined
            ? {}
            : {
                [ProviderInstanceId.make("claude-work")]: {
                  driver: CLAUDE,
                  config: { homePath: `${root}/${fixture.claudeHomePath}` },
                },
              },
      }),
    });
    const index = yield* PluginThreadIndex.make({ procRoot: `${root}/proc` }).pipe(
      Effect.provide(Layer.mergeAll(projection, projects, settings)),
      Effect.provideService(HostProcess.Environment, {}),
      Effect.provideService(HostProcess.HomeDirectory, `${root}/home`),
    );
    return yield* body(index, root);
  }).pipe(
    Effect.provide(Layer.merge(NodeServices.layer, Layer.fresh(SqlitePersistence.layerMemory))),
  );

const writeEnviron = (root: string, pid: number, environ: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${root}/proc/${pid}`, { recursive: true });
    yield* fs.writeFileString(`${root}/proc/${pid}/environ`, environ);
  });

it.effect("maps a pid to the existing thread its environment names", () =>
  withIndex({}, (index, root) =>
    Effect.gen(function* () {
      yield* writeEnviron(root, 4242, `PATH=/bin\0T3CODE_THREAD_ID=${LIVE_THREAD}\0HOME=/h\0`);
      assert.strictEqual(yield* index.threadForPid(4242), LIVE_THREAD);
    }),
  ),
);

it.effect.each([
  { case: "no proc entry for the pid", pid: 7, environ: null },
  { case: "no thread variable", pid: 8, environ: "PATH=/bin\0HOME=/h\0" },
  { case: "an empty thread variable", pid: 9, environ: "T3CODE_THREAD_ID=\0" },
  { case: "a thread that does not exist", pid: 10, environ: "T3CODE_THREAD_ID=thread-gone\0" },
  { case: "a deleted thread", pid: 11, environ: `T3CODE_THREAD_ID=${DELETED_THREAD}\0` },
  {
    case: "a variable that only ends in the thread name",
    pid: 12,
    environ: `X_T3CODE_THREAD_ID=${LIVE_THREAD}\0`,
  },
  { case: "pid zero", pid: 0, environ: `T3CODE_THREAD_ID=${LIVE_THREAD}\0` },
  { case: "a negative pid", pid: -4242, environ: null },
  { case: "a fractional pid", pid: 1.5, environ: null },
])("maps no thread for $case", ({ pid, environ }) =>
  withIndex({}, (index, root) =>
    Effect.gen(function* () {
      if (environ !== null) yield* writeEnviron(root, pid, environ);
      // A real entry beside the probed one shows the lookup reads only the pid it was given.
      yield* writeEnviron(root, 4242, `T3CODE_THREAD_ID=${LIVE_THREAD}\0`);
      assert.isNull(yield* index.threadForPid(pid));
    }),
  ),
);

it.effect("maps no thread when the proc root is absent", () =>
  withIndex({}, (index) =>
    Effect.gen(function* () {
      assert.isNull(yield* index.threadForPid(4242));
    }),
  ),
);

const writeTranscript = (configDir: string, project: string, sessionId: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${configDir}/projects/${project}`, { recursive: true });
    yield* fs.writeFileString(`${configDir}/projects/${project}/${sessionId}.jsonl`, "{}\n");
  });

it.effect("finds the thread's Claude transcript in its instance's config directory", () =>
  withIndex(
    {
      providerThread: { driver: CLAUDE, instanceId: "claude-work", sessionId: SESSION },
      claudeHomePath: "claude-work-home",
    },
    (index, root) =>
      Effect.gen(function* () {
        yield* writeTranscript(`${root}/claude-work-home`, "-home-me-repo", SESSION);
        yield* writeTranscript(`${root}/claude-work-home`, "-home-me-other", "another-session");
        // The default directory is not this instance's, so its copy is not a second match.
        yield* writeTranscript(`${root}/home/.claude`, "-home-me-repo", SESSION);
        assert.deepStrictEqual(yield* index.claudeTranscript(LIVE_THREAD), {
          sessionId: SESSION,
          transcriptPath: `${root}/claude-work-home/projects/-home-me-repo/${SESSION}.jsonl`,
        });
      }),
  ),
);

it.effect("reads the default Claude instance from ~/.claude", () =>
  withIndex(
    { providerThread: { driver: CLAUDE, instanceId: "claudeAgent", sessionId: SESSION } },
    (index, root) =>
      Effect.gen(function* () {
        yield* writeTranscript(`${root}/home/.claude`, "-repo", SESSION);
        assert.deepStrictEqual(yield* index.claudeTranscript(LIVE_THREAD), {
          sessionId: SESSION,
          transcriptPath: `${root}/home/.claude/projects/-repo/${SESSION}.jsonl`,
        });
      }),
  ),
);

it.effect.each([
  {
    case: "the session's transcript is not there",
    providerThread: { driver: CLAUDE, instanceId: "claudeAgent", sessionId: SESSION },
    transcripts: ["-repo/other-session"],
  },
  {
    case: "two project folders hold the session",
    providerThread: { driver: CLAUDE, instanceId: "claudeAgent", sessionId: SESSION },
    transcripts: [`-repo/${SESSION}`, `-repo-copy/${SESSION}`],
  },
  {
    case: "the chat runs on another provider",
    providerThread: {
      driver: ProviderDriverKind.make("codex"),
      instanceId: "codex",
      sessionId: SESSION,
    },
    transcripts: [`-repo/${SESSION}`],
  },
  {
    case: "the session id would leave the projects folder",
    providerThread: { driver: CLAUDE, instanceId: "claudeAgent", sessionId: "../escape" },
    transcripts: [`-repo/${SESSION}`],
  },
  { case: "the chat has no provider thread", providerThread: undefined, transcripts: [] },
])("finds no transcript when $case", ({ providerThread, transcripts }) =>
  withIndex(providerThread === undefined ? {} : { providerThread }, (index, root) =>
    Effect.gen(function* () {
      for (const transcript of transcripts) {
        const [project, sessionId] = transcript.split("/");
        yield* writeTranscript(`${root}/home/.claude`, project!, sessionId!);
      }
      assert.isNull(yield* index.claudeTranscript(LIVE_THREAD));
    }),
  ),
);

it.effect("lists every active thread whose working directory is the directory", () =>
  withIndex(
    {
      activeThreads: [
        shellThread("in-root-a", null),
        shellThread("in-root-b", null),
        shellThread("in-worktree", "/work/trees/feature"),
        shellThread("other-worktree", "/work/trees/other"),
      ],
    },
    (index, root) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* index.threadsForDir(`${root}/repo`), [
          ThreadId.make("in-root-a"),
          ThreadId.make("in-root-b"),
        ]);
        assert.deepStrictEqual(yield* index.threadsForDir("/work/trees/feature/"), [
          ThreadId.make("in-worktree"),
        ]);
        assert.deepStrictEqual(yield* index.threadsForDir("/work/trees"), []);
        assert.deepStrictEqual(
          yield* index.checkouts,
          [`${root}/repo`, "/work/trees/feature", "/work/trees/other"].toSorted(),
        );
      }),
  ),
);

it.effect("maps a Claude session id to the thread whose active session it is", () =>
  withIndex({}, (index) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const insertThread = (threadId: string, active: string, deleted: boolean) => sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          active_provider_thread_id, created_at, updated_at, deleted_at, payload_json
        ) VALUES (
          ${threadId}, 'project-1', 'Title', 'claudeAgent', 'full-access', 'default',
          ${active}, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
          ${deleted ? "2026-01-02T00:00:00Z" : null}, '{}'
        )
      `;
      const insertProviderThread = (
        providerThreadId: string,
        threadId: string,
        instance: string,
        driver: string,
        sessionId: string,
      ) => sql`
        INSERT INTO orchestration_v2_projection_provider_threads (
          provider_thread_id, thread_id, provider, driver, provider_instance_id, status,
          updated_at, payload_json
        ) VALUES (
          ${providerThreadId}, ${threadId}, ${instance}, ${driver}, ${instance}, 'idle',
          '2026-01-01T00:00:00Z',
          ${JSON.stringify({ nativeThreadRef: { driver, nativeId: sessionId, strength: "strong" } })}
        )
      `;
      // The provider column holds the instance id; only the driver column says Claude.
      yield* insertThread("thread-a", "pt-a", false);
      yield* insertProviderThread("pt-a", "thread-a", "claude-work", "claudeAgent", "session-a");
      // A session the thread moved away from no longer maps to it.
      yield* insertThread("thread-b", "pt-b2", false);
      yield* insertProviderThread("pt-b1", "thread-b", "claudeAgent", "claudeAgent", "session-b");
      yield* insertProviderThread("pt-b2", "thread-b", "claudeAgent", "claudeAgent", "session-b2");
      yield* insertThread("thread-c", "pt-c", true);
      yield* insertProviderThread("pt-c", "thread-c", "claudeAgent", "claudeAgent", "session-c");
      yield* insertThread("thread-d", "pt-d", false);
      yield* insertProviderThread("pt-d", "thread-d", "codex", "codex", "session-d");
      // Two live threads on one session cannot be told apart.
      yield* insertThread("thread-e1", "pt-e1", false);
      yield* insertProviderThread("pt-e1", "thread-e1", "claudeAgent", "claudeAgent", "session-e");
      yield* insertThread("thread-e2", "pt-e2", false);
      yield* insertProviderThread("pt-e2", "thread-e2", "claudeAgent", "claudeAgent", "session-e");

      assert.strictEqual(
        yield* index.threadForClaudeSession("session-a"),
        ThreadId.make("thread-a"),
      );
      assert.strictEqual(
        yield* index.threadForClaudeSession("session-b2"),
        ThreadId.make("thread-b"),
      );
      assert.isNull(yield* index.threadForClaudeSession("session-b"));
      assert.isNull(yield* index.threadForClaudeSession("session-c"));
      assert.isNull(yield* index.threadForClaudeSession("session-d"));
      assert.isNull(yield* index.threadForClaudeSession("session-e"));
      assert.isNull(yield* index.threadForClaudeSession("session-unknown"));
    }),
  ),
);
