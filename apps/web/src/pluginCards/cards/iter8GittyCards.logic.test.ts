import { describe, expect, it } from "vite-plus/test";

import {
  isOpenablePage,
  mergeRequestLabel,
  noteMeta,
  pageLabel,
  pageUrl,
  pipelineLabel,
  pushSummary,
} from "./iter8GittyCards.logic";

describe("pageLabel", () => {
  it("shows the page path when one was captured", () => {
    expect(pageLabel("http://abc.localhost:4310", "/digest.html?tab=2")).toBe("/digest.html?tab=2");
  });

  it("falls back to the page host, port included, without a path", () => {
    expect(pageLabel("http://abc.localhost:4310", null)).toBe("abc.localhost:4310");
  });

  it("treats an empty or root path as no path", () => {
    expect(pageLabel("http://abc.localhost:4310", "")).toBe("abc.localhost:4310");
    expect(pageLabel("http://abc.localhost:4310", "/")).toBe("abc.localhost:4310");
  });

  it("returns an unparseable page as written", () => {
    expect(pageLabel("not a url", null)).toBe("not a url");
  });
});

describe("pageUrl and isOpenablePage", () => {
  it("joins the page origin and the captured path", () => {
    expect(pageUrl("http://abc.localhost:4310", "/digest.html?tab=2")).toBe(
      "http://abc.localhost:4310/digest.html?tab=2",
    );
  });

  it("opens the root when no path was captured", () => {
    expect(pageUrl("http://abc.localhost:4310", null)).toBe("http://abc.localhost:4310/");
  });

  it("does not double the slash between origin and path", () => {
    expect(pageUrl("http://abc.localhost:4310/", "/a")).toBe("http://abc.localhost:4310/a");
    expect(pageUrl("http://abc.localhost:4310", "a")).toBe("http://abc.localhost:4310/a");
  });

  it("accepts only http and https pages", () => {
    expect(isOpenablePage("http://abc.localhost:4310")).toBe(true);
    expect(isOpenablePage("https://example.com")).toBe(true);
    expect(isOpenablePage("file:///tmp/page.html")).toBe(false);
    expect(isOpenablePage("httpx://abc")).toBe(false);
    expect(isOpenablePage("")).toBe(false);
  });
});

describe("noteMeta", () => {
  it("lists the note id, author and anchor in that order", () => {
    expect(noteMeta({ id: "N7", author: "You", anchor: "Mark all read" })).toEqual([
      "Note N7",
      "You",
      "Mark all read",
    ]);
  });

  it("leaves out the anchor when there is none", () => {
    expect(noteMeta({ id: "N7", author: "You", anchor: null })).toEqual(["Note N7", "You"]);
  });

  it("leaves out a missing author and keeps the anchor", () => {
    expect(noteMeta({ id: "N8", author: null, anchor: "h1" })).toEqual(["Note N8", "h1"]);
    expect(noteMeta({ id: "N9", author: null, anchor: null })).toEqual(["Note N9"]);
  });
});

describe("pushSummary", () => {
  const batch = (state: "done" | "running" | "pending" | "failed" | "stale") => ({
    label: "batch",
    state,
    commit: null,
  });

  it("counts only done batches against all batches", () => {
    expect(
      pushSummary({ batches: [batch("done"), batch("done"), batch("running"), batch("pending")] }),
    ).toEqual({ done: 2, total: 4, label: "2 of 4 batches" });
  });

  it("reports zero of zero for no batches", () => {
    expect(pushSummary({ batches: [] })).toEqual({ done: 0, total: 0, label: "0 of 0 batches" });
  });

  it("uses the singular for one batch", () => {
    expect(pushSummary({ batches: [batch("done")] }).label).toBe("1 of 1 batch");
  });

  it("does not count failed or stale batches as done", () => {
    expect(pushSummary({ batches: [batch("failed"), batch("stale")] }).done).toBe(0);
  });
});

describe("mergeRequestLabel", () => {
  it("numbers a GitHub pull request with a hash", () => {
    expect(mergeRequestLabel({ url: "https://github.com/acme/app/pull/482", number: 482 })).toBe(
      "#482",
    );
  });

  it("numbers a GitLab merge request with a bang", () => {
    expect(
      mergeRequestLabel({
        url: "https://gitlab.com/acme/app/-/merge_requests/482",
        number: 482,
      }),
    ).toBe("!482");
  });

  it("has no label without a number", () => {
    expect(mergeRequestLabel({ url: "https://github.com/acme/app/pull/482", number: null })).toBe(
      null,
    );
  });

  it("uses a hash when the url is unknown", () => {
    expect(mergeRequestLabel({ url: null, number: 3 })).toBe("#3");
  });
});

describe("pipelineLabel", () => {
  it("has no label when there is no pipeline", () => {
    expect(pipelineLabel("none")).toBe(null);
  });

  it("names each pipeline state", () => {
    expect(pipelineLabel("running")).toBe("Pipeline running");
    expect(pipelineLabel("passed")).toBe("Pipeline passed");
    expect(pipelineLabel("failed")).toBe("Pipeline failed");
  });
});
