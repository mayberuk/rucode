// @effect-diagnostics nodeBuiltinImport:off processEnvInEffect:off -- Fixtures need a real host process, real PTYs, a directory watch and the live environment.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import type { TerminalSessionSnapshot } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";

import * as ProcessRunner from "../processRunner.ts";
import { connectTerminalHost } from "../terminalHost/client.ts";
import { resolveTerminalHostAddress } from "../terminalHost/paths.ts";
import {
  readTerminalHostState,
  terminalHostStatePath,
  type TerminalHostStateEntry,
} from "../terminalHost/stateFile.ts";
import * as TerminalManager from "./Manager.ts";
import * as NodePtyAdapter from "./NodePtyAdapter.ts";
import { makeLiveTerminalSessionHost } from "./sessionHostLive.ts";

const userId = process.getuid?.() ?? 0;
const sessionKey = JSON.stringify(["thread-1", "term-1"]);

const services = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  NodePtyAdapter.layer.pipe(Layer.provide(NodeServices.layer)),
  ProcessRunner.layer.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

const unusedPty: PtyAdapter.PtyAdapter["Service"] = PtyAdapter.PtyAdapter.of({
  spawn: () => Effect.die("the in-process adapter must not be used here"),
});

const tempRoot = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-th-live-" });
  const stateDir = `${root}/state`;
  yield* fs.makeDirectory(stateDir);
  const address = resolveTerminalHostAddress({
    stateDir,
    platform: yield* HostProcess.Platform,
    tempDir: NodeOS.tmpdir(),
    runtimeDir: root,
    userId,
    joinPath: NodePath.join,
  });
  // systemd-run is kept off PATH so no test creates a unit in the developer's user manager.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: NodePath.dirname(process.execPath),
    XDG_RUNTIME_DIR: root,
  };
  return { root, stateDir, address, env };
});

/** Signals the host by the pid it reports for itself, whichever server launched it. */
const stopHostAt = (socketPath: string) =>
  connectTerminalHost(socketPath).pipe(
    Effect.map((client) => process.kill(client.hostPid, "SIGTERM")),
    Effect.scoped,
    Effect.ignore,
  );

describe("makeLiveTerminalSessionHost selection", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly platform: NodeJS.Platform;
    readonly env: NodeJS.ProcessEnv;
    readonly enabled?: boolean;
    readonly persistent: boolean;
  }> = [
    {
      name: "Vitest without opt-in",
      platform: "linux",
      env: { VITEST: "true" },
      persistent: false,
    },
    {
      name: "Vitest opted out",
      platform: "linux",
      env: { VITEST: "true" },
      enabled: false,
      persistent: false,
    },
    {
      name: "Vitest opted in",
      platform: "linux",
      env: { VITEST: "true" },
      enabled: true,
      persistent: true,
    },
    { name: "outside Vitest", platform: "linux", env: {}, persistent: true },
    { name: "Windows", platform: "win32", env: {}, enabled: true, persistent: false },
    {
      name: "AppImage",
      platform: "linux",
      env: { APPIMAGE: "/home/u/T3.AppImage" },
      enabled: true,
      persistent: false,
    },
    {
      name: "switched off",
      platform: "linux",
      env: { T3CODE_TERMINAL_HOST: "0" },
      enabled: true,
      persistent: false,
    },
    {
      name: "switched on",
      platform: "linux",
      env: { T3CODE_TERMINAL_HOST: "1" },
      enabled: true,
      persistent: true,
    },
  ];

  it.effect.each(cases)("$name", (testCase) =>
    Effect.gen(function* () {
      const { root, stateDir, address } = yield* tempRoot;
      const { VITEST: _vitest, ...base } = process.env;
      const scope = yield* Scope.make();
      const host = yield* makeLiveTerminalSessionHost({
        ptyAdapter: unusedPty,
        stateDir,
        ...(testCase.enabled === undefined ? {} : { enabled: testCase.enabled }),
      }).pipe(
        Scope.provide(scope),
        Effect.provideService(HostProcess.Platform, testCase.platform),
        Effect.provideService(HostProcess.Environment, {
          ...base,
          PATH: NodePath.dirname(process.execPath),
          XDG_RUNTIME_DIR: root,
          ...testCase.env,
        }),
      );
      expect(host.persistent).toBe(testCase.persistent);
      expect(yield* host.adoptAll).toEqual([]);
      yield* Scope.close(scope, Exit.void);
      // Starting a server never launches a host; only spawning a terminal does.
      expect(NodeFS.existsSync(address.socketPath)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("makeLiveTerminalSessionHost", () => {
  it.effect("reads the restorable command from the state file with no host running", () =>
    Effect.gen(function* () {
      const { stateDir, env } = yield* tempRoot;
      const entries: ReadonlyArray<TerminalHostStateEntry> = [
        {
          key: sessionKey,
          cwd: "/work",
          lastCommand: { line: "npm run dev", cwd: "/work/app" },
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          key: JSON.stringify(["thread-1", "idle"]),
          cwd: "/work",
          lastCommand: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ];
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          terminalHostStatePath(stateDir),
          JSON.stringify({ version: 1, sessions: entries }),
        ),
      );
      const host = yield* makeLiveTerminalSessionHost({
        ptyAdapter: unusedPty,
        stateDir,
        enabled: true,
      }).pipe(Effect.provideService(HostProcess.Environment, env));

      expect(yield* host.restorableCommand({ threadId: "thread-1", terminalId: "term-1" })).toEqual(
        Option.some({ line: "npm run dev", cwd: "/work/app" }),
      );
      expect(yield* host.restorableCommand({ threadId: "thread-1", terminalId: "idle" })).toEqual(
        Option.none(),
      );
      expect(yield* host.restorableCommand({ threadId: "thread-2", terminalId: "term-1" })).toEqual(
        Option.none(),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("opens an in-process terminal with one warning when the host cannot launch", () =>
    Effect.gen(function* () {
      const { stateDir, address, env } = yield* tempRoot;
      const warnings: string[] = [];
      const fallback: PtyAdapter.PtyProcess = {
        pid: 4242,
        write: () => {},
        resize: () => {},
        kill: () => {},
        onData: () => () => {},
        onExit: () => () => {},
      };
      const spawned: PtyAdapter.PtySpawnInput[] = [];
      const adapter = PtyAdapter.PtyAdapter.of({
        spawn: (input) => Effect.sync(() => (spawned.push(input), fallback)),
      });
      const spawnInput: PtyAdapter.PtySpawnInput = {
        shell: "/bin/sh",
        cwd: stateDir,
        cols: 80,
        rows: 24,
        env: {},
      };
      const opened = yield* Effect.gen(function* () {
        const host = yield* makeLiveTerminalSessionHost({
          ptyAdapter: adapter,
          stateDir,
          enabled: true,
        });
        return yield* host.spawn(
          { threadId: "thread-1", terminalId: "term-1" },
          {
            cwd: stateDir,
            worktreePath: null,
            shell: "/bin/sh",
            runtimeEnv: null,
            stopOnSettle: false,
            cols: 80,
            rows: 24,
          },
          spawnInput,
        );
      }).pipe(
        Effect.provideService(HostProcess.Environment, env),
        Effect.provideService(HostProcess.ExecutablePath, `${stateDir}/missing-node`),
        Effect.provide(
          Logger.layer(
            [
              Logger.make(({ logLevel, message }) => {
                if (logLevel === "Warn") warnings.push(String(message));
              }),
            ],
            { mergeWithExisting: false },
          ),
        ),
      );
      expect(opened.pid).toBe(4242);
      expect(spawned).toEqual([spawnInput]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("in-process");
      expect(NodeFS.existsSync(address.socketPath)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("keeps a terminal running across a server restart and reattaches it", () =>
    Effect.gen(function* () {
      const { root, stateDir, address, env } = yield* tempRoot;
      yield* Effect.addFinalizer(() => stopHostAt(address.socketPath));
      const ptyAdapter = yield* PtyAdapter.PtyAdapter;
      const logsDir = `${stateDir}/logs/terminals`;
      const terminal = { threadId: "thread-1", terminalId: "term-1" };

      const startServer = Effect.gen(function* () {
        const sessionHost = yield* makeLiveTerminalSessionHost({
          ptyAdapter,
          stateDir,
          enabled: true,
        }).pipe(Effect.provideService(HostProcess.Environment, env));
        const manager = yield* TerminalManager.makeWithOptions({
          logsDir,
          ptyAdapter,
          sessionHost,
          shellResolver: () => "/bin/sh",
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, PS1: "$ " },
          processKillGraceMs: 50,
        }).pipe(Effect.provideService(SpawnExecutableResolution, (command) => command));
        const output = yield* watchOutput(manager);
        return { sessionHost, manager, output };
      });

      const scopeA = yield* Scope.make();
      const serverA = yield* startServer.pipe(Scope.provide(scopeA));
      expect(serverA.sessionHost.persistent).toBe(true);
      const opened = yield* serverA.manager.open({ ...terminal, cwd: root, cols: 80, rows: 24 });
      const pid = opened.pid;
      assert(pid !== null);
      yield* serverA.manager.write({ ...terminal, data: "echo marker-one\r" });
      // The echoed command has a space before the marker; only the command's output starts a line with it.
      yield* serverA.output.until(/[\r\n]marker-one/);
      // Arithmetic keeps the marker out of the echoed command line.
      yield* serverA.manager.write({
        ...terminal,
        data: 'while [ ! -e go ]; do sleep 0.01; done; echo "between-$((6*7))"; : > printed\r',
      });
      yield* serverA.output.until(/printed/);
      yield* Scope.close(scopeA, Exit.void);

      expect(() => process.kill(pid, 0)).not.toThrow();
      const printed = yield* fileCreated(root, "printed");
      yield* Effect.promise(() => NodeFSP.writeFile(`${root}/go`, ""));
      yield* printed;

      const serverB = yield* startServer;
      const snapshot = yield* resumeSnapshot(serverB.manager, terminal);
      expect(snapshot.pid).toBe(pid);
      expect(snapshot.status).toBe("running");
      expect(snapshot.history).toContain("marker-one");
      // The host may hand the output over in its backlog or just after, as live output.
      serverB.output.seed(snapshot.history);
      yield* serverB.output.until(/between-42/);

      yield* serverB.manager.write({ ...terminal, data: "echo marker-two\r" });
      yield* serverB.output.until(/[\r\n]marker-two/);
      yield* stateWhere(stateDir, (entries) => entries.some((entry) => entry.key === sessionKey));

      yield* serverB.manager.close(terminal);
      yield* stateWhere(stateDir, (entries) => entries.every((entry) => entry.key !== sessionKey));
      expect(() => process.kill(pid, 0)).toThrow();
    }).pipe(Effect.scoped, Effect.provide(services)),
  );
});

const watchOutput = (manager: TerminalManager.TerminalManager["Service"]) =>
  Effect.gen(function* () {
    let seeded = "";
    let text = "";
    const waiting = new Set<{ readonly needle: RegExp; readonly done: Deferred.Deferred<void> }>();
    const settle = () => {
      for (const waiter of waiting) {
        if (!waiter.needle.test(seeded + text)) continue;
        waiting.delete(waiter);
        Deferred.doneUnsafe(waiter.done, Effect.void);
      }
    };
    const unsubscribe = yield* manager.subscribe((event) =>
      Effect.sync(() => {
        if (event.type !== "output") return;
        text += event.data;
        settle();
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    return {
      seed: (history: string) => {
        seeded = history;
        settle();
      },
      until: (needle: RegExp) =>
        Effect.suspend(() => {
          if (needle.test(seeded + text)) return Effect.void;
          const done = Deferred.makeUnsafe<void>();
          waiting.add({ needle, done });
          return Deferred.await(done);
        }),
    };
  });

const resumeSnapshot = (
  manager: TerminalManager.TerminalManager["Service"],
  terminal: { readonly threadId: string; readonly terminalId: string },
) =>
  Effect.gen(function* () {
    const snapshot = yield* Deferred.make<TerminalSessionSnapshot>();
    const stop = yield* manager.attachStream({ ...terminal, resume: true }, (event) =>
      event.type === "snapshot"
        ? Deferred.succeed(snapshot, event.snapshot).pipe(Effect.asVoid)
        : Effect.void,
    );
    yield* Effect.addFinalizer(() => Effect.sync(stop));
    return yield* Deferred.await(snapshot);
  });

/** Watches before returning, so a file created afterwards is never missed. */
const fileCreated = (directory: string, name: string) =>
  Effect.gen(function* () {
    const created = Deferred.makeUnsafe<void>();
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        NodeFS.watch(directory, (_event, filename) => {
          if (filename === name) Deferred.doneUnsafe(created, Effect.void);
        }),
      ),
      (watcher) => Effect.sync(() => watcher.close()),
    );
    return Deferred.await(created);
  });

/** Completes once the host's state file satisfies `predicate`, re-reading it on each change. */
const stateWhere = (
  stateDir: string,
  predicate: (entries: ReadonlyArray<TerminalHostStateEntry>) => boolean,
) =>
  Effect.gen(function* () {
    const changes = yield* Queue.unbounded<void>();
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        NodeFS.watch(stateDir, (_event, filename) => {
          if (filename === "terminal-host.json") Queue.offerUnsafe(changes, undefined);
        }),
      ),
      (watcher) => Effect.sync(() => watcher.close()),
    );
    while (!predicate(yield* readTerminalHostState(stateDir))) yield* Queue.take(changes);
  }).pipe(Effect.scoped);
