import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MessageId,
  type OrchestrationProjectShell,
  type PluginLiveCliSession,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { ExternalSessionHolds } from "../orchestration-v2/ExternalSessionHolds.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import { importedThreadRows } from "../project/AgentSessionImporter.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ClaudeSessionRegistry from "./ClaudeSessionRegistry.ts";
import * as CliSessionSync from "./CliSessionSync.ts";
import { CliSessionsLive } from "./cliSessionsLiveSource.ts";

const SESSION = "0b7c2a1e-5f3d-4c1a-9e8b-1d2f3a4b5c6d";
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CLAUDE_INSTANCE = ProviderInstanceId.make("claudeAgent");
const THREAD = ThreadId.make(`import:claudeAgent:${SESSION}`);
const PROJECT = ProjectId.make("project-repo");

const adapter = {
  instanceId: CLAUDE_INSTANCE,
  driver: CLAUDE,
  getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed: the effect worker is off"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestration = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderSessionRuntime.layer.pipe(Layer.provide(layerDatabase)),
  IdAllocator.layer,
  ProviderReplayHarness.layerWithRegistry(
    { name: "cli-session-sync" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
).pipe(Layer.provideMerge(CliSessionSync.layerHolds));

const claudeModel = (slug: string) => ({ slug, name: slug, isCustom: false, capabilities: null });
const providers = [
  {
    instanceId: CLAUDE_INSTANCE,
    driver: CLAUDE,
    models: [claudeModel("claude-haiku-4-5"), claudeModel("claude-sonnet-4-6")],
  } as unknown as ServerProvider,
];

const record = (type: "user" | "assistant", uuid: string, text: string, model?: string) =>
  `${JSON.stringify(
    type === "user"
      ? {
          type,
          uuid,
          timestamp: "2026-11-20T10:00:00.000Z",
          entrypoint: "cli",
          cwd: "__CWD__",
          origin: { kind: "human" },
          message: { role: "user", content: text },
        }
      : {
          type,
          uuid,
          timestamp: "2026-11-20T10:00:05.000Z",
          entrypoint: "cli",
          cwd: "__CWD__",
          message: {
            role: "assistant",
            ...(model === undefined ? {} : { model }),
            content: [{ type: "text", text }],
          },
        },
  )}\n`;

const attachment = (fields: Partial<ClaudeSessionRegistry.Attachment> = {}) => ({
  sessionId: SESSION,
  pid: 4242,
  owner: "terminal" as const,
  status: "idle" as const,
  name: "repo-work",
  cwd: null,
  tmux: "main:@27.%28",
  pane: { session: "main", pane: "%28" },
  startedAt: 1,
  ...fields,
});

interface Fixture {
  readonly stateDir: string;
  /** The server's home directory; unlike the temp tree, it is outside `/tmp`. */
  readonly home: string;
  readonly repo: string;
  readonly transcript: string;
  readonly attachments: SubscriptionRef.SubscriptionRef<
    ReadonlyMap<string, ClaudeSessionRegistry.Attachment>
  >;
  readonly releases: Array<
    Parameters<ProviderSessionManager.ProviderSessionManagerV2Shape["releaseUnlessBusy"]>[0]
  >;
  /** Starts a sync instance in its own scope; closing the scope stops it, as a restart would. */
  readonly start: Effect.Effect<
    { readonly sync: CliSessionSync.CliSessionSync["Service"]; readonly scope: Scope.Closeable },
    never,
    never
  >;
  readonly write: (contents: string) => Effect.Effect<void>;
  /** Writes another session's transcript, with `__CWD__` set to `cwd`. */
  readonly writeSession: (sessionId: string, cwd: string, contents: string) => Effect.Effect<void>;
  /** Contents served for `/proc/<key>`, such as `200/environ`; every other `/proc` path fails. */
  readonly proc: Map<string, string>;
  readonly addProject: (id: ProjectId, workspaceRoot: string) => void;
  /** Workspace roots passed to `ProjectService.bootstrap`. */
  readonly bootstraps: Array<string>;
  readonly touch: Effect.Effect<void>;
  /** How many times the whole transcript has been loaded. */
  readonly wholeReads: () => number;
}

/**
 * A temp home with `~/.claude/projects/<slug>/<SESSION>.jsonl` and a project at `~/dev/repo`.
 * File-system events are raised by the test (`touch`), since real ones arrive on wall-clock time.
 */
const withFixture = <A, E, R>(
  options: {
    readonly enabled: boolean | null;
    readonly environment?: Readonly<Record<string, string>>;
  },
  body: (fixture: Fixture) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-session-sync-" });
    const home = `${root}/home`;
    const repo = `${home}/dev/repo`;
    const claudeHome = `${home}/.claude`;
    const transcriptDir = `${claudeHome}/projects/-home-dev-repo`;
    const transcript = `${transcriptDir}/${SESSION}.jsonl`;
    // Placement skips anything under /tmp as temporary, so new session cwds live below a home
    // outside it. Nothing is created there; a cwd only names where Claude ran.
    const serverHome = "/nonexistent/home/acme";
    yield* fs.makeDirectory(repo, { recursive: true });
    yield* fs.makeDirectory(transcriptDir, { recursive: true });
    yield* fs.makeDirectory(`${claudeHome}/sessions`, { recursive: true });

    const fileEvents = yield* PubSub.unbounded<FileSystem.WatchEvent>();
    let wholeReads = 0;
    // The suite may run on a machine with these pids, inside a Claude session of its own.
    const proc = new Map<string, string>();
    const watching = FileSystem.FileSystem.of({
      ...fs,
      readFile: (path) => {
        if (path === transcript) wholeReads++;
        return fs.readFile(path);
      },
      readFileString: (path, encoding) => {
        if (!path.startsWith("/proc/")) return fs.readFileString(path, encoding);
        const stubbed = proc.get(path.slice("/proc/".length));
        return stubbed === undefined
          ? fs.readFileString(`${root}/no-proc/${path}`, encoding)
          : Effect.succeed(stubbed);
      },
      watch: (path, watchOptions) =>
        path.endsWith(".jsonl")
          ? Stream.fromPubSub(fileEvents).pipe(Stream.filter((event) => event.path === path))
          : fs.watch(path, watchOptions),
    });
    const attachments = yield* SubscriptionRef.make<
      ReadonlyMap<string, ClaudeSessionRegistry.Attachment>
    >(new Map());
    const registry = ClaudeSessionRegistry.ClaudeSessionRegistry.of({
      attachments,
      entry: () => Effect.succeed(null),
      awaitGone: () => Effect.succeed(true),
      socketOf: () => Effect.succeed("/tmp/tmux-test/default"),
    });
    const releases: Fixture["releases"] = [];
    const realSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const sessions = ProviderSessionManager.ProviderSessionManagerV2.of({
      ...realSessions,
      isLive: () => Effect.succeed(true),
      releaseUnlessBusy: (input) =>
        Effect.gen(function* () {
          releases.push(input);
          return !(yield* input.keepIf ?? Effect.succeed(false));
        }),
    });
    const projectShells = [
      { id: PROJECT, workspaceRoot: repo } as unknown as OrchestrationProjectShell,
    ];
    const bootstraps: Array<string> = [];
    const projects = Layer.mock(ProjectService.ProjectService)({
      listShells: () => Effect.sync(() => [...projectShells]),
      bootstrap: (input) =>
        Effect.sync(() => {
          bootstraps.push(input.workspaceRoot);
          return { project: { id: input.projectId }, created: true } as unknown as Effect.Success<
            ReturnType<ProjectService.ProjectService["Service"]["bootstrap"]>
          >;
        }),
    });
    const config = yield* ProviderReplayHarness.makeReplayServerConfig("cli-session-sync");
    const syncLayer = CliSessionSync.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ClaudeSessionRegistry.ClaudeSessionRegistry, registry),
          Layer.succeed(ProviderSessionManager.ProviderSessionManagerV2, sessions),
          Layer.succeed(FileSystem.FileSystem, watching),
          Layer.succeed(ServerConfig.ServerConfig, config),
          ServerSettings.ServerSettingsService.layerTest({
            claudeTerminalSessions: options.enabled,
          }),
          projects,
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed(providers),
          }),
        ),
      ),
    );
    const context = yield* Effect.context<
      | CliSessionSync.CliSessionHolds
      | EventSink.EventSinkV2
      | IdAllocator.IdAllocatorV2
      | Orchestrator.OrchestratorV2
      | Path.Path
      | ProjectionStore.ProjectionStoreV2
      | ProviderSessionRuntime.ProviderSessionRuntimeRepository
      | SqlClient.SqlClient
    >();
    const start = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const built = yield* Layer.buildWithScope(syncLayer, scope).pipe(
        Effect.provideContext(context),
        Effect.provideService(HostProcess.HomeDirectory, serverHome),
        Effect.provideService(HostProcess.Environment, {
          ...options.environment,
          CLAUDE_CONFIG_DIR: claudeHome,
        }),
        Effect.orDie,
      );
      return { sync: Context.get(built, CliSessionSync.CliSessionSync), scope };
    });
    const write = (contents: string) =>
      fs.writeFileString(transcript, contents.replaceAll("__CWD__", repo)).pipe(Effect.orDie);
    const writeSession = (sessionId: string, cwd: string, contents: string) =>
      Effect.gen(function* () {
        const dir = `${claudeHome}/projects/${cwd.replaceAll("/", "-")}`;
        yield* fs.makeDirectory(dir, { recursive: true });
        yield* fs.writeFileString(`${dir}/${sessionId}.jsonl`, contents.replaceAll("__CWD__", cwd));
      }).pipe(Effect.orDie);
    const changed: FileSystem.WatchEvent = { _tag: "Update", path: transcript };
    const touch = PubSub.publish(fileEvents, changed).pipe(Effect.asVoid);
    return yield* body({
      stateDir: config.stateDir,
      home: serverHome,
      repo,
      transcript,
      attachments,
      releases,
      start,
      write,
      writeSession,
      proc,
      addProject: (id, workspaceRoot) => {
        projectShells.push({ id, workspaceRoot } as unknown as OrchestrationProjectShell);
      },
      bootstraps,
      touch,
      wholeReads: () => wholeReads,
    });
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(layerOrchestration, NodeServices.layer)));

const messages = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return (yield* orchestrator.getThreadRecords(threadId, ["messages"])).messages.map(
      (message) => message.text,
    );
  });

const attach = (fixture: Fixture, fields: Partial<ClaudeSessionRegistry.Attachment> = {}) =>
  SubscriptionRef.set(fixture.attachments, new Map([[SESSION, attachment(fields)]]));

/** Replays the thread's stored events from the start, so it cannot miss one already written. */
const awaitMessage = (threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator
      .streamStoredEventsFrom({ threadId, afterSequence: 0, eventType: "message.updated" })
      .pipe(
        Stream.filter(
          (stored) => stored.event.type === "message.updated" && stored.event.payload.text === text,
        ),
        Stream.runHead,
      );
  });

/** The live list as of the first registry refresh that satisfies `ready`. */
const awaitLive = (ready: (sessions: ReadonlyArray<PluginLiveCliSession>) => boolean) =>
  Effect.gen(function* () {
    const live = yield* CliSessionsLive;
    return yield* live.changes.pipe(
      Stream.mapEffect(() => live.current),
      Stream.filter(ready),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  });

const twoRecords = record("user", "u-1", "Fix the login bug") + record("assistant", "a-1", "Done.");
const fourRecords =
  twoRecords + record("user", "u-2", "Now add a test") + record("assistant", "a-2", "Added.");

it.effect("adopts a terminal session and appends each new record once", () =>
  withFixture({ enabled: true }, (fixture) =>
    Effect.gen(function* () {
      yield* fixture.write(twoRecords);
      yield* attach(fixture);
      const { sync } = yield* fixture.start;
      yield* sync.drain;
      assert.deepEqual(yield* messages(THREAD), ["Fix the login bug", "Done."]);
      const thread = yield* (yield* ProjectionStore.ProjectionStoreV2).findThread(THREAD);
      assert.equal(thread?.projectId, PROJECT);
      assert.equal(thread?.title, "Fix the login bug");
      const importReads = fixture.wholeReads();

      yield* fixture.write(fourRecords);
      yield* fixture.touch;
      yield* awaitMessage(THREAD, "Added.");
      yield* sync.drain;
      yield* fixture.touch;
      yield* sync.drain;
      assert.deepEqual(yield* messages(THREAD), [
        "Fix the login bug",
        "Done.",
        "Now add a test",
        "Added.",
      ]);
      // Tailing reads only what the transcript gained; long sessions reach tens of megabytes.
      assert.equal(fixture.wholeReads(), importReads);
    }),
  ),
);

it.effect("follows the terminal's model when the Claude instance knows it", () =>
  withFixture({ enabled: true }, (fixture) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const model = Effect.map(store.findThread(THREAD), (thread) => thread?.modelSelection);
      let transcript =
        record("user", "u-1", "Fix the login bug") +
        record("assistant", "a-1", "Done.", "claude-haiku-4-5-20251001");
      yield* fixture.write(transcript);
      yield* attach(fixture);
      const { sync } = yield* fixture.start;
      yield* sync.drain;
      assert.deepEqual(yield* model, { instanceId: CLAUDE_INSTANCE, model: "claude-haiku-4-5" });

      const terminalWrites = Effect.fn(function* (uuid: string, text: string, reported: string) {
        transcript += record("assistant", uuid, text, reported);
        yield* fixture.write(transcript);
        yield* fixture.touch;
        yield* awaitMessage(THREAD, text);
        yield* sync.drain;
      });
      yield* terminalWrites("a-2", "Unknown model.", "claude-unreleased-9");
      assert.deepEqual(yield* model, { instanceId: CLAUDE_INSTANCE, model: "claude-haiku-4-5" });
      yield* terminalWrites("a-3", "Switched.", "claude-sonnet-4-6");
      assert.deepEqual(yield* model, { instanceId: CLAUDE_INSTANCE, model: "claude-sonnet-4-6" });
    }),
  ),
);

it.effect("adopts a session with no model the instance knows on the default model", () =>
  withFixture({ enabled: true }, (fixture) =>
    Effect.gen(function* () {
      yield* fixture.write(
        record("user", "u-1", "Fix the login bug") +
          record("assistant", "a-1", "Done.", "claude-unreleased-9"),
      );
      yield* attach(fixture);
      const { sync } = yield* fixture.start;
      yield* sync.drain;
      const thread = yield* (yield* ProjectionStore.ProjectionStoreV2).findThread(THREAD);
      assert.equal(thread?.modelSelection.model, DEFAULT_MODEL_BY_PROVIDER[CLAUDE]);
    }),
  ),
);

it.effect("re-reads without duplicates after a lost cursor or a replaced file", () =>
  withFixture({ enabled: true }, (fixture) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fixture.write(twoRecords);
      yield* attach(fixture);
      const first = yield* fixture.start;
      yield* first.sync.drain;
      yield* Scope.close(first.scope, Exit.void);
      yield* fs.remove(`${fixture.stateDir}/cli-session-sync.json`);

      yield* fixture.write(twoRecords + record("user", "u-2", "Now add a test"));
      const second = yield* fixture.start;
      yield* second.sync.drain;
      assert.deepEqual(yield* messages(THREAD), ["Fix the login bug", "Done.", "Now add a test"]);

      const replacement = `${fixture.transcript}.new`;
      yield* fs.writeFileString(replacement, fourRecords.replaceAll("__CWD__", fixture.repo));
      yield* fs.rename(replacement, fixture.transcript);
      yield* fixture.touch;
      yield* awaitMessage(THREAD, "Added.");
      yield* second.sync.drain;
      assert.deepEqual(yield* messages(THREAD), [
        "Fix the login bug",
        "Done.",
        "Now add a test",
        "Added.",
      ]);
    }),
  ),
);

it.effect("imports a long session as its first prompt, the newest 200 entries and a notice", () =>
  withFixture({ enabled: true }, (fixture) =>
    Effect.gen(function* () {
      const records = Array.from({ length: 210 }, (_, index) =>
        record(index % 2 === 0 ? "user" : "assistant", `r-${index}`, `entry ${index}`),
      );
      yield* fixture.write(records.join(""));
      const { sync } = yield* fixture.start;
      yield* sync.drain;

      const texts = yield* messages(THREAD);
      assert.lengthOf(texts, 201);
      assert.deepEqual([texts[0], texts[1], texts.at(-1)], ["entry 0", "entry 10", "entry 209"]);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const notices = (yield* orchestrator.getThreadRecords(THREAD, [
        "turnItems",
      ])).turnItems.flatMap((item) => (item.type === "system_notice" ? [item.message] : []));
      assert.lengthOf(notices, 1);
      assert.match(notices[0]!, /^9 earlier messages were not imported/);
    }),
  ),
);

it.effect("does not re-adopt or append to a deleted thread", () =>
  withFixture({ enabled: true }, (fixture) =>
    Effect.gen(function* () {
      yield* fixture.write(twoRecords);
      yield* attach(fixture);
      const { sync } = yield* fixture.start;
      yield* sync.drain;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-adopted"),
        threadId: THREAD,
      });

      yield* fixture.write(fourRecords);
      yield* fixture.touch;
      yield* attach(fixture, { status: "busy" });
      yield* awaitLive((sessions) => sessions.length === 0);
      yield* sync.drain;
      const { messages: stored } = yield* orchestrator.getThreadRecords(THREAD, ["messages"]);
      assert.lengthOf(stored, 2);
      const thread = yield* (yield* ProjectionStore.ProjectionStoreV2).findThread(THREAD);
      assert.isNotNull(thread?.deletedAt);
    }),
  ),
);

it.effect("waits for a rucode run to end, then appends terminal records after its items", () =>
  withFixture({ enabled: true }, (fixture) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      yield* fixture.write(twoRecords);
      const { sync } = yield* fixture.start;
      yield* sync.drain;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("send-from-rucode"),
        threadId: THREAD,
        messageId: MessageId.make("message:from-rucode"),
        text: "From RuCode",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });

      yield* fixture.write(fourRecords);
      yield* attach(fixture);
      yield* awaitLive((sessions) => sessions.some((session) => session.threadId === THREAD));
      yield* sync.drain;
      assert.deepEqual(yield* messages(THREAD), ["Fix the login bug", "Done.", "From RuCode"]);

      const [run] = (yield* orchestrator.getThreadRecords(THREAD, ["runs"])).runs;
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:run-complete"),
            type: "run.updated",
            threadId: THREAD,
            runId: run!.id,
            providerInstanceId: run!.providerInstanceId,
            occurredAt: yield* DateTime.now,
            payload: { ...run!, status: "completed" },
          },
        ],
      });
      yield* awaitMessage(THREAD, "Added.");
      yield* sync.drain;
      const { turnItems } = yield* orchestrator.getThreadRecords(THREAD, ["turnItems"]);
      const ordered = turnItems
        .toSorted((left, right) => left.ordinal - right.ordinal)
        .flatMap((item) =>
          item.type === "user_message" || item.type === "assistant_message" ? [item.text] : [],
        );
      assert.deepEqual(ordered, [
        "Fix the login bug",
        "Done.",
        "From RuCode",
        "Now add a test",
        "Added.",
      ]);
    }),
  ),
);

/** A Claude thread rucode runs itself, with a live provider session on `SESSION`. */
const writeRucodeThread = (threadId: ThreadId, pendingBackground: boolean, sessionId = SESSION) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const at = yield* DateTime.now;
    const rows = importedThreadRows({
      threadId,
      projectId: PROJECT,
      title: "Rucode chat",
      providerInstanceId: CLAUDE_INSTANCE,
      driver: CLAUDE,
      model: "claude-haiku-4-5",
      runtimeMode: "full-access",
      worktree: null,
      providerThreadId: (yield* IdAllocator.IdAllocatorV2).derive.providerThread({
        driver: CLAUDE,
        providerInstanceId: CLAUDE_INSTANCE,
        nativeThreadId: sessionId,
      }),
      nativeThreadId: sessionId,
      createdAt: at,
      updatedAt: at,
      settled: false,
    });
    yield* sink.write({
      events: [
        {
          id: EventId.make(`event:${threadId}:created`),
          type: "thread.created",
          threadId,
          providerInstanceId: CLAUDE_INSTANCE,
          occurredAt: at,
          payload: { ...rows.appThread, historyOrigin: "native" },
        },
        {
          id: EventId.make(`event:${threadId}:provider-thread`),
          type: "provider-thread.updated",
          threadId,
          driver: CLAUDE,
          providerInstanceId: CLAUDE_INSTANCE,
          occurredAt: at,
          payload: {
            ...rows.providerThread,
            providerSessionId: ProviderSessionId.make("provider-session-1"),
            pendingBackgroundTasks: pendingBackground
              ? [{ kind: "background_task", taskId: "task-1" }]
              : [],
          },
        },
      ],
    });
  });

const RUCODE_THREAD = ThreadId.make("thread:rucode-claude");

it.effect("releases rucode's own process when a terminal opens the session", () =>
  withFixture({ enabled: true }, (fixture) =>
    Effect.gen(function* () {
      yield* writeRucodeThread(RUCODE_THREAD, false);
      const { sync } = yield* fixture.start;
      yield* sync.drain;
      assert.lengthOf(fixture.releases, 0);

      yield* attach(fixture);
      yield* awaitLive((sessions) => sessions.length === 1);
      yield* sync.drain;
      assert.deepEqual(
        fixture.releases.map((release) => [release.providerSessionId, release.reason]),
        [["provider-session-1", "external_writer"]],
      );
      const live = yield* (yield* CliSessionsLive).current;
      assert.deepEqual(live, [
        {
          threadId: RUCODE_THREAD,
          sessionId: SESSION,
          owner: "terminal",
          status: "idle",
          name: "repo-work",
          inTmux: true,
          backgroundWorkKept: false,
        },
      ]);
    }),
  ),
);

it.effect("keeps rucode's process while background work is pending, and says so once", () =>
  withFixture({ enabled: true }, (fixture) =>
    Effect.gen(function* () {
      yield* writeRucodeThread(RUCODE_THREAD, true);
      yield* attach(fixture);
      const { sync } = yield* fixture.start;
      yield* sync.drain;
      yield* attach(fixture, { status: "busy" });
      yield* awaitLive((sessions) => sessions[0]?.status === "busy");
      yield* sync.drain;

      // Each registry change retries the release; every attempt was kept for the pending work.
      assert.isAtLeast(fixture.releases.length, 2);
      assert.isTrue(fixture.releases.every((release) => release.reason === "external_writer"));
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const notices = (yield* orchestrator.getThreadRecords(RUCODE_THREAD, [
        "turnItems",
      ])).turnItems.flatMap((item) => (item.type === "system_notice" ? [item.message] : []));
      assert.lengthOf(notices, 1);
      assert.match(notices[0]!, /still running background work/);
      const [live] = yield* (yield* CliSessionsLive).current;
      assert.isTrue(live?.backgroundWorkKept);
    }),
  ),
);

it.effect("with sync off, adopts nothing but still refuses a turn on a held session", () =>
  withFixture({ enabled: false }, (fixture) =>
    Effect.gen(function* () {
      const otherSession = "1c8d3b2f-6a4e-4d2b-8f9c-2e3a4b5c6d7e";
      yield* writeRucodeThread(RUCODE_THREAD, false, otherSession);
      yield* fixture.write(twoRecords);
      const holds = yield* ExternalSessionHolds;
      // SESSION has a transcript and would be adopted if sync were on; the other is rucode's own.
      yield* SubscriptionRef.set(
        fixture.attachments,
        new Map([
          [SESSION, attachment()],
          [otherSession, attachment({ sessionId: otherSession, pid: 5151 })],
        ]),
      );
      const { sync } = yield* fixture.start;
      // Waiting on the signal proves a hold change emits it; without one this never resolves.
      yield* (holds.changes ?? Stream.empty).pipe(
        Stream.filter(() => holds.heldBy(RUCODE_THREAD) !== null),
        Stream.runHead,
      );
      yield* sync.drain;
      assert.deepEqual(holds.heldBy(RUCODE_THREAD), { owner: "terminal", name: "repo-work" });
      assert.isNull(yield* (yield* ProjectionStore.ProjectionStoreV2).findThread(THREAD));
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const refused = yield* orchestrator
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("send-held"),
          threadId: RUCODE_THREAD,
          messageId: MessageId.make("message:held"),
          text: "Keep going",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "OrchestratorSessionHeldExternallyError");
    }),
  ),
);

const PARENT_SESSION = "5e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b";
const CHILD_SESSION = "6f2a3b4c-5d6e-4f7a-9b8c-0d1e2f3a4b5c";
const OTHER_SESSION = "7a3b4c5d-6e7f-4a8b-8c9d-1e2f3a4b5c6d";
const sessionThread = (sessionId: string) => ThreadId.make(`import:claudeAgent:${sessionId}`);
const conversation = (prompt: string) =>
  record("user", `u-${prompt}`, prompt) + record("assistant", `a-${prompt}`, "Done.");

/** Gives `pid` the environment a Claude Bash tool exports, and a parent chain up to the launcher. */
const launchedBy = (
  fixture: Fixture,
  pid: number,
  launcher: { readonly sessionId: string; readonly pid: number },
  between: ReadonlyArray<number>,
) => {
  fixture.proc.set(
    `${pid}/environ`,
    `HOME=/home/acme\0CLAUDE_CODE_SESSION_ID=${launcher.sessionId}\0CLAUDE_PID=${launcher.pid}\0`,
  );
  const chain = [pid, ...between, launcher.pid];
  for (let index = 0; index < chain.length - 1; index++) {
    fixture.proc.set(
      `${chain[index]}/stat`,
      `${chain[index]} (claude) S ${chain[index + 1]} 0 0\n`,
    );
  }
};

const attachSessions = (
  fixture: Fixture,
  sessions: ReadonlyArray<{ readonly sessionId: string; readonly pid: number }>,
) =>
  SubscriptionRef.set(
    fixture.attachments,
    new Map(sessions.map(({ sessionId, pid }) => [sessionId, attachment({ sessionId, pid })])),
  );

const findThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    return yield* (yield* ProjectionStore.ProjectionStoreV2).findThread(threadId);
  });

const awaitThreadCreated = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator
      .streamStoredEventsFrom({ threadId, afterSequence: 0, eventType: "thread.created" })
      .pipe(Stream.runHead);
  });

it.effect("nests a session another Claude session started under that session's thread", () =>
  withFixture({ enabled: true }, (fixture) =>
    Effect.gen(function* () {
      const parentThread = sessionThread(PARENT_SESSION);
      yield* fixture.writeSession(PARENT_SESSION, fixture.repo, conversation("Plan the release"));
      yield* attachSessions(fixture, [{ sessionId: PARENT_SESSION, pid: 100 }]);
      const { sync } = yield* fixture.start;
      yield* sync.drain;
      assert.deepEqual((yield* findThread(parentThread))?.lineage, {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: parentThread,
      });

      launchedBy(fixture, 200, { sessionId: PARENT_SESSION, pid: 100 }, [150]);
      launchedBy(fixture, 300, { sessionId: CHILD_SESSION, pid: 200 }, []);
      yield* fixture.writeSession(CHILD_SESSION, fixture.repo, conversation("Write the notes"));
      yield* fixture.writeSession(
        OTHER_SESSION,
        `${fixture.home}/dev/checkout-retries`,
        conversation("Retry the checkout"),
      );
      yield* attachSessions(fixture, [
        { sessionId: PARENT_SESSION, pid: 100 },
        { sessionId: CHILD_SESSION, pid: 200 },
        { sessionId: OTHER_SESSION, pid: 300 },
      ]);
      yield* awaitThreadCreated(sessionThread(OTHER_SESSION));
      yield* sync.drain;

      const nested = {
        parentThreadId: parentThread,
        relationshipToParent: null,
        rootThreadId: parentThread,
      };
      assert.deepEqual((yield* findThread(sessionThread(CHILD_SESSION)))?.lineage, nested);
      const store = yield* ProjectionStore.ProjectionStoreV2;
      assert.deepEqual(
        (yield* store.getThreadShell(sessionThread(CHILD_SESSION)))?.lineage,
        nested,
      );
      // A grandchild joins the family's root, not its direct parent's id.
      assert.deepEqual((yield* findThread(sessionThread(OTHER_SESSION)))?.lineage, {
        parentThreadId: sessionThread(CHILD_SESSION),
        relationshipToParent: null,
        rootThreadId: parentThread,
      });
    }),
  ),
);

it.effect("holds a child back until its parent's thread exists", () =>
  withFixture({ enabled: true }, (fixture) =>
    Effect.gen(function* () {
      const checkout = `${fixture.home}/dev/checkout-retries`;
      launchedBy(fixture, 200, { sessionId: PARENT_SESSION, pid: 100 }, [150]);
      launchedBy(fixture, 210, { sessionId: PARENT_SESSION, pid: 100 }, [150]);
      yield* fixture.writeSession(CHILD_SESSION, checkout, conversation("Retry the checkout"));
      yield* fixture.writeSession(OTHER_SESSION, checkout, conversation("Check the logs"));
      yield* attachSessions(fixture, [
        { sessionId: CHILD_SESSION, pid: 200 },
        { sessionId: OTHER_SESSION, pid: 210 },
      ]);
      const { sync } = yield* fixture.start;
      yield* sync.drain;
      assert.isNull(yield* findThread(sessionThread(CHILD_SESSION)));
      assert.isNull(yield* findThread(sessionThread(OTHER_SESSION)));
      assert.deepEqual(fixture.bootstraps, []);

      // The other child's process ends before its parent has a thread.
      yield* fixture.writeSession(PARENT_SESSION, fixture.repo, conversation("Plan the release"));
      yield* attachSessions(fixture, [
        { sessionId: CHILD_SESSION, pid: 200 },
        { sessionId: PARENT_SESSION, pid: 100 },
      ]);
      yield* awaitThreadCreated(sessionThread(CHILD_SESSION));
      yield* sync.drain;

      const parentThread = sessionThread(PARENT_SESSION);
      assert.isNotNull(yield* findThread(parentThread));
      assert.deepEqual((yield* findThread(sessionThread(CHILD_SESSION)))?.lineage, {
        parentThreadId: parentThread,
        relationshipToParent: null,
        rootThreadId: parentThread,
      });
      assert.isNull(yield* findThread(sessionThread(OTHER_SESSION)));
    }),
  ),
);

it.effect("hides a session in a throwaway checkout without creating a project", () =>
  withFixture({ enabled: true }, (fixture) =>
    Effect.gen(function* () {
      const spike = `${fixture.home}/dev/acme-spike.Qw3rTy`;
      yield* fixture.writeSession(CHILD_SESSION, spike, conversation("Try the spike"));
      yield* attachSessions(fixture, [{ sessionId: CHILD_SESSION, pid: 200 }]);
      const first = yield* fixture.start;
      yield* first.sync.drain;
      assert.isNull(yield* findThread(sessionThread(CHILD_SESSION)));
      assert.deepEqual(fixture.bootstraps, []);
      yield* Scope.close(first.scope, Exit.void);

      const spikeProject = ProjectId.make("project-spike");
      fixture.addProject(spikeProject, spike);
      yield* fixture.writeSession(OTHER_SESSION, spike, conversation("Keep the spike"));
      yield* attachSessions(fixture, [{ sessionId: OTHER_SESSION, pid: 210 }]);
      const second = yield* fixture.start;
      yield* second.sync.drain;
      const kept = yield* findThread(sessionThread(OTHER_SESSION));
      assert.equal(kept?.projectId, spikeProject);
      assert.isNull(kept?.lineage.parentThreadId);
    }),
  ),
);

it.effect("ignores the Claude session the server itself was started from", () =>
  withFixture(
    { enabled: true, environment: { CLAUDE_CODE_SESSION_ID: PARENT_SESSION } },
    (fixture) =>
      Effect.gen(function* () {
        yield* writeRucodeThread(ThreadId.make("thread:server-parent"), false, PARENT_SESSION);
        launchedBy(fixture, 200, { sessionId: PARENT_SESSION, pid: 100 }, [150]);
        yield* fixture.writeSession(CHILD_SESSION, fixture.repo, conversation("Open a terminal"));
        yield* attachSessions(fixture, [{ sessionId: CHILD_SESSION, pid: 200 }]);
        const { sync } = yield* fixture.start;
        yield* sync.drain;
        assert.deepEqual((yield* findThread(sessionThread(CHILD_SESSION)))?.lineage, {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: sessionThread(CHILD_SESSION),
        });
      }),
  ),
);
