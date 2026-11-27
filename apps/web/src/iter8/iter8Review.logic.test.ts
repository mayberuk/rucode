import type {
  Iter8Note,
  Iter8Page,
  Iter8ReviewSnapshot,
  Iter8Round,
  Iter8Session,
  PreviewAnnotationPayload,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createNoteInput,
  groupNotesByPath,
  matchIter8Page,
  reviewPins,
  roundStatus,
  sendAvailability,
  sessionRows,
  splitPageLinks,
} from "./iter8Review.logic";

const origin = "http://pg1.localhost:4173";
const createdAt = "2026-01-01T00:00:00.000Z";
const agent = { kind: "agent", name: "Reviewer" } as const;

function page(overrides: Partial<Iter8Page> = {}): Iter8Page {
  return {
    id: "pg1",
    origin,
    projectRoot: "/work/checkout-flow",
    ownerId: "owner-1",
    rounds: [],
    notes: [],
    ...overrides,
  };
}

function note(id: string, overrides: Partial<Iter8Note> = {}): Iter8Note {
  return {
    id,
    pageId: "pg1",
    roundId: null,
    author: { kind: "user" },
    intent: "fix",
    body: "Align the heading",
    selector: [".title"],
    anchorLabel: "Heading",
    path: "/plans",
    status: "draft",
    reply: null,
    createdAt,
    ...overrides,
  };
}

function round(
  id: string,
  stage: Iter8Round["stage"],
  overrides: Partial<Iter8Round> = {},
): Iter8Round {
  return { id, stage, pageId: "pg1", noteCount: 0, createdAt, ...overrides };
}

function session(overrides: Partial<Iter8Session> = {}): Iter8Session {
  return {
    ownerId: "owner-1",
    agent: "agent",
    label: "Checkout",
    cwd: "/work/session-checkout",
    state: "live",
    pageIds: ["pg1"],
    ...overrides,
  };
}

function snapshot(
  pages: ReadonlyArray<Iter8Page> = [],
  sessions: ReadonlyArray<Iter8Session> = [],
): Iter8ReviewSnapshot {
  return { available: true, pages, sessions };
}

function annotation(overrides: Partial<PreviewAnnotationPayload> = {}): PreviewAnnotationPayload {
  return {
    id: "annotation-1",
    pageUrl: `${origin}/confirm?step=2`,
    pageTitle: "Confirmation",
    comment: "  Is shipping included?\n",
    elements: [],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot: null,
    createdAt,
    ...overrides,
  };
}

const picked = {
  intent: "question",
  anchor: {
    selector: ["[data-action=confirm]", "button.confirm"],
    role: "button",
    name: "Confirm",
    text: "Confirm order",
    box: { x: 8, y: 12, width: 90, height: 32 },
  },
  viewport: { width: 960, height: 720, devicePixelRatio: 2 },
  theme: "dark",
} as const;

describe("matchIter8Page", () => {
  it("selects the matching page and keeps the query while omitting the fragment", () => {
    const current = page();
    const other = page({ id: "pg2", origin: "http://pg2.localhost:4173" });
    expect(matchIter8Page(snapshot([other, current]), `${origin}/confirm?step=2#summary`)).toEqual({
      page: current,
      path: "/confirm?step=2",
    });
  });

  it.each([
    ["implicit root", origin, "/"],
    ["query on the root", `${origin}?step=2`, "/?step=2"],
  ])("includes the %s", (_name, url, path) => {
    const current = page();
    expect(matchIter8Page(snapshot([current]), url)).toEqual({ page: current, path });
  });

  it.each([
    ["wrong scheme", "https://pg1.localhost:4173/plans"],
    ["blob scheme with the same embedded origin", `blob:${origin}/notes`],
    ["wrong page host", "http://pg2.localhost:4173/plans"],
    ["lookalike host", "http://pg1.localhost.example:4173/plans"],
    ["wrong port", "http://pg1.localhost:4174/plans"],
    ["missing port", "http://pg1.localhost/plans"],
    ["empty URL", ""],
    ["relative URL", "/plans"],
    ["invalid port", "http://pg1.localhost:65536/plans"],
    ["absent URL", null],
  ])("returns no page for a %s", (_name, url) => {
    expect(matchIter8Page(snapshot([page()]), url)).toBeNull();
  });

  it("returns no page for an empty snapshot", () => {
    expect(matchIter8Page(snapshot(), `${origin}/plans`)).toBeNull();
  });
});

describe("roundStatus", () => {
  it("counts every draft before considering an orphaned round", () => {
    expect(
      roundStatus(
        page({
          notes: [note("a"), note("b"), note("c", { status: "sent" })],
          rounds: [round("round-1", "orphaned")],
        }),
      ),
    ).toEqual({ kind: "drafts", count: 2 });
  });

  it("counts a single draft without a round", () => {
    expect(roundStatus(page({ notes: [note("a")] }))).toEqual({ kind: "drafts", count: 1 });
  });

  it("resolves the newest claimed round with both resolved statuses amid unrelated open notes", () => {
    expect(
      roundStatus(
        page({
          rounds: [
            round("round-1", "orphaned"),
            round("round-2", "claimed", { createdAt: "2026-01-02T00:00:00.000Z", noteCount: 2 }),
          ],
          notes: [
            note("a", { roundId: "round-2", status: "done" }),
            note("b", { roundId: "round-2", status: "answered" }),
            note("c", { roundId: "round-1", status: "sent" }),
          ],
        }),
      ),
    ).toEqual({ kind: "resolved", roundId: "round-2" });
  });

  it("reports the newest orphaned round as undelivered even with resolved notes", () => {
    expect(
      roundStatus(
        page({
          rounds: [
            round("round-2", "orphaned", {
              createdAt: "2026-01-02T00:00:00.000Z",
              noteCount: 1,
            }),
            round("round-1", "claimed"),
          ],
          notes: [note("a", { roundId: "round-2", status: "done" })],
        }),
      ),
    ).toEqual({ kind: "undelivered", roundId: "round-2" });
  });

  it("keeps a claimed round sent with even one unresolved note", () => {
    expect(
      roundStatus(
        page({
          rounds: [round("round-1", "claimed", { noteCount: 2 })],
          notes: [
            note("a", { roundId: "round-1", status: "done" }),
            note("b", { roundId: "round-1", status: "sent" }),
          ],
        }),
      ),
    ).toEqual({ kind: "sent", roundId: "round-1" });
  });

  it.each(["draft", "queued", "announced"] as const)(
    "keeps a %s round sent even if its notes are resolved",
    (stage) => {
      expect(
        roundStatus(
          page({
            rounds: [round("round-1", stage, { noteCount: 1 })],
            notes: [note("a", { roundId: "round-1", status: "answered" })],
          }),
        ),
      ).toEqual({ kind: "sent", roundId: "round-1" });
    },
  );

  it("resolves a claimed round with zero notes", () => {
    expect(roundStatus(page({ rounds: [round("round-1", "claimed")] }))).toEqual({
      kind: "resolved",
      roundId: "round-1",
    });
  });

  it("reports no round at all when there are only standalone resolved notes", () => {
    expect(roundStatus(page({ notes: [note("a", { status: "done" })] }))).toEqual({
      kind: "none",
    });
  });
});

describe("sendAvailability", () => {
  const draft = note("a");

  it("reports no drafts first when the page has no notes or owner", () => {
    expect(sendAvailability(snapshot(), page({ ownerId: null }))).toEqual({
      kind: "blocked",
      reason: "no-drafts",
    });
  });

  it("does not count agent drafts or sent user notes as sendable", () => {
    const current = page({
      notes: [note("a", { author: agent }), note("b", { status: "sent" })],
    });
    expect(sendAvailability(snapshot([current], [session()]), current)).toEqual({
      kind: "blocked",
      reason: "no-drafts",
    });
  });

  it("blocks an ownerless page even when a session lists it and it has drafts", () => {
    const current = page({ ownerId: null, notes: [draft] });
    expect(sendAvailability(snapshot([current], [session()]), current)).toEqual({
      kind: "blocked",
      reason: "no-session",
    });
  });

  it("treats a missing owner as ended even with another live session and drafts", () => {
    const current = page({ notes: [draft] });
    expect(
      sendAvailability(snapshot([current], [session({ ownerId: "owner-2" })]), current),
    ).toEqual({ kind: "blocked", reason: "session-ended" });
  });

  it("blocks a gone owner even with drafts", () => {
    const current = page({ notes: [draft] });
    expect(sendAvailability(snapshot([current], [session({ state: "gone" })]), current)).toEqual({
      kind: "blocked",
      reason: "session-ended",
    });
  });

  it.each(["live", "busy"] as const)("allows a %s owner to send only user drafts", (state) => {
    const current = page({
      notes: [draft, note("b"), note("c", { author: agent }), note("d", { status: "sent" })],
    });
    expect(sendAvailability(snapshot([current], [session({ state })]), current)).toEqual({
      kind: "ready",
      draftCount: 2,
    });
  });
});

describe("createNoteInput", () => {
  it("copies the iter8 data and original capture URL while trimming the comment", () => {
    expect(createNoteInput(page(), annotation({ iter8: picked }))).toEqual({
      pageId: "pg1",
      intent: "question",
      body: "Is shipping included?",
      url: "http://pg1.localhost:4173/confirm?step=2",
      anchor: {
        selector: ["[data-action=confirm]", "button.confirm"],
        role: "button",
        name: "Confirm",
        text: "Confirm order",
        box: { x: 8, y: 12, width: 90, height: 32 },
      },
      viewport: { width: 960, height: 720, devicePixelRatio: 2 },
      theme: "dark",
    });
  });

  it("retains a one-character note and a different intent and theme", () => {
    expect(
      createNoteInput(
        page(),
        annotation({ comment: " ? ", iter8: { ...picked, intent: "keep", theme: "light" } }),
      ),
    ).toMatchObject({ body: "?", intent: "keep", theme: "light" });
  });

  it("ignores a nonblank chat annotation without an iter8 payload", () => {
    expect(createNoteInput(page(), annotation())).toBeNull();
  });

  it.each(["", " \t\n "])("ignores a blank comment %j even with an iter8 payload", (comment) => {
    expect(createNoteInput(page(), annotation({ comment, iter8: picked }))).toBeNull();
  });

  it.each([
    ["a different page origin", "http://pg2.localhost:4173/confirm"],
    ["a different port", "http://pg1.localhost:4174/confirm"],
    ["a malformed URL", "not a URL"],
  ])("ignores a capture on %s with a valid comment and iter8 data", (_name, pageUrl) => {
    expect(createNoteInput(page(), annotation({ pageUrl, iter8: picked }))).toBeNull();
  });
});

describe("groupNotesByPath and reviewPins", () => {
  const first = note("a", {
    path: "/plans?trial=1",
    createdAt: "2026-01-02T00:00:00.000Z",
    selector: [".title", "h1"],
  });
  const second = note("b", { path: "/confirm", status: "done", selector: [".submit"] });
  const third = note("c", { path: "/plans?trial=1", selector: [] });
  const fourth = note("d", { path: null, status: "answered", selector: [".help"] });
  const fifth = note("e", { path: "/plans?trial=1", status: "sent" });
  const sixth = note("f", { path: "/", selector: [] });
  const current = page({ notes: [first, second, third, fourth, fifth, sixth] });

  it("keeps groups in first-occurrence order and labels in page order across paths and no selector", () => {
    expect(groupNotesByPath(current)).toEqual([
      {
        path: "/plans?trial=1",
        url: "http://pg1.localhost:4173/plans?trial=1",
        notes: [
          { note: first, label: "1" },
          { note: third, label: "3" },
          { note: fifth, label: "5" },
        ],
      },
      {
        path: "/confirm",
        url: "http://pg1.localhost:4173/confirm",
        notes: [{ note: second, label: "2" }],
      },
      {
        path: "/",
        url: "http://pg1.localhost:4173/",
        notes: [
          { note: fourth, label: "4" },
          { note: sixth, label: "6" },
        ],
      },
    ]);
  });

  it("returns no groups for an empty page", () => {
    expect(groupNotesByPath(page())).toEqual([]);
  });

  it("keeps page labels and selectors in path pins, skipping only the selectorless note", () => {
    const result = reviewPins(current, "/plans?trial=1", "e");
    expect(result).toEqual({
      pins: [
        { label: "1", selector: [".title", "h1"], resolved: false },
        { label: "5", selector: [".title"], resolved: false },
      ],
      focusLabel: "5",
    });
  });

  it("assigns a focus label even to a selectorless note on the current path", () => {
    expect(reviewPins(current, "/plans?trial=1", "c").focusLabel).toBe("3");
  });

  it("leaves focus unset when the requested note is missing from a populated path", () => {
    expect(reviewPins(current, "/plans?trial=1", "unknown").focusLabel).toBeNull();
  });

  it.each([
    { status: "done", path: "/confirm", label: "2", selector: ".submit", focusNoteId: "a" },
    { status: "answered", path: "/", label: "4", selector: ".help", focusNoteId: null },
  ])(
    "resolves a $status pin without focusing a note on another path or absent ID",
    ({ path, label, selector, focusNoteId }) => {
      expect(reviewPins(current, path, focusNoteId)).toEqual({
        pins: [{ label, selector: [selector], resolved: true }],
        focusLabel: null,
      });
    },
  );

  it.each([
    ["/plans", "a"],
    ["/plans?trial=2", "a"],
  ])("does not draw pins or focus on a different query at %s", (path, id) => {
    expect(reviewPins(current, path, id)).toEqual({ pins: [], focusLabel: null });
  });

  it("returns no pins or focus for an empty page", () => {
    expect(reviewPins(page(), "/", "a")).toEqual({ pins: [], focusLabel: null });
  });
});

describe("sessionRows", () => {
  it("keeps session and page order, ignores unknown pages and counts open notes across pages", () => {
    const first = page({
      notes: [
        note("a", { path: "/confirm", status: "done" }),
        note("b", { path: "/plans" }),
        note("c", { path: "/confirm", status: "answered" }),
      ],
    });
    const second = page({
      id: "pg2",
      origin: "http://pg2.localhost:4173",
      projectRoot: "/work/discounts/",
      notes: [
        note("d", { pageId: "pg2", path: null }),
        note("e", { pageId: "pg2", status: "sent" }),
      ],
    });
    const busy = session({ state: "busy", pageIds: ["pg2", "unknown", "pg1"] });
    const gone = session({ ownerId: "owner-2", state: "gone", pageIds: [] });
    expect(sessionRows(snapshot([first, second], [gone, busy]))).toEqual([
      {
        session: gone,
        project: "session-checkout",
        status: "ended",
        pages: [],
        openCount: 0,
        round: { kind: "none" },
      },
      {
        session: busy,
        project: "discounts",
        status: "working",
        pages: [
          { page: second, paths: ["/", "/plans"], noteCount: 2 },
          { page: first, paths: ["/", "/confirm", "/plans"], noteCount: 3 },
        ],
        openCount: 3,
        round: { kind: "drafts", count: 2 },
      },
    ]);
  });

  it("prefers done over ended when all notes are resolved and selects the newest round across pages", () => {
    const first = page({
      rounds: [round("round-1", "orphaned")],
      notes: [note("a", { roundId: "round-1", status: "done" })],
    });
    const second = page({
      id: "pg2",
      origin: "http://pg2.localhost:4173",
      rounds: [
        round("round-2", "claimed", {
          pageId: "pg2",
          createdAt: "2026-01-02T00:00:00.000Z",
          noteCount: 1,
        }),
      ],
      notes: [note("b", { pageId: "pg2", roundId: "round-2", status: "answered" })],
    });
    const owner = session({ state: "gone", pageIds: ["pg1", "pg2"] });
    expect(sessionRows(snapshot([first, second], [owner]))).toMatchObject([
      {
        project: "checkout-flow",
        status: "done",
        openCount: 0,
        round: { kind: "resolved", roundId: "round-2" },
      },
    ]);
  });

  it("keeps a live session running with a root path and an empty project falling back to cwd", () => {
    const current = page({ projectRoot: "" });
    const owner = session();
    expect(sessionRows(snapshot([current], [owner]))).toEqual([
      {
        session: owner,
        project: "session-checkout",
        status: "running",
        pages: [{ page: current, paths: ["/"], noteCount: 0 }],
        openCount: 0,
        round: { kind: "none" },
      },
    ]);
  });
});

describe("splitPageLinks", () => {
  it("retains all surrounding text and links repeated same-origin paths in body order", () => {
    expect(
      splitPageLinks(
        `Compare (${origin}/plans?trial=1#heading), ${origin}/confirm and ${origin}/confirm.`,
        page(),
      ),
    ).toEqual([
      { kind: "text", text: "Compare (" },
      {
        kind: "page",
        url: "http://pg1.localhost:4173/plans?trial=1#heading",
        path: "/plans?trial=1",
      },
      { kind: "text", text: "), " },
      { kind: "page", url: "http://pg1.localhost:4173/confirm", path: "/confirm" },
      { kind: "text", text: " and " },
      { kind: "page", url: "http://pg1.localhost:4173/confirm", path: "/confirm" },
      { kind: "text", text: "." },
    ]);
  });

  it("keeps other schemes, origins, unparsable candidates and relative paths in text", () => {
    const body =
      "https://pg1.localhost:4173/plans http://pg2.localhost:4173/plans http://pg1.localhost:4174/plans http://pg1.localhost:65536/plans /confirm";
    expect(splitPageLinks(body, page())).toEqual([{ kind: "text", text: body }]);
  });

  it("keeps an external URL intact when a page URL is embedded in its query", () => {
    const body = `https://example.test/?next=${origin}/confirm`;
    expect(splitPageLinks(body, page())).toEqual([{ kind: "text", text: body }]);
  });

  it("keeps balanced delimiters inside a URL and preserves mixed wrappers as text", () => {
    expect(splitPageLinks(`[(${origin}/plans(trial))]`, page())).toEqual([
      { kind: "text", text: "[(" },
      { kind: "page", url: "http://pg1.localhost:4173/plans(trial)", path: "/plans(trial)" },
      { kind: "text", text: ")]" },
    ]);
  });

  it("links a root URL without empty text segments", () => {
    expect(splitPageLinks(`${origin}/`, page())).toEqual([
      { kind: "page", url: "http://pg1.localhost:4173/", path: "/" },
    ]);
  });

  it("returns no segments for empty text", () => {
    expect(splitPageLinks("", page())).toEqual([]);
  });
});
