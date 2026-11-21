import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export interface DirectoryWatcher {
  /** Idempotent. A missing directory is skipped and retried on the next call. */
  readonly watch: (dir: string) => Effect.Effect<void>;
  /** One-shot change signal; replaces an earlier wake for the same key. */
  readonly wakeAfter: (key: string, delay: Duration.Input) => Effect.Effect<void>;
  readonly changes: Stream.Stream<void>;
}

const fileName = (path: string) =>
  path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);

export const makeDirectoryWatcher = Effect.fn("PluginCards.makeDirectoryWatcher")(
  function* (options: {
    readonly debounce: Duration.Input;
    readonly accept?: (dir: string, fileName: string) => boolean;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const scope = yield* Scope.Scope;
    const signals = yield* PubSub.unbounded<void>();
    const publish = PubSub.publish(signals, undefined).pipe(Effect.asVoid);
    const accept = options.accept ?? (() => true);
    const watched = new Set<string>();
    const wakes = new Map<string, { readonly token: object; readonly fiber: Fiber.Fiber<void> }>();

    const watch = Effect.fn("PluginCards.watchDirectory")(function* (dir: string) {
      if (watched.has(dir)) return;
      watched.add(dir);
      if (!(yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false)))) {
        watched.delete(dir);
        return;
      }
      const ready = yield* Deferred.make<void>();
      yield* fs
        .watch(dir, {
          onReady: () => {
            Deferred.doneUnsafe(ready, Effect.void);
          },
        })
        .pipe(
          Stream.filter((event) => accept(dir, fileName(event.path))),
          Stream.runForEach(() => publish),
          Effect.ignoreCause({ log: true }),
          Effect.ensuring(
            Effect.sync(() => {
              watched.delete(dir);
              Deferred.doneUnsafe(ready, Effect.void);
            }),
          ),
          Effect.forkIn(scope),
        );
      yield* Deferred.await(ready);
    });

    const wakeAfter = Effect.fn("PluginCards.wakeAfter")(function* (
      key: string,
      delay: Duration.Input,
    ) {
      const token = {};
      const fiber = yield* Effect.sleep(delay).pipe(
        Effect.andThen(publish),
        Effect.ensuring(
          Effect.sync(() => {
            if (wakes.get(key)?.token === token) wakes.delete(key);
          }),
        ),
        Effect.forkIn(scope),
      );
      // Swap before any suspension, so two concurrent wakes for one key cannot both survive.
      const previous = wakes.get(key);
      wakes.set(key, { token, fiber });
      if (previous !== undefined) yield* Fiber.interrupt(previous.fiber);
    });

    return {
      watch,
      wakeAfter,
      changes: Stream.fromPubSub(signals).pipe(Stream.debounce(options.debounce)),
    } satisfies DirectoryWatcher;
  },
);
