import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { HandIcon } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel } from "~/components/ui/collapsible";
import { toastManager } from "~/components/ui/toast";
import { answerPluginDecision } from "~/rpc/pluginCards";
import { useAtomCommand } from "~/state/use-atom-command";

import type { InitiativeNeedsYouItem } from "../liveStateIndex";
import { minutesUntil, primaryOptionKey } from "./board.logic";

export function NeedsYouGroup({
  environmentId,
  items,
  now,
}: {
  readonly environmentId: EnvironmentId;
  readonly items: ReadonlyArray<InitiativeNeedsYouItem>;
  readonly now: string;
}) {
  const gt = useGT();
  const headingId = useId();
  const answerDecision = useAtomCommand(answerPluginDecision, { reportFailure: false });
  const canAnswer = useAtomValue(answerPluginDecision.permissionAtom(environmentId));
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
  const visibleCount = items.filter(({ cardId }) => !answered.has(cardId)).length;

  const pickOption = (
    item: InitiativeNeedsYouItem,
    { key: optionKey, label }: InitiativeNeedsYouItem["options"][number],
  ) => {
    const { cardId, threadId } = item;
    if (threadId === null || answered.has(cardId)) return;

    setAnswered((current) => new Set(current).add(cardId));
    const restore = () => {
      setAnswered((current) => {
        const next = new Set(current);
        next.delete(cardId);
        return next;
      });
    };
    const send = async () => {
      const result = await answerDecision({
        environmentId,
        input: { threadId, cardId, optionKey },
      });
      if (result._tag === "Success") return;
      restore();
      const error = isAtomCommandInterrupted(result) ? null : squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: gt("Couldn't confirm your answer was sent"),
        description:
          error === null
            ? gt("Check the decision in its chat.")
            : error instanceof Error
              ? error.message
              : String(error),
      });
    };

    let pending = true;
    const id = toastManager.add({
      title: gt("Answered: {option}", { option: label }),
      description: item.question,
      timeout: 6000,
      actionProps: {
        children: gt("Undo"),
        onClick: () => {
          if (!pending) return;
          pending = false;
          toastManager.close(id);
          restore();
        },
      },
      onClose: () => {
        if (!pending) return;
        pending = false;
        void send();
      },
    });
  };

  return (
    <Collapsible open={visibleCount > 0} className="empty:hidden">
      <CollapsiblePanel inert={visibleCount === 0}>
        <section aria-labelledby={headingId}>
          <div className="flex h-8 items-center gap-2 px-2.5 text-xs font-medium text-sidebar-foreground/80">
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
            <h3 id={headingId}>{gt("Needs you")}</h3>
            <span className="ms-auto font-normal text-muted-foreground tabular-nums">
              {visibleCount}
            </span>
          </div>
          {items.map((item) => {
            const open = !answered.has(item.cardId);
            const primaryKey = primaryOptionKey(item);
            const defaultOption = item.options.find(({ key }) => key === item.defaultKey);
            let continuation = null;
            if (item.applyAfter !== null && defaultOption !== undefined) {
              const minutes = minutesUntil(item.applyAfter, now);
              continuation =
                minutes > 0
                  ? gt(
                      "Continues with {option} in {minutes, plural, one {# minute} other {# minutes}}",
                      {
                        option: defaultOption.label,
                        minutes,
                      },
                    )
                  : gt("Continuing with {option}", { option: defaultOption.label });
            }
            const details = [
              item.part,
              continuation,
              item.protection === null ? null : gt("Asks for confirmation in its chat"),
            ]
              .filter(Boolean)
              .join(" · ");

            return (
              <Collapsible key={item.cardId} open={open}>
                <CollapsiblePanel inert={!open}>
                  <div className="flex items-start gap-2.5 rounded-lg px-2.5 py-2">
                    <HandIcon
                      aria-hidden
                      className="mt-0.5 size-4 shrink-0 text-warning-foreground"
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-2.5 sm:flex-row sm:items-start">
                      <div className="min-w-0 flex-1 wrap-anywhere">
                        <p className="text-sm text-foreground">{item.question}</p>
                        {details && <p className="text-xs text-muted-foreground">{details}</p>}
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-1.5 max-sm:w-full sm:max-w-1/2">
                        {item.answerableInPlace && canAnswer ? (
                          item.options.map((option) => (
                            <Button
                              key={option.key}
                              size="xs"
                              variant={option.key === primaryKey ? "default" : "outline"}
                              onClick={() => pickOption(item, option)}
                            >
                              {option.label}
                            </Button>
                          ))
                        ) : item.threadId !== null ? (
                          <Button
                            variant="outline"
                            size="xs"
                            render={
                              <Link
                                to="/$environmentId/$threadId"
                                params={{ environmentId, threadId: item.threadId }}
                              />
                            }
                          >
                            {gt("Open chat")}
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {gt("Answer it where it was asked")}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </CollapsiblePanel>
              </Collapsible>
            );
          })}
        </section>
      </CollapsiblePanel>
    </Collapsible>
  );
}
