'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { ChevronsUpDown, ChevronUp, ChevronDown } from 'lucide-react'

export interface Column<T> {
  key: string
  label: ReactNode
  render: (row: T) => ReactNode
  align?: 'left' | 'right' | 'center'
  sortable?: boolean
  sortValue?: (row: T) => number | string
  /** pin this column to the left (sticky); give a numeric `width` so offsets stack */
  sticky?: boolean
  width?: number
  /** value rendered in the totals row */
  total?: ReactNode
}

export interface DataGridProps<T> {
  columns: Array<Column<T>>
  rows: T[]
  rowKey: (row: T) => string
  selectable?: boolean
  selected?: Set<string>
  onSelectedChange?: (next: Set<string>) => void
  showTotals?: boolean
  emptyState?: ReactNode
  initialSort?: { key: string; dir: 'asc' | 'desc' }
  /** cap height + scroll (sticky header/footer stay pinned) */
  maxHeight?: number | string
}

/**
 * The universal data grid (H10 `.h10-am-grid`): sortable headers, row selection
 * with select-all, sticky header, pinned left columns, an optional sticky totals
 * row, and an empty state. Generic over the row type.
 */
export function DataGrid<T>({
  columns,
  rows,
  rowKey,
  selectable,
  selected,
  onSelectedChange,
  showTotals,
  emptyState,
  initialSort,
  maxHeight,
}: DataGridProps<T>) {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(initialSort ?? null)

  const sortedRows = useMemo(() => {
    if (!sort) return rows
    const col = columns.find((c) => c.key === sort.key)
    if (!col?.sortValue) return rows
    const sv = col.sortValue
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = sv(a)
      const bv = sv(b)
      return av < bv ? -dir : av > bv ? dir : 0
    })
  }, [rows, sort, columns])

  const toggleSort = (key: string) =>
    setSort((s) => (s?.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }))

  const allKeys = rows.map(rowKey)
  const selCount = selected?.size ?? 0
  const allSelected = !!selectable && selCount > 0 && allKeys.every((k) => selected!.has(k))
  const someSelected = !!selectable && selCount > 0 && !allSelected

  const toggleAll = () => onSelectedChange?.(allSelected ? new Set() : new Set(allKeys))
  const toggleRow = (k: string) => {
    if (!selected) return onSelectedChange?.(new Set([k]))
    const next = new Set(selected)
    next.has(k) ? next.delete(k) : next.add(k)
    onSelectedChange?.(next)
  }

  // accumulate sticky-left offsets (checkbox is 40px wide and pinned at 0)
  const CK = 40
  let acc = selectable ? CK : 0
  const leftOf: Record<string, number> = {}
  for (const c of columns) {
    if (c.sticky) {
      leftOf[c.key] = acc
      acc += c.width ?? 0
    }
  }

  const alignClass = (a?: 'left' | 'right' | 'center') => (a === 'right' ? 'r' : a === 'center' ? 'c' : '')
  const sortIcon = (key: string) =>
    sort?.key === key ? sort.dir === 'asc' ? <ChevronUp size={13} /> : <ChevronDown size={13} /> : <ChevronsUpDown size={13} />

  return (
    <div className="h10-ds-grid-wrap" style={maxHeight != null ? { maxHeight } : undefined}>
      <table className="h10-ds-grid">
        <thead>
          <tr>
            {selectable && (
              <th className="ck sticky" style={{ left: 0 }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected
                  }}
                  onChange={toggleAll}
                  aria-label="Select all rows"
                />
              </th>
            )}
            {columns.map((c) => {
              const sorted = sort?.key === c.key
              const cls = [alignClass(c.align), c.sticky ? 'sticky' : '', sorted ? 'sorted' : ''].filter(Boolean).join(' ')
              return (
                <th key={c.key} className={cls} style={c.sticky ? { left: leftOf[c.key], width: c.width } : { width: c.width }}>
                  {c.sortable ? (
                    <button type="button" className="sortbtn" onClick={() => toggleSort(c.key)}>
                      {c.label}
                      {sortIcon(c.key)}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.length === 0 ? (
            <tr>
              <td className="h10-ds-grid-empty" colSpan={columns.length + (selectable ? 1 : 0)}>
                {emptyState ?? 'No rows.'}
              </td>
            </tr>
          ) : (
            sortedRows.map((row) => {
              const k = rowKey(row)
              const isSel = !!selected?.has(k)
              return (
                <tr key={k} className={isSel ? 'sel' : undefined}>
                  {selectable && (
                    <td className="ck sticky" style={{ left: 0 }}>
                      <input type="checkbox" checked={isSel} onChange={() => toggleRow(k)} aria-label="Select row" />
                    </td>
                  )}
                  {columns.map((c) => (
                    <td key={c.key} className={[alignClass(c.align), c.sticky ? 'sticky' : ''].filter(Boolean).join(' ')} style={c.sticky ? { left: leftOf[c.key] } : undefined}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              )
            })
          )}
        </tbody>
        {showTotals && sortedRows.length > 0 && (
          <tfoot>
            <tr className="totals">
              {selectable && <td className="ck sticky" style={{ left: 0 }} />}
              {columns.map((c) => (
                <td key={c.key} className={[alignClass(c.align), c.sticky ? 'sticky' : ''].filter(Boolean).join(' ')} style={c.sticky ? { left: leftOf[c.key] } : undefined}>
                  {c.total}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}
