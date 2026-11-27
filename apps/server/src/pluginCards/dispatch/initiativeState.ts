import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../../processRunner.ts";

// dp is Go, so an empty list arrives as null.
const nullableStrings = Schema.NullOr(Schema.Array(Schema.String));
const optionalText = Schema.optionalKey(Schema.NullOr(Schema.String));

const InitiativeShow = Schema.Struct({
  initiative: Schema.Struct({ slug: Schema.String, title: Schema.String, repos: nullableStrings }),
  parts: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        repo: Schema.String,
        zone: nullableStrings,
        wave: Schema.Number,
        status: Schema.String,
      }),
    ),
  ),
  waves: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        number: Schema.Number,
        opened: Schema.Boolean,
        closed: Schema.Boolean,
        parts: nullableStrings,
      }),
    ),
  ),
  progress: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          part: Schema.String,
          lastEventAt: optionalText,
          gate: Schema.optionalKey(
            Schema.NullOr(
              Schema.Struct({ passed: Schema.Boolean, at: optionalText, record: optionalText }),
            ),
          ),
        }),
      ),
    ),
  ),
  deliveries: Schema.optionalKey(
    Schema.NullOr(Schema.Array(Schema.Struct({ part_id: Schema.String, mr: Schema.String }))),
  ),
  closed: Schema.Boolean,
});

const decodeInitiativeShow = Schema.decodeUnknownOption(Schema.fromJsonString(InitiativeShow));

export interface DispatchInitiativeState {
  readonly initiative: {
    readonly slug: string;
    readonly title: string;
    readonly repos: ReadonlyArray<string>;
  };
  readonly parts: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly repo: string;
    readonly zone: ReadonlyArray<string>;
    readonly wave: number;
    readonly status: string;
  }>;
  readonly waves: ReadonlyArray<{
    readonly number: number;
    readonly opened: boolean;
    readonly closed: boolean;
    readonly parts: ReadonlyArray<string>;
  }>;
  readonly progress: ReadonlyArray<{
    readonly part: string;
    readonly lastEventAt: string | null;
    readonly gate: {
      readonly passed: boolean;
      readonly at: string | null;
      readonly record: string | null;
    } | null;
  }>;
  readonly deliveries: ReadonlyArray<{ readonly part: string; readonly mr: string }>;
  readonly closed: boolean;
}

/** Runs `dp initiative show`, never `dp status show`, which rewrites the live registry entry. */
export const readInitiativeState = Effect.fn("DispatchReader.readInitiativeState")(function* (
  slug: string,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const dp = yield* resolveCommandPath("dp");
  if (dp === null) return null;
  const output = yield* runner
    .run({
      command: dp,
      args: ["initiative", "show", slug, "--json"],
      timeout: Duration.seconds(15),
    })
    .pipe(Effect.option);
  if (Option.isNone(output) || output.value.code !== 0) return null;
  const decoded = decodeInitiativeShow(output.value.stdout);
  if (Option.isNone(decoded)) {
    yield* Effect.logWarning("dp initiative show returned unreadable JSON", { slug });
    return null;
  }
  const state = decoded.value;
  return {
    initiative: { ...state.initiative, repos: state.initiative.repos ?? [] },
    parts: (state.parts ?? []).map((part) => ({ ...part, zone: part.zone ?? [] })),
    waves: (state.waves ?? []).map((wave) => ({ ...wave, parts: wave.parts ?? [] })),
    progress: (state.progress ?? []).map(({ part, lastEventAt, gate }) => ({
      part,
      lastEventAt: lastEventAt ?? null,
      gate: gate ? { passed: gate.passed, at: gate.at ?? null, record: gate.record ?? null } : null,
    })),
    deliveries: (state.deliveries ?? []).map(({ part_id, mr }) => ({ part: part_id, mr })),
    closed: state.closed,
  } satisfies DispatchInitiativeState as DispatchInitiativeState;
});
