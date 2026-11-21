import type { GittyPushCardData } from "@t3tools/contracts";
import { CheckIcon, CircleDashedIcon, XIcon } from "lucide-react";

import { useOpenLink } from "~/browser/useOpenLink";
import { DiffStatLabel } from "~/components/chat/DiffStatLabel";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { InlineButton } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import { PluginCardShell } from "../core/PluginCardShell";
import { PluginCardStep } from "../core/PluginCardStep";
import type { PluginCardRendererProps } from "../core/types";
import { mergeRequestLabel, pipelineLabel, pushSummary } from "./iter8GittyCards.logic";
import { PluginCardActionButton } from "./shared/PluginCardActionButton";
import { shortSha, withUniqueKeys } from "./shared/cardFormat.logic";

const PIPELINE_DISPLAY = {
  running: { Icon: CircleDashedIcon, tone: "text-info-foreground" },
  passed: { Icon: CheckIcon, tone: "text-success-foreground" },
  failed: { Icon: XIcon, tone: "text-destructive-foreground" },
} as const;

export function GittyPushCard({ card, threadRef }: PluginCardRendererProps<"gitty.push">) {
  const data = card.data;
  const openLink = useOpenLink(threadRef);
  const summary = pushSummary(data);

  const openUrl = (url: string) => {
    openLink(url).catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Could not open the link",
        description: error instanceof Error ? error.message : undefined,
      });
    });
  };

  return (
    <PluginCardShell
      label="Push in batches"
      title={
        <span className="inline-flex min-w-0 items-center gap-x-3">
          <span className="shrink-0">{summary.verb}</span>
          <span className="min-w-0 truncate font-mono font-normal">{data.branch}</span>
          <span className="shrink-0 font-normal text-muted-foreground">{summary.label}</span>
        </span>
      }
      actions={<PluginCardActionButton card={card} actionId="push-next" threadRef={threadRef} />}
    >
      {data.batches.length === 0 && data.mergeRequest === null ? null : (
        <div className="px-3 pb-2.5">
          {withUniqueKeys(data.batches, (batch) => batch.commit ?? batch.label).map(
            ({ key, item: batch }) => {
              const sha = shortSha(batch.commit);
              return (
                <PluginCardStep
                  key={key}
                  state={batch.state}
                  label={batch.label}
                  trailing={
                    sha === null ? undefined : (
                      <>
                        {batch.state === "pending" ? "not pushed " : null}
                        <span className="font-mono">{sha}</span>
                      </>
                    )
                  }
                />
              );
            },
          )}
          {data.mergeRequest === null ? null : (
            <MergeRequestRow mergeRequest={data.mergeRequest} onOpen={openUrl} />
          )}
        </div>
      )}
    </PluginCardShell>
  );
}

function MergeRequestRow({
  mergeRequest,
  onOpen,
}: {
  mergeRequest: NonNullable<GittyPushCardData["mergeRequest"]>;
  onOpen: (url: string) => void;
}) {
  const number = mergeRequestLabel(mergeRequest);
  const pipeline = pipelineLabel(mergeRequest.pipeline);
  const url = mergeRequest.url;
  const display = mergeRequest.pipeline === "none" ? null : PIPELINE_DISPLAY[mergeRequest.pipeline];
  const reference =
    number ?? (url === null ? null : mergeRequest.draft ? "Draft" : "Merge request");
  const StateGlyph = mergeRequest.draft ? PullRequestGlyph.draft : PullRequestGlyph.pullRequest;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/60 pt-2.5 text-xs">
      {reference === null ? null : (
        <>
          <StateGlyph aria-hidden className="size-3.5 text-muted-foreground" />
          {mergeRequest.draft && number !== null ? (
            <span className="text-foreground/80">Draft</span>
          ) : null}
          {url === null ? (
            <span className="text-foreground/80">{reference}</span>
          ) : (
            <InlineButton tone="muted" onClick={() => onOpen(url)}>
              {reference}
            </InlineButton>
          )}
        </>
      )}
      {mergeRequest.additions === null || mergeRequest.deletions === null ? null : (
        <DiffStatLabel
          additions={mergeRequest.additions}
          deletions={mergeRequest.deletions}
          layout="inline"
          className="text-xs"
        />
      )}
      {pipeline === null || display === null ? null : (
        <span className={cn("inline-flex items-center gap-1", display.tone)}>
          <display.Icon aria-hidden className="size-3" />
          {pipeline}
        </span>
      )}
    </div>
  );
}
