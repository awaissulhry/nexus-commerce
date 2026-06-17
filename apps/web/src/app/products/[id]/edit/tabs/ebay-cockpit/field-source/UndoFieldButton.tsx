'use client'

// EC.2.3 — UndoFieldButton.
//
// One click reverts the field to the most recent history entry.
// Disabled when history is empty. Optional title surfaces the prior
// source + truncated prior value so operators know what they're
// reverting to before clicking.

import { Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SOURCE_LABELS, type HistoryEntry } from './types'

interface Props {
  canUndo: boolean
  lastEntry?: HistoryEntry
  onUndo: () => void
}

function shorten(s: string, n = 40): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

export default function UndoFieldButton({ canUndo, lastEntry, onUndo }: Props) {
  const title = canUndo && lastEntry
    ? `Undo to ${SOURCE_LABELS[lastEntry.source]}: "${shorten(lastEntry.value || '(empty)')}"`
    : 'Nothing to undo'
  return (
    <button
      type="button"
      onClick={onUndo}
      disabled={!canUndo}
      className={cn(
        'inline-flex items-center justify-center w-6 h-6 rounded border transition-colors',
        canUndo
          ? 'border-default dark:border-slate-700 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800'
          : 'border-subtle dark:border-slate-800 text-slate-300 dark:text-slate-700 cursor-not-allowed',
      )}
      title={title}
      aria-label={title}
    >
      <Undo2 className="w-3 h-3" />
    </button>
  )
}
