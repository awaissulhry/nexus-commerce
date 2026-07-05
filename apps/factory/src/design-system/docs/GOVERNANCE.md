# Governance

How the design system is versioned, changed, owned, and kept from drifting.

## Source of truth

| Layer | Canonical location | Notes |
|---|---|---|
| Token **values** | `tokens/` (TS) → **generates** `styles/tokens.css` | `tokens/css-vars.ts` (hex sourced from `tokens/colors.ts`) is the one source; `tools/generate-tokens-css.ts` emits the `:root{}` + `.dark{}` blocks. `tokens.css` is GENERATED — never hand-edited |
| Primitives | `primitives/` | The existing `components/ui/*` are aliased to these during migration |
| Components | `components/` | Lifted + generalized from `/marketing/ads` |
| Patterns | `patterns/` | Composed organisms (shell, builders, filter panels) |
| Docs/specs | `docs/` | Governance, naming, tokens, reconciliation |
| Research | `studies/` | Per-feature + cross-platform |

A value, component, or pattern is defined **once**. Re-implementing an existing
concept (a second "primary button", a second modal chrome) is a defect to be
reconciled, not merged.

## Token tiers

1. **Primitive** — raw scale values (`--h10-blue-600: #1f6fde`). No semantics.
2. **Semantic** — role-based, under the platform's names (`--text-primary`,
   `--surface-card`, `--border-default`, `--status-success-{soft,line,strong}`,
   `--color-primary`). **Live**: these are value-preserving aliases over the
   `--h10-*` roles, and every component CSS rule consumes **them**.
3. **Component** — DS-only knobs the semantic layer doesn't express, kept under
   `--h10-*` (radius/shadow/focus/pill/badge/targeting/rail/structural-dim).

Components reference the **semantic** (or DS-only component) tier — never the raw
`--h10-*-NNN` ramps, never raw hex.

## Versioning

The system is versioned in `CHANGELOG.md` with a simple, honest scheme:

- **Phase tags** (`P0`…`P9`) track the rollout; each shipped phase is an entry.
- **Breaking** changes to a token name or a primitive's public props are called
  out explicitly with a migration note.
- Token *value* changes that intentionally restyle the app (the whole point of
  convergence) are logged with before/after and the surfaces affected.

## Deprecation policy

1. Mark deprecated in code (`@deprecated` + replacement) and in `CHANGELOG.md`.
2. Keep a working shim/alias for at least one phase so callers don't break.
3. Remove only after the migration map (Phase 9) confirms zero live callers.

This mirrors how `components/ui` will be aliased onto the new primitives before
any removal.

## Definition of Done (per token / primitive / component / pattern)

- [ ] Resolves entirely through tokens — **no raw hex, no ad-hoc Tailwind color
      drift** in the component.
- [ ] Rendered in the **catalog** (`catalog/`) in every relevant state.
- [ ] **Native-res screenshot-diff** vs the H10 reference passes; alignment,
      borders, and spacing measured numerically (not by eye).
- [ ] `tsc` + `next build` clean; **contrast lint** passes (WCAG AA).
- [ ] Keyboard + focus-visible + ARIA where interactive; `prefers-reduced-motion`
      honoured.
- [ ] Light path verified; dark path either verified or explicitly N/A.
- [ ] Public props/usage documented (JSDoc + a catalog example).
- [ ] No regression to `/marketing/ads` (the reference surface renders identically).

## Review gates (every phase)

`build → tsc/build + contrast lint + screenshot-diff → human visual review →
commit & push.` Nothing merges that a gate rejects. The catalog page is the
single screen used to judge the whole system at once.

## Ownership

Until a `CODEOWNERS` entry is added (Phase 7), changes to `design-system/`,
`tokens.css`, and `tailwind.config.ts` are treated as shared-foundation edits:
small, reviewed, and committed with `git commit --only` to avoid colliding with
concurrent sessions.

## Hard constraints

- **Zero changes** to `/products/amazon-flat-file` and `/products/ebay-flat-file`
  (standing rule) — they converge via shared tokens only, never direct edits.
- **Defer live WIP**: the actively-changing ads builders (`_rank/`, the B-series
  budget builder) are folded in only after that work is committed.

## Guardrails (automated)

- **Token generation + sync** — `tools/generate-tokens-css.ts` is the source of
  truth pipeline: `npm run tokens:gen` writes `styles/tokens.css` from
  `tokens/css-vars.ts`; **`npm run tokens:check` is the CI guard** — it
  regenerates in memory and fails if the committed `tokens.css` is stale, so the
  TS source and the CSS can't drift. `tokens.css` carries a `GENERATED — do not
  edit by hand` header.
- **Token drift (hex)** — `tools/token-guard.mjs` fails on any raw hex literal in
  shipped DS code — `primitives/` · `components/` · `patterns/` · `styles/`
  (`tokens.css` excepted, since it *defines* the palette; `catalog/` out of
  scope). Run from repo root: `node apps/web/src/design-system/tools/token-guard.mjs`.
  Passes today.
- **Contract intent (not yet a script).** The consistency contract (see
  `docs/AUDIT.md` §0, spec §3) extends the hex guard to two further rules that are
  enforced by review today and slated for lint: **(a) no raw ramp** — a
  `var(--h10-{grey,blue,green,red,amber,purple,cyan}-NNN)` reach in component CSS
  is a defect (use the semantic alias instead); **(b) no raw Tailwind palette**
  in DS `.tsx`. A planned `tools/api-guard.mjs` will assert **barrel-export
  completeness** (every component re-exports its public Props/types) and that the
  `Tone`/`Size` unions conform — until then, the barrels in
  `primitives/index.ts` · `components/index.ts` · `patterns/index.ts` are the
  reviewed contract.
- **Visual regression** — `catalog/verify.mjs` @2x-captures the catalog + every
  overlay; commit baselines and diff in CI to automate the screenshot-diff rule.
- **Contrast** — body text uses `--text-primary` / `--text-secondary`
  (`--h10-text` / `--h10-text-2`); `--h10-text-3` is secondary/large-only (see
  `studies/02-contrast-audit.md`).
- **CODEOWNERS** — deferred for a solo operator (a self-review request adds
  friction with no second reviewer); add when a team forms.
