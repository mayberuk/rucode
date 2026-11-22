import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";
import { SquareTerminalIcon } from "lucide-react";
import { useState } from "react";

import { useThreadCliSession } from "~/pluginCards/live/liveAtoms";
import { takeOverCliSession } from "~/rpc/cliSessions";
import { useAtomCommand } from "~/state/use-atom-command";
import { cliSessionRefusal, cliSessionTakeOver } from "../cliSession.logic";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

type TakeOverAttempt =
  | { readonly key: string; readonly status: "pending" }
  | { readonly key: string; readonly status: "failed"; readonly message: string };

/**
 * While another Claude process holds this thread's session, the composer says where it is
 * open and refuses to send, since two writers would fork the conversation.
 */
export function useCliSessionComposer(
  threadRef: ScopedThreadRef,
  turnActive: boolean,
): {
  readonly bannerItem: ComposerBannerStackItem | null;
  readonly sendDisabledReason: string | null;
} {
  const gt = useGT();
  const m = useMessages();
  const session = useThreadCliSession(threadRef.environmentId, threadRef.threadId);
  const takeOver = useAtomCommand(takeOverCliSession, { reportFailure: false });
  const [attempt, setAttempt] = useState<TakeOverAttempt | null>(null);

  if (session === null) {
    if (attempt !== null) setAttempt(null);
    return { bannerItem: null, sendDisabledReason: null };
  }

  // A refusal describes the session as it was; a new status or session makes it stale.
  const attemptKey = JSON.stringify([
    threadRef.environmentId,
    threadRef.threadId,
    session.sessionId,
    session.status,
  ]);
  const current = attempt?.key === attemptKey ? attempt : null;
  const inTerminal = session.owner === "terminal";
  const place = inTerminal ? gt("Open in a terminal") : gt("Open in another Claude process");
  const statusLabel =
    session.status === "busy"
      ? gt("working")
      : session.status === "idle"
        ? gt("idle")
        : session.status === "shell"
          ? gt("running a command")
          : null;
  const notes = [
    current?.status === "failed" ? current.message : null,
    turnActive
      ? gt("A turn here is still finishing; restart the terminal session to see it.")
      : null,
    session.backgroundWorkKept
      ? gt("Background work started here is still running and may add to this chat.")
      : null,
  ].filter((note) => note !== null);

  const runTakeOver = async () => {
    setAttempt({ key: attemptKey, status: "pending" });
    const result = await takeOver({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    // Success keeps the button busy until live state drops the session and the banner goes.
    if (result._tag === "Success") return;
    if (isAtomCommandInterrupted(result)) {
      setAttempt(null);
      return;
    }
    const error = squashAtomCommandFailure(result);
    const refusal = cliSessionRefusal(error);
    setAttempt({
      key: attemptKey,
      status: "failed",
      message:
        refusal !== null
          ? m(refusal)
          : error instanceof Error && error.message.trim().length > 0
            ? error.message
            : gt("Couldn't take over the terminal session."),
    });
  };

  const takeOverState = cliSessionTakeOver(session);
  const pending = current?.status === "pending";
  const bannerItem: ComposerBannerStackItem = {
    id: `cli-session:${session.sessionId}`,
    variant: "info",
    group: "attention",
    icon: <SquareTerminalIcon />,
    title: statusLabel === null ? place : `${place} · ${statusLabel}`,
    description:
      notes.length > 0
        ? notes.join(" ")
        : takeOverState === "available"
          ? gt("Exit it there, or take over here.")
          : gt("Exit it there to continue here."),
  };
  return {
    bannerItem:
      takeOverState === "hidden"
        ? bannerItem
        : {
            ...bannerItem,
            actions: (
              <Button
                size="xs"
                variant="ghost"
                disabled={takeOverState !== "available" || pending}
                onClick={() => void runTakeOver()}
              >
                {pending ? gt("Taking over…") : gt("Take over")}
              </Button>
            ),
          },
    sendDisabledReason: inTerminal
      ? gt("Open in a terminal")
      : gt("Open in another Claude process"),
  };
}
