# VT.1 — FINAL contracts for the Variation theme column (2026-09-13)

**Lane:** VT.1 (backend), agent of `[3aec8721]`. **Design:** `docs/2026-09-13-variation-theme-column-design.md`
(§3.2 derivation, §3.3 column, §3.5 commit rules, §3.6 writes, §5 decisions D-VT1–D-VT9 on their defaults).
**Prompt:** `docs/vt-prompts.md` § "VT.1 — backend". **Composes with** `docs/2026-09-12-variation-projection-design.md`
(VX) and `docs/vp2-contracts.md` (the projection routes this reuses).

**Who this is for.** VT.2 codes the cell renderer, the `AxesPanelEditor` and the `SheetWriter` branch against this file
and the three fixtures in `docs/fixtures/vt1/fixtures.ts` until VT.1's routes answer. VT.3 and VT.4 read §5 and §6.
Every shape here is written FINAL-shaped on purpose; a later phase that has to change one edits this file and adds a
dated `CHANGES` block directly under this paragraph, so a consumer can see what moved.

**Nothing in this file is committed.** Every number in it was measured on the LOCAL Docker database
(`127.0.0.1:55439/nexus_development`, GALE-JACKET `Product.version` **59**; Neon prod is **51**) — the readings are in
`docs/pes-claims.md` under "VT.1 Phase 0".

---

## 1. `VariationThemeCell` — the cell's VALUE

One column, `key: 'variation_theme'`, `kind: 'variationTheme'`, `shape: 'axes'`, served by `GET /studio/sheet` on
**every** scope, first after the identity column, width **160** (R-VT-4, 2026-09-13 — was 200; measured both ways by
VT.F), header `Variation theme` (D-VT1, D-V9).

The cell's `value` **is** this object (`row.values['variation_theme'].value`), not a string. `null` is the CHILD-row
state (§1.3). The grid's copy/export/filter text is derived by the renderer, never sent (§1.4).

```ts
/** The delivered projection of the family's axes on ONE coordinate. */
export interface VariationThemeCell {
  /** In DELIVERY order. Empty only when the family has no axes at all. */
  axes: Array<{
    /** Canonical key: color | size | style | material | fittype | … (`canonicalVariantAxis`). */
    axisKey: string
    /** The axis's key as the FAMILY stores it (`Product.variationAxes` holds `Colore`, not `color`). */
    familyKey: string
    /** English label — Nexus vocabulary; what master shows. */
    label: string
    /** What the channel DELIVERS: Amazon's bound-attribute title, the eBay site aspect, the Shopify option. */
    channelName: string
    /** Amazon: the theme segment's SP-API attribute. eBay: the aspect name. Shopify/Etsy: the option name. */
    target: string | null
    /** false = dropped on this coordinate (limit or rule) — always named in `dropped` too. */
    included: boolean
    /** Amazon only: the theme SEGMENT this axis came from (`COLOR_NAME`), for the tooltip. */
    segment?: string
    /**
     * 🔴 Set when a segment/axis binds to NOTHING on this coordinate. The cell renders the name in warning
     * tone and readiness raises `attribute-unbound`. Measured 2026-09-13 (T15, re-measured on local): the
     * `_NAME` spelling binds no property on OUTERWEAR, and eBay·DE has no category at all on GALE, so it has
     * no aspect list to bind against. An unbound axis must never be shown as delivered.
     */
    unbound?: { reason: string }
  }>
  /** AMAZON only: the enum value chosen and the label derived from the BOUND attributes' titles. */
  theme: { code: string; label: string; deprecated: boolean } | null
  /** Where this projection came from. `ruleLabel`/`category` are non-null only for `kind: 'rule'`. */
  source: {
    kind: 'derived' | 'rule' | 'override' | 'none'
    ruleLabel: string | null
    category: string | null
    /** The verbatim sentence for the hover and the editor's source row — Appendix A copy, server-stated. */
    label: string
    /** Amazon derivation only: why THIS enum value won when several matched (D-VT8). */
    tieBreak?: 'bare-form' | 'only-match' | 'only-live' | 'set-order' | 'kept-from-listing'
  }
  /**
   * Everything the editor needs, PER COORDINATE, from CACHED schemas only (never a live call — T13).
   * `null` on master: master's candidates are the per-variant editable scalar columns, served in `masterCandidates`.
   */
  candidates: {
    kind: 'theme-enum' | 'aspects' | 'free'
    items: Array<{
      code: string
      label: string
      /** True when every one of the family's axes survives this choice. */
      coversAll: boolean
      /** axisKeys this choice DROPS. Empty when `coversAll`. */
      drops: string[]
      deprecated: boolean
      /** aspects only: eBay marks the aspect required for the category. */
      required?: boolean
    }>
    /** `limits.axes` for this coordinate — `null` = no limit this codebase can source. */
    limit: number | null
    /** When the schema this list came from was fetched, so the editor can say `schema from <date>`. */
    schemaFetchedAt: string | null
    /**
     * 🔴 Why the list is empty, when it is. `'ok'` = the channel offers these. `'freeform'` = the channel takes
     * free names (Shopify). `'unavailable'` = we COULD NOT LOOK (no cached schema, or no category on the
     * coordinate — eBay·DE on GALE). Three different sentences that serialised identically before this field.
     */
    state: 'ok' | 'freeform' | 'unavailable'
    /** Set whenever `state === 'unavailable'`: the reason, verbatim, for the editor's Banner. */
    unavailableReason?: string
  } | null
  /** MASTER scope only: the axes an operator may add, from the per-variant editable scalar columns (T1). */
  masterCandidates: Array<{ key: string; label: string; axisKey: string; valueCount: number }> | null
  /** axisKeys not delivered here, named — never silent (VX §6). */
  dropped: string[]
  /** Non-null only when `dropped` is non-empty AND included variants collide on the surviving key. */
  collisions: { unresolved: number; summary: string } | null
  /** Non-null when this coordinate is LIVE: a SET change is an operation, not a cell edit (§3.5 / VX §9). */
  locked: {
    reason: string
    externalId: string | null
    setChangeIs: 'relist' | 'new-parent' | 'in-place'
    /** eBay: reordering a live listing is a revise, not a relist — an order-only commit is allowed. */
    orderChangeAllowed: boolean
  } | null
  /**
   * Where the write lands. The SheetWriter routes on `column.kind === 'variationTheme'` and then on THIS —
   * never on the column key, and never on `writeField`. `null` = nothing to write here (child row, or no
   * listing on this coordinate); `writeBlockedReason` then says why.
   */
  write: {
    endpoint: 'variation-axes' | 'projection'
    /** The CAS token: `Product.version` for `variation-axes`, the parent `ChannelListing.version` for `projection`. */
    expectedVersion: number
    /** '' = the primary listing. */
    aliasKey: string
    /** Query the client must send back verbatim. */
    coordinate: { channel: string | null; market: string; accountId: string | null }
    /** `variation-axes` only — its validator REQUIRES the reviewed child ids (see §3.1). */
    childIds?: string[]
  } | null
  writable: boolean
  writeBlockedReason: string | null
  /** The channel's own noun for the editor title and tooltip (`theme` / `specific` / `option` / `property`). */
  vocabulary: { axisNoun: string; axisNounPlural: string; sectionTitle: string }
  /** The separator the renderer joins delivered names with: Amazon ` / `, everyone else ` · `. */
  separator: string
}
```

### 1.1 `source.label` — the verbatim sentences (Appendix A, server-stated)

| `source.kind` | `label` |
|---|---|
| `derived` | `Derived from the family axes` |
| `rule` | `Follows rule <ruleLabel>` |
| `override` | `Overridden here` |
| `none` | `Choose a theme` (Amazon) · `Set axes…` (master, no axes) |

The cell NEVER composes these — `describeCellSource()`'s rule for every other cell applies here too.

### 1.2 Master scope

`theme: null`, `candidates: null`, `masterCandidates` filled, `source.kind: 'derived'` with
`label: 'Derived from the family axes'` when the family HAS axes (master IS the structure, so the renderer draws no
provenance mark on master — §3.4), `source.kind: 'none'` with `label: 'Set axes…'` when `variationAxes` is empty.
`write.endpoint: 'variation-axes'`, `expectedVersion` = `Product.version`, `childIds` = the family's child ids.

### 1.3 Child rows

`row.values['variation_theme'].value === null`, `writable: false`,
`writeBlockedReason: 'Set on the parent'`. The renderer draws `—` with that tooltip (VT.8, Appendix A).

### 1.4 Copy / export / filter text (renderer-side, stated here so both hosts agree)

`axes.filter(a => a.included).map(a => a.channelName).join(cell.separator)` — `Color · Size` on master and eBay,
`Colore / Taglia` on Amazon·IT. On a child row: `—`. When `axes` is empty: `''` (the cell shows the `source.label`).

---

## 2. The resolver — `resolveVariationProjection(coordinate)`

`apps/api/src/services/pim/variation-rules.service.ts`. Pure over an injected `SchemaFacts` bundle, so it is unit
testable with no database (`reference_node_probe_pure_modules`). Three tiers, in this order:

1. **`override`** — the coordinate's PARENT listing row for this `aliasKey`.
   - Amazon / Shopify / Etsy: `ChannelListing.variationTheme` + `ChannelListing.variationMapping`.
   - eBay: today `Product.variationTheme`; after the VX D1 flip, `platformAttributes._variationAxes` on the
     coordinate when non-empty, else `Product.variationTheme` (§4.3).
   - 🔴 **`''` is NOT an override.** An empty string on an ACTIVE row is real data (T16: `GALE-JACKET-BLACK-MEN-XS`
     Amazon·IT carries `""` on both prod and local) and resolves to `null` → fall through to the next tier.
2. **`rule`** — `MarketplaceSchemaMapping.variations` for `(channel, market, category)`, then the channel-wide
   fallback (VX M2 / §11.1). **No rule exists in the catalogue today** (measured: the `variations` key is absent from
   every row), so this tier is wired, exercised by unit tests against a fixture rule, and reports `kind: 'rule'`
   only when a real row carries one. It NEVER invents a label.
3. **`derived`** — from the family's ordered `Product.variationAxes` (§3.2). This is the tier that makes
   "mapped by default" true without an operator writing a rule.

### 2.1 Amazon derivation, exactly (D-VT8, decided by T14–T16)

```
segments(theme)          = theme.split('/').map(trim).filter(Boolean)
canonicalThemeSegment(s) = canonicalVariantAxis(s.replace(/_?NAME$/i, ''))     // COLOR_NAME → color
want                     = variationAxes.map(canonicalVariantAxis)             // ["Colore","Taglia"] → [color,size]

inOrder = enum.filter(t => canon(segments(t)) equals want, in order)
asSet   = enum.filter(t => canon(segments(t)) equals want, as a set)

inOrder.length === 1  → derived, tieBreak 'only-match'
inOrder.length  >  1  → drop the DEPRECATED spellings first (below); if exactly one survives → derived,
                        tieBreak 'only-live'. If several still survive → PREFER THE BARE FORM (the spelling
                        with no `_NAME` segment), tieBreak 'bare-form'.
inOrder.length === 0 && asSet.length > 0 → derived from asSet[0] (same two filters) with the THEME's segment
                        order, tieBreak 'set-order'; the editor says `order from the theme`
otherwise             → source.kind 'none'; readiness `theme-unset`
```

🔴 **The tie-break is DERIVED, not preferred — measured 2026-09-13 by VT.1, strengthening D-VT8.**
`variation_theme.items.properties.name.$lifecycle.enumDeprecated` on OUTERWEAR·IT lists **28 deprecated enum
values, and every `_NAME` spelling is one of them** — `COLOR_NAME`, `SIZE_NAME`, `COLOR_NAME/SIZE_NAME`,
`SIZE_NAME/COLOR_NAME`, `STYLE_NAME`, `TEAM_NAME/SIZE_NAME/COLOR_NAME`, … — while `COLOR/SIZE` and `SIZE/COLOR`
are NOT. So on this product type the ambiguity resolves with **no preference at all**: one of the two matches is
marked dead by Amazon. The bare-form rule stays as the second filter for a product type whose deprecation list
does not separate them, and `tieBreak` says on the wire which filter decided. The reader is
`$lifecycle.enumDeprecated` on the enum-bearing node, the same marker
`services/amazon/flat-file.service.ts:findEnumDeprecated` reads — that module is UNTOUCHABLE and carries a heavy
import graph, so `variation-theme-segments.ts` has its own small reader **pinned by a test that asserts both
readers return the identical list on the real cached node**. One rule, two readers, proven equal.

Because the deprecated `_NAME` twin is still OFFERED by the schema, the editor lists it under `Deprecated` —
never hidden (warn, never block, as every other deprecated enum on this sheet).

**A listing that already carries a theme keeps it** (`kind: 'override'`, `tieBreak: 'kept-from-listing'`) even when
it is the `_NAME` form — a re-theme is an operation (VT.6), never a silent correction.

**Attribute binding (never by string convention — T15):** for a segment `S` against the product type's
`schema.properties`: `lower(S)` if that property exists → else `lower(S)` with a trailing `_name` removed → else
**unbound** (`axes[].unbound.reason`, readiness `attribute-unbound`). On OUTERWEAR IT/DE this binds
`COLOR_NAME → color`, `SIZE_NAME → size`, `MATERIAL_TYPE → material`; `color_name` and `size_name` do not exist.

**Display label** = the bound attributes' `title`s joined with ` / ` — `Colore / Taglia` on IT, `Farbe / Größe` on
DE. **Not** `enumNames` (T17: machine-cased `COLORE/DIMENSIONI`). The enum code rides in the tooltip.

**Candidates** come from the LATEST `CategorySchema` row for `(AMAZON, marketplace, productType)` **regardless of
`expiresAt`** (T17: every prod row is expired; local's BE/NL rows are too), with `schemaFetchedAt` on the wire so the
editor can say `schema from <date>`.

### 2.2 eBay derivation

Per axis, the site's **variation-enabled** aspect (`variantEligible`, i.e. `aspectEnabledForVariations`) whose
canonical key equals the axis key — matched on BOTH the localized `name` and the `englishName` eBay returns, so no
localized-name table is hardcoded. Measured live 2026-09-13 (Phase 0):

| site | category | aspects | variantEligible | `color` → | `size` → |
|---|---|---|---|---|---|
| IT | 177104 | 20 | 3 (`Taglia`, `Colore`, `Scollatura`) | `Colore` (en `Color`) | `Taglia` (en `Size`, not required) |
| DE | **177117** | 30 | 6 (`Größe`, `Sichtbares Logo`, `Farbe`, `Verschluss`, `Herstellernummer`, `Brustweite`) | `Farbe` (en `Color`) | `Größe` (en `Size`, **required**) |

🔴 **The IT category id does not exist in the DE tree** (`eBay 400 errorId 62005`), and GALE's eBay·DE listing carries
no category at all. So on eBay·DE the cell serves `candidates.state: 'unavailable'` with
`unavailableReason: 'This eBay DE listing has no category yet, so its variation specifics cannot be read.'` and each
axis carries `unbound`. An axis with no eligible aspect on a category we CAN read becomes a custom specific under the
English label, `unbound.reason: 'Not a variation aspect on this eBay site — it publishes as a custom specific and is
outside the filters.'`

### 2.3 Shopify / Etsy

The English label, in family order; `candidates.kind: 'free'` + `state: 'freeform'` on Shopify (limit 3),
`kind: 'aspects'` on Etsy from its property list (limit 2). Values are pushed **verbatim** — nothing is translated
by Nexus (VX D5, Owner 09-12).

### 2.4 Limits and drops

The derivation never exceeds `limits.axes` for the coordinate (`family-projection-limits.ts`: eBay 5, Shopify 3,
Etsy 2, Amazon = the widest segment count in its own enum). Trailing axes beyond the limit are `included: false` and
listed in `dropped`; the collision rule (VX §6) then applies.

---

## 3. Writes — one path

### 3.1 master → `PATCH /api/products/:id/studio/variation-axes`

**The body is NOT `{ version, axes }`.** Measured in `family-variation-axes.ts:validAxisChange`: the validator
requires four fields, and a request missing any of them answers
`400 {"error":"Supply a family version, unique axes, reviewed childIds and market."}`.

```jsonc
{ "version": 59, "axes": ["Colore", "Taglia"], "childIds": ["…", "…"], "market": "IT" }
```

`axes` are the FAMILY's keys (`familyKey`, e.g. `Colore`), not canonical keys — and they must each be one of the
`GET /studio/variation-axes` options. `childIds` must be exactly the family's current child ids, which is why
`cell.write.childIds` relays them. Response `{ version }`. Refusals (all `ProductRelationshipError`):
`400` axis not in the dictionary · `400` "Set axes on the shared parent…" · `409` "This family changed after you
reviewed it…". A no-op change returns the same version and writes nothing.

### 3.2 channel × market (× alias) → `PATCH /api/products/:id/studio/projection?channel&market&accountId&aliasKey`

```jsonc
{ "expectedVersion": 18, "theme": "COLOR/SIZE", "mapping": [ { "axisKey": "Colore", "target": "Colore", "order": 0 } ] }
```

- `expectedVersion` — the parent `ChannelListing.version` (`cell.write.expectedVersion`). Required; not an integer → 400.
- `mapping` — **the WHOLE list**. An axis left out is unmapped; a partial patch cannot express a removal.
- `theme` — Amazon only; `null` clears it.
- `reset: true` — **additive, VT.1** (§3.3).
- Response: the full `ProjectionRead` (`docs/vp2-contracts.md` §4), so the client repaints from the server's truth.

### 3.3 `reset` — additive

```jsonc
{ "expectedVersion": 18, "reset": true }
```

Nulls the override on this coordinate ONLY: Amazon/Shopify/Etsy → `variationTheme = null`, `variationMapping = null`
on the parent listing row; eBay → removes `_variationAxes` and `_axisNameLabels` from the coordinate's
`platformAttributes` (`Product.variationTheme` is left alone: it is shared by every eBay market, so clearing it from
one coordinate would change all of them — the projection already reports `affectsAllMarkets: true` for eBay).
`reset` may not be combined with `theme` or `mapping` → `400 bad_projection_request`
`"reset clears this coordinate's override; send it on its own."` After a reset the next read returns
`source.kind: 'rule' | 'derived'`.

### 3.4 Error shapes — one vocabulary

| status | `error` | when | extra |
|---|---|---|---|
| 400 | `bad_projection_request` | missing/!integer `expectedVersion`; `mapping` not an array; unknown axis; over `limits.axes`; duplicate target; target not offered; `reset` with `theme`/`mapping` | `detail` names the limit / the axes / the options |
| **400** | **`collision_unresolved`** | **VT.1, new:** the mapping's included variants do not have distinct keys and no resolver was given | `collisions: CollisionReport` (§3.5) |
| 409 | `version_conflict` | `expectedVersion` ≠ the row's version, before or inside the transaction | `current`: the fresh `ProjectionRead` |
| 409 | `axes_locked` | the coordinate is live and the axis SET changed | `locked`, `current` |
| 409 | `no_listing_here` | no parent listing row on this coordinate | — |
| 404 | `product_not_found` | — | — |

Every one of these is thrown as `ProjectionRequestError` / `ProjectionConflictError`, which
`product-studio.routes.ts`'s duck-typed mapper already turns into that body — no new branch in the route.

### 3.5 `CollisionReport` (VX §6, served on GET and on the 400)

```ts
export interface CollisionReport {
  /** Groups of ≥2 included variants sharing one key on the surviving axes. */
  groups: Array<{
    /** The surviving key, in delivery order, as the channel would receive it. */
    key: string[]
    members: Array<{ id: string; sku: string; droppedValues: Record<string, string> }>
  }>
  unresolved: number
  /** One sentence, server-stated, for the cell tag and the editor footer. */
  summary: string
  /** Which resolvers CAN run here; `null` reason = it can. */
  resolvers: Array<{ kind: 'split' | 'fold' | 'exclude'; available: boolean; reason: string | null }>
}
```

`fold` needs a `foldInto` axis present in the mapping; `split` needs aliases creatable (held until PES.5-ii, so it
reports `available: false` with that reason); `exclude` can always run.

### 3.6 What the bulk PATCH does NOT do

`variation_theme` is removed from `CHANNEL_WRITABLE` (`studio-sheet.service.ts`) and `amazon_variationTheme` /
`ebay_variationTheme` from `CHANNEL_FIELD_MAP` (`channel-field-map.ts`), and the two raw sheet columns
(`channel-specs/amazon.ts` `variation_theme`, `channel-specs/ebay.ts` `variationTheme`) are retired. **One fact, one
writer.** A `PATCH /api/products/bulk` carrying `variation_theme` is refused by the write gate rather than landing
somewhere nothing reads — VT.1 proves that with a negative control AND a positive control in the same run.

---

## 4. Readiness items

`scope-readiness.service.ts` gains three kinds. Each is per COORDINATE and names the axis or the theme, so the
catalogue filter (VX §11.4) and the Needs-attention list can route on them:

```ts
export type VariationReadinessKind = 'theme-unset' | 'collision' | 'attribute-unbound'
export interface VariationReadinessItem {
  kind: VariationReadinessKind
  coordinate: string          // 'Amazon · IT'
  /** Verbatim, server-stated. */
  message: string
  /** `attribute-unbound` / `theme-unset`: the axisKeys involved. `collision`: the colliding SKUs, capped at 10. */
  subjects: string[]
  severity: 'error' | 'warning'
}
```

| kind | severity | message |
|---|---|---|
| `theme-unset` | `error` | `No variation theme on <coordinate> — the family's axes match none of this product type's themes.` |
| `collision` | `error` | `<n> variants cannot be told apart on <coordinate> after <axis> is dropped.` |
| `attribute-unbound` | `warning` | `<segment> on <coordinate> binds to no attribute of this product type.` |

`theme-unset` is an ERROR because a live push without a theme is an 8541-class failure; `attribute-unbound` is a
WARNING because the push still goes out, with the axis missing — which is exactly what
`amazon-publish.adapter.ts`'s `${axis}_name` fallback did silently until VT.1 replaced it (T15).

---

## 5. The catalogue filter (VT.4's, fed by VT.1)

`/products/next?filter=variation-mapping:derived|rule|overridden` — the values are exactly `source.kind` minus
`none`, plus `unset` for `none` and `collides` for a coordinate with `collisions.unresolved > 0`.

---

## 6. Fixtures VT.2 can import

`docs/fixtures/vt1/fixtures.ts` — self-contained TypeScript, no imports, exporting

- `GALE_MASTER` — master scope, 2 axes (`Colore`, `Taglia`), `source.kind: 'derived'`, `masterCandidates` filled,
  `write.endpoint: 'variation-axes'`, `expectedVersion: 59`, 20 `childIds`.
- `GALE_AMAZON_DE_DERIVED` — Amazon·DE, `theme COLOR/SIZE` label `Farbe / Größe` (the BOUND attributes' titles,
  measured: `color.title = "Farbe"`, `size.title = "Größe"`; `enumNames` says `FARBE/GRÖSSE`), `source.kind:
  'derived'` `tieBreak: 'only-live'`, `limit: 4` (the widest segment count in its own enum, measured 4 on both
  IT and DE), `schemaFetchedAt 2026-09-12T14:52:54.095Z`, `write.endpoint: 'projection'`, `expectedVersion: 13`,
  `locked` (ASIN B0D8XBXM5H, `setChangeIs: 'new-parent'`).
- `GALE_EBAY_IT_OVERRIDDEN` — eBay·IT, `source.kind: 'override'`, delivered names `Colore · Taglia`, 3 candidate
  aspects, `limit: 5`, `expectedVersion: 18`, `locked` (item 257584954808, `setChangeIs: 'relist'`,
  `orderChangeAllowed: true`).
- `GALE_EBAY_DE_UNAVAILABLE` — the honest "could not look" state (no category on the DE listing).
- `GALE_CHILD` (`null` — the cell VALUE on a child row) + `GALE_CHILD_WRITE_BLOCKED_REASON`.
- `GALE_SHOPIFY_DROPPED` — a 3-axis family on a 2-option projection with `dropped: ['style']` and a collision,
  for the `n dropped` / `collides` states. `AMAZON_THEME_UNSET` — the `Choose a theme` state.
- `VariationThemeCell` re-declared in that file so it type-checks anywhere (verified: `tsc --strict` on the file
  alone, exit 0), plus `VT1_FIXTURES` keyed by scope and `GALE_CHILD_IDS` (the 20 real child ids the
  `variation-axes` PATCH requires back).

**One label the doc's §3.4 illustration gets wrong for this catalogue, on purpose:** it prints `Colour · Size`.
The SERVED English label of the master axis columns is **`Color`** and **`Size`** (measured on
`GET /studio/columns?scope=master&market=IT`: `{key: color, label: "Color", scope: per_variant, axis: true}`).
The cell shows the served label, never a spelling chosen in a document — so master reads `Color · Size`.

Every string in them is the copy from the design's Appendix A; every number is a Phase 0 reading.
