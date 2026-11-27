import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { resolveThreadActivityTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ContextMenuSource, ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { CheckIcon } from "lucide-react";
import {
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { cn } from "~/lib/utils";
import { contextMenuSourceOf } from "../../contextMenuSource";
import { useThreadHasOpenDecision } from "../../pluginCards/live/liveAtoms";
import { useThreadShell } from "../../state/entities";
import { textDirection } from "~/textDirection";
import { useUiStateStore } from "../../uiStateStore";
import {
  hasUnseenCompletion,
  resolveSidebarRowStatus,
  resolveThreadLastVisitedAt,
} from "../Sidebar.logic";
import { SortableSidebarMarker } from "./SidebarListMarkers";
import {
  JUMP_HINT_SLOT_CLASS_NAME,
  JumpHintBadge,
  RelativeTimeLabel,
  resolveSidebarTopStatus,
  SidebarProviderStack,
  TopStatusIcon,
  type SidebarProviderEntry,
} from "./SidebarThreadRow";

export function spawnedChildItemId(threadKey: string): string {
  return `spawned:${threadKey}`;
}

/** A session another thread spawned, drawn under that thread's row. */
export const SidebarSpawnedChildRow = memo(function SidebarSpawnedChildRow(props: {
  thread: EnvironmentThreadShell;
  anchorKey: string;
  anchorTitle: string;
  inFolder: boolean;
  isActive: boolean;
  jumpLabel: string | null;
  settleSupported: boolean;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
  revealRef?: ((row: HTMLElement, threadKey: string) => (() => void) | undefined) | undefined;
  onThreadClick: (event: ReactMouseEvent, threadRef: ScopedThreadRef) => void;
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
  onContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
  onSettle: (threadRef: ScopedThreadRef) => void;
}) {
  const gt = useGT();
  const threadRef = scopeThreadRef(props.thread.environmentId, props.thread.id);
  const threadKey = scopedThreadKey(threadRef);
  // The list arranges rows from quiet shells; the live shell re-renders only this row.
  const thread = useThreadShell(threadRef) ?? props.thread;
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const openDecision = useThreadHasOpenDecision(thread.environmentId, thread.id);
  const status = resolveSidebarRowStatus({ ...thread, lastVisitedAt }, { openDecision });
  const topStatus = resolveSidebarTopStatus({
    status,
    goalActive: thread.goal?.status === "active",
    isWoke: false,
    isUnread: hasUnseenCompletion({ ...thread, lastVisitedAt }),
  });
  const { revealRef } = props;
  const rowRef = (row: HTMLElement | null) =>
    row === null ? undefined : revealRef?.(row, threadKey);
  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    props.onThreadActivate(threadRef);
  };
  const handleContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    props.onContextMenu(
      threadRef,
      { x: event.clientX, y: event.clientY },
      contextMenuSourceOf(event),
    );
  };
  const handleSettleClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    props.onSettle(threadRef);
  };
  return (
    <SortableSidebarMarker sortableId={spawnedChildItemId(threadKey)}>
      <div
        ref={rowRef}
        role="button"
        tabIndex={0}
        data-sidebar-row={threadKey}
        data-sidebar-parent={props.anchorKey}
        data-testid="sidebar-row-spawned"
        aria-label={gt("{title}, session started by {parent}", {
          title: thread.title,
          parent: props.anchorTitle,
        })}
        aria-current={props.isActive ? "page" : undefined}
        className={cn(
          "group/sidebar-row relative flex h-9 w-full cursor-pointer items-center gap-2.5 overflow-hidden rounded-md pe-2.5 text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.inFolder ? "ps-14" : "ps-9",
          props.isActive
            ? "bg-sidebar-row-active text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
            : "text-sidebar-foreground hover:bg-sidebar-row-hover",
        )}
        onClick={(event) => props.onThreadClick(event, threadRef)}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
      >
        <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
          <SidebarProviderStack
            thread={thread}
            providerEntryByInstanceId={props.providerEntryByInstanceId}
          />
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-start text-sm",
            props.isActive
              ? "text-foreground"
              : "text-secondary-label group-hover/sidebar-row:text-foreground group-focus-visible/sidebar-row:text-foreground",
          )}
          dir={textDirection(thread.title)}
        >
          {thread.title}
        </span>
        <span
          className={cn(
            "relative ml-auto flex h-6 min-w-8 shrink-0 items-center justify-end",
            props.jumpLabel && JUMP_HINT_SLOT_CLASS_NAME,
          )}
        >
          <span
            className={cn(
              "inline-flex justify-end text-xs tabular-nums text-secondary-label",
              props.settleSupported &&
                "transition-opacity duration-150 ease-out group-any-hover/sidebar-row:opacity-0 group-focus-visible/sidebar-row:opacity-0 group-has-[:focus-visible]/sidebar-row:opacity-0 motion-reduce:transition-none",
            )}
          >
            {topStatus === null ? (
              <RelativeTimeLabel timestamp={resolveThreadActivityTimestamp(thread)} />
            ) : (
              <span
                className={cn("inline-flex items-center gap-1 font-medium", topStatus.className)}
              >
                <TopStatusIcon icon={topStatus.icon} className="size-3" />
                {topStatus.label}
              </span>
            )}
          </span>
          {props.settleSupported ? (
            <button
              type="button"
              aria-label={gt("Settle session")}
              onClick={handleSettleClick}
              onPointerDown={(event) => event.stopPropagation()}
              className="pointer-events-none absolute inset-y-0 right-0 -mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity duration-150 ease-out hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100 group-focus-visible/sidebar-row:pointer-events-auto group-focus-visible/sidebar-row:opacity-100 motion-reduce:transition-none"
            >
              <CheckIcon aria-hidden className="size-3.5" />
              {gt("Settle")}
            </button>
          ) : null}
          {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
        </span>
      </div>
    </SortableSidebarMarker>
  );
});
