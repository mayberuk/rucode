import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type RegistryStatus = "busy" | "idle" | "shell" | "unknown";
export type RegistryOwner = "rucode" | "terminal" | "other";

/** One `<claudeHome>/sessions/<pid>.json` file, written by a running Claude Code process. */
export interface RegistryEntry {
  readonly pid: number;
  readonly sessionId: string;
  readonly cwd: string | null;
  readonly entrypoint: string | null;
  readonly status: RegistryStatus;
  readonly name: string | null;
  readonly tmux: string | null;
  readonly procStart: string | null;
  readonly procStartFt: string | null;
  readonly pidDomain: string | null;
  readonly startedAt: number | null;
}

// Claude names transcripts `<sessionId>.jsonl`; anything else could escape the projects directory.
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// The registry is an undocumented Claude internal: only pid and sessionId are required, and a
// renamed or retyped optional field degrades to null instead of hiding the entry.
const decodeRawEntry = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      pid: Schema.Number,
      sessionId: Schema.String,
      cwd: Schema.optional(Schema.Unknown),
      entrypoint: Schema.optional(Schema.Unknown),
      status: Schema.optional(Schema.Unknown),
      name: Schema.optional(Schema.Unknown),
      tmux: Schema.optional(Schema.Unknown),
      procStart: Schema.optional(Schema.Unknown),
      procStartFt: Schema.optional(Schema.Unknown),
      pidDomain: Schema.optional(Schema.Unknown),
      startedAt: Schema.optional(Schema.Unknown),
    }),
  ),
);

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);

const isKnownStatus = (value: unknown): value is Exclude<RegistryStatus, "unknown"> =>
  value === "busy" || value === "idle" || value === "shell";

export const parseRegistryEntry = (json: string): RegistryEntry | null => {
  const raw = Option.getOrUndefined(decodeRawEntry(json));
  if (raw === undefined || !Number.isSafeInteger(raw.pid) || raw.pid <= 0) return null;
  if (!SESSION_ID_PATTERN.test(raw.sessionId)) return null;
  return {
    pid: raw.pid,
    sessionId: raw.sessionId,
    cwd: text(raw.cwd),
    entrypoint: text(raw.entrypoint),
    status: isKnownStatus(raw.status) ? raw.status : "unknown",
    name: text(raw.name),
    tmux: text(raw.tmux),
    procStart: text(raw.procStart),
    procStartFt: text(raw.procStartFt),
    pidDomain: text(raw.pidDomain),
    startedAt: typeof raw.startedAt === "number" ? raw.startedAt : null,
  };
};

export interface LivenessProbe {
  /** This machine's pid domain in Claude's format; null where Claude records none to compare. */
  readonly pidDomain: string | null;
  /** Linux records `procStart`; macOS records `procStartFt`. */
  readonly startField: "procStart" | "procStartFt";
  /** The process start time in the same format Claude records, or null when the pid is not running. */
  readonly startOf: (pid: number) => string | null;
}

export const isLive = (entry: RegistryEntry, probe: LivenessProbe): boolean => {
  if (probe.pidDomain !== null && entry.pidDomain !== null && entry.pidDomain !== probe.pidDomain) {
    return false;
  }
  const start = probe.startOf(entry.pid);
  if (start === null) return false;
  const recorded = entry[probe.startField];
  return recorded === null || recorded === start;
};

export const ownerOf = (entry: RegistryEntry): RegistryOwner =>
  entry.entrypoint === "t3-code" ? "rucode" : entry.entrypoint === "cli" ? "terminal" : "other";

export interface RegistryPane {
  readonly session: string;
  readonly pane: string;
}

export const paneOf = (entry: RegistryEntry): RegistryPane | null => {
  const match = entry.tmux === null ? null : /^(.+):@\d+\.(%\d+)$/.exec(entry.tmux);
  return match === null ? null : { session: match[1]!, pane: match[2]! };
};

/** Field 22 of `/proc/<pid>/stat`, the start time Claude records as `procStart`. */
export const procStatStartTime = (stat: string): string | null => {
  // The command name in field 2 may hold spaces and parentheses; fields after it are plain.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const start = fields[19]?.trim();
  return start !== undefined && /^\d+$/.test(start) ? start : null;
};

/** The tmux server socket from a process environment (`TMUX=<socket>,<pid>,<session>`). */
export const tmuxSocketFromEnviron = (environ: string): string | null => {
  const value = environ
    .split("\0")
    .find((variable) => variable.startsWith("TMUX="))
    ?.slice("TMUX=".length);
  const socket = value?.split(",")[0];
  return socket !== undefined && socket !== "" ? socket : null;
};
