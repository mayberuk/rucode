// @effect-diagnostics nodeBuiltinImport:off processEnvInEffect:off -- Fixtures need real sockets, file modes, a directory watch and the live PATH.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { connectTerminalHost } from "./client.ts";
import { startTerminalHost } from "./host.ts";
import { resolveTerminalHostAddress } from "./paths.ts";
import { readTerminalHostState, terminalHostStatePath } from "./stateFile.ts";

const userId = process.getuid?.() ?? 0;
const binPath = NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url));

class FakePty implements PtyAdapter.PtyProcess {
  readonly writes: Array<string | Buffer> = [];
  readonly signals: Array<string | undefined> = [];
  readonly firstWrite = Deferred.makeUnsafe<void>();
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  private exitEvent: PtyAdapter.PtyExitEvent | null = null;
  readonly pid: number;

  constructor(pid: number) {
    this.pid = pid;
  }

  write(data: string | Buffer): void {
    this.writes.push(data);
    Deferred.doneUnsafe(this.firstWrite, Effect.void);
  }

  resize(): void {}

  kill(signal?: string): void {
    this.signals.push(signal);
    this.exit({ exitCode: 0, signal: 1 });
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => this.dataListeners.delete(callback);
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    if (this.exitEvent !== null) {
      callback(this.exitEvent);
      return () => {};
    }
    this.exitListeners.add(callback);
    return () => this.exitListeners.delete(callback);
  }

  emit(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  exit(event: PtyAdapter.PtyExitEvent): void {
    if (this.exitEvent !== null) return;
    this.exitEvent = event;
    for (const listener of this.exitListeners) listener(event);
  }
}

const fakeSpawnInput = (cwd: string, env: NodeJS.ProcessEnv = {}): PtyAdapter.PtySpawnInput => ({
  shell: "/bin/fake",
  cwd,
  cols: 80,
  rows: 24,
  env,
});

const collect = (handle: PtyAdapter.PtyProcess, initial = "") => {
  let text = initial;
  const waiting = new Set<{ readonly needle: string; readonly done: Deferred.Deferred<void> }>();
  handle.onData((data) => {
    text += data;
    for (const waiter of waiting) {
      if (!text.includes(waiter.needle)) continue;
      waiting.delete(waiter);
      Deferred.doneUnsafe(waiter.done, Effect.void);
    }
  });
  return {
    text: () => text,
    until: (needle: string) =>
      Effect.suspend(() => {
        if (text.includes(needle)) return Effect.void;
        const done = Deferred.makeUnsafe<void>();
        waiting.add({ needle, done });
        return Deferred.await(done);
      }),
  };
};

const exitOf = (handle: PtyAdapter.PtyProcess) =>
  Effect.callback<PtyAdapter.PtyExitEvent>((resume) => {
    const stop = handle.onExit((event) => resume(Effect.succeed(event)));
    return Effect.sync(stop);
  });

const addressFor = (root: string, stateDir: string, platform: NodeJS.Platform) =>
  resolveTerminalHostAddress({
    stateDir,
    platform,
    tempDir: root,
    runtimeDir: root,
    userId,
    joinPath: NodePath.join,
  });

const tempRoot = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-th-" });
  const stateDir = `${root}/state`;
  yield* fs.makeDirectory(stateDir);
  return { root, stateDir, address: addressFor(root, stateDir, yield* HostProcess.Platform) };
});

const startInProcessHost = Effect.gen(function* () {
  const paths = yield* tempRoot;
  const fakes = new Map<number, FakePty>();
  let nextPid = 1000;
  const adapter = PtyAdapter.PtyAdapter.of({
    spawn: () =>
      Effect.sync(() => {
        const fake = new FakePty(nextPid++);
        fakes.set(fake.pid, fake);
        return fake;
      }),
  });
  const start = yield* startTerminalHost({
    stateDir: paths.stateDir,
    address: paths.address,
    idleExitMs: 3_600_000,
  }).pipe(Effect.provideService(PtyAdapter.PtyAdapter, adapter));
  assert(start._tag === "Serving");
  const fake = (handle: PtyAdapter.PtyProcess) => {
    const found = fakes.get(handle.pid);
    assert(found !== undefined);
    return found;
  };
  return { ...paths, host: start, fake };
});

describe("terminal host in process", () => {
  it.live("buffers output only while detached and keeps the newest 2 MiB", () =>
    Effect.gen(function* () {
      const { address, fake } = yield* startInProcessHost;
      const scopeA = yield* Scope.make();
      const a = yield* connectTerminalHost(address.socketPath).pipe(Scope.provide(scopeA));
      const handle = yield* a.spawn({
        key: "a",
        launch: { title: "A" },
        spawn: fakeSpawnInput("/w"),
      });
      const gone = yield* a.spawn({ key: "gone", launch: null, spawn: fakeSpawnInput("/w") });
      const seenByA = collect(handle);
      fake(handle).emit("while-attached");
      yield* seenByA.until("while-attached");

      handle.detach();
      gone.detach();
      // The host handles one connection's requests in order, so this reply follows both detaches.
      yield* a.spawn({ key: "sync", launch: null, spawn: fakeSpawnInput("/w") });
      // Two-byte characters: a cap counted in UTF-16 units would keep all five 512 KiB chunks.
      const chunks = [0, 1, 2, 3, 4].map((index) =>
        String.fromCharCode(0xe0 + index).repeat(256 * 1024),
      );
      for (const chunk of chunks) fake(handle).emit(chunk);
      fake(gone).exit({ exitCode: 3, signal: null });

      const b = yield* connectTerminalHost(address.socketPath);
      yield* a.closed;
      const adopted = new Map((yield* b.adoptAll).map((entry) => [entry.key, entry]));
      expect([...adopted.keys()].toSorted()).toEqual(["a", "gone", "sync"]);
      const adoptedA = adopted.get("a");
      assert(adoptedA !== undefined);
      expect(adoptedA.handle.pid).toBe(handle.pid);
      expect(adoptedA.launch).toEqual({ title: "A" });
      expect(adoptedA.exit).toBeNull();
      expect(adoptedA.backlog).toBe(chunks.slice(1).join(""));
      expect(adopted.get("sync")?.backlog).toBe("");
      expect(seenByA.text()).toBe("while-attached");

      const adoptedGone = adopted.get("gone");
      assert(adoptedGone !== undefined);
      expect(adoptedGone.exit).toEqual({ exitCode: 3, signal: null });
      expect(yield* exitOf(adoptedGone.handle)).toEqual({ exitCode: 3, signal: null });

      const seenByB = collect(adoptedA.handle);
      fake(handle).emit("after-adoption");
      yield* seenByB.until("after-adoption");
      expect(yield* b.adoptAll).toEqual([]);

      const c = yield* connectTerminalHost(address.socketPath);
      const again = yield* c.adoptAll;
      expect(again.map((entry) => entry.key).toSorted()).toEqual(["a", "sync"]);
      expect(again.find((entry) => entry.key === "a")?.backlog).toBe("");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("gives every session to a second client and closes the first", () =>
    Effect.gen(function* () {
      const { address, fake } = yield* startInProcessHost;
      const a = yield* connectTerminalHost(address.socketPath);
      const handle = yield* a.spawn({ key: "k", launch: null, spawn: fakeSpawnInput("/w") });
      const exitSeenByA = yield* Effect.forkScoped(exitOf(handle));

      const b = yield* connectTerminalHost(address.socketPath);
      yield* a.closed;
      expect(yield* Fiber.join(exitSeenByA)).toEqual({ exitCode: -1, signal: 1 });
      const [adopted] = yield* b.adoptAll;
      assert(adopted !== undefined);
      expect(adopted.key).toBe("k");
      expect(adopted.handle.pid).toBe(handle.pid);

      handle.write("from-a-after-close");
      adopted.handle.write(Buffer.from([0xff, 0x00, 0x1b]));
      yield* Deferred.await(fake(handle).firstWrite);
      expect(fake(handle).writes).toEqual([Buffer.from([0xff, 0x00, 0x1b])]);

      const seenByB = collect(adopted.handle);
      fake(handle).emit("to-b");
      yield* seenByB.until("to-b");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("keeps the state file to live sessions and never writes their environment", () =>
    Effect.gen(function* () {
      const { address, stateDir, host, fake } = yield* startInProcessHost;
      const client = yield* connectTerminalHost(address.socketPath);
      const selfExit = yield* client.spawn({
        key: "self-exit",
        launch: { runtimeEnv: { TOKEN: "launch-secret-value" } },
        spawn: fakeSpawnInput("/work/one", { SECRET_NAME: "env-secret-value" }),
      });
      const killed = yield* client.spawn({
        key: "killed",
        launch: null,
        spawn: fakeSpawnInput("/work/two"),
      });
      yield* client.recordCommand("self-exit", { line: "npm run dev", cwd: "/work/one/app" });
      yield* client.recordCommand("never-spawned", { line: "ignored", cwd: "/" });
      yield* client.spawn({ key: "sync", launch: null, spawn: fakeSpawnInput("/work/three") });
      yield* host.flushState;

      expect(yield* readTerminalHostState(stateDir)).toEqual([
        {
          key: "self-exit",
          cwd: "/work/one",
          lastCommand: { line: "npm run dev", cwd: "/work/one/app" },
          updatedAt: expect.any(String),
        },
        { key: "killed", cwd: "/work/two", lastCommand: null, updatedAt: expect.any(String) },
        { key: "sync", cwd: "/work/three", lastCommand: null, updatedAt: expect.any(String) },
      ]);
      const raw = yield* Effect.promise(() =>
        NodeFSP.readFile(terminalHostStatePath(stateDir), "utf8"),
      );
      for (const secret of ["SECRET_NAME", "env-secret-value", "TOKEN", "launch-secret-value"]) {
        expect(raw).not.toContain(secret);
      }

      fake(selfExit).exit({ exitCode: 0, signal: null });
      expect(yield* exitOf(selfExit)).toEqual({ exitCode: 0, signal: null });
      killed.kill("SIGTERM");
      expect(yield* exitOf(killed)).toEqual({ exitCode: 0, signal: 1 });
      expect(fake(killed).signals).toEqual(["SIGTERM"]);
      yield* host.flushState;
      expect((yield* readTerminalHostState(stateDir)).map((entry) => entry.key)).toEqual(["sync"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("keeps every live session restorable when it shuts down", () =>
    Effect.gen(function* () {
      const { address, stateDir, host, fake } = yield* startInProcessHost;
      const client = yield* connectTerminalHost(address.socketPath);
      const dev = yield* client.spawn({ key: "dev", launch: null, spawn: fakeSpawnInput("/w") });
      yield* client.recordCommand("dev", { line: "npm run dev", cwd: "/w" });
      const idle = yield* client.spawn({ key: "idle", launch: null, spawn: fakeSpawnInput("/i") });

      yield* host.shutdown;
      expect(yield* host.stopped).toBe("shutdown");
      expect(fake(dev).signals).toEqual(["SIGHUP"]);
      expect(fake(idle).signals).toEqual(["SIGHUP"]);
      expect(yield* readTerminalHostState(stateDir)).toEqual([
        {
          key: "dev",
          cwd: "/w",
          lastCommand: { line: "npm run dev", cwd: "/w" },
          updatedAt: expect.any(String),
        },
        { key: "idle", cwd: "/i", lastCommand: null, updatedAt: expect.any(String) },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

const shellInput = (cwd: string, env: NodeJS.ProcessEnv = {}): PtyAdapter.PtySpawnInput => ({
  shell: "/bin/sh",
  cwd,
  cols: 80,
  rows: 24,
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, PS1: "$ ", ...env },
});

const spawnHostProcess = (root: string, stateDir: string, idleExitMs: number) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        [binPath, "__terminal-host", "--state-dir", stateDir, "--idle-exit-ms", `${idleExitMs}`],
        { env: { TMPDIR: root, XDG_RUNTIME_DIR: root }, extendEnv: true },
      ),
    );
  });

const launchHost = (root: string, stateDir: string, idleExitMs: number) =>
  Effect.gen(function* () {
    const child = yield* spawnHostProcess(root, stateDir, idleExitMs);
    const stderrLines: string[] = [];
    const stderrWaiting = new Set<{
      readonly needle: string;
      readonly done: Deferred.Deferred<void>;
    }>();
    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.sync(() => {
          stderrLines.push(line);
          for (const waiter of stderrWaiting) {
            if (!line.includes(waiter.needle)) continue;
            stderrWaiting.delete(waiter);
            Deferred.doneUnsafe(waiter.done, Effect.void);
          }
        }),
      ),
      Effect.forkScoped,
    );
    const ready = yield* child.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead);
    assert(Option.isSome(ready), stderrLines.join("\n"));
    const match = /^ready (\d+)$/.exec(ready.value);
    assert(match !== null, ready.value);
    const pid = Number(match[1]);
    expect(pid).toBe(Number(child.pid));
    yield* Effect.addFinalizer(() =>
      child.isRunning.pipe(
        Effect.map((running) => {
          if (running) process.kill(pid, "SIGTERM");
        }),
        Effect.ignore,
      ),
    );
    return {
      pid,
      exitCode: child.exitCode.pipe(Effect.map(Number)),
      stderrLine: (needle: string) =>
        Effect.suspend(() => {
          if (stderrLines.some((line) => line.includes(needle))) return Effect.void;
          const done = Deferred.makeUnsafe<void>();
          stderrWaiting.add({ needle, done });
          return Deferred.await(done);
        }),
    };
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

describe("terminal host process", () => {
  it.live("keeps a shell and its output for the next client after a connection closes", () =>
    Effect.gen(function* () {
      const { root, stateDir, address } = yield* tempRoot;
      const host = yield* launchHost(root, stateDir, 3_600_000);

      const directory = yield* Effect.promise(() => NodeFSP.lstat(address.directory));
      expect(directory.isDirectory()).toBe(true);
      expect(directory.mode & 0o777).toBe(0o700);
      expect(directory.uid).toBe(userId);
      const socket = yield* Effect.promise(() => NodeFSP.lstat(address.socketPath));
      expect(socket.isSocket()).toBe(true);
      expect(socket.mode & 0o777).toBe(0o600);

      const scopeA = yield* Scope.make();
      const a = yield* connectTerminalHost(address.socketPath).pipe(Scope.provide(scopeA));
      expect(a.hostPid).toBe(host.pid);
      const shell = yield* a.spawn({
        key: "shell",
        launch: { title: "sh" },
        spawn: shellInput(root),
      });
      const seenByA = collect(shell);
      // Arithmetic keeps the marker out of the echoed command line.
      shell.write('while [ ! -e go ]; do sleep 0.01; done; echo "between-$((6*7))"; : > printed\n');
      yield* seenByA.until("printed");
      yield* Scope.close(scopeA, Exit.void);
      yield* host.stderrLine("owner disconnected");

      const printed = yield* fileCreated(root, "printed");
      yield* Effect.promise(() => NodeFSP.writeFile(`${root}/go`, ""));
      yield* printed;

      const b = yield* connectTerminalHost(address.socketPath);
      const [adopted] = yield* b.adoptAll;
      assert(adopted !== undefined);
      expect(adopted.key).toBe("shell");
      expect(adopted.handle.pid).toBe(shell.pid);
      expect(adopted.launch).toEqual({ title: "sh" });
      // The host may read the shell's output just before or just after this hello.
      const seenByB = collect(adopted.handle, adopted.backlog);
      yield* seenByB.until("between-42");
      expect(seenByA.text()).not.toContain("between-42");

      adopted.handle.write("echo still-$((40+2))\n");
      yield* seenByB.until("still-42");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("exits with status 0 when another host already serves the address", () =>
    Effect.gen(function* () {
      const { root, stateDir, address } = yield* tempRoot;
      const first = yield* launchHost(root, stateDir, 3_600_000);
      const second = yield* spawnHostProcess(root, stateDir, 3_600_000);
      const { stdout, exitCode } = yield* Effect.all(
        {
          stdout: second.stdout.pipe(Stream.decodeText(), Stream.mkString),
          exitCode: second.exitCode,
        },
        { concurrency: "unbounded" },
      );
      expect(Number(exitCode)).toBe(0);
      expect(stdout).toBe("");

      const client = yield* connectTerminalHost(address.socketPath);
      expect(client.hostPid).toBe(first.pid);
      const shell = yield* client.spawn({ key: "s", launch: null, spawn: shellInput(root) });
      const output = collect(shell);
      shell.write("echo served-$((1+1))\n");
      yield* output.until("served-2");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("exits on its own once its last session is killed and no client is connected", () =>
    Effect.gen(function* () {
      const { root, stateDir, address } = yield* tempRoot;
      const host = yield* launchHost(root, stateDir, 250);
      const scope = yield* Scope.make();
      const client = yield* connectTerminalHost(address.socketPath).pipe(Scope.provide(scope));
      const shell = yield* client.spawn({ key: "s", launch: null, spawn: shellInput(root) });
      shell.kill("SIGKILL");
      expect((yield* exitOf(shell)).exitCode).not.toBe(-1);
      yield* Scope.close(scope, Exit.void);
      expect(yield* host.exitCode).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("leaves live sessions and their last command in the state file on SIGTERM", () =>
    Effect.gen(function* () {
      const { root, stateDir, address } = yield* tempRoot;
      const host = yield* launchHost(root, stateDir, 3_600_000);
      const client = yield* connectTerminalHost(address.socketPath);
      yield* client.spawn({
        key: "dev",
        launch: { runtimeEnv: { TOKEN: "launch-secret-value" } },
        spawn: shellInput(root, { SECRET_NAME: "env-secret-value" }),
      });
      yield* client.recordCommand("dev", { line: "npm run dev", cwd: root });
      yield* client.spawn({ key: "idle", launch: null, spawn: shellInput(stateDir) });

      process.kill(host.pid, "SIGTERM");
      expect(yield* host.exitCode).toBe(0);
      expect(yield* readTerminalHostState(stateDir)).toEqual([
        {
          key: "dev",
          cwd: root,
          lastCommand: { line: "npm run dev", cwd: root },
          updatedAt: expect.any(String),
        },
        { key: "idle", cwd: stateDir, lastCommand: null, updatedAt: expect.any(String) },
      ]);
      const raw = yield* Effect.promise(() =>
        NodeFSP.readFile(terminalHostStatePath(stateDir), "utf8"),
      );
      for (const secret of ["SECRET_NAME", "env-secret-value", "TOKEN", "launch-secret-value"]) {
        expect(raw).not.toContain(secret);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
