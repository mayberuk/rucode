import { createElement, use } from "react";

import { pluginCardRenderer } from "~/pluginCards/registry";
import { TimelineRowCtx, type TimelineRow } from "./timelineRowContext";

export function PluginCardTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "plugin-card" }>;
}) {
  const { activeThreadEnvironmentId } = use(TimelineRowCtx);
  const renderer = pluginCardRenderer(row.card.kind);
  if (renderer === null) return null;
  return (
    <div className="min-w-0 px-1">
      {createElement(renderer, {
        card: row.card,
        environmentId: activeThreadEnvironmentId,
        threadRef: { environmentId: activeThreadEnvironmentId, threadId: row.card.threadId },
      })}
    </div>
  );
}
