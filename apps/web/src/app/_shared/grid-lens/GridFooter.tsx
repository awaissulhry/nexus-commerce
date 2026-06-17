'use client'

/**
 * GridFooter — standard row-count + pagination footer for VirtualizedGrid
 * surfaces. Renders below the grid, consistent across all pages.
 *
 * Simple (client-only):  "18 lots"
 * Paginated:             "847 products · page 2 of 17 · 50/page [▼] [← Prev] [Next →]"
 */

import { ChevronLeft, ChevronRight } from 'lucide-react'

interface GridFooterProps {
  /** Number of rows currently visible in the grid. */
  count: number
  /** Noun label in English, e.g. "products", "lots", "shipments". */
  label: string

  // ── Server pagination (all optional; omit for client-only pages) ──
  /** Total records across all pages (from the API). */
  total?: number
  /** Current page number (1-based). */
  page?: number
  /** Total page count. */
  totalPages?: number
  /** Called when the user clicks Prev / Next. */
  onPage?: (next: number) => void
  /** Current page-size selection. */
  pageSize?: number
  /** Called when the user changes the page-size dropdown. */
  onPageSize?: (size: number) => void
  /** Options shown in the page-size dropdown. Defaults to [25, 50, 100, 200]. */
  pageSizeOptions?: number[]
}

export function GridFooter({
  count,
  label,
  total,
  page,
  totalPages,
  onPage,
  pageSize,
  onPageSize,
  pageSizeOptions = [25, 50, 100, 200],
}: GridFooterProps) {
  const isPaginated = page != null && totalPages != null && onPage != null

  return (
    <div className="flex items-center justify-between gap-3 px-1 py-2 text-sm text-slate-500 dark:text-slate-400 select-none">
      {/* Left: count + page info */}
      <div className="flex items-center gap-2 flex-wrap">
        <span>
          <span className="font-semibold tabular-nums text-slate-700 dark:text-slate-300">
            {(total ?? count).toLocaleString()}
          </span>
          {' '}{label}
        </span>

        {isPaginated && (
          <>
            <span className="text-slate-300 dark:text-slate-600">·</span>
            <span>
              page{' '}
              <span className="tabular-nums font-medium text-slate-600 dark:text-slate-300">{page}</span>
              {' '}of{' '}
              <span className="tabular-nums font-medium text-slate-600 dark:text-slate-300">{totalPages}</span>
            </span>
          </>
        )}

        {pageSize != null && onPageSize != null && (
          <>
            <span className="text-slate-300 dark:text-slate-600">·</span>
            <select
              value={pageSize}
              onChange={(e) => onPageSize(Number(e.target.value))}
              aria-label="Rows per page"
              className="h-6 px-1.5 text-xs border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 cursor-pointer"
            >
              {pageSizeOptions.map((n) => (
                <option key={n} value={n}>{n}/page</option>
              ))}
            </select>
          </>
        )}
      </div>

      {/* Right: Prev / Next */}
      {isPaginated && totalPages! > 1 && (
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => onPage!(Math.max(1, page! - 1))}
            disabled={page! <= 1}
            aria-label="Previous page"
            className="h-7 w-7 inline-flex items-center justify-center border border-default dark:border-slate-700 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft size={13} />
          </button>
          <button
            type="button"
            onClick={() => onPage!(Math.min(totalPages!, page! + 1))}
            disabled={page! >= totalPages!}
            aria-label="Next page"
            className="h-7 w-7 inline-flex items-center justify-center border border-default dark:border-slate-700 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronRight size={13} />
          </button>
        </div>
      )}
    </div>
  )
}
