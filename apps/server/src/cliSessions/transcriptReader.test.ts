import { describe, expect, it } from "@effect/vitest";

import { readTranscript } from "./transcriptReader.ts";

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);
const lines = (...records: ReadonlyArray<object>) =>
  records.map((record) => `${JSON.stringify(record)}\n`).join("");

const human = (uuid: string, text: string, fields: Record<string, unknown> = {}) => ({
  type: "user",
  uuid,
  timestamp: "2026-11-20T10:00:00.000Z",
  entrypoint: "cli",
  origin: { kind: "human" },
  message: { role: "user", content: text },
  ...fields,
});

const assistantText = (uuid: string, text: string, fields: Record<string, unknown> = {}) => ({
  type: "assistant",
  uuid,
  timestamp: "2026-11-20T10:00:05.000Z",
  entrypoint: "cli",
  message: { role: "assistant", content: [{ type: "text", text }] },
  ...fields,
});

const uuids = (text: string, offset = 0) =>
  readTranscript(bytes(text), offset).entries.map((entry) => entry.uuid);

describe("readTranscript", () => {
  it("emits human prompts, assistant text and non-empty thinking", () => {
    const read = readTranscript(
      bytes(
        lines(
          human("u1", "fix the sidebar"),
          {
            type: "assistant",
            uuid: "a1",
            timestamp: "2026-11-20T10:00:01.000Z",
            message: {
              role: "assistant",
              content: [{ type: "thinking", thinking: "look at the layout", signature: "s" }],
            },
          },
          {
            type: "assistant",
            uuid: "a2",
            message: {
              role: "assistant",
              content: [{ type: "thinking", thinking: "", signature: "s" }],
            },
          },
          assistantText("a3", "Done."),
        ),
      ),
      0,
    );
    expect(read.entries).toEqual([
      { uuid: "u1", role: "user", text: "fix the sidebar", createdAt: "2026-11-20T10:00:00.000Z" },
      {
        uuid: "a1",
        role: "reasoning",
        text: "look at the layout",
        createdAt: "2026-11-20T10:00:01.000Z",
      },
      { uuid: "a3", role: "assistant", text: "Done.", createdAt: "2026-11-20T10:00:05.000Z" },
    ]);
  });

  it("reports the model of the last assistant record the terminal wrote", () => {
    const withModel = (uuid: string, model: string, fields: Record<string, unknown> = {}) =>
      assistantText(uuid, "reply", {
        message: { role: "assistant", model, content: [{ type: "text", text: "reply" }] },
        ...fields,
      });
    const model = (text: string) => readTranscript(bytes(text), 0).model;
    expect(model(lines(human("u1", "hi")))).toBeNull();
    expect(
      model(
        lines(
          withModel("a1", "claude-opus-4-6"),
          withModel("a2", "claude-haiku-4-5-20251001"),
          withModel("a3", "<synthetic>"),
          withModel("a4", "claude-sonnet-4-6", { entrypoint: "t3-code" }),
          withModel("a5", "claude-sonnet-4-6", { isSidechain: true }),
        ),
      ),
    ).toBe("claude-haiku-4-5-20251001");
  });

  it("skips records rucode wrote itself", () => {
    expect(
      uuids(
        lines(
          human("u1", "from rucode", { entrypoint: "t3-code" }),
          assistantText("a1", "reply", { entrypoint: "t3-code" }),
        ),
      ),
    ).toEqual([]);
  });

  it("skips task notifications and peer messages but keeps prompts without an origin", () => {
    expect(
      uuids(
        lines(
          human("u1", "<task-notification>done</task-notification>", {
            origin: { kind: "task-notification", producer: "session-task" },
          }),
          human("u2", "hello from a peer", { origin: { kind: "peer" } }),
          human("u3", "no origin recorded", { origin: undefined }),
        ),
      ),
    ).toEqual(["u3"]);
  });

  it("skips sidechain, meta and compact-summary records", () => {
    expect(
      uuids(
        lines(
          human("u1", "subagent prompt", { isSidechain: true }),
          assistantText("a1", "subagent reply", { isSidechain: true }),
          human("u2", "<local-command-caveat>", { isMeta: true }),
          human("u3", "This session is being continued", { isCompactSummary: true }),
        ),
      ),
    ).toEqual([]);
  });

  it("skips tool-result-only user records and other record types", () => {
    expect(
      uuids(
        lines(
          human("u1", "", {
            message: {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
            },
            origin: undefined,
          }),
          { type: "attachment", uuid: "x1", attachment: {} },
          { type: "system", uuid: "x2", content: "hook ran" },
          { type: "api-request", requestId: "r1" },
        ),
      ),
    ).toEqual([]);
  });

  it("waits for a trailing partial line and emits it once completed", () => {
    const complete = lines(human("u1", "first"));
    const partial = JSON.stringify(human("u2", "second"));
    const firstRead = readTranscript(bytes(complete + partial.slice(0, 20)), 0);
    expect(firstRead.entries.map((entry) => entry.uuid)).toEqual(["u1"]);
    expect(firstRead.offset).toBe(bytes(complete).byteLength);

    const rest = bytes(`${complete}${partial}\n`).slice(firstRead.offset);
    const secondRead = readTranscript(rest, firstRead.offset);
    expect(secondRead.entries.map((entry) => entry.uuid)).toEqual(["u2"]);
    expect(secondRead.offset).toBe(bytes(`${complete}${partial}\n`).byteLength);
  });

  it("counts the offset in bytes, not characters", () => {
    const text = lines(human("u1", "héllo wörld ✓"));
    expect(readTranscript(bytes(text), 10).offset).toBe(10 + bytes(text).byteLength);
  });

  it("prefers the custom title over the AI title", () => {
    const read = readTranscript(
      bytes(
        lines(
          human("u1", "first prompt\nwith detail"),
          { type: "custom-title", customTitle: "My rename", sessionId: "s" },
          { type: "ai-title", aiTitle: "Generated title", sessionId: "s" },
        ),
      ),
      0,
    );
    expect(read.title).toBe("My rename");
  });

  it("falls back to the AI title, then to the first human prompt from the start of the file", () => {
    expect(
      readTranscript(
        bytes(
          lines(human("u1", "first prompt"), {
            type: "ai-title",
            aiTitle: "Generated title",
            sessionId: "s",
          }),
        ),
        0,
      ).title,
    ).toBe("Generated title");
    expect(readTranscript(bytes(lines(human("u1", "first prompt\nmore"))), 0).title).toBe(
      "first prompt",
    );
    expect(readTranscript(bytes(lines(human("u9", "a later prompt"))), 4096).title).toBeNull();
  });

  it("reports the last uuid over all records as the leaf, and the newest agent name", () => {
    const read = readTranscript(
      bytes(
        lines(
          human("u1", "go"),
          { type: "agent-name", agentName: "repo-drv", sessionId: "s" },
          { type: "attachment", uuid: "x9", attachment: {} },
          { type: "last-prompt", lastPrompt: "go" },
        ),
      ),
      0,
    );
    expect(read.leafUuid).toBe("x9");
    expect(read.agentName).toBe("repo-drv");
  });

  it("yields the same uuids when the same bytes are read twice from offset 0", () => {
    const text = lines(human("u1", "one"), assistantText("a1", "two"), human("u2", "three"));
    expect(uuids(text)).toEqual(["u1", "a1", "u2"]);
    expect(uuids(text)).toEqual(uuids(text));
  });

  it("consumes a malformed complete line without emitting it", () => {
    const text = `{"type":"user",\n${lines(human("u1", "after"))}`;
    const read = readTranscript(bytes(text), 0);
    expect(read.entries.map((entry) => entry.uuid)).toEqual(["u1"]);
    expect(read.offset).toBe(bytes(text).byteLength);
  });
});
