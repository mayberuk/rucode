import { describe, expect, it } from "@effect/vitest";

import type { DispatchInitiativeState } from "./initiativeState.ts";
import { planWaves, waveName } from "./initiativeWaves.ts";

const part = (wave: number, status: string) => ({
  id: `part-${wave}`,
  title: `Part ${wave}`,
  repo: "acme/app",
  zone: [],
  wave,
  status,
});

const plan = (numbers: ReadonlyArray<number>, parts: DispatchInitiativeState["parts"] = []) =>
  planWaves({
    initiative: { slug: "alpha", title: "Alpha", repos: [] },
    parts,
    waves: numbers.map((number) => ({ number, opened: false, closed: false, parts: [] })),
    progress: [],
    deliveries: [],
    closed: false,
  });

describe("planWaves", () => {
  it("keeps consecutive one-based ranks and uses the last wave when there are no parts", () => {
    const waves = plan([1, 2, 3, 4]);
    expect({ total: waves.total, current: waves.current }).toEqual({ total: 4, current: 4 });
    expect([1, 2, 3, 4].map(waves.displayOf)).toEqual([1, 2, 3, 4]);
  });

  it("ranks the distinct union of out-of-order wave and part numbers across gaps", () => {
    const waves = plan([7, 1, 7], [part(3, "specced"), part(7, "planned")]);
    expect({ total: waves.total, current: waves.current }).toEqual({ total: 3, current: 2 });
    expect([1, 3, 7].map(waves.displayOf)).toEqual([1, 2, 3]);
  });

  it("counts a wave known only from a part", () => {
    const waves = plan([], [part(0, "planned")]);
    expect({ total: waves.total, current: waves.current }).toEqual({ total: 1, current: 1 });
    expect(waves.displayOf(0)).toBe(1);
  });

  it("treats an unrecognized ledger status as unsettled", () => {
    const waves = plan([1, 2], [part(1, "custom"), part(2, "merged")]);
    expect(waves.current).toBe(1);
  });

  it("sorts negative numbers numerically and returns insertion ranks for unknown waves", () => {
    const waves = plan([12, -1, 3]);
    expect([-2, -1, 0, 3, 4, 12, 13].map(waves.displayOf)).toEqual([1, 1, 2, 2, 3, 3, 4]);
    expect(plan([]).displayOf(0)).toBe(1);
  });
});

describe("waveName", () => {
  it.each([
    { title: "Checkout retries: design", name: "Checkout retries" },
    { title: "  Checkout retries — design (proposal)", name: "Checkout retries" },
    { title: "Checkout retries (proposal): design", name: "Checkout retries" },
    { title: "Checkout retries; design: proposal", name: "Checkout retries" },
    { title: "  Checkout—retries(v2)  ", name: "Checkout—retries(v2)" },
    { title: "", name: "" },
  ])("takes the trimmed lead phrase of '$title'", ({ title, name }) => {
    expect(waveName([title])).toEqual({ name, moreParts: 0 });
  });

  it.each([
    {
      title: "Improve checkout retries across multiple regions",
      name: "Improve checkout retries across multiple regions",
    },
    {
      title: "Improve checkout retries across multiple regions after an outage",
      name: "Improve checkout retries across multiple…",
    },
    {
      title: "Region failover for the checkout retry pipeline now",
      name: "Region failover for the checkout retry pipeline…",
    },
    { title: "a".repeat(49), name: `${"a".repeat(47)}…` },
    { title: "🌱".repeat(49), name: `${"🌱".repeat(47)}…` },
  ])("caps '$title' at 48 characters including any ellipsis", ({ title, name }) => {
    expect(waveName([title])).toEqual({ name, moreParts: 0 });
  });

  it.each([
    { titles: [], name: "", moreParts: 0 },
    { titles: ["Checkout: design", "Receipts; export"], name: "Checkout + Receipts", moreParts: 0 },
    {
      titles: ["Checkout: design", "Receipts; export", "Catalog", "Shipping"],
      name: "Checkout + Receipts",
      moreParts: 2,
    },
  ])("names at most two of $titles", ({ titles, name, moreParts }) => {
    expect(waveName(titles)).toEqual({ name, moreParts });
  });
});
