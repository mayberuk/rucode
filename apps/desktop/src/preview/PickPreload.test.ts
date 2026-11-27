import { expect, it, vi } from "vite-plus/test";

import { ELEMENT_PICKED_CHANNEL, START_PICK_CHANNEL } from "./GuestProtocol.ts";
import "./PickPreload.ts";

const ipcListeners = vi.hoisted(() => new Map<string, Array<(...args: unknown[]) => void>>());
const ipcSend = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  ipcRenderer: {
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      ipcListeners.set(channel, [...(ipcListeners.get(channel) ?? []), listener]);
    },
    off: () => {},
    send: ipcSend,
    invoke: async () => undefined,
  },
}));

vi.mock("react-grab/primitives", () => ({ getElementContext: async () => null }));

const startAnnotation = (
  options: { readonly mode?: "chat" | "iter8"; readonly sendEnabled?: boolean } = {},
): ShadowRoot => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  using attachShadow = vi.spyOn(Element.prototype, "attachShadow");
  for (const listener of ipcListeners.get(START_PICK_CHANNEL) ?? [])
    listener({}, undefined, options.sendEnabled ?? false, undefined, options.mode);
  const shadowRoot = attachShadow.mock.results[0]?.value;
  if (!(shadowRoot instanceof ShadowRoot)) throw new Error("annotation overlay did not start");
  return shadowRoot;
};

it("switches tools from the keyboard after a toolbar button is clicked", () => {
  const shadowRoot = startAnnotation();
  const region = Array.from(shadowRoot.querySelectorAll("button")).find(
    (button) => button.textContent === "Region",
  );
  if (!region) throw new Error("Region toolbar button not found");

  region.focus();
  region.click();
  expect(document.documentElement.getAttribute("data-t3code-annotation-tool")).toBe("marquee");

  region.dispatchEvent(new KeyboardEvent("keydown", { key: "v", bubbles: true, composed: true }));

  expect(
    document.documentElement.getAttribute("data-t3code-annotation-tool"),
    "V should switch to Select while focus is on a toolbar button",
  ).toBe("select");
});

it("keeps the tool while typing a tool key in the comment", () => {
  const shadowRoot = startAnnotation();
  const comment = shadowRoot.querySelector("textarea");
  if (!comment) throw new Error("comment textarea not found");

  comment.focus();
  comment.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true, composed: true }));

  expect(document.documentElement.getAttribute("data-t3code-annotation-tool")).toBe("select");
});

it("keeps comment keystrokes away from the page's capture-phase shortcuts", () => {
  const pageShortcut = vi.fn((event: KeyboardEvent) => event.preventDefault());
  window.addEventListener("keydown", pageShortcut, { capture: true });
  const shadowRoot = startAnnotation();
  const comment = shadowRoot.querySelector("textarea");
  if (!comment) throw new Error("comment textarea not found");

  comment.focus();
  const space = new KeyboardEvent("keydown", {
    key: " ",
    code: "Space",
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  comment.dispatchEvent(space);
  window.removeEventListener("keydown", pageShortcut, { capture: true });

  expect(pageShortcut).not.toHaveBeenCalled();
  expect(space.defaultPrevented).toBe(false);
});

it("keeps the annotation when Escape dismisses an IME candidate in the comment", () => {
  const shadowRoot = startAnnotation();
  const comment = shadowRoot.querySelector("textarea");
  if (!comment) throw new Error("comment textarea not found");

  comment.value = "draft";
  comment.focus();
  comment.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      isComposing: true,
      bubbles: true,
      cancelable: true,
      composed: true,
    }),
  );

  expect(shadowRoot.host.isConnected).toBe(true);
  expect(comment.value).toBe("draft");
});

const toolbarButton = (shadowRoot: ShadowRoot, label: string): HTMLButtonElement => {
  const button = Array.from(shadowRoot.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`${label} button not found`);
  return button;
};

const intentRadios = (shadowRoot: ShadowRoot) =>
  Array.from(shadowRoot.querySelectorAll<HTMLButtonElement>('[role="radiogroup"] [role="radio"]'));

const checkedIntent = (shadowRoot: ShadowRoot) =>
  intentRadios(shadowRoot)
    .filter((radio) => radio.getAttribute("aria-checked") === "true")
    .map((radio) => radio.textContent);

const pressKey = (target: Element, key: string, init: KeyboardEventInit = {}) =>
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, composed: true, ...init }),
  );

const pagePage = () => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
  })) as unknown as typeof window.matchMedia;
  document.body.innerHTML =
    '<button id="first">First</button><button id="second">Second</button><p>Plain</p>';
  const first = document.querySelector("#first")!;
  const second = document.querySelector("#second")!;
  for (const [element, x] of [
    [first, 10],
    [second, 200],
  ] as const) {
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
      x,
      y: 40,
      left: x,
      top: 40,
      right: x + 90,
      bottom: 70,
      width: 90,
      height: 30,
      toJSON: () => ({}),
    });
  }
  return { first, second };
};

const clickPage = (element: Element, init: MouseEventInit = {}) => {
  document.elementsFromPoint = () => [element];
  window.dispatchEvent(
    new MouseEvent("pointerdown", { button: 0, bubbles: true, cancelable: true, ...init }),
  );
};

const pickedCalls = () =>
  ipcSend.mock.calls.filter(([channel]) => channel === ELEMENT_PICKED_CHANNEL);

it("starts an iter8 pick on Change with only element selection available", () => {
  const shadowRoot = startAnnotation({ mode: "iter8" });

  const group = shadowRoot.querySelector('[role="radiogroup"]');
  expect(group?.hasAttribute("hidden")).toBe(false);
  expect(intentRadios(shadowRoot).map((radio) => radio.textContent)).toEqual([
    "Fix",
    "Change",
    "Question",
    "Keep",
  ]);
  expect(checkedIntent(shadowRoot)).toEqual(["Change"]);
  expect(intentRadios(shadowRoot).map((radio) => radio.tabIndex)).toEqual([-1, 0, -1, -1]);
  expect(shadowRoot.querySelector("textarea")?.placeholder).toBe("What should change?");
  for (const label of ["Region", "Draw", "Erase"])
    expect(toolbarButton(shadowRoot, label).hidden, label).toBe(true);
  expect(toolbarButton(shadowRoot, "Select").hidden).toBe(false);
  expect(
    shadowRoot.querySelector('[aria-label="Expand annotation editor"]')?.hasAttribute("hidden"),
  ).toBe(true);
  expect(toolbarButton(shadowRoot, "Add").textContent).toBe("Add");
});

it("ignores the region and drawing shortcuts in an iter8 pick", () => {
  startAnnotation({ mode: "iter8" });

  pressKey(document.body, "r");
  pressKey(document.body, "d");

  expect(document.documentElement.getAttribute("data-t3code-annotation-tool")).toBe("select");
});

it("keeps the chat annotation without the intent control and with every tool", () => {
  const shadowRoot = startAnnotation();

  expect(shadowRoot.querySelector('[role="radiogroup"]')?.hasAttribute("hidden")).toBe(true);
  expect(toolbarButton(shadowRoot, "Region").hidden).toBe(false);
  expect(toolbarButton(shadowRoot, "Draw").hidden).toBe(false);
  expect(shadowRoot.querySelector("textarea")?.placeholder).toBe("Describe the change…");
  expect(toolbarButton(shadowRoot, "Attach").textContent).toBe("Attach");
});

it("moves the intent with the arrow keys, wrapping at the ends, and retitles the comment", () => {
  const shadowRoot = startAnnotation({ mode: "iter8" });
  const comment = shadowRoot.querySelector("textarea")!;
  const [fix, change, question, keep] = intentRadios(shadowRoot);

  change!.focus();
  pressKey(change!, "ArrowRight");
  expect(checkedIntent(shadowRoot)).toEqual(["Question"]);
  expect(shadowRoot.activeElement).toBe(question);
  expect(comment.placeholder).toBe("What do you want to know?");

  pressKey(question!, "ArrowDown");
  expect(checkedIntent(shadowRoot)).toEqual(["Keep"]);
  expect(comment.placeholder).toBe("What should stay as it is?");

  pressKey(keep!, "ArrowRight");
  expect(checkedIntent(shadowRoot)).toEqual(["Fix"]);
  expect(comment.placeholder).toBe("What is wrong?");

  pressKey(fix!, "ArrowLeft");
  expect(checkedIntent(shadowRoot)).toEqual(["Keep"]);

  pressKey(keep!, "ArrowUp");
  expect(checkedIntent(shadowRoot)).toEqual(["Question"]);

  change!.click();
  expect(checkedIntent(shadowRoot)).toEqual(["Change"]);
  expect(comment.placeholder).toBe("What should change?");
});

it("replaces the selected element instead of adding a second one in an iter8 pick", async () => {
  const { first, second } = pagePage();
  const shadowRoot = startAnnotation({ mode: "iter8" });
  ipcSend.mockClear();

  clickPage(first);
  clickPage(second, { shiftKey: true });
  toolbarButton(shadowRoot, "Add").click();

  await vi.waitFor(() => expect(pickedCalls()).toHaveLength(1));
  const [, annotation] = pickedCalls()[0]!;
  expect(annotation.elements).toHaveLength(1);
  expect(annotation.iter8.anchor.selector).toEqual(["button#second"]);
});

it("adds an iter8 note with the chosen intent and anchor, even on Cmd/Ctrl+Enter", async () => {
  const { second } = pagePage();
  const shadowRoot = startAnnotation({ mode: "iter8", sendEnabled: true });
  ipcSend.mockClear();
  clickPage(second);
  const comment = shadowRoot.querySelector("textarea")!;
  const question = intentRadios(shadowRoot)[2]!;
  question.click();
  comment.value = "Why is this here?";
  comment.focus();

  pressKey(comment, "Enter", { ctrlKey: true });

  await vi.waitFor(() => expect(pickedCalls()).toHaveLength(1));
  const [, annotation, , submission] = pickedCalls()[0]!;
  expect(submission).toBe("attach");
  expect(annotation.comment).toBe("Why is this here?");
  expect(annotation.iter8).toEqual({
    intent: "question",
    anchor: {
      selector: ["button#second"],
      role: "button",
      text: "Second",
      box: { x: 200, y: 40, width: 90, height: 30 },
    },
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    },
    theme: "light",
  });
});

it("returns a chat annotation without an iter8 field", async () => {
  const { first } = pagePage();
  const shadowRoot = startAnnotation();
  ipcSend.mockClear();

  clickPage(first);
  toolbarButton(shadowRoot, "Attach").click();

  await vi.waitFor(() => expect(pickedCalls()).toHaveLength(1));
  const [, annotation, , submission] = pickedCalls()[0]!;
  expect(submission).toBe("attach");
  expect(annotation).not.toHaveProperty("iter8");
});

it("cancels an iter8 pick on Escape with no annotation", () => {
  const { first } = pagePage();
  const shadowRoot = startAnnotation({ mode: "iter8" });
  ipcSend.mockClear();
  clickPage(first);
  const comment = shadowRoot.querySelector("textarea")!;
  comment.value = "half a note";
  comment.focus();

  pressKey(comment, "Escape");

  expect(pickedCalls()).toEqual([[ELEMENT_PICKED_CHANNEL, null]]);
  expect(shadowRoot.host.isConnected).toBe(false);
});
