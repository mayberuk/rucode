import { describe, expect, it } from "vite-plus/test";

import { expandableImages, thumbnailCaption, verdictPresentation } from "./livecheckCards.logic";

describe("verdictPresentation", () => {
  it.each([
    ["pass", { label: "Passed", icon: "check", tone: "success" }],
    ["fail", { label: "Failed", icon: "x", tone: "destructive" }],
    ["blocked", { label: "Blocked", icon: "alert", tone: "warning" }],
    ["error", { label: "Error", icon: "alert", tone: "warning" }],
  ] as const)("presents %s", (verdict, expected) => {
    expect(verdictPresentation(verdict)).toEqual(expected);
  });
});

describe("thumbnailCaption", () => {
  it("joins the step index and label", () => {
    expect(thumbnailCaption({ index: 4, label: "Total" })).toBe("4. Total");
  });

  it("keeps a label that already contains a number", () => {
    expect(thumbnailCaption({ index: 1, label: "2 items in cart" })).toBe("1. 2 items in cart");
  });
});

describe("expandableImages", () => {
  const steps = [
    { index: 1, label: "Cart", assetId: "01-cart.png" },
    { index: 2, label: "Promo", assetId: "02-promo.png" },
    { index: 3, label: "Total", assetId: "03-total.png" },
    { index: 4, label: "Notes", assetId: null },
  ];

  it("keeps step order whatever order the urls loaded in", () => {
    const loaded = new Map([
      ["03-total.png", "blob:total"],
      ["01-cart.png", "blob:cart"],
    ]);
    expect(expandableImages(steps, loaded)).toEqual([
      { stepIndex: 1, src: "blob:cart", name: "1. Cart" },
      { stepIndex: 3, src: "blob:total", name: "3. Total" },
    ]);
  });

  it("skips steps that have not loaded and steps with no screenshot", () => {
    const loaded = new Map([["02-promo.png", "blob:promo"]]);
    expect(expandableImages(steps, loaded).map((image) => image.stepIndex)).toEqual([2]);
  });

  it("is empty when nothing has loaded", () => {
    expect(expandableImages(steps, new Map())).toEqual([]);
  });

  it("ignores loaded urls for assets no step names", () => {
    expect(expandableImages(steps, new Map([["99-other.png", "blob:other"]]))).toEqual([]);
  });
});
