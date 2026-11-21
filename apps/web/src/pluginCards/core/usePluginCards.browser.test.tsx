import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  PluginCardError,
  ThreadId,
  type PluginLiveState,
  type PluginThreadCards,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import * as pluginCardsRpc from "~/rpc/pluginCards";
import * as entities from "~/state/entities";
import * as session from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { makeThreadFixture } from "~/test-fixtures";
import { act, render } from "../../../test/render";
import { PluginCardShell } from "./PluginCardShell";
import { PluginCardStep } from "./PluginCardStep";
import {
  usePluginCardAsset,
  usePluginLiveState,
  usePluginThreadCards,
  usePostPluginCardMessage,
} from "./usePluginCards";

vi.mock(import("~/rpc/pluginCards"), { spy: true });
vi.mock(import("~/state/entities"), { spy: true });
vi.mock(import("~/state/session"), { spy: true });

const threadRef = {
  environmentId: EnvironmentId.make("plugin-cards"),
  threadId: ThreadId.make("thread"),
};

// The asset cache outlives a mount, so each test reads its own card.
function AssetCard({ cardId }: { readonly cardId: string }) {
  const asset = usePluginCardAsset(threadRef, cardId, "screenshot");
  return (
    <PluginCardShell label="Browser check" title="Browser check">
      {asset.status === "ready" ? (
        <img alt="Browser screenshot" src={asset.url} />
      ) : (
        <PluginCardStep
          state={asset.status === "failed" ? "failed" : "pending"}
          label={asset.status === "failed" ? asset.message : "Loading screenshot"}
        />
      )}
    </PluginCardShell>
  );
}

it("distinguishes a missing thread snapshot from an empty list without rendering cards", async () => {
  const snapshot = Atom.make<AsyncResult.AsyncResult<PluginThreadCards>>(AsyncResult.initial());
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  using subscription = vi
    .spyOn(pluginCardsRpc, "pluginThreadCardsAtomFamily")
    .mockReturnValue(snapshot);

  function ThreadCards() {
    const result = usePluginThreadCards(threadRef);
    return (
      <div data-testid="thread-cards" data-thread-id={result?.threadId}>
        {result?.cards.map((card) => (
          <div key={card.id}>{JSON.stringify(card)}</div>
        ))}
      </div>
    );
  }

  // The card hooks don't use navigation.
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <ThreadCards />
    </RegistryContext.Provider>,
    { router: false },
  );
  const cards = screen.getByTestId("thread-cards");
  expect(subscription).toHaveBeenCalledWith({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  });
  await expect.element(cards).not.toHaveAttribute("data-thread-id");
  await expect.element(cards).toBeEmptyDOMElement();

  const at = "2026-11-21T00:00:00Z";
  const populated: PluginThreadCards = {
    threadId: threadRef.threadId,
    cards: [
      {
        id: "gitty.conflict:file.txt",
        threadId: threadRef.threadId,
        kind: "gitty.conflict",
        placement: { type: "time", at },
        updatedAt: at,
        actions: [],
        data: { file: "file.txt", base: null, sides: [], resolutions: [] },
      },
    ],
  };
  await act(() => registry.set(snapshot, AsyncResult.success(populated)));
  await expect.element(cards).toHaveAttribute("data-thread-id", populated.threadId);
  await expect.element(cards).toHaveTextContent(JSON.stringify(populated.cards[0]));

  await act(() =>
    registry.set(snapshot, AsyncResult.success({ threadId: threadRef.threadId, cards: [] })),
  );
  await expect.element(cards).toHaveAttribute("data-thread-id", threadRef.threadId);
  await expect.element(cards).toBeEmptyDOMElement();
});

it("keeps the last live snapshot until the subscription delivers a new one", async () => {
  const snapshot = Atom.make<AsyncResult.AsyncResult<PluginLiveState, PluginCardError>>(
    AsyncResult.initial(),
  );
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  using subscription = vi
    .spyOn(pluginCardsRpc, "pluginLiveStateAtomFamily")
    .mockReturnValue(snapshot);

  function LiveCards() {
    const result = usePluginLiveState(threadRef.environmentId);
    return <output aria-label="Live snapshot">{JSON.stringify(result)}</output>;
  }

  const first: PluginLiveState = {
    asOf: "2026-11-21T00:00:00Z",
    initiatives: [],
    children: [],
    decisions: [],
    waitingThreadIds: [threadRef.threadId],
  };
  // The card hooks don't use navigation.
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <LiveCards />
    </RegistryContext.Provider>,
    { router: false },
  );
  expect(subscription).toHaveBeenCalledWith({ environmentId: threadRef.environmentId, input: {} });
  const live = screen.getByLabelText("Live snapshot");
  expect(live.element().textContent).toBe("null");
  await act(() => registry.set(snapshot, AsyncResult.success(first)));
  expect(live.element().textContent).toBe(JSON.stringify(first));

  const unavailable = new PluginCardError({ reason: "unavailable" });
  await act(() => registry.set(snapshot, AsyncResult.fail(unavailable)));
  expect(live.element().textContent).toBe(JSON.stringify(first));
  await act(() => registry.set(snapshot, AsyncResult.initial(true)));
  expect(live.element().textContent).toBe(JSON.stringify(first));

  const next = { ...first, asOf: "2026-11-21T00:01:00Z", waitingThreadIds: [] };
  await act(() => registry.set(snapshot, AsyncResult.success(next)));
  expect(live.element().textContent).toBe(JSON.stringify(next));
});

it("keeps the placeholder until the image loads and revokes its URL when the renderer unmounts", async () => {
  const asset = Promise.withResolvers<{ mediaType: string; bytes: Uint8Array }>();
  using read = vi
    .spyOn(pluginCardsRpc.readPluginCardAsset, "run")
    .mockReturnValue(asset.promise.then((value) => AsyncResult.success(value)));
  // The card renders outside navigation.
  const cardId = "livecheck.result:loads";
  await using screen = await render(<AssetCard cardId={cardId} />, { router: false });
  using revoke = vi.spyOn(URL, "revokeObjectURL");
  expect(read).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, cardId, assetId: "screenshot" },
  });
  await expect.element(screen.getByText("Loading screenshot")).toBeVisible();
  await expect.element(screen.getByRole("img")).not.toBeInTheDocument();

  asset.resolve({
    mediaType: "image/svg+xml",
    bytes: new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    ),
  });
  const image = screen.getByRole("img", { name: "Browser screenshot" });
  await expect.element(image).toBeVisible();
  const imageElement = image.element() as HTMLImageElement;
  await imageElement.decode();
  await expect.element(screen.getByText("Loading screenshot")).not.toBeInTheDocument();
  expect(revoke).not.toHaveBeenCalled();

  await screen.unmount();
  expect(revoke).toHaveBeenCalledExactlyOnceWith(imageElement.src);
});

it("reads an asset once across remounts, and again after the cache evicts it", async () => {
  using read = vi
    .spyOn(pluginCardsRpc.readPluginCardAsset, "run")
    .mockImplementation(() =>
      Promise.resolve(
        AsyncResult.success({ mediaType: "image/png", bytes: new Uint8Array(4 * 1024 * 1024) }),
      ),
    );
  const show = async (cardId: string) => {
    // The card renders outside navigation.
    await using screen = await render(<AssetCard cardId={cardId} />, { router: false });
    await expect.element(screen.getByRole("img")).toBeVisible();
  };

  await show("livecheck.result:cached-0");
  await show("livecheck.result:cached-0");
  expect(read).toHaveBeenCalledTimes(1);

  for (const n of [1, 2, 3, 4]) await show(`livecheck.result:cached-${n}`);
  await show("livecheck.result:cached-0");
  expect(read).toHaveBeenCalledTimes(6);
});

it("keeps the failed asset placeholder without retrying on rerender", async () => {
  const error = new PluginCardError({ reason: "unknown-asset" });
  using read = vi
    .spyOn(pluginCardsRpc.readPluginCardAsset, "run")
    .mockResolvedValue(AsyncResult.fail(error));

  // The card renders outside navigation.
  const cardId = "livecheck.result:failed";
  await using screen = await render(<AssetCard cardId={cardId} />, { router: false });
  await expect.element(screen.getByText(error.message)).toBeVisible();
  await screen.rerender(<AssetCard cardId={cardId} />);
  await expect.element(screen.getByText(error.message)).toBeVisible();
  await expect.element(screen.getByRole("img")).not.toBeInTheDocument();
  expect(read).toHaveBeenCalledTimes(1);
});

it("does not allocate an object URL when the asset arrives after unmount", async () => {
  const asset =
    Promise.withResolvers<AsyncResult.Success<{ mediaType: string; bytes: Uint8Array }>>();
  using _read = vi.spyOn(pluginCardsRpc.readPluginCardAsset, "run").mockReturnValue(asset.promise);

  // The card renders outside navigation.
  await using screen = await render(<AssetCard cardId="livecheck.result:late" />, {
    router: false,
  });
  using createUrl = vi.spyOn(URL, "createObjectURL");
  await expect.element(screen.getByText("Loading screenshot")).toBeVisible();
  await screen.unmount();
  await act(async () => {
    asset.resolve(AsyncResult.success({ mediaType: "image/png", bytes: new Uint8Array([1]) }));
    await asset.promise;
  });
  expect(createUrl).not.toHaveBeenCalled();
});

it("queues a card message through the same start-turn command as the composer", async () => {
  const shell = makeThreadFixture({
    environmentId: threadRef.environmentId,
    id: threadRef.threadId,
    runtimeMode: "approval-required",
  });
  using _shell = vi.spyOn(entities, "useThreadShell").mockReturnValue(shell);
  using _scope = vi.spyOn(session, "readEnvironmentScope").mockReturnValue(true);
  const sent = Promise.withResolvers<boolean>();
  const message = "Open the verification result";

  function PostMessage() {
    const post = usePostPluginCardMessage(threadRef);
    return <button onClick={() => void post(message).then(sent.resolve)}>Post message</button>;
  }

  // Posting uses the scoped thread directly.
  await using screen = await render(<PostMessage />, { router: false });
  using startTurn = vi
    .spyOn(threadEnvironment.startTurn, "run")
    .mockResolvedValue(AsyncResult.success({ sequence: 1 }));
  await screen.getByRole("button", { name: "Post message" }).click();
  await expect(sent.promise).resolves.toBe(true);
  expect(startTurn).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
    environmentId: threadRef.environmentId,
    input: {
      threadId: threadRef.threadId,
      message: { messageId: expect.any(String), role: "user", text: message, attachments: [] },
      runtimeMode: shell.runtimeMode,
      interactionMode: "default",
      dispatchMode: "queue",
    },
  });
});
