import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { isThreadWorking as isSidebarThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import * as DateTime from "effect/DateTime";
import { deriveActiveWorkStartedAt } from "../session-logic.ts";
import { describe, expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import {
  shouldCreateNewThreadInCurrentProject,
  deleteSelectedThreadEntries,
  getFallbackThreadIdAfterDelete,
  hasUnseenCompletion,
  orderItemsByPreferredIds,
  pinOrderKeyBetween,
  resolveSidebarSweepKeys,
  resolveSidebarRowStatus,
  resolveSidebarTerminalStatus,
  resolveSidebarThreadStatus,
  resolveThreadStatusPill,
  resolveWindowTitleThreadStatus,
  resolveWorkingStartedAt,
  searchSidebarThreads,
  shouldRecedeSidebarThread,
  sortInboxThreadsByReturn,
  resolveSidebarDropTarget,
  sidebarMarkerId,
  planSidebarThreadDrop,
  resolveSidebarReorderableThreadKeys,
  sortPinnedThreadsForSidebar,
  sortScopedProjectsForSidebar,
  sortSidebarV2ProjectGroups,
  shouldNavigateAfterThreadPark,
  type SidebarListItem,
  type SidebarListMarker,
  type SidebarSection,
  resolveSidebarDropVerb,
  groupSidebarFolders,
  groupSidebarThreadsByProject,
  nestSpawnedThreads,
  spawnedChildrenOf,
  visibleSpawnedChildren,
  withoutSpawnedThreads,
  partitionInitiativeThreads,
  resolveSidebarGroupStatus,
  isSidebarThreadNeedingYou,
  selectNeedsYouThreads,
  placeListInitiatives,
  sidebarListItemsKey,
  type ListInboxEntry,
  resolveInboxShelf,
  sidebarFolderExpansionKeys,
  skipFixedSortableItems,
} from "./Sidebar.logic";
import { createSidebarSortingStrategy } from "./Sidebar.drag";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
} from "@t3tools/client-runtime/state/thread-sort";
import { resolveProjectExpanded } from "../uiStateStore";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import { EnvironmentId, ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";

import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type Project,
  type Thread,
} from "../types";
import { makeThreadFixture, type ThreadFixtureOverrides } from "../test-fixtures";
import {
  completeSidebarRouteReveal,
  pendingSidebarRouteReveal,
  resolveSidebarRouteReveal,
} from "./sidebar/routeReveal";

const localEnvironmentId = EnvironmentId.make("environment-local");

describe("deleteSelectedThreadEntries", () => {
  const entries = [{ threadKey: "one" }, { threadKey: "two" }, { threadKey: "three" }] as const;
  const success = AsyncResult.success(undefined);
  const failure = AsyncResult.failure(Cause.fail(new Error("Delete failed")));
  const interrupted = AsyncResult.failure(Cause.interrupt());

  it("waits for each delete and excludes only earlier successes from worktree checks", async () => {
    let resolveDelete!: (result: typeof success) => void;
    const pendingDelete = new Promise<typeof success>((resolve) => {
      resolveDelete = resolve;
    });
    const worktreeChecks: { threadKey: string; deletedThreadKeys: string[] }[] = [];
    const deletion = deleteSelectedThreadEntries({
      entries,
      delete: async ({ threadKey }, deletedThreadKeys) => {
        worktreeChecks.push({ threadKey, deletedThreadKeys: [...deletedThreadKeys] });
        return threadKey === "one" ? pendingDelete : success;
      },
    });

    expect(worktreeChecks).toEqual([{ threadKey: "one", deletedThreadKeys: [] }]);
    resolveDelete(success);
    const outcome = await deletion;

    expect(worktreeChecks).toEqual([
      { threadKey: "one", deletedThreadKeys: [] },
      { threadKey: "two", deletedThreadKeys: ["one"] },
      { threadKey: "three", deletedThreadKeys: ["one", "two"] },
    ]);
    expect(outcome).toEqual({
      deletedThreadKeys: new Set(["one", "two", "three"]),
      firstFailure: null,
    });
  });

  it("continues after ordinary failures and keeps the first failure", async () => {
    const laterFailure = AsyncResult.failure(Cause.fail(new Error("Later failure")));
    const deletedKeysAtLastEntry: string[][] = [];
    const outcome = await deleteSelectedThreadEntries({
      entries: [...entries, { threadKey: "four" }],
      delete: async ({ threadKey }, deletedThreadKeys) => {
        if (threadKey === "one") return failure;
        if (threadKey === "three") return laterFailure;
        if (threadKey === "four") deletedKeysAtLastEntry.push([...deletedThreadKeys]);
        return success;
      },
    });

    expect(deletedKeysAtLastEntry).toEqual([["two"]]);
    expect(outcome).toEqual({
      deletedThreadKeys: new Set(["two", "four"]),
      firstFailure: failure,
    });
  });

  it.each([
    { firstResult: success, deletedThreadKeys: new Set(["one"]), firstFailure: null },
    { firstResult: failure, deletedThreadKeys: new Set<string>(), firstFailure: failure },
  ])("stops on interruption and preserves earlier results %#", async (testCase) => {
    const attemptedThreadKeys: string[] = [];
    const outcome = await deleteSelectedThreadEntries({
      entries,
      delete: async ({ threadKey }) => {
        attemptedThreadKeys.push(threadKey);
        return threadKey === "one" ? testCase.firstResult : interrupted;
      },
    });

    expect(attemptedThreadKeys).toEqual(["one", "two"]);
    expect(outcome).toEqual({
      deletedThreadKeys: testCase.deletedThreadKeys,
      firstFailure: testCase.firstFailure,
    });
  });
});

function makeLatestRun(overrides?: {
  completedAt?: string | null;
  startedAt?: string | null;
}): NonNullable<Thread["latestRun"]> {
  return {
    runId: "turn-1" as never,
    status: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt:
      overrides?.startedAt !== undefined ? overrides.startedAt : "2026-03-09T10:00:00.000Z",
    completedAt:
      overrides?.completedAt !== undefined ? overrides.completedAt : "2026-03-09T10:05:00.000Z",
  };
}

describe("orderItemsByPreferredIds", () => {
  it("resolves legacy preference aliases without materializing project state", () => {
    const ordered = orderItemsByPreferredIds({
      items: [
        { id: "physical-a", cwd: "/work/a" },
        { id: "physical-b", cwd: "/work/b" },
        { id: "physical-c", cwd: "/work/c" },
      ],
      preferredIds: ["legacy:/work/c", "legacy:/work/a"],
      getId: (project) => project.id,
      getPreferenceIds: (project) => [project.id, `legacy:${project.cwd}`],
    });

    expect(ordered.map((project) => project.id)).toEqual([
      "physical-c",
      "physical-a",
      "physical-b",
    ]);
  });
});

describe("resolveSidebarThreadStatus", () => {
  const runtime = {
    status: "running" as const,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
  };

  const idle = { hasPendingApprovals: false, hasPendingUserInput: false, runtime: null };

  it("prioritizes awaiting input over a running runtime, below approval", () => {
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        hasPendingUserInput: true,
        runtime,
        blockedOnThreadWait: true,
      }),
    ).toBe("input");
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        hasPendingApprovals: true,
        hasPendingUserInput: true,
        blockedOnThreadWait: true,
        runtime,
      }),
    ).toBe("approval");
  });

  it("shows a waiting guest message as a Request, below the agent's own requests", () => {
    expect(resolveSidebarThreadStatus({ ...idle, pendingGuestMessageCount: 1, runtime })).toBe(
      "request",
    );
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        hasPendingUserInput: true,
        pendingGuestMessageCount: 1,
      }),
    ).toBe("input");
  });

  it("shows an open decision above Request, Waiting and Working but below the agent's own asks", () => {
    const openDecision = { openDecision: true };
    expect(resolveSidebarThreadStatus(idle, openDecision)).toBe("decision");
    expect(resolveSidebarThreadStatus({ ...idle, runtime }, openDecision)).toBe("decision");
    expect(resolveSidebarThreadStatus({ ...idle, pendingGuestMessageCount: 1 }, openDecision)).toBe(
      "decision",
    );
    expect(
      resolveSidebarThreadStatus({ ...idle, runtime, blockedOnThreadWait: true }, openDecision),
    ).toBe("decision");
    expect(
      resolveSidebarThreadStatus(
        { ...idle, runtime: { ...runtime, status: "idle" as const } },
        openDecision,
      ),
    ).toBe("decision");
    expect(
      resolveSidebarThreadStatus(
        { ...idle, runtime: { ...runtime, status: "failed" as const, lastError: "boom" } },
        openDecision,
      ),
    ).toBe("decision");
    expect(
      resolveSidebarThreadStatus({ ...idle, hasPendingApprovals: true, runtime }, openDecision),
    ).toBe("approval");
    expect(
      resolveSidebarThreadStatus({ ...idle, pendingSubagentRequest: "approval" }, openDecision),
    ).toBe("approval");
    expect(
      resolveSidebarThreadStatus({ ...idle, hasPendingUserInput: true, runtime }, openDecision),
    ).toBe("input");
    expect(
      resolveSidebarThreadStatus({ ...idle, pendingSubagentRequest: "user_input" }, openDecision),
    ).toBe("input");
  });

  it("leaves the ordinary status alone without an open decision", () => {
    expect(resolveSidebarThreadStatus({ ...idle, runtime })).toBe("working");
    expect(resolveSidebarThreadStatus({ ...idle, runtime }, {})).toBe("working");
    expect(resolveSidebarThreadStatus({ ...idle, runtime }, { openDecision: false })).toBe(
      "working",
    );
    expect(resolveSidebarThreadStatus(idle, { openDecision: false })).toBe("ready");
  });

  it("keeps usage-limit stops Limited and visible until the thread recovers", () => {
    const limited = {
      ...runtime,
      status: "failed" as const,
      lastError: "Plan limit reached",
      lastErrorClass: "usage_limit" as const,
    };
    expect(resolveSidebarThreadStatus({ ...idle, runtime: limited })).toBe("limited");
    expect(
      resolveSidebarThreadStatus({ ...idle, runtime: { ...limited, status: "running" } }),
    ).toBe("working");
    expect(
      resolveSidebarThreadStatus({ ...idle, runtime: { ...limited, status: "completed" } }),
    ).toBe("ready");
    expect(
      shouldRecedeSidebarThread({
        status: "limited",
        isUnread: false,
        isWoke: false,
        isActive: false,
        isSelected: false,
      }),
    ).toBe(false);
  });

  it("never recedes a decision row, however quiet it otherwise is", () => {
    for (const isUnread of [false, true]) {
      for (const isWoke of [false, true]) {
        expect(
          shouldRecedeSidebarThread({
            status: "decision",
            isUnread,
            isWoke,
            isActive: false,
            isSelected: false,
          }),
        ).toBe(false);
      }
    }
  });

  it("reports worktree setup as preparing, and failed only while the latest run failed", () => {
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        runtime: { ...runtime, status: "preparing" as const },
      }),
    ).toBe("preparing");
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        runtime: { ...runtime, status: "failed" as const, lastError: "boom" },
      }),
    ).toBe("failed");
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        runtime: { ...runtime, status: "completed" as const, lastError: "persisted" },
      }),
    ).toBe("ready");
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        runtime: { ...runtime, status: "idle" as const, lastError: "persisted" },
      }),
    ).toBe("waiting");
  });

  it("titles the window with live work and requests only", () => {
    const cases = [
      [{ ...idle, hasPendingApprovals: true, runtime }, "Needs approval"],
      [{ ...idle, hasPendingUserInput: true }, "Needs your input"],
      [{ ...idle, runtime: { ...runtime, status: "preparing" as const } }, "Working"],
      [{ ...idle, runtime }, "Working"],
      [{ ...idle, runtime, pendingGuestMessageCount: 1 }, "Working"],
      [{ ...idle, runtime, blockedOnThreadWait: true }, "Working"],
      [{ ...idle, runtime: { ...runtime, status: "idle" as const } }, null],
      [{ ...idle, runtime: { ...runtime, status: "failed" as const } }, null],
      [{ ...idle, runtime: { ...runtime, status: "completed" as const } }, null],
      [idle, null],
    ] as const;
    for (const [thread, title] of cases) {
      expect(resolveWindowTitleThreadStatus(thread)).toBe(title);
    }
  });
});

describe("resolveSidebarRowStatus", () => {
  const failedRuntime = {
    status: "failed" as const,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: "Provider turn failed.",
    updatedAt: "2026-03-09T10:05:00.000Z",
  };
  const failed = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    runtime: failedRuntime,
    latestRun: { ...makeLatestRun(), status: "failed" as const },
  };

  it("settles a failure the user opened to ready, without showing Done", () => {
    expect(resolveSidebarRowStatus({ ...failed, lastVisitedAt: undefined })).toBe("failed");

    const opened = { ...failed, lastVisitedAt: "2026-03-09T10:06:00.000Z" };
    expect(resolveSidebarRowStatus(opened)).toBe("ready");
    expect(hasUnseenCompletion(opened)).toBe(false);
    // A runtime failure without a failed run has no date, so a visit cannot settle it.
    expect(resolveSidebarRowStatus({ ...opened, latestRun: null })).toBe("failed");
  });

  it("shows an open decision even on a failure the user already opened", () => {
    const opened = { ...failed, lastVisitedAt: "2026-03-09T10:06:00.000Z" };
    expect(resolveSidebarRowStatus(opened, { openDecision: true })).toBe("decision");
    expect(
      resolveSidebarRowStatus({ ...failed, lastVisitedAt: undefined }, { openDecision: true }),
    ).toBe("decision");
    expect(resolveSidebarRowStatus(opened, { openDecision: false })).toBe("ready");
    expect(
      resolveSidebarRowStatus({ ...opened, hasPendingApprovals: true }, { openDecision: true }),
    ).toBe("approval");
  });

  it.each([
    ["working", "busy", "terminal-busy"],
    ["ready", "busy", "terminal-busy"],
    ["ready", "shell", "terminal-busy"],
    ["ready", "idle", "terminal-idle"],
    ["waiting", "idle", "terminal-idle"],
    ["failed", "unknown", "terminal-idle"],
    ["decision", "busy", null],
    ["approval", "idle", null],
    ["input", "idle", null],
  ] as const)(
    "a %s row open in a terminal that is %s shows %s",
    (rowStatus, terminalStatus, expected) => {
      expect(resolveSidebarTerminalStatus(rowStatus, { status: terminalStatus })).toBe(expected);
    },
  );

  it("leaves the row's own status alone when no terminal holds it", () => {
    expect(resolveSidebarTerminalStatus("working", null)).toBeNull();
    expect(resolveSidebarTerminalStatus("ready", null)).toBeNull();
  });

  it("does not show a stopped run as an unseen completion", () => {
    for (const status of ["interrupted", "cancelled"] as const) {
      const stopped = {
        ...failed,
        runtime: { ...failedRuntime, status, lastError: null },
        latestRun: { ...makeLatestRun(), status },
        lastVisitedAt: "2026-03-09T10:01:00.000Z",
      };
      expect(hasUnseenCompletion(stopped)).toBe(false);
      expect(resolveThreadStatusPill({ thread: stopped })).toBeNull();
    }
  });
});

describe("searchSidebarThreads", () => {
  const searchThread = (id: string, title: string, latestUserMessageAt: string) => ({
    environmentId: localEnvironmentId,
    id: ThreadId.make(id),
    title,
    branch: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: latestUserMessageAt,
    latestUserMessageAt,
    opens: null,
  });
  const threads = [
    searchThread("thread-1", "Fix workspace search", "2026-10-20T00:00:00.000Z"),
    searchThread("thread-2", "Review providers", "2026-10-22T00:00:00.000Z"),
    searchThread("thread-3", "WORKTREE cleanup", "2026-09-01T00:00:00.000Z"),
    searchThread("thread-4", "Homework notes", "2026-10-22T00:00:00.000Z"),
  ];
  const now = Date.parse("2026-10-23T00:00:00.000Z");
  const contentKeys = (...ids: ReadonlyArray<string>) =>
    new Set(
      ids.map((id) =>
        threadSearchMatchKey({ environmentId: localEnvironmentId, threadId: ThreadId.make(id) }),
      ),
    );

  it("ranks word matches by recent use, then lists message matches once", () => {
    expect(searchSidebarThreads(threads, "work", contentKeys("thread-1", "thread-2"), now)).toEqual(
      {
        titleMatches: [threads[0], threads[2], threads[3]],
        contentMatches: [threads[1]],
      },
    );
  });
});

describe("resolveWorkingStartedAt", () => {
  const runtime = {
    status: "running" as const,
    providerName: "Codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    activeRunId: RunId.make("turn-1"),
    lastError: null,
    updatedAt: "2026-03-09T10:02:00.000Z",
  };

  it("does not invent a start from activity updates when the newest run completed", () => {
    expect(
      resolveWorkingStartedAt({
        latestRun: makeLatestRun(),
        runtime,
      }),
    ).toBeNull();
  });

  it.each(["queued", "cancelled"] as const)(
    "shares the detail timer when a newer run is %s",
    (status) => {
      const activityStartedAt = "2026-03-09T10:00:00.000Z";
      const latestRun = {
        ...makeLatestRun(),
        runId: RunId.make("newer-run"),
        status,
        startedAt: null,
        completedAt: status === "queued" ? null : "2026-03-09T10:05:00.000Z",
      };
      for (const updatedAt of ["2026-03-09T10:30:00.000Z", "2026-03-09T10:50:00.000Z"]) {
        const activeRuntime = { ...runtime, updatedAt, activityStartedAt };
        expect(resolveWorkingStartedAt({ latestRun, runtime: activeRuntime })).toBe(
          activityStartedAt,
        );
        expect(deriveActiveWorkStartedAt(latestRun, activeRuntime, updatedAt)).toBe(
          activityStartedAt,
        );
      }
      expect(
        deriveActiveWorkStartedAt(
          latestRun,
          { ...runtime, activityStartedAt: null },
          "2026-03-09T10:50:00.000Z",
        ),
      ).toBeNull();
    },
  );
});

describe("resolveThreadStatusPill", () => {
  const baseThread = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "plan" as const,
    latestRun: null,
    lastVisitedAt: undefined,
    runtime: {
      status: "running" as const,
      providerName: "Codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      activeRunId: "turn-1" as never,
      lastError: null,
      updatedAt: "2026-03-09T10:00:00.000Z",
    },
  };

  it("shows an active thread wait without a pulse and resumes Working when it ends", () => {
    const blocked = { ...baseThread, blockedOnThreadWait: true };
    expect(resolveSidebarThreadStatus(blocked)).toBe("waiting");
    expect(resolveThreadStatusPill({ thread: blocked })).toMatchObject({
      label: "Waiting",
      pulse: false,
    });

    const resumed = { ...blocked, blockedOnThreadWait: false };
    expect(resolveSidebarThreadStatus(resumed)).toBe("working");
    expect(resolveThreadStatusPill({ thread: resumed })).toMatchObject({
      label: "Working",
      pulse: true,
    });
  });

  it("shows waiting for an idle thread with pending background tasks", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          pendingBackgroundTasks: [
            { taskId: "bg-1", description: "Watch build", kind: "monitor", awaited: true },
          ],
          runtime: {
            ...baseThread.runtime,
            status: "idle",
            activeRunId: null,
          },
        },
      }),
    ).toMatchObject({
      label: "Waiting",
      colorClass: "text-sidebar-muted-foreground",
      dotClass: "bg-sidebar-muted-foreground",
      pulse: false,
    });
  });

  it("shows plan ready when a settled plan turn has a proposed plan ready for follow-up", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasActionableProposedPlan: true,
          latestRun: makeLatestRun(),
          runtime: {
            ...baseThread.runtime,
            status: "completed",
            activeRunId: null,
          },
        },
      }),
    ).toMatchObject({ label: "Plan Ready", pulse: false });
  });

  it("does not manufacture completed state without a client visit marker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestRun: makeLatestRun(),
          runtime: {
            ...baseThread.runtime,
            status: "completed",
            activeRunId: null,
          },
        },
      }),
    ).toBeNull();
  });

  it("shows completed when there is an unseen completion and no active blocker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          interactionMode: "default",
          latestRun: makeLatestRun(),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          runtime: {
            ...baseThread.runtime,
            status: "completed",
            activeRunId: null,
          },
        },
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });

  it("shows failed, not completed, when the unseen run failed", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          interactionMode: "default",
          latestRun: { ...makeLatestRun(), status: "failed" },
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          runtime: {
            ...baseThread.runtime,
            status: "failed",
            activeRunId: null,
            lastError: "Provider turn failed.",
          },
        },
      }),
    ).toMatchObject({ label: "Failed", pulse: false });
  });

  it("shows failed, not plan ready, when a plan run proposed a plan and then failed", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasActionableProposedPlan: true,
          latestRun: { ...makeLatestRun(), status: "failed" },
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          runtime: { ...baseThread.runtime, status: "failed", activeRunId: null },
        },
      }),
    ).toMatchObject({ label: "Failed" });
  });

  it("drops the failed pill once the failure has been seen", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          interactionMode: "default",
          latestRun: { ...makeLatestRun(), status: "failed" },
          lastVisitedAt: "2026-03-09T10:06:00.000Z",
          runtime: { ...baseThread.runtime, status: "failed", activeRunId: null },
        },
      }),
    ).toBeNull();
  });
});

function makeProject(overrides: Partial<Project> = {}): Project {
  const { defaultModelSelection, ...rest } = overrides;
  return {
    id: ProjectId.make("project-1"),
    environmentId: localEnvironmentId,
    title: "Project",
    workspaceRoot: "/tmp/project",
    repositoryIdentity: null,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      ...defaultModelSelection,
    },
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    scripts: [],
    ...rest,
  };
}

function makeThread(overrides: ThreadFixtureOverrides = {}): Thread {
  return makeThreadFixture({
    id: ThreadId.make("thread-1"),
    environmentId: localEnvironmentId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      ...overrides?.modelSelection,
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    runtime: null,
    messages: [],
    proposedPlans: [],
    createdAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestRun: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  });
}

describe("getFallbackThreadIdAfterDelete", () => {
  it("skips other threads being deleted in the same action", () => {
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads: [
        makeThread({
          id: ThreadId.make("thread-active"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-newest"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:10:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-next"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:07:00.000Z",
          messages: [],
        }),
      ],
      deletedThreadId: ThreadId.make("thread-active"),
      deletedThreadIds: new Set([ThreadId.make("thread-active"), ThreadId.make("thread-newest")]),
      sortOrder: "created_at",
      now: "2026-03-09T10:10:00.000Z",
      delegatedUnderParent: new Set(),
    });

    expect(fallbackThreadId).toBe(ThreadId.make("thread-next"));
  });

  it.each([
    [
      "snoozed",
      { snoozedUntil: "2099-01-01T00:00:00.000Z", snoozedAt: "2026-03-09T10:06:00.000Z" },
    ],
    ["delegated", { id: ThreadId.make("thread-delegated") }],
    ["settled", { settledOverride: "settled", settledAt: "2026-03-09T10:06:00.000Z" }],
    [
      "side chat",
      {
        lineage: {
          rootThreadId: ThreadId.make("thread-visible"),
          parentThreadId: ThreadId.make("thread-visible"),
          relationshipToParent: "fork",
          sideChat: true,
        },
      },
    ],
    [
      "subagent",
      {
        lineage: {
          rootThreadId: ThreadId.make("thread-visible"),
          parentThreadId: ThreadId.make("thread-visible"),
          relationshipToParent: "subagent",
        },
      },
    ],
  ] as const)("skips a %s thread the sidebar does not list", (_state, parked) => {
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads: [
        makeThread({
          id: ThreadId.make("thread-visible"),
          createdAt: "2026-03-09T10:01:00.000Z",
          updatedAt: "2026-03-09T10:01:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-parked"),
          createdAt: "2026-03-09T10:02:00.000Z",
          updatedAt: "2026-03-09T10:06:00.000Z",
          ...parked,
        }),
        makeThread({
          id: ThreadId.make("thread-active"),
          createdAt: "2026-03-09T10:03:00.000Z",
          updatedAt: "2026-03-09T10:03:00.000Z",
        }),
      ],
      deletedThreadId: ThreadId.make("thread-active"),
      sortOrder: "created_at",
      now: "2026-03-09T10:10:00.000Z",
      delegatedUnderParent: new Set([
        threadKey({
          environmentId: localEnvironmentId,
          threadId: ThreadId.make("thread-delegated"),
        }),
      ]),
    });

    expect(fallbackThreadId).toBe(ThreadId.make("thread-visible"));
  });
});

describe("sortScopedProjectsForSidebar", () => {
  it("keeps identical project ids in different environments separate", () => {
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const sharedProjectId = ProjectId.make("shared-project");
    const projects = [
      makeProject({
        environmentId: localEnvironmentId,
        id: sharedProjectId,
        title: "Local project",
      }),
      makeProject({
        environmentId: remoteEnvironmentId,
        id: sharedProjectId,
        title: "Remote project",
      }),
    ];
    const threads = [
      makeThread({
        environmentId: localEnvironmentId,
        projectId: sharedProjectId,
        updatedAt: "2026-03-09T10:02:00.000Z",
      }),
      makeThread({
        environmentId: remoteEnvironmentId,
        projectId: sharedProjectId,
        updatedAt: "2026-03-09T10:10:00.000Z",
      }),
    ];

    const sorted = sortScopedProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.title)).toEqual(["Remote project", "Local project"]);
  });

  it("does not use archived threads as project activity", () => {
    const projects = [
      makeProject({
        id: ProjectId.make("project-visible"),
        title: "Visible project",
        updatedAt: "2026-03-09T10:01:00.000Z",
      }),
      makeProject({
        id: ProjectId.make("project-archived"),
        title: "Archived-only project",
        updatedAt: "2026-03-09T10:00:00.000Z",
      }),
    ];
    const threads = [
      makeThread({
        id: ThreadId.make("thread-visible"),
        projectId: ProjectId.make("project-visible"),
        updatedAt: "2026-03-09T10:02:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("thread-archived"),
        projectId: ProjectId.make("project-archived"),
        updatedAt: "2026-03-09T10:10:00.000Z",
        archivedAt: "2026-03-09T10:11:00.000Z",
      }),
    ];

    const sorted = sortScopedProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.title)).toEqual([
      "Visible project",
      "Archived-only project",
    ]);
  });
});

describe("sortSidebarV2ProjectGroups", () => {
  it("does not let a hidden subagent thread reorder projects", () => {
    const olderProjectId = ProjectId.make("project-older");
    const newerProjectId = ProjectId.make("project-newer");
    const olderRootThreadId = ThreadId.make("thread-older-root");
    const projects = [
      {
        ...makeProject({ id: olderProjectId, title: "A older project" }),
        projectKey: "logical-older",
        memberProjectRefs: [{ environmentId: localEnvironmentId, projectId: olderProjectId }],
      },
      {
        ...makeProject({ id: newerProjectId, title: "Z newer project" }),
        projectKey: "logical-newer",
        memberProjectRefs: [{ environmentId: localEnvironmentId, projectId: newerProjectId }],
      },
    ];
    const threads = [
      makeThread({
        id: olderRootThreadId,
        projectId: olderProjectId,
        updatedAt: "2026-03-09T10:01:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("thread-newer-root"),
        projectId: newerProjectId,
        updatedAt: "2026-03-09T10:05:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("thread-hidden-subagent"),
        projectId: olderProjectId,
        updatedAt: "2026-03-09T10:10:00.000Z",
        lineage: {
          rootThreadId: olderRootThreadId,
          parentThreadId: olderRootThreadId,
          relationshipToParent: "subagent",
        },
      }),
    ];

    expect(
      sortSidebarV2ProjectGroups(projects, threads, "updated_at", new Set()).map(
        (project) => project.projectKey,
      ),
    ).toEqual(["logical-newer", "logical-older"]);
  });
});

describe("pinOrderKeyBetween", () => {
  it("stays strictly ordered under repeated top insertion", () => {
    let head: string | null = null;
    const keys: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      const key: string = pinOrderKeyBetween(null, head)!;
      expect(key).not.toBeNull();
      if (head !== null) expect(key < head).toBe(true);
      keys.push(key);
      head = key;
    }
    expect(new Set(keys).size).toBe(100);
  });

  it("stays strictly ordered under repeated middle insertion", () => {
    let low = pinOrderKeyBetween(null, null)!;
    let high = pinOrderKeyBetween(low, null)!;
    for (let i = 0; i < 100; i += 1) {
      const key: string = pinOrderKeyBetween(low, high)!;
      expect(low < key && key < high).toBe(true);
      if (i % 2 === 0) low = key;
      else high = key;
    }
  });

  it("returns null for corrupt or out-of-order bounds instead of throwing", () => {
    expect(pinOrderKeyBetween("z", "a")).toBeNull();
    expect(pinOrderKeyBetween("A!", null)).toBeNull();
    expect(pinOrderKeyBetween(null, "ma")).toBeNull();
    expect(pinOrderKeyBetween("m", "m")).toBeNull();
  });
});

describe("sortPinnedThreadsForSidebar", () => {
  const pinnable = (input: { id: string; createdAt: string; pinOrderKey?: string | null }) => ({
    id: input.id,
    createdAt: input.createdAt,
    pinOrderKey: input.pinOrderKey ?? null,
  });

  it("sorts keyed threads by key ahead of keyless threads in creation order", () => {
    const sorted = sortPinnedThreadsForSidebar([
      pinnable({ id: "keyless-old", createdAt: "2026-03-09T08:00:00.000Z" }),
      pinnable({ id: "second", createdAt: "2026-03-09T09:00:00.000Z", pinOrderKey: "t" }),
      pinnable({ id: "keyless-new", createdAt: "2026-03-09T12:00:00.000Z" }),
      pinnable({ id: "first", createdAt: "2026-03-09T07:00:00.000Z", pinOrderKey: "g" }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual([
      "first",
      "second",
      "keyless-new",
      "keyless-old",
    ]);
  });

  it("breaks equal keys by id so raced writes render identically everywhere", () => {
    const sorted = sortPinnedThreadsForSidebar([
      pinnable({ id: "b", createdAt: "2026-03-09T10:00:00.000Z", pinOrderKey: "m" }),
      pinnable({ id: "a", createdAt: "2026-03-09T11:00:00.000Z", pinOrderKey: "m" }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["a", "b"]);
  });
});

describe("resolveSidebarSweepKeys", () => {
  const ordered = ["a", "b", "c", "d", "blocked"];
  const canSettle = (key: string) => key !== "blocked";

  it("leaves out rows that cannot settle and rows that left the list", () => {
    expect(resolveSidebarSweepKeys(ordered, "c", "blocked", canSettle)).toEqual(["c", "d"]);
    expect(resolveSidebarSweepKeys(ordered, "gone", "a", canSettle)).toEqual([]);
  });
});

describe("navigation after parking a thread", () => {
  it.each([
    ["settle", "settled", null, "thread", true],
    ["settle", "active", null, "thread", false],
    ["settle", "settled", null, "other-thread", false],
    ["snooze", null, "2099-01-01T00:00:00.000Z", "thread", true],
    ["snooze", null, null, "thread", false],
    ["snooze", null, "2026-09-12T09:00:00.000Z", "thread", false],
    ["snooze", null, "2099-01-01T00:00:00.000Z", "thread", false, true],
    ["snooze", null, "2099-01-01T00:00:00.000Z", "other-thread", false],
  ] as const)(
    "%s with state %s / %s on %s navigates: %s",
    (
      action,
      settledOverride,
      snoozedUntil,
      currentThreadKey,
      expected,
      hasPendingApprovals: boolean = false,
    ) => {
      expect(
        shouldNavigateAfterThreadPark({
          threadKey: "thread",
          currentThreadKey,
          action,
          now: "2026-09-12T10:00:00.000Z",
          thread: {
            settledOverride,
            snoozedUntil,
            snoozedAt: null,
            session: null,
            latestTurn: null,
            hasPendingApprovals,
            hasPendingUserInput: false,
          },
        }),
      ).toBe(expected);
    },
  );
});

describe("unseen completion with background work", () => {
  it.each([
    {
      roster: "dev server",
      task: { kind: "command" },
      status: "ready",
      receded: false,
      pill: "Completed",
    },
    {
      roster: "dev server watchdog",
      task: { kind: "monitor" },
      status: "ready",
      receded: false,
      pill: "Completed",
    },
    {
      roster: "awaited command",
      task: { kind: "command", awaited: true },
      status: "waiting",
      receded: true,
      pill: "Waiting",
    },
  ] as const)("presents a completed thread with a $roster roster", (expected) => {
    const thread = presentThreadShell(localEnvironmentId, {
      ...makeThreadFixture().source,
      latestRunId: RunId.make("run-background-completion"),
      status: "completed",
      latestRunCompletedAt: DateTime.makeUnsafe("2026-06-20T01:00:00.000Z"),
      lastVisitedAt: DateTime.makeUnsafe("2026-06-20T00:59:00.000Z"),
      pendingBackgroundTasks: [{ taskId: "background-work", ...expected.task }],
    });
    const status = resolveSidebarThreadStatus(thread);
    const isUnread = hasUnseenCompletion(thread);

    expect(isUnread).toBe(true);
    expect(status).toBe(expected.status);
    expect(
      shouldRecedeSidebarThread({
        status,
        isUnread,
        isWoke: false,
        isActive: false,
        isSelected: false,
      }),
    ).toBe(expected.receded);
    expect(isSidebarThreadWorking(thread)).toBe(expected.receded);
    expect(resolveThreadStatusPill({ thread })).toMatchObject({ label: expected.pill });
  });
});

describe("Working shelf (beta)", () => {
  const runtime = {
    status: "running" as const,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
  };
  const backgroundTask = {
    taskId: "bg-1",
    description: "Watch build",
    kind: "monitor" as const,
    awaited: true as const,
  };
  const idle = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    latestRun: makeLatestRun(),
    runtime: null,
  };
  const waiting = {
    ...idle,
    runtime: { ...runtime, status: "idle" as const },
    pendingBackgroundTasks: [backgroundTask],
  };

  it("folds away running threads and threads waiting on background work only", () => {
    expect(isSidebarThreadWorking({ ...idle, runtime })).toBe(true);
    expect(isSidebarThreadWorking(waiting)).toBe(true);
    expect(isSidebarThreadWorking(idle)).toBe(false);
    expect(isSidebarThreadWorking({ ...idle, runtime, hasPendingApprovals: true })).toBe(false);
    expect(isSidebarThreadWorking({ ...idle, runtime, hasPendingUserInput: true })).toBe(false);
    expect(
      isSidebarThreadWorking({
        ...waiting,
        runtime: { ...runtime, status: "failed" as const, lastError: "boom" },
      }),
    ).toBe(false);
  });

  it("keeps a ready plan in the inbox while background work runs", () => {
    expect(
      isSidebarThreadWorking({
        ...waiting,
        interactionMode: "plan",
        hasActionableProposedPlan: true,
      }),
    ).toBe(false);
  });

  describe("sortInboxThreadsByReturn", () => {
    const thread = (
      id: string,
      input: { createdAt: string; completedAt?: string | null; unsettledAt?: string },
    ) => ({
      id: ThreadId.make(id),
      environmentId: localEnvironmentId,
      createdAt: input.createdAt,
      unsettledAt: input.unsettledAt ?? null,
      latestRun:
        input.completedAt === undefined
          ? null
          : { ...makeLatestRun({ completedAt: input.completedAt }), requestedAt: input.createdAt },
    });

    it("puts the thread that finished last on top, whatever its age", () => {
      const sorted = sortInboxThreadsByReturn([
        thread("new", { createdAt: "2026-03-09T11:00:00.000Z" }),
        thread("old-finished-now", {
          createdAt: "2026-03-01T09:00:00.000Z",
          completedAt: "2026-03-09T12:00:00.000Z",
        }),
        thread("reopened", {
          createdAt: "2026-03-02T09:00:00.000Z",
          unsettledAt: "2026-03-09T11:30:00.000Z",
        }),
      ]);
      expect(sorted.map((entry) => entry.id)).toEqual(["old-finished-now", "reopened", "new"]);
    });

    it("counts a return the server does not stamp, like an approval request", () => {
      const waiting = thread("asks-approval", {
        createdAt: "2026-03-09T09:00:00.000Z",
        completedAt: null,
      });
      const finished = thread("finished", {
        createdAt: "2026-03-09T09:30:00.000Z",
        completedAt: "2026-03-09T11:00:00.000Z",
      });
      expect(sortInboxThreadsByReturn([finished, waiting]).map((entry) => entry.id)).toEqual([
        "finished",
        "asks-approval",
      ]);
      expect(
        sortInboxThreadsByReturn([finished, waiting], (entry) =>
          entry === waiting ? Date.parse("2026-03-09T11:05:00.000Z") : undefined,
        ).map((entry) => entry.id),
      ).toEqual(["asks-approval", "finished"]);
    });
  });

  describe("dragging", () => {
    const marker = (name: SidebarListMarker): SidebarListItem => ({ kind: "marker", marker: name });
    const row = (key: string, section: SidebarSection): SidebarListItem => ({
      kind: "thread",
      key,
      section,
    });
    const items: readonly SidebarListItem[] = [
      marker("pinned-header"),
      row("p1", "pinned"),
      marker("pinned-divider"),
      row("a1", "active"),
      row("a2", "active"),
      marker("working-header"),
      row("w1", "working"),
      marker("settled-header"),
      row("s1", "settled"),
    ];

    it("does not read the Needs you header as a section change", () => {
      const withHeader: readonly SidebarListItem[] = [
        marker("pinned-header"),
        row("p1", "pinned"),
        marker("needs-you-header"),
        marker("pinned-divider"),
        row("a1", "active"),
        row("a2", "active"),
      ];
      expect(
        resolveSidebarDropTarget(withHeader, "p1", sidebarMarkerId("needs-you-header")),
      ).toEqual({ section: "pinned", pinnedOrder: ["p1"], activeOrder: ["a1", "a2"] });
      expect(resolveSidebarDropTarget(withHeader, "a1", "a2")).toEqual({
        section: "active",
        pinnedOrder: ["p1"],
        activeOrder: ["a2", "a1"],
      });
    });

    it("never drops into the Working shelf, and keeps it out of the inbox order", () => {
      expect(resolveSidebarDropTarget(items, "a1", "w1")).toBeNull();
      expect(resolveSidebarDropTarget(items, "p1", "a2")).toEqual({
        section: "active",
        pinnedOrder: [],
        activeOrder: ["a1", "a2", "p1"],
      });
      expect(resolveSidebarDropVerb("active", "working")).toBeNull();
    });

    it.each([
      ["pinned", "p1"],
      ["active", "a2"],
      ["settled", "s1"],
    ] as const)(
      "does not move a Working thread into %s when its reference drag ends in the sidebar",
      (section, overKey) => {
        const target = resolveSidebarDropTarget(items, "w1", overKey);
        expect(target?.section).toBe(section);
        expect(
          planSidebarThreadDrop({
            activeKey: "w1",
            activeSection: "working",
            target: target!,
            pinnedOrder: ["p1"],
            pinnedKeysById: new Map([["p1", "m"]]),
            activeOrder: ["a1", "a2"],
            activeKeysById: new Map([
              ["a1", "f"],
              ["a2", "t"],
            ]),
            activeTimeOrdered: true,
          }),
        ).toEqual({ kind: "none" });
      },
    );

    it("arranges the rows it can write when another row's server cannot store an order", () => {
      const plan = planSidebarThreadDrop({
        activeKey: "a2",
        activeSection: "active",
        target: {
          section: "active",
          pinnedOrder: [],
          activeOrder: ["offline", "a2", "a1"],
        },
        pinnedOrder: [],
        pinnedKeysById: new Map(),
        activeOrder: ["offline", "a1", "a2"],
        activeKeysById: new Map([
          ["offline", null],
          ["a1", null],
          ["a2", null],
        ]),
        activeReorderableKeys: new Set(["a1", "a2"]),
      });
      expect(plan.kind).toBe("move-active");
      if (plan.kind !== "move-active") return;
      expect(plan.assignments.map(({ id }) => id)).toEqual(["a2", "a1"]);
      const [a2, a1] = plan.assignments.map(({ orderKey }) => orderKey);
      expect(a2! < a1!).toBe(true);

      const above = planSidebarThreadDrop({
        activeKey: "a2",
        activeSection: "active",
        target: { section: "active", pinnedOrder: [], activeOrder: ["a2", "offline"] },
        pinnedOrder: [],
        pinnedKeysById: new Map(),
        activeOrder: ["offline", "a2"],
        activeKeysById: new Map([
          ["offline", "m"],
          ["a2", "t"],
        ]),
        activeReorderableKeys: new Set(["a2"]),
      });
      expect(above.kind === "move-active" && above.assignments[0]!.orderKey < "m").toBe(true);
    });

    describe("reordering with cached offline configuration", () => {
      const onlineEnvironmentId = EnvironmentId.make("online");
      const offlineEnvironmentId = EnvironmentId.make("offline");
      const capabilities = {
        repositoryIdentity: true,
        threadPinning: true,
        threadPinReorder: true,
        threadActiveReorder: true,
      };
      const config = (environmentId: EnvironmentId) => ({
        environment: {
          environmentId,
          label: environmentId,
          platform: { os: "linux" as const, arch: "x64" as const },
          serverVersion: "0.1.1",
          capabilities,
        },
      });
      const serverConfigs = new Map([
        [onlineEnvironmentId, config(onlineEnvironmentId)],
        [offlineEnvironmentId, config(offlineEnvironmentId)],
      ]);
      const thread = (
        id: string,
        environmentId = onlineEnvironmentId,
        key: string | null = null,
      ) => ({
        id: ThreadId.make(id),
        environmentId,
        createdAt: `2026-03-09T${id === "offline" ? "12" : id === "online" ? "11" : "10"}:00:00.000Z`,
        activeOrderKey: key,
        pinOrderKey: key,
      });
      const keyOf = (entry: ReturnType<typeof thread>) =>
        scopedThreadKey(scopeThreadRef(entry.environmentId, entry.id));
      const online = thread("online");
      const offline = thread("offline", offlineEnvironmentId);
      const membership = (connectedEnvironmentIds = [onlineEnvironmentId]) =>
        resolveSidebarReorderableThreadKeys({
          threads: [online, offline],
          serverConfigs,
          connectedEnvironmentIds,
        });
      const planDrop = (input: {
        section: "active" | "pinned";
        rows: ReturnType<typeof thread>[];
        moved: ReturnType<typeof thread>;
        order: ReturnType<typeof thread>[];
        from?: "active" | "pinned";
        connectedEnvironmentIds?: EnvironmentId[];
      }) => {
        const writable = resolveSidebarReorderableThreadKeys({
          threads: input.rows,
          serverConfigs,
          connectedEnvironmentIds: input.connectedEnvironmentIds ?? [onlineEnvironmentId],
        });
        const sort = (rows: typeof input.rows) =>
          input.section === "active"
            ? sortActiveThreadsByOrderKey(rows)
            : sortPinnedThreadsByOrderKey(rows);
        const originalOrder = sort(input.rows).map(keyOf);
        const targetOrder = input.order.map(keyOf);
        const keysById = new Map(input.rows.map((entry) => [keyOf(entry), entry.activeOrderKey]));
        const plan = planSidebarThreadDrop({
          activeKey: keyOf(input.moved),
          activeSection: input.from ?? input.section,
          target: { section: input.section, pinnedOrder: targetOrder, activeOrder: targetOrder },
          pinnedOrder: originalOrder,
          activeOrder: originalOrder,
          pinnedKeysById: keysById,
          activeKeysById: keysById,
          reorderableKeys: writable.draggableThreadKeys,
          activeReorderableKeys: writable.activeReorderableThreadKeys,
        });
        const assignments =
          plan.kind === "move-active" || plan.kind === "reorder-pinned"
            ? plan.assignments
            : plan.kind === "pin"
              ? [
                  ...plan.extraAssignments,
                  ...(plan.orderKey === undefined
                    ? []
                    : [{ id: keyOf(input.moved), orderKey: plan.orderKey }]),
                ]
              : [];
        const assignedKeys = new Map(assignments.map(({ id, orderKey }) => [id, orderKey]));
        const actualOrder = sort(
          input.rows.map((entry) => ({
            ...entry,
            activeOrderKey: assignedKeys.get(keyOf(entry)) ?? entry.activeOrderKey,
            pinOrderKey: assignedKeys.get(keyOf(entry)) ?? entry.pinOrderKey,
          })),
        ).map(keyOf);

        return { plan, assignments, actualOrder, targetOrder };
      };

      it("excludes cached capable offline rows from both writable sets", () => {
        const writable = membership();

        expect([...writable.draggableThreadKeys]).toEqual([keyOf(online)]);
        expect([...writable.activeReorderableThreadKeys]).toEqual([keyOf(online)]);
        expect(serverConfigs.has(offlineEnvironmentId)).toBe(true);
      });

      it("updates membership through disconnect, reconnect, and missing configuration", () => {
        expect(membership([]).draggableThreadKeys.size).toBe(0);
        const connected = membership([onlineEnvironmentId, offlineEnvironmentId]);
        expect(connected.draggableThreadKeys.size).toBe(2);
        expect(connected.activeReorderableThreadKeys.size).toBe(2);

        const changed = resolveSidebarReorderableThreadKeys({
          threads: [online, offline],
          connectedEnvironmentIds: [onlineEnvironmentId, offlineEnvironmentId],
          serverConfigs: new Map([[onlineEnvironmentId, config(onlineEnvironmentId)]]),
        });
        expect([...changed.draggableThreadKeys]).toEqual([keyOf(online)]);
        expect([...changed.activeReorderableThreadKeys]).toEqual([keyOf(online)]);
      });

      it.each(["active", "pinned"] as const)(
        "replans a disconnected drag source in %s",
        (section) => {
          const bound = thread("offline", offlineEnvironmentId, "m");
          const moved = thread("online", onlineEnvironmentId, "t");
          const input = { section, rows: [bound, moved], moved, order: [moved, bound] };
          expect(planDrop(input).plan.kind).toBe(
            section === "active" ? "move-active" : "reorder-pinned",
          );

          const disconnected = planDrop({ ...input, connectedEnvironmentIds: [] });

          expect(disconnected.plan).toEqual({ kind: "none" });
          expect(disconnected.assignments).toEqual([]);
        },
      );

      it.each(["active", "pinned"] as const)("preserves a keyed offline bound in %s", (section) => {
        const bound = thread("offline", offlineEnvironmentId, "m");
        const moved = thread("online", onlineEnvironmentId, "t");
        const result = planDrop({ section, rows: [bound, moved], moved, order: [moved, bound] });

        expect(result.plan.kind).toBe(section === "active" ? "move-active" : "reorder-pinned");
        expect(result.assignments.map(({ id }) => id)).toEqual([keyOf(moved)]);
        expect(result.actualOrder).toEqual(result.targetOrder);
      });

      it.each(["active", "pinned"] as const)(
        "rejects rebalancing a keyed offline bound in %s",
        (section) => {
          const bound = thread("offline", offlineEnvironmentId, "m");
          const neighbor = thread("neighbor");
          const result = planDrop({
            section,
            rows: [bound, online, neighbor],
            moved: online,
            order: [bound, neighbor, online],
          });

          expect(result.plan).toEqual({ kind: "none" });
          expect(result.assignments).toEqual([]);
        },
      );

      it.each(["active", "pinned"] as const)(
        "rejects crossing the frozen keyless boundary in %s",
        (section) => {
          const bound = {
            ...offline,
            createdAt:
              section === "active" ? "2026-03-09T12:00:00.000Z" : "2026-03-09T10:00:00.000Z",
          };
          const order = section === "active" ? [online, bound] : [bound, online];
          const result = planDrop({ section, rows: [bound, online], moved: online, order });

          expect(result.plan).toEqual({ kind: "none" });
          expect(result.assignments).toEqual([]);
        },
      );

      it.each(["active", "pinned"] as const)(
        "allows realizable moves beside a frozen keyless row in %s",
        (section) => {
          const neighbor = thread("neighbor");
          const order =
            section === "active" ? [offline, neighbor, online] : [online, neighbor, offline];
          const result = planDrop({
            section,
            rows: [offline, online, neighbor],
            moved: online,
            order,
          });

          expect(result.plan.kind).toBe(section === "active" ? "move-active" : "reorder-pinned");
          expect(result.assignments.length).toBeGreaterThan(0);
          expect(result.assignments.every(({ id }) => id !== keyOf(offline))).toBe(true);
          expect(result.actualOrder).toEqual(result.targetOrder);
        },
      );

      it.each(["active", "pinned"] as const)(
        "checks fallback assignments to other rows at the %s boundary",
        (section) => {
          const neighbor = thread("neighbor");
          const order =
            section === "active" ? [neighbor, offline, online] : [online, offline, neighbor];
          const result = planDrop({
            section,
            rows: [offline, online, neighbor],
            moved: online,
            order,
          });

          expect(result.plan).toEqual({ kind: "none" });
        },
      );

      it.each(["active", "pinned"] as const)(
        "rejects impossible pin/unpin placement across the %s boundary",
        (section) => {
          const order = section === "active" ? [online, offline] : [offline, online];
          const result = planDrop({
            section,
            rows: [offline, online],
            moved: online,
            order,
            from: section === "active" ? "pinned" : "active",
          });

          expect(result.plan).toEqual({ kind: "none" });
        },
      );
    });

    it("only changes lifecycle when the inbox is time-ordered", () => {
      const base = {
        pinnedOrder: ["p1"],
        pinnedKeysById: new Map([["p1", "m"]]),
        activeOrder: ["a1", "a2"],
        activeKeysById: new Map([
          ["a1", "f"],
          ["a2", "t"],
        ]),
        activeTimeOrdered: true,
      };
      expect(
        planSidebarThreadDrop({
          ...base,
          activeKey: "a1",
          activeSection: "active",
          target: { section: "active", pinnedOrder: ["p1"], activeOrder: ["a2", "a1"] },
        }),
      ).toEqual({ kind: "none" });
      expect(
        planSidebarThreadDrop({
          ...base,
          activeKey: "p1",
          activeSection: "pinned",
          target: { section: "active", pinnedOrder: [], activeOrder: ["a1", "p1", "a2"] },
        }),
      ).toEqual({
        kind: "move-active",
        order: null,
        assignments: [],
        unpin: true,
        unsettle: false,
        unsnooze: false,
      });
    });
  });
});

describe("pendingSidebarRouteReveal", () => {
  it("keeps a revealed thread settled across a mount that reads no route params", () => {
    const reveal = { observedKey: null, pendingKey: null };
    expect(pendingSidebarRouteReveal(reveal, "env:a1")).toBe("env:a1");
    completeSidebarRouteReveal(reveal);

    // Back from Settings: location commits before the thread match does.
    expect(pendingSidebarRouteReveal(reveal, null)).toBeNull();
    expect(pendingSidebarRouteReveal(reveal, "env:a1")).toBeNull();

    expect(pendingSidebarRouteReveal(reveal, "env:b1")).toBe("env:b1");
  });

  it("keeps a pending reveal through a render without route params", () => {
    const reveal = { observedKey: null, pendingKey: null };
    pendingSidebarRouteReveal(reveal, "env:a1");
    expect(pendingSidebarRouteReveal(reveal, null)).toBeNull();
    expect(pendingSidebarRouteReveal(reveal, "env:a1")).toBe("env:a1");
  });
});

describe("resolveSidebarRouteReveal", () => {
  const scopedProjectKeys = new Set(["environment-test:project-scoped"]);
  const hidden = makeThreadFixture({ projectId: ProjectId.make("project-other") });
  const hiddenKey = "environment-test:thread-test";
  const findThread = (key: string) => (key === hiddenKey ? hidden : undefined);

  it("widens the scope for a newly opened thread the scope hides", () => {
    expect(
      resolveSidebarRouteReveal({
        reveal: { observedKey: "environment-test:other", pendingKey: null },
        routeKey: hiddenKey,
        routeKeyInPlace: false,
        isSearching: false,
        scopedProjectKeys,
        delegatedUnderParent: new Set(),
        findThread,
      }),
    ).toEqual({ pendingKey: hiddenKey, widensScope: true });
  });

  it("never widens for a thread whose reveal already completed", () => {
    // A remount's once-per-mount scroll must keep the scope the user chose.
    expect(
      resolveSidebarRouteReveal({
        reveal: { observedKey: hiddenKey, pendingKey: null },
        routeKey: hiddenKey,
        routeKeyInPlace: false,
        isSearching: false,
        scopedProjectKeys,
        delegatedUnderParent: new Set(),
        findThread,
      }),
    ).toEqual({ pendingKey: null, widensScope: false });
  });

  it("widens again for a thread reopened before the thread between them listed its row", () => {
    // The user scoped away from the open thread, then went to a thread whose row
    // never mounted, then came back.
    const reveal = { observedKey: hiddenKey, pendingKey: null };
    const resolve = (routeKey: string) =>
      resolveSidebarRouteReveal({
        reveal,
        routeKey,
        routeKeyInPlace: false,
        isSearching: false,
        scopedProjectKeys,
        delegatedUnderParent: new Set(),
        findThread,
      });
    resolve("environment-test:unlisted");
    expect(resolve(hiddenKey)).toEqual({ pendingKey: hiddenKey, widensScope: true });
  });

  it("holds a pending reveal without widening while searching", () => {
    expect(
      resolveSidebarRouteReveal({
        reveal: { observedKey: hiddenKey, pendingKey: hiddenKey },
        routeKey: hiddenKey,
        routeKeyInPlace: false,
        isSearching: true,
        scopedProjectKeys,
        delegatedUnderParent: new Set(),
        findThread,
      }),
    ).toEqual({ pendingKey: hiddenKey, widensScope: false });
  });
});

describe("sidebarFolderExpansionKeys", () => {
  it("honors a collapse the legacy sidebar saved under a member's cwd", () => {
    const keys = sidebarFolderExpansionKeys({
      projectKey: "github.com/pingdotgg/t3code",
      memberProjects: [{ physicalProjectKey: "local:/code/t3code", workspaceRoot: "/code/t3code" }],
    });
    const cwdKey = keys.at(-1)!;

    expect(resolveProjectExpanded({}, keys)).toBe(true);
    expect(resolveProjectExpanded({ [cwdKey]: false }, keys)).toBe(false);
    expect(resolveProjectExpanded({ [keys[0]!]: true, [cwdKey]: false }, keys)).toBe(true);
  });
});

describe("groupSidebarThreadsByProject", () => {
  it("puts each thread in its project's folder and drops empty projects unless kept", () => {
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const t3code = ProjectId.make("t3code");
    const t3codeRemote = ProjectId.make("t3code-remote");
    const fleet = ProjectId.make("fleet");
    const thread = (id: string, environmentId: EnvironmentId, projectId: ProjectId) => ({
      id,
      environmentId,
      projectId,
    });
    const groups = [
      {
        projectKey: "t3code",
        memberProjectRefs: [
          { environmentId: localEnvironmentId, projectId: t3code },
          { environmentId: remoteEnvironmentId, projectId: t3codeRemote },
        ],
      },
      {
        projectKey: "fleet",
        memberProjectRefs: [{ environmentId: localEnvironmentId, projectId: fleet }],
      },
      {
        projectKey: "notes",
        memberProjectRefs: [
          { environmentId: localEnvironmentId, projectId: ProjectId.make("notes") },
        ],
      },
    ];

    const threads = [
      thread("a", localEnvironmentId, t3code),
      thread("orphan", localEnvironmentId, ProjectId.make("deleted")),
      thread("b", remoteEnvironmentId, t3codeRemote),
    ];
    const summarize = (keepEmpty: (group: (typeof groups)[number]) => boolean) =>
      groupSidebarThreadsByProject(groups, threads, keepEmpty).map((folder) => ({
        projectKey: folder.group.projectKey,
        threads: folder.threads.map((entry) => entry.id),
      }));

    expect(summarize(() => true)).toEqual([
      { projectKey: "t3code", threads: ["a", "b"] },
      { projectKey: "fleet", threads: [] },
      { projectKey: "notes", threads: [] },
    ]);
    expect(summarize(() => false)).toEqual([{ projectKey: "t3code", threads: ["a", "b"] }]);
    // A pinned project keeps its empty folder while other empty projects drop out.
    expect(summarize((group) => group.projectKey === "fleet")).toEqual([
      { projectKey: "t3code", threads: ["a", "b"] },
      { projectKey: "fleet", threads: [] },
    ]);
  });
});

const appProject = ProjectId.make("acme-app");

function lineageThread(
  id: string,
  parent: string | null,
  options: {
    readonly relationship?: "fork" | "subagent" | null;
    readonly sideChat?: boolean;
    readonly createdAt?: string;
    readonly projectId?: ProjectId;
    readonly environmentId?: EnvironmentId;
  } = {},
) {
  return {
    environmentId: options.environmentId ?? localEnvironmentId,
    id: ThreadId.make(id),
    projectId: options.projectId ?? appProject,
    createdAt: options.createdAt ?? "2026-01-01T00:00:00.000Z",
    lineage: {
      rootThreadId: ThreadId.make(parent ?? id),
      parentThreadId: parent === null ? null : ThreadId.make(parent),
      relationshipToParent: options.relationship ?? null,
      ...(options.sideChat === undefined ? {} : { sideChat: options.sideChat }),
    },
  };
}

const lineageKey = (id: string, environmentId = localEnvironmentId) =>
  scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));

describe("nestSpawnedThreads", () => {
  const summarize = (threads: ReadonlyArray<ReturnType<typeof lineageThread>>) => {
    const nesting = nestSpawnedThreads(threads);
    return {
      nested: [...nesting.nestedKeys].toSorted(),
      hidden: [...nesting.hiddenKeys].toSorted(),
      children: Object.fromEntries(
        [...nesting.childrenByAnchorKey].map(([anchor, rows]) => [
          anchor,
          rows.map((row) => row.id),
        ]),
      ),
    };
  };

  it("nests a spawned child under its listed parent and maps it to that parent", () => {
    const nesting = nestSpawnedThreads([
      lineageThread("alpha", null),
      lineageThread("alpha-child", "alpha"),
    ]);

    expect([...nesting.nestedKeys]).toEqual([lineageKey("alpha-child")]);
    expect(nesting.hiddenKeys.size).toBe(0);
    expect(nesting.childrenByAnchorKey.get(lineageKey("alpha"))?.map((row) => row.id)).toEqual([
      "alpha-child",
    ]);
    expect(nesting.anchorKeyOf(lineageKey("alpha-child"))).toBe(lineageKey("alpha"));
    expect(nesting.anchorKeyOf(lineageKey("alpha"))).toBe(lineageKey("alpha"));
    expect(nesting.anchorKeyOf(lineageKey("unlisted"))).toBe(lineageKey("unlisted"));
  });

  it("flattens a grandchild under the top-most listed ancestor, which counts both", () => {
    const nesting = nestSpawnedThreads([
      lineageThread("grandchild", "child", { createdAt: "2026-01-03T00:00:00.000Z" }),
      lineageThread("child", "root", { createdAt: "2026-01-02T00:00:00.000Z" }),
      lineageThread("root", null),
    ]);

    expect(nesting.childrenByAnchorKey.get(lineageKey("root"))?.map((row) => row.id)).toEqual([
      "child",
      "grandchild",
    ]);
    expect(nesting.childrenByAnchorKey.has(lineageKey("child"))).toBe(false);
    expect(nesting.anchorKeyOf(lineageKey("grandchild"))).toBe(lineageKey("root"));
    expect(nesting.anchorKeyOf(lineageKey("child"))).toBe(lineageKey("root"));
    expect(nesting.hiddenKeys.size).toBe(0);
  });

  it("anchors on the nearest listed ancestor that is not itself spawned", () => {
    expect(
      summarize([
        lineageThread("root", null),
        lineageThread("fork", "root", { relationship: "fork" }),
        lineageThread("spawned", "fork"),
      ]),
    ).toEqual({
      nested: [lineageKey("spawned")],
      hidden: [],
      children: { [lineageKey("fork")]: ["spawned"] },
    });
  });

  it("hides a child while any ancestor is unlisted and nests it again once it returns", () => {
    const root = lineageThread("root", null);
    const child = lineageThread("child", "root");
    const grandchild = lineageThread("grandchild", "child");

    expect(summarize([child, grandchild])).toEqual({
      nested: [],
      hidden: [lineageKey("child"), lineageKey("grandchild")].toSorted(),
      children: {},
    });
    expect(summarize([root, grandchild])).toEqual({
      nested: [],
      hidden: [lineageKey("grandchild")],
      children: {},
    });
    expect(summarize([root, child, grandchild])).toEqual({
      nested: [lineageKey("child"), lineageKey("grandchild")].toSorted(),
      hidden: [],
      children: { [lineageKey("root")]: ["child", "grandchild"] },
    });
  });

  it("nests a child whose project differs from its parent's", () => {
    expect(
      summarize([
        lineageThread("root", null),
        lineageThread("child", "root", { projectId: ProjectId.make("acme-api") }),
      ]).children,
    ).toEqual({ [lineageKey("root")]: ["child"] });
  });

  it("looks for the parent only in the child's own environment", () => {
    const remote = EnvironmentId.make("environment-remote");
    expect(
      summarize([
        lineageThread("root", null),
        lineageThread("child", "root", { environmentId: remote }),
      ]),
    ).toEqual({ nested: [], hidden: [lineageKey("child", remote)], children: {} });
  });

  it("never nests or hides a fork, subagent, side chat or parentless thread", () => {
    const others = [
      lineageThread("fork", "root", { relationship: "fork" }),
      lineageThread("subagent", "root", { relationship: "subagent" }),
      lineageThread("side-chat", "root", { sideChat: true }),
      lineageThread("orphan-fork", "missing", { relationship: "fork" }),
    ];
    for (const threads of [[lineageThread("root", null), ...others], others]) {
      expect(summarize(threads)).toEqual({ nested: [], hidden: [], children: {} });
    }
  });

  it("orders an anchor's children by creation time, then id", () => {
    expect(
      summarize([
        lineageThread("late", "root", { createdAt: "2026-01-05T00:00:00.000Z" }),
        lineageThread("tie-b", "root", { createdAt: "2026-01-03T00:00:00.000Z" }),
        lineageThread("early", "root", { createdAt: "2026-01-02T00:00:00.000Z" }),
        lineageThread("tie-a", "root", { createdAt: "2026-01-03T00:00:00.000Z" }),
        lineageThread("root", null),
      ]).children,
    ).toEqual({ [lineageKey("root")]: ["early", "tie-a", "tie-b", "late"] });
  });

  it("hides threads caught in a lineage cycle instead of looping", () => {
    expect(
      summarize([
        lineageThread("root", null),
        lineageThread("cycle-a", "cycle-b"),
        lineageThread("cycle-b", "cycle-a"),
        lineageThread("self", "self"),
        lineageThread("child", "root"),
      ]),
    ).toEqual({
      nested: [lineageKey("child")],
      hidden: [lineageKey("cycle-a"), lineageKey("cycle-b"), lineageKey("self")].toSorted(),
      children: { [lineageKey("root")]: ["child"] },
    });
  });

  it("returns the same empty nesting when nothing is spawned", () => {
    const empty = nestSpawnedThreads([]);
    const unspawned = nestSpawnedThreads([
      lineageThread("root", null),
      lineageThread("fork", "root", { relationship: "fork" }),
    ]);

    expect(empty.nestedKeys.size).toBe(0);
    expect(empty.hiddenKeys.size).toBe(0);
    expect(empty.childrenByAnchorKey.size).toBe(0);
    expect(empty.anchorKeyOf(lineageKey("root"))).toBe(lineageKey("root"));
    expect(unspawned.nestedKeys).toBe(empty.nestedKeys);
    expect(unspawned.hiddenKeys).toBe(empty.hiddenKeys);
    expect(unspawned.childrenByAnchorKey).toBe(empty.childrenByAnchorKey);
  });

  it("drops nested and hidden children from a list and keeps the list itself when none are in it", () => {
    const root = lineageThread("root", null);
    const fork = lineageThread("fork", "root", { relationship: "fork" });
    const child = lineageThread("child", "root");
    const orphan = lineageThread("orphan", "missing");
    const nesting = nestSpawnedThreads([root, fork, child, orphan]);

    expect(
      withoutSpawnedThreads([child, root, orphan, fork], nesting).map((row) => row.id),
    ).toEqual(["root", "fork"]);
    const untouched = [root, fork];
    expect(withoutSpawnedThreads(untouched, nesting)).toBe(untouched);
    expect(withoutSpawnedThreads([child, orphan], nesting)).toEqual([]);
    const unnested = [child, orphan];
    expect(withoutSpawnedThreads(unnested, nestSpawnedThreads([root]))).toBe(unnested);
  });

  it("shows every child while expanded and only the open one while collapsed", () => {
    const children = [lineageThread("first", "root"), lineageThread("second", "root")];
    const ids = (rows: ReadonlyArray<{ readonly id: string }>) => rows.map((row) => row.id);

    expect(ids(visibleSpawnedChildren(children, true, null))).toEqual(["first", "second"]);
    expect(ids(visibleSpawnedChildren(children, true, lineageKey("second")))).toEqual([
      "first",
      "second",
    ]);
    expect(ids(visibleSpawnedChildren(children, false, lineageKey("second")))).toEqual(["second"]);
    expect(ids(visibleSpawnedChildren(children, false, lineageKey("root")))).toEqual([]);
    expect(ids(visibleSpawnedChildren(children, false, null))).toEqual([]);
    expect(
      ids(
        visibleSpawnedChildren(children, false, lineageKey("second", EnvironmentId.make("other"))),
      ),
    ).toEqual([]);
  });
});

describe("groupSidebarFolders", () => {
  const apiProject = ProjectId.make("acme-api");
  const docsProject = ProjectId.make("acme-docs");
  const folderGroup = (projectKey: string, projectId: ProjectId) => ({
    projectKey,
    memberProjectRefs: [{ environmentId: localEnvironmentId, projectId }],
  });
  const groups = [
    folderGroup("app", appProject),
    folderGroup("api", apiProject),
    folderGroup("docs", docsProject),
  ];
  const initiative = (slug: string, members: ReadonlyArray<ReturnType<typeof lineageThread>>) => ({
    slug,
    members: members.map((thread) => ({ thread })),
  });
  const noThreads: ReadonlyArray<ReturnType<typeof lineageThread>> = [];
  const summarize = (result: {
    readonly folders: ReadonlyArray<{
      readonly group: { readonly projectKey: string };
      readonly threads: ReadonlyArray<{ readonly id: string }>;
      readonly initiatives: ReadonlyArray<{ readonly slug: string }>;
    }>;
    readonly unplacedInitiatives: ReadonlyArray<{ readonly slug: string }>;
  }) => ({
    folders: result.folders.map((folder) => ({
      projectKey: folder.group.projectKey,
      threads: folder.threads.map((thread) => thread.id),
      initiatives: folder.initiatives.map((entry) => entry.slug),
    })),
    unplaced: result.unplacedInitiatives.map((entry) => entry.slug),
  });

  it("places each initiative in its first member's project folder, keeping initiative-only folders", () => {
    const result = groupSidebarFolders({
      groups,
      threads: [lineageThread("app-thread", null)],
      initiatives: [
        initiative("checkout-retries", [
          lineageThread("orchestrator", null, { projectId: apiProject }),
          lineageThread("part", null, { projectId: appProject }),
        ]),
        initiative("billing", [lineageThread("billing-part", null, { projectId: appProject })]),
      ],
      keepEmpty: () => false,
    });

    expect(summarize(result)).toEqual({
      folders: [
        { projectKey: "app", threads: ["app-thread"], initiatives: ["billing"] },
        { projectKey: "api", threads: [], initiatives: ["checkout-retries"] },
      ],
      unplaced: [],
    });
  });

  it("returns an initiative whose project has no folder, or that has no members, as unplaced", () => {
    const result = groupSidebarFolders({
      groups,
      threads: noThreads,
      initiatives: [
        initiative("elsewhere", [
          lineageThread("outside", null, { projectId: ProjectId.make("deleted") }),
          lineageThread("inside", null, { projectId: appProject }),
        ]),
        initiative("empty", []),
      ],
      keepEmpty: (group) => group.projectKey === "docs",
    });

    expect(summarize(result)).toEqual({
      folders: [{ projectKey: "docs", threads: [], initiatives: [] }],
      unplaced: ["elsewhere", "empty"],
    });
  });

  it("gives no folder to a project whose only threads are nested spawned children", () => {
    const threads = [
      lineageThread("root", null),
      lineageThread("api-child", "root", { projectId: apiProject }),
      lineageThread("docs-orphan", "missing", { projectId: docsProject }),
    ];
    const nesting = nestSpawnedThreads(threads);
    const listed = threads.filter((thread) => {
      const key = lineageKey(thread.id);
      return !nesting.nestedKeys.has(key) && !nesting.hiddenKeys.has(key);
    });

    expect(
      summarize(
        groupSidebarFolders({ groups, threads: listed, initiatives: [], keepEmpty: () => false }),
      ),
    ).toEqual({
      folders: [{ projectKey: "app", threads: ["root"], initiatives: [] }],
      unplaced: [],
    });
  });
});

describe("partitionInitiativeThreads", () => {
  const remoteEnvironmentId = EnvironmentId.make("environment-remote");
  const thread = (id: string, environmentId = localEnvironmentId) => ({
    environmentId,
    id: ThreadId.make(id),
  });
  const group = (key: string, threadIds: string[], environmentId = localEnvironmentId) => ({
    key,
    environmentId,
    threadIds: threadIds.map((id) => ThreadId.make(id)),
  });
  const keyOf = (id: string, environmentId = localEnvironmentId) =>
    scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));
  const sections = (lists: Partial<Record<SidebarSection, string[]>>) => ({
    pinned: (lists.pinned ?? []).map((id) => thread(id)),
    active: (lists.active ?? []).map((id) => thread(id)),
    working: (lists.working ?? []).map((id) => thread(id)),
    snoozed: (lists.snoozed ?? []).map((id) => thread(id)),
    settled: (lists.settled ?? []).map((id) => thread(id)),
  });
  const ids = (list: ReadonlyArray<{ readonly id: string }>) => list.map((entry) => entry.id);
  const expanded = { routeThreadKey: null, collapsedKeys: {} };

  it("moves listed inbox, Working and Settled chats into the group in the group's order", () => {
    const input = sections({
      active: ["inbox", "orchestrator"],
      working: ["part-b", "busy"],
      settled: ["part-a", "old"],
    });
    const { groups, remaining } = partitionInitiativeThreads(
      input,
      [group("local:nov18", ["orchestrator", "part-a", "part-b", "not-in-sidebar"])],
      expanded,
    );

    expect(
      groups.map((entry) => ({
        key: entry.group.key,
        threads: entry.threads.map(({ thread, section }) => `${thread.id}:${section}`),
        hiddenCount: entry.hiddenCount,
      })),
    ).toEqual([
      {
        key: "local:nov18",
        threads: ["orchestrator:active", "part-a:settled", "part-b:working"],
        hiddenCount: 0,
      },
    ]);
    expect(ids(remaining.active)).toEqual(["inbox"]);
    expect(ids(remaining.working)).toEqual(["busy"]);
    expect(ids(remaining.settled)).toEqual(["old"]);
  });

  it("leaves pinned and snoozed chats where the user put them", () => {
    const input = sections({ pinned: ["pinned"], snoozed: ["snoozed"], active: ["listed"] });
    const { groups, remaining } = partitionInitiativeThreads(
      input,
      [group("local:nov18", ["pinned", "snoozed", "listed"])],
      expanded,
    );

    expect(groups.map((entry) => entry.threads.map(({ thread }) => thread.id))).toEqual([
      ["listed"],
    ]);
    expect(ids(remaining.pinned)).toEqual(["pinned"]);
    expect(ids(remaining.snoozed)).toEqual(["snoozed"]);
    expect(remaining.active).toEqual([]);
  });

  it("drops a group whose listed chats are all pinned, snoozed or missing", () => {
    const { groups, remaining } = partitionInitiativeThreads(
      sections({ pinned: ["pinned"], snoozed: ["snoozed"], active: ["inbox"] }),
      [group("local:quiet", ["pinned", "snoozed", "gone"]), group("local:empty", [])],
      expanded,
    );

    expect(groups).toEqual([]);
    expect(ids(remaining.active)).toEqual(["inbox"]);
  });

  it("returns every chat to its section when no initiative lists it", () => {
    const input = sections({ active: ["a"], working: ["w"], settled: ["s"] });

    for (const liveGroups of [[], [group("local:other", ["elsewhere"])]]) {
      const { groups, remaining } = partitionInitiativeThreads(input, liveGroups, expanded);
      expect(groups).toEqual([]);
      expect(remaining).toEqual(input);
    }
  });

  it("puts a chat two initiatives list only in the first", () => {
    const { groups } = partitionInitiativeThreads(
      sections({ active: ["shared", "own"] }),
      [group("local:first", ["shared"]), group("local:second", ["shared", "own"])],
      expanded,
    );

    expect(
      groups.map((entry) => [entry.group.key, entry.threads.map(({ thread }) => thread.id)]),
    ).toEqual([
      ["local:first", ["shared"]],
      ["local:second", ["own"]],
    ]);
  });

  it("matches chats by environment when two environments run the same slug", () => {
    const input = {
      ...sections({}),
      active: [thread("t1"), thread("t1", remoteEnvironmentId), thread("t2", remoteEnvironmentId)],
    };
    const { groups, remaining } = partitionInitiativeThreads(
      input,
      [
        group(`${localEnvironmentId}:nov18`, ["t1"]),
        group(`${remoteEnvironmentId}:nov18`, ["t1"], remoteEnvironmentId),
      ],
      expanded,
    );

    expect(
      groups.map((entry) => [
        entry.group.key,
        entry.threads.map(({ thread }) => `${thread.environmentId}/${thread.id}`),
      ]),
    ).toEqual([
      [`${localEnvironmentId}:nov18`, [`${localEnvironmentId}/t1`]],
      [`${remoteEnvironmentId}:nov18`, [`${remoteEnvironmentId}/t1`]],
    ]);
    expect(remaining.active).toEqual([thread("t2", remoteEnvironmentId)]);
  });

  it("keeps only the open chat of a collapsed group and counts the rest as hidden", () => {
    const input = sections({ active: ["a", "b"], settled: ["c"] });
    const liveGroups = [group("local:nov18", ["a", "b", "c"]), group("local:other", ["x"])];
    const collapsedKeys = { "local:nov18": true } as const;
    const summarize = (routeThreadKey: string | null, collapsed: Record<string, true>) =>
      partitionInitiativeThreads(input, liveGroups, {
        routeThreadKey,
        collapsedKeys: collapsed,
      }).groups.map((entry) => ({
        threads: entry.threads.map(({ thread }) => thread.id),
        members: entry.members.map(({ thread }) => thread.id),
        hiddenCount: entry.hiddenCount,
      }));

    expect(summarize(keyOf("c"), collapsedKeys)).toEqual([
      { threads: ["c"], members: ["a", "b", "c"], hiddenCount: 2 },
    ]);
    expect(summarize(keyOf("elsewhere"), collapsedKeys)).toEqual([
      { threads: [], members: ["a", "b", "c"], hiddenCount: 3 },
    ]);
    expect(summarize(null, collapsedKeys)).toEqual([
      { threads: [], members: ["a", "b", "c"], hiddenCount: 3 },
    ]);
    expect(summarize(keyOf("c"), { "local:other": true })).toEqual([
      { threads: ["a", "b", "c"], members: ["a", "b", "c"], hiddenCount: 0 },
    ]);
  });
});

describe("skipFixedSortableItems", () => {
  const marker = (name: SidebarListMarker): SidebarListItem => ({ kind: "marker", marker: name });
  const row = (key: string, section: SidebarSection): SidebarListItem => ({
    kind: "thread",
    key,
    section,
  });
  const items: readonly SidebarListItem[] = [
    marker("pinned-header"),
    row("p1", "pinned"),
    row("p2", "pinned"),
    marker("pinned-divider"),
    row("a1", "active"),
    row("a2", "active"),
    marker("settled-header"),
    row("s1", "settled"),
  ];
  const heights = [0, 82, 82, 0, 82, 82, 32, 36];
  // A group header, one card row and an end row sit after the pinned rows.
  const blockHeights = [32, 82, 36];
  const blockAt = 3;
  const rectsFor = (list: readonly number[]) => {
    let top = 100;
    return list.map((height) => {
      const rect = { top, bottom: top + height, height, left: 0, right: 260, width: 260 };
      top += height + 1;
      return rect;
    });
  };
  const strategy = () =>
    createSidebarSortingStrategy({ items, settledOrder: ["s1"], settledExpanded: true });
  const withoutBlock = (activeIndex: number, overIndex: number, index: number) => {
    const rects = rectsFor(heights);
    return strategy()({
      rects,
      activeNodeRect: rects[activeIndex]!,
      activeIndex,
      overIndex,
      index,
    });
  };
  const withBlock = (activeIndex: number, overIndex: number, index: number) => {
    const rects = rectsFor([
      ...heights.slice(0, blockAt),
      ...blockHeights,
      ...heights.slice(blockAt),
    ]);
    const outer = (inner: number) => (inner < blockAt ? inner : inner + blockHeights.length);
    const fixed = new Set(blockHeights.map((_, offset) => blockAt + offset));
    return skipFixedSortableItems(
      strategy(),
      fixed,
    )({
      rects,
      activeNodeRect: rects[outer(activeIndex)]!,
      activeIndex: outer(activeIndex),
      overIndex: outer(overIndex),
      index: outer(index),
    });
  };

  it.each([
    ["p1 over a2", 1, 5],
    ["a2 over p1", 5, 1],
    ["a1 over s1", 4, 7],
  ])("moves every row as it would without the block when dragging %s", (_, active, over) => {
    expect([...items.keys()].some((index) => withoutBlock(active, over, index)?.y !== 0)).toBe(
      true,
    );
    for (const index of items.keys()) {
      expect(withBlock(active, over, index), `row ${index}`).toEqual(
        withoutBlock(active, over, index),
      );
    }
  });

  it("holds the block still and treats hovering it as hovering nothing", () => {
    const rects = rectsFor([
      ...heights.slice(0, blockAt),
      ...blockHeights,
      ...heights.slice(blockAt),
    ]);
    const fixed = new Set([3, 4, 5]);
    const wrapped = skipFixedSortableItems(strategy(), fixed);
    for (const index of fixed) {
      expect(
        wrapped({ rects, activeNodeRect: rects[1]!, activeIndex: 1, overIndex: 8, index }),
      ).toBeNull();
    }
    for (const index of items.keys()) {
      const outer = index < blockAt ? index : index + blockHeights.length;
      expect(
        wrapped({ rects, activeNodeRect: rects[1]!, activeIndex: 1, overIndex: 4, index: outer }),
      ).toEqual(withoutBlock(1, 1, index));
    }
  });
});

describe("resolveSidebarGroupStatus", () => {
  const runtime = {
    status: "running" as const,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
  };
  let nextId = 0;
  const statusThread = (overrides: Record<string, unknown> = {}) => ({
    environmentId: localEnvironmentId,
    id: ThreadId.make(`status-${nextId++}`),
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    latestRun: makeLatestRun(),
    lastVisitedAt: "2026-03-09T10:06:00.000Z",
    runtime: null as typeof runtime | null,
    ...overrides,
  });
  const idle = () => statusThread();
  const working = () => statusThread({ runtime });
  const preparing = () => statusThread({ runtime: { ...runtime, status: "preparing" as const } });
  const failed = () => statusThread({ runtime: { ...runtime, status: "failed" as const } });
  const limited = () =>
    statusThread({
      runtime: { ...runtime, status: "failed" as const, lastErrorClass: "usage_limit" as const },
    });
  const noDecisions: ReadonlySet<string> = new Set();

  it.each([
    ["approval", () => statusThread({ hasPendingApprovals: true })],
    ["input", () => statusThread({ hasPendingUserInput: true })],
    ["guest request", () => statusThread({ pendingGuestMessageCount: 1 })],
    ["usage limit", limited],
  ])("counts a thread waiting on %s as needing you ahead of everything else", (_, needy) => {
    expect(resolveSidebarGroupStatus([failed(), working(), needy(), idle()], noDecisions)).toEqual({
      kind: "needs-you",
      count: 1,
    });
  });

  it("counts an open decision as needing you, by the thread's own key", () => {
    const decided = working();
    const other = working();
    expect(
      resolveSidebarGroupStatus(
        [decided, other],
        new Set([scopedThreadKey(scopeThreadRef(decided.environmentId, decided.id))]),
      ),
    ).toEqual({ kind: "needs-you", count: 1 });
    expect(
      resolveSidebarGroupStatus([decided, other], new Set([lineageKey("not-in-group")])),
    ).toEqual({ kind: "working", count: 2 });
  });

  it("counts every thread at the winning step", () => {
    expect(
      resolveSidebarGroupStatus(
        [
          statusThread({ hasPendingApprovals: true }),
          limited(),
          statusThread({ hasPendingUserInput: true }),
          failed(),
        ],
        noDecisions,
      ),
    ).toEqual({ kind: "needs-you", count: 3 });
    expect(resolveSidebarGroupStatus([failed(), working(), failed(), idle()], noDecisions)).toEqual(
      {
        kind: "failed",
        count: 2,
      },
    );
    expect(resolveSidebarGroupStatus([working(), idle(), preparing()], noDecisions)).toEqual({
      kind: "working",
      count: 2,
    });
    expect(resolveSidebarGroupStatus([failed()], noDecisions)).toEqual({
      kind: "failed",
      count: 1,
    });
    expect(resolveSidebarGroupStatus([preparing()], noDecisions)).toEqual({
      kind: "working",
      count: 1,
    });
  });

  describe("with the spawned sessions nested under its threads", () => {
    const withLineage = (id: string, parent: string | null, overrides = {}) => ({
      ...lineageThread(id, parent),
      ...statusThread({ id: ThreadId.make(id), ...overrides }),
    });

    it.each([
      ["needs approval", { hasPendingApprovals: true }, { kind: "needs-you", count: 1 }],
      [
        "failed",
        { runtime: { ...runtime, status: "failed" as const } },
        { kind: "failed", count: 1 },
      ],
      ["working", { runtime }, { kind: "working", count: 1 }],
    ])("a quiet parent's session that is %s decides the group", (_, childState, expected) => {
      const parent = withLineage("quiet-parent", null);
      const child = withLineage("quiet-child", "quiet-parent", childState);
      const aside = withLineage("quiet-aside", "elsewhere", { hasPendingApprovals: true });
      const nesting = nestSpawnedThreads([parent, child, aside]);
      const held = [parent];

      expect(resolveSidebarGroupStatus(held, noDecisions)).toEqual({ kind: "idle" });
      expect(spawnedChildrenOf(held, nesting).map((row) => row.id)).toEqual(["quiet-child"]);
      expect(
        resolveSidebarGroupStatus([...held, ...spawnedChildrenOf(held, nesting)], noDecisions),
      ).toEqual(expected);
    });

    it("lets the strongest state win across a thread and its sessions, and adds nothing without sessions", () => {
      const parent = withLineage("busy-parent", null, { runtime });
      const failedChild = withLineage("busy-failed", "busy-parent", {
        runtime: { ...runtime, status: "failed" as const },
      });
      const needyChild = withLineage("busy-needy", "busy-parent", { hasPendingUserInput: true });
      const nesting = nestSpawnedThreads([parent, failedChild, needyChild]);

      expect(
        resolveSidebarGroupStatus([parent, ...spawnedChildrenOf([parent], nesting)], noDecisions),
      ).toEqual({ kind: "needs-you", count: 1 });
      expect(spawnedChildrenOf([withLineage("lone", null)], nesting)).toEqual([]);
      expect(spawnedChildrenOf([parent], nestSpawnedThreads([parent]))).toEqual([]);
    });
  });

  it("reports idle for an empty, idle, waiting or opened-failure group", () => {
    const openedFailure = statusThread({
      runtime: { ...runtime, status: "failed" as const },
      latestRun: { ...makeLatestRun(), status: "failed" as const },
    });
    const waiting = statusThread({ runtime: { ...runtime, status: "idle" as const } });
    expect(resolveSidebarGroupStatus([], noDecisions)).toEqual({ kind: "idle" });
    expect(resolveSidebarGroupStatus([idle(), waiting, openedFailure], noDecisions)).toEqual({
      kind: "idle",
    });
  });

  describe("isSidebarThreadNeedingYou", () => {
    it.each([
      ["approval", () => statusThread({ hasPendingApprovals: true })],
      ["input", () => statusThread({ hasPendingUserInput: true })],
      ["guest request", () => statusThread({ pendingGuestMessageCount: 1 })],
      ["usage limit", limited],
    ])("is true for a thread waiting on %s", (_, needy) => {
      expect(isSidebarThreadNeedingYou(needy(), noDecisions)).toBe(true);
    });

    it.each([
      ["idle", idle],
      ["working", working],
      ["preparing", preparing],
      ["failed", failed],
    ])("is false for a %s thread", (_, quiet) => {
      expect(isSidebarThreadNeedingYou(quiet(), noDecisions)).toBe(false);
    });

    it("is true for an open decision only under the thread's own key", () => {
      const decided = working();
      expect(
        isSidebarThreadNeedingYou(
          decided,
          new Set([scopedThreadKey(scopeThreadRef(decided.environmentId, decided.id))]),
        ),
      ).toBe(true);
      expect(isSidebarThreadNeedingYou(decided, new Set([lineageKey("not-in-group")]))).toBe(false);
    });
  });

  describe("with a selected needs-you thread drawn in the Needs you section", () => {
    it("still reports needs-you for the folder's full list, and not for what is left", () => {
      const needy = statusThread({ hasPendingApprovals: true });
      const quiet = idle();
      const busy = working();
      const sections = {
        pinned: [],
        active: [needy, quiet],
        working: [busy],
        snoozed: [],
        settled: [],
      };
      const { threads } = selectNeedsYouThreads(sections, (thread) =>
        isSidebarThreadNeedingYou(thread, noDecisions),
      );

      expect(threads).toEqual([needy]);
      expect(resolveSidebarGroupStatus([needy, quiet, busy], noDecisions)).toEqual({
        kind: "needs-you",
        count: 1,
      });
      expect(resolveSidebarGroupStatus([quiet, busy], noDecisions)).toEqual({
        kind: "working",
        count: 1,
      });
    });
  });
});

describe("selectNeedsYouThreads", () => {
  const remoteEnvironmentId = EnvironmentId.make("environment-remote");
  const thread = (id: string, environmentId = localEnvironmentId) => ({
    environmentId,
    id: ThreadId.make(id),
  });
  const keyOf = (id: string, environmentId = localEnvironmentId) =>
    scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));
  const lists = (input: Partial<Record<SidebarSection, ReturnType<typeof thread>[]>>) => ({
    pinned: input.pinned ?? [],
    active: input.active ?? [],
    working: input.working ?? [],
    snoozed: input.snoozed ?? [],
    settled: input.settled ?? [],
  });
  const always = () => true;

  it("takes active, then working, then settled, each in its own order", () => {
    const result = selectNeedsYouThreads(
      lists({
        settled: [thread("s1"), thread("s2")],
        working: [thread("w1"), thread("w2")],
        active: [thread("a1"), thread("a2")],
      }),
      always,
    );

    expect(result.threads.map((entry) => entry.id)).toEqual(["a1", "a2", "w1", "w2", "s1", "s2"]);
    expect([...result.keys]).toEqual(["a1", "a2", "w1", "w2", "s1", "s2"].map((id) => keyOf(id)));
  });

  it("takes only the threads the predicate accepts", () => {
    const result = selectNeedsYouThreads(
      lists({ active: [thread("a1"), thread("a2")], settled: [thread("s1")] }),
      (entry) => entry.id === "a2" || entry.id === "s1",
    );

    expect(result.threads.map((entry) => entry.id)).toEqual(["a2", "s1"]);
    expect(result.keys).toEqual(new Set([keyOf("a2"), keyOf("s1")]));
  });

  it("selects a thread once when it is listed in two sections", () => {
    const shared = thread("shared");
    const result = selectNeedsYouThreads(
      lists({ active: [shared], working: [shared], settled: [shared] }),
      always,
    );

    expect(result.threads).toEqual([shared]);
    expect(result.keys).toEqual(new Set([keyOf("shared")]));
  });

  it("tells apart the same thread id in two environments", () => {
    const result = selectNeedsYouThreads(
      lists({
        active: [thread("same")],
        working: [thread("same", remoteEnvironmentId)],
      }),
      always,
    );

    expect(result.threads.map((entry) => entry.environmentId)).toEqual([
      localEnvironmentId,
      remoteEnvironmentId,
    ]);
    expect(result.keys).toEqual(new Set([keyOf("same"), keyOf("same", remoteEnvironmentId)]));
  });

  it("never takes a pinned or snoozed thread, even one the predicate accepts", () => {
    const result = selectNeedsYouThreads(
      lists({ pinned: [thread("pinned")], snoozed: [thread("snoozed")], active: [thread("a1")] }),
      always,
    );

    expect(result.threads.map((entry) => entry.id)).toEqual(["a1"]);
    expect(result.keys).toEqual(new Set([keyOf("a1")]));
  });

  it("selects nothing from empty lists", () => {
    const result = selectNeedsYouThreads(lists({}), always);

    expect(result.threads).toEqual([]);
    expect(result.keys.size).toBe(0);
  });
});

describe("placeListInitiatives", () => {
  const remoteEnvironmentId = EnvironmentId.make("environment-remote");
  const thread = (id: string, environmentId = localEnvironmentId) => ({
    environmentId,
    id: ThreadId.make(id),
  });
  const keyOf = (id: string, environmentId = localEnvironmentId) =>
    scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));
  const initiative = (name: string, members: ReturnType<typeof thread>[]) => ({
    name,
    members: members.map((member) => ({ thread: member })),
  });
  const describeEntries = (
    entries: ReadonlyArray<ListInboxEntry<{ id: string }, { name: string }>>,
  ) => entries.map((entry) => (entry.kind === "thread" ? entry.thread.id : entry.group.name));
  const noHidden: ReadonlySet<string> = new Set();

  it("puts a folder where its freshest inbox member stood, between the right neighbours", () => {
    const first = thread("first");
    const mid = thread("mid");
    const last = thread("last");
    const partA = thread("part-a");
    const partB = thread("part-b");
    const billing = initiative("Billing revamp", [partA, partB]);

    const entries = placeListInitiatives({
      inboxOrder: [first, mid, partA, last, partB],
      remaining: [first, mid, last],
      groups: [billing],
      hiddenKeys: noHidden,
    });

    expect(describeEntries(entries)).toEqual(["first", "mid", "Billing revamp", "last"]);
    expect(entries[2]).toEqual({ kind: "initiative", group: billing });
  });

  it("places each folder at its own freshest member, whatever the order of the groups", () => {
    const early = thread("early");
    const late = thread("late");
    const plain = thread("plain");
    const lateGroup = initiative("checkout-retries", [late]);
    const earlyGroup = initiative("Billing revamp", [early]);

    const entries = placeListInitiatives({
      inboxOrder: [early, plain, late],
      remaining: [plain],
      groups: [lateGroup, earlyGroup],
      hiddenKeys: noHidden,
    });

    expect(describeEntries(entries)).toEqual(["Billing revamp", "plain", "checkout-retries"]);
  });

  it("puts a folder with no inbox member after the last inbox row, in group order", () => {
    const one = thread("one");
    const two = thread("two");
    const settledOnly = thread("settled-only");
    const otherSettled = thread("other-settled");

    const entries = placeListInitiatives({
      inboxOrder: [one, two],
      remaining: [one, two],
      groups: [
        initiative("Billing revamp", [settledOnly]),
        initiative("checkout-retries", [otherSettled]),
      ],
      hiddenKeys: noHidden,
    });

    expect(describeEntries(entries)).toEqual(["one", "two", "Billing revamp", "checkout-retries"]);
  });

  it("never emits a hidden thread as a row", () => {
    const needy = thread("needy");
    const quiet = thread("quiet");

    const entries = placeListInitiatives({
      inboxOrder: [needy, quiet],
      remaining: [needy, quiet],
      groups: [],
      hiddenKeys: new Set([keyOf("needy")]),
    });

    expect(describeEntries(entries)).toEqual(["quiet"]);
  });

  it("still places a folder at a hidden member's slot", () => {
    const needy = thread("needy");
    const before = thread("before");
    const after = thread("after");

    const entries = placeListInitiatives({
      inboxOrder: [before, needy, after],
      remaining: [before, after],
      groups: [initiative("Billing revamp", [needy])],
      hiddenKeys: new Set([keyOf("needy")]),
    });

    expect(describeEntries(entries)).toEqual(["before", "Billing revamp", "after"]);
  });

  it("reads a member by environment as well as id", () => {
    const local = thread("same");
    const remote = thread("same", remoteEnvironmentId);

    const entries = placeListInitiatives({
      inboxOrder: [local, remote],
      remaining: [local],
      groups: [initiative("Billing revamp", [remote])],
      hiddenKeys: noHidden,
    });

    expect(entries.map((entry) => entry.kind)).toEqual(["thread", "initiative"]);
  });

  it("returns exactly the inbox order when there is no folder and nothing hidden", () => {
    const rows = [thread("c"), thread("a"), thread("b")];

    const entries = placeListInitiatives({
      inboxOrder: rows,
      remaining: rows,
      groups: [],
      hiddenKeys: noHidden,
    });

    expect(entries).toEqual(rows.map((row) => ({ kind: "thread", thread: row })));
  });

  it("returns nothing for an empty inbox with no folder", () => {
    expect(
      placeListInitiatives({ inboxOrder: [], remaining: [], groups: [], hiddenKeys: noHidden }),
    ).toEqual([]);
  });
});

describe("sidebarListItemsKey", () => {
  const standalone = (key: string) => ({
    kind: "thread" as const,
    key,
    section: "active" as const,
  });
  const member = (key: string) => ({
    kind: "initiative-row" as const,
    key,
    section: "active" as const,
    groupKey: "group-a",
  });

  it("differs when the same thread moves between a standalone row and an initiative row", () => {
    const standaloneB = [member("a"), standalone("b")];
    const memberB = [member("a"), member("b")];
    expect(sidebarListItemsKey(standaloneB)).not.toBe(sidebarListItemsKey(memberB));
  });

  it("matches for identical lists", () => {
    expect(sidebarListItemsKey([member("a"), standalone("b")])).toBe(
      sidebarListItemsKey([member("a"), standalone("b")]),
    );
  });
});

describe("shouldCreateNewThreadInCurrentProject", () => {
  it("opens the picker when several projects are open, or only archived ones exist", () => {
    expect(shouldCreateNewThreadInCurrentProject(false, 2, 3)).toBe(false);
    expect(shouldCreateNewThreadInCurrentProject(false, 0, 2)).toBe(false);
    expect(shouldCreateNewThreadInCurrentProject(false, 1, 3)).toBe(true);
    expect(shouldCreateNewThreadInCurrentProject(false, 0, 0)).toBe(true);
    expect(shouldCreateNewThreadInCurrentProject(true, 2, 2)).toBe(true);
  });
});

describe("resolveInboxShelf", () => {
  it("keeps a working chat with an open decision in the inbox", () => {
    const base = { workingShelfEnabled: true, working: true, hasOpenDecision: false };
    expect(resolveInboxShelf(base)).toBe("working");
    expect(resolveInboxShelf({ ...base, hasOpenDecision: true })).toBe("active");
    expect(resolveInboxShelf({ ...base, working: false })).toBe("active");
    expect(resolveInboxShelf({ ...base, workingShelfEnabled: false })).toBe("active");
  });
});
