# Study 00 — `/marketing/ads` UI inventory (authoritative)

**Route(s):** `apps/web/src/app/marketing/ads/**`
**Date:** 2026-06-22 · **Status:** final (Phase 0 deliverable)

The complete map of what we're extracting. Every visual element in the ads
surface, its current location, whether it's a reusable building block or a
one-off, and its target home + phase in the design system. This is the contract
for Phases 1–5.

**Scale:** 75 `.tsx` + 7 `.ts` + 4 `.css` (~11,900 LOC). Self-contained —
**nothing outside `marketing/ads` imports it**, and `ads.css` is imported once
(in `marketing/ads/layout.tsx`). Clean to extract.

---

## 1. Surface / route map

| Route | Purpose |
|---|---|
| `/marketing/ads` → `/dashboard` | index redirect |
| `dashboard/` | account dashboard |
| `campaigns/` + `campaigns/[id]/` + `…/ad-groups/[agId]/` | Ad Manager grid → campaign drill-in → ad-group drill-in (tabbed) |
| `campaign-builder/` | campaign-type chooser (AI Goal / Quick / Guided / SP wizard / Single) |
| `ai-advertising/` + `new-goal/` | AI product-goal dashboard + full-screen goal builder |
| `rules-automation/` (`tabs/`, `_shared/`, `_schedule/`, `_rank/`, `builder/`) | rules engine: bid/budget/placement/SOV/rank/schedule |
| `suggestions/` | AI suggestions feed |
| `analytics/`, `reporting/` (+ `brand-metrics/`), `amc/` (+ `audiences/`) | reporting suite + AMC |
| `budget-manager/`, `account-overview/`, `account-settings/`, `changelog/` | account/management surfaces |

## 2. CSS architecture

All styling is hand-authored `.h10-*` classes (no Tailwind, no CSS modules) —
hardcoded hex throughout, almost no CSS variables.

| File | Lines | Scope |
|---|---|---|
| `ads.css` | 1778 | shell, rail, header, Ad-Manager grid, filters, modals, date picker, charts, builders, pills |
| `rules-automation/rules-automation.css` | 635 | rule builder, IF/AND/THEN rows, campaign picker (`cp-*`), schedule (`h10-sb-*`) |
| `rules-automation/_schedule/dayparting.css` | 75 | 7×24 heatmap, chart, enable/pause preview |
| `suggestions/suggestions.css` | 34 | suggestions table + approve/dismiss |

**Class families** (→ become tokenized in Phase 1, renamed in Phase 9):
`h10-shell/rail/main/brand/nav/item/group` · `h10-hdr/hbtn/hsel/menu` ·
`h10-cd-*` (detail header) · `h10-dp-*` (date picker + heatmap) ·
`h10-am-*` (Ad Manager grid/filters/toolbar/pager/graph) · `h10-pill(.ok/.warn/.arch)` ·
`h10-modal(-backdrop/-h/-sub/-b/-f/-x)` · `h10-edit-*` · `h10-radio-card` ·
`h10-cb-*` (campaign builder) · `h10-rb-*` + `cp-*` (rule builder) ·
`h10-sb-*` (schedule) · `h10-aig` (AI goal) · `h10-tip` · `h10sh` (skeleton shimmer).

## 3. Design tokens observed (→ Phase 1; full mapping in `../docs/TOKEN-RECONCILIATION.md`)

- **Color — text:** primary `#1c2530`, secondary `#5b6573`, tertiary `#8a93a1`,
  disabled `#aeb6c2`.
- **Color — surface:** canvas `#f4f6f9` (+ `#f1f3f5`/`#f1f4f8` hovers), card
  `#fff`; focus wash `#eef5ff`, soft `#e7f0fd`.
- **Color — border:** subtle `#e6e9ee`/`#e3e7ec`, default `#d8dde4`, strong `#c2c9d3`.
- **Color — brand:** primary `#1f6fde`; chart navy `#002f66`/`#0b2447`.
- **Color — status:** success `#1e9e62`/`#15a34a`/`#1a7f37`; warning
  `#9a6700`/`#c2410c` on `#fdf3d3`; danger `#e5484d`/`#c0392b` on `#fde8e8`;
  info `#1f6fde` on `#e7f0fd`.
- **Color — program/targeting badges:** SP `#6d28d9`/`#f3e8ff`, SD
  `#0e7490`/`#e0f2fe`, SB `#b45309`/`#fef3c7`, Auto(A) `#134da3`, Manual(M) `#7400bc`.
- **Type:** `--font-sans` (Inter); sizes 10–27px; weights 500–800; H1 27/800
  `-0.02em`; **`-webkit-font-smoothing: auto`** (heavier than the app's antialiased).
- **Spacing:** 2/4/8/10/12/14/16/18/20/22/26/30 px. Rail 66→344px; rows 30/46px.
- **Radius:** 6/7/8/10/12/14 (pills 4–5).
- **Shadow:** card `0 6px 22px rgba(20,28,38,.16)`; menu `0 12px 32px …`; modal
  `0 18px 48px …`; rail-hover `8px 0 30px …`.
- **Motion:** `.12–.18s ease`; skeleton shimmer 1.3s.
- **Breakpoints:** 1320px (filter grid 6→3 col), 760px (→2 col).

## 4. Shell & layout (`_shell/`) → `patterns/` (Phase 5)

| Component | File | Notes |
|---|---|---|
| `AdsSidebar` | `_shell/AdsSidebar.tsx` | left rail 66→344px hover-expand; collapsible groups; pending-suggestions badge (60s poll) |
| `AdsPageHeader` | `_shell/AdsPageHeader.tsx` | eyebrow+title+subtitle / Learn · Data Sync · DateRange · Market · Action; exports `RANGE_PRESETS`, `rangeBounds`, `rangeLabel` |
| `CampaignDetailHeader` | `_shell/CampaignDetailHeader.tsx` | back-link + targeting badge + title + same controls |
| `DateRangePicker` | `_shell/DateRangePicker.tsx` | dual-month calendar + 15 presets → **also a `components/` primitive** |
| `builder-icons` | `_shell/builder-icons.tsx` | 8 custom SVG icons → `primitives/icons/` |
| `nav.ts` | `_shell/nav.ts` | `ADS_NAV[]` + icon catalog (feature data, stays in ads) |

## 5. Primitives (atoms) → `primitives/` (Phase 3)

| Primitive | Source | Notes |
|---|---|---|
| Button | `.h10-hbtn` (+ `.primary/.ghost/.acct`) in `ads.css` | reconcile with `components/ui/Button` (189 imports) |
| IconButton | `.h10-modal-x`, toolbar icon btns | |
| Input / money input | `.h10-edit-in`, `.h10-edit-money`, `.h10-cd-money` | € / % adornments |
| Select | `H10Select` in `campaigns/FilterDropdown.tsx` | portaled, auto-flip |
| MultiSelect | `MultiSelect` in `campaigns/FilterDropdown.tsx` | "Select All" indeterminate |
| Checkbox / Radio / RadioCard | `.h10-radio-card` (`CreateAdGroupModal`) | |
| Toggle/Switch | `.h10-toggle` (`ads.css`) | |
| Chip / status Pill | `.h10-pill(.ok/.warn/.arch)` | |
| Badge (program/targeting) | `.pb[data-p]`, `.tg[data-t]` | component tokens |
| Tooltip | `InfoTip` (`campaigns/InfoTip.tsx`) | portal, flips, arrow tracks icon |
| Spinner | Data-Sync button spinner | |
| Skeleton | `.h10sh` shimmer | |
| Kbd / Divider | inline | |

## 6. Components (molecules) → `components/` (Phase 4)

| Component | File (lines) | Notes / generalization |
|---|---|---|
| **DataGrid** | `campaigns/_grid/AdsDataGrid.tsx` (519) | the universal grid: 44-col catalog, metrics/edit modes, filters, selection, totals, pager, sticky cols. **De-ads-ify** `GridColumn<T>` API |
| CampaignsGrid | `campaigns/CampaignsGrid.tsx` (1445) | page-specific wrapper around DataGrid (stays in ads; consumes DS DataGrid) |
| FilterDropdown / HoverCard | `campaigns/FilterDropdown.tsx` (246) | exports `FilterDropdown`, `H10Select`, `MultiSelect`, `HoverCard` — split atoms vs molecule |
| Modal chrome | `.h10-modal-*` + `CreateAdGroupModal`, `SearchTermActionModal`, `AddNegativeKeywordsModal`, `AddProductsModal` (185), `AddKeywordsTargetsModal` (155) | one `Modal` + `ModalHeader/Body/Footer` |
| Tabs | `RulesAutomationClient` (408), campaign/ad-group tab routers (URL-driven) | |
| Card | `.h10-cb-card`, `.h10-rb-card`, dashboard cards | |
| Toast | (ads uses inline status) | reconcile with `components/ui/Toast` (144 imports) |
| EmptyState | `rules-automation/_shared/NoDataIllus.tsx`, `suggestions` empty | |
| Pagination | `.h10-am-pager` | |
| DateRangePicker | `_shell/DateRangePicker.tsx` (also §4) | |
| SearchInput | `.h10-am-search` | |
| ProgressBar | builder progress | |
| MetricStrip / KPI | `_shared/ads-ui/MetricStrip.tsx`, dashboard KPI strips | already partly shared |

## 7. Patterns (organisms) → `patterns/` (Phase 5)

| Pattern | Source (lines) | Notes |
|---|---|---|
| AppShell | `marketing/ads/layout.tsx` + `_shell/AdsSidebar` | generalized shell other sections adopt |
| PageHeader / DetailHeader | `_shell/AdsPageHeader`, `CampaignDetailHeader` | |
| **Builder framework** | `rules-automation/_shared/RuleBuilder.tsx` (1222), `ai-advertising/new-goal/AiGoalBuilder.tsx` (415), `rules-automation/_rank/RankGoalBuilder.tsx` ⚠WIP | full-screen wizard + scroll-spy nav; extract the shell, defer `_rank` until committed |
| CampaignBuilder | `campaign-builder/CampaignBuilder.tsx` | type-chooser cards + profile picker |
| FilterPanel | `.h10-am-fpanel` (in `CampaignsGrid`) | accordion, range/select/multi, presets, save-to-library |
| BulkActionBar | `campaigns/_grid/bulkActions.tsx` + `.h10-bulkrow` | |
| ColumnCustomizer | Customize-Columns modal (`CampaignsGrid`) | dnd reorder + per-group visibility + localStorage |
| EditModeBar | `.h10-am-editbar` sticky | discard/apply |
| ScheduleBuilder | `rules-automation/_schedule/ScheduleBuilder.tsx` (514) + `CampaignSection` (180) | frequency UI |

## 8. Charts / visualization → `components/` (Phase 4)

| Chart | File (lines) | Notes |
|---|---|---|
| PerformanceGraph | `campaigns/AdManagerGraph.tsx` (289) | Recharts dual-axis combo + metric pickers + drag-resize + tooltip |
| Heatmap | `rules-automation/_schedule/DaypartingHeatmap.tsx` | 7×24, 6-step scale, tooltip |
| RankTimeGrid / RankPlanBody | `_rank/*` ⚠WIP (155/272) | defer until committed |

## 9. Hooks & utilities → `tokens/` + `primitives/` + a `lib`

| Util | Source | Notes |
|---|---|---|
| Formatters | `_shared/ads-ui/format.ts` (`eur`,`eur0`,`num`,`pct`,`x2`,`eurMicros`) **and** `campaigns/_grid/format.ts` | **duplicated — consolidate to one** |
| `useClickAway` | `campaigns/FilterDropdown.tsx` | promote to shared hook |
| Portal positioning | InfoTip / HoverCard / H10Select (`useLayoutEffect` + `createPortal`) | shared popover-position helper |
| Date helpers | `DateRangePicker.tsx` (`sod`,`addMonths`,`sameDay`) | |
| `StatusChip` | `_shared/ads-ui/StatusChip.tsx` | → primitives |

## 10. Data / state patterns (informational — not extracted)

- Fetch via `getBackendUrl()` → `/api/advertising/*`; `{ ok, … }` envelopes.
- Date range = local state, lifted via `onDateRange`; default last-7-days.
- Grid selection = `Set<string>` prop-managed; tabs = URL `?tab=`.
- Sidebar polls pending suggestions (60s). Some surfaces SSE-reactive.

## 11. Reuse classification

- **Truly reusable (extract):** DataGrid, FilterDropdown family, Modal chrome,
  DateRangePicker, InfoTip, charts, MetricStrip, status pills/badges, the Builder
  framework, AppShell/PageHeader, EmptyState, formatters, `useClickAway`.
- **Page-specific (stays in ads, consumes DS):** CampaignsGrid, the per-tab
  bodies (DetailsTab, AdGroupsTab, SearchTermsTab…), CampaignBuilder,
  RulesAutomationClient, dashboards, `nav.ts`, `ruleTypes.ts`.

## 12. Gaps, risks & constraints (carry into later phases)

- **No design tokens** — ~80+ hardcoded hex in `ads.css`; the Phase-1 job.
- **No dark mode** — light-only; tokens must be built dark-ready (Phase 1/6).
- **Not a11y-audited** — pixel-tuned but focus/ARIA/keyboard/contrast need a pass
  (Phase 6). Font-smoothing `auto` is a deliberate heavier-text choice to capture
  as a token, not "fix".
- **Duplication** — two `format.ts`; multiple near-identical modals; overlapping
  green/blue shades. Consolidate during extraction.
- **Live WIP** — `_rank/` (RankGoalBuilder/RankPlanBody/RankTimeGrid/RankTarget/
  RankBlend/DeliveryChip/DemandReadout/rank-grid-model) + the B-series budget
  builder are **uncommitted/active**. Defer these until committed.
- **Untouchable** — never edit `/products/amazon-flat-file` or
  `/products/ebay-flat-file`; they converge via shared tokens only.

## 13. Master mapping (element → DS home → phase)

| Current | DS home | Phase |
|---|---|---|
| `ads.css` hardcoded values | `tokens/` + `styles/tokens.css` | 1 |
| `ads.css` rules (rewritten to `var()`) | `styles/` | 1 |
| Buttons, inputs, selects, checkboxes, toggles, pills, badges, tooltip, spinner, skeleton, builder-icons | `primitives/` | 3 |
| AdsDataGrid, FilterDropdown family, Modal, Tabs, Card, EmptyState, Pagination, DateRangePicker, SearchInput, ProgressBar, charts, MetricStrip | `components/` | 4 |
| AppShell, PageHeader, DetailHeader, Builder framework, FilterPanel, BulkActionBar, ColumnCustomizer, EditModeBar, ScheduleBuilder, CampaignBuilder | `patterns/` | 5 |
| formatters, useClickAway, portal-position, date helpers | shared `lib`/hooks | 4 |
| `_rank/*`, budget-builder | `patterns/`/`components/` | 5 (after WIP commits) |
| page bodies, dashboards, `nav.ts`, `ruleTypes.ts` | stay in `marketing/ads` | — |
