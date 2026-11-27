// @effect-diagnostics globalDate:off globalTimers:off - This isolated Electron preload does not run inside an Effect runtime.
import type { DesktopPreviewAnnotationTheme, DesktopPreviewReviewPin } from "@t3tools/contracts";

import { resolveIter8Selector } from "./Iter8Anchor.ts";

const PINS_ATTRIBUTE = "data-t3code-review-pins";
// One below the annotation overlay, so an open note composer stays above the pins.
const Z_INDEX_PINS = 2147483645;
const PIN_SIZE = 20;

const PIN_STYLES = `
:host {
  --t3-font-sans: "DM Sans Variable", "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --t3-popover: white;
  --t3-primary: oklch(0.488 0.217 264);
  --t3-primary-foreground: white;
  --t3-muted-foreground: oklch(0.556 0 0);
  --t3-border: rgb(0 0 0 / 8%);
  --t3-ring: oklch(0.488 0.217 264);
}
.pin {
  position: fixed;
  top: 0;
  left: 0;
  display: none;
  align-items: center;
  justify-content: center;
  gap: 2px;
  box-sizing: border-box;
  min-width: ${PIN_SIZE}px;
  height: ${PIN_SIZE}px;
  padding: 0 6px;
  border-radius: ${PIN_SIZE / 2}px;
  border: 1px solid var(--t3-popover);
  background: var(--t3-primary);
  color: var(--t3-primary-foreground);
  font: 600 11px/1 var(--t3-font-sans);
  font-variant-numeric: tabular-nums;
  box-shadow: 0 1px 3px rgb(0 0 0 / 20%);
  pointer-events: none;
}
.pin[data-resolved] {
  border-color: var(--t3-border);
  background: var(--t3-popover);
  color: var(--t3-muted-foreground);
}
.pin[data-focused] {
  outline: 2px solid var(--t3-ring);
  outline-offset: 2px;
}
`;

const CHECK_GLYPH =
  '<svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true"><path d="m5 12 4 4L19 6" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export interface ReviewPinsInput {
  readonly pins: ReadonlyArray<DesktopPreviewReviewPin>;
  readonly focusLabel: string | null;
}

function isReviewPin(value: unknown): value is DesktopPreviewReviewPin {
  if (typeof value !== "object" || value === null) return false;
  const pin = value as Record<string, unknown>;
  return (
    typeof pin["label"] === "string" &&
    typeof pin["resolved"] === "boolean" &&
    Array.isArray(pin["selector"]) &&
    pin["selector"].every((hop) => typeof hop === "string")
  );
}

/** Null clears the pins; anything that is not a pins list is ignored. */
export function decodeReviewPinsInput(value: unknown): ReviewPinsInput | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const focusLabel = input["focusLabel"];
  if (!Array.isArray(input["pins"]) || !input["pins"].every(isReviewPin)) return undefined;
  if (focusLabel !== null && typeof focusLabel !== "string") return undefined;
  return { pins: input["pins"], focusLabel };
}

interface DrawnPin {
  readonly pin: DesktopPreviewReviewPin;
  readonly node: HTMLElement;
}

interface Mounted {
  readonly host: HTMLElement;
  readonly hideOverlay: HTMLStyleElement;
  readonly layer: HTMLElement;
  readonly observer: MutationObserver;
  readonly schedule: () => void;
  drawn: DrawnPin[];
  frame: number | null;
  pendingFocus: string | null;
}

export interface ReviewPins {
  readonly update: (input: ReviewPinsInput | null) => void;
  readonly applyTheme: (theme: DesktopPreviewAnnotationTheme | null) => void;
}

/**
 * Draws numbered pins over the elements iter8 notes point at, and hides iter8's own injected
 * overlay while they are shown so the page never carries two note composers.
 */
export function createReviewPins(win: Window): ReviewPins {
  const doc = win.document;
  let mounted: Mounted | null = null;
  let theme: DesktopPreviewAnnotationTheme | null = null;
  let lastFocus: string | null = null;

  const paintTheme = (host: HTMLElement): void => {
    if (!theme) return;
    host.style.colorScheme = theme.colorScheme;
    const variables = {
      "--t3-font-sans": theme.fontSans,
      "--t3-popover": theme.popover,
      "--t3-primary": theme.primary,
      "--t3-primary-foreground": theme.primaryForeground,
      "--t3-muted-foreground": theme.mutedForeground,
      "--t3-border": theme.border,
      "--t3-ring": theme.ring,
    };
    for (const [name, value] of Object.entries(variables)) host.style.setProperty(name, value);
  };

  const position = (state: Mounted): void => {
    for (const { pin, node } of state.drawn) {
      const element = resolveIter8Selector(pin.selector, doc);
      const rect = element?.getBoundingClientRect();
      if (!element || !rect || (rect.width === 0 && rect.height === 0)) {
        node.style.display = "none";
        continue;
      }
      const left = Math.min(Math.max(0, rect.right - PIN_SIZE / 2), win.innerWidth - PIN_SIZE);
      const top = Math.max(0, rect.top - PIN_SIZE / 2);
      node.style.display = "flex";
      node.style.transform = `translate(${left}px, ${top}px)`;
      if (state.pendingFocus === pin.label) {
        state.pendingFocus = null;
        const reducedMotion = win.matchMedia("(prefers-reduced-motion: reduce)").matches;
        element.scrollIntoView({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
      }
    }
  };

  const unmount = (): void => {
    if (!mounted) return;
    const state = mounted;
    mounted = null;
    state.observer.disconnect();
    if (state.frame !== null) win.cancelAnimationFrame(state.frame);
    win.removeEventListener("scroll", state.schedule, true);
    win.removeEventListener("resize", state.schedule);
    state.host.remove();
    state.hideOverlay.remove();
  };

  const mount = (): Mounted => {
    const hideOverlay = doc.createElement("style");
    hideOverlay.setAttribute(PINS_ATTRIBUTE, "");
    hideOverlay.textContent = "iter8-overlay { display: none !important; }";
    (doc.head ?? doc.documentElement).appendChild(hideOverlay);

    const host = doc.createElement("div");
    host.setAttribute(PINS_ATTRIBUTE, "");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = `position:fixed;inset:0;z-index:${Z_INDEX_PINS};pointer-events:none`;
    paintTheme(host);
    const shadowRoot = host.attachShadow({ mode: "closed" });
    const style = doc.createElement("style");
    style.textContent = PIN_STYLES;
    const layer = doc.createElement("div");
    shadowRoot.append(style, layer);
    doc.documentElement.appendChild(host);

    const state: Mounted = {
      host,
      hideOverlay,
      layer,
      drawn: [],
      frame: null,
      pendingFocus: null,
      schedule: () => {
        if (state.frame !== null) return;
        state.frame = win.requestAnimationFrame(() => {
          state.frame = null;
          if (mounted === state) position(state);
        });
      },
      // Pages that render after load (hydration, client routing) add pin targets late.
      observer: new MutationObserver(() => state.schedule()),
    };
    win.addEventListener("scroll", state.schedule, { capture: true, passive: true });
    win.addEventListener("resize", state.schedule, { passive: true });
    state.observer.observe(doc.documentElement, { childList: true, subtree: true });
    return state;
  };

  const update = (input: ReviewPinsInput | null): void => {
    if (input === null) {
      unmount();
      lastFocus = null;
      return;
    }
    const state = mounted ?? mount();
    mounted = state;
    state.layer.replaceChildren();
    state.drawn = input.pins.map((pin) => {
      const node = doc.createElement("div");
      node.className = "pin";
      if (pin.resolved) {
        node.setAttribute("data-resolved", "");
        node.innerHTML = CHECK_GLYPH;
      }
      node.append(pin.label);
      if (pin.label === input.focusLabel) node.setAttribute("data-focused", "");
      state.layer.appendChild(node);
      return { pin, node };
    });
    // Re-sending the same focus must not pull the page back to it after the user scrolled away.
    if (input.focusLabel !== lastFocus) state.pendingFocus = input.focusLabel;
    lastFocus = input.focusLabel;
    position(state);
  };

  return {
    update,
    applyTheme: (next) => {
      theme = next;
      if (mounted) paintTheme(mounted.host);
    },
  };
}
