import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
} from "@t3tools/client-runtime/state/thread-sort";

import { hasUnseenCompletion, resolveThreadLastVisitedAt } from "../components/Sidebar.logic";

export interface WaitingContext {
  readonly localLastVisitedAt: string | undefined;
}

export type WaitingSource = (thread: EnvironmentThreadShell, context: WaitingContext) => boolean;

const hasPendingApproval: WaitingSource = (thread) =>
  thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval";

const hasPendingQuestion: WaitingSource = (thread) =>
  thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input";

// Shares the sidebar's rule so the jump and the "Completed" label agree.
const hasUnseenFinishedTurn: WaitingSource = (thread, context) =>
  hasUnseenCompletion({
    ...thread,
    lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, context.localLastVisitedAt),
  });

export const WAITING_SOURCES: ReadonlyArray<WaitingSource> = [
  hasPendingApproval,
  hasPendingQuestion,
  hasUnseenFinishedTurn,
];

export function isThreadWaiting(
  thread: EnvironmentThreadShell,
  context: WaitingContext,
  sources: ReadonlyArray<WaitingSource> = WAITING_SOURCES,
): boolean {
  return sources.some((source) => source(thread, context));
}

/** Pinned threads first, then the rest, each in sidebar order; archived threads are left out. */
export function orderJumpCandidates(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  const open = threads.filter((thread) => thread.archivedAt === null);
  return [
    ...sortPinnedThreadsByOrderKey(open.filter((thread) => thread.pinnedAt != null)),
    ...sortActiveThreadsByOrderKey(open.filter((thread) => thread.pinnedAt == null)),
  ];
}

export function threadShellKey(thread: EnvironmentThreadShell): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

/** The first waiting thread after the current one, wrapping; never the current thread. */
export function nextWaitingThread(
  ordered: ReadonlyArray<EnvironmentThreadShell>,
  isWaiting: (thread: EnvironmentThreadShell) => boolean,
  currentThreadKey: string | null,
): EnvironmentThreadShell | null {
  const currentIndex =
    currentThreadKey === null
      ? -1
      : ordered.findIndex((thread) => threadShellKey(thread) === currentThreadKey);
  const others = currentIndex === -1 ? ordered.length : ordered.length - 1;
  for (let step = 1; step <= others; step += 1) {
    const candidate = ordered[(currentIndex + step) % ordered.length];
    if (candidate !== undefined && isWaiting(candidate)) return candidate;
  }
  return null;
}
