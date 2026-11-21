import { ThreadId, type DispatchDecisionCard } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { decisionAnswerView, type DecisionAnswerAttempt } from "./decisionPanel.logic";

const at = "2026-11-21T09:00:00Z";
const card: DispatchDecisionCard = {
  id: "dispatch.decision:d1",
  threadId: ThreadId.make("thread"),
  kind: "dispatch.decision",
  placement: { type: "time", at },
  updatedAt: at,
  actions: [],
  data: {
    decisionId: "d1",
    dir: "/repo",
    decisionKind: "scope",
    question: "Keep the wave open?",
    options: [{ key: "keep", label: "Keep it open", recommended: false }],
    defaultKey: null,
    state: "open",
    choice: null,
    chosenBy: null,
    chosenVia: null,
    raisedAt: at,
    applyAfter: null,
    resolvedAt: null,
    needsPerson: true,
    protection: null,
    initiative: null,
    part: "ui",
    wave: 3,
    phase: null,
    answerable: "yes",
    answer: null,
  },
};

const sent: DecisionAnswerAttempt = {
  status: "sent",
  optionKey: "keep",
};

it.each(["posting", "recording"] as const)("shows server progress while %s", (status) => {
  expect(
    decisionAnswerView(
      {
        ...card,
        data: { ...card.data, answer: { status, optionKey: "keep", reason: null, detail: null } },
      },
      sent,
    ),
  ).toEqual({ status, optionKey: "keep" });
});

it("offers a retry when the first snapshot after a restart has no answer progress", () => {
  expect(decisionAnswerView(card, sent, true)).toEqual({
    status: "recording",
    optionKey: "keep",
  });
  expect(decisionAnswerView({ ...card }, sent)).toMatchObject({
    status: "failed",
    optionKey: "keep",
  });
});

it("clears local progress when the snapshot shows the decision answered", () => {
  const answered = { ...card, data: { ...card.data, state: "answered" as const, choice: "keep" } };
  expect(decisionAnswerView(answered, sent)).toEqual({ status: "idle" });
  expect(decisionAnswerView(answered, { status: "sending", optionKey: "keep" })).toEqual({
    status: "idle",
  });
});
