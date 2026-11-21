import type { PluginCheckState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  attemptLabel,
  checkTone,
  hasPlanFooter,
  outcomeLabel,
  outcomeTone,
  isDraftPlan,
  phaseStatus,
  phasesByWave,
  planSummary,
  runStepTrailing,
  runSummary,
  settledReason,
  tierLabel,
  toneClassName,
} from "./dispatchCards.logic";

const phase = (id: string, wave: number) => ({
  id,
  name: `Phase ${id}`,
  wave,
  tier: "standard",
  status: "pending",
  risk: false,
});

describe("phasesByWave", () => {
  it("returns no groups for no phases", () => {
    expect(phasesByWave([])).toEqual([]);
  });

  it("groups by wave in ascending numeric order, not input or lexical order", () => {
    const groups = phasesByWave([phase("5", 10), phase("1", 2), phase("2", 2), phase("3", 1)]);
    expect(groups.map((group) => group.wave)).toEqual([1, 2, 10]);
    expect(groups.map((group) => group.phases.map((item) => item.id))).toEqual([
      ["3"],
      ["1", "2"],
      ["5"],
    ]);
  });

  it("orders phases inside a wave by id, numerically where ids are numbers", () => {
    const groups = phasesByWave([phase("10", 1), phase("2", 1), phase("1", 1)]);
    expect(groups[0]?.phases.map((item) => item.id)).toEqual(["1", "2", "10"]);
  });

  it("keeps duplicate ids rather than dropping them", () => {
    const groups = phasesByWave([phase("1", 1), phase("1", 1)]);
    expect(groups[0]?.phases).toHaveLength(2);
  });

  it("does not reorder the caller's array", () => {
    const input = [phase("2", 2), phase("1", 1)];
    phasesByWave(input);
    expect(input.map((item) => item.id)).toEqual(["2", "1"]);
  });
});

describe("planSummary", () => {
  it.each([
    [[], "No phases yet"],
    [[phase("1", 1)], "1 phase in 1 wave"],
    [[phase("1", 1), phase("2", 1)], "2 phases in 1 wave"],
    [[phase("1", 1), phase("2", 2), phase("3", 2)], "3 phases in 2 waves"],
  ])("describes %j as %s", (phases, expected) => {
    expect(planSummary({ phases })).toBe(expected);
  });
});

describe("checkTone", () => {
  it.each<[PluginCheckState, string, string, string]>([
    ["pass", "check", "success", "Pass"],
    ["fail", "x", "destructive", "Fail"],
    ["stale", "history", "warning", "Stale"],
    ["running", "dashed", "muted", "Running"],
    ["pending", "circle", "muted", "Pending"],
    ["skipped", "minus", "muted", "Skipped"],
  ])("maps %s to icon %s, tone %s and label %s", (state, icon, tone, label) => {
    expect(checkTone(state)).toEqual({ icon, tone, label });
  });
});

describe("runSummary", () => {
  const base = (done: number, total: number, costUsd: number | null) => ({
    phases: Array.from({ length: total }, (_, index) => ({
      id: String(index + 1),
      name: `P${index + 1}`,
      state: index < done ? ("done" as const) : ("pending" as const),
      attempt: null,
    })),
    phasesTotal: total,
    costUsd,
  });

  it("counts only done phases against the total", () => {
    expect(runSummary(base(2, 5, null))).toBe("2 of 5 phases");
  });

  it("does not count failed, running or stale phases as done", () => {
    const data = base(0, 4, null);
    const states = ["done", "failed", "running", "stale"] as const;
    expect(
      runSummary({
        ...data,
        phases: data.phases.map((item, i) => ({ ...item, state: states[i]! })),
      }),
    ).toBe("1 of 4 phases");
  });

  it("uses the singular for one phase", () => {
    expect(runSummary(base(0, 1, null))).toBe("0 of 1 phase");
  });

  it("appends the cost with two decimals and no approximation prefix when known", () => {
    expect(runSummary(base(2, 5, 1.5))).toBe("2 of 5 phases · $1.50");
  });

  it("shows a known zero cost rather than hiding it", () => {
    expect(runSummary(base(0, 2, 0))).toBe("0 of 2 phases · $0.00");
  });

  it("takes the total from phasesTotal, not the listed phases", () => {
    const data = base(1, 2, null);
    expect(runSummary({ ...data, phasesTotal: 6 })).toBe("1 of 6 phases");
  });
});

describe("outcomeLabel and outcomeTone", () => {
  it.each([
    ["running", "Running", "muted"],
    ["passed", "Passed", "success"],
    ["failed", "Failed", "destructive"],
    ["aborted", "Aborted", "warning"],
  ] as const)("maps %s to %s in tone %s", (outcome, label, tone) => {
    expect(outcomeLabel(outcome)).toBe(label);
    expect(outcomeTone(outcome)).toBe(tone);
  });

  it("reads an outcome the card does not know as Aborted, never Running", () => {
    expect(outcomeLabel("unknown" as never)).toBe("Aborted");
    expect(outcomeTone("unknown" as never)).toBe("warning");
  });
});

describe("settledReason", () => {
  it("is hidden while the run is running, even when a reason is present", () => {
    expect(settledReason({ outcome: "running", reason: "stale note" })).toBeNull();
  });

  it.each(["passed", "failed", "aborted"] as const)("shows the reason once %s", (outcome) => {
    expect(settledReason({ outcome, reason: "dp reported no outcome" })).toBe(
      "dp reported no outcome",
    );
  });

  it("shows the server's reason for an unrecognised outcome", () => {
    expect(settledReason({ outcome: "unknown" as never, reason: "dp reported no outcome" })).toBe(
      "dp reported no outcome",
    );
  });

  it.each([null, "", "   "])("draws nothing for the empty reason %j", (reason) => {
    expect(settledReason({ outcome: "failed", reason })).toBeNull();
  });
});

describe("attemptLabel", () => {
  it.each([
    [null, null],
    [0, null],
    [1, null],
    [2, "attempt 2"],
    [10, "attempt 10"],
  ])("labels attempt %j as %j", (attempt, expected) => {
    expect(attemptLabel(attempt)).toBe(expected);
  });
});

describe("hasPlanFooter", () => {
  const action = (id: string) => ({
    id,
    label: id,
    type: "message" as const,
    message: id,
  });

  it("is false with no actions", () => {
    expect(hasPlanFooter({ actions: [] })).toBe(false);
  });

  it("is false when only unrelated actions exist", () => {
    expect(hasPlanFooter({ actions: [action("rerun")] })).toBe(false);
  });

  it.each(["approve", "request-changes"])("is true with only %s", (id) => {
    expect(hasPlanFooter({ actions: [action(id)] })).toBe(true);
  });
});

describe("phaseStatus", () => {
  it.each([
    ["pending", "circle", "muted", "Pending"],
    ["running", "dashed", "muted", "Running"],
    ["done", "check", "success", "Done"],
    ["failed", "x", "destructive", "Failed"],
    ["blocked", "minus", "muted", "blocked"],
  ] as const)("maps %s to icon %s, tone %s and label %s", (status, icon, tone, label) => {
    expect(phaseStatus(status)).toEqual({ icon, tone, label });
  });

  it("says pending the way the verify card does", () => {
    expect(phaseStatus("pending")).toEqual(checkTone("pending"));
  });
});

describe("tierLabel", () => {
  it.each([
    ["light", "Light"],
    ["standard", "Standard"],
    ["heavy", "Heavy"],
  ])("shows the dp tier %s as %s", (tier, label) => {
    expect(tierLabel(tier)).toBe(label);
  });
});

describe("isDraftPlan", () => {
  it("is true only for a draft plan", () => {
    expect(isDraftPlan({ status: "draft" })).toBe(true);
    expect(isDraftPlan({ status: "executing" })).toBe(false);
  });
});

describe("runStepTrailing", () => {
  it.each([
    ["done", null, null],
    ["stale", null, "no heartbeat"],
    ["running", 2, "attempt 2"],
    ["stale", 3, "no heartbeat · attempt 3"],
  ] as const)("reads a %s step on attempt %s as %s", (state, attempt, expected) => {
    expect(runStepTrailing({ state, attempt })).toBe(expected);
  });
});

describe("toneClassName", () => {
  it("shows success in the same green as the livecheck verdict", () => {
    expect(toneClassName("success")).toBe("text-success-foreground");
  });
});
