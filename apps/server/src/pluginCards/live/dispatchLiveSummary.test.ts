import { describe, expect, it } from "@effect/vitest";
import { type PluginLiveChild, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { DispatchInitiativeState } from "../dispatch/initiativeState.ts";
import type { DispatchLiveInitiative } from "../dispatch/liveRegistry.ts";
import type { DispatchRunFeedRow } from "../dispatch/runFeed.ts";
import {
  foldRunRows,
  isRegistryFileName,
  isRunFeedFileName,
  liveChildren,
  summarizeInitiative,
} from "./dispatchLiveSummary.ts";

const NOW_ISO = "2026-11-21T12:00:00.000Z";
const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe(NOW_ISO));
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (offsetMs: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW + offsetMs));

const opened = (
  run: string,
  pid: number,
  ts: string,
  extra: { readonly part?: string; readonly initiative?: string } = {},
): DispatchRunFeedRow => ({
  schema: "dp-run/1",
  ts,
  event: "run-opened",
  run,
  dir: `/work/${run}`,
  part: extra.part ?? "core",
  wave: 1,
  spec: ".claude/plans/core.md",
  pid,
  phases: 2,
  initiative: extra.initiative ?? "home",
});

const settled = (run: string, pid: number, ts: string, outcome: string): DispatchRunFeedRow => ({
  schema: "dp-run/1",
  ts,
  event: "run-settled",
  run,
  dir: `/work/${run}`,
  part: "core",
  wave: 1,
  pid,
  outcome,
});

const childrenOf = (
  rows: ReadonlyArray<DispatchRunFeedRow>,
  alivePids: ReadonlyArray<number> = [],
  now = NOW,
) =>
  liveChildren(foldRunRows(new Map(), rows), {
    now,
    pidAlive: (pid) => alivePids.includes(pid),
    threadIdFor: () => null,
  });

const entry = (overrides: Partial<DispatchLiveInitiative> = {}): DispatchLiveInitiative => ({
  slug: "home",
  closed: false,
  totalWave: 2,
  totalRunning: 3,
  totalSettled: 4,
  totalCostUsd: 12.5,
  reportedCostUsd: 20,
  started: "2026-11-21T10:00:00Z",
  touched: "2026-11-21T11:00:00Z",
  liveUntil: at(10 * MINUTE),
  ...overrides,
});

const initiativeState = (
  overrides: Partial<DispatchInitiativeState> = {},
): DispatchInitiativeState => ({
  initiative: { slug: "home", title: "Home base", repos: [] },
  parts: [],
  waves: [],
  progress: [],
  deliveries: [],
  closed: false,
  ...overrides,
});

const part = (id: string, wave: number, status: string) => ({
  id,
  title: `Part ${id}`,
  repo: "acme/app",
  zone: [],
  wave,
  status,
});

const wave = (number: number, opened: boolean, closed: boolean) => ({
  number,
  opened,
  closed,
  parts: [],
});

const summarize = (
  registry: DispatchLiveInitiative,
  state: DispatchInitiativeState | null,
  children: ReadonlyArray<PluginLiveChild> = [],
) =>
  summarizeInitiative(registry, state, {
    now: NOW,
    openDecisions: 0,
    orchestratorThreadId: null,
    children,
  });

describe("run children", () => {
  it("pairs open and settle rows by run and pid, so a resumed run is a separate child", () => {
    const children = childrenOf(
      [
        opened("r-1", 100, at(-2 * HOUR)),
        settled("r-1", 100, at(-HOUR), "aborted"),
        opened("r-1", 200, at(-30 * MINUTE)),
      ],
      [100, 200],
    );
    expect(
      children.map(({ id, state, startedAt, updatedAt }) => ({ id, state, startedAt, updatedAt })),
    ).toEqual([
      { id: "r-1:200", state: "running", startedAt: at(-30 * MINUTE), updatedAt: at(-30 * MINUTE) },
      { id: "r-1:100", state: "aborted", startedAt: at(-2 * HOUR), updatedAt: at(-HOUR) },
    ]);
  });

  it.each([
    { outcome: "passed", alive: false, state: "settled" },
    { outcome: "failed", alive: false, state: "failed" },
    { outcome: "aborted", alive: true, state: "aborted" },
    { outcome: null, alive: true, state: "running" },
    { outcome: null, alive: false, state: "aborted" },
  ] as const)("reports $state for outcome $outcome with a live pid: $alive", (fixture) => {
    const rows = [
      opened("r-1", 100, at(-HOUR)),
      ...(fixture.outcome === null ? [] : [settled("r-1", 100, at(-MINUTE), fixture.outcome)]),
    ];
    expect(childrenOf(rows, fixture.alive ? [100] : []).map((child) => child.state)).toEqual([
      fixture.state,
    ]);
  });

  it("fills the child from the open row", () => {
    expect(
      liveChildren(foldRunRows(new Map(), [opened("r-1", 100, "2026-11-21T06:30:00-05:00")]), {
        now: NOW,
        pidAlive: () => true,
        threadIdFor: (key) => (key === "r-1:100" ? ThreadId.make("thread-a") : null),
      }),
    ).toEqual([
      {
        id: "r-1:100",
        kind: "run",
        initiative: "home",
        part: "core",
        wave: 1,
        phase: null,
        state: "running",
        threadId: "thread-a",
        dir: "/work/r-1",
        startedAt: "2026-11-21T11:30:00.000Z",
        updatedAt: "2026-11-21T11:30:00.000Z",
        costUsd: null,
      },
    ]);
  });

  it("keeps runs that ended in the last 24 hours and every running run", () => {
    const children = childrenOf(
      [
        opened("kept-edge", 1, at(-30 * HOUR)),
        settled("kept-edge", 1, at(-24 * HOUR), "passed"),
        opened("dropped", 2, at(-30 * HOUR)),
        settled("dropped", 2, at(-24 * HOUR - 1000), "passed"),
        opened("dead-old", 3, at(-25 * HOUR)),
        opened("alive-old", 4, at(-30 * 24 * HOUR)),
      ],
      [4],
    );
    expect(children.map((child) => child.id).toSorted()).toEqual(["alive-old:4", "kept-edge:1"]);
  });

  it("lists at most 100 children, the most recently opened first", () => {
    const rows = Array.from({ length: 105 }, (_, index) =>
      opened(`r-${index}`, 1000 + index, at(-index * MINUTE)),
    );
    const children = childrenOf(
      rows,
      rows.map((_, index) => 1000 + index),
    );
    expect(children).toHaveLength(100);
    expect(children[0]?.id).toBe("r-0:1000");
    expect(children[99]?.id).toBe("r-99:1099");
  });
});

describe("initiative summary", () => {
  it.each([
    { liveUntil: at(1), running: 25 },
    { liveUntil: at(0), running: 0 },
    { liveUntil: at(-HOUR), running: 0 },
  ])("reports $running running when liveUntil is $liveUntil", ({ liveUntil, running }) => {
    const summary = summarize(entry({ liveUntil, totalRunning: 25, totalSettled: 4 }), null);
    expect(summary.running).toBe(running);
    expect(summary.settled).toEqual({ count: 4, total: 4 + running });
  });

  it.each([
    { reported: 110.6, total: 0, state: "final", spend: { usd: 110.6, state: "exact" } },
    { reported: 0, total: 9.5, state: "estimated", spend: { usd: 9.5, state: "estimated" } },
    { reported: 30, total: 9.5, state: "incomplete", spend: { usd: 30, state: "incomplete" } },
    { reported: 0, total: 9.5, state: undefined, spend: { usd: 9.5, state: "estimated" } },
    { reported: 0, total: 0, state: undefined, spend: { usd: null, state: "unknown" } },
  ] as const)("spend from reported $reported, total $total, state $state", (fixture) => {
    const summary = summarize(
      entry({
        reportedCostUsd: fixture.reported,
        totalCostUsd: fixture.total,
        ...(fixture.state === undefined ? {} : { totalCostState: fixture.state }),
      }),
      null,
    );
    expect(summary.spend).toEqual(fixture.spend);
  });

  it.each([
    {
      name: "the highest opened wave that is not closed, ranked from 1",
      waves: [
        wave(2, true, false),
        wave(0, true, false),
        wave(3, true, true),
        wave(1, false, false),
      ],
      parts: [
        part("a", 0, "planned"),
        part("b", 1, "merged"),
        part("c", 2, "mr-open"),
        part("d", 3, "gate-pass"),
      ],
      registryTotal: 9,
      liveWave: { current: 3, total: 4, partsSettled: 1, partsTotal: 1 },
      partWaves: [1, 2, 3, 4],
    },
    {
      name: "the first unsettled wave when none is opened and the registry total is 0",
      waves: [
        wave(3, false, false),
        wave(2, false, false),
        wave(1, false, false),
        wave(0, false, false),
      ],
      parts: [part("b", 3, "specced"), part("a", 0, "planned")],
      registryTotal: 0,
      liveWave: { current: 1, total: 4, partsSettled: 0, partsTotal: 1 },
      partWaves: [4, 1],
    },
    {
      name: "an open dp wave 0 ahead of a later unsettled wave",
      waves: [wave(0, true, false), wave(1, false, false)],
      parts: [part("a", 0, "merged"), part("b", 1, "planned")],
      registryTotal: 2,
      liveWave: { current: 1, total: 2, partsSettled: 1, partsTotal: 1 },
      partWaves: [1, 2],
    },
    {
      name: "the first unsettled wave after a settled wave when none is opened",
      waves: [wave(1, false, false), wave(3, false, false), wave(7, false, false)],
      parts: [part("d", 7, "planned"), part("a", 1, "mr-open"), part("c", 3, "gate-fail")],
      registryTotal: 0,
      liveWave: { current: 2, total: 3, partsSettled: 0, partsTotal: 1 },
      partWaves: [3, 1, 2],
    },
    {
      name: "the last wave when every part is settled and none is open",
      waves: [wave(1, true, true), wave(2, true, true), wave(3, false, false)],
      parts: [part("a", 1, "merged"), part("b", 2, "gate-pass"), part("c", 3, "mr-open")],
      registryTotal: 8,
      liveWave: { current: 3, total: 3, partsSettled: 1, partsTotal: 1 },
      partWaves: [1, 2, 3],
    },
    {
      name: "the open wave even when every part is settled",
      waves: [wave(1, true, false), wave(2, false, false)],
      parts: [part("a", 1, "gate-pass"), part("b", 2, "merged")],
      registryTotal: 0,
      liveWave: { current: 1, total: 2, partsSettled: 1, partsTotal: 1 },
      partWaves: [1, 2],
    },
    {
      name: "no wave when dp returns neither waves nor parts",
      waves: [],
      parts: [],
      registryTotal: 2,
      liveWave: { current: 0, total: 0, partsSettled: 0, partsTotal: 0 },
      partWaves: [],
    },
  ])("takes the current wave from $name", (fixture) => {
    const summary = summarize(
      entry({ totalWave: fixture.registryTotal }),
      initiativeState({ waves: fixture.waves, parts: fixture.parts }),
    );
    expect(summary.wave).toEqual(fixture.liveWave);
    expect(summary.parts.map(({ wave }) => wave)).toEqual(fixture.partWaves);
  });

  it("counts merged, gate-pass and mr-open parts of the current wave as settled", () => {
    const summary = summarize(
      entry(),
      initiativeState({
        waves: [wave(1, true, true), wave(2, true, false)],
        parts: [
          part("a", 2, "merged"),
          part("b", 2, "gate-pass"),
          part("c", 2, "running"),
          part("d", 2, "gate-fail"),
          part("e", 1, "merged"),
          part("f", 2, "mr-open"),
        ],
      }),
    );
    expect(summary.wave).toEqual({ current: 2, total: 2, partsSettled: 3, partsTotal: 5 });
    expect(summary.parts.map(({ status }) => status)).toEqual([
      "merged",
      "gate-pass",
      "running",
      "gate-fail",
      "merged",
      "mr-open",
    ]);
  });

  it("lists each part's distinct mapped chats from this initiative's children", () => {
    const threadA = ThreadId.make("thread-a");
    const threadB = ThreadId.make("thread-b");
    const child = (
      id: string,
      partId: string,
      threadId: ThreadId | null,
      initiative = "home",
    ): PluginLiveChild => ({
      id,
      kind: "run",
      initiative,
      part: partId,
      wave: 1,
      phase: null,
      state: "running",
      threadId,
      dir: "/work",
      startedAt: null,
      updatedAt: null,
      costUsd: null,
    });
    const summary = summarize(
      entry(),
      initiativeState({ parts: [part("core", 1, "running"), part("web", 1, "planned")] }),
      [
        child("r-1:1", "core", threadA),
        child("r-1:2", "core", threadA),
        child("r-2:3", "core", threadB),
        child("r-3:4", "core", null),
        child("r-4:5", "web", threadB, "elsewhere"),
      ],
    );
    expect(summary.parts).toEqual([
      {
        id: "core",
        title: "Part core",
        wave: 1,
        status: "running",
        threadIds: [threadA, threadB],
      },
      { id: "web", title: "Part web", wave: 1, status: "planned", threadIds: [] },
    ]);
  });

  it("takes the title from dp and reports touched in UTC", () => {
    const summary = summarizeInitiative(
      entry({ touched: "2026-11-21T11:00:00-05:00" }),
      initiativeState(),
      {
        now: NOW,
        openDecisions: 2,
        orchestratorThreadId: ThreadId.make("thread-o"),
        children: [],
      },
    );
    expect({
      title: summary.title,
      asOf: summary.asOf,
      openDecisions: summary.openDecisions,
      orchestratorThreadId: summary.orchestratorThreadId,
      closed: summary.closed,
    }).toEqual({
      title: "Home base",
      asOf: "2026-11-21T16:00:00.000Z",
      openDecisions: 2,
      orchestratorThreadId: "thread-o",
      closed: false,
    });
  });
});

describe("watched file names", () => {
  it.each([
    { name: "rucode-home.json", registry: true, feed: false },
    { name: "v1.2_x.json", registry: true, feed: false },
    { name: ".fp-tmp-x", registry: false, feed: false },
    { name: ".fp-tmp-123.json", registry: false, feed: false },
    { name: ".json", registry: false, feed: false },
    { name: "rucode-home.json.bak", registry: false, feed: false },
    { name: "runs.jsonl", registry: false, feed: true },
    { name: "runs.jsonl.1", registry: false, feed: true },
    { name: "runs.jsonl.2", registry: false, feed: false },
    { name: "runs.json", registry: true, feed: false },
  ])("$name", ({ name, registry, feed }) => {
    expect(isRegistryFileName(name)).toBe(registry);
    expect(isRunFeedFileName(name)).toBe(feed);
  });

  it("follows a run feed renamed by DP_RUN_FEED", () => {
    expect(isRunFeedFileName("feed.jsonl", "feed.jsonl")).toBe(true);
    expect(isRunFeedFileName("feed.jsonl.1", "feed.jsonl")).toBe(true);
    expect(isRunFeedFileName("runs.jsonl", "feed.jsonl")).toBe(false);
  });
});
