import {
  PluginCardError,
  type DispatchDecisionCard,
  type DispatchDecisionCardData,
  type PluginThreadCards,
  type ThreadId,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";

const NO_DECISIONS: ReadonlyArray<DispatchDecisionCard> = [];

export function openDecisionsForThread(
  snapshot: PluginThreadCards | null,
  threadId: ThreadId,
): ReadonlyArray<DispatchDecisionCard> {
  if (snapshot === null) return NO_DECISIONS;
  const open = snapshot.cards.filter(
    (card): card is DispatchDecisionCard =>
      card.kind === "dispatch.decision" && card.data.state === "open" && card.threadId === threadId,
  );
  return open.length === 0 ? NO_DECISIONS : open;
}

/** This client's own answer request, kept apart from the progress the server reports on the card. */
export type DecisionAnswerAttempt =
  | { readonly status: "sending"; readonly optionKey: string }
  | {
      readonly status: "sent";
      readonly optionKey: string;
      readonly cardAtSend: DispatchDecisionCard;
      readonly reusedRetryDeadline: number | null;
    }
  | { readonly status: "reported"; readonly optionKey: string }
  | {
      readonly status: "failed";
      readonly optionKey: string;
      readonly message: string;
      readonly cardAtSend: DispatchDecisionCard;
    };

export type DecisionAnswerView =
  | { readonly status: "idle" }
  | { readonly status: "posting" | "recording"; readonly optionKey: string }
  | { readonly status: "failed"; readonly optionKey: string; readonly message: string };

export function decisionAnswerView(
  card: DispatchDecisionCard,
  attempt: DecisionAnswerAttempt | null,
  reusedRetryDeadlinePassed = false,
): DecisionAnswerView {
  if (card.data.state !== "open") return { status: "idle" };
  const progress = card.data.answer;
  if (progress !== null && progress.status !== "failed") {
    return { status: progress.status, optionKey: progress.optionKey };
  }
  if (attempt?.status === "sending") return { status: "posting", optionKey: attempt.optionKey };
  if (attempt?.status === "failed" && Equal.equals(card, attempt.cardAtSend)) {
    return { status: "failed", optionKey: attempt.optionKey, message: attempt.message };
  }
  if (
    attempt?.status === "sent" &&
    Equal.equals(card, attempt.cardAtSend) &&
    !(progress?.status === "failed" && reusedRetryDeadlinePassed)
  ) {
    return { status: "recording", optionKey: attempt.optionKey };
  }
  if (progress?.status === "failed") {
    return {
      status: "failed",
      optionKey: progress.optionKey,
      message:
        progress.reason === null
          ? "Couldn't record your answer."
          : new PluginCardError({ reason: progress.reason }).message,
    };
  }
  if (attempt?.status === "sent" || attempt?.status === "reported") {
    return {
      status: "failed",
      optionKey: attempt.optionKey,
      message: "The server is no longer recording this answer.",
    };
  }
  return attempt?.status === "failed"
    ? { status: "failed", optionKey: attempt.optionKey, message: attempt.message }
    : { status: "idle" };
}

const SHELL_SAFE = /^[\w@%+=:,./-]+$/;
const shellQuote = (value: string) =>
  SHELL_SAFE.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

export function decisionAnswerCommand(data: DispatchDecisionCardData, optionKey: string): string {
  return `dp decision answer ${shellQuote(data.decisionId)} ${shellQuote(optionKey)} --dir ${shellQuote(data.dir)} --actor person`;
}

export function decisionContextLabel(data: DispatchDecisionCardData): string {
  return data.initiative === null ? `wave ${data.wave}` : `${data.initiative} · wave ${data.wave}`;
}

type DecisionCourseFields = Pick<
  DispatchDecisionCardData,
  "needsPerson" | "protection" | "defaultKey" | "applyAfter"
>;

/** No default the agent will go with on its own: needs-person, protected, or raised without one. */
export function decisionWaitsOnPerson(data: DecisionCourseFields): boolean {
  return (
    data.needsPerson ||
    data.protection !== null ||
    data.defaultKey === null ||
    data.applyAfter === null
  );
}

function optionLabel(data: DispatchDecisionCardData, key: string): string {
  return data.options.find((option) => option.key === key)?.label ?? key;
}

export type DecisionCourse =
  | {
      readonly type: "default";
      readonly optionLabel: string;
      readonly at: string;
      readonly protectedStop: boolean;
    }
  | { readonly type: "overdue"; readonly optionLabel: string }
  | { readonly type: "recommended"; readonly optionLabel: string }
  | { readonly type: "choose" };

// `dp decision wait` applies the default at applyAfter; a minute's grace covers its polling.
const OVERDUE_GRACE_MS = 60_000;

/** `nowMinute` is a UTC `YYYY-MM-DDTHH:mm`, as `useNowMinute` returns. */
export function decisionCourse(data: DispatchDecisionCardData, nowMinute: string): DecisionCourse {
  if (data.needsPerson || data.defaultKey === null || data.applyAfter === null) {
    const recommended = data.options.find((option) => option.recommended);
    return recommended === undefined
      ? { type: "choose" }
      : { type: "recommended", optionLabel: recommended.label };
  }
  const label = optionLabel(data, data.defaultKey);
  const dueMs = Date.parse(data.applyAfter);
  if (Date.parse(`${nowMinute}Z`) >= dueMs + OVERDUE_GRACE_MS) {
    return { type: "overdue", optionLabel: label };
  }
  return {
    type: "default",
    optionLabel: label,
    at: data.applyAfter,
    protectedStop: data.protection !== null,
  };
}

function isoMs(iso: string | null): number {
  const ms = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

const compareNumbers = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0);

export type DrawerDecisionFields = DecisionCourseFields &
  Pick<DispatchDecisionCardData, "raisedAt">;

/** Drawer order: waiting on the person first, then the soonest default, then the oldest. */
export function compareDrawerDecisions(a: DrawerDecisionFields, b: DrawerDecisionFields): number {
  return (
    compareNumbers(Number(!decisionWaitsOnPerson(a)), Number(!decisionWaitsOnPerson(b))) ||
    compareNumbers(isoMs(a.applyAfter), isoMs(b.applyAfter)) ||
    // Parsed, not compared as text: dp writes nanosecond fractions, so text order misplaces whole seconds.
    compareNumbers(isoMs(a.raisedAt), isoMs(b.raisedAt))
  );
}

/** The decision's one timeline line; `formatTime` renders a clock time such as "11:52". */
export function decisionLine(
  data: DispatchDecisionCardData,
  formatTime: (iso: string) => string,
): string {
  const at = data.applyAfter === null ? "" : ` at ${formatTime(data.applyAfter)}`;
  switch (data.state) {
    case "open":
      if (data.protection !== null && !data.needsPerson) {
        return `Holding off${at} unless you approve`;
      }
      if (data.defaultKey === null || decisionWaitsOnPerson(data)) {
        return `Decision · ${decisionContextLabel(data)} · waiting for you`;
      }
      return `Decision · going with ${optionLabel(data, data.defaultKey)}${at}`;
    case "answered":
    case "defaulted": {
      const who = decisionOutcome(data)?.who ?? null;
      const chosen = data.choice === null ? "an answer" : optionLabel(data, data.choice);
      return who === null ? `Went with ${chosen}` : `Went with ${chosen} · ${who}`;
    }
    case "superseded":
      return "Decision superseded";
  }
}

const CHOOSER_LABELS: Record<string, string> = {
  person: "You",
  agent: "Agent",
  jarvis: "Jarvis",
  default: "Default",
};

export function decisionOutcome(data: DispatchDecisionCardData): {
  readonly headline: string;
  readonly who: string | null;
  readonly at: string | null;
} | null {
  const optionLabel =
    data.choice === null
      ? null
      : (data.options.find((option) => option.key === data.choice)?.label ?? data.choice);
  const who = data.chosenBy === null ? null : (CHOOSER_LABELS[data.chosenBy] ?? data.chosenBy);
  switch (data.state) {
    case "open":
      return null;
    case "answered":
      return { headline: optionLabel ?? "Answered", who, at: data.resolvedAt };
    case "defaulted":
      return {
        headline: optionLabel === null ? "Defaulted" : `Defaulted to ${optionLabel}`,
        who: who ?? "Default",
        at: data.resolvedAt,
      };
    case "superseded":
      return {
        headline: data.chosenBy === null ? "Superseded" : `Superseded by ${data.chosenBy}`,
        who: null,
        at: data.resolvedAt,
      };
  }
}
