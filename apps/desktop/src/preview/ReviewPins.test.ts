import type { DesktopPreviewAnnotationTheme } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createReviewPins, decodeReviewPinsInput } from "./ReviewPins.ts";

const HIDE_OVERLAY = "iter8-overlay { display: none !important; }";

const setup = (options: { readonly reducedMotion?: boolean } = {}) => {
  vi.restoreAllMocks();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  for (const node of document.querySelectorAll("[data-t3code-review-pins]")) node.remove();
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  window.matchMedia = ((query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)" && options.reducedMotion === true,
  })) as unknown as typeof window.matchMedia;
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  const attachShadow = vi.spyOn(Element.prototype, "attachShadow");
  const pins = createReviewPins(window);
  const pinNodes = (): HTMLElement[] => {
    const root = attachShadow.mock.results.at(-1)?.value;
    if (!(root instanceof ShadowRoot)) return [];
    return Array.from(root.querySelectorAll<HTMLElement>(".pin"));
  };
  const visiblePins = () => pinNodes().filter((node) => node.style.display !== "none");
  const runFrames = () => {
    for (const callback of frames.splice(0)) callback(0);
  };
  return {
    pins,
    pinNodes,
    visiblePins,
    runFrames,
    frames,
    scrollIntoView,
    [Symbol.dispose]: () => pins.update(null),
  };
};

const placeAt = (element: Element, x: number, y: number, width: number, height: number) =>
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x,
    y,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    width,
    height,
    toJSON: () => ({}),
  });

const hidingStyles = () =>
  Array.from(document.querySelectorAll("style")).filter(
    (style) => style.textContent === HIDE_OVERLAY,
  );
const pinsHosts = () => document.querySelectorAll("div[data-t3code-review-pins]");

const page = () => {
  document.body.innerHTML = '<button id="pay">Pay</button><a id="plans" href="/plans">Plans</a>';
  const pay = document.querySelector("#pay")!;
  const plans = document.querySelector("#plans")!;
  placeAt(pay, 100, 50, 80, 20);
  placeAt(plans, 300, 200, 40, 16);
  return { pay, plans };
};

describe("createReviewPins", () => {
  it("draws one numbered pin at the top-right of each element it finds and skips the rest", () => {
    using harness = setup();
    const { pins, visiblePins } = harness;
    page();

    pins.update({
      pins: [
        { label: "1", selector: ["button#pay"], resolved: false },
        { label: "2", selector: ["section#gone"], resolved: false },
        { label: "3", selector: ["a#plans"], resolved: false },
      ],
      focusLabel: null,
    });

    expect(visiblePins().map((node) => node.textContent)).toEqual(["1", "3"]);
    expect(visiblePins().map((node) => node.style.transform)).toEqual([
      "translate(170px, 40px)",
      "translate(330px, 190px)",
    ]);
  });

  it("marks a resolved pin with a check glyph, not colour alone", () => {
    using harness = setup();
    const { pins, visiblePins } = harness;
    page();

    pins.update({
      pins: [
        { label: "1", selector: ["button#pay"], resolved: true },
        { label: "2", selector: ["a#plans"], resolved: false },
      ],
      focusLabel: null,
    });

    const [resolved, open] = visiblePins();
    expect(resolved?.hasAttribute("data-resolved")).toBe(true);
    expect(resolved?.querySelector("svg")).not.toBeNull();
    expect(resolved?.textContent).toBe("1");
    expect(open?.hasAttribute("data-resolved")).toBe(false);
    expect(open?.querySelector("svg")).toBeNull();
  });

  it("hides iter8's overlay even when there are no pins", () => {
    using harness = setup();
    const { pins, pinNodes } = harness;

    pins.update({ pins: [], focusLabel: null });

    expect(hidingStyles()).toHaveLength(1);
    expect(pinsHosts()).toHaveLength(1);
    expect(pinNodes()).toHaveLength(0);
  });

  it("replaces the drawn pins on each update without stacking hosts or styles", () => {
    using harness = setup();
    const { pins, visiblePins } = harness;
    page();

    pins.update({
      pins: [{ label: "1", selector: ["button#pay"], resolved: false }],
      focusLabel: null,
    });
    pins.update({
      pins: [{ label: "4", selector: ["a#plans"], resolved: false }],
      focusLabel: null,
    });

    expect(visiblePins().map((node) => node.textContent)).toEqual(["4"]);
    expect(hidingStyles()).toHaveLength(1);
    expect(pinsHosts()).toHaveLength(1);
  });

  it("removes pins, the hiding style and its listeners when cleared", () => {
    using harness = setup();
    const { pins, frames } = harness;
    page();
    pins.update({
      pins: [{ label: "1", selector: ["button#pay"], resolved: false }],
      focusLabel: null,
    });

    pins.update(null);
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));

    expect(hidingStyles()).toHaveLength(0);
    expect(pinsHosts()).toHaveLength(0);
    expect(frames).toHaveLength(0);
  });

  it("follows the page on scroll and resize, once per frame", () => {
    using harness = setup();
    const { pins, visiblePins, runFrames, frames } = harness;
    const { pay } = page();
    pins.update({
      pins: [{ label: "1", selector: ["button#pay"], resolved: false }],
      focusLabel: null,
    });

    placeAt(pay, 100, 10, 80, 20);
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("scroll"));
    expect(frames).toHaveLength(1);
    runFrames();

    expect(visiblePins()[0]?.style.transform).toBe("translate(170px, 0px)");
  });

  it("draws a pin whose element appears after the pins were set", async () => {
    using harness = setup();
    const { pins, visiblePins, runFrames } = harness;
    pins.update({
      pins: [{ label: "1", selector: ["button#late"], resolved: false }],
      focusLabel: null,
    });
    expect(visiblePins()).toHaveLength(0);

    const late = document.createElement("button");
    late.id = "late";
    placeAt(late, 20, 20, 40, 20);
    document.body.appendChild(late);
    await Promise.resolve();
    runFrames();

    expect(visiblePins().map((node) => node.textContent)).toEqual(["1"]);
  });

  it.each([
    [true, "auto"],
    [false, "smooth"],
  ] as const)(
    "scrolls the focused pin's element into view (reduced motion %s uses %s)",
    (reducedMotion, behavior) => {
      using harness = setup({ reducedMotion });
      const { pins, scrollIntoView, visiblePins } = harness;
      const { plans } = page();

      pins.update({
        pins: [
          { label: "1", selector: ["button#pay"], resolved: false },
          { label: "2", selector: ["a#plans"], resolved: false },
        ],
        focusLabel: "2",
      });

      expect(scrollIntoView).toHaveBeenCalledOnce();
      expect(scrollIntoView.mock.contexts[0]).toBe(plans);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior });
      expect(visiblePins().map((node) => node.hasAttribute("data-focused"))).toEqual([false, true]);
    },
  );

  it("does not scroll again when the same focus is re-sent, only when it changes", () => {
    using harness = setup();
    const { pins, scrollIntoView } = harness;
    const { pay, plans } = page();
    const list = [
      { label: "1", selector: ["button#pay"], resolved: false },
      { label: "2", selector: ["a#plans"], resolved: false },
    ];

    pins.update({ pins: list, focusLabel: "2" });
    pins.update({ pins: list, focusLabel: "2" });
    pins.update({ pins: list, focusLabel: "1" });

    expect(scrollIntoView.mock.contexts).toEqual([plans, pay]);
  });

  it("scrolls to a focused element once it appears on the page", async () => {
    using harness = setup();
    const { pins, scrollIntoView, runFrames } = harness;
    pins.update({
      pins: [{ label: "1", selector: ["button#late"], resolved: false }],
      focusLabel: "1",
    });
    expect(scrollIntoView).not.toHaveBeenCalled();

    const late = document.createElement("button");
    late.id = "late";
    placeAt(late, 20, 20, 40, 20);
    document.body.appendChild(late);
    await Promise.resolve();
    runFrames();

    expect(scrollIntoView.mock.contexts).toEqual([late]);
  });

  it("does not scroll for a focus label no pin carries", () => {
    using harness = setup();
    const { pins, scrollIntoView } = harness;
    page();

    pins.update({
      pins: [{ label: "1", selector: ["button#pay"], resolved: false }],
      focusLabel: "9",
    });

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("paints the app theme onto the pins host", () => {
    using harness = setup();
    const { pins } = harness;
    pins.applyTheme({
      colorScheme: "dark",
      primary: "rgb(1 2 3)",
      mutedForeground: "rgb(4 5 6)",
    } as DesktopPreviewAnnotationTheme);

    pins.update({ pins: [], focusLabel: null });

    const host = pinsHosts()[0] as HTMLElement;
    expect(host.style.getPropertyValue("--t3-primary")).toBe("rgb(1 2 3)");
    expect(host.style.getPropertyValue("--t3-muted-foreground")).toBe("rgb(4 5 6)");
    expect(host.style.colorScheme).toBe("dark");
  });
});

describe("decodeReviewPinsInput", () => {
  it("passes null through as a clear and ignores anything that is not a pins list", () => {
    const valid = { pins: [{ label: "1", selector: ["a"], resolved: false }], focusLabel: null };

    expect(decodeReviewPinsInput(null)).toBeNull();
    expect(decodeReviewPinsInput(valid)).toEqual(valid);
    expect(decodeReviewPinsInput(undefined)).toBeUndefined();
    expect(decodeReviewPinsInput({ pins: "1", focusLabel: null })).toBeUndefined();
    expect(
      decodeReviewPinsInput({
        pins: [{ label: 1, selector: [], resolved: false }],
        focusLabel: null,
      }),
    ).toBeUndefined();
    expect(
      decodeReviewPinsInput({
        pins: [{ label: "1", selector: [2], resolved: false }],
        focusLabel: null,
      }),
    ).toBeUndefined();
    expect(decodeReviewPinsInput({ pins: [], focusLabel: 3 })).toBeUndefined();
  });
});
