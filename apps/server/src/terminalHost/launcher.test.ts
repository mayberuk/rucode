// @effect-diagnostics nodeBuiltinImport:off processEnvInEffect:off -- Fixtures need real sockets, a stale socket file, file modes and the live environment.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { connectTerminalHost } from "./client.ts";
import {
  ensureTerminalHost,
  findSystemdRun,
  resolveTerminalHostCommand,
  wrapForSystemdScope,
  type TerminalHostLaunchCommand,
} from "./launcher.ts";
import { prepareTerminalHostDirectory, resolveTerminalHostAddress } from "./paths.ts";

const userId = process.getuid?.() ?? 0;
const binPath = NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url));

describe("resolveTerminalHostCommand", () => {
  it("runs a single executable's own hidden subcommand", () => {
    expect(
      resolveTerminalHostCommand({
        isExecutable: true,
        execPath: "/opt/t3/t3",
        entryPath: undefined,
        fromSource: false,
        stateDir: "/s",
      }),
    ).toEqual({ command: "/opt/t3/t3", args: ["__terminal-host", "--state-dir", "/s"] });
  });

  it("strips types when the entry is source", () => {
    expect(
      resolveTerminalHostCommand({
        isExecutable: false,
        execPath: "/usr/bin/node",
        entryPath: "/repo/apps/server/src/bin.ts",
        fromSource: true,
        stateDir: "/s",
      }),
    ).toEqual({
      command: "/usr/bin/node",
      args: [
        "--experimental-strip-types",
        "/repo/apps/server/src/bin.ts",
        "__terminal-host",
        "--state-dir",
        "/s",
      ],
    });
  });

  it("runs a built entry directly", () => {
    expect(
      resolveTerminalHostCommand({
        isExecutable: false,
        execPath: "/Applications/T3.app/Contents/MacOS/T3",
        entryPath: "/srv/dist/bin.mjs",
        fromSource: false,
        stateDir: "/s",
      }),
    ).toEqual({
      command: "/Applications/T3.app/Contents/MacOS/T3",
      args: ["/srv/dist/bin.mjs", "__terminal-host", "--state-dir", "/s"],
    });
  });

  it("has no command without an entry", () => {
    expect(
      resolveTerminalHostCommand({
        isExecutable: false,
        execPath: "/usr/bin/node",
        entryPath: undefined,
        fromSource: true,
        stateDir: "/s",
      }),
    ).toBeNull();
  });
});

describe("systemd scope", () => {
  const host: TerminalHostLaunchCommand = { command: "/usr/bin/node", args: ["bin.mjs", "x"] };

  it("prefixes a transient user scope when systemd-run is usable", () => {
    expect(
      wrapForSystemdScope(host, { systemdRun: "/usr/bin/systemd-run", unitName: "unit-a" }),
    ).toEqual({
      command: "/usr/bin/systemd-run",
      args: [
        "--user",
        "--scope",
        "--quiet",
        "--collect",
        "--unit=unit-a",
        "--",
        "/usr/bin/node",
        "bin.mjs",
        "x",
      ],
    });
    expect(wrapForSystemdScope(host, { systemdRun: null, unitName: "unit-a" })).toBe(host);
  });

  const withFakeSystemdRun = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-th-launch-" });
    const bin = `${root}/bin`;
    const runtimeDir = `${root}/runtime`;
    yield* fs.makeDirectory(bin);
    yield* fs.makeDirectory(runtimeDir);
    yield* fs.writeFileString(`${bin}/systemd-run`, "#!/bin/sh\n");
    yield* fs.chmod(`${bin}/systemd-run`, 0o755);
    return { root, bin, runtimeDir };
  });

  const find = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv, uid: number | undefined) =>
    findSystemdRun().pipe(
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provideService(HostProcess.Environment, env),
      Effect.provideService(HostProcess.UserId, uid),
    );

  // No real uid this large has a /run/user directory.
  const absentUid = 2_000_000_000;

  it.effect("finds systemd-run only on Linux with a runtime directory", () =>
    Effect.gen(function* () {
      const { root, bin, runtimeDir } = yield* withFakeSystemdRun;
      const env = { PATH: bin, XDG_RUNTIME_DIR: runtimeDir };
      expect(yield* find("linux", env, absentUid)).toBe(`${bin}/systemd-run`);
      expect(yield* find("darwin", env, absentUid)).toBeNull();
      expect(yield* find("linux", { PATH: bin }, absentUid)).toBeNull();
      expect(yield* find("linux", { PATH: bin, XDG_RUNTIME_DIR: "" }, absentUid)).toBeNull();
      expect(
        yield* find("linux", { PATH: bin, XDG_RUNTIME_DIR: `${root}/missing` }, absentUid),
      ).toBeNull();
      expect(yield* find("linux", { PATH: root, XDG_RUNTIME_DIR: runtimeDir }, absentUid)).toBe(
        null,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("ensureTerminalHost", () => {
  const fixture = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-th-launch-" });
    const stateDir = `${root}/state`;
    yield* fs.makeDirectory(stateDir);
    const address = resolveTerminalHostAddress({
      stateDir,
      platform: yield* HostProcess.Platform,
      tempDir: root,
      runtimeDir: root,
      userId,
      joinPath: NodePath.join,
    });
    const command = resolveTerminalHostCommand({
      isExecutable: false,
      execPath: process.execPath,
      entryPath: binPath,
      fromSource: true,
      stateDir,
    });
    assert(command !== null);
    const logPath = `${stateDir}/logs/terminal-host.log`;
    const env = { ...process.env, XDG_RUNTIME_DIR: root, TMPDIR: root };
    const ensure = (input: {
      readonly command: TerminalHostLaunchCommand;
      readonly fallback?: TerminalHostLaunchCommand;
    }) =>
      ensureTerminalHost({ address, logPath, ...input }).pipe(
        Effect.provideService(HostProcess.Environment, env),
        Effect.tap(({ launchedPid }) =>
          launchedPid === null
            ? Effect.void
            : Effect.addFinalizer(() => Effect.sync(() => process.kill(launchedPid, "SIGTERM"))),
        ),
      );
    return { root, stateDir, address, command, logPath, ensure };
  });

  const exitsWith = (code: number, stderr: string): TerminalHostLaunchCommand => ({
    command: process.execPath,
    args: ["-e", `process.stderr.write(${JSON.stringify(`${stderr}\n`)}); process.exit(${code})`],
  });

  it.live("launches a host when none answers and reuses it afterwards", () =>
    Effect.gen(function* () {
      const { address, command, ensure } = yield* fixture;
      const first = yield* ensure({ command });
      expect(first.launchedPid).toEqual(expect.any(Number));

      const second = yield* ensure({ command });
      expect(second.launchedPid).toBeNull();

      const client = yield* connectTerminalHost(address.socketPath);
      expect(client.hostPid).toBe(first.launchedPid);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("replaces a stale socket left by a dead host", () =>
    Effect.gen(function* () {
      const { address, command, ensure } = yield* fixture;
      yield* prepareTerminalHostDirectory(address.directory);
      // Closing a listener unlinks its own path, so leave the socket behind through a hard link.
      const staging = `${address.directory}/stale.tmp`;
      yield* Effect.promise(async () => {
        const server = NodeNet.createServer();
        await new Promise<void>((resolve) => server.listen(staging, resolve));
        await NodeFSP.link(staging, address.socketPath);
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });
      expect((yield* Effect.promise(() => NodeFSP.lstat(address.socketPath))).isSocket()).toBe(
        true,
      );

      const { launchedPid } = yield* ensure({ command });
      expect(launchedPid).toEqual(expect.any(Number));
      const client = yield* connectTerminalHost(address.socketPath);
      expect(client.hostPid).toBe(launchedPid);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("falls back to the unwrapped command when the wrapped one exits before ready", () =>
    Effect.gen(function* () {
      const { address, command, logPath, ensure } = yield* fixture;
      const { launchedPid } = yield* ensure({
        command: exitsWith(1, "no user manager"),
        fallback: command,
      });
      expect(launchedPid).toEqual(expect.any(Number));
      const client = yield* connectTerminalHost(address.socketPath);
      expect(client.hostPid).toBe(launchedPid);
      expect(yield* Effect.promise(() => NodeFSP.readFile(logPath, "utf8"))).toContain(
        "no user manager",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("fails when every launch exits before ready, appending to the log", () =>
    Effect.gen(function* () {
      const { stateDir, logPath, ensure } = yield* fixture;
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(`${stateDir}/logs`);
        await NodeFSP.writeFile(logPath, "earlier run\n");
      });
      const error = yield* Effect.flip(
        ensure({
          command: exitsWith(1, "first attempt"),
          fallback: exitsWith(0, "second attempt"),
        }),
      );
      expect(error._tag).toBe("TerminalHostUnavailableError");
      expect(yield* Effect.promise(() => NodeFSP.readFile(logPath, "utf8"))).toBe(
        "earlier run\nfirst attempt\nsecond attempt\n",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("fails on output other than a ready line and on a missing executable", () =>
    Effect.gen(function* () {
      const { ensure } = yield* fixture;
      const chatty = yield* Effect.flip(
        ensure({ command: { command: process.execPath, args: ["-e", "console.log('hello')"] } }),
      );
      expect(chatty._tag).toBe("TerminalHostUnavailableError");
      const missing = yield* Effect.flip(
        ensure({ command: { command: "/nonexistent/terminal-host", args: [] } }),
      );
      expect(missing._tag).toBe("TerminalHostUnavailableError");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
