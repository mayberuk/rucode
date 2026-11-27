import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, LayersIcon } from "lucide-react";

import { ThreadDetailsControl } from "~/components/chat/ThreadDetailsControl";
import { ThreadDetailsSection } from "~/components/chat/ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "~/components/chat/threadDetailsPanelStyles";
import { UsageRow } from "~/components/chat/ThreadDetailsUsage";
import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";

import { useThreadInitiative } from "./liveAtoms";
import { formatAsOf, initiativeMetrics } from "./liveStateIndex";

export function InitiativeDetailsSection({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const initiative = useThreadInitiative(environmentId, threadId);
  const nowMinute = useNowMinute();
  if (initiative === null) return null;

  return (
    <ThreadDetailsSection
      headingId="thread-details-initiative-heading"
      title="Initiative"
      actions={
        <span className="text-3xs leading-none text-muted-foreground">
          {formatAsOf(initiative.asOf, `${nowMinute}:00Z`)}
        </span>
      }
    >
      <div className="flex flex-col">
        <ThreadDetailsControl
          render={<Link to="/board" search={{ environmentId, slug: initiative.slug }} />}
        >
          <LayersIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
          <span className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
            {initiative.title ?? initiative.slug}
          </span>
          <ChevronRightIcon className={THREAD_DETAILS_PANEL_CHEVRON_CLASS} aria-hidden />
        </ThreadDetailsControl>
        <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
          {initiativeMetrics(initiative).map((metric) => (
            <UsageRow
              key={metric.label}
              label={metric.label}
              fill={metric.fill === null ? null : metric.fill * 100}
              tone={metric.tone}
              value={metric.value}
              tooltip={<span className="text-foreground">{metric.tooltip}</span>}
            />
          ))}
        </div>
      </div>
    </ThreadDetailsSection>
  );
}
