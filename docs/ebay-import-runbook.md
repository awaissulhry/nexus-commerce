# eBay Import — Verification Runbook

**Scope:** the dynamic eBay flat-file import (plan: `docs/superpowers/plans/2026-07-17-ebay-import-excellence.md`) plus the shared-SKU multi-listing model it feeds (E2 + the duplicate-SKU fix `ba28fe74`).

## 1. What shipped (EI series, 2026-07-17)

| Phase | What | Where |
|---|---|---|
| Fix | Duplicate-SKU publish blocker: text-boolean coercion at both doors, family resolution for file-linked/_shared rows, structural shared flag, **adopt-don't-duplicate belt** (a row with a live ItemID never re-lists) | `ba28fe74` |
| EI.1 | Typed coercion (booleans/EU numbers/strict enums canonicalized by option AND label — policy names → ids/multi-value themes/maxLength warns/junk drop) + per-cell issues; File-market selector scopes per-market columns ("Item ID" is deliberate, never column-order luck) | `importCoerce.pure.ts`, wizard |
| EI.2 | Review-listings step: blocks from parentage/parent_sku/ItemID, pooled-SKU badges, per-block **Adopt/Create/Skip** (Adopt default with a live ItemID), one-click "Flag all as Shared-SKU" | `importBlocks.pure.ts`, wizard |
| EI.3 | Import policies (Prices/Quantities/Content/Images/Business policies — all ON; identity+structure+aspects always import; **pool never written**), destructive rows (end/deactivate) behind typed-END, cell-level from→to plan with per-cell exclusion | `importPlan.pure.ts`, wizard |
| EI.4 | Sheet picker + header-row override on `/ebay/flat-file/parse` (workbook block on every Excel parse) | routes + wizard |
| EI.5 | Aspect header unification (dual Italian/EN sets fold into ONE canonical aspect column; ghost columns synthesized; `variantAttributes ⚠` auto-skips); text-category flags; category-required item-specifics report | `importAspects.pure.ts`, wizard |
| EI.6 | "Save wired up" banner (products created, memberships created/updated/skips, pool-untouched note) + per-ItemID **Verify** via read-only `GET /ebay/flat-file/verify-item` (Trading GetItem vs saved memberships: matched/missing/extra/not-pool-linked) | routes + client |

## 2. Invariants

- **The stock pool is never written by import or save** (FM Phase 1). Imported quantities are per-listing eBay quantities.
- **A row carrying a live ItemID is never re-listed** — publish skips with "Save the sheet to adopt"; memberships adopt on save. This holds even if the operator publishes before saving.
- **Amazon SKUs…** n/a here; **eBay child SKUs are case-sensitive custom labels** — matching is exact.
- Destructive `end`/`deactivate` rows never import silently; typed END required.
- Shared-SKU flag is structural: file value applies under BOTH merge modes.

## 3. Regression battery

```bash
# Pure import stack + full eBay web suite
cd apps/web && npx vitest run src/app/products/ebay-flat-file/
# expected: 21 files / 205+ tests green (importCoerce 7, importBlocks 8, importPlan 9, importAspects 7, sharedsku 10)

# Server eBay suite (memberships, shared push incl. adopt belt, create planner)
cd apps/api && npx vitest run $(find src -name '*.vitest.test.ts' | grep -iE 'ebay' | tr '\n' ' ')
# expected: 38+ files / 541+ tests green

# Typecheck + DS ratchet
cd apps/web && npx tsc --noEmit && cd ../api && npx tsc --noEmit
node scripts/ds-conformance-guard.mjs --manifest products   # must not exceed baseline (16 as of EI.5)
```

## 4. Owner E2E — the GALE 5-listing file

1. eBay flat file (IT) → File → import → drag `GALE eBay IT - 5 listings XXS-5XL (import).xlsx`.
2. **Map**: File market = IT (default); expect Item ID/Price/Qty mapped to IT columns; `Taglia (Size)`/`Size ⚠` both on `aspect_Taglia`; `variantAttributes ⚠` skipped.
3. **Review listings**: 5 blocks — GALE-JACKET + 4 others, each Adopt (live ItemIDs), 20 pooled SKUs badged. If the file lacked Shared-SKU flags, the red banner's "Flag all as Shared-SKU" fixes all blocks in one click.
4. **Preview**: policies all ON; no destructive rows; plan shows updates to the existing family + new rows for the 4 new parents; Import.
5. **Save** → "Save wired up" banner: 4 products created · 5 listings · ~100 memberships created · pool untouched. Click **Verify** per ItemID → expect `Active · 20/20 SKUs matched`.
6. **Publish** → primary family pushes; the 4 adopted listings report "already live (ItemID …) — Save the sheet to adopt" only if publish ran before save; after a save they simply skip as already-membershiped. No duplicate-SKU errors anywhere.
7. Change one pooled SKU's stock on /stock → all 5 eBay listings' quantities update via the fan-out (watch OutboundSyncQueue TRADING entries).

## 5. Gotchas

- `/ebay/flat-file/parse` rejects Amazon official templates with a redirect hint (A3.1a) — that's intentional.
- The wizard's aspect tier only folds `X (Y)` and `X ⚠` shapes; a bare unmatched header still lands in Unmapped for manual mapping.
- `verify-item` returns `DRY-RUN` status when `NEXUS_EBAY_REAL_API` isn't enabled (non-prod) — memberships comparison still runs.
- The Combobox target list scopes per-market columns to the wizard's File market; switching market re-runs auto-map and resets block decisions/cell exclusions.

## Deleting rows (2026-07-18)

Deleting a row now severs EVERY source that could resurrect it:

- **Adopted (read-only) child row** → its membership is deleted AND the
  variation is removed from the live eBay listing (`ReviseFixedPriceItem`
  `<Delete>true</Delete>`). If eBay refuses because the variation has sales
  history, its quantity is set to 0 instead (eBay hides qty-0 variations from
  buyers). The whole listing is never ended by a child-row delete. If the live
  removal fails, the toast says so — run Reconcile or remove it in Seller Hub,
  otherwise the next Reconcile restores the row (truth mirrors eBay).
- **Real row** → the delete dialog offers a scope choice:
  - *Remove from eBay only* (default) — the ChannelListing is removed; the
    product stays in the family, so the row reappears on reload as an
    unlisted family member. This is by design: the family file shows the
    product family, listed or not.
  - *Also delete the product from Nexus* — soft-delete; the row leaves the
    file for good (recoverable from Products → deleted filter).

### File exclusion (incident #12, 2026-07-18)

A product family can contain children with no eBay presence (e.g. Amazon-FBM
twin SKUs from a family merge). Deleting such a row used to remove nothing —
and the family loader resurrected it on every reload. Now **deleting any real
row stamps a per-market file exclusion** on the product
(`categoryAttributes.ebayFileExcluded[market] = true`):

- GET /rows skips excluded products → the row stays gone after reload.
- The product itself is untouched (stock, other channels, Amazon listings).
- **Saving that SKU in the file again auto-clears the stamp** — re-adding a
  row is just: add the row (import or type it), Save.
- A variation child's delete never ends the family's live listing (only a
  parent/standalone row may whole-listing delist).

## Images on multi-listing (shell) families — EB-IMG, 2026-07-19

The extra listings created by the multi-listing import are
`EBAY_LISTING_SHELL` products: no product children, variants linked through
`SharedListingMembership` rows, live presence = a Trading ItemID. Two things
shipped for them:

### Image publish (the "Single-SKU … isn't wired" fix)

`publishEbayImagesViaInventory` now dispatches by listing shape:

- **Real family** (product children, Inventory group) → unchanged
  `pushVariationGroup` lane.
- **Shell / no-child family** → `ebay-shared-image-publish.service.ts`:
  resolves ItemID(s) from ACTIVE memberships (`parentSku = shell SKU`,
  falling back to `Product.ebayItemId` for plain single-SKU listings),
  `GetItem`s the live listing, maps the curated axis/values onto the
  DECLARED variation specifics (`Color` → `Colore` via axisSynonymKey,
  values case-insensitive; unmatched → warnings, never silent), and sends
  ONE `ReviseFixedPriceItem` with `<PictureDetails>` + per-value
  `<VariationSpecificPictureSet>` (12-cap each, gallery-wins dedup,
  `__shared__` folds everything into the gallery). Same result shape, so
  the drawer, Images tab, bulk + scheduled publishes all render it.
- `refreshEbayLiveImages` uses the same membership fallback, so shells'
  live strips and post-publish read-backs work.
- Per-SKU image overrides don't exist on Trading listings — warned + skipped.

Verified live 2026-07-19: MOSS-ALT1 (257628770752) went from 1 gallery pic /
no sets to gallery 3 + Colore Grigio 6 · Verde 4 · Nero 6.

### Copy images from another listing

Each family section in the images drawer has **Copy from…** listing the
sheet's other families (add one via the family picker if it isn't in the
sheet). Picking a source loads its SAVED eBay buckets and maps them onto the
target's axis/values (`copyFromListing.pure.ts`, vitest-covered): Default →
Default, per-value sets by name; source values missing on the target are
toasted as skipped; the result lands as UNSAVED buckets — review, swap the
odd image, Save (or Save & Publish). Verified live: GALE-JACKET →
GALE-JACKET-ALT1 (256566101420), 16 images, published in one click.
