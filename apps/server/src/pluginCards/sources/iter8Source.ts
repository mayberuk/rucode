import { PluginCardError, type PluginCard } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import type {
  PluginCardRef,
  PluginCardSource,
  PluginCardSourceFactory,
  RecognizableCommand,
} from "../core/PluginCardSource.ts";
import { type Iter8Round, readRound } from "./iter8Store.ts";
import { commandSegments, invokes, positionals } from "./shared/commandText.ts";
import { makeDirectoryWatcher } from "./shared/directoryWatcher.ts";
import { runLocalCommand } from "./shared/runLocal.ts";
import { makeUpdatedAtStamper } from "./shared/updatedAtStamper.ts";

const KIND = "iter8.round";
const DB_FILE = "iter8.db";
const CHANGE_DEBOUNCE = Duration.millis(500);
const DONE_TIMEOUT = Duration.seconds(15);
const ANCHOR_TEXT_LIMIT = 60;
const ROUND_ID = /^R\d+$/;
const NOTE_ID = /^N\d+$/;
const OUTPUT_ROUND = /"roundId"\s*:\s*"(R\d+)"|^Round (R\d+)\b/m;
const NO_FLAG_VALUES: ReadonlySet<string> = new Set();

const firstLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");

const toCardData = (round: Iter8Round) => {
  const firstUrl = round.notes.flatMap((note) =>
    note.captureUrl === null ? [] : [note.captureUrl],
  );
  let pagePath: string | null = null;
  for (const url of firstUrl) {
    if (URL.canParse(url)) {
      const parsed = new URL(url);
      pagePath = `${parsed.pathname}${parsed.search}`;
      break;
    }
  }
  return {
    round: Number(round.id.slice(1)),
    page: `http://${round.pageId}.localhost:${round.port}`,
    pagePath,
    notes: round.notes.map((note) => ({
      id: note.id,
      text: note.body,
      state: note.open ? ("open" as const) : ("resolved" as const),
      author: note.author,
      anchor:
        note.anchor === null
          ? null
          : (note.anchor.name ??
            (note.anchor.text === null ? null : note.anchor.text.slice(0, ANCHOR_TEXT_LIMIT))),
    })),
  };
};

export const iter8Source: PluginCardSourceFactory = Effect.gen(function* () {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const environment = yield* HostProcess.Environment;
  const iter8Home = environment.ITER8_HOME;
  const dbDirectory =
    iter8Home === undefined || iter8Home === "" ? path.join(home, ".iter8") : iter8Home;
  const dbPath = path.join(dbDirectory, DB_FILE);

  const watcher = yield* makeDirectoryWatcher({
    debounce: CHANGE_DEBOUNCE,
    accept: (_dir, fileName) => fileName === DB_FILE || fileName === `${DB_FILE}-wal`,
  });
  const stamp = yield* makeUpdatedAtStamper;

  const recognize = (command: RecognizableCommand): ReadonlyArray<PluginCardRef> => {
    const rounds = new Set<string>();
    for (const segment of commandSegments(command.command, command.cwd)) {
      if (!invokes(segment.words, "iter8")) continue;
      const [verb, argument] = positionals(segment.words, NO_FLAG_VALUES);
      if (verb === "show" && argument !== undefined && ROUND_ID.test(argument)) {
        rounds.add(argument);
      } else if (verb === "done" && argument !== undefined && NOTE_ID.test(argument)) {
        const match = command.output === null ? null : OUTPUT_ROUND.exec(command.output);
        const round = match?.[1] ?? match?.[2];
        if (round !== undefined) rounds.add(round);
      }
    }
    return [...rounds].map((key) => ({ kind: KIND, key }));
  };

  const resolve: PluginCardSource["resolve"] = Effect.fn("PluginCards.iter8.resolve")(
    function* (ref) {
      if (ref.kind !== KIND) return null;
      yield* watcher.watch(dbDirectory);
      const round = yield* readRound(dbPath, ref.key);
      if (round === null) return null;
      const data = toCardData(round);
      const actions = data.notes.flatMap((note) =>
        note.state === "open"
          ? [
              {
                id: `reply:${note.id}`,
                label: "Reply",
                type: "message",
                message: `Reply to iter8 note ${note.id} in round R${data.round}.`,
              } as const,
              { id: `resolve:${note.id}`, label: "Resolve", type: "command" } as const,
            ]
          : [],
      );
      const updatedAt = yield* stamp(`${KIND}:${ref.key}`, { actions, data });
      return { kind: KIND, updatedAt, actions, data } as const;
    },
  );

  const runAction = Effect.fn("PluginCards.iter8.runAction")(function* (
    card: PluginCard,
    actionId: string,
  ) {
    const noteId = actionId.startsWith("resolve:") ? actionId.slice("resolve:".length) : null;
    const open =
      card.kind === KIND &&
      noteId !== null &&
      NOTE_ID.test(noteId) &&
      card.data.notes.some((note) => note.id === noteId && note.state === "open");
    if (!open) return yield* new PluginCardError({ reason: "unknown-action" });

    const result = yield* runLocalCommand({
      command: "iter8",
      args: ["done", noteId],
      cwd: home,
      timeout: DONE_TIMEOUT,
    });
    if (result === null) return yield* new PluginCardError({ reason: "unavailable" });
    if (result.exitCode !== 0) {
      const detail = firstLine(result.stderr) ?? firstLine(result.stdout);
      return yield* new PluginCardError({
        reason: "source-failed",
        ...(detail === undefined ? {} : { detail }),
      });
    }
  });

  return {
    id: "iter8",
    recognize,
    resolve,
    changes: watcher.changes,
    runAction,
  } satisfies PluginCardSource;
});
