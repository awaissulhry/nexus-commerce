# E3 — eBay Ads Console (read/analytics)

> eBay Ads workstream, Phase E3. UI placement per the user-confirmed decision: **inside the `/marketing/ads` shell** (the H10-style console). Zero edits to existing Amazon pages. Read-only — every write surface waits for E4.
>
> **E4.1 update (user direction 2026-07-03): ONE console, channel-switched.** The separate "eBay Ads" nav group was replaced by an **[Amazon | eBay] switch in the rail's brand area**: same rail, same layout; eBay mode renders Dashboard / Ad Manager / Products against the eBay routes below, then the on-page market dropdown narrows further (channel → market, exactly the intended flow). Switching keeps you on the counterpart page (Ad Manager ↔ Ad Manager). Pages stay physically separate under the hood so the in-flight Amazon grid and the eBay grid can never interfere; merging into one grid with a channel dropdown remains the later convergence path.

## Pages (apps/web/src/app/marketing/ads/ebay/**)

| Route | What |
|---|---|
| `/marketing/ads/ebay` | Dashboard: KPI strip (ad fees, any-click ad sales, eBay ACOS, clicks + avg CPC, impressions + CTR, campaign counts) with **vs-previous-period delta chips** (E1 `priorRange`), fees-vs-sales daily trend (dual-axis), missing-COGS banner ("manual only" listings), empty/error/skeleton states |
| `/marketing/ads/ebay/campaigns` | Campaign grid: strategy facet (All/General/Priority/Offsite) + status facet + range preset; columns incl. rate-or-budget, ads count with **stale** badge, window metrics, eBay ACOS; sortable; sticky first/last columns; row → detail |
| `/marketing/ads/ebay/campaigns/[id]` | Detail. Header: strategy/status/rules-based/managed-by/rate-strategy chips (dynamic-rate cap in tooltip), campaign rate or daily budget + **"N / 15 budget edits today"** quota. General: ads table with **rate-at-ad-level** (inherited campaign default shown in parens), **break-even column** (or "add cost" state), listing state incl. STALE/listing-ended, per-listing window metrics, ebay.it links. Priority manual: keywords table (match type, ad group, bid — shows "dynamic" + locked note under DYNAMIC bidding) + EXACT/PHRASE negative chips. Smart: ads only (no groups/keywords, per eBay). Offsite: explanatory empty state (campaign-level only) |
| `/marketing/ads/ebay/products` | **Product-first rollup**: every product with its live item-ID chips (the resolver union), aggregated window metrics, cost-readiness badge; plus the **Unmatched live listings** panel (legacy no-SKU items) with their real ad performance — nothing hidden |

Shared: `ebay/_shared.tsx` (API types, `useEbayAdsFetch`, formatters, FreshnessLine — "Data as of: facts/entities/listings … · attribution: any-click (30d)" — Strategy/Status/BreakEven chips), `ebay/ebay.css` (chips + panels; DS carries the rest). Components: `AdsPageHeader` (built-in marketplace switcher), grid-lens `KpiStrip` (delta chips), DS `DataGrid`/`PerformanceGraph`/`Banner`/`EmptyState`/`Skeleton`/`Select`/`SegmentedControl`.

## API (apps/api/src/routes/ebay-ads.routes.ts, `/api/ebay-ads/*`)

`GET /summary` (KPIs + priorRange deltas + campaign/economics counts) · `GET /trend` (daily series, adaptive bucket) · `GET /campaigns` (grid rows + window aggregates + ads/stale counts) · `GET /campaigns/:id` (ads joined to listing index title/price/qty + economics break-even; ad groups; keywords + keyword facts; negatives) · `GET /products` (rollups via `EbayListingIndex.productIds` + unmatched) · `GET /status` (cron runs + table counts). All responses: integer cents + currency + `freshness` timestamps; ACOS explicitly = fees ÷ **any-click-attributed** sales.

RBAC: `/api/ebay-ads` was already mapped in `permissions-manifest.ts` (reads → `ads.view`, writes → `ads.campaigns.manage`) — deny-by-default holds; an unauthenticated curl 401/403s by design.

## Verification

1. Backend smoke (real prod data, fastify inject — `apps/api/scripts/_e3-smoke.mts`): all six endpoints **200** — summary fees €55.28 / sales €354.89 / ACOS 15.6%; trend 28 daily points; 11 campaigns; detail CPS "Back Protector" (2 ads, 18.4% ad rate, break-even "add cost"); detail CPC "Xavia Gale" (3 ad groups, 12 keywords, 12 negatives); products 76 + 16 unmatched.
2. `tsc --noEmit` clean in both workspaces; pre-push full-workspace build green.
3. Click-through after deploy: `/marketing/ads` → "eBay Ads" nav group → Dashboard / Campaigns (open "Back Protector") / Products.

## Known limits (deliberate, tracked)

- Net-margin-after-ads shows "add cost" until COGS lands (dashboard banner explains; see E2 finding F-COGS).
- CPC campaign rollups derive from listing facts; the 4 CPC campaigns are paused (historical zeros are real).
- Product grain = variant-level products (family rollup is an E6 checklist item); unmatched-listing matching actions land in E4.
