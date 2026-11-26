@AGENTS.md

# RuCode

RuCode is a fork of T3 Code. Everything in AGENTS.md still applies; this section only adds to it. Where the two seem to conflict, AGENTS.md wins unless a line here says otherwise.

## UI work

Any change a user can see, on web, desktop or mobile, and any mock or sketch of one, follows these in order:

1. **T3 Code's floor.** AGENTS.md [Taste](AGENTS.md#taste) and [Hit every surface](AGENTS.md#hit-every-surface), and [Web UI](docs/internals/web-ui.md): compose `apps/web/src/components/ui` primitives and never restyle them, follow the `ComposerBanner` slot pattern, no continuously repainting animation, every locale, every client.
2. **RuCode's design context.** Read [PRODUCT.md](PRODUCT.md) and [DESIGN.md](DESIGN.md) before designing. Use only the app's theme variables, primitives, radii, type and motion values. A new surface should be impossible to tell apart from the screens around it, in the T3 Chat theme and in every other theme.
3. **Impeccable's process.** Shape the design with `/impeccable shape` before building, then run `/impeccable critique` and `/impeccable polish` on the result and fix what they find; `/impeccable audit` for accessibility. Check the T3 Chat theme in light and dark, plus one other theme, before calling it done.

Mocks and sketches link the app's compiled stylesheet and use the app's own classes and variables, never an invented palette or component.
