import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ClaudeSessionRegistry from "./ClaudeSessionRegistry.ts";

const MACHINE_ID = "0123456789abcdef0123456789abcdef";
const PID_NAMESPACE = "pid:[4026531836]";
const DOMAIN = `linux:${MACHINE_ID}:${PID_NAMESPACE}`;
const SESSION = "0b7c2a1e-5f3d-4c1a-9e8b-1d2f3a4b5c6d";
const OTHER_SESSION = "1c8d3b2f-6a4e-4d2b-8f9c-2e3a4b5c6d7e";

const registryJson = (pid: number, sessionId: string, fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    pid,
    sessionId,
    cwd: "/home/someone/dev/repo",
    kind: "interactive",
    entrypoint: "cli",
    tmux: "main:@27.%28",
    name: "repo-work",
    status: "idle",
    procStart: `${pid}00`,
    pidDomain: DOMAIN,
    ...fields,
  });

type Registry = ClaudeSessionRegistry.ClaudeSessionRegistry["Service"];

// Real file-system events arrive on wall-clock time; the test raises the watch events itself.
const withRegistry = <A, E>(
  body: (input: {
    readonly registry: Registry;
    readonly writeEntry: (
      file: string,
      contents: string,
    ) => Effect.Effect<void, PlatformError.PlatformError>;
    readonly removeEntry: (file: string) => Effect.Effect<void, PlatformError.PlatformError>;
    readonly startProcess: (
      pid: number,
      environ?: string,
    ) => Effect.Effect<void, PlatformError.PlatformError>;
    /** Ends the process without touching its registry file, as a kill or SIGHUP can. */
    readonly endProcess: (pid: number) => Effect.Effect<void, PlatformError.PlatformError>;
  }) => Effect.Effect<A, E | PlatformError.PlatformError>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-session-registry-" });
    const claudeHome = `${root}/claude`;
    const sessionsDir = `${claudeHome}/sessions`;
    const procRoot = `${root}/proc`;
    yield* fs.makeDirectory(sessionsDir, { recursive: true });
    yield* fs.makeDirectory(`${procRoot}/self/ns`, { recursive: true });
    yield* fs.symlink(PID_NAMESPACE, `${procRoot}/self/ns/pid`);
    yield* fs.writeFileString(`${root}/machine-id`, `${MACHINE_ID}\n`);

    const events = yield* Queue.unbounded<FileSystem.WatchEvent>();
    const watching = FileSystem.FileSystem.of({
      ...fs,
      watch: (path, options) =>
        path === sessionsDir
          ? Stream.fromQueue(events).pipe(Stream.onStart(Effect.sync(() => options?.onReady?.())))
          : fs.watch(path, options),
    });
    const notify = (file: string) =>
      Queue.offer(events, { _tag: "Update", path: `${sessionsDir}/${file}` });

    const settings = Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, providerInstances: {} }),
    });
    const registry = yield* ClaudeSessionRegistry.make({
      procRoot,
      machineIdPath: `${root}/machine-id`,
    }).pipe(
      Effect.provide(settings),
      Effect.provideService(
        ProcessRunner.ProcessRunner,
        ProcessRunner.ProcessRunner.of({ run: () => Effect.die("Linux reads /proc, not ps") }),
      ),
      Effect.provideService(FileSystem.FileSystem, watching),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { CLAUDE_CONFIG_DIR: claudeHome }),
      Effect.provideService(HostProcess.HomeDirectory, `${root}/home`),
    );

    return yield* body({
      registry,
      writeEntry: (file, contents) =>
        fs.writeFileString(`${sessionsDir}/${file}`, contents).pipe(Effect.andThen(notify(file))),
      removeEntry: (file) => fs.remove(`${sessionsDir}/${file}`).pipe(Effect.andThen(notify(file))),
      startProcess: (pid, environ = "") =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(`${procRoot}/${pid}`, { recursive: true });
          const beforeStart = Array.from({ length: 18 }, (_, index) => String(index + 4));
          yield* fs.writeFileString(
            `${procRoot}/${pid}/stat`,
            `${pid} (claude main) S ${beforeStart.join(" ")} ${pid}00 7 8 9\n`,
          );
          yield* fs.writeFileString(`${procRoot}/${pid}/environ`, environ);
        }),
      endProcess: (pid) => fs.remove(`${procRoot}/${pid}`, { recursive: true }),
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const attachmentFor = (registry: Registry, sessionId: string) =>
  SubscriptionRef.changes(registry.attachments).pipe(
    Stream.map((attachments) => attachments.get(sessionId)),
    Stream.filter((attachment) => attachment !== undefined),
    Stream.runHead,
    Effect.map((found) => found.pipe(Option.getOrThrow)),
  );

it.effect("publishes an attachment for a live registry entry written after start", () =>
  withRegistry(({ registry, writeEntry, startProcess }) =>
    Effect.gen(function* () {
      expect((yield* SubscriptionRef.get(registry.attachments)).size).toBe(0);
      yield* startProcess(4242, "PATH=/bin\0TMUX=/tmp/tmux-1000/default,1234,0\0HOME=/h\0");
      yield* writeEntry("4242.json", registryJson(4242, SESSION));

      const attachment = yield* attachmentFor(registry, SESSION);
      expect(attachment).toMatchObject({
        sessionId: SESSION,
        pid: 4242,
        owner: "terminal",
        status: "idle",
        name: "repo-work",
        pane: { session: "main", pane: "%28" },
      });
      expect(yield* registry.socketOf(4242)).toBe("/tmp/tmux-1000/default");
      expect((yield* registry.entry(SESSION))?.pid).toBe(4242);
    }),
  ),
);

it.effect("leaves out entries that are not live or that rucode itself owns", () =>
  withRegistry(({ registry, writeEntry, startProcess }) =>
    Effect.gen(function* () {
      yield* startProcess(4242);
      yield* startProcess(5151);
      yield* writeEntry("4242.json", registryJson(4242, SESSION, { entrypoint: "t3-code" }));
      yield* writeEntry("6000.json", registryJson(6000, OTHER_SESSION));
      yield* writeEntry("5151.json", registryJson(5151, "2d9e4c3a-7b5f-4e3c-9a0d-3f4a5b6c7d8e"));

      yield* attachmentFor(registry, "2d9e4c3a-7b5f-4e3c-9a0d-3f4a5b6c7d8e");
      const attachments = yield* SubscriptionRef.get(registry.attachments);
      expect([...attachments.keys()]).toEqual(["2d9e4c3a-7b5f-4e3c-9a0d-3f4a5b6c7d8e"]);
      expect((yield* registry.entry(SESSION))?.owner).toBe("rucode");
      expect(yield* registry.entry(OTHER_SESSION)).toBeNull();
    }),
  ),
);

it.effect("resolves awaitGone when the entry is deleted, and times out otherwise", () =>
  withRegistry(({ registry, writeEntry, removeEntry, startProcess }) =>
    Effect.gen(function* () {
      yield* startProcess(4242);
      yield* startProcess(5151);
      yield* writeEntry("4242.json", registryJson(4242, SESSION));
      yield* writeEntry("5151.json", registryJson(5151, OTHER_SESSION));
      yield* attachmentFor(registry, SESSION);
      yield* attachmentFor(registry, OTHER_SESSION);

      const gone = yield* registry.awaitGone(SESSION, "5 seconds").pipe(Effect.forkChild);
      const stays = yield* registry.awaitGone(OTHER_SESSION, "5 seconds").pipe(Effect.forkChild);
      yield* removeEntry("4242.json");
      expect(yield* Fiber.join(gone)).toBe(true);

      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(stays)).toBe(false);
    }),
  ),
);

it.effect("drops a holder that died without removing its file on the next liveness check", () =>
  withRegistry(({ registry, writeEntry, startProcess, endProcess }) =>
    Effect.gen(function* () {
      yield* startProcess(4242);
      yield* writeEntry("4242.json", registryJson(4242, SESSION));
      yield* attachmentFor(registry, SESSION);

      yield* endProcess(4242);
      yield* TestClock.adjust("15 seconds");
      expect(yield* registry.awaitGone(SESSION, "1 hour")).toBe(true);
    }),
  ),
);

it.effect("drops a dead holder as soon as a fresh read of its session finds it gone", () =>
  withRegistry(({ registry, writeEntry, startProcess, endProcess }) =>
    Effect.gen(function* () {
      yield* startProcess(4242);
      yield* writeEntry("4242.json", registryJson(4242, SESSION));
      yield* attachmentFor(registry, SESSION);

      yield* endProcess(4242);
      expect(yield* registry.entry(SESSION)).toBeNull();
      expect(yield* registry.awaitGone(SESSION, "1 hour")).toBe(true);
    }),
  ),
);

it.effect("ignores .key files and does not let one malformed file hide the others", () =>
  withRegistry(({ registry, writeEntry, startProcess }) =>
    Effect.gen(function* () {
      yield* startProcess(4242);
      yield* startProcess(5151);
      yield* writeEntry(
        "5151.a7c664604b344c37b5aadfefc8c1fb81.key",
        registryJson(5151, OTHER_SESSION),
      );
      yield* writeEntry("7777.json", '{"pid": 7777, "sessionId": ');
      yield* writeEntry("4242.json", registryJson(4242, SESSION));

      yield* attachmentFor(registry, SESSION);
      const attachments = yield* SubscriptionRef.get(registry.attachments);
      expect([...attachments.keys()]).toEqual([SESSION]);
    }),
  ),
);
