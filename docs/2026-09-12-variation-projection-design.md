# Variation projection — rules, aliases and delivery (VX) — design and build plan

**Status:** 🟡 **FOR APPROVAL, with defaults.** Written 2026-09-12 by `nexus-commerce-c2 [93b6b8]` on the
Owner's word of the same day ("Yes, please", after the terminal proposal). Every decision in §15 carries a
default the Owner can overrule in `docs/pes-claims.md`; a lane proceeds on the defaults. **Nothing is built.**
Lane prompts: `docs/vx-prompts.md`. The Owner launches and manages the lanes (ledger #794). Nothing is committed
until the Owner says so.

**Composes with, and does not reopen:** the Variants page spec (`docs/2026-09-11-variants-page-spec.md`) and its
final contracts (`docs/vp2-contracts.md`), the language-axis design (`docs/2026-09-11-language-axis-design.md`,
being built by Codex as LX.0–LX.2 at the time of writing), the channel attribute model
(`docs/2026-09-04-channel-attribute-model-design.md`), the global mapping engine
(`docs/2026-09-01-pes6-global-mapping-engine.md`), the alias layer (`docs/pes5-phase0-backend.md` §2, §3.4), the
studio layout (`docs/2026-09-01-product-edit-studio-layout.md` §1b, §2.10, §5) and the CH.1 sheet-chrome rule.

**Prerequisites, in order:** (1) VP.F reports "100% done" — it owns every `_studio/variants/**` path plus the
frame and the DS until then; (2) LX keeps its owned paths (its build prompt lists them) — VX touches none;
(3) PES.5-ii (alias creation) before any split lands live. VX.1 (backend) can start before (1); VX.3 cannot.

---

## 0. The Owner's words (2026-09-12, verbatim where it matters)

> "I should have proper control over each and everything … two variation axes on Shopify but three on Amazon …
> for each market or each localized language, I want the variation axis to be named what the users of that
> market could understand … we should be seeing just the English version … Everything must be happening in the
> backend. I should also be able to see what's actually going live to the channel or preview … manageable at a
> scale of thousands of products … is changing a variation theme really a thing? … set business rules to manage
> it all, and then … override … in the product edit studio."

> "Certain channels might have multiple aliases … would I have the ability to choose different variation themes
> or reorder the variation axes and the values of variation axes for the different aliases?"

> "Instead of translating the [axis] values, would you recommend keeping the original value itself so that we
> also know what exactly is being pushed, even before the preview? I just mentioned the name of the axis itself."

Seven asks: per-channel axis sets · market-vocabulary axis names with English in Nexus · a live preview ·
thousands of products · a truthful answer on theme changes · rules with per-product override · per-alias
projections. Plus one constraint the Owner set on 09-12: **values are not translated; what you see is what is
pushed.**

## 1. What was measured (2026-09-12, working tree at `80f6cfb84`, ~1,900 dirty paths)

| # | reading | value |
|---|---|---|
| V1 | family axes store | `Product.variationAxes String[]` (`schema.prisma:297`); keys canonicalised by `variant-attribute-keys.ts:2` (colore/colour/farbe → `color`, taglia/taille/talla/größe → `size`, stylename → `style`) |
| V2 | child axis values | `Product.categoryAttributes.variations` **and** `Product.variantAttributes` (vp2-contracts M3) — free text; GALE's two XXS rows read `XS` there (VP.F D7) |
| V3 | a codes-with-labels store already exists | `CustomAttribute` (`:635` — `code`, `label`, `localizable`, `scope 'global' \| 'per_variant'`, `options[]`) + `AttributeOption` (`:670` — `code`, `label`, `sortOrder`). **Not used by variation axes today** |
| V4 | projection store, per coordinate | parent `ChannelListing.variationTheme` (`:1609`) + `variationMapping` (`:1612`), keyed (channel, marketplace, account, `aliasKey`); non-null on **0 of 999** (mapping) and **21** (theme) rows (M5) |
| V5 | eBay axis SET precedence | `Product.variationTheme` wins over the coordinate's `platformAttributes._variationAxes` (`ebay-variation-push.service.ts:904-909`); names per coordinate `_axisNameLabels` (`:887`); value order `_axisValueOrder`; last published `__lastPublishedAxes[marketplaceId]` (`:542-569`). **One set for every eBay market and alias** |
| V6 | Shopify options source | `content-publisher.ts:218-219` builds `productOptions` from `content.axes`; `content-workspace.service.ts:43` seeds those from `family.variationAxes`. **The projection mapping is never read.** Option translations: `information-translations.ts:30` registers PRODUCT keys + metafields only; `ProductOption` / `ProductOptionValue` are translatable on the platform (Admin API 2026-07) |
| V7 | Amazon relationship write | `amazon-publish.adapter.ts:407-416` child PUT carries `parentage_level`, `child_parent_sku_relationship`, `variation_theme` **per marketplace**; axis attribute names from the flat `variationMapping`, fallback `<axis>_name` (`:378-388`). `variation_theme` is a sheet column on the Amazon scope (`channel-specs/amazon.ts:58`; 50 enum options on IT/OUTERWEAR, M13). `patchListingsItem` (`amazon-sp-api.client.ts:778`) and `deleteListingsItem` (`:1133`) exist |
| V8 | projection PATCH validates | known axis · ≤ `limits.axes` · no duplicate target · lock on SET change · alias creatable (`family-projection.service.ts:1412-1470`). **Not validated: that the mapped subset still keys the included variants** |
| V9 | value maps | `FieldValueMap` (`:2097` — channel, marketplace `'*'` or code, attribute, fromValue → toValue, confidence, reviewedAt) + `valueMap` transform op (`resolve-channel-field.ts:335-349`, onMiss keep\|null\|flag). Catalogue-level, cached 5 min |
| V10 | rules engine | `MarketplaceSchemaMapping` (`schema-mapping.service.ts:55-84`): `fields`, `byProductType[<category>]`, `expressions` (named business rules), `presentationRules`. Routes `channel-mapping.routes.ts` (templates `:69`, categories `:230`, expressions `:263-265`, `reviewRequired`). **No variations block** |
| V11 | aliases | `ProductListingAlias` (`:1817`) per (product, channel, marketplace, account, position); `ChannelListing.aliasId` / `aliasKey` (`''` = primary); projection read/write per `aliasKey` (`family-projection.service.ts:1021-1044`); eBay presentation order per `aliasKey` (`:1097`); creation **blocked** while the legacy unique indexes exist (`legacyAliasIndexesPresent`, M10); **0** alias rows (M11); 22 eBay shell products as the workaround (pes5 F2) |
| V12 | studio scope bar | account + market listboxes; a listing selection exists only as `listingId` + "Selected listing · Clear" (`StudioBar.tsx:37`) — no listbox |
| V13 | projection vocabulary | five words (`design-system/grid/renderers/projection.ts:52`) |
| V14 | three-axis family on prod | none known (GALE, MISANO, AIREON, XRI01 are ≤ 2 axes) — the collision rule has no natural fixture; §14 creates one |
| V15 | Amazon children carrying a theme in our data | **1 of 228** active (#718) — the Amazon projection is thin in data, not only in code |

## 2. Principles — each is a rule a lane can be measured against

- **VX.0 One structure, many projections.** Unchanged from the Variants spec §1.1.
- **VX.1 A rule first, an override second.** A projection reads the channel × market × category rule unless the
  listing row carries its own theme/mapping. `null` on the row = follows the rule. The source is always on screen.
- **VX.2 Axis names are the channel's vocabulary, never a translation.** Amazon owns the name (the theme fixes
  the attribute key; Amazon prints "Farbe"). eBay takes the **site's aspect name** for the canonical key from the
  cached category aspects ("Farbe" on DE, "Colore" on IT). Shopify takes the English label; per-locale
  translations are optional (D6). Nexus shows the English label everywhere.
- **VX.3 Values are pushed verbatim.** One stored value per variant, shown on every scope. A reviewed value map
  per channel × market may convert it; the channel-state cell shows the **outbound** word with its provenance. No
  per-product, per-language editing of a value, ever.
- **VX.4 A projection must key the variants.** The mapped axes on a coordinate must uniquely identify every
  included variant; otherwise the save is refused until a resolver is chosen (§6).
- **VX.5 The preview runs the engine.** The payload shown is produced by the same adapter functions the publish
  path calls, in dry-run. A second renderer of the rules is a defect (PES.0 ruling #2 applied to variations).
- **VX.6 A theme change is an operation, per channel, with a plan.** Never a cell edit on a live parent (§9).
- **VX.7 Aliases are coordinates.** Everything that is per coordinate is per alias; the eBay set joins them (D1).
- **VX.8 Codes, not strings.** An axis is a `CustomAttribute` with `scope: 'per_variant'`; a value is an
  `AttributeOption`. The label is what you see and what goes out. The two XXS rows are what free text does to a
  tuple.

## 3. Vocabulary and the contracts (proposed here, FINAL in `docs/vx1-contracts.md`, written by VX.1 first)

Names below are the only spelling. `axisKey` is always the canonical key (`color`, `size`, `style`).

```ts
/** Stored on MarketplaceSchemaMapping.variations and byProductType[<category>].variations (§4 M2). */
export interface VariationRule {
  /** AMAZON: a value of the product type's variation_theme enum. Every other channel: null. */
  theme: string | null
  /** The axes this channel RECEIVES, in projection order. A family axis absent here is DROPPED on this channel. */
  axes: Array<{ axisKey: string; target: string | null; order: number }>
  collisions: { resolver: 'split' | 'fold' | 'exclude'; foldInto?: string; foldSeparator?: string }  // D3, D10
  split: { mode: 'single' | 'per-axis'; axisKey?: string }
  updatedAt: string
  updatedBy: string | null
}

export interface ProjectionSource {
  kind: 'rule' | 'override' | 'none'
  /** "Apparel default" — the category the rule was found under, or the channel-wide rule's label. */
  ruleLabel: string | null
  category: string | null
}

export interface CollisionGroup { key: Record<string, string>; variantIds: string[]; skus: string[] }
export interface CollisionReport {
  groups: CollisionGroup[]
  resolver: VariationRule['collisions'] | null
  /** How many groups the resolver settles, and how many it cannot (e.g. split while aliases are not creatable). */
  resolved: number
  unresolved: number
  /** The server's sentence, rendered verbatim in the band and the dock. */
  summary: string
}

/** One axis as it will be DELIVERED on this coordinate. */
export interface AxisDelivery {
  axisKey: string
  /** What the buyer sees as the axis name: Amazon — the label Amazon prints (informational); eBay — the site aspect; Shopify — the option name. */
  channelName: string
  nameSource: 'channel' | 'site-aspect' | 'label' | 'pinned'
}

/** Extends vp2-contracts §4.1 ProjectionRead. Every field is served; the UI composes nothing. */
export interface ProjectionReadVx /* extends ProjectionRead */ {
  source: ProjectionSource
  collisions: CollisionReport
  delivery: AxisDelivery[]
  /** Every listing on this channel × market × account, for the scope-bar listbox. Primary first. */
  listings: Array<{ aliasKey: string; label: string; position: number; state: string }>
  /** Which family axes are included on this coordinate (the dock's include toggles). Order = projection order. */
  axesOnChannel: Array<{ axisKey: string; included: boolean; droppedReason: string | null }>
}

export interface ProjectionPreview {
  coordinate: { channel: string; market: string; accountId: string | null; aliasKey: string; label: string }
  buyerView: { axes: Array<{ name: string; values: string[] }>; sample: { sku: string; selections: Record<string, string> } }
  payload: { format: 'sp-api-listings-item' | 'ebay-trading-xml' | 'ebay-inventory-group' | 'shopify-product-set' | 'etsy-listing'
             parent: unknown; child: unknown }
  diff: { lastPublishedAxes: string[] | null; added: string[]; removed: string[]; renamed: Array<[string, string]> }
  /** Every warning the adapter would raise on the live path (missing value, unknown attribute), verbatim. */
  warnings: string[]
  meta: { tookMs: number; adapter: string }
}

export interface ThemeChangePlan {
  kind: 'amazon-new-parent' | 'ebay-relist' | 'shopify-in-place'
  coordinate: ProjectionPreview['coordinate']
  steps: Array<{ n: number; verb: string; target: string; detail: string; reversible: boolean }>
  keeps: string[]
  loses: string[]
  /** Always true in this programme (D8). The live executor is a separate approval. */
  dryRun: true
}
```

Every write is CAS on the listing `version` exactly as vp2-contracts §4.2; a 409 carries the current read.

## 4. Data model — all additive, no column dropped

- **VX.M1 Axes and values become codes.** An axis = a `CustomAttribute` row with `scope = 'per_variant'`,
  `code` = canonical key, `label` = English ("Colour"). A value = an `AttributeOption` (`code 'black'`,
  `label 'Nero'` — the label is the word the Owner chose, and the word that goes out). `Product.variationAxes`
  keeps canonical keys (V1 already canonicalises). The child value store becomes `variantAttributes[axisKey] =
  <option code>`; readers resolve the label through the option. **Backfill** (its own step, dry-run first, per
  family): each existing string becomes an option with `code = slug(string)` and `label = string`; unknown axis
  keys become attributes with `label = key`. The XXS/XS rows are **reported, not corrected** (VP.F D7). Until the
  backfill runs on a family, the read path treats the string as both code and label — byte-identical output.
- **VX.M2 The rule block.** `MarketplaceSchemaMapping.variations?: VariationRule` (channel-wide) and
  `byProductType[<category>].variations?: VariationRule` (per channel category), in the existing JSON template.
  No migration. Category key: Amazon = product type (`Product.productType`, `:134`, the listing's `productType`
  when set); eBay = `platformAttributes.categoryId`; Shopify/Etsy = product type. Precedence: category → channel
  wide → none.
- **VX.M3 The eBay set joins the coordinate (D1).** Precedence at `ebay-variation-push.service.ts:904-909` flips
  to: the coordinate's stored `platformAttributes._variationAxes` **when non-empty**, else `Product.variationTheme`,
  else legacy. Today every coordinate but GALE's is empty, so the flip is byte-identical on the catalogue and a
  characterisation test says so before and after. `Product.variationTheme` stops being written by the projection
  PATCH; it stays readable as the product-level default.
- **VX.M4 Override = the listing row.** `ChannelListing.variationTheme` / `variationMapping` non-null means
  "overridden here"; `Reset to rule` nulls both. This is already the state of 978 of 999 rows.
- **VX.M5 Readiness items.** Four new item kinds for the coordinate: `mapping-missing` (source `none`),
  `collision` (unresolved > 0), `unreviewed-value-map` (a map with `reviewedAt = null` on the path), `theme-unset`
  (Amazon, no theme). They live in `ReadinessIndex` when LX.5 has landed; until then `scope-readiness.service.ts`
  computes them uncached and the catalogue filter states that it is uncached.
- **VX.M6 Value maps unchanged.** `FieldValueMap` stays the only place a market word enters. Per-variant pins stay
  in the override cascade on the child listing row.

## 5. Resolution — one function per question, on the server

```
projection(coordinate)  = rule(channel, market, category)   ⊕  override(parent listing row)   ⊕  pins(child rows)
axis name(axis, coord)  = pinned _axisNameLabels[axis]  →  site aspect name for the canonical key (eBay/Etsy)
                          →  the English label (Shopify)  →  Amazon: informational, the theme decides
axis value(variant, axis, coord) = pin (child row)  →  FieldValueMap(channel, market)  →  FieldValueMap(channel, '*')
                          →  the option label
```

Provenance uses the existing `classifyProvenance` vocabulary: a pin is `pinned`; a map hit is `inherited` with
`from = "Value map · Amazon DE"`; a label is `inherited` with `from = "Shared value"`. No new provenance member.
The mapped-value cell on the channel state renders the RESULT of the chain, so the operator reads the outbound
word without opening the preview (the Owner's 09-12 constraint).

## 6. The collision rule (VX.4)

Given the included variants `V` and the mapped axes `A` on a coordinate, `key(v)` = the tuple of `v`'s option
codes on `A`. A **collision** is two included variants with equal `key`. `GET` always reports them; `PATCH`
refuses with `400 collision_unresolved` a mapping whose groups have no resolver or a resolver that cannot run.

| resolver | what it does | writes through | when it cannot run |
|---|---|---|---|
| `split` | one listing per value of the first dropped axis — an alias per value, labelled by the value's label | the alias route (pes5 §3.4) + `split.mode = 'per-axis'` | aliases not creatable (M10) → `unresolved`, held with the reason |
| `fold` | appends the dropped axis's value label to the `foldInto` axis's value, separator `foldSeparator` (default `" / "`, D10): `L / Slim` | the existing pin path on the child row (vp2 §4.3 — no new write path) | `foldInto` not in `A` |
| `exclude` | keeps the first variant per key (axis value order, then SKU), excludes the rest on this coordinate | `PATCH …/projection/children` (vp2 §4.3) | never |

A dropped axis is shown as dropped, by name, in the band ("style dropped") — an axis silently missing is the
two-column-builders trap in another vocabulary.

## 7. What each channel accepts — facts a lane relies on (sources in Appendix A)

| | Amazon | eBay | Shopify | Etsy |
|---|---|---|---|---|
| axes per listing | theme from the PT enum (1–3 segments) | ≤ 5 specifics | ≤ 3 options | 2 properties |
| variants per listing | no sourced cap | 250 | 100 (2048 new API) | 70 |
| axis NAME | Amazon's, from the theme; localised by Amazon | the site's aspect name; a non-aspect name becomes a custom specific outside the filters | free; translatable per locale on `ProductOption` | property list |
| axis VALUE | free text per marketplace listing; `color_map` is a separate closed enum, not an axis | free; site recommended values feed the filters | free; translatable on `ProductOptionValue` | property values |
| theme/set per market | **yes** — relationships are per marketplace | per site once M3 lands | one store, one set | per shop |
| change the set on a live listing | **no in place**: new parent + relink (Amazon's own 2025 procedure); parent/child theme mismatch → 8541-class errors | **relist** (proven 2026-07-25, code 21916664); reorder + add values = revise | **in place**: `productOptionsCreate` / `productOptionUpdate` / `productOptionsDelete` with a variant strategy; positions sequential; every option used by ≥ 1 variant | relist |

## 8. Preview (VX.5)

`GET /api/products/:id/studio/projection/preview?channel&market&accountId&aliasKey&sampleChildId` →
`ProjectionPreview`. Built by calling the publish adapters with **no HTTP**: Amazon `buildChildAttributes` + the
parent envelope (`amazon-publish.adapter.ts:370-425`) under the client's dry-run; eBay the push's plan builder
(the same code that composes `<Variations>` before `ReviseFixedPriceItem` / the inventory group); Shopify the
`productSet` input builder (`content-publisher.ts:218-224`). A test pins **preview payload ≡ live payload**: the
same function is called with `dryRun: true`, and the test fails if a second composer appears. `buyerView` is
derived from the payload, never from the mapping. `diff` reads `__lastPublishedAxes[marketplaceId]` and the parent
listing's `platformAttributes` (eBay), the last submission snapshot (Amazon), the read-back (Shopify).

## 9. Theme change operations (VX.6)

`POST /api/products/:id/studio/projection/theme-change` body `{ expectedVersion, kind, theme?, mapping?, dryRun: true }`
→ `ThemeChangePlan`. **In this programme `dryRun` is the only accepted value** (D8). The live executor is designed
here, built later under its own approval, and the Owner runs the first live one.

- **`amazon-new-parent`** (per marketplace): (1) PUT a new parent SKU `<parentSku>-P<n>` with the new theme;
  (2) per child, PATCH `child_parent_sku_relationship` → the new parent, `variation_theme` → the new theme, the
  axis attributes the theme needs; (3) after an 8 s read-back of every child, `deleteListingsItem` on the old
  parent. Keeps: child ASINs, reviews, sales history, offers. Loses: the parent ASIN and its URL, A+ attachment on
  the parent, ads targeting the parent ASIN. The Nexus product does not change — the parent listing row's
  `externalId` does.
- **`ebay-relist`** (per site, per alias): Trading — end + relist with the new specifics; Inventory — republish
  the group. Keeps: SKUs, EANs, prices, stock (echoed). Loses: ItemID, watchers, sales history, best-match age.
  Only when the SET changes; order and added values are a revise and never reach this plan.
- **`shopify-in-place`**: `productOptionsCreate` (a new option gives every existing variant a value — the plan
  names it), `productOptionUpdate` (rename, values), `productOptionsDelete` with the variant strategy; constraints
  stated in the plan (sequential positions, every remaining option used). Keeps variant ids where Shopify keeps
  them; the plan lists the ones it cannot.

## 10. Aliases (VX.7)

- **Listing listbox** in the scope bar's right slot, beside account and market: `Primary · ② Outlet · ③ Nero ·
  + New listing`. `+ New listing` is rendered and **held** with the reason while `createAlias` returns 409 (M10),
  never silently hidden. Selecting one sets `aliasKey` on the URL the way `listingId` does today (V12).
- **Shared state:** the CHANNEL PROJECTIONS strip gets one column per coordinate **including aliases**, header
  `eBay · IT ②` (market suffix rule from VP.F D11 unchanged). Inclusion across every listing on one screen.
- **Channel state:** one listing at a time. Mapping band, dock, grid and preview are that listing's. The eBay
  Variation order task stays alias-scoped as it is.
- **Split per-axis** creates aliases labelled by the value label ("Nero", "Giallo"), position by value order.
- **Amazon:** no aliases (one ASIN per seller per marketplace); the listbox shows `Primary` only and says why on
  hover. A second Amazon listing is a second account or the new parent a re-theme creates.

## 11. UI anatomy — every control named, DS only, copy verbatim in Appendix C

### 11.1 `/channels/mapping` — the Variations section (VX.2)

Rendered inside the mapping page under the selected category, after the field grid's groups, as its own group
`Variations` (the Rithum frame's grouped rows; DS `PageHeader`, `Listbox sm`, `OrderedList`, `Radio`, `Tag`,
`Button sm`; nothing page-local):

```
▾ Variations                                                   38 follow · 3 override  [List]
   Theme               [SIZE/COLOR/STYLE ▾]           Amazon only; the PT enum with its labels
   Axes on channel     ☰ colour → color_name   ☰ size → size_name   ☰ style → style_name   ☐ (none dropped)
   Collisions          (•) split per dropped axis   ( ) fold into [size ▾] with " / "   ( ) exclude
   Listing split       (•) one listing   ( ) one per [axis ▾]
   Value maps          colour: 12 mapped · 2 unreviewed   size: none   [Open value maps]
   Axis names          Amazon prints the names · eBay: from the site's aspects · Shopify: English labels
   Preview SKU         [GALE-JACKET-BLACK-XL ×▾]  → the same preview dock as the studio (§8), for this SKU
```

Save = `PUT /pim/channel-mapping/:channel/:code/variations[/:categoryId]` under `reviewRequired`, with the
existing blast-radius simulation before it commits ("38 products follow this rule · 12 would gain a collision").
`[List]` opens `/products/next?filter=variation-mapping:overridden&channel=…&market=…`.

### 11.2 Studio · Variants · channel state (VX.3, after VP.F)

- **Mapping band (40px, one row at 1280):** `MAPPING` · MappingChips · `2 of 3 themes` · divider ·
  `Follows rule Apparel default` **or** `Overridden here` (12.5 `--nds-text-2`) · `1 collision` (`Tag warning`,
  only when non-zero) · sentence · right `Edit mapping` · `Preview` (`Button sm`).
- **Dock (420, sections in this order, all visible at 900 for a 3-axis family):**
  1. `Variation theme` / `Variation specifics` / `Options` — source row `Follows rule Apparel default ·
     [Override]` or `Overridden here · [Reset to rule]`; per family axis a row `☑ ☰ colour → [color_name ▾]`,
     unchecked = dropped (the row says `dropped on this channel`); Amazon adds the theme listbox above the rows.
  2. `Values` — per axis with differences a mini-table `Shared · On Amazon DE · Included` (`Nero · Schwarz · 9`,
     the second column carries the provenance mark); one line for an axis with none.
  3. `Collisions` — the server's `summary` sentence + the resolver radios; empty state `No collisions on this
     listing.`
  4. `Listing split` — unchanged (held until PES.5-ii).
  5. Lock banner — unchanged.
- **Preview dock:** same 420 track, opened by `Preview`, replaces the dock content (a segmented control `Mapping ·
  Preview` at the dock header switches back). Three blocks: `Buyer view` (axis names and values in the market's
  words), `Payload` (`parent` / `child` tabs, mono, copy button), `Changes since last publish` (added / removed /
  renamed). Warnings as a `Banner warning` above the blocks.
- **⋯ menu (channel state):** `Change variation theme…` (Amazon), `Relist with new specifics…` (eBay), `Change
  options…` (Shopify) → a `Modal md` that shows the `ThemeChangePlan` (steps table, keeps, loses) with ONE button
  `Copy plan` — no live run in this programme (D8).

### 11.3 Studio · Variants · shared state (VX.3)

- Strip: one projection column per coordinate including aliases (§10).
- Sixth projection word **`collides`** (D9), tone from `readinessMeta('missing','row')`, checkbox enabled: the
  variant is included but the coordinate cannot key it. Next click opens the mapping dock's Collisions section.
- `Manage shared axes` dialog: the axis picker lists `CustomAttribute` rows with `scope = 'per_variant'` and
  creates one inline; the value editor on axis cells lists that attribute's `AttributeOption` rows and creates one
  inline. **No Labels tab** — values are not translated (VX.3).

### 11.4 Catalogue `/products/next` (VX.4)

- Filters: `Variation mapping` = follows rule · overridden · collisions · missing · theme unset, per channel and
  market; fed by §4 M5.
- Bulk verb on the selection: `Apply mapping rule…` → dry-run count (`14 families · 3 overrides removed · 0 new
  collisions`) → apply = null the overrides on the chosen coordinates through the projection PATCH, one CAS each,
  results table. Never touches a family with an unresolved collision — it lists them instead.
- `FamilyFooter` shows the selection's counts.

### 11.5 What does NOT change

Chrome heights, 28px controls, the one primary button, the sub-sidebar, the toolbar vocabulary and chip set (the
collision count lives inside `Mapping errors`), the column groups, the identity band, row order, the eBay
`Variation order` task, the five existing projection words, the alias band on the Information sheet.

## 12. Scale — why this holds at thousands

Rules per category mean the common family stores **zero** projection rows; only exceptions write. Readiness items
are materialised per coordinate (§4 M5) and the catalogue filters read the index, never a per-product read.
Value maps are catalogue-level and cached. The projection read must **not** add a live SP-API call: it reuses
the cached PT schema for the theme enum (the `channel-specs/index.ts:60` bypass is LX's to fix and is not
touched here). The number not to regress: Amazon·IT `/studio/columns` **3.77 s** (M14); the projection read on
GALE is measured before and after every VX.1 phase and written in the ledger.

## 13. Order of work, lanes, ownership

| lane | mandate | owns (claim in the ledger first) | first deliverable |
|---|---|---|---|
| **VX.1** backend | `docs/vx1-contracts.md` FINAL; M1–M6; §5 resolution; §6 collision; §8 preview; §9 dry-run plans; Shopify publisher reads the projection (V6); eBay precedence flip (M3) with characterisation tests; the three-axis fixture (§14); backfill dry-run report | `services/pim/family-projection*.ts`, `services/pim/variation-rules.service.ts` (new), `services/pim/variation-preview.service.ts` (new), `services/pim/theme-change.service.ts` (new), `services/pim/variant-attribute-keys.ts`, `routes/product-studio.routes.ts` (additions), `routes/channel-mapping.routes.ts` (additions), `schema-mapping.service.ts` (additive `variations` only), `services/shopify/content-workspace.service.ts` + `content-publisher.ts` (the axes SOURCE only), `ebay-variation-push.service.ts:900-912` (precedence only) | contracts file within the first phase, so VX.2/VX.3 code against it |
| **VX.2** mapping page | §11.1 | `apps/web/src/app/channels/mapping/**` | the Variations group on screen with fixtures, then live |
| **VX.3** studio | §10, §11.2, §11.3 — **starts only after VP.F's "100% done"** | `_studio/variants/**`, `_studio/StudioBar.tsx` (the listbox — claim it), `_studio/useWorkspaceDestination.ts` (aliasKey from the URL — claim it), DS additions (`collides`, the preview dock pieces) under `design-system/**` with a claim | band + dock sections on GALE with fixtures, then live |
| **VX.4** catalogue + readiness | §11.4, §4 M5 | `apps/web/src/app/products/next/**` (filters, bulk verb, footer), `services/pim/scope-readiness.service.ts` (item kinds — coordinate with the LX.5 owner in the ledger before editing) | filters on screen from the index |
| **VX.F** final pass | before/after tables, functionality matrix, all gates, on the fixtures | everything above | — |

Until VX.1's contracts are final, VX.2/VX.3/VX.4 build against typed fixtures shaped by §3 and switch without a
redesign. Cross-lane needs are ledger requests; the Owner decides conflicts. **LX's owned paths are off-limits to
every VX lane**; a need there is a ledger request to LX.

**Gates (every lane, bare, one clean run):** `npx tsc --noEmit -p apps/web/tsconfig.json`, api tsc, vitest for
touched modules, `node scripts/check-ag-grid-import-boundary.mjs`, `node scripts/check-editor-open.mjs`,
`node scripts/check-control-census.mjs` (signed in), `node scripts/check-layout-v2.mjs`,
`node scripts/check-raw-primitives-ratchet.mjs`, `node scripts/check-dark-alias-scope.mjs`.

## 14. Verification — measured, on screen, on the fixtures only

- **Fixtures:** GALE-JACKET `cmokmy3a40078pm0p1fvnu523` (2 axes, 20 children; eBay·IT account
  `cmr4aaqb00025nz016k18rup9`) for everything two-axis. **A three-axis fixture does not exist (V14):** VX.1
  creates `VX-TEST-3AX` under the XAVIA family through the existing generate endpoint (spec §3.4): parent + 8
  children (colour × size × style = 2 × 2 × 2), status DRAFT, **excluded on every coordinate, never published**,
  announced in the ledger BEFORE creation, deleted by VX.F at the end with a ledger line. Never another product.
- **Before any write:** state which database `:3000 → :8091` answers for (`Product.version` on GALE separates
  the local Docker `nexus_development` from Neon — re-measure, do not inherit). If prod, rehearse on the fixtures
  only; read back after 8 s; a write's response is not what it wrote.
- **Preview ≡ live** test (§8) and **precedence characterisation** tests (M3: identical output on every
  coordinate before and after the flip, asserted over the whole catalogue's parent listings, read-only).
- **Collision matrix** on `VX-TEST-3AX`: each resolver × each drop; fold produces `L / Slim` pins and the
  read-back shows them `pinned`; exclude leaves exactly 4 included; split is `unresolved` while M10 holds.
- **Screen parity:** band 40, controls 28, dock sections in §11.2 order visible at 900, one toolbar row at 1280,
  copy verbatim to Appendix C. Numbers, never adjectives. A claim must match its measurement.
- **DONE for a lane:** every item in its §13 row measured green, all gates green on one clean run, zero console
  errors on the states it owns, its ledger section holds the numbers, nothing committed, nothing outside its owned
  paths edited without a ledger claim.

## 15. Decisions only the Owner can make — defaults a lane proceeds on

| # | decision | default |
|---|---|---|
| **D1** | The eBay axis SET moves to the coordinate (M3), making per-market and per-alias sets possible | **Yes.** Byte-identical today; a characterisation test proves it |
| **D2** | Axes and values become `CustomAttribute` / `AttributeOption` codes (M1) | **Yes.** The store exists; the backfill is a dry-run report first |
| **D3** | Default collision resolver in a rule | **`fold`** until aliases are creatable, then **`split`**; the rule editor shows both with the reason |
| **D4** | Rules keyed by channel category, channel-wide rule as fallback | **Yes** |
| **D5** | Values pushed verbatim; maps per channel × market only; no per-product translation | **Yes** (the Owner, 09-12) |
| **D6** | Register Shopify option and value translations per locale | **No** in this programme; the platform supports it, add when a store has an alternate locale |
| **D7** | The listing listbox in the scope bar | **Yes** |
| **D8** | Theme-change live executor | **Not in this programme.** Dry-run plans only; the Owner runs the first live one under its own approval |
| **D9** | A sixth projection word `collides` | **Yes** — its next click differs from `needs-value` |
| **D10** | Fold separator and default fold target | `" / "`, the last mapped axis |

## Appendix A — sources for §7 (checked 2026-09-12)

- Amazon variation-theme removal procedure (delete parent, clear parentage on children, new parent, relink):
  Seller Central forum notice "Removal of irrelevant variation themes will start September 2" and the 2025
  coverage of it; error 8541 on parent/child theme mismatch (StoreAutomator, My Amazon Guy).
- eBay in-place rename impossible: `apps/api/src/services/ebay-axes-convert.service.ts` header (proven live
  2026-07-25, code 21916664); relist rule: Variants spec §4.4.4.
- Shopify `productOptionsCreate` / `productOptionUpdate` / `productOptionsDelete` (Admin API 2026-07, variant
  strategies, sequential positions, every option used); `ProductOption.translations` /
  `ProductOptionValue.translations` on the `Translation` object.
- Limits: `docs/vp2-contracts.md` §1 (eBay pinned by test; Shopify/Etsy from the spec table, unmeasured here).

## Appendix B — files VX must not edit (LX's, VP.F's, untouchable)

LX: everything its build prompt lists (`ProductTranslation`, `ChannelListingTranslation`, `Marketplace.languages`,
`resolveContent`, `resolveWriteRouting`'s language axis, `ReadinessIndex`, the Languages view). VP.F: every
`_studio/variants/**` path, the frame and the DS until it reports done. Untouchable: the flat-file editors
(`products/amazon-flat-file`, `products/ebay-flat-file`, `bulk-operations`, `services/amazon/flat-file*`,
`flat-file/registry/*`), FBA quantity, the existing import.

## Appendix C — copy table (verbatim; one source for every lane)

Band: `MAPPING` · `Follows rule <label>` · `Overridden here` · `<n> collision` / `<n> collisions` · `Preview` ·
`Edit mapping`. Dock: `Override` · `Reset to rule` · `dropped on this channel` · `Values` · `Shared` · `On
<Channel> · <Market>` · `Included` · `Collisions` · `No collisions on this listing.` · `Split per dropped axis` ·
`Fold into <axis>` · `Exclude the duplicates` · `Listing split` · `Save mapping`. Preview: `Preview` · `Mapping` ·
`Buyer view` · `Payload` · `Parent` · `Child` · `Copy` · `Changes since last publish` · `Added` · `Removed` ·
`Renamed`. Menu: `Change variation theme…` · `Relist with new specifics…` · `Change options…` · `Copy plan`.
Scope bar: `Listing` · `Primary` · `+ New listing`. Projection word: `Collides`. Mapping page: `Variations` ·
`Theme` · `Axes on channel` · `Collisions` · `Listing split` · `Value maps` · `Axis names` · `Preview SKU` ·
`<n> follow · <m> override`. Catalogue: `Variation mapping` · `Follows rule` · `Overridden` · `Collisions` ·
`Missing` · `Theme unset` · `Apply mapping rule…`.
