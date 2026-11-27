// @effect-diagnostics nodeBuiltinImport:off - the fixture is a real loopback HTTP server standing in for iter8.
import * as NodeHttp from "node:http";

import { expect, it } from "@effect/vitest";
import { Iter8ReviewError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  createDraft,
  deleteDraft,
  draftBodyFromCreateInput,
  type Iter8OverlayTarget,
  listDrafts,
  putDraft,
  sendRound,
} from "./iter8OverlayClient.ts";

const TOKEN = "tok-9f8e7d6c5b4a";

interface Seen {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}

interface Reply {
  readonly status: number;
  readonly body?: string;
}

const json = (status: number, value: unknown): Reply => ({ status, body: JSON.stringify(value) });

const portOf = (server: NodeHttp.Server) => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  return address.port;
};

const listen = (handler: NodeHttp.RequestListener) =>
  Effect.acquireRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer(handler);
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.sync(() => {
        server.closeAllConnections();
        server.close();
      }),
  );

const withIter8 = <A, E>(
  reply: (seen: Seen) => Reply,
  run: (target: Iter8OverlayTarget, seen: ReadonlyArray<Seen>) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen: Array<Seen> = [];
      const server = yield* listen((request, response) => {
        const chunks: Array<Buffer> = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const entry = {
            method: request.method,
            url: request.url,
            headers: request.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          };
          seen.push(entry);
          const { status, body } = reply(entry);
          response.writeHead(status, { "content-type": "application/json" });
          response.end(body);
        });
      });
      return yield* run({ pageId: "pg1", port: portOf(server), token: TOKEN }, seen);
    }),
  );

const pageHeaders = (port: number) => ({
  host: `pg1.localhost:${port}`,
  origin: `http://pg1.localhost:${port}`,
  "x-iter8-token": TOKEN,
});

const anchor = {
  selector: ["app-root", "button.confirm"],
  role: "button",
  name: "Confirm",
  box: { x: 48, y: 420, width: 140, height: 40 },
} as const;

// iter8's DraftBody for an element pick with only the url, viewport and theme captured.
const PICKED_DRAFT_BODY = {
  intent: "change",
  body: "Make the confirm button wider",
  target: {
    kind: "element",
    anchor: {
      selector: ["app-root", "button.confirm"],
      role: "button",
      name: "Confirm",
      box: { x: 48, y: 420, width: 140, height: 40 },
      renderGeneration: 0,
    },
  },
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
    url: "http://pg1.localhost:4173/confirm",
    viewport: { width: 1280, height: 800, devicePixelRatio: 2 },
    theme: "dark",
  },
} as const;

const storedNote = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  pageId: "pg1",
  author: { kind: "user" },
  createdAt: "2026-11-20T10:00:00.000Z",
  resolution: { status: "open" },
  ...PICKED_DRAFT_BODY,
  ...extra,
});

const regionTarget = {
  kind: "region",
  box: { x: 0, y: 280, width: 1280, height: 320 },
  viewport: { width: 1280, height: 800, devicePixelRatio: 2 },
};

const expectReviewError = (exit: Exit.Exit<unknown, Iter8ReviewError>, reason: string) => {
  const error = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : null;
  expect(error?._tag).toBe("Some");
  const value = error?._tag === "Some" ? error.value : null;
  expect(value).toBeInstanceOf(Iter8ReviewError);
  expect(value?.reason).toBe(reason);
  expect(value?.detail).toEqual(expect.any(String));
  for (const text of [value?.message, value?.detail, JSON.stringify(value), String(value)]) {
    expect(text).not.toContain(TOKEN);
  }
};

it.live("creates a draft in iter8's DraftBody shape with the page's Host, Origin and token", () =>
  withIter8(
    () => json(201, storedNote("N14")),
    (target, seen) =>
      Effect.gen(function* () {
        const body = draftBodyFromCreateInput({
          pageId: "pg1",
          intent: "change",
          body: "Make the confirm button wider",
          anchor,
          url: "http://pg1.localhost:4173/confirm",
          viewport: { width: 1280, height: 800, devicePixelRatio: 2 },
          theme: "dark",
        });
        expect(body).toEqual(PICKED_DRAFT_BODY);
        expect(yield* createDraft(target, body)).toBe("N14");
        expect(seen).toHaveLength(1);
        expect(seen[0]?.method).toBe("POST");
        expect(seen[0]?.url).toBe("/__iter8/drafts");
        expect(seen[0]?.headers).toMatchObject({
          ...pageHeaders(target.port),
          "content-type": "application/json",
        });
        expect(JSON.parse(seen[0]?.body ?? "")).toEqual(PICKED_DRAFT_BODY);
      }),
  ),
);

it.live("replaces a draft with PUT on the note's route", () =>
  withIter8(
    () => json(200, storedNote("N14", { intent: "fix", body: "Wider still" })),
    (target, seen) =>
      Effect.gen(function* () {
        const edited = { ...PICKED_DRAFT_BODY, intent: "fix", body: "Wider still" } as const;
        yield* putDraft(target, "N14", edited);
        expect(seen[0]?.method).toBe("PUT");
        expect(seen[0]?.url).toBe("/__iter8/drafts/N14");
        expect(seen[0]?.headers).toMatchObject({
          ...pageHeaders(target.port),
          "content-type": "application/json",
        });
        expect(JSON.parse(seen[0]?.body ?? "")).toEqual(edited);
      }),
  ),
);

it.live("deletes a draft with DELETE and no body", () =>
  withIter8(
    () => json(200, { ok: true }),
    (target, seen) =>
      Effect.gen(function* () {
        yield* deleteDraft(target, "N14");
        expect(seen[0]?.method).toBe("DELETE");
        expect(seen[0]?.url).toBe("/__iter8/drafts/N14");
        expect(seen[0]?.headers).toMatchObject(pageHeaders(target.port));
        expect(seen[0]?.headers["content-type"]).toBeUndefined();
        expect(seen[0]?.body).toBe("");
      }),
  ),
);

it.live("lists only the user's drafts, keeping a non-element target as iter8 stored it", () =>
  withIter8(
    () =>
      json(200, [
        storedNote("N14"),
        storedNote("N15", { target: regionTarget, anchorStatus: "moved" }),
        storedNote("N16", {
          author: { kind: "agent", owner: "own_a", name: "Claude", agent: "claude" },
        }),
      ]),
    (target, seen) =>
      Effect.gen(function* () {
        expect(yield* listDrafts(target)).toEqual([
          { id: "N14", draft: PICKED_DRAFT_BODY },
          {
            id: "N15",
            draft: { ...PICKED_DRAFT_BODY, target: regionTarget, anchorStatus: "moved" },
          },
        ]);
        expect(seen[0]?.method).toBe("GET");
        expect(seen[0]?.url).toBe("/__iter8/drafts");
        expect(seen[0]?.headers).toMatchObject(pageHeaders(target.port));
        expect(seen[0]?.headers["content-type"]).toBeUndefined();
      }),
  ),
);

it.live(
  "sends a round with the idempotency key, note ids and generation, and reads it accepted",
  () =>
    withIter8(
      () =>
        json(200, {
          outcome: "accepted",
          round: {
            id: "R13",
            pageId: "pg1",
            owner: "own_a",
            state: { stage: "queued", queuedAt: "2026-11-20T10:00:00.000Z", idempotencyKey: "k" },
            notes: [storedNote("N14")],
          },
        }),
      (target, seen) =>
        Effect.gen(function* () {
          const result = yield* sendRound(target, {
            idempotencyKey: "send-0123456789",
            noteIds: ["N14", "N15"],
            generation: 3,
          });
          expect(result).toEqual({ outcome: "accepted", roundId: "R13" });
          expect(seen[0]?.method).toBe("POST");
          expect(seen[0]?.url).toBe("/__iter8/rounds");
          expect(seen[0]?.headers).toMatchObject({
            ...pageHeaders(target.port),
            "content-type": "application/json",
          });
          expect(JSON.parse(seen[0]?.body ?? "")).toEqual({
            idempotencyKey: "send-0123456789",
            noteIds: ["N14", "N15"],
            generation: 3,
          });
        }),
    ),
);

it.live("reads a refused send with iter8's reason", () =>
  withIter8(
    () => json(200, { outcome: "refused", reason: "stale-generation", pairing: null }),
    (target) =>
      Effect.gen(function* () {
        const result = yield* sendRound(target, {
          idempotencyKey: "send-0123456789",
          noteIds: ["N14"],
          generation: 1,
        });
        expect(result).toEqual({ outcome: "refused", reason: "stale-generation" });
      }),
  ),
);

it.live("maps iter8's refusals and unreadable answers to typed reasons without the token", () =>
  Effect.gen(function* () {
    const draft = draftBodyFromCreateInput({
      pageId: "pg1",
      intent: "fix",
      body: "x",
      anchor,
      url: "http://pg1.localhost:4173/",
      viewport: { width: 1280, height: 800, devicePixelRatio: 1 },
      theme: "light",
    });
    const send = { idempotencyKey: "send-0123456789", noteIds: ["N14"], generation: 1 };
    const cases = [
      [{ status: 401 }, (t: Iter8OverlayTarget) => createDraft(t, draft), "rejected"],
      [{ status: 403 }, (t: Iter8OverlayTarget) => listDrafts(t), "rejected"],
      [{ status: 404 }, (t: Iter8OverlayTarget) => putDraft(t, "N14", draft), "unknown-note"],
      [{ status: 404 }, (t: Iter8OverlayTarget) => deleteDraft(t, "N14"), "unknown-note"],
      [{ status: 404 }, (t: Iter8OverlayTarget) => listDrafts(t), "unknown-page"],
      [{ status: 404 }, (t: Iter8OverlayTarget) => createDraft(t, draft), "unknown-page"],
      [{ status: 400 }, (t: Iter8OverlayTarget) => createDraft(t, draft), "incompatible"],
      [{ status: 200, body: "<html>" }, (t: Iter8OverlayTarget) => listDrafts(t), "incompatible"],
      [
        json(200, { outcome: "queued", roundId: "R1" }),
        (t: Iter8OverlayTarget) => sendRound(t, send),
        "incompatible",
      ],
      [
        json(200, { outcome: "refused", reason: "too-late" }),
        (t: Iter8OverlayTarget) => sendRound(t, send),
        "incompatible",
      ],
      [json(201, { noId: true }), (t: Iter8OverlayTarget) => createDraft(t, draft), "incompatible"],
      [{ status: 500 }, (t: Iter8OverlayTarget) => listDrafts(t), "unavailable"],
    ] as const;
    for (const [reply, request, reason] of cases) {
      const exit = yield* withIter8(
        () => reply,
        (target) => Effect.exit(request(target)),
      );
      expectReviewError(exit as Exit.Exit<unknown, Iter8ReviewError>, reason);
    }
  }),
);

it.live("reports iter8 unavailable when nothing listens on the page's port", () =>
  Effect.gen(function* () {
    const port = yield* Effect.scoped(
      Effect.map(
        listen(() => {}),
        portOf,
      ),
    );
    const exit = yield* Effect.exit(listDrafts({ pageId: "pg1", port, token: TOKEN }));
    expectReviewError(exit, "unavailable");
  }),
);

it.effect("gives up as unavailable when iter8 has not answered after 5 seconds", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let received: () => void = () => {};
      const arrived = new Promise<void>((resolve) => {
        received = resolve;
      });
      const server = yield* listen(() => received());
      const fiber = yield* Effect.forkChild(
        Effect.exit(listDrafts({ pageId: "pg1", port: portOf(server), token: TOKEN })),
      );
      yield* Effect.promise(() => arrived);
      yield* TestClock.adjust("4999 millis");
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 millis");
      expectReviewError(yield* Fiber.join(fiber), "unavailable");
    }),
  ),
);
