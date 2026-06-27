# eBay Shared-Variant-SKU Multi-Listing Inventory Sync — Design Spec

**Date:** 2026-06-27
**Status:** Draft — awaiting user review before plan
**Owner:** Awais / Nexus
**Scope:** eBay only (Amazon + Shopify untouched)

---

## 1. Problem & Goal

Xavia sells genuinely-different products on eBay (e.g. a *Touring Jacket* and an *Adventure Jacket*) that **share a physical stock component** — the same variant, identified by one SKU (e.g. an inner liner `LNR-BLK-M`). The operator wants to:

1. Reuse the **same variant SKU** under **different parent SKUs**, expressed as rows in the **single eBay flat file**, **without creating duplicate Nexus products** for the shared variant.
2. Have the **identical SKU string visible inside eBay Seller Hub** (the listing's Custom Label), in every listing that contains it.
3. Keep the shared variant's **inventory in real-time sync across all those listings** — a sale or stock edit anywhere updates every listing that draws on the shared pool.

This is **eBay-compliant** specifically because the parent listings are genuinely different products (not duplicate listings of an identical item). See §3.5.

### Non-goals
- Not for **identical items** listed twice for SEO/exposure — that violates eBay's duplicate-listing policy (§3.5). This feature must not be used that way.
- Not changing the **default Inventory-API push path** for normal (non-shared) listings.
- Not **cross-marketplace** sync (IT↔DE↔…) — that already works today (one Inventory-API inventory item shared across markets).
- Not Amazon or Shopify.

---

## 2. The one truth that shapes everything

A shared SKU is **not** what produces the sync. **eBay never syncs inventory across separate listings by shared SKU.** The shared variant SKU does two things only:

- **Data simplicity** — the operator types one SKU under multiple parents.
- **A join key** — it tells Nexus "these listings draw on one stock pool."

**Nexus is the sync engine.** When the shared pool's available quantity changes, Nexus pushes the new number to every listing that contains the SKU. This is already how Nexus syncs everything (§4.3).

---

## 3. eBay platform reality (constraints that dictate the design)

### 3.1 Inventory API (Nexus default) cannot do this
Every inventory item's SKU is **unique across the seller's inventory**, and you may publish **only one offer per SKU per marketplace**. So a SKU physically cannot appear as a variant in two live listings on the same marketplace via the Inventory API. ([Inventory item groups][1], [createOrReplaceInventoryItem][2])

### 3.2 Trading API with `InventoryTrackingMethod = ItemID` is the only path to the literal shared SKU
`ItemID` is the **default** tracking method. With it, `Variation.SKU` is a **non-unique Custom Label** that **can repeat across listings**, and listings are identified by **ItemID**. (If `InventoryTrackingMethod = SKU`, variation SKUs become required and must be **unique across active listings** — the opposite of what we need, so we explicitly do **not** use SKU tracking.) ([AddFixedPriceItem][3], [VariationType][4])

> Caveat to accept: eBay's own My eBay / search pages identify listings by **ItemID**, not SKU; the shared SKU shows as the **Custom Label**. That is exactly the Seller-Hub visibility the operator asked for. ([AddFixedPriceItem][3])

### 3.3 VariationSpecifics rules
All variations in a listing must use the **same set of specific names** (e.g. `Size`, `Color`); each variation must have a **unique value combination**. ([VariationType][4])

### 3.4 Quantity updates are by (ItemID + SKU)
`ReviseInventoryStatus` updates a variation's quantity using **ItemID to identify the listing + SKU to identify the variation**. Fan-out therefore = **one `ReviseInventoryStatus` call per ItemID**, each carrying the shared SKU and the newly-computed quantity. ([ReviseInventoryStatus][5], [InventoryStatusType][6])

> Gotcha to verify in sandbox: eBay docs state that when a variation has already sold units, eBay **adds the sold quantity to the value you specify**. Implementation pushes the computed **available** quantity and relies on that behavior; verify against sandbox before trusting it in prod. ([ReviseInventoryStatus][5])

### 3.5 Duplicate-listing policy guardrail
eBay prohibits "more than one fixed price listing of an identical item," explicitly including "listing an identical item in different categories"; penalties escalate from removal to **hiding from search** to suspension. This feature is compliant **only because the parents are genuinely different products**. The UI must make clear this is for shared *components across different products*, never for cloning one product. ([Duplicate listings policy][7])

---

## 4. Current Nexus foundation (from codebase research)

### 4.1 Trading API client — PARTIAL
`apps/api/src/providers/ebay.provider.ts`:
- `callTradingApi(callName, xmlPayload)` — POSTs XML to `https://api.ebay.com/ws/api.dll`, sets `X-EBAY-API-*` headers (`devId`/`appId`/`certId`/`siteId`, compat level `EBAY_COMPAT_LEVEL` default `1193`), parses `<Ack>`/`<ShortMessage>` for failures. Gated by `NEXUS_EBAY_REAL_API==='true'` (dry-run otherwise) and `EBAY_SANDBOX`.
- Implements `ReviseInventoryStatus`, `ReviseItem`, `ReviseItemImages`.
- **Missing:** `AddFixedPriceItem` (create multi-variation listing) — must be built.
- **Auth gap to resolve in plan:** the Trading XML must carry a user token. Trading API accepts an OAuth user token via the `X-EBAY-API-IAF-TOKEN` header. Nexus already mints valid OAuth tokens (§4.2) with `sell.inventory` scope. Plan must verify IAF-token auth works for `AddFixedPriceItem`/`ReviseInventoryStatus` (vs. legacy Auth'n'Auth token in `<RequesterCredentials>`).

### 4.2 OAuth — DONE
`apps/api/src/services/ebay-auth.service.ts` → `getValidToken(connectionId)` returns a valid (auto-refreshed) OAuth access token. Scopes include `sell.inventory`, `sell.account`, `sell.fulfillment`, `sell.marketing`.

### 4.3 Fan-out machinery — DONE and reusable
`apps/api/src/services/stock-movement.service.ts`:
- `applyStockMovement()` → `cascadeQuantityToListings()` (lines ~565–716): atomically recomputes per-listing quantity (respects FBA/FBM pool + `stockBuffer`), updates `ChannelListing`, and enqueues `OutboundSyncQueue` rows (`syncType: 'QUANTITY_UPDATE'`, `holdUntil` = 0ms for order-driven, 30s for manual).
- `OutboundSyncService.processPendingSyncs()` → `syncToEbay()` (`apps/api/src/services/outbound-sync.service.ts`) drains the queue and pushes to eBay (currently via Inventory API).
- `capToFbm()` (`apps/api/src/routes/ebay-flat-file.routes.ts:645`) + `computeAvailableToPublish()` provide oversell protection; reused.

### 4.4 Site IDs — DONE
`apps/api/src/services/ebay-category.service.ts`: `EBAY_IT=101, EBAY_DE=77, EBAY_FR=71, EBAY_GB/UK=3, EBAY_ES=186` (these are the Trading-API site IDs).

### 4.5 The blocker
`ChannelListing @@unique([productId, channel, marketplace])` (named `productId_channel_marketplace`, used by upserts) ⇒ a product can have **only one** eBay listing per marketplace. Our shared variant must belong to **multiple same-market listings**. We work around this with a dedicated membership table (§5.1) rather than relaxing the core constraint (which several upsert paths depend on).

---

## 5. Recommended architecture

A **parallel Trading-API push path**, selected per parent listing, that reuses the existing stock→queue→worker fan-out. Five pieces:

### 5.1 New model — `SharedListingMembership`
Maps a shared variant SKU to every eBay listing that contains it. Avoids touching `ChannelListing`'s unique constraint.

```
SharedListingMembership {
  id                String   @id @default(cuid())
  marketplace       String              // 'IT' | 'DE' | 'FR' | 'ES' | 'UK'
  sku               String              // shared variant SKU (eBay Custom Label)
  itemId            String              // eBay ItemID of the listing containing this variant
  parentSku         String              // parent listing grouping (operator-facing)
  productId         String?             // Nexus product whose StockLevel feeds this SKU (the shared inventory item)
  variationSpecifics Json               // { "Size": "M", "Color": "Nero" } — to target the variation
  status            String   @default("ACTIVE")  // ACTIVE | ENDED
  lastQtyPushed     Int?
  lastPushedAt      DateTime?
  lastError         String?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  @@unique([marketplace, itemId, sku])
  @@index([sku, marketplace])           // fan-out lookup
  @@index([productId])
}
```

### 5.2 Trading-API create path
- Extend `ebay.provider.ts` with `addFixedPriceItem(input): Promise<{ itemId: string }>` — builds the `AddFixedPriceItem` XML: title/description/condition/price/policies, `InventoryTrackingMethod` left default (ItemID), a `<Variations>` block with shared `VariationSpecifics` names, one `<Variation>` per row (`SKU` = shared SKU, `StartPrice`, `Quantity`, `VariationSpecifics`), `VariationSpecificPictureSet` for per-colour galleries (mirror the existing `ReviseItemImages` image code), and the per-market Site ID.
- New service `apps/api/src/services/ebay-shared-listing-push.service.ts`: groups flat-file rows by parent SKU, builds + sends one `AddFixedPriceItem` per parent, captures the returned `ItemID`, and writes one `SharedListingMembership` row per (variant SKU, ItemID). Idempotent: if a membership/ItemID already exists, call `ReviseFixedPriceItem` instead of re-adding.

### 5.3 Fan-out wiring
- In `cascadeQuantityToListings()` (or a sibling invoked right after it), after the normal cascade, **look up `SharedListingMembership` rows for the changed SKU(s)** and enqueue one `OutboundSyncQueue` row per membership: `syncType: 'QUANTITY_UPDATE'`, a new discriminator `pushVia: 'TRADING'` (in payload), `externalListingId = itemId`, `payload.sku`, `payload.quantity` (computed available via `computeAvailableToPublish`/`capToFbm`).
- Reuses the grace window, retry/DLQ, and worker drain unchanged.

### 5.4 `syncToEbay` Trading branch
- In `outbound-sync.service.ts` `syncToEbay()`, branch on `payload.pushVia === 'TRADING'`: call `ebayProvider.reviseInventoryStatus({ itemId, sku, quantity })` instead of the Inventory-API GET-merge-PUT. Reuse existing FBM cap. On `Ack=Failure`, surface to `errorMessage` and let the queue's retry/DLQ handle it.

### 5.5 Flat-file UX (untouchable files — modification approved, option A)
- `/products/ebay-flat-file` + `ebay-flat-file.routes.ts`: allow the **same variant SKU under different parent SKUs**; add a per-parent flag/column (e.g. `shared_sku_listing` / "Trading API") marking a parent listing as a Trading-API shared-SKU listing.
- On push: flagged parents route to `ebay-shared-listing-push.service.ts`; all others keep the existing Inventory-API `pushVariationGroup` path.
- A validation/guard surfaces the duplicate-listing-policy warning and requires the parents to be distinct products (§3.5).

---

## 6. Data flow

**Create:** operator enters rows (same variant SKU under different parents, parent flagged shared) → push → `ebay-shared-listing-push.service.ts` builds + sends `AddFixedPriceItem` per parent → captures ItemIDs → writes `SharedListingMembership` rows → writeback to `ChannelListing`/`Product.ebayItemId`.

**Sync:** sale/edit → `applyStockMovement(sharedProduct)` → `cascadeQuantityToListings()` computes new available → fan-out looks up `SharedListingMembership` for the SKU → enqueues one queue row per listing → worker → `syncToEbay()` Trading branch → `ReviseInventoryStatus(ItemID, SKU, qty)` per listing → all listings reflect the shared pool.

---

## 7. Error handling & edge cases
- **Trading `Ack=Failure`** → parsed (exists), mapped to `OutboundSyncQueue.errorMessage`, retried (`retryCount`/`maxRetries`), DLQ on exhaustion.
- **Partial create failure** across parents → per-parent isolation; successful parents keep their memberships; failed ones reported, not rolled back globally.
- **Oversell** → `capToFbm`/`computeAvailableToPublish` cap pushed quantity to the real pool minus buffer.
- **QuantitySold offset** (§3.4) → push computed available; verify eBay's "adds sold" behavior in sandbox.
- **Idempotency** → existing `SharedListingMembership`/ItemID ⇒ revise, not re-add; `@@unique([marketplace, itemId, sku])` prevents dupes.
- **Ended/deleted listing** → membership `status='ENDED'`; fan-out skips ENDED.
- **Dry-run** → `NEXUS_EBAY_REAL_API!=='true'` short-circuits real calls (existing gate); plan adds dry-run assertions on built XML.

---

## 8. Testing strategy
Per project rule (no local Docker / scratch DBs — verify via tsc/validate + dry-run + eBay sandbox, then prod):
- **Unit:** `AddFixedPriceItem` XML builder (variations, specifics, picture sets, site id); membership writeback; fan-out enqueue (SKU → N rows); `syncToEbay` Trading branch dispatch; `capToFbm` cap.
- **Dry-run integration:** push with `NEXUS_EBAY_REAL_API` off — assert correct XML + correct `SharedListingMembership` rows + correct queue rows, no network.
- **Sandbox:** `EBAY_SANDBOX=true` end-to-end on a 2-parent/1-shared-variant fixture; verify the literal SKU appears as Custom Label in both listings and a stock change updates both.
- Push-hook `tsc`/validate gates as usual.

---

## 9. Scope & proposed phasing (large — sequential sub-plans)
Each phase produces working, testable software:
1. **Trading API foundation** — `addFixedPriceItem()` + harden `reviseInventoryStatus()` wrappers, IAF-token auth verified, dry-run + unit tests.
2. **Model + create service** — `SharedListingMembership` migration + `ebay-shared-listing-push.service.ts` (build listings from rows, capture ItemIDs, writeback). Idempotent.
3. **Fan-out + worker branch** — `cascadeQuantityToListings` membership fan-out + `syncToEbay` Trading branch. Stock change → all listings synced.
4. **Flat-file UX** — same-SKU-under-different-parents entry + shared-listing flag + push routing + policy guard.

---

## 10. Open decisions for sign-off
1. **Trading-API auth:** reuse existing OAuth via `X-EBAY-API-IAF-TOKEN` (preferred — no new secrets) vs. legacy Auth'n'Auth token. (Plan verifies before committing.)
2. **Workaround vs. constraint change:** `SharedListingMembership` table (recommended, isolated) vs. relaxing `ChannelListing @@unique` (higher blast radius). Spec assumes the table.
3. **Phasing:** one combined plan vs. four sequential sub-plans (recommended for a build this size).

---

## Sources
- [1] eBay Inventory API — Creating and managing inventory item groups: https://developer.ebay.com/api-docs/sell/static/inventory/inventory-item-groups.html
- [2] eBay Inventory API — createOrReplaceInventoryItem: https://developer.ebay.com/api-docs/sell/inventory/resources/inventory_item/methods/createOrReplaceInventoryItem
- [3] eBay Trading API — AddFixedPriceItem: https://developer.ebay.com/devzone/xml/docs/reference/ebay/AddFixedPriceItem.html
- [4] eBay Trading API — VariationType: https://developer.ebay.com/devzone/xml/docs/reference/ebay/types/VariationType.html
- [5] eBay Trading API — ReviseInventoryStatus: https://developer.ebay.com/devzone/xml/docs/reference/ebay/ReviseInventoryStatus.html
- [6] eBay Trading API — InventoryStatusType: https://developer.ebay.com/devzone/xml/docs/reference/ebay/types/InventoryStatusType.html
- [7] eBay — Duplicate listings policy: https://www.ebay.com/help/policies/listing-policies/duplicate-listings-policy?id=4255
