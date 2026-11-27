import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { collectAssistantCitations } from "@t3tools/shared/assistantCitations";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import {
  ASSISTANT_CITATION_DRAFT_HIGHLIGHT,
  ASSISTANT_CITATION_HOT_HIGHLIGHT,
} from "~/lib/assistantCitationHighlights";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  dispatchedCommands,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const ANSWER = "Answer 0 for thread-quote.";
const COMMENT = "Check this line.";

const highlighted = (name: string) =>
  [...(CSS.highlights.get(name) ?? [])].map((range) => (range as Range).toString());

async function selectInAnswer(text: string) {
  const target = page.getByText(text, { exact: true });
  await expect.element(target).toHaveStyle({ pointerEvents: "auto" });
  await userEvent.tripleClick(target);
  await expect.element(page.getByRole("group", { name: "Selected text" })).toBeVisible();
}

// Its own file, and one test: the app's shell subscription and the composer draft outlive a test.
it("keeps every quoted passage highlighted while its chip is in the composer", async () => {
  const thread = threadWithHistory("thread-quote", 1);
  using _environment = installFakeEnvironment([thread], { acceptCommands: true });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText(ANSWER)).toBeVisible();
  expect(CSS.highlights.has(ASSISTANT_CITATION_DRAFT_HIGHLIGHT)).toBe(false);

  const editor = page.getByTestId("composer-editor");
  const commentChip = page.getByRole("link", { name: `View cited assistant text: ${COMMENT}` });

  await selectInAnswer(ANSWER);
  await userEvent.click(page.getByRole("button", { name: "Comment on selection" }));
  const commentInput = page.getByRole("textbox", { name: "Comment on selected text" });
  await expect.element(commentInput).toHaveFocus();
  await userEvent.keyboard(COMMENT);
  await userEvent.click(page.getByRole("button", { name: "Save", exact: true }));
  await expect.element(commentInput).not.toBeInTheDocument();
  await expect.element(commentChip).toBeVisible();
  await vi.waitFor(() => expect(highlighted(ASSISTANT_CITATION_DRAFT_HIGHLIGHT)).toHaveLength(1));
  expect(highlighted(ASSISTANT_CITATION_DRAFT_HIGHLIGHT)[0]).toContain(ANSWER);
  expect(highlighted(ASSISTANT_CITATION_HOT_HIGHLIGHT)).toEqual([]);

  await userEvent.hover(commentChip);
  await vi.waitFor(() =>
    expect(highlighted(ASSISTANT_CITATION_HOT_HIGHLIGHT)).toEqual(
      highlighted(ASSISTANT_CITATION_DRAFT_HIGHLIGHT),
    ),
  );
  expect(highlighted(ASSISTANT_CITATION_HOT_HIGHLIGHT)).toHaveLength(1);
  await userEvent.unhover(commentChip);
  await vi.waitFor(() => expect(highlighted(ASSISTANT_CITATION_HOT_HIGHLIGHT)).toEqual([]));

  await expect.element(editor).toHaveFocus();
  await userEvent.keyboard("{Backspace}");
  await expect.element(commentChip).not.toBeInTheDocument();
  expect(CSS.highlights.has(ASSISTANT_CITATION_DRAFT_HIGHLIGHT)).toBe(false);
  expect(CSS.highlights.has(ASSISTANT_CITATION_HOT_HIGHLIGHT)).toBe(false);

  await userEvent.keyboard("{Control>}z{/Control}");
  await expect.element(commentChip).toBeVisible();
  await vi.waitFor(() => expect(highlighted(ASSISTANT_CITATION_DRAFT_HIGHLIGHT)).toHaveLength(1));
  expect(highlighted(ASSISTANT_CITATION_DRAFT_HIGHLIGHT)[0]).toContain(ANSWER);

  commentChip.element().focus();
  await vi.waitFor(() =>
    expect(highlighted(ASSISTANT_CITATION_HOT_HIGHLIGHT)).toEqual(
      highlighted(ASSISTANT_CITATION_DRAFT_HIGHLIGHT),
    ),
  );
  (editor.element() as HTMLElement).focus();
  await vi.waitFor(() => expect(highlighted(ASSISTANT_CITATION_HOT_HIGHLIGHT)).toEqual([]));

  await userEvent.click(page.getByRole("button", { name: "Edit citation comment" }));
  await expect.element(commentInput).toHaveFocus();
  await userEvent.keyboard(" Again.");
  await userEvent.click(page.getByRole("button", { name: "Save", exact: true }));
  const editedChip = page.getByRole("link", {
    name: `View cited assistant text: ${COMMENT} Again.`,
  });
  await expect.element(editedChip).toBeVisible();
  expect(highlighted(ASSISTANT_CITATION_DRAFT_HIGHLIGHT)).toHaveLength(1);
  expect(highlighted(ASSISTANT_CITATION_DRAFT_HIGHLIGHT)[0]).toContain(ANSWER);

  await selectInAnswer("ran the tests");
  await userEvent.click(page.getByRole("button", { name: "Cite selection in composer" }));
  await expect
    .element(page.getByRole("link", { name: "View cited assistant text: ran the tests" }))
    .toBeVisible();
  expect(page.getByRole("textbox", { name: "Comment on selected text" }).query()).toBeNull();
  await vi.waitFor(() => expect(highlighted(ASSISTANT_CITATION_DRAFT_HIGHLIGHT)).toHaveLength(2));
  expect(highlighted(ASSISTANT_CITATION_DRAFT_HIGHLIGHT)).toContainEqual(
    expect.stringContaining("ran the tests"),
  );

  (editor.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  const sentTexts = () =>
    dispatchedCommands().flatMap((command) =>
      command.type === "message.dispatch" ? [command.text] : [],
    );
  await vi.waitFor(() => expect(sentTexts()).toHaveLength(1));
  const sentCitations = collectAssistantCitations(sentTexts()[0]!).map(({ citation }) => ({
    text: citation.text,
    comment: citation.comment,
  }));
  expect(sentCitations).toHaveLength(2);
  expect(sentCitations).toEqual(
    expect.arrayContaining([
      { text: expect.stringContaining(ANSWER), comment: `${COMMENT} Again.` },
      { text: expect.stringContaining("ran the tests"), comment: undefined },
    ]),
  );
  await expect.element(editedChip).not.toBeInTheDocument();
  await expect.element(editor).toHaveTextContent("");
  expect(CSS.highlights.has(ASSISTANT_CITATION_DRAFT_HIGHLIGHT)).toBe(false);
  expect(CSS.highlights.has(ASSISTANT_CITATION_HOT_HIGHLIGHT)).toBe(false);
});
