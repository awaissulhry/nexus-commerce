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
