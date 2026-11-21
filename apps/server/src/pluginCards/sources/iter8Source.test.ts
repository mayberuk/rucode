// @effect-diagnostics nodeBuiltinImport:off - the fixtures are real SQLite files, as iter8 writes them.
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  PluginCardError,
  type PluginCard,
  type PluginCardKind,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
import { iter8Source } from "./iter8Source.ts";

const THREAD = ThreadId.make("thread-a");
const NOW = Date.parse("2026-11-21T10:00:00.000Z");
const LONG_TEXT = `${"a".repeat(60)}${"b".repeat(10)}`;

const command = (text: string, output: string | null = null) => ({
  threadId: THREAD,
  turnItemId: TurnItemId.make("item-1"),
  command: text,
  output,
  exitCode: 0,
  cwd: "/repo",
  completedAt: null,
});

interface NoteFixture {
  readonly id: string;
  readonly roundId?: string;
  readonly ordinal: number;
  readonly author: string | null;
  readonly body: string;
  readonly target: string | null;
  readonly capture: string | null;
  readonly resolution: string | null;
}

const user = JSON.stringify({ kind: "user" });
const agent = JSON.stringify({ kind: "agent", name: "Claude", model: "x" });
const open = JSON.stringify({ status: "open" });

const NOTES: ReadonlyArray<NoteFixture> = [
  {
    id: "N3",
    ordinal: 3,
    author: user,
    body: "Region note",
    target: JSON.stringify({ kind: "region", rect: { x: 1, y: 2, w: 3, h: 4 } }),
    capture: JSON.stringify({ url: "http://pg1.localhost:4173/other" }),
    resolution: JSON.stringify({ status: "done" }),
  },
  {
    id: "N2",
    ordinal: 2,
    author: agent,
    body: "I changed the colour",
    target: JSON.stringify({ kind: "element", anchor: { text: LONG_TEXT, selector: ["a"] } }),
    capture: null,
    resolution: JSON.stringify({ status: "answered", extra: true }),
  },
  {
    id: "N1",
    ordinal: 1,
    author: user,
    body: "Make the button blue",
    target: JSON.stringify({
      kind: "element",
      anchor: { name: "Submit button", text: "Submit", selector: ["button"] },
    }),
    capture: JSON.stringify({ url: "http://pg1.localhost:4173/cart?step=2#frag", other: 1 }),
    resolution: open,
  },
  {
    id: "N9",
    roundId: "R13",
    ordinal: 1,
    author: user,
    body: "Belongs to another round",
    target: null,
    capture: null,
    resolution: open,
  },
];

const writeStore = (
  file: string,
  options: { readonly notes?: ReadonlyArray<NoteFixture>; readonly dropNotesColumn?: string } = {},
) => {
  const db = new NodeSqlite.DatabaseSync(file);
  try {
    db.exec(
      "CREATE TABLE pages (id TEXT PRIMARY KEY, project_root TEXT, target_kind TEXT, target TEXT, port INTEGER)",
    );
    db.exec(
      "CREATE TABLE rounds (id TEXT PRIMARY KEY, page_id TEXT, owner_id TEXT, state_json TEXT, created_at TEXT)",
    );
    const noteColumns = [
      "id",
      "page_id",
      "round_id",
      "kind",
      "ordinal",
      "author_json",
      "intent",
      "body",
      "target_json",
      "anchor_status",
      "capture_json",
      "resolution_json",
      "created_at",
    ].filter((column) => column !== options.dropNotesColumn);
    db.exec(`CREATE TABLE notes (${noteColumns.join(", ")})`);
    db.prepare("INSERT INTO pages VALUES ('pg1', '/p', 'url', 'x', 4173)").run();
    db.prepare("INSERT INTO rounds VALUES ('R12', 'pg1', 'o', '{}', 't')").run();
    db.prepare("INSERT INTO rounds VALUES ('R13', 'pg1', 'o', '{}', 't')").run();
    for (const note of options.notes ?? NOTES) {
      const row: Record<string, string | number | null> = {
        id: note.id,
        page_id: "pg1",
        round_id: note.roundId ?? "R12",
        kind: "comment",
        ordinal: note.ordinal,
        author_json: note.author,
        intent: "fix",
        body: note.body,
        target_json: note.target,
        anchor_status: "ok",
        capture_json: note.capture,
        resolution_json: note.resolution,
        created_at: "t",
      };
      const names = noteColumns;
      db.prepare(
        `INSERT INTO notes (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
      ).run(...names.map((name) => row[name]!));
    }
  } finally {
    db.close();
  }
};

const setNoteResolution = (file: string, id: string, status: string) => {
  const db = new NodeSqlite.DatabaseSync(file);
  try {
    db.prepare("UPDATE notes SET resolution_json = ? WHERE id = ?").run(
      JSON.stringify({ status }),
      id,
    );
  } finally {
    db.close();
  }
};

const output = (
  overrides: Partial<ProcessRunner.ProcessRunOutput>,
): ProcessRunner.ProcessRunOutput => ({
  stdout: "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
  ...overrides,
});

interface SetupOptions {
  readonly iter8Home?: "set" | "unset";
  readonly store?: "full" | "none";
  readonly notes?: ReadonlyArray<NoteFixture>;
  readonly dropNotesColumn?: string;
  readonly run?: ProcessRunner.ProcessRunner["Service"]["run"];
}

const setup = Effect.fnUntraced(function* (options: SetupOptions = {}) {
  const realFs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* realFs.makeTempDirectoryScoped({ prefix: "t3-iter8-source-" });
  yield* TestClock.setTime(NOW);

  const home = path.join(root, "home");
  const customHome = path.join(root, "custom-iter8");
  const storeDir = options.iter8Home === "unset" ? path.join(home, ".iter8") : customHome;
  yield* realFs.makeDirectory(storeDir, { recursive: true });
  const dbPath = path.join(storeDir, "iter8.db");
  if (options.store !== "none") {
    writeStore(dbPath, {
      ...(options.notes === undefined ? {} : { notes: options.notes }),
      ...(options.dropNotesColumn === undefined
        ? {}
        : { dropNotesColumn: options.dropNotesColumn }),
    });
  }

  const watched: Array<string> = [];
  const events = yield* Queue.unbounded<FileSystem.WatchEvent>();
  const fs = {
    ...realFs,
    watch: (target: string, watchOptions?: FileSystem.WatchOptions) => {
      watched.push(target);
      watchOptions?.onReady?.();
      return Stream.fromQueue(events);
    },
  } satisfies FileSystem.FileSystem;

  const calls: Array<ProcessRunner.ProcessRunInput> = [];
  const run: ProcessRunner.ProcessRunner["Service"]["run"] = (input) => {
    calls.push(input);
    return options.run === undefined ? Effect.succeed(output({})) : options.run(input);
  };
  const services = Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem, fs),
    Layer.succeed(Path.Path, path),
    Layer.succeed(ProcessRunner.ProcessRunner, { run }),
    Layer.mock(PluginThreadIndex)({}),
  );
  const source = yield* iter8Source.pipe(
    Effect.provide(services),
    Effect.provideService(HostProcess.HomeDirectory, home),
    Effect.provideService(
      HostProcess.Environment,
      options.iter8Home === "unset" ? {} : { ITER8_HOME: customHome },
    ),
  );

  const resolve = (key = "R12", kind: PluginCardKind = "iter8.round") =>
    source.resolve({ kind, key }, THREAD).pipe(Effect.provide(services));

  const asPlaced = (resolved: ResolvedPluginCard, key = "R12") =>
    ({
      ...resolved,
      id: `${resolved.kind}:${key}`,
      threadId: THREAD,
      placement: { type: "time", at: "2026-11-21T10:00:00.000Z" },
    }) as PluginCard;

  const runAction = (card: PluginCard, actionId: string) =>
    source.runAction!(card, actionId).pipe(Effect.provide(services), Effect.exit);

  return {
    source,
    services,
    path,
    realFs,
    root,
    home,
    storeDir,
    dbPath,
    watched,
    events,
    calls,
    resolve,
    asPlaced,
    runAction,
  };
});

const noteStates = (card: ResolvedPluginCard | null) => {
  if (card?.kind !== "iter8.round") throw new Error("expected an iter8 round card");
  return card.data.notes.map((note) => [note.id, note.state]);
};

const captureWarnings = () => {
  const warnings: Array<unknown> = [];
  const logger = Logger.make(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(message);
  });
  return { warnings, logger };
};

const expectActionError = (
  exit: Exit.Exit<void, PluginCardError>,
  reason: string,
  detail?: string,
) => {
  expect(Exit.isFailure(exit)).toBe(true);
  const error = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : null;
  expect(error?._tag).toBe("Some");
  const value = error?._tag === "Some" ? error.value : null;
  expect(value).toBeInstanceOf(PluginCardError);
  expect(value?.reason).toBe(reason);
  expect(value?.detail).toBe(detail);
};

it.layer(NodeServices.layer)("iter8 source", (it) => {
  it.effect("recognises a round from iter8 show, with or without --json", () =>
    Effect.gen(function* () {
      const { source } = yield* setup();
      const round = [{ kind: "iter8.round", key: "R12" }];
      expect(source.recognize(command("iter8 show R12 --json"))).toEqual(round);
      expect(source.recognize(command("iter8 show R12"))).toEqual(round);
      expect(
        source.recognize(command("cd /app && /usr/local/bin/iter8 show R12 | jq .notes")),
      ).toEqual(round);
      expect(
        source.recognize(command("iter8 show R12 --json; iter8 show R12; iter8 show R7")),
      ).toEqual([
        { kind: "iter8.round", key: "R12" },
        { kind: "iter8.round", key: "R7" },
      ]);
    }),
  );

  it.effect("recognises iter8 done by the round in its output, and nothing without one", () =>
    Effect.gen(function* () {
      const { source } = yield* setup();
      const round = [{ kind: "iter8.round", key: "R12" }];
      expect(
        source.recognize(
          command("iter8 done N3", '{"roundId":"R12","noteId":"N3","status":"done"}'),
        ),
      ).toEqual(round);
      expect(source.recognize(command("iter8 done N3", "Round R12\nN3 resolved\n"))).toEqual(round);
      expect(source.recognize(command("iter8 done N3", "N3 resolved"))).toEqual([]);
      expect(source.recognize(command("iter8 done N3", null))).toEqual([]);
      expect(source.recognize(command("iter8 done N3 --json", '{"roundId":"R5"}'))).toEqual([
        { kind: "iter8.round", key: "R5" },
      ]);
    }),
  );

  it.effect("recognises nothing for other iter8 commands or look-alikes", () =>
    Effect.gen(function* () {
      const { source } = yield* setup();
      for (const [text, out] of [
        ["iter8 rounds --json", '{"roundId":"R12"}'],
        ["iter8 open http://localhost:3000", "Round R12"],
        ["iter8 note R12 hello", '{"roundId":"R12"}'],
        ["iter8 show 12", null],
        ["iter8 show N12", null],
        ["iter8 show", null],
        ["iter8 done R12", '{"roundId":"R12"}'],
        ["echo iter8 show R12", null],
        ["notiter8 show R12", null],
      ] as const) {
        expect(source.recognize(command(text, out)), text).toEqual([]);
      }
    }),
  );

  it.effect("maps a round to a card with note text, author, anchor and state", () =>
    Effect.gen(function* () {
      const { resolve, watched, storeDir } = yield* setup();
      const card = yield* resolve();

      expect(card).toMatchObject({
        kind: "iter8.round",
        data: {
          round: 12,
          page: "http://pg1.localhost:4173",
          pagePath: "/cart?step=2",
          notes: [
            {
              id: "N1",
              text: "Make the button blue",
              state: "open",
              author: "You",
              anchor: "Submit button",
            },
            {
              id: "N2",
              text: "I changed the colour",
              state: "resolved",
              author: "Claude",
              anchor: "a".repeat(60),
            },
            { id: "N3", text: "Region note", state: "resolved", author: "You", anchor: null },
          ],
        },
      });
      expect(watched).toEqual([storeDir]);
    }),
  );

  it.effect("offers Reply and Resolve for the open note only", () =>
    Effect.gen(function* () {
      const { resolve } = yield* setup();
      const card = yield* resolve();
      expect(card?.actions).toEqual([
        {
          id: "reply:N1",
          label: "Reply",
          type: "message",
          message: "Reply to iter8 note N1 in round R12.",
        },
        { id: "resolve:N1", label: "Resolve", type: "command" },
      ]);
    }),
  );

  it.effect("uses the first capture URL for the page path, and null without any", () =>
    Effect.gen(function* () {
      const withLaterCapture = yield* setup({
        notes: NOTES.map((note) => (note.id === "N1" ? { ...note, capture: null } : note)),
      });
      expect((yield* withLaterCapture.resolve())?.data).toMatchObject({ pagePath: "/other" });

      const none = yield* setup({
        notes: NOTES.map((note) => ({ ...note, capture: null })),
      });
      expect((yield* none.resolve())?.data).toMatchObject({ pagePath: null });
    }),
  );

  it.effect("skips one unreadable note and keeps the round", () =>
    Effect.gen(function* () {
      const { resolve } = yield* setup({
        notes: NOTES.map((note) => (note.id === "N2" ? { ...note, resolution: "not json" } : note)),
      });
      const card = yield* resolve();
      expect(card?.data).toMatchObject({ notes: [{ id: "N1" }, { id: "N3" }] });
    }),
  );

  it.effect("reads the store from ITER8_HOME, else from ~/.iter8", () =>
    Effect.gen(function* () {
      const fromEnvironment = yield* setup({ iter8Home: "set" });
      expect((yield* fromEnvironment.resolve())?.kind).toBe("iter8.round");
      expect(fromEnvironment.watched).toEqual([fromEnvironment.storeDir]);

      const fromHome = yield* setup({ iter8Home: "unset" });
      expect(fromHome.storeDir).toBe(`${fromHome.home}/.iter8`);
      expect((yield* fromHome.resolve())?.kind).toBe("iter8.round");
      expect(fromHome.watched).toEqual([fromHome.storeDir]);
    }),
  );

  it.effect("resolves to null for an absent round or another card kind", () =>
    Effect.gen(function* () {
      const { resolve } = yield* setup();
      expect(yield* resolve("R99")).toBeNull();
      expect(yield* resolve("R12", "gitty.push")).toBeNull();
    }),
  );

  it.effect("draws no card, with one warning naming the path, when the store is missing", () =>
    Effect.gen(function* () {
      const { resolve, dbPath, realFs } = yield* setup({ store: "none" });
      const { warnings, logger } = captureWarnings();
      expect(yield* resolve().pipe(Effect.withLogger(logger))).toBeNull();
      expect(warnings).toHaveLength(1);
      expect(JSON.stringify(warnings)).toContain(dbPath);
      expect(yield* realFs.exists(dbPath)).toBe(false);
    }),
  );

  it.effect("draws no card when the store lacks the notes table", () =>
    Effect.gen(function* () {
      const { resolve, dbPath } = yield* setup({ store: "none" });
      const db = new NodeSqlite.DatabaseSync(dbPath);
      db.exec("CREATE TABLE rounds (id TEXT, page_id TEXT)");
      db.exec("CREATE TABLE pages (id TEXT, port INTEGER)");
      db.exec("INSERT INTO rounds VALUES ('R12', 'pg1')");
      db.exec("INSERT INTO pages VALUES ('pg1', 4173)");
      db.close();
      const { warnings, logger } = captureWarnings();
      expect(yield* resolve().pipe(Effect.withLogger(logger))).toBeNull();
      expect(JSON.stringify(warnings)).toContain(dbPath);
    }),
  );

  it.effect("draws no card when a column the reader uses is missing", () =>
    Effect.gen(function* () {
      for (const column of ["resolution_json", "round_id", "ordinal", "body"]) {
        const { resolve } = yield* setup({ dropNotesColumn: column });
        expect(yield* resolve(), column).toBeNull();
      }
    }),
  );

  it.effect("leaves the store byte for byte unchanged", () =>
    Effect.gen(function* () {
      const { resolve, dbPath, realFs } = yield* setup();
      const before = yield* realFs.readFile(dbPath);
      yield* resolve();
      yield* resolve("R99");
      expect(yield* realFs.readFile(dbPath)).toEqual(before);
    }),
  );

  it.effect(
    "shows a note resolved in iter8 with a newer updatedAt, and keeps it when unchanged",
    () =>
      Effect.gen(function* () {
        const { resolve, dbPath } = yield* setup();
        const first = yield* resolve();
        yield* TestClock.adjust("5 seconds");
        const unchanged = yield* resolve();
        expect(unchanged?.updatedAt).toBe(first?.updatedAt);

        setNoteResolution(dbPath, "N1", "done");
        const changed = yield* resolve();
        expect(noteStates(changed)).toEqual([
          ["N1", "resolved"],
          ["N2", "resolved"],
          ["N3", "resolved"],
        ]);
        expect(changed?.actions).toEqual([]);
        expect(changed?.updatedAt).toBe("2026-11-21T10:00:05.000Z");
      }),
  );

  it.effect("signals a change for the store files only, after the 500 ms debounce", () =>
    Effect.gen(function* () {
      const { source, services, resolve, events, storeDir } = yield* setup();
      const seen = yield* Queue.unbounded<void>();
      yield* Stream.runForEach(source.changes!, () => Queue.offer(seen, undefined)).pipe(
        Effect.provide(services),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* resolve();

      yield* Queue.offer(events, { _tag: "Update", path: `${storeDir}/notes.txt` });
      yield* Queue.offer(events, { _tag: "Update", path: `${storeDir}/iter8.db-shm` });
      yield* TestClock.adjust("10 seconds");
      expect(yield* Queue.size(seen)).toBe(0);

      yield* Queue.offer(events, { _tag: "Update", path: `${storeDir}/iter8.db-wal` });
      yield* TestClock.adjust("499 millis");
      expect(yield* Queue.size(seen)).toBe(0);
      yield* TestClock.adjust("1 millis");
      yield* Queue.take(seen);

      yield* Queue.offer(events, { _tag: "Update", path: `${storeDir}/iter8.db` });
      yield* TestClock.adjust("500 millis");
      yield* Queue.take(seen);
    }),
  );

  it.effect("resolves an open note by running exactly iter8 done for it", () =>
    Effect.gen(function* () {
      const { resolve, asPlaced, runAction, calls, home } = yield* setup();
      const card = asPlaced((yield* resolve())!);
      const exit = yield* runAction(card, "resolve:N1");

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ command: "iter8", args: ["done", "N1"], cwd: home });
      expect(Duration.toMillis(Duration.fromInputUnsafe(calls[0]!.timeout!))).toBe(15_000);
    }),
  );

  it.effect("fails with iter8's first stderr line when it refuses", () =>
    Effect.gen(function* () {
      const { resolve, asPlaced, runAction } = yield* setup({
        run: () =>
          Effect.succeed(
            output({
              code: ChildProcessSpawner.ExitCode(1),
              stderr: "\nnote N1 is locked by another round\nsecond line\n",
            }),
          ),
      });
      const card = asPlaced((yield* resolve())!);
      expectActionError(
        yield* runAction(card, "resolve:N1"),
        "source-failed",
        "note N1 is locked by another round",
      );
    }),
  );

  it.effect("fails with unavailable when iter8 is missing", () =>
    Effect.gen(function* () {
      const { resolve, asPlaced, runAction } = yield* setup({
        run: (input) =>
          Effect.fail(
            new ProcessRunner.ProcessSpawnError({
              command: input.command,
              argumentCount: input.args.length,
              cause: new Error("ENOENT"),
            }),
          ),
      });
      const card = asPlaced((yield* resolve())!);
      expectActionError(yield* runAction(card, "resolve:N1"), "unavailable");
    }),
  );

  it.effect(
    "refuses any action but resolve for an open note on the card, without running iter8",
    () =>
      Effect.gen(function* () {
        const { resolve, asPlaced, runAction, calls } = yield* setup();
        const card = asPlaced((yield* resolve())!);
        for (const actionId of [
          "resolve:N2",
          "resolve:N3",
          "resolve:N9",
          "resolve:",
          "resolve:--help",
          "reply:N1",
          "N1",
          "done:N1",
        ]) {
          expectActionError(yield* runAction(card, actionId), "unknown-action");
        }
        const notIter8 = { ...card, kind: "gitty.push" } as unknown as PluginCard;
        expectActionError(yield* runAction(notIter8, "resolve:N1"), "unknown-action");
        expect(calls).toEqual([]);
      }),
  );
});
