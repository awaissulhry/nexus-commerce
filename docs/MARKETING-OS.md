# Unified Marketing OS (UM-series)

One channel-agnostic Campaign system across **Amazon, eBay, Shopify, and
external networks (Google/Meta/TikTok)** and all EU markets, covering paid
ads + promotions + content pushes + review/email outreach — with a single
cockpit, cross-channel budgets, automation, and analytics.

**Live prod:** web `nexus-commerce-three.vercel.app` · api
`nexusapi-production-b7bb.up.railway.app`. Everything ships sandbox-safe;
live external writes are behind explicit, default-OFF gates.

---

## Surfaces (live)

| Surface | URL | What |
|---|---|---|
| Campaigns | `/marketing/campaigns` | Cross-channel roster (lens tabs), inline pause/resume + budget edit, "New campaign", row → detail |
| Campaign detail | `/marketing/campaigns/[id]` | KPIs, channel detail, markets, targets, action audit |
| Calendar | `/marketing/calendar` | Month grid, RetailEvent demand bands, scheduled campaigns, plan entries |
| Automation | `/marketing/automation-os` | Rules (dryRun default), test, evaluate-now |
| Budgets | `/marketing/budgets` | Cross-channel pools, rebalance preview→apply, guardrails |
| Analytics | `/marketing/analytics` | EUR-normalized rollups, daily trend, by-channel/market |

## Architecture (one-liner)

CORE `MarketingCampaign` + per-channel 1:1 detail tables + `MarketingCampaignLink`
(per-market) → adapters (`amazon`/`ebay`/`internal` real, `shopify`/`google`/`meta`/`tiktok`
sandbox stubs) → unified mutation path (`OutboundSyncQueue` + grace window +
`CampaignAction` audit + write gate) → automation (`AutomationRule` domain=marketing)
+ budgets (`CampaignBudget`) + analytics (`CampaignMetric`, `costEurCents` FX-normalized).
Live via the `marketing-events` SSE bus.

---

## Env flags (all default to SAFE / sandbox)

| Flag | Effect |
|---|---|
| `NEXUS_ENABLE_AMAZON_ADS_CRON=1` | starts marketing crons (rule-evaluator, sync-drain) + ads crons |
| `NEXUS_AMAZON_ADS_MODE=live` | Amazon Ads API in live mode (already set on prod) |
| `NEXUS_MARKETING_AMAZON_LIVE=1` | **gate 1/3** for unified Amazon live writes |
| `NEXUS_MARKETING_WRITES_EBAY=1` | eBay live writes via unified path |
| `NEXUS_MARKETING_WRITES_SHOPIFY/GOOGLE/META/TIKTOK=1` | per-channel live writes (need a real adapter first) |
| `NEXUS_MARKETING_WRITES_INTERNAL=1` | content/outreach live delegation |
| `NEXUS_MARKETING_MAX_WRITE_VALUE_CENTS` | per-write value cap (default €500) |

---

## HOW TO TEST EVERYTHING

`BASE=https://nexusapi-production-b7bb.up.railway.app/api/marketing/os`
Bodyless POSTs: do **not** send `Content-Type: application/json` (Fastify rejects empty JSON bodies with 400).

### A. Data foundation (sandbox — safe now)
1. **Amazon shadow populated:** `curl $BASE/summary` → `{ total, byChannel:{AMAZON:N}, spendCents, salesCents }`.
   Re-run backfill if empty: `curl -X POST "$BASE/backfill/amazon?mode=apply"` → `parity.ok=true`.
2. **Metric grain:** `curl $BASE/diagnostics/metrics` → `linkedToCampaign`, `campaignsWithSpend`, cost by entityType.

### B. Cockpit (UI)
3. Open `/marketing/campaigns` → roster renders; lens tabs (All/Amazon/eBay/Shopify/External/Content); sort columns; search/filter.
4. Click a campaign name → detail page (KPIs, channel detail, markets, targets, action history).
5. **Sandbox mutation:** click Pause on an ACTIVE campaign → status flips instantly (optimistic); the audit row appears on the detail page after the grace window + drain. Click Resume to revert. *(No live write — Amazon is sandbox.)*
6. **Budget edit:** click a budget cell → type a value → Enter → updates.
7. **New campaign:** "New campaign" → channel INTERNAL / surface CONTENT_PUSH → Create draft → appears under the Content lens; Launch (rocket) on the row.
   API equiv: `curl -X POST "$BASE/campaigns" -H 'Content-Type: application/json' -d '{"name":"Test","channel":"INTERNAL","surface":"CONTENT_PUSH","marketplaces":["IT"]}'` then `curl -X POST "$BASE/campaigns/<id>/launch"` then `curl -X DELETE "$BASE/campaigns/<id>"`.

### C. Calendar
8. `/marketing/calendar` → month grid; RetailEvent bands show as ★ tinted days; scheduled campaigns as channel dots; click a day → plan an entry; click an entry → edit/reschedule/delete.

### D. Automation (sandbox)
9. `/marketing/automation-os` → "New rule" (trigger `MKT_ACOS_BREACH`, action `mkt_pause_campaign`, dry-run on) → Create.
10. **Test (dry-run):** click the flask → result shows `status: DRY_RUN` + `wouldChange` (no write).
11. **Evaluate now:** click → `evals/matches` + context counts (e.g. `underpacingContexts`).
    API: `curl -X POST "$BASE/rules/evaluate-now"`.

### E. Budgets (sandbox)
12. `/marketing/budgets` → "New pool" (strategy PROFIT_WEIGHTED, dry-run) → add 2 campaigns (by id) → "Preview rebalance" → diff (current→proposed, weights, maxShift note) → Apply (dry-run audit).
    API: `curl "$BASE/budgets/<id>/rebalance/preview"`.

### F. Analytics
13. `/marketing/analytics` → totals + daily spend/sales bars + by-channel/by-market tables. Cross-check `byChannel.AMAZON` spend vs the legacy Trading Desk 30-day numbers.
    API: `curl "$BASE/analytics"`.

### G. Real-time
14. Open `/marketing/campaigns` in two tabs; run a backfill or mutation in one → the other shows the "live" pulse + refreshes (SSE bus).

---

## GO-LIVE RUNBOOKS (operator actions — real money / external writes)

### Amazon (P8 cutover)
1. **Check status:** `curl $BASE/cutover/amazon/status` → shows the 3 gates.
2. **Enable writes on the connection** (AD.4 flow): set the `AmazonAdsConnection` to `mode=production` + `writesEnabledAt` (Settings → Advertising / the enable-writes flow). *(Currently all 9 connections are sandbox.)*
3. **Set `NEXUS_MARKETING_AMAZON_LIVE=1`** on Railway.
4. **Guarded test:** `curl -X POST "$BASE/cutover/amazon/test?campaignId=<id>"` → expect `processed.status: live-success` (writes a campaign's *current* budget to itself — a no-op-value live write, changes no spend).
5. Now cockpit pause/budget + automation drive live Amazon. Re-check `/cutover/amazon/status` → `ready: true`.

### eBay (P9 live)
1. **Re-authorize eBay** so the token gains `sell.marketing`: Settings → Channels → reconnect eBay (approve the consent), **or** `curl -X POST .../api/ebay/auth/initiate` → open `authUrl` → approve.
   *(If the consent errors on the scope, enable the Marketing API on your eBay developer keyset.)*
2. **Sync campaigns:** `curl -X POST "$BASE/sync/ebay"` → `sync.upserted > 0`, eBay campaigns appear under the eBay lens. *(Before re-auth this returns the `403 sell.marketing` hint — that's expected.)*
3. **(Writes)** set `NEXUS_MARKETING_WRITES_EBAY=1` on Railway → cockpit pause/bid/budget push live to eBay.

### Shopify / Google / Meta / TikTok
Sandbox stubs registered (cockpit lenses + create work). Going live = provision each platform's OAuth app + credentials, then graduate its stub adapter (pull + write). Not yet built — needs creds.

---

## Deferred / remaining
- Live adapters for Shopify/Google/Meta/TikTok (need credentials).
- P14 legacy-surface retirement (`/marketing/advertising`, `/listings/ebay/campaigns`) — only after channel parity, to avoid removing working tools.
- Deep MC-publish / RV-send delegation for INTERNAL launches (currently records intent behind `NEXUS_MARKETING_WRITES_INTERNAL`).

---

# Advertising cockpit (AX-series)

One Amazon-grade ad cockpit at `/marketing/advertising` (sidebar
"Advertising"; `/marketing/campaigns` redirects in). Tabs: Campaigns
(40-50 customizable columns + KPI + chart) · Auto-architect · Harvesting ·
Bid optimizer · Dayparting · Budget pacing · N-gram intel · Create campaign
· (+ legacy Aged-stock/Profit/Reports/etc.). Built on the live AD-series
backend; all writes sandbox-safe behind the P8/ads-write-gate.

**Automation (each: preview → select → apply; or as automation-rule handlers):**
- **Auto-architect** — paste keywords → match-type-split / SKAG / auto-funnel campaigns.
- **Harvesting** — wasteful search terms → negatives; converters → graduate to Exact.
- **Bid optimizer** — move bids toward target ACOS (`bid_to_target_acos` rule handler).
- **Dayparting** — run campaigns only in day×hour windows (`AdSchedule` + 15-min cron).
- **Budget pacing** — raise out-of-budget winners / cut losers (`pace_budget` rule handler).
- **N-gram intel** — winning/wasteful word fragments across all search terms (+CSV).

**AX.12 — Amazon Marketing Stream (hourly), operator setup to go live:**
1. In the Amazon Ads console / Ads API, create an **AMS subscription** for
   the `sp-traffic` + `sp-conversion` datasets, delivering to **your AWS
   Firehose**.
2. Point the Firehose (via Lambda/HTTP) at
   `POST https://nexusapi-production-b7bb.up.railway.app/api/advertising/marketing-stream/ingest`
   (single message or `{ messages: [...] }`).
3. Hourly traffic + conversion then accumulate into AmazonAdsDailyPerformance
   automatically, powering intraday bid moves + dayparting. (Until subscribed,
   the endpoint simply receives nothing.)

---

# Advertising parity-plus (AX2-series)

Closes the gap to Pacvue / Perpetua / Intentwise / Quartile / Skai. All
sandbox-safe; live writes behind the same P8/ads-write-gate. Tabs added:
**Recommendations** (top) · **Share of voice**.

| Phase | What | Where |
|---|---|---|
| AX2.1 | **Product / ASIN / category / auto / negative targeting** — v3 SP `/sp/targets` + `/sp/negativeTargets` create | Campaign detail → Targeting → "+ Add targeting" (Product ASIN · Category · Auto close/loose/substitutes/complements · Negative ASIN) |
| AX2.2 | **Placement bid-adjustment writes** — v3 `dynamicBidding.placementBidding` | Campaign detail → Placements → top-of-search / product-pages / rest-of-search % + bidding strategy → Save |
| AX2.3 | **Sponsored Display audiences** — `/sd/targets` (Amazon in-market/lifestyle/interests + views/purchases remarketing) | Targeting builder → Audience (SD) |
| AX2.4 | **Cockpit UI upgrade** — toggleable multi-metric chart, CSV export, density toggle, segmented SP/SB/SD filter, status dots | `/marketing/advertising/campaigns` |
| AX2.5 | **Bulk ops** — bulk budget +10%/−10%/set; bulksheet CSV import (id\|externalCampaignId, budget, status) | Campaigns bulk bar + toolbar import |
| AX2.6 | **Share of Voice + impression-share intel** — within-account SOV, cannibalization, outbid / weak-CTR proxies | `/marketing/advertising/share-of-voice` |
| AX2.7 | **AI + rules recommendations** — bid/negative/graduate/budget/SOV in one impact-ranked feed, one-click apply + Anthropic brief | `/marketing/advertising/recommendations` |
| AX2.8 | **Goal-based guided builder** — pick a goal (grow / launch / defend / liquidate / custom) → structure, bidding, budget, match types pre-set + a strategy tip | `/marketing/advertising/create` |
| AX2.9 | **Sponsored Brands creatives** — brand name + headline + logo asset + creative type (collection / spotlight / video) + landing + featured ASINs, via `/sb/v4/ads` | builder, SB type |
| AX2.10 | **Data-grounded bid suggestions** — suggest keyword bids from your own observed CPCs (not Amazon's generic number) | builder → "Suggest bid from data" |
| AX2.11 | **Dayparting intelligence** — day-of-week conversion heatmap (bid-up/pause) → one-click AdSchedule | `/marketing/advertising/dayparting` (top panel) |
| AX2.12 | **Ads alerts** — ACOS breach / zero-sales / spend spike / sales drop watch feed | alerts strip atop `/recommendations` |

**How to test (sandbox-safe):**
- Targeting: open any campaign → Targeting → "+ Add targeting" → add an ASIN / category / auto / negative → it appears in the list (sandbox `sb-tgt-*` id; audit row written).
- Placements: campaign → Placements → set Top-of-search 50% → Save → `mode: sandbox`; reopen to confirm persisted.
- Bulk import: select campaigns → Export CSV; edit a budget; re-import via the import button → "✓ N updated".
- SOV: `/share-of-voice` → SOV bars, Cannibalized/Outbid/Weak-CTR filters, CSV. (Needs search-term report data.)
- Recommendations: `/recommendations` → AI brief + ranked feed; click **Apply** on a bid/negative/budget/graduate item (sandbox) or **Apply all high-priority**. API: `curl $BASE/../advertising/recommendations`.

---

# Advertising beyond-Pacvue (AX3-series)

Closes the gap to Pacvue / Perpetua on DSP, AMC, retail-readiness, and
full-funnel. New cockpit tabs: **New goal · DSP · Audiences · Retail readiness
· iROAS**, plus retail folded into **Recommendations** as a strategy.

| Phase | What | Where |
|---|---|---|
| AX3.1 | **Native retail-readiness guard** — auto-flag/pause campaigns advertising out-of-stock / lost-Buy-Box / uncompetitive products (we own the data; Pacvue integrates it) | `/marketing/advertising/retail-readiness` |
| AX3.2 | **Full-funnel Goal builder** — one goal → coordinated Branded + Unbranded SP campaigns, each own Target ACoS + budget; Suggest Targets from search-term history; bulk-ASIN | `/marketing/advertising/goals` |
| AX3.3 | **Amazon DSP + Performance+/Brand+** — guided programmatic builder (conversion vs awareness), inventory channels, AMC audience link | `/marketing/advertising/dsp` |
| AX3.4 | **AMC-style no-SQL audiences** — 6 templates (viewers / cart / purchasers / lookalike / suppression / competitor) → activate | `/marketing/advertising/audiences` |
| AX3.5 | **iROAS / incrementality (modeled)** — branded vs non-branded incrementality factors → incremental sales + iROAS vs reported ROAS | `/marketing/advertising/incrementality` |
| AX3.6 | **Strategy grouping** — Recommendations regrouped into Perpetua-style strategies (Budget / Bid / Negatives / Graduation / Inventory Shortage / SoV) + accept/dismiss | `/recommendations` |

**Retail-readiness auto-pilot:** set `NEXUS_ADS_RETAIL_GUARD_APPLY=1` + enable
the ads cron to auto-pause at-risk campaigns (gated; sandbox-safe until P8).
**DSP / AMC go-live:** need a DSP advertiser entitlement + AMC instance; until
then DSP campaigns & audiences are created locally (sandbox ids) so the full
plan/build flow works now.

**Still operator-gated / optional next:** real competitive impression-share
(needs Amazon's impression-share report subscription); `ANTHROPIC_API_KEY` on
Railway for the AI brief (degrades to a rules summary without it); goal-based
guided builder + Sponsored Brands creative management (assets-dependent).
