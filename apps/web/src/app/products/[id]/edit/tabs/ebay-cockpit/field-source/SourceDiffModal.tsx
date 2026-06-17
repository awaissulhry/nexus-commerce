'use client'

// EC.2.3 — SourceDiffModal.
//
// Before any source switch applies, this modal shows the operator
// the current value alongside what the new source would yield.
// Only one diff modal exists across the cockpit (slot lives in
// FieldSourceProvider), so opening a second one cancels the first.
//
// For long values (>80 chars or any newline) we stack vertically;
// short single-line values render side-by-side.

import { useEffect } from 'react'
import { X } from 'lucide-react'
import FieldSourceBadge from './FieldSourceBadge'
import { useFieldSourceContext } from './FieldSourceProvider'
import { SOURCE_LABELS } from './types'
import { cn } from '@/lib/utils'

export default function SourceDiffModal() {
  const { pendingDiff } = useFieldSourceContext()

  // ESC to cancel
  useEffect(() => {
    if (!pendingDiff) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') pendingDiff?.onCancel()
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) pendingDiff?.onConfirm()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pendingDiff])

  if (!pendingDiff) return null

  const isLong =
    pendingDiff.currentValue.length > 80 ||
    pendingDiff.nextValue.length > 80 ||
    pendingDiff.currentValue.includes('\n') ||
    pendingDiff.nextValue.includes('\n')

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm"
      onClick={pendingDiff.onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="source-diff-title"
        className="w-full max-w-2xl mx-4 rounded-lg border border-default dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-subtle dark:border-slate-800 flex items-center justify-between">
          <div>
            <div id="source-diff-title" className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Switch <span className="font-mono">{pendingDiff.fieldLabel}</span> source
            </div>
            <div className="text-xs text-slate-500 mt-0.5 flex items-center gap-1.5">
              <FieldSourceBadge source={pendingDiff.fromSource} compact />
              <span>→</span>
              <FieldSourceBadge source={pendingDiff.toSource} compact />
            </div>
          </div>
          <button
            type="button"
            onClick={pendingDiff.onCancel}
            className="p-1 text-tertiary hover:text-slate-700 dark:hover:text-slate-200 rounded"
            aria-label="Cancel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className={cn('p-4', isLong ? 'space-y-3' : 'grid grid-cols-2 gap-3')}>
          <ValueBlock
            label={`Current (${SOURCE_LABELS[pendingDiff.fromSource]})`}
            tone="from"
            value={pendingDiff.currentValue}
          />
          <ValueBlock
            label={`New (${SOURCE_LABELS[pendingDiff.toSource]})`}
            tone="to"
            value={pendingDiff.nextValue}
          />
        </div>

        {pendingDiff.error && (
          <div className="mx-4 mb-3 px-3 py-2 rounded bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 text-xs">
            {pendingDiff.error}
          </div>
        )}

        <div className="px-4 py-3 border-t border-subtle dark:border-slate-800 flex items-center justify-end gap-2">
          <span className="text-[10.5px] text-tertiary mr-auto">
            ESC to cancel · ⌘/Ctrl + Enter to apply
          </span>
          <button
            type="button"
            onClick={pendingDiff.onCancel}
            className="px-3 py-1.5 text-xs font-medium rounded border border-default dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={pendingDiff.onConfirm}
            disabled={pendingDiff.loading}
            className="px-3 py-1.5 text-xs font-medium rounded bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
          >
            {pendingDiff.loading ? 'Working…' : 'Apply switch'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ValueBlock({ label, tone, value }: { label: string; tone: 'from' | 'to'; value: string }) {
  return (
    <div className="space-y-1">
      <div
        className={cn(
          'text-[10.5px] font-medium uppercase tracking-wide',
          tone === 'from' ? 'text-slate-500' : 'text-blue-600 dark:text-blue-400',
        )}
      >
        {label}
      </div>
      <div
        className={cn(
          'rounded border p-2.5 text-xs whitespace-pre-wrap break-words font-mono leading-relaxed min-h-[2.5rem]',
          tone === 'from'
            ? 'border-default dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 text-slate-700 dark:text-slate-300'
            : 'border-blue-200 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-950/30 text-blue-900 dark:text-blue-200',
        )}
      >
        {value || <em className="not-italic text-tertiary">(empty)</em>}
      </div>
    </div>
  )
}
