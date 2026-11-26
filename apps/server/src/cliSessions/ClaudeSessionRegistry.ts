import { ClaudeSettings, defaultInstanceIdForDriver, ProviderDriverKind } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ProcessRunner from "../processRunner.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  isLive,
  type LivenessProbe,
  ownerOf,
  paneOf,
  parseRegistryEntry,
  procStatStartTime,
  type RegistryEntry,
  type RegistryOwner,
  type RegistryPane,
  tmuxSocketFromEnviron,
} from "./registryEntry.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
// Claude leaves its file behind when killed or hung up on, so no file event reports the death;
// this bounds how long such a dead holder keeps its chat blocked.
const HOLDER_LIVENESS_INTERVAL = "15 seconds";

export interface Attachment {
  readonly sessionId: string;
  readonly pid: number;
  readonly owner: RegistryOwner;
  readonly status: RegistryEntry["status"];
  readonly name: string | null;
  readonly cwd: string | null;
  readonly tmux: string | null;
  readonly pane: RegistryPane | null;
  readonly startedAt: number | null;
}

export class ClaudeSessionRegistry extends Context.Service<
  ClaudeSessionRegistry,
  {
    /** Live sessions held by a process other than this server, keyed by session id. */
    readonly attachments: SubscriptionRef.SubscriptionRef<ReadonlyMap<string, Attachment>>;
    /** A fresh read of the live entry for a session, this server's own included. */
    readonly entry: (sessionId: string) => Effect.Effect<Attachment | null>;
    /** True once the session leaves `attachments`; false when the timeout passes first. */
    readonly awaitGone: (sessionId: string, timeout: Duration.Input) => Effect.Effect<boolean>;
    /** The tmux server socket from the process's `TMUX` variable; null off Linux. */
    readonly socketOf: (pid: number) => Effect.Effect<string | null>;
  }
>()("t3/cliSessions/ClaudeSessionRegistry") {}

const toAttachment = (entry: RegistryEntry): Attachment => ({
  sessionId: entry.sessionId,
  pid: entry.pid,
  owner: ownerOf(entry),
  status: entry.status,
  name: entry.name,
  cwd: entry.cwd,
  tmux: entry.tmux,
  pane: paneOf(entry),
  startedAt: entry.startedAt,
});

// Two processes can hold one session; an outside holder matters more than this server's own.
const preferred = (left: Attachment, right: Attachment) => {
  if ((left.owner === "rucode") !== (right.owner === "rucode")) {
    return left.owner === "rucode" ? right : left;
  }
  return (right.startedAt ?? -1) > (left.startedAt ?? -1) ? right : left;
};

const bySession = (attachments: ReadonlyArray<Attachment>) => {
  const sessions = new Map<string, Attachment>();
  for (const attachment of attachments) {
    const current = sessions.get(attachment.sessionId);
    sessions.set(
      attachment.sessionId,
      current === undefined ? attachment : preferred(current, attachment),
    );
  }
  return sessions;
};

const sameAttachments = (
  left: ReadonlyMap<string, Attachment>,
  right: ReadonlyMap<string, Attachment>,
) =>
  left.size === right.size &&
  [...left].every(
    ([sessionId, attachment]) =>
      JSON.stringify(attachment) === JSON.stringify(right.get(sessionId) ?? null),
  );

export const make = Effect.fn("ClaudeSessionRegistry.make")(function* (options?: {
  readonly procRoot?: string;
  readonly machineIdPath?: string;
}) {
  const procRoot = options?.procRoot ?? "/proc";
  const machineIdPath = options?.machineIdPath ?? "/etc/machine-id";
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* ServerSettings.ServerSettingsService;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcess.Platform;
  const hostEnvironment = yield* HostProcess.Environment;

  const claudeHome = yield* Effect.gen(function* () {
    const current = yield* settings.getSettings.pipe(Effect.option);
    const instance = Option.isSome(current)
      ? current.value.providerInstances[defaultInstanceIdForDriver(CLAUDE_DRIVER)]
      : undefined;
    const config =
      instance === undefined || instance.driver === CLAUDE_DRIVER
        ? Option.getOrUndefined(decodeClaudeSettings(instance?.config ?? {}))
        : undefined;
    const configured = instance?.environment?.findLast(
      (variable) => variable.name === "CLAUDE_CONFIG_DIR",
    )?.value;
    const configDir =
      typeof configured === "string" ? configured : hostEnvironment.CLAUDE_CONFIG_DIR;
    return yield* resolveClaudeHomePath(
      { homePath: config?.homePath ?? "" },
      configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: configDir },
    );
  });
  const sessionsDir = path.join(claudeHome, "sessions");

  // Claude 2.1.330 writes `linux:<machine-id>:<pid namespace link>` on Linux; a different value
  // means another machine or container, whose pids say nothing about this one.
  const pidDomain =
    platform === "linux"
      ? [
          "linux",
          yield* fs.readFileString(machineIdPath).pipe(
            Effect.map((id) => id.trim()),
            Effect.orElseSucceed(() => ""),
          ),
          yield* fs
            .readLink(path.join(procRoot, "self", "ns", "pid"))
            .pipe(Effect.orElseSucceed(() => "")),
        ].join(":")
      : null;
  const startField = platform === "darwin" ? "procStartFt" : "procStart";

  const startOf = Effect.fnUntraced(function* (pid: number) {
    if (platform === "linux") {
      const stat = yield* fs
        .readFileString(path.join(procRoot, String(pid), "stat"))
        .pipe(Effect.option);
      return Option.isNone(stat) ? null : procStatStartTime(stat.value);
    }
    if (platform !== "darwin") return null;
    // Claude records `ps -o lstart=` under the C locale in UTC as `procStartFt`.
    const result = yield* processRunner
      .run({
        command: "ps",
        args: ["-o", "lstart=", "-p", String(pid)],
        timeout: "1 second",
        env: { ...hostEnvironment, LC_ALL: "C", TZ: "UTC" },
      })
      .pipe(Effect.option);
    if (Option.isNone(result) || result.value.code !== 0) return null;
    return result.value.stdout.trim() || null;
  });

  const readLive = Effect.fn("ClaudeSessionRegistry.read")(function* () {
    const names = yield* fs
      .readDirectory(sessionsDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const parsed = yield* Effect.forEach(
      names.filter((name) => name.endsWith(".json") && !name.startsWith(".")),
      (name) =>
        fs.readFileString(path.join(sessionsDir, name)).pipe(
          Effect.map(parseRegistryEntry),
          Effect.orElseSucceed(() => null),
        ),
      { concurrency: 8 },
    );
    const entries = parsed.filter((entry) => entry !== null);
    const starts = new Map(
      yield* Effect.forEach(
        new Set(entries.map((entry) => entry.pid)),
        (pid) => startOf(pid).pipe(Effect.map((start) => [pid, start] as const)),
        { concurrency: 8 },
      ),
    );
    const probe: LivenessProbe = {
      pidDomain,
      startField,
      startOf: (pid) => starts.get(pid) ?? null,
    };
    return entries
      .filter((entry) => isLive(entry, probe))
      .map((entry) => ({ attachment: toAttachment(entry), start: starts.get(entry.pid) ?? null }));
  });

  const attachments = yield* SubscriptionRef.make<ReadonlyMap<string, Attachment>>(new Map());
  // The start time each outside holder's pid had when last read; a change means it died.
  let holderStarts: ReadonlyMap<number, string | null> = new Map();

  const refresh = Effect.fn("ClaudeSessionRegistry.refresh")(function* () {
    const live = (yield* readLive()).filter(({ attachment }) => attachment.owner !== "rucode");
    holderStarts = new Map(live.map(({ attachment, start }) => [attachment.pid, start]));
    const next = bySession(live.map(({ attachment }) => attachment));
    if (!sameAttachments(yield* SubscriptionRef.get(attachments), next)) {
      yield* SubscriptionRef.set(attachments, next);
    }
  });

  // A burst of events collapses into one pending re-read.
  const dirty = yield* Queue.sliding<void>(1);
  const ready = yield* Deferred.make<void>();
  yield* fs.watch(sessionsDir, { onReady: () => Deferred.doneUnsafe(ready, Effect.void) }).pipe(
    Stream.filter((event) => event.path.endsWith(".json")),
    Stream.runForEach(() => Queue.offer(dirty, undefined)),
    Effect.ignoreCause({ log: true }),
    Effect.ensuring(Deferred.succeed(ready, undefined)),
    Effect.forkScoped,
  );
  yield* Deferred.await(ready);
  yield* refresh();
  yield* Queue.take(dirty).pipe(Effect.andThen(refresh()), Effect.forever, Effect.forkScoped);

  const holderDied = Effect.gen(function* () {
    for (const [pid, start] of holderStarts) {
      if ((yield* startOf(pid)) !== start) return true;
    }
    return false;
  });
  yield* holderDied.pipe(
    Effect.flatMap((died) => (died ? Queue.offer(dirty, undefined) : Effect.void)),
    Effect.repeat(Schedule.spaced(HOLDER_LIVENESS_INTERVAL)),
    Effect.forkScoped,
  );

  const entry = Effect.fn("ClaudeSessionRegistry.entry")(function* (sessionId: string) {
    const live = (yield* readLive())
      .map(({ attachment }) => attachment)
      .filter((attachment) => attachment.sessionId === sessionId);
    const found = bySession(live).get(sessionId) ?? null;
    const held = (yield* SubscriptionRef.get(attachments)).get(sessionId);
    if (held !== undefined && (found === null || found.owner === "rucode")) {
      yield* Queue.offer(dirty, undefined);
    }
    return found;
  });

  const awaitGone = Effect.fn("ClaudeSessionRegistry.awaitGone")(function* (
    sessionId: string,
    timeout: Duration.Input,
  ) {
    return yield* SubscriptionRef.changes(attachments).pipe(
      Stream.filter((current) => !current.has(sessionId)),
      Stream.runHead,
      Effect.as(true),
      Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.succeed(false) }),
    );
  });

  const socketOf = Effect.fn("ClaudeSessionRegistry.socketOf")(function* (pid: number) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    const environ = yield* fs
      .readFileString(path.join(procRoot, String(pid), "environ"))
      .pipe(Effect.option);
    return Option.isNone(environ) ? null : tmuxSocketFromEnviron(environ.value);
  });

  return ClaudeSessionRegistry.of({ attachments, entry, awaitGone, socketOf });
});

export const layer = Layer.effect(ClaudeSessionRegistry, make());
