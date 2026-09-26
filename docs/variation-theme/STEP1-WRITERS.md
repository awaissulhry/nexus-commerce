# VTR step 1 — every writer of the variation stores (read-only inventory, 2026-09-26, code at origin/main 93215463f)

Source: a read-only search helper (VTR session). Paths under `apps/api/src/` unless noted. NOT yet verified line by line —
each writer is re-read when step 1 re-routes it. Guards: V refuses non-scalars · T trims · D refuses duplicate combinations ·
C compare-and-set · B version bump without CAS · E event/audit · R readiness · K read cache · — none.

Totals: 50+ writers across 8 stores (+ a 9th mirror, `ProductVariation.variationAttributes`). Readers (non-test files):
variationAxes 52 · variationTheme 108 · variations bag ~44 · variantAttributes 92 · eBay `_*` keys 20 · variationMapping 25 ·
variationExcluded 7.

## Axes — `Product.variationAxes`
studio `family-variation-axes.ts:62` (C, E, K) · promote `product-relationship.service.ts:101` + bulk promote `routes/pim.routes.ts:515-520`
(B, K) · auto-detect `auto-detect.service.ts:229,250` (—, axes parsed from titles) · eBay flat-file rows save `routes/ebay-flat-file.routes.ts:1253/1258`
(clears to `[]`) + create `ebay-flat-file-create.logic.ts:286` · Amazon flat-file `amazon/flat-file.service.ts:1779 → :3413` · flat-file import
`flat-file/import/apply.ts:309-323`.

## Theme text — `Product.variationTheme`
promote/demote `product-relationship.service.ts:101,117` (demote nulls the theme, keeps the axes) · bulk promote `pim.routes.ts:519` ·
auto-detect `:236,256,269` · `amazon.routes.ts:57,69,133` (a GET that writes), `:345`, `:654,746,799`, `:1019` (defaults 'Size'), `:1072` ·
nightly `jobs/catalog-refresh.job.ts:65,77,140` · eBay flat-file `ebay-flat-file.routes.ts:1253`, `ebay-flat-file-create.service.ts:177`,
`.logic.ts:284,292` · `amazon/flat-file.service.ts:1774` · `flat-file/import/apply.ts:323` · Etsy sync `sync/etsy-sync.service.ts:156,170` ·
`sync/batch-repair.service.ts:176` · `sync/data-validation.service.ts:293` (no caller found) · web server action
`apps/web/src/app/catalog/[id]/edit/actions.ts:33` (turns '' into null on every save) · `scripts/seed-scale-fixture.ts:311`.

## Values — `categoryAttributes.variations`
`catalog.routes.ts:1779` writeVariationValues (V, T) · attach `product-relationship.service.ts:63` · organize publish/undo
`catalog-organize.routes.ts:145,338` · auto-detect `:275` · bulk action `bulk-action.service.ts:2940,2931` · bulk edit
`products/bulk-edit.service.ts:2272-2278` (also writes the flat key; C optional, E, R, K) · add child `catalog.routes.ts:1289` · create wizard
`products.routes.ts:1471` · **generate `family-generate.service.ts:416` (the ONLY writer with D)** · eBay flat-file create `.logic.ts:300` ·
Amazon flat-file `:1787` · Amazon sync-hierarchy `amazon.routes.ts:826` (whole bag, "Size Name" keys), `:363,670` (deletes) ·
`catalog.routes.ts:912` · bulk duplicate `products-catalog.routes.ts:1023` (clones a child's values under the same parent) · bulk variants
`catalog.routes.ts:1530` · global `pim-global.routes.ts:325,719`. Stale whole-bag read-modify-write (can undo a concurrent write):
`ebay-flat-file.routes.ts:1418,1477,3254`, `ebay-flat-file-delete.service.ts:687`.

## Values — flat keys in `categoryAttributes`
bulk edit `:2274,2283,353` · bulk variants `catalog.routes.ts:1530` (flat ONLY, never `variations`) · generate `:400` · bulk apply
`products.routes.ts:1768` · catalog transfer `catalog-transfer-plan.ts:504`, `catalog-transfer.service.ts:262,266` (C, R), assortment
`assortment/sync.service.ts:382` · eBay import `ebay-import.service.ts:130,152` · reconciliation `listing-reconciliation.service.ts:220` ·
`pim-global.routes.ts:325,719` · client bags `catalog.routes.ts:332,595,619,883`, `products.routes.ts:1443`.

## Values — legacy `Product.variantAttributes`
Still written: organize revert `catalog-organize.routes.ts:333`, eBay flat-file create `.logic.ts:299`, Amazon flat-file `:1786`,
`scripts/fill-variation-store.ts:60 --revert`. Every `variations` writer drops legacy keys.

## eBay `platformAttributes` keys (`_variationAxes`, `_variationAxesMode`, `_axisNameLabels`, `_axisValueLabels`, `_axisValueOrder`, `_axisSortOrder`)
order editor `ebay-presentation-order.service.ts:153-157` (C, Serializable) · projection `family-projection.service.ts:1812-1823` (C) ·
cockpit variation-matrix `ebay-cockpit.routes.ts:626,629` (labels, no guard; its axes/order branches are dead after the 409 at :598) ·
template-apply `:1758-1765` (copies all six raw, no C) · snapshot restore `:1022`, `listing-snapshot.service.ts:245` (C) ·
**eBay flat-file rows save `ebay-flat-file.routes.ts:1059` (+1184, 1211) replaces the bag — reported to DELETE all six keys (to verify)**.
Stale read-modify-write without C: cockpit `/category` 306, `/aspects` 397, `/offer-policies` 890, `/compatibility` 1573, `/publish`
1106, 1235; `ebay-image-axis-preference.service.ts:91`.

## Listing theme/mapping and inclusion
`ChannelListing.variationTheme/variationMapping`: projection `:1821` (C) · `matrix.routes.ts:141,182` (no guard, no web caller found) ·
snapshot restore · replicate `marketplaces.routes.ts:689` · flat-file import `apply.ts:456,469`. `variationExcluded`: only
`setVariationExcluded` (`family-projection.service.ts:429-437`) from the inclusion PATCH and variant-transfer `:171` (C, Serializable).

## Unsure (to check in step 1)
bulk edit on an Amazon coordinate may write `attr_variation_theme` to the listing column (`bulk-edit.service.ts:2207`,
`channel-specs/amazon.ts:69`) · catalog-transfer channel rows (`catalog-transfer-plan.ts:692`), `reconcile-divergence.service.ts:85`,
`information-validation.ts:36` · assortment sync field group `field-groups.ts:37` · reconciliation value shapes · the 9th mirror
`ProductVariation.variationAttributes` (`catalog.routes.ts:1783-1800`, `batch-repair.service.ts:259`) · 10 ad-hoc `apps/api/scripts/*.mts`.
