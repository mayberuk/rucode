import type {
  DispatchRunProgressCardData,
  DispatchVerifyCardData,
  PluginCheckState,
  PluginStepState,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const LiveChild = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  phase: Schema.String,
  attempt: Schema.Number,
  state: Schema.String,
  costUsd: Schema.NullOr(Schema.Number),
  stale: Schema.Boolean,
  disposition: Schema.String,
});

const LiveGate = Schema.Struct({
  state: Schema.String,
  currentCheck: Schema.String,
  checks: Schema.Array(
    Schema.Struct({ name: Schema.String, state: Schema.String, reason: Schema.String }),
  ),
});

const LivePart = Schema.Struct({
  runId: Schema.String,
  runStartedAt: Schema.String,
  alive: Schema.Boolean,
  part: Schema.String,
  wave: Schema.Number,
  dir: Schema.String,
  initiative: Schema.optionalKey(Schema.String),
  spec: Schema.optionalKey(Schema.String),
  complete: Schema.Boolean,
  children: Schema.Array(LiveChild),
  gate: Schema.NullOr(LiveGate),
  phases: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      wave: Schema.Number,
      tier: Schema.String,
    }),
  ),
});
export type DispatchLivePart = typeof LivePart.Type;

/** The `dp wave live --json` fields this source reads; other keys are ignored. */
export const DispatchLiveSnapshot = Schema.Struct({
  schema: Schema.Literal("mc/1"),
  run: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.String,
        startedAt: Schema.String,
        spec: Schema.String,
        active: Schema.Boolean,
        outcome: Schema.String,
        endedAt: Schema.NullOr(Schema.String),
      }),
    ),
  ),
  parts: Schema.Array(LivePart),
});
export type DispatchLiveSnapshot = typeof DispatchLiveSnapshot.Type;

export const DispatchVerifyEvidence = Schema.Struct({
  assessments: Schema.Array(
    Schema.Struct({ criterion: Schema.String, disposition: Schema.String }),
  ),
});
export type DispatchVerifyEvidence = typeof DispatchVerifyEvidence.Type;

export const GateAttemptRow = Schema.Struct({
  part: Schema.String,
  wave: Schema.Number,
  revision: Schema.String,
});
export type GateAttemptRow = typeof GateAttemptRow.Type;

const EXECUTOR_KIND = "phase-executor";
const PASSED_DISPOSITIONS = new Set(["settled", "adopted"]);
const NO_OUTCOME_REASON = "dp reported no outcome";
/** Gate reasons can run to kilobytes (an adversary's full gap list); the card shows a line. */
const SUMMARY_MAX = 240;

const CHECK_NAMES: Readonly<Record<string, string>> = {
  precheck: "Precheck",
  unit: "Unit",
  integration: "Integration",
  review: "Review",
  "test-adversary": "Test review",
  "evidence:design": "Design",
  ownership: "Ownership",
  contract: "Contract",
  executor: "Executor",
  "commit-identity": "Commit identity",
};

const RUN_OUTCOMES: Readonly<Record<string, DispatchRunProgressCardData["outcome"]>> = {
  running: "running",
  passed: "passed",
  failed: "failed",
  unfinished: "aborted",
};

const executorFor = (part: DispatchLivePart, phaseId: string) => {
  let latest: DispatchLivePart["children"][number] | null = null;
  for (const child of part.children) {
    if (child.kind !== EXECUTOR_KIND || child.phase !== phaseId) continue;
    if (latest === null || child.attempt >= latest.attempt) latest = child;
  }
  return latest;
};

const phaseState = (executor: DispatchLivePart["children"][number] | null): PluginStepState => {
  if (executor === null) return "pending";
  if (executor.disposition === "") return executor.stale ? "stale" : "running";
  return PASSED_DISPOSITIONS.has(executor.disposition) ? "done" : "failed";
};

export function findPart(
  snapshot: DispatchLiveSnapshot,
  part: string,
  wave: number | null,
): DispatchLivePart | null {
  let found: DispatchLivePart | null = null;
  for (const entry of snapshot.parts) {
    if (entry.part !== part) continue;
    if (wave !== null ? entry.wave === wave : found === null || entry.wave > found.wave) {
      found = entry;
    }
  }
  return found;
}

export function toRunProgressData(
  snapshot: DispatchLiveSnapshot,
  part: string,
  wave: number,
  dir: string,
): DispatchRunProgressCardData | null {
  const entry = findPart(snapshot, part, wave);
  if (entry === null) return null;
  const run = snapshot.run?.id === entry.runId ? snapshot.run : null;
  const phases = entry.phases
    .filter((phase) => phase.wave === entry.wave)
    .map((phase) => {
      const executor = executorFor(entry, phase.id);
      return {
        id: phase.id,
        name: phase.name,
        state: phaseState(executor),
        attempt: executor !== null && executor.attempt > 1 ? executor.attempt : null,
      };
    });
  const runReported = run?.outcome ?? (entry.alive ? "running" : "unknown");
  // The run stays "running" while later waves go on; a wave whose own record is complete is settled.
  const reported =
    runReported === "running" && entry.complete
      ? phases.every((phase) => phase.state === "done")
        ? "passed"
        : "failed"
      : runReported;
  const outcome = RUN_OUTCOMES[reported] ?? "aborted";
  const costs = entry.children.flatMap((child) => (child.costUsd === null ? [] : [child.costUsd]));

  return {
    runId: entry.runId,
    dir,
    part: entry.part,
    wave: entry.wave,
    initiative: entry.initiative === undefined || entry.initiative === "" ? null : entry.initiative,
    spec: entry.spec ?? run?.spec ?? "",
    outcome,
    reason: RUN_OUTCOMES[reported] === undefined ? NO_OUTCOME_REASON : null,
    phases,
    phasesTotal: phases.length,
    startedAt: entry.runStartedAt,
    settledAt: run?.endedAt ?? null,
    costUsd: costs.length === 0 ? null : costs.reduce((sum, cost) => sum + cost, 0),
  };
}

const checkState = (state: string, stale: boolean): PluginCheckState => {
  switch (state) {
    case "PASS":
      return stale ? "stale" : "pass";
    case "FAIL":
    case "BLOCKED":
      return "fail";
    default:
      return "pending";
  }
};

const summaryOf = (reason: string) =>
  reason.length > SUMMARY_MAX ? `${reason.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : reason;

const evidenceRow = (evidence: DispatchVerifyEvidence | null) => {
  if (evidence === null || evidence.assessments.length === 0) return [];
  const dispositions = evidence.assessments.map((assessment) => assessment.disposition);
  const satisfied = dispositions.filter((disposition) => disposition === "satisfied").length;
  const state: PluginCheckState = dispositions.includes("failed")
    ? "fail"
    : dispositions.includes("stale")
      ? "stale"
      : satisfied === dispositions.length
        ? "pass"
        : "pending";
  return [
    {
      name: "Acceptance criteria",
      summary: `${satisfied} of ${dispositions.length} satisfied`,
      state,
    },
  ];
};

/** A passing check is stale only when both revisions are known and differ. */
export function toVerifyChecks(
  part: DispatchLivePart,
  headRevision: string | null,
  gateRevision: string | null,
  evidence: DispatchVerifyEvidence | null,
): DispatchVerifyCardData["checks"] {
  const stale = headRevision !== null && gateRevision !== null && headRevision !== gateRevision;
  const gate = part.gate;
  const running = gate?.state === "running" && gate.currentCheck !== "" ? gate.currentCheck : null;
  const rows = (gate?.checks ?? []).map((check) => ({
    name: CHECK_NAMES[check.name] ?? check.name,
    summary: summaryOf(check.reason),
    state: check.name === running ? ("running" as const) : checkState(check.state, stale),
  }));
  if (running !== null && !gate!.checks.some((check) => check.name === running)) {
    rows.push({ name: CHECK_NAMES[running] ?? running, summary: "", state: "running" });
  }
  return [...rows, ...evidenceRow(evidence)];
}
