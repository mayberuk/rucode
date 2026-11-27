export type ConfirmGroup = "just-confirm" | "needs-your-call";

export interface ConfirmOption {
  /** As written, with "(my pick)" stripped. */
  readonly label: string;
  /** Text placed in the reply. */
  readonly reply: string;
  /** The line ended "(my pick)". */
  readonly suggested: boolean;
}

export interface ConfirmQuestion {
  /** 1..N across both groups. */
  readonly number: number;
  readonly group: ConfirmGroup;
  /** "Just confirm" or "Needs your call", as the agent wrote it. */
  readonly groupLabel: string;
  readonly text: string;
  readonly kind: "yes-no" | "choice" | "open";
  /** True only for a "Pick any:" question that has answer lines. */
  readonly multiple: boolean;
  readonly options: ReadonlyArray<ConfirmOption>;
}

export interface ConfirmSection {
  /** Text before the section, trailing whitespace trimmed; always a prefix of the input. */
  readonly body: string;
  readonly questions: ReadonlyArray<ConfirmQuestion>;
}

/** Question number to picked option indexes. */
export type ConfirmAnswers = ReadonlyMap<number, ReadonlyArray<number>>;

const QUESTION_LINE =
  /^ {0,3}\*\*(Just confirm|Needs your call)\s+[—–-]\s+([1-9]\d{0,8})\.\s+(\S.*?)\*\*[ \t]*$/;
const ANSWER_LINE = /^ {0,3}- +(\S.*)$/;
const FENCE_OPENER = /^ {0,3}(?:`{3,}|~{3,})/;
const PICK_ANY_PREFIX = /^pick any:\s*/i;
const MY_PICK_SUFFIX = /\s*\(my pick\)\s*$/i;

const YES_NO_OPTIONS: ReadonlyArray<ConfirmOption> = [
  { label: "Yes", reply: "yes", suggested: false },
  { label: "No", reply: "no", suggested: false },
];

interface DraftQuestion {
  readonly label: string;
  readonly number: number;
  readonly text: string;
  readonly answers: string[];
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function buildQuestion(draft: DraftQuestion): ConfirmQuestion | null {
  const group: ConfirmGroup = draft.label === "Just confirm" ? "just-confirm" : "needs-your-call";
  const text = draft.text.replace(PICK_ANY_PREFIX, "").trim();
  if (text === "") return null;

  const options: ConfirmOption[] = [];
  for (const answer of draft.answers) {
    const label = answer.replace(MY_PICK_SUFFIX, "").trim();
    if (label === "") return null;
    options.push({ label, reply: label, suggested: label !== answer.trim() });
  }

  const base = { number: draft.number, group, groupLabel: draft.label, text };
  if (options.length > 0) {
    return {
      ...base,
      kind: "choice",
      multiple: PICK_ANY_PREFIX.test(draft.text),
      options,
    };
  }
  return group === "just-confirm"
    ? { ...base, kind: "yes-no", multiple: false, options: YES_NO_OPTIONS }
    : { ...base, kind: "open", multiple: false, options: [] };
}

export function parseConfirmSection(text: string): ConfirmSection | null {
  if (!text.includes("**Just confirm") && !text.includes("**Needs your call")) return null;

  // Offsets come from the original text so `body` stays a prefix of it; matching ignores "\r".
  const rawLines = text.split("\n");
  const lines = rawLines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));

  let start = lines.length;
  while (
    start > 0 &&
    (isBlank(lines[start - 1]!) ||
      QUESTION_LINE.test(lines[start - 1]!) ||
      ANSWER_LINE.test(lines[start - 1]!))
  ) {
    start -= 1;
  }
  while (start < lines.length && isBlank(lines[start]!)) start += 1;
  if (start >= lines.length || !QUESTION_LINE.test(lines[start]!)) return null;

  let fenceLines = 0;
  for (let index = 0; index < start; index += 1) {
    if (FENCE_OPENER.test(lines[index]!)) fenceLines += 1;
  }
  if (fenceLines % 2 === 1) return null;

  const drafts: DraftQuestion[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]!;
    const questionMatch = QUESTION_LINE.exec(line);
    if (questionMatch) {
      drafts.push({
        label: questionMatch[1]!,
        number: Number(questionMatch[2]),
        text: questionMatch[3]!,
        answers: [],
      });
      continue;
    }
    const answerMatch = ANSWER_LINE.exec(line);
    if (answerMatch) drafts[drafts.length - 1]!.answers.push(answerMatch[1]!);
  }

  const questions: ConfirmQuestion[] = [];
  for (const [index, draft] of drafts.entries()) {
    if (draft.number !== index + 1) return null;
    const built = buildQuestion(draft);
    if (!built) return null;
    questions.push(built);
  }

  const offset = rawLines.slice(0, start).reduce((sum, line) => sum + line.length + 1, 0);
  return { body: text.slice(0, offset).trimEnd(), questions };
}

export function toggleConfirmAnswer(
  question: ConfirmQuestion,
  answers: ConfirmAnswers,
  optionIndex: number,
): ConfirmAnswers {
  if (
    question.kind === "open" ||
    !Number.isInteger(optionIndex) ||
    optionIndex < 0 ||
    optionIndex >= question.options.length
  ) {
    return answers;
  }

  const current = answers.get(question.number) ?? [];
  const picked = current.includes(optionIndex);
  let next: ReadonlyArray<number>;
  if (question.multiple) {
    next = picked
      ? current.filter((index) => index !== optionIndex)
      : [...current, optionIndex].toSorted((a, b) => a - b);
  } else {
    next = picked ? [] : [optionIndex];
  }

  const result = new Map(answers);
  if (next.length === 0) result.delete(question.number);
  else result.set(question.number, next);
  return result;
}

export function buildConfirmReply(
  questions: ReadonlyArray<ConfirmQuestion>,
  answers: ConfirmAnswers,
): string {
  const lines: string[] = [];
  for (const question of questions.toSorted((a, b) => a.number - b.number)) {
    if (question.kind === "open") continue;
    const replies = (answers.get(question.number) ?? [])
      .toSorted((a, b) => a - b)
      .flatMap((index) => question.options[index]?.reply ?? []);
    if (replies.length > 0) lines.push(`${question.number}. ${replies.join(", ")}`);
  }
  return lines.join("\n");
}

const REPLY_LINE = /^(\d+)\. (.+)$/;

function matchReplies(
  options: ReadonlyArray<ConfirmOption>,
  from: number,
  text: string,
): number[] | null {
  for (let index = from; index < options.length; index += 1) {
    const reply = options[index]!.reply;
    if (text === reply) return [index];
    if (text.startsWith(`${reply}, `)) {
      const rest = matchReplies(options, index + 1, text.slice(reply.length + 2));
      if (rest) return [index, ...rest];
    }
  }
  return null;
}

/**
 * Reads back the reply `buildConfirmReply` wrote at the start of a composer draft: the answers it
 * holds, and its exact text. Reading stops at the first line that is not an answer to a question.
 */
export function parseConfirmReply(
  questions: ReadonlyArray<ConfirmQuestion>,
  prompt: string,
): { readonly answers: ConfirmAnswers; readonly reply: string } {
  const answers = new Map<number, ReadonlyArray<number>>();
  const lines = prompt.split("\n");
  let consumed = 0;
  let previous = 0;
  for (const line of lines) {
    const match = REPLY_LINE.exec(line);
    if (!match) break;
    const number = Number(match[1]);
    const question = questions.find((candidate) => candidate.number === number);
    if (number <= previous || !question || question.kind === "open") break;
    const single = question.options.findIndex((option) => option.reply === match[2]);
    const picked = question.multiple
      ? matchReplies(question.options, 0, match[2]!)
      : single >= 0
        ? [single]
        : null;
    if (!picked) break;
    answers.set(number, picked);
    previous = number;
    consumed += 1;
  }
  return { answers, reply: lines.slice(0, consumed).join("\n") };
}

export function mergeConfirmReply(
  prompt: string,
  previousReply: string,
  nextReply: string,
): string {
  const remainder =
    previousReply !== "" && prompt.startsWith(previousReply)
      ? prompt.slice(previousReply.length)
      : prompt;
  const rest = remainder.replace(/^\n+/, "");
  if (nextReply === "") return rest;
  return rest === "" ? nextReply : `${nextReply}\n\n${rest}`;
}

export interface InlineSegment {
  readonly text: string;
  readonly code: boolean;
}

/** Splits agent text on backtick spans; an unpaired backtick stays plain text. */
export function splitInlineCode(text: string): ReadonlyArray<InlineSegment> {
  return text
    .split(/`([^`]+)`/)
    .map((part, index) => ({ text: part, code: index % 2 === 1 }))
    .filter((segment) => segment.text !== "");
}
