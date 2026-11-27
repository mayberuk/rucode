// @effect-diagnostics nodeBuiltinImport:off - a caller-set Host header needs node:http; fetch implementations may drop it.
import * as NodeHttp from "node:http";

import {
  type Iter8CreateNoteInput,
  type Iter8ElementAnchor,
  Iter8ReviewError,
  Iter8SendRefusal,
  type Iter8SendRoundResult,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const REQUEST_TIMEOUT = Duration.seconds(5);
const DEFAULT_HOST = "127.0.0.1";
const DRAFTS_PATH = "/__iter8/drafts";
const ROUNDS_PATH = "/__iter8/rounds";
const TOKEN_HEADER = "x-iter8-token";

export interface Iter8OverlayTarget {
  readonly pageId: string;
  readonly port: number;
  readonly token: string;
  /** Where to connect; the Host header always names the page. Defaults to 127.0.0.1. */
  readonly host?: string;
}

export type Iter8DraftAnchor = Iter8ElementAnchor & { readonly renderGeneration: number };

/**
 * A draft made in iter8's own overlay can target a region, several elements or an iter8 part; those
 * targets pass through untouched so editing such a draft keeps its target.
 */
export type Iter8DraftTarget =
  | { readonly kind: "element"; readonly anchor: Iter8DraftAnchor }
  | { readonly kind: "elements" | "region" | "iter8"; readonly [key: string]: unknown };

/** iter8's `DraftBody`: the fields a person authors; iter8 owns id, page, author and resolution. */
export interface Iter8DraftBody {
  readonly intent: Iter8CreateNoteInput["intent"];
  readonly body: string;
  readonly target: Iter8DraftTarget;
  readonly anchorStatus: "anchored" | "moved" | "unanchored";
  readonly capture?: unknown;
}

export interface Iter8DraftNote {
  readonly id: string;
  readonly draft: Iter8DraftBody;
}

const DraftAnchor = Schema.Struct({
  selector: Schema.NonEmptyArray(Schema.String),
  role: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  box: Schema.Struct({
    x: Schema.Number,
    y: Schema.Number,
    width: Schema.Number,
    height: Schema.Number,
  }),
  renderGeneration: Schema.Number,
});

const DraftTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("element"), anchor: DraftAnchor }),
  Schema.StructWithRest(Schema.Struct({ kind: Schema.Literals(["elements", "region", "iter8"]) }), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]),
]);

const DraftNoteJson = Schema.Struct({
  id: Schema.String,
  author: Schema.Struct({ kind: Schema.String }),
  intent: Schema.Literals(["fix", "change", "question", "keep"]),
  body: Schema.String,
  target: DraftTarget,
  anchorStatus: Schema.Literals(["anchored", "moved", "unanchored"]),
  capture: Schema.optionalKey(Schema.Unknown),
});

const NoteIdJson = Schema.Struct({ id: Schema.String });
const OkJson = Schema.Struct({ ok: Schema.Literal(true) });
const SendResultJson = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("accepted"),
    round: Schema.Struct({ id: Schema.String }),
  }),
  Schema.Struct({ outcome: Schema.Literal("refused"), reason: Iter8SendRefusal }),
]);

const decodeDraftList = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(DraftNoteJson)),
);
const decodeNoteId = Schema.decodeUnknownOption(Schema.fromJsonString(NoteIdJson));
const decodeOk = Schema.decodeUnknownOption(Schema.fromJsonString(OkJson));
const decodeSendResult = Schema.decodeUnknownOption(Schema.fromJsonString(SendResultJson));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

type Method = "GET" | "POST" | "PUT" | "DELETE";

interface Route {
  readonly method: Method;
  readonly path: string;
  /** A 404 on a route that names a note means the note, not the page, is unknown. */
  readonly namesNote: boolean;
}

const fail = (
  target: Iter8OverlayTarget,
  reason: Iter8ReviewError["reason"],
  detail: string,
): Effect.Effect<never, Iter8ReviewError> =>
  Effect.fail(
    new Iter8ReviewError({
      reason,
      detail: target.token === "" ? detail : detail.replaceAll(target.token, "[redacted]"),
    }),
  );

const routeLabel = (route: Route) => `${route.method} ${route.path}`;

const exchange = (
  target: Iter8OverlayTarget,
  route: Route,
  payload: string | undefined,
): Effect.Effect<{ readonly status: number; readonly text: string }, Iter8ReviewError> =>
  Effect.callback<{ readonly status: number; readonly text: string }, Iter8ReviewError>(
    (resume, signal) => {
      const pageHost = `${target.pageId}.localhost:${target.port}`;
      const request = NodeHttp.request(
        {
          host: target.host ?? DEFAULT_HOST,
          port: target.port,
          method: route.method,
          path: route.path,
          signal,
          headers: {
            host: pageHost,
            origin: `http://${pageHost}`,
            [TOKEN_HEADER]: target.token,
            ...(payload === undefined ? {} : { "content-type": "application/json" }),
          },
        },
        (response) => {
          const chunks: Array<Buffer> = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.once("error", (cause) =>
            resume(fail(target, "unavailable", `${routeLabel(route)}: ${cause.message}`)),
          );
          response.once("end", () =>
            resume(
              Effect.succeed({
                status: response.statusCode ?? 0,
                text: Buffer.concat(chunks).toString("utf8"),
              }),
            ),
          );
        },
      );
      request.once("error", (cause) =>
        resume(fail(target, "unavailable", `${routeLabel(route)}: ${cause.message}`)),
      );
      request.end(payload);
    },
  ).pipe(
    Effect.timeoutOrElse({
      duration: REQUEST_TIMEOUT,
      orElse: () =>
        fail(
          target,
          "unavailable",
          `${routeLabel(route)}: no response within ${Duration.format(REQUEST_TIMEOUT)}`,
        ),
    }),
  );

// Untraced: every caller is an exported Effect.fn whose span already covers this request.
const call = Effect.fnUntraced(function* <A>(
  target: Iter8OverlayTarget,
  route: Route,
  body: unknown,
  decode: (text: string) => Option.Option<A>,
) {
  const payload = body === undefined ? undefined : yield* encodeJson(body).pipe(Effect.orDie);
  const { status, text } = yield* exchange(target, route, payload);
  const at = `${routeLabel(route)} answered ${status}`;
  if (status === 401 || status === 403) return yield* fail(target, "rejected", at);
  if (status === 404) {
    return yield* fail(target, route.namesNote ? "unknown-note" : "unknown-page", at);
  }
  if (status >= 500) return yield* fail(target, "unavailable", at);
  if (status < 200 || status >= 300) return yield* fail(target, "incompatible", at);
  const decoded = decode(text);
  if (Option.isNone(decoded)) {
    return yield* fail(target, "incompatible", `${at} with a body it cannot decode`);
  }
  return decoded.value;
});

const draftPath = (noteId: string) => `${DRAFTS_PATH}/${encodeURIComponent(noteId)}`;

/** The page's user drafts; drafts another author wrote are left out. */
export const listDrafts = Effect.fn("Iter8Review.listDrafts")(function* (
  target: Iter8OverlayTarget,
) {
  const notes = yield* call(
    target,
    { method: "GET", path: DRAFTS_PATH, namesNote: false },
    undefined,
    decodeDraftList,
  );
  return notes.flatMap((note): ReadonlyArray<Iter8DraftNote> => {
    if (note.author.kind !== "user") return [];
    const draft: Iter8DraftBody = {
      intent: note.intent,
      body: note.body,
      target: note.target,
      anchorStatus: note.anchorStatus,
      ...(note.capture === undefined ? {} : { capture: note.capture }),
    };
    return [{ id: note.id, draft }];
  });
});

export const createDraft = Effect.fn("Iter8Review.createDraft")(function* (
  target: Iter8OverlayTarget,
  body: Iter8DraftBody,
) {
  const note = yield* call(
    target,
    { method: "POST", path: DRAFTS_PATH, namesNote: false },
    body,
    decodeNoteId,
  );
  return note.id;
});

export const putDraft = Effect.fn("Iter8Review.putDraft")(function* (
  target: Iter8OverlayTarget,
  noteId: string,
  body: Iter8DraftBody,
) {
  yield* call(
    target,
    { method: "PUT", path: draftPath(noteId), namesNote: true },
    body,
    decodeNoteId,
  );
});

export const deleteDraft = Effect.fn("Iter8Review.deleteDraft")(function* (
  target: Iter8OverlayTarget,
  noteId: string,
) {
  yield* call(
    target,
    { method: "DELETE", path: draftPath(noteId), namesNote: true },
    undefined,
    decodeOk,
  );
});

/**
 * Sends the named drafts as one round. iter8 answers 404 when a named note is no longer a draft
 * of the page, so a 404 here reports the note as unknown.
 */
export const sendRound = Effect.fn("Iter8Review.sendRound")(function* (
  target: Iter8OverlayTarget,
  input: {
    readonly idempotencyKey: string;
    readonly noteIds: ReadonlyArray<string>;
    readonly generation: number;
  },
) {
  const result = yield* call(
    target,
    { method: "POST", path: ROUNDS_PATH, namesNote: true },
    {
      idempotencyKey: input.idempotencyKey,
      noteIds: input.noteIds,
      generation: input.generation,
    },
    decodeSendResult,
  );
  const sent: Iter8SendRoundResult =
    result.outcome === "accepted"
      ? { outcome: "accepted", roundId: result.round.id }
      : { outcome: "refused", reason: result.reason };
  return sent;
});

/** Picks carry no landmark, text, styles, console, screenshot or source lead, so the capture says so. */
export const draftBodyFromCreateInput = (input: Iter8CreateNoteInput): Iter8DraftBody => ({
  intent: input.intent,
  body: input.body,
  target: { kind: "element", anchor: { ...input.anchor, renderGeneration: 0 } },
  anchorStatus: "anchored",
  capture: {
    completeness: "partial",
    omittedParts: [
      "landmark",
      "surroundingText",
      "computedStyles",
      "consoleErrors",
      "screenshot",
      "sourceLead",
    ],
    url: input.url,
    viewport: input.viewport,
    theme: input.theme,
  },
});
