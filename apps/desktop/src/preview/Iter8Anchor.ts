import type {
  Iter8ElementAnchor,
  Iter8Intent,
  Iter8PickedTarget,
  Iter8Viewport,
} from "@t3tools/contracts";

// Selector shape, role, name and text mirror iter8's own overlay snapshot: iter8 re-anchors a
// stored note by recomputing these and comparing them exactly, so any divergence loses the note.
const ROLE_MAX = 64;
const NAME_MAX = 200;
const TEXT_MAX = 200;

/** React's `useId` values are minted per render tree, so a selector anchored on one breaks on reload. */
const GENERATED_ID = /«r[0-9a-z]+»|:r[0-9a-z]+:|_r_[0-9a-z]+_/;

type TreeRoot = Document | ShadowRoot;

function uniqueIn(root: TreeRoot, element: Element, selector: string): boolean {
  const matches = root.querySelectorAll(selector);
  return matches.length === 1 && matches[0] === element;
}

function nthOfType(element: Element, qualifier = ""): string {
  const tag = element.localName;
  let index = 1;
  for (let at = element.previousElementSibling; at !== null; at = at.previousElementSibling)
    if (at.localName === tag) index += 1;
  return `${CSS.escape(tag)}${qualifier}:nth-of-type(${index})`;
}

function stopSegment(element: Element, root: TreeRoot): string | null {
  const tag = element.localName;
  if (root.nodeType === Node.DOCUMENT_NODE && (tag === "body" || tag === "html")) return tag;
  const id = element.id;
  if (id !== "" && !GENERATED_ID.test(id) && root.getElementById(id) === element) {
    const selector = `${CSS.escape(tag)}#${CSS.escape(id)}`;
    if (uniqueIn(root, element, selector)) return selector;
  }
  const testid = element.getAttribute("data-testid");
  if (testid !== null && testid !== "") {
    const selector = `${CSS.escape(tag)}[data-testid="${CSS.escape(testid)}"]`;
    if (uniqueIn(root, element, selector)) return selector;
  }
  return null;
}

function stepSegment(element: Element): string {
  const testid = element.getAttribute("data-testid");
  return testid === null || testid === ""
    ? nthOfType(element)
    : nthOfType(element, `[data-testid="${CSS.escape(testid)}"]`);
}

/** A shadow root has no `html` to stop at, so its walk is pinned to the root with `:host >`. */
function selectorWithin(element: Element, root: TreeRoot): string {
  const segments: string[] = [];
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    const stop = stopSegment(node, root);
    if (stop !== null) return [stop, ...segments].join(" > ");
    segments.unshift(stepSegment(node));
  }
  return [":host", ...segments].join(" > ");
}

function isShadowRoot(node: Node): node is ShadowRoot {
  return node.nodeType === Node.DOCUMENT_FRAGMENT_NODE && "host" in node;
}

function selectorPath(element: Element): [string, ...string[]] {
  const root = element.getRootNode();
  if (!isShadowRoot(root)) return [selectorWithin(element, element.ownerDocument)];
  return [...selectorPath(root.host), selectorWithin(element, root)];
}

const TAG_ROLES: Record<string, string> = {
  article: "article",
  aside: "complementary",
  button: "button",
  dialog: "dialog",
  fieldset: "group",
  details: "group",
  form: "form",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  hr: "separator",
  li: "listitem",
  main: "main",
  menu: "list",
  meter: "meter",
  nav: "navigation",
  ol: "list",
  option: "option",
  output: "status",
  progress: "progressbar",
  table: "table",
  tbody: "rowgroup",
  td: "cell",
  textarea: "textbox",
  tfoot: "rowgroup",
  th: "columnheader",
  thead: "rowgroup",
  tr: "row",
  ul: "list",
};

const LANDMARK_SCOPE = "article, aside, main, nav, section";

function inputRole(input: HTMLInputElement): string | undefined {
  switch (input.type) {
    case "button":
    case "submit":
    case "reset":
    case "image":
      return "button";
    case "checkbox":
      return "checkbox";
    case "radio":
      return "radio";
    case "range":
      return "slider";
    case "number":
      return "spinbutton";
    case "hidden":
      return undefined;
    case "search":
      return input.hasAttribute("list") ? "combobox" : "searchbox";
    default:
      return input.hasAttribute("list") ? "combobox" : "textbox";
  }
}

function implicitRole(element: Element): string | undefined {
  const tag = element.localName;
  if (tag === "a" || tag === "area") return element.hasAttribute("href") ? "link" : undefined;
  if (tag === "input") return inputRole(element as HTMLInputElement);
  if (tag === "select") {
    const select = element as HTMLSelectElement;
    return select.multiple || select.size > 1 ? "listbox" : "combobox";
  }
  if (tag === "img") return element.getAttribute("alt") === "" ? "presentation" : "img";
  if (tag === "header" || tag === "footer") {
    if (element.parentElement?.closest(LANDMARK_SCOPE) != null) return undefined;
    return tag === "header" ? "banner" : "contentinfo";
  }
  if (tag === "section") return accessibleName(element) === undefined ? undefined : "region";
  return TAG_ROLES[tag];
}

function roleOf(element: Element): string | undefined {
  const explicit = element.getAttribute("role")?.trim().split(/\s+/)[0];
  const role = explicit === undefined || explicit === "" ? implicitRole(element) : explicit;
  return role?.slice(0, ROLE_MAX);
}

function squeezed(value: string | null | undefined, max: number): string | undefined {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text === "" ? undefined : text.slice(0, max);
}

function accessibleName(element: Element): string | undefined {
  const label = squeezed(element.getAttribute("aria-label"), NAME_MAX);
  if (label !== undefined) return label;

  // A detached element is its own root and has no id lookup.
  const root = element.getRootNode() as Partial<TreeRoot>;
  const byId = root.getElementById?.bind(root);
  const ids = element.getAttribute("aria-labelledby")?.trim().split(/\s+/) ?? [];
  const labelledBy =
    byId === undefined
      ? undefined
      : squeezed(ids.map((id) => byId(id)?.textContent ?? "").join(" "), NAME_MAX);
  if (labelledBy !== undefined) return labelledBy;

  const labels = (element as { labels?: NodeListOf<HTMLLabelElement> | null }).labels ?? [];
  return squeezed(Array.from(labels, (label) => label.textContent ?? "").join(" "), NAME_MAX);
}

/** Equals `squeezed(element.textContent, TEXT_MAX)` but stops reading once it has enough. */
function leadingText(element: Element): string | undefined {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let text = "";
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const chunk = (node.nodeValue ?? "").replace(/\s+/g, " ");
    text += text === "" || text.endsWith(" ") ? chunk.trimStart() : chunk;
    if (text.length > TEXT_MAX) break;
  }
  return squeezed(text, TEXT_MAX);
}

export function buildIter8Anchor(element: Element, win: Window): Iter8ElementAnchor {
  const role = roleOf(element);
  const name = accessibleName(element);
  const text = leadingText(element);
  const rect = element.getBoundingClientRect();
  return {
    selector: selectorPath(element),
    ...(role === undefined ? {} : { role }),
    ...(name === undefined ? {} : { name }),
    ...(text === undefined ? {} : { text }),
    box: {
      x: rect.left + win.scrollX,
      y: rect.top + win.scrollY,
      width: Math.abs(rect.width),
      height: Math.abs(rect.height),
    },
  };
}

export function iter8Viewport(win: Window): Iter8Viewport {
  return {
    width: win.innerWidth,
    height: win.innerHeight,
    devicePixelRatio: win.devicePixelRatio,
  };
}

export function iter8Theme(win: Window): "light" | "dark" {
  return win.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function buildIter8Target(
  element: Element,
  intent: Iter8Intent,
  win: Window,
): Iter8PickedTarget {
  return {
    intent,
    anchor: buildIter8Anchor(element, win),
    viewport: iter8Viewport(win),
    theme: iter8Theme(win),
  };
}

// A malformed selector (an agent-authored anchor, say) matches nothing rather than throwing.
function matchFirst(root: ParentNode, selector: string): Element | null {
  try {
    return root.querySelector(selector);
  } catch {
    return null;
  }
}

/** Walks one selector per shadow-root hop, outermost first; null when any hop is missing. */
export function resolveIter8Selector(
  selector: ReadonlyArray<string>,
  doc: Document,
): Element | null {
  let root: ParentNode = doc;
  for (let index = 0; index < selector.length; index += 1) {
    const element = matchFirst(root, selector[index]!);
    if (element === null) return null;
    if (index === selector.length - 1) return element;
    if (element.shadowRoot === null) return null;
    root = element.shadowRoot;
  }
  return null;
}
