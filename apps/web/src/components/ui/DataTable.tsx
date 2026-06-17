/**
 * P1 — DataTable primitive.
 *
 * A token-driven table shell: solid surface (dense data should never
 * be translucent), visible header, AA text, hover rows, optional
 * sticky header + density. Generic over the row type — pass typed
 * columns with a render fn. Dense work surfaces use density="compact".
 *
 * Usage:
 *   <DataTable
 *     rows={products}
 *     rowKey={(p) => p.id}
 *     onRowClick={(p) => open(p)}
 *     columns={[
 *       { key: 'sku', header: 'SKU', render: (p) => <span className="font-mono">{p.sku}</span> },
 *       { key: 'stock', header: 'Stock', align: 'right', render: (p) => p.stock },
 *     ]}
 *   />
 */

import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface DataTableColumn<T> {
  key: string
  header: ReactNode
  render: (row: T, index: number) => ReactNode
  align?: 'left' | 'right' | 'center'
  /** CSS width (e.g. '8rem', '20%'). */
  width?: string
  /** Extra class on every cell in this column. */
  className?: string
}

interface DataTableProps<T> {
  columns: DataTableColumn<T>[]
  rows: T[]
  rowKey: (row: T) => string
  density?: 'compact' | 'comfortable'
  onRowClick?: (row: T) => void
  /** Rendered in place of the body when rows is empty. */
  empty?: ReactNode
  stickyHeader?: boolean
  className?: string
}

const ALIGN: Record<'left' | 'right' | 'center', string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  density = 'comfortable',
  onRowClick,
  empty,
  stickyHeader,
  className,
}: DataTableProps<T>) {
  const cell = density === 'compact' ? 'px-3 py-1.5 text-sm' : 'px-3 py-2.5 text-md'
  return (
    <div className={cn('overflow-x-auto rounded-lg border border-default bg-card', className)}>
      <table className="w-full border-collapse">
        <thead>
          <tr
            className={cn(
              'border-b border-default bg-sunken',
              stickyHeader && 'sticky top-0 z-sticky',
            )}
          >
            {columns.map((c) => (
              <th
                key={c.key}
                style={c.width ? { width: c.width } : undefined}
                className={cn(
                  'px-3 py-2 text-xs font-label uppercase tracking-wide text-tertiary',
                  ALIGN[c.align ?? 'left'],
                )}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-10 text-center text-md text-tertiary">
                {empty ?? 'No data'}
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(
                  'border-b border-subtle text-primary transition-colors last:border-0',
                  onRowClick && 'cursor-pointer hover:bg-sunken',
                )}
              >
                {columns.map((c) => (
                  <td key={c.key} className={cn(cell, ALIGN[c.align ?? 'left'], c.className)}>
                    {c.render(row, i)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
