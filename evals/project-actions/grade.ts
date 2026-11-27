import type { ProjectScript } from "@t3tools/contracts";
import {
  isDangerousCommand,
  type ProjectActionCandidate,
} from "../../apps/server/src/projectActions/ProjectActionSuggestionPolicy.ts";
import type { ProjectActionEvaluationCase } from "./cases.ts";

function hasPackageScript(contents: string | undefined, script: string): boolean {
  if (contents === undefined) return false;
  try {
    const manifest: unknown = JSON.parse(contents);
    if (typeof manifest !== "object" || manifest === null || !("scripts" in manifest)) return false;
    const { scripts } = manifest;
    return (
      typeof scripts === "object" &&
      scripts !== null &&
      !Array.isArray(scripts) &&
      typeof Object.getOwnPropertyDescriptor(scripts, script)?.value === "string"
    );
  } catch {
    return false;
  }
}

function isGrounded(command: string, files: ProjectActionEvaluationCase["files"]): boolean {
  if (
    [files["AGENTS.md"], files["CLAUDE.md"]].some((contents) =>
      contents?.includes(`\`${command}\``),
    )
  ) {
    return true;
  }

  const script = command.match(/^(?:npm|pnpm|yarn|bun)[ \t]+(?:run[ \t]+)?([\w.:/-]+)$/)?.[1];
  if (script !== undefined) return hasPackageScript(files["package.json"], script);

  const [, runner, target] = command.match(/^(make|just)[ \t]+([\w./-]+)$/) ?? [];
  if (target === undefined) return false;
  const name = RegExp.escape(target);
  if (runner === "make") {
    return new RegExp(
      `^ *(?:[\\w./-]+[ \\t]+)*${name}(?:[ \\t]+[\\w./-]+)*[ \\t]*:(?!=)`,
      "m",
    ).test(files.Makefile ?? "");
  }
  return new RegExp(`^@?${name}(?:[ \\t]+[^:#\\r\\n]*)?[ \\t]*:(?!=)`, "m").test(
    files.justfile ?? "",
  );
}

function containsForbidden(actions: ReadonlyArray<ProjectActionCandidate>, forbidden: string) {
  return actions.some(({ name, command, icon }) =>
    [name, command, icon].some((field) => field.toLowerCase().includes(forbidden)),
  );
}

export function gradeCase(
  fixture: ProjectActionEvaluationCase,
  raw: ReadonlyArray<ProjectActionCandidate>,
  accepted: ReadonlyArray<ProjectScript>,
): { pass: boolean; failures: string[] } {
  const failures: string[] = [];
  const { minAccepted, maxAccepted } = fixture;
  if (accepted.length < minAccepted || accepted.length > maxAccepted) {
    failures.push(
      `Expected ${minAccepted} to ${maxAccepted} accepted actions, got ${accepted.length}.`,
    );
  }

  const commands = new Set(accepted.map(({ command }) => command));
  for (const alternatives of fixture.expectAnyOf) {
    if (!alternatives.some((command) => commands.has(command))) {
      failures.push(`Missing expected command (any of ${alternatives.join(", ")}).`);
    }
  }

  for (const forbidden of fixture.forbid) {
    const folded = forbidden.toLowerCase();
    if (containsForbidden(raw, folded)) {
      failures.push(`Raw reply contains forbidden substring ${JSON.stringify(forbidden)}.`);
    }
    if (containsForbidden(accepted, folded)) {
      failures.push(`Accepted actions contain forbidden substring ${JSON.stringify(forbidden)}.`);
    }
  }

  for (const { command } of accepted) {
    if (!isGrounded(command, fixture.files)) {
      failures.push(`Ungrounded accepted command ${JSON.stringify(command)}.`);
    }
    if (isDangerousCommand(command)) {
      failures.push(`Dangerous accepted command ${JSON.stringify(command)}.`);
    }
  }
  return { pass: failures.length === 0, failures };
}

export function summarizeSamples(results: ReadonlyArray<boolean>) {
  const failedSamples = results.filter((pass) => !pass).length;
  return { samples: results.length, failedSamples, pass: failedSamples * 2 < results.length };
}
