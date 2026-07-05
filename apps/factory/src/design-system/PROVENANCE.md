# Provenance (F1)

This directory is a **verbatim copy** of `apps/web/src/design-system/` (the canonical Nexus H10 design system), taken per decision FD12 in `docs/factory/F0-DECISIONS.md`.

- Source: `apps/web/src/design-system/` at commit `213a3433` (last DS-touching commit, 2026-07-04)
- Copied: 2026-07-05 (F1)
- Copied subtrees: `styles/ tokens/ primitives/ components/ patterns/ lib/ tools/ docs/ README.md`
- Deliberately NOT copied: `catalog/` and `studies/` (Nexus-internal governance surfaces), `CHANGELOG.md`
- Files are byte-identical to the source by design — **no per-file provenance headers were added** so that `scripts/ds-parity-check.mjs` can diff copy vs canonical exactly (this is a deliberate deviation from the one-line-header idea in F0-DESIGN-BRIDGE; the header would have made every file permanently "drifted")

Rules:
1. Never import from `apps/web` — this copy is the factory's own dependency surface.
2. Never edit these files casually. Factory-specific components live OUTSIDE this directory (`src/components/`, `src/vendor/`). If a DS file must diverge, record it below under **Local divergences** so the parity script's report stays interpretable.
3. Re-sync deliberately: run `npm run check:ds-parity -w @nexus/factory`, review the drift report (including the pending upstream `.h10-*` → `.nx-*` rename), and re-copy when upstream improvements are wanted.

## Local divergences

(none)
