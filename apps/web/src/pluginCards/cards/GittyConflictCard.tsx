import { CircleAlertIcon } from "lucide-react";

import { PluginCardShell } from "../core/PluginCardShell";
import type { PluginCardRendererProps } from "../core/types";
import { PluginCardActionButton } from "./shared/PluginCardActionButton";

export function GittyConflictCard({ card, threadRef }: PluginCardRendererProps<"gitty.conflict">) {
  const data = card.data;
  return (
    <PluginCardShell
      label="Merge conflict"
      title={
        <>
          <span className="inline-flex items-center gap-1.5 text-warning-foreground">
            <CircleAlertIcon aria-hidden className="size-3.5" />
            Conflict
          </span>
          <span className="min-w-0 truncate font-mono font-normal">{data.file}</span>
        </>
      }
    >
      {data.sides.length === 0 && data.resolutions.length === 0 ? null : (
        <div className="px-3 pb-2.5">
          {data.sides.length === 0 ? null : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              {data.sides.map((side) => (
                <div key={side.label} className="contents">
                  <dt className="text-muted-foreground">{side.label}</dt>
                  <dd className="min-w-0 text-foreground/85">{side.summary}</dd>
                </div>
              ))}
            </dl>
          )}
          {data.resolutions.length === 0 ? null : (
            <ul className="mt-2 border-t border-border/60">
              {data.resolutions.map((resolution) => (
                <li
                  key={resolution.key}
                  className="flex items-center justify-between gap-3 border-b border-border/60 py-1.5 last:border-b-0"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm font-medium text-foreground/85">
                      {resolution.label}
                    </span>
                    <span className="text-2xs text-muted-foreground">
                      {resolution.predictedOutcome}
                    </span>
                  </div>
                  <PluginCardActionButton
                    card={card}
                    actionId={`use:${resolution.key}`}
                    threadRef={threadRef}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </PluginCardShell>
  );
}
