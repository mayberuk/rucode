import { type AssistantCitation, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ASSISTANT_CITATION_DRAFT_HIGHLIGHT,
  ASSISTANT_CITATION_HOT_HIGHLIGHT,
  createAssistantCitationHighlights,
} from "./assistantCitationHighlights";

interface FakeSource {
  readonly messageId: string;
  text: string;
  connected: boolean;
  readonly node: object;
}

interface FakeRange {
  readonly source: FakeSource;
  readonly text: string;
}

function citationFor(messageId: string, text: string, comment?: string): AssistantCitation {
  return {
    version: 1,
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    messageId: MessageId.make(messageId),
    text,
    start: 0,
    end: text.length,
    prefix: "",
    suffix: "",
    ...(comment === undefined ? {} : { comment }),
  };
}

function setup({ highlightApi = true }: { highlightApi?: boolean } = {}) {
  const sources: FakeSource[] = [];
  const highlights = new Map<string, { priority: number; ranges: Set<FakeRange> }>();
  let onMutations: ((targets: ReadonlyArray<unknown>) => void) | null = null;
  let observeCalls = 0;
  let findCalls = 0;
  let resolveCalls = 0;

  const registry = createAssistantCitationHighlights<FakeSource, FakeRange>({
    createHighlight: (name, priority) => {
      if (!highlightApi) return null;
      const ranges = new Set<FakeRange>();
      highlights.set(name, { priority, ranges });
      return {
        add: (range) => void ranges.add(range),
        delete: (range) => void ranges.delete(range),
        get size() {
          return ranges.size;
        },
      };
    },
    removeHighlight: (name) => void highlights.delete(name),
    findSource: (citation) => {
      findCalls += 1;
      return (
        sources.find((source) => source.connected && source.messageId === citation.messageId) ??
        null
      );
    },
    resolveRange: (source, citation) => {
      resolveCalls += 1;
      const first = source.text.indexOf(citation.text);
      if (first === -1 || source.text.indexOf(citation.text, first + 1) !== -1) return null;
      return { source, text: citation.text };
    },
    isAnchored: (source, range) => source.connected && range.source === source,
    contains: (source, node) => source.node === node,
    observe: (callback) => {
      observeCalls += 1;
      onMutations = callback;
      return () => {
        if (onMutations === callback) onMutations = null;
      };
    },
  });

  const mount = (messageId: string, text: string) => {
    const source: FakeSource = { messageId, text, connected: true, node: {} };
    sources.push(source);
    return source;
  };
  const ranges = (name: string) => [...(highlights.get(name)?.ranges ?? [])];

  return {
    registry,
    mount,
    draft: () => ranges(ASSISTANT_CITATION_DRAFT_HIGHLIGHT),
    hot: () => ranges(ASSISTANT_CITATION_HOT_HIGHLIGHT),
    priority: (name: string) => highlights.get(name)?.priority,
    registered: (name: string) => highlights.has(name),
    observing: () => onMutations !== null,
    mutate: (...targets: unknown[]) => {
      if (!onMutations) throw new Error("No observer is running");
      onMutations(targets);
    },
    counts: () => ({ observe: observeCalls, find: findCalls, resolve: resolveCalls }),
  };
}

describe("draft highlight lifetime", () => {
  it("paints a retained citation's passage below the comment highlight", () => {
    const host = setup();
    const source = host.mount("answer", "Answer 0 for thread-quote.");

    host.registry.retain(citationFor("answer", "Answer 0"));

    expect(host.draft()).toEqual([{ source, text: "Answer 0" }]);
    expect(host.priority(ASSISTANT_CITATION_DRAFT_HIGHLIGHT)).toBe(-1);
    expect(host.priority(ASSISTANT_CITATION_HOT_HIGHLIGHT)).toBe(2);
    expect(host.observing()).toBe(true);
  });

  it("shares one range between chips quoting the same passage with different comments", () => {
    const host = setup();
    host.mount("answer", "Answer 0 for thread-quote.");

    const releaseFirst = host.registry.retain(citationFor("answer", "Answer 0", "first note"));
    const [range] = host.draft();
    host.registry.retain(citationFor("answer", "Answer 0", "second note"));
    expect(host.draft()).toEqual([range]);
    expect(host.counts().resolve).toBe(1);

    releaseFirst();
    expect(host.draft()).toEqual([range]);
    expect(host.observing()).toBe(true);
  });

  it("keeps separate passages painted independently", () => {
    const host = setup();
    host.mount("answer", "Answer 0 for thread-quote.");

    const releaseAnswer = host.registry.retain(citationFor("answer", "Answer 0"));
    host.registry.retain(citationFor("answer", "thread-quote"));
    expect(host.draft().map((range) => range.text)).toEqual(["Answer 0", "thread-quote"]);

    releaseAnswer();
    expect(host.draft().map((range) => range.text)).toEqual(["thread-quote"]);
  });

  it("removes both named highlights and stops observing after the final release", () => {
    const host = setup();
    host.mount("answer", "Answer 0 for thread-quote.");
    const citation = citationFor("answer", "Answer 0");

    const releaseFirst = host.registry.retain(citation);
    const releaseSecond = host.registry.retain({ ...citation, comment: "note" });
    host.registry.setHot(citation);
    releaseFirst();
    releaseSecond();

    expect(host.registered(ASSISTANT_CITATION_DRAFT_HIGHLIGHT)).toBe(false);
    expect(host.registered(ASSISTANT_CITATION_HOT_HIGHLIGHT)).toBe(false);
    expect(host.observing()).toBe(false);
  });

  it("ignores a second call to the same release", () => {
    const host = setup();
    host.mount("answer", "Answer 0 for thread-quote.");
    const citation = citationFor("answer", "Answer 0");

    const releaseFirst = host.registry.retain(citation);
    host.registry.retain(citation);
    releaseFirst();
    releaseFirst();

    expect(host.draft()).toHaveLength(1);
    expect(host.observing()).toBe(true);
  });

  it("starts a fresh session after the last chip leaves and another arrives", () => {
    const host = setup();
    host.mount("answer", "Answer 0 for thread-quote.");
    const citation = citationFor("answer", "Answer 0");

    host.registry.retain(citation)();
    host.registry.retain(citation);

    expect(host.draft()).toHaveLength(1);
    expect(host.observing()).toBe(true);
    expect(host.counts().observe).toBe(2);
  });
});

describe("anchoring", () => {
  it("paints nothing for an unmounted source until a mutation batch finds it", () => {
    const host = setup();
    host.registry.retain(citationFor("answer", "Answer 0"));
    expect(host.draft()).toEqual([]);

    host.mutate();
    expect(host.draft()).toEqual([]);

    const source = host.mount("answer", "Answer 0 for thread-quote.");
    host.mutate({});
    expect(host.draft()).toEqual([{ source, text: "Answer 0" }]);
  });

  it("drops the range when its source leaves and re-anchors when the message remounts", () => {
    const host = setup();
    const first = host.mount("answer", "Answer 0 for thread-quote.");
    host.registry.retain(citationFor("answer", "Answer 0"));

    first.connected = false;
    host.mutate({});
    expect(host.draft()).toEqual([]);

    const remounted = host.mount("answer", "Answer 0 for thread-quote.");
    host.mutate({});
    expect(host.draft()).toEqual([{ source: remounted, text: "Answer 0" }]);
  });

  it("re-resolves when a mutation lands inside the source, and only then", () => {
    const host = setup();
    const source = host.mount("answer", "Answer 0 for thread-quote.");
    host.registry.retain(citationFor("answer", "Answer 0"));
    const [before] = host.draft();

    host.mutate({});
    expect(host.draft()[0]).toBe(before);
    expect(host.counts().resolve).toBe(1);

    host.mutate(source.node);
    expect(host.counts().resolve).toBe(2);
    expect(host.draft()).toHaveLength(1);
    expect(host.draft()[0]).not.toBe(before);
    expect(host.draft()[0]).toEqual({ source, text: "Answer 0" });
  });

  it("drops the range when an edit inside the source makes the quote ambiguous", () => {
    const host = setup();
    const source = host.mount("answer", "Answer 0 for thread-quote.");
    host.registry.retain(citationFor("answer", "Answer 0"));

    source.text = "Answer 0 for thread-quote. Answer 0 again.";
    host.mutate(source.node);

    expect(host.draft()).toEqual([]);
  });

  it("paints nothing for a quote that matches twice, without re-reading an unchanged source", () => {
    const host = setup();
    const source = host.mount("answer", "Answer 0, then Answer 0 again.");
    const release = host.registry.retain(citationFor("answer", "Answer 0"));
    expect(host.draft()).toEqual([]);

    host.mutate({});
    expect(host.counts().resolve).toBe(1);

    source.text = "Answer 0 only once.";
    host.mutate(source.node);
    expect(host.draft()).toEqual([{ source, text: "Answer 0" }]);

    expect(release).not.toThrow();
  });
});

describe("hot highlight", () => {
  it("paints only the hovered retained passage, and clears on null", () => {
    const host = setup();
    const source = host.mount("answer", "Answer 0 for thread-quote.");
    host.registry.retain(citationFor("answer", "Answer 0", "a note"));
    host.registry.retain(citationFor("answer", "thread-quote"));

    host.registry.setHot(citationFor("answer", "Answer 0"));
    expect(host.hot()).toEqual([{ source, text: "Answer 0" }]);

    host.registry.setHot(citationFor("answer", "thread-quote"));
    expect(host.hot()).toEqual([{ source, text: "thread-quote" }]);

    host.registry.setHot(null);
    expect(host.hot()).toEqual([]);
    expect(host.draft()).toHaveLength(2);
  });

  it("ignores a citation that no chip retains", () => {
    const host = setup();
    host.mount("answer", "Answer 0 for thread-quote.");
    host.registry.retain(citationFor("answer", "Answer 0"));
    host.registry.setHot(citationFor("answer", "Answer 0"));

    host.registry.setHot(citationFor("answer", "thread-quote"));

    expect(host.hot()).toEqual([]);
  });

  it("clears when the hovered citation is released", () => {
    const host = setup();
    host.mount("answer", "Answer 0 for thread-quote.");
    const release = host.registry.retain(citationFor("answer", "Answer 0"));
    host.registry.retain(citationFor("answer", "thread-quote"));
    host.registry.setHot(citationFor("answer", "Answer 0"));

    release();

    expect(host.hot()).toEqual([]);
    expect(host.registered(ASSISTANT_CITATION_HOT_HIGHLIGHT)).toBe(true);
  });

  it("follows its passage when the source remounts", () => {
    const host = setup();
    const first = host.mount("answer", "Answer 0 for thread-quote.");
    host.registry.retain(citationFor("answer", "Answer 0"));
    host.registry.setHot(citationFor("answer", "Answer 0"));

    first.connected = false;
    host.mutate({});
    expect(host.hot()).toEqual([]);

    const remounted = host.mount("answer", "Answer 0 for thread-quote.");
    host.mutate({});
    expect(host.hot()).toEqual([{ source: remounted, text: "Answer 0" }]);
  });
});

describe("without the Highlight API", () => {
  it("accepts every call and does no DOM work", () => {
    const host = setup({ highlightApi: false });
    host.mount("answer", "Answer 0 for thread-quote.");
    const citation = citationFor("answer", "Answer 0");

    const release = host.registry.retain(citation);
    host.registry.setHot(citation);
    host.registry.setHot(null);
    release();
    release();

    expect(host.counts()).toEqual({ observe: 0, find: 0, resolve: 0 });
    expect(host.registered(ASSISTANT_CITATION_DRAFT_HIGHLIGHT)).toBe(false);
  });
});
