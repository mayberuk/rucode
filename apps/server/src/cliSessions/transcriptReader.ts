import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { claudeTranscriptUserText } from "../provider/Drivers/ClaudeCommandTranscript.ts";

export interface TranscriptEntry {
  /** The record's uuid; a record that yields both reasoning and text suffixes the second `:1`. */
  readonly uuid: string;
  readonly role: "user" | "assistant" | "reasoning";
  readonly text: string;
  readonly createdAt: string | null;
}

export interface TranscriptRead {
  readonly entries: ReadonlyArray<TranscriptEntry>;
  /** Absolute byte offset just past the last complete line; a trailing partial line is left. */
  readonly offset: number;
  /** custom-title > ai-title > first human prompt (only when the read starts at byte 0). */
  readonly title: string | null;
  readonly customTitle: string | null;
  readonly agentName: string | null;
  /** The last uuid on any record read, including ones that emit no entry. */
  readonly leafUuid: string | null;
  /** The model of the last visible assistant record read, as Claude reports it. */
  readonly model: string | null;
}

const ContentBlock = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
});

const TranscriptRecord = Schema.Struct({
  type: Schema.optional(Schema.String),
  uuid: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
  entrypoint: Schema.optional(Schema.String),
  isSidechain: Schema.optional(Schema.Unknown),
  isMeta: Schema.optional(Schema.Unknown),
  isCompactSummary: Schema.optional(Schema.Unknown),
  origin: Schema.optional(Schema.NullOr(Schema.Struct({ kind: Schema.optional(Schema.String) }))),
  customTitle: Schema.optional(Schema.String),
  aiTitle: Schema.optional(Schema.String),
  agentName: Schema.optional(Schema.String),
  message: Schema.optional(
    Schema.Struct({
      model: Schema.optional(Schema.String),
      content: Schema.optional(Schema.Union([Schema.String, Schema.Array(ContentBlock)])),
    }),
  ),
});
type TranscriptRecord = typeof TranscriptRecord.Type;
type Content = NonNullable<TranscriptRecord["message"]>["content"];

const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(TranscriptRecord));
const decodeLooseRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ uuid: Schema.optional(Schema.String) })),
);

const NEWLINE = 0x0a;
const decoder = new TextDecoder();

const isHidden = (record: TranscriptRecord) =>
  record.entrypoint === "t3-code" ||
  record.isSidechain === true ||
  record.isMeta === true ||
  record.isCompactSummary === true;

const joinBlocks = (content: Content, type: "text" | "thinking"): string => {
  if (typeof content === "string") return type === "text" ? content.trim() : "";
  return (content ?? [])
    .flatMap((block) => {
      const value = (type === "text" ? block.text : block.thinking)?.trim();
      return block.type === type && value ? [value] : [];
    })
    .join("\n\n");
};

function entriesOf(record: TranscriptRecord): ReadonlyArray<TranscriptEntry> {
  if (record.uuid === undefined || isHidden(record)) return [];
  const content = record.message?.content;
  const createdAt = record.timestamp ?? null;
  if (record.type === "user") {
    const kind = record.origin?.kind;
    if (kind !== undefined && kind !== "human") return [];
    const text = claudeTranscriptUserText(joinBlocks(content, "text"));
    return text === null || text === ""
      ? []
      : [{ uuid: record.uuid, role: "user", text, createdAt }];
  }
  if (record.type === "assistant") {
    const found: Array<TranscriptEntry> = [];
    const reasoning = joinBlocks(content, "thinking");
    if (reasoning !== "") {
      found.push({ uuid: record.uuid, role: "reasoning", text: reasoning, createdAt });
    }
    const text = joinBlocks(content, "text");
    if (text !== "") {
      const uuid = found.length === 0 ? record.uuid : `${record.uuid}:1`;
      found.push({ uuid, role: "assistant", text, createdAt });
    }
    return found;
  }
  return [];
}

/**
 * Reads the complete JSONL lines in `bytes`, which start at absolute file offset `offset`.
 * Pure: the same bytes and offset always give the same entries.
 */
export function readTranscript(bytes: Uint8Array, offset: number): TranscriptRead {
  const entries: Array<TranscriptEntry> = [];
  let customTitle: string | null | undefined;
  let aiTitle: string | null = null;
  let agentName: string | null = null;
  let firstPrompt: string | null = null;
  let leafUuid: string | null = null;
  let model: string | null = null;
  let start = 0;
  for (let end = bytes.indexOf(NEWLINE); end !== -1; end = bytes.indexOf(NEWLINE, start)) {
    const line = decoder.decode(bytes.subarray(start, end));
    start = end + 1;
    if (line.trim() === "") continue;
    const record = Option.getOrUndefined(decodeRecord(line));
    if (record === undefined) {
      leafUuid = Option.getOrUndefined(decodeLooseRecord(line))?.uuid ?? leafUuid;
      continue;
    }
    if (record.uuid !== undefined) leafUuid = record.uuid;
    if (record.type === "custom-title" && record.customTitle !== undefined) {
      customTitle = record.customTitle.trim() || null;
    } else if (record.type === "ai-title" && record.aiTitle?.trim()) {
      aiTitle = record.aiTitle.trim();
    } else if (record.type === "agent-name" && record.agentName?.trim()) {
      agentName = record.agentName.trim();
    } else if (record.type === "assistant" && !isHidden(record)) {
      const reported = record.message?.model?.trim();
      // Claude labels its own error and notice records `<synthetic>`; no model wrote them.
      if (reported && reported !== "<synthetic>") model = reported;
    }
    for (const entry of entriesOf(record)) {
      if (firstPrompt === null && entry.role === "user") {
        firstPrompt = entry.text.split("\n")[0]!.slice(0, 100).trim() || null;
      }
      entries.push(entry);
    }
  }
  return {
    entries,
    offset: offset + start,
    title: customTitle ?? aiTitle ?? (offset === 0 ? firstPrompt : null),
    customTitle: customTitle ?? null,
    agentName,
    leafUuid,
    model,
  };
}
