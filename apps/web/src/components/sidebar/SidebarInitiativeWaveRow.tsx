import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { ArrowUpRightIcon, LayoutDashboardIcon } from "lucide-react";

import { useLiveInitiative } from "../../pluginCards/live/liveAtoms";
import { initiativeProgress } from "../../pluginCards/live/liveStateIndex";
import {
  initiativeGroupEndId,
  initiativeGroupRowId,
  SortableSidebarMarker,
} from "./SidebarListMarkers";

const CROSS_FADE = "transition-opacity duration-150 ease-out motion-reduce:transition-none";

/** The last row of an initiative group: its current wave, linking to the board on that initiative. */
export function SidebarInitiativeWaveRow(props: {
  groupKey: string;
  environmentId: EnvironmentId;
  slug: string;
}) {
  const gt = useGT();
  const live = useLiveInitiative(props.environmentId, props.slug);
  const progress = live === null ? null : initiativeProgress(live);
  const label =
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
  return (
    <SortableSidebarMarker sortableId={initiativeGroupEndId(props.groupKey)} className="pb-2">
      <Link
        to="/board"
        search={{ environmentId: props.environmentId, slug: props.slug }}
        aria-label={accessibleName}
        data-testid="sidebar-initiative-wave"
        data-sidebar-row={`${initiativeGroupRowId(props.groupKey)}:end`}
        data-sidebar-parent={initiativeGroupRowId(props.groupKey)}
        className="group/wave flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <LayoutDashboardIcon aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 truncate">{label}</span>
        <span
          aria-hidden
          className="ml-auto grid shrink-0 items-center text-xs tabular-nums text-secondary-label"
        >
          {merged === null ? null : (
            <span
              className={`[grid-area:1/1] group-hover/wave:opacity-0 group-focus-visible/wave:opacity-0 ${CROSS_FADE}`}
            >
              {merged}
            </span>
          )}
          <span
            className={`inline-flex items-center justify-end gap-1 opacity-0 [grid-area:1/1] group-hover/wave:opacity-100 group-focus-visible/wave:opacity-100 ${CROSS_FADE}`}
          >
            {gt("Board")}
            <ArrowUpRightIcon aria-hidden className="size-3" />
          </span>
        </span>
      </Link>
    </SortableSidebarMarker>
  );
}
