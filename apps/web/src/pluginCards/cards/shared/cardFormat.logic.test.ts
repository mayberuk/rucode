import { describe, expect, it } from "vite-plus/test";

import {
  agoLabel,
  agoLabelToMinute,
  cardAction,
  countLabel,
  shortSha,
  withUniqueKeys,
} from "./cardFormat.logic";

const NOW = Date.parse("2026-11-21T12:00:00.000Z");
const before = (ms: number) => new Date(NOW - ms).toISOString();

describe("agoLabel", () => {
  it.each([
    [999, "just now"],
    [1_000, "1s ago"],
    [4_000, "4s ago"],
    [59_000, "59s ago"],
    [59_999, "59s ago"],
    [60_000, "1m ago"],
    [3_599_000, "59m ago"],
    [3_600_000, "1h ago"],
    [86_399_000, "23h ago"],
    [86_400_000, "1d ago"],
    [5 * 86_400_000, "5d ago"],
    [-5_000, "just now"],
  ])("labels a time %i ms before now as %s", (elapsedMs, label) => {
    expect(agoLabel(before(elapsedMs), NOW)).toBe(label);
  });

  it("is empty for a time that does not parse", () => {
    expect(agoLabel("not a time", NOW)).toBe("");
  });
});

describe("agoLabelToMinute", () => {
  it.each([
    [999, "just now"],
    [37_000, "just now"],
    [59_999, "just now"],
    [60_000, "1m ago"],
    [125_000, "2m ago"],
    [3_600_000, "1h ago"],
    [-5_000, "just now"],
  ])("labels a time %i ms before now as %s", (elapsedMs, label) => {
    expect(agoLabelToMinute(before(elapsedMs), NOW)).toBe(label);
  });

  it("is empty for a time that does not parse", () => {
    expect(agoLabelToMinute("not a time", NOW)).toBe("");
  });
});

describe("withUniqueKeys", () => {
  it("keeps distinct ids and suffixes the repeats of an id", () => {
    const rows = withUniqueKeys(["a", "b", "a", "a"], (id) => id);
    expect(rows.map((row) => row.key)).toEqual(["a", "b", "a#1", "a#2"]);
    expect(rows.map((row) => row.item)).toEqual(["a", "b", "a", "a"]);
  });
});

describe("shortSha", () => {
  it("is null for a missing sha", () => {
    expect(shortSha(null)).toBeNull();
  });

  it("keeps the first 7 characters of a full sha", () => {
    expect(shortSha("0123456789abcdef0123456789abcdef01234567")).toBe("0123456");
  });

  it("keeps a sha shorter than 7 characters whole", () => {
    expect(shortSha("abc")).toBe("abc");
  });
});

describe("countLabel", () => {
  it.each([
    [0, "0 notes"],
    [1, "1 note"],
    [2, "2 notes"],
    [3, "3 notes"],
  ])("labels %i as %s", (count, label) => {
    expect(countLabel(count, "note", "notes")).toBe(label);
  });
});

describe("cardAction", () => {
  const card = {
    actions: [
      { id: "rerun", label: "Re-run", type: "message", message: "Re-run it." },
      { id: "resolve:N1", label: "Resolve", type: "command" },
    ],
  } as const;

  it("finds a message action by id", () => {
    expect(cardAction(card, "rerun")).toEqual(card.actions[0]);
  });

  it("finds a command action by its full id", () => {
    expect(cardAction(card, "resolve:N1")).toEqual(card.actions[1]);
  });

  it("is null when no action has the id", () => {
    expect(cardAction(card, "resolve:N2")).toBeNull();
  });

  it("is null for a card with no actions", () => {
    expect(cardAction({ actions: [] }, "rerun")).toBeNull();
  });
});
