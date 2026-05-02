'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  LayoutGrid,
  Loader2,
  Package,
  Plus,
  Search,
  Table as TableIcon,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import GridView from './components/GridView'
import TableView from './components/TableView'
import PaginationStrip from './components/PaginationStrip'
import ProductFilters, {
  type ProductFilterState,
} from './components/ProductFilters'
import SortMenu, { type SortOption } from './components/SortMenu'
import SelectionBar from './components/SelectionBar'

export interface ProductRow {
  id: string
  sku: string
  name: string
  brand: string | null
  basePrice: number
  totalStock: number
  status: string
  syncChannels: string[]
  imageUrl: string | null
  isParent: boolean
  updatedAt: string
  createdAt: string
}

export interface ProductStats {
  total: number
  active: number
  draft: number
  inStock: number
  outOfStock: number
}

type ViewMode = 'grid' | 'table'

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200]
const DEFAULT_FILTERS: ProductFilterState = {
  status: [],
  channels: [],
  stockLevel: 'all',
}

interface Props {
  initialProducts: ProductRow[]
  initialStats: ProductStats
  initialTotal: number
  initialTotalPages: number
  initialError: string | null
}

export default function ProductsClient({
  initialProducts,
  initialStats,
  initialTotal,
  initialTotalPages,
  initialError,
}: Props) {
  const [products, setProducts] = useState<ProductRow[]>(initialProducts)
  const [stats, setStats] = useState<ProductStats>(initialStats)
  const [total, setTotal] = useState(initialTotal)
  const [totalPages, setTotalPages] = useState(initialTotalPages)
  const [error, setError] = useState<string | null>(initialError)
  const [loading, setLoading] = useState(false)

  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(searchQuery), 200)
    return () => window.clearTimeout(t)
  }, [searchQuery])

  const [filters, setFilters] = useState<ProductFilterState>(DEFAULT_FILTERS)
  const [sort, setSort] = useState<SortOption>('updated')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [view, setView] = useState<ViewMode>('grid')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Refetch products whenever any filter / search / sort / page / size
  // changes. The server returns matching stats so the header counts
  // stay coherent with the current view.
  const fetchKey = useMemo(
    () =>
      JSON.stringify({
        debouncedSearch,
        filters,
        sort,
        page,
        pageSize,
      }),
    [debouncedSearch, filters, sort, page, pageSize],
  )

  // Skip the very first fetch — we already have initialProducts from
  // the server render.
  const isInitialMount = useRef(true)
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false
      return
    }
    let cancelled = false
    const params = new URLSearchParams()
    params.set('page', String(page))
    params.set('limit', String(pageSize))
    if (debouncedSearch.trim()) {
      params.set('search', debouncedSearch.trim())
    }
    if (filters.status.length > 0) {
      params.set('status', filters.status.join(','))
    }
    if (filters.channels.length > 0) {
      params.set('channels', filters.channels.join(','))
    }
    if (filters.stockLevel !== 'all') {
      params.set('stockLevel', filters.stockLevel)
    }
    params.set('sort', sort)

    setLoading(true)
    setError(null)
    fetch(`${getBackendUrl()}/api/products?${params.toString()}`, {
      cache: 'no-store',
    })
      .then(async (res) => {
        if (!res.ok) {
          const msg = `Fetch failed (HTTP ${res.status})`
          throw new Error(msg)
        }
        return res.json()
      })
      .then((data) => {
        if (cancelled) return
        setProducts(data.products ?? [])
        setStats(data.stats ?? stats)
        setTotal(data.total ?? 0)
        setTotalPages(data.totalPages ?? 1)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err?.message ?? String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchKey])

  const activeFilterCount =
    filters.status.length +
    filters.channels.length +
    (filters.stockLevel !== 'all' ? 1 : 0) +
    (debouncedSearch.trim() ? 1 : 0)

  const resetAll = useCallback(() => {
    setSearchQuery('')
    setFilters(DEFAULT_FILTERS)
    setSort('updated')
    setPage(1)
  }, [])

  // When filters change, jump back to page 1 so we don't end up on
  // page 5 of a smaller filtered set.
  useEffect(() => {
    setPage(1)
  }, [debouncedSearch, filters, sort])

  // Selection clears whenever the visible set changes — selections
  // pointing at rows you can't see anymore would be confusing.
  useEffect(() => {
    setSelectedIds(new Set())
  }, [products])

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(products.map((p) => p.id)))
  }, [products])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
  }, [])

  const selectedProducts = useMemo(
    () => products.filter((p) => selectedIds.has(p.id)),
    [products, selectedIds],
  )

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[22px] font-semibold text-slate-900">
            Products
          </h1>
          <p className="text-[13px] text-slate-600 mt-1">
            <span className="tabular-nums font-medium text-slate-900">
              {stats.total.toLocaleString()}
            </span>{' '}
            products
            <span className="text-slate-400"> · </span>
            <span className="tabular-nums">
              {stats.active.toLocaleString()}
            </span>{' '}
            active
            <span className="text-slate-400"> · </span>
            <span className="tabular-nums">
              {stats.draft.toLocaleString()}
            </span>{' '}
            draft
            <span className="text-slate-400"> · </span>
            <span className="tabular-nums">
              {stats.inStock.toLocaleString()}
            </span>{' '}
            in stock
            {stats.outOfStock > 0 && (
              <>
                <span className="text-slate-400"> · </span>
                <span className="tabular-nums text-red-700">
                  {stats.outOfStock.toLocaleString()} out of stock
                </span>
              </>
            )}
          </p>
        </div>
        <NewProductDropdown />
      </header>

      <div className="sticky top-0 z-10 bg-slate-50/90 backdrop-blur-sm pt-1 -mx-6 px-6 pb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex items-center flex-1 min-w-[260px]">
            <Search className="absolute left-2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search SKU, name, brand, GTIN…"
              className="w-full h-8 pl-7 pr-7 text-[13px] border border-slate-200 rounded-md bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-1.5 text-slate-400 hover:text-slate-700"
                aria-label="Clear search"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          <ProductFilters value={filters} onChange={setFilters} />
          <SortMenu value={sort} onChange={setSort} />

          <div className="flex items-center border border-slate-200 rounded-md bg-white">
            <button
              type="button"
              onClick={() => setView('grid')}
              className={cn(
                'h-8 px-2 inline-flex items-center gap-1.5 text-[12px]',
                view === 'grid'
                  ? 'bg-blue-50 text-blue-800'
                  : 'text-slate-600 hover:bg-slate-50',
              )}
              title="Grid view"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              Grid
            </button>
            <div className="w-px h-5 bg-slate-200" />
            <button
              type="button"
              onClick={() => setView('table')}
              className={cn(
                'h-8 px-2 inline-flex items-center gap-1.5 text-[12px]',
                view === 'table'
                  ? 'bg-blue-50 text-blue-800'
                  : 'text-slate-600 hover:bg-slate-50',
              )}
              title="Table view"
            >
              <TableIcon className="w-3.5 h-3.5" />
              Table
            </button>
          </div>

          <div className="inline-flex items-center text-[12px] text-slate-600">
            <select
              value={pageSize}
              onChange={(e) => setPageSize(parseInt(e.target.value, 10))}
              className="h-8 px-2 border border-slate-200 rounded-md bg-white text-[12px] focus:outline-none focus:border-blue-500"
            >
              {PAGE_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n} / page
                </option>
              ))}
            </select>
          </div>

          {activeFilterCount > 0 && (
            <button
              type="button"
              onClick={resetAll}
              className="h-8 px-2 text-[12px] text-blue-700 hover:text-blue-900"
            >
              Clear all
            </button>
          )}

          {loading && (
            <div className="text-[12px] text-slate-500 inline-flex items-center gap-1.5 ml-auto">
              <Loader2 className="w-3 h-3 animate-spin" />
              Loading
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 rounded-md bg-red-50 border border-red-200 text-[12px] text-red-900 flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <div>{error}</div>
        </div>
      )}

      {products.length === 0 && !loading ? (
        activeFilterCount > 0 ? (
          <NoResultsState onReset={resetAll} />
        ) : (
          <EmptyCatalogState />
        )
      ) : view === 'grid' ? (
        <GridView products={products} />
      ) : (
        <TableView
          products={products}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onSelectAll={selectAll}
          onClearSelection={clearSelection}
        />
      )}

      <PaginationStrip
        page={page}
        totalPages={totalPages}
        total={total}
        pageSize={pageSize}
        loading={loading}
        onChange={setPage}
      />

      <SelectionBar
        count={selectedIds.size}
        products={selectedProducts}
        onClear={clearSelection}
      />
    </div>
  )
}

function NewProductDropdown() {
  // v1: routes to bulk-operations Upload modal. Single-product
  // creation page is a deferred design.
  return (
    <a
      href="/bulk-operations#upload"
      className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[13px] font-medium bg-blue-600 text-white hover:bg-blue-700"
      title="Single-product creation coming soon — for now use the upload flow"
    >
      <Plus className="w-3.5 h-3.5" />
      New product
    </a>
  )
}

function EmptyCatalogState() {
  return (
    <div className="border border-slate-200 rounded-lg bg-white px-6 py-16 text-center">
      <Package className="w-10 h-10 text-slate-300 mx-auto mb-3" />
      <h3 className="text-[15px] font-semibold text-slate-900 mb-1">
        Your catalog is empty
      </h3>
      <p className="text-[13px] text-slate-600 mb-4 max-w-md mx-auto">
        Start by importing a CSV / XLSX file, or add a single product through
        the bulk-operations grid.
      </p>
      <a
        href="/bulk-operations"
        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[13px] font-medium bg-blue-600 text-white hover:bg-blue-700"
      >
        Open bulk operations
      </a>
    </div>
  )
}

function NoResultsState({ onReset }: { onReset: () => void }) {
  return (
    <div className="border border-slate-200 rounded-lg bg-white px-6 py-12 text-center">
      <Search className="w-8 h-8 text-slate-300 mx-auto mb-3" />
      <h3 className="text-[14px] font-semibold text-slate-900 mb-1">
        No products match your filters
      </h3>
      <p className="text-[13px] text-slate-600 mb-4 max-w-md mx-auto">
        Try a different search, broaden your filters, or clear them entirely.
      </p>
      <Button variant="secondary" size="sm" onClick={onReset}>
        Clear all filters
      </Button>
    </div>
  )
}
