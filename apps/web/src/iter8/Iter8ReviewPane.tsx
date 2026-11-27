import type { EnvironmentId, Iter8Note, Iter8ReviewSnapshot } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { FileIcon } from "lucide-react";
import type { KeyboardEvent } from "react";

import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";
import { Iter8NoteRow } from "./Iter8NoteRow";
import { Iter8SessionList } from "./Iter8SessionList";
import { groupNotesByPath, type Iter8PageMatch } from "./iter8Review.logic";

export type Iter8PaneView = "notes" | "sessions";

function NotesList({
  environmentId,
  match,
  canAddNotes,
  canUpdate,
  canDelete,
  focusedNoteId,
  onSelectNote,
  onNavigate,
}: {
  environmentId: EnvironmentId;
  match: Iter8PageMatch;
  canAddNotes: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  focusedNoteId: string | null;
  onSelectNote: (note: Iter8Note) => void;
  onNavigate: (url: string) => void;
}) {
  const gt = useGT();
  const { page, path } = match;
  if (page.notes.length === 0) {
    return (
      <p className="px-2 py-3 text-sm text-muted-foreground">
        {canAddNotes
          ? gt("No notes yet. Use Add note to pin one on the page.")
          : gt("No notes yet. Open the page in a new tab to add notes with iter8.")}
      </p>
    );
  }
  return groupNotesByPath(page).map((group) => {
    const current = group.path === path;
    return (
      <div key={group.path} className="flex flex-col gap-px pb-1">
        <button
          type="button"
          aria-current={current ? "page" : undefined}
          className={cn(
            "flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            current ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => onNavigate(group.url)}
        >
          <FileIcon aria-hidden className="size-3.5 shrink-0 opacity-80" />
          <span className="min-w-0 flex-1 truncate">{group.path}</span>
          <span className="font-normal tabular-nums">{group.notes.length}</span>
        </button>
        {group.notes.map(({ note, label }) => (
          <Iter8NoteRow
            key={note.id}
            environmentId={environmentId}
            note={note}
            label={label}
            page={page}
            selected={note.id === focusedNoteId}
            canUpdate={canUpdate}
            canDelete={canDelete}
            onSelect={() => onSelectNote(note)}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    );
  });
}

export function Iter8ReviewPane({
  environmentId,
  snapshot,
  match,
  failed,
  view,
  canAddNotes,
  canUpdate,
  canDelete,
  focusedNoteId,
  onViewChange,
  onSelectNote,
  onNavigate,
  onRetry,
  onKeyDown,
}: {
  environmentId: EnvironmentId;
  snapshot: Iter8ReviewSnapshot | null;
  match: Iter8PageMatch | null;
  failed: boolean;
  view: Iter8PaneView;
  canAddNotes: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  focusedNoteId: string | null;
  onViewChange: (view: Iter8PaneView) => void;
  onSelectNote: (note: Iter8Note) => void;
  onNavigate: (url: string) => void;
  onRetry: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
}) {
  const gt = useGT();
  return (
    <section
      aria-label={gt("iter8 review")}
      className="flex h-70 shrink-0 flex-col border-t border-border"
      onKeyDown={onKeyDown}
    >
      {snapshot !== null && match !== null ? (
        <div className="flex h-10 shrink-0 items-center gap-2 px-2">
          <ToggleGroup
            aria-label={gt("Review list")}
            value={[view]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === "notes" || value === "sessions") onViewChange(value);
            }}
          >
            <Toggle value="notes">
              {gt("Notes")}
              <span className="tabular-nums opacity-70">{match.page.notes.length}</span>
            </Toggle>
            <Toggle value="sessions">
              {gt("Sessions")}
              <span className="tabular-nums opacity-70">{snapshot.sessions.length}</span>
            </Toggle>
          </ToggleGroup>
        </div>
      ) : null}
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-2 pb-2">
          {failed ? (
            <div className="flex flex-col items-start gap-2 px-2 py-3">
              <p className="text-sm text-muted-foreground">
                {gt("Couldn't read iter8's review state.")}
              </p>
              <Button size="xs" variant="outline" onClick={onRetry}>
                {gt("Retry")}
              </Button>
            </div>
          ) : snapshot === null || match === null ? null : view === "notes" ? (
            <NotesList
              environmentId={environmentId}
              match={match}
              canAddNotes={canAddNotes}
              canUpdate={canUpdate}
              canDelete={canDelete}
              focusedNoteId={focusedNoteId}
              onSelectNote={onSelectNote}
              onNavigate={onNavigate}
            />
          ) : (
            <Iter8SessionList
              snapshot={snapshot}
              currentUrl={match.page.origin + match.path}
              onNavigate={onNavigate}
            />
          )}
        </div>
      </ScrollArea>
    </section>
  );
}
