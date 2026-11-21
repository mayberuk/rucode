import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as ProcessRunner from "../processRunner.ts";
import type { RestorableTerminalCommand } from "./sessionHost.ts";

/** Every read fails soft: a process that exited or a denied lookup is `null`, never an error. */
export interface ForegroundCommandSources {
  readonly readText: (path: string) => Effect.Effect<string | null>;
  readonly readLink: (path: string) => Effect.Effect<string | null>;
  readonly run: (command: string, args: ReadonlyArray<string>) => Effect.Effect<string | null>;
}

const PROCESS_QUERY_TIMEOUT = "2 seconds";

export const makeForegroundCommandSources = Effect.fn("terminal.makeForegroundCommandSources")(
  function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const processRunner = yield* ProcessRunner.ProcessRunner;
    return {
      readText: (path) => fileSystem.readFileString(path).pipe(Effect.orElseSucceed(() => null)),
      readLink: (path) => fileSystem.readLink(path).pipe(Effect.orElseSucceed(() => null)),
      run: (command, args) =>
        processRunner
          .run({
            command,
            args,
            timeout: PROCESS_QUERY_TIMEOUT,
            timeoutBehavior: "timedOutResult",
          })
          .pipe(
            Effect.map((result) => (result.code === 0 && !result.timedOut ? result.stdout : null)),
            Effect.orElseSucceed(() => null),
          ),
    } satisfies ForegroundCommandSources;
  },
);

const SHELL_SAFE_ARGUMENT = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Joins argv into one POSIX shell line, quoting only the arguments that need it. */
export function posixQuoteArgv(argv: ReadonlyArray<string>): string {
  return argv
    .map((argument) =>
      SHELL_SAFE_ARGUMENT.test(argument) ? argument : `'${argument.replaceAll("'", `'\\''`)}'`,
    )
    .join(" ");
}

const CONTROL_CHARACTER = /[\x00-\x08\x0a-\x1f\x7f]/;

/**
 * A line or directory holding a control character would reach the terminal as an escape
 * sequence on display and as keystrokes on rerun, so such a command is not restorable.
 */
export function restorableTerminalCommand(
  line: string,
  cwd: string,
): RestorableTerminalCommand | null {
  if (line.length === 0 || cwd.length === 0) return null;
  if (CONTROL_CHARACTER.test(line) || CONTROL_CHARACTER.test(cwd)) return null;
  return { line, cwd };
}

function parseLsofCwd(output: string): string | null {
  for (const record of output.split("\n")) {
    if (record.startsWith("n") && record.length > 1) return record.slice(1);
  }
  return null;
}

/** The working directory of `pid`, or null where it cannot be read. */
export const readProcessCwd = Effect.fn("terminal.readProcessCwd")(function* (
  pid: number,
  platform: NodeJS.Platform,
  sources: ForegroundCommandSources,
) {
  if (platform === "linux") return yield* sources.readLink(`/proc/${pid}/cwd`);
  if (platform === "darwin") {
    const output = yield* sources.run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    return output === null ? null : parseLsofCwd(output);
  }
  return null;
});

/** The command line and working directory of the process at `pid`, or null where unreadable. */
export const readForegroundCommand = Effect.fn("terminal.readForegroundCommand")(function* (
  pid: number,
  platform: NodeJS.Platform,
  sources: ForegroundCommandSources,
) {
  let line: string | null;
  if (platform === "linux") {
    const cmdline = yield* sources.readText(`/proc/${pid}/cmdline`);
    const argv = cmdline === null ? [] : cmdline.split("\0");
    if (argv.at(-1) === "") argv.pop();
    line = argv.length === 0 ? null : posixQuoteArgv(argv);
  } else if (platform === "darwin") {
    // ps joins argv with spaces, so an argument holding a space cannot be quoted back.
    line = ((yield* sources.run("ps", ["-o", "args=", "-p", String(pid)])) ?? "").trim() || null;
  } else {
    return null;
  }
  if (line === null) return null;
  const cwd = yield* readProcessCwd(pid, platform, sources);
  return cwd === null ? null : restorableTerminalCommand(line, cwd);
});
