import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

// Registry files written by older dp builds lack the orchestrator fields and totalCostState.
export const DispatchLiveInitiative = Schema.Struct({
  slug: Schema.String,
  orchestratorSession: Schema.optionalKey(Schema.String),
  orchestratorCwd: Schema.optionalKey(Schema.String),
  orchestratorPid: Schema.optionalKey(Schema.Number),
  closed: Schema.Boolean,
  totalWave: Schema.Number,
  totalRunning: Schema.Number,
  totalSettled: Schema.Number,
  totalCostUsd: Schema.Number,
  totalCostState: Schema.optionalKey(Schema.String),
  reportedCostUsd: Schema.Number,
  orchestratorCostUsd: Schema.optionalKey(Schema.Number),
  started: Schema.String,
  touched: Schema.String,
  liveUntil: Schema.String,
  repos: Schema.optionalKey(
    Schema.Array(Schema.Struct({ root: Schema.String, worktrees: Schema.Array(Schema.String) })),
  ),
  parts: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        wave: Schema.Number,
        running: Schema.Number,
        settled: Schema.Number,
        costUsd: Schema.Number,
        costState: Schema.String,
        costByChild: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
      }),
    ),
  ),
});
export type DispatchLiveInitiative = typeof DispatchLiveInitiative.Type;

const decodeInitiative = Schema.decodeUnknownOption(Schema.fromJsonString(DispatchLiveInitiative));

/** Reads `<initiativesRoot>/.live/*.json`, where `initiativesRoot` is `~/.claude/initiatives`. */
export const listLiveInitiatives = Effect.fn("DispatchReader.listLiveInitiatives")(function* (
  initiativesRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(initiativesRoot, ".live");
  const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
  const initiatives: Array<DispatchLiveInitiative> = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).toSorted()) {
    const file = path.join(directory, name);
    const initiative = yield* fs
      .readFileString(file)
      .pipe(Effect.map(decodeInitiative), Effect.orElseSucceed(Option.none));
    if (Option.isNone(initiative)) {
      yield* Effect.logWarning("dispatch live registry entry is unreadable", { path: file });
      continue;
    }
    initiatives.push(initiative.value);
  }
  return initiatives as ReadonlyArray<DispatchLiveInitiative>;
});
