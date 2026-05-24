'use client'

/**
 * PIM C.7 — Bulk selection toolbar.
 *
 * Slides in above the grid when ≥1 row is selected. Shows count +
 * "Set field" + "Clear" actions. Stateless — parent owns selection
 * Set and dispatches.
 */

import { X, PenLine } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  count: number
  onClear: () => void
  onOpenBulkApply: () => void
  className?: string
}

export default function SelectionBar({ count, onClear, onOpenBulkApply, className }: Props) {
  if (count === 0) return null
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 px-4 py-2',
        'bg-blue-50 dark:bg-blue-900/30 border-b border-blue-200 dark:border-blue-800',
        'text-sm',
        className,
      )}
    >
      <div className="flex items-center gap-3">
        <span className="font-medium text-blue-900 dark:text-blue-100">
          {count} selected
        </span>
        <button
          type="button"
          onClick={onOpenBulkApply}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium bg-blue-600 text-white hover:bg-blue-700"
        >
          <PenLine className="w-3 h-3" />
          Set field
        </button>
      </div>
      <button
        type="button"
        onClick={onClear}
        className="inline-flex items-center gap-1 text-xs text-blue-700 dark:text-blue-300 hover:text-blue-900 dark:hover:text-blue-100"
      >
        <X className="w-3 h-3" />
        Clear
      </button>
    </div>
  )
}
