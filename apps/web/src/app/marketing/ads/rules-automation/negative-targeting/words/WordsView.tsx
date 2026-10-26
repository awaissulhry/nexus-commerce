'use client'

/**
 * Negative Targeting page, Words view (step 4, 2026-10-25) — ONE NexusGrid card built like the Wasting view
 * (waste/WasteView): a word that wastes across shoppers' search terms ("cheap": 23 terms, €41, 0 orders), blocked as a
 * negative phrase where its terms spent.
 *
 * The redesign (2026-10-26, BRIEF D1, D4–D8, D14, D16):
 *   toolbar   [Wasting | Stopped | Words | Rules] · "5 words" · Search                 density · Customise · Views · status
 *   filter    the page's filter bar (Portfolio · Campaign · Ad group · Product · Show): every read sends its lists — the
 *             rows, "Select all N", Prev / Next, Export and Block word (the places the person saw). Show is the bar's
 *             (`showInBar`); the view hands it its choices with their counts (`onShowOptions`)
 *   ticked    the bulk actions take the search box's place: "3 ticked" · "Select all M" · Block word N · ⋯ (whole
 *             campaign, Export selected, Copy words) · Clear; the density toggle steps aside
 *   grid      two-line rows, server pages (`?page=`, `?sort=`), checkboxes, its own saved layout and density; a row
 *             (click or Enter) opens the word; a count that names a set opens that set in the word's record
 *   footer    the pager, always ("1–5 of 5"); under the card the server's own rule for a word
 *   export    the page header's Export ▾ (This view as CSV · Ticked rows as CSV): this view hands its items up
 *   phone     the same columns scrolling sideways in the card, no ticks, no density / Customise / Views; the search on its
 *             own line; a tap opens the full-screen sheet
 *
 * Block word goes through the page's review (`useWasteReview`): the server's preview lists one negative phrase per place,
 * each left out with why where it may not land; Done with Undo inside the review.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, CircleCheck, MoreHorizontal, SearchX, SlidersHorizontal } from 'lucide-react'
import { Button, Pill } from '@/design-system/primitives'
import { Banner, EmptyState, Listbox, Menu, useNarrow, useToast, type MenuItemDef } from '@/design-system/components'
import { GridToolbar, PreferencesModal, ReviewChangesModal, StepUpModal, type PreferencesValue } from '@/design-system/patterns'
import {
  AG_SELECTION_COL, cellOf, columnStateToPrefs, csvFileName, DEFAULT_GRID_DENSITY, downloadCsv, GRID_DENSITIES, gridSelection, GridCard, GridDensityProvider,
  GridDensityToggle, GridLoadingOverlay, GridPager, GridSearchSlot, GridSelectionActions, GridViewsMenu, NexusGrid, prefsToColumnState, toCsv, useGridState,
  type GridApi, type GridDensityName, type GridReadyEvent, type GridStateKey, type NexusGridProps, type PrefsBridgeOptions,
} from '@/design-system/grid'
import { getBackendUrl } from '@/lib/backend-url'
import { detailSearch, useDetailParam } from '../../../_shared/useDetailParam'
import { FILTER_EMPTY } from '../../_shared/scopeFilter/scopeFilterModel'
import type { ScopeView } from '../../_shared/scopeFilter/useScopeFilter'
import { gridStartState } from '../waste/gridStart'
import { useWasteReview, type WasteAsk } from '../waste/useWasteReview'
import { SearchBox } from '../waste/WasteView'
import { DEFAULT_PAGE_SIZE, PAGE_SIZES, pagerWords, plural, tickedCount, writeHeld, type CountPart, type Picked } from '../waste/wasteModel'
import type { WasteCriteria, Where } from '../waste/wasteTypes'
import { WORD_COLUMN_SPECS, WORD_OWN_KEY_COLUMNS, wordColumns, type WordCellContext, type WordCellHandlers, type WordGridRow } from './wordColumns'
import { WordDetail } from './WordDetail'
import { readAllWords, readWordIds, readWords } from './wordsApi'
import {
  WORD_CSV_HEADERS, wordCsvRow, wordOfId, wordsBulkCounts, wordsBulkPlan, wordsCount, wordShowChips, wordShowOf, wordShowOptions, wordsEmpty, wordSortOf, wordSortParam,
  wordTabOf, type WordsQuery, type WordTab,
} from './wordsModel'
import type { WordRow, WordTotals } from './wordsTypes'
import styles from '../negatives.module.css'

export interface WordsViewProps {
  market: string | null
  viewSwitch: ReactNode
  /** `?show=` as the address holds it (wasting · blocked · all). */
  show: string | null
  q: string
  scope?: ScopeView
  sort: string | null
  page: number
  pageSize: number
  canWrite: boolean
  setQuery(patch: Record<string, string | null>): void
  /** After a write: the page's other numbers are read again. */
  onWrote(): void
  /** Bumped by the page when another view wrote: read again. */
  refreshKey: number
  /** The redesign (2026-10-26, D4): the view's Show picks with their counts, for the page's filter bar. */
  onShowOptions?: (options: Array<{ value: string; label: string; count?: number }>) => void
  /** The redesign (D4): the page's filter bar draws Show; the view's toolbar does not. */
  showInBar?: boolean
  /** The redesign (D2): the view's items for the page header's Export ▾; null when none. */
  onExportItems?: (items: MenuItemDef[] | null) => void
}

const ROW_ID: NonNullable<NexusGridProps<WordGridRow>['getRowId']> = (p) => p.data.id
/** The skeleton draws the rows' own height (two lines) at the grid's density. */
const LOADING_PARAMS = { rows: 8, rowKind: 'two-line' as const }
const PERSIST_KEYS: readonly GridStateKey[] = ['columnSizing', 'columnOrder', 'columnVisibility', 'columnPinning']
const NO_CHOICES: number[] = []
const NO_SORT_OPTIONS: Array<{ value: string; label: string }> = []
const SELECTION = gridSelection<WordGridRow>({ selectAll: 'currentPage' }) as NexusGridProps<WordGridRow>['rowSelection']
const PAGE = '/marketing/ads/rules-automation/negative-targeting'
/** The word's record in the address: `?word=<id>&tab=`. */
const WORD_KEYS = { key: 'word', tabKey: 'tab' }
/** What the grid's remembered state keeps beside AG's own: the density (D5). */
interface PageState { density?: GridDensityName }
const isDensity = (v: unknown): v is GridDensityName => (GRID_DENSITIES as readonly unknown[]).includes(v)

interface Read { rows: WordGridRow[]; total: number; totals: WordTotals; criteria: WasteCriteria | null }

/** A count in the DS toolbar's form: the numbers bold ("<b>5</b> words"). */
function CountWords({ parts }: { parts: readonly CountPart[] }) {
  return <>{parts.map((p, i) => <span key={i}>{i > 0 ? ' · ' : null}<b>{p.n}</b>{p.words}</span>)}</>
}

export function WordsView(props: WordsViewProps) {
  const { market, viewSwitch, q, scope, sort, page, pageSize, canWrite, setQuery, onWrote, refreshKey, showInBar = false, onShowOptions, onExportItems } = props
  const show = wordShowOf(props.show)
  const phone = useNarrow()
  const { toast } = useToast()
  const scopeKey = scope?.key ?? ''
  const lists = scope?.api ?? null
  const query: WordsQuery = useMemo(() => ({ market, lists, show, q, sort, page, pageSize }), [market, scopeKey, show, q, sort, page, pageSize]) // eslint-disable-line react-hooks/exhaustive-deps
  const queryKey = JSON.stringify(query)

  /* ── the read ── */
  const [read, setRead] = useState<Read | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [reading, setReading] = useState(true)
  const [again, setAgain] = useState(0)
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const ctl = new AbortController()
    setReading(true)
    readWords(query, ctl.signal)
      .then((a) => { if (!ctl.signal.aborted) { setRead({ rows: a.rows, total: a.total, totals: a.totals, criteria: a.criteria ?? null }); setErr(null); setReading(false) } })
      .catch((e) => { if (!ctl.signal.aborted) { setErr(e instanceof Error ? e.message : String(e)); setReading(false) } })
    return () => ctl.abort()
  }, [queryKey, again, version, refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps
  // A new market starts with nothing shown (never another market's words).
  useEffect(() => { setRead(null); setErr(null) }, [market])
  const reload = useCallback(() => { setErr(null); setAgain((n) => n + 1) }, [])
  const afterWrite = useCallback(async () => { setVersion((n) => n + 1); onWrote() }, [onWrote])

  const rows = read?.rows ?? []
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows])
  const failed = !!err && !read
  const loading = !read && !err
  const scopeActive = !!scope?.active
  const ownFiltered = !!q.trim() || show !== 'wasting'
  const filtered = ownFiltered || scopeActive
  const total = read?.total ?? 0

  // D4 — the page's filter bar draws Show: its choices with this read's counts, whenever they change.
  const onShowRef = useRef(onShowOptions)
  onShowRef.current = onShowOptions
  const totalsKey = JSON.stringify(read?.totals ?? null)
  useEffect(() => { onShowRef.current?.(wordShowOptions(read?.totals ?? null)) }, [totalsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ── the record: ?word=&tab= ── */
  const detail = useDetailParam(WORD_KEYS)
  const [navIds, setNavIds] = useState<string[] | null>(null)
  const detailOpen = !!detail.id
  useEffect(() => {
    if (!detailOpen) return
    let live = true
    readWordIds(query).then((a) => { if (live) setNavIds(a.ids) }).catch(() => { if (live) setNavIds(rows.map((r) => r.id)) })
    return () => { live = false }
  }, [detailOpen, queryKey, version]) // eslint-disable-line react-hooks/exhaustive-deps
  const apiRef = useRef<GridApi<WordGridRow> | null>(null)
  const openerId = useRef<string | null>(null)
  const openRecord = useCallback((id: string, tab: WordTab | null = null) => { openerId.current = id; detail.open(id, tab === 'overview' ? null : tab) }, [detail])
  const recordFocus = useCallback(() => {
    const api = apiRef.current
    const id = detail.id
    if (!api || api.isDestroyed() || !id) return null
    return cellOf(api, id, { colId: 'word' })
  }, [detail.id])

  /* ── selection: kept across pages; "select all M that match" reaches past the page ── */
  const [picked, setPicked] = useState<Map<string, Picked<WordRow>>>(new Map())
  const syncing = useRef(false)
  useEffect(() => { setPicked(new Map()) }, [market, q, show, scopeKey])
  const onSelectionChanged = useCallback<NonNullable<NexusGridProps<WordGridRow>['onSelectionChanged']>>((e) => {
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
    if (!api || api.isDestroyed() || !read || phone || !canWrite) return
    syncing.current = true
    try {
      const on: Array<NonNullable<ReturnType<GridApi<WordGridRow>['getRowNode']>>> = []
      const off: typeof on = []
      api.forEachNode((n) => { if (n.data) (picked.has(n.data.id) ? on : off).push(n) })
      if (on.length) api.setNodesSelected({ nodes: on, newValue: true })
      if (off.length) api.setNodesSelected({ nodes: off, newValue: false })
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
      const ids = (await readWordIds(query)).ids
      setPicked(new Map(ids.map((id) => [id, byId.get(id) ?? { id }])))
      const api = apiRef.current
      if (api && !api.isDestroyed()) { syncing.current = true; try { api.selectAll() } finally { syncing.current = false } }
      // The words of the other pages, read in full: the bulk counts (and what is left out) are then exact.
      if (ids.some((id) => !byId.has(id))) {
        void readAllWords({ ...query, page: undefined, pageSize: undefined }).then((full) => {
          const map = new Map(full.map((r) => [r.id, r]))
          setPicked((cur) => new Map([...cur].map(([id, p]) => [id, 'word' in p ? p : map.get(id) ?? p])))
        }).catch(() => {})
      }
    } catch (e) {
      toast(`Not selected: ${e instanceof Error ? e.message : String(e)}`, 'danger')
    } finally { setSelectingAll(false) }
  }, [query, byId, toast])
  const pickedList = useMemo(() => [...picked.values()], [picked])

  /* ── Block word: the page's review ── */
  const { review, stepUp, ask, save, submitCode, cancelCode, undoSaved, retry, close, size: reviewSize } = useWasteReview({ market, after: afterWrite })
  const reviewOpener = useRef<HTMLElement | null>(null)
  const reviewRow = useRef<{ id: string; index: number } | null>(null)
  const askBlock = useCallback((list: ReadonlyArray<Picked<WordRow>>, where: Where) => {
    const plan = wordsBulkPlan(list, where, lists)
    const texts = Object.fromEntries(list.map((p) => [p.id, 'word' in p ? p.word : wordOfId(p.id)]))
    reviewOpener.current = document.activeElement as HTMLElement | null
    const first = plan.items[0]?.rowId ?? list[0]?.id ?? null
    reviewRow.current = first ? { id: first, index: rows.findIndex((r) => r.id === first) } : null
    const a: WasteAsk = { kind: 'change', items: plan.items, left: plan.left, texts }
    ask(a)
  }, [ask, lists, rows])
  const reviewFocus = useCallback(() => {
    const api = apiRef.current
    if (api && !api.isDestroyed() && reviewRow.current) {
      const { id, index } = reviewRow.current
      const here = rows.some((r) => r.id === id) ? id : rows[Math.min(Math.max(index, 0), rows.length - 1)]?.id
      const cell = here ? cellOf(api, here, { colId: 'word' }) : null
      if (cell) return cell
    }
    const el = reviewOpener.current
    return el && el.isConnected ? el : null
  }, [rows])
  const closeReview = useCallback(() => {
    if (review?.state.phase === 'done' && !detail.id) clearPicked()
    close()
  }, [review, detail.id, clearPicked, close])

  /* ── the grid ── */
  const handlers = useRef<WordCellHandlers>({ open: () => {}, block: () => {}, href: () => '#', noWrite: null })
  handlers.current = {
    open: (id, tab) => openRecord(id, tab),
    block: (id, campaign) => {
      const row = byId.get(id)
      if (row) askBlock([row], campaign ? 'campaign' : 'adGroup')
    },
    // The record's own address (the rest of the page's query kept), for a count link that opens it on a tab.
    href: (id, tab) => `${PAGE}?${detailSearch(typeof window === 'undefined' ? '' : window.location.search, WORD_KEYS, { id, tab: tab === 'overview' ? null : tab })}`,
    noWrite: writeHeld(canWrite),
  }
  // The rows' verbs are held for a person who may not change ads: drawn again when that is known.
  useEffect(() => { const api = apiRef.current; if (api && !api.isDestroyed()) api.refreshCells({ columns: ['actions'], force: true }) }, [canWrite])
  const cellContext = handlers as WordCellContext
  const columnDefs = useMemo(() => wordColumns(phone, cellContext) as NexusGridProps<WordGridRow>['columnDefs'], [phone]) // eslint-disable-line react-hooks/exhaustive-deps
  const bridge = useMemo<PrefsBridgeOptions>(() => ({ columns: WORD_COLUMN_SPECS.map((c) => ({ key: c.key, locked: c.locked })) }), [])
  const preferenceSpecs = useMemo(() => WORD_COLUMN_SPECS.map((c) => ({ key: c.key, label: c.label, locked: c.locked })), [])
  const defaultPrefs = useMemo<PreferencesValue>(() => ({
    visibleColumns: WORD_COLUMN_SPECS.filter((c) => !c.hidden).map((c) => c.key), lockedColumns: [], stickyFirstColumn: true, stickyLastColumn: false, pageSize: 0, sortBy: '', sortDir: 'asc',
  }), [])
  // D5 — the density (Compact · Cozy · Spacious) is remembered with its own saved layout (widths, order, columns), apart
  // from the Wasting and Stopped views', as on Listings.
  const [density, setDensity] = useState<GridDensityName>(DEFAULT_GRID_DENSITY)
  const densityRef = useRef(density)
  densityRef.current = density
  const gridState = useGridState<PageState>({
    surface: 'ads-neg-words', baseUrl: getBackendUrl(), persistKeys: PERSIST_KEYS, landOnLateDefault: true,
    getPageState: () => ({ density: densityRef.current }),
    applyPageState: (p) => { if (p && isDensity(p.density)) setDensity(p.density) },
  })
  const lastDensity = gridState.lastUsed?.page?.density
  useEffect(() => { if (isDensity(lastDensity)) setDensity(lastDensity) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const markDirty = gridState.markDirty
  const pickDensity = useCallback((d: GridDensityName) => { setDensity(d); markDirty() }, [markDirty])
  const bindState = useRef(gridState.bind)
  bindState.current = gridState.bind
  const sortNow = useRef(sort)
  sortNow.current = sort
  // One start for the page's tables (waste/gridStart.ts): its saved layout, else its default with the hidden columns
  // named. A phone draws the same columns (D16) but never takes the desktop's saved widths and order.
  const initialState = useMemo(() => gridStartState({
    saved: phone ? null : gridState.initialState, hidden: WORD_COLUMN_SPECS.filter((c) => c.hidden).map((c) => c.key), sort: wordSortOf(sort), phone: false,
  }), [gridState.initialState, phone]) // eslint-disable-line react-hooks/exhaustive-deps
  const bindPhone = useRef(phone)
  bindPhone.current = phone
  const onGridReady = useCallback((e: GridReadyEvent<WordGridRow>) => { apiRef.current = e.api; if (!bindPhone.current) bindState.current(e.api) }, [])
  const onSortChanged = useCallback<NonNullable<NexusGridProps<WordGridRow>['onSortChanged']>>((e) => {
    const col = e.api.getColumnState().find((c) => c.sort)
    const next = col ? wordSortParam({ colId: col.colId, dir: col.sort as 'asc' | 'desc' }) : null
    if ((next ?? null) !== (sortNow.current ?? null)) setQuery({ sort: next, page: null })
  }, [setQuery])
  const onRowClicked = useCallback<NonNullable<NexusGridProps<WordGridRow>['onRowClicked']>>((e) => {
    const target = (e.event?.target ?? null) as HTMLElement | null
    if (target?.closest?.('a, button, [role="dialog"], .ag-selection-checkbox, [role="img"][tabindex]')) return
    if (e.data) openRecord(e.data.id)
  }, [openRecord])
  const onCellKeyDown = useCallback<NonNullable<NexusGridProps<WordGridRow>['onCellKeyDown']>>((e) => {
    const key = e.event as KeyboardEvent | null | undefined
    if (key?.key !== 'Enter' || !e.data) return
    const target = key.target as HTMLElement | null
    if (target?.closest?.('a, button, input, [role="dialog"]')) return
    const col = 'column' in e ? e.column.getColId() : null
    if (col && (WORD_OWN_KEY_COLUMNS.has(col) || col.startsWith('ag-Grid'))) return
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
  const csvOf = useCallback((list: readonly WordRow[]) => toCsv(list as WordRow[], WORD_CSV_HEADERS.map((h, i) => ({ header: h, value: (r: WordRow) => wordCsvRow(r)[i] }))), [])
  const exportAll = useCallback(async () => {
    setExporting(true)
    try { downloadCsv(csvFileName('negative-targeting-words', { filtered }), csvOf(await readAllWords({ ...query, page: undefined, pageSize: undefined }))) }
    catch (e) { toast(`Not exported: ${e instanceof Error ? e.message : String(e)}`, 'danger') }
    finally { setExporting(false) }
  }, [query, filtered, csvOf, toast])
  /** The ticked words in full (one ticked through "select all" on another page is read). */
  const fullPicked = useCallback(async (): Promise<WordRow[]> => {
    if (pickedList.every((p) => 'word' in p)) return pickedList as WordRow[]
    const map = new Map((await readAllWords({ ...query, page: undefined, pageSize: undefined })).map((r) => [r.id, r]))
    return pickedList.flatMap((p) => ('word' in p ? [p] : map.get(p.id) ? [map.get(p.id)!] : []))
  }, [pickedList, query])
  const exportPicked = useCallback(async () => {
    try { downloadCsv(csvFileName('negative-targeting-words', { suffix: 'selected' }), csvOf(await fullPicked())) } catch (e) { toast(`Not exported: ${e instanceof Error ? e.message : String(e)}`, 'danger') }
  }, [csvOf, fullPicked, toast])
  const copyWords = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(pickedList.map((p) => ('word' in p ? p.word : wordOfId(p.id))).join('\n'))
      toast(`Copied ${plural(pickedList.length, 'word')}`, 'success')
    } catch (e) { toast(`Not copied: ${e instanceof Error ? e.message : String(e)}`, 'danger') }
  }, [pickedList, toast])

  /* ── the header's Export ▾ (D2): this view as CSV, the ticked words as CSV ── */
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

  /* ── ticked (D5): the bulk actions take the search box's place; every verb is secondary and counted ── */
  const held = writeHeld(canWrite)
  const counts = useMemo(() => wordsBulkCounts(pickedList), [pickedList])
  const bulkActions = (() => {
    if (!picked.size) return null
    const pageAll = rows.length > 0 && rows.every((r) => picked.has(r.id))
    const more: MenuItemDef[] = [
      { id: 'campaign', label: `Block word · whole campaign ${counts.campaign}`, disabled: !!held || !counts.campaign, description: held ?? (counts.campaign ? undefined : 'None of the ticked words may be blocked'), onSelect: () => askBlock(pickedList, 'campaign') },
      { id: 'sep', separator: true },
      { id: 'export', label: 'Export selected', onSelect: () => void exportPicked() },
      { id: 'copy', label: 'Copy words', onSelect: () => void copyWords() },
    ]
    return (
      <GridSelectionActions>
        {pageAll && total > picked.size && (
          <Button size="sm" variant="link" onClick={() => void selectAllMatching()} aria-busy={selectingAll || undefined}>{selectingAll ? 'Selecting…' : `Select all ${total}`}</Button>
        )}
        <Button size="sm" heldReason={held ?? (counts.adGroup ? null : 'None of the ticked words may be blocked: each says why')} onClick={() => askBlock(pickedList, 'adGroup')}>
          Block word {counts.adGroup}
        </Button>
        <Menu label={<MoreHorizontal size={15} aria-hidden />} items={more} align="right" triggerProps={{ className: 'nds-btn sm icon', 'aria-label': 'More bulk actions' }} />
        <Button size="sm" variant="link" onClick={clearPicked}>Clear</Button>
      </GridSelectionActions>
    )
  })()

  /* ── toolbar (D5): the view switch · the count · the search | density · Customise · Views · status ── */
  const countParts: CountPart[] | null = failed ? null : read ? (picked.size ? tickedCount(picked.size) : wordsCount(total)) : null
  const status = (
    <Pill tone={err ? 'danger' : 'success'} dot size="md">{err ? 'Not updating' : reading ? 'Updating…' : 'Up to date'}</Pill>
  )
  const search = (
    <GridSearchSlot>
      <SearchBox value={q} label="Search words" onCommit={(v) => setQuery({ q: v || null, page: null })} />
    </GridSearchSlot>
  )
  // Show is the page's filter bar's (D4, `showInBar`); until the page draws it there, the view keeps its own.
  const showControl = showInBar ? null : (
    <Listbox size="sm" width={phone ? '100%' : 164} ariaLabel="Show" value={show}
      options={wordShowChips(read?.totals ?? null).map((c) => ({ value: c.id, label: c.label, title: c.title, trailing: c.count != null ? <span className={styles.count}>{c.count}</span> : undefined }))}
      onChange={(v) => setQuery({ show: v === 'wasting' ? null : v, page: null })} />
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
          {phone && showControl}
        </>
      )}
    >
      {viewSwitch}
      {countParts ? <span className="cnt"><CountWords parts={countParts} /></span> : !read && !failed ? <span className="cnt">Reading…</span> : null}
      {bulkActions ?? (!phone && <>{search}{showControl}</>)}
    </GridToolbar>
  )

  /* ── states: empty and failed are a DS EmptyState in the grid; reading is its skeleton ── */
  const clearScope = scope?.clear
  const emptyState = useMemo(() => {
    if (failed) {
      return <EmptyState icon={<AlertCircle size={20} aria-hidden />} title="Words not read" description={err ?? undefined} action={<Button size="sm" onClick={reload}>Try again</Button>} />
    }
    // Only the page's filter bar narrows: say so, and clear it.
    if (scopeActive && clearScope && !ownFiltered) {
      return <EmptyState icon={<SearchX size={20} aria-hidden />} title={FILTER_EMPTY.title} action={<Button size="sm" onClick={() => clearScope()}>{FILTER_EMPTY.clear}</Button>} />
    }
    const w = wordsEmpty(show, filtered)
    // Clear filters clears the view's own and the filter bar's in ONE address change (two in one tick lose the first).
    const own = { q: null, show: null, page: null }
    return (
      <EmptyState icon={filtered ? <SearchX size={20} aria-hidden /> : <CircleCheck size={20} aria-hidden />} title={w.title}
        action={w.clear ? <Button size="sm" onClick={() => (scopeActive && clearScope ? clearScope(own) : setQuery(own))}>Clear filters</Button> : undefined} />
    )
  }, [failed, err, reload, show, filtered, ownFiltered, scopeActive, clearScope, setQuery])

  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  // D7 — the pager is always there once the words are read (never over a failed read or the first read).
  const pagerShown = !!read && !failed
  const openRow = detail.id ? byId.get(detail.id) ?? null : null
  const nav = detail.id && navIds?.includes(detail.id) ? { ids: navIds, current: detail.id, onGo: (id: string) => detail.go(id), noun: 'word' } : undefined
  // D8 — the server's own rule for a word and its test, in its words (nothing when the read did not say).
  const note = read?.criteria?.sentence?.trim() || null

  return (
    <div className={styles.stack}>
      {err && read && (
        <Banner tone="danger" title="Words not read" action={<Button size="sm" variant="secondary" onClick={reload}>Try again</Button>}>{err}</Banner>
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
            <NexusGrid<WordGridRow>
              key={phone ? 'phone' : 'desk'}
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
        <WordDetail
          id={detail.id}
          listRow={openRow}
          lists={lists}
          tab={wordTabOf(detail.tab)}
          onTab={(t) => detail.setTab(t === 'overview' ? null : t)}
          nav={nav}
          canWrite={canWrite}
          version={version}
          onBlock={(row, where) => askBlock([row], where)}
          onClose={detail.close}
          onUndo={(item) => ask({ kind: 'undo', item })}
          returnFocusTo={detail.id !== openerId.current ? recordFocus : undefined}
          criteria={read?.criteria ?? null}
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
          lead={review.lead}
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
        <StepUpModal open title="Your code" sentence="Your authenticator code approves it." busy={stepUp.busy} error={stepUp.error} confirmLabel={review.saveLabel}
          onSubmit={(code) => void submitCode(code)} onClose={cancelCode} />
      )}

      {prefsOpen && (
        <PreferencesModal open={prefsOpen} onClose={() => setPrefsOpen(false)} value={prefs} onConfirm={applyPrefs} allColumns={preferenceSpecs}
          defaultVisible={defaultPrefs.visibleColumns} pageSizeChoices={NO_CHOICES} sortFieldOptions={NO_SORT_OPTIONS} showSticky={false} title="Customise columns" />
      )}
    </div>
  )
}
