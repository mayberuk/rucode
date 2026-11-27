// @effect-diagnostics-next-line nodeBuiltinImport:off -- The matcher needs synchronous host path resolution.
import * as NodePath from "node:path";

import type { RolloutMeta } from "./rolloutReader.ts";

export interface RolloutCandidate {
  readonly filePath: string;
  readonly meta: RolloutMeta;
  readonly firstPrompt: string | null;
}

export interface CodexRunRequest {
  readonly cwd: string;
  readonly startedAtMs: number;
  readonly prompt: string | null;
}

const EARLIEST_START_MS = 30_000;
const LATEST_START_MS = 120_000;

export function matchRollout(
  request: CodexRunRequest,
  candidates: ReadonlyArray<RolloutCandidate>,
  claimed: ReadonlySet<string>,
): string | null {
  const cwd = NodePath.resolve(request.cwd);
  const prompt = request.prompt?.trim() ?? null;
  const earliest = request.startedAtMs - EARLIEST_START_MS;
  const latest = request.startedAtMs + LATEST_START_MS;
  let match: string | null = null;
  for (const candidate of candidates) {
    const { filePath, meta, firstPrompt } = candidate;
    if (claimed.has(filePath) || meta.originator !== "codex_exec") continue;
    const startedAt = Date.parse(meta.startedAt);
    if (!(startedAt >= earliest && startedAt <= latest)) continue;
    if (NodePath.resolve(meta.cwd) !== cwd) continue;
    if (prompt !== null && firstPrompt?.trim() !== prompt) continue;
    if (match !== null) return null;
    match = filePath;
  }
  return match;
}

function dayDir(root: string, date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return NodePath.join(root, year, month, day);
}

export function rolloutDayDirs(sessionsRoot: string, startedAtMs: number): ReadonlyArray<string> {
  // @effect-diagnostics-next-line globalDate:off -- Codex names directories in the host's local calendar.
  const date = new Date(startedAtMs);
  if (Number.isNaN(date.getTime())) return [];
  const today = dayDir(sessionsRoot, date);
  date.setDate(date.getDate() - 1);
  return [today, dayDir(sessionsRoot, date)];
}
