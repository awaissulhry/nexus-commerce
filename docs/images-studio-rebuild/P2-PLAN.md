# P2 — publishers read the media plan (slice plan)

Code map made 2026-09-27 (read-only study of the P1 worktree). Rule: a family is **switched** when it has a SHARED
`ProductMediaPlan` row. A switched family's publishers send exactly the layout computed by `@nexus/shared/media-plan-channels`;
an unswitched family keeps today's behaviour byte-for-byte (parity tests prove it).

## Summary
Six small PRs, each with its own tests, then one real proof per channel on the test family with the Owner's word:
P2a spine helper + fixes → P2b guards on the old paths → P2c eBay Trading → P2d eBay Inventory → P2e Amazon (one run
per account) → P2f Shopify. Etsy stays in P5 (no Etsy publish path exists to hook into).

## Found while mapping (fix in P2a)
- Layouts carry asset ids; every adapter maps id → URL.
- One helper `mediaLayoutFor(...)` in `media-plan.service.ts` must compute the main language, the listed/excluded
  variants and the layout the same way the page does — otherwise page and publisher could pick different versions.
- eBay sets need `productIds` (the eBay seller SKU can differ from `Product.sku`).
- `MODEL3D` vs `MODEL_3D`: Shopify 3D models would be dropped — use the stored value.
- Shopify's content resolver refuses more than 50 photos per resolved gallery; the layout allows 250 — decide before P2f.
- eBay `variationPictures.byValue` is an object: number-like value names ("42", "44") get re-ordered by JavaScript.
  Use an ordered list (and test a size axis).
- Today's eBay Trading publisher sends **no variation pictures** unless the parent has `_mediaGalleryDraft` (the block
  at `studio-publication-ebay.ts:258-266` never runs). The new path fixes this for switched families.

## Slices
| Slice | Change | Insertion points | Tests |
|---|---|---|---|
| **P2a** | `mediaLayoutFor` + `isMediaSwitched`; excluded variants; eBay API marker (`usesEbayInventory`) in the read; `productIds` on eBay sets; `MODEL_3D` | `services/images/media-plan.service.ts`; `packages/shared/media-plan-channels.ts` | extend `media-plan.service.vitest.test.ts`, `media-plan-channels.vitest.test.ts` |
| **P2b** | Old paths refuse switched families | `amazon-image-feed.service.ts:309` (covers route, retry, scheduled, bulk); `ebay-inventory-image-publish.service.ts` after `:91`; `ebay-shared-image-publish.service.ts` ~`:236`; eBay flat-file push family loop `routes/ebay-flat-file.routes.ts:2074` (ERROR rows; offers-only still runs); scheduled job `:57-66` (mark failed); Amazon per-market workspace save/copy `amazon-media-workspace.service.ts:129,:173` | bulk-image-publish, ebay-shared-image-publish, amazon-media-workspace route tests; a flat-file push test |
| **P2c** | eBay Trading from the layout: `PictureDetails` = Common, one `VariationSpecificPictureSet` per value with the **channel value** (pins and value maps, `channelAxisValues`) and the axis name from `shared.variationSpecificNames` (IT canonical); cap 12 per value | `pim/studio-publication-ebay.ts` `buildEbayListingInput` (skip `:182-186` when switched) and `finishEbayListingInput` (`:257-280`, unswitched path verbatim); `studio-publication-ebay-changes.ts:44` | `studio-publication-ebay-variations` (switched fixture, pinned value, screen order = XML order incl. numeric values), `.parity` (unswitched byte-identical), `-changes` (photos-only sparse publish; 13 per value refused) |
| **P2d** | eBay Inventory: group `imageUrls` (free after P2c) + per-SKU `product.imageUrls` and `aspectsImageVariesBy` as a new "Variation pictures" row, item PUT + read-back | `studio-publication-ebay-inventory-changes.ts` (`LATER` refusal lifted for pictures only), `studio-publication-ebay-inventory.ts` sender | `-inventory-changes`, `-inventory` tests |
| **P2e** | Amazon: `AmazonMediaRun` fed by the layout (`amazonDesiredFromLayout` beside `buildImagePatches`), **one run per account** on a selector market with a check that every child is listed there, run revision includes the plan revisions, read-back on a second market; studio feed fills slots only for new listings and strips them otherwise | `images/amazon-media-publish.service.ts:70`; `amazon-media-workspace.service.ts` revision (`:18,:31,:66,:98`); `pim/studio-publication-amazon.ts:116-134` | `amazon-media-workspace` route tests; new `studio-publication-amazon-media` test; `studio-publication-amazon-changes` |
| **P2f** | Shopify: content draft from the layout (family gallery + one variant image per variant), reconcile on for switched families, linked-product sheet galleries from the layout | `shopify/content-workspace.service.ts:88`; `content-sync.service.ts:141`; `channel-sheet-media.ts:18-76` | `listing-media-content`, `content-sync-existing-product`, `channel-sheet-media`, `content` tests |

## Per-market names in the page read (after P2c)
Value maps alone are not what the publisher uses (listing pins win). Correct and cheapest: per eBay destination,
`resolveBatch` for the listed children + `channelAxisValues` — the publisher's own code. Estimated 100–300 ms per
destination warm; run in parallel, memoised, eBay only. Measured at P3 start.

## Gates to remember
- A photos-only publish is still blocked by any unrelated error in the review (`studio-publication.service.ts:214-216`).
- A first eBay publish (no ItemID) is one `__create__` row — photos go with the whole listing.
