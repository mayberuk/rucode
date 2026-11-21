import type { DispatchDecisionCardData, PluginDecisionAnswerProgress } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const DECISION_SCHEMA = "decision/1";
/** Go's zero `time.Time`, which dp writes as `applyAfter` for a decision that never comes due. */
const ZERO_TIME = "0001-01-01T00:00:00Z";

const DecisionRecordFile = Schema.Struct({
  schema: Schema.Literal(DECISION_SCHEMA),
  id: Schema.String,
  kind: Schema.String,
  part: Schema.String,
  wave: Schema.Number,
  phase: Schema.String,
  question: Schema.String,
  options: Schema.Array(
    Schema.Struct({ key: Schema.String, label: Schema.String, command: Schema.String }),
  ),
  default: Schema.String,
  defaultReason: Schema.String,
  raisedAt: Schema.String,
  applyAfter: Schema.String,
  state: Schema.Literals(["open", "answered", "defaulted", "superseded"]),
  choice: Schema.String,
  chosenBy: Schema.String,
  resolvedAt: Schema.String,
  // Records written before dp fenced protected kinds carry neither key.
  protection: Schema.optionalKey(Schema.String),
  grant: Schema.optionalKey(Schema.String),
  chosenVia: Schema.optionalKey(Schema.String),
  quote: Schema.optionalKey(
    Schema.Struct({ text: Schema.String, at: Schema.String, source: Schema.String }),
  ),
  needsPerson: Schema.optionalKey(Schema.Boolean),
  recommended: Schema.optionalKey(Schema.String),
  initiative: Schema.optionalKey(Schema.String),
  obligation: Schema.optionalKey(Schema.String),
  grantSession: Schema.optionalKey(Schema.String),
  grantGeneration: Schema.optionalKey(Schema.Number),
});

/** A `decision/1` record plus `dir`, the checkout whose `.claude/work/decisions` holds it. */
export type DispatchDecisionRecord = typeof DecisionRecordFile.Type & { readonly dir: string };

const decodeSchemaTag = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ schema: Schema.String })),
);
const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(DecisionRecordFile));

export const listDecisionRecords = Effect.fn("DispatchReader.listDecisionRecords")(function* (
  checkout: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(checkout, ".claude", "work", "decisions");
  const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
  const records: Array<DispatchDecisionRecord> = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).toSorted()) {
    const file = path.join(directory, name);
    const text = yield* fs.readFileString(file).pipe(Effect.option);
    if (Option.isNone(text)) {
      yield* Effect.logWarning("dispatch decision record could not be read", { path: file });
      continue;
    }
    const tag = decodeSchemaTag(text.value);
    if (Option.isSome(tag) && tag.value.schema !== DECISION_SCHEMA) continue;
    const record = decodeRecord(text.value);
    if (Option.isNone(record)) {
      yield* Effect.logWarning("dispatch decision record is malformed", { path: file });
      continue;
    }
    records.push({ ...record.value, dir: checkout });
  }
  return records as ReadonlyArray<DispatchDecisionRecord>;
});

const nonEmpty = (value: string | undefined) =>
  value === undefined || value === "" ? null : value;

export const toDecisionCardData = (
  record: DispatchDecisionRecord,
  answer: PluginDecisionAnswerProgress | null,
  answerable: DispatchDecisionCardData["answerable"],
): DispatchDecisionCardData => ({
  decisionId: record.id,
  dir: record.dir,
  decisionKind: record.kind,
  question: record.question,
  options: record.options.map((option) => ({
    key: option.key,
    label: option.label,
    recommended: record.recommended !== undefined && option.key === record.recommended,
  })),
  defaultKey: nonEmpty(record.default),
  state: record.state,
  choice: nonEmpty(record.choice),
  chosenBy: nonEmpty(record.chosenBy),
  chosenVia: nonEmpty(record.chosenVia),
  raisedAt: record.raisedAt,
  applyAfter: record.applyAfter === ZERO_TIME ? null : nonEmpty(record.applyAfter),
  resolvedAt: nonEmpty(record.resolvedAt),
  needsPerson: record.needsPerson === true,
  protection:
    record.protection === "outward" || record.protection === "always-ask"
      ? record.protection
      : null,
  initiative: nonEmpty(record.initiative),
  part: record.part,
  wave: record.wave,
  phase: nonEmpty(record.phase),
  answerable,
  answer,
});
