# SKU ↔ Channel Decoupling ("Shadow SKU") + Flat-File Lifecycle — Design

**Date:** 2026-06-29
**Status:** Draft for approval — NOTHING implemented yet.
**Goal:** Make the internal product SKU a freely-renameable label by decoupling it from the channel seller-SKU (the Rithum/ChannelAdvisor "Shadow SKU" model), and close the Amazon flat-file lifecycle gaps so create / update / delete / **relist-same-ASIN** are all expressible — making the Nexus flat file the complete, best-in-class source of truth with full control.

---

## 1. Problem (what's wrong today)

- `Product.sku` is overloaded as BOTH the internal organizational identity AND the channel seller-SKU/listing key on **all three** channels (Amazon `item_sku`, eBay Inventory-API `/inventory_item/{sku}`, Shopify variant SKU). No channel-stable SKU is stored.
- Consequence: you can **never** rename a live SKU without spawning a **duplicate listing** on every channel + (for FBA) stranding inventory under the old SKU/FNSKU. The Phase-1 guard correctly blocks this — but that means live SKUs are frozen with no supported rename path.
- The flat file (today) can **delete** a listing (sends `record_action=delete` to Amazon) but: leaves Nexus **split-brain** (no local soft-delete), **cannot relist against an existing ASIN** (no ASIN-passthrough column → a new SKU mints a NEW ASIN → loses reviews/ranking), and does **not** handle FBA inventory.

## 2. Approach (Shadow SKU + flat-file lifecycle)

**A. Decouple internal SKU from channel seller-SKU.** Store the channel's seller-SKU per listing; identify the channel listing by that stable value (+ external id), not by live `Product.sku`. Then `Product.sku` becomes a renameable internal label; renaming it never touches the channel. (This is Rithum's Shadow SKU.) In the common case, **you never change the Amazon SKU at all.**

**B. Make the flat file able to actually change the Amazon SKU when genuinely needed** — the rare case — by closing the three lifecycle gaps (ASIN passthrough, local delete-sync, FBA visibility).

## 3. Data-model changes

- `ChannelListing.sellerSku String?` — the seller-SKU as it exists ON the channel. Seeded at first publish; for existing listings, backfilled = `Product.sku`. Becomes the channel identity for updates.
- (Reuse) `SkuAlias` (productId / alias / source) — already exists; used so channel-sourced inbound data under a prior seller-SKU still resolves to the product.
- Flat-file: a `merchant_suggested_asin` / `external_product_id` input path (manifest column) so a new SKU row can attach to an EXISTING ASIN. **Flat-file files are untouchable → this phase needs separate explicit approval.**

## 4. Behavior changes

- **Publish identity:** all channel publish/update paths resolve the listing by `ChannelListing.sellerSku` (+ `externalListingId`/ItemID/variant-id), falling back to `Product.sku` when `sellerSku` is null. `Product.sku` is no longer the channel key.
- **Rename flow:** renaming `Product.sku` on a live product becomes **allowed** (it's an internal label; the channel keeps `sellerSku`). The Phase-1 guard is **rescoped**: instead of blocking, it (a) never lets `sellerSku` be blanked, and (b) surfaces a **drift chip** when `Product.sku ≠ sellerSku`.
- **Inbound resolution:** channel→product lookups that currently key on `Product.sku` (`ebay-orders.service.ts`, `channel-stock-event.service.ts`, `amazon/flat-file-hydrate.service.ts`) resolve via `ChannelListing.sellerSku` → `SkuAlias` → `Product.sku`, so a rename never orphans incoming orders/reports/returns.
- **Flat-file delete-sync:** `record_action=delete` rows also soft-delete the local `ChannelListing` (and optionally the Product) — no more split-brain.
- **Flat-file relist-same-ASIN:** a new SKU row carrying an existing ASIN attaches the offer to that ASIN (preserves reviews/ranking) instead of minting a new ASIN.

## 5. Phasing (safety-first — this is the part that can break live listings)

- **Phase 0 — additive, zero behavior change.** Add nullable `ChannelListing.sellerSku`; backfill `= Product.sku` for ACTIVE+published listings. Nothing reads it. Fully reversible. *(Migration — runs as a reviewed step on Neon.)*
- **Phase 1 — shadow/verify.** Publish computes the seller-SKU it WOULD use from `sellerSku`, logs a comparison vs `Product.sku`, but still publishes with `Product.sku`. Run across real publishes; confirm zero mismatches before switching. De-risks Phase 2.
- **Phase 2 — switch identity + enable rename.** Publish uses `sellerSku` (fallback `Product.sku`). `Product.sku` becomes renameable; rescope the guard; add the drift chip; switch inbound lookups to `sellerSku`/`SkuAlias`. Internal-only, reversible (flip back to Product.sku).
- **Phase 3 — flat-file lifecycle (untouchable; separate explicit approval).** ASIN-passthrough column + delete-sync + FBA removal/relabel guidance surfaced in the editor.
- **Phase 4 — polish.** Drift dashboard, bulk reconcile, sellerSku visible on the grid/edit.

## 6. Risks & mitigations

- **Wrong publish identity → duplicate live listing.** Mitigated by Phase 1 shadow-verify (prove `sellerSku == Product.sku` on real publishes before the switch) + Phase 2 reversibility + verifying on a single draft/inactive SKU first.
- **Renamed internal SKU orphans inbound data.** Mitigated by the inbound-resolution change (Phase 2) — must land in the same phase as the identity switch.
- **Backfill correctness on messy/duplicate-parent data** (GALE-JACKET vs XAVIA-GALE-GIACCA-DA). Backfill reads raw `Product.sku` per listing, so it's robust; spot-check the known duplicates.
- **Migration on prod.** Additive nullable column; follow the Neon migration recipe; reviewed step, not auto.

## 7. Out of scope (this spec)

- Automating FBA removal orders / FNSKU relabel — surfaced as guidance/tracking only; the physical inventory dance stays operator-driven in Seller Central.
- eBay/Shopify variation re-parenting (eBay group key immutable).
- **Flat-file editor performance** (virtualization / memoization / streaming) — a separate workstream, also untouchable, needs its own approval.

## 8. Open decisions (please confirm on review)

1. **Flat-file `item_sku` semantics after decoupling:** keep `item_sku` = the channel `sellerSku` (flat file stays the channel control surface; the internal label is renamed on the edit page Master tab). *Recommended.*
2. **Channel scope / order:** Amazon first (your primary market), then eBay, then Shopify — vs all three at once. *Recommended: Amazon-first.*
3. **Guard after decoupling:** rescope to "never blank `sellerSku`" + drift chip, vs keep a hard block as a belt-and-suspenders. *Recommended: rescope.*
