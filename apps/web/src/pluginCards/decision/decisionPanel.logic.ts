import {
  PluginCardError,
  type DispatchDecisionCard,
  type DispatchDecisionCardData,
  type PluginThreadCards,
  type ThreadId,
} from "@t3tools/contracts";

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
  | { readonly status: "sent"; readonly optionKey: string }
  | { readonly status: "failed"; readonly optionKey: string; readonly message: string };

export type DecisionAnswerView =
  | { readonly status: "idle" }
  | { readonly status: "posting" | "recording"; readonly optionKey: string }
  | { readonly status: "failed"; readonly optionKey: string; readonly message: string };

export function decisionAnswerView(
  card: DispatchDecisionCard,
  attempt: DecisionAnswerAttempt | null,
  awaitingSnapshot = false,
): DecisionAnswerView {
  if (card.data.state !== "open") return { status: "idle" };
  const progress = card.data.answer;
  if (progress !== null && progress.status !== "failed") {
    return { status: progress.status, optionKey: progress.optionKey };
  }
  if (attempt?.status === "sending") return { status: "posting", optionKey: attempt.optionKey };
  if (awaitingSnapshot) {
    if (attempt?.status === "sent") return { status: "recording", optionKey: attempt.optionKey };
    if (attempt?.status === "failed") return attempt;
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
  if (attempt?.status === "sent") {
    return {
      status: "failed",
      optionKey: attempt.optionKey,
      message: "The server is no longer recording this answer.",
    };
  }
  return attempt?.status === "failed" ? attempt : { status: "idle" };
}

const SHELL_SAFE = /^[\w@%+=:,./-]+$/;
const shellQuote = (value: string) =>
  SHELL_SAFE.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

export function decisionAnswerCommand(data: DispatchDecisionCardData, optionKey: string): string {
  return `dp decision answer ${shellQuote(data.decisionId)} ${shellQuote(optionKey)} --dir ${shellQuote(data.dir)}`;
}

export function decisionContextLabel(data: DispatchDecisionCardData): string {
  return data.initiative === null ? `wave ${data.wave}` : `${data.initiative} · wave ${data.wave}`;
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
