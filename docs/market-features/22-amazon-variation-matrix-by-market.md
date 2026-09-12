# 22 — Amazon VARIATION MATRIX / VariantCube: axis grid, by-variant and BY-MARKET views

## 1. What it is (operator terms)

A catalogue operator owns a *family*: one parent SKU (GALE-JACKET) and its 20 variations, told
apart by axis values (Colore × Taglia). Three questions arise, and the old page answered each with
a different pivot of the same data. **(a) "show me the family as a colour × size grid"** — the axis
grid, used when creating/auditing coverage ("is there a Nero 3XL?"). **(b) "show me every variation
on THIS market"** — rows = variants, columns = price/qty/status, used for daily price and stock
work. **(c) "show me THIS variation on EVERY market"** — rows = variants, columns = IT/DE/FR/ES/UK,
used when an operator has just changed a price or quantity and needs to know which markets still
disagree, or is launching one variant into a new market. Alongside it sits the *family-level*
question nobody else answers: **what is this family's variation theme, what are its axes, and who
is the parent** — the structural facts that decide whether Amazon will even accept the family as a
multi-variant listing.

The studio's sheet already IS (a) and (b) for one coordinate. (c) and the family-structure editing
are the lost halves.

## 2. Old UI — inventory

**Entry points.** `tabs/amazon-cockpit/AmazonCockpit.tsx:661` mounts `<VariantCube>` with
`<VariationMatrix>` handed in as the `axisGrid` slot (`:668`). `tabs/MatrixTab.tsx` is the separate,
older full-page pivot. `tabs/VariationsTab.tsx` and `tabs/MasterDataTab.tsx:1423` mount
`CrossChannelMatrix`.

- **`variations/VariantCube.tsx` (873 lines)** — a three-tab switcher over one data hook
  (`:200`): `axis` (the slot), `variant`, `market`. Defaults to `axis`.
  - **`ByMarketView` (`:271`)** — THE lost surface. Rows = variants, columns = market codes, one
    field at a time chosen by a two-button toggle (`price` | `listedQty`, `:349`). Per-cell
    `EditableNumberCell` (`:32`) — click → `<input>`, Enter/blur commits, Esc cancels. A `⇥ Fill`
    button per row (`:410` region, logic `:310`) copies the first non-null market's value across
    every non-FBA market in one call. FBA cells render read-only with a 🔒 (`:307`) — the
    untouchable FBA-quantity rule, honoured.
  - Writes: `patchChannelPricing` → `PATCH /api/products/:id/channel-pricing` with
    `updates[{variantId, marketplace, channel, price|quantity}]` (`:159`). Master fields go via
    `patchChild` → `PATCH /api/products/:id` (`:117`) and `patchChildrenBulk` →
    `PATCH /api/products/bulk` (`:132`).
  - Browser-local: an optimistic overlay `edits` keyed `${field}:${variantId}:${market}` (`:182`).
    Never reconciled against a re-read — a failed write leaves the typed number on screen only if
    `ok` was true, but a *stale* server value is never corrected without a full refetch.
  - `FieldScopePopover` per variant for price field-links (`:441`), members = every market.
- **`_shared/cockpit-shell/useVariantCube.ts` (175 lines)** — the shared read. THREE parallel
  fetches (`:71–75`): `/api/products/:id/children`, `/channel-pricing?channel=`,
  `/channel-inventory?channel=`, merged into `CubeVariant{axes, marketsByCode}`. Derives
  `axisNames` (`:162`) and `marketCodes` (`:168`) from the data, not a constant. Live refresh via
  `useInvalidationChannel(['product.updated','channel-pricing.updated','listing.updated'])`,
  debounced 800ms (`:153`).
- **`variations/VariationMatrix.tsx` (1257 lines)** — the axis grid. Axes detected from
  `variations`/`variantAttributes` per child (`readAxes`, `:116`); 1 axis → list, 2 → 2-D grid,
  3+ → flat list (`:302–307`). Per-cell SKU + colour-locked thumbnail + price + stock + status dot.
  Bulk row/column apply (`applyBulk`, `:612`) → `PATCH /api/products/bulk` (`:659`).
  **`ThemeBadge` (`:441`) is READ-ONLY and says so in its own tooltip: "Detected from variant axes
  — AC.6.2 promotes this to a real picker" (`:471`). AC.6.2 never landed.** So the old page never
  had variation-theme *editing* either; it had a derived chip.
- **`_shared/cockpit-shell/CrossChannelMatrix.tsx`** — a drawer (`:70`) whose rows are
  channel×market coordinates and whose subject is ONE field, chosen from a fixed four
  (`title`/`description`/`price`/`brand`, `:47–53`), with propagate-preview → diff → Apply through
  `/api/products/:id/cross-channel/propagate-preview` and `/applied`
  (`useFieldLinks.ts:235,367`). Currency-mismatch targets skipped, machine translations flagged.
  **This is the closest existing precedent for the shape recommended in §6.**
- **`tabs/MatrixTab.tsx` (2076 lines)** — market pills IT/DE/FR/ES/UK inside the grid (`:1164`)
  switch which market's price/qty columns are shown; columns are `[axes] · SKU · Base price ·
  <MKT> price · Listed qty · Fulfilment · Avail. · Physical · Status` (`:1329–1340`).

**Nothing here is dead** — every component has a live importer.

## 3. Backend that exists

| method + path | file:line | notes |
|---|---|---|
| `GET /api/products/:id/channel-pricing` | `routes/product-channel-data.routes.ts:47` | variant × **every** market, ONE call |
| `PATCH /api/products/:id/channel-pricing` | `product-channel-data.routes.ts:150` | the old by-market writer |
| `GET /api/products/:id/channel-inventory` | `product-channel-data.routes.ts:220` | variant × every market qty + physical |
| `GET /api/products/:id/all-listings` | `routes/marketplaces.routes.ts:216` | **every** ChannelListing for one product, grouped by channel, ONE call, `omit: {flatFileSnapshot, overrideData}` |
| `PATCH /api/products/bulk` | `routes/products.routes.ts:1138` | the studio's one writer; `marketplaceContexts[]` **fan-out** (`:1043–1053`) applies one change to N coordinates |
| `GET /api/pim/family/:productId` | `routes/pim.routes.ts:662` | role · self{variationTheme, variationAxes} · parent · children · siblings |
| `POST /api/pim/promote-to-parent` | `pim.routes.ts:462` | the **only** writer of `variationTheme` + `variationAxes` on a product (`:492–498`) |
| `POST /api/pim/demote-parent` | `pim.routes.ts:718` | clears `variationTheme`; 409 with children unless `force` (which orphans them) |
| `POST /api/pim/reparent` / `attach-to-parent` | `pim.routes.ts:767` / `:320` | attach takes optional per-child `axisValues` |
| `POST /api/amazon/pim/unlink-child` | — | **`/api/amazon`, gated `channels.sync`**, not `pim.manage` |
| `PATCH /api/catalog/products/:productId/variant-attributes` | `routes/catalog.routes.ts:1710` | **atomic axis-value write, MERGE semantics, keeps THREE stores in sync**: `Product.variantAttributes`, `Product.categoryAttributes.variations`, `ProductVariation.variationAttributes`. Empty string deletes an axis. |
| `GET /api/products/:id/studio/sheet` | `routes/product-studio.routes.ts:179` | one coordinate, whole family; **`?market=` not `?marketplace=`** |
| `GET /api/products/:id/readiness` | `product-studio.routes.ts:212` | one market per call |

**Prisma.** `Product.variationTheme` (`schema.prisma:125`), `Product.variationAxes`,
`Product.variantAttributes` (`:302`), `isParent`/`parentId` self-relation (`:247–251`).
`ChannelListing` already carries **`price`, `salePrice`, `quantity`, `title`, `description`,
`variationTheme`, `variationMapping`, `listingStatus`, `offerActive`, `version`, `aliasKey`**
(`:1470–1530`) — **no schema change is needed for anything in §6/§7.**

**The write gate, and the finding that shapes this feature.**
`services/pim/channel-field-map.ts:22–36` is the complete list of fields `PATCH /api/products/bulk`
can route to a ChannelListing **column**: `{amazon,ebay}_{title,description,variationTheme}` +
`amazon_bulletPoints`. Everything else channel-bound goes to the `overrideData` bag via
`attr_*`. `studio-sheet.service.ts:519` then rules that **`storage: 'column'` stays master** — and
`FOLLOW_BY_KEY:446` shows `basePrice`/`price`/`quantity` are exactly such columns. So:

> **Per-market price and per-market quantity are NOT writable through the studio's one writer
> today. On a channel scope `basePrice` edits MASTER.** (CODE-READ: `studio-sheet.service.ts:462–
> 473`, `:519–525`, `channel-field-map.ts:22–36`; the service's own comment at `:1169` names
> `description`, `name` and `basePrice` as master-routed on eBay·IT.)

**Permissions** (`lib/auth/permissions-manifest.ts`): `/api/pim` → `pim.manage` (`:383`);
`/api/amazon` → read `listings.view`, write `channels.sync` (`:353`); `/api/catalog` and
`/api/catalog-matrix` → `products.view`/`products.edit` (`:399–401`); `/api/products/bulk` →
`products.edit` (pinned by `permissions-manifest-order.vitest.test.ts:85`); `/api/field-links` →
`pim.manage`. **Three different permissions across one feature's verbs** — already written down in
`_studio/sheet/master/familyActions.ts:10–22`.

**External channel calls / safety.** None of the endpoints above talks to Amazon. Publish is
separate and explicit; eBay is preview-only. `POST /api/amazon/pim/repair-parentage` (and the
catalog-refresh job) *read* `variation_theme[0].name` from SP-API and write
`isParent`/`variationTheme`/child axis names (`amazon.routes.ts:605–792`) — i.e. **a cron can
overwrite the family structure an operator edits**, see §8.

## 4. Studio today

**Built.**
- `_studio/sheet/master/**` is the axis grid and the by-variant view, for ONE coordinate — parity
  **3.30 ✅** (re-graded, ruling #91).
- `family.ts` / `useFamily.ts` / `FamilyBar.tsx` / `FamilySelectionBar.tsx` — the family bar exists
  and renders whatever `familyActions` declares at `contextOf('product-family')`
  (`FamilyBar.tsx:52,92`). `familyAxes()` reads `self.variationAxes` and never splits
  `variationTheme` (`family.ts:38`). Closes **6.16**.
- `familyActions.ts` + `familyOps.ts` — promote · attach · unlink · reparent · add-variation ·
  delete-variant · demote, each with preflight and confirm. Closes **6.14–6.21**. `promote` is the
  one verb that carries `variationTheme` + `variationAxes` (`familyOps.ts:192–197`).
- `AddVariationDialog.tsx:72–91` builds one `Input` **per family axis, from
  `family.self.variationAxes`** — never free text, because `Colore`/`colore` would silently split
  one family into two (ruling #135).
- `identitySecondary.ts` — the identity band's second line is the axis values, decided **once per
  family** by `axesFullyCovered` (`:47`), else nothing (#725).
- `drawer/useCompare.ts` + `panes/ComparePane.tsx` — **ONE field × N coordinates, read-only**,
  assembled as N `GET /studio/sheet` reads (`useCompare.ts:60–83`). Its docstring at `:18` states
  the exact gap this feature is about: *"the sheet is loaded for ONE scope, so what the same field
  carries on Amazon DE … is not in the row object."*
- `sheet/channel/channelActions.ts:305` — **`broadcast-to-listings`**, a SELECTION verb, COLLECT →
  PREFLIGHT (type-to-confirm, phrase = the channel) → RUN. Its own docstring (`:295–300`): *"The
  write endpoint has supported this since R.1 — `marketplaceContexts` fan-out — and no surface has
  ever reached it."*

**Parity rows.** 3.30 ✅ / **3.30n 🕳** ("this variant across all markets is not answerable from the
channel scope", `docs/pes-parity-audit.md:212`) · **3.13n 🕳** broadcast, ranked *third* in the
audit's own triage order because "the write path already supports it" (`:223`) · 6.1 🔁 superseded ·
**6.10 🔁 superseded — market is the FRAME's switcher, "one sheet per market with a switcher"
(Owner's MS decision), not chips inside the grid** · 6.14–6.21 all now closed by PES.2's F2–F4.

**Rulings that bind.** **#105 D2** — family restructuring: *build a studio surface now → PES.2,
design proposed FIRST through the hub, built on the Owner's approval*. **#110** — one verb, one
declaration, every surface. **#118** — COLLECT before PREFLIGHT. **#135** — axis fields from
`variationAxes`; a missing axis WARNS, never blocks; a new variation is `ACTIVE` from birth.
**#690** — axis columns sit AFTER the required block, and were measured EMPTY (0/21). **#716/#725**
— the band's second line. **#718/#721 (Owner item 46)** — **227 of 228 ACTIVE Amazon child listings
across 9 families carry no variation theme of their own; on GALE-JACKET 0 of 20 children carry
axis values, and colour/size exist only as text in the SKU.** #13 — AI dark.

## 5. Defects and slowness

1. **The old by-market writer reports success it did not have.** `PATCH /channel-pricing` runs
   `await Promise.allSettled(ops)` then `return reply.send({ ok: true, updated: updates.length })`
   (`product-channel-data.routes.ts:208–209`). Every rejection is discarded; a Fill across five
   markets that upserts none answers `ok:true, updated:5`, and `VariantCube` then commits the
   number to its optimistic overlay. **CODE-READ.** (Same shape at `:431`/`:465`.)
2. **That writer cannot address an alias.** The upsert key hardcodes `aliasKey: ''`
   (`:175`, `:406`, `:415`) — with N listings per coordinate (layout §2.3) it always writes the
   primary. **CODE-READ.**
3. **It silently pins.** Writing a price sets `followMasterPrice = false` (`:169`, `:198`), qty the
   same (`:171`) — an inheritance break the old UI never showed and never asked about.
   **CODE-READ.**
4. **No optimistic concurrency anywhere in the by-market path.** No `expectedVersion`, no
   `If-Match`, no version read-back — while the studio's channel write CASes on
   `row.listing.version` and the two counters differ on **89% of listings**
   (`useChannelSheet.ts:232–238`). **CODE-READ.**
5. **Per-market price/qty are unreachable from the studio's one writer** — §3's boxed finding. Any
   by-market pane that shows price and qty and claims to write "through the same writer" is making
   a claim the contract cannot honour until `CHANNEL_FIELD_MAP` grows. **CODE-READ.**
6. **`broadcast-to-listings` is disabled by its own wiring, not just dark.** `ChannelSheet.tsx:726–
   727` passes `siblingMarkets: []` and `pickMarkets: async () => null`, so `available()` always
   returns *"AMAZON has no other market connected to broadcast to"* — a sentence that is false on a
   catalogue with IT/DE/FR/ES. And `run` returns `ok:false` with *"Not sent…"* by design.
   **CODE-READ.**
7. **Two stores for one concept — editing an axis COLUMN does not fill the axis LINE.**
   `row.axisValues` is read from `Product.variantAttributes` (`studio-sheet.service.ts:1311`),
   while an axis *column* is `storage: 'categoryAttributes'` and routes master. So a `color` cell
   edited in the sheet leaves `axisValues` empty, `axesFullyCovered` still false, and the identity
   band still blank — the operator's fix appears not to work. `PATCH .../variant-attributes`
   (`catalog.routes.ts:1710`) is the endpoint that writes **all three** stores, and no studio
   surface calls it. **CODE-READ.**
8. **No writer for a family's theme/axes after promotion.** Grepped: the only writers of
   `Product.variationAxes` are `promote-to-parent` (`pim.routes.ts:497`),
   `bulk-promote-to-parent` (`:618`) and `POST /api/amazon/pim/create-group`
   (`amazon.routes.ts:1117`). A parent promoted without a theme can never be given one, and a
   family that varies by the wrong axes cannot be corrected. **CODE-READ.**
9. **N-market fan-out over `/studio/sheet` is expensive.** Measured in `_studio/contracts.tsx:396–
   405`: 4.11–4.86s per market warm, **9.8–12.7s** for other markets' sheet loads, 62.8s cold.
   Four markets in parallel is a 5–13s pane. `useCompare` pays this for ONE field and admits it
   (`useCompare.ts:15–16`). There is no field or row narrowing param on the route.
   **MEASURED-IN-DOC.**
10. **The old cube is three waterfalled reads plus an 800ms-debounced full refetch on any of three
    invalidation events** (`useVariantCube.ts:71,153`) — a burst of sibling edits reloads the whole
    cube. **CODE-READ.**
11. **Giant components:** `VariationMatrix.tsx` 1257 lines, `VariantCube.tsx` 873,
    `MatrixTab.tsx` 2076, `MasterSheet.tsx` 1993, `ChannelSheet.tsx` 2000+. **CODE-READ.**
12. **The theme the old UI showed was DERIVED and labelled auto** (`VariationMatrix.tsx:448–462`)
    — an operator reading "SizeColor" was reading a client-side guess, not the stored value, unless
    `variationTheme` happened to be set. **CODE-READ.**
13. **Nothing in this feature has been round-tripped live.** Ruling #135: *"no family or channel
    verb has been ROUND-TRIPPED"* — the local session is `anon` against :8091 so every write verb
    is honestly disabled. **MEASURED-IN-DOC.**

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors — **(c) BOTH, but not symmetrically**

**Primary: H7 — the record drawer's `Markets` pane, built by EXTENDING the existing `Listings`
pane rather than adding a fifth tab.** Rows = coordinates (channel · market · alias), columns = a
capped, operator-chosen set of key fields, per-cell edit.

Why H7 and not a view preset. The Owner's MS decision is *one sheet per market with a switcher*
(parity 6.10), and a pivot that puts markets on the sheet's columns contradicts it at the level of
the frame, not the styling. It also breaks mechanically: market column groups need AG column
groups, and `master/columns.tsx:497–527` records that `marryChildren` **renders the group header
twice the moment any child is pinned** (measured) and that grouping forced `applyOrder: false`,
making §9.2's ordering rule unimplementable — which is why `grouped` defaults to `false` on both
scopes. The studio sheet has a permanently pinned identity block, so the double header is not a
risk, it is the guaranteed outcome. And the width is not there: the channel default view is already
**15664px of columns, 11.4 screens at 1372px** (`layout-v2-spec.md:120`); multiplying selected
columns by 4–5 markets makes that worse, not better.

Why extend `Listings` rather than add a pane. `panes/ListingsPane.tsx:11–15` states that it *used
to* iterate a listings map keyed by coordinate and that the shape was removed as a mirror of a
read the studio does not have — and that on the master scope it can only apologise ("Master … has
no listing of its own", `:64–70`). `all-listings` **is** that read. Extending the pane turns its
one honest apology into the answer, keeps the drawer at four tabs at 520px, and obeys "extend, don't add pages". Renamed `Markets`
with a count, since the pane's own comment
(`RecordDrawer.tsx:479`) says a count belongs on a pane that shows several.

**Mirror 1 — H4 SELECTION verb: `broadcast-to-listings`, made real.** The pane answers *where do
they differ*; the verb answers *make them agree*, for N selected rows at once, and a verb must
never live only in the drawer (channel-ops §3.2). It is already declared, preflighted and
confirmed (`channelActions.ts:305`); it needs `siblingMarkets`/`pickMarkets` actually wired
(`ChannelSheet.tsx:726`) and its `run` connected to the `marketplaceContexts` fan-out.

**Mirror 2 — H5 CONTEXT(`product-family`) verbs on the family bar: `Variation theme & axes…`.**
Theme and axes are facts about the FAMILY, not about a row or a market. The bar already exists and
already renders exactly what the registry declares at `contextOf('product-family')`; the axes it
prints today are read-only (`family.ts:38`, `FamilyBar.tsx:92`). One more verb, one more dialog
built from the same `familyAxes()` source `AddVariationDialog` uses.

**Mirror 3 — H1: the axis columns keep their cells, and start routing correctly.** Defect 7 is the
one an operator would call a bug. An axis column's cell must write through
`PATCH /api/catalog/products/:id/variant-attributes`, not the generic bag, so `axisValues` fills
and the identity band's second line finally appears on this catalogue.

**Explicitly NOT: H11.** There is no theme *library* to manage — `variationTheme` is one string per
family. A page outside the studio would be a page with one field on it.

### 6.2 What the sheet shows at rest

| scope | at rest |
|---|---|
| **master** | Unchanged. Axis columns present (after the required block, #690), with an `H2`-style hover note on an axis cell whose value is missing on a row: *"not set on this variation — 0 of 20 in this family carry it"*. No market marks: master has no coordinate. Family bar prints `Parent · 20 variations · Colore × Taglia` + the new `Variation theme & axes…` button. |
| **channel × market** | Unchanged column set. **One new status column, `Markets`, 92px, right of readiness** — a compact `n/m` glyph strip: how many connected markets for this channel hold a listing for this row, and how many of the pane's tracked fields differ from THIS coordinate. Read-only, filterable, tooltip lists the differing markets. It is the only thing the sheet gains, and it is what makes the pane discoverable. |
| **alias band** | Nothing new. An alias is a listing within one coordinate; the pane's rows include it as a third key part. |

The `Markets` column is derived from ONE extra read per sheet load (§7), so it costs one request,
not N.

### 6.3 The interaction

**Open.** Identity cell / `open-record` verb / Enter on identity (layout §5.5) → dock slides in at
520px, non-modal, sheet stays live and keeps the arrow keys. Tab to `Markets`. Or: click the
`Markets` cell's glyph strip → opens the drawer directly on that pane (the same
`record.open(rowId, colKey)` path `ChannelSheet.tsx:735` already uses).

**Collect / render.** One `GET /api/products/:id/studio/listings` (§7). Rows sorted channel then
market, the open coordinate **pinned first and marked "this scope"**. DS: `DataGrid`
(`design-system/components/DataGrid.tsx`) — a real `<dl>`-free HTML table with sortable, `numeric`
columns and its own `PreferencesModal` for the field picker. **Not a second AG Grid**, for
ComparePane's reason verbatim (`ComparePane.tsx:11–22`): two grids on one page both claim the arrow
keys with nothing on screen saying which has focus.

**Field picker.** DS `MultiSelect` in the pane header, seeded from the coordinate's own columns,
capped by the width rule in 6.6. Persisted per user through the same `useGridState` →
`SavedView` path the sheet uses, surface `product-edit:markets-pane`.

**Edit.** Double-click a cell (or Enter) → the DS editor for that column's `kind`. Commit on
Enter/blur. **Every commit goes through the host's `onWrite`**, which already takes a per-write
`scope` (`drawer/types.ts:635–650`) — so the drawer can already address a coordinate other than
the sheet's. No new write path.

**Preflight / confirm.** A single cell needs none. Two cases do, and both reuse the drawer's own
overlay confirm (`DrawerConfirm.tsx`): writing over a **pinned** value on another coordinate
(ComparePane's rule 2), and any row whose coordinate is a **live alias** — refused for now, exactly
as `broadcastToListings` refuses (`channelActions.ts:342–344`), because wave-1 channel verbs are
preview-only.

**Fill across markets.** A per-row `⇥` (the old cube's affordance) is **not** re-created in the
pane. Per column, a `Fill from <this scope>` control in the header runs the registry's
`broadcast-to-listings` with the pane's own coordinate as source and the pane's selected market
rows as targets — one verb, one preflight, one confirm, one audit row. Fill is a SELECTION verb
that happens to be pressed from the drawer, not a pane feature.

**Repaints.** The write's result carries `versionOf` + `currentVersion`
(`useChannelSheet.ts:281–286`), so: the pane's own row re-renders from the returned version; the
sheet's `Markets` cell for that row repaints from the recomputed difference count; if the edited
coordinate IS the open scope, the sheet cell itself repaints through the normal writer path. **No
full reload** — the reload-on-write mistake `sheetWriter.ts:75–83` documents.

**Keyboard.** ⌘↑/⌘↓ still step records with the pane open. Arrows inside the pane's table move its
own cell focus (it is a plain table, so this is ours to define); Esc closes the editor, second Esc
closes the dock. No popup editors in the pane, so none of AG's Enter/Tab/Esc ownership applies.

### 6.4 Per-scope rules

- **master scope.** The pane still opens and still lists every coordinate — this is the one place
  the master scope gains a market answer, and it replaces the current apology. All value columns
  are **read-only** there: master has no coordinate to write from, and a "copy from master" is the
  `broadcast` verb with master as source, which needs its own preflight.
- **channel scope.** The open coordinate is pinned first and editable; siblings editable subject
  to 6.3's confirm rules. Rows for *other channels* are shown but read-only and dimmed, with the
  reason: cross-channel copy is `CrossChannelMatrix`'s job and a different decision (D1, undecided).
- **alias band row.** No pane — an alias band is a group header, not a record
  (`channelActions.ts:376`).
- **single-store channels (Shopify / Etsy / Woo).** Exactly one coordinate, so the pane shows one
  row and says so: *"Shopify has one store, so there is nothing to compare across."* **And their
  cells are read-only for a measured reason**: `marketplaceContexts[].channel` is typed
  `'AMAZON' | 'EBAY'` on the write endpoint (`products.routes.ts:1044`), so a Shopify context
  cannot be expressed at all (`studio-sheet.service.ts:520–524`).
- **market channels (Amazon / eBay).** Full behaviour. **Amazon EU quantity is SHARED across EU
  marketplaces** and **FBA quantity is Amazon-managed** — the quantity column renders read-only
  with the 🔒 the old cube already had (`VariantCube.tsx:56–66`), sourced from
  `platformAttributes.fulfillmentChannel` (`product-channel-data.routes.ts:23–28`), never inferred.

### 6.5 Provenance / autosave / readiness / publish

- **Provenance.** Each pane cell carries the same `ProvenanceChip` the drawer already renders
  (`drawer/fields/ProvenanceChip.tsx`), from the same `layer` the sheet read resolves — 🔗
  inherited · ✎ pinned · ⚠ · ✦ AI draft. The `follows` map is already on `SheetListing`
  (`studio-sheet.service.ts:1294`), so "this market follows master" is a fact we have, not one the
  pane derives. **Writing a price or quantity flips `followMasterPrice`/`Quantity`** — defect 3 —
  so the pane must say so *before* the write, in the cell's own note: *"this market currently
  follows master; changing it here pins it."*
- **Autosave.** One `SheetWriter` instance per pane, `rowId` = `${channel}:${market}:${aliasKey}`,
  `commit` mapping to one `PATCH /api/products/bulk` per coordinate with a **single-element**
  `marketplaceContexts` and that listing's `version` as `expectedVersion`. The writer class is
  shared substrate; a second *instance* is not a second write path. The 40ms flush window
  (`sheetWriter.ts:163`) coalesces a fill.
- **`marketplaceContexts` is a FAN-OUT, not a per-context payload** (`products.routes.ts:1038–
  1042`, `:1170–1181`): the same change lands on every listed coordinate. So per-cell edits are
  one context each; only *broadcast* uses the multi-context form. Stating this is the difference
  between a working pane and a pane that writes one market's value onto four.
- **Readiness.** The pane shows each coordinate's readiness pill from `readinessMeta()` — the one
  tone/label source (layout §3). It does **not** fetch readiness per market: that is one request
  per market (`product-studio.routes.ts:212`) and 12s of them. The pill on a non-open coordinate
  reads from what `studio/listings` returns; if the server does not compute it there, the pane
  shows **no pill** rather than a guessed one.
- **Publish.** No publish control in the pane, on `ListingsPane.tsx:5–9`'s reasoning: *"a 'Publish'
  button inside a record drawer is exactly how a preview-only channel gets published by reflex."*
  Each row link-outs to the live listing via `listingUrl()` and hands off to `Publish ▾`.

### 6.6 Mockup + the widths budget

Usable width = dock − pane padding = **520 − 2×14 = 492px** (min 380 → 352 · max 720 → 692;
`components.css:555`, `drawer.module.css:45–51`, `layout-v2-spec.md:801–802`).
Fixed: coordinate 104 · state pill 60 · gutter 8 → **172px**. Value column **78px** (ComparePane
measured ~70px/target as already tight at this width, `ComparePane.tsx:21`).
**Budget rule, derived not fixed: `maxFields = floor((usable − 172) / 78)` → 4 at 520 · 2 at 380 ·
6 at 720.** The `MultiSelect` caps at that number and says why; the table never scrolls
horizontally inside the dock.

```
┌ Record · GALE-JACKET-NERO-L ────────────────────── ⤢ ✕ ┐
│ Record | History | Compare | Markets (5)               │
├────────────────────────────────────────────────────────┤
│ Fields ▾ [Price ×][Qty ×][Title ×][Status ×]  4 of 4   │
│ ─────────────────────────────────────────────────────  │
│ COORDINATE     PRICE    QTY    TITLE       STATE       │
│ ▸ AM·IT (this) 149.00✎   12   Giacca…🔗    ● live      │
│   AM·DE        149.00🔗   12   Jacke…✎     ● live      │
│   AM·FR         —         —    —           ○ no listing│
│   AM·ES        139.00✎    0🔒  Chaqueta…🔗 ⚠ errors 2  │
│   EB·IT        155.00✎    9   Giacca…✎     ● live      │
│ ─────────────────────────────────────────────────────  │
│ Price: 3 of 5 markets differ from AM·IT                │
│ [Fill Price from AM·IT →]  (runs Broadcast, confirms)  │
│ 🔒 FBA quantity is Amazon-managed · EU quantity shared │
└────────────────────────────────────────────────────────┘
```

Family bar (H5), unchanged geometry, one verb added:

```
Parent · 20 variations · Colore × Taglia   [Variation theme & axes…] [Add variation] [Promote…] …
```

## 7. Contracts and data

**Reused as-is.** `PATCH /api/products/bulk` (writer + fan-out) · `GET /api/pim/family/:id` ·
`PATCH /api/catalog/products/:id/variant-attributes` · the `familyOps` seven · `SheetListing` and
`RecordWriteRequest{scope}` types · `broadcast-to-listings`'s whole declaration.

**New server work — PES.5, all additive, no schema change.**

1. **`GET /api/products/:id/studio/listings`** → `{ coordinates: Array<{channel, marketplace,
   aliasKey, locale, label, listing: SheetListing, values: Record<key, StudioCellValue>}> }`,
   built by calling the SAME `SheetListing`/cell builder `studio-sheet.service.ts:1277–1296`
   already uses, across coordinates, for ONE product id. Bounded by a `fields=` query param so
   the pane asks for the 4–6 it shows. **One request. Do NOT reuse `all-listings`** — it returns
   raw `ChannelListing` rows, which would put a client-side mirror of a server type on the wire
   (`reference_wire_parse_boundary_rules`) and omits `overrideData`, so the resolved value would
   differ from the sheet's. Same argument `useCompare.ts:11–14` makes for reusing the sheet read.
2. **Extend `CHANNEL_FIELD_MAP`** (`channel-field-map.ts:22`) with
   `{amazon,ebay}_{price,salePrice,quantity}` → `price`/`salePrice`/`quantity`, and add
   `price → followMasterPrice`, `quantity → followMasterQuantity` to `FOLLOW_FLAG_FOR_COLUMN`
   (`:44`) so an override the resolver would skip cannot be written. Mirror in
   `CHANNEL_WRITABLE` (`studio-sheet.service.ts:462`). **This is the load-bearing change**: without
   it "per-market price through the same writer" is false, and the alternative — routing the pane
   through `PATCH /channel-pricing` — is a second write path with no CAS, no alias key and a
   fabricated `ok:true` (defects 1–4).
3. **`PATCH /api/pim/family/:productId/variation`** → `{variationTheme?, variationAxes?}` on an
   **existing** parent, with a preflight that reports how many children would be left carrying an
   axis the family no longer declares. Today only `promote-to-parent` can set these.
4. `broadcast-to-listings`' server half: nothing new — it is the fan-out, already there.
5. Optional, for the `Markets` column: a `differsOn: string[]` per row on the sheet read, or leave
   the column to the same `studio/listings` call and accept one extra request per sheet load.
   **Recommend the latter** — it keeps the count and the pane consistent by construction.

**Lane ownership.** PES.5 — items 1–3, 5. PES.4 — the pane (extend `ListingsPane` → `Markets`,
its `SheetWriter` instance, the field picker). PES.3 — the `Markets` status column, wiring
`siblingMarkets`/`pickMarkets`, `broadcast-to-listings`' live run. PES.2 — the family-bar verb +
dialog, and re-routing axis-column writes to `variant-attributes`. PES.6 — nothing (mapping is
global). PES.1 — nothing (the market switcher already exists and stays as-is).

## 8. Risks and traps

1. **Local dev writes PRODUCTION and every eBay listing in the fixture family is LIVE.** The pane
   is a surface whose whole purpose is writing to markets the operator is *not* looking at — the
   highest-blast-radius control in the studio. It must land with the alias-live refusal already in
   `broadcastToListings` (`channelActions.ts:342`) in place from day one, not added after.
2. **`marketplaceContexts` fan-out with the wrong values.** One change → N coordinates. A pane that
   batches four cells across four markets into one PATCH with four contexts would write market IT's
   price to DE/FR/ES. **One context per commit; the multi-context form only inside the confirmed
   broadcast verb.**
3. **The cron can undo the operator.** `POST /api/amazon/pim/repair-parentage` and the
   catalog-refresh job write `isParent`, `variationTheme` and child axis names from SP-API
   (`amazon.routes.ts:335–338`, `:647`, `:739`, `catalog-refresh.job.ts:64,76,139`). An operator's
   theme edit can be overwritten by the next refresh with no notice. **HYPOTHESIS** as to
   frequency; the write sites are CODE-READ. The theme dialog must say what will re-derive it.
4. **The data the axis grid needs does not exist** (Owner item 46, #718/#721): 227 of 228 ACTIVE
   Amazon child listings carry no theme; GALE-JACKET's 20 children carry no axis values. A
   by-market pane built on this fixture will look *correct and empty*, and an empty axis column is
   indistinguishable from a failed read. Ship the "0 of 20 carry it" sentence with the column.
5. **`Product.version` is not a row version** — it is a CAS token only the single-product editor
   maintains, with 124 other writers ignoring it (`products.routes.ts:1099–1118`). The pane must
   CAS on the **listing's** version, and never mix the two: they differ on 89% of listings.
6. **Amazon EU quantity is shared** and **FBA quantity is untouchable**; **images are global per
   ASIN**. The quantity column is read-only wherever fulfilment says FBA, from the stored value,
   never inferred from the market.
7. **Per-channel oversell.** The pane can set qty per market; availability is per channel, not
   summed. It must not present a "total across markets" figure of any kind.
8. **Untouchables.** Nothing here touches the flat-file editors, FBA quantity logic or the import
   flows. `catalog.routes.ts`' variant-attributes endpoint is a catalogue route, not an import one.
9. **AI stays dark** (#13). The pane shows ✦ drafts as provenance and offers no generation.
10. **Currency.** The old cross-channel copy skipped currency-mismatch price targets
    (`CrossChannelMatrix.tsx:9–11`); the studio has **no currency on a channel scope at all**
    (parity 3.12n). A price broadcast from IT (EUR) to UK (GBP) must be refused in the preflight,
    not converted.
11. **`?market=` not `?marketplace=`** — the mismatch that made ComparePane print a confident wrong
    sentence for its entire life (`useCompare.ts:47–58`). Any new coordinate-scoped read inherits
    this trap.
12. **A 5-tab drawer at 380px.** The min dock width is 380; four tabs already sit there. Renaming
    rather than adding is partly a width decision.

## 9. Open questions for the Owner (3)

1. **Does the by-market answer live in the drawer only, or also as a sheet view?**
   *Recommend: drawer only (option **a**), plus the `Markets` status column and the broadcast verb.*
   Option (b) contradicts your own MS decision ("one sheet per market with a switcher"), and it
   breaks mechanically — AG's `marryChildren` draws a group header twice whenever a child is
   pinned, and the studio's identity block is always pinned. The pane is (c)'s useful half without
   (c)'s cost.
2. **May `PATCH /api/products/bulk` learn per-market price and quantity?**
   *Recommend: yes — six entries in `CHANNEL_FIELD_MAP`, two follow-flags, no schema change.*
   Without it there is no honest "per-market price through one writer", and the fallback
   (`PATCH /channel-pricing`) has a writer that reports success it did not have, cannot address an
   alias, and has no CAS. This change also gives the channel *sheet* a real per-market price cell,
   which is worth more than the pane.
3. **Who may edit a family's variation theme and axes, and what happens to children that no longer
   match?** *Recommend: `pim.manage` (as every other family verb bar unlink), a type-to-confirm
   preflight naming how many children carry an axis the family would stop declaring, and children
   left untouched — a value that survives is reversible, a cleared one is not (the same reasoning
   that makes unlink reversible today, `familyOps.ts:20–24`).*

## 10. Effort and dependencies

| piece | lane | effort | depends on |
|---|---|---|---|
| `GET /studio/listings` (reusing the SheetListing builder) | PES.5 | **M** | — |
| `CHANNEL_FIELD_MAP` + follow-flags for price/salePrice/quantity | PES.5 | **S** | Owner Q2 |
| `PATCH /pim/family/:id/variation` + preflight | PES.5 | **S** | Owner Q3 |
| `Markets` pane (extend `ListingsPane`, `DataGrid`, field picker, writer instance) | PES.4 | **L** | studio/listings; the drawer's `onWrite{scope}` (exists) |
| `Markets` status column + tooltip | PES.3 | **S** | studio/listings |
| wire `siblingMarkets`/`pickMarkets`, make `broadcast-to-listings` run | PES.3 | **M** | fan-out (exists); Owner D1 for anything beyond preview |
| family-bar `Variation theme & axes…` verb + dialog | PES.2 | **M** | Q3 endpoint |
| axis columns route to `variant-attributes` | PES.2 | **S** | — |

**Cross-feature dependencies.** Shares the confirm/preflight substrate with every channel verb
(D1, undecided — the pane's *reads* and single-cell writes do not wait on it; broadcast does).
Shares `useCompare`'s N-coordinate read pattern, which `studio/listings` should retire for the
multi-field case. Blocked in *usefulness*, not in build, on Owner item 46: the axis grid half of
this feature has almost no data to draw until the catalogue's variation axes are backfilled.
