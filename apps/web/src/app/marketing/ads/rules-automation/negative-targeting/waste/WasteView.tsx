'use client'

/**
 * Negative Targeting page (2026-10-11, lane NVIEW) — the Wasting and the Stopped views: ONE NexusGrid card each, built
 * like the Listings page (ListingReadinessClient: GridToolbar · NexusGrid · GridPager in one `nds-gridcard`, a note).
 *
 * The redesign (2026-10-26, BRIEF D1, D5–D8, D12, D13, D16):
 *   toolbar   [Wasting | Stopped | Words | Rules] · "9 rows · €754.50" · Search        density · Customise · Views · status
 *   filter    the page's filter bar above the card (Portfolio · Campaign · Ad group · Product · Kind · Show): every read
 *             sends its lists — the rows, the totals, "Select all N", Prev / Next and Export follow it
 *   ticked    the bulk actions take the search box's place: "3 ticked" · "Select all M" · the verbs, each counted and
 *             secondary (a verb that fits none is held and says why) · ⋯ · Clear; the density toggle steps aside
 *   grid      two-line rows, server pages (`?page=`, `?sort=`), checkboxes, header select-page; a row (click or Enter)
 *             opens its record; one secondary verb per row (a waiting row: Approve · Reject) and the ⋯
 *   footer    the pager, always ("1–9 of 9"); under the card one note in the code's own words
 *   export    the page header's Export ▾ (This view as CSV · Ticked rows as CSV): this view hands its items up
 *   states    reading (skeleton rows, "Reading…", "Updating…") · empty (a DS EmptyState, "Clear filters") · failed (the
 *             read's own words with Try again — never "nothing here", audit M4; "Not updating") · a failed re-read over
 *             rows already shown (a banner above the card)
 *   phone     the same columns scrolling sideways in the card, no ticks, no density / Customise / Views; the search on
 *             its own line; a tap opens the full-screen sheet
 *
 * Every write goes through the review (`useWasteReview`), above the record when one is open; after it the rows, the
 * tiles and the record are read again.
 *
 * Step 4: Show ▾ Protected (`?show=protected`, the Protected tile); a protected row's verb opens its
 * record (Keep protected · Remove protection and stop there); ticked protected rows: "Keep protected N" (Skip 30 d) and
 * "Remove protection and stop N" (one review: one removal per protected term, then each row's own verb).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, CircleCheck, ChevronDown, MoreHorizontal, Search, SearchX, SlidersHorizontal } from 'lucide-react'
import { Button, Input, Pill } from '@/design-system/primitives'
import { Banner, EmptyState, Menu, useNarrow, useToast, type MenuItemDef } from '@/design-system/components'
import { GridToolbar, PreferencesModal, ReviewChangesModal, StepUpModal, type PreferencesValue } from '@/design-system/patterns'
import {
  AG_SELECTION_COL, cellOf, columnStateToPrefs, csvFileName, DEFAULT_GRID_DENSITY, downloadCsv, GRID_DENSITIES, gridSelection, GridCard, GridDensityProvider,
  GridDensityToggle, GridLoadingOverlay, GridPager, GridSearchSlot, GridSelectionActions, GridViewsMenu, NexusGrid, prefsToColumnState, toCsv, useGridState,
  type GridApi, type GridDensityName, type GridReadyEvent, type GridStateKey, type NexusGridProps, type PrefsBridgeOptions,
} from '@/design-system/grid'
import { getBackendUrl } from '@/lib/backend-url'
import { usePermission } from '@/lib/auth/AuthProvider'
import { useDetailParam } from '../../../_shared/useDetailParam'
import { currencyOf } from '../../bid/_shared/format'
import { FILTER_EMPTY } from '../../_shared/scopeFilter/scopeFilterModel'
import type { ScopeView } from '../../_shared/scopeFilter/useScopeFilter'
import {
  STOPPED_COLUMN_SPECS, WASTE_COLUMN_SPECS, stoppedColumns, stoppedGridRow, wasteColumns, wasteGridRow, withVerbHandler,
  type CellContext, type CellHandlers, type StoppedGridRow, type WasteGridRow,
} from './columns'
import { gridStartState } from './gridStart'
import { RowDetail } from './RowDetail'
import { readAllRows, readAllStopped, readRowIds, readRows, readStopped } from './wasteApi'
import {
  DEFAULT_PAGE_SIZE, NOT_KEPT, writeHeld, detailTabOf, emptyWords, noteLine, PAGE_SIZES, pagerWords, plural, skipIds, sortOf, sortParam, stoppedBulkCounts, stoppedBulkPlan,
  stoppedCsvRow, STOPPED_BULK_LABEL, STOPPED_CSV_HEADERS, tickedCount, toolbarCount, viewSort, waitingOf, WASTE_BULK_LABEL, WASTE_CSV_HEADERS, wasteBulkCounts, wasteBulkPlan,
  wasteCsvRow, type CountPart, type KindFilter, type ListQuery, type Picked, type RowMenuVerb, type RowVerbView, type StoppedBulk, type WasteBulk,
} from './wasteModel'
import type { StoppedRow, StoppedTotals, WasteCriteria, WasteFreshness, WasteRow, WasteTotals } from './wasteTypes'
import { useWasteReview, type WasteAsk } from './useWasteReview'
import { KEEP_PROTECTED_DAYS, keepProtectedIds, removeProtectionBulkCount, removeProtectionBulkPlan, UNPROTECT_PERMISSIONS } from './protectionModel'
import styles from '../negatives.module.css'

type AnyRow = WasteGridRow | StoppedGridRow

export interface WasteViewProps {
  view: 'wasting' | 'stopped'
  market: string | null
  viewSwitch: ReactNode
  show: string
  kind: KindFilter
  q: string
  /** The page's filter bar: every read sends its lists. */
  scope?: ScopeView
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
  /** The redesign (D2): this view's items for the page header's Export ▾ (This view as CSV · Ticked rows as CSV); null
   *  when the view leaves. */
  onExportItems?(items: MenuItemDef[] | null): void
  /** After each Wasting read: the server's test and how fresh its numbers are (the header line, the tiles' window). */
  onRead?(facts: { criteria: WasteCriteria | null; freshness: WasteFreshness | null }): void
}

/* ── stable grid options (GDS decision 12) ───────────────────────────────────────────────────────────────────────── */

const ROW_ID: NonNullable<NexusGridProps<AnyRow>['getRowId']> = (p) => p.data.id
/** The skeleton draws the rows' own height (two lines) at the grid's density. */
const LOADING_PARAMS = { rows: 8, rowKind: 'two-line' as const }
const PERSIST_KEYS: readonly GridStateKey[] = ['columnSizing', 'columnOrder', 'columnVisibility', 'columnPinning']
const NO_CHOICES: number[] = []
const NO_SORT_OPTIONS: Array<{ value: string; label: string }> = []
const SELECTION = gridSelection<AnyRow>({ selectAll: 'currentPage' }) as NexusGridProps<AnyRow>['rowSelection']
/** Cells that answer Enter themselves (a link, a list, a button): Enter there never opens the record. */
const OWN_KEY_COLUMNS = new Set(['where', 'product', 'owner', 'actions', 'since'])
/** What the grid's remembered state keeps beside AG's own: the density (D5). */
interface PageState { density?: GridDensityName }
const isDensity = (v: unknown): v is GridDensityName => (GRID_DENSITIES as readonly unknown[]).includes(v)

interface Read { rows: AnyRow[]; total: number; totals: WasteTotals | StoppedTotals; criteria: WasteCriteria | null; freshness: WasteFreshness | null }

/** A count in the DS toolbar's form: the numbers bold ("<b>9</b> rows · <b>€754.50</b>"). */
function CountWords({ parts }: { parts: readonly CountPart[] }) {
  return <>{parts.map((p, i) => <span key={i}>{i > 0 ? ' · ' : null}<b>{p.n}</b>{p.words}</span>)}</>
}

export function WasteView(props: WasteViewProps) {
  const { view, market, viewSwitch, show, kind, q, scope, sort, page, pageSize, canWrite, setQuery, onTotals, onWrote, refreshKey, ruleHref, onExportItems, onRead } = props
  const phone = useNarrow()
  const { toast } = useToast()
  const wasting = view === 'wasting'
  const scopeKey = scope?.key ?? ''
  const query: ListQuery = useMemo(() => ({ market, lists: scope?.api ?? null, kind, show, q, sort: viewSort(view, sort), page, pageSize }), [market, scopeKey, kind, show, q, sort, page, pageSize, view]) // eslint-disable-line react-hooks/exhaustive-deps
  const queryKey = JSON.stringify(query)

  /* ── the read ── */
  const [read, setRead] = useState<Read | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [reading, setReading] = useState(true)
  const [again, setAgain] = useState(0)
  const [version, setVersion] = useState(0)
  const onTotalsRef = useRef(onTotals)
  onTotalsRef.current = onTotals
  const onReadRef = useRef(onRead)
  onReadRef.current = onRead
  useEffect(() => {
    const ctl = new AbortController()
    setReading(true)
    const run = async () => {
      try {
        const out: Read = wasting
          ? await readRows(query, ctl.signal).then((a) => ({ rows: a.rows.map(wasteGridRow), total: a.total, totals: a.totals, criteria: a.criteria ?? null, freshness: a.freshness ?? null }))
          : await readStopped(query, ctl.signal).then((a) => ({ rows: a.rows.map(stoppedGridRow), total: a.total, totals: a.totals, criteria: null, freshness: null }))
        if (ctl.signal.aborted) return
        setRead(out)
        setErr(null)
        setReading(false)
        onTotalsRef.current(out.totals)
        if (wasting) onReadRef.current?.({ criteria: out.criteria, freshness: out.freshness })
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
  const scopeActive = !!scope?.active
  /** The view's own filters (its toolbar); the page's filter bar is `scopeActive`. */
  const ownFiltered = !!q.trim() || kind !== 'all' || (wasting ? show !== 'wasting' : show !== 'all')
  const filtered = ownFiltered || scopeActive

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
  useEffect(() => { setPicked(new Map()) }, [shapeKey, q, kind, show, scopeKey]) // eslint-disable-line react-hooks/exhaustive-deps
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
  const { review, stepUp, ask, save, submitCode, cancelCode, undoSaved, retry, close, size: reviewSize } = useWasteReview({ market, after: afterWrite })
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

  /** A row's words and, when loaded, where it sits (the review always shows the place, audit S11). */
  const textOf = (id: string) => (byId.get(id)?.text ?? (picked.get(id) && 'text' in picked.get(id)! ? (picked.get(id) as AnyRow).text : id.replace(/^term:[^|]*\|[^|]*\|/, '').replace(/^kw:/, '')))
  const askRowOf = (id: string) => {
    const r = byId.get(id) ?? (picked.get(id) && 'text' in picked.get(id)! ? picked.get(id) as AnyRow : null)
    return { id, text: textOf(id), place: r ? [r.portfolio, r.campaign, r.adGroup] : undefined }
  }

  /* ── the grid ── */
  const handlers = useRef<CellHandlers>({ verb: () => {}, ruleHref: () => '', noWrite: null })
  handlers.current = {
    verb: (rowId: string, v: RowVerbView) => {
      if (v.held) return
      // Step 4 — a protected row's two actions are in its record.
      if (v.opens) { openRecord(rowId); return }
      askFrom({ kind: 'change', items: [{ rowId, action: v.action, ...(v.where ? { where: v.where } : {}), ...(v.targetRowId ? { targetRowId: v.targetRowId } : {}) }] })
    },
    // D12 — Approve / Reject in a waiting row: the ask's own review (one ask may cover several places: one decision).
    decide: (rowId: string, decide: 'approve' | 'reject') => {
      if (!canWrite) return
      const row = byId.get(rowId) as WasteRow | undefined
      if (!wasting || !row?.waiting) return
      askFrom({ kind: 'decide', decide, waits: waitingOf([row]) })
    },
    // The row's ⋯ (wasteModel.ts wasteRowMenu / stoppedRowMenu): every write through its review; Open record always.
    menu: (rowId: string, entry: RowMenuVerb) => {
      const a = entry.ask
      if (a.kind === 'record') { openRecord(rowId); return }
      if (entry.held) return
      if (a.kind === 'skip') askFrom({ kind: 'skip', days: a.days, rows: [askRowOf(rowId)] })
      else if (a.kind === 'unskip') askFrom({ kind: 'unskip', rows: [askRowOf(rowId)] })
      else askFrom({ kind: 'change', items: [a.item], ...(a.keepFrom !== undefined ? { keepFrom: { [rowId]: a.keepFrom } } : {}) })
    },
    open: (rowId: string) => openRecord(rowId),
    ruleHref,
    noWrite: writeHeld(canWrite),
  }
  // The rows' verbs are held for a person who may not change ads: drawn again when that is known.
  useEffect(() => { const api = apiRef.current; if (api && !api.isDestroyed()) api.refreshCells({ columns: ['actions'], force: true }) }, [canWrite])
  const cellContext = handlers as CellContext
  const specs = wasting ? WASTE_COLUMN_SPECS : STOPPED_COLUMN_SPECS
  const columnDefs = useMemo(() => {
    const base = wasting ? wasteColumns(phone) : stoppedColumns(phone)
    // Waiting rows carry the longest state chip ("Waiting · asked by Brain"): the State column is wider there (the
    // board's waiting column set), so the chip is never cut.
    const cols = wasting && show === 'waiting' && !phone ? base.map((c) => (c.colId === 'state' ? { ...c, width: 214 } : c)) : base
    return withVerbHandler(cols as never, cellContext, wasting ? 'waste' : 'stopped') as NexusGridProps<AnyRow>['columnDefs']
  }, [phone, wasting, show === 'waiting']) // eslint-disable-line react-hooks/exhaustive-deps
  const bridge = useMemo<PrefsBridgeOptions>(() => ({ columns: specs.map((c) => ({ key: c.key, locked: c.locked })) }), [specs])
  const preferenceSpecs = useMemo(() => specs.map((c) => ({ key: c.key, label: c.label, locked: c.locked })), [specs])
  const defaultPrefs = useMemo<PreferencesValue>(() => ({
    visibleColumns: specs.filter((c) => !c.hidden).map((c) => c.key), lockedColumns: [], stickyFirstColumn: true, stickyLastColumn: false, pageSize: 0, sortBy: '', sortDir: 'asc',
  }), [specs])
  // D5 — the density (Compact · Cozy · Spacious) is remembered with the layout, as on Listings.
  const [density, setDensity] = useState<GridDensityName>(DEFAULT_GRID_DENSITY)
  const densityRef = useRef(density)
  densityRef.current = density
  const gridState = useGridState<PageState>({
    surface: wasting ? 'ads-neg-wasting' : 'ads-neg-stopped', baseUrl: getBackendUrl(), persistKeys: PERSIST_KEYS,
    getPageState: () => ({ density: densityRef.current }),
    applyPageState: (p) => { if (p && isDensity(p.density)) setDensity(p.density) },
    // Land on the scope's default view even when it answers after the grid is up (grid audit F7).
    landOnLateDefault: true,
  })
  const lastDensity = gridState.lastUsed?.page?.density
  useEffect(() => { if (isDensity(lastDensity)) setDensity(lastDensity) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const markDirty = gridState.markDirty
  const pickDensity = useCallback((d: GridDensityName) => { setDensity(d); markDirty() }, [markDirty])
  const bindState = useRef(gridState.bind)
  bindState.current = gridState.bind
  const sortNow = useRef(sort)
  sortNow.current = sort
  // One start for the page's tables (gridStart.ts): the saved layout of this tab, else its default with the hidden
  // columns named. A phone draws the same columns (D16) but never takes the desktop's saved widths and order.
  const initialState = useMemo(() => gridStartState({
    saved: phone ? null : gridState.initialState, hidden: specs.filter((c) => c.hidden).map((c) => c.key), sort: sortOf(viewSort(view, sort)), phone: false,
  }), [gridState.initialState, phone]) // eslint-disable-line react-hooks/exhaustive-deps
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
    // Step 4 — Shift+Enter on the Term cell opens the protected term's panel (protectionModel termKeys), not the record.
    if (col === 'term' && key.shiftKey) return
    openRecord(e.data.id)
  }, [openRecord])

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
  const held = writeHeld(canWrite)
  const wasteCounts = useMemo(() => (wasting ? wasteBulkCounts(pickedList as Array<Picked<WasteRow>>) : null), [wasting, pickedList])
  const stoppedCounts = useMemo(() => (!wasting ? stoppedBulkCounts(pickedList as Array<Picked<StoppedRow>>) : null), [wasting, pickedList])
  const waits = useMemo(() => (wasting ? waitingOf(pickedList as Array<Picked<WasteRow>>) : []), [wasting, pickedList])
  const skips = useMemo(() => (wasting ? skipIds(pickedList as Array<Picked<WasteRow>>) : { skip: [], unskip: [] }), [wasting, pickedList])
  const keepIds = useMemo(() => (wasting ? keepProtectedIds(pickedList as Array<Picked<WasteRow>>) : []), [wasting, pickedList])
  // Step 4 — the removal's tool asks these on top of changing ads here (the same permissions as today).
  const unprotectPerms = [usePermission(UNPROTECT_PERMISSIONS[0]), usePermission(UNPROTECT_PERMISSIONS[1]), usePermission(UNPROTECT_PERMISSIONS[2]), usePermission(UNPROTECT_PERMISSIONS[3])]
  const unprotect = { write: canWrite, unprotect: unprotectPerms.every(Boolean) }
  const removeCount = useMemo(() => (wasting ? removeProtectionBulkCount(pickedList as Array<Picked<WasteRow>>, unprotect) : 0), [wasting, pickedList, unprotect.write, unprotect.unprotect]) // eslint-disable-line react-hooks/exhaustive-deps
  const bulkWaste = (verb: WasteBulk) => {
    const plan = wasteBulkPlan(pickedList as Array<Picked<WasteRow>>, verb)
    askFrom({ kind: 'change', items: plan.items, left: plan.left })
  }
  /** Step 4 — one review: one removal per protected term across the ticked rows, then each row's own verb. */
  const bulkRemoveProtection = async () => {
    try {
      const plan = removeProtectionBulkPlan(await fullPicked() as WasteRow[], unprotect)
      askFrom({ kind: 'change', items: plan.items, left: plan.left })
    } catch (e) { toast(`Not read: ${e instanceof Error ? e.message : String(e)}`, 'danger') }
  }
  const bulkStopped = (verb: StoppedBulk, keepUntil?: string | null) => {
    const plan = stoppedBulkPlan(pickedList as Array<Picked<StoppedRow>>, verb, keepUntil)
    const keepFrom = Object.fromEntries(pickedList.map((p) => [p.id, 'keptPaused' in p && p.keptPaused ? p.keptPaused.until ?? 'ALWAYS' : NOT_KEPT]))
    askFrom({ kind: 'change', items: plan.items, left: plan.left, ...(verb === 'keepUntil' ? { keepFrom } : {}) })
  }
  const counted = (label: string, n: number, why: string) => ({ label: `${label} ${n}`, held: held ?? (n ? null : why) })
  const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10)
  /** A menu button of the bulk bar, the DS `sm` button with its chevron. */
  const menuButton = (label: string, aria: string, items: MenuItemDef[]) => (
    <Menu label={<>{label} <ChevronDown size={13} aria-hidden /></>} align="left" triggerProps={{ className: 'nds-btn sm', 'aria-label': aria }} items={items} />
  )

  // D5 — ticked rows: the bulk actions take the search box's place; every verb is secondary and counted (Listings).
  const bulkActions = (() => {
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
          <Button size="sm" heldReason={pause.held} onClick={() => bulkWaste('pause')}>{pause.label}</Button>
          <Button size="sm" heldReason={exact.held} onClick={() => bulkWaste('negExact')}>{exact.label}</Button>
          {(keepIds.length > 0 || show === 'protected') && (
            <Button size="sm" heldReason={held ?? (keepIds.length ? null : 'None of the ticked rows is protected')}
              onClick={() => askFrom({ kind: 'skip', keep: 'protected', days: KEEP_PROTECTED_DAYS, rows: keepIds.map(askRowOf) })}>Keep protected {keepIds.length}</Button>
          )}
          {(removeCount > 0 || show === 'protected') && (
            <Button size="sm" heldReason={held ?? (!unprotect.unprotect ? 'Removing a protected term needs the ads automation, bids, budgets and ad spend permissions' : removeCount ? null : 'None of the ticked rows stops once its protection is removed')}
              onClick={() => void bulkRemoveProtection()}>Remove protection and stop {removeCount}</Button>
          )}
          {waits.length > 0 && (
            <>
              <Button size="sm" heldReason={held} onClick={() => askFrom({ kind: 'decide', decide: 'approve', waits })}>Approve {waits.length}</Button>
              <Button size="sm" heldReason={held} onClick={() => askFrom({ kind: 'decide', decide: 'reject', waits })}>Reject {waits.length}</Button>
            </>
          )}
          {held || !skips.skip.length
            ? <Button size="sm" heldReason={held ?? 'Nothing ticked to skip'}>Skip</Button>
            : menuButton('Skip', `Skip ${skips.skip.length}`, [
              { id: '7', label: `${skips.skip.length} for 7 d`, onSelect: () => askFrom({ kind: 'skip', days: 7, rows: skips.skip.map(askRowOf) }) },
              { id: '30', label: `${skips.skip.length} for 30 d`, onSelect: () => askFrom({ kind: 'skip', days: 30, rows: skips.skip.map(askRowOf) }) },
            ])}
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
            : menuButton('Keep paused', `Keep ${stoppedCounts.keepUntil} paused until`, [
              { id: '7', label: `${stoppedCounts.keepUntil} for 7 d`, onSelect: () => bulkStopped('keepUntil', inDays(7)) },
              { id: '30', label: `${stoppedCounts.keepUntil} for 30 d`, onSelect: () => bulkStopped('keepUntil', inDays(30)) },
              { id: 'always', label: `${stoppedCounts.keepUntil} always`, onSelect: () => bulkStopped('keepUntil', null) },
            ])}
        </>
      )
      more.push({ id: 'release', label: `${STOPPED_BULK_LABEL.release} ${stoppedCounts.release}`, disabled: !!held || !stoppedCounts.release, description: held ?? (stoppedCounts.release ? undefined : 'None of the ticked rows is kept paused'), onSelect: () => bulkStopped('release') })
    }
    more.push({ id: 'sep', separator: true }, { id: 'export', label: 'Export selected', onSelect: () => void exportPicked() }, { id: 'copy', label: 'Copy terms', onSelect: () => void copyTerms() })
    return (
      <GridSelectionActions>
        {pageAll && total > picked.size && (
          <Button size="sm" variant="link" onClick={() => void selectAllMatching()} aria-busy={selectingAll || undefined}>{selectingAll ? 'Selecting…' : `Select all ${total}`}</Button>
        )}
        {main}
        <Menu label={<MoreHorizontal size={15} aria-hidden />} items={more} align="right" triggerProps={{ className: 'nds-btn sm icon', 'aria-label': 'More bulk actions' }} />
        <Button size="sm" variant="link" onClick={clearPicked}>Clear</Button>
      </GridSelectionActions>
    )
  })()

  /* ── the header's Export ▾ (D2): this view as CSV, the ticked rows as CSV ── */
  const total = read?.total ?? 0
  const exportItems = useMemo<MenuItemDef[]>(() => [
    total
      ? { id: 'view', label: exporting ? 'Exporting…' : 'This view as CSV', onSelect: () => { if (!exporting) void exportAll() } }
      : { id: 'view', label: 'This view as CSV', disabled: true, description: 'Nothing to export' },
    picked.size
      ? { id: 'ticked', label: 'Ticked rows as CSV', onSelect: () => void exportPicked() }
      : { id: 'ticked', label: 'Ticked rows as CSV', disabled: true, description: 'No rows ticked' },
  ], [total, exporting, exportAll, picked.size, exportPicked])
  const onExportRef = useRef(onExportItems)
  onExportRef.current = onExportItems
  useEffect(() => { onExportRef.current?.(exportItems) }, [exportItems])
  useEffect(() => () => onExportRef.current?.(null), [])

  /* ── toolbar (D5): the view switch · the count · the search | density · Customise · Views · status ── */
  const totalsNow = read?.totals ?? null
  const countParts: CountPart[] | null = failed ? null : read
    ? (picked.size ? tickedCount(picked.size) : toolbarCount({ view, show, kind, total, totals: totalsNow, currency: currencyOf(market) }))
    : null
  const status = (
    <Pill tone={err ? 'danger' : 'success'} dot size="md">{err ? 'Not updating' : reading ? 'Updating…' : 'Up to date'}</Pill>
  )
  const search = (
    <GridSearchSlot>
      <SearchBox value={q} onCommit={(v) => setQuery({ q: v || null, page: null })} />
    </GridSearchSlot>
  )
  const toolbar = (
    <GridToolbar
      right={(
        <>
          {/* Density steps aside while rows are ticked: the bulk actions need the room (Listings). */}
          {!phone && !bulkActions && <GridDensityToggle value={density} onChange={pickDensity} />}
          {!phone && <Button size="sm" onClick={openCustomise}><SlidersHorizontal size={13} aria-hidden /> Customise</Button>}
          {!phone && <GridViewsMenu views={gridState} />}
          {status}
          {/* A phone: the search takes its own line under the bar (the card's narrow rule). */}
          {phone && search}
        </>
      )}
    >
      {viewSwitch}
      {countParts ? <span className="cnt"><CountWords parts={countParts} /></span> : !read && !failed ? <span className="cnt">Reading…</span> : null}
      {bulkActions ?? (!phone && search)}
    </GridToolbar>
  )

  /* ── states (States board): empty and failed are a DS EmptyState in the grid; reading is its skeleton ── */
  const clearScope = scope?.clear
  const emptyState = useMemo(() => {
    if (failed) {
      return <EmptyState icon={<AlertCircle size={20} aria-hidden />} title={wasting ? 'Wasting not read' : 'Stopped not read'} description={err ?? undefined}
        action={<Button size="sm" onClick={reload}>Try again</Button>} />
    }
    // Only the page's filter bar narrows: say so, and clear it.
    if (scopeActive && clearScope && !ownFiltered) {
      return <EmptyState icon={<SearchX size={20} aria-hidden />} title={FILTER_EMPTY.title} action={<Button size="sm" onClick={() => clearScope()}>{FILTER_EMPTY.clear}</Button>} />
    }
    // Step 4 — a Show with nothing in it says so in its own words ("Nothing wasting is protected"); the search, the kind
    // and the filter bar narrow beyond it ("Nothing matches these filters").
    const narrowed = !!q.trim() || kind !== 'all' || scopeActive
    const w = emptyWords(view, show, narrowed)
    // Clear filters clears the view's own and the filter bar's in ONE address change (two in one tick lose the first).
    const own = { q: null, kind: null, show: null, page: null }
    return (
      <EmptyState icon={narrowed ? <SearchX size={20} aria-hidden /> : <CircleCheck size={20} aria-hidden />} title={w.title}
        action={w.clear ? <Button size="sm" onClick={() => (scopeActive && clearScope ? clearScope(own) : setQuery(own))}>Clear filters</Button> : undefined} />
    )
  }, [failed, err, reload, view, show, q, kind, ownFiltered, scopeActive, clearScope, wasting, setQuery])

  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  // D7 — the pager is always there once the rows are read (never over a failed read or the first read).
  const pagerShown = !!read && !failed
  const openRow = detail.id ? byId.get(detail.id) ?? null : null
  const nav = detail.id && navIds?.includes(detail.id) ? { ids: navIds, current: detail.id, onGo: (id: string) => detail.go(id), noun: wasting ? 'row' : 'stop' } : undefined
  const note = noteLine(view, read?.criteria)

  return (
    <div className={styles.stack}>
      {err && read && (
        <Banner tone="danger" title={wasting ? 'Wasting not read' : 'Stopped not read'} action={<Button size="sm" variant="secondary" onClick={reload}>Try again</Button>}>{err}</Banner>
      )}
      <div className={styles.cardWrap}>
        <GridCard
          toolbar={toolbar}
          footer={pagerShown ? (
            <GridPager page={page} pageCount={pageCount} pageSize={pageSize} pageSizes={PAGE_SIZES}
              left={<span className={styles.pagerWords}>{pagerWords(page, pageSize, total)}</span>}
              onPage={(n) => setQuery({ page: n > 1 ? String(n) : null })} onPageSize={(n) => setQuery({ pageSize: n === DEFAULT_PAGE_SIZE ? null : String(n), page: null })} />
          ) : undefined}
        >
          <GridDensityProvider value={density}>
            <NexusGrid<AnyRow>
              key={`${view}|${phone ? 'phone' : 'desk'}`}
              domLayout="autoHeight"
              suppressCellFocus={false}
              rowData={failed ? [] : rows}
              getRowId={ROW_ID}
              columnDefs={columnDefs}
              rowSelection={!phone && canWrite ? SELECTION : undefined}
              density={density}
              rows="two-line"
              initialState={initialState}
              columnDialog={columnDialog}
              context={cellContext}
              loading={loading || (reading && failed)}
              loadingOverlayComponent={GridLoadingOverlay}
              loadingOverlayComponentParams={LOADING_PARAMS}
              emptyState={emptyState}
              rowClass={styles.clickRow}
              onGridReady={onGridReady}
              onRowClicked={onRowClicked}
              onCellKeyDown={onCellKeyDown}
              onSelectionChanged={onSelectionChanged}
              onSortChanged={onSortChanged}
            />
          </GridDensityProvider>
        </GridCard>
        {note && <p className={styles.note}>{note}</p>}
      </div>

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
          lead={review.lead}
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
          // The review's own size (useWasteReview): on a phone the full-screen sheet with each change a stacked card.
          size={reviewSize}
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

/** The search box: the address holds what was searched (a short pause after typing, or Enter). The Words view's too. */
export function SearchBox({ value, onCommit, label = 'Search terms, campaigns, ad groups, products' }: { value: string; onCommit(v: string): void; label?: string }) {
  const [draft, setDraft] = useState(value)
  const last = useRef(value)
  useEffect(() => { if (value !== last.current) { last.current = value; setDraft(value) } }, [value])
  useEffect(() => {
    if (draft === last.current) return
    const t = window.setTimeout(() => { last.current = draft.trim(); onCommit(draft.trim()) }, 350)
    return () => window.clearTimeout(t)
  }, [draft]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Input size="sm" type="search" aria-label={label} placeholder="Search" leadingIcon={<Search size={14} aria-hidden />}
      value={draft} onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') { last.current = draft.trim(); onCommit(draft.trim()) } }} />
  )
}
