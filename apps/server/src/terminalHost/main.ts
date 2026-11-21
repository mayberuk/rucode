// @effect-diagnostics nodeBuiltinImport:off -- The host process entry resolves its socket under the OS temp directory.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

import * as NodePtyAdapter from "../terminal/NodePtyAdapter.ts";
import { DEFAULT_IDLE_EXIT_MS, startTerminalHost } from "./host.ts";
import { resolveTerminalHostAddress } from "./paths.ts";

const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

function parseArguments(argv: ReadonlyArray<string>) {
  let stateDir: string | undefined;
  let idleExitMs = DEFAULT_IDLE_EXIT_MS;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`Missing a value for ${flag}.`);
    if (flag === "--state-dir") {
      stateDir = NodePath.resolve(value);
    } else if (flag === "--idle-exit-ms") {
      idleExitMs = Number(value);
      if (!Number.isSafeInteger(idleExitMs) || idleExitMs < 0) {
        throw new Error(`--idle-exit-ms must be a non-negative integer, got ${value}.`);
      }
    } else {
      throw new Error(`Unknown terminal host argument ${flag}.`);
    }
  }
  if (stateDir === undefined) throw new Error("--state-dir is required.");
  return { stateDir, idleExitMs };
}

/** Runs the terminal host until it idles out or is signalled. Prints `ready <pid>` once listening. */
export const runTerminalHost = async (argv: ReadonlyArray<string>): Promise<void> => {
  const { stateDir, idleExitMs } = parseArguments(argv);

  const program = Effect.gen(function* () {
    const userId = yield* HostProcess.UserId;
    if (userId === undefined) return yield* Effect.die("The terminal host needs a Unix user id.");
    const address = resolveTerminalHostAddress({
      stateDir,
      platform: yield* HostProcess.Platform,
      tempDir: NodeOS.tmpdir(),
      runtimeDir: (yield* HostProcess.Environment).XDG_RUNTIME_DIR,
      userId,
      joinPath: NodePath.join,
    });
    const start = yield* startTerminalHost({ stateDir, address, idleExitMs });
    if (start._tag === "AlreadyRunning") {
      yield* Effect.logInfo("another terminal host already serves this state directory");
      return;
    }
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    const onSignal = () => {
      runFork(start.shutdown);
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        for (const signal of SHUTDOWN_SIGNALS) process.on(signal, onSignal);
      }),
      () =>
        Effect.sync(() => {
          for (const signal of SHUTDOWN_SIGNALS) process.off(signal, onSignal);
        }),
    );
    process.stdout.end(`ready ${process.pid}\n`);
    const reason = yield* start.stopped;
    yield* Effect.logInfo(`terminal host stopping: ${reason}`);
  }).pipe(
    Effect.scoped,
    Effect.provide(NodePtyAdapter.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    Effect.provideService(Logger.LogToStderr, true),
  );

  const exit = await Effect.runPromiseExit(program);
  if (exit._tag === "Failure") {
    process.stderr.write(`terminal host failed: ${String(exit.cause)}\n`);
  }
  // A job that ignored the hangup can hold its PTY open and keep the event loop alive forever.
  process.exit(exit._tag === "Failure" ? 1 : 0);
};
