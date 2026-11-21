import type { GittyConflictCardData, GittyPushCardData } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type {
  PluginCardRef,
  PluginCardSource,
  PluginCardSourceFactory,
  RecognizableCommand,
} from "../core/PluginCardSource.ts";
import {
  commandSegments,
  flagValue,
  invokes,
  resolvePath,
  type CommandSegment,
} from "./shared/commandText.ts";
import { makeDirectoryWatcher } from "./shared/directoryWatcher.ts";
import { runLocalCommand } from "./shared/runLocal.ts";
import { makeUpdatedAtStamper } from "./shared/updatedAtStamper.ts";

const PUSH = "gitty.push";
const CONFLICT = "gitty.conflict";
const CHANGE_DEBOUNCE = Duration.millis(500);
const PUSH_SCRIPTS = [
  "scripts/push-state.sh",
  "scripts/push-enumerate.sh",
  "scripts/push-commit.sh",
] as const;
const GIT_DIR_FILES = new Set([
  "HEAD",
  "ORIG_HEAD",
  "REBASE_HEAD",
  "MERGE_HEAD",
  "COMMIT_EDITMSG",
  "packed-refs",
  "index",
]);
const CONFLICT_LINE = /^CONFLICT \([^)]*\): Merge conflict in (.+)$/gm;
const FIELD_SEPARATOR = "\u001f";
const SHA = /^[0-9a-f]{7,64}$/;

const ScriptOutput = Schema.Struct({
  featureBranch: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  conflicts: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});
const decodeScriptOutput = Schema.decodeUnknownOption(Schema.fromJsonString(ScriptOutput));

const PushState = Schema.Struct({
  baseBranch: Schema.optionalKey(Schema.NullOr(Schema.String)),
  featureBranch: Schema.optionalKey(Schema.NullOr(Schema.String)),
  mrUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodePushState = Schema.decodeUnknownOption(Schema.fromJsonString(PushState));

/** Branch names and file paths may contain `#`, the checkout path rarely does. */
const splitKey = (key: string): readonly [string, string] | null => {
  const cut = key.indexOf("#");
  return cut <= 0 ? null : [key.slice(0, cut), key.slice(cut + 1)];
};

/** A value from a command's output or a state file is never allowed to read as a git option. */
const isSafeRef = (value: string) =>
  value !== "" && !value.startsWith("-") && !/[\s\0]/.test(value);

const lines = (text: string) => text.split("\n").filter((line) => line !== "");

const scriptOutput = (output: string | null) => {
  if (output === null) return null;
  const text = output.trim();
  const direct = decodeScriptOutput(text);
  if (Option.isSome(direct)) return direct.value;
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open < 0 || close <= open) return null;
  const embedded = decodeScriptOutput(text.slice(open, close + 1));
  return Option.isSome(embedded) ? embedded.value : null;
};

/** `git -C <dir>` names the checkout a CONFLICT line came from. */
const conflictCheckout = (segments: ReadonlyArray<CommandSegment>, fallback: string) => {
  let checkout = fallback;
  for (const segment of segments) {
    if (!invokes(segment.words, "git")) continue;
    const dir = flagValue(segment.words, "-C");
    if (dir !== null && !/[$`~]/.test(dir)) checkout = resolvePath(segment.cwd, dir);
  }
  return checkout;
};

const parseShortstat = (text: string) => ({
  additions: Number(/(\d+) insertions?\(\+\)/.exec(text)?.[1] ?? 0),
  deletions: Number(/(\d+) deletions?\(-\)/.exec(text)?.[1] ?? 0),
});

const mergeRequestNumber = (url: string) => {
  const found = /\/(?:pull|merge_requests)\/(\d+)/.exec(url)?.[1];
  return found === undefined ? null : Number(found);
};

const lowerFirst = (label: string) => `${label.slice(0, 1).toLowerCase()}${label.slice(1)}`;

export const gittySource: PluginCardSourceFactory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const stateDirs = new Set<string>();
  const watcher = yield* makeDirectoryWatcher({
    debounce: CHANGE_DEBOUNCE,
    accept: (dir, fileName) => stateDirs.has(dir) || GIT_DIR_FILES.has(fileName),
  });
  const stamp = yield* makeUpdatedAtStamper;

  const recognize = (command: RecognizableCommand): ReadonlyArray<PluginCardRef> => {
    const refs = new Map<string, PluginCardRef>();
    const add = (kind: typeof PUSH | typeof CONFLICT, cwd: string, name: string) => {
      if (name === "" || cwd === "" || (kind === PUSH && !isSafeRef(name))) return;
      refs.set(`${kind}\0${cwd}#${name}`, { kind, key: `${cwd}#${name}` });
    };

    const hasConflictLine = command.output !== null && command.output.includes("CONFLICT (");
    const mayRunScript = PUSH_SCRIPTS.some((script) => command.command.includes(script));
    if (!hasConflictLine && !mayRunScript) return [];
    const segments = commandSegments(command.command, command.cwd);

    if (mayRunScript) {
      const parsed = scriptOutput(command.output);
      for (const segment of segments) {
        if (parsed === null) break;
        const script = PUSH_SCRIPTS.find((candidate) => invokes(segment.words, candidate));
        if (script === undefined) continue;
        const branch = parsed.featureBranch ?? parsed.branch;
        if (branch !== undefined) add(PUSH, segment.cwd, branch);
        if (script === "scripts/push-commit.sh" && parsed.status === "conflict") {
          for (const file of parsed.conflicts ?? []) {
            if (typeof file === "string") add(CONFLICT, segment.cwd, file);
          }
        }
      }
    }

    if (hasConflictLine) {
      const checkout = conflictCheckout(segments, segments.at(-1)?.cwd ?? command.cwd);
      for (const match of command.output!.matchAll(CONFLICT_LINE)) {
        add(CONFLICT, checkout, match[1]!);
      }
    }
    return [...refs.values()];
  };

  const git = (dir: string, args: ReadonlyArray<string>) =>
    runLocalCommand({
      command: "git",
      args: ["-C", dir, "--no-optional-locks", ...args],
      cwd: dir,
    });

  const gitText = Effect.fn("PluginCards.gitty.gitText")(function* (
    dir: string,
    args: ReadonlyArray<string>,
  ) {
    const result = yield* git(dir, args);
    return result !== null && result.exitCode === 0 ? result.stdout : null;
  });

  const locate = Effect.fn("PluginCards.gitty.locate")(function* (dir: string) {
    const text = yield* gitText(dir, [
      "rev-parse",
      "--show-toplevel",
      "--git-dir",
      "--abbrev-ref",
      "HEAD",
    ]);
    const [toplevel, gitDir, head] = text === null ? [] : lines(text);
    if (toplevel === undefined || gitDir === undefined) return null;
    const root = resolvePath(dir, toplevel);
    stateDirs.add(`${root}/.claude/gitty-state`);
    yield* watcher.watch(`${root}/.claude/gitty-state`);
    const resolvedGitDir = resolvePath(dir, gitDir);
    yield* watcher.watch(resolvedGitDir);
    return { root, gitDir: resolvedGitDir, head: head ?? null };
  });

  const readPushState = Effect.fn("PluginCards.gitty.readPushState")(function* (root: string) {
    const path = `${root}/.claude/gitty-state/push-in-progress.json`;
    const text = yield* fs.readFileString(path).pipe(Effect.option);
    if (Option.isNone(text)) return null;
    const state = decodePushState(text.value);
    if (Option.isNone(state)) {
      yield* Effect.logWarning("gitty push state could not be read", { path });
      return null;
    }
    return state.value;
  });

  const resolvePush = Effect.fn("PluginCards.gitty.resolvePush")(function* (
    key: string,
    cwd: string,
    branch: string,
  ) {
    if (!isSafeRef(branch)) return null;
    const checkout = yield* locate(cwd);
    if (checkout === null) return null;
    const state = yield* readPushState(checkout.root);
    const forThisBranch = state !== null && state.featureBranch === branch ? state : null;

    let base = forThisBranch?.baseBranch ?? null;
    if (base === null || base === "") {
      const head = yield* gitText(checkout.root, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
      const name = head?.trim().replace(/^origin\//, "");
      base = name === undefined || name === "HEAD" || name === "" ? null : name;
    }
    if (base === null || !isSafeRef(base)) return null;

    const remoteBase = yield* git(checkout.root, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${base}`,
    ]);
    const baseRef = remoteBase?.exitCode === 0 ? `origin/${base}` : base;
    const mergeBase = (yield* gitText(checkout.root, ["merge-base", baseRef, branch]))?.trim();
    if (mergeBase === undefined || mergeBase === "") return null;

    const range = `${mergeBase}..${branch}`;
    const [log, ahead] = yield* Effect.all(
      [
        gitText(checkout.root, ["log", "--reverse", `--format=%H%x1f%s`, range]),
        gitText(checkout.root, ["rev-list", `${branch}@{upstream}..${branch}`]),
      ],
      { concurrency: 2 },
    );
    if (log === null) return null;
    const unpushed = ahead === null ? null : new Set(lines(ahead));

    const batches: Array<GittyPushCardData["batches"][number]> = lines(log).map((line) => {
      const [sha = "", ...subject] = line.split(FIELD_SEPARATOR);
      return {
        label: subject.join(FIELD_SEPARATOR),
        state: unpushed === null || unpushed.has(sha) ? "pending" : "done",
        commit: sha,
      };
    });

    let uncommitted = 0;
    if (checkout.head === branch) {
      const status = yield* gitText(checkout.root, ["status", "--porcelain"]);
      uncommitted = status === null ? 0 : lines(status).length;
      if (uncommitted > 0) {
        batches.push({
          label: `${uncommitted} uncommitted ${uncommitted === 1 ? "file" : "files"}`,
          state: "pending",
          commit: null,
        });
      }
    }

    let mergeRequest: GittyPushCardData["mergeRequest"] = null;
    const url = forThisBranch?.mrUrl;
    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      const stat = yield* gitText(checkout.root, ["diff", "--shortstat", range]);
      const counts = stat === null ? null : parseShortstat(stat);
      mergeRequest = {
        url,
        number: mergeRequestNumber(url),
        draft: true,
        additions: counts?.additions ?? null,
        deletions: counts?.deletions ?? null,
        pipeline: "none",
      };
    }

    const data: GittyPushCardData = { branch, batches, mergeRequest };
    const actions = batches.some((batch) => batch.state === "running" || batch.state === "pending")
      ? ([
          {
            id: "push-next",
            label: "Push next batch",
            type: "message",
            message: "Push the next batch.",
          },
        ] as const)
      : [];
    const updatedAt = yield* stamp(`${PUSH}:${key}`, { kind: PUSH, actions, data });
    return { kind: PUSH, updatedAt, actions, data } as const;
  });

  const subject = Effect.fn("PluginCards.gitty.subject")(function* (
    root: string,
    revision: string,
    file: string | null,
  ) {
    const text = yield* gitText(root, [
      "log",
      "-1",
      "--format=%s",
      revision,
      ...(file === null ? [] : ["--", file]),
    ]);
    return text === null ? null : text.trim();
  });

  const readSha = (path: string) =>
    fs.readFileString(path).pipe(
      Effect.map((text) => text.trim()),
      Effect.orElseSucceed(() => ""),
    );

  const resolveConflict = Effect.fn("PluginCards.gitty.resolveConflict")(function* (
    key: string,
    cwd: string,
    file: string,
  ) {
    const checkout = yield* locate(cwd);
    if (checkout === null) return null;
    const unmerged = yield* gitText(checkout.root, [
      "diff",
      "--name-only",
      "-z",
      "--diff-filter=U",
    ]);
    if (unmerged === null || !unmerged.split("\0").includes(file)) return null;

    let theirSha = yield* readSha(`${checkout.gitDir}/rebase-merge/onto`);
    if (!SHA.test(theirSha)) theirSha = yield* readSha(`${checkout.gitDir}/MERGE_HEAD`);
    const theirs = SHA.test(theirSha) ? theirSha : null;

    let base: string | null = null;
    if (theirs !== null) {
      const named = (yield* gitText(checkout.root, ["name-rev", "--name-only", theirs]))?.trim();
      if (named !== undefined && named !== "" && named !== "undefined") {
        base = named.replace(/^remotes\//, "");
      }
    }

    const yours =
      (yield* subject(checkout.root, "REBASE_HEAD", null)) ??
      (yield* subject(checkout.root, "HEAD", null));
    const theirSubject = theirs === null ? null : yield* subject(checkout.root, theirs, file);

    const theirLabel = base ?? "Theirs";
    const resolutions: GittyConflictCardData["resolutions"] = [
      {
        key: "both",
        label: "Keep both changes",
        predictedOutcome: "Both changes stay. The overlapping lines need a manual merge.",
      },
      {
        key: "yours",
        label: "Keep yours",
        predictedOutcome:
          base === null
            ? "Their change to this file is dropped."
            : `The change on ${base} is dropped.`,
      },
      {
        key: "theirs",
        label: `Take ${base ?? "theirs"}`,
        predictedOutcome: "Your change to this file is dropped.",
      },
    ];
    const data: GittyConflictCardData = {
      file,
      base,
      sides: [
        { label: "You", summary: yours ?? "" },
        { label: theirLabel, summary: theirSubject ?? "" },
      ],
      resolutions,
    };
    const actions = resolutions.map((resolution) => ({
      id: `use:${resolution.key}`,
      label: "Use this",
      type: "message" as const,
      message: `Resolve the conflict in ${file}: ${lowerFirst(resolution.label)}.`,
    }));
    const updatedAt = yield* stamp(`${CONFLICT}:${key}`, { kind: CONFLICT, actions, data });
    return { kind: CONFLICT, updatedAt, actions, data } as const;
  });

  const resolve: PluginCardSource["resolve"] = Effect.fn("PluginCards.gitty.resolve")(
    function* (ref) {
      const parts = splitKey(ref.key);
      if (parts === null) return null;
      if (ref.kind === PUSH) return yield* resolvePush(ref.key, parts[0], parts[1]);
      if (ref.kind === CONFLICT) return yield* resolveConflict(ref.key, parts[0], parts[1]);
      return null;
    },
  );

  return { id: "gitty", recognize, resolve, changes: watcher.changes } satisfies PluginCardSource;
});
