import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { listDecisionRecords, toDecisionCardData } from "./decisionRecord.ts";

const openRecord = {
  schema: "decision/1",
  id: "batch-approval-core-w1",
  kind: "batch-approval",
  part: "core",
  wave: 1,
  phase: "",
  question: "Approve the batch?",
  options: [
    { key: "approve", label: "Approve", command: "" },
    { key: "stop", label: "Park it", command: "dp stop" },
  ],
  default: "stop",
  defaultReason: "",
  raisedAt: "2026-11-21T10:00:00.123456789Z",
  applyAfter: "2026-11-21T10:05:00Z",
  state: "open",
  choice: "",
  chosenBy: "",
  resolvedAt: "",
  protection: "",
  grant: "",
  futureKey: { nested: true },
};

const needsPersonRecord = {
  schema: "decision/1",
  id: "guard-failure-core-w2-np-abc",
  kind: "guard-failure",
  part: "core",
  wave: 2,
  phase: "3",
  question: "The guard failed. What now?",
  options: [
    { key: "retry", label: "Retry", command: "" },
    { key: "abort", label: "Abort", command: "" },
  ],
  default: "",
  defaultReason: "",
  raisedAt: "2026-11-21T11:00:00Z",
  applyAfter: "0001-01-01T00:00:00Z",
  state: "answered",
  choice: "retry",
  chosenBy: "person",
  chosenVia: "chat",
  quote: { text: "retry it", at: "2026-11-21T11:01:00Z", source: "/t.jsonl:u1" },
  resolvedAt: "2026-11-21T11:01:01Z",
  protection: "always-ask",
  grant: "g1",
  needsPerson: true,
  recommended: "retry",
  initiative: "rucode-home",
  obligation: "ob",
  grantSession: "session-1",
  grantGeneration: 1,
};

/** A record written before dp fenced protected kinds: no protection or grant key. */
const legacyRecord = {
  schema: "decision/1",
  id: "legacy-w1",
  kind: "batch-approval",
  part: "core",
  wave: 1,
  phase: "",
  question: "Old question",
  options: [{ key: "stop", label: "Stop", command: "" }],
  default: "stop",
  defaultReason: "",
  raisedAt: "2026-10-12T02:12:33Z",
  applyAfter: "2026-10-12T02:17:33Z",
  state: "defaulted",
  choice: "stop",
  chosenBy: "default",
  resolvedAt: "2026-10-12T02:17:33Z",
};

const writeDecisions = Effect.fnUntraced(function* (files: Record<string, string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dispatch-decisions-" });
  const directory = path.join(checkout, ".claude", "work", "decisions");
  yield* fs.makeDirectory(directory, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    yield* fs.writeFileString(path.join(directory, name), contents);
  }
  return checkout;
});

it.layer(NodeServices.layer)("dispatch decision records", (it) => {
  it.effect("returns only decision/1 records, skipping other schemas and broken files", () =>
    Effect.gen(function* () {
      const checkout = yield* writeDecisions({
        "a-open.json": JSON.stringify(openRecord),
        "b-needs-person.json": JSON.stringify(needsPersonRecord),
        "c-legacy.json": JSON.stringify(legacyRecord),
        "d-next-schema.json": JSON.stringify({ ...openRecord, schema: "decision/2", id: "v2" }),
        "e-broken.json": "{ not json",
        "f-missing-fields.json": JSON.stringify({ schema: "decision/1", id: "partial" }),
        "g-notes.txt": JSON.stringify({ ...openRecord, id: "txt" }),
      });
      const records = yield* listDecisionRecords(checkout);
      assert.deepEqual(
        records.map((record) => record.id),
        ["batch-approval-core-w1", "guard-failure-core-w2-np-abc", "legacy-w1"],
      );
      assert.ok(records.every((record) => record.dir === checkout));
      const needsPerson = records[1]!;
      assert.strictEqual(needsPerson.needsPerson, true);
      assert.strictEqual(needsPerson.grantSession, "session-1");
      assert.strictEqual(needsPerson.applyAfter, "0001-01-01T00:00:00Z");
      assert.deepEqual(needsPerson.quote, needsPersonRecord.quote);
      assert.notProperty(records[0]!, "futureKey");
    }),
  );

  it.effect("returns no records when the checkout has no decisions directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dispatch-empty-" });
      assert.deepEqual(yield* listDecisionRecords(checkout), []);
    }),
  );

  it.effect("maps an open record to card data, turning dp's empty strings into null", () =>
    Effect.gen(function* () {
      const checkout = yield* writeDecisions({ "open.json": JSON.stringify(openRecord) });
      const [record] = yield* listDecisionRecords(checkout);
      assert.deepEqual(toDecisionCardData(record!, null, "yes"), {
        decisionId: "batch-approval-core-w1",
        dir: checkout,
        decisionKind: "batch-approval",
        question: "Approve the batch?",
        options: [
          { key: "approve", label: "Approve", recommended: false },
          { key: "stop", label: "Park it", recommended: false },
        ],
        defaultKey: "stop",
        state: "open",
        choice: null,
        chosenBy: null,
        chosenVia: null,
        raisedAt: "2026-11-21T10:00:00.123456789Z",
        applyAfter: "2026-11-21T10:05:00Z",
        resolvedAt: null,
        needsPerson: false,
        protection: null,
        initiative: null,
        part: "core",
        wave: 1,
        phase: null,
        answerable: "yes",
        answer: null,
      });
    }),
  );

  it.effect("maps a needs-person record's zero applyAfter and empty default to null", () =>
    Effect.gen(function* () {
      const checkout = yield* writeDecisions({ "np.json": JSON.stringify(needsPersonRecord) });
      const [record] = yield* listDecisionRecords(checkout);
      const progress = {
        optionKey: "retry",
        status: "failed" as const,
        reason: "chat-quote-invalid" as const,
        detail: "dp: refused",
      };
      assert.deepEqual(toDecisionCardData(record!, progress, "terminal-only"), {
        decisionId: "guard-failure-core-w2-np-abc",
        dir: checkout,
        decisionKind: "guard-failure",
        question: "The guard failed. What now?",
        options: [
          { key: "retry", label: "Retry", recommended: true },
          { key: "abort", label: "Abort", recommended: false },
        ],
        defaultKey: null,
        state: "answered",
        choice: "retry",
        chosenBy: "person",
        chosenVia: "chat",
        raisedAt: "2026-11-21T11:00:00Z",
        applyAfter: null,
        resolvedAt: "2026-11-21T11:01:01Z",
        needsPerson: true,
        protection: "always-ask",
        initiative: "rucode-home",
        part: "core",
        wave: 2,
        phase: "3",
        answerable: "terminal-only",
        answer: progress,
      });
    }),
  );
});
