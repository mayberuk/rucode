# Product

## Register

product

## Users

RuCode's user is a developer who directs several coding agents at once, across a handful of repositories, all day. They start agents from the app and from the terminal, leave them running, and come back to see what needs them. Most of their time is spent reading: agent replies, diffs, plan and review output, the state of multi-part work. Their screen is usually a laptop or a desktop monitor; the phone is for approving a step away from the desk.

The job on any screen is one of three: see what needs me, read what an agent did, tell an agent what to do next.

## Product Purpose

RuCode is a fork of T3 Code, a GUI for coding agents (Claude Code, Codex and others) that runs on the user's machine and serves desktop, web and mobile clients. RuCode adds what one heavy user needs on top: plugin cards for dispatch (planned multi-part work), gitty, iter8 (page review) and livecheck; terminal sessions adopted as threads; live initiative state in the sidebar.

Success is the user trusting the app as the single place to run and watch their agents: nothing they need is hidden in a terminal, nothing on screen is stale, and nothing new looks like it came from a different product.

## Brand Personality

Calm, precise, quiet. It replicates what T3 Code already is: dense, restrained, low in colour, fast. Polish shows in spacing, alignment, type and the small motion that explains a change, never in decoration. The reference rendering is the T3 Chat theme, and every screen must work in every theme the app ships.

## Anti-references

- Generic AI-generated UI: gradient text, glass cards, coloured left-edge stripes, big-number stat tiles, small uppercase labels above every section.
- Anything off-system: a colour, radius, font, shadow or component that is not already in the app's theme variables and `apps/web/src/components/ui`.
- SaaS dashboard look: grids of cards, KPI tiles, Jira- or Linear-style boards.

## Design Principles

- **Looks like it was always there.** A new surface is built from the app's existing primitives and tokens, so a user cannot tell which screens are RuCode's additions.
- **Show state, not chrome.** Every pixel either tells the user what is happening or lets them act on it. Status is accurate and current; a stale label or a lying spinner is a bug.
- **Reading comes first.** Agent output is the main content. Controls stay small and out of the way until needed.
- **Motion explains, never performs.** Animate a change of state so the eye can follow it; nothing moves continuously.
- **One way in, one way out.** Every new action has its reverse and its visible state, on every client.

## Accessibility & Inclusion

WCAG 2.2 AA: body text at least 4.5:1, large text and controls at least 3:1, in every theme. Full keyboard reach with a visible focus ring. Every animation has a `prefers-reduced-motion` alternative. Status is never shown by colour alone; pair it with an icon or text.
