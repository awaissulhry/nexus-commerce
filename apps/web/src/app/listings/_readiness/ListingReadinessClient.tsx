'use client'

/**
 * /listings — the Listings page: what is ready, what needs work, and where to fix it (rebuild 2026-10-23, layout A;
 * docs/listings/READINESS-REBUILD-2026-10-23.md §2). It took over the Listings menu entry on 2026-10-24; the old
 * page is `/listings/legacy` (docs/listings/LISTINGS-SWAP-2026-10-24.md).
 *
 * The Products page's frame and parts, the same way round: header · tiles · Filters · one grid card (toolbar, the
 * server-side tree grid, the pager). One row per product family; a family folds open to a 10-row preview and the
 * family footer. Every verdict, count and order is the API's (`GET /api/catalog-transfer/readiness/families`); the
 * page never decides one.
 *
 * Live like Products: the server's events (`readiness.updated` names the family that changed), a re-read every 30 s
 * and when the tab comes back. A refresh is `refreshServerSide({ purge: false })`, so an open family stays open.
 *
 * The address is the page's state (`readinessQuery.ts`): every older link keeps working, and the page writes its
 * filters back with `history.replaceState` so a reload or a shared link shows the same thing.
 *
 * The menu's store pages are this page with a lock (`readinessScope.ts`, 2026-10-24): `/listings/amazon`,
 * `/listings/amazon/it`, `/listings/ebay`, `/listings/ebay/de`, `/listings/shopify` show that store (and market) only.
 *
 * The live layer (step 3 of docs/listings/LISTINGS-LIVE-LAYER-PLAN-2026-10-25.md, read only): what the channel shows,
 * as far as Nexus knows — each chip's mark, the "On the channel" column, the live tiles (Live · Errors · Suppressed ·
 * Out of sync) and the Channel state and Stock filters. All of it only when the answer carries live data
 * (`pageHasLive`); an older API, or a person without `listings.view`, sees the page as it was, the Amazon suppression
 * banner included.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Archive, ChevronDown, History, Search, SlidersHorizontal } from 'lucide-react'
import type { ReadinessDestination, ReadinessFamiliesPage } from '@nexus/shared/listing-readiness'

import Link from '@/lib/workspaces/Link'
import { browserWorkspaceId, workspaceHref } from '@/lib/workspaces/paths'
import { getBackendUrl } from '@/lib/backend-url'
import { useInvalidationChannel, type InvalidationEvent, type InvalidationType } from '@/lib/sync/invalidation-channel'
import { useListingEvents } from '@/lib/sync/use-listing-events'
import { usePolledList } from '@/lib/sync/use-polled-list'
import { streamsEnabled } from '@/lib/sync/dev-stream-gate'
import { Button, Input, Pill, TokenChip } from '@/design-system/primitives'
import { Banner, EmptyState, Menu, MetricStrip, ToastProvider, type Metric } from '@/design-system/components'
import { FilterBar, GridToolbar, PageHeader, PreferencesModal, type FilterDimension, type PreferencesValue } from '@/design-system/patterns'
import type { PreferencesColumnSpec } from '@/design-system/patterns/PreferencesModal'
import {
  GRID_DENSITIES,
  GridDensityProvider,
  GridDensityToggle,
  GridPager,
  GridSearchSlot,
  GridViewsMenu,
  NexusGrid,
  columnStateToPrefs,
  gridDensity,
  gridGeometry,
  prefsToColumnState,
  readinessMeta,
  useGridState,
  type GridApi,
  type GridReadyEvent,
  type GridStateKey,
  type PrefsBridgeOptions,
} from '@/design-system/grid'

import { transferApi } from '@/app/products/catalog-transfer/transferApi'
import { TranslateDialog, useCatalogLanguages } from '@/app/products/next/TranslateDialog'
import { DEFAULT_DENSITY, type DensityMode } from '@/app/products/next/density'
import { ReadinessFixDialog } from './FixDialog'
import styles from './readiness.module.css'
import { READINESS_COLUMN_SPECS, ReadinessFamilyFooter, readinessColumns, readinessTreeColumn, type ReadinessGridContext } from './readinessColumns'
import { createReadinessDatasource, type ReadinessTopLevel } from './readinessDatasource'
import { addToPlan, EMPTY_PLAN, familiesToRefresh, LIVE_DEBOUNCE_MS, LIVE_INTERVAL_MS, mayRefreshAgain, READINESS_EVENT, type RefreshPlan } from './readinessLive'
import {
  DEFAULT_READINESS_PAGE_SIZE,
  EMPTY_READINESS_QUERY,
  READINESS_PAGE_SIZES,
  activeFilterCount,
  apiFilterParams,
  familyPageHref,
  isPageSize,
  notFoundWords,
  parseReadinessQuery,
  selectorChipText,
  serializeReadinessQuery,
  translateScope,
  viewFiltersOf,
  withFilter,
  withLock,
  withViewFilters,
  withoutFilters,
  type ReadinessFilterKey,
  type ReadinessPageQuery,
  type ReadinessPageSize,
  type ReadinessViewFilters,
} from './readinessQuery'
import { canExpand, isFamilyRow, isReadinessFooter, readinessRowId, type ReadinessGridRow } from './readinessRows'
import { listingsInView, stateForTile, tileAccent, tileCount, tileHint, tileIsLit, tileLabel, visibleTiles } from './readinessTiles'
import { channelLabel, destinationLookup, orderedChips, plural } from './marketChips'
import { marketsColumnState, marketsFill, marketsFillForWindow, sizingForWidth } from './marketsWidth'
import { relativeTime } from './relativeTime'
import { hasLiveColumn, LIVE_COLUMN, orderWithLiveAfterMarkets, pageHasLive } from './liveMarks'
import {
  CHANNEL_STATE_OPTIONS,
  LIVE_TILE_HINT,
  LIVE_TILES,
  STOCK_OPTIONS,
  channelStatesOf,
  liveTileAccent,
  liveTileCount,
  liveTileIsLit,
  liveTileLabel,
  stockOf,
  withChannelStates,
  withLiveTile,
  withStock,
} from './liveFilters'
import { legacyMarketHref, legacyPath, lockedKeys, marketCount, marketWord, readinessPath, scopeWords, storeWord, suppressedListings, type ReadinessLock } from './readinessScope'

/* ── Constants ──────────────────────────────────────────────────────────────────────────────────────────────────── */

/** One family's readiness changed (`id` = the family root), plus the product and listing events Products listens to. */
const LIVE_TYPES: InvalidationType[] = [
  READINESS_EVENT,
  'product.updated',
  'product.created',
  'product.deleted',
  'listing.updated',
]
/** What the page remembers between visits: the columns only. Filters live in the address, paging in the pager. */
const PERSIST_KEYS: readonly GridStateKey[] = ['columnSizing', 'columnOrder', 'columnVisibility', 'columnPinning']
const NO_ROWS_TEMPLATE = '<span style="color: var(--nds-text-muted)">No products match these filters.</span>'
const NO_CHOICES: number[] = []
const NO_SORT_OPTIONS: Array<{ value: string; label: string }> = []
const REFRESH_ALL: RefreshPlan = { all: true, roots: new Set() }

/** The Customise dialog's columns, its bridge to AG and its defaults. On the channel is one only with live data. */
interface ColumnSetup { bridge: PrefsBridgeOptions; specs: PreferencesColumnSpec[]; defaults: PreferencesValue }
function columnSetup(live: boolean): ColumnSetup {
  const columns = READINESS_COLUMN_SPECS.filter((c) => live || c.key !== LIVE_COLUMN)
  return {
    bridge: { columns: columns.map((c) => ({ key: c.key, locked: 'locked' in c && c.locked })), treeColumnKey: 'product' },
    specs: columns.map((c) => ({ key: c.key, label: c.label, ...('locked' in c && c.locked ? { locked: true, uncounted: true } : {}) })),
    defaults: {
      visibleColumns: columns.map((c) => c.key),
      lockedColumns: [],
      stickyFirstColumn: true,
      stickyLastColumn: true,
      pageSize: 0,
      sortBy: '',
      sortDir: 'asc',
    },
  }
}

const isDensity = (value: unknown): value is DensityMode => (GRID_DENSITIES as readonly unknown[]).includes(value)

/* ── Types ──────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** GET /api/catalog-transfer/readiness/options — the subset this page reads. */
interface ReadinessOptions {
  families: Array<{ id: string; code?: string | null; label: string }>
  accounts: Array<{ id: string; channelType: string; marketplace?: string | null; displayName: string }>
  markets: Array<{ channel: string; code: string; name: string }>
}

/** What a saved view keeps beside the grid's own column state. */
interface ReadinessViewState {
  density: DensityMode
  pageSize: ReadinessPageSize
  filters: ReadinessViewFilters
}

interface FixTarget {
  productId: string
  family: boolean
  destinationKey: string
  /** The row's own destinations, in chip order: the window's switcher. */
  destinations: ReadinessDestination[]
  productName: string
}

/** A select filter whose value the options do not list (still loading, or an older link) still shows that value. */
function withCurrent(options: Array<{ value: string; label: string }>, value: string): Array<{ value: string; label: string }> {
  return !value || options.some((o) => o.value === value) ? options : [...options, { value, label: value }]
}

/** The crumbs above the title (the DS header's eyebrow, as on Publish history). */
function ScopeCrumbs({ crumbs }: { crumbs: Array<{ label: string; href: string }> }) {
  return (
    <nav aria-label="Breadcrumb">
      {crumbs.map((c, i) => (
        <span key={c.href}>
          {i > 0 && <span aria-hidden> › </span>}
          <Link href={c.href}>{c.label}</Link>
        </span>
      ))}
    </nav>
  )
}

/**
 * " · checked 2 min ago", and " · 12 listings last checked over a day ago" when there are any: the newest check, so
 * one family waiting for its nightly turn does not make the whole page read as stale (2026-10-25).
 */
function checkedWords(checked: ReadinessFamiliesPage['checked'] | undefined, now: number): string {
  if (!checked?.latest) return ''
  const old = checked.olderThanDay > 0 ? ` · ${plural(checked.olderThanDay, 'listing')} last checked over a day ago` : ''
  return ` · checked ${relativeTime(checked.latest, now)}${old}`
}

/** The eBay page's own tools: before 2026-10-24 two tiles and a button on the old eBay page. */
function ebayTools(lock: ReadinessLock): Array<{ id: string; label: string; href: string }> {
  const inBusiness = (href: string) => workspaceHref(browserWorkspaceId(), href)
  return [
    { id: 'markdowns', label: 'Markdowns', href: inBusiness('/listings/ebay/markdowns') },
    { id: 'campaigns', label: 'Promoted campaigns', href: inBusiness('/listings/ebay/campaigns') },
    { id: 'gaps', label: 'Gap analysis', href: inBusiness(`/listings/ebay/gaps${lock.marketplace ? `?marketplace=${lock.marketplace}` : ''}`) },
  ]
}

/** `GET /api/listings/amazon/overview` — the part this page reads: the old Amazon page's suppression list. */
interface AmazonSuppressions { activeSuppressions: Array<{ listingId: string; listing: { marketplace: string } }> }

/* ── The page ───────────────────────────────────────────────────────────────────────────────────────────────────── */

function ListingReadinessInner({ lock }: { lock: ReadinessLock | null }) {
  const backendUrl = getBackendUrl()

  // ── The query (the address is its owner) ──────────────────────
  const [query, setQueryState] = useState<ReadinessPageQuery | null>(null)
  const queryRef = useRef(query)
  queryRef.current = query
  // Every change keeps the store page's lock (`withLock`): a tile, Clear, a saved view, a view that answers late.
  const setQuery = useCallback((update: (q: ReadinessPageQuery) => ReadinessPageQuery) => {
    setQueryState((prev) => (prev ? withLock(update(prev)) : prev))
  }, [])
  const [density, setDensity] = useState<DensityMode>(DEFAULT_DENSITY)
  const densityRef = useRef(density)
  densityRef.current = density
  /** The page a link asked for (`?page=3`), until the grid knows how many pages there are. */
  const initialPageRef = useRef<number | null>(null)
  /** The search box; it reaches the query ~300 ms after the last keystroke. */
  const [searchDraft, setSearchDraft] = useState('')
  const searchDirty = useRef(false)

  // ── Saved views and the last-used columns ─────────────────────
  /** True once the grid is up: from then on an applied view brings its filters too. */
  const boundRef = useRef(false)
  /** A plain visit lands on a default view that answers late; a link with its own filters is an instruction and keeps them. */
  const [plainVisit] = useState(() => typeof window !== 'undefined' && window.location.search.length <= 1)
  const gridViews = useGridState<ReadinessViewState>({
    surface: 'listing-readiness',
    baseUrl: backendUrl,
    persistKeys: PERSIST_KEYS,
    landOnLateDefault: plainVisit,
    getPageState: () => ({
      density: densityRef.current,
      pageSize: queryRef.current?.pageSize ?? DEFAULT_READINESS_PAGE_SIZE,
      filters: viewFiltersOf(queryRef.current ?? EMPTY_READINESS_QUERY),
    }),
    applyPageState: (page) => {
      if (!page) return
      if (isDensity(page.density)) setDensity(page.density)
      if (!boundRef.current) return
      setQuery((q) => ({ ...withViewFilters(q, page.filters), ...(isPageSize(page.pageSize) ? { pageSize: page.pageSize } : {}) }))
    },
  })
  // A saved layout remembers Markets' `flex`; a phone reads it without (see `marketsWidth.ts`).
  const [initialState] = useState(() => sizingForWidth(gridViews.initialState, marketsFillForWindow()))
  /** The last visit had live data (its layout has the On the channel column): start with the column, as it was left. */
  const [liveAtMount] = useState(() => hasLiveColumn(gridViews.initialState))
  /** What the latest answer says, for the cells (set before its rows draw). */
  const liveRef = useRef(liveAtMount)

  // Read the address once, on the client. A remembered page size applies unless the link names its own paging.
  useEffect(() => {
    const search = new URLSearchParams(window.location.search)
    const parsed = parseReadinessQuery(search, lock)
    const remembered = gridViews.lastUsed?.page
    if (remembered && isDensity(remembered.density)) setDensity(remembered.density)
    const pageSize = !search.has('pageSize') && !search.has('page') && remembered && isPageSize(remembered.pageSize) ? remembered.pageSize : parsed.pageSize
    initialPageRef.current = parsed.page > 1 ? parsed.page : null
    setQueryState({ ...parsed, pageSize })
    setSearchDraft(parsed.q)
    // Once, on mount: the address is read when the page opens, then the page writes it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── The grid ──────────────────────────────────────────────────
  const [gridApi, setGridApi] = useState<GridApi<ReadinessGridRow> | null>(null)
  const gridApiRef = useRef<GridApi<ReadinessGridRow> | null>(null)
  const [pager, setPager] = useState<{ page: number; pageCount: number }>({ page: 1, pageCount: 1 })

  // ── What the last top-level answer said ───────────────────────
  const [top, setTop] = useState<ReadinessTopLevel | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [updating, setUpdating] = useState(false)
  const destinationsRef = useRef<readonly ReadinessDestination[]>([])
  /** Every destination seen this visit: a family's own page reads members, which carry keys but no labels. */
  const knownRef = useRef(new Map<string, ReadinessDestination>())
  const lookupRef = useRef(destinationLookup([]))
  const topLoadedRef = useRef(false)
  const families = top?.kind === 'families' ? top.page : null
  const members = top?.kind === 'members' ? top.page : null

  const datasource = useMemo(
    () =>
      createReadinessDatasource({
        getQuery: () => queryRef.current ?? EMPTY_READINESS_QUERY,
        onRequest: () => setUpdating(true),
        onTopLevel: (next) => {
          liveRef.current = pageHasLive(next.page)
          if (next.kind === 'families') {
            destinationsRef.current = next.page.destinations
            for (const d of next.page.destinations) knownRef.current.set(d.key, d)
          }
          lookupRef.current = destinationLookup([...knownRef.current.values()])
          topLoadedRef.current = true
          setTop(next)
          setListError(null)
          setUpdating(false)
        },
        onError: (message) => {
          setListError(message)
          setUpdating(false)
        },
      }),
    [],
  )

  // ── The Fix window ────────────────────────────────────────────
  const [fix, setFix] = useState<FixTarget | null>(null)

  /** One object for the life of the page (AG `context`); its functions read the page's current state. */
  const cellContext = useMemo<ReadinessGridContext>(
    () => ({
      destinations: () => (queryRef.current?.parent ? [...knownRef.current.values()] : destinationsRef.current),
      destinationOf: (key) => lookupRef.current(key),
      // A family row's chip is the family's verdict: the window reads the whole family on that destination.
      openFix: (row, destinationKey) => {
        const own = orderedChips(row.chips, queryRef.current?.parent ? [...knownRef.current.values()] : destinationsRef.current)
        setFix({
          productId: row.id,
          family: isFamilyRow(row) && row.isParent && !queryRef.current?.parent,
          destinationKey,
          destinations: own.map((chip) => lookupRef.current(chip.destinationKey)),
          productName: row.name || row.sku,
        })
      },
      familyHref: (rootId) => familyPageHref(queryRef.current ?? EMPTY_READINESS_QUERY, rootId),
      flat: () => !!queryRef.current?.parent,
      liveShown: () => liveRef.current,
      now: () => Date.now(),
    }),
    [],
  )
  /** Markets takes the free width only when there is some (`marketsWidth.ts`). The window's width decides
   *  before the grid's first layout (AG must never start with a flex column it cannot place); the card's width after. */
  const [fill, setFill] = useState(marketsFillForWindow)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const cardShown = query !== null // the card renders once the address is read
  useEffect(() => {
    const card = cardRef.current
    if (!card || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setFill(marketsFill(entry.contentRect.width)))
    observer.observe(card)
    return () => observer.disconnect()
  }, [cardShown])
  // Live data, as the latest answer says; until the first answer, as the last visit left it.
  const liveShown = top ? pageHasLive(top.page) : liveAtMount
  const columnDefs = useMemo(() => readinessColumns(cellContext, { fill, live: liveShown }), [cellContext, fill, liveShown])
  // On the channel arrives with the first answer that has live data, and AG puts a new column last: it goes after
  // Markets, once. A column the grid started with sits where the person left it.
  const livePlacedRef = useRef(liveAtMount)
  useEffect(() => { if (!liveShown) livePlacedRef.current = false }, [liveShown])
  useEffect(() => {
    if (!gridApi || gridApi.isDestroyed()) return
    const place = () => {
      if (livePlacedRef.current || gridApi.isDestroyed()) return
      const ids = gridApi.getColumnState().map((c) => c.colId)
      if (!ids.includes(LIVE_COLUMN)) return
      livePlacedRef.current = true
      const order = orderWithLiveAfterMarkets(ids)
      if (order) gridApi.applyColumnState({ state: order.map((colId) => ({ colId })), applyOrder: true })
    }
    place()
    gridApi.addEventListener('gridColumnsChanged', place)
    return () => { if (!gridApi.isDestroyed()) gridApi.removeEventListener('gridColumnsChanged', place) }
  }, [gridApi, columnDefs])
  // The column's live state, too: a restored layout or an earlier width may still carry the other setting.
  useEffect(() => {
    if (gridApi && !gridApi.isDestroyed()) gridApi.applyColumnState({ state: marketsColumnState(fill) })
  }, [gridApi, fill])
  const autoGroupColumnDef = useMemo(() => readinessTreeColumn(), [])

  /**
   * A NEW QUERY purges and re-asks from page 1. What counts as new is what the datasource would SEND — the filters,
   * the family page, the page size — so the pager moving or a refresh never folds the open families away.
   */
  const signature = query ? JSON.stringify({ filters: apiFilterParams(query), parent: query.parent, pageSize: query.pageSize }) : ''
  const lastSignature = useRef<string | null>(null)
  useEffect(() => {
    if (!gridApi || !signature) return
    if (lastSignature.current === signature) return
    const first = lastSignature.current === null
    lastSignature.current = signature
    if (first || gridApi.isDestroyed()) return // the grid's own first load already asked with this query
    gridApi.paginationGoToPage(0)
    gridApi.refreshServerSide({ purge: true })
  }, [gridApi, signature])

  // No `resetRowHeights()` on a density change: the Markets column is `autoHeight`, so AG measures every row itself
  // (and warns that a reset "makes no sense"); the new `getRowHeight` is the floor it measures against.

  // ── The address, kept in step ─────────────────────────────────
  useEffect(() => {
    if (!query) return
    const search = serializeReadinessQuery({ ...query, page: initialPageRef.current ?? pager.page })
    const next = `${window.location.pathname}${search ? `?${search}` : ''}`
    // `{}`, not `history.state`: Next's own state object makes the app router skip its apply (see the Products page).
    if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState({}, '', next)
  }, [query, pager.page])

  // ── Live ──────────────────────────────────────────────────────
  /** Read the screen again in place: the top level, and the open families the plan names. */
  const refreshGrid = useCallback((plan: RefreshPlan) => {
    setListError(null)
    const api = gridApiRef.current
    if (!api || api.isDestroyed()) return
    api.refreshServerSide({ purge: false })
    const open: Array<{ id: string; route: string[] }> = []
    api.forEachNode((node) => {
      if (node.group && node.expanded && node.key != null) open.push({ id: String(node.key), route: node.getRoute() ?? [String(node.key)] })
    })
    const ids = new Set(familiesToRefresh(plan, open.map((o) => o.id)))
    for (const o of open) if (ids.has(o.id)) api.refreshServerSide({ route: o.route, purge: false })
  }, [])

  const planRef = useRef<RefreshPlan>(EMPTY_PLAN)
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onLiveEvent = useCallback((event: InvalidationEvent) => {
    planRef.current = addToPlan(planRef.current, event)
    if (liveTimer.current != null) return
    // About a second: a burst of family rebuilds is one refresh.
    liveTimer.current = setTimeout(() => {
      liveTimer.current = null
      const plan = planRef.current
      planRef.current = EMPTY_PLAN
      refreshGrid(plan)
    }, LIVE_DEBOUNCE_MS)
  }, [refreshGrid])
  useEffect(() => () => { if (liveTimer.current != null) clearTimeout(liveTimer.current) }, [])
  // The server's events (one stream per tab), into the same invalidation channel the page listens to.
  useListingEvents(streamsEnabled())
  useInvalidationChannel(LIVE_TYPES, onLiveEvent)
  // A re-read every 30 s and when the tab comes back, as on Products — and the "checked 2 min ago" words move on.
  const [now, setNow] = useState(() => Date.now())
  const lastReadAt = useRef<number | null>(null)
  useEffect(() => {
    const refreshVisible = () => {
      if (document.visibilityState !== 'visible') return
      const at = Date.now()
      if (!mayRefreshAgain(lastReadAt.current, at)) return
      lastReadAt.current = at
      setNow(at)
      refreshGrid(REFRESH_ALL)
    }
    const timer = window.setInterval(refreshVisible, LIVE_INTERVAL_MS)
    window.addEventListener('focus', refreshVisible)
    document.addEventListener('visibilitychange', refreshVisible)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refreshVisible)
      document.removeEventListener('visibilitychange', refreshVisible)
    }
  }, [refreshGrid])

  // ── Filters ───────────────────────────────────────────────────
  const [options, setOptions] = useState<ReadinessOptions | null>(null)
  const [optionsError, setOptionsError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    void transferApi<ReadinessOptions>('catalog-transfer/readiness/options', undefined, controller.signal)
      .then(setOptions)
      .catch((error: Error) => { if (!controller.signal.aborted) setOptionsError(error.message) })
    return () => controller.abort()
  }, [])
  const languages = useCatalogLanguages()

  const filterDimensions = useMemo<FilterDimension[]>(() => {
    if (!query) return []
    const set = (key: ReadinessFilterKey) => (value: string) => setQuery((q) => withFilter(q, key, value))
    const markets = options?.markets ?? []
    const channels = [...new Set(markets.map((m) => m.channel))]
    const marketOptions = [...new Map(markets.filter((m) => !query.channel || m.channel === query.channel).map((m) => [m.code, m])).values()]
    const accounts = (options?.accounts ?? []).filter((a) => !query.channel || a.channelType === query.channel)
    // A store page's store (and market) is the page itself, not a filter: those two are not offered.
    const locked: readonly string[] = lockedKeys(query.lock)
    const dimensions: FilterDimension[] = [
      { key: 'channel', label: 'Channel', kind: 'select', value: query.channel, onChange: set('channel'),
        options: withCurrent([{ value: '', label: 'All channels' }, { value: 'SHARED', label: 'Shared product' }, ...channels.map((c) => ({ value: c, label: channelLabel(c) }))], query.channel) },
      { key: 'marketplace', label: 'Market', kind: 'select', value: query.marketplace, onChange: set('marketplace'),
        options: withCurrent([{ value: '', label: 'All markets' }, ...marketOptions.map((m) => ({ value: m.code, label: m.name }))], query.marketplace) },
      { key: 'accountId', label: 'Store', kind: 'select', value: query.accountId, onChange: set('accountId'),
        options: withCurrent([{ value: '', label: 'All stores' }, ...accounts.map((a) => ({ value: a.id, label: a.displayName }))], query.accountId) },
      { key: 'language', label: 'Language', kind: 'select', value: query.language, onChange: set('language'),
        options: withCurrent([{ value: '', label: 'All languages' }, ...languages.options], query.language) },
      { key: 'familyId', label: 'Product family', kind: 'select', value: query.familyId, onChange: set('familyId'),
        options: withCurrent([{ value: '', label: 'All families' }, ...(options?.families ?? []).map((f) => ({ value: f.id, label: f.label }))], query.familyId) },
      // What the channel shows: only when the answer carries it.
      ...(liveShown ? [
        { key: 'live', label: 'Channel state', kind: 'multiselect' as const, value: channelStatesOf(query),
          onChange: (values: string[]) => setQuery((q) => withChannelStates(q, values)),
          options: CHANNEL_STATE_OPTIONS.map((o) => ({ value: o.value, label: o.label })) },
        { key: 'stock', label: 'Stock', kind: 'select' as const, value: stockOf(query),
          onChange: (value: string) => setQuery((q) => withStock(q, value)),
          options: STOCK_OPTIONS.map((o) => ({ value: o.value, label: o.label })) },
      ] : []),
    ]
    return dimensions.filter((d) => !locked.includes(d.key))
  }, [query, options, languages.options, setQuery, liveShown])

  // ── Search (debounced, like Products) ─────────────────────────
  useEffect(() => {
    if (!searchDirty.current) return
    const timer = setTimeout(() => {
      searchDirty.current = false
      const value = searchDraft.trim()
      setQuery((q) => (q.q === value ? q : { ...q, q: value, page: 1 }))
    }, 300)
    return () => clearTimeout(timer)
  }, [searchDraft, setQuery])

  // ── One family's page: its name for the header and the chip ───
  const parent = query?.parent ?? ''
  const [family, setFamily] = useState<{ name: string | null; sku: string } | null>(null)
  useEffect(() => {
    if (!parent) { setFamily(null); return }
    const controller = new AbortController()
    void transferApi<{ name?: string | null; sku?: string }>(`products/${encodeURIComponent(parent)}`, undefined, controller.signal)
      .then((d) => { if (!controller.signal.aborted) setFamily({ name: d.name ?? null, sku: d.sku ?? '' }) })
      .catch(() => { /* the header falls back to the parent listing's own name, then to "Variation family" */ })
    return () => controller.abort()
  }, [parent])
  const parentRow = members?.rows.find((r) => r.isParentListing) ?? null
  const familyName = family?.name || family?.sku || parentRow?.name || parentRow?.sku || 'Variation family'

  // ── Saved views remember what AG state cannot hold ────────────
  const viewKey = query ? JSON.stringify(viewFiltersOf(query)) : ''
  const markDirty = gridViews.markDirty
  useEffect(() => { markDirty() }, [markDirty, density, query?.pageSize, viewKey])

  // ── Grid callbacks with stable identities ─────────────────────
  const getRowHeight = useCallback((p: { data?: ReadinessGridRow }) => (isReadinessFooter(p.data) ? gridGeometry.footerRowH : gridDensity[density].rowMedia), [density])
  const isFullWidthRow = useCallback((p: { rowNode: { data?: ReadinessGridRow } }) => isReadinessFooter(p.rowNode.data), [])
  const isServerSideGroup = useCallback((d: ReadinessGridRow) => !queryRef.current?.parent && canExpand(d), [])
  const getServerSideGroupKey = useCallback((d: ReadinessGridRow) => d.id, [])
  const getRowId = useCallback((p: { data: ReadinessGridRow; parentKeys?: string[] }) => readinessRowId(p.data, p.parentKeys), [])
  const bindViews = gridViews.bind
  const onGridReady = useCallback((e: GridReadyEvent<ReadinessGridRow>) => {
    gridApiRef.current = e.api
    setGridApi(e.api)
    bindViews(e.api)
    boundRef.current = true
  }, [bindViews])
  const onPaginationChanged = useCallback((e: { api: GridApi<ReadinessGridRow> }) => {
    const pageCount = Math.max(1, e.api.paginationGetTotalPages())
    const wanted = initialPageRef.current
    if (wanted && topLoadedRef.current) {
      initialPageRef.current = null
      if (wanted <= pageCount && wanted !== e.api.paginationGetCurrentPage() + 1) { e.api.paginationGoToPage(wanted - 1); return }
    }
    setPager({ page: e.api.paginationGetCurrentPage() + 1, pageCount })
  }, [])
  const onPage = useCallback((n: number) => gridApiRef.current?.paginationGoToPage(n - 1), [])
  const onPageSize = useCallback((n: number) => { if (isPageSize(n)) setQuery((q) => ({ ...q, pageSize: n, page: 1 })) }, [setQuery])

  // ── Customise: the DS dialog over AG's column state ───────────
  const columns = useMemo(() => columnSetup(liveShown), [liveShown])
  const [prefsOpen, setPrefsOpen] = useState(false)
  const [prefs, setPrefs] = useState<PreferencesValue>(() => columnSetup(liveAtMount).defaults)
  const openCustomise = useCallback(() => {
    const api = gridApiRef.current
    if (!api || api.isDestroyed()) return
    setPrefs((current) => columnStateToPrefs(api.getColumnState(), current, columns.bridge))
    setPrefsOpen(true)
  }, [columns])
  const applyPrefs = useCallback((next: PreferencesValue) => {
    const api = gridApiRef.current
    if (!api || api.isDestroyed()) return
    api.applyColumnState({ state: prefsToColumnState(next, columns.bridge), applyOrder: true })
    setPrefs(next)
  }, [columns])
  const resetColumns = useCallback(() => {
    gridApiRef.current?.resetColumnState()
    setPrefs(columns.defaults)
  }, [columns])
  const columnDialog = useMemo(() => ({ customise: openCustomise, reset: resetColumns }), [openCustomise, resetColumns])

  // ── Tiles ─────────────────────────────────────────────────────
  const state = query?.state ?? ''
  const metrics = useMemo<Metric[]>(
    () =>
      visibleTiles(families?.stats ?? null, state).map((tile) => ({
        label: tileLabel(tile),
        value: families ? tileCount(families.stats, tile).toLocaleString('en') : '—',
        hint: tileHint(tile),
        accent: tileAccent(tile),
        active: tileIsLit(state, tile),
        onClick: () => setQuery((q) => ({ ...q, state: stateForTile(q.state, tile), page: 1 })),
      })),
    [families, state, setQuery],
  )
  // The live tiles count listings ON THE CHANNEL, so each says its unit; a click toggles the live filter.
  const liveStats = families?.liveStats ?? null
  const liveFilters = useMemo(() => ({ live: query?.live ?? [], flags: query?.flags ?? [] }), [query?.live, query?.flags])
  const liveMetrics = useMemo<Metric[]>(
    () =>
      liveStats
        ? LIVE_TILES.map((tile) => ({
          label: liveTileLabel(tile),
          value: liveTileCount(liveStats, tile).toLocaleString('en'),
          hint: LIVE_TILE_HINT,
          accent: liveTileAccent(tile),
          active: liveTileIsLit(liveFilters, tile),
          onClick: () => setQuery((q) => withLiveTile(q, tile)),
        }))
        : [],
    [liveStats, liveFilters, setQuery],
  )

  // ── Translate ─────────────────────────────────────────────────
  const [translateOpen, setTranslateOpen] = useState(false)
  const translate = query ? translateScope(query) : null
  const translateHeld = !translate ? 'Loading…' : !translate.ok ? translate.reason : families && families.total === 0 ? 'No products match these filters.' : null

  // ── Amazon: listings Amazon suppressed, from the old Amazon page — only while the answer has no live data (an older
  //    API, no `listings.view`). With live data the Suppressed tile says it, and this 30-second call is not made. ──
  const amazonUrl = lock?.channel === 'AMAZON' && top !== null && !liveShown
    ? `/api/listings/amazon/overview${lock.marketplace ? `?marketplace=${lock.marketplace}` : ''}`
    : null
  const { data: amazon } = usePolledList<AmazonSuppressions>({
    url: amazonUrl,
    intervalMs: LIVE_INTERVAL_MS,
    invalidationTypes: ['listing.updated', 'listing.created', 'listing.deleted'],
  })
  const suppressed = amazon ? suppressedListings(amazon.activeSuppressions) : null

  const words = scopeWords(lock)
  if (!query) {
    return (
      <div className={styles.wrap}>
        <PageHeader eyebrow={words.crumbs.length ? <ScopeCrumbs crumbs={words.crumbs} /> : undefined} title={words.title} subtitle="Loading…" />
      </div>
    )
  }

  const subtitle = query.parent
    ? members
      ? `${plural(members.variantCount, 'variation')}${family?.sku ? ` of ${family.sku}` : ''} · listing readiness`
      : words.title
    : families
      ? `${lockedKeys(lock).includes('marketplace') ? plural(families.listingCount, 'listing') : `${plural(families.listingCount, 'listing')} on ${plural(marketCount(families.destinations), 'market')}`}${checkedWords(families.checked, now)}`
      : '— listings'
  const count = query.parent ? (
    // Rows, as on the top level: the parent's own listing and its variations are all products.
    <><b>{members ? members.total.toLocaleString('en') : '—'}</b> {members?.total === 1 ? 'product' : 'products'}</>
  ) : (
    <>
      <b>{families ? families.total.toLocaleString('en') : '—'}</b> {families?.total === 1 ? 'product' : 'products'}
      {' · '}
      <b>{families ? listingsInView(families.stats, query.state).toLocaleString('en') : '—'}</b> listings
    </>
  )
  const notFound = query.parent ? null : notFoundWords(families?.search)
  const stateChip = query.parent && query.state ? (query.state === 'notChecked' ? 'Not set up or not computed' : readinessMeta(query.state, 'scope').label) : null
  // One family's page on a store page: the store page is one more crumb (on /listings the chip below is the way back).
  const crumbs = query.parent && lock ? [...words.crumbs, { label: words.title, href: readinessPath(lock) }] : words.crumbs

  return (
    <div className={styles.wrap}>
      <PageHeader
        // No eyebrow on /listings: the DS header aligns differently with one.
        eyebrow={crumbs.length ? <ScopeCrumbs crumbs={crumbs} /> : undefined}
        title={query.parent ? familyName : words.title}
        subtitle={subtitle}
        actions={
          <div className={styles.acts}>
            <Button size="sm" heldReason={translateHeld} onClick={() => setTranslateOpen(true)}>
              Translate filtered products…
            </Button>
            <Button asChild size="sm">
              <Link href="/listings/publish-status">
                <History size={13} /> Publish history
              </Link>
            </Button>
            {/* The old page keeps the jobs this one does not do (live status, prices, stock, bulk edits); a store
                page's old page is that store's (`/listings/legacy/amazon/it`). */}
            <Button asChild size="sm">
              <Link href={legacyPath(lock)}>
                <Archive size={13} /> {lock ? `Legacy ${storeWord(lock.channel)} listings` : 'Legacy listings'}
              </Link>
            </Button>
            {lock?.channel === 'EBAY' && (
              <Menu
                align="right"
                label={<>eBay tools <ChevronDown size={13} aria-hidden /></>}
                items={ebayTools(lock)}
                triggerProps={{ className: 'nds-btn sm' }}
              />
            )}
          </div>
        }
      />

      {/* One family's page reads its members only; the tiles count the whole result, so they stand aside here. */}
      {!query.parent && <MetricStrip metrics={metrics} className={styles.kpis} />}
      {/* The second group: what is on the channel. Its own strip, so the two units never share a row. */}
      {!query.parent && liveMetrics.length > 0 && <MetricStrip metrics={liveMetrics} className={styles.kpis} />}

      {/* Without live data, readiness cannot see what Amazon suppressed; the old Amazon page lists it, one market at a time. */}
      {lock?.channel === 'AMAZON' && !liveShown && suppressed && suppressed.count > 0 && (
        <Banner
          tone="danger"
          className={styles.banner}
          title={`Amazon reports ${suppressed.more ? 'at least ' : ''}${plural(suppressed.count, 'suppressed listing')}${lock.marketplace ? ` on ${words.title}` : ''}.`}
          action={
            lock.marketplace ? (
              <Button asChild size="sm">
                <Link href={legacyPath(lock)}>Fix them on the legacy Amazon page</Link>
              </Button>
            ) : undefined
          }
        >
          Amazon hides a suppressed listing, so nobody can buy it.
          {!lock.marketplace && (
            <>
              {' '}Fix them on the legacy Amazon page:{' '}
              {suppressed.markets.map((m, i) => (
                <span key={m.code}>
                  {i > 0 && ' · '}
                  <Link className={styles.bannerLink} href={legacyMarketHref('AMAZON', m.code)}>{marketWord(m.code)} ({m.count.toLocaleString('en')})</Link>
                </span>
              ))}
            </>
          )}
        </Banner>
      )}

      {(optionsError || languages.error) && (
        <Banner tone="warning" className={styles.banner}>
          The filter lists could not load: {optionsError || languages.error}
        </Banner>
      )}

      <div className={styles.filterBar}>
        <FilterBar dimensions={filterDimensions} activeCount={activeFilterCount(query)} onClear={() => setQuery(withoutFilters)} />
      </div>

      {(query.selector || query.parent) && (
        <div className={styles.scope} role="group" aria-label="This page shows only">
          {query.selector && (
            <TokenChip
              onRemove={() => setQuery((q) => ({ ...q, selector: null, page: 1 }))}
              removeLabel={`Show every product, not only ${selectorChipText(query.selector)}`}
            >
              {selectorChipText(query.selector)}
            </TokenChip>
          )}
          {query.parent && (
            <TokenChip onRemove={() => setQuery((q) => ({ ...q, parent: '', page: 1 }))} removeLabel={`Show every family, not only ${familyName}`}>
              {familyName}
            </TokenChip>
          )}
          {stateChip && (
            <TokenChip onRemove={() => setQuery((q) => ({ ...q, state: '', page: 1 }))} removeLabel={`Show every state, not only ${stateChip}`}>
              {stateChip}
            </TokenChip>
          )}
        </div>
      )}

      {/* Pasted terms that matched nothing ("3 of 40 not found: …"). */}
      {notFound && <Banner tone="warning" className={styles.banner}>{notFound}</Banner>}

      {/* One card: toolbar + grid + pager. The grid is as tall as its page of rows and the PAGE scrolls (Products). */}
      <div ref={cardRef} className="nds-gridcard nds-grid-card">
        <GridToolbar
          count={count}
          right={
            <>
              <GridDensityToggle value={density} onChange={setDensity} />
              <Button size="sm" onClick={openCustomise} heldReason={gridApi ? null : 'The grid is still loading.'}>
                <SlidersHorizontal size={13} /> Customise
              </Button>
              <GridViewsMenu views={gridViews} />
              <Pill tone={listError ? 'danger' : 'success'} dot size="md">
                {listError ? 'Not updating' : updating ? 'Updating…' : 'Up to date'}
              </Pill>
            </>
          }
        >
          <GridSearchSlot>
            <Input
              leadingIcon={<Search size={13} style={{ color: 'var(--nds-text-3)' }} />}
              // With the live layer the search also finds channel ids, and many SKUs pasted at once.
              placeholder={liveShown ? 'Search SKU, name, ASIN, Item ID…' : 'Search SKU or name…'}
              aria-label={liveShown ? 'Search SKU, name, ASIN or Item ID' : 'Search SKU or name'}
              value={searchDraft}
              onChange={(e) => { searchDirty.current = true; setSearchDraft(e.target.value) }}
              style={{ width: '100%' }}
            />
          </GridSearchSlot>
        </GridToolbar>

        {/* The grid, the DS Thumbnail and the cells follow this one density. */}
        <GridDensityProvider value={density}>
          {listError ? (
            // A failed read is not an empty result and not a slow one.
            <EmptyState
              icon={<AlertTriangle size={20} />}
              title="Couldn’t load the listings"
              description={listError}
              action={<Button size="sm" variant="secondary" onClick={() => refreshGrid(REFRESH_ALL)}>Try again</Button>}
            />
          ) : (
            <>
              <NexusGrid<ReadinessGridRow>
                domLayout="autoHeight"
                density={density}
                rows="media"
                getRowHeight={getRowHeight}
                isFullWidthRow={isFullWidthRow}
                fullWidthCellRenderer={ReadinessFamilyFooter}
                pagination
                paginationPageSize={query.pageSize}
                // The footer below is the page-size control; AG's own selector is off.
                paginationPageSizeSelector={false}
                suppressPaginationPanel
                onPaginationChanged={onPaginationChanged}
                rowModelType="serverSide"
                serverSideDatasource={datasource}
                // One AG block is one API page (50 / 100 / 200).
                cacheBlockSize={query.pageSize}
                getRowId={getRowId}
                onGridReady={onGridReady}
                treeData
                flatTree
                isServerSideGroup={isServerSideGroup}
                getServerSideGroupKey={getServerSideGroupKey}
                maintainColumnOrder
                autoGroupColumnDef={autoGroupColumnDef}
                columnDefs={columnDefs}
                columnDialog={columnDialog}
                context={cellContext}
                initialState={initialState}
                overlayNoRowsTemplate={NO_ROWS_TEMPLATE}
              />
              <GridPager
                page={pager.page}
                pageCount={pager.pageCount}
                pageSize={query.pageSize}
                pageSizes={READINESS_PAGE_SIZES}
                onPage={onPage}
                onPageSize={onPageSize}
              />
            </>
          )}
        </GridDensityProvider>
      </div>

      <p className={styles.note}>
        {liveShown
          ? 'Readiness reflects saved information. On the channel is what Nexus last sent to or read from each channel, not a fresh read. Publishing runs its own checks before anything is sent.'
          : 'Readiness reflects saved information. Publishing runs its own checks before anything is sent.'}
      </p>

      {prefsOpen && (
        <PreferencesModal
          open={prefsOpen}
          onClose={() => setPrefsOpen(false)}
          title="Customise columns"
          value={prefs}
          onConfirm={applyPrefs}
          allColumns={columns.specs}
          defaultVisible={columns.defaults.visibleColumns}
          pageSizeChoices={NO_CHOICES}
          sortFieldOptions={NO_SORT_OPTIONS}
          showSticky={false}
        />
      )}

      {fix && (
        <ReadinessFixDialog
          open
          // The window only reads; a fix saved elsewhere arrives as a live event. Closing returns the focus to the chip.
          onClose={() => setFix(null)}
          productId={fix.productId}
          family={fix.family}
          destinationKey={fix.destinationKey}
          destinations={fix.destinations}
          query={apiFilterParams(query)}
          productName={fix.productName}
        />
      )}

      {translate?.ok && (
        <TranslateDialog open={translateOpen} onClose={() => setTranslateOpen(false)} language={query.language} scope={{ kind: 'readiness', query: translate.query }} />
      )}
    </div>
  )
}

/**
 * The DS ToastProvider for this subtree (the views menu reports through it), as on Products. `lock`: a store page's
 * store and market (`readinessScope.ts`); none on `/listings`.
 */
export function ListingReadinessClient({ lock = null }: { lock?: ReadinessLock | null }) {
  return (
    <ToastProvider>
      <ListingReadinessInner lock={lock} />
    </ToastProvider>
  )
}
