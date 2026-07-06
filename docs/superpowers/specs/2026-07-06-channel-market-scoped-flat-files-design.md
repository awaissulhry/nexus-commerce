# Per-Channel / Per-Market Flat Files + Action-Column Lifecycle — Design Spec

**Date:** 2026-07-06
**Status:** Awaiting Owner review (design approved verbally; spec pending review)
**Owner ask (verbatim intent):** *"A separate file for each channel and market, managed my way, while still keeping the inventories all in sync by using the child SKU."*

---

## 1. Problem statement

The Amazon and eBay flat-file editors behave as **one unified surface across channels**, not as separate per-channel/market files. Concretely, deleting a SKU in the eBay flat file also removes it from the Amazon flat file. This blocks independent, per-channel/market listing management.

### Root cause — three coupling layers (with intentional-vs-bug verdict)

| # | Coupling point | Where | Verdict | Action |
|---|---|---|---|---|
| C1 | **One shared `Product` per physical SKU; stock keyed on the child SKU** | `Product` (`schema.prisma`), stock fan-out | ✅ Intentional & correct — this *is* the inventory sync | **KEEP** |
| C2 | **Follow-master content propagation** (title/price/… shared unless overridden) | resolver / `ChannelListing.*Override` | ✅ Intentional & correct — edit-once, divergence is opt-in | **KEEP** |
| C3 | **Both editors load the *whole* catalog** then attach their channel's listings | eBay `ebay-flat-file.routes.ts:83` (`deletedAt: null`); Amazon `amazon/flat-file.service.ts:1332` `getExistingRows` (`{ deletedAt: null }`) | ⚠️ Intentional ("one catalog, two lenses") but predates the "separate files" requirement | **RE-SCOPE** |
| C4 | **eBay delete soft-deletes the shared `Product`** → vanishes from Amazon | `ebay-flat-file-delete.service.ts` `delete-product`/`delete-family` intents set `Product.deletedAt` | 🔴 Bug / wrong default. The channel-scoped `remove-listing` intent exists but only fires for `_shared` rows. Built 2026-07-04 under a "one product = one eBay listing" assumption that no longer holds | **FIX** |
| C5 | **Amazon delete is cosmetic** (local-only; reappears on reload) | `AmazonFlatFileClient.tsx` `deleteSelected`/`onDeleteRows` — no API call | 🔴 Bug / incomplete; asymmetric with eBay | **FIX** |

**Summary:** the *unified catalog + shared stock* (C1/C2) is correct and must stay. The *unified whole-catalog view* (C3) is intentional but wrong for the goal. The *eBay delete nuking the shared product* (C4) and the *cosmetic Amazon delete* (C5) are bugs.

---

## 2. Goals / Non-goals

### Goals
- Each **channel + market** is a **separately-managed flat file** (Amazon-IT, Amazon-DE, eBay-IT, …).
- Adding/removing/deactivating a listing in one file affects **only** that channel + market.
- Inventory stays **synced across all files** via the child SKU (one stock pool per physical item).
- Operator gets **staged, reversible-before-submit** control (Amazon-style Action column), with a dry-run preview.
- Support the shared-SKU **multi-group** model (same child SKU under multiple eBay parents / ItemIDs, per-listing price, shared stock).

### Non-goals (explicitly excluded)
- ❌ **Forking the catalog / stock per channel.** No separate `Product` rows or per-channel stock counters. That re-opens overselling + duplication.
- ❌ Removing follow-master. Divergence stays opt-in via overrides.
- ❌ Any change to the FF2 **workbook v2** import/export engine's contract (it stays the unified round-trip source of truth; this spec *reuses* its preview/apply/diff internals).

---

## 3. Invariants — what must NOT change (the inventory guard)

These are load-bearing. Every operation in this spec must respect them:

- **I1. One `Product` per physical child SKU.** Never create per-channel duplicate products.
- **I2. Stock lives on the child `Product`/SKU and is fanned out to listings.** No add/remove/deactivate-listing operation may ever mutate stock, the SKU, or the `Product` row itself.
- **I3. `Product.deletedAt` is a catalog-level (all-channel) operation.** It is reachable ONLY via the explicit, guarded "Delete product" verb — never as the default of a channel-scoped file.
- **I4. Removing a listing = removing a `ChannelListing` (Amazon) / `SharedListingMembership` (eBay shared)** — nothing else.

**Guard test (must ship with Phase 1):** *"Remove eBay-IT listing for child SKU X → the `Product` still exists (`deletedAt` null), its stock is unchanged, and its Amazon-IT listing is untouched."*

---

## 4. The model — "a file" = a channel+market-scoped view over one catalog

A flat file is redefined from *"the whole catalog with this channel's columns"* to *"the SKUs listed on **this channel + market**."*

| File | Row set (membership) | Add a row means | Remove a row means |
|---|---|---|---|
| **Amazon-`{mkt}`** | Products with an `AMAZON`/`{mkt}` `ChannelListing` | create that `ChannelListing` | remove that `ChannelListing` (Product/stock untouched) |
| **eBay-`{mkt}`** | Products with an `EBAY`/`{mkt}` `ChannelListing` **+** synthesized shared-variant rows from `SharedListingMembership` | create the listing / membership | remove the listing / membership |

- Uniqueness already supports this: `ChannelListing @@unique([productId, channel, marketplace])` (`schema.prisma:1174`); `SharedListingMembership @@unique([marketplace, itemId, sku])` (`schema.prisma:14148`).
- Stock (I2) is shared across every file. The child SKU column is the join key, exactly as today.
- "Not-yet-listed" products no longer clutter a channel file; they surface only through an explicit **Add to this file** flow (create the listing).

**UX note:** "separate file per market" is a *scoped view* presentation, not a physical fork. It may render as a per-market switcher (today's model) or a scoped "one view per market" — implementation choice in the plan. Either way the data scoping is identical.

---

## 5. The Action column (per-row, staged, channel/market-scoped)

Ported from Amazon's operation concept (`buildJsonFeedBody` already emits `UPDATE`/`PARTIAL_UPDATE`/`DELETE`), extended for eBay's richer lifecycle. The Action cell is the **one editable field** on otherwise read-only shared rows.

### eBay Action values

| Value | Effect | Underlying capability | ItemID |
|---|---|---|---|
| *(blank)* | no change | — | — |
| **Deactivate** | set quantity 0 — pause, listing hidden | `ReviseInventoryStatus` (`ebay-trading-api.service.ts:231`) | **preserved** |
| **Reactivate** | restore quantity (valid only from Deactivated) | `ReviseInventoryStatus` | **preserved** |
| **End** | delist on eBay; keep Product/SKU in catalog | delist path (`dispatchChannelDelist` DELETE_LISTING) | **retired** (relist = new ItemID) |
| **Delete product** | soft-delete the shared `Product` (cross-channel) — guarded, typed-confirm, labeled *"removes from ALL channels"* | today's `delete-product`/`delete-family` | product gone |
| **Full / Partial update** *(Phase 2)* | revise live-listing content; blank cell = "leave as-is"; writes via follow-master resolver | **NEW `ReviseFixedPriceItem`** (does not exist yet) | preserved |

### Amazon Action values

| Value | Effect | Notes |
|---|---|---|
| *(blank)* | no change | |
| **Remove from Amazon `{mkt}`** | remove that market's `AMAZON` `ChannelListing` | ASIN persists → reversible (re-add against same ASIN) |
| **Delete product** | soft-delete shared `Product` (cross-channel/market) — guarded | I3 |
| **Full / Partial update** | already derived by `buildJsonFeedBody`; surface it explicitly | existing plumbing |

### Guardrails (all reused from the FF2 engine)
- **Staged:** nothing executes until submit. Changing the cell back = zero consequence, ItemID untouched.
- **Dry-run preview:** *"3 ends, 5 deactivates, 1 delete, 40 updates"* before commit (reuse `previewImport`/`diff.ts`).
- **Typed confirmation** for End / Delete product; explicit irreversibility warning on End (*"re-list mints a new ItemID"*).
- **Staleness/conflict detection** via the FF2 fingerprint mechanism (listing may have sold/ended/changed since load).
- **Post-apply row status** ("Ended" / "Paused" / greyed) so the sheet reflects reality (rows persist by design).

### Key eBay nuance
You cannot "End" a single variant of a multi-variant fixed-price listing. **End on a parent** = `EndFixedPriceItem` for the whole listing; **End on a child/variant** = revise that variation to quantity 0 / remove it from the listing (Phase 2 for content removal; qty-0 works now).

---

## 6. Full scenario matrix

Row types: **Parent** (`_isParent=true`), **Child** (owned variant, `_isParent=false`, has `parentId`), **Shared-variant** (`_shared=true, _readonly=true`, synthesized from `SharedListingMembership` — same child under a group it belongs to), **Not-listed** (no listing on this channel+market).

### eBay — what each Action touches

| Action | Parent row | Child (owned) row | Shared-variant row | Not-listed |
|---|---|---|---|---|
| **Deactivate** | qty 0 for the listing (keep ItemID) | qty 0 for that variant (keep ItemID) | qty 0 for that membership's `itemId` (keep ItemID) | n/a |
| **End** | `EndFixedPriceItem` whole listing; keep Products; `ChannelListing`→ended | revise variant→qty 0 / remove from listing; keep Product | `remove-listing`: delete that `SharedListingMembership`; keep Product + other memberships; best-effort delist | n/a |
| **Delete product** | `delete-family`: soft-delete parent + children, remove memberships, delist — **cross-channel** | `delete-product`: soft-delete that child — **cross-channel** | soft-delete the underlying `Product` — **cross-channel** (warn: affects all groups + Amazon) | n/a |
| **Full/Partial update** *(P2)* | `ReviseFixedPriceItem` listing | revise that variant | revise that membership's listing (per-listing price via `ReviseInventoryStatus` now; content via `ReviseFixedPriceItem` P2) | create listing (`AddFixedPriceItem` → new ItemID) |

### Amazon — what each Action touches

| Action | Parent row | Child row | Not-listed |
|---|---|---|---|
| **Remove from Amazon `{mkt}`** | remove parent+children `AMAZON/{mkt}` `ChannelListing`s | remove that child's `AMAZON/{mkt}` `ChannelListing` | n/a |
| **Delete product** | soft-delete parent + children — **cross-channel/market** | soft-delete child — **cross-channel/market** | n/a |
| **Full/Partial update** | `UPDATE`/`PARTIAL_UPDATE` feed for the listing | same, per child | create listing |

### Before vs after submit (both channels)
- **Before submit:** the Action is a staged cell value — changeable, nothing executed, ItemID/Product untouched.
- **After submit:** executed against live channel + DB. End/Delete are **irreversible** (relist = new ItemID on eBay; on Amazon, remove is reversible because the ASIN persists).

---

## 7. Shared-SKU / multi-group interaction (the originally-planned model)

Already in the model + create/read paths:
- `SharedListingMembership` (`@@unique([marketplace, itemId, sku])`) — one child SKU → many rows with different `itemId` + `parentSku`, one `productId` (shared stock), per-listing `price`.
- Read: `synthesizeSharedRow` / `loadSharedMembershipRows` (`ebay-shared-membership-rows.ts`) emit one `_shared` row per membership.
- Create: `createSharedListing` (`AddFixedPriceItem` → new ItemID, then membership writes) / `pushSharedListings`.

**This spec supplies the missing management layer:** the Action column makes each `_shared` row independently actionable (Deactivate/End that one group's listing via `remove-listing` — leaving other groups, Amazon, and stock intact). Full content editing of a live group is Phase 2 (same `ReviseFixedPriceItem` gap). Prior plans (`docs/superpowers/plans/2026-07-02-ebay-shared-sku-flatfile-management.md` Phase 2) are subsumed here.

---

## 8. Phasing

**Phase 1 — Scoped files + lifecycle Action column + inventory guard** *(uses only existing capabilities)*
- Re-scope both load queries to channel+market membership (C3).
- eBay Action column: Deactivate / Reactivate / End / Delete-product; default destructive verb = End (channel-scoped), not delete-product (fixes C4).
- Amazon Action column: Remove-from-market (fixes C5) + surface existing Update/PartialUpdate/Delete.
- Staging + dry-run preview + typed-confirm + post-apply status (reuse FF2 engine).
- Inventory guard test (§3).

**Phase 2 — `ReviseFixedPriceItem` plumbing** *(the one net-new integration)*
- Build the eBay content-revise adapter → unblocks BOTH the Action column's Full/Partial content update AND live shared-group editing.

**Phase 3 — Amazon per-market parity polish**
- Scoped "one view per market" presentation + per-market Action column parity.

Phase 1 alone delivers the Owner's goal (separate, scoped, my-way files with synced stock).

> **Delivered 2026-07-06 — Plan 1 (channel/market-scoped removal + inventory guard):** the eBay editor's delete now removes only the EBAY/{market} `ChannelListing` (`remove-channel-listing` intent — Product/stock/other channels untouched), and the Amazon editor gained a real market-scoped removal (`removeAmazonListing` + `POST /api/amazon/flat-file/remove`), replacing its cosmetic delete. Both guarded by inventory-invariant tests (17/17 pass). See `docs/superpowers/plans/2026-07-06-channel-market-scoped-removal.md`. **Remaining:** scoped-view load (C3) + the staged Action column (Deactivate/End/Delete + `ReviseFixedPriceItem`) = Plans 2-3.

---

## 9. Affected surfaces (for the plan)

**API (apps/api):**
- `routes/ebay-flat-file.routes.ts` — scoped load (`GET /rows`, ~L77); Action-driven apply on `POST /push` / delete (~L1903).
- `services/ebay-flat-file-delete.service.ts` — default normal-row delete → `remove-listing`; keep `delete-product`/`family` for the explicit verb.
- `services/amazon/flat-file.service.ts` — scoped `getExistingRows` (~L1332); persistent per-market remove.
- `routes/amazon-flat-file.routes.ts` — real remove endpoint.
- `services/ebay-trading-api.service.ts` — add `ReviseFixedPriceItem` (Phase 2).
- **Reuse:** `services/flat-file/import/{diff,scope,apply,validate,report}.ts` (preview/conflict/apply engine).

**Web (apps/web) — untouchable exception, this spec is the approval:**
- `app/products/ebay-flat-file/EbayFlatFileClient.tsx` + `AddListingPopover.tsx` — Action column, staging, confirm modals, post-apply status.
- `app/products/amazon-flat-file/AmazonFlatFileClient.tsx` — Action column, real remove.
- `components/flat-file/*` / `app/products/_shared/*` — shared Action-column primitive (design-system), scoped-view plumbing.

**DB (packages/database):** no schema change expected for Phase 1 (membership/listing tables already model it). Any additive column (e.g. listing lifecycle status) is called out in the plan and gated on Owner go.

---

## 10. Testing strategy
- **Inventory guard** (§3) — the headline invariant test.
- **Channel isolation** — remove eBay-IT ⇒ Amazon-IT + eBay-DE untouched; remove Amazon-IT ⇒ eBay untouched.
- **Scenario matrix** (§6) — unit coverage per action × row-type.
- **Round-trip** — untouched scoped file ⇒ zero changes (reuse FF2 round-trip harness).
- **ItemID lifecycle** — Deactivate keeps ItemID; End retires it; relist mints new.
- **Staleness** — DB changed since load ⇒ conflict surfaced, not silently overwritten.
- Verify on prod (Vercel/Railway) per house rule; local only for tsc/vitest.

---

## 11. Risks & open decisions

| Item | Resolution |
|---|---|
| "Delete product" inside a channel file re-couples channels | Kept but guarded: default destructive verb is End (scoped); Delete-product is visually distinct, typed-confirm, cross-channel-labeled |
| Partial-update blank-cell semantics | Blank = "leave as-is"; writes via follow-master resolver |
| Deactivate depends on eBay **Out-of-Stock Control** account setting | Detect/require/warn; if off, qty-0 ends instead of hides — surface clearly |
| eBay revision rules stricter than Amazon (can't revise sold variations / ended items) | Per-operation validation + clear apply-time error surfacing (pattern: the category-schema banner) |
| Touching untouchable editors/routes | This spec = the approval; changes additive & surgical; design-system primitives only |

---

## 12. Global constraints (carried into the plan)
- Design-system primitives only for new UI (`apps/web/src/design-system`).
- ESM: every relative import in `apps/api` ends in `.js`.
- No changes to FF2 workbook v2 contract; reuse its internals only.
- Preserve config/OAuth/marketplace tables (never touched).
- Commit + push after each verified unit (except migrations/destructive/live-gate flips).
