import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ThreadId, TurnItemId } from "@t3tools/contracts";
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
import { dispatchPlanSource } from "./dispatchPlanSource.ts";

const THREAD = ThreadId.make("thread-a");

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

const frontmatter = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    task: "add-widget",
    status: "draft",
    wave: "1 of 2",
    initiative: "widgets",
    partOf: "core",
    created: "2026-11-21",
    ...overrides,
  });

const PHASES = JSON.stringify([
  {
    id: "p1",
    name: "Parser",
    wave: "1",
    tier: "standard",
    status: "pending",
    kind: "implementation",
    risk: "",
  },
  {
    id: "p2",
    name: "Auth",
    wave: "2",
    tier: "deep",
    status: "done",
    kind: "implementation",
    risk: "high",
  },
]);

type Reply = ProcessRunner.ProcessRunOutput | "missing";
interface Replies {
  readonly frontmatter: Reply;
  readonly phases: Reply;
}
const healthy: Replies = { frontmatter: output(frontmatter()), phases: output(PHASES) };

const command = (text: string, output: string | null = null, cwd = "/repo") => ({
  threadId: THREAD,
  turnItemId: TurnItemId.make("item-1"),
  command: text,
  output,
  exitCode: 0,
  cwd,
  completedAt: null,
});

const setup = Effect.fnUntraced(function* (initial: Replies = healthy) {
  const realFs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* realFs.makeTempDirectoryScoped({ prefix: "t3-plan-source-" });
  const plansDir = path.join(root, ".claude", "plans");
  yield* realFs.makeDirectory(plansDir, { recursive: true });
  const spec = path.join(plansDir, "x.md");

  const events = yield* Queue.unbounded<FileSystem.WatchEvent>();
  const processed = yield* Queue.unbounded<void>();
  const watched: Array<string> = [];
  const fs = {
    ...realFs,
    watch: (target: string, options?: FileSystem.WatchOptions) => {
      watched.push(target);
      options?.onReady?.();
      return Stream.fromQueue(events).pipe(Stream.tap(() => Queue.offer(processed, undefined)));
    },
  } satisfies FileSystem.FileSystem;

  let replies = initial;
  const calls: Array<{ readonly args: ReadonlyArray<string>; readonly cwd: string | undefined }> =
    [];
  const run: ProcessRunner.ProcessRunner["Service"]["run"] = (input) => {
    calls.push({ args: input.args, cwd: input.cwd });
    const reply = input.args[1] === "frontmatter" ? replies.frontmatter : replies.phases;
    return reply === "missing"
      ? Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: "dp",
            argumentCount: input.args.length,
            cause: new Error("ENOENT"),
          }),
        )
      : Effect.succeed(reply);
  };
  const services = Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem, fs),
    Layer.succeed(Path.Path, path),
    Layer.succeed(ProcessRunner.ProcessRunner, { run }),
    Layer.mock(PluginThreadIndex)({}),
  );
  const source = yield* dispatchPlanSource.pipe(Effect.provide(services));
  const ref = { kind: "dispatch.plan", key: spec } as const;
  return {
    source,
    services,
    root,
    spec,
    ref,
    calls,
    watched,
    events,
    processed,
    reply: (next: Partial<Replies>) => {
      replies = { ...replies, ...next };
    },
    resolve: (target: { readonly kind: "dispatch.plan"; readonly key: string } = ref) =>
      source.resolve(target, THREAD).pipe(Effect.provide(services)),
  };
});

it.layer(NodeServices.layer)("dispatch plan source", (it) => {
  it.effect("recognises dp commands that name a spec, keyed by the absolute spec path", () =>
    Effect.gen(function* () {
      const { source } = yield* setup();
      const keys = (text: string, out: string | null = null, cwd = "/repo") =>
        source.recognize(command(text, out, cwd)).map((ref) => `${ref.kind} ${ref.key}`);

      expect(keys("dp spec lint .claude/plans/x.md")).toEqual([
        "dispatch.plan /repo/.claude/plans/x.md",
      ]);
      expect(
        keys(
          'cd /repo && dp wave set .claude/plans/x.md --wave "1 of 2" --status executing',
          null,
          "/elsewhere",
        ),
      ).toEqual(["dispatch.plan /repo/.claude/plans/x.md"]);
      expect(keys("dp phase complete .claude/plans/x.md --phase p1")).toEqual([
        "dispatch.plan /repo/.claude/plans/x.md",
      ]);
      expect(keys("dp spec phases x.md --json")).toEqual(["dispatch.plan /repo/x.md"]);
      expect(keys("dp spec frontmatter /abs/y.md", null, "/elsewhere")).toEqual([
        "dispatch.plan /abs/y.md",
      ]);
      expect(keys("dp wave set --status executing .claude/plans/x.md")).toEqual([
        "dispatch.plan /repo/.claude/plans/x.md",
      ]);
    }),
  );

  it.effect("expands a bare task name to the plans directory", () =>
    Effect.gen(function* () {
      const { source } = yield* setup();
      expect(source.recognize(command("dp spec lint my-task")).map((ref) => ref.key)).toEqual([
        "/repo/.claude/plans/my-task.md",
      ]);
    }),
  );

  it.effect("recognises a `Spec written to:` output line, resolving a relative path", () =>
    Effect.gen(function* () {
      const { source } = yield* setup();
      const keys = (out: string) => source.recognize(command("echo done", out)).map((r) => r.key);

      expect(keys("planning...\nSpec written to: /repo/.claude/plans/z.md\n")).toEqual([
        "/repo/.claude/plans/z.md",
      ]);
      expect(keys("Spec written to: .claude/plans/z.md")).toEqual(["/repo/.claude/plans/z.md"]);
      expect(keys("The Spec written to: /repo/a.md")).toEqual([]);
    }),
  );

  it.effect("recognises nothing for commands that do not name a plan spec", () =>
    Effect.gen(function* () {
      const { source } = yield* setup();
      for (const text of [
        "dp spec lint",
        "dp spec show x.md",
        "echo dp spec lint x.md",
        "dp wave status 1 --part p1",
        "dp wave set --wave '1 of 2' --status executing",
        "dp spec lint $PLAN",
        "dp spec lint ~/x.md",
        "dp",
      ]) {
        expect(source.recognize(command(text)), text).toEqual([]);
      }
    }),
  );

  it.effect("returns one ref when a command names the same spec twice", () =>
    Effect.gen(function* () {
      const { source } = yield* setup();
      expect(
        source.recognize(command("dp spec lint x.md && dp spec phases x.md --json")),
      ).toHaveLength(1);
    }),
  );

  it.effect("fills the plan card from dp frontmatter and phases", () =>
    Effect.gen(function* () {
      const { resolve, spec, root, calls } = yield* setup();
      const card = yield* resolve();

      expect(card).toMatchObject({
        kind: "dispatch.plan",
        data: {
          task: "add-widget",
          specPath: spec,
          dir: root,
          status: "draft",
          wave: { current: 1, total: 2 },
          phases: [
            { id: "p1", name: "Parser", wave: 1, tier: "standard", status: "pending", risk: false },
            { id: "p2", name: "Auth", wave: 2, tier: "deep", status: "done", risk: true },
          ],
          initiative: "widgets",
          part: "core",
        },
      });
      expect(calls.map((call) => call.args)).toEqual([
        ["spec", "frontmatter", spec],
        ["spec", "phases", spec, "--json"],
      ]);
      expect(calls.map((call) => call.cwd)).toEqual([root, root]);
    }),
  );

  it.effect("reads a missing initiative, part and wave label as null and a zero wave", () =>
    Effect.gen(function* () {
      const { resolve, reply } = yield* setup();
      reply({
        frontmatter: output(
          JSON.stringify({ task: "t", status: "executing", initiative: "", partOf: "" }),
        ),
      });
      expect(yield* resolve()).toMatchObject({
        data: { initiative: null, part: null, wave: { current: 0, total: 2 } },
      });
    }),
  );

  it.effect("runs dp in the checkout of the first command that named the spec", () =>
    Effect.gen(function* () {
      const { source, resolve, spec, calls } = yield* setup();
      source.recognize(command(`dp spec lint ${spec}`, null, "/first"));
      source.recognize(command(`dp spec lint ${spec}`, null, "/second"));
      yield* resolve();
      expect(calls.map((call) => call.cwd)).toEqual(["/first", "/first"]);
    }),
  );

  it.effect("falls back to the checkout holding .claude/plans, else the spec's directory", () =>
    Effect.gen(function* () {
      const { resolve, root, calls } = yield* setup();
      yield* resolve();
      expect(calls[0]!.cwd).toBe(root);

      calls.length = 0;
      yield* resolve({ kind: "dispatch.plan", key: `${root}/notes.md` });
      expect(calls[0]!.cwd).toBe(root);
    }),
  );

  it.effect("does not resolve a ref of another kind", () =>
    Effect.gen(function* () {
      const { source, services } = yield* setup();
      const resolved = yield* source
        .resolve({ kind: "dispatch.verify", key: "/repo#p" }, THREAD)
        .pipe(Effect.provide(services));
      expect(resolved).toBeNull();
    }),
  );

  it.effect("offers Approve and Request changes while the status is draft, and neither after", () =>
    Effect.gen(function* () {
      const { resolve, reply } = yield* setup();
      const draft = yield* resolve();
      expect(draft?.actions).toEqual([
        {
          id: "request-changes",
          label: "Request changes",
          type: "message",
          message: "I want changes to plan add-widget before it runs.",
        },
        {
          id: "approve",
          label: "Approve",
          type: "message",
          message: "Plan add-widget is approved. Go ahead.",
        },
      ]);

      for (const status of ["executing", "approved", "done"]) {
        reply({ frontmatter: output(frontmatter({ status })) });
        expect((yield* resolve())?.actions, status).toEqual([]);
      }
    }),
  );

  it.effect("keeps updatedAt while the plan is unchanged and moves it when it changes", () =>
    Effect.gen(function* () {
      const { resolve, reply } = yield* setup();
      const first = yield* resolve();
      yield* TestClock.adjust("5 seconds");
      const same = yield* resolve();
      expect(same?.updatedAt).toBe(first?.updatedAt);

      reply({ frontmatter: output(frontmatter({ status: "executing" })) });
      const changed = yield* resolve();
      expect(changed?.updatedAt).not.toBe(first?.updatedAt);
      expect(changed?.updatedAt).toBe("1970-01-01T00:00:05.000Z");
    }),
  );

  it.effect.each([
    ["dp is not installed", { frontmatter: "missing", phases: "missing" }],
    ["frontmatter is unreadable", { frontmatter: output("boom", 1), phases: output(PHASES) }],
    ["phases are unreadable", { frontmatter: output(frontmatter()), phases: output("", 2) }],
    ["phases are not JSON", { frontmatter: output(frontmatter()), phases: output("not json") }],
    [
      "frontmatter lacks a task",
      { frontmatter: output(JSON.stringify({ status: "draft" })), phases: output(PHASES) },
    ],
  ] as const)("draws no card when %s", ([, replies]) =>
    Effect.gen(function* () {
      const { resolve } = yield* setup(replies);
      expect(yield* resolve()).toBeNull();
    }),
  );

  it.effect("watches the spec's directory and signals only for the spec's own file", () =>
    Effect.gen(function* () {
      const { source, services, resolve, watched, events, processed, spec } = yield* setup();
      const path = yield* Path.Path;
      const seen = yield* Queue.unbounded<void>();
      yield* Stream.runForEach(source.changes!, () => Queue.offer(seen, undefined)).pipe(
        Effect.provide(services),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* resolve();
      expect(watched).toEqual([path.dirname(spec)]);

      yield* Queue.offer(events, { _tag: "Update", path: "other.md" });
      yield* Queue.offer(events, { _tag: "Update", path: "notes.md" });
      yield* Queue.take(processed);
      yield* Queue.take(processed);
      yield* TestClock.adjust("1 second");
      expect(yield* Queue.size(seen)).toBe(0);

      yield* Queue.offer(events, { _tag: "Update", path: "x.md" });
      yield* Queue.take(processed);
      yield* TestClock.adjust("1 second");
      yield* Queue.take(seen);
    }),
  );
});
