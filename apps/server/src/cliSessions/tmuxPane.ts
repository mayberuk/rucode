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

const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash"]);
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

export const panePid = Effect.fn("tmuxPane.panePid")(function* (target: TmuxPaneTarget) {
  const stdout = yield* display(target, "#{pane_pid}");
  const pid = Number(stdout?.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
});

/** The pane's tmux session and foreground command; a login shell's leading `-` is dropped. */
export const paneProcess = Effect.fn("tmuxPane.paneProcess")(function* (target: TmuxPaneTarget) {
  const stdout = yield* display(target, "#{session_name}\t#{pane_current_command}");
  const [sessionName, command] = stdout?.trimEnd().split("\t") ?? [];
  if (sessionName === undefined || command === undefined || command === "") return null;
  return { sessionName, command: command.replace(/^-/, "") };
});

export const isShell = (command: string) => SHELLS.has(command);

/** `literal` types the keys as text (`-l`) instead of reading them as key names. */
export const sendKeys = Effect.fn("tmuxPane.sendKeys")(function* (
  target: TmuxPaneTarget,
  keys: ReadonlyArray<string>,
  options?: { readonly literal?: boolean },
) {
  const stdout = yield* tmux(target, [
    "send-keys",
    "-t",
    target.pane,
    ...(options?.literal ? ["-l"] : []),
    ...keys,
  ]);
  return stdout !== null;
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
