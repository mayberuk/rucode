import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { listLiveInitiatives } from "./liveRegistry.ts";

const withParts = {
  slug: "rucode-home",
  repos: [{ root: "/dev/rucode", worktrees: ["/dev/rucode-worktrees/card-core"] }],
  orchestratorSession: "58cc17bd",
  orchestratorCwd: "/dev/rucode",
  orchestratorPid: 630609,
  closed: false,
  totalWave: 2,
  totalRunning: 1,
  totalSettled: 4,
  totalCostUsd: 12.5,
  totalCostState: "incomplete",
  reportedCostUsd: 20,
  orchestratorCostUsd: 7.5,
  started: "2026-11-21T10:00:00-05:00",
  touched: "2026-11-21T11:00:00-05:00",
  liveUntil: "2026-11-21T11:10:00-05:00",
  parts: {
    "card-core": {
      wave: 2,
      running: 1,
      settled: 3,
      costUsd: 9.25,
      costState: "exact",
      costByChild: { "phase-executor:1|1|1792801660": 9.25 },
    },
    "terminal-host": { wave: 1, running: 0, settled: 1, costUsd: 3.25, costState: "estimated" },
  },
};

/** An entry written by an older dp: no orchestrator fields, cost state, repos or parts. */
const withoutParts = {
  slug: "field-notes",
  closed: true,
  totalWave: 0,
  totalRunning: 0,
  totalSettled: 9,
  totalCostUsd: 3,
  reportedCostUsd: 3,
  started: "2026-11-01T10:00:00Z",
  touched: "2026-11-01T11:00:00Z",
  liveUntil: "2026-11-01T11:10:00Z",
};

it.layer(NodeServices.layer)("dispatch live registry", (it) => {
  it.effect("decodes entries with and without parts, skipping unreadable files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dispatch-live-" });
      const live = path.join(root, ".live");
      yield* fs.makeDirectory(live);
      yield* fs.writeFileString(path.join(live, "rucode-home.json"), JSON.stringify(withParts));
      yield* fs.writeFileString(path.join(live, "field-notes.json"), JSON.stringify(withoutParts));
      yield* fs.writeFileString(path.join(live, "broken.json"), "{");
      yield* fs.writeFileString(
        path.join(live, "no-slug.json"),
        JSON.stringify({ ...withoutParts, slug: undefined }),
      );
      yield* fs.writeFileString(path.join(live, "rucode-home.lock"), JSON.stringify(withParts));

      const initiatives = yield* listLiveInitiatives(root);
      assert.deepEqual(initiatives, [withoutParts, withParts]);
    }),
  );

  it.effect("returns no initiatives when the registry directory is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dispatch-live-empty-" });
      assert.deepEqual(yield* listLiveInitiatives(root), []);
    }),
  );
});
