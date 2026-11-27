import type { ProjectScript } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  acceptProjectActionCandidates,
  isDangerousCommand,
  rejectProjectActionCandidate,
  type ProjectActionCandidate,
} from "./ProjectActionSuggestionPolicy.ts";

const candidate = { name: "Run Tests", command: "pnpm test", icon: "test" };

function action(id: string, name: string, command: string): ProjectScript {
  return { id, name, command, icon: "test", runOnWorktreeCreate: false };
}

describe("dangerous project action commands", () => {
  it.each([
    ["sudo", "sudo make test"],
    ["doas and case folding", "make test && DOAS make build"],
    ["recursive rm short flag", "rm -r ./build"],
    ["recursive rm uppercase flag", "rm -R ./build"],
    ["recursive rm long flag after an operand", "rm ./build --recursive"],
    ["recursive rm combined flags", "rm -rf ./build"],
    ["recursive rm reversed flags", "rm -fr ./build"],
    ["recursive rm quoted flags and absolute executable", "/bin/rm '-rf' ./build"],
    ["pipe into sh", "make test | sh"],
    ["pipe into bash without spaces", "make test|bash"],
    ["pipe into zsh", "make test | zsh"],
    ["pipe into fish", "make test | fish"],
    ["pipe into sudo", "make test | sudo tee ./log"],
    ["pipe into a shell by path", "make test | /bin/bash"],
    ["pipe stderr too into a shell", "pnpm test |& bash"],
    ["curl after a safe command", "make test; curl https://example.invalid"],
    ["wget", "wget https://example.invalid"],
    ["eval", "eval 'make test'"],
    ["backticks", "echo `make test`"],
    ["dollar command substitution", "echo $(make test)"],
    ["git push", "git push"],
    ["git push with global options", "git -C . push"],
    ["git reset --hard", "git reset --hard HEAD"],
    ["git reset with --hard after the ref", "git reset HEAD --hard"],
    ["git clean", "git clean"],
    ["git checkout --", "git checkout -- ./build"],
    ["npm publish", "npm publish"],
    ["pnpm publish", "pnpm publish"],
    ["yarn publish", "yarn publish"],
    ["bun publish", "bun publish"],
    ["cargo publish", "cargo publish"],
    ["twine upload", "twine upload ./dist/*"],
    ["gem push", "gem push ./acme.gem"],
    ["publish script", "pnpm run publish"],
    ["deploy script", "npm run deploy"],
    ["release script", "just release"],
    ["publish script with a suffix", "pnpm run publish:npm"],
    ["deploy script with a hyphenated target", "pnpm deploy-prod"],
    ["release script with a hyphenated target", "just release-patch"],
    ["npx remote package", "npx -y evil-pkg"],
    ["pnpx remote package", "pnpx evil-pkg"],
    ["pnpm dlx", "pnpm dlx evil-pkg"],
    ["yarn dlx", "yarn dlx evil-pkg"],
    ["bunx", "bunx evil-pkg"],
    ["bash -c", 'bash -c "make test"'],
    ["sh -c", "sh -c 'make test'"],
    ["shell by path with combined flags", "/bin/bash -lc 'make test'"],
    ["node -e", "node -e \"require('child_process')\""],
    ["node --eval", 'node --eval "1"'],
    ["python -c", 'python -c "import os"'],
    ["python3 -c", 'python3 -c "import os"'],
    ["find -delete", "find . -delete"],
    ["find -delete after other tests", "find ./build -name '*.o' -delete"],
    ["append redirect into the home directory", "make test >> ~/.bashrc"],
    ["redirect into $HOME", "make test > $HOME/.ssh/authorized_keys"],
    ["redirect into ${HOME}", "make test > ${HOME}/.profile"],
    ["quoted redirect into $HOME", 'make test > "$HOME/.profile"'],
    ["mkfs", "mkfs ./image"],
    ["mkfs with filesystem suffix", "mkfs.ext4 ./image"],
    ["dd if=", "dd if=./image of=./copy"],
    ["shutdown", "shutdown"],
    ["reboot", "reboot"],
    ["kill", "kill 42"],
    ["pkill", "pkill acme"],
    ["killall", "killall acme"],
    ["chmod -R", "chmod -R 755 ./build"],
    ["chown -R", "chown -R user ./build"],
    ["absolute output redirect", "make test > /tmp/acme.log"],
    ["absolute append redirect", "make test >>/tmp/acme.log"],
    ["quoted absolute redirect", 'make test 2>"/tmp/acme.log"'],
    ["fork bomb signature", ":(){"],
  ])("rejects %s", (_shape, command) => {
    for (const variant of [command, command.toUpperCase()]) {
      expect(isDangerousCommand(variant)).toBe(true);
      expect(rejectProjectActionCandidate({ ...candidate, command: variant }, [])).toBe(
        "dangerous-command",
      );
    }
  });

  it.each([
    "pnpm dev",
    "pnpm test",
    "pnpm run dev",
    "cargo build --release",
    "just verify",
    "npm run build:prod",
    "pnpm run test:ci",
    "pnpm exec vitest",
    "node ./scripts/check.js",
    "node --test",
    "python -m pytest",
    "sh ./scripts/test.sh",
    "find . -name '*.log'",
    "make test 2>&1 | tee ./log",
    "pnpm run test -- --watch=false",
    "make test",
    "just lint",
    "cargo build",
    "uv run pytest",
    "vp run typecheck",
    "npm run lint && npm test",
    "cargo build --release-profile",
    "git reset --soft HEAD",
    "git checkout acme",
    "make test | tee ./log",
    "make test > ./log",
    "rm -f ./log",
    "rm ./log && make test -r",
    "chmod 755 ./build",
    "pnpm run test-never-kill",
  ])("accepts the allowed command %s", (command) => {
    expect(isDangerousCommand(command)).toBe(false);
    expect(rejectProjectActionCandidate({ ...candidate, command }, [])).toBeNull();
  });
});

describe("project action candidates", () => {
  it.each([
    ["empty name", { name: "" }, "empty"],
    ["blank name", { name: "   " }, "empty"],
    ["empty command", { command: "" }, "empty"],
    ["blank command", { command: "   " }, "empty"],
    ["41-character name", { name: "x".repeat(41) }, "too-long"],
    ["201-character command", { command: "x".repeat(201) }, "too-long"],
    ["overlong name with leading whitespace", { name: " " + "x".repeat(40) }, "too-long"],
    ["overlong command with trailing whitespace", { command: "x".repeat(200) + " " }, "too-long"],
    ["line break in name", { name: "Run\nTests" }, "multi-line"],
    ["line break in command", { command: "pnpm test\r\npnpm lint" }, "multi-line"],
    ["trailing line break", { command: "pnpm test\n" }, "multi-line"],
    ["control character in name", { name: "Run\u0000Tests" }, "multi-line"],
    ["tab in command", { command: "pnpm\ttest" }, "multi-line"],
    ["Unicode line break", { name: "Run\u2028Tests" }, "multi-line"],
    ["C1 control character", { command: "pnpm test\u0085" }, "multi-line"],
    ["bidi override in command", { command: "pnpm te\u202Est" }, "multi-line"],
    ["bidi isolate in command", { command: "pnpm te\u2066st" }, "multi-line"],
    ["zero-width space in command", { command: "pnpm te\u200Bst" }, "multi-line"],
    ["bidi override in name", { name: "Run\u202ETests" }, "multi-line"],
    ["zero-width space in name", { name: "Run\u200BTests" }, "multi-line"],
    ["empty before too long", { name: "", command: "x".repeat(201) }, "empty"],
    ["too long before multiline", { name: `a\n${"x".repeat(40)}` }, "too-long"],
    ["multiline before unknown icon", { name: "Run\nTests", icon: "rocket" }, "multi-line"],
    [
      "unknown icon before dangerous",
      { command: "sudo make test", icon: "rocket" },
      "unknown-icon",
    ],
  ] satisfies Array<[string, Partial<ProjectActionCandidate>, string]>)(
    "classifies %s",
    (_case, overrides, reason) => {
      expect(rejectProjectActionCandidate({ ...candidate, ...overrides }, [])).toBe(reason);
    },
  );

  it.each([
    ["one character per field", { name: "A", command: "a" }],
    ["the maximum name length", { name: "x".repeat(40) }],
    ["the maximum command length", { command: "x".repeat(200) }],
  ] satisfies Array<[string, Partial<ProjectActionCandidate>]>)(
    "accepts %s",
    (_case, overrides) => {
      expect(rejectProjectActionCandidate({ ...candidate, ...overrides }, [])).toBeNull();
    },
  );

  it.each(["play", "test", "lint", "configure", "build", "debug"])(
    "accepts the %s icon",
    (icon) => {
      expect(rejectProjectActionCandidate({ ...candidate, icon }, [])).toBeNull();
    },
  );

  it.each(["rocket", "Test", "", " test "])("rejects the unknown icon %j", (icon) => {
    expect(rejectProjectActionCandidate({ ...candidate, icon }, [])).toBe("unknown-icon");
  });

  it("keeps siblings on both sides of an unknown icon", () => {
    const suggestions = acceptProjectActionCandidates(
      [
        candidate,
        { name: "Build", command: "pnpm build", icon: "rocket" },
        { name: "Lint", command: "pnpm lint", icon: "lint" },
      ],
      [],
    );
    expect(suggestions.map(({ id, icon }) => ({ id, icon }))).toEqual([
      { id: "run-tests", icon: "test" },
      { id: "lint", icon: "lint" },
    ]);
  });

  it.each([
    ["trimmed command", action("test", "Other Name", " pnpm test "), { command: "pnpm test " }],
    ["case-insensitive name", action("test", "RUN TESTS", "make test"), { command: "pnpm test" }],
    ["trimmed name", action("test", "Run Tests", "make test"), { name: " Run Tests " }],
  ] satisfies Array<[string, ProjectScript, Partial<ProjectActionCandidate>]>)(
    "rejects a duplicate by %s against existing actions",
    (_case, existing, overrides) => {
      expect(rejectProjectActionCandidate({ ...candidate, ...overrides }, [existing])).toBe(
        "duplicate",
      );
      expect(
        acceptProjectActionCandidates(
          [
            { ...candidate, ...overrides },
            { name: "Build", command: "pnpm build", icon: "build" },
          ],
          [existing],
        ).map(({ id }) => id),
      ).toEqual(["build"]);
    },
  );

  it("checks danger before duplication", () => {
    const command = "sudo make test";
    expect(
      rejectProjectActionCandidate({ ...candidate, command }, [
        action("test", "Run Tests", command),
      ]),
    ).toBe("dangerous-command");
  });

  it("keeps a case-distinct command with a different name", () => {
    expect(
      rejectProjectActionCandidate(candidate, [action("other", "Run Test", "PNPM TEST")]),
    ).toBeNull();
  });

  it.each([
    ["name", { name: "run tests", command: "make test", icon: "test" }],
    ["command", { name: "Check", command: " pnpm test ", icon: "test" }],
  ] satisfies Array<[string, ProjectActionCandidate]>)(
    "keeps the first suggestion when the batch duplicates by %s",
    (_case, duplicate) => {
      expect(acceptProjectActionCandidates([candidate, duplicate], []).map(({ id }) => id)).toEqual(
        ["run-tests"],
      );
    },
  );

  it("does not reserve the name or command of a rejected suggestion", () => {
    expect(
      acceptProjectActionCandidates([{ ...candidate, icon: "rocket" }, candidate], []).map(
        ({ id }) => id,
      ),
    ).toEqual(["run-tests"]);
  });

  it("returns no suggestions for an empty batch", () => {
    expect(acceptProjectActionCandidates([], [])).toEqual([]);
  });

  it("returns the first three accepted suggestions, with every auto-run role off", () => {
    expect(
      acceptProjectActionCandidates(
        [
          { ...candidate, name: " Run Tests ", command: " pnpm test " },
          { name: "Skipped", command: "make skip", icon: "rocket" },
          { name: "Lint", command: "pnpm lint", icon: "lint" },
          { name: "Build", command: "pnpm build", icon: "build" },
          { name: "Dev", command: "pnpm dev", icon: "play" },
        ],
        [],
      ),
    ).toStrictEqual([
      {
        id: "run-tests",
        name: "Run Tests",
        command: "pnpm test",
        icon: "test",
        runOnWorktreeCreate: false,
        runOnSettle: false,
        stopOnSettle: false,
      },
      {
        id: "lint",
        name: "Lint",
        command: "pnpm lint",
        icon: "lint",
        runOnWorktreeCreate: false,
        runOnSettle: false,
        stopOnSettle: false,
      },
      {
        id: "build",
        name: "Build",
        command: "pnpm build",
        icon: "build",
        runOnWorktreeCreate: false,
        runOnSettle: false,
        stopOnSettle: false,
      },
    ]);
  });

  it("normalizes IDs and skips IDs held by existing and earlier accepted actions", () => {
    expect(
      acceptProjectActionCandidates(
        [
          { ...candidate, name: "(Run + Tests!)" },
          { name: "Run#Tests", command: "make test", icon: "test" },
          { name: "検証", command: "just test", icon: "test" },
        ],
        [
          action("run-tests", "Existing", "cargo test"),
          action("run-tests-2", "Other", "uv run pytest"),
        ],
      ).map(({ id }) => id),
    ).toEqual(["run-tests-3", "run-tests-4", "script"]);
  });

  it.each([
    ["unoccupied slug", [], "abcdefghijklmnopqrstuvwx"],
    ["collision at maximum length", ["abcdefghijklmnopqrstuvwx"], "abcdefghijklmnopqrstuv-2"],
    [
      "two-digit collision suffix",
      [
        "abcdefghijklmnopqrstuvwx",
        ...Array.from({ length: 8 }, (_, i) => `abcdefghijklmnopqrstuv-${i + 2}`),
      ],
      "abcdefghijklmnopqrstu-10",
    ],
  ] satisfies Array<[string, string[], string]>)(
    "keeps an ID within 24 characters with an %s",
    (_case, ids, expected) => {
      expect(
        acceptProjectActionCandidates(
          [{ ...candidate, name: "ABCDEFGHIJKLMNOPQRSTUVWXYZ" }],
          ids.map((id) => action(id, id, "make other")),
        ).map(({ id }) => id),
      ).toEqual([expected]);
    },
  );

  it("continues numeric suffixes when 9,999 IDs are already taken", () => {
    const existing = [
      action("run-tests", "Existing", "make other"),
      ...Array.from({ length: 9998 }, (_, i) =>
        action(`run-tests-${i + 2}`, "Existing", "make other"),
      ),
    ];
    expect(acceptProjectActionCandidates([candidate], existing).map(({ id }) => id)).toEqual([
      "run-tests-10000",
    ]);
  });

  it("removes a separator exposed by truncation", () => {
    expect(
      acceptProjectActionCandidates(
        [{ ...candidate, name: "ABCDEFGHIJKLMNOPQRSTUVW XYZ" }],
        [],
      ).map(({ id }) => id),
    ).toEqual(["abcdefghijklmnopqrstuvw"]);
  });
});
