// @effect-diagnostics nodeBuiltinImport:off -- Socket directory ownership checks need lstat, which Effect's FileSystem does not expose.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const TERMINAL_HOST_PROTOCOL_VERSION = 1 as const;

export class TerminalHostUnavailableError extends Schema.TaggedError<TerminalHostUnavailableError>()(
  "TerminalHostUnavailableError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `The terminal host is unavailable: ${this.reason}`;
  }
}

export interface TerminalHostAddress {
  readonly socketPath: string;
  readonly directory: string;
}

/** One host per Unix user and state directory; the protocol version is part of the socket name. */
export function resolveTerminalHostAddress(input: {
  readonly stateDir: string;
  readonly platform: NodeJS.Platform;
  readonly tempDir: string;
  readonly runtimeDir: string | undefined;
  readonly userId: number;
  readonly joinPath: (...segments: readonly string[]) => string;
}): TerminalHostAddress {
  const stateHash = NodeCrypto.createHash("sha256")
    .update(input.stateDir)
    .digest("hex")
    .slice(0, 24);
  const socketName = `${stateHash}-v${TERMINAL_HOST_PROTOCOL_VERSION}.sock`;
  const directoryName = `rucode-th-${input.userId}`;
  const base =
    input.platform === "linux" && input.runtimeDir !== undefined && input.runtimeDir !== ""
      ? input.runtimeDir
      : input.tempDir;
  // sockaddr_un.sun_path holds 108 bytes on Linux and 104 on macOS, including the terminator.
  const maxPathBytes = input.platform === "linux" ? 107 : 103;
  let directory = input.joinPath(base, directoryName);
  if (Buffer.byteLength(input.joinPath(directory, socketName)) > maxPathBytes) {
    directory = input.joinPath("/tmp", directoryName);
  }
  return { socketPath: input.joinPath(directory, socketName), directory };
}

const directoryProblem = (directory: string, userId: number | undefined) =>
  Effect.tryPromise({
    try: () => NodeFSP.lstat(directory),
    catch: (cause) =>
      new TerminalHostUnavailableError({ reason: `cannot inspect ${directory}`, cause }),
  }).pipe(
    Effect.map((stat) => {
      if (stat.isSymbolicLink() || !stat.isDirectory()) return "is not a directory";
      if (userId === undefined || stat.uid !== userId) return "is owned by another user";
      if ((stat.mode & 0o077) !== 0) return "grants group or other access";
      return null;
    }),
  );

/** Fails unless `directory` is a real directory owned by this user with no group or other access. */
export const verifyTerminalHostDirectory = Effect.fn("TerminalHost.verifyDirectory")(function* (
  directory: string,
) {
  const problem = yield* directoryProblem(directory, yield* HostProcess.UserId);
  if (problem !== null) {
    return yield* new TerminalHostUnavailableError({ reason: `${directory} ${problem}` });
  }
});

/**
 * Creates the socket directory owner-only. An existing directory that grants group or other
 * access is refused rather than tightened: someone else may already have placed a socket in it.
 */
export const prepareTerminalHostDirectory = Effect.fn("TerminalHost.prepareDirectory")(function* (
  directory: string,
) {
  yield* Effect.tryPromise({
    try: () => NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 }),
    catch: (cause) =>
      new TerminalHostUnavailableError({ reason: `cannot create ${directory}`, cause }),
  });
  yield* verifyTerminalHostDirectory(directory);
  yield* Effect.tryPromise({
    try: () => NodeFSP.chmod(directory, 0o700),
    catch: (cause) =>
      new TerminalHostUnavailableError({ reason: `cannot restrict ${directory}`, cause }),
  });
});
