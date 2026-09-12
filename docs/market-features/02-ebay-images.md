# 02 — eBay IMAGES

## 1. What it is (operator terms)

An eBay variation listing shows **two galleries**: the *listing* gallery a buyer sees before they pick
anything (position 1 of it is the search-results thumbnail), and a *per-variation* gallery that swaps in
when the buyer picks a colour. The operator's job is to decide, per photo, **which of those buckets it
belongs to and in which position** — because on eBay the ORDER is the meaning and there are no named
slots. So the surface is a grid: rows = `Default (cover & common)` + one row per axis value; columns =
positions 1…12. A merchandiser opens it after the master gallery is right, drags/picks photos into
buckets, then publishes to eBay. Twelve is the real ceiling per variation on this path
(`ebay-image-axis.pure.ts` `EBAY_VARIATION_IMAGE_MAX`, enforced at `ebay-variation-push.service.ts:811,816,1555`).

Two eBay-only rules make this different from Amazon:
- **The axis is a choice, not a fact.** eBay varies pictures by exactly ONE aspect and the operator
  picks which (`Colore` / `Taglia` / `__shared__` = one gallery, no per-variant images).
- **Curation is sent VERBATIM.** A shared-pool photo may be reused in any row and any position
  (`ebay-gallery-verbatim.pure.ts:6-8`, operator rule 2026-07-27). Both call sites used to subtract the
  shared pool and silently published 6 of 7 photos per colour; the incident is in that file's header.

## 2. Old UI — inventory

**Entry point:** old edit page → Images tab → eBay channel tab. `tabs/ImagesTab.tsx:756` mounts
`tabs/images/ebay/EbayPanel.tsx` (607 L).

| Interaction | file:line | Round-trips? |
|---|---|---|
| Axis menu "Vary by" incl. `One shared gallery` | `EbayPanel.tsx:417-443` | `PATCH /images-workspace/axis` at `:212`, then `onReload()` — the reload is load-bearing (`:206-209`: without it Publish uses a STALE axis) |
| `Default` row + per-colour rows × positions 1..12 | `:304-329`, renders shared `ChannelImageGrid.tsx` at `:518` | no — client bucket state |
| Exclusive-bucket assign (move, never copy) | `:238-252` | no |
| Remove, with a **confirm when removing the Main** showing which photo takes over | `:349-357`, dialog `:571-604` | no |
| Promote to Main (move-to-front) | `:266-278` | no |
| Drag between cells / from the master strip | `:282-301`, strip `:451-476` | no |
| Save (flush) / Discard, driven by the shared bottom bar via an imperative controller | `:375-400`, `EbayController` `:52-57` | `POST /images-workspace/bulk-save` — full replace of Default + this-axis rows |
| Publish | fired from the TAB, not the panel: `tabs/ImagesTab.tsx:475-478` | `POST /ebay-images/publish` body `{ activeAxis }` |
| Axis warnings (Layer A) | `:481-494` | from the workspace payload |
| "Live on eBay" strip + Refresh | `:499-506` (`LiveChannelStrip`) | `POST /live-channel-images/refresh` |
| Publish history accordion | `:539-556` (`ImagePublishHistory`) | `GET /image-publish-jobs` |

**Browser-local only:** the whole bucket working copy (`Buckets = Map<string,string[]>` at `:105`), the
dirty count (`bucketsDiff` `:176`), rollback snapshots (`publishSnapshotStorage.ts`), auto-publish
(`autoPublishPrefs.ts`), approval queue (`approvalPrefs.ts`).

**DEAD for eBay — components that declare eBay support and are never mounted on it.** `EbayPanel.tsx`
imports (`:15-23`) Button, cn, beFetch, `ImagePickerModal`, `ImagePublishHistory`, `LiveChannelStrip`,
`ChannelImageGrid` — **and nothing else**. So of the four surfaces my brief lists:
- `ChannelValidationBanner.tsx:33` types `channel: 'EBAY' | 'SHOPIFY'` — imported only by
  `shopify/ShopifyPanel.tsx:27` and `CrossChannelPublishModal.tsx:28`. **Never rendered for eBay.**
- `ChannelStaleBanner.tsx:27` same union, same story (`ShopifyPanel.tsx:29`). **Never rendered for eBay.**
- `ChannelPublishPreviewModal.tsx` — only `ShopifyPanel.tsx:28`. **No eBay publish preview exists.**
- `RecentChannelJobsStrip.tsx` — only `ShopifyPanel.tsx:658` (`channel="SHOPIFY"`). **Not on eBay.**
- `ImageActionBar.tsx` / `ChannelPreview.tsx` — the action bar is tab-level; `ChannelPreview` is
  Amazon+Shopify only (`amazon/AmazonPanel.tsx:993`, `ShopifyPanel.tsx:626`).

⚠ `docs/2026-09-01-pes7-images-inventory.md` §2.5 grades all four **"for eBay+Shopify … REAL"**. Read
against the importers that is **false for eBay on all four rows** — parity rows 5.56/5.53 must be
graded against the mount, not the prop type. (CODE-READ.)

`tabs/ebay-cockpit/cards/ImagesCard.tsx` (285 L, parity 3.43) is the other old surface: a READ +
navigate card — hero, master gallery thumbs, per-colour `VariationSpecificPictureSet` chips, a stale
banner, "Open Images tab" deep link (`:3-19`). It is the right shape for a drawer pane.

## 3. Backend that exists

**Routes** (registered `apps/api/src/index.ts:790-791`, prefix `/api`)
- `POST /products/:productId/ebay-images/publish` — `routes/images/channel-image-publish.routes.ts:53-95`.
  Body `{ activeAxis? }`, query `?marketplace=`. 200/422/500.
- `GET /products/:productId/images-workspace` — `routes/images/images-workspace.routes.ts:84`. One payload:
  product, master, `listing` (all scopes), variants, `availableAxes`, `axisValueCounts`, resolved axes +
  warnings, amazon jobs.
- `PATCH …/images-workspace/axis` — `:401-422` → `writeImageAxisPreference(productId, axis, marketplace)`.
- `POST …/images-workspace/bulk-save` — `:425-496`. `{upserts, deletes}` in ONE `$transaction`
  (`:443`), deletes first; every upsert is stamped `publishStatus: 'DRAFT'` (`:478`). **No
  `expectedVersion`, no optimistic concurrency.**
- `POST …/images-workspace/copy-scope` — `:499`. Backs "copy Master→eBay / Amazon→eBay".
- `GET /products/:productId/image-publish-jobs` — `channel-image-publish.routes.ts:142` (unified
  Amazon+eBay+Shopify). `POST /image-publish-jobs/:jobId/retry` — `:229`.
- `GET|POST /products/:id/live-channel-images[/refresh]` — `routes/product-images-crud.routes.ts:1139,1162`.
- eBay has **no** `validate`, `preview` or `stale` route. Amazon has all three
  (`routes/images/amazon-images.routes.ts:320,371,406`).

**Services**
- `services/images/ebay-inventory-image-publish.service.ts` (555 L) — the real path. Builds the same
  family rows as the eBay flat file (`buildEbayFamilyRows`), resolves priced markets from
  `ChannelListing` (`:121-137`), resolves the picture axis (`resolveImagePictureAxis`, `:215`), reads
  curated `ListingImage` rows into `sharedUrls` / `imageOverrideByColor` / `imageOverrideBySku`
  (`:228-258`), sends them **verbatim** (`:259-265`), and pushes via `pushVariationGroup`
  (`:310-330`). Dispatches to the Trading path for shells and single-SKU listings (`:89-91`, `:112-114`).
- `services/images/ebay-gallery-verbatim.pure.ts` — 2 lines of code, 29 of incident history. The ONE
  verbatim rule, shared with the description renderer (`ebay-description-render.ts:42`).
- `services/images/ebay-shared-image-publish.service.ts` — Trading `ReviseFixedPriceItem` for
  `EBAY_LISTING_SHELL` products (memberships → ItemID), 12-cap on both gallery and per-variation sets
  (`:38`), per-SKU overrides warned + skipped (`:20-21`).
- `services/images/ebay-image-publish.service.ts` — legacy Trading/`ebayItemId` path, **a permanent
  no-op for Inventory-listed families** (stated `ebay-inventory-image-publish.service.ts:4-6`).
- `services/images/ebay-live-images.service.ts` — GetItem read-back into `ChannelLiveImage`; needs
  `ebayItemId` or a `SharedListingMembership` fallback (`:139-158`), else `skipped: 'NO_ITEM_ID'`;
  gated by `NEXUS_EBAY_REAL_API` (`:20-26`, `:164`).
- `services/ebay-image-axis-preference.service.ts` — per-market `_imageAxis` on the parent
  `ChannelListing.platformAttributes`, global `Product.imageAxisPreference` as fallback.
- **Post-publish parity assertion** (`ebay-inventory-image-publish.service.ts:348-389`): re-reads
  `GET /sell/inventory/v1/inventory_item/{sku}` per curated value, 4 s delayed retry for eventual
  consistency, and pushes a loud warning comparing LIVE against what the OPERATOR curated (`curatedByColor`,
  `:382`) rather than against the post-pipeline set — because the earlier version "could never catch a
  reduction it had already been fed".

**Prisma**
- `ListingImage` — the eBay store. eBay rows are `scope: PLATFORM, platform: 'EBAY', marketplace: null`;
  bucket = `variantGroupKey`/`variantGroupValue` (null key = Default); `position` 0-based; `role`
  MAIN/GALLERY; `publishStatus` DRAFT|PUBLISHED|OUTDATED|ERROR; `locked` is "a UI safety only; does NOT
  affect Publish". **No `marketplace` and no `aliasId` on an eBay row** — see §5.
- `ChannelImagePublishJob` — `channel`, `marketplace?`, `status` SUBMITTING|DONE|FATAL,
  `requestPayload` (records `{markets, groupKey, requestedAxis, pictureAxis, realAxes, sharedGallery}`),
  `response`, `vendorEntityId` = the group key.
- `ChannelLiveImage` — read replica; comment says `marketplace` is "Null for eBay + Shopify which are
  not per-marketplace today"; eBay `slot` = position-as-string.
- `ProductImage` — master. `ScheduledImagePublish` — the schedule rows.

**Jobs/crons:** `jobs/scheduled-image-publish.job.ts:23` fires `publishEbayImagesViaInventory`,
**default-OFF** behind `NEXUS_ENABLE_SCHEDULED_IMAGE_PUBLISH=1` (`:9-12`; `index.ts:1729`) — and per
inventory §7 D4 the prod cron is disabled with zero rows. `jobs/ebay-image-readback.job.ts` (read-only,
gated). `routes/bulk-image-publish.routes.ts:37` is a second caller of the same publisher.

**Permissions** (`lib/auth/permissions-manifest.ts`, first-match-wins)
- `…/images-workspace/bulk-save` matches `P(F.productsImagesEdit, has('/images'))` at `:380` — the path
  contains `/images-workspace`.
- `…/ebay-images/publish` does **NOT** — `has('/images')` needs a literal `/images` and the segment is
  `/ebay-images`. It falls through to `RW(F.productsView, F.productsEdit, pfx('/api/products'))` at
  `:412`, so **a live eBay image publish needs only `products:edit`**, while the bulk equivalent needs
  `marketingPublish` (`:317`) and the job list needs it too (`:164`). (CODE-READ.)

## 4. Studio today

`_studio/images/channel/ebay/` — 3 files + 1 test (606 L total), mounted from
`_studio/images/ImagesTab.tsx:147-156` on `scope === 'EBAY'`; tab bound at `StudioTabHost.tsx:46`.

- `buckets.ts` (174 L, pure, `buckets.vitest.test.ts` 139 L) — `buildBuckets` (Default first, then the
  axis's order, then **orphan buckets that exist in storage but not in the axis**, `:71-73`),
  `placeInBucket` returning `move|add|refused` with the one-bucket invariant (`:143-148`), `renumber`
  returning only rows whose position changed (`:158`), `bucketWarnings` (`:165`). `EbayRow` is a
  `Pick<ListingAsset,…>` (`:34`) — deliberately not a hand-written twin.
- `useEbayEdits.ts` (87 L) — every edit is ONE `bulk-save` transaction carrying the upsert and the
  delete of the photo's old home together (`:42-50`), so no window exists where a photo is in two
  buckets. Memoised return per ruling #156 (`:83`).
- `EbayGrid.tsx` (206 L) — `NexusGrid` + `MediaCell` on the DS media substrate
  (`MEDIA_MATRIX_GRID_OPTIONS`), 12 position columns, header `1 · cover` (`:75`), 0-based storage →
  1-based screen converted once at the column def (`:10-12`), refusals rendered in place (`:125`),
  a `Modal` position picker (`:160-205`).

**Parity rows.** 5.53 (eBay Default+colour rows, exclusive buckets, main-removal confirm, axis menu,
flush/discard) · 5.56 (validation/stale/preview/jobs) · 5.57 (unified history+retry) · 3.43 (cockpit
ImagesCard) — **all four have an EMPTY status cell** in `docs/pes-parity-audit.md:351-355,169`; §5 is
ungraded. Against the code today: 5.53 is **partial** (grid + buckets + cap shipped; **no axis menu, no
main-removal confirm, no drag, no shared-gallery mode**), 5.56 is **absent on both sides**, 5.57 is
covered by `_studio/images/publish/PublishHistory.tsx`, 3.43 is unbuilt.

**Hub rulings that bind this feature**
- **#125** (2026-09-01) — "**P4 eBay SHIPPED, prod-verified** (3 buckets, 16 photos, one-bucket
  invariant as a single transaction, 12-cap refused with the limit NAMED, renumber-on-remove)."
  Same ruling: `RecordImage.inherited?` / `inheritedFrom` contract, and `pickFaceImage()` written once.
- **#181** — `StudioRow` carries `imageUrl`, `photoCount`, `imageInherited`; server-side `pickFaceImage`
  "so grid and drawer cannot disagree"; 74 of 301 children have zero own images.
- **#447** — measured on `?tab=images&scope=EBAY`: "eBay images · 3 buckets · 16 photos · max 12 per
  variation" over the bucket grid, with planner, publish record and schedule. Also the standing
  instruction for any future split: **mount `EbayGrid` directly, never a second host duplicating the
  planner/record/schedule.** And: matrix rows are AXIS VALUES, not variations, so the grid scales.
- **#247** — the precedent for §5's headline: `getEbayPublishMode()` **exists and is not called** on the
  eBay batch path; ruled OWNER-QUEUE with a hub recommendation to *close it now*.
- **#80** — a `warn` on a src-less media cell is unreachable by design; "required and empty" is a
  MATRIX-level statement, not a tile one (`renderers/mediaCell.ts:69-82`).
- **#3** — "The Images tab renders no sheet, no family bar" — it is neither the drawer's nor PES.3's.

## 5. Defects and slowness

1. 🔴 **The eBay image publish is an ungated LIVE write to `api.ebay.com`.** CODE-READ.
   `channel-image-publish.routes.ts:53-95` → `publishEbayImagesViaInventory` → `pushVariationGroup`.
   `grep -n "NEXUS_ENABLE_EBAY_PUBLISH|EBAY_PUBLISH_MODE|publish-gate"` over
   `routes/images/*.ts`, `services/images/*.ts` and `ebay-variation-push.service.ts` returns **nothing**;
   the base URL is `process.env.EBAY_API_BASE ?? 'https://api.ebay.com'`
   (`ebay-inventory-image-publish.service.ts:48`) and the push uses 14 raw `fetch()` calls against it.
   `NEXUS_EBAY_REAL_API` gates the *Trading* helper (`ebay-trading-api.service.ts:235`) and the live-image
   READ, so the shell path is gated and the Inventory path is not. Meanwhile the studio's own planner
   renders an eBay **gate pill** from `/api/listings/publish-readiness`
   (`listings-syndication.routes.ts:2667`, `plan/CrossChannelPlanner.tsx:44-56`) — a control aimed one
   layer away from the call it makes. Third instance of #247's class.
2. 🔴 **"Publish images" also rewrites the live listing's DESCRIPTION.** CODE-READ,
   `ebay-inventory-image-publish.service.ts:302-309` renders the themed description and `:328` sends it
   as `parentContent.description`; `:336-345` then stamps the description push so the staleness badge
   clears. Deliberate (the comment says so) and invisible: nothing on any screen says an image publish
   re-delivers the description.
3. 🔴 **It can DELETE offers on other marketplaces.** CODE-READ, `ebay-variation-push.service.ts:1943-1965`
   (FFP.14 auto-heal): on a 25007 with orphan drafts, `DELETE /sell/inventory/v1/offer/{offerId}` for
   every `UNPUBLISHED` offer on every other market, then retry. Reachable from an images-only publish —
   `skipOffersOnNoPrice: true` skips *offer updates on no price*, not this branch. Failure-path only.
4. 🔴 **Two different axes in ONE request.** CODE-READ. The publisher reads the **global**
   `Product.imageAxisPreference` (`:81`, `:216`) while the description renderer reads the **per-market**
   `_imageAxis` (`ebay-description-theme.service.ts:261-262`) and the flat file reads it too
   (`ebay-flat-file.routes.ts:2206-2207`). Where a market's `_imageAxis` differs from the global column,
   one call curates pictures by axis A and re-renders the description's galleries by axis B.
5. 🔴 **The per-market axis capability is unreachable from the images surfaces.** CODE-READ.
   `writeImageAxisPreference` takes a marketplace; `EbayPanel.tsx:212-213` sends `{ axis }` with none, so
   it always writes the global column; `tabs/ImagesTab.tsx:342` reads the global column back. The studio
   has **no axis control at all** and `EbayGrid` is handed `axisValues`/`axisName` from `ws.axes[0]`
   (`ImagesTab.tsx:152-153`), so `__shared__` mode is unreachable there.
6. 🔴 **Success stamps every eBay row PUBLISHED, including the ones that were never sent.** CODE-READ,
   `:422-427` — `updateMany({ where: { productId, platform: 'EBAY' } })`. Photos past the 12-cap (sliced
   at `:1555` with only a warning), and per-SKU rows the Trading path *warns and skips*
   (`ebay-shared-image-publish.service.ts:20-21`), are stamped `PUBLISHED` with a `publishedAt`.
7. 🔴 **`DRAFT` renders as "queued" in the studio grid.** CODE-READ, `EbayGrid.tsx:89-90`:
   `isPublished ? 'live' : 'ERROR' ? 'failed' : 'queued'`. `bulk-save` writes `DRAFT`
   (`images-workspace.routes.ts:478`), so every freshly placed photo claims to be queued — and there is
   no eBay image queue (the schedule cron is default-OFF with zero rows, inventory §7 D4). `OUTDATED`
   collapses into the same lie.
8. 🔴 **The studio's only eBay publish call reports an outcome it cannot know.**
   `CrossChannelPlanner.tsx:98-113` posts `{}` (no `activeAxis`, so the server silently falls back to the
   global preference) and then branches on `res.data?.dryRun`, a field `EbayInventoryPublishResult`
   (`:50-71`) does not have — so a call that DID contact live eBay logs *"Completed, but the server did
   not say whether it was submitted."*
9. 🔴 **eBay outcomes cannot be joined to their jobs.** Recorded as a hub finding from the audit
   measurement: eBay writes outcomes and never a start, and its 24 outcome rows carry no job reference.
   Confirmed by reading — `channel-image-publish.routes.ts:73-82` and `:86-91` build the audit metadata
   from `pictureCount`/`colorSetCount` and omit `result.jobId`, which is right there on the result.
   MEASURED-IN-DOC + CODE-READ.
10. ⚠ **The eBay live strip is structurally empty for the families this publisher serves.** CODE-READ.
    `ebay-live-images.service.ts:139-158` needs `ebayItemId` (or memberships); Inventory-listed families
    have neither, which is the stated reason `publishEbayImagesViaInventory` exists at all. So drift
    detection — the only independent check on "are the right pictures live?" — is unavailable exactly
    where it is most needed. The post-publish parity assertion (§3) is the one thing that does cover it,
    and it lives inside the publish call rather than on a surface.
11. ⚠ **Two caps, and the client-side one is wrong.** `PLATFORM_RULES.EBAY.maxImages = 24`
    (`packages/shared/image-validation.ts:58-62`, correctly annotated as the fixed-price gallery max) is
    what `ChannelValidationBanner.tsx:142` would show, while the enforced ceiling on this path is 12.
    Moot today only because the banner is never mounted on eBay (§2).
12. ⚠ **Doc drift, three places.** `docs/…pes7-images-inventory.md` §2.3 states "publish de-dupes
    per-colour against Default as a safety net" — deleted 2026-07-27 and the reason is in
    `ebay-gallery-verbatim.pure.ts:9-24`; the same clause survives as a stale comment on
    `ebay-variation-push.service.ts:767-770` ("The caller de-dupes … so nothing shows twice"); and §2.5
    grades four eBay surfaces REAL that have no eBay importer.
13. **No optimistic concurrency on the store.** `bulk-save` has no `expectedVersion`
    (`images-workspace.routes.ts:425-496`) and the old panel's flush deletes *every* eBay row for the
    axis and rewrites it (`EbayPanel.tsx:383-385`) — two operators on one product silently last-write-wins.
14. **Old-UI weight:** `EbayPanel.tsx` 607 L, `tabs/ImagesTab.tsx` 1019 L, `MasterPanel.tsx` 1492 L;
    `tabs/images/**` totals 11 221 L. The panel re-derives `baseline` from `listingImages` on every
    change and copies it into state (`:223-226`), so a workspace reload discards in-flight edits.
15. **HYPOTHESIS (not measured):** the workspace GET is one query per product with the whole
    `listing` set; the studio's own comment measures **~6 s on a 24-image product**
    (`_studio/images/ImagesTab.tsx:66-67`). eBay needs only its own platform rows.

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors

**PRIMARY — H8, the Images tab, eBay channel scope: the bucket × position grid** (as built, ruling
#125/#447). This is the direct answer to the Owner's question. A photo's identity here is
*(bucket, position)*, not *(row, field)*: the Default row is not a product row, the columns are an
ORDER rather than named attributes, and the operator's gesture is "move this picture from Default into
Nero at position 1". Nothing about that projects onto the channel sheet's row model, and eBay declares
no image property to make a column from — AM.1 §5 acceptance 1 fixes eBay·IT at "20 aspects + 7
channel-wide". §A.3a's rule ("every property the channel declares is a column") therefore *produces zero
eBay image columns* by its own construction, unlike Amazon's 22 locators. eBay images are not an
exclusion; they are simply not declared properties. So the grid stays on H8 and the sheet gets a
DERIVED column instead.

**MIRROR 1 — H1, ONE new cell on the eBay alias band: `imageAxis`.** This is the other half of the
Owner's question, and it splits cleanly: **the AXIS is a cell, the PHOTOS are the images section.** The
axis is a stored per-market listing attribute (`ChannelListing.platformAttributes._imageAxis`), single-
valued, chosen from the family's real axes plus `__shared__` — exactly a `scalar` cell with an enum
editor under AM.1's shape vocabulary, and exactly the store the description renderer and flat file
already read. Putting it there kills defects 4 and 5 in one move: one store, per market, on the band,
with the Images tab READING it instead of holding its own copy. The old "Vary by" menu becomes a cell
and the second source of truth disappears.

**MIRROR 2 — H2, a derived read-only status column on the eBay channel sheet: `ebayPhotos`.** The sheet
must be able to answer "does this listing have its pictures?" without changing tab. It cannot today:
the identity band's thumbnail and count come from `photoCount: ownImages.length`
(`studio-sheet.service.ts:1255`) — the **master** ProductImage count — so on eBay·IT a row can show "24"
while its eBay buckets are empty. See 6.2.

**MIRROR 3 — H5, `CONTEXT(alias-group)` verb `publish-ebay-images`, preflight-first.** Publish targets a
LISTING, not a row: `publishEbayImagesViaInventory` keys on a productId and dispatches per `productType`
(family → Inventory group; `EBAY_LISTING_SHELL` → Trading revise). The alias band IS that unit. Row and
selection scopes are wrong here and must not be offered — publishing "these 3 SKUs' images" is not a
thing eBay accepts. Mirrored, per registry rule, on the band's ⋯ and the drawer's actions, and listed in
the header **H10 `Publish ▾`** as *eBay · images* alongside *eBay · listing*.

**MIRROR 4 — H3 row verb `open-images`** — jumps to the Images tab with the row's axis value's bucket
focused. Navigation only, no preflight (registry treats an absent preflight as run-immediately,
`channelActions.ts:391`).

**MIRROR 5 — H7, an images section in the drawer's Listings pane** — the `ImagesCard` shape rebuilt on
DS: hero, per-bucket chips with counts, cover marked, curated-vs-live diff when a read-back exists, and
the link out. Read + navigate; per channel-ops §3.2 no verb lives only here.

**MIRROR 6 — H9, Errors & Sync** — the parity-mismatch warning (`…:383`, "LIVE DOES NOT MATCH YOUR
CURATION"), FATAL `ChannelImagePublishJob` rows, and truncation warnings, grouped by cause and jumping
back to the sheet row / the Images tab bucket. A queue must never be inline-only, and this one is
currently invisible: it exists only inside a response payload.

**MIRROR 7 — H6, SheetToolbar `trailing` on the eBay scope: "Refresh what's live on eBay"** — the read-back
verb, which must say `NO_ITEM_ID` / `API_DISABLED` in words (defect 10) rather than showing an empty strip.

**Not proposed:** H11 (nothing account-level here), H12 (nothing to drop — every old capability has a
home above; the axis menu MOVES, it is not dropped).

### 6.2 What the sheet shows at rest

| Scope | At rest |
|---|---|
| **master** | unchanged — identity band thumbnail + `photoCount` (its own truth), `imageInherited` → `ProvenanceMark` |
| **eBay · IT, alias band row** | `imageAxis` **cell** (H1) showing `Colore` / `Taglia` / `One shared gallery`, with `aliasOverride`/`master` provenance like any other channel cell; plus **`ebayPhotos`** (H2), a read-only derived column: `12 · 3 buckets` when covered, `⚠ no cover photos` when the Default bucket is empty, `⚠ 13 → 12` when a bucket exceeds the cap, and a **drift mark** when a read-back exists and disagrees. Tooltip names the other surface per §A.3a: *"Curated in Images · eBay. 12 photos in 3 buckets, cover set. Publish rewrites the description too."* |
| **eBay · IT, variant rows** | **nothing new.** A child SKU has no eBay picture of its own in the normal model — the bucket is keyed by the AXIS VALUE, so a per-row image column would repeat one fact across every SKU sharing a colour. The exception (`ListingImage.variationId`, per-SKU override) gets a mark on `ebayPhotos` only where a row actually has one, and the tooltip says the Trading path skips it. |
| **Amazon · any market** | untouched — Amazon's 22 declared locators are columns per §A.3a; that is a different feature (01). |
| **Shopify** | out of scope (unbuilt; ruling #125 made it conditional on measuring real rows). |

`ebayPhotos` is **not** twelve media cells. Twelve media columns on a 21-row sheet would repeat the
bucket grid badly (positions are per-bucket, not per-row), cost 12 × 100px of a sheet already carrying
every attribute, and — per #80 — a "required and empty" verdict is a MATRIX-level statement anyway. One
derived, filterable status column plus the tab is the honest split.

### 6.3 The interaction, step by step

**Editing photos (H8).** Click a cell → DS `Modal` picker (master gallery + DAM) → `place()` →
`placeInBucket` decides `move | add | refused` → ONE `bulk-save` transaction (upsert + old-home delete
together) → `reload()`. A refusal renders on the tile, never a toast. Keyboard: arrows move the focused
cell, `Enter` opens the picker, `Delete` removes with the **main-photo confirm** restored — the old
side-by-side "Removing → New main" (`EbayPanel.tsx:571-604`) rebuilt as DS `Modal` + `Thumbnail`, since
silently promoting the search thumbnail is exactly the change an operator must see. Drag between cells
and from the master strip returns via `MediaCell`'s drop contract (`mediaCellAcceptsDrop`).

**Setting the axis (H1).** Double-click the band's `imageAxis` cell → DS `Listbox` of the family's real
axes + `One shared gallery` → autosave through the one `SheetWriter` with `expectedVersion` → the Images
tab re-reads and re-buckets. `__shared__` collapses the grid to the Default row and says so.

**Publishing (H5), preflight-first, in the registry's order.**
- **COLLECT** — the band's alias, and the market from the scope chip. No picker: one alias, one market.
- **PREFLIGHT** — `GET /products/:id/ebay-images/preflight?marketplace=IT` (**new**, §7). It contacts no
  channel. It returns, per bucket: photo count, cap verdict, cover present, resolved `pictureAxis` and
  whether it came from the market or the global fallback, the markets that would receive it, per-SKU rows
  that will be skipped, **the publish mode from `getEbayPublishMode()`**, and the two side effects. It
  populates `ActionImpact`: `findings` per bucket, `consequences` = "3 buckets, 12 photos, cover set, to
  eBay IT", `sideEffects` = **"the listing's description is re-rendered and re-sent"** and **"unpublished
  draft offers on other markets may be deleted if eBay rejects the group"**, and `payload` = the
  preflight snapshot so `run` applies what was approved (ruling #118's time-of-check gap).
- **CONFIRM** — `ActionConfirm` at the level the preflight returned, never a fixed flag. With the gate
  closed the verb is **`unavailable`** with the server's sentence, exactly as `AliasPublishControl`
  reads `notSendable` today.
- **RUN** — `POST /ebay-images/publish` with `{ activeAxis, expectedSnapshot }`. Repaint:
  `invalidation: 'page'` (the channel sheet has no row refetch — ruling #114), the Images tab's buckets,
  the publish record, and any parity warning straight into H9.

**With the drawer open** the sheet stays live (layout-v2 §5), so all of this works from either side; the
Images tab is a tab, not a modal, so opening it replaces the sheet rather than overlaying it.

**DS components:** `NexusGrid` + `MediaCell`/`MediaCellView` + `MEDIA_MATRIX_GRID_OPTIONS` (grid);
`Modal`, `Thumbnail`, `FileDropzone`, `Listbox`, `Button` (picker/confirm/axis); `Banner` (validation,
stale, gate); `Pill`/`Badge` (bucket counts, cap, live/failed); `ActionConfirm` + `useActionPress`
(verbs); `Card`/`KeyValue` (drawer pane); `EmptyState` (no buckets). **No new DS component is needed.**

### 6.4 Per-scope rules

- **master** — no eBay concepts. The master gallery is the source the buckets draw from; a master delete
  that is referenced by an eBay bucket must warn, not cascade.
- **eBay channel scope** — the buckets are **PLATFORM-scoped, `marketplace: null`** (§3). So switching
  the market chip from IT to DE **does not change a single photo**, while it *does* change the axis
  (`_imageAxis` is per market). That asymmetry must be stated on screen: the grid header says *"one
  picture set for every eBay market · the axis is per market"*. Anything else lets an operator believe
  they are curating DE.
- **alias band** — each alias is a separate live listing with its own pictures, and its pictures live
  under **its own productId** (the shell product), because `ListingImage` has no `aliasId`. The Images
  tab today takes its productId from the route (`ImagesTabRoute.tsx:19-21`), so **a shell's pictures are
  unreachable from the family's Images tab**. The tab needs an alias selector reading the band's
  productId (§9 Q2). Six ACTIVE + 16 DRAFT shells exist on prod, all eBay·IT
  (`_studio/sheet/channel/types.ts:11-17`), and a DRAFT shell is still LIVE (`reference_ebay_draft_still_live`).
- **single-store channels (Shopify)** — no axis, no market, a pool + assignment; nothing here transfers
  beyond the media substrate.
- **Amazon** — declared locators → columns; per-market rows; a different feature.

### 6.5 Provenance / autosave / readiness / publish

- **Provenance.** `EbayGrid` correctly sets `provenance: 'own'` on every tile (`:85-87`) — eBay's model
  is one-bucket-per-photo, not a cascade, so `inherited` is meaningless *inside* the grid. The `imageAxis`
  cell is a normal channel cell and takes the normal vocabulary (`master` 🔗 / `alias` ✎ / `aliasVariant` ✎).
- **Autosave.** Photo placement already autosaves per edit through `write()` → `useSaveReporter()`, so
  the header's one autosave indicator speaks for image work. The `imageAxis` cell goes through the ONE
  `SheetWriter` with `expectedVersion`. `bulk-save` needs the same guard (§7). The old panel's
  Save/Discard/dirty-count controller (`EbayController`) is **correctly dropped** under per-cell autosave
  — the capability it protected (a reviewable batch) is now the publish preflight.
- **Readiness.** One server definition (`services/pim/readiness.service.ts`) must gain an eBay image
  rule so the scope chip's ⚠ can be caused by "no cover photo". Today it cannot: nothing about eBay
  buckets reaches readiness, so a listing with zero pictures shows a clean chip.
- **Publish.** `POST /api/products/sheet/publish-preview` covers no image issues
  (`sheet-publish.service.ts` — zero `image` matches) and its eBay refusal is specifically about the
  **offer** route ("updates an existing offer and has no dry run", `:126-141`). The IMAGE route is a
  separate, live, ungated path — so "eBay is preview-only" is true of listings and **false of images**
  today. Preflight-first for images therefore needs the new preflight endpoint *and* the mode gate; until
  the gate lands, the verb should be `unavailable` with that stated as the reason.

### 6.6 ASCII mockup — the primary surface

```
 Sheet · IMAGES · Analytics·Ads · Activity · Errors&Sync      eBay ⚠71%   Market [IT ▾]
┌───────────────────────────────────────────────────────────────────────────────────────┐
│ eBay images · 3 buckets · 16 photos · max 12 per variation      one bucket per photo  │
│ Vary by Colore (this market) · one picture set for every eBay market                  │
│ ⚠ Nero: 13 photos — eBay publishes only the first 12.                                 │
├──────────────────────┬───────┬───────┬───────┬───────┬─────┬─────┬────────────────────┤
│ Bucket               │1·cover│   2   │   3   │   4   │  5  │  6  │ …  12              │
├──────────────────────┼───────┼───────┼───────┼───────┼─────┼─────┼────────────────────┤
│ Default (cover&common│ [img]●│ [img] │ [img] │ [img] │  +  │  ·  │  ·                 │
│ Nero                 │ [img] │ [img] │ [img] │ [img] │[img]│[img]│ ⚠13                │
│ Giallo               │ [img] │ [img] │  +    │   ·   │  ·  │  ·  │  ·                 │
│ Rosso (not in the cur│  ·    │  ·    │  ·    │   ·   │  ·  │  ·  │  ·                 │
└──────────────────────┴───────┴───────┴───────┴───────┴─────┴─────┴────────────────────┘
 [Preview publish to eBay IT]   Live read-back: unavailable — no eBay ItemID for this
                                family (Inventory-listed). Parity is checked after publish.
 ── Recent ────────────────────────────────────────────────────────────────────────────
 12:04 eBay IT · DONE · 20 SKUs · Colore (3 curated)      12:04 ⚠ parity: Nero 12/13 →
```

## 7. Contracts and data

**Reused unchanged** — `GET /images-workspace` · `POST /images-workspace/bulk-save` ·
`POST /ebay-images/publish` · `GET /image-publish-jobs` + retry ·
`GET|POST /live-channel-images[/refresh]` · `POST /api/products/sheet/publish-preview` ·
`GET /api/listings/publish-readiness`.

**Server changes (PES.5, all additive)**
1. **Gate the publish** on `getEbayPublishMode()` in `channel-image-publish.routes.ts:53`, plus a caller
   `dryRun` — the `amazon-batch-feed.service.ts:240-268` shape ruling #247 named. **Owner-gated (§9 Q1).**
2. **`GET /products/:productId/ebay-images/preflight?marketplace=`** — new, contacts no channel; the
   response shape above. Mirrors `amazon-images/validate`+`/stale`+`/preview`, which is exactly the gap
   `ChannelValidationBanner`/`ChannelStaleBanner` had no server truth for.
3. **One axis source.** `publishEbayImagesViaInventory` calls `readImageAxisPreference(productId, marketplace)`
   instead of reading the global column (defect 4). Additive: the function already falls back to the column.
4. **Honest publish stamping** — stamp only the rows actually sent, from the push's own result (defect 6).
5. **`jobId` in the eBay audit metadata** at both call sites, and an `imagePublishStarted` write (defect 9).
6. **`expectedVersion` on `bulk-save`** (defect 13).
7. **Permission** — put `/ebay-images/publish` behind a publish permission, not `products:edit`
   (manifest ordering, §3). One entry above `:412`.
8. **Readiness** — an eBay image rule in `readiness.service.ts` (cover present, cap, buckets covered).
9. **Sheet contract** — `ebayPhotos` (derived, per row) and `imageAxis` (a real `ChannelFieldSpec` scalar)
   on the channel sheet payload. No schema change: `_imageAxis` already exists on `platformAttributes`.
10. **Docs** — correct inventory §2.3's dead de-dupe sentence, §2.5's four eBay grades, and the stale
    comment at `ebay-variation-push.service.ts:767-770`.

**Schema:** none required. `ListingImage.marketplace` for eBay and an `aliasId` FK would be additive and
are only needed if Q2/Q3 are answered that way.

**Lane ownership** — PES.7: the grid, axis-cell consumer, drawer images section, preflight UI, main-removal
confirm, drag. PES.3: the `imageAxis` cell, the `ebayPhotos` column, the `publish-ebay-images` context verb
on the band. PES.2: nothing new (the media substrate covers it; `MediaCell` gains no field). PES.4: the
drawer pane slot + `GalleryImage.inherited?` (ruling #125). PES.5: all of §7's server items. PES.1: the
`Publish ▾` entry. PES.6: nothing. PES.8: nothing (no AI here; lifestyle generation is master-scope and DARK).

## 8. Risks and traps

- **Every eBay listing in the fixture family is LIVE and a DRAFT shell is live too**
  (`reference_ebay_draft_still_live`). eBay has **no safe test target** — no sandbox equivalent for these
  listings, which is what makes defect 1 the headline rather than a tidiness item.
- **Local dev hits the PRODUCTION API** (`_studio/images/api.ts:9-11`), so a click in a local Images tab
  is a real eBay write. Verification writes go to the XAVIA family only, and even there a publish is real.
- **A publish does more than it says** — the description re-render (defect 2) and the cross-market offer
  DELETE (defect 3) must both be in `ActionImpact.sideEffects`; that field exists for exactly this.
- **The parity assertion is the only independent check** and it lives inside the publish call; if it
  warns, the operator has already written to eBay. Surfacing it (H9) does not make it a preflight.
- **Untouchable:** `products/ebay-flat-file/**` — it owns the listing send today and imports the shared
  `ChannelImageGrid` (`EbayFlatFileImageModal.tsx:14`), so the old grid component cannot be deleted at
  swap. Also FBA quantity and the import flows.
- **eBay images are NOT per-market** while Amazon's are per-market-and-ASIN-global; getting these two
  models the same way round on one screen is the likeliest operator error. Say it in the header.
- **AI dark** (ruling #13) — nothing here generates.
- **Cap silence** — a 13th photo is sliced with a warning that today reaches only `pushWarnings`; if the
  UI drops it, the operator believes 13 went out.

## 9. Open questions for the Owner (max 3)

1. **Close the eBay image publish gate now?** Today `POST /ebay-images/publish` reaches
   `api.ebay.com` with no `getEbayPublishMode()` check, no `NEXUS_EBAY_REAL_API` check, and only
   `products:edit` — while the studio shows an eBay gate pill that does not govern it. **Recommend YES,
   as ruling #247 recommended for the batch path:** unify onto `getEbayPublishMode()`, default-safe,
   one-way, with a caller `dryRun`. If prod depends on image publishes today, flip the mode to `live`
   explicitly rather than leaving the path ungated. This is spend/live-marketplace, so it is the Owner's.
2. **Do alias (shell) listings get their images in the studio?** `ListingImage` has no `aliasId` and the
   Images tab reads one productId from the route, so the 6 ACTIVE + 16 DRAFT eBay·IT shells' pictures are
   unreachable — and the publisher already has a Trading path built for them
   (`ebay-shared-image-publish.service.ts`). **Recommend:** the Images tab gains an alias selector that
   uses the band's productId (no schema change, reuses the existing dispatch), rather than an `aliasId`
   column on `ListingImage`.
3. **Do eBay images stay one set for every eBay market?** They are `marketplace: null` today while the
   picture AXIS is per market — so IT and DE share photos but can vary by different aspects.
   **Recommend:** keep them platform-wide and **say so on the grid header**, since eBay is IT-only in
   practice (`project_active_channels`); revisit with an additive `marketplace` on eBay `ListingImage`
   rows only if a second eBay market goes live.

## 10. Effort and dependencies

| Piece | Effort | Depends on |
|---|---|---|
| Axis control as an `imageAxis` band cell (H1) + Images tab consuming it | **M** | PES.3 channel columns; PES.5 item 3 (one axis source) |
| `ebayPhotos` derived status column (H2) | **M** | PES.5 item 9 (sheet contract) |
| `publish-ebay-images` CONTEXT verb, preflight-first (H5) + `Publish ▾` entry (H10) | **M** | **Q1 gate ruling**; PES.5 items 1–2 |
| `GET /ebay-images/preflight` | **M** | PES.5 |
| Main-photo removal confirm + drag/drop restore in `EbayGrid` | **S** | none — substrate is in place |
| Shared-gallery (`__shared__`) mode in the grid | **S** | the axis cell |
| Validation + stale + gate banners on DS `Banner`, fed by the preflight | **S** | the preflight endpoint |
| Drawer images section (H7) | **S** | PES.4 pane slot + `GalleryImage.inherited?` |
| Parity/failure queue rows in Errors & Sync (H9) | **M** | PES.5 items 4–5 (honest stamping, `jobId`) |
| "Refresh what's live" scope verb (H6) with honest `NO_ITEM_ID` | **S** | none |
| Alias selector for shell listings | **M** | **Q2** |
| Readiness rule for eBay images | **S** | PES.5 item 8 |
| Server hardening: gate, axis, stamping, `jobId`, `expectedVersion`, permission | **M** | Q1 for the gate only |

Cross-feature dependencies: **01 Amazon images** shares the media substrate and the publish-record /
planner / schedule surfaces — build those once (#447: mount the per-scope grid directly, never a second
host). **eBay description** shares `_imageAxis` and is re-sent by an image publish, so its lane and this
one must agree on the axis read (defect 4) — producer and consumer land together.
