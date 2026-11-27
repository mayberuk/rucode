import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import { Atom } from "effect/reactivity";

import { environmentThreadDetails } from "../../../state/threads";
import { latestConfirmMessageId } from "./confirmBlock.logic";

const NO_MESSAGE_ATOM = Atom.make<string | null>(null).pipe(
  Atom.withLabel("confirm-block-latest-message:empty"),
);

// Reads the timeline's held items, so streamed text does not recompute it, and the value changes
// only when the latest message with a confirm section does.
const latestConfirmMessageIdAtomFamily = Atom.family((key: string) =>
  Atom.make((get) =>
    latestConfirmMessageId(
      get(environmentThreadDetails.timelineVisibleTurnItemsAtom(parseThreadKey(key))),
    ),
  ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`confirm-block-latest-message:${key}`)),
);

export function useConfirmBlockMode(
  threadRef: ScopedThreadRef | null,
  messageId: string,
  canOperateThread: boolean,
): "answerable" | "readonly" {
  const latest = useAtomValue(
    threadRef === null ? NO_MESSAGE_ATOM : latestConfirmMessageIdAtomFamily(threadKey(threadRef)),
  );
  return canOperateThread && threadRef !== null && latest === messageId ? "answerable" : "readonly";
}
