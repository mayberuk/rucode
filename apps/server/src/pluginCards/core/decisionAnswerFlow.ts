import {
  CommandId,
  MessageId,
  PluginCardError,
  type PluginDecisionAnswerInput,
  type PluginDecisionAnswerResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { decisionAnswerArgs, findQuotedTurn, parseDpError } from "../dispatch/decisionAnswer.ts";
import type { DispatchDecisionSource } from "../dispatch/decisionSource.ts";
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

  const claims = new Map<string, object>();
  // The message an answer already quoted, kept after dp refuses so a retry quotes it again.
  const quoted = new Map<string, QuotedTurn>();
  let sends = 0;

  const failed = (cardId: string, optionKey: string, error: PluginCardError) =>
    decisions.setProgress(cardId, {
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
    release: Effect.Effect<void>,
  ) {
    const { cardId, optionKey } = input;
    const found = yield* decisions.findDecision(cardId);
    if (found === null) return yield* refuse("unknown-card");
    const { record: decision, threadId } = found;
    if (decision.state !== "open") return yield* refuse("decision-closed");
    const option = decision.options.find((candidate) => candidate.key === optionKey);
    if (option === undefined) return yield* refuse("unknown-option");
    if (threadId !== input.threadId) return yield* refuse("not-this-chat");
    const transcript = yield* index.claudeTranscript(input.threadId);
    if (transcript === null) return yield* refuse("terminal-only");
    const dp = yield* resolveCommandPath("dp").pipe(
      Effect.provideService(HostProcess.Environment, env),
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provideService(Path.Path, path),
    );
    if (dp === null) return yield* refuse("dp-missing");

    // Released before the final progress, so whoever sees it can answer again at once.
    const background = (work: Effect.Effect<void, PluginCardError>) =>
      work.pipe(
        Effect.matchEffect({
          onSuccess: () => Effect.andThen(release, decisions.setProgress(cardId, null)),
          onFailure: (error) => Effect.andThen(release, failed(cardId, optionKey, error)),
        }),
        Effect.ensuring(release),
        Effect.forkIn(scope),
      );

    const earlier = quoted.get(cardId);
    if (
      earlier !== undefined &&
      earlier.optionKey === optionKey &&
      earlier.transcriptPath === transcript.transcriptPath
    ) {
      yield* decisions.setProgress(cardId, {
        optionKey,
        status: "recording",
        reason: null,
        detail: null,
      });
      yield* background(record(cardId, decision, dp, earlier));
      return { delivery: "reused" } satisfies PluginDecisionAnswerResult;
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
    yield* decisions.setProgress(cardId, {
      optionKey,
      status: "posting",
      reason: null,
      detail: null,
    });
    const sent = yield* threadManagement
      .sendToThread({
        projectId: shell.projectId,
        commandId: CommandId.make(`server:plugin-decision:${decision.id}:${attempt}`),
        threadId: input.threadId,
        messageId: MessageId.make(`message:plugin-decision:${decision.id}:${attempt}`),
        text,
        attachments: [],
        mode: "auto",
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(
        Effect.mapError(
          (cause) => new PluginCardError({ reason: "unavailable", detail: cause.message, cause }),
        ),
        Effect.tapError(() => decisions.setProgress(cardId, null)),
      );
    yield* decisions.setProgress(cardId, {
      optionKey,
      status: "recording",
      reason: null,
      detail: null,
    });
    yield* background(
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
    return {
      delivery: sent.delivery === "queued" ? "queued" : "started",
    } satisfies PluginDecisionAnswerResult;
  });

  const answer = Effect.fn("PluginCards.answerDecision")(
    function* (input: PluginDecisionAnswerInput) {
      const claim = yield* Effect.sync(() => {
        if (claims.has(input.cardId)) return null;
        const token = {};
        claims.set(input.cardId, token);
        return token;
      });
      if (claim === null) return yield* refuse("answer-in-progress");
      const release = Effect.sync(() => {
        if (claims.get(input.cardId) === claim) claims.delete(input.cardId);
      });
      return yield* startAnswer(input, release).pipe(Effect.onError(() => release));
    },
    Effect.provideService(FileSystem.FileSystem, fs),
  );

  return { answer };
});
