# Changelog — Nexus Design System

Newest first. Each shipped phase is an entry. Token-value changes that
intentionally restyle the app, and breaking changes to token names or primitive
props, are called out explicitly with a migration note.

## [P3.2] — 2026-06-22 — Primitives wave 2 (Input · Select · Checkbox · Toggle)

- Form controls tokenized to the H10 spec: `Input` (plain / leading-icon /
  `€`-prefix / `%`-suffix via the `.h10-am-search` + `.mmin` field pattern),
  `Select` (styled native + chevron, `.h10-fsel`), `Checkbox` (accent-tinted
  native), `Toggle` (`role="switch"`, `.h10-toggle` 30×17 with sliding knob).
- Appended `.h10-ds-field/select/check/toggle` to `styles/primitives.css`;
  catalog dog-foods them in a second Primitives card.
- `tsc` clean; identical pattern to the visually-verified wave 1. The @2x visual
  capture + push were deferred at commit time — a concurrent session was actively
  re-breaking the shared tree (dev 500 / non-buildable); both run on a clean window.
- Note: the searchable/portal MultiSelect + Combobox move to Phase 4 (composite).

## [P3.1] — 2026-06-22 — Primitives wave 1 (Button · Pill · Badge)

- First primitives in `primitives/`, tokenized to the H10 spec: `Button`
  (primary/secondary/ghost × md/sm + disabled, matches `.h10-am-btn`), `Pill`
  (ok/warn/arch, matches `.h10-pill`), `Badge` (SP/SD/SB program + A/M targeting).
- Self-contained `styles/primitives.css` under the `.h10-ds-*` sub-namespace
  (collision-proof vs ads.css's route-scoped `.h10-*`; documented in NAMING).
  Added `--h10-text-strong` + `--h10-surface-hover` semantic tokens.
- Catalog now **dog-foods** the components (Primitives section); the verify
  harness gained a per-section `[data-cat]` capture.
- Verified @2x: light, dark, and a focused primitives shot — all match the H10
  look. Committed locally; push deferred behind a concurrent session's
  non-buildable tree.
- Remaining primitive waves: Input/Select/MultiSelect, Checkbox/Radio/Toggle,
  Tooltip/Spinner/Skeleton/Kbd/Divider, icons.

## [P2] — 2026-06-22 — Living catalog + verify harness

- New route `/design-system` (`app/design-system/page.tsx`) renders the full
  token set — primitive ramps, semantic roles, status pills, program chips,
  typography, spacing, radius, elevation, motion/z-index/breakpoints — driven by
  `@/design-system/tokens` so the catalog can never drift from the source. Light
  + a dark toggle that exercises the `.dark` CSS layer.
- `catalog/TokenCatalog.tsx` (the portable component) + `catalog/verify.mjs`, a
  Playwright @2x screenshot harness (light + dark, full page → `.analysis/dsshot`)
  reusing the established H10 capture pattern. This is the baseline that the
  component phases + the `ads.css` migration screenshot-diff against — i.e. it
  **unblocks** the deferred `ads.css` → token rewrite.
- Verified: `tsc` clean; isolated additive route (no existing file touched).
  Live visual review on the deploy (local dev server was in a concurrent-session
  500 state at build time, unrelated to this route).

## [P1] — 2026-06-22 — Token foundation

- Canonical token system shipped as new files (zero changes to existing code):
  `tokens/` (colors, typography, spacing, radius, shadow, motion, zindex,
  breakpoints + `index` barrel) and `styles/tokens.css` (the `--h10-*` CSS vars,
  three tiers: primitive ramps → semantic roles → component chips).
- Distilled the canon from **251 hex literals → ~70 tokens**; documented the
  drift (near-duplicate greens/reds/blues/greys, dual shadow tints) and the
  collapse worklist in `studies/01-color-drift.md`.
- Tokens are **dark-ready** (provisional `.dark` inversions of the semantic
  layer) though H10 ships light-first; no surface opts in yet.
- **Sequencing decision:** the `ads.css` rewrite onto tokens is deferred to
  *after* the Phase 2 screenshot-diff harness — canonicalizing drift changes
  pixels, so it must be verified, not done blind. Phase 1 stays pure-additive.
- Namespaced `--h10-*` to avoid colliding with `globals.css`; convergence onto
  the platform's semantic names is a deliberate migration step.

## [P0] — 2026-06-22 — Scaffold + governance + inventory

- Created `apps/web/src/design-system/` with the full folder structure
  (`tokens` · `styles` · `primitives` · `components` · `patterns` · `catalog` ·
  `studies` · `docs`), each self-documented.
- Founding governance docs: `README`, `GOVERNANCE`, `CONTRIBUTING`, `NAMING`,
  `TOKENS`, `TOKEN-RECONCILIATION`.
- Studies framework: `studies/README` + `_TEMPLATE` + the authoritative
  `00-ads-inventory.md` mapping every `/marketing/ads` UI element to its DS home.
- **Decision:** the H10 look becomes the canonical platform design language; the
  existing Tailwind semantic-token system converges onto it (one system, not a
  fork). Supersedes the unapproved `docs/UI_REBUILD_STRATEGY.md`.
- **Decision:** keep the `.h10-*` class prefix until a Phase 9 rename.
- Non-destructive: no existing page or stylesheet changed.
