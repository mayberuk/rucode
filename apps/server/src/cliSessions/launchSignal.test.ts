import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  claudeLaunchFromEnviron,
  parentClaudeSessionOf,
  procStatParentPid,
} from "./launchSignal.ts";

const SESSION = "3baad347-005a-4c67-8069-cc02833ca788";
const OTHER_SESSION = "0b7dafba-87d7-48bf-8b1c-e27aa0f22c76";
const CHILD = 4242;
const PARENT = 3000;
const SESSION_ENTRY = `CLAUDE_CODE_SESSION_ID=${SESSION}`;
const PID_ENTRY = `CLAUDE_PID=${PARENT}`;
const launchEnviron = (pid = PARENT, sessionId = SESSION) =>
  `CLAUDE_CODE_SESSION_ID=${sessionId}\0CLAUDE_PID=${pid}\0`;
const statLine = (pid: number, ppid: number, command = "claude") =>
  `${pid} (${command}) S ${ppid} 0 0 0 0\n`;

describe("claudeLaunchFromEnviron", () => {
  it.each([
    ["both variables", launchEnviron(), { sessionId: SESSION, pid: PARENT }],
    [
      "only the named entries in reverse order among unrelated values with equals signs",
      `EXAMPLE_TOKEN=abc=def\0CLAUDE_PID_OTHER=9\0${PID_ENTRY}\0${SESSION_ENTRY}\0HOME=/acme\0`,
      { sessionId: SESSION, pid: PARENT },
    ],
    [
      "a single-character session ID and the smallest positive PID",
      launchEnviron(1, "7"),
      {
        sessionId: "7",
        pid: 1,
      },
    ],
    [
      "a session ID with allowed punctuation and the largest safe PID",
      launchEnviron(Number.MAX_SAFE_INTEGER, "Acme.session_7-"),
      { sessionId: "Acme.session_7-", pid: Number.MAX_SAFE_INTEGER },
    ],
    [
      "a PID with leading zeros",
      `${SESSION_ENTRY}\0CLAUDE_PID=003000`,
      {
        sessionId: SESSION,
        pid: PARENT,
      },
    ],
    [
      "the first occurrence of each duplicate variable",
      `${launchEnviron()}${launchEnviron(3001, OTHER_SESSION)}`,
      { sessionId: SESSION, pid: PARENT },
    ],
  ] as const)("extracts %s", (_case, environ, expected) => {
    expect(claudeLaunchFromEnviron(environ)).toStrictEqual(expected);
  });

  it.each([
    ["empty environ", ""],
    ["missing PID", SESSION_ENTRY],
    ["missing session ID", PID_ENTRY],
    ["a PID entry without an equals sign", `${SESSION_ENTRY}\0CLAUDE_PID`],
    ["a session ID entry without an equals sign", `CLAUDE_CODE_SESSION_ID\0${PID_ENTRY}`],
    ["a lookalike PID variable", `${SESSION_ENTRY}\0OTHER_CLAUDE_PID=3000`],
    ["a lookalike session variable", `CLAUDE_CODE_SESSION_ID_OTHER=${SESSION}\0${PID_ENTRY}`],
    ["empty PID", `${SESSION_ENTRY}\0CLAUDE_PID=`],
    ["non-numeric PID", `${SESSION_ENTRY}\0CLAUDE_PID=abc`],
    ["zero PID", launchEnviron(0)],
    ["negative PID", launchEnviron(-1)],
    ["unsafe PID", launchEnviron(Number.MAX_SAFE_INTEGER + 1)],
    ["fractional PID", launchEnviron(3.5)],
    ["signed PID", `${SESSION_ENTRY}\0CLAUDE_PID=+3000`],
    ["exponential PID", `${SESSION_ENTRY}\0CLAUDE_PID=3e3`],
    ["hexadecimal PID", `${SESSION_ENTRY}\0CLAUDE_PID=0xbb8`],
    ["PID with whitespace", `${SESSION_ENTRY}\0CLAUDE_PID= 3000`],
    ["a PID value with another equals sign", `${PID_ENTRY}=8\0${SESSION_ENTRY}`],
    ["empty session ID", launchEnviron(PARENT, "")],
    ["session ID with a slash", launchEnviron(PARENT, "acme/session")],
    ["session ID with an equals sign", launchEnviron(PARENT, "acme=session")],
    ["session ID starting with punctuation", launchEnviron(PARENT, "_acme")],
    ["session ID with a trailing newline", launchEnviron(PARENT, "acme\n")],
    ["an invalid first duplicate PID", `${SESSION_ENTRY}\0CLAUDE_PID=0\0${PID_ENTRY}`],
  ] as const)("rejects %s", (_case, environ) => {
    expect(claudeLaunchFromEnviron(environ)).toBeNull();
  });
});

describe("procStatParentPid", () => {
  it.each([
    ["a simple command", statLine(CHILD, PARENT), PARENT],
    [
      "a command with spaces and an inner closing parenthesis",
      statLine(CHILD, 77, "shell ) main"),
      77,
    ],
    ["a zero parent", statLine(CHILD, 0), 0],
    ["an init parent", statLine(CHILD, 1), 1],
    [
      "the largest safe parent PID",
      statLine(CHILD, Number.MAX_SAFE_INTEGER),
      Number.MAX_SAFE_INTEGER,
    ],
  ] as const)("reads field 4 for %s", (_case, stat, expected) => {
    expect(procStatParentPid(stat)).toBe(expected);
  });

  it.each([
    ["empty stat", ""],
    ["missing command", "4242 shell S 3000 0"],
    ["missing closing parenthesis", "4242 (shell S 3000 0"],
    ["missing opening parenthesis", "4242 shell) S 3000 0"],
    ["missing state", "4242 (shell) 3000 0"],
    ["missing parent", "4242 (shell) S"],
    ["negative parent", statLine(CHILD, -1)],
    ["fractional parent", statLine(CHILD, 3.5)],
    ["unsafe parent", statLine(CHILD, Number.MAX_SAFE_INTEGER + 1)],
    ["exponential parent", "4242 (shell) S 3e3 0"],
    ["hexadecimal parent", "4242 (shell) S 0xbb8 0"],
    ["partially numeric parent", "4242 (shell) S 3000x 0"],
  ] as const)("rejects %s", (_case, stat) => {
    expect(procStatParentPid(stat)).toBeNull();
  });
});

const fakeProc = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-launch-" });
  const write = (pid: number, file: "environ" | "stat", contents: string) =>
    fs
      .makeDirectory(`${root}/${pid}`, { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(`${root}/${pid}/${file}`, contents)));
  return {
    root,
    write,
    setParent: (pid: number, ppid: number, command?: string) =>
      write(pid, "stat", statLine(pid, ppid, command)),
  };
});

describe("parentClaudeSessionOf", () => {
  const withProc = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

  it.effect.each([CHILD, Number.MAX_SAFE_INTEGER])(
    "returns the ID for child %i without needing the direct parent's stat",
    (pid) =>
      Effect.gen(function* () {
        const { root, write, setParent } = yield* fakeProc;
        yield* write(pid, "environ", launchEnviron());
        yield* setParent(pid, PARENT);
        expect(yield* parentClaudeSessionOf(pid, root)).toBe(SESSION);
      }).pipe(withProc),
  );

  it.effect("returns null when reading the environ fails for an existing path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { root, setParent } = yield* fakeProc;
      yield* setParent(CHILD, PARENT);
      yield* fs.makeDirectory(`${root}/${CHILD}/environ`);
      expect(yield* parentClaudeSessionOf(CHILD, root)).toBeNull();
    }).pipe(withProc),
  );

  it.effect("returns the ID through an intermediate shell and rereads a changed chain", () =>
    Effect.gen(function* () {
      const { root, write, setParent } = yield* fakeProc;
      yield* write(CHILD, "environ", launchEnviron());
      yield* setParent(CHILD, 4000);
      yield* setParent(4000, PARENT, "shell ) main");
      expect(yield* parentClaudeSessionOf(CHILD, root)).toBe(SESSION);
      yield* setParent(4000, 1);
      expect(yield* parentClaudeSessionOf(CHILD, root)).toBeNull();
    }).pipe(withProc),
  );

  it.effect("keeps concurrent lookups for children of the same parent independent", () =>
    Effect.gen(function* () {
      const { root, write, setParent } = yield* fakeProc;
      yield* write(CHILD, "environ", launchEnviron());
      yield* write(CHILD + 1, "environ", launchEnviron(PARENT, OTHER_SESSION));
      yield* setParent(CHILD, 4000);
      yield* setParent(CHILD + 1, 4000);
      yield* setParent(4000, PARENT);
      const results = yield* Effect.all(
        [parentClaudeSessionOf(CHILD, root), parentClaudeSessionOf(CHILD + 1, root)],
        { concurrency: 2 },
      );
      expect(results).toEqual([SESSION, OTHER_SESSION]);
    }).pipe(withProc),
  );

  it.effect.each([0, 1])("stops a stale tmux launch at PID %i", (terminalPid) =>
    Effect.gen(function* () {
      const { root, write, setParent } = yield* fakeProc;
      yield* write(CHILD, "environ", launchEnviron());
      yield* setParent(CHILD, 4000);
      yield* setParent(4000, terminalPid, "tmux: server");
      yield* setParent(terminalPid, PARENT);
      expect(yield* parentClaudeSessionOf(CHILD, root)).toBeNull();
    }).pipe(withProc),
  );

  it.effect("rejects PID 1 as a launcher even when named by the environment", () =>
    Effect.gen(function* () {
      const { root, write, setParent } = yield* fakeProc;
      yield* write(CHILD, "environ", launchEnviron(1));
      yield* setParent(CHILD, 1);
      expect(yield* parentClaudeSessionOf(CHILD, root)).toBeNull();
    }).pipe(withProc),
  );

  it.effect("rejects the process's own PID even when its stat names itself", () =>
    Effect.gen(function* () {
      const { root, write, setParent } = yield* fakeProc;
      yield* write(CHILD, "environ", launchEnviron(CHILD));
      yield* setParent(CHILD, CHILD);
      expect(yield* parentClaudeSessionOf(CHILD, root)).toBeNull();
    }).pipe(withProc),
  );

  it.effect.each([
    ["missing", undefined],
    ["empty", ""],
    ["lacks PID", SESSION_ENTRY],
    ["lacks session ID", PID_ENTRY],
    ["has an invalid PID", `${SESSION_ENTRY}\0CLAUDE_PID=3e3`],
    ["has an invalid session ID", launchEnviron(PARENT, "acme/session")],
  ] as const)("returns null when the environ is %s", ([_case, environ]) =>
    Effect.gen(function* () {
      const { root, write, setParent } = yield* fakeProc;
      yield* setParent(CHILD, PARENT);
      if (environ !== undefined) yield* write(CHILD, "environ", environ);
      expect(yield* parentClaudeSessionOf(CHILD, root)).toBeNull();
    }).pipe(withProc),
  );

  it.effect.each([0, -1, 3.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])(
    "rejects an invalid starting PID %s even with matching files",
    (pid) =>
      Effect.gen(function* () {
        const { root, write } = yield* fakeProc;
        yield* write(pid, "environ", launchEnviron());
        yield* write(pid, "stat", statLine(CHILD, PARENT));
        expect(yield* parentClaudeSessionOf(pid, root)).toBeNull();
      }).pipe(withProc),
  );

  it.effect.each([
    ["missing", undefined],
    ["malformed", "4000 (shell) S 3000x 0"],
  ] as const)("returns null when an intermediate stat is %s", ([_case, stat]) =>
    Effect.gen(function* () {
      const { root, write, setParent } = yield* fakeProc;
      yield* write(CHILD, "environ", launchEnviron());
      yield* setParent(CHILD, 4000);
      if (stat !== undefined) yield* write(4000, "stat", stat);
      expect(yield* parentClaudeSessionOf(CHILD, root)).toBeNull();
    }).pipe(withProc),
  );

  it.effect("breaks a cycle before rereading an already visited stat", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { root, write, setParent } = yield* fakeProc;
      yield* write(CHILD, "environ", launchEnviron());
      yield* setParent(CHILD, 4000);
      yield* setParent(4000, 4001);
      yield* setParent(4001, 4000);
      const statReads: Array<string> = [];
      const recordingFs = FileSystem.FileSystem.of({
        ...fs,
        readFileString: (path, encoding) => {
          if (path.endsWith("/stat")) statReads.push(path);
          return fs.readFileString(path, encoding);
        },
      });

      const result = yield* parentClaudeSessionOf(CHILD, root).pipe(
        Effect.provideService(FileSystem.FileSystem, recordingFs),
      );

      expect(result).toBeNull();
      expect(statReads).toEqual([
        `${root}/${CHILD}/stat`,
        `${root}/4000/stat`,
        `${root}/4001/stat`,
      ]);
    }).pipe(withProc),
  );

  it.effect.each([
    [64, SESSION],
    [65, null],
  ] as const)("checks the limit for a launcher %i hops away", ([distance, expected]) =>
    Effect.gen(function* () {
      const { root, write, setParent } = yield* fakeProc;
      yield* write(CHILD, "environ", launchEnviron());
      for (let hop = 1; hop < distance; hop++) {
        yield* setParent(CHILD + hop - 1, CHILD + hop);
      }
      yield* setParent(CHILD + distance - 1, PARENT);
      expect(yield* parentClaudeSessionOf(CHILD, root)).toBe(expected);
    }).pipe(withProc),
  );
});
