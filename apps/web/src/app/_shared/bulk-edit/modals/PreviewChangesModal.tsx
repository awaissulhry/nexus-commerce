'use client'

import { useEffect } from 'react'
import { X, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import type { BulkProduct, CellChange } from '../types'

interface Props {
  open: boolean
  onClose: () => void
  changes: Map<string, CellChange>
  products: BulkProduct[]
}

const COLUMN_LABELS: Record<string, string> = {
  name: 'Name',
  brand: 'Brand',
  status: 'Status',
  fulfillmentChannel: 'Channel',
  basePrice: 'Price',
  costPrice: 'Cost',
  totalStock: 'Stock',
}

function formatValue(columnId: string, value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '—'
  }
  if (columnId === 'basePrice' || columnId === 'costPrice') {
    return `€${Number(value).toFixed(2)}`
  }
  return String(value)
}

export default function PreviewChangesModal({
  open,
  onClose,
  changes,
  products,
}: Props) {
  // Esc to close
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const productsById = new Map(products.map((p) => [p.id, p]))
  const sortedChanges = Array.from(changes.values()).sort((a, b) =>
    (productsById.get(a.rowId)?.sku ?? '').localeCompare(
      productsById.get(b.rowId)?.sku ?? ''
    )
  )

  return (
    <div
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-[1px] z-50 flex items-center justify-center p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Preview pending changes"
    >
      <div
        className="bg-white dark:bg-slate-900 rounded-lg shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-3xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              Pending Changes
            </h2>
            <p className="text-base text-slate-500 dark:text-slate-400 mt-0.5">
              {changes.size} cell{changes.size === 1 ? '' : 's'} edited across{' '}
              {new Set(sortedChanges.map((c) => c.rowId)).size} product
              {new Set(sortedChanges.map((c) => c.rowId)).size === 1 ? '' : 's'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1">
          <table className="w-full">
            <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 z-10">
              <tr>
                <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                  SKU
                </th>
                <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                  Field
                </th>
                <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                  Was
                </th>
                <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                  New
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedChanges.map((c) => {
                const product = productsById.get(c.rowId)
                const sku = product?.sku ?? c.rowId
                return (
                  <tr
                    key={`${c.rowId}:${c.columnId}`}
                    className="border-b border-slate-100 dark:border-slate-800"
                  >
                    <td className="px-4 py-2 font-mono text-base text-slate-900 dark:text-slate-100">
                      {sku}
                    </td>
                    <td className="px-4 py-2 text-base text-slate-700 dark:text-slate-300">
                      {COLUMN_LABELS[c.columnId] ?? c.columnId}
                    </td>
                    <td className="px-4 py-2 text-base text-slate-500 dark:text-slate-400 line-through tabular-nums">
                      {formatValue(c.columnId, c.oldValue)}
                    </td>
                    <td className="px-4 py-2 text-base text-slate-900 dark:text-slate-100 font-medium bg-yellow-50 tabular-nums">
                      {formatValue(c.columnId, c.newValue)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="border-t border-slate-200 dark:border-slate-700 px-5 py-3 flex items-center justify-between gap-3 flex-shrink-0">
          <div className="flex items-start gap-2 text-base text-amber-700 dark:text-amber-300">
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>
              Save flow ships in Phase C. For now this is a preview only —
              changes stay in the table on close.
            </span>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            <Button variant="secondary" size="sm" onClick={onClose}>
              Close
            </Button>
            <Button variant="primary" size="sm" disabled>
              Save All — Phase C
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
