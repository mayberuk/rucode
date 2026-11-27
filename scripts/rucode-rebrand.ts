#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Only node: imports: this runs straight after an upstream merge, before dependencies are reinstalled.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export type Hit = { path: string; line: number; text: string };

type Pin = { path: string; anchor: RegExp; target: string };

const REPLACEMENTS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /(?:\b|(?<=\\[fnrtv]))T3(?: |%20|\+)Code\b/g, replacement: "RuCode" },
  {
    pattern: /(?:\b|(?<=\\[fnrtv]))T3 (homes?|servers?|threads?|environments?)\b/g,
    replacement: "RuCode $1",
  },
];

const MARKDOWN_LINK_FRAGMENT = /(\]\([^)\s#]*#)([^)\s]*)/g;
const FRAGMENT_SLUG = /(?<![a-z0-9])t3-code(?![a-z0-9])/g;

// Installed profiles, running apps and shims are recognized by their original names and marker.
// Wire identifiers other programs match on stay too: the Codex originator, client info and
// user agent, the GitHub app's registered name, the Android album folder and the connection
// error wording older servers still send.
const PRESERVED_LITERALS = [
  "T3 Code (Alpha)",
  "T3 Code (Dev)",
  "Written by T3 Code: runs the desktop app's bundled t3 CLI.",
  'CODEX_CLIENT_NAME = "T3 Code"',
  '"clientInfo":{"name":"T3 Code","title":"T3 Code"',
  'clientInfo: { name: "T3 Code", title: "T3 Code"',
  '"originator":"T3 Code"',
  '"userAgent":"T3 Code/',
  'userAgent: "T3 Code/',
  "unknown (T3 Code; ",
  "T3 Code for GitHub",
  "Pictures/T3 Code",
  "DIRECTORY_PICTURES}/T3 Code",
  "Unable to connect to the T3 server WebSocket.",
];

const PRESERVED_LINE = /fork of T3 Code|upstream T3 Code|T3 Code upstream/i;
const DEFERRED_INSTALLER_OUTPUT = /Installed T3 Code|to use T3 Code here/;

const EXCLUDED_PATHS: ReadonlyArray<RegExp> = [
  /^\.repos\//,
  /^patches\//,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)LICENSE[^/]*$/,
  /^third-party-licenses\//,
  /^evals\//,
  /^PRODUCT\.md$/,
  /^CLAUDE\.md$/,
  /^apps\/marketing\/src\/lib\/tweets\.ts$/,
  /^apps\/marketing\/src\/pages\/(privacy-policy|terms-of-service|security-policy|legal)\.astro$/,
  /^\.(agents|cursor|devcontainer|github)\//,
  /^oxlint-plugin-t3code\//,
  /^docs\/operations\/upstream-sync\.md$/,
  /^scripts\/rucode-rebrand(\.test)?\.ts$/,
  /^apps\/desktop\/resources\/dmg\//,
  /^apps\/desktop\/resources\/linux\//,
  /^packaging\//,
  /^scripts\/install\.(sh|ps1)$/,
];

const IDENTITY_PINS: ReadonlyArray<Pin> = [
  {
    path: "packages/shared/src/cliRelease.ts",
    anchor: /^\s*appId: "com\.t3tools\.t3code",$/,
    target: 'appId: "io.github.mayberuk.rucode",',
  },
  {
    path: "packages/shared/src/cliRelease.ts",
    anchor: /^\s*appId: "com\.t3tools\.t3code\.dev",$/,
    target: 'appId: "io.github.mayberuk.rucode.dev",',
  },
];

const BINARY_SNIFF_BYTES = 8192;

function isExcluded(relativePath: string): boolean {
  return EXCLUDED_PATHS.some((pattern) => pattern.test(relativePath));
}

function rebrandLine(filePath: string, line: string): string {
  if (PRESERVED_LINE.test(line)) return line;
  if (filePath === "scripts/install.test.ts" && DEFERRED_INSTALLER_OUTPUT.test(line)) return line;
  if (
    filePath === "packages/shared/src/t3McpToolPresentation.test.ts" &&
    line.trim() === '"T3 Code ",'
  ) {
    return line;
  }
  let next = line;
  PRESERVED_LITERALS.forEach((literal, index) => {
    next = next.replaceAll(literal, `${index}`);
  });
  for (const { pattern, replacement } of REPLACEMENTS) {
    next = next.replace(pattern, replacement);
  }
  if (filePath.endsWith(".md")) {
    next = next.replace(
      MARKDOWN_LINK_FRAGMENT,
      (_match, prefix: string, fragment: string) =>
        prefix + fragment.replace(FRAGMENT_SLUG, "rucode"),
    );
  }
  return next.replace(
    /(\d+)/g,
    (match, index: string) => PRESERVED_LITERALS[Number(index)] ?? match,
  );
}

export function rebrandText(path: string, text: string): { text: string; hits: Hit[] } {
  const hits: Hit[] = [];
  const lines = text.split("\n");
  // The bundled playbook must match the upstream copy under .github byte for byte.
  const playbookStart =
    path === "apps/server/src/triage/triagePrompt.ts"
      ? lines.findIndex((line) => line.startsWith("export const TRIAGE_PLAYBOOK = `"))
      : -1;
  const playbookEnd =
    playbookStart < 0
      ? -1
      : lines.findIndex((line, index) => index > playbookStart && line.trimEnd() === "`;");
  const rewritten = lines.map((line, index) => {
    if (index >= playbookStart && index <= playbookEnd) return line;
    const next = rebrandLine(path, line);
    if (next !== line) hits.push({ path, line: index + 1, text: line.trim() });
    return next;
  });
  return { text: rewritten.join("\n"), hits };
}

function applyPins(
  filePath: string,
  text: string,
  mode: "apply" | "check",
  pinProblems: string[],
): string {
  const lines = text.split("\n");
  for (const pin of IDENTITY_PINS.filter((candidate) => candidate.path === filePath)) {
    let anchored = false;
    let pinned = false;
    lines.forEach((line, index) => {
      const carriageReturn = line.endsWith("\r") ? "\r" : "";
      const content = carriageReturn ? line.slice(0, -1) : line;
      if (content.trim() === pin.target) pinned = true;
      if (!pin.anchor.test(content)) return;
      anchored = true;
      if (mode === "check") {
        pinProblems.push(`${filePath}:${index + 1}: identity pin not applied: ${content.trim()}`);
        return;
      }
      const indent = /^\s*/.exec(content)?.[0] ?? "";
      lines[index] = `${indent}${pin.target}${carriageReturn}`;
    });
    if (!anchored && !pinned) {
      pinProblems.push(
        `${filePath}: identity pin anchor missing: no line matches ${pin.anchor} or ${pin.target}`,
      );
    }
  }
  return lines.join("\n");
}

function readText(absolutePath: string): string | undefined {
  let stat: NodeFS.Stats;
  try {
    stat = NodeFS.lstatSync(absolutePath);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  const bytes = NodeFS.readFileSync(absolutePath);
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return undefined;
  const text = bytes.toString("utf8");
  // Invalid UTF-8 would be rewritten as U+FFFD, corrupting a file the rules never matched.
  if (!Buffer.from(text, "utf8").equals(bytes)) return undefined;
  return text;
}

export function runRebrand(input: {
  root: string;
  files: readonly string[];
  mode: "apply" | "check";
}): { changed: string[]; remaining: Hit[]; pinProblems: string[] } {
  const changed: string[] = [];
  const remaining: Hit[] = [];
  const pinProblems: string[] = [];
  const pinPaths = new Set(IDENTITY_PINS.map((pin) => pin.path));
  const seenPinPaths = new Set<string>();

  for (const file of input.files) {
    const isPinPath = pinPaths.has(file);
    if (isExcluded(file) && !isPinPath) continue;
    const absolutePath = NodePath.join(input.root, file);
    const original = readText(absolutePath);
    if (original === undefined) continue;

    let next = original;
    if (!isExcluded(file)) {
      const result = rebrandText(file, original);
      if (input.mode === "check") remaining.push(...result.hits);
      else {
        next = result.text;
        remaining.push(...rebrandText(file, next).hits);
      }
    }
    if (isPinPath) {
      seenPinPaths.add(file);
      next = applyPins(file, next, input.mode, pinProblems);
    }
    if (input.mode === "apply" && next !== original) {
      NodeFS.writeFileSync(absolutePath, next);
      changed.push(file);
    }
  }

  for (const pinPath of pinPaths) {
    if (!seenPinPaths.has(pinPath)) {
      pinProblems.push(`${pinPath}: identity pin file is missing or unreadable`);
    }
  }
  return { changed, remaining, pinProblems };
}

function git(cwd: string, args: string[]): string {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function main(argv: readonly string[]): number {
  const usage = "usage: node scripts/rucode-rebrand.ts [--check]";
  const unknown = argv.filter((arg) => arg !== "--check");
  if (unknown.length > 0) {
    console.error(`rucode-rebrand: unknown argument ${unknown.join(" ")}\n${usage}`);
    return 2;
  }
  const mode = argv.includes("--check") ? "check" : "apply";

  let root: string;
  let files: string[];
  try {
    root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
    if (git(root, ["ls-files", "-u"]).trim() !== "") {
      console.error("rucode-rebrand: unmerged paths present; resolve the conflicts first");
      return 2;
    }
    files = git(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
  } catch (error) {
    console.error(`rucode-rebrand: not a git repository (${String(error).trim()})`);
    return 2;
  }

  const result = runRebrand({ root, files, mode });
  for (const file of result.changed) console.log(file);
  for (const hit of result.remaining) console.log(`${hit.path}:${hit.line}: ${hit.text}`);
  for (const problem of result.pinProblems) console.log(problem);
  console.log(
    mode === "apply"
      ? `rucode-rebrand: ${result.changed.length} file(s) changed, ${result.pinProblems.length} pin problem(s)`
      : `rucode-rebrand --check: ${result.remaining.length} remaining hit(s), ${result.pinProblems.length} pin problem(s)`,
  );
  return result.remaining.length > 0 || result.pinProblems.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
