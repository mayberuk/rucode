import { T3_PROJECT_FILE_NAME } from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

export const PROJECT_ACTION_CONTEXT_MAX_CHARS = 6000;

const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_PACKAGE_SCRIPTS = 40;
const MAX_BUILD_TARGETS = 30;
const MAX_INSTRUCTION_COMMANDS = 40;

const packageManagerLockfiles = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
] as const;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePackageJson(contents: string | undefined) {
  if (contents === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(contents);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function packageScriptLines(scripts: unknown): string[] {
  if (!isRecord(scripts)) return [];
  return Object.entries(scripts)
    .slice(0, MAX_PACKAGE_SCRIPTS)
    .flatMap(([name, command]) =>
      name.trim() && typeof command === "string" && command.trim() ? [`${name}: ${command}`] : [],
    );
}

function buildTargets(contents: string | undefined, kind: "make" | "just"): string[] {
  if (contents === undefined) return [];

  const targets = new Set<string>();
  const lines = contents.replace(/\\\r?\n/g, " ").split(/\r?\n/);
  for (const line of lines) {
    const names =
      kind === "make"
        ? line.match(/^ *([a-z0-9_./-]+(?:[ \t]+[a-z0-9_./-]+)*)[ \t]*:{1,2}(?![:=])/i)?.[1]
        : line.match(/^@?([\w.-]+)(?:[ \t]+[^:#]*)?:(?!=)/)?.[1];
    if (names === undefined) continue;
    for (const name of names.split(/[ \t]+/)) {
      if (name.startsWith(".") || name.startsWith("_")) continue;
      targets.add(name);
      if (targets.size === MAX_BUILD_TARGETS) return [...targets];
    }
  }
  return [...targets];
}

function pythonScriptNames(contents: string | undefined): string[] {
  if (contents === undefined) return [];
  const scripts: string[] = [];
  let inScripts = false;
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      inScripts = /^\[\s*(?:project|tool\s*\.\s*poetry)\s*\.\s*scripts\s*\]\s*(?:#.*)?$/.test(line);
    } else if (inScripts && line && !line.startsWith("#")) {
      const key = line.match(
        /^(?:([\w-]+)|"((?:[^"\\]|\\.)+)"|'([^']+)')\s*=\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'|\{.*\})\s*(?:#.*)?$/,
      );
      const name = key?.[1] ?? key?.[2] ?? key?.[3];
      if (name === undefined) return [];
      scripts.push(name);
    }
  }
  return scripts;
}

const inlineRunner =
  /^(?:npm|pnpm|yarn|bun|npx|vp|make|just|cargo|go|python|uv|poetry|pytest|deno)(?:\s|$)/;

function instructionCommands(contents: string | undefined, limit: number): string[] {
  if (contents === undefined || limit === 0) return [];
  const commands: string[] = [];
  let fence: string | undefined;
  for (const line of contents.split(/\r?\n/)) {
    const fenceLine = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const marker = fenceLine?.[1];
    const suffix = fenceLine?.[2]?.trim() ?? "";
    if (fence !== undefined) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && suffix === "") {
        fence = undefined;
      } else if (line.trim()) {
        commands.push(line.trim());
      }
    } else if (marker && (marker[0] === "~" || !suffix.includes("`"))) {
      fence = marker;
    } else {
      for (const match of line.matchAll(/(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)/g)) {
        const command = match[2]?.trim();
        if (command && inlineRunner.test(command)) commands.push(command);
        if (commands.length === limit) break;
      }
    }
    if (commands.length === limit) break;
  }
  return commands;
}

function section(label: string, lines: ReadonlyArray<string>): string | undefined {
  return lines.length === 0 ? undefined : `${label}:\n${lines.join("\n")}`;
}

export const gatherProjectActionContext = Effect.fn("ProjectActionContext.gather")(function* (
  workspaceRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const readSource = Effect.fn("ProjectActionContext.readSource")(
    function* (file: string, mode: "contents" | "presence" = "contents") {
      const filePath = path.join(workspaceRoot, file);
      const info = yield* fs.lstat(filePath);
      if (info.type !== "File" || info.size > MAX_SOURCE_BYTES) return undefined;
      if (mode === "presence") {
        yield* fs.access(filePath, { readable: true });
        return file;
      }
      const chunks = yield* Stream.runCollect(
        fs.stream(filePath, { bytesToRead: MAX_SOURCE_BYTES + 1 }),
      );
      const bytes = Buffer.concat(chunks);
      return bytes.length > MAX_SOURCE_BYTES ? undefined : bytes.toString("utf8");
    },
    Effect.orElseSucceed(() => undefined),
  );

  const sources = yield* Effect.all(
    {
      packageJson: readSource("package.json"),
      lockfiles: Effect.forEach(packageManagerLockfiles, ([file]) => readSource(file, "presence"), {
        concurrency: "unbounded",
      }),
      makefile: readSource("Makefile"),
      justfile: readSource("justfile"),
      pyproject: readSource("pyproject.toml"),
      manifests: Effect.forEach(["Cargo.toml", "go.mod"], (file) => readSource(file, "presence"), {
        concurrency: "unbounded",
      }),
      t3: readSource(T3_PROJECT_FILE_NAME),
      agents: readSource("AGENTS.md"),
      claude: readSource("CLAUDE.md"),
    },
    { concurrency: "unbounded" },
  );

  const packageJson = parsePackageJson(sources.packageJson);
  const declaredManager = packageJson?.packageManager;
  const inferredManager = packageManagerLockfiles[sources.lockfiles.findIndex(Boolean)]?.[1];
  const manager =
    (typeof declaredManager === "string"
      ? declaredManager.trim().match(/^[a-z][a-z0-9-]*(?=@|$)/i)?.[0]
      : undefined) ?? inferredManager;

  const t3Scripts = sources.t3 === undefined ? undefined : parseT3ProjectFile(sources.t3)?.scripts;
  const agents = instructionCommands(sources.agents, MAX_INSTRUCTION_COMMANDS);
  const claude = instructionCommands(sources.claude, MAX_INSTRUCTION_COMMANDS - agents.length);

  return [
    `Project: ${path.basename(workspaceRoot) || workspaceRoot}`,
    manager === undefined ? undefined : `Package manager: ${manager}`,
    section("package.json scripts", packageScriptLines(packageJson?.scripts)),
    section("Makefile targets", buildTargets(sources.makefile, "make")),
    section("justfile recipes", buildTargets(sources.justfile, "just")),
    section("pyproject.toml scripts", pythonScriptNames(sources.pyproject)),
    section(
      "Other manifests",
      sources.manifests.filter((file) => file !== undefined),
    ),
    section("t3.json scripts", t3Scripts?.map(({ name, command }) => `${name}: ${command}`) ?? []),
    section("AGENTS.md commands", agents),
    section("CLAUDE.md commands", claude),
  ]
    .filter((entry) => entry !== undefined)
    .join("\n\n")
    .slice(0, PROJECT_ACTION_CONTEXT_MAX_CHARS);
});
