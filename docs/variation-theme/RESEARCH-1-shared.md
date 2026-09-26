# VTR research 1 — the variation theme on Shared (master) (read-only, 2026-09-26, code at 8a345981f)

## 1. Data model — there is no single source of truth

**Family axes: 3 stores.**
- `Product.variationAxes String[]` (schema.prisma:304) — display spellings; one family can mix them (`Colore`, `Taglia`, dictionary key
  `color`); no per-axis metadata.
- `Product.variationTheme` (schema.prisma:134) — a delimited string; the eBay projection FOLLOWS it whenever the coordinate has no
  override (variation-rules.service.ts:670-673, `ebayAxisSet` :387-399).
- `ChannelListing.variationTheme` + `variationMapping` (schema.prisma:1638/1641, per coordinate).

**Axis candidates** = dictionary columns with `scope: per_variant` (via `CustomAttribute.scope`, or already an axis)
(sheet-columns.service.ts:354, :733; filter family-variation-axes.ts:31-33, variation-theme-facts.ts:169-184) → an attribute not
declared `per_variant` can never become an axis.

**Each variant's values: 3–4 stores.** `categoryAttributes.variations` (designated); flat key `categoryAttributes.color`; legacy
`variantAttributes` (schema.prisma:314); deprecated `ProductVariation.variationAttributes` (still synced, catalog.routes.ts:1781-1803).
The family read reads 3 (cell → variations → legacy) and reports conflicts (family-projection.service.ts:240-262). The resolver gives
`variations` priority over the flat key ONLY for color/size/style (attribute-resolver.ts:185-200, :265); for any other axis a stale flat
key wins (:175, :264).

**Value codes:** none — values verbatim, `label: code` (family-projection.service.ts:536); only SKU codes typed in Generate
(family-generate.service.ts:225-230). `AttributeOption` already has code, label, synonyms, sortOrder, archivedAt (schema.prisma:689) —
no variation value is linked to it.

**Value order:** no Shared store. The family read borrows the eBay parent listing's `platformAttributes._axisValueOrder` (first parent
listing in channel-name order, family-projection.service.ts:1158-1168, :532-540); else `completeAxisValueOrder` = alphabetical except a
fixed size list (shared-variation-values.ts:90-101).

**Per-language value labels:** none on Shared; the only value rename is eBay-only per coordinate (`_axisValueLabels`,
ebay-cockpit.routes.ts:456, :629).

## 2. What Shared offers today

| Operation | Where | API | Bulk? |
|---|---|---|---|
| Add/remove/reorder axes | Information theme cell (`AxesPanelEditor` master host; clicking a chip REMOVES the axis :602-610; reorder :854-872); Variants `ManageAxesDialog` (:172,:182) + band drag | `PATCH /studio/variation-axes` (CAS version + childIds) | one family |
| Rename an axis | **nowhere** (spec claims it, variants-page-spec:68) | — | — |
| Add/rename/merge/reorder values | only typed in Generate; rename = edit cells; no merge; no value-order editor | — | — |
| Set a variant's value | axis column cell on the child row (parent blocked, studio-sheet.service.ts:1376) | `PATCH /api/products/bulk` (bulk-edit.service.ts:2267-2285 writes flat + `variations`) | fill/paste/undo(200) — **one request per row** (sheetWriter.ts:20), not atomic |
| Fill down / paste on the theme cell | refused (`suppressFillHandle`, no `valueParser`, shapeColumn.ts:157,:168) | — | no |
| Add a variant | Information + Variants (`AddVariationDialog`, free text) | `POST /api/catalog/products/:id/children` | one at a time |
| Generate combinations | **Variants only** | `POST /studio/family/generate` (dry run → commit; cap 2000) | within one family |
| Missing/duplicate combinations | **Variants only** (FamilyBand, coverage.ts) | family read `coverage` | — |
| Variant CSV import/export | **Variants only** (`useVariantTransfer`) | `/studio/variants/import` | edits only; cannot create |
| Attach/move/promote/demote/unlink | family actions registry, both tabs | `/api/pim/*`, `/api/amazon/pim/unlink-child` | attach/unlink ≤200 |
| Change axes on many families | **none** | — | no |

## 3. Limitations and inconsistencies (V = verified in code)

1. V — Removing an axis never checks for values (designed refusal "has values on n variants": 0 hits); values orphaned in
   `variations`, invisible on Shared (studio-sheet.service.ts:708-722).
2. V — Remove axis = one click, no confirmation (AxesPanelEditor.tsx:607).
3. V — Shared axis change never gated for live listings (master `locked: null`, variation-rules.service.ts:489;
   `updateFamilyVariationAxes` no live check, family-variation-axes.ts:45-73); Amazon's derived theme re-derives under a live ASIN.
4. V — "Set once on Shared, every channel follows" is FALSE for eBay: where `Product.variationTheme` is set (T18: 337/338 rows) eBay
   follows that string; the Shared axes save never updates it.
5. V — `variationAxes` has ≥5 writers with different rules: studio PATCH (validates); promote (no validation,
   product-relationship.service.ts:98-106); eBay flat-file save writes both stores and clearing wipes `variationAxes` to `[]`
   (ebay-flat-file.routes.ts:1251-1256); auto-detect (auto-detect.service.ts:185-255); amazon.routes.ts:1140; demote nulls
   `variationTheme` keeps `variationAxes` (:117); Amazon catalog-refresh cron (env-gated) overwrites `Product.variationTheme`
   (catalog-refresh.job.ts:65,:77).
6. V — Standalone product: theme cell editable, save refused 400 "Promote a standalone product" (resolveMaster `writable: true` :502;
   family-variation-axes.ts:47-49); the dialog disables Save and explains (ManageAxesDialog.tsx:147,:162).
7. V — Duplicate combinations never refused: add child (catalog.routes.ts:1255-1290), attach (:52-66), reparent w/o axis check
   (:68-82), bulk edit, variant-attributes PATCH, import. Detection only on Variants; master `collisions: null`; master readiness has
   no missing/duplicate item.
8. V — Casing/whitespace: coverage + generate compare exact strings (coverage.ts:119-131,:207-236; family-generate.service.ts:259-262)
   → `Nero` ≠ `nero `; add child only trims; synonyms only color/size/style (variant-attribute-keys.ts:15-24).
9. V — Two coverage definitions (`variantCoverage` reads cells; `combinationCoverage` reads `axisValues` first) + the server's.
10. V — Writers disagree on stored key spelling: add child → declared name (`Colore`); Generate → `storedKey`; bulk edit → flat +
    `variations`; variant-attributes PATCH/attach/auto-detect/bulk-action → `variations` only → a stale flat key stays on screen
    (saved but not shown).
11. V — An axis with no dictionary column ("saved axis", family-variation-axes.ts:38) has no editable column and is silently left out of
    the variant template (variant-transfer.routes.ts:38).
12. V — Weak value concurrency: `writeVariationValues` never bumps `Product.version` (category-attributes-write.ts:31-41);
    `PATCH /variant-attributes` (catalog.routes.ts:1738-1810): no CAS, no read-cache refresh, no event, any keys → lost updates.
13. V — Value rename does not carry stored order: eBay `_axisValueOrder`/`_axisValueLabels` keyed by the old value; renamed value drops
    to the end (shared-variation-values.ts:99-100).
14. V — Generate copies a sibling's `totalStock` into new drafts (family-generate.service.ts:414).
15. V — No axis-count cap on Shared (≤50, family-variation-axes.ts:13); channel limits only appear as dropped/collides.
16. (doc) Renaming a live eBay value may force a relist (VX design:414, ebay-axes-convert header).

## 4. Scenarios today

Create a family (Promote first, or parent with 0 children + axes; first values only via Add child or Generate) · add an axis to a live
family (saved at once, no plan, no fill-in; eBay ignores it where the theme string is set) · remove an axis (values orphaned) · rename
axis / rename a live value / merge / reorder values (unsupported) · split a family (no verb; alias split held) · move a variant
between families (no axis or duplicate check) · bulk-edit 200 variants (200 non-atomic PATCHes; no family or cross-family verb) ·
undo (cell undo only; none for axis dialogs/Generate) · concurrency (axes CAS; values partly) · standalone (refused after the fact) ·
parent with 0 children (axes allowed; `no-values`) · children without values (flagged only on Variants) · members with different axis
sets (hidden keys still count as held axes, shared-variation-values.ts:66-71) · languages (mixed-language axis names; no value labels)
· flat-file/catalog-refresh overwrites (silent).

## 5. Reuse vs rebuild

**Keep:** `variation-rules.service.ts` resolver (52 tests); `AxesPanelEditor` (71) + `sheetWriter` `variationThemeWrite`;
`masterWrite.commitVariationTheme` (31); `family-generate.service.ts` (dry run → commit, previewToken, collision refusal; 14) — move its
host onto Information; `coverage.ts` + `generatePlan.ts` (25 + 25); `writeVariationValues` as the one atomic value writer; the
`variation-axes` CAS (7).

**Rebuild:** a real axis definition on Shared (attribute code, ordered values with codes, per-locale labels, synonyms — reuse
`CustomAttribute`/`AttributeOption`) instead of `variationAxes: string[]`; ONE family-aware value writer + validator (normalise, refuse
duplicate tuples, bump version) replacing 8+ writers; retire `Product.variationTheme` as a second axis store eBay follows; a
remove-axis / live-listing plan gate; operations on Information (coverage, generate, value rename/merge/order, axis rename, a bulk verb
across families); a generic resolver beyond color/size/style.

Before the Variants tab can go, Information needs: combination coverage, Generate, value order, rows ordered by axis value, the
variant CSV's job (inclusion) and the channel dock's sections.
