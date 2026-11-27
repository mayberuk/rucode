import { describe, expect, it } from "vite-plus/test";

import {
  CLI_RELEASE_CHECKSUMS_FILE,
  CLI_RELEASE_REPOSITORY,
  CLI_RELEASES_PAGE_URL,
  DESKTOP_APP_ARCHIVE_ARCH,
  DESKTOP_APP_ARTIFACT_NAME_TEMPLATE,
  DESKTOP_APP_IDENTITIES,
  DEV_DESKTOP_APP_ARTIFACT_NAME_TEMPLATE,
  RELEASE_SOURCE_GIT_URL,
  cliArchiveFileName,
  cliArchiveTarCommand,
  cliReleaseAssetUrl,
  cliReleaseDownloadBaseUrl,
  desktopAppArchiveFileName,
  desktopAppIdentityOf,
  devBuildCommitOf,
  devBuildVersion,
  isDevBuildVersion,
  newestCliReleaseVersion,
  parseChecksums,
  releaseTag,
} from "./cliRelease.ts";

const commit = "0123456789abcdef0123456789abcdef01234567";
const devVersion = "1.2.3-dev.0123456789abcdef0123456789abcdef01234567";

describe("cliRelease", () => {
  it("publishes release metadata and names matching the fork's artifacts", () => {
    expect(CLI_RELEASE_REPOSITORY).toBe("mayberuk/rucode");
    expect(CLI_RELEASES_PAGE_URL).toBe("https://github.com/mayberuk/rucode/releases");
    expect(RELEASE_SOURCE_GIT_URL).toBe("https://github.com/mayberuk/rucode.git");
    expect(releaseTag("1.2.3")).toBe("v1.2.3");
    expect(releaseTag("2.0.0-preview.20260924.3")).toBe("v2.0.0-preview.20260924.3");
    expect(CLI_RELEASE_CHECKSUMS_FILE).toBe("SHA256SUMS");
    expect(cliArchiveFileName("1.2.3", "linux-x64")).toBe("t3-1.2.3-linux-x64.tar.gz");
    expect(cliArchiveFileName("1.2.3", "darwin-arm64")).toBe("t3-1.2.3-darwin-arm64.tar.gz");
    expect(DESKTOP_APP_ARCHIVE_ARCH).toBe("arm64");
    expect(DESKTOP_APP_ARTIFACT_NAME_TEMPLATE).toBe("T3-Code-${version}-${arch}.${ext}");
    expect(DEV_DESKTOP_APP_ARTIFACT_NAME_TEMPLATE).toBe("T3-Code-Dev-${version}-${arch}.${ext}");
  });

  it.each([
    ["1.2.3", "arm64", "T3-Code-1.2.3-arm64.zip"],
    ["2.0.0", "x64", "T3-Code-2.0.0-x64.zip"],
  ])("names the macOS app archive for %s and %s", (version, arch, fileName) => {
    expect(desktopAppArchiveFileName(version, arch)).toBe(fileName);
  });

  it.each([undefined, "", "   "])("uses the fork with base URL %j", (baseUrl) => {
    expect(cliReleaseDownloadBaseUrl("1.2.3", baseUrl)).toBe(
      "https://github.com/mayberuk/rucode/releases/download/v1.2.3",
    );
    expect(cliReleaseAssetUrl("1.2.3", "t3-1.2.3-linux-x64.tar.gz", baseUrl)).toBe(
      "https://github.com/mayberuk/rucode/releases/download/v1.2.3/t3-1.2.3-linux-x64.tar.gz",
    );
    expect(cliReleaseAssetUrl("1.2.3", CLI_RELEASE_CHECKSUMS_FILE, baseUrl)).toBe(
      "https://github.com/mayberuk/rucode/releases/download/v1.2.3/SHA256SUMS",
    );
  });

  it.each(["https://releases.example.com/builds", "  https://releases.example.com/builds///  "])(
    "uses the supplied release base URL %j",
    (baseUrl) => {
      expect(cliReleaseDownloadBaseUrl("2.0.0", baseUrl)).toBe(
        "https://releases.example.com/builds/v2.0.0",
      );
      expect(cliReleaseAssetUrl("2.0.0", "t3-2.0.0-linux-x64.tar.gz", baseUrl)).toBe(
        "https://releases.example.com/builds/v2.0.0/t3-2.0.0-linux-x64.tar.gz",
      );
      expect(cliReleaseAssetUrl("2.0.0", CLI_RELEASE_CHECKSUMS_FILE, baseUrl)).toBe(
        "https://releases.example.com/builds/v2.0.0/SHA256SUMS",
      );
    },
  );

  it("rejects a malformed release asset base URL", () => {
    expect(() => cliReleaseAssetUrl("1.2.3", "SHA256SUMS", "builds")).toThrow(TypeError);
  });

  it.each([
    ["1.2.3", commit, devVersion],
    ["0.0.0", "0".repeat(40), `0.0.0-dev.${"0".repeat(40)}`],
    ["10.20.30", "f".repeat(40), `10.20.30-dev.${"f".repeat(40)}`],
  ])("round-trips the full Dev commit for %s", (baseVersion, sha, expectedVersion) => {
    const version = devBuildVersion(baseVersion, sha);
    expect(version).toBe(expectedVersion);
    expect(devBuildCommitOf(version)).toBe(sha);
    expect(isDevBuildVersion(version)).toBe(true);
    expect(version).toMatch(
      /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
    );
  });

  it.each([
    ["an empty commit", ""],
    ["a 39-character commit", "a".repeat(39)],
    ["a 41-character commit", "a".repeat(41)],
    ["uppercase hex", `${"a".repeat(39)}A`],
    ["a non-hex character", `${"a".repeat(39)}g`],
    ["a trailing newline", `${commit}\n`],
  ])("rejects %s when creating a Dev version", (_label, sha) => {
    expect(devBuildVersion).toBeTypeOf("function");
    expect(() => devBuildVersion("1.2.3", sha)).toThrow();
  });

  it.each([
    ["an empty version", ""],
    ["a stable version", "1.2.3"],
    ["a different prerelease marker", `1.2.3-nightly.${commit}`],
    ["an uppercase marker", `1.2.3-DEV.${commit}`],
    ["a missing commit separator", `1.2.3-dev${commit}`],
    ["an empty commit", "1.2.3-dev."],
    ["a 39-character commit", `1.2.3-dev.${"a".repeat(39)}`],
    ["a 41-character commit", `1.2.3-dev.${"a".repeat(41)}`],
    ["uppercase hex", `1.2.3-dev.${"a".repeat(39)}A`],
    ["a non-hex character", `1.2.3-dev.${"a".repeat(39)}g`],
    ["an extra prerelease segment", `${devVersion}.extra`],
    ["build metadata", `${devVersion}+build`],
    ["a version tag prefix", `v${devVersion}`],
    ["leading whitespace", ` ${devVersion}`],
    ["a trailing newline", `${devVersion}\n`],
    ["a missing patch number", `1.2-dev.${commit}`],
    ["a nonnumeric major number", `x.2.3-dev.${commit}`],
    ["a nonnumeric minor number", `1.x.3-dev.${commit}`],
    ["a nonnumeric patch number", `1.2.x-dev.${commit}`],
    ["a leading zero in the major number", `01.2.3-dev.${commit}`],
    ["a leading zero in the minor number", `1.02.3-dev.${commit}`],
    ["a leading zero in the patch number", `1.2.03-dev.${commit}`],
    ["a negative major number", `-1.2.3-dev.${commit}`],
  ])("does not recognize %s as a Dev version", (_label, version) => {
    expect(devBuildCommitOf(version)).toBeUndefined();
    expect(isDevBuildVersion(version)).toBe(false);
  });

  it("uses the separate Dev app identity for a Dev version", () => {
    const identity = desktopAppIdentityOf(devVersion);
    expect(identity).toBe(DESKTOP_APP_IDENTITIES.dev);
    expect(identity).toStrictEqual({
      appId: "com.t3tools.t3code.dev",
      productName: "T3 Code Dev",
      t3HomeDirName: ".t3-dev",
    });
  });

  it.each(["1.2.3", "1.2.3-dev.1234567"])("uses the release app identity for %s", (version) => {
    const identity = desktopAppIdentityOf(version);
    expect(identity).toBe(DESKTOP_APP_IDENTITIES.release);
    expect(identity).toStrictEqual({
      appId: "com.t3tools.t3code",
      productName: undefined,
      t3HomeDirName: ".t3",
    });
  });

  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *t3-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("t3-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("t3-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("picks the newest non-draft release on the requested channel", () => {
    const releases = [
      { tag_name: "v1.2.4-preview.20260912.9", draft: true },
      { tag_name: "v1.2.4-preview.20260912.8" },
      { tag_name: "v1.2.4-nightly.20260912.7" },
      { tag_name: "desktop-preview" },
      { tag_name: "v1.2.3" },
      { tag_name: "v1.2.3-nightly.20260911.2" },
    ];
    expect(newestCliReleaseVersion(releases, "preview")).toBe("1.2.4-preview.20260912.8");
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("1.2.4-nightly.20260912.7");
    expect(newestCliReleaseVersion(releases, "stable")).toBe("1.2.3");
    expect(newestCliReleaseVersion([{ tag_name: "v1.2.3" }], "preview")).toBeUndefined();
  });
});
