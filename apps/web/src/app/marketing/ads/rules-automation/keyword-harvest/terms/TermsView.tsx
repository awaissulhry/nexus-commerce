'use client'

/**
 * Keyword Harvest page — the Terms view (2026-10-11, lane TERMS): every search term that sells, one row per term ×
 * product × market (GET /api/advertising/harvest/candidates), built like /products: ONE grid card, a checkbox column with
 * the header ticking the page, "Select all N" once the page is ticked (the rows read), the bulk bar while ticked,
 * Views, Customise, Export, the pager.
 *
 *   bulk    Harvest (each to its suggested place) · Harvest to… (one place for all) · Approve / Reject (waiting) ·
 *           Skip 7 d / 30 d / for good · Unskip · Undo harvest · Export selected · Copy terms — each reviewed, Done with Undo
 *   row     Harvest · Approve / Reject · Undo… · Unskip, and the ⋯ menu; a click (or Enter) opens the term's detail
 *   keys    Enter opens the term · Space ticks · H opens Harvest to… for the row
 *
 * The page's tiles (Ready · Waiting for you · Harvested · 30 d · Worse) are this view's totals (`onTotals`, after each
 * read) and filter it (`show`): the filter counts the way the server counts, so a tile's number is the rows it shows.
 * "Harvest" and "Harvest to…" open the HARVEST-TO window (lane HTO, `keyword-harvest/harvest-to`).
 *
 * The page never writes to Amazon directly: a harvest, an approve and an undo are approval requests (approved by the
 * person on the page, in the same click, where they may); skip and unskip are Nexus settings.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, Clock, Copy, CornerDownRight, Download, Eye, EyeOff, MoreHorizontal, Search, SlidersHorizontal, Sprout, Undo2, X } from 'lucide-react'
import { Button, Input } from '@/design-system/primitives'
import { Banner, Menu, useNarrow, useToast, type MenuItemDef } from '@/design-system/components'
import { GridToolbar, PreferencesModal, type PreferencesValue } from '@/design-system/patterns'
import {
  AG_SELECTION_COL, GRID_PAGE_SIZES, cellOf, columnStateToPrefs, displayedRowIds, gridCsvRows, gridCsvSourceFromApi, gridSelection,
  downloadCsv, exportGridCsv, GridCard, GridLoadingOverlay, GridNoRowsOverlay, GridPager, GridSearchSlot, GridSelectionActions, GridViewsMenu,
  NexusGrid, prefsToColumnState, revealRow, SelectionLabel, useGridState,
  type GridApi, type GridReadyEvent, type GridStateKey, type NexusGridProps, type PrefsBridgeOptions, type RecordNavGridApi,
} from '@/design-system/grid'
import { usePermission } from '@/lib/auth/AuthProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { useRouter, useSearchParams } from '@/lib/workspaces/navigation'
import { useDetailParam } from '../../../_shared/useDetailParam'
import { useAdsMarketplace } from '../../../_shell/MarketplaceContext'
import { FILTER_EMPTY } from '../../_shared/scopeFilter/scopeFilterModel'
import type { ScopeView } from '../../_shared/scopeFilter/useScopeFilter'
import { readCandidates } from '../_shared/harvestApi'
import type { CandidateQuery, CandidateTotals, HarvestCandidateRow, HarvestToMode, HarvestToSource, SkipDays } from '../_shared/types'
import { HarvestToWindow } from '../harvest-to'
import { TERM_COLUMN_SPECS, termColumns, type TermsCellContext, type TermsCellHandlers } from './termsColumns'
import {
  bulkHeld, bulkSplit, copyText, countWords, emptyWords, harvestToHeld, isTermsList, listStates, plural, productsOf,
  showMatches, decideButtonWords, harvestedInWindow, harvestSourceOf, requestIds, waitingDecision, type TermsList, type TermsShow, type TermTab,
} from './termsModel'
import { ReviewDialogs } from './ReviewDialogs'
import { TermDetail } from './TermDetail'
import { useTermsRead } from './useTermsRead'
import { useTermsReview, type TermsTask } from './useTermsReview'
import styles from './terms.module.css'

export interface TermsViewProps {
  /** A market code, or 'all'. */
  market: string
  /** A tile's filter (the page's `?show=`). */
  show?: TermsShow | null
  /** Called after each read with the view's totals (counted over the scope, not the tile): the page's tiles. */
  onTotals?: (totals: CandidateTotals) => void
  /** The page's [Terms | Rules | Sources] switch, drawn at the start of this view's toolbar. */
  viewSwitch?: ReactNode
  /** The page's filter bar: the terms are read with its lists (the server filters, the tiles' totals too). */
  scope?: ScopeView
}

/* ── stable grid options (GDS decision 12) ───────────────────────────────────────────────── */

const ROW_ID: NonNullable<NexusGridProps<HarvestCandidateRow>['getRowId']> = (p) => p.data.id
const ROW_CLASS = styles.clickRow
const LOADING_PARAMS = { rows: 8 }
const PAGER_FROM = GRID_PAGE_SIZES[0]
const PERSIST_KEYS: readonly GridStateKey[] = ['columnSizing', 'columnOrder', 'columnVisibility', 'columnPinning', 'sort']
const NO_CHOICES: number[] = []
const NO_SORT_OPTIONS: Array<{ value: string; label: string }> = []
const NO_PAGE_STATE = (): Record<string, never> => ({})
const IGNORE_PAGE_STATE = () => {}
const SELECTION = gridSelection<HarvestCandidateRow>({ selectAll: 'currentPage' }) as NexusGridProps<HarvestCandidateRow>['rowSelection']
const SELECTION_COL = { width: 43, maxWidth: 43, resizable: false }
/** The cells that answer Enter themselves (links, verbs): Enter there never opens the detail. */
const OWN_KEY_COLUMNS = new Set(['actions', 'goesTo', 'product'])
const SEARCH_DELAY = 250

/** "**48** terms", "**3** of 48": the number bold, like the Rules view's count. */
function CountWords({ shown, total, filtered }: { shown: number; total: number; filtered: boolean }) {
  const words = countWords(shown, total, filtered)
  const [first, ...rest] = words.split(' ')
  return <><b>{first}</b> {rest.join(' ')}</>
}

/** The selection: ticked rows, or every term that matches ("Select all N"). */
type Picked = { kind: 'rows'; ids: string[] } | { kind: 'all'; ids: string[]; total: number }

export function TermsView({ market, show = null, onTotals, viewSwitch, scope }: TermsViewProps) {
  const canManage = usePermission('ads.campaigns.manage')
  const manageHeld = canManage ? null : 'Needs the permission to manage campaigns'
  const phone = useNarrow()
  const { toast } = useToast()
  const { writeAccess } = useAdsMarketplace()
  /** A change that reaches Amazon is off on a market Nexus only reads (ads wave 4c), with its reason. */
  const writeHeld = useCallback((row: Pick<HarvestCandidateRow, 'market'>) => { const a = writeAccess(row.market); return a.canWrite ? null : a.reason ?? 'Nexus only reads this market' }, [writeAccess])
  const router = useRouter()
  const params = useSearchParams()

  // ── the address: ?list=skipped, ?q=, ?term=&tab= ──
  const list: TermsList = isTermsList(params.get('list')) ? (params.get('list') as TermsList) : 'open'
  const qParam = params.get('q') ?? ''
  const [search, setSearch] = useState(qParam)
  useEffect(() => { setSearch(qParam) }, [qParam])
  const patch = useCallback((p: Record<string, string | null>) => {
    const next = new URLSearchParams(window.location.search)
    for (const [k, v] of Object.entries(p)) { if (v == null || v === '') next.delete(k); else next.set(k, v) }
    const qs = next.toString()
    router.replace(qs ? `?${qs}` : '?', { scroll: false })
  }, [router])
  useEffect(() => {
    if (search === qParam) return
    const t = setTimeout(() => patch({ q: search.trim() || null }), SEARCH_DELAY)
    return () => clearTimeout(t)
  }, [search, qParam, patch])
  const detail = useDetailParam({ key: 'term', tabKey: 'tab' })

  // ── the read ──
  const lists = scope?.api ?? null
  const scopeKey = scope?.key ?? ''
  const query = useMemo<CandidateQuery>(() => ({ market: market || 'all', state: listStates(list), q: qParam.trim() || null, lists }), [market, list, qParam, scopeKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const read = useTermsRead(query)
  const answer = read.answer
  const [version, setVersion] = useState(0)
  const after = useCallback(async () => { await read.reload(); setVersion((n) => n + 1) }, [read])

  const onTotalsRef = useRef(onTotals)
  onTotalsRef.current = onTotals
  // The tiles' totals, with "Harvested" counted in the page's one window from the open list's rows (the server counts
  // 30 days); the skipped list keeps the count of the last open read.
  const harvestedRef = useRef<number | undefined>(undefined)
  useEffect(() => { harvestedRef.current = undefined }, [market, scopeKey])
  useEffect(() => {
    if (!answer) return
    if (list === 'open') harvestedRef.current = harvestedInWindow(answer.rows)
    onTotalsRef.current?.({ ...answer.totals, harvestedWindow: harvestedRef.current })
  }, [answer, list])

  const all = useMemo(() => answer?.rows ?? [], [answer])
  const byId = useMemo(() => new Map(all.map((r) => [r.id, r])), [all])
  const shown = useMemo(() => all.filter((r) => showMatches(r, list === 'open' ? show : null)), [all, show, list])
  const failed = !!read.err && !answer
  const loading = !answer && !read.err

  // ── grid ──
  const apiRef = useRef<GridApi<HarvestCandidateRow> | null>(null)
  const [order, setOrder] = useState<string[]>([])
  const [pager, setPager] = useState({ page: 1, pageCount: 1 })
  const [pageSize, setPageSize] = useState<number>(PAGER_FROM)
  const [picked, setPicked] = useState<Picked>({ kind: 'rows', ids: [] })
  const [pageTicked, setPageTicked] = useState(false)

  const handlers = useRef<TermsCellHandlers>({} as TermsCellHandlers)
  const cellContext = handlers as TermsCellContext
  const columnDefs = useMemo(() => termColumns(phone, cellContext), [phone, cellContext])
  const bridge = useMemo<PrefsBridgeOptions>(() => ({ columns: TERM_COLUMN_SPECS.map((c) => ({ key: c.key, locked: c.locked })) }), [])
  // The locked Search term is listed but not counted (DS `uncounted`): the dialog's "N columns" and "In view · n of N"
  // then count the same columns — the DS counts a locked column in the first and not in the second (re-audit NICE).
  const preferenceSpecs = useMemo(() => TERM_COLUMN_SPECS.map((c) => ({ key: c.key, label: c.label, locked: c.locked, ...(c.locked ? { uncounted: true } : {}) })), [])
  const defaultPrefs = useMemo<PreferencesValue>(() => ({
    visibleColumns: TERM_COLUMN_SPECS.filter((c) => !c.hidden).map((c) => c.key),
    lockedColumns: [], stickyFirstColumn: true, stickyLastColumn: true, pageSize: 0, sortBy: '', sortDir: 'asc',
  }), [])
  const gridState = useGridState<Record<string, never>>({
    surface: 'ads-harvest-terms', baseUrl: getBackendUrl(), getPageState: NO_PAGE_STATE, applyPageState: IGNORE_PAGE_STATE, persistKeys: PERSIST_KEYS,
  })
  const bindState = useRef(gridState.bind)
  bindState.current = gridState.bind
  // A phone keeps no saved layout (its two columns are its own): the grid is drawn afresh when the width class changes.
  const phoneRef = useRef(phone)
  phoneRef.current = phone
  const onGridReady = useCallback((e: GridReadyEvent<HarvestCandidateRow>) => { apiRef.current = e.api; if (!phoneRef.current) bindState.current(e.api) }, [])
  const onPaginationChanged = useCallback((e: { api: GridApi<HarvestCandidateRow> }) => {
    setPager({ page: e.api.paginationGetCurrentPage() + 1, pageCount: Math.max(1, e.api.paginationGetTotalPages()) })
  }, [])
  const onPage = useCallback((n: number) => apiRef.current?.paginationGoToPage(n - 1), [])
  const onPageSize = useCallback((n: number) => { setPageSize(n); apiRef.current?.paginationGoToPage(0) }, [])
  const onModelUpdated = useCallback((e: { api: GridApi<HarvestCandidateRow> }) => {
    const ids = displayedRowIds(e.api as unknown as RecordNavGridApi)
    setOrder((cur) => (cur.length === ids.length && cur.every((id, i) => id === ids[i]) ? cur : ids))
  }, [])

  /** The ticked rows on the page on screen: all of them → offer "Select all N". */
  const pageIds = useCallback((): string[] => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return []
    const size = api.paginationGetPageSize()
    const start = api.paginationGetCurrentPage() * size
    const ids: string[] = []
    let i = 0
    api.forEachNodeAfterFilterAndSort((n) => { if (i >= start && i < start + size && n.data) ids.push(n.data.id); i++ })
    return ids
  }, [])
  const onSelectionChanged = useCallback<NonNullable<NexusGridProps<HarvestCandidateRow>['onSelectionChanged']>>((e) => {
    const ids = e.api.getSelectedRows().map((r) => r.id)
    setPicked((cur) => (cur.kind === 'all' && ids.length === cur.ids.filter((id) => byIdRef.current.has(id)).length ? cur : { kind: 'rows', ids }))
    const onPage = pageIds()
    setPageTicked(onPage.length > 0 && onPage.every((id) => ids.includes(id)))
  }, [pageIds])
  const byIdRef = useRef(byId)
  byIdRef.current = byId
  const clearSelection = useCallback(() => { apiRef.current?.deselectAll(); setPicked({ kind: 'rows', ids: [] }); setPageTicked(false) }, [])

  // A new market or list: nothing stays ticked.
  // A new market, list, search or tile (Back / Forward too): nothing stays ticked (release review Low).
  useEffect(() => { apiRef.current?.deselectAll(); setPicked({ kind: 'rows', ids: [] }); setPageTicked(false) }, [market, list, qParam, show, scopeKey])

  const selectedRows = useMemo(() => picked.ids.flatMap((id) => byId.get(id) ?? []), [picked, byId])
  const ticked = picked.ids.length
  const split = useMemo(() => bulkSplit(selectedRows), [selectedRows])
  /** What may be sent to Amazon (a market Nexus only reads holds its rows): harvest, approve, undo. */
  const sendable = useMemo(() => {
    const ok = (r: HarvestCandidateRow) => !writeHeld(r)
    return { harvest: split.harvest.filter(ok), harvestTo: split.harvestTo.filter(ok), decide: split.decide.filter(ok), approve: split.approve.filter(ok), undo: split.undo.filter(ok) }
  }, [split, writeHeld])
  const firstWriteHeld = (rows: readonly HarvestCandidateRow[]) => rows.map(writeHeld).find((w) => !!w) ?? null
  /**
   * "Select all N" acts on exactly the N it says (release review R7): the rows the table shows now — this read, its tile
   * and its search — all pages. Past the 5,000 the page reads, N is what it holds (the banner says the rest is not read).
   */
  const selectAllMatching = useCallback(() => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    const ids = displayedRowIds(api as unknown as RecordNavGridApi)
    const set = new Set(ids)
    const nodes: Parameters<GridApi<HarvestCandidateRow>['setNodesSelected']>[0]['nodes'] = []
    api.forEachNode((n) => { if (n.data && set.has(n.data.id)) nodes.push(n) })
    api.setNodesSelected({ nodes, newValue: true })
    setPicked({ kind: 'all', ids, total: ids.length })
  }, [])

  // ── reviews, the code, the HARVEST-TO window ──
  const { review, ask, save, close, undoSaved, stepUp, submitCode, cancelCode } = useTermsReview({
    after: async () => { clearSelection(); await after() },
  })
  const [harvestTo, setHarvestTo] = useState<{ source: HarvestToSource; mode: HarvestToMode; productId: string | null; opener: string | null } | null>(null)
  /** The window gets exactly the ticked rows it may harvest (R7: never a query that could reach other terms). */
  const openHarvestTo = useCallback((rows: HarvestCandidateRow[], mode: HarvestToMode) => {
    if (!rows.length) return
    const single = productsOf(rows) === 1 ? rows[0].product.id : null
    const source: HarvestToSource = harvestSourceOf(rows)
    setHarvestTo({ source, mode, productId: single, opener: rows.length === 1 ? rows[0].id : null })
  }, [])
  const askReview = useCallback((task: TermsTask) => ask(task), [ask])
  /**
   * Approve / Reject list EVERY write they decide (release review R4): when a request covers more terms than this read
   * holds (a search narrows it), its rows are read again without the search first.
   */
  const askDecision = useCallback(async (kind: 'approve' | 'reject', ticked: readonly HarvestCandidateRow[]) => {
    let pool: readonly HarvestCandidateRow[] = all
    const first = waitingDecision(kind, ticked, pool)
    const held = new Map<string, number>()
    for (const r of first.rows) held.set(r.waiting!.approvalId, (held.get(r.waiting!.approvalId) ?? 0) + 1)
    const short = first.rows.some((r) => (r.waiting?.terms ?? 0) > (held.get(r.waiting!.approvalId) ?? 0))
    if (short) {
      try {
        const wide = await readCandidates({ market: market || 'all', state: ['WAITING'], pageSize: 500 })
        const ids = new Set(pool.map((r) => r.id))
        pool = [...pool, ...wide.rows.filter((r) => !ids.has(r.id))]
      } catch (e) {
        toast(`Not every term of the request was read: ${e instanceof Error ? e.message : String(e)}`, 'danger')
        return
      }
    }
    ask({ kind, ...waitingDecision(kind, ticked, pool) })
  }, [all, market, ask, toast])
  /**
   * Where the focus goes when a review closes (audit S16). After a save the bulk bar that opened it is gone: the cell of
   * the first term it changed (or the first row's) takes it — unless the term's detail is open (it gets it back). A
   * cancelled review goes back to the control that opened it.
   */
  const reviewFocusRef = useRef<{ done: boolean; id: string | null }>({ done: false, id: null })
  // Kept while a review is open: the render that closes it must not wipe what its close reads.
  if (review) reviewFocusRef.current = { done: review.state.phase === 'done', id: review.focusId }
  const reviewFocus = useCallback((): HTMLElement | null => {
    const { done, id } = reviewFocusRef.current
    const api = apiRef.current
    if (!done || detailOpenRef.current || !api || api.isDestroyed()) return null
    const target = id && api.getRowNode(id) ? id : displayedRowIds(api as unknown as RecordNavGridApi)[0]
    return target ? cellOf(api as unknown as RecordNavGridApi, target, { colId: 'term' }) : null
  }, [])
  /** A waiting request can cover several terms: the review lists them all (every loaded row of the same request). */
  const requestRows = useCallback((rows: readonly HarvestCandidateRow[]) => {
    const ids = new Set(rows.map((r) => r.waiting?.approvalId).filter((x): x is string => !!x))
    return all.filter((r) => r.waiting && ids.has(r.waiting.approvalId))
  }, [all])

  const copyTerms = useCallback(async (rows: readonly HarvestCandidateRow[]) => {
    try {
      await navigator.clipboard.writeText(copyText(rows))
      toast(`${plural(rows.length, 'term')} copied`, 'success')
    } catch {
      toast('Not copied: the browser refused the clipboard', 'danger')
    }
  }, [toast])

  handlers.current = {
    open: (row) => detail.open(row.id, 'overview'),
    harvest: (row) => openHarvestTo([row], 'suggested'),
    harvestTo: (row) => openHarvestTo([row], 'choose'),
    decide: (row, kind) => void askDecision(kind, [row]),
    skip: (row, days) => askReview({ kind: 'skip', rows: [row], days }),
    unskip: (row) => askReview({ kind: 'unskip', rows: [row] }),
    undo: (row) => askReview({ kind: 'undo', rows: [row] }),
    copy: (row) => void copyTerms([row]),
    manageHeld,
    writeHeld,
  }

  // ── rows: click, keys ──
  const onRowClicked = useCallback<NonNullable<NexusGridProps<HarvestCandidateRow>['onRowClicked']>>((e) => {
    const target = (e.event?.target ?? null) as HTMLElement | null
    if (target?.closest?.('a, button, input, [role="dialog"], [role="menu"], .ag-selection-checkbox')) return
    if (e.data) detail.open(e.data.id, 'overview')
  }, [detail])
  const onCellKeyDown = useCallback<NonNullable<NexusGridProps<HarvestCandidateRow>['onCellKeyDown']>>((e) => {
    const key = e.event as KeyboardEvent | null | undefined
    if (!key || !e.data || key.altKey || key.ctrlKey || key.metaKey) return
    const target = key.target as HTMLElement | null
    if (target?.closest?.('a, button, input, [role="dialog"], [role="menu"]')) return
    const col = 'column' in e ? e.column.getColId() : null
    if (key.key === 'Enter') {
      if (col && (OWN_KEY_COLUMNS.has(col) || col === AG_SELECTION_COL)) return
      detail.open(e.data.id, 'overview')
    } else if ((key.key === 'h' || key.key === 'H') && !harvestToHeld(e.data) && !writeHeld(e.data) && canManage) {
      key.preventDefault()
      openHarvestTo([e.data], 'choose')
    }
  }, [detail, canManage, openHarvestTo, writeHeld])

  // ── the detail ──
  const openRow = detail.id ? byId.get(detail.id) ?? null : null
  const detailOpenRef = useRef(false)
  detailOpenRef.current = !!detail.id
  const openerCell = useCallback(() => {
    const api = apiRef.current
    if (!api || api.isDestroyed() || !detail.id) return null
    return cellOf(api as unknown as RecordNavGridApi, detail.id, { colId: 'term' })
  }, [detail.id])
  const goTo = useCallback((id: string) => {
    detail.go(id)
    const api = apiRef.current
    if (api && !api.isDestroyed()) revealRow(api as unknown as RecordNavGridApi, id, { focus: false, colId: 'term' })
  }, [detail])

  // ── Customise, Export ──
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
  const runExport = useCallback((only?: ReadonlySet<string>) => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    if (!only) {
      const out = exportGridCsv(api, 'keyword-harvest-terms', { narrowed: !!show || !!qParam })
      toast(`${plural(out.rows, 'term')} exported`, 'success')
      return
    }
    const source = gridCsvSourceFromApi(api)
    const out = gridCsvRows({ ...source, rows: source.rows.filter((r) => only.has(r.key)), narrowed: true }, 'keyword-harvest-terms-selected')
    downloadCsv(out.fileName, out.csv)
    toast(`${plural(out.rows, 'term')} exported`, 'success')
  }, [show, qParam, shown.length, toast])

  // ── words ──
  const filtered = !!show || !!qParam.trim()
  const countText = failed ? null : answer ? <CountWords shown={shown.length} total={all.length} filtered={filtered} /> : 'Reading…'
  const scopeActive = !!scope?.active
  const clearScope = scope?.clear
  const noRowsParams = useMemo(() => {
    if (failed) return { title: 'Terms not read', message: read.err ?? '', action: { label: 'Try again', onClick: () => void read.reload() } }
    // The page's filter bar left no term to read: say so, and clear it.
    if (!all.length && list === 'open' && !qParam.trim() && scopeActive && clearScope) return { title: FILTER_EMPTY.title, message: '', action: { label: FILTER_EMPTY.clear, onClick: () => clearScope() } }
    const words = emptyWords({ show: list === 'open' ? show : null, list, search: qParam, any: all.length > 0 })
    // One write of the address (audit M2: two replaces in one tick lost the first).
    const clear = () => { setSearch(''); patch({ q: null, list: null, show: null }) }
    return { title: words.title, message: '', action: words.clear ? { label: 'Clear filters', onClick: clear } : undefined }
  }, [failed, read, show, list, qParam, all.length, patch, scopeActive, clearScope])

  const skippedCount = answer?.totals.skipped ?? 0
  // "N out of date" (beside Waiting for you) filters too: a toolbar button like Skipped, in the address (?show=stale).
  const staleCount = answer?.totals.waitingStale ?? 0
  const staleButton = staleCount > 0 || show === 'stale' ? (
    <Button size="sm" variant="secondary" aria-pressed={show === 'stale'} onClick={() => { clearSelection(); patch({ show: show === 'stale' ? null : 'stale', list: null, term: null, tab: null }) }}>
      <Clock size={14} aria-hidden /> Out of date {staleCount}
    </Button>
  ) : undefined
  // Skipped: a toolbar button at the right, like the Rules view's Archived (audit S18); hidden while nothing is skipped.
  // One write of the address (audit M2).
  const skippedButton = skippedCount > 0 || list === 'skipped' ? (
    <Button size="sm" variant="secondary" aria-pressed={list === 'skipped'} onClick={() => { clearSelection(); patch({ list: list === 'skipped' ? null : 'skipped', show: null, term: null, tab: null }) }}>
      <EyeOff size={14} aria-hidden /> Skipped {skippedCount}
    </Button>
  ) : undefined
  // Bulk Approve leaves out the requests the server would refuse now (stale rule asks) and says how many.
  const staleLeftOut = requestIds(split.decide.filter((r) => r.waiting?.stale)).length
  const approveBase = decideButtonWords('approve', requestRows(sendable.approve))
  const approveWords = staleLeftOut ? { ...approveBase, long: `${approveBase.long} · ${staleLeftOut} left out: cannot be approved now` } : approveBase
  const rejectWords = decideButtonWords('reject', requestRows(split.decide))
  const bulk = !phone && ticked > 0
  const pagerShown = !!answer && !failed && shown.length > PAGER_FROM
  const allCount = shown.length
  const offerAll = bulk && picked.kind === 'rows' && pageTicked && allCount > ticked

  const skipMenu: MenuItemDef[] = ([7, 30, null] as SkipDays[]).map((days) => {
    const why = manageHeld ?? bulkHeld('skip', split.skip.length, ticked)
    const label = `${days == null ? 'For good' : `${days} d`}${split.skip.length ? ` · ${split.skip.length}` : ''}`
    return why ? { id: `skip${days ?? 'x'}`, label, disabled: true, description: why } : { id: `skip${days ?? 'x'}`, label, onSelect: () => askReview({ kind: 'skip', rows: split.skip, days }) }
  })
  const moreMenu: MenuItemDef[] = [
    { id: 'export', label: `Export selected · ${ticked}`, icon: <Download size={14} aria-hidden />, onSelect: () => runExport(new Set(picked.ids)) },
    { id: 'copy', label: `Copy terms · ${ticked}`, icon: <Copy size={14} aria-hidden />, onSelect: () => void copyTerms(selectedRows) },
  ]
  const harvestWhy = manageHeld ?? bulkHeld('harvest', split.harvest.length, ticked) ?? (sendable.harvest.length ? null : firstWriteHeld(split.harvest))
  const harvestToWhy = manageHeld ?? bulkHeld('harvestTo', split.harvestTo.length, ticked) ?? (sendable.harvestTo.length ? null : firstWriteHeld(split.harvestTo))
    ?? (productsOf(sendable.harvestTo) > 1 ? 'Pick terms of one product: one place takes one product\'s terms' : null)
  const approveWhy = manageHeld ?? bulkHeld('approve', split.approve.length, ticked) ?? (sendable.approve.length ? null : firstWriteHeld(split.approve))
  const undoWhy = manageHeld ?? (sendable.undo.length ? null : firstWriteHeld(split.undo))

  const selectionCount = (
    <span className={styles.inline}>
      {viewSwitch}
      {/* The select-all rule of the page (Terms and Sources, re-audit S1): the header box ticks the page, as on /products;
          once the whole page is ticked and more rows match, ONE link "Select all N"; then "All N selected". */}
      <span className={styles.count}>{picked.kind === 'all' ? <>All <b>{picked.total.toLocaleString('en-IE')}</b> selected</> : <>Selected <b>{ticked}</b> {ticked === 1 ? 'term' : 'terms'}</>}</span>
      {offerAll && <Button size="sm" variant="link" onClick={selectAllMatching}>Select all {allCount.toLocaleString('en-IE')}</Button>}
    </span>
  )

  return (
    <div className={styles.stack}>
      {read.err && answer && (
        <Banner tone="danger" title="Terms not read" action={<Button size="sm" variant="secondary" onClick={() => void read.reload()}>Try again</Button>}>{read.err}</Banner>
      )}

      <GridCard
        toolbar={bulk ? (
          <GridToolbar count={selectionCount}>
            <GridSelectionActions>
              <Button size="sm" variant="primary" heldReason={harvestWhy} title={harvestWhy ? undefined : 'Harvest: each term to its suggested place'} aria-label={sendable.harvest.length ? `Harvest ${sendable.harvest.length}` : 'Harvest'} onClick={() => openHarvestTo(sendable.harvest, 'suggested')}>
                <Sprout size={14} aria-hidden /> <SelectionLabel>Harvest{sendable.harvest.length ? ` ${sendable.harvest.length}` : ''}</SelectionLabel>
              </Button>
              <Button size="sm" variant="secondary" heldReason={harvestToWhy} title={harvestToWhy ? undefined : 'Harvest to one place (H on a row)'} aria-label={`Harvest ${sendable.harvestTo.length} to…`} onClick={() => openHarvestTo(sendable.harvestTo, 'choose')}>
                <CornerDownRight size={14} aria-hidden /> <SelectionLabel>Harvest to…</SelectionLabel>
              </Button>
              {split.decide.length > 0 && (
                <>
                  <Button size="sm" variant="secondary" heldReason={approveWhy} title={approveWhy ? undefined : approveWords.long} aria-label={approveWords.long} onClick={() => void askDecision('approve', sendable.decide)}>
                    <Check size={14} aria-hidden /> <SelectionLabel>{approveWords.label}</SelectionLabel>
                  </Button>
                  <Button size="sm" variant="secondary" heldReason={manageHeld} title={manageHeld ? undefined : rejectWords.long} aria-label={rejectWords.long} onClick={() => void askDecision('reject', split.decide)}>
                    <X size={14} aria-hidden /> <SelectionLabel>{rejectWords.label}</SelectionLabel>
                  </Button>
                </>
              )}
              {list === 'open' && <Menu label={<span className={styles.inline}><EyeOff size={14} aria-hidden /><SelectionLabel>Skip…</SelectionLabel></span>} items={skipMenu} triggerProps={{ className: 'nds-btn sm', 'aria-label': 'Skip the ticked terms', title: 'Skip' }} />}
              {(split.unskip.length > 0 || list === 'skipped') && (
                <Button size="sm" variant="secondary" heldReason={manageHeld ?? bulkHeld('unskip', split.unskip.length, ticked)} title={manageHeld ?? bulkHeld('unskip', split.unskip.length, ticked) ? undefined : 'Unskip'} aria-label={`Unskip ${split.unskip.length}`} onClick={() => askReview({ kind: 'unskip', rows: split.unskip })}>
                  <Eye size={14} aria-hidden /> <SelectionLabel>Unskip {split.unskip.length}</SelectionLabel>
                </Button>
              )}
              {split.undo.length > 0 && (
                <Button size="sm" variant="secondary" heldReason={undoWhy} title={undoWhy ? undefined : 'Undo the harvests'} aria-label={`Undo ${sendable.undo.length} harvests`} onClick={() => askReview({ kind: 'undo', rows: sendable.undo })}>
                  <Undo2 size={14} aria-hidden /> <SelectionLabel>Undo {sendable.undo.length}…</SelectionLabel>
                </Button>
              )}
              <Menu label={<MoreHorizontal size={15} aria-hidden />} items={moreMenu} align="right" triggerProps={{ className: 'nds-btn sm', 'aria-label': 'More for the ticked terms' }} />
              <Button size="sm" variant="link" onClick={clearSelection}>Clear</Button>
            </GridSelectionActions>
          </GridToolbar>
        ) : (
          <GridToolbar
            count={<span className={styles.inline}>{viewSwitch}{countText && <span className={styles.count} aria-live="polite">{countText}</span>}</span>}
            right={!phone ? (
              <span className={styles.toolbarRight}>
                {staleButton}
                {skippedButton}
                <GridViewsMenu views={gridState} />
                <Button size="sm" variant="secondary" onClick={openCustomise}><SlidersHorizontal size={14} aria-hidden /> Customise</Button>
                <Button size="sm" variant="secondary" heldReason={shown.length ? null : 'Nothing to export'} onClick={() => runExport()}><Download size={14} aria-hidden /> Export</Button>
              </span>
            ) : <span className={styles.toolbarRight}>{staleButton}{skippedButton}</span>}
          >
            <GridSearchSlot>
              <Input
                size="sm"
                type="search"
                aria-label="Search terms"
                placeholder="Search terms"
                leadingIcon={<Search size={14} aria-hidden />}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </GridSearchSlot>
          </GridToolbar>
        )}
        footer={pagerShown ? <GridPager page={pager.page} pageCount={pager.pageCount} pageSize={pageSize} onPage={onPage} onPageSize={onPageSize} /> : undefined}
      >
        <NexusGrid<HarvestCandidateRow>
          key={phone ? 'phone' : 'desk'}
          domLayout="autoHeight"
          suppressCellFocus={false}
          rowData={failed ? [] : shown}
          getRowId={ROW_ID}
          rowClass={ROW_CLASS}
          columnDefs={columnDefs}
          rowSelection={phone ? undefined : SELECTION}
          selectionColumnDef={SELECTION_COL}
          initialState={phone ? undefined : gridState.initialState}
          columnDialog={columnDialog}
          context={cellContext}
          loading={loading || (read.reading && failed)}
          loadingOverlayComponent={GridLoadingOverlay}
          loadingOverlayComponentParams={LOADING_PARAMS}
          noRowsOverlayComponent={GridNoRowsOverlay}
          noRowsOverlayComponentParams={noRowsParams}
          pagination
          paginationPageSize={pageSize}
          paginationPageSizeSelector={false}
          suppressPaginationPanel
          onGridReady={onGridReady}
          onPaginationChanged={onPaginationChanged}
          onRowClicked={onRowClicked}
          onCellKeyDown={onCellKeyDown}
          onModelUpdated={onModelUpdated}
          onSelectionChanged={onSelectionChanged}
        />
      </GridCard>

      {answer?.truncated && (
        <Banner tone="warning" title={`Showing the first ${all.length.toLocaleString('en-IE')} of ${answer.total.toLocaleString('en-IE')} terms`}>
          Pick a market or search to see the rest.
        </Banner>
      )}

      {detail.id && (
        <TermDetail
          row={openRow}
          missing={!!answer && !openRow}
          loading={!answer && !read.err}
          onRetry={() => void read.reload()}
          tab={detail.tab}
          onTab={(t: TermTab) => detail.setTab(t)}
          nav={openRow && order.includes(openRow.id) ? { ids: order, current: openRow.id, onGo: goTo, noun: 'term' } : undefined}
          onClose={detail.close}
          returnFocusTo={openerCell}
          manageHeld={manageHeld}
          writeHeld={openRow ? writeHeld(openRow) : null}
          version={version}
          actions={{
            harvestTo: (row) => openHarvestTo([row], 'choose'),
            decide: (row, kind) => void askDecision(kind, [row]),
            skip: (row, days) => askReview({ kind: 'skip', rows: [row], days }),
            unskip: (row) => askReview({ kind: 'unskip', rows: [row] }),
            undo: (row) => askReview({ kind: 'undo', rows: [row] }),
          }}
        />
      )}

      <ReviewDialogs review={review} save={save} close={close} undoSaved={undoSaved} stepUp={stepUp} submitCode={submitCode} cancelCode={cancelCode} returnFocusTo={reviewFocus} />

      {harvestTo && (
        <HarvestToWindow
          open
          source={harvestTo.source}
          mode={harvestTo.mode}
          market={market}
          productId={harvestTo.productId}
          returnFocusTo={() => {
            const api = apiRef.current
            if (detail.id || !harvestTo.opener || !api || api.isDestroyed()) return null
            return cellOf(api as unknown as RecordNavGridApi, harvestTo.opener, { colId: 'term' })
          }}
          onClose={() => setHarvestTo(null)}
          onDone={() => { clearSelection(); void after() }}
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

