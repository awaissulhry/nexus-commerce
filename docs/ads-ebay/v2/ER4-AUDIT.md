# ER4 — Consistency Audit (side-by-side · census · CSS · a11y/perf/i18n · fix register)

Run 2026-07-04 against `5effcaa2` (ER3 sweep complete). Method: mechanical greps over the
tree + the phase-by-phase prod verifications recorded in the gate reports.

## 1 · Side-by-side conformance (C1–C14)

| Contract | Dashboard | Ad Manager | Campaign detail | Builder | Hub | Products | Change Log | Digest |
|---|---|---|---|---|---|---|---|---|
| C1 folder-per-page / file-per-unit | ✅ `_dash/` | ✅ | ✅ `tabs/`+`modals/`+`[agId]` | ✅ `_wizard/steps/` | ✅ `tabs/`+`rules/` | ✅ `modals/` | ✅ | ✅ single 189-line file (no monolith) |
| C2 tables via AdsDataGrid | n/a | ✅ | ✅ (all grids) | n/a | ✅ (Suggestions/Applied) | ✅ | ✅ | n/a (payload lists) |
| C6 DateRangePicker | ✅ header | ✅ toolbar | ✅ | n/a | n/a | ✅ toolbar | n/a (event log) | n/a (week-scoped picker) |
| C7 `money()`/`eurC` never hardcoded € | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (chart axis formatters excepted by design) |
| C8 Amazon-style metric names + ROAS | ✅ | ✅ | ✅ | ✅ | ✅ (rule labels) | ✅ | n/a | ✅ |
| C9 shared StatusPill/ebayStatusPill | ✅ | ✅ | ✅ | n/a | n/a | pills kept for states | pills | chips |
| C13 ER# file headers | ✅ all files | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| C14 `/api/ebay-ads` namespace only | ✅ (grep: zero out-of-namespace calls in the tree) | | | | | | | |
| X4 window.confirm/prompt | **0 remaining** — 6 grep hits are comments documenting the replacements | | | | | | | |

Largest file: `RuleEditor.tsx` 338 lines (v1 peaked ~1,500 in single-file pages). No
preset `<select>` date controls remain anywhere in the tree.

## 2 · Shared-component census

Consumed by the eBay tree (import counts): `campaigns/_grid/AdsDataGrid` (13),
`campaigns/_grid/format` (15), `_shell/AdsPageHeader` (5 pages), `_shell/DateRangePicker`
(2 direct + header built-in), `_shared/StatusPill` (2), `_shell/CampaignDetailHeader`
(detail), `_shell/nav.ts` (rail).

Additive props introduced across ER (definition site + consumers verified by grep):

| Prop / change | Where | Non-eBay consumers | Amazon risk |
|---|---|---|---|
| `channel` + `EbayMark` | AdsPageHeader (ER1) | none | default `'amazon'` — proven identical ER1 |
| `channel`, `titleBadges` | CampaignDetailHeader (ER1) | none | defaults preserve markup |
| `.h10-menu button.danger` CSS | ads.css (ER1) | rule was MISSING before; adds color to a class Amazon already emitted | verified ER1 |
| `filterPresetsKey` | AdsDataGrid (ER3.1) | none | renders nothing when absent — proven identical ER3.1 |
| `initialFilters` | AdsDataGrid (ER3.3) | none | `?? {}` fallback — proven ER3.3 |
| `rowClassName` | AdsDataGrid (ER3.5) | none | empty concat when absent — proven ER3.5 |
| `EBAY_ADS_NAV` entry + sidebar counterpart maps | nav.ts / AdsSidebar (ER3.4) | Amazon array untouched | verified ER3.4 |

Every phase carried an Amazon before/after prod snapshot; all identical (data drift from
concurrent sessions noted where seen, rendering unchanged).

## 3 · `eb-*` CSS audit (`ebay.css`)

- **82** `eb-*` classes defined; **0 dead** (every class referenced from the eBay tree).
- Deliberate cross-class overrides inside `ebay.css` (safe: the file is imported ONLY by
  eBay pages — grep: zero non-eBay importers):
  - `.dash-row2 > .dash-card { min-width: 0 }` (ER3.3 grid-blowout guard)
  - `.eb-changelog … .nm.fz { left: 0 }` (ER3.4 — page-scoped correction of the shared
    sticky-offset defect, see fix F1)
- `dashboard/dashboard.css` and `ads.css` consumed, never edited beyond the two additive
  ER1 rules recorded above.

## 4 · a11y · perf · i18n

- **a11y**: 73 `aria-*`/`role` attributes across the tree; tab bars use `role=tablist/tab`
  + `aria-selected`; toggles use `role=switch aria-checked`; menus carry `aria-label`;
  live regions on preview (`aria-live=polite`) and toasts (`role=status`); grid keyboard
  nav available via the shared grid where opted.
- **perf**: every page is route-split by Next (App Router); the heaviest new page
  (RuleEditor) is a leaf route; grids paginate at 100; dashboard fetches 4 endpoints in
  parallel; no new dependencies were added across the entire ER series (sparklines are
  hand-rolled SVG).
- **i18n**: the ads console is deliberately English-only — matching the Amazon console
  and the operator-language decision on record; listing CONTENT stays Italian elsewhere.
  No `t()` catalog entries required; the i18n hook passes.

## 5 · Fix register (presented at the ER4 gate)

**Amazon-gated (shared files — each needs its own approval + before/after snapshots):**

- **F1 · Sticky first-column offset** — `ads.css` `.nm.fz { left: 40px }` assumes the
  40px checkbox column; `selectable={false}` grids get a 40px overlay on column 2
  (root-caused ER3.4; page-scoped override shipped for the eBay Change Log). Proper fix:
  a `nosel` modifier class emitted by AdsDataGrid when `selectable === false` +
  `left: 0` rule. **Affects Amazon ad-group sub-grids (improves the same clip there).**
- **F2 · Total row ignores filters** — `GridColumn.total` is parent-computed over ALL
  rows; filtering leaves stale totals on BOTH consoles (recorded ER3.1). Proper fix:
  optional `totalValue(row)=>number` aggregated by the grid over filtered rows, falling
  back to the static `total`. Additive, but changes what Amazon totals display when
  filters are active (arguably a correctness fix). Larger than F1.

**eBay-only (can ship inside ER4 on approval):**

- **E1** · Hub rule-menu "Run now" renders enabled on disabled rules but the evaluator
  only runs enabled rules — grey it out with a tooltip.
- **E2** · Digest per-marketplace split (generator work) — backlog.
- **E3** · `estimatedImpact` on proposals (fee-delta modelling) — backlog.
- **E4** · PRI listing-attach write-layer gap (from ER2 findings) — backlog.
- **E5** · Products unmatched-band placement — decided (stays last; deep link shipped).

## 6 · Scorecard

See `SCORECARD.md` (beat-checklist §7 verdicts). Change record: `CHANGELOG.md`.
