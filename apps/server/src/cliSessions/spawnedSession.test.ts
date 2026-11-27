import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  decideSpawn,
  looksLikeThrowawayCheckout,
  type SpawnDecision,
  type SpawnInput,
} from "./spawnedSession.ts";

const HOME = "/home/someone";
const CHECKOUT = `${HOME}/dev/acme-spike.xDsmKz`;
const SESSION = "0b7c2a1e-5f3d-4c1a-9e8b-1d2f3a4b5c6d";
const PARENT = "1c8d3b2f-6a4e-4d2b-8f9c-2e3a4b5c6d7e";
const SERVER = "2d9e4c3a-7b5f-4e3c-9a0d-3f4b5c6d7e8f";
const PARENT_THREAD = ThreadId.make("thread-parent");
const SESSION_THREAD = ThreadId.make("thread-current");
const SERVER_THREAD = ThreadId.make("thread-server");
const THREADS = new Map([
  [PARENT, PARENT_THREAD],
  [SESSION, SESSION_THREAD],
  [SERVER, SERVER_THREAD],
]);

const input = (fields: Partial<SpawnInput>): SpawnInput => ({
  sessionId: SESSION,
  parentSessionId: null,
  serverSessionId: SERVER,
  cwd: `${HOME}/dev/acme`,
  homeDir: HOME,
  atProjectRoot: false,
  sessionThreads: THREADS,
  ...fields,
});

describe("decideSpawn", () => {
  const child = { _tag: "Child", parentThreadId: PARENT_THREAD } as const;
  const awaiting = { _tag: "AwaitingParent", parentSessionId: PARENT } as const;
  const hidden = { _tag: "Hidden", reason: "throwaway-checkout" } as const;
  const topLevel = { _tag: "TopLevel" } as const;

  const cases: ReadonlyArray<{
    name: string;
    fields: Partial<SpawnInput>;
    expected: SpawnDecision;
  }> = [
    {
      name: "looks up the verified parent instead of the session",
      fields: { parentSessionId: PARENT },
      expected: child,
    },
    {
      name: "keeps the verified parent when the server has no inherited id",
      fields: { parentSessionId: PARENT, serverSessionId: null },
      expected: child,
    },
    {
      name: "uses the verified parent before the throwaway heuristic",
      fields: { parentSessionId: PARENT, cwd: CHECKOUT },
      expected: child,
    },
    {
      name: "uses the verified parent even at a registered root",
      fields: { parentSessionId: PARENT, cwd: CHECKOUT, atProjectRoot: true },
      expected: child,
    },
    {
      name: "uses the verified parent even outside home",
      fields: { parentSessionId: PARENT, cwd: "/srv/acme" },
      expected: child,
    },
    {
      name: "holds back a parent mapped to null instead of treating it as a unique thread",
      fields: { parentSessionId: PARENT, sessionThreads: new Map([[PARENT, null]]) },
      expected: awaiting,
    },
    {
      name: "holds back a missing parent instead of creating a top-level thread",
      fields: { parentSessionId: PARENT, sessionThreads: new Map([[SESSION, SESSION_THREAD]]) },
      expected: awaiting,
    },
    {
      name: "holds back a missing parent before applying the throwaway heuristic",
      fields: { parentSessionId: PARENT, cwd: CHECKOUT, sessionThreads: new Map() },
      expected: awaiting,
    },
    {
      name: "uses the null sentinel for a missing parent id",
      fields: { parentSessionId: "", cwd: CHECKOUT },
      expected: { _tag: "AwaitingParent", parentSessionId: "" },
    },
    {
      name: "ignores the server's inherited parent id even when it maps to a thread",
      fields: { parentSessionId: SERVER },
      expected: topLevel,
    },
    {
      name: "applies the throwaway heuristic after ignoring the server's inherited id",
      fields: { parentSessionId: SERVER, cwd: CHECKOUT },
      expected: hidden,
    },
    {
      name: "ignores the session's own id even when it maps to a thread",
      fields: { parentSessionId: SESSION },
      expected: topLevel,
    },
    {
      name: "applies the throwaway heuristic after ignoring the session's own id",
      fields: { parentSessionId: SESSION, cwd: CHECKOUT },
      expected: hidden,
    },
    {
      name: "hides a throwaway cwd when there is no parent",
      fields: { cwd: CHECKOUT },
      expected: hidden,
    },
    {
      name: "exempts a registered root even when the cwd resembles a throwaway checkout",
      fields: { cwd: CHECKOUT, atProjectRoot: true },
      expected: topLevel,
    },
    {
      name: "keeps a throwaway-looking cwd outside home top-level without a parent",
      fields: { cwd: "/srv/acme.xDsmKz" },
      expected: topLevel,
    },
    { name: "keeps an ordinary cwd top-level without a parent", fields: {}, expected: topLevel },
  ];

  it.each(cases)("$name", ({ fields, expected }) => {
    expect(decideSpawn(input(fields))).toStrictEqual(expected);
  });

  it("uses the current mapping when a previously missing parent acquires a thread", () => {
    const sessionThreads = new Map<string, ThreadId | null>();
    const placement = input({ parentSessionId: PARENT, sessionThreads });

    expect(decideSpawn(placement)).toStrictEqual(awaiting);
    sessionThreads.set(PARENT, PARENT_THREAD);
    expect(decideSpawn(placement)).toStrictEqual(child);
  });
});

describe("looksLikeThrowawayCheckout", () => {
  it.each([
    ["matches a six-character mixed-case suffix", CHECKOUT, HOME, true],
    ["checks ancestors below home", `${CHECKOUT}/src`, HOME, true],
    ["trims trailing slashes from cwd", `${CHECKOUT}///`, HOME, true],
    ["trims trailing slashes from home", CHECKOUT, `${HOME}///`, true],
    ["allows digits in a mixed-case suffix", `${HOME}/dev/acme.xD3mK0`, HOME, true],
    ["allows a one-character basename", `${HOME}/a.xDsmKz`, HOME, true],
    ["allows dots after the first basename character", `${HOME}/acme.dev.xDsmKz`, HOME, true],
    ["checks components below a filesystem-root home", "/acme.xDsmKz", "/", true],
    ["rejects a name without a suffix", `${HOME}/dev/acme`, HOME, false],
    ["rejects an all-lowercase suffix", `${HOME}/dev/notes.backup`, HOME, false],
    ["rejects an ordinary version name", `${HOME}/dev/v1.2.3`, HOME, false],
    ["rejects an all-uppercase suffix", `${HOME}/dev/acme.ABCDEF`, HOME, false],
    ["rejects a digits-only suffix", `${HOME}/dev/acme.123456`, HOME, false],
    ["rejects a suffix one character short", `${HOME}/dev/acme.xDsmK`, HOME, false],
    ["rejects a suffix one character long", `${HOME}/dev/acme.xDsmKzz`, HOME, false],
    ["rejects punctuation in a six-character suffix", `${HOME}/dev/acme.xD_mKz`, HOME, false],
    ["rejects a basename starting with a dot", `${HOME}/dev/.acme.xDsmKz`, HOME, false],
    ["rejects a missing basename", `${HOME}/dev/.xDsmKz`, HOME, false],
    ["rejects a dash before a mixed-case suffix", `${HOME}/dev/api-Server`, HOME, false],
    ["rejects an ordinary worktree", `${HOME}/dev/acme-worktrees/feature-x`, HOME, false],
    ["excludes the home directory itself", CHECKOUT, CHECKOUT, false],
    ["excludes matching components in the home path", `${CHECKOUT}/dev/acme`, CHECKOUT, false],
    ["rejects cwd outside home", "/srv/acme.xDsmKz", HOME, false],
    ["rejects a sibling sharing the home prefix", `${HOME}-else/acme.xDsmKz`, HOME, false],
    ["rejects an empty cwd", "", HOME, false],
    ["rejects a relative cwd", "acme.xDsmKz", HOME, false],
    ["rejects an empty home", CHECKOUT, "", false],
  ] as const)("%s", (_name, cwd, homeDir, expected) => {
    expect(looksLikeThrowawayCheckout(cwd, homeDir)).toBe(expected);
  });
});
