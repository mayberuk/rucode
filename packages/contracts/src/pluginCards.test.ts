import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "./auth.ts";
import { ThreadId, TurnItemId } from "./baseSchemas.ts";
import { CLIENT_GUARDED_RPC_SCOPES, clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import {
  PluginCard,
  PluginCardAsset,
  PluginCardError,
  PluginCardErrorReason,
  PluginCardKind,
  type PluginCard as PluginCardType,
} from "./pluginCards.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

const threadId = ThreadId.make("thread-1");
const base = {
  threadId,
  placement: { type: "turnItem", turnItemId: TurnItemId.make("item-1") },
  updatedAt: "2026-11-21T10:00:00Z",
  actions: [
    { id: "a1", label: "Open", type: "message", message: "show it" },
    { id: "a2", label: "Run", type: "command" },
  ],
} as const;

const decisionData = {
  decisionId: "d1",
  dir: "/repo",
  decisionKind: "scope",
  question: "Which way?",
  options: [
    { key: "a", label: "Left", recommended: true },
    { key: "b", label: "Right", recommended: false },
  ],
  defaultKey: "a",
  state: "open",
  choice: null,
  chosenBy: null,
  chosenVia: null,
  raisedAt: "2026-11-21T09:00:00Z",
  applyAfter: "2026-11-21T12:00:00Z",
  resolvedAt: null,
  needsPerson: true,
  protection: "outward",
  initiative: "ini",
  part: "p1",
  wave: 2,
  phase: "build",
  answerable: "yes",
  answer: { optionKey: "a", status: "failed", reason: "dp-failed", detail: "exit 1" },
} as const;

const cardOfEachKind: ReadonlyArray<PluginCardType> = [
  { ...base, id: "dispatch.decision:/repo#d1", kind: "dispatch.decision", data: decisionData },
  {
    ...base,
    id: "dispatch.plan:spec",
    kind: "dispatch.plan",
    data: {
      task: "Ship",
      specPath: "/repo/spec.md",
      dir: "/repo",
      status: "draft",
      wave: { current: 1, total: 3 },
      phases: [
        { id: "1", name: "Contracts", wave: 1, tier: "standard", status: "draft", risk: true },
      ],
      initiative: null,
      part: null,
    },
  },
  {
    ...base,
    id: "dispatch.verify:spec",
    kind: "dispatch.verify",
    data: {
      task: "Ship",
      specPath: "/repo/spec.md",
      dir: "/repo",
      revision: "abc123",
      checks: [
        { name: "lint", summary: "clean", state: "pass" },
        { name: "test", summary: "2 failed", state: "fail" },
      ],
    },
  },
  {
    ...base,
    id: "dispatch.runProgress:r1",
    kind: "dispatch.runProgress",
    data: {
      runId: "r1",
      dir: "/repo",
      part: "p1",
      wave: 1,
      initiative: "ini",
      spec: "spec.md",
      outcome: "failed",
      reason: "gate failed",
      phases: [{ id: "1", name: "Contracts", state: "stale", attempt: 2 }],
      phasesTotal: 4,
      startedAt: "2026-11-21T09:00:00Z",
      settledAt: "2026-11-21T09:30:00Z",
      costUsd: 1.25,
    },
  },
  {
    ...base,
    id: "livecheck.result:r1",
    kind: "livecheck.result",
    data: {
      runId: "r1",
      runDir: "/runs/r1",
      target: "http://localhost:3000",
      verdict: "blocked",
      summary: "Login blocked",
      judge: null,
      steps: [{ index: 0, label: "Open page", state: "done", assetId: "shot-0" }],
      failedStepIndex: 0,
      finishedAt: null,
    },
  },
  {
    ...base,
    id: "livecheck.progress:r1",
    kind: "livecheck.progress",
    data: {
      runId: "r1",
      runDir: "/runs/r1",
      target: "http://localhost:3000",
      steps: [{ index: 0, label: "Open page", state: "running", durationMs: null }],
      currentStep: 0,
      totalSteps: 5,
      heartbeatAt: "2026-11-21T09:59:00Z",
      latestAssetId: null,
    },
  },
  {
    ...base,
    id: "iter8.round:home#2",
    kind: "iter8.round",
    data: {
      round: 2,
      page: "home",
      pagePath: "/pages/home.html",
      notes: [{ id: "n1", text: "Tighten", state: "resolved", author: "biruk", anchor: "#hero" }],
    },
  },
  {
    ...base,
    id: "gitty.push:feat",
    kind: "gitty.push",
    data: {
      branch: "feat",
      batches: [{ label: "batch 1", state: "pending", commit: null }],
      mergeRequest: {
        url: "https://example.test/mr/7",
        number: 7,
        draft: true,
        additions: 10,
        deletions: 2,
        pipeline: "running",
      },
    },
  },
  {
    ...base,
    id: "gitty.conflict:a.ts",
    kind: "gitty.conflict",
    data: {
      file: "a.ts",
      base: null,
      sides: [{ label: "ours", summary: "renamed" }],
      resolutions: [{ key: "ours", label: "Keep ours", predictedOutcome: "builds" }],
    },
  },
];

const decode = Schema.decodeUnknownSync(PluginCard);
const decodeExit = Schema.decodeUnknownExit(PluginCard);
const encode = Schema.encodeSync(PluginCard);
const encodeAsset = Schema.encodeSync(PluginCardAsset);
const decodeAsset = Schema.decodeUnknownSync(PluginCardAsset);
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("PluginCard", () => {
  it("fixtures cover every declared kind exactly once", () => {
    expect(cardOfEachKind.map((card) => card.kind).toSorted()).toEqual(
      [...PluginCardKind.literals].toSorted(),
    );
  });

  it.each(cardOfEachKind.map((card) => [card.kind, card] as const))(
    "round-trips a %s card through JSON",
    (_kind, card) => {
      expect(decode(wire(encode(card)))).toEqual(card);
    },
  );

  it("decodes a decision with no apply-after time and no default option", () => {
    const decoded = decode(
      wire({
        ...base,
        id: "dispatch.decision:/repo#d2",
        kind: "dispatch.decision",
        data: { ...decisionData, applyAfter: null, defaultKey: null, answer: null },
      }),
    );
    if (decoded.kind !== "dispatch.decision") throw new Error("wrong kind");
    expect(decoded.data.applyAfter).toBeNull();
    expect(decoded.data.defaultKey).toBeNull();
    expect(decoded.data.answer).toBeNull();
  });

  it("rejects a kind outside the known list", () => {
    expect(Exit.isFailure(decodeExit(wire({ ...cardOfEachKind[0], kind: "dispatch.nope" })))).toBe(
      true,
    );
  });

  it("rejects data that belongs to a different kind", () => {
    expect(Exit.isFailure(decodeExit(wire({ ...cardOfEachKind[0], kind: "gitty.conflict" })))).toBe(
      true,
    );
  });

  it("rejects an unknown placement type and an empty card id", () => {
    expect(
      Exit.isFailure(decodeExit(wire({ ...cardOfEachKind[0], placement: { type: "x" } }))),
    ).toBe(true);
    expect(Exit.isFailure(decodeExit(wire({ ...cardOfEachKind[0], id: "  " })))).toBe(true);
  });
});

describe("PluginCardAsset", () => {
  it("carries bytes as base64 on the wire", () => {
    const asset = { mediaType: "image/png", bytes: new Uint8Array([0, 1, 254, 255]) };
    const encoded = encodeAsset(asset);
    expect(encoded).toEqual({ mediaType: "image/png", bytes: "AAH+/w==" });
    expect(decodeAsset(encoded)).toEqual(asset);
  });
});

describe("PluginCardError", () => {
  it.each(PluginCardErrorReason.literals)("words %s as a plain sentence", (reason) => {
    const { message } = new PluginCardError({ reason });
    expect(message).toMatch(/^[A-Z].*\.$/);
    expect(message).not.toContain("—");
    expect(message).not.toContain(reason);
  });

  it("gives every reason its own message", () => {
    const messages = PluginCardErrorReason.literals.map(
      (reason) => new PluginCardError({ reason }).message,
    );
    expect(new Set(messages).size).toBe(PluginCardErrorReason.literals.length);
  });

  it("keeps answer recording details available without including them in the message", () => {
    const error = new PluginCardError({ reason: "dp-failed", detail: "exit 2" });
    expect(error.message).toBe("Couldn't record your answer.");
    expect(error.detail).toBe("exit 2");
  });
});

describe("plugin card RPC methods", () => {
  const readMethods = [
    WS_METHODS.pluginCardsSubscribeThread,
    WS_METHODS.pluginCardsSubscribeLive,
    WS_METHODS.pluginCardsReadAsset,
  ];
  const operateMethods = [WS_METHODS.pluginCardsAnswerDecision, WS_METHODS.pluginCardsRunAction];

  it("names the five methods on the wire", () => {
    expect([...readMethods, ...operateMethods].toSorted()).toEqual([
      "pluginCards.answerDecision",
      "pluginCards.readAsset",
      "pluginCards.runAction",
      "pluginCards.subscribeLive",
      "pluginCards.subscribeThread",
    ]);
  });

  it("registers every method in the server RPC group", () => {
    for (const method of [...readMethods, ...operateMethods]) {
      expect(WsRpcGroup.requests.has(method)).toBe(true);
    }
  });

  it.each(readMethods)("requires exactly the read scope for %s", (method) => {
    expect(CLIENT_GUARDED_RPC_SCOPES[method]).toBe(AuthOrchestrationReadScope);
    expect(clientRpcRequiredScopes(method, {})).toEqual([AuthOrchestrationReadScope]);
  });

  it.each(operateMethods)("requires exactly the operate scope for %s", (method) => {
    expect(CLIENT_GUARDED_RPC_SCOPES[method]).toBe(AuthOrchestrationOperateScope);
    expect(clientRpcRequiredScopes(method, {})).toEqual([AuthOrchestrationOperateScope]);
  });
});
