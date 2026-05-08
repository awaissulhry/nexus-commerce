'use client'

/**
 * P.1j — extracted from ProductsWorkspace.tsx as part of the
 * file-decomposition sweep. U.6 was the original feature.
 *
 * Renders a one-row pagination strip with First / Prev / numbered
 * range / Next / Last. The numbered range collapses long page sets
 * into "1 … 5 6 [7] 8 9 … 20" so the operator can hop multiple
 * pages at once.
 */

import { useMemo } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'

interface PaginationProps {
  page: number
  totalPages: number
  onPage: (next: number) => void
}

export function Pagination({ page, totalPages, onPage }: PaginationProps) {
  const numbers = useMemo(
    () => buildPageRange(page, totalPages),
    [page, totalPages],
  )
  return (
    <nav
      aria-label="Pagination"
      // U.25 — wrapper used `text-base` while the inner `<span>` used
      // `text-sm`; the wrapper text leaked through hover states. Drop
      // both to `text-sm` so the strip reads as one consistent scale.
      className="flex items-center justify-between text-sm text-slate-500 dark:text-slate-400"
    >
      <span>
        Page{' '}
        <span className="font-semibold text-slate-700 dark:text-slate-300 tabular-nums">
          {page}
        </span>{' '}
        of <span className="tabular-nums">{totalPages}</span>
      </span>
      <div className="flex items-center gap-1">
        <PageBtn
          onClick={() => onPage(1)}
          disabled={page === 1}
          ariaLabel="First page"
          title="First page"
        >
          <ChevronsLeft className="w-3.5 h-3.5" />
        </PageBtn>
        <PageBtn
          onClick={() => onPage(Math.max(1, page - 1))}
          disabled={page === 1}
          ariaLabel="Previous page"
          title="Previous page"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </PageBtn>
        {numbers.map((n, i) =>
          n === 'gap' ? (
            <span
              key={`gap-${i}`}
              className="px-1 text-slate-400 dark:text-slate-500 select-none"
              aria-hidden="true"
            >
              …
            </span>
          ) : (
            <button
              key={n}
              type="button"
              onClick={() => onPage(n)}
              aria-current={n === page ? 'page' : undefined}
              aria-label={`Page ${n}`}
              className={`min-h-11 min-w-11 sm:min-h-0 sm:min-w-[1.75rem] sm:h-7 px-2 text-sm tabular-nums rounded border transition-colors inline-flex items-center justify-center ${
                n === page
                  ? 'bg-slate-900 text-white border-slate-900 dark:bg-slate-100 dark:text-slate-900 dark:border-slate-100'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-800 dark:hover:bg-slate-800'
              }`}
            >
              {n}
            </button>
          ),
        )}
        <PageBtn
          onClick={() => onPage(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
          ariaLabel="Next page"
          title="Next page"
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </PageBtn>
        <PageBtn
          onClick={() => onPage(totalPages)}
          disabled={page >= totalPages}
          ariaLabel="Last page"
          title="Last page"
        >
          <ChevronsRight className="w-3.5 h-3.5" />
        </PageBtn>
      </div>
    </nav>
  )
}

function PageBtn({
  onClick,
  disabled,
  ariaLabel,
  title,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  ariaLabel: string
  title: string
  children: React.ReactNode
}) {
  // U.2b — IconButton outline variant for pagination chevrons.
  // min-h-11/min-w-11 keeps the C.13 44×44 mobile touch-target while
  // desktop renders at h-7 w-7 (size="md").
  return (
    <IconButton
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      title={title}
      variant="outline"
      size="md"
      className="min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 disabled:opacity-40"
    >
      {children}
    </IconButton>
  )
}

/**
 * Returns the page-number range to render. Always shows first/last,
 * the current page, and 1 neighbour on each side — gaps between
 * non-adjacent groups become 'gap' sentinels.
 *
 * Examples (current = 7, total = 20): [1, 'gap', 6, 7, 8, 'gap', 20]
 *           (current = 2, total = 5):  [1, 2, 3, 4, 5]
 */
function buildPageRange(
  current: number,
  total: number,
): Array<number | 'gap'> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1)
  }
  const out: Array<number | 'gap'> = [1]
  const window: number[] = []
  for (let i = current - 1; i <= current + 1; i++) {
    if (i > 1 && i < total) window.push(i)
  }
  if (window[0] && window[0] > 2) out.push('gap')
  out.push(...window)
  if (window[window.length - 1] && window[window.length - 1] < total - 1)
    out.push('gap')
  out.push(total)
  return out
}
