# /products/next — Ad-Manager parity rebuild (design)

Date: 2026-06-28
Status: In progress (Phase 1 built, pending visual verification)
Surface: `http://localhost:3000/products/next`
Gold standard / reference: `/marketing/ads/campaigns`

## Goal

Rebuild `/products/next` to **pixel-identical visual consistency** with the
`/marketing/ads/campaigns` page (the most-polished surface on the platform —
corners, colours, spacing, the dropdowns that open up), built entirely from the
**design system** (`apps/web/src/design-system`). The current `/products/next`
already has good grid work (variation expansion, density-aware thumbnails) that
we **keep as-is**.

## Lesson from the revert (2026-06-28 night)

Adopting `AdsDataGrid` wholesale (commits `15ec9ce9`/`6b40c91f`) was reverted
(`a1e89211`/`88a3fc`) because it **dropped features** (quick filters, column
customization, density, sticky bulk bar). So: match the Ad-Manager *look* via
the DS, but keep `/products/next` on its own grid so nothing is lost.

## Architecture decisions

- **DS-first.** Compose existing DS pieces. Anything new and reusable is built
  **into the DS** (recorded: barrel + catalog + CHANGELOG + token-clean + guards),
  never a one-off in the feature folder. The feature page holds *configuration*
  only (which dimensions, which columns).
- **Client-side filtering** (decision): filter the already-loaded rows in the
  browser (matches current `/products/next` + the campaigns grid; right for the
  ~few-hundred-SKU catalog). Server-side URL params deferred.
- **Token reconciliation deferred** (decision: "build now, reconcile after"). The
  DS is ~98% matched to the campaigns gold standard but has measured drift
  (panel border `#d8dde4` vs `#d6dbe2`; multiselect border; label grey
  `#3a4452` vs `#2b3440`; grid greys `#e2e6eb`/`#f7faff`/`#475467` not yet
  tokenized). A focused token-reconciliation pass to lock the whole platform to
  the gold standard is tracked as a follow-up — **values, not structure**.
- **Keep the grid** (decision): variation expansion, thumbnail sizing, density —
  untouched.

## Phases (in the user's order)

### Phase 1 — Filter bar  ✅ built
A collapsible/expandable filter **bar** at the top of the page (campaigns parity),
hosting **every** dimension. Implemented as a new DS pattern:

- **`FilterBar`** (`design-system/patterns/FilterBar.tsx`) — config-driven: pass
  `dimensions: FilterDimension[]`; renders the collapsible panel (on `FilterPanel`)
  with `multiselect`→`MultiSelect`, `select`→`Combobox`, `range`→min/max field,
  `toggle`→`Toggle`; options accept facet `count`. Footer "Clear" + Hide/Show.
- `FilterPanel` gained additive `resetLabel`/`resetDisabled`.
- New token-clean CSS: `.h10-ds-range*`, `.h10-ds-ms-count`.
- Recorded: patterns barrel, catalog (Filters → FilterBar), CHANGELOG `[FILTERBAR]`.
- Wired on `/products/next` with: Channel, Status, Stock, Fulfilment, Product type,
  Brand, Tags, Family, Workflow stage, Missing channel, Price range, Stock-units
  range. Quick-lens chips + dead "Filter" button removed.

### Phase 2 — Main buttons (toolbar)  ✅ built + verified live
New DS pattern **`GridToolbar`** (`patterns/GridToolbar.tsx`, `.h10-ds-toolbar`) +
**`.h10-ds-gridcard`** wrapper so the toolbar sits inside the grid card above the
`DataGrid`, matching the campaigns page. Recorded (barrel · catalog · CHANGELOG
`[GRIDTOOLBAR]`). On `/products/next`:
- Toolbar count "Viewing X of Y products" (← "Selected N products" when rows picked).
- Left slot swaps search ⇄ selection actions.
- Right slot: density · **Customise** · **Export** (CSV) · **Live**.
- Header: **Import** (→ /products/upload) · **New product** (→ /products/new). `⋯` removed.

**No dead UI** — every control wired or removed (verified by scan + live test):
- **Export** → real client-side CSV (mirrors live /products).
- **Activate / Draft / Inactive** → `POST /api/products/bulk-status`.
- **Duplicate** (bulk + row) → `POST /api/products/bulk-duplicate` (verified 200 live).
- **Delete** → `POST /api/products/bulk-soft-delete` (two-click confirm; verified 200 live).
- All mutations `emitInvalidation('product.updated')` → `usePolledList` auto-refetch
  (verified: duplicate appeared, then delete removed it, count 16→17→16, no reload).
- Removed dead: header `⋯`, toolbar `↕ Sort`, bulk `Set field / Preview diff / Apply all`.

**Bulk Tag + Publish — now wired (DS `Menu`):**
- **Tag** → loads `GET /api/tags` on mount (verified 200; catalog has 0 tags → graceful
  "No tags yet"); clicking a tag → `POST /api/products/bulk-tag {…mode:'add'}`. Selection
  kept so several tags can be applied.
- **Publish** → DS Menu with 9 destinations (Amazon IT/DE/FR/ES · eBay IT/DE/FR/ES ·
  Shopify; active channels only). Each → resolve `GET /api/listings?channel&marketplace`
  → `POST /api/listings/bulk-action {action:'publish'}` → `emitInvalidation`.
- Menus verified rendering live; mutations use the same proven pattern as the
  duplicate→delete round-trip already verified end-to-end (200 + auto-refetch). Publish
  not fired against live channels during verification (FBA/FBM cascade caution).

### Phase 3 — "Customise" modal  ✅ built + verified live
New DS pattern **`PreferencesModal`** (`patterns/PreferencesModal.tsx`) — the live
two-panel preferences dialog ported to the DS (`Modal` + `Button` + `Toggle` +
tokens, no app i18n/utils). Left: optional rows-per-page · sticky first/last ·
optional sort · `workspaceSlot`; right: column visibility + native drag-reorder
(locked columns disabled). Draft→Save, Reset-to-default. Optional sections collapse
on empty option lists. Recorded (barrel · catalog · CHANGELOG `[PREFERENCES]`).

To make "Pin last column" real, **`DataGrid` gained `stickyRight`** on `Column`
(right-pinned, offsets stack like sticky-left, left edge-shadow). Additive.

On `/products/next` the toolbar **Customise** button opens it:
- Columns: product/actions locked, channels/status/available/price toggle + reorder.
- Sticky first (product) / last (actions) → wired to DataGrid sticky/stickyRight.
- Sort: Product name / Available / Price → sortKey/sortDir. Page-size hidden.
- Prefs persisted to `products-next:columns` + `products-next:layout`.

Verified live: toggling Channels off + Save removed the column; Reset restored it.
Fixed a defect found in verification — Reset used the DS default sort field
(`'updated'`, not valid here); `resetAll` now **clamps `sortBy`** to the first
offered option (shows "Product name", no mismatch).

## Phase 4 — Full column overhaul  ✗ REVERTED (2026-06-28)

Attempted to port the live ~18-column set into the grid + Customise modal
(`next/columns.tsx`). The user did NOT want this — they asked only to *add* the
missing columns to the Customise modal, **not** to change the existing grid
columns or the Product cell. Fully reverted: grid is back to the original 4
columns (channels · status · available · price) + original Product cell;
`columns.tsx` deleted; sticky removed from the columns (Phase 3 `showSticky`
toggles hidden via `showSticky={false}`). Lesson recorded in memory
(`feedback_reuse_reskin_not_rebuild`).

**Still open (correct, surgical version):** add the missing columns as
*additional available options* in the Customise modal without replacing the
existing displayed columns or touching the Product cell — and only after the
approach is approved.

## Phase 1.5 — competitive edge (deferred, approved order: core first)

- **Facet counts** next to each option (FilterBar already supports `count`).
- **Cross-channel filters** — "on Amazon, missing on eBay", "price drift across
  channels", "in stock locally, out on channel X". The multi-channel-cockpit
  advantage over Rithum / ChannelAdvisor.
- **Smart presets** — one-click Needs-attention / Suppressed / Out-of-stock
  (FilterPanel `presets` slot).
- **Market filter** — needs the server `facets.marketplaces` (not in the loaded
  row); wire via a light passthrough or per-row projection.

## Constraints

- `/products/amazon-flat-file` + `/products/ebay-flat-file` pages/routes: **zero
  changes** without explicit approval.
- The live `/products` page is not touched by this rebuild.
- DS governance: semantic tokens only (no raw hex / numbered ramp / Tailwind
  palette in DS); `token-guard` + `api-guard` must not gain new violations.
