import { MAX_SCRIPT_ID_LENGTH, ProjectScriptIcon, type ProjectScript } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export interface ProjectActionCandidate {
  readonly name: string;
  readonly command: string;
  readonly icon: string;
}

export type ProjectActionRejection =
  | "empty"
  | "too-long"
  | "multi-line"
  | "unknown-icon"
  | "dangerous-command"
  | "duplicate";

export const MAX_SUGGESTED_PROJECT_ACTIONS = 3;

const MAX_NAME_LENGTH = 40;
const MAX_COMMAND_LENGTH = 200;
const isProjectScriptIcon = Schema.is(ProjectScriptIcon);

const dangerousCommandPatterns = [
  /(?<![\w.-])(?:sudo|doas|curl|wget|eval|shutdown|reboot|kill|pkill|killall)(?![\w.-])/i,
  /(?<![\w.-])(?:rm|chmod|chown)(?=[\s'"])[^;&|\r\n]*?[\s'"]-(?:-recursive|[a-z]*r[a-z]*)(?=[\s'";&|<>()]|$)/i,
  /\|\s*['"]?(?:[\w./\\-]*[/\\])?(?:sh|bash|zsh|fish|sudo)(?=[\s'";&|<>()]|$)/i,
  /`|\$\(/,
  /(?<![\w.-])git(?=[\s'"])[^;&|\r\n]*?\s['"]?(?:push|clean)(?=[\s'";&|<>()]|$)/i,
  /(?<![\w.-])git(?=[\s'"])[^;&|\r\n]*?\s['"]?reset(?=[\s'"])[^;&|\r\n]*?\s['"]?--hard(?=[\s'";&|<>()]|$)/i,
  /(?<![\w.-])git(?=[\s'"])[^;&|\r\n]*?\s['"]?checkout(?=[\s'"])[^;&|\r\n]*?\s['"]?--(?=[\s'";&|<>()]|$)/i,
  /(?<![\w.-])(?:npm|pnpm|yarn|bun|cargo)(?=[\s'"])[^;&|\r\n]*?\s['"]?publish(?=[\s'";&|<>()]|$)/i,
  /(?<![\w.-])twine(?=[\s'"])[^;&|\r\n]*?\s['"]?upload(?=[\s'";&|<>()]|$)/i,
  /(?<![\w.-])gem(?=[\s'"])[^;&|\r\n]*?\s['"]?push(?=[\s'";&|<>()]|$)/i,
  /(?<![\w.-])(?:deploy|release)(?![\w.-])/i,
  /(?<![\w.-])mkfs(?:\.[\w-]+)?(?![\w.-])/i,
  /(?<![\w.-])dd(?=[\s'"])[^;&|\r\n]*?\s['"]?if=/i,
  />\s*['"]?(?:\/|[a-z]:[/\\]|\\\\)/i,
  /:\s*\(\s*\)\s*\{/,
];

export function isDangerousCommand(command: string): boolean {
  return dangerousCommandPatterns.some((pattern) => pattern.test(command));
}

function duplicatesAction(name: string, command: string, scripts: ReadonlyArray<ProjectScript>) {
  const foldedName = name.toLowerCase();
  return scripts.some(
    (script) =>
      script.command.trim() === command || script.name.trim().toLowerCase() === foldedName,
  );
}

export function rejectProjectActionCandidate(
  candidate: ProjectActionCandidate,
  existing: ReadonlyArray<ProjectScript>,
): ProjectActionRejection | null {
  const name = candidate.name.trim();
  const command = candidate.command.trim();
  if (name.length === 0 || command.length === 0) return "empty";
  if (candidate.name.length > MAX_NAME_LENGTH || candidate.command.length > MAX_COMMAND_LENGTH) {
    return "too-long";
  }
  const controlOrLineBreak = /[\p{Cc}\u2028\u2029]/u;
  if (controlOrLineBreak.test(candidate.name) || controlOrLineBreak.test(candidate.command)) {
    return "multi-line";
  }
  if (!isProjectScriptIcon(candidate.icon)) return "unknown-icon";
  if (isDangerousCommand(command)) return "dangerous-command";

  return duplicatesAction(name, command, existing) ? "duplicate" : null;
}

function nextProjectScriptId(name: string, taken: ReadonlySet<string>): string {
  const baseId =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_SCRIPT_ID_LENGTH)
      .replace(/-+$/g, "") || "script";
  if (!taken.has(baseId)) return baseId;

  for (let suffix = 2; ; suffix += 1) {
    const ending = `-${suffix}`;
    const id = `${baseId.slice(0, MAX_SCRIPT_ID_LENGTH - ending.length)}${ending}`;
    if (!taken.has(id)) return id;
  }
}

export function acceptProjectActionCandidates(
  candidates: ReadonlyArray<ProjectActionCandidate>,
  existing: ReadonlyArray<ProjectScript>,
): ReadonlyArray<ProjectScript> {
  const accepted: ProjectScript[] = [];
  const takenIds = new Set(existing.map(({ id }) => id));
  for (const candidate of candidates) {
    if (rejectProjectActionCandidate(candidate, existing) !== null) continue;

    const name = candidate.name.trim();
    const command = candidate.command.trim();
    if (duplicatesAction(name, command, accepted)) continue;

    const id = nextProjectScriptId(name, takenIds);
    accepted.push({
      id,
      name,
      command,
      icon: candidate.icon as ProjectScript["icon"],
      runOnWorktreeCreate: false,
      runOnSettle: false,
      stopOnSettle: false,
    });
    takenIds.add(id);
    if (accepted.length === MAX_SUGGESTED_PROJECT_ACTIONS) break;
  }
  return accepted;
}
