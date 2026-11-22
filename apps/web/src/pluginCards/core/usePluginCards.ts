import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PluginCardId,
  PluginLiveState,
  PluginThreadCards,
  ScopedThreadRef,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import { useContext, useEffect, useState } from "react";

import { toastManager } from "~/components/ui/toast";
import { newMessageId } from "~/lib/utils";
import {
  pluginLiveStateAtomFamily,
  pluginThreadCardsAtomFamily,
  readPluginCardAsset,
  runPluginCardAction,
} from "~/rpc/pluginCards";
import { useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { DEFAULT_INTERACTION_MODE } from "~/types";

function failureMessage(result: { readonly cause: Cause.Cause<unknown> }): string | undefined {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim().length > 0 ? error.message : undefined;
}

/** Null until the first snapshot arrives; a dropped stream keeps its last snapshot. */
export function usePluginThreadCards(threadRef: ScopedThreadRef | null): PluginThreadCards | null {
  return useEnvironmentQuery(
    threadRef === null
      ? null
      : pluginThreadCardsAtomFamily({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        }),
  ).data;
}

const emptyLiveSnapshot = Atom.make<PluginLiveState | null>(null);
const liveSnapshotAtom = Atom.family((source: ReturnType<typeof pluginLiveStateAtomFamily>) =>
  Atom.make((get): PluginLiveState | null =>
    AsyncResult.getOrElse(get(source), () => Option.getOrNull(get.self<PluginLiveState | null>())),
  ),
);

/** Null until the first snapshot arrives; a dropped stream keeps its last snapshot. */
export function usePluginLiveState(environmentId: EnvironmentId | null): PluginLiveState | null {
  return useAtomValue(
    environmentId === null
      ? emptyLiveSnapshot
      : liveSnapshotAtom(pluginLiveStateAtomFamily({ environmentId, input: {} })),
  );
}

/** @public Runs a card's server-handled action and reports failures to the user. */
export function useRunPluginCardAction(threadRef: ScopedThreadRef) {
  const runAction = useAtomCommand(runPluginCardAction, { reportFailure: false });
  return async (cardId: PluginCardId, actionId: string): Promise<boolean> => {
    const result = await runAction({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, cardId, actionId },
    });
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Could not run the action",
        description: failureMessage(result),
      });
    }
    return false;
  };
}

export type PluginCardAssetState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly url: string }
  | { readonly status: "failed"; readonly message: string };

const ASSET_LOADING: PluginCardAssetState = { status: "loading" };

/**
 * Decoded images outlive a mount, so a remount fetches nothing. The server resolves every card of
 * the thread to serve one asset, so a refetch is costly there. Capped by size, oldest first.
 */
const MAX_CACHED_ASSET_BYTES = 16 * 1024 * 1024;
const assetBlobs = new Map<string, Blob>();
const assetReads = new Map<string, Promise<AssetBlobResult>>();
let assetBlobBytes = 0;

type AssetBlobResult =
  | { readonly blob: Blob; readonly message?: undefined }
  | { readonly blob?: undefined; readonly message: string };

function rememberAssetBlob(key: string, blob: Blob) {
  assetBlobs.set(key, blob);
  assetBlobBytes += blob.size;
  for (const [oldKey, oldBlob] of assetBlobs) {
    if (assetBlobBytes <= MAX_CACHED_ASSET_BYTES) break;
    assetBlobs.delete(oldKey);
    assetBlobBytes -= oldBlob.size;
  }
}

function readAssetBlob(
  registry: AtomRegistry.AtomRegistry,
  key: string,
  request: Parameters<typeof readPluginCardAsset.run>[1],
): Promise<AssetBlobResult> {
  const cached = assetBlobs.get(key);
  if (cached !== undefined) return Promise.resolve({ blob: cached });
  const pending = assetReads.get(key);
  if (pending !== undefined) return pending;
  const read = runAtomCommand(registry, readPluginCardAsset, request, {
    reportFailure: false,
  }).then((result): AssetBlobResult => {
    assetReads.delete(key);
    if (result._tag === "Failure") {
      return { message: failureMessage(result) ?? "The image could not be read." };
    }
    // Decoded from base64, so the bytes never sit on a SharedArrayBuffer.
    const bytes = result.value.bytes as Uint8Array<ArrayBuffer>;
    const blob = new Blob([bytes], { type: result.value.mediaType });
    rememberAssetBlob(key, blob);
    return { blob };
  });
  assetReads.set(key, read);
  return read;
}

/** A failure stays failed for the mount rather than retrying. */
export function usePluginCardAsset(
  threadRef: ScopedThreadRef,
  cardId: PluginCardId,
  assetId: string,
): PluginCardAssetState {
  const registry = useContext(RegistryContext);
  const { environmentId, threadId } = threadRef;
  const key = JSON.stringify([environmentId, threadId, cardId, assetId]);
  const [loaded, setLoaded] = useState<{
    readonly key: string;
    readonly state: PluginCardAssetState;
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns a browser object URL for the asset bytes, revoked when the asset changes or the renderer unmounts
  useEffect(() => {
    let active = true;
    let url: string | null = null;
    void readAssetBlob(registry, key, {
      environmentId,
      input: { threadId, cardId, assetId },
    }).then((outcome) => {
      if (!active) return;
      if (outcome.blob === undefined) {
        setLoaded({ key, state: { status: "failed", message: outcome.message } });
        return;
      }
      url = URL.createObjectURL(outcome.blob);
      setLoaded({ key, state: { status: "ready", url } });
    });
    return () => {
      active = false;
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [registry, environmentId, threadId, cardId, assetId, key]);
  return loaded !== null && loaded.key === key ? loaded.state : ASSET_LOADING;
}

/** @public Posts a message as the user and queues it behind any running turn. */
export function usePostPluginCardMessage(threadRef: ScopedThreadRef) {
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const shell = useThreadShell(threadRef);
  return async (text: string): Promise<boolean> => {
    if (shell === null) {
      toastManager.add({ type: "error", title: "Could not send the message" });
      return false;
    }
    const result = await startTurn({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        message: { messageId: newMessageId(), role: "user", text, attachments: [] },
        runtimeMode: shell.runtimeMode,
        interactionMode: DEFAULT_INTERACTION_MODE,
        dispatchMode: "queue",
      },
    });
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Could not send the message",
        description: failureMessage(result),
      });
    }
    return false;
  };
}
