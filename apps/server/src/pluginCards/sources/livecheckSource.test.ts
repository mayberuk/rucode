import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { type PluginCard, ThreadId, TurnItemId } from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../../processRunner.ts";
import type { ResolvedPluginCard } from "../core/PluginCardSource.ts";
import { PluginThreadIndex } from "../core/PluginThreadIndex.ts";
import { livecheckSource } from "./livecheckSource.ts";

const THREAD = ThreadId.make("thread-a");
const NOW = Date.parse("2026-11-21T10:00:00.000Z");
const RUN_ID = "20261121-095800-login-flow";
const FOUR_MIB = 4 * 1024 * 1024;

const RUNNING_LOG = [
  "2026-11-21T09:58:00Z step open login page",
  "2026-11-21T09:58:30Z checkpoint logged in",
  "2026-11-21T09:58:40Z progress 40s steps=2",
  "2026-11-21T09:59:00Z step open cart",
  "2026-11-21T09:59:10Z mystery not a step",
].join("\n");

const FAIL_RESULT = {
  runId: RUN_ID,
  task: "log in and open the cart",
  platform: "web",
  collectionStatus: "REACHED",
  verdict: "FAIL",
  rationale: "The cart stayed empty after adding an item.",
  endedAt: "2026-11-21T09:59:30Z",
  blockers: [],
  evidence: { screenshots: ["screenshots/01-login-page.png"] },
  asserts: [
    {
      via: "screenshot",
      expect: "login works",
      outcome: "pass",
      evidenceRef: "screenshots/01-login-page.png",
    },
    {
      via: "screenshot",
      expect: "the cart has the item",
      outcome: "fail",
      evidenceRef: "screenshots/03-cart-empty.png",
    },
  ],
  provenance: { judge: { engine: "codex", model: "gpt-5", status: "judged" } },
};

const FAIL_LOG = [
  RUNNING_LOG,
  "2026-11-21T09:59:20Z collected REACHED",
  "2026-11-21T09:59:30Z finalize verdict null->FAIL status REACHED->REACHED",
].join("\n");

const SCREENSHOTS = {
  "03-cart-empty.png": "third",
  "01-login-page.png": "first",
  "02-add-item.png": "second",
  "notes.txt": "not an image",
};

interface RunFixture {
  readonly id?: string;
  readonly steps?: string;
  readonly meta?: unknown;
  readonly result?: unknown;
  readonly heartbeatAgeMs?: number | null;
  readonly screenshots?: Readonly<Record<string, string | Uint8Array>>;
}

const command = (text: string, output: string | null = null, cwd = "/repo") => ({
  threadId: THREAD,
  turnItemId: TurnItemId.make("item-1"),
  command: text,
  output,
  exitCode: 0,
  cwd,
  completedAt: null,
});

const gitOutput = (stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const setup = Effect.fnUntraced(function* (
  options: { readonly gitKnowsMainCheckout?: boolean } = {},
) {
  const realFs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* realFs.makeTempDirectoryScoped({ prefix: "t3-livecheck-source-" });
  yield* TestClock.setTime(NOW);

  const watched: Array<string> = [];
  const fs = {
    ...realFs,
    watch: (target: string, watchOptions?: FileSystem.WatchOptions) => {
      watched.push(target);
      watchOptions?.onReady?.();
      return Stream.never;
    },
  } satisfies FileSystem.FileSystem;
  const gitCalls: Array<string | undefined> = [];
  const run: ProcessRunner.ProcessRunner["Service"]["run"] = (input) => {
    gitCalls.push(input.cwd);
    return options.gitKnowsMainCheckout !== true
      ? Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: input.command,
            argumentCount: input.args.length,
            cause: new Error("ENOENT"),
          }),
        )
      : Effect.succeed(gitOutput(`${root}/.git\n`));
  };
  const services = Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem, fs),
    Layer.succeed(Path.Path, path),
    Layer.succeed(ProcessRunner.ProcessRunner, { run }),
    Layer.mock(PluginThreadIndex)({}),
  );
  const source = yield* livecheckSource.pipe(Effect.provide(services));

  const writeRun = Effect.fnUntraced(function* (fixture: RunFixture) {
    const runDir = path.join(root, ".livecheck", "runs", fixture.id ?? RUN_ID);
    yield* realFs.makeDirectory(path.join(runDir, "screenshots"), { recursive: true });
    yield* realFs.writeFileString(
      path.join(runDir, "meta.json"),
      JSON.stringify(
        fixture.meta ?? { runId: fixture.id ?? RUN_ID, slug: "login-flow", startedAt: "x" },
      ),
    );
    yield* realFs.writeFileString(path.join(runDir, "steps.log"), fixture.steps ?? RUNNING_LOG);
    if (fixture.result !== undefined) {
      yield* realFs.writeFileString(
        path.join(runDir, "result.json"),
        typeof fixture.result === "string" ? fixture.result : JSON.stringify(fixture.result),
      );
    }
    const heartbeatAge = fixture.heartbeatAgeMs === undefined ? 10_000 : fixture.heartbeatAgeMs;
    if (heartbeatAge !== null) {
      const heartbeat = path.join(runDir, "heartbeat");
      yield* realFs.writeFileString(heartbeat, "");
      yield* realFs.utimes(heartbeat, NOW / 1000, (NOW - heartbeatAge) / 1000);
    }
    for (const [name, contents] of Object.entries(fixture.screenshots ?? {})) {
      const target = path.join(runDir, "screenshots", name);
      if (typeof contents === "string") yield* realFs.writeFileString(target, contents);
      else yield* realFs.writeFile(target, contents);
    }
    return runDir;
  });

  const resolve = (kind: "livecheck.progress" | "livecheck.result", key: string) =>
    source.resolve({ kind, key }, THREAD).pipe(Effect.provide(services));

  const both = Effect.fnUntraced(function* (key: string) {
    return {
      progress: yield* resolve("livecheck.progress", key),
      result: yield* resolve("livecheck.result", key),
    };
  });

  const asPlaced = (resolved: ResolvedPluginCard, key: string) =>
    ({
      ...resolved,
      id: `${resolved.kind}:${key}`,
      threadId: THREAD,
      placement: { type: "time", at: "2026-11-21T10:00:00.000Z" },
    }) as PluginCard;

  const readAsset = (card: PluginCard, assetId: string) =>
    source.readAsset!(card, assetId).pipe(Effect.provide(services));

  return {
    source,
    services,
    root,
    path,
    realFs,
    watched,
    gitCalls,
    writeRun,
    resolve,
    both,
    asPlaced,
    readAsset,
  };
});

const captureWarnings = () => {
  const warnings: Array<unknown> = [];
  const logger = Logger.make(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(message);
  });
  return { warnings, logger };
};

it.layer(NodeServices.layer)("livecheck source", (it) => {
  it.effect("recognises init-run.sh by its one-line output, as a progress and a result ref", () =>
    Effect.gen(function* () {
      const { source } = yield* setup();
      const runDir = `/repo/.livecheck/runs/${RUN_ID}`;
      const refs = source.recognize(
        command(
          'bash "/home/u/.claude/plugins/cache/cc-plugins/livecheck/0.19.3/scripts/run-dir/init-run.sh" "$PWD" login-flow',
          `${runDir}\n`,
        ),
      );
      expect(refs).toEqual([
        { kind: "livecheck.progress", key: runDir },
        { kind: "livecheck.result", key: runDir },
      ]);
    }),
  );

  it.effect("recognises run paths in the command and output, resolving relative ones", () =>
    Effect.gen(function* () {
      const { source } = yield* setup();
      const keys = (text: string, output: string | null = null, cwd = "/repo") => [
        ...new Set(source.recognize(command(text, output, cwd)).map((ref) => ref.key)),
      ];

      expect(
        keys(`cd /repo && cat .livecheck/runs/${RUN_ID}/result.json`, null, "/elsewhere"),
      ).toEqual([`/repo/.livecheck/runs/${RUN_ID}`]);
      expect(keys(`ls ./.livecheck/runs/${RUN_ID}/screenshots`, null, "/repo/app")).toEqual([
        `/repo/app/.livecheck/runs/${RUN_ID}`,
      ]);
      expect(
        keys(`bash /p/scripts/run-dir/watchdog.sh /abs/.livecheck/runs/${RUN_ID} 360`, null, "/x"),
      ).toEqual([`/abs/.livecheck/runs/${RUN_ID}`]);
      expect(
        keys(
          'bash /p/scripts/run-dir/finalize-run.sh "$RUN_DIR" --status BLOCKED',
          `finalized /abs/.livecheck/runs/${RUN_ID}.\nand again /abs/.livecheck/runs/${RUN_ID}`,
        ),
      ).toEqual([`/abs/.livecheck/runs/${RUN_ID}`]);
      expect(
        keys(`cat /r/.livecheck/runs/${RUN_ID}/a.json /r/.livecheck/runs/20261121-100000-other`),
      ).toEqual([`/r/.livecheck/runs/${RUN_ID}`, "/r/.livecheck/runs/20261121-100000-other"]);
    }),
  );

  it.effect("recognises nothing for commands that do not name a run", () =>
    Effect.gen(function* () {
      const { source } = yield* setup();
      for (const [text, output] of [
        ["ls", `/repo/.livecheck/runs/${RUN_ID}`],
        ["echo scripts/run-dir", null],
        ["ls .livecheck/runs/", "20261121-095800-login-flow\n"],
        [`cat $DIR/.livecheck/runs/${RUN_ID}/result.json`, null],
        [`cat ~/repo/.livecheck/runs/${RUN_ID}/result.json`, null],
        [`cat foo.livecheck/runs/${RUN_ID}`, null],
        ["bash /p/scripts/run-dir/prune-runs.sh /repo", "pruned 0 runs"],
      ] as const) {
        expect(source.recognize(command(text, output)), text).toEqual([]);
      }
    }),
  );

  it.effect("shows a running run as a progress card with its steps, and no result card", () =>
    Effect.gen(function* () {
      const { writeRun, both, watched, path } = yield* setup();
      const runDir = yield* writeRun({ screenshots: { "02-cart.png": "b", "01-login.png": "a" } });
      const { progress, result } = yield* both(runDir);

      expect(result).toBeNull();
      expect(progress).toMatchObject({
        kind: "livecheck.progress",
        data: {
          runId: RUN_ID,
          runDir,
          target: "login-flow",
          steps: [
            { index: 1, label: "open login page", state: "done", durationMs: 30_000 },
            { index: 2, label: "logged in", state: "done", durationMs: 30_000 },
            { index: 3, label: "open cart", state: "running", durationMs: null },
          ],
          currentStep: 3,
          totalSteps: 3,
          heartbeatAt: "2026-11-21T09:59:50.000Z",
          latestAssetId: "02-cart.png",
        },
        actions: [
          {
            id: "stop",
            label: "Stop",
            type: "message",
            message: `Stop live check run ${RUN_ID}.`,
          },
        ],
      });
      expect(watched).toEqual([runDir, path.join(runDir, "screenshots")]);
    }),
  );

  it.effect("shows a run with no steps yet as an empty progress card", () =>
    Effect.gen(function* () {
      const { writeRun, resolve } = yield* setup();
      const runDir = yield* writeRun({ steps: "" });
      expect(yield* resolve("livecheck.progress", runDir)).toMatchObject({
        data: { steps: [], currentStep: null, totalSteps: 0, latestAssetId: null },
      });
    }),
  );

  it.effect.each([
    ["exactly 360 s", 360_000, "running"],
    ["361 s", 361_000, "stale"],
    ["missing", null, "stale"],
  ] as const)("marks the current step by a heartbeat %s old", ([, age, state]) =>
    Effect.gen(function* () {
      const { writeRun, resolve } = yield* setup();
      const runDir = yield* writeRun({ heartbeatAgeMs: age });
      const card = yield* resolve("livecheck.progress", runDir);
      expect(card?.kind === "livecheck.progress" && card.data.steps.map((s) => s.state)).toEqual([
        "done",
        "done",
        state,
      ]);
    }),
  );

  it.effect("signals a change when the heartbeat ages past 360 s, without a file event", () =>
    Effect.gen(function* () {
      const { source, services, writeRun, resolve } = yield* setup();
      const runDir = yield* writeRun({ heartbeatAgeMs: 350_000 });
      const seen = yield* Queue.unbounded<void>();
      yield* Stream.runForEach(source.changes!, () => Queue.offer(seen, undefined)).pipe(
        Effect.provide(services),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* resolve("livecheck.progress", runDir);

      yield* TestClock.adjust("9 seconds");
      expect(yield* Queue.size(seen)).toBe(0);

      yield* TestClock.adjust("2 seconds");
      yield* TestClock.adjust("1 second");
      yield* Queue.take(seen);
      const card = yield* resolve("livecheck.progress", runDir);
      expect(card?.kind === "livecheck.progress" && card.data.steps.at(-1)?.state).toBe("stale");
    }),
  );

  it.effect("keeps a reached run that is still waiting for its verdict as progress", () =>
    Effect.gen(function* () {
      const { writeRun, both } = yield* setup();
      const runDir = yield* writeRun({
        steps: `${RUNNING_LOG}\n2026-11-21T09:59:20Z collected REACHED`,
        result: { ...FAIL_RESULT, verdict: null },
      });
      const { progress, result } = yield* both(runDir);
      expect(progress?.kind).toBe("livecheck.progress");
      expect(result).toBeNull();
    }),
  );

  it.effect("keeps a run whose finalize line leaves the status null as progress", () =>
    Effect.gen(function* () {
      const { writeRun, both } = yield* setup();
      const runDir = yield* writeRun({
        steps: `${RUNNING_LOG}\n2026-11-21T09:59:20Z finalize verdict null->null status null->null`,
      });
      const { progress, result } = yield* both(runDir);
      expect(progress?.kind).toBe("livecheck.progress");
      expect(result).toBeNull();
    }),
  );

  it.effect("replaces the progress card with a failing result card once finalized", () =>
    Effect.gen(function* () {
      const { writeRun, both } = yield* setup();
      const runDir = yield* writeRun({
        steps: FAIL_LOG,
        result: FAIL_RESULT,
        screenshots: SCREENSHOTS,
      });
      const { progress, result } = yield* both(runDir);

      expect(progress).toBeNull();
      expect(result).toMatchObject({
        kind: "livecheck.result",
        data: {
          runId: RUN_ID,
          runDir,
          target: "log in and open the cart",
          verdict: "fail",
          summary: "The cart stayed empty after adding an item.",
          judge: "Judged by codex (gpt-5)",
          steps: [
            { index: 1, label: "login page", state: "done", assetId: "01-login-page.png" },
            { index: 2, label: "add item", state: "done", assetId: "02-add-item.png" },
            { index: 3, label: "cart empty", state: "failed", assetId: "03-cart-empty.png" },
          ],
          failedStepIndex: 3,
          finishedAt: "2026-11-21T09:59:30Z",
        },
        actions: [
          {
            id: "rerun",
            label: "Re-run",
            type: "message",
            message: "Re-run the live check: log in and open the cart",
          },
          {
            id: "fix",
            label: "Fix this",
            type: "message",
            message: `Fix what live check run ${RUN_ID} found.`,
          },
        ],
      });
    }),
  );

  it.effect.each([
    [
      "a failing assert names no screenshot",
      [{ via: "api", expect: "x", outcome: "fail", evidenceRef: "GET /api/cart" }],
    ],
    [
      "only a passing assert names a screenshot",
      [{ via: "s", expect: "x", outcome: "pass", evidenceRef: "screenshots/02-add-item.png" }],
    ],
    ["a failing assert has no evidence", [{ via: "s", expect: "x", outcome: "fail" }]],
  ] as const)("marks no step failed when %s", ([, asserts]) =>
    Effect.gen(function* () {
      const { writeRun, resolve } = yield* setup();
      const runDir = yield* writeRun({
        steps: FAIL_LOG,
        result: { ...FAIL_RESULT, asserts },
        screenshots: SCREENSHOTS,
      });
      const card = yield* resolve("livecheck.result", runDir);
      expect(card?.kind === "livecheck.result" && card.data).toMatchObject({
        failedStepIndex: null,
        steps: [{ state: "done" }, { state: "done" }, { state: "done" }],
      });
    }),
  );

  it.effect("shows a blocked run with its first blocker and without Fix this", () =>
    Effect.gen(function* () {
      const { writeRun, both } = yield* setup();
      const runDir = yield* writeRun({
        steps: `${RUNNING_LOG}\n2026-11-21T09:59:20Z collected BLOCKED app not logged in`,
        result: {
          runId: RUN_ID,
          task: "log in",
          collectionStatus: "BLOCKED",
          verdict: null,
          blockers: ["app not logged in", "feature flag off"],
        },
      });
      const { progress, result } = yield* both(runDir);
      expect(progress).toBeNull();
      expect(result).toMatchObject({
        data: { verdict: "blocked", summary: "app not logged in", judge: null, steps: [] },
        actions: [{ id: "rerun", message: "Re-run the live check: log in" }],
      });
      expect(result?.actions).toHaveLength(1);
    }),
  );

  it.effect.each([
    ["PASS", "REACHED", "pass"],
    [null, "PARTIAL", "blocked"],
    [null, "ERROR", "error"],
  ] as const)("maps verdict %s with collection %s to %s", ([verdict, status, expected]) =>
    Effect.gen(function* () {
      const { writeRun, resolve } = yield* setup();
      const runDir = yield* writeRun({
        steps: `2026-11-21T09:59:30Z finalize verdict null->${verdict} status null->${status}`,
        result: { runId: RUN_ID, task: "t", collectionStatus: status, verdict },
      });
      const card = yield* resolve("livecheck.result", runDir);
      expect(card?.kind === "livecheck.result" && card.data.verdict).toBe(expected);
      expect(card?.actions.map((action) => action.id)).toEqual(["rerun"]);
    }),
  );

  it.effect("draws no result card for a malformed result.json, and warns with its path", () =>
    Effect.gen(function* () {
      const { writeRun, resolve, path } = yield* setup();
      const broken = yield* writeRun({ steps: FAIL_LOG, result: "{ not json" });
      const healthy = yield* writeRun({
        id: "20261121-095900-other",
        steps: FAIL_LOG,
        result: FAIL_RESULT,
      });
      const { warnings, logger } = captureWarnings();

      const brokenCards = yield* Effect.all([
        resolve("livecheck.result", broken),
        resolve("livecheck.progress", broken),
      ]).pipe(Effect.withLogger(logger));
      expect(brokenCards).toEqual([null, null]);
      expect(JSON.stringify(warnings)).toContain(path.join(broken, "result.json"));
      expect((yield* resolve("livecheck.result", healthy))?.kind).toBe("livecheck.result");
    }),
  );

  it.effect("draws no card for a finished run without result.json, or a missing run", () =>
    Effect.gen(function* () {
      const { writeRun, both, root } = yield* setup();
      const runDir = yield* writeRun({ steps: FAIL_LOG });
      expect(yield* both(runDir)).toEqual({ progress: null, result: null });
      expect(yield* both(`${root}/.livecheck/runs/20261121-000000-gone`)).toEqual({
        progress: null,
        result: null,
      });
    }),
  );

  it.effect("finds a run named from a linked worktree in the main checkout", () =>
    Effect.gen(function* () {
      const { writeRun, resolve, gitCalls } = yield* setup({ gitKnowsMainCheckout: true });
      const runDir = yield* writeRun({});

      const card = yield* resolve(
        "livecheck.progress",
        `/worktrees/feature/.livecheck/runs/${RUN_ID}`,
      );
      expect(card?.kind === "livecheck.progress" && card.data.runDir).toBe(runDir);
      expect(gitCalls).toEqual(["/worktrees/feature"]);
    }),
  );

  it.effect("returns a listed screenshot's bytes and media type", () =>
    Effect.gen(function* () {
      const { writeRun, resolve, asPlaced, readAsset } = yield* setup();
      const runDir = yield* writeRun({
        steps: FAIL_LOG,
        result: FAIL_RESULT,
        screenshots: { ...SCREENSHOTS, "04-final.jpg": "jpeg bytes" },
      });
      const card = asPlaced((yield* resolve("livecheck.result", runDir))!, runDir);

      const png = yield* readAsset(card, "03-cart-empty.png");
      expect(png.mediaType).toBe("image/png");
      expect(new TextDecoder().decode(png.bytes)).toBe("third");
      const jpeg = yield* readAsset(card, "04-final.jpg");
      expect(jpeg.mediaType).toBe("image/jpeg");
      expect(new TextDecoder().decode(jpeg.bytes)).toBe("jpeg bytes");
    }),
  );

  it.effect("serves a progress card's latest screenshot and nothing older", () =>
    Effect.gen(function* () {
      const { writeRun, resolve, asPlaced, readAsset } = yield* setup();
      const runDir = yield* writeRun({ screenshots: { "01-a.webp": "a", "02-b.webp": "b" } });
      const card = asPlaced((yield* resolve("livecheck.progress", runDir))!, runDir);

      const latest = yield* readAsset(card, "02-b.webp");
      expect(latest.mediaType).toBe("image/webp");
      expect(new TextDecoder().decode(latest.bytes)).toBe("b");
      const older = yield* readAsset(card, "01-a.webp").pipe(Effect.flip);
      expect(older.reason).toBe("unknown-asset");
    }),
  );

  it.effect("serves a screenshot of exactly 4 MiB and refuses one a byte larger", () =>
    Effect.gen(function* () {
      const { writeRun, resolve, asPlaced, readAsset } = yield* setup();
      const runDir = yield* writeRun({
        steps: FAIL_LOG,
        result: FAIL_RESULT,
        screenshots: {
          "01-fits.png": new Uint8Array(FOUR_MIB),
          "02-too-big.png": new Uint8Array(FOUR_MIB + 1),
        },
      });
      const card = asPlaced((yield* resolve("livecheck.result", runDir))!, runDir);

      expect((yield* readAsset(card, "01-fits.png")).bytes.byteLength).toBe(FOUR_MIB);
      const refused = yield* readAsset(card, "02-too-big.png").pipe(Effect.flip);
      expect(refused.reason).toBe("unknown-asset");
    }),
  );

  it.effect("refuses an asset id that is not a listed screenshot or not a regular file", () =>
    Effect.gen(function* () {
      const { writeRun, resolve, asPlaced, readAsset, realFs, path } = yield* setup();
      const runDir = yield* writeRun({
        steps: FAIL_LOG,
        result: FAIL_RESULT,
        screenshots: SCREENSHOTS,
      });
      yield* realFs.makeDirectory(path.join(runDir, "screenshots", "04-folder.png"));
      const card = asPlaced((yield* resolve("livecheck.result", runDir))!, runDir);
      expect(
        card.kind === "livecheck.result" && card.data.steps.map((step) => step.assetId),
      ).toContain("04-folder.png");

      for (const assetId of [
        "../meta.json",
        "../../result.json",
        "99-not-on-card.png",
        "notes.txt",
        "screenshots/01-login-page.png",
        "",
        "04-folder.png",
      ]) {
        const refused = yield* readAsset(card, assetId).pipe(Effect.flip);
        expect(refused.reason, assetId).toBe("unknown-asset");
      }
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "refuses a listed screenshot that is a symlink out of the run directory",
    () =>
      Effect.gen(function* () {
        const { writeRun, resolve, asPlaced, readAsset, realFs, path, root } = yield* setup();
        const runDir = yield* writeRun({ steps: FAIL_LOG, result: FAIL_RESULT });
        const outside = path.join(root, "secret.png");
        yield* realFs.writeFileString(outside, "secret");
        yield* realFs.symlink(outside, path.join(runDir, "screenshots", "01-leak.png"));
        const card = asPlaced((yield* resolve("livecheck.result", runDir))!, runDir);

        const refused = yield* readAsset(card, "01-leak.png").pipe(Effect.flip);
        expect(refused.reason).toBe("unknown-asset");
      }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "refuses a screenshot reached through a symlinked screenshots directory",
    () =>
      Effect.gen(function* () {
        const { writeRun, resolve, asPlaced, readAsset, realFs, path, root } = yield* setup();
        const runDir = yield* writeRun({ steps: FAIL_LOG, result: FAIL_RESULT });
        const elsewhere = path.join(root, "elsewhere");
        yield* realFs.makeDirectory(elsewhere);
        yield* realFs.writeFileString(path.join(elsewhere, "01-leak.png"), "secret");
        yield* realFs.remove(path.join(runDir, "screenshots"), { recursive: true });
        yield* realFs.symlink(elsewhere, path.join(runDir, "screenshots"));
        const card = asPlaced((yield* resolve("livecheck.result", runDir))!, runDir);

        const refused = yield* readAsset(card, "01-leak.png").pipe(Effect.flip);
        expect(refused.reason).toBe("unknown-asset");
      }),
  );

  it.effect("refuses an asset for a card this source did not produce", () =>
    Effect.gen(function* () {
      const { writeRun, resolve, asPlaced, readAsset } = yield* setup();
      const runDir = yield* writeRun({
        steps: FAIL_LOG,
        result: FAIL_RESULT,
        screenshots: SCREENSHOTS,
      });
      const resolved = (yield* resolve("livecheck.result", runDir))!;
      const forged = asPlaced(resolved, "/somewhere/else");

      const refused = yield* readAsset(forged, "01-login-page.png").pipe(Effect.flip);
      expect(refused.reason).toBe("unknown-asset");
    }),
  );
});
