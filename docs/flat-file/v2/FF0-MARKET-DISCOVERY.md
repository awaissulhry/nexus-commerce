# FF0-MARKET-DISCOVERY — Live channel×market matrix & auto-discovery

> Phase FF0 (read-only). Proves the workbook can carry **all channels × all markets simultaneously**, discovered from live data so a newly activated market auto-appears in the next export (Part IV / Contract "markets discovered from live data, never hardcoded").

---

## 1. How channels & markets are modelled

- **No `enum Marketplace`.** Markets are **free-text `String` codes**. The only channel enum is `OrderChannel` (orders only, `schema.prisma:4110`) and the unused `SyncChannel` (L57).
- **Config registry = `model Marketplace`** (`schema.prisma:1631`), keyed **`@@unique([channel, code])`**, with `marketplaceId` (SP-API id), `region`, `currency`, `language`, `isActive`, `isParticipating`, `vatRate`. A market is the pair **`(channel, code)`** — Amazon-IT and eBay-IT are distinct rows with distinct `marketplaceId` (`APJ6JRA9NG5V4` vs `EBAY_IT`).
- **Per-listing markets** live as strings on the listing rows:
  - `ChannelListing.marketplace` (default `"DEFAULT"`, indexed, `@@unique([productId, channel, marketplace])`) — **the live source**.
  - `VariantChannelListing.marketplace` (default `"GLOBAL"`) — eBay residue.
- **No FK** from listings to `Marketplace` (join is done in JS, `marketplaces.routes.ts:129`) → the code set is **not enforced at the DB level**. This is *why* dynamic discovery from listing data is the reliable source of truth, not any constant.
- **eBay is a single-token multi-market channel:** `ChannelConnection.marketplace = null` for eBay (`schema.prisma:5231`); per-market identity is carried only on the listing rows.

---

## 2. The live channel×market matrix (from code/config/seed)

Seeded by two identical hardcoded lists: `packages/database/scripts/seed-marketplaces.ts:16-43` and `apps/api/src/routes/marketplaces.routes.ts:10-31` (POST `/api/marketplaces/seed`).

| Channel | Markets modelled (seed) | Active for Xavia (project scope) |
|---|---|---|
| **AMAZON** | IT, DE, FR, ES, UK, NL, SE, PL, US (9) | **IT, DE, FR, ES, UK** (5); **primary = IT** (`APJ6JRA9NG5V4`, the hardcoded fallback in ~6 SP-API methods) |
| **EBAY** | IT, DE, FR, ES, UK (5); `marketplaceId` = `EBAY_IT`…`EBAY_GB` | IT, DE, FR, ES, UK (5) |
| **SHOPIFY** | GLOBAL (1) | in scope (single store, `marketplace="GLOBAL"`) |
| **WOOCOMMERCE / ETSY** | GLOBAL each | **out of scope** (MEMORY: Amazon+eBay+Shopify only; `ACTIVE_CHANNELS_OPTIONS` confirms) |

**Width inconsistency across the stack (F3):** UI/flat-file/coverage use **5** (IT,DE,FR,ES,UK); `Marketplace` seed has **9** Amazon; the orders cron sweeps **11** EU (`DEFAULT_EU_MARKETPLACE_IDS`, `amazon-orders.service.ts:172-184`: IT,DE,FR,ES,UK,NL,SE,PL,BE,IE,TR); the full seed is **17**. Orders in the 6 extra swept markets land in the DB with **no editor/coverage surface**. Nothing reconciles these numbers — which is the core reason a discovered list, not a constant, must drive the workbook.

---

## 3. Hardcoded market lists (drift-risk inventory — 20 sites)

Every place a market list is hardcoded. FF v2 must supersede the flat-file ones (**bold**) with dynamic discovery; the rest are noted so we don't reintroduce drift.

**Backend**
| # | file:line | constant |
|---|---|---|
| 1 | `services/marketplaces/amazon.service.ts:23` | `XAVIA_ACTIVE_MARKETPLACES` (IT,DE,FR,ES,UK) |
| 2 | `services/marketplaces/amazon.service.ts:10-20` | `AMAZON_MARKETPLACE_CODE_TO_ID` (9) |
| 3 | `services/amazon-orders.service.ts:172-184` | `DEFAULT_EU_MARKETPLACE_IDS` (11) |
| 4 | `services/categories/marketplace-ids.ts:6-31` | `CODE_TO_AMAZON_ID`, `CODE_TO_LOCALE` (10) |
| 5 | `routes/marketplaces.routes.ts:10-31` | `MARKETPLACES` seed (17) |
| **6** | **`services/amazon/flat-file.service.ts:1432`** | **`COVERAGE_MARKETS` (IT,DE,FR,ES,UK) — the flat-file cross-market coverage strip** |
| 7 | `services/compliance-resolver.service.ts:85` | `EU_MARKETS` (17) |
| 8 | `routes/listing-wizard.routes.ts:239,4752` | `EBAY_MARKETPLACES`, `EU_MARKETS` |
| 9 | `services/images/amazon-adopt.service.ts:24` | `FALLBACK_EU_MARKETS` (IT,DE,FR,ES,UK) |

**Frontend**
| # | file:line | constant |
|---|---|---|
| **10** | **`app/products/amazon-flat-file/AmazonFlatFileClient.tsx:692,7177,8700`** | **`ALL_MARKETS`×2, `COVERAGE_MARKETS` — the Amazon editor strip; never calls `/api/marketplaces`** |
| **11** | **`app/products/ebay-flat-file/EbayFlatFileClient.tsx:326`** | **`ALL_MARKETS`** |
| **12** | **`app/products/ebay-flat-file/ebay-columns.ts:122` (+`MARKET_COLUMN_GROUPS` 497-558)** | **`EBAY_MARKETPLACES`** |
| 13 | `app/products/_components/BulkActionBar.tsx:1373` | `MARKETS` |
| 14 | `app/products/[id]/edit/ListOnChannelDropdown.tsx:13-14` | `AMAZON_MARKETS` (+US), `EBAY_MARKETS` |
| 15 | `app/products/[id]/edit/tabs/MatrixTab.tsx:47` | `ALL_MARKETS` |
| 16 | `app/reconciliation/ReconciliationClient.tsx:661` | `ALL_MARKETS` |
| 17 | `components/ui/MultiSelectChips.tsx:148-154` | `ACTIVE_MARKETPLACES_OPTIONS` |
| 18 | `app/pricing/PricingMatrixClient.tsx:554` | `ACTIVE_MARKETPLACES` |
| 19 | `lib/marketplace-code.ts:16-42` | `MARKETPLACE_ID_TO_CODE` (~22; **BE/PL conflict, F3**) |
| 20 | `app/listings/ebay/campaigns/EbayCampaignsClient.tsx:37` | `EBAY_MARKETPLACES` |

SP-API config hardcodes `region:"eu"` (`amazon.service.ts:313`) and the IT fallback marketplace in ~6 methods.

---

## 4. The discovery mechanism (already exists — lift it into the flat-file path)

Three dynamic-discovery forms already exist; the flat-file editors use **none** of them:

**(a) Config-table discovery** — `GET /api/marketplaces` / `/grouped` → `marketplace.findMany({ where:{ isActive:true } })`. Consumed by listings, settings/mappings, product edit, bulk-operations — but **not** the flat-file editors.

**(b) DB-backed active resolver** — `getActiveMarketplaceIdsFromDb()` (`amazon-orders.service.ts:205-224`): `Marketplace.findMany({ where:{ channel:'AMAZON', isActive:true, region:'EU', marketplaceId:{not:null} } })`, env fallback. Flipping `isActive` takes effect next tick, no redeploy (MS.5).

**(c) Live-data DISTINCT discovery** — the exact "from live data" pattern, reference implementation at **`GET /api/fulfillment/facets` (`fulfillment.routes.ts:11542-11558`)**:
```ts
prisma.channelListing.findMany({ where:{ listingStatus:'ACTIVE' }, distinct:['marketplace'] })
// comment: "Replaces the hardcoded ['IT','DE','FR','ES','UK','GLOBAL'] list with the
//           seller's actual marketplace/channel presence (distinct from ACTIVE ChannelListings)."
```
Also: `order.groupBy({ by:['marketplace'] })` (`orders.routes.ts:568`), `channelListing.groupBy({ by:['channel','marketplace'] })` (multiple routes).

### 4.1 The FF v2 discovery query (recommended)

The workbook's channel-sheet columns are generated from this — run once per export, per channel:

```ts
// Markets that actually carry data for a channel (auto-includes any newly activated market):
const present = await prisma.channelListing.findMany({
  where: { channel },                       // 'AMAZON' | 'EBAY' | 'SHOPIFY'
  select: { marketplace: true },
  distinct: ['marketplace'],
})
// Union with configured-but-not-yet-populated active markets so new markets get empty columns too:
const configured = await prisma.marketplace.findMany({
  where: { channel, isActive: true },
  select: { code: true },
})
const markets = sortMarkets(unique([...present.map(p => p.marketplace), ...configured.map(c => c.code)]))
```

**Guarantee:** because columns are the union of *(markets with live listings)* ∪ *(active `Marketplace` rows)*, a newly activated NL/SE/PL market appears in the very next export — either as soon as it has one listing, or immediately once its `Marketplace.isActive=true`. No constant to edit, satisfying Contract "never hardcoded."

**Key on `code`, not SP-API id** — this sidesteps the BE/PL `marketplaceId` collision (F3). `sortMarkets` gives a deterministic column order (Contract §1): primary market first (IT), then the rest alphabetically — e.g. `IT, DE, ES, FR, UK, …`.

### 4.2 Determinism & the `_meta` record

The export records the resolved market list at export time on the hidden `_meta` sheet, so an import can detect if the market set changed since export (a market appearing/disappearing is surfaced, never silently dropped). Sheet/column order is deterministic given the same market set (Contract §1).

---

## 5. Findings feeding FF0-FINDINGS

- **F3** (🔴): flat-file hardcodes markets (sites 6, 10-12) + the **BE/PL `marketplaceId` conflict** (`A1C3SOZRARQ6R3` PL-backend vs BE-frontend). Discovery keyed on `code` avoids the conflict; the map itself needs a standalone fix.
- **Width inconsistency** (5/9/11/17) means any single constant is wrong for some surface — discovery is the only correct source.
- **eBay single-token**: discover eBay markets from listing DISTINCT, not from `ChannelConnection` (which is null).
- **Two channel-modelling layers**: target the current layer (`ChannelListing` + `Marketplace` + `ChannelConnection`); the legacy `Channel`/`Listing`/`MarketplaceSync` tables (L2259-2299) are documented empty — ignore.
