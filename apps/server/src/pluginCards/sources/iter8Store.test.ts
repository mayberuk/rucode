// @effect-diagnostics nodeBuiltinImport:off - the fixtures are real SQLite files, as iter8 writes them.
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { Iter8ReviewSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";

import { readPageAccess, readReviewSnapshot, resolveIter8DbPath } from "./iter8Store.ts";

const DDL = {
  owners: `CREATE TABLE owners (
  id TEXT PRIMARY KEY NOT NULL,
  agent TEXT NOT NULL,
  pid INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  label TEXT NOT NULL,
  cwd TEXT NOT NULL,
  created_at TEXT NOT NULL,
  relabel_pending INTEGER NOT NULL,
  busy INTEGER NOT NULL,
  gone_reason TEXT,
  UNIQUE (pid, started_at)
)`,
  pages: `CREATE TABLE pages (
  id TEXT PRIMARY KEY NOT NULL,
  token TEXT NOT NULL,
  project_root TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('server', 'folder')),
  target TEXT NOT NULL,
  port INTEGER NOT NULL,
  owner_id TEXT REFERENCES owners(id),
  generation INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_root, target_kind, target)
)`,
  rounds: `CREATE TABLE rounds (
  id TEXT PRIMARY KEY NOT NULL,
  page_id TEXT NOT NULL REFERENCES pages(id),
  owner_id TEXT REFERENCES owners(id),
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL
)`,
  notes: `CREATE TABLE notes (
  id TEXT PRIMARY KEY NOT NULL,
  page_id TEXT NOT NULL REFERENCES pages(id),
  round_id TEXT REFERENCES rounds(id),
  kind TEXT NOT NULL CHECK (kind IN ('draft', 'sent', 'agent')),
  ordinal INTEGER NOT NULL,
  author_json TEXT NOT NULL,
  intent TEXT NOT NULL,
  body TEXT NOT NULL,
  target_json TEXT NOT NULL,
  anchor_status TEXT NOT NULL,
  capture_json TEXT,
  resolution_json TEXT NOT NULL,
  created_at TEXT NOT NULL
)`,
} as const;

type Table = keyof typeof DDL;

const box = { x: 10, y: 20, width: 100, height: 30 };
const viewport = { width: 1280, height: 800, devicePixelRatio: 2 };
const user = JSON.stringify({ kind: "user" });
const agentAuthor = JSON.stringify({
  kind: "agent",
  owner: "own_a",
  name: "Claude",
  agent: "claude",
});
const open = JSON.stringify({ status: "open" });
const done = JSON.stringify({ status: "done", at: "2026-11-20T10:05:00.000Z" });
const answered = JSON.stringify({
  status: "answered",
  reply: "It stacks below 640px.",
  at: "2026-11-20T10:06:00.000Z",
});
const element = (anchor: Record<string, unknown>) =>
  JSON.stringify({ kind: "element", anchor: { box, renderGeneration: 1, ...anchor } });
const capture = (url: string) =>
  JSON.stringify({ completeness: "partial", omittedParts: [], url, viewport, theme: "light" });

interface NoteRow {
  readonly id: string;
  readonly page: string;
  readonly round: string | null;
  readonly kind: "draft" | "sent" | "agent";
  readonly ordinal: number;
  readonly author: string;
  readonly intent: string;
  readonly body: string;
  readonly target: string;
  readonly capture: string | null;
  readonly resolution: string;
}

// Inserted out of ordinal order so the expectation sees the reader's ordering.
const NOTES: ReadonlyArray<NoteRow> = [
  {
    id: "N3",
    page: "pg1",
    round: "R1",
    kind: "sent",
    ordinal: 4,
    author: user,
    intent: "question",
    body: "Should these cards wrap?",
    target: JSON.stringify({
      kind: "elements",
      anchors: [
        {
          selector: ["section > article:nth-of-type(1)"],
          name: "First card",
          box,
          renderGeneration: 1,
        },
        {
          selector: ["section > article:nth-of-type(2)"],
          name: "Second card",
          box,
          renderGeneration: 1,
        },
      ],
    }),
    capture: capture("not a url"),
    resolution: open,
  },
  {
    id: "N5",
    page: "pg1",
    round: null,
    kind: "draft",
    ordinal: 1,
    author: user,
    intent: "fix",
    body: "Link goes to the wrong tier",
    target: element({ selector: ["main", "a.plans"], name: "Plans link", text: "See plans" }),
    capture: capture("http://pg1.localhost:4173/plans?tier=pro#top"),
    resolution: open,
  },
  {
    id: "N1",
    page: "pg1",
    round: "R1",
    kind: "sent",
    ordinal: 2,
    author: user,
    intent: "change",
    body: "Make the confirm button wider",
    target: element({ selector: ["app-root", "button.confirm"] }),
    capture: capture("http://pg1.localhost:4173/confirm"),
    resolution: done,
  },
  {
    id: "N2",
    page: "pg1",
    round: "R1",
    kind: "sent",
    ordinal: 3,
    author: user,
    intent: "question",
    body: "Does this band collapse on small screens?",
    target: JSON.stringify({ kind: "region", box, viewport }),
    capture: null,
    resolution: answered,
  },
  {
    id: "N4",
    page: "pg1",
    round: "R2",
    kind: "sent",
    ordinal: 5,
    author: user,
    intent: "keep",
    body: "Keep the dock ring",
    target: JSON.stringify({
      kind: "iter8",
      part: { key: "dock.ring", name: "Dock ring", source: "x.tsx" },
      iter8Version: "0.4.4",
      box,
      viewport,
    }),
    capture: capture("http://pg1.localhost:4173/"),
    resolution: open,
  },
  {
    id: "N6",
    page: "pg1",
    round: null,
    kind: "agent",
    ordinal: 6,
    author: agentAuthor,
    intent: "question",
    body: "I moved the toggle; better?",
    target: element({ selector: ["div.toggle"], name: "Plan toggle" }),
    capture: null,
    resolution: open,
  },
  {
    id: "N7",
    page: "pg1",
    round: null,
    kind: "agent",
    ordinal: 7,
    author: agentAuthor,
    intent: "change",
    body: "Spacing adjusted",
    target: JSON.stringify({ kind: "region", box, viewport }),
    capture: null,
    resolution: done,
  },
  {
    id: "N8",
    page: "pg1",
    round: null,
    kind: "draft",
    ordinal: 8,
    author: user,
    intent: "fix",
    body: "Unreadable resolution",
    target: element({ selector: ["p"] }),
    capture: null,
    resolution: "not json",
  },
  {
    id: "N9",
    page: "pg2",
    round: null,
    kind: "draft",
    ordinal: 9,
    author: user,
    intent: "fix",
    body: "Footer overlaps",
    target: element({ selector: ["footer"] }),
    capture: capture("http://pg2.localhost:4174/"),
    resolution: open,
  },
];

const writeStore = (
  file: string,
  options: { readonly omitTable?: Table; readonly dropColumn?: readonly [Table, string] } = {},
) => {
  const db = new NodeSqlite.DatabaseSync(file, { enableForeignKeyConstraints: false });
  try {
    for (const table of Object.keys(DDL) as ReadonlyArray<Table>) {
      if (table === options.omitTable) continue;
      const [dropTable, dropColumn] = options.dropColumn ?? [];
      const ddl =
        dropTable === table
          ? DDL[table].replace(new RegExp(`\\n  ${dropColumn} [^\\n]*`), "")
          : DDL[table];
      db.exec(ddl);
    }
    const insert = (table: Table, row: Record<string, string | number | null>) => {
      if (table === options.omitTable) return;
      const columns = Object.keys(row).filter(
        (column) => !(options.dropColumn?.[0] === table && options.dropColumn[1] === column),
      );
      db.prepare(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      ).run(...columns.map((column) => row[column]!));
    };
    const owner = (
      id: string,
      pid: number,
      agent: string,
      busy: number,
      goneReason: string | null,
    ) =>
      insert("owners", {
        id,
        agent,
        pid,
        started_at: "s",
        label: `label-${id}`,
        cwd: "/work/acme-app",
        created_at: "2026-11-01T00:00:00.000Z",
        relabel_pending: 0,
        busy,
        gone_reason: goneReason,
      });
    owner("own_a", 1, "claude", 1, null);
    owner("own_b", 2, "codex", 1, "exited");
    owner("own_c", 3, "claude", 0, null);
    owner("own_d", 4, "claude", 0, "crashed");

    const page = (id: string, port: number, ownerId: string | null, createdAt: string) =>
      insert("pages", {
        id,
        token: `token-${id}`,
        project_root: "/work/acme-app",
        target_kind: "server",
        target: `http://127.0.0.1:${port - 1000}`,
        port,
        owner_id: ownerId,
        generation: 2,
        created_at: createdAt,
      });
    page("pg1", 4173, "own_a", "2026-11-01T00:00:00.000Z");
    page("pg2", 4174, "own_b", "2026-11-03T00:00:00.000Z");
    page("pg3", 4175, null, "2026-11-02T00:00:00.000Z");

    insert("rounds", {
      id: "R2",
      page_id: "pg1",
      owner_id: "own_a",
      state_json: JSON.stringify({ stage: "queued", queuedAt: "x", idempotencyKey: "send-abc" }),
      created_at: "2026-11-20T11:00:00.000Z",
    });
    insert("rounds", {
      id: "R1",
      page_id: "pg1",
      owner_id: "own_a",
      state_json: JSON.stringify({ stage: "claimed", claimedAt: "x" }),
      created_at: "2026-11-20T10:00:00.000Z",
    });

    for (const note of NOTES) {
      insert("notes", {
        id: note.id,
        page_id: note.page,
        round_id: note.round,
        kind: note.kind,
        ordinal: note.ordinal,
        author_json: note.author,
        intent: note.intent,
        body: note.body,
        target_json: note.target,
        anchor_status: "anchored",
        capture_json: note.capture,
        resolution_json: note.resolution,
        created_at: `2026-11-20T10:0${note.ordinal}:00.000Z`,
      });
    }
  } finally {
    db.close();
  }
};

const created = (ordinal: number) => `2026-11-20T10:0${ordinal}:00.000Z`;

const EXPECTED: Iter8ReviewSnapshot = {
  available: true,
  sessions: [
    {
      ownerId: "own_a",
      agent: "claude",
      label: "label-own_a",
      cwd: "/work/acme-app",
      state: "busy",
      pageIds: ["pg1"],
    },
    {
      ownerId: "own_b",
      agent: "codex",
      label: "label-own_b",
      cwd: "/work/acme-app",
      state: "gone",
      pageIds: ["pg2"],
    },
    {
      ownerId: "own_c",
      agent: "claude",
      label: "label-own_c",
      cwd: "/work/acme-app",
      state: "live",
      pageIds: [],
    },
  ],
  pages: [
    {
      id: "pg2",
      origin: "http://pg2.localhost:4174",
      projectRoot: "/work/acme-app",
      ownerId: "own_b",
      rounds: [],
      notes: [
        {
          id: "N9",
          pageId: "pg2",
          roundId: null,
          author: { kind: "user" },
          intent: "fix",
          body: "Footer overlaps",
          selector: ["footer"],
          anchorLabel: "footer",
          path: "/",
          status: "draft",
          reply: null,
          createdAt: created(9),
        },
      ],
    },
    {
      id: "pg3",
      origin: "http://pg3.localhost:4175",
      projectRoot: "/work/acme-app",
      ownerId: null,
      rounds: [],
      notes: [],
    },
    {
      id: "pg1",
      origin: "http://pg1.localhost:4173",
      projectRoot: "/work/acme-app",
      ownerId: "own_a",
      rounds: [
        {
          id: "R1",
          pageId: "pg1",
          stage: "claimed",
          noteCount: 3,
          createdAt: "2026-11-20T10:00:00.000Z",
        },
        {
          id: "R2",
          pageId: "pg1",
          stage: "queued",
          noteCount: 1,
          createdAt: "2026-11-20T11:00:00.000Z",
        },
      ],
      notes: [
        {
          id: "N5",
          pageId: "pg1",
          roundId: null,
          author: { kind: "user" },
          intent: "fix",
          body: "Link goes to the wrong tier",
          selector: ["main", "a.plans"],
          anchorLabel: "Plans link",
          path: "/plans?tier=pro",
          status: "draft",
          reply: null,
          createdAt: created(1),
        },
        {
          id: "N1",
          pageId: "pg1",
          roundId: "R1",
          author: { kind: "user" },
          intent: "change",
          body: "Make the confirm button wider",
          selector: ["app-root", "button.confirm"],
          anchorLabel: "button.confirm",
          path: "/confirm",
          status: "done",
          reply: null,
          createdAt: created(2),
        },
        {
          id: "N2",
          pageId: "pg1",
          roundId: "R1",
          author: { kind: "user" },
          intent: "question",
          body: "Does this band collapse on small screens?",
          selector: [],
          anchorLabel: null,
          path: null,
          status: "answered",
          reply: "It stacks below 640px.",
          createdAt: created(3),
        },
        {
          id: "N3",
          pageId: "pg1",
          roundId: "R1",
          author: { kind: "user" },
          intent: "question",
          body: "Should these cards wrap?",
          selector: ["section > article:nth-of-type(1)"],
          anchorLabel: "First card",
          path: null,
          status: "sent",
          reply: null,
          createdAt: created(4),
        },
        {
          id: "N4",
          pageId: "pg1",
          roundId: "R2",
          author: { kind: "user" },
          intent: "keep",
          body: "Keep the dock ring",
          selector: [],
          anchorLabel: null,
          path: "/",
          status: "sent",
          reply: null,
          createdAt: created(5),
        },
        {
          id: "N6",
          pageId: "pg1",
          roundId: null,
          author: { kind: "agent", name: "Claude" },
          intent: "question",
          body: "I moved the toggle; better?",
          selector: [],
          anchorLabel: "Plan toggle",
          path: null,
          status: "sent",
          reply: null,
          createdAt: created(6),
        },
        {
          id: "N7",
          pageId: "pg1",
          roundId: null,
          author: { kind: "agent", name: "Claude" },
          intent: "change",
          body: "Spacing adjusted",
          selector: [],
          anchorLabel: null,
          path: null,
          status: "done",
          reply: null,
          createdAt: created(7),
        },
      ],
    },
  ],
};

const UNAVAILABLE = { available: false, sessions: [], pages: [] };

const captureWarnings = () => {
  const warnings: Array<unknown> = [];
  const logger = Logger.make(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(message);
  });
  return { warnings, logger };
};

const tempStore = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-iter8-store-" });
  return { fs, path, dbPath: path.join(root, "iter8.db") };
});

it.layer(NodeServices.layer)("iter8 store", (it) => {
  it.effect("reads sessions, pages, rounds and notes as iter8 recorded them", () =>
    Effect.gen(function* () {
      const { dbPath } = yield* tempStore();
      writeStore(dbPath);
      const { warnings, logger } = captureWarnings();
      const snapshot = yield* readReviewSnapshot(dbPath).pipe(Effect.withLogger(logger));
      expect(snapshot).toEqual(EXPECTED);
      expect(warnings).toEqual([
        ["iter8 note skipped: unreadable record", { path: dbPath, note: "N8" }],
      ]);
    }),
  );

  it.effect("is unavailable, with one warning naming the path, when the store is missing", () =>
    Effect.gen(function* () {
      const { fs, dbPath } = yield* tempStore();
      const { warnings, logger } = captureWarnings();
      expect(yield* readReviewSnapshot(dbPath).pipe(Effect.withLogger(logger))).toEqual(
        UNAVAILABLE,
      );
      expect(warnings).toHaveLength(1);
      expect(JSON.stringify(warnings)).toContain(dbPath);
      expect(yield* fs.exists(dbPath)).toBe(false);
    }),
  );

  it.effect("is unavailable when a table the reader uses is missing", () =>
    Effect.gen(function* () {
      for (const table of ["owners", "pages", "rounds", "notes"] as const) {
        const { dbPath } = yield* tempStore();
        writeStore(dbPath, { omitTable: table });
        const { warnings, logger } = captureWarnings();
        expect(yield* readReviewSnapshot(dbPath).pipe(Effect.withLogger(logger)), table).toEqual(
          UNAVAILABLE,
        );
        expect(warnings, table).toHaveLength(1);
      }
    }),
  );

  it.effect("is unavailable when a column the reader uses is missing", () =>
    Effect.gen(function* () {
      const columns = [
        ["owners", "gone_reason"],
        ["owners", "busy"],
        ["pages", "owner_id"],
        ["pages", "created_at"],
        ["rounds", "state_json"],
        ["notes", "resolution_json"],
        ["notes", "round_id"],
        ["notes", "kind"],
      ] as const;
      for (const dropColumn of columns) {
        const { dbPath } = yield* tempStore();
        writeStore(dbPath, { dropColumn });
        const { warnings, logger } = captureWarnings();
        const label = dropColumn.join(".");
        expect(yield* readReviewSnapshot(dbPath).pipe(Effect.withLogger(logger)), label).toEqual(
          UNAVAILABLE,
        );
        expect(warnings, label).toHaveLength(1);
      }
    }),
  );

  it.effect("leaves the store byte for byte unchanged", () =>
    Effect.gen(function* () {
      const { fs, dbPath } = yield* tempStore();
      writeStore(dbPath);
      const before = yield* fs.readFile(dbPath);
      yield* readReviewSnapshot(dbPath);
      yield* readPageAccess(dbPath, "pg1");
      expect(yield* fs.readFile(dbPath)).toEqual(before);
    }),
  );

  it.effect("reads one page's port, token, generation and owner", () =>
    Effect.gen(function* () {
      const { dbPath } = yield* tempStore();
      writeStore(dbPath);
      expect(yield* readPageAccess(dbPath, "pg3")).toEqual({
        pageId: "pg3",
        port: 4175,
        token: "token-pg3",
        generation: 2,
        ownerId: null,
      });
      expect(yield* readPageAccess(dbPath, "pg1")).toEqual({
        pageId: "pg1",
        port: 4173,
        token: "token-pg1",
        generation: 2,
        ownerId: "own_a",
      });
      expect(yield* readPageAccess(dbPath, "pg9")).toBeNull();
    }),
  );

  it.effect("has no page access when the store is missing", () =>
    Effect.gen(function* () {
      const { dbPath } = yield* tempStore();
      expect(yield* readPageAccess(dbPath, "pg1")).toBeNull();
    }),
  );

  it.effect("finds the store under ITER8_HOME, else under ~/.iter8", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(resolveIter8DbPath("/home/u", undefined, path.join)).toBe("/home/u/.iter8/iter8.db");
      expect(resolveIter8DbPath("/home/u", "", path.join)).toBe("/home/u/.iter8/iter8.db");
      expect(resolveIter8DbPath("/home/u", "/srv/iter8", path.join)).toBe("/srv/iter8/iter8.db");
    }),
  );
});
