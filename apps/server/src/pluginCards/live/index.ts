import type { PluginLiveSourceFactory } from "../core/PluginCardSource.ts";
import { dispatchLiveSource } from "./dispatchLiveSource.ts";

export const pluginLiveSources: ReadonlyArray<PluginLiveSourceFactory> = [dispatchLiveSource];
