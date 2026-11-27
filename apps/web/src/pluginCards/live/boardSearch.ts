import type { EnvironmentId } from "@t3tools/contracts";

export interface BoardSearch {
  readonly environmentId?: EnvironmentId;
  readonly slug?: string | undefined;
}

const bounded = (value: unknown): string | undefined => {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  return typeof text === "string" ? text.trim().slice(0, 200) || undefined : undefined;
};

export function boardSearchFromUrl(raw: Record<string, unknown>): BoardSearch {
  // environmentId is also a pull-requests search key typed without undefined, so adding undefined
  // to its type breaks that route's search consumers; the key is still returned explicitly so a
  // rejected raw value is overwritten in the router's search merge.
  return { environmentId: bounded(raw.environmentId), slug: bounded(raw.slug) } as BoardSearch;
}
