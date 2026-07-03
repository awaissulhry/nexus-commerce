# E0 — Product ↔ eBay Listing Map

> eBay Ads workstream, Phase E0 deliverable 3 of 5. Read-only research; no code changed.
> Sources: code audit of `apps/api` + `packages/database/prisma/schema.prisma` (13,626 lines) and **live read-only probes against the production eBay account run 2026-07-03** (`scripts/_e0-ebay-probe*.mjs`).

## 0. Why this document decides the architecture

The console's core promise is **product-first promotion**: pick a Nexus product → every live eBay item ID behind it is promoted, per marketplace. That promise rests on one query — *"give me every LIVE eBay item ID for product X on marketplace Y"* — and today **no single function in the codebase can answer it**. This document maps what exists, what the live account actually looks like, and exactly what must be built.

## 1. Live reality check (production probes, 2026-07-03)

### 1.1 Account census

| Fact | Value | Consequence for ads |
|---|---|---|
| Live (active) items on the eBay account | **20** | Small enough to backfill mapping in minutes; catch-all rules campaign matters more than mega-bulk ops on day 1 |
| Marketplace distribution | **100% eBay IT (site 101)** | DE/FR/ES have *zero live listings today* — multi-marketplace console is forward-looking, not current-state |
| Tracked in Nexus (`ChannelListing.externalListingId`, any status) | **1 of 20** (item `257584954808`, the shared-SKU GALE listing) | **95% of the live account is invisible to Nexus** — a listing-discovery/import sync is a hard prerequisite (E2) |
| Multi-variation items | 8 of 20 (13–24 variations each, all with per-variation SKUs) | Variation-level SKUs exist only on Nexus-pushed or newer listings |
| Items with NO SKUs at all | **11 of 20** (legacy hand-created listings) | **Ad attachment must be by `listingId`** (`bulkCreateAdsByListingId`); inventory-reference (SKU) attachment only works for a minority |
| Duplicate-listing strategy in active use | Yes — e.g. GALE jacket ≈ **5 concurrent live items** (256564203510, 256566101420, 256566102729, 256566103703, 257584954808), Ventra jacket ×3, knee sliders ×4 | The product-first premise is real: promoting "GALE" must fan out to ~5 item IDs, each with its own price/qty/sales history |
| Sales activity | Present (e.g. 34, 27, 21 sold on top items) | Enough attributed-sale history for eBay suggested rates to be meaningful |
| Currency | EUR (one anomaly: item `255137162735` lists in **USD** under the US "eBay Motors" category tree while `Site=Italy`) | Currency handling per listing, never assume EUR |
| Categories | 177104 (moto jackets), 177101 (sliders), 183507 (back protectors), 177106 (leather jackets), 177117 (US Motors apparel) | All in apparel/protective trees → the 2026 size-standardization mandate applies to the jacket categories |

### 1.2 Campaigns + program eligibility (live probes)

- `GET /sell/marketing/v1/ad_campaign` → **HTTP 403 "Insufficient permissions"**: the current OAuth grant does **not** carry `sell.marketing`. The scope is already in the consent list in code (`ebay-auth.service.ts:74–83`, added by UM.9) — **one operator re-consent unblocks everything**. Until then we cannot even *see* whether Seller Hub campaigns exist.
- `GET /sell/account/v1/advertising_eligibility` (needs only `sell.account`, which we hold) → for **all four target marketplaces (IT/DE/FR/ES)**:
  - `PROMOTED_LISTINGS_STANDARD` (General/CPS): **ELIGIBLE**
  - `PROMOTED_LISTINGS_ADVANCED` (Priority/CPC): **ELIGIBLE**
  - `OFFSITE_ADS`: **ELIGIBLE**
- Note the naming split: the Account API still speaks legacy program names (`PROMOTED_LISTINGS_STANDARD/_ADVANCED`); bare `PROMOTED_LISTINGS` is rejected (error 50116). The Marketing API uses funding models (`COST_PER_SALE`/`COST_PER_CLICK`). Our layer must map both.
- `EbayCampaign` table in the DB: **0 rows** (sync has never succeeded — consistent with the 403).

### 1.3 Size-aspect spot check (2026 apparel mandate)

- DB-side: 20/20 ACTIVE `ChannelListing` rows store `itemSpecifics`; 19/20 carry a size-like key. **Key naming is inconsistent** — mostly `Size`, one row `Taglia` (the actual eBay IT aspect name). Values are standard tokens (XS–4XL).
- Live-side (Trading `GetItem` sample): all jacket listings carry `Taglia` as a variation specific (`varSpecifics=["Colore","Taglia"]` etc.); sliders/protectors have no size aspect (plausible for non-apparel categories, to be confirmed against the enforcement category list in `E0-EBAY-CAPABILITY-MATRIX.md`).
- Verdict: **no immediate red flag**, but a proper compliance audit (all items × the mandated aspect set per category) belongs in the E2 sync (we'll have every listing's aspects locally) — see Findings.

## 2. The three product→listing stores (schema truth)

### 2.1 `ChannelListing` — standard one-listing-per-(product, channel, marketplace) (`schema.prisma:1413`)

| Field | eBay meaning |
|---|---|
| `productId` | master product (variant-level in this catalog) |
| `channel='EBAY'`, `region`, `channelMarket` (legacy), `marketplace` (`IT`/`DE`/`FR`/`ES`/`GLOBAL`/`DEFAULT`) | identity |
| **`externalListingId`** | **eBay ItemID** (12-digit) |
| `platformProductId` | analytics grouping = ItemID |
| `listingStatus` | `DRAFT/ACTIVE/INACTIVE/ENDED/ERROR` (+ `REMOVED` written by reconcile cron) |
| `platformAttributes` JSON | `{ itemSpecifics, categoryId, conditionId, __offerIds }` (`__offerIds` = per-marketplace eBay offer IDs, written by `ebay-variation-push.service.ts:224`) |
| `flatFileSnapshot` JSON | verbatim flat-file row |
| `quantity/price/salePrice/stockBuffer/offerActive/fulfillmentMethod` | pricing/qty/fulfillment |

Unique `(productId, channel, marketplace)`; indexed on `externalListingId`, `(channel, marketplace, listingStatus)`.

### 2.2 `SharedListingMembership` — the shared-SKU fan-out map (`schema.prisma:13607`)

One row per **(marketplace, itemId, sku)** — THE mechanism for one product appearing in many item IDs:

| Field | Meaning |
|---|---|
| `marketplace` | `IT/DE/FR/ES/UK` |
| `sku` | shared variant SKU (= eBay Custom Label) |
| **`itemId`** | eBay ItemID of the listing containing this variant |
| `parentSku` | operator-facing grouping |
| **`productId`** | Nexus product feeding stock — **nullable** (null for imported/legacy members until a SKU-lookup backfill runs) |
| `variationSpecifics` JSON | e.g. `{ "Taglia": "M", "Colore": "Nero" }` — best per-ItemID source for the apparel Size aspect |
| `status` | `'ACTIVE'`/`'ENDED'` — set to ACTIVE at creation and **never updated by any code path (grep-confirmed: no writer flips it to ENDED)** |
| `price`, `lastQtyPushed`, `lastPushedAt`, `lastError` | per-listing push state |

### 2.3 `VariantChannelListing` — per-variant, per-marketplace (`schema.prisma:1357`)

`variantId` + `channel` + `marketplace` (unique), `externalListingId` (ItemID), `externalSku`, `listingStatus` (`PENDING/ACTIVE/ENDED/UNSOLD/SOLD`).

### 2.4 Legacy/auxiliary fields

- `Product.ebayItemId` + `Product.ebayTitle` (legacy single shared ID at parent level).
- `ProductVariation.ebayVariationId`; `ProductVariation.marketplaceMetadata.ebay.itemSpecifics`.
- `Marketplace(channel='EBAY', code='IT'…)` reference table (`schema.prisma:1631`).
- `ListingReconciliation` (`schema.prisma:11902`) — import/match staging (`externalListingId`, `matchedProductId`, `matchMethod`, `reconciliationStatus`).

## 3. How product→itemIDs resolves today — and where it breaks

**Writers of the mapping:**
- `pushVariationGroup` (`ebay-variation-push.service.ts:1096–1128`) — Trading `AddFixedPriceItem` multi-variation → sets `ChannelListing.externalListingId` + `ACTIVE`.
- `createSharedListing` (`ebay-shared-listing-push.service.ts:172–187`) — Trading create → writes `SharedListingMembership` rows (`status:'ACTIVE'`).
- Import matcher `ebay-sync.service.ts:367,427` — sets `externalListingId = match.ebayItemId` from reconciliation.

**Readers (each partial):**
- `enqueueSharedTradingFanout` (`ebay-shared-fanout.service.ts:114`) — `SharedListingMembership WHERE productId=X AND status='ACTIVE'` (shared only).
- Ad-hoc `prisma.channelListing.findMany({ productId, channel:'EBAY', marketplace, listingStatus:'ACTIVE' })` inline in cockpit/gap code (standard only).

**A correct resolver must UNION both stores (+ optionally `VariantChannelListing`), filter live, and de-dup by ItemID — it does not exist.** Compounding gaps:

1. **Discovery**: 19 of 20 live items have no row in *either* store (created in Seller Hub before Nexus, or pre-shared-SKU pushes). Nothing imports them today; the flat-file "pull preview" imports rows on operator demand, not as a sync.
2. **Nullable `SharedListingMembership.productId`** breaks product→items even for tracked shared listings until the SKU-lookup backfill runs (documented in `docs/superpowers/plans/2026-07-02-ebay-shared-sku-flatfile-unblock-persist.md`).
3. **Marketplace vocabulary drift**: 2-letter codes (`IT`) in listing stores vs `EBAY_IT` in campaign stores vs Trading site IDs (101) — mapped ad-hoc via `siteIdForMarket` (`ebay-trading-api.service.ts`), `ebayMarketplaceIdForMarket` (`ebay-shared-fanout.service.ts:20`), `toMarketplaceId` (`ebay-variation-push.service.ts:1276`). UK→`EBAY_GB`.

## 4. End/relist + stock reconciliation state

| Mechanism | Cadence | Default | Covers | Gap |
|---|---|---|---|---|
| `ebay-status-reconcile.job.ts` (Inventory API `GET /offer?sku=`) | daily 02:00 | **OFF** (`NEXUS_ENABLE_EBAY_STATUS_RECONCILE_CRON=1`) | `ChannelListing` only, first active connection only | Trading-created shared listings have no Inventory offers → never reconciled |
| `ebay-readback.job.ts` → `recordChannelStockEvent` | every 30 min | ON (opt-out `NEXUS_EBAY_READBACK=0`) | published qty per active `ChannelListing` SKU (cap `NEXUS_EBAY_READBACK_MAX`=200) | drift detection only; not per-ItemID live-stock truth |
| Platform Notifications (site 101) | push | ON | `AuctionCheckoutComplete`, `FixedPriceTransaction`, `ItemSold`, `ItemMarkedAsShipped`; handler also processes `ItemRevised`/order topics (`ebay-notification.routes.ts:422–540`) | **`ItemRevised` subscription was rejected by eBay for this seller's Trading permission level**; no item-ended/relisted topics subscribed |
| `SharedListingMembership.status` | — | — | — | **no writer ever flips ACTIVE→ENDED**; relists get a new ItemID that nothing relinks |

**Ads consequence:** ads attached to an ended ItemID die silently; a relist (new ItemID) is unpromoted until manually re-added. eBay auto-hides out-of-stock ads (resurface on restock) — we can *display* that state only if we hold per-ItemID live quantity, which we currently don't (nearest signals: `ChannelListing.quantity`, `StockLevel`, `SharedListingMembership.lastQtyPushed` — the last is "last pushed", not eBay truth).

## 5. What exists and is directly reusable

- **OAuth**: scope list already includes `sell.marketing`; token auto-refresh cron every 30 min (`ebay-token-refresh.job.ts`, default-ON); re-consent flow = `POST /api/ebay/auth/initiate` → open `authUrl` → `/callback` (also Settings → Channels → reconnect). Admin helpers: `GET /api/admin/ebay-token-status`, `POST /api/admin/refresh-ebay-tokens`.
- **Marketing API client**: `postEbayMarketing()` (`ebay-marketing-dispatch.service.ts`) already POSTs `item_promotion` (volume pricing) and `item_price_markdown_promotion` (markdown). ⚠️ Caveat from live probe: these *code paths* are sound but the token 403s on `sell.marketing` today — so markdown/volume-pricing pushes cannot have run live either. After re-consent they and the ads writes share one working client.
- **Campaign read/sync**: `syncEbayCampaigns()` (`marketing/ebay-marketing-api.service.ts`) → `EbayCampaign`; shadow mirror to `MarketingCampaign` (`ebay-backfill.service.ts`); read-only `EbayAdapter` with `applyMutation`/`setBudget` deliberately throwing until `NEXUS_MARKETING_WRITES_EBAY` + creds.
- **Per-marketplace plumbing**: site-ID + `EBAY_xx` mapping, publish gate (`ebay-publish-gate.service.ts`: mode resolution, token-bucket, circuit breaker per connection×marketplace), `recordApiCall` → `OutboundApiCallLog`.
- **Queues**: `OutboundSyncQueue` with eBay dispatchers `syncToEbay` (Inventory GET-merge-PUT) and `syncSharedTradingQuantity` (`outbound-sync.service.ts:1161`, Trading `ReviseInventoryStatus`, writes back membership push state).
- **Aspects for size audits**: `SharedListingMembership.variationSpecifics` + `ChannelListing.platformAttributes.itemSpecifics` + cockpit `PATCH /ebay/cockpit/aspects`.
- **SSE**: `ebay_push.status_changed` events (`ebay-feed-poll.job.ts:227`); web hook `useEbayChannelEvents.ts`.

## 6. Resolution strategy for product-first ads (what E2 must build)

1. **`EbayListingIndex` (or equivalent unified read model)** — one row per live (marketplace, itemId): title, category, price, currency, quantity, variation SKUs, aspects, source (`CHANNEL_LISTING` | `SHARED_MEMBERSHIP` | `DISCOVERED`), productIds[] (resolved), firstSeen/lastSeen/endedAt. Rebuilt by a **listing-discovery sync** (Trading `GetMyeBaySelling`/`GetSellerList`, paginated, per site) at ad-relevant cadence + on `ebay_push` events. This is the ads-side source of truth and never touches the untouchable flat-file routes.
2. **Resolver service** — `getLiveEbayItemIds(productId | productIds, marketplace?)`: union of `SharedListingMembership (status='ACTIVE', productId backfilled)` ∪ `ChannelListing (listingStatus='ACTIVE')` ∪ discovery index matches (SKU → product via `Product.sku`; title/attribute-assisted match queue for the 11 SKU-less legacy items, operator-confirmable, staged in `ListingReconciliation`).
3. **`SharedListingMembership.productId` backfill** + status maintenance: discovery sync flips `status='ENDED'` when an itemId disappears from the account's active list; relist detection re-links successor ItemIDs (same SKU set/title heuristics) and re-attaches ads per policy (propose or autopilot).
4. **Per-ItemID stock state** — discovery sync captures live quantity per item (and per variation where relevant) so the console can show eBay's "ad hidden — out of stock" state honestly.
5. **Drift contract for ads**: every ad row references (marketplace, itemId); nightly + event-driven reconciliation marks ads whose itemId is no longer live as `STALE` and (per rule mode) proposes removal/re-attach — never silent.

### Design consequences for the console

- **Attach by listing ID, not SKU**: 11/20 live items have no SKUs; `bulkCreateAdsByListingId` is the universal path, `bulkCreateAdsByInventoryReference` an optimization for Nexus-pushed listings.
- **Product cards must show N live listings per marketplace** (GALE → 5 on IT), each with its own suggested rate/performance, with "promote all / promote selected".
- **IT-first rollout, multi-market-ready schema**: every ad entity keys on `marketplace` from day 1, but don't block the console on DE/FR/ES having zero listings.
- **Campaign-store naming**: adopt Marketing API vocabulary (`COST_PER_SALE`/`COST_PER_CLICK`) in new tables; keep the Account API program names only at the eligibility probe boundary (see capability matrix §program-naming).
