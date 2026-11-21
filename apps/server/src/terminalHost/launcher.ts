// @effect-diagnostics nodeBuiltinImport:off -- The host must outlive this process, which Effect's ChildProcessSpawner scope forbids.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import { TerminalHostUnavailableError, type TerminalHostAddress } from "./paths.ts";

export interface TerminalHostLaunchCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/** Returns null when this build has no entry the host subcommand can run from. */
export function resolveTerminalHostCommand(input: {
  readonly isExecutable: boolean;
  readonly execPath: string;
  readonly entryPath: string | undefined;
  readonly fromSource: boolean;
  readonly stateDir: string;
}): TerminalHostLaunchCommand | null {
  const hostArgs = ["__terminal-host", "--state-dir", input.stateDir];
  if (input.isExecutable) return { command: input.execPath, args: hostArgs };
  if (input.entryPath === undefined) return null;
  return {
    command: input.execPath,
    args: [
      ...(input.fromSource ? ["--experimental-strip-types"] : []),
      input.entryPath,
      ...hostArgs,
    ],
  };
}

/** Pass `systemdRun: null` to launch without a scope; `findSystemdRun` decides when one is usable. */
export function wrapForSystemdScope(
  command: TerminalHostLaunchCommand,
  input: { readonly systemdRun: string | null; readonly unitName: string },
): TerminalHostLaunchCommand {
  if (input.systemdRun === null) return command;
  return {
    command: input.systemdRun,
    args: [
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      `--unit=${input.unitName}`,
      "--",
      command.command,
      ...command.args,
    ],
  };
}

export const terminalHostUnitName = (stateDir: string): string =>
  `rucode-terminal-host-${NodeCrypto.createHash("sha256").update(stateDir).digest("hex").slice(0, 12)}-${NodeCrypto.randomBytes(3).toString("hex")}`;

/**
 * `systemd-run` when this is Linux with a user runtime directory, else null. A server running as
 * a user service is stopped with `KillMode=mixed`, which also kills a plain detached child; only a
 * separate scope survives it. `AgentScope.wrap` is not reused: it raises `oom_score_adj`, which
 * would make every terminal the kernel's first OOM victim.
 */
export const findSystemdRun = Effect.fn("TerminalHost.findSystemdRun")(function* () {
  if ((yield* HostProcess.Platform) !== "linux") return null;
  const env = yield* HostProcess.Environment;
  const userId = yield* HostProcess.UserId;
  const runtimeDir =
    env.XDG_RUNTIME_DIR !== undefined && env.XDG_RUNTIME_DIR !== ""
      ? env.XDG_RUNTIME_DIR
      : userId === undefined
        ? undefined
        : `/run/user/${userId}`;
  if (runtimeDir === undefined) return null;
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(runtimeDir).pipe(Effect.orElseSucceed(() => false)))) return null;
  return yield* resolveCommandPath("systemd-run", { env });
});

const READY_TIMEOUT = "30 seconds";
const MAX_READY_LINE_BYTES = 256;

const answers = (socketPath: string) =>
  Effect.callback<boolean>((resume) => {
    const socket = NodeNet.createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resume(Effect.succeed(true));
    });
    socket.once("error", () => {
      socket.destroy();
      resume(Effect.succeed(false));
    });
    return Effect.sync(() => socket.destroy());
  });

const unavailable = (reason: string, cause?: unknown) =>
  new TerminalHostUnavailableError(cause === undefined ? { reason } : { reason, cause });

const launchOnce = (
  command: TerminalHostLaunchCommand,
  logPath: string,
  env: NodeJS.ProcessEnv,
): Effect.Effect<number | null, TerminalHostUnavailableError> =>
  Effect.callback<number | null, TerminalHostUnavailableError>((resume) => {
    let logFd: number;
    try {
      logFd = NodeFS.openSync(logPath, "a", 0o600);
    } catch (cause) {
      resume(Effect.fail(unavailable(`cannot open ${logPath}`, cause)));
      return;
    }
    let child: NodeChildProcess.ChildProcess;
    try {
      child = NodeChildProcess.spawn(command.command, [...command.args], {
        detached: true,
        stdio: ["ignore", "pipe", logFd],
        env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      });
    } catch (cause) {
      resume(Effect.fail(unavailable(`cannot start ${command.command}`, cause)));
      return;
    } finally {
      NodeFS.closeSync(logFd);
    }
    const stdout = child.stdout;
    let settled = false;
    let pending = "";
    const settle = (result: Effect.Effect<number | null, TerminalHostUnavailableError>) => {
      if (settled) return;
      settled = true;
      stdout?.destroy();
      child.unref();
      resume(result);
    };
    stdout?.setEncoding("utf8");
    stdout?.on("data", (chunk: string) => {
      pending += chunk;
      const newline = pending.indexOf("\n");
      if (newline === -1) {
        if (pending.length > MAX_READY_LINE_BYTES) {
          settle(Effect.fail(unavailable("the terminal host printed no ready line")));
        }
        return;
      }
      const ready = /^ready (\d+)$/.exec(pending.slice(0, newline));
      settle(
        ready === null
          ? Effect.fail(unavailable(`unexpected terminal host output: ${pending.slice(0, 80)}`))
          : Effect.succeed(Number(ready[1])),
      );
    });
    child.once("error", (cause) =>
      settle(Effect.fail(unavailable(`cannot start ${command.command}`, cause))),
    );
    child.once("exit", () => settle(Effect.succeed(null)));
    return Effect.sync(() => {
      if (settled) return;
      settled = true;
      stdout?.destroy();
      child.kill("SIGTERM");
      child.unref();
    });
  });

const launchLock = Semaphore.makeUnsafe(1);

/**
 * Launches the host unless one already answers at `address`. When `fallback` is given and
 * `command` exits before its ready line (a `systemd-run` without a user manager), `fallback` runs
 * once in its place.
 */
export const ensureTerminalHost = Effect.fn("TerminalHost.ensure")(function* (input: {
  readonly address: TerminalHostAddress;
  readonly command: TerminalHostLaunchCommand;
  readonly fallback?: TerminalHostLaunchCommand;
  readonly logPath: string;
}) {
  const env = yield* HostProcess.Environment;
  const fs = yield* FileSystem.FileSystem;
  return yield* launchLock.withPermits(1)(
    Effect.gen(function* () {
      if (yield* answers(input.address.socketPath)) return { launchedPid: null };
      yield* fs
        .makeDirectory(NodePath.dirname(input.logPath), { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            unavailable(`cannot create ${NodePath.dirname(input.logPath)}`, cause),
          ),
        );
      let failure = unavailable(
        `the terminal host exited before it was ready; see ${input.logPath}`,
      );
      for (const command of input.fallback === undefined
        ? [input.command]
        : [input.command, input.fallback]) {
        const launched = yield* launchOnce(command, input.logPath, env).pipe(
          Effect.timeoutOption(READY_TIMEOUT),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(unavailable("the terminal host did not become ready")),
              onSome: Effect.succeed,
            }),
          ),
          Effect.result,
        );
        if (launched._tag === "Success" && launched.success !== null) {
          return { launchedPid: launched.success };
        }
        if (launched._tag === "Failure") failure = launched.failure;
        // A host started by someone else between our probe and this launch exits without a
        // ready line, leaving the socket to the winner.
        if (yield* answers(input.address.socketPath)) return { launchedPid: null };
      }
      return yield* failure;
    }),
  );
});
