import {
  ClaudeSettings,
  type CliSessionContinueInput,
  type CliSessionContinueResult,
  CliSessionError,
  type CliSessionTakeOverInput,
  type OrchestrationV2ProviderThread,
  type ProviderInstanceId,
  ProviderDriverKind,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import type * as ProcessRunner from "../processRunner.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ClaudeSessionRegistry from "./ClaudeSessionRegistry.ts";
import * as TmuxPane from "./tmuxPane.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
// The id is typed into a shell unquoted; Claude's own ids are uuids.
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Claude Code 2.1.330: the first Ctrl-C clears any draft and arms exit, a second within 800 ms
// exits. Two separate sends 200 ms apart arrive as two reads; Ctrl-D exits only on empty input.
const EXIT_KEY_GAP = "200 millis";
const EXIT_TIMEOUT = "5 seconds";

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const refuse = (reason: CliSessionError["reason"], cause?: unknown) =>
  Effect.fail(new CliSessionError(cause === undefined ? { reason } : { reason, cause }));

const ownProviderThreads = (
  threadId: ThreadId,
  providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>,
) => providerThreads.filter((providerThread) => providerThread.appThreadId === threadId);

const hasBackgroundWork = (providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>) =>
  providerThreads.some(
    (providerThread) => (providerThread.pendingBackgroundTasks?.length ?? 0) > 0,
  );

export class CliSessionHandOff extends Context.Service<
  CliSessionHandOff,
  {
    /** Ends the terminal's idle Claude process for the thread's session so rucode can write. */
    readonly takeOver: (input: CliSessionTakeOverInput) => Effect.Effect<void, CliSessionError>;
    /** Releases rucode's own process, then returns the command that resumes the session. */
    readonly continueInTerminal: (
      input: CliSessionContinueInput,
    ) => Effect.Effect<CliSessionContinueResult, CliSessionError>;
  }
>()("t3/cliSessions/CliSessionHandOff") {}

/** For a server built without the service: it knows of no terminal session to hand off. */
export const unavailable: CliSessionHandOff["Service"] = {
  takeOver: () => refuse("not-attached"),
  continueInTerminal: () => refuse("no-session"),
};

export const make = Effect.fn("CliSessionHandOff.make")(function* (options?: {
  readonly procRoot?: string;
}) {
  const procRoot = options?.procRoot ?? "/proc";
  const registry = yield* ClaudeSessionRegistry.ClaudeSessionRegistry;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const hostEnvironment = yield* HostProcess.Environment;
  // Also carries the host platform and home directory references the tmux and path helpers read.
  const services = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner
  >();

  const threadSession = Effect.fnUntraced(function* (threadId: ThreadId) {
    const shell = yield* orchestrator.getThreadShell(threadId).pipe(Effect.orDie);
    if (shell === null || shell.activeProviderThreadId === null) return yield* refuse("no-session");
    const { providerThreads } = yield* orchestrator
      .getThreadRecords(threadId, ["providerThreads"])
      .pipe(Effect.orDie);
    const providerThread = providerThreads.find(
      (candidate) => candidate.id === shell.activeProviderThreadId,
    );
    const sessionId = providerThread?.nativeThreadRef?.nativeId;
    if (
      providerThread === undefined ||
      providerThread.driver !== CLAUDE_DRIVER ||
      typeof sessionId !== "string" ||
      !SESSION_ID_PATTERN.test(sessionId)
    ) {
      return yield* refuse("no-session");
    }
    return {
      shell,
      providerThread,
      sessionId,
      own: ownProviderThreads(threadId, providerThreads),
    };
  });

  const takeOver = Effect.fn("CliSessionHandOff.takeOver")(function* (
    input: CliSessionTakeOverInput,
  ) {
    const { sessionId } = yield* threadSession(input.threadId);
    const entry = yield* registry.entry(sessionId);
    if (entry === null || entry.owner !== "terminal") return yield* refuse("not-attached");
    if (entry.status !== "idle") return yield* refuse("not-idle");
    if (entry.pane === null) return yield* refuse("not-in-tmux");
    // Off Linux there is no socket to read; tmux's default server is tried, and the pid check
    // below is what proves it is the right pane.
    const target = { socket: yield* registry.socketOf(entry.pid), pane: entry.pane.pane };
    const terminal = yield* TmuxPane.paneTerminal(target);
    // The pane holding Claude is not enough: a Ctrl-Z'd Claude or one nested in another program's
    // terminal would hand these keys to whatever job is in front.
    const claudeInFront = Effect.map(
      TmuxPane.foregroundTty(entry.pid),
      (tty) => terminal !== null && tty === terminal.tty,
    );
    if (
      terminal === null ||
      !(yield* TmuxPane.descendsFrom(entry.pid, terminal.pid, { procRoot })) ||
      !(yield* claudeInFront)
    ) {
      return yield* refuse("pane-changed");
    }
    if (!(yield* TmuxPane.sendKeys(target, ["C-c"]))) return yield* refuse("tmux-failed");
    yield* Effect.sleep(EXIT_KEY_GAP);
    if ((yield* claudeInFront) && !(yield* TmuxPane.sendKeys(target, ["C-c"]))) {
      return yield* refuse("tmux-failed");
    }
    if (!(yield* registry.awaitGone(sessionId, EXIT_TIMEOUT))) return yield* refuse("still-open");
  }, Effect.provideContext(services));

  const claudeHomeOf = Effect.fnUntraced(function* (instanceId: ProviderInstanceId) {
    const current = yield* settings.getSettings.pipe(Effect.option);
    const instance = Option.isSome(current)
      ? current.value.providerInstances[instanceId]
      : undefined;
    const claudeSettings =
      instance?.driver === CLAUDE_DRIVER
        ? Option.getOrUndefined(decodeClaudeSettings(instance.config ?? {}))
        : undefined;
    const configured = instance?.environment?.findLast(
      (variable) => variable.name === "CLAUDE_CONFIG_DIR",
    )?.value;
    const configDir =
      typeof configured === "string" ? configured : hostEnvironment.CLAUDE_CONFIG_DIR;
    return yield* resolveClaudeHomePath(
      { homePath: claudeSettings?.homePath ?? "" },
      configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: configDir },
    );
  });

  const resumeCommand = Effect.fnUntraced(function* (
    session: Effect.Success<ReturnType<typeof threadSession>>,
  ) {
    const cwd =
      session.shell.worktreePath ??
      Option.getOrUndefined(
        yield* projects.get(session.shell.projectId).pipe(Effect.orElseSucceed(Option.none)),
      )?.workspaceRoot;
    if (cwd === undefined) return yield* refuse("no-session");
    const home = yield* claudeHomeOf(session.providerThread.providerInstanceId);
    const defaultHome = yield* resolveClaudeHomePath({ homePath: "" }, hostEnvironment);
    const configDir = home === defaultHome ? "" : `CLAUDE_CONFIG_DIR=${shellQuote(home)} `;
    return `cd ${shellQuote(cwd)} && ${configDir}claude --resume ${session.sessionId}`;
  });

  const releaseOwnProcesses = Effect.fnUntraced(function* (
    threadId: ThreadId,
    own: ReadonlyArray<OrchestrationV2ProviderThread>,
  ) {
    const backgroundWorkNow = orchestrator.getThreadRecords(threadId, ["providerThreads"]).pipe(
      Effect.map(({ providerThreads }) =>
        hasBackgroundWork(ownProviderThreads(threadId, providerThreads)),
      ),
      Effect.orElseSucceed(() => true),
    );
    const providerSessionIds = new Set(
      own.flatMap((providerThread) =>
        providerThread.providerSessionId === null ? [] : [providerThread.providerSessionId],
      ),
    );
    for (const providerSessionId of providerSessionIds) {
      if (!(yield* sessions.isLive(providerSessionId))) continue;
      // No own turn is exempt: any busy turn, or background work started meanwhile, keeps it.
      const released = yield* sessions
        .releaseUnlessBusy({
          providerSessionId,
          ownProviderThreadIds: [],
          throughRunOrdinal: 0,
          keepIf: backgroundWorkNow,
          reason: "manual_shutdown",
          detail: "Continued in a terminal",
        })
        .pipe(Effect.catch((cause) => refuse("run-active", cause)));
      if (!released) {
        return yield* refuse((yield* backgroundWorkNow) ? "background-pending" : "run-active");
      }
    }
  });

  const continueInTerminal = Effect.fn("CliSessionHandOff.continueInTerminal")(function* (
    input: CliSessionContinueInput,
  ) {
    const session = yield* threadSession(input.threadId);
    if (session.shell.activeRunId !== null) return yield* refuse("run-active");
    if (hasBackgroundWork(session.own)) return yield* refuse("background-pending");
    const command = yield* resumeCommand(session);
    yield* releaseOwnProcesses(input.threadId, session.own);
    // Nothing outside a shell can tell whether its prompt holds a half-typed line, and typing
    // after one would run both; the user runs the command where they choose.
    return { delivery: "copy", command, paneLabel: null } satisfies CliSessionContinueResult;
  }, Effect.provideContext(services));

  return CliSessionHandOff.of({ takeOver, continueInTerminal });
});

export const layer = Layer.effect(CliSessionHandOff, make());
