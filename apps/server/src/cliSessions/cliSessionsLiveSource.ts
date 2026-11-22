import type { PluginLiveCliSession } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { PluginLiveSourceFactory } from "../pluginCards/core/PluginCardSource.ts";

export interface CliSessionsLiveValue {
  readonly current: Effect.Effect<ReadonlyArray<PluginLiveCliSession>>;
  /** Emits after `current` changes, which happens only on registry or thread-mapping changes. */
  readonly changes: Stream.Stream<void>;
}

/** Synced Claude sessions another process holds; provide it under the plugin cards layer. */
export const CliSessionsLive = Context.Reference<CliSessionsLiveValue>(
  "t3/cliSessions/CliSessionsLive",
  { defaultValue: () => ({ current: Effect.succeed([]), changes: Stream.empty }) },
);

export const cliSessionsLiveSource: PluginLiveSourceFactory = Effect.gen(function* () {
  const live = yield* CliSessionsLive;
  return {
    id: "cli-sessions",
    snapshot: live.current.pipe(
      Effect.map((cliSessions) => ({ initiatives: [], children: [], cliSessions })),
    ),
    changes: live.changes,
  };
});
