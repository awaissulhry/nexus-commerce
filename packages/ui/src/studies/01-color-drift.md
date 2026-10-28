# Study 01 — Color drift in the ads stylesheets

**Date:** 2026-06-22 · **Status:** final (Phase 1 companion)

The four ads stylesheets contain **251 unique hex colors** (+ ~25 rgba variants).
The design language only needs ~70. The rest is **drift** — near-duplicate shades
accreted across many authoring sessions. This study names the canonical value per
cluster (now in `../tokens/colors.ts` + `../styles/tokens.css`) and lists the
duplicates each one absorbs.

> Why this matters: collapsing a duplicate onto its canon (e.g. `#16a34a` →
> `#15a34a`) is a **real pixel change**, so it is NOT done in Phase 1. The
> canonicalization runs during the harness-gated `ads.css` migration (after
> Phase 2), where every change is screenshot-diffed. This report is the worklist.

## Method

```
grep -hoE '#[0-9a-fA-F]{3,8}' <ads stylesheets> | sort | uniq -c | sort -rn   → 251 hex
grep -hoE 'rgba?\([0-9.,% ]+\)'  <ads stylesheets>                            → rgba variants
```

## Drift clusters (canonical ← absorbs)

### Primary blue — canon `#1f6fde` (383×)
Absorbs the brighter/cooler accent blues and dark-blue variants:
`#2f6bff` (24) · `#316ee0` (6) · `#2f6fed` (4) · `#2f72d6` (1) · `#1a5fc0`/`#195fc0` (2/2) ·
`#1558b0` (2) · `#1e40af` (1) · `#6b3df0` (1). Dark: canon `#134da3`/`#0a4ba8` absorb
`#0048b0` (2) · `#0048ab` (1).

### Success green — canon `#15a34a` (action), `#15803d` (strong), `#1e9e62` (live)
Absorbs: `#1f9d57` (4) · `#16a34a` (2) · `#1a7f37` (3) · `#167a48` (2) · `#2e8b57` (3) ·
`#2d9d5f` (2) · `#128a3f` (1) · `#5fb377` (2) · `#34c759` (2, dayparting "enable").

### Danger red — canon `#e5484d`, `#c0392b` (strong), `#d4493f` (hover)
Absorbs: `#d6453d` (4) · `#e0322a` (4) · `#c11208` (2) · `#c0271c` (2) · `#cf3b40` (1) ·
`#cc1100` (1) · `#ff4d4f` (2) · `#b91c1c` (1).

### Text / neutral darks — canon `#1c2530` (324×)
Absorbs: `#1b2230` (15) · `#1a2330` (4) · `#1f2c3d` (1) · `#111a27` (1).
Secondary `#5b6573` (178×) absorbs `#6b7585` (52) · `#6b7480` (18) · `#667085` (8) ·
`#5b6c84` (2) · `#6d839f` (2) · `#6a7787` (4).
Tertiary `#8a93a1` (207×) absorbs `#98a2b3` (44) · `#9aa3af` (10) · `#93a0b0` (2) ·
`#9aa3b0` (3) · `#8a94a6` (2).

### Borders — canon `#d8dde4` (default), `#e6e9ee` (subtle), `#c2c9d3` (strong)
Default absorbs `#d6dbe2` (9) · `#d4dae4` (4) · `#d2dae4` (2) · `#dde2e8` (8) · `#dae0e7` (8).
Subtle absorbs `#e3e7ec` (26, except the rail line) · `#e3e8ef` (24) · `#e0e4ea` (12) ·
`#e7eaee` (6) · `#e2e6eb` (2).

### Light surfaces — canon `#f7f9fb` (raised), `#f4f6f9` (canvas), `#eef1f5` (sunken)
Absorbs the near-white wash family: `#f7faff` (12) · `#f4f7fb` (9) · `#f6f8fa` (15) ·
`#f1f3f6` (8) · `#f7f9fc` (6) · `#f4f6f8` (6) · `#fafbfd` (2) · `#f6f7f9` (2).

### Shadow base — canon `rgb(20 28 38 / α)`
Absorbs two parallel shadow tints: `rgba(16, 24, 40, α)` (≈14×) and
`rgba(20, 30, 50, α)` (≈8×). Also normalize formatting: `rgba(31, 111, 222, 0.12)`
(24) and `rgba(31,111,222,.12)` (16) are the **same** focus ring — one token.

## Outcome

- **Canonical palette:** ~70 tokens (`../tokens/`), down from 251 literals.
- **Worklist for migration:** ~180 literals → map onto canon, screenshot-diffed.
- **Guardrail (Phase 7):** lint to reject new raw hex in DS-managed CSS so drift
  can't re-accumulate.
