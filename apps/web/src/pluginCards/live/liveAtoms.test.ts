import {
  EnvironmentId,
  ThreadId,
  type PluginLiveInitiative,
  type PluginLiveState,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "~/rpc/atomRegistry";

import { useThreadHasOpenDecision, useThreadInitiative } from "./liveAtoms";

type LiveResult = AsyncResult.AsyncResult<PluginLiveState, string>;

const sources = vi.hoisted(() => new Map<string, Atom.Writable<LiveResult>>());

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
