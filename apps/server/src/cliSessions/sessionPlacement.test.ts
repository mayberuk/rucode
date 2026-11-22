import { describe, expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";

import {
  pairSessionIdsIn,
  placeSession,
  type SessionPlacementInput,
  transcriptOrigin,
} from "./sessionPlacement.ts";

const SESSION = "0b7c2a1e-5f3d-4c1a-9e8b-1d2f3a4b5c6d";
const REPO = ProjectId.make("project-repo");

const input = (fields: Partial<SessionPlacementInput>): SessionPlacementInput => ({
  sessionId: SESSION,
  cwd: "/home/someone/dev/repo",
  homeDir: "/home/someone",
  projects: [{ id: REPO, workspaceRoot: "/home/someone/dev/repo" }],
  linkedWorktree: null,
  names: [],
  pairSessionIds: new Set(),
  ...fields,
});

describe("placeSession", () => {
  it("puts a session whose cwd is a project root in that project", () => {
    expect(placeSession(input({}))).toEqual({ _tag: "Project", projectId: REPO, worktree: null });
  });

  it("puts a session in a linked worktree of a project's repository in that project", () => {
    expect(
      placeSession(
        input({
          cwd: "/home/someone/dev/repo-worktrees/fix",
          linkedWorktree: { mainCheckout: "/home/someone/dev/repo", branch: "fix" },
        }),
      ),
    ).toEqual({
      _tag: "Project",
      projectId: REPO,
      worktree: { path: "/home/someone/dev/repo-worktrees/fix", branch: "fix" },
    });
  });

  it("creates a project at a subdirectory of a project root rather than reusing the root", () => {
    expect(placeSession(input({ cwd: "/home/someone/dev/repo/packages/web" }))).toEqual({
      _tag: "NewProject",
      workspaceRoot: "/home/someone/dev/repo/packages/web",
    });
  });

  it("skips sessions under /tmp and outside the home directory", () => {
    expect(placeSession(input({ cwd: "/tmp/x" }))).toEqual({ _tag: "Skip", reason: "temporary" });
    expect(placeSession(input({ cwd: "/srv/build" }))).toEqual({
      _tag: "Skip",
      reason: "outside-home",
    });
  });

  it("skips dispatch pair sessions by name suffix or pair record", () => {
    for (const name of [
      "x-drv",
      "x-driver",
      "rucode-sup",
      "x-super",
      "spring-clean-a-supervisor",
    ]) {
      expect(placeSession(input({ names: [null, name] }))).toEqual({
        _tag: "Skip",
        reason: "pair-session",
      });
    }
    expect(placeSession(input({ names: ["x-drive"] }))._tag).toBe("Project");
    expect(placeSession(input({ pairSessionIds: new Set([SESSION]) }))).toEqual({
      _tag: "Skip",
      reason: "pair-session",
    });
  });
});

describe("pairSessionIdsIn", () => {
  it("finds every session id a pair record names, whatever its shape", () => {
    const record = JSON.stringify({
      driver: { sessionId: SESSION },
      supervisor: "1c8d3b2f-6a4e-4d2b-8f9c-2e3a4b5c6d7e",
      slug: "spring-clean-a",
    });
    expect(pairSessionIdsIn(record)).toEqual([SESSION, "1c8d3b2f-6a4e-4d2b-8f9c-2e3a4b5c6d7e"]);
  });
});

describe("transcriptOrigin", () => {
  const encode = (text: string) => new TextEncoder().encode(text);

  it("reads the entrypoint and cwd of the first record that has an entrypoint", () => {
    const text = [
      JSON.stringify({ type: "custom-title", customTitle: "x" }),
      JSON.stringify({ type: "user", entrypoint: "cli", cwd: "/home/someone/dev/repo" }),
      JSON.stringify({ type: "user", entrypoint: "t3-code", cwd: "/elsewhere" }),
      "",
    ].join("\n");
    expect(transcriptOrigin(encode(text))).toEqual({
      entrypoint: "cli",
      cwd: "/home/someone/dev/repo",
    });
  });

  it("is null when no complete record names an entrypoint", () => {
    expect(transcriptOrigin(encode('{"type":"user","entrypoint":"cli"'))).toBeNull();
  });
});
