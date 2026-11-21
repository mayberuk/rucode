import { expect, it, vi } from "vite-plus/test";

import { cardRenderers } from "./cards";
import { liveCardRenderers } from "./live";
import { pluginCardRenderer } from "./registry";

vi.mock(import("./cards"), () => ({
  cardRenderers: {
    "gitty.push": function PushCard() {
      return null;
    },
  },
}));
vi.mock(import("./live"), () => ({
  liveCardRenderers: {
    "dispatch.verify": function VerifyCard() {
      return null;
    },
  },
}));

it.each([
  ["gitty.conflict", null],
  ["gitty.push", cardRenderers["gitty.push"]],
  ["dispatch.verify", liveCardRenderers["dispatch.verify"]],
] as const)("resolves the renderer for %s", (kind, renderer) => {
  expect(pluginCardRenderer(kind)).toBe(renderer);
});
