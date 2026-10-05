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
- 16:40 W1/W2/W3 DONE, committed locally 56635ace3 (not pushed). settleAndAnnounce shared. All their checks pass.
- Running: W4 import round-trip (planner compares eBay imageUrls with the list Publish sends; ebayListingPhotoUrls → pure);
  R1 adversarial review (data safety, versions, publish, ids). Next: R2 test sweep (profiles ON, web, guards), fixes, PR.
- Known follow-ups (not in PR 1): Claude undo of Image URLs reads only imageUrls (blind after settle); photo-plan families'
  Image URLs edits are ignored by Publish (pre-existing); live-read may compare eBay-hosted addresses.
- Open for PR 2: `_mediaGalleryDraft` (old eBay Images tab) still overrides at publish; live drift mark in the cell.

## Writers of imageUrls (subagent map)
- sheet + MCP set-listing-fields: bulk-edit.service.ts applyProductBulkEdits (:2807 row, :2056 batch) → applyPlatformMutations
- import: catalog-transfer-plan.ts:783 channelValuePatch → catalog-transfer.service.ts applyTransferTarget (:295, :320)
- old flat-file page: ebay-flat-file.routes.ts (Owner: never use it) — not changed
- `_mediaGalleryDraft` (old eBay Images tab, reachable from the popup "Media page" link) still overrides at publish — open.

## 17:30 — review round (R1 found 12 items) → design change
- Settle writes ONLY the listing: settles only when EVERY address is a library photo (same address, or same Cloudinary
  path with another version marker/ending; a transformation step = another photo). Otherwise the old list stays (cell
  says how many photos are outside). Never adds to a library, never pins (fixed R1 #1 import blocker, #4 library mode,
  #5 cross-business share, #7 rendering swap, #10 slow LIKE). Photo-plan families never settle (#9).
- Editor save adds outside photos to the ROW's product (copy semantics, row pinned) — explicit user action only.
- Colour photos: the chosen axis (`_imageAxis`, else Product.imageAxisPreference) wins; rows without own photos count
  as the gallery (#2); >12 → first 12 + note, never blocks (#3).
- Committed 3c73b3234. Round 2 running: W1 (und on legacy save #8, photoInUse #11), W2 (tests, wording, Claude undo #6,
  import family test), W3 (plan families read-only #9, outside-count note). R2 sweep running on the older state.
- Still open → PR 2: `_mediaGalleryDraft` override (#12); live drift mark.

## 18:30 — round 2 done (all builders + 2 reviewers)
- Commits up to 08e873ae1 (local). W1: und on legacy save, photoInUse counts listing + product saved lists. W2: tests to
  new rules, import family blocker test (+ negative control), wording, Claude undo restores the list Publish sends,
  LX.2 language guard. W3: plan rows' Image URLs read-only, outside-photo count note.
- R2 sweep: only branch-caused failure was the LX.2 guard (fixed). Pre-existing on main: variation-one-writer,
  variation-store-readers, studio-publication delete+relist mocks (×3), attribute-scope-baseline B3; 4 static gates
  (shell pin freshness, dark⇄pin parity, token resolution, DS api guard). DB-needing suites not run (no local pg :5432).
- Known gaps (not in this PR): sheet channel receipts keep no `before` (no rollback for any channel write);
  set-listing-fields undo input limit 30 addresses; `_mediaGalleryDraft` override (PR 2); live drift mark (PR 3).
