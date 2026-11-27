import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";

import { Route as BoardRoute } from "../../routes/_chat.board";
import { boardSearchFromUrl } from "./boardSearch";

vi.mock("./BoardPage", () => ({ BoardPage: () => "Board page test marker" }));

const cases: ReadonlyArray<{
  name: string;
  raw: Record<string, unknown>;
  expected: { environmentId?: string; slug?: string };
  url?: string;
}> = [
  {
    name: "keeps both valid keys in their original fields",
    raw: { environmentId: "alpha", slug: "checkout-retries" },
    expected: { environmentId: "alpha", slug: "checkout-retries" },
  },
  {
    name: "omits an absent environment",
    raw: { slug: "checkout-retries" },
    expected: { slug: "checkout-retries" },
  },
  {
    name: "omits an absent slug",
    raw: { environmentId: "alpha" },
    expected: { environmentId: "alpha" },
  },
  {
    name: "returns no keys for empty search",
    raw: {},
    expected: {},
    url: "/board",
  },
  {
    name: "omits empty strings in both fields",
    raw: { environmentId: "", slug: "" },
    expected: {},
  },
  {
    name: "omits whitespace-only strings in both fields",
    raw: { environmentId: " \t", slug: "\n " },
    expected: {},
  },
  {
    name: "stringifies zero and a positive numeric slug",
    raw: { environmentId: 0, slug: 42 },
    expected: { environmentId: "0", slug: "42" },
    url: "/board?environmentId=0&slug=42",
  },
  {
    name: "keeps the sign and fraction of finite numbers",
    raw: { environmentId: -42, slug: -0.5 },
    expected: { environmentId: "-42", slug: "-0.5" },
  },
  {
    name: "rejects NaN and positive infinity",
    raw: { environmentId: NaN, slug: Infinity },
    expected: {},
  },
  {
    name: "rejects negative infinity and NaN",
    raw: { environmentId: -Infinity, slug: NaN },
    expected: {},
  },
  {
    name: "rejects objects in both fields",
    raw: { environmentId: { id: "alpha" }, slug: { id: "checkout-retries" } },
    expected: {},
  },
  {
    name: "rejects arrays in both fields",
    raw: { environmentId: ["alpha"], slug: ["checkout-retries"] },
    expected: {},
  },
  {
    name: "rejects booleans in both fields",
    raw: { environmentId: true, slug: false },
    expected: {},
  },
  {
    name: "rejects null in both fields",
    raw: { environmentId: null, slug: null },
    expected: {},
  },
  {
    name: "drops extra keys and preserves an unknown slug",
    raw: { environmentId: "alpha", slug: "unknown-initiative", view: "details" },
    expected: { environmentId: "alpha", slug: "unknown-initiative" },
    url: "/board?environmentId=alpha&slug=unknown-initiative",
  },
  {
    name: "trims both values without collapsing internal spaces",
    raw: { environmentId: " alpha\t", slug: "\n checkout retries  " },
    expected: { environmentId: "alpha", slug: "checkout retries" },
  },
  {
    name: "keeps the 200th character and drops the 201st",
    raw: { environmentId: "a".repeat(200), slug: `${"b".repeat(200)}c` },
    expected: { environmentId: "a".repeat(200), slug: "b".repeat(200) },
  },
  {
    name: "trims before capping a 300-character value",
    raw: { environmentId: ` ${"a".repeat(300)} `, slug: "b".repeat(300) },
    expected: { environmentId: "a".repeat(200), slug: "b".repeat(200) },
  },
];

it.each(cases)("$name", async ({ raw, expected, url }) => {
  expect(boardSearchFromUrl(raw)).toStrictEqual(expected);

  if (url !== undefined) {
    expect(BoardRoute.options.validateSearch).toBe(boardSearchFromUrl);
    expect(BoardRoute.options.pendingComponent).toBeUndefined();
    expect(BoardRoute.options.loader).toBeUndefined();

    const root = createRootRoute();
    const chat = createRoute({ getParentRoute: () => root, id: "_chat" });
    const board = createRoute({
      getParentRoute: () => chat,
      path: "board",
      validateSearch: BoardRoute.options.validateSearch,
    });
    const router = createRouter({
      routeTree: root.addChildren([chat.addChildren([board])]),
      history: createMemoryHistory({ initialEntries: [url] }),
    });
    expect(router.matchRoutes(router.latestLocation).at(-1)?.search).toStrictEqual(expected);

    const component = BoardRoute.options.component;
    if (!component) throw new Error("The board route must declare a component");
    await component.preload?.();
    expect(renderToStaticMarkup(createElement(component))).toBe("Board page test marker");
  }
});
