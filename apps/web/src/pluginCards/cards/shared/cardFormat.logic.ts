import type { PluginCardAction } from "@t3tools/contracts";

import { parseTimestampDate } from "~/timestampFormat";

export function cardAction(
  card: { readonly actions: ReadonlyArray<PluginCardAction> },
  actionId: string,
): PluginCardAction | null {
  return card.actions.find((action) => action.id === actionId) ?? null;
}

export function agoLabel(iso: string, nowMs: number): string {
  const date = parseTimestampDate(iso);
  if (date === null) return "";
  const seconds = Math.floor((nowMs - date.getTime()) / 1000);
  if (seconds < 1) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function agoLabelToMinute(iso: string, nowMs: number): string {
  const date = parseTimestampDate(iso);
  if (date !== null && nowMs - date.getTime() < 60_000) return "just now";
  return agoLabel(iso, nowMs);
}

/** Pairs each item with a key that stays unique when two items share an id: later repeats get `#n`. */
export function withUniqueKeys<A>(
  items: ReadonlyArray<A>,
  idOf: (item: A) => string,
): ReadonlyArray<{ readonly key: string; readonly item: A }> {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const id = idOf(item);
    const count = seen.get(id) ?? 0;
    seen.set(id, count + 1);
    return { key: count === 0 ? id : `${id}#${count}`, item };
  });
}

export function shortSha(sha: string | null): string | null {
  return sha === null ? null : sha.slice(0, 7);
}

export function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
