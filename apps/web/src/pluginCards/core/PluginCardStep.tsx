import type { PluginStepState } from "@t3tools/contracts";
import { CheckIcon, CircleAlertIcon, CircleDashedIcon, CircleIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { WorkLogRow } from "~/components/chat/WorkLog";
import { cn } from "~/lib/utils";

function StepIcon({ state }: { state: PluginStepState }) {
  const className = "size-4 shrink-0 stroke-2";
  switch (state) {
    case "done":
      return <CheckIcon aria-hidden className={className} />;
    // Static on purpose: a card can sit in a long timeline, and a spinner repaints every frame.
    case "running":
      return <CircleDashedIcon aria-hidden className={className} />;
    case "failed":
      return <XIcon aria-hidden className={className} />;
    case "stale":
      return <CircleAlertIcon aria-hidden className={className} />;
    case "pending":
      return <CircleIcon aria-hidden className={className} />;
  }
}

function stepTone(state: PluginStepState): string {
  switch (state) {
    case "failed":
      return "text-destructive-foreground";
    case "stale":
      return "text-warning-foreground";
    case "pending":
      return "text-muted-foreground";
    case "running":
    case "done":
      return "text-secondary-label";
  }
}

export function PluginCardStep({
  state,
  label,
  trailing,
}: {
  state: PluginStepState;
  label: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <WorkLogRow
      data-plugin-step-state={state}
      icon={
        <span className="text-icon-muted">
          <StepIcon state={state} />
        </span>
      }
      label={<span className={cn("block truncate", stepTone(state))}>{label}</span>}
      trailing={
        trailing ? (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{trailing}</span>
        ) : null
      }
    />
  );
}
