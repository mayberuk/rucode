import type { Iter8ReviewSnapshot } from "@t3tools/contracts";
import { useGT } from "gt-react";
import {
  ActivityIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleStopIcon,
  FileIcon,
  FolderIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { type Iter8SessionStatus, sessionRows } from "./iter8Review.logic";
import { useIter8RoundLabel } from "./useIter8Review";

function SessionStatus({ status }: { status: Iter8SessionStatus }) {
  const gt = useGT();
  if (status === "done") {
    return (
      <span className="inline-flex items-center gap-1 font-medium text-success-foreground">
        <CircleCheckIcon aria-hidden className="size-3.5" />
        {gt("Done")}
      </span>
    );
  }
  const Icon =
    status === "working" ? ActivityIcon : status === "running" ? CircleDotIcon : CircleStopIcon;
  return (
    <span className="inline-flex items-center gap-1 font-medium text-muted-foreground">
      <Icon aria-hidden className="size-3.5" />
      {status === "working" ? gt("Working") : status === "running" ? gt("Running") : gt("Ended")}
    </span>
  );
}

export function Iter8SessionList({
  snapshot,
  currentUrl,
  onNavigate,
}: {
  snapshot: Iter8ReviewSnapshot;
  currentUrl: string;
  onNavigate: (url: string) => void;
}) {
  const gt = useGT();
  const roundLabel = useIter8RoundLabel();
  const rows = sessionRows(snapshot);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        rows
          .filter((row) => row.pages.some(({ page }) => currentUrl.startsWith(page.origin + "/")))
          .map((row) => row.session.ownerId),
      ),
  );

  if (rows.length === 0) {
    return <p className="px-2 py-3 text-sm text-muted-foreground">{gt("No iter8 sessions.")}</p>;
  }

  const toggle = (ownerId: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (!next.delete(ownerId)) next.add(ownerId);
      return next;
    });

  return rows.map((row) => {
    const isExpanded = expanded.has(row.session.ownerId);
    const pathCount = row.pages.reduce((total, page) => total + page.paths.length, 0);
    const active = row.pages.some(({ page }) => currentUrl.startsWith(page.origin + "/"));
    const round = roundLabel(
      row.pages.map(({ page }) => page),
      row.round,
    );
    const meta = [
      gt("{count, plural, one {# page} other {# pages}}", { count: pathCount }),
      round,
      row.openCount > 0 ? gt("{count} open", { count: row.openCount }) : null,
    ]
      .filter((part) => part !== null)
      .join(" · ");
    return (
      <div key={row.session.ownerId} className="flex flex-col gap-px pb-1">
        <button
          type="button"
          aria-expanded={isExpanded}
          className="relative w-full cursor-pointer rounded-md px-2.5 py-2 text-left outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => toggle(row.session.ownerId)}
        >
          <span className="flex h-5 min-w-0 items-center gap-1.5">
            <FolderIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-xs text-secondary-label">
              {row.project}
            </span>
            <span className="flex shrink-0 items-center text-xs">
              <SessionStatus status={row.status} />
            </span>
          </span>
          <span className="mt-1 flex min-w-0 items-center gap-1.5">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm",
                active ? "font-medium text-foreground" : "text-foreground/75",
              )}
            >
              {row.session.label}
            </span>
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none",
                !isExpanded && "-rotate-90",
              )}
            />
          </span>
          <span className="mt-0.5 block truncate text-xs text-secondary-label">{meta}</span>
        </button>
        {isExpanded
          ? row.pages.flatMap(({ page, paths }) =>
              paths.map((path) => {
                const url = page.origin + path;
                const current = url === currentUrl;
                const count = page.notes.filter((note) => (note.path ?? "/") === path).length;
                return (
                  <button
                    key={url}
                    type="button"
                    aria-current={current ? "page" : undefined}
                    className={cn(
                      "flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md ps-8 pe-2.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      current
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                    )}
                    onClick={() => onNavigate(url)}
                  >
                    <FileIcon aria-hidden className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{path}</span>
                    {count > 0 ? (
                      <span className="text-xs tabular-nums text-secondary-label">
                        {gt("{count, plural, one {# note} other {# notes}}", { count })}
                      </span>
                    ) : null}
                  </button>
                );
              }),
            )
          : null}
      </div>
    );
  });
}
