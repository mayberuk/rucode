import type { PluginCardSourceFactory } from "../core/PluginCardSource.ts";
import { dispatchPlanSource } from "./dispatchPlanSource.ts";
import { dispatchWaveSource } from "./dispatchWaveSource.ts";
import { gittySource } from "./gittySource.ts";
import { iter8Source } from "./iter8Source.ts";
import { livecheckSource } from "./livecheckSource.ts";

export const pluginCardSources: ReadonlyArray<PluginCardSourceFactory> = [
  dispatchPlanSource,
  dispatchWaveSource,
  gittySource,
  iter8Source,
  livecheckSource,
];
