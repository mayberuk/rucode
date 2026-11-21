import type {
  DispatchPlanCardData,
  DispatchRunProgressCardData,
  PluginCardAction,
  PluginCheckState,
} from "@t3tools/contracts";
import { formatUsd } from "@t3tools/shared/usageFormat";

import { cardAction, countLabel } from "./shared/cardFormat.logic";

type PlanPhase = DispatchPlanCardData["phases"][number];

export type CardTone = "success" | "destructive" | "warning" | "muted";
export type CheckIconName = "check" | "x" | "history" | "dashed" | "circle" | "minus";

const compareIds = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

export function phasesByWave(
  phases: ReadonlyArray<PlanPhase>,
): ReadonlyArray<{ wave: number; phases: ReadonlyArray<PlanPhase> }> {
  const byWave = new Map<number, PlanPhase[]>();
  for (const phase of phases) {
    const group = byWave.get(phase.wave);
    if (group) group.push(phase);
    else byWave.set(phase.wave, [phase]);
  }
  return [...byWave.entries()]
    .toSorted(([a], [b]) => a - b)
    .map(([wave, group]) => ({
      wave,
      phases: group.toSorted((a, b) => compareIds(a.id, b.id)),
    }));
}

export function planSummary(data: { readonly phases: ReadonlyArray<PlanPhase> }): string {
  if (data.phases.length === 0) return "No phases yet";
  const waves = new Set(data.phases.map((phase) => phase.wave)).size;
  return `${countLabel(data.phases.length, "phase", "phases")} in ${countLabel(waves, "wave", "waves")}`;
}

export function tierLabel(tier: string): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

export function isDraftPlan(data: { readonly status: string }): boolean {
  return data.status === "draft";
}

export function phaseStatus(status: string): {
  icon: CheckIconName;
  tone: CardTone;
  label: string;
} {
  switch (status) {
    case "done":
    case "complete":
      return { icon: "check", tone: "success", label: "Done" };
    case "failed":
      return { icon: "x", tone: "destructive", label: "Failed" };
    case "running":
    case "executing":
      return checkTone("running");
    case "pending":
      return checkTone("pending");
    default:
      return { icon: "minus", tone: "muted", label: status };
  }
}

export function hasPlanFooter(card: {
  readonly actions: ReadonlyArray<PluginCardAction>;
}): boolean {
  return cardAction(card, "request-changes") !== null || cardAction(card, "approve") !== null;
}

export function checkTone(state: PluginCheckState): {
  icon: CheckIconName;
  tone: CardTone;
  label: string;
} {
  switch (state) {
    case "pass":
      return { icon: "check", tone: "success", label: "Pass" };
    case "fail":
      return { icon: "x", tone: "destructive", label: "Fail" };
    case "stale":
      return { icon: "history", tone: "warning", label: "Stale" };
    case "running":
      return { icon: "dashed", tone: "muted", label: "Running" };
    case "pending":
      return { icon: "circle", tone: "muted", label: "Pending" };
    case "skipped":
      return { icon: "minus", tone: "muted", label: "Skipped" };
  }
}

export function runSummary(
  data: Pick<DispatchRunProgressCardData, "phases" | "phasesTotal" | "costUsd">,
): string {
  const done = data.phases.filter((phase) => phase.state === "done").length;
  const progress = `${done} of ${countLabel(data.phasesTotal, "phase", "phases")}`;
  return data.costUsd === null ? progress : `${progress} · ${formatUsd(data.costUsd)}`;
}

type RunOutcome = DispatchRunProgressCardData["outcome"];

// A card with an outcome this build does not know reads as Aborted: showing Running would
// hide a run that has already ended.
export function outcomeLabel(outcome: RunOutcome): string {
  switch (outcome) {
    case "running":
      return "Running";
    case "passed":
      return "Passed";
    case "failed":
      return "Failed";
    default:
      return "Aborted";
  }
}

export function outcomeTone(outcome: RunOutcome): CardTone {
  switch (outcome) {
    case "running":
      return "muted";
    case "passed":
      return "success";
    case "failed":
      return "destructive";
    default:
      return "warning";
  }
}

export function settledReason(
  data: Pick<DispatchRunProgressCardData, "outcome" | "reason">,
): string | null {
  if (data.outcome === "running") return null;
  const reason = data.reason?.trim() ?? "";
  return reason === "" ? null : reason;
}

export function attemptLabel(attempt: number | null): string | null {
  return attempt !== null && attempt > 1 ? `attempt ${attempt}` : null;
}

export function runStepTrailing(
  phase: Pick<DispatchRunProgressCardData["phases"][number], "state" | "attempt">,
): string | null {
  const parts = [phase.state === "stale" ? "no heartbeat" : null, attemptLabel(phase.attempt)];
  const label = parts.filter((part) => part !== null).join(" · ");
  return label === "" ? null : label;
}

export function toneClassName(tone: CardTone): string {
  switch (tone) {
    case "destructive":
      return "text-destructive-foreground";
    case "warning":
      return "text-warning-foreground";
    case "success":
      return "text-success-foreground";
    case "muted":
      return "text-secondary-label";
  }
}
