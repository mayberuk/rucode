import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { type ReactNode, useLayoutEffect } from "react";
import { cn } from "~/lib/utils";
import {
  animateSidebarLayoutChanges,
  sidebarMarkerId,
  type SidebarGroupStatus,
} from "../Sidebar.logic";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarGroupStatusText, useSidebarGroupStatusLabel } from "./SidebarGroupStatusText";
import { SIDEBAR_SORTABLE_DRAG_DISABLED } from "./SidebarThreadRow";

export function SortableSidebarMarker(props: {
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
  /** The group's project; the header shows it only outside its project folder. */
  project: { readonly favicon: ProjectFaviconProject | null; readonly displayName: string } | null;
  showProject: boolean;
  /** The tree row of the project folder this header sits in. */
  folderRow?: string | undefined;
  /** Set while collapsed. */
  status: SidebarGroupStatus | null;
  onToggle: (groupKey: string) => void;
}) {
  const statusLabel = useSidebarGroupStatusLabel(
    props.status?.kind === "idle" ? null : props.status,
    null,
  );
  const title =
    props.project === null ? props.label : `${props.project.displayName} · ${props.label}`;
  return (
    <SortableSidebarMarker
      sortableId={initiativeGroupHeaderId(props.groupKey)}
      data-testid="sidebar-initiative-header"
      className="relative mx-0.5 h-8"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <CollapsibleSectionHeader
              data-sidebar-row={initiativeGroupRowId(props.groupKey)}
              data-sidebar-parent={props.folderRow}
              aria-label={statusLabel === null ? title : `${title}, ${statusLabel}`}
              onClick={() => props.onToggle(props.groupKey)}
              expanded={props.expanded}
              accessory={
                props.status !== null && statusLabel !== null ? (
                  <SidebarGroupStatusText status={props.status} label={statusLabel} />
                ) : (
                  <span className="font-normal tabular-nums">{props.count}</span>
                )
              }
            />
          }
        >
          {props.showProject && props.project !== null ? (
            <span className="flex min-w-0 items-center gap-1.5">
              {props.project.favicon === null ? null : (
                <ProjectFavicon project={props.project.favicon} className="size-4 shrink-0" />
              )}
              <span className="max-w-1/2 shrink-0 truncate font-normal text-secondary-label">
                {props.project.displayName}
              </span>
              <span aria-hidden className="shrink-0 font-normal text-secondary-label">
                ·
              </span>
              <span className="min-w-0 truncate">{props.label}</span>
            </span>
          ) : (
            props.label
          )}
        </TooltipTrigger>
        <TooltipPopup>{title}</TooltipPopup>
      </Tooltip>
    </SortableSidebarMarker>
  );
}
