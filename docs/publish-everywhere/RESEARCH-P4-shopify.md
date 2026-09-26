# P4 Shopify — research (read-only, 2026-09-26)

No file edited, no Shopify call (no Shopify MCP tool), read-only SQL on `nexus_vtr_test` / `nexus_pe_test` (identical for Shopify).
Paths start at `apps/api/src/`. Labels: read / measured / inferred / docs.

## 0. Findings that change the plan

1. **The Owner's store uses separate colour products**: each colour is its own Shopify product with native size variants, tied by a
   `custom.variation_products` product-reference list. Owner confirmed 2026-09-09 (`docs/audits/2026-09-09-shopify-family-migration/README.md:3`;
   `shopify/content-import.service.ts:76`). One Nexus family = N Shopify products. Today's publisher builds ONE `productSet` product
   holding every axis → on a linked product it would restructure it.
2. **No tool links a Nexus product to an existing Shopify product.** The Owner cannot "link first" until one is built.
3. **One full-overwrite path is not guarded by the studio refusal**: `POST /products/:id/shopify-content/synchronize`
   (`routes/images/shopify-content.routes.ts:32`) → full `productSet`; the web offers "Existing linked Shopify product"
   (`apps/web/src/app/products/[id]/edit/_studio/images/shopify/ShopifyContentWorkspace.tsx:159`). Verified by the main session.
   **Safe today** only because the Shopify gate is off (gateway enforces it); must be fixed before the switch.

## 1. Today's publish path

- Review: Shopify branch refuses any excluded variant, then `previewContentSync(remote=true)` (`pim/studio-publication.service.ts:73-90`).
  Existing products refused at `:77-78`. Preview saves the content document locally (`:120-127`).
- Remote identity: `publish.productId`, else listing `externalListingId` (target `linked-product`), else `nexus.family_id` metafield
  (`shopify/content-sync.service.ts:45`; `content-publisher.ts:30-36`).
- Submit not sparse: `sparse = ['AMAZON','EBAY']` (`studio-publication.service.ts:205`); `synchronizeContent` journals each mutation.
- Sent in order (`content-publisher.ts:226-341`): definitions → `fileCreate`/`metaobjectUpsert`/`translationsRegister` →
  **`productSet(synchronous:true)` with the full variant list** → `inventorySetQuantities` → `productVariantDetachMedia` →
  `metafieldsSet`/`metafieldsDelete` → gallery job → linked-information writes → read-back.
- Option value order = first-seen = child-id order (`content-publisher.ts:221`; `content-workspace.service.ts:53`).

## 2. Linking

- Stored on `ChannelListing` (SHOPIFY, GLOBAL, connection, alias): `externalListingId` = product id; `platformAttributes` =
  `variantId`, `inventoryItemId`, `shopifyProductId`, `inventoryLocationId` (sheet reads: `shopify/channel-sheet-projection.ts:40-45`).
  Legacy `Product.shopifyProductId`: 0 of 343 set (measured).
- Exists: `linked-discovery` / `linked-products` (`importLinkedFamily :102`) import a colour-product family into
  `_nexusLinkedProducts.members` — but do NOT tie members to Nexus variants (no `externalListingId`/`variantId` set).
  Information-sheet sync already does sparse compare-and-set writes (`information-gateway.ts:123-155`; `linked-products.service.ts:220-235`).
  Queue writer finds a variant by exact SKU when ids are missing (`listing-write.service.ts:71-86`).
- Automation modes: PAUSED (default) / MONITOR / AUTOMATIC; AUTOMATIC writes metafields, ≤25 per 5-min tick, never removals
  (`linked-automation.service.ts:8-66`; `jobs/shopify-linked-automation.job.ts:17-32`).
- Local counts (measured): 1 connection; 2 SHOPIFY listings (GALE-JACKET parent + 1 of 20 children), DRAFT, no product id;
  1 linked draft with 0 members, PAUSED; 0 content docs/snapshots/attempts; **1 PENDING Shopify CONTENT_UPDATE queue row**
  (`MASTER_CONTENT_CHANGE`, 2026-09-11). Production 09-25: 0 listings, 0 queue rows (PCO record, not re-measured).
- Missing: product picker, SKU-match preview, local-only apply, N colour products per family, unlink, safe default state.

## 3. Admin GraphQL contract (pinned `2026-07`, `shopify/api-version.ts:5`; shopify.dev reference)

| Mutation | Behaviour |
|---|---|
| `productUpdate` | only given fields; no variants |
| `productVariantsBulkUpdate(allowPartialUpdates=false)` | only listed variants; one error blocks the call |
| `metafieldsSet` (≤25) / `metafieldsDelete` | sparse; `compareDigest` = compare-and-set |
| `productOptionsReorder` | sets option + value order and re-sorts variants; if values given, ALL existing values must be listed |
| `productOptionUpdate` | rename/position/add/delete values; value reorder not documented |
| media mutations | sparse (already used) |
| **`productSet`** | **replaces lists** (variants, metafields, collections): deletes entries not included |

Unsure: whether a list left out of `productSet` entirely is left alone; whether `optionValues` in bulk update auto-creates values; nothing checked against a live store.
**Rule for existing products: never call `productSet`.**

## 4. Reuse of PCO pieces

`-changes` reusable (comparator `nativeValuesEqual` + metafield digest; no Shopify comparator in `channel-drift/`); `-baseline` reusable
but today's Shopify journal has no `intentVersion`/`writes` → new sends must carry them (`studio-publication.service.ts:292-301`);
`-records` reusable (accepts per SKU on VERIFIED); `-selection` needs a branch; `-overwrite` not needed once sparse.
Live read = `readInformation` (`information-gateway.ts:66`); gap: no read of `options { optionValues }` order.

## 5. What starts writing when the gate opens

| Writer | Trigger | Write |
|---|---|---|
| Queue drain (every minute) | stock, price, master-content cascades | stock `inventorySetQuantities`; price `productVariantsBulkUpdate`; **linked-row content: unconditional `productUpdate` title/description per row, children included** (`outbound-sync.service.ts:2303`; `listing-write.service.ts:190-201`, inferred); native-row content: full `productSet` (`offer-sync.service.ts:18-24`) |
| Master content cascade | enqueues Shopify CONTENT_UPDATE even for unlinked rows (`master-content.service.ts:18,144-150`) | the 1 local row above |
| Linked automation cron (5 min, no env switch) | AUTOMATIC only | `metafieldsSet` |
| Images route | manual | full `productSet` |

Gated rows become terminal SKIPPED (`outbound-sync.service.ts:2262-2266`).
Before opening: P4.0 deployed · linked rows paused · 0 AUTOMATIC · 0 pending Shopify queue rows · 0 unintended `nexusFamilyId` rows ·
wizard/bulk re-read · read-only production census recorded.

## 6. Risks

Unguarded `productSet` path · content cascade overwriting titles from children · VTR step 0 counts a variant without a listing row as
excluded and Shopify refuses exclusions (GALE-JACKET 19 of 20 children have no row) · a second value-order store would conflict with
VTR step 1 · `productOptionsReorder` visibly re-sorts variants · productType sometimes holds a gid (data bug) · store SKUs may differ
from Nexus SKUs (store not read) · **10 real Shopify ids (products, themes) are in the public repo** in
`docs/audits/2026-09-09-shopify-family-migration/README.md` (verified by the main session: 10 distinct ≥10-digit ids).
