import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type * as PtyAdapter from "@t3tools/shared/PtyAdapter";

export interface TerminalSessionKey {
  readonly threadId: string;
  readonly terminalId: string;
}

/** What a terminal was launched with; adopting it later compares a new open against this. */
export interface TerminalLaunchRecord {
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly shell: string;
  readonly runtimeEnv: Record<string, string> | null;
  readonly stopOnSettle: boolean;
  readonly cols: number;
  readonly rows: number;
}

export interface HostedPtyProcess extends PtyAdapter.PtyProcess {
  /** Lets go of the PTY without signalling it; a persistent host keeps the shell running. */
  detach(): void;
}

export interface AdoptedTerminalSession {
  readonly key: TerminalSessionKey;
  readonly launch: TerminalLaunchRecord;
  readonly process: HostedPtyProcess;
  /** Output the host buffered while no server was attached. */
  readonly backlog: string;
  readonly exit: PtyAdapter.PtyExitEvent | null;
}

export interface RestorableTerminalCommand {
  readonly line: string;
  readonly cwd: string;
}

export interface TerminalSessionHostShape {
  /** Whether sessions outlive the server, so shutdown detaches them instead of killing them. */
  readonly persistent: boolean;
  readonly spawn: (
    key: TerminalSessionKey,
    launch: TerminalLaunchRecord,
    input: PtyAdapter.PtySpawnInput,
  ) => Effect.Effect<HostedPtyProcess, PtyAdapter.PtySpawnError>;
  readonly adoptAll: Effect.Effect<ReadonlyArray<AdoptedTerminalSession>>;
  readonly restorableCommand: (
    key: TerminalSessionKey,
  ) => Effect.Effect<Option.Option<RestorableTerminalCommand>>;
  readonly recordCommand: (
    key: TerminalSessionKey,
    command: RestorableTerminalCommand | null,
  ) => Effect.Effect<void>;
}

const inProcessHostedPty = (process: PtyAdapter.PtyProcess): HostedPtyProcess => ({
  get pid() {
    return process.pid;
  },
  write: (data) => process.write(data),
  resize: (cols, rows) => process.resize(cols, rows),
  kill: (signal) => process.kill(signal),
  onData: (callback) => process.onData(callback),
  onExit: (callback) => process.onExit(callback),
  // Nothing outlives the server here, so letting go of a PTY ends it.
  detach: () => process.kill(),
});

export const inProcessTerminalSessionHost = (
  ptyAdapter: PtyAdapter.PtyAdapter["Service"],
): TerminalSessionHostShape => ({
  persistent: false,
  spawn: (_key, _launch, input) => ptyAdapter.spawn(input).pipe(Effect.map(inProcessHostedPty)),
  adoptAll: Effect.succeed([]),
  restorableCommand: () => Effect.succeedNone,
  recordCommand: () => Effect.void,
});
