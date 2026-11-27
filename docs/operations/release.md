# Fork releases

## Cutting a release

1. Bump the workspace version. For example, run `node scripts/update-release-package-versions.ts 1.2.3`, then commit and push the version bump.
2. Tag the release commit with `v<version>` and push that tag to the fork. For example, use `git tag v1.2.3` and `git push origin v1.2.3` if `origin` points to the fork.
3. Wait for [`rucode-release.yml`](../../.github/workflows/rucode-release.yml) to finish in GitHub Actions. It builds the tagged commit and creates a draft release with the macOS arm64 zip, the Linux x64 server archive, and `SHA256SUMS`.
4. Open the draft on the fork's Releases page. Review the tag, release notes, and assets, then publish it. Only published releases are available to SSH installs.

## First release

A maintainer must push the first tag and publish the draft by hand. The public fork uses GitHub-hosted runners. No runner setup is required.

## Installing and updating the app

The app has no self-update in this release. A built-in updater is planned as a follow-up.

1. Download the macOS arm64 release zip by hand from the fork's Releases page. Save `SHA256SUMS` from the same release.
2. Run `shasum -a 256 T3-Code-1.2.3-arm64.zip` with the downloaded zip's filename. Compare the result with that file's entry in `SHA256SUMS` and proceed only if the hashes match.
3. Unzip the archive. Quit the app if it's running, then use the new app to replace the existing copy in Applications. For a first install, move the app into Applications.
4. Before the first launch of an unsigned build, run `xattr -dr com.apple.quarantine` followed by the path to the installed app bundle. You can also attempt to open the app and approve it with **Open Anyway** in **System Settings** → **Privacy & Security**.

## Building the Dev app

On an Apple Silicon Mac, check out a commit that has already been pushed to the fork. Replace `<base>` with a version such as `1.2.3` and use the full commit SHA in the Dev version.

```sh
vp run dist:desktop:artifact --platform mac --target zip --arch arm64 --build-version "<base>-dev.$(git rev-parse HEAD)"
```

The Dev app installs alongside the release app and uses `~/.t3-dev` for its data by default.

## SSH remotes

For a published version, the SSH remote downloads the matching server archive from the fork's GitHub releases and checks it against `SHA256SUMS`. The fork ships a Linux x64 server archive. To use a mirror, set `T3CODE_RELEASE_BASE_URL` in the desktop app's environment. The mirror must serve the archive and checksum file under `v<version>/` relative to that base URL.

For a Dev version, the SSH remote fetches and builds the exact commit in the app version. The commit must be pushed to the fork. The remote needs Git, Node matching the checkout's `engines.node` in `package.json` (the runner can find Node through nvm or mise), and network access to the fork and the package registry. The runner installs dependencies, caches the build under `~/.t3/runtime/source/<commit>`, and runs the server from that checkout.

## Upstream steps the fork skips

The fork skips Developer ID signing and notarization so it can ship the Apple Silicon zip without Apple credentials. It also skips npm publishing because SSH installs use the server archive attached to the GitHub release.
