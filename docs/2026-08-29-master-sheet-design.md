# The Master Sheet — design (GDS-4)

**Status:** designed in the DS and prototyped in the grid lab (`/design/grid-lab?tab=gds#sheet`). §8 decisions taken by the Owner 2026-08-29. **MS.1–MS.7 are BUILT** — reads (§9), the component (§10), bulk fill (§12), publish preview (§13), channel divergence (§14), un-pin (§17). Where the sheet lives is still open and blocks only the mount.

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

**79 unit tests** — 65 in `apps/api` (schema-caps 17, sheet-columns 24, sheet-rows 24) and 14 in
`packages/shared`. Every load-bearing rule is mutation-tested: a cap that is not the tightest, a
strict list that blocks instead of warning, a parent flagged for a per-variant field, an unlisted row
reported as ready, a Prisma Decimal read as null — each mutation fails at least one test.

> **Corrected 2026-08-30.** The commit message for `225771677` and the first version of this section
> both claimed "82 unit tests". The real count at that commit was 65. Nothing else in the number was
> wrong, but a test count nobody can reproduce is the kind of claim that makes the rest suspect.

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


---

## 11. Verification pass (2026-08-30)

Re-checked every claim rather than restating it. Three of my own claims were wrong:

| Claim | Reality |
|---|---|
| "82 unit tests" | **65.** Corrected above and in §9. |
| "Prod has the routes — 401 proves it, not 404" | **Invalid inference.** `/api/products/sheet-nonexistent` returns the *identical* 401, because the RBAC hook matches the `/api/products` prefix before routing resolves. The routes ARE deployed, but the evidence given was worthless; the Railway deployment record is the real proof. |
| "MS.3 not found in the served Vercel chunks" | **My grep was wrong.** Four strings unique to MS.3 all resolve to `/_next/static/chunks/02l2uhpnymwn9.js`. |

One real defect, now fixed: **an unknown market returned a sheet instead of an error.**
`market=XX` came back HTTP 200 with zero coordinates and a full page of rows, so a typo'd link
rendered as a real market that merely had no channels. `UnknownMarketError` → **400** naming the
markets that exist. A market that exists but has no listings yet (`PL`) is still reachable by URL and
simply not offered in the switcher.

One structural fix: the applicability rules were **duplicated** in the API and the sheet after MS.3.
They now live once in `packages/shared/master-sheet.ts` (14 tests). A drift there is invisible and
vicious — the cell would say "required" while the readiness pill said "not applicable".

### What the pass confirmed

* Both commits on `origin/main`; Railway `SUCCESS` for both; Vercel serving MS.3.
* **All four markets work**, not just the one it was built against: IT/DE/ES/FR return the right
  locale, the right coordinates (IT has Amazon + eBay, the rest Amazon only), and `schemaMissing:
  ["GLOVES"]` correctly on ES/FR.
* **The readiness verdicts are true.** Claims were checked against the raw records: every field the
  sheet reports missing is genuinely absent from the row *and* its parent. Zero false accusations.
* **The production data touched during MS.3 verification is restored** — `manufacturer` is `null`,
  and the audit trail holds exactly two bulk operations (the write and the restore), both SUCCESS.
* Prod end to end: the deployed sheet loaded with a real session — 37 products, 251 rows, the
  deployed API answering in 3.1 s.

### Still open

* **The web component has no automated tests.** Its two rules are now covered in `packages/shared`,
  but the column builder, the save dispatch and the round-trip painting are browser-verified only.
* **Only the failing readiness path is proven on real data.** 3 of 58 verdicts on one page came back
  `ready`; no passing row has been checked end to end against a channel.
* Reads take 3–6.6 s per market from a laptop (mostly Neon latency), unmeasured on Railway.


---

## 12. MS.4 as built — bulk fill (2026-08-30)

**Why this before publish.** MS.4 was going to be the publish fan-out, because pushing to channels is
where the original ask ends. Building on the real catalogue changed the order: the master is nearly
empty, so *every* readiness verdict is `errors` and there is almost nothing a publish could send.
Five Amazon-required fields absent across 251 rows is over a thousand cell edits. Filling the master
is the bottleneck; publishing is the step after it. Publish is now MS.5.

`BulkSetControl.tsx` + `bulkSetCells()` — select rows, pick a column, set it once.

* **No new write path.** It is the same `PATCH /api/products/bulk` a single cell uses, which already
  accepts up to 1000 changes and routes `attr_*` into `categoryAttributes`. Bulk fill inherits its
  per-cell structured errors for free.
* **Three outcomes, never one "done":** `N set` · `N refused` (the server's reason on hover) ·
  `N not applicable`. A size on a parent is not a server error — it is a question that should never
  have been asked, so those rows are filtered out client-side and reported separately.
* The column picker offers only writable columns at least one selected row can hold, and labels each
  one with **which channel requires it** (`Paese di origine — required by Amazon · IT`), so the
  operator fills what actually unblocks a listing first.
* A locale column fans out to the per-product `/global` route, since the bulk endpoint has no way
  into a locale slot.
* **Deliberately last-write-wins.** The bulk endpoint takes ONE `expectedVersion` for the whole call,
  which cannot be correct for N rows at N versions, so bulk fill sends none and the page refetches
  afterwards to pick up fresh versions. The single-cell path keeps its 409 guard.

### Verified in the browser on the real IT catalogue

| Check | Result |
|---|---|
| Bulk write | 3 GLOVES variations selected → `Produttore` = `Xavia Racing SRL` → **"3 set"**, and the server read back the value on exactly those three |
| Blast radius | `xriser-bla-xl`, a sibling that was *not* selected, stayed `null` |
| Restore | All three set back to `null`; `updated: 3`, no errors |
| Not-applicable path, verified WITHOUT writing | Parent + 2 variations selected, column `EAN` (per-variant) → the button reads **"Set 2 rows"**: the parent is excluded before anything is sent |

## 13. MS.5 as built — publish, preflight-first (2026-08-30)

Publishing is outward-facing and hard to reverse, so **nothing leaves the sheet as a side effect of
one click.** The flow is two deliberate steps, and the send reuses the route that already owns
publishing rather than adding a second way to reach a marketplace.

**Step 1 — preview.** `POST /api/products/sheet/publish-preview { ids[], channel, marketplace }`
(`services/pim/sheet-publish.service.ts`). Makes **no channel call at all**. Each row gets a verdict:

| Verdict | Meaning |
|---|---|
| `blocked` | Readiness has errors. Refused here with the fields named, rather than spending an API call to be told the same thing. |
| `unlisted` | Nothing on the channel yet. Still sendable — that is how a listing is born — but flagged as a create, not an update. |
| `warned` | Sendable, but something would probably be rejected downstream (an off-list value). |
| `ready` | Already listed, every required field present. |

**Step 2 — send.** A separate button that appears only after a preview, names how many rows and to
where, and **defaults to a dry run**. It calls the existing `POST /api/products/:id/publish-amazon`
per row. The platform's own gate is reported beside it: `AMAZON_PUBLISH_MODE` defaults to `dry-run`
and is currently `gated`, so a live send needs *both* the switch and the env. A green result in
dry-run mode means "this would have worked", never "this is listed", and the pill says which.

**eBay is preview-only from the sheet, deliberately.** Its publish route updates an *existing* offer
("No offer found — push first") and takes no dry-run parameter, so there is no way to rehearse it.
Wiring a one-click send to a live marketplace call that cannot be simulated is not something this
sheet should do. The preview is still useful; the eBay flat-file surface still owns the send.

The publish mode comes from the SAME gates the publish routes consult (`getAmazonPublishMode` /
`getEbayPublishMode`), never re-derived from env here — a preview that said "live" while the gate
said "dry-run" would have an operator believe a listing went out.

**14 tests**, four rules mutation-tested: errors no longer blocking, blocked rows counted as
sendable, eBay silently becoming sendable, and a family page replacing the exact id list (which
would judge — and offer to publish — rows nobody selected).

### Verified on the real IT catalogue

| Check | Result |
|---|---|
| Amazon preview, 3 rows | **3 blocked**, each naming `Descrizione del prodotto is required by Amazon · IT` — matching the raw records |
| eBay preview, same rows | **3 sendable** (1 ready, 2 new) with **preview only** and the reason on hover; no send button, no dry-run toggle rendered |
| Send affordance | With 0 sendable the button reads **"Rehearse 0"** and is **disabled**; dry run defaults to checked |
| Platform state | `platform: gated` surfaced in the toolbar — publishing is switched off for this channel entirely |

**No live publish has been performed.** The send path is wired and type-checked but has never been
fired against a marketplace, by design — that needs the Owner's word and an ungated env.

## 14. MS.6 as built — channel divergence, read-only (2026-08-30)

A `Channel · <market>` column group: per coordinate, the price that channel is **actually carrying**
and whether it still **follows the master**.

**Why it earns a column.** Measured on the real IT catalogue: of 525 IT listings, **232 carry
`followMasterPrice: false`** and **240 `followMasterTitle: false`** — nearly half have stopped
following the master, and nothing in the console showed it. Those are legitimate legacy pins, not a
data bug: `priceOverride` is null on all 525, and the resolver falls back to the direct `price`
column for rows that predate the Phase 20 SSOT split (`attribute-resolver.ts`, "covers older rows
that never got migrated"). The value is real; only its storage is old.

One cell summarises six flags — it reads *Follows master* only when **every** flag does, and the
tooltip names the pinned ones (`Pinned on Amazon · IT: Title, Description, Price — the master no
longer drives them`). Collapsing six flags into one boolean without naming them would be a worse lie
than showing nothing.

**Read-only, deliberately.** `PATCH /products/:id/channel-pricing` *pins* a field when you write a
price (`followMasterPrice = false`), but **no route sets a follow flag back to true** — `price: null`
is explicitly ignored by that handler. A control that can pin but never un-pin is a trap: the
operator breaks inheritance by accident and cannot undo it from here. So the sheet shows the
divergence and the channel surfaces keep the edit until that route exists.

Verified in the browser: parents `1J-EYE5-Y0TW` and `3K-HP05-BH9I` read **Pinned**, the `xriser-*`
variations read **Follows master**, the MISANO variations read **Pinned** beside a real
`Amazon · IT price` of €149.95, and eBay shows `—` where no listing exists.

## 15. Tests added for the component (2026-08-30)

The web component's write dispatch was browser-verified only; it now has **17 tests**
(`useMasterSheet.vitest.test.ts`), five rules mutation-tested. Each covers a way the sheet could lie
about production data: a per-cell refusal arriving inside a 200 being read as success, a no-op
(`updated: 0`) reported as saved, a locale field sent to the endpoint that cannot write it, a bulk
fill ignoring applicability and setting a field on rows that cannot hold it, and the single-cell path
dropping its `expectedVersion` guard.

## 17. MS.7 — un-pin, and the divergence cell becomes a control (2026-08-30)

`PATCH /api/products/:id/channel-follows { updates: [{ marketplace, channel?, field, follows }] }`
(`services/pim/channel-follows.service.ts`). This closes the one genuinely missing route: nothing
anywhere could set a follow flag back to `true`, so breaking inheritance was a one-way door.

**What it does and does not do.** It flips flags and nothing else — no channel call, no publish. The
response says so in words (`Flags only — nothing was published. The live listing changes on the next
publish.`), because "now follows master" and "the channel now shows the master's value" are different
facts and conflating them would be a lie.

**It never destroys the channel's value.** Handing a field back to the master clears only the
explicit `*Override`. For rows predating the Phase 20 SSOT split the pinned value lives in the
DIRECT column (`price`, `title`) — which is also what the channel is carrying right now. Clearing
that to "tidy up" would erase the record of a live listing's real price. `images` has a flag but no
override column at all (a gallery is a relation, not a scalar), and is handled explicitly.

The divergence cell from §14 is now an editable control. It governs the **price** flag specifically —
the header reads `Amazon · IT price follows` — because one cell cannot set six flags without guessing
which was meant; the tooltip names the others and says they are not editable here.

**13 tests**, three mutation-tested: clearing the direct column as well (data loss), reading an absent
flag as pinned (the column defaults to true), and clearing the override when *pinning* rather than
un-pinning.

### Verified on the real IT catalogue, restored afterwards

| Check | Result |
|---|---|
| Un-pin | `1J-EYE5-Y0TW` price `false → true`; response `stillPinned: [title, description, images, bulletPoints]` — price gone from the list |
| No collateral damage | The channel price was **unchanged** across the flip |
| Restore | Flipped back to `false`; final state matches the original exactly |
| Rejects a JSONB attribute | `field: "material"` → **400** (attributes have no flag — §5) |
| Rejects a non-boolean | `follows: "yes"` → **400** |
| A coordinate with no listing | `ok: false, reason: "no listing on this coordinate"` — reported, not an error |

## 18. What is left

* **The mount** — §8.3 remains the Owner's decision, deliberately not taken for them. The sheet lives
  at `/design/grid-lab?tab=sheet`; the recommendation is still a "Sheet" lens on `/products`.
* **A live publish has never been fired** (§13) — needs the Owner's word and an ungated env
  (`AMAZON_PUBLISH_MODE` currently reads `gated`).
* **Follows for the other five fields.** The route handles all six; the sheet exposes only price,
  because five more columns per coordinate would cost more than they explain. Worth revisiting once
  an operator says which they actually change.
* The column-def builder in `MasterSheet.tsx` is still covered only by browser verification.
