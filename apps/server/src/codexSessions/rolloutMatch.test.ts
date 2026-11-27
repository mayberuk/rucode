// @effect-diagnostics globalDate:off -- Fixed local timestamps make the fixtures independent of UTC offset.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Fixtures use the host's path separators.
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import {
  matchRollout,
  rolloutDayDirs,
  type CodexRunRequest,
  type RolloutCandidate,
} from "./rolloutMatch.ts";

const cwd = "/work/acme-app";
const startedAtMs = Date.parse("2026-11-20T10:00:00.000Z");
const request = (fields: Partial<CodexRunRequest> = {}): CodexRunRequest => ({
  cwd,
  startedAtMs,
  prompt: "reply ok",
  ...fields,
});
const candidate = (
  name: string,
  fields: Partial<RolloutCandidate["meta"]> = {},
  firstPrompt: string | null = "reply ok",
): RolloutCandidate => ({
  filePath: NodePath.join("/sessions", `rollout-${name}.jsonl`),
  meta: {
    sessionId: name,
    cwd,
    startedAt: "2026-11-20T10:00:00.000Z",
    originator: "codex_exec",
    ...fields,
  },
  firstPrompt,
});
const unclaimed = new Set<string>();

describe("matchRollout", () => {
  it("matches a single candidate with identical cwd, start time and prompt", () => {
    const rollout = candidate("one");
    expect(matchRollout(request(), [rollout], unclaimed)).toBe(rollout.filePath);
  });

  it("matches overlapping runs by prompt with either candidate order", () => {
    const first = candidate("one", {}, "  reply ok\n");
    const second = candidate("two", { startedAt: "2026-11-20T10:00:01.000Z" }, "list the files");
    for (const candidates of [
      [second, first],
      [first, second],
    ]) {
      expect(matchRollout(request(), candidates, unclaimed)).toBe(first.filePath);
      expect(
        matchRollout(
          request({ startedAtMs: startedAtMs + 1_000, prompt: "\nlist the files  " }),
          candidates,
          unclaimed,
        ),
      ).toBe(second.filePath);
    }
  });

  it("requires exact prompt equality after trimming", () => {
    const rollout = candidate("one", {}, "reply okay");
    expect(matchRollout(request(), [rollout], unclaimed)).toBeNull();
  });

  it("rejects candidates without a first prompt when the run prompt is known", () => {
    expect(matchRollout(request(), [candidate("one", {}, null)], unclaimed)).toBeNull();
  });

  it("treats a blank known prompt as a prompt to match", () => {
    const blank = candidate("blank", {}, "");
    expect(matchRollout(request({ prompt: "  " }), [candidate("one"), blank], unclaimed)).toBe(
      blank.filePath,
    );
  });

  it("rejects a different cwd with a common prefix", () => {
    const rollout = candidate("one", { cwd: "/work/acme-app-other" });
    expect(matchRollout(request(), [rollout], unclaimed)).toBeNull();
  });

  it("compares the resolved cwd of both the rollout and the request", () => {
    const rollout = candidate("one", { cwd: cwd + "/scratch/.." });
    expect(matchRollout(request({ cwd: "/work/./acme-app/" }), [rollout], unclaimed)).toBe(
      rollout.filePath,
    );
  });

  it.each([
    ["30 seconds early", "2026-11-20T09:59:30.000Z"],
    ["120 seconds late", "2026-11-20T10:02:00.000Z"],
  ])("includes a start exactly %s", (_, startedAt) => {
    const rollout = candidate("one", { startedAt });
    expect(matchRollout(request(), [rollout], unclaimed)).toBe(rollout.filePath);
  });

  it.each([
    ["one millisecond before the window", "2026-11-20T09:59:29.999Z"],
    ["one millisecond after the window", "2026-11-20T10:02:00.001Z"],
    ["a malformed date", "invalid"],
    ["an empty date", ""],
  ])("rejects a start with %s", (_, startedAt) => {
    expect(matchRollout(request(), [candidate("one", { startedAt })], unclaimed)).toBeNull();
  });

  it.each(["codex_cli_rs", null])("rejects the originator %s", (originator) => {
    expect(matchRollout(request(), [candidate("one", { originator })], unclaimed)).toBeNull();
  });

  it("rejects an already claimed path", () => {
    const rollout = candidate("one");
    expect(matchRollout(request(), [rollout], new Set([rollout.filePath]))).toBeNull();
  });

  it("returns null for an empty candidate list and an unknown prompt", () => {
    expect(matchRollout(request({ prompt: null }), [], unclaimed)).toBeNull();
  });

  it("returns null for two eligible candidates and an unknown prompt", () => {
    const first = candidate("one");
    const second = candidate("two", {}, "list the files");
    expect(matchRollout(request({ prompt: null }), [first, second], unclaimed)).toBeNull();
  });

  it("matches an unknown prompt when only one candidate survives all filters", () => {
    const eligible = candidate("remaining", {}, null);
    const claimed = candidate("claimed");
    const candidates = [
      candidate("interactive", { originator: "codex_cli_rs" }),
      claimed,
      candidate("other-folder", { cwd: "/work/other" }),
      eligible,
      candidate("early", { startedAt: "2026-11-20T09:59:00.000Z" }),
    ];
    expect(matchRollout(request({ prompt: null }), candidates, new Set([claimed.filePath]))).toBe(
      eligible.filePath,
    );
  });

  it("matches an unknown prompt against a single eligible candidate", () => {
    const rollout = candidate("one");
    expect(matchRollout(request({ prompt: null }), [rollout], unclaimed)).toBe(rollout.filePath);
  });

  it("returns null for the same known prompt even at different start times", () => {
    const first = candidate("one");
    const second = candidate("two", { startedAt: "2026-11-20T10:00:01.000Z" });
    expect(matchRollout(request(), [first, second], unclaimed)).toBeNull();
  });
});

describe("rolloutDayDirs", () => {
  it("uses local dates and crosses the year boundary at local midnight", () => {
    expect(rolloutDayDirs("/sessions", new Date(2026, 0, 1, 0, 1).getTime())).toEqual([
      NodePath.join("/sessions", "2026", "01", "01"),
      NodePath.join("/sessions", "2025", "12", "31"),
    ]);
    expect(rolloutDayDirs("/sessions", new Date(2025, 11, 31, 23, 59).getTime())).toEqual([
      NodePath.join("/sessions", "2025", "12", "31"),
      NodePath.join("/sessions", "2025", "12", "30"),
    ]);
  });

  it("uses the previous calendar day even when it is shorter than 24 hours", () => {
    expect(rolloutDayDirs("/sessions", new Date(2026, 2, 9, 0, 30).getTime())).toEqual([
      NodePath.join("/sessions", "2026", "03", "09"),
      NodePath.join("/sessions", "2026", "03", "08"),
    ]);
  });

  it("produces no directories for an invalid start time", () => {
    expect(rolloutDayDirs("/sessions", Number.NaN)).toEqual([]);
  });
});
