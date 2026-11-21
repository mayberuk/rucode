import { EnvironmentId, ThreadId, type PluginCard } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { TimelineRowCtx } from "~/components/chat/timelineRowContext";
import type { ExpandedImagePreview } from "~/components/chat/ExpandedImagePreview";
import { fakeTimers, render } from "../../../test/render";
import type { PluginCardAssetState } from "../core/usePluginCards";
import { LivecheckProgressCard } from "./LivecheckProgressCard";
import { LivecheckResultCard } from "./LivecheckResultCard";

const testState = vi.hoisted(() => ({
  assets: new Map<string, unknown>(),
  postMessage: vi.fn<(text: string) => Promise<boolean>>(),
}));

vi.mock(import("../core/usePluginCards"), () => ({
  usePluginCardAsset: (_threadRef, _cardId, assetId) =>
    (testState.assets.get(assetId) as PluginCardAssetState | undefined) ?? { status: "loading" },
  usePostPluginCardMessage: () => testState.postMessage,
  useRunPluginCardAction: () => async () => true,
}));

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const AT = "2026-11-21T12:00:00.000Z";
const threadId = ThreadId.make("thread-1");
const threadRef = { environmentId: EnvironmentId.make("env-1"), threadId };

type ResultCard = Extract<PluginCard, { kind: "livecheck.result" }>;
type ProgressCard = Extract<PluginCard, { kind: "livecheck.progress" }>;

function setup(assets: Record<string, PluginCardAssetState> = {}) {
  testState.assets = new Map(Object.entries(assets));
  testState.postMessage.mockReset().mockResolvedValue(true);
}

function resultCard(overrides: Partial<ResultCard["data"]> = {}): ResultCard {
  return {
    id: "livecheck.result:/repo/.livecheck/runs/r14",
    threadId,
    kind: "livecheck.result",
    placement: { type: "time", at: AT },
    updatedAt: AT,
    actions: [
      { id: "rerun", label: "Re-run", type: "message", message: "Re-run the live check: checkout" },
      {
        id: "fix",
        label: "Fix this",
        type: "message",
        message: "Fix what live check run r14 found.",
      },
    ],
    data: {
      runId: "r14",
      runDir: "/repo/.livecheck/runs/r14",
      target: "checkout flow",
      verdict: "fail",
      summary: "The order total still shows $0.00.",
      judge: "Judged by codex (gpt-5)",
      steps: [
        { index: 1, label: "Cart", state: "done", assetId: "01-cart.png" },
        { index: 2, label: "Promo", state: "done", assetId: "02-promo.png" },
        { index: 3, label: "Total", state: "failed", assetId: "03-total.png" },
      ],
      failedStepIndex: 3,
      finishedAt: null,
      ...overrides,
    },
  };
}

function progressCard(overrides: Partial<ProgressCard["data"]> = {}): ProgressCard {
  return {
    id: "livecheck.progress:/repo/.livecheck/runs/r14",
    threadId,
    kind: "livecheck.progress",
    placement: { type: "time", at: AT },
    updatedAt: AT,
    actions: [{ id: "stop", label: "Stop", type: "message", message: "Stop live check run r14." }],
    data: {
      runId: "r14",
      runDir: "/repo/.livecheck/runs/r14",
      target: "checkout flow",
      steps: [],
      currentStep: null,
      totalSteps: 0,
      heartbeatAt: null,
      latestAssetId: null,
      ...overrides,
    },
  };
}

const expandable = (onImageExpand: (preview: ExpandedImagePreview) => void) => ({
  onImageExpand,
});

function inTimeline(
  value: { onImageExpand?: (preview: ExpandedImagePreview) => void },
  ui: React.ReactNode,
) {
  return <TimelineRowCtx value={value as never}>{ui}</TimelineRowCtx>;
}

describe("LivecheckResultCard", () => {
  it("draws loaded, loading and failed thumbnails and marks the failed step", async () => {
    setup({
      "01-cart.png": { status: "ready", url: PIXEL },
      "03-total.png": { status: "failed", message: "The image could not be read." },
    });
    await using screen = await render(
      inTimeline(
        expandable(vi.fn()),
        <LivecheckResultCard
          card={resultCard()}
          environmentId={threadRef.environmentId}
          threadRef={threadRef}
        />,
      ),
      { router: false },
    );

    await expect.element(screen.getByText("Failed", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("The order total still shows $0.00.")).toBeVisible();
    await expect.element(screen.getByText("Judged by codex (gpt-5)")).toBeVisible();
    await expect
      .element(screen.getByRole("img", { name: "1. Cart" }))
      .toHaveAttribute("src", PIXEL);

    const figures = screen.container.querySelectorAll("figure");
    expect([...figures].map((figure) => figure.dataset.assetState)).toEqual([
      "ready",
      "loading",
      "failed",
    ]);
    expect([...figures].map((figure) => figure.hasAttribute("data-step-failed"))).toEqual([
      false,
      false,
      true,
    ]);
    expect(figures[1]?.querySelector("img")).toBeNull();
    expect(figures[1]?.textContent).toBe("2. Promo");
    expect(figures[2]?.textContent).toContain("The image could not be read.");
  });

  it("offers Fix this as an outline button, not the default one", async () => {
    setup();
    await using screen = await render(
      inTimeline(
        expandable(vi.fn()),
        <LivecheckResultCard
          card={resultCard()}
          environmentId={threadRef.environmentId}
          threadRef={threadRef}
        />,
      ),
      { router: false },
    );
    const fix = screen.getByRole("button", { name: "Fix this" }).element();
    expect(fix.classList.contains("border-input")).toBe(true);
    expect(fix.classList.contains("bg-primary")).toBe(false);
    await expect.element(screen.getByRole("button", { name: "Re-run" })).toBeVisible();
  });

  it("omits Fix this when the card carries no fix action", async () => {
    setup();
    const card = resultCard({ verdict: "pass", failedStepIndex: null });
    await using screen = await render(
      inTimeline(
        expandable(vi.fn()),
        <LivecheckResultCard
          card={{ ...card, actions: card.actions.filter((action) => action.id !== "fix") }}
          environmentId={threadRef.environmentId}
          threadRef={threadRef}
        />,
      ),
      { router: false },
    );
    expect(screen.getByRole("button", { name: "Fix this" }).query()).toBeNull();
    await expect.element(screen.getByText("Passed", { exact: true })).toBeVisible();
  });

  it("opens the viewer on the clicked screenshot beside the other loaded ones", async () => {
    setup({
      "01-cart.png": { status: "ready", url: `${PIXEL}#cart` },
      "03-total.png": { status: "ready", url: `${PIXEL}#total` },
    });
    const onImageExpand = vi.fn<(preview: ExpandedImagePreview) => void>();
    await using screen = await render(
      inTimeline(
        expandable(onImageExpand),
        <LivecheckResultCard
          card={resultCard()}
          environmentId={threadRef.environmentId}
          threadRef={threadRef}
        />,
      ),
      { router: false },
    );

    await screen.getByRole("button", { name: "Preview 3. Total" }).click();

    expect(onImageExpand).toHaveBeenCalledExactlyOnceWith({
      images: [
        { src: `${PIXEL}#cart`, name: "1. Cart", mimeType: "image/png", ownsSrc: false },
        { src: `${PIXEL}#total`, name: "3. Total", mimeType: "image/png", ownsSrc: false },
      ],
      index: 1,
    });
  });

  it("draws thumbnails without buttons when the timeline cannot expand images", async () => {
    setup({ "01-cart.png": { status: "ready", url: PIXEL } });
    await using screen = await render(
      inTimeline(
        {},
        <LivecheckResultCard
          card={resultCard()}
          environmentId={threadRef.environmentId}
          threadRef={threadRef}
        />,
      ),
      { router: false },
    );
    await expect.element(screen.getByRole("img", { name: "1. Cart" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Preview 1. Cart" }).query()).toBeNull();
  });

  it("shows the verdict and summary with no thumbnail row when there are no screenshots", async () => {
    setup();
    await using screen = await render(
      inTimeline(
        expandable(vi.fn()),
        <LivecheckResultCard
          card={resultCard({ steps: [], failedStepIndex: null, judge: null })}
          environmentId={threadRef.environmentId}
          threadRef={threadRef}
        />,
      ),
      { router: false },
    );
    await expect.element(screen.getByText("The order total still shows $0.00.")).toBeVisible();
    expect(screen.container.querySelector("figure")).toBeNull();
  });
});

describe("LivecheckProgressCard", () => {
  it("shows a muted Starting line when no step has been recorded", async () => {
    setup();
    await using screen = await render(
      <LivecheckProgressCard
        card={progressCard()}
        environmentId={threadRef.environmentId}
        threadRef={threadRef}
      />,
      { router: false },
    );
    await expect.element(screen.getByText("Starting")).toBeVisible();
    await expect.element(screen.getByText("Checking")).toBeVisible();
  });

  it("posts the stop message", async () => {
    setup();
    await using screen = await render(
      <LivecheckProgressCard
        card={progressCard()}
        environmentId={threadRef.environmentId}
        threadRef={threadRef}
      />,
      { router: false },
    );
    await screen.getByRole("button", { name: "Stop" }).click();
    expect(testState.postMessage).toHaveBeenCalledExactlyOnceWith("Stop live check run r14.");
  });

  it("shows steps with durations, the current step, the heartbeat age and the latest screenshot", async () => {
    setup({ "02-promo.png": { status: "ready", url: PIXEL } });
    using _timers = fakeTimers();
    vi.setSystemTime(new Date("2026-11-21T12:00:05.000Z"));
    const card = progressCard({
      steps: [
        { index: 1, label: "Open the cart", state: "done", durationMs: 4_000 },
        { index: 2, label: "Enter promo code", state: "running", durationMs: null },
      ],
      currentStep: 2,
      totalSteps: 2,
      heartbeatAt: AT,
      latestAssetId: "02-promo.png",
    });
    await using screen = await render(
      <LivecheckProgressCard
        card={card}
        environmentId={threadRef.environmentId}
        threadRef={threadRef}
      />,
      { router: false },
    );
    const section = screen.getByRole("region", { name: "Live check in progress" }).element();
    expect(section.textContent).toContain("step 2");
    expect(section.textContent).toContain("heartbeat 5s ago");
    expect(section.textContent).toContain("Open the cart4s");
    expect(section.textContent).toContain("Enter promo code");
    expect(section.querySelector("figure")?.textContent).toBe("Latest");
    expect(section.querySelector("img")?.getAttribute("src")).toBe(PIXEL);
  });
});
