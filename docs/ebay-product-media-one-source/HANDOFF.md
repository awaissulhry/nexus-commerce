# eBay: Product media is the one photo source — HANDOFF (2026-10-05)

Owner asked (10-05): the Product media column must show what is live on eBay, and a change there must reach eBay on Publish.
Owner chose "A" (build it). Worktree /private/tmp/feat-ebay-publish-adds-variations, branch feat/ebay-publish-adds-variations
(from origin/main 9c8146ab0). Nothing committed or pushed yet.

## Done (uncommitted)
- `apps/api/src/services/pim/ebay-variation-photos.ts` (new): `rowHasOwnPhotos`, `legacyImageUrls`, `ebayVariationPhotoSets`
  (+ `.vitest.test.ts`). Publish (`studio-publication-ebay.ts` finishEbayListingInput) now sends each colour row's own photos
  as eBay VariationSpecificPictureSet off the photo plan (before: never sent). Max 12 per value.
- `studio-sheet.service.ts`: Product media cell shows the old `imageUrls` list when the eBay listing has no Product media.
  KNOWN BREAK (subagent): cell ids differ from GET /product-media → cell drag-reorder/fill refuse. Must be fixed with the
  editor bridge below before a PR.
- Checks: typecheck api pass; vitest ebay-variation-photos + studio-publication-ebay* + studio-sheet* pass (288).

## Waiting for the Owner (decision on old Image URLs lists)
A (recommended): one list at a time, last save wins. Editor GET bridges the old list (library file ids by URL, others as
`url:<hash>` ids); PUT adopts `url:` ids into ProductImage rows (pin product `und` first, like copyProductMedia) and deletes
`imageUrls`; any write of `imageUrls` (sheet/MCP via applyPlatformMutations, import) clears `_productMediaLocales`.
B: one-time move of every old list into Product media at deploy (data change on prod).

## Writers of imageUrls (subagent map)
- sheet + MCP set-listing-fields: bulk-edit.service.ts applyProductBulkEdits (:2807 row, :2056 batch) → applyPlatformMutations
- import: catalog-transfer-plan.ts:783 channelValuePatch → catalog-transfer.service.ts applyTransferTarget (:295, :320)
- old flat-file page: ebay-flat-file.routes.ts (Owner: never use it) — not changed
- `_mediaGalleryDraft` (old eBay Images tab, reachable from the popup "Media page" link) still overrides at publish — open.
