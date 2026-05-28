# eBay Flat-File Fields — pick-or-type catalog

Which columns on `/products/ebay-flat-file` offer a curated value list, and
how strictly that list is enforced. Companion to
[ebay-integration-map.md](./ebay-integration-map.md) and
[cockpit-parity.md](./cockpit-parity.md). Built by the **FF-EN series**.

> **You can always type your own value.** Every list is an *editable
> combobox* (search + a "Use «typed value»" entry). The list is a
> convenience, never a cage. The only difference between modes is whether a
> non-listed value is *flagged*.

## Modes

- **open** — eBay accepts free text (its `aspectMode = FREE_TEXT`, or a
  field where a custom value is reasonable). Suggestions show; a typed
  value is plain.
- **strict** — eBay only accepts listed values (`SELECTION_ONLY`, or a
  category-narrowed Condition). A typed off-list value is still accepted
  into the cell but **flagged amber** ("not in eBay's list" in the
  dropdown; an alert icon + tooltip on the cell), because eBay rejects it
  at publish. *Warn, never block.*
- **multi** — the cell holds a comma list; the dropdown toggles options
  in/out and stays open (checkboxes + "N selected / Done").

## Column catalog

| Column | Mode | List source |
|---|---|---|
| Condition | strict | `get_item_condition_policies` for the loaded category → Inventory `ConditionEnum` (English labels). Static 11-value list (open) until a category is set. |
| Format (`listing_format`) | strict | `FIXED_PRICE` / `AUCTION` (Inventory API publishes Fixed Price). |
| Duration (`listing_duration`) | strict | `GTC` / `DAYS_1…30`. |
| Item specifics — `SELECTION_ONLY` | strict | eBay aspect `values` (Taxonomy `getItemAspectsForCategory`). |
| Item specifics — `FREE_TEXT` w/ values | open | eBay aspect `values` (suggested, not required). |
| Variation Theme | open + **multi** | the category's variant-eligible aspect names (English preferred). |
| Fulfillment / Payment / Return policy | strict | the seller's eBay business policies (`/ebay/flat-file/policies`). |
| Item location country | open | curated ISO-3166 alpha-2 (EU-centric) subset. |
| Package type | open | `PackageTypeEnum` subset (apparel/gear). |
| Weight unit | strict | `WeightUnitOfMeasureEnum` (KILOGRAM/GRAM/POUND/OUNCE). |
| Dimension unit | strict | `LengthUnitOfMeasureEnum` (CENTIMETER/INCH/METER/FEET). |
| VAT % | open | common EU rates (0/4/5/10/22). |

Plain free-text / numeric columns (no list): SKU, EAN, MPN, Title,
Subtitle, Description, Price, Best-Offer floor/ceiling, Quantity, Handling
days, package weight/length/width/height, image URLs, Category ID
(double-click opens the category search). Status/IDs are read-only.

## Where values come from / go

- **Source.** Aspect lists + `aspectMode` come from the category-schema
  endpoint (`GET /ebay/flat-file/category-schema`), which also returns the
  category's allowed `conditions`. Policies come from
  `/ebay/flat-file/policies`. Units/format/duration/VAT/country/package-type
  are static option sets in `ebay-columns.ts`.
- **Persistence.** The full-parity fields (format, duration, VAT, location,
  package type, weight + unit, dimensions + unit) round-trip through the
  eBay `ChannelListing.platformAttributes` — `buildFlatRow` reads them,
  `packSharedFields` writes them. No dedicated columns / DB migration.
- **Push.** Package weight/dimensions/type are wired into the Inventory API
  publish as `inventory_item.packageWeightAndSize` (single-SKU **and**
  variation-group paths) via `buildPackageWeightAndSize`; absent when
  unset, so a row without dimensions publishes unchanged.

## Engine

The combobox is the shared `FlatFileGrid` `EnumDropdown`
(`apps/web/src/components/flat-file/FlatFileGrid.tsx`). A column opts in
with `kind: 'enum'` + `options`, plus optional `enumMode` ('open'|'strict')
and `multiValue`. Undefined `enumMode`/`multiValue` = legacy single-select
open behavior, so the grid's other consumers (Amazon flat-file via its own
client, bulk-operations) are unaffected. a11y: `role=combobox`/`listbox`
with `aria-activedescendant`; large lists cap at 200 rendered rows with a
"keep typing" hint.

## Constraint

All of the above is on the otherwise-untouchable `/products/ebay-flat-file`
surface (page + `ebay-flat-file.routes.ts`) and the shared `FlatFileGrid`.
The FF-EN series was explicitly approved; changes to the shared grid are
additive + opt-in so non-eBay consumers don't change.
