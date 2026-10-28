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
  **DONE 2026-08-24** for `token-guard` + `api-guard` (both were red when wired:
  55 token violations, 4 barrel gaps — cleared in the same change). The catalog
  visual-regression baselines are the remaining open bullet.

### 9.0b — Token-form collision → **`PHASE-9-0B-TOKEN-FORM.md`**
- The DS and the app define the same 25 semantic names in two incompatible forms
  (colours vs RGB channels), so **289 DS declarations are discarded** on every
  page inside `.h10-shell`. Not a cascade-order bug — ancestor scope beats source
  order — and not fixable by flipping `globals.css` (Tailwind needs the channels).
- Fix: DS stylesheets consume `--nds-*` only; the platform-alias tier is deleted
  and a `token-guard` check D keeps it out.
- **Blocks 9.2 and 9.3**, which would otherwise amplify the ambiguity across ~290
  pages. Full plan, measurements and gates in the linked doc.

### 9.1 — Tokenize the app's stylesheets ✅ MOSTLY DONE 2026-08-25
- **Scope was wider than this section said.** It named `ads.css` (2,144 literals).
  `rules-automation.css` had **3,674** and was never mentioned; repo-wide it was 10,343
  across 45 stylesheets.
- `styles/tokens.css` is already imported by the ads layout — that step was done.
- **Done:** 10,343 → ~3,300. Two mechanical passes, both by construction safe:
  exact token matches (value-identical), then ΔE ≤ 2.3 drift (gated on a pixel
  diff — max channel delta 7/255 across four pages).
- **Mapped to tier-1 RAMPS, not semantic roles.** 40 of 60 hex values carry
  several token names (`#ffffff` is `--nds-white` AND `--nds-surface` AND
  `--nds-text-inverse`); a blind substitution to a semantic name asserts a
  meaning it cannot know. Promoting ramps to roles needs context and is a later,
  per-surface pass.
- **What is left is NOT more of the same.** ~3,300 literals that are genuinely
  off-palette. 🔴 Read them as evidence, not drift: three separate clusters
  turned out to be contrast ratios someone COMPUTED and documented in a comment,
  and snapping them to the nearest token would have broken WCAG AA. That is how
  `--nds-*-text` and `--nds-text-muted` came to exist. Anything with a ratio in
  a comment beside it is load-bearing.
- The legacy consoles (`ads-console/`, `advertising/`) are excluded — Wave 0
  retires them, so converting them buys nothing.

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
  🔴 **STALE — the grid line is now BACKWARDS.** Concept #13 was decided 2026-08-25 the
  other way: the ads grid is PROMOTED into `patterns/` as `WorkspaceGrid` and the DS
  `DataGrid` is retired, because 10 of its 14 call sites already hand-roll the chrome the
  ads grid has built in, and the port is one field plus two renames. See
  `PHASE-9-3-DUPLICATE-CONCEPTS.md` Appendix A. Anyone following the line below migrates
  in the wrong direction.
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
