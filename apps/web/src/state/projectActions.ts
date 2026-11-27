import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const suggestProjectActions = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:project-actions:suggest",
  tag: WS_METHODS.projectActionsSuggest,
});
