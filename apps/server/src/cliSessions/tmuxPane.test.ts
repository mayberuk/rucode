import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as ProcessRunner from "../processRunner.ts";
import * as TmuxPane from "./tmuxPane.ts";

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

const runner = (
  respond: (input: ProcessRunner.ProcessRunInput) => ProcessRunner.ProcessRunOutput,
) => ProcessRunner.ProcessRunner.of({ run: (input) => Effect.succeed(respond(input)) });

const noProcesses = runner(() => {
  throw new Error("Linux walks the proc root, not ps");
});

// pid -> ppid, written as `/proc/<pid>/stat` with a command name holding spaces and parentheses.
const withProcRoot = <A, E, R>(
  parents: Record<number, number>,
  body: (procRoot: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const procRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-tmux-pane-" });
    for (const [pid, ppid] of Object.entries(parents)) {
      yield* fs.makeDirectory(`${procRoot}/${pid}`);
      yield* fs.writeFileString(
        `${procRoot}/${pid}/stat`,
        `${pid} (claude (x) y) S ${ppid} ${pid} ${pid} 0 -1 4194560\n`,
      );
    }
    return yield* body(procRoot);
  });

it.effect("on Linux, finds the pane's shell among the registry pid's ancestors", () =>
  withProcRoot({ 4242: 4200, 4200: 4100, 4100: 1, 5000: 1 }, (procRoot) =>
    Effect.gen(function* () {
      const descends = (pid: number, ancestor: number) =>
        TmuxPane.descendsFrom(pid, ancestor, { procRoot });
      expect(yield* descends(4242, 4100)).toBe(true);
      expect(yield* descends(4242, 4242)).toBe(true);
      expect(yield* descends(4242, 5000)).toBe(false);
      // A pid whose stat is gone breaks the chain: unverifiable is not a match.
      expect(yield* descends(6000, 1)).toBe(false);
    }),
  ).pipe(
    Effect.scoped,
    Effect.provideService(ProcessRunner.ProcessRunner, noProcesses),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provide(NodeServices.layer),
  ),
);

it.effect("stops walking a parent cycle instead of looping", () =>
  withProcRoot({ 10: 11, 11: 10 }, (procRoot) =>
    TmuxPane.descendsFrom(10, 99, { procRoot }).pipe(
      Effect.map((descends) => expect(descends).toBe(false)),
    ),
  ).pipe(
    Effect.scoped,
    Effect.provideService(ProcessRunner.ProcessRunner, noProcesses),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provide(NodeServices.layer),
  ),
);

it.effect("on macOS, reads the process tree from ps", () =>
  Effect.gen(function* () {
    const calls: Array<ReadonlyArray<string>> = [];
    const ps = runner((input) => {
      calls.push([input.command, ...input.args]);
      return output("    1     0\n 4100     1\n 4200  4100\n 4242  4200\n 5000     1\n");
    });
    const descends = (pid: number, ancestor: number) =>
      TmuxPane.descendsFrom(pid, ancestor, { procRoot: "/nonexistent" }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, ps),
      );
    expect(yield* descends(4242, 4100)).toBe(true);
    expect(yield* descends(4242, 5000)).toBe(false);
    expect(calls[0]).toEqual(["ps", "-A", "-o", "pid=,ppid="]);

    const failing = runner(() => output("", 1));
    expect(
      yield* TmuxPane.descendsFrom(4242, 4100, { procRoot: "/nonexistent" }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, failing),
      ),
    ).toBe(false);
  }).pipe(
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provide(NodeServices.layer),
  ),
);

it.effect("addresses the named socket, or tmux's default server when there is none", () =>
  Effect.gen(function* () {
    const calls: Array<ReadonlyArray<string>> = [];
    const tmux = runner((input) => {
      calls.push([input.command, ...input.args]);
      return input.args.includes("#{pane_pid}") ? output("4100\n") : output("main\t-zsh\n");
    });
    const provide = Effect.provideService(ProcessRunner.ProcessRunner, tmux);

    expect(
      yield* TmuxPane.panePid({ socket: "/tmp/tmux-1000/default", pane: "%28" }).pipe(provide),
    ).toBe(4100);
    expect(yield* TmuxPane.paneProcess({ socket: null, pane: "%28" }).pipe(provide)).toEqual({
      sessionName: "main",
      command: "zsh",
    });
    expect(calls).toEqual([
      ["tmux", "-S", "/tmp/tmux-1000/default", "display-message", "-p", "-t", "%28", "#{pane_pid}"],
      ["tmux", "display-message", "-p", "-t", "%28", "#{session_name}\t#{pane_current_command}"],
    ]);
  }),
);

it.effect("reads a missing pane or a failed send as nothing, not as success", () =>
  Effect.gen(function* () {
    const gone = Effect.provideService(
      ProcessRunner.ProcessRunner,
      runner(() => output("", 1)),
    );
    const target = { socket: "/tmp/s", pane: "%28" };
    expect(yield* TmuxPane.panePid(target).pipe(gone)).toBeNull();
    expect(yield* TmuxPane.paneProcess(target).pipe(gone)).toBeNull();
    expect(yield* TmuxPane.sendKeys(target, ["C-c"]).pipe(gone)).toBe(false);
  }),
);
