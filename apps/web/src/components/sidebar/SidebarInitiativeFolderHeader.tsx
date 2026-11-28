import type { ContextMenuSource, EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { ChevronDownIcon, LayoutDashboardIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { contextMenuSourceOf } from "../../contextMenuSource";
import { useLiveInitiative } from "../../pluginCards/live/liveAtoms";
import { initiativeProgress } from "../../pluginCards/live/liveStateIndex";
import type { SidebarGroupStatus } from "../Sidebar.logic";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarGroupStatusText, useSidebarGroupStatusLabel } from "./SidebarGroupStatusText";
import {
  initiativeGroupHeaderId,
  initiativeGroupRowId,
  SortableSidebarMarker,
} from "./SidebarListMarkers";

export interface SidebarInitiativeRef {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly slug: string;
  readonly label: string;
}

function useInitiativeWaveText(environmentId: EnvironmentId, slug: string) {
  const gt = useGT();
  const live = useLiveInitiative(environmentId, slug);
  const progress = live === null ? null : initiativeProgress(live);
  const wave =
    progress === null
      ? gt("Open the board")
      : progress.wave.total === 0
        ? gt("No waves yet")
        : gt("Wave {current} of {total}", {
            current: progress.wave.current,
            total: progress.wave.total,
          });
  const merged =
    progress === null || progress.parts.total === 0
      ? null
      : gt("{merged} of {total} merged", {
          merged: progress.parts.merged,
          total: progress.parts.total,
        });
  const accessibleName =
    progress === null
      ? undefined
      : progress.wave.total === 0
        ? gt("No waves yet. Open the board")
        : gt("Wave {current} of {waves}: {merged} of {parts} parts merged. Open the board", {
            current: progress.wave.current,
            waves: progress.wave.total,
            merged: progress.parts.merged,
            parts: progress.parts.total,
          });
  return { wave, progressLine: merged === null ? wave : `${wave} · ${merged}`, accessibleName };
}

/**
 * An initiative drawn as a folder, shaped like a project folder header. In Projects it sits in
 * its project's folder with its wave progress on a line under it; in List it stands alone with
 * the project's favicon and the wave text as its status word.
 */
export function SidebarInitiativeFolderHeader(props: {
  initiative: SidebarInitiativeRef;
  layout: "list" | "projects";
  /** The List icon; Projects draws the board icon. */
  project: ProjectFaviconProject | null;
  /** Names the project in the List tooltip. */
  projectName: string | null;
  /** The tree row of the project folder this header sits in. */
  folderRow?: string | undefined;
  collapsed: boolean;
  /** Set while collapsed; List shows the wave text instead. */
  status: SidebarGroupStatus | null;
  onToggle: (groupKey: string) => void;
  onContextMenu: (
    initiative: SidebarInitiativeRef,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
}) {
  const { initiative, layout, collapsed } = props;
  const gt = useGT();
  const rowId = initiativeGroupRowId(initiative.key);
  const waveText = useInitiativeWaveText(initiative.environmentId, initiative.slug);
  const status = layout === "projects" && collapsed ? props.status : null;
  const statusLabel = useSidebarGroupStatusLabel(status, null);
  const boardSearch = { environmentId: initiative.environmentId, slug: initiative.slug };
  return (
    <SortableSidebarMarker
      sortableId={initiativeGroupHeaderId(initiative.key)}
      data-testid="sidebar-initiative-folder"
      className={cn(
        "group/initiative-folder relative",
        props.folderRow === undefined && "mt-2 first:mt-0",
      )}
    >
      <Tooltip disabled={layout !== "list" || props.projectName === null}>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-sidebar-row={rowId}
              data-sidebar-parent={props.folderRow}
              aria-expanded={!collapsed}
              aria-label={
                statusLabel === null ? initiative.label : `${initiative.label}, ${statusLabel}`
              }
              onClick={() => props.onToggle(initiative.key)}
              onContextMenu={(event) => {
                event.preventDefault();
                props.onContextMenu(
                  initiative,
                  { x: event.clientX, y: event.clientY },
                  contextMenuSourceOf(event),
                );
              }}
              className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
          }
        >
          {layout === "list" && props.project !== null ? (
            <ProjectFavicon project={props.project} className="size-4 shrink-0" />
          ) : (
            <LayoutDashboardIcon
              aria-hidden
              className="size-4 shrink-0 text-(--sidebar-icon-color)"
            />
          )}
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground/90">
            {initiative.label}
          </span>
          {status !== null && statusLabel !== null ? (
            <SidebarGroupStatusText
              status={status}
              label={statusLabel}
              className="group-hover/initiative-folder:invisible group-has-[[data-sidebar-action-for]:focus]/initiative-folder:invisible pointer-coarse:invisible"
            />
          ) : null}
          {/* Holds the wave link's width so the label truncates before the link drawn over it. */}
          {layout === "list" ? (
            <span aria-hidden className="invisible shrink-0 text-xs tabular-nums">
              {waveText.wave}
            </span>
          ) : null}
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
              collapsed && "-rotate-90",
            )}
          />
        </TooltipTrigger>
        <TooltipPopup>{`${props.projectName} · ${initiative.label}`}</TooltipPopup>
      </Tooltip>
      {layout === "list" ? (
        // The row's inset, the chevron and its gap: the right edge of the held width.
        <span className="absolute inset-y-0 right-8 flex items-center">
          <Link
            to="/board"
            search={boardSearch}
            aria-label={waveText.accessibleName}
            data-testid="sidebar-initiative-board-link"
            data-sidebar-action-for={rowId}
            className="rounded-sm text-xs tabular-nums text-sidebar-muted-foreground outline-none hover:text-sidebar-foreground hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {waveText.wave}
          </Link>
        </span>
      ) : (
        <>
          <span className="absolute top-0 right-6 flex h-8 items-center opacity-0 focus-within:opacity-100 group-hover/initiative-folder:opacity-100 pointer-coarse:opacity-100">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    data-sidebar-action-for={rowId}
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={gt("Open board for {label}", { label: initiative.label })}
                    render={<Link to="/board" search={boardSearch} />}
                  />
                }
              >
                <LayoutDashboardIcon aria-hidden />
              </TooltipTrigger>
              <TooltipPopup>{gt("Open board")}</TooltipPopup>
            </Tooltip>
          </span>
          <div className="flex min-w-0 ps-8">
            <Link
              to="/board"
              search={boardSearch}
              aria-label={waveText.accessibleName}
              data-testid="sidebar-initiative-board-link"
              className="inline-flex h-6 min-w-0 items-center rounded-sm px-1 text-xs tabular-nums text-secondary-label outline-none hover:text-sidebar-foreground hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span className="min-w-0 truncate">{waveText.progressLine}</span>
            </Link>
          </div>
        </>
      )}
    </SortableSidebarMarker>
  );
}
