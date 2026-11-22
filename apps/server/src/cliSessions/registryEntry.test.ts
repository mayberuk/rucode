import { describe, expect, it } from "@effect/vitest";

import {
  isLive,
  type LivenessProbe,
  ownerOf,
  paneOf,
  parseRegistryEntry,
  type RegistryEntry,
} from "./registryEntry.ts";

const DOMAIN = "linux:0123456789abcdef0123456789abcdef:pid:[4026531836]";

const raw = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    pid: 4242,
    sessionId: "0b7c2a1e-5f3d-4c1a-9e8b-1d2f3a4b5c6d",
    cwd: "/home/someone/dev/repo",
    kind: "interactive",
    entrypoint: "cli",
    tmux: "main:@27.%28",
    name: "repo-work",
    status: "idle",
    procStart: "556881",
    pidDomain: DOMAIN,
    startedAt: 1_790_787_054_573,
    peerProtocol: 3,
    ...fields,
  });

const entry = (fields: Record<string, unknown> = {}): RegistryEntry => {
  const parsed = parseRegistryEntry(raw(fields));
  if (parsed === null) throw new Error("fixture did not parse");
  return parsed;
};

const probe = (running: Readonly<Record<number, string>>): LivenessProbe => ({
  pidDomain: DOMAIN,
  startField: "procStart",
  startOf: (pid) => running[pid] ?? null,
});

describe("parseRegistryEntry", () => {
  it("returns null for a malformed file", () => {
    expect(parseRegistryEntry("{")).toBeNull();
    expect(parseRegistryEntry("[]")).toBeNull();
    expect(parseRegistryEntry(JSON.stringify({ sessionId: "abc" }))).toBeNull();
    expect(parseRegistryEntry(JSON.stringify({ pid: 12 }))).toBeNull();
  });

  it("keeps the shell status and maps an unknown status to unknown", () => {
    expect(entry({ status: "shell" }).status).toBe("shell");
    expect(entry({ status: "busy" }).status).toBe("busy");
    expect(entry({ status: "thinking-hard" }).status).toBe("unknown");
    expect(entry({ status: undefined }).status).toBe("unknown");
  });

  it("accepts unknown fields", () => {
    expect(entry({ somethingNew: { nested: true } }).sessionId).toBe(
      "0b7c2a1e-5f3d-4c1a-9e8b-1d2f3a4b5c6d",
    );
  });
});

describe("isLive", () => {
  it("is false for a dead pid", () => {
    expect(isLive(entry(), probe({}))).toBe(false);
  });

  it("is false when a reused pid started at a different time", () => {
    expect(isLive(entry(), probe({ 4242: "999999" }))).toBe(false);
  });

  it("is false for an entry from another pid domain", () => {
    const other = entry({ pidDomain: "linux:fedcba9876543210fedcba9876543210:pid:[4026531836]" });
    expect(isLive(other, probe({ 4242: "556881" }))).toBe(false);
  });

  it("is true for a running pid with the recorded start time", () => {
    expect(isLive(entry(), probe({ 4242: "556881" }))).toBe(true);
  });

  it("compares procStartFt where the platform records it", () => {
    const mac = entry({
      procStart: undefined,
      procStartFt: "Sat Nov 22 08:00:00 2026",
      pidDomain: undefined,
    });
    const macProbe = (start: string): LivenessProbe => ({
      pidDomain: null,
      startField: "procStartFt",
      startOf: (pid) => (pid === 4242 ? start : null),
    });
    expect(isLive(mac, macProbe("Sat Nov 22 08:00:00 2026"))).toBe(true);
    expect(isLive(mac, macProbe("Sat Nov 22 09:30:00 2026"))).toBe(false);
  });
});

describe("ownerOf", () => {
  it("maps the entrypoint to an owner", () => {
    expect(ownerOf(entry({ entrypoint: "cli" }))).toBe("terminal");
    expect(ownerOf(entry({ entrypoint: "t3-code" }))).toBe("rucode");
    expect(ownerOf(entry({ entrypoint: "sdk-cli" }))).toBe("other");
    expect(ownerOf(entry({ entrypoint: undefined }))).toBe("other");
  });
});

describe("paneOf", () => {
  it("parses the tmux location", () => {
    expect(paneOf(entry({ tmux: "main:@27.%28" }))).toEqual({ session: "main", pane: "%28" });
    expect(paneOf(entry({ tmux: "n1481546:@0.%1" }))).toEqual({ session: "n1481546", pane: "%1" });
  });

  it("is null outside tmux or for an unrecognised location", () => {
    expect(paneOf(entry({ tmux: null }))).toBeNull();
    expect(paneOf(entry({ tmux: "main" }))).toBeNull();
  });
});
