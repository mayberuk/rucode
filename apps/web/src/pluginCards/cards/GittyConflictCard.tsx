import { CircleAlertIcon } from "lucide-react";

import { splitPath } from "./iter8GittyCards.logic";
import { PluginCardShell } from "../core/PluginCardShell";
import type { PluginCardRendererProps } from "../core/types";
import { PluginCardActionButton } from "./shared/PluginCardActionButton";

export function GittyConflictCard({ card, threadRef }: PluginCardRendererProps<"gitty.conflict">) {
  const data = card.data;
  const file = splitPath(data.file);
  return (
    <PluginCardShell
      label="Merge conflict"
      title={
        <span className="inline-flex min-w-0 items-center gap-x-3">
          <span className="inline-flex shrink-0 items-center gap-1.5 text-warning-foreground">
            <CircleAlertIcon aria-hidden className="size-3.5" />
            Conflict
          </span>
          <span className="flex min-w-0 font-mono font-normal" title={data.file}>
            {file.folder === "" ? null : (
              <span className="min-w-0 truncate text-muted-foreground">{file.folder}</span>
            )}
            <span className="max-w-full shrink-0 truncate">{file.name}</span>
          </span>
        </span>
      }
    >
      {data.sides.length === 0 && data.resolutions.length === 0 ? (
        <p className="px-3 pb-2.5 text-xs text-muted-foreground">Resolve it in your editor</p>
      ) : (
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
