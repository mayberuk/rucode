# Brand icons

The RuCode masters in `prod/` are `rucode-icon.svg` for the squircle, `rucode-icon-square.svg` for iOS, `rucode-mark.svg` for the single-colour glyph, and `rucode-favicon-{16,32}.svg` for the hand-pixelled favicons.
Run `node scripts/render-rucode-icons.ts` from the repository root on Linux to regenerate the tracked icons for all channels, including the 1024×1024 macOS pre-Tahoe PNGs with an 824×824 body.
The production Icon Composer project (`prod/app-icon.icon`) carries the ሩ layer and plum gradient.
`scripts/render-rucode-icons.ts` is the source of truth for the RuCode art on Linux. Besides the files under `assets/`, it also writes `apps/web/public/*`, `apps/marketing/public/*` and `apps/marketing/src/assets/icon*.webp`.
`vp run icons:export` and `vp run icons:check` (macOS only) read the Icon Composer projects in `assets/prod`, `assets/dev` and `assets/nightly`. They cannot reproduce the hand-pixelled 16 and 32 px favicons and still read the T3 `dev` and `nightly` projects, so `icons:check` is not a valid gate for any channel until the renderer stops being the source of truth.
The Android exports below mix RuCode production art with T3 `dev` and `nightly` layers until they are re-exported.
`prod/logo.svg` is still the T3 glyph and nothing references it.
Never hand-edit the generated PNG and ICO files.

## Android launcher and splash artwork

Android masks the central 72dp of a 108dp adaptive canvas, and the Android 12+ splash screen masks
the central two thirds of a 288dp canvas, so the Icon Composer exports cannot be used directly:
their rounded-square silhouette gets framed again and the wordmark is cropped. The Android artwork
is instead rendered from the same Icon Composer SVG sources by `vp run icons:export:android`:

- `apps/mobile/assets/android-icon-foreground.png`: the shared transparent wordmark, sized to stay
  inside the safe zone
- `apps/mobile/assets/android-icon-background-dev.png` and `-nightly.png`: full-bleed variant
  artwork (blueprint grid and annotations; night sky and clouds). Production uses a solid color.
- `apps/mobile/assets/android-splash-icon-*.png`: the two layers composed into one 288dp image, so
  the splash mask reproduces the launcher icon's framing.

Rerun the export after changing a layer SVG. `android-icon-mark.png` remains a flat silhouette for
Android's monochrome themed icon.
