# VP.2 — FINAL data contracts for the Variants page (2026-09-11)

**Lane:** VP.2 (backend) of the Variants page build. **Spec:** `docs/2026-09-11-variants-page-spec.md` §4.5, §5, §8.
**Status of this document:** these are the FINAL shapes. §5 of the spec proposed them; this file settles them.
VP.3 and VP.4 code against THIS file. **Nothing here is committed.**

Every field below is either (a) already stored and named with its store, or (b) derived, with the derivation
stated. No number is hardcoded in the UI: `limits`, `targetOptions` and `vocabulary` all arrive from the server.

---

## §0 What was MEASURED before these shapes were fixed

All readings taken 2026-09-11 on the family the spec names, GALE-JACKET `cmokmy3a40078pm0p1fvnu523`.

| # | measurement | value |
|---|---|---|
| M1 | `Product.variationAxes` | `["Colore","Taglia"]` |
| M2 | `Product.variationTheme` | `"Colore,Taglia"` |
| M3 | child axis values live at | `Product.categoryAttributes.variations` = `{"Size":"3XL","Color":"Nero"}` **and** `Product.variantAttributes` |
| M4 | parent `ChannelListing(EBAY,IT).variationTheme` | `"Color,Size"` — a DIFFERENT string from M2 |
| M5 | `ChannelListing.variationMapping`, whole table | **ZERO of 999 rows carry a mapping OBJECT.** Exactly: 998 SQL `NULL`, 1 JSONB `null` (AIREON · AMAZON/DE, untouched since 2026-09-01). 21 rows carry a `variationTheme`. ⚠ the first pass said "NULL on all 999" from a Prisma `equals: null` predicate, which does not separate SQL NULL from JSON null; `jsonb_typeof` does. Same conclusion, exact numbers |
| M6 | parent `ChannelListing(EBAY,IT).platformAttributes` | 31 keys, incl. `_variationAxes: ["Colore","Taglia"]`, `_axisValueOrder`, `__lastPublishedAxes: {"EBAY_IT":["Colore","Taglia"]}` |
| M7 | `listingStatus` distinct values, whole table | `ACTIVE` 457 · `DISCOVERABLE` 386 · `DRAFT` 98 · `BUYABLE` 58 (none of the schema comment's INACTIVE/ENDED/ERROR) |
| M8 | `isPublished` × `listingStatus` | `true/DRAFT` 76 **and** `false/DRAFT` 22 — `isPublished` does not mean "draft" |
| M9 | references to `listingStatus` / `isPublished` in `apps/api/src` | 344 / 139 (excluding tests) |
| M10 | legacy pre-alias unique indexes on `ChannelListing` | **STILL PRESENT** (`…_conn_key` ×2) → `legacyAliasIndexesPresent()` true → alias creation blocked |
| M11 | `ProductListingAlias` rows | 0 |
| M12 | eBay·IT sheet columns with `variantEligible: true` | 3 — `color` (`aspect_Color`, specific `Colore`), `size` (`aspect_Size`, specific `Taglia`), `scollatura` |
| M13 | Amazon·IT `variation_theme` column | `kind: select`, 50 enum options with localised `optionLabels`, `writeField: amazon_variationTheme` |
| M14 | Amazon·IT `/studio/columns` read | 160 columns, **3.77 s** (the known-slow read — the baseline not to regress) |
| M15 | eBay·IT `/studio/columns` read | 51 columns, **0.15 s** |

### M16 — 🔴 the finding that routes the mapping write per channel

`ChannelListing.variationMapping` has four readers. Their expectations **disagree**, and the eBay publish path
does not read the column at all:

| reader | expects | what it does with M5's `null` |
|---|---|---|
| `amazon-mapper.service.ts:112,176-186` | **nested by theme**: `{ "SIZE/COLOR": { masterAttribute, platformAttribute, values } }` | `variationMapping[theme]` undefined → logs `No mapping found for variation theme` → child gets `{}` axis attributes |
| `listing-wizard/submission.service.ts:249-262` | **flat strings**: `{ "Colore": "color_name" }`; non-string values are dropped | empty map → adapter falls back |
| `listing-wizard/amazon-publish.adapter.ts:427` | **flat strings**, same as above | falls back to `` `${axis.toLowerCase()}_name` `` |
| `listing-snapshot.service.ts:76` | shape-agnostic — copies the column verbatim into a snapshot | copies `null` |
| `flat-file/registry/channel-fields.ts:16` | a COMMENT only ("flatten or exclude"). No read. | — |

**The eBay variation push reads none of it.** `ebay-variation-push.service.ts:864-911` builds its authoritative
axis set from `parseThemeAxes(Product.variationTheme)` (M2), falling back to the parent listing's
`platformAttributes._variationAxes` (M6); the eBay specific NAME per axis comes from
`platformAttributes._axisNameLabels`; value order from `_axisValueOrder`. `variationMapping` is never consulted.

**Consequence, and the rule this file adopts:** a mapping written to `variationMapping` for eBay would be a
mapping the channel never receives — a surface that displays something the server cannot round-trip
(`feedback_100_percent_honest_ui`). So the projection mapping is **routed to the store each channel's own
publish path actually reads**, per §5's instruction to keep the readers resolving:

| channel | axis SET + order | axis → channel target | scope of the write |
|---|---|---|---|
| **EBAY** | `Product.variationTheme` (comma-joined, `parseThemeAxes`) + parent `ChannelListing.platformAttributes._variationAxes` on the coordinate | `platformAttributes._axisNameLabels[axisKey]` → the eBay specific name | the SET is product-level (every eBay market); the NAMES are per coordinate |
| **AMAZON** | parent `ChannelListing.variationTheme` on the coordinate (M13's enum) | `ChannelListing.variationMapping` — **flat** `{ axisKey: spApiAttribute }`, the shape `amazon-publish.adapter.ts:427` reads | per coordinate |
| **SHOPIFY / ETSY** | parent `ChannelListing.variationTheme` on the coordinate | `ChannelListing.variationMapping`, flat | per coordinate |

The flat shape is chosen for `variationMapping` because it is what the only two live *readers of values* expect.
`amazon-mapper.service.ts` keeps reading `null` exactly as it does today on all 999 rows — its behaviour is
**unchanged by construction**, and a flat mapping does not satisfy its `variationMapping[theme]` lookup any more
than `null` does. That is the pre-existing state, not a regression this lane introduces; it is recorded here and
in the ledger so nobody later reads it as one. No file listed in the table above is edited by VP.2.

---

## §1 Vocabulary, limits and target options (spec §4.5)

Served inside the projection read (§4) — never hardcoded client-side.

```ts
interface ProjectionVocabulary {
  /** Singular, lower case: 'specific' | 'theme' | 'option' | 'property'. */
  axisNoun: string
  /** The plural the copy needs. Sent explicitly: 'property' does not pluralise with +s. */
  axisNounPlural: string
  /** The dock's section-1 title for this channel (spec §9): 'Variation specifics' | 'Variation theme' | 'Options' | 'Properties'. */
  sectionTitle: string
}

interface ProjectionLimits {
  /** Max axes per listing. null = this channel states no limit we can source. */
  axes: number | null
  /** Max variants per listing. null = no limit we can source — the UI then omits the "of N allowed" half. */
  variants: number | null
  /** Where each number came from, for the operator and for review. */
  source: { axes: string | null; variants: string | null }
}
```

| channel | `axisNoun` / plural | `sectionTitle` | `limits.axes` | `limits.variants` | source |
|---|---|---|---|---|---|
| EBAY | `specific` / `specifics` | `Variation specifics` | 5 | 250 | `ebay-theme-axes.ts:27` (the parser truncates at 5) · `ebay-variation-preflight.ts:54` `MAX_VARIANTS` |
| AMAZON | `theme` / `themes` | `Variation theme` | derived: the largest segment count in the product type's `variation_theme` enum (M13) | `null` | the PT schema's own enum · no sourced variant cap |
| SHOPIFY | `option` / `options` | `Options` | 3 | 100 | **spec §4.5** — not measured in this repo; no Shopify limit constant exists here |
| ETSY | `property` / `properties` | `Properties` | 2 | 70 | **spec §4.5** — not measured in this repo; no Etsy limit constant exists here |

🔴 **The two eBay numbers are PINNED, not copied.** `apps/api/src/services/pim/family-projection-limits.vitest.test.ts`
asserts that `parseThemeAxes` actually truncates at `limits.axes` and that `ebay-variation-preflight`'s
`MAX_VARIANTS` equals `limits.variants`. If either source moves, the test fails rather than the page quietly
stating a stale number (`reference_a_list_of_members_is_a_set_claim`).


🔴 **Shopify's and Etsy's four numbers come from the spec table, not from a measurement.** Nothing in this
repository states them, so there is nothing to pin them to and no test can hold them honest. They are served
with `source` saying so, and the first operator report that contradicts one is evidence, not noise. eBay's and
Amazon's are derived from code or schema and are pinned.

```ts
interface TargetOption {
  /** The value stored in the mapping — the eBay specific name, the SP-API attribute, the Shopify option name. */
  code: string
  /** What the operator reads in the Listbox — the channel's own localised label. */
  label: string
  /** The sheet column this option came from, when it came from one. null for a derived option. */
  columnKey: string | null
  /** True when a shared axis is already mapped onto it. */
  taken: boolean
}
```

**Derivation, per channel, all server-side:**
- **EBAY** — the coordinate's sheet columns with `variantEligible === true` (M12). `code` = the eBay specific
  name, i.e. the leaf of `channels[<label>].store.path` (`itemSpecifics` → **`Colore`**); `label` =
  `channels[<label>].label`. Measured on eBay·IT: `Colore`, `Taglia`, `Scollatura`.
- **AMAZON** — the distinct segments of the product type's `variation_theme` enum (M13), each lowercased to its
  SP-API attribute: `SIZE_NAME` → `size_name`, `COLOR_NAME` → `color_name`, … `label` = the enum's
  `optionLabels` entry when it has one, else the segment. The chosen THEME travels separately (§4.1 `theme`).
- **SHOPIFY** — free names: `targetOptions` is `[]` and `freeform: true` (see §4.1). The Listbox becomes an Input.
- **ETSY** — the coordinate's `variantEligible` columns, same derivation as eBay.

---

## §2 `GET /api/products/:id/studio/family?market=IT`

RBAC: inherited from the `/api/products` prefix → `products:view`. `:id` may be the parent OR any child; the
family root is resolved either way, exactly as `/studio/sheet` does.

```ts
interface FamilyRead {
  /** The PARENT product's `Product.version`. Send it back on generate. */
  version: number
  family: { parentId: string; parentSku: string; role: 'parent' | 'standalone' }
  /** In stored order (`Product.variationAxes`). */
  axes: Array<{
    /** The declared axis key, e.g. 'Colore'. The key the family speaks. */
    key: string
    /** Display label. Falls back to `key`. */
    label: string
    /** The key values are actually STORED under, e.g. 'Color'. May differ from `key` — see M1/M3. */
    storedKey: string
    /** 'stored' = values exist under `storedKey`; 'declared' = the family lists the axis and nothing is stored. */
    source: 'stored' | 'declared'
    values: Array<{ code: string; label: string; count: number }>
  }>
  children: Array<{
    id: string
    sku: string
    name: string | null
    image: string | null
    imageInherited: boolean
    status: string
    version: number
    /** Keyed by the axis's `key` (not `storedKey`) — one vocabulary for the client. */
    axisValues: Record<string, string>
    readiness: RowReadiness | null                    // { state, requiredPct, note } — see §6a
    completeness: RowCompleteness | null              // { pct, filled, total } — optional attributes INCLUDED
    /** Keyed 'CHANNEL:MARKET', e.g. 'EBAY:IT'. One entry per member of `channels`. */
    projections: Record<string, ProjectionCellState>
  }>
  parent: {
    id: string; sku: string; name: string | null; image: string | null
    readiness: RowReadiness | null
    completeness: RowCompleteness | null
    /** Same keys as a child's. `listings` is how many listing rows the parent holds there (alias count + 1). */
    projections: Record<string, ProjectionCellState & { listings: number }>
  }
  coverage: {
    /** 🔴 NULLABLE — null means NOT COUNTED, never zero. See §6a. */
    /** Cartesian product of the DISTINCT values present per axis. */
    combinations: number | null
    /** Tuples that exist on a child. */
    existing: number | null
    /** Every missing tuple, as value codes in axis order. */
    missing: string[][] | null
    /** Which case this is: 'ok' | 'no-axes' | 'no-values'. */
    state: 'ok' | 'no-axes' | 'no-values'
    /** Tuples carried by more than one child: the SKUs that share each tuple. */
    duplicates: string[][]
    /** Children with at least one axis with no value. Feeds the "Missing axis values" chip. */
    childrenMissingAxisValues: string[]
  }
  channels: Array<{
    channel: string; market: string; label: string
    /** A connected account exists for this coordinate. */
    connected: boolean
    /** The resolved account, when there is exactly one. */
    accountId: string | null
    /** Set when `connected` is false, or when more than one account matches. */
    note: string | null
  }>
  meta: { tookMs: number; phases: Record<string, number> }
}
```

### §2.1 `ProjectionCellState` — the projection vocabulary

```ts
type ProjectionState = 'listed' | 'draft' | 'excluded' | 'not_set_up' | 'needs_value'

interface ProjectionCellState {
  /** The checkbox. False for every state except 'listed' | 'draft' | 'needs_value'. */
  included: boolean
  state: ProjectionState
  /** The mono detail the cell renders on the right. ASIN / ItemID / Shopify id. null when there is none. */
  externalId: string | null
  /** Row readiness for this coordinate. Never mapped onto `state` by the client. `null` = not computed. */
  readiness: RowReadiness | null
  /** Optional-inclusive completeness — a DIFFERENT measurement from readiness. See §6a. */
  completeness: RowCompleteness | null
  /** One sentence for the tooltip: why this state. Server-stated, never composed client-side. */
  reason: string
}
```

🔴 **This is a THIRD vocabulary and it is deliberate**, exactly as `readinessMeta`'s two are
(`design-system/grid/renderers/readiness.ts`). `listed`/`draft`/`excluded`/`not_set_up`/`needs_value` are the
five words spec §3.3 puts in the cell, and none of them is a row-readiness state: `excluded` and `not_set_up`
have no readiness counterpart, and `live` has no exclusion counterpart. Both are therefore sent, side by side,
and **no lane writes a converter between them**.

→ **Request to VP.5** (spec §1.6 owns the three DS pieces): export `projectionMeta(state)` beside
`readinessMeta`, returning `{ tone, label, dot }` for these five, so `ProjectionCell` has no local colour map —
which spec §3.3 forbids. Words verbatim from spec §9: `Listed` · `Draft` · `Excluded` · `Not set up` ·
`Needs a value`.

**How each state is decided (server-side, one derivation):**

| state | condition |
|---|---|
| `not_set_up` | the coordinate has no connected account (`channels[].connected === false`) |
| `excluded` | connected, and EITHER no `ChannelListing` row for this child on the coordinate, OR a row with `variationExcluded = true` |
| `needs_value` | included, and the child has no value for at least one MAPPED axis (it cannot be a variation without one) |
| `listed` | included, the row has a non-empty `externalListingId` |
| `draft` | included, no `externalListingId` |

---

## §3 Axes — unchanged

`GET|PATCH /api/products/:id/studio/variation-axes` (`family-variation-axes.ts`) stays exactly as it is. Its
`PATCH` is already version-checked on `Product.version` and already refuses an axis the dictionary no longer
offers. The family band's "Manage shared axes" modal writes through it. VP.2 adds nothing here.

---

## §4 `GET | PATCH /api/products/:id/studio/projection`

Query: `?channel=EBAY&market=IT&accountId=<optional>&aliasKey=<optional, '' = primary>`.
Account resolution is the studio's existing one (`resolveWorkspaceDestination`), so an ambiguous account is a
409 that names the accounts rather than a silent pick.

### §4.0 Amendments folded in from VP.4 (2026-09-11), all implemented and probed

VP.4 asked for five fields §4's surface cannot render without, and found one routing boundary. All six are in.

| ask | field | where it comes from |
|---|---|---|
| A1 | `mapping[].axisLabel` | the family's display label — a key is not a label |
| A2 | `children[].name · image · imageInherited · sharedAxisValues · readiness` | the channel sheet's row, so the identity band matches the sheet's |
| A3 | `coordinate.channelLabel · accountLabel` | the coordinate's label and `ChannelConnection.displayName` (measured: `xaviaracing`) |
| A4 | `axes[{ key, label, values[{ code, label, count }] }]` | every axis the family HAS, not only the mapped ones; `count` is INCLUDED variants only |
| A5 | `children[].values[axisKey].write` + `writeBlockedReason` | relayed from the CELL's own routing, never composed by the client |

**A6 and A7, added 2026-09-11 after VP.4 caught a live-data bug.**

- **A7 `children[].values[axisKey].inheritedValue`** — what the cascade lands on if that cell is RESET. This is
  the serious one. VP.4 built a reset against `sharedAxisValues` and caught it on live data: this read reports
  `sharedAxisValues.Colore = "Nero"` on all 20 children while the MASTER sheet, at the same minute, reports
  `color: null` on the same children. **`sharedAxisValues` is the family's axis TUPLE — what tells one variant
  from its siblings — and nothing inherits it.** A reset labelled "restore Nero" would have emptied a `Colore`
  specific on live item 257584954808.
  Measured answer, now served: `inheritedValue: null` on every normal row — **a reset EMPTIES the cell**, which
  is precisely why the control must not offer it as a restore. Derived from the master sheet's cell for the
  same column, because clearing a channel override uncovers the master-derived base
  (`studio-sheet.service.ts:1202-1213` writes the `channelExplicit` layer OVER it).
  🔴 **The field is ABSENT, not null, when it could not be computed**, with
  `inheritedValueUnknownReason` saying why — "we did not answer" and "we answered: nothing" must not share a
  value. Measured on eBay·DE: *"This coordinate has no column for Colore, so a reset has no target here."*
  A cell whose value is `mapped` is deliberately left unanswered: a mapping rule sits between master and the
  channel, so the master value is not where a reset lands, and offering it would be a confident wrong answer.
- **A6 `parent`** — `{ id, sku, name, image, externalId, listings, state, reason }`. The external id is the
  **parent listing's own**, never inferred from what the children carry. Measured: eBay·IT `257584954808`,
  Amazon·IT `B0F7J163XJ`, `listings: 1`, `state: 'listed'`.

**Two more, from the same review.**

- **Every count names its UNIT.** `counts` is now `{ rows, includedChildren, pinnedCells, pinnedRows,
  mappingErrorRows }`. VP.4 spotted that `pinned: 40` on a 20-child family counts CELLS, so a chip printing 40
  and narrowing the grid to 20 rows would be the count-and-result disagreement the chip rules forbid. Both
  units are served; the chip prints `pinnedRows`.
- **Suspect shared values are named rather than asserted.** `children[].axisValuesSuspect[]` and
  `axes[].values[].suspectRows` / `axes[].hasSuspectRows`. The signal is measurable, not a heuristic: the row's
  `categoryAttributes.variations` bag is non-empty in the database but cleans to EMPTY, i.e. a writer
  overwrote it with the corrupt `variantAttributes: "[object Object]"` key. Measured on GALE-JACKET: the two
  `…-XXS` SKUs, whose only surviving value says `Size: XS`. Served counts now read `XS count 4 (2 suspect)`,
  `Nero 10 (1 suspect)`, `Giallo 10 (1 suspect)`. The value is still reported — deriving `XXS` from the SKU
  would be a guess, and an axis value must be rendered as stored or as absent, never inferred from a name.
  What is added is the SAYING of it.

**🔴 `parent.listing` is NESTED, exactly like `children[].listing`.** It was flat for about two minutes on
2026-09-11 and put VP.4's page into an error boundary reading `state` off `undefined`. The spec §5.4 proposal
nested it; so does this. One vocabulary, one shape — `{ state, externalId, listingId, reason }` in both places,
with `parent.listings` (a count) beside it. If you built against the flat shape in that window, this is the one
line to change.

**`axes[].valueOrder` (family read) — where a MEANINGFUL value order comes from.**
VP.3 established that nothing derivable gives one: these axes carry no schema option list, so first appearance
over a SKU-ascending read is all a client can do, and that yields `3XL, 4XL, 5XL, L, M, S, XL, XS, XXL` for a
size axis. There IS a stored answer and it is the only one on this catalogue — the parent listing's
`platformAttributes._axisValueOrder`, arranged by an operator in the eBay presentation-order editor.
Measured on GALE-JACKET: `Taglia` now reads **XS, S, M, L, XL, XXL, 3XL, 4XL, 5XL**, sourced `EBAY:IT`.

```ts
valueOrder: { source: 'stored' | 'sku-alphabetical', from: string | null, codes: string[] }
```

Two properties on purpose. The order comes from the stored list; the **membership never does**, so a value no
child carries cannot inflate a count and `coverage` is unchanged (still 18 combinations / 18 existing / 0
missing / 2 duplicates). And `codes` is the stored list VERBATIM, so it may name values no child carries — on
this family it contains **`XXS`**, which is information rather than noise: it is the size the two clobbered
children have lost. The `__dimN__` keys are array-position-derived from `AXIS_SYNONYM_GROUPS` (append-only for
that reason); `axisSynonymKey` is imported as the one joiner rather than re-derived. When more than one
coordinate stores an order, coordinates are visited in a stable sorted order and the first with an entry wins,
with `from` naming it, so two reads cannot disagree.

**`children[].values[axisKey].sharedWrite` — the honest alternative when a cell is held.**
Added 2026-09-11 after VP.4 reported that my held sentence was FALSE on three markets and being rendered with
this contract's authority. A held control with a wrong reason is worse than a held control, because the reason
is the part an operator acts on, and the old one sent them to create a column that already exists.
Measured: eBay·IT serves **51** columns including `color`/`size` with a writable cell; eBay·DE/FR/ES serve
**31** and neither axis column, because those markets have no listing set up for this family (DE is DRAFT with
no ItemID; FR and ES have no listing row at all). The shared record has the columns on every coordinate.
So when `write` is null and the shared record can take the edit, the cell carries the route with its blast
radius attached:

```ts
sharedWrite?: { field: string; target: 'master'; verb: 'master'; version: number; affectsAllMarkets: true }
```

Its PRESENCE is the signal that a shared edit is available — absent on eBay·IT, where the per-market write
exists. `writeBlockedReason` now reads, verbatim on the wire: *"eBay · DE offers no specifics for this family
yet, so there is no per-market Colore to pin here. This market uses the shared Colore, and changing that
changes every market."*

**A5 in detail.** `write` is `{ field, target, verb, version }` or `null`. It is read off the channel sheet's
cell (`writable`, `writeField`, `writeTarget`, `writeVerb`), which is the same routing `commitChannelRow`
resolves — so the pin action cannot drift from the write that executes it. `version` is the LISTING's version
for a `channelListing` target and the PRODUCT's for a `master` one. `null` plus a `writeBlockedReason` is a
complete answer: the control renders held with the reason rather than guessing a route. Measured on eBay·IT:
`{ field: 'attr_color', target: 'channelListing', verb: 'channel', version: 35 }`.

**The routing boundary — VP.4's finding, verified here.** `ebay-cockpit.routes.ts:596` answers 409 for
`pickedAxes`, `axisSortOrder` and `axisValueOrder`, naming `/api/ebay/cockpit/presentation-order` as the one
editor for them. Verified, and the boundary is narrower than the ask: that guard does **not** cover
`axisNameLabels` or `axisValueLabels`, which stay writable. So the split this contract adopts is:

| what | store | writer |
|---|---|---|
| eBay axis SET | `Product.variationTheme` | **this PATCH** |
| eBay axis NAME (the specific) | `platformAttributes._axisNameLabels` | **this PATCH** |
| eBay axis ORDER + value order | `_variationAxes`, `_axisSortOrder`, `_axisValueOrder` | the presentation-order editor, NOT this PATCH |

The GET relays the order read-only in `order: { axes, valueOrder, editorUrl, writableHere: false, reason }` so
the dock paints in one round trip and sends its drag half to `editorUrl`. And a mapping save PRESERVES the
existing order for every axis it keeps, so it can never reorder a live listing's specifics behind that
editor's back. **The Owner decides whether the dock's drag control routes there; the payload supports it
either way.**

### §4.1 GET

```ts
interface ProjectionRead {
  /** The PARENT ChannelListing's `version` on this coordinate. Send it back as `expectedVersion`. */
  version: number
  coordinate: { channel: string; market: string; accountId: string | null; aliasKey: string; label: string }
  vocabulary: ProjectionVocabulary
  limits: ProjectionLimits
  /** In projection order. `target` is null for an axis that has not been mapped yet. */
  mapping: Array<{ axisKey: string; axisLabel: string; target: string | null; order: number }>
  /** Every axis the family HAS (A4), with INCLUDED-variant counts and the suspect counts above. */
  axes: Array<{ key: string; label: string; hasSuspectRows: boolean
                values: Array<{ code: string; label: string; count: number; suspectRows: number }> }>
  /** The presentation ORDER, relayed read-only. See §4.0 — this PATCH does not write it. */
  order: { axes: string[]; valueOrder: Record<string, string[]>; editorUrl: string; writableHere: false; reason: string }
  parent: { id: string; sku: string; name: string | null; image: string | null
            externalId: string | null; listings: number; state: ProjectionState; reason: string }
  /** What `target` may be set to. Empty + `freeform: true` for a channel that takes free names (Shopify). */
  targetOptions: TargetOption[]
  freeform: boolean
  /** AMAZON only — the theme enum (M13). null on every other channel. */
  theme: { value: string | null; options: Array<{ code: string; label: string }> } | null
  split: {
    mode: 'single' | 'per-axis'
    axisKey?: string
    listings: Array<{ aliasKey: string; label: string; count: number }>
    /** MEASURED per request, never assumed — see §4.4. */
    creatable: boolean
    heldReason?: string
  }
  /** Non-null when this coordinate has already published: adding/removing an axis would relist. */
  locked: null | { reason: string; lockedAxisKeys: string[] }
  children: Array<{
    id: string
    sku: string
    included: boolean
    /** Keyed by axis key. `source` is the cascade's own answer, not a local guess. */
    name: string | null; image: string | null; imageInherited: boolean
    readiness: RowReadiness | null
    completeness: RowCompleteness | null
    sharedAxisValues: Record<string, string>          // the axis TUPLE — never an inheritable value
    axisValuesSuspect: Array<{ axisKey: string; reason: string }>
    values: Record<string, {
      value: string | null
      source: 'inherited' | 'pinned'
      write: AxisWriteRouting | null
      writeBlockedReason: string | null
      inheritedValue?: string | null                  // ABSENT = not computed; null = a reset empties the cell
      inheritedValueUnknownReason?: string
    }>
    listing: { state: ProjectionState; externalId: string | null; listingId: string | null; reason: string }
  }>
  counts: { rows: number; includedChildren: number; pinnedCells: number; pinnedRows: number; mappingErrorRows: number }
  meta: { tookMs: number; phases: Record<string, number> }
}
```

**`locked`** is read from the parent listing's `platformAttributes.__lastPublishedAxes[<marketplaceId>]` (M6) —
the axis names eBay actually published for this market. When present and non-empty:
`lockedAxisKeys` = those axes, `reason` = spec §4.4.4's sentence with the real item id substituted. When the key
is absent the coordinate has never published and `locked` is `null`; it is never fabricated from the declared
axes, which would make every coordinate look locked (the same trap `priorPublishedAxisNames` documents at
`ebay-variation-preflight.ts:39-46`).

### §4.2 `PATCH …/studio/projection`

```ts
// body
{ expectedVersion: number, mapping?: Array<{ axisKey: string; target: string; order: number }>, split?: { mode: 'single' | 'per-axis'; axisKey?: string } }
// → 200 { version, mapping, locked }        409 { error: 'version_conflict', current: <ProjectionRead> }
```

- CAS on the parent `ChannelListing.version` for this coordinate. A 409 carries the whole current read, so the
  dock repaints from the response and needs no second request (the sheet's rule).
- `mapping` is the WHOLE list, not a patch: an axis absent from it is unmapped. Partial patches cannot express
  a removal, and removal is the operation the lock banner exists to warn about.
- Refused with 400, by name, never silently truncated: more axes than `limits.axes`; a `target` not in
  `targetOptions` when `freeform` is false; two axes on one `target`; an `axisKey` not in `Product.variationAxes`.
- Refused with 409 when `locked` is non-null and the SET of axes changes (order and value changes are allowed —
  spec §4.4.4's exact rule). The response names the axes and the live item.
- eBay writes: `Product.variationTheme` (the set, comma-joined in order) **and** the coordinate's
  `platformAttributes._variationAxes` + `_axisNameLabels`. 🔴 The response states
  `affectsAllMarkets: true` for the eBay SET, because `Product.variationTheme` is product-level: the dock must
  say so before saving. Amazon/Shopify/Etsy write the coordinate's `variationTheme` + `variationMapping` only.
- `split` is accepted only when `split.creatable` is true (§4.4). Otherwise 409 `alias_creation_blocked` with
  the held reason — the same code the existing alias route already returns.

### §4.3 `PATCH …/studio/projection/children` — include / exclude

```ts
// body
{ expectedVersion: number, changes: Array<{ id: string; included: boolean }> }
// → 200 { version, results: Array<{ id: string; included: boolean; state: ProjectionState; listingId: string | null }> }
//   409 { error: 'version_conflict', current: <ProjectionRead> }
```

🔴 **This is a LOCAL-RECORD write and nothing else.** It is implemented on a new additive column,
`ChannelListing.variationExcluded Boolean @default(false)`:

- **exclude** → `variationExcluded = true` **and** `isPublished = false`. Both directions are strictly
  push-REDUCING: every existing consumer of `isPublished` treats `false` as "do not send".
- **include** → `variationExcluded = false` **only**. `isPublished` is NOT raised, so including can never
  enable a push that was not already enabled. Publishing stays an explicit, separate operator action.
- **include on a child with no row** → creates the row `listingStatus: 'DRAFT'`, `isPublished: false`,
  **`syncPaused: true`**, `variationExcluded: false`, `aliasKey: ''`/the alias, no overrides, no
  `externalListingId`.
  🔴 **`syncPaused` is on the BIRTH state for a measured reason.** `cascadeQuantityToListings`
  (`stock-movement.service.ts:694`) selects `where: { productId }` with **no** status, `isPublished` or
  `externalListingId` filter, so a bare new row would be swept into a `QUANTITY_UPDATE` on the next stock
  movement — and Amazon's dispatch PATCHes by SKU, not by `externalListingId`, so a null external id does not
  stop it. `syncPaused: true` makes the row inert at BOTH layers: at enqueue (`resolveIntendedQuantity` →
  `kind: 'PAUSED'` → `newListingQty = null` → no write and no queue row, `stock-movement.service.ts:779-794`)
  and at dispatch (`outbound-sync.service.ts:897` and `:1147` re-check at send time and SKIP).
  **It does not gate an explicit operator publish**: `syncPaused` has zero references in
  `ebay-variation-push.service.ts`, `routes/ebay-flat-file.routes.ts` and `amazon/flat-file.service.ts`.
  Only rows this endpoint CREATES get it — an existing row's `syncPaused` is never touched, because that is
  an operator-set Sync Control state and overwriting it would be a silent change.
- Never deletes a row, so an `externalListingId` is never lost by excluding.
- **The pair is deliberately ASYMMETRIC.** Exclude lowers `isPublished`; include does not raise it. A tick
  cannot restore publishing — that stays the explicit Publish action. The cell's `reason` sentence says so
  whenever a row is included with `isPublished: false`, so the UI never implies otherwise.

**Why a new column rather than an existing field** (M7–M9): `listingStatus` carries four live values and has
344 references; `isPublished` has 139 and already means two different things on the same fixture
(`true/DRAFT` 76 vs `false/DRAFT` 22). Overloading either would collapse `Draft` and `Excluded`, which spec §3.3
requires to be two distinct cell states. The new column has **zero** pre-existing consumers by construction,
which is what makes the no-push-path proof checkable rather than argued. The migration is additive with a
default, so every existing row reads `included` exactly as it does today — no backfill.

### §4.4 `split.creatable` is MEASURED on every read

`listing-alias.service.ts` blocks alias creation while the pre-alias unique indexes stand. VP.2 calls the
service's own `legacyAliasIndexesPresent()` per read rather than assuming a state.

**Measured 2026-09-11: the legacy indexes ARE present** (M10) — `ChannelListing_productId_channelMarket_conn_key`
and `ChannelListing_productId_channel_marketplace_conn_key` — and `ProductListingAlias` holds 0 rows (M11).
So today: `creatable: false`, `heldReason: "A second listing needs a database change that has not shipped yet
(PES.5-ii). The option is shown so it is not forgotten; it cannot be saved."` The dock renders the radio with
`aria-disabled` and that sentence in the tooltip — never a silent disable (spec §4.4.3).
**When PES.5-ii ships, this flips with no code change on either side.**

---

## §5 `POST /api/products/:id/studio/family/generate`

```ts
// body
{
  version: number                       // the PARENT's Product.version (§2's `version`)
  axisValues: Record<string, string[]>  // axis key → the value codes to include, IN ORDER
  skuPattern: string                    // tokens: {parent} {<axis>} {<axis>.code}
  copyFrom: 'nearest-sibling'
  dryRun: boolean
}

// dryRun: true →
{
  plan: Array<{ sku: string; axisValues: Record<string, string>; copiesFrom: { id: string; sku: string } | null }>
  skipped: Array<{ axisValues: Record<string, string>; reason: 'exists' | 'sku_collision'; sku?: string; existingSku?: string }>
  counts: { combinations: number; existing: number; willCreate: number }
  /** Every new axis VALUE this run would introduce, per axis — the modal's tinted tags. */
  newValues: Record<string, string[]>
}

// dryRun: false →
{ created: Array<{ id: string; sku: string }>, version: number }   // the parent's NEW version
// 409 { error: 'version_conflict', current: number }
// 409 { error: 'sku_collision', collisions: Array<{ sku: string; existingProductId: string }> }
```

**Rules, all server-side:**
- The plan is the Cartesian product of `axisValues` in axis order, **minus** every tuple an existing child
  already carries. Coverage's `existing` and the plan's `skipped(reason: 'exists')` are the same derivation.
- `skuPattern` tokens: `{parent}` = the parent SKU; `{<axisKey>}` = the value verbatim; `{<axisKey>.code}` = the
  value's short code (uppercased, non-alphanumerics → `-`, collapsed). An unknown token is a 400 that names it.
- **A SKU collision REFUSES by name and never renames** — the whole run, on `dryRun: false`, so a partially
  created family is impossible. On `dryRun: true` collisions come back in `skipped` so the operator can change
  the pattern before committing.
- Created children are **full `Product` rows**: `status: 'DRAFT'`, `parentId` = the family root, `isParent: false`,
  and `name` / `basePrice` / `totalStock` copied from the **nearest sibling** — the existing child sharing the
  most axis values with the new tuple, ties broken by axis order, then by SKU. `copiesFrom` names it in the plan,
  so the operator sees which row each new one came from before creating anything.
- Axis values are written the way the existing "Add a child" verb writes them
  (`product-relationship.service.ts:59-64`): **both** `Product.variantAttributes` and
  `categoryAttributes.variations`. One writer's shape, not a second one.
- **No `ChannelListing` rows are created.** A generated child is excluded from every channel until it is
  included (spec §3.4), which under §4.3 is exactly "no row on the coordinate".
- Version-checked on the parent's `Product.version`, inside the same serializable transaction the other family
  verbs use (`relationshipTransaction`), and the parent's version is incremented once for the whole run.

---

## §6 Errors — one shape for all four routes

The existing `sendError` mapper in `product-studio.routes.ts` is reused unchanged, so these routes fail the way
every other studio route already fails: `{ error: <code>, message: <sentence> }`, 404 unknown product, 400 a
malformed request that names the field, 409 for a well-formed request the WORLD refused (version conflict,
locked axes, alias creation blocked, SKU collision). A 409 for a version conflict always carries enough to
repaint without a second round trip.

---

## §7 What VP.3 / VP.4 can rely on

- Every count the bands and chips render is in the payload: `coverage.*` (§2) and `counts.*` (§4.1). No client
  derivation, so master and channel cannot disagree.
- Every word with a tone comes from a named vocabulary: `RowReadinessState` via `readinessMeta(state, 'row')`,
  `ProjectionState` via VP.5's `projectionMeta(state)`. No local maps.
- Every limit and option list is served. `limits.variants: null` on Amazon means **omit** the "of N allowed"
  half of the sentence — it does not mean zero.
- `axisValues` on a child is keyed by the axis `key` (`Colore`), never by `storedKey` (`Color`). The server
  owns that translation; the client never sees the two spellings (M1 vs M3).

---

## §5a `generate` dry run — the preview's every string is server-stated (2026-09-11)

Added after VP.3 found that their dialog would preview `GALE-JACKET-BLACK-MEN-XXS` while Create produced
`GALE-JACKET-NERO-MEN-XXS` on any family tidy enough for their sibling-derivation to succeed. Nothing shows on
GALE-JACKET because that derivation refuses this family — which is what makes it the dangerous shape: a
confident wrong preview waiting for the first consistent family.

The dry run now carries everything §3.4's modal renders, so the dialog computes no string of its own:

| modal element (spec §3.4) | field |
|---|---|
| the value tags, and which are new | `newValues` |
| `Codes: Nero → BLACK …` | **`codes`** — `{ [axisKey]: { [value]: code } }`, only for axes whose `.code` token is in the pattern |
| `first new SKU …` and every other SKU | `plan[].sku` |
| `**3 × 10 = 30** · 20 exist · **10 will be created**` | `counts` |
| which sibling each new row copies from | `plan[].copiesFrom` |
| a code that disagrees with the family's own SKUs | `skuConventionWarnings[]` |

Measured on the canvas pattern: `codes` = `{"Colore":{"Nero":"NERO","Giallo":"GIALLO","Rosso":"ROSSO"},
"Taglia":{"XXS":"XXS","M":"M"}}`; control — a pattern with no `.code` token returns `{}`.

🔴 **`dryRun: true` writes nothing**, so this is callable the moment the modal opens; the preview does not have
to wait for Create to be wired. Spec §3.4 already routes it this way ("dry-run first → the summary is the
dry-run's answer → create"). A client-side derivation on top is a SUGGESTION an operator accepts, never the
string the preview shows.

---

## §6a Not-counted is not zero — the nullable fields, and why (2026-09-11)

This codebase already rules it: `StudioSheet.counts.mapped` is `number | null` with *"null when the mapping
enrichment did not run — never 0 for that"*. Zero is a real answer; NOT COUNTED is a different fact; they must
not share a value. Four places in these contracts broke that rule and now follow it.

**`coverage` (§2).** `combinations`, `existing` and `missing` are `number | null` / `string[][] | null`, plus
`coverage.state`:

| state | meaning | measured on |
|---|---|---|
| `ok` | every axis has values; the counts mean something | GALE-JACKET — 18 / 18 / 0 missing / 2 duplicates |
| `no-values` | axes are DECLARED and nothing is stored under them, so the product cannot be computed | AIREON — 40 children, `2 × 0`, counts `null`, `childrenMissingAxisValues: 40` |
| `no-axes` | the family declares none | MISANO — counts `null`, `childrenMissingAxisValues: []` |

Before this, one payload could assert `missing: 0` beside `childrenMissingAxisValues: 40`, and a band rendering
it read *"0 of 0 combinations exist · 0 missing"* on a forty-child family, identical to a complete one.
`childrenMissingAxisValues` is now `[]` when there are no axes — there is nothing to miss.

**`readiness` split from `completeness`.** They were one object, `{ pct, state }`, and `pct` was the
OPTIONAL-inclusive completeness ratio while `state` was readiness. Measured on Amazon·IT: `{ pct: 14,
state: 'live' }` with **8 of 8 required attributes filled**. Now:

```ts
readiness:    { state: RowReadinessState; requiredPct: number | null; note: string | null } | null
completeness: { pct: number | null; filled: number; total: number } | null
```

Both `null` percentages under the substrate's own predicate — `meta.schemaMissing` non-empty **or**
`required.total === 0` — with the note relayed from `scope-readiness.service.ts`, never reworded here (PES.2's
sheet already renders operator words for this state at `MasterSheet.tsx:1783`).
🔴 The third condition in that predicate, `mappingUnavailable`, is deliberately NOT copied: it reads a sheet
built WITH mapping, and these reads pass `includeMapping: false`, so it is null by construction here and
copying it would null every channel row for a reason that is an artefact of this read's configuration.
Measured after: Amazon·PL `requiredPct: null`, `completeness.pct: null`, note *"Category metadata is
incomplete: OUTERWEAR"* — it previously served **`pct: 100`** off four surviving columns.

**`targetOptionsState`.** An empty `targetOptions` meant three different things. Now `'ok'` · `'freeform'`
(Shopify) · `'unavailable'`, with `schemaMissing[]` beside it. Measured: eBay·IT `ok` / 3 options; Etsy·GLOBAL
`unavailable` / `["ETSY:*"]`; Amazon·PL `unavailable` / `["OUTERWEAR"]`.

## §7a VP.F shared-sheet consistency — 2026-09-11

1. Family and projection reads accept `locale`; channel coordinates retain explicit account, market and alias. `getInformationSheet` is the common reader for Information, Variants and scope readiness, including native Shopify enrichment.
2. Projection `axisColumns[axisKey]` relays the exact Information column definition for the mapped target, including select options. A missing resolved cell remains null. Its `write` route comes from that cell.
3. `source: pinned` means the resolved channel value differs from the resolved shared value. `storedOverride` separately describes storage ownership for import undo; equal explicit values still render inherited.
4. Generate dry-run returns `previewToken`. Create sends that token with the same reviewed plan; changed inputs, sibling content or membership refuse the request. Generated children are DRAFT with no channel listings.
5. Mapping PATCH accepts `presentationOrder` with the existing order token and reviewed axis/value order. eBay mapping labels and order commit under one listing-version check and transaction. Publication remains separate.
6. Variants import uses `/studio/variants/import/{template,diff,jobs/:jobId}` with explicit account/market/alias column keys. Dry-run precedes apply; revert restores only applied cells and uses reset when the original value was inherited. Polling includes successful and refused outcomes.
7. `scripts/check-variants-sheet-parity.mjs` reads all attributed coordinates and compares row order, shared identity, completeness, axis metadata, resolved values and write routes against Information. The control census asserts the 43px selection column before P/C and independent inclusion.
