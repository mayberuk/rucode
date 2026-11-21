import { EnvironmentId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import {
  WAITING_SOURCES,
  type WaitingSource,
  isThreadWaiting,
  nextWaitingThread,
  orderJumpCandidates,
  threadShellKey,
} from "./waitingThreads";

const COMPLETED_AT = "2026-03-01T12:00:00.000Z";
const BEFORE_COMPLETION = "2026-03-01T11:00:00.000Z";
const AFTER_COMPLETION = "2026-03-01T13:00:00.000Z";

type ShellOverrides = Omit<Partial<EnvironmentThreadShell>, "id"> & { readonly id: string };

function shell({ id, ...overrides }: ShellOverrides): EnvironmentThreadShell {
  return {
    environmentId: EnvironmentId.make("env"),
    id: ThreadId.make(id),
    projectId: ProjectId.make("project"),
    createdAt: "2026-01-01T00:00:00.000Z",
    unsettledAt: null,
    latestRun: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    archivedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    ...overrides,
  } as EnvironmentThreadShell;
}

function finishedRun(status: "completed" | "interrupted" | "cancelled" | "failed") {
  return {
    runId: RunId.make("run"),
    status,
    requestedAt: null,
    startedAt: null,
    completedAt: COMPLETED_AT,
    assistantMessageId: null,
  };
}

const NO_LOCAL = { localLastVisitedAt: undefined };

describe("isThreadWaiting", () => {
  it.each([
    { name: "a pending approval", thread: { hasPendingApprovals: true } },
    { name: "a pending subagent approval", thread: { pendingSubagentRequest: "approval" } },
    { name: "a pending question", thread: { hasPendingUserInput: true } },
    { name: "a pending subagent question", thread: { pendingSubagentRequest: "user_input" } },
    {
      name: "a finished turn newer than the server visit",
      thread: { latestRun: finishedRun("completed"), lastVisitedAt: BEFORE_COMPLETION },
    },
    {
      name: "a failed turn newer than the server visit",
      thread: { latestRun: finishedRun("failed"), lastVisitedAt: BEFORE_COMPLETION },
    },
  ] as const)("is waiting on $name", ({ thread }) => {
    expect(isThreadWaiting(shell({ id: "t", ...thread }), NO_LOCAL)).toBe(true);
  });

  it.each([
    { name: "nothing pending and no run", thread: {}, local: undefined },
    {
      name: "a finished turn older than the server visit",
      thread: { latestRun: finishedRun("completed"), lastVisitedAt: AFTER_COMPLETION },
      local: undefined,
    },
    {
      name: "a finished turn visited at the same instant",
      thread: { latestRun: finishedRun("completed"), lastVisitedAt: COMPLETED_AT },
      local: undefined,
    },
    {
      name: "an interrupted run",
      thread: { latestRun: finishedRun("interrupted"), lastVisitedAt: BEFORE_COMPLETION },
      local: undefined,
    },
    {
      name: "a cancelled run",
      thread: { latestRun: finishedRun("cancelled"), lastVisitedAt: BEFORE_COMPLETION },
      local: undefined,
    },
    {
      name: "a completion in a thread never visited",
      thread: { latestRun: finishedRun("completed") },
      local: undefined,
    },
    {
      name: "a local visit newer than the completion when the server field is absent",
      thread: { latestRun: finishedRun("completed") },
      local: AFTER_COMPLETION,
    },
    {
      name: "a server visit of null, which wins over an older local visit",
      thread: { latestRun: finishedRun("completed"), lastVisitedAt: null },
      local: BEFORE_COMPLETION,
    },
  ] as const)("is not waiting on $name", ({ thread, local }) => {
    expect(isThreadWaiting(shell({ id: "t", ...thread }), { localLastVisitedAt: local })).toBe(
      false,
    );
  });

  it("uses an older local visit when the server field is absent", () => {
    const thread = shell({ id: "t", latestRun: finishedRun("completed") });
    expect(isThreadWaiting(thread, { localLastVisitedAt: BEFORE_COMPLETION })).toBe(true);
  });

  it("counts a thread matched by a source added to the list", () => {
    const idle = shell({ id: "t" });
    const seen: Array<{ id: string; local: string | undefined }> = [];
    const extra: WaitingSource = (thread, context) => {
      seen.push({ id: thread.id, local: context.localLastVisitedAt });
      return thread.id === "t";
    };

    expect(isThreadWaiting(idle, NO_LOCAL)).toBe(false);
    expect(isThreadWaiting(idle, { localLastVisitedAt: "x" }, [...WAITING_SOURCES, extra])).toBe(
      true,
    );
    expect(seen).toEqual([{ id: "t", local: "x" }]);
    expect(isThreadWaiting(shell({ id: "other" }), NO_LOCAL, [...WAITING_SOURCES, extra])).toBe(
      false,
    );
  });
});

describe("orderJumpCandidates", () => {
  it("lists pinned threads first by pin order, then the rest newest first, without archived ones", () => {
    const ordered = orderJumpCandidates([
      shell({ id: "old", createdAt: "2026-01-01T00:00:00.000Z" }),
      shell({ id: "pin-b", pinnedAt: "2026-02-01T00:00:00.000Z", pinOrderKey: "b" }),
      shell({ id: "new", createdAt: "2026-02-01T00:00:00.000Z" }),
      shell({ id: "gone", createdAt: "2026-03-01T00:00:00.000Z", archivedAt: "2026-03-02" }),
      shell({ id: "pin-a", pinnedAt: "2026-02-02T00:00:00.000Z", pinOrderKey: "a" }),
      shell({
        id: "pin-gone",
        pinnedAt: "2026-02-03T00:00:00.000Z",
        pinOrderKey: "0",
        archivedAt: "2026-03-02",
      }),
    ]);

    expect(ordered.map((thread) => thread.id)).toEqual(["pin-a", "pin-b", "new", "old"]);
  });

  it("returns nothing for no threads", () => {
    expect(orderJumpCandidates([])).toEqual([]);
  });
});

describe("nextWaitingThread", () => {
  const a = shell({ id: "a" });
  const b = shell({ id: "b" });
  const c = shell({ id: "c" });
  const d = shell({ id: "d" });
  const ordered = [a, b, c, d];
  const waitingIds =
    (...ids: string[]) =>
    (thread: EnvironmentThreadShell) =>
      ids.includes(thread.id);

  it("picks the first waiting thread strictly after the current one", () => {
    expect(nextWaitingThread(ordered, waitingIds("a", "c", "d"), threadShellKey(a))).toBe(c);
  });

  it("skips non-waiting threads between the current one and the next waiting one", () => {
    expect(nextWaitingThread(ordered, waitingIds("d"), threadShellKey(a))).toBe(d);
  });

  it("wraps to the start after the last thread", () => {
    expect(nextWaitingThread(ordered, waitingIds("a", "b"), threadShellKey(d))).toBe(a);
  });

  it("wraps past the end when only earlier threads wait", () => {
    expect(nextWaitingThread(ordered, waitingIds("b"), threadShellKey(c))).toBe(b);
  });

  it("visits each waiting thread in turn rather than returning to the same one", () => {
    const waiting = waitingIds("a", "c", "d");
    const visited: string[] = [];
    let current: string | null = threadShellKey(a);
    for (let press = 0; press < 4; press += 1) {
      const next = nextWaitingThread(ordered, waiting, current);
      visited.push(next?.id ?? "none");
      current = next === null ? null : threadShellKey(next);
    }
    expect(visited).toEqual(["c", "d", "a", "c"]);
  });

  it("starts at the first waiting thread when the current one is not in the list", () => {
    expect(nextWaitingThread(ordered, waitingIds("b", "c"), "env:elsewhere")).toBe(b);
    expect(nextWaitingThread(ordered, waitingIds("b", "c"), null)).toBe(b);
  });

  it("never returns the current thread, even when it is the only one waiting", () => {
    expect(nextWaitingThread(ordered, waitingIds("b"), threadShellKey(b))).toBeNull();
  });

  it("returns null when nothing waits or there are no threads", () => {
    expect(nextWaitingThread(ordered, waitingIds(), threadShellKey(a))).toBeNull();
    expect(nextWaitingThread([], waitingIds("a"), null)).toBeNull();
    expect(nextWaitingThread([], waitingIds("a"), threadShellKey(a))).toBeNull();
  });

  it("returns the lone other thread when two threads exist and the other waits", () => {
    expect(nextWaitingThread([a, b], waitingIds("a", "b"), threadShellKey(b))).toBe(a);
  });
});
