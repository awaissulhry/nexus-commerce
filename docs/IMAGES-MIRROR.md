# Nexus → Amazon Image Mirror

Make **Nexus the authoritative hub** for Amazon product images: on publish,
Amazon mirrors Nexus **exactly** — same images, same order, same count, across
all configured EU markets, with **deletions propagating**. Includes the
**PS01–06 product-safety (GPSR)** slots and uncaps the additional-image slots
beyond PT08.

## Model
- **Master gallery** (`ProductImage`) is the source of truth for a product's
  images.
- **Per-channel assignments** (`ListingImage`, `platform=AMAZON`) map images to
  Amazon slots (`amazonSlot`), optionally per marketplace / per variant.
- **Live read-replica** (`ChannelLiveImage`) caches what Amazon currently shows
  (from `getListingsItem`), used for drift + reconcile.

## Slots (schema-driven)
`amazon-slot-taxonomy.service.ts` discovers the real image-locator attributes
per `(marketplace, productType)` from the cached product-type schema:
`main_product_image_locator`→**MAIN**, `other_product_image_locator_N`→**PT{N}**
(real count — not capped at 8), `swatch_product_image_locator`→**SWCH**,
`image_locator_ps01..ps06`→**PS01..PS06** (product-safety / GPSR; each tagged
`writable`). Falls back to the legacy 10 slots when the schema is unavailable.
Verified live (IT/DE OUTERWEAR): MAIN + PT01–08 + PS01–06 + SWCH, all writable.

Inspect: `GET /admin/amazon-slot-taxonomy?marketplace=IT&productType=OUTERWEAR`.

## Operating flow
1. **Adopt-first (lossless)** — `POST /api/products/:id/amazon-images/adopt`
   pulls every live Amazon image (all EU markets, all slots) into a per-market
   `ListingImage` baseline, gap-only (never clobbers your edits). Run once before
   relying on exact-mirror so nothing on Amazon is lost. Reconcile diff:
   `GET …/amazon-images/reconcile?marketplaces=IT,DE`.
2. **Fill from gallery** — `POST …/amazon-images/fill-from-gallery` maps the
   master gallery → slots (MAIN + PT in order) as product-level Amazon
   assignments, so the mirror publishes the gallery to every variant + market.
   `{dryRun:true}` returns the plan; `{overwrite:true}` rewires.
3. **Preview** — `GET …/amazon-images/mirror-diff?marketplace=IT` shows exactly
   what a publish would do per ASIN: **adds / replaces / deletes** (only real
   removals) / unchanged, plus **skipped** (ASINs with no MAIN, left untouched).
4. **Publish (exact-mirror)** — `POST …/amazon-images/publish` `{marketplace}`.
   Sends `op:replace` for filled slots **and `op:delete` for empty ones** so
   Amazon matches Nexus exactly. Accepts any configured EU marketplace.

## Safety (layered)
- **skip-no-MAIN** — an ASIN with no resolved MAIN is skipped, **never wiped**.
- **MAIN never deleted** — hard guard in the feed builder (throws).
- **adopt-first** — captures pre-existing Amazon images before any delete.
- **mirror-diff preview** — see deletions before publishing.
- **additive-first** — if the listing has no seller image attributes yet (common),
  the first publish only adds; deletions fire only once Nexus is the source.
- **kill-switch** — `NEXUS_AMAZON_IMAGE_MIRROR_ENABLED=0` reverts to additive
  (no deletes). `NEXUS_AMAZON_BATCH_DRYRUN=1` builds feeds without submitting.

## Order & count
`computeExactMirror` (in `amazon-exact-mirror.ts`) compacts the PT and PS
families to contiguous indices in the master `sortOrder`, then deletes every
writable taxonomy slot Nexus doesn't fill — so Amazon's order and count match
Nexus precisely.

## Key files
- `services/images/amazon-slot-taxonomy.service.ts` — slot discovery (M1)
- `services/images/amazon-adopt.service.ts` — adopt + reconcile (M2)
- `services/images/amazon-exact-mirror.ts` — pure mirror plan (M3)
- `services/channel-batch/amazon-batch-feed.service.ts` — op:delete + MAIN guard (M3)
- `services/images/amazon-image-feed.service.ts` — resolve (child Products + ProductVariation) + submit (M3/M3.1)
- `services/images/amazon-mirror-diff.service.ts` — preview (M4)
- `services/images/amazon-fill-gallery.service.ts` — gallery → slots (M6)
- `routes/images/amazon-images.routes.ts` — adopt/reconcile/mirror-diff/fill/publish
- HARD CONSTRAINT: `/products/amazon-flat-file` is untouched throughout.

## Cross-market copy (CM-series)
Replicate one Amazon market's images onto others quickly, **staged** (then publish via Mirror):
- **Copy this market → markets** — in the Amazon Mirror panel (active market only). Copies all slots.
- **Copy selected images → markets** — in **Select** mode, tick individual images (or use the row / column / all checkboxes) and copy them to the **same cell** (group + slot) in the targets — the "certain image at a certain place" case.
- Targets = other Amazon markets and/or **"All Markets (shared)"** (writes PLATFORM scope → applies everywhere).
- **Edit once for all** — the "All Markets" tab edits PLATFORM scope, applying to every market unless a market overrides.

Mechanics (frontend, no backend change): `buildCrossMarketUpserts`
(`amazon/crossMarketCopy.ts`) reads the source market's effective cells via
`resolveCell`, then stages `addPendingUpsert`s; `bulk-save` upserts by
(productId, variationId, scope, platform, marketplace, amazonSlot) so a copy
**replaces the target's same slot in place** (no duplicate). Copy stages as
DRAFT → operator Saves → Mirror to Amazon.

## Bulk editing (BE-series)
A **Select** toggle (off by default) turns the matrix into a bulk editor:
- **Select** at four levels — per image (cell), whole **row**, whole **column**, **all** — on every market incl. "All Markets".
- One **action bar**: **Copy → markets**, **Set as MAIN** (single), **Fill from gallery** (empty slots), **Lock / Unlock**, **Reset to shared** (revert a market override), **Delete**. Quick-selects: *empties*, *all*.
- **Delete** only removes images the current scope OWNS (a market's own override, or the shared row on All Markets); inherited + locked cells are skipped; the confirm spells out the effect. Staged → Save → Publish removes from Amazon.
- **Lock** (`ListingImage.locked`, server-persisted) protects an image: it shows a padlock badge, is skipped by Delete / Reset, and won't be overwritten by Copy. `POST /images-workspace/lock {ids,locked}`. Lock does **not** affect Publish.
- Classification (which actions apply + the counts) is the pure `classifyBulk` (`amazon/bulkSelection.ts`).

## Tests
Pure verifiers (vitest): slot taxonomy (incl. PS naming + fallback), reconcile
categorization, exact-mirror plan + the wire JSON (replace/delete/MAIN-guard),
mirror-diff categorization, gallery-fill mapping, cross-market copy
(whole/per-cell, shared→PLATFORM, replace-by-id, skip-self), bulk classification
(deletable/lockable/overrides, lock-exclusion, all-markets). ~44 cases.
