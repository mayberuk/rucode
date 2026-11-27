// @effect-diagnostics nodeBuiltinImport:off - plain vitest cases hash and read the committed assets directly.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import sharp from "sharp";
import { assert, expect, it } from "vite-plus/test";

import { renderRuCodeIcons, RU_CODE_ICON_OUTPUTS } from "./render-rucode-icons.ts";

const root = new URL("..", import.meta.url);
const squircle = "assets/prod/rucode-icon.svg";
const square = "assets/prod/rucode-icon-square.svg";
const pixel16 = "assets/prod/rucode-favicon-16.svg";
const pixel32 = "assets/prod/rucode-favicon-32.svg";
const webSizes = [16, 32, 48];
const windowsSizes = [16, 24, 32, 48, 64, 128, 256];

function output(path: string, sizes: number[], largeSource = squircle) {
  return {
    path,
    frames: sizes.map((size) => ({
      size,
      source: size === 16 ? pixel16 : size === 32 ? pixel32 : largeSource,
    })),
  };
}

const expectedOutputs = [
  ...[
    ["assets/prod/black", "assets/prod/t3-black"],
    ["assets/dev/blueprint", "assets/dev/blueprint"],
    ["assets/nightly/nightly", "assets/nightly/nightly"],
  ].flatMap(([app, web]) => [
    output(`${app}-ios-1024.png`, [1024], square),
    output(`${app}-macos-1024.png`, [1024]),
    output(`${app}-universal-1024.png`, [1024]),
    output(`${web}-windows.ico`, windowsSizes),
    output(`${web}-web-favicon.ico`, webSizes),
    output(`${web}-web-favicon-16x16.png`, [16]),
    output(`${web}-web-favicon-32x32.png`, [32]),
    output(`${web}-web-apple-touch-180.png`, [180]),
    output(`${web}-web-icon-192x192.png`, [192]),
    output(`${web}-web-icon-512x512.png`, [512]),
  ]),
  ...["apps/web/public", "apps/marketing/public"].flatMap((directory) => [
    output(`${directory}/favicon.ico`, webSizes),
    output(`${directory}/favicon-16x16.png`, [16]),
    output(`${directory}/favicon-32x32.png`, [32]),
    output(`${directory}/apple-touch-icon.png`, [180]),
  ]),
  output("apps/web/public/icon-192x192.png", [192]),
  output("apps/web/public/icon-512x512.png", [512]),
  output("apps/marketing/src/assets/icon.webp", [1024]),
  output("apps/marketing/src/assets/icon-nightly.webp", [1024]),
];

const byPath = (left: { path: string }, right: { path: string }) =>
  left.path.localeCompare(right.path);
const digest = (contents: Buffer | string) =>
  NodeCrypto.createHash("sha256").update(contents).digest("hex");
const repoFile = (path: string) => NodeFSP.readFile(new URL(path, root));

const decodeRgba = (contents: Buffer) =>
  sharp(contents).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

// Pixels, not encoded bytes: PNG and WebP encoders differ by version. RGB of fully transparent
// pixels is ignored for the same reason.
async function expectSamePixels(path: string, generated: Buffer, committed: Buffer) {
  const [left, right] = await Promise.all([decodeRgba(generated), decodeRgba(committed)]);
  expect(left.info.width, path).toBe(right.info.width);
  expect(left.info.height, path).toBe(right.info.height);
  let mismatches = 0;
  for (let index = 0; index < right.data.length; index += 4) {
    const alpha = right.data[index + 3];
    if (
      left.data[index + 3] !== alpha ||
      (alpha !== 0 &&
        (left.data[index] !== right.data[index] ||
          left.data[index + 1] !== right.data[index + 1] ||
          left.data[index + 2] !== right.data[index + 2]))
    ) {
      mismatches += 1;
    }
  }
  expect(mismatches, path).toBe(0);
}

it("declares each existing output once with the required source and sizes", () => {
  expect(RU_CODE_ICON_OUTPUTS.toSorted(byPath)).toEqual(expectedOutputs.toSorted(byPath));
});

it.each([
  [pixel16, 16, "7c03f3ea8326f53c1fd536c7b6b75986419a1bd1eb5e1de663b8c2ef31109735"],
  [pixel32, 32, "5fbdb6609080a3cff31044c8c6c35f59c159df6e5c064cfc991a9cbbd14c7fa0"],
] as const)("preserves the selected mock's pixel grid in %s", async (path, size, expected) => {
  const svg = (await repoFile(path)).toString();
  expect(svg).toContain(`viewBox="0 0 ${size} ${size}"`);
  expect(svg).toContain('shape-rendering="crispEdges"');
  // Hash the mock's rects so a changed pixel fails even if all outputs are regenerated.
  const rects = svg.match(/<rect\b[^>]*\/>/g)?.join("") ?? "";
  expect(digest(rects.replace(/\s/g, ""))).toBe(expected);
});

it("keeps the one-colour mark and production Composer layer on the selected glyph", async () => {
  const mark = (await repoFile("assets/prod/rucode-mark.svg")).toString();
  const layer = (await repoFile("assets/prod/app-icon.icon/Assets/text.svg")).toString();
  expect(mark).toContain('viewBox="-57 3 760 760"');
  expect(mark).toContain('fill="currentColor"');
  expect(layer).toContain('viewBox="0 0 128 128"');
  for (const svg of [mark, layer]) {
    const glyph = svg.match(/<path\b[^>]*\bd="([^"]+)"/)?.[1] ?? "";
    expect(digest(glyph.replace(/\s/g, ""))).toBe(
      "24ca0c41b7f9041a777bb8a2b3a428d2f5efbc5b2e7e26df99069b5a1c08d32e",
    );
  }
});

it("preserves the selected mock's squircle geometry and artwork", async () => {
  const svg = (await repoFile(squircle)).toString();
  const geometry = svg.match(/<path id="sq"[^>]*\/>/)?.[0] ?? "";
  expect(digest(geometry.replace(/\s/g, ""))).toBe(
    "997f16fcd32b0708f8905765df02375743438b66afbf2a3bd5da3a177fc7c04e",
  );
  const artwork = svg.split("</defs>")[1]?.replace("</svg>", "") ?? "";
  expect(digest(artwork.replace(/\s/g, ""))).toBe(
    "9be68d29d4aa4bd913912795f5f3d4487b57b0146743752a052b790dfc412b18",
  );
  for (const color of ["#2b1d2d", "#1a111b", "#120b13", "#c0135f", "#f6eef4"]) {
    expect(svg).toContain(`stop-color="${color}"`);
  }
});

it("fills the iOS master to all four corners", async () => {
  const stats = await sharp(await repoFile(square))
    .ensureAlpha()
    .stats();
  expect(stats.channels[3]?.min).toBe(255);
});

function icoFrames(contents: Buffer, sizes: number[]) {
  expect(contents.readUInt16LE(0)).toBe(0);
  expect(contents.readUInt16LE(2)).toBe(1);
  expect(contents.readUInt16LE(4)).toBe(sizes.length);
  let nextOffset = 6 + sizes.length * 16;
  const frames = sizes.map((size, index) => {
    const entry = 6 + index * 16;
    expect(contents[entry]).toBe(size === 256 ? 0 : size);
    expect(contents[entry + 1]).toBe(size === 256 ? 0 : size);
    const length = contents.readUInt32LE(entry + 8);
    const offset = contents.readUInt32LE(entry + 12);
    expect(offset).toBe(nextOffset);
    nextOffset += length;
    return contents.subarray(offset, nextOffset);
  });
  expect(nextOffset).toBe(contents.length);
  return frames;
}

it.each(expectedOutputs)("ships $path at its declared size", async ({ path, frames }) => {
  const contents = await repoFile(path);
  const isIco = path.endsWith(".ico");
  const images = isIco
    ? icoFrames(
        contents,
        frames.map(({ size }) => size),
      )
    : [contents];
  for (const [index, { size, source }] of frames.entries()) {
    const frame = images[index];
    assert(frame !== undefined, "expected a frame for each declared size");
    const image = sharp(frame);
    expect(await image.metadata()).toMatchObject({
      width: size,
      height: size,
      format: path.endsWith(".webp") ? "webp" : "png",
      ...(source === square ? { hasAlpha: false } : {}),
    });
    if (source === pixel16 || source === pixel32) {
      const nativeRender = await sharp(await repoFile(source))
        .png()
        .toBuffer();
      expect(digest(frame)).toBe(digest(nativeRender));
    }
  }
});

it.each(["prod/black", "dev/blueprint", "nightly/nightly"])(
  "keeps the 824 px body inset for the %s macOS icon",
  async (channel) => {
    const image = await sharp(await repoFile(`assets/${channel}-macos-1024.png`))
      .ensureAlpha()
      .raw()
      .toBuffer();
    const alpha = (x: number, y: number) => image[(y * 1024 + x) * 4 + 3];
    expect(alpha(0, 0)).toBe(0);
    const inside: ReadonlyArray<readonly [number, number]> = [
      [512, 100],
      [512, 923],
      [100, 512],
      [923, 512],
    ];
    for (const [x, y] of inside) {
      expect(alpha(x, y)).toBe(255);
    }
    const outside: ReadonlyArray<readonly [number, number]> = [
      [512, 99],
      [512, 924],
      [99, 512],
      [924, 512],
    ];
    for (const [x, y] of outside) {
      expect(alpha(x, y)).toBeLessThan(255);
    }
    expect(alpha(512, 944)).toBeGreaterThan(10);
  },
);

const fixture = Effect.fn("renderRuCodeIcons.testFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "render-rucode-icons-" });
  yield* fs.makeDirectory(NodePath.join(directory, "assets/prod"), { recursive: true });
  return directory;
});

effectIt.layer(NodeServices.layer)("renderer", (it) => {
  it.effect("writes every committed asset from the masters and allows overlapping reruns", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fixture();
      for (const source of [squircle, square, pixel16, pixel32]) {
        yield* fs.writeFile(
          NodePath.join(directory, source),
          yield* Effect.promise(() => repoFile(source)),
        );
      }
      yield* renderRuCodeIcons(directory);
      for (const concurrentRun of [false, true]) {
        if (concurrentRun) {
          yield* Effect.all([renderRuCodeIcons(directory), renderRuCodeIcons(directory)], {
            concurrency: 2,
          });
        }
        for (const { path, frames } of expectedOutputs) {
          const generated = Buffer.from(yield* fs.readFile(NodePath.join(directory, path)));
          const committed = yield* Effect.promise(() => repoFile(path));
          const sizes = frames.map(({ size }) => size);
          const generatedFrames = path.endsWith(".ico") ? icoFrames(generated, sizes) : [generated];
          const committedFrames = path.endsWith(".ico") ? icoFrames(committed, sizes) : [committed];
          for (const [index, frame] of generatedFrames.entries()) {
            const expected = committedFrames[index];
            assert(expected !== undefined, "expected a committed frame for each generated frame");
            yield* Effect.promise(() =>
              expectSamePixels(path, Buffer.from(frame), Buffer.from(expected)),
            );
          }
        }
      }
    }),
  );

  it.effect("fails when a required master is missing before replacing outputs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fixture();
      const destination = NodePath.join(directory, "assets/prod/black-ios-1024.png");
      yield* fs.writeFileString(destination, "previous output");
      yield* renderRuCodeIcons(directory).pipe(Effect.flip);
      expect(yield* fs.readFileString(destination)).toBe("previous output");
    }),
  );

  it.effect("fails when a required master cannot be decoded before replacing outputs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fixture();
      for (const source of [squircle, square, pixel16]) {
        yield* fs.writeFile(
          NodePath.join(directory, source),
          yield* Effect.promise(() => repoFile(source)),
        );
      }
      yield* fs.writeFileString(NodePath.join(directory, pixel32), "invalid SVG");
      const destination = NodePath.join(directory, "assets/prod/black-ios-1024.png");
      yield* fs.writeFileString(destination, "previous output");
      yield* renderRuCodeIcons(directory).pipe(Effect.flip);
      expect(yield* fs.readFileString(destination)).toBe("previous output");
    }),
  );
});
