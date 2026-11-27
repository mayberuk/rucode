import { ThreadId, type TurnItemId } from "@t3tools/contracts";

export interface CodexExecCommand {
  readonly ephemeral: boolean;
  readonly cd: string | null;
  readonly prompt:
    | { readonly kind: "inline"; readonly text: string }
    | { readonly kind: "file"; readonly path: string }
    | null;
}

interface ShellWord {
  readonly kind: "word";
  readonly text: string;
  readonly dynamic: boolean;
  readonly assignment: boolean;
}

type ShellToken =
  | ShellWord
  | { readonly kind: "redirect"; readonly operator: string; readonly fd: string }
  | { readonly kind: "separator"; readonly operator: string };

type ShellQuote = "'" | '"' | "`" | null;

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const ASSIGNMENT_WITH_CONTINUATIONS = /^[A-Za-z_](?:[A-Za-z0-9_]|\\\n)*=/;
const WORD_BREAK = /[ \t\r\n|;&<>()]/;
const DOUBLE_QUOTED_ESCAPE = /["\\$`]/;

function readShellWord(source: string, start: number): { word: ShellWord; end: number } | null {
  let text = "";
  let dynamic = false;
  let quote: ShellQuote = null;
  const substitutionQuotes: ShellQuote[] = [];
  let quoteBeforeBackticks: ShellQuote = null;
  let end = start;

  for (; end < source.length; end++) {
    const character = source[end]!;
    const inSubstitution = substitutionQuotes.length > 0;
    if (quote === null && !inSubstitution && WORD_BREAK.test(character)) break;

    if (character === "\\" && quote !== "'") {
      const next = source[end + 1];
      if (next === undefined) return null;
      if (next === "\n") {
        end++;
        continue;
      }
      if (quote !== '"' || DOUBLE_QUOTED_ESCAPE.test(next)) {
        if (!inSubstitution && quote !== "`") text += next;
        end++;
        continue;
      }
    }

    if (quote === "`") {
      if (character === "`") quote = quoteBeforeBackticks;
      continue;
    }
    if (character === quote) {
      quote = null;
      continue;
    }
    if (quote !== "'") {
      if (character === "`") {
        if (!inSubstitution) {
          dynamic = true;
          text += "`";
        }
        quoteBeforeBackticks = quote;
        quote = "`";
        continue;
      }
      if (character === "$" && source[end + 1] === "(") {
        if (!inSubstitution) {
          dynamic = true;
          text += "$(";
        }
        substitutionQuotes.push(quote);
        quote = null;
        end++;
        continue;
      }
      if (quote === null) {
        if (inSubstitution && character === "(") {
          substitutionQuotes.push(null);
          continue;
        }
        if (inSubstitution && character === ")") {
          quote = substitutionQuotes.pop() ?? null;
          continue;
        }
        if (character === "'" || character === '"') {
          quote = character;
          continue;
        }
      }
    }

    if (!inSubstitution) text += character;
  }

  if (quote !== null || substitutionQuotes.length > 0) return null;
  return {
    word: {
      kind: "word",
      text,
      dynamic,
      assignment: ASSIGNMENT_WITH_CONTINUATIONS.test(source.slice(start, end)),
    },
    end,
  };
}

function tokenizeShell(source: string): ShellToken[] | null {
  const tokens: ShellToken[] = [];
  const redirect = /([0-9]*)(<<<|<<-|<<|<&|<>|<|>>|>&|>\||>|&>>|&>)/y;
  const separator = /&&|\|\||\|&|[|;&()]/y;
  let index = 0;

  while (index < source.length) {
    const character = source[index];
    if (source.startsWith("\\\n", index)) {
      index += 2;
      continue;
    }
    if (character === " " || character === "\t" || character === "\r") {
      index++;
      continue;
    }
    if (character === "\n" && tokens.length === 0) {
      index++;
      continue;
    }
    if (character === "\n" || character === "#") break;

    redirect.lastIndex = index;
    const redirection = redirect.exec(source);
    if (redirection) {
      tokens.push({ kind: "redirect", fd: redirection[1]!, operator: redirection[2]! });
      index = redirect.lastIndex;
      continue;
    }

    separator.lastIndex = index;
    const delimiter = separator.exec(source);
    if (delimiter) {
      tokens.push({ kind: "separator", operator: delimiter[0] });
      index = separator.lastIndex;
      if (delimiter[0] !== "|" && delimiter[0] !== "|&" && delimiter[0] !== "&&") break;
      continue;
    }

    const result = readShellWord(source, index);
    if (result === null) return null;
    tokens.push(result.word);
    index = result.end;
  }

  return tokens;
}

function codexExecArgumentIndex(words: readonly ShellWord[]): number | null {
  let index = 0;
  while (words[index]?.assignment) index++;

  while (index < words.length) {
    const executable = words[index++]!;
    if (executable.dynamic) return null;
    switch (executable.text) {
      case "env":
        if (words[index]?.text === "-i" || words[index]?.text === "--ignore-environment") index++;
        if (words[index]?.text === "--") index++;
        while (ASSIGNMENT.test(words[index]?.text ?? "")) index++;
        break;
      case "command":
        if (words[index]?.text === "-p") index++;
        if (words[index]?.text === "--") index++;
        break;
      case "nice":
        if (words[index]?.text === "-n") {
          index++;
          if (!/^[+-]?\d+$/.test(words[index++]?.text ?? "")) return null;
        } else if (/^-\d+$/.test(words[index]?.text ?? "")) {
          index++;
        }
        if (words[index]?.text === "--") index++;
        break;
      case "timeout":
        if (words[index]?.text === "--") index++;
        if (!/^(?:\d+(?:\.\d*)?|\.\d+)[smhd]?$/.test(words[index++]?.text ?? "")) return null;
        break;
      case "codex": {
        const subcommand = words[index];
        return subcommand &&
          !subcommand.dynamic &&
          (subcommand.text === "exec" || subcommand.text === "e")
          ? index + 1
          : null;
      }
      default:
        return null;
    }
  }
  return null;
}

const VALUE_OPTIONS = new Set([
  "-m",
  "--model",
  "-c",
  "--config",
  "-s",
  "--sandbox",
  "-o",
  "--output-last-message",
  "-p",
  "--profile",
  "-i",
  "--image",
  "--color",
  "--output-schema",
]);

function parseCodexStage(
  tokens: readonly ShellToken[],
  leadingCd: string | null,
  pipedIn: boolean,
): CodexExecCommand | null {
  const words: ShellWord[] = [];
  let stdin: Extract<CodexExecCommand["prompt"], { kind: "file" }> | "unknown" | null = null;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.kind === "word") {
      words.push(token);
      continue;
    }
    if (token.kind !== "redirect") return null;
    const target = tokens[++index];
    if (target?.kind !== "word") return null;
    const redirectsStdin =
      token.fd === "" ? token.operator.startsWith("<") : Number(token.fd) === 0;
    if (redirectsStdin) {
      stdin =
        token.operator === "<" && !target.dynamic ? { kind: "file", path: target.text } : "unknown";
    }
  }

  const argumentIndex = codexExecArgumentIndex(words);
  if (argumentIndex === null) return null;
  let cd = leadingCd;
  let ephemeral = false;
  let positional: ShellWord | undefined;
  let options = true;

  for (let index = argumentIndex; index < words.length; index++) {
    const word = words[index]!;
    if (!options || !word.text.startsWith("-") || word.text === "-") {
      positional ??= word;
      continue;
    }
    if (word.text === "--") {
      options = false;
      continue;
    }
    if (word.text === "--ephemeral") {
      ephemeral = true;
      continue;
    }

    const equals = word.text.indexOf("=");
    const option = equals === -1 ? word.text : word.text.slice(0, equals);
    const directoryOption = option === "-C" || option === "--cd";
    if (!directoryOption && !VALUE_OPTIONS.has(option)) continue;
    const value =
      equals === -1 ? words[++index] : { text: word.text.slice(equals + 1), dynamic: word.dynamic };
    if (!value || (equals === -1 && value.text.startsWith("-") && value.text !== "-")) return null;
    if (directoryOption) {
      if (value.dynamic) return null;
      cd = value.text;
    }
  }

  let prompt: CodexExecCommand["prompt"] = null;
  if (!pipedIn && stdin !== "unknown" && !positional?.dynamic) {
    prompt =
      positional === undefined || positional.text === "-"
        ? stdin
        : { kind: "inline", text: positional.text };
  }
  return { ephemeral, cd, prompt };
}

export function parseCodexExecCommand(command: string): CodexExecCommand | null {
  const tokens = tokenizeShell(command);
  if (!tokens) return null;

  const [first, directory, separator] = tokens;
  const hasLeadingCd =
    first?.kind === "word" &&
    first.text === "cd" &&
    directory?.kind === "word" &&
    separator?.kind === "separator" &&
    separator.operator === "&&";
  if (hasLeadingCd && directory.dynamic) return null;

  const leadingCd = hasLeadingCd ? directory.text : null;
  let start = hasLeadingCd ? 3 : 0;
  let pipedIn = false;
  let result: CodexExecCommand | null = null;

  for (let end = start; end <= tokens.length; end++) {
    const token = tokens[end];
    if (token && token.kind !== "separator") continue;
    if (start === end) return null;
    result ??= parseCodexStage(tokens.slice(start, end), leadingCd, pipedIn);
    if (token?.operator !== "|" && token?.operator !== "|&") return result;
    start = end + 1;
    pipedIn = true;
  }
  return result;
}

export function codexRunThreadId(parentThreadId: ThreadId, itemId: TurnItemId): ThreadId {
  return ThreadId.make(`codex-run:${parentThreadId}:${itemId}`);
}
