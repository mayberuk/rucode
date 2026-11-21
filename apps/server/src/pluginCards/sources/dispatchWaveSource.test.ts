import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../../processRunner.ts";
import { PluginThreadIndex } from "../core/PluginThreadIndex.ts";
import {
  type DispatchLivePart,
  type DispatchLiveSnapshot,
  toRunProgressData,
  toVerifyChecks,
} from "./dispatchWaveSnapshot.ts";
import { dispatchWaveSource } from "./dispatchWaveSource.ts";

const THREAD = ThreadId.make("thread-a");
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

type Child = DispatchLivePart["children"][number];
type Gate = NonNullable<DispatchLivePart["gate"]>;

const child = (overrides: Partial<Child>): Child => ({
  id: "1",
  kind: "phase-executor",
  phase: "1",
  attempt: 1,
  state: "running",
  costUsd: null,
  stale: false,
  disposition: "",
  ...overrides,
});

const PHASES: DispatchLivePart["phases"] = [
  { id: "1", name: "Earlier wave phase", wave: 1, tier: "standard" },
  { id: "2", name: "Parser", wave: 2, tier: "standard" },
  { id: "3", name: "Watcher", wave: 2, tier: "complex" },
];

const part = (overrides: Partial<DispatchLivePart> = {}): DispatchLivePart => ({
  runId: "r-1",
  runStartedAt: "2026-11-21T10:00:00Z",
  alive: true,
  part: "ui",
  wave: 2,
  dir: "/w",
  initiative: "home",
  spec: "/w/.claude/plans/x.md",
  complete: false,
  children: [],
  gate: null,
  phases: PHASES,
  ...overrides,
});

type Run = NonNullable<DispatchLiveSnapshot["run"]>;
const run = (overrides: Partial<Run> = {}): Run => ({
  id: "r-1",
  startedAt: "2026-11-21T10:00:00Z",
  spec: "/w/.claude/plans/x.md",
  active: true,
  outcome: "running",
  endedAt: null,
  ...overrides,
});

const snapshot = (
  parts: ReadonlyArray<DispatchLivePart>,
  current: Run | null = run(),
): DispatchLiveSnapshot => ({ schema: "mc/1", run: current, parts });

const gate = (overrides: Partial<Gate> = {}): Gate => ({
  state: "passed",
  currentCheck: "",
  checks: [],
  ...overrides,
});

describe("run progress mapping", () => {
  it("maps each phase of the part's wave from its executor child", () => {
    const data = toRunProgressData(
      snapshot([
        part({
          phases: [
            ...PHASES,
            { id: "4", name: "Stalled", wave: 2, tier: "standard" },
            { id: "5", name: "Broken", wave: 2, tier: "standard" },
            { id: "6", name: "Adopted", wave: 2, tier: "standard" },
          ],
          children: [
            child({ id: "2", phase: "2", state: "running" }),
            child({ id: "2:review", kind: "review-thread", phase: "3", state: "running" }),
            child({ id: "4", phase: "4", state: "running", stale: true }),
            child({ id: "5", phase: "5", state: "settled", disposition: "deadline" }),
            child({ id: "6", phase: "6", state: "settled", disposition: "adopted" }),
          ],
        }),
      ]),
      "ui",
      2,
      "/w",
    );
    expect(data?.phases).toEqual([
      { id: "2", name: "Parser", state: "running", attempt: null },
      { id: "3", name: "Watcher", state: "pending", attempt: null },
      { id: "4", name: "Stalled", state: "stale", attempt: null },
      { id: "5", name: "Broken", state: "failed", attempt: null },
      { id: "6", name: "Adopted", state: "done", attempt: null },
    ]);
    expect(data?.phasesTotal).toBe(5);
  });

  it("marks a settled executor done and shows its attempt only above 1, from the latest attempt", () => {
    const data = toRunProgressData(
      snapshot([
        part({
          children: [
            child({ id: "2", phase: "2", attempt: 2, state: "settled", disposition: "settled" }),
            child({ id: "3", phase: "3", attempt: 1, state: "settled", disposition: "settled" }),
          ],
        }),
      ]),
      "ui",
      2,
      "/w",
    );
    expect(data?.phases).toEqual([
      { id: "2", name: "Parser", state: "done", attempt: 2 },
      { id: "3", name: "Watcher", state: "done", attempt: null },
    ]);
  });

  it("sums the reported cost of every child, skipping null, and is null when none reported", () => {
    const withOneNull = part({
      children: [
        child({ id: "2", phase: "2", costUsd: 1.25 }),
        child({ id: "2:review", kind: "review-thread", phase: "2", costUsd: 0.5 }),
        child({ id: "3", phase: "3", costUsd: null }),
      ],
    });
    expect(toRunProgressData(snapshot([withOneNull]), "ui", 2, "/w")?.costUsd).toBe(1.75);

    const allNull = part({
      children: [child({ id: "2", phase: "2" }), child({ id: "3", phase: "3" })],
    });
    expect(toRunProgressData(snapshot([allNull]), "ui", 2, "/w")?.costUsd).toBeNull();
    expect(toRunProgressData(snapshot([part()]), "ui", 2, "/w")?.costUsd).toBeNull();
  });

  it.each([
    ["running", "running", null],
    ["passed", "passed", null],
    ["failed", "failed", null],
    ["unfinished", "aborted", null],
    ["unknown", "aborted", "dp reported no outcome"],
    ["something-new", "aborted", "dp reported no outcome"],
  ] as const)("maps run outcome %s to %s", (reported, outcome, reason) => {
    const data = toRunProgressData(snapshot([part()], run({ outcome: reported })), "ui", 2, "/w");
    expect(data).toMatchObject({ outcome, reason });
  });

  it("fills run fields from the part entry and the run it belongs to", () => {
    const data = toRunProgressData(
      snapshot(
        [part({ alive: false })],
        run({ outcome: "passed", endedAt: "2026-11-21T11:00:00Z" }),
      ),
      "ui",
      2,
      "/w",
    );
    expect(data).toMatchObject({
      runId: "r-1",
      dir: "/w",
      part: "ui",
      wave: 2,
      initiative: "home",
      spec: "/w/.claude/plans/x.md",
      startedAt: "2026-11-21T10:00:00Z",
      settledAt: "2026-11-21T11:00:00Z",
    });
  });

  it("reads a part from another run as running while alive, else as having no outcome", () => {
    const other = run({ id: "r-2", outcome: "passed", endedAt: "2026-11-21T12:00:00Z" });
    expect(
      toRunProgressData(snapshot([part({ alive: true })], other), "ui", 2, "/w"),
    ).toMatchObject({ outcome: "running", reason: null, settledAt: null });
    expect(
      toRunProgressData(snapshot([part({ alive: false })], other), "ui", 2, "/w"),
    ).toMatchObject({ outcome: "aborted", reason: "dp reported no outcome", settledAt: null });
    expect(
      toRunProgressData(snapshot([part({ alive: false })], null), "ui", 2, "/w"),
    ).toMatchObject({ outcome: "aborted", reason: "dp reported no outcome" });
  });

  it("finds only the entry with the same part and wave", () => {
    const entries = [part({ wave: 1, runId: "r-0" }), part({ part: "api" })];
    expect(toRunProgressData(snapshot(entries), "ui", 2, "/w")).toBeNull();
    expect(toRunProgressData(snapshot(entries), "ui", 1, "/w")?.runId).toBe("r-0");
  });
});

describe("verify mapping", () => {
  const checks = (overrides: Partial<Gate>) =>
    part({
      gate: gate({
        checks: [
          { name: "precheck", state: "PASS", reason: "typecheck passed" },
          { name: "unit", state: "FAIL", reason: "2 tests failed" },
          { name: "integration", state: "BLOCKED", reason: "lock held" },
          { name: "test-adversary", state: "NOT_RUN", reason: "deferred" },
        ],
        ...overrides,
      }),
    });

  it("maps check states and display names for a gate on HEAD", () => {
    expect(toVerifyChecks(checks({}), HEAD, HEAD, null)).toEqual([
      { name: "Precheck", summary: "typecheck passed", state: "pass" },
      { name: "Unit", summary: "2 tests failed", state: "fail" },
      { name: "Integration", summary: "lock held", state: "fail" },
      { name: "Test review", summary: "deferred", state: "pending" },
    ]);
  });

  it("shows a pass recorded on an older revision as stale and leaves a failure failing", () => {
    expect(toVerifyChecks(checks({}), HEAD, OLD, null).map((row) => row.state)).toEqual([
      "stale",
      "fail",
      "fail",
      "pending",
    ]);
  });

  it("keeps a pass when either revision is unknown", () => {
    expect(toVerifyChecks(checks({}), null, OLD, null)[0]?.state).toBe("pass");
    expect(toVerifyChecks(checks({}), HEAD, null, null)[0]?.state).toBe("pass");
  });

  it.each([
    ["evidence:design", "Design"],
    ["ownership", "Ownership"],
    ["contract", "Contract"],
    ["executor", "Executor"],
    ["commit-identity", "Commit identity"],
    ["review", "Review"],
    ["evidence:test-run", "evidence:test-run"],
  ])("names check %s as %s", (name, label) => {
    const entry = part({ gate: gate({ checks: [{ name, state: "PASS", reason: "" }] }) });
    expect(toVerifyChecks(entry, HEAD, HEAD, null)[0]?.name).toBe(label);
  });

  it("shows the running gate's current check as running and later unsettled checks as pending", () => {
    const entry = part({
      gate: gate({
        state: "running",
        currentCheck: "unit",
        checks: [
          { name: "precheck", state: "PASS", reason: "" },
          { name: "unit", state: "NOT_RUN", reason: "" },
          { name: "integration", state: "NOT_RUN", reason: "" },
        ],
      }),
    });
    expect(toVerifyChecks(entry, HEAD, HEAD, null).map((row) => row.state)).toEqual([
      "pass",
      "running",
      "pending",
    ]);
  });

  it("adds a running row for a current check the gate has not recorded yet", () => {
    const entry = part({ gate: gate({ state: "running", currentCheck: "precheck", checks: [] }) });
    expect(toVerifyChecks(entry, HEAD, HEAD, null)).toEqual([
      { name: "Precheck", summary: "", state: "running" },
    ]);
  });

  it("shows no running row once the gate is no longer running", () => {
    const entry = part({
      gate: gate({
        state: "failed",
        currentCheck: "unit",
        checks: [{ name: "unit", state: "FAIL", reason: "" }],
      }),
    });
    expect(toVerifyChecks(entry, HEAD, HEAD, null)[0]?.state).toBe("fail");
  });

  it("draws no gate rows without a gate", () => {
    expect(toVerifyChecks(part({ gate: null }), HEAD, HEAD, null)).toEqual([]);
  });

  it.each([
    [["satisfied", "satisfied", "satisfied"], "pass", "3 of 3 satisfied"],
    [["satisfied", "failed", "stale"], "fail", "1 of 3 satisfied"],
    [["satisfied", "stale", "no-evidence"], "stale", "1 of 3 satisfied"],
    [["satisfied", "no-evidence"], "pending", "1 of 2 satisfied"],
    [["blocked", "needs-match"], "pending", "0 of 2 satisfied"],
  ] as const)("scores acceptance criteria %j as %s", (dispositions, state, summary) => {
    const evidence = {
      assessments: dispositions.map((disposition, index) => ({
        criterion: `criterion ${index}`,
        disposition,
      })),
    };
    expect(toVerifyChecks(part({ gate: null }), HEAD, HEAD, evidence)).toEqual([
      { name: "Acceptance criteria", summary, state },
    ]);
  });

  it("puts the acceptance criteria row after the gate rows and omits it with no criteria", () => {
    const evidence = { assessments: [{ criterion: "c", disposition: "satisfied" }] };
    expect(toVerifyChecks(checks({}), HEAD, HEAD, evidence).map((row) => row.name)).toEqual([
      "Precheck",
      "Unit",
      "Integration",
      "Test review",
      "Acceptance criteria",
    ]);
    expect(toVerifyChecks(part({ gate: null }), HEAD, HEAD, { assessments: [] })).toEqual([]);
  });
});

const output = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

type Reply = ProcessRunner.ProcessRunOutput | "missing";
interface Replies {
  readonly live: Reply;
  readonly evidence: Reply;
  readonly head: Reply;
}

const command = (text: string, out: string | null = null, cwd = "/repo") => ({
  threadId: THREAD,
  turnItemId: TurnItemId.make("item-1"),
  command: text,
  output: out,
  exitCode: 0,
  cwd,
  completedAt: null,
});

const setup = Effect.fnUntraced(function* () {
  const realFs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* realFs.makeTempDirectoryScoped({ prefix: "t3-wave-source-" });
  const work = path.join(root, ".claude", "work");
  yield* realFs.makeDirectory(work, { recursive: true });

  const events = yield* Queue.unbounded<FileSystem.WatchEvent>();
  const processed = yield* Queue.unbounded<void>();
  const watched: Array<string> = [];
  const fs = {
    ...realFs,
    watch: (target: string, options?: FileSystem.WatchOptions) => {
      watched.push(target);
      options?.onReady?.();
      return Stream.fromQueue(events).pipe(Stream.tap(() => Queue.offer(processed, undefined)));
    },
  } satisfies FileSystem.FileSystem;

  let replies: Replies = { live: "missing", evidence: "missing", head: output(`${HEAD}\n`) };
  const calls: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
  const run: ProcessRunner.ProcessRunner["Service"]["run"] = (input) => {
    calls.push({ command: input.command, args: input.args });
    const reply =
      input.command === "git"
        ? replies.head
        : input.args[0] === "verify"
          ? replies.evidence
          : replies.live;
    return reply === "missing"
      ? Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: input.command,
            argumentCount: input.args.length,
            cause: new Error("ENOENT"),
          }),
        )
      : Effect.succeed(reply);
  };
  const services = Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem, fs),
    Layer.succeed(Path.Path, path),
    Layer.succeed(ProcessRunner.ProcessRunner, { run }),
    Layer.mock(PluginThreadIndex)({}),
  );
  const source = yield* dispatchWaveSource.pipe(Effect.provide(services));
  return {
    source,
    services,
    root,
    work,
    calls,
    watched,
    events,
    processed,
    reply: (next: Partial<Replies>) => {
      replies = { ...replies, ...next };
    },
    resolve: (kind: "dispatch.runProgress" | "dispatch.verify", key: string) =>
      source.resolve({ kind, key }, THREAD).pipe(Effect.provide(services)),
  };
});

const liveJson = (parts: ReadonlyArray<DispatchLivePart>, current: Run | null = run()) =>
  output(
    JSON.stringify({
      schema: "mc/1",
      generatedAt: "2026-11-21T10:05:00Z",
      dir: "/w",
      staleAfterMs: 6000,
      history: [],
      run: current === null ? null : { ...current, waves: 2 },
      parts: parts.map((entry) => ({
        ...entry,
        children: entry.children.map((c) => ({ ...c, model: "m", tokensIn: 1 })),
      })),
    }),
  );

it.layer(NodeServices.layer)("dispatch wave source", (it) => {
  it.effect("recognises wave legs as run progress or verify refs keyed by dir, part and wave", () =>
    Effect.gen(function* () {
      const { source } = yield* setup();
      const refs = (text: string, out: string | null = null, cwd = "/repo") =>
        source.recognize(command(text, out, cwd)).map((ref) => `${ref.kind} ${ref.key}`);

      expect(refs("dp wave run 2 --spec .claude/plans/x.md --part ui --dir /w")).toEqual([
        "dispatch.runProgress /w#ui#2",
      ]);
      expect(refs("dp wave wait 2 --part ui --leg gate")).toEqual(["dispatch.verify /repo#ui"]);
      expect(refs("dp wave wait 2 --part ui --leg run")).toEqual([
        "dispatch.runProgress /repo#ui#2",
      ]);
      expect(refs("dp wave wait 3 --part ui")).toEqual(["dispatch.runProgress /repo#ui#3"]);
      expect(refs("dp wave status 2")).toEqual(["dispatch.runProgress /repo#wave-2#2"]);
      expect(refs("dp wave gate 2 --part=ui --dir sub")).toEqual(["dispatch.verify /repo/sub#ui"]);
      expect(refs("dp wave settle 2 --phase 3 --part ui")).toEqual(["dispatch.verify /repo#ui"]);
      expect(refs("cd /w && dp wave run --part ui 4", null, "/elsewhere")).toEqual([
        "dispatch.runProgress /w#ui#4",
      ]);
    }),
  );

  it.effect("recognises the launch line, taking part and dir from the same segment", () =>
    Effect.gen(function* () {
      const { source } = yield* setup();
      const refs = (text: string, out: string) =>
        source.recognize(command(text, out)).map((ref) => `${ref.kind} ${ref.key}`);

      expect(
        refs(
          "dp wave settle 2 --phase 3 --part ui --dir /w",
          "dp: wave 2 gate launched (pid 41)\n",
        ),
      ).toEqual(["dispatch.verify /w#ui"]);
      expect(
        refs(
          "dp wave run 2 --part ui --dir /w --json",
          "starting\ndp: wave 2 run launched (pid 7)\n",
        ),
      ).toEqual(["dispatch.runProgress /w#ui#2"]);
      expect(refs("./launch.sh", "dp: wave 5 run launched (pid 9)")).toEqual([
        "dispatch.runProgress /repo#wave-5#5",
      ]);
      expect(refs("cat log", "note: dp: wave 5 run launched (pid 9)")).toEqual([]);
    }),
  );

  it.effect("recognises dp verify only when the command names the part", () =>
    Effect.gen(function* () {
      const { source } = yield* setup();
      const refs = (text: string) =>
        source.recognize(command(text)).map((ref) => `${ref.kind} ${ref.key}`);

      expect(refs("dp verify evidence .claude/plans/x.md --part ui")).toEqual([
        "dispatch.verify /repo#ui",
      ]);
      expect(refs("dp verify ears x.md --part ui --dir /w")).toEqual(["dispatch.verify /w#ui"]);
      expect(refs("dp verify evidence .claude/plans/x.md")).toEqual([]);
      expect(refs("dp verify log run --part ui")).toEqual([]);
    }),
  );

  it.effect("recognises nothing for other dp verbs or unresolvable arguments", () =>
    Effect.gen(function* () {
      const { source } = yield* setup();
      for (const text of [
        "dp wave abort 2 --part ui",
        "dp wave live --json",
        "dp wave status",
        "dp wave run",
        "dp wave run 0",
        "dp wave run $N",
        "dp wave run 2 --dir $HOME/w",
        "dp wave wait 2 --leg other",
        "echo dp wave run 2",
        "dp spec lint x.md",
      ]) {
        expect(source.recognize(command(text)), text).toEqual([]);
      }
    }),
  );

  it.effect("resolves a run progress card from dp wave live in the checkout", () =>
    Effect.gen(function* () {
      const { resolve, reply, calls, watched, work, root } = yield* setup();
      reply({
        live: liveJson([
          part({
            dir: root,
            children: [
              child({ id: "2", phase: "2", attempt: 2, costUsd: 0.75 }),
              child({ id: "3", phase: "3", state: "settled", disposition: "settled", costUsd: 1 }),
            ],
          }),
        ]),
      });
      const card = yield* resolve("dispatch.runProgress", `${root}#ui#2`);
      expect(card).toMatchObject({
        kind: "dispatch.runProgress",
        actions: [],
        data: {
          runId: "r-1",
          dir: root,
          part: "ui",
          wave: 2,
          outcome: "running",
          phases: [
            { id: "2", state: "running", attempt: 2 },
            { id: "3", state: "done", attempt: null },
          ],
          phasesTotal: 2,
          costUsd: 1.75,
        },
      });
      expect(calls).toEqual([{ command: "dp", args: ["wave", "live", "--dir", root, "--json"] }]);
      expect(watched).toEqual([work]);
      expect(yield* resolve("dispatch.runProgress", `${root}#ui#3`)).toBeNull();
    }),
  );

  it.effect(
    "resolves a verify card with gate rows, acceptance criteria and the gate revision",
    () =>
      Effect.gen(function* () {
        const { resolve, reply, root, work, calls } = yield* setup();
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${work}/gate-attempts.jsonl`,
          [
            JSON.stringify({ part: "ui", wave: 2, revision: OLD, verdict: "passed" }),
            JSON.stringify({ part: "ui", wave: 2, revision: HEAD, verdict: "passed" }),
            "{ not json",
            JSON.stringify({ part: "api", wave: 2, revision: "c".repeat(40) }),
            JSON.stringify({ part: "ui", wave: 1, revision: "d".repeat(40) }),
            "",
          ].join("\n"),
        );
        reply({
          live: liveJson([
            part({ wave: 1, spec: `${root}/.claude/plans/old.md`, gate: gate() }),
            part({
              spec: ".claude/plans/widgets.md",
              gate: gate({ checks: [{ name: "precheck", state: "PASS", reason: "ok" }] }),
            }),
          ]),
          evidence: output(
            JSON.stringify({
              headCommit: HEAD,
              assessments: [
                { criterion: "a", disposition: "satisfied", matches: [] },
                { criterion: "b", disposition: "no-evidence", matches: [] },
              ],
            }),
          ),
        });
        const card = yield* resolve("dispatch.verify", `${root}#ui`);
        expect(card).toEqual({
          kind: "dispatch.verify",
          updatedAt: "1970-01-01T00:00:00.000Z",
          actions: [
            {
              id: "rerun",
              label: "Re-run",
              type: "message",
              message: "Re-run verification for widgets.",
            },
          ],
          data: {
            task: "widgets",
            specPath: `${root}/.claude/plans/widgets.md`,
            dir: root,
            revision: HEAD,
            checks: [
              { name: "Precheck", summary: "ok", state: "pass" },
              { name: "Acceptance criteria", summary: "1 of 2 satisfied", state: "pending" },
            ],
          },
        });
        expect(calls).toContainEqual({
          command: "dp",
          args: ["verify", "evidence", `${root}/.claude/plans/widgets.md`],
        });
        expect(calls).toContainEqual({ command: "git", args: ["rev-parse", "HEAD"] });
      }),
  );

  it.effect("shows a pass from an older gate revision as stale against the checkout's HEAD", () =>
    Effect.gen(function* () {
      const { resolve, reply, root, work } = yield* setup();
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        `${work}/gate-attempts.jsonl`,
        `${JSON.stringify({ part: "ui", wave: 2, revision: OLD })}\n`,
      );
      reply({
        live: liveJson([
          part({ gate: gate({ checks: [{ name: "unit", state: "PASS", reason: "" }] }) }),
        ]),
      });
      const card = yield* resolve("dispatch.verify", `${root}#ui`);
      expect(card?.data).toMatchObject({
        revision: OLD,
        checks: [{ name: "Unit", summary: "", state: "stale" }],
      });
    }),
  );

  it.effect(
    "omits the acceptance row and the revision when dp and the attempt log yield nothing",
    () =>
      Effect.gen(function* () {
        const { resolve, reply, root } = yield* setup();
        reply({
          live: liveJson([part({ spec: "/w/.claude/plans/x.md", gate: null })]),
          evidence: output("boom", 1),
          head: "missing",
        });
        expect((yield* resolve("dispatch.verify", `${root}#ui`))?.data).toMatchObject({
          task: "x",
          revision: null,
          checks: [],
        });
      }),
  );

  it.effect.each([
    ["dp is missing", "missing"],
    ["dp fails", output("", 1)],
    ["the record is not JSON", output("not json")],
    ["the record has another schema", output(JSON.stringify({ schema: "mc/2", parts: [] }))],
    ["no part matches", output(JSON.stringify({ schema: "mc/1", run: null, parts: [] }))],
  ] as const)("draws no card when %s", ([, live]) =>
    Effect.gen(function* () {
      const { resolve, reply, root } = yield* setup();
      reply({ live });
      expect(yield* resolve("dispatch.runProgress", `${root}#ui#2`)).toBeNull();
      expect(yield* resolve("dispatch.verify", `${root}#ui`)).toBeNull();
    }),
  );

  it.effect("resolves no card for another kind or a malformed key", () =>
    Effect.gen(function* () {
      const { source, services, resolve, reply, root } = yield* setup();
      reply({ live: liveJson([part()]) });
      expect(
        yield* source
          .resolve({ kind: "dispatch.plan", key: `${root}#ui` }, THREAD)
          .pipe(Effect.provide(services)),
      ).toBeNull();
      expect(yield* resolve("dispatch.runProgress", `${root}#ui`)).toBeNull();
      expect(yield* resolve("dispatch.runProgress", `${root}#ui#x`)).toBeNull();
      expect(yield* resolve("dispatch.verify", `${root}#`)).toBeNull();
    }),
  );

  it.effect("keeps updatedAt while a card is unchanged and moves it when the run changes", () =>
    Effect.gen(function* () {
      const { resolve, reply, root } = yield* setup();
      reply({ live: liveJson([part({ children: [child({ id: "2", phase: "2" })] })]) });
      const first = yield* resolve("dispatch.runProgress", `${root}#ui#2`);
      yield* TestClock.adjust("5 seconds");
      expect((yield* resolve("dispatch.runProgress", `${root}#ui#2`))?.updatedAt).toBe(
        first?.updatedAt,
      );

      reply({
        live: liveJson([
          part({ children: [child({ id: "2", phase: "2", disposition: "settled" })] }),
        ]),
      });
      expect((yield* resolve("dispatch.runProgress", `${root}#ui#2`))?.updatedAt).toBe(
        "1970-01-01T00:00:05.000Z",
      );
    }),
  );

  it.effect("signals a change one second after a run record changes, ignoring telemetry", () =>
    Effect.gen(function* () {
      const { source, services, resolve, reply, events, processed, root } = yield* setup();
      reply({ live: liveJson([part()]) });
      const seen = yield* Queue.unbounded<void>();
      yield* Stream.runForEach(source.changes!, () => Queue.offer(seen, undefined)).pipe(
        Effect.provide(services),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* resolve("dispatch.runProgress", `${root}#ui#2`);

      for (const name of [
        "events.jsonl",
        "telemetry",
        "wave-run-2.json.alive",
        "provisioned.json",
      ]) {
        yield* Queue.offer(events, { _tag: "Update", path: `${root}/.claude/work/${name}` });
        yield* Queue.take(processed);
      }
      yield* TestClock.adjust("2 seconds");
      expect(yield* Queue.size(seen)).toBe(0);

      for (const name of [
        "wave-run-2.json",
        "wave-run-2.json.gate",
        "gate-attempts.jsonl",
        "VERIFIED.jsonl",
      ]) {
        yield* Queue.offer(events, { _tag: "Update", path: `${root}/.claude/work/${name}` });
        yield* Queue.take(processed);
        yield* TestClock.adjust("999 millis");
        expect(yield* Queue.size(seen), name).toBe(0);
        yield* TestClock.adjust("1 millis");
        yield* Queue.take(seen);
      }
    }),
  );
});
