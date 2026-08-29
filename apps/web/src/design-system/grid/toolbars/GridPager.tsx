'use client'

/**
 * GDS — the footer under a page grid: pages on the left of the control, rows per page on the
 * right, the Ad Manager's arrangement. Decision 4: a page grid is `autoHeight` and THIS is what
 * decides how tall it is — 50 / 100 / 200 / 500 rows, the page scrolls.
 *
 * Wire it to AG's pagination:
 *   <GridPager page={page} pageCount={pageCount} pageSize={pageSize}
 *              onPage={(n) => api.paginationGoToPage(n - 1)}
 *              onPageSize={(n) => { setPageSize(n); api.paginationGoToPage(0) }} />
 */
import { memo, type ReactNode } from 'react'

import { Listbox, Pagination } from '../../components'

export const GRID_PAGE_SIZES = [50, 100, 200, 500] as const
export const DEFAULT_GRID_PAGE_SIZE = 50

export interface GridPagerProps {
  /** 1-based. */
  page: number
  pageCount: number
  pageSize: number
  onPage: (page: number) => void
  onPageSize: (size: number) => void
  pageSizes?: readonly number[]
  /** Left slot — a count line ("Showing 1–50 of 1,204"), a hint. */
  left?: ReactNode
}

export const GridPager = memo(function GridPager({ page, pageCount, pageSize, onPage, onPageSize, pageSizes = GRID_PAGE_SIZES, left }: GridPagerProps) {
  return (
    <div className="nds-grid-pager">
      {left}
      <span className="nds-grid-pager-grow" />
      <Pagination page={page} pageCount={pageCount} onPage={onPage} />
      <div className="nds-grid-pager-rpp">
        Rows per page:
        <Listbox
          width={84}
          options={pageSizes.map((n) => ({ value: String(n), label: String(n) }))}
          value={String(pageSize)}
          onChange={(v) => onPageSize(Number(v))}
          ariaLabel="Rows per page"
        />
      </div>
    </div>
  )
})
