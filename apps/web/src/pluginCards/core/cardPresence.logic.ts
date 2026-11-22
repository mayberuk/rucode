import type { DispatchRunProgressCardData, PluginCard, PluginCheckState } from "@t3tools/contracts";

import {
  hasPlanFooter,
  isDraftPlan,
  outcomeLabel,
  outcomeTone,
  phaseStatus,
  planSummary,
  runSummary,
  tierLabel,
  type CardTone,
} from "../cards/dispatchCards.logic";
import { pipelineLabel, pushSummary } from "../cards/iter8GittyCards.logic";
import { progressMeta, verdictPresentation } from "../cards/livecheckCards.logic";
import { countLabel } from "../cards/shared/cardFormat.logic";
import { decisionLine, decisionWaitsOnPerson } from "../decision/decisionPanel.logic";

export type CardPresence = "needs-you" | "failed" | "background";

function startedMs(data: Pick<DispatchRunProgressCardData, "startedAt">): number {
  const ms = Date.parse(data.startedAt);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

function passedLater(run: DispatchRunProgressCardData, cards: ReadonlyArray<PluginCard>): boolean {
  return cards.some(
    (other) =>
      other.kind === "dispatch.runProgress" &&
      other.data.outcome === "passed" &&
      other.data.initiative === run.initiative &&
      other.data.part === run.part &&
      other.data.wave >= run.wave &&
      startedMs(other.data) > startedMs(run),
  );
}

/** `cards` is the chat's whole snapshot, so a failed run a later run of its part passed reads settled. */
export function cardPresence(card: PluginCard, cards: ReadonlyArray<PluginCard>): CardPresence {
  switch (card.kind) {
    case "dispatch.decision":
      return card.data.state === "open" && decisionWaitsOnPerson(card.data)
        ? "needs-you"
        : "background";
    case "dispatch.plan":
      return hasPlanFooter(card) ? "needs-you" : "background";
    case "gitty.conflict":
      return card.data.resolutions.length > 0 ? "needs-you" : "background";
    case "dispatch.runProgress":
      return card.data.outcome !== "running" &&
        card.data.outcome !== "passed" &&
        !passedLater(card.data, cards)
        ? "failed"
        : "background";
    case "dispatch.verify":
      return card.data.checks.some((check) => check.state === "fail") ? "failed" : "background";
    case "livecheck.result":
      return card.data.verdict === "pass" ? "background" : "failed";
    case "gitty.push":
      return card.data.batches.some((batch) => batch.state === "failed") ||
        card.data.mergeRequest?.pipeline === "failed"
        ? "failed"
        : "background";
    case "livecheck.progress":
    case "iter8.round":
      return "background";
  }
}

/** Decisions are always a line: the drawer is where they are answered. */
export function cardRendersAsLine(card: PluginCard, presence: CardPresence): boolean {
  return card.kind === "dispatch.decision" || presence === "background";
}

interface CardOutcome {
  readonly label: string;
  readonly tone: CardTone;
}

interface CardSummary {
  readonly label: string;
  readonly outcome: CardOutcome | null;
}

function verifyOutcome(
  checks: ReadonlyArray<{ readonly state: PluginCheckState }>,
): CardOutcome | null {
  if (checks.length === 0) return null;
  const states = new Set(checks.map((check) => check.state));
  if (states.has("fail")) return { label: "Failed", tone: "destructive" };
  if (states.has("running") || states.has("pending")) return { label: "Running", tone: "muted" };
  if (states.has("stale")) return { label: "Stale", tone: "warning" };
  return { label: "Passed", tone: "success" };
}

/** `formatTime` renders a clock time such as "11:52" for decision deadlines. */
export function cardSummary(card: PluginCard, formatTime: (iso: string) => string): CardSummary {
  switch (card.kind) {
    case "dispatch.decision":
      return { label: decisionLine(card.data, formatTime), outcome: null };
    case "dispatch.plan": {
      const status = phaseStatus(card.data.status);
      return {
        label: `Plan · ${card.data.task} · ${planSummary(card.data)}`,
        outcome: isDraftPlan(card.data)
          ? null
          : { label: tierLabel(status.label), tone: status.tone },
      };
    }
    case "dispatch.runProgress":
      return {
        label: `Run · ${card.data.part} · wave ${card.data.wave} · ${runSummary(card.data)}`,
        outcome: { label: outcomeLabel(card.data.outcome), tone: outcomeTone(card.data.outcome) },
      };
    case "dispatch.verify":
      return {
        label: `Verify · ${card.data.task} · ${countLabel(card.data.checks.length, "check", "checks")}`,
        outcome: verifyOutcome(card.data.checks),
      };
    case "livecheck.result": {
      const verdict = verdictPresentation(card.data.verdict);
      return {
        label: `Live check · ${card.data.target}`,
        outcome: { label: verdict.label, tone: verdict.tone },
      };
    }
    case "livecheck.progress": {
      const meta = progressMeta(card.data);
      return {
        label: `Checking ${card.data.target}${meta === null ? "" : ` · ${meta}`}`,
        outcome: { label: "Running", tone: "muted" },
      };
    }
    case "iter8.round":
      return {
        label: `Round ${card.data.round} · ${
          card.data.notes.length === 0
            ? "No notes yet"
            : countLabel(card.data.notes.length, "note", "notes")
        }`,
        outcome: null,
      };
    case "gitty.push": {
      const summary = pushSummary(card.data);
      const pipeline = card.data.mergeRequest?.pipeline ?? "none";
      const failedBatch = card.data.batches.some((batch) => batch.state === "failed");
      const pipelineText = pipelineLabel(pipeline);
      return {
        label: `${summary.verb} ${card.data.branch} · ${summary.label}`,
        outcome: failedBatch
          ? { label: "Failed", tone: "destructive" }
          : pipelineText === null
            ? null
            : {
                label: pipelineText,
                tone:
                  pipeline === "failed"
                    ? "destructive"
                    : pipeline === "passed"
                      ? "success"
                      : "muted",
              },
      };
    }
    case "gitty.conflict":
      return { label: `Merge conflict · ${card.data.file}`, outcome: null };
  }
}
