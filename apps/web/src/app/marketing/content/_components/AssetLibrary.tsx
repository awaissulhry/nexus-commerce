'use client'

// MC.1.2 — virtualized asset library. Two views:
//   1. Grid — 6-col responsive grid of AssetCard, virtualized by row.
//   2. List — single column with thumbnail + filename + meta columns.
//
// Pagination: requests page+1 when the user scrolls within 4 rows of
// the bottom. Cursor pagination across DigitalAsset+ProductImage is
// MC.2 work (see assets.routes.ts:/assets/library doc).
//
// Loading/empty/error states each have their own panel — no silent
// blank states. Errors retry with a button (no auto-retry to avoid
// hammering a failing endpoint).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Loader2, AlertTriangle, ImageIcon, RefreshCw } from 'lucide-react'
import Image from 'next/image'
import { Button } from '@/components/ui/Button'
import { useTranslations } from '@/lib/i18n/use-translations'
import AssetCard from './AssetCard'
import { formatBytes } from '../_lib/format'
import type { LibraryItem, LibraryResponse, AssetSource } from '../_lib/types'

export type ViewMode = 'grid' | 'list'

interface Props {
  view: ViewMode
  search: string
  typeFilter: string | null
  sourceFilter: AssetSource | null
  apiBase: string
  onSelect?: (item: LibraryItem) => void
  selectedId?: string | null
}

const PAGE_SIZE = 60
// Tile height roughly: image (≈195px) + label rows (≈40px). Updated by
// useVirtualizer's measureElement once cards mount; this is just the
// pre-measure estimate.
const GRID_ROW_HEIGHT_PX = 240
const LIST_ROW_HEIGHT_PX = 64
// Columns per breakpoint. The lg breakpoint matches the grid layout
// in AssetCard's `sizes` hint above.
const GRID_COLS_BY_WIDTH: Array<{ minWidth: number; cols: number }> = [
  { minWidth: 1280, cols: 6 },
  { minWidth: 1024, cols: 5 },
  { minWidth: 768, cols: 4 },
  { minWidth: 640, cols: 3 },
  { minWidth: 0, cols: 2 },
]

function useGridCols(scrollerRef: React.RefObject<HTMLDivElement | null>) {
  const [cols, setCols] = useState(4)
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const compute = () => {
      const w = el.clientWidth
      const match = GRID_COLS_BY_WIDTH.find((b) => w >= b.minWidth)
      setCols(match?.cols ?? 2)
    }
    compute()
    const obs = new ResizeObserver(compute)
    obs.observe(el)
    return () => obs.disconnect()
  }, [scrollerRef])
  return cols
}

export default function AssetLibrary({
  view,
  search,
  typeFilter,
  sourceFilter,
  apiBase,
  onSelect,
  selectedId,
}: Props) {
  const { t } = useTranslations()
  const [items, setItems] = useState<LibraryItem[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestSeq = useRef(0)

  const fetchPage = useCallback(
    async (
      targetPage: number,
      replace: boolean,
      currentSearch: string,
      currentType: string | null,
    ) => {
      const seq = ++requestSeq.current
      setLoading(true)
      setError(null)
      try {
        const url = new URL(`${apiBase}/api/assets/library`)
        url.searchParams.set('page', String(targetPage))
        url.searchParams.set('pageSize', String(PAGE_SIZE))
        if (currentSearch) url.searchParams.set('search', currentSearch)
        if (currentType) url.searchParams.set('type', currentType)
        const res = await fetch(url.toString(), { cache: 'no-store' })
        if (!res.ok)
          throw new Error(`Library API returned ${res.status}`)
        const data = (await res.json()) as LibraryResponse
        if (seq !== requestSeq.current) return // stale response
        setItems((prev) =>
          replace ? data.items : [...prev, ...data.items],
        )
        setTotal(data.total)
        setHasMore(data.hasMore)
        setPage(data.page)
      } catch (err) {
        if (seq !== requestSeq.current) return
        setError(err instanceof Error ? err.message : 'Network error')
      } finally {
        if (seq === requestSeq.current) setLoading(false)
      }
    },
    [apiBase],
  )

  // Reset + refetch when filters or search change. Uses 250ms debounce
  // on search so each keystroke doesn't issue a request.
  useEffect(() => {
    const handle = setTimeout(() => {
      setItems([])
      setPage(1)
      setHasMore(false)
      void fetchPage(1, true, search, typeFilter)
    }, 250)
    return () => clearTimeout(handle)
  }, [search, typeFilter, fetchPage])

  const visibleItems = useMemo(() => {
    if (!sourceFilter) return items
    return items.filter((i) => i.source === sourceFilter)
  }, [items, sourceFilter])

  const scrollerRef = useRef<HTMLDivElement>(null)
  const cols = useGridCols(scrollerRef)
  const rowCount =
    view === 'grid' ? Math.ceil(visibleItems.length / cols) : visibleItems.length

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () =>
      view === 'grid' ? GRID_ROW_HEIGHT_PX : LIST_ROW_HEIGHT_PX,
    overscan: 6,
  })

  // Trigger next page when scrolled within 4 rows of the end.
  useEffect(() => {
    const virtualItems = virtualizer.getVirtualItems()
    if (!virtualItems.length) return
    const last = virtualItems[virtualItems.length - 1]
    if (!last) return
    if (
      hasMore &&
      !loading &&
      !error &&
      last.index >= rowCount - 4 &&
      visibleItems.length === items.length // don't paginate while a
      // client-side source filter is active; the server doesn't yet
      // know about the filter (sourceFilter is web-only), so paging
      // would just append more rows the user has filtered out.
    ) {
      void fetchPage(page + 1, false, search, typeFilter)
    }
  }, [
    virtualizer,
    hasMore,
    loading,
    error,
    rowCount,
    visibleItems.length,
    items.length,
    page,
    search,
    typeFilter,
    fetchPage,
  ])

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-red-200 bg-red-50 p-8 text-center dark:border-red-900 dark:bg-red-950/40">
        <AlertTriangle className="w-6 h-6 text-red-500" />
        <p className="text-sm font-medium text-red-900 dark:text-red-200">
          {t('marketingContent.library.errorTitle')}
        </p>
        <p className="text-xs text-red-700 dark:text-red-300">{error}</p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            fetchPage(1, true, search, typeFilter)
          }
        >
          <RefreshCw className="w-4 h-4 mr-1" />
          {t('marketingContent.library.retry')}
        </Button>
      </div>
    )
  }

  if (!loading && visibleItems.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 bg-white py-16 text-center dark:border-slate-700 dark:bg-slate-900">
        <ImageIcon className="w-8 h-8 text-slate-400" />
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {search
            ? t('marketingContent.library.emptySearchTitle')
            : t('marketingContent.library.emptyTitle')}
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md">
          {search
            ? t('marketingContent.library.emptySearchBody', { search })
            : t('marketingContent.library.emptyBody')}
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
        <span>
          {loading
            ? t('marketingContent.library.loading')
            : t('marketingContent.library.countSummary', {
                shown: visibleItems.length.toString(),
                total: total.toString(),
              })}
        </span>
        {loading && (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />
        )}
      </div>

      <div
        ref={scrollerRef}
        className="overflow-y-auto"
        style={{ height: 'calc(100vh - 360px)', minHeight: 400 }}
      >
        <div
          className="relative"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((row) => {
            if (view === 'grid') {
              const rowItems = visibleItems.slice(
                row.index * cols,
                row.index * cols + cols,
              )
              return (
                <div
                  key={row.key}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  className="absolute inset-x-0 grid gap-2 px-3 py-1"
                  style={{
                    transform: `translateY(${row.start}px)`,
                    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                  }}
                >
                  {rowItems.map((item) => (
                    <AssetCard
                      key={item.id}
                      item={item}
                      onSelect={onSelect}
                      selected={selectedId === item.id}
                    />
                  ))}
                </div>
              )
            }

            // list view
            const item = visibleItems[row.index]
            if (!item) return null
            return (
              <button
                type="button"
                key={row.key}
                data-index={row.index}
                ref={virtualizer.measureElement}
                onClick={() => onSelect?.(item)}
                aria-pressed={selectedId === item.id}
                className={`absolute inset-x-0 flex items-center gap-3 border-b border-slate-100 px-3 text-left transition-colors hover:bg-slate-50 focus:outline-none focus-visible:bg-blue-50 dark:border-slate-800 dark:hover:bg-slate-800 dark:focus-visible:bg-blue-950 ${
                  selectedId === item.id
                    ? 'bg-blue-50 dark:bg-blue-950/40'
                    : ''
                }`}
                style={{
                  transform: `translateY(${row.start}px)`,
                  height: LIST_ROW_HEIGHT_PX,
                }}
              >
                <div className="relative h-12 w-12 flex-shrink-0 overflow-hidden rounded bg-slate-100 dark:bg-slate-800">
                  {item.type === 'image' ? (
                    <Image
                      src={item.url}
                      alt={item.label}
                      fill
                      sizes="48px"
                      className="object-cover"
                      unoptimized
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-slate-400">
                      <ImageIcon className="w-5 h-5" />
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                    {item.label}
                  </p>
                  <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                    {item.productSku
                      ? `${item.productSku} · ${item.productName ?? ''}`
                      : t('marketingContent.library.noProductLink')}
                  </p>
                </div>
                <div className="hidden sm:flex flex-col items-end gap-0.5 text-xs text-slate-500 dark:text-slate-400">
                  <span className="uppercase tracking-wide text-[10px]">
                    {item.type}
                    {item.role ? ` · ${item.role}` : ''}
                  </span>
                  <span>
                    {item.sizeBytes ? formatBytes(item.sizeBytes) : '—'}
                    {item.usageCount > 0
                      ? ` · ${t('marketingContent.library.usedIn', {
                          n: item.usageCount.toString(),
                        })}`
                      : ''}
                  </span>
                </div>
              </button>
            )
          })}
        </div>

        {loading && items.length > 0 && (
          <div className="flex items-center justify-center gap-2 p-3 text-xs text-slate-500 dark:text-slate-400">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            {t('marketingContent.library.loadingMore')}
          </div>
        )}
      </div>
    </div>
  )
}
