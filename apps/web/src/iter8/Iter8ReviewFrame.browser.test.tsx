import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  Iter8ReviewError,
  type Iter8Note,
  type Iter8Page,
  type Iter8ReviewSnapshot,
  type PreviewAnnotationSubmissionResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { toastManager } from "~/components/ui/toast";
import * as iter8Rpc from "~/rpc/iter8";
import { act, render } from "../../test/render";
import { Iter8ReviewFrame, type Iter8ReviewPins } from "./Iter8ReviewFrame";

vi.mock(import("~/rpc/iter8"), { spy: true });

const environmentId = EnvironmentId.make("iter8-review");
const origin = "http://pg1.localhost:4321";

function note(overrides: Partial<Iter8Note> & Pick<Iter8Note, "id">): Iter8Note {
  return {
    pageId: "pg1",
    roundId: null,
    author: { kind: "user" },
    intent: "fix",
    body: "Body",
    selector: [],
    anchorLabel: null,
    path: "/",
    status: "draft",
    reply: null,
    createdAt: "2026-11-20T10:00:00Z",
    ...overrides,
  };
}

const draft = note({
  id: "n-draft",
  intent: "fix",
  body: `Match the totals on ${origin}/confirm.`,
  selector: ["button.total"],
  anchorLabel: "button.total",
  path: "/plans",
});
const sent = note({
  id: "n-sent",
  roundId: "r1",
  intent: "change",
  body: "Shorten the heading",
  selector: ["h1"],
  path: "/confirm",
  status: "sent",
});
const done = note({
  id: "n-done",
  roundId: "r1",
  intent: "question",
  body: "Is the fee final?",
  selector: ["p.fee"],
  path: "/confirm",
  status: "done",
  reply: "Yes, the fee is final.",
});

const page: Iter8Page = {
  id: "pg1",
  origin,
  projectRoot: "/work/checkout-flow",
  ownerId: "owner-1",
  rounds: [
    {
      id: "r1",
      pageId: "pg1",
      stage: "announced",
      noteCount: 2,
      createdAt: "2026-11-20T11:00:00Z",
    },
  ],
  notes: [draft, sent, done],
};

const snapshot: Iter8ReviewSnapshot = {
  available: true,
  sessions: [
    {
      ownerId: "owner-1",
      agent: "claude",
      label: "Polish the checkout flow",
      cwd: "/work/checkout-flow",
      state: "live",
      pageIds: ["pg1"],
    },
  ],
  pages: [page],
};

type ReviewResult = AsyncResult.AsyncResult<Iter8ReviewSnapshot, Iter8ReviewError>;

function setup(
  source: Atom.Atom<ReviewResult> = Atom.make<ReviewResult>(AsyncResult.success(snapshot)),
) {
  const stack = new DisposableStack();
  const registry = stack.adopt(AtomRegistry.make(), (value) => value.dispose());
  stack.use(vi.spyOn(iter8Rpc, "iter8ReviewAtomFamily").mockReturnValue(source as never));
  for (const command of [
    iter8Rpc.createIter8Note,
    iter8Rpc.updateIter8Note,
    iter8Rpc.deleteIter8Note,
    iter8Rpc.sendIter8Round,
  ]) {
    stack.use(vi.spyOn(command, "permissionAtom").mockReturnValue(Atom.make(true)));
  }
  const create = stack.use(
    vi.spyOn(iter8Rpc.createIter8Note, "run").mockResolvedValue(AsyncResult.success(undefined)),
  );
  const update = stack.use(
    vi.spyOn(iter8Rpc.updateIter8Note, "run").mockResolvedValue(AsyncResult.success(undefined)),
  );
  const remove = stack.use(
    vi.spyOn(iter8Rpc.deleteIter8Note, "run").mockResolvedValue(AsyncResult.success(undefined)),
  );
  const send = stack.use(vi.spyOn(iter8Rpc.sendIter8Round, "run"));
  const toast = stack.use(vi.spyOn(toastManager, "add"));
  const navigate = vi.fn<(url: string) => void>();
  const openExternally = vi.fn<(url: string) => void>();
  const setPins = vi.fn<(pins: Iter8ReviewPins) => void>();
  const frame = (props: {
    url: string;
    pickNote?: (() => Promise<PreviewAnnotationSubmissionResult | null>) | null;
    withPins?: boolean;
  }): ReactNode => (
    <RegistryContext.Provider value={registry}>
      <Iter8ReviewFrame
        environmentId={environmentId}
        url={props.url}
        pickNote={props.pickNote === undefined ? () => Promise.resolve(null) : props.pickNote}
        cancelPickNote={null}
        setPins={props.withPins === false ? null : setPins}
        navigate={navigate}
        openExternally={openExternally}
      >
        <div data-testid="page">page body</div>
      </Iter8ReviewFrame>
    </RegistryContext.Provider>
  );
  return {
    registry,
    create,
    update,
    remove,
    send,
    toast,
    navigate,
    openExternally,
    setPins,
    frame,
    [Symbol.dispose]: () => stack.dispose(),
  };
}

it.each([
  {
    case: "a non-iter8 URL",
    url: "http://localhost:5173/plans",
    result: AsyncResult.success(snapshot),
  },
  { case: "a review still loading", url: `${origin}/plans`, result: AsyncResult.initial() },
  {
    case: "iter8 being unavailable",
    url: `${origin}/plans`,
    result: AsyncResult.success({ available: false, sessions: [], pages: [] }),
  },
] satisfies ReadonlyArray<{ case: string; url: string; result: ReviewResult }>)(
  "renders only the page for $case",
  async ({ url, result }) => {
    using env = setup(Atom.make<ReviewResult>(result));
    await using screen = await render(env.frame({ url }));
    await expect.element(screen.getByTestId("page")).toBeVisible();
    expect(screen.container.textContent).toBe("page body");
    expect(env.setPins).not.toHaveBeenCalled();
  },
);

it("docks the bar and the grouped notes around an iter8 page, and lists its sessions", async () => {
  using env = setup();
  await using screen = await render(env.frame({ url: `${origin}/plans` }));

  const bar = screen.getByRole("toolbar", { name: "iter8 review" });
  await expect.element(bar).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Add note" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Page: /plans" })).toBeVisible();
  await expect.element(bar).toMatchTextContent("R2 · 1 draft");
  const order = [
    ...screen.container.querySelectorAll("[role=toolbar], [data-testid=page], section"),
  ];
  expect(
    order.map((element) => element.getAttribute("role") ?? element.tagName.toLowerCase()),
  ).toEqual(["toolbar", "div", "section"]);

  await expect.element(screen.getByRole("button", { name: /^\/plans\s*1$/ })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /^\/confirm\s*2$/ })).toBeVisible();
  const draftRow = screen.getByRole("button", { name: /Match the totals/ });
  await expect.element(draftRow).toMatchTextContent(/^1Fixbutton\.total.*Draft/);
  const doneRow = screen.getByRole("button", { name: /Is the fee final/ });
  await expect.element(doneRow).toMatchTextContent("Resolved");
  await expect.element(doneRow).toMatchTextContent("Yes, the fee is final.");
  await expect
    .element(screen.getByRole("button", { name: /Shorten the heading/ }))
    .toMatchTextContent("Sent");

  await screen.getByRole("link", { name: "/confirm" }).click();
  expect(env.navigate).toHaveBeenLastCalledWith(`${origin}/confirm`);
  await screen.getByRole("button", { name: /^\/plans\s*1$/ }).click();
  expect(env.navigate).toHaveBeenLastCalledWith(`${origin}/plans`);

  await screen.getByRole("button", { name: /^Sessions/ }).click();
  const session = screen.getByRole("button", { name: /Polish the checkout flow/ });
  await expect.element(session).toMatchTextContent("checkout-flow");
  await expect.element(session).toMatchTextContent("Running");
  await expect.element(session).toMatchTextContent("3 pages · R2 · 1 draft · 2 open");
  await session.click();
  await screen.getByRole("button", { name: /^\/confirm/ }).click();
  expect(env.navigate).toHaveBeenLastCalledWith(`${origin}/confirm`);
});

it("navigates to a selected note's path and focuses its pin, and clears the pins when the dock goes", async () => {
  using env = setup();
  await using screen = await render(env.frame({ url: `${origin}/plans` }));
  await expect.element(screen.getByRole("toolbar")).toBeVisible();
  expect(env.setPins).toHaveBeenLastCalledWith({
    pins: [{ label: "1", selector: ["button.total"], resolved: false }],
    focusLabel: null,
  });

  await screen.getByRole("button", { name: /Shorten the heading/ }).click();
  expect(env.navigate).toHaveBeenLastCalledWith(`${origin}/confirm`);
  await screen.rerender(env.frame({ url: `${origin}/confirm` }));
  expect(env.setPins).toHaveBeenLastCalledWith({
    pins: [
      { label: "2", selector: ["h1"], resolved: false },
      { label: "3", selector: ["p.fee"], resolved: true },
    ],
    focusLabel: "2",
  });

  await screen.unmount();
  expect(env.setPins).toHaveBeenLastCalledWith(null);
});

it.each([
  {
    case: "has ended",
    review: {
      ...snapshot,
      sessions: snapshot.sessions.map((session) => ({ ...session, state: "gone" as const })),
    },
    reason: "The session that owns this page has ended",
  },
  {
    case: "is missing",
    review: { ...snapshot, pages: [{ ...page, ownerId: null }] },
    reason: "No session owns this page",
  },
])("disables Send and says why when the page's session $case", async ({ review, reason }) => {
  using env = setup(Atom.make<ReviewResult>(AsyncResult.success(review)));
  await using screen = await render(env.frame({ url: `${origin}/plans` }));
  await expect.element(screen.getByRole("button", { name: "Send round" })).toBeDisabled();
  await expect.element(screen.getByRole("toolbar")).toMatchTextContent(reason);
});

it("offers Open in new tab instead of Add note where the browser cannot pick", async () => {
  using env = setup(
    Atom.make<ReviewResult>(AsyncResult.success({ ...snapshot, pages: [{ ...page, notes: [] }] })),
  );
  await using screen = await render(
    env.frame({ url: `${origin}/plans`, pickNote: null, withPins: false }),
  );
  await expect.element(screen.getByRole("button", { name: "Add note" })).not.toBeInTheDocument();
  await expect
    .element(screen.getByText("No notes yet. Open the page in a new tab to add notes with iter8."))
    .toBeVisible();
  await screen.getByRole("button", { name: "Open in new tab" }).click();
  expect(env.openExternally).toHaveBeenCalledExactlyOnceWith(`${origin}/plans`);
});

it("tells a desktop user how to add the first note", async () => {
  using env = setup(
    Atom.make<ReviewResult>(AsyncResult.success({ ...snapshot, pages: [{ ...page, notes: [] }] })),
  );
  await using screen = await render(env.frame({ url: `${origin}/plans` }));
  await expect
    .element(screen.getByText("No notes yet. Use Add note to pin one on the page."))
    .toBeVisible();
});

it("creates a draft from the picked element, and keeps the text in a toast when saving fails", async () => {
  const iter8 = {
    intent: "question",
    anchor: { selector: ["main > button"], box: { x: 1, y: 2, width: 30, height: 40 } },
    viewport: { width: 800, height: 600, devicePixelRatio: 2 },
    theme: "dark",
  } as const;
  const picked: PreviewAnnotationSubmissionResult = {
    submission: "attach",
    annotation: {
      id: "a1",
      pageUrl: `${origin}/plans`,
      pageTitle: null,
      comment: "  Two buttons do the same thing  ",
      elements: [],
      regions: [],
      strokes: [],
      styleChanges: [],
      screenshot: null,
      createdAt: "2026-11-20T12:00:00Z",
      iter8,
    },
  };
  const pickNote = vi.fn(() => Promise.resolve(picked));
  using env = setup();
  await using screen = await render(env.frame({ url: `${origin}/plans`, pickNote }));

  await screen.getByRole("button", { name: "Add note" }).click();
  await vi.waitFor(() => expect(env.create).toHaveBeenCalledTimes(1));
  expect(env.create).toHaveBeenCalledWith(expect.anything(), {
    environmentId,
    input: {
      pageId: "pg1",
      intent: "question",
      body: "Two buttons do the same thing",
      anchor: iter8.anchor,
      url: `${origin}/plans`,
      viewport: iter8.viewport,
      theme: "dark",
    },
  });
  expect(env.toast).not.toHaveBeenCalled();

  env.create.mockResolvedValueOnce(AsyncResult.fail(new Iter8ReviewError({ reason: "rejected" })));
  await screen.getByRole("button", { name: "Add note" }).click();
  await vi.waitFor(() => expect(env.toast).toHaveBeenCalledTimes(1));
  expect(env.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "error",
      title: "Couldn't save the note",
      description: "Two buttons do the same thing",
    }),
  );
});

it("deletes a draft and saves an edited intent and text", async () => {
  using env = setup();
  await using screen = await render(env.frame({ url: `${origin}/plans` }));

  await screen.getByRole("button", { name: "Delete note" }).click();
  expect(env.remove).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
    environmentId,
    input: { pageId: "pg1", noteId: "n-draft" },
  });
  expect(env.navigate).not.toHaveBeenCalled();

  await screen.getByRole("button", { name: "Edit note" }).click();
  await screen.getByRole("button", { name: "Change", exact: true }).click();
  const textbox = screen.getByRole("textbox", { name: "Note" });
  await textbox.fill("  Align the totals  ");
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  expect(env.update).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
    environmentId,
    input: { pageId: "pg1", noteId: "n-draft", intent: "change", body: "Align the totals" },
  });
  await expect.element(textbox).not.toBeInTheDocument();
});

it("shows iter8's refusal in the bar and keeps Send disabled", async () => {
  using env = setup();
  env.send.mockResolvedValue(
    AsyncResult.success({ outcome: "refused", reason: "session-gone" } as const),
  );
  await using screen = await render(env.frame({ url: `${origin}/plans` }));
  const sendButton = screen.getByRole("button", { name: "Send round" });
  await expect.element(sendButton).toBeEnabled();

  screen
    .getByRole("button", { name: /Match the totals/ })
    .element()
    .focus();
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  expect(env.send).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
    environmentId,
    input: { pageId: "pg1", idempotencyKey: expect.any(String) },
  });
  expect(env.navigate).not.toHaveBeenCalled();
  await expect
    .element(screen.getByRole("toolbar"))
    .toMatchTextContent("The session that owns this page has ended");
  await expect.element(sendButton).toBeDisabled();
});

it("retries a send with an unknown outcome under the same idempotency key", async () => {
  using env = setup();
  const first = Promise.withResolvers<Awaited<ReturnType<typeof iter8Rpc.sendIter8Round.run>>>();
  env.send
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce(AsyncResult.success({ outcome: "accepted", roundId: "r2" } as const));
  await using screen = await render(env.frame({ url: `${origin}/plans` }));

  await screen.getByRole("button", { name: "Send round" }).click();
  await expect.element(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
  await act(async () => {
    first.resolve(AsyncResult.failure(Cause.interrupt()));
  });
  await vi.waitFor(() => expect(env.toast).toHaveBeenCalledTimes(1));
  const toast = env.toast.mock.calls[0]![0];
  expect(toast).toMatchObject({ type: "error", title: "The round may not have been sent" });
  const retry = toast.actionProps?.onClick as (() => void) | undefined;
  expect(retry).toBeTypeOf("function");
  await act(() => retry!());

  expect(env.send).toHaveBeenCalledTimes(2);
  const keys = env.send.mock.calls.map(([, target]) => target.input.idempotencyKey);
  expect(keys[1]).toBe(keys[0]);
  expect(keys[0]!.length).toBeGreaterThanOrEqual(8);
  await expect.element(screen.getByRole("button", { name: "Send round" })).toBeEnabled();
});

it("shows a failed review read in the pane with a Retry that subscribes again", async () => {
  let reads = 0;
  const failing = Atom.make((): ReviewResult => {
    reads += 1;
    return AsyncResult.fail(new Iter8ReviewError({ reason: "unavailable" }));
  });
  using env = setup(failing);
  await using screen = await render(env.frame({ url: `${origin}/plans` }));
  await expect.element(screen.getByText("Couldn't read iter8's review state.")).toBeVisible();
  await expect.element(screen.getByTestId("page")).toBeVisible();
  const before = reads;
  await screen.getByRole("button", { name: "Retry" }).click();
  await vi.waitFor(() => expect(reads).toBe(before + 1));
});
