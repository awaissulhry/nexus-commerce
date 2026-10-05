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

## Owner decision (10-05 15:45): A + "import with image links: Product media takes the library photos and follows the
file's order; super smart and dynamic; deploy multiple sub-agents, AAA quality".
- Core (committed 347d92c4b + uncommitted): images/listing-photos.pure.ts (cloudinaryPhotoKey, matchLibraryPhoto,
  legacyImageUrls, legacyPhotoItems/legacyPhotoId) + listing-photos.service.ts (addLibraryPhotos → family ROOT library,
  pins root 'und' unless empty; settleListingPhotos/settleListingsPhotos). Tests 14 pass.
- eBay spec imageUrls: channelStore.replaces [['_productMediaLocales']] → any Image URLs write removes Product media.
- Builders running: W1 product-media.service.ts (editor bridge, adopt url: ids on save, delete imageUrls on save, copy);
  W2 writers (bulk-edit, import applyTransferTarget → settle in tx, live event); W3 sheet Image URLs column = Product
  media, row note, eBay export from Product media, live-read check.
- Then: 2 reviewers (correctness/data safety; tests + full area runs), then PR.
- Open for PR 2: `_mediaGalleryDraft` (old eBay Images tab) still overrides at publish; live drift mark in the cell.

## Writers of imageUrls (subagent map)
- sheet + MCP set-listing-fields: bulk-edit.service.ts applyProductBulkEdits (:2807 row, :2056 batch) → applyPlatformMutations
- import: catalog-transfer-plan.ts:783 channelValuePatch → catalog-transfer.service.ts applyTransferTarget (:295, :320)
- old flat-file page: ebay-flat-file.routes.ts (Owner: never use it) — not changed
- `_mediaGalleryDraft` (old eBay Images tab, reachable from the popup "Media page" link) still overrides at publish — open.
