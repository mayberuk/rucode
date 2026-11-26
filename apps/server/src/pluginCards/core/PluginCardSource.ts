import type {
  PluginCard,
  PluginCardAsset,
  PluginCardError,
  PluginCardKind,
  PluginLiveState,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

import type * as ProcessRunner from "../../processRunner.ts";
import type { PluginThreadIndex } from "./PluginThreadIndex.ts";

export type PluginCardSourceServices =
  | FileSystem.FileSystem
  | Path.Path
  | ProcessRunner.ProcessRunner
  | PluginThreadIndex;

export interface RecognizableCommand {
  readonly threadId: ThreadId;
  readonly turnItemId: TurnItemId;
  readonly command: string;
  /** Full output, read server-side even when the wire omits it. */
  readonly output: string | null;
  readonly exitCode: number | null;
  /** The thread's effective working directory. */
  readonly cwd: string;
  readonly completedAt: string | null;
}

export interface PluginCardRef {
  readonly kind: PluginCardKind;
  readonly key: string;
  /** The command created or waited on what the card shows, rather than only looking at it. */
  readonly owns?: boolean;
}

/** Omit per card kind, so a resolved card's `data` stays tied to its `kind`. */
export type ResolvedPluginCard = PluginCard extends infer Card
  ? Card extends PluginCard
    ? Omit<Card, "id" | "threadId" | "placement">
    : never
  : never;

export interface PluginCardSource {
  readonly id: string;
  /** Pure and cheap: no I/O. */
  readonly recognize: (command: RecognizableCommand) => ReadonlyArray<PluginCardRef>;
  readonly resolve: (
    ref: PluginCardRef,
    threadId: ThreadId,
  ) => Effect.Effect<ResolvedPluginCard | null, never, PluginCardSourceServices>;
  /** Cards mapped to the thread without a command, placed by time. */
  readonly cardsForThread?: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<PluginCard>, never, PluginCardSourceServices>;
  /** Signals that resolved data may have changed. File-watch driven, never polling. */
  readonly changes?: Stream.Stream<void, never, PluginCardSourceServices>;
  readonly runAction?: (
    card: PluginCard,
    actionId: string,
  ) => Effect.Effect<void, PluginCardError, PluginCardSourceServices>;
  readonly readAsset?: (
    card: PluginCard,
    assetId: string,
  ) => Effect.Effect<PluginCardAsset, PluginCardError, PluginCardSourceServices>;
}

export interface PluginLiveSource {
  readonly id: string;
  readonly snapshot: Effect.Effect<
    Pick<PluginLiveState, "initiatives" | "children" | "cliSessions">,
    never,
    PluginCardSourceServices
  >;
  readonly changes: Stream.Stream<void, never, PluginCardSourceServices>;
}

/** Runs once in the PluginCards service's scope, so a source may hold state and watchers. */
export type PluginCardSourceFactory = Effect.Effect<
  PluginCardSource,
  never,
  PluginCardSourceServices | Scope.Scope
>;
export type PluginLiveSourceFactory = Effect.Effect<
  PluginLiveSource,
  never,
  PluginCardSourceServices | Scope.Scope
>;
