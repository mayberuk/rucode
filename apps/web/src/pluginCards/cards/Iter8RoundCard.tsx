import { PanelRightIcon } from "lucide-react";

import { useOpenLink } from "~/browser/useOpenLink";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { PluginCardShell } from "../core/PluginCardShell";
import type { PluginCardRendererProps } from "../core/types";
import { isOpenablePage, noteMeta, pageLabel, pageUrl } from "./iter8GittyCards.logic";
import { PluginCardActionButton } from "./shared/PluginCardActionButton";
import { countLabel } from "./shared/cardFormat.logic";

export function Iter8RoundCard({ card, threadRef }: PluginCardRendererProps<"iter8.round">) {
  const data = card.data;
  const openLink = useOpenLink(threadRef);

  const openPage = () => {
    openLink(pageUrl(data.page, data.pagePath)).catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Could not open the page",
        description: error instanceof Error ? error.message : undefined,
      });
    });
  };

  return (
    <div className="@container/iter8-round">
      <PluginCardShell
        label="Review round"
        title={
          <>
            <span>Round {data.round}</span>
            <span className="min-w-0 truncate font-normal text-muted-foreground">
              {countLabel(data.notes.length, "note", "notes")} on{" "}
              {pageLabel(data.page, data.pagePath)}
            </span>
          </>
        }
        actions={
          isOpenablePage(data.page) ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost-muted"
                    aria-label="Open page beside chat"
                    onClick={openPage}
                  />
                }
              >
                <PanelRightIcon className="size-3" />
                <span className="hidden @[28rem]/iter8-round:inline">Open page beside chat</span>
              </TooltipTrigger>
              <TooltipPopup side="top">Open page beside chat</TooltipPopup>
            </Tooltip>
          ) : null
        }
      >
        {data.notes.length === 0 ? null : (
          <ul className="px-3 pb-1">
            {data.notes.map((note) => {
              const open = note.state === "open";
              return (
                <li
                  key={note.id}
                  className="border-t border-border/60 py-2.5 first:border-t-0 first:pt-0.5"
                >
                  <p
                    className={cn("text-sm", open ? "text-foreground/85" : "text-muted-foreground")}
                  >
                    {note.text}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <span className="text-secondary-label">{noteMeta(note).join(" · ")}</span>
                    {open ? (
                      <>
                        <PluginCardActionButton
                          card={card}
                          actionId={`reply:${note.id}`}
                          threadRef={threadRef}
                        />
                        <PluginCardActionButton
                          card={card}
                          actionId={`resolve:${note.id}`}
                          threadRef={threadRef}
                        />
                      </>
                    ) : (
                      <span className="text-muted-foreground">Resolved</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </PluginCardShell>
    </div>
  );
}
