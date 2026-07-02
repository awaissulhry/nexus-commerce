# eBay flat file — add variant / import-under-parent / re-parent (multi-family management)

**Goal:** On the eBay flat file, let the operator add a variant to an existing family, import rows under a chosen parent, and move/re-parent rows across families — with the results **persisting** in Nexus (surviving reload) and publishing under the right parent.

**Approved decisions (2026-07-02):** Phase 1 (server persistence) FIRST; "add variant" extends the existing `AddListingPopover` (new-family / add-to-existing-family toggle). Modes/UX confirmed. eBay-first (linkage is channel-specific).

## Key mechanics (from forensic investigation)
- Variant→parent link = internal **`platformProductId`** (= parent's product id) + `_isParent=false` + `aspect_<Axis>` values for the parent's `variation_theme`. NOT an editable column. (Amazon uses the editable `parent_sku` — different.)
- Grouping/push already key off `platformProductId` (`getGroupKey` `EbayFlatFileClient.tsx:1666`; push route `ebay-flat-file.routes.ts:755-822`). Push groups client rows by it → once stamped, variants publish under the parent.
- **THE GAP:** eBay save can't create products. PATCH `/api/ebay/flat-file/rows` skips a row whose SKU has no existing `Product` (`ebay-flat-file.routes.ts:271-283`) and never sets `parentId`. Push write-back only updates resolvable productIds (`ebay-variation-push.service.ts:1070-1142`). So new variants are ephemeral until we add server creation. This already affects the existing "Add Listing" flow.
- Existing pieces to reuse: `AddListingPopover.tsx` (axis + SKU-template + `generateRows` at :109-156 — currently only NEW families, `platformProductId=parentRowId` temp id); `EbayImportWizard.tsx` (`onImport(rows,mode)` at :43; new rows built in `handleImport` `EbayFlatFileClient.tsx:1341-1373`, push at :1366); Amazon precedent `handleImportApply` (`AmazonFlatFileClient.tsx:3753-3769`) + `AddRowsPanel` variant mode (:8259-8368, :2876-2935); `ParentPickerModal` UI shape (`MatrixTab.tsx:1860`) — but re-point data source to sheet parents (`rows.filter(_isParent)`), not `/api/pim/*`.
- Gotchas: duplicate SKU = hard error (`validateRows` :129); variant must carry `aspect_<Axis>` for every parent axis (push pre-flight `ebay-variation-push.service.ts:523-553`); new SKU needs `image_1..6` (25717); `shared_sku_listing` flips to Trading-API path (leave OFF); parent's `variation_theme` must persist.

## Phases

### Phase 1 — Server: create/persist products under a parent (foundation)
- Add an eBay create path (extend PATCH `/rows` create-branch or new `POST /api/ebay/flat-file/create`): for a `_isNew` row with `platformProductId` → resolve target parent Product; create a `Product` with `parentId`, `variationTheme` (parent), variant `variantAttributes` from `aspect_*`, brand, then a `ChannelListing` (eBay) with price/qty/content. For NEW families (Add Listing): create the parent product first (temp `_rowId` → real id), then children with `parentId`=new parent id.
- Re-parent: a row whose `platformProductId` changed updates `Product.parentId`.
- Return the created/updated real ids so the client can reconcile temp `_rowId`→real id (so reload matches).
- Guard: dedupe by SKU, transaction per family, don't touch preserved config tables.

### Phase 2 — Add variant to an existing family (extend AddListingPopover)
- Add a mode toggle: "New family" (current) vs "Add to existing family". In the latter, a parent `<select>`/picker sourced from sheet parents (`rows.filter(r=>r._isParent===true)`), auto-seed axes from that parent's `variation_theme`, generate unique SKUs (existing template), stamp `platformProductId=<parent id>`, `_isParent=false`, `aspect_*`. Insert into the family (near the parent) + focus (port `handleAddRows` splice/focus).

### Phase 3 — Import under a chosen parent
- Add "Import as: New families / Under parent → [picker]" to `EbayImportWizard`. Thread `targetParentId` through `onImport(rows,mode,targetParentId?)`; stamp `platformProductId + _isParent=false` (+ split mapped axis columns into `aspect_*`) on new rows at `handleImport` :1366.

### Phase 4 — Manage / re-parent across families
- Checkbox-select (uses the P1 shift-range) → selection-bar action "Move to family / Assign to parent" (sheet-scoped parent picker) + "Detach to standalone". Rewrites `platformProductId`+`_isParent` in row state; persists via Phase 1 on save. Optional read-only "Parent" indicator column. The P4 "Group by: Family" mode already visualizes families.

### Phase 5 — Validation + round-trip verify
- Unique-SKU generation/guard, missing-axis guard, image guard. Verify add/import/move → save → reload persists (DB `parentId` set) → push lands under the right parent; no regression to existing families or the shared-SKU (Trading-API) path.

## Constraints
- eBay flat-file page/routes are "untouchable" without approval — this engagement is the approval. Prefer additive changes; keep the shared grid family path unchanged.
- Verify on prod (Railway+Vercel), not Docker. Product creation touches live data — be conservative, dedupe, and test on a scratch family first.
