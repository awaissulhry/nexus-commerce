# Nexus-as-Hub: 1:1 SKU Linkage + Complete Flat-File Lifecycle — Design

**Date:** 2026-06-29
**Status:** Draft for approval. Supersedes the Shadow-SKU draft (explicitly dropped — it created drift). NOTHING implemented yet.
**Goal:** Make Nexus the accurate hub for operating every platform — each Nexus product mirrors its channel listing **1:1** (SKU + identity) with **zero drift**, and the flat file is the **complete control surface** for the full listing lifecycle (create · update · delete · **relist-same-ASIN**).

---

## 1. Principle — 1:1, no drift, ever

- `Product.sku` **== channel seller-SKU, always.** Nexus mirrors each platform exactly. One SKU per product. Nothing to reconcile, nothing to explain.
- Channel linkage is the stable external id — Amazon **ASIN**, eBay **ItemID**, Shopify **variant id** — on `ChannelListing.externalListingId`.
- "Renaming" a live SKU = the Amazon-native **relist**: delete the old SKU, relist the **same ASIN** under the new SKU. The new **Nexus** SKU equals the new **Amazon** SKU → still 1:1, reviews/ranking preserved (same ASIN).
- **Direct** SKU edits on a LIVE product (edit-page Master tab) stay **blocked** by the existing guard — a direct edit would desync from the channel. Drafts/unpublished rename freely (no channel impact; already works since Phase 1).

## 2. What we build (so the flat file is the complete, perfectly-linked control surface)

### 2a. Flat-file lifecycle gaps — the rename enabler
- **ASIN passthrough** — an input (`merchant_suggested_asin` / `external_product_id`) so a NEW SKU row attaches its offer to an **existing ASIN**, preserving reviews/ranking. (Today a new SKU mints a *new* ASIN → loses reviews — the core defect.)
- **Delete-sync** — `record_action=delete` rows also **soft-delete the local `ChannelListing`**, ending the split-brain (today: deleted on Amazon, still active in Nexus).
- **FBA visibility** — when a SKU being deleted/relisted has FBA stock, surface a clear warning + the required steps (removal order / sell-through / relabel). **Not automated** (stays operator-driven in Seller Central) — but never a silent surprise.

### 2b. Linkage integrity — the hub trust layer
- The relist **carries the ASIN** (new SKU → same ASIN → `externalListingId` copied to the new `ChannelListing`), so linkage survives a rename.
- A **reconciliation / drift audit** (built on the existing `ListingReconciliation`) that flags any product whose Nexus SKU/identity ≠ what the channel actually reports — catching accidental divergence (e.g. a manual Seller-Central change) with a one-click fix. This is the safety net that keeps "1:1, no inconsistency" TRUE in the real world.

## 3. Phasing

- **Phase 1 — Flat-file delete-sync.** Closes the split-brain; lowest risk. *(Untouchable file — approved.)*
- **Phase 2 — Flat-file ASIN passthrough.** The relist-same-ASIN enabler. *(Untouchable file.)*
- **Phase 3 — FBA visibility** on delete/relist.
- **Phase 4 — Linkage reconciliation** (Nexus↔channel drift audit + fix).
- **Channel order:** Amazon first (primary market + where the gaps are); eBay/Shopify lifecycle parity as a follow-on. The 1:1 principle applies to all channels now.

## 4. Risks & mitigations

- Untouchable flat-file files → shared hooks/services + surgical edits + your explicit approval; verify each on prod before moving on.
- Delete-sync → **soft delete only** (reversible); confirm no unintended cascade on Offers/Stock/history.
- ASIN passthrough → validate the ASIN is real and the submitted feed **attaches the offer** (doesn't mint a new ASIN); test on one inactive SKU first.
- FBA → surface only, never auto-removal.
- **No migration and no publish-identity change in this plan** → dramatically lower risk than the rejected Shadow-SKU path.

## 5. Out of scope

- Shadow SKU / internal-vs-channel SKU divergence — **rejected** (it creates exactly the drift we're eliminating).
- Automating FBA removal/relabel (operator-driven; surfaced only).
- eBay/Shopify SKU-rename-in-place (also relist-based; their flat-file lifecycle is a follow-on).

## 6. Open decisions (please confirm on review)

1. **Delete-sync depth:** soft-delete the `ChannelListing` only and keep the `Product` (so history/links survive) — *recommended* — vs also archive the Product.
2. **ASIN passthrough UX:** an explicit flat-file column the operator fills (control + transparency) — *recommended* — vs an inferred "relist" action that auto-carries the prior ASIN.
3. **Reconciliation timing:** ship the lifecycle gaps first and add the drift audit as Phase 4 — *recommended* — vs build reconciliation up front.
