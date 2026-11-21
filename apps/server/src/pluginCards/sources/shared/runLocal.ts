import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ProcessRunner } from "../../../processRunner.ts";

export interface LocalCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

interface LocalCommandInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly timeout?: Duration.Input;
  readonly maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT = Duration.seconds(15);
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** A host without the program fails the same way on every refresh, so it is reported once. */
const missingReported = new Set<string>();

export const runLocalCommand = Effect.fn("PluginCards.runLocalCommand")(function* (
  input: LocalCommandInput,
) {
  const runner = yield* ProcessRunner;
  return yield* runner
    .run({
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      timeout: input.timeout ?? DEFAULT_TIMEOUT,
      maxOutputBytes: input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    })
    .pipe(
      Effect.map((output): LocalCommandResult | null =>
        output.code === null
          ? null
          : { stdout: output.stdout, stderr: output.stderr, exitCode: output.code },
      ),
      Effect.catch((error) => {
        if (error._tag === "ProcessSpawnError") {
          if (missingReported.has(input.command)) return Effect.succeed(null);
          missingReported.add(input.command);
        }
        return Effect.logWarning("local plugin command failed", {
          program: input.command,
          reason: error._tag,
        }).pipe(Effect.as(null));
      }),
    );
});

export const runLocalJson = Effect.fn("PluginCards.runLocalJson")(function* <
  S extends Schema.ConstraintDecoder<unknown>,
>(schema: S, input: LocalCommandInput) {
  const result = yield* runLocalCommand(input);
  if (result === null || result.exitCode !== 0) return null;
  const decoded = Schema.decodeOption(Schema.fromJsonString(schema))(result.stdout);
  if (Option.isSome(decoded)) return decoded.value;
  yield* Effect.logWarning("local plugin command printed output that did not decode", {
    program: input.command,
  });
  return null;
});
