import {
  EnvironmentId,
  PluginCardId,
  type PluginInitiativeBoard,
  type PluginInitiativeCost,
  type PluginInitiativeDecision,
  type PluginInitiativeGate,
  type PluginInitiativePart,
  type PluginInitiativePhase,
  type PluginInitiativeWave,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardSearchFromUrl } from "../boardSearch";
import { PART_STATUS_LOOK } from "./boardLook";
import {
  boardTarget,
  failedCheckCount,
  formatCost,
  headlineWithoutDecisions,
  mergeRequestLabel,
  minutesUntil,
  optionsPrimaryLast,
  partTitle,
  type PhaseSummary,
  phaseSummary,
  previousWave,
  primaryOptionKey,
  runningParts,
  settledFill,
  type SpendView,
  spendView,
} from "./board.logic";

describe("boardTarget", () => {
  const alpha = EnvironmentId.make("alpha");
  const beta = EnvironmentId.make("beta");
  const checkout = { environmentId: alpha, slug: "checkout-retries" };
  const otherCheckout = { environmentId: beta, slug: "checkout-retries" };
  const billing = { environmentId: beta, slug: "billing" };
  const selected = { kind: "initiative", ...checkout };
  const choose = { kind: "choose" };
  const none = { kind: "none" };

  it.each([
    [
      "prefers the explicit environment over an open match elsewhere",
      checkout,
      [otherCheckout],
      [beta, alpha],
      selected,
    ],
    [
      "opens an explicit connected target absent from the open list",
      checkout,
      [],
      [alpha],
      selected,
    ],
    [
      "reports disconnection even when another environment has the slug",
      checkout,
      [otherCheckout],
      [beta],
      { kind: "disconnected", ...checkout },
    ],
    [
      "reports disconnection with no connected environments",
      checkout,
      [],
      [],
      { kind: "disconnected", ...checkout },
    ],
    [
      "finds the sole slug match among unrelated open initiatives",
      { slug: "checkout-retries" },
      [billing, checkout],
      [beta, alpha],
      selected,
    ],
    [
      "resolves the sole open slug match independently of connected fallback",
      { slug: "checkout-retries" },
      [checkout],
      [beta],
      selected,
    ],
    [
      "asks for a choice when a slug is open in two environments",
      { slug: "checkout-retries" },
      [checkout, otherCheckout],
      [alpha, beta],
      choose,
    ],
    [
      "opens a closed initiative through the sole connected environment",
      { slug: "checkout-retries" },
      [billing],
      [beta],
      { kind: "initiative", ...otherCheckout },
    ],
    [
      "asks for a choice when no slug matches and two environments are connected",
      { slug: "checkout-retries" },
      [billing],
      [beta, alpha],
      choose,
    ],
    [
      "asks for a choice when no slug matches and nothing is connected",
      { slug: "checkout-retries" },
      [],
      [],
      choose,
    ],
    ["opens the only initiative from a bare URL", {}, [checkout], [alpha], selected],
    ["gives a bare URL no target when nothing is open", {}, [], [alpha], none],
    [
      "asks for a choice when a bare URL has several open initiatives",
      {},
      [checkout, billing],
      [alpha, beta],
      choose,
    ],
    [
      "ignores an environment without a slug when one initiative is open elsewhere",
      { environmentId: beta },
      [checkout],
      [alpha, beta],
      selected,
    ],
    [
      "ignores an environment without a slug when no initiatives are open",
      { environmentId: alpha },
      [],
      [alpha],
      none,
    ],
    [
      "ignores an environment with an empty slug when several initiatives are open",
      { environmentId: alpha, slug: "" },
      [checkout, billing],
      [alpha, beta],
      choose,
    ],
    [
      "ignores a malformed slug",
      { environmentId: beta, slug: ["checkout-retries"] },
      [checkout],
      [alpha, beta],
      selected,
    ],
    [
      "uses the slug-only path when the environment is malformed",
      { environmentId: {}, slug: "checkout-retries" },
      [checkout, otherCheckout],
      [alpha, beta],
      choose,
    ],
  ] as const)("%s", (_name, raw, open, connected, expected) => {
    expect(boardTarget(boardSearchFromUrl(raw), open, connected)).toStrictEqual(expected);
  });
});

describe("phaseSummary", () => {
  const prepare = { id: "prepare", name: "Prepare", state: "done", attempt: 1 } as const;
  const build = { id: "build", name: "Build", state: "running", attempt: 1 } as const;
  const failed = { ...build, state: "failed", attempt: 2 } as const;
  const check = { id: "check", name: "Check", state: "pending", attempt: null } as const;
  const publish = { id: "publish", name: "Publish", state: "stale", attempt: null } as const;
  const built = { ...build, state: "done" } as const;

  it.each([
    [
      "reports zero counts and no selections for an empty list",
      [],
      { done: 0, total: 0, current: null, next: null, attempt: null },
    ],
    [
      "reports all phases done and no current or next phase",
      [prepare, { ...check, state: "done" }],
      { done: 2, total: 2, current: null, next: null, attempt: 1 },
    ],
    [
      "indexes a running phase from one and picks the first pending phase after it",
      [prepare, build, check, publish],
      { done: 1, total: 4, current: { index: 2, phase: build }, next: check, attempt: 1 },
    ],
    [
      "picks a failed phase before a running phase and a stale phase before a pending one",
      [prepare, failed, build, publish, check],
      { done: 1, total: 5, current: { index: 2, phase: failed }, next: publish, attempt: 2 },
    ],
    [
      "keeps the first running phase when a later phase failed",
      [build, failed, check],
      { done: 0, total: 3, current: { index: 1, phase: build }, next: check, attempt: 2 },
    ],
    [
      "skips a stale phase before the last done phase",
      [prepare, publish, built, check],
      { done: 2, total: 4, current: null, next: check, attempt: 1 },
    ],
    [
      "starts at the first stale phase with no current or done phase",
      [publish, check],
      { done: 0, total: 2, current: null, next: publish, attempt: null },
    ],
    [
      "never wraps to an eligible phase before current",
      [check, build, prepare],
      { done: 1, total: 3, current: { index: 2, phase: build }, next: null, attempt: 1 },
    ],
    [
      "uses current as the start even when a done phase comes later",
      [build, check, prepare],
      { done: 1, total: 3, current: { index: 1, phase: build }, next: check, attempt: 1 },
    ],
    [
      "does not wrap when the last done phase ends the list",
      [check, prepare],
      { done: 1, total: 2, current: null, next: null, attempt: 1 },
    ],
    [
      "keeps an attempt of zero",
      [{ ...check, attempt: 0 }],
      { done: 0, total: 1, current: null, next: { ...check, attempt: 0 }, attempt: 0 },
    ],
    [
      "keeps the highest negative attempt when no nonnegative attempt is set",
      [{ ...prepare, attempt: -2 }, { ...check, attempt: -1 }, publish],
      { done: 1, total: 3, current: null, next: { ...check, attempt: -1 }, attempt: -1 },
    ],
  ] as const satisfies ReadonlyArray<
    readonly [string, ReadonlyArray<PluginInitiativePhase>, PhaseSummary]
  >)("%s", (_name, phases, expected) => {
    expect(phaseSummary(phases)).toStrictEqual(expected);
  });
});

describe("formatCost", () => {
  it.each([
    ["formats exact positive cost as dollars and cents", 1234.5, "exact", "$1,234.50"],
    ["prefixes estimated cost", 12, "estimated", "~$12.00"],
    ["suffixes incomplete cost", 12, "incomplete", "$12.00+"],
    ["hides unknown cost even with a numeric amount", 12, "unknown", null],
    ["hides a missing amount even when estimated", null, "estimated", null],
    ["hides zero", 0, "exact", null],
    ["hides negative cost", -1, "incomplete", null],
    ["keeps a positive cost that rounds down to zero", 0.001, "exact", "$0.00"],
  ] as const satisfies ReadonlyArray<
    readonly [string, number | null, PluginInitiativeCost["state"], string | null]
  >)("%s", (_name, usd, state, expected) => {
    expect(formatCost({ usd, state })).toBe(expected);
  });
});

describe("spendView", () => {
  it.each([
    [
      "shows exact zero and an empty bar",
      0,
      "exact",
      100,
      { value: "$0.00", ceiling: "$100.00", fill: 0, tone: null },
    ],
    [
      "prefixes estimated zero",
      0,
      "estimated",
      null,
      { value: "~$0.00", ceiling: null, fill: null, tone: null },
    ],
    [
      "suffixes incomplete zero",
      0,
      "incomplete",
      null,
      { value: "$0.00+", ceiling: null, fill: null, tone: null },
    ],
    [
      "fills estimated spend without a warning below 80%",
      79.5,
      "estimated",
      100,
      { value: "~$79.50", ceiling: "$100.00", fill: 79.5, tone: null },
    ],
    [
      "warns on incomplete spend at exactly 80%",
      80,
      "incomplete",
      100,
      { value: "$80.00+", ceiling: "$100.00", fill: 80, tone: "warning" },
    ],
    [
      "keeps the warning above 80% and below 100%",
      99.5,
      "exact",
      100,
      { value: "$99.50", ceiling: "$100.00", fill: 99.5, tone: "warning" },
    ],
    [
      "errors at exactly 100%",
      100,
      "exact",
      100,
      { value: "$100.00", ceiling: "$100.00", fill: 100, tone: "error" },
    ],
    [
      "caps fill above 100% and keeps the error",
      101,
      "exact",
      100,
      { value: "$101.00", ceiling: "$100.00", fill: 100, tone: "error" },
    ],
    [
      "hides unknown spend despite an amount and a ceiling",
      100,
      "unknown",
      100,
      { value: null, ceiling: "$100.00", fill: null, tone: null },
    ],
    [
      "hides missing spend while retaining its ceiling",
      null,
      "incomplete",
      100,
      { value: null, ceiling: "$100.00", fill: null, tone: null },
    ],
    [
      "shows positive spend without a ceiling",
      5,
      "exact",
      null,
      { value: "$5.00", ceiling: null, fill: null, tone: null },
    ],
    [
      "formats a zero ceiling without filling the bar",
      5,
      "exact",
      0,
      { value: "$5.00", ceiling: "$0.00", fill: null, tone: null },
    ],
    [
      "formats a negative ceiling without filling the bar",
      5,
      "exact",
      -20,
      { value: "$5.00", ceiling: "-$20.00", fill: null, tone: null },
    ],
    [
      "uses the ceiling as denominator and keeps fractional fill",
      1,
      "exact",
      8,
      { value: "$1.00", ceiling: "$8.00", fill: 12.5, tone: null },
    ],
    [
      "formats a negative amount and preserves its ratio",
      -2,
      "exact",
      8,
      { value: "-$2.00", ceiling: "$8.00", fill: -25, tone: null },
    ],
  ] as const satisfies ReadonlyArray<
    readonly [string, number | null, PluginInitiativeCost["state"], number | null, SpendView]
  >)("%s", (_name, usd, state, ceilingUsd, expected) => {
    expect(spendView({ usd, state, ceilingUsd })).toStrictEqual(expected);
  });
});

describe("primaryOptionKey", () => {
  const narrow = { key: "narrow", label: "Narrow", recommended: false };
  const broad = { key: "broad", label: "Broad", recommended: false };
  const recommended = { ...broad, recommended: true };

  it.each([
    ["prefers a recommended option over a valid default", [narrow, recommended], "narrow", "broad"],
    ["keeps a recommendation even with no default", [recommended], null, "broad"],
    [
      "keeps the first of multiple recommendations",
      [recommended, { ...narrow, recommended: true }],
      "narrow",
      "broad",
    ],
    ["finds a valid default without a recommendation", [narrow, broad], "broad", "broad"],
    ["rejects a default key that matches no option", [narrow], "missing", null],
    ["returns null with neither a recommendation nor a default", [narrow], null, null],
    ["rejects a default when there are no options", [], "broad", null],
    ["honors a matching empty-string default key", [{ ...narrow, key: "" }], "", ""],
  ] as const)("%s", (_name, options, defaultKey, expected) => {
    const decision: PluginInitiativeDecision = {
      cardId: PluginCardId.make("dispatch.decision:alpha"),
      decisionId: "alpha",
      kind: "scope",
      question: "Which scope?",
      part: "part-a",
      options,
      defaultKey,
      applyAfter: null,
      protection: null,
      needsPerson: false,
      raisedAt: "2026-11-21T09:00:00Z",
    };
    expect(primaryOptionKey(decision)).toBe(expected);
  });
});

describe("optionsPrimaryLast", () => {
  const keep = { key: "keep", label: "Keep", recommended: false };
  const skip = { key: "skip", label: "Skip", recommended: false };
  const pause = { key: "pause", label: "Pause", recommended: false };
  const decision = (options: PluginInitiativeDecision["options"], defaultKey: string | null) => ({
    cardId: PluginCardId.make("dispatch.decision:alpha"),
    decisionId: "alpha",
    kind: "scope",
    question: "Which scope?",
    part: "part-a",
    options,
    defaultKey,
    applyAfter: null,
    protection: null,
    needsPerson: false,
    raisedAt: "2026-11-21T09:00:00Z",
  });

  it.each([
    [
      "moves a leading recommended option to the end",
      [{ ...keep, recommended: true }, skip, pause],
      null,
      ["skip", "pause", "keep"],
    ],
    [
      "leaves a trailing recommended option in place",
      [skip, pause, { ...keep, recommended: true }],
      null,
      ["skip", "pause", "keep"],
    ],
    [
      "moves a default with no recommendation to the end",
      [keep, skip, pause],
      "keep",
      ["skip", "pause", "keep"],
    ],
    [
      "keeps the given order when nothing is primary",
      [keep, skip, pause],
      null,
      ["keep", "skip", "pause"],
    ],
  ] as const)("%s", (_name, options, defaultKey, expected) => {
    expect(optionsPrimaryLast(decision(options, defaultKey)).map(({ key }) => key)).toStrictEqual(
      expected,
    );
  });
});

it.each([
  ["clamps a past time to zero", "2026-11-21T08:57:59Z", 0],
  ["returns zero at the reference time", "2026-11-21T09:00:00Z", 0],
  ["rounds one second up to one minute", "2026-11-21T09:00:01Z", 1],
  ["keeps an exact minute whole", "2026-11-21T09:01:00Z", 1],
  ["rounds 61 seconds up to two minutes", "2026-11-21T09:01:01Z", 2],
  ["returns zero when the deadline cannot be parsed", "", 0],
] as const)("minutesUntil %s", (_name, deadline, expected) => {
  expect(minutesUntil(deadline, "2026-11-21T09:00:00Z")).toBe(expected);
});

it.each([
  ["counts zero for a null gate", null, 0],
  ["counts zero for an empty failed gate", { state: "failed", at: null, checks: [] }, 0],
  [
    "counts only failed checks independently of the gate state",
    {
      state: "running",
      at: null,
      checks: [
        { id: "lint", state: "fail", summary: "" },
        { id: "build", state: "pass", summary: "" },
        { id: "test", state: "fail", summary: "" },
        { id: "format", state: "skipped", summary: "" },
        { id: "types", state: "stale", summary: "" },
        { id: "review", state: "running", summary: "" },
        { id: "package", state: "pending", summary: "" },
      ],
    },
    2,
  ],
] as const satisfies ReadonlyArray<readonly [string, PluginInitiativeGate | null, number]>)(
  "failedCheckCount %s",
  (_name, gate, expected) => {
    expect(failedCheckCount(gate)).toBe(expected);
  },
);

it.each([
  ["has no fill for a zero total", 0, 0, null],
  ["shows zero fill when none are settled", 0, 4, 0],
  ["calculates percentage from the counts", 1, 8, 12.5],
  ["reaches 100% when all are settled", 4, 4, 100],
] as const)("settledFill %s", (_name, settled, total, expected) => {
  expect(settledFill({ settled, total })).toBe(expected);
});

it.each([
  ["prefers a number over the ref", 12, "acme/app!12", "!12"],
  ["uses a number of zero when present", 0, "acme/app!12", "!0"],
  ["falls back to the ref without a number", null, "acme/app!12", "acme/app!12"],
] as const)("mergeRequestLabel %s", (_name, number, ref, expected) => {
  expect(mergeRequestLabel({ number, ref, url: null })).toBe(expected);
});

describe("board wave helpers", () => {
  function part(
    id: string,
    title: string,
    wave: number,
    status: PluginInitiativePart["status"],
  ): PluginInitiativePart {
    return {
      id,
      title,
      wave,
      status,
      phases: [],
      gate: null,
      branch: null,
      mergeRequest: null,
      cost: { usd: null, state: "unknown" },
      startedAt: null,
      lastEventAt: null,
    };
  }

  function wave(number: number, parts: ReadonlyArray<PluginInitiativePart>): PluginInitiativeWave {
    return {
      number,
      name: "Checkout",
      moreParts: 0,
      state: "active",
      partsSettled: 0,
      partsTotal: parts.length,
      parts,
    };
  }

  const gating = part("part-c", "", 1, "gating");
  const running = part("part-a", "Retry checkout", 3, "running");
  const later = part("part-b", "Check checkout", 3, "gating");
  const firstWave = wave(1, [part("part-d", "Plan checkout", 1, "planned"), gating]);
  const thirdWave = wave(3, [running, part("part-e", "Merge checkout", 3, "gate-pass"), later]);
  const board: PluginInitiativeBoard = {
    slug: "checkout-retries",
    title: null,
    closed: false,
    startedAt: null,
    asOf: "2026-11-21T09:00:00Z",
    headline: { kind: "waiting", nextPart: null },
    parts: { settled: 1, total: 5 },
    spend: { usd: null, state: "unknown", ceilingUsd: null },
    currentWave: 3,
    waves: [firstWave, thirdWave],
    needsYou: [],
  };

  it.each([
    ["finds a named part in the first wave", "part-d", "Plan checkout"],
    ["finds a named part beyond the first wave", "part-a", "Retry checkout"],
    ["falls back to the id for an empty title", "part-c", "part-c"],
    ["falls back to the id for an absent part", "part-f", "part-f"],
  ] as const)("partTitle %s", (_name, id, expected) => {
    expect(partTitle(board, id)).toBe(expected);
  });

  it.each([
    ["has no predecessor for the first wave", 1, null],
    ["looks up the predecessor by wave number", 4, thirdWave],
    ["returns null for a gap between wave numbers", 3, null],
  ] as const)("previousWave %s", (_name, number, expected) => {
    expect(previousWave(board, number)).toBe(expected);
  });

  it.each([
    [
      "keeps running and gating parts in wave and list order",
      [firstWave, thirdWave],
      [gating, running, later],
    ],
    ["returns an empty list when there are no waves", [], []],
  ] as const)("runningParts %s", (_name, waves, expected) => {
    expect(runningParts({ ...board, waves })).toStrictEqual(expected);
  });

  describe("headlineWithoutDecisions", () => {
    const planned = part("part-p", "Plan", 3, "planned");
    const failed = part("part-f", "Fail", 3, "gate-fail");

    it.each([
      [
        "prefers a failing gate over a running gate",
        [wave(1, [gating, failed])],
        { kind: "failing", part: "part-f", failedChecks: 0 },
      ],
      [
        "ignores a failing gate in a later wave",
        [wave(1, [gating]), wave(4, [part("part-l", "Late", 4, "gate-fail")])],
        { kind: "gating", part: "part-c" },
      ],
      [
        "reports the running part with the next queued one",
        [wave(3, [running, part("part-q", "Queue", 3, "queued")])],
        { kind: "running", part: "part-a", phase: null, nextPart: "part-q" },
      ],
      [
        "reports done when every part is settled",
        [wave(3, [part("part-m", "M", 3, "merged"), part("part-g", "G", 3, "gate-pass")])],
        { kind: "done" },
      ],
      [
        "waits on the first unstarted part at or after the current wave",
        [wave(1, [part("part-o", "Old", 1, "planned")]), wave(3, [planned])],
        { kind: "waiting", nextPart: "part-p" },
      ],
      [
        "waits without a next part when there are no parts",
        [],
        { kind: "waiting", nextPart: null },
      ],
    ] as const)("%s", (_name, waves, expected) => {
      expect(headlineWithoutDecisions({ ...board, waves })).toStrictEqual(expected);
    });
  });
});

it("gives every part status its own icon so no status relies on colour alone", () => {
  const icons = Object.values(PART_STATUS_LOOK).map(({ icon }) => icon);
  expect(new Set(icons).size).toBe(icons.length);
});
