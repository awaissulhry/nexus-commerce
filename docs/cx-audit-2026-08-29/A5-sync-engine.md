# Audit A5 — Sync engines, normalisation / data path, webhook infrastructure

Read-only audit of `/Users/awais/nexus-commerce` on 2026-08-29. Every claim carries a `path:line`; paths are relative to the repo root unless stated. "unverified" means I did not find evidence either way.

Conventions: `api/` = `apps/api/src/`, `web/` = `apps/web/src/`, `schema` = `packages/database/prisma/schema.prisma`.

---

## 0. One-paragraph shape of the system

There is exactly ONE production outbound push engine — `OutboundSyncQueue` rows drained by `OutboundSyncService` (`api/services/outbound-sync.service.ts:522`) via a BullMQ worker (`api/workers/bullmq-sync.worker.ts:33`) with a 60-second DB-polling backstop (`api/workers/sync.worker.ts:60`). Around it sit (a) three generations of earlier "orchestrators" that are dead or retired but still compiled, (b) a Phase-27 `channel-sync` BullMQ lane that builds payloads it never sends yet marks listings `IN_SYNC`, (c) a family of direct-to-API push paths (flat-file feeds, cockpit publish, eBay variation push, pricing dispatcher, variation processor) that bypass the queue, and (d) per-channel inbound pullers (Amazon report/catalog jobs, Shopify/Woo/Etsy pull services, eBay listing sync) that each map into the core model with their own field selection. Source-of-truth for *quantity* is centralised in one pure resolver (`api/services/sync-control-core.ts:146`) but only 5 of 16 `QUANTITY_UPDATE` producers call it; source-of-truth for title/description/price is a set of `followMaster*` booleans on `ChannelListing` (schema:1550-1553) honoured by ~28 files, not by one function. Webhook ingress is per-channel (Shopify/Woo/Etsy HTTP, eBay HTTP, Amazon via SQS poll) into one `WebhookEvent` table whose `(channel, externalId)` unique index is the idempotency key (schema:4633); outbound operator webhooks exist (`NotificationWebhook` + `webhook-dispatch.service.ts`) but only alert events are ever emitted.

---

## 1. Sync orchestrators / engines — inventory, entry points, liveness, overlap

### 1.1 Engine table

| # | Engine | Entry points (routes / jobs) | Channels | Live? | Evidence |
|---|---|---|---|---|---|
| E1 | `UnifiedSyncOrchestrator` (`api/services/sync/unified-sync-orchestrator.ts:37`) | none in `src`. Only reference is a stale build artefact `apps/api/dist/jobs/sync.job.js:7`; `api/jobs/sync.job.ts` does not exist. `api/routes/listings.ts:148-160` documents it as RETIRED (410). | SHOPIFY/WOO/ETSY via env; AMAZON/EBAY stubbed (`:228-231`, `:331-334`) | **DEAD** | `grep unifiedSyncOrchestrator api/src` → 0 importers. `syncProductToChannel` only logs (`:301-361`). Writes `VariantChannelListing` (`:417-424`). |
| E2 | `ProductSyncService` (`api/services/sync/product-sync.service.ts:81`) | imported only by E1 (`unified-sync-orchestrator.ts:11`) | n/a (SKU-regex parent/child upsert `:190-282`) | **DEAD** (transitively) | no other importer |
| E3 | `services/sync/index.ts` barrel (`:1-3`) | 0 importers (the only `services/sync'` grep hit is an unrelated carrier route `api/routes/fulfillment.routes.ts:15471`) | — | **DEAD** | |
| E4 | `DataValidationService` / `BatchRepairService` (`api/services/sync/data-validation.service.ts`, `batch-repair.service.ts`) | `api/routes/admin.ts:71-72` → `/admin/validation/report` (`:214`), `/admin/repair/*` (`:260-401`); `api/services/monitoring/monitoring.service.ts:8,51` | n/a (DB repair of Product/ProductVariation/Listing) | live in API, **no web caller** (`grep /api/admin/validation|repair web/` → 0) | writes `product.update` (`data-validation.service.ts:275`, `batch-repair.service.ts:176,323`) |
| E5 | Shopify / WooCommerce / Etsy **inbound pull** (`api/services/sync/shopify-sync.service.ts:57,443`, `woocommerce-sync.service.ts:52,375`, `etsy-sync.service.ts:55,406`) | jobs `api/jobs/{shopify,woocommerce,etsy}-sync.job.ts:7` — **no `cron.schedule` and no `start*Cron` in `index.ts`**; reachable only via manual trigger `CRON_REGISTRY` (`api/jobs/cron-registry.ts:219-221`) and routes `api/routes/shopify.ts:8`, `woocommerce.ts:8`, `etsy.ts:8`, `api/services/woocommerce-pushback/index.ts:94` | SHOPIFY, WOOCOMMERCE, ETSY | live-but-manual | Writes Product (`shopify-sync.service.ts:142,174,185`; `woocommerce-sync.service.ts:137,179,189,358`; `etsy-sync.service.ts:149,164,386`), Order (`shopify:551-559`, `woo:437`, `etsy:493`), legacy `Channel` rows (`woo:586`, `etsy:482`), `SyncLog` (the ONLY writers of SyncLog: 6 each in the three jobs). |
| E6 | Amazon "Vacuum" `syncAmazonEUCatalog` (`api/services/inbound-sync.service.ts:141`) | `api/routes/inbound.routes.ts:8,22,71` → `POST /api/inbound/sync-catalog`, registered `api/index.ts:640`. Web: `web/app/catalog/ImportCatalogButton.tsx` — **0 importers** (unmounted). | AMAZON | **BROKEN dead-on-arrival** | upsert key `productId_channel_region` (`inbound-sync.service.ts:59-64`) does not exist — schema only has `productId_channelMarket` (schema:1653) and `productId_channel_marketplace` (schema:1654) → Prisma throws. Hard-codes `region:'EU'`, `channelMarket:'AMAZON_EU'` (`:76-78`); own `new PrismaClient()` (`:14`). |
| E7 | Root `AmazonSyncService.syncAmazonCatalog` (`api/services/amazon-sync.service.ts`) | `api/routes/sync.routes.ts:2,90,113` → `POST /api/sync/amazon/catalog` (`:66-67`), `GET …/:syncId` (`:150`), `POST …/:syncId/retry` (`:194`); registered `api/index.ts:626`. Web: `web/components/inventory/SyncTriggerButton.tsx`, `SyncStatusModal.tsx` (mounted in `web/app/inventory/manage/ManageInventoryClient.tsx`) via Next proxy `web/app/api/sync/amazon/catalog/route.ts`. | AMAZON (request body = pre-fetched products) | live | Writes Product only (`amazon-sync.service.ts:158-286,406`). **Defect:** `getSyncStatus` does `syncLog.findUnique({id: syncId})` (`:355`) but `syncId` is a generated string `sync-<ts>-<rand>` (`:43`) and nothing in this service writes `SyncLog` (writers census: only the three E5 jobs) → status endpoint always throws "not found". |
| E8 | Root `ebaySyncService.syncEbayInventory` (`api/services/ebay-sync.service.ts:465`) | `api/routes/ebay.routes.ts:8,62` → `GET /api/sync/ebay/listings/:connectionId` (`:158`), `POST /api/sync/ebay/listings/:listingId/link` (`:269`). Web: `web/components/inventory/ChannelResolverClient.tsx` mounted at `web/app/products/resolve/page.tsx`. | EBAY (inbound listing discovery) | live | writes `VariantChannelListing` (`ebay-sync.service.ts:364,441`), `rawPayload` preserved (grep list §2.3) |
| E9 | Amazon nightly catalog refresh (`api/jobs/catalog-refresh.job.ts`) + manual `GET /api/amazon/products` (`api/routes/amazon.routes.ts:23`) | cron `0 3 * * *` (`catalog-refresh.job.ts:185`), gate `NEXUS_ENABLE_CATALOG_SYNC_CRON=1` (header `:11-13`) | AMAZON (MERCHANT_LISTINGS report) | live | Product upsert/update `:55,102,113,135,152` |
| E10 | Amazon attribute hydrate (`api/jobs/amazon-attr-hydrate.job.ts:1-8`) | `startAttrHydrateCron` (index.ts starter list) | AMAZON | live | writes only `ChannelListing.platformAttributes.attributes` (header `:3-5`) |
| E11 | Amazon FBA inventory poll (`api/jobs/amazon-inventory-sync.job.ts`) | `*/15 * * * *` (`:67`), gate `NEXUS_ENABLE_AMAZON_INVENTORY_CRON=1` (header `:16`) | AMAZON FBA only | live | delegates to `amazon-inventory.service` |
| E12 | **`OutboundSyncService`** (`api/services/outbound-sync.service.ts:522`) | consumers: BullMQ worker `api/workers/bullmq-sync.worker.ts:16,33` (`processSingle` `:611`), 60-s cron `api/workers/sync.worker.ts:60` (`processPendingSyncs` `:666`), started unconditionally `api/index.ts:415`; other importers: `api/jobs/sync-drift-detection.job.ts`, `api/routes/outbound.routes.ts`, `api/routes/catalog.routes.ts`, `api/services/bulk-action.service.ts`, `api/services/follow-master.service.ts` | AMAZON (`syncToAmazon :857`), EBAY (`:1094`), SHOPIFY (`:1826`), WOOCOMMERCE (`:2117`); ETSY not dispatchable (`dispatchSync :590-598`) | **LIVE — the real engine** | Does not itself write `ChannelListing` (grep `channelListing.update` in file → 0); the worker writes queue row + listing (`bullmq-sync.worker.ts:182,201,262,311,346,384,450`). |
| E13 | `OutboundSyncServicePhase9` (`api/services/outbound-sync-phase9.service.ts:19`) | only importer `api/services/variation-sync-processor.service.ts:13`, which uses just `markSyncSuccess`/`markSyncFailed` (`:49,148,171`). `handleChildVariationChange` (`:93`) has **0 callers**; `buildAndLogVariationPayload` (`:195`) 0 callers. | AMAZON | mostly dead | |
| E14 | `VariationSyncProcessor` (`api/services/variation-sync-processor.service.ts:17`) | `api/workers/bullmq-sync.worker.ts:15`; triggered by `LISTING_SYNC` rows with `payload.source ∈ {CHILD_VARIATION_CHANGE, VARIATION_THEME_UPDATE}` (`:190-195`) — **no producer of either source exists** outside E13 (grep → 0) | AMAZON | dead path, dangerous if ever fed | submits directly to `amazonSpApiClient.submitListingPayload` (`:99`) with hard-coded `currency:'USD'` (`:117`), bypassing publish gates/circuit/audit; own `PrismaClient` (`:15`); `getPendingVariationSyncs` uses an invalid Prisma where key `'payload.source'` (`:211-213`). |
| E15 | `syncActivatedListings` (`api/services/listing-activation-sync.service.ts:24`) | `api/routes/ebay-flat-file.routes.ts`, `api/routes/marketplaces.routes.ts:6`, `api/services/ebay-variation-push.service.ts` | AMAZON/EBAY/SHOPIFY (`VALID_CHANNELS :18`) | live | enqueues `QUANTITY_UPDATE` through `resolveIntendedQuantity` (`:72-91`) and instant lane (`:110-111`) |
| E16 | **Phase-27 `channel-sync` lane**: `api/workers/channel-sync.worker.ts:28` + `api/services/marketplaces/{amazon,ebay,shopify}-sync.service.ts` | producer `api/routes/catalog.routes.ts:1973` (`POST /api/catalog/sync/bulk`) ← web `web/app/inventory/manage/ManageInventoryClient.tsx:196` and `web/components/catalog/MarketplaceActionsDropdown.tsx` | AMAZON/EBAY/SHOPIFY | **live and harmful** | The services only *build* a payload and return it (`marketplaces/amazon-sync.service.ts:137-165`, `ebay-sync.service.ts:159`, `shopify-sync.service.ts:198`). The worker's guard `syncResult?.status === 'noop'` (`channel-sync.worker.ts:202`) never matches (no service returns a `status` field; grep `noop` in the three services → 0), so it falls into the else-branch and writes `syncStatus:'IN_SYNC', lastSyncStatus:'SUCCESS'` (`:209-216`) — a false success. It also fabricates a `ChannelListing` with `region:'US'`, `channelMarket:'<CH>_US'` when none exists (`:124-142`). |
| E17 | `channel-publish.service.ts` (MC.12 image publish) | `api/routes/channel-publish.routes.ts` (`/channel-publish/{amazon,ebay,shopify,woo,cascade}` `:45-331`), `api/routes/listing-wizard.routes.ts`, `api/jobs/scheduled-wizard-publish.job.ts`; web `web/app/marketing/content/publish/*` | AMAZON/EBAY/SHOPIFY/WOO | live, **sandbox-only** | every `live` branch returns `ok:false` "not yet wired" (`:80-88,127-135,168-176,214-222`); sandbox returns random fake ids (`:64,109,152,199`) |
| E18 | Direct-to-API listing pushes outside the queue: `marketplaces.routes.ts` `/products/:id/listings/:channel/:marketplace/publish` (`:959`) → `amazonSpApiClient.putListingsItem` (`:1046`); Amazon flat-file `POST /api/amazon/flat-file/submit` → `createFeedDocument` + `JSON_LISTINGS_FEED` (`api/routes/amazon-flat-file.routes.ts:669,689`) → `AmazonFlatFileFeedJob`; eBay flat-file + `ebay-variation-push.service.ts:1-6` → Inventory API → `EbayPushJob` (`ebay-flat-file.routes.ts` 5 writes); `pricing-outbound.service.ts:1-14` (price PATCH, writes `ChannelListingOverride`); eBay cockpit (`ebay-cockpit.routes.ts`, 15 `channelListing` writes) | AMAZON, EBAY | live | none of these go through `OutboundSyncQueue`; the listing-wizard `submission.service.ts:1-14` composes only ("putListingsItem is the missing integration"). |
| E19 | Read-back / drift / reconcile loops: `sync-drift-detection.job.ts` (`*/30`, `:390`; header `:1-20`), `amazon-qty-readback.job.ts` (`15 4 * * *`, `:253`), `ebay-readback.job.ts` (`*/30`, `:30`), `reconcile-cron.job.ts` (`45 3 * * *`, `:55`) → `channel-reconciliation.service.ts:189,325` (Amazon-only, report-only `:1-11`), `channel-stock-event.service.ts:92,253` (inbound drift triage) | AMAZON, EBAY (+SHOPIFY events) | live | |

### 1.2 Overlap — who can write the same fields

`ChannelListing` mutation census (non-test, `grep channelListing.(update|upsert|create|updateMany)`): 40 files. The heaviest: `ebay-cockpit.routes.ts` (15), `marketplaces.routes.ts` (14), `ebay-flat-file.routes.ts` (13), `listings-syndication.routes.ts` (10), `sync-control.routes.ts` (6), `ebay-variation-push.service.ts` (5), `channel-sync.worker.ts` (4), `flat-file/import/apply.ts` (4), `stock-import.service.ts` (3), `pricing-outbound.service.ts` (3), `amazon/flat-file-pull.service.ts` (3), `product-channel-data.routes.ts` (3), `catalog.routes.ts` (3), plus 2 each in `stock-movement`, `sp-api-pricing`, `promotion-scheduler`, `master-price`, `listing-wizard/submission`, `follow-master`, `channel-listing-cas`, `amazon/flat-file`, `amazon-market-offer`, `products.routes`, `pricing.routes`, `matrix.routes`, `dashboard.routes`, `amazon.routes`, `amazon-cockpit-publish.routes`, and 1 each in `bullmq-sync.worker`, `sync-control-policy`, `repricing-engine`, `repricer-scheduler`, `pim/reconcile-divergence`, `master-status`, `master-content`, `listings/recovery`, `listing-reconciliation`, `inbound-sync`, `flat-file/listing-content-write`, `feed/browse-node-predictor`.

Concrete same-field collisions:

| Field | Writers (≥2 engines) |
|---|---|
| `ChannelListing.quantity` / `quantityOverride` / `followMasterQuantity` | `follow-master.service.ts:17-18,249` · `stock-movement.service.ts` · `stock-import.service.ts` · `sync-control.routes.ts` · `inbound-sync.service.ts:69` (broken) · `channel-sync.worker.ts:137` (create) · flat-file apply (`flat-file/import/apply.ts`) · `sync-drift-detection.job` (self-heal) |
| `ChannelListing.price` / `priceOverride` | `pricing-outbound.service.ts` · `repricing-engine.service.ts` · `repricer-scheduler.service.ts` · `master-price.service.ts` · `sp-api-pricing.service.ts` · `promotion-scheduler.service.ts` · `marketplaces.routes.ts` (PUT listing `:445`) · `inbound-sync.service.ts:68` |
| `ChannelListing.syncStatus` / `lastSyncStatus` / `lastSyncedAt` | `channel-sync.worker.ts:209-216,244-249` (false success) · `bullmq-sync.worker.ts:262` · `marketplaces.routes.ts` publish (`:1065-1102`) · `listings-syndication.routes.ts` |
| `ChannelListing.title/description` | `inbound-sync.service.ts:66-67` · `master-content.service.ts` · `flat-file/listing-content-write.service.ts` · `marketplaces.routes.ts` · `ebay-cockpit.routes.ts` |
| `ChannelListing.platformAttributes` | 12 files (see §2.3) incl. `amazon-attr-hydrate` (E10) and `sync-drift-detection.job.ts` |
| `Product.basePrice / name / totalStock / description` | `inbound-sync.service.ts:28-52` · `product-sync.service.ts:190-282` (dead) · `shopify/woocommerce/etsy-sync.service` (E5) · `catalog-refresh.job.ts:55-152` · root `amazon-sync.service.ts:158-286` · `data-validation.service.ts:275` · `batch-repair.service.ts:176,323` |
| `VariantChannelListing.channelQuantity / lastSyncStatus` | `unified-sync-orchestrator.ts:417-424` (dead) · `ebay-sync.service.ts:364,441` · `shopify-sync.service.ts` (2) · `api/routes/inventory.ts` (2) · `api/routes/marketplaces.ts` (3) · `batch-repair.service.ts` |

Two engines that would push the **same quantity to the same channel by different rules**: the queue engine (E12, honours `resolveIntendedQuantity` at dispatch — `outbound-sync.service.ts` imports `sync-control-core`) versus `api/routes/marketplaces.ts` `POST /marketplaces/inventory/update` (`:144-145`) → `marketplaceService.updateInventory` (`api/services/marketplaces/marketplace.service.ts:241-349`) which pushes the raw body number (and answers "Not implemented" for AMAZON `:250-259`). That route is registered without prefix (`api/index.ts:617`) and has no web caller.

---

## 2. Normalisation — canonical model and mapping sites

### 2.1 Canonical core model today

| Entity | Key columns | Evidence |
|---|---|---|
| `Product` | `sku` (unique), channel ids `amazonAsin`, `ebayItemId`, `shopifyProductId`, `woocommerceProductId Int?` | schema:91-96 |
| | hierarchy `isParent`, `parentAsin`, `isMasterProduct` (legacy), `masterProductId` | schema:247,254,269,272-273,287 |
| | flexible bags `categoryAttributes Json?`, `localizedContent Json`, `aPlusContent Json?`, `variantAttributes Json?`, `syncChannels String[]` | schema:136,146,115,302,311 |
| `ProductVariation` | `amazonAsin` (child), `ebayVariationId`, `shopifyVariantId`; `variationAttributes Json?`, `lockedAttributes Json?`, `marketplaceMetadata Json?` | schema:1287-1289,1239,1244,1326 |
| `ChannelListing` (product × channel × marketplace) | `channel`, `region`, `marketplace` (`@default("DEFAULT")`), legacy `channelMarket`; ids `externalListingId`, `externalParentId`, `platformProductId`; content `title/description/price/salePrice/quantity`; `platformAttributes Json?`, `flatFileSnapshot Json?`, `overrideData Json`; follow flags `followMasterTitle/Description/Price/Quantity/Images/BulletPoints`; overrides `titleOverride/descriptionOverride/priceOverride/quantityOverride/bulletPointsOverride`; master snapshots `masterTitle…masterBulletPoints`; `syncStatus`, `lastSyncStatus`, `version` (CAS); uniques `[productId, channelMarket, channelConnectionId]` and `[productId, channel, marketplace, channelConnectionId]` | schema:1423-1665 (ids 1457-1464, bags 1489/1496/1516, flags 1550-1563, overrides 1576-1580, uniques 1653-1654) |
| `VariantChannelListing` (variant × channel × marketplace) | legacy `channelId → Channel`, `channelSku`, `channelProductId`, `externalListingId`, `externalSku`, `channelSpecificData Json?`, two price and two quantity columns (`channelPrice`/`currentPrice`, `channelQuantity`/`quantity`) | schema:1365-1419 (dupes 1391-1394) |
| `Offer` (per listing × fulfilment) | `sku`, `price`, `quantity`, `offerMetadata Json?` | schema:1982-2025 |
| `SharedListingMembership` (eBay shared variant) | `marketplace`, `sku`, `itemId`, `variationSpecifics Json`, `flatFileSnapshot`, unique `[marketplace, itemId, sku]` | schema:15529-15565 |
| `Order` | `channel OrderChannel`, `marketplace?`, `channelOrderId` unique with channel, per-channel `amazonMetadata/ebayMetadata/shopifyMetadata/woocommerceMetadata/etsyMetadata Json?` | schema:4884-4887,4963-4967,4980 |

### 2.2 Where each channel's payload is mapped in (function + line)

| Channel → entity | Mapping site | What it keeps |
|---|---|---|
| Amazon catalog → Product | `AmazonSyncService.syncAmazonCatalog` (`api/services/amazon-sync.service.ts:158-286`) — request body from the web, not SP-API | asin/parentAsin/title/sku/price/stock (interface `:3-13`); everything else dropped |
| Amazon MERCHANT_LISTINGS → Product | `catalog-refresh.job.ts:55-152` (`runCatalogRefresh`) | Product columns only; no ChannelListing write (grep `channelListing.` in file → 0) |
| Amazon catalog → Product+ChannelListing+Offer | `unpackAmazonCatalogItem` (`api/services/inbound-sync.service.ts:20-132`) | title/description/brand/manufacturer/price/quantity/asin — **broken** (§1 E6) |
| Amazon listing attributes → `ChannelListing.platformAttributes`, `flatFileSnapshot` | `api/services/amazon/flat-file-pull.service.ts` (3 CL writes), `amazon-attr-hydrate.job` (E10) | raw key→value preserved (schema:1491-1496) |
| Amazon orders → Order | `api/services/amazon-orders.service.ts` (`amazonMetadata` written 3×) | raw kept in `amazonMetadata` |
| eBay listings → VariantChannelListing | `ebaySyncService.createOrUpdateChannelListing` (`api/services/ebay-sync.service.ts:341-460`) | `rawPayload` preserved (grep §2.3) |
| eBay orders → Order | `api/services/ebay-orders.service.ts:455` (`order.create`), `ebayMetadata` ×3 | raw kept |
| eBay notifications → WebhookEvent / Order resync | `api/routes/ebay-notification.routes.ts:345-395` | full `payload` stored |
| Shopify products → Product (+VariantChannelListing) | `ShopifySyncService.syncProduct` (`api/services/sync/shopify-sync.service.ts:123-200`; upserts by `sku` with `shopifyProductId` `:142-185`) | title/price/stock/shopifyProductId; **no `channelSpecificData`/`platformAttributes` write in the file** (grep → 0) → tags, vendor, body_html, images, metafields dropped |
| Shopify orders → Order | `syncOrder` (`shopify-sync.service.ts:512-559`) and webhook `handleOrderCreate` (`api/routes/shopify-webhooks.ts:324-335`, `shopifyMetadata` ×3) | webhook path keeps raw; pull path unverified |
| Shopify inventory → ChannelStockEvent | `handleInventoryUpdate` (`shopify-webhooks.ts:168`) → `recordChannelStockEvent` | `rawPayload` kept (schema:4760) |
| WooCommerce products/orders | `WooCommerceSyncService.syncProduct` (`woocommerce-sync.service.ts:118`), `syncOrder :437`, `mapOrderStatus :564`, `getOrCreateWooCommerceChannel :580` | picks fields; no raw bag written (grep → 0) |
| Etsy listings/orders | `EstySyncService.syncListings :55` (`product.create :149`), `syncOrder :469` (`order.create :493`) | picks fields; no raw bag |
| PIM → channel payload (outbound) | `previewPayload` (`api/services/pim/payload-preview.ts:1-16`) over `Marketplace.schemaMapping` (schema:1704-1710; `api/services/pim/schema-mapping.service.ts:1-16`), merged by `applyMappingToSyncPayload` (`api/services/marketplaces/sync-mapping-merge.ts:78-129`) | only consumed by the E16 no-send lane |

### 2.3 Raw-JSON preservation vs dropped on the floor

Columns that preserve channel-native data and who writes them (`grep -l "<col>\s*:"`):

- `ChannelListing.platformAttributes` — 12 writer files: `jobs/sync-drift-detection.job.ts`, `routes/amazon-cockpit-publish.routes.ts`, `routes/amazon-cockpit.routes.ts`, `routes/catalog.routes.ts`, `routes/categories.routes.ts`, `routes/ebay-cockpit.routes.ts`, `routes/ebay-description-themes.routes.ts`, `routes/ebay-flat-file.routes.ts`, `routes/field-links.routes.ts`, `routes/flat-file-unified.routes.ts`, `routes/images/images-workspace.routes.ts`, `routes/listing-wizard.routes.ts`.
- `ChannelListing.flatFileSnapshot` — 12 files (Amazon + eBay flat-file/pull/verify/description services).
- `ChannelStockEvent.rawPayload` / `WebhookEvent.payload` — SQS poll, eBay notification, Shopify webhooks, `stock.routes`, `amazon-sqs.service`, `channel-stock-event.service`, `ebay-sync.service`.
- `Order.*Metadata` — `amazon-orders.service` (3), `ebay-orders.service` (3), `shopify-webhooks.ts` (3), refunds/financial services.
- `VariantChannelListing.channelSpecificData` and `ProductVariation.marketplaceMetadata` — written **only** by `api/services/import.service.ts` (CSV import), never by a channel sync.

Dropped on the floor (a mapping that picks N fields and discards the rest):

- E5 Shopify/Woo/Etsy pull services: Product upserts at `shopify-sync.service.ts:142-185`, `woocommerce-sync.service.ts:137-189`, `etsy-sync.service.ts:149-164` write name/price/stock/channel id; none of the three files writes any Json bag (grep `channelSpecificData|platformAttributes|marketplaceMetadata` → 0 in all three).
- Root `AmazonSyncService` (`amazon-sync.service.ts:3-13` interface) accepts eight scalar fields; `fulfillmentChannel`/`shippingTemplate` are in the interface but the Product writes at `:158-286` — unverified whether they land anywhere.
- `sync-mapping-merge.ts:31-39` `TOP_LEVEL` maps seven channel field keys to `title/description/price/quantity`; every other resolved field is pushed into `attributes` (`:65-68`) — fine in principle, but the consumer never sends (§1 E16).
- `ChannelListingOverride` rows (schema:1721-1750) are written by `pricing-outbound.service.ts` and `pricing.routes.ts` and **read by nobody** (readers census 0).

### 2.4 `ChannelSchema` — what, who fills, who reads

- Definition: per-field metadata `(channel, marketplace?, fieldKey, label, maxLength, required, allowedValues, notes)` — schema:14013-14026. Explicitly distinct from `Marketplace.schemaMapping` (the rules) — schema:1704-1707.
- Fillers (3): `api/services/pim/schema-sync-bridge.ts:120` (SP-API Product-Type-Definition → rows; header `:1-10`), `api/services/pim/ebay-schema-sync.service.ts:78` (eBay Taxonomy aspects), `api/services/feed/channel-schema.service.ts:174` (CE.1 seed via `POST /api/feed-transform/seed-schemas`, header `:7-8`).
- Readers (9 sites): `api/routes/pim-mapping.routes.ts:77,139,254`, `api/services/pim/mapping-suggest.service.ts:100`, `mapping-suggest-ai.service.ts:86`, `schema-mapping.service.ts:510`, `mapping-coverage.service.ts:47`, `feed/channel-schema.service.ts:32,88`.
- Live: yes — the web `/settings/mappings` page (`web/app/settings/mappings/MappingsClient.tsx:1-14`) calls `/api/pim/mappings/*` (10 refs), whose routes read ChannelSchema.

### 2.5 `sync-mapping-merge.ts` — what and which precedence

- Merges the PIM mapping's resolved values (`previewPayload(...)`, `:90-95`) **over** the legacy payload: "mapping wins where a catalog rule exists; legacy fills the rest" (`:9-12`, implementation `:50-70`).
- Mode per channel from env `FM_SYNC_<CHANNEL>` ∈ `off|shadow|merge`, default `off` (`:24-27`); `shadow` logs a diff and serves legacy (`:108-117`).
- Consumers: `api/services/marketplaces/amazon-sync.service.ts:160`, `ebay-sync.service.ts:159`, `shopify-sync.service.ts:198` — all three are the E16 build-only lane. No consumer in `outbound-sync.service.ts`, the flat-file services, `listing-content-write.service.ts`, or the cockpit publish routes (grep `resolveChannelField|previewPayload|schemaMapping|applyMappingToSyncPayload` across those → 0). Net: **operator field mappings never reach a real push today.**

---

## 3. Source-of-truth rules and where they are bypassed

### 3.1 Where the rules live

- **Quantity** — one pure resolver `resolveIntendedQuantity` (`api/services/sync-control-core.ts:146-180`). Precedence documented `:10-23`: FBA_EXCLUDED > CLOSED (offer close) > PAUSED via policy > PAUSED via listing > PINNED (`followMasterQuantity=false`) > FOLLOW (routed ledger − buffer; zero routed rows → UNCOUNTED, never a manufactured zero). Channel/market policy comes from `SyncChannelPolicy` (schema:15572-15592) through `loadChannelPolicies`/`policyFor` (`api/services/sync-control-policy.service.ts:10-43`, exact row beats `*` `:42`). Mutations audited in `SyncControlAudit` (schema:15596-15610; writers `sync-control-policy.service.ts:124`, `stock-import.service.ts`, `sync-control.routes.ts`).
- **Title / description / price / images / bullets** — per-field booleans on `ChannelListing.followMaster*` (schema:1550-1553,1563-1564) with `*Override` columns (schema:1576-1580). Not centralised: `followMasterPrice` is consulted in 28 files (census list in evidence, e.g. `api/services/master-price.service.ts`, `pim/attribute-resolver.ts`, `product-read-cache.service.ts`, `amazon/flat-file.service.ts`, `pricing-engine.service.ts`, `repricing-engine.service.ts`, `sync-status.service.ts:19-39`, `marketplaces/*-sync.service.ts`). The PIM resolver `attribute-resolver.ts` and `pim/reconcile-divergence.service.ts` are the closest thing to a single rule; the flat-file registry (`flat-file/registry/channel-fields.ts`) has its own copy.
- Master snapshots for cascade (`masterTitle`, `masterPrice`, …, schema:1568-1572) and the drift detector (`sync-drift-detection.job.ts:1-20`) exist because writes bypassed the cascade historically (header `:9-12`).
- "Channel is master" cases: FBA quantity (Amazon-managed, rule 1 above; `amazon-inventory-sync.job.ts` header `:14-16`); channel-side stock corrections flow in through `ChannelStockEvent` (`channel-stock-event.service.ts:1-38`, auto-apply ≤ 1 unit `:45-54`); Amazon suppression/issues mirrored into `AmazonSuppression`/`ListingIssue` (schema:1620-1630). There is **no per-field policy table** saying "channel wins for X".

### 3.2 Engines that bypass the quantity resolver

`QUANTITY_UPDATE` producers (files that write `syncType: 'QUANTITY_UPDATE'`) vs. files importing `resolveIntendedQuantity`/`resolveMembershipIntended` (comm on the two lists):

- **Call the resolver (5):** `routes/sync-control.routes.ts`, `services/ebay-shared-fanout.service.ts`, `services/listing-activation-sync.service.ts`, `services/stock-import.service.ts`, `services/stock-movement.service.ts`.
- **Do not (11):** `jobs/amazon-qty-readback.job.ts`, `routes/amazon-flat-file.routes.ts`, `routes/dashboard.routes.ts`, `routes/ebay-flat-file.routes.ts`, `routes/listings-syndication.routes.ts`, `routes/stock.routes.ts`, `services/amazon-market-offer.service.ts`, `services/bulk-action-template-seeds.ts`, `services/follow-master.service.ts` (writes `quantity` directly, `:17-18`), `services/listing-automation/action-handlers.ts`, `services/sync-coalesce.ts` (cancel-only, benign).

Mitigation that exists: `outbound-sync.service.ts` imports `sync-control-core` and `sync-control-policy.service` (importer lists) so dispatch re-derives ("dispatch re-reads" per `sync-control-core.ts:4-8`) — so a bypassing producer is mostly a *latency/noise* problem, not a wrong-number problem, **for rows that go through E12**. Paths that push quantity without E12 at all: `api/routes/marketplaces.ts:144-145` → `marketplace.service.ts:241` (raw number), `unified-sync-orchestrator.ts:366-438` (dead), `variation-sync-processor.service.ts:117-118` (`quantity: item.quantity` straight to SP-API), and the eBay flat-file/variation push (`ebay-variation-push.service.ts`) — unverified whether the latter derives quantity through the resolver.

Price: `pricing-outbound.service.ts` and `repricing-engine.service.ts` reference `followMasterPrice` (census), so they at least read the flag; `marketplaces.routes.ts` publish (`:959-1102`) builds its own payload — unverified whether it honours `followMasterTitle/Description`.

---

## 4. External-id ↔ internal-id mapping

| Entity | Where the channel id lives | Pattern |
|---|---|---|
| Product (parent-level) | `Product.amazonAsin`, `ebayItemId`, `shopifyProductId`, `woocommerceProductId Int?`, `parentAsin` — schema:92-96,254 | per-channel ad-hoc columns (Woo is `Int`, others `String`) |
| Variant | `ProductVariation.amazonAsin`, `ebayVariationId`, `shopifyVariantId` — schema:1287-1289 | per-channel ad-hoc columns |
| Listing (product × channel × marketplace) | `ChannelListing.externalListingId`, `externalParentId`, `platformProductId` — schema:1457-1464 | generic, but three overlapping id columns with channel-dependent meaning (comment `:1454-1456,1461-1463`) |
| Listing (variant × channel × marketplace) | `VariantChannelListing.channelSku`, `channelProductId`, `externalListingId`, `externalSku`, legacy `channelId → Channel` — schema:1369-1388 | generic-ish, four id columns; legacy FK to an almost-empty `Channel` table (schema:2318-2328) |
| eBay shared variant | `SharedListingMembership.itemId + sku` — schema:15533-15534 | eBay-specific table |
| Order | `Order.channelOrderId` + `channel` (`@@unique([channel, channelOrderId])`) — schema:4887,4980 | consistent |
| Webhook / stock observation | `WebhookEvent.externalId` (unique with channel) schema:4617,4633; `ChannelStockEvent.channelEventId` schema:4728,4765 | consistent |
| Publish/feed receipts | `ChannelPublishAttempt.submissionId` (12252), `AmazonFlatFileFeedJob.feedId` (7780), `EbayPushJob.taskId` (7814), `ChannelImagePublishJob.vendorEntityId` (7870), `ChannelLiveImage.externalSku/asin/slot` (4691-4695) | per-artefact |
| Account | `ChannelConnection.externalAccountId` (6040); legacy `ebay*` columns 6011-6018 | dual-written legacy |

Verdict: **no single pattern**. Product-level ids are per-channel columns; listing-level ids exist in three parallel tables (`ChannelListing`, `VariantChannelListing`, `SharedListingMembership`) with different key vocabularies; order and webhook ids are consistent.

---

## 5. Webhook infrastructure

### 5.1 `WebhookEvent` (schema:4613-4637)

- Columns: `channel`, `eventType`, `externalId` (comment "for idempotency"), `payload Json`, `signature?`, `isProcessed`, `processedAt`, `error`, `providerTimestamp` (RT.3 latency). Unique `[channel, externalId]` (`:4633`). **No** retry count, attempt/next-retry, or dead-letter columns.
- Writers:
  - Shared helper `WebhookProcessor.markWebhookProcessed` (`api/utils/webhook.ts:211` upsert; `isWebhookProcessed :173`) — used by `routes/shopify-webhooks.ts`, `woocommerce-webhooks.ts`, `etsy-webhooks.ts` (importers list).
  - `woocommerce-webhooks.ts` and `etsy-webhooks.ts` ALSO write `webhookEvent.create/update` directly six times each (`woocommerce-webhooks.ts:325-670`, `etsy-webhooks.ts:346-606`) — two idempotency implementations in the same handlers (Etsy's direct path uses `findFirst`, `:332`, not the unique key).
  - Amazon: `api/jobs/amazon-sqs-poll.job.ts:68` upsert keyed on SQS `messageId`, `update: {}` (never overwrite), then status updates `:113-494`.
  - eBay: `api/routes/ebay-notification.routes.ts:386` upsert keyed on `notificationId`, **fallback `${topic}:${ebayOrderId}:${Date.now()}`** (`:379`) which defeats idempotency when eBay omits the id.
  - Replay/admin: `api/routes/sync-logs.routes.ts:1036-1109`.
- Readers: `sync-logs.routes.ts:950-1140` (hub list/detail/replay), `push-latency.routes.ts:91,100`, `push-health.routes.ts:94-105`, `marketplaces.routes.ts:76` (sidebar error count), `connections.routes.ts:182`, `orders.routes.ts:64`, `inbox.routes.ts:101,214`.
- Processing status: `isProcessed` + `error` only. Retry/dead-letter: none at the table level; Amazon has a real SQS DLQ monitored by `api/jobs/dlq-monitor.job.ts:1-27` (`*/5 * * * *` `:119`, `AMAZON_SQS_DLQ_URL`). Replay: `POST /api/sync-logs/webhooks/:id/replay` (`sync-logs.routes.ts:1009-1021`) re-dispatches via `dispatchShopifyWebhook/dispatchWooWebhook/dispatchEtsyWebhook` (`:41-43`), re-runs Amazon `ORDER_CHANGE` for a 5-min window (`:1031`) and eBay order sync (`:1051`).

### 5.2 Ingress — one per channel, not one

| Channel | Ingress | Registered | Verification |
|---|---|---|---|
| Shopify | `POST /webhooks/shopify/{products/update,products/delete,inventory/update,orders/create,orders/update,fulfillments/create,refunds/create,refunds/create-test}` — `api/routes/shopify-webhooks.ts:926-1402` | `api/index.ts` (no prefix, registration block line 17) | `x-shopify-hmac-sha256` (`:928`) |
| WooCommerce | 6 routes `/webhooks/woocommerce/*` — `woocommerce-webhooks.ts:288-628` | no prefix | unverified (helper in `utils/webhook.ts`) |
| Etsy | 6 routes `/webhooks/etsy/*` — `etsy-webhooks.ts:318-581` | no prefix | unverified |
| eBay | `GET/POST /api/webhooks/ebay-notification` (challenge `:326-341`, receive `:345`) | `/api` prefix (`index.ts:776`) | challenge hash `:335-338`; POST signature unverified |
| Amazon | no HTTP ingress; SQS poll `amazon-sqs-poll.job.ts` every minute (`:535`, gate `NEXUS_ENABLE_AMAZON_SQS_POLL`); subscription mgmt `api/routes/amazon-notifications.routes.ts:178,231` | `/api` (`index.ts:775`) | n/a |
| Generic inbound | `api/routes/webhooks.routes.ts`: `POST /api/webhooks/order-created` (`:59`, full path) and `POST /webhooks/stock-adjustment` (`:137`, **no `/api`**) — mixed prefixes in one file; `GET /webhooks/recent-adjustments` removed (`:17,225`) but still called by `web/components/dashboard/RealTimeStockMonitor.tsx` (0 importers → unmounted) | no prefix (`index.ts` line 38 of block) | unverified |
| Others | `sendcloud-webhooks.routes.ts`, `cloudinary-webhook.routes.ts` | | |

### 5.3 Outbound (operator) webhooks

- `settings-webhooks.routes.ts` = operator subscription CRUD on `NotificationWebhook` (schema:4206-4230): `GET/POST /api/settings/webhooks`, `PATCH/DELETE …/:id`, `POST …/:id/test` (`:68-310`). Web page `web/app/settings/webhooks/WebhooksClient.tsx` (6 refs) — live.
- `webhook-dispatch.service.ts` = the OUTBOUND dispatcher `emitWebhookEvent` (`:66`): HMAC-SHA256 (`:37-39`), 8 s timeout (`:42`), auto-pause after 10 consecutive failures (`:41,164-172`), fire-and-forget (`:21-24`). **Only caller:** `api/services/monitoring/alert.service.ts:187` bridging five alert types (NEW_ORDER, LOW_STOCK, RETURN_REQUEST, SYNC_FAILURE, AI_COMPLETE per comment `:181-183`). No sync/listing/stock event is emitted from any sync engine.
- `notifications.routes.ts` = in-app `Notification` list / mark-read / delete (`:27-77`); unrelated to webhooks.

---

## 6. Job queue

- Backing: BullMQ + ioredis (`api/lib/queue.ts:33-34`); queues `outbound-sync`, `channel-sync`, `read-cache`, `search-index`, `bulk-job`, `ads-sync` (`:126-188`). Redis target resolution bug-fix history `:46-57`.
- Default job options: `attempts:3`, exponential backoff 2000 ms, keep completed 1 h / failed 24 h (`:110-118`). Priorities: `outboundEnqueuePriority` returns `1` for order-driven reasons only (`api/services/sync-priority.ts:9-13`), consumed by `stock-movement.service.ts`.
- Gating: workers start only when `ENABLE_QUEUE_WORKERS=1` and Redis is configured (`api/index.ts:417-427`); the DB-polling 60-s autopilot always runs (`index.ts:412-415`, `sync.worker.ts:60`) and skips rows owned by a live BullMQ job (`sync.worker.ts:24-45`). Producers use `addJobSafely` — 2.5 s timeout + 30 s circuit, and skip entirely when workers are off (`queue.ts:217-290`); every enqueue is backed by a PENDING DB row (`:211-214`). Instant-lane helper: `api/services/outbound-enqueue.ts:1-21,42,78` (11 importers).
- Concurrency: outbound worker `concurrency: 5` **global, not per channel** (`bullmq-sync.worker.ts:33-36`); channel-sync `3` (`channel-sync.worker.ts:28-31`). Per-channel throttling is inside the adapters (eBay revise counter `outbound-sync.service.ts:61`, circuit/rate-limit codes `:123-183`, publish-audit chain `channel-publish-audit.service.ts:1-13`).
- Backoff on 429/5xx: `computeFailureDisposition` (`outbound-sync.service.ts:123-183`) — circuit-open / rate-limited / debounced → deferral with jitter; auth-class → 15-min deferral (`:100-112`); non-retryable → terminal; else ladder `RETRY_BACKOFF_MS` up to `maxRetries` (default 3, schema:6098). eBay: 400/404/409/422 terminal and do not trip the circuit, everything else transient + trips (`:468-509`). Worker fallback `2^attempt × 5 s` (`bullmq-sync.worker.ts:377`).
- Dead-letter: `OutboundSyncQueue.isDead/diedAt` (schema:6118-6119) set on terminal outcomes (`bullmq-sync.worker.ts:381-407`, event `SYNC_DEAD`); janitor sweeps orphaned IN_PROGRESS / stale PENDING / un-dead-lettered FAILED every 15 min (`api/jobs/outbound-queue-janitor.job.ts:1-22,124`); Dead Letters tab in the web hub (`web/app/sync-logs/outbound-queue/OutboundQueueClient.tsx` → `/api/outbound-queue/*`). `dlq-monitor.job.ts` is the **Amazon SQS** DLQ, not BullMQ.
- Queue vs inline: queue-based = E12 (all QUANTITY/PRICE/CONTENT/DELIST pushes), E16 (channel-sync), E14 (inside the outbound worker). Inline in the HTTP request = `marketplaces.routes.ts` publish (`:1046`), Amazon flat-file submit (`amazon-flat-file.routes.ts:669-689`), eBay flat-file push, `marketplaces.ts` price/inventory routes, `sync.routes.ts` catalog import (`:113`), `inbound.routes.ts:22`, `ebay.routes.ts:62`, E5 routes; `pricing-outbound.service` — unverified whether cron or request.

---

## 7. Conflict resolution, dry-run, progress

- Dry-run / gated modes on the real push: `NEXUS_ENABLE_<CH>_PUBLISH` + `<CH>_PUBLISH_MODE` ∈ gated/dry-run/sandbox/live (`outbound-sync.service.ts:852,1091,1181,1215,1258-1277,1832-1837`); a non-live "success" is recorded as `SKIPPED`, not `SUCCESS` (`:729-730,808-809`). Every attempt is audited in `ChannelPublishAttempt` with mode/outcome/payload digest (schema:12233-12258; writer `channel-publish-audit.service.ts:84`).
- Preview endpoints: PIM payload preview/validate `GET /api/pim/mappings/:channel/:code/preview/:productId`, `…/validate/:productId` (`pim-mapping.routes.ts:354,380`); flat-file pull preview start/apply (`amazon-flat-file.routes.ts:1733,1773`; `ebay-flat-file.routes.ts:3766,3846`); sync-control import preview/apply (`sync-control.routes.ts:1344,1357`); control-tower delta preview (web `DeltaPreviewModal.tsx` → `/api/inventory-sync/control-tower/:sku/delta`, documented `docs/INVENTORY-SYNC.md:90`); `marketplaces.ts` accepts a `dryRun` body flag (`:21,31`) — unverified whether honoured.
- Conflict resolution: inbound drift triage `ChannelStockEvent` (AUTO_APPLIED ≤ threshold 1, REVIEW_NEEDED, apply/ignore — `channel-stock-event.service.ts:10-38,92,253`); `SyncHealthLog.conflictType/resolutionStatus` (schema:2491-2494) with `resolveConflict` (`sync-health.service.ts:272`); optimistic CAS on `ChannelListing.version` (`channel-listing-cas.ts:44-66`, used by cockpit + flat-file writers); Amazon EU shared-quantity guard (documented `docs/SYNC-CONTROL.md:79-98`, kill-switch `NEXUS_EU_SHARED_QTY_GUARD`); coalescing of superseded PENDING quantity rows (`sync-coalesce.ts:20-34`).
- Progress / SSE: `api/lib/sse.ts` only builds CORS-safe event-stream headers (`:9-29`). Live tail of API calls: `GET /api/sync-logs/events` (`sync-logs.routes.ts:764`) fed by the in-process bus `sync-logs-events.service.ts:38-53` (single-process by design `:8-10`). SSE is also used by `listings-syndication.routes.ts`, `dashboard.routes.ts`, `bulk-operations.routes.ts` (file list). There is no per-push progress stream for a single `OutboundSyncQueue` row — the UI polls `/api/outbound/queue/*` and `/api/outbound-queue/*` (web refs).

---

## 8. Sync health / monitoring

- `SyncHealthLog` (schema:2469-2511): written by `sync-health.service.ts` (`logError :104`, `logConflict :145`, `logDuplicateVariation :188`) whose callers are `jobs/amazon-qty-readback.job.ts`, `jobs/sync-drift-detection.job.ts`, `jobs/latency-watchdog.job.ts`, `services/outbound-sync.service.ts` (importer list); plus a direct write in `amazon-qty-readback.job.ts`. Read by `routes/health.ts` (`GET /health` `:17`), `routes/pricing.routes.ts`, `routes/sync-control.routes.ts`, `jobs/reconcile-cron.job.ts`, `jobs/sync-drift-detection.job.ts`, `jobs/latency-watchdog.job.ts` and the service's own scoring (`calculateChannelHealthScore :313`, `getAllChannelHealthScores :423`). Real (fed by live loops).
- `sync-monitoring.service.ts`: alerts and configs are **in-memory** (`private alerts: Map`, `alertConfigs` `:45-46`) — reset on every deploy; `getAggregatedMetrics :158`, `getSyncHealthStatus :540`; email via `sendEmail` import `:2`. Sole consumer `api/routes/monitoring.routes.ts` (`/api/monitoring/health,/metrics,/alerts,/alert-configs,/test-alert` `:9-252`), registered without prefix (`index.ts:619`). Web: `web/components/monitoring/SyncHealthDashboard.tsx` and `JobMonitor.tsx` call these but have **0 importers** → not rendered anywhere. Stale/dead surface.
- `SyncLog` (schema:4807-4831): written only by the three manual-trigger E5 jobs; read by `dashboard.routes.ts:1587,2965-3044` (`GET /dashboard/health`) and the broken E7 `getSyncStatus` (§1). Effectively empty on prod (unverified count).
- `SyncError` (schema:4835-4853): written by `api/utils/error-handler.ts:363-407`; read only by `dashboard.routes.ts:1582,2993,3032`.
- What operators actually see: the `/sync-logs` hub (45 web refs → `sync-logs.routes.ts`: API calls, alerts, cron registry/trigger, webhooks, listing-health, in-flight), `/fulfillment/stock/sync-control` (→ `/api/stock/sync-control/*`), Control Tower (`/api/inventory-sync/control-tower`), push health (`/api/admin/push-health`, 5 web refs), and diagnostics (`GET /api/admin/inventory-sync/diagnostics` → `summarizeDiagnostics` `sync-metrics.ts:151-196`; 3 web refs). `/api/admin/outbound-latency` and `/api/admin/reconciliation/*` have 0 web refs.

---

## 9. Dead / duplicated — see the table at the end.

## 10. Where the operator can see/override field mappings today

- Page: `/settings/mappings` (`web/app/settings/mappings/MappingsClient.tsx:1-14`): marketplace picker + per-field rule rows; saves `PUT /api/pim/mappings/:channel/:code/:fieldKey`, deletes `DELETE …` (comment `:8-9`); web refs: `/api/pim/mappings/` ×10, `/api/pim/value-maps` ×3, `/api/pim/size-scales` ×2.
- API: `api/routes/pim-mapping.routes.ts` — `/pim/mappings/marketplaces` (`:61`), `/pim/mappings/:channel/:code` (`:116`), `…/:fieldKey` (`:184,436`), `…/preview/:productId` (`:354`), `…/validate/:productId` (`:380`), `…/revisions` (`:460`), `…/rollback/:revisionId` (`:472`), `/pim/mappings/coverage` (`:584`); `api/routes/mapping-propagation.routes.ts` `/products/:id/mapping/{divergence,matrix}` (`:105,126`).
- Model: rules in `Marketplace.schemaMapping Json` (schema:1704-1710; service `pim/schema-mapping.service.ts:1-16`), field catalogue in `ChannelSchema` (§2.4), value maps / size scales as separate PIM tables.
- Is it channel field mapping? **Yes** — PIM attribute → channel field key with transforms (`schema-mapping.service.ts:20-26`). **But** the only outbound consumer is FM.7 `applyMappingToSyncPayload` inside the E16 build-only lane, default `off` (`sync-mapping-merge.ts:24-27`); the flat-file, cockpit publish and `OutboundSyncService` paths never consult it (§2.5 grep). So the mapping editor is a preview tool, not a control of what ships.

---

## Cron jobs that touch channels (cadence · gate)

Manual-trigger registry: `api/jobs/cron-registry.ts:136-364` (every name is triggerable via `POST /api/sync-logs/cron/<jobName>/trigger`, `sync-logs.routes.ts:505`). Scheduled ticks found by `cron.schedule` string per job file:

| job | cadence | gate | touches |
|---|---|---|---|
| autopilot drain `workers/sync.worker.ts:60` | `* * * * *` | always (`index.ts:415`) | all channels via E12 |
| `amazon-sqs-poll.job.ts:535` | `* * * * *` | `NEXUS_ENABLE_AMAZON_SQS_POLL` | Amazon notifications → WebhookEvent/orders/stock |
| `amazon-flat-file-feed-poll.job.ts:56` | `*/2` | — | AmazonFlatFileFeedJob |
| `ebay-orders-sync.job.ts:136` | `*/5` | — | eBay orders |
| `dlq-monitor.job.ts:119` | `*/5` | `AMAZON_SQS_DLQ_URL` | Amazon SQS DLQ |
| `amazon-inventory-sync.job.ts:67` | `*/15` | `NEXUS_ENABLE_AMAZON_INVENTORY_CRON` | FBA stock |
| `amazon-orders-sync.job.ts:70` | `*/15` | — | Amazon orders |
| `fba-status-poll.job.ts:141`, `outbound-queue-janitor.job.ts:124`, `read-cache-reconcile.job.ts:29` | `*/15` | janitor default on; read-cache `NEXUS_ENABLE_READCACHE_RECONCILE` | |
| `ebay-readback.job.ts:30`, `sync-drift-detection.job.ts:390`, `ebay-token-refresh.job.ts:134` | `*/30` | readback `NEXUS_EBAY_READBACK≠0` | eBay qty read-back; master drift self-heal |
| `latency-watchdog.job.ts:293` | `30 * * * *` | `NEXUS_LATENCY_WATCHDOG≠0` | outbound latency + realtime-degraded |
| `ebay-status-reconcile.job.ts:278` | `0 2 * * *` | `NEXUS_ENABLE_EBAY_STATUS_RECONCILE_CRON` | |
| `ebay-item-status-reconcile.job.ts:119` | `30 2 * * *` | — | |
| `catalog-refresh.job.ts:185` | `0 3 * * *` | `NEXUS_ENABLE_CATALOG_SYNC_CRON` | Amazon catalog → Product |
| `reconcile-cron.job.ts:55` | `45 3 * * *` | `NEXUS_RECONCILE_CRON` (doc) | Amazon orders/inventory report |
| `schema-refresh.job.ts:101` | `0 4 * * *` | `NEXUS_ENABLE_SCHEMA_REFRESH_CRON` | Amazon PTD schemas |
| `amazon-qty-readback.job.ts:253` | `15 4 * * *` | `NEXUS_QTY_READBACK≠0` | Amazon FBM qty read-back + self-heal |
| `fba-drift-detector.job.ts:28` | `0 5 * * *` | `NEXUS_ENABLE_FBA_DRIFT_DETECTOR` | |
| `ebay-image-readback.job.ts:40` | `45 */6 * * *` | `NEXUS_ENABLE_EBAY_IMAGE_READBACK_CRON` | ChannelLiveImage |
| `shopify-sync`, `woocommerce-sync`, `etsy-sync` | **none** (no `cron.schedule` in the job files; not started from `index.ts`) | manual only via registry `:219-221` | E5 |
| `image-publish-reconcile`, `ebay-feed-poll`, `scheduled-wizard-publish` | schedule string not found by the regex (unverified) | wizard: `NEXUS_ENABLE_SCHEDULED_WIZARD_PUBLISH` | |

---

## Models — what / who writes / who reads (counts are non-test Prisma call sites)

| Model (schema line) | Stores | Writers | Readers |
|---|---|---|---|
| `ChannelSchema` (14013) | per-field channel metadata | 3 (`pim/schema-sync-bridge.ts:120`, `pim/ebay-schema-sync.service.ts:78`, `feed/channel-schema.service.ts:174`) | 9 (§2.4) — live |
| `ChannelListing` (1423) | product × channel × marketplace listing, follow flags, overrides, raw bags | 40 files (§1.2) | pervasive |
| `ChannelListingOverride` (1721) | per-field override audit | 2 (`pricing-outbound.service.ts`, `pricing.routes.ts`) | **0** — write-only |
| `ChannelListingImage` (2098) | master/listing images with `platformMetadata` | 2 (`catalog.routes.ts`) | 0 direct `findMany` (may be loaded via relation `include` — unverified) |
| `ChannelPublishAttempt` (12220) | gated/dry-run/sandbox/live attempt audit with payload digest | 1 (`channel-publish-audit.service.ts:84`) | 3 |
| `ChannelStockEvent` (4719) | channel-reported qty vs local, drift, triage status, rawPayload | 4 (`channel-stock-event.service.ts`) | 5 |
| `WebhookEvent` (4613) | inbound event receipt, idempotency, processed flag | §5.1 | §5.1 |
| `SyncAttempt` (1889) | per-listing manual/cron/bulk/webhook resync timeline | 4 (`listings-syndication.routes.ts:3102` …) | 1 |
| `SyncLog` (4807) | per-product sync run summary | 18 — only `jobs/{shopify,woocommerce,etsy}-sync.job.ts` (6 each) | 5 (`dashboard.routes.ts` ×4, `amazon-sync.service.ts:355`) |
| `SyncError` (4835) | classified sync error with retry fields | 3 (`utils/error-handler.ts:363-407`) | 3 (`dashboard.routes.ts`) |
| `SyncHealthLog` (2469) | error/conflict/duplicate log with resolution | 6 (`sync-health.service.ts` ×5, `amazon-qty-readback.job.ts`) | 21 (§8) |
| `SyncChannelPolicy` (15572) | channel/market push kill-switch + new-listing default | 2 (`sync-control.routes.ts`) | 6 |
| `SyncControlAudit` (15596) | before/after audit of sync controls | 3 (`sync-control-policy.service.ts:124`, `stock-import.service.ts`, `sync-control.routes.ts`) | 4 |
| `MarketplaceSync` (2305) | product × channel last-sync status | **0 creators** — only `deleteMany` (`products.routes.ts:2434`, `products-catalog.routes.ts:2065`, `purge-soft-deleted-products.job.ts:117`) | 2 (`unified-sync-orchestrator.ts:456` dead) — **dead table** |
| `Marketplace` (1670) | channel × country catalogue + `schemaMapping` | 10 (mostly `pim/schema-mapping.service.ts`, `amazon-participations.service.ts`, seed `marketplaces.routes.ts:109`) | 50 |
| `Channel` (2318) | legacy channel row (credentials column dropped `:2322-2324`) | 4 (`sync/woocommerce-sync.service.ts:586`, `sync/etsy-sync.service.ts:482`, `woocommerce-webhooks.ts`, `etsy-webhooks.ts`) | 6 — legacy |
| `Listing` (relation of Channel) | legacy | 6 (`etsy-sync.service.ts` ×2, `data-validation.service.ts`, delete sites) | 3 (`data-validation.service.ts` ×2, `etsy-sync.service.ts`) — legacy |
| `EbayPushJob` (7811) | eBay api/feed push receipt with per-SKU results | 6 (`ebay-flat-file.routes.ts` ×5, `ebay-feed-poll.job.ts`) | 3 |
| `AmazonFlatFileFeedJob` (7778) | SP-API feed receipt + parsed report | 2 (`amazon-flat-file-feed.service.ts`, `amazon-flat-file.routes.ts`) | 4 |
| `ChannelImagePublishJob` (7852) | eBay/Shopify image publish receipt | 14 (image publish services) | 2 |
| `SyncLogErrorGroup` (10494) | fingerprinted error groups for the hub | 1 (`sync-logs.routes.ts`) | 3 |
| `VariantChannelListing` (1365) | variant × channel listing | 18 (`marketplaces.ts` ×3, `sync/shopify-sync.service.ts` ×2, `ebay-sync.service.ts` ×2, `inventory.ts` ×2, dead orchestrator, batch-repair …) | 8 (`ebay.routes.ts` ×2, `sales-report-ingest`, `ebay-orders`, `connection-resolver`, `etsy-webhooks`, `accounts.routes`) |
| `NotificationWebhook` (4206) | operator outbound subscription | 5 (`settings-webhooks.routes.ts` ×4, `webhook-dispatch.service.ts:165`) | 7 |
| `ChannelLiveImage` (4675) | read-back of live channel images | 7 | 6 |

---

## Docs vs code drift

| Doc | Matches code? | Discrepancy (one example each) |
|---|---|---|
| `docs/PHASE27-SSOT-SYNC-ENGINE.md` | **No** | Claims the channel-sync worker "orchestrates the sync process" and updates status on success (`:38-64,251-270`); code builds a payload and never sends (`api/services/marketplaces/amazon-sync.service.ts:137-165`), and the worker's own Phase-0.3 comment says the real push is elsewhere (`channel-sync.worker.ts:196-207`) — while still writing `IN_SYNC` (`:209-216`). |
| `docs/INVENTORY-SYNC.md` | **Mostly yes** (2026-07 RT program) | Names `inventory-reconcile` daily 03:45 (`:54`) — code job is `reconcile-cron.job.ts:55`; states FBA "15-min poll" (`:9`) which matches `amazon-inventory-sync.job.ts:67`. Claims every push writes a `SyncHealthLog` record "(with latency, success/fail, clamping)" (`:11`) — the outbound service imports sync-health but per-push logging is unverified. |
| `docs/SYNC-CONTROL.md` | **Yes** | Precedence ladder (`:6-13`) equals `sync-control-core.ts:10-23`; API surface `GET/POST /api/stock/sync-control/*` (`:62`) equals `sync-control.routes.ts:259-1357`. |
| `docs/WEBHOOK-DOCUMENTATION.md` | **No** | Documents endpoints `/webhooks/shopify/products`, `/webhooks/woocommerce/products`, `/webhooks/etsy/listings` with Express-style handlers (`:67,99,131,324-793`); code paths are `/webhooks/shopify/products/update` etc. (`shopify-webhooks.ts:926-1402`) on Fastify, and there is no mention of the eBay challenge endpoint or the Amazon SQS path. |
| `docs/DATA-MAPPING-REFERENCE.md` | **Partially** | Describes mapping Shopify/Woo/Etsy products into a generic shape with `channelProductId` (`:53-79`); code writes `Product.shopifyProductId` and `VariantChannelListing.channelProductId` but the described `shortDescription`, `vendor`, `productType` fields are not persisted by `shopify-sync.service.ts:142-185` (no such columns written). |
| `docs/MARKETPLACE-API-DOCUMENTATION.md` | **Stale** | Documents `POST /marketplaces/inventory/update` as "Update Inventory Across Channels" (`:719`); code returns "Inventory update not yet implemented for Amazon" (`marketplace.service.ts:250-259`) and the route set (`marketplaces.ts:43-509`) has no web caller and is superseded by `marketplaces.routes.ts`. |

---

## Dead / duplicated code

| Item | Evidence | Recommendation |
|---|---|---|
| `api/services/sync/unified-sync-orchestrator.ts` | 0 `src` importers; only `apps/api/dist/jobs/sync.job.js:7` (stale build; `src/jobs/sync.job.ts` absent); `listings.ts:148-160` marks it retired | Delete; also purge `apps/api/dist` from the tree if committed (unverified) |
| `api/services/sync/product-sync.service.ts` | only importer is the dead orchestrator (`unified-sync-orchestrator.ts:11`) | Delete |
| `api/services/sync/index.ts` | 0 importers | Delete |
| `api/services/marketplaces/marketplace.service.ts` + `api/routes/marketplaces.ts` | importers: dead orchestrator + `routes/marketplaces.ts`; routes registered without `/api` (`index.ts:617`), 0 web callers; Amazon inventory "Not implemented" (`:250-259`); stubbed `syncProductsAcrossChannels` (`:549-587`) | Delete both; keep `marketplaces.routes.ts` |
| `api/services/inbound-sync.service.ts` + `POST /api/inbound/sync-catalog` | invalid unique key `productId_channel_region` (`:59`; schema has 1653-1654 only); hard-coded `AMAZON_EU`; own PrismaClient; caller button `ImportCatalogButton.tsx` unmounted (0 importers) | Delete service, route (`inbound.routes.ts`), Next proxy `web/app/api/inbound/sync-catalog/route.ts`, and the button |
| `api/services/outbound-sync-phase9.service.ts` | `handleChildVariationChange`/`buildAndLogVariationPayload` have 0 callers; only `markSync*` used by E14 | Fold `markSync*` into the worker; delete the rest |
| `api/services/variation-sync-processor.service.ts` | no producer of `CHILD_VARIATION_CHANGE`/`VARIATION_THEME_UPDATE` rows (grep → 0); hard-coded `USD` (`:117`); direct SP-API bypassing gates/audit (`:99`); invalid Prisma filter (`:211-213`); own PrismaClient (`:15`) | Remove from `bullmq-sync.worker.ts:15` and delete; if variation parent sync is needed, route it through `syncToAmazon` |
| Phase-27 lane: `api/workers/channel-sync.worker.ts`, `api/services/marketplaces/{amazon,ebay,shopify}-sync.service.ts`, `sync-mapping-merge.ts`, `channelSyncQueue` (`queue.ts:131`), `POST /api/catalog/sync/bulk` (`catalog.routes.ts:1973`) | builds payload, never sends; writes false `IN_SYNC`/`SUCCESS` (`channel-sync.worker.ts:209-216`) because the `'noop'` guard (`:202`) can never match; creates bogus `_US` listings (`:124-142`); UI-reachable from `ManageInventoryClient.tsx:196` and `MarketplaceActionsDropdown.tsx` | Either delete the lane and repoint "Sync All to X" at `OutboundSyncQueue` (`FULL_SYNC` rows), or fix: return `{status:'noop'}` and stop touching `syncStatus`. Move `applyMappingToSyncPayload` into `syncToAmazon/Ebay/Shopify` if FM.7 is meant to ship. |
| Root `api/services/amazon-sync.service.ts` `getSyncStatus` (`:353-366`) + `GET/POST /api/sync/amazon/catalog/:syncId[/retry]` (`sync.routes.ts:149-194`) | looks up `SyncLog` by a generated non-DB id (`:43`); no writer of SyncLog for Amazon → always 404/500; `SyncStatusModal.tsx` (mounted) polls it | Persist a `SyncLog` row in `syncAmazonCatalog` or drop the status/retry endpoints and the modal |
| `MarketplaceSync` model (schema:2305) | 0 creators; only `deleteMany` | Drop table (additive-safe: add a migration after removing the three delete sites) |
| `Channel` + `Listing` models (schema:2318) and `VariantChannelListing.channelId` | legacy; created only by E5 Woo/Etsy paths; `Channel.credentials` already dropped `:2322-2324` | Migrate E5 to `ChannelConnection`; drop `Channel`/`Listing` |
| `ChannelListingOverride` | 2 writers, 0 readers | Either surface in the listing drawer's Sync tab or stop writing |
| `SyncLog` / `SyncError` | written only by manual-trigger E5 jobs / `error-handler.ts`; read only by `/dashboard/health` | Retire in favour of `OutboundApiCallLog` + `SyncHealthLog`; or wire E7/E12 to write them |
| `api/services/sync-monitoring.service.ts` + `api/routes/monitoring.routes.ts` + `web/components/monitoring/{SyncHealthDashboard,JobMonitor}.tsx` | in-memory alerts (`:45-46`); web components have 0 importers | Delete the components; delete or persist the service |
| `web/components/dashboard/RealTimeStockMonitor.tsx` | 0 importers; calls removed `/api/webhooks/recent-adjustments` (`webhooks.routes.ts:17,225`) | Delete |
| `api/routes/webhooks.routes.ts` mixed prefixes | `/api/webhooks/order-created` (`:59`) vs `/webhooks/stock-adjustment` (`:137`) in one un-prefixed plugin | Normalise to one prefix |
| Duplicate idempotency code in `woocommerce-webhooks.ts:311-670` and `etsy-webhooks.ts:332-606` | direct `webhookEvent.findFirst/create/update` next to the shared `WebhookProcessor` helper (`utils/webhook.ts:173,211`); Etsy path uses `findFirst` not the unique key | Use the helper only |
| eBay notification fallback id `${topic}:${orderId}:${Date.now()}` (`ebay-notification.routes.ts:379`) | non-idempotent when `notificationId` is absent | Drop `Date.now()`; key on `(topic, orderId, publishDate)` |
| `api/routes/admin.ts` `/admin/validation/*`, `/admin/repair/*` (`:214-401`) | 0 web callers | Keep as ops CLI or move to scripts |
| `api/routes/sync.routes.ts` `/sync/detect-drift[/status]` (`:42,58`) | 0 web callers (cron + registry cover it) | Fold into `/api/sync-logs/cron/sync-drift-detection/trigger` |
| `GET /api/admin/outbound-latency`, `/api/admin/reconciliation/*` | 0 web refs | Surface in the sync-logs hub or drop |
| Shopify/Woo/Etsy sync jobs (`api/jobs/*-sync.job.ts`) | no schedule, no starter in `index.ts`; only manual registry entries (`cron-registry.ts:219-221`) | Decide: schedule them (with gates) or delete E5 with the channels |
| `docs/PHASE27-SSOT-SYNC-ENGINE.md`, `docs/WEBHOOK-DOCUMENTATION.md`, `docs/MARKETPLACE-API-DOCUMENTATION.md` | describe retired/never-shipped surfaces (table above) | Rewrite or delete; keep `SYNC-CONTROL.md` and `INVENTORY-SYNC.md` as the runbooks |
