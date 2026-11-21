import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";

/** Format `${kind}:${key}`; the source picks the key. */
export const PluginCardId = TrimmedNonEmptyString;
export type PluginCardId = typeof PluginCardId.Type;

export const PluginCardKind = Schema.Literals([
  "dispatch.decision",
  "dispatch.plan",
  "dispatch.verify",
  "dispatch.runProgress",
  "livecheck.result",
  "livecheck.progress",
  "iter8.round",
  "gitty.push",
  "gitty.conflict",
]);
export type PluginCardKind = typeof PluginCardKind.Type;

export const PluginStepState = Schema.Literals(["done", "running", "failed", "pending", "stale"]);
export type PluginStepState = typeof PluginStepState.Type;

export const PluginCheckState = Schema.Literals([
  "pass",
  "fail",
  "stale",
  "running",
  "pending",
  "skipped",
]);
export type PluginCheckState = typeof PluginCheckState.Type;

export const PluginCardErrorReason = Schema.Literals([
  "unknown-card",
  "unknown-option",
  "unknown-action",
  "unknown-asset",
  "decision-closed",
  "not-this-chat",
  "terminal-only",
  "answer-in-progress",
  "dp-missing",
  "dp-failed",
  "message-not-in-transcript",
  "chat-quote-invalid",
  "protected-decision",
  "source-failed",
  "unavailable",
]);
export type PluginCardErrorReason = typeof PluginCardErrorReason.Type;

const PLUGIN_CARD_ERROR_MESSAGES = {
  "unknown-card": "This card is no longer in the chat.",
  "unknown-option": "That option is not part of this decision.",
  "unknown-action": "That action is not available on this card.",
  "unknown-asset": "That image is not available on this card.",
  "decision-closed": "This decision was already answered or closed.",
  "not-this-chat": "This decision belongs to a different chat.",
  "terminal-only": "This decision can only be answered from a terminal.",
  "answer-in-progress": "This decision is already being answered.",
  "dp-missing": "The tool for recording answers is missing on this machine.",
  "dp-failed": "Couldn't record your answer.",
  "message-not-in-transcript": "The answer message has not reached the chat transcript yet.",
  "chat-quote-invalid": "The answer message could not be quoted from the chat transcript.",
  "protected-decision": "This decision is protected and cannot be answered from here.",
  "source-failed": "The plugin data for this card could not be read.",
  unavailable: "Plugin cards are not available on this server.",
} as const satisfies Record<PluginCardErrorReason, string>;

export class PluginCardError extends Schema.TaggedError<PluginCardError>()("PluginCardError", {
  reason: PluginCardErrorReason,
  detail: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    const base = PLUGIN_CARD_ERROR_MESSAGES[this.reason];
    return this.reason === "dp-failed" || this.detail === undefined || this.detail === ""
      ? base
      : `${base} ${this.detail}`;
  }
}

export const PluginCardPlacement = Schema.Union([
  Schema.Struct({ type: Schema.Literal("turnItem"), turnItemId: TurnItemId }),
  Schema.Struct({ type: Schema.Literal("time"), at: IsoDateTime }),
]);
export type PluginCardPlacement = typeof PluginCardPlacement.Type;

export const PluginCardAction = Schema.Union([
  Schema.Struct({
    id: Schema.String,
    label: Schema.String,
    type: Schema.Literal("message"),
    message: Schema.String,
  }),
  Schema.Struct({
    id: Schema.String,
    label: Schema.String,
    type: Schema.Literal("command"),
  }),
]);
export type PluginCardAction = typeof PluginCardAction.Type;

const cardBase = {
  id: PluginCardId,
  threadId: ThreadId,
  placement: PluginCardPlacement,
  updatedAt: IsoDateTime,
  actions: Schema.Array(PluginCardAction),
};

export const PluginDecisionAnswerProgress = Schema.Struct({
  optionKey: Schema.String,
  status: Schema.Literals(["posting", "recording", "failed"]),
  reason: Schema.NullOr(PluginCardErrorReason),
  detail: Schema.NullOr(Schema.String),
});
export type PluginDecisionAnswerProgress = typeof PluginDecisionAnswerProgress.Type;

export const DispatchDecisionCardData = Schema.Struct({
  decisionId: Schema.String,
  dir: Schema.String,
  decisionKind: Schema.String,
  question: Schema.String,
  options: Schema.Array(
    Schema.Struct({ key: Schema.String, label: Schema.String, recommended: Schema.Boolean }),
  ),
  defaultKey: Schema.NullOr(Schema.String),
  state: Schema.Literals(["open", "answered", "defaulted", "superseded"]),
  choice: Schema.NullOr(Schema.String),
  chosenBy: Schema.NullOr(Schema.String),
  chosenVia: Schema.NullOr(Schema.String),
  raisedAt: IsoDateTime,
  applyAfter: Schema.NullOr(IsoDateTime),
  resolvedAt: Schema.NullOr(IsoDateTime),
  needsPerson: Schema.Boolean,
  protection: Schema.NullOr(Schema.Literals(["outward", "always-ask"])),
  initiative: Schema.NullOr(Schema.String),
  part: Schema.String,
  wave: Schema.Number,
  phase: Schema.NullOr(Schema.String),
  answerable: Schema.Literals(["yes", "terminal-only"]),
  answer: Schema.NullOr(PluginDecisionAnswerProgress),
});
export type DispatchDecisionCardData = typeof DispatchDecisionCardData.Type;
export const DispatchDecisionCard = Schema.Struct({
  ...cardBase,
  kind: Schema.Literal("dispatch.decision"),
  data: DispatchDecisionCardData,
});
export type DispatchDecisionCard = typeof DispatchDecisionCard.Type;

export const DispatchPlanCardData = Schema.Struct({
  task: Schema.String,
  specPath: Schema.String,
  dir: Schema.String,
  status: Schema.String,
  wave: Schema.Struct({ current: Schema.Number, total: Schema.Number }),
  phases: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      wave: Schema.Number,
      tier: Schema.String,
      status: Schema.String,
      risk: Schema.Boolean,
    }),
  ),
  initiative: Schema.NullOr(Schema.String),
  part: Schema.NullOr(Schema.String),
});
export type DispatchPlanCardData = typeof DispatchPlanCardData.Type;
export const DispatchPlanCard = Schema.Struct({
  ...cardBase,
  kind: Schema.Literal("dispatch.plan"),
  data: DispatchPlanCardData,
});
export type DispatchPlanCard = typeof DispatchPlanCard.Type;

export const DispatchVerifyCardData = Schema.Struct({
  task: Schema.String,
  specPath: Schema.String,
  dir: Schema.String,
  revision: Schema.NullOr(Schema.String),
  checks: Schema.Array(
    Schema.Struct({ name: Schema.String, summary: Schema.String, state: PluginCheckState }),
  ),
});
export type DispatchVerifyCardData = typeof DispatchVerifyCardData.Type;
export const DispatchVerifyCard = Schema.Struct({
  ...cardBase,
  kind: Schema.Literal("dispatch.verify"),
  data: DispatchVerifyCardData,
});
export type DispatchVerifyCard = typeof DispatchVerifyCard.Type;

export const DispatchRunProgressCardData = Schema.Struct({
  runId: Schema.String,
  dir: Schema.String,
  part: Schema.String,
  wave: Schema.Number,
  initiative: Schema.NullOr(Schema.String),
  spec: Schema.String,
  outcome: Schema.Literals(["running", "passed", "failed", "aborted"]),
  reason: Schema.NullOr(Schema.String),
  phases: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      state: PluginStepState,
      attempt: Schema.NullOr(Schema.Number),
    }),
  ),
  phasesTotal: Schema.Number,
  startedAt: IsoDateTime,
  settledAt: Schema.NullOr(IsoDateTime),
  costUsd: Schema.NullOr(Schema.Number),
});
export type DispatchRunProgressCardData = typeof DispatchRunProgressCardData.Type;
export const DispatchRunProgressCard = Schema.Struct({
  ...cardBase,
  kind: Schema.Literal("dispatch.runProgress"),
  data: DispatchRunProgressCardData,
});
export type DispatchRunProgressCard = typeof DispatchRunProgressCard.Type;

export const LivecheckResultCardData = Schema.Struct({
  runId: Schema.String,
  runDir: Schema.String,
  target: Schema.String,
  verdict: Schema.Literals(["pass", "fail", "blocked", "error"]),
  summary: Schema.String,
  judge: Schema.NullOr(Schema.String),
  steps: Schema.Array(
    Schema.Struct({
      index: Schema.Number,
      label: Schema.String,
      state: PluginStepState,
      assetId: Schema.NullOr(Schema.String),
    }),
  ),
  failedStepIndex: Schema.NullOr(Schema.Number),
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type LivecheckResultCardData = typeof LivecheckResultCardData.Type;
export const LivecheckResultCard = Schema.Struct({
  ...cardBase,
  kind: Schema.Literal("livecheck.result"),
  data: LivecheckResultCardData,
});
export type LivecheckResultCard = typeof LivecheckResultCard.Type;

export const LivecheckProgressCardData = Schema.Struct({
  runId: Schema.String,
  runDir: Schema.String,
  target: Schema.String,
  steps: Schema.Array(
    Schema.Struct({
      index: Schema.Number,
      label: Schema.String,
      state: PluginStepState,
      durationMs: Schema.NullOr(Schema.Number),
    }),
  ),
  currentStep: Schema.NullOr(Schema.Number),
  totalSteps: Schema.Number,
  heartbeatAt: Schema.NullOr(IsoDateTime),
  latestAssetId: Schema.NullOr(Schema.String),
});
export type LivecheckProgressCardData = typeof LivecheckProgressCardData.Type;
export const LivecheckProgressCard = Schema.Struct({
  ...cardBase,
  kind: Schema.Literal("livecheck.progress"),
  data: LivecheckProgressCardData,
});
export type LivecheckProgressCard = typeof LivecheckProgressCard.Type;

export const Iter8RoundCardData = Schema.Struct({
  round: Schema.Number,
  page: Schema.String,
  pagePath: Schema.NullOr(Schema.String),
  notes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      text: Schema.String,
      state: Schema.Literals(["open", "resolved"]),
      author: Schema.NullOr(Schema.String),
      anchor: Schema.NullOr(Schema.String),
    }),
  ),
});
export type Iter8RoundCardData = typeof Iter8RoundCardData.Type;
export const Iter8RoundCard = Schema.Struct({
  ...cardBase,
  kind: Schema.Literal("iter8.round"),
  data: Iter8RoundCardData,
});
export type Iter8RoundCard = typeof Iter8RoundCard.Type;

export const GittyPushCardData = Schema.Struct({
  branch: Schema.String,
  batches: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      state: PluginStepState,
      commit: Schema.NullOr(Schema.String),
    }),
  ),
  mergeRequest: Schema.NullOr(
    Schema.Struct({
      url: Schema.NullOr(Schema.String),
      number: Schema.NullOr(Schema.Number),
      draft: Schema.Boolean,
      additions: Schema.NullOr(Schema.Number),
      deletions: Schema.NullOr(Schema.Number),
      pipeline: Schema.Literals(["none", "running", "passed", "failed"]),
    }),
  ),
});
export type GittyPushCardData = typeof GittyPushCardData.Type;
export const GittyPushCard = Schema.Struct({
  ...cardBase,
  kind: Schema.Literal("gitty.push"),
  data: GittyPushCardData,
});
export type GittyPushCard = typeof GittyPushCard.Type;

export const GittyConflictCardData = Schema.Struct({
  file: Schema.String,
  base: Schema.NullOr(Schema.String),
  sides: Schema.Array(Schema.Struct({ label: Schema.String, summary: Schema.String })),
  resolutions: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      label: Schema.String,
      predictedOutcome: Schema.String,
    }),
  ),
});
export type GittyConflictCardData = typeof GittyConflictCardData.Type;
export const GittyConflictCard = Schema.Struct({
  ...cardBase,
  kind: Schema.Literal("gitty.conflict"),
  data: GittyConflictCardData,
});
export type GittyConflictCard = typeof GittyConflictCard.Type;

export const PluginCard = Schema.Union([
  DispatchDecisionCard,
  DispatchPlanCard,
  DispatchVerifyCard,
  DispatchRunProgressCard,
  LivecheckResultCard,
  LivecheckProgressCard,
  Iter8RoundCard,
  GittyPushCard,
  GittyConflictCard,
]);
export type PluginCard = typeof PluginCard.Type;

export const PluginThreadCards = Schema.Struct({
  threadId: ThreadId,
  cards: Schema.Array(PluginCard),
});
export type PluginThreadCards = typeof PluginThreadCards.Type;

export const PluginLiveInitiative = Schema.Struct({
  slug: Schema.String,
  title: Schema.NullOr(Schema.String),
  closed: Schema.Boolean,
  wave: Schema.Struct({
    current: Schema.Number,
    total: Schema.Number,
    partsSettled: Schema.Number,
    partsTotal: Schema.Number,
  }),
  settled: Schema.Struct({ count: Schema.Number, total: Schema.Number }),
  running: Schema.Number,
  openDecisions: Schema.Number,
  spend: Schema.Struct({
    usd: Schema.NullOr(Schema.Number),
    state: Schema.Literals(["exact", "estimated", "incomplete", "unknown"]),
  }),
  orchestratorThreadId: Schema.NullOr(ThreadId),
  asOf: IsoDateTime,
  parts: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.NullOr(Schema.String),
      wave: Schema.Number,
      status: Schema.String,
      threadIds: Schema.Array(ThreadId),
    }),
  ),
});
export type PluginLiveInitiative = typeof PluginLiveInitiative.Type;

export const PluginLiveChild = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["run", "child"]),
  initiative: Schema.NullOr(Schema.String),
  part: Schema.String,
  wave: Schema.Number,
  phase: Schema.NullOr(Schema.String),
  state: Schema.Literals(["running", "settled", "failed", "aborted"]),
  threadId: Schema.NullOr(ThreadId),
  dir: Schema.String,
  startedAt: Schema.NullOr(IsoDateTime),
  updatedAt: Schema.NullOr(IsoDateTime),
  costUsd: Schema.NullOr(Schema.Number),
});
export type PluginLiveChild = typeof PluginLiveChild.Type;

export const PluginLiveDecision = Schema.Struct({
  cardId: PluginCardId,
  decisionId: Schema.String,
  dir: Schema.String,
  kind: Schema.String,
  question: Schema.String,
  initiative: Schema.NullOr(Schema.String),
  part: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  needsPerson: Schema.Boolean,
  raisedAt: IsoDateTime,
  applyAfter: Schema.NullOr(IsoDateTime),
});
export type PluginLiveDecision = typeof PluginLiveDecision.Type;

export const PluginLiveState = Schema.Struct({
  asOf: IsoDateTime,
  initiatives: Schema.Array(PluginLiveInitiative),
  children: Schema.Array(PluginLiveChild),
  decisions: Schema.Array(PluginLiveDecision),
  waitingThreadIds: Schema.Array(ThreadId),
});
export type PluginLiveState = typeof PluginLiveState.Type;

export const PluginCardsThreadInput = Schema.Struct({ threadId: ThreadId });
export type PluginCardsThreadInput = typeof PluginCardsThreadInput.Type;

export const PluginDecisionAnswerInput = Schema.Struct({
  threadId: ThreadId,
  cardId: PluginCardId,
  optionKey: Schema.String,
});
export type PluginDecisionAnswerInput = typeof PluginDecisionAnswerInput.Type;

/** `reused`: the earlier posted message is quoted again instead of posting a second one. */
export const PluginDecisionAnswerResult = Schema.Struct({
  delivery: Schema.Literals(["started", "queued", "reused"]),
});
export type PluginDecisionAnswerResult = typeof PluginDecisionAnswerResult.Type;

export const PluginCardActionInput = Schema.Struct({
  threadId: ThreadId,
  cardId: PluginCardId,
  actionId: Schema.String,
});
export type PluginCardActionInput = typeof PluginCardActionInput.Type;

export const PluginCardAssetInput = Schema.Struct({
  threadId: ThreadId,
  cardId: PluginCardId,
  assetId: Schema.String,
});
export type PluginCardAssetInput = typeof PluginCardAssetInput.Type;

/** The wire is JSON, so the bytes travel as base64; the server caps them at 4 MiB. */
export const PluginCardAsset = Schema.Struct({
  mediaType: Schema.String,
  bytes: Schema.Uint8ArrayFromBase64,
});
export type PluginCardAsset = typeof PluginCardAsset.Type;
