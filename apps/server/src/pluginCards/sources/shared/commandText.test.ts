import { expect, it } from "@effect/vitest";

import { commandSegments, flagValue, invokes, positionals, resolvePath } from "./commandText.ts";

const segments = (command: string, cwd = "/start") => commandSegments(command, cwd);
const wordsOf = (command: string) => segments(command).map((segment) => segment.words);

it("reports a plugin command after cd with that directory as its working directory", () => {
  expect(segments("cd /a && dp spec lint .claude/plans/x.md")).toEqual([
    { words: ["cd", "/a"], cwd: "/start" },
    { words: ["dp", "spec", "lint", ".claude/plans/x.md"], cwd: "/a" },
  ]);
});

it("resolves a relative cd against the working directory in force and keeps earlier segments where they ran", () => {
  expect(segments("dp one; cd sub && cd ../other && dp two")).toEqual([
    { words: ["dp", "one"], cwd: "/start" },
    { words: ["cd", "sub"], cwd: "/start" },
    { words: ["cd", "../other"], cwd: "/start/sub" },
    { words: ["dp", "two"], cwd: "/start/other" },
  ]);
});

it.each(["~/work", "-", "$DIR/x", "`pwd`"])(
  "leaves the working directory alone for a cd it cannot resolve: %s",
  (target) => {
    expect(segments(`cd ${target} && dp x`).map((segment) => segment.cwd)).toEqual([
      "/start",
      "/start",
    ]);
  },
);

it("keeps a quoted argument with spaces as one word without its quotes", () => {
  expect(wordsOf(`dp spec lint "my plans/x y.md" 'it is' a\\ b`)).toEqual([
    ["dp", "spec", "lint", "my plans/x y.md", "it is", "a b"],
  ]);
});

it("joins adjacent quoted and bare text into one word and keeps an empty quoted word", () => {
  expect(wordsOf(`echo a"b c"d '' ""`)).toEqual([["echo", "ab cd", "", ""]]);
});

it("keeps variable and command-substitution text literally inside its word", () => {
  expect(wordsOf(`echo RUN_DIR="$(bash x.sh)" --dir "$HOME/a b" $(a && b | c) tail`)).toEqual([
    ["echo", "RUN_DIR=$(bash x.sh)", "--dir", "$HOME/a b", "$(a && b | c)", "tail"],
  ]);
});

it("does not treat a pure assignment as a command", () => {
  expect(wordsOf(`RUN_DIR="$(bash x.sh)"`)).toEqual([]);
});

it("drops leading assignments and a bash, sh or env wrapper so the program is first", () => {
  expect(wordsOf("FOO=1 bash /p/scripts/push-state.sh read")).toEqual([
    ["/p/scripts/push-state.sh", "read"],
  ]);
  expect(wordsOf("/bin/sh run.sh")).toEqual([["run.sh"]]);
  expect(wordsOf("env A=1 B=2 dp spec lint x.md")).toEqual([["dp", "spec", "lint", "x.md"]]);
  expect(wordsOf("A=1 dp x")).toEqual([["dp", "x"]]);
});

it("keeps an assignment-looking word that is not leading", () => {
  expect(wordsOf("dp x A=1")).toEqual([["dp", "x", "A=1"]]);
});

it("splits on unquoted && || ; | and newlines only", () => {
  expect(wordsOf("a && b || c ; d | e\nf")).toEqual([["a"], ["b"], ["c"], ["d"], ["e"], ["f"]]);
  expect(wordsOf(`echo "a && b; c" 'd | e' g 2>&1 h&i`)).toEqual([
    ["echo", "a && b; c", "d | e", "g", "2>&1", "h&i"],
  ]);
});

it("joins a backslash-newline continuation into the same segment", () => {
  expect(wordsOf("dp spec \\\nlint x")).toEqual([["dp", "spec", "lint", "x"]]);
});

it.each([
  [["dp", "--part", "p1"], "--part", "p1"],
  [["dp", "--part=p1", "x"], "--part", "p1"],
  [["dp", "--part="], "--part", ""],
  [["dp", "--partial=p1"], "--part", null],
  [["dp", "x"], "--part", null],
  [["dp", "--part"], "--part", null],
] as const)("flagValue(%j, %s) is %j", (words, flag, expected) => {
  expect(flagValue(words, flag)).toBe(expected);
});

it("skips flags and the values of flags that take one when listing positionals", () => {
  const words = [
    "dp",
    "wave",
    "run",
    "2",
    "--part",
    "p1",
    "--dir=/d",
    "--json",
    "--spec",
    "s.md",
    "tail",
  ];
  expect(positionals(words, new Set(["--part", "--spec", "--dir"]))).toEqual([
    "wave",
    "run",
    "2",
    "tail",
  ]);
  expect(positionals(words, new Set())).toEqual(["wave", "run", "2", "p1", "s.md", "tail"]);
});

it("treats everything after -- and a lone - as positional", () => {
  expect(positionals(["dp", "-", "--", "--part", "x"], new Set(["--part"]))).toEqual([
    "-",
    "--part",
    "x",
  ]);
});

it.each([
  [["/usr/local/bin/dp", "spec"], "dp", true],
  [["dp"], "dp", true],
  [["dpx"], "dp", false],
  [["xdp"], "dp", false],
  [[], "dp", false],
  [["/p/scripts/push-state.sh", "read"], "scripts/push-state.sh", true],
  [["scripts/push-state.sh"], "scripts/push-state.sh", true],
  [["/p/myscripts/push-state.sh"], "scripts/push-state.sh", false],
  [["/p/other/push-state.sh"], "scripts/push-state.sh", false],
  [["push-state.sh"], "scripts/push-state.sh", false],
] as const)("invokes(%j, %s) is %s", (words, program, expected) => {
  expect(invokes(words, program)).toBe(expected);
});

it.each([
  ["/a/b", "c/d", "/a/b/c/d"],
  ["/a/b", "../c", "/a/c"],
  ["/a/b", "./c//d/", "/a/b/c/d"],
  ["/a/b", "/x/./y/../z", "/x/z"],
  ["/a/b", ".", "/a/b"],
  ["/a", "/", "/"],
] as const)("resolvePath(%s, %s) is %s", (cwd, path, expected) => {
  expect(resolvePath(cwd, path)).toBe(expected);
});
