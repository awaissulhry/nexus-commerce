# Variants page — build spec (Owner-approved 2026-09-11)

**Status:** APPROVED by the Owner on 2026-09-11 ("I really like the design that we've now created … let's build it").
**Canvas (the visual contract):** https://claude.ai/code/artifact/438612eb-cada-442e-8f47-b4b93b0762f2 — four artboards:
`Variants · shared product`, `Variants · eBay projection + mapping`, `Product navigation`, `Generate combinations`.
**Programme:** Product Edit Studio (PES). This page replaces the old `tab=variants` workspace. Everything below
inherits `docs/2026-09-01-product-edit-studio-layout.md` (§1b, §2.10 build-from-scratch, §5 protocol) and the CH.1
sheet-chrome rules. **The Owner manages the sessions (ledger #794). Nothing is committed until the Owner says so.**

Five lanes, VP.1–VP.5 (§8). Prompts: `docs/vp-prompts.md`. Claims + reports: `docs/pes-claims.md`.

---

## §1 What was decided (and why)

1. **ONE Variants page, under Information in THIS PRODUCT.** Family STRUCTURE (axes · which children · each
   child's axis values) is defined once, on the shared product. Each channel's PROJECTION (theme/specifics
   mapping, per-variant inclusion, listing split, pinned values) is the SAME page re-projected by the scope bar.
   This is the studio's founding rule ("one grid re-projected per scope") applied to variations.
2. **No per-channel "Variants & relationships" item in the sub-sidebar.** A channel's projection = its scope chip
   + the Variants item. Reason: layout doc D9 — a second way to reach a thing the page already is makes the
   page bigger, not more capable.
3. **Relationships becomes its own nav item** (bundles, kits, linked products). It is NOT designed. VP.1 mounts the
   studio's standard placeholder for it (a placeholder that states what it is and what it needs — never an empty
   box). **Deviation from the canvas, default kept unless the Owner rules otherwise:** Shopify's `Product family`
   item STAYS under the Shopify group until Relationships is designed — deleting a capability with no
   replacement fails the parity rule.
4. **Owner override, 2026-09-12: restore eBay `Variation order` as the third channel task**, after Listing
   information and Description themes. Reuse `PresentationTab mode="order"` and its existing alias-scoped
   axis/value order, inheritance and publication-review controls. This supersedes the original instruction
   to remove the navigation entry and fold ordering into the mapping dock.
5. **The Variants toolbar has no views trigger** (fixed column set). Built on `SheetToolbar`, it declares
   `absent: [{ control: 'views', reason: 'This page has a fixed column set: product, axes and channel projections.' }]`.
6. **Three new DS pieces** (VP.5): `AxisChip`, `MappingChip`, `ProjectionCell`. Everything else is an existing
   primitive at its measured size. Nothing page-local that the DS could own (feedback_design_system).
7. **Rows are variants; the page is "Variants".** Copy uses `variant`/`variants` for rows, `axis`/`axes` for the
   distinguishing attributes, `combination` for an axis-value tuple, `projection` only in code (operators see
   "eBay · IT" and "mapping"). The parent row is "Parent".

## §2 Chrome — unchanged, and measured (1440×900, live studio 2026-09-11)

| band | height | source of truth |
|---|---|---|
| top bar (dark chrome) | 56 | `app/_shared/app-topbar.css`, `tokens/chrome.ts` |
| workspace subheader: 48px toggle column + `DetailHeader dense` | 49 (48 + 1 rule) | `patterns.css` `.nds-workspace-subheader`, `.nds-detailhdr.dense` |
| scope bar (`ScopeBar`, mergedRow) | 40 | `StudioBar.tsx`, `--nds-toolbar-h` |
| **page band (new: family band / mapping band)** | **40** | this spec §3/§4 — same class of band as the scope bar: `--nds-toolbar-h`, 16px side padding, 12px gap, eyebrow `.nds-scopebar-label` style |
| sheet toolbar (`SheetToolbar` → `GridToolbar` inside `.nds-grid-sheet`) | 40 | `sheet/SheetToolbar.tsx`; padding is 0 **6px** (measured), not 16 |
| AG column-group strip | 30 | `--nds-grid-strip-h`, `.ag-header-group-cell` |
| AG header | 28 (+1 rule) | `gridDensity.compact.header` |
| rows (`rows="media-line"`) | 36 | `gridDensity.compact.rowMediaLine` — 🔴 never 28 (see tokens/grid.ts) |
| footer strip | 36 | `.nds-grid-sheet-status` |
| secondary navigation drawer | 224 wide | `--nds-secondary-nav-w` |
| record/mapping dock | 420 wide, in-flow flex sibling | `drawer/StudioDock.tsx` pattern (`--studio-dock-w` on the track) |

Every control in a band is on the `sm` tier (28px): `.nds-btn.sm`, `.nds-fchip.md`, `.nds-listbox-btn` sm,
`.nds-scope`, `.nds-tbtn`. The census gate (`scripts/check-control-census.mjs`) enforces it; VP.5 extends the
gate to the variants surfaces.

## §3 Shared-product state (`scope=master&tab=variants`) — canvas artboard 1

### §3.1 Family band (40px)
`AXES` eyebrow · `AxisChip` per axis in order (grip 13px `--nds-text-3` · label 12.5/600 · count `Tag neutral`
"2 values") · `×` between chips (12.5px `--nds-text-3`) · `+ Add axis` (`Button ghost sm`, plus 13px) ·
1×20px divider `--nds-border-subtle` · coverage sentence 12.5 `--nds-text-2` with bold numbers:
`**20** of 20 combinations exist · **0** missing` · right: `Generate combinations` (`Button sm`) ·
`Add variant ▾` (`Button primary sm`, chevron 14px white; the ONE primary on the page).
- Axis chip click → the existing `Manage shared axes` DS Modal (rename/reorder/remove; `OrderedList`); drag
  reorders inline; `+ Add axis` opens the same modal with the add field focused. Axes = `Product.variationAxes`
  (attribute keys); values = the children's attribute values for those keys (what `variantCoverage` reads).
- `Add variant ▾` menu items: `Add a child…` (existing `AddVariationDialog` via `familyActions`), `Generate
  combinations…`, `Attach existing…` (existing verb). Nothing new is invented for these verbs.
- Coverage counts derive from axis VALUES actually present on children (Cartesian product of distinct values
  per axis vs existing tuples). `missing` and `duplicates` are the two chip counts in the toolbar.

### §3.2 Toolbar (40px, `SheetToolbar`)
count: `**21** rows · 1 parent · 20 variants` · `Find a SKU or a name…` (Input xs in a 340px slot) · grow ·
chips (`FilterChip md`): `Excluded somewhere N` · `Missing axis values N` · `Duplicate combinations N` ·
`Customise` · `Export` · `Import` · `⋯` (family verbs from `useFamilyVerbs()` first, separator, `Reload`).
Views trigger ABSENT with the §1.5 reason. Chip semantics: single, URL-backed (`?chip=`), like the sheet.

### §3.3 Grid (`NexusGrid` in `GridSheet`, `rows="media-line"`, AG column groups → the 30px strip)
Strip groups: `PRODUCT` (select 43 + identity 380) · `AXES` (140 per axis) · `CHANNEL PROJECTIONS` (one column per
connected channel × market the family is read at; unconnected channels still get a column so the absence is
visible — "Not set up", muted).
- Identity = the DS `IdentityBand` exactly as the sheet uses it: role chip (`IdentityChip` P accent / C neutral),
  32px thumb, SKU mono 11/600, secondary line = axis values joined with ` · ` ("Nero · XXS"), trailing =
  `CompletenessPill` + row `⋯` (28px). Rows ordered parent first, then by axis-value order (axis 1 values in
  their defined order, then axis 2 …) — NOT alphabetical SKU.
- Axis cells: editable select (the sheet's editor for that attribute), chevron 13px; parent row shows `—`.
- Projection cell (`ProjectionCell`, VP.5): `[checkbox 15px] [7px status dot] word` + optional mono detail
  right-aligned. States and tones come from `readinessMeta(state, 'row')` — never a local colour map:
  `Listed` (success dot) · `Draft` (hollow neutral dot) · `Excluded` (no dot, muted) · `Not set up` (disabled
  checkbox, muted) · `Needs a value` (danger dot). Checkbox = included on that coordinate; toggling writes
  through VP.2's include endpoint (§5.4); fill-down works (AG fill handle — see reference_ag_fill_handle).
  Parent row shows the channel parent identity (ASIN / ItemID / product id, mono) + a muted note.
- Footer: `21 rows · 20 variants`. Help `?` at right as today.

### §3.4 Generate combinations (DS `Modal md`, canvas artboard 4)
Title `Generate combinations` · sub `GALE-JACKET · Colore × Taglia · every combination that does not exist yet
becomes a variant` · per axis: `Field` label + hint (`3 values · Rosso is new and is added only when you create ·
type a value and press Enter to add another`), value tags (existing = `Tag neutral`, new = `FilterChip`-tinted
tag with plus glyph), inline `Add a value…` placeholder · `SKU pattern` mono Input with tokens `{parent}`,
`{<axis>.code}`, `{<axis>}` and a live preview line `Codes: Nero → BLACK … first new SKU GALE-JACKET-RED-MEN-XXS ·
title, price and stock copy from the nearest sibling` · summary box `**3 × 10 = 30** combinations · 20 exist ·
**10 will be created** as drafts, excluded from every channel until you include them` · footer `Cancel` /
`Create 10 variants` (primary). Flow: dry-run first (§5.3) → the summary is the dry-run's answer → create.
Created children are full `Product` rows (children are full records), status DRAFT, no channel rows.

## §4 Channel projection state (`scope=EBAY&market=IT&tab=variants`) — canvas artboard 2

### §4.1 Mapping band (40px)
`MAPPING` eyebrow · `MappingChip` per axis in projection order (`Colore → Colore`: from 12.5/500 `--nds-text-2`,
arrow 12px `--nds-text-3`, to 12.5/600) · `Tag neutral` `2 of 5 specifics` (the channel's own noun: eBay
"specifics", Amazon "theme", Shopify "options", Etsy "properties") · divider · sentence `One listing · **19** of 20
variants included · 20 of 250 allowed` · right: `Edit mapping` (`Button sm`).
Scope-bar right slot unchanged (account + market listboxes, from `StudioBar`).

### §4.2 Toolbar
count `**21** rows · 19 included` · Find (240px slot when the dock is open, 340 otherwise) · chips `Excluded N` ·
`Pinned values N` · `Mapping errors N` · Customise · Export · Import · ⋯ (`Preflight`, `+ Add listing alias`,
separator, `Reload` — the CH.1 channel verbs).

### §4.3 Grid
Strip: `PRODUCT` · `EBAY · IT`. Columns: identity 380 · `Included` 90 (checkbox) · one column per mapped axis
(150/130) · `Listing` fill. NO shared-axes group: the identity secondary line already carries the shared values.
- Mapped-value cell = the sheet's `CascadeCell` vocabulary: value + chevron + `SourceIndicator` (link glyph
  `--nds-text-3` = inherits the shared value; pin glyph `--nds-text-link` + 7% primary tint `.nds-cell-is-pinned`
  = pinned for this channel). Hover names the source; one click pins, one click resets (layout doc §1).
  Pinned writes go through the EXISTING channel write path (`resolveWriteRouting`, `marketplaceContexts`) — no
  new write path for values.
- `Listing` cell: `● Listed` / `Excluded` (muted) / `Draft` / `Needs a value`; parent row `● Listed · 1 listing`.
- Excluded rows render their mapped values muted; the checkbox is the only live control on them.

### §4.4 Mapping dock (420px, docked like `StudioDock`; opens on `Edit mapping`; explicit Save, not autosave)
Header: title `eBay · IT mapping` 15/700 · sub `GALE-JACKET · 20 variants · 1 listing · <account>` 12 muted ·
close 28px. Body (16/18 padding, 18px section gap):
1. **Variation specifics** — hint `Each shared axis becomes one eBay specific. Drag to set the order buyers pick
   in. eBay allows up to 5.` · rows: grip · axis name (92px) · arrow · `Listbox sm` (grow) of the channel's
   target options · `+ Add a specific` ghost · `Tag` `2 of 5 used`.
2. **Values** — hint `Specific values follow the shared axis values. Pin a different value on a variant in the
   grid.` · one mini-table per axis whose values can differ: header `<Axis> value / On <channel> / Included`,
   rows `Nero / Nero / 9`, `Giallo / Giallo · 1 pinned / 10` · one-line note for axes that are identical
   (`Taglia · 10 values · same as shared · 19 included`). Counts are INCLUDED variants only.
3. **Listing split** — hint `How this family lands on eBay. Limits: 250 variations, 5 specifics per listing.` ·
   radios `One listing — 19 of 250 variations` (selected) · `One listing per <axis> — 2 listings · 9 + 10`.
   🔴 Split = `ProductListingAlias` rows. Alias creation is INERT until PES.5-ii lands (`createAlias` → 409).
   Render the option, hold it (`aria-disabled` + the reason in the tooltip, never a silent disable) until VP.2
   confirms creation works on prod.
4. **Lock banner** (`Banner warning`, lock icon) — `Specifics lock once the listing is live` / `Item <id> is live
   with Colore and Taglia. Adding or removing a specific relists it; reordering and adding values do not.` Shown
   only when the coordinate has a live listing; the locked axes' listboxes are disabled with the same reason.
Footer: `Cancel` · `Save mapping` (primary). Save = one PATCH (§5.4) with `expectedVersion`; 409 → repaint +
refetch, exactly like the sheet. Unsaved changes arm the studio's navigation guard.

### §4.5 Per-channel vocabulary and limits (the reason the projection layer exists)
| channel | axes per listing | variants per listing | target options come from |
|---|---|---|---|
| Amazon | theme from the product type (usually 1–3 axes; a fixed enum) | thousands | the PT schema's variation theme enum (field-catalogue / schema-caps) |
| eBay | up to 5 specifics | 250 | category aspects (existing eBay aspect services) |
| Shopify | up to 3 options | 100 (2048 on the new API) | free names |
| Etsy | up to 2 properties | 70 combinations | Etsy property list |
VP.2 exposes `limits` and `targetOptions` per coordinate; the UI never hardcodes a number.

## §5 Data contracts — PROPOSED here, FINAL in `docs/vp2-contracts.md` (VP.2 writes it in its first phase)
Storage is what exists; nothing new unless measured necessary (additive migrations are pre-approved):
- axes → `Product.variationAxes` (`family-variation-axes.ts` reads/writes; keep using it)
- child axis values → the child's attribute bag for those keys (what the sheet's `axis: true` columns edit)
- projection mapping → the PARENT's `ChannelListing.variationTheme` + `variationMapping` on that coordinate.
  🔴 `amazon-mapper.service.ts:112–180` READS `variationMapping` on the Amazon publish path, and
  `listing-wizard/*`, `listing-snapshot.service.ts`, `flat-file/registry/channel-fields.ts` (flat-file:
  untouchable) touch these columns. VP.2 keeps the stored shape those readers expect, or extends it
  additively and proves every reader still resolves — measured, in the ledger.
- inclusion → presence + status of the child's `ChannelListing` row on (channel, marketplace, account, alias)
- split → `ProductListingAlias` (held until PES.5-ii; see §4.4.3)
- pinned values → the existing per-channel override cascade (no new store)

### §5.1 `GET /api/products/:id/studio/family?market=IT`
```
{ version, family: { parentId, parentSku, role },
  axes: [{ key, label, values: [{ code, label, count }] }],           // in stored order
  children: [{ id, sku, name, image, axisValues: {[key]: code}, readiness: { pct, state },
               projections: { "EBAY:IT": { included, state, externalId } , ... } }],
  parent:   { id, sku, name, image, readiness, projections: { "EBAY:IT": { externalId, listings } } },
  coverage: { combinations, existing, missing: [[code...]], duplicates: [[sku...]] },
  channels: [{ channel, market, connected, label }] }
```
### §5.2 axes: keep `GET/PATCH /products/:id/studio/variation-axes` (exists).
### §5.3 `POST /api/products/:id/studio/family/generate` body `{ version, axisValues: {[key]: [code]},
skuPattern, copyFrom: 'nearest-sibling', dryRun }` → `{ plan: [{ sku, axisValues, copiesFrom }], skipped: [...] }`
when `dryRun`, else `{ created: [{ id, sku }], version }`. Refuses a SKU collision by name, never renames.
### §5.4 `GET/PATCH /api/products/:id/studio/projection?channel=EBAY&market=IT&accountId=&aliasKey=`
```
GET → { version, coordinate, vocabulary: { axisNoun: 'specific', limits: { axes: 5, variants: 250 } },
        mapping: [{ axisKey, target, order }], targetOptions: [{ code, label }],
        split: { mode: 'single' | 'per-axis', axisKey?, listings: [{ aliasKey, label, count }], creatable: boolean, heldReason? },
        locked: null | { reason, lockedAxisKeys: [] },
        children: [{ id, included, values: {[axisKey]: { value, source: 'inherited' | 'pinned' }}, listing: { state, externalId } }] }
PATCH body { expectedVersion, mapping?, split? } → { version } | 409 { current }
PATCH /studio/projection/children body { expectedVersion, changes: [{ id, included }] } → { version, results }
```
🔴 **Include/exclude is a LOCAL-RECORD write.** VP.2 proves before shipping that setting a child's row to the
included/excluded state triggers NO push, NO cron pickup and NO feed (grep every consumer of the status it
writes; list them in the ledger). Local dev hits PROD (reference_local_dev_hits_prod_api); DRAFT rows are live
records (reference_ebay_draft_still_live). Rehearse on the XAVIA family only.

## §6 What is DELETED (VP.1) — exact blast radius, measured 2026-09-11
Old page: `apps/web/src/app/products/[id]/edit/_studio/variants/{AliasManager,VariantSummary,VariantsWorkspace}.tsx`,
`columns.ts`, `coverage.ts` (fold its tuple logic into the new family module or VP.2 — do not lose it),
`variants.module.css`, `variants.vitest.test.ts`.
References to unpick: `StudioTabHost.tsx` (19, 31–32, 51–54), `StudioSubheader.tsx` (28, 34–35 channel task
lists), `navigation.tsx` (8–9, 13, 15), `scopes.ts` (221 `visibleTabs`), `types.ts` (38, 57 tab ids),
`SaveIndicator.tsx` (41–42 manual-save message), `images/types.ts` (137, 204), `navigationHref.vitest.test.ts`
(39, 41), `scopes.vitest.test.ts` (215–246), the `workspace` prop threaded through `MasterSheet.tsx`
(108–113, 1749), `ChannelSheet.tsx` (142–173, 1113, 2076–2078) and `ChannelScopeTab.tsx` (27, 53).
`PresentationTab.tsx:26` (`VariationOrderTab`) is removed only after VP.4's §1.4 verdict. Sheet files belong to
PES.2/PES.3 — VP.1 claims the SURGICAL removal of the `workspace` prop in the ledger before touching them and
checks for live claims first.

## §7 Verification (every lane) — measured, on screen, on the XAVIA family only
- Fixture family: GALE-JACKET `cmokmy3a40078pm0p1fvnu523` (Colore × Taglia, 20 children); MISANO / AIREON / XRI01
  for a second shape. eBay·IT account `cmr4aaqb00025nz016k18rup9`. Never another product.
- Before any write: state which API :3000 talks to (`NEXT_PUBLIC_API_URL`; a local API on :8091 may or may not
  be running — check `lsof -ti :8091`). A write on prod is real; announce the fixture in the ledger BEFORE it.
- Gates: `npx tsc --noEmit -p apps/web/tsconfig.json`, api tsc, vitest for touched modules,
  `node scripts/check-ag-grid-import-boundary.mjs`, `node scripts/check-control-census.mjs` (VP.5 adds the
  variants surfaces), `node scripts/check-layout-v2.mjs` (VP.5 adds the variants band budget), the raw-primitive
  ratchet (pre-push). Run a gate BARE to read its exit code (never through `| tail`).
- Screen parity against the canvas: band heights §2, control heights 28, row 36, identity 380, strip 30; the
  copy in §3/§4 verbatim. Report numbers, not adjectives. A claim must match its measurement.
- Definition of DONE for a lane (say "100% done" only then): every item in its §8 row measured green, all gates
  green on one clean run, zero console errors on the four canvas states, its ledger section holds the numbers,
  nothing committed, nothing outside its owned paths edited without a ledger claim.

## §8 Lanes and ownership (claim in `docs/pes-claims.md` before editing; never edit another lane's paths)
| lane | mandate | owns | first deliverable |
|---|---|---|---|
| **VP.1** frame + removal | nav IA (§1.2/§1.3), tab host switch for `variants` → VP.3 (master) / VP.4 (channel), Relationships placeholder, delete §6, URL contract unchanged | `_studio/{StudioTabHost,StudioSubheader,navigation,scopes,types,navigationHref,SaveIndicator}.tsx/.ts`, `_studio/variants/VariantsTab.tsx` (the switch only), `_studio/relationships/`, the §6 removals | nav + switch + placeholders on screen; §6 removed; tests green |
| **VP.2** backend | §5 contracts, `docs/vp2-contracts.md`, family read, generate, projection read/write, include/exclude, limits + target options per channel, the no-push-path proof | `apps/api/src/services/pim/family-projection*.ts` (new), `family-variation-axes.ts`, `routes/product-studio.routes.ts` (additions only), any additive migration | `docs/vp2-contracts.md` with FINAL shapes within the first phase, so VP.3/VP.4 code against it |
| **VP.3** shared-product surface | §3 entire | `_studio/variants/family/**` | family band + grid on GALE-JACKET with fixtures, then live on VP.2 |
| **VP.4** channel projection surface | §4 entire, the `Variation order` verdict | `_studio/variants/channel/**` | mapping band + grid + dock on eBay·IT with fixtures, then live |
| **VP.5** DS + conformance | `AxisChip`, `MappingChip`, `ProjectionCell` in the DS; census + layout gates extended to the variants surfaces; the end-of-wave measurement of all four states vs the canvas | `apps/web/src/design-system/**` (additions), `scripts/check-control-census.mjs`, `scripts/check-layout-v2.mjs`, `.claude/DS-GAPS.md` | the three pieces exported, with stories/tests, in the first phase |
Until VP.2's contracts are final, VP.3/VP.4 build against typed fixtures shaped by §5 and switch without a
redesign. Until VP.5's pieces export, VP.3/VP.4 use a local stub with the SAME props and replace it — never a
second implementation. Cross-lane needs are ledger requests to the owning lane; the Owner decides conflicts.

## §9 Copy table (verbatim; one source for every lane)
Nav: `Information` · `Variants` · `Relationships` · `Media` · `Needs attention` · `Performance` · `Activity`;
channel groups: `Listing information` (+ eBay `Description themes` · `Variation order`, Owner override §1.4;
Shopify `Product family` kept, §1.3).
Family band: `AXES` · `Add axis` · `<n> of <m> combinations exist · <k> missing` · `Generate combinations` ·
`Add variant`. Toolbar chips (master): `Excluded somewhere` · `Missing axis values` · `Duplicate combinations`.
Toolbar chips (channel): `Excluded` · `Pinned values` · `Mapping errors`. Absent views reason: §1.5.
Mapping band: `MAPPING` · `<n> of <limit> <axisNoun>s` · `One listing · <n> of <m> variants included · <m> of
<limit> allowed` · `Edit mapping`. Projection words: `Listed` · `Draft` · `Excluded` · `Not set up` · `Needs a
value`. Dock: `<Channel> · <Market> mapping` · `Variation specifics` (Amazon: `Variation theme`; Shopify:
`Options`; Etsy: `Properties`) · `Values` · `Listing split` · `Save mapping`. Placeholder (Relationships):
`Relationships — bundles, kits and linked products. Designed after Variants ships; Shopify linked products stay
under Shopify until then.`
