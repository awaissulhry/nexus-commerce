'use client'

/**
 * PIM C.7 — Bulk apply dialog.
 *
 * Operator picks a field + value; on confirm the parent iterates the
 * selected rows and dispatches updates through useMatrixMutation (so
 * batching / optimistic / rollback behaviour matches single-cell
 * editing exactly — same code path, just N rows instead of one).
 *
 * Minimum field set: the editable columns from C.3 (brand/basePrice/
 * totalStock/status). Transform DSL (truncate, append, title-case,
 * regex replace) lands in C.7b.
 */

import { useState } from 'react'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/components.css'
import { X, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Listbox } from '@/design-system/components/Listbox'

type FieldKey = 'brand' | 'basePrice' | 'totalStock' | 'status'

const FIELDS: Array<{ key: FieldKey; label: string; kind: 'text' | 'number' | 'select' }> = [
  { key: 'brand', label: 'Brand', kind: 'text' },
  { key: 'basePrice', label: 'Price', kind: 'number' },
  { key: 'totalStock', label: 'Stock', kind: 'number' },
  { key: 'status', label: 'Status', kind: 'select' },
]

const STATUS_OPTIONS = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'INACTIVE', label: 'Inactive' },
]

interface Props {
  open: boolean
  onClose: () => void
  selectedCount: number
  /** Parent handler: receives the field key + parsed value, iterates
   *  its selected rows itself (so this dialog stays unaware of which
   *  rows are selected). */
  onApply: (field: FieldKey, value: string | number) => void
}

export default function BulkApplyDialog({ open, onClose, selectedCount, onApply }: Props) {
  const [field, setField] = useState<FieldKey>('basePrice')
  const [valueText, setValueText] = useState('')
  const [valueStatus, setValueStatus] = useState('ACTIVE')

  if (!open) return null

  const fieldDef = FIELDS.find((f) => f.key === field)!

  const handleApply = () => {
    let parsed: string | number
    if (fieldDef.kind === 'number') {
      const trimmed = valueText.trim()
      if (trimmed === '') return
      const n = Number(trimmed)
      if (Number.isNaN(n)) return
      parsed = field === 'totalStock' ? Math.trunc(n) : n
    } else if (fieldDef.kind === 'select') {
      parsed = valueStatus
    } else {
      parsed = valueText
    }
    onApply(field, parsed)
    setValueText('')
  }

  const canApply =
    fieldDef.kind === 'select' || valueText.trim() !== '' || field === 'brand'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <div
        className="bg-white dark:bg-zinc-900 rounded-lg shadow-xl w-full max-w-md flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Apply to {selectedCount} {selectedCount === 1 ? 'row' : 'rows'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-4 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Field</label>
            <Listbox
              value={field}
              onChange={(value) => {
                setField(value as FieldKey)
                setValueText('')
              }}
              options={FIELDS.map((f) => ({ value: f.key, label: f.label }))}
              ariaLabel="Field"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Value</label>
            {fieldDef.kind === 'select' ? (
              <Listbox
                value={valueStatus}
                onChange={(value) => setValueStatus(value)}
                options={STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                ariaLabel="Value"
              />
            ) : (
              <input
                type={fieldDef.kind === 'number' ? 'number' : 'text'}
                step={fieldDef.kind === 'number' ? (field === 'totalStock' ? 1 : 0.01) : undefined}
                value={valueText}
                onChange={(e) => setValueText(e.target.value)}
                placeholder={field === 'brand' ? 'Brand name (empty clears)' : ''}
                className="px-2 py-1.5 text-sm rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 focus:outline-none focus:ring-1 focus:ring-blue-400"
                autoFocus
              />
            )}
          </div>

          <div className="flex items-start gap-2 px-2 py-2 rounded bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 text-xs">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>
              This change applies to all {selectedCount} selected{' '}
              {selectedCount === 1 ? 'row' : 'rows'} (parents <em>and</em> variants). Undo isn't
              available yet — review your selection before confirming.
            </span>
          </div>
        </div>

        <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={!canApply}
            className={cn(
              'px-3 py-1.5 text-xs rounded font-medium',
              'bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed',
            )}
          >
            Apply to {selectedCount}
          </button>
        </div>
      </div>
    </div>
  )
}

export type { FieldKey }
