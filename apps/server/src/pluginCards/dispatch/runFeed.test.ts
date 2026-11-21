import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readRunFeed, runFeedPath } from "./runFeed.ts";

const opened = (run: string) => ({
  ts: "2026-11-21T16:38:43Z",
  event: "run-opened",
  run,
  dir: "/repo/wt",
  part: "core",
  wave: 2,
  spec: ".claude/plans/core.md",
  pid: 4242,
  phases: 3,
  initiative: "rucode-home",
  schema: "dp-run/1",
});
const line = (row: object) => `${JSON.stringify(row)}\n`;
const runs = (rows: ReadonlyArray<object>) =>
  rows.map((row) => ("run" in row ? row.run : "id" in row ? row.id : null));

const feedDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dispatch-feed-" });
  return { fs, feed: path.join(dir, "runs.jsonl") };
});

describe("runFeedPath", () => {
  it.each([
    { env: { DP_RUN_FEED: "/x/feed.jsonl", XDG_STATE_HOME: "/state" }, want: "/x/feed.jsonl" },
    { env: { DP_RUN_FEED: "", XDG_STATE_HOME: "/state" }, want: "/state/dispatch/runs.jsonl" },
    { env: { XDG_STATE_HOME: "/state/" }, want: "/state/dispatch/runs.jsonl" },
    { env: { XDG_STATE_HOME: "" }, want: "/home/me/.local/state/dispatch/runs.jsonl" },
    { env: {}, want: "/home/me/.local/state/dispatch/runs.jsonl" },
  ])("resolves $env to $want", ({ env, want }) => {
    assert.strictEqual(runFeedPath(env, "/home/me"), want);
  });
});

it.layer(NodeServices.layer)("readRunFeed", (it) => {
  it.effect("decodes every row kind and skips undecodable lines", () =>
    Effect.gen(function* () {
      const { fs, feed } = yield* feedDir;
      const settled = {
        ts: "2026-11-21T16:40:00Z",
        event: "run-settled",
        run: "r-2",
        dir: "/repo/wt",
        part: "core",
        wave: 2,
        pid: 4242,
        outcome: "failed",
        reason: "gate",
        schema: "dp-run/1",
      };
      const raised = {
        ts: "2026-11-21T16:41:00Z",
        event: "decision-raised",
        id: "d-1",
        dir: "/repo/wt",
        kind: "guard-failure",
        part: "core",
        wave: 2,
        apply_after: "0001-01-01T00:00:00Z",
        needs_person: true,
        schema: "dp-run/1",
      };
      const resolved = {
        ts: "2026-11-21T16:42:00Z",
        event: "decision-resolved",
        id: "d-2",
        dir: "/repo/wt",
        kind: "guard-failure",
        part: "core",
        wave: 2,
        state: "answered",
        choice: "retry",
        chosen_by: "person",
        chosen_via: "chat",
        quote: "retry it",
        schema: "dp-run/1",
      };
      yield* fs.writeFileString(
        feed,
        [
          line(opened("r-1")),
          "not json at all\n",
          line({ ...opened("r-other-schema"), schema: "dp-run/2" }),
          line({ ...opened("r-bad-wave"), wave: "two" }),
          line({ ...opened("r-unknown-event"), event: "run-paused" }),
          line(settled),
          line(raised),
          line(resolved),
        ].join(""),
      );
      const { rows } = yield* readRunFeed(feed, null);
      assert.deepEqual(runs(rows), ["r-1", "r-2", "d-1", "d-2"]);
      assert.deepEqual<unknown>(rows[0], opened("r-1"));
      assert.deepEqual<unknown>(rows[2], raised);
      assert.deepEqual<unknown>(rows[3], resolved);
    }),
  );

  it.effect("leaves an incomplete last line unread until its newline arrives", () =>
    Effect.gen(function* () {
      const { fs, feed } = yield* feedDir;
      const second = line(opened("r-2"));
      yield* fs.writeFileString(feed, line(opened("r-1")) + second.slice(0, 20));
      const first = yield* readRunFeed(feed, null);
      assert.deepEqual(runs(first.rows), ["r-1"]);
      assert.strictEqual(first.cursor.offset, Buffer.byteLength(line(opened("r-1"))));

      const again = yield* readRunFeed(feed, first.cursor);
      assert.deepEqual(again.rows, []);
      assert.deepEqual(again.cursor, first.cursor);

      yield* fs.writeFileString(feed, second.slice(20), { flag: "a" });
      const completed = yield* readRunFeed(feed, again.cursor);
      assert.deepEqual(runs(completed.rows), ["r-2"]);
    }),
  );

  it.effect("returns the rest of runs.jsonl.1 before the new file after a rotation", () =>
    Effect.gen(function* () {
      const { fs, feed } = yield* feedDir;
      yield* fs.writeFileString(feed, line(opened("r-1")) + line(opened("r-2")));
      const first = yield* readRunFeed(feed, null);
      assert.deepEqual(runs(first.rows), ["r-1", "r-2"]);

      yield* fs.writeFileString(feed, line(opened("r-3")), { flag: "a" });
      yield* fs.rename(feed, `${feed}.1`);
      yield* fs.writeFileString(feed, line(opened("r-4")) + line(opened("r-5")));

      const second = yield* readRunFeed(feed, first.cursor);
      assert.deepEqual(runs(second.rows), ["r-3", "r-4", "r-5"]);
      assert.deepEqual(runs((yield* readRunFeed(feed, second.cursor)).rows), []);
    }),
  );

  it.effect("drains runs.jsonl.1 while the new file does not exist yet, without rereading it", () =>
    Effect.gen(function* () {
      const { fs, feed } = yield* feedDir;
      yield* fs.writeFileString(feed, line(opened("r-1")));
      const first = yield* readRunFeed(feed, null);

      yield* fs.writeFileString(feed, line(opened("r-2")), { flag: "a" });
      yield* fs.rename(feed, `${feed}.1`);
      const drained = yield* readRunFeed(feed, first.cursor);
      assert.deepEqual(runs(drained.rows), ["r-2"]);

      yield* fs.writeFileString(feed, line(opened("r-3")));
      const resumed = yield* readRunFeed(feed, drained.cursor);
      assert.deepEqual(runs(resumed.rows), ["r-3"]);
    }),
  );

  it.effect("returns no rows when the feed does not exist", () =>
    Effect.gen(function* () {
      const { feed } = yield* feedDir;
      const { rows } = yield* readRunFeed(feed, null);
      assert.deepEqual(rows, []);
    }),
  );
});
