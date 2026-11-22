import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const feedRow = <const Event extends string, Fields extends Schema.Struct.Fields>(
  event: Event,
  fields: Fields,
) =>
  Schema.Struct({
    schema: Schema.Literal("dp-run/1"),
    ts: Schema.String,
    event: Schema.Literal(event),
    ...fields,
  });

const optionalString = Schema.optionalKey(Schema.String);

export const DispatchRunFeedRow = Schema.Union([
  feedRow("run-opened", {
    run: Schema.String,
    dir: Schema.String,
    part: Schema.String,
    wave: Schema.Number,
    spec: Schema.String,
    pid: Schema.Number,
    phases: Schema.Number,
    initiative: optionalString,
    request: optionalString,
  }),
  feedRow("run-settled", {
    run: Schema.String,
    dir: Schema.String,
    part: Schema.String,
    wave: Schema.Number,
    pid: Schema.Number,
    outcome: Schema.String,
    reason: optionalString,
    request: optionalString,
  }),
  feedRow("decision-raised", {
    id: Schema.String,
    dir: Schema.String,
    kind: Schema.String,
    part: Schema.String,
    wave: Schema.Number,
    default: optionalString,
    apply_after: optionalString,
    needs_person: Schema.optionalKey(Schema.Boolean),
    initiative: optionalString,
    obligation: optionalString,
    phase: optionalString,
    protection: optionalString,
  }),
  feedRow("decision-resolved", {
    id: Schema.String,
    dir: Schema.String,
    kind: Schema.String,
    part: Schema.String,
    wave: Schema.Number,
    state: Schema.String,
    choice: optionalString,
    chosen_by: Schema.String,
    chosen_via: optionalString,
    quote: optionalString,
    phase: optionalString,
    protection: optionalString,
    grant: optionalString,
  }),
]);
export type DispatchRunFeedRow = typeof DispatchRunFeedRow.Type;

const decodeRow = Schema.decodeUnknownOption(Schema.fromJsonString(DispatchRunFeedRow));

/** `ino` is null where the platform reports no inode; rotation is then invisible to the reader. */
export interface RunFeedCursor {
  readonly ino: string | null;
  readonly offset: number;
}

const under = (base: string, relative: string) => `${base.replace(/\/+$/, "")}/${relative}`;

export function runFeedPath(env: NodeJS.ProcessEnv, home: string): string {
  if (env.DP_RUN_FEED) return env.DP_RUN_FEED;
  if (env.XDG_STATE_HOME) return under(env.XDG_STATE_HOME, "dispatch/runs.jsonl");
  return under(home, ".local/state/dispatch/runs.jsonl");
}

const NEWLINE = 0x0a;
const utf8 = new TextDecoder();

/**
 * Reads the newline-terminated lines from byte `offset` to the end of the file. A trailing line
 * with no newline is left unread so a half-written row is read whole next time.
 */
export const readCompleteLines = Effect.fn("DispatchReader.readCompleteLines")(function* (
  path: string,
  offset: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const bytes = yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(path);
      const size = Number((yield* file.stat).size);
      const chunks: Array<Uint8Array> = [];
      let position = offset;
      while (position < size) {
        const chunk = yield* file.readAlloc(size - position, { position: BigInt(position) });
        if (Option.isNone(chunk) || chunk.value.byteLength === 0) break;
        chunks.push(chunk.value);
        position += chunk.value.byteLength;
      }
      return Buffer.concat(chunks);
    }),
  ).pipe(Effect.orElseSucceed(() => Buffer.alloc(0)));
  const end = bytes.lastIndexOf(NEWLINE);
  if (end === -1) return { lines: [] as ReadonlyArray<string>, nextOffset: offset };
  const lines = utf8
    .decode(bytes.subarray(0, end))
    .split("\n")
    .filter((line) => line.trim() !== "");
  return { lines: lines as ReadonlyArray<string>, nextOffset: offset + end + 1 };
});

const fileIno = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(path).pipe(Effect.option);
  if (Option.isNone(info)) return Option.none<{ ino: string | null; size: number }>();
  return Option.some({
    ino: Option.match(info.value.ino, { onNone: () => null, onSome: String }),
    size: Number(info.value.size),
  });
});

const readRows = Effect.fnUntraced(function* (path: string, offset: number) {
  const { lines, nextOffset } = yield* readCompleteLines(path, offset);
  const rows = lines.flatMap((line) => Option.toArray(decodeRow(line)));
  return { rows, nextOffset };
});

export const readRunFeed = Effect.fn("DispatchReader.readRunFeed")(function* (
  path: string,
  cursor: RunFeedCursor | null,
): Effect.fn.Return<
  { readonly rows: ReadonlyArray<DispatchRunFeedRow>; readonly cursor: RunFeedCursor },
  never,
  FileSystem.FileSystem
> {
  const rotatedRows = Effect.fnUntraced(function* (previous: RunFeedCursor) {
    const none = { rows: [] as ReadonlyArray<DispatchRunFeedRow>, nextOffset: previous.offset };
    if (previous.ino === null) return none;
    const rotated = yield* fileIno(`${path}.1`);
    if (Option.isNone(rotated) || rotated.value.ino !== previous.ino) return none;
    return yield* readRows(`${path}.1`, previous.offset);
  });

  const current = yield* fileIno(path);
  if (Option.isNone(current)) {
    if (cursor === null) return { rows: [], cursor: { ino: null, offset: 0 } };
    const drained = yield* rotatedRows(cursor);
    return { rows: drained.rows, cursor: { ino: cursor.ino, offset: drained.nextOffset } };
  }
  const { ino, size } = current.value;
  if (cursor !== null && cursor.ino === ino) {
    const start = size < cursor.offset ? 0 : cursor.offset;
    const read = yield* readRows(path, start);
    return { rows: read.rows, cursor: { ino, offset: read.nextOffset } };
  }
  const drained = cursor === null ? { rows: [] } : yield* rotatedRows(cursor);
  const read = yield* readRows(path, 0);
  return {
    rows: [...drained.rows, ...read.rows],
    cursor: { ino, offset: read.nextOffset },
  };
});
