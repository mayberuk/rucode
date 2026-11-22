import { PluginCardError, type PluginCardErrorReason } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { readCompleteLines } from "./runFeed.ts";

export function decisionAnswerArgs(
  id: string,
  key: string,
  dir: string,
  transcriptPath: string,
  uuid: string,
): ReadonlyArray<string> {
  return [
    "decision",
    "answer",
    id,
    key,
    "--dir",
    dir,
    "--actor",
    "person",
    "--from-turn",
    `${transcriptPath}:${uuid}`,
    "--json",
  ];
}

const TranscriptLine = Schema.Struct({
  type: Schema.String,
  uuid: Schema.String,
  timestamp: Schema.String,
  isMeta: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  message: Schema.Struct({
    role: Schema.String,
    content: Schema.Union([
      Schema.String,
      Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) })),
    ]),
  }),
});
const decodeTranscriptLine = Schema.decodeUnknownOption(Schema.fromJsonString(TranscriptLine));

/** Nanoseconds since the epoch, keeping the sub-millisecond digits `Date.parse` drops. */
const instant = (iso: string) => {
  const millis = Date.parse(iso);
  if (Number.isNaN(millis)) return null;
  const fraction = /T[\d:]+\.(\d+)/.exec(iso)?.[1] ?? "";
  const subMillis = Number(fraction.slice(3, 9).padEnd(6, "0"));
  return BigInt(millis) * 1_000_000n + BigInt(subMillis);
};

/**
 * Applies the same tests `dp decision answer --from-turn` applies to the quoted line, so a uuid
 * returned here is one dp accepts as a person's own turn.
 */
export const findQuotedTurn = Effect.fn("DispatchReader.findQuotedTurn")(function* (
  transcriptPath: string,
  text: string,
  after: string,
  fromOffset: number,
) {
  const { lines, nextOffset } = yield* readCompleteLines(transcriptPath, fromOffset);
  const raisedAt = instant(after);
  for (const raw of lines) {
    const line = Option.getOrUndefined(decodeTranscriptLine(raw));
    if (line === undefined || line.type !== "user" || line.message.role !== "user") continue;
    if (line.isMeta === true) continue;
    const content = line.message.content;
    if (typeof content !== "string" && content.some((block) => block.type === "tool_result")) {
      continue;
    }
    const body =
      typeof content === "string"
        ? content
        : content.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : [])).join("\n");
    if (!body.includes(text) || body.trim().startsWith("<")) continue;
    const at = instant(line.timestamp);
    if (raisedAt === null || at === null || at <= raisedAt) continue;
    return { uuid: line.uuid as string | null, nextOffset };
  }
  return { uuid: null as string | null, nextOffset };
});

const DP_ERROR_REASONS: Readonly<Record<string, PluginCardErrorReason>> = {
  chat_quote_invalid: "chat-quote-invalid",
  protected_decision: "protected-decision",
  decision_closed: "decision-closed",
  not_found: "unknown-card",
};

export function parseDpError(stderr: string, exitCode: number | null): PluginCardError {
  const lines = stderr.split("\n").map((line) => line.trim());
  const code = lines
    .flatMap((line) => {
      const match = /^ERROR_CODE=(\S+)$/.exec(line);
      return match?.[1] === undefined ? [] : [match[1]];
    })
    .at(-1);
  const detail =
    lines.find((line) => line !== "" && !line.startsWith("ERROR_CODE=")) ??
    (exitCode === null ? "dp did not exit." : `dp exited with code ${exitCode}.`);
  return new PluginCardError({
    reason: (code === undefined ? undefined : DP_ERROR_REASONS[code]) ?? "dp-failed",
    detail,
  });
}
