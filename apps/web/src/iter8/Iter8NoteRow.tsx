import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, Iter8Intent, Iter8Note, Iter8Page } from "@t3tools/contracts";
import { useGT } from "gt-react";
import {
  CircleCheckIcon,
  CornerDownRightIcon,
  LinkIcon,
  PencilIcon,
  SendIcon,
  Trash2Icon,
} from "lucide-react";
import { type KeyboardEvent, useState } from "react";

import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { deleteIter8Note, updateIter8Note } from "~/rpc/iter8";
import { useAtomCommand } from "~/state/use-atom-command";
import { type Iter8BodySegment, splitPageLinks } from "./iter8Review.logic";

const INTENTS = ["fix", "change", "question", "keep"] as const satisfies ReadonlyArray<Iter8Intent>;

function isIntent(value: unknown): value is Iter8Intent {
  return INTENTS.some((intent) => intent === value);
}

function useIntentLabel() {
  const gt = useGT();
  return (intent: Iter8Intent) =>
    intent === "fix"
      ? gt("Fix")
      : intent === "change"
        ? gt("Change")
        : intent === "question"
          ? gt("Question")
          : gt("Keep");
}

function NoteStatus({ note }: { note: Iter8Note }) {
  const gt = useGT();
  if (note.status === "draft") return <span className="text-muted-foreground">{gt("Draft")}</span>;
  if (note.status === "sent") {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <SendIcon aria-hidden className="size-3" />
        {gt("Sent")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 font-medium text-success-foreground">
      <CircleCheckIcon aria-hidden className="size-3.5" />
      {note.status === "answered" ? gt("Answered") : gt("Resolved")}
    </span>
  );
}

function segmentLength(segment: Iter8BodySegment): number {
  return segment.kind === "text" ? segment.text.length : segment.url.length;
}

function NoteBody({
  body,
  page,
  onNavigate,
}: {
  body: string;
  page: Iter8Page;
  onNavigate: (url: string) => void;
}) {
  const segments: Array<{ start: number; segment: Iter8BodySegment }> = [];
  for (const segment of splitPageLinks(body, page)) {
    const previous = segments.at(-1);
    const start = previous === undefined ? 0 : previous.start + segmentLength(previous.segment);
    segments.push({ start, segment });
  }
  return (
    <span className="ps-5.5 text-sm leading-5 text-foreground/75 wrap-anywhere">
      {segments.map(({ start, segment }) =>
        segment.kind === "text" ? (
          <span key={`text:${start}`}>{segment.text}</span>
        ) : (
          <a
            key={`page:${start}`}
            href={segment.url}
            className="inline-flex items-center gap-1 rounded-sm bg-foreground/10 px-1 align-baseline font-mono text-xs text-foreground outline-none transition-colors duration-150 ease-out hover:bg-foreground/16 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onNavigate(segment.url);
            }}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <LinkIcon aria-hidden className="size-3" />
            {segment.path}
          </a>
        ),
      )}
    </span>
  );
}

function NoteEditor({
  environmentId,
  note,
  onClose,
}: {
  environmentId: EnvironmentId;
  note: Iter8Note;
  onClose: () => void;
}) {
  const gt = useGT();
  const intentLabel = useIntentLabel();
  const update = useAtomCommand(updateIter8Note, { reportFailure: false });
  const [intent, setIntent] = useState<Iter8Intent>(note.intent);
  const [body, setBody] = useState(note.body);
  const [saving, setSaving] = useState(false);
  const trimmed = body.trim();

  const save = async () => {
    if (trimmed === "" || saving) return;
    setSaving(true);
    const result = await update({
      environmentId,
      input: { pageId: note.pageId, noteId: note.id, intent, body: trimmed },
    });
    setSaving(false);
    if (result._tag === "Success") {
      onClose();
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Couldn't save the note"),
        description: trimmed,
      });
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void save();
    }
  };

  return (
    <div
      className="flex flex-col gap-2 px-2 py-1.5"
      role="group"
      aria-label={gt("Edit note")}
      onKeyDown={onKeyDown}
    >
      <ToggleGroup
        aria-label={gt("Intent")}
        value={[intent]}
        onValueChange={(next) => {
          const value = next[0];
          if (isIntent(value)) setIntent(value);
        }}
      >
        {INTENTS.map((value) => (
          <Toggle key={value} value={value}>
            {intentLabel(value)}
          </Toggle>
        ))}
      </ToggleGroup>
      <Textarea
        aria-label={gt("Note")}
        size="sm"
        value={body}
        autoFocus
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="flex justify-end gap-1">
        <Button size="xs" variant="ghost" onClick={onClose}>
          {gt("Cancel")}
        </Button>
        <Button size="xs" variant="default" disabled={trimmed === "" || saving} onClick={save}>
          {gt("Save")}
        </Button>
      </div>
    </div>
  );
}

export function Iter8NoteRow({
  environmentId,
  note,
  label,
  page,
  selected,
  canUpdate,
  canDelete,
  onSelect,
  onNavigate,
}: {
  environmentId: EnvironmentId;
  note: Iter8Note;
  label: string;
  page: Iter8Page;
  selected: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  onSelect: () => void;
  onNavigate: (url: string) => void;
}) {
  const gt = useGT();
  const intentLabel = useIntentLabel();
  const remove = useAtomCommand(deleteIter8Note, { reportFailure: false });
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const isDraft = note.status === "draft" && note.author.kind === "user";
  const resolved = note.status === "done" || note.status === "answered";

  if (editing && isDraft) {
    return (
      <NoteEditor environmentId={environmentId} note={note} onClose={() => setEditing(false)} />
    );
  }

  const deleteNote = async () => {
    setDeleting(true);
    const result = await remove({
      environmentId,
      input: { pageId: note.pageId, noteId: note.id },
    });
    setDeleting(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Couldn't delete the note"),
        description: note.body,
      });
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "group/note relative flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <span className="flex h-5 min-w-0 items-center gap-1.5 text-xs">
        <span
          className={cn(
            "inline-flex size-4 shrink-0 items-center justify-center rounded-full text-3xs font-semibold tabular-nums",
            resolved
              ? "bg-success/8 text-success-foreground dark:bg-success/16"
              : "bg-primary text-primary-foreground",
          )}
        >
          {label}
        </span>
        <span className="shrink-0 font-medium text-foreground/80">{intentLabel(note.intent)}</span>
        {note.anchorLabel ? (
          <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground">
            {note.anchorLabel}
          </span>
        ) : null}
        <span className="ms-auto flex shrink-0 items-center gap-1">
          {isDraft && (canUpdate || canDelete) ? (
            <span className="flex items-center opacity-0 transition-opacity duration-150 ease-out group-hover/note:opacity-100 group-focus-within/note:opacity-100 pointer-coarse:opacity-100">
              {canUpdate ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-micro"
                        variant="ghost-muted"
                        aria-label={gt("Edit note")}
                        onClick={(event) => {
                          event.stopPropagation();
                          setEditing(true);
                        }}
                      />
                    }
                  >
                    <PencilIcon />
                  </TooltipTrigger>
                  <TooltipPopup>{gt("Edit note")}</TooltipPopup>
                </Tooltip>
              ) : null}
              {canDelete ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-micro"
                        variant="ghost-destructive"
                        aria-label={gt("Delete note")}
                        disabled={deleting}
                        onClick={(event) => {
                          event.stopPropagation();
                          void deleteNote();
                        }}
                      />
                    }
                  >
                    <Trash2Icon />
                  </TooltipTrigger>
                  <TooltipPopup>{gt("Delete note")}</TooltipPopup>
                </Tooltip>
              ) : null}
            </span>
          ) : null}
          <NoteStatus note={note} />
        </span>
      </span>
      <NoteBody body={note.body} page={page} onNavigate={onNavigate} />
      {note.reply ? (
        <span className="flex min-w-0 items-start gap-1.5 ps-5.5 text-xs leading-4 text-muted-foreground">
          <CornerDownRightIcon aria-hidden className="mt-px size-3.5 shrink-0" />
          <span>{note.reply}</span>
        </span>
      ) : null}
    </div>
  );
}
