#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import sharp from "sharp";

import {
  BRAND_ASSET_PATHS,
  resolveWebIconOverrides,
  type WebAssetBrand,
} from "./lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const squircle = "assets/prod/rucode-icon.svg";
const square = "assets/prod/rucode-icon-square.svg";
const pixel16 = "assets/prod/rucode-favicon-16.svg";
const pixel32 = "assets/prod/rucode-favicon-32.svg";

interface IconFrame {
  readonly source: string;
  readonly size: number;
}

interface IconOutput {
  readonly path: string;
  readonly frames: readonly [IconFrame, ...IconFrame[]];
}

const favicon16 = { source: pixel16, size: 16 };
const favicon32 = { source: pixel32, size: 32 };
const appSquare = { source: square, size: 1024 };
const appSquircle = { source: squircle, size: 1024 };

const windowsFrames: IconOutput["frames"] = [
  favicon16,
  ...WINDOWS_ICON_SIZES.slice(1).map((size) =>
    size === 32 ? favicon32 : { source: squircle, size },
  ),
];

const webFrames = new Map<string, IconOutput["frames"]>([
  ["favicon.ico", [favicon16, favicon32, { source: squircle, size: 48 }]],
  ["favicon-16x16.png", [favicon16]],
  ["favicon-32x32.png", [favicon32]],
  ["apple-touch-icon.png", [{ source: squircle, size: 180 }]],
  ["icon-192x192.png", [{ source: squircle, size: 192 }]],
  ["icon-512x512.png", [{ source: squircle, size: 512 }]],
]);

function webOutputs(brand: WebAssetBrand, publicDirectory?: string): IconOutput[] {
  return resolveWebIconOverrides(brand, publicDirectory ?? "").map((override) => {
    const filename = override.targetRelativePath.slice(
      override.targetRelativePath.lastIndexOf("/") + 1,
    );
    const frames = webFrames.get(filename);
    if (frames === undefined) {
      throw new Error(`No RuCode icon rendition for ${filename}.`);
    }
    return {
      path: publicDirectory ? override.targetRelativePath : override.sourceRelativePath,
      frames,
    };
  });
}

const assets = BRAND_ASSET_PATHS;

export const RU_CODE_ICON_OUTPUTS: readonly IconOutput[] = [
  { path: assets.productionIosIconPng, frames: [appSquare] },
  { path: assets.productionMacIconPng, frames: [appSquircle] },
  { path: assets.productionLinuxIconPng, frames: [appSquircle] },
  { path: assets.productionWindowsIconIco, frames: windowsFrames },
  ...webOutputs("production"),
  { path: assets.developmentIosIconPng, frames: [appSquare] },
  { path: assets.developmentDesktopIconPng, frames: [appSquircle] },
  { path: assets.developmentUniversalIconPng, frames: [appSquircle] },
  { path: assets.developmentWindowsIconIco, frames: windowsFrames },
  ...webOutputs("development"),
  { path: assets.nightlyIosIconPng, frames: [appSquare] },
  { path: assets.nightlyMacIconPng, frames: [appSquircle] },
  { path: assets.nightlyLinuxIconPng, frames: [appSquircle] },
  { path: assets.nightlyWindowsIconIco, frames: windowsFrames },
  ...webOutputs("nightly"),
  ...webOutputs("development", "apps/web/public"),
  ...webOutputs("production", "apps/marketing/public").filter(
    ({ path }) => !path.includes("/icon-"),
  ),
  { path: "apps/marketing/src/assets/icon.webp", frames: [appSquircle] },
  { path: "apps/marketing/src/assets/icon-nightly.webp", frames: [appSquircle] },
];

class RuCodeIconRenderError extends Schema.TaggedError<RuCodeIconRenderError>()(
  "RuCodeIconRenderError",
  { source: Schema.String, size: Schema.Number, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not render ${this.source} at ${this.size}×${this.size}.`;
  }
}

const writeIcon = Effect.fn("renderRuCodeIcons.writeIcon")(function* (
  outputPath: string,
  contents: Buffer,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(outputPath);
  yield* fs.makeDirectory(directory, { recursive: true });
  const temporary = yield* fs.makeTempFileScoped({ directory, prefix: ".rucode-icon-" });
  yield* fs.writeFile(temporary, contents);
  yield* fs.rename(temporary, outputPath);
}, Effect.scoped);

export const renderRuCodeIcons = Effect.fn("renderRuCodeIcons")(function* (
  repositoryRoot?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = repositoryRoot ?? (yield* path.fromFileUrl(new URL("..", import.meta.url)));
  const cache = new Map<string, Buffer>();

  const render = Effect.fn("renderRuCodeIcons.render")(function* (
    { source, size }: IconFrame,
    format: "png" | "webp",
  ) {
    const key = `${source}:${size}:${format}`;
    const cached = cache.get(key);
    if (cached !== undefined) return { size, contents: cached };

    const svg = yield* fs.readFile(path.join(root, source));
    const contents = yield* Effect.tryPromise({
      try: async () => {
        const image = sharp(svg);
        if (source === squircle && size !== 1024) image.resize(size, size);
        if (source === square) image.removeAlpha();
        const result = await (
          format === "webp" ? image.webp({ lossless: true }) : image.png()
        ).toBuffer({ resolveWithObject: true });
        if (result.info.width !== size || result.info.height !== size) {
          throw new Error(`Rendered ${result.info.width}×${result.info.height}.`);
        }
        return result.data;
      },
      catch: (cause) => new RuCodeIconRenderError({ source, size, cause }),
    });
    cache.set(key, contents);
    return { size, contents };
  });

  const generated = new Map<string, Buffer>();
  for (const output of RU_CODE_ICON_OUTPUTS) {
    if (output.path.endsWith(".ico")) {
      const images = yield* Effect.forEach(output.frames, (frame) => render(frame, "png"));
      generated.set(output.path, encodePngIco(images));
    } else {
      const format = output.path.endsWith(".webp") ? "webp" : "png";
      const image = yield* render(output.frames[0], format);
      generated.set(output.path, image.contents);
    }
  }

  yield* Effect.forEach(
    generated,
    ([outputPath, contents]) => writeIcon(path.join(root, outputPath), contents),
    { discard: true },
  );
  yield* Console.log(`Rendered ${generated.size} RuCode icons.`);
});

if (import.meta.main) {
  renderRuCodeIcons().pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
