# Every attribute a channel supports — a schema-driven attribute model for the sheet

**Status:** 🟢 **APPROVED by the Owner 2026-09-05 ~00:05** ("I'll go with your recommendations"), with the
§7 choices settled as recommended, plus one ruling that amends §3 and §4: *"everything has to be AAA
quality and we do not want any resistance or anything that might limit the experience or the features
applied by the channel or the attributes provided by the channel according to the category for the
user."* → **there are NO exclusions** (§3a below) and **no friction rules in the editor** (§A.3 slot
gating is withdrawn). Written 2026-09-04 ~23:40 by `nexus-commerce-5c` from the Owner's direction of
the same evening. Every number below was measured that night on the local API (`:8091`) and on the
production database through read-only probes (`probe-attr-gap{,2,3,4,5}.mts` in the session
scratchpad), or read at the cited file:line. Nothing is relayed.
**BUILD 2026-09-05 00:10–01:30 (nexus-commerce-5c): the server halves are LIVE on :8091** — adapters
(`services/pim/channel-specs/`), the rebuilt column builder, the one value derivation, list/measure
readiness, slot writes, the `platformAttributes` write path, the equality pass. Measured after:
master·IT 185 / Amazon·IT 186 / eBay·IT 83 columns; GALE's Amazon readiness `live`. Open items and
the full measured record: `docs/pes-claims.md` "### AM.1 — nexus-commerce-5c — BUILT". NOT built:
the engine cells for `list` and `measure` shapes (§A.3 rows 3–4), the eBay cache unification
(§A.5, the adapter reads both caches instead), import/export key forms (§A.6).
Composes with the approved views design (`docs/2026-09-04-sheet-views-and-full-attributes-design.md`):
that one decides *which of the declared columns are on screen*; this one decides *what is declared*.

---

## 0. The Owner's words

> "I've noticed that there are several missing attributes. I want them to be exactly as each channel
> scope supports. For example, we only have a single column for the bullet, but we are supposed to be
> able to write [more] bullets on Amazon. The same goes for eBay, and it is certain that there is some
> attribute inconsistency. I want AAA quality … no inconsistency. And it should be the same for any
> other channels that we connect in the future."

Three asks: (1) the sheet declares **every attribute the channel's schema declares**, in the shape the
channel gives it; (2) the same rule on **every channel, including ones not connected yet**; (3) zero
inconsistency between what the channel holds, what the sheet shows, what readiness says and what a
write lands on.

## 1. Measured tonight

### 1.1 Amazon — OUTERWEAR, the GALE-JACKET family

| reading | value |
|---|---|
| properties in the cached IT/OUTERWEAR product-type schema | **109** (fetched 2026-09-01) |
| of those, columns on the Amazon·IT sheet | **63** — 46 absent |
| absent by shape | 24 single-valued (22 image locators, `variation_theme`, `gpsr_manufacturer_reference`) · 9 value+unit (`item_weight`, `item_package_weight`, `list_price`, `fc_shelf_life`, `num_batteries`, `hazmat`, `language`, `compliance_media`, `externally_assigned_product_identifier`) · 3 multi-sub-property (`gift_options`, `fulfillment_availability`, `child_parent_sku_relationship`) · 10 compound (`item_package_dimensions`, `closure`, `inner`, `outer`, `battery`, `lithium_battery`, `ghs`, `epr_product_packaging`, `purchasable_offer`, `supplemental_condition_information`) |
| multi-valued attributes squashed into ONE cell | **5**: `bullet_point` (max **10**), `material` (3), `ghs_chemical_h_code` (100), `recommended_browse_nodes` (232), `supplier_declared_dg_hz_regulation` (1000) |
| `bullet_point` cardinality × per-bullet cap | **10 × 700 chars on all 49 cached (marketplace × type) Amazon schemas** — IT, DE, ES, FR, UK, NL, every type. The Owner mentioned 56; the channel's own figure is 10 per listing. |
| `generic_keyword` | max **1** on IT/OUTERWEAR (500 chars / 2000 bytes) — one column is right there; **1000** on other types — cardinality varies by coordinate |
| what Amazon itself holds for one GALE child (`platformAttributes.attributes`, present on **725 of 725** listings) | **107 keys**, `bullet_point` = 5 entries, `material` = 2 entries |
| where our bullets live | `ChannelListing.bulletPointsOverride` (String[]): **495 listings × 5, 12 × 6, 5 × 1, 213 × 0** · `Product.bulletPoints`: **0 of 148** OUTERWEAR · `categoryAttributes.bullet_point`: **absent on 148/148** · `localizedContent.*.bulletPoints`: none |
| what the sheet's `bullet_point` cell reads | `cell.value` = **null on every GALE row**, on master AND on Amazon·IT (`ChannelSheet.tsx:1060` reads `.value`; the mapping engine's `mapped.value` beside it holds the 5 bullets) |
| readiness on the GALE child, Amazon·IT | `state: "errors"` — **"Bullet Point is required by Amazon · IT"** while the listing has 5 bullets and Amazon has 5. Master completeness lists `bullet_point` as a missing required field on the same rows. |
| where a sheet write to `attr_bullet_point` on the channel scope would land | the `overrideData` bag (`products.routes.ts:2019`) — `{}` on every GALE listing; the feed, the resolver and the mapping rule (`{"source":"bulletPoints"}`) all read `bulletPointsOverride`. **A write nothing reads.** |
| dead registry columns on every scope | **5**, `editable:false`, help text "No backing column yet" / "follow-up phase": `amazon_bullets`, `amazon_searchKeywords`, `amazon_browseNode`, `ebay_format`, `ebay_duration` |

Across all 49 cached Amazon schemas (5,885 properties): **4,091 single · 501 multi-valued · 480 value+unit
· 635 compound · 178 multi-sub-property** — **30% of what Amazon declares has no shape in today's model.**

### 1.2 eBay — category 177104, IT

| reading | value |
|---|---|
| aspects in the cached category schema | **20** (1 required: Marca/Brand · 3 variant-eligible: Taglia, Colore, Scollatura · 4 multi-value: Adatto a, Features, Protection, Closure/Fastening) |
| aspect columns on the eBay·IT sheet | **0**. The 35 columns are 30 master columns + the 5 static `ebay_*` registry fields (2 dead). |
| what the listings hold (`platformAttributes.itemSpecifics`, 247 of 252 IT listings) | **23 Italian-keyed aspects per GALE child** (Marca, Stile, Colore, Genere, Taglia, Materiale, Protezione, Chiusura …) — none visible, none editable |
| channel-wide listing fields eBay holds per listing | `listingFormat`, `listingDuration`, `conditionId`, `bestOffer`, `handlingTime`, package dims/weight, policies — on 247 listings; the sheet shows `ebay_format`/`ebay_duration` as dead columns "No backing column yet" |
| eBay schema caches | **two**, with two shapes and two marketplace codes: `CategorySchema` rows under `EBAY_IT` (177101, 177104, 177109) and under `IT` (177104); `ChannelSchema` EBAY:IT (20 `aspect_<English>` rows) plus EBAY:\* channel-wide rows — **7 fields inserted 3 times** (21 rows, `marketplace = null` defeats the unique index) |

### 1.3 The premise is right

The Owner's "attribute inconsistency" is measurable on the Owner's own fixture: three stores agree
that GALE has five bullets on Amazon·IT, the sheet shows an empty required cell and readiness reports
an error. On eBay the sheet shows nothing of what the listing is made of.

## 2. The mechanism — one cause, not a list of bugs

1. **Columns come from the MASTER registry; channel schemas only decorate them.** `buildSheetColumns`
   (`sheet-columns.service.ts:310`) walks `fields` (static registry + `schema-to-fields.ts`) and
   uses the Amazon caps and eBay aspects as a JOIN on the master key — a channel field with no master
   twin cannot become a column. That is why eBay·IT has zero aspects (on an eBay-only scope there are
   no `attr_*` fields at all to join against) and why 46 Amazon properties are absent.
2. **Three walkers of the Amazon schema, three copies of the same drop rule.** `schema-to-fields.ts`
   (fields), `schema-caps.ts` (caps) and `mapping/field-catalogue.service.ts` (the mapping editor)
   each hard-code "one cell per attribute; skip anything needing more than `value`; ignore
   `maxUniqueItems`". The two-column-builders trap (`reference_two_column_builders_drift`) one layer
   down: a rule with three copies drifts, and a skip with no output is invisible.
3. **The contract has no vocabulary for shape.** `SheetColumn.kind` is six scalar kinds
   (`text|longtext|number|select|boolean|date`); there is no cardinality, no unit, no sub-field. The
   UI cannot draw what the wire cannot say, and the studio keeps at least three hand-written mirrors of the type
   (`channel/types.ts`, `master/types.ts`, `drawer/types.ts`) — each one a place a new fact can be omitted.
4. **Storage for multi-valued values is per-field folklore.** Bullets have four stores and a fifth
   write target; the wizard encodes lists as a JSON string inside a text attribute
   (`submission.service.ts:1259`); the feed decodes by sniffing for `[`.
5. **Channel writability is a 6-entry table** (`CHANNEL_FIELD_MAP`), not the channel's schema — so
   399 of 441 channel cells route to master (`reference_bulk_patch_routes_six_channel_fields`), and a
   channel attribute that IS pinnable lands in a store no reader reads (§1.1, last row).

## 3. The design

### A.1 — One adapter per channel, ONE output shape: `ChannelFieldSpec`

```ts
interface ChannelFieldSpec {
  key: string                       // channel key: bullet_point · aspect_Brand · listingFormat
  label: string                     // English (D10)          channelLabel?: string  // the channel's own term
  group: string; groupOrder: number // the channel's groups (Amazon __propertyGroups, eBay: Aspects/Listing)
  shape: 'scalar' | 'list' | 'measure' | 'compound'
  kind: 'text' | 'longtext' | 'number' | 'select' | 'boolean' | 'date'   // of the leaf value
  cardinality: { min: number; max: number | null }                      // list: maxUniqueItems / eBay MULTI
  unitOptions?: string[]            // measure: the unit enum
  leaves?: ChannelFieldSpec[]       // compound: flattened scalar leaves (closure.type, inner.material …)
  options?: string[]; optionLabels?: Record<string,string>; mode?: 'strict'|'open'; deprecatedOptions?: string[]
  maxLength?: number; maxBytes?: number
  requirement: 'required' | 'requiredIfRelevant' | 'optional'          // derived, never invented
  variantEligible: boolean; editableOnExisting: boolean
  applicableProductTypes?: string[]; requiredForProductTypes?: string[]
  masterKey?: string                // the master field this links to, when one exists (for inheritance/provenance)
  ownedBy?: 'images' | 'pricing' | 'inventory' | 'compliance'   // another surface shares this store; named in the tooltip, never hidden
}
```

- **Amazon adapter** = ONE walker over the cached product-type definition, replacing the three in §2.2
  (`schema-to-fields.ts`, `schema-caps.ts`, the catalogue's `extractSchemaCaps` call all become callers
  of it). It reads `maxUniqueItems` (cardinality), the authored sub-properties (`value`+`unit` →
  measure; scalar leaves → compound), `$lifecycle`, `__propertyGroups`, root `required` and the
  `allOf if/then` gates (`reference_amazon_requirement_levels_derivation`).
- **eBay adapter** = ONE walker over the aspect cache: `englishName` → key/label, `localizedName` →
  `channelLabel`, `cardinality: MULTI` → list, `aspectMode` → strict/open, `required`,
  `variantEligible` → axis; plus the channel-wide listing fields the listings already carry
  (`listingFormat`, `listingDuration`, `conditionId`, `bestOffer`, `handlingTime`, package
  dims/weight, the three policy ids) as scalars/measures with eBay's own enums.
- **Shopify / WooCommerce / Etsy** implement the same interface when connected. **A new channel is one
  adapter file plus its conformance test — the sheet, readiness, import/export and the write path do
  not change.** That is the Owner's "same for any other channels".
- **Conformance test, every adapter:** `classified == every property of the cached schema` (set
  equality, printed on failure). No property may fall out silently — there is no exclusion path.

### A.2 — Column derivation flips: the channel's spec is the source, master is the join

- **Channel scope:** columns = the channel's `ChannelFieldSpec[]` for this coordinate and product type
  (every field the channel supports), joined to a master key where `masterKey` exists — so inheritance,
  provenance (🔗/✎/⚠/✦) and the cascade keep working exactly as PES.3 built them. A channel field
  with no master twin is a column whose value lives only on the listing (§A.4).
- **Master scope:** columns = master's own fields + every channel field any coordinate in the market
  reads (today's rule), but sourced from the adapters, not from the static `AMAZON_FIELDS`/`EBAY_FIELDS`
  lists. The five dead columns are DELETED; their capabilities become real fields: `amazon_bullets` →
  `bullet_point`, `amazon_searchKeywords` → `generic_keyword`, `amazon_browseNode` →
  `recommended_browse_nodes`, `ebay_format`/`ebay_duration` → the eBay channel-wide fields.
- **Per-coordinate facts stay per coordinate.** `cardinality`, caps, options and requirement are
  carried per column *per coordinate*; a union sheet (master, or a family spanning types) takes the
  tightest and names who set it — the `capFrom` rule extended to cardinality
  (`reference_contract_field_varies_by_market`: `generic_keyword` is 1 on IT/OUTERWEAR, 1000 elsewhere).

### A.3 — Four shapes on screen, each ONE rule in the engine that both builders call

| shape | on screen | editor | readiness | export / import key |
|---|---|---|---|---|
| **scalar** | as today | as today | as today | `key` |
| **list, max ≤ 10** (`bullet_point` 10, `material` 3, `special_feature` 5, `seasons` 5, eBay MULTI aspects with a declared max) | **N numbered columns** `Bullet point 1 … N`, grouped under one header, one array store behind them | the shape's leaf editor per slot (long-text popup for bullets), per-slot cap + counter; **every slot is an independent cell** (Owner ruling 2026-09-05: no gating). The store keeps positions (an empty slot is an empty string), so nothing the operator typed moves; the OUTBOUND payload compacts empties away | on the ARRAY: required ⇒ `≥ min` non-empty slots; per-slot near/over | `bullet_point#1 … #N` — the form the repo's own flat-file mapping already speaks (`flat-file-mapping.ts:67`) and the way Rithum's grid presents bullets; no separator, one value per cell; D15.1 re-import no-op holds |
| **list, max > 10 or unbounded** (`recommended_browse_nodes` 232, `ghs_chemical_h_code` 100, `supplier_declared_dg_hz_regulation` 1000, `fabric_type` 1000 on some types, eBay MULTI aspects with no declared max) | **ONE column**, chip-list cell (count + first values, full list in the tooltip) | DS `MultiSelect` when options exist, DS chip input for free text; the same `ListboxPanel` family the select editor already uses (D18) | same array rule | ONE key column `key[]`, values `|`-separated **and the separator declared in the key row** (`reference_composed_string_invisible_separator`) |
| **measure** (value + unit: `item_weight`, `item_package_weight`, `list_price`, `fc_shelf_life` …; master's own weight/dims join this shape) | ONE column, cell reads `1.2 kg` | number + unit select in one popup (DS), unit enum from the spec | value present AND unit present | two key columns `item_weight.value`, `item_weight.unit` |
| **compound** with scalar leaves (`item_package_dimensions`, `closure`, `inner`, `outer`, `battery`, `lithium_battery`, `gift_options`, `child_parent_sku_relationship`, `epr_product_packaging`, `num_batteries`) | one column per leaf, `Closure · Type`, grouped under the parent's header | the leaf's shape | per leaf, required per the schema's leaf rule | `closure.type` |

The list threshold (10) is ONE constant with its reason beside it; changing it changes every
channel. Everything in the table is engine-owned (`design-system/grid`), spread by BOTH builders —
the parity block in `check-editor-open.mjs` grows one reading per shape.

### A.3a — NO exclusions (Owner ruling 2026-09-05)

Every property the channel declares for the category is a column, image locators and the offer,
fulfilment, compliance and condition compounds included. The `excluded` field of the spec is
DELETED; where another surface already owns a value (the Images tab for the 22 image locators,
Pricing for `purchasable_offer`/`list_price`, Inventory for `fulfillment_availability`) the column
reads and writes **the same store that surface uses**, so the two can never disagree — the cell's
tooltip names the other surface, it never hides the column. Conformance therefore becomes exact:
`classified == every property of the cached schema`.

### A.4 — One store per shape, one write path, readers follow the writer

- **Master:** `categoryAttributes[key]` holds the typed value — `string`, `string[]`, `{value, unit}`,
  or the compound leaf under its path. The wizard's "JSON array inside a text attribute" encoding
  (`submission.service.ts:1259`) is retired at the write; the feed's `[`-sniffing decoder stays as a
  read-compat layer until the sweep, then goes.
- **Channel:** the existing typed column where one exists — `bulletPointsOverride` for
  `bullet_point` (512 listings already there; the feed, the resolver and the mapping rule read it) —
  and `overrideData[key]` for everything else, typed the same way as master. **No new table, no
  destructive migration**: `Product.bulletPoints` and `localizedContent.*.bulletPoints` stay
  read-only legacy layers of the resolver (they already are) and receive no new writes.
- **Writability comes from the spec, not from a table.** A field is channel-writable iff the
  channel's spec declares it and the coordinate carries a listing; `CHANNEL_FIELD_MAP` (6 entries)
  becomes the adapters' `masterKey` links. The write route needs one addition: `attr_*` with
  `target:'channel'` routes to the typed column when the spec names one, else the bag — exactly one
  place, and the same predicate the readers use (`reference_write_predicate_must_match_its_readers`).
  This closes "399 of 441 cells route to master" by construction: the cell says *why* it is not
  writable only when the channel truly does not accept the field (`editableOnExisting: false`).
- **Readiness reads the RESOLVED value** (the same value the cell paints), never `cell.value` alone —
  the false "Bullet Point is required" on 21/21 GALE rows goes with it. One rule per shape (§A.3).

### A.5 — eBay: one cache, one code, English keys with the Italian term beside them

- Unify `EBAY_IT` → `IT` in `CategorySchema` (4 rows) and dedupe the channel-wide `ChannelSchema` rows
  (21 → 7). Additive: rows are re-keyed, nothing dropped; the adapter reads one place.
- Aspect columns keyed by English name (`aspect_Brand`), header English, `channelLabel` = "Marca"
  (D10, identical to Amazon's treatment). Values read from `itemSpecifics` through the aspect's
  `localizedName`, so the 23 aspects each listing already holds appear filled on day one.
- `variantEligible` aspects are axes (Taglia, Colore, Scollatura) — `scope: per_variant`, locked on
  the parent, exactly as Amazon's axes are today.
- MULTI aspects (Features, Protection, Closure/Fastening, Adatto a) are `list`; eBay declares no per-
  aspect max in the cached metadata, so they take the chip-list form and the adapter records
  `max: null` rather than inventing one.

### A.6 — Import/export follow the shapes

The D15.2 key row grows `#n`, `.leaf` and `[]` forms; the diff service matches on them; an
unmodified export re-imports as zero changes on every shape (acceptance 3 of the views design holds
on the wider file). The template endpoint (D15.9) emits every declared column per shape.

## 4. Not in v1, and why

- **A+ content and per-market image TEXT** — PES.7's surfaces; not attributes of the product-type schema.
- **A "best practice" requirement level** — Amazon has none; we do not synthesise one.
- **Per-slot translation UI** — formulas (`translate`) already run per cell; a slot is a cell.

## 5. Acceptance — mechanical, on GALE-JACKET, before any lane reports done

1. **Set equality, every scope:** rendered header set == adapter output == the cached schema's property
   set (expanded per shape). Amazon·IT (every one of the 109 properties has ≥ 1 column), Amazon·DE (per-market cardinality shown), eBay·IT (20 aspects + 7 channel-wide).
2. **Bullets, end to end:** 10 numbered columns; the GALE child shows its 5 bullets read from
   `bulletPointsOverride`; readiness says filled; edit slot 6 → `bulletPointsOverride[5]` (DB read-back
   after ≥ 8 s) → mapping preview shows 6 → export carries `bullet_point#6` → re-import is a no-op.
   Restore by value. Slot 8 edited with 7 empty stays in slot 8 on reload; the feed preview omits the hole.
3. **eBay, end to end:** Marca reads "Xavia Racing" from `itemSpecifics`; Features renders chips;
   Brand counts as required-filled; an edited aspect lands in `overrideData.aspect_Features` and the
   eBay push preview shows it.
4. **Measure:** `item_weight` paints `1.2 kg`; edit → `{value, unit}`; the Amazon payload preview shows
   both sub-properties.
5. **Parity:** b0's `parity` block grows one reading per shape and passes on all three scopes.
6. **Performance:** §4a budgets of the views design apply unchanged (column virtualisation is ON);
   time-to-interactive measured before/after on Amazon·IT with the wider set, written as a pair.
7. **No dead columns:** zero columns with `editable:false` whose help text says "no backing column".
8. **Conformance:** every adapter's test fails when a schema property is neither classified nor
   excluded — proven by a mutation that deletes one classification branch.

## 6. Lanes (the Owner assigns)

- **Server, adapters + contract** (`services/pim/channel-specs/{amazon,ebay}.ts`, the shape vocabulary
  on `SheetColumn`, the one write predicate, readiness on resolved values, eBay cache unification).
- **Engine shapes** (`design-system/grid`: numbered-slot group, chip-list cell + editor, measure cell
  + editor, leaf grouping) — lands beside b0's editor shell, not inside it.
- **Both sheets** consume the engine (master + channel), delete the static channel lists.
- **Import/export** key-row forms; **mapping editor** consumes the same adapter.
- **UX witnesses** for acceptance 1–4.

## 7. Three choices — DECIDED by the Owner 2026-09-05 (all three as recommended; choice 3 superseded by §A.3a: nothing is excluded)

1. **Bullets as numbered columns (1–10) or as one list cell?** Recommend **numbered columns up to the
   channel's max** — it is how Amazon's own template, Seller Central's form and Rithum's grid present
   them; each bullet gets its own cap, counter, formula and import key. The list-cell form is kept for
   the unbounded lists only.
2. **Canonical bullet store on the channel: keep `bulletPointsOverride`** (typed, 512 listings, every
   reader already on it) rather than moving bullets into the bag. Recommend **keep**; retire the two
   legacy master stores from writes only.
3. **The declared exclusions** (image locators, `purchasable_offer`, `fulfillment_availability`,
   `supplemental_condition_information`, `compliance_media`, `hazmat`, `language`): confirm each stays
   on its own surface, or name any the sheet should carry anyway.
