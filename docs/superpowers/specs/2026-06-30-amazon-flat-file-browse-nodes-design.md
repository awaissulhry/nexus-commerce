# Amazon Flat-File Browse Nodes & Category Model — Design

- **Date:** 2026-06-30
- **Surface:** `/products/amazon-flat-file` (Amazon flat-file editor) only
- **Status:** Approved design — ready for implementation plan
- **Series tag:** BN (browse-nodes)

> Note: code line numbers in this doc are anchors captured at the 2026-06-30 snapshot and may drift; treat the symbol names as authoritative, the line numbers as hints.

---

## 1. Problem & goal

The Amazon flat-file editor lets a user pick one **product type** (and union extra types via "+ Add category") from a toolbar dropdown, which drives the column set. It does **not** surface **browse nodes** as a managed, validated, per-row concept — even though the Amazon schema we already fetch carries `recommended_browse_nodes`.

Browse nodes matter because a single parent ASIN can hold children of **different product types and different browse nodes** (the reference `AIREON COAT+PANT` file: jacket children → `COAT` → *Giacche* node `2420941031`; pant children → `PANTS` → *Pantaloni* node `2420943031`, all under parent `AIREON`). Each subgroup also requires a **different field set** (jacket rows fill 110 fields, pant rows 114).

**Goal:** make browse nodes first-class and auto-fresh, and replace the toolbar product-type controls with a **Category** model that assigns *product type + browse node together* to a selection / subgroup of rows, makes mixed families legible, and lights up the correct field columns per subgroup.

### Non-goals
- No changes to the eBay flat-file editor or its routes.
- No changes to the product cockpit (`/products/[id]/edit?tab=AMAZON`); we **reuse** its browse-node infrastructure but do not modify it.
- No changes to existing working columns or the Product cell (surgical).
- US `item_type_keyword` placement path is not built now (EU/IT-first); design leaves room for it.

---

## 2. Key facts the design depends on

1. **Required fields are driven by product type, not the browse node.** Amazon migrated to product-type-driven requirements. The browse node is *placement/discoverability* metadata. We assign them together as one "Category" gesture but **store and validate them as two separate fields**.
   - Evidence: Product Type Definitions API is authoritative for `required`; `recommended_browse_nodes` is placement-only. A missing node degrades discoverability but is not a validation failure (Amazon assigns the category root node).
2. **Browse-node ids are per-marketplace.** An IT id is invalid on DE/UK and must re-resolve when the market changes. Column token is `recommended_browse_nodes[marketplace_id=<MP>]#N.value`.
3. **The valid node set for (marketplace, productType) is readable from the PTD schema** as `recommended_browse_nodes.enum` (node ids) + `enumNames` (display paths) — present for *most* EU types, not all. When absent, fall back to the existing AI predictor.
4. **One parent can hold mixed product types/browse nodes** (confirmed by the user and the reference file). We validate each row against its own `product_type`. Amazon *may* reject mixed-type families for some categories → we **warn, not block**.
5. The flat-file value format in a downloaded template is `"<localized path> (<node id>)"`; the JSON schema field stores just the id string (`value`, maxLength 15). The picker stores the **id**, displays the **path**.

---

## 3. Current architecture (reuse map)

### Frontend — `apps/web/src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx`
- `productType` state (~549), `productTypes` list `{value, source}` (~552), `sheetTypes` multi-category union (~557).
- `ProductTypeDropdown` in toolbar "Bar 3" (~4044, component ~5610); "+ Add category" `<select>` appends to `sheetTypes` (~4063).
- Columns derive from the manifest: `Manifest`/`ColumnGroup`/`Column` interfaces (~117–161); `effectiveManifest` = union or single (~568–583); `allColumns` (~1204).
- Template fetch `GET /api/amazon/flat-file/template?marketplace&productType` (~2252); union fetch `/api/amazon/flat-file/union-template` (~596).
- Grouping by `parentage_level` + `parent_sku` (~1309–1330); family coloring (~1354–1376).
- Persistence: URL params (`marketplace`, `productType`, ~2405) + localStorage draft keyed by market+type (~2045–2081). Submit/preflight (~3069–3110).
- Shared hook: `apps/web/src/components/flat-file/useFlatFileCore.ts` (rows/undo/sort/filters; per-instance, not cross-page).

### Backend
- `apps/api/src/routes/amazon-flat-file.routes.ts`: `GET /template` (~149–192), in-memory `TtlCache` 30 min keyed `marketplace:productType` (~53–63), submit per-row validation against each row's own `product_type` (~277).
- `apps/api/src/services/amazon/flat-file.service.ts`: `generateManifest` (~1036–1284), `expandSchemaField` (~546–732), `mergeManifestsIntoUnion` tagging `applicableProductTypes`/`requiredForProductTypes` (~831–883), `buildPerTypeValidation` (~213–238).
- `apps/api/src/services/categories/schema-sync.service.ts`: `getDefinitionsProductType` (PTD API `2020-09-01`, `requirements=LISTING`, locale per market, ~180–276); `propertyGroups` embedded as `__propertyGroups` (~222). 24h DB cache via `CategorySchema`.

### Existing browse-node infra (reuse)
- `apps/api/src/routes/categories.routes.ts` → `/api/categories` predicts `{ categoryPath, browseNodes }` from product type.
- `apps/api/src/services/feed/browse-node-predictor.service.ts` + `apps/api/src/jobs/browse-node-predictor.job.ts` (AI predictor cron).
- Cockpit `CategoryCard` browse-node picker.
- `ChannelListing.platformAttributes.browseNodeId` (`prisma/schema.prisma` ~1476–1479) — write-back target.

---

## 4. Target design

### 4.1 Data model
- Browse node lives in the existing schema column `recommended_browse_nodes[marketplace_id=<MP>]#1..N.value` per row; **no new DB column for the flat-file row** (rows are draft state in localStorage + serialized to feed).
- On sync/submit, write the chosen node id to `ChannelListing.platformAttributes.browseNodeId` (per marketplace), reusing the existing field.
- "Category" is a **derived UI concept**, not a stored field: `Category(row) = { productType: row.product_type, browseNode: row.recommended_browse_nodes#1 }`, rendered as a chip (e.g. `Giacche · COAT`).

### 4.2 Browse-node source (Phase 0)
- New endpoint `GET /api/amazon/flat-file/browse-nodes?marketplace=&productType=` → `[{ id, path, label }]` extracted from the PTD schema `recommended_browse_nodes.enum`/`enumNames`.
- Fallback when the enum is absent: existing `/api/categories` predictor.
- Freshness: reuse the 24h `CategorySchema` cache; add a nightly cron that refreshes schemas for the markets×product-types currently in use; expose `force` for on-demand live refresh; surface "last refreshed" to the UI.

### 4.3 UI model (Phases 1–3)
- **Pinned Category column** (always visible, left of the field columns, right of identity) rendering the category chip per row; read-only display.
- **Browse-node cell/picker** (Phase 1): search-as-you-type over the node list, shows full path, stores id; per-market aware; default 1 node, allow up to 2 (`#1`,`#2`).
- **"Set category" toolbar action** (Phase 2): operates on the current selection or a parent's child-subgroup → choose product type (drives fields) + browse node (filtered to that type's enum) → applies to all selected rows.
- **Dynamic columns:** the union manifest is driven by the **set of categories actually assigned across rows** (replacing the manual "+ Add category" list). Assigning `PANTS` to the pant subgroup makes pant-specific columns appear via the existing `applicableProductTypes` mechanism.
- **Toolbar replacement** (Phase 3): remove `ProductTypeDropdown` + "+ Add category"; replace with a "Categories in this sheet" chip summary (click → filter columns to that category via existing column-filter buttons) + the "Set category" action. Marketplace switcher stays.

### 4.4 Per-market + validation (Phase 4)
- On market switch, node ids re-resolve per market (don't carry IT→DE); show an unresolved state + offer predictor auto-fill.
- Warn (not block) when a mixed-type family risks Amazon rejection; warn when an EU row has no node (root-node fallback).
- Per-type required-field validation already exists (`buildPerTypeValidation`); keep it authoritative.

---

## 5. Phases (each independently testable, shippable, committed)

### Phase 0 — Browse-node source of truth (backend only, zero UI risk)
- Extract `recommended_browse_nodes` `enum`+`enumNames` from the PTD schema per (marketplace, productType).
- Add `GET /api/amazon/flat-file/browse-nodes`; predictor fallback; nightly refresh cron; `force` live refresh.
- **Acceptance:** IT `COAT` returns node `2420941031` (*…> Giacche*); `PANTS` returns `2420943031` (*…> Pantaloni*); absent-enum type falls back to predictor without error.

### Phase 1 — Browse node as a first-class, picker-driven column
- Managed `recommended_browse_nodes` column with search-as-you-type picker (path shown, id stored), per-market aware, 1–2 nodes.
- Serialize into `JSON_LISTINGS_FEED`; write back to `platformAttributes.browseNodeId` on sync.
- **Acceptance:** pick a node on a jacket row → submit → payload carries the id in the correct token; `browseNodeId` persisted on the listing.

### Phase 2 — Category concept + per-group assignment (UX core)
- Pinned Category column (chip `Giacche · COAT`).
- "Set category" action on selection / child-subgroup → sets product type + browse node together.
- Union manifest driven by assigned categories; pant-specific columns appear when `PANTS` assigned.
- **Acceptance:** in one AIREON family, assign `COAT` to jacket rows + `PANTS` to pant rows → correct columns light up, per-type validation holds, mixed family readable.

### Phase 3 — Toolbar replacement
- Remove `ProductTypeDropdown` + "+ Add category"; add "Categories in this sheet" summary + "Set category"; keep marketplace switcher.
- **Acceptance:** old controls gone; all assignment via column/action; column-filtering by category works; market switch intact.

### Phase 4 — Freshness, per-market resolution, validation polish
- "Synced from Amazon / last refreshed · Refresh" indicator.
- Market-switch node re-resolution + unresolved state + predictor auto-fill.
- Mixed-family rejection warning; EU missing-node warning.
- **Acceptance:** IT→DE switch prompts re-resolution; missing-node + mixed-family warnings fire; manual refresh updates the node list.

---

## 6. Cross-cutting constraints
- Build new UI from the design system (`apps/web/src/design-system`).
- Honor the editor's DSP discard/save/publish patterns + dirty-registry.
- Ship **live (enabled by default)**, not behind a dark flag; diff-then-apply + per-type validation are the safety.
- Commit + push after each verified phase.
- **Surgical:** no changes to unrelated columns or the Product cell. The flat-file "untouchable" rule is lifted **for this approved work only**.

---

## 7. Risks / open items
- PTD `recommended_browse_nodes` enum present for *most* (not all) EU types → predictor fallback (Phase 0) covers gaps.
- Mixed-type families can be rejected by Amazon for some categories → warn, don't block (reference file proves moto-apparel works).
- Per-market node re-resolution is genuine work (Phase 4), not hand-waved.
- `maxUniqueItems` for nodes is large (schema ceiling 232) but practical usage is 1–2; UI caps at 2.
