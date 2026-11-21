import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../../processRunner.ts";
import { PluginThreadIndex } from "../core/PluginThreadIndex.ts";
import { gittySource } from "./gittySource.ts";

const THREAD = ThreadId.make("thread-a");
const BRANCH = "feat/x";
const ONTO = "1234567890abcdef1234567890abcdef12345678";

const output = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});
const fail = output("", 128);

type Reply = ProcessRunner.ProcessRunOutput | "missing";

const command = (text: string, out: string | null = null, cwd = "/repo") => ({
  threadId: THREAD,
  turnItemId: TurnItemId.make("item-1"),
  command: text,
  output: out,
  exitCode: 0,
  cwd,
  completedAt: null,
});

const pushKey = (root: string, branch = BRANCH) =>
  ({ kind: "gitty.push", key: `${root}#${branch}` }) as const;
const conflictKey = (root: string, file: string) =>
  ({ kind: "gitty.conflict", key: `${root}#${file}` }) as const;

const SEP = "\u001f";
const log = (...rows: ReadonlyArray<readonly [string, string]>) =>
  rows.map(([sha, subject]) => `${sha}${SEP}${subject}\n`).join("");

const READ_ONLY_GIT = new Set([
  "rev-parse",
  "merge-base",
  "log",
  "rev-list",
  "status",
  "diff",
  "name-rev",
]);

const setup = Effect.fnUntraced(function* () {
  const realFs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* realFs.makeTempDirectoryScoped({ prefix: "t3-gitty-source-" });
  const gitDir = path.join(root, ".git");
  const stateDir = path.join(root, ".claude", "gitty-state");
  yield* realFs.makeDirectory(gitDir, { recursive: true });
  yield* realFs.makeDirectory(stateDir, { recursive: true });

  const queues = new Map<string, Queue.Queue<FileSystem.WatchEvent>>([
    [gitDir, yield* Queue.unbounded<FileSystem.WatchEvent>()],
    [stateDir, yield* Queue.unbounded<FileSystem.WatchEvent>()],
  ]);
  const processed = yield* Queue.unbounded<void>();
  const watched: Array<string> = [];
  const fs = {
    ...realFs,
    watch: (target: string, options?: FileSystem.WatchOptions) => {
      watched.push(target);
      options?.onReady?.();
      return Stream.fromQueue(queues.get(target)!).pipe(
        Stream.tap(() => Queue.offer(processed, undefined)),
      );
    },
  } satisfies FileSystem.FileSystem;

  const git: Record<string, Reply> = {
    [`rev-parse --show-toplevel --git-dir --abbrev-ref HEAD`]: output(
      `${root}\n${gitDir}\n${BRANCH}\n`,
    ),
    "rev-parse --abbrev-ref origin/HEAD": output("origin/main\n"),
    "rev-parse --verify --quiet refs/remotes/origin/main": output("deadbeef\n"),
    [`merge-base origin/main ${BRANCH}`]: output("base000\n"),
    [`log --reverse --format=%H%x1f%s base000..${BRANCH}`]: output(
      log(["aaa", "first"], ["bbb", "second"], ["ccc", "third"]),
    ),
    [`rev-list ${BRANCH}@{upstream}..${BRANCH}`]: output("ccc\n"),
    "status --porcelain": output(" M a.ts\n?? b.ts\n"),
    [`diff --shortstat base000..${BRANCH}`]: output(
      " 3 files changed, 10 insertions(+), 2 deletions(-)\n",
    ),
  };
  const calls: Array<ReadonlyArray<string>> = [];
  const unexpected: Array<string> = [];
  let everythingMissing = false;
  const run: ProcessRunner.ProcessRunner["Service"]["run"] = (input) => {
    calls.push(input.args);
    if (input.command !== "git" || input.args[2] !== "--no-optional-locks") {
      unexpected.push(`${input.command} ${input.args.join(" ")}`);
    }
    const rest = input.args.slice(3).join(" ");
    const reply = git[rest];
    if (reply === undefined) unexpected.push(rest);
    return everythingMissing || reply === "missing"
      ? Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: "git",
            argumentCount: input.args.length,
            cause: new Error("ENOENT"),
          }),
        )
      : Effect.succeed(reply ?? fail);
  };
  const services = Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem, fs),
    Layer.succeed(Path.Path, path),
    Layer.succeed(ProcessRunner.ProcessRunner, { run }),
    Layer.mock(PluginThreadIndex)({}),
  );
  const source = yield* gittySource.pipe(Effect.provide(services));
  return {
    source,
    services,
    root,
    gitDir,
    stateDir,
    git,
    calls,
    unexpected,
    watched,
    queues,
    processed,
    writeState: (state: unknown) =>
      realFs.writeFileString(
        path.join(stateDir, "push-in-progress.json"),
        typeof state === "string" ? state : JSON.stringify(state),
      ),
    writeGitFile: (relative: string, text: string) =>
      Effect.gen(function* () {
        const file = path.join(gitDir, relative);
        yield* realFs.makeDirectory(path.dirname(file), { recursive: true });
        yield* realFs.writeFileString(file, text);
      }),
    breakGit: () => {
      everythingMissing = true;
    },
    resolve: (ref: { readonly kind: string; readonly key: string }) =>
      source.resolve(ref as never, THREAD).pipe(Effect.provide(services)),
  };
});

/** The TestClock is shared by the tests in this group, so stamps are checked relative to an earlier one. */
const after = (iso: string | undefined, milliseconds: number) =>
  DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(iso!), { milliseconds }));

const keysOf = (refs: ReadonlyArray<{ readonly kind: string; readonly key: string }>) =>
  refs.map((ref) => `${ref.kind} ${ref.key}`);

it.layer(NodeServices.layer)("gitty source", (it) => {
  it.effect("recognises a push script by its JSON output, keyed by checkout and branch", () =>
    Effect.gen(function* () {
      const { source } = yield* setup();
      const pretty = JSON.stringify(
        { status: "pushed", sha: "abc", branch: BRANCH, files: ["a.ts"] },
        null,
        2,
      );
      expect(
        keysOf(
          source.recognize(
            command('bash "/x/scripts/push-commit.sh" --message m -- a.ts', pretty, "/repo"),
          ),
        ),
      ).toEqual([`gitty.push /repo#${BRANCH}`]);

      const state = JSON.stringify({ featureBranch: "feat/y", task: "t" }, null, 2);
      expect(
        keysOf(source.recognize(command("cd /other && /p/scripts/push-state.sh read", state))),
      ).toEqual(["gitty.push /other#feat/y"]);

      const enumerate = JSON.stringify({ branch: BRANCH, batches: [] }, null, 2);
      expect(keysOf(source.recognize(command("/p/scripts/push-enumerate.sh", enumerate)))).toEqual([
        `gitty.push /repo#${BRANCH}`,
      ]);
    }),
  );

  it.effect("recognises nothing for a push script without a branch, output or invocation", () =>
    Effect.gen(function* () {
      const { source } = yield* setup();
      const branchJson = JSON.stringify({ branch: BRANCH });
      expect(source.recognize(command("/p/scripts/push-state.sh read", "{}"))).toEqual([]);
      expect(source.recognize(command("/p/scripts/push-state.sh read", "not json"))).toEqual([]);
      expect(source.recognize(command("/p/scripts/push-state.sh read", null))).toEqual([]);
      expect(source.recognize(command(`echo scripts/push-commit.sh`, branchJson))).toEqual([]);
      expect(source.recognize(command("git status", branchJson))).toEqual([]);
      expect(
        source.recognize(
          command("/p/scripts/push-state.sh read", JSON.stringify({ branch: "-x" })),
        ),
      ).toEqual([]);
      expect(source.recognize(command("/p/scripts/other.sh", branchJson))).toEqual([]);
    }),
  );

  it.effect("recognises one conflict ref per file a push-commit conflict status lists", () =>
    Effect.gen(function* () {
      const { source } = yield* setup();
      const conflict = JSON.stringify(
        { status: "conflict", branch: BRANCH, conflicts: ["a.ts", "src/b.ts"] },
        null,
        2,
      );
      expect(
        keysOf(source.recognize(command("/p/scripts/push-commit.sh -m x -- a.ts", conflict))),
      ).toEqual([
        `gitty.push /repo#${BRANCH}`,
        "gitty.conflict /repo#a.ts",
        "gitty.conflict /repo#src/b.ts",
      ]);

      const pushed = JSON.stringify({ status: "pushed", branch: BRANCH, conflicts: ["a.ts"] });
      expect(
        keysOf(source.recognize(command("/p/scripts/push-commit.sh -m x -- a.ts", pushed))),
      ).toEqual([`gitty.push /repo#${BRANCH}`]);
      const none = JSON.stringify({ status: "conflict", branch: BRANCH, conflicts: [] });
      expect(
        keysOf(source.recognize(command("/p/scripts/push-commit.sh -m x -- a.ts", none))),
      ).toEqual([`gitty.push /repo#${BRANCH}`]);
    }),
  );

  it.effect("recognises a conflict from each CONFLICT line of a git command's output", () =>
    Effect.gen(function* () {
      const { source } = yield* setup();
      const rebase = [
        "Auto-merging a.ts",
        "CONFLICT (content): Merge conflict in a.ts",
        "error: could not apply 1234567... change",
      ].join("\n");
      expect(keysOf(source.recognize(command("git rebase origin/main", rebase)))).toEqual([
        "gitty.conflict /repo#a.ts",
      ]);

      const merge = [
        "CONFLICT (content): Merge conflict in src/one two.ts",
        "CONFLICT (add/add): Merge conflict in b.ts\r",
        "CONFLICT (modify/delete): c.ts deleted in HEAD and modified in topic.",
        "Automatic merge failed",
      ].join("\n");
      expect(keysOf(source.recognize(command("git merge topic", merge)))).toEqual([
        "gitty.conflict /repo#src/one two.ts",
        "gitty.conflict /repo#b.ts",
      ]);

      expect(
        source.recognize(
          command("git merge topic", "hint: CONFLICT (content): Merge conflict in a.ts"),
        ),
      ).toEqual([]);
      expect(source.recognize(command("git merge topic", "Already up to date."))).toEqual([]);
    }),
  );

  it.effect("keys a conflict by the directory the command ran git in", () =>
    Effect.gen(function* () {
      const { source } = yield* setup();
      const out = "CONFLICT (content): Merge conflict in a.ts";
      expect(keysOf(source.recognize(command("cd sub && git merge topic", out)))).toEqual([
        "gitty.conflict /repo/sub#a.ts",
      ]);
      expect(keysOf(source.recognize(command("git -C /other merge topic", out)))).toEqual([
        "gitty.conflict /other#a.ts",
      ]);
    }),
  );

  it.effect("returns one ref when a file is named by both the JSON and a CONFLICT line", () =>
    Effect.gen(function* () {
      const { source } = yield* setup();
      const out = `CONFLICT (content): Merge conflict in a.ts\n${JSON.stringify({
        status: "conflict",
        branch: BRANCH,
        conflicts: ["a.ts"],
      })}`;
      expect(
        keysOf(source.recognize(command("/p/scripts/push-commit.sh -m x -- a.ts", out))).filter(
          (key) => key.startsWith("gitty.conflict"),
        ),
      ).toEqual(["gitty.conflict /repo#a.ts"]);
    }),
  );

  it.effect("lists committed batches as done or pending, then uncommitted files as pending", () =>
    Effect.gen(function* () {
      const { resolve, root, calls, unexpected } = yield* setup();
      const card = yield* resolve(pushKey(root));

      expect(card).toMatchObject({
        kind: "gitty.push",
        data: {
          branch: BRANCH,
          batches: [
            { label: "first", state: "done", commit: "aaa" },
            { label: "second", state: "done", commit: "bbb" },
            { label: "third", state: "pending", commit: "ccc" },
            { label: "2 uncommitted files", state: "pending", commit: null },
          ],
          mergeRequest: null,
        },
        actions: [
          {
            id: "push-next",
            label: "Push next batch",
            type: "message",
            message: "Push the next batch.",
          },
        ],
      });
      expect(unexpected).toEqual([]);
      expect(calls.every((args) => args[0] === "-C" && args[1] === root)).toBe(true);
    }),
  );

  it.effect("runs only read-only git subcommands", () =>
    Effect.gen(function* () {
      const { resolve, root, calls, writeState, git, writeGitFile } = yield* setup();
      yield* writeState({
        featureBranch: BRANCH,
        baseBranch: "main",
        mrUrl: "https://github.com/o/r/pull/42",
      });
      yield* writeGitFile("rebase-merge/onto", ONTO);
      git["diff --name-only -z --diff-filter=U"] = output("a.ts\0");
      git[`name-rev --name-only ${ONTO}`] = output("remotes/origin/main\n");
      git["log -1 --format=%s REBASE_HEAD"] = output("mine\n");
      git[`log -1 --format=%s ${ONTO} -- a.ts`] = output("theirs\n");
      yield* resolve(pushKey(root));
      yield* resolve(conflictKey(root, "a.ts"));
      const subcommands = new Set(calls.map((args) => args[3]));
      expect([...subcommands].filter((name) => !READ_ONLY_GIT.has(name!))).toEqual([]);
      expect(subcommands.size).toBeGreaterThan(4);
    }),
  );

  it.effect("treats every commit as unpushed when the branch has no upstream", () =>
    Effect.gen(function* () {
      const { resolve, root, git } = yield* setup();
      git[`rev-list ${BRANCH}@{upstream}..${BRANCH}`] = output("", 128);
      git["status --porcelain"] = output("");
      const card = yield* resolve(pushKey(root));
      expect(card?.kind === "gitty.push" && card.data.batches.map((batch) => batch.state)).toEqual([
        "pending",
        "pending",
        "pending",
      ]);
      expect(card?.actions.map((action) => action.id)).toEqual(["push-next"]);
    }),
  );

  it.effect("offers no push-next with nothing ahead and a clean tree", () =>
    Effect.gen(function* () {
      const { resolve, root, git } = yield* setup();
      git[`log --reverse --format=%H%x1f%s base000..${BRANCH}`] = output("");
      git[`rev-list ${BRANCH}@{upstream}..${BRANCH}`] = output("");
      git["status --porcelain"] = output("");
      expect(yield* resolve(pushKey(root))).toMatchObject({ data: { batches: [] }, actions: [] });
    }),
  );

  it.effect("offers no push-next when every commit is pushed and the tree is clean", () =>
    Effect.gen(function* () {
      const { resolve, root, git } = yield* setup();
      git[`rev-list ${BRANCH}@{upstream}..${BRANCH}`] = output("");
      git["status --porcelain"] = output("");
      const card = yield* resolve(pushKey(root));
      expect(card?.actions).toEqual([]);
      expect(card?.kind === "gitty.push" && card.data.batches.map((batch) => batch.state)).toEqual([
        "done",
        "done",
        "done",
      ]);
    }),
  );

  it.effect("offers push-next for uncommitted files alone", () =>
    Effect.gen(function* () {
      const { resolve, root, git } = yield* setup();
      git[`rev-list ${BRANCH}@{upstream}..${BRANCH}`] = output("");
      git["status --porcelain"] = output(" M a.ts\n");
      const card = yield* resolve(pushKey(root));
      expect(card?.kind === "gitty.push" && card.data.batches.at(-1)).toEqual({
        label: "1 uncommitted file",
        state: "pending",
        commit: null,
      });
      expect(card?.actions.map((action) => action.id)).toEqual(["push-next"]);
    }),
  );

  it.effect("ignores the working tree when the branch is not the checked-out one", () =>
    Effect.gen(function* () {
      const { resolve, root, git, calls } = yield* setup();
      git["rev-parse --show-toplevel --git-dir --abbrev-ref HEAD"] = output(
        `${root}\n${root}/.git\nother\n`,
      );
      const card = yield* resolve(pushKey(root));
      expect(card?.kind === "gitty.push" && card.data.batches.map((batch) => batch.state)).toEqual([
        "done",
        "done",
        "pending",
      ]);
      expect(calls.some((args) => args[3] === "status")).toBe(false);
    }),
  );

  it.effect("attaches the draft merge request recorded for this branch", () =>
    Effect.gen(function* () {
      const { resolve, root, writeState } = yield* setup();
      yield* writeState({
        task: "t",
        baseBranch: "main",
        featureBranch: BRANCH,
        mrUrl: "https://github.com/o/r/pull/42",
      });
      const card = yield* resolve(pushKey(root));
      expect(card?.kind === "gitty.push" && card.data.mergeRequest).toEqual({
        url: "https://github.com/o/r/pull/42",
        number: 42,
        draft: true,
        additions: 10,
        deletions: 2,
        pipeline: "none",
      });
    }),
  );

  it.effect("numbers a GitLab merge request and counts a one-sided diff", () =>
    Effect.gen(function* () {
      const { resolve, root, writeState, git } = yield* setup();
      yield* writeState({
        baseBranch: "main",
        featureBranch: BRANCH,
        mrUrl: "https://gitlab.example.com/g/p/-/merge_requests/7",
      });
      git[`diff --shortstat base000..${BRANCH}`] = output(" 1 file changed, 1 insertion(+)\n");
      const card = yield* resolve(pushKey(root));
      expect(card?.kind === "gitty.push" && card.data.mergeRequest).toMatchObject({
        number: 7,
        additions: 1,
        deletions: 0,
      });

      git[`diff --shortstat base000..${BRANCH}`] = output("");
      const empty = yield* resolve(pushKey(root));
      expect(empty?.kind === "gitty.push" && empty.data.mergeRequest).toMatchObject({
        additions: 0,
        deletions: 0,
      });

      git[`diff --shortstat base000..${BRANCH}`] = output("", 128);
      const unreadable = yield* resolve(pushKey(root));
      expect(unreadable?.kind === "gitty.push" && unreadable.data.mergeRequest).toMatchObject({
        additions: null,
        deletions: null,
      });
    }),
  );

  it.effect("ignores a state file recorded for another branch, including its base", () =>
    Effect.gen(function* () {
      const { resolve, root, writeState, calls } = yield* setup();
      yield* writeState({
        baseBranch: "develop",
        featureBranch: "feat/other",
        mrUrl: "https://github.com/o/r/pull/9",
      });
      const card = yield* resolve(pushKey(root));
      expect(card).toMatchObject({ data: { mergeRequest: null } });
      expect(calls.some((args) => args.includes("origin/develop"))).toBe(false);
    }),
  );

  it.effect("draws no merge request for a state file without a web URL", () =>
    Effect.gen(function* () {
      const { resolve, root, writeState } = yield* setup();
      for (const mrUrl of [null, "", "javascript:alert(1)"]) {
        yield* writeState({ baseBranch: "main", featureBranch: BRANCH, mrUrl });
        expect(yield* resolve(pushKey(root))).toMatchObject({ data: { mergeRequest: null } });
      }
    }),
  );

  it.effect(
    "takes the base from the state file, preferring origin/<base> only when it exists",
    () =>
      Effect.gen(function* () {
        const { resolve, root, writeState, git } = yield* setup();
        yield* writeState({ baseBranch: "develop", featureBranch: BRANCH });
        git["rev-parse --verify --quiet refs/remotes/origin/develop"] = output("cafe\n");
        git[`merge-base origin/develop ${BRANCH}`] = output("base111\n");
        git[`log --reverse --format=%H%x1f%s base111..${BRANCH}`] = output(log(["ddd", "only"]));
        expect(yield* resolve(pushKey(root))).toMatchObject({
          data: { batches: [{ label: "only", commit: "ddd" }, { state: "pending" }] },
        });

        git["rev-parse --verify --quiet refs/remotes/origin/develop"] = output("", 1);
        git[`merge-base develop ${BRANCH}`] = output("base111\n");
        expect(yield* resolve(pushKey(root))).toMatchObject({
          data: { batches: [{ label: "only" }, { state: "pending" }] },
        });
      }),
  );

  it.effect("keeps drawing from git when the state file is malformed", () =>
    Effect.gen(function* () {
      const { resolve, root, writeState } = yield* setup();
      yield* writeState("{not json");
      expect(yield* resolve(pushKey(root))).toMatchObject({
        data: { mergeRequest: null, batches: [{ label: "first" }, {}, {}, {}] },
      });
    }),
  );

  it.effect("draws no push card without a base branch or merge base", () =>
    Effect.gen(function* () {
      const { resolve, root, git } = yield* setup();
      git["rev-parse --abbrev-ref origin/HEAD"] = output("origin/HEAD\n", 128);
      expect(yield* resolve(pushKey(root))).toBeNull();

      git["rev-parse --abbrev-ref origin/HEAD"] = output("origin/main\n");
      git[`merge-base origin/main ${BRANCH}`] = output("", 1);
      expect(yield* resolve(pushKey(root))).toBeNull();
    }),
  );

  it.effect("never passes a dash-leading branch to git", () =>
    Effect.gen(function* () {
      const { resolve, root, calls } = yield* setup();
      expect(yield* resolve(pushKey(root, "--output=x"))).toBeNull();
      expect(calls).toEqual([]);
    }),
  );

  it.effect("keeps updatedAt while the branch is unchanged and moves it on a new commit", () =>
    Effect.gen(function* () {
      const { resolve, root, git } = yield* setup();
      const first = yield* resolve(pushKey(root));
      yield* TestClock.adjust("5 seconds");
      expect((yield* resolve(pushKey(root)))?.updatedAt).toBe(first?.updatedAt);

      git[`log --reverse --format=%H%x1f%s base000..${BRANCH}`] = output(
        log(["aaa", "first"], ["bbb", "second"], ["ccc", "third"], ["ddd", "fourth"]),
      );
      const changed = yield* resolve(pushKey(root));
      expect(changed?.updatedAt).toBe(after(first?.updatedAt, 5_000));
      expect(
        changed?.kind === "gitty.push" && changed.data.batches.map((batch) => batch.label),
      ).toEqual(["first", "second", "third", "fourth", "2 uncommitted files"]);
    }),
  );

  it.effect(
    "signals on git state changes and on any gitty state file, not on other git files",
    () =>
      Effect.gen(function* () {
        const { source, services, resolve, root, watched, gitDir, stateDir, queues, processed } =
          yield* setup();
        const seen = yield* Queue.unbounded<void>();
        yield* Stream.runForEach(source.changes!, () => Queue.offer(seen, undefined)).pipe(
          Effect.provide(services),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* resolve(pushKey(root));
        expect([...watched].toSorted()).toEqual([gitDir, stateDir].toSorted());

        const gitEvents = queues.get(gitDir)!;
        yield* Queue.offer(gitEvents, { _tag: "Update", path: "index.lock" });
        yield* Queue.offer(gitEvents, { _tag: "Update", path: "config" });
        yield* Queue.take(processed);
        yield* Queue.take(processed);
        yield* TestClock.adjust("1 second");
        expect(yield* Queue.size(seen)).toBe(0);

        for (const name of [
          "HEAD",
          "ORIG_HEAD",
          "REBASE_HEAD",
          "MERGE_HEAD",
          "COMMIT_EDITMSG",
          "packed-refs",
          "index",
        ]) {
          yield* Queue.offer(gitEvents, { _tag: "Update", path: name });
          yield* Queue.take(processed);
          yield* TestClock.adjust("1 second");
          yield* Queue.take(seen);
        }

        yield* Queue.offer(queues.get(stateDir)!, {
          _tag: "Update",
          path: "push-in-progress.json",
        });
        yield* Queue.take(processed);
        yield* TestClock.adjust("1 second");
        yield* Queue.take(seen);
      }),
  );

  it.effect("debounces a burst of changes into one signal after 500 ms", () =>
    Effect.gen(function* () {
      const { source, services, resolve, root, gitDir, queues, processed } = yield* setup();
      const seen = yield* Queue.unbounded<void>();
      yield* Stream.runForEach(source.changes!, () => Queue.offer(seen, undefined)).pipe(
        Effect.provide(services),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* resolve(pushKey(root));
      const events = queues.get(gitDir)!;
      yield* Queue.offer(events, { _tag: "Update", path: "index" });
      yield* Queue.offer(events, { _tag: "Update", path: "HEAD" });
      yield* Queue.take(processed);
      yield* Queue.take(processed);
      yield* TestClock.adjust("499 millis");
      expect(yield* Queue.size(seen)).toBe(0);
      yield* TestClock.adjust("1 millis");
      yield* Queue.take(seen);
      expect(yield* Queue.size(seen)).toBe(0);
    }),
  );

  const conflictSetup = Effect.fnUntraced(function* () {
    const ctx = yield* setup();
    ctx.git["diff --name-only -z --diff-filter=U"] = output("a.ts\0src/b c.ts\0");
    ctx.git["log -1 --format=%s REBASE_HEAD"] = output("my change\n");
    ctx.git["log -1 --format=%s HEAD"] = output("head change\n");
    return ctx;
  });

  it.effect("fills a conflict card with both sides and three resolutions that name the file", () =>
    Effect.gen(function* () {
      const { resolve, root, git, writeGitFile, unexpected } = yield* conflictSetup();
      yield* writeGitFile("rebase-merge/onto", `${ONTO}\n`);
      git[`name-rev --name-only ${ONTO}`] = output("remotes/origin/Release-2\n");
      git[`log -1 --format=%s ${ONTO} -- a.ts`] = output("their change\n");

      const card = yield* resolve(conflictKey(root, "a.ts"));
      expect(card).toMatchObject({
        kind: "gitty.conflict",
        data: {
          file: "a.ts",
          base: "origin/Release-2",
          sides: [
            { label: "You", summary: "my change" },
            { label: "origin/Release-2", summary: "their change" },
          ],
          resolutions: [
            {
              key: "both",
              label: "Keep both changes",
              predictedOutcome: "Both changes stay. The overlapping lines need a manual merge.",
            },
            {
              key: "yours",
              label: "Keep yours",
              predictedOutcome: "The change on origin/Release-2 is dropped.",
            },
            {
              key: "theirs",
              label: "Take origin/Release-2",
              predictedOutcome: "Your change to this file is dropped.",
            },
          ],
        },
        actions: [
          {
            id: "use:both",
            label: "Use this",
            type: "message",
            message: "Resolve the conflict in a.ts: keep both changes.",
          },
          {
            id: "use:yours",
            label: "Use this",
            type: "message",
            message: "Resolve the conflict in a.ts: keep yours.",
          },
          {
            id: "use:theirs",
            label: "Use this",
            type: "message",
            message: "Resolve the conflict in a.ts: take origin/Release-2.",
          },
        ],
      });
      expect(unexpected).toEqual([]);
    }),
  );

  it.effect("names the other side from MERGE_HEAD and falls back to HEAD for your side", () =>
    Effect.gen(function* () {
      const { resolve, root, git, writeGitFile } = yield* conflictSetup();
      yield* writeGitFile("MERGE_HEAD", `${ONTO}\n`);
      git["log -1 --format=%s REBASE_HEAD"] = output("", 128);
      git[`name-rev --name-only ${ONTO}`] = output("topic\n");
      git[`log -1 --format=%s ${ONTO} -- a.ts`] = output("topic change\n");
      expect(yield* resolve(conflictKey(root, "a.ts"))).toMatchObject({
        data: {
          base: "topic",
          sides: [
            { label: "You", summary: "head change" },
            { label: "topic", summary: "topic change" },
          ],
        },
      });
    }),
  );

  it.effect("calls the other side Theirs when no rebase or merge names it", () =>
    Effect.gen(function* () {
      const { resolve, root, git, writeGitFile } = yield* conflictSetup();
      const bare = yield* resolve(conflictKey(root, "a.ts"));
      expect(bare).toMatchObject({
        data: {
          base: null,
          sides: [{ label: "You" }, { label: "Theirs", summary: "" }],
          resolutions: [
            {},
            { predictedOutcome: "Their change to this file is dropped." },
            { label: "Take theirs" },
          ],
        },
      });
      expect(bare?.actions.map((action) => action.type === "message" && action.message)).toEqual([
        "Resolve the conflict in a.ts: keep both changes.",
        "Resolve the conflict in a.ts: keep yours.",
        "Resolve the conflict in a.ts: take theirs.",
      ]);

      yield* writeGitFile("MERGE_HEAD", `${ONTO}\n`);
      git[`name-rev --name-only ${ONTO}`] = output("undefined\n");
      git[`log -1 --format=%s ${ONTO} -- a.ts`] = output("their change\n");
      expect(yield* resolve(conflictKey(root, "a.ts"))).toMatchObject({
        data: { base: null, sides: [{}, { label: "Theirs", summary: "their change" }] },
      });
    }),
  );

  it.effect("reads a file whose name has spaces from the unmerged list", () =>
    Effect.gen(function* () {
      const { resolve, root } = yield* conflictSetup();
      expect(yield* resolve(conflictKey(root, "src/b c.ts"))).toMatchObject({
        kind: "gitty.conflict",
        data: { file: "src/b c.ts" },
      });
    }),
  );

  it.effect("removes the conflict card once the file is no longer unmerged", () =>
    Effect.gen(function* () {
      const { resolve, root, git } = yield* conflictSetup();
      expect(yield* resolve(conflictKey(root, "a.ts"))).not.toBeNull();

      git["diff --name-only -z --diff-filter=U"] = output("src/b c.ts\0");
      expect(yield* resolve(conflictKey(root, "a.ts"))).toBeNull();

      git["diff --name-only -z --diff-filter=U"] = output("a.tsx\0");
      expect(yield* resolve(conflictKey(root, "a.ts"))).toBeNull();

      git["diff --name-only -z --diff-filter=U"] = output("");
      expect(yield* resolve(conflictKey(root, "a.ts"))).toBeNull();
    }),
  );

  it.effect("keeps updatedAt for an unchanged conflict card", () =>
    Effect.gen(function* () {
      const { resolve, root, git } = yield* conflictSetup();
      const first = yield* resolve(conflictKey(root, "a.ts"));
      yield* TestClock.adjust("3 seconds");
      expect((yield* resolve(conflictKey(root, "a.ts")))?.updatedAt).toBe(first?.updatedAt);
      git["log -1 --format=%s REBASE_HEAD"] = output("mine, amended\n");
      expect((yield* resolve(conflictKey(root, "a.ts")))?.updatedAt).toBe(
        after(first?.updatedAt, 3_000),
      );
    }),
  );

  it.effect("draws no gitty card when git is missing", () =>
    Effect.gen(function* () {
      const { resolve, root, breakGit } = yield* conflictSetup();
      breakGit();
      expect(yield* resolve(pushKey(root))).toBeNull();
      expect(yield* resolve(conflictKey(root, "a.ts"))).toBeNull();
    }),
  );

  it.effect("draws no gitty card for a directory that is not a repository", () =>
    Effect.gen(function* () {
      const { resolve, root, git } = yield* conflictSetup();
      git["rev-parse --show-toplevel --git-dir --abbrev-ref HEAD"] = output("", 128);
      expect(yield* resolve(pushKey(root))).toBeNull();
      expect(yield* resolve(conflictKey(root, "a.ts"))).toBeNull();
    }),
  );

  it.effect("does not resolve other kinds or malformed keys", () =>
    Effect.gen(function* () {
      const { resolve, calls } = yield* setup();
      expect(yield* resolve({ kind: "dispatch.plan", key: "/repo#x" })).toBeNull();
      expect(yield* resolve({ kind: "gitty.push", key: "no-separator" })).toBeNull();
      expect(yield* resolve({ kind: "gitty.conflict", key: "#a.ts" })).toBeNull();
      expect(calls).toEqual([]);
    }),
  );

  it.effect("splits a key at the first #, so branches and files may contain #", () =>
    Effect.gen(function* () {
      const { resolve, root, git } = yield* conflictSetup();
      git["diff --name-only -z --diff-filter=U"] = output("C#/a.cs\0");
      expect(yield* resolve(conflictKey(root, "C#/a.cs"))).toMatchObject({
        data: { file: "C#/a.cs" },
      });
    }),
  );
});
