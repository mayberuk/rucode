import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { readSyncState, type SyncState, writeSyncState } from "./syncState.ts";

const state: SyncState = {
  version: 1,
  backfilledAt: "2026-11-22T09:00:00.000Z",
  sessions: {
    "0b7c2a1e-5f3d-4c1a-9e8b-1d2f3a4b5c6d": {
      threadId: ThreadId.make("thread-1"),
      filePath: "/home/someone/.claude/projects/-home-someone-dev-repo/0b7c2a1e.jsonl",
      inode: 1234567,
      offset: 8192,
      syncedTitle: "Fix the sidebar",
    },
    "1c8d3b2f-6a4e-4d2b-8f9c-2e3a4b5c6d7e": {
      threadId: ThreadId.make("thread-2"),
      filePath: "/home/someone/.claude/projects/-home-someone-dev-repo/1c8d3b2f.jsonl",
      inode: 7654321,
      offset: 0,
      syncedTitle: null,
    },
  },
};

const empty: SyncState = { version: 1, backfilledAt: null, sessions: {} };

const tempStateDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-session-sync-" });
});

it.layer(NodeServices.layer)("cli session sync state", (it) => {
  it.effect("reads back what it wrote", () =>
    Effect.gen(function* () {
      const stateDir = yield* tempStateDir;
      yield* writeSyncState(stateDir, state);
      expect(yield* readSyncState(stateDir)).toEqual(state);
    }),
  );

  it.effect("reads a missing file as empty", () =>
    Effect.gen(function* () {
      const stateDir = yield* tempStateDir;
      expect(yield* readSyncState(stateDir)).toEqual(empty);
    }),
  );

  it.effect("reads a corrupt file as empty", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* tempStateDir;
      yield* fs.writeFileString(path.join(stateDir, "cli-session-sync.json"), '{"version":1,"ses');
      expect(yield* readSyncState(stateDir)).toEqual(empty);
      yield* fs.writeFileString(
        path.join(stateDir, "cli-session-sync.json"),
        JSON.stringify({ version: 2, backfilledAt: null, sessions: {} }),
      );
      expect(yield* readSyncState(stateDir)).toEqual(empty);
    }),
  );

  it.effect("keeps the previous file readable when a write dies before the rename", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* tempStateDir;
      yield* writeSyncState(stateDir, state);

      const crashing = FileSystem.FileSystem.of({
        ...fs,
        rename: (from) =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "Unknown",
              module: "FileSystem",
              method: "rename",
              pathOrDescriptor: from,
            }),
          ),
      });
      const failed = yield* writeSyncState(stateDir, empty).pipe(
        Effect.provideService(FileSystem.FileSystem, crashing),
        Effect.flip,
      );
      expect(failed._tag).toBe("CliSessionSyncStateWriteError");

      expect(yield* readSyncState(stateDir)).toEqual(state);
      expect((yield* fs.readDirectory(stateDir)).toSorted()).toEqual(["cli-session-sync.json"]);
    }),
  );
});
