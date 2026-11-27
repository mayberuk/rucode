import * as Schema from "effect/Schema";

export const Iter8Intent = Schema.Literals(["fix", "change", "question", "keep"]);
export type Iter8Intent = typeof Iter8Intent.Type;

/** CSS pixels in page coordinates. */
export const Iter8Box = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
export type Iter8Box = typeof Iter8Box.Type;

export const Iter8Viewport = Schema.Struct({
  width: Schema.Number,
  height: Schema.Number,
  devicePixelRatio: Schema.Number,
});
export type Iter8Viewport = typeof Iter8Viewport.Type;

export const Iter8ElementAnchor = Schema.Struct({
  selector: Schema.NonEmptyArray(Schema.String),
  role: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  box: Iter8Box,
});
export type Iter8ElementAnchor = typeof Iter8ElementAnchor.Type;

export const Iter8PickedTarget = Schema.Struct({
  intent: Iter8Intent,
  anchor: Iter8ElementAnchor,
  viewport: Iter8Viewport,
  theme: Schema.Literals(["light", "dark"]),
});
export type Iter8PickedTarget = typeof Iter8PickedTarget.Type;

export const Iter8NoteStatus = Schema.Literals(["draft", "sent", "done", "answered"]);
export type Iter8NoteStatus = typeof Iter8NoteStatus.Type;

export const Iter8Note = Schema.Struct({
  id: Schema.String,
  pageId: Schema.String,
  roundId: Schema.NullOr(Schema.String),
  author: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("user") }),
    Schema.Struct({ kind: Schema.Literal("agent"), name: Schema.String }),
  ]),
  intent: Iter8Intent,
  body: Schema.String,
  selector: Schema.Array(Schema.String),
  anchorLabel: Schema.NullOr(Schema.String),
  path: Schema.NullOr(Schema.String),
  status: Iter8NoteStatus,
  reply: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type Iter8Note = typeof Iter8Note.Type;

export const Iter8RoundStage = Schema.Literals([
  "draft",
  "queued",
  "announced",
  "claimed",
  "orphaned",
]);
export type Iter8RoundStage = typeof Iter8RoundStage.Type;

export const Iter8Round = Schema.Struct({
  id: Schema.String,
  pageId: Schema.String,
  stage: Iter8RoundStage,
  noteCount: Schema.Number,
  createdAt: Schema.String,
});
export type Iter8Round = typeof Iter8Round.Type;

export const Iter8Page = Schema.Struct({
  id: Schema.String,
  origin: Schema.String,
  projectRoot: Schema.String,
  ownerId: Schema.NullOr(Schema.String),
  rounds: Schema.Array(Iter8Round),
  notes: Schema.Array(Iter8Note),
});
export type Iter8Page = typeof Iter8Page.Type;

export const Iter8SessionState = Schema.Literals(["busy", "live", "gone"]);
export type Iter8SessionState = typeof Iter8SessionState.Type;

export const Iter8Session = Schema.Struct({
  ownerId: Schema.String,
  agent: Schema.String,
  label: Schema.String,
  cwd: Schema.String,
  state: Iter8SessionState,
  pageIds: Schema.Array(Schema.String),
});
export type Iter8Session = typeof Iter8Session.Type;

export const Iter8ReviewSnapshot = Schema.Struct({
  available: Schema.Boolean,
  sessions: Schema.Array(Iter8Session),
  pages: Schema.Array(Iter8Page),
});
export type Iter8ReviewSnapshot = typeof Iter8ReviewSnapshot.Type;

export const Iter8CreateNoteInput = Schema.Struct({
  pageId: Schema.String,
  intent: Iter8Intent,
  body: Schema.String,
  anchor: Iter8ElementAnchor,
  url: Schema.String,
  viewport: Iter8Viewport,
  theme: Schema.Literals(["light", "dark"]),
});
export type Iter8CreateNoteInput = typeof Iter8CreateNoteInput.Type;

export const Iter8UpdateNoteInput = Schema.Struct({
  pageId: Schema.String,
  noteId: Schema.String,
  intent: Iter8Intent,
  body: Schema.String,
});
export type Iter8UpdateNoteInput = typeof Iter8UpdateNoteInput.Type;

export const Iter8DeleteNoteInput = Schema.Struct({
  pageId: Schema.String,
  noteId: Schema.String,
});
export type Iter8DeleteNoteInput = typeof Iter8DeleteNoteInput.Type;

export const Iter8SendRoundInput = Schema.Struct({
  pageId: Schema.String,
  idempotencyKey: Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(100)),
});
export type Iter8SendRoundInput = typeof Iter8SendRoundInput.Type;

export const Iter8SendRefusal = Schema.Literals(["session-gone", "stale-generation", "no-pairing"]);
export type Iter8SendRefusal = typeof Iter8SendRefusal.Type;

export const Iter8SendRoundResult = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("accepted"), roundId: Schema.String }),
  Schema.Struct({ outcome: Schema.Literal("refused"), reason: Iter8SendRefusal }),
]);
export type Iter8SendRoundResult = typeof Iter8SendRoundResult.Type;

export class Iter8ReviewError extends Schema.TaggedError<Iter8ReviewError>()("Iter8ReviewError", {
  reason: Schema.Literals([
    "unavailable",
    "unknown-page",
    "unknown-note",
    "rejected",
    "incompatible",
  ]),
  detail: Schema.optionalKey(Schema.String),
}) {
  override get message(): string {
    return "The iter8 review request failed.";
  }
}
