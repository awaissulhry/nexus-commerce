# PES.6 — Global Mapping Engine (`/channels/mapping`) — Phase 0

**Lane:** PES.6 · **Date:** 2026-09-01 · **Status:** Phase 0 complete, phase plan awaiting Owner approval.
**Rules in force:** nothing committed · new route allowed (this IS the designated global area) ·
DS + NexusGrid for any grid · stay in lane paths · ONE resolver serves preview AND sheet.

---

## §0 Method note (honesty)

The lane prompt said "frames 1440–2140 notes are in the layout doc". They are **not** — the layout
doc only *cites* "frames 1400–2350 of the 2026-08-12 recording" in its decision log. So I did the
study myself from `~/Desktop/Screen Recording 2026-08-12 at 15.01.31.mov` (3456×2234, 3298 s,
166,151 frames @120 fps nominal). Frame numbers in the layout doc are **video seconds** (the 1-fps
convention from `reference_video_frame_study_method`), so 1440–2140 = 24:00–35:40.

Extraction: `-ss <t> -vf "fps=1/20, crop=2827:1580:321:654, scale=1500"` — the crop isolates the
Zoom-shared ChannelAdvisor window from the webcam/Zoom chrome. 48 coarse frames over 1400–2360,
plus two dense 1/4-fps passes (1580–1760, 2090–2310) rendered as 3×5 contact sheets for state
detection. Artifacts live in this session's scratchpad (`rithum/coarse`, `rithum/crop`,
`rithum/dense`, `rithum/tiles`) — not in the repo.

**What the recording does NOT show:** the operator never opened the rule editor. Every mapping was
browsed read-only. So the *authoring* gesture below is inference from the read-only surface + the
menu, not observed fact. Flagged again in §2.7.

---

## §1 The Rithum template editor, as observed

URL: `complete.channeladvisor.com/OutboundTemplateEditV2.mvc?apid=<account>&CCID=<connection>&FmsId=<template>`

Two templates were shown: **Amazon | Amazon Template – Listings API** (CCID=97) and
**Zalando UK | Template** (CCID=11323). Same editor, different taxonomy and field set.

### 1.1 Frame

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Amazon      Amazon Template - Listings API        [Save Changes] [(0)▾] [More Actions▾] │
│ Marketplace                                                                     [Exit]  │
├──────────────┬─────────────────────────────────────────────────────────────────────────┤
│ Categories   │ COAT                    Preview SKU: [SE_AS_47006372-5-2XL: Errol ×▾]    │
│         [Add]│                                                        Go to Product     │
│ [🔍 Search ] ├──────────┬──────────┬──────────────────┬──────────────┬─────────────────┤
│              │ Channel  │ Priority │ Mapping from     │ Preview Value│ Status          │
│ All Cats     │ Field    │          │ Your Data        │ [!View 21    │                 │
│      71/4582 │[Contains▾]│[3 sel ▾]│                  │  Errors]     │                 │
│ BACKPACK     │[Search…] │          │                  │ [All ▾]      │ [All ▾]         │
│       59/236 ├──────────┴──────────┴──────────────────┴──────────────┴─────────────────┤
│ BATHTUB    × │  Your filters match 119 of 245 total fields.  Clear Filters             │
│ COAT       × ├─────────────────────────────────────────────────────────────────────────┤
│ FAUCET     × │ ▾ Common                                     Expand All │ Collapse All   │
│ KITCHEN    × │   ▾ Product Identification                                              │
│ SINK       × │     Title            Required if Rel  🪄 SE_AS_TITLE   Xavia Racing…  ✅ │
│ TOOLS      × │   ▾ Product Details                                                     │
│              │     Brand Name       Required if Rel  🏷 Brand         Xavia Racing   ✅ │
├──────────────┤     External Prod ID Required if Rel  🪄 if(isblank(…) 7325707234606 ✅ │
│ Category     │     Shipping Price…  Best Practice    —               —          Unmapped│
│  Mapping Edit│     Item Package Qty Required if Rel  ❞ "1"           1             ✅  │
│ ❞ "BACKPACK" │     Unit Count Type  Required if Rel  ❞ "Count"   [Auto Corrected?] count│
└──────────────┴─────────────────────────────────────────────────────────────────────────┘
```

### 1.2 The five columns (this is the model)

| Column | What it is |
|---|---|
| **Channel Field** | one row per field in the channel's schema for the selected category. Name is a link (opens the editor). Some carry ⓘ = schema help text. Grouped `Common ▸ <group> ▸ <subgroup>` (Product Identification / Product Details / Product Description / Images / Price Optimization / C. Pricing / A. Product). Filter: `Contains ▾` + free text. |
| **Priority** | the channel's **requirement level**, four values observed: `Required` · `Required if Relevant` · `Best Practice` · `Optional`. Filter is a **multi-select** ("3 selected" / "4 selected"). This is schema truth, not operator choice. |
| **Mapping from Your Data** | the rule. Three kinds, distinguished by icon: 🏷 **attribute** (`Brand`, `ASIN`, `FEATUREPOINT1`, `Image URL 1`) · ❞ **constant** (`"1"`, `"New"`, `"AEP"`, `"Count"`) · 🪄 **business rule / expression** (`SE_AS_TITLE`, `SE_AS_Price - 60% Margin`, `if(isblank($itemasin),"ean","upc")`). Hovering a 🪄 shows the tooltip **"Business Rule Result: SE_AS_Price - 20% Margin"** — so named rules are first-class, reusable objects, and the cell shows the rule's NAME, not its body. |
| **Preview Value** | the resolved value **for the selected Preview SKU**. `–` when no SKU is selected. Renders long text in a scroll-in-cell box, URLs as links, and three special states: a red `⊙ Field 'Bullet Point 1' is required.` error, a magenta `Auto Corrected ?` chip (`"Count"` → `count`), and empty. Header carries a red **`⊙ View N Errors`** button (21 on Amazon, 3 on Zalando) + its own `All ▾` filter. |
| **Status** | `Mapped` (green) / `Unmapped` (grey). **Independent of the error state** — Bullet Point 1 is `Mapped` and simultaneously errored. Filter `All ▾`. |

### 1.3 Left rail — categories and category mapping

- Header `Categories [Add]` + search box.
- `All Categories 71/4,582` — **mapped / total** for the whole channel taxonomy. Per category the
  same pair (`BACKPACK 59/236` = 59 of 236 fields mapped). Zalando: `29/2,263`, `Low Shoe 27/167`.
- Categories are **added to a working set** (each has an `×` to remove); the selected one drives the
  field list. So the rail is "the categories I sell into", not the whole 4,582-node taxonomy.
- Bottom pane: **`Category Mapping  [Edit]`** showing `❞ "BACKPACK"` / `❞ "Low Shoe"` — i.e. the
  category assignment is itself expressed as a rule (here a constant), editable, and the grid gets a
  sticky **`Category` → `low_shoe`** header row showing the resolved channel category CODE.

### 1.4 Preview SKU

- A searchable typeahead over `SKU: Product name` (`SE_AS_47006372-5-2XL: Errol`,
  `SE_AS_47400028-274-M: Long Shearling Coat`, `SE_AS_10021: Universeller Reiseadapter`).
- Selecting one **switches the category view to that product's mapped category** and shows a toast:
  *"Your view has changed to BACKPACK · Go back to COAT"* — an undo link, not a silent jump.
- `Go to Product` link next to the picker.
- The selection **persists across templates** (Amazon → Zalando kept the same SKU).
- Field counts are per-category (`119 of 245` COAT, `115 of 236` BACKPACK, `167 of 167` Low Shoe).

### 1.5 Where the editor lives in the IA

The `Sell` mega-menu lists every channel connection (Amazon Marketplace, Amazon Vendor, eBay,
Zalando, ASOS, Debenhams, John Lewis, M&S, Wayfair, OnBuy, Decathlon, Shopify, BigCommerce, …), each
with the same sub-items: **Listings · Deals · Template · Settings** (marketplaces add Pricing
Console / Repricer / Competition / Product Insights). A right-hand **Settings & Tools** column holds
the cross-channel objects: **Library · Business Rules · Lookup Lists** · Multi-Channel (Price
Protection, Velocity Repricer, Multi-Channel Profiles) · Direct Checkout · **AI Tools (Categorizer,
Content Optimizer)**.

**Read:** the template is *per channel connection*; the reusable machinery (named business rules,
lookup/value lists) is *global*. That is exactly the split PES.6 needs.

### 1.6 Formulas actually observed

```
if(isblank($itemasin), $itemean, $item…)        → 7325707234606     (External Product ID)
if(isblank($itemasin), "ean", "upc")            → ean               (External Product ID Type)
SE_AS_TITLE                                     → "Xavia Racing Errol MIdnight - Superior
                                                   Insulation, Genuine Sheepskin Construction, …"
SE_AS_eBay Title                                → "Errol Mens Jacket XS-5XL Midnight"
SE_AS_Price - 20% Margin                        → 1267.99           (Zalando Minimum Price)
SE_AS_Price - 60% Margin                        → 1690.99           (Zalando Maximum Price)
ZL Selling Price                                → 1300.00
ZL UK Promotion/Discount Price                  → 1040
```

Syntax elements: `$attribute` refs · double-quoted string literals · `if(cond, then, else)` ·
`isblank(x)` · named rules referenced by name · margin arithmetic.

---

## §2 Inventory — what we already have

**Headline: we have far more of this than the mission assumes, spread across THREE parallel
systems, and the one real hole is category mapping.**

### 2.1 The FM engine (the real one) — `Marketplace.schemaMapping` JSONB

`apps/api/src/services/pim/schema-mapping.service.ts` (583 lines) owns the shape:

```ts
MarketplaceSchemaMapping {
  version: number
  fields: Record<fieldKey, FieldMappingRule>            // default rules
  byProductType?: Record<productType, Record<fieldKey, FieldMappingRule>>   // FM.1 overlay
  lastSyncedAt: string | null
  schemaSnapshotVersion: string | null
}
FieldMappingRule { source: string; fallback?: string; transforms?: TransformOp[]; required?: boolean; notes?: string }
```

15 transform ops already implemented and validated: `truncate · titleCase · lowerCase · upperCase ·
prepend · append · replace · default · valueMap · sizeScale · unit · numberFormat · template ·
channelLimit · translate`.

### 2.2 `resolveChannelField` — the single resolver (568 lines)

`apps/api/src/services/pim/resolve-channel-field.ts`. Already the documented "what you preview ==
what ships" path. Composes: rule.source → fallback → transforms, with provenance precedence
`missing → locked → override → linked → fallback → default → catalogRule`, plus `warnings[]`,
`appliedTransforms[]`, `needsTranslation`, and a `legacySource` kept byte-identical for the canvas.
`payload-preview.ts`, `publish-validator.ts`, `mapping-simulate`, `mapping-matrix` all go through it.

**This is the engine PES.6 must run — not re-implement.** It already produces Rithum's Preview Value
and its warning vocabulary.

### 2.3 Supporting services already built (`apps/api/src/services/pim/`, 7,417 lines)

| File | What it gives PES.6 |
|---|---|
| `payload-preview.ts` | `previewPayload({productId, channel, marketplace, locale})` → `{payload, fields[], missingRequired[]}` — the Preview SKU column, already. |
| `publish-validator.ts` | required-field validation → the `View N Errors` panel. |
| `mapping-coverage.service.ts` | per-(channel, market, productType) `{totalFields, mappedFields, requiredFields, requiredUnmapped, coveragePct}` — the rail's `59/236`. |
| `mapping-suggest.service.ts` + `mapping-suggest-ai.service.ts` | heuristic then AI suggestions for unmapped fields (review-gated). |
| `mapping-simulate.service.ts` | blast radius of a rule change before saving. |
| `mapping-revision.service.ts` + `MappingRevision` model | version history + rollback (last 30). |
| `value-map.service.ts` + `FieldValueMap` / `SizeScaleMap` | Rithum's **Lookup Lists**, already modelled and AI-seedable. |
| `schema-caps.ts` | maxLength / maxBytes / enum options / required / editable / deprecated enums from the CACHED Amazon definition (deliberately TTL-ignoring; caller reports age). |
| `schema-to-fields.ts`, `master-schema.service.ts`, `field-registry.service.ts` | the "internal variables" side. |
| `reverse-mapping.service.ts` | invert rules to bootstrap master from a live listing. |
| `mapping-matrix.service.ts` | per-product field × coordinate matrix (the existing MappingTab). |
| `mapping-propagation.service.ts` / `apply-mapping.service.ts` | FM.5/FM.6 cascade. |

### 2.4 API surface that already exists

```
GET    /api/pim/mappings/marketplaces                       list + fieldCount/mappedCount
GET    /api/pim/mappings/:channel/:code[?productType=]      every ChannelSchema field + its rule + overlay flag
PUT    /api/pim/mappings/:channel/:code/:fieldKey            upsert one rule (revision recorded)
DELETE /api/pim/mappings/:channel/:code/:fieldKey
POST   /api/pim/mappings/:channel/:code/bulk  · DELETE .../bulk
POST   /api/pim/mappings/:channel/:code/sync-schema          live SP-API schema pull → ChannelSchema
GET    /api/pim/mappings/:channel/:code/preview/:productId   ← the Preview SKU engine
GET    /api/pim/mappings/:channel/:code/validate/:productId  ← the errors panel
GET    /api/pim/mappings/:channel/:code/suggest  · POST .../suggest-ai
GET    /api/pim/mappings/:channel/:code/revisions · POST .../rollback/:revisionId
POST   /api/pim/mappings/:channel/:code/simulate
POST   /api/pim/mappings/clone      GET /api/pim/mappings/coverage
GET/PUT/DELETE /api/pim/value-maps  · POST /api/pim/value-maps/seed-ai · seed-ebay
GET/PUT        /api/pim/size-scales
GET    /api/products/:id/mapping/matrix · /divergence · POST /propagate-preview · /apply · /adopt-master
```

### 2.5 Web surfaces that already exist (three of them)

1. **`/settings/mappings`** (776 lines) — marketplace picker + flat `FieldRuleRow` list, productType
   overlay selector, live schema sync, validate-against-product, payload preview modal, value-map
   manager. Hand-rolled Tailwind-ish, `@/components/ui/Input`, not NexusGrid.
2. **`/settings/mappings/canvas/[channel]/[code]`** (438 lines) — the D.4 two-column click-to-bind
   canvas + `internalVariables.ts` (a curated 30-entry source-path registry).
3. **`/marketing/content/mapping`** (CE.1, 1,219 lines incl. `RuleBuilderDrawer`) — **a completely
   separate engine**: `FeedTransformRule` model (condition `{field, op, value}` + action
   `{type, value|template}`, integer `priority`, first-match-per-field), its own
   `/api/feed-transform/*` routes and its own reuse of the `ChannelSchema` table.
4. Per-product **`MappingTab.tsx`** (536 lines) — the read-only matrix on the old edit page.

### 2.6 The real gaps

| # | Gap | Severity |
|---|---|---|
| **G1** | **No category mapping exists at all.** Nothing maps our `Category` taxonomy (`Category`/`CategoryClosure`/`ProductCategory`) to a channel category. The rule-set axis is `Product.productType` — a raw string on the product, read straight into `getResolvedRules(channel, code, product.productType)`. `ChannelListing.channelCategoryId` is per-listing, not a mapping. This is the biggest hole vs Rithum, and it needs a Prisma model. | 🔴 needs PES.5 |
| **G2** | **Priority is a boolean.** `ChannelSchema.required: Boolean`. Rithum has four levels. The 4-level truth *is* derivable from the cached `CategorySchema.schemaDefinition` (root `required[]`, conditional requirements, `$lifecycle`) — `schema-caps.ts` already walks that JSON. | 🟠 |
| **G3** | **Preview only covers MAPPED fields.** `previewPayload` iterates `Object.keys(rules)`. Rithum shows the whole schema (245 fields) with `Unmapped` rows. Need the union `ChannelSchema ∪ rule keys`, resolved in one pass. | 🟠 |
| **G4** | **No formula/expression engine.** `template` interpolates `{{attr}}` and that is all. No `if()`, no `isblank()`, no arithmetic, no margins, no named/reusable rules. `SE_AS_Price - 20% Margin` has no representation today. | 🔴 core mission |
| **G5** | **No batched channel-field resolve.** Everything is per-product (`previewPayload` = 1 product). The sheet's channel scopes need N products × M fields in one call. | 🔴 the PES.2/3 seam |
| **G6** | **The sheet does not use the channel resolver at all.** `sheet-rows.service.ts` calls `resolveAttributes` (master layer) only. There are no 🔗 derived channel values in the sheet yet. | 🔴 the seam |
| **G7** | **No field grouping.** `ChannelSchema` has no group/subgroup; the editor renders a flat alphabetical list. Amazon's `__propertyGroups` (already cached) carries it. | 🟡 |
| **G8** | **Three engines, three UIs.** FM (`schemaMapping`) vs CE.1 (`FeedTransformRule`) vs the D.4 canvas. Consolidation is an Owner decision, not a silent one. | 🟠 |
| **G9** | No `/channels` route exists in `apps/web/src/app` at all. | 🟢 |

### 2.7 Traps that bind this lane

- `reference_preview_must_run_the_engine` — the preview column must call `resolveChannelField`, never a client-side re-implementation.
- `reference_ag_filter_modules_decision` — AG filter modules were REJECTED on `/products/next` because of the SSRM contract. This grid is **client-side row data** (≤ a few hundred rows), so DS filters (`GridSetFilter`/`GridTextFilter`, already exported from the grid barrel) are legitimate — but `design-system/grid/` belongs to **PES.2**, so any change there is a cross-lane request.
- `reference_grid_chrome_lives_in_the_engine` · `reference_grid_height_follows_rows_per_page` — chrome and height rules; see Q5 below.
- `reference_ag_react_inline_options_rerun_column_model` — memoise every option object.
- `reference_prisma_upsert_on_conflict` — if a category-mapping model changes any `@@unique`, sweep upsert call sites.
- `feedback_100_percent_honest_ui` — a Preview Value must be the server's resolved value, round-tripped; an `Auto Corrected` chip must reflect an actual correction the engine made, not a client guess.
- `reference_ask_amazon_allowed_columns` / `reference_empty_column_four_causes` — an empty preview cell has several causes (unmapped, source empty, transform nulled, schema field absent); the cell must say which.
- `feedback_ship_live_not_dark` — the page ships wired to real endpoints, not a mock.
- The Amazon Rithum tenant showed *"Amazon API Authorization Failure"* the whole session — a good reminder that our own schema-sync path must degrade to the cached definition (which `schema-caps.ts` already does) and **report the age**.

---

## §3 Proposed phase plan (awaiting approval)

Nothing below is implemented yet. Sequenced so the PES.2/PES.3 seam lands early.

| Phase | Deliverable | Paths | Depends on |
|---|---|---|---|
| **6.1** | **Field catalogue read** — `GET /api/pim/mappings/:channel/:code/fields` returning the **union** of `ChannelSchema` ∪ rule keys, each with `{fieldKey, label, group, subgroup, priority, maxLength/maxBytes, options, editable, deprecatedOptions, rule, ruleKind, overlay}`. Priority derived 4-level from the cached `CategorySchema` via `schema-caps.ts` (+ schema age reported). Fixes G2, G3, G7. | `apps/api/src/routes/channel-mapping.routes.ts` (new), `services/pim/mapping/field-catalogue.service.ts` (new) | — |
| **6.2** | **Batched resolver seam** — `POST /api/pim/mappings/:channel/:code/resolve` `{productIds[], variantIds?, fieldKeys?, locale}` → per (product × field) `{value, status: mapped\|unmapped, error?, autoCorrected?, provenance, appliedTransforms, warnings, required, priority}`. One `resolveAttributes`/link-group/value-map load per product, one rule set per template; **calls `resolveChannelField` per field**. Fixes G5. **This is the ONE resolver the sheet consumes.** | same route file, `services/pim/mapping/resolve-batch.service.ts` (new) | 6.1 |
| **6.3** | **Expression engine** — new transform op `{type:'expr', expr}` with a small no-eval evaluator: `$attr` / `{{attr}}` refs, string literals, `+ - * /`, `if(a,b,c)`, `isblank(x)`, `coalesce(…)`, `round(x,n)`, `concat(…)`, `%margin` helpers. Pure, unit-tested, warning-based failure (never throws). Plus **named expressions**: `expressions: Record<name, expr>` added to `MarketplaceSchemaMapping` (see Q2) so `SE_AS_Price - 20% Margin` is authored once and referenced by many fields; the mapping cell shows the NAME, the tooltip the body — exactly Rithum. Fixes G4. | `services/pim/mapping/expr.ts` (new) + additive edits to `schema-mapping.service.ts` / `resolve-channel-field.ts` ⚠ shared with PES.5 — see Q1 | — |
| **6.4** | **Category mapping** — `CategoryChannelMapping` (our `Category` → channel category / Amazon `productType`, per channel × marketplace, with a resolved-path label + mapped/total counts), a resolver `effectiveProductType(product, channel, market)` that prefers the mapping over the raw `Product.productType`, and `GET/PUT /api/pim/mappings/:channel/:code/categories`. Fixes G1. **Needs a Prisma migration → PES.5's owned path (Q1).** | `packages/database/prisma/schema.prisma` + migration (PES.5), `services/pim/mapping/category-mapping.service.ts` | Q1 answer |
| **6.5** | **The page frame** `/channels/mapping` — DS shell, channel × market picker off `/pim/mappings/marketplaces`, left Categories rail (search, working set, `mapped/total` from `mapping-coverage`), Category Mapping pane + editor, header with pending-change count + Save / Discard / More actions (clone, sync schema, revisions, rollback, simulate). | `apps/web/src/app/channels/mapping/**` | 6.1, 6.4 |
| **6.6** | **The field grid (NexusGrid)** — rows = the 6.1 catalogue, AG row grouping `Common ▸ group ▸ subgroup`; columns `Channel Field · Priority · Mapping from Your Data · Preview Value · Status`; per-column DS filters + the "N of M total fields · Clear Filters" banner; icon-by-kind in the mapping cell (🏷 attribute / ❞ constant / 🪄 expression); Status chips; Preview cell with value / error / `Auto Corrected` / scroll-in-cell long text. | `apps/web/src/app/channels/mapping/**` (+ cross-lane request to PES.2 if `design-system/grid/` needs anything) | 6.5 |
| **6.7** | **Preview SKU + errors** — SKU typeahead (`SKU: name`), category auto-switch with the *"view has changed… go back"* undo toast, `Go to product`, `View N Errors` panel off `validate/:productId`, per-cell warnings from the resolver. | same | 6.2, 6.6 |
| **6.8** | **Rule editor drawer** — DS Drawer: kind picker (attribute / constant / expression / named rule), source + fallback pickers over the internal-variable registry, the existing `TransformsEditor` reused, live preview against the selected SKU (runs 6.2), `simulate` blast radius before save, revisions/rollback. Reuses `PUT /:fieldKey` (revision recorded automatically). | same | 6.3, 6.7 |
| **6.9** | **The sheet seam** — publish the client contract PES.2/PES.3 consume (`useChannelFieldResolve` hook + types) so channel-scope cells render 🔗 derived values from the SAME endpoint; record it as a cross-lane deliverable in `docs/pes-claims.md`. Fixes G6. | `apps/web/src/app/channels/mapping/_shared/` (exported), claims doc | 6.2 |
| **6.10** | **Consolidation proposal** (write-up only, no deletion) — one surface on the FM engine; what happens to `/settings/mappings`, `/settings/mappings/canvas`, `/marketing/content/mapping` + `FeedTransformRule`. Owner decides. | doc | all |

---

## §4 Questions I need answered before implementing

1. **Migration ownership (blocks 6.4).** Category mapping needs a new Prisma model, and
   `packages/database/prisma/schema.prisma` + migrations are PES.5's claimed path (their claim names
   `apps/api/prisma/**`, but the live schema is `packages/database/prisma/schema.prisma`). Do I
   (a) write the model + additive migration myself after telling PES.5, or (b) file it as a
   cross-lane request and wait? **My recommendation: (a)** — additive migrations are pre-approved and
   PES.5's alias work does not touch `Category`.
2. **Named expressions: where do they live?** (a) `expressions: Record<name, expr>` inside
   `Marketplace.schemaMapping` — **zero migration**, versioned + revisioned + rollback-able for free,
   but scoped per marketplace; or (b) a global `MappingExpression` table shared across every channel
   (Rithum's "Business Rules" are global). **My recommendation: (a) now, promote to (b) only when a
   rule genuinely needs to cross marketplaces** — the JSONB path costs nothing and the revision
   history comes free.
3. **Priority derivation.** Derive the 4 levels from the cached Amazon schema (Required / Required if
   Relevant / Best Practice / Optional), or keep `required: boolean` plus a curated "Best Practice"
   list? **Recommendation: derive**, and show the schema's age beside it (`schema-caps.ts` convention).
4. **Retirement.** Does `/channels/mapping` supersede `/settings/mappings` (+ canvas) and
   `/marketing/content/mapping`, or do all three stay? I will not touch or redirect them without
   your word; 6.10 is a proposal only.
5. **Grid host.** DS rule is autoHeight + page scroll for PAGE grids, with `GridSheet` as the
   sanctioned bounded exception. Rithum's editor is bounded (sticky filter row, inner scroll) and
   this is an editor surface, not a list. **Recommendation: bounded via the `GridSheet` host** —
   confirm, since it deviates from the page-grid default.
6. **Route chrome.** `/channels/mapping` with the standard global chrome (default `AppShell`), or the
   `/products/next` standalone `h10-shell` + rail? The latter needs one line in
   `apps/web/src/components/layout/AppShell.tsx`, which **PES.1 owns** → cross-lane request.
   **Recommendation: standard global chrome** — it is a global settings-class area, and it keeps
   PES.1 unblocked.

---

# §5 What was built (2026-09-01, session `nexus-commerce-33`)

Owner approved the §3 plan and all six §4 recommendations ("Go ahead"). Everything below is
**uncommitted**, per programme rule 2.

## 5.1 Backend

| File | What it is |
|---|---|
| `services/pim/mapping/expr.ts` (794 lines) | **The formula engine.** Tokenizer + Pratt parser + tree-walking evaluator. No `eval`, no `new Function`, never throws — a bad formula is a warning on one cell, never a 500. 34 functions across Logic / Text / Number / Pricing / Rules, including `margin` · `markup` · `discount` · `vat` · `exvat` (spelled out because `price / (1 - pct/100)` is the arithmetic that gets typed wrong once and ships wrong for a year) and `rule("name")` for saved rules. `+` is numeric when both sides are numeric and concatenation otherwise. 22 unit tests. |
| `services/pim/mapping/field-catalogue.service.ts` | **The union** of the channel schema ∪ `ChannelSchema` rows ∪ every key carrying a rule, so an UNMAPPED field is a row rather than an absence. Derives the 3 real requirement levels from Amazon (see 5.4). Derived schema is TTL-cached: **1384ms cold → ~78ms warm**. |
| `services/pim/mapping/resolve-batch.service.ts` | **The resolver seam.** N products × M fields in one pass, every value through `resolveChannelField`. Reports auto-correction, off-list values, over-limit lengths and required-but-empty separately from mapped/unmapped status. |
| `services/pim/mapping/category-mapping.service.ts` | Our `Category` → the channel's, per channel × market, inheriting down the tree via `CategoryClosure`, falling back to `Product.productType` and **saying so** (`source: 'productType'`). |
| `services/pim/mapping/index.ts` | The **in-process** entry point PES.5 composes (hub ruling #15). Imports in 88ms with Redis unreachable. |
| `routes/channel-mapping.routes.ts` | 15 endpoints. Rule writes deliberately reuse the existing `PUT/DELETE /pim/mappings/…`, so every edit still records a `MappingRevision` and stays rollback-able — no second write path. |

**Additive edits in two shared files** (declared in `docs/pes-claims.md`): `TransformOp` gains
`{type:'expr'}`; `MarketplaceSchemaMapping` gains `expressions` (named business rules, stored
inside the mapping so they inherit its revision history — Owner option (a), no new table);
`rule.source` may now be empty when a `default`/`template`/`expr` transform produces the value.
Every rule valid before is still valid.

**Migration** `20260901d_pes6_category_channel_mapping` — one new table, applied to prod, recorded
in `_prisma_migrations`. Applied directly rather than via `migrate deploy`, which would have
dragged two sibling lanes' parked migrations.

## 5.2 Frontend — `/channels/mapping`

Built from scratch on the DS (decision §2.10); nothing imported from `/settings/mappings`,
`components/ui/**` or the old canvas. Standard app chrome. `NexusGrid` in the bounded `GridSheet`
host, grouped into full-width bands by the channel's own `__propertyGroups`. Five columns exactly
as Rithum: **Channel field · Priority · Mapping from your data · Preview value · Status**, with
per-column filters and the "Your filters match N of M fields" banner.

The rule drawer offers the four kinds the grid's icons name — Attribute 🏷 · Fixed value ❝ ·
Formula 𝑓 · Business rule ✦ — with **live server-side syntax checking** (`expected ")" but the
expression ended (character 29)`) and dependency extraction (`Valid · reads armorType, brand`).
Its attribute picker is read live off the previewed product through the same resolver the rules
use, so every path offered is one that resolves and each shows its current value — which is how
the drawer explains an error rather than just reporting it.

## 5.3 The rail says something Rithum's never has to

🔴 **Our `Category` taxonomy is EMPTY on prod** — `Category`, `ProductCategory` and
`CategoryClosure` are 0 rows. The live axis is `Product.productType` (OUTERWEAR 148 · SUIT 50 ·
COAT 21 · PANTS 20 · GLOVES 17 · AUTO_ACCESSORY 18 · EBAY_LISTING_SHELL 22 · **null 42**). So the
rail lists CHANNEL categories (which is what the field set hangs off, and what Rithum's rail shows
anyway) and the Category Mapping pane states the fallback in words instead of rendering an empty
tree that pretends to be a feature.

## 5.4 Requirement levels: three, not four

Measured on the cached IT/OUTERWEAR definition (`__requirementsEnforced: "ENFORCED"`):
`root.required` = **7** → `Required`; gated by an `allOf` `if/then` = **44** → `Required if
relevant`; the rest = **115** → `Optional`. ⚠ `minItems >= 1` is on **109 of 109** properties — it
is array cardinality, NOT a requirement signal, and reading it that way marks every field
required. Rithum's fourth level, "Best Practice", has no counterpart in Amazon's schema, so it is
never synthesised. Now binds the readiness work in PES.1/2/5 (hub ruling #15).

## 5.5 Verified on prod data, not asserted

`AMAZON · DE / OUTERWEAR`, SKU `GALE-JACKET-BLACK-MEN-L`: 111 fields, 19 mapped, 4 real errors,
and all three preview states round-tripped from the server — a real value (`bullet_point` → the
actual German bullets), an error (`Stofftyp` → *"Field 'Stofftyp' is required."*, status **Mapped**
— Rithum's mapped-AND-errored pairing reproduced), and `empty`. Business rules created, listed,
and deleted through the UI; prod left clean. Light + dark both measured: every pair ≥ 4.5:1 after
swapping the filter banner to `--nds-note-warn-fg/bg` (the obvious `--nds-amber-text` on
`--nds-amber-soft` measures 4.39:1).

**Four bugs found by reading the screen rather than the diff:**
1. Two catalogue fetches raced and the **stale, emptier** one won — the page showed "0 of 111
   mapped" while the API returned 19. Fixed with request-sequence guards.
2. `Content-Type: application/json` on a **bodyless DELETE** → Fastify 400
   (`FST_ERR_CTP_EMPTY_JSON_BODY`). Every delete on the page failed while the button looked fine.
3. Fastify **already percent-decodes route params**; the extra `decodeURIComponent` threw
   `URI malformed` on a business rule named "20% margin" — the Rithum example itself.
4. AG Grid diffs rows by column **value** when `getRowId` is set. A field resolving to nothing has
   an empty preview value before *and* after, so the renderer was never re-invoked and the column
   kept printing the "no preview SKU" dash over real data. `context` changes don't repaint either.

## 5.6 Still open — for the Owner, not done silently

- **§4 Q4 (retirement) stands unanswered by design.** `/settings/mappings`, its canvas, and the
  separate CE.1 engine at `/marketing/content/mapping` (`FeedTransformRule`) are all still live and
  untouched. `/channels/mapping` supersedes the first two functionally; the third is a genuinely
  different engine. Retiring any of them is a decision, not a cleanup.
- **42 products have no `productType`** and therefore resolve against no category at all. Flagged
  by the hub as a data-quality item for missing-required.
- The category mapper's UI is built and works, but has **nothing to map until categories exist**.
