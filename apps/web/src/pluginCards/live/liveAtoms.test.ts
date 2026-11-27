import {
  EnvironmentId,
  ThreadId,
  type PluginInitiativeBoard,
  type PluginInitiativeDecision,
  type PluginLiveInitiative,
  type PluginLiveState,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "~/rpc/atomRegistry";

import {
  useInitiativeBoard,
  useLiveInitiative,
  useThreadHasOpenDecision,
  useThreadInitiative,
} from "./liveAtoms";

type LiveResult = AsyncResult.AsyncResult<PluginLiveState, string>;
type BoardResult = AsyncResult.AsyncResult<PluginInitiativeBoard, string>;

const sources = vi.hoisted(() => new Map<string, Atom.Writable<LiveResult>>());
const boardSources = vi.hoisted(() => new Map<string, Atom.Writable<BoardResult>>());

// Hooks run as plain functions here: a mounted atom keeps the previous snapshot the way a
// rendered component's subscription does.
vi.mock(import("@effect/atom-react"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomValue: <A>(atom: Atom.Atom<A>): A => {
    appAtomRegistry.mount(atom);
    return appAtomRegistry.get(atom);
  },
}));

vi.mock(import("~/rpc/pluginCards"), async (importOriginal) => ({
  ...(await importOriginal()),
  pluginLiveStateAtomFamily: (({ environmentId }: { environmentId: string }) =>
    sources.get(environmentId)!) as never,
  pluginInitiativeBoardAtomFamily: (({
    environmentId,
    input,
  }: {
    environmentId: string;
    input: { slug: string };
  }) => boardSources.get(JSON.stringify([environmentId, input.slug]))!) as never,
}));

const thread = ThreadId.make("chat-1");
let environmentCount = 0;

function newEnvironment() {
  const environmentId = EnvironmentId.make(`env-${++environmentCount}`);
  const source = Atom.make<LiveResult>(AsyncResult.initial());
  sources.set(environmentId, source);
  return {
    environmentId,
    deliver: (state: PluginLiveState) => appAtomRegistry.set(source, AsyncResult.success(state)),
    fail: (previous: PluginLiveState | null = null) =>
      appAtomRegistry.set(
        source,
        AsyncResult.fail("stream dropped", {
          previousSuccess:
            previous === null ? Option.none() : Option.some(AsyncResult.success(previous)),
        }),
      ),
  };
}

function initiative(overrides: Partial<PluginLiveInitiative> = {}): PluginLiveInitiative {
  return {
    slug: "alpha",
    title: "Alpha",
    closed: false,
    wave: { current: 1, total: 2, partsSettled: 1, partsTotal: 3 },
    settled: { count: 1, total: 4 },
    running: 2,
    openDecisions: 0,
    spend: { usd: 1.5, state: "exact" },
    orchestratorThreadId: thread,
    asOf: "2026-11-21T09:00:00Z",
    parts: [],
    ...overrides,
  };
}

function live(
  initiatives: ReadonlyArray<PluginLiveInitiative>,
  overrides: Partial<PluginLiveState> = {},
): PluginLiveState {
  return {
    asOf: "2026-11-21T09:00:00Z",
    initiatives,
    children: [],
    decisions: [],
    waitingThreadIds: [],
    ...overrides,
  };
}

function newBoardSource(environmentId: EnvironmentId, slug = "alpha") {
  const source = Atom.make<BoardResult>(AsyncResult.initial());
  boardSources.set(JSON.stringify([environmentId, slug]), source);
  return {
    read: () => useInitiativeBoard(environmentId, slug),
    deliver: (board: PluginInitiativeBoard) =>
      appAtomRegistry.set(source, AsyncResult.success(board)),
    fail: (error: string, previous: PluginInitiativeBoard | null = null) =>
      appAtomRegistry.set(
        source,
        AsyncResult.fail(error, {
          previousSuccess:
            previous === null ? Option.none() : Option.some(AsyncResult.success(previous)),
        }),
      ),
  };
}

function board(overrides: Partial<PluginInitiativeBoard> = {}): PluginInitiativeBoard {
  return {
    slug: "alpha",
    title: null,
    closed: false,
    startedAt: null,
    asOf: "2026-11-21T09:00:00Z",
    headline: { kind: "waiting", nextPart: null },
    parts: { settled: 0, total: 0 },
    spend: { usd: null, state: "unknown", ceilingUsd: null },
    currentWave: 0,
    waves: [],
    needsYou: [],
    ...overrides,
  };
}

describe("initiative board subscription lifecycle", () => {
  it("stays loading after live state arrives and becomes ready on the first board", () => {
    const env = newEnvironment();
    const source = newBoardSource(env.environmentId);
    expect(source.read()).toStrictEqual({ status: "loading", board: null, needsYou: [] });
    env.deliver(live([initiative()]));
    expect(source.read()).toStrictEqual({ status: "loading", board: null, needsYou: [] });

    const first = board();
    source.deliver(first);
    expect(source.read()).toStrictEqual({ status: "ready", board: first, needsYou: [] });
  });

  it("retains the latest board on repeated failures and replaces it on recovery", () => {
    const env = newEnvironment();
    const source = newBoardSource(env.environmentId);
    source.deliver(board());
    expect(source.read().status).toBe("ready");
    const latest = board({ title: "Alpha", asOf: "2026-11-21T09:01:00Z" });
    source.deliver(latest);
    expect(source.read().board).toBe(latest);

    source.fail("stream dropped", latest);
    expect(source.read()).toStrictEqual({ status: "unavailable", board: latest, needsYou: [] });
    source.fail("stream still unavailable");
    expect(source.read()).toStrictEqual({ status: "unavailable", board: latest, needsYou: [] });

    const recovered = board({ title: "Alpha updated", asOf: "2026-11-21T09:02:00Z" });
    source.deliver(recovered);
    expect(source.read()).toStrictEqual({ status: "ready", board: recovered, needsYou: [] });
  });

  it("uses the source's previous success when the board is first read after a failure", () => {
    const env = newEnvironment();
    const source = newBoardSource(env.environmentId);
    const previous = board();
    source.fail("stream dropped", previous);
    expect(source.read()).toStrictEqual({ status: "unavailable", board: previous, needsYou: [] });
  });

  it.each(["unknown initiative", "board service unavailable"])(
    "reports unavailable with no board after an initial %s failure",
    (error) => {
      const env = newEnvironment();
      const source = newBoardSource(env.environmentId);
      expect(source.read().status).toBe("loading");
      source.fail(error);
      expect(source.read()).toStrictEqual({ status: "unavailable", board: null, needsYou: [] });

      const first = board();
      source.deliver(first);
      expect(source.read()).toStrictEqual({ status: "ready", board: first, needsYou: [] });
    },
  );

  it("reuses the view and board when a duplicate payload arrives", () => {
    const env = newEnvironment();
    const source = newBoardSource(env.environmentId);
    const first = board();
    source.deliver(first);
    const firstView = source.read();

    source.deliver(structuredClone(first));
    const repeated = source.read();
    expect(repeated.board).toBe(first);
    expect(repeated).toBe(firstView);

    const refreshed = board({ asOf: "2026-11-21T09:01:00Z" });
    source.deliver(refreshed);
    expect(source.read()).toStrictEqual({ status: "ready", board: refreshed, needsYou: [] });
  });

  it("isolates concurrent subscriptions by both environment and slug", () => {
    const firstEnv = newEnvironment();
    const secondEnv = newEnvironment();
    const alpha = newBoardSource(firstEnv.environmentId);
    const beta = newBoardSource(firstEnv.environmentId, "beta");
    const remoteAlpha = newBoardSource(secondEnv.environmentId);
    expect(alpha.read().status).toBe("loading");
    expect(beta.read().status).toBe("loading");
    expect(remoteAlpha.read().status).toBe("loading");

    const betaBoard = board({ slug: "beta" });
    beta.deliver(betaBoard);
    const remoteBoard = board({ title: "Remote Alpha" });
    remoteAlpha.deliver(remoteBoard);
    alpha.fail("unknown initiative");
    expect(alpha.read()).toStrictEqual({ status: "unavailable", board: null, needsYou: [] });
    expect(beta.read()).toStrictEqual({ status: "ready", board: betaBoard, needsYou: [] });
    expect(remoteAlpha.read()).toStrictEqual({ status: "ready", board: remoteBoard, needsYou: [] });
  });

  it("updates the decision join when live state arrives or removes the chat", () => {
    const env = newEnvironment();
    const source = newBoardSource(env.environmentId);
    const decision: PluginInitiativeDecision = {
      cardId: "dispatch.decision:alpha",
      decisionId: "confirm-checkout",
      kind: "dispatch.decision",
      question: "Continue checkout?",
      part: "part-a",
      options: [],
      defaultKey: null,
      applyAfter: null,
      protection: null,
      needsPerson: false,
      raisedAt: "2026-11-21T09:00:00Z",
    };
    const first = board({ needsYou: [decision] });
    source.deliver(first);
    expect(source.read()).toStrictEqual({
      status: "ready",
      board: first,
      needsYou: [{ ...decision, threadId: null, answerableInPlace: false }],
    });

    env.deliver(
      live([], {
        decisions: [{ ...decision, dir: "/acme/app", initiative: "alpha", threadId: thread }],
      }),
    );
    expect(source.read()).toStrictEqual({
      status: "ready",
      board: first,
      needsYou: [{ ...decision, threadId: thread, answerableInPlace: true }],
    });

    source.fail("stream dropped");
    env.deliver(live([]));
    expect(source.read()).toStrictEqual({
      status: "unavailable",
      board: first,
      needsYou: [{ ...decision, threadId: null, answerableInPlace: false }],
    });
  });
});

it("useLiveInitiative returns null for an unknown slug and follows the matching live initiative", () => {
  const env = newEnvironment();
  const alpha = initiative();
  env.deliver(live([alpha]));
  expect(useLiveInitiative(env.environmentId, "missing")).toBeNull();
  expect(useLiveInitiative(env.environmentId, "alpha")).toBe(alpha);

  env.deliver(live([{ ...alpha, closed: true }]));
  expect(useLiveInitiative(env.environmentId, "alpha")).toBeNull();
});

describe("thread initiative subscription lifecycle", () => {
  it("shows nothing while loading, then the initiative once the first snapshot arrives", () => {
    const env = newEnvironment();
    expect(useThreadInitiative(env.environmentId, thread)).toBeNull();

    const first = initiative();
    env.deliver(live([first]));
    expect(useThreadInitiative(env.environmentId, thread)).toBe(first);
  });

  it("shows nothing for a chat in no open initiative", () => {
    const env = newEnvironment();
    env.deliver(
      live([
        initiative({ slug: "other", orchestratorThreadId: ThreadId.make("elsewhere") }),
        initiative({ slug: "done", closed: true }),
      ]),
    );
    expect(useThreadInitiative(env.environmentId, thread)).toBeNull();
  });

  it("shows nothing after a failure before any snapshot, then shows it once a resubscribed stream delivers one", () => {
    const env = newEnvironment();
    env.fail();
    expect(useThreadInitiative(env.environmentId, thread)).toBeNull();

    const first = initiative();
    env.deliver(live([first]));
    expect(useThreadInitiative(env.environmentId, thread)).toBe(first);
  });

  it("keeps the last values and their as-of time when the stream drops, and replaces them on the next snapshot", () => {
    const env = newEnvironment();
    const first = initiative({ asOf: "2026-11-21T09:00:00Z", running: 2 });
    const firstState = live([first]);
    env.deliver(firstState);
    expect(useThreadInitiative(env.environmentId, thread)).toBe(first);

    env.fail(firstState);
    expect(useThreadInitiative(env.environmentId, thread)).toBe(first);

    env.fail();
    expect(useThreadInitiative(env.environmentId, thread)).toBe(first);

    const next = initiative({ asOf: "2026-11-21T09:30:00Z", running: 0 });
    env.deliver(live([next]));
    expect(useThreadInitiative(env.environmentId, thread)).toBe(next);
  });

  it("drops the section when a later snapshot no longer lists the chat's initiative", () => {
    const env = newEnvironment();
    env.deliver(live([initiative()]));
    expect(useThreadInitiative(env.environmentId, thread)).not.toBeNull();

    env.deliver(live([initiative({ closed: true })]));
    expect(useThreadInitiative(env.environmentId, thread)).toBeNull();
  });
});

describe("thread open decision subscription lifecycle", () => {
  it("is false while loading and after a failure before any snapshot, and follows the first snapshot", () => {
    const env = newEnvironment();
    expect(useThreadHasOpenDecision(env.environmentId, thread)).toBe(false);

    env.fail();
    expect(useThreadHasOpenDecision(env.environmentId, thread)).toBe(false);

    env.deliver(live([], { waitingThreadIds: [thread] }));
    expect(useThreadHasOpenDecision(env.environmentId, thread)).toBe(true);
  });

  it("keeps the last answer when the stream drops", () => {
    const env = newEnvironment();
    const state = live([], { waitingThreadIds: [thread] });
    env.deliver(state);
    env.fail(state);
    expect(useThreadHasOpenDecision(env.environmentId, thread)).toBe(true);
  });
});
