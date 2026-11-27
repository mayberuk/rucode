// @effect-diagnostics nodeBuiltinImport:off - the fixtures use iter8's SQLite and loopback HTTP boundaries.
import * as NodeHttp from "node:http";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type Iter8CreateNoteInput,
  type Iter8ReviewSnapshot,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";
import * as TestClock from "effect/testing/TestClock";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as Iter8Review from "./Iter8Review.ts";

const createdAt = "2026-01-10T12:00:00.000Z";
const projectRoot = "/workspace/checkout-flow";
const token = "fixture-page-token";
const unavailableSnapshot = { available: false, sessions: [], pages: [] };
const anchor = {
  selector: ["main", "button.confirm"],
  role: "button",
  name: "Confirm",
  box: { x: 12, y: 40, width: 105, height: 36 },
} as const;
const createInput = {
  pageId: "pg1",
  intent: "fix",
  body: "Align the confirmation button",
  anchor,
  url: "http://pg1.localhost:4173/confirm?step=2",
  viewport: { width: 1200, height: 720, devicePixelRatio: 2 },
  theme: "dark",
} satisfies Iter8CreateNoteInput;
const updateInput = { pageId: "pg1", noteId: "N2", intent: "keep", body: "" } as const;
const deleteInput = { pageId: "pg1", noteId: "N2" };
const sendInput = { pageId: "pg1", idempotencyKey: "checkout-request-01" };

const withStore = (file: string, write: (db: NodeSqlite.DatabaseSync) => void) => {
  const db = new NodeSqlite.DatabaseSync(file);
  try {
    write(db);
  } finally {
    db.close();
  }
};

const writeStore = (file: string, port = 4173, generation = 7) =>
  withStore(file, (db) => {
    db.exec(`
      CREATE TABLE owners (id TEXT PRIMARY KEY, agent TEXT, label TEXT, cwd TEXT, busy INTEGER, gone_reason TEXT);
      CREATE TABLE pages (id TEXT PRIMARY KEY, token TEXT, project_root TEXT, port INTEGER, owner_id TEXT, generation INTEGER, created_at TEXT);
      CREATE TABLE rounds (id TEXT PRIMARY KEY, page_id TEXT, state_json TEXT, created_at TEXT);
      CREATE TABLE notes (id TEXT PRIMARY KEY, page_id TEXT, round_id TEXT, kind TEXT, ordinal INTEGER, author_json TEXT, intent TEXT, body TEXT, target_json TEXT, capture_json TEXT, resolution_json TEXT, created_at TEXT);
    `);
    db.prepare("INSERT INTO owners VALUES ('owner-a', 'agent', 'Checkout', ?, 0, NULL)").run(
      projectRoot,
    );
    db.prepare("INSERT INTO pages VALUES ('pg1', ?, ?, ?, 'owner-a', ?, ?)").run(
      token,
      projectRoot,
      port,
      generation,
      createdAt,
    );
    db.prepare("INSERT INTO rounds VALUES ('R1', 'pg1', ?, ?)").run(
      '{"stage":"queued"}',
      createdAt,
    );
    db.prepare(
      "INSERT INTO notes VALUES ('N1', 'pg1', 'R1', 'sent', 1, ?, 'fix', ?, ?, ?, ?, ?)",
    ).run(
      '{"kind":"user"}',
      "Align the confirmation button",
      JSON.stringify({ kind: "element", anchor }),
      JSON.stringify({ url: createInput.url }),
      '{"status":"open"}',
      createdAt,
    );
  });

const expectedSnapshot: Iter8ReviewSnapshot = {
  available: true,
  sessions: [
    {
      ownerId: "owner-a",
      agent: "agent",
      label: "Checkout",
      cwd: projectRoot,
      state: "live",
      pageIds: ["pg1"],
    },
  ],
  pages: [
    {
      id: "pg1",
      origin: "http://pg1.localhost:4173",
      projectRoot,
      ownerId: "owner-a",
      rounds: [{ id: "R1", pageId: "pg1", stage: "queued", noteCount: 1, createdAt }],
      notes: [
        {
          id: "N1",
          pageId: "pg1",
          roundId: "R1",
          author: { kind: "user" },
          intent: "fix",
          body: "Align the confirmation button",
          selector: ["main", "button.confirm"],
          anchorLabel: "Confirm",
          path: "/confirm?step=2",
          status: "sent",
          reply: null,
          createdAt,
        },
      ],
    },
  ],
};

const setup = Effect.fnUntraced(function* (
  options: {
    readonly store?: "missing-directory" | "missing-file" | "missing-tables";
    readonly iter8Home?: "unset" | "empty";
    readonly port?: number;
    readonly generation?: number;
  } = {},
) {
  const realFs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* realFs.makeTempDirectoryScoped({ prefix: "t3-iter8-review-" });
  const storeDir = path.join(home, options.iter8Home === undefined ? "custom" : ".iter8");
  const dbPath = path.join(storeDir, "iter8.db");
  if (options.store !== "missing-directory") {
    yield* realFs.makeDirectory(storeDir);
  }
  if (options.store === undefined) {
    writeStore(dbPath, options.port, options.generation);
  } else if (options.store === "missing-tables") {
    withStore(dbPath, () => {});
  }

  const watched: Array<string> = [];
  const events = yield* PubSub.unbounded<FileSystem.WatchEvent>();
  const fs = {
    ...realFs,
    watch: (dir: string, watchOptions?: FileSystem.WatchOptions) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(events);
          watched.push(dir);
          watchOptions?.onReady?.();
          return Stream.fromSubscription(subscription);
        }),
      ),
  } satisfies FileSystem.FileSystem;
  const environment =
    options.iter8Home === "unset"
      ? {}
      : { ITER8_HOME: options.iter8Home === "empty" ? "" : storeDir };
  const review = yield* Iter8Review.Iter8Review.pipe(
    Effect.provide(
      Iter8Review.layer.pipe(
        Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)),
        Layer.provide(Layer.succeed(Path.Path, path)),
        Layer.provide(Layer.succeed(HostProcess.HomeDirectory, home)),
        Layer.provide(Layer.succeed(HostProcess.Environment, environment)),
      ),
    ),
  );
  const notify = (file: string) =>
    PubSub.publish(events, { _tag: "Update", path: path.join(storeDir, file) } as const);
  const setBusy = (busy: boolean) =>
    withStore(dbPath, (db) => db.prepare("UPDATE owners SET busy = ?").run(Number(busy)));

  return { review, watched, storeDir, dbPath, realFs, notify, setBusy };
});

const collectSnapshots = Effect.fnUntraced(function* (review: Iter8Review.Iter8Review["Service"]) {
  const seen = yield* Queue.unbounded<Iter8ReviewSnapshot>();
  yield* Stream.runForEach(review.subscribe, (snapshot) => Queue.offer(seen, snapshot)).pipe(
    Effect.forkScoped({ startImmediately: true }),
  );
  return seen;
});

it.effect(
  "reads the current snapshot as soon as a client subscribes, from the configured store",
  () =>
    Effect.gen(function* () {
      const { review, watched, storeDir } = yield* setup();
      expect(watched).toEqual([]);
      expect(yield* Stream.runHead(review.subscribe)).toEqual(Option.some(expectedSnapshot));
      expect(watched).toEqual([storeDir]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["unset", "empty"] as const)(
  "reads the home store when ITER8_HOME is %s",
  (iter8Home) =>
    Effect.gen(function* () {
      const { review } = yield* setup({ iter8Home });
      expect(yield* Stream.runHead(review.subscribe)).toEqual(Option.some(expectedSnapshot));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports an existing store with no review records as available", () =>
  Effect.gen(function* () {
    const { review, dbPath } = yield* setup();
    withStore(dbPath, (db) =>
      db.exec("DELETE FROM notes; DELETE FROM rounds; DELETE FROM pages; DELETE FROM owners"),
    );
    expect(yield* Stream.runHead(review.subscribe)).toEqual(
      Option.some({ available: true, sessions: [], pages: [] }),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("sends a changed WAL snapshot at 500 ms and suppresses an identical reread", () =>
  Effect.gen(function* () {
    const { review, notify, setBusy } = yield* setup();
    const seen = yield* collectSnapshots(review);
    expect(yield* Queue.take(seen)).toEqual(expectedSnapshot);

    setBusy(true);
    yield* notify("iter8.db-wal");
    yield* TestClock.adjust("499 millis");
    expect(yield* Queue.poll(seen)).toEqual(Option.none());
    yield* TestClock.adjust("1 millis");
    expect(yield* Queue.poll(seen)).toEqual(
      Option.some({
        ...expectedSnapshot,
        sessions: [
          {
            ownerId: "owner-a",
            agent: "agent",
            label: "Checkout",
            cwd: projectRoot,
            state: "busy",
            pageIds: ["pg1"],
          },
        ],
      }),
    );

    yield* notify("iter8.db-wal");
    yield* TestClock.adjust("500 millis");
    expect(yield* Queue.poll(seen)).toEqual(Option.none());

    setBusy(false);
    yield* notify("iter8.db-wal");
    yield* TestClock.adjust("500 millis");
    expect(yield* Queue.poll(seen)).toEqual(Option.some(expectedSnapshot));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("emits when only the content of a page note changes", () =>
  Effect.gen(function* () {
    const { review, dbPath, notify } = yield* setup();
    const seen = yield* collectSnapshots(review);
    expect(yield* Queue.take(seen)).toEqual(expectedSnapshot);

    withStore(dbPath, (db) =>
      db.prepare("UPDATE notes SET body = ? WHERE id = 'N1'").run("Shorten the label"),
    );
    yield* notify("iter8.db");
    yield* TestClock.adjust("500 millis");
    expect(yield* Queue.poll(seen)).toMatchObject({
      _tag: "Some",
      value: {
        available: true,
        sessions: expectedSnapshot.sessions,
        pages: [{ id: "pg1", notes: [{ id: "N1", body: "Shorten the label" }] }],
      },
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ignores auxiliary files and measures the debounce from the latest store change", () =>
  Effect.gen(function* () {
    const { review, notify, realFs, dbPath, setBusy } = yield* setup();
    const seen = yield* collectSnapshots(review);
    expect(yield* Queue.take(seen)).toEqual(expectedSnapshot);

    setBusy(true);
    yield* notify("iter8.db-shm");
    yield* notify("notes.txt");
    yield* TestClock.adjust("500 millis");
    expect(yield* Queue.poll(seen)).toEqual(Option.none());

    yield* notify("iter8.db-wal");
    yield* TestClock.adjust("499 millis");
    yield* realFs.remove(dbPath);
    yield* notify("iter8.db");
    yield* TestClock.adjust("499 millis");
    expect(yield* Queue.poll(seen)).toEqual(Option.none());
    yield* TestClock.adjust("1 millis");
    expect(yield* Queue.poll(seen)).toEqual(Option.some(unavailableSnapshot));
    expect(yield* Queue.poll(seen)).toEqual(Option.none());
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("delivers a store change to both concurrent subscribers", () =>
  Effect.gen(function* () {
    const { review, notify, realFs, dbPath } = yield* setup();
    const [first, second] = yield* Effect.all(
      [collectSnapshots(review), collectSnapshots(review)],
      { concurrency: "unbounded" },
    );
    expect(yield* Queue.take(first)).toEqual(expectedSnapshot);
    expect(yield* Queue.take(second)).toEqual(expectedSnapshot);

    yield* realFs.remove(dbPath);
    yield* notify("iter8.db");
    yield* TestClock.adjust("500 millis");
    expect(yield* Queue.poll(first)).toEqual(Option.some(unavailableSnapshot));
    expect(yield* Queue.poll(second)).toEqual(Option.some(unavailableSnapshot));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("retries watching a missing directory on the next subscription", () =>
  Effect.gen(function* () {
    const { review, watched, storeDir, dbPath, realFs, notify } = yield* setup({
      store: "missing-directory",
    });
    expect(yield* Stream.runHead(review.subscribe)).toEqual(Option.some(unavailableSnapshot));
    expect(watched).toEqual([]);

    yield* realFs.makeDirectory(storeDir);
    writeStore(dbPath);
    const seen = yield* collectSnapshots(review);
    expect(yield* Queue.take(seen)).toEqual(expectedSnapshot);
    expect(watched).toEqual([storeDir]);

    yield* realFs.remove(dbPath);
    yield* notify("iter8.db");
    yield* TestClock.adjust("500 millis");
    expect(yield* Queue.poll(seen)).toEqual(Option.some(unavailableSnapshot));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["missing-file", "missing-tables"] as const)(
  "reports a %s store as unavailable",
  (store) =>
    Effect.gen(function* () {
      const { review, watched, storeDir } = yield* setup({ store });
      expect(yield* Stream.runHead(review.subscribe)).toEqual(Option.some(unavailableSnapshot));
      expect(watched).toEqual([storeDir]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("the optional-service fallback emits once and refuses all mutations", () =>
  Effect.gen(function* () {
    const review = Iter8Review.unavailable;
    expect(yield* Stream.runCollect(review.subscribe)).toEqual([unavailableSnapshot]);
    for (const call of [
      review.createNote(createInput),
      review.updateNote(updateInput),
      review.deleteNote(deleteInput),
      review.sendRound(sendInput).pipe(Effect.asVoid),
    ]) {
      expect(yield* Effect.flip(call)).toMatchObject({
        _tag: "Iter8ReviewError",
        reason: "unavailable",
      });
    }
  }),
);

interface Request {
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly host: string | undefined;
  readonly origin: string | undefined;
  readonly token: string | ReadonlyArray<string> | undefined;
  readonly body: unknown;
}

interface Reply {
  readonly status: number;
  readonly json: unknown;
}

const withOverlay = Effect.fnUntraced(function* (
  reply: (request: Request) => Reply,
  generation = 7,
) {
  const requests: Array<Request> = [];
  const server = yield* Effect.acquireRelease(
    Effect.callback<NodeHttp.Server, Error>((resume) => {
      const server = NodeHttp.createServer((request, response) => {
        const chunks: Array<Buffer> = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.once("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const entry = {
            method: request.method,
            path: request.url,
            host: request.headers.host,
            origin: request.headers.origin,
            token: request.headers["x-iter8-token"],
            body: text === "" ? undefined : JSON.parse(text),
          };
          requests.push(entry);
          const result = reply(entry);
          response.writeHead(result.status, { "content-type": "application/json" });
          response.end(JSON.stringify(result.json));
        });
      });
      server.once("error", (error) => resume(Effect.fail(error)));
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP port");
  const { review, dbPath } = yield* setup({ port: address.port, generation });
  return { review, dbPath, requests, port: address.port };
});

const storedDraft = {
  intent: "change",
  body: "Use the same spacing",
  target: { kind: "element", anchor: { ...anchor, renderGeneration: 4 } },
  anchorStatus: "moved",
  capture: {
    url: "http://pg1.localhost:4173/plans?draft=1",
    theme: "light",
    omittedParts: ["screenshot"],
  },
} as const;
const userDraft = { id: "N2", author: { kind: "user" }, ...storedDraft };
const agentDraft = { id: "N3", author: { kind: "agent" }, ...storedDraft };

it.live("posts every user draft in overlay order with the page generation and caller key", () =>
  Effect.gen(function* () {
    const { review, requests, port } = yield* withOverlay(({ method }) =>
      method === "GET"
        ? { status: 200, json: [{ ...userDraft, id: "N8" }, agentDraft, userDraft] }
        : { status: 200, json: { outcome: "accepted", round: { id: "R9" } } },
    );

    expect(yield* review.sendRound(sendInput)).toEqual({ outcome: "accepted", roundId: "R9" });
    const pageAccess = {
      host: `pg1.localhost:${port}`,
      origin: `http://pg1.localhost:${port}`,
      token,
    };
    expect(requests).toEqual([
      { ...pageAccess, method: "GET", path: "/__iter8/drafts", body: undefined },
      {
        ...pageAccess,
        method: "POST",
        path: "/__iter8/rounds",
        body: { idempotencyKey: "checkout-request-01", noteIds: ["N8", "N2"], generation: 7 },
      },
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("passes through a repeated key and reads a new pairing generation when retried", () =>
  Effect.gen(function* () {
    let posts = 0;
    const { review, requests, dbPath } = yield* withOverlay(({ method }) => {
      if (method === "GET") return { status: 200, json: [userDraft] };
      posts += 1;
      return {
        status: 200,
        json:
          posts === 1
            ? { outcome: "refused", reason: "stale-generation" }
            : { outcome: "accepted", round: { id: "R5" } },
      };
    }, 0);

    const input = { pageId: "pg1", idempotencyKey: "request1" };
    expect(yield* review.sendRound(input)).toEqual({
      outcome: "refused",
      reason: "stale-generation",
    });
    withStore(dbPath, (db) => db.prepare("UPDATE pages SET generation = 1 WHERE id = 'pg1'").run());
    expect(yield* review.sendRound(input)).toEqual({ outcome: "accepted", roundId: "R5" });
    expect(requests.filter(({ method }) => method === "POST").map(({ body }) => body)).toEqual([
      { idempotencyKey: "request1", noteIds: ["N2"], generation: 0 },
      { idempotencyKey: "request1", noteIds: ["N2"], generation: 1 },
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(["session-gone", "no-pairing"] as const)("returns iter8's %s refusal", (reason) =>
  Effect.gen(function* () {
    const { review, requests } = yield* withOverlay(({ method }) =>
      method === "GET"
        ? { status: 200, json: [userDraft] }
        : { status: 200, json: { outcome: "refused", reason } },
    );
    const input = { pageId: "pg1", idempotencyKey: "a".repeat(100) };
    expect(yield* review.sendRound(input)).toEqual({ outcome: "refused", reason });
    expect(requests.at(1)?.body).toEqual({
      idempotencyKey: "a".repeat(100),
      noteIds: ["N2"],
      generation: 7,
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each([
  { name: "empty", drafts: [] },
  { name: "agent-only", drafts: [agentDraft] },
])("rejects $name draft lists before posting a round", ({ drafts }) =>
  Effect.gen(function* () {
    const { review, requests } = yield* withOverlay(() => ({ status: 200, json: drafts }));
    expect(yield* Effect.flip(review.sendRound(sendInput))).toMatchObject({
      _tag: "Iter8ReviewError",
      reason: "rejected",
      detail: "no drafts",
    });
    expect(requests.map(({ method, path }) => [method, path])).toEqual([
      ["GET", "/__iter8/drafts"],
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each([
  { name: "malformed", reply: { status: 200, json: { id: "N2" } }, reason: "incompatible" },
  { name: "refused", reply: { status: 403, json: {} }, reason: "rejected" },
])("propagates a $name draft read without writing a round or draft", ({ reply, reason }) =>
  Effect.gen(function* () {
    const { review, requests } = yield* withOverlay(() => reply);
    expect(yield* Effect.flip(review.sendRound(sendInput))).toMatchObject({
      _tag: "Iter8ReviewError",
      reason,
    });
    expect(yield* Effect.flip(review.updateNote(updateInput))).toMatchObject({
      _tag: "Iter8ReviewError",
      reason,
    });
    expect(requests.map(({ method, path }) => [method, path])).toEqual([
      ["GET", "/__iter8/drafts"],
      ["GET", "/__iter8/drafts"],
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "preserves the selected draft's target, anchor status and capture while replacing intent and body",
  () =>
    Effect.gen(function* () {
      const { review, requests } = yield* withOverlay(({ method }) =>
        method === "GET"
          ? {
              status: 200,
              json: [
                { ...agentDraft, id: "N2", capture: null },
                { ...userDraft, id: "N8", anchorStatus: "unanchored" },
                userDraft,
              ],
            }
          : { status: 200, json: { id: "N2" } },
      );
      expect(yield* review.updateNote(updateInput)).toBeUndefined();
      expect(requests.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
        { method: "GET", path: "/__iter8/drafts", body: undefined },
        {
          method: "PUT",
          path: "/__iter8/drafts/N2",
          body: {
            intent: "keep",
            body: "",
            target: storedDraft.target,
            anchorStatus: "moved",
            capture: storedDraft.capture,
          },
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(["", "N3", "N99"])(
  "does not write an edit for an unset or non-user draft id %j",
  (noteId) =>
    Effect.gen(function* () {
      const { review, requests } = yield* withOverlay(() => ({
        status: 200,
        json: [userDraft, agentDraft],
      }));
      expect(yield* Effect.flip(review.updateNote({ ...updateInput, noteId }))).toMatchObject({
        _tag: "Iter8ReviewError",
        reason: "unknown-note",
      });
      expect(requests.map(({ method, path }) => [method, path])).toEqual([
        ["GET", "/__iter8/drafts"],
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("creates a picked draft and deletes the named note through the overlay", () =>
  Effect.gen(function* () {
    const { review, requests } = yield* withOverlay(({ method }) =>
      method === "POST" ? { status: 201, json: { id: "N2" } } : { status: 200, json: { ok: true } },
    );
    expect(yield* review.createNote(createInput)).toBeUndefined();
    expect(yield* review.deleteNote(deleteInput)).toBeUndefined();
    expect(requests.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      {
        method: "POST",
        path: "/__iter8/drafts",
        body: {
          intent: "fix",
          body: "Align the confirmation button",
          target: { kind: "element", anchor: { ...anchor, renderGeneration: 0 } },
          anchorStatus: "anchored",
          capture: {
            completeness: "partial",
            omittedParts: [
              "landmark",
              "surroundingText",
              "computedStyles",
              "consoleErrors",
              "screenshot",
              "sourceLead",
            ],
            url: "http://pg1.localhost:4173/confirm?step=2",
            viewport: { width: 1200, height: 720, devicePixelRatio: 2 },
            theme: "dark",
          },
        },
      },
      { method: "DELETE", path: "/__iter8/drafts/N2", body: undefined },
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["", "pg99"])("returns unknown-page on all mutations of page %j", (pageId) =>
  Effect.gen(function* () {
    const { review } = yield* setup();
    for (const result of [
      review.createNote({ ...createInput, pageId }),
      review.updateNote({ ...updateInput, pageId }),
      review.deleteNote({ ...deleteInput, pageId }),
      review.sendRound({ ...sendInput, pageId }).pipe(Effect.asVoid),
    ]) {
      expect(yield* Effect.flip(result)).toMatchObject({
        _tag: "Iter8ReviewError",
        reason: "unknown-page",
      });
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

const reviewMethods = [
  WS_METHODS.iter8SubscribeReview,
  WS_METHODS.iter8CreateNote,
  WS_METHODS.iter8UpdateNote,
  WS_METHODS.iter8DeleteNote,
  WS_METHODS.iter8SendRound,
] as const;

const sendRoundRpc = WsRpcGroup.requests.get(WS_METHODS.iter8SendRound);
if (sendRoundRpc?._tag !== "iter8.sendRound") throw new Error("Expected the iter8.sendRound RPC");
const isSendRoundPayload = Schema.is(sendRoundRpc.payloadSchema);

it.each([
  { key: undefined, valid: false },
  { key: 12345678, valid: false },
  { key: "", valid: false },
  { key: "a".repeat(7), valid: false },
  { key: "a".repeat(8), valid: true },
  { key: "a".repeat(100), valid: true },
  { key: "a".repeat(101), valid: false },
])("validates the round key at the RPC boundary ($key)", ({ key, valid }) => {
  const payload = key === undefined ? { pageId: "pg1" } : { pageId: "pg1", idempotencyKey: key };
  expect(isSendRoundPayload(payload)).toBe(valid);
});

it.effect("lets read-only clients subscribe and denies every mutation before its handler", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
          (typeof reviewMethods)[number]
        > => !(reviewMethods as ReadonlyArray<string>).includes(tag),
      ),
    );
    const handled: Array<string> = [];
    const record = (method: string) =>
      Effect.sync(() => {
        handled.push(method);
      });
    const accepted = { outcome: "accepted", roundId: "R9" } as const;
    const handlers = group.toLayer({
      [WS_METHODS.iter8SubscribeReview]: () => Stream.make(expectedSnapshot),
      [WS_METHODS.iter8CreateNote]: () => record("create"),
      [WS_METHODS.iter8UpdateNote]: () => record("update"),
      [WS_METHODS.iter8DeleteNote]: () => record("delete"),
      [WS_METHODS.iter8SendRound]: () => record("send").pipe(Effect.as(accepted)),
    });
    const reader = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(Layer.merge(handlers, RpcAuthorization.layer([AuthOrchestrationReadScope]))),
    );
    expect(yield* Stream.runCollect(reader[WS_METHODS.iter8SubscribeReview]({}))).toEqual([
      expectedSnapshot,
    ]);

    for (const call of [
      reader[WS_METHODS.iter8CreateNote](createInput),
      reader[WS_METHODS.iter8UpdateNote](updateInput),
      reader[WS_METHODS.iter8DeleteNote](deleteInput),
      reader[WS_METHODS.iter8SendRound](sendInput).pipe(Effect.asVoid),
    ]) {
      expect(yield* Effect.flip(call)).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredScope: AuthOrchestrationOperateScope,
        requiredPermission: AuthOrchestrationOperateScope,
      });
    }
    expect(handled).toEqual([]);

    const operator = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.merge(handlers, RpcAuthorization.layer([AuthOrchestrationOperateScope])),
      ),
    );
    yield* operator[WS_METHODS.iter8CreateNote](createInput);
    yield* operator[WS_METHODS.iter8UpdateNote](updateInput);
    yield* operator[WS_METHODS.iter8DeleteNote](deleteInput);
    expect(yield* operator[WS_METHODS.iter8SendRound](sendInput)).toEqual(accepted);
    expect(handled).toEqual(["create", "update", "delete", "send"]);
    expect(
      yield* Stream.runCollect(operator[WS_METHODS.iter8SubscribeReview]({})).pipe(Effect.flip),
    ).toMatchObject({
      _tag: "EnvironmentAuthorizationError",
      requiredScope: AuthOrchestrationReadScope,
    });
  }),
);
