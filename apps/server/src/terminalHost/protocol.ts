import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { TerminalHostCommand } from "./stateFile.ts";

/** A frame is one JSON object on one line; this bounds the memory a single peer can make us buffer. */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;

const SpawnInput = Schema.Struct({
  shell: Schema.String,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  cwd: Schema.String,
  cols: Schema.Int,
  rows: Schema.Int,
  env: Schema.Record(Schema.String, Schema.String),
});

const ExitFields = {
  exitCode: Schema.Number,
  signal: Schema.NullOr(Schema.Number),
};

const RequestFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("hello"), protocol: Schema.Number }),
  Schema.Struct({
    type: Schema.Literal("spawn"),
    id: Schema.Int,
    key: Schema.String,
    launch: Schema.Unknown,
    spawn: SpawnInput,
  }),
  Schema.Struct({
    type: Schema.Literal("write"),
    key: Schema.String,
    data: Schema.String,
    binary: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("resize"),
    key: Schema.String,
    cols: Schema.Int,
    rows: Schema.Int,
  }),
  Schema.Struct({
    type: Schema.Literal("kill"),
    key: Schema.String,
    signal: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("detach"), key: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("record-command"),
    key: Schema.String,
    command: Schema.NullOr(TerminalHostCommand),
  }),
]);
export type TerminalHostRequest = typeof RequestFrame.Type;

/**
 * `welcome` announces how many `session` frames follow it. Each session travels in its own frame
 * because a welcome carrying every backlog at once could exceed the frame limit.
 */
const EventFrame = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("welcome"),
    protocol: Schema.Number,
    hostPid: Schema.Int,
    sessions: Schema.Int,
  }),
  Schema.Struct({
    type: Schema.Literal("session"),
    key: Schema.String,
    pid: Schema.Int,
    launch: Schema.Unknown,
    backlog: Schema.String,
    exit: Schema.NullOr(Schema.Struct(ExitFields)),
  }),
  Schema.Struct({
    type: Schema.Literal("spawned"),
    id: Schema.Int,
    key: Schema.String,
    pid: Schema.Int,
  }),
  Schema.Struct({ type: Schema.Literal("spawn-failed"), id: Schema.Int, message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("data"), key: Schema.String, data: Schema.String }),
  Schema.Struct({ type: Schema.Literal("exit"), key: Schema.String, ...ExitFields }),
]);
export type TerminalHostEvent = typeof EventFrame.Type;

const decodeRequest = Schema.decodeUnknownOption(Schema.fromJsonString(RequestFrame));
const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(EventFrame));

export const decodeTerminalHostRequest = (line: string): TerminalHostRequest | null =>
  Option.getOrNull(decodeRequest(line));

export const decodeTerminalHostEvent = (line: string): TerminalHostEvent | null =>
  Option.getOrNull(decodeEvent(line));

export const encodeTerminalHostFrame = (frame: TerminalHostRequest | TerminalHostEvent): string =>
  `${JSON.stringify(frame)}\n`;

/**
 * Splits decoded socket text into lines. Returns null once a line exceeds MAX_FRAME_BYTES of
 * UTF-8; the splitter is unusable after that and the caller drops the connection.
 */
export function makeFrameSplitter(): (chunk: string) => ReadonlyArray<string> | null {
  let parts: string[] = [];
  let pendingBytes = 0;
  return (chunk) => {
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf("\n", start);
      if (newline === -1) break;
      const segment = chunk.slice(start, newline);
      if (pendingBytes + Buffer.byteLength(segment) > MAX_FRAME_BYTES) return null;
      lines.push(parts.length === 0 ? segment : parts.join("") + segment);
      parts = [];
      pendingBytes = 0;
      start = newline + 1;
    }
    if (start < chunk.length) {
      const rest = chunk.slice(start);
      pendingBytes += Buffer.byteLength(rest);
      if (pendingBytes > MAX_FRAME_BYTES) return null;
      parts.push(rest);
    }
    return lines;
  };
}
