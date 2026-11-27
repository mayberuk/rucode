import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  claudeTerminalSessionsDefault,
  claudeTerminalSessionsEnabled,
} from "./terminalSessionsDefault.ts";

const homeIn = Effect.fn(function* (git: "file" | "directory" | "none") {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const checkout = yield* fs.makeTempDirectoryScoped();
  if (git === "file")
    yield* fs.writeFileString(path.join(checkout, ".git"), "gitdir: /repo/.git/worktrees/x\n");
  if (git === "directory") yield* fs.makeDirectory(path.join(checkout, ".git"));
  return path.join(checkout, ".t3");
});

it.effect.each([
  ["a linked worktree", "file", null, false],
  ["a main checkout", "directory", null, true],
  ["a plain directory", "none", null, true],
  ["a linked worktree", "file", true, true],
  ["a main checkout", "directory", false, false],
  ["a plain directory", "none", false, false],
] as const)(
  "a RuCode home in %s with the setting %s runs terminal sessions: %s",
  ([_name, git, setting, expected]) =>
    Effect.gen(function* () {
      const enabledByDefault = yield* claudeTerminalSessionsDefault(yield* homeIn(git));
      expect(claudeTerminalSessionsEnabled(setting, enabledByDefault)).toBe(expected);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
