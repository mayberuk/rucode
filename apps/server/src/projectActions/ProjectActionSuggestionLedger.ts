import type { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";

const Ledger = Schema.fromJsonString(
  Schema.Struct({ offered: Schema.Record(Schema.String, Schema.DateTimeUtcFromString) }),
);
const decodeLedger = Schema.decodeEffect(Ledger);
const encodeLedger = Schema.encodeEffect(Ledger);

export class ProjectActionSuggestionLedger extends Context.Service<
  ProjectActionSuggestionLedger,
  {
    readonly has: (projectId: ProjectId) => Effect.Effect<boolean>;
    readonly record: (projectId: ProjectId) => Effect.Effect<void>;
  }
>()("t3/projectActions/ProjectActionSuggestionLedger") {}

const make = Effect.fn("ProjectActionSuggestionLedger.make")(function* (ledgerPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const random = yield* SecureRandom.SecureRandom;
  const writes = yield* Semaphore.make(1);
  const read = fs.readFileString(ledgerPath).pipe(
    Effect.flatMap(decodeLedger),
    Effect.orElseSucceed((): typeof Ledger.Type => ({ offered: {} })),
  );

  const has = Effect.fn("ProjectActionSuggestionLedger.has")(function* (projectId: ProjectId) {
    const { offered } = yield* read;
    return Object.hasOwn(offered, projectId);
  });

  const record = Effect.fn("ProjectActionSuggestionLedger.record")(
    function* (projectId: ProjectId) {
      const { offered } = yield* read;
      const now = yield* DateTime.now;
      const contents = yield* encodeLedger({ offered: { ...offered, [projectId]: now } });
      const temporaryPath = `${ledgerPath}.${yield* random.uuidV4()}.tmp`;
      yield* fs
        .writeFileString(temporaryPath, contents, { flag: "wx" })
        .pipe(
          Effect.andThen(fs.rename(temporaryPath, ledgerPath)),
          Effect.ensuring(fs.remove(temporaryPath, { force: true }).pipe(Effect.ignore)),
          Effect.uninterruptible,
        );
    },
    (write, projectId) =>
      writes
        .withPermits(1)(write)
        .pipe(
          Effect.orDie,
          Effect.catchDefect(() =>
            Effect.logWarning("Could not record project action offer.", { projectId }),
          ),
        ),
  );

  return ProjectActionSuggestionLedger.of({ has, record });
});

export const layerAt = (ledgerPath: string) =>
  Layer.effect(ProjectActionSuggestionLedger, make(ledgerPath));

export const layer = Layer.effect(
  ProjectActionSuggestionLedger,
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return yield* make(path.join(stateDir, "project-action-suggestions.json"));
  }),
);
