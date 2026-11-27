import type { APIRoute } from "astro";

import { ANDROID_PLAY_STORE_URL, GITHUB_REPOSITORY_URL, IOS_APP_STORE_URL } from "../lib/site";
import { absoluteUrl, SITE_TAGLINE } from "../lib/seo";

// https://llmstxt.org: a plain index that tells AI agents which domain and links are official.
export const GET: APIRoute = () => {
  const body = `# RuCode

> ${SITE_TAGLINE}. RuCode is a free, MIT-licensed fork of upstream T3 Code. It runs Claude Code, Codex, Cursor, OpenCode, Grok, Antigravity, and other coding agents from one desktop and web app.

The t3.codes website, the web app at https://app.t3.codes, the \`t3\` package on npm (\`npx t3@latest\`), the iOS App Store listing, and the Google Play listing belong to upstream T3 Code, not to this fork. RuCode's own source and builds are at https://github.com/mayberuk/rucode.

## RuCode links

- [Source code](https://github.com/mayberuk/rucode): the MIT-licensed repository
- [Releases](https://github.com/mayberuk/rucode/releases): RuCode release builds

## Upstream T3 Code links

- [Download upstream T3 Code](${absoluteUrl("/download")}): macOS, Windows, and Linux installers
- [Web app](https://app.t3.codes): upstream T3 Code's web app
- [Source code](${GITHUB_REPOSITORY_URL}): upstream T3 Code's repository
- [Releases](${GITHUB_REPOSITORY_URL}/releases): upstream T3 Code's release builds and changelogs
- [npm package](https://www.npmjs.com/package/t3): run \`npx t3@latest\`
- [iOS app](${IOS_APP_STORE_URL})
- [Android app](${ANDROID_PLAY_STORE_URL})

## Policies

- [Security policy](${absoluteUrl("/security-policy")})
- [Privacy policy](${absoluteUrl("/privacy-policy")})
- [Terms of service](${absoluteUrl("/terms-of-service")})
`;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
