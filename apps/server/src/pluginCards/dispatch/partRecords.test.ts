import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../../processRunner.ts";
import type { DispatchLiveInitiative } from "./liveRegistry.ts";
import {
  partWorktree,
  readSpecPhases,
  readSpendCeiling,
  readWorktreeBranch,
} from "./partRecords.ts";

const partId = "part-a";

const files = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dispatch-part-records-" });
  const worktree = path.join(root, partId);
  const record = path.join(root, ".pairs", "alpha", "record.json");
  const plan = path.join(worktree, ".claude", "plans", "part-a.md");
  const write = Effect.fn("PartRecordsTest.write")(function* (file: string, content: string) {
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, content);
  });
  return { fs, path, root, worktree, record, plan, write };
});

const registry = (repos: DispatchLiveInitiative["repos"]): DispatchLiveInitiative => ({
  slug: "alpha",
  closed: false,
  totalWave: 1,
  totalRunning: 0,
  totalSettled: 0,
  totalCostUsd: 0,
  reportedCostUsd: 0,
  started: "2026-11-21T10:00:00Z",
  touched: "2026-11-21T10:00:00Z",
  liveUntil: "2026-11-21T11:00:00Z",
  ...(repos === undefined ? {} : { repos }),
});

const phaseOutput = JSON.stringify([
  { id: "phase-b", name: "Read records", wave: "2", tier: "standard" },
  { id: "phase-a", name: "Find worktrees", wave: "0" },
  { id: "phase-c", name: "Read phases", wave: "12" },
]);

const expectedPhases = [
  { id: "phase-b", name: "Read records", wave: 2 },
  { id: "phase-a", name: "Find worktrees", wave: 0 },
  { id: "phase-c", name: "Read phases", wave: 12 },
];

const processOutput = (stdout: string, code: number): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

it.layer(NodeServices.layer)("dispatch part records", (it) => {
  it.effect(
    "uses the first existing exact basename match across registry repos before the gate",
    () =>
      Effect.gen(function* () {
        const { fs, path, root, worktree, write } = yield* files;
        const firstRepo = path.join(root, "repo-a");
        const otherRepo = path.join(root, "repo-b");
        const missing = path.join(firstRepo, "missing", partId);
        const sameNameFile = path.join(firstRepo, "files", partId);
        const partial = path.join(firstRepo, "other-part-a");
        const firstMatch = path.join(otherRepo, "first", partId);
        const lastMatch = path.join(otherRepo, "last", partId);
        yield* write(sameNameFile, "");
        for (const directory of [partial, firstMatch, lastMatch, worktree]) {
          yield* fs.makeDirectory(directory, { recursive: true });
        }
        const repos = registry([
          { root: firstRepo, worktrees: [partial, missing, sameNameFile] },
          { root: otherRepo, worktrees: [firstMatch, lastMatch] },
        ]);
        const gateRecord = path.join(worktree, ".claude", "work", "wave-run-1.json");
        assert.strictEqual(
          yield* partWorktree({ partId, registry: repos, gateRecord }),
          firstMatch,
        );
        assert.strictEqual(
          yield* partWorktree({ partId, registry: repos, gateRecord: null }),
          firstMatch,
        );
      }),
  );

  it.effect.each(["no registry", "no repos", "a stale registry"] as const)(
    "derives the gate worktree when there is %s and the record is missing",
    (kind) =>
      Effect.gen(function* () {
        const { fs, path, root } = yield* files;
        const checkout = path.join(root, "checkout-a");
        yield* fs.makeDirectory(checkout);
        const entry =
          kind === "no registry"
            ? null
            : registry(
                kind === "no repos" ? undefined : [{ root, worktrees: [path.join(root, partId)] }],
              );
        assert.strictEqual(
          yield* partWorktree({
            partId,
            registry: entry,
            gateRecord: path.join(checkout, ".claude", "work", "wave-run-12.json"),
          }),
          checkout,
        );
      }),
  );

  it.effect.each([
    ["a gone worktree", null, ".claude/work/wave-run-1.json"],
    ["a file in place of a worktree", "file", ".claude/work/wave-run-1.json"],
    ["an absent gate record", "directory", null],
    ["an empty gate record", "directory", ""],
    ["a relative path", "directory", "relative"],
    ["a gate for a different directory", "directory", ".claude/other/wave-run-1.json"],
    ["a gate outside .claude", "directory", "elsewhere/work/wave-run-1.json"],
    ["a non-numeric run id", "directory", ".claude/work/wave-run-alpha.json"],
    ["a gate sidecar", "directory", ".claude/work/wave-run-1.json.gate"],
    ["a directory suffix", "directory", ".claude/work/wave-run-1.json/"],
  ] as const)("returns no worktree for %s", ([, checkout, suffix]) =>
    Effect.gen(function* () {
      const { fs, path, worktree, write } = yield* files;
      if (checkout === "file") yield* write(worktree, "");
      if (checkout === "directory") yield* fs.makeDirectory(worktree);
      const gateRecord =
        suffix === "relative"
          ? path.relative(".", path.join(worktree, ".claude", "work", "wave-run-1.json"))
          : suffix
            ? `${worktree}${path.sep}${suffix}`
            : suffix;
      assert.strictEqual(yield* partWorktree({ partId, registry: null, gateRecord }), null);
    }),
  );

  it.effect.each(["relative", "absolute"] as const)("reads HEAD from a %s gitdir link", (kind) =>
    Effect.gen(function* () {
      const { path, root, worktree, write } = yield* files;
      const gitdir = path.join(root, "repo a", ".git", "worktrees", partId);
      const pointer = kind === "relative" ? path.relative(worktree, gitdir) : gitdir;
      yield* write(path.join(worktree, ".git"), `gitdir: ${pointer}\n`);
      yield* write(path.join(gitdir, "HEAD"), "ref: refs/heads/topic/alpha\n");
      assert.strictEqual(yield* readWorktreeBranch(worktree), "topic/alpha");
    }),
  );

  it.effect("reads HEAD from a plain .git directory", () =>
    Effect.gen(function* () {
      const { path, worktree, write } = yield* files;
      yield* write(path.join(worktree, ".git", "HEAD"), "ref: refs/heads/topic/beta\r\n");
      assert.strictEqual(yield* readWorktreeBranch(worktree), "topic/beta");
    }),
  );

  it.effect.each([
    ["missing .git", null, null],
    ["missing HEAD in a directory", "directory", null],
    ["missing linked HEAD", "gitdir: ../missing\n", null],
    ["a malformed gitdir", "../linked\n", "ref: refs/heads/alpha\n"],
    ["an empty gitdir", "gitdir: \n", "ref: refs/heads/alpha\n"],
    ["detached HEAD", "directory", "0123456789012345678901234567890123456789\n"],
    ["a tag ref", "directory", "ref: refs/tags/alpha\n"],
    ["an empty branch name", "directory", "ref: refs/heads/\n"],
    ["a malformed HEAD", "directory", "junk ref: refs/heads/alpha\n"],
    ["an empty HEAD", "directory", ""],
  ] as const)("returns no branch for %s", ([, git, head]) =>
    Effect.gen(function* () {
      const { fs, path, root, worktree, write } = yield* files;
      const dotGit = path.join(worktree, ".git");
      if (git === "directory") yield* fs.makeDirectory(dotGit, { recursive: true });
      else if (git !== null) yield* write(dotGit, git);
      if (head !== null) {
        const headDirectory =
          git === "directory"
            ? dotGit
            : git === "gitdir: \n"
              ? worktree
              : path.join(root, "linked");
        yield* write(path.join(headDirectory, "HEAD"), head);
      }
      assert.strictEqual(yield* readWorktreeBranch(worktree), null);
    }),
  );

  it.effect.each([
    ["a positive fraction with other fields", '{"spend_ceiling_usd":12.5,"slug":false}', 12.5],
    ["the smallest positive number", '{"spend_ceiling_usd":5e-324}', Number.MIN_VALUE],
    ["the largest finite number", '{"spend_ceiling_usd":1.7976931348623157e308}', Number.MAX_VALUE],
    ["overflow", '{"spend_ceiling_usd":1e309}', null],
    ["zero", '{"spend_ceiling_usd":0}', null],
    ["a negative value", '{"spend_ceiling_usd":-2}', null],
    ["a numeric string", '{"spend_ceiling_usd":"12.5"}', null],
    ["a non-numeric value", '{"spend_ceiling_usd":true}', null],
    ["an explicit null", '{"spend_ceiling_usd":null}', null],
    ["a missing ceiling", '{"other_ceiling":12.5}', null],
    ["a missing file", null, null],
  ] as const)("reads the expected ceiling for %s", ([, contents, expected]) =>
    Effect.gen(function* () {
      const { root, record, write } = yield* files;
      if (contents !== null) yield* write(record, contents);
      assert.strictEqual(yield* readSpendCeiling(root, "alpha"), expected);
    }),
  );

  it.effect("warns once per unreadable pair record across concurrent reads and retries", () =>
    Effect.gen(function* () {
      const { fs, path, root, record, write } = yield* files;
      const other = path.join(root, ".pairs", "beta", "record.json");
      yield* write(record, "{");
      yield* fs.makeDirectory(other, { recursive: true });
      const warnings: Array<string> = [];
      const logger = Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(JSON.stringify(message));
      });
      yield* Effect.gen(function* () {
        const read = (slug: string) => readSpendCeiling(root, slug);
        assert.deepStrictEqual(
          yield* Effect.all([read("alpha"), read("beta"), read("alpha"), read("missing")], {
            concurrency: "unbounded",
          }),
          [null, null, null, null],
        );
        assert.strictEqual(yield* read("beta"), null);
        assert.lengthOf(warnings, 2);
        assert.strictEqual(
          warnings.filter((warning) => warning.includes(JSON.stringify(record))).length,
          1,
        );
        assert.strictEqual(
          warnings.filter((warning) => warning.includes(JSON.stringify(other))).length,
          1,
        );

        yield* write(record, '{"spend_ceiling_usd":4}');
        assert.strictEqual(yield* read("alpha"), 4);
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    }),
  );

  it.effect.each(["conventional", "explicit"] as const)(
    "reads phases from the %s spec path",
    (kind) =>
      Effect.gen(function* () {
        const { path, worktree, plan, write } = yield* files;
        const explicit = "plans/override.md";
        yield* write(plan, "# Alpha\n");
        if (kind === "explicit") yield* write(path.join(worktree, explicit), "# Beta\n");
        const calls: Array<ProcessRunner.ProcessRunInput> = [];
        const result = yield* readSpecPhases(
          worktree,
          partId,
          kind === "explicit" ? explicit : null,
        ).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, {
            run: (input) => {
              calls.push(input);
              return Effect.succeed(processOutput(phaseOutput, 0));
            },
          }),
        );
        assert.deepStrictEqual(result, expectedPhases);
        assert.deepStrictEqual(
          calls.map(({ command, args, cwd, timeout }) => ({
            command,
            args,
            cwd,
            timeoutMs:
              timeout === undefined
                ? undefined
                : Duration.toMillis(Duration.fromInputUnsafe(timeout)),
          })),
          [
            {
              command: "dp",
              args: ["spec", "phases", kind === "explicit" ? explicit : plan, "--json"],
              cwd: worktree,
              timeoutMs: 15_000,
            },
          ],
        );
      }),
  );

  it.effect(
    "returns no phases when the explicit spec fails even if the conventional plan exists",
    () =>
      Effect.gen(function* () {
        const { worktree, plan, write } = yield* files;
        yield* write(plan, "# Alpha\n");
        const calls: Array<ReadonlyArray<string>> = [];
        const result = yield* readSpecPhases(worktree, partId, "plans/missing.md").pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, {
            run: ({ args }) => {
              calls.push(args);
              return Effect.succeed(processOutput(phaseOutput, args[2] === plan ? 0 : 1));
            },
          }),
        );
        assert.strictEqual(result, null);
        assert.deepStrictEqual(calls, [["spec", "phases", "plans/missing.md", "--json"]]);
      }),
  );

  it.effect.each([
    ["no conventional plan", null],
    ["a directory in place of a plan", "directory"],
    ["an empty explicit path", "empty"],
  ] as const)("returns no phases and skips dp for %s", ([, kind]) =>
    Effect.gen(function* () {
      const { fs, worktree, plan, write } = yield* files;
      if (kind === "directory") yield* fs.makeDirectory(plan, { recursive: true });
      if (kind === "empty") yield* write(plan, "# Alpha\n");
      const result = yield* readSpecPhases(worktree, partId, kind === "empty" ? "" : null).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: () => Effect.die("dp should not be called"),
        }),
      );
      assert.strictEqual(result, null);
    }),
  );

  it.effect.each([
    ["a failed exit even with valid JSON", phaseOutput, 1, null],
    ["a process timeout", "", 0, null],
    ["malformed JSON", "[", 0, null],
    ["a non-array payload", "{}", 0, null],
    ["a missing id", '[{"name":"Read records","wave":"1"}]', 0, null],
    ["a malformed name", '[{"id":"phase-a","name":null,"wave":"1"}]', 0, null],
    ["a non-string wave", '[{"id":"phase-a","name":"Read records","wave":1}]', 0, null],
    ["a non-numeric wave", '[{"id":"phase-a","name":"Read records","wave":"1st"}]', 0, null],
    ["a blank wave", '[{"id":"phase-a","name":"Read records","wave":" "}]', 0, null],
    ["a non-finite wave", '[{"id":"phase-a","name":"Read records","wave":"1e309"}]', 0, null],
    ["an empty phase list", "[]", 0, []],
  ] as const)("reads the expected phases for %s", ([name, stdout, code, expected]) =>
    Effect.gen(function* () {
      const { worktree, plan, write } = yield* files;
      yield* write(plan, "# Alpha\n");
      const calls: Array<ReadonlyArray<string>> = [];
      const result = yield* readSpecPhases(worktree, partId, null).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: ({ args }) => {
            calls.push(args);
            return name === "a process timeout"
              ? Effect.fail(
                  new ProcessRunner.ProcessTimeoutError({
                    command: "dp",
                    argumentCount: 4,
                    timeoutMs: 15_000,
                  }),
                )
              : Effect.succeed(processOutput(stdout, code));
          },
        }),
      );
      assert.deepStrictEqual(result, expected);
      assert.deepStrictEqual(calls, [["spec", "phases", plan, "--json"]]);
    }),
  );
});
