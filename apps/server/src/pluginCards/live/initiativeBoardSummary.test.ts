import { describe, expect, it } from "@effect/vitest";

import type { DispatchDecisionRecord } from "../dispatch/decisionRecord.ts";
import type { DispatchInitiativeState } from "../dispatch/initiativeState.ts";
import type { DispatchLiveInitiative } from "../dispatch/liveRegistry.ts";
import type { DispatchLivePart } from "../sources/dispatchWaveSnapshot.ts";
import {
  buildInitiativeBoard,
  type InitiativeBoardInputs,
  type PartRecords,
} from "./initiativeBoardSummary.ts";

type StatePart = DispatchInitiativeState["parts"][number];
type StateWave = DispatchInitiativeState["waves"][number];
type Progress = DispatchInitiativeState["progress"][number];
type Child = DispatchLivePart["children"][number];
type Gate = NonNullable<DispatchLivePart["gate"]>;

const ledgerPart = (id: string, wave: number, status: string, title = id): StatePart => ({
  id,
  title,
  repo: "acme/app",
  zone: [],
  wave,
  status,
});

const ledgerWave = (number: number, opened: boolean, closed: boolean): StateWave => ({
  number,
  opened,
  closed,
  parts: [],
});

const state = (overrides: Partial<DispatchInitiativeState> = {}): DispatchInitiativeState => ({
  initiative: { slug: "alpha", title: "Alpha rollout", repos: ["acme/app"] },
  parts: [],
  waves: [],
  progress: [],
  deliveries: [],
  closed: false,
  ...overrides,
});

const executor = (overrides: Partial<Child>): Child => ({
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

const gate = (overrides: Partial<Gate> = {}): Gate => ({
  state: "passed",
  currentCheck: "",
  checks: [],
  ...overrides,
});

const live = (overrides: Partial<DispatchLivePart> = {}): DispatchLivePart => ({
  runId: "r-1",
  runStartedAt: "2026-11-21T10:00:00Z",
  alive: false,
  part: "part-a",
  wave: 1,
  dir: "/w/part-a",
  initiative: "alpha",
  spec: "/w/part-a/.claude/plans/part-a.md",
  complete: true,
  children: [],
  gate: null,
  phases: [],
  ...overrides,
});

const records = (overrides: Partial<PartRecords> = {}): PartRecords => ({
  branch: null,
  waveLive: [],
  specPhases: null,
  ...overrides,
});

const registry = (overrides: Partial<DispatchLiveInitiative> = {}): DispatchLiveInitiative => ({
  slug: "alpha",
  closed: false,
  totalWave: 1,
  totalRunning: 0,
  totalSettled: 0,
  totalCostUsd: 0,
  reportedCostUsd: 0,
  started: "2026-11-20T08:00:00Z",
  touched: "2026-11-22T08:00:00Z",
  liveUntil: "2026-11-22T09:00:00Z",
  ...overrides,
});

const decision = (overrides: Partial<DispatchDecisionRecord> = {}): DispatchDecisionRecord => ({
  schema: "decision/1",
  id: "d-1",
  kind: "next-part",
  part: "part-a",
  wave: 1,
  phase: "",
  question: "Continue to the next part?",
  options: [
    { key: "pause", label: "Pause", command: "dp decision answer d-1 pause" },
    { key: "continue", label: "Continue", command: "dp decision answer d-1 continue" },
  ],
  default: "",
  defaultReason: "",
  raisedAt: "2026-11-22T10:00:00Z",
  applyAfter: "0001-01-01T00:00:00Z",
  state: "open",
  choice: "",
  chosenBy: "",
  resolvedAt: "",
  dir: "/w/part-a",
  ...overrides,
});

const inputs = (overrides: Partial<InitiativeBoardInputs> = {}): InitiativeBoardInputs => ({
  slug: "alpha",
  state: state(),
  registry: null,
  ceilingUsd: null,
  records: new Map(),
  openDecisions: [],
  ...overrides,
});

const onlyPart = (board: ReturnType<typeof buildInitiativeBoard>) => {
  const part = board.waves.flatMap((wave) => wave.parts)[0];
  if (part === undefined) throw new Error("board has no part");
  return part;
};

describe("waves", () => {
  it("numbers dp's 0-based waves from 1 and names each from its parts' lead phrases", () => {
    const board = buildInitiativeBoard(
      inputs({
        state: state({
          parts: [
            ledgerPart("part-a", 0, "gate-pass", "Board contract: schema and RPC"),
            ledgerPart("part-b", 0, "merged", "Ledger decoder — progress fields"),
            ledgerPart("part-c", 1, "planned", "Phase bars (segmented)"),
            ledgerPart("part-d", 1, "briefed", "Gate sheet; checks and summaries"),
            ledgerPart("part-e", 1, "specced", "Cost column"),
            ledgerPart("part-f", 2, "planned", "Docs"),
          ],
          waves: [
            ledgerWave(0, true, true),
            ledgerWave(1, true, false),
            ledgerWave(2, false, false),
          ],
        }),
      }),
    );

    expect(
      board.waves.map(({ number, name, moreParts, state, partsSettled, partsTotal }) => ({
        number,
        name,
        moreParts,
        state,
        partsSettled,
        partsTotal,
      })),
    ).toEqual([
      {
        number: 1,
        name: "Board contract + Ledger decoder",
        moreParts: 0,
        state: "done",
        partsSettled: 2,
        partsTotal: 2,
      },
      {
        number: 2,
        name: "Phase bars + Gate sheet",
        moreParts: 1,
        state: "active",
        partsSettled: 0,
        partsTotal: 3,
      },
      { number: 3, name: "Docs", moreParts: 0, state: "waiting", partsSettled: 0, partsTotal: 1 },
    ]);
    expect(
      board.waves.map((wave) => wave.parts.map(({ id, wave, status }) => ({ id, wave, status }))),
    ).toEqual([
      [
        { id: "part-a", wave: 1, status: "gate-pass" },
        { id: "part-b", wave: 1, status: "merged" },
      ],
      [
        { id: "part-c", wave: 2, status: "queued" },
        { id: "part-d", wave: 2, status: "queued" },
        { id: "part-e", wave: 2, status: "queued" },
      ],
      [{ id: "part-f", wave: 3, status: "planned" }],
    ]);
    expect(board.currentWave).toBe(2);
    expect(board.parts).toEqual({ settled: 2, total: 6 });
    expect(board.headline).toEqual({ kind: "waiting", nextPart: "part-c" });
  });

  it("leaves parts planned when the current wave has not been opened", () => {
    const board = buildInitiativeBoard(
      inputs({
        state: state({
          parts: [ledgerPart("part-a", 1, "merged"), ledgerPart("part-b", 2, "specced")],
          waves: [ledgerWave(1, true, true), ledgerWave(2, false, false)],
        }),
      }),
    );

    expect(board.currentWave).toBe(2);
    expect(board.waves.map((wave) => wave.state)).toEqual(["done", "active"]);
    expect(board.waves[1]?.parts[0]?.status).toBe("specced");
    expect(board.headline).toEqual({ kind: "waiting", nextPart: "part-b" });
  });

  it("reports no waves as current wave 0 with no wave rows", () => {
    const board = buildInitiativeBoard(inputs());

    expect(board.currentWave).toBe(0);
    expect(board.waves).toEqual([]);
    expect(board.parts).toEqual({ settled: 0, total: 0 });
  });
});

describe("part status", () => {
  const statusOf = (dpStatus: string, entry: DispatchLivePart | null) =>
    onlyPart(
      buildInitiativeBoard(
        inputs({
          state: state({
            parts: [ledgerPart("part-a", 1, dpStatus)],
            waves: [ledgerWave(1, false, false)],
          }),
          records: new Map([["part-a", records({ waveLive: entry === null ? [] : [entry] })]]),
        }),
      ),
    ).status;

  it("is running while the latest wave run is alive and incomplete", () => {
    expect(statusOf("gate-fail", live({ alive: true, complete: false }))).toBe("running");
  });

  it("is gating while that run's gate is running", () => {
    expect(
      statusOf("specced", live({ alive: true, complete: false, gate: gate({ state: "running" }) })),
    ).toBe("gating");
  });

  it("keeps dp's status when the run is complete or dead", () => {
    expect(statusOf("gate-pass", live({ alive: true, complete: true }))).toBe("gate-pass");
    expect(statusOf("gate-fail", live({ alive: false, complete: false }))).toBe("gate-fail");
  });

  it("never overrides merged", () => {
    expect(statusOf("merged", live({ alive: true, complete: false }))).toBe("merged");
  });

  it("reads an unknown dp status as planned", () => {
    expect(statusOf("paused", null)).toBe("planned");
  });

  it("follows the highest plan wave's run, not an earlier one", () => {
    expect(statusOf("specced", live({ wave: 1, alive: true, complete: false }))).toBe("running");
    const board = buildInitiativeBoard(
      inputs({
        state: state({ parts: [ledgerPart("part-a", 1, "specced")] }),
        records: new Map([
          [
            "part-a",
            records({
              waveLive: [
                live({ wave: 2, alive: false, complete: true }),
                live({ wave: 1, alive: true, complete: false }),
              ],
            }),
          ],
        ]),
      }),
    );
    expect(onlyPart(board).status).toBe("specced");
  });
});

describe("phases", () => {
  it("lists every spec phase in id order, each from its own plan wave's record", () => {
    const phases: DispatchLivePart["phases"] = [
      { id: "10", name: "Docs", wave: 2, tier: "standard" },
      { id: "2", name: "Parser", wave: 2, tier: "standard" },
      { id: "1", name: "Schema", wave: 1, tier: "standard" },
      { id: "3", name: "Watcher", wave: 2, tier: "complex" },
      { id: "4", name: "Wiring", wave: 2, tier: "standard" },
    ];
    const board = buildInitiativeBoard(
      inputs({
        state: state({
          parts: [ledgerPart("part-a", 1, "specced"), ledgerPart("part-b", 1, "planned")],
          waves: [ledgerWave(1, true, false)],
        }),
        records: new Map([
          [
            "part-a",
            records({
              branch: "part-a",
              waveLive: [
                live({
                  wave: 1,
                  phases,
                  children: [executor({ phase: "1", disposition: "settled", state: "settled" })],
                }),
                live({
                  wave: 2,
                  alive: true,
                  complete: false,
                  phases,
                  children: [
                    executor({ id: "2", phase: "2", attempt: 1, disposition: "deadline" }),
                    executor({ id: "2b", phase: "2", attempt: 2 }),
                    executor({ id: "3", phase: "3", disposition: "deadline" }),
                    executor({ id: "10", phase: "10", stale: true }),
                    executor({ id: "r", kind: "review-thread", phase: "4" }),
                  ],
                }),
              ],
            }),
          ],
        ]),
      }),
    );
    const part = board.waves[0]?.parts[0];

    expect(part?.branch).toBe("part-a");
    expect(part?.phases).toEqual([
      { id: "1", name: "Schema", state: "done", attempt: null },
      { id: "2", name: "Parser", state: "running", attempt: 2 },
      { id: "3", name: "Watcher", state: "failed", attempt: null },
      { id: "4", name: "Wiring", state: "pending", attempt: null },
      { id: "10", name: "Docs", state: "stale", attempt: null },
    ]);
    expect(board.headline).toEqual({
      kind: "running",
      part: "part-a",
      phase: { index: 2, total: 5 },
      nextPart: "part-b",
    });
  });

  it("falls back to the spec's phases, pending, when the part has no wave record yet", () => {
    const part = onlyPart(
      buildInitiativeBoard(
        inputs({
          state: state({ parts: [ledgerPart("part-a", 1, "specced")] }),
          records: new Map([
            [
              "part-a",
              records({
                branch: "part-a",
                specPhases: [
                  { id: "2", name: "Parser", wave: 1 },
                  { id: "1", name: "Schema", wave: 1 },
                ],
              }),
            ],
          ]),
        }),
      ),
    );

    expect(part.phases).toEqual([
      { id: "1", name: "Schema", state: "pending", attempt: null },
      { id: "2", name: "Parser", state: "pending", attempt: null },
    ]);
  });
});

describe("a part with no worktree", () => {
  it("has no phases or branch, and keeps its ledger status, gate, MR and last event", () => {
    const part = onlyPart(
      buildInitiativeBoard(
        inputs({
          state: state({
            parts: [ledgerPart("part-a", 1, "gate-fail")],
            progress: [
              {
                part: "part-a",
                lastEventAt: "2026-11-21T12:00:00Z",
                gate: { passed: false, at: "2026-11-21T11:30:00Z", record: "/gone/gate.json" },
              },
            ],
            deliveries: [{ part: "part-a", mr: "!241" }],
          }),
        }),
      ),
    );

    expect(part).toEqual({
      id: "part-a",
      title: "part-a",
      wave: 1,
      status: "gate-fail",
      phases: [],
      gate: { state: "failed", at: "2026-11-21T11:30:00Z", checks: [] },
      branch: null,
      mergeRequest: { ref: "!241", url: null, number: 241 },
      cost: { usd: null, state: "unknown" },
      startedAt: null,
      lastEventAt: "2026-11-21T12:00:00Z",
    });
  });

  it("has no gate and no MR when the ledger records neither", () => {
    const part = onlyPart(
      buildInitiativeBoard(
        inputs({ state: state({ parts: [ledgerPart("part-a", 1, "planned")] }) }),
      ),
    );

    expect(part.gate).toBeNull();
    expect(part.mergeRequest).toBeNull();
    expect(part.lastEventAt).toBeNull();
  });
});

describe("a part whose wave record is missing", () => {
  const ledgerGate = (passed: boolean): Progress => ({
    part: "part-a",
    lastEventAt: null,
    gate: { passed, at: "2026-11-20T09:30:00Z", record: "/w/part-a/gate.json" },
  });
  const specPhases = [
    { id: "1", name: "Schema", wave: 1 },
    { id: "2", name: "Parser", wave: 1 },
  ];

  it("takes the gate from the ledger and marks phases done once settled", () => {
    const part = onlyPart(
      buildInitiativeBoard(
        inputs({
          state: state({
            parts: [ledgerPart("part-a", 1, "gate-pass")],
            progress: [ledgerGate(true)],
          }),
          records: new Map([["part-a", records({ branch: "part-a", specPhases })]]),
        }),
      ),
    );

    expect(part.gate).toEqual({ state: "passed", at: "2026-11-20T09:30:00Z", checks: [] });
    expect(part.phases.map((phase) => phase.state)).toEqual(["done", "done"]);
  });

  it("leaves phases pending while the part is not settled", () => {
    const part = onlyPart(
      buildInitiativeBoard(
        inputs({
          state: state({
            parts: [ledgerPart("part-a", 1, "gate-fail")],
            progress: [ledgerGate(false)],
          }),
          records: new Map([["part-a", records({ specPhases })]]),
        }),
      ),
    );

    expect(part.gate).toEqual({ state: "failed", at: "2026-11-20T09:30:00Z", checks: [] });
    expect(part.phases.map((phase) => phase.state)).toEqual(["pending", "pending"]);
  });

  it("uses the latest ledger gate row for the part", () => {
    const part = onlyPart(
      buildInitiativeBoard(
        inputs({
          state: state({
            parts: [ledgerPart("part-a", 1, "gate-pass")],
            progress: [
              ledgerGate(false),
              {
                ...ledgerGate(true),
                gate: { passed: true, at: "2026-11-21T09:30:00Z", record: null },
              },
            ],
          }),
        }),
      ),
    );

    expect(part.gate).toEqual({ state: "passed", at: "2026-11-21T09:30:00Z", checks: [] });
  });
});

describe("gate", () => {
  const partWith = (
    entries: ReadonlyArray<DispatchLivePart>,
    status = "specced",
    progress: ReadonlyArray<Progress> = [],
  ) =>
    buildInitiativeBoard(
      inputs({
        state: state({
          parts: [ledgerPart("part-a", 1, status)],
          waves: [ledgerWave(1, true, false)],
          progress,
        }),
        records: new Map([["part-a", records({ waveLive: entries })]]),
      }),
    );

  it("reports a running gate from its start time, with the current check running", () => {
    const board = partWith(
      [
        live({ wave: 1, gate: gate({ state: "failed", checks: [] }) }),
        live({
          wave: 2,
          alive: true,
          complete: false,
          gate: gate({
            state: "running",
            currentCheck: "unit",
            startedAt: "2026-11-22T08:00:00Z",
            checks: [{ name: "precheck", state: "PASS", reason: "typecheck passed" }],
          }),
        }),
      ],
      "specced",
      [
        {
          part: "part-a",
          lastEventAt: null,
          gate: { passed: false, at: "2026-11-20T00:00:00Z", record: null },
        },
      ],
    );

    expect(onlyPart(board).gate).toEqual({
      state: "running",
      at: "2026-11-22T08:00:00Z",
      checks: [
        { id: "precheck", state: "pass", summary: "typecheck passed" },
        { id: "unit", state: "running", summary: "" },
      ],
    });
    expect(board.headline).toEqual({ kind: "gating", part: "part-a" });
  });

  it("marks the current check running when the gate already lists it", () => {
    const board = partWith([
      live({
        alive: true,
        complete: false,
        gate: gate({
          state: "running",
          currentCheck: "unit",
          checks: [{ name: "unit", state: "", reason: "" }],
        }),
      }),
    ]);

    expect(onlyPart(board).gate).toEqual({
      state: "running",
      at: null,
      checks: [{ id: "unit", state: "running", summary: "" }],
    });
  });

  it("reports a failed gate with each check, its ledger time and a capped summary", () => {
    const board = partWith(
      [
        live({
          gate: gate({
            state: "failed",
            checks: [
              { name: "unit", state: "FAIL", reason: "x".repeat(300) },
              { name: "integration", state: "BLOCKED", reason: "lock held" },
              { name: "review", state: "PASS", reason: "ok" },
              { name: "test-adversary", state: "NOT_RUN", reason: "deferred" },
            ],
          }),
        }),
      ],
      "gate-fail",
      [
        {
          part: "part-a",
          lastEventAt: null,
          gate: { passed: false, at: "2026-11-22T09:00:00Z", record: null },
        },
      ],
    );
    const result = onlyPart(board).gate;

    expect(result?.state).toBe("failed");
    expect(result?.at).toBe("2026-11-22T09:00:00Z");
    expect(result?.checks.map(({ id, state }) => ({ id, state }))).toEqual([
      { id: "unit", state: "fail" },
      { id: "integration", state: "fail" },
      { id: "review", state: "pass" },
      { id: "test-adversary", state: "pending" },
    ]);
    expect(result?.checks[0]?.summary).toHaveLength(240);
    expect(result?.checks[0]?.summary.endsWith("…")).toBe(true);
    expect(result?.checks[1]?.summary).toBe("lock held");
    expect(board.headline).toEqual({ kind: "failing", part: "part-a", failedChecks: 2 });
  });

  it("reads a gate as failed when any check failed, whatever dp's gate state says", () => {
    const board = partWith([
      live({
        gate: gate({
          state: "passed",
          checks: [{ name: "unit", state: "FAIL", reason: "1 test failed" }],
        }),
      }),
    ]);

    expect(onlyPart(board).gate?.state).toBe("failed");
  });

  it("reads a gate with only passing checks as passed", () => {
    const board = partWith([
      live({ gate: gate({ state: "", checks: [{ name: "unit", state: "PASS", reason: "" }] }) }),
    ]);

    expect(onlyPart(board).gate?.state).toBe("passed");
  });

  it("skips a record whose gate is empty and uses the ledger instead", () => {
    const board = partWith([live({ gate: gate({ state: "", checks: [] }) })], "gate-pass", [
      {
        part: "part-a",
        lastEventAt: null,
        gate: { passed: true, at: "2026-11-22T09:00:00Z", record: null },
      },
    ]);

    expect(onlyPart(board).gate).toEqual({
      state: "passed",
      at: "2026-11-22T09:00:00Z",
      checks: [],
    });
  });
});

describe("merge request", () => {
  const mergeRequestOf = (deliveries: DispatchInitiativeState["deliveries"]) =>
    onlyPart(
      buildInitiativeBoard(
        inputs({ state: state({ parts: [ledgerPart("part-a", 1, "mr-open")], deliveries }) }),
      ),
    ).mergeRequest;
  const one = (mr: string) => mergeRequestOf([{ part: "part-a", mr }]);

  it.each([
    ["!241", { ref: "!241", url: null, number: 241 }],
    ["  #12 ", { ref: "#12", url: null, number: 12 }],
    [
      "https://github.com/acme/app/pull/57",
      {
        ref: "https://github.com/acme/app/pull/57",
        url: "https://github.com/acme/app/pull/57",
        number: 57,
      },
    ],
    [
      "https://gitlab.example.com/acme/app/-/merge_requests/88",
      {
        ref: "https://gitlab.example.com/acme/app/-/merge_requests/88",
        url: "https://gitlab.example.com/acme/app/-/merge_requests/88",
        number: 88,
      },
    ],
    ["awaiting review", { ref: "awaiting review", url: null, number: null }],
    ["!12 superseded, reopening", { ref: "!12 superseded, reopening", url: null, number: null }],
    [
      "see https://github.com/acme/app/pull/57",
      { ref: "see https://github.com/acme/app/pull/57", url: null, number: 57 },
    ],
    ["ftp://example.com/pull/3", { ref: "ftp://example.com/pull/3", url: null, number: 3 }],
  ])("reads %j", (mr, expected) => {
    expect(one(mr)).toEqual(expected);
  });

  it("caps the reference at 120 characters but keeps the whole URL", () => {
    const url = `https://example.com/${"a".repeat(110)}`;
    const result = one(url);

    expect(result?.ref).toHaveLength(120);
    expect(url.startsWith(result?.ref.slice(0, 119) ?? "-")).toBe(true);
    expect(result?.url).toBe(url);
    expect(result?.number).toBeNull();
  });

  it("is null without a delivery or with a blank one", () => {
    expect(mergeRequestOf([])).toBeNull();
    expect(mergeRequestOf([{ part: "part-b", mr: "!9" }])).toBeNull();
    expect(one("   ")).toBeNull();
  });

  it("uses the part's latest delivery", () => {
    expect(
      mergeRequestOf([
        { part: "part-a", mr: "!1" },
        { part: "part-a", mr: "!2" },
      ]),
    ).toEqual({ ref: "!2", url: null, number: 2 });
  });
});

describe("cost", () => {
  const costOf = (
    entry: DispatchLiveInitiative | null,
    waveLive: ReadonlyArray<DispatchLivePart> = [],
  ) =>
    onlyPart(
      buildInitiativeBoard(
        inputs({
          state: state({ parts: [ledgerPart("part-a", 1, "specced")] }),
          registry: entry,
          records: new Map([["part-a", records({ waveLive })]]),
        }),
      ),
    ).cost;
  const row = (costUsd: number, costState: string) =>
    registry({ parts: { "part-a": { wave: 1, running: 0, settled: 0, costUsd, costState } } });

  it("maps the registry row's cost state", () => {
    expect(costOf(row(3.5, "final"))).toEqual({ usd: 3.5, state: "exact" });
    expect(costOf(row(3.5, "estimated"))).toEqual({ usd: 3.5, state: "estimated" });
    expect(costOf(row(3.5, "incomplete"))).toEqual({ usd: 3.5, state: "incomplete" });
    expect(costOf(row(2, ""))).toEqual({ usd: 2, state: "estimated" });
    expect(costOf(row(0, ""))).toEqual({ usd: null, state: "unknown" });
  });

  it("sums the wave records' child costs as an estimate without a registry row", () => {
    expect(
      costOf(registry(), [
        live({ wave: 1, children: [executor({ costUsd: 1.25 }), executor({ costUsd: null })] }),
        live({ wave: 2, children: [executor({ costUsd: 0.5 })] }),
      ]),
    ).toEqual({ usd: 1.75, state: "estimated" });
  });

  it("is unknown with neither", () => {
    expect(costOf(null, [live({ children: [executor({ costUsd: null })] })])).toEqual({
      usd: null,
      state: "unknown",
    });
  });
});

describe("part times", () => {
  it("starts at the earliest wave run, in UTC", () => {
    const part = onlyPart(
      buildInitiativeBoard(
        inputs({
          state: state({ parts: [ledgerPart("part-a", 1, "specced")] }),
          records: new Map([
            [
              "part-a",
              records({
                waveLive: [
                  live({ wave: 2, runStartedAt: "2026-11-21T11:00:00Z" }),
                  live({ wave: 1, runStartedAt: "2026-11-21T12:00:00+02:00" }),
                ],
              }),
            ],
          ]),
        }),
      ),
    );

    expect(part.startedAt).toBe("2026-11-21T10:00:00.000Z");
  });
});

describe("initiative totals", () => {
  it("takes title, start and spend from the ledger, registry and ceiling", () => {
    const board = buildInitiativeBoard(
      inputs({
        state: state({ parts: [ledgerPart("part-a", 1, "gate-pass")] }),
        registry: registry({ reportedCostUsd: 14.2, totalCostState: "estimated" }),
        ceilingUsd: 60,
      }),
    );

    expect(board.slug).toBe("alpha");
    expect(board.title).toBe("Alpha rollout");
    expect(board.closed).toBe(false);
    expect(board.startedAt).toBe("2026-11-20T08:00:00Z");
    expect(board.spend).toEqual({ usd: 14.2, state: "estimated", ceilingUsd: 60 });
  });

  it("reports unknown spend and no start without a registry entry", () => {
    const board = buildInitiativeBoard(inputs({ ceilingUsd: 25 }));

    expect(board.spend).toEqual({ usd: null, state: "unknown", ceilingUsd: 25 });
    expect(board.startedAt).toBeNull();
  });
});

describe("needs you", () => {
  it("lists open decisions oldest first with options, default and auto-continue time", () => {
    const board = buildInitiativeBoard(
      inputs({
        state: state({ parts: [ledgerPart("part-a", 1, "gate-fail")] }),
        openDecisions: [
          decision({ id: "d-3", part: "part-b", raisedAt: "2026-11-22T10:05:00Z" }),
          decision({
            id: "d-1",
            default: "continue",
            recommended: "continue",
            applyAfter: "2026-11-22T10:04:00Z",
            needsPerson: false,
            initiative: "alpha",
          }),
          decision({
            id: "d-2",
            kind: "push",
            part: "part-c",
            protection: "outward",
            needsPerson: true,
            dir: "/w/part-c",
          }),
        ],
      }),
    );

    expect(board.needsYou.map((item) => item.decisionId)).toEqual(["d-1", "d-2", "d-3"]);
    expect(board.needsYou[0]).toEqual({
      cardId: "dispatch.decision:/w/part-a#d-1",
      decisionId: "d-1",
      kind: "next-part",
      question: "Continue to the next part?",
      part: "part-a",
      options: [
        { key: "pause", label: "Pause", recommended: false },
        { key: "continue", label: "Continue", recommended: true },
      ],
      defaultKey: "continue",
      applyAfter: "2026-11-22T10:04:00Z",
      protection: null,
      needsPerson: false,
      raisedAt: "2026-11-22T10:00:00Z",
    });
    expect(board.needsYou[1]).toMatchObject({
      cardId: "dispatch.decision:/w/part-c#d-2",
      defaultKey: null,
      applyAfter: null,
      protection: "outward",
      needsPerson: true,
    });
    expect(board.headline).toEqual({ kind: "needs-you", decisions: 3, part: "part-a" });
  });

  it("orders by raise time, not by id", () => {
    const board = buildInitiativeBoard(
      inputs({
        openDecisions: [
          decision({ id: "a-late", raisedAt: "2026-11-22T11:00:00Z" }),
          decision({ id: "z-early", part: "part-z", raisedAt: "2026-11-22T09:00:00Z" }),
        ],
      }),
    );

    expect(board.needsYou.map((item) => item.decisionId)).toEqual(["z-early", "a-late"]);
    expect(board.headline).toEqual({ kind: "needs-you", decisions: 2, part: "part-z" });
  });
});

describe("headline", () => {
  const headlineOf = (overrides: Partial<InitiativeBoardInputs>) =>
    buildInitiativeBoard(inputs(overrides)).headline;
  const running = records({ waveLive: [live({ alive: true, complete: false })] });
  const gating = records({
    waveLive: [live({ alive: true, complete: false, gate: gate({ state: "running" }) })],
  });

  it("is closed before anything else", () => {
    expect(
      headlineOf({
        state: state({ parts: [ledgerPart("part-a", 1, "gate-fail")] }),
        openDecisions: [decision()],
        registry: registry({ closed: true }),
      }),
    ).toEqual({ kind: "closed" });
    expect(headlineOf({ state: state({ closed: true }) })).toEqual({ kind: "closed" });
  });

  it("puts a failing part before a gating or running one", () => {
    expect(
      headlineOf({
        state: state({
          parts: [
            ledgerPart("part-a", 1, "specced"),
            ledgerPart("part-b", 1, "specced"),
            ledgerPart("part-c", 1, "gate-fail"),
          ],
          waves: [ledgerWave(1, true, false)],
        }),
        records: new Map([
          ["part-a", running],
          ["part-b", gating],
        ]),
      }),
    ).toEqual({ kind: "failing", part: "part-c", failedChecks: 0 });
  });

  it("ignores a failing part in a wave after the current one", () => {
    expect(
      headlineOf({
        state: state({
          parts: [ledgerPart("part-a", 1, "specced"), ledgerPart("part-b", 2, "gate-fail")],
          waves: [ledgerWave(1, true, false), ledgerWave(2, false, false)],
        }),
        records: new Map([["part-a", running]]),
      }),
    ).toEqual({ kind: "running", part: "part-a", phase: null, nextPart: null });
  });

  it("puts a gating part before a running one", () => {
    expect(
      headlineOf({
        state: state({
          parts: [ledgerPart("part-a", 1, "specced"), ledgerPart("part-b", 1, "specced")],
        }),
        records: new Map([
          ["part-a", running],
          ["part-b", gating],
        ]),
      }),
    ).toEqual({ kind: "gating", part: "part-b" });
  });

  it("caps the running phase index at the phase total", () => {
    const phases: DispatchLivePart["phases"] = [
      { id: "1", name: "Schema", wave: 1, tier: "standard" },
      { id: "2", name: "Parser", wave: 1, tier: "standard" },
    ];
    expect(
      headlineOf({
        state: state({ parts: [ledgerPart("part-a", 1, "specced")] }),
        records: new Map([
          [
            "part-a",
            records({
              waveLive: [
                live({
                  alive: true,
                  complete: false,
                  phases,
                  children: [
                    executor({ phase: "1", disposition: "settled" }),
                    executor({ id: "2", phase: "2", disposition: "settled" }),
                  ],
                }),
              ],
            }),
          ],
        ]),
      }),
    ).toEqual({ kind: "running", part: "part-a", phase: { index: 2, total: 2 }, nextPart: null });
  });

  it("waits on the next unstarted part in the current or a later wave", () => {
    expect(
      headlineOf({
        state: state({
          parts: [
            ledgerPart("part-a", 1, "briefed"),
            ledgerPart("part-b", 2, "gate-pass"),
            ledgerPart("part-c", 3, "planned"),
          ],
          waves: [
            ledgerWave(1, true, true),
            ledgerWave(2, true, false),
            ledgerWave(3, false, false),
          ],
        }),
      }),
    ).toEqual({ kind: "waiting", nextPart: "part-c" });
  });

  it("is done when every part is settled", () => {
    expect(
      headlineOf({
        state: state({
          parts: [
            ledgerPart("part-a", 1, "gate-pass"),
            ledgerPart("part-b", 1, "mr-open"),
            ledgerPart("part-c", 2, "merged"),
          ],
        }),
      }),
    ).toEqual({ kind: "done" });
  });
});
