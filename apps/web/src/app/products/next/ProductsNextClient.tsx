'use client'

// No design-system stylesheet imports here on purpose. The root layout (app/layout.tsx)
// loads tokens-global -> primitives -> components -> patterns -> a11y for the whole app, in
// that exact cascade order. This page used to re-import `tokens.css`, which additionally
// republishes the eleven platform aliases (--text-*, --surface-*, --border-*) at :root for as
// long as the page is mounted — the same names app/globals.css defines as Tailwind RGB
// channels. Nothing here needs them any more: this page's CSS is entirely on `--nds-*`.

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, ArrowLeft, Copy, Download, MoreHorizontal, Plus, Search, Send, SlidersHorizontal, Tag as TagIcon, Trash2, Upload } from 'lucide-react'

import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation, useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import type { ProductRow, Tag as ProductTag } from '@/app/products/_types'
import { DensityContext } from '@/app/_shared/grid-lens'

import { Button, Input, Pill, SegmentedControl } from '@/design-system/primitives'
import { Banner, EmptyState, Listbox, Menu, MetricStrip, Modal, Pagination, ToastProvider, type MenuItemDef, type Metric, useToast } from '@/design-system/components'
import { FilterBar, GridToolbar, PageHeader, PreferencesModal, type FilterDimension, type PreferencesValue } from '@/design-system/patterns'
import { eur0 } from '@/design-system/lib'

// The grid. One engine (AG Grid Enterprise, Server-Side Row Model), and the four things this
// product owns around it: the theme and defaults (NexusGrid), the server contract
// (productsServerContract), the Customise bridge (columnPrefs) and state persistence
// (useGridViews). Nothing else.
import { NexusGrid, type ColDef, type GridApi, type GridReadyEvent, type GridState } from '@/design-system/patterns/workspace-grid/engine/NexusGrid'
import { createProductsDatasource, isFamilyFooter, type ProductsListStats } from '@/design-system/patterns/workspace-grid/engine/productsDatasource'
import { gridFilterDef } from '@/design-system/patterns/workspace-grid/engine/filters/gridFilters'
import {
  buildGridRequest,
  EMPTY_CONTEXT_FILTERS,
  GRID_FILTER_COLUMNS,
  type GridFilterModel,
  type GridFilterModelEntry,
  type ProductGridContextFilters,
} from '@/design-system/patterns/workspace-grid/engine/productsServerContract'
import { useGridViews } from '@/design-system/patterns/workspace-grid/engine/useGridViews'
import { AG_AUTO_COL, columnStateToPrefs, prefsToColumnState, type PrefsBridgeOptions } from '@/design-system/patterns/workspace-grid/engine/columnPrefs'

import styles from './styles.module.css'
import { buildPageColumns, columnLabel, isGroupRow, projectColDefs, CHANNEL_OPTS, SALES_WINDOW_DAYS, STATUS_OPTS } from './columns'
import { ProductTreeCell, type ProductTreeCellParams } from './ProductTreeCell'
import { useBulkActions } from './useBulkActions'
import { GridViewsMenu } from './GridViewsMenu'
import { FamilyFooter } from './FamilyFooter'
import { BulkEditModal, type BulkEditChanges } from './BulkEditModal'
import { TagDialog } from './TagDialog'
import { InventoryEditorModal } from './InventoryEditorModal'
import { ProductsSkeleton } from './ProductsSkeleton'
import { DEFAULT_DENSITY, DENSITY_OPTIONS, DENSITY_ROW_PX, GRID_SIZE, mapDensity, type DensityMode } from './density'

// ─────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────

/**
 * Columns that START padlocked in the Customise dialog: the identity column and the row actions.
 * Padlocked means not draggable and not removable — in the dialog and in the grid's header alike
 * — but the operator holds the key: unlock either and it moves or hides like any other column.
 */
const DEFAULT_LOCKED_COLUMNS: readonly string[] = ['product', 'actions']

/** Which page warning the operator has already read and closed. Holds the warning's VALUE. */
const WARNING_DISMISS_KEY = 'products-next:dismissed-warning'


/** One server block — the unit the datasource fetches, whatever page size the operator picks. */
const BLOCK_SIZE = 100
/** The family footer row: a single line with a small button, not a data-row-tall band. */
const FAMILY_FOOTER_PX = 48
/** Rows per page, set in the footer as on Ad Manager. */
const PAGE_SIZE_CHOICES = [50, 100, 200, 500]
const NO_ROWS_TEMPLATE = '<span style="color: var(--nds-text-muted)">No products match this filter.</span>'

/** Market names for publish-destination labels. */
const MARKET_NAMES: Record<string, string> = { IT: 'Italy', DE: 'Germany', FR: 'France', ES: 'Spain', UK: 'United Kingdom' }
/**
 * Publish destinations offered in the bulk "Publish" dialog. Active channels only
 * (Amazon · eBay · Shopify), matching the platform's channel scope.
 */
const PUBLISH_DESTINATIONS: Array<{ channel: string; marketplace: string; label: string }> = [
  ...['IT', 'DE', 'FR', 'ES'].map((m) => ({ channel: 'AMAZON', marketplace: m, label: `Amazon ${m} (${MARKET_NAMES[m] ?? m})` })),
  ...['IT', 'DE', 'FR', 'ES'].map((m) => ({ channel: 'EBAY', marketplace: m, label: `eBay ${m} (${MARKET_NAMES[m] ?? m})` })),
  { channel: 'SHOPIFY', marketplace: 'GLOBAL', label: 'Shopify' },
]

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

type KpiTileKey = 'active' | 'out-of-stock' | 'attention' | null

/**
 * The page's OWN filter state: the accordion dimensions that are not grid columns. Everything
 * column-backed — Product search, Status, Channels, Brand, Product type, Tags, Price, Available —
 * is an AG column filter and lives in the grid's `filterModel`.
 */
type ProductFilters = ProductGridContextFilters
const EMPTY_FILTERS: ProductFilters = EMPTY_CONTEXT_FILTERS

/** What a saved view stores BESIDE the grid state — the page's own knobs. */
interface PageViewState {
  filters: ProductFilters
  tile: KpiTileKey
  density: DensityMode
  /** Columns the operator padlocked in Customise: not removable, not draggable, until unlocked. */
  lockedColumns: string[]
  /** Rows per page, from the footer. Absent on views saved before it existed. */
  pageSize?: number
}

/** GET /api/products/facets — the subset this page reads. */
interface ServerFacets {
  productTypes: Array<{ value: string; count: number }>
  brands: Array<{ value: string; count: number }>
  families: Array<{ value: string; label: string; code: string | null; count: number }>
  workflowStages: Array<{ value: string; label: string; code: string | null; count: number }>
  hygiene: { total: number; missingPhotos: number; missingDescription: number; missingBrand: number; missingGtin: number }
}

/** The grid's selection, as the page reads it. The GRID owns it; this is a read. */
interface Selection {
  ids: string[]
  rows: ProductRow[]
}
const EMPTY_SELECTION: Selection = { ids: [], rows: [] }

/**
 * Walk the loaded nodes rather than trust `getSelectedNodes()`: under SSRM a header select-all is
 * recorded as a selection STATE, and the loaded nodes answer `isSelected()` correctly while the
 * convenience list lagged behind it (measured: 12 rows ticked, count still "14 products").
 */
function readSelection(api: GridApi<ProductRow>): Selection {
  const rows: ProductRow[] = []
  api.forEachNode((n) => { if (n.data && !isGroupRow(n.data) && !isFamilyFooter(n.data) && n.isSelected()) rows.push(n.data) })
  return { ids: rows.map((r) => r.id), rows }
}

/** A family parent: the row AG may expand to its variations. ONE predicate for the grid and the cell. */
const isFamilyParent = (d: ProductRow): boolean => d.isParent || (d.childCount ?? 0) > 0

// ─────────────────────────────────────────────────────────────────
// Inner component (uses DS toast context)
// ─────────────────────────────────────────────────────────────────

function ProductsNextInner() {
  const { toast } = useToast()
  const router = useRouter()

  // The family scope. Null on the normal catalogue view. `?parent=<id>` scopes the whole page to
  // ONE variation family — the same grid, the same columns, the same filters, showing only that
  // parent's variants; the endpoint scopes its `stats` block to the query too.
  const searchParams = useSearchParams()
  const familyId = searchParams?.get('parent') ?? null

  // ── State ─────────────────────────────────────────────────────
  const [filters, setFilters] = useState<ProductFilters>(EMPTY_FILTERS)
  const [density, setDensity] = useState<DensityMode>(DEFAULT_DENSITY)
  const [activeTile, setActiveTile] = useState<KpiTileKey>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [modalRow, setModalRow] = useState<ProductRow | null>(null)
  const [bulkEditOpen, setBulkEditOpen] = useState(false)
  const [tagDialogOpen, setTagDialogOpen] = useState(false)
  const [publishOpen, setPublishOpen] = useState(false)
  const [publishTarget, setPublishTarget] = useState<string | null>(null)
  const [customizeOpen, setCustomizeOpen] = useState(false)

  // ── The grid's own state ───────────────────────────────────────
  // Sort, column order, widths, visibility, pinning, filters and selection all live IN the grid
  // (`api.getState()` snapshots them for a saved view). The page keeps only what the grid cannot
  // know: the accordion filters, the density, the clicked tile — and READS the rest.
  const [gridApi, setGridApi] = useState<GridApi<ProductRow> | null>(null)
  /** Mirror of AG's filter model, kept current by `onFilterChanged`; the accordion reads it. */
  const [filterModel, setFilterModelState] = useState<GridFilterModel>({})
  /** Mirror of AG's selection, kept current by `onSelectionChanged`; the toolbar reads it. */
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION)
  // What the last top-level block said about the whole result: the "of N" count and the KPI
  // stats. Null until a response lands — a count of zero for something never counted is a lie.
  const [listMeta, setListMeta] = useState<{
    total: number
    stats?: ProductsListStats
    salesUnattributed: Array<{ channel: string; orders: number; units: number; revenueCents: number }> | null
  } | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  // Things the request could not express (a tag with no id, a sort the server lacks). Shown,
  // never swallowed: a filter that silently stops filtering widens the result behind the
  // operator's back.
  const [unsupported, setUnsupported] = useState<string[]>([])
  // Operator locks from the Customise padlocks. They are not part of AG's column state, so they
  // live here and ride into the saved view with the other page knobs.
  const [lockedColumns, setLockedColumns] = useState<string[]>([...DEFAULT_LOCKED_COLUMNS])
  /**
   * Grouped is a VIEW MODE: AG's auto column is either the family tree or the group column, never
   * both. While a grouping is active the tree is off and families do not expand.
   */
  const [grouped, setGrouped] = useState(false)
  const [pageSize, setPageSize] = useState(BLOCK_SIZE)
  const [pager, setPager] = useState<{ page: number; pageCount: number }>({ page: 1, pageCount: 1 })

  // ── Saved views: ONE object, server-side, per operator ──────────
  const gridViews = useGridViews<PageViewState>({
    surface: 'products-next',
    getPageState: () => ({ filters, tile: activeTile, density, lockedColumns, pageSize }),
    applyPageState: (pg) => {
      setFilters(pg.filters)
      setActiveTile(pg.tile)
      setDensity(pg.density)
      setLockedColumns(pg.lockedColumns ?? [])
      if (pg.pageSize) setPageSize(pg.pageSize)
    },
  })
  const gridViewsBind = gridViews.bind

  // ── Data the page fetches itself ───────────────────────────────
  // The grid asks the server for blocks (see the datasource below). The page's own fetches are
  // the facets (accordion option lists, the "Needs attention" tile), the merchant's active
  // channels, the tag list, and — in family scope — the family's own row for the header.
  const [facets, setFacets] = useState<ServerFacets | null>(null)
  const refreshFacets = useCallback(() => {
    fetch(`${getBackendUrl()}/api/products/facets`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: ServerFacets) => setFacets(d))
      .catch(() => { /* option lists stay empty — visibly, not silently */ })
  }, [])
  useEffect(() => { refreshFacets() }, [refreshFacets])

  const [family, setFamily] = useState<ProductRow | null>(null)
  useEffect(() => {
    if (!familyId) { setFamily(null); return }
    let cancelled = false
    fetch(`${getBackendUrl()}/api/products/${encodeURIComponent(familyId)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: ProductRow) => { if (!cancelled) setFamily(d) })
      .catch(() => { /* header falls back to the SKU-less wording */ })
    return () => { cancelled = true }
  }, [familyId])

  /**
   * Which channels COUNT for this merchant — the active connections, not every channel the
   * platform supports. Driving it from here is also the scalability answer: connect Etsy and the
   * column includes it with no code change, drop a connection and it stops being a gap.
   */
  const [activeChannels, setActiveChannels] = useState<string[]>([])
  useEffect(() => {
    let cancelled = false
    fetch(`${getBackendUrl()}/api/connections`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { connections?: Array<{ channel: string; isActive: boolean }> }) => {
        if (cancelled) return
        setActiveChannels([...new Set((d.connections ?? []).filter((c) => c.isActive).map((c) => c.channel))])
      })
      .catch(() => { /* no roster ⇒ the cell says "no channels" rather than inventing one */ })
    return () => { cancelled = true }
  }, [])

  const [allTags, setAllTags] = useState<ProductTag[]>([])
  const refreshTags = useCallback(() => {
    fetch(`${getBackendUrl()}/api/tags`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { items?: ProductTag[] }) => setAllTags(d.items ?? []))
      .catch(() => { /* tags are optional; the dialog offers to create the first one */ })
  }, [])
  useEffect(() => { refreshTags() }, [refreshTags])

  /**
   * Re-ask the server for whatever is on screen, IN PLACE. Called on every invalidation and by
   * the error state's "Try again". `purge: false` on purpose: a purge throws away every loaded
   * block AND collapses every expanded family, so a stock event landing while an operator is
   * looking at a family's variations would fold them away mid-read.
   */
  const refetch = useCallback(() => {
    setListError(null)
    if (gridApi && !gridApi.isDestroyed()) gridApi.refreshServerSide({ purge: false })
    refreshFacets()
  }, [gridApi, refreshFacets])
  useInvalidationChannel(
    ['product.updated', 'product.created', 'product.deleted', 'stock.adjusted', 'listing.updated'],
    () => refetch(),
  )

  const stats = listMeta?.stats
  const loading = listMeta == null && listError == null
  const error = listError
  const totalCount = listMeta?.total ?? null
  // From the server's hygiene facet — the whole catalogue, not the rows a page holds.
  const needsAttentionCount: number | null = facets?.hygiene.missingPhotos ?? null

  // Filter options from the server's facets. Families and stages carry an id (`value`) AND a
  // code; the accordion keeps showing codes, and the contract maps code → id on the way out.
  const facetOptions = useMemo(() => {
    const byStr = (a: string, b: string) => a.localeCompare(b)
    const fam = (facets?.families ?? []).map((f) => [f.code ?? 'null', f.label] as [string, string])
    const stg = (facets?.workflowStages ?? []).map((f) => [f.code ?? 'null', f.label] as [string, string])
    return {
      types: (facets?.productTypes ?? []).map((t) => t.value).sort(byStr),
      brands: (facets?.brands ?? []).map((b) => b.value).sort(byStr),
      families: fam.sort((a, b) => a[1].localeCompare(b[1])),
      stages: stg.sort((a, b) => a[1].localeCompare(b[1])),
    }
  }, [facets])

  // ── Selection: the grid owns it, the page reads it ─────────────
  // One direction. The grid reports every change; "Clear" and every consuming bulk action ask
  // the grid to deselect, and the report comes back through the same event.
  const clearSelection = useCallback(() => {
    setConfirmDelete(false)
    if (gridApi && !gridApi.isDestroyed()) gridApi.deselectAll()
  }, [gridApi])
  const onSelectionChanged = useCallback((e: { api: GridApi<ProductRow> }) => {
    const next = readSelection(e.api)
    setSelection((prev) => (prev.ids.length === next.ids.length && prev.ids.every((id, i) => id === next.ids[i]) ? { ...prev, rows: next.rows } : next))
  }, [])
  /**
   * How many VARIATIONS the current selection reaches. Selecting a parent selects the parent — one
   * row, one tick — because the depth differs per action and folding them together would make
   * select-all unusable (14 parents expand to 315, and every bulk endpoint caps at 200). So the
   * reach is stated instead of implied, and stated BEFORE the click rather than in the toast.
   */
  const selectionReach = useMemo(
    () => selection.rows.filter((r) => r.parentId === null).reduce((n, r) => n + (r.childCount ?? 0), 0),
    [selection.rows],
  )
  useEffect(() => {
    if (selection.ids.length === 0 && confirmDelete) setConfirmDelete(false)
  }, [selection.ids.length, confirmDelete])

  // ── Mutations ─────────────────────────────────────────────────
  const { busy, publishBulk, setStatusBulk, duplicateBulk, softDeleteBulk } = useBulkActions({ toast, onConsumed: clearSelection })
  /**
   * One write per field that was ticked, in order, each reporting its own outcome — a status
   * flip that lands and a tag write that fails must not share one green toast.
   */
  const applyBulkEdit = useCallback(
    async (c: BulkEditChanges) => {
      if (c.status) await setStatusBulk(selection.ids, c.status, c.includeChildren)
      setBulkEditOpen(false)
    },
    [setStatusBulk, selection.ids],
  )
  /** Publish is the only thing behind the ⋯ — it is a JOB with per-marketplace outcomes. */
  const moreActionItems = useMemo<MenuItemDef[]>(
    () => [{ id: 'publish', label: 'Publish…', icon: <Send size={13} />, onSelect: () => { setPublishTarget(null); setPublishOpen(true) } }],
    [],
  )

  // ── Columns ───────────────────────────────────────────────────
  const onDuplicate = useCallback((id: string) => void duplicateBulk([id]), [duplicateBulk])
  const columns = useMemo(
    // The Channels cell reads `activeChannels`; omitting it froze the column on the empty roster
    // it was built with, so every row read "no channels" while /api/connections answered 200.
    () => buildPageColumns({ activeChannels, onDuplicate, onOpenInventory: setModalRow }),
    [activeChannels, onDuplicate],
  )

  /**
   * Which column carries which filter, from the shared contract — the same table the server
   * reads. Set-filter options come from the facets the accordion already loads.
   */
  const filterDefFor = useCallback(
    (key: string): Partial<ColDef<ProductRow>> => {
      const kind = (GRID_FILTER_COLUMNS as Record<string, 'set' | 'number' | 'text' | undefined>)[key]
      if (!kind) return {}
      if (kind === 'text') return gridFilterDef('text')
      if (kind === 'number') return gridFilterDef('number', key === 'price' ? { unit: '€' } : {})
      const options =
        key === 'status' ? STATUS_OPTS
        : key === 'channels' ? CHANNEL_OPTS
        : key === 'brand' ? facetOptions.brands.map((b) => ({ value: b, label: b }))
        : key === 'productType' ? facetOptions.types.map((t) => ({ value: t, label: t }))
        : key === 'tags' ? allTags.map((t) => ({ value: t.name, label: t.name }))
        : []
      return gridFilterDef('set', { options, searchable: key === 'brand' || key === 'productType' || key === 'tags' })
    },
    [facetOptions, allTags],
  )

  const colDefs = useMemo(() => projectColDefs(columns, { lockedColumns, filterDefFor }), [columns, lockedColumns, filterDefFor])

  /**
   * The Product column IS the tree column. Its cell is this page's own (`ProductTreeCell`), which
   * is AG's way to draw a custom group cell: the DS expander wired to `node.setExpanded`, a
   * variation directly under its parent, a group's products stepped in under the group.
   */
  const groupHeader = useMemo(() => {
    if (!gridApi || !grouped) return 'Product'
    const labels = gridApi.getRowGroupColumns().map((col) => {
      const c = columns.find((x) => x.key === col.getColId())
      return c ? columnLabel(c) : (col.getColDef().headerName ?? col.getColId())
    })
    return labels.length ? labels.join(' › ') : 'Product'
  }, [gridApi, grouped, columns])
  const autoGroupColumnDef = useMemo<ColDef<ProductRow>>(
    () => ({
      colId: 'product',
      headerName: groupHeader,
      // A value on every row: the CSV export and the sort indicator read it.
      valueGetter: (p) => (isGroupRow(p.data) ? p.data.groupKey : p.data?.name ?? null),
      flex: 1,
      minWidth: 320,
      // Holds the left edge and cannot be hidden or dragged WHILE padlocked — the default — and
      // is an ordinary column once the operator unlocks it in Customise.
      lockPosition: lockedColumns.includes('product') ? 'left' : undefined,
      lockVisible: lockedColumns.includes('product'),
      suppressMovable: lockedColumns.includes('product'),
      sortable: true,
      cellClass: 'nds-ag-cell',
      ...gridFilterDef('text'),
      cellRenderer: ProductTreeCell,
      cellRendererParams: { grouped, columns, canExpand: isFamilyParent } satisfies ProductTreeCellParams,
    }),
    [lockedColumns, groupHeader, columns, grouped],
  )

  // ── The datasource ────────────────────────────────────────────
  // Stable identity, live context: a ref lets one datasource read the CURRENT page context on
  // every request, and the effect below tells the grid to re-ask whenever that context changes.
  // Names and codes travel as the operator sees them; the server resolves them to ids.
  const ctxRef = useRef({ filters, tile: activeTile, familyId, salesDays: SALES_WINDOW_DAYS })
  ctxRef.current = { filters, tile: activeTile, familyId, salesDays: SALES_WINDOW_DAYS }
  const datasource = useMemo(
    () =>
      createProductsDatasource<ProductRow>({
        getContext: () => ctxRef.current,
        onTopLevel: ({ total, stats, response }) => {
          setListError(null)
          setListMeta({ total, stats, salesUnattributed: response.salesUnattributed ?? null })
        },
        onUnsupported: (items) => setUnsupported((prev) => (prev.join('|') === items.join('|') ? prev : items)),
        onError: (message) => setListError(message),
      }),
    [],
  )

  /**
   * A NEW QUERY purges the cache and re-asks. What counts as a new query is decided by the
   * contract itself — the effect keys on the context the datasource would send, not on the
   * inputs that feed it. Keying on the inputs was a real bug: facets and tags arrive one to
   * three seconds after load and used to purge the grid — collapsing every expanded family —
   * exactly when an operator had just expanded one.
   */
  const querySignature = useMemo(
    // The sort and the column filters are AG's own; AG re-asks on its own when they change.
    () => JSON.stringify(buildGridRequest(ctxRef.current, { sortModel: [], groupKeys: [] }).context),
    // ctxRef mirrors exactly these; listing them keeps the memo honest.
    [filters, activeTile, familyId],
  )
  const lastSignature = useRef<string | null>(null)
  useEffect(() => {
    if (!gridApi) return
    if (lastSignature.current === querySignature) return
    const isFirst = lastSignature.current === null
    lastSignature.current = querySignature
    if (isFirst) return // the grid's own first load already asked with this query
    setUnsupported([])
    if (!gridApi.isDestroyed()) gridApi.refreshServerSide({ purge: true })
  }, [gridApi, querySignature])

  // Row height is a grid option; when the density changes AG must re-measure the rows it holds.
  useEffect(() => {
    if (gridApi && !gridApi.isDestroyed()) gridApi.resetRowHeights()
  }, [gridApi, density])

  // ── Customise: the DS dialog, backed by AG's column state ──────
  // Opening reads the grid's LIVE state — a column dragged in the header shows up in that order —
  // and confirming applies the dialog's answer in one call. Views persist it as part of the grid
  // state they already snapshot, so there is no separate store to drift.
  const prefsBridge = useMemo<PrefsBridgeOptions>(
    () => ({ columns: columns.map((c) => ({ key: c.key })), treeColumnKey: 'product', sortKeyToColumn: { product: 'product', available: 'available', price: 'price' } }),
    [columns],
  )
  const defaultPrefs = useMemo<PreferencesValue>(
    () => ({
      visibleColumns: columns.filter((c) => !c.defaultHidden).map((c) => c.key),
      lockedColumns,
      rowGroups: [],
      aggregations: {},
      stickyFirstColumn: false,
      stickyLastColumn: false,
      pageSize: BLOCK_SIZE,
      sortBy: 'product',
      sortDir: 'asc',
    }),
    [columns, lockedColumns],
  )
  const [prefsDraft, setPrefsDraft] = useState<PreferencesValue | null>(null)
  /** The grid is the draft: read its column state back into the dialog's shape. */
  const syncPrefsFromGrid = useCallback(() => {
    if (!gridApi || gridApi.isDestroyed()) return
    setPrefsDraft((prev) => columnStateToPrefs(gridApi.getColumnState(), { ...(prev ?? defaultPrefs), lockedColumns }, prefsBridge))
  }, [gridApi, defaultPrefs, prefsBridge, lockedColumns])
  const openCustomize = useCallback(() => {
    if (!gridApi) return
    syncPrefsFromGrid()
    setCustomizeOpen(true)
  }, [gridApi, syncPrefsFromGrid])
  /** Tree or groups — decided BEFORE the column state applies, so the first request is right. */
  const applyViewMode = useCallback(
    (next: PreferencesValue) => {
      const isGrouped = (next.rowGroups ?? []).length > 0
      gridApi?.setGridOption('treeData', !isGrouped)
      setGrouped(isGrouped)
    },
    [gridApi],
  )
  const applyPrefs = useCallback(
    (next: PreferencesValue) => {
      applyViewMode(next)
      gridApi?.applyColumnState({ state: prefsToColumnState(next, prefsBridge), applyOrder: true })
      setLockedColumns(next.lockedColumns ?? [])
      setPrefsDraft(next)
    },
    [gridApi, prefsBridge, applyViewMode],
  )
  const confirmCustomize = useCallback((next: PreferencesValue) => { applyPrefs(next); setCustomizeOpen(false) }, [applyPrefs])
  /**
   * "Reset columns" from a header menu: the page's defaults, in ONE column-state call. Each
   * column's width, flex and pin go back to its definition. `api.resetColumnState()` would do the
   * widths but would also clear the sort first, and under SSRM every sort change is a round-trip.
   */
  const resetColumns = useCallback(() => {
    if (!gridApi) return
    const next: PreferencesValue = { ...defaultPrefs, lockedColumns: [...DEFAULT_LOCKED_COLUMNS] }
    applyViewMode(next)
    const state = prefsToColumnState(next, prefsBridge).map((s) => {
      const def = gridApi.getColumn(s.colId)?.getColDef()
      return { ...s, width: def?.width, flex: def?.flex ?? null }
    })
    gridApi.applyColumnState({ state, applyOrder: true })
    setLockedColumns([...DEFAULT_LOCKED_COLUMNS])
    setPrefsDraft(next)
  }, [gridApi, defaultPrefs, prefsBridge, applyViewMode])

  const onGridReady = useCallback((e: GridReadyEvent<ProductRow>) => {
    setGridApi(e.api)
    setFilterModelState(e.api.getFilterModel() as GridFilterModel)
    gridViewsBind(e.api)
  }, [gridViewsBind])

  const onPaginationChanged = useCallback((e: { api: GridApi<ProductRow> }) => {
    setPager({ page: e.api.paginationGetCurrentPage() + 1, pageCount: Math.max(1, e.api.paginationGetTotalPages()) })
  }, [])

  // ── KPI tiles ──────────────────────────────────────────────────
  // Each tile is a real button with `aria-pressed`, because each one TOGGLES a filter.
  const kpiMetrics = useMemo<Metric[]>(() => {
    const tiles: Array<{ tileKey: KpiTileKey; label: string; value: number | string; hint: string; accent: string }> = [
      { tileKey: null, label: 'Total', value: stats?.total ?? '—', hint: 'all statuses', accent: 'var(--nds-primary)' },
      { tileKey: 'active', label: 'Active', value: stats?.active ?? '—', hint: 'live & selling', accent: 'var(--nds-success)' },
      { tileKey: 'out-of-stock', label: 'Out of stock', value: stats?.outOfStock ?? '—', hint: 'no available units', accent: 'var(--nds-danger)' },
      { tileKey: 'attention', label: 'Needs attention', value: needsAttentionCount ?? '—', hint: 'photos · GTIN · description', accent: 'var(--nds-warning)' },
    ]
    return tiles.map((t) => ({
      label: t.label,
      value: t.value,
      hint: t.hint,
      accent: t.accent,
      active: activeTile === t.tileKey,
      onClick: () => setActiveTile((prev) => (prev === t.tileKey ? null : t.tileKey)),
    }))
  }, [stats, needsAttentionCount, activeTile])

  /**
   * Which warning the operator has already dismissed — the VALUE, not a boolean. Storing what
   * was dismissed means the banner comes back the moment it has something different to say.
   */
  const [dismissedWarning, setDismissedWarning] = useState<string | null>(null)
  useEffect(() => {
    try { setDismissedWarning(localStorage.getItem(WARNING_DISMISS_KEY)) } catch { /* private mode: the banner simply always shows */ }
  }, [])
  const dismissWarning = useCallback((key: string) => {
    setDismissedWarning(key)
    try { localStorage.setItem(WARNING_DISMISS_KEY, key) } catch { /* dismissal just won't survive a reload */ }
  }, [])

  // Fold the per-channel orphan rows into one honest sentence. Null when sales were not
  // requested, or when every line attributed cleanly — there is nothing to say then.
  const unattributed = useMemo(() => {
    const rows = listMeta?.salesUnattributed
    if (!rows || rows.length === 0) return null
    const cents = rows.reduce((sum, r) => sum + r.revenueCents, 0)
    const orders = rows.reduce((sum, r) => sum + r.orders, 0)
    if (cents === 0) return null
    const channels = rows
      .filter((r) => r.revenueCents > 0)
      .sort((a, b) => b.revenueCents - a.revenueCents)
      .map((r) => `${r.channel.toLowerCase()} ${eur0(r.revenueCents)}`)
      .join(' · ')
    return {
      key: `unattributed:${cents}:${orders}`,
      text: `${eur0(cents)} across ${orders} ${orders === 1 ? 'order' : 'orders'}`,
      why: `those order lines carry no product link (${channels})`,
    }
  }, [listMeta])

  // ── Filter bar config ──────────────────────────────────────────
  const setF = useCallback(<K extends keyof ProductFilters>(key: K, value: ProductFilters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }))
  }, [])
  /**
   * One column filter, written into AG's model. AG then re-asks the server, fires
   * `filterChanged`, and the mirror above follows — the accordion never holds its own copy.
   */
  const setColumnFilter = useCallback(
    (colId: string, entry: GridFilterModelEntry | null) => {
      if (!gridApi) return
      const next = { ...(gridApi.getFilterModel() as GridFilterModel) }
      if (entry) next[colId] = entry
      else delete next[colId]
      gridApi.setFilterModel(next)
    },
    [gridApi],
  )
  const setValuesOf = useCallback((colId: string): string[] => {
    const m = filterModel[colId]
    return m?.filterType === 'set' ? m.values : []
  }, [filterModel])
  const rangeOf = useCallback((colId: string): { min: string; max: string } => {
    const m = filterModel[colId]
    return m?.filterType === 'number'
      ? { min: m.filter == null ? '' : String(m.filter), max: m.filterTo == null ? '' : String(m.filterTo) }
      : { min: '', max: '' }
  }, [filterModel])
  const setSetFilter = useCallback((colId: string) => (values: string[]) => setColumnFilter(colId, values.length ? { filterType: 'set', values } : null), [setColumnFilter])
  const setRangeFilter = useCallback(
    (colId: string) => (min: string, max: string) => {
      const num = (s: string) => (s.trim() === '' ? null : Number.isFinite(Number(s)) ? Number(s) : null)
      const filter = num(min)
      const filterTo = num(max)
      setColumnFilter(colId, filter == null && filterTo == null ? null : { filterType: 'number', type: 'inRange', filter, filterTo })
    },
    [setColumnFilter],
  )

  // The search box IS the Product column's text filter, debounced so a keystroke is not a
  // request. In the LIVE model AG keys it by its own auto-column id; the wire says `product`.
  const searchModel = filterModel[AG_AUTO_COL]
  const searchApplied = searchModel?.filterType === 'text' ? searchModel.filter : ''
  const [searchDraft, setSearchDraft] = useState('')
  const searchDirty = useRef(false)
  useEffect(() => {
    if (!searchDirty.current) setSearchDraft(searchApplied)
  }, [searchApplied])
  useEffect(() => {
    if (!searchDirty.current) return
    const t = setTimeout(() => {
      searchDirty.current = false
      const v = searchDraft.trim()
      setColumnFilter(AG_AUTO_COL, v ? { filterType: 'text', type: 'contains', filter: v } : null)
    }, 250)
    return () => clearTimeout(t)
  }, [searchDraft, setColumnFilter])

  const activeFilterCount = useMemo(() => {
    const f = filters
    // Every column filter except the Product search, which has its own box, plus the page's own.
    const columnFilters = Object.keys(filterModel).filter((k) => k !== AG_AUTO_COL && k !== 'product').length
    return columnFilters + f.stock.length + f.fulfillment.length + f.families.length + f.workflowStages.length + f.missingChannels.length
  }, [filters, filterModel])

  const filterDimensions = useMemo<FilterDimension[]>(() => {
    const dims: FilterDimension[] = [
      { key: 'channels', label: 'Channel', kind: 'multiselect', value: setValuesOf('channels'), onChange: setSetFilter('channels'), options: CHANNEL_OPTS },
      { key: 'status', label: 'Status', kind: 'multiselect', value: setValuesOf('status'), onChange: setSetFilter('status'), options: STATUS_OPTS },
      { key: 'stock', label: 'Stock', kind: 'multiselect', value: filters.stock, onChange: (v) => setF('stock', v), options: [{ value: 'in', label: 'In stock' }, { value: 'low', label: 'Low stock' }, { value: 'out', label: 'Out of stock' }] },
      { key: 'fulfillment', label: 'Fulfilment', kind: 'multiselect', value: filters.fulfillment, onChange: (v) => setF('fulfillment', v), options: [{ value: 'FBA', label: 'FBA' }, { value: 'FBM', label: 'FBM' }] },
    ]
    if (facetOptions.types.length)
      dims.push({ key: 'productTypes', label: 'Product type', kind: 'multiselect', value: setValuesOf('productType'), onChange: setSetFilter('productType'), options: facetOptions.types.map((t) => ({ value: t, label: t })), searchable: true })
    if (facetOptions.brands.length)
      dims.push({ key: 'brands', label: 'Brand', kind: 'multiselect', value: setValuesOf('brand'), onChange: setSetFilter('brand'), options: facetOptions.brands.map((b) => ({ value: b, label: b })), searchable: true })
    // Sourced from every tag that EXISTS, not from the tags found on loaded rows.
    if (allTags.length)
      dims.push({ key: 'tags', label: 'Tags', kind: 'multiselect', value: setValuesOf('tags'), onChange: setSetFilter('tags'), options: allTags.map((t) => ({ value: t.name, label: t.name })), searchable: true })
    if (facetOptions.families.length)
      dims.push({ key: 'families', label: 'Family', kind: 'multiselect', value: filters.families, onChange: (v) => setF('families', v), options: facetOptions.families.map(([code, label]) => ({ value: code, label })), searchable: true })
    if (facetOptions.stages.length)
      dims.push({ key: 'workflowStages', label: 'Workflow stage', kind: 'multiselect', value: filters.workflowStages, onChange: (v) => setF('workflowStages', v), options: facetOptions.stages.map(([code, label]) => ({ value: code, label })), searchable: true })
    dims.push({ key: 'missingChannels', label: 'Missing channel', kind: 'multiselect', value: filters.missingChannels, onChange: (v) => setF('missingChannels', v), options: CHANNEL_OPTS })
    dims.push({ key: 'price', label: 'Price', kind: 'range', unit: '€', ...rangeOf('price'), onChange: setRangeFilter('price') })
    dims.push({ key: 'stockUnits', label: 'Stock units', kind: 'range', ...rangeOf('available'), onChange: setRangeFilter('available') })
    return dims
  }, [filters, facetOptions, setF, allTags, setValuesOf, setSetFilter, rangeOf, setRangeFilter])

  const selectedCount = selection.ids.length

  // ── Grid options with STABLE identities ─────────────────────────
  // AgGridReact shallow-compares every prop and calls `setGridOption` for each one whose identity
  // changed. An object literal in JSX is a new identity on every render — and this page re-renders
  // on every selection change — so `rowSelection`, `selectionColumnDef` and the rest were being
  // "changed" on every tick of a checkbox, and AG re-ran its column model each time (measured:
  // `aria-colindex` rewritten on every Product cell per selection). Declared once, they change
  // only when their inputs do.
  const rowSelection = useMemo<NonNullable<ComponentProps<typeof NexusGrid<ProductRow>>['rowSelection']>>(
    () => ({
      mode: 'multiRow',
      checkboxes: true,
      headerCheckbox: true,
      enableClickSelection: false,
      // Select-all reaches what is LOADED on this page. Under SSRM the alternative — selecting every
      // row the query matches, loaded or not — is a larger promise that the bulk endpoints (capped
      // at 200) could not keep.
      selectAll: 'currentPage',
      // A group row cannot be selected, and the footer is arithmetic, not a product.
      isRowSelectable: (n) => !isGroupRow(n.data) && !isFamilyFooter(n.data),
      hideDisabledCheckboxes: true,
    }),
    [],
  )
  // The DS grid's checkbox column measures 43px; AG's default is 50.
  const selectionColumnDef = useMemo(() => ({ width: 43, maxWidth: 43, resizable: false }), [])
  const columnDialog = useMemo(() => ({ customise: openCustomize, reset: resetColumns }), [openCustomize, resetColumns])
  // AG's own words for the aggregate submenu; the operator sees what it does.
  const localeText = useMemo(() => ({ valueAggregation: 'Total on group rows' }), [])
  const getRowHeight = useCallback((p: { data?: ProductRow }) => (isFamilyFooter(p.data) ? FAMILY_FOOTER_PX : DENSITY_ROW_PX[density]), [density])
  const isFullWidthRow = useCallback((p: { rowNode: { data?: ProductRow } }) => isFamilyFooter(p.rowNode.data), [])
  // Families are a TREE the server serves lazily: a row that can expand asks for its children by
  // its own id. Tree OR groups: while a grouping is active the auto column is the group column.
  const isServerSideGroup = useCallback((d: ProductRow) => (isGroupRow(d) ? true : !grouped && !isFamilyFooter(d) && isFamilyParent(d)), [grouped])
  const getServerSideGroupKey = useCallback((d: ProductRow) => (isGroupRow(d) ? d.groupKey : d.id), [])
  const getRowId = useCallback((p: { data: ProductRow }) => p.data.id, [])
  const onFilterChanged = useCallback((e: { api: GridApi<ProductRow> }) => setFilterModelState(e.api.getFilterModel() as GridFilterModel), [])
  // A refetch replaces every `node.data`; the selection's rows are re-read so a dialog opened
  // afterwards sees what the grid shows (e.g. the tags just applied).
  const onStoreRefreshed = useCallback((e: { api: GridApi<ProductRow> }) => { if (e.api.getSelectedNodes().length || selectedCount > 0) setSelection(readSelection(e.api)) }, [selectedCount])
  const onColumnRowGroupChanged = useCallback((e: { api: GridApi<ProductRow> }) => { setGrouped(e.api.getRowGroupColumns().length > 0); syncPrefsFromGrid() }, [syncPrefsFromGrid])
  const onColumnMoved = useCallback((e: { finished: boolean }) => { if (e.finished) syncPrefsFromGrid() }, [syncPrefsFromGrid])
  // The live page opens sorted by Product ↑; a saved default view overrides it. Initial-only.
  const initialState = useMemo<GridState>(() => gridViews.defaultView?.payload?.gridState ?? { sort: { sortModel: [{ colId: AG_AUTO_COL, sort: 'asc' }] } }, [gridViews.defaultView])

  // ── Render ────────────────────────────────────────────────────
  return (
    <div className={styles.wrap}>
      {/* Page header. In family scope it names the FAMILY, not the catalogue — the page is the
          same grid, and the only thing that tells you which of the two you are looking at is
          this. "Import"/"New product" are catalogue actions and would be lies here, so the
          scoped view offers the way back instead. */}
      <PageHeader
        title={familyId ? (family?.name ?? 'Variation family') : 'Products'}
        subtitle={
          familyId
            ? `${stats?.total ?? '—'} variations${family?.sku ? ` of ${family.sku}` : ''}`
            : `${stats?.total ?? '—'} products · synced live across Amazon, eBay & Shopify`
        }
        actions={
          <div className={styles.acts}>
            {familyId ? (
              <Button asChild size="sm">
                <Link href="/products/next">
                  <ArrowLeft size={13} /> All products
                </Link>
              </Button>
            ) : (
              <>
                <Button size="sm" onClick={() => router.push('/products/upload')}>
                  <Upload size={13} /> Import
                </Button>
                <Button size="sm" variant="primary" onClick={() => router.push('/products/new')}>
                  <Plus size={13} /> New product
                </Button>
              </>
            )}
          </div>
        }
      />

      <MetricStrip metrics={kpiMetrics} className={styles.kpis} />

      {/* Revenue the Sales column cannot show. An order line with no productId is a real sale
          that no product row can carry; without this the column silently under-reports. */}
      {unattributed && unattributed.key !== dismissedWarning && (
        <Banner tone="warning" className={styles.unattributed} onDismiss={() => dismissWarning(unattributed.key)}>
          {unattributed.text} not shown in Sales — {unattributed.why}
        </Banner>
      )}

      <div className={styles.filterBar}>
        <FilterBar
          dimensions={filterDimensions}
          activeCount={activeFilterCount}
          onClear={() => {
            setFilters(EMPTY_FILTERS)
            // Column filters clear too; the search box is not an accordion filter and stays.
            const keep = gridApi?.getFilterModel()[AG_AUTO_COL]
            gridApi?.setFilterModel(keep ? { [AG_AUTO_COL]: keep } : null)
          }}
        />
      </div>

      {unsupported.length > 0 && (
        <Banner tone="warning" className={styles.unattributed}>
          Not applied by the server: {unsupported.map((u) => u.replace(':', ' ')).join(', ')} — the rows above
          are wider than the filters you set.
        </Banner>
      )}

      {/* One card: toolbar + grid + pager share the grid rectangle (Ad-Manager parity). The grid
          is exactly as tall as the page of rows the footer selects — 50, 100, 200 or 500 — and
          the PAGE scrolls, as Seller Central's and Ad Manager's tables do. Expand a family and
          the page gets longer. Owner decision, stated twice (PN.6, PN.9): the grid is never
          bounded to the viewport with a scrollbar of its own. */}
      <div className={`nds-gridcard ${styles.gridCard}`}>
        <GridToolbar
          count={
            selectedCount > 0 ? (
              <>
                Selected <b>{selectedCount}</b> {selectedCount === 1 ? 'product' : 'products'}
                {selectionReach > 0 && (
                  <span className={styles.reachNote}>
                    {' · '}actions also reach <b>{selectionReach}</b>{' '}
                    {selectionReach === 1 ? 'variation' : 'variations'}
                  </span>
                )}
              </>
            ) : familyId ? (
              <><b>{totalCount ?? '—'}</b> variations</>
            ) : grouped ? (
              <><b>{totalCount ?? '—'}</b> {totalCount === 1 ? 'group' : 'groups'} · <b>{stats?.total ?? '—'}</b> products</>
            ) : (
              <><b>{totalCount ?? '—'}</b> products</>
            )
          }
          right={
            <>
              {/* Density steps aside while rows are selected: the bulk actions need the room. */}
              {selectedCount === 0 && (
                <SegmentedControl options={DENSITY_OPTIONS} value={density} onChange={(v) => setDensity(v as DensityMode)} size="sm" />
              )}
              <Button size="sm" onClick={openCustomize} disabled={!gridApi}>
                <SlidersHorizontal size={13} /> Customise
              </Button>
              <GridViewsMenu views={gridViews} />
              <Button
                size="sm"
                // AG exports what the grid is SHOWING — current sort, visible columns, in the
                // operator's order.
                onClick={() => gridApi?.exportDataAsCsv({ fileName: 'products.csv' })}
                disabled={!gridApi || !totalCount}
              >
                <Download size={13} /> Export
              </Button>
              <Pill tone={error ? 'danger' : 'success'} dot size="md">
                {error ? 'Not syncing' : loading ? 'Syncing…' : 'Live'}
              </Pill>
            </>
          }
        >
          {selectedCount > 0 ? (
            <span className={styles.selActions}>
              <Button size="sm" variant="primary" disabled={busy} onClick={() => setBulkEditOpen(true)}>
                <SlidersHorizontal size={13} /> <span className={styles.lbl}>Bulk edit</span>
              </Button>
              <Button size="sm" disabled={busy} onClick={() => setTagDialogOpen(true)} title="Tag">
                <TagIcon size={13} /> <span className={styles.lbl}>Tag</span>
              </Button>
              <Button size="sm" disabled={busy} onClick={() => duplicateBulk(selection.ids)} title="Duplicate">
                <Copy size={13} /> <span className={styles.lbl}>Duplicate</span>
              </Button>
              {confirmDelete ? (
                <Button size="sm" variant="danger" disabled={busy} onClick={() => { setConfirmDelete(false); void softDeleteBulk(selection.ids) }}>
                  Delete {selectedCount + selectionReach}
                </Button>
              ) : (
                <Button size="sm" disabled={busy} onClick={() => setConfirmDelete(true)} title="Delete">
                  <Trash2 size={13} /> <span className={styles.lbl}>Delete</span>
                </Button>
              )}
              <Menu
                label={<MoreHorizontal size={15} />}
                items={moreActionItems}
                align="right"
                triggerProps={{ className: 'nds-btn sm', disabled: busy, 'aria-label': 'More bulk actions' }}
              />
              <Button variant="link" size="sm" onClick={clearSelection}>
                Clear
              </Button>
            </span>
          ) : (
            <span className={styles.searchField}>
              <Input
                leadingIcon={<Search size={13} style={{ color: 'var(--nds-text-3)' }} />}
                placeholder="Search products…"
                value={searchDraft}
                onChange={(e) => { searchDirty.current = true; setSearchDraft(e.target.value) }}
                style={{ width: '100%' }}
              />
            </span>
          )}
        </GridToolbar>

        {/* DensityContext keeps the shared Thumbnail size-aware (compact 32 / comfortable 40 /
            spacious 56); the grid's own row density is the DS `size` tier plus this page's
            measured row height. */}
        <DensityContext.Provider value={mapDensity(density)}>
          {error ? (
            // A failed fetch is NOT an empty catalogue and NOT a slow one.
            <EmptyState
              icon={<AlertTriangle size={20} />}
              title="Couldn't load products"
              description={error}
              action={
                <Button size="sm" variant="secondary" onClick={() => void refetch()}>
                  Try again
                </Button>
              }
            />
          ) : (
            <>
              <NexusGrid<ProductRow>
                // The grid sizes itself to its rows (the current page of them, under pagination)
                // and hands scrolling to the page. Rows are rendered per page, not per screen —
                // the cost of a 500-row page is 500 rows, which is the trade the footer offers.
                domLayout="autoHeight"
                size={GRID_SIZE[density]}
                getRowHeight={getRowHeight}
                isFullWidthRow={isFullWidthRow}
                fullWidthCellRenderer={FamilyFooter}
                pagination
                paginationPageSize={pageSize}
                // The footer below is the page-size control; AG's own selector is off.
                paginationPageSizeSelector={false}
                suppressPaginationPanel
                onPaginationChanged={onPaginationChanged}
                rowModelType="serverSide"
                serverSideDatasource={datasource}
                cacheBlockSize={BLOCK_SIZE}
                getRowId={getRowId}
                onGridReady={onGridReady}
                treeData={!grouped}
                // The DS tint + rail on child rows; the cell itself decides the indent.
                flatTree={!grouped}
                isServerSideGroup={isServerSideGroup}
                getServerSideGroupKey={getServerSideGroupKey}
                // Header text stays the column's name; the aggregate is chosen in Customise.
                suppressAggFuncInHeader
                onColumnRowGroupChanged={onColumnRowGroupChanged}
                onColumnValueChanged={syncPrefsFromGrid}
                onColumnMoved={onColumnMoved}
                onColumnVisible={syncPrefsFromGrid}
                localeText={localeText}
                autoGroupColumnDef={autoGroupColumnDef}
                columnDefs={colDefs}
                columnDialog={columnDialog}
                selectionColumnDef={selectionColumnDef}
                rowSelection={rowSelection}
                onFilterChanged={onFilterChanged}
                onSelectionChanged={onSelectionChanged}
                onStoreRefreshed={onStoreRefreshed}
                initialState={initialState}
                loadingOverlayComponent={ProductsSkeleton}
                overlayNoRowsTemplate={NO_ROWS_TEMPLATE}
              />
              {/* The footer as Ad Manager's: pages on the left of the control, rows per page on the right. */}
              <div className={styles.pager}>
                <span className={styles.grow} />
                <Pagination page={pager.page} pageCount={pager.pageCount} onPage={(n) => gridApi?.paginationGoToPage(n - 1)} />
                <div className={styles.rpp}>
                  Rows per page:
                  <Listbox
                    width={84}
                    options={PAGE_SIZE_CHOICES.map((n) => ({ value: String(n), label: String(n) }))}
                    value={String(pageSize)}
                    onChange={(v) => { setPageSize(Number(v)); gridApi?.paginationGoToPage(0) }}
                    ariaLabel="Rows per page"
                  />
                </div>
              </div>
            </>
          )}
        </DensityContext.Provider>
      </div>

      {/* Customise — the DS dialog over AG's column state (see openCustomize). */}
      {prefsDraft && (
        <PreferencesModal
          open={customizeOpen}
          onClose={() => setCustomizeOpen(false)}
          title="Customise columns"
          value={prefsDraft}
          onConfirm={confirmCustomize}
          // The FULL registry, in canonical order: the immutable ends (Product, Actions) render as
          // padlocked bookends the operator can unlock.
          allColumns={columns.map((c) => ({ key: c.key, label: columnLabel(c), group: c.group, defaultLocked: DEFAULT_LOCKED_COLUMNS.includes(c.key) }))}
          defaultVisible={defaultPrefs.visibleColumns}
          groupByOptions={columns.filter((c) => c.groupable).map((c) => ({ key: c.key, label: columnLabel(c) }))}
          aggregationOptions={columns.filter((c) => c.aggregate).map((c) => ({ key: c.key, label: columnLabel(c), funcs: c.aggregate! }))}
          // Headers sort, the footer sets rows per page, sticky is off: no Display tab here.
          sortFieldOptions={[]}
          pageSizeChoices={[]}
          showSticky={false}
        />
      )}

      <BulkEditModal open={bulkEditOpen} onClose={() => setBulkEditOpen(false)} selection={selection.rows} busy={busy} onSubmit={applyBulkEdit} />

      {/* Tag dialog — the selection's tags, tri-state across the rows it covers. */}
      <TagDialog
        open={tagDialogOpen}
        onClose={() => setTagDialogOpen(false)}
        selection={selection.rows}
        allTags={allTags}
        onTagsChanged={refreshTags}
        onApplied={({ added, removed, products: n }) => {
          const bits = [added ? `+${added}` : '', removed ? `−${removed}` : ''].filter(Boolean).join(' ')
          toast(`${bits} on ${n} ${n === 1 ? 'product' : 'products'}`, 'success')
          emitInvalidation({ type: 'product.updated', meta: { productIds: selection.ids, source: 'bulk-tag' } })
          refreshTags()
        }}
      />

      {/* Publish is a JOB, not an edit: its own dialog, its own outcome, one destination a time. */}
      <Modal
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        size="md"
        title="Publish"
        subtitle={`${selectedCount} ${selectedCount === 1 ? 'product' : 'products'}${selectionReach > 0 ? ` · ${selectionReach} ${selectionReach === 1 ? 'variation' : 'variations'}` : ''} — choose a destination`}
        footer={
          <>
            <Button onClick={() => setPublishOpen(false)}>Cancel</Button>
            <span className="grow" />
            <Button
              variant="primary"
              disabled={!publishTarget || busy}
              onClick={() => {
                const d = PUBLISH_DESTINATIONS.find((x) => `${x.channel}-${x.marketplace}` === publishTarget)
                if (!d) return
                setPublishOpen(false)
                void publishBulk(selection.ids, d.channel, d.marketplace, d.label)
              }}
            >
              Publish
            </Button>
          </>
        }
      >
        <div className={styles.pubList} role="radiogroup" aria-label="Publish destination">
          {PUBLISH_DESTINATIONS.map((d) => {
            const id = `${d.channel}-${d.marketplace}`
            return (
              <label key={id} className={styles.pubRow}>
                <input type="radio" name="nds-publish-destination" checked={publishTarget === id} onChange={() => setPublishTarget(id)} />
                <span>{d.label}</span>
              </label>
            )
          })}
        </div>
      </Modal>

      {/* Inventory editor modal — opened by clicking the Available cell */}
      <InventoryEditorModal row={modalRow} density={density} onClose={() => setModalRow(null)} />
    </div>
  )
}

/** Provides the DS ToastProvider for this subtree (the root layout's is the old library's). */
export function ProductsNextClient() {
  return (
    <ToastProvider>
      <ProductsNextInner />
    </ToastProvider>
  )
}
