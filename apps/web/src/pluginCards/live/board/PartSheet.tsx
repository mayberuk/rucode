import type {
  PluginInitiativeBoard,
  PluginInitiativeGate,
  PluginInitiativePart,
  PluginInitiativePhase,
  PluginInitiativeWave,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { GitBranchIcon } from "lucide-react";

import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { Button } from "~/components/ui/button";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "~/components/ui/sheet";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import { formatElapsedDurationLabel } from "~/timestampFormat";

import { usePartStatusText } from "./PartRow";
import { formatCost, mergeRequestLabel, partTitle, phaseSummary } from "./board.logic";
import { CHECK_STATE_LOOK, PHASE_STATE_LOOK } from "./boardLook";

function PartPhases({ phases }: { readonly phases: ReadonlyArray<PluginInitiativePhase> }) {
  const gt = useGT();
  const { done, total, next } = phaseSummary(phases);
  const labels = {
    done: gt("Done"),
    running: gt("Running"),
    failed: gt("Failed"),
    stale: gt("Stale"),
    pending: gt("Pending"),
  };

  return (
    <section>
      <h3 className="px-2.5 pb-1 text-xs font-medium text-muted-foreground">
        {gt("Phases · {done} of {total} done", { done, total })}
      </h3>
      <ul>
        {phases.map((phase) => {
          const { icon: Icon, className } = PHASE_STATE_LOOK[phase.state];
          const status = phase === next ? gt("Next") : labels[phase.state];
          return (
            <li key={phase.id} className="flex h-7 items-center gap-2.5 px-2.5">
              <Icon aria-hidden className={cn("size-4 shrink-0", className)} />
              <span className="min-w-0 flex-1 truncate text-sm text-foreground/90">
                {phase.name}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {phase.attempt === null
                  ? status
                  : gt("{status} · attempt {attempt}", { status, attempt: phase.attempt })}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PartGate({
  gate,
  age,
}: {
  readonly gate: PluginInitiativeGate;
  readonly age: string | null;
}) {
  const gt = useGT();
  const state = { passed: gt("passed"), failed: gt("failed"), running: gt("running") }[gate.state];
  const checkLabels = {
    pass: gt("Passed"),
    fail: gt("Failed"),
    running: gt("Running"),
    pending: gt("Pending"),
    stale: gt("Stale"),
    skipped: gt("Skipped"),
  };

  return (
    <section>
      <h3 className="px-2.5 pb-1 text-xs font-medium text-muted-foreground">
        {age === null
          ? gt("Gate · {state}", { state })
          : gt("Gate · {state} · {age}", { state, age })}
      </h3>
      {gate.checks.length === 0 ? (
        <p className="px-2.5 text-xs text-muted-foreground">{gt("No check details yet")}</p>
      ) : (
        <ul>
          {gate.checks.map((check) => {
            const { icon: Icon, className } = CHECK_STATE_LOOK[check.state];
            return (
              <li key={check.id} className="flex min-h-7 items-start gap-2.5 px-2.5 py-1">
                <Icon
                  role="img"
                  aria-label={checkLabels[check.state]}
                  className={cn("mt-0.5 size-4 shrink-0", className)}
                />
                <div className="min-w-0">
                  <p className="break-words text-sm text-foreground/90">{check.id}</p>
                  {check.summary ? (
                    <p className="break-words text-xs text-muted-foreground">{check.summary}</p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function PartSheet({
  part,
  wave,
  board,
  now,
  open,
  onOpenChange,
}: {
  readonly part: PluginInitiativePart;
  readonly wave: PluginInitiativeWave;
  readonly board: PluginInitiativeBoard;
  readonly now: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const gt = useGT();
  const statusText = usePartStatusText()(part);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "branch" });
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const { branch, mergeRequest, gate, phases, status } = part;
  const mrUrl = mergeRequest?.url;
  const passedGate = status === "gate-pass" || status === "mr-open" || status === "merged";
  const nowMs = Date.parse(now);

  function ageLabel(date: string | null) {
    const age = date === null ? "" : formatElapsedDurationLabel(date, nowMs);
    if (!age) return null;
    return age === "just now" ? gt("just now") : gt("{age} ago", { age });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup side="right" {...(reducedMotion ? { transitionDurationMs: 0 } : {})}>
        <SheetHeader>
          <div className="pe-10">
            <SheetTitle className="break-words">{partTitle(board, part.id)}</SheetTitle>
          </div>
          <SheetDescription className="break-words">
            {gt("Wave {number} · {wave} · {status}", {
              number: wave.number,
              wave: wave.name,
              status: statusText,
            })}
          </SheetDescription>
        </SheetHeader>
        <div
          className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3.5 pb-6"
          data-slot="sheet-panel"
        >
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-2.5 text-xs text-muted-foreground">
            <dt>{gt("Branch")}</dt>
            <dd className="break-words">
              {branch ? (
                <span className="font-mono text-foreground/80">{branch}</span>
              ) : (
                gt("Created when the part starts")
              )}
            </dd>
            <dt>{gt("Merge request")}</dt>
            <dd className="break-words">
              {mergeRequest ? (
                mrUrl ? (
                  <a
                    href={mrUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-info-foreground underline-offset-4 hover:underline"
                  >
                    {mergeRequestLabel(mergeRequest)}
                  </a>
                ) : (
                  <span className="text-foreground/80">{mergeRequest.ref}</span>
                )
              ) : passedGate ? (
                gt("None")
              ) : (
                gt("Opens after the gate passes")
              )}
            </dd>
            <dt>{gt("Started")}</dt>
            <dd className="tabular-nums">{ageLabel(part.startedAt) ?? gt("Not started")}</dd>
            <dt>{gt("Last activity")}</dt>
            <dd className="tabular-nums">{ageLabel(part.lastEventAt) ?? gt("No activity yet")}</dd>
            <dt>{gt("Cost")}</dt>
            <dd className="tabular-nums">{formatCost(part.cost) ?? gt("Nothing spent yet")}</dd>
          </dl>
          {phases.length > 0 ? <PartPhases phases={phases} /> : null}
          {gate ? <PartGate gate={gate} age={ageLabel(gate.at)} /> : null}
        </div>
        {branch || mrUrl ? (
          <div
            className="flex flex-wrap justify-end gap-2 border-t bg-muted/72 px-6 py-4"
            data-slot="sheet-footer"
          >
            {branch ? (
              <Button variant="outline" size="sm" onClick={() => copyToClipboard(branch)}>
                <GitBranchIcon />
                {isCopied ? gt("Copied") : gt("Copy branch")}
              </Button>
            ) : null}
            {mrUrl ? (
              <Button
                variant="outline"
                size="sm"
                render={<a href={mrUrl} target="_blank" rel="noreferrer" />}
              >
                <PullRequestGlyph.pullRequest />
                {gt("Open MR")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </SheetPopup>
    </Sheet>
  );
}
