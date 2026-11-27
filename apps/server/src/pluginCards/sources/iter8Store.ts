// @effect-diagnostics nodeBuiltinImport:off - iter8's store is a plain SQLite file the server does not own.
import * as NodeSqlite from "node:sqlite";

import {
  Iter8Intent,
  type Iter8Note as Iter8ReviewNote,
  type Iter8NoteStatus,
  type Iter8Page,
  type Iter8ReviewSnapshot,
  type Iter8Round as Iter8ReviewRound,
  Iter8RoundStage,
  type Iter8Session,
} from "@t3tools/contracts";
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

export const resolveIter8DbPath = (
  home: string,
  iter8Home: string | undefined,
  join: (...parts: string[]) => string,
): string =>
  iter8Home === undefined || iter8Home === ""
    ? join(home, ".iter8", "iter8.db")
    : join(iter8Home, "iter8.db");

const openReadOnly = <A>(dbPath: string, use: (db: NodeSqlite.DatabaseSync) => A) =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => new NodeSqlite.DatabaseSync(dbPath, { readOnly: true }),
      catch: asCause,
    }),
    (db) => Effect.try({ try: () => use(db), catch: asCause }),
    (db) => Effect.try({ try: () => db.close(), catch: asCause }).pipe(Effect.ignore),
  );

const SnapshotAuthorJson = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user") }),
  Schema.Struct({ kind: Schema.Literal("agent"), name: Schema.String }),
]);
const SnapshotAnchorJson = Schema.Struct({
  name: optionalText,
  selector: Schema.optionalKey(Schema.Array(Schema.String)),
});
const SnapshotTargetJson = Schema.Struct({
  kind: Schema.String,
  anchor: Schema.optionalKey(SnapshotAnchorJson),
  anchors: Schema.optionalKey(Schema.Array(SnapshotAnchorJson)),
});
const SnapshotResolutionJson = Schema.Union([
  Schema.Struct({ status: Schema.Literal("open") }),
  Schema.Struct({ status: Schema.Literal("done") }),
  Schema.Struct({ status: Schema.Literal("answered"), reply: Schema.String }),
]);
const RoundStateJson = Schema.Struct({ stage: Iter8RoundStage });

const decodeSnapshotAuthor = Schema.decodeUnknownOption(Schema.fromJsonString(SnapshotAuthorJson));
const decodeSnapshotTarget = Schema.decodeUnknownOption(Schema.fromJsonString(SnapshotTargetJson));
const decodeSnapshotResolution = Schema.decodeUnknownOption(
  Schema.fromJsonString(SnapshotResolutionJson),
);
const decodeRoundState = Schema.decodeUnknownOption(Schema.fromJsonString(RoundStateJson));
const decodeIntent = Schema.decodeUnknownOption(Iter8Intent);

const UNAVAILABLE: Iter8ReviewSnapshot = { available: false, sessions: [], pages: [] };

const elementAnchorOf = (target: typeof SnapshotTargetJson.Type) =>
  target.kind === "element"
    ? target.anchor
    : target.kind === "elements"
      ? target.anchors?.[0]
      : undefined;

const pathOf = (captureJson: unknown): string | null => {
  if (typeof captureJson !== "string") return null;
  const capture = decodeCapture(captureJson);
  const url = Option.isSome(capture) ? nonEmpty(capture.value.url) : null;
  if (url === null || !URL.canParse(url)) return null;
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};

/** Agent notes never carry a round, so an open one is the agent's message, not the user's draft. */
const statusOf = (
  resolution: typeof SnapshotResolutionJson.Type,
  roundId: string | null,
  isAgent: boolean,
): Iter8NoteStatus => {
  if (resolution.status !== "open") return resolution.status;
  return roundId === null && !isAgent ? "draft" : "sent";
};

const toSnapshotNote = (row: Row): Iter8ReviewNote | null => {
  const { id, page_id, round_id, kind, author_json, intent, body, created_at } = row;
  if (typeof id !== "string" || typeof page_id !== "string" || typeof body !== "string") {
    return null;
  }
  if (typeof created_at !== "string") return null;
  if (round_id !== null && typeof round_id !== "string") return null;
  const parsedIntent = decodeIntent(intent);
  const author =
    typeof author_json === "string" ? decodeSnapshotAuthor(author_json) : Option.none();
  const resolution =
    typeof row.resolution_json === "string"
      ? decodeSnapshotResolution(row.resolution_json)
      : Option.none();
  if (Option.isNone(parsedIntent) || Option.isNone(author) || Option.isNone(resolution)) {
    return null;
  }
  const isAgent = kind === "agent";
  const target =
    typeof row.target_json === "string" ? decodeSnapshotTarget(row.target_json) : Option.none();
  const anchor = Option.isSome(target) ? elementAnchorOf(target.value) : undefined;
  const hops = anchor?.selector ?? [];
  return {
    id,
    pageId: page_id,
    roundId: round_id,
    author: author.value,
    intent: parsedIntent.value,
    body,
    selector: isAgent ? [] : hops,
    anchorLabel: nonEmpty(anchor?.name) ?? nonEmpty(hops.at(-1)),
    path: pathOf(row.capture_json),
    status: statusOf(resolution.value, round_id, isAgent),
    reply: resolution.value.status === "answered" ? resolution.value.reply : null,
    createdAt: created_at,
  };
};

const toSession = (row: Row, pageIds: ReadonlyArray<string>): Iter8Session | null => {
  const { id, agent, label, cwd, busy, gone_reason } = row;
  if (typeof id !== "string" || typeof agent !== "string") return null;
  if (typeof label !== "string" || typeof cwd !== "string") return null;
  const state = gone_reason !== null ? "gone" : busy === 1 ? "busy" : "live";
  return { ownerId: id, agent, label, cwd, state, pageIds };
};

/**
 * Reads every iter8 session, page, round and note, opening the store read-only and closing it
 * after. Unavailable, with one warning, when the file, a table or a column the reader uses is missing.
 */
export const readReviewSnapshot = Effect.fn("PluginCards.iter8.readReviewSnapshot")(function* (
  dbPath: string,
) {
  const found = yield* openReadOnly(dbPath, (db) => ({
    owners: db
      .prepare("SELECT id, agent, label, cwd, busy, gone_reason FROM owners ORDER BY rowid")
      .all(),
    pages: db
      .prepare(
        "SELECT id, project_root, port, owner_id, created_at FROM pages ORDER BY created_at DESC, rowid DESC",
      )
      .all(),
    rounds: db
      .prepare("SELECT id, page_id, state_json, created_at FROM rounds ORDER BY created_at, rowid")
      .all(),
    notes: db
      .prepare(
        "SELECT id, page_id, round_id, kind, ordinal, author_json, intent, body, target_json, capture_json, resolution_json, created_at FROM notes ORDER BY ordinal, rowid",
      )
      .all(),
  })).pipe(
    Effect.catch((reason) =>
      Effect.logWarning("iter8 store could not be read", { path: dbPath, reason }).pipe(
        Effect.as(null),
      ),
    ),
  );
  if (found === null) return UNAVAILABLE;

  const notesByPage = new Map<string, Array<Iter8ReviewNote>>();
  for (const row of found.notes) {
    const note = toSnapshotNote(row);
    if (note === null) {
      yield* Effect.logWarning("iter8 note skipped: unreadable record", {
        path: dbPath,
        note: typeof row.id === "string" ? row.id : null,
      });
      continue;
    }
    notesByPage.set(note.pageId, [...(notesByPage.get(note.pageId) ?? []), note]);
  }

  const roundsByPage = new Map<string, Array<Iter8ReviewRound>>();
  for (const row of found.rounds) {
    const { id, page_id, state_json, created_at } = row;
    const state = typeof state_json === "string" ? decodeRoundState(state_json) : Option.none();
    if (
      typeof id !== "string" ||
      typeof page_id !== "string" ||
      typeof created_at !== "string" ||
      Option.isNone(state)
    ) {
      yield* Effect.logWarning("iter8 round skipped: unreadable record", {
        path: dbPath,
        round: typeof id === "string" ? id : null,
      });
      continue;
    }
    const noteCount = (notesByPage.get(page_id) ?? []).filter((note) => note.roundId === id).length;
    const round = {
      id,
      pageId: page_id,
      stage: state.value.stage,
      noteCount,
      createdAt: created_at,
    };
    roundsByPage.set(page_id, [...(roundsByPage.get(page_id) ?? []), round]);
  }

  const pages: Array<Iter8Page> = [];
  for (const row of found.pages) {
    const { id, project_root, port, owner_id } = row;
    if (
      typeof id !== "string" ||
      typeof project_root !== "string" ||
      typeof port !== "number" ||
      (owner_id !== null && typeof owner_id !== "string")
    ) {
      yield* Effect.logWarning("iter8 page skipped: unreadable record", {
        path: dbPath,
        page: typeof id === "string" ? id : null,
      });
      continue;
    }
    pages.push({
      id,
      origin: `http://${id}.localhost:${port}`,
      projectRoot: project_root,
      ownerId: owner_id,
      rounds: roundsByPage.get(id) ?? [],
      notes: notesByPage.get(id) ?? [],
    });
  }

  const sessions: Array<Iter8Session> = [];
  for (const row of found.owners) {
    const pageIds = pages.flatMap((page) => (page.ownerId === row.id ? [page.id] : []));
    const session = toSession(row, pageIds);
    if (session === null) {
      yield* Effect.logWarning("iter8 session skipped: unreadable record", {
        path: dbPath,
        owner: typeof row.id === "string" ? row.id : null,
      });
      continue;
    }
    if (session.state !== "gone" || pageIds.length > 0) sessions.push(session);
  }

  return { available: true, sessions, pages } satisfies Iter8ReviewSnapshot;
});

export interface Iter8PageAccess {
  readonly pageId: string;
  readonly port: number;
  readonly token: string;
  readonly generation: number;
  readonly ownerId: string | null;
}

/** The page's port, token and pairing generation; null when the page or the store is unreadable. */
export const readPageAccess = Effect.fn("PluginCards.iter8.readPageAccess")(function* (
  dbPath: string,
  pageId: string,
) {
  const row = yield* openReadOnly(dbPath, (db) =>
    db.prepare("SELECT id, port, token, generation, owner_id FROM pages WHERE id = ?").get(pageId),
  ).pipe(
    Effect.catch((reason) =>
      Effect.logWarning("iter8 store could not be read", { path: dbPath, reason }).pipe(
        Effect.as(undefined),
      ),
    ),
  );
  if (row === undefined) return null;
  const { port, token, generation, owner_id } = row;
  if (typeof port !== "number" || typeof token !== "string" || typeof generation !== "number") {
    return null;
  }
  if (owner_id !== null && typeof owner_id !== "string") return null;
  return { pageId, port, token, generation, ownerId: owner_id } satisfies Iter8PageAccess;
});
