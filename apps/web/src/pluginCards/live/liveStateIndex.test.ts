import {
  EnvironmentId,
  ThreadId,
  type PluginLiveChild,
  type PluginLiveInitiative,
  type PluginLiveState,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import {
  boardInitiatives,
  formatAsOf,
  hasOpenDecision,
  initiativeForThread,
  initiativeMetrics,
  initiativeSidebarGroups,
} from "./liveStateIndex";

const t = (id: string) => ThreadId.make(id);
const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");
const at = "2026-11-21T09:00:00Z";

function initiative(overrides: Partial<PluginLiveInitiative> = {}): PluginLiveInitiative {
  return {
    slug: "alpha",
    title: null,
    closed: false,
    wave: { current: 1, total: 1, partsSettled: 0, partsTotal: 0 },
    settled: { count: 0, total: 0 },
    running: 0,
    openDecisions: 0,
    spend: { usd: null, state: "unknown" },
    orchestratorThreadId: null,
    asOf: at,
    parts: [],
    ...overrides,
  };
}

function child(overrides: Partial<PluginLiveChild> = {}): PluginLiveChild {
  return {
    id: "c1",
    kind: "run",
    initiative: "alpha",
    part: "p1",
    wave: 1,
    phase: null,
    state: "running",
    threadId: null,
    dir: "/repo",
    startedAt: null,
    updatedAt: null,
    costUsd: null,
    ...overrides,
  };
}

function live(overrides: Partial<PluginLiveState> = {}): PluginLiveState {
  return {
    asOf: at,
    initiatives: [],
    children: [],
    decisions: [],
    waitingThreadIds: [],
    ...overrides,
  };
}

function part(id: string, threadIds: string[], wave = 1) {
  return { id, title: null, wave, status: "running", threadIds: threadIds.map(t) };
}

const spendValue = (usd: number | null, state: PluginLiveInitiative["spend"]["state"]) =>
  initiativeMetrics(initiative({ spend: { usd, state } })).find((m) => m.label === "Spend")!;

it("hasOpenDecision is true only for a thread listed as waiting", () => {
  const state = live({ waitingThreadIds: [t("a")] });
  expect(hasOpenDecision(state, t("a"))).toBe(true);
  expect(hasOpenDecision(state, t("b"))).toBe(false);
  expect(hasOpenDecision(live(), t("a"))).toBe(false);
  expect(hasOpenDecision(null, t("a"))).toBe(false);
});

it.each([
  ["orchestrator chat", initiative({ orchestratorThreadId: t("x") }), [], "alpha"],
  ["part chat", initiative({ parts: [part("p1", ["x"])] }), [], "alpha"],
  ["child chat", initiative(), [child({ threadId: t("x"), initiative: "alpha" })], "alpha"],
])("initiativeForThread resolves a %s", (_name, init, children, slug) => {
  expect(initiativeForThread(live({ initiatives: [init], children }), t("x"))?.slug).toBe(slug);
});

it("initiativeForThread prefers the orchestrator rule over part and child rules", () => {
  const state = live({
    initiatives: [
      initiative({ slug: "by-child" }),
      initiative({ slug: "by-part", parts: [part("p1", ["x"])] }),
      initiative({ slug: "by-orchestrator", orchestratorThreadId: t("x") }),
    ],
    children: [child({ threadId: t("x"), initiative: "by-child" })],
  });
  expect(initiativeForThread(state, t("x"))?.slug).toBe("by-orchestrator");
});

it("initiativeForThread prefers the part rule over the child rule", () => {
  const state = live({
    initiatives: [
      initiative({ slug: "by-child" }),
      initiative({ slug: "by-part", parts: [part("p1", ["x"])] }),
    ],
    children: [child({ threadId: t("x"), initiative: "by-child" })],
  });
  expect(initiativeForThread(state, t("x"))?.slug).toBe("by-part");
});

it("initiativeForThread ignores closed initiatives, unknown chats and missing state", () => {
  const closed = initiative({ closed: true, orchestratorThreadId: t("x") });
  expect(initiativeForThread(live({ initiatives: [closed] }), t("x"))).toBeNull();
  const closedByChild = live({
    initiatives: [initiative({ closed: true })],
    children: [child({ threadId: t("x") })],
  });
  expect(initiativeForThread(closedByChild, t("x"))).toBeNull();
  expect(initiativeForThread(live({ initiatives: [initiative()] }), t("y"))).toBeNull();
  expect(initiativeForThread(null, t("x"))).toBeNull();
});

it("sidebar groups list orchestrator, then parts, then children, without repeats", () => {
  const state = live({
    initiatives: [
      initiative({
        orchestratorThreadId: t("orch"),
        parts: [part("p1", ["a", "b"]), part("p2", ["b", "c"])],
      }),
    ],
    children: [
      child({ threadId: t("c"), initiative: "alpha" }),
      child({ id: "c2", threadId: t("d"), initiative: "alpha" }),
      child({ id: "c3", threadId: t("other"), initiative: "beta" }),
      child({ id: "c4", threadId: null, initiative: "alpha" }),
    ],
  });
  const [group] = initiativeSidebarGroups([{ environmentId: envA, state }]);
  expect(group?.threadIds).toEqual(["orch", "a", "b", "c", "d"]);
});

it("sidebar groups skip closed initiatives, initiatives with no chats and missing state", () => {
  const groups = initiativeSidebarGroups([
    { environmentId: envA, state: null },
    {
      environmentId: envB,
      state: live({
        initiatives: [
          initiative({ slug: "empty" }),
          initiative({ slug: "closed", closed: true, orchestratorThreadId: t("x") }),
        ],
      }),
    },
  ]);
  expect(groups).toEqual([]);
});

it("sidebar groups for two environments with the same slug stay separate", () => {
  const state = live({ initiatives: [initiative({ orchestratorThreadId: t("x") })] });
  const groups = initiativeSidebarGroups([
    { environmentId: envA, state },
    { environmentId: envB, state },
  ]);
  expect(groups.map((g) => g.key)).toEqual(["env-a:alpha", "env-b:alpha"]);
  expect(groups.map((g) => g.environmentId)).toEqual([envA, envB]);
});

it("sidebar groups use the title, else the slug, as the label and sort by it", () => {
  const state = live({
    initiatives: [
      initiative({ slug: "zeta", title: "Alpha work", orchestratorThreadId: t("1") }),
      initiative({ slug: "mid", orchestratorThreadId: t("2") }),
      initiative({ slug: "aaa", title: "Zulu", orchestratorThreadId: t("3") }),
    ],
  });
  const groups = initiativeSidebarGroups([{ environmentId: envA, state }]);
  expect(groups.map((g) => g.label)).toEqual(["Alpha work", "mid", "Zulu"]);
});

it.each([
  [{ current: 2, total: 3, partsSettled: 3, partsTotal: 5 }, "Wave 2 of 3 · 3 of 5 parts settled"],
  [{ current: 1, total: 1, partsSettled: 0, partsTotal: 0 }, "Wave 1 of 1"],
])("sidebar group end label for %j", (wave, expected) => {
  const state = live({ initiatives: [initiative({ wave, orchestratorThreadId: t("x") })] });
  expect(initiativeSidebarGroups([{ environmentId: envA, state }])[0]?.endLabel).toBe(expected);
});

it("sidebar groups are structurally equal when only as-of times change", () => {
  const build = (asOf: string) =>
    initiativeSidebarGroups([
      {
        environmentId: envA,
        state: live({
          asOf,
          initiatives: [initiative({ asOf, orchestratorThreadId: t("x") })],
        }),
      },
    ]);
  expect(build("2026-11-21T09:00:00Z")).toEqual(build("2026-11-21T09:05:00Z"));
  expect(JSON.stringify(build(at))).not.toContain("asOf");
});

it("metrics for zero parts have no bars and the stated wording", () => {
  expect(initiativeMetrics(initiative())).toMatchObject([
    { label: "Wave 1", value: "0 of 0", fill: null, tone: null },
    { label: "Settled", value: "0 of 0", fill: null, tone: null },
    { label: "Running", value: "0", fill: null, tone: null },
    { label: "Decisions", value: "None", fill: null, tone: null },
    { label: "Spend", value: "Unknown", fill: null, tone: null },
  ]);
});

it("metrics show bar shares, running count and open decisions with a warning tone", () => {
  const metrics = initiativeMetrics(
    initiative({
      wave: { current: 2, total: 3, partsSettled: 1, partsTotal: 4 },
      settled: { count: 6, total: 8 },
      running: 2,
      openDecisions: 3,
    }),
  );
  expect(metrics).toMatchObject([
    { label: "Wave 2", value: "1 of 4", fill: 0.25 },
    { label: "Settled", value: "6 of 8", fill: 0.75 },
    { label: "Running", value: "2" },
    { label: "Decisions", value: "3 open", tone: "warning" },
    { label: "Spend" },
  ]);
});

it.each([
  [12.3, "exact", "$12.30", "Exact"],
  [12.345, "estimated", "~$12.35", "Estimated"],
  [0.5, "incomplete", "~$0.50", "Incomplete: some runs have no cost yet"],
  [null, "unknown", "Unknown", "Unknown"],
  [null, "exact", "Unknown", "Exact"],
] as const)("spend %s in state %s reads %s", (usd, state, value, tooltip) => {
  expect(spendValue(usd, state)).toMatchObject({ value, tooltip });
});

it("board lists open initiatives across environments, active first then newest as-of", () => {
  const stateA = live({
    initiatives: [
      initiative({ slug: "idle-new", asOf: "2026-11-21T08:00:00Z" }),
      initiative({ slug: "busy-old", asOf: "2026-11-01T08:00:00Z", running: 1 }),
      initiative({ slug: "done", closed: true, running: 5 }),
    ],
  });
  const stateB = live({
    initiatives: [
      initiative({ slug: "asking", asOf: "2026-11-10T08:00:00Z", openDecisions: 1 }),
      initiative({ slug: "idle-old", asOf: "2026-10-01T08:00:00Z" }),
    ],
  });
  const board = boardInitiatives([
    { environmentId: envA, state: stateA },
    { environmentId: envB, state: stateB },
    { environmentId: EnvironmentId.make("env-c"), state: null },
  ]);
  expect(board.map((b) => [b.key, b.active])).toEqual([
    ["env-b:asking", true],
    ["env-a:busy-old", true],
    ["env-a:idle-new", false],
    ["env-b:idle-old", false],
  ]);
  expect(board[0]?.metrics.map((m) => m.label)).toEqual([
    "Wave 1",
    "Settled",
    "Running",
    "Decisions",
    "Spend",
  ]);
});

it.each([
  ["2026-11-21T09:00:30Z", "updated just now"],
  ["2026-11-21T09:00:59.999Z", "updated just now"],
  ["2026-11-21T09:01:00Z", "updated 1m ago"],
  ["2026-11-21T09:03:00Z", "updated 3m ago"],
  ["2026-11-21T09:59:59Z", "updated 59m ago"],
  ["2026-11-21T10:00:00Z", "updated 1h ago"],
  ["2026-11-21T11:00:00Z", "updated 2h ago"],
  ["2026-11-22T08:59:59Z", "updated 23h ago"],
  ["2026-11-22T09:00:00Z", "updated 1d ago"],
  ["2026-11-25T09:00:00Z", "updated 4d ago"],
  ["2026-11-21T08:00:00Z", "updated just now"],
])("formatAsOf at %s reads %s", (now, expected) => {
  expect(formatAsOf(at, now)).toBe(expected);
});
