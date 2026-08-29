# The Master Sheet — design (GDS-4)

**Status:** designed in the DS and prototyped in the grid lab (`/design/grid-lab?tab=gds#sheet`). §8 decisions taken by the Owner 2026-08-29. **MS.1 + MS.2 (the reads) and MS.3 (the component) are BUILT** — see §9 and §10. Where the sheet lives is still open and blocks only the mount.

**Ask (2026-08-28):** "a proper grid where I can actually make changes cell by cell. That would be used as the source of data, which would then be mapped, converted, or directly pushed to multiple channels of a specific market."

---

## 1. The approach, in one paragraph

The sheet **is the master**. One row per product or variation; one column per master attribute; one market at a time. Every cell edit writes the master record (per cell, with the server's answer painted on the cell). Nothing on the sheet writes a channel: channels are **projections** of the master — the existing resolver (`attribute-resolver.ts` → `resolve-channel-field.ts`, `Marketplace.schemaMapping` rules, `ChannelListing.followMaster*` flags) turns master values into what Amazon IT, eBay IT or the webstore expects, and the existing push routes send them. The sheet shows, beside the master cells, **what each channel would do with the row right now** (readiness per channel × market) and a **Publish** action per channel that sends the selection and paints each row's answer. So the operator edits ONE place, sees every channel's verdict live, and pushes when the verdicts are green.

This is the "live Products sheet" the FF0 v2 workbook spec already describes for a market (`field@MARKET` columns, follows-master control column FFD10), rebuilt as a grid instead of a file: same columns, same precedence, no export/import round trip, no stale copy.

## 2. What the research settled

| Source | What it settled |
|---|---|
| **Our own master model** (`Product` parent/child, `variantAttributes`, `categoryAttributes` JSONB, `localizedContent[locale]`; `ChannelListing` per product × channel × marketplace with `followMaster*` + `*Override` + `overrideData` + `platformAttributes`; `Marketplace.schemaMapping` rules `{source, fallback, transforms}`) | The data model already IS a master-with-projections model. The sheet needs no new tables — it needs a read that returns the master row with per-channel resolution beside it, and per-cell writes to the master. |
| **The flat-file trust runbook (Z1–Z3)** and the FlatFileGrid behaviours | Local draft, read-back verify, per-SKU results that jump to the cell, strict-enum "warn never block", explicit publish with preflight. The sheet keeps every one of these (see §5) — they were earned on real Amazon refusals. |
| **FF0 v2 workbook spec** | Per-market sheet; `field@MARKET`; follows-master is a CONTROL COLUMN, not a hidden flag; 50-ish columns is the practical ceiling before operators lose the row. |
| **Shopify bulk editor** | Cell-by-cell editing with fill handle; **explicit Save**, and unsaved state shown per cell; validation inline, never a modal. |
| **Akeneo PIM** | The two axes of a product sheet are **channel** and **locale**; a *completeness* score per channel × locale drives the operator; attribute groups as column groups; ~50 visible columns cap, everything else through a column picker. |
| **Amazon product-type definitions** | The canonical attribute schema per product type per marketplace is Amazon's JSON schema; enums, required-ness and length caps are per marketplace. The master schema is derived from the union of the channel schemas the product is listed on — Amazon's is the most demanding and so the spine. |
| **xaviaracing.it** (the Owner's own catalogue) | Motorcycle apparel: jackets, gloves, rainwear; families are **colour × size**; the attributes that matter are protection level (CE 1/2), EN 17092 garment class, waterproofing, outer material, season, gender; markets IT/EN/FR/ES/DE; content is per language. The fixture in the lab is this shape (GALE, MISANO, AIREON, XRI01). |

## 3. The sheet's model

```
market: IT                                 ← one market per sheet; a switcher changes it
row    : Product (parent)  |  Product (variation: colour × size)
column : one master attribute, or one control (follows-master), or one projection (readiness)
cell   : the MASTER value for that row + attribute, in the market's locale where localised
```

**Inheritance.** A `global` attribute (title, material, protection level, origin…) lives on the parent; every variation shows it **tinted** (`.nds-cell-is-inherited`) and can pin its own value by editing the cell. A `per_variant` attribute (colour, size, EAN) lives on the variation; on the parent row it is **locked** (not flagged). Editing a parent's global attribute repaints the whole family.

**Follows master.** A channel-facing value that can diverge per market (price, and later stock rules, title overrides) has TWO cells: the effective market value, and a `Follows master | Pinned` control beside it. Editing the market value pins it; setting the control back to *Follows master* clears the override. This is `ChannelListing.followMasterPrice` + `priceOverride` made visible, exactly as FFD10 specifies.

**Readiness.** One column per channel **coordinate** in this market: `Ready` · `Missing · n` · `Errors · n` · `Live · <channel id>` · `Unlisted`, each with the issues on hover. Computed server-side, never by the grid, and it recomputes on every cell edit — that is the feedback loop that makes the sheet worth using.

> **A market is a coordinate LIST, not a filter (verified 2026-08-29).** There is no `Market` entity: `"IT"` is a
> string on `Marketplace.code` and on `ChannelListing.marketplace`, and the webstore channels (Shopify, Woo, Etsy)
> are seeded at `marketplace = 'GLOBAL'`, not `'IT'`. So "market IT" is `[{AMAZON,IT}, {EBAY,IT}, {SHOPIFY,GLOBAL}]`
> — the switcher resolves a market name to that list, and `Marketplace.language` ('it') selects the content locale.

> **No existing readiness call is batch AND market-aware AND schema-driven** — you get two of three:
> `POST /api/products/listing-health/bulk` (batch + market, but a 3-field heuristic), `POST /api/products/channel-readiness/bulk`
> (batch, no marketplace, hardcoded minimums), `validatePublish` (schema-driven + market, 3–4 queries per product).
> The sheet's readiness is therefore composed (MS.2) from the PURE validators, not from any one of these.

**Completeness.** The Akeneo number: filled ÷ applicable master attributes, per row. Frozen beside the identity so the operator can sort by it.

## 4. Column model (market IT, product type "Motorcycle jacket")

| Group | Columns | Notes |
|---|---|---|
| **frozen** | ☐ · Product (P/C chip, tree) · SKU 🔒 · Status · Master % | Checkbox first, always. Identity never scrolls away. |
| **Content · IT** | Title · Bullet 1–5 · Description · Search terms | Long-text cells with a live counter against the **tightest cap across the channels the row is listed on**; `agLargeTextCellEditor` popup. |
| **Attributes** | Brand · Gender · Colour · Size (EU) · Outer material · Protector level · EN 17092 class · Waterproof · Season · Origin · … | From the master schema for the product type. Select cells use the DS Listbox; `strict` lists WARN on an off-list value (amber, corner triangle), `open` lists accept. Required cells show `⚠ required` when empty. |
| **Identifiers** | EAN | Per variation; refused by the server when malformed (the refusal paints the cell red with the reason). |
| **Pricing · IT** | Base price · Price · IT · Follows | Euro editors; the follows-master control. |
| **Readiness · IT** | Amazon · IT · eBay · IT · Shopify | Read-only projections; recompute on every edit. |
| **Channel ids 🔒** | ASIN · eBay item · Images | Synced from the channels; never edited here. |

Column groups are AG header groups (`marryChildren`), 30px group strip over the 28px compact header. Column visibility beyond ~50 goes through the DS Customise dialog (`useGridState`), per operator per surface.

## 5. Cell states and the editing contract

| State | Class | Looks like | Means |
|---|---|---|---|
| editable | `.nds-cell-is-editable` | subtle affordance on hover | the cell writes the master |
| inherited | `.nds-cell-is-inherited` | tinted text | value comes from the parent; edit to pin |
| locked | `.nds-cell-is-locked` | muted, no editor | synced from a channel, or not applicable on this row |
| required | `.nds-cell-required` | `⚠ required` | empty and a listed channel needs it |
| warned | `.nds-cell-is-warned` | amber tint + corner triangle | accepted, a channel may reject (off-list) |
| invalid | `.nds-cell-is-invalid` | red tint + corner triangle | a channel WILL refuse (over cap, malformed) |
| saving | `.nds-cell-is-saving` | primary tint | the write is in flight |
| saved | `.nds-cell-is-saved` | success tint, fades in 1.5 s | the server accepted |
| refused | `.nds-cell-is-refused` | red tint, reason on hover, stays | the server refused; the value on screen is NOT on the server |

Keyboard (from `SHEET_GRID_OPTIONS`, shared by every sheet): click selects · type / F2 / Enter edits · Enter commits and moves DOWN · Tab moves RIGHT · Esc reverts · drag the corner to fill · ⌘C / ⌘V move cells · ⌘Z / ⌘⇧Z (200 steps). Paste from Excel with a header row is **matched by header name** (`sheetPasteProcessor`), so column order in the spreadsheet does not matter.

The status strip (`GridSheetStatus`) always shows: rows · selected · unsaved cells · refused cells · last saved time.

## 6. Saving and trust

* **Per-cell autosave to the master.** The write is one cell; the answer is painted on that cell (`saveCell` → `CellSaveTracker`). A refusal is a RESULT (red, reason on hover), never a toast, never an exception; it stays until the cell is edited again. The sheet is therefore never "dirty as a whole" — the strip's *unsaved / refused* counts are the truth.
* **Publish is explicit and per channel × market.** *Publish → Amazon · IT* sends the selection (or every ready row when nothing is selected) through the EXISTING routes (`/api/products/:id/publish-amazon`, `/api/amazon/flat-file/submit`, `/api/ebay/flat-file/push`) and paints each row's answer: the channel's id arrives and the readiness cell reads `Live · B0…`; a refusal reads `Errors · n` with the channel's message. Nothing is pushed by editing a cell.
* **Read-back verify** (Z2/Z3) stays on the push path, not on the sheet.

## 7. What the API already has, and what MS.* must add

> Verified against the code 2026-08-29 (not against the docs — see the correction below). The first draft of this
> section listed five green-field endpoints; most of that work is already done, and one of the docs I was reading
> describes code that no longer exists.

**🔴 Correction — Phase 30 "reactive attribute inheritance" is documentation only.**
`docs/PHASE30-REACTIVE-ATTRIBUTE-INHERITANCE.md` describes `attribute-inheritance.service.ts`, `attribute-inheritance.routes.ts`
and `/api/attributes/{sync-parent,lock,bulk-lock,locked/:id}`. **None of them exist**: they were deleted in `c354e1cc6`
("remove orphan files exposed by the Express bundle removal"). What survives is `ProductVariation.lockedAttributes`
— a dead column on a model the schema itself marks deprecated ("variants live as child Product rows") — and an
orphaned `apps/web/src/components/catalog/AttributeLockToggle.tsx`. **There is no per-attribute lock in the running
system.** What actually implements inheritance is two different things:
1. **read-time resolution** — `resolveAttributes()` layers parent → variant → channel and rewrites nothing;
2. **write-time cascade** — `PATCH /api/products/bulk` with `cascade: true` physically writes a value into every
   child and appends the field to `Product.cascadedFields[]`. It is per-change and has no per-child opt-out.

So the sheet's *inherited → edit to pin* is **read-time resolution + a normal per-cell write to the child**: editing a
variation's cell simply gives that child its own value, which then wins in `resolveAttributes`. No lock table needed.

### Already built — reuse verbatim, do not fork

| Need | What exists | Where |
|---|---|---|
| **Cell-by-cell autosave** | `PATCH /api/products/bulk` — `{changes:[{id, field, value, cascade?}], marketplaceContext(s), expectedVersion}`; **300 req/min, commented "multiple PATCHes per second when a user is typing through 50 cells"**; per-cell structured errors `{id, field, error}`; `attr_*` → `categoryAttributes` batched jsonb merge; 409 `VERSION_CONFLICT`; writes a `BulkOperation` audit row and refreshes `ProductReadCache` | `routes/products.routes.ts:964` |
| **Columns per productType × market** | `getAvailableFields({productTypes, marketplace, channels, ebayCategoryIds})` → `FieldDefinition[]`, served as `GET /api/pim/fields` (`max-age=300`) | `services/pim/field-registry.service.ts:253`, `routes/products.routes.ts:60` |
| **Length caps + enum labels + per-type applicability** | `FlatFileColumn` — the richest column descriptor in the repo (`maxLength`, `maxUtf8ByteLength`, `optionCodes`, `optionsByProductType`, `requiredForProductTypes`, `applicableParentage`, `guidance`, `deprecatedOptions`), served by `GET /api/amazon/flat-file/union-template?marketplace=IT&productTypes=…` | `services/amazon/flat-file.service.ts:64`, `routes/amazon-flat-file.routes.ts:310` |
| **eBay aspect caps** | `ChannelSchema {channel, marketplace, fieldKey, label, maxLength, required, allowedValues}` | `schema.prisma:14137`, `ebay-schema-sync.service.ts:22` |
| **Master → channel resolution** | `resolveAttributes(input)` → `{value, source, inheritedFrom}` per key, and `resolveChannelField(...)`. **Both PURE, no DB** — load 50 rows in 3 `findMany`s and call them in-process | `pim/attribute-resolver.ts:211`, `pim/resolve-channel-field.ts:489` |
| **Row + one listing, in bulk** | `GET /api/products/bulk-fetch?channel=&marketplace=&productIds=` — 1000-id cap, returns `categoryAttributes`, `variantAttributes`, `productType`, `cascadedFields` + `_channelListing {title, description, price, quantity, listingStatus, platformAttributes}` | `routes/products.routes.ts:209` |
| **Publish preflight rules** | `listing-preflight.service.ts` — `findMissingRequired`, `checkLengthLimits`, `checkEnumValues`, `checkDeprecatedValues`, `checkRequiredWithParent`, `validateParentChildBatch`. **All pure and batchable**, `PreflightIssue {severity:'error'\|'warning'}` | `services/amazon/listing-preflight.service.ts` |
| **Publish** | `POST /api/products/:id/publish-amazon {marketplaces[], dryRun}` (multi-market, one product) · `POST /api/amazon/flat-file/submit {rows[]}` (**batch, 2000 rows**) · `POST /api/ebay/flat-file/publish {rowIds[], markets[]}` (**batch × batch**) | `amazon-cockpit-publish.routes.ts`, `amazon-flat-file.routes.ts:365`, `ebay-flat-file.routes.ts:3286` |
| **Master attribute schema (per product)** | `getMasterAttributeSchema(productId)` → `MasterAttribute[]` + the MA.2 editor that renders it | `pim/master-schema.service.ts:110`, `tabs/_shared/MasterAttributesEditor.tsx` |

### To build

| # | What | Why it can't be reused as-is |
|---|---|---|
| **MS.1** | `GET /api/products/sheet/columns?market=IT&productTypes=…` → `SheetColumn[]` — one merge of `getAvailableFields` (the field set) + the Amazon union manifest (`maxLength`, enums, per-type applicability) + `ChannelSchema` (eBay caps), stamped with `scope: global\|per_variant` and `requiredBy: channel[]` | `getMasterAttributeSchema` is **per product**, does N `getAvailableFields` + a `getResolvedRules` per coordinate + up to 2 enum-label calls — **hundreds of round-trips for a 50-row page** — and it *unions* the product's Amazon markets, so an IT sheet would over-report DE-only attributes. `maxLength` is **dropped** by `schema-to-fields.ts`, so the counter cells have no cap without the flat-file manifest. |
| **MS.2** | `GET /api/products/sheet?market=IT&…` → rows with own + resolved values, `source` per cell, refs, per-coordinate readiness, completeness | Nothing returns N products × M attributes for a market. Composed from `bulk-fetch`-shaped loads + the **pure** resolvers + the **pure** preflight validators — 3 queries, no per-row fan-out. |
| **MS.3** | *(none — reuse `PATCH /api/products/bulk`)* | It is already the cell path, rate-limited for typing, with per-cell errors. The sheet's `saveCell` sends one `changes[]` entry. |
| **MS.4** | Follows-master **for the six flagged fields only** | `followMaster*` covers only `title, description, price, quantity, images, bulletPoints`. **JSONB attributes have no flag** — a per-channel attribute override lives in `overrideData` with nothing to toggle, so for attribute cells "follows master" is *derived* from `resolveAttributes().source ∈ {channelOverride, channelExplicit}`, and `FollowsCell` appears only where a real flag exists. |
| **MS.5** | `POST /api/products/sheet/publish {ids, coordinate}` → per-row results | A thin fan-out over the existing per-channel routes; batch already exists on both flat-file paths. |
| **MS.6** | Optimistic concurrency on the attribute write | `PATCH /products/bulk` honours `expectedVersion`/409; the sheet must send it so two operators on one row cannot silently overwrite each other. |

**Not touched:** the Amazon and eBay flat-file editors. They are the closest existing surface (`union-template` for columns + `flat-file/rows` for rows) but they are per-channel×market and write `ChannelListing.flatFileSnapshot`; the master sheet is their master-first sibling and sits **beside** them.

## 8. Decisions (Owner, 2026-08-29)

1. **Autosave per cell — DECIDED.** Every cell edit writes the master immediately and paints that cell with the
   server's answer (`saving → saved | refused`). Publish stays explicit and separate. There is no page-level Save
   button and no "dirty sheet" state — the strip's *unsaved / refused* counts are the only truth.
2. **One sheet per market, with a market switcher — DECIDED.** The sheet's primary axis is the market. The switcher
   changes BOTH axes at once: the market (pricing, follows-master, channel listings, readiness) and the locale of
   the content columns (market IT → Italian content). No `field@MARKET` wide sheet.
3. **Where it lives — STILL OPEN (Owner deciding).** *Blocks only the mount.* The sheet is built as a
   self-contained `<MasterSheet market="IT" />`; wherever it lands is a one-line mount. Recommendation stands: a
   "Sheet" tab on /products sharing the list's selection, filters and Customise dialog — never a new route.
4. **IT first — DECIDED.** The IT market is built and verified end to end before a second market is switched on.

---

## Appendix — what is in the DS after GDS-4

`design-system/grid/`: `hosts/GridSheet` (+ `SHEET_GRID_OPTIONS`, `GridSheetStatus`, `height` for embedded use), `renderers` `LongTextCell` · `ReadinessCell` · `FollowsCell`, `editors/sheet` `longTextEditor` · `sheetClassRules` · `selectValidation` · `lengthValidation` · `matchPasteToHeaders` · `sheetPasteProcessor`, `NexusGrid fill`, cell-state CSS (`.nds-cell-is-invalid/-warned/-inherited`, `.nds-cell-required`, `.nds-cell-longtext*`, `.nds-cell-follows*`). Lab: `#sheet` on a XAVIA fixture (4 families, 38 variations, market IT); conformance probe `sheet: compact`.

Verified in the browser 2026-08-29: EAN `12345` → saving → **refused** (red, "Refused: an EAN is 13 digits", strip "1 refused"); corrected → saved → "Saved 05:07", eBay readiness Errors → Live; Origin select on a variation → own value, inherited tint gone; Price · IT edit → Follows master → Pinned; parent title edit → every variation repaints; Publish → Amazon · IT on 2 rows → "1 published · 1 refused" with the refused row's reason in its readiness cell.


---

## 9. MS.1 + MS.2 as built (2026-08-29)

```
GET /api/products/sheet/columns?market=IT&productTypes=COAT,GLOVES
GET /api/products/sheet?market=IT&page=1&limit=25&search=&status=&productTypes=&parentIds=
```

Both mount under `/api`, so the existing `/api/products` RBAC prefix rule maps them to `products:view`
on a GET (verified: 2478 routes, 0 unmapped). Writes are NOT here — the sheet autosaves through the
existing `PATCH /api/products/bulk`.

* `services/pim/schema-caps.ts` — `extractSchemaCaps` / `mergeSchemaCaps`: per-attribute caps, closed
  enums, deprecated values and required-ness read from a **cached** Amazon product-type definition.
* `services/pim/sheet-columns.service.ts` — `buildSheetColumns` (pure) merges the field registry, the
  cached Amazon caps and the eBay `ChannelSchema` aspects into `SheetColumn[]`; `coordinatesFor`
  resolves a market name to its coordinate list; the built set is cached in-process for 5 minutes.
* `services/pim/sheet-rows.service.ts` — one page of FAMILIES, `resolveAttributes` per row (pure),
  `computeReadiness` per row × coordinate (pure), completeness through the existing MA.4 function.

**82 unit tests**, every load-bearing rule mutation-tested (a cap that is not the tightest, a strict
list that blocks instead of warning, a parent flagged for a per-variant field, an unlisted row
reported as ready, a Prisma Decimal read as null — each mutation fails at least one test).

### What building it against the real catalogue exposed

| Finding | Consequence |
|---|---|
| **Every cached Amazon IT schema is past its 24 h TTL** (fetched 8 Jul – 27 Aug). Going through the flat-file manifest calls `getSchema`, which refreshes from SP-API — and with a revoked local refresh token it threw, yielding **zero caps for all four product types**. | The sheet reads the cached definition **whatever its TTL** and reports `schemaAge` per type. A month-old cap beats no cap; a counter with no cap looks exactly like a cap of none. Refreshing stays the schema-sync cron's job. |
| `getAvailableFields(marketplace)` re-reads the same 50–500 KB definitions this service already reads — **7.8 s on top of 4.1 s** for the identical rows. | The dynamic `attr_*` fields are derived once, here, from the rows already loaded. Cold read 82 s → 34.7 s; warm (column set cached) ≈ 1 s for a 29-row page. Most of what remains is Neon round-trip latency from a laptop (~860 ms for a trivial query); it will be far lower on Railway. |
| **`variationAxes` holds the operator's LABELS, not schema keys** — the real IT catalogue carries `["Colore","Taglia"]` while the attributes are `color` / `size`. | Axes are matched against the localised label as well as the key. Key-only matching marked every variation axis `global`, so a parent row offered to set one size for the whole family. |
| **The master is thin.** 277 of 338 products carry *some* `categoryAttributes`; a typical jacket carries 0–1 keys. | Readiness is honestly `errors` for most rows — every Amazon-required field is genuinely absent. This is the gap the sheet exists to close, and MA.3 "import from Amazon parent" is the bulk way to close it. |
| **Exactly ONE product has an `it` content slot.** | Italian title/description cells are empty across the catalogue, correctly: the resolver deliberately does not synthesise English into a non-`en` locale, so "missing translation" surfaces rather than hiding. |
| Amazon gives `color` a 1000-character cap and `product_tax_code` 949. | `longtext` is decided by the KEY, never by cap size — a cap-based rule opened a textarea for a one-word colour. |
| 174 columns come back for four product types. | Every column is returned; `defaultVisible` marks the master's own shape plus whatever a channel requires (~25), and the rest are one Customise click away. |
| The webstore channels are seeded `marketplace = 'GLOBAL'` and have **zero listings**. | A coordinate is included only where the market actually has a presence (Amazon · IT, eBay · IT), unless a channel is explicitly forced in — three dead "Unlisted" columns teach an operator to stop reading the readiness strip. |


---

## 10. MS.3 as built (2026-08-29)

`apps/web/src/app/products/_sheet/` — `MasterSheet.tsx`, `useMasterSheet.ts`, `types.ts`.

```tsx
<MasterSheet market="IT" />
```

Self-contained by design: it takes a market and nothing else, so **where it lives is still one mount**
(§8.3 is open). Until the Owner decides, it is verifiable at `/design/grid-lab?tab=sheet`.

* Columns and rows come from MS.2 in ONE request; only `defaultVisible` columns are rendered
  (26 of 111 for the real IT catalogue), the rest are a Customise click away.
* Autosave per cell, through **existing** endpoints — no new write route:
  `column` + `categoryAttributes` → `PATCH /api/products/bulk` (with `expectedVersion`);
  `localizedContent` → `PATCH /api/products/:id/global` (the bulk endpoint has no route into a locale).
* Cell states are the GDS ones: inherited tint, locked, `⚠ required`, warn/error corner triangles,
  and `saving → saved | refused` per cell with the server's reason on hover.
* A market switcher built from `availableMarkets` (only markets that actually carry listings), and a
  `caps` pill that says when the cap data was fetched or that a type has no cached schema at all.

### Verified in the browser against the real IT catalogue

| Check | Result |
|---|---|
| Renders live | 37 products / 251 rows on page 1, groups `Identity · Master · Attributes · Readiness · IT` |
| Write round trip | Typed `Xavia Racing` into an empty `manufacturer` → cell went `saving` → status "1 unsaved cell" → **server read back `"Xavia Racing"`, version 1 → 2** → "Saved" |
| Restore | Set back to `null`; the field is as it was (version 3 — an audit counter, not data) |
| Optimistic concurrency | A write with a stale `expectedVersion` was **refused 409 `VERSION_CONFLICT`** and did not land |
| Two defects found and fixed | A `marryChildren` group straddling the pinned boundary renders TWICE in AG (two adjacent `IDENTITY` headers) — the pinned pair keeps `Identity`, the rest became `Master`. And the tree column repeated the product name read-only beside the editable `name` cell; it is now the tree control alone (76px). |

**A trap worth remembering:** pointing the web dev server at a local API made `GET /api/accounts` take
62 s, so `/design/grid-lab?tab=gds` never reached `networkidle` and `check-grid-chrome.mjs` timed out
for *every* session on the machine. The grid was innocent; one hung request in the app chrome is
enough to break a `networkidle` gate.
