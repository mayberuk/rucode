import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { SquareIcon } from "lucide-react";

import { useNowSecond } from "~/hooks/useNowSecond";
import { PluginCardShell } from "../core/PluginCardShell";
import { PluginCardStep } from "../core/PluginCardStep";
import type { PluginCardRendererProps } from "../core/types";
import { LivecheckThumbnail } from "./LivecheckThumbnail";
import { PluginCardActionButton } from "./shared/PluginCardActionButton";
import { progressMeta } from "./livecheckCards.logic";
import { agoLabel } from "./shared/cardFormat.logic";

/** Mounted only while the run is unfinished, so a settled card never subscribes to the tick. */
function HeartbeatAge({ iso }: { iso: string }) {
  const nowMs = useNowSecond();
  return <>{agoLabel(iso, nowMs)}</>;
}

export function LivecheckProgressCard({
  card,
  threadRef,
}: PluginCardRendererProps<"livecheck.progress">) {
  const data = card.data;
  const stepMeta = progressMeta(data);
  const steps =
    data.steps.length === 0 ? (
      <p className="px-1 py-1 text-sm text-muted-foreground">Starting</p>
    ) : (
      data.steps.map((step) => (
        <PluginCardStep
          key={step.index}
          state={step.state}
          label={step.label}
          trailing={
            step.state === "stale"
              ? "no heartbeat"
              : step.durationMs === null
                ? null
                : formatDuration(step.durationMs)
          }
        />
      ))
    );

  return (
    <PluginCardShell
      label="Live check in progress"
      title={
        <span className="inline-flex min-w-0 items-center gap-x-3">
          <span className="shrink-0">Checking</span>
          <span className="min-w-0 truncate font-normal">{data.target}</span>
          {stepMeta === null && data.heartbeatAt === null ? null : (
            <span className="shrink-0 font-normal text-muted-foreground">
              {stepMeta}
              {stepMeta !== null && data.heartbeatAt !== null ? " · " : null}
              {data.heartbeatAt === null ? null : (
                <>
                  heartbeat <HeartbeatAge iso={data.heartbeatAt} />
                </>
              )}
            </span>
          )}
        </span>
      }
      actions={
        <PluginCardActionButton
          card={card}
          actionId="stop"
          threadRef={threadRef}
          icon={<SquareIcon className="size-3" />}
        />
      }
    >
      {data.latestAssetId === null ? (
        <div className="px-2 pb-2">{steps}</div>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 px-2 pb-2">
          <div className="min-w-0">{steps}</div>
          <div className="pe-1">
            <LivecheckThumbnail
              key={data.latestAssetId}
              threadRef={threadRef}
              cardId={card.id}
              assetId={data.latestAssetId}
              caption="Latest"
              failed={false}
            />
          </div>
        </div>
      )}
    </PluginCardShell>
  );
}
