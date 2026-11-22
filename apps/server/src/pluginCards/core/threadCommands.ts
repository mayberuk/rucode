import type { OrchestrationV2TurnItem, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ProjectionStoreV2 from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import type { RecognizableCommand } from "./PluginCardSource.ts";

type CommandTurnItem = Extract<OrchestrationV2TurnItem, { readonly type: "command_execution" }>;

const TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const satisfies ReadonlyArray<OrchestrationV2TurnItem["status"]>;

const isTerminal = (status: OrchestrationV2TurnItem["status"]) =>
  (TERMINAL_STATUSES as ReadonlyArray<string>).includes(status);

export interface ThreadCommandItem extends RecognizableCommand {
  readonly ordinal: number;
}

export class ThreadCommands extends Context.Service<
  ThreadCommands,
  {
    /** The thread's command items that have finished, with full output. */
    readonly list: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<ThreadCommandItem>>;
    /**
     * `existing` as `list` reads it, and `completed` each command item that finishes after that
     * read began. An item finishing during the read can appear in both.
     */
    readonly follow: (threadId: ThreadId) => Effect.Effect<{
      readonly existing: ReadonlyArray<ThreadCommandItem>;
      readonly completed: Stream.Stream<ThreadCommandItem>;
    }>;
  }
>()("t3/pluginCards/core/threadCommands") {}

const make = Effect.fn("ThreadCommands.make")(function* () {
  const projection = yield* ProjectionStoreV2.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const eventStore = yield* OrchestrationEventStore.OrchestrationEventStore;

  const effectiveCwd = Effect.fnUntraced(function* (threadId: ThreadId) {
    const thread = yield* projection.findThread(threadId);
    if (thread === null || thread.deletedAt !== null) return null;
    if (thread.worktreePath !== null) return thread.worktreePath;
    const project = yield* projects.getShell(thread.projectId);
    return Option.isSome(project) ? project.value.workspaceRoot : null;
  });

  const toCommand = Effect.fnUntraced(function* (item: CommandTurnItem, cwd: string) {
    // Wire-projected items drop long output; the stored item still has it.
    const stored =
      item.outputOmitted === true
        ? yield* projection
            .getTurnItem({ threadId: item.threadId, itemId: item.id })
            .pipe(Effect.orElseSucceed(() => null))
        : item;
    const output = stored?.type === "command_execution" ? (stored.output ?? null) : null;
    return {
      threadId: item.threadId,
      turnItemId: item.id,
      ordinal: item.ordinal,
      command: item.input,
      output,
      exitCode: item.exitCode ?? null,
      cwd,
      completedAt: item.completedAt === null ? null : DateTime.formatIso(item.completedAt),
    } satisfies ThreadCommandItem;
  });

  const readExisting = Effect.fnUntraced(function* (threadId: ThreadId, cwd: string) {
    const records = yield* projection.getThreadRecords(threadId, ["turnItems"], {
      turnItemTypes: ["command_execution"],
      turnItemStatuses: TERMINAL_STATUSES,
    });
    const items = records.turnItems.filter(
      (item): item is CommandTurnItem => item.type === "command_execution",
    );
    return yield* Effect.forEach(items, (item) => toCommand(item, cwd), { concurrency: 8 });
  });

  const listWithCwd = (threadId: ThreadId, cwd: string | null) =>
    cwd === null
      ? Effect.succeed<ReadonlyArray<ThreadCommandItem>>([])
      : readExisting(threadId, cwd).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("plugin cards could not read thread commands", { threadId, cause }),
          ),
          Effect.orElseSucceed((): ReadonlyArray<ThreadCommandItem> => []),
        );

  const readCwd = (threadId: ThreadId) =>
    effectiveCwd(threadId).pipe(Effect.orElseSucceed((): string | null => null));

  const list = Effect.fn("ThreadCommands.list")(function* (threadId: ThreadId) {
    return yield* listWithCwd(threadId, yield* readCwd(threadId));
  });

  const follow = Effect.fn("ThreadCommands.follow")(function* (threadId: ThreadId) {
    const cwd = yield* readCwd(threadId);
    if (cwd === null) {
      return { existing: [], completed: Stream.empty };
    }
    const afterSequence = yield* eventStore.latestAgentSequence(threadId).pipe(Effect.option);
    const existing = yield* listWithCwd(threadId, cwd);
    if (Option.isNone(afterSequence)) return { existing, completed: Stream.empty };
    const completed = threadManagement
      .streamStoredEventsFrom({
        threadId,
        afterSequence: afterSequence.value,
        eventType: "turn-item.updated",
      })
      .pipe(
        Stream.map((stored) =>
          stored.event.type === "turn-item.updated" &&
          stored.event.payload.type === "command_execution" &&
          isTerminal(stored.event.payload.status)
            ? stored.event.payload
            : null,
        ),
        Stream.filter((item): item is CommandTurnItem => item !== null),
        Stream.mapEffect((item) => toCommand(item, cwd)),
        Stream.catchCause((cause) =>
          Stream.fromEffect(
            Effect.logWarning("plugin cards stopped following thread commands", {
              threadId,
              cause,
            }),
          ).pipe(Stream.drain),
        ),
      );
    return { existing, completed };
  });

  return ThreadCommands.of({ list, follow });
});

export const layer = Layer.effect(ThreadCommands, make());
