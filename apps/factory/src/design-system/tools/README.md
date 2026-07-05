# tools/

Automated guardrails (run from the repo root).

## `token-guard.mjs`
Fails if a raw hex color appears in **shipped** DS code — primitives, components,
patterns, and the tokenized stylesheets. Everything must resolve through a token
(`var(--h10-*)` in CSS, or an import from `tokens/` in TS). `styles/tokens.css`
is excepted (it *defines* the palette); `catalog/` is out of scope (a demo).

```bash
node apps/web/src/design-system/tools/token-guard.mjs
```

**Enforce it:** add that line to `.githooks/pre-push` (next to the existing P3
guard) so drift can't land. Currently runnable + documented; wiring is the
one-line activation step.

## Visual regression
`../catalog/verify.mjs` captures the catalog @2x — every `[data-cat]` section plus
each opened overlay (modal, drawer, menu, dropdowns, toast, date picker,
hovercard, builder, column customizer) — to `.analysis/dsshot/`.

To turn this into a CI gate: commit those PNGs as **baselines**, then in CI
re-run the harness and diff new shots against the baselines (e.g. `pixelmatch`),
failing on drift. This automates the "screenshot-diff before showing" rule.
