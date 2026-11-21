// @effect-diagnostics nodeBuiltinImport:off -- The client speaks the host's line protocol over a Unix socket.
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import {
  TERMINAL_HOST_PROTOCOL_VERSION,
  TerminalHostUnavailableError,
  verifyTerminalHostDirectory,
} from "./paths.ts";
import {
  decodeTerminalHostEvent,
  encodeTerminalHostFrame,
  makeFrameSplitter,
  type TerminalHostEvent,
  type TerminalHostRequest,
} from "./protocol.ts";
import type { TerminalHostCommand } from "./stateFile.ts";

export { TerminalHostUnavailableError };

export interface HostedPtyHandle extends PtyAdapter.PtyProcess {
  /** Leaves the shell running in the host and stops this handle's events. */
  detach(): void;
}

export interface HostSessionAdoption {
  readonly key: string;
  readonly handle: HostedPtyHandle;
  readonly backlog: string;
  readonly launch: unknown;
  readonly exit: PtyAdapter.PtyExitEvent | null;
}

export interface TerminalHostClient {
  readonly hostPid: number;
  /** The sessions the host handed over when this client connected. Later calls return none. */
  readonly adoptAll: Effect.Effect<ReadonlyArray<HostSessionAdoption>>;
  readonly spawn: (input: {
    readonly key: string;
    readonly launch: unknown;
    readonly spawn: PtyAdapter.PtySpawnInput;
  }) => Effect.Effect<HostedPtyHandle, PtyAdapter.PtySpawnError>;
  readonly recordCommand: (key: string, command: TerminalHostCommand | null) => Effect.Effect<void>;
  /** Completes when the connection ends for any reason. */
  readonly closed: Effect.Effect<void>;
}

const CONNECTION_LOST_EXIT: PtyAdapter.PtyExitEvent = { exitCode: -1, signal: 1 };

class HostedSession implements HostedPtyHandle {
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  // Output that arrives before anyone subscribes is held for the first subscriber.
  private pendingData: string[] | null = [];
  private exitEvent: PtyAdapter.PtyExitEvent | null;
  private detached = false;
  readonly key: string;
  readonly pid: number;
  private readonly send: (frame: TerminalHostRequest) => void;
  private readonly onDetach: (session: HostedSession) => void;

  constructor(input: {
    readonly key: string;
    readonly pid: number;
    readonly exit: PtyAdapter.PtyExitEvent | null;
    readonly send: (frame: TerminalHostRequest) => void;
    readonly onDetach: (session: HostedSession) => void;
  }) {
    this.key = input.key;
    this.pid = input.pid;
    this.exitEvent = input.exit;
    this.send = input.send;
    this.onDetach = input.onDetach;
  }

  get active(): boolean {
    return !this.detached && this.exitEvent === null;
  }

  write(data: string | Buffer): void {
    if (!this.active) return;
    this.send(
      typeof data === "string"
        ? { type: "write", key: this.key, data }
        : { type: "write", key: this.key, data: data.toString("latin1"), binary: true },
    );
  }

  resize(cols: number, rows: number): void {
    if (this.active) this.send({ type: "resize", key: this.key, cols, rows });
  }

  kill(signal?: string): void {
    if (!this.active) return;
    this.send(
      signal === undefined
        ? { type: "kill", key: this.key }
        : { type: "kill", key: this.key, signal },
    );
  }

  detach(): void {
    if (this.detached) return;
    this.detached = true;
    if (this.exitEvent === null) this.send({ type: "detach", key: this.key });
    this.pendingData = null;
    this.dataListeners.clear();
    this.exitListeners.clear();
    this.onDetach(this);
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

  emitData(data: string): void {
    if (this.detached) return;
    if (this.pendingData !== null) {
      this.pendingData.push(data);
      return;
    }
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(event: PtyAdapter.PtyExitEvent): void {
    if (this.exitEvent !== null) return;
    this.exitEvent = event;
    for (const listener of this.exitListeners) listener(event);
    this.exitListeners.clear();
  }
}

const connectSocket = (socketPath: string) =>
  Effect.callback<NodeNet.Socket, TerminalHostUnavailableError>((resume) => {
    const socket = NodeNet.createConnection(socketPath);
    const onConnect = () => {
      socket.off("error", onError);
      resume(Effect.succeed(socket));
    };
    const onError = (cause: Error) => {
      socket.off("connect", onConnect);
      socket.destroy();
      resume(
        Effect.fail(
          new TerminalHostUnavailableError({ reason: `cannot connect to ${socketPath}`, cause }),
        ),
      );
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
    return Effect.sync(() => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.destroy();
    });
  });

/** Takes ownership of every session in the host at `socketPath`. Closing the scope detaches them all. */
export const connectTerminalHost = Effect.fn("TerminalHost.connect")(function* (
  socketPath: string,
) {
  yield* verifyTerminalHostDirectory(NodePath.dirname(socketPath));
  const socket = yield* Effect.acquireRelease(connectSocket(socketPath), (socket) =>
    Effect.sync(() => socket.destroy()),
  );

  const handles = new Map<string, HostedSession>();
  const pendingSpawns = new Map<
    number,
    {
      readonly deferred: Deferred.Deferred<HostedSession, PtyAdapter.PtySpawnError>;
      readonly shell: string;
    }
  >();
  const closed = Deferred.makeUnsafe<void>();
  const handshake = Deferred.makeUnsafe<
    { readonly hostPid: number; readonly adoptions: HostSessionAdoption[] },
    TerminalHostUnavailableError
  >();
  let welcome: { readonly hostPid: number; readonly sessions: number } | null = null;
  const adoptions: HostSessionAdoption[] = [];
  let isClosed = false;
  let nextSpawnId = 1;

  const send = (frame: TerminalHostRequest) => {
    if (!isClosed && !socket.destroyed) socket.write(encodeTerminalHostFrame(frame));
  };
  const forget = (session: HostedSession) => {
    if (handles.get(session.key) === session) handles.delete(session.key);
  };
  const makeSession = (key: string, pid: number, exit: PtyAdapter.PtyExitEvent | null) =>
    new HostedSession({ key, pid, exit, send, onDetach: forget });
  const supersede = (key: string) => {
    const previous = handles.get(key);
    if (previous === undefined) return;
    handles.delete(key);
    previous.emitExit(CONNECTION_LOST_EXIT);
  };
  const finishHandshake = () => {
    if (welcome !== null && adoptions.length === welcome.sessions) {
      Deferred.doneUnsafe(
        handshake,
        Effect.succeed({ hostPid: welcome.hostPid, adoptions: [...adoptions] }),
      );
    }
  };
  const protocolError = (reason: string) => {
    Deferred.doneUnsafe(handshake, Effect.fail(new TerminalHostUnavailableError({ reason })));
    socket.destroy();
  };

  const handleEvent = (event: TerminalHostEvent) => {
    switch (event.type) {
      case "welcome":
        if (welcome !== null) {
          protocolError("the host sent a second welcome");
          return;
        }
        if (event.protocol !== TERMINAL_HOST_PROTOCOL_VERSION) {
          protocolError(`the host speaks protocol ${event.protocol}`);
          return;
        }
        welcome = { hostPid: event.hostPid, sessions: event.sessions };
        finishHandshake();
        return;
      case "session": {
        const handle = makeSession(event.key, event.pid, event.exit);
        if (event.exit === null) handles.set(event.key, handle);
        adoptions.push({
          key: event.key,
          handle,
          backlog: event.backlog,
          launch: event.launch,
          exit: event.exit,
        });
        finishHandshake();
        return;
      }
      case "spawned": {
        supersede(event.key);
        const pending = pendingSpawns.get(event.id);
        pendingSpawns.delete(event.id);
        if (pending === undefined) {
          send({ type: "kill", key: event.key });
          return;
        }
        const handle = makeSession(event.key, event.pid, null);
        handles.set(event.key, handle);
        Deferred.doneUnsafe(pending.deferred, Effect.succeed(handle));
        return;
      }
      case "spawn-failed": {
        const pending = pendingSpawns.get(event.id);
        pendingSpawns.delete(event.id);
        if (pending === undefined) return;
        Deferred.doneUnsafe(
          pending.deferred,
          Effect.fail(
            new PtyAdapter.PtySpawnError({
              adapter: "terminal-host",
              shell: pending.shell,
              cause: new Error(event.message),
            }),
          ),
        );
        return;
      }
      case "data":
        handles.get(event.key)?.emitData(event.data);
        return;
      case "exit": {
        const handle = handles.get(event.key);
        handles.delete(event.key);
        handle?.emitExit({ exitCode: event.exitCode, signal: event.signal });
        return;
      }
    }
  };

  socket.setEncoding("utf8");
  const split = makeFrameSplitter();
  socket.on("data", (chunk: string) => {
    const lines = split(chunk);
    if (lines === null) {
      protocolError("the host sent an oversized frame");
      return;
    }
    for (const line of lines) {
      if (socket.destroyed) return;
      const event = decodeTerminalHostEvent(line);
      if (event === null) {
        protocolError("the host sent a malformed frame");
        return;
      }
      handleEvent(event);
    }
  });
  socket.on("error", () => socket.destroy());
  socket.on("close", () => {
    isClosed = true;
    Deferred.doneUnsafe(
      handshake,
      Effect.fail(new TerminalHostUnavailableError({ reason: "the host closed the connection" })),
    );
    const live = [...handles.values()];
    handles.clear();
    for (const handle of live) handle.emitExit(CONNECTION_LOST_EXIT);
    for (const [id, pending] of pendingSpawns) {
      pendingSpawns.delete(id);
      Deferred.doneUnsafe(
        pending.deferred,
        Effect.fail(
          new PtyAdapter.PtySpawnError({
            adapter: "terminal-host",
            shell: pending.shell,
            cause: new Error("The terminal host connection closed."),
          }),
        ),
      );
    }
    Deferred.doneUnsafe(closed, Effect.void);
  });

  send({ type: "hello", protocol: TERMINAL_HOST_PROTOCOL_VERSION });
  const accepted = yield* Deferred.await(handshake);
  let unclaimed: ReadonlyArray<HostSessionAdoption> = accepted.adoptions;

  const client: TerminalHostClient = {
    hostPid: accepted.hostPid,
    adoptAll: Effect.sync(() => {
      const taken = unclaimed;
      unclaimed = [];
      return taken;
    }),
    spawn: Effect.fn("TerminalHost.spawn")(function* (input) {
      if (isClosed) {
        return yield* new PtyAdapter.PtySpawnError({
          adapter: "terminal-host",
          shell: input.spawn.shell,
          cause: new Error("The terminal host connection closed."),
        });
      }
      const id = nextSpawnId++;
      const deferred = Deferred.makeUnsafe<HostedSession, PtyAdapter.PtySpawnError>();
      pendingSpawns.set(id, { deferred, shell: input.spawn.shell });
      const env: Record<string, string> = {};
      for (const [name, value] of Object.entries(input.spawn.env)) {
        if (value !== undefined) env[name] = value;
      }
      send({
        type: "spawn",
        id,
        key: input.key,
        launch: input.launch,
        spawn: {
          shell: input.spawn.shell,
          ...(input.spawn.args === undefined ? {} : { args: input.spawn.args }),
          cwd: input.spawn.cwd,
          cols: input.spawn.cols,
          rows: input.spawn.rows,
          env,
        },
      });
      return yield* Deferred.await(deferred).pipe(
        Effect.onInterrupt(() => Effect.sync(() => pendingSpawns.delete(id))),
      );
    }),
    recordCommand: (key, command) =>
      Effect.sync(() => send({ type: "record-command", key, command })),
    closed: Deferred.await(closed),
  };
  return client;
});
