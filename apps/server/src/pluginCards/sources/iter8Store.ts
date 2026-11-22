// @effect-diagnostics nodeBuiltinImport:off - iter8's store is a plain SQLite file the server does not own.
import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface Iter8Anchor {
  readonly name: string | null;
  readonly text: string | null;
}

export interface Iter8Note {
  readonly id: string;
  readonly body: string;
  /** `You` for the user, the agent's name for an agent, null when the record names no one. */
  readonly author: string | null;
  readonly anchor: Iter8Anchor | null;
  readonly captureUrl: string | null;
  readonly open: boolean;
}

export interface Iter8Round {
  readonly id: string;
  readonly pageId: string;
  readonly port: number;
  readonly notes: ReadonlyArray<Iter8Note>;
}

const optionalText = Schema.optionalKey(Schema.NullOr(Schema.String));
const AnchorJson = Schema.Struct({ name: optionalText, text: optionalText });
const AuthorJson = Schema.Struct({ kind: Schema.String, name: optionalText });
const TargetJson = Schema.Struct({
  kind: Schema.String,
  anchor: Schema.optionalKey(AnchorJson),
  anchors: Schema.optionalKey(Schema.Array(AnchorJson)),
});
const CaptureJson = Schema.Struct({ url: optionalText });
const ResolutionJson = Schema.Struct({ status: Schema.String });

const decodeAuthor = Schema.decodeUnknownOption(Schema.fromJsonString(AuthorJson));
const decodeTarget = Schema.decodeUnknownOption(Schema.fromJsonString(TargetJson));
const decodeCapture = Schema.decodeUnknownOption(Schema.fromJsonString(CaptureJson));
const decodeResolution = Schema.decodeUnknownOption(Schema.fromJsonString(ResolutionJson));

const nonEmpty = (value: string | null | undefined) =>
  value === undefined || value === null || value === "" ? null : value;

type Row = Record<string, unknown>;

const asCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const anchorOf = (target: Option.Option<typeof TargetJson.Type>): Iter8Anchor | null => {
  if (Option.isNone(target)) return null;
  const { kind, anchor, anchors } = target.value;
  const found = kind === "element" ? anchor : kind === "elements" ? anchors?.[0] : undefined;
  if (found === undefined) return null;
  return { name: nonEmpty(found.name), text: nonEmpty(found.text) };
};

/** A note without a readable id, body or resolution is dropped; author, target and capture are optional detail. */
const toNote = (row: Row): Iter8Note | null => {
  const { id, body, author_json, target_json, capture_json, resolution_json } = row;
  if (typeof id !== "string" || typeof body !== "string") return null;
  if (typeof resolution_json !== "string") return null;
  const resolution = decodeResolution(resolution_json);
  if (Option.isNone(resolution)) return null;
  const author = typeof author_json === "string" ? decodeAuthor(author_json) : Option.none();
  const capture = typeof capture_json === "string" ? decodeCapture(capture_json) : Option.none();
  const target = typeof target_json === "string" ? decodeTarget(target_json) : Option.none();
  const authorName = Option.isNone(author)
    ? null
    : author.value.kind === "user"
      ? "You"
      : nonEmpty(author.value.name);
  return {
    id,
    body,
    author: authorName,
    anchor: anchorOf(target),
    captureUrl: Option.isSome(capture) ? nonEmpty(capture.value.url) : null,
    open: resolution.value.status === "open",
  };
};

/**
 * Reads one round with its notes, opening the store read-only per call and closing it after.
 * `null` when the round is absent, or when the file, a table or a column the reader uses is missing.
 */
export const readRound = Effect.fn("PluginCards.iter8.readRound")(function* (
  dbPath: string,
  roundId: string,
) {
  const read = Effect.acquireUseRelease(
    Effect.try({
      try: () => new NodeSqlite.DatabaseSync(dbPath, { readOnly: true }),
      catch: asCause,
    }),
    (db) =>
      Effect.try({
        try: () => {
          const round = db.prepare("SELECT id, page_id FROM rounds WHERE id = ?").get(roundId);
          if (round === undefined || typeof round.page_id !== "string") return null;
          const page = db.prepare("SELECT port FROM pages WHERE id = ?").get(round.page_id);
          if (page === undefined || typeof page.port !== "number") return null;
          const rows = db
            .prepare(
              "SELECT id, body, author_json, target_json, capture_json, resolution_json FROM notes WHERE round_id = ? ORDER BY ordinal",
            )
            .all(roundId);
          return { id: roundId, pageId: round.page_id, port: page.port, rows };
        },
        catch: asCause,
      }),
    (db) => Effect.try({ try: () => db.close(), catch: asCause }).pipe(Effect.ignore),
  );

  const found = yield* read.pipe(
    Effect.catch((reason) =>
      Effect.logWarning("iter8 store could not be read", { path: dbPath, reason }).pipe(
        Effect.as(null),
      ),
    ),
  );
  if (found === null) return null;

  const notes: Array<Iter8Note> = [];
  for (const row of found.rows) {
    const note = toNote(row);
    if (note !== null) notes.push(note);
    else {
      yield* Effect.logWarning("iter8 note skipped: unreadable record", {
        path: dbPath,
        note: typeof row.id === "string" ? row.id : null,
      });
    }
  }
  return { id: found.id, pageId: found.pageId, port: found.port, notes } satisfies Iter8Round;
});
