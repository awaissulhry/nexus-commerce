# Variation theme column in the product sheet (VT) — assessment, design and build plan

**Status:** 🟢 **APPROVED 2026-09-13 by the Owner on the defaults** ("I actually agree, so let's go ahead and start and
make sure that everything's AAA quality all along"). **VT.0 is DONE** (§1 T14–T18, §4); D-VT8 is decided by its
numbers. Lanes VT.1–VT.F run from `docs/vt-prompts.md`, launched by the Owner. Written 2026-09-13 by session
`[3aec8721]` from the Owner's handwritten plan
(photo `IMG_7997.HEIC`, transcribed verbatim in §0), the code as it stands today (§1, every reading taken on
the working tree this morning), and the two designs this composes with: the Variants page
(`docs/2026-09-11-variants-page-spec.md`, built by VP.1–VP.5 + VP.F) and the variation projection design
(`docs/2026-09-12-variation-projection-design.md`, "VX", FOR APPROVAL, nothing built). **Nothing is built by
this document. Nothing is committed.** The Owner launches and manages the lanes (ledger #794).

**What this document is:** (a) the Owner's plan, section by section, with a verdict on each; (b) the design
that results — one `Variation theme` column in the product sheet, re-projected per scope; (c) the contracts,
the order of work and the decisions the Owner must make. Where VX already designed a piece (rules on the
mapping page, collisions, the live-listing plan, aliases) this document **reuses it by reference and does not
restate it**; where this document differs from VX it says so in §3.

---

## 0. The Owner's plan (2026-09-13, transcribed from the photo; the drawn lines are the section breaks)

**Top section**
> Need Variation theme column. Should be dynamic and be mapped by default in mappings page. Such that for
> amazon i choose → sizename/color name, it automatically maps to color & size on ebay and the axes must also
> always be in the language of the market. (ALWAYS)

**Left section**
> Should support Aliases and i think that its better to only keep it at parent level.
> ↓ layout
> → should simply select the att i want as axes; to select multiple maybe should use some key like (, or / or
> +). a popup editor opens when i click and i should be able to rearrange just like chips, add or remove etc.
> (maybe should suggest the ones acceptable) The axes should, or the acceptable axes should, be depending on
> the categories and i have experienced differences even in diff markets.

**Right section** (the bracket joins it to the layout section)
> Now since we have a common channel sheet what's the best approach to get it done taking into account all
> the channel scopes and then also multiple markets/languages. Do we keep a separate column in each scope and
> market? while keeping it all properly mapped and in case of having a different theme for a specific
> scope/channel/market i simply select it from there.

## 1. What is true in the code today (measured 2026-09-13; check, do not trust)

| # | reading | value |
|---|---|---|
| T1 | the family's axes | `Product.variationAxes String[]` (`schema.prisma:297`) on the parent — canonical keys; the Variants page AXES band edits it through `PATCH /products/:id/studio/variation-axes` (`product-studio.routes.ts:142`, `family-variation-axes.ts:63`). **This is already the "select the attributes I want as axes" store.** Candidates = sheet columns that are `editable && scope === 'per_variant'` and scalar (`family-variation-axes.ts:31-33`) |
| T2 | TWO theme stores with DIFFERENT consumers | `Product.variationTheme` (`:127`, a delimited string `"Colore,Taglia"`) is the **eBay axis SET** — the push reads it and it wins over the coordinate (`ebay-variation-push.service.ts:904-909`), ONE set for every eBay market and alias. `ChannelListing.variationTheme` (`:1611`) is the **Amazon enum value** per marketplace coordinate — the publish adapter sends it as `variation_theme` on every child (`amazon-publish.adapter.ts:410-417`) |
| T3 | two parsers, one precedence disagreement | `parseThemeAxes` (`ebay-theme-axes.ts:16-29`, splits `, / \| ;`, caps 5) vs `ffcParseThemeAxes` (`amazon/flat-file.service.ts:1612-1645`); `ebay-family-axes.service.ts:232` lets the LISTING theme win, `ebay-variation-push.service.ts:904` lets the PRODUCT theme win |
| T4 | the projection wire already carries the theme | `GET /studio/projection` returns `theme: { value, options }` on Amazon only (`family-projection.service.ts:1331-1333`; options from the coordinate's own `variation_theme` sheet column `:1083-1085`); `PATCH /studio/projection` accepts `theme` + ordered `mapping[]` + `expectedVersion` and routes the write per channel (eBay → `Product.variationTheme` + `platformAttributes._axisNameLabels` `:1517`; others → the listing's `variationTheme` + flat `variationMapping` `:1528-1536`). **No component renders `page.theme`** (`variants/channel/types.ts:262` typed, never read) |
| T5 | a raw theme column ALREADY exists on the Amazon scope | `channel-specs/amazon.ts:58` serves `variation_theme` (enum options + localized labels + deprecations from the PT schema walker `:238-281`); writable through the bulk PATCH (`studio-sheet.service.ts:520-527`); **excluded from master** (`sheet-columns.service.ts:533-534`). eBay serves a `variationTheme` listing column (`channel-specs/ebay.ts:136`) **that no push path reads** |
| T6 | the sheet has NO axes/theme column of its own | the only axis facts on the sheet are `column.axis` (`master/types.ts:68`, server-derived) and the identity band's second line (`identitySecondary.ts:83-89`, axis values joined with ` · `, `null` on the parent) |
| T7 | acceptable Amazon themes are per product type × marketplace | `CategorySchema.variationThemes` (`schema.prisma:7777`, written by `schema-sync.service.ts:495-513` from `properties.variation_theme.items.properties.name.enum`); bundled fallback `product-types.constants.ts:258`. The Owner's "differences even in diff markets" is what the schema says |
| T8 | acceptable eBay specifics are per category × site | `getItemAspectsForCategory` (`ebay-category.service.ts:886`) → `variantEligible: !!c.aspectEnabledForVariations` (`:964`); site aspect NAMES are the market's words ("Colore" IT, "Farbe" DE) |
| T9 | the mapping page has NO variations section | rules key on channel × market × `byProductType[<productType \| eBay category>]` (`schema-mapping.service.ts:95-124`); the only variation-adjacent rule is eBay's `presentationRules.order` on a separate page, activation held (`ImpactReview.tsx:91`) |
| T10 | aliases | `ProductListingAlias` carries no theme/order; but the projection already reads and writes **per `aliasKey` on `ChannelListing`** (`family-projection.service.ts:1017-1044`, `:1470-1490`) — the per-alias store exists for Amazon/Shopify/Etsy; eBay's set is product-level (T2) until VX D1 |
| T11 | DS pieces that already exist | `AxisChip` (grip · label · count), `MappingChip` (from → to), `OrderedList` (drag reorder), `OptionList` (the ONE option list), `TagInput` (chips, suggestions, maxTags), `ListPanelEditor` (the `shape: 'list'` AG popup editor: `OptionList` for a closed list, `TagInput` for free text, `onValueChange` on every change, draft mirrored so Enter = add-and-save), `SelectPanelEditor`, `ProvenanceMark` + `classifyProvenance`, `CascadeCell` |
| T12 | the Variants page | LIVE: `_studio/variants/{family,channel}` — AXES band + `+ Add axis` on master; MAPPING band + dock (`dock/sections.tsx:45-135`: `OrderedList` of axis → target `Listbox`) on channel scopes. VP.F's final table closed 2026-09-12 (row 50) |
| T13 | scale trap | Amazon channel-scope load makes a LIVE SP-API PT definition call (`channel-specs/index.ts:60` bypass, LX's to fix). A cell editor that opened a live call per cell would be a defect on day one |
| **T14** | **VT.0 — the derivation is AMBIGUOUS for every family** (Neon prod, read-only, 2026-09-13 ~06:30; discriminator GALE `Product.version` **51**; role `neondb_owner` has `rolbypassrls`, positive control 338 products) | 14 families with children; **35 of 35** family × Amazon-marketplace pairs that declare axes resolve to TWO in-order spellings — `COLOR/SIZE` **and** `COLOR_NAME/SIZE_NAME` (`SIZE/COLOR` + `SIZE_NAME/COLOR_NAME` for AIR-MESH; `COLOR` + `COLOR_NAME` for the knee sliders); **0 unique**, 0 none. Across the 44 cached Amazon schemas with a theme enum (349 distinct values) **32 canonical keys carry both spellings**. The tie-break is load-bearing for 100% of the catalogue, not an edge case |
| **T15** | **VT.0 — the `_NAME` spelling binds to NO attribute of its own** | OUTERWEAR on IT and DE: attributes `color`, `size`, `style`, `material` exist (titles "Colore/Taglia", "Farbe/Größe"); **`color_name`, `size_name`, `style_name`, `material_type` are ABSENT** (`"color_name"` occurs 0 times in the schema text; `COLOR_NAME` 78 times, all inside the theme enum and its `enumNames`). Both spellings are the same relationship over the same attributes; the `_NAME` form is a legacy vocabulary. **The adapter's fallback `${axis}_name` (`amazon-publish.adapter.ts:426`, comment "correct for Xavia's motorcycle-gear catalog") names attributes that do not exist on this product type** — a live defect on any push that reaches it |
| **T16** | **VT.0 — the only live Amazon child carrying a theme uses the BARE form** | `GALE-JACKET-BLACK-MEN-XS` · DE · ACTIVE · `variationTheme = "SIZE/COLOR"`; the same child on IT carries `""` (an EMPTY STRING on an active row — the resolver must treat `''` as null). One `variationMapping` row exists (AIREON · DE, null theme, DRAFT) |
| **T17** | **VT.0 — the enum is the same on six marketplaces for OUTERWEAR** | IT = DE = ES = FR = NL = UK, 52 values each, six different `schemaVersion`s, all fetched 2026-09-07 and **all expired 2026-09-08** (24 h TTL) and served stale. Per-coordinate caching stays (Amazon versions them per marketplace); the localized `enumNames` differ ("COLORE/DIMENSIONI" IT, "FARBE/GRÖSSE" DE) and are machine-cased — the human labels are the bound attributes' `title`s |
| **T18** | **VT.0 — `Product.variationTheme` is set on 337 of 338 products, children included** | `"Colore,Taglia"` on 222 rows (22 roots); `"Fit Type / Size Name / Color Name"` on 50 rows — the `xracing` family (SUIT, 49 children) declares a THREE-axis theme string while `variationAxes` is `[]` (a real 3-axis family exists in one store and not the other; VX V14 said none existed); `"Size / Color"` 23 / 2 roots; `"Color / Size"` 17 / 2 roots. Scripts: `apps/api/scripts/_vt0-theme-derivation.mts`, `_vt0b-theme-attributes.mts` (URL passed explicitly, SELECT only) |

## 2. Verdict on the plan — section by section

**Overall: the approach is right and it is the same shape VX reached on 09-12 from the other end.** Keep it. Three
things I would change, three I would add.

| plan section | verdict | what changes |
|---|---|---|
| **Variation theme column, dynamic, mapped by default on the mapping page** | ✅ correct | Mapping-page defaults are VX §11.1 (rules per channel × market × category, channel-wide fallback). **Change 1:** add a third, zero-config tier — **derived** from the family's axes — so a family with no rule still projects (§3.2). Most families never need a rule |
| **"for Amazon I choose SIZE_NAME/COLOR_NAME → it automatically maps to Color & Size on eBay"** | ✅ intent, ⚠ direction | **Change 2:** the pivot is the MASTER's axes (`colour × size`), not Amazon's theme. Every channel derives from the master by canonical key: Amazon → the PT theme whose segments are those axes in that order; eBay → the site's variation-enabled aspects; Shopify → options. Choosing a theme on the Amazon scope is then Amazon's projection only — reordering to SIZE/COLOR on Amazon·DE must not reorder eBay. "Set once, every channel follows" is what you get; the once is on master |
| **axes ALWAYS in the language of the market** | ✅ already decided 09-12 | Axis NAMES come from the channel: Amazon prints its own localized names from the theme; eBay takes the site aspect name (Colore / Farbe / Couleur); Shopify the label. **Values are pushed verbatim** (Owner, 09-12; VX D5) — nothing is translated by Nexus. The cell on a channel × market scope shows the delivered names, so the operator reads what goes out |
| **support aliases; keep it at parent level only** | ✅ correct | Theme lives on the PARENT row (the family on master; the coordinate's parent listing row on a channel; the alias's own parent listing row for an alias). Children show `—` (their axis VALUES already live in the identity band and the AXES columns). Per-alias eBay themes need VX D1 (the eBay set moves to the coordinate) — today one set serves every eBay market and alias (T2) |
| **select the attributes as axes; `,` `/` `+` to add; popup editor; chips; rearrange; add/remove; suggest the acceptable ones** | ✅ correct | Built from T11: a GDS popup editor (`AxesPanelEditor`) = ordered `AxisChip`/`MappingChip` rows (drag to reorder) + the ONE `OptionList` of acceptable candidates for THIS coordinate + the coordinate's limit. Comma and `/` add a chip (they are not AG's keys; Enter is — it commits, `reference_ag_popup_editor_owns_keys`). **The same component is the Variants dock's section 1** — one editor, two hosts, zero drift |
| **acceptable axes depend on category and differ by market** | ✅ confirmed in code (T7, T8) | Candidates are served PER COORDINATE from the cached schemas (`CategorySchema.variationThemes`; cached category aspects) — never a live call on cell open (T13), never cached per channel |
| **"do we keep a separate column in each scope and market?"** | ❌ no — **one column, re-projected** | One column definition in the engine, spread by both builders (`reference_two_column_builders_drift`). Its VALUE is the coordinate's projection; its provenance mark says `derived` / `follows rule <label>` / `overridden here`; selecting a different theme on Amazon·DE writes an override on THAT coordinate's parent listing row; `Reset to rule` nulls it. Markets differ by coordinate, not by column. Languages do not enter this column at all (names come from the channel per market; values verbatim) |

**Add 1 — a theme change on a LIVE listing is an operation, never a cell edit** (VX §9, D8). Amazon: new parent +
relink, or 8541-class errors; eBay: relist when the SET changes; Shopify: in place. The cell is gated by the
coordinate's `locked` state (already on the wire, T4): on a live coordinate, committing a SET change opens the
dry-run plan (`Change variation theme…`) and writes nothing. Without this gate the column is the fastest way to
break a live family.

**Add 2 — a channel that drops an axis collides** (VX §6: `split` / `fold` / `exclude`). A 3-axis family on a
2-axis Amazon theme has variants that can no longer be told apart. The cell shows `1 dropped` and `collides`
(VX D9) and refuses to save an unresolved mapping. The plan did not mention this; it is the failure mode of
"different theme per channel".

**Add 3 — ONE write path.** The column writes through the projection PATCH (master through the axes PATCH) —
the same endpoint the Variants dock uses — and the raw Amazon `variation_theme` and eBay `variationTheme`
sheet columns (T5) are **retired**: two columns writing one fact through two paths is the drift trap in another
vocabulary. The two parsers and the precedence disagreement (T3) are unified behind the resolver in the same
step.

## 3. Design

### 3.1 Principles (each is a rule a lane can be measured against)

- **VT.1 One structure, many projections.** The family's axes are defined once on master; every scope shows
  that coordinate's projection of them in one column.
- **VT.2 Three tiers, one resolver, on the server.** `override (parent listing row, per aliasKey)` →
  `rule (mapping page: category → channel-wide)` → `derived (from the family's canonical axes)`. The source is
  always on the wire and always on screen. `null` on the row = follows the rule or the derivation.
- **VT.3 The pivot is the master.** Amazon's theme, eBay's specifics and Shopify's options are projections of
  `Product.variationAxes`; none of them is the source for another channel.
- **VT.4 Names from the channel, values verbatim** (VX.2, VX.3; Owner 09-12).
- **VT.5 One editor, two hosts.** The cell's popup editor and the Variants dock's mapping section are the same
  component (`AxesPanelEditor`), fed by the same wire, writing through the same PATCH.
- **VT.6 A live SET change is a plan** (VX.6). The cell never writes a SET change to a live coordinate.
- **VT.7 Candidates are per coordinate and cached.** No live schema call from a cell.
- **VT.8 Children carry values, not structure.** The column is `—` on child rows.

### 3.2 The derived tier (new against VX)

Given the family's ordered canonical axes `A = [a1..an]` on coordinate `c`:

- **Amazon:** the PT enum value (from the cached `CategorySchema.variationThemes` for `(productType,
  marketplace)`) whose segments, canonicalised, equal `A` in order. **Segment canonicalisation is its own
  function, not `canonicalVariantAxis`** — that one turns `COLOR_NAME` into `colorname`, not `color`; strip a
  trailing `_NAME` first, then canonicalise (VT.0 script `canonicalThemeSegment`). If exactly one matches →
  `derived`. **Several always match (T14): every PT measured offers both `COLOR/SIZE` and
  `COLOR_NAME/SIZE_NAME`.** The tie-break, decided by T15 + T16: **prefer the BARE form** (`COLOR/SIZE`) — the
  `_NAME` spelling binds no attribute of its own, the one live child on prod carries the bare form, and
  Amazon's own labels for the bare form are the natural ones. A coordinate whose listing already carries the
  `_NAME` form keeps it (read-back wins over derivation; a re-theme is an operation, VT.6). If none matches in
  order but one matches as a SET → `derived` with the segment order (the cell says `order from the theme`).
  If none → `none`: the cell reads `Choose a theme` (warning tone) and readiness raises `theme-unset` (VX M5).
- **Amazon attribute binding (new, from T15):** the attribute a segment writes is resolved against the PT
  schema's `properties`, never by string convention: `lower(segment)` if that property exists, else
  `lower(segment)` with a trailing `_name` removed, else **unresolved** (readiness item, the cell shows the
  segment in warning tone). `COLOR_NAME` → `color`, `SIZE_NAME` → `size`, `MATERIAL_TYPE` → `material` on
  OUTERWEAR; `TEAM_NAME` → `team_name` where that property exists. The adapter's `${axis}_name` fallback
  (`amazon-publish.adapter.ts:426`) is replaced by this resolver — it is a defect today (T15).
- **Amazon display label:** the bound attributes' `title`s from the same schema, joined with ` / ` (`Colore /
  Taglia` on IT, `Farbe / Größe` on DE); the enum code in the tooltip. Not `enumNames` (T17: machine-cased).
- **Schema freshness:** candidates are read from the LATEST `CategorySchema` row for the coordinate regardless
  of `expiresAt` (every row on prod is expired, T17); the editor shows `schema from <date>` and a refresh is
  a background job, never a call on cell open (T13).
- **eBay:** per axis, the site's variation-enabled aspect whose canonical key equals the axis key (`Colore`
  for `color` on IT, `Farbe` on DE — `variantEligible` from T8). An axis with no eligible aspect → a custom
  specific under the English label, flagged `not a site aspect` (outside the filters).
- **Shopify / Etsy:** the English label, in family order; Etsy limited to its property list.
- **Limits:** the derivation never exceeds the coordinate's `limits.axes`; beyond it the trailing axes are
  `dropped` and the collision rule applies (VX §6).

The derived tier is what makes "mapped by default" true without an operator writing a rule per category. A
rule on the mapping page (VX §11.1) is the category-level exception; the cell override is the product-level one.

### 3.3 The column — `variation_theme`, served on EVERY scope by `/studio/sheet`

One engine-owned definition (`design-system/grid/editors/sheetColumn.ts`, spread by BOTH builders). New
contract fields, additive to `SheetColumn` (`master/types.ts` mirror, `sheet-columns.service.ts` producer):

```ts
/** kind: 'variationTheme', shape: 'axes' — one column, one row per FAMILY per coordinate. */
export interface VariationThemeCell {
  /** The projection on this coordinate, in delivery order. Empty on a child row. */
  axes: Array<{
    axisKey: string            // canonical: color | size | style | …
    label: string              // English label (Nexus vocabulary) — what master shows
    channelName: string        // the delivered name: Amazon's printed name, the eBay site aspect, the Shopify option
    target: string | null      // Amazon: the theme segment's attribute; eBay: the aspect; Shopify: the option
    included: boolean          // false = dropped on this coordinate (§3.2 limits / rule)
  }>
  /** AMAZON only: the enum value (COLOR_NAME/SIZE_NAME) and its localized label. */
  theme: { code: string; label: string } | null
  source: { kind: 'derived' | 'rule' | 'override' | 'none'; ruleLabel: string | null; category: string | null }
  /** Everything the editor needs, PER COORDINATE, from cached schemas. Absent on master (master candidates are the per_variant columns). */
  candidates: {
    kind: 'theme-enum' | 'aspects' | 'free'
    /** Amazon: every enum value with its label, deprecation, and whether it covers every family axis. eBay: eligible aspects. */
    items: Array<{ code: string; label: string; coversAll?: boolean; drops?: string[]; deprecated?: boolean }>
    limit: number | null       // limits.axes
  } | null
  dropped: string[]            // axisKeys not delivered here (named, never silent — VX §6)
  collisions: { unresolved: number; summary: string } | null
  locked: { reason: string; externalId: string | null; setChangeIs: 'relist' | 'new-parent' | 'in-place' } | null
  /** Where the write lands — the SheetWriter routes on this, never on the column key. */
  write: { endpoint: 'variation-axes' | 'projection'; expectedVersion: number; aliasKey: string } | null
  writable: boolean
  writeBlockedReason: string | null
}
```

Cell VALUE on the grid = the ordered `axisKey[]` (master) or `{ theme, axes }` (channel); copy/export/filter
text = the delivered names joined with the channel's separator (`Colour · Size`; Amazon `Colour / Size`).

**Placement:** first column after the identity column on every scope, in every default view (it is structure,
like identity). Width 200. Header `Variation theme` on every scope (D-VT1); the tooltip and the editor title use
the channel's noun (`Variation specifics`, `Options`, `Properties` — `family-projection-limits.ts:52-57`).
Locked to the family's parent row and alias rows; `—` with tooltip `Set on the parent` on children.

### 3.4 The cell (36px row; DS `CascadeCell` vocabulary, nothing page-local)

```
master        │ Colour · Size                                    │  (English labels, family order; no mark — master IS the structure)
Amazon · DE   │ 🔗 Farbe / Größe                        [2 of 2] │  link glyph = derived / follows rule; tooltip: "COLOR_NAME/SIZE_NAME · Derived from the family axes"
Amazon · IT   │ 📌 Taglia / Colore                      [2 of 2] │  pin glyph + 7% tint = overridden here (order differs from master on this market only)
eBay · IT     │ 🔗 Colore · Taglia                 🔒            │  lock = live item; tooltip names the item and "changing the set relists"
Shopify       │ 🔗 Colour · Size                    ⚠ 1 dropped  │  3-axis family on a 2-option projection → `style dropped` · collides
child rows    │ —                                                 │  tooltip "Set on the parent"
empty family  │ Set axes…                                         │  muted; `⚠ required` tone when the family has children and no axes
Amazon, none  │ Choose a theme                                    │  warning tone; readiness `theme-unset`
```

- The `n of m` tag renders only when `dropped` is non-empty (`Tag warning`); otherwise nothing trails the text.
- Hover names the source verbatim (`Derived from the family axes` · `Follows rule Apparel default` ·
  `Overridden here`), exactly as `describeCellSource()` does for every other cell.
- Click (the shared open gesture, `openGesture.ts`) opens the editor; a fill handle is **disabled** on this
  column (`reference_ag_fill_handle_swallows_dblclick`).

### 3.5 The editor — `AxesPanelEditor` (`design-system/grid/editors/`, AG popup, `editorBox` kind `'list'`)

```
┌ Variation theme · Amazon · DE ───────────────────────────────── 420 ┐
│ Derived from the family axes                        [Override]      │   ← source row; or `Overridden here · [Reset to rule]`; or `Follows rule Apparel default · [Override]`
│ Theme  [🔍 filter the 50 themes…                              ]    │   ← Amazon only: OptionList of the PT × marketplace enum, typing filters
│   Covers every axis (3)                                             │
│   ● COLOR_NAME/SIZE_NAME   Farbe / Größe                            │
│   ○ SIZE_NAME/COLOR_NAME   Größe / Farbe                            │
│   Drops an axis (12)   ▸                                            │   ← collapsed group; each row names what it drops
│   Deprecated (2)       ▸                                            │
│ Axes on this channel                                                │
│   ☰ ☑ Colour  →  color_name        (Farbe)                          │   ← MappingChip rows; Amazon: order fixed by the theme, grips inert with the reason
│   ☰ ☑ Size    →  size_name         (Größe)                          │
│ ⚠ Live on Amazon DE (ASIN B0…) — changing the theme creates a new   │   ← Banner warning, only when `locked`
│   parent and relinks 20 children. Commit opens the plan.            │
│ 0 collisions on this coordinate                                     │
└──────────────────────────────────────────── Esc discards · ⏎ saves ─┘
```

- **master:** rows are `AxisChip`s (`☰ Colour [2 values]`), drag to reorder; below them `+ Add axis` = the
  `OptionList` of per-variant editable scalar columns (T1's rule, served as `candidates`); typing filters,
  **`,` and `/` add the highlighted candidate** (D-VT7); `×` on a chip removes it. Removing an axis that has
  values on children is refused with the count (`Size has values on 20 variants — remove them first`), the
  same refusal the AXES band gives.
- **eBay / Etsy:** rows `☰ ☑ Colour → [Colore ▾]` — the `Listbox` lists the eligible aspects; unchecking a row
  = dropped on this coordinate (the row says so); `+ Add a specific` while under the limit; limit tag
  `2 of 5`.
- **Shopify:** the target is a free `Input` (the option name), `3 of 3` limit.
- **Amazon:** the theme picker decides the rows; the rows are informational (order and attributes come from
  the theme); the grouped list makes "drops an axis" a deliberate choice, never a surprise.
- **Keys:** Enter commits and Esc discards — AG's, by design; the last reported value is what commits
  (`onValueChange` on every change, `reference_ag36_react_editor_onvaluechange`); an untouched edit is
  discarded (`isCancelAfterEnd`). Arrow keys move the highlight; `,` and `/` add.
- **Commit rules:** unchanged → nothing; changed on an unlocked coordinate → the PATCH (§3.6); changed SET on
  a locked coordinate → the `Change variation theme…` Modal with the dry-run plan (VX §9, D8), nothing written;
  order-only change on a locked eBay coordinate → allowed (a revise, not a relist — VX §7).
- **The Variants dock's section 1 renders this same component** (host = dock, not AG); its `Save mapping`
  footer stays. One component, two hosts, one test file.

### 3.6 Writes — one path

| scope | endpoint | body | store |
|---|---|---|---|
| master | `PATCH /products/:id/studio/variation-axes` (exists) | `{ version, axes: axisKey[] }` | `Product.variationAxes` |
| channel × market (× alias) | `PATCH /products/:id/studio/projection?channel&market&accountId&aliasKey` (exists) | `{ expectedVersion, theme?, mapping: [{axisKey, target, order}] }` | Amazon/Shopify/Etsy: the coordinate's parent `ChannelListing.variationTheme` + `variationMapping`; eBay: per VX D1 the coordinate's `_variationAxes` + `_axisNameLabels` (today `Product.variationTheme`) |
| reset to rule | the same PATCH with `{ reset: true }` (additive) | nulls the override; the read returns `source.kind: 'rule' \| 'derived'` | |

The `SheetWriter` gains ONE engine-owned routing branch keyed on `column.kind === 'variationTheme'` → the
endpoint in `cell.write.endpoint`, CAS on `cell.write.expectedVersion`, 409 → repaint + refetch exactly like
every other cell. **The bulk PATCH's `variation_theme` channel field is removed from `CHANNEL_WRITABLE`** in the
same step (T5) so the fact has one writer. The projection PATCH validates the mapping keys the included
variants (VX.4) — today it does not (VX V8).

### 3.7 Mapping page — `Variations` group (VX §11.1, unchanged, plus one line)

The group as VX designed it (Theme · Axes on channel · Collisions · Listing split · Value maps · Axis names ·
Preview SKU). One addition: when no rule exists the group's header reads `No rule — <n> families follow the
derived theme` and the theme row shows the derivation for the selected category's most common axis set
(`colour × size → COLOR_NAME/SIZE_NAME on 9 of 9 families`). `[List]` opens
`/products/next?filter=variation-mapping:derived|rule|overridden`.

### 3.8 Aliases (VX §10, unchanged)

The column on an alias row (the alias band on a channel scope) shows that alias's projection; the store is
the alias's own parent `ChannelListing` row (`aliasKey`, T10). Amazon has no aliases. eBay per-alias themes
require VX D1. `+ New listing` stays held with the 409 reason until PES.5-ii.

### 3.9 What does NOT change

Chrome heights (56/49/40/40/40), 28px controls, 36px rows, the identity column and its second line, the AXES
columns on master, the Variants page's AXES band and MAPPING band, the dock's other sections (Values,
Collisions, Listing split, Lock), the CH.1 toolbar vocabulary, the five projection words (+ `collides`, VX
D9), the flat-file editors (untouchable), FBA quantity, the existing import.

## 4. Order of work — lanes, ownership, gates

| lane | mandate | owns (claim in `docs/pes-claims.md` first) | done when |
|---|---|---|---|
| **VT.0** measure (read-only, before any code) — **DONE 2026-09-13 by session `[3aec8721]`** (T14–T18; scripts `apps/api/scripts/_vt0-theme-derivation.mts`, `_vt0b-theme-attributes.mts`; Neon prod, SELECT only) | (a) ✅ OUTERWEAR enum on IT and DE (and ES/FR/NL/UK): 52 values, identical sets, `[color,size]` matches TWO spellings everywhere; (b) ⏳ **eBay aspects are an in-memory cache** (`ebay-category.service.ts:122` `richCache`), not a table — the IT/DE `variantEligible` reading needs one live taxonomy call and moves to VT.1's first step; (c) ✅ 35/35 pairs ambiguous, 8 no-axes, 0 unique, 0 none; (d) ✅ by code: the column's options come from `channel-specs/amazon.ts` through the `:60` bypass — VT.1 reads `CategorySchema` directly | the tie-break is FIXED in §3.2 (bare form) and D-VT8 |
| **VT.1** backend (this is VX.1 re-cut around the column) | the resolver `resolveVariationProjection(coordinate)` (three tiers, `source`); **`canonicalThemeSegment` + the schema-property attribute binding (§3.2) replacing the adapter's `${axis}_name` fallback (T15)**; `''` theme = null (T16); `/studio/sheet` serves the `variation_theme` column on every scope per §3.3; candidates from the latest cached schema regardless of expiry (T17); `reset`; the PATCH validates keys-the-variants (VX.4); eBay precedence flip (VX D1, M3) with characterisation tests over every parent listing; ONE theme parser; the `:232`/`:904` disagreement resolved to the resolver; `CHANNEL_WRITABLE.variation_theme` removed; the raw Amazon/eBay theme columns retired from `channel-specs`; readiness items `theme-unset` / `collision` (VX M5); **first step: the live eBay aspects reading for GALE's category on IT and DE (VT.0 b) and the `xracing` 3-axis inconsistency (T18) reported in the ledger, read-only** | `services/pim/family-projection*.ts`, `services/pim/variation-rules.service.ts` (new), `services/pim/sheet-columns.service.ts` + `studio-sheet.service.ts` (the one column), `services/pim/channel-specs/{amazon,ebay}.ts` (retire two columns), `services/listing-wizard/amazon-publish.adapter.ts:410-430` (attribute binding only), `ebay-variation-push.service.ts:900-912` + `ebay-family-axes.service.ts:232` (precedence only), `routes/product-studio.routes.ts` (additive) | contracts in `docs/vt1-contracts.md` first; GALE master/Amazon·IT/eBay·IT/Shopify reads carry the column with the predicted `source`; Amazon·IT `/studio/columns` not slower than 3.77 s (VX M14) |
| **VT.2** GDS | `AxesPanelEditor` + the `variationTheme` cell renderer + `shape: 'axes'` in `sheetColumn.ts`/`shapeColumn.ts` (spread by BOTH builders); `SheetWriter` routing branch; fill handle disabled on the column; the Variants dock section 1 switched to the same component; stories + tests; factory mirror | `design-system/grid/editors/AxesPanelEditor.tsx` (new), `grid/renderers/variationTheme.tsx` (new), `grid/editors/{sheetColumn,shapeColumn,sheetWriter}.ts` (additive), `_studio/variants/channel/dock/sections.tsx` (section 1 only), `apps/factory` mirrors | the column edits on all four scopes on GALE with fixtures, then live; `EDITOR_ONLY=parity node scripts/check-editor-open.mjs --strict` green with the new column in the set |
| **VT.3** mapping page | §3.7 (= VX.2 + the derived line) | `apps/web/src/app/channels/mapping/**` | the group on screen with fixtures, then live |
| **VT.4** live gate + plans + collisions | VX §9 dry-run plans behind the cell commit; `collides` word (VX D9); the catalogue filter `Variation mapping` (VX §11.4) | `services/pim/theme-change.service.ts` (new), `_studio/variants/**` (collisions section), `products/next/**` (filter) | the plan Modal opens from a locked cell on the fixture; no live executor |
| **VT.F** final pass | before/after tables on GALE at 1440×900, functionality matrix (every cell state in §3.4 × every scope), all gates on one clean run | everything above | — |

**Prerequisites:** VP.F's final table closed 2026-09-12 (treat as done unless the Owner says otherwise); LX's
owned paths are off-limits (its build prompt lists them); PES.5-ii before any split lands; the fixture is
GALE-JACKET `cmokmy3a40078pm0p1fvnu523` for two axes and `VX-TEST-3AX` (VX §14, created by VT.1 under XAVIA,
DRAFT, excluded everywhere, deleted by VT.F) for three.

**Gates (every lane, one clean run):** `npx tsc --noEmit -p apps/web/tsconfig.json`, api tsc, vitest for touched
modules, `node scripts/check-ag-grid-import-boundary.mjs`, `node scripts/check-editor-open.mjs`,
`node scripts/check-control-census.mjs` (signed in), `node scripts/check-layout-v2.mjs`,
`node scripts/check-raw-primitives-ratchet.mjs`, `node scripts/check-dark-alias-scope.mjs`, the factory mirror
ratchet. Before any write: state which database `:8091` answers for (`Product.version` on GALE separates local
Docker from Neon); read back after 8 s; a write's response is not what it wrote.

## 5. Decisions only the Owner can make — defaults a lane proceeds on

| # | decision | default |
|---|---|---|
| **D-VT1** | Column header `Variation theme` on every scope (the Owner's word), channel noun in the tooltip/editor title | **Yes** |
| **D-VT2** | The derived tier (§3.2) exists below rule and override | **Yes** — it is what makes "mapped by default" true at thousands of families |
| **D-VT3** | Retire the raw Amazon `variation_theme` and eBay `variationTheme` sheet columns and the bulk-PATCH writer; the new column is the only writer | **Yes** — one fact, one path |
| **D-VT4** | The Variants page keeps its AXES band and mapping dock; the dock's mapping section becomes the shared editor | **Yes** — values, collisions, split and preview need the dock; the column is the fast path |
| **D-VT5** | The eBay axis set moves to the coordinate (VX D1) — required for per-market and per-alias eBay themes | **Yes** — byte-identical today, characterisation test proves it |
| **D-VT6** | A SET change on a live coordinate is a dry-run plan only; no live executor in this programme (VX D8) | **Yes** |
| **D-VT7** | `,` and `/` add the highlighted candidate in the editor (`+` is left alone — it is a value character) | **Yes** |
| **D-VT8** | Amazon derivation tie-break when a PT offers both forms | **DECIDED, and derivable (VT.1, 2026-09-13):** Amazon's own `$lifecycle.enumDeprecated` marks all 28 `_NAME` spellings dead on OUTERWEAR, so the first rule is **`only-live`** (the one non-deprecated match wins); **bare form** (`COLOR/SIZE`) is the tie-break only when both spellings are live (T14–T16: the `_NAME` spelling binds no attribute, the one live child uses the bare form). A listing already carrying `_NAME` keeps it (`kept-from-listing`). The wire says which rule fired (`source.tieBreak`) |
| **D-VT9** | Column position: first after identity, in every default view | **Yes** |

## Appendix A — copy table (verbatim; one source for every lane)

Header: `Variation theme`. Cell: `Set axes…` · `Choose a theme` · `—` · `<n> dropped` · `Set on the parent`.
Source: `Derived from the family axes` · `Follows rule <label>` · `Overridden here` · `Override` · `Reset to
rule`. Editor: `Variation theme · <Channel> · <Market>` · `Theme` · `Covers every axis` · `Drops an axis` ·
`Deprecated` · `Axes on this channel` · `+ Add axis` · `+ Add a specific` · `+ Add an option` · `dropped on
this channel` · `order from the theme` · `<n> of <m>` · `<n> collisions on this coordinate` · `Esc discards ·
⏎ saves`. Lock: `Live on <Channel> <Market> (<id>) — changing the theme creates a new parent and relinks <n>
children. Commit opens the plan.` · `Live on eBay <Site> (item <id>) — changing the set relists it. Reordering
does not.` Refusal: `<Axis> has values on <n> variants — remove them first`. Mapping page: `No rule — <n>
families follow the derived theme`.

## Appendix B — files VT must not edit

LX's owned paths (its build prompt); the flat-file editors (`products/amazon-flat-file`, `products/ebay-flat-file`,
`bulk-operations`, `services/amazon/flat-file*`, `flat-file/registry/*` — the registry's `variation_theme`
master field stays as it is); FBA quantity; the existing import; `_studio/variants/**` outside the dock's
section 1 (VP.F's) unless claimed in the ledger.

## Appendix C — side findings while measuring (not VT's to fix; reported)

- `apps/web/src/app/design/variation-projection/fixtures.ts:174` joins a tuple key with a literal NUL byte
  (`.join('<NUL>')`) — harmless at runtime, but it makes the file "binary" to `grep` (the banked trap
  `reference_nul_byte_in_source_blinds_grep`). `'\0'` as an escape would behave identically and stay greppable.
- `ebay-family-axes.service.ts:232` and `ebay-variation-push.service.ts:904` disagree on whether the listing's
  or the product's theme wins for eBay (T3) — VT.1 resolves it; until then the family-axes read can differ from
  what the push sends.
