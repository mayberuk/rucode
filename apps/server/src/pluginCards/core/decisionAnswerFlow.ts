import {
  CommandId,
  MessageId,
  PluginCardError,
  type PluginDecisionAnswerInput,
  type PluginDecisionAnswerResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { decisionAnswerArgs, findQuotedTurn, parseDpError } from "../dispatch/decisionAnswer.ts";
import {
  canonicalDecisionCardId,
  type DispatchDecisionSource,
} from "../dispatch/decisionSource.ts";
import { PluginThreadIndex } from "./PluginThreadIndex.ts";

/** A queued message is written to the transcript only when the active turn ends. */
const QUOTE_DEADLINE = Duration.minutes(15);
const DP_TIMEOUT = Duration.seconds(30);

interface QuotedTurn {
  readonly optionKey: string;
  readonly transcriptPath: string;
  readonly uuid: string;
}

const refuse = (reason: PluginCardError["reason"], detail?: string) =>
  Effect.fail(new PluginCardError(detail === undefined ? { reason } : { reason, detail }));

export const make = Effect.fn("PluginCards.makeDecisionAnswerFlow")(function* (
  decisions: DispatchDecisionSource,
) {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const index = yield* PluginThreadIndex;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Scope.Scope;
  const env = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;

  const claims = new Set<string>();
  // The message an answer already quoted, kept after dp refuses so a retry quotes it again.
  const quoted = new Map<string, QuotedTurn>();
  let sends = 0;

  const failed = (threadId: ThreadId, cardId: string, optionKey: string, error: PluginCardError) =>
    decisions.setProgress(threadId, cardId, {
      optionKey,
      status: "failed",
      reason: error.reason,
      detail: error.detail ?? null,
    });

  const record = Effect.fnUntraced(function* (
    cardId: string,
    decision: { readonly id: string; readonly dir: string },
    dp: string,
    turn: QuotedTurn,
  ) {
    const output = yield* runner
      .run({
        command: dp,
        args: decisionAnswerArgs(
          decision.id,
          turn.optionKey,
          decision.dir,
          turn.transcriptPath,
          turn.uuid,
        ),
        cwd: decision.dir,
        timeout: DP_TIMEOUT,
      })
      .pipe(
        Effect.mapError(
          (cause) => new PluginCardError({ reason: "dp-failed", detail: cause.message, cause }),
        ),
      );
    if (output.code !== 0) return yield* parseDpError(output.stderr, output.code);
    quoted.delete(cardId);
  });

  const awaitQuote = Effect.fnUntraced(function* (
    transcriptPath: string,
    text: string,
    raisedAt: string,
    fromOffset: number,
  ) {
    let offset = fromOffset;
    const scan = Effect.suspend(() => findQuotedTurn(transcriptPath, text, raisedAt, offset)).pipe(
      Effect.tap((found) => Effect.sync(() => void (offset = found.nextOffset))),
      Effect.map((found) => found.uuid),
      Effect.provideService(FileSystem.FileSystem, fs),
    );
    // Scanning once the watcher is installed catches a line written before it was.
    const ready = yield* Queue.unbounded<void>();
    const changes = fs.watch(transcriptPath, {
      onReady: () => Queue.offerUnsafe(ready, undefined),
    });
    const uuid = yield* Stream.merge(Stream.fromQueue(ready), changes).pipe(
      Stream.mapEffect(() => scan),
      Stream.filter((found): found is string => found !== null),
      Stream.runHead,
      Effect.timeoutOption(QUOTE_DEADLINE),
      Effect.map(Option.flatten),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    if (Option.isNone(uuid)) {
      return yield* refuse(
        "message-not-in-transcript",
        "The answer was posted, but it did not appear in the chat's transcript.",
      );
    }
    return uuid.value;
  });

  const startAnswer = Effect.fnUntraced(function* (
    input: PluginDecisionAnswerInput,
    cardId: string,
    reply: Deferred.Deferred<PluginDecisionAnswerResult>,
  ) {
    const { optionKey } = input;
    const found = yield* decisions.findDecision(cardId);
    if (found === null) return yield* refuse("unknown-card");
    const { record: decision, threadId } = found;
    if (threadId !== input.threadId) return yield* refuse("not-this-chat");
    if (decision.state !== "open") return yield* refuse("decision-closed");
    const option = decision.options.find((candidate) => candidate.key === optionKey);
    if (option === undefined) return yield* refuse("unknown-option");
    const transcript = yield* index.claudeTranscript(input.threadId);
    if (transcript === null) return yield* refuse("terminal-only");
    const dp = yield* resolveCommandPath("dp").pipe(
      Effect.provideService(HostProcess.Environment, env),
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provideService(Path.Path, path),
    );
    if (dp === null) return yield* refuse("dp-missing");

    const clearProgress = decisions.setProgress(threadId, cardId, null);
    const finishAnswer = (
      post: Effect.Effect<PluginDecisionAnswerResult, PluginCardError>,
      work: Effect.Effect<void, PluginCardError>,
    ) =>
      post.pipe(
        Effect.tap(() =>
          decisions.setProgress(threadId, cardId, {
            optionKey,
            status: "recording",
            reason: null,
            detail: null,
          }),
        ),
        Effect.tap((result) => Deferred.succeed(reply, result)),
        Effect.andThen(
          work.pipe(
            Effect.matchEffect({
              onSuccess: () => clearProgress,
              onFailure: (error) => failed(threadId, cardId, optionKey, error),
            }),
          ),
        ),
        Effect.onInterrupt(() => clearProgress),
      );

    const earlier = quoted.get(cardId);
    if (
      earlier !== undefined &&
      earlier.optionKey === optionKey &&
      earlier.transcriptPath === transcript.transcriptPath
    ) {
      return yield* finishAnswer(
        Effect.succeed({ delivery: "reused" }),
        record(cardId, decision, dp, earlier),
      );
    }
    quoted.delete(cardId);

    const shell = yield* threadManagement
      .getThreadShell(input.threadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (shell === null) return yield* refuse("not-this-chat");
    const fromOffset = yield* fs.stat(transcript.transcriptPath).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => 0),
    );
    const text = `Decision ${decision.id}: ${option.label} (${option.key})`;
    const attempt = `${yield* Clock.currentTimeMillis}-${++sends}`;
    const post = decisions
      .setProgress(threadId, cardId, {
        optionKey,
        status: "posting",
        reason: null,
        detail: null,
      })
      .pipe(
        Effect.andThen(
          threadManagement.sendToThread({
            projectId: shell.projectId,
            commandId: CommandId.make(`server:plugin-decision:${decision.id}:${attempt}`),
            threadId: input.threadId,
            messageId: MessageId.make(`message:plugin-decision:${decision.id}:${attempt}`),
            text,
            attachments: [],
            mode: "auto",
            createdBy: "user",
            creationSource: "web",
          }),
        ),
        Effect.mapError(
          (cause) => new PluginCardError({ reason: "unavailable", detail: cause.message, cause }),
        ),
        Effect.tapError(() => clearProgress),
        Effect.map((sent): PluginDecisionAnswerResult => ({
          delivery: sent.delivery === "queued" ? "queued" : "started",
        })),
      );
    return yield* finishAnswer(
      post,
      Effect.gen(function* () {
        const uuid = yield* awaitQuote(
          transcript.transcriptPath,
          text,
          decision.raisedAt,
          fromOffset,
        );
        const turn = { optionKey, transcriptPath: transcript.transcriptPath, uuid };
        quoted.set(cardId, turn);
        yield* record(cardId, decision, dp, turn);
      }),
    );
  });

  const answer = Effect.fn("PluginCards.answerDecision")(
    function* (input: PluginDecisionAnswerInput) {
      const cardId = canonicalDecisionCardId(input.cardId, path);
      if (cardId === null) return yield* refuse("unknown-card");
      const reply = yield* Deferred.make<PluginDecisionAnswerResult>();
      const claim = Effect.suspend(() => {
        if (claims.has(cardId)) return refuse("answer-in-progress");
        claims.add(cardId);
        return Effect.void;
      });
      // The send can commit before returning, so a disconnected client must leave its watcher running.
      const worker = yield* Effect.acquireUseRelease(
        claim,
        () => startAnswer(input, cardId, reply),
        () => Effect.sync(() => void claims.delete(cardId)),
      ).pipe(Effect.forkIn(scope));
      const delivery = Deferred.await(reply);
      return yield* Effect.raceFirst(delivery, Fiber.join(worker).pipe(Effect.andThen(delivery)));
    },
    Effect.provideService(FileSystem.FileSystem, fs),
  );

  return { answer };
});
