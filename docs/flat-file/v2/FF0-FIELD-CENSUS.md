# FF0-FIELD-CENSUS — Exhaustive field inventory (proves Fidelity Contract §3)

> Phase FF0 (read-only). Source of truth: `packages/database/prisma/schema.prisma` (14,113 lines), read end-to-end for the target models, cross-checked against `apps/api/src` write-ops. This census proves **every editable field has exactly one workbook cell, and every non-editable field is accounted for** (readonly, derived, excluded).
>
> ⚠️ **Built on the CORRECTED model chain** (see FF0-FINDINGS F1): the workbook is generated from **`Product`** (parent + child rows, SHARED data) + **`ChannelListing`** (per `productId × channel × marketplace`, MARKET-SCOPED). `ProductVariation` / `VariantChannelListing` are deprecated/eBay-residual and are **read-only legacy** (§7).

---

## 1. Classification legend

Every field is tagged with **class** and **scope**, which together decide its workbook treatment.

| Class | Meaning | Workbook treatment |
|---|---|---|
| **IDENTITY** | Keys: SKU, parent SKU, ASIN, EAN/GTIN, eBay item id | forced-text cell; used for row matching; most are read-only after creation |
| **EDITABLE** | Operator-owned master data or listing content | normal editable cell |
| **READONLY-SYNCED** | Mirrored FROM the channel/SP-API (live status, buybox, fees) | greyed READONLY column; exported for reference, **ignored on import** (Contract §7) |
| **DERIVED** | Computed by jobs (rollups, metrics, master-snapshot cache) | greyed READONLY column |
| **SYSTEM** | id / timestamps / soft-delete / concurrency / structural flags | excluded from cells; some surface as READONLY meta |

| Scope | Meaning | Sheet |
|---|---|---|
| **SHARED** | One value across all markets | `Products` sheet (from `Product`) |
| **MARKET-SCOPED** | Per-marketplace value | channel sheet, `field@MARKET` column (from `ChannelListing`) |

**Blank policy** (Contract §4, Part IV): blank cell = *no change*; `__CLEAR__` sentinel = *set field empty*. Applies to every EDITABLE cell symmetrically.

---

## 2. `Product` — SHARED master data → **`Products` sheet** (`schema.prisma:83-453`)

All scalars are SHARED (one value per product across markets). CHANNEL noted where an identifier is channel-specific.

### 2.1 Identity & structure

| field | type | class | workbook column | notes |
|---|---|---|---|---|
| `sku` | String @unique | IDENTITY | `sku` (forced text, frozen) | master/parent SKU — row key |
| `parentId` → `Product` | String? | IDENTITY/struct | *(derived)* `parent_sku` | resolved to parent's SKU for the file |
| `masterProductId` | String? | SYSTEM/struct | — | legacy master link; excluded |
| `isParent` / `isMaster` / `isMasterProduct` | Boolean | SYSTEM/struct | `hierarchy_level` (derived: PARENT/CHILD/STANDALONE) | **F15**: 3 overlapping flags → collapse to one derived column |
| `isBundle` | Boolean | SYSTEM | `is_bundle` (readonly) | |
| `masterSku` | String? | IDENTITY | `master_sku` (forced text) | internal master SKU |
| `variationTheme` / `variationAxes[]` | String / String[] | EDITABLE | `variation_theme`, `variation_axes` | axes joined with ` \| ` |
| `amazonAsin` | String? | IDENTITY (Amazon) | `asin` (forced text) | parent ASIN, non-buyable |
| `parentAsin` | String? | IDENTITY (Amazon) | *(excluded — dup of `amazonAsin`, F15)* | |
| `ebayItemId` | String? | IDENTITY (eBay) | `ebay_item_id` (forced text) | |
| `shopifyProductId` | String? | IDENTITY (Shopify) | `shopify_product_id` (forced text) | |
| `woocommerceProductId` | Int? | IDENTITY | *(excluded — out of active scope)* | |
| `upc` / `ean` / `gtin` | String? | IDENTITY | `upc`, `ean`, `gtin` (forced text) | **leading-zero/scientific-notation risk — forced text mandatory** |
| `fnsku` | String? | READONLY-SYNCED (Amazon) | `fnsku` (readonly) | cached from SP-API |

### 2.2 Editable master content

| field | type | class | workbook column |
|---|---|---|---|
| `name` | String | EDITABLE | `name` |
| `description` | String? | EDITABLE | `description` |
| `bulletPoints[]` | String[] | EDITABLE | `bullet_points` (join ` \| `) |
| `keywords[]` | String[] | EDITABLE | `keywords` (join ` \| `) |
| `brand` / `manufacturer` | String? | EDITABLE | `brand`, `manufacturer` |
| `ebayTitle` | String? | EDITABLE (eBay) | `ebay_title` |
| `productType` | String? | EDITABLE (Amazon) | `product_type` |
| `status` | String ("ACTIVE") | EDITABLE | `status` (enum: DRAFT/ACTIVE/INACTIVE — app-enforced) |
| `fulfillmentMethod` | FulfillmentMethod? | EDITABLE | `fulfillment_method` (FBA/FBM) |
| `fulfillmentChannel` | FulfillmentMethod? | EDITABLE | *(excluded — dup of `fulfillmentMethod`, F15)* |
| `shippingTemplate` | String? | EDITABLE (FBM) | `shipping_template` |

### 2.3 Physical / logistics / compliance (EN 17092, GPSR, customs)

| field | type | class | workbook column |
|---|---|---|---|
| `weightValue` / `weightUnit` | Decimal(10,3)/String | EDITABLE | `weight_value`, `weight_unit` |
| `dimLength` / `dimWidth` / `dimHeight` / `dimUnit` | Decimal(10,2)/String | EDITABLE | `dim_length`, `dim_width`, `dim_height`, `dim_unit` |
| `hsCode` / `countryOfOrigin` | String? | EDITABLE | `hs_code`, `country_of_origin` |
| `ppeCategory` | String? | EDITABLE | `ppe_category` (CAT_I/II/III) |
| `garmentClass` | String? | EDITABLE | `garment_class` (EN 17092 AAA/AA/A/B/C) |
| `notifiedBodyNumber` / `notifiedBodyName` | String? | EDITABLE | `notified_body_number`, `notified_body_name` |
| `declarationOfConformityUrl` | String? | EDITABLE | `doc_url` |
| `hazmatClass` / `hazmatUnNumber` | String? | EDITABLE | `hazmat_class`, `hazmat_un_number` |
| `impactProtectors` | Json? | EDITABLE | **JSON — flatten or exclude (§6)** |

### 2.4 Pricing & cost (master-level)

| field | type | class | workbook column |
|---|---|---|---|
| `basePrice` | Decimal(10,2) | EDITABLE | `base_price` (locale-safe decimal) |
| `costPrice` | Decimal(10,2)? | EDITABLE | `cost_price` |
| `minPrice` / `maxPrice` | Decimal(10,2)? | EDITABLE | `min_price`, `max_price` |
| `minMargin` | Decimal(5,2)? | EDITABLE | `min_margin` |
| `costingMethod` | String ("WAC") | EDITABLE | `costing_method` (WAC/FIFO/LIFO) |
| `weightedAvgCostCents` | Int? | DERIVED | `wac_cents` (readonly) |
| `b2bPrice` / `b2bMinQty` | Decimal/Int? | EDITABLE (Amazon B2B) | `b2b_price`, `b2b_min_qty` |
| `buyBoxPrice` / `competitorPrice` | Decimal(10,2)? | **READONLY-SYNCED** (Amazon) | `buybox_price`, `competitor_price` (readonly) |
| `serviceLevelPercent` / `orderingCostCents` / `carryingCostPctYear` | Decimal/Int? | EDITABLE | replenishment econ (3 cols) |

### 2.5 Stock & derived rollups

| field | type | class | workbook column |
|---|---|---|---|
| `totalStock` | Int (0) | DERIVED | `total_stock` (readonly — real ledger is `StockLevel`) |
| `lowStockThreshold` | Int (10) | EDITABLE | `low_stock_threshold` |
| `abcClass` | String? | DERIVED | `abc_class` (readonly) |
| `firstInventoryDate` | DateTime? | SYSTEM/DERIVED | `first_inventory_date` (readonly, ISO) |
| `linkedToChannels[]` / `syncChannels[]` | String[] | DERIVED/SYSTEM | `linked_channels` (readonly) |
| `validationStatus` / `validationErrors[]` | String/String[] | DERIVED | `validation_status`, `validation_errors` (readonly) |
| `hasChannelOverrides` / `lastChannelOverrideAt` | Boolean/DateTime? | DERIVED | *(readonly meta)* |

### 2.6 JSON content blobs (round-trip risk — see §6)

| field | type | class | treatment |
|---|---|---|---|
| `categoryAttributes` | Json? | EDITABLE | **flatten dotted or exclude** — Amazon product-type attributes; the flat-file editor expands these via the manifest, not raw JSON |
| `localizedContent` | Json `{en:{},it:{}}` | EDITABLE | **flatten per-locale** (`localizedContent.it.title`) or exclude |
| `aPlusContent` | Json? | EDITABLE | **exclude** (rich content — not a cell) |
| `variantAttributes` | Json? (child rows) | EDITABLE | **flatten per-axis** (`attr.Color`, `attr.Size`) — this is how variant axis values are stored on child `Product` rows |

### 2.7 System / provenance / lifecycle (excluded or readonly-meta)

`familyId` (EDITABLE FK → `family_id`), `workflowStageId` (SYSTEM), `reviewStatus` (SYSTEM/EDITABLE), `importSource`/`importedAt` (SYSTEM), `imageAxisPreference` (SYSTEM), `cascadedFields[]` (SYSTEM), `lastAmazonSync`/`amazonSyncStatus`/`amazonSyncError` (READONLY-SYNCED → `amazon_sync_status` readonly), `version` (SYSTEM — **stripped on import, F16**), `deletedAt` (SYSTEM — soft delete, **never resurrected via import**), `createdAt`/`updatedAt` (SYSTEM → readonly meta).

### 2.8 Relation-only (not scalar cells — separate handling)

Images (`images` ProductImage, `listingImages`) → **image URL list, separate `Images` sheet or URL columns** (§6). Everything else in the ~70 relation list (L155-397: `tierPrices`, `certificates`, `lots`, `serials`, `channelListings`, `orderItems`, …) is out-of-band and not authored via product cells. **`tierPrices` (`ProductTierPrice`)** and **certificates** are candidate future sub-sheets (FFD-level).

---

## 3. `ChannelListing` — MARKET-SCOPED → **channel sheets** (`schema.prisma:1413-1626`)

The live per-market row. One `ChannelListing` per `(productId, channel, marketplace)`. On the workbook these become **`field@MARKET` columns** on the channel sheet (e.g. `price@IT`, `quantity@DE`, `title@FR`).

### 3.1 Identity (per row)

| field | type | class | workbook column |
|---|---|---|---|
| `productId` → `Product` | String | IDENTITY(FK) | *(resolved to `sku`)* |
| `channel` | String | IDENTITY | *(the sheet: Amazon/eBay/Shopify)* |
| `marketplace` | String ("DEFAULT") | IDENTITY | *(the `@MARKET` suffix)* |
| `region` / `channelMarket` | String | IDENTITY (legacy) | *(excluded — superseded by `marketplace`, F15)* |
| `externalListingId` | String? | IDENTITY | `listing_id@MKT` (forced text — ASIN/ItemID/ProductID) |
| `externalParentId` | String? | IDENTITY (Amazon) | `parent_listing_id@MKT` (forced text) |
| `platformProductId` | String? | IDENTITY | *(analytics key — readonly)* |

### 3.2 Per-market editable content — **but gated by the resolver (F2)**

Each of these has a **follow-master toggle**, a **cached master snapshot**, and an **override column**. The workbook must expose the control so the round trip is explicit (see FFD10).

| concept | follow flag | override column | cached master | workbook columns |
|---|---|---|---|---|
| title | `followMasterTitle` (true) | `titleOverride` | `masterTitle` (DERIVED) | `title@MKT` + `title_follows_master@MKT` |
| description | `followMasterDescription` | `descriptionOverride` | `masterDescription` | `description@MKT` + `desc_follows_master@MKT` |
| price | `followMasterPrice` | `priceOverride` (and `price`) | `masterPrice` | `price@MKT` + `price_follows_master@MKT` |
| quantity | `followMasterQuantity` | `quantityOverride` (and `quantity`) | `masterQuantity` | `quantity@MKT` + `qty_follows_master@MKT` |
| bullet points | `followMasterBulletPoints` | `bulletPointsOverride[]` | `masterBulletPoints[]` | `bullets@MKT` + `bullets_follows_master@MKT` |
| images | `followMasterImages` | *(image relation)* | — | *(images sheet)* |

Additional per-market editable:

| field | type | class | workbook column |
|---|---|---|---|
| `salePrice` | Decimal? | EDITABLE | `sale_price@MKT` |
| `pricingRule` | PricingRuleType (FIXED) | EDITABLE | `pricing_rule@MKT` (FIXED/MATCH_AMAZON/PERCENT_OF_MASTER) |
| `priceAdjustmentPercent` | Decimal? | EDITABLE | `price_adj_pct@MKT` |
| `fulfillmentMethod` | FulfillmentMethod? | EDITABLE | `fulfillment@MKT` (FCF.1 — per channel×market) |
| `stockBuffer` | Int (0) | EDITABLE | `stock_buffer@MKT` |
| `bestOfferFloor` | Decimal? | EDITABLE (eBay) | `best_offer_floor@MKT` |
| `variationTheme` / `variationMapping` | String?/Json? | EDITABLE | `variation_theme@MKT` (+ mapping flatten/exclude) |
| `syncFromMaster` / `syncLocked` / `isPublished` / `offerActive` | Boolean | EDITABLE (control) | `sync_from_master@MKT`, `sync_locked@MKT`, `is_published@MKT`, `offer_active@MKT` |

### 3.3 Per-market READONLY-SYNCED / DERIVED (greyed, ignored on import)

| field | class | workbook column (readonly) |
|---|---|---|
| `listingStatus` | READONLY-SYNCED | `status@MKT` |
| `syncStatus` / `lastSyncStatus` / `lastSyncError` / `lastSyncedAt` / `syncRetryLastAt` | READONLY-SYNCED | `sync@MKT` group |
| `estimatedFbaFee` / `referralFeePercent` / `feeFetchedAt` | DERIVED/SYNCED | `fba_fee@MKT`, `referral_pct@MKT` |
| `lowestCompetitorPrice` / `competitorFetchedAt` | READONLY-SYNCED | `competitor_price@MKT` |
| `validationStatus` / `validationErrors[]` | DERIVED | `validation@MKT` |
| `lastOverrideAt` / `lastOverrideBy` | SYSTEM | *(meta)* |
| `version` | SYSTEM | **stripped on import** |

### 3.4 JSON / snapshot on ChannelListing (round-trip risk)

| field | class | treatment |
|---|---|---|
| `platformAttributes` | EDITABLE/mixed | **flatten per-channel** (browseNode, itemSpecifics) or exclude |
| `overrideData` | EDITABLE | **the override-JSON layer of the resolver (F2)** — do not author raw; the override *columns* are the interface |
| `variationMapping` | EDITABLE | flatten or exclude |
| `flatFileSnapshot` | EDITABLE/SNAPSHOT | **EXCLUDE from cells — never regenerate** (see FF0-FINDINGS/MEMORY re-parenting trap; §6) |

---

## 4. Enums (verbatim — the ONLY two real DB enums on target models)

```prisma
enum FulfillmentMethod { FBA  FBM }                              // schema.prisma:10
enum PricingRuleType   { FIXED  MATCH_AMAZON  PERCENT_OF_MASTER } // schema.prisma:77
```

**Everything else is a free-text String** with values enforced only in application code (F16). The workbook enforces them in the **import layer** as strict/open enums (Contract §5, §8). Documented allowed sets:

- `Product.status` ∈ {DRAFT, ACTIVE, INACTIVE}
- `channel` ∈ {AMAZON, EBAY, SHOPIFY, WOOCOMMERCE, ETSY} (active: AMAZON, EBAY, SHOPIFY)
- `ChannelListing.listingStatus` ∈ {DRAFT, ACTIVE, INACTIVE, ENDED, ERROR}
- `ChannelListing.syncStatus` ∈ {IDLE, PENDING, SYNCING, IN_SYNC, FAILED}
- `VariantChannelListing.listingStatus` ∈ {PENDING, ACTIVE, INACTIVE, ERROR, ENDED, UNSOLD, SOLD}

> Note: `enum SyncChannel` (L57, AMAZON/EBAY/SHOPIFY/WOOCOMMERCE/GOOGLE/META/TIKTOK) exists but the target models do **not** use it.

For **Amazon channel columns**, the authoritative enum options come from the **live Amazon JSON Schema** via the manifest (`flat-file.service.ts`), not from the DB — the workbook's Amazon sheet reuses the manifest's `options` + `enumMode`. For **eBay**, from the static registry + category aspects.

---

## 5. Reference / config models (NOT product-workbook cells)

| model | role | workbook treatment |
|---|---|---|
| `Marketplace` (L1631) | market registry (code, marketplaceId, currency, isActive, vatRate) | **reference only** — drives which `@MARKET` columns exist; a separate read-only `Markets` legend on `_meta`/`README`, never round-tripped |
| `ChannelConnection` (L5224) | OAuth/credentials (accessToken/refreshToken/ebay*) | **NEVER export/import** — secrets (MEMORY: preserve sensitive config) |
| `ChannelListingOverride` (L1682) | per-field audit trail | SYSTEM/audit — excluded |
| `ProductTierPrice` (L904) | B2B/volume tiers | candidate future sub-sheet (out of v1 scope unless Owner wants it) |

---

## 6. Round-trip risk register (fields that cannot survive a naïve cell round-trip)

| field(s) | why it breaks | workbook rule |
|---|---|---|
| `ChannelListing.flatFileSnapshot` | opaque verbatim Amazon-row map incl. gated fields; re-parenting trap (MEMORY) | **EXCLUDE**; never regenerate from cells; edits go to real columns |
| `Product.categoryAttributes / localizedContent / variantAttributes / aPlusContent / impactProtectors`; `ChannelListing.platformAttributes / overrideData / variationMapping`; `VariantChannelListing.channelSpecificData` | arbitrary-depth JSON — one-cell-one-field impossible | **flatten with dotted keys** where a stable shape exists (`localizedContent.it.title`, `attr.Color`), else **exclude**; document in README |
| Array columns: `bulletPoints, keywords, variationAxes, cascadedFields, linkedToChannels, syncChannels, validationErrors`; `masterBulletPoints, bulletPointsOverride` | `String[]` can't be one scalar cell | **join with ` \| `** and split reliably on import (escaped); document delimiter |
| All READONLY-SYNCED (buyBoxPrice, competitorPrice, fnsku, listingStatus, estimatedFbaFee, master* cache, lastSynced*, …) | mirrored/computed — write-back no-ops or is overwritten by next sync | **READONLY** (greyed); exported for reference, ignored on import (Contract §7) |
| All DERIVED (totalStock, abcClass, weightedAvgCostCents, validationStatus, …) | recomputed by jobs — cell is a stale echo | **READONLY** |
| Image relations (`ProductImage`/`VariantImage`/`ChannelListingImage`) | 1:N, carry hashes/AI-analysis/sortOrder/isPrimary invariants — not scalar | **separate `Images` sheet / URL columns**; do not author binary/derived fields via cells |
| `ChannelConnection.accessToken/refreshToken/ebay*` | secrets | **never in the file** |
| `version` (Product, ChannelListing) | optimistic-concurrency counter; stale value → 409 on import | **strip on import**; import path re-reads current version |
| `deletedAt` | soft-delete flag | **never resurrected/hidden via a data cell**; deletion only via `Action=DELETE` |

---

## 7. Legacy chain (`ProductVariation` / `VariantChannelListing`) — read-only

Per F1, these are deprecated (`ProductVariation` 3 writes; `VariantChannelListing` 4 eBay-only writes). **Default: excluded from the round-trippable workbook.** If the Owner confirms live eBay-variation dependence (FFD9), they surface as a **readonly** `Legacy` reference block only. Their JSON blobs (`variationAttributes`, `lockedAttributes`, `marketplaceMetadata`, `channelSpecificData`) carry the same flatten/exclude rules as §6. Note `VariantChannelListing` has **no `createdAt`/`updatedAt`** and **two** competing price/qty fields (F15).

---

## 8. No-gaps proof (Fidelity Contract §3)

**Claim:** every *editable* field of the live product model has exactly one workbook cell; every *non-editable* field is explicitly readonly or excluded with a stated reason.

- **`Product`:** all 90-odd scalar fields enumerated in §2. Every EDITABLE scalar → one `Products`-sheet column. Every non-editable → READONLY column or excluded-with-reason (§2.7, §2.8, §6). JSON/array handled by §6 conventions.
- **`ChannelListing`:** all fields enumerated in §3. Every EDITABLE per-market field → one `field@MARKET` column (with its follow/override control where the resolver applies, §3.2). Every SYNCED/DERIVED → greyed `@MARKET` readonly. JSON/snapshot per §3.4/§6.
- **Reference/config models (§5), images, legacy chain (§7):** explicitly out of the cell grid with stated handling.

**Residual gaps to close in FF0-WORKBOOK-SPEC / at the gate:**
1. **JSON flattening set** — exactly which nested keys of `categoryAttributes`/`localizedContent`/`platformAttributes` become columns vs stay opaque (FFD7 + census-driven; the Amazon manifest already enumerates the expandable set).
2. **Resolver exposure** — the follow-flag + override column model for F2 (FFD10) needs Owner sign-off before it's locked.
3. **Images** — sheet vs URL-columns decision (proposed: `Images` sheet keyed by SKU + slot).
4. **Legacy chain** — include-readonly vs exclude (FFD9).

Everything else is mapped. There is **no editable field without a home.**
