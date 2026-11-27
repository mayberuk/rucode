// @effect-diagnostics nodeBuiltinImport:off - Builds fixture trees synchronously and runs the real CLI against a temp git repo.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { rebrandText, runRebrand } from "./rucode-rebrand.ts";

const PIN_PATH = "packages/shared/src/cliRelease.ts";
const UNPINNED_SOURCE = [
  "  release: {",
  '    appId: "com.t3tools.t3code",',
  "  },",
  "  dev: {",
  '    appId: "com.t3tools.t3code.dev",',
  '    productName: "T3 Code Dev",',
  "  },",
  "",
].join("\n");
const PINNED_SOURCE = [
  "  release: {",
  '    appId: "io.github.mayberuk.rucode",',
  "  },",
  "  dev: {",
  '    appId: "io.github.mayberuk.rucode.dev",',
  '    productName: "RuCode Dev",',
  "  },",
  "",
].join("\n");

function writeFiles(root: string, files: Record<string, string | Uint8Array>) {
  for (const [file, content] of Object.entries(files)) {
    const target = NodePath.join(root, file);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, content);
  }
}

const read = (root: string, file: string) => NodeFS.readFileSync(NodePath.join(root, file), "utf8");

/** A temp tree holding `files` plus an already pinned identity file, so pin problems stay empty. */
const makeTree = (files: Record<string, string | Uint8Array>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "rucode-rebrand-" });
    writeFiles(root, { [PIN_PATH]: PINNED_SOURCE, ...files });
    return { root, files: [PIN_PATH, ...Object.keys(files)] };
  });

describe("rebrandText", () => {
  it("renames the product in JSON locale values, TSX strings and Markdown prose and headings", () => {
    assert.strictEqual(
      rebrandText("apps/web/src/i18n/translations/en.json", '{ "welcome": "Welcome to T3 Code" }')
        .text,
      '{ "welcome": "Welcome to RuCode" }',
    );
    assert.strictEqual(
      rebrandText("apps/web/src/App.tsx", 'const title = "Open T3 Code";\n<span>T3 Code</span>')
        .text,
      'const title = "Open RuCode";\n<span>RuCode</span>',
    );
    assert.strictEqual(
      rebrandText(
        "docs/user/start.md",
        "# What is T3 Code?\n\nYour T3 home, the T3 server, a T3 thread and the T3 environment.",
      ).text,
      "# What is RuCode?\n\nYour RuCode home, the RuCode server, a RuCode thread and the RuCode environment.",
    );
  });

  it("rewrites t3-code only inside a Markdown link fragment, and only in .md files", () => {
    const link = "See [setup](t3-code/guide.md#install-t3-code) and [home](#t3-code-home).";
    assert.strictEqual(
      rebrandText("docs/user/start.md", link).text,
      "See [setup](t3-code/guide.md#install-rucode) and [home](#rucode-home).",
    );
    assert.strictEqual(rebrandText("apps/web/src/links.ts", link).text, link);
    const notAFragment = "Run apps/mobile/modules/t3-code-editor and see [x](#t3-codex).";
    assert.strictEqual(rebrandText("docs/user/start.md", notAFragment).text, notAFragment);
  });

  it("reports each rewritten line with its 1-based number and original text", () => {
    const { hits } = rebrandText(
      "docs/a.md",
      "intro\n  Welcome to T3 Code  \nplain\nthe T3 server",
    );
    assert.deepStrictEqual(hits, [
      { path: "docs/a.md", line: 2, text: "Welcome to T3 Code" },
      { path: "docs/a.md", line: 4, text: "the T3 server" },
    ]);
  });

  it("leaves internal identifiers, upstream services and the t3 command byte-identical", () => {
    const identifiers = [
      'import { x } from "@t3tools/x";',
      "process.env.T3CODE_HOME",
      "open t3code://pair",
      "com.t3tools.T3Code",
      "class T3Code {}",
      "https://github.com/pingdotgg/t3code",
      "https://app.t3.codes",
      "run `t3 pair` and edit t3.json",
      "T3 Connect, T3 Chat, T3 Tools and your T3 Account",
      "T3-Code-1.0.0.dmg",
      "T3 servers, T3 Server, T3 homes and the T3 Environment",
    ].join("\n");
    for (const file of ["docs/user/start.md", "apps/web/src/App.tsx", "en.json"]) {
      assert.deepStrictEqual(rebrandText(file, identifiers), { text: identifiers, hits: [] });
    }
  });

  it("keeps legacy profile names and fork statements while renaming the rest of the line", () => {
    assert.strictEqual(
      rebrandText(
        "apps/desktop/resources/installer.nsh",
        "$_ -in 'T3 Code (Alpha)', 'T3 Code (Beta)', 'T3 Code (Nightly)', 'T3 Code (Dev)'",
      ).text,
      "$_ -in 'T3 Code (Alpha)', 'RuCode (Beta)', 'RuCode (Nightly)', 'T3 Code (Dev)'",
    );
    const forkLines = [
      "RuCode is a fork of T3 Code, and T3 Code is MIT.",
      "Upstream T3 Code ships weekly.",
      "Track T3 Code upstream releases.",
    ].join("\n");
    assert.deepStrictEqual(rebrandText("README.md", forkLines), { text: forkLines, hits: [] });
  });
});

it.layer(NodeServices.layer)("runRebrand", (it) => {
  it.effect("rewrites a tree, then a second run changes nothing", () =>
    Effect.gen(function* () {
      const tree = yield* makeTree({
        "docs/a.md": "Welcome to T3 Code\n",
        "apps/web/src/en.json": '{ "home": "Your T3 home" }\n',
        "apps/web/src/same.ts": "export const x = 1;\n",
      });

      const first = runRebrand({ ...tree, mode: "apply" });
      assert.deepStrictEqual(first, {
        changed: ["docs/a.md", "apps/web/src/en.json"],
        remaining: [],
        pinProblems: [],
      });
      assert.strictEqual(read(tree.root, "docs/a.md"), "Welcome to RuCode\n");
      assert.strictEqual(
        read(tree.root, "apps/web/src/en.json"),
        '{ "home": "Your RuCode home" }\n',
      );

      assert.deepStrictEqual(runRebrand({ ...tree, mode: "apply" }), {
        changed: [],
        remaining: [],
        pinProblems: [],
      });
    }),
  );

  it.effect("converges a half-renamed file to the same text as fresh upstream text", () =>
    Effect.gen(function* () {
      const tree = yield* makeTree({
        "half.md": "RuCode home and T3 Code, RuCode server and T3 thread\n",
        "fresh.md": "T3 home and T3 Code, T3 server and T3 thread\n",
      });

      runRebrand({ ...tree, mode: "apply" });

      const expected = "RuCode home and RuCode, RuCode server and RuCode thread\n";
      assert.strictEqual(read(tree.root, "half.md"), expected);
      assert.strictEqual(read(tree.root, "fresh.md"), expected);
    }),
  );

  it.effect(
    "check reports remaining text and unapplied pins without writing, then none after apply",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rucode-rebrand-" });
        writeFiles(root, {
          [PIN_PATH]: UNPINNED_SOURCE,
          "docs/a.md": "intro\nWelcome to T3 Code\n",
          "docs/b.md": "Already RuCode\nthe T3 environment\n",
        });
        const files = [PIN_PATH, "docs/a.md", "docs/b.md"];

        const check = runRebrand({ root, files, mode: "check" });
        assert.deepStrictEqual(check.changed, []);
        assert.deepStrictEqual(check.remaining, [
          { path: PIN_PATH, line: 6, text: 'productName: "T3 Code Dev",' },
          { path: "docs/a.md", line: 2, text: "Welcome to T3 Code" },
          { path: "docs/b.md", line: 2, text: "the T3 environment" },
        ]);
        assert.strictEqual(check.pinProblems.length, 2);
        assert.match(
          check.pinProblems.join("\n"),
          /^packages\/shared\/src\/cliRelease\.ts:2: .*\n.*cliRelease\.ts:5: /,
        );
        assert.strictEqual(read(root, PIN_PATH), UNPINNED_SOURCE);
        assert.strictEqual(read(root, "docs/a.md"), "intro\nWelcome to T3 Code\n");

        runRebrand({ root, files, mode: "apply" });

        assert.deepStrictEqual(runRebrand({ root, files, mode: "check" }), {
          changed: [],
          remaining: [],
          pinProblems: [],
        });
      }),
  );

  it.effect("neither rewrites nor reports excluded paths, including the upstream-sync ledger", () =>
    Effect.gen(function* () {
      const excluded = [
        ".agents/skills/upstream-sync/ledger/2026-11.md",
        ".agents/skills/upstream-sync/SKILL.md",
        ".repos/effect/README.md",
        "patches/foo.patch",
        "pnpm-lock.yaml",
        "LICENSE",
        "apps/web/src/terminal/fonts/LICENSE.txt",
        "third-party-licenses/spdx/MIT.json",
        "evals/cases/title.json",
        "PRODUCT.md",
        "CLAUDE.md",
        "apps/marketing/src/lib/tweets.ts",
        "apps/marketing/src/pages/privacy-policy.astro",
        "apps/marketing/src/pages/terms-of-service.astro",
        "apps/marketing/src/pages/security-policy.astro",
        "apps/marketing/src/pages/legal.astro",
        "docs/operations/upstream-sync.md",
        "scripts/rucode-rebrand.ts",
        "scripts/rucode-rebrand.test.ts",
        "apps/desktop/resources/dmg/background.txt",
        "apps/desktop/resources/linux/app.desktop",
        "packaging/aur/PKGBUILD",
        "scripts/install.sh",
        "scripts/install.ps1",
      ];
      const included = [
        "apps/desktop/resources/installer.nsh",
        "docs/operations/upstream-sync-notes.md",
        "apps/marketing/src/pages/index.astro",
        "apps/web/CLAUDE.md",
      ];
      const tree = yield* makeTree(
        Object.fromEntries([...excluded, ...included].map((file) => [file, "T3 Code\n"])),
      );

      const check = runRebrand({ ...tree, mode: "check" });
      assert.deepStrictEqual(
        check.remaining.map((hit) => hit.path),
        included,
      );

      const apply = runRebrand({ ...tree, mode: "apply" });
      assert.deepStrictEqual(apply.changed, included);
      for (const file of excluded) assert.strictEqual(read(tree.root, file), "T3 Code\n", file);
      for (const file of included) assert.strictEqual(read(tree.root, file), "RuCode\n", file);
    }),
  );

  it.effect("skips a file with a NUL byte in its first 8 KiB, and invalid UTF-8", () =>
    Effect.gen(function* () {
      const nulAt = (index: number) =>
        new Uint8Array([
          ...new TextEncoder().encode(`T3 Code${"a".repeat(index - 7)}`),
          0,
          ...new TextEncoder().encode("\nT3 Code"),
        ]);
      const lastSniffed = nulAt(8191);
      const firstUnsniffed = nulAt(8192);
      const invalidUtf8 = new Uint8Array([0xff, ...new TextEncoder().encode(" T3 Code")]);
      const tree = yield* makeTree({
        "assets/last-sniffed.bin": lastSniffed,
        "assets/first-unsniffed.txt": firstUnsniffed,
        "assets/latin1.txt": invalidUtf8,
      });

      const result = runRebrand({ ...tree, mode: "apply" });

      assert.deepStrictEqual(result.changed, ["assets/first-unsniffed.txt"]);
      const unchanged = (file: string) => NodeFS.readFileSync(NodePath.join(tree.root, file));
      assert.deepStrictEqual(new Uint8Array(unchanged("assets/last-sniffed.bin")), lastSniffed);
      assert.deepStrictEqual(new Uint8Array(unchanged("assets/latin1.txt")), invalidUtf8);
    }),
  );

  it.effect(
    "applies identity pins, keeping indentation, line endings and the other channel's line",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rucode-rebrand-" });
        writeFiles(root, {
          [PIN_PATH]: UNPINNED_SOURCE,
        });

        const applied = runRebrand({ root, files: [PIN_PATH], mode: "apply" });
        assert.deepStrictEqual(applied, { changed: [PIN_PATH], remaining: [], pinProblems: [] });
        assert.strictEqual(read(root, PIN_PATH), PINNED_SOURCE);

        assert.deepStrictEqual(runRebrand({ root, files: [PIN_PATH], mode: "apply" }), {
          changed: [],
          remaining: [],
          pinProblems: [],
        });

        writeFiles(root, {
          [PIN_PATH]:
            '\tappId: "io.github.mayberuk.rucode",\r\n\tappId: "com.t3tools.t3code.dev",\r\n',
        });
        assert.deepStrictEqual(
          runRebrand({ root, files: [PIN_PATH], mode: "apply" }).pinProblems,
          [],
        );
        assert.strictEqual(
          read(root, PIN_PATH),
          '\tappId: "io.github.mayberuk.rucode",\r\n\tappId: "io.github.mayberuk.rucode.dev",\r\n',
        );
      }),
  );

  it.effect("reports a pin whose anchor line is missing, and a missing pin file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "rucode-rebrand-" });
      writeFiles(root, {
        [PIN_PATH]: 'export const appId = "com.example";\n',
        "docs/a.md": "T3 Code\n",
      });

      const missingAnchor = runRebrand({ root, files: [PIN_PATH, "docs/a.md"], mode: "apply" });
      assert.strictEqual(missingAnchor.pinProblems.length, 2);
      for (const problem of missingAnchor.pinProblems) assert.include(problem, PIN_PATH);
      assert.deepStrictEqual(missingAnchor.changed, ["docs/a.md"]);
      assert.strictEqual(read(root, PIN_PATH), 'export const appId = "com.example";\n');

      const missingFile = runRebrand({ root, files: ["docs/a.md"], mode: "check" });
      assert.strictEqual(missingFile.pinProblems.length, 1);
      assert.include(missingFile.pinProblems.join("\n"), PIN_PATH);
    }),
  );

  it.effect("the CLI exits 0 after apply, 1 on a dirty --check or missing pin, 2 on misuse", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "rucode-rebrand-cli-" });
      const env: NodeJS.ProcessEnv = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
        ),
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CEILING_DIRECTORIES: NodePath.dirname(root),
      };
      const script = NodeURL.fileURLToPath(new URL("./rucode-rebrand.ts", import.meta.url));
      const git = (...args: string[]) =>
        NodeChildProcess.execFileSync("git", args, {
          cwd: root,
          env,
          encoding: "utf8",
          stdio: "pipe",
        });
      const cli = (args: string[], cwd = root) => {
        const child = NodeChildProcess.spawnSync(process.execPath, [script, ...args], {
          cwd,
          env,
          encoding: "utf8",
        });
        return { status: child.status, stdout: child.stdout };
      };
      const outputLines = (stdout: string) => stdout.trim().split("\n");

      const notARepo = yield* fs.makeTempDirectoryScoped({ prefix: "rucode-rebrand-norepo-" });
      assert.strictEqual(cli([], notARepo).status, 2);

      git("init", "-q");
      writeFiles(root, { "docs/a.md": "Welcome to T3 Code\n", [PIN_PATH]: UNPINNED_SOURCE });
      writeFiles(root, { "untracked.md": "T3 Code\n" });
      git("add", "docs/a.md", PIN_PATH);

      const dirty = cli(["--check"], NodePath.join(root, "docs"));
      assert.strictEqual(dirty.status, 1);
      assert.include(outputLines(dirty.stdout), "docs/a.md:1: Welcome to T3 Code");
      assert.strictEqual(read(root, "docs/a.md"), "Welcome to T3 Code\n");
      assert.strictEqual(read(root, PIN_PATH), UNPINNED_SOURCE);

      const applied = cli([]);
      assert.strictEqual(applied.status, 0);
      assert.includeMembers(outputLines(applied.stdout), ["docs/a.md", PIN_PATH]);
      assert.strictEqual(read(root, "docs/a.md"), "Welcome to RuCode\n");
      assert.strictEqual(read(root, PIN_PATH), PINNED_SOURCE);
      assert.strictEqual(read(root, "untracked.md"), "T3 Code\n");

      const again = cli([]);
      assert.strictEqual(again.status, 0);
      assert.notInclude(outputLines(again.stdout), "docs/a.md");
      assert.strictEqual(cli(["--check"]).status, 0);
      assert.strictEqual(cli(["--fix"]).status, 2);

      writeFiles(root, { "docs/a.md": "Welcome to T3 Code\n", "conflicted.md": "T3 Code\n" });
      const blob = git("hash-object", "-w", "conflicted.md").trim();
      NodeChildProcess.execFileSync("git", ["update-index", "--index-info"], {
        cwd: root,
        env,
        input: [1, 2, 3].map((stage) => `100644 ${blob} ${stage}\tconflicted.md\n`).join(""),
      });
      assert.notStrictEqual(git("ls-files", "-u"), "");
      assert.strictEqual(cli([]).status, 2);
      assert.strictEqual(cli(["--check"]).status, 2);
      assert.strictEqual(read(root, "docs/a.md"), "Welcome to T3 Code\n");
      assert.strictEqual(read(root, "conflicted.md"), "T3 Code\n");

      git("update-index", "--force-remove", "conflicted.md");
      writeFiles(root, { [PIN_PATH]: "export {};\n" });
      const missingPin = cli([]);
      assert.strictEqual(missingPin.status, 1);
      assert.include(missingPin.stdout, `${PIN_PATH}: identity pin anchor missing`);
    }),
  );
});
