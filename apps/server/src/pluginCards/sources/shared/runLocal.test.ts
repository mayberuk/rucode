import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../../../processRunner.ts";
import { runLocalCommand, runLocalJson } from "./runLocal.ts";

const output = (stdout: string, code: number, stderr = ""): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr,
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const spawnError = (command: string) =>
  new ProcessRunner.ProcessSpawnError({
    command,
    argumentCount: 0,
    cause: new Error("ENOENT"),
  });
const timeoutError = (command: string) =>
  new ProcessRunner.ProcessTimeoutError({ command, argumentCount: 0, timeoutMs: 15_000 });

const withRunner =
  (run: ProcessRunner.ProcessRunner["Service"]["run"]) =>
  <A, E>(effect: Effect.Effect<A, E, ProcessRunner.ProcessRunner>) =>
    effect.pipe(Effect.provideService(ProcessRunner.ProcessRunner, { run }));

const collectWarnings = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
  const warnings: Array<string> = [];
  const logger = Logger.make(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(JSON.stringify(message));
  });
  const value = yield* effect.pipe(
    Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
  );
  return { value, warnings };
});

const base = { command: "dp", args: ["wave", "live"], cwd: "/work" };

it.effect.each([
  ["a missing program", spawnError("t3-missing")],
  ["a timeout", timeoutError("t3-missing")],
] as const)("returns no result and logs one warning naming the program for %s", ([, error]) =>
  Effect.gen(function* () {
    const { value, warnings } = yield* collectWarnings(
      runLocalCommand({ ...base, command: "t3-missing" }).pipe(
        withRunner(() => Effect.fail(error)),
      ),
    );
    expect(value).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("t3-missing");
  }),
);

it.effect("returns a non-zero exit as a result instead of null", () =>
  Effect.gen(function* () {
    const result = yield* runLocalCommand(base).pipe(
      withRunner(() => Effect.succeed(output("partial", 1, "boom"))),
    );
    expect(result).toEqual({ stdout: "partial", stderr: "boom", exitCode: 1 });
  }),
);

it.effect("runs the bare program in the given directory with a 15 second, 2 MiB budget", () =>
  Effect.gen(function* () {
    const calls: Array<ProcessRunner.ProcessRunInput> = [];
    const run = (input: ProcessRunner.ProcessRunInput) => {
      calls.push(input);
      return Effect.succeed(output("", 0));
    };
    yield* runLocalCommand(base).pipe(withRunner(run));
    yield* runLocalCommand({ ...base, timeout: "3 seconds", maxOutputBytes: 10 }).pipe(
      withRunner(run),
    );

    expect(calls.map((call) => [call.command, call.args, call.cwd])).toEqual([
      ["dp", ["wave", "live"], "/work"],
      ["dp", ["wave", "live"], "/work"],
    ]);
    expect(Duration.toMillis(Duration.fromInputUnsafe(calls[0]!.timeout!))).toBe(15_000);
    expect(calls[0]!.maxOutputBytes).toBe(2 * 1024 * 1024);
    expect(Duration.toMillis(Duration.fromInputUnsafe(calls[1]!.timeout!))).toBe(3_000);
    expect(calls[1]!.maxOutputBytes).toBe(10);
  }),
);

const Payload = Schema.Struct({ part: Schema.String, wave: Schema.Number });

it.effect("decodes JSON printed with exit code zero", () =>
  Effect.gen(function* () {
    const result = yield* runLocalJson(Payload, base).pipe(
      withRunner(() => Effect.succeed(output('{"part":"p1","wave":2}', 0))),
    );
    expect(result).toEqual({ part: "p1", wave: 2 });
  }),
);

it.effect.each([
  ["not json", output("not json", 0)],
  ["json of the wrong shape", output('{"part":"p1","wave":"two"}', 0)],
  ["empty output", output("", 0)],
  ["valid json with a non-zero exit", output('{"part":"p1","wave":2}', 1)],
] as const)("returns no result for %s", ([, result]) =>
  Effect.gen(function* () {
    expect(
      yield* runLocalJson(Payload, base).pipe(withRunner(() => Effect.succeed(result))),
    ).toBeNull();
  }),
);

it.effect("returns no result from runLocalJson when the program is missing", () =>
  Effect.gen(function* () {
    const { value, warnings } = yield* collectWarnings(
      runLocalJson(Payload, { ...base, command: "t3-missing" }).pipe(
        withRunner(() => Effect.fail(spawnError("t3-missing"))),
      ),
    );
    expect(value).toBeNull();
    expect(warnings).toHaveLength(1);
  }),
);
