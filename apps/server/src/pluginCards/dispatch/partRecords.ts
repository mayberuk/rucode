import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { runLocalJson } from "../sources/shared/runLocal.ts";
import type { DispatchLiveInitiative } from "./liveRegistry.ts";

const decodePairRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ spend_ceiling_usd: Schema.optionalKey(Schema.Unknown) })),
);
const unreadablePairRecords = new Set<string>();

const SpecPhases = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    wave: Schema.String.check(Schema.isPattern(/\S/)).pipe(
      Schema.decodeTo(Schema.FiniteFromString),
    ),
  }),
);

export const partWorktree = Effect.fn("DispatchReader.partWorktree")(function* (input: {
  readonly partId: string;
  readonly registry: DispatchLiveInitiative | null;
  readonly gateRecord: string | null;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const repo of input.registry?.repos ?? []) {
    for (const worktree of repo.worktrees) {
      if (path.basename(worktree) !== input.partId) continue;
      const info = yield* fs.stat(worktree).pipe(Effect.orElseSucceed(() => null));
      if (info?.type === "Directory") return worktree;
    }
  }

  const record = input.gateRecord;
  if (record === null || !path.isAbsolute(record)) return null;
  const filename = path.basename(record);
  const work = path.dirname(record);
  const claude = path.dirname(work);
  if (
    !/^wave-run-\d+\.json$/.test(filename) ||
    !record.endsWith(filename) ||
    path.basename(work) !== "work" ||
    path.basename(claude) !== ".claude"
  ) {
    return null;
  }
  const worktree = path.dirname(claude);
  const info = yield* fs.stat(worktree).pipe(Effect.orElseSucceed(() => null));
  return info?.type === "Directory" ? worktree : null;
});

export const readWorktreeBranch = Effect.fn("DispatchReader.readWorktreeBranch")(
  function* (worktree: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dotGit = path.join(worktree, ".git");
    const info = yield* fs.stat(dotGit);
    let gitDirectory = dotGit;
    if (info.type === "File") {
      const link = yield* fs.readFileString(dotGit);
      const target = /^gitdir: ([^\r\n]+)(?:\r?\n)?$/.exec(link)?.[1];
      if (target === undefined) return null;
      gitDirectory = path.resolve(worktree, target);
    } else if (info.type !== "Directory") {
      return null;
    }
    const head = yield* fs.readFileString(path.join(gitDirectory, "HEAD"));
    return /^ref: refs\/heads\/([^\r\n]+)(?:\r?\n)?$/.exec(head)?.[1] ?? null;
  },
  Effect.orElseSucceed(() => null),
);

export const readSpendCeiling = Effect.fn("DispatchReader.readSpendCeiling")(function* (
  initiativesRoot: string,
  slug: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(initiativesRoot, ".pairs", slug, "record.json");
  const record = yield* fs.readFileString(file).pipe(
    Effect.map(decodePairRecord),
    Effect.catch((error) =>
      Effect.succeed(error.reason._tag === "NotFound" ? null : Option.none()),
    ),
  );
  if (record === null) return null;
  if (Option.isNone(record)) {
    if (!unreadablePairRecords.has(file)) {
      unreadablePairRecords.add(file);
      yield* Effect.logWarning("dispatch pair record is unreadable", { path: file });
    }
    return null;
  }
  const ceiling = record.value.spend_ceiling_usd;
  return typeof ceiling === "number" && Number.isFinite(ceiling) && ceiling > 0 ? ceiling : null;
});

export const readSpecPhases = Effect.fn("DispatchReader.readSpecPhases")(function* (
  worktree: string,
  partId: string,
  spec: string | null,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const specPath = spec ?? path.join(worktree, ".claude", "plans", `${partId}.md`);
  if (specPath === "") return null;
  if (spec === null) {
    const info = yield* fs.stat(specPath).pipe(Effect.orElseSucceed(() => null));
    if (info?.type !== "File") return null;
  }
  return yield* runLocalJson(SpecPhases, {
    command: "dp",
    args: ["spec", "phases", specPath, "--json"],
    cwd: worktree,
  });
});
