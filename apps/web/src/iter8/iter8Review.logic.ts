import type {
  DesktopPreviewReviewPin,
  Iter8CreateNoteInput,
  Iter8Note,
  Iter8Page,
  Iter8ReviewSnapshot,
  Iter8Round,
  Iter8Session,
  PreviewAnnotationPayload,
} from "@t3tools/contracts";
import { fileBasename } from "@t3tools/shared/path";

export interface Iter8PageMatch {
  readonly page: Iter8Page;
  readonly path: string;
}

export interface Iter8PathGroup {
  readonly path: string;
  readonly url: string;
  readonly notes: ReadonlyArray<Iter8NoteRow>;
}

export interface Iter8NoteRow {
  readonly note: Iter8Note;
  readonly label: string;
}

export type Iter8RoundStatus =
  | { kind: "none" }
  | { kind: "drafts"; count: number }
  | { kind: "sent"; roundId: string }
  | { kind: "resolved"; roundId: string }
  | { kind: "undelivered"; roundId: string };

export type Iter8SendAvailability =
  | { kind: "ready"; draftCount: number }
  | { kind: "blocked"; reason: "no-drafts" | "no-session" | "session-ended" };

export type Iter8SessionStatus = "working" | "running" | "ended" | "done";

export interface Iter8SessionRow {
  readonly session: Iter8Session;
  readonly project: string;
  readonly status: Iter8SessionStatus;
  readonly pages: ReadonlyArray<{
    page: Iter8Page;
    paths: ReadonlyArray<string>;
    noteCount: number;
  }>;
  readonly openCount: number;
  readonly round: Iter8RoundStatus;
}

export type Iter8BodySegment =
  | { kind: "text"; text: string }
  | { kind: "page"; url: string; path: string };

function parsePageUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function pagePath(url: URL): string {
  return (url.pathname || "/") + url.search;
}

export function matchIter8Page(
  snapshot: Iter8ReviewSnapshot,
  url: string | null,
): Iter8PageMatch | null {
  const parsed = url === null ? null : parsePageUrl(url);
  if (parsed === null) return null;

  const page = snapshot.pages.find((page) => page.origin === parsed.origin);
  return page === undefined ? null : { page, path: pagePath(parsed) };
}

function notePath(note: Iter8Note): string {
  return note.path ?? "/";
}

export function groupNotesByPath(page: Iter8Page): ReadonlyArray<Iter8PathGroup> {
  const groups = new Map<string, Iter8NoteRow[]>();
  for (const [index, note] of page.notes.entries()) {
    const path = notePath(note);
    const row = { note, label: String(index + 1) };
    const notes = groups.get(path);
    if (notes === undefined) {
      groups.set(path, [row]);
    } else {
      notes.push(row);
    }
  }
  return Array.from(groups, ([path, notes]) => ({ path, url: page.origin + path, notes }));
}

function isResolved(note: Iter8Note): boolean {
  return note.status === "done" || note.status === "answered";
}

function roundStatusForPages(pages: ReadonlyArray<Iter8Page>): Iter8RoundStatus {
  let draftCount = 0;
  let newest: { page: Iter8Page; round: Iter8Round; time: number } | undefined;

  for (const page of pages) {
    draftCount += page.notes.filter((note) => note.status === "draft").length;
    for (const round of page.rounds) {
      const timestamp = Date.parse(round.createdAt);
      const time = Number.isNaN(timestamp) ? -Infinity : timestamp;
      if (newest === undefined || time > newest.time) {
        newest = { page, round, time };
      }
    }
  }

  if (draftCount > 0) return { kind: "drafts", count: draftCount };
  if (newest === undefined) return { kind: "none" };

  const { page, round } = newest;
  if (round.stage === "orphaned") return { kind: "undelivered", roundId: round.id };
  if (
    round.stage === "claimed" &&
    page.notes.every((note) => note.roundId !== round.id || isResolved(note))
  ) {
    return { kind: "resolved", roundId: round.id };
  }
  return { kind: "sent", roundId: round.id };
}

export function roundStatus(page: Iter8Page): Iter8RoundStatus {
  return roundStatusForPages([page]);
}

export function sendAvailability(
  snapshot: Iter8ReviewSnapshot,
  page: Iter8Page,
): Iter8SendAvailability {
  const draftCount = page.notes.filter(
    (note) => note.status === "draft" && note.author.kind === "user",
  ).length;
  if (draftCount === 0) return { kind: "blocked", reason: "no-drafts" };
  if (page.ownerId === null) return { kind: "blocked", reason: "no-session" };

  const owner = snapshot.sessions.find((session) => session.ownerId === page.ownerId);
  if (owner === undefined || owner.state === "gone") {
    return { kind: "blocked", reason: "session-ended" };
  }
  return { kind: "ready", draftCount };
}

const sessionStatuses = {
  busy: "working",
  live: "running",
  gone: "ended",
} as const satisfies Record<Iter8Session["state"], Iter8SessionStatus>;

export function sessionRows(snapshot: Iter8ReviewSnapshot): ReadonlyArray<Iter8SessionRow> {
  const pagesById = new Map(snapshot.pages.map((page) => [page.id, page]));
  return snapshot.sessions.map((session) => {
    const pages = session.pageIds.flatMap((id) => {
      const page = pagesById.get(id);
      return page === undefined ? [] : [page];
    });
    const notes = pages.flatMap((page) => page.notes);
    const openCount = notes.filter((note) => !isResolved(note)).length;
    return {
      session,
      project: fileBasename(pages[0]?.projectRoot || session.cwd),
      status: notes.length > 0 && openCount === 0 ? "done" : sessionStatuses[session.state],
      pages: pages.map((page) => ({
        page,
        paths: [...new Set(["/", ...page.notes.map(notePath)])],
        noteCount: page.notes.length,
      })),
      openCount,
      round: roundStatusForPages(pages),
    };
  });
}

export function createNoteInput(
  page: Iter8Page,
  annotation: PreviewAnnotationPayload,
): Iter8CreateNoteInput | null {
  const { iter8, pageUrl } = annotation;
  const body = annotation.comment.trim();
  if (iter8 === undefined || body === "" || parsePageUrl(pageUrl)?.origin !== page.origin) {
    return null;
  }
  const { intent, anchor, viewport, theme } = iter8;
  return { pageId: page.id, intent, body, anchor, url: pageUrl, viewport, theme };
}

export function reviewPins(
  page: Iter8Page,
  path: string,
  focusNoteId: string | null,
): { pins: ReadonlyArray<DesktopPreviewReviewPin>; focusLabel: string | null } {
  const pins: DesktopPreviewReviewPin[] = [];
  let focusLabel: string | null = null;
  for (const [index, note] of page.notes.entries()) {
    if (notePath(note) !== path) continue;
    const label = String(index + 1);
    if (note.id === focusNoteId) focusLabel = label;
    if (note.selector.length > 0) {
      pins.push({ label, selector: note.selector, resolved: isResolved(note) });
    }
  }
  return { pins, focusLabel };
}

const openingDelimiters = new Map([
  [")", "("],
  ["]", "["],
  ["}", "{"],
]);

function trimLinkSuffix(candidate: string): string {
  const unmatchedClosers = new Map<string, number>();
  let end = candidate.length;
  while (end > 0) {
    const last = candidate.charAt(end - 1);
    if (!".,;!?".includes(last)) {
      const open = openingDelimiters.get(last);
      if (open === undefined) break;
      const unmatched =
        unmatchedClosers.get(last) ?? candidate.split(last).length - candidate.split(open).length;
      if (unmatched <= 0) break;
      unmatchedClosers.set(last, unmatched - 1);
    }
    end--;
  }
  return candidate.slice(0, end);
}

export function splitPageLinks(body: string, page: Iter8Page): ReadonlyArray<Iter8BodySegment> {
  const urlPattern = /(?<![\w+./:-])[a-z][a-z\d+.-]*:\/\/[^\s"'`<>]+/gi;
  const segments: Iter8BodySegment[] = [];
  let start = 0;
  for (const { 0: candidate, index } of body.matchAll(urlPattern)) {
    const url = trimLinkSuffix(candidate);
    const parsed = parsePageUrl(url);
    if (parsed?.protocol !== "http:" || parsed.origin !== page.origin) continue;

    if (index > start) segments.push({ kind: "text", text: body.slice(start, index) });
    segments.push({ kind: "page", url, path: pagePath(parsed) });
    start = index + url.length;
  }
  if (start < body.length) segments.push({ kind: "text", text: body.slice(start) });
  return segments;
}
