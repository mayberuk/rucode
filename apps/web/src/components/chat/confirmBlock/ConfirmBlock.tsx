import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { Fragment, useRef, useState, type KeyboardEvent } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { cn } from "~/lib/utils";
import { Badge } from "../../ui/badge";
import { ComposerOptionRow } from "../ComposerOptionRow";
import { CheckboxMark } from "../../ui/checkbox";
import { Kbd } from "../../ui/kbd";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import {
  buildConfirmReply,
  mergeConfirmReply,
  parseConfirmReply,
  splitInlineCode,
  toggleConfirmAnswer,
  type ConfirmAnswers,
  type ConfirmQuestion,
  type ConfirmSection,
} from "./confirmBlock.logic";

const MAX_DIGIT_OPTIONS = 9;
// A segmented toggle cannot wrap its label, so longer options stack as rows. About 24 characters
// plus a "my pick" chip is what fits a phone-width column.
const STACK_LABEL_CHARS = 24;
const NO_ANSWERS: ConfirmAnswers = new Map();

function InlineText({ text }: { text: string }) {
  return splitInlineCode(text).map((segment, index) => (
    // oxlint-disable-next-line react/no-array-index-key -- segments of one static string
    <Fragment key={index}>{segment.code ? <code>{segment.text}</code> : segment.text}</Fragment>
  ));
}

// Drawn like ComposerOptionRow's radio: ui/radio-group's Radio only checks inside a RadioGroup.
function OptionRadio({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex size-4.5 shrink-0 items-center justify-center rounded-full border border-foreground/55 bg-background not-dark:bg-clip-padding sm:size-4 dark:bg-input/32",
        checked ? "shadow-none" : "shadow-xs/5",
      )}
    >
      {checked ? (
        <span className="-inset-px absolute flex items-center justify-center rounded-full bg-primary before:size-2 before:rounded-full before:bg-primary-foreground sm:before:size-1.5" />
      ) : null}
    </span>
  );
}

export function ConfirmBlock({
  section,
  mode,
  threadRef,
}: {
  section: ConfirmSection;
  mode: "answerable" | "readonly";
  threadRef: ScopedThreadRef | undefined;
}) {
  const gt = useGT();
  const { questions } = section;
  const answerable = mode === "answerable" && threadRef !== undefined;
  const answerableNumbers = questions.filter((q) => q.kind !== "open").map((q) => q.number);
  const prompt = useComposerDraftStore((state) =>
    answerable ? (state.getComposerDraft(threadRef)?.prompt ?? "") : "",
  );
  const answers = answerable ? parseConfirmReply(questions, prompt).answers : NO_ANSWERS;
  const [focusedRow, setFocusedRow] = useState(answerableNumbers[0]);
  const rootRef = useRef<HTMLDivElement>(null);

  const focusRow = (number: number, preventScroll = false) => {
    rootRef.current
      ?.querySelector<HTMLElement>(`[data-confirm-row="${number}"]`)
      ?.focus({ preventScroll });
  };

  const pick = (question: ConfirmQuestion, optionIndex: number): ConfirmAnswers | null => {
    if (!answerable || threadRef === undefined) return null;
    const store = useComposerDraftStore.getState();
    const draft = store.getComposerDraft(threadRef)?.prompt ?? "";
    const current = parseConfirmReply(questions, draft);
    const next = toggleConfirmAnswer(question, current.answers, optionIndex);
    if (next === current.answers) return null;
    store.setPrompt(
      threadRef,
      mergeConfirmReply(draft, current.reply, buildConfirmReply(questions, next)),
    );
    return next;
  };

  const select = (question: ConfirmQuestion, optionIndex: number) => {
    setFocusedRow(question.number);
    pick(question, optionIndex);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!answerable || event.metaKey || event.ctrlKey || event.altKey) return;
    if (!(event.target instanceof Element)) return;
    const row = event.target.closest<HTMLElement>("[data-confirm-row]");
    if (!row) return;
    const number = Number(row.dataset.confirmRow);

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const position = answerableNumbers.indexOf(number);
      const step = event.key === "ArrowDown" ? 1 : -1;
      const target =
        answerableNumbers[Math.min(answerableNumbers.length - 1, Math.max(0, position + step))];
      event.preventDefault();
      if (target !== undefined) focusRow(target);
      return;
    }

    if (!/^[1-9]$/.test(event.key)) return;
    const question = questions.find((q) => q.number === number);
    if (!question || Number(event.key) > question.options.length) return;
    event.preventDefault();
    const next = pick(question, Number(event.key) - 1);
    if (!next || question.multiple || !next.has(number)) return;
    const later = answerableNumbers.find((n) => n > number && !next.has(n));
    if (later !== undefined) focusRow(later);
  };

  const answeredCount = answerableNumbers.filter((n) => answers.has(n)).length;
  const hintDigits = Array.from(
    {
      length: Math.min(
        MAX_DIGIT_OPTIONS,
        questions.find((q) => q.number === focusedRow)?.options.length ?? 0,
      ),
    },
    (_, offset) => offset + 1,
  );

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={gt("Questions from the agent")}
      className="group/confirm mt-4 border-t border-border/60"
      onKeyDown={handleKeyDown}
    >
      {questions.map((question, position) => {
        const showGroupLabel = questions[position - 1]?.groupLabel !== question.groupLabel;
        const rowAnswerable = answerable && question.kind !== "open";
        const picked = answers.get(question.number) ?? [];
        return (
          <Fragment key={question.number}>
            {showGroupLabel ? (
              <div className="pt-3 pb-1 text-xs font-medium text-muted-foreground">
                {question.groupLabel}
              </div>
            ) : null}
            <div
              data-confirm-row={question.number}
              {...(rowAnswerable
                ? {
                    role: "group",
                    tabIndex: question.number === focusedRow ? 0 : -1,
                    "aria-label": gt("Question {number}: {text}", {
                      number: question.number,
                      text: question.text,
                    }),
                    "aria-keyshortcuts": question.options
                      .slice(0, MAX_DIGIT_OPTIONS)
                      .map((_, index) => index + 1)
                      .join(" "),
                    onFocus: () => setFocusedRow(question.number),
                  }
                : {})}
              className="-mx-1 grid grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5 rounded-md px-1 py-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
            >
              <span className="self-start text-sm leading-relaxed text-muted-foreground tabular-nums">
                {question.number}
              </span>
              <span className="min-w-0 text-sm leading-relaxed text-foreground/90">
                <InlineText text={question.text} />
                {question.multiple ? (
                  <span className="text-muted-foreground"> {gt("Pick any")}</span>
                ) : null}
              </span>
              {question.kind === "choice" &&
              question.options.some((option) => option.label.length > STACK_LABEL_CHARS) ? (
                <div
                  role="group"
                  aria-label={gt("Answers to question {number}", { number: question.number })}
                  className="col-start-2 flex min-w-0 flex-col"
                >
                  {question.options.map((option, index) => (
                    <ComposerOptionRow
                      // oxlint-disable-next-line react/no-array-index-key -- options are positional and the agent may repeat a label
                      key={index}
                      indicator={question.multiple ? "checkbox" : "radio"}
                      selected={picked.includes(index)}
                      disabled={!answerable}
                      label={splitInlineCode(option.label)
                        .map((segment) => segment.text)
                        .join("")}
                      description={option.suggested ? gt("my pick") : undefined}
                      shortcutDigit={null}
                      className="text-start"
                      onClick={() => select(question, index)}
                    />
                  ))}
                </div>
              ) : question.kind === "open" ? null : (
                <ToggleGroup
                  aria-label={gt("Answers to question {number}", { number: question.number })}
                  multiple={question.multiple}
                  value={picked.map(String)}
                  className="col-start-2 max-w-full flex-wrap justify-self-start"
                >
                  {question.options.map((option, index) => (
                    <Toggle
                      // oxlint-disable-next-line react/no-array-index-key -- options are positional and the agent may repeat a label
                      key={index}
                      value={String(index)}
                      tabIndex={-1}
                      disabled={!answerable}
                      onClick={() => select(question, index)}
                    >
                      {question.multiple ? (
                        <CheckboxMark checked={picked.includes(index)} variant="contrast" />
                      ) : (
                        <OptionRadio checked={picked.includes(index)} />
                      )}
                      <span>
                        {question.kind === "yes-no" ? (
                          option.reply === "yes" ? (
                            gt("Yes")
                          ) : (
                            gt("No")
                          )
                        ) : (
                          <InlineText text={option.label} />
                        )}
                      </span>
                      {option.suggested ? <Badge variant="secondary">{gt("my pick")}</Badge> : null}
                    </Toggle>
                  ))}
                </ToggleGroup>
              )}
            </div>
          </Fragment>
        );
      })}
      {answerable && answerableNumbers.length > 0 ? (
        <div className="mt-1 flex h-7 items-center justify-between text-xs text-muted-foreground">
          <span className="tabular-nums">
            {gt("{answered} of {total} answered", {
              answered: answeredCount,
              total: answerableNumbers.length,
            })}
          </span>
          <span className="flex items-center gap-1.5 opacity-0 transition-opacity duration-150 ease-out group-focus-within/confirm:opacity-100 motion-reduce:transition-none">
            <span className="flex items-center gap-1">
              {hintDigits.map((digit) => (
                <Kbd key={digit}>{digit}</Kbd>
              ))}
            </span>
            <span>{gt("Pick")}</span>
            <Kbd className="ml-2">↑</Kbd>
            <Kbd>↓</Kbd>
            <span>{gt("Question")}</span>
          </span>
        </div>
      ) : null}
    </div>
  );
}
