# P3 eBay — research (read-only, 2026-09-26)

No file edited, no channel call, read-only SQL on `nexus_vtr_test` / `nexus_pe_test`. Paths start at `apps/api/src/`.
"VTR" = `/private/tmp/nexus-variation-theme/apps/api/src/` (PR #45, the future base). Labels: read / measured / inferred / unsure.

## 1. How Nexus models an eBay Inventory-model listing

- No column says "Inventory". The only marker is `ChannelListing.platformAttributes.__offerIds = {EBAY_IT: offerId}`, on CHILD
  listings only (read). Written after a group publish by `saveOfferIds` (`services/ebay-variation-push.service.ts:528-551`); used as
  the lane marker at `routes/ebay-flat-file.routes.ts:1843-1865`, `ebay-description-push.service.ts:281-290`, `ebay-inventory-drift.service.ts:130`.
- ItemID = `ChannelListing.externalListingId` on parent and children. The group key is NEVER stored; Nexus assumes it equals the
  parent SKU (`ebay-flat-file.routes.ts:2280`, `ebay-inventory-drift.service.ts:139`); the 25703 fallback can switch to an old key
  without saving it (`ebay-variation-push.service.ts:1701-1739`).
- merchantLocationKey = `platformAttributes.merchantLocationKey` + account `ebayPolicies` (`reconcileEbayPolicies`, `:1788-1797`).
- Studio refusal now at `services/pim/studio-publication-ebay.ts:112` (main and VTR); PCO PLAN's "~:97" is stale.
- **Measured:** 208 child listings carry `__offerIds` across 8 items (re-counted by the main session: 208 / 8). All IT, ACTIVE, one account, no alias.

| Family (IT) | Inventory children |
|---|---|
| AIREON | 40 |
| AIRMESH-JACKET | 20 |
| GALE-JACKET | 20 |
| IT-MOSS-JACKET | 30 |
| normal-knee-slider | 8 |
| REGAL-JACKET | 40 |
| VENTRA-JACKET | 40 |
| WATERPROOF-OVERJACKET-BLACK-MEN | 10 |

- **Two stock lanes write the same SKUs (measured).** 7 of 8 families (not AIREON) also have `SharedListingMembership` rows on the
  same item (168). Inventory lane `bulk_update_price_quantity`: 175 successful QUANTITY_UPDATE rows; Trading `ReviseInventoryStatus`:
  160 memberships pushed without error. So `ReviseInventoryStatus` works on Inventory items; `ReviseFixedPriceItem` does NOT
  (eBay: "non consentita per gli oggetti del magazzino", `ebay-axes-convert.service.ts:23-26`).

## 2. Code that writes to the eBay Inventory API

| Writer | Sends | Caller | Gate | Live? |
|---|---|---|---|---|
| Flat-file Push `routes/ebay-flat-file.routes.ts:1501` → `pushVariationGroup` (`:2358`) | item PUT per SKU (`ebay-variation-push:1462`), group PUT (`:1712`), offer PUT/POST with price+qty (`:1888`, `:1903`), `publish_by_inventory_item_group` (`:1930`); on a publish failure caused by other-market drafts it **deletes those offers** (`:2025`) | Owner by hand | `ebayWriteRefusal`, push controls, locks, gateway | yes |
| Image publish `images/ebay-inventory-image-publish.service.ts:325` | same whole-family push | Images tab (scheduled job OFF) | `:84` | by hand |
| Outbound queue `outbound-sync.service.ts:1422` | qty `bulk_update_price_quantity` (`:1774`); content GET-merge-PUT of inventory_item (`:1789-1804`, wipe guard `:1797`); price offer PUT (`:1890`) | minute drain | `:1578` + gateway | yes |
| Wizard / `EbayService` create | single-SKU create only | cockpit, listings, bulk-list worker | yes | create only |

- Gateway: publish mode (`gateway/gateway.ts:213-224`), push lock + wrong-account (`:226-232`); `bulk_get_*` POSTs are reads (`gateway/ebay.ts:12`).
- **No existing group writer is change-only**: each rebuilds the whole family and re-sends price + quantity on the offers.
- Read side: drift GETs the group but compares only title + variant list (`ebay-inventory-drift.service.ts:147`); stock readback reads
  quantities; GetItem answers on Inventory items (PCO record `pco3-live-reads.json`, AIREON, 1.46 s).
- Fresh evidence for Inventory = group GET + `bulk_get_inventory_item` (≤25 SKUs/call) + GetItem ≈ 4 calls per family.
- `liveItemReceipt`'s `InventoryModel` test (`studio-publication-ebay.ts:70`) looks for an element GetItem may not return (inferred: may never fire).

## 3. eBay Inventory API contract (docs knowledge; confidence stated)

- inventory_item PUT replaces the whole record; omitted containers clear (fairly sure). Quantity (`availability`) lives inside it →
  must be echoed. With a published offer, eBay updates the live listing (fairly sure).
- inventory_item_group PUT replaces title, description, imageUrls, aspects, variantSKUs, variesBy (sure). Whether a group PUT alone
  updates the live listing: **unsure** (Nexus always follows it with `publish_by_inventory_item_group`).
- Price on the offer; quantity on the item; offer `availableQuantity` caps it (25004, `:1470-1476`). `updateOffer` replaces the whole offer.
- Add variant: item PUT → POST offer (price+qty) → group PUT → publish (fairly sure). Always sends price + stock.
- Change a value: item PUT (aspects) + group PUT (specifications); publish needed? **unsure**.
- Remove variant: drop from `variantSKUs` or `deleteOffer` — **unsure** which; a variant with sales can probably only go to qty 0.
- Reorder values: group PUT with the new order (inferred).
- Other-market drafts break the group publish (`:1938-1942`).

## 4. Trading variation changes on a live item

- Add: extended `VariationSpecificsSet` + only the new `<Variation>` (SKU, StartPrice, Quantity, specifics, EAN); already live via the
  flat-file page (`ebay-variation-add.service.ts:66-91`).
- Remove: `<Variation><SKU/><Delete>true</Delete>` (`ebay-flat-file-delete.service.ts:191-195`). eBay refuses one with sales; the
  existing fallback then **silently sets quantity 0** (`:196-203`) — breaks R-PCO-2, must not be copied.
- Reorder: `VariationSpecificsSet` in the new order only; no price/qty (`ebay-variation-order-apply.service.ts:8-29`).
- Change a value: `<Variation>` with SKU, new specifics, StartPrice AND Quantity (omitting → error 73, `ebay-axes-convert.service.ts:17-21`),
  + updated set (+ Pictures if the picture axis changed). In-place axis rename failed live (21916664, `:7-15`); value change may too — **unsure**.
- Echo live price: send eBay's own price text (`ebay-trading-api.service.ts:571`). No automatic Trading price writer found
  (price door prices Inventory offers only, outbound-sync `:1862-1906`; `ReviseInventoryStatus` carries no price).
- Echo quantity: GetItem `Quantity` is the LIFETIME total (`ebay-trading-api.service.ts:552-555`, verified by the main session).
  Whether a Revise `Quantity` means "available" (echo `Quantity − QuantitySold`) is **unsure** → prove it with an identity revise.
  🔴 `ebay-axes-convert.service.ts:61,89` echoes the RAW `Quantity` (verified by the main session) — would add sold units back to stock;
  it has never succeeded, so no harm yet (inferred). Fix in P3.5.
- Races: send-time digest (`studio-publication-ebay.ts:260` main / `:263` VTR) covers variation Quantity/StartPrice, not QuantitySold
  (`ebay-content-compare.ts:39-47`). The window between the check and the Revise is short; readback heals drift.
  Mitigation: refuse while a PENDING/IN_PROGRESS quantity row exists for the item's SKUs; after the send, read back and re-send ledger stock.

## 5. Risks

R1 whole-object replace can drop variants/pictures from a stale read · R2 the flat-file publish deletes other-market offers — never reuse ·
R3 two stock lanes on the same SKUs · R4 group key not stored — read it first · R5 flat-file Full Publish is not journaled → should mark
change-only baselines unknown · R6 eBay holds 1 item specific on AIREON → first review shows many "differs" rows · R7 ~250 revisions/listing/day (`ebay-shared-fanout.service.ts:42-45`).
