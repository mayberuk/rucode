import { DEFAULT_CLIENT_SETTINGS, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { AnyRouter } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";

import { toastManager } from "~/components/ui/toast";
import * as commandPalette from "../commandPaletteBus";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import * as previewActions from "../components/preview/previewActionBus";
import * as settings from "../hooks/useSettings";
import * as storage from "../hooks/useLocalStorage";
import * as threadActions from "../lib/chatThreadActions";
import * as entities from "../state/entities";
import * as projectsState from "../state/projects";
import * as session from "../state/session";
import { Atom } from "effect/reactivity";
import type { Project } from "../types";
import { installChatRouteCommands } from "./chatRouteCommands";
import * as dispatcher from "./dispatcher";

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

describe("new thread commands", () => {
  it.each([
    { mode: "normal", count: 2, command: "chat.new", picker: true },
    { mode: "boring", count: 2, command: "chat.new", picker: true },
    { mode: "boring", count: 1, command: "chat.new", picker: false },
    { mode: "boring", count: 2, command: "chat.newLocal", picker: false },
  ] as const)("$mode sidebar, $count projects, $command: picker=$picker", (scenario) => {
    using _settings = vi.spyOn(settings, "getClientSettings").mockReturnValue({
      ...DEFAULT_CLIENT_SETTINGS,
      sidebarLayout: scenario.mode === "boring" ? "projects" : "list",
    });
    using _projects = vi
      .spyOn(entities, "readProjects")
      .mockReturnValue([project("active"), project("idle")].slice(0, scenario.count));
    using _ready = vi
      .spyOn(projectsState, "defaultProjectFallbackReadyAtom")
      .mockReturnValue(Atom.make(true));
    using storedProject = vi.spyOn(storage, "getLocalStorageItem").mockReturnValue("local:active");
    using openPicker = vi.spyOn(commandPalette, "openCommandPalette").mockImplementation(() => {});
    using startLocal = vi.spyOn(threadActions, "startNewThreadFromContext").mockResolvedValue(true);
    using register = vi.spyOn(dispatcher, "registerCommands").mockReturnValue(() => {});
    const router = { state: { matches: [] } } as unknown as AnyRouter;
    using stack = new DisposableStack();
    stack.defer(installChatRouteCommands(router));
    const commands = register.mock.calls[0]![0];
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;

    storedProject.mockReturnValue("local:idle");
    commands[scenario.command]!(event);

    if (scenario.picker) {
      expect(openPicker).toHaveBeenCalledWith({ open: "new-thread-in" });
      expect(startLocal).not.toHaveBeenCalled();
    } else {
      expect(openPicker).not.toHaveBeenCalled();
      expect(startLocal).toHaveBeenCalledOnce();
      expect(startLocal.mock.calls[0]![0].defaultProjectRef).toEqual({
        environmentId: "local",
        projectId: scenario.count === 1 ? "active" : "idle",
      });
    }
  });
});

describe("preview commands", () => {
  it.each([
    { command: "preview.find", action: "find" },
    { command: "preview.refresh", action: "refresh" },
    { command: "preview.focusUrl", action: "focus-url" },
  ] as const)("$command reaches the right panel on a draft thread", ({ command, action }) => {
    const draftId = DraftId.make("draft-1");
    useComposerDraftStore
      .getState()
      .setProjectDraftThreadId(
        { environmentId: EnvironmentId.make("local"), projectId: ProjectId.make("active") },
        draftId,
      );
    using stack = new DisposableStack();
    stack.defer(() => useComposerDraftStore.getState().clearDraftThread(draftId));
    using _scope = vi.spyOn(session, "readEnvironmentScope").mockReturnValue(true);
    using dispatch = vi.spyOn(previewActions, "dispatchPreviewAction").mockImplementation(() => {});
    using register = vi.spyOn(dispatcher, "registerCommands").mockReturnValue(() => {});
    const router = {
      state: { matches: [{ routeId: "/_chat/draft/$draftId", params: { draftId } }] },
    } as unknown as AnyRouter;
    stack.defer(installChatRouteCommands(router));
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent;

    register.mock.calls[0]![0][command]!(event);

    expect(dispatch).toHaveBeenCalledWith(action);
  });
});

describe("thread.nextWaiting", () => {
  function shell(id: string, createdAt: string, waiting: boolean): EnvironmentThreadShell {
    return {
      environmentId: EnvironmentId.make("local"),
      id: ThreadId.make(id),
      projectId: ProjectId.make("active"),
      createdAt,
      unsettledAt: null,
      latestRun: null,
      hasPendingApprovals: waiting,
      hasPendingUserInput: false,
      pendingSubagentRequest: null,
      archivedAt: null,
      pinnedAt: null,
      pinOrderKey: null,
      activeOrderKey: null,
    } as unknown as EnvironmentThreadShell;
  }

  function press(input: { shells: EnvironmentThreadShell[]; openThreadId: string | null }) {
    using _shells = vi.spyOn(entities, "readThreadShells").mockReturnValue(input.shells);
    using register = vi.spyOn(dispatcher, "registerCommands").mockReturnValue(() => {});
    const toast = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    const navigate = vi.fn();
    const router = {
      state: {
        matches: [
          {
            routeId: "/_chat/$environmentId/$threadId",
            params:
              input.openThreadId === null
                ? {}
                : { environmentId: "local", threadId: input.openThreadId },
          },
        ],
      },
      navigate,
    } as unknown as AnyRouter;
    const uninstall = installChatRouteCommands(router);
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent;
    register.mock.calls[0]![0]["thread.nextWaiting"]!(event);
    uninstall();
    const titles = toast.mock.calls.map(([options]) => options.title);
    toast.mockRestore();
    return { navigate, titles, event };
  }

  // Newest first in sidebar order: c, b, a.
  const A = shell("a", "2026-01-01T00:00:00.000Z", true);
  const B = shell("b", "2026-01-02T00:00:00.000Z", false);
  const C = shell("c", "2026-01-03T00:00:00.000Z", true);

  it("opens the next waiting chat after the open one and claims the key", () => {
    const { navigate, titles, event } = press({ shells: [A, B, C], openThreadId: "c" });

    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "local", threadId: "a" },
    });
    expect(titles).toEqual([]);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("wraps to the first waiting chat from the last one", () => {
    const { navigate } = press({ shells: [A, B, C], openThreadId: "a" });

    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "local", threadId: "c" },
    });
  });

  it("opens the first waiting chat from a route that is not a thread", () => {
    const { navigate } = press({ shells: [A, B, C], openThreadId: null });

    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "local", threadId: "c" },
    });
  });

  it("stays put and says so when the open chat is the only one waiting", () => {
    const { navigate, titles } = press({ shells: [A, B], openThreadId: "a" });

    expect(navigate).not.toHaveBeenCalled();
    expect(titles).toEqual(["No other chat waiting"]);
  });

  it("stays put and says so when no chat is waiting", () => {
    const { navigate, titles } = press({
      shells: [shell("a", "2026-01-01T00:00:00.000Z", false), B],
      openThreadId: "a",
    });

    expect(navigate).not.toHaveBeenCalled();
    expect(titles).toEqual(["No chat waiting"]);
  });

  it("says no chat is waiting before any thread list has loaded", () => {
    const { navigate, titles } = press({ shells: [], openThreadId: "a" });

    expect(navigate).not.toHaveBeenCalled();
    expect(titles).toEqual(["No chat waiting"]);
  });
});
