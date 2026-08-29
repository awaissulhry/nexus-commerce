# GRID — the Grid Design System (GDS)

One grid for the whole platform: `NexusGrid`, AG Grid Enterprise, inside the Nexus design system.
This is the spec a new engineer builds a grid from without reading the products page. Every number
here is one a browser has confirmed — `npm run grid:conformance` opens `/design/grid-lab?tab=gds`
and holds every scenario to `design-system/grid/spec.json` at three densities, in both themes, at a
laptop and a monitor width. The plan and its decisions: `docs/2026-08-28-grid-design-system-gds.md`.

```ts
import { NexusGrid, GridCard, GridToolbar, GridPager, gridSelection, moneyColumn, statusColumn, useGridState } from '@/design-system/grid'
```

## 1. The folder

```
design-system/grid/
  NexusGrid.tsx        the thin AgGridReactProps<T> wrapper — pages hand it AG's own ColDef[]
  theme/theme.ts       Theming API bound to --nds-grid-* (tokens/grid.ts); grid.css = what the API has no param for
  modules.ts           the curated module list — the only place production registers AG modules
  renderers/           the cell library (.nds-cell-*) + loading / empty overlays
  columns/             presets (ColDef fragments) + the Customise ⇄ AG column-state bridge
  editors/             AG's number editor configured, a DS Listbox editor, the per-cell round trip
  toolbars/            GridToolbar (the DS pattern), GridPager, GridFooterStrip, GridDensityToggle
  hosts/               GridCard (page), GridPanel (modal / drawer)
  filters/             DS-built column filters mounted in AG's column menu
  hooks/               density context, theme mode, grid state (last-used + named views)
  sortValues.ts        the blank-sinking comparator
  spec.json            the numbers the conformance runner asserts
```

Only this folder and `app/design/grid-lab/` may import `ag-grid-*` (`scripts/check-ag-grid-import-boundary.mjs`).
No stylesheet outside it may address `.ag-*`, `.nds-ag-*`, `.nds-cell-*` or the GDS hosts.

## 2. Decisions that do not move

1. AG Grid Enterprise is the engine; pages pass AG's own `ColDef[]`. No compatibility layer over AG's props.
2. Theming API, token-bound. Every colour is a `var(--nds-grid-*)` that derives from a **semantic** role
   (`--nds-surface-*`, `--nds-border-*`, `--nds-text-*`, `--nds-primary`) — never a ramp step. Each alias is
   re-declared in `.dark` and pinned in `.h10-shell`; two guards enforce it.
3. Grid chrome lives in the engine: partitions, tokens, density, the totals-row height. Never a per-grid option.
4. A page grid's height is the page of rows the pager selects (`autoHeight` + AG pagination + `GridPager`,
   50 / 100 / 200 / 500); the page scrolls. Bounded grids only inside a modal or drawer (`GridPanel`).
5. Spacious is the default density. A modal follows its page (`GridDensityProvider`).
6. A family's inline preview is capped at 10 variations in the grid's sort, closed by a 48px footer row.
7. Customise is the DS `PreferencesModal` over AG column state (`columns/columnPrefs.ts`); AG's column chooser and
   tool panel are not shown. The `FilterBar` accordion writes `api.setFilterModel`; the three DS column filters live
   in the column menu; `suppressHeaderFilterButton` engine-wide.
8. Selection is the grid's: pages read it (`onSelectionChanged` → `api.getSelectedNodes()`), clear it
   (`api.deselectAll()`), never mirror it back down.
9. `ag-Grid-AutoColumn` never leaves the browser; the server sees the page's own column id.
10. A locked column (FBA quantity) is locked in the column DEFINITION (`lockedColumn`), never in a renderer.
11. Every option object and callback handed to `<NexusGrid>` has a stable identity
    (`scripts/check-grid-option-identity.mjs` fails the push otherwise).

## 3. Tokens (`tokens/grid.ts` → `--nds-grid-*`)

| Group | Tokens | Value |
|---|---|---|
| surfaces | `bg` · `header-bg` · `strip-bg` · `totals-bg` · `hover-bg` · `selected-bg` · `child-bg` · `child-hover-bg` · `child-rail` · `chrome-bg` | `--nds-surface` · `--nds-surface-raised` · `--nds-surface-sunken` · raised · raised · `--nds-wash-primary` · sunken · `--nds-surface-hover` · `--nds-border` · raised |
| rules | `row-rule` · `header-rule` · `partition` · `partition-w` · `partition-ratio` · `strip-rule` · `frame` · `frame-radius` | `--nds-border-subtle` · `--nds-border` · `--nds-border-subtle` · 2px · 0.3 · subtle · `--nds-border` · `--nds-radius-2xl` |
| type | `header-fg` 11.5px/700 · `cell-fg` 13px/500 · `muted-fg` · `strip-fg` 11px/700/0.05em caps · `empty-fg` | `--nds-text-strong` · `--nds-text` · `--nds-text-muted` · `--nds-text-2` · `--nds-text-2` |
| density | `row-text-*` 28/43/49 · `row-media-*` 52/68/85 · `header-*` 28/38/46 · `thumb-*` 32/40/56 · `cell-pad-x` 14 (compact 10) | compact / cozy / spacious |
| geometry | `strip-h` 30 · `footer-row-h` 48 · `select-col-w` 43 · `identity-w` 320 · `checkbox-size` 16 | |
| controls | `accent` · `focus-ring` · `radius` · `checkbox-radius` · `drag-handle` · `fill-handle` | `--nds-primary` · `--nds-focus-ring` · `--nds-radius-sm` · sm · primary · primary |
| editing | `editable-ring` · `editor-ring` · `pending-bg` · `refused-bg` / `-ring` · `saving-bg` · `delta-bg` / `-neg-bg` / `-fg` · `locked-fg` | `--nds-border` · `--nds-primary` · warning 14% · danger 10% / `--nds-danger` · info 10% · `--nds-warning` / `--nds-danger` / `--nds-text-inverse` · `--nds-text-muted` |
| overlays | `skeleton-bg` · `skeleton-shine` · `loading-veil` · `pinned-shadow` | sunken · subtle · surface 60% · `rgb(var(--nds-shadow-rgb) / .08)` |

Resolved in the browser (spec.json): light — ground `#ffffff`, header `#f7f9fb` / `#3a4452`, cell `#1c2530`,
row rule `#e6e9ee`, header rule `#d8dde4`, hover `#f7f9fb`, selected `#eef5ff`, strip `#eef1f5` / `#5b6573`.
Dark — ground `#18263b`, header `#1f2c3d` / `#e7ebf1`, cell `#e7ebf1`, rules `#26323f` / `#2f3a4a`,
hover `#1f2c3d`, selected `#182a44`, strip `#1a2330` / `#aab6c2`.

AG paints `--ag-cell-horizontal-padding` one pixel under the variable (14 → 13). The token states 14.

## 4. Density

| `density` | text row | media row | header | thumb | cell pad |
|---|---|---|---|---|---|
| `compact` | 28 | 52 | 28 | 32 | 10 (renders 9) |
| `cozy` | 43 | 68 | 38 | 40 | 14 (renders 13) |
| `spacious` (default) | 49 | 85 | 46 | 56 | 14 (renders 13) |

`rows="text"` for a one-line row, `rows="media"` when the identity cell carries a thumbnail. Omit `density` and
the grid follows the nearest `GridDensityProvider`; `GridDensityToggle` in the toolbar's right slot is the one
control. Rows are integers because AG virtualises off them.

## 5. Header chrome

One header row at the tier's height. Partitions: 2px `--nds-grid-partition`, **30% of the header row** —
`calc(var(--nds-grid-header-h) * 0.3)`, stamped by the wrapper, so a cell spanning a column-group strip draws the
same 13.8px mark as its neighbours (Quartz's own `30%` is of the cell). Resize handle mark width 0 (the handle still
drags). Sort indicator: AG's. Header menu on every column unless `suppressHeaderMenuButton`; the menu's last
items are "Customise columns…" / "Reset columns" when the page passes `columnDialog`. Column groups render as a
**30px strip** above the header: sunken ground, eyebrow caps 11px/700/0.05em, full-height partitions.

## 6. Cell types (`renderers/`, `columns/presets.ts`)

| Preset | Renderer | Rule |
|---|---|---|
| `integerColumn(field)` | `NumericCell` | thousands-separated |
| `moneyColumn(field, {decimals})` | `NumericCell` | CENTS in; `€1,234` or `€1,234.56` |
| `euroColumn(field)` | `NumericCell` | euros in (a decimal) |
| `percentColumn(field, {dp})` | `NumericCell` | a FRACTION in (0.153 → 15.3%) |
| `deltaColumn(field)` | `NumericCell` | `+12` / `−4` |
| `dateColumn(field)` | `DateCell` | `formatDate`, muted 12px |
| `statusColumn(field, {tones})` | `BadgeCell` | a `Pill` per value, fallback tone |
| `textColumn(field)` | — | as-is |
| `stockColumn(field, {threshold})` | `StockCell` | out / low / ok tones |
| `lockedColumn(field)` | `LockedCell` | muted + 🔒, `editable:false`, unmovable |
| `actionsColumn({primary, items, pinned})` | `ActionsCell` | Edit + ⋯ `Menu`; held at the right end, pinned on request |
| `holdColumn(col, end, pinned)` | — | cannot be hidden or moved |
| identity | `IdentityCell` | expander slot · `Thumbnail` · title link + hover "Open" pill · sub-line (`SkuTag`, `Tag`s) |
| tags | `TagsCell` | one named chip, or ≤6 glyph chips + "+N", `InfoTip` |
| coverage | `CoverageCell` | `CoverageSummary` from a `CoverageChannel[]` value |
| group row | `GroupCell` | label + count |

**The null rule.** `formatGridValue` decides: `null` / `undefined` / `NaN` → `EmptyValue` — a muted dash with
**no** title (`aria-label="Not measured"`); a measured zero prints (`0`, `€0`) or, with `zero: 'dash'`, draws the
dash **with** a `title` that says what was measured. No renderer ever coerces a null to a zero (tests per kind).

## 7. Row kinds

Data · child (`flatTree`: sunken tint + 3px rail, no indent; the page's cell owns the expander) · group row
(`GroupCell`, unselectable) · full-width footer row (48px, the family cap) · **pinned totals row = the header's
height** (the engine's default `getRowHeight`) · master/detail row (`MasterDetailModule`, the DS theme at the same
density) · loading rows (`GridLoadingOverlay` skeleton at the current density). Hover → `--nds-grid-hover-bg`;
selected → `--nds-grid-selected-bg`; the hovered row sits above its siblings (`z-index: 1`).

## 8. Selection · toolbar · footer

`gridSelection()` — checkboxes, header select-all, no click-to-select, disabled boxes hidden, pinned rows
unselectable; under SSRM `selectAll: 'currentPage'` (the honest reach). The selection column is 43px and stays
first. `GridToolbar` = count · children (search / selection actions) · right (density, Customise, Views, Export,
live pill); the count swaps to "Selected N" and the children to the bulk actions while rows are ticked.
`GridPager` below the grid: pages left of the control, rows-per-page on the right. `GridFooterStrip` inside an
editor's card: reason · notes · message · Cancel · Apply.

## 9. Editing

`numericEditor({min, max, step, precision})` (no stepper buttons), `textEditor()`, `selectEditor(options)` (a DS
Listbox). Keys: Enter ↓ (`enterNavigatesVertically`), Tab →, Esc reverts, fill handle + paste + undo/redo in the
editor. Two models: **batch** — edits are pending (`.nds-cell-is-pending`, `DeltaChip`) until Apply, per-change
results, a refused cell stays `.nds-cell-is-refused` with its reason on hover; **per-cell round trip** —
`saveCell(api, tracker, rowId, colId, save)` paints `saving → saved (fades 1.5s) | refused (stays)`.

## 10. Row models · state · hosts

SSRM: the verbatim `IServerSideGetRowsRequest` goes to the page's endpoint; the server owns column-id → sort/filter
maps and reports `unsupported`; block size 100; `maxBlocksInCache` only with a fixed row height. CSRM for small
data and modals. State: `useGridState(surface)` — a server default view wins; else the last-used
`{gridState, page}` from `nds-grid:<surface>:v1`; else the page's default; named views on `SavedView`.
Hosts: `GridCard` (page, autoHeight, a size container for the toolbar's container queries), `GridPanel`
(modal/drawer, bounded). Popups parent to `document.body`; `data-ag-theme-mode` is stamped on `<html>`.

## 11. Themes · accessibility · locale · performance

Light/dark through the tokens; the console shell pins light, so dark is verified in the lab. AG's ARIA is kept
(`role=grid`, `aria-sort`, `aria-selected`, row/col indexes); contrast ≥ AA on every state; never `cursor: help`.
`localeText` lives in one file; numbers and dates only through `design-system/lib`. Curated modules; memoised
renderers; a 500-row page is the most a page grid draws. RTL and mobile widths are out of scope for v1.

## 12. Empty · loading · error

`GridNoRowsOverlay` (title, message, an action) · `GridLoadingOverlay` (skeleton rows, `media` for thumbnails) ·
a failed SSRM block reports to the page (`onError`) and the page shows the DS `Callout` with a retry.

## 13. Guards

`check-ag-grid-import-boundary` (imports + stylesheets) · `check-grid-option-identity` (AST) · `check-grid-kit-ratchet`
(the rebuild backlog only shrinks) · `check-ds-gaps-append-only` · `theme.vitest.test.ts` (every param a grid token,
no ramp) · `check-grid-chrome` (Playwright, measured; `npm run grid:conformance`, `--strict` in CI).
