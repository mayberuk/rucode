import type { PluginCardKind } from "@t3tools/contracts";
import {
  EyeIcon,
  GitBranchIcon,
  ListChecksIcon,
  ListTodoIcon,
  MessageSquareIcon,
  PlayIcon,
  SplitIcon,
  type LucideIcon,
} from "lucide-react";
import { createElement, use } from "react";

import { cn } from "~/lib/utils";
import { toneClassName } from "~/pluginCards/cards/dispatchCards.logic";
import { cardRendersAsLine, cardSummary } from "~/pluginCards/core/cardPresence.logic";
import { pluginCardRenderer } from "~/pluginCards/registry";
import { formatShortTimestamp } from "~/timestampFormat";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { TimelineRowTimestamp } from "./TimelineRowParts";
import { TimelineRowCtx, type TimelineRow } from "./timelineRowContext";
import { WorkLogButton } from "./WorkLog";

const KIND_ICONS = {
  "dispatch.decision": SplitIcon,
  "dispatch.plan": ListTodoIcon,
  "dispatch.runProgress": PlayIcon,
  "dispatch.verify": ListChecksIcon,
  "livecheck.result": EyeIcon,
  "livecheck.progress": EyeIcon,
  "iter8.round": MessageSquareIcon,
  "gitty.push": GitBranchIcon,
  "gitty.conflict": PullRequestGlyph.conflicting,
} as const satisfies Record<PluginCardKind, LucideIcon>;

export function PluginCardTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "plugin-card" }>;
}) {
  const { activeThreadEnvironmentId, timestampFormat, onToggleWorkGroup } = use(TimelineRowCtx);
  const renderer = pluginCardRenderer(row.card.kind);
  if (renderer === null) return null;
  const card = createElement(renderer, {
    card: row.card,
    environmentId: activeThreadEnvironmentId,
    threadRef: { environmentId: activeThreadEnvironmentId, threadId: row.card.threadId },
  });
  if (!cardRendersAsLine(row.card, row.presence)) {
    return <div className="mt-4 min-w-0 px-1">{card}</div>;
  }
  const summary = cardSummary(row.card, (iso) => formatShortTimestamp(iso, timestampFormat));
  const Icon = KIND_ICONS[row.card.kind];
  return (
    <div className="min-w-0">
      <WorkLogButton
        aria-expanded={!row.collapsed}
        onClick={() => onToggleWorkGroup(row.id, row.id)}
        icon={
          <Icon
            aria-hidden
            className="size-4 shrink-0 stroke-2 text-icon-muted opacity-70 light:brightness-60"
          />
        }
        label={<span className="block truncate">{summary.label}</span>}
        trailing={
          <>
            {summary.outcome === null ? null : (
              <span className={cn("shrink-0 text-xs", toneClassName(summary.outcome.tone))}>
                {summary.outcome.label}
              </span>
            )}
            <TimelineRowTimestamp createdAt={row.createdAt} timestampFormat={timestampFormat} />
          </>
        }
      />
      {row.collapsed ? null : <div className="min-w-0 px-1">{card}</div>}
    </div>
  );
}
