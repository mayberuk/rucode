import { PluginCardError, type PluginCard, type PluginCardAsset } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import type {
  PluginCardRef,
  PluginCardSource,
  PluginCardSourceFactory,
  RecognizableCommand,
} from "../core/PluginCardSource.ts";
import {
  HEARTBEAT_STALE_MS,
  SCREENSHOT_NAME,
  isFinished,
  readRun,
  toProgressData,
  toResultData,
} from "./livecheckRun.ts";
import { commandSegments, resolvePath } from "./shared/commandText.ts";
import { makeDirectoryWatcher } from "./shared/directoryWatcher.ts";
import { runLocalCommand } from "./shared/runLocal.ts";
import { makeUpdatedAtStamper } from "./shared/updatedAtStamper.ts";

const PROGRESS = "livecheck.progress";
const RESULT = "livecheck.result";
const RUNS_SEGMENT = "/.livecheck/runs/";
const CHANGE_DEBOUNCE = Duration.millis(250);
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
const MAX_REMEMBERED_CHECKOUTS = 128;
const RUN_PATH = /([^\s'"=:;|&<>]*)\.livecheck\/runs\/(\d{8}-\d{6}[A-Za-z0-9._-]*)/g;

const MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

function runDirsIn(text: string, cwd: string, into: Set<string>) {
  for (const match of text.matchAll(RUN_PATH)) {
    const prefix = match[1]!;
    if (prefix !== "" && !prefix.endsWith("/")) continue;
    if (/[$`~(){}]/.test(prefix)) continue;
    const id = match[2]!.replace(/\.+$/, "");
    into.add(resolvePath(cwd, `${prefix}.livecheck/runs/${id}`));
  }
}

const unknownAsset = (detail?: string) =>
  new PluginCardError({ reason: "unknown-asset", ...(detail === undefined ? {} : { detail }) });

export const livecheckSource: PluginCardSourceFactory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const watcher = yield* makeDirectoryWatcher({ debounce: CHANGE_DEBOUNCE });
  const stamp = yield* makeUpdatedAtStamper;
  const located = new Map<string, string>();
  const produced = new Map<string, string>();
  const mainCheckouts = new Map<string, string | null>();

  const recognize = (command: RecognizableCommand): ReadonlyArray<PluginCardRef> => {
    const text = command.command;
    if (!text.includes("scripts/run-dir/") && !text.includes(".livecheck/runs/")) return [];
    const runDirs = new Set<string>();
    let lastCwd = command.cwd;
    for (const segment of commandSegments(text, command.cwd)) {
      for (const word of segment.words) runDirsIn(word, segment.cwd, runDirs);
      lastCwd = segment.cwd;
    }
    if (command.output !== null) runDirsIn(command.output, lastCwd, runDirs);
    return [...runDirs].flatMap((key) => [
      { kind: PROGRESS, key },
      { kind: RESULT, key },
    ]);
  };

  const isDirectory = (path: string) =>
    fs.stat(path).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );

  /** Remembers a failed lookup too, so a run that is missing does not start git on every refresh. */
  const mainCheckoutOf = Effect.fn("PluginCards.livecheck.mainCheckoutOf")(function* (
    checkout: string,
  ) {
    const remembered = mainCheckouts.get(checkout);
    if (remembered !== undefined) return remembered;
    const git = yield* runLocalCommand({
      command: "git",
      args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      cwd: checkout,
    });
    const commonDir = git?.exitCode === 0 ? git.stdout.trim() : "";
    const main = commonDir.startsWith("/") ? resolvePath(commonDir, "..") : null;
    if (mainCheckouts.size >= MAX_REMEMBERED_CHECKOUTS) {
      mainCheckouts.delete(mainCheckouts.keys().next().value!);
    }
    mainCheckouts.set(checkout, main);
    return main;
  });

  /** Runs land in the main checkout, so a path named from a linked worktree is looked up there. */
  const locate = Effect.fn("PluginCards.livecheck.locate")(function* (key: string) {
    const known = located.get(key);
    if (known !== undefined) return known;
    let runDir: string | null = null;
    if (yield* isDirectory(key)) runDir = key;
    else {
      const cut = key.lastIndexOf(RUNS_SEGMENT);
      const checkout = cut > 0 ? key.slice(0, cut) : null;
      const main = checkout === null ? null : yield* mainCheckoutOf(checkout);
      if (main !== null) {
        const candidate = `${main}${key.slice(cut)}`;
        if (candidate !== key && (yield* isDirectory(candidate))) runDir = candidate;
      }
    }
    if (runDir !== null) located.set(key, runDir);
    return runDir;
  });

  const resolve: PluginCardSource["resolve"] = Effect.fn("PluginCards.livecheck.resolve")(
    function* (ref) {
      if (ref.kind !== PROGRESS && ref.kind !== RESULT) return null;
      const runDir = yield* locate(ref.key);
      if (runDir === null) return null;
      yield* watcher.watch(runDir);
      yield* watcher.watch(`${runDir}/screenshots`);
      const run = yield* readRun(runDir);
      if (run === null) return null;
      const finished = isFinished(run.steps, run.result);
      const cardId = `${ref.kind}:${ref.key}`;

      if (ref.kind === PROGRESS) {
        if (finished) return null;
        const now = yield* Clock.currentTimeMillis;
        if (run.heartbeatMtime !== null) {
          const untilStale = run.heartbeatMtime + HEARTBEAT_STALE_MS + 1 - now;
          if (untilStale > 0) yield* watcher.wakeAfter(runDir, Duration.millis(untilStale));
        }
        const data = toProgressData(run, now);
        const actions = [
          {
            id: "stop",
            label: "Stop",
            type: "message",
            message: `Stop live check run ${data.runId}.`,
          },
        ] as const;
        produced.set(cardId, runDir);
        const updatedAt = yield* stamp(cardId, { kind: PROGRESS, actions, data });
        return { kind: PROGRESS, updatedAt, actions, data } as const;
      }

      if (!finished) return null;
      const data = toResultData(run);
      if (data === null) {
        yield* Effect.logWarning("livecheck run finished without a readable result.json", {
          path: runDir,
        });
        return null;
      }
      const actions = [
        {
          id: "rerun",
          label: "Re-run",
          type: "message",
          message: `Re-run the live check: ${data.target}`,
        } as const,
        ...(data.verdict === "fail"
          ? [
              {
                id: "fix",
                label: "Fix this",
                type: "message",
                message: `Fix what live check run ${data.runId} found.`,
              } as const,
            ]
          : []),
      ];
      produced.set(cardId, runDir);
      const updatedAt = yield* stamp(cardId, { kind: RESULT, actions, data });
      return { kind: RESULT, updatedAt, actions, data } as const;
    },
  );

  /** `noFollow` covers only the last path component, so the opened file is checked to sit in the run's own screenshots directory. */
  const readScreenshot = Effect.fn("PluginCards.livecheck.readScreenshot")(function* (
    runDir: string,
    assetId: string,
  ) {
    const platform = yield* HostProcess.Platform;
    const path = `${runDir}/screenshots/${assetId}`;
    const file = yield* fs.open(path, { flag: "r", noFollow: platform !== "win32" });
    const info = yield* file.stat;
    if (info.type !== "File" || info.size > BigInt(MAX_SCREENSHOT_BYTES)) return null;
    const [realRunDir, realPath] = yield* Effect.all([fs.realPath(runDir), fs.realPath(path)]);
    if (realPath !== `${realRunDir}/screenshots/${assetId}`) return null;
    const placed = yield* fs.stat(realPath);
    if (placed.dev !== info.dev || Option.getOrNull(placed.ino) !== Option.getOrNull(info.ino)) {
      return null;
    }
    const bytes = new Uint8Array(Number(info.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = yield* file.read(bytes.subarray(offset));
      if (read === 0) break;
      offset += read;
    }
    return bytes.subarray(0, offset);
  }, Effect.scoped);

  const readAsset = Effect.fn("PluginCards.livecheck.readAsset")(function* (
    card: PluginCard,
    assetId: string,
  ) {
    if (card.kind !== PROGRESS && card.kind !== RESULT) return yield* unknownAsset();
    const runDir = produced.get(card.id);
    if (runDir === undefined || runDir !== card.data.runDir) return yield* unknownAsset();
    const extension = SCREENSHOT_NAME.exec(assetId)?.[1];
    if (extension === undefined) return yield* unknownAsset();
    const listed =
      card.kind === RESULT
        ? card.data.steps.some((step) => step.assetId === assetId)
        : card.data.latestAssetId === assetId;
    if (!listed) return yield* unknownAsset();

    const path = `${runDir}/screenshots/${assetId}`;
    const readFailed = (cause: unknown) =>
      new PluginCardError({ reason: "source-failed", detail: path, cause });
    const fileInfo = yield* fs.lstat(path).pipe(Effect.mapError(readFailed));
    if (fileInfo.type !== "File") {
      return yield* unknownAsset("It is not a regular file in the run directory.");
    }
    if (fileInfo.size > BigInt(MAX_SCREENSHOT_BYTES)) {
      return yield* unknownAsset("It is larger than 4 MiB.");
    }
    const bytes = yield* readScreenshot(runDir, assetId).pipe(Effect.mapError(readFailed));
    if (bytes === null) return yield* unknownAsset("It is not a regular file under 4 MiB.");
    return { mediaType: MEDIA_TYPES[extension]!, bytes } satisfies PluginCardAsset;
  });

  return {
    id: "livecheck",
    recognize,
    resolve,
    changes: watcher.changes,
    readAsset,
  } satisfies PluginCardSource;
});
