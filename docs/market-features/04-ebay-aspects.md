# 04 — eBay ASPECTS / item specifics

> Read against a tree being edited live. `sheet-columns.service.ts` grew 707 → 966 lines DURING this
> session (AM.1 landing its phase 1). Every citation to that file is from a snapshot taken 2026-09-05
> and kept at `…/scratchpad/sheet-columns.snapshot.ts`; re-read before acting on a line number.

## 1. What it is

eBay's per-category **item specifics** ("aspects"): the structured attributes eBay's Taxonomy API
declares for one leaf category on one marketplace — for GALE·177104·IT, twenty of them (Marca,
Taglia, Colore, Materiale, Caratteristiche, Protezione, Chiusura, Scollatura, Stagione, Paese di
origine …). Each carries five facts the operator must obey: **requiredness** (REQUIRED /
RECOMMENDED / OPTIONAL), **cardinality** (SINGLE vs MULTI), **mode** (SELECTION_ONLY = closed list
vs FREE_TEXT = suggestions only), **variant-eligibility** (may this aspect be a variation axis), and
a **localized name** that is the key eBay actually receives (`Marca`, not `Brand`). The catalogue
operator fills them when first listing a family and re-checks them whenever the category changes or
eBay rejects a push with 25002/25007. Missing a REQUIRED aspect blocks the publish; a thin aspect set
costs search rank. It is the single largest body of eBay-specific data on a listing: **23 Italian-keyed
aspects per GALE child on 247 of 252 IT listings**, and until AM.1 the eBay sheet showed none of it.

## 2. Old UI — inventory

**Entry point:** eBay cockpit tab → `EbayCockpit.tsx:64,568` mounts `<AspectsCard>`.

- `tabs/ebay-cockpit/cards/AspectsCard.tsx` (545 lines).
  - `:130-161` fetches `GET /api/ebay/flat-file/category-schema?categoryId&marketplace=EBAY_<MK>` on
    every `categoryId` change. Server round-trip; no client cache; `null` category ⇒ a hint, no fields.
  - `:167-184` four buckets, each aspect in exactly one: **Required** (rose) → **Variation-eligible**
    (violet) → **Recommended** (amber) → **Optional** (slate). Note the order: a variant-eligible
    aspect that is ALSO recommended lands in the violet bucket, so "Recommended" undercounts.
  - `:189-194` `requiredMissing` — a live count of required-and-empty, rendered as the card's
    readiness chip (`:241-250`).
  - `:196-227` **Save All** → `PATCH /api/ebay/cockpit/aspects` with `{ productId, marketplace,
    aspects: Record<name, string> }`, then `router.refresh()`. Buffered in `dirtyValues`, not
    autosaved. Its own comment concedes the gap: *"EC.5 keeps single-value for substrate; multi-value
    tag input (EC.5b) splits comma-separated entries into arrays"* — **EC.5b never shipped**.
  - `:98-101,121-127` `firstValue()` collapses the stored `string[]` to `v[0]`. **A MULTI aspect's
    2nd..Nth values are invisible in the old editor and are destroyed on the next Save All**, because
    the PATCH sends the single string back and the server wraps it as a one-element array.
  - `:508-544` `AspectInput`: DS `Listbox` for `kind==='enum'`, `<input type=number>`, else a raw
    `<input>`. **`enumMode` (strict/open) is never read** — the card's own `SchemaAspect` interface
    (`:41-51`) omits it, so a SELECTION_ONLY aspect and a suggest-only one render identically.
  - `:435-506` per-aspect Field-Source row: manual / **master** / **sibling** / default, with the
    master resolver in `cards/aspect-master-map.ts` — a hardcoded 30-entry `REGISTRY` of localized
    aspect names in 5 languages → master getters (`:35-82`), matched by splitting `"Marca (Brand)"`
    (`:86-103`). Its own header calls itself a placeholder for a `CategoryAspectMapping` table.
  - `:251-263,360-377` **"AI Suggest"** → `POST /api/ebay/cockpit/ai-improve` `operation:'aspects'`,
    merging suggestions into the dirty buffer for review.
- Field-source state is **localStorage-only**: `field-source/FieldSourceProvider.tsx:51,63`
  (`storageKey(productId, marketplace)`). Which source an aspect draws from never reaches the server.
- `products/_shared/ChannelFieldEditor.tsx` (2456 lines) is the other, generic path:
  `:470-500` fetches `GET /api/products/:id/listings/EBAY/:mk/schema`, `:2138` requires a numeric
  category, `:485-492` renders a nudge on `code:'no_ebay_category'`. Aspects arrive there through a
  **different** converter with **different keys** (§5.1).
- **DEAD / no importer:** nothing in the aspect path is orphaned — `AspectsCard` is mounted and both
  endpoints are live. What is dead is the *capability*: multi-value editing (EC.5b) and the promised
  `CategoryAspectMapping` table.

## 3. Backend that exists

**Routes**
- `GET /api/ebay/flat-file/category-schema` — `routes/ebay-flat-file.routes.ts:543-700`. 24 h
  in-memory cache (`:552-556`); `throwOnError: true` (`:562-566`) so an eBay failure is detectable;
  maps `EbayAspectRich` → `{ id: 'aspect_<localized>', label: 'English (Localized)', localizedName,
  englishName, kind, options, enumMode, required, recommended, guidance, width, variantEligible }`
  (`:578-618`); durable read-through `CategorySchema` upsert under `schemaVersion:'live'`
  (`:645-666`); on an eBay outage serves the stored copy with `staleSchema: true` (`:676-697`).
  🔴 **`cardinality` and `maxLength` are NOT persisted** — see §5.2.
- `PATCH /api/ebay/cockpit/aspects` — `routes/ebay-cockpit.routes.ts:339-399`. Merges into
  `ChannelListing.platformAttributes.itemSpecifics`, normalising every value to `string[]`
  (`:371-383`); an empty array deletes the key; **409 when no ChannelListing exists** (`:357-363`) —
  the category must be picked first. Accepts arrays, so the wire format is already MULTI-capable.
- `POST /api/ebay/cockpit/ai-improve` `operation:'aspects'` — `:1271-1508`. Builds the prompt from
  the live category schema and calls `provider.generate` (`:1487-1497`, feature
  `ebay-cockpit-ai-improve-aspects`). **A live generation call.**
- `GET /api/products/:id/listings/:channel/:marketplace/schema` — `routes/listing-wizard.routes.ts:3148`,
  eBay branch `:3277-3400`, converter `ebayAspectsToUnionFields:83-165`.
- `POST /api/pim/mappings/:channel/:code/sync-schema` — `routes/pim-mapping.routes.ts:236,269` →
  `syncEbayCategoryAspects`. **Manual only; no cron** (§5.2).

**Services**
- `services/ebay-category.service.ts:66-82` `EbayAspectRich` — `dataType`, `mode`, `usage`,
  `cardinality` (`:927`), `variantEligible` (`:928`), `maxLength`, `values`, `englishName` via
  `lookupEnglishAspectName` (`:916,1221`, `Accept-Language: en-US`). `getCategoryAspectsRich:766-930`.
- `services/pim/ebay-schema-sync.service.ts` — unions aspects across the categories the marketplace's
  listings use into `ChannelSchema` as `aspect_<English>` rows; **encodes usage / `multi-value` /
  `variant` / `eBay: <localized>` into a free-text `notes` string** (`:60-72`), upsert `:76-99`.
- `services/pim/channel-specs/ebay.ts` (AM.1, **new today**) — the approved adapter. 24 listing-level
  fields (`:83-113`) + one spec per aspect (`:125-162`): `key = normaliseKey(englishName)`,
  `attribute = aspect_<English>`, `label = localized`, `englishLabel`, `shape: multi ? 'list' :
  'scalar'` with `cardinality {min:1, max:null}` (`:142-146`, no invented max), `mode` from
  `enumMode` (`:148`), `requirement` (`:150`), `variantEligible` (`:154`), and
  `channelStore = { platformAttributes, path: ['itemSpecifics', localizedName] }` (`:157`) — **the
  same store the push reads**. `aspectNames:183-197` recovers both names from `"Marca (Brand)"`.
  Conformance test + real fixture: `__tests__/channel-specs.test.ts:236-274`,
  `fixtures/ebay-it-177104.json`.
- `services/pim/channel-specs/index.ts:122-208` `loadEbaySpec` — reads `CategorySchema` under BOTH
  `IT` and `EBAY_IT`, prefers the row carrying explicit English names (`:158-167`), and falls back to
  the marketplace-wide `ChannelSchema` `aspect_*` rows when no category schema is cached (`:183-204`).
- `services/pim/sheet-columns.service.ts` — channel specs are now the SOURCE of channel columns
  (`:449-506`); `key = f.masterKey ?? normIndex.get(normaliseKey(f.key)) ?? f.key` (`:465-467`) is
  the **aspect ↔ master field map: a normalised-English join, not a table**; `scopeFor:302-309`
  matches the family's `variationAxes` against the key AND every channel label; finalise `:542-620`.
- `services/pim/studio-sheet.service.ts:1120-1137` reads the aspect out of
  `platformAttributes.itemSpecifics[<localized>]`; `:1177` `blockedByAxis = isParent && col.scope ===
  'per_variant'`; `:1174` `writable = cellEditable`; `ebayCategoryIdsFor:754-770` and the wiring at
  `:821-827`.
- `services/pim/readiness.service.ts:107-163` — `requiredBy` → the required list; **only `mode ===
  'strict'` lists are value-checked, and as a WARNING** (`:131-146`).
- Push: `services/ebay-variation-push.service.ts:2472` `buildFlatRow`, `:2657-2662` derives
  `aspect_<localized>` **from `itemSpecifics`**; axis discovery `:285-295`.
  `services/ebay-aspect-preflight.ts:43-67` `findMissingRequiredAspects`, used at
  `routes/ebay-flat-file.routes.ts:2016-2052` — a cache MISS skips the check.
  `services/ebay-family-axes.service.ts:1-64` is the one authoritative axis resolver, and its
  `candidates` list is *variant-eligible schema aspects ∪ aspect keys observed on the children*.
- **Prisma:** `ChannelListing.platformAttributes` (JSONB — `itemSpecifics`, `categoryId`),
  `ChannelListing.overrideData`, `CategorySchema{channel,marketplace,productType,schemaVersion,
  schemaDefinition,fetchedAt,expiresAt,isActive}`, `ChannelSchema{channel,marketplace,fieldKey,label,
  maxLength,required,allowedValues,notes}`, `Product.variationAxes`, `Product.variantAttributes`.
- **Safety gates:** `services/ebay-publish-gate.service.ts:31-46` — publish needs
  `NEXUS_ENABLE_EBAY_PUBLISH`, else `gated`; `EBAY_PUBLISH_MODE` defaults to **`dry-run`**.
- **Permissions** (`lib/auth/permissions-manifest.ts`, first-match-wins): `:339`
  `P(listingsFlatfileEdit, '/api/ebay/flat-file')` — a **fixed** write-level permission, so even the
  GET of `category-schema` demands it; `:354` `RW(listingsView, channelsSync, '/api/ebay')` covers the
  aspects PATCH; `:412` `RW(productsView, productsEdit, '/api/products')` covers the studio sheet.
- **Jobs/crons:** none for eBay aspects. `syncEbayCategoryAspects` fires only from the mapping page.

## 4. Studio today

- **Contract:** `SheetStorage` gained `'listing'` and `SheetColumn` gained `shape` / `cardinality` /
  `slot` / `variantEligible` / `channels[]` (`sheet-columns.service.ts` snapshot `:96-160`).
  `SheetColumnChannelFacts` carries the channel's own `key`, `attribute`, `path`, localized `label`,
  `requirement`, `cardinality`, `mode`, `store` (`:66-90`).
- **eBay aspects ARE columns as of today (AM.1 phase 1, READ-ONLY).** `editable: !listingOnly`
  (`:485`) makes every listing-only eBay field non-editable, with an honest sentence from
  `studio-sheet.service.ts:1183-1185`: *"Read from the listing — editing this channel field lands
  with the next build; the value shown is what the listing holds today."*
- **The drawer already has the section for free.** `drawer/panes/RecordPane.tsx:95-110` groups by
  `SheetColumn.group`, and the adapter emits `group = { key:'aspects', label:'Item specifics',
  channelLabel:"Specifiche dell'oggetto" }` (`channel-specs/ebay.ts:66`). `:117-122` gives every
  collapsed group a "N fields · M required missing" summary.
- **Nothing on the client knows about the new shapes.** `_studio/sheet/channel/types.ts` (the wire
  mirror) has no `shape`, `cardinality`, `slot`, `variantEligible` or `channels` — the mirrored-type
  drift trap. `ChannelSheet.tsx:1004-1028` selects an editor by `kind` only; `CascadeCell.tsx:150`
  paints `String(p.valueFormatted ?? p.value ?? '')`. **A `list` cell therefore renders
  `Antipioggia,Traspirante` with no chips, no count and no separator declaration.**
- **The engine has no list shape at all.** `design-system/grid/editors/` holds `SelectCellEditor`,
  `SelectPanelEditor` (single-select `ListboxPanel` in an AG popup), `FormulaCellEditor` — no chip
  cell, no chip editor. `renderers/` has no list renderer.
- **Parity:** row **3.41 ✅ PARITY (re-graded, ruling #91)** — *"eBay aspects ARE the channel column
  family from `ChannelSchema`, editable as cells with their caps … Verified on screen."*
  Note the grade was taken against the `ChannelSchema` join, before AM.1, and it says *editable*;
  today's columns are read-only until phase 2. Neighbours that bound this feature: **3.40 🕳** (no
  eBay category picker — the aspect SET is unreachable without it), **3.42 ✅** (alias × variant rows
  are the Color × Size matrix), **3.44 🕳** (policies).
- **Rulings that bind:** **#91** (the re-grade above and its line: ✅ = same action on same data,
  seen). **#13** no live AI generation. **#794** the hub stood down; the Owner manages lanes. The
  AM.1 design itself is Owner-approved 2026-09-05 (`docs/2026-09-04-channel-attribute-model-design.md`
  header) with the amendment *no exclusions, no friction in the editor* (§A.3a). Claim 21 (`pes-claims.md:34241-34280`)
  fixes "one concept, one column, keyed by the master key" and names the eBay `aspect_Material` join.

## 5. Defects and slowness

1. **SIX derivations of one aspect schema, four key conventions** — CODE-READ. `ebay-flat-file.routes.ts:578`
   (`aspect_<localized>`), `ebay-schema-sync.service.ts:57` (`aspect_<English>`, facts in prose),
   `field-registry.service.ts:336` (`attr_<localized_snake>`, MULTI in `helpText` prose),
   `listing-wizard.routes.ts:122` (`<snake_case>`, `string_array`), `channel-specs/ebay.ts:129`
   (`normaliseKey(English)`), plus the client's `aspect-master-map.ts:35`. `reference_two_column_builders_drift`
   at scale: the wizard stores `taglia`, the sheet keys `size`, and the same aspect is two attributes.
2. 🔴 **MULTI-ness is carried in a prose string and matched with a regex** — CODE-READ + MEASURED.
   The cached fixture's 20 aspects carry **no `cardinality` field at all** (dumped from
   `fixtures/ebay-it-177104.json`: `cardinality: None` on all 20), because
   `ebay-flat-file.routes.ts:596-618` never persists `a.cardinality` although `EbayAspectRich` has it
   (`ebay-category.service.ts:927`). So `channel-specs/ebay.ts:131` falls back to
   `/multi-value/i.test(row?.notes)` over a `ChannelSchema.notes` string written only by a **manual**
   sync (`pim-mapping.routes.ts:269`). If that sync never ran for a market, **all four MULTI aspects
   silently become scalars** and nothing fails. The adapter's own comment (`:38-39`) says as much.
3. 🔴 **The old editor destroys multi-values** — CODE-READ. `AspectsCard.tsx:98-101,121-127,206-208`.
4. 🔴 **A MULTI aspect cannot be pushed today** — CODE-READ. The push filters
   `typeof v === 'string'` (`ebay-flat-file.routes.ts:2145`, `:2456`; `ebay-variation-push.service.ts:290`)
   and builds `aspects[name] = [val]` — exactly one value (`:2513-2517`). A stored
   `["Antipioggia","Traspirante"]` is **dropped from the payload**, not truncated.
5. 🔴 **`overrideData` is a store no eBay reader reads** — CODE-READ. `grep overrideData
   apps/api/src/services/ebay-*.ts` returns **nothing**; `resolve-channel-field.ts` never reads
   `platformAttributes.itemSpecifics`. §A.4's default ("`overrideData[key]` for everything else")
   would reproduce the bullet-point defect the same doc measured (§1.1 last row: *"A write nothing
   reads"*). The adapter got this right by declaring `channelStore` — the phase-2 write router must
   honour it, not the default. `reference_write_predicate_must_match_its_readers`.
6. **A joined aspect can hide a disagreement** — CODE-READ. `sheet-columns.service.ts:465-467` joins
   eBay `material` onto master `attr_material`, keeping `storage: 'categoryAttributes'`;
   `studio-sheet.service.ts:1124` only falls back to `itemSpecifics` `if (isBlank(base?.value))`. So
   master "Nylon" + listing "Poliestere" ⇒ the sheet shows Nylon, eBay receives Poliestere, and
   `divergence` cannot fire because it is computed for `storage === 'column'` only (`:1037`).
7. **The validators are list-blind** — CODE-READ. `checkEnumValues` does `String(raw).trim()`
   (`listing-preflight.service.ts:189`), so a *valid* strict MULTI value warns as
   `"Antipioggia,Traspirante" isn't an accepted option`; `checkLengthLimits` measures the joined
   string. `isBlank` (`:119`) is correct for lists by accident (`String([]) === ''`).
8. **`enumMode` never reached the old UI** — CODE-READ (`AspectsCard.tsx:41-51`). Strict and open
   render the same control, and `listing-wizard.routes.ts:151` **invents** `maxItems: 20`.
9. **Field-source choice is localStorage-only** (`FieldSourceProvider.tsx:51,63`) — per browser,
   invisible to the server, lost on another machine.
10. **Waterfall + no batching in the old card:** one schema fetch per category change, `router.refresh()`
    after every Save All (`AspectsCard.tsx:221`), whole-cockpit re-render.
11. **Permission mismatch:** the richest aspect endpoint sits behind `listingsFlatfileEdit`
    (`permissions-manifest.ts:339`) while the studio runs on `productsView/productsEdit` (`:412`).
    A studio surface must NOT call `/api/ebay/flat-file/*` directly.
12. **`syncEbayCategoryAspects` reads every eBay listing's `platformAttributes` with no `select`
    narrowing** (`ebay-schema-sync.service.ts:29-32`) then upserts one row per aspect in a loop
    (`:76-99`) — HYPOTHESIS on cost, CODE-READ on shape.

## 6. Proposed home in the studio

### 6.1 Primary home and mirrors

**Primary: H1 — the cell itself, one column per aspect.** AM.1 is approved and already emits them;
the operator's action on an aspect *is* "put a value on this listing for this SKU", which is a cell.
Twenty aspects × twenty-one rows is 420 values; a card that scrolls a form is the wrong instrument for
that and the grid is the right one. This is not a new placement — it is the placement the Owner
approved — so what this report designs is the four things the cell shape still needs (6.3).

**Mirror 1: H7 — the drawer's existing "Item specifics" group.** It costs nothing: `RecordPane`
already groups by `SheetColumn.group` and the adapter already names the group. For the 40-aspect
categories the question was asked about, the drawer is where an operator works down a long list one
field at a time with the full localized label, the guidance sentence and the required count visible —
and the sheet stays live behind it. **A dedicated Aspects PANE is not needed and should not be
built**: a second surface would be a second taxonomy, and `RecordPane`'s per-group
"N fields · M required missing" line already answers "how far through the 40 am I".

**Mirror 2: H2 — one derived status column, `Item specifics`,** reading *"14 of 20 · 1 required
missing"* with the misses in the tooltip. It is the old card's readiness chip (`AspectsCard.tsx:241-250`)
turned into something filterable and sortable across the family — the thing a card could never be.

**Mirror 3: H9 — Errors & Sync,** grouped by cause: *"Required item specific missing — Marca (3 SKUs)"*
and *"Off-list value on a closed aspect (2)"*, each row jumping to the cell. The server already
produces both sentences (`readiness.service.ts:189`, `listing-preflight.service.ts:193-197`) and the
push already refuses on the first (`ebay-aspect-preflight.ts:43`).

**Mirror 4: H6 — a `Pull item specifics` SheetToolbar trailing verb** on an eBay coordinate: read what
the listing holds and stamp it into `itemSpecifics`. Defect 5 and 6 both come from not knowing what
the channel actually holds; parity row 3.4 is the same gap. Not v1.

**H11 — the aspect↔master map does NOT come back as a table.** The join is
`normaliseKey(englishName)` in the column builder (`sheet-columns.service.ts:465-467`), plus explicit
`masterKey` in the adapter (`channel-specs/ebay.ts:159`). Anything beyond that (Genere→gender,
Paese di origine→countryOfOrigin) is a mapping RULE and belongs at `/channels/mapping` — global, one
editor, already built — never in a per-product card. `aspect-master-map.ts`'s 30 entries are the
seed list for those rules, not code to port.

### 6.2 What the sheet shows at rest

| scope | at rest |
|---|---|
| **master** | **nothing.** `scopeKind === 'master' && listingOnly ⇒ continue` (`sheet-columns.service.ts:459`). An aspect that JOINS a master attribute (material, color, size, brand) appears as that master column, once, with eBay's requirement folded into `requiredBy` — one concept, one column (claim 21). |
| **eBay · IT** | one column per aspect in group **Item specifics** (24 listing fields + 20 aspects declared; 3 link to master). Header **English** (`Colour`), `channelLabel` **`Colore`** in the tooltip and in the drawer (D10). Scalar cells as today. `list` cells: **chips**. Required-by-eBay columns carry the required mark and are hoisted into the required block by the shared order rule. Provenance: `channelExplicit` ⇒ ✎ pinned (the value is the listing's own). |
| **Amazon · IT / master·DE** | absent — a coordinate that does not declare the field contributes no column (`mergeSpecField:684-690`). |
| **single-store channels** | Shopify/Woo/Etsy have no aspect concept; their adapters declare their own fields. No eBay column leaks onto them. |

### 6.3 The interaction, step by step

**(a) The MULTI aspect cell — ONE new engine piece, `ChipListCell` + `ChipListEditor`.**
At rest the cell paints the first values as DS `Tag` glyphs plus a `+N` DS `Pill` when they overflow
the width, and the tooltip carries the full list **one per line with the separator named** — the
`reference_composed_string_invisible_separator` rule, which today's `String(value)` breaks outright
(`CascadeCell.tsx:150`). Empty ⇒ the engine's `EmptyValue`, never `""`.
Open: **double-click or type** (§5.5 gesture map), guarded by the fill-handle trap
(`reference_ag_fill_handle_swallows_dblclick`). `cellEditorPopup: true`, built exactly as
`SelectPanelEditor` is — AG owns Enter/Tab/Esc (`reference_ag_popup_editor_owns_keys`), the DS popover
owns the geometry, and the value reaches the grid **only** through `props.onValueChange`
(`reference_ag36_react_editor_onvaluechange`).
Inside the popup, by `mode`:
- **strict + options** ⇒ DS **`MultiSelect`** (`components/MultiSelect.tsx:13-38`, `value: string[]`,
  `onChange(next)`) over `OptionList`. Off-list values cannot be typed.
- **open + options** (16 of the 20 on 177104) ⇒ the same `MultiSelect` **plus a "use what I typed"
  row**, so eBay's suggestions are offered and a custom value is still accepted. This is the
  measured majority case and the one the old card got wrong.
- **no options** ⇒ DS **`TagInput`** (`primitives/TagInput.tsx`), free chips.
`cardinality.max === null` ⇒ **no cap and no counter** — the adapter records `null` rather than
inventing a maximum (`channel-specs/ebay.ts:144-146`), so the UI must not invent one either
(`reference_api_accepts_a_flag_it_ignores` in reverse: do not display a limit the channel never set).
Commit → `onValueChange(string[])` → `valueSetter` **mutates `params.data`**
(`reference_ag_value_setter_must_mutate_params_data`) → ONE `sheetWriter` autosave with
`expectedVersion`. Repaints: the cell's chips, its provenance mark, its readiness class, the
`Item specifics` status column, the scope chip, and the Errors & Sync count — all from the one
response, no second read.

**(b) Strict vs open.** `mode: 'strict'` narrows the editor AND is the only mode readiness checks —
and it checks as a **WARNING, never a block** (`readiness.service.ts:141-145`, `selectionOnly: false`
with the policy stated in the comment). That is right for eBay: a closed list eBay published
yesterday can be stale, and blocking a save on it would be the "resistance" §A.3a forbids. `mode:
'open'` is offered as suggestions and never warns.

**(c) The localized label in the tooltip.** `composeCellTooltip` already takes ordered lines
(`ChannelSheet.tsx:1046-1050`). Add one line, first: **`Colore — eBay · IT sends "Colore"`**, from
`col.channels['eBay · IT'].label` (`SheetColumnChannelFacts.label`). This is load-bearing, not
decoration: the localized name IS the wire key (`channelStore.path[1]`), and an operator debugging a
25002 needs to see it. The RECOMMENDED sentence the adapter already writes
(`channel-specs/ebay.ts:156`) is the second line; caps/validation follow as today.

**(d) The "required by this category" mark.** No new mechanism: `requirement: 'required'` ⇒
`requiredBy.push('eBay · IT')` (`mergeSpecField:684-686`) ⇒ the engine's existing required class and
the message *"Marca is required by eBay · IT"* (`readiness.service.ts:189`). The one addition owed is
the **`requiredIfRelevant`** level the adapter already emits for RECOMMENDED aspects (`:150`): it must
paint as a distinct **soft** mark (the old card's amber rim), never as an error and never as nothing.
Requiredness is **per category**, so a family listed in two leaves shows `categories: [...]` in the
tooltip — `mergeSpecField:673` already collects them.

**(e) With the drawer open** the sheet stays live (§5, non-modal): editing a chip cell in the drawer's
Item specifics group and editing it in the grid go through the same `sheetWriter` and repaint both.

### 6.4 Per-scope rules

- **Alias band row (`rowKind: 'parent'`)** — an aspect that is one of the family's axes is **LOCKED**
  (6.5). A non-axis aspect on the band is the listing-wide value and every variant follows it;
  editing it there is a `CONTEXT(alias-group)` write, exactly as other channel fields behave today.
- **Variant rows** — a per-variant aspect is editable only here.
- **Two categories in one family** — the union of both aspect sets; each column names its declaring
  categories; requirement is the stricter (`mergeSpecField:677-679`).
- **Market channels vs single-store** — aspects are per (marketplace × category); the localized label
  and the strict option lists differ per market (`reference_contract_field_varies_by_market`), which
  is why the label must come from `channels[coord].label` and never from a parsed string.

### 6.5 Provenance / autosave / readiness / publish — and the per-VARIANT lock

**A per-VARIANT aspect (Taglia / Colore) is locked on the parent row by `scope: 'per_variant'`, and
the mechanism is already on the server:**

1. `channel-specs/ebay.ts:154` sets `variantEligible: true` from eBay's `aspectEnabledForVariations`
   (`ebay-category.service.ts:928`). **`variantEligible` alone does NOT lock anything** — Scollatura
   is variant-eligible on 177104 and is not an axis of GALE.
2. `sheet-columns.service.ts:543` builds `labels = [channelLabel, …channels[*].label]` and
   `scopeFor(d.key, labels, axes)` (`:302-309`) returns `per_variant` when the aspect's key OR **any
   of its labels** normalises into the family's `Product.variationAxes`. The localized label is why
   this works: GALE's axes are stored Italian (`Colore`, `Taglia`) while the column key is English
   (`color`, `size`) — matching English only would silently make every axis `global`, the exact
   regression the old `scopeFor`'s comment records.
3. `studio-sheet.service.ts:1177` `blockedByAxis = isParent && col.scope === 'per_variant'` ⇒
   `cellEditable = false` ⇒ `writable: false` on the wire (`:1174`), plus the sentence *"Set on each
   variant — this is a variation axis, so the family row has no single value."* (`:1191-1194`).
4. The client already honours it: `isCellEditable` gates AG's `editable`, and the SAME predicate
   paints `nds-cell-is-locked` (`ChannelSheet.tsx:1031-1034,1125-1126`) with the refusal spoken via
   `refusalWords` (`:1707-1732`). **What is missing on the channel scope is only the reason CLASS:**
   the channel branch knows `channel-not-writable` / `column-read-only` / `cell-locked` but not
   `per-variant-on-parent`, which exists on master (`master/columnRules.ts:81`,
   `refusalWords.ts:60-61`). Wire the server's `cellBlockedReason` through instead of re-deriving it —
   `reference_write_predicate_must_match_its_readers`.
5. Axis VALUES are already the alias band's second identity line (`ChannelSheet.tsx:1589-1590`), and
   `ebay-family-axes.service.ts` remains the one authority for which aspects are axes at push time —
   the sheet must not become a second one.

**Provenance:** an aspect read from `itemSpecifics` is `source: 'channelExplicit'` ⇒ ✎ pinned, not
🔗 inherited, because the value is the listing's own. A joined aspect whose master and listing values
disagree must paint ⚠ + `divergence` (defect 6) — a silent preference is the honest-UI rule broken.
**Autosave:** one `sheetWriter` path, `expectedVersion`, nav guard (`reference_autosave_still_needs_a_nav_guard`);
re-read after ≥ 8 s before believing a read-back (`reference_read_before_the_write_arrived`).
**Publish:** eBay stays **preview-only** (`ebay-publish-gate.service.ts:31-46`, `dry-run` default).
`AliasPublishControl` → `POST /api/products/sheet/publish-preview` must show the aspects it would
send, and the preflight must be `findMissingRequiredAspects` — the same function the push uses, not a
re-derived twin.

### 6.6 Mockup

```
eBay · IT — GALE-JACKET                       group ▸ Item specifics (20)
┌──────────────────────┬──────────┬──────────┬─────────────────────────────┬───────────┐
│ SKU / alias          │ *Brand   │ Colour   │ Features            [list] │ Season    │
├──────────────────────┼──────────┼──────────┼─────────────────────────────┼───────────┤
│ ▾ ① Giacca GALE  ⋯   │ Xavia ✎  │ ▒locked▒ │ ⟨Antipioggia⟩⟨Traspirante⟩ │ Inverno ✎ │
│   GALE-…-BLACK-M     │ Xavia 🔗 │ Nero ✎   │ ⟨Antipioggia⟩ +2           │ 🔗        │
│   GALE-…-BLACK-XXS   │ Xavia 🔗 │ Nero ✎   │ —                       ⚠  │ 🔗        │
└──────────────────────┴──────────┴──────────┴─────────────────────────────┴───────────┘
 ▒locked▒ → "Colour is set on each variant — this is a variation axis, so the
             family row has no single value."
 hover *Brand → "Brand — eBay · IT sends «Marca» · Required by eBay · IT"

 double-click Features ──▶ ┌ Features · eBay · IT sends «Caratteristiche» ──┐
                           │ suggestions (open list — type your own)        │
                           │ ☑ Antipioggia      ☑ Traspirante               │
                           │ ☐ Impermeabile     ☐ Antivento                 │
                           │ ⌕ ricicl▏          ＋ use "riciclato"          │
                           │ ⟨Antipioggia ×⟩⟨Traspirante ×⟩                 │
                           │ eBay sets no limit on this aspect              │
                           └────────────────────────────────────────────────┘
```

## 7. Contracts and data

**Reused unchanged:** `GET/POST /api/products/studio/sheet` (columns + cells; AM.1 already serves
aspects), `PATCH /api/products/bulk` (the one write path), `POST /api/products/sheet/publish-preview`,
`services/pim/readiness.service.ts`, `ebay-aspect-preflight.ts`, `ebay-family-axes.service.ts`.
**Not called from the studio:** `/api/ebay/flat-file/category-schema` (permission mismatch, defect 11)
and `PATCH /api/ebay/cockpit/aspects` (product-scoped, 409-on-no-listing, single-value semantics).

| # | change | additive? | lane |
|---|---|---|---|
| 1 | Persist `cardinality` **and** `maxLength` in the aspect record the category-schema route writes (`ebay-flat-file.routes.ts:596-618`) — the value is in hand at `ebay-category.service.ts:927`. Removes the prose-regex dependency (defect 2). One field, no migration. | yes | PES.5 / AM.1 |
| 2 | `SheetColumnChannelFacts` → surface `variantEligible` and `categories` to the client; add `shape`/`cardinality`/`slot`/`variantEligible`/`channels` to the studio's channel `types.ts` mirror. | yes | PES.5 + PES.3 |
| 3 | Phase-2 write router: an `attr_*`/aspect cell on a channel scope routes to `channelFacts.store` (`platformAttributes.itemSpecifics[<localized>]`), **never** the `overrideData` default — one predicate, the readers' own (defect 5). | yes | PES.5 |
| 4 | `divergence` for `storage !== 'column'`: master bag vs `itemSpecifics` (defect 6). | yes | PES.5 |
| 5 | List-aware validators: `checkEnumValues` / `checkLengthLimits` evaluate **each element** (defect 7). | yes | PES.5 |
| 6 | Push accepts arrays: `aspects[name] = string[]` at `ebay-flat-file.routes.ts:2513` and drop the `typeof v === 'string'` filters (defect 4). **Touches the live push — Owner sign-off, dry-run witness first.** | yes | PES.5 |
| 7 | Engine: `ChipListCell` + `ChipListEditor` (the ONE new DS/engine component this feature needs), `popup:chips` added to `scripts/check-editor-open.mjs:649-650` and to the `parity` block. | new | PES.2 |
| 8 | Channel sheet: chip column wiring, the localized-label tooltip line, the `requiredIfRelevant` soft mark, and the `per-variant-on-parent` reason class relayed from the server. | — | PES.3 |
| 9 | Seed `/channels/mapping` rules from `aspect-master-map.ts`'s 30 entries; retire the file. | yes | PES.6 |
| 10 | `Item specifics` H2 status column + Errors & Sync causes. | yes | PES.3 / PES.5 |

No schema migration. §A.5's `EBAY_IT` → `IT` re-key is already handled by `loadEbaySpec` reading both
codes (`channel-specs/index.ts:125,154`), so it is a tidy-up, not a prerequisite.

## 8. Risks and traps

- 🔴 **Every eBay listing in the fixture family is LIVE and local dev writes PROD.** An aspect write is
  a content write; a `blur` on a chip editor commits (`reference_endpoint_safety_is_not_interaction_safety`).
  Verify with `writable: false` still in force, or on a probe value inside the fixture family
  (`reference_transport_failure_write_is_unknown_outcome`).
- 🔴 **Do not enable eBay publish.** `EBAY_PUBLISH_MODE` default `dry-run`, gated by
  `NEXUS_ENABLE_EBAY_PUBLISH`. Preview only; the mode comes from the SERVER, never env read in the UI.
- 🔴 **Item 6 touches the live push.** `ebay-flat-file.routes.ts` is the flat-file editors' server.
  The web flat-file trees are untouchable; the push path is shared and must be changed once, with a
  dry-run witness, and never forked.
- 🔴 **A 25002/25007 is a REQUIRED-aspect refusal.** `ebay-aspect-preflight.ts` **skips the check on a
  cache miss** (`ebay-flat-file.routes.ts:2029-2036`) — a green preflight can mean "not measured".
  `reference_could_not_measure_vs_measured_empty`.
- **`variantEligible ≠ per_variant`.** Locking on the former would freeze Scollatura on every parent.
- **AI dark (#13):** the `ai-improve` aspects route makes a real `provider.generate` call
  (`ebay-cockpit.routes.ts:1487`). Do not port the "AI Suggest" button; ✦ AI-draft provenance +
  PES.8's draft review is the honest surface.
- **Column count:** eBay·IT goes 35 → ~76 columns and the sheet lands FULL (views design §88).
  Column virtualisation must stay ON and the §4a budgets re-measured as a before/after pair.
- **`MultiSelect` / `OptionList` / `GridSetFilter`**: use the shared `OptionList` family, not a fourth
  copy (`reference_ds_option_list_two_copies`).
- **Row 3.40 (no category picker) gates this feature's reach:** the aspect SET follows the eBay
  category, and today the studio cannot change it.
- **Amazon EU shared quantity / per-channel oversell / images-per-ASIN**: not touched — aspects are
  content only.

## 9. Open questions for the Owner (max 3)

1. **A joined aspect (Material, Colour, Size) on the eBay scope — does the CHANNEL store win?**
   *Recommend yes:* on a channel scope the cell must show and write what eBay holds
   (`itemSpecifics`), with a ⚠ + `divergence` line whenever master disagrees. Showing master's value
   while eBay ships something else is the honest-UI rule broken, and it is today's behaviour.
2. **Do we fix the push to accept multi-value aspects now (item 6), or ship the chip cell read-only
   until then?** *Recommend fixing it in the same change:* a chip editor over a push that drops the
   2nd..Nth value is a surface that lies. Producer and consumer land together
   (`feedback_producer_and_consumer_land_together`). One dry-run witness on GALE·IT before anything is
   enabled.
3. **Does "Item specifics" belong in the landing view, or behind a preset?** *Recommend in the
   landing set* (the views design's ground state is All attributes) with an **eBay content** preset
   that carries the required aspects first; the drawer's Item specifics group stays the depth surface
   for a 40-aspect category.

## 10. Effort and dependencies

| piece | size | depends on |
|---|---|---|
| Persist `cardinality`/`maxLength` in the aspect cache (item 1) | **S** | — (do first; everything MULTI rests on it) |
| Client contract mirror + `variantEligible`/`categories` on the wire (item 2) | **S** | item 1 |
| `ChipListCell` + `ChipListEditor` + gate shape (item 7) | **M** | items 1–2; PES.2's editor shell; `reference_ag36_react_editor_onvaluechange` |
| Chip column wiring, localized-label tooltip line, soft required mark, per-variant reason class (item 8) | **M** | items 2, 7 |
| Phase-2 write router honouring `channelStore` (item 3) | **M** | AM.1 phase 2 (in flight) |
| List-aware validators + bag/`itemSpecifics` divergence (items 4–5) | **M** | item 1 |
| Push accepts arrays (item 6) | **M** | Owner sign-off; dry-run witness |
| `Item specifics` status column + Errors & Sync causes (item 10) | **S** | items 4–5 |
| Mapping rules seeded from `aspect-master-map.ts` (item 9) | **S** | PES.6 |

**Cross-feature dependencies:** the eBay **category** feature (parity 3.40) — the aspect set is a
function of the category, so a category cell/picker unlocks the rest; the **variation matrix** (3.42)
shares `ebay-family-axes.service.ts` and must stay the one axis authority; **description / theme**
shares `descriptionThemeId`, already a listing-level column in the same adapter; **policies** (3.44)
are the other three listing-level ids the adapter emits. AM.1 (`nexus-commerce-5c`) owns the server
adapter and is mid-build — none of this competes with it; items 1–6 are its phase-2 list, items 7–8
are the engine and sheet work it explicitly leaves to PES.2/PES.3 (§6 of the design doc).
