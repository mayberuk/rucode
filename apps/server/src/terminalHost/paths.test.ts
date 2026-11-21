// @effect-diagnostics nodeBuiltinImport:off -- Fixtures need real directory modes, owners and symlinks.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { connectTerminalHost } from "./client.ts";
import {
  prepareTerminalHostDirectory,
  resolveTerminalHostAddress,
  TerminalHostUnavailableError,
} from "./paths.ts";

const address = (overrides: Partial<Parameters<typeof resolveTerminalHostAddress>[0]> = {}) =>
  resolveTerminalHostAddress({
    stateDir: "/home/me/.t3/userdata",
    platform: "linux",
    tempDir: "/var/tmp",
    runtimeDir: undefined,
    userId: 1000,
    joinPath: NodePath.posix.join,
    ...overrides,
  });

const userId = process.getuid?.() ?? 0;

const expectUnavailable = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flip(effect).pipe(
    Effect.map((error) => expect(error).toBeInstanceOf(TerminalHostUnavailableError)),
  );

describe("resolveTerminalHostAddress", () => {
  it("names a per-user directory and a per-state-directory socket", () => {
    const resolved = address();
    expect(resolved.directory).toBe("/var/tmp/rucode-th-1000");
    expect(resolved.socketPath).toMatch(/^\/var\/tmp\/rucode-th-1000\/[0-9a-f]{24}-v1\.sock$/);
  });

  it("separates state directories and users", () => {
    const base = address();
    expect(address({ stateDir: "/home/me/.t3/dev" }).socketPath).not.toBe(base.socketPath);
    expect(address({ stateDir: "/home/me/worktree/.t3" }).socketPath).not.toBe(base.socketPath);
    const otherUser = address({ userId: 1001 });
    expect(otherUser.socketPath).not.toBe(base.socketPath);
    expect(otherUser.directory).toBe("/var/tmp/rucode-th-1001");
  });

  it("prefers the runtime directory on Linux only", () => {
    expect(address({ runtimeDir: "/run/user/1000" }).directory).toBe(
      "/run/user/1000/rucode-th-1000",
    );
    expect(address({ runtimeDir: "" }).directory).toBe("/var/tmp/rucode-th-1000");
    expect(address({ platform: "darwin", runtimeDir: "/run/user/1000" }).directory).toBe(
      "/var/tmp/rucode-th-1000",
    );
  });

  it("falls back to /tmp once the socket path passes the platform limit", () => {
    // The socket name is 32 bytes and "rucode-th-1000" 14, plus three separators.
    const linuxFits = `/${"a".repeat(107 - 32 - 14 - 3)}`;
    expect(address({ tempDir: linuxFits }).socketPath).toHaveLength(107);
    expect(address({ tempDir: linuxFits }).directory).toBe(`${linuxFits}/rucode-th-1000`);
    expect(address({ tempDir: `${linuxFits}a` }).directory).toBe("/tmp/rucode-th-1000");

    const macFits = `/${"a".repeat(103 - 32 - 14 - 3)}`;
    expect(address({ platform: "darwin", tempDir: macFits }).socketPath).toHaveLength(103);
    expect(address({ platform: "darwin", tempDir: macFits }).directory).toBe(
      `${macFits}/rucode-th-1000`,
    );
    expect(address({ platform: "darwin", tempDir: `${macFits}a` }).directory).toBe(
      "/tmp/rucode-th-1000",
    );
  });
});

describe("socket directory checks", () => {
  it.live("creates an owner-only directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-th-paths-" });
      const directory = `${root}/nested/rucode-th-${userId}`;
      yield* prepareTerminalHostDirectory(directory);
      const stat = yield* Effect.promise(() => NodeFSP.lstat(directory));
      expect(stat.mode & 0o777).toBe(0o700);
      expect(stat.uid).toBe(userId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("refuses a symlink, another owner, or group or other access, to bind or connect", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-th-paths-" });
      const real = `${root}/real`;
      yield* Effect.promise(() => NodeFSP.mkdir(real, { mode: 0o700 }));
      const link = `${root}/link`;
      yield* Effect.promise(() => NodeFSP.symlink(real, link));
      const group = `${root}/group`;
      yield* Effect.promise(() => NodeFSP.mkdir(group));
      yield* Effect.promise(() => NodeFSP.chmod(group, 0o750));
      const other = `${root}/other`;
      yield* Effect.promise(() => NodeFSP.mkdir(other));
      yield* Effect.promise(() => NodeFSP.chmod(other, 0o705));

      for (const directory of [link, group, other]) {
        yield* expectUnavailable(prepareTerminalHostDirectory(directory));
        yield* expectUnavailable(Effect.scoped(connectTerminalHost(`${directory}/host-v1.sock`)));
      }
      const groupStat = yield* Effect.promise(() => NodeFSP.lstat(group));
      expect(groupStat.mode & 0o777).toBe(0o750);

      yield* Effect.gen(function* () {
        yield* expectUnavailable(prepareTerminalHostDirectory(real));
        yield* expectUnavailable(Effect.scoped(connectTerminalHost(`${real}/host-v1.sock`)));
      }).pipe(Effect.provideService(HostProcess.UserId, userId + 1));

      yield* prepareTerminalHostDirectory(real);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
