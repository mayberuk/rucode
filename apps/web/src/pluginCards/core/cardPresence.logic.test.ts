import {
  ThreadId,
  type DispatchDecisionCardData,
  type DispatchRunProgressCardData,
  type PluginCard,
  type PluginCardAction,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { cardPresence } from "./cardPresence.logic";

const at = "2026-11-21T09:00:00Z";
const shell = (id: string, actions: ReadonlyArray<PluginCardAction> = []) => ({
  id,
  threadId: ThreadId.make("thread"),
  placement: { type: "time" as const, at },
  updatedAt: at,
  actions,
});

const decision = (data: Partial<DispatchDecisionCardData>): PluginCard => ({
  ...shell("dispatch.decision:d1"),
  kind: "dispatch.decision",
  data: {
    decisionId: "d1",
    dir: "/repo",
    decisionKind: "scope",
    question: "Continue?",
    options: [
      { key: "go", label: "Continue", recommended: false },
      { key: "stop", label: "Stop", recommended: false },
    ],
    defaultKey: "go",
    state: "open",
    choice: null,
    chosenBy: null,
    chosenVia: null,
    raisedAt: at,
    applyAfter: "2026-11-21T09:05:00Z",
    resolvedAt: null,
    needsPerson: false,
    protection: null,
    initiative: "nov18",
    part: "ui",
    wave: 2,
    phase: null,
    answerable: "yes",
    answer: null,
    ...data,
  },
});

const run = (
  runId: string,
  data: Partial<DispatchRunProgressCardData>,
): Extract<PluginCard, { kind: "dispatch.runProgress" }> => ({
  ...shell(`dispatch.runProgress:${runId}`),
  kind: "dispatch.runProgress",
  data: {
    runId,
    dir: "/repo",
    part: "api",
    wave: 2,
    initiative: "nov18",
    spec: "api.md",
    outcome: "passed",
    reason: null,
    phases: [],
    phasesTotal: 0,
    startedAt: at,
    settledAt: null,
    costUsd: null,
    ...data,
  },
});

const plan = (actions: ReadonlyArray<PluginCardAction>): PluginCard => ({
  ...shell("dispatch.plan:p", actions),
  kind: "dispatch.plan",
  data: {
    task: "sidebar",
    specPath: "sidebar.md",
    dir: "/repo",
    status: "draft",
    wave: { current: 0, total: 1 },
    phases: [],
    initiative: null,
    part: null,
  },
});

const verify = (states: ReadonlyArray<"pass" | "fail" | "running">): PluginCard => ({
  ...shell("dispatch.verify:v"),
  kind: "dispatch.verify",
  data: {
    task: "api",
    specPath: "api.md",
    dir: "/repo",
    revision: null,
    checks: states.map((state, index) => ({ name: `check ${index}`, summary: "", state })),
  },
});

const livecheck = (verdict: "pass" | "fail" | "blocked" | "error"): PluginCard => ({
  ...shell("livecheck.result:l"),
  kind: "livecheck.result",
  data: {
    runId: "l",
    runDir: "/runs/l",
    target: "login",
    verdict,
    summary: "",
    judge: null,
    steps: [],
    failedStepIndex: null,
    finishedAt: at,
  },
});

const livecheckProgress: PluginCard = {
  ...shell("livecheck.progress:l"),
  kind: "livecheck.progress",
  data: {
    runId: "l",
    runDir: "/runs/l",
    target: "login",
    steps: [],
    currentStep: 1,
    totalSteps: 3,
    heartbeatAt: null,
    latestAssetId: null,
  },
};

const push = (
  batch: "done" | "failed" | "running",
  pipeline: "none" | "running" | "passed" | "failed",
): PluginCard => ({
  ...shell("gitty.push:b"),
  kind: "gitty.push",
  data: {
    branch: "feature",
    batches: [{ label: "batch 1", state: batch, commit: null }],
    mergeRequest: {
      url: null,
      number: 4,
      draft: true,
      additions: null,
      deletions: null,
      pipeline,
    },
  },
});

const conflict = (resolutions: number): PluginCard => ({
  ...shell("gitty.conflict:c"),
  kind: "gitty.conflict",
  data: {
    file: "src/a.ts",
    base: null,
    sides: [],
    resolutions: Array.from({ length: resolutions }, (_, index) => ({
      key: `r${index}`,
      label: `Resolution ${index}`,
      predictedOutcome: "",
    })),
  },
});

const round: PluginCard = {
  ...shell("iter8.round:1"),
  kind: "iter8.round",
  data: { round: 1, page: "https://example.test", pagePath: null, notes: [] },
};

const approve: PluginCardAction = { id: "approve", label: "Approve", type: "command" };

describe("cardPresence", () => {
  it.each([
    [
      "an open needs-person decision",
      decision({ needsPerson: true, defaultKey: null }),
      "needs-you",
    ],
    [
      "an open protected decision",
      decision({ protection: "outward", defaultKey: "stop" }),
      "needs-you",
    ],
    ["an open ordinary decision", decision({}), "background"],
    ["an answered decision", decision({ state: "answered", choice: "go" }), "background"],
    ["a defaulted decision", decision({ state: "defaulted", choice: "go" }), "background"],
    ["a superseded decision", decision({ state: "superseded" }), "background"],
    ["a plan with the approve footer", plan([approve]), "needs-you"],
    ["a plan without a footer", plan([]), "background"],
    ["a gitty conflict with resolutions", conflict(2), "needs-you"],
    ["a gitty conflict without resolutions", conflict(0), "background"],
    ["a failed run", run("r1", { outcome: "failed" }), "failed"],
    ["an aborted run", run("r1", { outcome: "aborted" }), "failed"],
    ["a running run", run("r1", { outcome: "running" }), "background"],
    ["a passed run", run("r1", { outcome: "passed" }), "background"],
    ["a verify with a failing check", verify(["pass", "fail"]), "failed"],
    ["a verify whose checks pass", verify(["pass", "pass"]), "background"],
    ["a verify still running", verify(["pass", "running"]), "background"],
    ["a livecheck that failed", livecheck("fail"), "failed"],
    ["a livecheck that was blocked", livecheck("blocked"), "failed"],
    ["a livecheck that errored", livecheck("error"), "failed"],
    ["a livecheck that passed", livecheck("pass"), "background"],
    ["a livecheck in progress", livecheckProgress, "background"],
    ["a push with a failed batch", push("failed", "none"), "failed"],
    ["a push whose pipeline failed", push("done", "failed"), "failed"],
    ["a push whose pipeline passed", push("done", "passed"), "background"],
    ["a push still pushing", push("running", "running"), "background"],
    ["a review round", round, "background"],
  ] as const)("shows %s as %s", (_label, card, presence) => {
    expect(cardPresence(card, [card])).toBe(presence);
  });

  it.each([
    ["at a later wave", { wave: 3 }],
    ["at the same wave", { wave: 2 }],
  ])("shows a failed run followed by a passing run of the same part %s as background", (_l, at) => {
    const failed = run("r1", { outcome: "failed", startedAt: "2026-11-21T09:00:00Z" });
    const passed = run("r2", { ...at, outcome: "passed", startedAt: "2026-11-21T09:30:00Z" });
    expect(cardPresence(failed, [failed, passed])).toBe("background");
  });

  it.each([
    ["another part", { part: "web" }],
    ["an earlier wave", { wave: 1 }],
    ["another initiative", { initiative: "other" }],
    ["a run that is still running", { outcome: "running" as const }],
    ["a passing run that started before it", { startedAt: "2026-11-21T08:00:00Z" }],
  ])("keeps a failed run failed after a passing run of %s", (_l, overrides) => {
    const failed = run("r1", { outcome: "failed", startedAt: "2026-11-21T09:00:00Z" });
    const other = run("r2", { outcome: "passed", startedAt: "2026-11-21T09:30:00Z", ...overrides });
    expect(cardPresence(failed, [failed, other])).toBe("failed");
  });
});
