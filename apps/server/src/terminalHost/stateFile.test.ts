// @effect-diagnostics nodeBuiltinImport:off -- Fixtures check the file's mode and the directory listing.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";

import {
  openTerminalHostStateStore,
  readTerminalHostState,
  terminalHostStatePath,
} from "./stateFile.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const tempStateDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-th-state-" });
});

const writeRaw = (stateDir: string, contents: string) =>
  Effect.promise(() => NodeFSP.writeFile(terminalHostStatePath(stateDir), contents));

describe("terminal host state file", () => {
  it("lives at terminal-host.json in the state directory", () => {
    expect(terminalHostStatePath("/state")).toBe("/state/terminal-host.json");
  });

  it.effect("reads a missing, invalid or wrongly shaped file as no entries", () =>
    Effect.gen(function* () {
      const stateDir = yield* tempStateDir;
      expect(yield* readTerminalHostState(stateDir)).toEqual([]);
      for (const contents of [
        "",
        "{not json",
        "[]",
        '{"version":2,"sessions":[]}',
        '{"version":1,"sessions":[{"key":"k"}]}',
      ]) {
        yield* writeRaw(stateDir, contents);
        expect(yield* readTerminalHostState(stateDir)).toEqual([]);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("prunes entries older than 30 days when the store opens", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const stateDir = yield* tempStateDir;
      const entry = (key: string, updatedAt: string) => ({
        key,
        cwd: `/work/${key}`,
        lastCommand: { line: `run ${key}`, cwd: `/work/${key}` },
        updatedAt,
      });
      const kept = [
        entry("exactly-30-days", iso(NOW - 30 * DAY_MS)),
        entry("recent", iso(NOW - DAY_MS)),
      ];
      yield* writeRaw(
        stateDir,
        JSON.stringify({
          version: 1,
          sessions: [
            entry("expired", iso(NOW - 30 * DAY_MS - 1)),
            kept[0],
            entry("unparseable", "yesterday"),
            kept[1],
          ],
        }),
      );

      const store = yield* openTerminalHostStateStore(stateDir);
      expect(store.entries()).toEqual(kept);
      yield* store.flush;
      expect(yield* readTerminalHostState(stateDir)).toEqual(kept);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("writes updates owner-only through a renamed temp file", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const stateDir = yield* tempStateDir;
      const store = yield* openTerminalHostStateStore(stateDir);
      store.replace("a", "/work/a");
      store.replace("b", "/work/b");
      store.recordCommand("a", { line: "npm run dev", cwd: "/work/a/app" });
      store.recordCommand("missing", { line: "ignored", cwd: "/" });
      yield* store.flush;

      expect(yield* readTerminalHostState(stateDir)).toEqual([
        {
          key: "a",
          cwd: "/work/a",
          lastCommand: { line: "npm run dev", cwd: "/work/a/app" },
          updatedAt: iso(NOW),
        },
        { key: "b", cwd: "/work/b", lastCommand: null, updatedAt: iso(NOW) },
      ]);
      const stat = yield* Effect.promise(() => NodeFSP.stat(terminalHostStatePath(stateDir)));
      expect(stat.mode & 0o777).toBe(0o600);
      expect(yield* Effect.promise(() => NodeFSP.readdir(stateDir))).toEqual([
        "terminal-host.json",
      ]);

      store.replace("a", "/elsewhere");
      store.remove("b");
      yield* store.flush;
      expect(yield* readTerminalHostState(stateDir)).toEqual([
        { key: "a", cwd: "/elsewhere", lastCommand: null, updatedAt: iso(NOW) },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
