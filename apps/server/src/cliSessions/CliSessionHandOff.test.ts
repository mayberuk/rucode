import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CliSessionError,
  DEFAULT_SERVER_SETTINGS,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ClaudeSessionRegistry from "./ClaudeSessionRegistry.ts";
import * as CliSessionHandOff from "./CliSessionHandOff.ts";

const SESSION = "0b7c2a1e-5f3d-4c1a-9e8b-1d2f3a4b5c6d";
const SOCKET = "/tmp/tmux-1000/default";
const CLAUDE_PID = 4242;
const PANE_SHELL_PID = 4100;
const threadId = ThreadId.make("thread-hand-off");
const providerThreadId = ProviderThreadId.make("provider-thread-hand-off");
const providerSessionId = ProviderSessionId.make("provider-session-hand-off");
const claudeDriver = ProviderDriverKind.make("claudeAgent");
const claudeInstance = ProviderInstanceId.make("claudeAgent");

const terminalEntry: ClaudeSessionRegistry.Attachment = {
  sessionId: SESSION,
  pid: CLAUDE_PID,
  owner: "terminal",
  status: "idle",
  name: "repo-work",
  cwd: "/w",
  tmux: "main:@27.%28",
  pane: { session: "main", pane: "%28" },
  startedAt: 1,
};

interface Fixture {
  readonly entry?: ClaudeSessionRegistry.Attachment | null;
  readonly gone?: boolean;
  readonly socket?: string | null;
  readonly platform?: "linux" | "darwin";
  readonly panePid?: number;
  /** `ps -o stat=,tty=` for the Claude pid, one per call; the last repeats, and "" is no process. */
  readonly claudeStats?: ReadonlyArray<string>;

  readonly activeRunId?: RunId | null;
  readonly backgroundWork?: boolean;
  readonly claudeHomePath?: string;
}

const output = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: code as ProcessRunner.ProcessRunOutput["code"],
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const withHandOff = <A, E>(
  fixture: Fixture,
  body: (input: {
    readonly handOff: CliSessionHandOff.CliSessionHandOff["Service"];
    /** Every tmux argv, in order, as it is run. */
    readonly tmux: Queue.Queue<ReadonlyArray<string>>;
    readonly tmuxCalls: ReadonlyArray<ReadonlyArray<string>>;
    /** Releases and tmux sends interleaved, to check the order between them. */
    readonly steps: ReadonlyArray<string>;
    readonly releases: ReadonlyArray<{ readonly reason: string }>;
    readonly awaitGoneCalls: ReadonlyArray<readonly [string, unknown]>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-hand-off-" });
    const procRoot = `${root}/proc`;
    const parents: Record<number, number> = {
      [CLAUDE_PID]: 4200,
      4200: PANE_SHELL_PID,
      [PANE_SHELL_PID]: 1,
      5000: 1,
    };
    for (const [pid, ppid] of Object.entries(parents)) {
      yield* fs.makeDirectory(`${procRoot}/${pid}`, { recursive: true });
      yield* fs.writeFileString(`${procRoot}/${pid}/stat`, `${pid} (zsh) S ${ppid} 1 1 0\n`);
    }

    const tmux = yield* Queue.unbounded<ReadonlyArray<string>>();
    const tmuxCalls: Array<ReadonlyArray<string>> = [];
    const steps: Array<string> = [];
    const releases: Array<{ readonly reason: string }> = [];
    const awaitGoneCalls: Array<readonly [string, unknown]> = [];

    const claudeStats = [...(fixture.claudeStats ?? ["Sl+ pts/5"])];
    const processRunner = ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.sync(() => {
          if (input.command === "ps" && input.args.includes("stat=,tty=")) {
            const stat = claudeStats.length > 1 ? claudeStats.shift()! : claudeStats[0]!;
            return stat === "" ? output("", 1) : output(`${stat}\n`);
          }
          if (input.command === "ps") {
            return output(
              Object.entries(parents)
                .map(([pid, ppid]) => `${pid.padStart(6)} ${String(ppid).padStart(6)}`)
                .join("\n"),
            );
          }
          tmuxCalls.push(input.args);
          steps.push(`tmux ${input.args.join(" ")}`);
          Queue.offerUnsafe(tmux, input.args);
          const format = input.args.at(-1) ?? "";
          if (format === "#{pane_pid}\t#{pane_tty}") {
            return output(`${fixture.panePid ?? PANE_SHELL_PID}\t/dev/pts/5\n`);
          }
          return output("");
        }),
    });

    const registry = Layer.mock(ClaudeSessionRegistry.ClaudeSessionRegistry)({
      attachments: yield* SubscriptionRef.make<
        ReadonlyMap<string, ClaudeSessionRegistry.Attachment>
      >(new Map()),
      entry: () => Effect.succeed(fixture.entry === undefined ? terminalEntry : fixture.entry),
      awaitGone: (sessionId, timeout) =>
        Effect.sync(() => {
          awaitGoneCalls.push([sessionId, timeout]);
          return fixture.gone ?? true;
        }),
      socketOf: () => Effect.succeed(fixture.socket === undefined ? SOCKET : fixture.socket),
    });

    const providerThread = {
      id: providerThreadId,
      driver: claudeDriver,
      providerInstanceId: claudeInstance,
      providerSessionId,
      appThreadId: threadId,
      nativeThreadRef: { driver: claudeDriver, nativeId: SESSION, strength: "strong" },
      pendingBackgroundTasks: fixture.backgroundWork
        ? [{ taskId: "dev-server", kind: "command" }]
        : [],
    } as unknown as OrchestrationV2ProviderThread;
    const shell = {
      id: threadId,
      projectId: ProjectId.make("project-hand-off"),
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      activeRunId: fixture.activeRunId ?? null,
    } as unknown as OrchestrationV2ThreadShell;
    const orchestrator = Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: () => Effect.succeed(shell),
      getThreadRecords: () =>
        Effect.succeed({ providerThreads: [providerThread], runs: [] } as never),
    });
    const projects = Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () => Effect.succeedSome({ workspaceRoot: "/w" } as ProjectStore.ProjectRow),
    });
    const sessions = Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
      isLive: () => Effect.succeed(true),
      releaseUnlessBusy: (input) =>
        Effect.sync(() => {
          steps.push(`release ${input.providerSessionId}`);
          releases.push({ reason: input.reason });
          return true;
        }),
    });
    const settings = Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances:
          fixture.claudeHomePath === undefined
            ? {}
            : {
                [claudeInstance]: {
                  driver: claudeDriver,
                  config: { homePath: fixture.claudeHomePath },
                },
              },
      }),
    });

    const handOff = yield* CliSessionHandOff.make({ procRoot }).pipe(
      Effect.provide(Layer.mergeAll(registry, orchestrator, projects, sessions, settings)),
      Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      Effect.provideService(HostProcess.Platform, fixture.platform ?? "linux"),
      Effect.provideService(HostProcess.Environment, {}),
      Effect.provideService(HostProcess.HomeDirectory, "/home/someone"),
    );
    return yield* body({ handOff, tmux, tmuxCalls, steps, releases, awaitGoneCalls });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const refusal = <A>(effect: Effect.Effect<A, CliSessionError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

// A guard that let a key through would otherwise park on the test clock instead of failing.
const refusedBeforeAnyKey = <A>(
  effect: Effect.Effect<A, CliSessionError>,
  tmux: Queue.Queue<ReadonlyArray<string>>,
) =>
  Effect.raceFirst(
    refusal(effect),
    Queue.take(tmux).pipe(
      Effect.repeat({ until: (args) => args.includes("send-keys") }),
      Effect.andThen(Effect.die("sent keys before refusing")),
    ),
  );

const sendCtrlC = ["-S", SOCKET, "send-keys", "-t", "%28", "C-c"];

// The gap is on the test clock: advance it only once the first key is out.
const afterFirstKey = (tmux: Queue.Queue<ReadonlyArray<string>>) =>
  Queue.take(tmux).pipe(
    Effect.repeat({ until: (args) => args.includes("send-keys") }),
    Effect.andThen(TestClock.adjust("200 millis")),
  );

it.effect("takes over an idle tmux session with two Ctrl-C 200 ms apart, to that pane only", () =>
  withHandOff({}, ({ handOff, tmux, tmuxCalls, awaitGoneCalls }) =>
    Effect.gen(function* () {
      const fiber = yield* handOff.takeOver({ threadId }).pipe(Effect.forkChild);
      expect(yield* Queue.take(tmux)).toEqual([
        "-S",
        SOCKET,
        "display-message",
        "-p",
        "-t",
        "%28",
        "#{pane_pid}\t#{pane_tty}",
      ]);
      expect(yield* Queue.take(tmux)).toEqual(sendCtrlC);
      yield* TestClock.adjust("199 millis");
      expect(tmuxCalls).toHaveLength(2);
      yield* TestClock.adjust("1 millis");
      expect(yield* Queue.take(tmux)).toEqual(sendCtrlC);
      expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true);
      expect(tmuxCalls).toHaveLength(3);
      expect(awaitGoneCalls).toEqual([[SESSION, "5 seconds"]]);
    }),
  ),
);

it.effect("refuses before any tmux call unless the terminal session is idle and in tmux", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<
      readonly [ClaudeSessionRegistry.Attachment | null, CliSessionError["reason"]]
    > = [
      [{ ...terminalEntry, status: "busy" }, "not-idle"],
      [{ ...terminalEntry, status: "shell" }, "not-idle"],
      [{ ...terminalEntry, status: "unknown" }, "not-idle"],
      [{ ...terminalEntry, tmux: null, pane: null }, "not-in-tmux"],
      [{ ...terminalEntry, owner: "other" }, "not-attached"],
      [null, "not-attached"],
    ];
    for (const [entry, reason] of cases) {
      yield* withHandOff({ entry }, ({ handOff, tmux, tmuxCalls, awaitGoneCalls }) =>
        Effect.gen(function* () {
          expect(yield* refusedBeforeAnyKey(handOff.takeOver({ threadId }), tmux)).toBe(reason);
          expect(tmuxCalls).toEqual([]);
          expect(awaitGoneCalls).toEqual([]);
        }),
      );
    }
  }),
);

it.effect("sends nothing when the pane's process tree does not hold the registry pid", () =>
  withHandOff({ panePid: 5000 }, ({ handOff, tmux, tmuxCalls }) =>
    Effect.gen(function* () {
      expect(yield* refusedBeforeAnyKey(handOff.takeOver({ threadId }), tmux)).toBe("pane-changed");
      expect(tmuxCalls.filter((args) => args.includes("send-keys"))).toEqual([]);
    }),
  ),
);

it.effect("sends nothing unless Claude is the job in front of the pane's own terminal", () =>
  Effect.gen(function* () {
    // Suspended with Ctrl-Z, sent to the background, stopped in front, nested in another
    // program's terminal, or gone.
    for (const stat of ["Tl pts/5", "Sl pts/5", "T+ pts/5", "Sl+ pts/9", ""]) {
      yield* withHandOff({ claudeStats: [stat] }, ({ handOff, tmux, tmuxCalls }) =>
        Effect.gen(function* () {
          expect(yield* refusedBeforeAnyKey(handOff.takeOver({ threadId }), tmux)).toBe(
            "pane-changed",
          );
          expect(tmuxCalls.filter((args) => args.includes("send-keys"))).toEqual([]);
        }),
      );
    }
  }),
);

it.effect("holds back the second Ctrl-C once Claude is no longer in front", () =>
  withHandOff({ claudeStats: ["Sl+ pts/5", ""] }, ({ handOff, tmux, tmuxCalls }) =>
    Effect.gen(function* () {
      const fiber = yield* handOff.takeOver({ threadId }).pipe(Effect.forkChild);
      yield* afterFirstKey(tmux);
      expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true);
      expect(tmuxCalls.filter((args) => args.includes("send-keys"))).toEqual([
        ["-S", SOCKET, "send-keys", "-t", "%28", "C-c"],
      ]);
    }),
  ),
);

it.effect("reports still-open when the session outlives the wait", () =>
  withHandOff({ gone: false }, ({ handOff, tmux, tmuxCalls }) =>
    Effect.gen(function* () {
      const fiber = yield* refusal(handOff.takeOver({ threadId })).pipe(Effect.forkChild);
      yield* afterFirstKey(tmux);
      expect(yield* Fiber.join(fiber)).toBe("still-open");
      expect(tmuxCalls.filter((args) => args.includes("send-keys"))).toHaveLength(2);
    }),
  ),
);

it.effect("on macOS, uses tmux's default server only after ps proves the pane holds the pid", () =>
  Effect.gen(function* () {
    yield* withHandOff({ platform: "darwin", socket: null }, ({ handOff, tmux, tmuxCalls }) =>
      Effect.gen(function* () {
        const fiber = yield* handOff.takeOver({ threadId }).pipe(Effect.forkChild);
        yield* afterFirstKey(tmux);
        expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true);
        expect(tmuxCalls).toEqual([
          ["display-message", "-p", "-t", "%28", "#{pane_pid}\t#{pane_tty}"],
          ["send-keys", "-t", "%28", "C-c"],
          ["send-keys", "-t", "%28", "C-c"],
        ]);
      }),
    );
    yield* withHandOff(
      { platform: "darwin", socket: null, panePid: 5000 },
      ({ handOff, tmux, tmuxCalls }) =>
        Effect.gen(function* () {
          expect(yield* refusedBeforeAnyKey(handOff.takeOver({ threadId }), tmux)).toBe(
            "pane-changed",
          );
          expect(tmuxCalls.filter((args) => args.includes("send-keys"))).toEqual([]);
        }),
    );
  }),
);

it.effect("releases rucode's own process and offers the command to copy, typing nowhere", () =>
  withHandOff({ entry: null }, ({ handOff, steps, releases }) =>
    Effect.gen(function* () {
      expect(yield* handOff.continueInTerminal({ threadId })).toEqual({
        delivery: "copy",
        command: `cd '/w' && claude --resume ${SESSION}`,
        paneLabel: null,
      });
      expect(releases).toHaveLength(1);
      expect(steps).toEqual([`release ${providerSessionId}`]);
    }),
  ),
);

it.effect("names a non-default Claude home on the claude invocation, not on cd", () =>
  withHandOff({ entry: null, claudeHomePath: "/alt/claude's" }, ({ handOff }) =>
    Effect.gen(function* () {
      expect((yield* handOff.continueInTerminal({ threadId })).command).toBe(
        `cd '/w' && CLAUDE_CONFIG_DIR='/alt/claude'\\''s' claude --resume ${SESSION}`,
      );
    }),
  ),
);

it.effect("refuses to continue while a turn or background work is running, releasing nothing", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<readonly [Fixture, CliSessionError["reason"]]> = [
      [{ activeRunId: RunId.make("run-active") }, "run-active"],
      [{ backgroundWork: true }, "background-pending"],
    ];
    for (const [fixture, reason] of cases) {
      yield* withHandOff({ ...fixture, entry: null }, ({ handOff, tmuxCalls, releases }) =>
        Effect.gen(function* () {
          expect(yield* refusal(handOff.continueInTerminal({ threadId }))).toBe(reason);
          expect(releases).toEqual([]);
          expect(tmuxCalls).toEqual([]);
        }),
      );
    }
  }),
);
