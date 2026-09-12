# 13 — Amazon IMAGES matrix

## 1. What it is (operator terms)

A merchandiser who has just shot or edited photography needs to decide, per Amazon market, **which
picture sits in which Amazon image slot for which colour** — MAIN, PT01…PT08, PS01…PS06 (GPSR
safety), SWCH — and then get those pictures onto Amazon and know whether Amazon took them. The
surface is a grid: rows are colour buckets (plus a shared "all colours" row), columns are the image
slots **Amazon's own product-type schema declares for this product** (16 on GALE-JACKET/OUTERWEAR,
10 on a bare shell). Around the grid sit the operations that make it usable at catalogue scale: copy
this market's set to the other markets, copy a colour's set to other variants, lock a row so bulk
ops skip it, fill every slot from the master gallery, see what an exact-mirror publish would
*remove* from Amazon, preflight it, submit the feed, poll the feed, re-publish only the rows that
went stale, and — when the API cannot do it — export a ZIP named the way Seller Central's bulk
uploader expects so a human finishes the job. It is used by whoever owns imagery, episodically
(after a shoot, after a compliance change, after Amazon suppresses a listing), and it is the only
surface in the studio besides the sheet's publish that reaches a real marketplace.

## 2. Old UI — inventory

Entry: `tabs/images/ImagesTab.tsx` renders its own Master/Amazon/eBay/Shopify strip → `amazon/AmazonPanel.tsx`
(1,104 L) → `amazon/AmazonMatrix.tsx` (936 L) over the shared `ChannelImageGrid.tsx` (483 L), with
`useAmazonImages.ts` (551 L) as the data+publish hook and one global `ImageActionBar` (548 L)
driving Save/Discard/Publish for every channel tab.

| capability | component | round-trips |
|---|---|---|
| Market tabs `ALL/IT/DE/FR/ES/UK` + "market-specific" dot | `AmazonPanel.tsx:97` (label map) | scope=MARKETPLACE rows |
| Colour × Slot matrix, cell + column-header drop targets, keyboard nav, drag reorder | `AmazonMatrix.tsx` | staged → `bulk-save` |
| Cascade per cell (variation override > group > product) | `useAmazonImages.resolveCell` | client-side |
| Bulk cell selection + delete/clear/fill/set-MAIN/lock/upload | `bulkSelection.ts` (tested) | `bulk-save`, `/images-workspace/lock` |
| Lock / unlock | `AmazonPanel.tsx:385` → `POST /images-workspace/lock` | REAL |
| Filter bar (axis multi-select + cell status) | `MatrixFilterBar.tsx` | URL + **localStorage presets** |
| Column show/hide + reorder (MAIN pinned) | `MatrixColumnsModal.tsx`, `matrixColumnPrefs.ts` | **localStorage only** |
| Named cross-device views | `MediaViewsMenu.tsx:34,67,84` → `/api/saved-views?surface=product-media` | REAL, server |
| Slot-group completion ("Safety 6/6 ✓") | `groupCoverage.ts` (tested) | client-side |
| Copy to markets / to variants | `CopyToMarketsModal.tsx` + `crossMarketCopy.ts`; `CopyToVariantsModal.tsx` + `variantCopy.ts` | staged upserts |
| Mirror: fill-from-gallery, mirror-diff | `AmazonMirrorControls.tsx:49,69`; also `AmazonPanel.tsx:421` | `POST /fill-from-gallery`, `GET /mirror-diff` |
| Pre-publish preview (per-ASIN × per-slot) + validate | `PublishPreviewModal.tsx:115,116` | `GET /preview`, `GET /validate` |
| Publish + feed poll | `AmazonPublishBar.tsx`, `useAmazonImages.ts:421,463` | `POST /publish`, `GET /feed-status/:jobId` |
| Stale banner + "re-publish stale" (variantIds-filtered) | `StaleBanner.tsx:50,70` | `GET /stale`, `POST /publish` |
| Export ZIP + manifest preview | `AmazonPanel.tsx:226,258`, `ExportPreviewModal.tsx:51` | `POST /export-zip`, `GET /export-zip/manifest` |
| Live strip + drift + adopt-to-master | `LiveChannelStrip.tsx:141`, `LiveImageDriftModal.tsx` | `POST /live-channel-images/refresh` |

**The export "guided flow" already half-existed.** `AmazonPanel.tsx:247-284` loops the five markets
client-side, calls `export-zip` per market and **re-zips the results in the browser** into
`amazon-all-markets-<date>.zip` — "ONE download containing a ready-to-upload ZIP per market"
(its own comment, `:247`). That is precisely the Country-Specific-Upload operator flow ruling #8
asks for, built before the ruling and never named as such. The market list is hardcoded at `:251`.

**Browser-local (documented as intentional, inventory §2.6):** matrix column layout, filter presets,
rollback snapshots (`publishSnapshotStorage.ts`), approval queue (`approvalPrefs.ts`), auto-publish
(`autoPublishPrefs.ts`).

**Nothing here is DEAD** — every listed component has an importer via `ImagesTab`/`AmazonPanel`.

## 3. Backend that exists

Routes — `apps/api/src/routes/images/amazon-images.routes.ts` (all under `/api`):

| method + path | line | notes |
|---|---|---|
| `POST /products/:id/amazon-images/publish` | `:54` | validator gate; refuses **only when every ASIN is blocked** (`:85-98`), else publishes the good ones and reports `skippedAsins`. `?force=true` skips the gate. Audit row records `result.dryRun` **and** `requestedDryRun` (`:137-141`) |
| `POST …/adopt` | `:164` | lossless pull of live Amazon images into a per-market baseline |
| `GET …/reconcile` | `:196` | |
| `GET …/mirror-diff` | `:220` | |
| `GET …/debug-live/:sku` | `:242` | TEMP read-only probe still mounted in prod |
| `POST …/fill-from-gallery` | `:292` | `{dryRun}` returns the plan, `{overwrite}` rewires |
| `GET …/validate` | `:316` | `{hardFails, softWarnings, blockedAsins, summary}` |
| `GET …/feed-status/:jobId` | `:346` | polls Amazon, writes `publishStatus` back |
| `GET …/preview` | `:367` | per-ASIN × per-slot resolved plan |
| `GET …/stale` | `:402` | |
| `POST …/export-zip` | `:429` | streams ZIP; counts in `X-File-Count` / `X-Skipped-No-Asin` / `X-Errors` |
| `GET …/export-zip/manifest` | `:487` | per-market coverage without downloading bytes |
| `GET …/jobs` | `:509` | recent `AmazonImageFeedJob` |

`images-workspace.routes.ts`: `GET …/images-workspace` (`:84`, the one payload — includes
`resolvedAxes`, `axisValueCounts`, `resolvedAxisSuppressed`, `amazonSlotTaxonomy` **and**
`amazonSlotTaxonomySource`), `PATCH …/axis` (`:401`), `POST …/bulk-save` (`:425`),
`POST …/copy-scope` (`:499`), `POST …/lock` (`:588`).

Services: `amazon-image-feed.service.ts` (735 L — `resolveAmazonImages` **6-level cascade**:
variation+MARKETPLACE → variation+PLATFORM → variation+GLOBAL → product+MARKETPLACE →
product+PLATFORM → product+GLOBAL, header `:14-22`; `submitAmazonImageFeed`; `pollAndUpdateFeedJob`),
`amazon-exact-mirror.ts` (`computeExactMirror`), `amazon-slot-taxonomy.service.ts`,
`amazon-image-zip.service.ts` (328 L), `amazon-image-preview.service.ts`,
`amazon-publish-validator.service.ts`, `amazon-stale.service.ts`, `amazon-adopt.service.ts`,
`amazon-mirror-diff.service.ts`, `amazon-fill-gallery.service.ts`.

Prisma: `ListingImage` (`scope GLOBAL|PLATFORM|MARKETPLACE` + `platform` + `marketplace`,
`amazonSlot`, `variantGroupKey/Value`, `variationId`, `altOverride`, `publishStatus/publishedAt/publishError`,
`locked`, `mediaType/posterUrl/durationSec`, `sourceProductImageId`), `AmazonImageFeedJob`,
`ChannelLiveImage` (unique on `productId, channel, marketplace, externalSku, slot`),
`ScheduledImagePublish`, `ChannelListingImage` (a **second, unrelated** image table keyed to
`ChannelListing` — not what the matrix uses).

Safety gates (all server-side, `docs/IMAGES-MIRROR.md`): `getAmazonPublishMode()`
(`amazon-publish-gate.service.ts:45` — `gated` unless `NEXUS_ENABLE_AMAZON_PUBLISH`, then
`AMAZON_PUBLISH_MODE` dry-run|sandbox|live, default-safe), `NEXUS_AMAZON_IMAGE_MIRROR_ENABLED=0`
→ additive (no deletes), `NEXUS_AMAZON_BATCH_DRYRUN=1`, skip-no-MAIN, "MAIN never deleted" hard
throw in the feed builder, adopt-first, mirror-diff preview. Caller-level rehearsal now works:
`AmazonBatchSubmission.dryRun` (`amazon-batch-feed.service.ts:95`) with the one-way guard at `:256`.

Jobs/crons: the scheduled-image-publish cron is **disabled in prod and the table holds zero rows**
(ruling #4, inventory §7 D4).

Permissions (`permissions-manifest.ts`, first-match-wins): `:380` `P(F.productsImagesEdit, has('/images'))`
matches `/images-workspace/…` (substring `/images` present) but **not** `/amazon-images/…` or
`/live-channel-images/…` — the character before `images` there is `-`. Those fall through to `:412`
`RW(productsView, productsEdit, pfx('/api/products'))`. Net effect: **staging an image into a cell
needs the narrow `products.images.edit`; submitting the feed to Amazon needs only `products.edit`** —
the stricter permission guards the safer act.

## 4. Studio today

Built at `_studio/images/channel/amazon/` — `AmazonMatrix.tsx` (309 L), `matrixModel.ts`,
`cascade.ts`, `edits.ts`, `useMatrixEdits.ts`, `useTileDrag.ts`, `SlotPicker.tsx`,
`BulkApplyModal.tsx` + `bulkApply.ts`, `ChannelTruthPanel.tsx` + `channelTruth.ts` + `mirrorPlan.ts`,
`PublishPanel.tsx` + `publishPlan.ts` + `usePublishGate.ts` — plus the tab-level
`plan/CrossChannelPlanner.tsx` + `crossChannel.ts`, `publish/{PublishHistory,HealthCards,ScheduleSurface}`,
`local/LocalPublishSettings.tsx`. Spine: `useImageWorkspace.ts` (one `GET /images-workspace`, writes
reported through `useSaveReporter()`); market comes from `useStudioScope()` so **the tab has no
channel or market strip of its own** (`ImagesTab.tsx:6-13`).

Substrate conditions from ruling **#12** are met by construction (`AmazonMatrix.tsx:10-16`): the
picture is the cell **value** (`valueGetter` → `MatrixCellValue`, `:168-178`), handlers arrive
through `MediaCellProvider` (`:143-148`, `:254`), `MEDIA_MATRIX_GRID_OPTIONS` turns `cellSelection`
off (`:261`). DS pieces: `MediaCell` / `MediaCellView.tsx` / `mediaCell.ts` (state precedence and its
one known consequence documented at `mediaCell.ts:67-82`).

Ruling **#8** (D1 overridden) is honoured in shape: the per-market model stays, and the mechanism
advisory exists — `AmazonMatrix.tsx:214-216` renders `"IT · via SP-API (global to the ASIN)"` with
the FAQ citation in the title, and `crossChannel.ts:111-124` (`mechanismNote`) + `:127-133`
(`collisionSentence`) tell the operator that selecting DE+ES+IT writes **one** destination and
"whichever finishes last is what Amazon keeps".

Parity rows 5.38–5.52: **every Status cell is EMPTY** in `docs/pes-parity-audit.md:332-346` — area 5
is assigned to "PES.7 (AFTER their P3–P8 build)" (`:38`) and was never filled in. The authoritative
substitute is the lane's own §30.1 audit (`docs/2026-09-01-pes7-images-inventory.md:1712-1748`).

**Not rebuilt (from §30.1, re-verified against the studio tree by grep):**

| row | capability | studio state |
|---|---|---|
| 5.38 | market tabs / "All markets" + per-market dot | 🕳 one market at a time from the scope bar; no cross-market overview |
| 5.40 | column show/hide + reorder | 🕳 (`columnDefs` fixed, `resizable:false`) |
| 5.41 | named server views (`saved-views`) | 🕳 |
| 5.42 | filter/group bar | 🕳 |
| 5.43 | bulk cell selection | 🔁 replaced by `BulkApplyModal` (one picture → chosen rows×slots) |
| 5.44 | copy to markets | 🕳 — and `POST /images-workspace/copy-scope` (`:499`) has **no caller in either UI** |
| 5.45 | copy to variants | 🕳 |
| 5.46 | lock / unlock | 🕳 write path unreachable; `locked` is only *read* (`bulkApply.ts:49`, `matrixModel.ts:142`) |
| 5.47 | fill-from-gallery | 🕳 (no `/fill-from-gallery` call anywhere in `_studio`) |
| 5.47 | mirror-diff | ✅ read-only in `ChannelTruthPanel.tsx:55`, with totals **withheld** when the live cache is empty (§17) |
| 5.48 | publish | ✅ `PublishPanel` |
| 5.48 | feed-status poll UI | 🕳 (no `/feed-status` call in `_studio`) |
| 5.49 | validate | ✅ | 
| 5.49 | per-ASIN × per-slot **preview** table | 🕳 (`/amazon-images/preview` never called) |
| 5.50 | stale count | ✅ shown; **action correctly withheld** because the endpoint names zero targets (`channelTruth.ts` / §15) |
| 5.51 | Export ZIP + manifest | 🕳 |
| 5.52 | live strip + refresh | ✅ `ChannelTruthPanel.tsx:54,72`; **adopt-to-master** 🕳 |
| — | slot-group completion ("Safety 6/6 ✓") | 🕳 |

Also missing across the tab: retry-a-job, browser notifications, cross-channel quick-sync strip, and
sort/filter on the publish-history/audit/jobs/schedule lists (§30.2 records that last one as "a real
gap, not a judgement call").

## 5. Defects and slowness

1. 🔴 **A matrix drop onto an owned cell silently nulls that row's `altOverride`, dimensions, mime
   and white-background verdict.** `bulk-save` builds one full `data` object and, given `u.id`, calls
   `update` with it (`images-workspace.routes.ts:481-483`); the object sets
   `altOverride: u.altOverride ?? null`, `width/height/fileSize/mimeType/hasWhiteBackground: … ?? null`
   (`:466-476`). `placeImage` never sends any of them (`edits.ts:73-83`). So IE.6 per-variant alt text
   is destroyed by a picture swap. `locked` and `mediaType` survive only because they are absent from
   `data`. **CODE-READ.**
2. 🔴 **The same update nulls `variationId`** (`:459`), and the studio cascade cannot see it: `CascadeRow`
   is a `Pick` that omits `variationId` (`cascade.ts:59-65`) and `amazonRows` filters on platform only
   (`matrixModel.ts:167`). The server resolves **six** levels, three of them variation-scoped
   (`amazon-image-feed.service.ts:14-22`); the matrix models three. So on a family with any
   variation-scoped Amazon row, the surface's stated contract — "what the matrix shows is what a
   publish would send" (`AmazonMatrix.tsx:8`) — does not hold, and an innocent drop widens a
   one-variation image to the whole bucket. **CODE-READ** for the mechanism; whether GALE-JACKET has
   such rows today is **HYPOTHESIS** (unmeasured — no DB reads).
3. 🔴 **`PublishPanel`'s dry-run checkbox is disabled on a premise that its own lane fixed.**
   `PublishPanel.tsx:139-153` disables the control because "the endpoint cannot honour it", and
   `:75-80` states `submitAmazonImageFeed` "never forwards it (`...(dryRun ? {} : {})`)". That was true
   and is not: `amazon-image-feed.service.ts:398-408` now forwards `dryRun,` and
   `amazon-batch-feed.service.ts:95,256` accept and honour it one-way (inventory §28, mutation-proven).
   Under the 100%-honest-UI rule this is a live inaccuracy in the rebuilt surface, and it removes a
   rehearsal the operator is entitled to once the gate opens. **CODE-READ.**
4. 🔴 **`bulk-save` has no optimistic concurrency.** No `expectedVersion`, no `If-Match`, no version
   column read — unlike the sheet's single `SheetWriter`. Two operators, or an images edit racing a
   sheet edit on the same `ListingImage`, clobber silently. **CODE-READ.**
5. 🔴 **Export-ZIP is narrower than publish by six markets.** `export-zip` validates against
   `VALID_MARKETPLACES = {IT,DE,FR,ES,UK}` (`amazon-images.routes.ts:41,444`) and the service against
   `ALL_AMAZON_MARKETPLACES` (`amazon-image-zip.service.ts:30`), while `publish` accepts anything
   `marketplaceCodeToId` resolves (`:70-75`) — and `options.channels` declares **11 Amazon markets**
   (BE DE ES FR IE IT NL PL SE TR UK, measured, inventory §27). Export 400s on BE/IE/NL/PL/SE/TR.
   **MEASURED-IN-DOC + CODE-READ.**
6. 🔴 **`export-zip` accepts an undeclared flag.** `includePs` is destructured from the body
   (`:442`) but is not in the route's `Body` type (`:432-438`); it survives only because
   `request.body ?? ({} as any)` widens to `any` (api tsconfig is not strict). A client written from
   the type cannot know PS slots are optional. **CODE-READ.**
7. **`copy-scope` is an N+1 and has no preview.** One `findFirst` plus one `create` per source image,
   sequentially (`images-workspace.routes.ts:521-577`); at 65 rows × 5 markets that is up to ~325
   round-trips, and there is no dry-run mode to build a "would overwrite N" sentence from. **CODE-READ.**
8. **Everything below the matrix is an unfiltered stack.** `ImagesTab.tsx:170-202` renders
   `CrossChannelPlanner` + `PublishHistory` + `ScheduleSurface` + `LocalPublishSettings` on *every*
   channel scope, one under the other, newest-first with no sort or filter (§30.2). **CODE-READ.**
9. **Only the first axis is used.** `ImagesTab.tsx:141-142` passes `ws.axes[0]`; a Colour × Size
   family drops its second axis with no notice. **CODE-READ.**
10. **`GET /images-workspace` measures ~6s on a 24-image product** and the tab says so after 4s
    (`ImagesTab.tsx:66-72`) — honest, still a 6s cold open on every visit. **MEASURED-IN-DOC.**
11. **A `debug-live/:sku` probe route is mounted in production** (`amazon-images.routes.ts:242`).
    **CODE-READ.**
12. **`ListingImage.locked`'s own schema comment says it does not gate publish** ("A UI safety only;
    does NOT affect Publish (the mirror still publishes everything)"). A row an operator locks is
    still mirrored — including its deletion. **CODE-READ.**
13. **Data facts, still standing** (§12, §15, re-confirmed after two retractions in §16/§21): 16 of
    65 Amazon rows on GALE-JACKET hold no `url` and no `sourceProductImageId`, one of them a shared
    MAIN marked `PUBLISHED`; `stale` reports 23 rows and names **zero** targets; the live read-back
    cache is empty, so drift is "not checked", never "no drift". The 18-of-20-missing-MAIN claim is
    **RETRACTED** (§16) — do not carry it forward. **MEASURED-IN-DOC.**

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors

**Primary: H8 — the Images tab.** Nothing else can host a colour × slot matrix. The substrate
question was settled by measurement, not preference (ruling #12), the grid is built on it, and every
gesture the capability needs — drop a file on a cell, drag a tile between cells, fill a column from a
header — is a two-dimensional media gesture that the attribute sheet has no vocabulary for. Keep it
here, and finish it here.

**Mirror A: H2 — a *derived* image column group on the Amazon channel sheet.** Ruling A.3a
(`docs/2026-09-04-channel-attribute-model-design.md:161-170`, approved 2026-09-05) says every
schema property is a column, image locators included, and that where another surface owns the value
**the column reads and writes the same store that surface uses**. Today that clause is unimplemented
and the drift is already loaded: `channel-specs/amazon.ts` walks
`image_locator_ps01.media_location` into a scalar leaf by design (`:176-186`), `AMAZON_MASTER_LINKS`
has four entries and none is an image (`:45-50`), so each locator gets `store: undefined`
(`sheet-columns.service.ts:665`) and `writeField: attr_<key>` (`:469`) — the `overrideData` bag,
which no image reader reads. Worse, readiness is **column-derived** (`readiness.service.ts:143-147,
220`), so `main_product_image_locator` being schema-required would paint "Main Product Image Locator
is required by Amazon · IT" on all 21 GALE rows while the pictures sit in `ListingImage` — the exact
false-required defect the design doc measured for `bullet_point` (`:38-44`), reproduced for images.
So: the locators must be **read-only, ListingImage-backed status columns**, not editable text cells.
**HYPOTHESIS** that `main_product_image_locator` is in the cached schema's root `required` — needs
one DB read to confirm; the mechanism holds either way for the `requiredIfRelevant` case.

**Mirror B: H5 — `CONTEXT(alias-group)` verbs on the alias band.** An alias *is* one (channel,
market, listing family), which is exactly the scope an image feed submits and exactly the scope
`export-zip` produces a folder for. Two verbs: `publish-images` and `export-image-files`. Both open
the H8 surface pre-scoped rather than sending — a verb must never live only in the drawer, and this
one must never send from two places.

**Mirror C: H10 — the header `Publish ▾` gets images as a *named destination*, not a second send.**
Yes, it belongs there, and for a specific reason: images ride a **different feed** from fields
(`POST /amazon-images/publish` vs `POST /products/sheet/publish-preview` → the sheet's path), so an
operator reading one "what can I send?" list must see both or they will believe one publish covered
both. `PublishMenu.tsx` is entirely disabled today (`:67`) and says why (`:31-32`); the DS `Menu` has
no submenus, so it must be two flat items per coordinate — `Amazon · IT — fields & attributes` and
`Amazon · IT — images (N slots · M blocked)`. The images item routes to the Images tab's publish
panel. It must not become a third publish path.

**Mirror D: H9 — the queue half moves to Errors & Sync.** FATAL feed jobs, stale rows and drift are
queue-shaped, grouped by cause, spanning many rows — and today they are inline-only lists with no
sort or filter, which §30.2 already concedes is a gap. Keep the per-market *record* in H8; move the
*queue* to H9 with rows that jump back to the matrix cell.

### 6.2 What the sheet shows at rest

- **Master scope:** unchanged — the identity cell's thumbnail + count, from the shared
  `IdentityCell` (`cells.tsx`).
- **Amazon channel scope, per row:** the identity cell already carries the face image, `photoCount`
  and an inherited mark (`ChannelSheet.tsx:1596-1610`, `AliasBandCell.tsx:164-168`) — keep it.
  Add **one derived column group "Images"**, not 22 text cells:
  - `Images` — a **thumbnail-strip cell** (`MediaCellView` with `count`, `mediaRenditionWidth` for the
    rendition): up to four faces in slot order plus `+N`. Answering the brief's question directly: a
    strip cell, yes; 22 editable locator cells, no.
  - `MAIN` — a status mark: `●` present · `⚠ MAIN missing` · `⛔ marked live, holds no image` (the
    §12 phantom). Filterable, and the filter is what makes "show me every row Amazon would refuse"
    a one-click question.
  - `Slots` — `12/16` from the server taxonomy, tooltip breaking it down by family
    (`Gallery 8/8 · Safety 4/6 · Swatch 0/1`) — the old `groupCoverage.ts` capability, reborn as a
    column instead of a badge.
  - `Image sync` — `queued · live · stale (N) · not checked · drift (N)`, straight from
    `channelTruth.ts`'s vocabulary, never collapsed into one "out of sync" number.
  All four are **read-only** (`editableOnExisting: false`) with the tooltip naming the Images tab as
  the editor, per A.3a. The 22 raw locator columns stay available under Customise for someone who
  genuinely wants the URL, and they read `ListingImage`, not the bag.
- **eBay / Shopify scope:** the same `Images` strip + `Slots` column; eBay's slots are positions
  1–12, Shopify's a pool of 250, so the denominator differs and the column reads it from the channel
  adapter rather than assuming Amazon's.

### 6.3 The interaction, step by step

`Publish images` (H5 verb or H10 item or the tab's own button):

1. **Open** — `Publish ▾ → Amazon · IT — images`, or right-click an alias band → `Publish images`,
   or the matrix header's `Publish…`. All three land on the same `Modal`.
2. **Collect** — the alias's child SKUs on this coordinate (the band's own row set) become
   `variantIds`; from the tab it is the whole coordinate. Selection is stated in the modal title,
   never inferred.
3. **Preflight** — `GET /amazon-images/validate` **and** `GET /listings/publish-readiness` fetched
   separately and held separately, so one failure cannot hide the other's answer, and the error names
   which refused (`PublishPanel.tsx:6-15`, already built this way). Add `GET /amazon-images/preview`
   here: the per-ASIN × per-slot table is what turns "3 blocked" into a decision.
4. **Confirm** — `ActionImpact` comes from the preflight, never a fixed flag: `blockedAsins > 0` or
   `deletes > 0` (mirror) ⇒ typed confirm; everything else ⇒ single confirm. Two facts always
   separate: the operator's dry-run choice and the server's gate.
5. **Run** — `POST /amazon-images/publish` with `dryRun` **honoured** (defect 3 fixed). Outcome
   read from the *server's* `dryRun`, `undefined` reported as "the server did not say".
6. **Repaint** — the matrix's affected tiles go `queued`; the `Image sync` sheet column flips to
   `queued`; `PublishHistory` gains a row; the H9 queue gains an entry once the feed poll starts.
   Nothing ever says "published" — the verb is "queue" (test-enforced in `publishPlan.ts`).

DS: `Modal`, `Banner`, `Pill`, `Checkbox`, `Button`, `KeyValue` for the preview table header,
`DataGrid` for the per-ASIN × per-slot table, `Menu` (H10), `ActionConfirm` + `useActionPress` from
`grid/actions/`, `MediaCell`/`MediaCellView` in the matrix, `Thumbnail` in the strip cell,
`FilterBar` + `MultiSelect` for the matrix filter bar (5.42), `PreferencesModal` for column
show/hide (5.40 — the ONE Customize dialog), `Combobox` for the axis picker. **One new DS component
is needed:** a `MediaStripCell` renderer (N faces + `+N` in a text-row-height cell) — `MediaCellView`
draws one 84px tile in a media-tier row and the sheet is a text tier. It belongs in
`design-system/grid/renderers/`, PES.2's.

Keyboard: `Enter`/type on a matrix cell opens the slot picker (double-click **edits**, per layout
§5.5 — and beware the AG fill handle, a 6×6px child that swallows the double-click and fills the
column down; `scripts/check-editor-open.mjs` is the gate). `Esc` closes. Arrow keys traverse cells.
The publish modal is a `Modal`, so it takes focus; the record drawer is non-modal and the sheet
stays live behind it, so an H5 verb fired from the band works with the drawer open — but the publish
modal must not be openable *from* the drawer while it is open, or two scopes fight for one send.

### 6.4 Per-scope rules

- **Master scope:** no publish, no slots. The gallery is the source; the only channel-facing verb is
  `apply-to-children`, whose 300-variant cost is server-side and **untested** (§35).
- **Amazon channel scope:** per-market rows, per-market publish, and the mechanism sentence is
  mandatory on every publish surface (ruling #8). The cascade is
  `variation+MARKETPLACE > variation+PLATFORM > variation+GLOBAL > product+MARKETPLACE >
  product+PLATFORM > product+GLOBAL`; the studio must model all six (defect 2).
- **Alias band:** the band is the publish scope; the shared "all colours" row is a real bucket with a
  `null` value, not the absence of one (`matrixModel.ts:13`).
- **Market channels vs single-store channels:** Amazon's 11 markets share one ASIN image set on the
  SP-API path — so the honest per-market UI is per-market *rows* plus one destination warning, which
  is what `collisionSentence` already says. eBay (IT-only, positions 1–12, one bucket per photo, no
  de-dupe) and Shopify (single store, 250 pool, position 0 = featured) have genuinely per-listing
  pictures and need no such warning; `mechanismNote` already distinguishes all three
  (`crossChannel.ts:111-124`).

### 6.5 Provenance / autosave / readiness / publish

- **Provenance:** the matrix already speaks the sheet's vocabulary (`MediaCellValue.provenance` is
  `CellProvenance`, `mediaCell.ts:38-46`) — inherited · pinned · own, one definition, no fork. The
  new `Images` sheet column carries the same mark, so "inherited from master" reads identically in
  both places.
- **Autosave:** image writes report through `useSaveReporter()` (`useImageWorkspace.ts:5-9`), so the
  header's autosave state speaks for image work. It must go further: `bulk-save` needs the
  `expectedVersion` discipline the `SheetWriter` has (defect 4), and `placeImage` must send the
  fields the update would otherwise null (defect 1) — or `bulk-save` must switch to a partial merge.
  Either fix; not neither.
- **Readiness:** ONE server definition. Today it has **no image rule at all** — `readiness.service.ts`
  and `scope-readiness.service.ts` contain no image logic, so the frame's `Amazon ●92%` chip says
  nothing about a missing MAIN. Inventory §8's plan ("completeness → the frame's readiness chips")
  was never implemented on the server side, so the old tab's per-channel image completeness is
  **lost, not moved**. The rule to add is derived, not new data: `MAIN present` (error) and
  `required-family slots filled` (warning), read from the resolved `ListingImage` cascade — the same
  value the `Slots` column paints, never from the bag.
- **Publish:** mode from `getAmazonPublishMode()` via `publish-readiness`, never re-derived; `null`
  readiness is UNKNOWN and refuses to offer what it cannot describe; exact-mirror `deletes` is the
  most consequential number on the surface and is **withheld** when the live cache is empty (§17).
  All three already hold and must survive the rebuild of the missing pieces.

### 6.6 ASCII mockup

```
┌ Images ─ Amazon · IT ────────────────────────────────────────────────────────────────┐
│ 2 colore rows · 16 slots · 29 placed        IT · via SP-API (global to the ASIN) ⓘ   │
│ [View ▾][Colore ▾][Only empty][Safety] Find…  [Fill slots…][Export files…][Publish…] │
├──────────────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┬───────┤
│ Colore       │ MAIN │ PT01 │ PT02 │ PT03 │ … │ PS01 │ PS02 │ SWCH │ Safety│        │
├──────────────┼──────┼──────┼──────┼──────┼───┼──────┼──────┼──────┼───────┼────────┤
│ (all colours)│ ⛔   │ ▣    │ ▣    │ ·    │ … │ ▣    │ ·    │ ·    │ 4/6   │        │
│ Nero         │ ▣✎   │ ▣🔗  │ ▣🔗  │ ▣✎   │ … │ ▣🔗  │ ·    │ ▣    │ 4/6   │        │
│ Giallo       │ ▣✎   │ ▣    │ ·    │ ·    │ … │ ·    │ ·    │ 🔒   │ 2/6   │        │
├──────────────┴──────┴──────┴──────┴──────┴───┴──────┴──────┴──────┴───────┴────────┤
│ ⛔ 16 slots are marked published on Amazon but hold no image — they publish nothing. │
│ What Amazon has · 23 stale · not checked · [Check Amazon]                            │
└──────────────────────────────────────────────────────────────────────────────────────┘
   ▣ picture  · empty  ✎ pinned here  🔗 inherited  🔒 locked  ⛔ live but empty
```

## 7. Contracts and data

**Reused unchanged (no server work):** `GET /images-workspace`, `POST /images-workspace/bulk-save`,
`POST /images-workspace/lock`, `GET|POST /amazon-images/{validate,preview,stale,publish,feed-status,
mirror-diff,fill-from-gallery,adopt,export-zip,export-zip/manifest,jobs}`,
`GET /listings/publish-readiness`, `/api/saved-views?surface=product-media`,
`POST /live-channel-images/refresh`. Ruling #12 is right that **no new API is needed for the
matrix** — the four dropped fields are on the wire and now consumed.

**Server changes needed, all additive:**

| change | why | lane |
|---|---|---|
| `bulk-save` partial merge (or `placeImage` sends every field) + `expectedVersion` | defects 1 & 4 — data loss and no CAS | PES.5 |
| `CascadeRow` gains `variationId`; matrix models all 6 levels | defect 2 — the surface's own contract | PES.7 |
| `export-zip` + zip service accept every `marketplaceCodeToId` market; declare `includePs` in `Body` | defects 5 & 6 | PES.5 |
| `copy-scope` gains `dryRun` returning `{wouldCopy, wouldSkip, wouldOverwrite}`; batch the writes | 5.44 needs a preview, and N+1 | PES.5 |
| `ChannelFieldSpec.channelStore` gains `{kind:'listingImage', slot, market}`; image locators get `editable:false` + `readsFrom:'images'` | A.3a's "same store" clause, and it is the difference between a correct column and a false-required readiness flag | PES.6 + PES.5 |
| readiness gains `MAIN present` (error) + `required slot families` (warning) from the resolved cascade | the frame's chip currently ignores images entirely | PES.5 |
| `lock` either gates the mirror or the schema comment and the UI both say it does not | §12 / schema `ListingImage.locked` | PES.5 |
| remove `debug-live/:sku`, or gate it | a probe route in prod | PES.5 |
| `permissions-manifest.ts`: an entry for `-images` paths before `:412` | feed submission needs a narrower permission than a title edit | PES.5 |

**No schema change is required.** Every field the rebuild needs already exists on `ListingImage`.

**Lane split:** PES.7 owns the matrix, the filter bar, column prefs, named views, copy-to-markets/
variants, lock, fill-from-gallery, export flow, feed-poll UI, preview table, slot-group coverage.
PES.2 owns `MediaStripCell` and the media-tier row rules. PES.3 owns the `Images`/`MAIN`/`Slots`/
`Image sync` columns and the H5 band verbs. PES.1 owns the H10 menu items. PES.5 owns every server
row above. PES.6 owns the `ChannelFieldSpec` store kind.

## 8. Risks and traps

- **Live listings, real writes.** Local dev hits the production API and the production database; every
  image write in this family is real. Verification stays on the XAVIA test family, and no Amazon
  submission — not even a dry run — without explicit authorisation. "It would have been safe" is not
  "it was authorised" (the lane's own standard, §14).
- **`Check Amazon` spends a real SP-API call** on the live seller account even though it writes
  nothing. Treat it as an authorised action, not a free read.
- **Exact-mirror DELETES.** `computeExactMirror` deletes every writable taxonomy slot Nexus does not
  fill. With the live cache empty, `mirror-diff` returns `240 adds · 0 deletes` which is not a
  measurement of anything — the surface must keep withholding those totals (§17). The kill-switch is
  `NEXUS_AMAZON_IMAGE_MIRROR_ENABLED=0`.
- **Images are global per ASIN on the SP-API path** and the same ASIN sells in up to 11 markets.
  Every per-market surface must carry the mechanism sentence or it is telling the operator that
  choosing IT gave IT its own pictures.
- **The slot set can be falsely clean.** `resolveSlotTaxonomy`'s fallback caches for 60s (was 24h,
  fixed §19) and a fallback arrives as a perfectly good list of ten — so `slotSetSource` must always
  come from the server's word, never inferred from `taxonomy.length`. `unknown` is its own state.
- **AG traps that apply here specifically:** the fill handle swallows a double-click and fills the
  column down; a popup editor owns Enter/Tab/Esc; `position:absolute` inside a cell escapes it;
  `cellSelection` must stay off; an unregistered AG module fails silently with no console warning.
- **AI stays dark** (ruling #13): `LifestyleGenerator` is built and honest; nothing here proposes
  enabling generation.
- **Untouchable:** the Amazon flat-file editors own the `*_image_locator` grid columns
  (`flat-file.service.ts:933,1977`). The studio's image columns must not be built by touching that
  code, and must not contradict it.
- **The scheduled-publish cron is disabled and the table is empty** — a pending badge here is a
  promise nothing keeps, and the surface must keep saying so.
- **Two retractions came out of this lane** (§16, §21) from reporting a single reading of a shared
  live database as a durable property. Any number in this report sourced from one measurement is
  labelled; re-measure before acting on it.

## 9. Open questions for the Owner (3)

1. **Do the 22 Amazon image locators become editable sheet cells, or read-only status columns that
   point at the Images tab?** A.3a says "no exclusions" and "reads and writes the same store"; the
   store for images is `ListingImage`, addressed by (bucket, slot, market) — a coordinate a single
   sheet cell cannot express, since one sheet row is a SKU and one image row can cover a colour
   across every SKU. **Recommendation: read-only.** Four derived columns (`Images` strip, `MAIN`,
   `Slots`, `Image sync`) that read the resolved cascade, plus the 22 raw locators available under
   Customise as read-only URLs. Editing stays in H8. This satisfies A.3a's real requirement — the two
   surfaces can never disagree — without inventing a write path the coordinate cannot carry.
2. **Is Amazon's Country-Specific Upload automatable, or is the ZIP the answer?** (The P3 sub-study
   ruling #8 asked for, still open.) Nothing in the repo calls a country-specific API, and Amazon
   documents it as a Seller Central self-service tool. **Recommendation: treat it as
   operator-assisted.** Rebuild Export-ZIP as a guided per-market flow — the old panel already
   produced "one ready-to-upload ZIP per market" client-side (`AmazonPanel.tsx:247-284`) — fix the
   6-market gap (defect 5), and label each market's card with its mechanism (SP-API global ·
   country-specific upload · A+). Revisit if Amazon ships an API.
3. **Should `lock` block a mirror publish?** Today the schema says it does not, so an operator who
   locks a row still has that row's absence mirrored as a deletion. **Recommendation: yes — make
   `locked` skip both the replace and the delete for that (bucket, slot, market), and say so on the
   tile.** A lock that does not survive the one operation that can destroy an image is a control
   that means less than it looks like it means. If the Owner prefers to keep publish absolute, then
   the lock must be renamed on screen to "protect from bulk edits" and the mirror surface must say
   locked rows are still deleted.

## 10. Effort and dependencies

| piece | effort | depends on |
|---|---|---|
| Defects 1–4 (alt-override wipe, variationId blindness, dry-run lie, CAS) | **M** | PES.5 for `bulk-save`; blocks any further matrix write work |
| Filter bar + column prefs + named views (5.40–5.42) | **M** | DS `FilterBar`/`MultiSelect`/`PreferencesModal`; `saved-views` exists |
| Copy to markets + copy to variants (5.44–5.45) | **M** | `copy-scope` gains dry-run + batching (PES.5) |
| Lock/unlock verb (5.46) | **S** | open question 3 |
| Fill-from-gallery + mirror-diff *action* (5.47) | **S** | endpoints exist; `mirrorPlan` withholding rules already built |
| Feed-status poll UI + retry (5.48) | **S** | endpoints exist |
| Per-ASIN × per-slot preview table (5.49) | **S** | `/preview` exists, uncalled |
| Slot-group coverage + adopt-to-master (5.52) | **S** each | `/adopt` exists |
| Export-ZIP guided per-market flow (5.51) | **M** | open question 2 + defect 5 |
| `Images`/`MAIN`/`Slots`/`Image sync` sheet columns | **M** | open question 1 · `MediaStripCell` from PES.2 · `channelStore` kind from PES.6 |
| Readiness image rule | **S** (server) | PES.5; unblocks the frame's chip telling the truth about images |
| H5 band verbs + H10 menu items | **S** | action registry (PES.2), `PublishMenu` (PES.1) |
| Move the publish/stale/drift queues to H9 | **M** | Errors & Sync console owner |
| **Total** | **~L** | heaviest coupling is to PES.5 (seven server rows) and to feature 11's channel-column model |

Cross-feature dependencies: the eBay bucket grid and the Shopify pool (unbuilt) share this
substrate — build the filter bar and column prefs in the engine, not in `channel/amazon/`, or they
fork three ways. The `Images` column group is the same engine work as feature 11's channel columns
and should land in the same pass so `store` handling is written once.
