import { PluginCardError, type PluginInitiativeBoard } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";

export class InitiativeBoard extends Context.Service<
  InitiativeBoard,
  {
    readonly subscribe: (slug: string) => Stream.Stream<PluginInitiativeBoard, PluginCardError>;
  }
>()("t3/pluginCards/live/InitiativeBoard") {}

const unavailableError = new PluginCardError({ reason: "unavailable" });

export const unavailable: InitiativeBoard["Service"] = {
  subscribe: () => Stream.fail(unavailableError),
};
