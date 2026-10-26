'use client'

/**
 * Reviews › Inbox (`/marketing/reviews/inbox`, build spec §3.2, PR B): one list for every product review and seller
 * feedback, on every channel and market. Its own PageHeader (ruling 1): the crumbs, "Inbox", "{n} reviews · {period}",
 * the period (7 / 30 / 90 days, All time; also a removable chip), "Import reviews…" and the "Reviews" menu button.
 *
 *   Tabs        All · Product reviews · Seller feedback, each with its count
 *   Tiles       New · In progress · Responded · Resolved · Ignored · Overdue (open > 48 h, the API's rule): a press
 *               filters, a second press clears; the filter shows as a chip
 *   Banners     a channel × market Nexus is not reading, with Reconnect when a person can fix it
 *   Filters     channel, market, stars, mood, theme, status, owner, product family ("Has photos": Coming later)
 *   The list    a grid card — search (300 ms) or, while rows are ticked, the bulk bar (Assign · Tag · Set status ·
 *               Draft with AI · Clear), density, Customise, Views, the live pill — newest first; a row (or Enter)
 *               opens the review pop-up. Below 760 px: cards with "Load 50 more" and long-press ticking.
 *
 * Everything the page shows is in the address (`inboxQuery.ts`); `?import=1` opens the Import window once and
 * `?review=<id>` opens a review. Live: a review arriving, turning negative or getting a reply (SSE), and any change made
 * in this or another tab (BroadcastChannel), read the list again in place — ticked rows, filters and the page stay.
 * Writes are never optimistic: the call, `emitInvalidation`, a re-read, then a toast with the server's count.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { AlertTriangle, ListChecks, Search, SlidersHorizontal, Sparkles, Tag as TagIcon, UserPlus } from 'lucide-react'
import {
  Banner, Card, EmptyState, Field, Listbox, MetricStrip, Modal, StarRating, Tabs, ToastProvider, useNarrow, useToast, type Metric,
} from '@/design-system/components'
import {
  GridCard, GridDensityProvider, GridDensityToggle, GridNoRowsOverlay, GridPager, GridSearchSlot, GridSelectionActions, GridToolbar,
  GridViewsMenu, LoadedRowsSelectionHeader, NexusGrid, SelectionLabel, columnStateToPrefs, gridGeometry, prefsToColumnState, useGridState,
  type GridApi, type GridReadyEvent, type GridState,
} from '@/design-system/grid'
import { BulkActionBar, FilterBar, PageHeader, PreferencesModal, type FilterDimension, type PreferencesValue } from '@/design-system/patterns'
import { Button, Input, Pill, SegmentedControl, TokenChip } from '@/design-system/primitives'
import { COUNTRY_NAMES } from '@/app/_shared/app-nav'
import { useAuth } from '@/lib/auth/AuthProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation, useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import Link from '@/lib/workspaces/Link'
import { usePathname } from '@/lib/workspaces/navigation'
import { reviewsGet, reviewsSend } from '../_lib/reviewsFetch'
import { useReviewEvents } from '../_lib/useReviewEvents'
import { MOOD_WORD, THEME_LABEL, themeWord } from '../_lib/reviewWords'
import { reviewsCrumbs } from '../_shell/reviews-crumbs'
import { ReviewsMenuButton } from '../_shell/ReviewsShell'
import {
  BULK_ACTIONS, BULK_LABEL, SETTABLE_STATUSES, TAG_MAX, bulkActionHeld, bulkApplyHeld, bulkApplyLabel, bulkBody, bulkReach,
  bulkResultWords, bulkSkipWords, ownerChoices, type BulkAction, type BulkRow,
} from './inboxBulk'
import { INBOX_COLUMN_DEFS, INBOX_COLUMN_SPECS, INBOX_DEFAULT_PREFS, INBOX_DEFAULT_VISIBLE, INBOX_PREFS_BRIDGE } from './inboxColumns'
import { createInboxDatasource, type InboxPage, type InboxRow } from './inboxDatasource'
import {
  EMPTY_INBOX_QUERY, INBOX_PAGE_SIZES, INBOX_PERIOD_CHOICES, INBOX_STATUSES, NO_OWNER, activeFilterCount, clearFilters, gridSortOf,
  inboxApiParams, isFiltered, litTile, parseInboxQuery, querySignature, serializeInboxQuery, sortFromGrid, toggleStatusTile, withFilter,
  withKind, withPage, withPeriod, withSearch, withSort, type InboxFilterKey, type InboxQuery, type InboxSort,
} from './inboxQuery'
import {
  TILE_ORDER, headerSubtitle, inboxChips, livePill, periodShort, readStateBanners, tabItems, tileAccent, tileHint,
  tileLabel, tileValue, valueWord,
} from './inboxTiles'
import { ImportModal } from './ImportModal'
import { InboxCards } from './InboxCards'
import { ReviewDetailModal } from './ReviewDetailModal'
import s from './inbox.module.css'

const MANAGE_IMPORT = "You need 'Manage reviews' to import reviews."
const SEARCH_MS = 300
const LIVE_MS = 600
const CARD_PAGE = 50

const PERIOD_OPTIONS = INBOX_PERIOD_CHOICES.map((p) => ({ value: p, label: periodShort(p) }))
const SORT_OPTIONS: { value: InboxSort; label: string }[] = [
  { value: 'postedAt:desc', label: 'Newest first' },
  { value: 'postedAt:asc', label: 'Oldest first' },
  { value: 'rating:asc', label: 'Fewest stars first' },
  { value: 'rating:desc', label: 'Most stars first' },
]
const CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY']
const BASE_MARKETS = ['IT', 'DE', 'FR', 'ES', 'UK', 'NL', 'BE', 'SE', 'PL', 'AT', 'IE']
const PERSIST_KEYS = ['columnSizing', 'columnOrder', 'columnVisibility'] as const
const BULK_ICON: Record<BulkAction, typeof UserPlus> = { assign: UserPlus, tag: TagIcon, status: ListChecks, draft: Sparkles }

type Density = ComponentProps<typeof GridDensityToggle>['value']
interface InboxViewState { density: Density; pageSize: number }

/** The ticked rows, as the grid has them now. */
function readTicked(api: GridApi<InboxRow>): InboxRow[] {
  const rows: InboxRow[] = []
  api.forEachNode((node) => { if (node.data && node.isSelected()) rows.push(node.data) })
  return rows
}

function InboxInner() {
  const pathname = usePathname() ?? '/marketing/reviews/inbox'
  const { status, has, user } = useAuth()
  // Until the session is known nothing is held: the API checks the permission on every write.
  const canManage = status !== 'authed' || has('reviews.manage')
  const me = user?.displayName || user?.email || null
  const { toast } = useToast()
  const narrow = useNarrow()

  // ── The address: read once on the client, written back on every change ──
  const [query, setQueryState] = useState<InboxQuery | null>(null)
  const [firstQuery, setFirstQuery] = useState<InboxQuery | null>(null)
  const [openReview, setOpenReview] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [searchDraft, setSearchDraft] = useState('')
  const initialPage = useRef<number | null>(null)
  useEffect(() => {
    const parsed = parseInboxQuery(window.location.search)
    initialPage.current = parsed.query.page > 1 ? parsed.query.page : null
    setQueryState(parsed.query)
    setFirstQuery(parsed.query)
    setSearchDraft(parsed.query.q)
    setOpenReview(parsed.review)
    setImportOpen(parsed.openImport)
  }, [])
  const setQuery = useCallback((update: (q: InboxQuery) => InboxQuery) => setQueryState((q) => update(q ?? EMPTY_INBOX_QUERY)), [])
  const queryRef = useRef<InboxQuery>(EMPTY_INBOX_QUERY)
  if (query) queryRef.current = query
  useEffect(() => {
    if (!query) return
    // `{}`, not `history.state`: Next's own state object makes the app router skip its apply. `?import=1` is left out.
    const next = `${window.location.pathname}${serializeInboxQuery(query, { review: openReview })}`
    if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState({}, '', next)
  }, [query, openReview])

  // The search reaches the query 300 ms after the last keystroke.
  useEffect(() => {
    if (!query || searchDraft.trim() === query.q) return
    const id = window.setTimeout(() => setQuery((q) => withSearch(q, searchDraft)), SEARCH_MS)
    return () => window.clearTimeout(id)
  }, [searchDraft, query, setQuery])

  // ── What the latest answer said ──
  const [top, setTop] = useState<InboxPage | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [updating, setUpdating] = useState(false)
  /** The rows of each page the grid read (one AG block = one API page): Prev / Next in the pop-up walk the page on screen. */
  const pageRows = useRef(new Map<number, InboxRow[]>())

  // ── The grid ──
  const [density, setDensity] = useState<Density>('cozy')
  const gridApiRef = useRef<GridApi<InboxRow> | null>(null)
  const [gridApi, setGridApi] = useState<GridApi<InboxRow> | null>(null)
  const [pager, setPager] = useState({ page: 1, pageCount: 1 })
  const gridViews = useGridState<InboxViewState>({
    surface: 'reviews-inbox',
    baseUrl: getBackendUrl(),
    persistKeys: PERSIST_KEYS,
    getPageState: () => ({ density, pageSize: queryRef.current.pageSize }),
    applyPageState: (page) => {
      if (!page) return
      if (page.density) setDensity(page.density)
      if ((INBOX_PAGE_SIZES as readonly number[]).includes(page.pageSize)) setQuery((q) => withPage(q, 1, page.pageSize))
    },
  })
  const markDirty = gridViews.markDirty
  useEffect(() => { markDirty() }, [markDirty, density, query?.pageSize])
  const initialState = useMemo<GridState | undefined>(() => {
    if (!firstQuery) return undefined
    return { ...(gridViews.initialState ?? {}), sort: { sortModel: [gridSortOf(firstQuery.sort)] } } as GridState
    // Read once, when the grid first mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstQuery])

  const datasource = useMemo(() => createInboxDatasource({
    getQuery: () => queryRef.current,
    onRequest: () => setUpdating(true),
    onPage: (page) => {
      pageRows.current.set(page.page, page.rows)
      setTop(page)
      setListError(null)
      setUpdating(false)
    },
    onError: (message) => {
      setListError(message)
      setUpdating(false)
    },
  }), [])

  // A change of what shows (not the page) reads from page 1 again; a header click is AG's own read (mirrored below).
  const signature = query ? querySignature(query) : ''
  const lastSignature = useRef<string | null>(null)
  useEffect(() => {
    if (!gridApi || !signature) return
    if (lastSignature.current === signature) return
    const first = lastSignature.current === null
    lastSignature.current = signature
    if (first || gridApi.isDestroyed()) return
    pageRows.current.clear()
    gridApi.paginationGoToPage(0)
    gridApi.refreshServerSide({ purge: true })
  }, [gridApi, signature])

  // ── Selection: the grid owns it (the cards their own), the page reads it ──
  const [ticked, setTicked] = useState<InboxRow[]>([])
  const onSelectionChanged = useCallback((e: { api: GridApi<InboxRow> }) => setTicked(readTicked(e.api)), [])
  const onStoreRefreshed = useCallback((e: { api: GridApi<InboxRow> }) => setTicked(readTicked(e.api)), [])
  const clearGridSelection = useCallback(() => {
    const api = gridApiRef.current
    if (api && !api.isDestroyed()) api.deselectAll()
  }, [])

  const bindViews = gridViews.bind
  const onGridReady = useCallback((e: GridReadyEvent<InboxRow>) => {
    gridApiRef.current = e.api
    setGridApi(e.api)
    bindViews(e.api)
  }, [bindViews])
  const onPaginationChanged = useCallback((e: { api: GridApi<InboxRow> }) => {
    const pageCount = Math.max(1, e.api.paginationGetTotalPages())
    const wanted = initialPage.current
    if (wanted && pageCount > 1) {
      initialPage.current = null
      if (wanted <= pageCount && wanted !== e.api.paginationGetCurrentPage() + 1) { e.api.paginationGoToPage(wanted - 1); return }
    }
    const page = e.api.paginationGetCurrentPage() + 1
    setPager({ page, pageCount })
    setQueryState((q) => (q && q.page !== page ? { ...q, page } : q))
  }, [])
  const onPage = useCallback((n: number) => gridApiRef.current?.paginationGoToPage(n - 1), [])
  const onPageSize = useCallback((n: number) => setQuery((q) => withPage(q, 1, n)), [setQuery])
  const onSortChanged = useCallback((e: { api: GridApi<InboxRow> }) => {
    const model = (e.api.getColumnState() ?? [])
      .filter((c) => c.sort)
      .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
      .map((c) => ({ colId: c.colId, sort: c.sort === 'asc' ? 'asc' as const : 'desc' as const }))
    // AG has already started the read with the new order: the address only mirrors it.
    setQueryState((prev) => {
      if (!prev) return prev
      const next = withSort(prev, sortFromGrid(model, 'postedAt:desc'))
      if (next !== prev) lastSignature.current = querySignature(next)
      return next
    })
    pageRows.current.clear()
  }, [])
  const openRow = useCallback((id: string) => setOpenReview(id), [])
  const onRowClicked = useCallback((e: { data?: InboxRow; event?: Event | null }) => {
    const target = e.event?.target
    // Ticking a row is not opening it.
    if (target instanceof Element && target.closest('.ag-selection-checkbox, .ag-checkbox, [col-id="ag-Grid-SelectionColumn"]')) return
    if (e.data) openRow(e.data.id)
  }, [openRow])
  const onCellKeyDown = useCallback((e: { data?: InboxRow; event?: Event | null; column?: { getColId(): string } }) => {
    const key = (e.event as KeyboardEvent | null | undefined)?.key
    if (key === 'Enter' && e.data && e.column?.getColId() !== 'ag-Grid-SelectionColumn') openRow(e.data.id)
  }, [openRow])
  const getRowId = useCallback((p: { data: InboxRow }) => p.data.id, [])
  const rowSelection = useMemo<NonNullable<ComponentProps<typeof NexusGrid<InboxRow>>['rowSelection']>>(() => ({
    mode: 'multiRow', checkboxes: true, headerCheckbox: false, enableClickSelection: false,
  }), [])
  const selectionColumnDef = useMemo(() => ({ width: gridGeometry.selectColW, maxWidth: gridGeometry.selectColW, resizable: false, headerComponent: LoadedRowsSelectionHeader }), [])

  // ── Customise ──
  const [prefsOpen, setPrefsOpen] = useState(false)
  const [prefs, setPrefs] = useState<PreferencesValue>(INBOX_DEFAULT_PREFS)
  const openCustomise = useCallback(() => {
    const api = gridApiRef.current
    if (!api || api.isDestroyed()) return
    setPrefs((current) => columnStateToPrefs(api.getColumnState(), current, INBOX_PREFS_BRIDGE))
    setPrefsOpen(true)
  }, [])
  const applyPrefs = useCallback((next: PreferencesValue) => {
    const api = gridApiRef.current
    if (!api || api.isDestroyed()) return
    api.applyColumnState({ state: prefsToColumnState(next, INBOX_PREFS_BRIDGE), applyOrder: true })
    setPrefs(next)
  }, [])
  const resetColumns = useCallback(() => {
    gridApiRef.current?.resetColumnState()
    setPrefs(INBOX_DEFAULT_PREFS)
  }, [])
  const columnDialog = useMemo(() => ({ customise: openCustomise, reset: resetColumns }), [openCustomise, resetColumns])

  // ── Cards (a phone) ──
  const [cards, setCards] = useState<InboxRow[] | null>(null)
  const [cardsBusy, setCardsBusy] = useState(false)
  const [cardsError, setCardsError] = useState<string | null>(null)
  const cardsSeq = useRef(0)
  const cardsRef = useRef<InboxRow[] | null>(null)
  cardsRef.current = cards
  const loadCards = useCallback(async (mode: 'first' | 'more' | 'again') => {
    const q = queryRef.current
    const loaded = cardsRef.current?.length ?? 0
    const page = mode === 'more' ? Math.floor(loaded / CARD_PAGE) + 1 : 1
    const size = mode === 'again' ? Math.min(200, Math.max(CARD_PAGE, loaded)) : CARD_PAGE
    const seq = ++cardsSeq.current
    setCardsBusy(true)
    setUpdating(true)
    const res = await reviewsGet<InboxPage>('/reviews/inbox', { ...inboxApiParams(q, page), pageSize: size })
    if (seq !== cardsSeq.current) return
    setCardsBusy(false)
    setUpdating(false)
    if (!res.data) {
      setCardsError(res.error)
      setListError(res.error)
      return
    }
    setCardsError(null)
    setListError(null)
    setTop(res.data)
    setCards((prev) => (mode === 'more' && prev ? [...prev, ...res.data!.rows.filter((r) => !prev.some((p) => p.id === r.id))] : res.data!.rows))
  }, [])
  const cardSignature = query ? querySignature({ ...query, pageSize: 50 }) : ''
  useEffect(() => {
    if (!narrow || !cardSignature) return
    setCards(null)
    void loadCards('first')
  }, [narrow, cardSignature, loadCards])
  const [selecting, setSelecting] = useState(false)
  const [cardTicks, setCardTicks] = useState<ReadonlySet<string>>(new Set())
  const toggleCard = useCallback((id: string) => setCardTicks((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }), [])
  const longPress = useCallback((id: string) => {
    setSelecting(true)
    setCardTicks((prev) => new Set(prev).add(id))
  }, [])
  const stopSelecting = useCallback(() => {
    setSelecting(false)
    setCardTicks(new Set())
  }, [])

  // ── Live: read again in place (ticks, filters and the page stay) ──
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const narrowRef = useRef(narrow)
  narrowRef.current = narrow
  const refresh = useCallback(() => {
    if (liveTimer.current) clearTimeout(liveTimer.current)
    liveTimer.current = setTimeout(() => {
      if (narrowRef.current) {
        void loadCards('again')
        return
      }
      const api = gridApiRef.current
      if (!api || api.isDestroyed()) return
      setListError(null)
      api.refreshServerSide({ purge: false })
    }, LIVE_MS)
  }, [loadCards])
  useEffect(() => () => { if (liveTimer.current) clearTimeout(liveTimer.current) }, [])
  useReviewEvents(refresh)
  useInvalidationChannel(['review.updated', 'review.replied', 'review.imported'], refresh)
  const retry = useCallback(() => {
    if (narrowRef.current) {
      void loadCards('first')
      return
    }
    setListError(null)
    gridApiRef.current?.refreshServerSide({ purge: true })
  }, [loadCards])

  // ── Bulk ──
  const tickedRows: BulkRow[] = narrow ? (cards ?? []).filter((r) => cardTicks.has(r.id)) : ticked
  const [bulk, setBulk] = useState<BulkAction | null>(null)
  const bulkDone = useCallback((words: string, tone: 'success' | 'warning') => {
    setBulk(null)
    toast(words, tone)
  }, [toast])

  // ── Header, tabs, tiles, filters, chips ──
  const facets = top?.facets ?? null
  const q = query ?? EMPTY_INBOX_QUERY
  const lit = litTile(q)
  const metrics = useMemo<Metric[]>(() => TILE_ORDER.map((tile) => ({
    label: tileLabel(tile),
    value: tileValue(top?.statusCounts ?? null, tile),
    hint: tileHint(tile),
    accent: tileAccent(tile),
    active: lit === tile,
    onClick: () => setQuery((prev) => toggleStatusTile(prev, tile)),
  })), [top?.statusCounts, lit, setQuery])

  const marketCodes = useMemo(() => {
    const seen = new Set([...BASE_MARKETS, ...(top?.readState ?? []).map((r) => r.market ?? '').filter(Boolean), ...q.markets])
    return [...seen].map((code) => ({ value: code, label: COUNTRY_NAMES[code] ?? code })).sort((a, b) => a.label.localeCompare(b.label))
  }, [top?.readState, q.markets])
  const setFilter = useCallback((key: InboxFilterKey, values: readonly (string | number)[]) => setQuery((prev) => withFilter(prev, key, values)), [setQuery])
  const dimensions = useMemo<FilterDimension[]>(() => {
    const words = (key: InboxFilterKey, values: readonly string[]) => values.map((value) => ({ value, label: valueWord(key, value, facets) }))
    const themes = facets?.themes.length ? facets.themes : Object.keys(THEME_LABEL)
    return [
      { key: 'channel', label: 'Channel', kind: 'multiselect', options: words('channels', CHANNELS), value: q.channels, onChange: (v) => setFilter('channels', v), placeholder: 'All' },
      { key: 'market', label: 'Market', kind: 'multiselect', options: marketCodes, value: q.markets, onChange: (v) => setFilter('markets', v), placeholder: 'All', searchable: true },
      { key: 'stars', label: 'Stars', kind: 'multiselect', options: words('stars', ['5', '4', '3', '2', '1']), value: q.stars.map(String), onChange: (v) => setFilter('stars', v), placeholder: 'All' },
      { key: 'mood', label: 'Mood', kind: 'multiselect', options: Object.entries(MOOD_WORD).map(([value, label]) => ({ value, label })), value: q.moods, onChange: (v) => setFilter('moods', v), placeholder: 'All' },
      { key: 'theme', label: 'Theme', kind: 'multiselect', options: themes.map((value) => ({ value, label: themeWord(value) })), value: q.themes, onChange: (v) => setFilter('themes', v), placeholder: 'All' },
      { key: 'status', label: 'Status', kind: 'multiselect', options: words('statuses', [...INBOX_STATUSES]), value: q.statuses, onChange: (v) => setFilter('statuses', v), placeholder: 'All' },
      {
        key: 'owner', label: 'Owner', kind: 'multiselect', placeholder: 'Anyone', searchable: true,
        options: [{ value: NO_OWNER, label: 'Nobody' }, ...(facets?.owners ?? []).map((o) => ({ value: o, label: o }))],
        value: q.owners, onChange: (v) => setFilter('owners', v),
      },
      {
        key: 'family', label: 'Product family', kind: 'multiselect', placeholder: 'All', searchable: true, wide: true,
        options: (facets?.families ?? []).map((f) => ({ value: f.id, label: f.label })),
        value: q.families, onChange: (v) => setFilter('families', v),
        heldReason: !facets ? 'The list is still loading.' : facets.families.length === 0 ? 'No product families yet.' : null,
      },
    ]
  }, [q, facets, marketCodes, setFilter])
  const filterCount = activeFilterCount(q)
  const chips = inboxChips(q, facets)
  const banners = readStateBanners(top?.readState ?? null)
  const pill = livePill({ error: !!listError, updating, readState: top?.readState ?? null })
  const subtitle = headerSubtitle(top?.total ?? null, q.period, listError && !top ? 'error' : top ? 'ready' : 'loading')

  const noRowsParams = useMemo(() => (isFiltered(q)
    ? { title: 'No reviews match these filters', message: 'Clear a filter to see more. New reviews still arrive while filters are on.', action: { label: 'Clear all filters', onClick: () => setQuery(clearFilters) } }
    : { title: 'No reviews yet', message: 'Reviews arrive here as Nexus reads them, or when you import a file.' }), [q, setQuery])

  // ── The pop-up's Prev / Next: the rows on screen ──
  const navIds = useMemo(() => (narrow ? (cards ?? []) : pageRows.current.get(pager.page) ?? top?.rows ?? []).map((r) => r.id),
    // `top` changes with every answer the grid gets, which is when the page's rows change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [narrow, cards, pager.page, top])

  if (!query) {
    return <div className={s.page} aria-busy="true"><PageHeader eyebrow={reviewsCrumbs(pathname)} title="Inbox" subtitle="Loading…" actions={<ReviewsMenuButton />} /></div>
  }

  const bulkButtons = (wrap: boolean) => BULK_ACTIONS.map((action) => {
    const Icon = BULK_ICON[action]
    const held = bulkActionHeld(action, { canManage, rows: tickedRows })
    return (
      <Button key={action} size="sm" aria-label={BULK_LABEL[action]} onClick={() => setBulk(action)} heldReason={held}>
        <Icon size={13} aria-hidden /> {wrap ? <SelectionLabel>{BULK_LABEL[action]}</SelectionLabel> : BULK_LABEL[action]}
      </Button>
    )
  })

  const actions = (
    <div className={s.actions}>
      <ReviewsMenuButton />
      <SegmentedControl size="sm" ariaLabel="Period" options={PERIOD_OPTIONS} value={q.period} onChange={(p) => setQuery((prev) => withPeriod(prev, p))} />
      <Button size="sm" onClick={() => setImportOpen(true)} heldReason={canManage ? null : MANAGE_IMPORT}>Import reviews…</Button>
    </div>
  )

  return (
    <div className={s.page}>
      <PageHeader eyebrow={reviewsCrumbs(pathname)} title="Inbox" subtitle={subtitle} actions={actions} />

      <Tabs
        ariaLabel="Kind of review"
        tabs={tabItems(top?.tabCounts ?? null)}
        active={q.kind}
        onChange={(id) => setQuery((prev) => withKind(prev, id))}
        overflow="scroll"
      />

      <MetricStrip metrics={metrics} minTileWidth={132} className={s.tiles} />

      {listError && (
        <Banner tone="danger" title="The Inbox could not load." action={<Button size="sm" onClick={retry}>Try again</Button>}>
          {listError} Nothing is lost: reviews keep arriving and show here when Nexus answers.
        </Banner>
      )}
      {banners.map((b) => (
        <Banner key={b.key} tone="warning" title={b.title} action={b.action ? <Button asChild size="sm"><Link href={b.action.href}>{b.action.label}</Link></Button> : undefined}>
          {b.body}
        </Banner>
      ))}

      <FilterBar
        dimensions={dimensions}
        onClear={() => { setQuery(clearFilters); setSearchDraft('') }}
        activeCount={filterCount + (q.q ? 1 : 0) + (q.period !== 'all' ? 1 : 0)}
        presets={(
          // ⛔ KEEP — placeholder (build spec ruling 3): "Has photos" filters by buyers' photos, which Nexus reads from
          // Phase 3 (eBay REST, review apps). Held with its reason until then, never hidden.
          <span className={s.placeholder}>
            <Button size="sm" heldReason="Coming later: Nexus does not read buyers’ photos yet, so there is nothing to filter by.">Has photos</Button>
            <Pill tone="info">Coming later</Pill>
          </span>
        )}
      />

      {chips.length > 0 && (
        <div className={s.chips} role="group" aria-label="Filters on">
          {chips.map((chip) => (
            <TokenChip key={chip.key} onRemove={() => { setQuery(() => chip.next); if (chip.key === 'q') setSearchDraft('') }} removeLabel={chip.removeLabel}>
              {chip.label}
            </TokenChip>
          ))}
        </div>
      )}

      {narrow ? (
        <>
          <div className={s.phoneTools}>
            <Input
              leadingIcon={<Search size={13} aria-hidden />}
              placeholder="Search text, buyer or SKU"
              aria-label="Search text, buyer or SKU"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
            />
            <Listbox size="sm" ariaLabel="Order" options={SORT_OPTIONS} value={q.sort} onChange={(v) => setQuery((prev) => withSort(prev, v))} />
            {selecting
              ? <Button size="sm" onClick={stopSelecting}>Done</Button>
              : <Button size="sm" onClick={() => setSelecting(true)}>Select</Button>}
            <Pill tone={pill.tone} dot>{pill.words}</Pill>
          </div>
          <InboxCards
            rows={cards}
            total={top?.total ?? null}
            loading={cardsBusy}
            error={cardsError}
            onRetry={retry}
            onOpen={openRow}
            selecting={selecting}
            selected={cardTicks}
            onToggle={toggleCard}
            onLongPress={longPress}
            onMore={() => void loadCards('more')}
            moreHeld={null}
            filtered={isFiltered(q)}
            onClearFilters={() => { setQuery(clearFilters); setSearchDraft('') }}
          />
          <BulkActionBar count={cardTicks.size} onClear={stopSelecting} noun={cardTicks.size === 1 ? 'review ticked' : 'reviews ticked'} className={s.phoneBar}>
            {bulkButtons(false)}
          </BulkActionBar>
        </>
      ) : (
        <GridCard
          toolbar={(
            <GridToolbar
              count={ticked.length > 0 ? <><b>{ticked.length.toLocaleString('en-US')}</b> selected</> : top ? <><b>{top.total.toLocaleString('en-US')}</b> {top.total === 1 ? 'review' : 'reviews'}</> : '—'}
              right={(
                <>
                  {ticked.length === 0 && <GridDensityToggle value={density} onChange={setDensity} />}
                  <Button size="sm" onClick={openCustomise} heldReason={gridApi ? null : 'The list is still loading.'}>
                    <SlidersHorizontal size={13} aria-hidden /> Customise
                  </Button>
                  <GridViewsMenu views={gridViews} />
                  <Pill tone={pill.tone} dot size="md">{pill.words}</Pill>
                </>
              )}
            >
              {ticked.length > 0 ? (
                <GridSelectionActions>
                  {bulkButtons(true)}
                  <Button size="sm" variant="link" onClick={clearGridSelection}>Clear</Button>
                </GridSelectionActions>
              ) : (
                <GridSearchSlot>
                  <Input
                    leadingIcon={<Search size={13} aria-hidden />}
                    placeholder="Search text, buyer or SKU…"
                    aria-label="Search text, buyer or SKU"
                    value={searchDraft}
                    onChange={(e) => setSearchDraft(e.target.value)}
                    style={{ width: '100%' }}
                  />
                </GridSearchSlot>
              )}
            </GridToolbar>
          )}
          footer={!listError ? (
            <GridPager page={pager.page} pageCount={pager.pageCount} pageSize={q.pageSize} pageSizes={INBOX_PAGE_SIZES} onPage={onPage} onPageSize={onPageSize} />
          ) : undefined}
        >
          <GridDensityProvider value={density}>
            {listError && !top ? (
              // A failed read is not an empty Inbox.
              <EmptyState
                icon={<AlertTriangle size={20} />}
                title="Couldn’t load the reviews"
                description={`${listError} This is not an empty Inbox.`}
                action={<Button size="sm" onClick={retry}>Try again</Button>}
              />
            ) : null}
            <div className={listError && !top ? s.offstage : undefined}>
              <NexusGrid<InboxRow>
                domLayout="autoHeight"
                density={density}
                rows="media"
                rowModelType="serverSide"
                serverSideDatasource={datasource}
                cacheBlockSize={q.pageSize}
                pagination
                paginationPageSize={q.pageSize}
                paginationPageSizeSelector={false}
                suppressPaginationPanel
                suppressMultiSort
                onPaginationChanged={onPaginationChanged}
                onSortChanged={onSortChanged}
                getRowId={getRowId}
                onGridReady={onGridReady}
                columnDefs={INBOX_COLUMN_DEFS}
                columnDialog={columnDialog}
                rowSelection={rowSelection}
                selectionColumnDef={selectionColumnDef}
                onSelectionChanged={onSelectionChanged}
                onStoreRefreshed={onStoreRefreshed}
                onRowClicked={onRowClicked}
                onCellKeyDown={onCellKeyDown}
                initialState={initialState}
                noRowsOverlayComponent={GridNoRowsOverlay}
                noRowsOverlayComponentParams={noRowsParams}
              />
            </div>
          </GridDensityProvider>
        </GridCard>
      )}

      {/* ⛔ KEEP — placeholder (build spec ruling 3): Amazon seller feedback (Phase 3, PR H), Etsy reviews (PR I) and eBay
          photos (PR G) are not read yet. Two labelled sample rows show where they will appear; they are not reviews. */}
      <Card header="Coming later" headerAction={<Pill tone="neutral">Sample</Pill>}>
        <p className={s.hint}>Amazon seller feedback, Etsy reviews and eBay photos arrive in later updates. These rows show how they will look; they are samples, not your reviews.</p>
        <ul className={s.sampleList}>
          <li className={s.sampleRow}>
            <StarRating value={2} size="sm" label="2 stars (sample)" />
            <span className={s.stack}><span className={s.main}>Amazon IT · Seller feedback</span><span className={s.sub}>“The gloves arrived with an open seam on the thumb.”</span></span>
            <Pill tone="neutral">Sample</Pill>
          </li>
          <li className={s.sampleRow}>
            <StarRating value={5} size="sm" label="5 stars (sample)" />
            <span className={s.stack}><span className={s.main}>Etsy · Product review · 2 photos</span><span className={s.sub}>“Beautiful stitching, fits true to size and keeps me warm.”</span></span>
            <Pill tone="neutral">Sample</Pill>
          </li>
        </ul>
      </Card>

      {prefsOpen && (
        <PreferencesModal
          open={prefsOpen}
          onClose={() => setPrefsOpen(false)}
          title="Customise columns"
          value={prefs}
          onConfirm={applyPrefs}
          allColumns={INBOX_COLUMN_SPECS}
          defaultVisible={INBOX_DEFAULT_VISIBLE}
          pageSizeChoices={[]}
          sortFieldOptions={[]}
          showSticky={false}
        />
      )}

      {openReview && (
        <ReviewDetailModal
          reviewId={openReview}
          ids={navIds}
          onGo={setOpenReview}
          onClose={() => setOpenReview(null)}
          canManage={canManage}
          owners={facets?.owners ?? []}
          me={me}
        />
      )}

      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} canManage={canManage} />

      {bulk && (
        <BulkDialog
          action={bulk}
          rows={tickedRows}
          canManage={canManage}
          owners={facets?.owners ?? []}
          me={me}
          onClose={() => setBulk(null)}
          onDone={bulkDone}
        />
      )}
    </div>
  )
}

interface BulkDialogProps {
  action: BulkAction
  rows: readonly BulkRow[]
  canManage: boolean
  owners: readonly string[]
  me: string | null
  onClose: () => void
  onDone: (words: string, tone: 'success' | 'warning') => void
}

/** One window per bulk action: pick the value, see how many reviews it changes, apply. */
function BulkDialog({ action, rows, canManage, owners, me, onClose, onDone }: BulkDialogProps) {
  const [value, setValue] = useState(action === 'assign' && me ? me : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const picked = action === 'draft' ? null : value
  const reach = bulkReach(action, action === 'assign' ? value || null : picked, rows)
  const held = busy ? 'Applying… this takes a few seconds.' : bulkApplyHeld(action, picked, { canManage, rows })
  const skipped = bulkSkipWords(reach.skipped)

  const apply = async () => {
    setBusy(true)
    setError(null)
    const res = await reviewsSend<{ changed: number; skipped: { id: string; reason: string }[] }>('POST', '/reviews/inbox/bulk', bulkBody(rows.map((r) => r.id), action, picked))
    setBusy(false)
    if (!res.data) {
      setError(res.error)
      return
    }
    emitInvalidation({ type: 'review.updated', meta: { bulk: action, changed: res.data.changed } })
    onDone(bulkResultWords(action, picked || null, res.data), res.data.changed > 0 ? 'success' : 'warning')
  }

  const ticked = `${rows.length.toLocaleString('en-US')} ticked`
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={`${BULK_LABEL[action]} · ${ticked}`}
      footer={(
        <div className={s.dialogFoot}>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" onClick={() => void apply()} heldReason={held}>{bulkApplyLabel(action, picked || null, reach.apply.length)}</Button>
        </div>
      )}
    >
      <div className={s.dialogBody}>
        {action === 'assign' && (
          <Field label="Owner" hint="The person who answers these reviews. Nobody takes them off their owner.">
            <Listbox size="sm" ariaLabel="Owner" options={ownerChoices(owners, me)} value={value} onChange={setValue} searchable width="100%" />
          </Field>
        )}
        {action === 'tag' && (
          <Field label="Tag" hint={`Added to each ticked review's tags. Up to ${TAG_MAX} characters.`}>
            <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="size chart" aria-label="Tag" />
          </Field>
        )}
        {action === 'status' && (
          <Field label="Status">
            <Listbox
              size="sm"
              ariaLabel="Status"
              placeholder="Pick a status"
              options={SETTABLE_STATUSES.map((v) => ({ value: v, label: valueWord('statuses', v) }))}
              value={value || undefined}
              onChange={setValue}
              width="100%"
            />
          </Field>
        )}
        {action === 'draft' && (
          <p className={s.hint}>
            Nexus drafts a reply to each review in the buyer’s language, one AI call each. Nothing is sent: each draft waits in the review for a person to read and send it.
          </p>
        )}
        {skipped && <p className={s.hint}>{skipped}</p>}
        {error && <Banner tone="danger" title={error} />}
      </div>
    </Modal>
  )
}

/** The page's own toasts (the Views menu reports through them too). */
export function InboxClient() {
  return (
    <ToastProvider>
      <InboxInner />
    </ToastProvider>
  )
}
