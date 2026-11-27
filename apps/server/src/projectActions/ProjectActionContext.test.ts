import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";

import {
  gatherProjectActionContext,
  PROJECT_ACTION_CONTEXT_MAX_CHARS,
} from "./ProjectActionContext.ts";

const makeProject = Effect.fn("ProjectActionContext.test.makeProject")(function* (
  files: Readonly<Record<string, string>> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped();
  const root = path.join(directory, "acme-app");
  yield* fs.makeDirectory(root);
  for (const [file, contents] of Object.entries(files)) {
    yield* fs.writeFileString(path.join(root, file), contents);
  }
  return { fs, path, root };
});

it.layer(NodeServices.layer)("project action context", (it) => {
  it.effect("lists every root source in order and prefers a declared package manager", () =>
    Effect.gen(function* () {
      const { root } = yield* makeProject({
        "package.json": JSON.stringify({
          name: "acme-package",
          packageManager: "pnpm@10.0.0",
          scripts: { test: "vitest run", dev: "vite" },
        }),
        "yarn.lock": "",
        Makefile:
          ".PHONY: test lint\n.IGNORE:\n_internal:\ntest lint: deps\n\techo recipe: internal\n",
        justfile:
          "default:\n  @echo ignored\n[group('checks')]\ncheck profile='dev': default\n_private:\n.hidden:\nversion := '1'\n",
        "pyproject.toml":
          '[project.scripts]\nserve = "acme:serve"\n[project.gui-scripts]\ngui = "acme:gui"\n[tool.poetry.scripts] # published entry points\n"run-tests" = { reference = "acme:tests", type = "console" }\n[tool.other]\nignore = "acme:ignore"\n',
        "Cargo.toml": "",
        "go.mod": "",
        "t3.json": JSON.stringify({ scripts: [{ name: "Check", command: "just check" }] }),
        "AGENTS.md": [
          "Prose and pnpm run ignored.",
          "",
          "```sh",
          "pnpm test",
          "```",
          "",
          "Use `vp run typecheck` or `unknown prose`, but avoid `make-something`.",
        ].join("\n"),
        "CLAUDE.md": ["~~~sh", "./scripts/check", "~~~", "Run `uv run pytest`."].join("\n"),
      });

      expect(yield* gatherProjectActionContext(root)).toBe(
        [
          "Project: acme-app",
          "Package manager: pnpm",
          "package.json scripts:\ntest: vitest run\ndev: vite",
          "Makefile targets:\ntest\nlint",
          "justfile recipes:\ndefault\ncheck",
          "pyproject.toml scripts:\nserve\nrun-tests",
          "Other manifests:\nCargo.toml\ngo.mod",
          "t3.json scripts:\nCheck: just check",
          "AGENTS.md commands:\npnpm test\nvp run typecheck",
          "CLAUDE.md commands:\n./scripts/check\nuv run pytest",
        ].join("\n\n"),
      );
    }),
  );

  it.effect.each([
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
  ] as const)("infers the package manager from %s", ([lockfile, manager]) =>
    Effect.gen(function* () {
      const { root } = yield* makeProject({ [lockfile]: "" });
      expect(yield* gatherProjectActionContext(root)).toBe(
        `Project: acme-app\n\nPackage manager: ${manager}`,
      );
    }),
  );

  it.effect.each([
    [
      "malformed package.json",
      "{ broken",
      '{"scripts":[{"name":"Lint","command":"vp run lint"}]}',
      "t3.json scripts:\nLint: vp run lint",
    ],
    [
      "malformed t3.json",
      '{"scripts":{"test":"vitest run"}}',
      "{ broken",
      "package.json scripts:\ntest: vitest run",
    ],
  ] as const)(
    "skips %s without dropping another JSON source or lockfile inference",
    ([, packageJson, t3Json, section]) =>
      Effect.gen(function* () {
        const { root } = yield* makeProject({
          "package.json": packageJson,
          "t3.json": t3Json,
          "pnpm-lock.yaml": "",
        });
        expect(yield* gatherProjectActionContext(root)).toBe(
          `Project: acme-app\n\nPackage manager: pnpm\n\n${section}`,
        );
      }),
  );

  it.effect("skips unrecognized JSON shapes and omits empty sections", () =>
    Effect.gen(function* () {
      const { root } = yield* makeProject({
        "package.json": '{"packageManager":3,"scripts":{"empty":" ","not-a-command":3}}',
        "t3.json": '{"scripts":[{"name":"Lint","command":42}]}',
        Makefile: "# acme comments only\n.PHONY: all\n_hidden:\n",
        "pyproject.toml": '[tool.other]\nignore = "acme:ignore"\n',
        "AGENTS.md": "Only prose.",
      });
      expect(yield* gatherProjectActionContext(root)).toBe("Project: acme-app");
    }),
  );

  it.effect("skips a broken Python script section without dropping other sources", () =>
    Effect.gen(function* () {
      const { root } = yield* makeProject({
        "pyproject.toml": '[project.scripts]\nvalid = "acme:run"\nbroken = "acme:broken\n',
        Makefile: "check:\n",
      });
      expect(yield* gatherProjectActionContext(root)).toBe(
        "Project: acme-app\n\nMakefile targets:\ncheck",
      );
    }),
  );

  it.effect("skips one byte over 256 KiB and accepts exactly 256 KiB", () =>
    Effect.gen(function* () {
      const instruction = ["```sh", "pnpm test", "```", ""].join("\n");
      const { root } = yield* makeProject({
        "package.json": '{"scripts":{"dev":"vite"}}'.padEnd(256 * 1024 + 1),
        "AGENTS.md": instruction + "é".repeat((256 * 1024 - instruction.length) / 2),
      });
      expect(yield* gatherProjectActionContext(root)).toBe(
        "Project: acme-app\n\nAGENTS.md commands:\npnpm test",
      );
    }),
  );

  it.effect("skips a root file that fails to read and reads the remaining sources", () =>
    Effect.gen(function* () {
      const { fs, path, root } = yield* makeProject({
        "package.json": '{"scripts":{"test":"vitest run"}}',
        Makefile: "check:\n",
      });
      const unreadable = path.join(root, "package.json");
      const summary = yield* gatherProjectActionContext(root).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          stream: (file, options) =>
            file === unreadable
              ? Stream.fail(
                  PlatformError.systemError({
                    module: "FileSystem",
                    method: "stream",
                    _tag: "PermissionDenied",
                    pathOrDescriptor: file,
                  }),
                )
              : fs.stream(file, options),
        }),
      );
      expect(summary).toBe("Project: acme-app\n\nMakefile targets:\ncheck");
    }),
  );

  it.effect("skips a file that grows past 256 KiB after its metadata is read", () =>
    Effect.gen(function* () {
      const initial = '{"scripts":{"test":"vitest run"}}';
      const { fs, path, root } = yield* makeProject({ "package.json": initial });
      const growing = path.join(root, "package.json");
      const summary = yield* gatherProjectActionContext(root).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          lstat: (file) =>
            file === growing
              ? fs
                  .lstat(file)
                  .pipe(Effect.tap(() => fs.writeFileString(file, initial.padEnd(256 * 1024 + 1))))
              : fs.lstat(file),
        }),
      );
      expect(summary).toBe("Project: acme-app");
    }),
  );

  it.effect("skips nested content, symlinks and directories at recognized root paths", () =>
    Effect.gen(function* () {
      const { fs, path, root } = yield* makeProject({ "pnpm-lock.yaml": "" });
      const nested = path.join(root, "nested");
      yield* fs.makeDirectory(nested);
      yield* fs.makeDirectory(path.join(root, "go.mod"));
      yield* fs.writeFileString(path.join(nested, "Makefile"), "nested-test:\n");
      yield* fs.writeFileString(path.join(nested, "CLAUDE.md"), "Run `pnpm lint`.");
      yield* fs.symlink(path.join(nested, "CLAUDE.md"), path.join(root, "CLAUDE.md"));
      expect(yield* gatherProjectActionContext(root)).toBe(
        "Project: acme-app\n\nPackage manager: pnpm",
      );
    }),
  );

  it.effect(
    "keeps 40 package scripts, 30 targets per build file, and 40 instruction commands across both files",
    () =>
      Effect.gen(function* () {
        const { root } = yield* makeProject({
          "package.json": JSON.stringify({
            scripts: Object.fromEntries(
              Array.from({ length: 41 }, (_, i) => [`script-${i + 1}`, "make test"]),
            ),
          }),
          Makefile: Array.from({ length: 31 }, (_, i) => `target-${i + 1}:\n`).join(""),
          justfile: Array.from({ length: 31 }, (_, i) => `recipe-${i + 1}:\n`).join(""),
          "AGENTS.md": Array.from({ length: 39 }, (_, i) => `Run \`pnpm script-${i + 1}\`.\n`).join(
            "",
          ),
          "CLAUDE.md": "Run `make first` or `make second`.",
        });
        const sections = (yield* gatherProjectActionContext(root)).split("\n\n");
        expect(sections).toHaveLength(6);
        expect(sections[1]?.split("\n")).toHaveLength(41);
        expect(sections[1]).toMatch(/\nscript-40: make test$/);
        expect(sections[2]?.split("\n")).toHaveLength(31);
        expect(sections[2]).toMatch(/\ntarget-30$/);
        expect(sections[3]?.split("\n")).toHaveLength(31);
        expect(sections[3]).toMatch(/\nrecipe-30$/);
        expect(sections[4]?.split("\n")).toHaveLength(40);
        expect(sections[4]).toMatch(/\npnpm script-39$/);
        expect(sections[5]).toBe("CLAUDE.md commands:\nmake first");
      }),
  );

  it.effect("caps the full summary at exactly 6,000 characters", () =>
    Effect.gen(function* () {
      const { root } = yield* makeProject({
        "package.json": JSON.stringify({ scripts: { test: "x".repeat(6001) } }),
        Makefile: "check:\n",
      });
      expect(PROJECT_ACTION_CONTEXT_MAX_CHARS).toBe(6000);
      expect(yield* gatherProjectActionContext(root)).toBe(
        "Project: acme-app\n\npackage.json scripts:\ntest: ".padEnd(6000, "x"),
      );
    }),
  );

  it.effect("keeps inline commands from each known runner", () =>
    Effect.gen(function* () {
      const commands = [
        "npm run dev",
        "pnpm test",
        "yarn build",
        "bun run dev",
        "npx vitest",
        "vp run lint",
        "make test",
        "just check",
        "cargo build",
        "go test",
        "python -m unittest",
        "uv run pytest",
        "poetry run pytest",
        "pytest",
        "deno task check",
      ];
      const { root } = yield* makeProject({
        "AGENTS.md": "Run " + commands.map((command) => "``" + command + "``").join(" or ") + ".",
      });
      expect(yield* gatherProjectActionContext(root)).toBe(
        ["Project: acme-app", "", "AGENTS.md commands:", ...commands].join("\n"),
      );
    }),
  );

  it.effect(
    "caps an instruction file on its own and omits the next file when no budget remains",
    () =>
      Effect.gen(function* () {
        const { root } = yield* makeProject({
          "AGENTS.md": Array.from({ length: 41 }, (_, i) => `Run \`pnpm script-${i + 1}\`.\n`).join(
            "",
          ),
          "CLAUDE.md": "Run `pnpm lint`.",
        });
        const lines = (yield* gatherProjectActionContext(root)).split("\n");
        expect(lines).toHaveLength(43);
        expect(lines.at(-1)).toBe("pnpm script-40");
        expect(lines).not.toContain("CLAUDE.md commands:");
      }),
  );

  it.effect("returns only the project name for both empty and missing roots", () =>
    Effect.gen(function* () {
      const { path, root } = yield* makeProject();
      expect(yield* gatherProjectActionContext(root)).toBe("Project: acme-app");
      expect(yield* gatherProjectActionContext(path.join(root, "missing"))).toBe(
        "Project: missing",
      );
    }),
  );
});
