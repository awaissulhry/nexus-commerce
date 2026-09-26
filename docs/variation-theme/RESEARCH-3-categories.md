# VTR research 3 — family, categories and channel categories (read-only, 2026-09-26, code at 8a345981f)

`api/` = `apps/api/src/`, `studio/` = `apps/web/src/app/products/[id]/edit/_studio/`, `schema` = `packages/database/prisma/schema.prisma`.
VERIFIED = read in code · (doc) = plan document only · (likely) = inferred, not run.

## 1. Where each value lives, and which wins

- **Family:** `Product.familyId` → `ProductFamily` (schema:166, 553; families can have a parent family). Each row uses its own family
  else the parent's (`studio-sheet.service.ts:1219`); the column set = union of every family in the product family (:1010).
- **Internal categories:** `ProductCategory` (+ `isPrimary`, enforced by the service not the DB, schema:15609); `Category` tree with a
  closure table (schema:15533); `Category.attributes.suggestedFamilyId` read (`product-classification.ts:25`), written only by a seed.
- **Category mapping:** `CategoryChannelMapping` — one row per (category, channel, market or `*`): channel category id, browse node,
  review date (schema:19085).
- **Per listing (per market, per alias):** `ChannelListing.platformAttributes` — Amazon `productType`, eBay `categoryId`, Shopify
  `category` (gid), Etsy `taxonomy_id` (`mapping/category-mapping.service.ts:76-77`; `packages/shared/catalog-transfer.ts:6`).
- Legacy `Product.productType` (schema:141) = last Amazon fallback. Shopify's free-text "Product type" (`channel-specs/store.ts:32`) is
  not a category and drives nothing. eBay secondary/store categories: none.

**Which wins** (`category-mapping.service.ts:9-24, 67-83, 197-238`): 1 the listing's own value → 2 the primary category's mapping for
this market → 3 its `*` mapping → 4 nearest mapped ancestor → 5 other categories of the product (if they disagree: EMPTY + "Conflicting
shared categories" on every cell, `resolve-batch.service.ts:461-462`) → 6 `Product.productType` (Amazon only).
Edge cases: a variant with no categories uses its parent's (:198) but the legacy fallback reads the variant's own `productType` (:233);
a value set on the parent LISTING never reaches the child rows (`studio-sheet.service.ts:1216-1217`); unreviewed mappings are used,
only flagged.

## 2. Operations the UI offers

- **"Classification…" dialog** (⋯ on the Shared sheet, `useMasterSheetAdapter.tsx:631`): family (flat list), primary + extra categories
  (one flat dropdown of the whole tree, no search), suggested family, the primary category's direct mappings (`ClassificationDialog.tsx`).
  `GET/PATCH /products/:id/studio/classification` (`product-studio.routes.ts:359-369`): version check, locks the tree, keeps values;
  **refuses variants** (400, `product-classification.ts:41-57`). One product; no Amazon product type.
- **Shared sheet:** no family/category/product-type column (family mode drops `productType`, `sheet-columns.service.ts:1329-1331`).
- **Channel sheet category cell:** Amazon `productType` (`channel-specs/amazon.ts:76-87`), eBay `categoryId` (`ebay.ts:119`), Etsy
  `taxonomy_id` (`etsy.ts:31`) → `ChannelCategoryEditor` (`channelColumns.tsx:79-80`), local taxonomy search `assignable=1`
  (`categoryOptions.ts:8-12`). **Shopify `category` has NO picker** — plain text needing a gid (`store.ts:42`; `referenceOptions.ts:5`);
  the picker exists only in the Shopify workspace (`ShopifyNativeEditor.tsx:47-49`). Saves: `PATCH /products/bulk` (one channel+market,
  `useChannelSheet.ts:299-312`). Bulk: fill/paste inside one scope + one family (`GridSheet.tsx:111`).
- **"Broadcast to other markets…" NOT BUILT** — every path returns "Broadcast is not built" (`channelActions.ts:367-379`).
- **`/catalog/categories`:** tree create/rename/move/delete (`taxonomy.routes.ts:14-21`); channel mappings per category × channel × ONE
  market via a reviewed impact job (`TaxonomyDialog.tsx:42`; `mapping/impact.service.ts:146-160, 386-393`) — writes the exact market
  only; nothing writes `*`. The only true "bulk by taxonomy" path.
- **`/products` grid:** "Family" bulk → `POST /products/bulk-attach-family` (`BulkActionBar.tsx:925-937`; `families.routes.ts:564-640`),
  ≤500, no parent check, no version bump, no event. "Set field → Product type" = free text into the legacy column (`SetFieldModal.tsx:60`).
  **No bulk action for internal categories.**
- `POST /products/:id/categories` (`pim-categories.routes.ts:146`): one product, accepts variants, no web caller.
- **Catalog import/export:** product rows `family`, `parentSku`, `categoryIds`, `primaryCategoryId` (`catalog-transfer-plan.ts:30,
  425-436, 512-519`, variants included); listing rows: the listing category; new products must have a family (:401).
- Other: Amazon flat-file import overwrites `Product.productType` (`amazon/flat-file.service.ts:3618`); cockpit "copy layout from donor"
  copies product type / eBay category (`amazon-cockpit.routes.ts:135-138`, `ebay-cockpit.routes.ts:1770-1773`).

## 3. Limitations and inconsistencies (VERIFIED unless marked)

1. Variant classification contradicts itself: the dialog says variations inherit "unless they have their own classification", the API
   refuses variants, yet bulk-attach-family and import give variants their own family/categories — whose columns then widen the whole sheet.
2. Mixed product types in one family never checked in the studio (only the flat-file grid warns, `gridAdapter.ts:248`); columns = union
   of types; the theme reads the parent's type only (`studio-sheet.service.ts:1002-1003, 1696`).
3. Empty category: readiness error "requirements unavailable" (`studio-sheet.service.ts:1195-1197, 1575-1579`); column set
   `AMAZON:category not selected` (`sheet-columns.service.ts:1356`); eBay publish refuses (`studio-publication-ebay.ts:131-132`).
4. Changing a category: validation skipped for a category-only save, old values stay, "new errors appear on reload"
   (`information-validation.ts:44-45`); no preview, no list of values that no longer apply, no client reload of columns; Amazon publish
   silently sends only the new type's attributes (`mapping-payload.ts:55-65`).
5. Live listing: product-type edit has no lock (the theme has one, `variation-rules.service.ts:209-214`); publish then refuses
   (`studio-publication-amazon-changes.ts:224-225`).
6. Mapping default vs explicit: a default shows with source `master` (`studio-sheet.service.ts:1341-1342`) — wrong label;
   `resolveBatch` treats the default as stored only for Amazon `productType` and eBay `categoryId` (`resolve-batch.service.ts:338`) →
   Etsy/Shopify defaults show but may count as empty for readiness/publish (likely); the same condition matches Shopify's free-text
   "Product type" → probably shows the taxonomy gid when empty (likely).
7. Per market: set separately, no copy; eBay ids differ per site (GALE DE has no category; its IT id does not exist in the DE tree,
   `variation-rules.service.ts:177-179`).
8. The dialog shows only the primary category's own mappings — no effective per-market answer, no inheritance, no overrides; its text
   says only Amazon/eBay values win — Shopify/Etsy do too (`ClassificationDialog.tsx:88-89`).
9. `/products` "Type" column shows the legacy field, not the listing's product type (`_columns.ts:84`).
10. Moving a product under a parent (`catalog-organize.routes.ts:135-140`) changes only `parentId` — family/type/categories not reconciled.
11. Export writes the listing category as SET/INHERIT (`catalog-transfer-export.ts:171-189`); import undo does not restore
    family/category (doc, `docs/product-sheet-import-export/PLAN.md:392`).

## 4. Category ↔ variation theme

Theme cell on the parent listing per alias; its category from the parent listing else the mapping (`studio-sheet.service.ts:1696`;
`variation-theme-facts.ts:253`). Amazon: themes from `CategorySchema.variationThemes` (market, type), latest row even if expired
(`variation-theme-facts.ts:89-104`); order: stored theme → category-scoped rule (`:273-274`) → derived from axes
(`variation-rules.service.ts:550-569`). eBay: variation-eligible aspects of the parent's category (`variation-theme-facts.ts:258-262`);
no category → "has no category yet" (`variation-rules.service.ts:217, 665`). Etsy: eligible taxonomy properties (`:266`), draft only
(`variation-rules.service.ts:531`). **When the category changes:** a stored theme is kept even if the new type does not offer it
(unchecked); unbound axes → readiness errors (`:833-835`); a derived theme recomputes silently; a category rule swaps; only the live
theme-change run checks the theme against the type (`theme-change.service.ts:350-364`).

## 5. Scenarios (today)

Family on one/many (dialog: parent only; grid bulk: anything incl. variants) · variant with own family (widens columns) · internal
categories in bulk (import only) · primary conflict (empty + errors everywhere) · mapped on an ancestor (inherited, not shown) · unreviewed
mapping (used) · listing with no category (readiness error; eBay blocked) · mixed types in a family (silent) · change type on a draft
(values kept, errors on reload) · on a live listing (allowed, publish refuses) · stored theme not offered by the new type (kept; errors)
· same type across 11 Amazon markets (set 11×) · eBay across sites (separate ids, no help) · Shopify category (gid text) · Etsy default
(probably empty) · import family/categories on variants (accepted; undo does not restore) · flat-file import (rewrites legacy) · move to
a new parent (no reconciliation).

## 6. Overlap with other sessions

- `docs/attributes/PLAN.md` **P3b** (not started): attribute placement, "no family shows the core", column cache keys in
  `sheet-columns.service.ts`; its screens belong to the product-sheet session — do NOT rebuild the no-family behaviour.
- **P4** (live): channel rules, Shopify taxonomy values, refresh. **P7** (first pass merged): required-field engine. **P8** (first pass
  merged): readers onto `resolveBatch` — the default-vs-explicit fix (3.6) touches `resolve-batch.service.ts:338`: coordinate.
- `docs/2026-09-11-category-taxonomy-plan.md`: ingestion, search, Categories page, reviewed mapping built; "the editor shows effective
  assignments, inheritance, overrides" only partly done.
- `docs/2026-09-13-variation-theme-column-design.md`: candidates per market/category; not what happens when the category changes.
- The import/export plan already has one tab per product type and greys out fields that do not apply.

## 7. Reuse vs rebuild

**Reuse:** the category resolver (`resolveCategoriesForProducts`, `categoryForListing`, `productCategoryContext`); local taxonomy search +
`ChannelCategoryEditor`; mapping impact review; the classification save's lock + version transaction; the variation-theme facts and
rules; the import's classification rules; the missing-schema readiness errors.

**Rebuild/add:** ONE classification surface (family, internal categories, each market's effective channel category with its source,
conflicts, overrides), editable in bulk across products, variants and markets; ONE bulk classification endpoint (one parent/variant
rule, versioning, events) replacing `bulk-attach-family`; a preview before a category change (impact-review pattern: values that no
longer apply, theme validity, live consequence); a Shopify category picker in the sheet; copy across markets (replacing the unbuilt
broadcast); correct source labels + mapping defaults for all 4 channels; a check that a family's variants share one product type;
retire or label the legacy `Product.productType` writers.
