# GDS — the Grid Design System on AG Grid

> Paste everything below this line into a fresh Claude Code session in `/Users/awais/nexus-commerce`.
> It is self-contained: the facts, the decisions already made, the scope, the working rules, and
> the order of work. Where it says "measured", the number was taken off the live DOM on 2026-08-28.

---

## Your mission

Design and build the **Grid Design System (GDS)**: one grid for the whole platform, built on
AG Grid Enterprise, inside the existing Nexus design system — so that every grid on every page
(products, inventory editor, ads console, fulfilment, settings, modals, drawers) looks and behaves
as ONE product. The seed already exists and is in production use on two surfaces; your job is to
turn that seed into a system with tokens, a spec, a catalog, guards and a migration map.

**Plan first, then build.** Phase 0 is an audit and a written plan that I approve before any code
changes. Do not implement anything in Phase 0. Consider every scenario listed in §6 — if one does
not apply, say so explicitly in the plan rather than skipping it.

## 1. Where things are (read these before planning)

- **Design system:** `apps/web/src/design-system/` — `tokens/` (TS; `css-vars.ts` GENERATES
  `styles/tokens.css`), `styles/` (`tokens-global.css` 332 L, `tokens.css` 344 L, `primitives.css`
  1362 L, `components.css` 2168 L, `patterns.css` 1000 L, `workspace-grid.css` 490 L, `a11y.css`),
  `primitives/`, `components/`, `patterns/`, `catalog/` (living style guide at `/design/catalog`),
  `docs/`, `README.md` (principles), `CHANGELOG.md`. Rules: `DESIGN.md` at the repo root
  (🔴 "Everything new uses the design system"; "the same names mean two different things" —
  `--text-*`/`--surface-*`/`--border-*` in `app/globals.css` are Tailwind RGB CHANNELS, the DS
  namespace is `--nds-*`). Gaps are filed in `.claude/DS-GAPS.md` (APPEND-ONLY, never subtract).
- **`apps/factory/src/design-system/` is a COPY of the web DS** that must stay byte-identical
  (`scripts/check-ds-fork-drift.mjs`). Known hole: that guard is BLIND to the four stylesheets —
  today `components.css`, `patterns.css`, `primitives.css` already differ between web and factory.
  Any DS change you make is made in BOTH.
- **The grid engine (the seed):** `apps/web/src/design-system/patterns/workspace-grid/engine/`
  - `NexusGrid.tsx` (230 L) — the ONE grid component: a thin wrapper that extends
    `AgGridReactProps` (pages pass AG's own `ColDef[]`; no invented column contract), adds the DS
    theme + light/dark mode attribute, density tiers (`size` xs/sm/md/lg/xl → row 28/34/43/49/59,
    header 28/32/38/46/56 — MEASURED off the DS grid in `/design/grid-lab`), a blank-sinking
    comparator (blanks sink to the bottom in BOTH sort directions — the KT.3 rule), `columnDialog`
    (replaces AG's "Choose/Reset Columns" menu items with the DS Customise dialog), a "selection
    column stays first" rule, `popupParent=document.body`, `flatTree` (tint + 3px rail on child
    rows), `numericColumn` (right-aligned, tabular figures). Wrapper classes: `nds-ag-wrap`
    `nds-ag-nexus` — the DS DataGrid tokens are keyed on `nds-ag-nexus` so EVERY NexusGrid speaks
    them wherever it sits (page card, modal, drawer).
  - `theme.ts` (149 L) — AG **Theming API** (`themeQuartz.withParams`), never `ag-theme-*.css`;
    every colour is a `var(--nds-*)` so dark mode is free; geometry transcribed from
    `workspace-grid.css` and measured; `HEADER_COLUMN_PARTITION` (2px `--nds-grey-150` header
    partition at 30% height; the resize handle's own mark width 0) — locked by
    `theme.vitest.test.ts`, which reads the theme's EMITTED CSS (`_getParamsCss()`).
  - `modules.ts` (122 L) — the CURATED module list (never `AllEnterpriseModule` on a shipped
    route; the lab registers the wildcard itself in `app/design/grid-lab/labModules.ts`).
    `ValidationModule` dev-only so a missing module is named in the console.
  - `ag-grid.css` (290 L) — the only place `.ag-*` selectors may appear: cell = flex row with a
    normal line box (multi-line renderers), tooltip overflow escapes via `:has()`, hovered-row
    z-index, `flatTree` tint + rail, `.nds-gridcard` frame removal, `.nds-ag-nexus` tokens
    (header `--nds-text-strong`, body `--nds-text`, hover `--nds-surface-raised`, selected
    `--nds-wash-primary`), the column-group row as a slim STRIP (`.ag-header-row-group`: sunken
    ground, eyebrow caps, full-height partitions), xs density cell padding, the custom filter
    components' styles.
  - `filters/gridFilters.tsx` — DS-built AG column filters (set with search, number range, text)
    via `useGridFilter`, `doesFilterPass: () => true` under SSRM.
  - `columnPrefs.ts` (+ tests) — pure bridge DS `PreferencesModal` ⇄ AG column state.
  - `useGridViews.ts` — saved views = `api.getState()` + page knobs, server-side on the
    `SavedView` table under a per-page surface.
  - `useAgThemeMode.ts` — stamps `data-ag-theme-mode` on the wrapper AND on `<html>` (popups).
  - `productsDatasource.ts`, `productsServerContract.ts` (+ tests) — products-page specific;
    they live in the engine folder today and probably should not (your call in the plan).
  - `AgWorkspaceGrid.tsx` (498 L) — a Phase-1 spike that re-expressed AG through the old
    `WorkspaceGridProps` contract; only the lab imports it. Treat as legacy to retire.
  - `scripts/check-ag-grid-import-boundary.mjs` — only `engine/` and `app/design/grid-lab/` may
    import `ag-grid-*`. Keep it.
- **The two production consumers (uncommitted, local — read them as the reference):**
  - `/products/next` — `apps/web/src/app/products/next/`: `ProductsNextClient.tsx` (~1,060 L),
    `columns.tsx` (registry + cells + `projectColDefs`), `ProductTreeCell.tsx` (custom auto-group
    cell), `FamilyFooter.tsx` (full-width sentinel row), `useBulkActions.ts`, `GridViewsMenu.tsx`,
    `density.ts` (rows 52/68/85, thumb 32/40/56, header xs/md/lg — shared with the modal),
    `styles.module.css`. Server-Side Row Model, tree data (families, lazily loaded, preview capped
    at 10 in the grid's sort), server-side row grouping + aggregation, AG pagination over SSRM with
    a DS pager footer, `domLayout="autoHeight"` (the page scrolls), Customise = DS
    `PreferencesModal` (tabbed: Columns + Grouping), saved views, one-way selection
    (grid owns it), CSV export, DS `GridToolbar`, DS `FilterBar` writing AG's `filterModel`.
  - **Inventory editor** (the modal behind the Available cell) — `InventoryEditorModal.tsx`,
    `InventoryGrid.tsx`, `useInventoryEditor.ts`, `inventoryEditor.logic.ts` (+ tests):
    Client-Side Row Model, column groups per location rendered as the strip, spreadsheet editing
    (number editor, Enter ↓ / Tab → / Esc, fill handle, paste, undo/redo), pending-edit overlay
    (amber + delta chip), batch Apply with per-change server results (refused cells stay red),
    pinned totals row at header height, DS `GridToolbar` + `Pill`s, the page's `productCell`/
    `skuTag` classes for the identity cell, a footer strip INSIDE the `nds-gridcard` styled like
    the page's pager, Columns `MultiSelect`, density FOLLOWS the page.
- **Every other grid on the platform (the migration surface — count them yourself, these were
  measured today):** DS `DataGrid` (a `<table>` component; 7 importers), `AdsDataGrid` (the ads
  console's hand-rolled grid; **62** importers), `app/_shared/grid-lens/` (**63** importers; its
  own `GridToolbar`, `GridFooter`, `KpiStrip`, `ColumnPicker`, `SavedViewsButton`, a 416-line
  Tailwind `PreferencesModal` FORK, `ProductIdentityCell`, `Thumbnail`, `VirtualizedGrid`,
  `DensityToggle`…), DS `WorkspaceGrid` pattern (1,074 L, 51 props; 2 importers), and **196 files
  with a raw `<table>`**. The AG migration plan for the ads console is
  `docs/2026-08-28-ag-grid-migration-ag.md` (read §5 load-bearing behaviours and §7 risks).
- **Guards you must pass (pre-push, `.githooks/pre-push`):** `check-contrast`,
  `check-css-hex-ratchet`, `check-css-radius-ratchet`, `check-css-ds-shadow-ratchet`,
  `check-raw-primitives-ratchet` (a file with no baseline is held at ZERO raw controls),
  `ds-conformance-guard` (native select/date input, inline fontSize/hex — ratchets DOWN only),
  `check-ds-fork-drift`, `check-ds-dts-fresh`, `check-help-cursor` (never `cursor: help`),
  `check-button-vocabulary`, `check-dark-alias-scope`, `check-ag-grid-import-boundary`.
  🔴 The DS guards grep COMMENTS too. `git ls-files`-based guards miss UNTRACKED files — stage
  into a private index before trusting a green run.

## 2. Decisions already made — do not relitigate, build on them

1. AG Grid Enterprise is the engine, `NexusGrid` is the one grid; pages pass AG's own `ColDef[]`.
   No compatibility layer over AG's props (that was tried — `AgWorkspaceGrid` — and produced the
   flat-list/`postSortRows` sort bug).
2. Theming API, token-bound, no legacy theme stylesheet. Every colour is `var(--nds-*)`.
3. **Grid chrome lives in the ENGINE** (theme + `ag-grid.css` + `nds-ag-nexus`), never in a
   per-grid option or a wrapper class. Header partitions are a theme param. A column-group row is
   a 30px strip. This came from a real defect: the editor once had no header partitions because
   `resizable: false` removed the resize-handle marks.
4. **A page's grid height is the page of rows the footer selects** (`autoHeight` + AG pagination
   + the DS pager: 50/100/200/500); the PAGE scrolls. Never a viewport-bounded grid with its own
   scrollbar; never "recover rows" by collapsing the chrome above the grid.
5. **Spacious is the default density** on `/products/next`. Density tiers are shared
   (`density.ts`); a modal grid follows the page's current density.
6. A family's inline preview is capped at **10** variations in the grid's current sort, closed by
   a **48px** footer row ("Showing 10 of 40 variations · View all 40"); the parent cell's
   "N variations ↗" link stays too. Consequence: `getRowHeight` is a function on SSRM, so
   `maxBlocksInCache` is deliberately NOT set (AG #203 fires only when both are set).
7. The Customise dialog is the DS `PreferencesModal` (tabbed when a grid offers grouping); AG's
   Columns tool panel is not shown. The filter accordion (`FilterBar`) stays the filter UI; AG's
   column filters are DS-built components; `suppressHeaderFilterButton` engine-wide.
8. Selection is the grid's; pages READ it (`onSelectionChanged`, `deselectAll`), never mirror it
   back down.
9. `ag-Grid-AutoColumn` never leaves the browser — the client maps it to the page's column id.
10. The FBA quantity is never written by anything we build; FBA/Shopify locations are locked in
    the column definition, not in a renderer.
11. **Never mention AG Grid licensing, patches or installation.** Assume a valid licence and the
    latest version. Code and technical reasoning only.
12. **Every AG option object/callback passed to `AgGridReact` has a stable identity**
    (`useMemo`/`useCallback`). An inline `rowSelection={{…}}` is a changed option on every render
    and makes AG re-run its column model (measured: `aria-colindex` rewritten on every cell per
    checkbox tick).

## 3. Working rules for this session

- **Approval before implementing.** Phase 0 ends with a plan I approve. Each later phase is
  proposed (what/why/files) before it is built. Read-only investigation needs no approval.
- **Local-first.** Do not commit. Leave everything in the working tree; I commit on my command.
- **Honest UI, measured.** What displays is real; a `null` is never rendered as `0`; a change the
  server refused stays visible. Verify every visual change in the browser at native resolution and
  MEASURE it (row heights, header heights, partition widths, colours, alignment) before showing
  it. The dev server (`:3000`) and the API (`:8080`, `tsx watch`) are usually running; use the
  claude-in-chrome tools; drive AG through its own paths (focus a cell, `keydown`, editor input,
  Enter) — a bare `input.click()` and coordinate clicks after an HMR layout shift both proved
  unreliable. Probe `document.activeElement` before typing.
- **AG probe traps:** DOM order ≠ visual order (read cells by x); `.ag-center-cols-container`
  does not exist in this version — use `.ag-row` and filter by your cell's class; a ref-click
  scrolls an `overflow:hidden` card and hits the wrong row; `node.group` is NOT set when SSRM first
  renders a custom auto-column cell — derive expandability from row data with the same predicate
  you hand to `isServerSideGroup`.
- **CSS traps:** a CSS-module class that does not exist renders as `class="undefined"` silently —
  check every `styles.x` against the stylesheet; source order beats specificity; a DS rule like
  `.nds-modal.xxl .nds-modal-b` is (0,3,0) and needs (0,4,0) to override; `color-mix()` is fine for
  soft tints; `--nds-grey-500` is NOT a text token (3.10:1); `--color-primary-soft` is 1.15:1 (a
  wash, never a mark); `--border-strong` is the 2.56:1 floor.
- **Shared means EXACTLY the same.** No copy props, no forks. If two surfaces need to differ, the
  difference is a prop on the shared thing, or it is not shared.
- **Reuse before building.** The page's own pieces are the vocabulary: `nds-gridcard`,
  `GridToolbar` (count · children · right), `Pagination` + `Listbox` pager, `Pill`, `Tag`,
  `TagGlyph`, `InfoTip`, `CoverageSummary`, `MetricStrip`, `FilterBar`, `PreferencesModal`,
  `Thumbnail`, the `productCell`/`pmeta`/`skuTag`/`psub` cell classes, `eur0`/`num`/`formatDate`
  from `design-system/lib`. A gap goes to `.claude/DS-GAPS.md` with a measurement, then into the
  DS (both copies), never hand-rolled locally.
- **Write the plan to `docs/`** the day it is agreed (a plan that lives only in a transcript has
  been lost before).
- Update `apps/web/src/design-system/CHANGELOG.md` for every DS change you ship.

## 4. Phase 0 — audit and plan (read-only; ends with my approval)

Deliver `docs/<today>-grid-design-system-gds.md` containing:

1. **Inventory of every grid surface** (path, component used, row model, feature list, whether it
   owns localStorage state and in what shape, whether it is inside a page card / modal / drawer).
   Use the counts in §1 as the starting expectation and reconcile them against the tree.
2. **Feature matrix**: rows = surfaces, columns = every scenario in §6; a cell is "uses / needs /
   n/a".
3. **Token audit**: every visual value the grid surfaces use today (from `workspace-grid.css`,
   `components.css` `.nds-grid*`, `ag-grid.css`, `theme.ts`, the page CSS modules) → the grid
   component tokens you propose (name, value, which DS primitive/semantic token it derives from,
   light + dark). Nothing hard-coded survives.
4. **The GDS spec outline** (§5) with the open questions you want me to decide, each with your
   recommendation.
5. **The migration map** (§7) — order, effort, the data-migration risk per surface, what is
   retired when.
6. **Guards you will add** (§8).

## 5. Phase 1+ — what the GDS must define (the spec)

Each item is a section of the spec AND a scenario in the lab/catalog. Numbers, not adjectives.

- **Tokens** — grid component tokens in `tokens/` (generated into `tokens.css`), consumed by
  `theme.ts` and `ag-grid.css`: surfaces (header, body, strip, pinned/totals, hover, selected,
  child tint, rail), rules (row, header, partition, strip rule, frame), type (header 11.5/700,
  cell 13/500, eyebrow caps for strips), density geometry (row/header/cell padding per tier,
  thumbnail size per tier), radii, focus ring, drag/fill handle colours, editing states (editor
  border, pending, refused), overlays (loading skeleton, no-rows, error).
- **Density tiers** — xs/sm/md/lg/xl in the engine; compact/cozy/spacious as the page-facing
  triple; the rule that a modal follows its page; where the switch lives (`GridToolbar` right).
- **Header chrome** — one row, page height; partitions from the theme; sort indicator; menu
  button (when a column has a menu; suppressed when it would be empty); the column-group strip;
  header checkbox; pinned-left identity column; resize behaviour.
- **Cell types** (renderers + ColDef fragments exported from the engine, like `numericColumn`):
  text, numeric (integer, money — cents-based `eur0`, percent, delta ± chips), date, status
  `Pill`, tags (glyph + name, `InfoTip`), coverage/channel summary, thumbnail identity
  (photo · title/SKU · sub-line; SKU-first variant), actions cluster (Edit + ⋯ `Menu`), locked
  (🔒 + muted), link (same-tab / new-tab pill on hover), empty-value rendering (a measured zero
  vs an unmeasured null — DIFFERENT renderings).
- **Row kinds** — data, child (tint + rail, flat under parent), group row (label + count,
  expander), full-width footer row (48px), pinned totals row (header height), loading rows,
  hover/selected/focus states, z-order rules.
- **Selection** — checkbox column (43px), header select-all semantics under SSRM
  (`currentPage`), unselectable rows, one-way read into the page, bulk toolbar swap.
- **Toolbar** — `GridToolbar` layout contract (count · search/actions · right controls), what
  goes right (density, Customise, Views, Export, Live pill), the selection-actions variant and its
  container-query collapse.
- **Footer** — the DS pager (pages + rows per page), the totals row, and the in-card footer strip
  used by editors (reason/notes/apply).
- **Filtering** — `FilterBar` accordion writing AG's `filterModel`; the three DS column filters;
  the `unsupported` banner when the server cannot express a filter/sort.
- **Sorting** — server-side under SSRM; blank-sinking under CSRM; multi-sort policy.
- **Tree data + grouping** — lazy families, capped preview + footer, group rows, view-mode rule
  (tree OR groups), the auto-column cell owned by the page (`cellRenderer`, not `innerRenderer`
  + CSS).
- **Editing** — number/text editors, Enter/Tab/Esc map, fill handle, paste, undo/redo, pending
  overlay + delta, batch Apply with per-row results, locked columns, validation, discard guard.
- **Row models** — SSRM (verbatim `IServerSideGetRowsRequest` to one endpoint; the server owns
  column-id → sort/filter maps; `unsupported` reporting; block size 100; when `maxBlocksInCache`
  may be set) and CSRM (small data, modals); the page-scroll rule for pages, bounded height only
  inside modals/drawers.
- **State** — Grid State API (`getState`/`initialState`) for saved views on the server;
  Customise via `columnPrefs` bridge; what a page may keep (accordion filters, density, tile)
  and how the two are stored together; the localStorage shapes the legacy kits use and how they
  migrate.
- **Hosts** — grid in a page card, in a modal (body inset 18px, xxl), in a drawer; frame rules;
  popup parent; stacking with DS overlays.
- **Themes** — light/dark via tokens; `browserColorScheme` per mode; the `.dark` tone-token gap
  (probe BOTH themes).
- **Accessibility** — ARIA from AG kept intact, focus ring visible, keyboard map documented,
  contrast ≥ AA on every state, no `cursor: help`.
- **Locale & formatting** — `localeText` overrides live in the engine; numbers/dates through
  `design-system/lib` only.
- **Performance** — curated modules; stable option identities; cell renderers as memoised
  components; virtualisation expectations per host; export.
- **Empty / loading / error** — skeleton overlay, "no rows" template wording, failed-block
  reporting to the page, the retry affordance.

## 6. Scenarios the plan must cover explicitly (each: uses / needs / n/a per surface)

Catalogue page (SSRM, tree, pagination, autoHeight) · family page (`?parent=`) · row grouping
with aggregates · bulk-select + toolbar swap · Customise (columns, locks, groups, totals) · saved
views incl. default view on first load · CSV export · a grid inside a modal (editor) · a grid
inside a drawer · a grid inside a tab panel · a read-only report grid (ads reporting) · an
editable grid with server round-trips per cell (ads bid/budget) · a grid with frozen/pinned
right actions column · a grid with a pinned Total row · a grid with expandable detail rows · a
grid with column groups · a matrix (rows × locations) · a 0-row grid · a 1-row grid · a
10,000-row grid · a grid with very long text cells · a grid with images · dark mode · Compact /
Cozy / Spacious · a 962px-tall laptop window and a 1440px monitor · keyboard-only operation ·
screen-reader announcement of sort/selection · printing/export parity · RTL (state whether out
of scope) · mobile widths (state whether out of scope) · the ads console's "cannot verify
locally" constraint (`/design/grid-lab` is the parity harness).

## 7. Migration map (plan only; execution is a separate approval)

Order by risk and reuse: `/products/next` (done) → inventory editor (done) → DS `DataGrid`
sites (7) → `grid-lens` workspaces (63; the 416-line `PreferencesModal` fork is retired by this)
→ `AdsDataGrid` (62; the ads console — parity proven in the lab first, `AgWorkspaceGrid`
retired) → `WorkspaceGrid` (2) → the 196 raw `<table>` files (most are not grids; classify).
For each: what state it persists today and the data migration to Grid State; which shared
pieces replace its local ones; the guard that stops a new fork appearing.

## 8. Guards to add (so this never regresses)

- Theme params test (exists) — extend to every grid token.
- A "grid chrome conformance" test that renders `NexusGrid` in the lab and asserts the measured
  numbers (row/header/strip heights per tier, partition width, header/body colours) against the
  spec — the lab already measures DOM properties; make it the spec's test.
- Extend `check-ds-fork-drift.mjs` to the stylesheets (it is blind to them today) or replace the
  factory copy with a single source.
- A grep guard: outside `engine/`, no `.ag-` selector in any stylesheet and no `ag-grid-*` import
  (the import boundary exists; add the CSS half).
- A guard that `AgGridReact` option props in pages are memoised (lint rule or a ratchet on inline
  object literals for `rowSelection`, `selectionColumnDef`, `columnDefs`, `localeText`,
  `cellSelection`).
- Keep `.claude/DS-GAPS.md` append-only; every gap you close is listed with its measurement.

## 9. Definition of done for the whole programme

- One grid component, one theme, one token set, one catalog page, one lab with every scenario
  in §6 rendered and measured; a spec in `docs/` that a new engineer can build a grid from
  without reading the products page.
- Both DS copies identical; all pre-push guards green from a staged private index.
- `/products/next` and the inventory editor unchanged in behaviour and measured identical in
  chrome before and after.
- Nothing committed until I say so.

Start with Phase 0. Show me the plan.
