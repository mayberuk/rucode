---
name: RuCode
description: A calm, dense desktop-and-web workspace for driving coding agents. This file describes the UI as it ships today.
referenceTheme: t3-chat
# Colours are the app's semantic CSS variables (apps/web/src/index.css, packages/shared/src/themePalettes.ts).
# Values are the computed T3 Chat runtime values: unsuffixed = dark, -light = light.
# Full dumps: .claude/brainstorms/sketches/_app/theme-t3-chat-{dark,light}.css
colors:
  background: "oklch(0.22813 0.020366 307.469)"
  background-light: "oklch(0.982446 0.010114 325.653)"
  foreground: "oklch(0.980735 0.004092 301.426)"
  foreground-light: "oklch(0.325698 0.116116 325.037)"
  sidebar: "oklch(0.185778 0.019368 322.159)"
  sidebar-light: "oklch(0.928886 0.031178 322.592)"
  sidebar-foreground: "oklch(0.967434 0.001326 286.375)"
  sidebar-foreground-light: "oklch(0.396296 0.025134 285.196)"
  sidebar-muted-foreground: "oklch(0.880303 0.03077 342.696)"
  sidebar-muted-foreground-light: "oklch(0.494754 0.190937 354.544)"
  sidebar-row-active: "oklch(0.23366 0.026081 338.196)"
  sidebar-row-active-light: "oklch(0.978851 0.001321 106.424)"
  sidebar-border: "oklch(0.269132 0.030766 351.067)"
  sidebar-border-light: "oklch(0.938313 0.002552 48.717)"
  card: "oklch(0.267101 0.02016 311.799)"
  card-light: "oklch(0.971835 0.012884 321.894)"
  surface-raised: "oklch(0.279864 0.021572 309.532)"
  surface-raised-light: "oklch(0.988235 0.005049 325.615)"
  popover: "oklch(0.154761 0.01316 338.901)"
  popover-light: "oklch(1 0 0)"
  message-surface: "oklch(0.273791 0.025541 309.079)"
  message-surface-light: "oklch(0.926746 0.037898 332.6)"
  message-foreground: "oklch(0.949872 0.021269 306.838)"
  message-foreground-light: "oklch(0.354591 0.093575 307.568)"
  primary: "oklch(0.460685 0.185347 4.099)"
  primary-light: "oklch(0.591646 0.217985 0.584)"
  primary-foreground: "oklch(0.901233 0.057189 343.694)"
  primary-foreground-light: "oklch(1 0 0)"
  secondary: "oklch(0.313674 0.030572 310.061)"
  secondary-light: "oklch(0.869588 0.06751 334.899)"
  secondary-foreground: "oklch(0.848252 0.038248 307.961)"
  secondary-foreground-light: "oklch(0.444777 0.134061 324.799)"
  muted: "oklch(0.360924 0.021469 316.83)"
  muted-light: "oklch(0.802407 0.090963 345.892)"
  muted-foreground: "oklch(0.880303 0.03077 342.696)"
  muted-foreground-light: "oklch(0.428932 0.163929 354.332)"
  secondary-label: "oklch(0.880303 0.03077 342.696)"
  secondary-label-light: "oklch(0.494754 0.190937 354.544)"
  placeholder: "oklch(0.657087 0.028226 307.985)"
  placeholder-light: "oklch(0.549927 0.090215 323.149)"
  accent: "oklch(0.364912 0.050794 308.491)"
  accent-light: "oklch(0.939552 0.024286 321.664)"
  accent-foreground: "oklch(0.964695 0.009139 341.803)"
  accent-foreground-light: "oklch(0.396296 0.025134 285.196)"
  border: "oklch(0.266943 0.015262 302.425)"
  border-light: "oklch(0.923531 0.021247 328.096)"
  input: "oklch(0.266817 0.02897 344.461)"
  input-light: "oklch(0.851713 0.055822 336.6)"
  ring: "oklch(0.591646 0.217985 0.584)"
  code-background: "oklch(0.22813 0.020366 307.469)"
  code-background-light: "oklch(0.953855 0.019695 315.668)"
  code-foreground: "oklch(0.848703 0.064239 306.645)"
  code-foreground-light: "oklch(0.445128 0.13005 307.026)"
  destructive: "oklch(0.458704 0.169677 3.815)"
  destructive-light: "oklch(0.627117 0.248974 7.734)"
  warning: "oklch(0.76859 0.164659 70.08)"
  success: "oklch(69.6% 0.17 162.48)"
  info: "oklch(62.3% 0.214 259.815)"
  info-foreground: "oklch(70.7% 0.165 254.624)"
  info-foreground-light: "oklch(48.8% 0.243 264.376)"
  composer-outline: "#241e28"
typography:
  interface:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Inter Variable", "Segoe UI", system-ui, sans-serif'
    fontSize: "16px"
    lineHeight: "24px"
    fontWeight: 400
  chat-body:
    fontFamily: "{typography.interface.fontFamily}"
    fontSize: "14px"
    lineHeight: "22.75px"
    fontWeight: 400
  chat-heading:
    fontFamily: "{typography.interface.fontFamily}"
    fontSize: "18px"
    lineHeight: "23.4px"
    fontWeight: 600
  dialog-title:
    fontFamily: "{typography.interface.fontFamily}"
    fontSize: "20px"
    lineHeight: 1.375
    fontWeight: 600
  row-title:
    fontFamily: "{typography.interface.fontFamily}"
    fontSize: "14px"
    lineHeight: "20px"
    fontWeight: 400
  control-label:
    fontFamily: "{typography.interface.fontFamily}"
    fontSize: "14px"
    lineHeight: "20px"
    fontWeight: 500
  meta:
    fontFamily: "{typography.interface.fontFamily}"
    fontSize: "12px"
    lineHeight: "16px"
    fontWeight: 400
  meta-2xs:
    fontFamily: "{typography.interface.fontFamily}"
    fontSize: "11px"
    lineHeight: "16px"
  meta-3xs:
    fontFamily: "{typography.interface.fontFamily}"
    fontSize: "10px"
    lineHeight: "14px"
  code:
    fontFamily: 'ui-monospace, "SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace'
    fontSize: "13px"
    lineHeight: "17.875px"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  control: "8px"
  xl: "12px"
  2xl: "16px"
  full: "9999px"
spacing:
  sidebar-content-inset: "8px"
  sidebar-row-content-inset: "10px"
  sidebar-control-gap: "8px"
  floating-content-inset: "12px"
  command-content-inset: "16px"
  workspace-gutter: "20px"
  sidebar-width: "256px"
  topbar-height: "52px"
  chat-content-max-width: "736px"
  thread-details-panel-width: "280px"
components:
  button-default:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.control}"
    height: "32px"
    padding: "0 11px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
    height: "32px"
  button-ghost-hover:
    backgroundColor: "{colors.accent}"
  button-icon-sm:
    size: "28px"
    rounded: "{rounded.control}"
  sidebar-thread-row:
    backgroundColor: "transparent"
    textColor: "{colors.sidebar-muted-foreground}"
    rounded: "{rounded.md}"
    padding: "8px 10px"
    height: "60px"
  sidebar-thread-row-selected:
    backgroundColor: "{colors.sidebar-row-active}"
    textColor: "{colors.sidebar-foreground}"
  sidebar-group-header:
    textColor: "{colors.sidebar-muted-foreground}"
    typography: "{typography.meta}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 8px"
  sidebar-nav-row:
    textColor: "{colors.sidebar-muted-foreground}"
    typography: "{typography.row-title}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 10px"
  user-message:
    backgroundColor: "{colors.message-surface}"
    textColor: "{colors.message-foreground}"
    typography: "{typography.chat-body}"
    rounded: "{rounded.2xl}"
    padding: "12px"
  composer:
    backgroundColor: "{colors.surface-raised}"
    rounded: "{rounded.2xl}"
    width: "736px"
  menu-item:
    textColor: "{colors.foreground}"
    typography: "{typography.control-label}"
    rounded: "{rounded.sm}"
    height: "28px"
    padding: "4px 8px"
  menu-item-highlighted:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-foreground}"
  tooltip:
    backgroundColor: "{colors.popover}"
    textColor: "{colors.foreground}"
    typography: "{typography.meta}"
    rounded: "{rounded.md}"
    padding: "4px 8px"
  badge-info:
    backgroundColor: "color-mix(in srgb, {colors.info} 16%, transparent)"
    textColor: "{colors.info-foreground}"
    rounded: "{rounded.sm}"
    height: "18px"
    padding: "0 3px"
  dialog:
    rounded: "{rounded.2xl}"
    width: "512px"
  code-block:
    backgroundColor: "{colors.code-background}"
    textColor: "{colors.code-foreground}"
    rounded: "{rounded.lg}"
---

# Design System: RuCode

Every value below was read from the code or measured in the running dev app (port 5733, viewport 1440x900, T3 Chat theme) on 2026-11-26. Reference captures: `.claude/brainstorms/sketches/_app/refs/` (index in its `README.md`). Runtime variable dumps: `.claude/brainstorms/sketches/_app/theme-t3-chat-dark.css` and `theme-t3-chat-light.css`; link one of them after `rucode-app.css` and set `<html class="dark" data-theme-id="t3-chat">` (or no class for light) to render a static mock with the real values.

## Overview

**Creative North Star: "The Quiet Workbench"**

RuCode is a tool people sit in all day while agents work. The surface stays out of the way: one canvas colour, a slightly different sidebar tone, text in three weights of emphasis, and almost no chrome. Everything is a row. Threads, waves, menu items, tool calls, details-panel entries and board items are all single-line or two-line rows 28 to 36px tall, separated by space, not boxes. Density is high and even; nothing is set large except the rare 18px markdown heading.

Colour is carried by the theme, never by the component. A component names a semantic variable (`bg-sidebar`, `text-muted-foreground`, `border-input`), and the theme decides what that means. In T3 Chat that means plum-tinted neutrals and one magenta accent; in Grove, Ocean, Ember or Iris the same component renders in that theme's palette. Depth comes from tone first and from glass only for things that float above the page (menus, dialogs, the composer, the details card). There are no cards-in-a-grid layouts, no stat tiles and no decorative colour.

Personality: calm, precise, quiet. The UI reports state truthfully and in small type; it does not celebrate, decorate or shout.

**Key Characteristics:**

- Row-based everything: 32px controls, 36px nav rows, 60 to 78px two/three-line thread rows, 28px menu items.
- Semantic theme variables only; T3 Chat is the reference rendering, every theme must keep working.
- 14px chat text at 22.75px line height in a 736px column; 12px meta text; 16px interface base.
- Flat tonal layers at rest; glass (blur 16px dark / 12px light, 80% opacity) only on floating surfaces.
- Radii from one scale: 4 / 6 / 8 / 12 / 16px, 8px for every control (`--control-radius`).
- Lucide icons at 16px with stroke 1.75.
- Motion is 100 to 200ms, mostly 150ms ease-out; nothing repaints continuously.

## Colors

The palette is two neutrals (canvas, sidebar) plus tinted text levels and a single accent, all defined per theme. T3 Chat tints every neutral plum (hue 300 to 345 in OKLCH) and uses magenta (hue ~0 to 4) as the only accent.

Tokens are applied through Tailwind's semantic names (`apps/web/src/index.css` `@theme inline`): `--color-foreground: var(--contrast-foreground)` and so on. The `--contrast-*` variants mix in the user's Settings > Appearance contrast slider (default 100%, which leaves the base value unchanged), so components use the Tailwind name (`text-foreground`, `border-border`) and never the raw `--foreground`. Themes are set at runtime by `apps/web/src/hooks/useTheme.ts` from `packages/shared/src/themePalettes.ts`: it writes `--app-theme-*` variables, and `index.css` maps them onto the semantic names. `[data-app-sidebar]` re-maps the same names to the sidebar palette, so a component inside the sidebar uses the same classes and gets sidebar colours.

### Primary

- **Magenta Accent** (`--primary`; dark `oklch(0.460685 0.185347 4.099)`, light `oklch(0.591646 0.217985 0.584)`): default `Button`, the composer send button, slider fills, the selected theme outline in Settings. Foreground on it: `--primary-foreground`.
- **Focus Magenta** (`--ring`, `oklch(0.591646 0.217985 0.584)` in both modes): focus rings only.

### Neutral

- **Canvas** (`--background`; dark `oklch(0.22813 0.020366 307.469)`, light `oklch(0.982446 0.010114 325.653)`): page, chat column, top bar (`--toolbar-background` equals it), code blocks in dark (`--code-background` equals canvas in dark).
- **Sidebar Plum** (`--sidebar`; dark `oklch(0.185778 0.019368 322.159)`, darker than canvas; light `oklch(0.928886 0.031178 322.592)`, pinker than canvas): the left sidebar and the settings nav.
- **Row Highlight** (`--sidebar-row-hover` / `-active` / `-selected`, all equal in T3 Chat; dark `oklch(0.23366 0.026081 338.196)`, light `oklch(0.978851 0.001321 106.424)`): hovered and selected sidebar rows. In light the selected row also gets `ring-1 ring-inset ring-sidebar-border/70`.
- **Raised Surface** (`--surface-raised`; dark `oklch(0.279864 0.021572 309.532)`, light `oklch(0.988235 0.005049 325.615)`): composer glass base, composer banners.
- **Card** (`--card`; dark `oklch(0.267101 0.02016 311.799)`): card surfaces.
- **Popover** (`--popover`; dark `oklch(0.154761 0.01316 338.901)`, light white): tooltips, menu glass base.
- **Message Surface** (`--message-surface`; dark `oklch(0.273791 0.025541 309.079)`, light `oklch(0.926746 0.037898 332.6)`): the user's chat bubble; in T3 Chat light also inline code.
- **Accent Wash** (`--accent`; dark `oklch(0.364912 0.050794 308.491)`, light `oklch(0.939552 0.024286 321.664)`): ghost-button hover, highlighted menu and command items, pressed header toggles.
- **Text levels**: `--foreground` (titles, body; assistant markdown renders at 90% opacity), `--muted-foreground` / `--secondary-label` (meta, labels, "Worked for", timestamps; dark `oklch(0.880303 0.03077 342.696)`), `--placeholder` (empty inputs), `--icon-muted`.
- **Lines**: `--border` (dark `oklch(0.266943 0.015262 302.425)`), `--input` (control borders), `--sidebar-border` (the sidebar's right edge; T3 Chat keeps it pink in dark on purpose, see `index.css` "T3 Chat's panel divider is deliberately pink").

### Status

- `--success`, `--warning`, `--info`, `--destructive` and their `-foreground` pairs. They appear as text colour or as an 8% (light) / 16% (dark) tint behind text (`Badge` variants `success`, `warning`, `info`, `error`), never as solid fills except the destructive button.

### Named Rules

**The Theme Owns Colour Rule.** A component never contains a colour literal. It names a semantic class; the five built-in themes and user themes supply the value. The only theme-specific literals in components are T3 Chat's composer outline `#241e28` and highlight `#432d48` in `chat/ComposerSurface.tsx`, and they live inside a `[data-theme-id=t3-chat]` selector.

**The One Accent Rule.** `--primary` marks the single next action (send, the default button). Status colours mark state. Nothing else is coloured.

## Typography

**Interface font:** `-apple-system, BlinkMacSystemFont, "Inter Variable", "Segoe UI", system-ui, sans-serif` (`--font-sans`; renders as SF Pro on macOS).
**Mono font:** `ui-monospace, "SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace` (`--font-mono`).

Both stacks are variables so Settings > Appearance can override them at runtime; use `font-sans` / `font-mono`, never a literal family. The interface size setting defaults to 16px and code to 13px (`--font-size-code`); the prompt is `--font-size-prompt` 0.875rem (14px).

**Character:** system UI type, regular weight for content, medium (500) for anything clickable or labelling, semibold (600) only for markdown headings and dialog titles. No display type, no uppercase, no letter-spacing tricks (command shortcuts use `tracking-widest` on `kbd` only).

### Hierarchy (measured)

- **Dialog title** (600, 20px `text-xl`, `leading-snug`): `DialogTitle` in `components/ui/dialog.tsx`.
- **Markdown heading** (600, 18px / 23.4px, 8px bottom margin): headings inside assistant messages.
- **Page title** (500, 14px / 20px): e.g. "Board" in the top bar, thread title in the breadcrumb.
- **Chat body** (400, 14px / 22.75px, `text-sm leading-relaxed`): user bubble, assistant markdown, list items, table cells, "Worked for", tool-call rows, composer text.
- **Row title** (400, 14px / 20px): sidebar thread title (`text-foreground/75`, full `text-foreground` on hover or when selected), wave row label.
- **Control label** (500, 14px / 20px on `sm:` screens; 16px below): buttons, menu items, command items, settings nav.
- **Details row** (500, 13px / 19.5px): rows in the thread details card.
- **Meta** (400 or 500, 12px / 16px `text-xs`): sidebar project name and status ("Done", "In terminal", "10d"), group headers (500), tooltips, table heads on the board, badges.
- **Dense meta** (`text-2xs` 11px, `text-3xs` 10px, defined in `index.css`): counters, "updated 14d ago" on the board, keyboard hints. `text-4xs` 8px and `text-5xs` 7px exist only for provider icon overlays.
- **Code** (mono, 13px / 17.875px in blocks; inline code 0.85em with 4px radius and a 10% foreground tint, or `--message-surface` in T3 Chat light).

### Named Rules

**The Three-Level Text Rule.** Emphasis is expressed with `text-foreground`, `text-muted-foreground` / `text-secondary-label`, and opacity steps (`/80`, `/75`), not with size jumps or colour.

## Elevation

Flat by default, tonal layering for structure, glass for anything that floats. There is no shadow on rows, panels or the chat column. Structure comes from the sidebar being a different tone than the canvas and from 1px `border-border` lines. The app body carries a faint grain (`--surface-grain`, 128px tile at 2.745% opacity in T3 Chat) baked into each surface's background; surfaces that float over the body opt in with the `surface-grain` utility.

### Shadow and glass vocabulary (from `apps/web/src/index.css` and `components/ui`)

- **dialog-glass** (dialogs, command palette): `background: color-mix(in srgb, var(--background) var(--glass-opacity), transparent)` with `backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation))`. Light: border `--contrast-foreground` 10%, `box-shadow: 0 24px 64px -24px rgb(0 0 0 / 65%)`. Dark: border white 8%, `box-shadow: inset 0 1px rgb(255 255 255 / 4%), 0 24px 72px -20px rgb(0 0 0 / 90%)`. `--glass-opacity` 80% (user setting), `--glass-blur` 12px light / 16px dark, `--glass-saturation` 1.14 light / 1.08 dark.
- **dialog-backdrop**: canvas at 60% (light) / 64% (dark), `blur(4px)`.
- **dropdown-glass** (menus, the thread details card, context menu): popover mixed to the glass opacity plus the same blur, `1px solid` foreground at 10%. Menu popups add `shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)]`, dark `0_18px_44px_-18px_rgb(0_0_0/80%)`.
- **Composer**: `--shadow-composer: 0 1px 2px rgb(0 0 0 / 5%)` in light, none in dark; a 1px outline in `--chat-composer-outline` (`--app-theme-toolbar-border` for themes, `#241e28` for T3 Chat dark) with a 1px inset top highlight in dark. Attached banners use `--shadow-composer-dark: 0 14px 32px -18px rgb(0 0 0 / 75%)` in dark.
- **Controls**: default/destructive buttons `shadow-xs` plus `inset 0 1px rgb(255 255 255 / 16%)` highlight, `inset 0 1px rgb(0 0 0 / 8%)` when pressed; outline buttons and inputs `shadow-xs/5` with a 1px inner top/bottom line (black 4% light, white 6% dark).
- **Tooltip**: `--popover` fill, 1px border, `shadow-md/5`, 1px inner line like controls.

### Shape

One radius scale derived from `--radius: 0.5rem`: `rounded-sm` 4px (menu and command items, inline code, badges, kbd), `rounded-md` 6px (sidebar rows, tooltips, board rows), `rounded-lg` / `--control-radius` 8px (buttons, inputs, toggles, code blocks, menu popups, header toggles, details rows), `rounded-xl` 12px (settings theme cards), `rounded-2xl` 16px (dialogs, settings dialog, command palette, composer, user bubble, details card), `rounded-full` (send button, pill sizes). Borders are always 1px.

### Named Rules

**The Glass-Floats-Only Rule.** Glass (`dialog-glass`, `dropdown-glass`, `surface-glass`, the composer) is reserved for surfaces above the page. In-page content never gets blur, gradient or a drop shadow.

**The Quiet Motion Rule.** From AGENTS.md "Taste": no continuously repainting animations; they peg the GPU on high-refresh displays. The few loops that exist are duty-cycled with stepped timing and pause off-screen: `animate-skeleton` 2.4s `steps(4)`, `animate-status-pulse` 2s `steps(6)`, `animate-status-ping` 2s `steps(8)`, `live-tool-shine` and `live-activity-focus` 2.2s `steps(30)` with `animation-play-state: var(--visible-animation-state, paused)`, all disabled under `prefers-reduced-motion`.

### Motion values (measured and grepped)

- Default transition: 150ms `cubic-bezier(0.4, 0, 0.2, 1)` (Tailwind default, measured on buttons, toggles, tooltips, "Worked for").
- Durations in components: `duration-150` (31 uses), `duration-200` (27), `duration-100` (8), `duration-180` (4); `ease-out` (38 uses), `ease-in-out` (5).
- `--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)` for surfaces that slide or pop in (composer context, pills).
- Dialog popup: scale 0.98 + opacity, 200ms ease-in-out; backdrop opacity 200ms. Settings dialog: scale 0.985 + opacity, 150ms ease-out.
- Tooltip and popover: scale 0.98 + opacity, 150ms.
- Button press: `scale-[0.97]` on `:active`. Send button: `hover:scale-105`, 150ms.
- Sidebar list reorder: 150ms ease-out, row travel capped at 40px (`components/Sidebar.motion.ts`).
- Panel width animations: `--panel-animation-duration`, default 0ms (`packages/contracts/src/settings.ts`, "Zero avoids per-frame layout work").

## Components

Primitives live in `apps/web/src/components/ui/*.tsx`. Compose these, never restyle them: pick a `variant` and `size`; put only layout classes (width, flex, margin, position) on the parent. `shadcn/no-restyle` fails lint on violations (AGENTS.md "Taste", `docs/internals/web-ui.md`). A treatment a second call site needs becomes a variant or slot on the shared component. Do not style a raw `<button>`, `<input>` or `<select>` to look like a primitive; raw elements are for semantic rows, tabs and editor surfaces.

**Reference composition:** `apps/web/src/components/chat/ComposerBanner.tsx` exports one object of small slots (`Surface`, `Attachment`, `Dock`, `Column`, `Root`, `Row`, `Icon`, `Content`, `Separator`, `Actions`, `Children`, `Scroll`, `Count`, `Body`, `Dot`, `ToggleIcon`, `Dismiss`). Slots own their classes, take `className`, spread the rest of their props and merge with `cn`; variants (`default | error | info | success | warning`) and density (`default | comfortable | spacious`) are props on `Root`; a slot that needs a control renders `Button`. `ComposerBannerStack.tsx` composes them and owns only stack behaviour. New UI is built the same way.

### Buttons (`components/ui/button.tsx`)

- **Shape:** `rounded-[var(--control-radius)]` (8px), 1px border, 500 weight, 14px on `sm:` screens. Icons default to 16px (`sm:size-4`).
- **Sizes (desktop / touch):** `default` 32 / 36px, `sm` 28 / 32px, `xs` 24 / 28px, `lg` 36 / 40px, `xl` 40 / 44px, `compact` 28px with 6px radius and 12px text, `micro` 20px with 11px text, `icon` 32 / 36px, `icon-sm` 28 / 32px, `icon-xs` 24 / 28px, `icon-lg` 36 / 40px, `icon-xl` 40 / 44px, `icon-micro` 20px, `icon-tiny` 16px, plus `sm-pill`, `icon-sm-pill`, `multiline`, `sm-multiline`. Coarse pointers get a 44px hit area via `::after`.
- **Variants:** `default` (primary fill, 90% on hover), `secondary`, `outline` (popover fill, `border-input`, `dark:bg-input/32`), `ghost` (transparent, `bg-accent` on hover/pressed, icons in muted foreground), `ghost-muted`, `ghost-destructive`, `destructive`, `destructive-outline`, `warning-outline`, `glass` (rounded-full `surface-glass`), `link`, `overlay`, `media-close`, `media-navigation`.
- **States:** `focus-visible:ring-2 ring-inset ring-ring ring-offset-1`; disabled at 64% opacity; active `scale-[0.97]`.
- `InlineButton` (same file) for text-only actions inside prose (`tone`: `default | muted | destructive | picker`).

### Badges (`components/ui/badge.tsx`)

- 4px radius, 500 weight. Sizes: `default` 18px tall / 12px text on desktop, `sm` 16px / 10px, `lg` 22px / 14px, `control` 24px with 8px radius.
- Variants: `default`, `secondary`, `outline`, `destructive`, and tinted `success | warning | info | error` (8% tint light, 16% dark, `-foreground` text). Measured on the board: "MR open" is `info` at 59x18px, padding 0 3px.

### Menus, popovers, tooltips

- **Menu** (`components/ui/menu.tsx`): `dropdown-glass`, 8px radius, 4px inner padding; items 28px (32px touch), 4px radius, 8px horizontal padding, 16px icons at 80% opacity in muted foreground, `data-highlighted:bg-accent`; separators `mx-2 my-1 h-px bg-border`; group labels 12px 500 muted. The thread-actions menu captured in refs is `contextMenuFallback.ts` with the same measurements (218px wide, 8px radius, 28px items).
- **Popover** (`components/ui/popover.tsx`): 8px radius, popover fill, scale/opacity entry.
- **Tooltip** (`components/ui/tooltip.tsx`): 6px radius, `--popover` fill, 1px border, 12px text at 16.5px line height, 4px 8px padding; shows shortcut in parentheses, e.g. "Toggle terminal drawer (⌘J)".
- **Kbd** (`components/ui/kbd.tsx`): 20px, 4px radius, 12px 500 muted text on `foreground/7%`; `outline` variant draws a physical key.

### Dialogs (`components/ui/dialog.tsx`, `dialog-styles.ts`, `command.tsx`)

- `DialogPopup`: `dialog-glass`, 16px radius, 1px border, `max-w-lg` (512px) by default; close button is a ghost `icon` button at `end-2 top-2`. Mobile becomes a bottom sheet.
- `DialogHeader` `p-6 gap-2`, `DialogPanel` `p-6 space-y-4` in a fading `ScrollArea`, `DialogFooter` `px-6 py-4`, `border-t bg-muted/72`, right-aligned actions.
- Command palette: 576px wide, 16px radius, input 34px with a leading search icon, group label 12px 500 muted (6px 8px padding), items 32px with 4px radius and `bg-accent` highlight, shortcuts as `kbd` in `text-secondary-label`, footer `bg-foreground/2.5%` with `border-foreground/7%` and kbd hints ("Navigate", "Select", "Close").
- Settings is a full dialog (1280x820 at this viewport, 16px radius, `bg-background`) with a left nav that reuses `SidebarMenuButton` rows (32px, 8px radius, `bg-sidebar-row-active` when active) and 12px 500 muted section labels.

### Inputs (`components/ui/input.tsx`, `textarea.tsx`, `select.tsx`, `input-group.tsx`)

- Wrapper `rounded-lg border border-input bg-background` (`dark:bg-input/32`), `shadow-xs/5`, 1px inner line; field 34px (30px on `sm:`), 11px horizontal padding, placeholder in `text-placeholder`.
- Focus: `border-ring` plus a 3px inset `ring-ring/24`. Invalid: `border-destructive/36`, focused `ring-destructive/16`. Disabled 64% opacity.

### Sidebar (`components/ui/sidebar.tsx`, `components/Sidebar.tsx`, `components/sidebar/SidebarThreadRow.tsx`, `SidebarThreadHeader.tsx`)

- Width 256px, `bg-sidebar` with grain, 1px right border. Content inset 8px; header row 52px with the stage art backdrop (`SidebarStageBackdrop.tsx`, theme-tinted line art fading out by 92%).
- **Thread row:** full width minus 16px (239px), 6px radius, 10px horizontal inner padding. Line 1: 16px project icon + project name at 12px `text-secondary-label`, status or age at 12px on the right ("Done" with check icon in success colour, "In terminal", "now", "10d"); hover swaps the status for Snooze / Settle actions. Line 2: title 14px / 20px `text-foreground/75`. Optional line 3: branch at 12px. Heights 60px (two lines) and 78px (three lines). Selected: `bg-sidebar-row-active`, `text-sidebar-foreground`, title at full foreground.
- **Group header** (e.g. "Checkout retries"; an initiative or project name): 32px button, 8px padding, 12px 500 `text-sidebar-muted-foreground`, truncated label, count and chevron on the right. No background.
- **Child rows** under a group (initiative thread, "Wave 0 of 4"): 36px, 10px padding, 10px gap, 16px icon (`lucide-layout-dashboard` for the wave row), 14px label in `text-sidebar-muted-foreground`, `hover:bg-sidebar-row-hover hover:text-sidebar-foreground`.
- Section toggles ("Working 1", "Settled 11") are 32px rows like the group header. Footer: 32px icon buttons (Settings, Pull requests, Issues, Board, Usage), 8px radius.
- `SidebarMenuButton` sizes: `default` 32px, `sm` 28px, `lg` 48px, `icon` 32px; variants `default` (500 weight, muted at 80%) and `outline`.

### Chat column and timeline (`components/chat/*`)

- Column `.chat-content-lane`, `max-width: var(--chat-content-max-width)` (46rem = 736px), centred. Top bar 52px, 20px horizontal padding, breadcrumb "project / thread title".
- **User message:** right-aligned bubble, `bg-message`, 16px radius, 12px padding, `max-w-[80%]`, 14px text; time and copy actions (24px icon buttons) under it.
- **Assistant message:** no bubble; markdown at 14px / 22.75px, `text-foreground` at 90%. Lists indent 20px. Tables: header 600, cell padding 7.2px 12px 7.2px 0, `border-b` at 60% border.
- **Code block** (`.chat-markdown-codeblock`): 8px radius, 1px border (`border-border/70`; transparent in dark default, `--contrast-border` in themes), `--code-background`, 10.4px vertical margin, language chip top-left and wrap/copy icon buttons top-right; `pre` padding 12.8px 14.4px.
- **Work log:** "Worked for 14s" toggle (14px muted, chevron), then one 28px row per tool call or thought: 16px lucide icon (`brain`, `list-todo`, `eye`, `pencil`, `square-terminal`), 14px `text-secondary-label` truncated text, chevron on the right. Background tasks render as a row like "Command "…" finished" with a terminal icon. A summary row reads "Changed 1 file, ran 1 command, and performed 1 other action".

### Composer (`components/chat/ComposerSurface.tsx`, `ComposerBanner.tsx`, `ComposerBannerStack.tsx`)

- `Shell` 736px wide, 16px radius; its glass is `--chat-composer-glass-surface` (`--app-theme-surface-raised` in themes) at `--glass-opacity` with `--glass-blur`. `Host` adds the 1px outline and, in light, `--shadow-composer`. Editor 14px / 22.75px, min two lines, max 208px (`max-h-52`).
- Toolbar row 40px: attach icon button left; model picker and permission pills (28px, `--control-radius`, 14px 500 at 80% foreground, `hover:bg-accent`), mic, and a 32px round send button on the right (primary fill, `inset-shadow-control-highlight`). Focus does not change the composer outline; the caret is the focus signal.
- Banners attach above the composer with `ComposerBanner` slots; `Attachment` tucks 17px under the card, inset 22px each side (`--chat-composer-drawer-inset: 1.375rem`).

### Thread details card (right side, 280px)

- Floating `dropdown-glass`, 16px radius, 12px from the top bar edge. Rows are 32px `Button`-based rows: 8px radius, 10px padding, 10px gap, 14px icon, 13px 500 text at 80% foreground, trailing chevron or value. Sections (Workspace, Version Control, Previous agents) separated by a 1px divider; an expanded section header gets `bg-foreground/8%`. Subagent rows show the provider icon, truncated title and age ("18m").

### Board (`pluginCards/live/BoardPage.tsx`)

- What "Wave 0 of 4" opens today. Initiative rows are 32px buttons (8px start / 10px end padding, 12px 500 at 80% foreground) with "updated 14d ago" in `text-3xs` and a chevron. Expanding one shows label/value stat rows (12px muted label, right-aligned value, a thin progress bar) and a `components/ui/table.tsx` parts table (head 40px, 12px 500; cells 8px padding, 12px; rows `border-b`, `hover:bg-muted/50`) with `Badge` `info` statuses. The captured board shows the Part column overflowing into Wave/Status; treat it as current state, not a pattern to copy.

### Other primitives available

`alert`, `alert-dialog`, `autocomplete`, `calendar`, `checkbox`, `collapsible`, `collapsible-section-header`, `color-picker`, `combobox`, `discovery-list`, `draft-input`, `empty`, `group`, `label`, `middle-truncate`, `number-field`, `panel-tab-close-button`, `preview-card`, `radio-group`, `scroll-area`, `separator`, `sheet`, `skeleton`, `spinner`, `standalone-page`, `switch`, `table`, `toast`, `toggle`, `toggle-group`, `wizard` (all in `components/ui`).

### Icons

- Library: `lucide-react` (330 import sites in `components/`; no other icon library). Default stroke is lowered to 1.75 globally (`index.css`, `svg.lucide[stroke-width="2"]`).
- Sizes measured: 16px (most rows, buttons, menu items), 14px (details rows, breadcrumb), 12px (pins, micro controls). Icons take `--control-icon-color` inside buttons and `--sidebar-icon-color` (sidebar muted foreground at 85%) in the sidebar.

### Focus

Global `outline-ring/50` with `outline-offset: -2px` (outlines stay inside controls). Controls use `focus-visible:ring-2 ring-inset ring-ring`; inputs use `border-ring` plus a 3px `ring-ring/24`. Menu, select and popover popups suppress their own focus outline.

## Do's and Don'ts

### Do:

- **Do** start every mock from `rucode-app.css` plus `theme-t3-chat-dark.css` or `theme-t3-chat-light.css`, with `<html class="dark" data-theme-id="t3-chat">` (or no class), and use only the app's Tailwind classes and semantic variables.
- **Do** build with the primitives in `components/ui` and the `ComposerBanner` slot pattern; pick `variant` / `size`, never restyle.
- **Do** express new features as rows: 32px controls, 36px nav rows, 28px menu rows, two-line 60px list rows, 14px titles over 12px meta.
- **Do** put new floating content in an existing floating surface (menu, popover, dialog, details card, composer banner) and keep in-page content flat on the canvas.
- **Do** use text levels (`text-foreground`, `text-muted-foreground`, `text-secondary-label`, opacity steps) for hierarchy.
- **Do** keep the 736px chat column, 256px sidebar and 280px details card widths.
- **Do** use 150ms ease-out for state changes and 200ms for dialogs; stepped, visibility-paused animation for anything that loops.
- **Do** check the design in at least T3 Chat dark, T3 Chat light and the default theme; colours must come out right in all five built-ins.

### Don't:

- **Don't** use any colour, radius, font, shadow or component that is not in the theme variables and `components/ui`. No hex or Tailwind palette colours (`bg-pink-500`) in components.
- **Don't** use gradient text, glass cards inside the page, coloured left-edge stripes, big-number stat tiles, or uppercase eyebrow labels on sections. Section labels are 12px 500 sentence case in muted foreground.
- **Don't** build SaaS dashboard layouts: card grids, KPI tiles, Jira or Linear style kanban boards. Lists of rows and a plain `Table` are the vocabulary.
- **Don't** add drop shadows or borders around in-page groups; separate with space or a 1px `border-border` line.
- **Don't** use the accent for decoration, headings or icons; it marks the one primary action, focus, and selection.
- **Don't** add continuously repainting animation (spinners outside `visible-animate-spin`, shimmer, gradients that move, per-frame CSS animation).
- **Don't** set text larger than 18px (20px for `DialogTitle` is the one exception), or use weights above 600.
- **Don't** use an icon set other than lucide, or icons larger than 16px in rows.
