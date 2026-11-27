import type { PluginInitiativePart } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { formatElapsedDurationLabel } from "~/timestampFormat";

import { failedCheckCount, formatCost, mergeRequestLabel, phaseSummary } from "./board.logic";
import { PART_STATUS_LOOK, PHASE_SEGMENT_CLASS } from "./boardLook";

export function usePartStatusText(): (part: PluginInitiativePart) => string {
  const gt = useGT();
  return (part) => {
    switch (part.status) {
      case "planned":
        return gt("Planned");
      case "briefed":
        return gt("Briefed");
      case "specced":
        return part.phases.length === 0
          ? gt("Spec written")
          : gt("Spec written · {count, plural, one {# phase} other {# phases}}", {
              count: part.phases.length,
            });
      case "queued":
        return gt("Up next");
      case "running": {
        const { current, total } = phaseSummary(part.phases);
        return current === null
          ? gt("Running")
          : gt("Phase {index} of {total} · {name}", {
              index: current.index,
              total,
              name: current.phase.name,
            });
      }
      case "gating":
        return gt("Running the gate");
      case "gate-fail": {
        const count = failedCheckCount(part.gate);
        const attempt = phaseSummary(part.phases).attempt;
        const failure =
          count === 0
            ? gt("Gate failed")
            : gt("{count, plural, =1 {One gate check failing} other {# gate checks failing}}", {
                count,
              });
        return attempt !== null && attempt >= 2
          ? gt("{failure} · attempt {attempt}", { failure, attempt })
          : failure;
      }
      case "gate-pass":
        return gt("Gate passed");
      case "mr-open":
        return gt("MR open");
      case "merged":
        return gt("Merged");
    }
  };
}

function PartMergeRequest({ part }: { readonly part: PluginInitiativePart }) {
  const gt = useGT();
  const { mergeRequest, status } = part;
  if (mergeRequest !== null) {
    const label = mergeRequestLabel(mergeRequest);
    return mergeRequest.url ? (
      <a
        href={mergeRequest.url}
        target="_blank"
        rel="noreferrer"
        className="relative truncate text-xs text-info-foreground hover:underline"
      >
        {label}
      </a>
    ) : (
      <span className="truncate text-xs text-muted-foreground">{label}</span>
    );
  }
  return (
    <span className="truncate text-xs text-muted-foreground/70">
      {status === "running" || status === "gating" || status === "gate-fail"
        ? gt("After gate")
        : null}
    </span>
  );
}

export function PartRow({
  part,
  now,
  onOpen,
}: {
  readonly part: PluginInitiativePart;
  readonly now: string;
  readonly onOpen: (partId: string) => void;
}) {
  const gt = useGT();
  const status = usePartStatusText()(part);
  const [mountedStatus] = useState(part.status);
  const [statusChanged, setStatusChanged] = useState(false);
  const animate = statusChanged || part.status !== mountedStatus;
  if (animate && !statusChanged) setStatusChanged(true);

  const { icon: StatusIcon, className: iconColor } = PART_STATUS_LOOK[part.status];
  const title = part.title || part.id;
  const { done, total } = phaseSummary(part.phases);
  const cost = formatCost(part.cost);
  const age =
    part.lastEventAt === null ? "" : formatElapsedDurationLabel(part.lastEventAt, Date.parse(now));
  const ageText = age === "just now" ? gt("just now") : age;

  return (
    <div
      role="group"
      aria-label={gt("{part}, {status}", { part: title, status })}
      className="relative isolate grid h-9 grid-cols-[16px_minmax(0,1fr)_minmax(0,1.15fr)_64px_84px_88px] items-center gap-x-2.5 rounded-md px-2.5 hover:bg-black/[0.035] max-sm:grid-cols-[16px_minmax(0,1fr)_64px_72px] dark:hover:bg-white/[0.08]"
    >
      <StatusIcon
        key={part.status}
        aria-hidden
        className={cn(
          "size-4",
          iconColor,
          animate &&
            "transition-[opacity,scale] duration-150 ease-out motion-safe:starting:opacity-0 motion-safe:starting:scale-50 motion-reduce:transition-none",
        )}
      />
      <button
        type="button"
        aria-label={gt("{title}, {status}. Open details", { title, status })}
        className="truncate text-start text-sm text-foreground/90 outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
        onClick={(event) => {
          // Safari does not focus buttons on click, so the sheet needs an explicit return target.
          event.currentTarget.focus({ preventScroll: true });
          onOpen(part.id);
        }}
      >
        {title}
      </button>
      <span
        className={cn(
          "truncate text-xs max-sm:hidden",
          part.status === "gate-fail" ? "text-destructive-foreground" : "text-muted-foreground",
        )}
      >
        {status}
      </span>
      {total === 0 ? (
        <span className="text-2xs text-muted-foreground/70">{gt("Not split")}</span>
      ) : (
        <div
          role="img"
          aria-label={gt("{done} of {total} phases done", { done, total })}
          className="flex items-center gap-1.5"
        >
          <div className="flex w-16 min-w-0 gap-0.5">
            {part.phases.map(({ id, state }) => (
              <span
                key={id}
                className={cn(
                  "h-1 max-w-[9px] min-w-0 flex-1 rounded-full transition-colors duration-300 ease-out motion-reduce:transition-none",
                  PHASE_SEGMENT_CLASS[state],
                )}
              />
            ))}
          </div>
          <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
            {gt("{done}/{total}", { done, total })}
          </span>
        </div>
      )}
      <PartMergeRequest part={part} />
      <span className="truncate text-end text-xs tabular-nums text-muted-foreground max-sm:hidden">
        {cost && ageText ? gt("{cost} · {age}", { cost, age: ageText }) : cost || ageText}
      </span>
      {animate ? (
        <span
          key={`tint-${part.status}`}
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 rounded-md bg-accent opacity-0 transition-opacity duration-1000 ease-out starting:opacity-100 motion-reduce:hidden"
        />
      ) : null}
    </div>
  );
}
