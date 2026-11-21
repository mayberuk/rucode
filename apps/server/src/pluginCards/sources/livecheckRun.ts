import type { LivecheckProgressCardData, LivecheckResultCardData } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** livecheck's own watchdog (`scripts/run-dir/watchdog.sh`) calls a run stale past this. */
export const HEARTBEAT_STALE_MS = 360_000;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_STEPS_LOG_BYTES = 256 * 1024;

/** The only screenshot names listed or served; it admits no path separator. */
export const SCREENSHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpe?g|webp)$/;

const RunMeta = Schema.Struct({
  runId: Schema.optionalKey(Schema.String),
  slug: Schema.optionalKey(Schema.String),
  startedAt: Schema.optionalKey(Schema.String),
});
export type RunMeta = typeof RunMeta.Type;

const RunResult = Schema.Struct({
  runId: Schema.optionalKey(Schema.String),
  task: Schema.optionalKey(Schema.String),
  collectionStatus: Schema.Literals(["REACHED", "BLOCKED", "PARTIAL", "ERROR"]),
  verdict: Schema.optionalKey(Schema.NullOr(Schema.Literals(["PASS", "FAIL"]))),
  rationale: Schema.optionalKey(Schema.NullOr(Schema.String)),
  endedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  blockers: Schema.optionalKey(Schema.Array(Schema.String)),
  asserts: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        outcome: Schema.String,
        evidenceRef: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  provenance: Schema.optionalKey(
    Schema.Struct({
      judge: Schema.optionalKey(
        Schema.NullOr(
          Schema.Struct({
            engine: Schema.String,
            model: Schema.optionalKey(Schema.NullOr(Schema.String)),
          }),
        ),
      ),
    }),
  ),
});
export type RunResult = typeof RunResult.Type;

export interface StepLine {
  readonly at: string;
  readonly kind: string;
  readonly text: string;
}

export interface LivecheckRun {
  readonly runDir: string;
  readonly meta: RunMeta | null;
  readonly steps: ReadonlyArray<StepLine>;
  readonly result: RunResult | null;
  readonly heartbeatMtime: number | null;
  readonly screenshots: ReadonlyArray<string>;
}

function parseStepsLog(text: string): ReadonlyArray<StepLine> {
  const lines: Array<StepLine> = [];
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const first = line.indexOf(" ");
    if (first <= 0) continue;
    const second = line.indexOf(" ", first + 1);
    const kind = second === -1 ? line.slice(first + 1) : line.slice(first + 1, second);
    if (kind === "") continue;
    lines.push({
      at: line.slice(0, first),
      kind,
      text: second === -1 ? "" : line.slice(second + 1),
    });
  }
  return lines;
}

const FINALIZE_STATUS = /(?:^| )status [^ >]*->([^ ]+)/;
const SETTLED_COLLECTION = new Set(["BLOCKED", "PARTIAL", "ERROR"]);

/** A collected-but-unjudged run (REACHED, verdict still null) is not finished. */
export function isFinished(steps: ReadonlyArray<StepLine>, result: RunResult | null): boolean {
  if (result?.collectionStatus === "REACHED" && (result.verdict ?? null) === null) return false;
  return steps.some((line) => {
    if (line.kind === "finalize") {
      const status = FINALIZE_STATUS.exec(line.text)?.[1];
      return status !== undefined && status !== "null";
    }
    return line.kind === "collected" && SETTLED_COLLECTION.has(line.text.split(" ")[0] ?? "");
  });
}

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const runIdOf = (run: LivecheckRun) => run.result?.runId ?? run.meta?.runId ?? baseName(run.runDir);

const targetOf = (run: LivecheckRun) =>
  run.result?.task ?? run.meta?.slug?.replaceAll("-", " ") ?? runIdOf(run);

function screenshotLabel(fileName: string): string {
  const stem = fileName.slice(0, fileName.lastIndexOf("."));
  const label = stem.replace(/^\d+-/, "").replaceAll("-", " ");
  return label === "" ? stem : label;
}

function failedScreenshot(result: RunResult, screenshots: ReadonlyArray<string>): number | null {
  for (const assert of result.asserts ?? []) {
    if (assert.outcome !== "fail" || !assert.evidenceRef) continue;
    const named = baseName(assert.evidenceRef.split("#")[0]!);
    const index = screenshots.indexOf(named);
    if (index !== -1) return index + 1;
  }
  return null;
}

function verdictOf(result: RunResult): LivecheckResultCardData["verdict"] | null {
  if (result.verdict === "PASS") return "pass";
  if (result.verdict === "FAIL") return "fail";
  if (result.collectionStatus === "BLOCKED" || result.collectionStatus === "PARTIAL") {
    return "blocked";
  }
  return result.collectionStatus === "ERROR" ? "error" : null;
}

/** Null without a result.json, or while a reached run still waits for its verdict. */
export function toResultData(run: LivecheckRun): LivecheckResultCardData | null {
  const result = run.result;
  if (result === null) return null;
  const verdict = verdictOf(result);
  if (verdict === null) return null;
  const failedStepIndex = failedScreenshot(result, run.screenshots);
  const judge = result.provenance?.judge;
  return {
    runId: runIdOf(run),
    runDir: run.runDir,
    target: targetOf(run),
    verdict,
    summary: result.rationale || result.blockers?.[0] || "",
    judge: judge ? `Judged by ${judge.engine}${judge.model ? ` (${judge.model})` : ""}` : null,
    steps: run.screenshots.map((name, position) => ({
      index: position + 1,
      label: screenshotLabel(name),
      state: position + 1 === failedStepIndex ? "failed" : "done",
      assetId: name,
    })),
    failedStepIndex,
    finishedAt: result.endedAt ?? null,
  };
}

/** A run with no heartbeat file has no evidence it is alive, so it reads as stale. */
function isHeartbeatStale(run: LivecheckRun, nowMs: number): boolean {
  return run.heartbeatMtime === null || nowMs - run.heartbeatMtime > HEARTBEAT_STALE_MS;
}

export function toProgressData(run: LivecheckRun, nowMs: number): LivecheckProgressCardData {
  const entries = run.steps.filter((line) => line.kind === "step" || line.kind === "checkpoint");
  const lastState = isHeartbeatStale(run, nowMs) ? "stale" : "running";
  return {
    runId: runIdOf(run),
    runDir: run.runDir,
    target: targetOf(run),
    steps: entries.map((line, position) => {
      const next = entries[position + 1];
      const gap = next === undefined ? Number.NaN : Date.parse(next.at) - Date.parse(line.at);
      return {
        index: position + 1,
        label: line.text,
        state: next === undefined ? lastState : "done",
        durationMs: Number.isFinite(gap) && gap >= 0 ? gap : null,
      };
    }),
    currentStep: entries.length > 0 ? entries.length : null,
    totalSteps: entries.length,
    heartbeatAt:
      run.heartbeatMtime === null
        ? null
        : DateTime.formatIso(DateTime.makeUnsafe(run.heartbeatMtime)),
    latestAssetId: run.screenshots.at(-1) ?? null,
  };
}

const readRecord = Effect.fn("PluginCards.livecheck.readRecord")(function* <
  S extends Schema.ConstraintDecoder<unknown>,
>(schema: S, path: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(path).pipe(Effect.option);
  if (Option.isNone(info)) return null;
  if (info.value.type !== "File" || info.value.size > BigInt(MAX_RECORD_BYTES)) {
    yield* Effect.logWarning("livecheck record is not a file under 1 MiB", { path });
    return null;
  }
  const text = yield* fs.readFileString(path).pipe(Effect.option);
  const decoded = Option.flatMap(text, Schema.decodeOption(Schema.fromJsonString(schema)));
  if (Option.isSome(decoded)) return decoded.value;
  yield* Effect.logWarning("livecheck record could not be read", { path });
  return null;
});

/** The end of the log is the live part of a run, so an oversized log keeps its last 256 KiB, from a whole line. */
const readStepsLog = Effect.fn("PluginCards.livecheck.readStepsLog")(
  function* (path: string) {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* fs.open(path, { flag: "r" });
    const { size } = yield* file.stat;
    const start = Math.max(0, Number(size) - MAX_STEPS_LOG_BYTES);
    if (start > 0) yield* file.seek(BigInt(start), "start");
    const bytes = new Uint8Array(Number(size) - start);
    let offset = 0;
    while (offset < bytes.length) {
      const read = yield* file.read(bytes.subarray(offset));
      if (read === 0) break;
      offset += read;
    }
    const text = new TextDecoder().decode(bytes.subarray(0, offset));
    if (start === 0) return text;
    const firstLineEnd = text.indexOf("\n");
    return firstLineEnd < 0 ? "" : text.slice(firstLineEnd + 1);
  },
  Effect.scoped,
  Effect.orElseSucceed(() => ""),
);

export const readRun = Effect.fn("PluginCards.livecheck.readRun")(function* (runDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(runDir).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== "Directory") return null;

  const [meta, stepsText, result, heartbeat, entries] = yield* Effect.all(
    [
      readRecord(RunMeta, `${runDir}/meta.json`),
      readStepsLog(`${runDir}/steps.log`),
      readRecord(RunResult, `${runDir}/result.json`),
      fs.stat(`${runDir}/heartbeat`).pipe(Effect.option),
      fs
        .readDirectory(`${runDir}/screenshots`)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])),
    ],
    { concurrency: "unbounded" },
  );
  const heartbeatMtime = Option.flatMap(heartbeat, (stat) => stat.mtime);
  return {
    runDir,
    meta,
    steps: parseStepsLog(stepsText),
    result,
    heartbeatMtime: Option.isSome(heartbeatMtime) ? heartbeatMtime.value.getTime() : null,
    screenshots: entries.filter((name) => SCREENSHOT_NAME.test(name)).toSorted(),
  } satisfies LivecheckRun;
});
