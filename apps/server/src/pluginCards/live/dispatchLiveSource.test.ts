import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../../processRunner.ts";
import type { PluginLiveSource } from "../core/PluginCardSource.ts";
import { PluginThreadIndex } from "../core/PluginThreadIndex.ts";
import { makeDispatchLiveSource } from "./dispatchLiveSource.ts";

const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-21T12:00:00Z"));
const at = (offsetMs: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW + offsetMs));
const HOUR = 3_600_000;

const THREAD_ORCHESTRATOR = ThreadId.make("thread-orchestrator");
const THREAD_RUN = ThreadId.make("thread-run");
const ALIVE_PID = 4242;
const OTHER_PID = 5151;

const registryEntry = (slug: string, overrides: Record<string, unknown> = {}) => ({
  slug,
  closed: false,
  totalWave: 3,
  totalRunning: 2,
  totalSettled: 5,
  totalCostUsd: 4,
  reportedCostUsd: 6,
  started: "2026-11-21T10:00:00Z",
  touched: "2026-11-21T11:00:00Z",
  liveUntil: at(HOUR),
  ...overrides,
});

const initiativeShow = (slug: string, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    initiative: { slug, title: `Title of ${slug}`, repos: null },
    parts: [{ id: "core", title: "Core", repo: "rucode", zone: null, wave: 1, status: "merged" }],
    waves: [{ number: 1, opened: true, closed: false, parts: ["core"] }],
    closed: false,
    ...overrides,
  });

const decisionRecord = (id: string, state: string, initiative?: string) => ({
  schema: "decision/1",
  id,
  kind: "batch-approval",
  part: "core",
  wave: 1,
  phase: "",
  question: `Approve ${id}?`,
  options: [{ key: "go", label: "Go", command: "" }],
  default: "go",
  defaultReason: "",
  raisedAt: "2026-11-21T10:00:00Z",
  applyAfter: "0001-01-01T00:00:00Z",
  state,
  choice: "",
  chosenBy: "",
  resolvedAt: "",
  ...(initiative === undefined ? {} : { initiative }),
});

const feedRow = (row: Record<string, unknown>) =>
  `${JSON.stringify({ schema: "dp-run/1", ...row })}\n`;
const openedRow = (run: string, pid: number, part = "core") =>
  feedRow({
    ts: at(-HOUR),
    event: "run-opened",
    run,
    dir: "/work/run",
    part,
    wave: 1,
    spec: ".claude/plans/core.md",
    pid,
    phases: 2,
    initiative: "alpha",
  });
const settledRow = (run: string, pid: number, outcome: string) =>
  feedRow({
    ts: at(-60_000),
    event: "run-settled",
    run,
    dir: "/work/run",
    part: "core",
    wave: 1,
    pid,
    outcome,
  });

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
  readonly runFeed: string;
  readonly procRoot: string;
  /** `dp initiative show` stdout per slug; a missing slug exits 1. */
  readonly shows: Map<string, string>;
  readonly dpCalls: Array<string>;
  readonly pidThreads: Map<number, ThreadId>;
}

/** Real files under a temp root; a fake `dp` on PATH, a fake runner and a fake thread index. */
const withSource = <A, E, R>(
  body: (fixture: Fixture, source: PluginLiveSource) => Effect.Effect<A, E, R>,
  options: { readonly dpInstalled?: boolean } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* TestClock.setTime(NOW);
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dispatch-live-source-" });
    const bin = path.join(root, "bin");
    const fixture: Fixture = {
      root,
      initiativesRoot: path.join(root, "initiatives"),
      runFeed: path.join(root, "state", "runs.jsonl"),
      procRoot: path.join(root, "proc"),
      shows: new Map(),
      dpCalls: [],
      pidThreads: new Map(),
    };
    for (const dir of [
      bin,
      path.join(fixture.initiativesRoot, ".live"),
      path.dirname(fixture.runFeed),
      fixture.procRoot,
    ]) {
      yield* fs.makeDirectory(dir, { recursive: true });
    }
    yield* fs.writeFileString(path.join(bin, "dp"), "", { mode: 0o755 });

    const runner: ProcessRunner.ProcessRunner["Service"] = {
      run: (input) => {
        const slug = input.args[2] ?? "";
        fixture.dpCalls.push(slug);
        const show = fixture.shows.get(slug);
        return Effect.succeed(processOutput(show ?? "", show === undefined ? 1 : 0));
      },
    };
    const index = PluginThreadIndex.of({
      threadForClaudeSession: (session) =>
        Effect.succeed(session === "orchestrator-session" ? THREAD_ORCHESTRATOR : null),
      threadsForDir: () => Effect.succeed([]),
      threadForPid: (pid) => Effect.succeed(fixture.pidThreads.get(pid) ?? null),
      claudeTranscript: () => Effect.succeed(null),
      decisionLookup: Effect.succeed({
        checkouts: [],
        threadForClaudeSession: () => Effect.succeed(null),
        threadsForDir: () => Effect.succeed([]),
      }),
      decisionMappingChanges: Stream.empty,
      checkouts: Effect.succeed([]),
    });

    return yield* Effect.gen(function* () {
      const source = yield* makeDispatchLiveSource({
        initiativesRoot: fixture.initiativesRoot,
        runFeedPath: fixture.runFeed,
        procRoot: fixture.procRoot,
      });
      return yield* body(fixture, source);
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(PluginThreadIndex, index),
      Effect.provideService(HostProcess.Environment, {
        PATH: options.dpInstalled === false ? "" : bin,
      }),
    );
  });

const writeRegistry = (fixture: Fixture, name: string, contents: unknown) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(
      path.join(fixture.initiativesRoot, ".live", name),
      typeof contents === "string" ? contents : JSON.stringify(contents),
    );
  });

const writeLedger = (fixture: Fixture, slug: string, contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.join(fixture.initiativesRoot, slug), { recursive: true });
    yield* fs.writeFileString(path.join(fixture.initiativesRoot, slug, "ledger.jsonl"), contents);
  });

const markAlive = (fixture: Fixture, pid: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.join(fixture.procRoot, String(pid)));
  });

it.layer(NodeServices.layer)("dispatch live source", (it) => {
  it.effect("reports open initiatives only, skipping an unreadable registry file", () =>
    withSource((fixture, source) =>
      Effect.gen(function* () {
        yield* writeRegistry(
          fixture,
          "alpha.json",
          registryEntry("alpha", { orchestratorSession: "orchestrator-session" }),
        );
        yield* writeRegistry(fixture, "beta.json", registryEntry("beta", { closed: true }));
        yield* writeRegistry(fixture, "broken.json", "{");
        yield* writeRegistry(
          fixture,
          "delta.json",
          registryEntry("delta", { orchestratorPid: OTHER_PID }),
        );
        yield* writeRegistry(fixture, "gamma.json", registryEntry("gamma"));
        fixture.shows.set("alpha", initiativeShow("alpha"));
        fixture.shows.set("delta", initiativeShow("delta"));
        fixture.shows.set("gamma", initiativeShow("gamma", { closed: true }));
        fixture.pidThreads.set(OTHER_PID, THREAD_RUN);

        const { initiatives } = yield* source.snapshot;
        assert.deepStrictEqual(
          initiatives.map(({ slug, title, orchestratorThreadId }) => ({
            slug,
            title,
            orchestratorThreadId,
          })),
          [
            { slug: "alpha", title: "Title of alpha", orchestratorThreadId: THREAD_ORCHESTRATOR },
            { slug: "delta", title: "Title of delta", orchestratorThreadId: THREAD_RUN },
          ],
        );
      }),
    ),
  );

  it.effect.each([
    { name: "dp exits non-zero", dpInstalled: true },
    { name: "dp is missing", dpInstalled: false },
  ])("still reports the initiative when $name", ({ dpInstalled }) =>
    withSource(
      (fixture, source) =>
        Effect.gen(function* () {
          yield* writeRegistry(fixture, "alpha.json", registryEntry("alpha", { totalWave: 3 }));
          const [initiative] = (yield* source.snapshot).initiatives;
          assert.strictEqual(initiative?.title, null);
          assert.deepStrictEqual(initiative?.parts, []);
          assert.deepStrictEqual(initiative?.wave, {
            current: 3,
            total: 3,
            partsSettled: 0,
            partsTotal: 0,
          });
        }),
      { dpInstalled },
    ),
  );

  it.effect("runs dp again only after the initiative's ledger changes", () =>
    withSource((fixture, source) =>
      Effect.gen(function* () {
        yield* writeRegistry(fixture, "alpha.json", registryEntry("alpha"));
        yield* writeLedger(fixture, "alpha", "{}\n");
        fixture.shows.set("alpha", initiativeShow("alpha"));

        yield* source.snapshot;
        yield* source.snapshot;
        assert.deepStrictEqual(fixture.dpCalls, ["alpha"]);

        fixture.shows.set(
          "alpha",
          initiativeShow("alpha", { initiative: { slug: "alpha", title: "Renamed", repos: null } }),
        );
        yield* writeLedger(fixture, "alpha", "{}\n{}\n");
        const [initiative] = (yield* source.snapshot).initiatives;
        assert.deepStrictEqual(fixture.dpCalls, ["alpha", "alpha"]);
        assert.strictEqual(initiative?.title, "Renamed");
      }),
    ),
  );

  it.effect("counts open decisions of the initiative across its checkouts", () =>
    withSource((fixture, source) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repoRoot = path.join(fixture.root, "repo");
        const worktree = path.join(fixture.root, "repo-worktree");
        const orchestratorCwd = path.join(fixture.root, "orchestrator");
        const unrelated = path.join(fixture.root, "unrelated");
        const write = (checkout: string, record: ReturnType<typeof decisionRecord>) =>
          Effect.gen(function* () {
            const dir = path.join(checkout, ".claude", "work", "decisions");
            yield* fs.makeDirectory(dir, { recursive: true });
            yield* fs.writeFileString(path.join(dir, `${record.id}.json`), JSON.stringify(record));
          });
        yield* write(repoRoot, decisionRecord("mine", "open", "alpha"));
        yield* write(repoRoot, decisionRecord("untagged", "open"));
        yield* write(repoRoot, decisionRecord("theirs", "open", "beta"));
        yield* write(repoRoot, decisionRecord("answered", "answered", "alpha"));
        yield* write(worktree, decisionRecord("in-worktree", "open", "alpha"));
        yield* write(orchestratorCwd, decisionRecord("at-orchestrator", "open"));
        yield* write(unrelated, decisionRecord("elsewhere", "open", "alpha"));
        yield* writeRegistry(
          fixture,
          "alpha.json",
          registryEntry("alpha", {
            orchestratorCwd,
            repos: [{ root: repoRoot, worktrees: [worktree] }],
          }),
        );

        const [initiative] = (yield* source.snapshot).initiatives;
        assert.strictEqual(initiative?.openDecisions, 4);
      }),
    ),
  );

  it.effect("reads only appended run feed rows and keeps a run's chat after its pid exits", () =>
    withSource((fixture, source) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const first = openedRow("r-1", ALIVE_PID);
        const dead = openedRow("r-2", OTHER_PID);
        yield* fs.writeFileString(fixture.runFeed, first + dead);
        yield* markAlive(fixture, ALIVE_PID);
        fixture.pidThreads.set(ALIVE_PID, THREAD_RUN);

        const before = (yield* source.snapshot).children;
        assert.deepStrictEqual(
          before.map(({ id, state, threadId, part }) => ({ id, state, threadId, part })),
          [
            { id: "r-1:4242", state: "running", threadId: THREAD_RUN, part: "core" },
            { id: "r-2:5151", state: "aborted", threadId: null, part: "core" },
          ],
        );

        // Same length, same file: a reader that went back to the start would see "corx".
        const rewrittenFirst = openedRow("r-1", ALIVE_PID, "corx");
        yield* fs.writeFileString(
          fixture.runFeed,
          rewrittenFirst + dead + settledRow("r-1", ALIVE_PID, "passed"),
        );
        yield* fs.remove(path.join(fixture.procRoot, String(ALIVE_PID)), { recursive: true });
        fixture.pidThreads.delete(ALIVE_PID);

        const after = (yield* source.snapshot).children;
        assert.deepStrictEqual(
          after.map(({ id, state, threadId, part }) => ({ id, state, threadId, part })),
          [
            { id: "r-1:4242", state: "settled", threadId: THREAD_RUN, part: "core" },
            { id: "r-2:5151", state: "aborted", threadId: null, part: "core" },
          ],
        );
      }),
    ),
  );

  it.effect("treats an unsettled run as running when there is no process directory", () =>
    withSource((fixture, source) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(fixture.procRoot, { recursive: true });
        yield* fs.writeFileString(fixture.runFeed, openedRow("r-1", OTHER_PID));
        const { children } = yield* source.snapshot;
        assert.deepStrictEqual(
          children.map((child) => child.state),
          ["running"],
        );
      }),
    ),
  );

  it.effect.each([
    { name: "a parent directory", slug: "../../elsewhere" },
    { name: "a path separator", slug: "alpha/beta" },
    { name: "a leading dash", slug: "-rf" },
    { name: "a leading dot", slug: ".hidden" },
    { name: "more than 128 characters", slug: "a".repeat(129) },
  ])("skips a registry entry whose slug has $name", ({ slug }) =>
    withSource((fixture, source) =>
      Effect.gen(function* () {
        yield* writeRegistry(fixture, "alpha.json", registryEntry("alpha"));
        yield* writeRegistry(fixture, "bad.json", registryEntry(slug));
        fixture.shows.set("alpha", initiativeShow("alpha"));
        fixture.shows.set(slug, initiativeShow(slug));

        const { initiatives } = yield* source.snapshot;
        assert.deepStrictEqual(
          initiatives.map((initiative) => initiative.slug),
          ["alpha"],
        );
        assert.deepStrictEqual(fixture.dpCalls, ["alpha"]);
      }),
    ),
  );

  it.effect("retries a failed dp read after a backoff even when the ledger is unchanged", () =>
    withSource((fixture, source) =>
      Effect.gen(function* () {
        yield* writeRegistry(fixture, "alpha.json", registryEntry("alpha"));
        yield* writeLedger(fixture, "alpha", "{}\n");

        const first = (yield* source.snapshot).initiatives[0];
        assert.strictEqual(first?.title, null);

        fixture.shows.set("alpha", initiativeShow("alpha"));
        const early = (yield* source.snapshot).initiatives[0];
        assert.strictEqual(early?.title, null);
        assert.deepStrictEqual(fixture.dpCalls, ["alpha"]);

        yield* TestClock.adjust("60 seconds");
        const later = (yield* source.snapshot).initiatives[0];
        assert.strictEqual(later?.title, "Title of alpha");
        assert.deepStrictEqual(fixture.dpCalls, ["alpha", "alpha"]);

        yield* TestClock.adjust("10 minutes");
        yield* source.snapshot;
        assert.deepStrictEqual(fixture.dpCalls, ["alpha", "alpha"]);
      }),
    ),
  );

  it.effect("re-checks liveness on a timer while a run is recorded as running", () =>
    withSource((fixture, source) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.writeFileString(fixture.runFeed, openedRow("r-1", ALIVE_PID));
        yield* markAlive(fixture, ALIVE_PID);
        const states = (snapshot: Effect.Success<typeof source.snapshot>) =>
          snapshot.children.map((child) => child.state);
        assert.deepStrictEqual(states(yield* source.snapshot), ["running"]);

        const signal = yield* Effect.forkChild(Stream.runHead(source.changes));
        yield* Effect.yieldNow;
        yield* fs.remove(path.join(fixture.procRoot, String(ALIVE_PID)), { recursive: true });

        yield* TestClock.adjust("29 seconds");
        assert.isUndefined(signal.pollUnsafe());
        yield* TestClock.adjust("1 second");
        yield* TestClock.adjust("250 millis");
        yield* Fiber.join(signal);
        assert.deepStrictEqual(states(yield* source.snapshot), ["aborted"]);
      }),
    ),
  );

  it.effect("does not wake on a timer once nothing is running", () =>
    withSource((fixture, source) =>
      Effect.gen(function* () {
        yield* writeRegistry(fixture, "alpha.json", registryEntry("alpha"));
        fixture.shows.set("alpha", initiativeShow("alpha"));
        yield* source.snapshot;
        const signal = yield* Effect.forkChild(Stream.runHead(source.changes));
        yield* Effect.yieldNow;
        yield* TestClock.adjust("10 minutes");
        assert.isUndefined(signal.pollUnsafe());
      }),
    ),
  );
});
