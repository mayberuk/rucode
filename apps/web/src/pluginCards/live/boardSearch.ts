export interface BoardSearch {
  readonly environmentId: string | undefined;
  readonly slug: string | undefined;
}

const bounded = (value: unknown): string | undefined => {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  return typeof text === "string" ? text.trim().slice(0, 200) || undefined : undefined;
};

export function boardSearchFromUrl(raw: Record<string, unknown>): BoardSearch {
  return {
    environmentId: bounded(raw.environmentId),
    slug: bounded(raw.slug),
  };
}
