// @effect-diagnostics globalDate:off -- Codex names session directories by the host's local date.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  defaultInstanceIdForDriver,
  EventId,
  isListedThreadLineage,
  isProviderNativeSubagentThread,
  NodeId,
  type OrchestrationProjectShell,
  ProjectId,
  ProviderDriverKind,
  ProviderThreadId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { codexRunThreadId } from "@t3tools/shared/codexExecRun";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { importedThreadRows } from "../project/AgentSessionImporter.ts";
import * as CodexSessionSync from "./CodexSessionSync.ts";

const PARENT = ThreadId.make("thread:parent");
const PROJECT = ProjectId.make("project-acme");
const CODEX_INSTANCE = defaultInstanceIdForDriver(ProviderDriverKind.make("codex"));
const STARTED_AT = "2026-11-20T10:00:00.000Z";
const STARTED_MS = Date.parse(STARTED_AT);
const AT = "2026-11-20T10:00:05.000Z";
const LATER = "2026-11-20T10:00:09.000Z";

const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestration = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "codex-session-sync" },
    ProviderAdapterRegistry.layerFromAdapters([]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const record = (type: string, payload: unknown, timestamp = AT) => ({ type, timestamp, payload });
const sessionMeta = (id: string, cwd: string, startedAt = STARTED_AT) =>
  record("session_meta", {
    id,
    cwd,
    timestamp: startedAt,
    originator: "codex_exec",
    base_instructions: "Be brief.",
  });
const turnContext = (model: string) => record("turn_context", { model });
const item = (type: string, id: string, fields: Record<string, unknown>, timestamp = AT) =>
  record("event_msg", { type: "item_completed", item: { type, id, ...fields } }, timestamp);
const user = (id: string, text: string) => item("UserMessage", id, { content: [{ text }] });
const assistant = (id: string, text: string, timestamp = AT) =>
  item("AgentMessage", id, { content: [{ text }] }, timestamp);
const reasoning = (id: string, text: string) => item("Reasoning", id, { summary_text: [text] });
const shellCommand = (id: string, command: string, output: string, exitCode: number) =>
  item("CommandExecution", id, {
    command: ["/bin/sh", "-lc", command],
    parsed_cmd: [{ cmd: command }],
    aggregated_output: output,
    exit_code: exitCode,
    status: "completed",
  });
const fileChange = (id: string, paths: ReadonlyArray<string>) =>
  item("FileChange", id, { changes: Object.fromEntries(paths.map((path) => [path, {}])) });
const taskComplete = record("event_msg", { type: "task_complete" });
const lines = (...records: ReadonlyArray<unknown>) =>
  records.map((value) => `${JSON.stringify(value)}\n`).join("");

const localDay = (ms: number) => {
  const date = new Date(ms);
  return [
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ];
};

type Started = {
  readonly sync: CodexSessionSync.CodexSessionSync["Service"];
  readonly scope: Scope.Closeable;
};

interface Fixture {
  readonly repo: string;
  readonly other: string;
  readonly stateFile: string;
  readonly start: Effect.Effect<Started>;
  readonly writeRollout: (name: string, contents: string) => Effect.Effect<string>;
  readonly appendRollout: (filePath: string, contents: string) => Effect.Effect<void>;
  readonly writeFile: (filePath: string, contents: string) => Effect.Effect<void>;
  /** Raises a file-system change event; real ones arrive on wall-clock time. */
  readonly touch: (filePath: string) => Effect.Effect<void>;
  /** How many times a Codex sessions directory has been listed. */
  readonly sessionListings: () => number;
}

const withFixture = <A, E, R>(body: (fixture: Fixture) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-session-sync-" });
    const home = path.join(root, "home");
    const repo = path.join(root, "work", "acme-app");
    const other = path.join(root, "work", "other");
    const sessionsRoot = path.join(home, ".codex", "sessions");
    const dayDir = path.join(sessionsRoot, ...localDay(STARTED_MS));
    yield* fs.makeDirectory(repo, { recursive: true });
    yield* fs.makeDirectory(other, { recursive: true });
    yield* fs.makeDirectory(dayDir, { recursive: true });

    const fileEvents = yield* PubSub.unbounded<FileSystem.WatchEvent>();
    let sessionListings = 0;
    const watching = FileSystem.FileSystem.of({
      ...fs,
      readDirectory: (directory, options) => {
        if (directory.startsWith(sessionsRoot)) sessionListings++;
        return fs.readDirectory(directory, options);
      },
      watch: (watched, watchOptions) =>
        watched.endsWith(".jsonl")
          ? Stream.fromPubSub(fileEvents).pipe(Stream.filter((event) => event.path === watched))
          : fs.watch(watched, watchOptions),
    });
    const config = yield* ProviderReplayHarness.makeReplayServerConfig("codex-session-sync");
    const projects = Layer.mock(ProjectStore.ProjectStoreV2)({
      getShell: () =>
        Effect.succeedSome({
          id: PROJECT,
          workspaceRoot: repo,
        } as unknown as OrchestrationProjectShell),
    });
    const syncLayer = CodexSessionSync.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(FileSystem.FileSystem, watching),
          Layer.succeed(ServerConfig.ServerConfig, config),
          projects,
        ),
      ),
    );
    const context = yield* Effect.context<
      EventSink.EventSinkV2 | Path.Path | ProjectionStore.ProjectionStoreV2
    >();
    const start = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const built = yield* Layer.buildWithScope(syncLayer, scope).pipe(
        Effect.provideContext(context),
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(HostProcess.Environment, {}),
        Effect.orDie,
      );
      return { sync: Context.get(built, CodexSessionSync.CodexSessionSync), scope };
    });
    const writeFile = (filePath: string, contents: string) =>
      fs.writeFileString(filePath, contents).pipe(Effect.orDie);
    return yield* body({
      repo,
      other,
      stateFile: path.join(config.stateDir, "codex-sessions.json"),
      start,
      writeRollout: (name, contents) =>
        writeFile(path.join(dayDir, name), contents).pipe(Effect.as(path.join(dayDir, name))),
      appendRollout: (filePath, contents) =>
        fs.readFileString(filePath).pipe(
          Effect.orDie,
          Effect.flatMap((existing) => writeFile(filePath, existing + contents)),
        ),
      writeFile,
      touch: (filePath) => {
        const changed: FileSystem.WatchEvent = { _tag: "Update", path: filePath };
        return PubSub.publish(fileEvents, changed).pipe(Effect.asVoid);
      },
      sessionListings: () => sessionListings,
    });
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(layerOrchestration, NodeServices.layer)));

const writeParent = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const at = DateTime.makeUnsafe(STARTED_AT);
  const { appThread } = importedThreadRows({
    threadId: PARENT,
    projectId: PROJECT,
    title: "Tidy the docs",
    providerInstanceId: CODEX_INSTANCE,
    driver: ProviderDriverKind.make("codex"),
    model: "model-parent",
    runtimeMode: "full-access",
    worktree: null,
    providerThreadId: ProviderThreadId.make("provider-thread:parent"),
    nativeThreadId: "native-parent",
    createdAt: at,
    updatedAt: at,
    settled: false,
  });
  yield* sink.write({
    events: [
      {
        id: EventId.make("event:parent:created"),
        type: "thread.created",
        threadId: PARENT,
        providerInstanceId: CODEX_INSTANCE,
        occurredAt: at,
        payload: appThread,
      },
    ],
  });
});

let commandEvents = 0;
/** A Bash command item on the parent thread, as a provider adapter writes it. */
const emitCommand = (itemId: string, input: string, status: "running" | "completed" = "running") =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const startedAt = DateTime.makeUnsafe(STARTED_AT);
    commandEvents++;
    yield* sink.write({
      events: [
        {
          id: EventId.make(`event:command:${itemId}:${commandEvents}`),
          type: "turn-item.updated",
          threadId: PARENT,
          occurredAt: startedAt,
          payload: {
            id: TurnItemId.make(itemId),
            threadId: PARENT,
            runId: null,
            nodeId: NodeId.make(`node:${itemId}`),
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status,
            title: null,
            startedAt,
            completedAt: null,
            updatedAt: startedAt,
            type: "command_execution",
            input,
          },
        },
      ],
    });
  });

const childOf = (itemId: string) => codexRunThreadId(PARENT, TurnItemId.make(itemId));

/** The child's items in timeline order, reduced to what the transcript shows. */
const childItems = (childThreadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const { turnItems } = yield* store.getThreadRecords(childThreadId, ["turnItems"]);
    return turnItems
      .toSorted((left, right) => left.ordinal - right.ordinal)
      .map((entry) => {
        switch (entry.type) {
          case "user_message":
          case "assistant_message":
          case "reasoning":
            return [entry.type, entry.text];
          case "command_execution":
            return [
              entry.type,
              entry.input,
              entry.output ?? null,
              entry.exitCode ?? null,
              entry.status,
              entry.outputIndicatesFailure ?? false,
            ];
          case "file_change":
            return [entry.type, entry.fileName, (entry.changes ?? []).map((change) => change.path)];
          default:
            return [entry.type];
        }
      });
  });

const childMessages = (childThreadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const { messages } = yield* store.getThreadRecords(childThreadId, ["messages"]);
    return messages.map((message) => [message.role, message.text]);
  });

const rootNode = (childThreadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const { nodes } = yield* store.getThreadRecords(childThreadId, ["nodes"]);
    assert.lengthOf(nodes, 1);
    return nodes[0]!;
  });

const findThread = (threadId: ThreadId) =>
  Effect.flatMap(ProjectionStore.ProjectionStoreV2, (store) => store.findThread(threadId));

const savedRun = (fixture: Fixture, childThreadId: ThreadId) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const contents = yield* fs.readFileString(fixture.stateFile).pipe(Effect.option);
    if (Option.isNone(contents)) return undefined;
    const parsed = JSON.parse(contents.value) as {
      readonly runs: Record<string, { readonly [field: string]: unknown }>;
    };
    return parsed.runs[childThreadId];
  });

/** Advances the clock in the 2-second retry steps, letting each retry finish its file reads. */
const advanceSeconds = (sync: Started["sync"], seconds: number) =>
  Effect.gen(function* () {
    for (let elapsed = 0; elapsed < seconds; elapsed += 2) {
      yield* TestClock.adjust("2 seconds");
      yield* sync.drain;
    }
  });

describe("CodexSessionSync", () => {
  it.effect("adopts the matching rollout as a read-only Codex child and streams it", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(STARTED_MS);
        yield* writeParent;
        const rollout = yield* fixture.writeRollout(
          "rollout-2026-11-20T10-00-01-one.jsonl",
          lines(
            sessionMeta("session-one", fixture.repo, "2026-11-20T10:00:01.000Z"),
            turnContext("model-codex"),
            user("u1", "reply ok"),
            reasoning("r1", "Read the request"),
          ),
        );
        const { sync } = yield* fixture.start;
        yield* emitCommand("item-1", `codex exec "reply ok"`);
        yield* sync.drain;

        const childId = childOf("item-1");
        assert.equal(childId, ThreadId.make(`codex-run:${PARENT}:item-1`));
        const child = yield* findThread(childId);
        assert.isNotNull(child);
        assert.isTrue(isProviderNativeSubagentThread(child!));
        assert.isFalse(isListedThreadLineage(child!.lineage));
        assert.deepEqual(child!.lineage, {
          parentThreadId: PARENT,
          relationshipToParent: "subagent",
          rootThreadId: PARENT,
        });
        assert.equal(child!.creationSource, "provider");
        assert.equal(child!.providerInstanceId, CODEX_INSTANCE);
        assert.deepEqual(child!.modelSelection, {
          instanceId: CODEX_INSTANCE,
          model: "model-codex",
        });
        assert.isNull(child!.activeProviderThreadId);
        assert.equal(child!.title, "reply ok");
        assert.deepEqual(child!.forkedFrom, { type: "node", nodeId: NodeId.make("node:item-1") });
        assert.equal((yield* rootNode(childId)).status, "running");
        assert.deepEqual(yield* childItems(childId), [
          ["user_message", "reply ok"],
          ["reasoning", "Read the request"],
        ]);

        yield* fixture.appendRollout(
          rollout,
          lines(
            shellCommand("c1", "list files", "one.txt\n", 0),
            shellCommand("c2", "run checks", "error\n", 2),
            fileChange("f1", ["/work/acme-app/one.txt", "/work/acme-app/two.txt"]),
          ) + JSON.stringify(assistant("a1", "Done.")),
        );
        yield* fixture.touch(rollout);
        yield* sync.drain;
        const streamed = [
          ["user_message", "reply ok"],
          ["reasoning", "Read the request"],
          ["command_execution", "list files", "one.txt\n", 0, "completed", false],
          ["command_execution", "run checks", "error\n", 2, "failed", true],
          [
            "file_change",
            "/work/acme-app/one.txt",
            ["/work/acme-app/one.txt", "/work/acme-app/two.txt"],
          ],
        ];
        // The assistant line has no newline yet, so it is not complete.
        assert.deepEqual(yield* childItems(childId), streamed);

        yield* fixture.appendRollout(rollout, "\n");
        yield* fixture.touch(rollout);
        yield* sync.drain;
        yield* fixture.touch(rollout);
        yield* sync.drain;
        assert.deepEqual(yield* childItems(childId), [...streamed, ["assistant_message", "Done."]]);
        assert.deepEqual(yield* childMessages(childId), [
          ["user", "reply ok"],
          ["assistant", "Done."],
        ]);

        const fs = yield* FileSystem.FileSystem;
        const full = yield* fs.readFileString(rollout);
        yield* fixture.writeFile(rollout, "");
        yield* fixture.touch(rollout);
        yield* sync.drain;
        yield* fixture.writeFile(rollout, full + lines(assistant("a2", "Rewritten.")));
        yield* fixture.touch(rollout);
        yield* sync.drain;
        assert.deepEqual(yield* childItems(childId), [
          ...streamed,
          ["assistant_message", "Done."],
          ["assistant_message", "Rewritten."],
        ]);
      }),
    ),
  );

  it.effect("streams two concurrent runs in one folder into the child whose prompt matches", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(STARTED_MS);
        yield* writeParent;
        const path = yield* Path.Path;
        yield* fixture.writeFile(path.join(fixture.repo, "prompt.md"), "list the files\n");
        const replyRollout = yield* fixture.writeRollout(
          "rollout-2026-11-20T10-00-01-a.jsonl",
          lines(
            sessionMeta("session-reply", fixture.repo, "2026-11-20T10:00:01.000Z"),
            user("u1", "reply ok"),
          ),
        );
        const listRollout = yield* fixture.writeRollout(
          "rollout-2026-11-20T10-00-02-b.jsonl",
          lines(
            sessionMeta("session-list", fixture.repo, "2026-11-20T10:00:02.000Z"),
            user("u1", "list the files"),
          ),
        );
        const { sync } = yield* fixture.start;
        yield* emitCommand("item-list", "codex exec - < prompt.md");
        yield* emitCommand("item-reply", `codex exec 'reply ok'`);
        yield* sync.drain;

        yield* fixture.appendRollout(listRollout, lines(assistant("a1", "Two files.")));
        yield* fixture.appendRollout(replyRollout, lines(assistant("a1", "ok")));
        yield* fixture.touch(listRollout);
        yield* fixture.touch(replyRollout);
        yield* sync.drain;
        assert.deepEqual(yield* childItems(childOf("item-list")), [
          ["user_message", "list the files"],
          ["assistant_message", "Two files."],
        ]);
        assert.deepEqual(yield* childItems(childOf("item-reply")), [
          ["user_message", "reply ok"],
          ["assistant_message", "ok"],
        ]);
      }),
    ),
  );

  it.effect("records a run with no rollout in its folder as unmatched after 120 seconds", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(STARTED_MS);
        yield* writeParent;
        yield* fixture.writeRollout(
          "rollout-2026-11-20T10-00-01-other.jsonl",
          lines(
            sessionMeta("session-other", fixture.other, "2026-11-20T10:00:01.000Z"),
            user("u1", "reply ok"),
          ),
        );
        const first = yield* fixture.start;
        yield* emitCommand("item-1", `codex exec "reply ok"`);
        yield* first.sync.drain;
        const childId = childOf("item-1");

        yield* advanceSeconds(first.sync, 118);
        assert.isUndefined(yield* savedRun(fixture, childId));
        yield* advanceSeconds(first.sync, 2);
        assert.deepEqual(yield* savedRun(fixture, childId), {
          filePath: null,
          inode: -1,
          offset: 0,
          state: "unmatched",
          parentThreadId: PARENT,
        });
        assert.isNull(yield* findThread(childId));

        yield* Scope.close(first.scope, Exit.void);
        const second = yield* fixture.start;
        const listings = fixture.sessionListings();
        yield* emitCommand("item-1", `codex exec "reply ok"`, "completed");
        yield* second.sync.drain;
        yield* advanceSeconds(second.sync, 4);
        assert.equal(fixture.sessionListings(), listings);
        assert.isNull(yield* findThread(childId));
      }),
    ),
  );

  it.effect("keeps searching and adopts a rollout that appears within the window", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(STARTED_MS);
        yield* writeParent;
        const { sync } = yield* fixture.start;
        yield* emitCommand("item-1", `codex exec -C ../other "reply ok"`);
        yield* sync.drain;
        yield* advanceSeconds(sync, 100);
        assert.isNull(yield* findThread(childOf("item-1")));

        yield* fixture.writeRollout(
          "rollout-2026-11-20T10-01-40-late.jsonl",
          lines(
            sessionMeta("session-late", fixture.other, "2026-11-20T10:01:40.000Z"),
            user("u1", "reply ok"),
          ),
        );
        yield* advanceSeconds(sync, 2);
        assert.deepEqual(yield* childItems(childOf("item-1")), [["user_message", "reply ok"]]);
      }),
    ),
  );

  it.effect("never searches for an --ephemeral run", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(STARTED_MS);
        yield* writeParent;
        yield* fixture.writeRollout(
          "rollout-2026-11-20T10-00-01-one.jsonl",
          lines(
            sessionMeta("session-one", fixture.repo, "2026-11-20T10:00:01.000Z"),
            user("u1", "reply ok"),
          ),
        );
        const { sync } = yield* fixture.start;
        yield* emitCommand("item-1", `codex exec --ephemeral "reply ok"`);
        yield* sync.drain;
        yield* advanceSeconds(sync, 4);
        assert.equal(fixture.sessionListings(), 0);
        assert.isNull(yield* findThread(childOf("item-1")));
      }),
    ),
  );

  it.effect("completes the child's root node on task_complete and stops watching", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(STARTED_MS);
        yield* writeParent;
        const rollout = yield* fixture.writeRollout(
          "rollout-2026-11-20T10-00-01-one.jsonl",
          lines(
            sessionMeta("session-one", fixture.repo, "2026-11-20T10:00:01.000Z"),
            user("u1", "reply ok"),
          ),
        );
        const { sync } = yield* fixture.start;
        yield* emitCommand("item-1", `codex exec "reply ok"`);
        yield* sync.drain;
        const childId = childOf("item-1");
        assert.equal((yield* rootNode(childId)).status, "running");

        yield* fixture.appendRollout(rollout, lines(assistant("a1", "ok", LATER), taskComplete));
        yield* fixture.touch(rollout);
        yield* sync.drain;
        const node = yield* rootNode(childId);
        assert.equal(node.status, "completed");
        assert.deepEqual(node.completedAt, DateTime.makeUnsafe(LATER));
        assert.equal((yield* savedRun(fixture, childId))?.state, "done");

        yield* fixture.appendRollout(rollout, lines(user("u2", "next prompt")));
        yield* fixture.touch(rollout);
        yield* sync.drain;
        assert.deepEqual(yield* childItems(childId), [
          ["user_message", "reply ok"],
          ["assistant_message", "ok"],
        ]);
      }),
    ),
  );

  it.effect("interrupts a child whose rollout stops growing for 30 minutes", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(STARTED_MS);
        yield* writeParent;
        const rollout = yield* fixture.writeRollout(
          "rollout-2026-11-20T10-00-01-one.jsonl",
          lines(
            sessionMeta("session-one", fixture.repo, "2026-11-20T10:00:01.000Z"),
            user("u1", "reply ok"),
          ),
        );
        const { sync } = yield* fixture.start;
        yield* emitCommand("item-1", `codex exec "reply ok"`);
        yield* sync.drain;
        const childId = childOf("item-1");

        yield* TestClock.adjust("10 minutes");
        yield* fixture.appendRollout(rollout, lines(reasoning("r1", "Still reading")));
        yield* fixture.touch(rollout);
        yield* sync.drain;
        // Thirty minutes after the start, but only twenty after the last growth.
        yield* TestClock.adjust("20 minutes");
        yield* sync.drain;
        assert.equal((yield* rootNode(childId)).status, "running");
        yield* TestClock.adjust("9 minutes");
        yield* sync.drain;
        assert.equal((yield* rootNode(childId)).status, "running");

        yield* TestClock.adjust("1 minute");
        yield* sync.drain;
        assert.equal((yield* rootNode(childId)).status, "interrupted");
        assert.equal((yield* savedRun(fixture, childId))?.state, "done");
        yield* fixture.appendRollout(rollout, lines(assistant("a1", "Too late.")));
        yield* fixture.touch(rollout);
        yield* sync.drain;
        assert.deepEqual(yield* childItems(childId), [
          ["user_message", "reply ok"],
          ["reasoning", "Still reading"],
        ]);
      }),
    ),
  );

  it.effect("resumes from the saved offset after a restart without duplicating items", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(STARTED_MS);
        yield* writeParent;
        const meta = sessionMeta("session-one", fixture.repo, "2026-11-20T10:00:01.000Z");
        const rollout = yield* fixture.writeRollout(
          "rollout-2026-11-20T10-00-01-one.jsonl",
          lines(meta, user("u1", "reply ok")),
        );
        const first = yield* fixture.start;
        yield* emitCommand("item-1", `codex exec "reply ok"`);
        yield* first.sync.drain;
        yield* fixture.appendRollout(rollout, lines(assistant("a1", "First.")));
        yield* fixture.touch(rollout);
        yield* first.sync.drain;
        yield* Scope.close(first.scope, Exit.void);

        // Same length and inode, but a new item id before the cursor: a re-read from byte 0 adds it.
        yield* fixture.writeFile(
          rollout,
          lines(meta, user("u9", "reply ok"), assistant("a1", "First.")) +
            lines(reasoning("r2", "Check again"), assistant("a2", "Second.")),
        );
        const second = yield* fixture.start;
        yield* second.sync.drain;
        const childId = childOf("item-1");
        assert.deepEqual(yield* childItems(childId), [
          ["user_message", "reply ok"],
          ["assistant_message", "First."],
          ["reasoning", "Check again"],
          ["assistant_message", "Second."],
        ]);
        assert.deepEqual(yield* childMessages(childId), [
          ["user", "reply ok"],
          ["assistant", "First."],
          ["assistant", "Second."],
        ]);
      }),
    ),
  );

  it.effect("never recreates or appends to a child the user deleted", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* TestClock.setTime(STARTED_MS);
        yield* writeParent;
        const rollout = yield* fixture.writeRollout(
          "rollout-2026-11-20T10-00-01-one.jsonl",
          lines(
            sessionMeta("session-one", fixture.repo, "2026-11-20T10:00:01.000Z"),
            user("u1", "reply ok"),
          ),
        );
        const first = yield* fixture.start;
        yield* emitCommand("item-1", `codex exec "reply ok"`);
        yield* first.sync.drain;
        const childId = childOf("item-1");
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("delete-child"),
          threadId: childId,
        });

        yield* fixture.appendRollout(rollout, lines(assistant("a1", "ok")));
        yield* fixture.touch(rollout);
        yield* first.sync.drain;
        assert.deepEqual(yield* childItems(childId), [["user_message", "reply ok"]]);
        assert.equal((yield* savedRun(fixture, childId))?.state, "done");

        yield* Scope.close(first.scope, Exit.void);
        yield* fs.remove(fixture.stateFile);
        const second = yield* fixture.start;
        const listings = fixture.sessionListings();
        yield* emitCommand("item-1", `codex exec "reply ok"`, "completed");
        yield* second.sync.drain;
        assert.equal(fixture.sessionListings(), listings);
        assert.isNotNull((yield* findThread(childId))?.deletedAt);
        assert.deepEqual(yield* childItems(childId), [["user_message", "reply ok"]]);
      }),
    ),
  );
});
