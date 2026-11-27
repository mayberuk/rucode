import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildIter8Anchor,
  buildIter8Target,
  iter8Theme,
  resolveIter8Selector,
} from "./Iter8Anchor.ts";

const fakeWindow = (overrides: Partial<Window> = {}): Window =>
  ({
    scrollX: 0,
    scrollY: 0,
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 2,
    matchMedia: (query: string) => ({ matches: false, media: query }),
    ...overrides,
  }) as unknown as Window;

const mount = (html: string): HTMLElement => {
  document.body.innerHTML = html;
  return document.body;
};

const placeAt = (element: Element, rect: { x: number; y: number; w: number; h: number }) =>
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: rect.x,
    y: rect.y,
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.w,
    bottom: rect.y + rect.h,
    width: rect.w,
    height: rect.h,
    toJSON: () => ({}),
  });

describe("buildIter8Anchor", () => {
  it("writes one selector per shadow-root hop, outermost first", () => {
    const body = mount('<main><section><x-card id="card"></x-card></section></main>');
    const card = body.querySelector("#card")!;
    const shadow = card.attachShadow({ mode: "open" });
    shadow.innerHTML = '<div><span>a</span><button id="save">Save</button></div>';
    const save = shadow.querySelector("#save")!;

    expect(buildIter8Anchor(save, fakeWindow()).selector).toEqual(["x-card#card", "button#save"]);
  });

  it("pins a shadow hop without an id to the shadow root and counts same-tag siblings", () => {
    const body = mount('<div id="host"></div>');
    const shadow = body.querySelector("#host")!.attachShadow({ mode: "open" });
    shadow.innerHTML = "<p>one</p><span></span><p>two</p>";
    const second = shadow.querySelectorAll("p")[1]!;

    expect(buildIter8Anchor(second, fakeWindow()).selector).toEqual([
      "div#host",
      ":host > p:nth-of-type(2)",
    ]);
  });

  it("walks a light-DOM element up to body when nothing nearer is unique", () => {
    const body = mount("<ul><li>a</li><li><a>b</a></li></ul>");
    const link = body.querySelectorAll("a")[0]!;

    expect(buildIter8Anchor(link, fakeWindow()).selector).toEqual([
      "body > ul:nth-of-type(1) > li:nth-of-type(2) > a:nth-of-type(1)",
    ]);
  });

  it.each([
    ["<button>Go</button>", "button", "button"],
    ['<a href="/plans">Plans</a>', "a", "link"],
    ["<a>Plain</a>", "a", undefined],
    ['<input type="checkbox">', "input", "checkbox"],
    ["<input>", "input", "textbox"],
    ["<select><option>x</option></select>", "select", "combobox"],
    ["<textarea></textarea>", "textarea", "textbox"],
    ['<img alt="Logo">', "img", "img"],
    ["<h3>Title</h3>", "h3", "heading"],
    ['<button role="tab">Tab</button>', "button", "tab"],
    ["<div>Box</div>", "div", undefined],
  ])("derives the role of %s", (html, tag, role) => {
    const element = mount(html).querySelector(tag)!;

    expect(buildIter8Anchor(element, fakeWindow()).role).toBe(role);
  });

  it("prefers aria-label, then aria-labelledby, then a label element", () => {
    const body = mount(`
      <span id="lead">Lead</span><span id="tail">text</span>
      <button id="both" aria-label="  Close   dialog " aria-labelledby="lead">x</button>
      <button id="labelled" aria-labelledby="lead tail">x</button>
      <label for="email">Email address</label><input id="email">
      <button id="none">x</button>
    `);

    expect(buildIter8Anchor(body.querySelector("#both")!, fakeWindow()).name).toBe("Close dialog");
    expect(buildIter8Anchor(body.querySelector("#labelled")!, fakeWindow()).name).toBe("Lead text");
    expect(buildIter8Anchor(body.querySelector("#email")!, fakeWindow()).name).toBe(
      "Email address",
    );
    expect(buildIter8Anchor(body.querySelector("#none")!, fakeWindow())).not.toHaveProperty("name");
  });

  it("squeezes whitespace in the text and stops at 200 characters", () => {
    const body = mount(
      `<p id="short">  Pay   now\n </p><p id="long">${"a".repeat(201)}</p><p id="empty">  </p>`,
    );

    expect(buildIter8Anchor(body.querySelector("#short")!, fakeWindow()).text).toBe("Pay now");
    expect(buildIter8Anchor(body.querySelector("#long")!, fakeWindow()).text).toBe("a".repeat(200));
    expect(buildIter8Anchor(body.querySelector("#empty")!, fakeWindow())).not.toHaveProperty(
      "text",
    );
  });

  it("caps the accessible name at the same 200 characters iter8 compares against", () => {
    const body = mount(`<button aria-label="${"n".repeat(201)}">x</button>`);

    expect(buildIter8Anchor(body.querySelector("button")!, fakeWindow()).name).toBe(
      "n".repeat(200),
    );
  });

  it("reports the box in page coordinates of a scrolled window", () => {
    const button = mount("<button>Go</button>").querySelector("button")!;
    placeAt(button, { x: 10, y: 20, w: 120, h: 32 });

    expect(buildIter8Anchor(button, fakeWindow({ scrollX: 30, scrollY: 400 })).box).toEqual({
      x: 40,
      y: 420,
      width: 120,
      height: 32,
    });
  });
});

describe("buildIter8Target", () => {
  it("carries the intent, the viewport and the page's colour scheme", () => {
    const button = mount("<button>Go</button>").querySelector("button")!;
    const dark = fakeWindow({
      matchMedia: ((query: string) => ({
        matches: query === "(prefers-color-scheme: dark)",
      })) as unknown as Window["matchMedia"],
    });

    const target = buildIter8Target(button, "question", dark);

    expect(target.intent).toBe("question");
    expect(target.viewport).toEqual({ width: 1280, height: 800, devicePixelRatio: 2 });
    expect(target.theme).toBe("dark");
    expect(iter8Theme(fakeWindow())).toBe("light");
  });
});

describe("resolveIter8Selector", () => {
  it("walks selector hops through shadow roots", () => {
    const body = mount('<x-card id="card"></x-card>');
    const shadow = body.querySelector("#card")!.attachShadow({ mode: "open" });
    shadow.innerHTML = '<button id="save">Save</button>';

    expect(resolveIter8Selector(["x-card#card", "button#save"], document)).toBe(
      shadow.querySelector("#save"),
    );
  });

  it("finds nothing when a hop is missing, has no shadow root, or is not valid CSS", () => {
    mount('<x-card id="card"></x-card><div id="plain"></div>');

    expect(resolveIter8Selector(["x-card#other", "button"], document)).toBeNull();
    expect(resolveIter8Selector(["div#plain", "button"], document)).toBeNull();
    expect(resolveIter8Selector(["div[[["], document)).toBeNull();
    expect(resolveIter8Selector([], document)).toBeNull();
  });
});
