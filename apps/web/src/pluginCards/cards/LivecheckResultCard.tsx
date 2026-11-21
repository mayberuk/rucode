import { CheckIcon, CircleAlertIcon, RotateCcwIcon, WrenchIcon, XIcon } from "lucide-react";
import { use, useRef } from "react";

import { TimelineRowCtx } from "~/components/chat/timelineRowContext";
import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { PluginCardShell } from "../core/PluginCardShell";
import type { PluginCardRendererProps } from "../core/types";
import { LivecheckThumbnail } from "./LivecheckThumbnail";
import {
  expandableImages,
  thumbnailCaption,
  verdictPresentation,
  type VerdictPresentation,
} from "./livecheckCards.logic";
import { PluginCardActionButton } from "./shared/PluginCardActionButton";
import { agoLabel } from "./shared/cardFormat.logic";

const VERDICT_ICONS = {
  check: CheckIcon,
  x: XIcon,
  alert: CircleAlertIcon,
} as const satisfies Record<VerdictPresentation["icon"], typeof CheckIcon>;

const VERDICT_TONES = {
  success: "text-success-foreground",
  destructive: "text-destructive-foreground",
  warning: "text-warning-foreground",
} as const satisfies Record<VerdictPresentation["tone"], string>;

function FinishedAgo({ iso }: { iso: string }) {
  const nowMs = Date.parse(`${useNowMinute()}:00Z`);
  return <>{agoLabel(iso, nowMs)}</>;
}

export function LivecheckResultCard({
  card,
  threadRef,
}: PluginCardRendererProps<"livecheck.result">) {
  const data = card.data;
  const { onImageExpand } = use(TimelineRowCtx);
  const loadedUrls = useRef(new Map<string, string>());
  const verdict = verdictPresentation(data.verdict);
  const VerdictIcon = VERDICT_ICONS[verdict.icon];
  const shots = data.steps.flatMap((step) =>
    step.assetId === null ? [] : [{ step, assetId: step.assetId }],
  );

  const recordLoaded = (assetId: string, url: string | null) => {
    if (url === null) loadedUrls.current.delete(assetId);
    else loadedUrls.current.set(assetId, url);
  };
  const expand = (stepIndex: number) => () => {
    const images = expandableImages(data.steps, loadedUrls.current);
    const index = images.findIndex((image) => image.stepIndex === stepIndex);
    if (index < 0) return;
    onImageExpand({
      images: images.map(({ src, name }) => ({ src, name, mimeType: "image/png", ownsSrc: false })),
      index,
    });
  };

  return (
    <PluginCardShell
      label="Live check result"
      title={
        <>
          <span className={cn("inline-flex items-center gap-1.5", VERDICT_TONES[verdict.tone])}>
            <VerdictIcon aria-hidden className="size-3.5" />
            {verdict.label}
          </span>
          <span className="min-w-0 truncate font-normal">{data.target}</span>
          <span className="font-normal text-muted-foreground">
            run {data.runId}
            {data.finishedAt === null ? null : (
              <>
                {" · "}
                <FinishedAgo iso={data.finishedAt} />
              </>
            )}
          </span>
        </>
      }
      actions={
        <>
          <PluginCardActionButton
            card={card}
            actionId="rerun"
            threadRef={threadRef}
            icon={<RotateCcwIcon className="size-3" />}
          />
          <PluginCardActionButton
            card={card}
            actionId="fix"
            threadRef={threadRef}
            variant="outline"
            icon={<WrenchIcon className="size-3" />}
          />
        </>
      }
    >
      {data.summary === "" && data.judge === null && shots.length === 0 ? null : (
        <div className="px-3 pb-3">
          {data.summary === "" ? null : (
            <p className="text-sm text-foreground/85">{data.summary}</p>
          )}
          {data.judge === null ? null : (
            <p className="mt-1 text-xs text-muted-foreground">{data.judge}</p>
          )}
          {shots.length === 0 ? null : (
            <div className="mt-2.5 flex flex-wrap gap-2">
              {shots.map(({ step, assetId }) => (
                <LivecheckThumbnail
                  key={step.index}
                  threadRef={threadRef}
                  cardId={card.id}
                  assetId={assetId}
                  caption={thumbnailCaption(step)}
                  failed={step.index === data.failedStepIndex}
                  onExpand={typeof onImageExpand === "function" ? expand(step.index) : undefined}
                  onLoaded={recordLoaded}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </PluginCardShell>
  );
}
