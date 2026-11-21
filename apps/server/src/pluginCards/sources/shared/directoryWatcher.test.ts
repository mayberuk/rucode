import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { makeDirectoryWatcher } from "./directoryWatcher.ts";

const collectChanges = Effect.fnUntraced(function* (options: {
  readonly debounce: Duration.Input;
  readonly accept?: (dir: string, fileName: string) => boolean;
}) {
  const watcher = yield* makeDirectoryWatcher({
    debounce: options.debounce,
    ...(options.accept === undefined ? {} : { accept: options.accept }),
  });
  const seen = yield* Queue.unbounded<void>();
  yield* Stream.runForEach(watcher.changes, () => Queue.offer(seen, undefined)).pipe(
    Effect.forkScoped({ startImmediately: true }),
  );
  return { watcher, seen };
});

const pending = (seen: Queue.Queue<void>) => Queue.size(seen);

it.layer(NodeServices.layer)("directory watcher", (it) => {
  it.effect("emits one change after a wake's delay and none before", () =>
    Effect.gen(function* () {
      const { watcher, seen } = yield* collectChanges({ debounce: "10 millis" });
      yield* watcher.wakeAfter("run", "100 millis");

      yield* TestClock.adjust("99 millis");
      expect(yield* pending(seen)).toBe(0);

      yield* TestClock.adjust("11 millis");
      yield* Queue.take(seen);
      yield* TestClock.adjust("10 seconds");
      expect(yield* pending(seen)).toBe(0);
    }),
  );

  it.effect("replaces an earlier wake for the same key", () =>
    Effect.gen(function* () {
      const { watcher, seen } = yield* collectChanges({ debounce: "10 millis" });
      yield* watcher.wakeAfter("run", "100 millis");
      yield* TestClock.adjust("50 millis");
      yield* watcher.wakeAfter("run", "100 millis");

      yield* TestClock.adjust("70 millis");
      expect(yield* pending(seen)).toBe(0);

      yield* TestClock.adjust("50 millis");
      yield* Queue.take(seen);
      yield* TestClock.adjust("10 seconds");
      expect(yield* pending(seen)).toBe(0);
    }),
  );

  it.effect("keeps wakes for different keys apart", () =>
    Effect.gen(function* () {
      const { watcher, seen } = yield* collectChanges({ debounce: "10 millis" });
      yield* watcher.wakeAfter("one", "100 millis");
      yield* watcher.wakeAfter("two", "1 second");

      yield* TestClock.adjust("120 millis");
      yield* Queue.take(seen);

      yield* TestClock.adjust("2 seconds");
      yield* Queue.take(seen);
    }),
  );

  it.effect("does not fail for a directory that does not exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dir-watcher-" });
      const { watcher, seen } = yield* collectChanges({ debounce: "10 millis" });

      yield* watcher.watch(path.join(root, "missing"));
      expect(Option.isNone(yield* Queue.poll(seen))).toBe(true);
    }),
  );
});

// Real file-system events arrive on wall-clock time, so these cannot run on the TestClock.
it.live("emits for a file written in a watched directory", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dir-watcher-" });
    const { watcher, seen } = yield* collectChanges({ debounce: "1 millis" });

    yield* watcher.watch(root);
    yield* fs.writeFileString(path.join(root, "state.json"), "{}");
    yield* Queue.take(seen);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("starts watching a directory that was missing on an earlier call", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dir-watcher-" });
    const dir = path.join(root, "later");
    const { watcher, seen } = yield* collectChanges({ debounce: "1 millis" });

    yield* watcher.watch(dir);
    yield* fs.makeDirectory(dir);
    yield* watcher.watch(dir);
    yield* fs.writeFileString(path.join(dir, "state.json"), "{}");
    yield* Queue.take(seen);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("asks accept about each event's directory and file name", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dir-watcher-" });
    const asked = yield* Deferred.make<readonly [string, string]>();
    const { watcher, seen } = yield* collectChanges({
      debounce: "1 millis",
      accept: (dir, fileName) => {
        Deferred.doneUnsafe(asked, Effect.succeed([dir, fileName] as const));
        return fileName === "wanted.json";
      },
    });

    yield* watcher.watch(root);
    yield* fs.writeFileString(path.join(root, "wanted.json"), "{}");
    expect(yield* Deferred.await(asked)).toEqual([root, "wanted.json"]);
    yield* Queue.take(seen);
  }).pipe(Effect.provide(NodeServices.layer)),
);
