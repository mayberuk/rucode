// @effect-diagnostics nodeBuiltinImport:off -- Reads must work without platform services, and writes need an owner-only temp file renamed into place.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const TerminalHostCommand = Schema.Struct({
  line: Schema.String,
  cwd: Schema.String,
});
export type TerminalHostCommand = typeof TerminalHostCommand.Type;

const TerminalHostStateEntry = Schema.Struct({
  key: Schema.String,
  cwd: Schema.String,
  lastCommand: Schema.NullOr(TerminalHostCommand),
  updatedAt: Schema.String,
});
export type TerminalHostStateEntry = typeof TerminalHostStateEntry.Type;

const StateDocumentJson = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    sessions: Schema.Array(TerminalHostStateEntry),
  }),
);
const decodeStateDocument = Schema.decodeUnknownOption(StateDocumentJson);
const encodeStateDocument = Schema.encodeSync(StateDocumentJson);

class TerminalHostStateFileError extends Schema.TaggedError<TerminalHostStateFileError>()(
  "TerminalHostStateFileError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not access the terminal host state file ${this.path}.`;
  }
}

const RESTORABLE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const terminalHostStatePath = (stateDir: string): string =>
  NodePath.join(stateDir, "terminal-host.json");

/** A missing or unreadable file reads as no entries. */
export const readTerminalHostState = (
  stateDir: string,
): Effect.Effect<ReadonlyArray<TerminalHostStateEntry>> =>
  Effect.tryPromise({
    try: () => NodeFSP.readFile(terminalHostStatePath(stateDir), "utf8"),
    catch: (cause) =>
      new TerminalHostStateFileError({ path: terminalHostStatePath(stateDir), cause }),
  }).pipe(
    Effect.map((text) =>
      Option.match(decodeStateDocument(text), {
        onNone: () => [],
        onSome: (document) => document.sessions,
      }),
    ),
    Effect.orElseSucceed(() => []),
  );

const writeStateFile = Effect.fn("TerminalHost.writeStateFile")(function* (
  stateDir: string,
  sessions: ReadonlyArray<TerminalHostStateEntry>,
) {
  const target = terminalHostStatePath(stateDir);
  const staging = `${target}.${NodeCrypto.randomBytes(6).toString("hex")}.tmp`;
  const contents = `${encodeStateDocument({ version: 1, sessions })}\n`;
  yield* Effect.tryPromise({
    try: async () => {
      try {
        await NodeFSP.writeFile(staging, contents, { mode: 0o600 });
        await NodeFSP.rename(staging, target);
      } catch (error) {
        await NodeFSP.rm(staging, { force: true });
        throw error;
      }
    },
    catch: (cause) => new TerminalHostStateFileError({ path: target, cause }),
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to write the terminal host state file", { cause: error }),
    ),
  );
});

/** The host's view of `terminal-host.json`. Updates are synchronous; writes coalesce behind them. */
interface TerminalHostStateStore {
  readonly entries: () => ReadonlyArray<TerminalHostStateEntry>;
  readonly replace: (key: string, cwd: string) => void;
  readonly recordCommand: (key: string, command: TerminalHostCommand | null) => void;
  readonly remove: (key: string) => void;
  /** Completes once every update made so far is on disk. */
  readonly flush: Effect.Effect<void>;
}

export const openTerminalHostStateStore = Effect.fn("TerminalHost.openStateStore")(function* (
  stateDir: string,
) {
  const clock = yield* Clock.Clock;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const startedAt = clock.currentTimeMillisUnsafe();
  const previous = yield* readTerminalHostState(stateDir);
  // An unparseable timestamp fails the comparison and is pruned with the expired entries.
  const kept = previous.filter(
    (entry) => Date.parse(entry.updatedAt) >= startedAt - RESTORABLE_MAX_AGE_MS,
  );
  const entries = new Map(kept.map((entry) => [entry.key, entry]));
  const nowIso = () => DateTime.formatIso(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe()));

  let dirty = false;
  let writer: Fiber.Fiber<void> | null = null;
  const writeLoop: Effect.Effect<void> = Effect.gen(function* () {
    // Yielding first lets a synchronous burst of updates land in a single write.
    yield* Effect.yieldNow;
    while (dirty) {
      dirty = false;
      yield* writeStateFile(stateDir, [...entries.values()]);
    }
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        writer = null;
        if (dirty) markDirty();
      }),
    ),
  );
  const markDirty = () => {
    dirty = true;
    if (writer === null) writer = runFork(writeLoop);
  };

  if (kept.length !== previous.length) markDirty();

  const store: TerminalHostStateStore = {
    entries: () => [...entries.values()],
    replace: (key, cwd) => {
      entries.delete(key);
      entries.set(key, { key, cwd, lastCommand: null, updatedAt: nowIso() });
      markDirty();
    },
    recordCommand: (key, command) => {
      const entry = entries.get(key);
      if (entry === undefined) return;
      entries.set(key, { ...entry, lastCommand: command, updatedAt: nowIso() });
      markDirty();
    },
    remove: (key) => {
      if (entries.delete(key)) markDirty();
    },
    flush: Effect.suspend(function loop(): Effect.Effect<void> {
      const pending = writer;
      return pending === null ? Effect.void : Fiber.join(pending).pipe(Effect.andThen(loop));
    }),
  };
  return store;
});
