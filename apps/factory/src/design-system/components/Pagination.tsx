import { ChevronLeft, ChevronRight } from 'lucide-react'

export interface PaginationProps {
  page: number
  pageCount: number
  onPage: (page: number) => void
  className?: string
}

/** Windowed page list with first/last + current±1 and ellipses. */
function pageList(page: number, pageCount: number): Array<number | 'gap'> {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1)
  const wanted = [1, pageCount, page, page - 1, page + 1].filter((p) => p >= 1 && p <= pageCount)
  const sorted = Array.from(new Set(wanted)).sort((a, b) => a - b)
  const out: Array<number | 'gap'> = []
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push('gap')
    out.push(p)
  })
  return out
}

/** Pager (H10 `.h10-am-pager` look). Controlled via `page` / `onPage`. */
export function Pagination({ page, pageCount, onPage, className }: PaginationProps) {
  return (
    <div className={`h10-ds-pager${className ? ` ${className}` : ''}`}>
      <button type="button" className="h10-ds-pgbtn" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
        <ChevronLeft size={15} />
      </button>
      {pageList(page, pageCount).map((p, i) =>
        p === 'gap' ? (
          <span key={`gap-${i}`} className="h10-ds-pgell">
            …
          </span>
        ) : (
          <button
            key={p}
            type="button"
            className={['h10-ds-pgbtn', p === page ? 'on' : ''].filter(Boolean).join(' ')}
            aria-current={p === page ? 'page' : undefined}
            onClick={() => onPage(p)}
          >
            {p}
          </button>
        ),
      )}
      <button type="button" className="h10-ds-pgbtn" disabled={page >= pageCount} onClick={() => onPage(page + 1)} aria-label="Next page">
        <ChevronRight size={15} />
      </button>
    </div>
  )
}
