import type { GittyPushCardData, Iter8RoundCardData } from "@t3tools/contracts";

import { countLabel } from "./shared/cardFormat.logic";

type Note = Iter8RoundCardData["notes"][number];
type MergeRequest = NonNullable<GittyPushCardData["mergeRequest"]>;
type Pipeline = MergeRequest["pipeline"];

export function noteMeta(note: Pick<Note, "id" | "author" | "anchor">): ReadonlyArray<string> {
  return [
    `Note ${note.id}`,
    ...(note.author ? [note.author] : []),
    ...(note.anchor ? [note.anchor] : []),
  ];
}

export function pageLabel(page: string, pagePath: string | null): string {
  if (pagePath !== null && pagePath !== "" && pagePath !== "/") return pagePath;
  try {
    return new URL(page).host;
  } catch {
    return page;
  }
}

export function isOpenablePage(page: string): boolean {
  return /^https?:\/\//i.test(page);
}

export function pageUrl(page: string, pagePath: string | null): string {
  const origin = page.replace(/\/+$/, "");
  if (pagePath === null || pagePath === "") return `${origin}/`;
  return pagePath.startsWith("/") ? `${origin}${pagePath}` : `${origin}/${pagePath}`;
}

export function pushSummary(card: Pick<GittyPushCardData, "batches">): {
  readonly done: number;
  readonly total: number;
  readonly verb: "Push" | "Pushing" | "Pushed";
  readonly label: string;
} {
  const total = card.batches.length;
  const done = card.batches.filter((batch) => batch.state === "done").length;
  const pushing = card.batches.some(
    (batch) => batch.state === "running" || batch.state === "pending",
  );
  return {
    done,
    total,
    verb: total === 0 ? "Push" : pushing ? "Pushing" : "Pushed",
    label:
      total === 0 ? "Nothing to push yet" : `${done} of ${countLabel(total, "batch", "batches")}`,
  };
}

/** Folder and file name of a path, so a long folder can be cut while the file name stays. */
export function splitPath(path: string): { readonly folder: string; readonly name: string } {
  const slash = path.lastIndexOf("/");
  return { folder: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

/** GitLab numbers merge requests with `!`, GitHub numbers pull requests with `#`. */
export function mergeRequestLabel(mr: Pick<MergeRequest, "url" | "number">): string | null {
  if (mr.number === null) return null;
  return `${mr.url?.includes("merge_requests") ? "!" : "#"}${mr.number}`;
}

export function pipelineLabel(state: Pipeline): string | null {
  switch (state) {
    case "none":
      return null;
    case "running":
      return "Pipeline running";
    case "passed":
      return "Pipeline passed";
    case "failed":
      return "Pipeline failed";
  }
}
