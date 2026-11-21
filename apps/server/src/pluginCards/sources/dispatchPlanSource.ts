import type { DispatchPlanCardData } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type {
  PluginCardRef,
  PluginCardSource,
  PluginCardSourceFactory,
  RecognizableCommand,
} from "../core/PluginCardSource.ts";
import { commandSegments, invokes, positionals, resolvePath } from "./shared/commandText.ts";
import { makeDirectoryWatcher } from "./shared/directoryWatcher.ts";
import { runLocalJson } from "./shared/runLocal.ts";
import { makeUpdatedAtStamper } from "./shared/updatedAtStamper.ts";

const CARD_KIND = "dispatch.plan";
const CHANGE_DEBOUNCE = Duration.millis(250);
const SPEC_WRITTEN = /^Spec written to:[ \t]*(.+?)[ \t]*$/gm;
const WAVE_LABEL = /^\s*(\d+)\s+of\s+(\d+)\s*$/;
const PLANS_DIR = "/.claude/plans/";
const SPEC_VERBS = new Set(["lint", "phases", "frontmatter"]);
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--wave",
  "--status",
  "--phase",
  "--part",
  "--last-updated",
]);
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["--json"]);

const Frontmatter = Schema.Struct({
  task: Schema.String,
  status: Schema.String,
  wave: Schema.optionalKey(Schema.String),
  initiative: Schema.optionalKey(Schema.String),
  partOf: Schema.optionalKey(Schema.String),
});

const Phases = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    wave: Schema.String,
    tier: Schema.String,
    status: Schema.String,
    risk: Schema.optionalKey(Schema.String),
  }),
);

const unresolvable = (word: string) => word.startsWith("~") || /[$`]/.test(word);

const looksLikeSpec = (word: string) => word.includes("/") || word.includes(".md");

/** A flag dp does not list as taking a value still swallows the next word unless that word names a spec. */
const withoutUnknownFlagValues = (words: ReadonlyArray<string>) => {
  const kept: Array<string> = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === "--") {
      kept.push(...words.slice(index));
      break;
    }
    const next = words[index + 1];
    const unknownFlag =
      word.startsWith("--") &&
      !word.includes("=") &&
      !VALUE_FLAGS.has(word) &&
      !BOOLEAN_FLAGS.has(word);
    if (unknownFlag && next !== undefined && !next.startsWith("-") && !looksLikeSpec(next)) {
      index += 1;
      continue;
    }
    kept.push(word);
  }
  return kept;
};

const specArgument = (words: ReadonlyArray<string>) => {
  if (!invokes(words, "dp")) return null;
  const group = words[1];
  const verb = words[2];
  const matches =
    (group === "spec" && verb !== undefined && SPEC_VERBS.has(verb)) ||
    (group === "wave" && verb === "set") ||
    (group === "phase" && verb === "complete");
  return matches
    ? (positionals(withoutUnknownFlagValues(words.slice(2)), VALUE_FLAGS)[0] ?? null)
    : null;
};

const specPathFor = (cwd: string, argument: string) => {
  if (unresolvable(argument)) return null;
  return looksLikeSpec(argument)
    ? resolvePath(cwd, argument)
    : resolvePath(cwd, `.claude/plans/${argument}.md`);
};

const checkoutOf = (specPath: string, dirname: (path: string) => string) => {
  const cut = specPath.lastIndexOf(PLANS_DIR);
  return cut > 0 ? specPath.slice(0, cut) : dirname(specPath);
};

const parseNumber = (text: string) => {
  const value = Number.parseInt(text, 10);
  return Number.isNaN(value) ? 0 : value;
};

const orNull = (value: string | undefined) => (value === undefined || value === "" ? null : value);

export const dispatchPlanSource: PluginCardSourceFactory = Effect.gen(function* () {
  const path = yield* Path.Path;
  const specs = new Set<string>();
  const dirs = new Map<string, string>();
  const watcher = yield* makeDirectoryWatcher({
    debounce: CHANGE_DEBOUNCE,
    accept: (dir, fileName) => specs.has(path.join(dir, fileName)),
  });
  const stamp = yield* makeUpdatedAtStamper;

  const remember = (refs: Map<string, PluginCardRef>, specPath: string, dir: string) => {
    if (!dirs.has(specPath)) dirs.set(specPath, dir);
    refs.set(specPath, { kind: CARD_KIND, key: specPath });
  };

  const recognize = (command: RecognizableCommand): ReadonlyArray<PluginCardRef> => {
    const refs = new Map<string, PluginCardRef>();
    for (const segment of commandSegments(command.command, command.cwd)) {
      const argument = specArgument(segment.words);
      if (argument === null) continue;
      const specPath = specPathFor(segment.cwd, argument);
      if (specPath !== null) remember(refs, specPath, segment.cwd);
    }
    if (command.output !== null) {
      for (const match of command.output.matchAll(SPEC_WRITTEN)) {
        const written = match[1]!;
        if (unresolvable(written)) continue;
        remember(refs, resolvePath(command.cwd, written), command.cwd);
      }
    }
    return [...refs.values()];
  };

  const resolve: PluginCardSource["resolve"] = Effect.fn("PluginCards.dispatchPlan.resolve")(
    function* (ref) {
      if (ref.kind !== CARD_KIND) return null;
      const specPath = ref.key;
      const dir = dirs.get(specPath) ?? checkoutOf(specPath, path.dirname);
      specs.add(specPath);
      yield* watcher.watch(path.dirname(specPath));

      const [frontmatter, phases] = yield* Effect.all(
        [
          runLocalJson(Frontmatter, {
            command: "dp",
            args: ["spec", "frontmatter", specPath],
            cwd: dir,
          }),
          runLocalJson(Phases, {
            command: "dp",
            args: ["spec", "phases", specPath, "--json"],
            cwd: dir,
          }),
        ],
        { concurrency: 2 },
      );
      if (frontmatter === null || phases === null) {
        yield* Effect.logWarning("dispatch plan could not be read", { specPath });
        return null;
      }

      const rows = phases.map((phase) => ({
        id: phase.id,
        name: phase.name,
        wave: parseNumber(phase.wave),
        tier: phase.tier,
        status: phase.status,
        risk: phase.risk === "high",
      }));
      const label = WAVE_LABEL.exec(frontmatter.wave ?? "");
      const data: DispatchPlanCardData = {
        task: frontmatter.task,
        specPath,
        dir,
        status: frontmatter.status,
        wave:
          label === null
            ? { current: 0, total: Math.max(0, ...rows.map((row) => row.wave)) }
            : { current: Number(label[1]), total: Number(label[2]) },
        phases: rows,
        initiative: orNull(frontmatter.initiative),
        part: orNull(frontmatter.partOf),
      };
      const actions =
        frontmatter.status === "draft"
          ? ([
              {
                id: "request-changes",
                label: "Request changes",
                type: "message",
                message: `I want changes to plan ${data.task} before it runs.`,
              },
              {
                id: "approve",
                label: "Approve",
                type: "message",
                message: `Plan ${data.task} is approved. Go ahead.`,
              },
            ] as const)
          : [];
      const updatedAt = yield* stamp(specPath, { kind: CARD_KIND, actions, data });
      return { kind: CARD_KIND, updatedAt, actions, data } as const;
    },
  );

  return {
    id: "dispatch-plan",
    recognize,
    resolve,
    changes: watcher.changes,
  } satisfies PluginCardSource;
});
