# Phase 9 — Migration plan (rolling the DS onto the app)

**Status:** PROPOSAL — awaiting approval. Each sub-phase: build → token-guard +
`tsc`/`next build` + **harness screenshot-diff vs baseline** → visual review →
commit & push. Nothing ships that the harness flags as a regression.

The build (Phases 0–8) is done. This is the rollout — "convert existing to use
this." It converges the two design languages onto the H10 tokens and adopts the
DS across the app, **without ever forking**.

## Hard rails (every sub-phase)
- **Harness-gated.** Screenshot-diff each touched screen against a baseline; a
  visible regression blocks the commit (your "never catch a defect" rule).
- **Untouchables.** Zero changes to `/products/amazon-flat-file` +
  `/products/ebay-flat-file` — they converge via shared tokens only.
- **Let the ads WIP settle.** Don't start 9.1 until the live `_rank` + B-series
  budget builder are committed (tokenizing `ads.css` mid-edit = collisions).
- **Concurrent sessions.** `git commit --only`; re-push if the shared build gate
  is momentarily red (as seen during the build).
- **Per-sub-phase approval.** Highest-blast-radius step (9.2) gets extra review.

## Sub-phases (in order)

### 9.0 — Pre-flight
- Confirm ads `_rank`/budget WIP is committed (no uncommitted churn in `ads.css`'s
  neighborhood).
- Capture harness **baselines**: `/marketing/ads/*` (the reference) + the top
  pages of each section. These are the diff targets for every later step.
- Activate the guardrails: wire `tools/token-guard.mjs` + the catalog
  visual-regression into `.githooks/pre-push`.

### 9.1 — Tokenize `ads.css` (keystone — the deferred Phase 1 rewrite)
- Rewrite `ads.css` to reference `var(--h10-*)` instead of hardcoded hex,
  canonicalizing the 251→~70 drift per `studies/01-color-drift.md`.
- Import `styles/tokens.css` in the ads layout.
- **Gate:** every ads screen pixel-identical vs the 9.0 baseline (drift-collapse
  is sub-perceptual; the diff proves it). This is *the* proof the system's values
  equal the originals.

### 9.2 — Converge `globals.css` onto H10 (the app-wide look flip)
- Reset the existing semantic token **values** (`--text-*`, `--surface-*`,
  `--border-*`, `--status-*`) to the H10 values per `TOKEN-RECONCILIATION.md`.
- One token change → the ~290 Tailwind pages shift to the H10 look. **Highest
  blast radius.** Do it **per token-group** (text → surfaces → borders → status),
  each reviewed, to isolate any surprise. Honor the Phase-6 contrast rule
  (body = text/text-2).

### 9.3 — Re-skin `components/ui` onto the DS
- Point the 26 `components/ui` primitives at the DS tokens (re-skin) or re-export
  the DS primitives, so every page's Button/Card/Input/etc. adopts H10 without
  per-page edits. Gate: the old `/design` page + key pages render in H10.

### 9.4 — Section rollout (one section = one sub-phase)
Dashboard → Products → Orders → Fulfillment → Pricing → Insights → Listings →
Customers → Settings. Migrate each section's bespoke UI to DS components/patterns;
its feature dossier (studies hub) scopes it; harness-gated + reviewed.

### 9.5 — Migrate the ads cockpit onto the DS
- Replace the ads' bespoke components per `studies/03-ads-campaigns.md` §3
  (`AdsDataGrid`→`DataGrid`, `FilterDropdown`→`MultiSelect`/`Combobox`, modals→
  `Modal`/`Drawer`, charts→`PerformanceGraph`/`Heatmap`, shell/headers→patterns,
  rule builders→`Builder`). Lift `builder-icons` → `primitives/icons`. Dedupe the
  two `format.ts` onto `lib/format`.

### 9.6 — Prefix rename
- Codemod `.h10-*` → a neutral prefix (`.nx-*`) across `styles/` + all consumers
  in one reviewed sweep, once everything is stable. Update `NAMING.md`.

### 9.7 — Retire duplication
- Fold the old Tailwind `/design` page into `/design-system`; remove dead tokens,
  the duplicate formatters, and (per the superseded `UI_REBUILD_STRATEGY`) the
  redundant `ads-console` / `advertising` surfaces. Tighten lint to ban off-token
  drift app-wide.

## Suggested start
**9.0 + 9.1** once the ads WIP is committed — the highest-value, lowest-risk first
move (tokenize the reference surface, proven pixel-identical). Pause for review
before **9.2** (the app-wide flip).
