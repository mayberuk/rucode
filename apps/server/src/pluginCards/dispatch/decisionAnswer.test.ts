import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { decisionAnswerArgs, findQuotedTurn, parseDpError } from "./decisionAnswer.ts";

const ANSWER = "Decision d-1: Retry the phase (retry)";
const RAISED_AT = "2026-11-21T10:00:00.500Z";

const userLine = (
  uuid: string,
  content: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: "user",
  uuid,
  timestamp: "2026-11-21T10:01:00.000Z",
  sessionId: "s-1",
  message: { role: "user", content },
  ...extra,
});
const jsonl = (lines: ReadonlyArray<object>) =>
  lines.map((line) => `${JSON.stringify(line)}\n`).join("");

const transcript = Effect.fnUntraced(function* (contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dispatch-transcript-" });
  const file = path.join(dir, "s-1.jsonl");
  yield* fs.writeFileString(file, contents);
  return file;
});

describe("decisionAnswerArgs", () => {
  it("quotes the transcript line as a person's answer", () => {
    assert.deepEqual(decisionAnswerArgs("d-1", "retry", "/repo", "/t/s-1.jsonl", "u-9"), [
      "decision",
      "answer",
      "d-1",
      "retry",
      "--dir",
      "/repo",
      "--actor",
      "person",
      "--from-turn",
      "/t/s-1.jsonl:u-9",
      "--json",
    ]);
  });
});

it.layer(NodeServices.layer)("findQuotedTurn", (it) => {
  it.effect("returns the uuid of the person's line that carries the answer", () =>
    Effect.gen(function* () {
      const contents = jsonl([
        { type: "assistant", uuid: "a-1", message: { role: "assistant", content: ANSWER } },
        userLine("u-other", "something else"),
        userLine("u-answer", [{ type: "text", text: ANSWER }]),
      ]);
      const file = yield* transcript(contents);
      const found = yield* findQuotedTurn(file, ANSWER, RAISED_AT, 0);
      assert.deepEqual(found, { uuid: "u-answer", nextOffset: Buffer.byteLength(contents) });
    }),
  );

  it.effect("reads a plain string content", () =>
    Effect.gen(function* () {
      const file = yield* transcript(jsonl([userLine("u-string", `  ${ANSWER}`)]));
      assert.strictEqual((yield* findQuotedTurn(file, ANSWER, RAISED_AT, 0)).uuid, "u-string");
    }),
  );

  it.effect.each([
    { name: "a meta line", line: userLine("u-x", ANSWER, { isMeta: true }) },
    {
      name: "a tool result",
      line: userLine("u-x", [
        { type: "tool_result", tool_use_id: "t", content: "x" },
        { type: "text", text: ANSWER },
      ]),
    },
    { name: "text starting with <", line: userLine("u-x", ` <command-name>${ANSWER}`) },
    {
      name: "a line before the decision was raised",
      line: userLine("u-x", ANSWER, { timestamp: "2026-11-21T10:00:00.000Z" }),
    },
    {
      name: "a line at the same millisecond the decision was raised",
      line: userLine("u-x", ANSWER, { timestamp: RAISED_AT }),
    },
    {
      name: "an assistant role on a user line",
      line: { ...userLine("u-x", ANSWER), message: { role: "assistant", content: ANSWER } },
    },
  ])("returns no uuid when the only match is $name", ({ line }) =>
    Effect.gen(function* () {
      const file = yield* transcript(jsonl([line]));
      assert.isNull((yield* findQuotedTurn(file, ANSWER, RAISED_AT, 0)).uuid);
    }),
  );

  it.effect("compares below the millisecond against a nanosecond raise time", () =>
    Effect.gen(function* () {
      const file = yield* transcript(
        jsonl([userLine("u-same-ms", ANSWER, { timestamp: "2026-11-21T10:00:00.500Z" })]),
      );
      const found = yield* findQuotedTurn(file, ANSWER, "2026-11-21T10:00:00.500000001Z", 0);
      assert.isNull(found.uuid);
      const later = yield* findQuotedTurn(file, ANSWER, "2026-11-21T10:00:00.499999999Z", 0);
      assert.strictEqual(later.uuid, "u-same-ms");
    }),
  );

  it.effect("ignores a match in the bytes before fromOffset", () =>
    Effect.gen(function* () {
      const before = jsonl([userLine("u-old", ANSWER)]);
      const after = jsonl([userLine("u-new", "unrelated")]);
      const file = yield* transcript(before + after);
      const found = yield* findQuotedTurn(file, ANSWER, RAISED_AT, Buffer.byteLength(before));
      assert.deepEqual(found, {
        uuid: null,
        nextOffset: Buffer.byteLength(before) + Buffer.byteLength(after),
      });
    }),
  );

  it.effect("leaves a half-written last line for the next scan", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const complete = jsonl([userLine("u-other", "unrelated")]);
      const partial = jsonl([userLine("u-answer", ANSWER)]);
      const file = yield* transcript(complete + partial.slice(0, 30));
      const first = yield* findQuotedTurn(file, ANSWER, RAISED_AT, 0);
      assert.deepEqual(first, { uuid: null, nextOffset: Buffer.byteLength(complete) });

      yield* fs.writeFileString(file, partial.slice(30), { flag: "a" });
      const second = yield* findQuotedTurn(file, ANSWER, RAISED_AT, first.nextOffset);
      assert.strictEqual(second.uuid, "u-answer");
    }),
  );

  it.effect("returns no uuid for a missing transcript", () =>
    Effect.gen(function* () {
      const found = yield* findQuotedTurn("/nonexistent/t3/s.jsonl", ANSWER, RAISED_AT, 7);
      assert.deepEqual(found, { uuid: null, nextOffset: 7 });
    }),
  );
});

describe("parseDpError", () => {
  const stderr = (code: string) =>
    `dp: line u-1 in /t.jsonl is marked isMeta\nsecond line\nERROR_CODE=${code}\n`;

  it.each([
    { code: "chat_quote_invalid", reason: "chat-quote-invalid" },
    { code: "protected_decision", reason: "protected-decision" },
    { code: "decision_closed", reason: "decision-closed" },
    { code: "not_found", reason: "unknown-card" },
    { code: "actor_unbound", reason: "dp-failed" },
    { code: "locked", reason: "dp-failed" },
    { code: "arg_error", reason: "dp-failed" },
    { code: "something_new", reason: "dp-failed" },
  ])("maps ERROR_CODE=$code to $reason with dp's first stderr line", ({ code, reason }) => {
    const error = parseDpError(stderr(code), 4);
    assert.strictEqual(error.reason, reason);
    assert.strictEqual(error.detail, "dp: line u-1 in /t.jsonl is marked isMeta");
  });

  it("reads the last ERROR_CODE line", () => {
    const error = parseDpError("dp: first\nERROR_CODE=locked\nERROR_CODE=decision_closed\n", 3);
    assert.strictEqual(error.reason, "decision-closed");
  });

  it("reports dp-failed with the exit code when stderr is empty", () => {
    const error = parseDpError("", 2);
    assert.strictEqual(error.reason, "dp-failed");
    assert.strictEqual(error.detail, "dp exited with code 2.");
  });
});
