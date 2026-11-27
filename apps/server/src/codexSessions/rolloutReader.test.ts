import { describe, expect, it } from "@effect/vitest";

import { readRollout, readRolloutHead } from "./rolloutReader.ts";

const encoder = new TextEncoder();
const at = "2026-11-20T10:00:01.000Z";
const startedAt = "2026-11-20T10:00:00.000Z";
const emptyRead = { meta: null, model: null, items: [], completed: false, offset: 0 };
const session = {
  sessionId: "session-one",
  cwd: "/work/acme-app",
  startedAt,
  originator: "codex_exec",
};
const record = (type: string, payload: unknown) => ({ type, timestamp: at, payload });
const line = (value: unknown) => JSON.stringify(value) + "\n";
const bytes = (...records: ReadonlyArray<unknown>) => encoder.encode(records.map(line).join(""));
const event = (type: string, payload: Record<string, unknown> = {}) =>
  record("event_msg", { type, ...payload });
const sessionMeta = (fields: Record<string, unknown> = {}) =>
  record("session_meta", {
    id: session.sessionId,
    cwd: session.cwd,
    timestamp: startedAt,
    originator: session.originator,
    ...fields,
  });
const item = (type: string, id: string, fields: Record<string, unknown> = {}) =>
  event("item_completed", { item: { type, id, ...fields } });
const user = (id: string, ...text: string[]) =>
  item("UserMessage", id, { content: text.map((value) => ({ text: value })) });
const assistant = (id: string, text: string) =>
  item("AgentMessage", id, { content: [{ text }], phase: "final_answer" });
const command = (fields: Record<string, unknown> = {}) =>
  item("CommandExecution", "c1", {
    command: ["/bin/sh", "-lc", "list files && print ok"],
    parsed_cmd: [{ cmd: "list files" }, { cmd: "print ok" }],
    aggregated_output: "ok\n",
    exit_code: 0,
    status: "completed",
    ...fields,
  });

describe("readRollout", () => {
  it("reads each completed item in order with the model, session and completion status", () => {
    const prefix = [sessionMeta(), record("turn_context", { model: "model-one" })];
    const conversation = [
      user("u1", "list the files"),
      item("Reasoning", "r1", { summary_text: ["Inspect the folder"] }),
      command(),
      item("FileChange", "f1", {
        changes: { "/work/acme-app/one.txt": {}, "/work/acme-app/two.txt": {} },
        status: "completed",
      }),
      assistant("a1", "Done."),
    ];
    const fixture = bytes(...prefix, ...conversation, event("task_complete"));
    const offsets = conversation.map(
      (_, index) => bytes(...prefix, ...conversation.slice(0, index)).byteLength,
    );
    expect(readRollout(fixture, 0)).toEqual({
      meta: session,
      model: "model-one",
      items: [
        { id: "u1", at, offset: offsets[0], kind: "user", text: "list the files" },
        { id: "r1", at, offset: offsets[1], kind: "reasoning", text: "Inspect the folder" },
        {
          id: "c1",
          at,
          offset: offsets[2],
          kind: "command",
          command: "list files; print ok",
          output: "ok\n",
          exitCode: 0,
          status: "completed",
        },
        {
          id: "f1",
          at,
          offset: offsets[3],
          kind: "file_change",
          paths: ["/work/acme-app/one.txt", "/work/acme-app/two.txt"],
        },
        { id: "a1", at, offset: offsets[4], kind: "assistant", text: "Done." },
      ],
      completed: true,
      offset: fixture.byteLength,
    });
  });

  it("uses the latest reported model, including settings changes", () => {
    const context = record("turn_context", { model: "model-one" });
    const settings = event("thread_settings_applied", { thread_settings: { model: "model-two" } });
    expect(
      readRollout(
        bytes(context, settings, record("turn_context", {}), event("thread_settings_applied")),
        0,
      ).model,
    ).toBe("model-two");
    expect(readRollout(bytes(settings, context), 0).model).toBe("model-one");
  });

  it("accepts absent originator and item timestamp as null", () => {
    const meta = sessionMeta({ originator: undefined });
    const message = { ...user("u1", "reply ok"), timestamp: undefined };
    const read = readRollout(bytes(meta, message), 0);
    expect(read.meta).toEqual({ ...session, originator: null });
    expect(read.items).toEqual([
      { id: "u1", at: null, offset: bytes(meta).byteLength, kind: "user", text: "reply ok" },
    ]);
  });

  it("joins text blocks and reasoning summaries in order, skipping empty reasoning", () => {
    const first = user("u1", "reply ok", "include details");
    const second = item("AgentMessage", "a1", {
      content: [{ text: "Done." }, { type: "image" }, { text: "No changes." }],
    });
    const read = readRollout(
      bytes(
        first,
        second,
        item("Reasoning", "r0", { summary_text: [] }),
        item("Reasoning", "r1", { summary_text: [""] }),
        item("Reasoning", "r2", { summary_text: ["Read the list", "Summarize the result"] }),
      ),
      0,
    );
    expect(read.items).toMatchObject([
      { id: "u1", kind: "user", text: "reply ok\ninclude details" },
      { id: "a1", kind: "assistant", text: "Done.\nNo changes." },
      { id: "r2", kind: "reasoning", text: "Read the list\nSummarize the result" },
    ]);
    expect(read.completed).toBe(false);
  });

  it("keeps a user message without text and a file change without paths", () => {
    const message = item("UserMessage", "u1", { content: [{ type: "image" }] });
    const change = item("FileChange", "f1", { changes: {}, status: "failed" });
    expect(readRollout(bytes(message, change), 0).items).toMatchObject([
      { id: "u1", kind: "user", text: "" },
      { id: "f1", kind: "file_change", paths: [] },
    ]);
  });

  it("preserves item IDs and order across repeated reads and repeated item IDs", () => {
    const first = user("u1", "reply ok");
    const fixture = bytes(first, event("task_complete"), assistant("a1", "Done."), first);
    for (const read of [readRollout(fixture, 0), readRollout(fixture, 0)]) {
      expect(read.items.map(({ id, offset }) => [id, offset])).toEqual([
        ["u1", 0],
        ["a1", bytes(first, event("task_complete")).byteLength],
        ["u1", bytes(first, event("task_complete"), assistant("a1", "Done.")).byteLength],
      ]);
      expect(read.completed).toBe(true);
    }
  });

  it("consumes blank, malformed and unsupported lines without emitting their content", () => {
    const ignored =
      ' \r\n{"type":\n' +
      [
        null,
        [],
        record("session_meta", { id: "bad", timestamp: startedAt }),
        record("turn_context", { model: 7 }),
        record("event_msg", null),
        event("item_completed"),
        item("UserMessage", "bad-content", { content: null }),
        item("AgentMessage", "bad-id", { id: 1, content: [{ text: "bad" }] }),
        item("Reasoning", "bad-summary", { summary_text: "bad" }),
        command({ exit_code: "invalid" }),
        item("FileChange", "bad-changes", { changes: [] }),
        record("response_item", { type: "task_complete" }),
        event("token_count"),
        event("token_usage_record"),
        event("world_state"),
        item("OtherItem", "unknown"),
        record("unknown", { type: "task_complete" }),
      ]
        .map(line)
        .join("");
    const fixture = encoder.encode(ignored + line(user("u1", "reply ok")));
    expect(readRollout(fixture, 0)).toEqual({
      ...emptyRead,
      items: [
        {
          id: "u1",
          at,
          offset: encoder.encode(ignored).byteLength,
          kind: "user",
          text: "reply ok",
        },
      ],
      offset: fixture.byteLength,
    });
  });

  it("resumes at the first byte provided and reports absolute offsets after multibyte text", () => {
    const first = user("u1", "café");
    const next = assistant("a1", "✓");
    const fixture = bytes(sessionMeta(), first, next, event("task_complete"));
    const start = bytes(sessionMeta(), first).byteLength;
    expect(readRollout(fixture.subarray(start), start)).toEqual({
      ...emptyRead,
      items: [{ id: "a1", at, offset: start, kind: "assistant", text: "✓" }],
      completed: true,
      offset: fixture.byteLength,
    });
  });

  it("keeps the cursor on empty reads at zero and at the end of the file", () => {
    expect(readRollout(new Uint8Array(), 0)).toEqual(emptyRead);
    expect(readRollout(new Uint8Array(), 4_096)).toEqual({ ...emptyRead, offset: 4_096 });
  });

  it("holds back a partial first line", () => {
    expect(readRollout(encoder.encode('{"type":"session_meta"'), 0)).toEqual(emptyRead);
  });

  it("leaves a trailing JSON object unread until its newline arrives", () => {
    const first = user("u1", "café");
    const next = assistant("a1", "✓");
    const full = bytes(first, next);
    const cursor = bytes(first).byteLength;
    const firstRead = readRollout(full.subarray(0, full.byteLength - 1), 0);
    expect(firstRead).toEqual({
      ...emptyRead,
      items: [{ id: "u1", at, offset: 0, kind: "user", text: "café" }],
      offset: cursor,
    });
    expect(readRollout(full.subarray(firstRead.offset), firstRead.offset)).toEqual({
      ...emptyRead,
      items: [{ id: "a1", at, offset: cursor, kind: "assistant", text: "✓" }],
      offset: full.byteLength,
    });
  });

  it("leaves a completion record unread until its newline arrives", () => {
    const fixture = bytes(event("task_complete"));
    expect(readRollout(fixture.subarray(0, fixture.byteLength - 1), 0)).toEqual(emptyRead);
    expect(readRollout(fixture, 0)).toEqual({
      ...emptyRead,
      completed: true,
      offset: fixture.byteLength,
    });
  });

  it.each([
    { label: "negative exit", exit: -1, itemStatus: "completed", status: "failed" },
    { label: "nonzero exit", exit: 2, itemStatus: "completed", status: "failed" },
    { label: "failed status with zero exit", exit: 0, itemStatus: "failed", status: "failed" },
    { label: "no exit or status", exit: undefined, itemStatus: undefined, status: "completed" },
  ])("maps command status with $label and falls back to the final command argument", (test) => {
    const read = readRollout(
      bytes(command({ parsed_cmd: [], exit_code: test.exit, status: test.itemStatus })),
      0,
    );
    expect(read.items).toEqual([
      {
        id: "c1",
        at,
        offset: 0,
        kind: "command",
        command: "list files && print ok",
        output: "ok\n",
        exitCode: test.exit ?? null,
        status: test.status,
      },
    ]);
  });

  it("uses empty strings when command arguments and output are absent", () => {
    const read = readRollout(
      bytes(command({ command: [], parsed_cmd: undefined, aggregated_output: null })),
      0,
    );
    expect(read.items).toMatchObject([{ kind: "command", command: "", output: "" }]);
  });

  it("leaves output of exactly 64 KiB intact", () => {
    const output = "é".repeat(32_768);
    expect(readRollout(bytes(command({ aggregated_output: output })), 0).items).toMatchObject([
      { kind: "command", output },
    ]);
  });

  it("keeps the final 64 KiB when command output exceeds the limit by one byte", () => {
    const tail = "x".repeat(65_531) + "\nlast";
    expect(readRollout(bytes(command({ aggregated_output: "!" + tail })), 0).items).toMatchObject([
      { kind: "command", output: "[earlier output truncated]\n" + tail },
    ]);
  });

  it("cuts at a UTF-8 boundary when the final 64 KiB start inside a code point", () => {
    const tail = "x".repeat(65_535);
    expect(readRollout(bytes(command({ aggregated_output: "é" + tail })), 0).items).toMatchObject([
      { kind: "command", output: "[earlier output truncated]\n" + tail },
    ]);
  });
});

describe("readRolloutHead", () => {
  it("reads the complete first user prompt, preserving whitespace and subsequent lines", () => {
    const prompt = "  reply ok\n" + "include details ".repeat(12);
    const fixture = bytes(
      sessionMeta(),
      assistant("a1", "Ready."),
      record("response_item", { type: "UserMessage", content: [{ text: "ignored" }] }),
      user("u1", prompt),
      user("u2", "next prompt"),
    );
    expect(readRolloutHead(fixture)).toEqual({ meta: session, firstPrompt: prompt });
  });

  it("leaves a partial first prompt and a partial metadata record unread", () => {
    const prompt = bytes(sessionMeta(), user("u1", "reply ok"));
    expect(readRolloutHead(prompt.subarray(0, prompt.byteLength - 1))).toEqual({
      meta: session,
      firstPrompt: null,
    });
    const meta = bytes(sessionMeta());
    expect(readRolloutHead(meta.subarray(0, meta.byteLength - 1))).toEqual({
      meta: null,
      firstPrompt: null,
    });
  });

  it("can read a prompt without metadata and keeps an empty first prompt", () => {
    expect(readRolloutHead(bytes(user("u1", ""), user("u2", "reply ok")))).toEqual({
      meta: null,
      firstPrompt: "",
    });
  });
});
