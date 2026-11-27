import { useAtomValue } from "@effect/atom-react";
import type {
  KeybindingCommand,
  ProjectId,
  ProjectScript,
  EnvironmentId,
} from "@t3tools/contracts";
import { AuthSettingsWriteScope, EnvironmentAuthorizationError } from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  decodeProjectScriptKeybindingRule,
  keybindingValueForCommand,
} from "../../lib/projectScriptKeybindings";
import {
  buildProjectScript,
  commandForProjectScript,
  nextProjectScriptId,
  projectScriptIdFromCommand,
  releaseClaimedRoles,
} from "../../projectScripts";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { suggestProjectActions } from "../../state/projectActions";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useProjects } from "../../state/entities";
import {
  scriptsAfterUndo,
  type ProjectActionSuggestionsController,
} from "../projectActionSuggestions.logic";
import { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** Write script settings before reconciling shortcuts in environment keybindings. */
export function useProjectScriptEditing(input: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject | null;
  readonly scripts: ReadonlyArray<ProjectScript>;
  readonly settings: UnifiedSettings;
}) {
  const { environmentId, project, scripts, settings } = input;
  const allProjects = useProjects();
  const updateProjectScriptSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });
  const removeKeybinding = useAtomCommand(serverEnvironment.removeKeybinding, {
    reportFailure: false,
  });
  const requestSuggestions = useAtomCommand(suggestProjectActions, { reportFailure: false });
  const canSuggest = useAtomValue(suggestProjectActions.permissionAtom(environmentId));
  const available =
    project !== null &&
    canSuggest &&
    resolveProjectSettings(settings, project.id).settings.suggestProjectActions;
  const autoAttempts = useRef(new Set<ProjectId>());
  const pendingSuggestions = useRef(new Set<ProjectId>());
  const [attemptedProjects, setAttemptedProjects] = useState(() => new Set<ProjectId>());
  const [suggestingProjects, setSuggestingProjects] = useState(() => new Set<ProjectId>());
  const persistProjectScripts = async (input: {
    projectId: ProjectId;
    projectCwd: string;
    previousScripts: ReadonlyArray<ProjectScript>;
    nextScripts: ReadonlyArray<ProjectScript>;
    keybinding: NewProjectScriptInput["keybinding"];
    keybindingCommand: KeybindingCommand | null;
  }): Promise<AtomCommandResult<void, unknown>> => {
    const serverConfig = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
    const previousKeybinding = keybindingValueForCommand(
      serverConfig?.keybindings ?? [],
      input.keybindingCommand,
    );
    const isDeletingScript = !input.nextScripts.some(
      (script) => commandForProjectScript(script.id) === input.keybindingCommand,
    );
    const changesKeybinding =
      input.keybinding !== undefined &&
      (input.keybinding?.trim() || null) !== previousKeybinding &&
      (!isDeletingScript || readEnvironmentScope(environmentId, AuthSettingsWriteScope));
    if (changesKeybinding && !readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      return AsyncResult.failure(
        Cause.fail(
          new EnvironmentAuthorizationError({
            requiredScope: AuthSettingsWriteScope,
            message: "This connection cannot change keyboard shortcuts.",
          }),
        ),
      );
    }
    const keybindingRule = changesKeybinding
      ? decodeProjectScriptKeybindingRule({
          keybinding: input.keybinding,
          command: input.keybindingCommand,
        })
      : null;
    const updateResult = mapAtomCommandResult(
      await updateProjectScriptSettings({
        environmentId,
        input: {
          patch:
            serverConfig?.environment.capabilities.projectSettingsOverrides === true
              ? {
                  projectSettingsOverrides: {
                    [input.projectId]: {
                      ...settings.projectSettingsOverrides[input.projectId],
                      defaultProjectScripts: input.nextScripts,
                    },
                  },
                }
              : {
                  projectScriptOverrides: {
                    [input.projectId]: input.nextScripts,
                  },
                },
        },
      }),
      () => undefined,
    );
    if (updateResult._tag === "Failure") {
      return updateResult;
    }

    if (!changesKeybinding) return updateResult;
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      return AsyncResult.failure(
        Cause.fail(
          new EnvironmentAuthorizationError({
            requiredScope: AuthSettingsWriteScope,
            message: isDeletingScript
              ? "The script was deleted, but its keyboard shortcut could not be removed because permission changed."
              : "The script was saved, but this connection can no longer change keyboard shortcuts.",
          }),
        ),
      );
    }

    const scriptId = input.keybindingCommand
      ? projectScriptIdFromCommand(input.keybindingCommand)
      : null;
    if (!keybindingRule && !input.previousScripts.some((script) => script.id === scriptId)) {
      return updateResult;
    }
    const retainedElsewhere =
      !input.nextScripts.some((script) => script.id === scriptId) &&
      (settings.defaultProjectScripts.some((script) => script.id === scriptId) ||
        Object.entries(settings.projectSettingsOverrides).some(
          ([projectId, entry]) =>
            projectId !== input.projectId &&
            entry.defaultProjectScripts?.some((script) => script.id === scriptId),
        ) ||
        allProjects.some(
          (other) =>
            other.environmentId === environmentId &&
            other.id !== input.projectId &&
            resolveProjectScripts(settings, other).some((script) => script.id === scriptId),
        ));
    if (!keybindingRule && retainedElsewhere) return updateResult;

    const previousRules = (serverConfig?.keybindings ?? []).flatMap((binding) => {
      if (binding.command !== input.keybindingCommand || binding.whenAst) return [];
      const previous = decodeProjectScriptKeybindingRule({
        keybinding: keybindingValueForCommand([binding], input.keybindingCommand),
        command: input.keybindingCommand,
      });
      return previous ? [previous] : [];
    });
    const previous = previousRules.at(-1);
    for (const rule of keybindingRule ? previousRules.slice(0, -1) : previousRules) {
      const result = await removeKeybinding({ environmentId, input: rule });
      if (result._tag === "Failure") return mapAtomCommandResult(result, () => undefined);
    }
    return keybindingRule
      ? mapAtomCommandResult(
          await upsertKeybinding({
            environmentId,
            input:
              previous && previous.key !== keybindingRule.key
                ? { ...keybindingRule, replace: previous }
                : keybindingRule,
          }),
          () => undefined,
        )
      : updateResult;
  };
  const saveProjectScript = async (
    input: NewProjectScriptInput,
  ): Promise<AtomCommandResult<void, unknown>> => {
    if (!project) {
      return AsyncResult.success(undefined);
    }
    const nextId = nextProjectScriptId(
      input.name,
      scripts.map((script) => script.id),
    );
    const nextScript = buildProjectScript(nextId, input);
    const nextScripts = [
      ...scripts.map((script) => releaseClaimedRoles(script, input)),
      nextScript,
    ];

    return persistProjectScripts({
      projectId: project.id,
      projectCwd: project.workspaceRoot,
      previousScripts: scripts,
      nextScripts,
      keybinding: input.keybinding,
      keybindingCommand: commandForProjectScript(nextId),
    });
  };
  const updateProjectScript = async (
    scriptId: string,
    input: NewProjectScriptInput,
  ): Promise<AtomCommandResult<void, unknown>> => {
    if (!project) {
      return AsyncResult.success(undefined);
    }
    const existingScript = scripts.find((script) => script.id === scriptId);
    if (!existingScript) {
      return AsyncResult.failure(Cause.fail(new Error("Script not found.")));
    }

    const updatedScript = buildProjectScript(existingScript.id, input);
    const nextScripts = scripts.map((script) =>
      script.id === scriptId ? updatedScript : releaseClaimedRoles(script, input),
    );

    return persistProjectScripts({
      projectId: project.id,
      projectCwd: project.workspaceRoot,
      previousScripts: scripts,
      nextScripts,
      keybinding: input.keybinding,
      keybindingCommand: commandForProjectScript(scriptId),
    });
  };
  const deleteProjectScript = async (
    scriptId: string,
  ): Promise<AtomCommandResult<void, unknown>> => {
    if (!project) {
      return AsyncResult.success(undefined);
    }
    const nextScripts = scripts.filter((script) => script.id !== scriptId);

    const deletedName = scripts.find((s) => s.id === scriptId)?.name;

    const result = await persistProjectScripts({
      projectId: project.id,
      projectCwd: project.workspaceRoot,
      previousScripts: scripts,
      nextScripts,
      keybinding: null,
      keybindingCommand: commandForProjectScript(scriptId),
    });
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: `Deleted action "${deletedName ?? "Unknown"}"`,
      });
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not delete action",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    }
    return result;
  };

  const suggest: ProjectActionSuggestionsController["suggest"] = async (trigger) => {
    if (!project || !available) return { _tag: "Skipped" };
    const projectId = project.id;
    if (
      pendingSuggestions.current.has(projectId) ||
      (trigger === "auto" && autoAttempts.current.has(projectId))
    ) {
      return { _tag: "Skipped" };
    }
    if (trigger === "auto") {
      autoAttempts.current.add(projectId);
      setAttemptedProjects(new Set(autoAttempts.current));
    }
    pendingSuggestions.current.add(projectId);
    setSuggestingProjects(new Set(pendingSuggestions.current));

    const result = await requestSuggestions({
      environmentId,
      input: { projectId, trigger },
    }).finally(() => {
      pendingSuggestions.current.delete(projectId);
      setSuggestingProjects(new Set(pendingSuggestions.current));
    });
    if (result._tag === "Success") {
      if (result.value._tag === "Added") return { ...result.value, projectId };
      return result.value._tag === "Skipped" ? { _tag: "Skipped" } : result.value;
    }
    if (isAtomCommandInterrupted(result)) return { _tag: "Skipped" };
    const error = squashAtomCommandFailure(result);
    return { _tag: "Failed", message: error instanceof Error ? error.message : String(error) };
  };
  const undo: ProjectActionSuggestionsController["undo"] = async (projectId, added) => {
    const target =
      project?.id === projectId
        ? project
        : allProjects.find(
            (other) => other.environmentId === environmentId && other.id === projectId,
          );
    if (!target) return AsyncResult.success(undefined);
    const current = target === project ? scripts : resolveProjectScripts(settings, target);
    return persistProjectScripts({
      projectId,
      projectCwd: target.workspaceRoot,
      previousScripts: current,
      nextScripts: scriptsAfterUndo(current, added),
      keybinding: undefined,
      keybindingCommand: null,
    });
  };
  const projectActionSuggestions: ProjectActionSuggestionsController = {
    available,
    projectId: project?.id ?? null,
    projectName: project?.title ?? null,
    suggesting: project !== null && suggestingProjects.has(project.id),
    autoAttempted: project !== null && attemptedProjects.has(project.id),
    suggest: useStableCallback(suggest),
    undo: useStableCallback(undo),
  };

  return {
    saveProjectScript: useStableCallback(saveProjectScript),
    updateProjectScript: useStableCallback(updateProjectScript),
    deleteProjectScript: useStableCallback(deleteProjectScript),
    projectActionSuggestions,
  };
}
