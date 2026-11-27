import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const iter8ReviewAtomFamily = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:iter8:review",
    tag: WS_METHODS.iter8SubscribeReview,
  },
);

export const createIter8Note = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:iter8:create-note",
  tag: WS_METHODS.iter8CreateNote,
});

export const updateIter8Note = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:iter8:update-note",
  tag: WS_METHODS.iter8UpdateNote,
});

export const deleteIter8Note = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:iter8:delete-note",
  tag: WS_METHODS.iter8DeleteNote,
});

export const sendIter8Round = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:iter8:send-round",
  tag: WS_METHODS.iter8SendRound,
});
