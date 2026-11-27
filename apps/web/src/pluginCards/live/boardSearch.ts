import type { EnvironmentId } from "@t3tools/contracts";

export interface BoardSearch {
  readonly environmentId?: EnvironmentId;
  readonly slug?: string;
}

const bounded = (value: unknown): string | undefined => {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  return typeof text === "string" ? text.trim().slice(0, 200) || undefined : undefined;
};

export function boardSearchFromUrl(raw: Record<string, unknown>): BoardSearch {
  const environmentId = bounded(raw.environmentId);
  const slug = bounded(raw.slug);
  return {
    ...(environmentId !== undefined && { environmentId: environmentId as EnvironmentId }),
    ...(slug !== undefined && { slug }),
  };
}
