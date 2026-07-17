# Ads Mission Control — Arc E: Complete the Cockpit — Plan

> Breadth arc: surface the ~20 already-built backend capabilities + fill the 9 stub pages + wire the 3 partial rule tabs, so `/marketing/ads` is a complete, best-in-class cockpit. **Owner-approved sequencing (2026-06-30): Arc E first · legacy surfaces retired at the end · writes stay gated/dry-run-default until explicitly flipped.** Each phase gets verified (tsc + tests where logic exists + native screenshot on :3000) and committed; built on the existing DS + H10 tokens, image-free, read-only unless noted (mutations reuse the existing gated endpoints).

## Global constraints
- Light H10, image-free, design-system components; no new deps; **no backend changes** unless a phase explicitly needs one (most are consume-existing-endpoint). Writes (where present) reuse the existing **write-gated** PATCH/POST endpoints, dry-run-default.
- Verify each phase: `tsc` clean; pure logic unit-tested; native screenshot on dev **:3000** (CORS-allowlisted). Commit per phase (`git commit <paths>`); push when the shared tree is buildable.
- Date-range: until Arc Q wires the global selector, pass `windowDays=30` to match the header (the reconciliation lesson).

## Phases

### E1 — Wire the 3 partial rule tabs
- Files: `rules-automation/RulesAutomationClient.tsx` (+ tab components), `tabs/placeholderSeeds.ts`.
- Replace placeholder seeds for **Bid · Keyword-Harvest · Negative-Targeting** with real `RuleListTab` `liveType` calls (`GET /advertising/automation-rules` filtered by action.type), matching the already-real Budget/Placement/Dayparting tabs. Acceptance: each tab shows real rules (or a proper empty state), no seed rows.

### E2 — Dashboard (the landing page)
- Files: new `dashboard/DashboardClient.tsx` (replace the stub `dashboard/page.tsx`).
- KPI strip + trend chart + health/alerts summary + top movers. Consume `GET /advertising/summary` · `/trends` · `/alerts` · `/momentum`. Acceptance: landing shows live account KPIs + a chart, no "pixel-match in progress" stub.

### E3 — Recommendations inbox
- Files: new `recommendations/` page.
- Consume `GET /advertising/recommendations` (+ `/brief`); Approve/Dismiss/edit-before-apply (mirror the Suggestions UX); applies via existing gated endpoints. Acceptance: real ranked recs with one-click (gated) apply + dry-run.

### E4 — Alerts / campaign health
- Files: new `alerts/` page (or Dashboard panel).
- Consume `GET /advertising/alerts` (+ anomaly-guard); CPC-spike/ROAS-drop/budget-exhaustion/zero-sales with drill-through to the object. Acceptance: live alerts list with severity + links.

### E5 — Search-terms + n-gram + harvest/negate loop
- Files: new `analytics/search-terms/` (or a Reports section).
- Consume `GET /advertising/reports/search-terms` · `/ngrams` · `/reports/negative-keyword-candidates`; wasted-spend view → one-click (gated) negate / graduate-to-exact. Acceptance: real search-term rows + harvest/negate actions (gated).

### E6 — Dayparting heatmap intelligence
- Files: reuse DS `Heatmap`; new section in `analytics/` or `rules-automation`.
- Consume `GET /advertising/dayparting/heatmap` · `/orders-dayparting` (Rome TZ); 7×24 order-velocity heatmap → "apply as schedule". Acceptance: heatmap renders real data; apply creates an `AdSchedule` (gated).

### E7 — Analytics
- Files: replace stub `analytics/page.tsx`.
- Trends + **true-profit P&L** (`/profit`) + **iROAS/incrementality** (`/incrementality`) + **SoV trends** (`/share-of-voice`). Acceptance: multi-tab analytics with real charts.

### E8 — Reporting + scheduled export + Brand Metrics
- Files: replace stubs `reporting/page.tsx`, `reporting/brand-metrics/page.tsx`.
- Consume `GET /advertising/reports` · `/bulk/export` (xlsx via exceljs) + brand metrics. Acceptance: report list + bulk export download + brand KPIs.

### E9 — Automation health + execution/audit log
- Files: new `automation-health` view or `rules-automation` drawer.
- Consume `GET /advertising/automation-health` · `/automation-feed` · `/events` · `/actions/:id/log`. Acceptance: per-rule firing history + impact + errors + audit timeline.

### E10 — Portfolios + budget-pool rebalancing
- Files: new `portfolios/` + Budget Manager enhancement.
- Consume `GET /advertising/portfolios` · `/budget-pools` (+ `/rebalance`, `/allocations`). Acceptance: portfolio roster + cross-campaign pool rebalance UI (gated).

### E11 — Account Overview + Settings
- Files: replace stubs `account-overview/page.tsx`, `account-settings/page.tsx`.
- Connections + write-mode + AMS subscriptions (`/marketing-stream`) + retail-readiness (`/retail-readiness`) + reconciliation (`/reconcile`). Acceptance: connection health + the **enable-writes** surface (read-only display; flipping stays operator-gated per decision).

### E12 — AMC + Audiences + DSP
- Files: replace stubs `amc/page.tsx`, `amc/audiences/page.tsx`; new `dsp` if needed.
- Consume `/audiences` (+templates) · `/dsp` (+meta). Acceptance: audience roster + DSP plan list (live needs entitlement; degrade gracefully).

### E13 — Changelog
- Files: replace stub `changelog/page.tsx`.
- Feature/changelog feed (static or from `/events`). Acceptance: real changelog, no stub.

### E14 — Target-ACoS fleet
- Files: new `target-acos` view.
- Consume `GET /advertising/target-acos/fleet`; all-campaigns profit-native target-ACoS in one revenue-ranked grid. Acceptance: fleet grid + (gated) bulk apply.

## Notes
- Several E-phases overlap Arc A (E9 ↔ provenance/P9; E10 ↔ budget; rank-defense ↔ P6) — build the cockpit view now; the canvas/agent integration folds in during Arc A.
- Reuse existing components heavily (AdsDataGrid, DS Heatmap/PerformanceGraph/MetricStrip/Drawer/Modal, the Suggestions inbox pattern for E3/E4).
- Each phase is independently shippable; order is by impact (E1 quick win → E2 landing → E3/E4 action hubs → intelligence → completeness).
