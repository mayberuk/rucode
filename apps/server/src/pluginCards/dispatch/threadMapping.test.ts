import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { DispatchDecisionRecord } from "./decisionRecord.ts";
import type { DispatchLiveInitiative } from "./liveRegistry.ts";
import { mapDecisionToThread, mapRunToThread, type RunOpenedRow } from "./threadMapping.ts";

const GRANT_THREAD = ThreadId.make("thread-grant");
const ORCHESTRATOR_THREAD = ThreadId.make("thread-orchestrator");
const DIR_THREAD = ThreadId.make("thread-dir");
const PID_THREAD = ThreadId.make("thread-pid");
const OTHER_THREAD = ThreadId.make("thread-other");

/** `dirs` is what a directory guess would see; mapping must never consult it. */
const lookup = (world: {
  readonly sessions?: Record<string, ThreadId>;
  readonly dirs?: Record<string, ReadonlyArray<ThreadId>>;
  readonly pids?: Record<number, ThreadId>;
}) => ({
  threadForClaudeSession: (sessionId: string) =>
    Effect.succeed(world.sessions?.[sessionId] ?? null),
  threadsForDir: (dir: string) => Effect.succeed(world.dirs?.[dir] ?? []),
  threadForPid: (pid: number) => Effect.succeed(world.pids?.[pid] ?? null),
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

const opened = (overrides: Partial<RunOpenedRow>): RunOpenedRow => ({
  schema: "dp-run/1",
  ts: "2026-11-21T09:30:00Z",
  event: "run-opened",
  run: "r-1",
  dir: "/dev/rucode-worktrees/card-core",
  part: "card-core",
  wave: 2,
  spec: ".claude/plans/card-core.md",
  pid: 4242,
  phases: 3,
  ...overrides,
});

describe("mapDecisionToThread", () => {
  it.effect("maps to the thread whose Claude session holds the grant, before any other rule", () =>
    Effect.gen(function* () {
      const mapped = yield* mapDecisionToThread(
        record({ grantSession: "grant-session", initiative: "rucode-home" }),
        [rucodeHome],
        everyThread,
        [],
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
          [],
        );
        assert.strictEqual(mapped, ORCHESTRATOR_THREAD);
      }),
  );

  it.effect(
    "maps a named initiative's decision through its orchestrator's process when its session has no chat",
    () =>
      Effect.gen(function* () {
        const mapped = yield* mapDecisionToThread(
          record({ initiative: "rucode-home" }),
          [{ ...rucodeHome, orchestratorSession: "cli-session", orchestratorPid: 777 }],
          lookup({ pids: { 777: PID_THREAD } }),
          [],
        );
        assert.strictEqual(mapped, PID_THREAD);
      }),
  );

  it.effect("does not guess an initiative from the decision's directory", () =>
    Effect.gen(function* () {
      for (const dir of ["/dev/rucode-worktrees/card-core/apps/server", "/dev/rucode"]) {
        assert.isNull(yield* mapDecisionToThread(record({ dir }), [rucodeHome], everyThread, []));
      }
    }),
  );

  it.effect("leaves a decision unmapped even when one thread works in its directory", () =>
    Effect.gen(function* () {
      const mapped = yield* mapDecisionToThread(
        record({ grantSession: "gone-session", initiative: "rucode-home" }),
        [{ ...rucodeHome, orchestratorSession: "gone-orchestrator" }],
        everyThread,
        [],
      );
      assert.isNull(mapped);
    }),
  );

  it.effect(
    "maps an unbound decision to the chat whose process opened the run with the same dir, part and wave",
    () =>
      Effect.gen(function* () {
        const runs = [
          opened({ run: "r-older", pid: 1, ts: "2026-11-21T08:00:00Z" }),
          opened({ run: "r-opener", pid: 4242 }),
          opened({ run: "r-other-part", pid: 2, part: "web" }),
          opened({ run: "r-other-wave", pid: 3, wave: 3 }),
          opened({ run: "r-other-dir", pid: 4, dir: "/dev/rucode" }),
          opened({ run: "r-later", pid: 5, ts: "2026-11-21T10:00:01Z" }),
        ];
        const pids = { 1: OTHER_THREAD, 2: OTHER_THREAD, 3: OTHER_THREAD, 4: OTHER_THREAD };
        const world = lookup({ pids: { ...pids, 4242: PID_THREAD, 5: OTHER_THREAD } });
        assert.strictEqual(yield* mapDecisionToThread(record(), [], world, runs), PID_THREAD);
        assert.isNull(
          yield* mapDecisionToThread(record(), [], lookup({ pids }), runs),
          "the opener's process names no chat",
        );
      }),
  );

  it.effect("leaves the decision unmapped when nothing matches", () =>
    Effect.gen(function* () {
      assert.isNull(yield* mapDecisionToThread(record(), [], lookup({}), []));
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

  it.effect("leaves a run unmapped when only its directory matches a chat", () =>
    Effect.gen(function* () {
      const mapped = yield* mapRunToThread(
        run,
        lookup({ pids: { 1: PID_THREAD }, dirs: { [run.dir]: [DIR_THREAD] } }),
      );
      assert.isNull(mapped);
    }),
  );
});
