# The Master Sheet — design (GDS-4)

**Status:** designed in the DS and prototyped in the grid lab (`/design/grid-lab?tab=gds#sheet`); nothing on a product page yet. **Owner decides** the open questions at the end before any page is built.

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

**Readiness.** One column per channel listed for this market: `Ready` · `Missing · n` · `Errors · n` · `Live · <channel id>` · `Unlisted`, each with the issues on hover. Computed by the publish validator (`validatePublish` / `channel-readiness.service`), never by the grid. It recomputes on every cell edit — that is the feedback loop that makes the sheet worth using.

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

## 7. What the API needs (gaps — none built)

| Gap | Shape | Why |
|---|---|---|
| **MA.1 master schema per product type × market** | `GET /api/products/master-schema?productType=&market=` → `[{key, label, group, kind, scope, options, mode, requiredBy, maxLength}]` | Derived from the Amazon PTD ∪ eBay aspects ∪ the mapping rules' sources. The sheet's columns come from this — never hand-listed. |
| **MA.2 sheet read** | `GET /api/products/sheet?market=IT&cursor=` → rows with own + effective values, follows flags, refs, readiness per channel, completeness | One query per page of rows; readiness computed server-side by the validator. |
| **MA.3 cell write** | `PATCH /api/products/:id/master` `{key, value, locale?}` → `{ok} \| {ok:false, reason}` + the row's new readiness | One cell, one answer; refusals are answers. |
| **MA.4 follows toggle** | `PATCH /api/channel-listings/:id` `{followMasterPrice: bool}` | Exists in spirit (`followMaster*` flags); needs the market-scoped form. |
| **MA.5 publish selection** | `POST /api/products/publish` `{ids, channel, market}` → per-row results | Fans out to the existing per-channel routes. |

## 8. Open questions for the Owner

1. **Autosave per cell vs explicit Save.** Recommended: **autosave per cell** (as prototyped) — the write is to the master, which is ours, cheap and reversible (⌘Z + a refusal that stays visible); Publish stays explicit. Shopify's explicit Save exists because their write IS the storefront; ours is not.
2. **One sheet per market vs a wide `field@MARKET` sheet.** Recommended: **per market with a switcher** — 20 attributes × 5 markets is 100 columns nobody reads; a per-market sheet is the FF0 v2 shape and keeps the column count under Akeneo's ~50.
3. **Where it lives.** Recommended: a **tab on /products** ("Sheet") beside the list — never a new page (the extend-don't-add rule); the list and the sheet share the same selection, filters and Customise dialog.
4. **Which market first.** IT (the home market, xaviaracing.it) — the fixture is built for it.

---

## Appendix — what is in the DS after GDS-4

`design-system/grid/`: `hosts/GridSheet` (+ `SHEET_GRID_OPTIONS`, `GridSheetStatus`, `height` for embedded use), `renderers` `LongTextCell` · `ReadinessCell` · `FollowsCell`, `editors/sheet` `longTextEditor` · `sheetClassRules` · `selectValidation` · `lengthValidation` · `matchPasteToHeaders` · `sheetPasteProcessor`, `NexusGrid fill`, cell-state CSS (`.nds-cell-is-invalid/-warned/-inherited`, `.nds-cell-required`, `.nds-cell-longtext*`, `.nds-cell-follows*`). Lab: `#sheet` on a XAVIA fixture (4 families, 38 variations, market IT); conformance probe `sheet: compact`.

Verified in the browser 2026-08-29: EAN `12345` → saving → **refused** (red, "Refused: an EAN is 13 digits", strip "1 refused"); corrected → saved → "Saved 05:07", eBay readiness Errors → Live; Origin select on a variation → own value, inherited tint gone; Price · IT edit → Follows master → Pinned; parent title edit → every variation repaints; Publish → Amazon · IT on 2 rows → "1 published · 1 refused" with the refused row's reason in its readiness cell.
