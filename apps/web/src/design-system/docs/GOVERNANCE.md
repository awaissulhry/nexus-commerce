# Governance

How the design system is versioned, changed, owned, and kept from drifting.

## Source of truth

| Layer | Canonical location | Notes |
|---|---|---|
| Token **values** | `tokens/` (TS) → generates/wires `styles/tokens.css` + Tailwind | One definition; CSS vars and Tailwind both derive from it |
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
2. **Semantic** — role-based, reusing the platform's existing names
   (`--text-primary`, `--surface-card`, `--border-default`,
   `--status-success-{soft,line,strong}`). Components consume **these**.
3. **Component** — only when a component needs a knob the semantic layer doesn't
   express (e.g. `--grid-row-height`).

Components reference the **semantic** (or component) tier — never primitives,
never raw hex.

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
