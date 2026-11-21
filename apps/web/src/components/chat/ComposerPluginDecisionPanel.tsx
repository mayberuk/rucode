import { useAtom } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { DispatchDecisionCard, ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { memo, use, useEffect, useEffectEvent, useState } from "react";

import { useDeadlinePassed } from "~/hooks/useDeadline";
import { isInSideChatPane } from "~/lib/sideChatPane";
import { cn } from "~/lib/utils";
import {
  decisionAnswerCommand,
  decisionAnswerView,
  decisionContextLabel,
  type DecisionAnswerAttempt,
} from "~/pluginCards/decision/decisionPanel.logic";
import { answerPluginDecision } from "~/rpc/pluginCards";
import { useAtomCommand } from "~/state/use-atom-command";
import { CommandBlock } from "../CommandBlock";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { BackgroundThreadContext } from "./backgroundThread";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerOptionRow } from "./ComposerOptionRow";

// Outlives the panel, so a failure whose outcome is unknown still offers Try again after the
// panel remounts on reconnect or a thread switch.
const answerAttemptAtom = Atom.family((_key: string) =>
  Atom.make<DecisionAnswerAttempt | null>(null).pipe(Atom.keepAlive),
);

const UNCONFIRMED_ANSWER = "The connection dropped before the answer was confirmed.";
// Older servers can emit an identical failure after the 30-second recording window.
const REUSED_RETRY_WAIT_MS = 31_000;

export const ComposerPluginDecisionPanel = memo(function ComposerPluginDecisionPanel({
  decision,
  index,
  total,
  threadRef,
}: {
  decision: DispatchDecisionCard;
  index: number;
  total: number;
  threadRef: ScopedThreadRef;
}) {
  const data = decision.data;
  const [attempt, setAttempt] = useAtom(
    answerAttemptAtom(JSON.stringify([threadRef.environmentId, decision.id])),
  );
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const answerDecision = useAtomCommand(answerPluginDecision, { reportFailure: false });
  const backgroundThread = use(BackgroundThreadContext);
  const reusedRetryDeadlinePassed = useDeadlinePassed(
    attempt?.status === "sent" ? attempt.reusedRetryDeadline : null,
  );
  const view = decisionAnswerView(decision, attempt, reusedRetryDeadlinePassed);
  const busy = view.status === "posting" || view.status === "recording";
  const selectedKey = busy
    ? view.optionKey
    : (pickedKey ?? (view.status === "failed" ? view.optionKey : null));

  const send = async (optionKey: string) => {
    setAttempt({ status: "sending", optionKey });
    const result = await answerDecision({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, cardId: decision.id, optionKey },
    });
    if (result._tag === "Success") {
      setAttempt({
        status: "sent",
        optionKey,
        cardAtSend: decision,
        reusedRetryDeadline:
          result.value.delivery === "reused" &&
          data.answer?.status === "failed" &&
          data.answer.attemptId === undefined
            ? Date.now() + REUSED_RETRY_WAIT_MS
            : null,
      });
      return;
    }
    const error = isAtomCommandInterrupted(result) ? null : squashAtomCommandFailure(result);
    setAttempt({
      status: "failed",
      optionKey,
      cardAtSend: decision,
      message:
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : UNCONFIRMED_ANSWER,
    });
  };

  const progressStatus = data.answer?.status;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- retains reported server progress across panel remounts
  useEffect(() => {
    if (
      attempt?.status !== "sent" ||
      (progressStatus !== "posting" && progressStatus !== "recording")
    ) {
      return;
    }
    setAttempt((current) =>
      current === attempt ? { status: "reported", optionKey: attempt.optionKey } : current,
    );
  }, [attempt, progressStatus, setAttempt]);

  const pickFromShortcut = useEffectEvent((digit: number) => {
    const option = data.options[digit - 1];
    if (option) setPickedKey(option.key);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes a document keydown listener so digit keys pick an option
  useEffect(() => {
    if (busy || collapsed || backgroundThread) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (isInSideChatPane(target)) return;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (
        target instanceof HTMLElement &&
        target.closest(
          'select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [aria-modal="true"], [role="menu"], [role="combobox"], [data-slot$="popup"]',
        )
      ) {
        return;
      }
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
      event.preventDefault();
      pickFromShortcut(digit);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [backgroundThread, busy, collapsed]);

  const context = decisionContextLabel(data);

  return (
    <Collapsible open={!collapsed} onOpenChange={(open) => setCollapsed(!open)}>
      <CollapsibleTrigger
        render={<ComposerBanner.Row render={<button type="button" />} />}
        title={
          collapsed ? "Show the decision and its options" : "Hide the decision and its options"
        }
        className="px-4 py-1.5"
      >
        <ComposerBanner.Content>
          <span className="flex-none text-warning-foreground">Decision</span>
          <span className={cn("min-w-0 truncate text-muted-foreground", collapsed && "max-w-1/3")}>
            {context}
          </span>
          {collapsed ? (
            <>
              <ComposerBanner.Separator />
              <span className="min-w-0 flex-1 truncate text-secondary-label">{data.question}</span>
            </>
          ) : null}
        </ComposerBanner.Content>
        <ComposerBanner.Actions className="gap-0">
          {total > 1 ? (
            <ComposerBanner.Count>
              {index + 1}/{total}
            </ComposerBanner.Count>
          ) : null}
          <ComposerBanner.ToggleIcon expanded={!collapsed} />
        </ComposerBanner.Actions>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ComposerBanner.Scroll>
          <ComposerBanner.Body className="ps-6 pe-4 pb-1 wrap-anywhere sm:ps-5.5">
            <p className="pt-0.5 text-sm whitespace-pre-wrap text-foreground/85">{data.question}</p>
            <div className="-ms-2 mt-1.5 sm:-ms-1.5">
              {data.options.map((option, optionIndex) => (
                <ComposerOptionRow
                  key={option.key}
                  indicator="radio"
                  selected={selectedKey === option.key}
                  disabled={busy}
                  label={option.label}
                  description={option.recommended ? "Recommended" : undefined}
                  shortcutDigit={optionIndex < 9 ? optionIndex + 1 : null}
                  className="text-start"
                  onClick={() => setPickedKey(option.key)}
                />
              ))}
            </div>
            {data.answerable === "terminal-only" ? (
              selectedKey === null ? (
                <p className="py-1.5 text-xs text-secondary-label">
                  This chat cannot post the answer. Pick an option to get its terminal command.
                </p>
              ) : (
                <CommandBlock
                  command={decisionAnswerCommand(data, selectedKey)}
                  className="my-1.5"
                />
              )
            ) : (
              <div className="flex items-center gap-2 py-1.5">
                <p
                  role={view.status === "failed" ? "alert" : "status"}
                  className={cn(
                    "min-w-0 flex-1 text-xs",
                    view.status === "failed"
                      ? "text-destructive-foreground"
                      : "text-secondary-label",
                  )}
                >
                  {view.status === "failed"
                    ? view.message
                    : "Your answer is posted as a message in this chat."}
                </p>
                <Button
                  type="button"
                  variant={view.status === "failed" ? "ghost" : "default"}
                  size="xs"
                  disabled={busy || selectedKey === null}
                  onClick={() => {
                    if (selectedKey !== null) void send(selectedKey);
                  }}
                >
                  {busy ? "Recording answer…" : view.status === "failed" ? "Try again" : "Answer"}
                </Button>
              </div>
            )}
          </ComposerBanner.Body>
        </ComposerBanner.Scroll>
      </CollapsiblePanel>
    </Collapsible>
  );
});
