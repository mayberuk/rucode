import appCss from "../index.css?inline";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import * as shelfHooks from "../state/olderSettledShelf";
import { createWorkspaceFocusController, workspaceAreaProps } from "../lib/workspaceFocus";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  type ClientSettings,
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  type LocalApi,
  type PluginLiveInitiative,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useSyncExternalStore } from "react";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { makeThreadFixture } from "../test-fixtures";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useNowMinute } from "../hooks/useNowMinute";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import {
  useProjects,
  useServerConfigs,
  useQuietThreadShells,
  useThreadShell,
} from "../state/entities";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { useUiStateStore } from "../uiStateStore";
import { readLocalApi } from "../localApi";
import * as liveAtoms from "../pluginCards/live/liveAtoms";
import type { Project } from "../types";
import Sidebar from "./Sidebar";
import { THREAD_JUMP_HINT_SHOW_DELAY_MS } from "./Sidebar.logic";
import { SortableThreadRow } from "./sidebar/SidebarThreadRow";
import { SidebarProvider } from "./ui/sidebar";

vi.mock(import("../state/olderSettledShelf"), async (original) => {
  const actual = await original();
  return { ...actual, useOlderSettledShelf: vi.fn(actual.useOlderSettledShelf) };
});
vi.mock("../state/entities", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../hooks/useNowMinute", { spy: true });
vi.mock("../hooks/useThreadRouteTarget", { spy: true });
vi.mock("./sidebar/SidebarThreadRow", { spy: true });
vi.mock("../state/session", { spy: true });
vi.mock("../state/use-orchestration-command", { spy: true });
vi.mock("../localApi", { spy: true });
vi.mock("../pluginCards/live/liveAtoms", { spy: true });
vi.mock(import("../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  // The desktop defaults: holding Mod alone already matches a thread jump.
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "mod+1", command: "thread.jump.1" },
    { key: "mod+2", command: "thread.jump.2" },
  ]);
  return { ...(await original()), primaryServerKeybindingsAtom: Atom.make(keybindings) };
});
vi.mock("../commandPaletteBus", () => ({
  openCommandPalette: vi.fn(),
  isCommandPaletteOpen: () => false,
}));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

function project(id: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make("local"),
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

describe("sidebar header new thread", () => {
  it.each([
    { mode: "normal", count: 2, shift: false, picker: true },
    { mode: "boring", count: 2, shift: false, picker: true },
    { mode: "boring", count: 2, shift: true, picker: false },
    { mode: "boring", count: 1, shift: false, picker: false },
  ] as const)("$mode sidebar, $count projects, shift=$shift: picker=$picker", async (scenario) => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      sidebarLayout: scenario.mode === "boring" ? "projects" : "list",
    });
    const projects = [project("active"), project("idle")].slice(0, scenario.count);
    const currentProjectRef = {
      environmentId: projects[0]!.environmentId,
      projectId: projects[0]!.id,
    };
    const startThread = vi.fn().mockResolvedValue(null);
    vi.mocked(useProjects).mockReturnValue(projects);
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: currentProjectRef,
      defaultProjectFallbackReady: true,
      handleNewThread: startThread,
      routeDraftId: null,
      routeThreadRef: null,
    });
    vi.mocked(openCommandPalette).mockClear();
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "New thread", exact: true }), {
      modifiers: scenario.shift ? ["Shift"] : [],
    });

    if (scenario.picker) {
      expect(openCommandPalette).toHaveBeenCalledExactlyOnceWith({ open: "new-thread-in" });
      expect(startThread).not.toHaveBeenCalled();
    } else {
      expect(openCommandPalette).not.toHaveBeenCalled();
      expect(startThread).toHaveBeenCalledExactlyOnceWith(currentProjectRef);
    }
  });
});

function threadShell(projectId: ProjectId, index: number): EnvironmentThreadShell {
  return makeThreadFixture({
    environmentId: EnvironmentId.make("local"),
    id: ThreadId.make(`thread-${index}`),
    projectId,
    title: `Thread ${index}`,
  });
}

describe("sidebar render isolation", () => {
  // regression: #33100 Cmd+J re-rendered every sidebar row, which took hundreds of ms with many threads
  it("does not re-render thread rows when a quick Mod shortcut opens and focuses the terminal", async () => {
    using stack = new DisposableStack();
    const activeProject = project("active");
    const threads = Array.from({ length: 5 }, (_, index) => threadShell(activeProject.id, index));
    const routeThreadRef: ScopedThreadRef = {
      environmentId: activeProject.environmentId,
      threadId: threads[0]!.id,
    };
    threads.unshift(threadShell(activeProject.id, 100));
    // A real wall-clock minute tick mid-test re-renders every row and reads as a leak.
    vi.mocked(useNowMinute).mockReturnValue("2026-01-01T00:00");
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: routeThreadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef,
    });
    const terminal = document.createElement("div");
    terminal.dataset.terminalOwner = "drawer";
    const terminalInput = document.createElement("textarea");
    terminal.append(terminalInput);
    document.body.append(terminal);
    stack.defer(() => terminal.remove());
    stack.defer(() => useTerminalUiStateStore.getState().setTerminalOpen(routeThreadRef, false));
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    await expect.element(screen.getByText("Thread 4").first()).toBeInTheDocument();
    const rowRenders = () => vi.mocked(SortableThreadRow).mock.calls.length;

    using _timers = fakeTimers();
    const modifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";
    const beforeShortcut = rowRenders();
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => useTerminalUiStateStore.getState().setTerminalOpen(routeThreadRef, true));
    await act(() => terminalInput.focus());
    await userEvent.keyboard(`{/${modifier}}`);
    await act(() => terminalInput.blur());
    expect(
      rowRenders() - beforeShortcut,
      "thread rows re-rendered while opening the terminal with a quick Mod shortcut",
    ).toBe(0);

    const jumpLabelsSince = (start: number) =>
      vi
        .mocked(SortableThreadRow)
        .mock.calls.slice(start)
        .map(([props]) => props.jumpLabel)
        .filter((label) => label !== null);
    const beforeHold = rowRenders();
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS));
    expect(jumpLabelsSince(beforeHold), "holding Mod showed no jump hints").toHaveLength(2);
    const beforeRelease = rowRenders();
    await userEvent.keyboard(`{/${modifier}}`);
    expect(rowRenders()).toBeGreaterThan(beforeRelease);
    expect(jumpLabelsSince(beforeRelease)).toEqual([]);
  });
});

describe("sidebar thread rename", () => {
  // regression: #35151 an untouched rename wrote back the title it opened with over a newer one
  it.each(["{Enter}", "{Tab}"])(
    "ending an untouched rename with %s keeps a title that arrived while it was open",
    async (finish) => {
      const activeProject = project("active");
      const routeThreadRef: ScopedThreadRef = {
        environmentId: activeProject.environmentId,
        threadId: ThreadId.make("thread-0"),
      };
      const shellTitled = (title: string) => ({ ...threadShell(activeProject.id, 0), title });
      const updateMetadata = vi.fn().mockResolvedValue({ _tag: "Success" });
      vi.mocked(useOrchestrationCommand).mockReturnValue(updateMetadata);
      vi.mocked(readEnvironmentScope).mockReturnValue(true);
      vi.mocked(useEnvironmentScope).mockReturnValue(true);
      vi.mocked(useProjects).mockReturnValue([activeProject]);
      vi.mocked(useQuietThreadShells).mockReturnValue([shellTitled("Fix the login redirect")]);
      vi.mocked(useThreadRouteTarget).mockReturnValue({
        kind: "server",
        threadRef: routeThreadRef,
      });
      vi.mocked(useHandleNewThread).mockReturnValue({
        activeDraftThread: null,
        activeThread: null,
        defaultProjectRef: {
          environmentId: activeProject.environmentId,
          projectId: activeProject.id,
        },
        defaultProjectFallbackReady: true,
        handleNewThread: vi.fn().mockResolvedValue(null),
        routeDraftId: null,
        routeThreadRef,
      });
      const tree = () => (
        <SidebarProvider>
          <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
        </SidebarProvider>
      );
      await using screen = await render(tree());
      await userEvent.dblClick(screen.getByText("Fix the login redirect").first());
      const input = screen.getByRole("textbox", { name: "Thread title" });
      await expect.element(input).toHaveValue("Fix the login redirect");

      vi.mocked(useQuietThreadShells).mockReturnValue([shellTitled("Generated title")]);
      await screen.rerender(tree());
      await userEvent.keyboard(finish);

      await expect.element(input).not.toBeInTheDocument();
      expect(updateMetadata).not.toHaveBeenCalled();
    },
  );
});

describe("sidebar thread menu", () => {
  it("tells the menu whether the keyboard opened it", async () => {
    const activeProject = project("active");
    const thread = threadShell(activeProject.id, 0);
    const threadRef = { environmentId: activeProject.environmentId, threadId: thread.id };
    const show = vi.fn().mockResolvedValue(null);
    vi.mocked(readLocalApi).mockReturnValue({ contextMenu: { show } } as unknown as LocalApi);
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue([thread]);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef: threadRef,
    });
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const row = screen.getByText("Thread 0").first();
    await expect.element(row).toBeInTheDocument();
    row.element().closest<HTMLElement>("[data-sidebar-row]")!.focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    expect(show.mock.lastCall?.[2]).toBe("keyboard");
    await userEvent.click(row, { button: "right" });
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(2));
    expect(show.mock.lastCall?.[2]).toBe("mouse");
  });
});

describe("sidebar settled pagination", () => {
  it("keeps the viewport in place when showing more settled threads", async () => {
    using stack = new DisposableStack();
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    stack.defer(() => style.remove());
    const focusController = createWorkspaceFocusController(document);
    stack.defer(() => focusController.dispose());
    let loading = false;
    const originalShelf = vi.mocked(shelfHooks.useOlderSettledShelf).getMockImplementation()!;
    using _shelf = vi.spyOn(shelfHooks, "useOlderSettledShelf").mockImplementation((input) => ({
      ...originalShelf(input),
      loading,
      retry: () => {
        loading = true;
      },
    }));
    const activeProject = project("active");
    const threads = Array.from({ length: 70 }, (_, index) =>
      makeThreadFixture({
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
        id: ThreadId.make(`settled-${index}`),
        title: `Settled thread ${index}`,
        settledOverride: "settled",
        settledAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    threads.unshift(threadShell(activeProject.id, 100));
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue({
      kind: "server",
      threadRef: { environmentId: activeProject.environmentId, threadId: threads[0]!.id },
    });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef: { environmentId: activeProject.environmentId, threadId: threads[0]!.id },
    });
    vi.mocked(useServerConfigs).mockReturnValue(
      new Map([
        [
          activeProject.environmentId,
          {
            scratchWorkspaceRoot: null,
            shellThreadFamilies: false,
          } as unknown as EnvironmentServerConfig,
        ],
      ]),
    );
    await using screen = await render(
      <SidebarProvider
        {...workspaceAreaProps("sidebar", 0, "Threads")}
        style={{ height: 400, minHeight: 400 }}
      >
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const shelf = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="shelf:settled"]',
    )!;
    if (shelf.getAttribute("aria-expanded") === "false") await act(() => shelf.click());
    const more = screen.getByRole("button", { name: "Show 25 more", exact: true });
    await expect.element(more).toBeInTheDocument();
    const moreButton = more.element() as HTMLButtonElement;
    const viewport = moreButton.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    viewport.style.height = "300px";
    viewport.style.maxHeight = "300px";
    moreButton.scrollIntoView({ block: "nearest" });
    const before = viewport.scrollTop;
    expect(before).toBeGreaterThan(0);
    moreButton.focus({ preventScroll: true });
    await act(() => moreButton.click());
    await expect
      .element(screen.getByRole("button", { name: "Loading", exact: true }))
      .toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Loading", exact: true }))
      .toHaveFocus();
    expect(viewport.scrollTop).toBe(before);
    const loadedRows = screen.container.querySelectorAll("[data-thread-item]").length;
    await act(() => moreButton.click());
    expect(screen.container.querySelectorAll("[data-thread-item]")).toHaveLength(loadedRows);
  });
});

describe("sidebar initiative groups", () => {
  const environmentId = EnvironmentId.make("local");
  const groupedProject = { ...project("acme"), title: "acme/app" };
  const shell = (id: string, title: string, overrides: Partial<EnvironmentThreadShell> = {}) =>
    makeThreadFixture({
      environmentId,
      projectId: groupedProject.id,
      id: ThreadId.make(id),
      title,
      ...overrides,
    });
  const running = {
    runtime: {
      status: "running" as const,
      activeRunId: null,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: "Codex",
      lastError: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  };
  const baseThreads = [
    shell("inbox", "Inbox chat"),
    shell("part", "Part one chat"),
    shell("orchestrator", "Orchestrator chat"),
    shell("pinned", "Pinned chat", {
      pinnedAt: "2026-01-01T00:00:00.000Z",
      pinOrderKey: "a",
    }),
  ];
  const group = {
    key: `${environmentId}:billing-revamp`,
    environmentId,
    slug: "billing-revamp",
    label: "Billing revamp",
    threadIds: [ThreadId.make("orchestrator"), ThreadId.make("part"), ThreadId.make("pinned")],
    endLabel: "Wave 2 of 3 · 1 of 2 parts settled",
  };
  const liveInitiative = (overrides: Partial<PluginLiveInitiative> = {}): PluginLiveInitiative => ({
    slug: group.slug,
    title: group.label,
    closed: false,
    wave: { current: 2, total: 3, partsSettled: 1, partsTotal: 2 },
    settled: { count: 1, total: 2 },
    running: 1,
    openDecisions: 0,
    spend: { usd: null, state: "unknown" },
    orchestratorThreadId: ThreadId.make("orchestrator"),
    asOf: "2026-01-01T00:00:00.000Z",
    parts: [
      { id: "alpha", title: null, wave: 1, status: "merged", threadIds: [] },
      { id: "beta", title: null, wave: 2, status: "mr-open", threadIds: [ThreadId.make("part")] },
    ],
    ...overrides,
  });
  const routeThreadRef = { environmentId, threadId: ThreadId.make("inbox") };
  const tree = () => (
    <SidebarProvider>
      <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
    </SidebarProvider>
  );
  const follows = (earlier: Element, later: Element) =>
    (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  const inDocumentOrder = (elements: ReadonlyArray<Element>) =>
    elements.every((element, index) => index === 0 || follows(elements[index - 1]!, element));
  const folderToggle = (screen: Awaited<ReturnType<typeof render>>) =>
    screen.getByRole("button", { name: /^Billing revamp/ });
  const boardLink = (screen: Awaited<ReturnType<typeof render>>) =>
    screen.getByTestId("sidebar-initiative-board-link");
  const expectBoardOpened = async (screen: Awaited<ReturnType<typeof render>>) => {
    await vi.waitFor(() => expect(screen.router!.state.location.pathname).toBe("/board"));
    expect(screen.router!.state.location.search).toEqual({ environmentId, slug: "billing-revamp" });
  };

  function setup(
    stack: DisposableStack,
    options: {
      readonly sidebarLayout: ClientSettings["sidebarLayout"];
      readonly needsYouFirst?: boolean;
      readonly threads?: ReadonlyArray<EnvironmentThreadShell>;
      readonly openDecisionThreadIds?: ReadonlyArray<string>;
      readonly live?: PluginLiveInitiative | null;
    },
  ) {
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      sidebarLayout: options.sidebarLayout,
      sidebarNeedsYouFirst: options.needsYouFirst ?? DEFAULT_CLIENT_SETTINGS.sidebarNeedsYouFirst,
    });
    stack.defer(() => window.localStorage.removeItem("t3code:sidebar:initiative-collapsed"));
    stack.defer(() => useUiStateStore.setState({ projectExpandedById: {} }));
    stack.use(vi.spyOn(liveAtoms, "useInitiativeSidebarGroups").mockReturnValue([group]));
    const decisionKeys = (options.openDecisionThreadIds ?? []).map((id) =>
      scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id))),
    );
    stack.use(vi.spyOn(liveAtoms, "useOpenDecisionThreadKeys").mockReturnValue(decisionKeys));
    // Read through a store so a test can deliver the live state after the first render.
    let live = options.live === undefined ? liveInitiative() : options.live;
    const listeners = new Set<() => void>();
    stack.use(
      vi.spyOn(liveAtoms, "useLiveInitiative").mockImplementation(() =>
        useSyncExternalStore(
          (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          () => live,
        ),
      ),
    );
    vi.mocked(useProjects).mockReturnValue([groupedProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue([...(options.threads ?? baseThreads)]);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: routeThreadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: { environmentId, projectId: groupedProject.id },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef,
    });
    return {
      deliverLive: (next: PluginLiveInitiative | null) =>
        act(() => {
          live = next;
          for (const listener of listeners) listener();
        }),
    };
  }

  const noWaves = liveInitiative({
    wave: { current: 0, total: 0, partsSettled: 0, partsTotal: 0 },
    parts: [],
  });
  const onDay = (day: number) => ({ createdAt: `2026-01-0${day}T00:00:00.000Z` });
  const rowKind = (element: Element) =>
    element.closest("[data-testid^='sidebar-row-']")?.getAttribute("data-testid");

  it("draws a List initiative as one folder row at its freshest member's place, opening in place to two-line rows", async () => {
    using stack = new DisposableStack();
    setup(stack, {
      sidebarLayout: "list",
      needsYouFirst: false,
      threads: [
        shell("newer", "Newer chat", onDay(5)),
        shell("part", "Part one chat", onDay(4)),
        shell("older", "Older chat", onDay(3)),
        shell("orchestrator", "Orchestrator chat", onDay(2)),
        shell("pinned", "Pinned chat", {
          pinnedAt: "2026-01-01T00:00:00.000Z",
          pinOrderKey: "a",
        }),
      ],
    });
    {
      await using first = await render(tree());
      const toggle = folderToggle(first);
      const row = (title: string) => first.getByText(title, { exact: true }).first();
      await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
      await expect.element(toggle).toHaveAccessibleName("Billing revamp");
      expect(first.getByTestId("sidebar-initiative-folder").all()).toHaveLength(1);
      // The part is fresher than Older chat, so the folder stands where the part would have.
      expect(
        inDocumentOrder(
          [
            row("Pinned chat"),
            row("Newer chat"),
            toggle,
            row("Orchestrator chat"),
            row("Part one chat"),
            row("Older chat"),
          ].map((locator) => locator.element()),
        ),
      ).toBe(true);
      await vi.waitFor(() => expect(boardLink(first).element().textContent).toBe("Wave 2 of 3"));
      expect(rowKind(row("Orchestrator chat").element())).toBe("sidebar-row-card");
      expect(rowKind(row("Part one chat").element())).toBe("sidebar-row-card");
      expect(first.getByTestId("sidebar-initiative-wave").query()).toBeNull();

      // The shift guard drops pointer presses on rows that just appeared; keys pass.
      toggle.element().focus();
      await userEvent.keyboard("{Enter}");
      await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
      await expect
        .element(first.getByText("Orchestrator chat", { exact: true }))
        .not.toBeInTheDocument();
      await expect
        .element(first.getByText("Part one chat", { exact: true }))
        .not.toBeInTheDocument();
      expect(boardLink(first).element().textContent).toBe("Wave 2 of 3");
      expect(
        JSON.parse(window.localStorage.getItem("t3code:sidebar:initiative-collapsed")!),
      ).toEqual({ [group.key]: true });
    }
    await using screen = await render(tree());
    const reloaded = folderToggle(screen);
    await expect.element(reloaded).toHaveAttribute("aria-expanded", "false");
    reloaded.element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(reloaded).toHaveAttribute("aria-expanded", "true");
    await expect
      .element(screen.getByText("Part one chat", { exact: true }).first())
      .toBeInTheDocument();
    expect(screen.router!.state.location.pathname).toBe("/");
  });

  const longLabel = "Billing revamp and every follow-up migration we planned for the quarter";
  it.each([
    { name: "a label that fits", label: "Billing revamp", truncated: false },
    { name: "a label too long for the row", label: longLabel, truncated: true },
  ])(
    "keeps the List folder's wave text between the label and the chevron with $name",
    async ({ label, truncated }) => {
      using stack = new DisposableStack();
      const style = document.createElement("style");
      style.textContent = appCss;
      document.head.append(style);
      stack.defer(() => style.remove());
      setup(stack, { sidebarLayout: "list" });
      stack.use(
        vi.spyOn(liveAtoms, "useInitiativeSidebarGroups").mockReturnValue([{ ...group, label }]),
      );
      await using screen = await render(
        <SidebarProvider>
          <div style={{ width: "16rem", flex: "none" }}>
            <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
          </div>
        </SidebarProvider>,
      );
      const toggle = screen.getByRole("button", { name: label, exact: true });
      await expect.element(toggle).toBeInTheDocument();
      const link = boardLink(screen).element();
      await vi.waitFor(() => expect(link.textContent).toBe("Wave 2 of 3"));
      const labelText = Array.from(toggle.element().querySelectorAll("span")).find(
        (span) => span.textContent === label,
      )!;
      const chevron = toggle.element().querySelector("svg.lucide-chevron-down")!;
      const linkBox = link.getBoundingClientRect();
      expect(linkBox.left).toBeGreaterThanOrEqual(labelText.getBoundingClientRect().right);
      expect(linkBox.right).toBeLessThanOrEqual(chevron.getBoundingClientRect().left);
      expect(labelText.scrollWidth > labelText.clientWidth).toBe(truncated);
      expect(labelText.clientWidth).toBeGreaterThan(0);
    },
  );

  it("says in words what a closed initiative folder's hidden members and their sessions need", async () => {
    using stack = new DisposableStack();
    setup(stack, {
      sidebarLayout: "projects",
      threads: [
        ...baseThreads,
        shell("part-child", "Part session", {
          lineage: {
            rootThreadId: ThreadId.make("part"),
            parentThreadId: ThreadId.make("part"),
            relationshipToParent: null,
          },
          runtime: { ...running.runtime, status: "failed" as const },
        }),
      ],
    });
    await using screen = await render(tree());
    const toggle = folderToggle(screen);
    await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle.element().textContent).toBe("Billing revamp");
    toggle.element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    await expect.element(toggle).toHaveAccessibleName("Billing revamp, 1 failed");
    expect(toggle.element().textContent).toBe("Billing revamp1 failed");
  });

  it("puts the initiative folder inside its project folder, before the folder's own threads, with its wave line under it", async () => {
    using stack = new DisposableStack();
    setup(stack, {
      sidebarLayout: "projects",
      threads: [
        shell("inbox", "Inbox chat"),
        shell("busy", "Busy chat", running),
        shell("part", "Part one chat"),
        shell("orchestrator", "Orchestrator chat", running),
      ],
    });
    await using screen = await render(tree());
    const folder = screen.getByTestId("sidebar-project-folder").getByRole("button").first();
    const toggle = folderToggle(screen);
    await expect.element(toggle).toBeInTheDocument();
    // An open folder names only the initiative: no member count.
    expect(toggle.element().textContent).toBe("Billing revamp");
    await vi.waitFor(() =>
      expect(boardLink(screen).element().textContent).toBe("Wave 2 of 3 · 1 of 2 merged"),
    );
    await expect
      .element(boardLink(screen))
      .toHaveAccessibleName("Wave 2 of 3: 1 of 2 parts merged. Open the board");
    const row = (title: string) => screen.getByText(title, { exact: true }).first();
    expect(
      inDocumentOrder(
        [
          folder,
          toggle,
          boardLink(screen),
          row("Orchestrator chat"),
          row("Part one chat"),
          row("Inbox chat"),
        ].map((locator) => locator.element()),
      ),
    ).toBe(true);
    expect(rowKind(row("Part one chat").element())).toBe("sidebar-row-folder");
    expect(screen.getByTestId("sidebar-initiative-wave").query()).toBeNull();

    // Arrow keys walk folder -> initiative -> its members, and back up one level at a time.
    folder.element().focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(toggle).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(screen.getByRole("button", { name: /^Orchestrator chat/ })).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(toggle).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    // The wave line stays under a closed initiative.
    expect(boardLink(screen).element().textContent).toBe("Wave 2 of 3 · 1 of 2 merged");
    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(folder).toHaveFocus();
    toggle.element().focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(toggle).toHaveAttribute("aria-expanded", "true");

    folder.element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(folder).toHaveAttribute("aria-expanded", "false");
    // Both running threads are hidden: the folder's own and the initiative's.
    await expect.element(folder).toHaveAccessibleName("acme/app, 2 working");
    await expect.element(toggle).not.toBeInTheDocument();
    await expect.element(row("Inbox chat")).toBeInTheDocument();
  });

  it("shows the freshest hidden thread's age on a closed folder with nothing to report", async () => {
    using stack = new DisposableStack();
    setup(stack, {
      sidebarLayout: "projects",
      threads: [
        shell("inbox", "Inbox chat"),
        shell("older", "Older chat", { latestUserMessageAt: "2026-01-01T06:00:00.000Z" }),
        shell("newer", "Newer chat", { latestUserMessageAt: "2026-01-02T12:00:00.000Z" }),
        shell("part", "Part one chat"),
        shell("orchestrator", "Orchestrator chat"),
      ],
    });
    stack.use(vi.mocked(useNowMinute).mockReturnValue("2026-01-03T00:00"));
    await using screen = await render(tree());
    const folder = screen.getByTestId("sidebar-project-folder").getByRole("button").first();
    await expect.element(folder).toHaveAttribute("aria-expanded", "true");
    folder.element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(folder).toHaveAttribute("aria-expanded", "false");
    await expect.element(folder).toHaveAccessibleName("acme/app, 12h");
  });

  it.each([
    { from: "the wave line", layout: "projects" as const, via: "link" as const },
    { from: "the hover action", layout: "projects" as const, via: "action" as const },
    { from: "the context menu", layout: "projects" as const, via: "menu" as const },
    { from: "the wave text", layout: "list" as const, via: "link" as const },
    { from: "the context menu", layout: "list" as const, via: "menu" as const },
  ])("opens the board on the initiative from $from in $layout", async ({ layout, via }) => {
    using stack = new DisposableStack();
    setup(stack, { sidebarLayout: layout });
    const show = vi.fn().mockResolvedValue("open-board");
    stack.use(
      vi.mocked(readLocalApi).mockReturnValue({ contextMenu: { show } } as unknown as LocalApi),
    );
    await using screen = await render(tree());
    await expect.element(folderToggle(screen)).toBeInTheDocument();
    if (via === "menu") {
      folderToggle(screen).element().focus();
      await userEvent.keyboard("{Shift>}{F10}{/Shift}");
      await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1));
      expect(show.mock.lastCall?.[0]).toEqual([{ id: "open-board", label: "Open board" }]);
    } else {
      const target =
        via === "link"
          ? boardLink(screen)
          : screen.getByRole("link", { name: "Open board for Billing revamp", exact: true });
      target.element().focus();
      await userEvent.keyboard("{Enter}");
    }
    await expectBoardOpened(screen);
  });

  it.each([
    { layout: "list" as const, live: noWaves, text: "No waves yet" },
    { layout: "projects" as const, live: noWaves, text: "No waves yet" },
    { layout: "list" as const, live: null, text: "Open the board" },
    { layout: "projects" as const, live: null, text: "Open the board" },
  ])("shows $text in $layout and still links to the board", async ({ layout, live, text }) => {
    using stack = new DisposableStack();
    setup(stack, { sidebarLayout: layout, live });
    await using screen = await render(tree());
    await vi.waitFor(() => expect(boardLink(screen).element().textContent).toBe(text));
    await expect
      .element(screen.getByText("Orchestrator chat", { exact: true }).first())
      .toBeInTheDocument();
    boardLink(screen).element().focus();
    await userEvent.keyboard("{Enter}");
    await expectBoardOpened(screen);
  });

  it("swaps the loading text for the wave once progress arrives, and falls back when it is lost", async () => {
    using stack = new DisposableStack();
    const { deliverLive } = setup(stack, { sidebarLayout: "list", live: null });
    await using screen = await render(tree());
    await vi.waitFor(() => expect(boardLink(screen).element().textContent).toBe("Open the board"));
    await deliverLive(liveInitiative());
    await vi.waitFor(() => expect(boardLink(screen).element().textContent).toBe("Wave 2 of 3"));
    await deliverLive(null);
    await vi.waitFor(() => expect(boardLink(screen).element().textContent).toBe("Open the board"));
  });

  describe("Needs you section", () => {
    const asking = { hasPendingUserInput: true };
    const created = (day: number) => ({ createdAt: `2026-01-0${day}T00:00:00.000Z` });
    // Inbox order is newest first: Newer, Question, Older.
    const threads = [
      shell("newer", "Newer chat", created(5)),
      shell("question", "Question chat", { ...created(4), ...asking }),
      shell("older", "Older chat", created(3)),
      shell("orchestrator", "Orchestrator chat", created(2)),
      shell("part", "Part one chat", created(2)),
      shell("pinned", "Pinned chat", {
        ...asking,
        pinnedAt: "2026-01-01T00:00:00.000Z",
        pinOrderKey: "a",
      }),
    ];
    const titleOrder = (container: HTMLElement, titles: readonly string[]) =>
      Array.from(container.querySelectorAll<HTMLElement>("[data-thread-item]"))
        .map((row) => titles.find((title) => row.textContent?.includes(title)))
        .filter((title) => title !== undefined);
    const allTitles = threads.map((thread) => thread.title);
    const header = (screen: Awaited<ReturnType<typeof render>>) =>
      screen.getByTestId("sidebar-needs-you-shelf-toggle");

    function setupSection(
      stack: DisposableStack,
      options: {
        readonly sidebarLayout: ClientSettings["sidebarLayout"];
        readonly needsYouFirst: boolean;
        readonly routeThreadId?: string;
        readonly openDecisionThreadIds?: ReadonlyArray<string>;
      },
    ) {
      setup(stack, {
        sidebarLayout: options.sidebarLayout,
        needsYouFirst: options.needsYouFirst,
        threads,
        openDecisionThreadIds: options.openDecisionThreadIds ?? ["part"],
      });
      stack.defer(() => window.localStorage.removeItem("t3code:sidebar:needs-you-expanded"));
      const routeThreadRef =
        options.routeThreadId === undefined
          ? null
          : { environmentId, threadId: ThreadId.make(options.routeThreadId) };
      vi.mocked(useThreadRouteTarget).mockReturnValue(
        routeThreadRef === null ? null : { kind: "server", threadRef: routeThreadRef },
      );
      vi.mocked(useHandleNewThread).mockReturnValue({
        activeDraftThread: null,
        activeThread: null,
        defaultProjectRef: { environmentId, projectId: groupedProject.id },
        defaultProjectFallbackReady: true,
        handleNewThread: vi.fn().mockResolvedValue(null),
        routeDraftId: null,
        routeThreadRef,
      });
    }

    it("lists a thread waiting on the user once, under a header below the pins, and out of its initiative", async () => {
      using stack = new DisposableStack();
      setupSection(stack, { sidebarLayout: "list", needsYouFirst: true });
      await using screen = await render(tree());
      await expect.element(header(screen)).toBeInTheDocument();
      expect(header(screen).element().textContent).toBe("Needs you2");
      await expect.element(header(screen)).toHaveAttribute("aria-expanded", "true");
      // The pinned thread is asking too, but stays pinned; the decision on a part pulls it out of its initiative.
      expect(titleOrder(screen.container, allTitles)).toEqual([
        "Pinned chat",
        "Question chat",
        "Part one chat",
        "Newer chat",
        "Older chat",
        "Orchestrator chat",
      ]);
      const pinnedRow = screen.getByText("Pinned chat", { exact: true }).element();
      const initiativeHeader = folderToggle(screen).element();
      expect(follows(pinnedRow, header(screen).element())).toBe(true);
      expect(
        follows(screen.getByText("Part one chat", { exact: true }).element(), initiativeHeader),
      ).toBe(true);
    });

    it("takes the thread out of its project folder, and a closed folder still says it needs you", async () => {
      using stack = new DisposableStack();
      setupSection(stack, {
        sidebarLayout: "projects",
        needsYouFirst: true,
        routeThreadId: "question",
        openDecisionThreadIds: [],
      });
      await using screen = await render(tree());
      const folder = screen.getByTestId("sidebar-project-folder").getByRole("button").first();
      await expect.element(header(screen)).toBeInTheDocument();
      expect(header(screen).element().textContent).toBe("Needs you1");
      expect(screen.getByText("Question chat", { exact: true }).all()).toHaveLength(1);
      const question = screen.getByText("Question chat", { exact: true }).element();
      expect(follows(header(screen).element(), question)).toBe(true);
      expect(follows(question, folder.element())).toBe(true);

      folder.element().focus();
      await userEvent.keyboard("{Enter}");
      await expect.element(folder).toHaveAttribute("aria-expanded", "false");
      // The open thread is drawn in the section, so the closed folder counts it instead of keeping it.
      await expect.element(folder).toHaveAccessibleName("acme/app, Needs you");
      await expect.element(screen.getByText("Newer chat", { exact: true })).not.toBeInTheDocument();
      expect(screen.getByText("Question chat", { exact: true }).all()).toHaveLength(1);
    });

    it.each([
      {
        layout: "list" as const,
        order: [
          "Pinned chat",
          "Newer chat",
          "Question chat",
          "Older chat",
          "Orchestrator chat",
          "Part one chat",
        ],
      },
      {
        layout: "projects" as const,
        order: [
          "Pinned chat",
          "Orchestrator chat",
          "Part one chat",
          "Newer chat",
          "Question chat",
          "Older chat",
        ],
      },
    ])("draws no section and keeps every thread in place when off: $layout", async (spec) => {
      using stack = new DisposableStack();
      setupSection(stack, { sidebarLayout: spec.layout, needsYouFirst: false });
      await using screen = await render(tree());
      await expect.element(screen.getByText("Older chat", { exact: true })).toBeInTheDocument();
      expect(screen.getByTestId("sidebar-needs-you-header").query()).toBeNull();
      expect(titleOrder(screen.container, allTitles)).toEqual(spec.order);
    });

    it("returns a thread to its place once it stops needing the user, and drops the empty section", async () => {
      using stack = new DisposableStack();
      setupSection(stack, {
        sidebarLayout: "list",
        needsYouFirst: true,
        openDecisionThreadIds: [],
      });
      await using screen = await render(tree());
      await expect.element(header(screen)).toBeInTheDocument();
      expect(header(screen).element().textContent).toBe("Needs you1");

      vi.mocked(useQuietThreadShells).mockReturnValue(
        threads.map((thread) =>
          thread.id === ThreadId.make("question")
            ? { ...thread, hasPendingUserInput: false }
            : thread,
        ),
      );
      await screen.rerender(tree());
      await expect.element(screen.getByTestId("sidebar-needs-you-header")).not.toBeInTheDocument();
      await vi.waitFor(() =>
        expect(titleOrder(screen.container, allTitles)).toEqual([
          "Pinned chat",
          "Newer chat",
          "Question chat",
          "Older chat",
          "Orchestrator chat",
          "Part one chat",
        ]),
      );
    });

    it("hides the section's rows when collapsed except the open thread, and remembers it", async () => {
      using stack = new DisposableStack();
      setupSection(stack, { sidebarLayout: "list", needsYouFirst: true, routeThreadId: "part" });
      {
        await using first = await render(tree());
        await expect.element(header(first)).toBeInTheDocument();
        header(first).element().focus();
        await userEvent.keyboard("{Enter}");
        await expect.element(header(first)).toHaveAttribute("aria-expanded", "false");
        expect(header(first).element().textContent).toBe("Needs you2");
        await expect
          .element(first.getByText("Question chat", { exact: true }))
          .not.toBeInTheDocument();
        expect(first.getByText("Part one chat", { exact: true }).all()).toHaveLength(1);
        expect(window.localStorage.getItem("t3code:sidebar:needs-you-expanded")).toBe("false");
      }
      await using screen = await render(tree());
      await expect.element(header(screen)).toHaveAttribute("aria-expanded", "false");
      await expect.element(screen.getByText("Part one chat", { exact: true })).toBeInTheDocument();
      expect(screen.getByText("Question chat", { exact: true }).query()).toBeNull();
    });
  });
});

describe("sidebar spawned sessions", () => {
  const environmentId = EnvironmentId.make("local");
  const appProject = project("acme-app");
  const apiProject = project("acme-api");
  const shell = (id: string, title: string, overrides: Partial<EnvironmentThreadShell> = {}) =>
    makeThreadFixture({
      environmentId,
      projectId: appProject.id,
      id: ThreadId.make(id),
      title,
      ...overrides,
    });
  const spawnedBy = (parentId: string) => ({
    lineage: {
      rootThreadId: ThreadId.make(parentId),
      parentThreadId: ThreadId.make(parentId),
      relationshipToParent: null,
    },
  });
  const parent = shell("parent", "Parent chat");
  const firstChild = shell("first-child", "First session", {
    ...spawnedBy("parent"),
    createdAt: "2026-01-02T00:00:00.000Z",
    latestUserMessageAt: "2026-01-02T12:00:00.000Z",
  });
  const secondChild = shell("second-child", "Second session", {
    ...spawnedBy("parent"),
    projectId: apiProject.id,
    createdAt: "2026-01-02T06:00:00.000Z",
  });
  const runningSecondChild = {
    ...secondChild,
    runtime: {
      status: "running" as const,
      activeRunId: null,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: "Codex",
      lastError: null,
      updatedAt: "2026-01-02T06:00:00.000Z",
    },
  };
  const other = shell("other", "Other chat");
  const parentKey = scopedThreadKey(scopeThreadRef(environmentId, parent.id));
  const tree = () => (
    <SidebarProvider>
      <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
    </SidebarProvider>
  );
  const follows = (earlier: Element, later: Element) =>
    (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  function setup(
    stack: DisposableStack,
    options: {
      readonly sidebarLayout: ClientSettings["sidebarLayout"];
      readonly threads: ReadonlyArray<EnvironmentThreadShell>;
      readonly routeThreadId?: string;
    },
  ) {
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      sidebarLayout: options.sidebarLayout,
    });
    stack.defer(() => window.localStorage.removeItem("t3code:sidebar:spawned-expanded"));
    stack.defer(() => useUiStateStore.setState({ projectExpandedById: {} }));
    stack.use(vi.spyOn(liveAtoms, "useInitiativeSidebarGroups").mockReturnValue([]));
    stack.use(vi.spyOn(liveAtoms, "useOpenDecisionThreadKeys").mockReturnValue([]));
    // The live shell is missing, so rows render from the snapshot alone.
    stack.use(vi.mocked(useThreadShell).mockReturnValue(null));
    stack.use(vi.mocked(useNowMinute).mockReturnValue("2026-01-03T00:00"));
    const routeThreadRef = {
      environmentId,
      threadId: ThreadId.make(options.routeThreadId ?? "other"),
    };
    vi.mocked(useProjects).mockReturnValue([appProject, apiProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue([...options.threads]);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: routeThreadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: { environmentId, projectId: appProject.id },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef,
    });
  }

  it("keeps sessions under their parent behind a count, opens them in place and navigates into them", async () => {
    using stack = new DisposableStack();
    setup(stack, {
      sidebarLayout: "list",
      threads: [parent, firstChild, runningSecondChild, other],
    });
    {
      await using first = await render(tree());
      // The name flips between Show and Hide, so the test id follows the one button.
      const toggle = first.getByTestId("sidebar-spawned-toggle");
      await expect
        .element(toggle)
        .toHaveAccessibleName("Show 2 sessions this thread started, 1 working");
      await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
      expect(toggle.element().textContent).toBe("2");
      expect(toggle.element().querySelector(".lucide-circle-dashed")).not.toBeNull();
      await expect.element(first.getByText("Other chat", { exact: true })).toBeInTheDocument();
      expect(first.getByText("First session", { exact: true }).query()).toBeNull();
      expect(first.getByText("Second session", { exact: true }).query()).toBeNull();

      toggle.element().focus();
      await userEvent.keyboard("{Enter}");
      await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
      await expect
        .element(toggle)
        .toHaveAccessibleName("Hide 2 sessions this thread started, 1 working");
      expect(first.router!.state.location.pathname).toBe("/");
      expect(JSON.parse(window.localStorage.getItem("t3code:sidebar:spawned-expanded")!)).toEqual({
        [parentKey]: true,
      });
      const parentRow = first.container.querySelector<HTMLElement>(
        `[data-sidebar-row="${CSS.escape(parentKey)}"]`,
      )!;
      const firstRow = first.getByRole("button", {
        name: "First session, session started by Parent chat",
      });
      const secondRow = first.getByRole("button", {
        name: "Second session, session started by Parent chat",
      });
      await expect.element(firstRow).toBeInTheDocument();
      await expect.element(secondRow).toBeInTheDocument();
      expect(follows(parentRow, firstRow.element())).toBe(true);
      expect(follows(firstRow.element(), secondRow.element())).toBe(true);
      // Neither child is also a top-level row.
      expect(first.container.querySelectorAll('[data-sidebar-row$=":first-child"]')).toHaveLength(
        1,
      );
      expect(firstRow.element().textContent).toContain("First session");
      expect(firstRow.element().textContent).toContain("12h");
      expect(secondRow.element().textContent).toContain("Working");

      parentRow.focus();
      await userEvent.keyboard("{ArrowRight}");
      await expect.element(firstRow).toHaveFocus();
      await userEvent.keyboard("{ArrowLeft}");
      expect(document.activeElement).toBe(parentRow);
    }
    await using screen = await render(tree());
    const reloaded = screen.getByTestId("sidebar-spawned-toggle");
    await expect
      .element(reloaded)
      .toHaveAccessibleName("Hide 2 sessions this thread started, 1 working");
    await expect.element(reloaded).toHaveAttribute("aria-expanded", "true");
    const child = screen.getByRole("button", {
      name: "First session, session started by Parent chat",
    });
    child.element().focus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(screen.router!.state.location.pathname).toBe(`/${environmentId}/first-child`),
    );

    reloaded.element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(reloaded).toHaveAttribute("aria-expanded", "false");
    await expect.element(screen.getByTestId("sidebar-row-spawned")).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem("t3code:sidebar:spawned-expanded")!)).toEqual({});
  });

  const failedChild = {
    ...secondChild,
    runtime: { ...runningSecondChild.runtime, status: "failed" as const },
  };
  const needyChild = { ...firstChild, hasPendingApprovals: true };

  it.each([
    {
      name: "a session that needs you outranks a working one",
      children: [needyChild, runningSecondChild],
      label: "Needs you",
      icon: "lucide-hand",
    },
    {
      name: "a failed session outranks an idle one",
      children: [firstChild, failedChild],
      label: "1 failed",
      icon: "lucide-circle-alert",
    },
    {
      name: "a working session shows more than a colour",
      children: [firstChild, runningSecondChild],
      label: "1 working",
      icon: "lucide-circle-dashed",
    },
  ])("states the strongest session state in words and an icon: $name", async (spec) => {
    using stack = new DisposableStack();
    setup(stack, { sidebarLayout: "list", threads: [parent, ...spec.children, other] });
    await using screen = await render(tree());
    const toggle = screen.getByTestId("sidebar-spawned-toggle");
    await expect
      .element(toggle)
      .toHaveAccessibleName(`Show 2 sessions this thread started, ${spec.label}`);
    expect(toggle.element().querySelector(`.${spec.icon}`)).not.toBeNull();
    expect(toggle.element().textContent).toBe("2");
    expect(toggle.element().querySelector(".text-secondary-label")?.textContent).toBe("2");
  });

  it.each([
    { name: "needs approval", child: needyChild, label: "acme-app, Needs you" },
    { name: "failed", child: failedChild, label: "acme-app, 1 failed" },
  ])(
    "reads a closed folder's nested session that is $name as the folder's status",
    async ({ child, label }) => {
      using stack = new DisposableStack();
      setup(stack, { sidebarLayout: "projects", threads: [parent, child, other] });
      await using screen = await render(tree());
      const folder = screen.getByTestId("sidebar-project-folder").getByRole("button").first();
      await expect.element(folder).toHaveAttribute("aria-expanded", "true");
      folder.element().focus();
      await userEvent.keyboard("{Enter}");
      await expect.element(folder).toHaveAttribute("aria-expanded", "false");
      await expect.element(folder).toHaveAccessibleName(label);
    },
  );

  it("follows the snapshot: nothing while loading, hidden without the parent, nested with it, gone with the children", async () => {
    using stack = new DisposableStack();
    setup(stack, { sidebarLayout: "list", threads: [] });
    await using screen = await render(tree());
    const toggles = () =>
      screen.container.querySelectorAll('[data-testid="sidebar-spawned-toggle"]');
    expect(toggles()).toHaveLength(0);
    expect(screen.container.querySelectorAll('[data-testid="sidebar-row-spawned"]')).toHaveLength(
      0,
    );

    // The parent is archived, so it is absent from the shells.
    vi.mocked(useQuietThreadShells).mockReturnValue([firstChild, secondChild, other]);
    await screen.rerender(tree());
    await expect.element(screen.getByText("Other chat", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("First session", { exact: true }).query()).toBeNull();
    expect(screen.getByText("Second session", { exact: true }).query()).toBeNull();
    expect(toggles()).toHaveLength(0);

    vi.mocked(useQuietThreadShells).mockReturnValue([parent, firstChild, secondChild, other]);
    await screen.rerender(tree());
    const toggle = screen.getByRole("button", { name: "Show 2 sessions this thread started" });
    await expect.element(toggle).toBeInTheDocument();
    expect(toggle.element().querySelector(".text-secondary-label")?.textContent).toBe("2");
    expect(screen.getByText("First session", { exact: true }).query()).toBeNull();
    toggle.element().focus();
    await userEvent.keyboard("{Enter}");
    await expect
      .element(
        screen.getByRole("button", { name: "First session, session started by Parent chat" }),
      )
      .toBeInTheDocument();

    vi.mocked(useQuietThreadShells).mockReturnValue([parent, other]);
    await screen.rerender(tree());
    await vi.waitFor(() => expect(toggles()).toHaveLength(0));
    // A removed row fades out as a clone without its test id, so match the live rows only.
    await expect.element(screen.getByTestId("sidebar-row-spawned")).not.toBeInTheDocument();
    await expect
      .element(screen.getByText("Parent chat", { exact: true }).first())
      .toBeInTheDocument();
  });

  it("gives no folder to a project whose only thread is nested, and keeps an open child with its parent in a closed folder", async () => {
    using stack = new DisposableStack();
    setup(stack, {
      sidebarLayout: "projects",
      threads: [parent, firstChild, secondChild, other],
      routeThreadId: "second-child",
    });
    await using screen = await render(tree());
    const folders = () =>
      [...screen.container.querySelectorAll('[data-testid="sidebar-project-folder"]')].map(
        (folder) => folder.textContent ?? "",
      );
    await vi.waitFor(() => expect(folders()).toHaveLength(1));
    expect(folders()[0]).toContain("acme-app");
    expect(folders()[0]).not.toContain("acme-api");

    // Collapsed by default, the list still shows the open child under its parent.
    const secondRow = screen.getByRole("button", {
      name: "Second session, session started by Parent chat",
    });
    await expect.element(secondRow).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("First session", { exact: true }).query()).toBeNull();

    const folder = screen.getByTestId("sidebar-project-folder").getByRole("button").first();
    folder.element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(folder).toHaveAttribute("aria-expanded", "false");
    await expect.element(screen.getByText("Other chat", { exact: true })).not.toBeInTheDocument();
    await expect.element(screen.getByText("Parent chat", { exact: true })).toBeInTheDocument();
    await expect.element(secondRow).toBeInTheDocument();
    expect(
      follows(screen.getByText("Parent chat", { exact: true }).element(), secondRow.element()),
    ).toBe(true);
  });
});
