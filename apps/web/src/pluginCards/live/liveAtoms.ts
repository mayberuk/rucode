import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  PluginInitiativeBoard,
  PluginLiveCliSession,
  PluginLiveInitiative,
  PluginLiveState,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { pluginInitiativeBoardAtomFamily, pluginLiveStateAtomFamily } from "~/rpc/pluginCards";

import {
  boardInitiatives,
  cliSessionForThread,
  hasOpenDecision,
  initiativeForThread,
  initiativeNeedsYou,
  initiativeSidebarGroups,
  liveInitiative,
  type BoardInitiative,
  type EnvironmentLiveState,
  type InitiativeNeedsYouItem,
  type InitiativeSidebarGroup,
} from "./liveStateIndex";

interface EnvironmentLiveSnapshot {
  readonly status: "loading" | "ready" | "failed";
  readonly state: PluginLiveState | null;
}

const LOADING: EnvironmentLiveSnapshot = { status: "loading", state: null };

// Reads card-core's subscription rather than opening another one. A dropped stream keeps the
// last snapshot, so a flaky connection does not blank every label.
const environmentLiveAtom = Atom.family((environmentId: EnvironmentId) => {
  const source = pluginLiveStateAtomFamily({ environmentId, input: {} });
  return Atom.make((get): EnvironmentLiveSnapshot => {
    const result = get(source);
    const previous = Option.getOrElse(get.self<EnvironmentLiveSnapshot>(), () => LOADING);
    const state = Option.getOrElse(AsyncResult.value(result), () => previous.state);
    if (state !== null) {
      return previous.status === "ready" && previous.state === state
        ? previous
        : { status: "ready", state };
    }
    if (AsyncResult.isFailure(result))
      return previous.status === "failed" ? previous : { status: "failed", state: null };
    return LOADING;
  });
});

// Nested because a family needs a primitive key; the inner atom compares by value, so a row
// re-renders only when its own answer changes.
const liveSelectorAtom = <Key extends string, A>(
  select: (state: PluginLiveState | null, key: Key) => A,
) =>
  Atom.family((environmentId: EnvironmentId) =>
    Atom.family((key: Key) =>
      Atom.make((get): A => select(get(environmentLiveAtom(environmentId)).state, key)),
    ),
  );

const threadHasOpenDecisionAtom = liveSelectorAtom(hasOpenDecision);
const threadInitiativeAtom = liveSelectorAtom(initiativeForThread);
const threadCliSessionAtom = liveSelectorAtom(cliSessionForThread);
const liveInitiativeAtom = liveSelectorAtom(liveInitiative);

const anyThreadHasOpenDecisionAtom = Atom.family((key: string) => {
  const threads: ReadonlyArray<ScopedThreadRef> = JSON.parse(key);
  return Atom.make((get) =>
    threads.some(({ environmentId, threadId }) =>
      get(threadHasOpenDecisionAtom(environmentId)(threadId)),
    ),
  );
});

// Sorted so equal sets compare equal and the sidebar re-partitions only when a decision opens or closes.
const openDecisionThreadKeysAtom = Atom.family((key: string) => {
  const environmentIds: ReadonlyArray<EnvironmentId> = JSON.parse(key);
  return Atom.make((get): ReadonlyArray<string> => {
    const next = environmentStates(get, environmentIds)
      .flatMap(({ environmentId, state }) =>
        (state?.waitingThreadIds ?? []).map((threadId) =>
          scopedThreadKey(scopeThreadRef(environmentId, threadId)),
        ),
      )
      .toSorted();
    const previous = get.self<ReadonlyArray<string>>();
    return Option.isSome(previous) && Equal.equals(previous.value, next) ? previous.value : next;
  });
});

function environmentStates(
  get: Atom.AtomContext,
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyArray<EnvironmentLiveSnapshot & { readonly environmentId: EnvironmentId }> {
  return environmentIds.map((environmentId) => ({
    environmentId,
    ...get(environmentLiveAtom(environmentId)),
  }));
}

// Keyed by the joined ids because a family needs a primitive key.
const sidebarGroupsAtom = Atom.family((key: string) => {
  const environmentIds: ReadonlyArray<EnvironmentId> = JSON.parse(key);
  return Atom.make((get): ReadonlyArray<InitiativeSidebarGroup> => {
    const next = initiativeSidebarGroups(environmentStates(get, environmentIds));
    const previous = get.self<ReadonlyArray<InitiativeSidebarGroup>>();
    // An as-of-only change must not re-partition the sidebar.
    return Option.isSome(previous) && Equal.equals(previous.value, next) ? previous.value : next;
  });
});

interface BoardState {
  readonly status: "loading" | "ready" | "unavailable";
  readonly initiatives: ReadonlyArray<BoardInitiative>;
}

const LOADING_BOARD: BoardState = { status: "loading", initiatives: [] };

const boardAtom = Atom.family((key: string) => {
  const environmentIds: ReadonlyArray<EnvironmentId> = JSON.parse(key);
  return Atom.make((get): BoardState => {
    const snapshots = environmentStates(get, environmentIds);
    if (snapshots.some((snapshot) => snapshot.status === "loading")) return LOADING_BOARD;
    if (snapshots.length > 0 && snapshots.every((snapshot) => snapshot.status === "failed")) {
      return { status: "unavailable", initiatives: [] };
    }
    const states: ReadonlyArray<EnvironmentLiveState> = snapshots;
    return { status: "ready", initiatives: boardInitiatives(states) };
  });
});

export interface InitiativeBoardView {
  readonly status: "loading" | "ready" | "unavailable";
  readonly board: PluginInitiativeBoard | null;
  readonly needsYou: ReadonlyArray<InitiativeNeedsYouItem>;
}

const initiativeBoardAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.family((slug: string) => {
    const source = pluginInitiativeBoardAtomFamily({ environmentId, input: { slug } });
    return Atom.make((get): InitiativeBoardView => {
      const result = get(source);
      const previous = Option.getOrUndefined(get.self<InitiativeBoardView>());
      const latest = AsyncResult.getOrElse(result, () => previous?.board ?? null);
      const board = previous && Equal.equals(previous.board, latest) ? previous.board : latest;
      const status = AsyncResult.isFailure(result)
        ? "unavailable"
        : board === null
          ? "loading"
          : "ready";
      const needsYou =
        board !== null && board.needsYou.length > 0
          ? initiativeNeedsYou(board, get(environmentLiveAtom(environmentId)).state)
          : [];
      return previous?.status === status &&
        previous.board === board &&
        Equal.equals(previous.needsYou, needsYou)
        ? previous
        : { status, board, needsYou };
    });
  }),
);

function environmentIdsKey(environmentIds: ReadonlyArray<EnvironmentId>): string {
  return JSON.stringify(environmentIds);
}

export function useThreadHasOpenDecision(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): boolean {
  return useAtomValue(threadHasOpenDecisionAtom(environmentId)(threadId));
}

export function useAnyThreadHasOpenDecision(threads: ReadonlyArray<ScopedThreadRef>): boolean {
  const key = JSON.stringify(
    threads.map(({ environmentId, threadId }) => ({ environmentId, threadId })),
  );
  return useAtomValue(anyThreadHasOpenDecisionAtom(key));
}

export function useOpenDecisionThreadKeys(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyArray<string> {
  return useAtomValue(openDecisionThreadKeysAtom(environmentIdsKey(environmentIds)));
}

export function useThreadInitiative(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): PluginLiveInitiative | null {
  return useAtomValue(threadInitiativeAtom(environmentId)(threadId));
}

export function useThreadCliSession(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): PluginLiveCliSession | null {
  return useAtomValue(threadCliSessionAtom(environmentId)(threadId));
}

export function readThreadCliSession(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): PluginLiveCliSession | null {
  return appAtomRegistry.get(threadCliSessionAtom(environmentId)(threadId));
}

export function useInitiativeSidebarGroups(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyArray<InitiativeSidebarGroup> {
  return useAtomValue(sidebarGroupsAtom(environmentIdsKey(environmentIds)));
}

export function useBoardInitiatives(environmentIds: ReadonlyArray<EnvironmentId>): BoardState {
  return useAtomValue(boardAtom(environmentIdsKey(environmentIds)));
}

export function useInitiativeBoard(
  environmentId: EnvironmentId,
  slug: string,
): InitiativeBoardView {
  return useAtomValue(initiativeBoardAtom(environmentId)(slug));
}

export function useLiveInitiative(
  environmentId: EnvironmentId,
  slug: string,
): PluginLiveInitiative | null {
  return useAtomValue(liveInitiativeAtom(environmentId)(slug));
}

export function readThreadHasOpenDecision(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): boolean {
  return appAtomRegistry.get(threadHasOpenDecisionAtom(environmentId)(threadId));
}
