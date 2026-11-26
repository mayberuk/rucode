import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ThreadId,
  type PluginLiveCliSession,
  type PluginLiveState,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import * as pluginCardsRpc from "~/rpc/pluginCards";
import { act, render, type Screen } from "../../../test/render";
import { useCliSessionComposer } from "./CliSessionBanner";
import { ComposerBannerStack } from "./ComposerBannerStack";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

vi.mock(import("~/rpc/pluginCards"), { spy: true });
vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
  useClientSettings: () => false,
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: () => null,
  useSidebarStageBackdropVariant: () => null,
}));

const threadId = ThreadId.make("chat");
let environmentCount = 0;

function setup() {
  const stack = new DisposableStack();
  const registry = stack.adopt(AtomRegistry.make(), (value) => value.dispose());
  const live = Atom.make<AsyncResult.AsyncResult<PluginLiveState>>(AsyncResult.initial());
  stack.use(vi.spyOn(pluginCardsRpc, "pluginLiveStateAtomFamily").mockReturnValue(live));
  // Live atoms are keyed by environment, so each test gets its own.
  const threadRef: ScopedThreadRef = {
    environmentId: EnvironmentId.make(`cli-sessions-${++environmentCount}`),
    threadId,
  };
  const publish = (cliSessions: ReadonlyArray<PluginLiveCliSession>) =>
    act(() =>
      registry.set(
        live,
        AsyncResult.success({
          asOf: "2026-11-22T09:00:00Z",
          initiatives: [],
          children: [],
          decisions: [],
          waitingThreadIds: [],
          cliSessions,
        }),
      ),
    );
  return { registry, threadRef, publish, [Symbol.dispose]: () => stack.dispose() };
}

function session(overrides: Partial<PluginLiveCliSession> = {}): PluginLiveCliSession {
  return {
    threadId,
    sessionId: "session-1",
    owner: "terminal",
    status: "idle",
    name: "work",
    inTmux: true,
    backgroundWorkKept: false,
    ...overrides,
  };
}

function Composer({ threadRef }: { threadRef: ScopedThreadRef }) {
  const { bannerItem, sendDisabledReason } = useCliSessionComposer(threadRef, false);
  return (
    <>
      <ComposerBannerStack items={bannerItem === null ? [] : [bannerItem]} />
      <ComposerPrimaryActions
        compact={false}
        canOperateThread
        pendingAction={null}
        isRunning={false}
        canInterrupt={false}
        isSendBusy={false}
        sendDisabledReason={sendDisabledReason}
        isEnvironmentUnavailable={false}
        isPreparingWorktree={false}
        hasSendableContent
        onPreviousPendingQuestion={() => {}}
        onInterrupt={() => {}}
      />
    </>
  );
}

const renderComposer = (env: ReturnType<typeof setup>) =>
  render(
    <RegistryContext.Provider value={env.registry}>
      <Composer threadRef={env.threadRef} />
    </RegistryContext.Provider>,
  );

const takeOverButton = (screen: Screen) => screen.getByRole("button", { name: "Take over" });

it("holds Send while a terminal has the chat open and releases it once the terminal lets go", async () => {
  using env = setup();
  await using screen = await renderComposer(env);
  await env.publish([session()]);

  await expect.element(screen.getByText("Open in a terminal · idle")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Open in a terminal", exact: true }))
    .toBeDisabled();

  await env.publish([]);

  await expect.element(screen.getByRole("button", { name: "Submit message" })).toBeEnabled();
  expect(screen.container.textContent).not.toContain("Open in a terminal");
});

it.each([
  ["idle", true, true],
  ["idle", false, false],
  ["busy", true, false],
  ["shell", true, false],
  ["unknown", true, false],
] as const)(
  "offers Take over for a %s terminal session (in tmux: %s): %s",
  async (status, inTmux, available) => {
    using env = setup();
    await using screen = await renderComposer(env);
    await env.publish([session({ status, inTmux })]);

    if (available) await expect.element(takeOverButton(screen)).toBeEnabled();
    else await expect.element(takeOverButton(screen)).toBeDisabled();
    await expect
      .element(
        screen.getByText(
          available ? "Exit it there, or take over here." : "Exit it there to continue here.",
        ),
      )
      .toBeVisible();
  },
);
