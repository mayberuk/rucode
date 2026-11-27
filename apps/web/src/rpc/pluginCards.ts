import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const pluginThreadCardsAtomFamily = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:plugin-cards:thread",
    tag: WS_METHODS.pluginCardsSubscribeThread,
  },
);

export const pluginLiveStateAtomFamily = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:plugin-cards:live",
    tag: WS_METHODS.pluginCardsSubscribeLive,
  },
);

export const pluginInitiativeBoardAtomFamily = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:plugin-cards:initiative",
    tag: WS_METHODS.pluginCardsSubscribeInitiative,
    idleTtlMs: 0,
  },
);

export const answerPluginDecision = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:plugin-cards:answer-decision",
  tag: WS_METHODS.pluginCardsAnswerDecision,
});

export const runPluginCardAction = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:plugin-cards:run-action",
  tag: WS_METHODS.pluginCardsRunAction,
});

export const readPluginCardAsset = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:plugin-cards:read-asset",
  tag: WS_METHODS.pluginCardsReadAsset,
});
