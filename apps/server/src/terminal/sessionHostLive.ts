// @effect-diagnostics nodeBuiltinImport:off -- The host derives its socket from the OS temp directory, and a source run finds the entry beside this module.
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";

import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import {
  connectTerminalHost,
  type HostedPtyHandle,
  type HostSessionAdoption,
  type TerminalHostClient,
} from "../terminalHost/client.ts";
import {
  ensureTerminalHost,
  findSystemdRun,
  resolveTerminalHostCommand,
  terminalHostUnitName,
  wrapForSystemdScope,
} from "../terminalHost/launcher.ts";
import { resolveTerminalHostAddress } from "../terminalHost/paths.ts";
import { readTerminalHostState } from "../terminalHost/stateFile.ts";
import {
  inProcessTerminalSessionHost,
  type AdoptedTerminalSession,
  type HostedPtyProcess,
  type TerminalSessionHostShape,
  type TerminalSessionKey,
} from "./sessionHost.ts";

const decodeSessionKey = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
);
const encodeSessionKey = (key: TerminalSessionKey) =>
  JSON.stringify([key.threadId, key.terminalId]);

const decodeLaunchRecord = Schema.decodeUnknownOption(
  Schema.Struct({
    cwd: Schema.String,
    worktreePath: Schema.NullOr(Schema.String),
    shell: Schema.String,
    runtimeEnv: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
    stopOnSettle: Schema.Boolean,
    cols: Schema.Int,
    rows: Schema.Int,
  }),
);

// How the host client reports its own connection closing, as opposed to a shell exit.
const isConnectionLoss = (event: PtyAdapter.PtyExitEvent) =>
  event.exitCode === -1 && event.signal === 1;

class ReattachablePty implements HostedPtyProcess {
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  private pendingData: string[] | null = [];
  private exitEvent: PtyAdapter.PtyExitEvent | null = null;
  private lostConnection: PtyAdapter.PtyExitEvent | null = null;
  private requestedKill: { readonly signal: string | undefined } | null = null;
  private detached = false;
  private inner: HostedPtyHandle;
  private stopInner: () => void = () => {};
  readonly key: string;
  readonly pid: number;
  private readonly release: (handle: ReattachablePty) => void;

  constructor(key: string, inner: HostedPtyHandle, release: (handle: ReattachablePty) => void) {
    this.key = key;
    this.pid = inner.pid;
    this.inner = inner;
    this.release = release;
    this.bind(inner, "");
  }

  get live(): boolean {
    return !this.detached && this.exitEvent === null;
  }

  private bind(inner: HostedPtyHandle, backlog: string): void {
    this.inner = inner;
    if (backlog.length > 0) this.emitData(backlog);
    const stopData = inner.onData((data) => this.emitData(data));
    const stopExit = inner.onExit((event) => {
      if (isConnectionLoss(event)) this.lostConnection = event;
      else this.finish(event);
    });
    this.stopInner = () => {
      stopData();
      stopExit();
    };
  }

  rebind(adoption: HostSessionAdoption): void {
    if (!this.live) return;
    this.stopInner();
    this.lostConnection = null;
    this.bind(adoption.handle, adoption.backlog);
    if (this.requestedKill !== null) adoption.handle.kill(this.requestedKill.signal);
  }

  giveUp(): void {
    const lost = this.lostConnection;
    this.lostConnection = null;
    if (lost !== null) this.finish(lost);
  }

  private finish(event: PtyAdapter.PtyExitEvent): void {
    if (this.exitEvent !== null) return;
    this.exitEvent = event;
    this.stopInner();
    this.release(this);
    for (const listener of this.exitListeners) listener(event);
    this.exitListeners.clear();
  }

  private emitData(data: string): void {
    if (this.detached) return;
    if (this.pendingData !== null) {
      this.pendingData.push(data);
      return;
    }
    for (const listener of this.dataListeners) listener(data);
  }

  write(data: string | Buffer): void {
    this.inner.write(data);
  }

  resize(cols: number, rows: number): void {
    this.inner.resize(cols, rows);
  }

  kill(signal?: string): void {
    // A kill sent while the connection is down would be lost; rebind repeats it.
    this.requestedKill = { signal };
    this.inner.kill(signal);
  }

  detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.stopInner();
    this.inner.detach();
    this.pendingData = null;
    this.dataListeners.clear();
    this.exitListeners.clear();
    this.release(this);
  }

  onData(callback: (data: string) => void): () => void {
    if (this.detached) return () => {};
    this.dataListeners.add(callback);
    const pending = this.pendingData;
    this.pendingData = null;
    if (pending !== null) for (const data of pending) callback(data);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    if (this.exitEvent !== null) {
      if (!this.detached) callback(this.exitEvent);
      return () => {};
    }
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }
}

const SERVER_ENTRY = /(?:^|[\\/])bin\.(?:ts|mjs)$/;

/**
 * Terminals run in a terminal host that outlives this server where the platform allows it, and
 * in-process otherwise. Never launches a host until a terminal is spawned.
 */
export const makeLiveTerminalSessionHost = Effect.fn("TerminalSessionHost.makeLive")(
  function* (input: {
    readonly ptyAdapter: PtyAdapter.PtyAdapter["Service"];
    readonly stateDir: string;
    /** Opts a Vitest run in; every other run decides from the platform and environment. */
    readonly enabled?: boolean;
  }): Effect.fn.Return<
    TerminalSessionHostShape,
    never,
    Scope.Scope | FileSystem.FileSystem | Path.Path
  > {
    const inProcess = inProcessTerminalSessionHost(input.ptyAdapter);
    const platform = yield* HostProcess.Platform;
    const env = yield* HostProcess.Environment;
    const userId = yield* HostProcess.UserId;
    if (
      platform === "win32" ||
      userId === undefined ||
      // An AppImage's files vanish when the app quits, taking a host launched from them along.
      env.APPIMAGE !== undefined ||
      env.T3CODE_TERMINAL_HOST === "0" ||
      // A test that forgets to opt out would leave a detached host behind.
      (env.VITEST !== undefined && input.enabled !== true)
    ) {
      return inProcess;
    }

    const path = yield* Path.Path;
    const argvEntry = (yield* HostProcess.Arguments)[1];
    const entryPath =
      argvEntry !== undefined && SERVER_ENTRY.test(argvEntry)
        ? argvEntry
        : import.meta.url.endsWith(".ts")
          ? NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url))
          : undefined;
    const stateDir = path.resolve(input.stateDir);
    const command = resolveTerminalHostCommand({
      isExecutable: yield* HostProcess.IsExecutable,
      execPath: yield* HostProcess.ExecutablePath,
      entryPath,
      fromSource: entryPath?.endsWith(".ts") === true,
      stateDir,
    });
    if (command === null) return inProcess;
    const address = resolveTerminalHostAddress({
      stateDir,
      platform,
      tempDir: NodeOS.tmpdir(),
      runtimeDir: env.XDG_RUNTIME_DIR,
      userId,
      joinPath: path.join,
    });
    const systemdRun = yield* findSystemdRun();
    const fileSystem = yield* FileSystem.FileSystem;
    const logPath = path.join(stateDir, "logs", "terminal-host.log");

    const outer = yield* Effect.scope;
    const connectionLock = yield* Semaphore.make(1);
    const held = new Map<string, ReattachablePty>();
    let current: { readonly client: TerminalHostClient; readonly scope: Scope.Closeable } | null =
      null;
    let shuttingDown = false;

    const release = (handle: ReattachablePty) => {
      if (held.get(handle.key) === handle) held.delete(handle.key);
    };
    const track = (key: string, handle: HostedPtyHandle, live: boolean) => {
      const tracked = new ReattachablePty(key, handle, release);
      if (live && tracked.live) {
        const previous = held.get(key);
        held.set(key, tracked);
        // The host replaced the previous session under this key; its handle saw a lost connection.
        previous?.giveUp();
      }
      return tracked;
    };

    const giveUpAll = Effect.sync(() => {
      for (const handle of held.values()) handle.giveUp();
    });

    // Sessions this server does not hold stay with the host for the next server to adopt.
    const reattach = (client: TerminalHostClient) =>
      client.adoptAll.pipe(
        Effect.map((adoptions) => {
          const rebound = new Set<string>();
          for (const adoption of adoptions) {
            const handle = held.get(adoption.key);
            if (handle === undefined) {
              if (adoption.exit === null) adoption.handle.detach();
              continue;
            }
            rebound.add(adoption.key);
            handle.rebind(adoption);
          }
          for (const [key, handle] of held) if (!rebound.has(key)) handle.giveUp();
        }),
      );

    const onConnectionLost = (client: TerminalHostClient): Effect.Effect<void> =>
      Effect.suspend(() => {
        const lost = current;
        if (shuttingDown || lost === null || lost.client !== client) return Effect.void;
        current = null;
        return Scope.close(lost.scope, Exit.void).pipe(
          Effect.andThen(
            connectionLock.withPermits(1)(
              Effect.suspend(() =>
                shuttingDown || current !== null
                  ? Effect.void
                  : connect().pipe(
                      Effect.flatMap(reattach),
                      Effect.catch((error) =>
                        Effect.logWarning("lost the terminal host; its terminals have ended", {
                          cause: error,
                        }).pipe(Effect.andThen(giveUpAll)),
                      ),
                    ),
              ),
            ),
          ),
        );
      });

    const connect = Effect.fn("TerminalSessionHost.connect")(function* () {
      const scope = yield* Scope.make();
      const client = yield* connectTerminalHost(address.socketPath).pipe(
        Scope.provide(scope),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      );
      current = { client, scope };
      yield* client.closed.pipe(Effect.andThen(onConnectionLost(client)), Effect.forkIn(outer));
      return client;
    });

    const ensureConnected = connectionLock.withPermits(1)(
      Effect.suspend(() => {
        if (current !== null) return Effect.succeed(current.client);
        return ensureTerminalHost({
          address,
          command: wrapForSystemdScope(command, {
            systemdRun,
            unitName: terminalHostUnitName(stateDir),
          }),
          ...(systemdRun === null ? {} : { fallback: command }),
          logPath,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          // The host derives its socket from its environment, so it must see the one used here.
          Effect.provideService(HostProcess.Environment, env),
          Effect.andThen(connect()),
          Effect.tap((client) => reattach(client)),
        );
      }),
    );

    const adopt = Effect.fn("TerminalSessionHost.adopt")(function* (adoption: HostSessionAdoption) {
      const key = decodeSessionKey(adoption.key);
      const launch = decodeLaunchRecord(adoption.launch);
      if (Option.isNone(key) || Option.isNone(launch)) {
        yield* Effect.logWarning("ending a hosted terminal whose launch record cannot be read", {
          key: adoption.key,
        });
        if (adoption.exit === null) adoption.handle.kill();
        return Option.none<AdoptedTerminalSession>();
      }
      const [threadId, terminalId] = key.value;
      return Option.some<AdoptedTerminalSession>({
        key: { threadId, terminalId },
        launch: launch.value,
        process: track(adoption.key, adoption.handle, adoption.exit === null),
        backlog: adoption.backlog,
        exit: adoption.exit,
      });
    });

    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        shuttingDown = true;
        const connection = current;
        current = null;
        return connection === null ? Effect.void : Scope.close(connection.scope, Exit.void);
      }),
    );

    // Only an already running host is joined here, so a server that never opens a terminal
    // never starts one.
    yield* connect().pipe(Effect.ignore);

    const host: TerminalSessionHostShape = {
      persistent: true,
      spawn: Effect.fn("TerminalSessionHost.spawn")(function* (key, launch, spawnInput) {
        const connected = yield* Effect.result(ensureConnected);
        if (connected._tag === "Failure") {
          yield* Effect.logWarning(
            "the terminal host is unavailable; opening an in-process terminal",
            {
              cause: connected.failure,
            },
          );
          return yield* inProcess.spawn(key, launch, spawnInput);
        }
        const encoded = encodeSessionKey(key);
        const handle = yield* connected.success.spawn({ key: encoded, launch, spawn: spawnInput });
        return track(encoded, handle, true);
      }),
      adoptAll: Effect.suspend(() =>
        current === null ? Effect.succeed([]) : current.client.adoptAll,
      ).pipe(
        Effect.flatMap((adoptions) => Effect.forEach(adoptions, adopt)),
        Effect.map((adopted) => adopted.flatMap((session) => Option.toArray(session))),
      ),
      restorableCommand: (key) =>
        readTerminalHostState(stateDir).pipe(
          Effect.map((entries) =>
            Option.fromNullishOr(
              entries.find((entry) => entry.key === encodeSessionKey(key))?.lastCommand,
            ),
          ),
        ),
      recordCommand: (key, command) =>
        Effect.suspend(() =>
          current === null
            ? Effect.void
            : current.client.recordCommand(encodeSessionKey(key), command),
        ),
    };
    return host;
  },
);
