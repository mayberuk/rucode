import {
  EnvironmentId,
  type PluginInitiativeBoard,
  type PluginInitiativeCost,
  type PluginInitiativeDecision,
  type PluginInitiativeGate,
  type PluginInitiativeMergeRequest,
  type PluginInitiativePart,
  type PluginInitiativePhase,
  type PluginInitiativeWave,
} from "@t3tools/contracts";
import { formatUsd } from "@t3tools/shared/usageFormat";

import type { BoardSearch } from "../boardSearch";

export type BoardTarget =
  | { readonly kind: "initiative"; readonly environmentId: EnvironmentId; readonly slug: string }
  | { readonly kind: "disconnected"; readonly environmentId: EnvironmentId; readonly slug: string }
  | { readonly kind: "choose" }
  | { readonly kind: "none" };

export function boardTarget(
  search: BoardSearch,
  open: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly slug: string }>,
  connected: ReadonlyArray<EnvironmentId>,
): BoardTarget {
  const { slug } = search;
  if (!slug) {
    if (open.length > 1) return { kind: "choose" };
    const [initiative] = open;
    return initiative
      ? { kind: "initiative", environmentId: initiative.environmentId, slug: initiative.slug }
      : { kind: "none" };
  }

  if (search.environmentId !== undefined) {
    const environmentId = EnvironmentId.make(search.environmentId);
    return {
      kind: connected.includes(environmentId) ? "initiative" : "disconnected",
      environmentId,
      slug,
    };
  }

  const matches = open.filter((initiative) => initiative.slug === slug);
  const [match] = matches;
  if (matches.length > 1) return { kind: "choose" };
  if (match) return { kind: "initiative", environmentId: match.environmentId, slug };

  const [environmentId] = connected;
  return connected.length === 1 && environmentId !== undefined
    ? { kind: "initiative", environmentId, slug }
    : { kind: "choose" };
}

export interface PhaseSummary {
  readonly done: number;
  readonly total: number;
  readonly current: { readonly index: number; readonly phase: PluginInitiativePhase } | null;
  readonly next: PluginInitiativePhase | null;
  readonly attempt: number | null;
}

export function phaseSummary(phases: ReadonlyArray<PluginInitiativePhase>): PhaseSummary {
  let done = 0;
  let lastDoneIndex = -1;
  let current: PhaseSummary["current"] = null;
  let attempt: number | null = null;

  for (const [index, phase] of phases.entries()) {
    if (phase.state === "done") {
      done += 1;
      lastDoneIndex = index;
    }
    if (current === null && (phase.state === "running" || phase.state === "failed")) {
      current = { index: index + 1, phase };
    }
    if (phase.attempt !== null && (attempt === null || phase.attempt > attempt)) {
      attempt = phase.attempt;
    }
  }

  const nextStart = current?.index ?? lastDoneIndex + 1;
  const next = phases.find(
    ({ state }, index) => index >= nextStart && (state === "pending" || state === "stale"),
  );
  return { done, total: phases.length, current, next: next ?? null, attempt };
}

export function failedCheckCount(gate: PluginInitiativeGate | null): number {
  return gate?.checks.filter(({ state }) => state === "fail").length ?? 0;
}

function formatAmount(usd: number, state: PluginInitiativeCost["state"]): string {
  const amount = formatUsd(usd);
  if (state === "estimated") return `~${amount}`;
  if (state === "incomplete") return `${amount}+`;
  return amount;
}

export function formatCost({ usd, state }: PluginInitiativeCost): string | null {
  return usd === null || state === "unknown" || usd <= 0 ? null : formatAmount(usd, state);
}

export interface SpendView {
  readonly value: string | null;
  readonly ceiling: string | null;
  readonly fill: number | null;
  readonly tone: "error" | "warning" | null;
}

export function spendView(spend: PluginInitiativeBoard["spend"]): SpendView {
  const { state, ceilingUsd } = spend;
  const usd = state === "unknown" ? null : spend.usd;
  const value = usd === null ? null : formatAmount(usd, state);
  const ceiling = ceilingUsd === null ? null : formatUsd(ceilingUsd);
  if (usd === null || ceilingUsd === null || ceilingUsd <= 0) {
    return { value, ceiling, fill: null, tone: null };
  }

  const ratio = usd / ceilingUsd;
  return {
    value,
    ceiling,
    fill: Math.min(100, ratio * 100),
    tone: ratio >= 1 ? "error" : ratio >= 0.8 ? "warning" : null,
  };
}

export function settledFill({ settled, total }: PluginInitiativeBoard["parts"]): number | null {
  return total === 0 ? null : (settled / total) * 100;
}

export function mergeRequestLabel({ number, ref }: PluginInitiativeMergeRequest): string {
  return number === null ? ref : `!${number}`;
}

export function partTitle(board: PluginInitiativeBoard, partId: string): string {
  for (const { parts } of board.waves) {
    const part = parts.find(({ id }) => id === partId);
    if (part) return part.title || partId;
  }
  return partId;
}

export function previousWave(
  board: PluginInitiativeBoard,
  number: number,
): PluginInitiativeWave | null {
  return board.waves.find((wave) => wave.number === number - 1) ?? null;
}

export function runningParts(board: PluginInitiativeBoard): ReadonlyArray<PluginInitiativePart> {
  return board.waves.flatMap(({ parts }) =>
    parts.filter(({ status }) => status === "running" || status === "gating"),
  );
}

export function primaryOptionKey({ options, defaultKey }: PluginInitiativeDecision): string | null {
  return (
    options.find(({ recommended }) => recommended)?.key ??
    options.find(({ key }) => key === defaultKey)?.key ??
    null
  );
}

export function minutesUntil(iso: string, now: string): number {
  const remaining = Date.parse(iso) - Date.parse(now);
  return remaining > 0 ? Math.ceil(remaining / 60_000) : 0;
}
