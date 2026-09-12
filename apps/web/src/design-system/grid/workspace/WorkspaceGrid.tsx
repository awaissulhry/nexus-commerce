'use client'

/**
 * AGW — the ads console's workspace grid on AG Grid Enterprise.
 *
 * The props are the hand-rolled grid's, unchanged (`./types.ts`); the chrome around the rows —
 * filter panel + preset library, toolbar, pager, "Latest Report" footer, the hover-edit popover,
 * the DS Customize dialog — is the hand-rolled grid's markup, lifted verbatim; only the `<table>`
 * became `NexusGrid`. What the engine owns is the header (the Owner's exemption), sorting, paging,
 * selection, pinning, column drag and resize, grouping. What stays the shared pure modules is the
 * filtering, the search, the sort comparison, the edit diff, the rank vocabulary. The design and
 * the prop-by-prop mapping: docs/2026-09-05-ads-console-on-ag-grid-design.md §2 and §5.
 *
 * Three rules this file keeps that a reader might otherwise "simplify" away:
 *   1. The column DEFINITIONS depend on structure only (`columns.ts`); the row-reading functions
 *      are reached through a context holder rewritten every render. A consumer that rebuilds its
 *      `columns` array each render (most do) must not make AG rebuild its column model.
 *   2. The selection Set is the consumer's: AG's selection is applied FROM it and read back INTO it
 *      by merge, so ids the consumer holds for rows that are filtered out survive, as they did.
 *   3. Sorting is AG's, but "the operator sorted" is a flag this file keeps, because `enabledFirst`
 *      banding applies under a DEFAULT sort and not under a chosen one — the SF.1 rule.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Download, Pencil, Search, Settings2, X } from 'lucide-react'
import type {
  CellClickedEvent, ColDef, ColumnMovedEvent, ColumnResizedEvent, FirstDataRenderedEvent, GetRowIdParams, GridApi,
  GridReadyEvent, GridSizeChangedEvent, IRowNode, PostSortRowsParams, RowClassParams, RowClassRules, RowSelectionOptions,
  SelectionChangedEvent, SelectionColumnDef, SortChangedEvent, SortDirection,
} from 'ag-grid-community'

import { Button } from '@/design-system/primitives'
import { Listbox } from '@/design-system/components'
import { PreferencesModal, type PreferencesColumnSpec } from '@/design-system/patterns/PreferencesModal'
import { emitPrefsChanged } from '@/design-system/patterns/prefs-bus'
import { AdsFilterBar, isServerKey, stripServerKeys } from '@/design-system/patterns/workspace-grid/AdsFilterBar'
import { filterRows } from '@/design-system/patterns/workspace-grid/filterRows'
import { collectEdits } from '@/design-system/patterns/workspace-grid/editDrafts'
import { isInteractiveChild } from '@/design-system/patterns/workspace-grid/rowInteraction'

import { TooltipPortalProvider } from '@/design-system/primitives/Tooltip'
import { NexusGrid } from '../NexusGrid'
import { rendererOwnsKeyboard } from '../rendererKeyboard'
import { withVisibleColumnOrder } from '../preferencesLayout'
import {
  GroupBandRenderer, HeaderTipRenderer, IdentityCellRenderer, SelectionSkeletonRenderer, ValueCellRenderer,
  isSkeletonRow, isTotalRow, type SkeletonRow, type TotalRow, type WsContext, type WsContextHolder,
} from './cells'
import { buildColDefs, columnsSignature } from './columns'
import { createDraftStore } from './drafts'
import { bandByEnabled, collectGroupMeta, hasActiveFilters, initialPageOf, orderGroups, pageMath, pluralize, searchRows } from './pipeline'
import {
  FIRST_COL, SELECTION_COL, defaultPrefs, defaultVisibleKeys, hasStoredPrefs, readStoredPrefs, samePrefs,
  visibleOrderFromColumnState, widthsToColumnState, withWidth, writeStoredPrefs, prefsToModal, prefsFromModal,
} from './prefs'
import { adsWorkspaceTheme } from './theme'
import type { FilterState, GridEditField, GridPrefs, WorkspaceGridProps } from './types'
import './workspace.css'

/**
 * Rows are CONTENT-DRIVEN, as the legacy `<td>` was (measured on 16 console pages: 44.5 for one text line,
 * 45 for the chip row, 46 · 47.5 · 51.3 · 62 · 82.3 where a cell holds more, and four different heights inside
 * one library grid — no fixed number reproduces that). Every cell is `autoHeight` and carries the legacy
 * `12px` vertical padding (workspace.css), so a row measures 12 + content + 12 + the 1px rule. This number
 * is AG's default for rows that have no measured cell yet, and the pinned totals row's when the consumer
 * fixes nothing; a consumer that passes `rowHeight` gets FIXED rows (the Ad Manager's 50).
 */
const DEFAULT_ROW_H = 45
/** The group band: `tr.h10-am-grp td { padding: 7px 16px }` around a 13px line + the rules. */
const GROUP_ROW_H = 35
const SKELETON_ROWS: SkeletonRow[] = Array.from({ length: 6 }, (_, i) => ({ __skeleton: i }))
const SORTING_ORDER: SortDirection[] = ['asc', 'desc', null]
const PAGE_SIZES = [{ value: '50', label: '50' }, { value: '100', label: '100' }, { value: '200', label: '200' }, { value: '500', label: '500' }]
const EMPTY_META: ReadonlyMap<string, { label: string; order?: number }> = new Map()
const RENDERERS = { identity: IdentityCellRenderer, value: ValueCellRenderer, headerTip: HeaderTipRenderer }

const sortOfState = (api: GridApi): { key: string; dir: 'asc' | 'desc' } | null => {
  const s = api.getColumnState().filter((c) => c.sort).sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))[0]
  return s && s.sort ? { key: s.colId, dir: s.sort } : null
}

export function WorkspaceGrid<T>({
  rows, loading, rowId, noun,
  firstColLabel, renderFirst, firstSortValue,
  columns, filters, filterPresetsKey,
  toolbarLeft, toolbarRight, exportable, onExport, customizable = true, storageKey, hierarchy,
  selectable = true, selected, onSelectedChange,
  showTotal, totalFirst = 'Total',
  reportLabel, emptyLabel = 'No data.', emptyNode, defaultSort, enabledFirst, editMode, selectionActions,
  searchable, searchPlaceholder = 'Search…', searchValue, pagerCentered, filtersDefaultOpen = true,
  groupBy, onRowClick, keyboardNav, onRowKey, initialFilters, rowClassName,
  onSortChange, onFilterChange,
  initialPage, onPageChange, initialSearch, onSearchChange,
  filterState, onFilterStateChange, hideFilterPanel, server,
  rowHeight, chromeless, prefs: prefsProp, onPrefsChange, selectAllIds,
}: WorkspaceGridProps<T>) {
  type Row = T | SkeletonRow
  const serverMode = server != null
  const treeMode = hierarchy != null
  const rawOrder = serverMode || treeMode || !!chromeless
  const clientPaging = !rawOrder
  const prefsControlled = prefsProp !== undefined
  /** Content-driven rows unless the consumer fixes `rowHeight` (see DEFAULT_ROW_H). */
  const autoRows = rowHeight == null

  // ── AG handles ────────────────────────────────────────────────────────────────────────────────
  const apiRef = useRef<GridApi<Row> | null>(null)
  const [apiReady, setApiReady] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  // ── search / filters (legacy state, unchanged) ────────────────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(() => !!initialSearch)
  const [search, setSearch] = useState(initialSearch ?? '')
  const [ownFstate, setOwnFstate] = useState<FilterState>(initialFilters ?? {})
  const filtersControlled = filterState !== undefined
  const fstate = filtersControlled ? filterState : ownFstate
  const fstateRef = useRef(fstate)
  fstateRef.current = fstate
  const setFstate = (u: FilterState | ((s: FilterState) => FilterState)) => {
    const next = typeof u === 'function' ? u(fstateRef.current) : u
    if (filtersControlled) onFilterStateChange?.(next)
    else setOwnFstate(next)
  }
  const [presets, setPresets] = useState<Array<{ name: string; values: FilterState }>>([])
  const [presetSaveOpen, setPresetSaveOpen] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [presetRenaming, setPresetRenaming] = useState<string | null>(null)
  useEffect(() => {
    if (!filterPresetsKey) return
    try { const raw = localStorage.getItem(filterPresetsKey); if (raw) setPresets(JSON.parse(raw)) } catch { /* ignore */ }
  }, [filterPresetsKey])
  const persistPresets = (next: Array<{ name: string; values: FilterState }>) => {
    setPresets(next)
    if (filterPresetsKey) { try { localStorage.setItem(filterPresetsKey, JSON.stringify(next)) } catch { /* ignore */ } }
  }

  // ── sort: AG's; this file keeps "the operator sorted" (SF.1) ──────────────────────────────────
  const userSortedRef = useRef(false)
  const applyingSortRef = useRef(false)
  const dsKey = defaultSort?.key ?? ''
  const dsDir = defaultSort?.dir ?? 'desc'

  // ── edit mode ─────────────────────────────────────────────────────────────────────────────────
  const [editing, setEditing] = useState(false)
  const [applying, setApplying] = useState(false)
  const draftsRef = useRef(createDraftStore())
  const drafts = draftsRef.current
  const draftSnapshot = useSyncExternalStore(drafts.subscribeAll, drafts.snapshot, drafts.snapshot)
  const editByKey = useMemo(() => new Map<string, GridEditField<T>>((editMode?.fields ?? []).map((f) => [f.key, f])), [editMode])

  // ── paging ────────────────────────────────────────────────────────────────────────────────────
  const [page, setPage] = useState(() => initialPageOf(initialPage))
  const [rowsPerPage, setRowsPerPage] = useState(100)
  const [showCustomize, setShowCustomize] = useState(false)

  // ── preferences: which columns, in what order, what sticks, what was resized ──────────────────
  const defaultVisible = useMemo(() => defaultVisibleKeys(columns), [columns])
  const [ownPrefs, setOwnPrefs] = useState<GridPrefs>(() => defaultPrefs(columns))
  // A controlled consumer may hand a NEW object each render with the same content; the column definitions key
  // on the object, so the last identity whose content still holds is the one used (never a rebuilt column model).
  const rawPrefs = prefsControlled ? prefsProp : ownPrefs
  const stablePrefsRef = useRef(rawPrefs)
  if (stablePrefsRef.current !== rawPrefs && !samePrefs(stablePrefsRef.current, rawPrefs)) stablePrefsRef.current = rawPrefs
  const prefs = stablePrefsRef.current
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const updatePrefs = useCallback((next: GridPrefs, persist: boolean) => {
    if (samePrefs(prefsRef.current, next)) return
    if (prefsControlled) { onPrefsChange?.(next); return }
    setOwnPrefs(next)
    if (persist && storageKey) {
      writeStoredPrefs(storageKey, next)
      emitPrefsChanged(storageKey)
    }
  }, [prefsControlled, onPrefsChange, storageKey])
  /**
   * 🔴 SGX — a storageKey change means a different saved view: use what is stored, and when nothing
   * is stored fall back to THESE columns' own defaults (the legacy effect, verbatim in behaviour).
   */
  useEffect(() => {
    if (prefsControlled || !storageKey) return
    setOwnPrefs(readStoredPrefs(storageKey, columns) ?? defaultPrefs(columns))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, prefsControlled])
  /** 🔴 RPX.0 — columns that ARRIVE LATER: re-seed from this set's defaults whenever the KEY set changes. */
  const colKeySig = useMemo(() => columns.map((c) => c.key).join(' '), [columns])
  const lastColSig = useRef<string | null>(null)
  useEffect(() => {
    if (prefsControlled) return
    if (storageKey && hasStoredPrefs(storageKey)) return
    if (lastColSig.current === colKeySig) return
    lastColSig.current = colKeySig
    if (!columns.length) return
    const next = defaultVisibleKeys(columns)
    setOwnPrefs((p) => (p.visible.length === next.length && p.visible.every((k, i) => k === next[i]) ? p : { ...p, visible: next }))
  }, [colKeySig, storageKey, columns, prefsControlled])

  const prefsColumns = useMemo<PreferencesColumnSpec[]>(
    () => [{ key: FIRST_COL, label: firstColLabel, locked: true }, ...columns.map((c) => ({ key: c.key, label: c.label, group: c.group, groupKey: c.groupKey, defaultLocked: !!c.freezeRight && c.width != null, lockSide: c.freezeRight ? 'right' as const : 'left' as const }))],
    [columns, firstColLabel],
  )

  // ── selection (a controlled Set, merged with AG's) ────────────────────────────────────────────
  const [selInner, setSelInner] = useState<Set<string>>(new Set())
  const sel = selected ?? selInner
  const selRef = useRef(sel)
  selRef.current = sel
  const setSel = useCallback((s: Set<string>) => { if (onSelectedChange) onSelectedChange(s); else setSelInner(s) }, [onSelectedChange])

  // ── the pipeline: filter → search (client); rows verbatim otherwise ───────────────────────────
  const filtered = useMemo(() => (rawOrder ? rows : filterRows(rows, filters, fstate, columns)), [rows, filters, fstate, columns, rawOrder])
  const searched = useMemo(
    () => (rawOrder ? filtered : searchRows(filtered, search, searchable, searchValue ?? firstSortValue)),
    [filtered, search, searchable, searchValue, firstSortValue, rawOrder],
  )
  /** The rows totals are computed over and the count line counts: the whole result, never the page. */
  const totalRows = searched
  const groupMeta = useMemo(() => (groupBy ? collectGroupMeta(totalRows, groupBy) : EMPTY_META), [groupBy, totalRows])
  const rowData = useMemo<Row[]>(() => (loading ? SKELETON_ROWS : totalRows), [loading, totalRows])
  const empty = !loading && rowData.length === 0

  const perPage = server ? server.rowsPerPage : rowsPerPage
  const totalCount = server ? server.total : totalRows.length
  const { pageCount, safePage, viewStart, viewEnd } = pageMath(page, perPage, totalCount)

  // ── the context every cell reads (rewritten each render; read at call time) ───────────────────
  const [inline, setInline] = useState<{ id: string; key: string; top: number; left: number } | null>(null)
  const [inlineDraft, setInlineDraft] = useState('')
  const [savingInline, setSavingInline] = useState(false)
  const openInline = useCallback((id: string, key: string, init: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    setInlineDraft(init)
    setInline({ id, key, top: r.bottom + 5, left: Math.max(8, Math.min(r.left, window.innerWidth - 226)) })
  }, [])
  const columnsByKey = useMemo(() => new Map(columns.map((c) => [c.key, c] as const)), [columns])
  const ctxHolder = useRef<WsContextHolder<T>>({ current: null as unknown as WsContext<T> })
  ctxHolder.current.current = {
    rowId, renderFirst, firstSortValue, firstColLabel, columnsByKey, totalRows, totalFirst, noun, hierarchy,
    editing, editByKey, hasEditMode: !!editMode, drafts, openInline,
    groupKeyOf: groupBy ? (r: T) => groupBy(r).key : undefined, groupMeta,
    isSentinel: (d: unknown) => isSkeletonRow(d) || isTotalRow(d),
  }
  const ctx = ctxHolder.current as unknown as WsContextHolder<unknown>

  // ── column definitions: structure only, keyed on a structural signature ───────────────────────
  const colSig = useMemo(() => columnsSignature(columns), [columns])
  const columnDefs = useMemo<ColDef[]>(
    () => buildColDefs({ columns, prefs, firstColLabel, firstSortable: !!firstSortValue, rawOrder, groupBy: !!groupBy, autoRows, tree: treeMode, defaultSort: dsKey ? { key: dsKey, dir: dsDir } : undefined, components: RENDERERS }),
    // `columns` is deliberately NOT a dependency — `colSig` stands for it (rule 1 in the file header).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [colSig, prefs, firstColLabel, !!firstSortValue, rawOrder, !!groupBy, autoRows, treeMode, dsKey, dsDir],
  )

  // ── stable AG options ─────────────────────────────────────────────────────────────────────────
  const rowIdRef = useRef(rowId); rowIdRef.current = rowId
  const getRowId = useCallback((p: GetRowIdParams<Row>) => {
    const d = p.data as unknown
    if (isSkeletonRow(d)) return `__skeleton_${d.__skeleton}`
    if (isTotalRow(d)) return '__total'
    return rowIdRef.current(d as T)
  }, [])
  const rowH = rowHeight ?? DEFAULT_ROW_H
  const getRowHeight = useCallback((p: { node: IRowNode }) => (p.node.group ? GROUP_ROW_H : rowH), [rowH])
  const hierarchyRef = useRef(hierarchy); hierarchyRef.current = hierarchy
  const isRowSelectable = useCallback((node: IRowNode<Row>) => {
    const d = node.data as unknown
    if (node.group || node.rowPinned || d == null || isSkeletonRow(d) || isTotalRow(d)) return false
    return !hierarchyRef.current?.isRemainder?.(d as T)
  }, [])
  const rowSelection = useMemo<RowSelectionOptions<Row> | undefined>(
    () => (selectable ? { mode: 'multiRow', checkboxes: true, headerCheckbox: true, enableClickSelection: false, hideDisabledCheckboxes: true, selectAll: 'currentPage', copySelectedRows: false, isRowSelectable } : undefined),
    [selectable, isRowSelectable],
  )
  // The legacy's third click clears the sort; AG's default order is the same three steps, stated.
  const defaultColDef = useMemo<ColDef<Row>>(() => ({ sortingOrder: SORTING_ORDER, suppressKeyboardEvent: rendererOwnsKeyboard }), [])
  const selectionColumnDef = useMemo<SelectionColumnDef>(() => ({
    // MEASURED on the legacy pages: the `td.ck` box was 48px wide (the sheet says 46; a table cell adds its rule),
    // and the identity column started at x = 46 + 48 + … exactly where AG puts it with 48 here.
    width: 48, minWidth: 48, maxWidth: 48, suppressSizeToFit: true, suppressAutoSize: true, resizable: false,
    lockPosition: 'left', lockPinned: true,
    cellClass: ['nds-ws-td', 'ck'],
    headerClass: 'nds-ws-th nds-ws-th-ck',
    cellRendererSelector: (p) => (isSkeletonRow(p.data as unknown) ? { component: SelectionSkeletonRenderer } : undefined),
  }), [])
  const onRowClickRef = useRef(onRowClick); onRowClickRef.current = onRowClick
  const rowClassNameRef = useRef(rowClassName); rowClassNameRef.current = rowClassName
  const focusedIdRef = useRef<string | null>(null)
  const rowClassRules = useMemo<RowClassRules<Row>>(() => ({
    'nds-ws-tr': () => true,
    sk: (p: RowClassParams<Row>) => isSkeletonRow(p.data as unknown),
    'h10-am-total': (p: RowClassParams<Row>) => p.node.rowPinned === 'top',
    'h10-am-grp': (p: RowClassParams<Row>) => !!p.node.group,
    'nds-tree-remainder': (p: RowClassParams<Row>) => p.data != null && !!hierarchyRef.current?.isRemainder?.(p.data as T),
    'kbd-focus': (p: RowClassParams<Row>) => focusedIdRef.current != null && p.node.id === focusedIdRef.current,
    clickable: (p: RowClassParams<Row>) => !!onRowClickRef.current && !p.node.group && !p.node.rowPinned,
  }), [])
  const getRowClass = useCallback((p: RowClassParams<Row>) => {
    const d = p.data as unknown
    if (d == null || isSkeletonRow(d) || isTotalRow(d) || p.node.group) return undefined
    return rowClassNameRef.current?.(d as T) || undefined
  }, [])
  const enabledFirstRef = useRef(enabledFirst); enabledFirstRef.current = enabledFirst
  const groupMetaRef = useRef(groupMeta); groupMetaRef.current = groupMeta
  const postSortRows = useCallback((p: PostSortRowsParams<Row>) => {
    const nodes = p.nodes
    if (!nodes.length) return
    if (nodes[0].group) { orderGroups(nodes, (n) => (n.key == null ? undefined : String(n.key)), groupMetaRef.current); return }
    const ef = enabledFirstRef.current
    if (ef && !userSortedRef.current) bandByEnabled(nodes, (n) => (n.data as unknown), ef as (row: never) => unknown)
  }, [])
  const columnsRefForReset = useRef(columns); columnsRefForReset.current = columns
  /** The header menu's last two items: the DS Customize dialog and a reset to this grid's defaults
   *  (an empty object strips AG's own column chooser from a grid that offers no Customize). */
  const columnDialog = useMemo(
    () => (customizable && !prefsControlled && !chromeless
      ? { customise: () => setShowCustomize(true), reset: () => updatePrefs(defaultPrefs(columnsRefForReset.current), true) }
      : {}),
    [customizable, prefsControlled, chromeless, updatePrefs],
  )
  const totalsVersion = useRef(0)
  const pinnedTopRowData = useMemo<TotalRow[] | undefined>(() => {
    if (!showTotal || loading || totalRows.length === 0) return undefined
    totalsVersion.current += 1
    return [{ __total: true, v: totalsVersion.current }]
  }, [showTotal, loading, totalRows])

  // ── AG events ─────────────────────────────────────────────────────────────────────────────────
  const fitColumns = useCallback(() => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    const widths = prefsRef.current.widths ?? {}
    const cols = (api.getAllGridColumns() ?? []).filter((c) => c.getColId() !== SELECTION_COL && widths[c.getColId()] == null && !c.getColDef().suppressAutoSize && c.isVisible())
    if (cols.length) api.autoSizeColumns(cols, false)
    if (Object.keys(widths).length) api.applyColumnState({ state: widthsToColumnState(prefsRef.current) })
    stretchIfNarrow()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  /** A `<table width=100%>` stretches to its box when its content is narrower; so does this grid. */
  const stretchIfNarrow = () => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    if (Object.keys(prefsRef.current.widths ?? {}).length) return
    const total = api.getAllDisplayedColumns().reduce((a, c) => a + c.getActualWidth(), 0)
    const w = wrapRef.current?.clientWidth ?? 0
    if (w > 0 && total < w) api.sizeColumnsToFit()
  }
  const fitPending = useRef(0)
  const scheduleFit = useCallback(() => {
    cancelAnimationFrame(fitPending.current)
    fitPending.current = requestAnimationFrame(() => fitColumns())
  }, [fitColumns])
  useEffect(() => () => cancelAnimationFrame(fitPending.current), [])

  const onGridReady = useCallback((e: GridReadyEvent<Row>) => {
    apiRef.current = e.api
    setApiReady(true)
    userSortedRef.current = !!onSortChange && !!dsKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const onFirstDataRendered = useCallback((_e: FirstDataRenderedEvent<Row>) => { scheduleFit() }, [scheduleFit])
  const onGridSizeChanged = useCallback((_e: GridSizeChangedEvent<Row>) => { stretchIfNarrow() }, [])
  const onSortChangeRef = useRef(onSortChange); onSortChangeRef.current = onSortChange
  const onSortChanged = useCallback((e: SortChangedEvent<Row>) => {
    if (applyingSortRef.current || e.source !== 'uiColumnSorted') return
    const next = sortOfState(e.api)
    const was = userSortedRef.current
    userSortedRef.current = next !== null
    // SF.1 — the banding changed relevance with this click; AG sorted before this flag moved, so ask it to sort again.
    if (enabledFirstRef.current && was !== userSortedRef.current) e.api.onSortChanged()
    onSortChangeRef.current?.(next)
  }, [])
  const selectAllIdsRef = useRef(selectAllIds); selectAllIdsRef.current = selectAllIds
  const onSelectionChanged = useCallback((e: SelectionChangedEvent<Row>) => {
    // React owns selection. AG also emits after API synchronisation and row replacement;
    // reading those intermediate states back would erase saved/off-page selections.
    if (!['checkboxSelected', 'rowClicked', 'spaceKey', 'keyboardSelectAll', 'uiSelectAll', 'uiSelectAllCurrentPage', 'uiSelectAllFiltered'].includes(e.source)) return
    // The header checkbox on a consumer that pages its own rows (`selectAllIds`): the whole filtered set
    // on, nothing off — the Ad Manager's legacy `toggleAll`. The page's rows follow through the sync below.
    if (selectAllIdsRef.current && (e.source === 'uiSelectAll' || e.source === 'uiSelectAllCurrentPage' || e.source === 'uiSelectAllFiltered')) {
      setSel(e.api.getSelectedNodes().length > 0 ? new Set(selectAllIdsRef.current) : new Set())
      return
    }
    const next = new Set(selRef.current)
    let changed = false
    e.api.forEachNode((n) => {
      const d = n.data as unknown
      if (d == null || isSkeletonRow(d) || isTotalRow(d) || n.group) return
      const id = rowIdRef.current(d as T)
      const on = !!n.isSelected()
      if (on && !next.has(id)) { next.add(id); changed = true }
      else if (!on && next.has(id)) { next.delete(id); changed = true }
    })
    if (changed) setSel(next)
  }, [setSel])
  const onCellClicked = useCallback((e: CellClickedEvent<Row>) => {
    const d = e.data as unknown
    if (!onRowClickRef.current || d == null || isSkeletonRow(d) || isTotalRow(d) || e.node.group || e.node.rowPinned) return
    if (isInteractiveChild(e.event?.target)) return
    onRowClickRef.current(d as T)
  }, [])
  const onColumnMoved = useCallback((e: ColumnMovedEvent<Row>) => {
    if (!e.finished || e.source !== 'uiColumnMoved') return
    const known = new Set(columnsRefForReset.current.map((c) => c.key))
    const visible = visibleOrderFromColumnState(e.api.getColumnState(), known)
    updatePrefs({ ...withVisibleColumnOrder(prefsRef.current, visible), visible }, true)
  }, [updatePrefs])
  const onColumnResized = useCallback((e: ColumnResizedEvent<Row>) => {
    if (!e.finished || e.source !== 'uiColumnResized') return
    let next = prefsRef.current
    for (const c of e.columns ?? (e.column ? [e.column] : [])) next = withWidth(next, c.getColId(), c.getActualWidth())
    updatePrefs(next, true)
  }, [updatePrefs])

  // ── effects that keep AG in step with React ───────────────────────────────────────────────────
  // The page: React state is the truth (the pager, the URL bridge); AG follows.
  useEffect(() => {
    const api = apiRef.current
    if (!api || api.isDestroyed() || !clientPaging) return
    if (api.paginationGetCurrentPage() !== safePage - 1) api.paginationGoToPage(safePage - 1)
  }, [apiReady, safePage, clientPaging, rowData, perPage])
  // Selection: FROM the Set into AG. Only user selection events are read back above.
  useEffect(() => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    const on: IRowNode<Row>[] = [], off: IRowNode<Row>[] = []
    api.forEachNode((n) => {
      const d = n.data as unknown
      if (d == null || isSkeletonRow(d) || isTotalRow(d) || n.group || !n.selectable) return
      const want = sel.has(rowIdRef.current(d as T))
      if (want !== !!n.isSelected()) (want ? on : off).push(n)
    })
    if (on.length) api.setNodesSelected({ nodes: on, newValue: true })
    if (off.length) api.setNodesSelected({ nodes: off, newValue: false })
  }, [apiReady, sel, rowData])
  // The row-reading functions changed identity (a consumer rebuilt its columns): re-render the cells.
  const lastRenderIds = useRef<unknown[]>([])
  useEffect(() => {
    const api = apiRef.current
    const ids = [renderFirst, columns, hierarchy, editing, editByKey, totalRows, totalFirst, firstSortValue]
    const changed = ids.length !== lastRenderIds.current.length || ids.some((v, i) => v !== lastRenderIds.current[i])
    lastRenderIds.current = ids
    if (changed && api && !api.isDestroyed()) api.refreshCells({ force: true, suppressFlash: true })
  })
  // `rowClassName` is read at row creation; when its answer changes for a row, that row is redrawn.
  const lastRowClasses = useRef<Map<string, string>>(new Map())
  useEffect(() => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    if (!rowClassName) { lastRowClasses.current = new Map(); return }
    const next = new Map<string, string>()
    const changed: IRowNode<Row>[] = []
    for (const r of totalRows) {
      const id = rowId(r)
      const cls = rowClassName(r) ?? ''
      next.set(id, cls)
      if (lastRowClasses.current.has(id) && lastRowClasses.current.get(id) !== cls) {
        const node = api.getRowNode(id)
        if (node) changed.push(node)
      }
    }
    lastRowClasses.current = next
    if (changed.length) api.redrawRows({ rowNodes: changed })
  })
  // Column widths: auto-size to content when the column set or the ROWS change; persisted widths win. A
  // `<table>` re-laid its columns out on every data change (measured: the Bid Rule column sized at 218 on the
  // first render, before the bid owners had loaded, while its content settled at 114 — the legacy table sat at
  // 141.5); one fit per rAF, so a keystroke in the search box costs one measurement, never one per row.
  const widthsSig = JSON.stringify(prefs.widths ?? {})
  useEffect(() => { if (apiRef.current) scheduleFit() }, [colSig, loading, empty, widthsSig, totalRows, scheduleFit])
  // BID.S0 — the seed changed (back button, pasted link): follow it. The mount is the ColDef's `initialSort`.
  const sortBridgeMounted = useRef(false)
  useEffect(() => {
    if (!onSortChange) return
    if (!sortBridgeMounted.current) { sortBridgeMounted.current = true; return }
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    applyingSortRef.current = true
    api.applyColumnState({ state: dsKey ? [{ colId: dsKey, sort: dsDir, sortIndex: 0 }] : [], defaultState: { sort: null } })
    applyingSortRef.current = false
    userSortedRef.current = !!dsKey
    if (enabledFirstRef.current) api.onSortChanged()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dsKey, dsDir])

  // ── BID.S0 / S4.1 bridges (legacy, verbatim) ──────────────────────────────────────────────────
  const seededFilters = JSON.stringify(initialFilters ?? {})
  const lastEmitted = useRef<string | null>(null)
  const suppressEmit = useRef(false)
  useEffect(() => {
    if (filtersControlled || !onFilterChange || !initialFilters) return
    const merged = { ...fstateRef.current, ...initialFilters }
    if (JSON.stringify(merged) === JSON.stringify(fstate)) return
    suppressEmit.current = true
    setFstate(merged)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seededFilters])
  useEffect(() => {
    if (filtersControlled || !onFilterChange) return
    const s = JSON.stringify(fstate)
    if (lastEmitted.current === null) { lastEmitted.current = s; return }
    if (lastEmitted.current === s) return
    lastEmitted.current = s
    if (suppressEmit.current) { suppressEmit.current = false; return }
    onFilterChange(fstate)
  }, [fstate, onFilterChange, filtersControlled])
  const bridgeMounted = useRef(false)
  const seedPage = initialPage != null && Number.isFinite(initialPage) && initialPage >= 1 ? Math.floor(initialPage) : null
  const suppressPageEmit = useRef(false)
  useEffect(() => {
    if (!onPageChange || seedPage == null || !bridgeMounted.current) return
    suppressPageEmit.current = true
    setPage(seedPage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedPage])
  const lastPageEmitted = useRef<number | null>(null)
  useEffect(() => {
    if (!onPageChange) return
    if (lastPageEmitted.current === null) { lastPageEmitted.current = page; return }
    if (lastPageEmitted.current === page) return
    lastPageEmitted.current = page
    if (suppressPageEmit.current) { suppressPageEmit.current = false; return }
    onPageChange(page)
  }, [page, onPageChange])
  const seedSearch = initialSearch ?? ''
  const suppressSearchEmit = useRef(false)
  useEffect(() => {
    if (!onSearchChange || !bridgeMounted.current) return
    suppressSearchEmit.current = true
    setSearch(seedSearch)
    if (seedSearch) setSearchOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedSearch])
  const lastSearchEmitted = useRef<string | null>(null)
  useEffect(() => {
    if (!onSearchChange) return
    if (lastSearchEmitted.current === null) { lastSearchEmitted.current = search; return }
    if (lastSearchEmitted.current === search) return
    lastSearchEmitted.current = search
    if (suppressSearchEmit.current) { suppressSearchEmit.current = false; return }
    onSearchChange(search)
  }, [search, onSearchChange])
  useEffect(() => { bridgeMounted.current = true }, [])

  // ── keyboard navigation (opt-in) — the legacy document listener, over AG's displayed rows ──────
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const displayedRows = useCallback((): Array<{ node: IRowNode<Row>; row: T }> => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return []
    const out: Array<{ node: IRowNode<Row>; row: T }> = []
    const n = api.getDisplayedRowCount()
    const start = clientPaging ? api.paginationGetCurrentPage() * api.paginationGetPageSize() : 0
    const end = clientPaging ? Math.min(n, start + api.paginationGetPageSize()) : n
    for (let i = start; i < end; i++) {
      const node = api.getDisplayedRowAtIndex(i)
      const d = node?.data as unknown
      if (!node || node.group || d == null || isSkeletonRow(d) || isTotalRow(d)) continue
      out.push({ node, row: d as T })
    }
    return out
  }, [clientPaging])
  const onRowKeyRef = useRef(onRowKey); onRowKeyRef.current = onRowKey
  useEffect(() => {
    if (!keyboardNav) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      const list = displayedRows()
      const n = list.length
      if (n === 0) return
      const k = e.key.toLowerCase()
      const i = list.findIndex((x) => x.node.id === focusedIdRef.current)
      if (k === 'j' || e.key === 'ArrowDown') { e.preventDefault(); setFocusedId(list[Math.min(n - 1, i + 1)].node.id ?? null) }
      else if (k === 'k' || e.key === 'ArrowUp') { e.preventDefault(); setFocusedId(list[Math.max(0, (i < 0 ? 0 : i) - 1)].node.id ?? null) }
      else {
        if (i < 0 || i >= n) return
        if (k === 'o' || e.key === 'Enter') { e.preventDefault(); onRowClickRef.current?.(list[i].row) }
        else onRowKeyRef.current?.(list[i].row, k)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [keyboardNav, displayedRows])
  useEffect(() => {
    const api = apiRef.current
    const prev = focusedIdRef.current
    focusedIdRef.current = focusedId
    if (!api || api.isDestroyed()) return
    const nodes = [prev, focusedId].filter((id): id is string => id != null).map((id) => api.getRowNode(id)).filter((n): n is IRowNode<Row> => !!n)
    if (nodes.length) api.redrawRows({ rowNodes: nodes })
    if (focusedId != null) wrapRef.current?.querySelector('.ag-row.kbd-focus')?.scrollIntoView({ block: 'nearest' })
  }, [focusedId])
  // A focused row that left the page (a filter, a page turn) loses its focus, as the legacy clamp did.
  useEffect(() => {
    if (focusedId == null) return
    if (!displayedRows().some((x) => x.node.id === focusedId)) setFocusedId(null)
  }, [rowData, safePage, focusedId, displayedRows])

  // ── edit mode (legacy, over the draft store) ──────────────────────────────────────────────────
  const dirtyEdits = useMemo(
    () => (editMode ? collectEdits(totalRows, rowId, editMode.fields, draftSnapshot) : []),
    [editMode, totalRows, draftSnapshot, rowId],
  )
  const enterEdit = () => { drafts.reset(); setEditing(true) }
  const discardEdits = () => { drafts.reset(); setEditing(false) }
  const applyEdits = async () => {
    if (!editMode || !dirtyEdits.length || applying) return
    setApplying(true)
    try { await editMode.onApply(dirtyEdits); drafts.reset(); setEditing(false) } finally { setApplying(false) }
  }
  const editLabelFor = (key: string) => (key === FIRST_COL ? firstColLabel : columns.find((c) => c.key === key)?.label ?? '')
  const saveInline = async () => {
    if (!inline || !editMode || savingInline) return
    setSavingInline(true)
    try { await editMode.onApply([{ id: inline.id, values: { [inline.key]: inlineDraft } }]); setInline(null) } finally { setSavingInline(false) }
  }
  const inlineRow = inline ? totalRows.find((r) => rowId(r) === inline.id) : undefined
  const inlineField = inline ? editByKey.get(inline.key) : undefined

  const hasFilters = hasActiveFilters(fstate)
  const toggleAllClear = () => setSel(new Set())

  // ── the grid card: header (AG's) → rows → the empty state under the header when there are none ──
  const grid = (
    <div ref={wrapRef} className={`nds-wsgrid nds-ag-ws${autoRows ? ' is-auto' : ''}${selectable ? '' : ' nosel'}${editing ? ' is-editing' : ''}${empty ? ' is-empty' : ''}`}>
      <TooltipPortalProvider>
      <NexusGrid<Row>
        theme={adsWorkspaceTheme}
        className="nds-ws-grid"
        domLayout="autoHeight"
        rowHeight={rowH}
        getRowHeight={getRowHeight}
        rowData={rowData}
        columnDefs={columnDefs}
        getRowId={getRowId}
        pinnedTopRowData={pinnedTopRowData}
        rowSelection={rowSelection}
        selectionColumnDef={selectionColumnDef}
        defaultColDef={defaultColDef}
        context={ctx}
        rowClassRules={rowClassRules}
        getRowClass={getRowClass}
        postSortRows={postSortRows}
        pagination={clientPaging}
        paginationPageSize={perPage}
        paginateChildRows
        suppressPaginationPanel
        groupDisplayType="groupRows"
        groupRowRenderer={GroupBandRenderer}
        groupDefaultExpanded={-1}
        suppressGroupRowsSticky
        suppressAggFuncInHeader
        suppressNoRowsOverlay
        suppressColumnVirtualisation
        suppressDragLeaveHidesColumns
        suppressRowTransform
        // A `<table>` column is exactly its content plus the cell padding; AG's auto-size adds 20px of slack
        // by default (measured: every column +20 against the legacy widths, the identity 350 for 328.5).
        autoSizePadding={0}
        enableCellTextSelection
        tooltipShowDelay={600}
        columnDialog={columnDialog}
        onGridReady={onGridReady}
        onFirstDataRendered={onFirstDataRendered}
        onGridSizeChanged={onGridSizeChanged}
        onSortChanged={onSortChanged}
        onSelectionChanged={onSelectionChanged}
        onCellClicked={onCellClicked}
        onColumnMoved={onColumnMoved}
        onColumnResized={onColumnResized}
      />
      </TooltipPortalProvider>
      {empty && <div className="nds-ws-td empty nds-ws-empty">{emptyNode ?? emptyLabel}</div>}
    </div>
  )

  // per-cell hover-edit popover (portaled; reuses .h10-editpop styling)
  const inlinePopover = inline && inlineField && typeof document !== 'undefined' && createPortal(<>
    <button type="button" className="h10-dd-back" aria-label="Close" onClick={() => setInline(null)} />
    <div className="h10-editpop" style={{ position: 'fixed', top: inline.top, left: inline.left, zIndex: 1000 }} role="dialog" aria-label={`Edit ${editLabelFor(inline.key)}`}>
      <div className="h">{editLabelFor(inline.key)}</div>
      {(inlineField.renderPopover ?? inlineField.render)(inlineDraft, setInlineDraft, inlineRow as T)}
      <div className="f">
        <Button size="sm" onClick={() => setInline(null)}>Cancel</Button>
        <Button variant="primary" size="sm" disabled={savingInline} onClick={saveInline}>{savingInline ? 'Saving…' : 'Save'}</Button>
      </div>
    </div>
  </>, document.body)

  if (chromeless) return <>{grid}{inlinePopover}</>

  return (
    <>
      {/* FB.1 — one implementation, rendered here unless the page renders it itself at the top. */}
      {hideFilterPanel ? null : (
        <AdsFilterBar
          filters={filters ?? []}
          value={fstate}
          onChange={(next) => setFstate(next)}
          onAfterChange={() => setPage(1)}
          defaultOpen={filtersDefaultOpen}
          presetsSlot={filterPresetsKey ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--nds-text-muted)' }}>Presets:</span>
                    {presets.map((p) => (
                      <span key={p.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                        {presetRenaming === p.name ? (
                          <input
                            className="h10-edit-in" autoFocus defaultValue={p.name} style={{ width: 120 }}
                            aria-label="Rename preset"
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') { const nn = (e.target as HTMLInputElement).value.trim().slice(0, 60); if (nn) persistPresets(presets.map((x) => (x.name === p.name ? { ...x, name: nn } : x))); setPresetRenaming(null) }
                              if (e.key === 'Escape') setPresetRenaming(null)
                            }}
                            onBlur={() => setPresetRenaming(null)}
                          />
                        ) : (
                          <Button
 size="sm" title="Apply preset · double-click to rename"
 /* FB.1 — a preset carries metric filters ONLY. It keeps whatever scope keys are
 set, because a saved metric view must never move you to another account view. */
 onClick={() => { setFstate((cur) => ({ ...Object.fromEntries(Object.entries(cur).filter(([k]) => isServerKey(k))), ...stripServerKeys(p.values) })); setPage(1) }}
 onDoubleClick={() => setPresetRenaming(p.name)}
 >{p.name}</Button>
                        )}
                        <Button variant="link" aria-label={`Delete preset ${p.name}`} style={{ fontSize: 11 }} onClick={() => persistPresets(presets.filter((x) => x.name !== p.name))}>✕</Button>
                      </span>
                    ))}
                    {presetSaveOpen ? (
                      <input
                        className="h10-edit-in" autoFocus placeholder="preset name…" value={presetName} style={{ width: 140 }}
                        aria-label="Preset name"
                        onChange={(e) => setPresetName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { const nn = presetName.trim().slice(0, 60); if (nn) persistPresets([...presets.filter((x) => x.name !== nn), { name: nn, values: stripServerKeys(fstate) }]); setPresetName(''); setPresetSaveOpen(false) }
                          if (e.key === 'Escape') { setPresetName(''); setPresetSaveOpen(false) }
                        }}
                      />
                    ) : (
                      <Button variant="link" style={{ fontSize: 12 }} disabled={!hasFilters} onClick={() => setPresetSaveOpen(true)}>Save preset</Button>
                    )}
                  </span>
          ) : undefined}
        />
      )}

      {/* one card: toolbar + grid + pager share the grid rectangle (H10 — toolbar sits inside it) */}
      <div className="nds-card h10-cardstack">
      {/* toolbar */}
      <div className="h10-am-toolbar">
        <span className="cnt">{selectable && sel.size > 0
          ? <b>{`Selected ${sel.size} ${pluralize(noun, sel.size)}`}</b>
          : totalCount === 0 ? `Showing 0 ${pluralize(noun, 0)}` : `Viewing ${viewStart}-${viewEnd} of ${server ? totalCount.toLocaleString('en-GB') : totalCount} ${pluralize(noun, totalCount)}`}</span>
        {editMode && editMode.bulk !== false ? (editing ? (
          <span className="h10-edit-actions">
            <button type="button" className="h10-discard" onClick={discardEdits}>Discard Changes</button>
      <Button variant="primary" disabled={!dirtyEdits.length || applying} onClick={applyEdits}>{applying ? 'Applying…' : 'Apply Changes'}</Button>
          </span>
        ) : (
     <Button variant="primary" onClick={enterEdit}><Pencil size={13} /> {editMode.label}</Button>
        )) : toolbarLeft}
        {selectable && sel.size > 0 && !editing && selectionActions ? selectionActions([...sel], toggleAllClear) : null}
        {/* inline 🔍 sits after the count + any selection actions (H10 order) */}
        {searchable && (searchOpen ? (
          <span className="h10-am-searchbox">
            <Search size={14} />
            <input autoFocus value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }} placeholder={searchPlaceholder} aria-label="Search" />
            <button type="button" className="x" aria-label="Clear search" onMouseDown={(e) => e.preventDefault()} onClick={() => { setSearch(''); setSearchOpen(false) }}><X size={13} /></button>
          </span>
        ) : (
          <button type="button" className="h10-am-searchbtn" aria-label="Search" onClick={() => setSearchOpen(true)}><Search size={15} /></button>
        ))}
        <span className="grow" />
        {toolbarRight}
        {customizable && !prefsControlled && (
          <>
            <Button active={showCustomize} onClick={() => setShowCustomize(true)} aria-haspopup="dialog" aria-expanded={showCustomize}><Settings2 size={13} /> Customize</Button>
            {/* SGX3 — the SHARED dialog, not a second implementation (the same wiring as before). */}
            <PreferencesModal
              attributeGroups
              groupToggles
              inViewCount
              open={showCustomize}
              onClose={() => setShowCustomize(false)}
              title="Customise columns"
              value={prefsToModal(prefs, columns, perPage)}
              onConfirm={(next) => {
                updatePrefs(prefsFromModal(prefs, next, columns), true)
              }}
              allColumns={prefsColumns}
              defaultVisible={defaultVisible}
              sortFieldOptions={[]}
              pageSizeChoices={[]}
              showSticky
            />
          </>
        )}
    {exportable && <Button onClick={onExport}><Download size={13} /> Export Data…</Button>}
      </div>

      {grid}

      {/* pager */}
      <div className="h10-am-pager">
        <span className="grow" />
        <div className="pg">
          <button type="button" className="pgbtn" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label="Previous page">‹</button>
          {Array.from({ length: Math.min(pageCount, 9) }).map((_, i) => (
            <button type="button" key={i} className={`pgbtn ${safePage === i + 1 ? 'on' : ''}`} onClick={() => setPage(i + 1)}>{i + 1}</button>
          ))}
          <button type="button" className="pgbtn" disabled={safePage >= pageCount} onClick={() => setPage((p) => Math.min(pageCount, p + 1))} aria-label="Next page">›</button>
        </div>
        {pagerCentered && <span className="grow" />}
        <div className="rpp">Rows per page:
          <Listbox width={84} options={PAGE_SIZES} value={String(perPage)} onChange={(v) => { if (server) server.onRowsPerPageChange(Number(v)); else setRowsPerPage(Number(v)); setPage(1) }} ariaLabel="Rows per page" />
        </div>
      </div>
      </div>
      {reportLabel && <div className="h10-am-latest"><b>Latest Report:</b> {reportLabel} · Performance data is not real-time. <span className="lk">Learn More</span></div>}

      {inlinePopover}
    </>
  )
}
