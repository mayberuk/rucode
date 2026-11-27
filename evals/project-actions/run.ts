#!/usr/bin/env node
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CodexSettings,
  DEFAULT_TEXT_GENERATION_MODEL,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../../apps/server/src/config.ts";
import { gatherProjectActionContext } from "../../apps/server/src/projectActions/ProjectActionContext.ts";
import { acceptProjectActionCandidates } from "../../apps/server/src/projectActions/ProjectActionSuggestionPolicy.ts";
import { makeCodexTextGeneration } from "../../apps/server/src/textGeneration/CodexTextGeneration.ts";
import { projectActionEvaluationCases } from "./cases.ts";
import { gradeCase, summarizeSamples } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: DEFAULT_TEXT_GENERATION_MODEL },
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "3" },
    baseline: { type: "string" },
  },
});
const { out, model } = values;
if (!out || !model?.trim()) throw new Error("Use --out <directory> [--model <configured model>].");
const samples = Number(values.samples);
if (!Number.isSafeInteger(samples) || samples < 1) {
  throw new Error("--samples must be a positive integer.");
}
const requestedCases = new Set(values.case);
for (const id of requestedCases) {
  if (!projectActionEvaluationCases.some((fixture) => fixture.id === id)) {
    throw new Error(`Unknown case id ${JSON.stringify(id)}.`);
  }
}
const fixtures = projectActionEvaluationCases.filter(
  ({ id }) => requestedCases.size === 0 || requestedCases.has(id),
);
const decodeSettings = Schema.decodeUnknownEffect(CodexSettings);
const encodeReport = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeBaseline = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        model: Schema.String,
        sample: Schema.Int,
        pass: Schema.Boolean,
      }),
    ),
  ),
);

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baselineByCase = new Map<string, ReturnType<typeof summarizeSamples>>();
    if (values.baseline !== undefined) {
      const baseline = yield* fs
        .readFileString(values.baseline)
        .pipe(Effect.flatMap(decodeBaseline));
      for (const { id } of fixtures) {
        const previous = baseline.filter((row) => row.id === id && row.model === model);
        if (previous.length === 0) throw new Error(`Baseline is missing ${id} for model ${model}.`);
        baselineByCase.set(id, summarizeSamples(previous.map(({ pass }) => pass)));
      }
    }

    const generation = yield* makeCodexTextGeneration(yield* decodeSettings({}));
    const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model };
    const results = [];
    const cases = [];
    for (const fixture of fixtures) {
      const grades = [];
      for (let sample = 1; sample <= samples; sample += 1) {
        const result = yield* Effect.gen(function* () {
          const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-project-actions-eval-" });
          const projectName = "acme-app";
          const cwd = path.join(temp, projectName);
          yield* fs.makeDirectory(cwd);
          for (const [file, contents] of Object.entries(fixture.files)) {
            yield* fs.writeFileString(path.join(cwd, file), contents);
          }
          const projectContext = yield* gatherProjectActionContext(cwd);
          const outcome = yield* generation
            .generateProjectActions({
              cwd,
              projectName,
              projectContext,
              existingCommands: [],
              modelSelection,
            })
            .pipe(
              Effect.match({
                onFailure: (error) => ({
                  raw: [],
                  accepted: [],
                  pass: false,
                  failures: [`Could not generate actions (${error.detail}).`],
                }),
                onSuccess: ({ actions: raw }) => {
                  const accepted = acceptProjectActionCandidates(raw, []);
                  return { raw, accepted, ...gradeCase(fixture, raw, accepted) };
                },
              }),
            );
          return { id: fixture.id, source: fixture.source, model, sample, ...outcome };
        }).pipe(Effect.scoped);
        grades.push(result.pass);
        results.push(result);
      }
      cases.push({
        id: fixture.id,
        source: fixture.source,
        ...summarizeSamples(grades),
        baseline: baselineByCase.get(fixture.id),
      });
    }

    const passed = cases.filter(({ pass }) => pass).length;
    const pass = passed === cases.length;
    const summary = { model, modelCalls: results.length, pass, cases };
    yield* fs.makeDirectory(out, { recursive: true });
    yield* fs.writeFileString(path.join(out, "results.json"), yield* encodeReport(results));
    yield* fs.writeFileString(path.join(out, "summary.json"), yield* encodeReport(summary));
    yield* Effect.log(`${passed}/${cases.length} cases passed. See ${out} for the results.`);
    if (!pass) process.exitCode = 1;
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-actions-eval-state-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
