import type { DispatchVerifyCardData } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type {
  PluginCardRef,
  PluginCardSource,
  PluginCardSourceFactory,
  RecognizableCommand,
} from "../core/PluginCardSource.ts";
import {
  DispatchLiveSnapshot,
  DispatchVerifyEvidence,
  GateAttemptRow,
  findPart,
  toRunProgressData,
  toVerifyChecks,
} from "./dispatchWaveSnapshot.ts";
import {
  type CommandSegment,
  commandSegments,
  flagValue,
  invokes,
  positionals,
  resolvePath,
} from "./shared/commandText.ts";
import { makeDirectoryWatcher } from "./shared/directoryWatcher.ts";
import { runLocalCommand, runLocalJson } from "./shared/runLocal.ts";
import { makeUpdatedAtStamper } from "./shared/updatedAtStamper.ts";

const RUN_KIND = "dispatch.runProgress";
const VERIFY_KIND = "dispatch.verify";
const CHANGE_DEBOUNCE = Duration.seconds(1);
const DP_TIMEOUT = Duration.seconds(15);
const WAVE_VERBS = new Set(["run", "gate", "wait", "settle", "status"]);
const VERIFY_VERBS = new Set(["evidence", "ears"]);
const LAUNCH_LINE = /^dp: wave (\d+) (run|gate) launched \(pid \d+\)/gm;
const WAVE_NUMBER = /^[1-9]\d*$/;
/**
 * Telemetry and events.jsonl are left out on purpose: they change several times a second during a
 * run. The `.gate` marker holds the gate's current check, so a running gate's rows can move.
 */
const WATCHED_FILE = /^(wave-run-\d+\.json(\.gate)?|gate-attempts\.jsonl|VERIFIED\.jsonl)$/;
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--spec",
  "--part",
  "--part-kind",
  "--part-env",
  "--initiative",
  "--request",
  "--dir",
  "--agent",
  "--review-agent",
  "--adversary-agent",
  "--engine",
  "--model",
  "--model-reason",
  "--deadline-seconds",
  "--stall-seconds",
  "--gate-command",
  "--env-file",
  "--rerun",
  "--reason",
  "--rerun-reason",
  "--allow-wide-selection",
  "--leg",
  "--since",
  "--timeout-seconds",
  "--start-grace-seconds",
  "--phase",
  "--allow-path",
  "--waive",
  "--cause",
  "--window-min",
  "--phase-status",
]);

const decodeAttempt = Schema.decodeUnknownOption(Schema.fromJsonString(GateAttemptRow));

const unresolvable = (word: string) => word.startsWith("~") || /[$`]/.test(word);

const targetOf = (segment: CommandSegment, wave: string) => {
  const dirFlag = flagValue(segment.words, "--dir");
  if (dirFlag !== null && unresolvable(dirFlag)) return null;
  const part = flagValue(segment.words, "--part") ?? `wave-${wave}`;
  if (unresolvable(part)) return null;
  return { dir: dirFlag === null ? segment.cwd : resolvePath(segment.cwd, dirFlag), part };
};

const waveCommand = (words: ReadonlyArray<string>) => {
  if (!invokes(words, "dp") || words[1] !== "wave") return null;
  const verb = words[2];
  if (verb === undefined || !WAVE_VERBS.has(verb)) return null;
  const wave = positionals(words.slice(2), VALUE_FLAGS)[0];
  return wave !== undefined && WAVE_NUMBER.test(wave) ? { verb, wave } : null;
};

const runRef = (dir: string, part: string, wave: string): PluginCardRef => ({
  kind: RUN_KIND,
  key: `${dir}#${part}#${wave}`,
});
const verifyRef = (dir: string, part: string): PluginCardRef => ({
  kind: VERIFY_KIND,
  key: `${dir}#${part}`,
});

const refsForSegment = (segment: CommandSegment): ReadonlyArray<PluginCardRef> => {
  const words = segment.words;
  const wave = waveCommand(words);
  if (wave !== null) {
    const target = targetOf(segment, wave.wave);
    if (target === null) return [];
    const leg = wave.verb === "wait" ? (flagValue(words, "--leg") ?? "run") : null;
    if (wave.verb === "run" || wave.verb === "status" || leg === "run") {
      return [runRef(target.dir, target.part, wave.wave)];
    }
    if (wave.verb === "gate" || wave.verb === "settle" || leg === "gate") {
      return [verifyRef(target.dir, target.part)];
    }
    return [];
  }
  if (invokes(words, "dp") && words[1] === "verify" && VERIFY_VERBS.has(words[2] ?? "")) {
    const part = flagValue(words, "--part");
    if (part === null || positionals(words.slice(2), VALUE_FLAGS)[0] === undefined) return [];
    const target = targetOf(segment, "");
    return target === null ? [] : [verifyRef(target.dir, part)];
  }
  return [];
};

/** Splits from the right, so a checkout path that holds `#` still parses. */
const parseKey = (key: string, withWave: boolean) => {
  let rest = key;
  let wave: number | null = null;
  if (withWave) {
    const cut = rest.lastIndexOf("#");
    if (cut <= 0) return null;
    const text = rest.slice(cut + 1);
    if (!WAVE_NUMBER.test(text)) return null;
    wave = Number(text);
    rest = rest.slice(0, cut);
  }
  const cut = rest.lastIndexOf("#");
  if (cut <= 0 || cut === rest.length - 1) return null;
  return { dir: rest.slice(0, cut), part: rest.slice(cut + 1), wave };
};

const taskOf = (specPath: string, fallback: string) => {
  const name = specPath.slice(specPath.lastIndexOf("/") + 1).replace(/\.md$/, "");
  return name === "" ? fallback : name;
};

export const dispatchWaveSource: PluginCardSourceFactory = Effect.gen(function* () {
  const path = yield* Path.Path;
  const watcher = yield* makeDirectoryWatcher({
    debounce: CHANGE_DEBOUNCE,
    accept: (_dir, fileName) => WATCHED_FILE.test(fileName),
  });
  const stamp = yield* makeUpdatedAtStamper;

  const recognize = (command: RecognizableCommand): ReadonlyArray<PluginCardRef> => {
    const refs = new Map<string, PluginCardRef>();
    const add = (ref: PluginCardRef) => refs.set(`${ref.kind} ${ref.key}`, ref);
    const segments = commandSegments(command.command, command.cwd);
    for (const segment of segments) refsForSegment(segment).forEach(add);

    if (command.output !== null) {
      for (const match of command.output.matchAll(LAUNCH_LINE)) {
        const wave = match[1]!;
        const segment =
          segments.find((candidate) => waveCommand(candidate.words)?.wave === wave) ??
          segments.find((candidate) => invokes(candidate.words, "dp")) ??
          ({ words: [], cwd: command.cwd } satisfies CommandSegment);
        const target = targetOf(segment, wave);
        if (target === null) continue;
        add(
          match[2] === "run"
            ? runRef(target.dir, target.part, wave)
            : verifyRef(target.dir, target.part),
        );
      }
    }
    return [...refs.values()];
  };

  const readSnapshot = Effect.fn("PluginCards.dispatchWave.readSnapshot")(function* (dir: string) {
    yield* watcher.watch(path.join(dir, ".claude", "work"));
    const snapshot = yield* runLocalJson(DispatchLiveSnapshot, {
      command: "dp",
      args: ["wave", "live", "--dir", dir, "--json"],
      cwd: dir,
      timeout: DP_TIMEOUT,
    });
    if (snapshot === null) yield* Effect.logWarning("dispatch wave record unreadable", { dir });
    return snapshot;
  });

  const readGateRevision = Effect.fn("PluginCards.dispatchWave.readGateRevision")(function* (
    dir: string,
    part: string,
    wave: number,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const file = path.join(dir, ".claude", "work", "gate-attempts.jsonl");
    const text = yield* fs.readFileString(file).pipe(Effect.option);
    if (Option.isNone(text)) return null;
    let revision: string | null = null;
    for (const line of text.value.split("\n")) {
      const row = decodeAttempt(line);
      if (Option.isSome(row) && row.value.part === part && row.value.wave === wave) {
        revision = row.value.revision;
      }
    }
    return revision;
  });

  const readHead = Effect.fn("PluginCards.dispatchWave.readHead")(function* (dir: string) {
    const result = yield* runLocalCommand({
      command: "git",
      args: ["rev-parse", "HEAD"],
      cwd: dir,
    });
    const head = result?.exitCode === 0 ? result.stdout.trim() : "";
    return head === "" ? null : head;
  });

  const resolveRun = Effect.fn("PluginCards.dispatchWave.resolveRun")(function* (key: string) {
    const target = parseKey(key, true);
    if (target === null || target.wave === null) return null;
    const snapshot = yield* readSnapshot(target.dir);
    if (snapshot === null) return null;
    const data = toRunProgressData(snapshot, target.part, target.wave, target.dir);
    if (data === null) return null;
    const updatedAt = yield* stamp(`${RUN_KIND}:${key}`, data);
    return { kind: RUN_KIND, updatedAt, actions: [], data } as const;
  });

  const resolveVerify = Effect.fn("PluginCards.dispatchWave.resolveVerify")(function* (
    key: string,
  ) {
    const target = parseKey(key, false);
    if (target === null) return null;
    const snapshot = yield* readSnapshot(target.dir);
    if (snapshot === null) return null;
    const entry = findPart(snapshot, target.part, null);
    if (entry === null) return null;
    const specPath = entry.spec === undefined ? "" : resolvePath(target.dir, entry.spec);

    const [gateRevision, head, evidence] = yield* Effect.all(
      [
        readGateRevision(target.dir, target.part, entry.wave),
        readHead(target.dir),
        specPath === ""
          ? Effect.succeed(null)
          : runLocalJson(DispatchVerifyEvidence, {
              command: "dp",
              args: ["verify", "evidence", specPath],
              cwd: target.dir,
              timeout: DP_TIMEOUT,
            }),
      ],
      { concurrency: 3 },
    );
    const task = taskOf(specPath, target.part);
    const data: DispatchVerifyCardData = {
      task,
      specPath,
      dir: target.dir,
      revision: gateRevision,
      checks: toVerifyChecks(entry, head, gateRevision, evidence),
    };
    const actions = [
      {
        id: "rerun",
        label: "Re-run",
        type: "message",
        message: `Re-run verification for ${task}.`,
      },
    ] as const;
    const updatedAt = yield* stamp(`${VERIFY_KIND}:${key}`, { actions, data });
    return { kind: VERIFY_KIND, updatedAt, actions, data } as const;
  });

  const resolve: PluginCardSource["resolve"] = (ref) =>
    ref.kind === RUN_KIND
      ? resolveRun(ref.key)
      : ref.kind === VERIFY_KIND
        ? resolveVerify(ref.key)
        : Effect.succeed(null);

  return {
    id: "dispatch-wave",
    recognize,
    resolve,
    changes: watcher.changes,
  } satisfies PluginCardSource;
});
