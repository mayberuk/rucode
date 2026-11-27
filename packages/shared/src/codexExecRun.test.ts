import { ThreadId, TurnItemId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  codexRunThreadId,
  parseCodexExecCommand,
  type CodexExecCommand,
} from "@t3tools/shared/codexExecRun";

const inline = (text: string) => ({ kind: "inline", text }) as const;
const file = (path: string) => ({ kind: "file", path }) as const;

describe("parseCodexExecCommand", () => {
  it.each<{ name: string; command: string; expected: Partial<CodexExecCommand> | null }>([
    {
      name: "skips the mock command's four option values before the dash and file redirection",
      command: "codex exec -m m -c k=v -s read-only -o out.md - < prompt.md",
      expected: { prompt: file("prompt.md") },
    },
    ...[
      "-m model",
      "--model model",
      "-c key=value",
      "--config key=value",
      "-s read-only",
      "--sandbox read-only",
      "-o out.md",
      "--output-last-message out.md",
      "-p default",
      "--profile default",
      "-i image.png",
      "--image image.png",
      "--color never",
      "--output-schema schema.json",
    ].map((option) => ({
      name: `skips ${option} before the prompt`,
      command: `codex exec ${option} - < prompt.md`,
      expected: { prompt: file("prompt.md") },
    })),
    {
      name: "preserves a quoted filename and ignores output and descriptor redirections",
      command: `codex exec - <"prompt draft.md" > out.log 2>&1`,
      expected: { prompt: file("prompt draft.md") },
    },
    {
      name: "finds a stdin file without a positional and accepts an explicit descriptor zero",
      command: "codex exec 0<prompt.md",
      expected: { prompt: file("prompt.md") },
    },
    {
      name: "uses the last stdin redirect",
      command: "codex exec - < old.md < prompt.md",
      expected: { prompt: file("prompt.md") },
    },
    {
      name: "ignores redirects on descriptors other than stdin",
      command: "codex exec - 3< prompt.md",
      expected: { prompt: null },
    },
    { name: "keeps stdin unknown for a bare dash", command: "codex exec -", expected: {} },
    { name: "keeps stdin unknown without arguments", command: "codex exec", expected: {} },
    {
      name: "keeps an inline positional when stdin is redirected from a file",
      command: "codex exec reply < prompt.md",
      expected: { prompt: inline("reply") },
    },
    {
      name: "does not consume a redirection target as a missing option value",
      command: "codex exec -m < prompt.md",
      expected: null,
    },
    {
      name: "does not consume another flag as a missing option value",
      command: "codex exec -m --ephemeral",
      expected: null,
    },
    {
      name: "rejects a missing redirection target",
      command: "codex exec - <",
      expected: null,
    },
    {
      name: "sets ephemeral when the flag precedes a prompt",
      command: "codex exec --ephemeral 'reply ok'",
      expected: { ephemeral: true, prompt: inline("reply ok") },
    },
    {
      name: "sets ephemeral once when the flag repeats or follows the prompt",
      command: "codex exec reply --ephemeral --ephemeral",
      expected: { ephemeral: true, prompt: inline("reply") },
    },
    {
      name: "uses a literal flag-shaped prompt after the option terminator",
      command: "codex exec -- --ephemeral",
      expected: { prompt: inline("--ephemeral") },
    },
    {
      name: "keeps ephemeral false when a prompt merely mentions the flag",
      command: `codex exec 'explain --ephemeral'`,
      expected: { prompt: inline("explain --ephemeral") },
    },
    {
      name: "does not read a flag from the following pipeline stage",
      command: "codex exec reply | tee --ephemeral",
      expected: { prompt: inline("reply") },
    },
    {
      name: "reads a quoted directory from a leading cd",
      command: `cd 'repo dir' && codex exec reply`,
      expected: { cd: "repo dir", prompt: inline("reply") },
    },
    {
      name: "reads a directory from -C without a leading cd",
      command: "codex exec -C ./repo reply",
      expected: { cd: "./repo", prompt: inline("reply") },
    },
    {
      name: "takes -C over the leading cd",
      command: "cd repo && codex exec -C ./subdir reply",
      expected: { cd: "./subdir", prompt: inline("reply") },
    },
    {
      name: "reads the separate long directory option",
      command: `codex exec --cd "repo dir" reply`,
      expected: { cd: "repo dir", prompt: inline("reply") },
    },
    {
      name: "reads the attached long directory option and lets a later override win",
      command: `codex exec -C early --cd="repo dir" reply`,
      expected: { cd: "repo dir", prompt: inline("reply") },
    },
    {
      name: "preserves an explicitly empty directory argument",
      command: `codex exec --cd="" reply`,
      expected: { cd: "", prompt: inline("reply") },
    },
    { name: "rejects a missing directory argument", command: "codex exec -C", expected: null },
    {
      name: "rejects a leading cd without its directory",
      command: "cd && codex exec",
      expected: null,
    },
    {
      name: "accepts env assignments and a timeout before the executable",
      command: `FOO="one two" timeout 20 codex exec reply`,
      expected: { prompt: inline("reply") },
    },
    {
      name: "unwraps command, nice, env, and a timeout with a unit",
      command: "command nice -n -5 env FOO=1 timeout 0.5s codex e reply",
      expected: { prompt: inline("reply") },
    },
    {
      name: "accepts a zero timeout",
      command: "timeout 0 codex exec reply",
      expected: { prompt: inline("reply") },
    },
    { name: "rejects a negative timeout", command: "timeout -1 codex exec", expected: null },
    { name: "rejects a missing timeout", command: "timeout codex exec", expected: null },
    { name: "rejects a malformed timeout", command: "timeout x codex exec", expected: null },
    {
      name: "does not mistake a command lookup for an invocation",
      command: "command -v codex exec",
      expected: null,
    },
    {
      name: "does not mistake a quoted shell word for an assignment prefix",
      command: `"FOO=1" codex exec`,
      expected: null,
    },
    {
      name: "preserves an empty first positional instead of falling back to stdin",
      command: `codex exec '' < prompt.md`,
      expected: { prompt: inline("") },
    },
    {
      name: "joins continued lines within and between words",
      command: "co\\\ndex exec \\\n  --ephemeral \\\n  'reply ok'",
      expected: { ephemeral: true, prompt: inline("reply ok") },
    },
    {
      name: "removes a continuation in double quotes and preserves a backslash-newline in single quotes",
      command: `codex exec "re\\\nply"'\\\nok'`,
      expected: { prompt: inline("reply\\\nok") },
    },
    {
      name: "unescapes double quotes and retains a backslash before an ordinary character",
      command: String.raw`codex exec "say \"ok\" \path"`,
      expected: { prompt: inline(String.raw`say "ok" \path`) },
    },
    {
      name: "preserves quoted and escaped shell operators as prompt text",
      command: String.raw`codex exec 'reply | ok'\<more`,
      expected: { prompt: inline("reply | ok<more") },
    },
    {
      name: "stops at the first positional and does not consume the tee stage",
      command: "codex exec reply ignored | tee out.log",
      expected: { prompt: inline("reply") },
    },
    {
      name: "recognizes a piped codex stage with unknown stdin",
      command: "printf reply | codex exec --ephemeral - | tee out.log",
      expected: { ephemeral: true, prompt: null },
    },
    {
      name: "leaves the prompt unknown when the codex stage receives a pipe",
      command: "printf reply | codex exec reply",
      expected: { prompt: null },
    },
    {
      name: "leaves a heredoc prompt unknown and ignores the heredoc body",
      command: "codex e - <<'EOF'\nreply | codex exec wrong\nEOF",
      expected: { prompt: null },
    },
    {
      name: "does not match codex in a different command's heredoc body",
      command: "cat <<EOF\ncodex exec reply\nEOF",
      expected: null,
    },
    {
      name: "leaves an unquoted command substitution unknown without scanning its pipeline",
      command: `codex exec $(printf reply | tee out.log) --ephemeral`,
      expected: { ephemeral: true, prompt: null },
    },
    {
      name: "leaves a double-quoted nested command substitution unknown",
      command: `codex exec "$(printf '%s' "$(printf 'reply)')")"`,
      expected: { prompt: null },
    },
    {
      name: "preserves a substitution written literally inside single quotes",
      command: `codex exec '$(printf reply)'`,
      expected: { prompt: inline("$(printf reply)") },
    },
    {
      name: "does not match codex inside another command's substitution",
      command: "echo $(printf reply | codex exec reply)",
      expected: null,
    },
    ...[
      "echo codex exec",
      "codex login",
      `rg "codex exec"`,
      `git commit -m 'codex exec'`,
      `echo 'reply | codex exec'`,
      `echo \`printf hi | codex exec\``,
      "codex exec |",
      "| codex exec",
      `codex exec 'unfinished`,
      "codex exec \\",
      "codex",
      "   ",
      "",
    ].map((command) => ({
      name: `rejects ${JSON.stringify(command)}`,
      command,
      expected: null,
    })),
  ])("$name", ({ command, expected }) => {
    expect(parseCodexExecCommand(command)).toEqual(
      expected === null ? null : { ephemeral: false, cd: null, prompt: null, ...expected },
    );
  });
});

describe("codexRunThreadId", () => {
  it("derives stable ids from both inputs across repeated and interleaved calls", () => {
    const parent = ThreadId.make("thread:parent");
    const firstItem = TurnItemId.make("item:first");
    const secondItem = TurnItemId.make("item:second");
    const otherParent = ThreadId.make("thread:other");

    expect(codexRunThreadId(parent, firstItem)).toBe("codex-run:thread:parent:item:first");
    expect(codexRunThreadId(parent, secondItem)).toBe("codex-run:thread:parent:item:second");
    expect(codexRunThreadId(otherParent, firstItem)).toBe("codex-run:thread:other:item:first");
    expect(codexRunThreadId(parent, firstItem)).toBe("codex-run:thread:parent:item:first");
  });
});
