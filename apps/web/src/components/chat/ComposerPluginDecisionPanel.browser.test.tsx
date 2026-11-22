import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  PluginCardError,
  ThreadId,
  type DispatchDecisionCard,
  type DispatchDecisionCardData,
  type PluginCard,
  type PluginThreadCards,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { createElement } from "react";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { composerDrawerContent } from "~/pendingUserInput";
import { usePluginThreadCards } from "~/pluginCards/core/usePluginCards";
import { pluginCardRenderer } from "~/pluginCards/registry";
import * as pluginCardsRpc from "~/rpc/pluginCards";
import { act, fakeTimers, render, type Screen } from "../../../test/render";
import { ComposerPluginDecisionPanel } from "./ComposerPluginDecisionPanel";
import { PluginCardTimelineRow } from "./PluginCardTimelineRow";
import { TimelineRowCtx } from "./timelineRowContext";
import { usePendingPluginDecisions } from "./usePendingThreadRequests";

vi.mock(import("~/rpc/pluginCards"), { spy: true });

const threadRef = {
  environmentId: EnvironmentId.make("decisions"),
  threadId: ThreadId.make("thread"),
};

function decisionCard(
  decisionId: string,
  data: Partial<DispatchDecisionCardData> = {},
  threadId = threadRef.threadId,
): DispatchDecisionCard {
  const dir = data.dir ?? "/home/me/repo";
  return {
    id: `dispatch.decision:${dir}#${decisionId}`,
    threadId,
    kind: "dispatch.decision",
    placement: { type: "time", at: "2026-11-21T09:00:00Z" },
    updatedAt: "2026-11-21T09:00:00Z",
    actions: [],
    data: {
      decisionId,
      dir,
      decisionKind: "scope",
      question: `Close the initiative without ${decisionId}?`,
      options: [
        { key: "drop", label: "Drop the wave and close", recommended: false },
        { key: "keep", label: "Keep it open", recommended: false },
      ],
      defaultKey: null,
      state: "open",
      choice: null,
      chosenBy: null,
      chosenVia: null,
      raisedAt: "2026-11-21T09:00:00Z",
      applyAfter: null,
      resolvedAt: null,
      needsPerson: true,
      protection: null,
      initiative: "nov18",
      part: "ui",
      wave: 3,
      phase: null,
      answerable: "yes",
      answer: null,
      ...data,
    },
  };
}

function setup({ canAnswer = true }: { canAnswer?: boolean } = {}) {
  const stack = new DisposableStack();
  const registry = stack.adopt(AtomRegistry.make(), (value) => value.dispose());
  const snapshot = Atom.make<AsyncResult.AsyncResult<PluginThreadCards>>(AsyncResult.initial());
  stack.use(vi.spyOn(pluginCardsRpc, "pluginThreadCardsAtomFamily").mockReturnValue(snapshot));
  stack.use(
    vi
      .spyOn(pluginCardsRpc.answerPluginDecision, "permissionAtom")
      .mockReturnValue(Atom.make(canAnswer)),
  );
  const publish = (cards: ReadonlyArray<PluginCard>) =>
    act(() => registry.set(snapshot, AsyncResult.success({ threadId: threadRef.threadId, cards })));
  const drop = () => act(() => registry.set(snapshot, AsyncResult.initial(true)));
  return { registry, publish, drop, [Symbol.dispose]: () => stack.dispose() };
}

type AnswerResult = Awaited<ReturnType<typeof pluginCardsRpc.answerPluginDecision.run>>;

function stubAnswer() {
  const calls: Array<PromiseWithResolvers<AnswerResult>> = [];
  const spy = vi.spyOn(pluginCardsRpc.answerPluginDecision, "run").mockImplementation(() => {
    const call = Promise.withResolvers<AnswerResult>();
    calls.push(call);
    return call.promise;
  });
  return { spy, calls, [Symbol.dispose]: () => spy.mockRestore() };
}

// The same wiring the composer uses to pick what its drawer shows.
function DecisionDrawer() {
  const openDecisions = usePendingPluginDecisions(threadRef);
  const content = composerDrawerContent({
    pendingUserInputs: [],
    pendingApprovals: [],
    openDecisions,
  });
  return content?.type === "decision" ? (
    <ComposerPluginDecisionPanel
      key={content.decision.id}
      decision={content.decision}
      index={content.index}
      total={content.total}
      threadRef={threadRef}
    />
  ) : null;
}

function SnapshotTimelineCard() {
  const card = usePluginThreadCards(threadRef)?.cards[0];
  return card ? <TimelineCard card={card} /> : null;
}

function TimelineCard({ card }: { card: PluginCard }) {
  const renderer = pluginCardRenderer(card.kind);
  return renderer === null
    ? null
    : createElement(renderer, { card, environmentId: threadRef.environmentId, threadRef });
}

const answerButton = (screen: Screen) =>
  screen.getByRole("button", { name: "Answer", exact: true });

const recommendingDrop: Partial<DispatchDecisionCardData> = {
  options: [
    { key: "drop", label: "Drop the wave and close", recommended: true },
    { key: "keep", label: "Keep it open", recommended: false },
  ],
};

// Far enough ahead that the minute clock never reads the default as overdue.
const ordinary: Partial<DispatchDecisionCardData> = {
  needsPerson: false,
  defaultKey: "drop",
  applyAfter: "2099-01-01T09:05:00Z",
};

it("shows no panel while the snapshot loads or when the chat has no open decision", async () => {
  using env = setup();
  await using screen = await render(
    <RegistryContext.Provider value={env.registry}>
      <DecisionDrawer />
    </RegistryContext.Provider>,
  );
  expect(screen.container.textContent).toBe("");

  await env.publish([
    decisionCard("d-answered", { state: "answered", choice: "keep", chosenBy: "person" }),
    decisionCard("d-elsewhere", {}, ThreadId.make("other-thread")),
  ]);
  expect(screen.container.textContent).toBe("");
});

it("stays hidden for a connection that cannot answer decisions", async () => {
  using env = setup({ canAnswer: false });
  await using screen = await render(
    <RegistryContext.Provider value={env.registry}>
      <DecisionDrawer />
    </RegistryContext.Provider>,
  );
  await env.publish([decisionCard("d-1")]);
  expect(screen.container.textContent).toBe("");
});

it("answers the picked option in two steps and shows recording until the decision closes", async () => {
  using env = setup();
  using answer = stubAnswer();
  await using screen = await render(
    <RegistryContext.Provider value={env.registry}>
      <DecisionDrawer />
    </RegistryContext.Provider>,
  );
  const card = decisionCard("d-1", recommendingDrop);
  await env.publish([card]);

  await expect.element(screen.getByText("Close the initiative without d-1?")).toBeVisible();
  await expect.element(screen.getByText("nov18 · wave 3")).toBeVisible();
  await expect.element(screen.getByText(/^Recommended: Drop the wave and close$/)).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: /Keep it open/ }))
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Other options" }).click();
  const recommended = screen.getByRole("button", { name: /Drop the wave and close/ });
  await expect.element(recommended).toMatchTextContent(/Recommended/);
  await expect
    .element(screen.getByRole("button", { name: /Keep it open/ }))
    .not.toMatchTextContent(/Recommended/);
  await expect.element(screen.getByText("1/1")).not.toBeInTheDocument();
  await expect.element(answerButton(screen)).toBeDisabled();

  await screen.getByRole("button", { name: /Keep it open/ }).click();
  await answerButton(screen).click();
  expect(answer.spy).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, cardId: card.id, optionKey: "keep" },
  });
  await expect.element(screen.getByRole("button", { name: "Recording answer…" })).toBeDisabled();

  await env.publish([
    { ...card, data: { ...card.data } },
    decisionCard("d-answered", { state: "answered", choice: "keep" }),
  ]);
  await act(async () => {
    answer.calls[0]!.resolve(AsyncResult.success({ delivery: "started" }));
  });
  await expect.element(screen.getByRole("button", { name: "Recording answer…" })).toBeDisabled();

  await env.publish([
    {
      ...card,
      updatedAt: "2026-11-21T09:01:00Z",
      data: {
        ...card.data,
        answer: { optionKey: "keep", status: "recording", reason: null, detail: null },
      },
    },
  ]);
  await expect.element(screen.getByRole("button", { name: "Recording answer…" })).toBeDisabled();
  await expect
    .element(screen.getByRole("button", { name: /Keep it open/ }))
    .toHaveAttribute("aria-pressed", "true");

  await env.publish([
    decisionCard("d-1", { state: "answered", choice: "keep", chosenBy: "person" }),
  ]);
  expect(screen.container.textContent).toBe("");
  expect(answer.spy).toHaveBeenCalledTimes(1);
});

it("goes with a needs-person decision's recommendation in one step", async () => {
  using env = setup();
  using answer = stubAnswer();
  await using screen = await render(
    <RegistryContext.Provider value={env.registry}>
      <DecisionDrawer />
    </RegistryContext.Provider>,
  );
  const card = decisionCard("d-1", recommendingDrop);
  await env.publish([card]);

  await screen.getByRole("button", { name: "Go with it" }).click();
  expect(answer.spy).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, cardId: card.id, optionKey: "drop" },
  });
  await expect.element(screen.getByRole("button", { name: "Recording answer…" })).toBeDisabled();
});

it("shows an ordinary decision as the course it will take until its header opens its options", async () => {
  using env = setup();
  using answer = stubAnswer();
  await using screen = await render(
    <RegistryContext.Provider value={env.registry}>
      <DecisionDrawer />
    </RegistryContext.Provider>,
  );
  const card = decisionCard("d-1", ordinary);
  await env.publish([card]);

  await expect.element(screen.getByText(/^Going with Drop the wave and close at /)).toBeVisible();
  await expect
    .element(screen.getByText("Close the initiative without d-1?"))
    .not.toBeInTheDocument();

  await screen.getByTitle("Show the decision and its options").click();
  await expect
    .element(screen.getByRole("button", { name: /^Drop the wave and close/ }))
    .toMatchTextContent(/Default ·/);
  await screen.getByRole("button", { name: /Keep it open/ }).click();
  await answerButton(screen).click();
  expect(answer.spy).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, cardId: card.id, optionKey: "keep" },
  });
});

it("picks an option from a digit key without sending an answer", async () => {
  using env = setup();
  using answer = stubAnswer();
  await using screen = await render(
    <RegistryContext.Provider value={env.registry}>
      <textarea aria-label="Draft" />
      <DecisionDrawer />
    </RegistryContext.Provider>,
  );
  await env.publish([decisionCard("d-1")]);
  const keep = screen.getByRole("button", { name: /Keep it open/ });
  const drop = screen.getByRole("button", { name: /Drop the wave and close/ });
  await expect.element(keep).toHaveAttribute("aria-pressed", "false");

  await userEvent.keyboard("2");
  await expect.element(keep).toHaveAttribute("aria-pressed", "true");
  await expect.element(answerButton(screen)).toBeEnabled();

  await userEvent.keyboard("3");
  await expect.element(keep).toHaveAttribute("aria-pressed", "true");

  screen.getByLabelText("Draft").element().focus();
  await userEvent.keyboard("1");
  await expect.element(keep).toHaveAttribute("aria-pressed", "true");
  await expect.element(drop).toHaveAttribute("aria-pressed", "false");
  expect(answer.spy).not.toHaveBeenCalled();
});

it("shows the oldest of several decisions with a count and moves on when it closes", async () => {
  using env = setup();
  await using screen = await render(
    <RegistryContext.Provider value={env.registry}>
      <DecisionDrawer />
    </RegistryContext.Provider>,
  );
  const middle = decisionCard("d-middle", { raisedAt: "2026-11-21T09:30:00Z" });
  const newest = decisionCard("d-newest", { raisedAt: "2026-11-21T10:00:00Z" });
  const oldest = decisionCard("d-oldest", { raisedAt: "2026-11-21T08:00:00Z" });
  await env.publish([middle, newest, oldest]);
  await expect.element(screen.getByText("Close the initiative without d-oldest?")).toBeVisible();
  await expect.element(screen.getByText("1/3")).toBeVisible();

  await env.publish([middle, newest, { ...oldest, data: { ...oldest.data, state: "answered" } }]);
  await expect.element(screen.getByText("Close the initiative without d-middle?")).toBeVisible();
  await expect.element(screen.getByText("1/2")).toBeVisible();
});

it.each(["legacy", "versioned"] as const)(
  "offers another retry after a %s refusal repeats",
  async (server) => {
    using env = setup();
    using answer = stubAnswer();
    await using screen = await render(
      <RegistryContext.Provider value={env.registry}>
        <DecisionDrawer />
      </RegistryContext.Provider>,
    );
    const failure = {
      optionKey: "keep",
      status: "failed",
      reason: "dp-failed",
      detail: "exit status 1",
    } as const;
    const showFailure = (attemptId?: string) =>
      decisionCard("d-1", {
        answer: attemptId === undefined ? failure : { ...failure, attemptId },
      });
    const card = showFailure(server === "versioned" ? "attempt-1" : undefined);
    await env.publish([card]);

    await expect.element(screen.getByText("Couldn't record your answer.")).toBeVisible();
    await expect.element(screen.getByText("Close the initiative without d-1?")).toBeVisible();
    await expect.element(answerButton(screen)).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "Try again" }).click();
    expect(answer.spy).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, cardId: card.id, optionKey: "keep" },
    });

    {
      using _timers = fakeTimers();
      await act(async () => {
        answer.calls[0]!.resolve(AsyncResult.success({ delivery: "reused" }));
      });
      await expect
        .element(screen.getByRole("button", { name: "Recording answer…" }))
        .toBeDisabled();
      if (server === "legacy") {
        await act(() => vi.advanceTimersByTime(31_000));
      } else {
        await env.publish([showFailure("attempt-2")]);
      }
      await expect.element(screen.getByText("Couldn't record your answer.")).toBeVisible();
    }

    await screen.getByRole("button", { name: "Try again" }).click();
    await act(async () => {
      answer.calls[1]!.resolve(
        AsyncResult.fail(new PluginCardError({ reason: "decision-closed" })),
      );
    });
    await expect
      .element(screen.getByText("This decision was already answered or closed."))
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  },
);

it("shows the terminal command for the picked option when the chat cannot quote turns", async () => {
  using env = setup();
  using answer = stubAnswer();
  await using screen = await render(
    <RegistryContext.Provider value={env.registry}>
      <DecisionDrawer />
    </RegistryContext.Provider>,
  );
  await env.publish([
    decisionCard("d-7", { answerable: "terminal-only", dir: "/home/me/my repo" }),
  ]);
  await expect.element(screen.getByText("Close the initiative without d-7?")).toBeVisible();
  await expect.element(answerButton(screen)).not.toBeInTheDocument();
  await expect.element(screen.getByText(/dp decision answer/)).not.toBeInTheDocument();

  await screen.getByRole("button", { name: /Keep it open/ }).click();
  await expect
    .element(
      screen.getByText(
        /^\$\s*dp decision answer d-7 keep --dir '\/home\/me\/my repo' --actor person$/,
      ),
    )
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Copy command" })).toBeVisible();
  await expect.element(answerButton(screen)).not.toBeInTheDocument();
  expect(answer.spy).not.toHaveBeenCalled();
});

it.each([
  { reconnectedTo: "still open", answered: false },
  { reconnectedTo: "answered", answered: true },
])(
  "shows the first snapshot after a dropped answer reconnects $reconnectedTo",
  async ({ answered }) => {
    using env = setup();
    using answer = stubAnswer();
    const card = decisionCard("d-1");
    const answeredCard = decisionCard("d-1", {
      state: "answered",
      choice: "keep",
      chosenBy: "person",
      resolvedAt: "2026-11-21T09:05:00Z",
    });
    await using screen = await render(
      <RegistryContext.Provider value={env.registry}>
        <div data-testid="drawer">
          <DecisionDrawer />
        </div>
        <SnapshotTimelineCard />
      </RegistryContext.Provider>,
    );
    await env.publish([card]);
    await screen.getByRole("button", { name: /Keep it open/ }).click();
    await answerButton(screen).click();
    await act(async () => {
      answer.calls[0]!.resolve(AsyncResult.failure(Cause.interrupt()));
    });
    await expect
      .element(screen.getByText("The connection dropped before the answer was confirmed."))
      .toBeVisible();

    await env.drop();
    expect(screen.container.textContent).toBe("");

    await env.publish([answered ? answeredCard : card]);
    if (!answered) {
      await expect.element(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
      await expect
        .element(screen.getByRole("button", { name: /Keep it open/ }))
        .toHaveAttribute("aria-pressed", "true");
      return;
    }
    expect(screen.getByTestId("drawer").element().textContent).toBe("");
    const timelineCard = screen.getByRole("region", { name: "Decision" });
    await expect.element(timelineCard).toMatchTextContent(/Keep it open/);
    await expect.element(timelineCard).toMatchTextContent(/You/);
    expect(timelineCard.element().querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-11-21T09:05:00Z",
    );
  },
);

it.each([
  {
    state: "answered" as const,
    data: { choice: "keep", chosenBy: "agent" },
    headline: "Keep it open",
    who: "Agent",
  },
  {
    state: "defaulted" as const,
    data: { choice: "drop", chosenBy: "default" },
    headline: "Defaulted to Drop the wave and close",
    who: "Default",
  },
  {
    state: "superseded" as const,
    data: { choice: null, chosenBy: "waiver" },
    headline: "Superseded by waiver",
    who: null,
  },
])("records a $state decision on its timeline card", async ({ state, data, headline, who }) => {
  using env = setup();
  const card = decisionCard("d-1", { state, ...data, resolvedAt: "2026-11-21T09:05:00Z" });
  await using screen = await render(
    <RegistryContext.Provider value={env.registry}>
      <TimelineCard card={card} />
    </RegistryContext.Provider>,
  );
  const timelineCard = screen.getByRole("region", { name: "Decision" });
  await expect.element(timelineCard).toMatchTextContent(headline);
  await expect.element(timelineCard).not.toMatchTextContent(/Answer it in the composer/);
  if (who !== null) await expect.element(timelineCard).toMatchTextContent(who);
  expect(timelineCard.element().querySelector("time")?.getAttribute("datetime")).toBe(
    "2026-11-21T09:05:00Z",
  );
});

it("draws an open decision as one timeline line, its options left to the composer", async () => {
  using env = setup();
  const onToggleWorkGroup = vi.fn();
  const card = decisionCard("d-1");
  const row = {
    kind: "plugin-card",
    id: `plugin-card:${card.id}`,
    createdAt: card.updatedAt,
    card,
    presence: "needs-you",
    collapsed: true,
  } as const;
  const ctx = {
    activeThreadEnvironmentId: threadRef.environmentId,
    timestampFormat: "24-hour",
    onToggleWorkGroup,
  } as never;
  await using screen = await render(
    <RegistryContext.Provider value={env.registry}>
      <TimelineRowCtx value={ctx}>
        <PluginCardTimelineRow row={row} />
      </TimelineRowCtx>
    </RegistryContext.Provider>,
  );
  const line = screen.getByRole("button", { name: /Decision · nov18 · wave 3/ });
  await expect.element(line).toHaveAttribute("aria-expanded", "false");
  await expect.element(line).toMatchTextContent(/Waiting/);
  expect(screen.container.textContent).not.toMatch(/Keep it open|Close the initiative/);
  await line.click();
  expect(onToggleWorkGroup).toHaveBeenCalledExactlyOnceWith(row.id, row.id);

  await screen.rerender(
    <RegistryContext.Provider value={env.registry}>
      <TimelineRowCtx value={ctx}>
        <PluginCardTimelineRow row={{ ...row, collapsed: false }} />
      </TimelineRowCtx>
    </RegistryContext.Provider>,
  );
  const timelineCard = screen.getByRole("region", { name: "Decision" });
  await expect.element(timelineCard).toMatchTextContent(/Close the initiative without d-1\?/);
  await expect.element(timelineCard).toMatchTextContent(/Answer it in the composer\./);
  await expect.element(timelineCard).not.toMatchTextContent(/Keep it open/);
});
