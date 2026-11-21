// @effect-diagnostics nodeBuiltinImport:off -- The host serves a Unix socket and claims its path with link, rename and lstat.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  prepareTerminalHostDirectory,
  TERMINAL_HOST_PROTOCOL_VERSION,
  TerminalHostUnavailableError,
  type TerminalHostAddress,
} from "./paths.ts";
import {
  decodeTerminalHostRequest,
  encodeTerminalHostFrame,
  makeFrameSplitter,
  type TerminalHostEvent,
  type TerminalHostRequest,
} from "./protocol.ts";
import { openTerminalHostStateStore } from "./stateFile.ts";

const MAX_BACKLOG_BYTES = 2 * 1024 * 1024;
const MAX_OWNER_QUEUED_BYTES = 16 * 1024 * 1024;
export const DEFAULT_IDLE_EXIT_MS = 30_000;

interface HostSession {
  readonly key: string;
  readonly process: PtyAdapter.PtyProcess;
  readonly launch: unknown;
  attached: boolean;
  backlog: string[];
  backlogBytes: number;
  exit: PtyAdapter.PtyExitEvent | null;
  unsubscribe: () => void;
}

interface TerminalHostOptions {
  readonly stateDir: string;
  readonly address: TerminalHostAddress;
  readonly idleExitMs: number;
}

type TerminalHostStopReason = "idle" | "shutdown";

type TerminalHostStart =
  | { readonly _tag: "AlreadyRunning" }
  | {
      readonly _tag: "Serving";
      readonly stopped: Effect.Effect<TerminalHostStopReason>;
      /** Hangs up every shell while keeping their state entries restorable, then stops. */
      readonly shutdown: Effect.Effect<void>;
      readonly flushState: Effect.Effect<void>;
    };

const answers = (socketPath: string) =>
  new Promise<boolean>((resolve) => {
    const socket = NodeNet.createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });

const listen = (path: string, onConnection: (socket: NodeNet.Socket) => void) =>
  new Promise<NodeNet.Server>((resolve, reject) => {
    const server = NodeNet.createServer(onConnection);
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });

const closeServer = (server: NodeNet.Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

const inodeAt = (path: string) =>
  NodeFSP.lstat(path).then(
    (stat) => stat.ino,
    () => null,
  );

// Closing a server unlinks the path it was bound to, even after another host replaced that
// path, so bind a private staging path and link it into place.
async function claimSocket(
  address: TerminalHostAddress,
  onConnection: (socket: NodeNet.Socket) => void,
): Promise<{ readonly server: NodeNet.Server; readonly inode: number } | null> {
  if (await answers(address.socketPath)) return null;
  const staging = NodePath.join(
    address.directory,
    `${NodeCrypto.randomBytes(6).toString("hex")}.tmp`,
  );
  const server = await listen(staging, onConnection);
  try {
    await NodeFSP.chmod(staging, 0o600);
    const { ino } = await NodeFSP.lstat(staging);
    try {
      await NodeFSP.link(staging, address.socketPath);
      await NodeFSP.unlink(staging);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (await answers(address.socketPath)) {
        await closeServer(server);
        return null;
      }
      await NodeFSP.rename(staging, address.socketPath);
    }
    return { server, inode: ino };
  } catch (error) {
    await closeServer(server);
    throw error;
  }
}

/** Serves PTY sessions over `address` until it idles out or `shutdown` runs; closing the scope releases the socket. */
export const startTerminalHost = Effect.fn("TerminalHost.start")(function* (
  options: TerminalHostOptions,
) {
  const pty = yield* PtyAdapter.PtyAdapter;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const log = (message: string, cause?: unknown) => {
    runFork(cause === undefined ? Effect.logInfo(message) : Effect.logWarning(message, { cause }));
  };

  yield* prepareTerminalHostDirectory(options.address.directory);

  // The state store must not open until this host owns the socket: a losing host would
  // otherwise rewrite the winner's state file. Connections wait until it is open.
  const waiting: NodeNet.Socket[] = [];
  let accept = (socket: NodeNet.Socket) => {
    waiting.push(socket);
  };
  const claimed = yield* Effect.tryPromise({
    try: () => claimSocket(options.address, (socket) => accept(socket)),
    catch: (cause) =>
      new TerminalHostUnavailableError({
        reason: `cannot listen on ${options.address.socketPath}`,
        cause,
      }),
  });
  if (claimed === null) {
    const alreadyRunning: TerminalHostStart = { _tag: "AlreadyRunning" };
    return alreadyRunning;
  }
  const { server, inode } = claimed;
  server.on("error", (cause) => log("terminal host socket error", cause));

  const store = yield* openTerminalHostStateStore(options.stateDir);
  const stopped = yield* Deferred.make<TerminalHostStopReason>();
  const sessions = new Map<string, HostSession>();
  const sockets = new Set<NodeNet.Socket>();
  let owner: NodeNet.Socket | null = null;
  let ownerQueueAllowance = 0;
  let shuttingDown = false;
  let idleTimer: Fiber.Fiber<void> | null = null;
  let idleGeneration = 0;

  const isIdle = () => {
    if (shuttingDown || sockets.size > 0) return false;
    for (const session of sessions.values()) if (session.exit === null) return false;
    return true;
  };
  const refreshIdle = () => {
    const idle = isIdle();
    if (idle && idleTimer === null) {
      const generation = ++idleGeneration;
      idleTimer = runFork(
        Effect.sleep(Duration.millis(options.idleExitMs)).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              generation === idleGeneration && isIdle()
                ? Deferred.succeed(stopped, "idle")
                : Effect.void,
            ),
          ),
          Effect.asVoid,
        ),
      );
    } else if (!idle && idleTimer !== null) {
      const timer = idleTimer;
      idleTimer = null;
      idleGeneration++;
      runFork(Fiber.interrupt(timer));
    }
  };

  const releaseOwner = (socket: NodeNet.Socket) => {
    if (owner !== socket) return;
    owner = null;
    for (const session of sessions.values()) session.attached = false;
    log("owner disconnected; sessions detached");
  };
  const dropConnection = (socket: NodeNet.Socket) => {
    releaseOwner(socket);
    socket.destroy();
  };
  const send = (socket: NodeNet.Socket, event: TerminalHostEvent) => {
    if (socket.destroyed) return;
    socket.write(encodeTerminalHostFrame(event));
    if (socket === owner && socket.writableLength > ownerQueueAllowance) {
      log("dropping the owner connection because it stopped reading output");
      dropConnection(socket);
    }
  };
  const tryKill = (target: PtyAdapter.PtyProcess, signal?: string) => {
    try {
      target.kill(signal);
    } catch (cause) {
      log("failed to signal a terminal session", cause);
    }
  };

  const appendBacklog = (session: HostSession, data: string) => {
    session.backlog.push(data);
    session.backlogBytes += Buffer.byteLength(data);
    while (session.backlogBytes > MAX_BACKLOG_BYTES && session.backlog.length > 1) {
      session.backlogBytes -= Buffer.byteLength(session.backlog.shift() ?? "");
    }
  };
  const onSessionData = (session: HostSession, data: string) => {
    if (sessions.get(session.key) !== session) return;
    if (session.attached && owner !== null) {
      send(owner, { type: "data", key: session.key, data });
    } else {
      appendBacklog(session, data);
    }
  };
  const onSessionExit = (session: HostSession, exit: PtyAdapter.PtyExitEvent) => {
    if (sessions.get(session.key) !== session) return;
    if (!shuttingDown) store.remove(session.key);
    if (session.attached && owner !== null) {
      sessions.delete(session.key);
      send(owner, { type: "exit", key: session.key, ...exit });
    } else {
      session.exit = exit;
    }
    refreshIdle();
  };
  // SIGHUP is what closing a terminal window sends: the shell hangs up its jobs and exits.
  const retire = (session: HostSession) => {
    sessions.delete(session.key);
    session.unsubscribe();
    if (session.exit === null) tryKill(session.process, "SIGHUP");
  };

  const welcome = (socket: NodeNet.Socket, protocol: number) => {
    if (protocol !== TERMINAL_HOST_PROTOCOL_VERSION) {
      socket.end(
        encodeTerminalHostFrame({
          type: "welcome",
          protocol: TERMINAL_HOST_PROTOCOL_VERSION,
          hostPid: process.pid,
          sessions: 0,
        }),
      );
      return;
    }
    if (owner !== null && owner !== socket) dropConnection(owner);
    socket.write(
      encodeTerminalHostFrame({
        type: "welcome",
        protocol: TERMINAL_HOST_PROTOCOL_VERSION,
        hostPid: process.pid,
        sessions: sessions.size,
      }),
    );
    for (const session of sessions.values()) {
      socket.write(
        encodeTerminalHostFrame({
          type: "session",
          key: session.key,
          pid: session.process.pid,
          launch: session.launch,
          backlog: session.backlog.join(""),
          exit: session.exit,
        }),
      );
      session.backlog = [];
      session.backlogBytes = 0;
      session.attached = true;
      if (session.exit !== null) sessions.delete(session.key);
    }
    // The handover itself may queue several backlogs; only output queued after it counts.
    ownerQueueAllowance = socket.writableLength + MAX_OWNER_QUEUED_BYTES;
    owner = socket;
  };

  const startSession = (
    socket: NodeNet.Socket,
    request: Extract<TerminalHostRequest, { type: "spawn" }>,
    child: PtyAdapter.PtyProcess,
  ) => {
    if (shuttingDown || owner !== socket) {
      tryKill(child, "SIGHUP");
      send(socket, {
        type: "spawn-failed",
        id: request.id,
        message: "The connection no longer owns this terminal host.",
      });
      return;
    }
    const previous = sessions.get(request.key);
    if (previous !== undefined) retire(previous);
    const session: HostSession = {
      key: request.key,
      process: child,
      launch: request.launch,
      attached: true,
      backlog: [],
      backlogBytes: 0,
      exit: null,
      unsubscribe: () => {},
    };
    sessions.set(session.key, session);
    store.replace(session.key, request.spawn.cwd);
    send(socket, { type: "spawned", id: request.id, key: session.key, pid: child.pid });
    const stopData = child.onData((data) => onSessionData(session, data));
    const stopExit = child.onExit((exit) => onSessionExit(session, exit));
    session.unsubscribe = () => {
      stopData();
      stopExit();
    };
    refreshIdle();
  };

  const spawnSession = (
    socket: NodeNet.Socket,
    request: Extract<TerminalHostRequest, { type: "spawn" }>,
  ) => {
    const { spawn } = request;
    runFork(
      pty
        .spawn({
          shell: spawn.shell,
          ...(spawn.args === undefined ? {} : { args: [...spawn.args] }),
          cwd: spawn.cwd,
          cols: spawn.cols,
          rows: spawn.rows,
          env: { ...spawn.env },
        })
        .pipe(
          Effect.matchCause({
            onFailure: (cause) => {
              const error = Cause.squash(cause);
              send(socket, {
                type: "spawn-failed",
                id: request.id,
                message: error instanceof Error ? error.message : String(error),
              });
            },
            onSuccess: (child) => startSession(socket, request, child),
          }),
        ),
    );
  };

  const liveSession = (key: string) => {
    const session = sessions.get(key);
    return session !== undefined && session.exit === null ? session : undefined;
  };

  const handleRequest = (socket: NodeNet.Socket, request: TerminalHostRequest) => {
    if (request.type === "hello") {
      welcome(socket, request.protocol);
      return;
    }
    if (socket !== owner) return;
    switch (request.type) {
      case "spawn":
        spawnSession(socket, request);
        return;
      case "write": {
        const session = liveSession(request.key);
        if (session === undefined) return;
        try {
          session.process.write(PtyAdapter.ptyInput(request.data, request.binary));
        } catch (cause) {
          log("failed to write to a terminal session", cause);
        }
        return;
      }
      case "resize": {
        const session = liveSession(request.key);
        if (session === undefined) return;
        try {
          session.process.resize(request.cols, request.rows);
        } catch (cause) {
          log("failed to resize a terminal session", cause);
        }
        return;
      }
      case "kill": {
        const session = liveSession(request.key);
        if (session !== undefined) tryKill(session.process, request.signal);
        return;
      }
      case "detach": {
        const session = sessions.get(request.key);
        if (session !== undefined) session.attached = false;
        return;
      }
      case "record-command":
        if (liveSession(request.key) !== undefined) {
          store.recordCommand(request.key, request.command);
        }
        return;
    }
  };

  const onConnection = (socket: NodeNet.Socket) => {
    if (shuttingDown) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    refreshIdle();
    socket.setEncoding("utf8");
    const split = makeFrameSplitter();
    socket.on("data", (chunk: string) => {
      const lines = split(chunk);
      if (lines === null) {
        log("dropping a connection that sent an oversized frame");
        dropConnection(socket);
        return;
      }
      for (const line of lines) {
        if (socket.destroyed) return;
        const request = decodeTerminalHostRequest(line);
        if (request === null) {
          log("dropping a connection that sent a malformed frame");
          dropConnection(socket);
          return;
        }
        handleRequest(socket, request);
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      sockets.delete(socket);
      releaseOwner(socket);
      refreshIdle();
    });
  };

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      shuttingDown = true;
      if (idleTimer !== null) yield* Fiber.interrupt(idleTimer);
      idleTimer = null;
      for (const socket of sockets) socket.destroy();
      yield* Effect.promise(() => closeServer(server));
      yield* Effect.promise(async () => {
        if ((await inodeAt(options.address.socketPath)) === inode) {
          await NodeFSP.rm(options.address.socketPath, { force: true });
        }
      });
      yield* store.flush;
    }),
  );

  accept = onConnection;
  for (const socket of waiting.splice(0)) onConnection(socket);
  refreshIdle();

  const shutdown = Effect.suspend(() => {
    if (!shuttingDown) {
      shuttingDown = true;
      refreshIdle();
      for (const session of sessions.values()) {
        if (session.exit === null) tryKill(session.process, "SIGHUP");
      }
    }
    return store.flush.pipe(Effect.andThen(Deferred.succeed(stopped, "shutdown")), Effect.asVoid);
  });

  const serving: TerminalHostStart = {
    _tag: "Serving",
    stopped: Deferred.await(stopped),
    shutdown,
    flushState: store.flush,
  };
  return serving;
});
