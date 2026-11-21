import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { DispatchDecisionRecord } from "./decisionRecord.ts";
import type { DispatchLiveInitiative } from "./liveRegistry.ts";
import { type DispatchThreadLookup, mapDecisionToThread, mapRunToThread } from "./threadMapping.ts";

const GRANT_THREAD = ThreadId.make("thread-grant");
const ORCHESTRATOR_THREAD = ThreadId.make("thread-orchestrator");
const DIR_THREAD = ThreadId.make("thread-dir");
const OTHER_DIR_THREAD = ThreadId.make("thread-dir-2");
const PID_THREAD = ThreadId.make("thread-pid");

const lookup = (world: {
  readonly sessions?: Record<string, ThreadId>;
  readonly dirs?: Record<string, ReadonlyArray<ThreadId>>;
  readonly pids?: Record<number, ThreadId>;
}): DispatchThreadLookup => ({
  threadForClaudeSession: (sessionId) => Effect.succeed(world.sessions?.[sessionId] ?? null),
  threadsForDir: (dir) => Effect.succeed(world.dirs?.[dir] ?? []),
  threadForPid: (pid) => Effect.succeed(world.pids?.[pid] ?? null),
});

const record = (overrides: Partial<DispatchDecisionRecord> = {}): DispatchDecisionRecord => ({
  schema: "decision/1",
  id: "d-1",
  kind: "guard-failure",
  part: "card-core",
  wave: 2,
  phase: "",
  question: "What now?",
  options: [],
  default: "",
  defaultReason: "",
  raisedAt: "2026-11-21T10:00:00Z",
  applyAfter: "0001-01-01T00:00:00Z",
  state: "open",
  choice: "",
  chosenBy: "",
  resolvedAt: "",
  dir: "/dev/rucode-worktrees/card-core",
  ...overrides,
});

const initiative = (overrides: Partial<DispatchLiveInitiative>): DispatchLiveInitiative => ({
  slug: "rucode-home",
  closed: false,
  totalWave: 2,
  totalRunning: 1,
  totalSettled: 0,
  totalCostUsd: 0,
  reportedCostUsd: 0,
  started: "2026-11-21T09:00:00Z",
  touched: "2026-11-21T09:00:00Z",
  liveUntil: "2026-11-21T09:10:00Z",
  ...overrides,
});

const rucodeHome = initiative({
  orchestratorSession: "orchestrator-session",
  orchestratorCwd: "/dev/rucode",
  repos: [{ root: "/dev/rucode", worktrees: ["/dev/rucode-worktrees/card-core"] }],
});

const everyThread = lookup({
  sessions: { "grant-session": GRANT_THREAD, "orchestrator-session": ORCHESTRATOR_THREAD },
  dirs: { "/dev/rucode-worktrees/card-core": [DIR_THREAD] },
});

describe("mapDecisionToThread", () => {
  it.effect("maps to the thread whose Claude session holds the grant, before any other rule", () =>
    Effect.gen(function* () {
      const mapped = yield* mapDecisionToThread(
        record({ grantSession: "grant-session", initiative: "rucode-home" }),
        [rucodeHome],
        everyThread,
      );
      assert.strictEqual(mapped, GRANT_THREAD);
    }),
  );

  it.effect(
    "falls through to the named initiative's orchestrator when the grant session has no thread",
    () =>
      Effect.gen(function* () {
        const mapped = yield* mapDecisionToThread(
          record({ grantSession: "gone-session", initiative: "rucode-home" }),
          [initiative({ slug: "other", orchestratorSession: "grant-session" }), rucodeHome],
          everyThread,
        );
        assert.strictEqual(mapped, ORCHESTRATOR_THREAD);
      }),
  );

  it.effect("finds the initiative by a worktree that holds the decision's directory", () =>
    Effect.gen(function* () {
      const mapped = yield* mapDecisionToThread(
        record({ dir: "/dev/rucode-worktrees/card-core/apps/server" }),
        [rucodeHome],
        everyThread,
      );
      assert.strictEqual(mapped, ORCHESTRATOR_THREAD);
    }),
  );

  it.effect("finds the initiative by its orchestrator directory", () =>
    Effect.gen(function* () {
      const mapped = yield* mapDecisionToThread(
        record({ dir: "/dev/rucode" }),
        [
          initiative({
            orchestratorSession: "orchestrator-session",
            orchestratorCwd: "/dev/rucode",
          }),
        ],
        everyThread,
      );
      assert.strictEqual(mapped, ORCHESTRATOR_THREAD);
    }),
  );

  it.effect("does not match a directory that only shares a name prefix with a worktree", () =>
    Effect.gen(function* () {
      const mapped = yield* mapDecisionToThread(
        record({ dir: "/dev/rucode-worktrees/card-core-2" }),
        [rucodeHome],
        everyThread,
      );
      assert.isNull(mapped);
    }),
  );

  it.effect("ignores a closed initiative and an ambiguous directory match", () =>
    Effect.gen(function* () {
      const closed = yield* mapDecisionToThread(
        record({ dir: "/dev/rucode" }),
        [{ ...rucodeHome, closed: true }],
        everyThread,
      );
      assert.isNull(closed);
      const ambiguous = yield* mapDecisionToThread(
        record(),
        [rucodeHome, { ...rucodeHome, slug: "rucode-two", orchestratorSession: "grant-session" }],
        lookup({
          sessions: { "grant-session": GRANT_THREAD, "orchestrator-session": ORCHESTRATOR_THREAD },
        }),
      );
      assert.isNull(ambiguous);
    }),
  );

  it.effect(
    "maps to the one thread working in the decision's directory when no session matches",
    () =>
      Effect.gen(function* () {
        const mapped = yield* mapDecisionToThread(
          record({ grantSession: "gone-session", initiative: "rucode-home" }),
          [{ ...rucodeHome, orchestratorSession: "gone-orchestrator" }],
          everyThread,
        );
        assert.strictEqual(mapped, DIR_THREAD);
      }),
  );

  it.effect("leaves the decision unmapped when two threads share its directory", () =>
    Effect.gen(function* () {
      const mapped = yield* mapDecisionToThread(
        record(),
        [],
        lookup({ dirs: { "/dev/rucode-worktrees/card-core": [DIR_THREAD, OTHER_DIR_THREAD] } }),
      );
      assert.isNull(mapped);
    }),
  );

  it.effect("leaves the decision unmapped when nothing matches", () =>
    Effect.gen(function* () {
      assert.isNull(yield* mapDecisionToThread(record(), [], lookup({})));
    }),
  );
});

describe("mapRunToThread", () => {
  const run = { dir: "/dev/rucode-worktrees/card-core", pid: 4242 };

  it.effect("maps a run to the thread its process environment names", () =>
    Effect.gen(function* () {
      const mapped = yield* mapRunToThread(
        run,
        lookup({ pids: { 4242: PID_THREAD }, dirs: { [run.dir]: [DIR_THREAD] } }),
      );
      assert.strictEqual(mapped, PID_THREAD);
    }),
  );

  it.effect("falls back to the one thread in the run's directory", () =>
    Effect.gen(function* () {
      const mapped = yield* mapRunToThread(
        run,
        lookup({ pids: { 1: PID_THREAD }, dirs: { [run.dir]: [DIR_THREAD] } }),
      );
      assert.strictEqual(mapped, DIR_THREAD);
    }),
  );

  it.effect("leaves the run unmapped when two threads share its directory", () =>
    Effect.gen(function* () {
      const mapped = yield* mapRunToThread(
        run,
        lookup({ dirs: { [run.dir]: [DIR_THREAD, OTHER_DIR_THREAD] } }),
      );
      assert.isNull(mapped);
    }),
  );
});
