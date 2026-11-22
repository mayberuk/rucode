import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
} from "@t3tools/shared/keybindings";

import { toastManager } from "../components/ui/toast";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  type CommandHandlers,
  type CommandScopeOptions,
  dispatchMenuAction,
  registerCommands,
  registerMenuAction,
} from "./dispatcher";

function bindings(entries: ReadonlyArray<[string, KeybindingCommand]>): ResolvedKeybindingsConfig {
  return entries.map(([key, command]) => ({
    command,
    shortcut: {
      key,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: false,
    },
  }));
}

const keybindings = () =>
  bindings([
    ["k", "chat.new"],
    ["j", "chat.newLocal"],
  ]);

function press(key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true });
  window.dispatchEvent(event);
  return event;
}

function prefixSurface(
  options: {
    terminal?: boolean;
    recorder?: boolean;
    confirmation?: boolean;
    keybindings?: ResolvedKeybindingsConfig;
  } = {},
) {
  const stack = new DisposableStack();
  stack.use(
    vi
      .spyOn(appAtomRegistry, "get")
      .mockReturnValue(options.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS),
  );
  const container = document.createElement("div");
  if (options.terminal !== false) container.dataset.terminalOwner = "drawer";
  if (options.confirmation) container.setAttribute("role", "alertdialog");
  if (options.recorder) container.dataset.keybindingCapture = "";
  const input = document.createElement(options.recorder ? "input" : "textarea");
  container.append(input);
  document.body.append(container);
  stack.defer(() => container.remove());
  stack.defer(registerCommands({}));
  stack.defer(() => window.dispatchEvent(new Event("blur")));
  const windowSeen: Event[] = [];
  const onWindowKeyDown = (event: Event) => windowSeen.push(event);
  window.addEventListener("keydown", onWindowKeyDown, true);
  stack.defer(() => window.removeEventListener("keydown", onWindowKeyDown, true));
  input.focus();
  const received: Event[] = [];
  input.addEventListener("keydown", (event) => {
    received.push(event);
    event.stopPropagation();
  });
  const send = (key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    input.dispatchEvent(event);
    return event;
  };
  return {
    received,
    windowSeen,
    input,
    send,
    prefix: (init: KeyboardEventInit = {}) => send(" ", { code: "Space", ctrlKey: true, ...init }),
    register: (commands: CommandHandlers, options?: CommandScopeOptions) =>
      stack.defer(registerCommands(commands, options)),
    [Symbol.dispose]: () => stack.dispose(),
  };
}

describe("prefix dispatcher", () => {
  it.each(["terminal", "composer"])("captures the prefix and action ahead of the %s", (surface) => {
    using fixture = prefixSurface({ terminal: surface === "terminal" });
    const nextWaiting = vi.fn();
    fixture.register({ "thread.nextWaiting": nextWaiting });

    const prefix = fixture.prefix();
    expect(prefix.defaultPrevented).toBe(true);
    expect(fixture.received).toEqual([]);
    const action = fixture.send("a");
    expect(action.defaultPrevented).toBe(true);
    expect(nextWaiting).toHaveBeenCalledExactlyOnceWith(action);
    expect(fixture.received).toEqual([]);
    const following = fixture.send("a");
    expect(fixture.received).toEqual([following]);
    expect(fixture.windowSeen).toEqual([following]);
    expect(nextWaiting).toHaveBeenCalledOnce();
  });

  it("runs New chat after prefix c", () => {
    using fixture = prefixSurface();
    const newChat = vi.fn();
    fixture.register({ "chat.new": newChat });
    fixture.prefix();
    const action = fixture.send("c");
    expect(newChat).toHaveBeenCalledExactlyOnceWith(action);
    expect(fixture.received).toEqual([]);
  });

  it("delivers only the second prefix untouched and disarms", () => {
    using fixture = prefixSurface();
    const nextWaiting = vi.fn();
    fixture.register({ "thread.nextWaiting": nextWaiting });
    fixture.prefix();
    const second = fixture.prefix();
    expect(second.defaultPrevented).toBe(false);
    expect(second.key).toBe(" ");
    expect(second.code).toBe("Space");
    expect(second.ctrlKey).toBe(true);
    expect(fixture.received).toEqual([second]);
    const following = fixture.send("a");
    expect(fixture.received).toEqual([second, following]);
    expect(nextWaiting).not.toHaveBeenCalled();
  });

  it("ignores an unarmed repeat but claims repeats of an armed prefix", () => {
    using fixture = prefixSurface();
    const nextWaiting = vi.fn();
    fixture.register({ "thread.nextWaiting": nextWaiting });
    const unarmedRepeat = fixture.prefix({ repeat: true });
    const bare = fixture.send("a");
    expect(unarmedRepeat.defaultPrevented).toBe(false);
    expect(fixture.received).toEqual([unarmedRepeat, bare]);
    expect(nextWaiting).not.toHaveBeenCalled();

    fixture.prefix();
    const armedRepeat = fixture.prefix({ repeat: true });
    expect(armedRepeat.defaultPrevented).toBe(true);
    const action = fixture.send("a");
    expect(nextWaiting).toHaveBeenCalledExactlyOnceWith(action);
    expect(fixture.received).toEqual([unarmedRepeat, bare]);
  });

  it.each(["Escape", "x", ""])(
    "swallows %j after the prefix and delivers the following key",
    (key) => {
      using fixture = prefixSurface();
      const nextWaiting = vi.fn();
      fixture.register({ "thread.nextWaiting": nextWaiting });
      fixture.prefix();
      expect(fixture.send(key).defaultPrevented).toBe(true);
      expect(fixture.received).toEqual([]);
      const following = fixture.send("a");
      expect(following.defaultPrevented).toBe(false);
      expect(fixture.received).toEqual([following]);
      expect(fixture.windowSeen).toEqual([following]);
      expect(nextWaiting).not.toHaveBeenCalled();
    },
  );

  it.each(["Control", "Shift", "Alt", "Meta"])("stays armed across a bare %s", (key) => {
    using fixture = prefixSurface();
    const nextWaiting = vi.fn();
    fixture.register({ "thread.nextWaiting": nextWaiting });
    const unarmedModifier = fixture.send(key);
    const bare = fixture.send("a");
    expect(nextWaiting).not.toHaveBeenCalled();
    fixture.prefix();
    const armedModifier = fixture.send(key);
    expect(armedModifier.defaultPrevented).toBe(false);
    const action = fixture.send("a");
    expect(nextWaiting).toHaveBeenCalledExactlyOnceWith(action);
    expect(fixture.received).toEqual([unarmedModifier, bare, armedModifier]);
  });

  it("disarms on window blur", () => {
    using fixture = prefixSurface();
    const nextWaiting = vi.fn();
    fixture.register({ "thread.nextWaiting": nextWaiting });
    window.dispatchEvent(new Event("blur"));
    const first = fixture.send("a");
    fixture.prefix();
    window.dispatchEvent(new Event("blur"));
    const following = fixture.send("a");
    expect(fixture.received).toEqual([first, following]);
    expect(following.defaultPrevented).toBe(false);
    expect(nextWaiting).not.toHaveBeenCalled();
  });

  it.each(["a", "c"])("delivers bare %s without running a prefix action", (key) => {
    using fixture = prefixSurface();
    const nextWaiting = vi.fn();
    const newChat = vi.fn();
    fixture.register({ "thread.nextWaiting": nextWaiting, "chat.new": newChat });
    const event = fixture.send(key);
    expect(event.defaultPrevented).toBe(false);
    expect(fixture.received).toEqual([event]);
    expect(nextWaiting).not.toHaveBeenCalled();
    expect(newChat).not.toHaveBeenCalled();
  });

  it.each([false, true])("leaves recorder input alone with armed=%s", (armed) => {
    using fixture = prefixSurface({ recorder: true });
    const nextWaiting = vi.fn();
    fixture.register({ "thread.nextWaiting": nextWaiting });
    if (armed) {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", ctrlKey: true, cancelable: true }),
      );
    }
    const prefix = fixture.prefix();
    expect(prefix.defaultPrevented).toBe(false);
    const following = fixture.send("a");
    expect(fixture.received).toEqual([prefix, following]);
    expect(nextWaiting).not.toHaveBeenCalled();
  });

  it.each([false, true])("leaves composing keys alone and disarms with armed=%s", (armed) => {
    using fixture = prefixSurface();
    const nextWaiting = vi.fn();
    fixture.register({ "thread.nextWaiting": nextWaiting });
    if (armed) fixture.prefix();
    const composing = fixture.prefix({ isComposing: true });
    const following = fixture.send("a");
    expect(composing.defaultPrevented).toBe(false);
    expect(fixture.received).toEqual([composing, following]);
    expect(nextWaiting).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "toasts and disarms when no handler is eligible, guarded=%s",
    (guarded) => {
      using fixture = prefixSurface();
      using toast = vi.spyOn(toastManager, "add").mockReturnValue("prefix-toast");
      const nextWaiting = vi.fn();
      if (guarded) fixture.register({ "thread.nextWaiting": nextWaiting }, { when: () => false });
      fixture.prefix();
      expect(fixture.send("a").defaultPrevented).toBe(true);
      expect(toast).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ type: "info", title: "That shortcut can't follow the prefix" }),
      );
      const following = fixture.send("a");
      expect(fixture.received).toEqual([following]);
      expect(fixture.windowSeen).toEqual([following]);
      expect(nextWaiting).not.toHaveBeenCalled();
      expect(toast).toHaveBeenCalledOnce();
    },
  );

  it("runs the newest eligible capture handler before global scopes", () => {
    using fixture = prefixSurface();
    const older = vi.fn();
    const newest = vi.fn();
    const guarded = vi.fn();
    const global = vi.fn();
    fixture.register({ "thread.nextWaiting": older }, { capture: true });
    fixture.register({ "thread.nextWaiting": newest }, { capture: true });
    fixture.register({ "thread.nextWaiting": guarded }, { capture: true, when: () => false });
    fixture.register({ "thread.nextWaiting": global });
    fixture.prefix();
    const action = fixture.send("a");
    expect(newest).toHaveBeenCalledExactlyOnceWith(action);
    expect(older).not.toHaveBeenCalled();
    expect(guarded).not.toHaveBeenCalled();
    expect(global).not.toHaveBeenCalled();
  });

  it("runs the newest eligible global handler when capture scopes have none", () => {
    using fixture = prefixSurface();
    const older = vi.fn();
    const newest = vi.fn();
    const guarded = vi.fn();
    fixture.register({ "thread.nextWaiting": older });
    fixture.register({ "thread.nextWaiting": newest });
    fixture.register({ "thread.nextWaiting": guarded }, { when: () => false });
    fixture.register({ "chat.new": vi.fn() }, { capture: true });
    fixture.prefix();
    const action = fixture.send("a");
    expect(newest).toHaveBeenCalledExactlyOnceWith(action);
    expect(older).not.toHaveBeenCalled();
    expect(guarded).not.toHaveBeenCalled();
  });

  it("resolves each scope's own context and keybindings and passes a declined key on", () => {
    using fixture = prefixSurface({
      keybindings: [
        ...DEFAULT_RESOLVED_KEYBINDINGS,
        ...compileResolvedKeybindingsConfig([
          { key: "p", command: "preview.toggle", when: "prefixActive && previewOpen" },
        ]),
      ],
    });
    using toast = vi.spyOn(toastManager, "add").mockReturnValue("prefix-toast");
    const older = vi.fn();
    const declined = vi.fn(() => false);
    const closedPreview = vi.fn();
    fixture.register({ "preview.toggle": older }, { context: () => ({ previewOpen: true }) });
    fixture.register({ "preview.toggle": declined }, { context: () => ({ previewOpen: true }) });
    fixture.register({ "preview.toggle": closedPreview });
    fixture.prefix();
    const action = fixture.send("p");
    expect(declined).toHaveBeenCalledExactlyOnceWith(action);
    expect(older).toHaveBeenCalledExactlyOnceWith(action);
    expect(closedPreview).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("toasts when every eligible handler declines the prefix action", () => {
    using fixture = prefixSurface();
    using toast = vi.spyOn(toastManager, "add").mockReturnValue("prefix-toast");
    const declined = vi.fn(() => false);
    fixture.register({ "thread.nextWaiting": declined });
    fixture.prefix();
    fixture.send("a");
    expect(declined).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenCalledOnce();
  });

  it("runs prefix actions inside confirmations", () => {
    using fixture = prefixSurface({ confirmation: true });
    const nextWaiting = vi.fn();
    fixture.register({ "thread.nextWaiting": nextWaiting });
    fixture.prefix();
    const action = fixture.send("a");
    expect(nextWaiting).toHaveBeenCalledExactlyOnceWith(action);
    expect(fixture.received).toEqual([]);
  });

  it("reads a rebound prefix and action from primary keybindings", () => {
    using fixture = prefixSurface({
      keybindings: compileResolvedKeybindingsConfig([
        { key: "ctrl+p", command: "prefix.start" },
        { key: "w", command: "thread.nextWaiting", when: "prefixActive" },
      ]),
    });
    const nextWaiting = vi.fn();
    fixture.register({ "thread.nextWaiting": nextWaiting });
    const oldPrefix = fixture.prefix();
    const bare = fixture.send("w");
    expect(nextWaiting).not.toHaveBeenCalled();
    expect(fixture.send("p", { ctrlKey: true }).defaultPrevented).toBe(true);
    const action = fixture.send("w");
    expect(nextWaiting).toHaveBeenCalledExactlyOnceWith(action);
    expect(fixture.received).toEqual([oldPrefix, bare]);
  });
});

describe("command dispatcher", () => {
  it("runs the newest scope's handler and nothing below it", () => {
    const global = vi.fn();
    const outer = vi.fn();
    const inner = vi.fn();
    using stack = new DisposableStack();
    stack.defer(registerCommands({ "chat.new": global }, { keybindings }));
    stack.defer(registerCommands({ "chat.new": outer }, { keybindings }));
    stack.defer(registerCommands({ "chat.new": inner }, { keybindings }));

    press("k");

    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
    expect(global).not.toHaveBeenCalled();
  });

  it("falls through scopes that return false, skip the command, or fail their guard", () => {
    const global = vi.fn();
    const declined = vi.fn(() => false);
    const guarded = vi.fn();
    using stack = new DisposableStack();
    stack.defer(registerCommands({ "chat.new": global }, { keybindings }));
    stack.defer(registerCommands({ "chat.new": declined }, { keybindings }));
    stack.defer(registerCommands({ "chat.newLocal": vi.fn() }, { keybindings }));
    stack.defer(registerCommands({ "chat.new": guarded }, { keybindings, when: () => false }));

    press("k");

    expect(guarded).not.toHaveBeenCalled();
    expect(declined).toHaveBeenCalledOnce();
    expect(global).toHaveBeenCalledOnce();
  });

  it("stops once a handler prevents default, and unregisters on cleanup", () => {
    const lower = vi.fn();
    const upper = vi.fn((event: KeyboardEvent) => {
      event.preventDefault();
      return false;
    });
    using stack = new DisposableStack();
    stack.defer(registerCommands({ "chat.new": lower }, { keybindings }));
    const unregisterUpper = registerCommands({ "chat.new": upper }, { keybindings });

    press("k");
    expect(lower).not.toHaveBeenCalled();

    unregisterUpper();
    press("k");
    expect(upper).toHaveBeenCalledOnce();
    expect(lower).toHaveBeenCalledOnce();
  });

  it("lets a scope claim raw keys before command lookup", () => {
    const onEscape = vi.fn((event: KeyboardEvent) => (event.key === "Escape" ? undefined : false));
    const command = vi.fn();
    using stack = new DisposableStack();
    stack.defer(registerCommands({ "chat.new": command }, { keybindings, onKeyDown: onEscape }));

    press("Escape");
    press("k");

    expect(onEscape).toHaveBeenCalledTimes(2);
    expect(command).toHaveBeenCalledOnce();
  });

  it("tells observers whether a scope consumed the key, after the scopes ran", () => {
    const calls: Array<string> = [];
    using stack = new DisposableStack();
    stack.defer(
      registerCommands({}, { observe: (_event, consumed) => calls.push(`observe:${consumed}`) }),
    );
    stack.defer(
      registerCommands({ "chat.new": () => void calls.push("command") }, { keybindings }),
    );

    press("k");
    press("x");

    expect(calls).toEqual(["command", "observe:true", "observe:false"]);
  });

  it("consumes a command chord pressed inside a confirmation without running its handler", () => {
    const command = vi.fn();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "alertdialog");
    const cancel = document.createElement("button");
    dialog.append(cancel);
    document.body.append(dialog);
    using stack = new DisposableStack();
    stack.defer(() => dialog.remove());
    stack.defer(registerCommands({ "chat.new": command }, { keybindings }));
    cancel.focus();

    const event = new KeyboardEvent("keydown", { key: "k", cancelable: true, bubbles: true });
    cancel.dispatchEvent(event);

    expect(command).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("routes a menu action to its newest handler", () => {
    const older = vi.fn();
    const newer = vi.fn();
    using stack = new DisposableStack();
    stack.defer(registerMenuAction("test-action", older));
    const unregisterNewer = registerMenuAction("test-action", newer);

    dispatchMenuAction("test-action");
    unregisterNewer();
    dispatchMenuAction("test-action");

    expect(newer).toHaveBeenCalledOnce();
    expect(older).toHaveBeenCalledOnce();
  });
});
