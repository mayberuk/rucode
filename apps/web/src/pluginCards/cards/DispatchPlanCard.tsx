import { Badge } from "~/components/ui/badge";
import { cn } from "~/lib/utils";
import { PluginCardShell } from "../core/PluginCardShell";
import type { PluginCardRendererProps } from "../core/types";
import {
  hasPlanFooter,
  phaseStatusTone,
  phasesByWave,
  planSummary,
  toneClassName,
} from "./dispatchCards.logic";
import { PluginCardActionButton } from "./shared/PluginCardActionButton";
import { withUniqueKeys } from "./shared/cardFormat.logic";

export function DispatchPlanCard({ card, threadRef }: PluginCardRendererProps<"dispatch.plan">) {
  const data = card.data;
  return (
    <PluginCardShell
      label="Plan"
      title={
        <>
          <Badge variant="secondary">Plan</Badge>
          <span className="min-w-0 truncate font-mono font-normal">{data.task}</span>
          <span className="font-normal text-muted-foreground">{planSummary(data)}</span>
        </>
      }
    >
      <div className="flex flex-col gap-3 px-3 pb-2.5">
        {phasesByWave(data.phases).map((group) => (
          <div key={group.wave}>
            <h4 className="mb-1 text-xs font-medium text-muted-foreground">Wave {group.wave}</h4>
            <ul>
              {withUniqueKeys(group.phases, (phase) => phase.id).map(({ key, item: phase }) => (
                <li key={key} className="flex items-center gap-2 py-1 text-sm">
                  <span className="min-w-0 truncate text-foreground/85">{phase.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{phase.tier}</span>
                  {phase.risk ? (
                    <Badge variant="warning" size="sm">
                      Risk
                    </Badge>
                  ) : null}
                  <span
                    className={cn(
                      "ml-auto shrink-0 text-xs",
                      toneClassName(phaseStatusTone(phase.status)),
                    )}
                  >
                    {phase.status}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {hasPlanFooter(card) ? (
        <div className="flex justify-end gap-2 px-3 pb-2.5">
          <PluginCardActionButton
            card={card}
            actionId="request-changes"
            threadRef={threadRef}
            variant="outline"
            size="sm"
          />
          <PluginCardActionButton
            card={card}
            actionId="approve"
            threadRef={threadRef}
            variant="default"
            size="sm"
          />
        </div>
      ) : null}
    </PluginCardShell>
  );
}
