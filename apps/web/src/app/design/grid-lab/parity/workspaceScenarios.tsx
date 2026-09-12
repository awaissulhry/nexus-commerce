'use client'

/**
 * AGL — every prop of `WorkspaceGridProps`, as scenarios. One scenario = ONE props set, built by ONE
 * hook, rendered by BOTH engines. The hook runs once per side (each side keeps its own selection,
 * search, expansion…), so a difference between the two panels is the engine's, never the props'.
 *
 * Nothing here persists: `onApply`, `onExport`, `onRowKey` and the URL-bridge callbacks write to a
 * per-side log rendered above the grid, so a person can see the SAME callback fire from either engine.
 *
 * Identity discipline (GDS decision 12): every object handed to a grid is a module constant or comes
 * out of `useMemo` / `useCallback`. The props object itself is memoised, so a parent re-render does not
 * hand the engine a new options object.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { Button, Input } from '@/design-system/primitives'
import { EmptyState } from '@/design-system/components'
import { AdsFilterBar } from '@/design-system/patterns'
import type { FilterState, GridColumn, GridEditMode, GridHierarchy, GridPrefs, WorkspaceGridProps } from '@/design-system/patterns'

import type { AgWorkspaceExtras, ParityEngines, Side, WorkspaceEngine } from './engines'
import { Pair } from './Pair'
import { renderIdentity } from './IdentityCell'
import {
  ENABLED_FIRST, FIRST_SORT_VALUE, GROUP_BY_PRODUCT, NO_ROWS, ROWS_120, ROWS_24, ROWS_24_BY_SPEND, ROWS_36, ROWS_50, ROWS_TREE, ROW_ID, SEARCH_VALUE,
  TREE_EXPANDED_INITIAL, WS_COLUMNS, WS_FILTERS, WS_PREFS_SUBSET, WS_SELECTED_INITIAL, eur, type ParityRow,
} from './fixture'

type WsProps = WorkspaceGridProps<ParityRow> & AgWorkspaceExtras
/** What a scenario hook returns: the props, plus anything to render above the grid on that side. */
interface SideBuild { props: WsProps; above?: ReactNode }
type UseSide = (side: Side) => SideBuild

/* ── plumbing ────────────────────────────────────────────────────────────────────────────────── */

/** Every scenario shares the identity contract. Spread first; a scenario overrides what it exercises. */
const BASE = {
  rowId: ROW_ID,
  noun: 'campaign',
  firstColLabel: 'Campaign',
  renderFirst: renderIdentity,
  firstSortValue: FIRST_SORT_VALUE,
  columns: WS_COLUMNS,
  customizable: false,
} as const

/** A per-side log of callback firings — the proof that the engine called the consumer's function. */
function useLog(): [string[], (line: string) => void] {
  const [log, setLog] = useState<string[]>([])
  const push = useCallback((line: string) => setLog((l) => [...l.slice(-3), line]), [])
  return [log, push]
}
function Log({ lines, label }: { lines: string[]; label: string }) {
  return (
    <div className="nds-type-sm" style={{ color: 'var(--nds-text-2)', minHeight: 18 }}>
      <b>{label}:</b> {lines.length ? lines.join(' · ') : 'nothing yet'}
    </div>
  )
}

function WsSide({ Engine, side, useSide }: { Engine: WorkspaceEngine; side: Side; useSide: UseSide }) {
  const { props, above } = useSide(side)
  // The three additive props reach the AG side only; the legacy component has no such props and must
  // never be handed them (design §7 — chromeless is the Ad Manager's mode, not a legacy feature).
  const { chromeless, prefs, onPrefsChange, rowHeight, ...legacyProps } = props
  return (
    <>
      {above}
      {side === 'ag'
        ? <Engine {...legacyProps} chromeless={chromeless} prefs={prefs} onPrefsChange={onPrefsChange} rowHeight={rowHeight} />
        : <Engine {...legacyProps} />}
    </>
  )
}

function WsPair({ id, title, note, header, engines, useSide, exempt }: {
  id: string; title: string; note?: ReactNode; header?: ReactNode; engines: ParityEngines; useSide: UseSide; exempt?: string[]
}) {
  return (
    <Pair
      id={id}
      kind="workspace"
      title={title}
      note={note}
      header={header}
      exempt={exempt}
      legacy={engines.legacyWorkspace ? <WsSide Engine={engines.legacyWorkspace} side="legacy" useSide={useSide} /> : null}
      ag={engines.agWorkspace ? <WsSide Engine={engines.agWorkspace} side="ag" useSide={useSide} /> : null}
    />
  )
}

/** A selection Set per side + the toolbar's bulk-action slot. */
function useSelection(initial: Set<string> = EMPTY_SET) {
  const [selected, setSelected] = useState<Set<string>>(initial)
  const selectionActions = useCallback((ids: string[], clear: () => void) => (
    <>
      <Button size="sm" onClick={clear}>Clear {ids.length} selected</Button>
      <Button size="sm" variant="primary" onClick={clear}>Pause {ids.length}</Button>
    </>
  ), [])
  return { selected, setSelected, selectionActions }
}
const EMPTY_SET = new Set<string>()

const noop = () => {}
const toolbarRightNode = <Button size="sm" onClick={noop}>Refresh</Button>
const toolbarLeftNode = <span className="nds-type-sm" style={{ color: 'var(--nds-text-2)' }}>Last synced 04:10</span>

/* ── the scenarios ───────────────────────────────────────────────────────────────────────────── */

/** S1 — the Ad Manager shape: 120 rows, totals, tips, Spend ↓, selection, export, footer. */
function useMetrics(): SideBuild {
  const [log, push] = useLog()
  const { selected, setSelected, selectionActions } = useSelection()
  const onExport = useCallback(() => push('onExport'), [push])
  const props = useMemo<WsProps>(() => ({
    ...BASE, rows: ROWS_120, showTotal: true, defaultSort: METRICS_SORT,
    selectable: true, selected, onSelectedChange: setSelected, selectionActions,
    exportable: true, onExport, reportLabel: 'Yesterday, 23:59 UTC', toolbarLeft: toolbarLeftNode, toolbarRight: toolbarRightNode,
  }), [selected, setSelected, selectionActions, onExport])
  return { props, above: <Log label="fired" lines={log} /> }
}
const METRICS_SORT = { key: 'spend', dir: 'desc' } as const

/** S2 — `enabledFirst`: live rows first, then paused, then archived; no header sort active. */
function useEnabledFirst(): SideBuild {
  const props = useMemo<WsProps>(() => ({ ...BASE, rows: ROWS_36, enabledFirst: ENABLED_FIRST, selectable: false }), [])
  return { props }
}

/** S3 — `groupBy` with `order`: SP · SB · SD bands, Spend ↓ inside each, totals over all. */
function useGroupBy(): SideBuild {
  const { selected, setSelected, selectionActions } = useSelection()
  const props = useMemo<WsProps>(() => ({
    ...BASE, rows: ROWS_36, groupBy: GROUP_BY_PRODUCT, defaultSort: METRICS_SORT, showTotal: true,
    selectable: true, selected, onSelectedChange: setSelected, selectionActions,
  }), [selected, setSelected, selectionActions])
  return { props }
}

/** S4 — right-pinned columns with widths on a column set wide enough to scroll at any viewport. */
const extra = (key: string, label: string, f: (r: ParityRow) => number, fmt: (n: number) => string): GridColumn<ParityRow> => ({
  key, label, sortable: true, width: 120, render: (r) => fmt(f(r)), sortValue: f,
})
const roas = (r: ParityRow) => (r.spend > 0 ? Math.round((r.sales / r.spend) * 100) / 100 : 0)
const cvr = (r: ParityRow) => (r.clicks > 0 ? Math.round((r.orders / r.clicks) * 10000) / 100 : 0)
const cpa = (r: ParityRow) => (r.orders > 0 ? Math.round((r.spend / r.orders) * 100) / 100 : 0)
const aov = (r: ParityRow) => (r.orders > 0 ? Math.round((r.sales / r.orders) * 100) / 100 : 0)
const two = (n: number) => n.toFixed(2)
const pct2 = (n: number) => `${n.toFixed(2)}%`
const WIDE_COLUMNS: GridColumn<ParityRow>[] = [
  ...WS_COLUMNS.filter((c) => !c.freezeRight),
  extra('roas', 'ROAS', roas, two), extra('cvr', 'CVR', cvr, pct2), extra('cpa', 'CPA', cpa, eur), extra('aov', 'AOV', aov, eur),
  extra('ntb', 'NTB-Orders', (r) => Math.round(r.orders * 0.31), String), extra('units', 'Sale Units', (r) => Math.round(r.orders * 1.2), String),
  ...WS_COLUMNS.filter((c) => c.freezeRight),
]
function useFreezeRight(): SideBuild {
  const props = useMemo<WsProps>(() => ({ ...BASE, rows: ROWS_24, columns: WIDE_COLUMNS, showTotal: true, defaultSort: METRICS_SORT, selectable: false }), [])
  return { props }
}

/** S5 — selection with two rows already ticked, so the selected-row paint is on screen to measure. */
function useSelected(): SideBuild {
  const { selected, setSelected, selectionActions } = useSelection(WS_SELECTED_INITIAL)
  const props = useMemo<WsProps>(() => ({
    ...BASE, rows: ROWS_24, selectable: true, selected, onSelectedChange: setSelected, selectionActions,
  }), [selected, setSelected, selectionActions])
  return { props, above: <Button size="sm" onClick={() => setSelected(new Set([ROW_ID(ROWS_24[5]), 'off-page-selection']))}>Replace selection</Button> }
}

/** S6 — edit mode: the bulk toggle AND the hover pencil, one field, its own popover editor. */
const budgetInitial = (r: ParityRow) => String(r.budget)
const renderBudgetField = (v: string, set: (n: string) => void) => (
  <Input value={v} onChange={(e) => set(e.target.value)} aria-label="Daily budget" size="sm" prefix="€" inputMode="decimal" />
)
const renderBudgetPopover = (v: string, set: (n: string) => void) => (
  <Input size="sm" value={v} onChange={(e) => set(e.target.value)} aria-label="Daily budget" inputMode="decimal" />
)
function useEditMode(): SideBuild {
  const [log, push] = useLog()
  const onApply = useCallback(async (edits: Array<{ id: string; values: Record<string, string> }>) => {
    push(`onApply ${edits.length} edit${edits.length === 1 ? '' : 's'}: ${edits.map((e) => `${e.id}→${e.values.budget}`).join(', ')}`)
  }, [push])
  const editMode = useMemo<GridEditMode<ParityRow>>(() => ({
    label: 'Edit budgets',
    fields: [{ key: 'budget', initial: budgetInitial, render: renderBudgetField, renderPopover: renderBudgetPopover }],
    onApply,
  }), [onApply])
  const props = useMemo<WsProps>(() => ({ ...BASE, rows: ROWS_24, editMode, selectable: true }), [editMode])
  return { props, above: <Log label="fired" lines={log} /> }
}

/** S7 — the inline 🔍, seeded from a URL-shaped `initialSearch`, echoing through `onSearchChange`. */
function useSearch(): SideBuild {
  const [log, push] = useLog()
  const onSearchChange = useCallback((q: string) => push(`onSearchChange "${q}"`), [push])
  const props = useMemo<WsProps>(() => ({
    ...BASE, rows: ROWS_36, searchable: true, searchPlaceholder: 'Search campaigns…', searchValue: SEARCH_VALUE, initialSearch: 'Brand', onSearchChange, selectable: false,
  }), [onSearchChange])
  return { props, above: <Log label="fired" lines={log} /> }
}

/** S8 — the grid's own filter panel: range / select / multiselect, presets, a seeded filter, the emit. */
const INITIAL_FILTERS: FilterState = { product: 'SP' }
function useFilters(): SideBuild {
  const [log, push] = useLog()
  const onFilterChange = useCallback((f: Record<string, unknown>) => push(`onFilterChange ${JSON.stringify(f)}`), [push])
  const props = useMemo<WsProps>(() => ({
    ...BASE, rows: ROWS_36, filters: WS_FILTERS, filterPresetsKey: 'lab:parity:ws:presets', filtersDefaultOpen: true, initialFilters: INITIAL_FILTERS, onFilterChange, showTotal: true, selectable: false,
  }), [onFilterChange])
  return { props, above: <Log label="fired" lines={log} /> }
}

/** S9 — drill-down: a two-level tree in flat tree order, chevrons inside the identity cell, a remainder row. */
const depthOf = (r: ParityRow) => r.depth ?? 0
const expandableOf = (r: ParityRow) => !!r.expandable
const isRemainder = (r: ParityRow) => !!r.remainder
function useHierarchy(): SideBuild {
  const [expanded, setExpanded] = useState<Set<string>>(TREE_EXPANDED_INITIAL)
  const onToggle = useCallback((row: ParityRow, next: boolean) => setExpanded((s) => { const n = new Set(s); if (next) n.add(row.id); else n.delete(row.id); return n }), [])
  const hierarchy = useMemo<GridHierarchy<ParityRow>>(() => ({ depthOf, expandableOf, expanded, onToggle, isRemainder }), [expanded, onToggle])
  // The rows the grid shows follow the open set — the consumer owns the tree, the grid draws it.
  const rows = useMemo(() => ROWS_TREE.filter((r) => !r.parentId || expanded.has(r.parentId)), [expanded])
  const { selected, setSelected, selectionActions } = useSelection()
  const props = useMemo<WsProps>(() => ({
    ...BASE, rows, hierarchy, selectable: true, selected, onSelectedChange: setSelected, selectionActions,
  }), [rows, hierarchy, selected, setSelected, selectionActions])
  return { props }
}

/** S10 — server mode: 50 rows verbatim, 120 in the result, the page size a query parameter. */
function useServer(): SideBuild {
  const [log, push] = useLog()
  const [rowsPerPage, setRowsPerPage] = useState(50)
  const onRowsPerPageChange = useCallback((n: number) => { setRowsPerPage(n); push(`onRowsPerPageChange ${n}`) }, [push])
  const onSortChange = useCallback((s: { key: string; dir: 'asc' | 'desc' } | null) => push(`onSortChange ${s ? `${s.key} ${s.dir}` : 'none'}`), [push])
  const onPageChange = useCallback((p: number) => push(`onPageChange ${p}`), [push])
  const server = useMemo(() => ({ total: 120, rowsPerPage, onRowsPerPageChange }), [rowsPerPage, onRowsPerPageChange])
  const props = useMemo<WsProps>(() => ({
    ...BASE, rows: ROWS_50, server, defaultSort: METRICS_SORT, onSortChange, onPageChange, showTotal: true, selectable: false,
  }), [server, onSortChange, onPageChange])
  return { props, above: <Log label="fired" lines={log} /> }
}

/** S11 — keyboard navigation. Both engines listen on the document, so j/k moves both panels at once here. */
function useKeyboardNav(): SideBuild {
  const [log, push] = useLog()
  const onRowKey = useCallback((r: ParityRow, key: string) => push(`onRowKey "${key}" on ${r.id}`), [push])
  const onRowClick = useCallback((r: ParityRow) => push(`onRowClick ${r.id}`), [push])
  const props = useMemo<WsProps>(() => ({ ...BASE, rows: ROWS_24, keyboardNav: true, onRowKey, onRowClick, selectable: false }), [onRowKey, onRowClick])
  return { props, above: <Log label="fired" lines={log} /> }
}

/** S12 — a clickable row (interactive children excluded) and a per-row class from the consumer. */
const rowClassName = (r: ParityRow) => (r.status === 'ARCHIVED' ? 'lab-archived' : undefined)
function useRowClick(): SideBuild {
  const [log, push] = useLog()
  const onRowClick = useCallback((r: ParityRow) => push(`onRowClick ${r.id}`), [push])
  const props = useMemo<WsProps>(() => ({ ...BASE, rows: ROWS_24, onRowClick, rowClassName, selectable: true }), [onRowClick])
  return { props, above: <Log label="fired" lines={log} /> }
}

/** S13 — loading: six skeleton rows the height of a loaded grid; header and pager as usual. */
function useLoading(): SideBuild {
  const props = useMemo<WsProps>(() => ({ ...BASE, rows: ROWS_24, loading: true, showTotal: true, selectable: true }), [])
  return { props }
}

/** S14 — empty, with the consumer's own node (title, sentence, a CTA). */
const emptyNode = (
  <EmptyState title="No campaigns here yet" description="Nothing in this account matches the current view. Clear the filters, or create the first campaign." action={<Button size="sm" variant="primary" onClick={noop}>Create campaign</Button>} />
)
function useEmptyNode(): SideBuild {
  const props = useMemo<WsProps>(() => ({ ...BASE, rows: NO_ROWS, emptyNode, showTotal: true, selectable: true }), [])
  return { props }
}
/** S14b — empty, with only `emptyLabel`. */
function useEmptyLabel(): SideBuild {
  const props = useMemo<WsProps>(() => ({ ...BASE, rows: NO_ROWS, emptyLabel: 'No campaigns match the current filters.', selectable: false }), [])
  return { props }
}

/** S15 — independent stores prevent the frozen reader from overwriting new layout fields. */
function useCustomizable(side: Side): SideBuild {
  const props = useMemo<WsProps>(() => ({ ...BASE, columns: WS_COLUMNS.map((c) => ({ ...c, group: c.freezeRight || c.align === 'left' || c.align === 'center' ? 'Settings' : 'Performance' })), rows: ROWS_24, customizable: true, storageKey: `lab:parity:ws:custom:${side}`, showTotal: true, selectable: true }), [side])
  return { props }
}

/** S16 — chromeless + controlled prefs (design §7): the Ad Manager's mode. The legacy grid has no such
 *  mode, so its side renders the SAME column subset in the same order with its chrome — toolbar and
 *  pager are exempt on this scenario by construction; rows, cells and header are compared. */
function useChromeless(side: Side): SideBuild {
  const [log, push] = useLog()
  const [prefs, setPrefs] = useState<GridPrefs>(() => ({ visible: WS_PREFS_SUBSET, stickyFirst: true, stickyLast: true }))
  const onPrefsChange = useCallback((p: GridPrefs) => { setPrefs(p); push(`onPrefsChange ${p.visible.join(',')}`) }, [push])
  const onSortChange = useCallback((s: { key: string; dir: 'asc' | 'desc' } | null) => push(`onSortChange ${s ? `${s.key} ${s.dir}` : 'none'}`), [push])
  const { selected, setSelected, selectionActions } = useSelection()
  const legacyColumns = useMemo(() => prefs.visible.map((k) => WS_COLUMNS.find((c) => c.key === k)!).filter(Boolean), [prefs.visible])
  // Chromeless renders rows VERBATIM (design §7 — the page sorts, searches and pages), so the AG side is handed the
  // rows already in Spend ↓ order, exactly as the Ad Manager page hands them; the legacy side sorts by defaultSort
  // itself. Run 2 compared a verbatim list against a sorted one and read the engine as "sorting differently".
  const props = useMemo<WsProps>(() => (side === 'ag'
    ? { ...BASE, rows: ROWS_24_BY_SPEND, chromeless: true, prefs, onPrefsChange, defaultSort: METRICS_SORT, onSortChange, selectable: true, selected, onSelectedChange: setSelected, selectionActions }
    : { ...BASE, rows: ROWS_24, columns: legacyColumns, defaultSort: METRICS_SORT, onSortChange, selectable: true, selected, onSelectedChange: setSelected, selectionActions }
  ), [side, prefs, onPrefsChange, onSortChange, selected, setSelected, selectionActions, legacyColumns])
  return { props, above: <Log label="fired" lines={log} /> }
}

/** S17 — the rules grids' pager: centred, opened on page 2 from a URL-shaped seed, emitting page changes. */
function usePagerCentered(): SideBuild {
  const [log, push] = useLog()
  const onPageChange = useCallback((p: number) => push(`onPageChange ${p}`), [push])
  const onRowClick = useCallback((r: ParityRow) => push(`onRowClick ${r.id}`), [push])
  const props = useMemo<WsProps>(() => ({ ...BASE, rows: ROWS_120, pagerCentered: true, initialPage: 2, onPageChange, selectable: false, keyboardNav: true, onRowClick }), [onPageChange, onRowClick])
  return { props, above: <Log label="fired" lines={log} /> }
}

/** S18 — the Rules & Automation shape: ONE filter bar above the page, the grid reads its state. */
export function ControlledFiltersScenario({ engines }: { engines: ParityEngines }) {
  const [fstate, setFstate] = useState<FilterState>({})
  // ONE props object for both sides — this scenario has no per-side state, and the point is that
  // both grids read the same filter state. Memoised on it, so the engines see a new object only
  // when a filter actually changed.
  const sharedProps = useMemo<WsProps>(() => ({
    ...BASE, rows: ROWS_36, filters: WS_FILTERS, filterState: fstate, onFilterStateChange: setFstate, hideFilterPanel: true, showTotal: true, selectable: false,
  }), [fstate])
  const useSide = useCallback((): SideBuild => ({ props: sharedProps }), [sharedProps])
  return (
    <WsPair
      id="controlled-filters"
      title="hideFilterPanel + controlled filterState — one bar, two grids, one state"
      note="The bar is rendered once, above both panels. A range or a selection must narrow BOTH grids identically; the unmeasured rows (blank ACoS) must leave both when an ACoS range is set."
      header={<AdsFilterBar filters={WS_FILTERS} value={fstate} onChange={setFstate} defaultOpen />}
      engines={engines}
      useSide={useSide}
    />
  )
}

/* ── the list ────────────────────────────────────────────────────────────────────────────────── */

export interface WsScenarioDef { id: string; title: string; note?: ReactNode; useSide: UseSide; exempt?: string[] }

export const WS_SCENARIOS: WsScenarioDef[] = [
  { id: 'metrics', title: 'Plain metrics — showTotal · tips · defaultSort Spend ↓ · selection · export · footer', note: '120 rows, so the pager has a second page. Sort ACoS in both: the blank rows must sink in BOTH directions, and the third click clears the sort.', useSide: useMetrics },
  { id: 'enabled-first', title: 'enabledFirst — live campaigns first, no header sort active', note: 'Enabled, then paused, then archived; the fixture order holds within each band. Clicking a header hands the order to that column; the third click restores the banding.', useSide: useEnabledFirst },
  { id: 'group-by', title: 'groupBy with order — SP · SB · SD bands', note: 'Explicit `order` beats alphabetical (SB < SD < SP). Each band prints its label and its count; Spend ↓ orders rows inside a band; totals cover every row.', useSide: useGroupBy },
  { id: 'freeze-right', title: 'freezeRight columns with width — Daily Budget + Actions pinned right', note: 'Eighteen columns, so the grid scrolls sideways at any viewport; the two pinned columns keep their widths and the leftmost carries the separator (fzr0).', useSide: useFreezeRight },
  { id: 'selection', title: 'selectable + selectionActions — two rows pre-selected', note: 'The selected-row paint is on screen from the first render. Ticking the header checkbox selects the page; the toolbar count swaps to "Selected N campaigns" and the bulk actions appear.', useSide: useSelected },
  { id: 'edit-mode', title: 'editMode — bulk toggle and the hover pencil, one field with renderPopover', note: 'Edit budgets swaps the Daily Budget cells to inputs and the toolbar to Discard / Apply. Hover a row: the pencil appears on that cell and opens the popover, which uses the inline editor.', useSide: useEditMode },
  { id: 'search', title: 'searchable — initialSearch "Brand", searchValue over name + market, onSearchChange', note: 'The 🔍 opens expanded because a search is seeded; every keystroke narrows and emits.', useSide: useSearch },
  { id: 'filters', title: 'filters (range · select · multiselect) + filterPresetsKey + initialFilters + onFilterChange', note: 'The grid renders its own panel, seeded with Type = Sponsored Products. Presets persist under a lab-only key.', useSide: useFilters },
  { id: 'hierarchy', title: 'hierarchy — two levels, chevrons in the identity cell, a remainder row', note: 'Portfolios open by default with their campaigns beneath; "Other campaigns" is arithmetic — italic, unselectable, no checkbox. Rows stay in tree order whatever the header says.', useSide: useHierarchy },
  { id: 'server', title: 'server mode — rows verbatim, count from server.total, page size a query parameter', note: '50 rows shown of 120; the pager says 1-50 of 120 and three pages; the header click emits onSortChange and reorders nothing.', useSide: useServer },
  { id: 'keyboard-nav', title: 'keyboardNav + onRowKey — j/k move the focus row, Enter fires onRowClick', note: 'Both panels listen on the document, so a keypress moves both — which is itself the parity check. Focus a row and press a letter: onRowKey fires with it.', useSide: useKeyboardNav },
  { id: 'row-click', title: 'onRowClick + rowClassName — clickable rows, archived rows carry a consumer class', note: 'A click on the checkbox, the Open pill or the Pause button must NOT count as a row click in either engine.', useSide: useRowClick },
  { id: 'loading', title: 'loading — six skeleton rows', note: 'The loading grid is the height of a loaded one; header and pager render as usual.', useSide: useLoading },
  { id: 'empty-node', title: 'empty with emptyNode — the consumer’s own empty state', note: 'Centred, 28px padding, wraps; totals row absent.', useSide: useEmptyNode, exempt: ['totals'] },
  { id: 'empty-label', title: 'empty with emptyLabel only', useSide: useEmptyLabel, exempt: ['totals'] },
  { id: 'customizable', title: 'customizable + storageKey — the DS PreferencesModal', note: 'Each engine keeps its own lab layout; the AG side supports groups and pins. CPC is defaultHidden.', useSide: useCustomizable },
  { id: 'chromeless', title: 'chromeless + controlled prefs (AG only) — the Ad Manager’s mode', note: 'The AG side renders only the grid card with a controlled column subset; the legacy side renders the same subset with its chrome (it has no chromeless mode). Toolbar and pager are exempt here; rows, cells and header are compared.', useSide: useChromeless, exempt: ['toolbar', 'pager'] },
  { id: 'pager-centered', title: 'pagerCentered + initialPage 2 + onPageChange', note: 'Opens on page 2 of 2; the pager sits in the middle.', useSide: usePagerCentered },
]

export function WorkspaceScenarios({ engines, scenario = 'all' }: { engines: ParityEngines; scenario?: string }) {
  return (
    <>
      {WS_SCENARIOS.filter((s) => scenario === 'all' || s.id === scenario).map((s) => <WsPair key={s.id} id={s.id} title={s.title} note={s.note} engines={engines} useSide={s.useSide} exempt={s.exempt} />)}
      {(scenario === 'all' || scenario === 'controlled-filters') && <ControlledFiltersScenario engines={engines} />}
    </>
  )
}
