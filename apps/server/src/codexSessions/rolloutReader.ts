export interface RolloutMeta {
  readonly sessionId: string;
  readonly cwd: string;
  readonly startedAt: string;
  readonly originator: string | null;
}

type ItemLocation = {
  readonly id: string;
  readonly offset: number;
  readonly at: string | null;
};

export type RolloutItem = ItemLocation &
  (
    | { readonly kind: "user"; readonly text: string }
    | { readonly kind: "assistant"; readonly text: string }
    | { readonly kind: "reasoning"; readonly text: string }
    | {
        readonly kind: "command";
        readonly command: string;
        readonly output: string;
        readonly exitCode: number | null;
        readonly status: "completed" | "failed";
      }
    | { readonly kind: "file_change"; readonly paths: ReadonlyArray<string> }
  );

export interface RolloutRead {
  readonly meta: RolloutMeta | null;
  readonly model: string | null;
  readonly items: ReadonlyArray<RolloutItem>;
  readonly completed: boolean;
  readonly offset: number;
}

const NEWLINE = 0x0a;
const MAX_OUTPUT_BYTES = 64 * 1024;
const decoder = new TextDecoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string");
}

function* readRecords(bytes: Uint8Array) {
  let start = 0;
  for (let end = bytes.indexOf(NEWLINE); end !== -1; end = bytes.indexOf(NEWLINE, start)) {
    const offset = start;
    start = end + 1;
    let record: unknown;
    try {
      record = JSON.parse(decoder.decode(bytes.subarray(offset, end)));
    } catch {
      continue;
    }
    if (isRecord(record) && isRecord(record.payload)) {
      yield { offset, type: record.type, timestamp: record.timestamp, payload: record.payload };
    }
  }
}

function readMeta(payload: Record<string, unknown>): RolloutMeta | null {
  const { id, cwd, timestamp, originator } = payload;
  if (
    typeof id !== "string" ||
    id === "" ||
    typeof cwd !== "string" ||
    cwd === "" ||
    typeof timestamp !== "string" ||
    timestamp === "" ||
    (originator != null && typeof originator !== "string")
  ) {
    return null;
  }
  return { sessionId: id, cwd, startedAt: timestamp, originator: originator ?? null };
}

function readMessageText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const blocks: Array<string> = [];
  for (const block of content) {
    if (!isRecord(block) || (block.text !== undefined && typeof block.text !== "string")) {
      return null;
    }
    if (typeof block.text === "string") blocks.push(block.text);
  }
  return blocks.join("\n");
}

function tailOutput(output: string): string {
  const bytes = Buffer.from(output, "utf8");
  if (bytes.length <= MAX_OUTPUT_BYTES) return output;
  let start = bytes.length - MAX_OUTPUT_BYTES;
  // The byte limit can fall inside a UTF-8 code point.
  while ((bytes[start]! & 0xc0) === 0x80) start += 1;
  return `[earlier output truncated]\n${bytes.toString("utf8", start)}`;
}

function readCommand(item: Record<string, unknown>, location: ItemLocation): RolloutItem | null {
  const {
    command,
    parsed_cmd: parsedCommands,
    aggregated_output: output,
    exit_code: exitCode,
    status,
  } = item;
  if (
    (command != null && !isStringArray(command)) ||
    (parsedCommands != null && !Array.isArray(parsedCommands)) ||
    (output != null && typeof output !== "string") ||
    (exitCode != null && typeof exitCode !== "number") ||
    (status != null && typeof status !== "string")
  ) {
    return null;
  }
  const commands: Array<string> = [];
  for (const parsed of parsedCommands ?? []) {
    if (!isRecord(parsed) || typeof parsed.cmd !== "string") return null;
    commands.push(parsed.cmd);
  }
  return {
    ...location,
    kind: "command",
    command: commands.length > 0 ? commands.join("; ") : (command?.at(-1) ?? ""),
    output: tailOutput(output ?? ""),
    exitCode: exitCode ?? null,
    status: (exitCode != null && exitCode !== 0) || status === "failed" ? "failed" : "completed",
  };
}

function readItem(item: unknown, offset: number, timestamp: unknown): RolloutItem | null {
  if (!isRecord(item) || typeof item.id !== "string") return null;
  const location = { id: item.id, offset, at: typeof timestamp === "string" ? timestamp : null };
  switch (item.type) {
    case "UserMessage":
    case "AgentMessage": {
      const text = readMessageText(item.content);
      if (text === null) return null;
      const kind = item.type === "UserMessage" ? "user" : "assistant";
      return { ...location, kind, text };
    }
    case "Reasoning": {
      if (!isStringArray(item.summary_text)) return null;
      const text = item.summary_text.filter((summary) => summary.trim() !== "").join("\n");
      return text === "" ? null : { ...location, kind: "reasoning", text };
    }
    case "CommandExecution":
      return readCommand(item, location);
    case "FileChange":
      return isRecord(item.changes)
        ? { ...location, kind: "file_change", paths: Object.keys(item.changes) }
        : null;
    default:
      return null;
  }
}

/** Reads a byte slice beginning at the absolute file offset `startOffset`. */
export function readRollout(bytes: Uint8Array, startOffset: number): RolloutRead {
  let meta: RolloutMeta | null = null;
  let model: string | null = null;
  let completed = false;
  const items: Array<RolloutItem> = [];
  for (const record of readRecords(bytes)) {
    const { type, payload } = record;
    if (type === "session_meta") {
      meta ??= readMeta(payload);
    } else if (type === "turn_context") {
      if (typeof payload.model === "string") model = payload.model;
    } else if (type === "event_msg") {
      switch (payload.type) {
        case "thread_settings_applied": {
          const settings = payload.thread_settings;
          if (isRecord(settings) && typeof settings.model === "string") model = settings.model;
          break;
        }
        case "task_complete":
          completed = true;
          break;
        case "item_completed": {
          const item = readItem(payload.item, startOffset + record.offset, record.timestamp);
          if (item !== null) items.push(item);
          break;
        }
      }
    }
  }
  return { meta, model, items, completed, offset: startOffset + bytes.lastIndexOf(NEWLINE) + 1 };
}

export function readRolloutHead(bytes: Uint8Array): {
  readonly meta: RolloutMeta | null;
  readonly firstPrompt: string | null;
} {
  let meta: RolloutMeta | null = null;
  let firstPrompt: string | null = null;
  for (const { type, payload } of readRecords(bytes)) {
    if (type === "session_meta") {
      meta ??= readMeta(payload);
    } else if (type === "event_msg" && payload.type === "item_completed" && firstPrompt === null) {
      const item = payload.item;
      if (isRecord(item) && item.type === "UserMessage" && typeof item.id === "string") {
        firstPrompt = readMessageText(item.content);
      }
    }
    if (meta !== null && firstPrompt !== null) break;
  }
  return { meta, firstPrompt };
}
