import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";

// A JSON file, not a table: a fork migration in the shared ledger would collide with upstream's.
// The state is a cache; losing it costs a re-read from byte 0, which uuid ids make idempotent.
const SYNC_STATE_FILE = "cli-session-sync.json";

const SyncedSession = Schema.Struct({
  threadId: ThreadId,
  filePath: Schema.String,
  inode: Schema.Number,
  offset: Schema.Number,
  syncedTitle: Schema.NullOr(Schema.String),
  pane: Schema.NullOr(
    Schema.Struct({
      socket: Schema.String,
      pane: Schema.String,
      name: Schema.NullOr(Schema.String),
    }),
  ),
});
export type SyncedSession = typeof SyncedSession.Type;

const SyncStateFile = Schema.Struct({
  version: Schema.Literal(1),
  backfilledAt: Schema.NullOr(Schema.String),
  sessions: Schema.Record(Schema.String, SyncedSession),
});
export type SyncState = typeof SyncStateFile.Type;

const decodeSyncState = Schema.decodeUnknownOption(Schema.fromJsonString(SyncStateFile));
const encodeSyncState = Schema.encodeSync(Schema.fromJsonString(SyncStateFile));

const EMPTY_SYNC_STATE: SyncState = { version: 1, backfilledAt: null, sessions: {} };

export class CliSessionSyncStateWriteError extends Schema.TaggedError<CliSessionSyncStateWriteError>()(
  "CliSessionSyncStateWriteError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to write the CLI session sync state.";
  }
}

/** A missing or unreadable file reads as empty. */
export const readSyncState = Effect.fn("CliSessionSyncState.read")(function* (stateDir: string) {
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
export const writeSyncState = Effect.fn("CliSessionSyncState.write")(function* (
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
    Effect.mapError((cause) => new CliSessionSyncStateWriteError({ path: target, cause })),
  );
});
