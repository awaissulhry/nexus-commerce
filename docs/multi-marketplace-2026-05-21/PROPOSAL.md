# Multi-Marketplace Backfill Engagement — Proposal

**Date:** 2026-05-21
**Driver:** Xavia is connected to 9 Amazon marketplaces; only IT has any data.

---

## ⚠️ STATUS: SUPERSEDED — see M0-audit.md correction

This proposal assumed the deployed I11 reconciliation's per-marketplace counts ("DE: 40 orders, FR: 19, ES: 3") were real customer-placed orders that needed backfilling. Empirical verification during M2 implementation revealed they are phantom Pan-EU FBA visibility duplicates — every one of Xavia's 2,410 historical orders has `raw.MarketplaceId = APJ6JRA9NG5V4` (IT), and zero buyers are in DE/FR/ES/NL/UK/PL/SE/US.

**M3–M16 are deferred indefinitely.** M0+M1+M2 work shipped as future-proofing infrastructure; if/when Xavia activates non-IT customer activity, the system is ready to ingest it.

The full proposal below is preserved for reference.

---

---

## What the read-only audit found

### 🔴 Empty marketplaces (8 of 9)

```
┌──────┬────────────────┬──────────┬─────────┬────────┬────────────┐
│ Code │ MarketplaceId  │ Currency │ Region  │ Orders │ Settlements│
├──────┼────────────────┼──────────┼─────────┼────────┼────────────┤
│ IT   │ APJ6JRA9NG5V4  │ EUR      │ EU      │  2,410 │ 26         │  ← only this one
│ DE   │ A1PA6795UKMFR9 │ EUR      │ EU      │      0 │ 0          │
│ FR   │ A13V1IB3VIYZZH │ EUR      │ EU      │      0 │ 0          │
│ ES   │ A1RKKUPIHCS9HS │ EUR      │ EU      │      0 │ 0          │
│ NL   │ A1805IZSGTT6HS │ EUR      │ EU      │      0 │ 0          │
│ UK   │ A1F83G8C2ARO7P │ GBP      │ EU      │      0 │ 0          │
│ PL   │ A1C3SOZRARQ6R3 │ PLN      │ EU      │      0 │ 0          │
│ SE   │ A2NODRKZP88ZB9 │ SEK      │ EU      │      0 │ 0          │
│ US   │ ATVPDKIKX0DER  │ USD      │ NA      │      0 │ 0          │
└──────┴────────────────┴──────────┴─────────┴────────┴────────────┘
```

ChannelListing snapshots exist for IT (262) / DE (235) / ES (140) / FR (132) from an older push, but **no orders, no settlements, no returns, no ads** outside IT.

### 🔴 Root cause: sync routes hardcoded to env marketplaceId

`POST /api/amazon/orders/sync` (line 1472 amazon.routes.ts) accepts `since` / `daysBack` / `from` / `to` / `limit` — but **no `marketplaceId` or `marketplaceIds` field**. 14+ other Amazon routes pull `process.env.AMAZON_MARKETPLACE_ID` directly. The backfill scripts (`scripts/backfill-amazon-*.mjs`) just POST without a marketplace param.

Net effect: every backfill goes to `APJ6JRA9NG5V4` (IT). DE/FR/etc. orders sit on Amazon's servers, ungrabbed.

### 🟡 Pan-EU FBA inventory is correct already

```
AMAZON-EU-FBA  (type: AMAZON_FBA)  17 SKUs  434 units
```

A single pool serves IT+DE+FR+ES+NL under Pan-EU FBA — the inventory backfill correctly pulled the EU-wide aggregate. **But UK is separate post-Brexit** (its own UK-FBA pool); same for US. We don't have those pools populated.

### 🟡 SP-API authorization may not cover all 9 markets

The operator may have re-authorized SP-API for IT only. We need to call `getMarketplaceParticipations` upfront — any marketplace where the seller has no listing/participation will 403 every call. The reconciliation route I shipped in I11 will surface those failures as warnings, but better to detect upfront and skip dead markets.

### 🟢 What's already correct (don't break it)

- `Marketplace` table has all 9 markets with correct marketplaceId + currency
- `ChannelConnection` rows are PRESERVE-by-default per the wipe rules
- `DailySalesAggregate` schema already keys on `(channel, marketplace, sku, day)` — supports the data, just needs ingest
- I11 reconciliation already fans out across all marketplaces with currency-aware drift checks
- I3+I5+I6 services already return per-(channel, marketplace, currency) breakdowns; UI shows them
- Multi-currency Insights pipeline (cents math + native-currency display) is in place

---

## Plus stuff you might have missed (research adds)

| # | Item | Why it matters |
|---|---|---|
| 1 | **Brexit / UK customs** | UK is NOT in Pan-EU FBA. Separate inventory pool, separate VAT regime, separate IOSS treatment. Treating UK like DE silently corrupts inventory + fiscal numbers. |
| 2 | **VAT registration per market** | If the operator isn't VAT-registered in DE, Amazon may collect VAT on their behalf ("marketplace facilitator"). Order's `totalPrice` shape changes. Don't infer net-of-VAT before checking. |
| 3 | **OSS / IOSS reporting** | Single EU VAT return covers all EU sales under €10k threshold; over that, operator must register in each. Our /insights/fiscal needs per-market thresholds. |
| 4 | **Currency snapshot at order time** | UK orders in GBP, PL in PLN, SE in SEK. For consolidated EUR P&L we need *historical* FX (ECB daily rate on purchase date), not today's rate. ECB FX table is already 24mo backfilled — just not used per-order. |
| 5 | **Amazon Ads is per-marketplace** | Each marketplace has its own Sponsored Products/Brands/Display profileId. Backfilling DE ad spend requires that DE profileId, not the IT one. |
| 6 | **Settlement reports are 90-day cap** | SP-API only returns settlements published in the last ~90 days. Older settlements unavailable for backfill. Document this gap; don't promise historical reconciliation older than 3 months. |
| 7 | **Returns API per marketplace** | Same hard limit — recent windows only, marketplace-scoped. |
| 8 | **MFN vs FBA per market** | Operator may use FBA in IT/DE/FR but MFN in PL/SE (volume too low for FBA). Backfill needs to detect fulfillment channel per order, not assume FBA. |
| 9 | **A+ Content is region-locked** | EU content cluster ≠ NA content cluster. Pulling US A+ Content needs separate Brand Registry auth. |
| 10 | **Buy Box / Featured Offer per market** | Same SKU competes against different sellers in each marketplace. Buy-box wins per market matter for pricing decisions. |
| 11 | **Browse nodes / category trees per market** | EN-DE category names differ from EN-IT. Listing categorization is per-marketplace. |
| 12 | **Reviews per marketplace** | Star ratings are per market — IT 4.5★ doesn't mean DE is too. Brand Analytics has this. |
| 13 | **Sales tax per US state** | US is the outlier — sales tax varies per state. If we backfill US, we need state-level tax breakdown from Amazon's MWS Tax document. |
| 14 | **Marketplace activation flag** | Just because `Marketplace` row exists doesn't mean operator actively sells there. We should set `isActive=false` for markets with zero participations to skip them in cron loops. |
| 15 | **Cross-marketplace inventory transfers (PEFI)** | Pan-EU FBA shifts stock from IT pool to DE pool automatically. Adjustments show up in inventory ledger; need to attribute correctly. |
| 16 | **Per-marketplace customer reviews / Brand Analytics** | Search-term reports, market basket analysis, top-100 brand searches — all per market. |
| 17 | **Promotional history per market** | Lightning deals, coupons, vouchers — per market. Affects revenue spikes that look like organic growth. |
| 18 | **Multi-currency invoice generation** | Italian fiscal invoices use EUR. UK orders need GBP invoices (HMRC compliance). Per-market invoice template + currency. |
| 19 | **Per-marketplace fee schedule** | Referral % varies per category × marketplace. FBA pick-and-pack fees differ DE vs IT. Current 15% Amazon estimate is IT-only. |
| 20 | **Listing health per market** | A SKU active in IT may be suppressed in DE (missing translation, category restriction). Different health signal per market. |
| 21 | **Tax-inclusive vs tax-exclusive pricing** | EU = inclusive; US = exclusive. Mixing without conversion overstates EU revenue when shown alongside US in the same chart. (Already flagged in I0 audit, still pending.) |
| 22 | **Per-marketplace returns rate** | Some markets return more (DE famously high). Returns / orders per market needed for fiscal + quality dashboards. |

---

## Proposed phases (gate-before-implementing, same as last engagement)

### **Phase M0 — Read-only audit + participations probe** (~1h)
- Call `getMarketplaceParticipations` to confirm which of the 9 markets the operator's SP-API auth actually permits
- Audit every Amazon route + service for `process.env.AMAZON_MARKETPLACE_ID` references
- Audit every backfill script for marketplace hardcoding
- Output `docs/multi-marketplace-2026-05-21/M0-audit.md` with: code locations to change, marketplaces actually authorized, per-market expected order volume (from SP-API count endpoints)

**Gate:** you review which marketplaces are authorized + scope to backfill.

### **Phase M1 — Marketplace activation flag + per-market DB filter** (~1h)
- Add `Marketplace.isParticipating` boolean (or use existing `isActive`)
- Set false for markets with no SP-API participation
- All sync loops + cron jobs respect the flag — no wasted SP-API calls on dead markets
- Idempotent: re-run participations check refreshes the flag

**Gate:** confirm we're not silently dropping any market.

### **Phase M2 — Add `marketplaceIds` to sync routes** (~2h)
- `POST /api/amazon/orders/sync` accepts `{ marketplaceIds?: string[] }` — default = all participating
- Same for `/api/amazon/inventory/sync`, `/api/amazon/finance/sync`, `/api/amazon/returns/sync`, `/api/amazon/settlements/sync`
- Service layer iterates marketplace list inside the route — one SP-API call per marketplace, errors per-marketplace not all-or-nothing
- Backfill scripts accept `--marketplaces=DE,FR,ES` flag (default = all)

**Gate:** dry-run against IT (already populated) — confirm no regression.

### **Phase M3 — Backfill DE/FR/ES/NL orders** (~3-4h wall clock, mostly SP-API throttle)
- Run `scripts/backfill-amazon-orders-12m.mjs --marketplaces=DE,FR,ES,NL` for 24-month window
- These are all EUR → no FX work needed
- Verify per-marketplace order count + revenue lands in Orders + DailySalesAggregate
- Spot-check 1 order per market against Amazon Seller Central

**Gate:** numbers match Seller Central for each market.

### **Phase M4 — Backfill UK orders (GBP + Brexit handling)** (~2h)
- Separate phase because of currency + customs
- UK uses its own FBA inventory pool (UK-FBA, not EU-FBA)
- Per-order historical FX snapshot at purchase date (ECB GBP→EUR rate that day)
- Verify EUR-equivalent total reconciles vs Amazon GBP totalPrice × rate

**Gate:** UK reconciliation report shows 0 drift in GBP, EUR-equivalent matches.

### **Phase M5 — Backfill PL + SE (PLN + SEK)** (~2h)
- Same currency-snapshot work as UK
- Lower volume so faster wall-clock
- ECB FX for PLN + SEK already in fx table

**Gate:** per-marketplace reconciliation reports clean for PL, SE.

### **Phase M6 — Backfill US (USD + state tax + tax-exclusive pricing)** (~3h)
- US is the most different: VAT-exclusive pricing, state-level sales tax, different fee schedule, no Pan-EU FBA
- Separate FBA inventory pool (US-FBA)
- Pull state-level tax breakdown from `MerchantListings_All_Plus_Tax_All_Marketplaces` report
- Confirm `Order.taxAmount` interpretation switches based on `marketplace='US'`

**Gate:** US reconciliation clean; tax breakdown matches Seller Central US fiscal report.

### **Phase M7 — Per-marketplace settlements** (~2h)
- Walk SP-API settlements API per marketplaceId
- 90-day cap means we backfill what's available; document the gap
- Settlement reports already keyed on `marketplaceId` — schema OK

**Gate:** settlement totals reconcile against SP-API ledger view per market.

### **Phase M8 — Per-marketplace ad spend backfill** (~2h)
- Amazon Ads has separate profileId per market
- Pull AmazonAdsDailyPerformance per (marketplace, day) for 12 months
- Mark IT profile as primary; new profiles for DE/FR/etc.
- Validate /insights/advertising shows per-marketplace ACoS/TACoS

**Gate:** ad spend totals per marketplace match Amazon Ads console.

### **Phase M9 — UK-separate + US-separate FBA inventory pools** (~2h)
- Add UK-FBA + US-FBA `StockLocation` rows
- Reconcile each pool independently against SP-API getInventorySummaries per marketplace
- Pan-EU EU pool unchanged

**Gate:** all 3 FBA pools (EU/UK/US) reconcile clean.

### **Phase M10 — Per-marketplace returns** (~1.5h)
- Returns API per marketplaceId (90-day cap)
- Per-marketplace return rate metric on insights
- Refunds already flow to Return.refundCents; just need per-market provenance

**Gate:** Return counts per marketplace match Seller Central returns dashboard.

### **Phase M11 — Per-marketplace channel listings** (~2h)
- Pull `GET_MERCHANT_LISTINGS_ALL_DATA` per marketplaceId
- Existing ChannelListing rows for DE/ES/FR are stale — refresh against current state
- Capture per-marketplace asin/sku/price/buybox/condition

**Gate:** ChannelListing count + statuses match SC inventory file per market.

### **Phase M12 — Per-marketplace FX snapshot for historical orders** (~2h)
- New column `Order.fxRateToEur` (capture ECB rate at purchaseDate for non-EUR markets)
- Backfill historical UK/PL/SE/US orders with their day's rate
- New EUR-equivalent rollup endpoint: `/api/insights/summary?currency=EUR&fxMode=snapshot` for cross-market consolidation when operator explicitly wants one number

**Gate:** EUR-equivalent totals stable over time (don't change when today's FX changes).

### **Phase M13 — Per-marketplace VAT / OSS / fiscal** (~3h)
- Per-market VAT rate table (IT 22%, DE 19%, FR 20%, ES 21%, NL 21%, PL 23%, SE 25%, UK 20%, US: state-level)
- OSS rollup: combine EU sales under €10k threshold; flag if over per market
- Per-marketplace registered-for-VAT flag on Marketplace
- /insights/fiscal extended with per-marketplace VAT collected + breakdown

**Gate:** OSS-eligible revenue + per-marketplace VAT collected match Amazon's VAT calculation report.

### **Phase M14 — Per-marketplace fee schedule** (~2h)
- Replace flat 15% Amazon fee estimate with per-(marketplace, category) referral % from Amazon's fee schedule
- FBA pick-and-pack fees per market × size tier
- Profit report fees become defensible per market

**Gate:** estimated fees per marketplace within 5% of Amazon FinancialEvents.

### **Phase M15 — UI polish + per-marketplace cron defaults** (~3h)
- Add marketplace selector to /insights filter (already has it; ensure it lists all 9, not just IT)
- All Amazon crons iterate participating markets by default
- Marketplace health dashboard: connection status + last sync per market + drift score

**Gate:** operator can switch between markets in UI, see per-market state cleanly.

### **Phase M16 — End-to-end verification** (~2h)
- Run the I11 reconciliation report across all participating markets
- Per-currency cross-check: sum of native marketplace revenue × FX = aggregate EUR
- Spot-check a known period (e.g. "Oct 2024 DE" = €X) against DE Seller Central
- Document any persistent gaps (e.g., SE volume <€100 not worth backfill effort)

**Gate:** sign-off on multi-marketplace data quality.

---

## Estimated wall-clock

| Phase | Hours | Notes |
|---|---|---|
| M0 audit + participations | 1 | Read-only; informs scope |
| M1 activation flag | 1 | Code only |
| M2 marketplaceIds in sync routes | 2 | Code only |
| M3 EU EUR orders (DE/FR/ES/NL) | 3-4 | SP-API throttle bound |
| M4 UK orders (GBP) | 2 | + FX snapshot |
| M5 PL + SE | 2 | + FX snapshot |
| M6 US orders | 3 | + state tax |
| M7 settlements per market | 2 | 90-day cap |
| M8 ads per market | 2 | Per-profile auth |
| M9 UK + US FBA pools | 2 | Separate pools |
| M10 returns per market | 1.5 | 90-day cap |
| M11 channel listings | 2 | Refresh existing + new markets |
| M12 FX snapshot | 2 | Historical rates |
| M13 VAT / OSS / fiscal | 3 | Per-market rates |
| M14 fee schedule | 2 | Per-category fees |
| M15 UI + cron defaults | 3 | Operator-facing |
| M16 verification | 2 | Recon report |
| **Subtotal** | **~33h** | ~4 working days |

---

## Risk + sequencing notes

- **SP-API quotas**: Rate limits are per-account, not per-marketplace. Backfilling 8 marketplaces sequentially is safer than parallel. Pages-per-second budget = same; just more pages to walk.
- **Settlement 90-day cap is hard**: Some marketplaces (e.g. SE, US) may have settlements older than 90 days that we literally can't backfill. Document as a known gap.
- **Authorization scope**: If SP-API auth was IT-only, we'll need the operator to re-authorize with the multi-marketplace scope BEFORE M3 starts. M0 audit will surface this.
- **Pan-EU FBA transfers**: Don't double-count inventory. EU pool serves IT/DE/FR/ES/NL — one number, attributed to whichever market the order ships TO.
- **DE return rate is famously high (~30% apparel)**: Expect a big refunds bump when DE comes online. Not a bug.
- **US scope**: If the operator isn't actually selling in US (zero ASINs listed), skip M6 entirely. M0 participations probe will tell us.

---

## My recommendation

**Start with M0 (read-only audit + participations probe) only.** That tells us which markets are even reachable, what code needs to change, and what realistic volume per market to expect. It also catches the authorization issue *before* we spend hours on a sync that's going to 403.

After M0, the highest-impact phases are:
- **M1+M2 (code-level multi-marketplace support)** — unblocks every subsequent phase
- **M3 (DE/FR/ES/NL backfill)** — biggest expected revenue contribution (Pan-EU is real)
- **M9 (separate FBA pools for UK + US, if used)** — inventory correctness
- **M13 (VAT / OSS)** — fiscal compliance for EU consolidation

**M10-M14 are quality-of-life enhancements** — should land but can be incrementally shipped after M3-M6 prove out.

Reply with:
- **"proceed with M0"** — read-only audit, you review, then we agree on phases
- **"proceed M0 → M2 sequentially, gate before M3"** — incremental autonomy
- **"do everything in order, full autonomy"** — full mandate, multi-session run
- **"different prioritization"** — propose changes

---

## What's already shipped that supports this

| Capability | From | Status |
|---|---|---|
| Multi-marketplace reconciliation | I11 | ✅ /api/amazon/reconciliation/all + currency cross-check |
| Per-(channel, marketplace, currency) insights | I3 + I5 + I6 + I9 | ✅ UI shows native-currency tables |
| ECB FX rates 24mo | earlier | ✅ Loaded for EUR↔GBP/PLN/SEK/USD |
| Integer-cents money math | I7 | ✅ No float drift across markets |
| TZ hardening | I8 | ✅ DST-safe windows |
| Settlement reports schema | Phase 6.B | ✅ Already keyed on marketplaceId |
| Marketplace + ChannelConnection tables | earlier | ✅ All 9 markets pre-loaded |

The foundation is solid — this engagement is mostly data ingestion + a thin code layer to remove the env-marketplace hardcode.
