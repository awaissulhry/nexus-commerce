# ER3.3 — Dashboard (`/marketing/ads/ebay`)

Mini-spec per Part VIII (double gate). Sources: CURRENT-STATE-CRITIQUE §2.3 ("honest but
thin" — raw Status dump, no Recommendations surface, no pacing visual, preset-only dates,
no alert link-through, no sparklines), COMPETITOR-TEARDOWN verdicts tagged "ER3 Dashboard"
(Teikametrics Recommendations hub with **transparent eligibility criteria** → adopt; Seller
Hub "Today's recommendations" → adapt, "ours carry margin context Seller Hub can't have";
Teika Budget Pacing with honest data-lag definitions → adapt), D1 (DateRangePicker
everywhere).

**Ground truth that shapes this spec** (verified in code, 2026-07-03):

- `EbayDashboard.tsx` is 141 lines: KPI strip (7 tiles + deltas), fees-vs-sales
  `PerformanceGraph`, Alerts card (anomalies endpoint), Status card = raw key/value flex
  dump, date = preset `<select>` inside the chart card header.
- It imports **Amazon's `dashboard/dashboard.css`** — that file stays untouched; every new
  style lands in `ebay.css`.
- All data for a Recommendations panel already exists server-side: unmatched/missing-cost
  listings (products payload + `economicsStatus`), coverage gap (summary + the coverage
  guard's PENDING `enroll_catch_all` proposal), campaigns-without-rules (ER3.1's
  `automation.rules` logic), rates-above-break-even (ads `bidPercentage` vs
  `EbayListingEconomics.breakEvenAdRatePct`).
- Pacing data exists: `checkSpendCeilings()` (MTD vs cap per marketplace, exposed via
  `/automation/state`), campaigns payload (`dailyBudgetCents`, `limitedByBudget`,
  `fundingModel`), `EbayAdsDailyPerformance` yesterday campaign-grain fees.
- `detectAnomalies()` returns `{type, severity, message, entityId?}` — `entityId` is the
  **external** campaign id on `campaign_ended_externally` / `dynamic_rate_over_cap`; no
  internal id, so the UI can't route to the campaign page yet.
- `useEbayAdsFetch` accepts `{start,end}` ranges since ER3.1; `AdsPageHeader` has the
  DateRangePicker props (used by the eBay Ad Manager since ER3.1).

## The 9 deltas

**1 · C1 structure** — decompose into file-per-card: `EbayDashboard.tsx` (shell) +
`_dash/KpiStrip.tsx` · `TrendCard.tsx` · `RecommendationsCard.tsx` · `PacingCard.tsx` ·
`AlertsCard.tsx` · `StatusCard.tsx`. ER# headers (C13). Banners (sandbox, missing-cost)
stay in the shell.

**2 · Recommendations panel** (the headline; Teika adopt + Seller Hub adapt). New card,
top-left of row 2. Five types, each computed live server-side and rendered as: count pill ·
title · **its eligibility criteria in one sentence** (the Teika idiom — no black box) ·
prefilled CTA:
- *Unmatched listings* — promoted listings with no product match → "Match products" →
  `/ebay/products` match queue.
- *Missing costs* — listings in active campaigns with `MISSING_COGS` → "Enter costs" →
  `/ebay/products` (criteria: break-even unknown ⇒ automation manual-only).
- *Unpromoted live listings* — live inventory in no active General campaign → if the
  coverage guard already has a PENDING `enroll_catch_all` proposal, "Review enrollment" →
  hub **Suggestions**; else "Start catch-all" → builder General template.
- *Campaigns without rules* — RUNNING campaigns no enabled rule covers (ER3.1 scope
  semantics) → "Add a rule" → hub `rules/new`.
- *Rates above break-even* — ACTIVE ads whose rate exceeds the listing's break-even (the
  margin context no competitor has) → "Repair" → hub `rules/new?template=Rate above
  break-even — repair (CPS)`.
Rows with count 0 hide; all-zero ⇒ "Nothing to recommend — matching, costs, coverage and
margins look clean." Samples (≤3 entity names) render under each row title.

**3 · Budget pacing card** (Teika adapt; honest lag). Row-2 card: per marketplace — MTD
attributed fees vs monthly ceiling as a bar (green <80% / amber ≥80%) + **straight-line
month-end projection** (mtd ÷ day-of-month × days-in-month, labelled "straight-line") ·
CPC block — Σ daily budgets of RUNNING CPC campaigns, yesterday's CPC fees as utilisation %
of that Σ, and an "N limited by budget" chip deep-linking to the Ad Manager's LIMITED
status filter. Footnote states the honesty constraints: fees reconcile ~72h; eBay may
spend 2× the daily budget in a day (monthly cap 30.4×).

**4 · Status card decomposition** — the raw dump becomes three labelled groups in one card:
**Campaigns** (status counts as pills, click → Ad Manager) · **Coverage** (n/m bar + % —
kept amber/green semantics) · **Data** (attribution "any-click (30d)" · facts/entities
freshness timestamps · 72h note). No mixed key/value row.

**5 · DateRangePicker in the header** (D1/X3) — `showDateRange` + real `{start,end}` on
`AdsPageHeader`, driving summary + trend + KPI deltas together (fetch layer already
accepts ranges). The preset `<select>` inside the chart card is removed.

**6 · Trend card metric views** — chip row on the chart card: **Fees + Sales** (default) ·
**Fees + ACOS** · **Clicks + Impressions**. Same `TrendPayload` (points already carry
acosPct/clicks/impressions), three `PerformanceGraph` configs, pure client.

**7 · KPI strip upgrade** — add a **ROAS** tile (C8 parity with the ER3.1 grids); SOLD tile
gains a CVR subtext (sold ÷ clicks); metric tiles gain **sparklines** (tiny inline SVG from
the trend points — no new dependency).

**8 · Alerts link-through** — `detectAnomalies()` additionally returns the **internal**
`campaignId` on the two campaign-scoped types (select already fetches the campaign row);
type-aware row targets: campaign-scoped → campaign detail; `nexus_ebay_drift` → hub Drift
tab; account-grain (`fee_spike`, `ctr_collapse`) → Ad Manager sorted by fees. Rows with a
target render a chevron and navigate; severity dot + type pill stay.

**9 · API surface** — ONE additive endpoint: `GET /ebay-ads/dashboard` returning
`{ recommendations: [...], pacing: {...} }` (types, counts, criteria strings, samples,
CTA refs; ceilings + CPC budget/yday-fee aggregates). Summary/trend/anomalies endpoints
unchanged except the additive `campaignId` field (delta 8). C14 namespace; RBAC as the
existing routes. **No migration.**

## Non-negotiables honoured

- **Amazon untouched**: `dashboard/dashboard.css` is consumed, never edited — new classes
  go to `ebay.css` (`eb-dash-*`). No shared component edits planned. Identical-after
  snapshot of `/marketing/ads` (Amazon Dashboard) regardless.
- **No fake data**: every recommendation count/sample comes from live queries with its
  criteria stated; projection is labelled straight-line; zero-count rows hide rather than
  pad the panel.
- **Guarded writes only** — the dashboard writes nothing; every CTA lands on an existing
  surface (match queue, cost entry, builder template, hub) where writes are already gated.
- Reversible: single revert.

## Verification script (gate 2)

Smoke (`_er33-smoke.mts`): GET /dashboard → 5 recommendation types, each count
cross-checked against a direct DB query (match-status, MISSING_COGS, coverage,
rules-scope, rate>BE); pacing block (Σ CPC budgets, yday fees, MTD/cap echo, projection
maths); anomalies carry internal campaignId on campaign-scoped types; /summary + /trend
still serve presets AND explicit ranges. Prod click-through: header range picker drives
KPIs+chart; chart view chips; recommendations rows + CTAs land on the right surfaces;
pacing bars + LIMITED deep link; status groups; alert row navigates; sparklines render.
Amazon `/marketing/ads` before/after identical. `tsc` + builds green; unit tests for the
projection/utilisation maths (pure helpers).

## Rollback

Single revert (no migration; no shared-file edits).
