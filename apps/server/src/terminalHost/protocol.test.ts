import { describe, expect, it } from "@effect/vitest";

import {
  decodeTerminalHostEvent,
  decodeTerminalHostRequest,
  encodeTerminalHostFrame,
  makeFrameSplitter,
  MAX_FRAME_BYTES,
  type TerminalHostEvent,
  type TerminalHostRequest,
} from "./protocol.ts";

const requests: ReadonlyArray<TerminalHostRequest> = [
  { type: "hello", protocol: 1 },
  {
    type: "spawn",
    id: 7,
    key: "thread:term",
    launch: { runtimeEnv: { A: "1" }, nested: [1, "two", null] },
    spawn: {
      shell: "/bin/sh",
      args: ["-l"],
      cwd: "/work",
      cols: 80,
      rows: 24,
      env: { PATH: "/bin" },
    },
  },
  { type: "write", key: "k", data: "ls\r" },
  { type: "write", key: "k", data: "ÿ\u0000\u001b", binary: true },
  { type: "resize", key: "k", cols: 120, rows: 40 },
  { type: "kill", key: "k" },
  { type: "kill", key: "k", signal: "SIGKILL" },
  { type: "detach", key: "k" },
  { type: "record-command", key: "k", command: { line: "npm run dev", cwd: "/work" } },
  { type: "record-command", key: "k", command: null },
];

const events: ReadonlyArray<TerminalHostEvent> = [
  { type: "welcome", protocol: 1, hostPid: 4242, sessions: 2 },
  {
    type: "session",
    key: "k",
    pid: 99,
    launch: { shell: "zsh" },
    backlog: "line\r\n\u001b[0m",
    exit: { exitCode: 0, signal: null },
  },
  { type: "session", key: "k", pid: 99, launch: null, backlog: "", exit: null },
  { type: "spawned", id: 7, key: "k", pid: 100 },
  { type: "spawn-failed", id: 7, message: "no such shell" },
  { type: "data", key: "k", data: "héllo \u001b[31mred\n" },
  { type: "exit", key: "k", exitCode: 1, signal: 15 },
];

describe("terminal host protocol", () => {
  it("round trips every request and event through one encoded line", () => {
    for (const request of requests) {
      const line = encodeTerminalHostFrame(request);
      expect(line.indexOf("\n")).toBe(line.length - 1);
      expect(decodeTerminalHostRequest(line.slice(0, -1))).toEqual(request);
    }
    for (const event of events) {
      expect(decodeTerminalHostEvent(encodeTerminalHostFrame(event).slice(0, -1))).toEqual(event);
    }
  });

  it("rejects malformed lines, unknown types and frames of the wrong direction", () => {
    expect(decodeTerminalHostRequest("")).toBeNull();
    expect(decodeTerminalHostRequest("{not json")).toBeNull();
    expect(decodeTerminalHostRequest('{"type":"reboot"}')).toBeNull();
    expect(decodeTerminalHostRequest('{"type":"write","key":"k"}')).toBeNull();
    expect(decodeTerminalHostRequest('{"type":"resize","key":"k","cols":1.5,"rows":2}')).toBeNull();
    expect(decodeTerminalHostRequest('{"type":"data","key":"k","data":"x"}')).toBeNull();
    expect(decodeTerminalHostEvent('{"type":"hello","protocol":1}')).toBeNull();
  });

  it("splits lines across and within chunks", () => {
    const split = makeFrameSplitter();
    expect(split('{"a":')).toEqual([]);
    expect(split('1}\n{"b":2}\n{"c"')).toEqual(['{"a":1}', '{"b":2}']);
    expect(split(":3}\n")).toEqual(['{"c":3}']);
    expect(split("\n")).toEqual([""]);
  });

  it("accepts a line of exactly the limit in UTF-8 bytes and rejects one byte more", () => {
    // "é" is two UTF-8 bytes, so a splitter that counted UTF-16 units would accept both lines.
    const atLimit = "é".repeat(MAX_FRAME_BYTES / 2);
    expect(makeFrameSplitter()(`${atLimit}\n`)).toEqual([atLimit]);
    expect(makeFrameSplitter()(`${atLimit}a\n`)).toBeNull();

    const pending = makeFrameSplitter();
    expect(pending(atLimit)).toEqual([]);
    expect(pending("a")).toBeNull();

    const spanning = makeFrameSplitter();
    expect(spanning(atLimit.slice(0, 10))).toEqual([]);
    expect(spanning(`${atLimit.slice(10)}a\n`)).toBeNull();
  });
});
