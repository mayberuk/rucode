import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";

const defaultInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.22",
  appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
  isPackaged: false,
  resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const layerEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.layer({
    ...defaultInput,
    ...overrides,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest(env)),
    ),
  );

const makeEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) => DesktopEnvironment.DesktopEnvironment.pipe(Effect.provide(layerEnvironment(overrides, env)));

describe("DesktopEnvironment", () => {
  it.effect("uses the packaged Windows server sidecar as the backend root", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        platform: "win32",
        isPackaged: true,
        appPath: "/install/resources/app.asar",
        resourcesPath: "/install/resources",
      });

      assert.equal(environment.appRoot, "/install/resources/app.asar");
      assert.equal(environment.serverRoot, "/install/resources/server.asar");
      assert.equal(
        environment.backendEntryPath,
        "/install/resources/server.asar/apps/server/dist/bin.mjs",
      );
      assert.equal(
        environment.clientAssetsDir,
        "/install/resources/server.asar/apps/server/dist/client",
      );
    }),
  );

  it.effect("keeps implicit development state separate from production state", () =>
    Effect.gen(function* () {
      const development = yield* makeEnvironment(
        {},
        { VITE_DEV_SERVER_URL: "http://localhost:5173" },
      );
      const production = yield* makeEnvironment();

      assert.equal(development.stateDir, "/Users/alice/.t3/dev");
      assert.equal(production.stateDir, "/Users/alice/.t3/userdata");
    }),
  );

  describe("packaged Dev build", () => {
    const devVersion = `0.0.22-dev.${"a".repeat(40)}`;
    const packaged = { isPackaged: true, appVersion: devVersion };

    it.effect("labels itself Dev with its own app id and home", () =>
      Effect.gen(function* () {
        const environment = yield* makeEnvironment(packaged);

        assert.equal(environment.branding.stageLabel, "Dev");
        assert.equal(environment.appUserModelId, "com.t3tools.t3code.dev");
        assert.equal(environment.baseDir, "/Users/alice/.t3-dev");
        assert.equal(environment.stateDir, "/Users/alice/.t3-dev/userdata");
      }),
    );

    it.effect("lets T3CODE_HOME override the home folder", () =>
      Effect.gen(function* () {
        const environment = yield* makeEnvironment(packaged, { T3CODE_HOME: "/data/t3" });

        assert.equal(environment.baseDir, "/data/t3");
        assert.equal(environment.stateDir, "/data/t3/userdata");
      }),
    );

    it.effect("falls back to its own home when T3CODE_HOME is blank", () =>
      Effect.gen(function* () {
        const environment = yield* makeEnvironment(packaged, { T3CODE_HOME: "   " });

        assert.equal(environment.baseDir, "/Users/alice/.t3-dev");
      }),
    );

    it.effect("lets the app user model id override win", () =>
      Effect.gen(function* () {
        const environment = yield* makeEnvironment(packaged, {
          T3CODE_DESKTOP_APP_USER_MODEL_ID: "example.override",
        });

        assert.equal(environment.appUserModelId, "example.override");
      }),
    );

    it.effect("treats a version with an abbreviated commit as a release", () =>
      Effect.gen(function* () {
        const environment = yield* makeEnvironment({
          isPackaged: true,
          appVersion: "0.0.22-dev.abc1234",
        });

        assert.equal(environment.baseDir, "/Users/alice/.t3");
        assert.equal(environment.appUserModelId, "com.t3tools.t3code");
        assert.notEqual(environment.branding.stageLabel, "Dev");
      }),
    );
  });

  describe("packaged release build", () => {
    it.effect("keeps the release label, app id and home", () =>
      Effect.gen(function* () {
        const environment = yield* makeEnvironment({ isPackaged: true });

        assert.equal(environment.branding.stageLabel, "Beta");
        assert.equal(environment.appUserModelId, "com.t3tools.t3code");
        assert.equal(environment.baseDir, "/Users/alice/.t3");
        assert.equal(environment.stateDir, "/Users/alice/.t3/userdata");
      }),
    );

    it.effect("lets T3CODE_HOME override the home folder", () =>
      Effect.gen(function* () {
        const environment = yield* makeEnvironment(
          { isPackaged: true },
          { T3CODE_HOME: "/data/t3" },
        );

        assert.equal(environment.baseDir, "/data/t3");
        assert.equal(environment.stateDir, "/data/t3/userdata");
      }),
    );
  });
});
