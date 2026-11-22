// @effect-diagnostics nodeBuiltinImport:off - pure string helper, and Path is an Effect service.
import * as NodePathPosix from "node:path/posix";

export interface CommandSegment {
  readonly words: ReadonlyArray<string>;
  readonly cwd: string;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(["bash", "sh", "env"]);

export function resolvePath(cwd: string, path: string): string {
  const joined = NodePathPosix.isAbsolute(path)
    ? NodePathPosix.normalize(path)
    : NodePathPosix.join(cwd, path);
  return joined.length > 1 && joined.endsWith("/") ? joined.slice(0, -1) : joined;
}

const basename = (word: string) => word.slice(word.lastIndexOf("/") + 1);

/** Splits into raw words per segment. A `$(...)` or backtick span stays inside its word. */
function tokenize(command: string): Array<Array<string>> {
  const segments: Array<Array<string>> = [];
  let words: Array<string> = [];
  let word = "";
  let inWord = false;

  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };

  /** Copies raw text from `start` up to and including the closer matching `open`; returns the next index. */
  const copySubstitution = (start: number, open: "(" | "`"): number => {
    let depth = 1;
    let index = start;
    while (index < command.length && depth > 0) {
      const char = command[index]!;
      if (char === "\\") {
        word += command.slice(index, index + 2);
        index += 2;
        continue;
      }
      if (open === "`") {
        if (char === "`") depth = 0;
      } else if (char === "'" || char === '"') {
        const close = command.indexOf(char, index + 1);
        const end = close === -1 ? command.length : close + 1;
        word += command.slice(index, end);
        index = end;
        continue;
      } else if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      word += char;
      index += 1;
    }
    return index;
  };

  let index = 0;
  while (index < command.length) {
    const char = command[index]!;
    const next = command[index + 1];

    if (char === "\\") {
      if (next === "\n") index += 2;
      else {
        if (next !== undefined) word += next;
        inWord = true;
        index += 2;
      }
    } else if (char === "'") {
      const close = command.indexOf("'", index + 1);
      const end = close === -1 ? command.length : close;
      word += command.slice(index + 1, end);
      inWord = true;
      index = end + 1;
    } else if (char === '"') {
      inWord = true;
      index += 1;
      while (index < command.length && command[index] !== '"') {
        const inner = command[index]!;
        const after = command[index + 1];
        if (inner === "\\" && after !== undefined && '"\\$`\n'.includes(after)) {
          if (after !== "\n") word += after;
          index += 2;
        } else if (inner === "$" && after === "(") {
          word += "$(";
          index = copySubstitution(index + 2, "(");
        } else if (inner === "`") {
          word += "`";
          index = copySubstitution(index + 1, "`");
        } else {
          word += inner;
          index += 1;
        }
      }
      index += 1;
    } else if (char === "$" && next === "(") {
      word += "$(";
      inWord = true;
      index = copySubstitution(index + 2, "(");
    } else if (char === "`") {
      word += "`";
      inWord = true;
      index = copySubstitution(index + 1, "`");
    } else if (char === " " || char === "\t" || char === "\r") {
      endWord();
      index += 1;
    } else if (char === "\n" || char === ";") {
      endSegment();
      index += 1;
    } else if (char === "|") {
      endSegment();
      index += next === "|" ? 2 : 1;
    } else if (char === "&" && next === "&") {
      endSegment();
      index += 2;
    } else {
      word += char;
      inWord = true;
      index += 1;
    }
  }
  endSegment();
  return segments;
}

function programWords(raw: ReadonlyArray<string>): ReadonlyArray<string> {
  let start = 0;
  while (start < raw.length && ASSIGNMENT.test(raw[start]!)) start += 1;
  const first = raw[start];
  if (first === undefined || !WRAPPERS.has(basename(first))) return raw.slice(start);
  start += 1;
  if (basename(first) === "env") {
    while (start < raw.length && ASSIGNMENT.test(raw[start]!)) start += 1;
  }
  return raw.slice(start);
}

/** A `cd` target that can be resolved without a shell: no `~`, `$`, `-` or backtick. */
const isResolvableDirectory = (target: string) =>
  target !== "-" && !target.startsWith("~") && !/[$`]/.test(target);

export function commandSegments(command: string, cwd: string): ReadonlyArray<CommandSegment> {
  const segments: Array<CommandSegment> = [];
  let current = cwd;
  for (const raw of tokenize(command)) {
    const words = programWords(raw);
    if (words.length === 0) continue;
    segments.push({ words, cwd: current });
    const target = words[1];
    if (words[0] === "cd" && target !== undefined && isResolvableDirectory(target)) {
      current = resolvePath(current, target);
    }
  }
  return segments;
}

export function invokes(words: ReadonlyArray<string>, program: string): boolean {
  const first = words[0];
  if (first === undefined) return false;
  if (!program.includes("/")) return basename(first) === program;
  return first === program || first.endsWith(`/${program}`);
}

export function flagValue(words: ReadonlyArray<string>, flag: string): string | null {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === flag) return words[index + 1] ?? null;
    if (word.startsWith(`${flag}=`)) return word.slice(flag.length + 1);
  }
  return null;
}

/** The arguments after the program (`words[0]`) that are neither flags nor the values of `flagsWithValues`. */
export function positionals(
  words: ReadonlyArray<string>,
  flagsWithValues: ReadonlySet<string>,
): ReadonlyArray<string> {
  const found: Array<string> = [];
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === "--") {
      found.push(...words.slice(index + 1));
      break;
    }
    if (word.startsWith("-") && word !== "-") {
      if (flagsWithValues.has(word)) index += 1;
      continue;
    }
    found.push(word);
  }
  return found;
}
