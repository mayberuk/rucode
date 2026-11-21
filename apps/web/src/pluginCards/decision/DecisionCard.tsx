import { CheckIcon, CircleIcon, SplitIcon } from "lucide-react";

import { usePrimarySettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { formatDayAwareTimestamp } from "~/timestampFormat";
import { PluginCardShell } from "../core/PluginCardShell";
import type { PluginCardRendererProps } from "../core/types";
import { decisionContextLabel, decisionOutcome } from "./decisionPanel.logic";

export function DecisionCard({ card }: PluginCardRendererProps<"dispatch.decision">) {
  const data = card.data;
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const outcome = decisionOutcome(data);
  const titleColor = outcome === null ? "text-warning-foreground" : "text-muted-foreground";
  return (
    <PluginCardShell
      label="Decision"
      title={
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <SplitIcon aria-hidden className={cn("size-3.5 shrink-0", titleColor)} />
          <span className={titleColor}>Decision</span>
          <span className="truncate font-normal text-muted-foreground">
            {decisionContextLabel(data)}
          </span>
        </span>
      }
    >
      <div className="px-3 pb-2.5">
        <p className="text-sm whitespace-pre-wrap text-foreground/85 wrap-anywhere">
          {data.question}
        </p>
        {outcome === null ? (
          <>
            <ul className="mt-1.5 flex flex-col gap-1">
              {data.options.map((option) => (
                <li
                  key={option.key}
                  className="flex items-start gap-1.5 text-sm text-foreground/70"
                >
                  <CircleIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-icon-muted" />
                  <div>
                    {option.label}
                    {option.recommended ? (
                      <p className="text-xs text-secondary-label">Recommended</p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-2xs text-secondary-label">Answer it in the composer.</p>
          </>
        ) : (
          <div className="mt-1.5 flex flex-col gap-0.5">
            <p className="inline-flex items-center gap-1.5 text-sm text-foreground">
              {data.state === "answered" ? (
                <CheckIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              ) : null}
              {outcome.headline}
            </p>
            <p className="text-xs text-muted-foreground">
              {outcome.who}
              {outcome.who !== null && outcome.at !== null ? " · " : null}
              {outcome.at === null ? null : (
                <time dateTime={outcome.at}>
                  {formatDayAwareTimestamp(outcome.at, timestampFormat)}
                </time>
              )}
            </p>
          </div>
        )}
      </div>
    </PluginCardShell>
  );
}
