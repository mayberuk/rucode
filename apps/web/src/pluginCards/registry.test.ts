import { expect, it } from "vite-plus/test";

import { pluginCardRenderer } from "./registry";

it("returns no renderer for an unregistered card kind", () => {
  expect(pluginCardRenderer("gitty.conflict")).toBeNull();
});
