'use client'

/**
 * AGD — the DS `DataGrid` (`components/DataGrid.tsx`) on AG Grid Enterprise, behind the IDENTICAL
 * `DataGridProps<T>` / `Column<T>`: a consumer changes only its import path.
 *
 * What the engine owns: the header (the Owner's exemption — AG's chrome, sort indicator, column
 * menu, drag and resize), the row model, pinning, the pinned totals row, the tree that carries
 * `getSubRows` children and `renderExpanded` sub rows under their parent through a sort. What is
 * the legacy's, lifted line for line: the sort cycle and comparator (`columns.ts`), the selection
 * arithmetic (`rows.ts`), the preferences storage and reconciliation (`prefs.ts`), the Customise
 * chrome (the prefs bar, the DS `PreferencesModal` with the same wiring). What is restated for
 * AG's DOM with the legacy's tokens: `datagrid.css`. The design: docs/2026-09-05-ads-console-on-
 * ag-grid-design.md §6; the lane-owner decisions 1-7 are cited where they land.
 *
 * Three rules this file keeps that a reader might otherwise "simplify" away:
 *   1. The column DEFINITIONS depend on structure only (`columnsSignature`); the row-reading
 *      functions are reached through a context holder rewritten every render. A consumer that
 *      rebuilds its `columns` array each render (38 of the 47 ads sites) must not make AG rebuild
 *      its column model — and the cells it does rebuild must not REMOUNT, because seven sites keep
 *      inputs inside cells that commit on blur. So changes reach the DOM by `refreshCells` (a
 *      re-render) and by attribute/class toggles on the row element, never by `redrawRows`.
 *   2. Selection is the consumer's Set, drawn with the legacy's NATIVE checkboxes (the 15px
 *      accent-coloured box `components.css:1490` styles) — AG's own selection would draw a
 *      different glyph and count collapsed children the legacy never counted.
 *   3. Rows are CONTENT-DRIVEN (lane-owner decision 2): every column is `autoHeight` and the
 *      cell carries the tier's vertical padding, so a one-line row is the legacy floor
 *      (`geometry.ts`) and a two-line cell grows its row as the `<td>` did.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import type {
  ColDef, ColumnMovedEvent, ColumnResizedEvent, DisplayedColumnsChangedEvent, FirstDataRenderedEvent, GetRowIdParams, GridApi,
  GridReadyEvent, GridSizeChangedEvent, IRowNode, IsFullWidthRowParams, ModelUpdatedEvent, RowClassParams, RowClassRules,
  RowDataUpdatedEvent, SortChangedEvent,
} from 'ag-grid-community'

import { ToolbarButton } from '@/design-system/primitives'
// The pattern FILE, not the `../patterns` barrel — the barrel would be a cycle (see the note in the legacy grid).
import { PreferencesModal } from '@/design-system/patterns/PreferencesModal'
import { withVisibleColumnOrder } from '../preferencesLayout'

import type { Column, DataGridProps } from '../../components/DataGrid'
import { TooltipPortalProvider } from '@/design-system/primitives/Tooltip'
import { NexusGrid } from '../NexusGrid'
import { rendererOwnsKeyboard } from '../rendererKeyboard'
import {
  LabelHeaderRenderer, SelectAllHeaderRenderer, SelectCellRenderer, SubRowRenderer, ValueCellRenderer,
  type DgContext, type DgContextHolder,
} from './cells'
import { CK_COL, SORTING_ORDER, buildColDefs, columnsSignature, orderColumns, splitColumns } from './columns'
import { geometryFor, geometryVars } from './geometry'
import {
  defaultPrefs, parseStoredPrefs, readStoredRaw, reconcileStoredPrefs, visibleOrderFromColumnState, withWidth, writeStoredPrefs,
  type DataGridPrefs, type SortSpec,
} from './prefs'
import { registerDelegation, type HandlerBag } from './rowEvents'
import { applyTo, clearFrom, splitElementProps } from './rowDom'
import { flattenRows, isSubRow, isTotalRow, selectableKeys, type DgRow, type RowMeta, type TotalRow } from './rows'
import { dataGridTheme } from './theme'
import './datagrid.css'

const RENDERERS = { value: ValueCellRenderer, select: SelectCellRenderer, selectAll: SelectAllHeaderRenderer, labelHeader: LabelHeaderRenderer }
const DEFAULT_COL_DEF: ColDef = { sortingOrder: SORTING_ORDER, suppressKeyboardEvent: rendererOwnsKeyboard, suppressHeaderKeyboardEvent: rendererOwnsKeyboard }
const EMPTY_DIALOG = {}
const EMPTY_META: ReadonlyMap<unknown, RowMeta> = new Map()

const sortOfState = (api: GridApi): SortSpec | null => {
  const s = api.getColumnState().filter((c) => c.sort).sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))[0]
  return s && s.sort ? { key: s.colId, dir: s.sort } : null
}
const sameSort = (a: SortSpec | null | undefined, b: SortSpec | null | undefined): boolean =>
  (a?.key ?? null) === (b?.key ?? null) && (a?.dir ?? null) === (b?.dir ?? null)
const cssLength = (v: number | string): string => (typeof v === 'number' ? `${v}px` : v)
const rowElement = (root: HTMLElement, id: string | null | undefined): HTMLElement | null =>
  id == null ? null : (root.querySelector(`.ag-row[row-id="${CSS.escape(id)}"]`) as HTMLElement | null)

/**
 * The universal data grid (`.nds-grid`): sortable headers, row selection with select-all, sticky
 * header, pinned columns, an optional sticky totals row, and an empty state. Generic over the row type.
 */
export function DataGrid<T>({
  columns,
  rows,
  rowKey,
  selectable,
  selected,
  onSelectedChange,
  rowSelectable,
  rowSelectableHint,
  selectAllHint,
  selectRowHint,
  showTotals,
  emptyState, renderExpanded, expanded, rowProps, size = 'md', headerProps, cellProps, getSubRows, subRowSelectable,
  initialSort,
  sort: controlledSort,
  onSortChange,
  rowClassName,
  maxHeight,
  className,
  ariaLabel,
  keyboardScroll = false,
  customizable,
  storageKey,
  customizeOpen,
  onCustomizeOpenChange,
  customizeTitle,
  prefsSortFields,
}: DataGridProps<T>) {
  type Row = DgRow<T>
  const geometry = geometryFor(size)
  const geometryRef = useRef(geometry); geometryRef.current = geometry
  const treeMode = !!getSubRows || !!renderExpanded
  const bounded = maxHeight != null

  // ── AG handles ────────────────────────────────────────────────────────────────────────────────
  const apiRef = useRef<GridApi<Row> | null>(null)
  const [apiReady, setApiReady] = useState(false)
  const ariaLabelRef = useRef(ariaLabel); ariaLabelRef.current = ariaLabel
  const wrapRef = useRef<HTMLDivElement | null>(null)

  // ── a bounded grid (`maxHeight`, lane-owner decision 4): the normal layout at min(content, maxHeight) ──
  // The content height is read back after every model update (AG's row auto-height ends in `modelUpdated`:
  // the client-side model's `onRowHeightChanged` is a `refreshModel`) and after the pinned row is re-measured.
  const [naturalHeight, setNaturalHeight] = useState<number>(() =>
    Math.ceil(geometry.headerHeight + rows.length * geometry.rowHeight + (showTotals && rows.length ? geometry.totalsHeight : 0)),
  )
  const measurePending = useRef(0)
  const measureNatural = useCallback(() => {
    cancelAnimationFrame(measurePending.current)
    measurePending.current = requestAnimationFrame(() => {
      const api = apiRef.current
      const root = wrapRef.current
      if (!api || api.isDestroyed() || !root) return
      const n = api.getDisplayedRowCount()
      const last = n ? api.getDisplayedRowAtIndex(n - 1) : undefined
      const body = last ? (last.rowTop ?? 0) + (last.rowHeight ?? 0) : 0
      const header = (root.querySelector('.ag-header') as HTMLElement | null)?.offsetHeight ?? geometryRef.current.headerHeight
      const pinned = api.getPinnedBottomRow(0)?.rowHeight ?? 0
      const hscroll = (root.querySelector('.ag-body-horizontal-scroll') as HTMLElement | null)?.offsetHeight ?? 0
      const next = Math.ceil(header + body + pinned + hscroll)
      setNaturalHeight((prev) => (prev === next ? prev : next))
    })
  }, [])
  useEffect(() => () => cancelAnimationFrame(measurePending.current), [])

  // ── sort (DataGrid.tsx:264-270): `undefined` = uncontrolled, `null` = controlled and unsorted ──
  const [ownSort, setOwnSort] = useState<SortSpec | null>(initialSort ?? null)
  const controlled = controlledSort !== undefined
  const sort = controlled ? controlledSort : ownSort
  const sortRef = useRef(sort); sortRef.current = sort
  const applyingSortRef = useRef(false)

  // ── Column preferences (DataGrid.tsx:272-453, inert unless `customizable`) ───────────────────
  const [ownPrefsOpen, setOwnPrefsOpen] = useState(false)
  const prefsControlled = customizeOpen !== undefined
  const prefsOpen = customizeOpen ?? ownPrefsOpen
  const setPrefsOpen = (next: boolean) => {
    onCustomizeOpenChange?.(next)
    if (!prefsControlled) setOwnPrefsOpen(next)
  }
  const { lockedLead, lockedTrail, togglableKeys, defaultLockedKeys, prefsColumns, anyPinned } = useMemo(() => splitColumns(columns), [columns])
  const [prefs, setPrefs] = useState<DataGridPrefs>(() => defaultPrefs(togglableKeys, defaultLockedKeys))
  const prefsRef = useRef(prefs); prefsRef.current = prefs
  // Once per storageKey, never in the state initializer (hydration); the ref, not a dep list, makes it once —
  // a call site that builds `columns` inline hands us a new array every render.
  const loadedFor = useRef<string | null>(null)
  // 🔴 A ref cannot gate the writer (DataGrid.tsx:337-343): a state flag defers it to the next render.
  const [prefsLoaded, setPrefsLoaded] = useState(false)
  const applySort = (next: SortSpec) => {
    onSortChange?.(next)
    if (!controlled) setOwnSort(next)
  }
  const applySortRef = useRef(applySort); applySortRef.current = applySort
  useEffect(() => {
    if (!customizable || !storageKey || loadedFor.current === storageKey) return
    loadedFor.current = storageKey
    const saved = parseStoredPrefs(readStoredRaw(storageKey))
    if (saved) {
      const { patch, restoredSort } = reconcileStoredPrefs(saved, { togglableKeys, defaultLockedKeys, prefsSortFields })
      setPrefs((prev) => ({ ...prev, ...patch }))
      // The ROWS have to move too, not just the dialog's copy of the value.
      if (restoredSort) applySortRef.current(restoredSort)
    }
    setPrefsLoaded(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customizable, storageKey, togglableKeys])
  useEffect(() => {
    if (!customizable || !storageKey || !prefsLoaded) return
    writeStoredPrefs(storageKey, prefs, togglableKeys)
  }, [prefs, customizable, storageKey, togglableKeys, prefsLoaded])
  const togglableSet = useMemo(() => new Set(togglableKeys), [togglableKeys])
  const togglableSetRef = useRef(togglableSet); togglableSetRef.current = togglableSet
  const defaultsRef = useRef({ togglableKeys, defaultLockedKeys }); defaultsRef.current = { togglableKeys, defaultLockedKeys }

  // The operator's order IS the render order; untouched when `customizable` is absent.
  const cols = useMemo(
    () => orderColumns(columns, prefs.visibleColumns, !!customizable, lockedLead, lockedTrail, prefs.lockedColumns),
    [customizable, columns, prefs.visibleColumns, prefs.lockedColumns, lockedLead, lockedTrail],
  )
  const hiddenCols = useMemo(() => (customizable ? columns.filter((c) => !cols.includes(c)) : []), [customizable, columns, cols])
  // The operator's toggle GATES the developer's flag.
  const pinLeft = !customizable || prefs.stickyFirstColumn
  const pinRight = !customizable || prefs.stickyLastColumn

  // ── the rows AG is handed: the legacy's order, as a tree when kids / sub rows exist ───────────
  const flat = useMemo(
    () => (treeMode ? flattenRows({ rows, rowKey, expanded, getSubRows, renderExpanded }) : null),
    [treeMode, rows, rowKey, expanded, getSubRows, renderExpanded],
  )
  const rowData: Row[] = flat ? flat.data : rows
  const meta: ReadonlyMap<unknown, RowMeta> = flat ? flat.meta : EMPTY_META
  const metaRef = useRef(meta); metaRef.current = meta
  const empty = rows.length === 0

  // ── selection (DataGrid.tsx:477-504): a controlled Set, the legacy arithmetic ────────────────
  const allKeys = useMemo(
    () => selectableKeys({ rows, rowKey, rowSelectable, subRowSelectable, getSubRows, expanded }),
    [rows, rowKey, rowSelectable, subRowSelectable, getSubRows, expanded],
  )
  const selCount = selected?.size ?? 0
  const allSelected = !!selectable && selCount > 0 && allKeys.length > 0 && allKeys.every((k) => selected!.has(k))
  const someSelected = !!selectable && selCount > 0 && !allSelected
  const toggleAll = useCallback(() => onSelectedChange?.(allSelected ? new Set() : new Set(allKeys)), [onSelectedChange, allSelected, allKeys])
  const toggleRow = useCallback((k: string) => {
    if (!selected) return onSelectedChange?.(new Set([k]))
    const next = new Set(selected)
    next.has(k) ? next.delete(k) : next.add(k)
    onSelectedChange?.(next)
  }, [selected, onSelectedChange])

  // ── the context every cell reads (rewritten each render; read at call time) ───────────────────
  const rowKeyRef = useRef(rowKey); rowKeyRef.current = rowKey
  const selRef = useRef(selected); selRef.current = selected
  const rowPropsRef = useRef(rowProps); rowPropsRef.current = rowProps
  const cellPropsRef = useRef(cellProps); cellPropsRef.current = cellProps
  const headerPropsRef = useRef(headerProps); headerPropsRef.current = headerProps
  const rowClassNameRef = useRef(rowClassName); rowClassNameRef.current = rowClassName
  const columnsByKey = useMemo(() => new Map(columns.map((c) => [c.key, c] as const)), [columns])
  const columnsByKeyRef = useRef(columnsByKey); columnsByKeyRef.current = columnsByKey
  const indexByKey = useMemo(() => new Map(cols.map((c, i) => [c.key, i] as const)), [cols])
  const indexByKeyRef = useRef(indexByKey); indexByKeyRef.current = indexByKey
  const colsRef = useRef(cols); colsRef.current = cols
  const hiddenColsRef = useRef(hiddenCols); hiddenColsRef.current = hiddenCols
  const edgesRef = useRef<{ first: string | null; last: string | null }>({ first: cols[0]?.key ?? null, last: cols[cols.length - 1]?.key ?? null })
  const subHeights = useRef(new Map<string, number>())
  const totalsHeights = useRef(new Map<string, number>())
  const totalsHeightRef = useRef<number | null>(null)
  const heightPending = useRef(0)
  const requestRowHeights = useCallback(() => {
    cancelAnimationFrame(heightPending.current)
    heightPending.current = requestAnimationFrame(() => {
      const api = apiRef.current
      if (!api || api.isDestroyed()) return
      // A full-width renderer can measure before gridReady. Apply the cached size
      // once its row exists, as well as after later content/width changes.
      for (const [id, height] of subHeights.current) {
        const node = api.getRowNode(id)
        if (node && node.rowHeight !== height) node.setRowHeight(height)
      }
      api.onRowHeightChanged()
    })
  }, [])
  const reportSubHeight = useCallback((id: string, h: number | null) => {
    if (h == null) { subHeights.current.delete(id); return }
    if (subHeights.current.get(id) === h) return
    subHeights.current.set(id, h)
    requestRowHeights()
  }, [requestRowHeights])
  const reportTotalsHeight = useCallback((colId: string, h: number | null) => {
    if (h == null) totalsHeights.current.delete(colId)
    else totalsHeights.current.set(colId, h)
    const max = totalsHeights.current.size ? Math.max(...totalsHeights.current.values()) : null
    if (max === totalsHeightRef.current) return
    totalsHeightRef.current = max
    // Pinned rows are measured when their data is set (NexusGrid): re-set it so `getRowHeight` is asked again.
    const api = apiRef.current
    if (!api || api.isDestroyed() || max == null) return
    const data = api.getGridOption('pinnedBottomRowData') as TotalRow[] | undefined
    if (data?.length) api.setGridOption('pinnedBottomRowData', [{ ...data[0] }])
    measureNatural()
  }, [measureNatural])
  const ctxHolder = useRef<DgContextHolder<T>>({ current: null as unknown as DgContext<T> })
  ctxHolder.current.current = {
    rowKey, columnsByKey,
    metaOf: (d) => metaRef.current.get(d),
    isSentinel: (d) => isSubRow(d) || isTotalRow(d),
    selectable: !!selectable, selected, rowSelectable, rowSelectableHint, selectAllHint, selectRowHint,
    subRowSelectable: !!subRowSelectable, allSelected, someSelected, toggleAll, toggleRow,
    rowProps, cellProps, rowClassName,
    indexOf: (key) => indexByKeyRef.current.get(key) ?? -1,
    get firstColId() { return edgesRef.current.first },
    get lastColId() { return edgesRef.current.last },
    reportSubHeight, reportTotalsHeight,
  }
  const ctx = ctxHolder.current as unknown as DgContextHolder<unknown>

  // ── column definitions: structure only, keyed on a structural signature ───────────────────────
  const colSig = useMemo(() => columnsSignature(columns), [columns])
  const visibleSig = cols.map((c) => c.key).join(' ')
  const hiddenSig = hiddenCols.map((c) => c.key).join(' ')
  const widthsSig = JSON.stringify(prefs.widths ?? {})
  const locksSig = JSON.stringify(customizable ? prefs.lockedColumns ?? [] : [])
  const columnDefs = useMemo<ColDef[]>(
    () => buildColDefs({ visible: colsRef.current, hidden: hiddenColsRef.current, selectable: !!selectable, pinLeft, pinRight, sort: sortRef.current, widths: prefsRef.current.widths, lockedColumns: customizable ? prefsRef.current.lockedColumns : undefined, components: RENDERERS }),
    // `columns` / `cols` / `sort` are deliberately NOT dependencies — the signatures stand for the structure, and
    // a header click must not rebuild the model (rule 1 in the file header).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [colSig, visibleSig, hiddenSig, !!selectable, pinLeft, pinRight, widthsSig, locksSig],
  )

  // ── stable AG options ─────────────────────────────────────────────────────────────────────────
  const getRowId = useCallback((p: GetRowIdParams<Row>) => {
    const d = p.data as unknown
    if (isTotalRow(d)) return '__total'
    return metaRef.current.get(d)?.id ?? rowKeyRef.current(d as T)
  }, [])
  const getDataPath = useCallback((d: Row) => metaRef.current.get(d)?.path ?? [rowKeyRef.current(d as T)], [])
  const isFullWidthRow = useCallback((p: IsFullWidthRowParams<Row>) => isSubRow(p.rowNode.data), [])
  const isGroupOpenByDefault = useCallback(() => true, [])
  const getRowHeight = useCallback((p: { node: IRowNode<Row> }) => {
    if (p.node.rowPinned) return totalsHeightRef.current ?? geometryRef.current.totalsHeight
    if (isSubRow(p.node.data)) return subHeights.current.get(p.node.id ?? '') ?? geometryRef.current.rowHeight
    return geometryRef.current.rowHeight
  }, [])
  const rowClassRules = useMemo<RowClassRules<Row>>(() => ({
    'nds-dg-tr': () => true,
    'nds-grid-kid': (p: RowClassParams<Row>) => metaRef.current.get(p.data)?.kind === 'kid',
    'nds-grid-sub': (p: RowClassParams<Row>) => isSubRow(p.data),
    'nds-dg-totals': (p: RowClassParams<Row>) => p.node.rowPinned === 'bottom',
    // `sel` on a top-level row only: a child row carried `nds-grid-kid` + `rowClassName`, never `sel` (DataGrid.tsx:631).
    sel: (p: RowClassParams<Row>) => {
      const d = p.data as unknown
      if (d == null || isSubRow(d) || isTotalRow(d) || p.node.rowPinned || metaRef.current.get(d)?.kind === 'kid') return false
      return !!selRef.current?.has(rowKeyRef.current(d as T))
    },
    first: (p: RowClassParams<Row>) => !p.node.rowPinned && p.node.rowIndex === 0,
    last: (p: RowClassParams<Row>) => !p.node.rowPinned && p.node.rowIndex === p.api.getDisplayedRowCount() - 1,
  }), [])
  const getRowClass = useCallback((p: RowClassParams<Row>) => {
    const d = p.data as unknown
    if (d == null || isSubRow(d) || isTotalRow(d) || p.node.rowPinned) return undefined
    const own = rowClassNameRef.current?.(d as T)
    // The legacy spread `rowProps` BEFORE `className` and so discarded a `className` inside it; the lane owner
    // asked for it to apply (decision 1) — no consumer passes one.
    const fromProps = rowPropsRef.current?.(d as T)?.className
    return [own, fromProps].filter(Boolean).join(' ') || undefined
  }, [])
  const totalsVersion = useRef(0)
  const pinnedBottomRowData = useMemo<TotalRow[] | undefined>(() => {
    if (!showTotals || rows.length === 0) return undefined
    totalsVersion.current += 1
    return [{ __total: true, v: totalsVersion.current }]
  }, [showTotals, rows])
  const columnDialog = useMemo(
    () => (customizable
      ? { customise: () => setPrefsOpen(true), reset: () => setPrefs(defaultPrefs(defaultsRef.current.togglableKeys, defaultsRef.current.defaultLockedKeys)) }
      : EMPTY_DIALOG),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [customizable, prefsControlled],
  )

  // ── the edges, the header attributes, the edge rows: what AG's DOM is told by hand ────────────
  const updateEdges = useCallback((api: GridApi<Row>) => {
    const data = (api.getAllDisplayedColumns() ?? []).filter((c) => c.getColId() !== CK_COL)
    const next = { first: data[0]?.getColId() ?? null, last: data[data.length - 1]?.getColId() ?? null }
    const changed = next.first !== edgesRef.current.first || next.last !== edgesRef.current.last
    edgesRef.current = next
    return changed
  }, [])
  const applyHeaderProps = useCallback(() => {
    const root = wrapRef.current
    const hp = headerPropsRef.current
    if (!root) return
    for (const el of root.querySelectorAll<HTMLElement>('.ag-header-cell[col-id]')) {
      const id = el.getAttribute('col-id') ?? ''
      const c = columnsByKeyRef.current.get(id)
      const i = indexByKeyRef.current.get(id)
      if (!hp || !c || i == null) { clearFrom(el); continue }
      applyTo(el, splitElementProps(hp(c, i) as Record<string, unknown>))
    }
  }, [])
  const edgeRowsRef = useRef<{ first: string | null; last: string | null }>({ first: null, last: null })
  const syncEdgeRows = useCallback(() => {
    const api = apiRef.current
    const root = wrapRef.current
    if (!api || api.isDestroyed() || !root) return
    const n = api.getDisplayedRowCount()
    const next = { first: n ? api.getDisplayedRowAtIndex(0)?.id ?? null : null, last: n ? api.getDisplayedRowAtIndex(n - 1)?.id ?? null : null }
    const prev = edgeRowsRef.current
    if (prev.first === next.first && prev.last === next.last) return
    rowElement(root, prev.first)?.classList.remove('first')
    rowElement(root, prev.last)?.classList.remove('last')
    rowElement(root, next.first)?.classList.add('first')
    rowElement(root, next.last)?.classList.add('last')
    edgeRowsRef.current = next
  }, [])

  useEffect(() => () => cancelAnimationFrame(heightPending.current), [])

  // ── column widths: auto-size to content, then fit the box like a `<table width=100%>` ──
  /**
   * A `<table width=100%>` with `table-layout: auto` and nowrap cells: columns are at least their content, the
   * slack goes to the AUTO columns (a widthed column keeps its hint unless every column is widthed — then all
   * grow, as `table-layout: fixed` did), and the table is as wide as the wrapper's CONTENT box — inside a
   * vertical scrollbar, which a bounded grid grows the moment its height is capped. So this fits in BOTH
   * directions: it stretches into slack and gives back what a scrollbar took, but never shrinks an auto column
   * below the width its content measured (`contentWidths`, recorded by `fitColumns`), so a grid whose content
   * is wider than its box overflows sideways exactly as the table did. AG fits to its own body width, which
   * already excludes the scrollbar. Persisted widths count as widthed.
   */
  const contentWidths = useRef(new Map<string, number>())
  const fitToBox = useCallback(() => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    const displayed = api.getAllDisplayedColumns()
    if (!displayed.length || !(wrapRef.current?.clientWidth ?? 0)) return
    const widths = prefsRef.current.widths ?? {}
    const isWidthed = (id: string) => id === CK_COL || widths[id] != null || columnsByKeyRef.current.get(id)?.width != null
    const anyAuto = displayed.some((c) => !isWidthed(c.getColId()))
    api.sizeColumnsToFit({
      columnLimits: displayed.map((c) => {
        const id = c.getColId()
        if (anyAuto && isWidthed(id)) return { key: id, minWidth: c.getActualWidth(), maxWidth: c.getActualWidth() }
        const content = contentWidths.current.get(id)
        return content != null ? { key: id, minWidth: content } : { key: id, minWidth: c.getActualWidth() }
      }),
    })
  }, [])
  const fitColumns = useCallback(() => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    const cols = (api.getAllGridColumns() ?? []).filter((c) => !c.getColDef().suppressAutoSize && c.isVisible())
    if (cols.length) api.autoSizeColumns(cols, false)
    contentWidths.current = new Map(cols.map((c) => [c.getColId(), c.getActualWidth()]))
    fitToBox()
  }, [fitToBox])
  const fitPending = useRef(0)
  const scheduleFit = useCallback(() => {
    cancelAnimationFrame(fitPending.current)
    fitPending.current = requestAnimationFrame(() => fitColumns())
  }, [fitColumns])
  useEffect(() => () => cancelAnimationFrame(fitPending.current), [])

  // ── AG events ─────────────────────────────────────────────────────────────────────────────────
  const onGridReady = useCallback((e: GridReadyEvent<Row>) => {
    apiRef.current = e.api
    e.api.setGridAriaProperty('label', ariaLabelRef.current ?? null)
    setApiReady(true)
    updateEdges(e.api)
    applyHeaderProps()
  }, [updateEdges, applyHeaderProps])
  const onFirstDataRendered = useCallback((_e: FirstDataRenderedEvent<Row>) => { scheduleFit(); requestRowHeights(); syncEdgeRows(); measureNatural() }, [scheduleFit, requestRowHeights, syncEdgeRows, measureNatural])
  const onGridSizeChanged = useCallback((_e: GridSizeChangedEvent<Row>) => { fitToBox(); measureNatural() }, [fitToBox, measureNatural])
  const onSortChanged = useCallback((e: SortChangedEvent<Row>) => {
    if (applyingSortRef.current || e.source !== 'uiColumnSorted') return
    const next = sortOfState(e.api)
    if (!next) return
    // The legacy `toggleSort` (DataGrid.tsx:468-475): report, and keep it unless the consumer controls it.
    applySortRef.current(next)
    syncEdgeRows()
  }, [syncEdgeRows])
  const onColumnMoved = useCallback((e: ColumnMovedEvent<Row>) => {
    if (!e.finished || e.source !== 'uiColumnMoved') return
    if (customizable) {
      const visibleColumns = visibleOrderFromColumnState(e.api.getColumnState(), togglableSetRef.current)
      setPrefs((p) => ({ ...withVisibleColumnOrder(p, visibleColumns), visibleColumns }))
    }
  }, [customizable])
  const onColumnResized = useCallback((e: ColumnResizedEvent<Row>) => {
    if (!e.finished || e.source !== 'uiColumnResized' || !customizable) return
    setPrefs((p) => {
      let next = p
      for (const c of e.columns ?? (e.column ? [e.column] : [])) next = withWidth(next, c.getColId(), c.getActualWidth())
      return next
    })
  }, [customizable])
  const onDisplayedColumnsChanged = useCallback((e: DisplayedColumnsChangedEvent<Row>) => {
    if (updateEdges(e.api)) {
      e.api.refreshCells({ force: true, suppressFlash: true })
      e.api.refreshHeader()
    }
    applyHeaderProps()
    measureNatural()
  }, [updateEdges, applyHeaderProps, measureNatural])
  const onModelUpdated = useCallback((_e: ModelUpdatedEvent<Row>) => { syncEdgeRows(); measureNatural() }, [syncEdgeRows, measureNatural])
  const onRowDataUpdated = useCallback((_e: RowDataUpdatedEvent<Row>) => { syncEdgeRows(); measureNatural() }, [syncEdgeRows, measureNatural])

  // ── effects that keep AG in step with React ───────────────────────────────────────────────────
  // The sort: React state is the truth (controlled or own); AG follows — no echo, the read-back compares first.
  const sortKey = sort?.key ?? null
  const sortDir = sort?.dir ?? null
  useEffect(() => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    if (sameSort(sortOfState(api), sort)) return
    applyingSortRef.current = true
    api.applyColumnState({ state: sort ? [{ colId: sort.key, sort: sort.dir, sortIndex: 0 }] : [], defaultState: { sort: null } })
    applyingSortRef.current = false
    syncEdgeRows()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiReady, sortKey, sortDir, columnDefs])
  useEffect(() => {
    const api = apiRef.current
    if (api && !api.isDestroyed()) api.setGridAriaProperty('label', ariaLabel ?? null)
  }, [ariaLabel])
  // The row-reading functions changed identity (a consumer rebuilt its columns, the selection moved): re-render
  // the cells — a refresh, never a redraw (rule 1: inputs inside cells must not remount).
  const lastCellIds = useRef<unknown[]>([])
  useEffect(() => {
    const api = apiRef.current
    const ids = [columns, selected, rowProps, cellProps, rowClassName, rowSelectable, rowSelectableHint, selectRowHint, subRowSelectable, cols]
    const changed = ids.length !== lastCellIds.current.length || ids.some((v, i) => v !== lastCellIds.current[i])
    lastCellIds.current = ids
    if (changed && api && !api.isDestroyed()) api.refreshCells({ force: true, suppressFlash: true })
  })
  // The header reads the JSX labels and the select-all state through the context: refresh it when they change.
  const lastHeaderIds = useRef<unknown[]>([])
  useEffect(() => {
    const api = apiRef.current
    const ids = [columns, allSelected, someSelected, selectAllHint, headerProps]
    const changed = ids.length !== lastHeaderIds.current.length || ids.some((v, i) => v !== lastHeaderIds.current[i])
    lastHeaderIds.current = ids
    if (changed && api && !api.isDestroyed()) { api.refreshHeader(); applyHeaderProps() }
  })
  // Column widths: auto-size to content when the column set or the rows arrive; persisted widths win.
  useEffect(() => { if (apiRef.current) scheduleFit() }, [colSig, visibleSig, empty, widthsSig, scheduleFit])
  // Decision 1 — `rowProps` / `cellProps` / `headerProps` HANDLERS, delegated to AG's elements.
  useLayoutEffect(() => {
    const root = wrapRef.current
    if (!root) return
    const dataOf = (rowEl: HTMLElement | null): T | null => {
      const api = apiRef.current
      const id = rowEl?.getAttribute('row-id')
      if (!api || api.isDestroyed() || id == null) return null
      const d = api.getRowNode(id)?.data as unknown
      return d == null || isSubRow(d) || isTotalRow(d) ? null : (d as T)
    }
    return registerDelegation({
      root,
      rowHandlers: (rowEl) => {
        const d = dataOf(rowEl)
        return d == null ? undefined : (rowPropsRef.current?.(d) as HandlerBag | undefined)
      },
      cellHandlers: (cellEl) => {
        const id = cellEl.getAttribute('col-id') ?? ''
        const c = columnsByKeyRef.current.get(id)
        const i = indexByKeyRef.current.get(id)
        const d = dataOf(cellEl.closest('.ag-row') as HTMLElement | null)
        return !c || i == null || d == null ? undefined : (cellPropsRef.current?.(d, c, i) as HandlerBag | undefined)
      },
      headerHandlers: (headerEl) => {
        const id = headerEl.getAttribute('col-id') ?? ''
        const c = columnsByKeyRef.current.get(id)
        const i = indexByKeyRef.current.get(id)
        return !c || i == null ? undefined : (headerPropsRef.current?.(c, i) as HandlerBag | undefined)
      },
    })
  }, [])

  // ── the grid card: header (AG's) → rows → the empty state under the header when there are none ──
  const wrapperStyle = useMemo<CSSProperties>(
    () => ({ ...geometryVars(geometry), ...(bounded ? { maxHeight: cssLength(maxHeight) } : {}) }),
    [geometry, bounded, maxHeight],
  )
  const gridHeight = bounded ? `min(${naturalHeight}px, ${cssLength(maxHeight)})` : undefined
  const grid = (
    <div
      ref={wrapRef}
      className={['nds-grid-wrap', 'nds-grid', 'nds-ag-dg', empty ? 'is-empty' : '', className].filter(Boolean).join(' ')}
      style={wrapperStyle}
      data-size={size}
    >
      <TooltipPortalProvider>
      <NexusGrid<Row>
        theme={dataGridTheme}
        className="nds-dg-grid"
        density={geometry.density}
        domLayout={bounded ? 'normal' : 'autoHeight'}
        height={gridHeight}
        rowHeight={geometry.rowHeight}
        getRowHeight={getRowHeight}
        rowData={rowData}
        columnDefs={columnDefs}
        getRowId={getRowId}
        treeData={treeMode}
        treeDataDisplayType="custom"
        getDataPath={getDataPath}
        isGroupOpenByDefault={isGroupOpenByDefault}
        isFullWidthRow={isFullWidthRow}
        fullWidthCellRenderer={SubRowRenderer}
        pinnedBottomRowData={pinnedBottomRowData}
        defaultColDef={DEFAULT_COL_DEF}
        context={ctx}
        rowClassRules={rowClassRules}
        getRowClass={getRowClass}
        columnDialog={columnDialog}
        suppressMultiSort
        suppressNoRowsOverlay
        suppressColumnVirtualisation
        suppressDragLeaveHidesColumns
        suppressRowTransform
        enableCellTextSelection
        suppressCellFocus={!keyboardScroll}
        onGridReady={onGridReady}
        onFirstDataRendered={onFirstDataRendered}
        onGridSizeChanged={onGridSizeChanged}
        onSortChanged={onSortChanged}
        onColumnMoved={onColumnMoved}
        onColumnResized={onColumnResized}
        onDisplayedColumnsChanged={onDisplayedColumnsChanged}
        onModelUpdated={onModelUpdated}
        onRowDataUpdated={onRowDataUpdated}
      />
      </TooltipPortalProvider>
      {empty && <div className="nds-dg-empty nds-grid-empty">{emptyState ?? 'No rows.'}</div>}
    </div>
  )

  // Not customizable ⇒ the exact element every existing consumer already renders. No wrapper, no extra node.
  if (!customizable) return grid

  return (
    <>
      {!prefsControlled && (
        <div className="nds-grid-prefsbar">
          <ToolbarButton
            icon={<SlidersHorizontal size={14} />}
            label={customizeTitle ?? 'Customise'}
            description="Choose which columns show, and drag to reorder them."
            onClick={() => setPrefsOpen(true)}
            active={prefsOpen}
            // The bar is `justify-content: flex-end`, so this button is ALWAYS at the right edge and a centred
            // bubble always overflows — measured at 21px past the viewport on the DataGrid card before this.
            tooltipAlign="end"
          />
        </div>
      )}
      {grid}
      <PreferencesModal
        attributeGroups
        groupToggles
        inViewCount
        open={prefsOpen}
        onClose={() => setPrefsOpen(false)}
        // Seeded from the LIVE sort, so opening the dialog after sorting from a header shows what is in force.
        value={{ ...prefs, sortBy: sort?.key ?? prefs.sortBy, sortDir: sort?.dir ?? prefs.sortDir }}
        onConfirm={(next) => {
          setPrefs((p) => ({ ...next, widths: p.widths }))
          // Only when the caller asked for the section — otherwise `next.sortBy` is the inert value carried through.
          if (prefsSortFields?.length && next.sortBy && (next.sortBy !== sort?.key || next.sortDir !== sort?.dir)) {
            applySort({ key: next.sortBy, dir: next.sortDir })
          }
          setPrefsOpen(false)
        }}
        allColumns={prefsColumns}
        defaultVisible={togglableKeys}
        // Page-size stays hidden — this grid paginates nothing. Sort is the CALLER's call: omitted, the section is
        // hidden and the grid sorts from its headers; supplied, the dialog drives the very same sort.
        sortFieldOptions={prefsSortFields ?? []}
        pageSizeChoices={[]}
        // No pinned columns ⇒ two toggles that move nothing.
        showSticky={anyPinned}
        title={customizeTitle ?? 'Customise columns'}
      />
    </>
  )
}

export type { Column, DataGridProps }
