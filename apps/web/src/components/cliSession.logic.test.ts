import {
  ProviderDriverKind,
  ProviderInstanceId,
  type PluginLiveCliSession,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { cliSessionTakeOver, isClaudeThread } from "./cliSession.logic";

const instance = (id: string) => ProviderInstanceId.make(id);
const providers = [
  { instanceId: instance("claude-work"), driver: ProviderDriverKind.make("claudeAgent") },
  { instanceId: instance("codex"), driver: ProviderDriverKind.make("codex") },
];

describe("isClaudeThread", () => {
  it("follows the running provider first, then the thread's model selection", () => {
    const thread = (runtimeInstance: string | null, selected: string) => ({
      runtime: runtimeInstance === null ? null : { providerInstanceId: instance(runtimeInstance) },
      modelSelection: { instanceId: instance(selected) },
    });
    expect(isClaudeThread(thread(null, "claude-work"), providers)).toBe(true);
    expect(isClaudeThread(thread("claude-work", "codex"), providers)).toBe(true);
    expect(isClaudeThread(thread("codex", "claude-work"), providers)).toBe(false);
    expect(isClaudeThread(thread(null, "codex"), providers)).toBe(false);
    expect(isClaudeThread(thread(null, "removed"), providers)).toBe(false);
  });
});

describe("cliSessionTakeOver", () => {
  const session = (overrides: Partial<PluginLiveCliSession>) =>
    ({
      owner: "terminal",
      status: "idle",
      inTmux: true,
      ...overrides,
    }) as const;

  it.each([
    [session({}), "available"],
    [session({ status: "busy" }), "unavailable"],
    [session({ status: "shell" }), "unavailable"],
    [session({ status: "unknown" }), "unavailable"],
    [session({ inTmux: false }), "unavailable"],
    [session({ owner: "other" }), "hidden"],
  ] as const)("%o is %s", (input, expected) => {
    expect(cliSessionTakeOver(input)).toBe(expected);
  });
});
