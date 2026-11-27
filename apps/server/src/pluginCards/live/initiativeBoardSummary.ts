import type {
  PluginInitiativeBoard,
  PluginInitiativeCost,
  PluginInitiativeDecision,
  PluginInitiativeGate,
  PluginInitiativeHeadline,
  PluginInitiativeMergeRequest,
  PluginInitiativePart,
  PluginInitiativePartStatus,
  PluginInitiativePhase,
  PluginInitiativeWave,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { type DispatchDecisionRecord, toDecisionCardData } from "../dispatch/decisionRecord.ts";
import { decisionCardId } from "../dispatch/decisionSource.ts";
import type { DispatchInitiativeState } from "../dispatch/initiativeState.ts";
import { planWaves, SETTLED_PART_STATUSES, waveName } from "../dispatch/initiativeWaves.ts";
import type { DispatchLiveInitiative } from "../dispatch/liveRegistry.ts";
import {
  checkState,
  type DispatchLivePart,
  executorFor,
  phaseState,
  summaryOf,
} from "../sources/dispatchWaveSnapshot.ts";
import { spendOf } from "./dispatchLiveSummary.ts";

export interface PartRecords {
  readonly branch: string | null;
  /** This part's `dp wave live` entries, for any of its plan waves. */
  readonly waveLive: ReadonlyArray<DispatchLivePart>;
  readonly specPhases: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly wave: number;
  }> | null;
}

export interface InitiativeBoardInputs {
  readonly slug: string;
  readonly state: DispatchInitiativeState;
  readonly registry: DispatchLiveInitiative | null;
  readonly ceilingUsd: number | null;
  /** Keyed by part id; a part with no worktree has no entry. */
  readonly records: ReadonlyMap<string, PartRecords>;
  /** Already filtered to this initiative. */
  readonly openDecisions: ReadonlyArray<DispatchDecisionRecord>;
}

type LedgerPart = DispatchInitiativeState["parts"][number];

const LEDGER_STATUSES: ReadonlySet<string> = new Set<PluginInitiativePartStatus>([
  "planned",
  "briefed",
  "specced",
  "gate-fail",
  "gate-pass",
  "mr-open",
  "merged",
]);
const UNSTARTED_STATUSES: ReadonlySet<string> = new Set(["planned", "briefed", "specced"]);
const WAITING_STATUSES: ReadonlySet<string> = new Set([...UNSTARTED_STATUSES, "queued"]);
const FAILED_CHECK_STATES: ReadonlySet<string> = new Set(["FAIL", "BLOCKED"]);
const MAX_MR_REF = 120;
const SINGLE_HTTP_URL = /^https?:\/\/\S+$/iu;
const TRAILING_MR_NUMBER = /(?:!|#|\/merge_requests\/|\/pull\/)(\d+)$/u;
const PHASE_ORDER = new Intl.Collator("en", { numeric: true });

const parseMillis = (iso: string): number | null =>
  Option.getOrNull(Option.map(DateTime.make(iso), DateTime.toEpochMillis));

const compareTimes = (left: string, right: string) => {
  const leftMillis = parseMillis(left);
  const rightMillis = parseMillis(right);
  return leftMillis !== null && rightMillis !== null
    ? leftMillis - rightMillis
    : left.localeCompare(right);
};

const latestBy = <T>(items: ReadonlyArray<T>, isLater: (candidate: T, best: T) => boolean) =>
  items.reduce<T | null>(
    (best, item) => (best === null || isLater(item, best) ? item : best),
    null,
  );

const latestEntry = (entries: ReadonlyArray<DispatchLivePart>) =>
  latestBy(
    entries,
    (candidate, best) =>
      candidate.wave > best.wave ||
      (candidate.wave === best.wave &&
        compareTimes(candidate.runStartedAt, best.runStartedAt) >= 0),
  );

const partStatus = (
  part: LedgerPart,
  latest: DispatchLivePart | null,
  inOpenedCurrentWave: boolean,
): PluginInitiativePartStatus => {
  const base = LEDGER_STATUSES.has(part.status)
    ? (part.status as PluginInitiativePartStatus)
    : "planned";
  if (base !== "merged" && latest !== null && latest.alive && !latest.complete) {
    return latest.gate?.state === "running" ? "gating" : "running";
  }
  return inOpenedCurrentWave && UNSTARTED_STATUSES.has(base) ? "queued" : base;
};

const partPhases = (
  records: PartRecords | undefined,
  latest: DispatchLivePart | null,
  settled: boolean,
): ReadonlyArray<PluginInitiativePhase> => {
  const listed = latest?.phases ?? records?.specPhases ?? [];
  const entries = records?.waveLive ?? [];
  return listed
    .toSorted((left, right) => PHASE_ORDER.compare(left.id, right.id))
    .map((phase) => {
      const entry = latestEntry(entries.filter((candidate) => candidate.wave === phase.wave));
      const executor = entry === null ? null : executorFor(entry, phase.id);
      return {
        id: phase.id,
        name: phase.name,
        state: executor === null && settled ? "done" : phaseState(executor),
        attempt: executor !== null && executor.attempt > 1 ? executor.attempt : null,
      };
    });
};

const liveGate = (entry: DispatchLivePart): PluginInitiativeGate | null => {
  const gate = entry.gate;
  if (gate === null || (gate.state === "" && gate.checks.length === 0)) return null;
  const running = gate.state === "running";
  const current = running && gate.currentCheck !== "" ? gate.currentCheck : null;
  const checks = gate.checks.map((check) => ({
    id: check.name,
    state: check.name === current ? ("running" as const) : checkState(check.state, false),
    summary: summaryOf(check.reason),
  }));
  if (current !== null && !gate.checks.some((check) => check.name === current)) {
    checks.push({ id: current, state: "running", summary: "" });
  }
  const failed =
    gate.state === "failed" || gate.checks.some((check) => FAILED_CHECK_STATES.has(check.state));
  return {
    state: running ? "running" : failed ? "failed" : "passed",
    at: running ? (gate.startedAt ?? null) : null,
    checks,
  };
};

const partGate = (
  entries: ReadonlyArray<DispatchLivePart>,
  ledger: DispatchInitiativeState["progress"][number]["gate"],
): PluginInitiativeGate | null => {
  const withGate = latestEntry(entries.filter((entry) => liveGate(entry) !== null));
  const fromLive = withGate === null ? null : liveGate(withGate);
  if (fromLive !== null) {
    return fromLive.state === "running" ? fromLive : { ...fromLive, at: ledger?.at ?? null };
  }
  return ledger === null
    ? null
    : { state: ledger.passed ? "passed" : "failed", at: ledger.at, checks: [] };
};

const mergeRequestOf = (recorded: string | undefined): PluginInitiativeMergeRequest | null => {
  const text = recorded?.trim() ?? "";
  if (text === "") return null;
  const number = TRAILING_MR_NUMBER.exec(text)?.[1];
  return {
    ref: text.length > MAX_MR_REF ? `${text.slice(0, MAX_MR_REF - 1)}…` : text,
    url: SINGLE_HTTP_URL.test(text) ? text : null,
    number: number === undefined ? null : Number(number),
  };
};

const costStateOf = (state: string, usd: number | null): PluginInitiativeCost["state"] => {
  switch (state) {
    case "final":
      return "exact";
    case "estimated":
      return "estimated";
    case "incomplete":
      return "incomplete";
    default:
      return usd === null ? "unknown" : "estimated";
  }
};

const partCost = (
  row: NonNullable<DispatchLiveInitiative["parts"]>[string] | undefined,
  entries: ReadonlyArray<DispatchLivePart>,
): PluginInitiativeCost => {
  if (row !== undefined) {
    const usd = row.costUsd > 0 ? row.costUsd : null;
    return { usd, state: costStateOf(row.costState, usd) };
  }
  const costs = entries.flatMap((entry) =>
    entry.children.flatMap((child) => (child.costUsd === null ? [] : [child.costUsd])),
  );
  return costs.length === 0
    ? { usd: null, state: "unknown" }
    : { usd: costs.reduce((sum, cost) => sum + cost, 0), state: "estimated" };
};

const earliestStart = (entries: ReadonlyArray<DispatchLivePart>) => {
  const starts = entries.flatMap((entry) => {
    const millis = parseMillis(entry.runStartedAt);
    return millis === null ? [] : [millis];
  });
  return starts.length === 0 ? null : DateTime.formatIso(DateTime.makeUnsafe(Math.min(...starts)));
};

const toNeedsYou = (record: DispatchDecisionRecord): PluginInitiativeDecision => {
  const data = toDecisionCardData(record, null, "yes");
  return {
    cardId: decisionCardId(record.dir, record.id),
    decisionId: data.decisionId,
    kind: data.decisionKind,
    question: data.question,
    part: data.part,
    options: data.options,
    defaultKey: data.defaultKey,
    applyAfter: data.applyAfter,
    protection: data.protection,
    needsPerson: data.needsPerson,
    raisedAt: data.raisedAt,
  };
};

const isSettled = (part: PluginInitiativePart) => SETTLED_PART_STATUSES.has(part.status);

const headlineOf = (
  closed: boolean,
  needsYou: ReadonlyArray<PluginInitiativeDecision>,
  waves: ReadonlyArray<PluginInitiativeWave>,
  currentWave: number,
): PluginInitiativeHeadline => {
  if (closed) return { kind: "closed" };
  const oldest = needsYou[0];
  if (oldest !== undefined) {
    return { kind: "needs-you", decisions: needsYou.length, part: oldest.part || null };
  }
  const parts = waves.flatMap((wave) => wave.parts);
  const failing = parts.find((part) => part.status === "gate-fail" && part.wave <= currentWave);
  if (failing !== undefined) {
    return {
      kind: "failing",
      part: failing.id,
      failedChecks: failing.gate?.checks.filter((check) => check.state === "fail").length ?? 0,
    };
  }
  const gating = parts.find((part) => part.status === "gating");
  if (gating !== undefined) return { kind: "gating", part: gating.id };
  const running = parts.find((part) => part.status === "running");
  if (running !== undefined) {
    const total = running.phases.length;
    const done = running.phases.filter((phase) => phase.state === "done").length;
    return {
      kind: "running",
      part: running.id,
      phase: total === 0 ? null : { index: Math.min(done + 1, total), total },
      nextPart: parts.find((part) => part.status === "queued")?.id ?? null,
    };
  }
  if (parts.length > 0 && parts.every(isSettled)) return { kind: "done" };
  return {
    kind: "waiting",
    nextPart:
      parts.find((part) => part.wave >= currentWave && WAITING_STATUSES.has(part.status))?.id ??
      null,
  };
};

export function buildInitiativeBoard(
  inputs: InitiativeBoardInputs,
): Omit<PluginInitiativeBoard, "asOf"> {
  const { state, registry } = inputs;
  const plan = planWaves(state);
  const currentOpened = state.waves.some(
    (wave) => wave.opened && !wave.closed && plan.displayOf(wave.number) === plan.current,
  );

  const buildPart = (part: LedgerPart): PluginInitiativePart => {
    const records = inputs.records.get(part.id);
    const entries = records?.waveLive ?? [];
    const latest = latestEntry(entries);
    const wave = plan.displayOf(part.wave);
    const status = partStatus(part, latest, currentOpened && wave === plan.current);
    const progress = state.progress.findLast((row) => row.part === part.id) ?? null;
    return {
      id: part.id,
      title: part.title,
      wave,
      status,
      phases: [...partPhases(records, latest, SETTLED_PART_STATUSES.has(status))],
      gate: partGate(
        entries,
        state.progress.findLast((row) => row.part === part.id && row.gate !== null)?.gate ?? null,
      ),
      branch: records?.branch ?? null,
      mergeRequest: mergeRequestOf(
        state.deliveries.findLast((delivery) => delivery.part === part.id)?.mr,
      ),
      cost: partCost(registry?.parts?.[part.id], entries),
      startedAt: earliestStart(entries),
      lastEventAt: progress?.lastEventAt ?? null,
    };
  };

  const waves = Array.from({ length: plan.total }, (_, index): PluginInitiativeWave => {
    const number = index + 1;
    const ledgerParts = state.parts.filter((part) => plan.displayOf(part.wave) === number);
    const parts = ledgerParts.map(buildPart);
    const settled = parts.filter(isSettled).length;
    return {
      number,
      ...waveName(ledgerParts.map((part) => part.title)),
      state: settled === parts.length ? "done" : number <= plan.current ? "active" : "waiting",
      partsSettled: settled,
      partsTotal: parts.length,
      parts,
    };
  });

  const needsYou = inputs.openDecisions
    .toSorted(
      (left, right) =>
        compareTimes(left.raisedAt, right.raisedAt) || left.id.localeCompare(right.id),
    )
    .map(toNeedsYou);
  const closed = state.closed || registry?.closed === true;
  const allParts = waves.flatMap((wave) => wave.parts);

  return {
    slug: inputs.slug,
    title: state.initiative.title,
    closed,
    startedAt: registry?.started ?? null,
    headline: headlineOf(closed, needsYou, waves, plan.current),
    parts: { settled: allParts.filter(isSettled).length, total: allParts.length },
    spend: {
      ...(registry === null ? { usd: null, state: "unknown" as const } : spendOf(registry)),
      ceilingUsd: inputs.ceilingUsd,
    },
    currentWave: plan.current,
    waves,
    needsYou,
  };
}
