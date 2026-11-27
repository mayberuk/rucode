import {
  type Iter8CreateNoteInput,
  type Iter8DeleteNoteInput,
  Iter8ReviewError,
  type Iter8ReviewSnapshot,
  type Iter8SendRoundInput,
  type Iter8SendRoundResult,
  type Iter8UpdateNoteInput,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import {
  readPageAccess,
  readReviewSnapshot,
  resolveIter8DbPath,
} from "../pluginCards/sources/iter8Store.ts";
import { makeDirectoryWatcher } from "../pluginCards/sources/shared/directoryWatcher.ts";
import * as Overlay from "./iter8OverlayClient.ts";

export class Iter8Review extends Context.Service<
  Iter8Review,
  {
    readonly subscribe: Stream.Stream<Iter8ReviewSnapshot, Iter8ReviewError>;
    readonly createNote: (input: Iter8CreateNoteInput) => Effect.Effect<void, Iter8ReviewError>;
    readonly updateNote: (input: Iter8UpdateNoteInput) => Effect.Effect<void, Iter8ReviewError>;
    readonly deleteNote: (input: Iter8DeleteNoteInput) => Effect.Effect<void, Iter8ReviewError>;
    readonly sendRound: (
      input: Iter8SendRoundInput,
    ) => Effect.Effect<Iter8SendRoundResult, Iter8ReviewError>;
  }
>()("t3/iter8/Iter8Review") {}

const unavailableError = new Iter8ReviewError({ reason: "unavailable" });

export const unavailable: Iter8Review["Service"] = {
  subscribe: Stream.make({ available: false, sessions: [], pages: [] }),
  createNote: () => Effect.fail(unavailableError),
  updateNote: () => Effect.fail(unavailableError),
  deleteNote: () => Effect.fail(unavailableError),
  sendRound: () => Effect.fail(unavailableError),
};

const make = Effect.fn("Iter8Review.make")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const environment = yield* HostProcess.Environment;
  const dbPath = resolveIter8DbPath(home, environment.ITER8_HOME, path.join);
  const directory = path.dirname(dbPath);
  const dbFile = path.basename(dbPath);
  const read = readReviewSnapshot(dbPath);

  const subscribe = Effect.fn("Iter8Review.subscribe")(function* () {
    const watcher = yield* makeDirectoryWatcher({
      debounce: Duration.millis(500),
      accept: (_dir, file) => file === dbFile || file === `${dbFile}-wal`,
    }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
    // Listen before the initial read so a write during subscription startup is observed.
    const changes = yield* Stream.toPull(watcher.changes);
    yield* watcher.watch(directory);
    return Stream.concat(
      Stream.fromEffect(read),
      Stream.fromPull(Effect.succeed(changes)).pipe(Stream.mapEffect(() => read)),
    ).pipe(Stream.changes);
  });

  const pageAccess = Effect.fn("Iter8Review.pageAccess")(function* (pageId: string) {
    const page = yield* readPageAccess(dbPath, pageId);
    if (page === null) return yield* new Iter8ReviewError({ reason: "unknown-page" });
    return page;
  });

  const createNote = Effect.fn("Iter8Review.createNote")(function* (input: Iter8CreateNoteInput) {
    const page = yield* pageAccess(input.pageId);
    yield* Overlay.createDraft(page, Overlay.draftBodyFromCreateInput(input));
  });

  const updateNote = Effect.fn("Iter8Review.updateNote")(function* (input: Iter8UpdateNoteInput) {
    const page = yield* pageAccess(input.pageId);
    const notes = yield* Overlay.listDrafts(page);
    const note = notes.find(({ id }) => id === input.noteId);
    if (note === undefined) return yield* new Iter8ReviewError({ reason: "unknown-note" });
    yield* Overlay.putDraft(page, note.id, {
      ...note.draft,
      intent: input.intent,
      body: input.body,
    });
  });

  const deleteNote = Effect.fn("Iter8Review.deleteNote")(function* (input: Iter8DeleteNoteInput) {
    const page = yield* pageAccess(input.pageId);
    yield* Overlay.deleteDraft(page, input.noteId);
  });

  const sendRound = Effect.fn("Iter8Review.sendRound")(function* (input: Iter8SendRoundInput) {
    const page = yield* pageAccess(input.pageId);
    const notes = yield* Overlay.listDrafts(page);
    if (notes.length === 0) {
      return yield* new Iter8ReviewError({ reason: "rejected", detail: "no drafts" });
    }
    return yield* Overlay.sendRound(page, {
      idempotencyKey: input.idempotencyKey,
      noteIds: notes.map(({ id }) => id),
      generation: page.generation,
    });
  });

  return Iter8Review.of({
    subscribe: Stream.unwrap(subscribe()),
    createNote,
    updateNote,
    deleteNote,
    sendRound,
  });
});

export const layer = Layer.effect(Iter8Review, make());
