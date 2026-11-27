import { useGT } from "gt-react";
import {
  ChevronDownIcon,
  ExternalLinkIcon,
  FileIcon,
  MessageSquarePlusIcon,
  SendIcon,
} from "lucide-react";
import { type KeyboardEvent, useId } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

export function Iter8ReviewBar({
  path,
  paths,
  roundLabel,
  notice,
  sendTooltip,
  sendDisabled,
  sending,
  picking,
  addNoteDisabled,
  onAddNote,
  onOpenExternally,
  onSelectPath,
  onSend,
  onKeyDown,
}: {
  path: string;
  paths: ReadonlyArray<string>;
  roundLabel: string | null;
  /** Why Send is unavailable, shown in place of the round status. */
  notice: string | null;
  sendTooltip: string;
  sendDisabled: boolean;
  sending: boolean;
  picking: boolean;
  addNoteDisabled: boolean;
  /** Null when this browser cannot pick elements, so the page opens in a normal tab instead. */
  onAddNote: (() => void) | null;
  onOpenExternally: () => void;
  onSelectPath: (path: string) => void;
  onSend: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
}) {
  const gt = useGT();
  const noticeId = useId();
  const status = notice ?? roundLabel;
  return (
    <div
      role="toolbar"
      aria-label={gt("iter8 review")}
      className="flex h-8 shrink-0 items-center gap-1 px-2"
      onKeyDown={onKeyDown}
    >
      {onAddNote ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                variant="ghost"
                aria-pressed={picking}
                data-pressed={picking ? "" : undefined}
                disabled={addNoteDisabled}
                onClick={onAddNote}
              />
            }
          >
            <MessageSquarePlusIcon />
            {gt("Add note")}
          </TooltipTrigger>
          <TooltipPopup>
            {picking ? gt("Stop adding notes (Esc)") : gt("Pin a note on an element (N)")}
          </TooltipPopup>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger render={<Button size="xs" variant="ghost" onClick={onOpenExternally} />}>
            <ExternalLinkIcon />
            {gt("Open in new tab")}
          </TooltipTrigger>
          <TooltipPopup>{gt("Add notes with iter8 in a normal browser tab")}</TooltipPopup>
        </Tooltip>
      )}
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="xs"
              variant="ghost"
              aria-label={gt("Page: {path}", { path })}
              className="min-w-0"
            />
          }
        >
          <FileIcon />
          <span className="max-w-40 truncate">{path}</span>
          <ChevronDownIcon className="size-3.5 opacity-70" />
        </MenuTrigger>
        <MenuPopup align="start">
          {paths.map((item) => (
            <MenuItem key={item} onClick={() => onSelectPath(item)}>
              <FileIcon />
              <span className="truncate">{item}</span>
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
      <span className="flex-1" />
      {status ? (
        <span id={noticeId} className="min-w-0 truncate text-xs text-muted-foreground tabular-nums">
          {status}
        </span>
      ) : null}
      <Tooltip>
        <TooltipTrigger render={<span className="ms-1 inline-flex shrink-0" />}>
          <Button
            size="xs"
            variant="default"
            disabled={sendDisabled || sending}
            aria-describedby={notice ? noticeId : undefined}
            onClick={onSend}
          >
            <SendIcon />
            {sending ? gt("Sending…") : gt("Send round")}
          </Button>
        </TooltipTrigger>
        <TooltipPopup>{sendTooltip}</TooltipPopup>
      </Tooltip>
    </div>
  );
}
