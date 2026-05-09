'use client'

/**
 * W9.6b — Extracted from ReplenishmentWorkspace.tsx (R.5 origin).
 *
 * Sortable column header. Click to set sort; click again to flip
 * direction. Renders a small chevron next to the active column.
 *
 * Co-located with the SortKey union so callers in the workspace
 * (and any future pages that want the same sort UI) import a
 * single source.
 *
 * Adds dark-mode hover so the header reads correctly in both
 * themes — the original inline version was bright-mode-only.
 */

import { ArrowUp, ArrowDown } from 'lucide-react'
import type { ReactNode } from 'react'

export type SortKey =
  | 'urgency'
  | 'daysOfCover'
  | 'velocity'
  | 'qty'
  | 'stock'
  | 'sku'
  | 'name'

export function SortableTh({
  sortKey,
  current,
  dir,
  onSort,
  className,
  children,
}: {
  sortKey: SortKey
  current: SortKey
  dir: 'asc' | 'desc'
  onSort: (k: SortKey) => void
  className: string
  children: ReactNode
}) {
  const active = current === sortKey
  return (
    <th className={className}>
      <button
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-slate-100"
        aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        {children}
        {active && (dir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
      </button>
    </th>
  )
}
