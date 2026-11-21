import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as Scope from "effect/Scope";

import type * as PtyAdapter from "@t3tools/shared/PtyAdapter";

import { inProcessTerminalSessionHost, type TerminalSessionHostShape } from "./sessionHost.ts";

export const makeLiveTerminalSessionHost = (input: {
  readonly ptyAdapter: PtyAdapter.PtyAdapter["Service"];
  readonly stateDir: string;
}): Effect.Effect<
  TerminalSessionHostShape,
  never,
  Scope.Scope | FileSystem.FileSystem | Path.Path
> => Effect.succeed(inProcessTerminalSessionHost(input.ptyAdapter));
