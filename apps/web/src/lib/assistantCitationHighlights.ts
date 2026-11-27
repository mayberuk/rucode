import type { AssistantCitation } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";

import { resolveAssistantCitationRange } from "./assistantTextSelection";

export const ASSISTANT_CITATION_DRAFT_HIGHLIGHT = "t3-assistant-citation-draft";
export const ASSISTANT_CITATION_HOT_HIGHLIGHT = "t3-assistant-citation-hot";

// The comment editor's highlight keeps the default priority 0, so it paints between these.
const DRAFT_PRIORITY = -1;
const HOT_PRIORITY = 2;

interface HighlightLike<TRange> {
  add(range: TRange): void;
  delete(range: TRange): void;
  readonly size: number;
}

interface CitationHighlightHost<TSource, TRange> {
  /** Creates and registers a named highlight, or returns null without the Highlight API. */
  readonly createHighlight: (name: string, priority: number) => HighlightLike<TRange> | null;
  readonly removeHighlight: (name: string) => void;
  readonly findSource: (citation: AssistantCitation) => TSource | null;
  readonly resolveRange: (source: TSource, citation: AssistantCitation) => TRange | null;
  readonly isAnchored: (source: TSource, range: TRange) => boolean;
  readonly contains: (source: TSource, node: unknown) => boolean;
  readonly observe: (onMutations: (targets: ReadonlyArray<unknown>) => void) => () => void;
}

interface Entry<TSource, TRange> {
  readonly key: string;
  readonly citation: AssistantCitation;
  count: number;
  /** Kept without a range too, so an unresolvable quote is not re-read until its source changes. */
  source: TSource | null;
  range: TRange | null;
}

function quoteKey(citation: AssistantCitation): string {
  const { comment: _comment, ...quote } = citation;
  return serializeAssistantCitation(quote);
}

/** Paints the passages of retained citations, re-anchoring them as their messages remount. */
export function createAssistantCitationHighlights<TSource, TRange>(
  host: CitationHighlightHost<TSource, TRange>,
) {
  const entries = new Map<string, Entry<TSource, TRange>>();
  let draft: HighlightLike<TRange> | null = null;
  let hot: HighlightLike<TRange> | null = null;
  let hotKey: string | null = null;
  let hotRange: TRange | null = null;
  let stopObserving: (() => void) | null = null;

  const paintHot = () => {
    const next = hotKey === null ? null : (entries.get(hotKey)?.range ?? null);
    if (next === hotRange) return;
    if (hotRange !== null) hot?.delete(hotRange);
    hotRange = next;
    if (next !== null) hot?.add(next);
  };

  const setRange = (entry: Entry<TSource, TRange>, range: TRange | null) => {
    if (entry.range === range) return;
    if (entry.range !== null) draft?.delete(entry.range);
    entry.range = range;
    if (range !== null) draft?.add(range);
    if (hotKey === entry.key) paintHot();
  };

  const anchor = (entry: Entry<TSource, TRange>, source: TSource | null) => {
    entry.source = source;
    setRange(entry, source === null ? null : host.resolveRange(source, entry.citation));
  };

  const onMutations = (targets: ReadonlyArray<unknown>) => {
    for (const entry of entries.values()) {
      const { source, range } = entry;
      const touched = source !== null && targets.some((target) => host.contains(source, target));
      if (source !== null && range !== null && host.isAnchored(source, range)) {
        if (touched) anchor(entry, source);
        continue;
      }
      const found = host.findSource(entry.citation);
      if (found !== null && found === source && range === null && !touched) continue;
      anchor(entry, found);
    }
  };

  const start = () => {
    draft = host.createHighlight(ASSISTANT_CITATION_DRAFT_HIGHLIGHT, DRAFT_PRIORITY);
    if (draft === null) return;
    hot = host.createHighlight(ASSISTANT_CITATION_HOT_HIGHLIGHT, HOT_PRIORITY);
    stopObserving = host.observe(onMutations);
  };

  const stop = () => {
    stopObserving?.();
    stopObserving = null;
    if (draft !== null) host.removeHighlight(ASSISTANT_CITATION_DRAFT_HIGHLIGHT);
    if (hot !== null) host.removeHighlight(ASSISTANT_CITATION_HOT_HIGHLIGHT);
    draft = null;
    hot = null;
    hotKey = null;
    hotRange = null;
  };

  const release = (key: string) => {
    const entry = entries.get(key);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count > 0) return;
    entries.delete(key);
    if (entries.size === 0) {
      stop();
      return;
    }
    setRange(entry, null);
    if (hotKey === key) {
      hotKey = null;
      paintHot();
    }
  };

  return {
    retain(citation: AssistantCitation): () => void {
      const key = quoteKey(citation);
      let entry = entries.get(key);
      if (!entry) {
        if (entries.size === 0) start();
        entry = { key, citation, count: 0, source: null, range: null };
        entries.set(key, entry);
        if (draft !== null) anchor(entry, host.findSource(citation));
      }
      entry.count += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        release(key);
      };
    },
    setHot(citation: AssistantCitation | null): void {
      const key = citation === null ? null : quoteKey(citation);
      hotKey = key !== null && entries.has(key) ? key : null;
      paintHot();
    },
  };
}

function findSource(citation: AssistantCitation): HTMLElement | null {
  const selector = [
    `[data-assistant-citation-source="${CSS.escape(citation.messageId)}"]`,
    `[data-assistant-citation-environment="${CSS.escape(citation.environmentId)}"]`,
    `[data-assistant-citation-thread="${CSS.escape(citation.threadId)}"]`,
  ].join("");
  for (const source of document.querySelectorAll<HTMLElement>(selector)) {
    if (source.closest("[data-assistant-citation-viewport]")) return source;
  }
  return null;
}

function observeDocument(onMutations: (targets: ReadonlyArray<unknown>) => void): () => void {
  let targets = new Set<Node>();
  let frame: number | null = null;
  const flush = () => {
    frame = null;
    const batch = [...targets];
    targets = new Set();
    onMutations(batch);
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) targets.add(record.target);
    frame ??= requestAnimationFrame(flush);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  return () => {
    observer.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
}

/** The app's instance over `document` and `CSS.highlights`, with frame-coalesced mutations. */
export const assistantCitationHighlights = createAssistantCitationHighlights<HTMLElement, Range>({
  createHighlight: (name, priority) => {
    if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") {
      return null;
    }
    const highlight = new Highlight();
    highlight.priority = priority;
    CSS.highlights.set(name, highlight);
    return highlight;
  },
  removeHighlight: (name) => CSS.highlights.delete(name),
  findSource,
  resolveRange: resolveAssistantCitationRange,
  isAnchored: (source, range) =>
    source.isConnected &&
    !range.collapsed &&
    source.contains(range.startContainer) &&
    source.contains(range.endContainer),
  contains: (source, node) => node instanceof Node && source.contains(node),
  observe: observeDocument,
});
