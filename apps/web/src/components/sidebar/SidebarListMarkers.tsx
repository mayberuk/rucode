import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useNavigate } from "@tanstack/react-router";
import { LayoutDashboardIcon } from "lucide-react";
import { type ReactNode, useLayoutEffect } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { cn } from "~/lib/utils";
import { useAnyThreadHasOpenDecision } from "../../pluginCards/live/liveAtoms";
import { animateSidebarLayoutChanges, sidebarMarkerId } from "../Sidebar.logic";
import { FOLDER_DOT_CLASS_NAME, FOLDER_DOT_LABEL } from "./SidebarProjectFolderHeader";
import { SIDEBAR_SORTABLE_DRAG_DISABLED } from "./SidebarThreadRow";

function SortableSidebarMarker(props: {
  sortableId: string;
  placeholder?: boolean;
  className?: string;
  children?: ReactNode;
  revealOverflow?: boolean;
  "data-testid"?: string;
}) {
  const { node, setNodeRef, transform, transition } = useSortable({
    id: props.sortableId,
    disabled: SIDEBAR_SORTABLE_DRAG_DISABLED,
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the projected drop box inside the scroll viewport as drag transforms move it
  useLayoutEffect(() => {
    if (props.revealOverflow && transform?.y !== undefined) {
      node.current?.firstElementChild?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [node, props.revealOverflow, transform?.y]);
  return (
    <li
      ref={setNodeRef}
      data-thread-selection-safe
      data-testid={props["data-testid"]}
      className={cn("list-none", props.className)}
      style={{
        transform: CSS.Translate.toString(transform),
        transition: props.placeholder ? "none" : transition,
        visibility: transform?.scaleY === 0 ? "hidden" : undefined,
      }}
    >
      {props.children}
    </li>
  );
}

export function SidebarSectionPlaceholder(props: {
  marker: "active-placeholder" | "settled-placeholder";
  label: string;
  showHint: boolean;
  isDropTarget: boolean;
}) {
  return (
    <SortableSidebarMarker
      sortableId={sidebarMarkerId(props.marker)}
      placeholder
      data-testid={`sidebar-${props.marker}`}
      className="relative mx-0.5 -mb-px h-0"
      // Revealing on every drag scrolls the list out from under the pointer.
      revealOverflow={
        props.marker === "settled-placeholder" && props.showHint && props.isDropTarget
      }
    >
      {props.showHint ? (
        <div
          className={cn(
            "absolute inset-x-0 top-0 flex h-9 items-center justify-center rounded-md border border-dashed border-sidebar-foreground/25 text-xs text-sidebar-foreground/80",
            props.isDropTarget && "border-primary/40 bg-primary/5 text-primary",
          )}
        >
          {props.label}
        </div>
      ) : null}
    </SortableSidebarMarker>
  );
}

export function SidebarDragBoundary(props: {
  marker: "pinned-header" | "pinned-divider";
  label: string;
  visible: boolean;
  isDropTarget: boolean;
}) {
  return (
    <SortableSidebarMarker
      sortableId={sidebarMarkerId(props.marker)}
      data-testid={`sidebar-${props.marker}`}
      className="pointer-events-none relative mx-0.5 -mb-px h-0"
    >
      {props.visible ? (
        <div className="sidebar-drag-boundary-label absolute inset-x-2 top-1 flex h-4 items-center gap-2">
          <span
            className={cn(
              "shrink-0 text-xs font-medium",
              props.isDropTarget ? "text-primary" : "text-sidebar-foreground/80",
            )}
          >
            {props.label}
          </span>
          <span
            aria-hidden
            className={cn(
              "h-px flex-1",
              props.isDropTarget ? "bg-primary/50" : "bg-sidebar-foreground/25",
            )}
          />
        </div>
      ) : null}
    </SortableSidebarMarker>
  );
}

export function SidebarSectionHeader(props: {
  marker: "working-header" | "snoozed-header" | "settled-header";
  label: string;
  /** A muted trailing count. */
  count: number;
  className?: string;
  dragging?: boolean;
  isDropTarget?: boolean;
  toggle: { expanded: boolean; onToggle: () => void };
}) {
  const shelf =
    props.marker === "working-header"
      ? "working"
      : props.marker === "snoozed-header"
        ? "snoozed"
        : "settled";
  return (
    <SortableSidebarMarker
      sortableId={sidebarMarkerId(props.marker)}
      data-testid={`sidebar-${props.marker}`}
      className={cn("relative mx-0.5 h-8", props.className)}
    >
      <CollapsibleSectionHeader
        data-sidebar-row={`shelf:${shelf}`}
        onClick={props.toggle.onToggle}
        expanded={props.toggle.expanded}
        tone={props.isDropTarget ? "accent" : props.dragging ? "emphasized" : "muted"}
        data-testid={`sidebar-${shelf}-shelf-toggle`}
        accessory={<span className="font-normal tabular-nums">{props.count}</span>}
      >
        {props.label}
      </CollapsibleSectionHeader>
    </SortableSidebarMarker>
  );
}

export function initiativeGroupHeaderId(groupKey: string): string {
  return `sidebar-initiative-header:${groupKey}`;
}

export function initiativeGroupEndId(groupKey: string): string {
  return `sidebar-initiative-end:${groupKey}`;
}

export function initiativeGroupRowId(groupKey: string): string {
  return `initiative:${groupKey}`;
}

export function InitiativeGroupHeader(props: {
  groupKey: string;
  label: string;
  count: number;
  expanded: boolean;
  hiddenThreads: ReadonlyArray<ScopedThreadRef>;
  onToggle: (groupKey: string) => void;
}) {
  const openDecision = useAnyThreadHasOpenDecision(props.expanded ? [] : props.hiddenThreads);
  return (
    <SortableSidebarMarker
      sortableId={initiativeGroupHeaderId(props.groupKey)}
      data-testid="sidebar-initiative-header"
      className="relative mx-0.5 h-8"
    >
      <CollapsibleSectionHeader
        data-sidebar-row={initiativeGroupRowId(props.groupKey)}
        onClick={() => props.onToggle(props.groupKey)}
        expanded={props.expanded}
        accessory={
          <span className="flex items-center gap-1.5">
            {openDecision ? (
              <span
                className={cn("size-1.5 shrink-0 rounded-full", FOLDER_DOT_CLASS_NAME.attention)}
              >
                <span className="sr-only">{FOLDER_DOT_LABEL.attention}</span>
              </span>
            ) : null}
            <span className="font-normal tabular-nums">{props.count}</span>
          </span>
        }
      >
        {props.label}
      </CollapsibleSectionHeader>
    </SortableSidebarMarker>
  );
}

export function InitiativeGroupEnd(props: {
  groupKey: string;
  label: string;
  hiddenCount: number;
}) {
  const navigate = useNavigate();
  return (
    <SortableSidebarMarker sortableId={initiativeGroupEndId(props.groupKey)} className="pb-2">
      <button
        type="button"
        data-sidebar-row={`${initiativeGroupRowId(props.groupKey)}:end`}
        data-sidebar-parent={initiativeGroupRowId(props.groupKey)}
        onClick={() => void navigate({ to: "/board" })}
        className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
      >
        <LayoutDashboardIcon aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 truncate">
          {props.hiddenCount > 0 ? `Show ${props.hiddenCount} more · ${props.label}` : props.label}
        </span>
      </button>
    </SortableSidebarMarker>
  );
}
