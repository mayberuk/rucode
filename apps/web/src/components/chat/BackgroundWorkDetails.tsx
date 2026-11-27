import {
  ProviderDriverKind,
  type EnvironmentId,
  type OrchestrationV2PendingBackgroundTask,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import { codexRunThreadId, parseCodexExecCommand } from "@t3tools/shared/codexExecRun";
import { useState } from "react";

import { useQuietThreadShell } from "../../state/entities";
import { InlineButton } from "../ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { CommandOutputPanel, useCommandOutputStreaming } from "./CommandOutputPanel";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { ShellCommandBlock } from "./ShellCommandBlock";

const CODEX_DRIVER = ProviderDriverKind.make("codex");

/**
 * The Codex run a command started and its read-only child thread, once the server has created it.
 * The child's id is derived from the command's item, so no server round trip is needed to look it up.
 */
export function useCodexRun(
  environmentId: EnvironmentId,
  command: {
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId | undefined;
    readonly text: string | undefined;
  } | null,
) {
  const parsed =
    command?.text === undefined || command.itemId === undefined
      ? null
      : parseCodexExecCommand(command.text);
  const childShell = useQuietThreadShell(
    parsed === null || parsed.ephemeral || command === null || command.itemId === undefined
      ? null
      : scopeThreadRef(environmentId, codexRunThreadId(command.threadId, command.itemId)),
  );
  if (parsed === null) return null;
  return {
    ephemeral: parsed.ephemeral,
    child: childShell === null ? null : { threadId: childShell.id, title: childShell.title },
  };
}

function BackgroundTask(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly task: OrchestrationV2PendingBackgroundTask;
  readonly turnItems: ThreadStructure["turnItems"];
  readonly streamsOutput: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onClose: () => void;
}) {
  const { task } = props;
  const [commandOpen, setCommandOpen] = useState(false);
  const item = props.turnItems.findLast((candidate) =>
    task.itemId === undefined
      ? (candidate.nativeItemRef?.nativeId || candidate.id) === task.taskId
      : candidate.id === task.itemId,
  );
  const command = task.command ?? (item?.type === "command_execution" ? item.input : undefined);
  const description = task.description?.trim();
  const itemId = task.itemId ?? (item?.type === "command_execution" ? item.id : undefined);
  const outputThreadId = task.sourceThreadId ?? item?.threadId ?? props.threadId;
  const run = useCodexRun(props.environmentId, {
    threadId: outputThreadId,
    itemId,
    text: command,
  });
  const descriptionTitle = description && description !== command?.trim() ? description : null;
  const title =
    run !== null
      ? (run.child?.title ?? descriptionTitle ?? "Codex run")
      : (descriptionTitle ?? (command ? "Command" : task.kind.replaceAll("_", " ")));
  const childThreadId = task.kind === "subagent" ? task.childThreadId : undefined;
  const commandHidden = run?.child != null && !commandOpen;
  const indent = run === null ? undefined : "ps-6";
  return (
    <section className="space-y-2 text-sm">
      <div className="flex items-baseline justify-between gap-3">
        {run === null ? (
          <h3 className="font-medium">{title}</h3>
        ) : (
          <h3 className="flex min-w-0 items-center gap-2 font-medium">
            <ProviderInstanceIcon
              driverKind={CODEX_DRIVER}
              displayName="Codex"
              className="size-4 self-center"
              iconClassName="size-4"
            />
            <span className="truncate">{title}</span>
          </h3>
        )}
        <span className="shrink-0 text-xs text-muted-foreground">
          {task.awaited ? "Waiting" : "Running"}
        </span>
      </div>
      {run?.child != null ? (
        <div className="flex items-baseline gap-3 ps-6">
          <InlineButton
            aria-label={`Open agent: ${title}`}
            onClick={() => {
              props.onClose();
              props.onOpenThread(run.child!.threadId);
            }}
          >
            Open agent
          </InlineButton>
          <InlineButton
            tone="muted"
            aria-expanded={commandOpen}
            onClick={() => setCommandOpen(!commandOpen)}
          >
            {commandOpen ? "Hide command" : "Show command"}
          </InlineButton>
        </div>
      ) : null}
      {run?.ephemeral ? (
        <p className="ps-6 text-muted-foreground">
          No transcript: this run was started with{" "}
          <span className="whitespace-nowrap">--ephemeral</span>, so Codex wrote no session log.
        </p>
      ) : null}
      {command && !commandHidden ? (
        <div className={indent}>
          <div className="rounded-md border border-border bg-muted/20 p-3 font-mono text-xs whitespace-pre-wrap break-words">
            <ShellCommandBlock command={command} />
          </div>
        </div>
      ) : null}
      {itemId && props.streamsOutput && item?.status === "running" ? (
        <div className="font-mono text-xs whitespace-pre-wrap break-words">
          <CommandOutputPanel
            environmentId={props.environmentId}
            threadId={outputThreadId}
            itemId={itemId}
          />
        </div>
      ) : null}
      {childThreadId ? (
        <InlineButton
          onClick={() => {
            props.onClose();
            props.onOpenThread(childThreadId);
          }}
        >
          Open subagent
        </InlineButton>
      ) : null}
    </section>
  );
}

export function BackgroundWorkDetails(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly turnItems: ThreadStructure["turnItems"];
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const [open, setOpen] = useState(false);
  const streamsOutput = useCommandOutputStreaming(props.environmentId);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<InlineButton />}>Details</DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Background work</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-5">
            {props.tasks.map((task) => (
              <BackgroundTask
                key={task.taskId}
                environmentId={props.environmentId}
                threadId={props.threadId}
                task={task}
                turnItems={props.turnItems}
                streamsOutput={streamsOutput}
                onOpenThread={props.onOpenThread}
                onClose={() => setOpen(false)}
              />
            ))}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
