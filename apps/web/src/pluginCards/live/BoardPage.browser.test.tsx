import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  PluginCardError,
  ThreadId,
  type PluginInitiativeBoard,
  type PluginInitiativePart,
  type PluginInitiativeWave,
  type PluginLiveInitiative,
} from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { createContext, use } from "react";
import { expect, it, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";

import { ToastProvider } from "~/components/ui/toast";
import * as pluginCardsRpc from "~/rpc/pluginCards";
import * as environments from "~/state/environments";

import { act, fakeTimers, render } from "../../../test/render";
import { BoardPage } from "./BoardPage";
import { InitiativeDetailsSection } from "./InitiativeDetailsSection";
import { InitiativeBoard } from "./board/InitiativeBoard";
import { boardSearchFromUrl } from "./boardSearch";
import * as liveAtoms from "./liveAtoms";
import type { InitiativeBoardView } from "./liveAtoms";
import { boardInitiatives, type InitiativeNeedsYouItem } from "./liveStateIndex";

import "~/index.css";

vi.mock(import("./liveAtoms"), { spy: true });
vi.mock(import("~/rpc/pluginCards"), { spy: true });
vi.mock(import("~/state/environments"), { spy: true });

const environmentId = EnvironmentId.make("env-a");
const secondEnvironmentId = EnvironmentId.make("env-b");
const now = "2026-11-21T09:05:00Z";
const asOf = "2026-11-21T09:04:00Z";
const mrUrl = "https://example.test/acme/app/-/merge_requests/12";
const loadingList = {
  status: "loading",
  initiatives: [],
} satisfies ReturnType<typeof liveAtoms.useBoardInitiatives>;
const BoardList = createContext<ReturnType<typeof liveAtoms.useBoardInitiatives>>(loadingList);
const ConnectedEnvironments = createContext<ReadonlyArray<EnvironmentId>>([]);

function part(id: string, overrides: Partial<PluginInitiativePart> = {}): PluginInitiativePart {
  return {
    id,
    title: id,
    wave: 1,
    status: "planned",
    phases: [],
    gate: null,
    branch: null,
    mergeRequest: null,
    cost: { usd: null, state: "unknown" },
    startedAt: null,
    lastEventAt: null,
    ...overrides,
  };
}

function wave(
  number: number,
  name: string,
  state: PluginInitiativeWave["state"],
  parts: ReadonlyArray<PluginInitiativePart>,
  overrides: Partial<PluginInitiativeWave> = {},
): PluginInitiativeWave {
  return {
    number,
    name,
    state,
    moreParts: 0,
    partsSettled: 0,
    partsTotal: parts.length,
    parts,
    ...overrides,
  };
}

function board(
  overrides: Partial<PluginInitiativeBoard> = {},
  status: InitiativeBoardView["status"] = "ready",
): InitiativeBoardView {
  return {
    status,
    board: {
      slug: "alpha",
      title: "Alpha",
      closed: false,
      startedAt: "2026-11-21T09:00:00Z",
      asOf,
      headline: { kind: "waiting", nextPart: null },
      parts: { settled: 1, total: 3 },
      spend: { usd: 8, state: "exact", ceilingUsd: 10 },
      currentWave: 2,
      waves: [
        wave(1, "Account access", "done", [part("part-a", { status: "merged" })], {
          partsSettled: 1,
        }),
        wave(2, "Payment retries", "active", [part("part-b", { wave: 2, status: "running" })], {
          moreParts: 2,
        }),
        wave(3, "Receipt history", "waiting", [part("part-c", { wave: 3 })]),
      ],
      needsYou: [],
      ...overrides,
    },
    needsYou: [],
  };
}

function screenFor(view = board()) {
  return <InitiativeBoard environmentId={environmentId} view={view} now={now} />;
}

function liveInitiative(slug: string, title: string | null): PluginLiveInitiative {
  return {
    slug,
    title,
    closed: false,
    wave: { current: 1, total: 2, partsSettled: 1, partsTotal: 2 },
    settled: { count: 7, total: 8 },
    running: 0,
    openDecisions: 0,
    spend: { usd: null, state: "unknown" },
    orchestratorThreadId: null,
    asOf,
    parts: [
      { id: "part-a", title: "part-a", wave: 1, status: "merged", threadIds: [] },
      { id: "part-b", title: "part-b", wave: 2, status: "planned", threadIds: [] },
    ],
  };
}

function openInitiatives(entries: ReadonlyArray<readonly [EnvironmentId, PluginLiveInitiative]>) {
  return boardInitiatives(
    entries.map(([id, initiative]) => ({
      environmentId: id,
      state: { asOf, children: [], decisions: [], waitingThreadIds: [], initiatives: [initiative] },
    })),
  );
}

function boardRouter(initialPath: string) {
  const root = createRootRoute();
  const chat = createRoute({ getParentRoute: () => root, id: "_chat" });
  const boardRoute = createRoute({
    getParentRoute: () => chat,
    path: "/board",
    validateSearch: boardSearchFromUrl,
    component: BoardPage,
  });
  const detailsRoute = createRoute({
    getParentRoute: () => chat,
    path: "/details",
    component: () => (
      <InitiativeDetailsSection
        environmentId={secondEnvironmentId}
        threadId={ThreadId.make("thread-a")}
      />
    ),
  });
  return createRouter({
    routeTree: root.addChildren([chat.addChildren([boardRoute, detailsRoute])]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    disableGlobalCatchBoundary: true,
  });
}

it("opens the initiative named by the details link, even when another initiative is open", async () => {
  const beta = liveInitiative("beta", "Beta");
  using _thread = vi.spyOn(liveAtoms, "useThreadInitiative").mockReturnValue(beta);
  using _connected = vi
    .spyOn(environments, "useConnectedEnvironmentIds")
    .mockReturnValue([environmentId, secondEnvironmentId]);
  using _list = vi.spyOn(liveAtoms, "useBoardInitiatives").mockReturnValue({
    status: "ready",
    initiatives: openInitiatives([
      [environmentId, liveInitiative("alpha", "Alpha")],
      [secondEnvironmentId, beta],
    ]),
  });
  using subscription = vi
    .spyOn(liveAtoms, "useInitiativeBoard")
    .mockReturnValue(board({ slug: "beta", title: "Beta" }));
  const router = boardRouter("/details");
  // The default fixture router lacks the board route and its search validator.
  await using screen = await render(<RouterProvider router={router} />, { router: false });
  const link = screen.getByRole("link", { name: "Beta" });
  await expect.element(link).toHaveAttribute("href", "/board?environmentId=env-b&slug=beta");
  await link.click();
  await expect.element(screen.getByRole("heading", { level: 1, name: "Beta" })).toBeVisible();
  expect(subscription).toHaveBeenCalledWith(secondEnvironmentId, "beta");
  await expect
    .element(screen.getByRole("link", { name: "Board" }))
    .toHaveAttribute("href", "/board");
});

it("settles bare Board from the loading list to the only open initiative", async () => {
  using _connected = vi
    .spyOn(environments, "useConnectedEnvironmentIds")
    .mockReturnValue([environmentId]);
  using _list = vi.spyOn(liveAtoms, "useBoardInitiatives").mockImplementation(() => use(BoardList));
  using subscription = vi.spyOn(liveAtoms, "useInitiativeBoard").mockReturnValue(board());
  const router = boardRouter("/board");
  // This fixture supplies the board route.
  await using screen = await render(
    <BoardList value={loadingList}>
      <RouterProvider router={router} />
    </BoardList>,
    { router: false },
  );
  await vi.waitFor(() => {
    expect(screen.container.querySelector('[aria-busy="true"]')).toBeVisible();
  });
  await screen.rerender(
    <BoardList
      value={{
        status: "ready",
        initiatives: openInitiatives([[environmentId, liveInitiative("alpha", "Alpha")]]),
      }}
    >
      <RouterProvider router={router} />
    </BoardList>,
  );
  await expect.element(screen.getByRole("heading", { level: 1, name: "Alpha" })).toBeVisible();
  expect(subscription).toHaveBeenCalledWith(environmentId, "alpha");
});

it("lists several open initiatives with their own environment, slug and part counts", async () => {
  using _connected = vi
    .spyOn(environments, "useConnectedEnvironmentIds")
    .mockReturnValue([environmentId, secondEnvironmentId]);
  using _labels = vi.spyOn(environments, "useEnvironmentIdentities").mockReturnValue([
    { environmentId, label: "Laptop" },
    { environmentId: secondEnvironmentId, label: "Workspace" },
  ]);
  using _list = vi.spyOn(liveAtoms, "useBoardInitiatives").mockReturnValue({
    status: "ready",
    initiatives: openInitiatives([
      [environmentId, liveInitiative("alpha", "Alpha")],
      [secondEnvironmentId, liveInitiative("beta", null)],
    ]),
  });
  const router = boardRouter("/board");
  // This fixture supplies the board route.
  await using screen = await render(<RouterProvider router={router} />, { router: false });
  await expect
    .element(screen.getByRole("link", { name: "Alpha Laptop 1 of 2 parts settled" }))
    .toHaveAttribute("href", "/board?environmentId=env-a&slug=alpha");
  await expect
    .element(screen.getByRole("link", { name: "beta Workspace 1 of 2 parts settled" }))
    .toHaveAttribute("href", "/board?environmentId=env-b&slug=beta");
});

it("shows the empty state on bare Board when there are no open initiatives", async () => {
  using _connected = vi.spyOn(environments, "useConnectedEnvironmentIds").mockReturnValue([]);
  using _list = vi
    .spyOn(liveAtoms, "useBoardInitiatives")
    .mockReturnValue({ status: "ready", initiatives: [] });
  const router = boardRouter("/board");
  // This fixture supplies the board route.
  await using screen = await render(<RouterProvider router={router} />, { router: false });
  await expect.element(screen.getByText("No open initiatives", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByText("Initiatives started with dispatch appear here while they are open."))
    .toBeVisible();
});

it("explains a disconnected environment and opens the named board when it reconnects", async () => {
  using _connected = vi
    .spyOn(environments, "useConnectedEnvironmentIds")
    .mockImplementation(() => use(ConnectedEnvironments));
  using _list = vi
    .spyOn(liveAtoms, "useBoardInitiatives")
    .mockReturnValue({ status: "loading", initiatives: [] });
  using subscription = vi.spyOn(liveAtoms, "useInitiativeBoard").mockReturnValue(board());
  const router = boardRouter("/board?environmentId=env-b&slug=alpha");
  // This fixture supplies the board route.
  await using screen = await render(
    <ConnectedEnvironments value={[environmentId]}>
      <RouterProvider router={router} />
    </ConnectedEnvironments>,
    { router: false },
  );
  await expect
    .element(screen.getByText("This initiative's environment isn't connected"))
    .toBeVisible();
  await expect
    .element(screen.getByText("It opens when that environment reconnects."))
    .toBeVisible();
  expect(subscription).not.toHaveBeenCalled();
  await screen.rerender(
    <ConnectedEnvironments value={[environmentId, secondEnvironmentId]}>
      <RouterProvider router={router} />
    </ConnectedEnvironments>,
  );
  await expect.element(screen.getByRole("heading", { level: 1, name: "Alpha" })).toBeVisible();
  expect(subscription).toHaveBeenCalledWith(secondEnvironmentId, "alpha");
});

it.each(["/board?environmentId=env-a&slug=missing", "/board?slug=missing"])(
  "settles an unreadable named board at %s and clears its search via the fallback link",
  async (path) => {
    using _connected = vi
      .spyOn(environments, "useConnectedEnvironmentIds")
      .mockReturnValue([environmentId]);
    using _list = vi
      .spyOn(liveAtoms, "useBoardInitiatives")
      .mockReturnValue({ status: "ready", initiatives: [] });
    using subscription = vi.spyOn(liveAtoms, "useInitiativeBoard").mockReturnValue({
      status: "unavailable",
      board: null,
      needsYou: [],
    });
    const router = boardRouter(path);
    // This fixture supplies the board route.
    await using screen = await render(<RouterProvider router={router} />, { router: false });
    await expect.element(screen.getByText("Can't read this initiative right now")).toBeVisible();
    expect(subscription).toHaveBeenCalledWith(environmentId, "missing");
    const all = screen.getByRole("link", { name: "All initiatives" });
    await expect.element(all).toHaveAttribute("href", "/board");
    await all.click();
    await expect.element(screen.getByText("No open initiatives")).toBeVisible();
  },
);

it("settles an unresolved slug on a multi-environment board without opening an unrelated initiative", async () => {
  using _connected = vi
    .spyOn(environments, "useConnectedEnvironmentIds")
    .mockReturnValue([environmentId, secondEnvironmentId]);
  using _list = vi.spyOn(liveAtoms, "useBoardInitiatives").mockReturnValue({
    status: "ready",
    initiatives: openInitiatives([[environmentId, liveInitiative("alpha", "Alpha")]]),
  });
  using subscription = vi.spyOn(liveAtoms, "useInitiativeBoard").mockReturnValue(board());
  const router = boardRouter("/board?slug=missing");
  // This fixture supplies the board route.
  await using screen = await render(<RouterProvider router={router} />, { router: false });
  await expect.element(screen.getByText("Can't read this initiative right now")).toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: "All initiatives" }))
    .toHaveAttribute("href", "/board");
  expect(subscription).not.toHaveBeenCalled();
});

it("shows a title, thin metric bars, running parts and snapshot ages", async () => {
  const active = wave(1, "Payment retries", "active", [
    part("part-a", { title: "Payment retries", status: "running" }),
    part("part-b", { title: "Receipt history", status: "gating" }),
    part("part-c", { title: "Account access", status: "queued" }),
  ]);
  await using screen = await render(
    screenFor(board({ waves: [active], parts: { settled: 1, total: 4 } })),
  );
  await expect.element(screen.getByRole("heading", { level: 2, name: "Alpha" })).toBeVisible();
  await expect
    .element(
      screen.getByText("4 parts in 1 wave · started 5m ago · updated 1m ago", { exact: true }),
    )
    .toBeVisible();
  const settled = screen.getByLabelText("Parts settled: 1 of 4").element();
  const spend = screen.getByLabelText("Spend: $8.00 of $10.00").element();
  expect(settled.querySelector('[style*="25%"]')).toBeVisible();
  expect(spend.querySelector('[style*="80%"]')).toHaveClass("bg-warning");
  await expect
    .element(screen.getByText("Payment retries, Receipt history", { exact: true }))
    .toBeVisible();
});

it.each([
  [{ kind: "closed" }, "This initiative is closed."],
  [
    { kind: "needs-you", decisions: 1, part: "part-a" },
    "A decision from Account access needs your answer.",
  ],
  [
    { kind: "needs-you", decisions: 2, part: "part-a" },
    "2 decisions need your answer, the oldest from Account access.",
  ],
  [{ kind: "needs-you", decisions: 1, part: null }, "A decision needs your answer."],
  [{ kind: "needs-you", decisions: 2, part: null }, "2 decisions need your answer."],
  [{ kind: "failing", part: "part-a", failedChecks: 0 }, "Account access failed its gate."],
  [
    { kind: "failing", part: "part-a", failedChecks: 1 },
    "Account access failed its gate with one failing check.",
  ],
  [
    { kind: "failing", part: "part-a", failedChecks: 2 },
    "Account access failed its gate with 2 failing checks.",
  ],
  [{ kind: "gating", part: "part-a" }, "Account access is running its gate."],
  [
    { kind: "running", part: "part-a", phase: { index: 2, total: 3 }, nextPart: "part-b" },
    "Account access is on phase 2 of 3. Payment retries is next.",
  ],
  [{ kind: "running", part: "part-a", phase: null, nextPart: null }, "Account access is running."],
  [{ kind: "waiting", nextPart: "part-a" }, "Waiting to start Account access."],
  [{ kind: "waiting", nextPart: null }, "Waiting for the next wave to open."],
  [{ kind: "done" }, "Every part is settled."],
] satisfies ReadonlyArray<readonly [PluginInitiativeBoard["headline"], string]>)(
  "renders the headline as %j and %s",
  async (headline, sentence) => {
    await using screen = await render(
      screenFor(
        board({
          headline,
          waves: [
            wave(1, "Account access", "active", [
              part("part-a", { title: "Account access" }),
              part("part-b", { title: "Payment retries" }),
            ]),
          ],
        }),
      ),
    );
    await expect.element(screen.getByText(sentence, { exact: true })).toBeVisible();
  },
);

it("settles loading on a ready board, then keeps rows during a failure and clears the note on recovery", async () => {
  await page.viewport(1000, 700);
  await using screen = await render(screenFor({ status: "loading", board: null, needsYou: [] }));
  const busy = () => screen.container.querySelector('[aria-busy="true"]');
  expect(busy()).toBeVisible();
  expect(busy()?.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(3);
  await screen.rerender(screenFor());
  expect(busy()).toBeNull();
  const row = screen.getByRole("group", { name: "part-b, Running" });
  await expect.element(row).toBeVisible();
  await screen.rerender(screenFor(board({}, "unavailable")));
  await expect.element(row).toBeVisible();
  const paused = screen.getByText("Updates paused: can't reach the server");
  await expect.element(paused).toBeVisible();
  await screen.rerender(screenFor());
  await expect.element(paused).not.toBeInTheDocument();
  await expect.element(row).toBeVisible();
});

it("replaces the initial placeholders with recovery instructions if no board arrived", async () => {
  await using screen = await render(screenFor({ status: "loading", board: null, needsYou: [] }));
  await screen.rerender(screenFor({ status: "unavailable", board: null, needsYou: [] }));
  await expect.element(screen.getByText("Can't read this initiative right now")).toBeVisible();
  await expect
    .element(screen.getByText("The board refreshes when the server reconnects."))
    .toBeVisible();
  expect(screen.container.querySelector('[aria-busy="true"]')).toBeNull();
});

it("shows the empty board under its slug heading when its title and waves are absent", async () => {
  await using screen = await render(
    screenFor(
      board({
        title: null,
        startedAt: null,
        waves: [],
        parts: { settled: 0, total: 0 },
        spend: { state: "unknown", usd: null, ceilingUsd: null },
      }),
    ),
  );
  await expect.element(screen.getByRole("heading", { level: 2, name: "alpha" })).toBeVisible();
  await expect.element(screen.getByText("No parts yet")).toBeVisible();
  await expect
    .element(screen.getByText("0 parts in 0 waves · updated 1m ago", { exact: true }))
    .toBeVisible();
  await expect.element(screen.getByText("Unknown", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Nothing", { exact: true })).toBeVisible();
});

it("opens waves by state until the user toggles each wave independently", async () => {
  await page.viewport(1000, 700);
  const first = wave(1, "Account access", "done", [part("part-a")], { partsSettled: 1 });
  const second = wave(2, "Payment retries", "active", [part("part-b")], { moreParts: 2 });
  const third = wave(3, "Receipt history", "waiting", [part("part-c")]);
  const content = (state: PluginInitiativeWave["state"]) =>
    screenFor(board({ waves: [first, second, { ...third, state }] }));
  await using screen = await render(content("waiting"));
  const done = screen.getByRole("button", {
    name: /Account access wave 1 of 3 · done 1 of 1 settled/,
  });
  const active = screen.getByRole("button", {
    name: /Payment retries and 2 more wave 2 of 3 · in progress/,
  });
  const next = screen.getByRole("button", { name: /^Receipt history/ });
  await expect.element(done).toHaveAttribute("aria-expanded", "false");
  await expect.element(active).toHaveAttribute("aria-expanded", "true");
  await expect.element(next).toHaveAttribute("aria-expanded", "false");
  await expect.element(next).toHaveAccessibleName(/wave 3 of 3 · waits on Payment retries/);
  await expect.element(screen.getByText("part-b", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("part-a", { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText("part-c", { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText(/wave 0/i)).not.toBeInTheDocument();

  await screen.rerender(content("active"));
  await expect.element(next).toHaveAttribute("aria-expanded", "true");
  await expect.element(screen.getByText("part-c", { exact: true })).toBeVisible();
  await screen.rerender(content("waiting"));
  await expect.element(next).toHaveAttribute("aria-expanded", "false");

  await next.click();
  await expect.element(next).toHaveAttribute("aria-expanded", "true");
  await active.click();
  await expect.element(active).toHaveAttribute("aria-expanded", "false");
  await screen.rerender(content("done"));
  await expect.element(next).toHaveAttribute("aria-expanded", "true");
  await expect.element(active).toHaveAttribute("aria-expanded", "false");
});

it("names a first waiting wave without inventing a predecessor", async () => {
  await using screen = await render(
    screenFor(board({ waves: [wave(1, "Account access", "waiting", [])] })),
  );
  await expect
    .element(
      screen.getByRole("button", { name: "Account access wave 1 of 1 · waiting 0 of 0 settled" }),
    )
    .toHaveAttribute("aria-expanded", "false");
});

it("renders phase segments, MR links, cost and age from the part snapshot", async () => {
  await page.viewport(1000, 700);
  const current = part("part-a", {
    status: "running",
    phases: [
      { id: "phase-a", name: "Account access", state: "done", attempt: 1 },
      { id: "phase-b", name: "Payment retries", state: "running", attempt: 1 },
      { id: "phase-c", name: "Receipt history", state: "pending", attempt: null },
    ],
    mergeRequest: { ref: "acme/app!12", number: 12, url: mrUrl },
    cost: { usd: 1.25, state: "estimated" },
    lastEventAt: "2026-11-21T09:03:00Z",
  });
  await using screen = await render(
    screenFor(
      board({
        waves: [wave(1, "Payment retries", "active", [current, part("part-b")])],
      }),
    ),
  );
  await expect
    .element(screen.getByText("Phase 2 of 3 · Payment retries", { exact: true }))
    .toBeVisible();
  const progress = screen.getByRole("img", { name: "1 of 3 phases done" });
  await expect.element(progress.getByText("1/3", { exact: true })).toBeVisible();
  expect(
    Array.from(
      progress.element().querySelectorAll('span[class*="transition-colors"]'),
      (segment) => segment.className,
    ),
  ).toEqual([
    expect.stringContaining("bg-foreground/60"),
    expect.stringContaining("bg-info"),
    expect.stringContaining("bg-muted-foreground/22"),
  ]);
  const link = screen.getByRole("link", { name: "!12" });
  await expect.element(link).toHaveAttribute("href", mrUrl);
  await expect.element(link).toHaveAttribute("target", "_blank");
  await expect.element(link).toHaveAttribute("rel", "noreferrer");
  await expect.element(screen.getByText("~$1.25 · 2m", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Not split", { exact: true })).toBeVisible();
});

it.each([
  [0, null, "Gate failed"],
  [1, 1, "One gate check failing"],
  [2, 2, "2 gate checks failing · attempt 2"],
] as const)(
  "words a gate failure with %i failed checks and attempt %s",
  async (count, attempt, status) => {
    await page.viewport(1000, 700);
    const failed = part("part-a", {
      status: "gate-fail",
      phases: [{ id: "phase-a", name: "Account access", state: "done", attempt }],
      gate: {
        state: "failed",
        at: asOf,
        checks: [
          ...Array.from({ length: count }, (_, index) => ({
            id: `check-${index}`,
            state: "fail" as const,
            summary: "Payment retries",
          })),
          { id: "check-pass", state: "pass", summary: "Account access" },
        ],
      },
    });
    await using screen = await render(
      screenFor(board({ waves: [wave(1, "Account access", "active", [failed])] })),
    );
    await expect.element(screen.getByText(status, { exact: true })).toBeVisible();
    await expect.element(screen.getByText("After gate", { exact: true })).toBeVisible();
  },
);

it.each([
  ["planned", "Planned", "circle"],
  ["briefed", "Briefed", "circle"],
  ["specced", "Spec written", "circle-dot-dashed"],
  ["queued", "Up next", "clock"],
  ["running", "Running", "circle-dashed"],
  ["gating", "Running the gate", "circle-dashed"],
  ["gate-fail", "Gate failed", "circle-alert"],
  ["gate-pass", "Gate passed", "circle-check"],
  ["mr-open", "MR open", "git-pull-request-arrow"],
  ["merged", "Merged", "circle-check"],
] satisfies ReadonlyArray<readonly [PluginInitiativePart["status"], string, string]>)(
  "prints the %s status text and icon",
  async (status, label, iconName) => {
    await page.viewport(1000, 700);
    const row = part("part-a", { status });
    await using screen = await render(
      screenFor(board({ waves: [wave(1, "Account access", "active", [row])] })),
    );
    const group = screen.getByRole("group", { name: `part-a, ${label}` });
    expect(group.element().querySelector(`svg.lucide-${iconName}`)).toBeVisible();
    expect(group.getByText(label, { exact: true }).element()).toBeVisible();
  },
);

it("keeps a ref-only MR as text and shows a positive cost without an event age", async () => {
  await page.viewport(1000, 700);
  const row = part("part-a", {
    status: "mr-open",
    mergeRequest: { ref: "acme/app!12", number: null, url: null },
    cost: { usd: 2, state: "incomplete" },
  });
  await using screen = await render(
    screenFor(board({ waves: [wave(1, "Account access", "active", [row])] })),
  );
  await expect.element(screen.getByText("acme/app!12", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("link", { name: "acme/app!12" })).not.toBeInTheDocument();
  await expect.element(screen.getByText("$2.00+", { exact: true })).toBeVisible();
});

it("re-enters the icon and tint for status changes only, including a return to the first status", async () => {
  const content = (status: PluginInitiativePart["status"], lastEventAt: string | null = null) =>
    screenFor(
      board({
        waves: [wave(1, "Account access", "active", [part("part-a", { status, lastEventAt })])],
      }),
    );
  await using screen = await render(content("running"));
  const initialRow = screen.getByRole("group", { name: "part-a, Running" });
  const initialIcon = initialRow.element().querySelector("svg");
  const tintSelector = '[class*="starting:opacity-100"]';
  expect(initialRow.element().querySelector(tintSelector)).toBeNull();

  await screen.rerender(content("gating"));
  const gatingRow = screen.getByRole("group", { name: "part-a, Running the gate" });
  const icon = gatingRow.element().querySelector("svg");
  const tint = gatingRow.element().querySelector(tintSelector);
  expect(icon).not.toBe(initialIcon);
  expect(icon).toHaveClass("motion-safe:starting:opacity-0", "motion-safe:starting:scale-50");
  expect(icon && getComputedStyle(icon).transitionDuration).toBe("0.15s");
  expect(tint && getComputedStyle(tint).transitionDuration).toBe("1s");

  await screen.rerender(content("gating", asOf));
  expect(gatingRow.element().querySelector("svg")).toBe(icon);
  expect(gatingRow.element().querySelector(tintSelector)).toBe(tint);

  await screen.rerender(content("running", asOf));
  expect(initialRow.element().querySelector("svg")).not.toBe(icon);
  const returnedTint = initialRow.element().querySelector(tintSelector);
  expect(returnedTint).toBeInstanceOf(HTMLSpanElement);
  expect(returnedTint).not.toBe(tint);
});

it("changes the status icon without a transition or tint when reduced motion is preferred", async () => {
  const content = (status: PluginInitiativePart["status"]) =>
    screenFor(
      board({ waves: [wave(1, "Account access", "active", [part("part-a", { status })])] }),
    );
  await using screen = await render(content("queued"));
  const session = cdp();
  await session.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await using _preference = {
    [Symbol.asyncDispose]: async () => {
      await session.send("Emulation.setEmulatedMedia", { features: [] });
    },
  };
  expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
  await screen.rerender(content("merged"));
  const row = screen.getByRole("group", { name: "part-a, Merged" }).element();
  const icon = row.querySelector("svg.lucide-circle-check");
  const tint = row.querySelector('[class*="starting:opacity-100"]');
  expect(icon).toBeVisible();
  expect(icon && getComputedStyle(icon).transitionProperty).toBe("none");
  expect(icon && getComputedStyle(icon).opacity).toBe("1");
  expect(tint && getComputedStyle(tint).display).toBe("none");
});

function partDetails(overrides: Partial<PluginInitiativePart> = {}) {
  return part("part-a", {
    title: "Checkout retries",
    wave: 2,
    status: "running",
    branch: "checkout-retries",
    mergeRequest: { ref: "acme/app!12", number: 12, url: mrUrl },
    startedAt: "2026-11-21T09:00:00Z",
    lastEventAt: "2026-11-21T09:03:00Z",
    cost: { usd: 1.25, state: "estimated" },
    phases: [
      { id: "phase-a", name: "Account access", state: "done", attempt: 1 },
      { id: "phase-b", name: "Payment retries", state: "running", attempt: 2 },
      { id: "phase-c", name: "Receipt history", state: "stale", attempt: null },
      { id: "phase-d", name: "Order history", state: "stale", attempt: null },
      { id: "phase-e", name: "Receipt emails", state: "pending", attempt: null },
      { id: "phase-f", name: "Order emails", state: "failed", attempt: 0 },
    ],
    gate: {
      state: "failed",
      at: asOf,
      checks: [
        { id: "typecheck", state: "pass", summary: "Types match" },
        { id: "tests", state: "fail", summary: "One retry timed out" },
      ],
    },
    ...overrides,
  });
}

function sheetBoard(
  parts: ReadonlyArray<PluginInitiativePart>,
  status: InitiativeBoardView["status"] = "ready",
) {
  return screenFor(board({ waves: [wave(2, "Checkout", "active", parts)] }, status));
}

it("opens the selected row's sheet with details, phases, attempts and gate check summaries", async () => {
  await using screen = await render(sheetBoard([part("part-b"), partDetails()]));
  const row = screen.getByRole("button", {
    name: "Checkout retries, Phase 2 of 6 · Payment retries. Open details",
    exact: true,
  });
  const dialog = page.getByRole("dialog", { name: "Checkout retries" });
  await expect.element(dialog).not.toBeInTheDocument();
  await row.click();
  await expect
    .element(dialog)
    .toHaveAccessibleDescription("Wave 2 · Checkout · Phase 2 of 6 · Payment retries");
  for (const [label, value] of [
    ["Branch", "checkout-retries"],
    ["Merge request", "!12"],
    ["Started", "5m ago"],
    ["Last activity", "2m ago"],
    ["Cost", "~$1.25"],
  ] as const) {
    const term = dialog.getByText(label, { exact: true });
    await expect.element(term).toBeVisible();
    expect(term.element().nextElementSibling?.textContent).toBe(value);
  }
  for (const [label, href] of [
    ["!12", mrUrl],
    ["Open MR", mrUrl],
  ] as const) {
    const link = dialog.getByRole("link", { name: label, exact: true });
    await expect.element(link).toHaveAttribute("href", href);
    await expect.element(link).toHaveAttribute("target", "_blank");
    await expect.element(link).toHaveAttribute("rel", "noreferrer");
  }
  await expect.element(dialog.getByText("Phases · 1 of 6 done", { exact: true })).toBeVisible();
  for (const [phase, state] of [
    ["Account access", "Done · attempt 1"],
    ["Payment retries", "Running · attempt 2"],
    ["Receipt history", "Next"],
    ["Order history", "Stale"],
    ["Receipt emails", "Pending"],
    ["Order emails", "Failed · attempt 0"],
  ] as const) {
    await expect.element(dialog.getByText(phase, { exact: true })).toBeVisible();
    expect(dialog.getByText(phase, { exact: true }).element().nextElementSibling?.textContent).toBe(
      state,
    );
  }
  await expect.element(dialog.getByText("Gate · failed · 1m ago", { exact: true })).toBeVisible();
  await expect.element(dialog.getByText("No check details yet")).not.toBeInTheDocument();
  for (const [check, summary, state, icon] of [
    ["typecheck", "Types match", "Passed", "circle-check"],
    ["tests", "One retry timed out", "Failed", "circle-x"],
  ] as const) {
    await expect.element(dialog.getByText(summary, { exact: true })).toBeVisible();
    const label = dialog.getByText(check, { exact: true }).element();
    expect(label.nextElementSibling).toHaveTextContent(summary);
    const stateIcon = dialog.getByRole("img", { name: state, exact: true });
    await expect.element(stateIcon).toHaveClass(`lucide-${icon}`);
    expect(label.parentElement?.previousElementSibling).toBe(stateIcon.element());
  }
});

it("closes the sheet and returns focus to its row on Escape and on Close", async () => {
  await using screen = await render(sheetBoard([part("part-b"), partDetails()]));
  const row = screen.getByRole("button", { name: /^Checkout retries, .*\. Open details$/ });
  const dialog = page.getByRole("dialog", { name: "Checkout retries" });
  await row.click();
  await expect.element(dialog.getByRole("link", { name: "!12" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(row).toHaveFocus();

  await userEvent.keyboard("{Enter}");
  await expect.element(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(row).toHaveFocus();
});

it("copies the displayed branch from the sheet", async () => {
  await using screen = await render(sheetBoard([partDetails({ mergeRequest: null })]));
  using write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  await screen.getByRole("button", { name: /^Checkout retries, .*\. Open details$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Checkout retries" });
  await dialog.getByRole("button", { name: "Copy branch" }).click();
  await expect.element(dialog.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(write.mock.calls).toEqual([["checkout-retries"]]);
  await expect.element(dialog.getByRole("link", { name: "Open MR" })).not.toBeInTheDocument();
});

it("offers Open MR without a branch and uses the ref when the request has no number", async () => {
  const row = partDetails({
    branch: null,
    mergeRequest: { ref: "acme/app!12", number: null, url: mrUrl },
  });
  await using screen = await render(sheetBoard([row]));
  await screen.getByRole("button", { name: /^Checkout retries, .*\. Open details$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Checkout retries" });
  await expect
    .element(dialog.getByRole("link", { name: "acme/app!12" }))
    .toHaveAttribute("href", mrUrl);
  await expect
    .element(dialog.getByRole("link", { name: "Open MR" }))
    .toHaveAttribute("href", mrUrl);
  await expect.element(dialog.getByRole("button", { name: "Copy branch" })).not.toBeInTheDocument();
});

it("opens from the row surface and keeps the row's MR link independently clickable", async () => {
  await page.viewport(1000, 700);
  await using screen = await render(sheetBoard([partDetails()]));
  const link = screen.getByRole("link", { name: "!12" });
  const clicked = vi.fn((event: Event) => event.preventDefault());
  link.element().addEventListener("click", clicked, { once: true });
  await link.click();
  expect(clicked).toHaveBeenCalledOnce();
  const dialog = page.getByRole("dialog", { name: "Checkout retries" });
  await expect.element(dialog).not.toBeInTheDocument();

  await screen.getByRole("group", { name: /^Checkout retries, Phase 2 of 6/ }).click();
  await expect.element(dialog).toBeVisible();
});

it("updates the open sheet with the selected part and closes it when that part leaves", async () => {
  await using screen = await render(sheetBoard([partDetails(), part("part-b")]));
  await screen.getByRole("button", { name: /^Checkout retries, .*\. Open details$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Checkout retries" });
  await expect.element(dialog).toBeVisible();
  const failed = partDetails({ status: "gate-fail", wave: 3, branch: "checkout-retries-v2" });
  await screen.rerender(screenFor(board({ waves: [wave(3, "Payments", "active", [failed])] })));
  await expect
    .element(dialog)
    .toHaveAccessibleDescription("Wave 3 · Payments · One gate check failing · attempt 2");
  await expect.element(dialog.getByText("checkout-retries-v2", { exact: true })).toBeVisible();
  await expect
    .element(dialog.getByText("checkout-retries", { exact: true }))
    .not.toBeInTheDocument();

  await screen.rerender(sheetBoard([part("part-b")]));
  await expect.element(dialog).not.toBeInTheDocument();
  await screen.rerender(sheetBoard([partDetails(), part("part-b")]));
  await expect.element(dialog).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "part-b, Planned. Open details" }).click();
  await expect.element(page.getByRole("dialog", { name: "part-b" })).toBeVisible();
});

it("explains what is still missing for an unsplit planned part without empty sections or actions", async () => {
  await using screen = await render(
    sheetBoard([part("part-a", { title: "", cost: { usd: 0, state: "exact" } })]),
  );
  await screen.getByRole("button", { name: "part-a, Planned. Open details" }).click();
  const dialog = page.getByRole("dialog", { name: "part-a" });
  await expect.element(dialog).toHaveAccessibleDescription("Wave 2 · Checkout · Planned");
  for (const label of [
    "Created when the part starts",
    "Opens after the gate passes",
    "Not started",
    "No activity yet",
    "Nothing spent yet",
  ]) {
    await expect.element(dialog.getByText(label, { exact: true })).toBeVisible();
  }
  await expect.element(dialog.getByText(/^Phases ·/)).not.toBeInTheDocument();
  await expect.element(dialog.getByText(/^Gate ·/)).not.toBeInTheDocument();
  await expect.element(dialog.getByRole("button", { name: "Copy branch" })).not.toBeInTheDocument();
  await expect.element(dialog.getByRole("link", { name: "Open MR" })).not.toBeInTheDocument();
  await expect.element(dialog.getByRole("button", { name: "Close" })).toBeVisible();
  expect(dialog.element().querySelector('[data-slot="sheet-footer"]')).toBeNull();
});

it.each([
  ["gate-pass", null, "None"],
  ["mr-open", { ref: "acme/app!12", number: 12, url: null }, "acme/app!12"],
  ["mr-open", null, "None"],
  ["merged", null, "None"],
] satisfies ReadonlyArray<
  readonly [PluginInitiativePart["status"], PluginInitiativePart["mergeRequest"], string]
>)("shows the MR detail for a %s part without an MR URL", async (status, mergeRequest, label) => {
  await using screen = await render(sheetBoard([part("part-a", { status, mergeRequest })]));
  await screen.getByRole("button", { name: /^part-a, .*\. Open details$/ }).click();
  const dialog = page.getByRole("dialog", { name: "part-a" });
  await expect.element(dialog.getByText(label, { exact: true })).toBeVisible();
  await expect.element(dialog.getByRole("link")).not.toBeInTheDocument();
});

it("uses missing-time labels for invalid timestamps carried by a snapshot", async () => {
  const row = part("part-a", {
    startedAt: "invalid",
    lastEventAt: "",
    gate: { state: "passed", at: "invalid", checks: [] },
  });
  await using screen = await render(sheetBoard([row]));
  await screen.getByRole("button", { name: "part-a, Planned. Open details" }).click();
  const dialog = page.getByRole("dialog", { name: "part-a" });
  await expect.element(dialog.getByText("Not started", { exact: true })).toBeVisible();
  await expect.element(dialog.getByText("No activity yet", { exact: true })).toBeVisible();
  await expect.element(dialog.getByText("Gate · passed", { exact: true })).toBeVisible();
});

it("keeps the open sheet on the last snapshot while updates are paused and refreshes on recovery", async () => {
  const row = partDetails();
  await using screen = await render(sheetBoard([row]));
  await screen.getByRole("button", { name: /^Checkout retries, .*\. Open details$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Checkout retries" });
  await expect.element(dialog).toBeVisible();
  await screen.rerender(sheetBoard([row], "unavailable"));
  const paused = screen.getByText("Updates paused: can't reach the server");
  await expect.element(paused).toBeVisible();
  await expect.element(dialog.getByText("checkout-retries", { exact: true })).toBeVisible();
  await expect.element(dialog.getByText("One retry timed out", { exact: true })).toBeVisible();

  await screen.rerender(sheetBoard([{ ...row, branch: "checkout-retries-v2" }]));
  await expect.element(paused).not.toBeInTheDocument();
  await expect.element(dialog.getByText("checkout-retries-v2", { exact: true })).toBeVisible();
});

it("offers no row to open while a board is loading, even with a previous snapshot", async () => {
  await using screen = await render(sheetBoard([partDetails()], "loading"));
  const row = screen.getByRole("button", { name: /Open details$/ });
  await expect.element(row).not.toBeInTheDocument();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await screen.rerender(sheetBoard([partDetails()]));
  await row.click();
  await expect.element(page.getByRole("dialog", { name: "Checkout retries" })).toBeVisible();
  await screen.rerender(sheetBoard([partDetails()], "loading"));
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect.element(row).not.toBeInTheDocument();
});

it.each([
  ["running", now, "Gate · running · just now"],
  ["passed", null, "Gate · passed"],
  ["failed", asOf, "Gate · failed · 1m ago"],
] as const)("shows a %s gate with no check details", async (state, at, label) => {
  const row = part("part-a", { gate: { state, at, checks: [] } });
  await using screen = await render(sheetBoard([row]));
  await screen.getByRole("button", { name: "part-a, Planned. Open details" }).click();
  const dialog = page.getByRole("dialog", { name: "part-a" });
  await expect.element(dialog.getByText(label, { exact: true })).toBeVisible();
  await expect.element(dialog.getByText("No check details yet", { exact: true })).toBeVisible();
  await expect.element(dialog.getByText(/^Phases ·/)).not.toBeInTheDocument();
  await expect.element(dialog.getByRole("list")).not.toBeInTheDocument();
});

it("opens the sheet without a transition under reduced motion", async () => {
  await using screen = await render(sheetBoard([partDetails()]));
  const session = cdp();
  await session.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await using _preference = {
    [Symbol.asyncDispose]: async () => {
      await session.send("Emulation.setEmulatedMedia", { features: [] });
    },
  };
  await screen.getByRole("button", { name: /^Checkout retries, .*\. Open details$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Checkout retries" });
  await expect.element(dialog).toBeVisible();
  expect(getComputedStyle(dialog.element()).transitionProperty).toBe("none");
});

function decision(overrides: Partial<InitiativeNeedsYouItem> = {}): InitiativeNeedsYouItem {
  return {
    cardId: "dispatch.decision:alpha#decision-a",
    decisionId: "decision-a",
    kind: "scope",
    question: "Continue checkout?",
    part: "part-a",
    options: [
      { key: "keep", label: "Keep checkout", recommended: true },
      { key: "skip", label: "Skip checkout", recommended: false },
    ],
    defaultKey: null,
    applyAfter: null,
    protection: null,
    needsPerson: true,
    raisedAt: asOf,
    threadId: ThreadId.make("thread-a"),
    answerableInPlace: true,
    ...overrides,
  };
}

function anotherDecision(): InitiativeNeedsYouItem {
  return decision({
    cardId: "dispatch.decision:alpha#decision-b",
    decisionId: "decision-b",
    question: "Continue receipts?",
    part: "part-b",
    threadId: ThreadId.make("thread-b"),
    options: [{ key: "keep", label: "Keep receipts", recommended: true }],
  });
}

type AnswerResult = Awaited<ReturnType<typeof pluginCardsRpc.answerPluginDecision.run>>;

function setup({ canAnswer = true }: { canAnswer?: boolean } = {}) {
  const stack = new DisposableStack();
  const registry = stack.adopt(AtomRegistry.make(), (value) => value.dispose());
  stack.use(
    vi
      .spyOn(pluginCardsRpc.answerPluginDecision, "permissionAtom")
      .mockReturnValue(Atom.make(canAnswer)),
  );
  const calls: Array<PromiseWithResolvers<AnswerResult>> = [];
  const answer = stack.use(
    vi.spyOn(pluginCardsRpc.answerPluginDecision, "run").mockImplementation(() => {
      const call = Promise.withResolvers<AnswerResult>();
      calls.push(call);
      return call.promise;
    }),
  );

  const ui = (items: ReadonlyArray<InitiativeNeedsYouItem>, time = now, showBoard = true) => (
    <RegistryContext.Provider value={registry}>
      <ToastProvider>
        {showBoard ? (
          <InitiativeBoard
            environmentId={environmentId}
            view={{
              ...board({
                waves: [
                  wave(1, "Checkout", "active", [
                    part("part-a", { title: "Checkout retries" }),
                    part("part-b", { title: "Receipt history" }),
                  ]),
                ],
                needsYou: items,
              }),
              needsYou: items,
            }}
            now={time}
          />
        ) : null}
      </ToastProvider>
    </RegistryContext.Provider>
  );

  return { ui, answer, calls, [Symbol.dispose]: () => stack.dispose() };
}

it.each([
  ["2026-11-21T09:04:00Z", "Checkout retries · Continues with Skip checkout in 2 minutes"],
  ["2026-11-21T09:05:00Z", "Checkout retries · Continues with Skip checkout in 1 minute"],
  ["2026-11-21T09:05:59Z", "Checkout retries · Continues with Skip checkout in 1 minute"],
  ["2026-11-21T09:06:00Z", "Checkout retries · Continuing with Skip checkout"],
  ["2026-11-21T09:06:01Z", "Checkout retries · Continuing with Skip checkout"],
])("lists the open decision with the correct countdown at %s", async (time, detail) => {
  using env = setup();
  await using screen = await render(
    env.ui([decision({ applyAfter: "2026-11-21T09:06:00Z", defaultKey: "skip" })], time),
  );
  const group = screen.getByRole("region", { name: "Needs you" });
  await expect.element(group.getByText("1", { exact: true })).toBeVisible();
  await expect.element(group.getByText("Continue checkout?")).toBeVisible();
  await expect.element(group.getByText(detail, { exact: true })).toBeVisible();
  await expect
    .element(group.getByRole("button", { name: "Keep checkout" }))
    .toHaveClass("border-primary");
  await expect
    .element(group.getByRole("button", { name: "Skip checkout" }))
    .toHaveClass("border-input");
});

it.each([
  { applyAfter: null, defaultKey: "skip" },
  { applyAfter: "2026-11-21T09:06:00Z", defaultKey: null },
  { applyAfter: "2026-11-21T09:06:00Z", defaultKey: "unknown" },
])(
  "omits the countdown without a deadline and a matching default option ($applyAfter, $defaultKey)",
  async (overrides) => {
    using env = setup();
    await using screen = await render(env.ui([decision(overrides)]));
    const group = screen.getByRole("region", { name: "Needs you" });
    await expect.element(group.getByText("Checkout retries", { exact: true })).toBeVisible();
    await expect.element(group.getByText(/Continues|Continuing/)).not.toBeInTheDocument();
  },
);

it("shows the question without buttons or a countdown when there are no options", async () => {
  using env = setup();
  await using screen = await render(
    env.ui([decision({ options: [], applyAfter: "2026-11-21T09:06:00Z", defaultKey: "skip" })]),
  );
  const group = screen.getByRole("region", { name: "Needs you" });
  await expect.element(group.getByText("Continue checkout?")).toBeVisible();
  await expect.element(group.getByText("Checkout retries", { exact: true })).toBeVisible();
  await expect.element(group.getByRole("button")).not.toBeInTheDocument();
});

it("undoes only the picked decision and never sends it", async () => {
  using env = setup();
  await using screen = await render(env.ui([decision(), anotherDecision()]));
  using _timers = fakeTimers();
  const group = screen.getByRole("region", { name: "Needs you" });
  const question = group.getByText("Continue checkout?");
  await expect.element(group.getByText("2", { exact: true })).toBeVisible();

  await group.getByRole("button", { name: "Keep checkout" }).click();
  await expect.element(question).not.toBeInTheDocument();
  await expect.element(group.getByText("Continue receipts?")).toBeVisible();
  await expect.element(group.getByText("1", { exact: true })).toBeVisible();
  const toast = page.getByRole("region", { name: "Notifications" });
  await expect.element(toast.getByText("Answered: Keep checkout")).toBeVisible();
  await expect.element(toast.getByText("Continue checkout?")).toBeVisible();
  expect(env.answer).not.toHaveBeenCalled();

  await toast.getByRole("button", { name: "Undo" }).click();
  await expect.element(question).toBeVisible();
  await expect.element(group.getByText("2", { exact: true })).toBeVisible();
  await act(() => vi.advanceTimersByTime(6000));
  expect(env.answer).not.toHaveBeenCalled();
});

it("sends only after the six-second window and keeps the decision hidden through success", async () => {
  using env = setup();
  const item = decision();
  await using screen = await render(env.ui([item]));
  using _timers = fakeTimers();
  const group = screen.getByRole("region", { name: "Needs you" });

  await screen.getByRole("button", { name: "Skip checkout" }).click();
  await act(() => vi.advanceTimersByTime(5999));
  expect(env.answer).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTime(1));
  expect(env.answer).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
    environmentId,
    input: {
      threadId: ThreadId.make("thread-a"),
      cardId: "dispatch.decision:alpha#decision-a",
      optionKey: "skip",
    },
  });
  await expect.element(group).not.toBeInTheDocument();

  await screen.rerender(env.ui([{ ...item }]));
  await expect.element(group).not.toBeInTheDocument();
  await act(() => env.calls[0]!.resolve(AsyncResult.success({ delivery: "started" })));
  await expect.element(group).not.toBeInTheDocument();
  await screen.rerender(env.ui([]));
  await expect.element(group).not.toBeInTheDocument();
  expect(env.answer).toHaveBeenCalledTimes(1);
});

it("sends once when dismissed without Undo after leaving the board", async () => {
  using env = setup();
  await using screen = await render(env.ui([decision()]));
  using _timers = fakeTimers();

  await screen.getByRole("button", { name: "Keep checkout" }).click();
  await screen.rerender(env.ui([], now, false));
  await page.getByRole("button", { name: "Dismiss notification" }).click();
  expect(env.answer).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
    environmentId,
    input: {
      threadId: ThreadId.make("thread-a"),
      cardId: "dispatch.decision:alpha#decision-a",
      optionKey: "keep",
    },
  });
  await act(() => env.calls[0]!.resolve(AsyncResult.success({ delivery: "started" })));
  await act(() => vi.advanceTimersByTime(6000));
  expect(env.answer).toHaveBeenCalledTimes(1);
});

it.each([
  {
    result: AsyncResult.fail(new PluginCardError({ reason: "dp-failed" })),
    description: "Couldn't record your answer.",
    latest: "still open",
  },
  {
    result: AsyncResult.failure(Cause.interrupt()),
    description: "Check the decision in its chat.",
    latest: "answered",
  },
] satisfies ReadonlyArray<{ result: AnswerResult; description: string; latest: string }>)(
  "restores a failed answer and reflects a decision that is $latest on the next update",
  async ({ result, description, latest }) => {
    using env = setup();
    const item = decision();
    await using screen = await render(env.ui([item]));
    using _timers = fakeTimers();
    const group = screen.getByRole("region", { name: "Needs you" });

    await screen.getByRole("button", { name: "Keep checkout" }).click();
    await act(() => vi.advanceTimersByTime(6000));
    await expect.element(group).not.toBeInTheDocument();

    await act(() => env.calls[0]!.resolve(result));
    await expect.element(group.getByRole("button", { name: "Keep checkout" })).toBeVisible();
    const toast = page.getByRole("region", { name: "Notifications" });
    await expect.element(toast.getByText("Couldn't confirm your answer was sent")).toBeVisible();
    await expect.element(toast.getByText(description, { exact: true })).toBeVisible();

    if (latest === "still open") {
      await screen.rerender(env.ui([{ ...item, question: "Keep checkout retries?" }]));
      await expect.element(group.getByText("Keep checkout retries?")).toBeVisible();
      await expect.element(group.getByText("1", { exact: true })).toBeVisible();
    } else {
      await screen.rerender(env.ui([]));
      await expect.element(group).not.toBeInTheDocument();
    }
  },
);

it("settles two answers independently when their results arrive in reverse order", async () => {
  using env = setup();
  await using screen = await render(env.ui([decision(), anotherDecision()]));
  using _timers = fakeTimers();
  const group = screen.getByRole("region", { name: "Needs you" });

  await group.getByRole("button", { name: "Keep checkout" }).click();
  await group.getByRole("button", { name: "Keep receipts" }).click();
  await act(() => vi.advanceTimersByTime(6000));
  expect(env.answer).toHaveBeenCalledTimes(2);
  expect(env.answer).toHaveBeenNthCalledWith(2, expect.anything(), {
    environmentId,
    input: {
      threadId: ThreadId.make("thread-b"),
      cardId: "dispatch.decision:alpha#decision-b",
      optionKey: "keep",
    },
  });

  await act(() => env.calls[1]!.resolve(AsyncResult.success({ delivery: "started" })));
  await expect.element(group).not.toBeInTheDocument();
  await act(() =>
    env.calls[0]!.resolve(AsyncResult.fail(new PluginCardError({ reason: "decision-closed" }))),
  );
  await expect.element(group.getByText("Continue checkout?")).toBeVisible();
  await expect.element(group.getByText("Continue receipts?")).not.toBeInTheDocument();
  await expect.element(group.getByText("1", { exact: true })).toBeVisible();
});

it.each(["outward", "always-ask"] as const)(
  "offers the chat for a decision with %s protection",
  async (protection) => {
    using env = setup();
    await using screen = await render(env.ui([decision({ protection, answerableInPlace: false })]));
    const group = screen.getByRole("region", { name: "Needs you" });
    await expect
      .element(
        group.getByText("Checkout retries · Asks for confirmation in its chat", { exact: true }),
      )
      .toBeVisible();
    await expect
      .element(group.getByRole("link", { name: "Open chat" }))
      .toHaveAttribute("href", "/env-a/thread-a");
    await expect.element(group.getByRole("button")).not.toBeInTheDocument();
  },
);

it("points back to the decision source when the chat is unknown", async () => {
  using env = setup();
  await using screen = await render(
    env.ui([decision({ threadId: null, answerableInPlace: false })]),
  );
  const group = screen.getByRole("region", { name: "Needs you" });
  await expect.element(group.getByText("Answer it where it was asked")).toBeVisible();
  await expect.element(group.getByRole("button")).not.toBeInTheDocument();
  await expect.element(group.getByRole("link")).not.toBeInTheDocument();
});

it("offers the chat when the connection lacks answer permission", async () => {
  using env = setup({ canAnswer: false });
  await using screen = await render(env.ui([decision()]));
  const group = screen.getByRole("region", { name: "Needs you" });
  await expect
    .element(group.getByRole("link", { name: "Open chat" }))
    .toHaveAttribute("href", "/env-a/thread-a");
  await expect.element(group.getByRole("button")).not.toBeInTheDocument();
  await expect.element(group.getByText(/Asks for confirmation/)).not.toBeInTheDocument();
});

it("shows no Needs you group when there are no decisions", async () => {
  using env = setup();
  await using screen = await render(env.ui([]));
  await expect.element(screen.getByRole("heading", { name: "Alpha" })).toBeVisible();
  await expect.element(screen.getByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
});
