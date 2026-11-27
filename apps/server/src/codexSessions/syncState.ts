import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";

// A JSON file, not a table: a fork migration in the shared ledger would collide with upstream's.
const SYNC_STATE_FILE = "codex-sessions.json";

const CodexRun = Schema.Struct({
  filePath: Schema.NullOr(Schema.String),
  inode: Schema.Number,
  offset: Schema.Number,
  state: Schema.Literals(["tailing", "done", "unmatched"]),
  parentThreadId: ThreadId,
});
export type CodexRun = typeof CodexRun.Type;

const SyncStateFile = Schema.Struct({
  runs: Schema.Record(Schema.String, CodexRun),
});
export type SyncState = typeof SyncStateFile.Type;

const decodeSyncState = Schema.decodeUnknownOption(Schema.fromJsonString(SyncStateFile));
const encodeSyncState = Schema.encodeSync(Schema.fromJsonString(SyncStateFile));

const EMPTY_SYNC_STATE: SyncState = { runs: {} };

export class CodexSessionSyncStateWriteError extends Schema.TaggedError<CodexSessionSyncStateWriteError>()(
  "CodexSessionSyncStateWriteError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to write the Codex session sync state.";
  }
}

/** A missing or unreadable file reads as empty. */
export const readSyncState = Effect.fn("CodexSessionSyncState.read")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contents = yield* fs
    .readFileString(path.join(stateDir, SYNC_STATE_FILE))
    .pipe(Effect.option);
  return Option.isNone(contents)
    ? EMPTY_SYNC_STATE
    : Option.getOrElse(decodeSyncState(contents.value), () => EMPTY_SYNC_STATE);
});

/** Writes a temp file and renames it over the old one, so a crash leaves either whole file. */
export const writeSyncState = Effect.fn("CodexSessionSyncState.write")(function* (
  stateDir: string,
  state: SyncState,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(stateDir, SYNC_STATE_FILE);
  const temp = `${target}.${(yield* Random.nextInt).toString(36)}.tmp`;
  yield* fs.writeFileString(temp, encodeSyncState(state)).pipe(
    Effect.andThen(fs.rename(temp, target)),
    Effect.onError(() => fs.remove(temp, { force: true }).pipe(Effect.ignore)),
    Effect.mapError((cause) => new CodexSessionSyncStateWriteError({ path: target, cause })),
  );
});
