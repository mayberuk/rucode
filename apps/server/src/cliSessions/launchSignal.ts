import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export interface ClaudeLaunch {
  readonly sessionId: string;
  readonly pid: number;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DIGITS = /^\d+$/;
const MAX_PARENT_HOPS = 64;

/** Reads the launching Claude session from a NUL-separated environ when both required variables are valid. */
export const claudeLaunchFromEnviron = (environ: string): ClaudeLaunch | null => {
  let sessionId: string | undefined;
  let pidText: string | undefined;

  for (const entry of environ.split("\0")) {
    const separator = entry.indexOf("=");
    if (separator === -1) continue;
    switch (entry.slice(0, separator)) {
      case "CLAUDE_CODE_SESSION_ID":
        sessionId ??= entry.slice(separator + 1);
        break;
      case "CLAUDE_PID":
        pidText ??= entry.slice(separator + 1);
        break;
    }
    if (sessionId !== undefined && pidText !== undefined) break;
  }

  if (sessionId === undefined || !SESSION_ID_PATTERN.test(sessionId)) return null;
  if (pidText === undefined || !DIGITS.test(pidText)) return null;
  const pid = Number(pidText);
  return Number.isSafeInteger(pid) && pid > 0 ? { sessionId, pid } : null;
};

/** Field 4 of `/proc/<pid>/stat`. */
export const procStatParentPid = (stat: string): number | null => {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd === -1 || !/^\d+ \(/.test(stat)) return null;
  const parent = /^ [A-Za-z] (\d+)(?:\s|$)/.exec(stat.slice(commandEnd + 1))?.[1];
  if (parent === undefined) return null;
  const pid = Number(parent);
  return Number.isSafeInteger(pid) ? pid : null;
};

/** Verifies the launching Claude process is an ancestor of `pid`. Unknown ancestry yields null. */
export const parentClaudeSessionOf = Effect.fn("CliSessionLaunch.parentClaudeSessionOf")(
  function* (pid: number, procRoot = "/proc") {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const launch = claudeLaunchFromEnviron(
      yield* fs.readFileString(path.join(procRoot, String(pid), "environ")),
    );
    if (launch === null || launch.pid === pid) return null;

    const seen = new Set<number>();
    let current = pid;
    for (let hop = 0; hop < MAX_PARENT_HOPS; hop++) {
      if (seen.has(current)) return null;
      seen.add(current);
      const parent = procStatParentPid(
        yield* fs.readFileString(path.join(procRoot, String(current), "stat")),
      );
      if (parent === null || parent <= 1) return null;
      if (parent === launch.pid) return launch.sessionId;
      current = parent;
    }
    return null;
  },
  Effect.catchCause(() => Effect.succeed(null)),
);
