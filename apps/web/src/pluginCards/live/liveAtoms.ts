import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  PluginLiveInitiative,
  PluginLiveState,
  ThreadId,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { pluginLiveStateAtomFamily } from "~/rpc/pluginCards";

import {
  boardInitiatives,
  hasOpenDecision,
  initiativeForThread,
  initiativeSidebarGroups,
  type BoardInitiative,
  type EnvironmentLiveState,
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
const threadAtom = <A>(select: (state: PluginLiveState | null, threadId: ThreadId) => A) =>
  Atom.family((environmentId: EnvironmentId) =>
    Atom.family((threadId: ThreadId) =>
      Atom.make((get): A => select(get(environmentLiveAtom(environmentId)).state, threadId)),
    ),
  );

const threadHasOpenDecisionAtom = threadAtom(hasOpenDecision);
const threadInitiativeAtom = threadAtom(initiativeForThread);

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

function environmentIdsKey(environmentIds: ReadonlyArray<EnvironmentId>): string {
  return JSON.stringify(environmentIds);
}

export function useThreadHasOpenDecision(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): boolean {
  return useAtomValue(threadHasOpenDecisionAtom(environmentId)(threadId));
}

export function useThreadInitiative(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): PluginLiveInitiative | null {
  return useAtomValue(threadInitiativeAtom(environmentId)(threadId));
}

export function useInitiativeSidebarGroups(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyArray<InitiativeSidebarGroup> {
  return useAtomValue(sidebarGroupsAtom(environmentIdsKey(environmentIds)));
}

export function useBoardInitiatives(environmentIds: ReadonlyArray<EnvironmentId>): BoardState {
  return useAtomValue(boardAtom(environmentIdsKey(environmentIds)));
}

export function readThreadHasOpenDecision(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): boolean {
  return appAtomRegistry.get(threadHasOpenDecisionAtom(environmentId)(threadId));
}
