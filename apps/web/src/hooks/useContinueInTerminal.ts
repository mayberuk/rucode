import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";

import { cliSessionRefusal } from "../components/cliSession.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { continueCliSessionInTerminal } from "../rpc/cliSessions";
import { useAtomCommand } from "../state/use-atom-command";
import { writeTextToClipboard } from "./useCopyToClipboard";

/** Hands a Claude thread to a terminal: typed into its last shell pane, or copied to run by hand. */
export function useContinueInTerminal() {
  const gt = useGT();
  const m = useMessages();
  const continueInTerminal = useAtomCommand(continueCliSessionInTerminal, {
    reportFailure: false,
  });

  return async (threadRef: ScopedThreadRef) => {
    const result = await continueInTerminal({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      const refusal = cliSessionRefusal(error);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Couldn't continue in a terminal"),
          description:
            refusal !== null
              ? m(refusal)
              : error instanceof Error
                ? error.message
                : gt("An error occurred."),
        }),
      );
      return;
    }
    const { delivery, command, paneLabel } = result.value;
    if (delivery === "sent") {
      toastManager.add({
        type: "success",
        title:
          paneLabel === null
            ? gt("Resumed in your terminal")
            : gt("Resumed in {pane}", { pane: paneLabel }),
      });
      return;
    }
    const copied = await writeTextToClipboard(command, "command").then(
      () => true,
      () => false,
    );
    toastManager.add({
      type: copied ? "success" : "info",
      title: copied ? gt("Copied. Run it in a terminal") : gt("Run this in a terminal"),
      description: command,
    });
  };
}
