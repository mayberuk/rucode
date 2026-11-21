import type {
  EnvironmentId,
  PluginLiveInitiative,
  PluginLiveState,
  ThreadId,
} from "@t3tools/contracts";

export interface EnvironmentLiveState {
  readonly environmentId: EnvironmentId;
  readonly state: PluginLiveState | null;
}

export interface InitiativeMetric {
  readonly label: string;
  readonly value: string;
  /** Share from 0 to 1 for a bar, or null for a plain value. */
  readonly fill: number | null;
  readonly tone: "warning" | null;
  readonly tooltip: string;
}

export interface InitiativeSidebarGroup {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly slug: string;
  readonly label: string;
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly endLabel: string;
}

export interface BoardInitiative {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly initiative: PluginLiveInitiative;
  readonly metrics: ReadonlyArray<InitiativeMetric>;
  readonly active: boolean;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function share(part: number, total: number): number | null {
  return total > 0 ? Math.min(1, Math.max(0, part / total)) : null;
}

function initiativeKey(environmentId: EnvironmentId, slug: string): string {
  return `${environmentId}:${slug}`;
}

function openInitiatives(state: PluginLiveState | null): ReadonlyArray<PluginLiveInitiative> {
  return state === null ? [] : state.initiatives.filter((initiative) => !initiative.closed);
}

export function hasOpenDecision(state: PluginLiveState | null, threadId: ThreadId): boolean {
  return state !== null && state.waitingThreadIds.includes(threadId);
}

export function initiativeForThread(
  state: PluginLiveState | null,
  threadId: ThreadId,
): PluginLiveInitiative | null {
  if (state === null) return null;
  const open = openInitiatives(state);
  return (
    open.find((initiative) => initiative.orchestratorThreadId === threadId) ??
    open.find((initiative) => initiative.parts.some((part) => part.threadIds.includes(threadId))) ??
    open.find((initiative) =>
      state.children.some(
        (child) => child.threadId === threadId && child.initiative === initiative.slug,
      ),
    ) ??
    null
  );
}

function spendMetric(spend: PluginLiveInitiative["spend"]): InitiativeMetric {
  const tooltips = {
    exact: "Exact",
    estimated: "Estimated",
    incomplete: "Incomplete: some runs have no cost yet",
    unknown: "Unknown",
  } as const;
  const approximate = spend.state === "estimated" || spend.state === "incomplete";
  return {
    label: "Spend",
    value: spend.usd === null ? "Unknown" : `${approximate ? "~" : ""}$${spend.usd.toFixed(2)}`,
    fill: null,
    tone: null,
    tooltip: tooltips[spend.state],
  };
}

export function initiativeMetrics(
  initiative: PluginLiveInitiative,
): ReadonlyArray<InitiativeMetric> {
  const { wave, settled, running, openDecisions, spend } = initiative;
  return [
    {
      label: `Wave ${wave.current}`,
      value: `${wave.partsSettled} of ${wave.partsTotal}`,
      fill: share(wave.partsSettled, wave.partsTotal),
      tone: null,
      tooltip: `Parts settled in wave ${wave.current} of ${wave.total}`,
    },
    {
      label: "Settled",
      value: `${settled.count} of ${settled.total}`,
      fill: share(settled.count, settled.total),
      tone: null,
      tooltip: "Runs settled out of all runs started",
    },
    {
      label: "Running",
      value: `${running}`,
      fill: null,
      tone: null,
      tooltip: "Runs working right now",
    },
    {
      label: "Decisions",
      value: openDecisions > 0 ? `${openDecisions} open` : "None",
      fill: null,
      tone: openDecisions > 0 ? "warning" : null,
      tooltip: "Decisions waiting for an answer",
    },
    spendMetric(spend),
  ];
}

function distinct<T>(values: ReadonlyArray<T>): ReadonlyArray<T> {
  return [...new Set(values)];
}

function initiativeThreadIds(
  state: PluginLiveState,
  initiative: PluginLiveInitiative,
): ReadonlyArray<ThreadId> {
  const ids: ThreadId[] = [];
  if (initiative.orchestratorThreadId !== null) ids.push(initiative.orchestratorThreadId);
  for (const part of initiative.parts) ids.push(...part.threadIds);
  for (const child of state.children) {
    if (child.initiative === initiative.slug && child.threadId !== null) ids.push(child.threadId);
  }
  return distinct(ids);
}

function groupEndLabel(wave: PluginLiveInitiative["wave"]): string {
  const base = `Wave ${wave.current} of ${wave.total}`;
  return wave.partsTotal > 0
    ? `${base} · ${wave.partsSettled} of ${wave.partsTotal} parts settled`
    : base;
}

export function initiativeSidebarGroups(
  states: ReadonlyArray<EnvironmentLiveState>,
): ReadonlyArray<InitiativeSidebarGroup> {
  const groups: InitiativeSidebarGroup[] = [];
  for (const { environmentId, state } of states) {
    if (state === null) continue;
    for (const initiative of openInitiatives(state)) {
      const threadIds = initiativeThreadIds(state, initiative);
      if (threadIds.length === 0) continue;
      groups.push({
        key: initiativeKey(environmentId, initiative.slug),
        environmentId,
        slug: initiative.slug,
        label: initiative.title ?? initiative.slug,
        threadIds,
        endLabel: groupEndLabel(initiative.wave),
      });
    }
  }
  return groups.toSorted(
    (a, b) => a.label.localeCompare(b.label) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

function asOfMs(asOf: string): number {
  const ms = Date.parse(asOf);
  return Number.isNaN(ms) ? 0 : ms;
}

export function boardInitiatives(
  states: ReadonlyArray<EnvironmentLiveState>,
): ReadonlyArray<BoardInitiative> {
  const items: BoardInitiative[] = [];
  for (const { environmentId, state } of states) {
    for (const initiative of openInitiatives(state)) {
      items.push({
        key: initiativeKey(environmentId, initiative.slug),
        environmentId,
        initiative,
        metrics: initiativeMetrics(initiative),
        active: initiative.running > 0 || initiative.openDecisions > 0,
      });
    }
  }
  return items.toSorted(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      asOfMs(b.initiative.asOf) - asOfMs(a.initiative.asOf) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

export function formatAsOf(asOf: string, now: string): string {
  const elapsed = Date.parse(now) - Date.parse(asOf);
  if (!(elapsed >= MINUTE_MS)) return "as of just now";
  if (elapsed < HOUR_MS) return `as of ${Math.floor(elapsed / MINUTE_MS)}m ago`;
  if (elapsed < DAY_MS) return `as of ${Math.floor(elapsed / HOUR_MS)}h ago`;
  return `as of ${Math.floor(elapsed / DAY_MS)}d ago`;
}
