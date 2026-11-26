import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const takeOverCliSession = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:cli-sessions:take-over",
  tag: WS_METHODS.cliSessionsTakeOver,
});

export const continueCliSessionInTerminal = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:cli-sessions:continue-in-terminal",
  tag: WS_METHODS.cliSessionsContinueInTerminal,
});
