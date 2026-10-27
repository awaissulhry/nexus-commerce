'use client'

/**
 * Reviews › Insights › Products (`/marketing/reviews/insights/products`, build spec §3.4, the Products board): how each
 * product is rated, what buyers complain about and how often it comes back, per family.
 *
 *   Header   the shared Insights header: channel and market, period (both in the address)
 *   Tiles    products with reviews · Below 4 stars (filter) · Rating dropped (filter) · top return reason
 *   Filters  family, top complaint, rating range, has an open alert (+ the search); each adds a removable chip
 *   Grid     families with their sizes and colours (`GET /api/reviews/insights/products`, one API page = one grid page):
 *            the chevron or → / ← opens a family, Expand all / Collapse all; a header click sorts on the server; density,
 *            Customise, saved Views; the live status
 *   Pop-up   a product's name opens ProductReviewsModal over the page (`?product=<id>`; K / J walk the page's products)
 * Everything is in the address; the list re-reads every 60 s and when this or another tab changes a review or an alert.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { ChevronsDownUp, ChevronsUpDown, Search, SlidersHorizontal } from 'lucide-react'
import { Banner, MetricStrip, ToastProvider, type Metric } from '@/design-system/components'
import {
  GridCard,
  GridDensityProvider,
  GridDensityToggle,
  GridLoadingOverlay,
  GridNoRowsOverlay,
  GridPager,
  GridSearchSlot,
  GridViewsMenu,
  NexusGrid,
  useGridState,
  type ColDef,
  type GridApi,
  type GridReadyEvent,
  type GridState,
  type GridStateKey,
  type NexusGridProps,
} from '@/design-system/grid'
import { FilterBar, GridToolbar, type FilterDimension } from '@/design-system/patterns'
import { Button, Input, Pill, TokenChip } from '@/design-system/primitives'
import { useAuth } from '@/lib/auth/AuthProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { THEME_LABEL } from '../../_lib/reviewWords'
import { insightsHref } from '../../_lib/reviewsLinks'
import { useGridCustomise } from '../../requests/gridCustomise'
import { InsightsHeader } from '../_shared/InsightsHeader'
import { periodWords } from '../_shared/insightsScope'
import { useAddressSync, useInsightsRead, useInsightsScope, useScopeChoices } from '../_shared/useInsights'
import { navIds } from './productModalModel'
import { ProductReviewsModal } from './ProductReviewsModal'
import {
  PRODUCT_COLUMNS,
  PRODUCT_COLUMN_SPECS,
  PRODUCT_TREE_COLUMN,
  gridRows,
  type ProductGridRow,
  type ProductsAnswer,
  type ProductsGridContext,
} from './productsColumns'
import {
  PRODUCTS_PAGE_SIZES,
  SORT_OF_COLUMN,
  activeFilterCount,
  clearFilters,
  cleanRating,
  columnOfSort,
  effectiveDir,
  nextQuery,
  parseProductsQuery,
  productChips,
  productsAddressParams,
  productsApiParams,
  toggleTile,
  withSort,
  withoutChip,
  type ProductsQuery,
} from './productsQuery'
import shared from '../_shared/insights.module.css'

const SEARCH_MS = 300
const EVENTS = ['review.updated', 'review.imported', 'review.alert.changed'] as const
const PERSIST_KEYS: readonly GridStateKey[] = ['columnSizing', 'columnOrder', 'columnVisibility']
const LOADING_PARAMS = { rows: 8 }
const ROW_ID: NonNullable<NexusGridProps<ProductGridRow>['getRowId']> = (p) => p.data.rowId
const DATA_PATH = (d: ProductGridRow) => d.path
const THEME_OPTIONS = [{ value: '', label: 'All' }, ...Object.entries(THEME_LABEL).filter(([k]) => k !== 'OTHER').map(([value, label]) => ({ value, label }))]

type Density = ComponentProps<typeof GridDensityToggle>['value']
interface ProductsViewState { density: Density; pageSize: number }

/** → opens a closed family, ← closes an open one (the tree column only); every other key is AG's. */
const treeKeys: NonNullable<ColDef<ProductGridRow>['suppressKeyboardEvent']> = (params) => {
  const { event, node, data } = params
  if (!data || data.level !== 0 || data.variantCount === 0 || event.type !== 'keydown') return false
  if (event.key === 'ArrowRight' && !node.expanded) {
    node.setExpanded(true)
    return true
  }
  if (event.key === 'ArrowLeft' && node.expanded) {
    node.setExpanded(false)
    return true
  }
  return false
}

const TREE_COLUMN: ColDef<ProductGridRow> = { ...PRODUCT_TREE_COLUMN, suppressKeyboardEvent: treeKeys }
const HIDDEN_AT_FIRST = PRODUCT_COLUMN_SPECS.filter((c) => c.hidden).map((c) => c.key)

export function ProductsClient() {
  return (
    <ToastProvider>
      <Products />
    </ToastProvider>
  )
}

function Products() {
  const { status, has } = useAuth()
  // Until the session is known nothing is held: the API checks the permission on every write.
  const canManage = status !== 'authed' || has('reviews.manage')
  const { scope, initial, setScope } = useInsightsScope()

  // ── The address: read once, written back on every change ──
  const [query, setQueryState] = useState<ProductsQuery | null>(null)
  const [firstQuery, setFirstQuery] = useState<ProductsQuery | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [searchDraft, setSearchDraft] = useState('')
  useEffect(() => {
    if (!initial) return
    const parsed = parseProductsQuery(initial)
    setQueryState(parsed.query)
    setFirstQuery(parsed.query)
    setOpenId(parsed.product)
    setSearchDraft(parsed.query.q)
  }, [initial])
  const setQuery = useCallback((update: (q: ProductsQuery) => ProductsQuery) => setQueryState((q) => (q ? update(q) : q)), [])
  useAddressSync(query ? scope : null, query ? productsAddressParams(query, openId) : {})
  useEffect(() => {
    if (!query || searchDraft.trim() === query.q) return
    const id = window.setTimeout(() => setQuery((q) => nextQuery(q, { q: searchDraft.trim() })), SEARCH_MS)
    return () => window.clearTimeout(id)
  }, [searchDraft, query, setQuery])

  // A new scope starts again from page 1.
  const scopeKey = scope ? `${scope.channel}|${scope.market}|${scope.period}` : ''
  const lastScope = useRef(scopeKey)
  useEffect(() => {
    if (lastScope.current === scopeKey) return
    const first = lastScope.current === ''
    lastScope.current = scopeKey
    if (!first) setQuery((q) => nextQuery(q, {}))
  }, [scopeKey, setQuery])

  const read = useInsightsRead<ProductsAnswer>(scope && query ? '/reviews/insights/products' : null, scope && query ? productsApiParams(scope, query) : {}, [...EVENTS], { keep: scopeKey || null })
  const choices = useScopeChoices(scope?.period ?? null)
  const data = read.data

  // Family names, kept as they are seen (the family filter's choices outlive one filtered answer).
  const [families, setFamilies] = useState<Map<string, string>>(new Map())
  useEffect(() => {
    if (!data) return
    setFamilies((prev) => {
      let changed = false
      const next = new Map(prev)
      for (const f of data.families) if (f.variants.length && next.get(f.familyId) !== f.name) { next.set(f.familyId, f.name); changed = true }
      return changed ? next : prev
    })
  }, [data])

  // ── Grid ──
  const rows = useMemo(() => gridRows(data?.families ?? []), [data])
  const ids = useMemo(() => navIds(data?.families ?? []), [data])
  const [density, setDensity] = useState<Density>('cozy')
  const [allOpen, setAllOpen] = useState(false)
  const apiRef = useRef<GridApi<ProductGridRow> | null>(null)
  const customise = useGridCustomise(apiRef, PRODUCT_COLUMN_SPECS)
  const queryRef = useRef(query)
  queryRef.current = query
  const gridState = useGridState<ProductsViewState>({
    surface: 'reviews-insights-products',
    baseUrl: getBackendUrl(),
    persistKeys: PERSIST_KEYS,
    getPageState: () => ({ density, pageSize: queryRef.current?.pageSize ?? 50 }),
    applyPageState: (page) => {
      if (!page) return
      if (page.density) setDensity(page.density)
      if ((PRODUCTS_PAGE_SIZES as readonly number[]).includes(page.pageSize)) setQuery((q) => nextQuery(q, { pageSize: page.pageSize }))
    },
  })
  const markDirty = gridState.markDirty
  useEffect(() => { markDirty() }, [markDirty, density, query?.pageSize])
  const bindState = useRef(gridState.bind)
  bindState.current = gridState.bind
  const onGridReady = useCallback((e: GridReadyEvent<ProductGridRow>) => {
    apiRef.current = e.api
    bindState.current(e.api)
  }, [])
  const initialState = useMemo<GridState | undefined>(() => {
    if (!firstQuery) return undefined
    // A saved state names its own columns; a first visit starts with Open alert hidden (Customise brings it back): AG
    // reads a state without `columnVisibility` as "nothing hidden".
    const saved = gridState.initialState
    const columns = saved ? { columnVisibility: saved.columnVisibility ?? { hiddenColIds: [] } } : { columnVisibility: { hiddenColIds: HIDDEN_AT_FIRST } }
    return { ...columns, ...(saved ?? {}), sort: { sortModel: [{ colId: columnOfSort(firstQuery.sort), sort: effectiveDir(firstQuery) }] } } as GridState
    // Read once, when the grid first mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstQuery])
  const onSortChanged = useCallback((e: { api: GridApi<ProductGridRow> }) => {
    const col = (e.api.getColumnState() ?? []).find((c) => c.sort)
    const sort = col ? SORT_OF_COLUMN[col.colId] : undefined
    if (!sort) return setQuery((q) => (q.sort === 'reviews' && q.dir == null ? q : withSort(q, 'reviews', null)))
    const dir = col?.sort === 'asc' ? 'asc' : 'desc'
    // The sort the page already shows (the grid applying the address's own sort) changes nothing; the API's default
    // direction for a sort leaves the address.
    setQuery((q) => {
      if (q.sort === sort && effectiveDir(q) === dir) return q
      return withSort(q, sort, dir === effectiveDir({ sort, dir: null }) ? null : dir)
    })
  }, [setQuery])

  const context = useRef<ProductsGridContext>({ open: () => {}, hrefOf: () => '' })
  context.current = {
    open: (id) => setOpenId(id),
    hrefOf: (id) => insightsHref('products', { channel: scope?.channel, market: scope?.market, period: scope?.period, product: id }),
  }
  const toggleAll = useCallback(() => {
    const api = apiRef.current
    if (!api) return
    if (allOpen) api.collapseAll()
    else api.expandAll()
    setAllOpen(!allOpen)
  }, [allOpen])

  // ── Tiles, filters, chips ──
  const familyName = useCallback((id: string) => families.get(id) ?? null, [families])
  const dimensions = useMemo<FilterDimension[]>(() => {
    if (!query) return []
    const familyOptions = [{ value: '', label: 'All' }, ...[...families.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label))]
    return [
      { key: 'family', label: 'Family', kind: 'select', options: familyOptions, value: query.family ?? '', onChange: (v) => setQuery((q) => nextQuery(q, { family: v || null })) },
      { key: 'theme', label: 'Top complaint', kind: 'select', options: THEME_OPTIONS, value: query.theme ?? '', onChange: (v) => setQuery((q) => nextQuery(q, { theme: v || null })) },
      { key: 'rating', label: 'Rating (stars)', kind: 'range', min: query.minRating, max: query.maxRating, unit: '', onChange: (min, max) => setQuery((q) => nextQuery(q, { minRating: cleanRating(min), maxRating: cleanRating(max) })) },
      { key: 'openAlert', label: 'Has an open alert', kind: 'toggle', value: query.openAlert, onChange: (v) => setQuery((q) => nextQuery(q, { openAlert: v })) },
    ]
  }, [query, families, setQuery])
  const chips = query ? productChips(query, familyName) : []

  const tiles = data?.tiles
  const metrics: Metric[] = tiles && query
    ? [
        { label: 'Products with reviews', value: tiles.productsWithReviews.toLocaleString('en-IE'), hint: `in ${tiles.families} ${tiles.families === 1 ? 'family' : 'families'}` },
        { label: 'Below 4 stars', value: String(tiles.below4), hint: 'on at least one market', accent: 'var(--nds-danger)', onClick: () => setQuery((q) => toggleTile(q, 'below4')), active: query.tile === 'below4' },
        { label: 'Rating dropped', value: String(tiles.dropped), hint: `by 0.3 or more against ${periodWords(scope?.period ?? '30d').before}`, accent: 'var(--nds-warning)', onClick: () => setQuery((q) => toggleTile(q, 'dropped')), active: query.tile === 'dropped' },
        {
          label: 'Top return reason',
          value: tiles.topReturnReason?.reason ?? 'None',
          hint: tiles.topReturnReason ? `${tiles.topReturnReason.share}% of returns${tiles.topReturnReason.product ? ` · ${tiles.topReturnReason.product.name}` : ''}` : 'no return gave a reason, last 30 days',
        },
      ]
    : []

  const pageCount = data && query ? Math.max(1, Math.ceil(data.total.families / query.pageSize)) : 1
  const filtered = !!query && (chips.length > 0)
  const noRows = useMemo(() => (filtered
    ? { title: 'No products match these filters', message: 'Remove a chip, or Clear the filters.' }
    : { title: 'No product has reviews in this period', message: 'Pick a longer period, or every channel and market.' }), [filtered])
  const subtitle = !scope || read.loading
    ? 'Loading…'
    : data ? `What buyers say about your products · ${data.total.products.toLocaleString('en-IE')} products in ${data.total.families.toLocaleString('en-IE')} ${data.total.families === 1 ? 'family' : 'families'} · ${periodWords(scope.period).label}` : 'What buyers say about your products'
  const pill = read.error ? { tone: 'danger' as const, words: 'Not updating' } : read.updating ? { tone: 'info' as const, words: 'Updating…' } : { tone: 'success' as const, words: 'Up to date' }

  return (
    <div className={shared.page}>
      <InsightsHeader scope={scope} onScope={setScope} subtitle={subtitle} choices={choices.data?.options ?? []} />

      {metrics.length > 0 && <MetricStrip metrics={metrics} minTileWidth={150} />}

      <FilterBar
        dimensions={dimensions}
        activeCount={query ? activeFilterCount(query) : 0}
        onClear={() => { setQuery(clearFilters); setSearchDraft('') }}
      />

      {chips.length > 0 && (
        <div className={shared.chips} role="group" aria-label="This page shows only">
          {chips.map((chip) => (
            <TokenChip key={chip.key} removeLabel={chip.removeLabel} onRemove={() => { setQuery((q) => withoutChip(q, chip.key)); if (chip.key === 'q') setSearchDraft('') }}>
              {chip.label}
            </TokenChip>
          ))}
        </div>
      )}

      {read.error && !data ? (
        <Banner tone="danger" title="Couldn’t read the products" action={<Button size="sm" onClick={read.reload}>Try again</Button>}>
          {read.error} This is not an empty list.
        </Banner>
      ) : (
        <GridCard
          toolbar={(
            <GridToolbar
              count={data ? <><b>{data.total.families.toLocaleString('en-IE')}</b> {data.total.families === 1 ? 'family' : 'families'} · {data.total.products.toLocaleString('en-IE')} products</> : 'Reading…'}
              right={(
                <>
                  <Button size="sm" onClick={toggleAll} aria-pressed={allOpen}>
                    {allOpen ? <ChevronsDownUp size={13} aria-hidden /> : <ChevronsUpDown size={13} aria-hidden />} {allOpen ? 'Collapse all' : 'Expand all'}
                  </Button>
                  <GridDensityToggle value={density} onChange={setDensity} />
                  <Button size="sm" onClick={customise.openCustomise}><SlidersHorizontal size={13} aria-hidden /> Customise</Button>
                  <GridViewsMenu views={gridState} />
                  <Pill tone={pill.tone} dot size="md">{pill.words}</Pill>
                </>
              )}
            >
              <GridSearchSlot>
                <Input
                  leadingIcon={<Search size={13} aria-hidden />}
                  placeholder="Search product, SKU, colour…"
                  aria-label="Search product, SKU or colour"
                  value={searchDraft}
                  onChange={(e) => setSearchDraft(e.target.value)}
                  style={{ width: '100%' }}
                />
              </GridSearchSlot>
            </GridToolbar>
          )}
          footer={data && query ? (
            <GridPager
              page={query.page}
              pageCount={pageCount}
              pageSize={query.pageSize}
              pageSizes={PRODUCTS_PAGE_SIZES}
              onPage={(n) => setQuery((q) => nextQuery(q, { page: n }))}
              onPageSize={(n) => setQuery((q) => nextQuery(q, { pageSize: n }))}
              left={<span className={shared.muted}>Showing {data.total.families.toLocaleString('en-IE')} families · {data.total.products.toLocaleString('en-IE')} products</span>}
            />
          ) : undefined}
        >
          <GridDensityProvider value={density}>
            {firstQuery && (
              <NexusGrid<ProductGridRow>
                domLayout="autoHeight"
                density={density}
                suppressCellFocus={false}
                flatTree
                treeData
                getDataPath={DATA_PATH}
                groupDefaultExpanded={allOpen ? -1 : 0}
                autoGroupColumnDef={TREE_COLUMN}
                rowData={rows}
                getRowId={ROW_ID}
                columnDefs={PRODUCT_COLUMNS}
                context={context}
                initialState={initialState}
                columnDialog={customise.columnDialog}
                loading={read.loading}
                loadingOverlayComponent={GridLoadingOverlay}
                loadingOverlayComponentParams={LOADING_PARAMS}
                noRowsOverlayComponent={GridNoRowsOverlay}
                noRowsOverlayComponentParams={noRows}
                onGridReady={onGridReady}
                onSortChanged={onSortChanged}
              />
            )}
          </GridDensityProvider>
        </GridCard>
      )}
      {read.error && data && <p className={shared.muted} role="status">Not updating: {read.error}</p>}

      <p className={shared.footnote}>
        Ratings mix every channel and market; open a product to see each one. Amazon stars come only from reviews you imported: Amazon gives
        no rating by API. Return rate = returns with a reason, over orders, last 30 days; Amazon returns arrive with a delay of about 2 days.
        eBay feedback counts as 5, 3 or 1 star.
      </p>

      {openId && scope && (
        <ProductReviewsModal
          productId={openId}
          ids={ids.includes(openId) ? ids : [openId]}
          scope={scope}
          canManage={canManage}
          onGo={setOpenId}
          onClose={() => setOpenId(null)}
        />
      )}
      {customise.modal}
    </div>
  )
}
