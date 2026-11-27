import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * What a null `claudeTerminalSessions` means here. A RuCode home inside a linked git worktree is a
 * dev server, which defaults off so it does not adopt the developer's own sessions.
 */
export const claudeTerminalSessionsDefault = Effect.fn("CliSessions.terminalSessionsDefault")(
  function* (baseDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const inLinkedWorktree = yield* fs.stat(path.join(path.dirname(baseDir), ".git")).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    );
    return !inLinkedWorktree;
  },
);

export const claudeTerminalSessionsEnabled = (setting: boolean | null, enabledByDefault: boolean) =>
  setting ?? enabledByDefault;
