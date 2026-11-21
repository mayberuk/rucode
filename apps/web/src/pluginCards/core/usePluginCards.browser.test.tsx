import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  PluginCardError,
  ThreadId,
  type PluginLiveState,
  type PluginThreadCards,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import * as pluginCardsRpc from "~/rpc/pluginCards";
import { act, render } from "../../../test/render";
import { PluginCardShell } from "./PluginCardShell";
import { PluginCardStep } from "./PluginCardStep";
import { usePluginCardAsset, usePluginLiveState, usePluginThreadCards } from "./usePluginCards";

vi.mock(import("~/rpc/pluginCards"), { spy: true });

const threadRef = {
  environmentId: EnvironmentId.make("plugin-cards"),
  threadId: ThreadId.make("thread"),
};
const cardId = "livecheck.result:home";

function AssetCard() {
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
  using _subscription = vi
    .spyOn(pluginCardsRpc, "pluginThreadCardsAtomFamily")
    .mockReturnValue(snapshot);

  function ThreadCards() {
    const result = usePluginThreadCards(threadRef);
    return (
      <div data-testid="thread-cards" data-count={result?.cards.length ?? "pending"}>
        {result?.cards.map((card) => (
          <div key={card.id}>{card.kind}</div>
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
  await expect.element(cards).toHaveAttribute("data-count", "pending");
  await expect.element(cards).toBeEmptyDOMElement();

  await act(() =>
    registry.set(snapshot, AsyncResult.success({ threadId: threadRef.threadId, cards: [] })),
  );
  await expect.element(cards).toHaveAttribute("data-count", "0");
  await expect.element(cards).toBeEmptyDOMElement();
});

it("keeps the last live snapshot until the subscription delivers a new one", async () => {
  const snapshot = Atom.make<AsyncResult.AsyncResult<PluginLiveState, PluginCardError>>(
    AsyncResult.initial(),
  );
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  using _subscription = vi
    .spyOn(pluginCardsRpc, "pluginLiveStateAtomFamily")
    .mockReturnValue(snapshot);

  function LiveCards() {
    const result = usePluginLiveState(threadRef.environmentId);
    return <output aria-label="Waiting threads">{result?.waitingThreadIds.length ?? "…"}</output>;
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
  const waitingThreads = screen.getByLabelText("Waiting threads");
  await expect.element(waitingThreads).toHaveTextContent("…");
  await act(() => registry.set(snapshot, AsyncResult.success(first)));
  await expect.element(waitingThreads).toHaveTextContent("1");
  await act(() =>
    registry.set(
      snapshot,
      AsyncResult.failureWithPrevious(Cause.fail(new PluginCardError({ reason: "unavailable" })), {
        previous: Option.some(registry.get(snapshot)),
        waiting: true,
      }),
    ),
  );
  await expect.element(waitingThreads).toHaveTextContent("1");
  await act(() => registry.set(snapshot, AsyncResult.success({ ...first, waitingThreadIds: [] })));
  await expect.element(waitingThreads).toHaveTextContent("0");
});

it("keeps the placeholder until the image loads and revokes its URL when the renderer unmounts", async () => {
  const asset = Promise.withResolvers<{ mediaType: string; bytes: Uint8Array }>();
  using _read = vi
    .spyOn(pluginCardsRpc.readPluginCardAsset, "run")
    .mockReturnValue(asset.promise.then((value) => AsyncResult.success(value)));
  using revoke = vi.spyOn(URL, "revokeObjectURL");

  // The card renders outside navigation.
  await using screen = await render(<AssetCard />, { router: false });
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

  await screen.rerender(<div />);
  expect(revoke).toHaveBeenCalledExactlyOnceWith(imageElement.src);
});

it("keeps the failed asset placeholder without retrying on rerender", async () => {
  const error = new PluginCardError({ reason: "unknown-asset" });
  using read = vi
    .spyOn(pluginCardsRpc.readPluginCardAsset, "run")
    .mockResolvedValue(AsyncResult.fail(error));

  // The card renders outside navigation.
  await using screen = await render(<AssetCard />, { router: false });
  await expect.element(screen.getByText(error.message)).toBeVisible();
  await screen.rerender(<AssetCard />);
  await expect.element(screen.getByText(error.message)).toBeVisible();
  await expect.element(screen.getByRole("img")).not.toBeInTheDocument();
  expect(read).toHaveBeenCalledTimes(1);
});
