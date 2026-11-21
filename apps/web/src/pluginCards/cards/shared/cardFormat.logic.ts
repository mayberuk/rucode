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

export function shortSha(sha: string | null): string | null {
  return sha === null ? null : sha.slice(0, 7);
}

export function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
