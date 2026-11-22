import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";

/** A tmux pane by id (`%28`); a null socket means tmux's default server. */
export interface TmuxPaneTarget {
  readonly socket: string | null;
  readonly pane: string;
}

// Deeper than any real shell-to-CLI chain; also ends a walk through a corrupt parent cycle.
const MAX_ANCESTRY_DEPTH = 64;

const tmux = Effect.fnUntraced(function* (target: TmuxPaneTarget, args: ReadonlyArray<string>) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const result = yield* processRunner
    .run({
      command: "tmux",
      args: [...(target.socket === null ? [] : ["-S", target.socket]), ...args],
      timeout: "2 seconds",
    })
    .pipe(Effect.option);
  return Option.isSome(result) && result.value.code === 0 ? result.value.stdout : null;
});

const display = (target: TmuxPaneTarget, format: string) =>
  tmux(target, ["display-message", "-p", "-t", target.pane, format]);

/** The pid of the process the pane started and the pane's terminal device. */
export const paneTerminal = Effect.fn("tmuxPane.paneTerminal")(function* (target: TmuxPaneTarget) {
  const stdout = yield* display(target, "#{pane_pid}\t#{pane_tty}");
  const [pidText, tty] = stdout?.trim().split("\t") ?? [];
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0 || tty === undefined || tty === "") return null;
  return { pid, tty };
});

/**
 * The terminal `pid` runs in the foreground of, or null when it is stopped, in the background,
 * gone or unreadable. Keys typed into that terminal reach this process and no other job.
 */
export const foregroundTty = Effect.fn("tmuxPane.foregroundTty")(function* (pid: number) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const result = yield* processRunner
    .run({ command: "ps", args: ["-o", "stat=,tty=", "-p", String(pid)], timeout: "2 seconds" })
    .pipe(Effect.option);
  if (Option.isNone(result) || result.value.code !== 0) return null;
  // Both procps and BSD ps mark a process in its terminal's foreground group with `+`.
  const [stat, tty] = result.value.stdout.trim().split(/\s+/);
  if (stat === undefined || tty === undefined || /^[Tt]/.test(stat) || !stat.includes("+")) {
    return null;
  }
  return tty === "?" || tty === "??" ? null : `/dev/${tty}`;
});

export const sendKeys = Effect.fn("tmuxPane.sendKeys")(function* (
  target: TmuxPaneTarget,
  keys: ReadonlyArray<string>,
) {
  return (yield* tmux(target, ["send-keys", "-t", target.pane, ...keys])) !== null;
});

const linuxParentOf = Effect.fnUntraced(function* (procRoot: string, pid: number) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stat = yield* fs
    .readFileString(path.join(procRoot, String(pid), "stat"))
    .pipe(Effect.option);
  if (Option.isNone(stat)) return null;
  // The command name in field 2 may hold spaces and parentheses; ppid is the field after state.
  const ppid = Number(stat.value.slice(stat.value.lastIndexOf(")") + 2).split(" ")[1]);
  return Number.isSafeInteger(ppid) && ppid >= 0 ? ppid : null;
});

const psParents = Effect.fnUntraced(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const result = yield* processRunner
    .run({ command: "ps", args: ["-A", "-o", "pid=,ppid="], timeout: "2 seconds" })
    .pipe(Effect.option);
  if (Option.isNone(result) || result.value.code !== 0) return null;
  const parents = new Map<number, number>();
  for (const line of result.value.stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isSafeInteger(pid) && Number.isSafeInteger(ppid)) parents.set(pid!, ppid!);
  }
  return parents;
});

/** Whether `pid` is `ancestor` or runs below it. Anything unreadable on the way answers false. */
export const descendsFrom = Effect.fn("tmuxPane.descendsFrom")(function* (
  pid: number,
  ancestor: number,
  options: { readonly procRoot: string },
) {
  const platform = yield* HostProcess.Platform;
  const parents = platform === "linux" ? null : yield* psParents();
  if (platform !== "linux" && parents === null) return false;
  let current: number | null = pid;
  for (let depth = 0; current !== null && current > 0 && depth < MAX_ANCESTRY_DEPTH; depth++) {
    if (current === ancestor) return true;
    current =
      parents === null
        ? yield* linuxParentOf(options.procRoot, current)
        : (parents.get(current) ?? null);
  }
  return false;
});
