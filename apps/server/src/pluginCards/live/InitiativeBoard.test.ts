import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { PluginInitiativeBoard } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../../processRunner.ts";
import { InitiativeBoard, makeInitiativeBoard } from "./InitiativeBoard.ts";

const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-21T12:00:00Z"));
const ALIVE_PID = 4242;

const processOutput = (stdout: string, code: number): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

interface Fixture {
  readonly root: string;
  readonly initiativesRoot: string;
  readonly repo: string;
  readonly worktree: (part: string) => string;
  /** stdout per slug, per worktree and per spec path; a missing key exits 1. */
  readonly shows: Map<string, string>;
  readonly waveLive: Map<string, string>;
  readonly specs: Map<string, string>;
  readonly calls: Array<string>;
  readonly callQueue: Queue.Queue<string>;
  readonly warnings: Array<string>;
}

const write = (file: string, contents: unknown) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(
      file,
      typeof contents === "string" ? contents : JSON.stringify(contents),
    );
  });

const initiativeShow = (fixture: Fixture, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    initiative: { slug: "alpha", title: "Alpha rollout", repos: null },
    parts: [
      {
        id: "part-a",
        title: "Checkout retries: backoff",
        repo: "acme/app",
        zone: null,
        wave: 0,
        status: "specced",
      },
      { id: "part-b", title: "Receipts", repo: "acme/app", zone: null, wave: 0, status: "planned" },
      {
        id: "part-c",
        title: "Refunds",
        repo: "acme/app",
        zone: null,
        wave: 1,
        status: "gate-fail",
      },
      {
        id: "part-d",
        title: "Ledger reader",
        repo: "acme/app",
        zone: null,
        wave: 1,
        status: "specced",
      },
    ],
    waves: [
      { number: 0, opened: true, closed: false, parts: ["part-a", "part-b"] },
      { number: 1, opened: false, closed: false, parts: ["part-c", "part-d"] },
    ],
    progress: [
      {
        part: "part-c",
        lastEventAt: null,
        gate: {
          passed: false,
          at: "2026-11-21T09:00:00Z",
          record: `${fixture.root}/gone/part-c/.claude/work/wave-run-1.json`,
        },
      },
      {
        part: "part-d",
        lastEventAt: null,
        gate: {
          passed: false,
          at: "2026-11-21T09:00:00Z",
          record: `${fixture.worktree("part-d")}/.claude/work/wave-run-1.json`,
        },
      },
    ],
    deliveries: null,
    closed: false,
    ...overrides,
  });

const executor = (phase: string, disposition: string) => ({
  id: `exec-${phase}`,
  kind: "phase-executor",
  phase,
  attempt: 1,
  state: disposition === "" ? "running" : "done",
  costUsd: null,
  stale: false,
  disposition,
});

const waveLive = (
  dir: string,
  part: string,
  run: { readonly alive: boolean; readonly secondPhase: string },
) =>
  JSON.stringify({
    schema: "mc/1",
    parts: [
      {
        runId: `run-${part}`,
        runStartedAt: "2026-11-21T11:00:00Z",
        alive: run.alive,
        part,
        wave: 0,
        dir,
        initiative: "alpha",
        complete: !run.alive,
        children: [executor("1", "settled"), executor("2", run.secondPhase)],
        gate: null,
        phases: [
          { id: "1", name: "Contract", wave: 0, tier: "standard" },
          { id: "2", name: "Server", wave: 0, tier: "standard" },
        ],
      },
    ],
  });

const decision = (id: string, state: string, initiative: string) => ({
  schema: "decision/1",
  id,
  kind: "batch-approval",
  part: "part-a",
  wave: 0,
  phase: "",
  question: `Approve ${id}?`,
  options: [{ key: "go", label: "Go", command: "" }],
  default: "",
  defaultReason: "",
  raisedAt: "2026-11-21T10:00:00Z",
  applyAfter: "0001-01-01T00:00:00Z",
  state,
  choice: "",
  chosenBy: "",
  resolvedAt: "",
  initiative,
});

/**
 * Real files under a temp root, a fake `dp` answering from the fixture's maps. part-a has a
 * worktree with a running wave record, part-b is listed in the registry without a worktree on
 * disk, part-c's gate record names a deleted worktree, and part-d's names a worktree that has a
 * plan but no wave record.
 */
const withBoard = <A, E, R>(
  body: (fixture: Fixture, board: InitiativeBoard["Service"]) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* TestClock.setTime(NOW);
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-initiative-board-" });
    const fixture: Fixture = {
      root,
      initiativesRoot: path.join(root, "initiatives"),
      repo: path.join(root, "repo"),
      worktree: (part) => path.join(root, "worktrees", part),
      shows: new Map(),
      waveLive: new Map(),
      specs: new Map(),
      calls: [],
      callQueue: yield* Queue.unbounded<string>(),
      warnings: [],
    };
    const bin = path.join(root, "bin");
    const procRoot = path.join(root, "proc");
    const partA = fixture.worktree("part-a");
    const partD = fixture.worktree("part-d");
    yield* fs.makeDirectory(bin, { recursive: true });
    yield* fs.writeFileString(path.join(bin, "dp"), "", { mode: 0o755 });
    yield* fs.makeDirectory(path.join(procRoot, String(ALIVE_PID)), { recursive: true });
    yield* write(path.join(fixture.initiativesRoot, "alpha", "ledger.jsonl"), "{}\n");
    yield* write(path.join(fixture.initiativesRoot, ".pairs", "alpha", "record.json"), {
      spend_ceiling_usd: 20,
    });
    yield* write(path.join(fixture.initiativesRoot, ".live", "alpha.json"), {
      slug: "alpha",
      closed: false,
      totalWave: 2,
      totalRunning: 1,
      totalSettled: 0,
      totalCostUsd: 0,
      reportedCostUsd: 0,
      started: "2026-11-21T10:00:00Z",
      touched: "2026-11-21T11:00:00Z",
      liveUntil: "2026-11-21T13:00:00Z",
      repos: [{ root: fixture.repo, worktrees: [partA, fixture.worktree("part-b")] }],
    });
    yield* write(path.join(partA, ".git", "HEAD"), "ref: refs/heads/feature/part-a\n");
    yield* write(path.join(partA, ".claude", "work", "wave-run-1.json"), "{}");
    yield* write(path.join(partA, ".claude", "work", "wave-run-1.json.alive"), {
      pid: ALIVE_PID,
    });
    const decisions = (checkout: string) => path.join(checkout, ".claude", "work", "decisions");
    yield* write(path.join(decisions(partA), "d-open.json"), decision("d-open", "open", "alpha"));
    yield* write(
      path.join(decisions(partA), "d-answered.json"),
      decision("d-answered", "answered", "alpha"),
    );
    yield* write(path.join(decisions(partA), "d-other.json"), decision("d-other", "open", "beta"));
    yield* write(
      path.join(decisions(fixture.repo), "d-root.json"),
      decision("d-root", "open", "alpha"),
    );
    const partDPlan = path.join(partD, ".claude", "plans", "part-d.md");
    yield* write(partDPlan, "# Ledger reader\n");

    fixture.shows.set("alpha", initiativeShow(fixture));
    fixture.waveLive.set(partA, waveLive(partA, "part-a", { alive: true, secondPhase: "" }));
    fixture.specs.set(partDPlan, JSON.stringify([{ id: "1", name: "Reader", wave: "1" }]));

    const runner: ProcessRunner.ProcessRunner["Service"] = {
      run: (input) => {
        const [verb] = input.args;
        const [key, stdout] =
          verb === "initiative"
            ? [`show ${input.args[2]}`, fixture.shows.get(input.args[2] ?? "")]
            : verb === "wave"
              ? [`wave ${input.args[3]}`, fixture.waveLive.get(input.args[3] ?? "")]
              : [`spec ${input.args[2]}`, fixture.specs.get(input.args[2] ?? "")];
        fixture.calls.push(key);
        return Queue.offer(fixture.callQueue, key).pipe(
          Effect.as(processOutput(stdout ?? "", stdout === undefined ? 1 : 0)),
        );
      },
    };
    const logger = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") fixture.warnings.push(JSON.stringify(message));
    });

    return yield* Effect.gen(function* () {
      const board = yield* makeInitiativeBoard({
        initiativesRoot: fixture.initiativesRoot,
        procRoot,
      });
      return yield* body(fixture, board);
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcess.Environment, { PATH: bin }),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    );
  });

const collectBoards = (board: InitiativeBoard["Service"]) =>
  Effect.gen(function* () {
    const boards = yield* Queue.unbounded<PluginInitiativeBoard>();
    yield* Effect.forkChild(
      Stream.runForEach(board.subscribe("alpha"), (next) => Queue.offer(boards, next)),
    );
    return boards;
  });

const awaitCall = (fixture: Fixture, key: string): Effect.Effect<void> =>
  Queue.take(fixture.callQueue).pipe(
    Effect.flatMap((call) => (call === key ? Effect.void : awaitCall(fixture, key))),
  );

/** Real file events arrive on wall-clock time, so each step is driven by the liveness recheck. */
const recheck = TestClock.adjust("30 seconds");

const appendLedger = (fixture: Fixture, rows: string) =>
  write(`${fixture.initiativesRoot}/alpha/ledger.jsonl`, rows);

const partsOf = (board: PluginInitiativeBoard) =>
  board.waves.flatMap((wave) =>
    wave.parts.map(({ id, wave: number, status, phases, branch }) => ({
      id,
      wave: number,
      status,
      phases,
      branch,
    })),
  );

const waveCalls = (fixture: Fixture) =>
  fixture.calls.filter((call) => call.startsWith("wave ")).toSorted();

it.layer(NodeServices.layer)("initiative board", (it) => {
  it.effect(
    "builds the first board from the ledger, registry, pair record, worktrees and decisions",
    () =>
      withBoard((fixture, board) =>
        Effect.gen(function* () {
          const partA = fixture.worktree("part-a");
          const [first] = yield* Stream.runCollect(Stream.take(board.subscribe("alpha"), 1));
          assert.isDefined(first);
          assert.strictEqual(first.slug, "alpha");
          assert.strictEqual(first.title, "Alpha rollout");
          assert.strictEqual(first.asOf, "2026-11-21T12:00:00.000Z");
          assert.strictEqual(first.currentWave, 1);
          assert.strictEqual(first.spend.ceilingUsd, 20);
          assert.deepStrictEqual(
            first.waves.map((wave) => wave.number),
            [1, 2],
          );
          assert.deepStrictEqual(partsOf(first), [
            {
              id: "part-a",
              wave: 1,
              status: "running",
              phases: [
                { id: "1", name: "Contract", state: "done", attempt: null },
                { id: "2", name: "Server", state: "running", attempt: null },
              ],
              branch: "feature/part-a",
            },
            { id: "part-b", wave: 1, status: "queued", phases: [], branch: null },
            { id: "part-c", wave: 2, status: "gate-fail", phases: [], branch: null },
            {
              id: "part-d",
              wave: 2,
              status: "specced",
              phases: [{ id: "1", name: "Reader", state: "pending", attempt: null }],
              branch: null,
            },
          ]);
          assert.deepStrictEqual(
            first.needsYou.map((item) => item.decisionId),
            ["d-open", "d-root"],
          );
          assert.deepStrictEqual(first.headline, {
            kind: "needs-you",
            decisions: 2,
            part: "part-a",
          });
          assert.deepStrictEqual(fixture.calls.toSorted(), [
            "show alpha",
            `spec ${fixture.worktree("part-d")}/.claude/plans/part-d.md`,
            `wave ${partA}`,
          ]);
        }),
      ),
  );

  it.effect.each([
    { name: "the slug is invalid", slug: "../alpha" },
    { name: "the initiative has no ledger", slug: "beta" },
    { name: "dp cannot read the initiative", slug: "alpha", dpFails: true },
  ])("ends the subscription with source-failed when $name", ({ slug, dpFails }) =>
    withBoard((fixture, board) =>
      Effect.gen(function* () {
        if (dpFails === true) fixture.shows.delete("alpha");
        fixture.shows.set("beta", initiativeShow(fixture));
        const error = yield* Effect.flip(Stream.runCollect(board.subscribe(slug)));
        assert.strictEqual(error.reason, "source-failed");
      }),
    ),
  );

  it.effect("re-reads only a changed worktree and stays quiet when nothing changed", () =>
    withBoard((fixture, board) =>
      Effect.gen(function* () {
        const partA = fixture.worktree("part-a");
        const partB = fixture.worktree("part-b");
        yield* write(`${partB}/.claude/work/wave-run-1.json`, "{}");
        fixture.waveLive.set(
          partB,
          waveLive(partB, "part-b", { alive: false, secondPhase: "settled" }),
        );

        const boards = yield* collectBoards(board);
        const first = yield* Queue.take(boards);
        assert.deepStrictEqual(waveCalls(fixture), [`wave ${partA}`, `wave ${partB}`]);
        yield* awaitCall(fixture, "show alpha");

        yield* appendLedger(fixture, "{}\n{}\n");
        yield* recheck;
        yield* awaitCall(fixture, "show alpha");
        // Refreshes run one at a time, so the next one reaching dp proves this one has finished.
        yield* appendLedger(fixture, "{}\n{}\n{}\n");
        yield* recheck;
        yield* awaitCall(fixture, "show alpha");
        assert.deepStrictEqual(waveCalls(fixture), [`wave ${partA}`, `wave ${partB}`]);

        fixture.waveLive.set(
          partA,
          waveLive(partA, "part-a", { alive: true, secondPhase: "settled" }),
        );
        yield* write(`${partA}/.claude/work/wave-run-1.json`, '{"changed":true}');
        yield* recheck;
        const next = yield* Queue.take(boards);

        assert.deepStrictEqual(
          partsOf(first)[0]?.phases.map((phase) => phase.state),
          ["done", "running"],
        );
        assert.deepStrictEqual(
          partsOf(next)[0]?.phases.map((phase) => phase.state),
          ["done", "done"],
        );
        assert.deepStrictEqual(waveCalls(fixture), [
          `wave ${partA}`,
          `wave ${partA}`,
          `wave ${partB}`,
        ]);
      }),
    ),
  );

  it.effect("re-runs dp wave live once a run's process exits, though no file changed", () =>
    withBoard((fixture, board) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const partA = fixture.worktree("part-a");
        const boards = yield* collectBoards(board);
        const first = yield* Queue.take(boards);
        assert.strictEqual(partsOf(first)[0]?.status, "running");

        fixture.waveLive.set(partA, waveLive(partA, "part-a", { alive: false, secondPhase: "" }));
        yield* fs.remove(`${fixture.root}/proc/${ALIVE_PID}`, { recursive: true });
        yield* recheck;
        const next = yield* Queue.take(boards);
        assert.strictEqual(partsOf(next)[0]?.status, "queued");
        assert.deepStrictEqual(waveCalls(fixture), [`wave ${partA}`, `wave ${partA}`]);
      }),
    ),
  );

  it.effect.each([
    {
      name: "dp initiative show",
      call: (_fixture: Fixture) => "show alpha",
      fail: (fixture: Fixture) =>
        Effect.gen(function* () {
          fixture.shows.delete("alpha");
          yield* appendLedger(fixture, "{}\n{}\n");
        }),
    },
    {
      name: "dp wave live",
      call: (fixture: Fixture) => `wave ${fixture.worktree("part-a")}`,
      fail: (fixture: Fixture) =>
        Effect.gen(function* () {
          fixture.waveLive.delete(fixture.worktree("part-a"));
          yield* write(`${fixture.worktree("part-a")}/.claude/work/wave-run-1.json`, "{ }");
        }),
    },
  ])("keeps the last board and logs when $name fails after the first board", ({ call, fail }) =>
    withBoard((fixture, board) =>
      Effect.gen(function* () {
        const partA = fixture.worktree("part-a");
        const failingCall = call(fixture);
        const boards = yield* collectBoards(board);
        const first = yield* Queue.take(boards);
        yield* awaitCall(fixture, failingCall);
        assert.deepStrictEqual(fixture.warnings, []);

        yield* fail(fixture);
        yield* recheck;
        yield* awaitCall(fixture, failingCall);

        fixture.shows.set(
          "alpha",
          initiativeShow(fixture, {
            initiative: { slug: "alpha", title: "Renamed", repos: null },
          }),
        );
        fixture.waveLive.set(partA, waveLive(partA, "part-a", { alive: true, secondPhase: "" }));
        yield* appendLedger(fixture, "{}\n{}\n{}\n");
        yield* recheck;
        const next = yield* Queue.take(boards);

        assert.strictEqual(next.title, "Renamed");
        assert.deepStrictEqual(partsOf(next), partsOf(first));
        assert.isAbove(fixture.warnings.length, 0);
      }),
    ),
  );

  it.effect("runs no refresh without a subscriber, nor after the last one leaves", () =>
    withBoard((fixture, board) =>
      Effect.gen(function* () {
        yield* TestClock.adjust("10 minutes");
        assert.deepStrictEqual(fixture.calls, []);

        yield* Stream.runCollect(Stream.take(board.subscribe("alpha"), 1));
        const afterFirst = fixture.calls.length;
        yield* appendLedger(fixture, "{}\n{}\n");
        yield* TestClock.adjust("10 minutes");
        assert.strictEqual(fixture.calls.length, afterFirst);
      }),
    ),
  );
});
