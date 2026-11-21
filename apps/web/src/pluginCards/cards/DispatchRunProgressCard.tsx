import { cn } from "~/lib/utils";
import { PluginCardShell } from "../core/PluginCardShell";
import { PluginCardStep } from "../core/PluginCardStep";
import type { PluginCardRendererProps } from "../core/types";
import {
  outcomeLabel,
  outcomeTone,
  runStepTrailing,
  runSummary,
  settledReason,
  toneClassName,
} from "./dispatchCards.logic";

export function DispatchRunProgressCard({ card }: PluginCardRendererProps<"dispatch.runProgress">) {
  const data = card.data;
  const reason = settledReason(data);
  return (
    <PluginCardShell
      label="Run"
      title={
        <span className="inline-flex min-w-0 items-center gap-x-3">
          <span className="shrink-0">Run</span>
          <span className="min-w-0 truncate font-normal text-muted-foreground">
            {data.part} · wave {data.wave}
          </span>
          <span className="shrink-0 font-normal text-muted-foreground">{runSummary(data)}</span>
        </span>
      }
      actions={
        <span className={cn("text-xs font-medium", toneClassName(outcomeTone(data.outcome)))}>
          {outcomeLabel(data.outcome)}
        </span>
      }
    >
      <div className="px-2 pb-2">
        {data.phases.map((phase) => (
          <PluginCardStep
            key={phase.id}
            state={phase.state}
            label={phase.name}
            trailing={runStepTrailing(phase)}
          />
        ))}
      </div>
      {reason === null ? null : (
        <p className="px-3 pb-2.5 text-xs text-muted-foreground">{reason}</p>
      )}
    </PluginCardShell>
  );
}
