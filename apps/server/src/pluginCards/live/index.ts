import { cliSessionsLiveSource } from "../../cliSessions/cliSessionsLiveSource.ts";
import type { PluginLiveSourceFactory } from "../core/PluginCardSource.ts";
import { dispatchLiveSource } from "./dispatchLiveSource.ts";

export const pluginLiveSources: ReadonlyArray<PluginLiveSourceFactory> = [
  dispatchLiveSource,
  cliSessionsLiveSource,
];
