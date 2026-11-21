/** Only inline icons: a remote address is chosen by content the agent read and can carry data off the machine. */
function inlineFaviconUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl || rawUrl.length > 4096) return null;
  try {
    const url = new URL(rawUrl);
    return url.protocol === "data:" && url.pathname.startsWith("image/") ? url.href : null;
  } catch {
    return null;
  }
}

export function toolActivityFaviconUrl(
  icon: {
    readonly pageUrl: string;
    readonly faviconUrl?: string | undefined;
    readonly faviconUrlDark?: string | undefined;
  },
  appearance: "light" | "dark",
  _size = 32,
): string | null {
  if (appearance === "dark") {
    return inlineFaviconUrl(icon.faviconUrlDark) ?? inlineFaviconUrl(icon.faviconUrl);
  }
  return inlineFaviconUrl(icon.faviconUrl);
}
