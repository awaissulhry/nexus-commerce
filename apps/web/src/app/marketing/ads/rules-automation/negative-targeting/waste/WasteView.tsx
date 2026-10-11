'use client'

/**
 * Negative Targeting page (2026-10-11, lane NVIEW) — the Wasting and the Stopped views: ONE NexusGrid card each, built
 * like /products (ProductsNextClient) and the Bid page's Bids view.
 *
 *   toolbar   [Wasting | Stopped | Rules] · count · Search · All · Keywords · Search terms · Scope ▾ · filter chips
 *                                                                             Views · Customise · Export
 *   ticked    Selected N · "Select all M that match" · the verbs, each counted (a verb that fits none is held and says
 *             why) · ⋯ · Clear
 *   grid      server pages (`?page=`, `?sort=`), checkboxes, header select-page; a row (click or Enter) opens its record
 *   footer    the pager
 *   states    reading (the grid's overlay) · empty (its words, "Clear filters") · failed (the read's own words with Try
 *             again — never "nothing here", audit M4) · a failed re-read over rows already shown (a banner)
 *   phone     3 columns, no ticks, no verbs column, no Views / Customise / Export; a tap opens the full-screen sheet
 *
 * Every write goes through the review (`useWasteReview`), above the record when one is open; after it the rows, the
 * tiles and the record are read again.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Crosshair, Download, MoreHorizontal, Search, SlidersHorizontal, TextSearch } from 'lucide-react'
import { Button, Input, SegmentedControl } from '@/design-system/primitives'
import { Banner, Listbox, Menu, Modal, useNarrow, useToast, type MenuItemDef } from '@/design-system/components'
import { GridToolbar, PreferencesModal, ReviewChangesModal, StepUpModal, type PreferencesValue } from '@/design-system/patterns'
import {
  AG_SELECTION_COL, cellOf, columnStateToPrefs, csvFileName, downloadCsv, gridSelection, GridCard, GridLoadingOverlay, GridNoRowsOverlay, GridPager,
  GridSearchSlot, GridSelectionActions, GridViewsMenu, NexusGrid, prefsToColumnState, toCsv, useGridState,
  type GridApi, type GridReadyEvent, type GridStateKey, type NexusGridProps, type PrefsBridgeOptions,
} from '@/design-system/grid'
import { getBackendUrl } from '@/lib/backend-url'
import { useDetailParam } from '../../../_shared/useDetailParam'
import {
  STOPPED_COLUMN_SPECS, WASTE_COLUMN_SPECS, stoppedColumns, stoppedGridRow, wasteColumns, wasteGridRow, withVerbHandler,
  type CellContext, type CellHandlers, type StoppedGridRow, type WasteGridRow,
} from './columns'
import { RowDetail } from './RowDetail'
import { readAllRows, readAllStopped, readRowIds, readRows, readStopped } from './wasteApi'
import {
  DEFAULT_PAGE_SIZE, NOT_KEPT, waitingCount, detailTabOf, emptyWords, PAGE_SIZES, plural, scopeKey, scopeOptions, skipIds, sortOf, sortParam, stoppedBulkCounts, stoppedBulkPlan,
  stoppedChips, stoppedCsvRow, STOPPED_BULK_LABEL, STOPPED_CSV_HEADERS, waitingOf, WASTE_BULK_LABEL, WASTE_CSV_HEADERS, wasteBulkCounts, wasteBulkPlan, wasteCsvRow,
  type KindFilter, type ListQuery, type Picked, type RowVerbView, type Scope, type StoppedBulk, type WasteBulk,
} from './wasteModel'
import type { Ref, StoppedRow, StoppedTotals, WasteRow, WasteTotals } from './wasteTypes'
import { useWasteReview, type WasteAsk } from './useWasteReview'
import styles from '../negatives.module.css'

type AnyRow = WasteGridRow | StoppedGridRow

export interface WasteViewProps {
  view: 'wasting' | 'stopped'
  market: string | null
  viewSwitch: ReactNode
  show: string
  kind: KindFilter
  q: string
  scope: Scope | null
  sort: string | null
  page: number
  pageSize: number
  canWrite: boolean
  /** One address change (the rest of the query is kept). */
  setQuery(patch: Record<string, string | null>): void
  /** After each read: this view's totals, for the page's tiles. */
  onTotals(totals: WasteTotals | StoppedTotals): void
  /** After a write: the page's other numbers are read again. */
  onWrote(): void
  /** Bumped by the page when the other view wrote: read again. */
  refreshKey: number
  ruleHref(ruleId: string): string
}

/* ── stable grid options (GDS decision 12) ───────────────────────────────────────────────────────────────────────── */

const ROW_ID: NonNullable<NexusGridProps<AnyRow>['getRowId']> = (p) => p.data.id
const LOADING_PARAMS = { rows: 8 }
const PERSIST_KEYS: readonly GridStateKey[] = ['columnSizing', 'columnOrder', 'columnVisibility', 'columnPinning']
const NO_CHOICES: number[] = []
const NO_SORT_OPTIONS: Array<{ value: string; label: string }> = []
const NO_PAGE_STATE = (): Record<string, never> => ({})
const IGNORE_PAGE_STATE = () => {}
const SELECTION = gridSelection<AnyRow>({ selectAll: 'currentPage' }) as NexusGridProps<AnyRow>['rowSelection']
/** Cells that answer Enter themselves (a link, a list, a button): Enter there never opens the record. */
const OWN_KEY_COLUMNS = new Set(['where', 'product', 'owner', 'actions', 'since'])
/** All · ours · shoppers': icons, the words on hover and for a screen reader. */
const KIND_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'keyword', label: <span className="nds-vh">Keywords</span>, icon: <Crosshair size={14} aria-hidden />, title: 'Keywords: ours' },
  { value: 'term', label: <span className="nds-vh">Search terms</span>, icon: <TextSearch size={14} aria-hidden />, title: 'Search terms: shoppers\'' },
]

interface Read { rows: AnyRow[]; total: number; totals: WasteTotals | StoppedTotals }

export function WasteView(props: WasteViewProps) {
  const { view, market, viewSwitch, show, kind, q, scope, sort, page, pageSize, canWrite, setQuery, onTotals, onWrote, refreshKey, ruleHref } = props
  const phone = useNarrow()
  const { toast } = useToast()
  const wasting = view === 'wasting'
  const query: ListQuery = useMemo(() => ({ market, scope, kind, show, q, sort: wasting ? sort : null, page, pageSize }), [market, scope, kind, show, q, sort, page, pageSize, wasting])
  const queryKey = JSON.stringify(query)

  /* ── the read ── */
  const [read, setRead] = useState<Read | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [reading, setReading] = useState(true)
  const [again, setAgain] = useState(0)
  const [version, setVersion] = useState(0)
  const seen = useRef(new Map<string, { portfolio: Ref | null; campaign: Ref | null; adGroup: Ref | null }>())
  const seenMarket = useRef(market)
  if (seenMarket.current !== market) { seenMarket.current = market; seen.current = new Map() }
  const onTotalsRef = useRef(onTotals)
  onTotalsRef.current = onTotals
  useEffect(() => {
    const ctl = new AbortController()
    setReading(true)
    const run = async () => {
      try {
        const out: Read = wasting
          ? await readRows(query, ctl.signal).then((a) => ({ rows: a.rows.map(wasteGridRow), total: a.total, totals: a.totals }))
          : await readStopped(query, ctl.signal).then((a) => ({ rows: a.rows.map(stoppedGridRow), total: a.total, totals: a.totals }))
        if (ctl.signal.aborted) return
        for (const r of out.rows) seen.current.set(`${r.campaign.id}|${r.adGroup?.id ?? ''}`, { portfolio: r.portfolio, campaign: r.campaign, adGroup: r.adGroup })
        setRead(out)
        setErr(null)
        setReading(false)
        onTotalsRef.current(out.totals)
      } catch (e) {
        if (ctl.signal.aborted) return
        setErr(e instanceof Error ? e.message : String(e))
        setReading(false)
      }
    }
    void run()
    return () => ctl.abort()
  }, [queryKey, again, version, refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps
  // A new view or market starts with nothing shown (never another view's rows); a new page of the same keeps the rows
  // on screen while the next one is read.
  const shapeKey = `${view}|${market ?? ''}`
  useEffect(() => { setRead(null); setErr(null) }, [shapeKey])
  const reload = useCallback(() => { setErr(null); setAgain((n) => n + 1) }, [])
  const afterWrite = useCallback(async () => { setVersion((n) => n + 1); onWrote() }, [onWrote])

  const rows = read?.rows ?? []
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows])
  const failed = !!err && !read
  const loading = !read && !err
  const filtered = !!q.trim() || kind !== 'all' || !!scope || (wasting ? show !== 'wasting' : show !== 'all')

  /* ── the record: ?row=&tab= ── */
  const detail = useDetailParam({ key: 'row', tabKey: 'tab' })
  const [navIds, setNavIds] = useState<string[] | null>(null)
  const detailOpen = !!detail.id
  useEffect(() => {
    if (!detailOpen) return
    let live = true
    const ids = wasting ? readRowIds(query).then((a) => a.ids) : readAllStopped({ ...query, page: undefined, pageSize: undefined }, 2000).then((r) => r.map((x) => x.id))
    ids.then((list) => { if (live) setNavIds(list) }).catch(() => { if (live) setNavIds(rows.map((r) => r.id)) })
    return () => { live = false }
  }, [detailOpen, queryKey, version]) // eslint-disable-line react-hooks/exhaustive-deps
  const apiRef = useRef<GridApi<AnyRow> | null>(null)
  const openerId = useRef<string | null>(null)
  const openRecord = useCallback((id: string) => { openerId.current = id; detail.open(id, null) }, [detail])
  const recordFocus = useCallback(() => {
    const api = apiRef.current
    const id = detail.id
    if (!api || api.isDestroyed() || !id) return null
    return cellOf(api, id, { colId: 'term' })
  }, [detail.id])

  /* ── selection: kept across pages; "select all M that match" reaches past the page ── */
  const [picked, setPicked] = useState<Map<string, Picked<AnyRow>>>(new Map())
  const syncing = useRef(false)
  useEffect(() => { setPicked(new Map()) }, [shapeKey, q, kind, show, scopeKey(scope)]) // eslint-disable-line react-hooks/exhaustive-deps
  const onSelectionChanged = useCallback<NonNullable<NexusGridProps<AnyRow>['onSelectionChanged']>>((e) => {
    if (syncing.current) return
    const on = new Set(e.api.getSelectedRows().map((r) => r.id))
    setPicked((cur) => {
      const next = new Map(cur)
      e.api.forEachNode((n) => { if (n.data) { if (on.has(n.data.id)) next.set(n.data.id, n.data); else next.delete(n.data.id) } })
      return next
    })
  }, [])
  // A page read: its ticks follow the selection (and the loaded rows replace their bare ids).
  useEffect(() => {
    const api = apiRef.current
    if (!api || api.isDestroyed() || !read) return
    // No ticks on the phone, nor for a person who may not change ads: nothing to keep in step.
    if (phone || !canWrite) return
    syncing.current = true
    try {
      const nodes = { on: [] as ReturnType<GridApi<AnyRow>['getRowNode']>[], off: [] as ReturnType<GridApi<AnyRow>['getRowNode']>[] }
      api.forEachNode((n) => { if (n.data) (picked.has(n.data.id) ? nodes.on : nodes.off).push(n) })
      if (nodes.on.length) api.setNodesSelected({ nodes: nodes.on.filter(Boolean) as never, newValue: true })
      if (nodes.off.length) api.setNodesSelected({ nodes: nodes.off.filter(Boolean) as never, newValue: false })
    } finally { syncing.current = false }
    setPicked((cur) => {
      let changed = false
      const next = new Map(cur)
      for (const r of read.rows) if (next.has(r.id) && next.get(r.id) !== r) { next.set(r.id, r); changed = true }
      return changed ? next : cur
    })
  }, [read]) // eslint-disable-line react-hooks/exhaustive-deps
  const clearPicked = useCallback(() => { setPicked(new Map()); apiRef.current?.deselectAll() }, [])
  const [selectingAll, setSelectingAll] = useState(false)
  const selectAllMatching = useCallback(async () => {
    setSelectingAll(true)
    try {
      const all: Array<Picked<AnyRow>> = wasting
        ? (await readRowIds(query)).ids.map((id) => byId.get(id) ?? { id })
        : (await readAllStopped({ ...query, page: undefined, pageSize: undefined })).map(stoppedGridRow)
      setPicked(new Map(all.map((r) => [r.id, r])))
      const api = apiRef.current
      if (api && !api.isDestroyed()) { syncing.current = true; try { api.selectAll() } finally { syncing.current = false } }
    } catch (e) {
      toast(`Not selected: ${e instanceof Error ? e.message : String(e)}`, 'danger')
    } finally { setSelectingAll(false) }
  }, [wasting, query, byId, toast])
  const pickedList = useMemo(() => [...picked.values()], [picked])

  /* ── the review ── */
  const { review, stepUp, ask, save, submitCode, cancelCode, undoSaved, retry, close } = useWasteReview({ market, after: afterWrite })
  const reviewOpener = useRef<HTMLElement | null>(null)
  /** The row the review changes (its position too): the focus goes back to it, or to the row now in its place. */
  const reviewRow = useRef<{ id: string; index: number } | null>(null)
  const askFrom = useCallback((given: WasteAsk) => {
    // The rows' own words go with the ask, so a review names an auto target by its group ("Close match").
    const a: WasteAsk = given.kind === 'change' ? {
      ...given,
      texts: {
        ...Object.fromEntries(given.items.flatMap((i): Array<[string, string]> => {
          const r = (byId.get(i.rowId) ?? picked.get(i.rowId)) as { text?: unknown } | undefined
          return typeof r?.text === 'string' ? [[i.rowId, r.text]] : []
        })),
        ...given.texts,
      },
    } : given
    reviewOpener.current = document.activeElement as HTMLElement | null
    const first = a.kind === 'change' ? a.items[0]?.rowId : a.kind === 'skip' || a.kind === 'unskip' ? a.rows[0]?.id : a.kind === 'decide' ? a.waits[0]?.rowId : null
    const index = first ? rows.findIndex((r) => r.id === first) : -1
    reviewRow.current = first ? { id: first, index } : null
    ask(a)
  }, [ask, rows, byId, picked])
  // After a review the focus goes back to the changed row's cell (audit S18); when the row left the view, to the row in
  // its place; never to <body>.
  const reviewFocus = useCallback(() => {
    const api = apiRef.current
    if (api && !api.isDestroyed() && reviewRow.current) {
      const { id, index } = reviewRow.current
      const here = rows.some((r) => r.id === id) ? id : rows[Math.min(Math.max(index, 0), rows.length - 1)]?.id
      const cell = here ? cellOf(api, here, { colId: 'term' }) : null
      if (cell) return cell
    }
    const el = reviewOpener.current
    if (el && el.isConnected) return el
    const first = rows[0]?.id
    return api && !api.isDestroyed() && first ? cellOf(api, first, { colId: 'term' }) : null
  }, [rows])
  const closeReview = useCallback(() => {
    if (review?.state.phase === 'done' && !detail.id) clearPicked()
    close()
  }, [review, detail.id, clearPicked, close])

  /* ── the grid ── */
  const handlers = useRef<CellHandlers>({ verb: () => {}, ruleHref: () => '' })
  handlers.current = {
    verb: (rowId: string, v: RowVerbView) => {
      if (v.held) return
      const row = byId.get(rowId)
      if (wasting && row && 'waiting' in row && row.waiting) { openRecord(rowId); return }
      askFrom({ kind: 'change', items: [{ rowId, action: v.action, ...(v.where ? { where: v.where } : {}), ...(v.targetRowId ? { targetRowId: v.targetRowId } : {}) }] })
    },
    ruleHref,
  }
  const cellContext = handlers as CellContext
  const specs = wasting ? WASTE_COLUMN_SPECS : STOPPED_COLUMN_SPECS
  const columnDefs = useMemo(() => {
    const cols = wasting ? wasteColumns(phone) : stoppedColumns(phone)
    return withVerbHandler(cols as never, cellContext, wasting ? 'waste' : 'stopped') as NexusGridProps<AnyRow>['columnDefs']
  }, [phone, wasting]) // eslint-disable-line react-hooks/exhaustive-deps
  const bridge = useMemo<PrefsBridgeOptions>(() => ({ columns: specs.map((c) => ({ key: c.key, locked: c.locked })) }), [specs])
  const preferenceSpecs = useMemo(() => specs.map((c) => ({ key: c.key, label: c.label, locked: c.locked })), [specs])
  const defaultPrefs = useMemo<PreferencesValue>(() => ({
    visibleColumns: specs.filter((c) => !c.hidden).map((c) => c.key), lockedColumns: [], stickyFirstColumn: true, stickyLastColumn: false, pageSize: 0, sortBy: '', sortDir: 'asc',
  }), [specs])
  const gridState = useGridState<Record<string, never>>({
    surface: wasting ? 'ads-neg-wasting' : 'ads-neg-stopped', baseUrl: getBackendUrl(), getPageState: NO_PAGE_STATE, applyPageState: IGNORE_PAGE_STATE, persistKeys: PERSIST_KEYS,
  })
  const bindState = useRef(gridState.bind)
  bindState.current = gridState.bind
  const sortNow = useRef(sort)
  sortNow.current = sort
  // The phone's three columns never take the desktop's saved widths or order.
  const initialState = useMemo(() => {
    const s = sortOf(sort)
    return { ...(phone ? {} : gridState.initialState ?? {}), ...(s && wasting ? { sort: { sortModel: [{ colId: s.colId, sort: s.dir }] } } : {}) }
  }, [gridState.initialState, phone]) // eslint-disable-line react-hooks/exhaustive-deps
  const bindPhone = useRef(phone)
  bindPhone.current = phone
  const onGridReady = useCallback((e: GridReadyEvent<AnyRow>) => { apiRef.current = e.api; if (!bindPhone.current) bindState.current(e.api) }, [])
  const onSortChanged = useCallback<NonNullable<NexusGridProps<AnyRow>['onSortChanged']>>((e) => {
    const col = e.api.getColumnState().find((c) => c.sort)
    const next = col ? sortParam({ colId: col.colId, dir: col.sort as 'asc' | 'desc' }) : null
    if ((next ?? null) !== (sortNow.current ?? null)) setQuery({ sort: next, page: null })
  }, [setQuery])

  const onRowClicked = useCallback<NonNullable<NexusGridProps<AnyRow>['onRowClicked']>>((e) => {
    const target = (e.event?.target ?? null) as HTMLElement | null
    if (target?.closest?.('a, button, [role="dialog"], .ag-selection-checkbox, [role="img"][tabindex]')) return
    if (e.data) openRecord(e.data.id)
  }, [openRecord])
  const onCellKeyDown = useCallback<NonNullable<NexusGridProps<AnyRow>['onCellKeyDown']>>((e) => {
    const key = e.event as KeyboardEvent | null | undefined
    if (key?.key !== 'Enter' || !e.data) return
    const target = key.target as HTMLElement | null
    if (target?.closest?.('a, button, input, [role="dialog"]')) return
    const col = 'column' in e ? e.column.getColId() : null
    if (col && (OWN_KEY_COLUMNS.has(col) || col.startsWith('ag-Grid'))) return
    openRecord(e.data.id)
  }, [openRecord])

  const [filtersOpen, setFiltersOpen] = useState(false)

  /* ── Customise ── */
  const [prefsOpen, setPrefsOpen] = useState(false)
  const [prefs, setPrefs] = useState<PreferencesValue>(defaultPrefs)
  const openCustomise = useCallback(() => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    setPrefs((current) => columnStateToPrefs(api.getColumnState().filter((c) => c.colId !== AG_SELECTION_COL), current, bridge))
    setPrefsOpen(true)
  }, [bridge])
  const applyPrefs = useCallback((next: PreferencesValue) => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    api.applyColumnState({ state: prefsToColumnState(next, bridge), applyOrder: true })
    setPrefs(next)
  }, [bridge])
  const resetColumns = useCallback(() => { apiRef.current?.resetColumnState(); setPrefs(defaultPrefs) }, [defaultPrefs])
  const columnDialog = useMemo(() => (phone ? undefined : { customise: openCustomise, reset: resetColumns }), [phone, openCustomise, resetColumns])

  /* ── export, copy ── */
  const [exporting, setExporting] = useState(false)
  const csvOf = useCallback((list: readonly AnyRow[]) => (wasting
    ? toCsv(list as WasteGridRow[], WASTE_CSV_HEADERS.map((h, i) => ({ header: h, value: (r: WasteGridRow) => wasteCsvRow(r)[i] })))
    : toCsv(list as StoppedGridRow[], STOPPED_CSV_HEADERS.map((h, i) => ({ header: h, value: (r: StoppedGridRow) => stoppedCsvRow(r)[i] })))), [wasting])
  const exportAll = useCallback(async () => {
    setExporting(true)
    try {
      const all = wasting ? (await readAllRows({ ...query, page: undefined, pageSize: undefined })).map(wasteGridRow) : (await readAllStopped({ ...query, page: undefined, pageSize: undefined })).map(stoppedGridRow)
      downloadCsv(csvFileName(`negative-targeting-${view}`, { filtered }), csvOf(all))
    } catch (e) {
      toast(`Not exported: ${e instanceof Error ? e.message : String(e)}`, 'danger')
    } finally { setExporting(false) }
  }, [wasting, query, view, filtered, csvOf, toast])
  /** The ticked rows in full (a row ticked through "select all" on another page is read). */
  const fullPicked = useCallback(async (): Promise<AnyRow[]> => {
    const missing = pickedList.filter((p) => !('kind' in p)).map((p) => p.id)
    if (!missing.length) return pickedList as AnyRow[]
    const all = wasting ? (await readAllRows({ ...query, page: undefined, pageSize: undefined })).map(wasteGridRow) : (await readAllStopped({ ...query, page: undefined, pageSize: undefined })).map(stoppedGridRow)
    const map = new Map(all.map((r) => [r.id, r]))
    return pickedList.flatMap((p) => ('kind' in p ? [p as AnyRow] : map.get(p.id) ? [map.get(p.id)!] : []))
  }, [pickedList, wasting, query])
  const exportPicked = useCallback(async () => {
    try { downloadCsv(csvFileName(`negative-targeting-${view}`, { suffix: 'selected' }), csvOf(await fullPicked())) } catch (e) { toast(`Not exported: ${e instanceof Error ? e.message : String(e)}`, 'danger') }
  }, [view, csvOf, fullPicked, toast])
  const copyTerms = useCallback(async () => {
    try {
      const list = await fullPicked()
      await navigator.clipboard.writeText(list.map((r) => r.text).join('\n'))
      toast(`Copied ${plural(list.length, 'term')}`, 'success')
    } catch (e) { toast(`Not copied: ${e instanceof Error ? e.message : String(e)}`, 'danger') }
  }, [fullPicked, toast])

  /* ── bulk ── */
  const held = canWrite ? null : 'You can see ads here, not change them'
  const wasteCounts = useMemo(() => (wasting ? wasteBulkCounts(pickedList as Array<Picked<WasteRow>>) : null), [wasting, pickedList])
  const stoppedCounts = useMemo(() => (!wasting ? stoppedBulkCounts(pickedList as Array<Picked<StoppedRow>>) : null), [wasting, pickedList])
  const waits = useMemo(() => (wasting ? waitingOf(pickedList as Array<Picked<WasteRow>>) : []), [wasting, pickedList])
  const skips = useMemo(() => (wasting ? skipIds(pickedList as Array<Picked<WasteRow>>) : { skip: [], unskip: [] }), [wasting, pickedList])
  /** A ticked row's words and, when loaded, where it sits (the review always shows the place, audit S11). */
  const askRowOf = (id: string) => {
    const r = byId.get(id) ?? (picked.get(id) && 'text' in picked.get(id)! ? picked.get(id) as AnyRow : null)
    return { id, text: textOf(id), place: r ? [r.portfolio, r.campaign, r.adGroup] : undefined }
  }
  const textOf = (id: string) => (byId.get(id)?.text ?? (picked.get(id) && 'text' in picked.get(id)! ? (picked.get(id) as AnyRow).text : id.replace(/^term:[^|]*\|[^|]*\|/, '').replace(/^kw:/, '')))
  const bulkWaste = (verb: WasteBulk) => {
    const plan = wasteBulkPlan(pickedList as Array<Picked<WasteRow>>, verb)
    askFrom({ kind: 'change', items: plan.items, left: plan.left })
  }
  const bulkStopped = (verb: StoppedBulk, keepUntil?: string | null) => {
    const plan = stoppedBulkPlan(pickedList as Array<Picked<StoppedRow>>, verb, keepUntil)
    const keepFrom = Object.fromEntries(pickedList.map((p) => [p.id, 'keptPaused' in p && p.keptPaused ? p.keptPaused.until ?? 'ALWAYS' : NOT_KEPT]))
    askFrom({ kind: 'change', items: plan.items, left: plan.left, ...(verb === 'keepUntil' ? { keepFrom } : {}) })
  }
  const counted = (label: string, n: number, why: string) => ({ label: `${label} ${n}`, held: held ?? (n ? null : why) })
  const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10)

  const bulkBar = (() => {
    if (!picked.size) return null
    const pageAll = rows.length > 0 && rows.every((r) => picked.has(r.id))
    const total = read?.total ?? 0
    const more: MenuItemDef[] = []
    let main: ReactNode = null
    if (wasting && wasteCounts) {
      const pause = counted(WASTE_BULK_LABEL.pause, wasteCounts.pause, 'None of the ticked rows is our keyword running')
      const exact = counted(WASTE_BULK_LABEL.negExact, wasteCounts.negExact, 'None of the ticked rows is a search term running')
      main = (
        <>
          <Button size="sm" variant="primary" heldReason={pause.held} onClick={() => bulkWaste('pause')}>{pause.label}</Button>
          <Button size="sm" variant="primary" heldReason={exact.held} onClick={() => bulkWaste('negExact')}>{exact.label}</Button>
          {waits.length > 0 && (
            <>
              <Button size="sm" heldReason={held} onClick={() => askFrom({ kind: 'decide', decide: 'approve', waits })}>Approve {waits.length}</Button>
              <Button size="sm" heldReason={held} onClick={() => askFrom({ kind: 'decide', decide: 'reject', waits })}>Reject {waits.length}</Button>
            </>
          )}
          {held || !skips.skip.length
            ? <Button size="sm" heldReason={held ?? 'Nothing ticked to skip'}>Skip</Button>
            : <Menu label="Skip" align="left" triggerProps={{ className: 'nds-btn sm', 'aria-label': `Skip ${skips.skip.length}` }} items={[
              { id: '7', label: `${skips.skip.length} for 7 d`, onSelect: () => askFrom({ kind: 'skip', days: 7, rows: skips.skip.map(askRowOf) }) },
              { id: '30', label: `${skips.skip.length} for 30 d`, onSelect: () => askFrom({ kind: 'skip', days: 30, rows: skips.skip.map(askRowOf) }) },
            ]} />}
        </>
      )
      const item = (id: WasteBulk, why: string): MenuItemDef => {
        const n = wasteCounts[id]
        return { id, label: `${WASTE_BULK_LABEL[id]} ${n}`, disabled: !!held || !n, description: held ?? (n ? undefined : why), onSelect: () => bulkWaste(id) }
      }
      more.push(item('negPhrase', 'No search term (not a product) ticked'), item('negCampaign', 'No search term (not a product) ticked'))
      more.push({ id: 'unskip', label: `Unskip ${skips.unskip.length}`, disabled: !!held || !skips.unskip.length, description: held ?? (skips.unskip.length ? undefined : 'None of the ticked rows is skipped'), onSelect: () => askFrom({ kind: 'unskip', rows: skips.unskip.map(askRowOf) }) })
    } else if (stoppedCounts) {
      const on = counted(STOPPED_BULK_LABEL.turnOn, stoppedCounts.turnOn, 'None of the ticked rows can be turned on')
      const rm = counted(STOPPED_BULK_LABEL.remove, stoppedCounts.remove, 'None of the ticked rows is a negative you may remove')
      main = (
        <>
          <Button size="sm" heldReason={on.held} onClick={() => bulkStopped('turnOn')}>{on.label}</Button>
          <Button size="sm" variant="danger-outline" heldReason={rm.held} onClick={() => bulkStopped('remove')}>{rm.label}</Button>
          {held || !stoppedCounts.keepUntil
            ? <Button size="sm" heldReason={held ?? 'None of the ticked rows is a paused keyword'}>Keep paused</Button>
            : <Menu label="Keep paused" align="left" triggerProps={{ className: 'nds-btn sm', 'aria-label': `Keep ${stoppedCounts.keepUntil} paused until` }} items={[
              { id: '7', label: `${stoppedCounts.keepUntil} for 7 d`, onSelect: () => bulkStopped('keepUntil', inDays(7)) },
              { id: '30', label: `${stoppedCounts.keepUntil} for 30 d`, onSelect: () => bulkStopped('keepUntil', inDays(30)) },
              { id: 'always', label: `${stoppedCounts.keepUntil} always`, onSelect: () => bulkStopped('keepUntil', null) },
            ]} />}
        </>
      )
      more.push({ id: 'release', label: `${STOPPED_BULK_LABEL.release} ${stoppedCounts.release}`, disabled: !!held || !stoppedCounts.release, description: held ?? (stoppedCounts.release ? undefined : 'None of the ticked rows is kept paused'), onSelect: () => bulkStopped('release') })
    }
    more.push({ id: 'export', label: 'Export selected', onSelect: () => void exportPicked() }, { id: 'copy', label: 'Copy terms', onSelect: () => void copyTerms() })
    return (
      <GridToolbar count={<span className={styles.inline}>{viewSwitch}<span className={styles.count}>Selected <b>{picked.size}</b></span></span>}>
        <GridSelectionActions>
          {pageAll && total > picked.size && (
            <Button size="sm" variant="link" onClick={() => void selectAllMatching()} aria-busy={selectingAll || undefined}>{selectingAll ? 'Selecting…' : `Select all ${total}`}</Button>
          )}
          {main}
          <Menu label={<MoreHorizontal size={15} aria-hidden />} items={more} align="right" triggerProps={{ className: 'nds-btn sm', 'aria-label': 'More bulk actions' }} />
          <Button size="sm" variant="link" onClick={clearPicked}>Clear</Button>
        </GridSelectionActions>
      </GridToolbar>
    )
  })()

  /* ── toolbar ── */
  const scopeLabel = scope ? [...seen.current.values()].map((s) => (scope.level === 'pf' ? s.portfolio : scope.level === 'cp' ? s.campaign : s.adGroup)).find((r) => r?.id === scope.id)?.name ?? null : null
  const scopeOpts = useMemo(() => scopeOptions(seen.current.values(), scope, scopeLabel), [read, scope]) // eslint-disable-line react-hooks/exhaustive-deps
  const totalsNow = read?.totals ?? null
  const chips = wasting
    ? [
      { id: 'wasting', label: 'Wasting', count: (totalsNow as WasteTotals | null)?.wasting ?? null, title: 'Wasting now' },
      { id: 'waiting', label: 'Waiting', count: (totalsNow as WasteTotals | null)?.waiting ?? null, title: 'Waiting for you' },
      { id: 'skipped', label: 'Skipped', count: (totalsNow as WasteTotals | null)?.skipped ?? null, title: 'Skipped for now' },
      { id: 'turned-on', label: 'Turned on', count: (totalsNow as WasteTotals | null)?.turnedOn ?? null, title: 'Kept paused, but turned on outside Nexus' },
      { id: 'clashes', label: 'Clashes', count: (totalsNow as WasteTotals | null)?.clashes ?? null, title: 'Clashes the Owner should see' },
      { id: 'all', label: 'All', count: null, title: 'Every keyword and search term with numbers' },
    ]
    : stoppedChips(totalsNow as StoppedTotals | null)
  const total = read?.total ?? 0
  // Waiting counts asks, as its tile does (one ask may cover several places): "4 asks · 5 places" (audit N3).
  const shownCount = failed ? null : read ? (wasting && show === 'waiting' ? waitingCount((totalsNow as WasteTotals | null)?.waiting, total) : plural(total, 'row')) : 'Reading…'

  const filterControls = (
    <>
      <SegmentedControl size="sm" ariaLabel="Kind" options={KIND_OPTIONS} value={kind} onChange={(v) => setQuery({ kind: v === 'all' ? null : v, page: null })} />
      <Listbox size="sm" width={phone ? '100%' : 180} ariaLabel="Scope" searchable options={scopeOpts} value={scopeKey(scope) ?? ''} emptyLabel={market && market !== 'all' ? `All of ${market}` : 'All markets'}
        onChange={(v) => setQuery({ scope: v || null, page: null })} />
      <Listbox size="sm" width={phone ? '100%' : 164} ariaLabel="Show" value={show}
        options={chips.map((c) => ({ value: c.id, label: c.label, title: c.title, trailing: c.count != null ? <span className={styles.count}>{c.count}</span> : undefined }))}
        onChange={(v) => setQuery({ show: v === (wasting ? 'wasting' : 'all') ? null : v, page: null })} />
    </>
  )
  const activeFilters = [!!q.trim(), kind !== 'all', !!scope, wasting ? show !== 'wasting' : show !== 'all'].filter(Boolean).length
  const toolbar = bulkBar ?? (
    <GridToolbar
      count={<span className={styles.inline}>{viewSwitch}{shownCount != null && !phone && <span className={styles.count}>{shownCount}</span>}</span>}
      right={!phone ? (
        <span className={styles.toolbarRight}>
          <GridViewsMenu views={gridState} />
          <Button size="sm" variant="secondary" onClick={openCustomise}><SlidersHorizontal size={14} aria-hidden /> Customise</Button>
          <Button size="sm" variant="secondary" onClick={() => { if (!exporting) void exportAll() }} aria-busy={exporting || undefined} heldReason={total ? null : 'Nothing to export'}>
            <Download size={14} aria-hidden /> {exporting ? 'Exporting…' : 'Export'}
          </Button>
        </span>
      ) : undefined}
    >
      {!phone && (
        <GridSearchSlot>
          <SearchBox value={q} onCommit={(v) => setQuery({ q: v || null, page: null })} />
        </GridSearchSlot>
      )}
      {phone ? (
        // One button on the phone (audit S10): the table starts on the first screen; the filters open in a sheet.
        <Button size="sm" onClick={() => setFiltersOpen(true)} aria-label={`Filters${activeFilters ? `, ${activeFilters} on` : ''}`}>
          <SlidersHorizontal size={14} aria-hidden /> Filters{activeFilters ? ` · ${activeFilters}` : ''}
        </Button>
      ) : (
        <span className={styles.toolbarRow}>{filterControls}</span>
      )}
    </GridToolbar>
  )

  const noRowsParams = useMemo(() => {
    if (failed) return { title: wasting ? 'Wasting not read' : 'Stopped not read', message: err ?? '', action: { label: 'Try again', onClick: reload } }
    const w = emptyWords(view, show, filtered)
    return { title: w.title, message: '', action: w.clear ? { label: 'Clear filters', onClick: () => setQuery({ q: null, kind: null, scope: null, show: null, page: null }) } : undefined }
  }, [failed, err, reload, view, show, filtered, wasting, setQuery])

  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const pagerShown = !!read && !failed && total > PAGE_SIZES[0]
  const openRow = detail.id ? byId.get(detail.id) ?? null : null
  const nav = detail.id && navIds?.includes(detail.id) ? { ids: navIds, current: detail.id, onGo: (id: string) => detail.go(id), noun: wasting ? 'row' : 'stop' } : undefined

  return (
    <div className={styles.stack}>
      {err && read && (
        <Banner tone="danger" title={wasting ? 'Wasting not read' : 'Stopped not read'} action={<Button size="sm" variant="secondary" onClick={reload}>Try again</Button>}>{err}</Banner>
      )}
      <GridCard
        toolbar={toolbar}
        footer={pagerShown ? <GridPager page={page} pageCount={pageCount} pageSize={pageSize} pageSizes={PAGE_SIZES} onPage={(n) => setQuery({ page: n > 1 ? String(n) : null })} onPageSize={(n) => setQuery({ pageSize: n === DEFAULT_PAGE_SIZE ? null : String(n), page: null })} /> : undefined}
      >
        <NexusGrid<AnyRow>
          key={`${view}|${phone ? 'phone' : 'desk'}`}
          domLayout="autoHeight"
          suppressCellFocus={false}
          rowData={failed ? [] : rows}
          getRowId={ROW_ID}
          columnDefs={columnDefs}
          rowSelection={!phone && canWrite ? SELECTION : undefined}
          rowHeight={phone ? 76 : undefined}
          initialState={initialState}
          columnDialog={columnDialog}
          context={cellContext}
          loading={loading || (reading && failed)}
          loadingOverlayComponent={GridLoadingOverlay}
          loadingOverlayComponentParams={LOADING_PARAMS}
          noRowsOverlayComponent={GridNoRowsOverlay}
          noRowsOverlayComponentParams={noRowsParams}
          rowClass={styles.clickRow}
          onGridReady={onGridReady}
          onRowClicked={onRowClicked}
          onCellKeyDown={onCellKeyDown}
          onSelectionChanged={onSelectionChanged}
          onSortChanged={onSortChanged}
        />
      </GridCard>

      {detail.id && (
        <RowDetail
          id={detail.id}
          listRow={openRow}
          market={market}
          tab={detailTabOf(detail.tab)}
          onTab={(t) => detail.setTab(t === 'overview' ? null : t)}
          nav={nav}
          canWrite={canWrite}
          version={version}
          onAsk={askFrom}
          onClose={detail.close}
          onOpen={(id) => detail.go(id)}
          ruleHref={ruleHref}
          returnFocusTo={detail.id !== openerId.current ? recordFocus : undefined}
        />
      )}

      {review && (
        <ReviewChangesModal
          open
          onClose={closeReview}
          title={review.state.phase === 'done' ? undefined : review.title}
          changes={review.changes}
          state={review.state}
          summary={review.summary}
          problems={review.problems}
          saveLabel={review.saveLabel}
          doneVerb={review.doneVerb}
          ackLabel={review.ackLabel}
          onSave={() => void save()}
          onRetry={retry}
          doneActions={review.state.phase === 'done' && (review.undo || review.noUndo) ? (
            <Button heldReason={review.undo ? null : review.noUndo} aria-busy={review.undoing || undefined} onClick={() => { if (!review.undoing) void undoSaved() }}>
              {review.undoing ? 'Undoing…' : review.undoLabel ?? 'Undo'}
            </Button>
          ) : undefined}
          returnFocusTo={detail.id ? undefined : reviewFocus}
          size="xl"
        />
      )}

      {stepUp && review && (
        <StepUpModal
          open
          title="Your code"
          sentence="Turning a kept-paused keyword on lets it spend again. Your authenticator code approves it."
          busy={stepUp.busy}
          error={stepUp.error}
          confirmLabel={review.saveLabel}
          onSubmit={(code) => void submitCode(code)}
          onClose={cancelCode}
        />
      )}

      {filtersOpen && (
        <Modal open onClose={() => setFiltersOpen(false)} title="Filters" size="sm"
          footer={<><span className="grow" /><Button variant="primary" onClick={() => setFiltersOpen(false)}>Done</Button></>}>
          <div className={styles.filterSheet}>
            <SearchBox value={q} onCommit={(v) => setQuery({ q: v || null, page: null })} />
            {filterControls}
          </div>
        </Modal>
      )}

      {prefsOpen && (
        <PreferencesModal
          open={prefsOpen}
          onClose={() => setPrefsOpen(false)}
          value={prefs}
          onConfirm={applyPrefs}
          allColumns={preferenceSpecs}
          defaultVisible={defaultPrefs.visibleColumns}
          pageSizeChoices={NO_CHOICES}
          sortFieldOptions={NO_SORT_OPTIONS}
          showSticky={false}
          title="Customise columns"
        />
      )}
    </div>
  )
}

/** The search box: the address holds what was searched (a short pause after typing, or Enter). */
function SearchBox({ value, onCommit }: { value: string; onCommit(v: string): void }) {
  const [draft, setDraft] = useState(value)
  const last = useRef(value)
  useEffect(() => { if (value !== last.current) { last.current = value; setDraft(value) } }, [value])
  useEffect(() => {
    if (draft === last.current) return
    const t = window.setTimeout(() => { last.current = draft.trim(); onCommit(draft.trim()) }, 350)
    return () => window.clearTimeout(t)
  }, [draft]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Input size="sm" type="search" aria-label="Search terms, campaigns, ad groups, products" placeholder="Search" leadingIcon={<Search size={14} aria-hidden />}
      value={draft} onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') { last.current = draft.trim(); onCommit(draft.trim()) } }} />
  )
}
