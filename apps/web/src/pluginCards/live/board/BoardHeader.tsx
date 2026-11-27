import type { PluginInitiativeBoard } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { UsageRow } from "~/components/chat/ThreadDetailsUsage";
import { formatElapsedDurationLabel } from "~/timestampFormat";

import { partTitle, runningParts, settledFill, spendView } from "./board.logic";

function headlineText(board: PluginInitiativeBoard, gt: ReturnType<typeof useGT>): string {
  const { headline } = board;
  switch (headline.kind) {
    case "closed":
      return gt("This initiative is closed.");
    case "needs-you":
      return headline.part === null
        ? gt(
            "{count, plural, =1 {A decision needs your answer.} other {# decisions need your answer.}}",
            {
              count: headline.decisions,
            },
          )
        : gt(
            "{count, plural, =1 {A decision from {part} needs your answer.} other {# decisions need your answer, the oldest from {part}.}}",
            {
              count: headline.decisions,
              part: partTitle(board, headline.part),
            },
          );
    case "failing": {
      const part = partTitle(board, headline.part);
      return headline.failedChecks === 0
        ? gt("{part} failed its gate.", { part })
        : gt(
            "{part} failed its gate with {count, plural, =1 {one failing check} other {# failing checks}}.",
            {
              part,
              count: headline.failedChecks,
            },
          );
    }
    case "gating":
      return gt("{part} is running its gate.", { part: partTitle(board, headline.part) });
    case "running": {
      const part = partTitle(board, headline.part);
      const running =
        headline.phase === null
          ? gt("{part} is running.", { part })
          : gt("{part} is on phase {index} of {total}.", {
              part,
              index: headline.phase.index,
              total: headline.phase.total,
            });
      return headline.nextPart === null
        ? running
        : gt("{running} {next} is next.", { running, next: partTitle(board, headline.nextPart) });
    }
    case "waiting":
      return headline.nextPart === null
        ? gt("Waiting for the next wave to open.")
        : gt("Waiting to start {part}.", { part: partTitle(board, headline.nextPart) });
    case "done":
      return gt("Every part is settled.");
  }
}

export function BoardHeader({
  board,
  now,
  paused,
}: {
  readonly board: PluginInitiativeBoard;
  readonly now: string;
  readonly paused: boolean;
}) {
  const gt = useGT();
  const nowMs = Date.parse(now);
  const started =
    board.startedAt === null ? "" : formatElapsedDurationLabel(board.startedAt, nowMs);
  const updated = formatElapsedDurationLabel(board.asOf, nowMs);
  const waveCount = board.waves.length;
  const { settled, total } = board.parts;
  const spend = spendView(board.spend);
  const partsValue = gt("{settled} of {total}", { settled, total });
  const spendValue =
    spend.value === null
      ? gt("Unknown")
      : spend.ceiling === null
        ? spend.value
        : gt("{value} of {ceiling}", { value: spend.value, ceiling: spend.ceiling });
  const spendState = {
    exact: gt("Exact"),
    estimated: gt("Estimated"),
    incomplete: gt("Incomplete"),
    unknown: gt("Unknown"),
  }[board.spend.state];
  const running =
    runningParts(board)
      .map(({ title, id }) => title || id)
      .join(", ") || gt("Nothing");

  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 px-2.5">
        <h2 className="text-sm font-medium text-foreground">{board.title || board.slug}</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">{headlineText(board, gt)}</p>
        <p className="text-xs text-muted-foreground/70">
          {gt(
            "{parts, plural, one {# part} other {# parts}} in {waves, plural, one {# wave} other {# waves}}",
            {
              parts: total,
              waves: waveCount,
            },
          )}
          {started === ""
            ? null
            : started === "just now"
              ? gt(" · started just now")
              : gt(" · started {age} ago", { age: started })}
          {updated === ""
            ? null
            : updated === "just now"
              ? gt(" · updated just now")
              : gt(" · updated {age} ago", { age: updated })}
        </p>
        {paused ? (
          <p className="text-xs text-muted-foreground/70">
            {gt("Updates paused: can't reach the server")}
          </p>
        ) : null}
      </div>
      <div className="grid max-w-md grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        <UsageRow
          label={gt("Parts settled")}
          fill={settledFill(board.parts)}
          tone={null}
          value={partsValue}
          tooltip={gt("{settled} of {total, plural, one {# part} other {# parts}} settled", {
            settled,
            total,
          })}
        />
        <UsageRow
          label={gt("Spend")}
          fill={spend.fill}
          tone={spend.tone}
          value={spendValue}
          tooltip={spendState}
        />
        <UsageRow label={gt("Running")} fill={null} tone={null} value={running} tooltip={running} />
      </div>
    </header>
  );
}
