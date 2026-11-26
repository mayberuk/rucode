import {
  ThreadId,
  type DispatchDecisionCard,
  type DispatchDecisionCardData,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  decisionAnswerView,
  decisionCourse,
  type DecisionAnswerAttempt,
} from "./decisionPanel.logic";

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

const sent = {
  status: "sent" as const,
  optionKey: "keep",
  cardAtSend: card,
  reusedRetryDeadline: null,
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

it("keeps recording after a snapshot changes only other cards", () => {
  const unchanged = { ...card, data: { ...card.data } };
  expect(decisionAnswerView(unchanged, sent)).toEqual({
    status: "recording",
    optionKey: "keep",
  });
});

it.each([
  {
    after: "a card update without progress",
    changedCard: { ...card, updatedAt: "2026-11-21T09:01:00Z" },
    attempt: sent,
  },
  {
    after: "previously reported progress disappears",
    changedCard: card,
    attempt: { status: "reported", optionKey: "keep" } satisfies DecisionAnswerAttempt,
  },
])("offers a retry after $after", ({ changedCard, attempt }) => {
  expect(decisionAnswerView(changedCard, attempt)).toMatchObject({
    status: "failed",
    optionKey: "keep",
  });
});

const failedCard: DispatchDecisionCard = {
  ...card,
  data: {
    ...card.data,
    answer: { status: "failed", optionKey: "keep", reason: "dp-failed", detail: null },
  },
};

it.each([
  { deadlinePassed: false, expectedStatus: "recording" },
  { deadlinePassed: true, expectedStatus: "failed" },
])(
  "shows $expectedStatus for an identical failure with retry deadline passed: $deadlinePassed",
  ({ deadlinePassed, expectedStatus }) => {
    const retry: DecisionAnswerAttempt = {
      ...sent,
      cardAtSend: failedCard,
      reusedRetryDeadline: 31_000,
    };
    expect(decisionAnswerView(failedCard, retry, deadlinePassed)).toMatchObject({
      status: expectedStatus,
      optionKey: "keep",
      ...(expectedStatus === "failed" ? { message: "Couldn't record your answer." } : {}),
    });
  },
);

it("shows a repeated failure as soon as the newer attempt arrives", () => {
  const failedAttempt = (attemptId: string): DispatchDecisionCard => ({
    ...failedCard,
    data: {
      ...failedCard.data,
      answer: { status: "failed", optionKey: "keep", reason: "dp-failed", detail: null, attemptId },
    },
  });
  const retry = { ...sent, cardAtSend: failedAttempt("first") };
  expect(decisionAnswerView(retry.cardAtSend, retry).status).toBe("recording");
  expect(decisionAnswerView(failedAttempt("second"), retry)).toEqual({
    status: "failed",
    optionKey: "keep",
    message: "Couldn't record your answer.",
  });
});

it("clears local progress when the snapshot shows the decision answered", () => {
  const answered = { ...card, data: { ...card.data, state: "answered" as const, choice: "keep" } };
  expect(decisionAnswerView(answered, sent)).toEqual({ status: "idle" });
  expect(decisionAnswerView(answered, { status: "sending", optionKey: "keep" })).toEqual({
    status: "idle",
  });
});

describe("decisionCourse", () => {
  const applyAfter = "2026-11-21T09:05:00Z";
  const ordinary: DispatchDecisionCardData = {
    ...card.data,
    options: [
      { key: "go", label: "Continue", recommended: false },
      { key: "stop", label: "Park it", recommended: false },
    ],
    defaultKey: "go",
    applyAfter,
    needsPerson: false,
  };
  const protectedStop: DispatchDecisionCardData = {
    ...ordinary,
    defaultKey: "stop",
    protection: "outward",
  };
  const needsPerson = (recommended: boolean): DispatchDecisionCardData => ({
    ...ordinary,
    defaultKey: null,
    applyAfter: null,
    needsPerson: true,
    options: [
      { key: "go", label: "Continue", recommended: false },
      { key: "stop", label: "Park it", recommended },
    ],
  });

  it.each([
    [
      "an ordinary decision before its default applies",
      ordinary,
      "2026-11-21T09:00",
      { type: "default", optionLabel: "Continue", at: applyAfter, protectedStop: false },
    ],
    [
      "an ordinary decision in the minute its default applies",
      ordinary,
      "2026-11-21T09:05",
      { type: "default", optionLabel: "Continue", at: applyAfter, protectedStop: false },
    ],
    [
      "an ordinary decision a minute after its default was due",
      ordinary,
      "2026-11-21T09:06",
      { type: "overdue", optionLabel: "Continue" },
    ],
    [
      "a protected decision",
      protectedStop,
      "2026-11-21T09:00",
      { type: "default", optionLabel: "Park it", at: applyAfter, protectedStop: true },
    ],
    [
      "a needs-person decision with a recommendation",
      needsPerson(true),
      "2026-11-21T09:00",
      { type: "recommended", optionLabel: "Park it" },
    ],
    [
      "a needs-person decision without a recommendation",
      needsPerson(false),
      "2026-11-21T09:00",
      { type: "choose" },
    ],
  ] as const)("reads %s", (_label, data, nowMinute, course) => {
    expect(decisionCourse(data, nowMinute)).toEqual(course);
  });
});
