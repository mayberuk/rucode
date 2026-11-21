import type { PluginCard, ScopedThreadRef } from "@t3tools/contracts";
import { useRef, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";

import { usePostPluginCardMessage, useRunPluginCardAction } from "../../core/usePluginCards";
import { cardAction } from "./cardFormat.logic";

export function PluginCardActionButton({
  card,
  actionId,
  threadRef,
  variant = "ghost-muted",
  size = "xs",
  icon,
}: {
  card: PluginCard;
  actionId: string;
  threadRef: ScopedThreadRef;
  variant?: "ghost-muted" | "outline" | "default";
  size?: "xs" | "sm";
  icon?: ReactNode;
}): ReactNode {
  const postMessage = usePostPluginCardMessage(threadRef);
  const runAction = useRunPluginCardAction(threadRef);
  const [pending, setPending] = useState(false);
  // State alone lets a fast double click start a second request before the disabled render lands.
  const inFlight = useRef(false);
  const action = cardAction(card, actionId);
  if (action === null) return null;

  const press = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    const request =
      action.type === "message" ? postMessage(action.message) : runAction(card.id, action.id);
    request
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: `Could not ${action.label.toLowerCase()}`,
          description: error instanceof Error ? error.message : undefined,
        });
      })
      .then(() => {
        inFlight.current = false;
        setPending(false);
      });
  };

  return (
    <Button type="button" size={size} variant={variant} disabled={pending} onClick={press}>
      {icon}
      {action.label}
    </Button>
  );
}
