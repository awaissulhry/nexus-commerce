'use client'

import type { ComponentType, SVGProps } from 'react'
import { Loader2, X } from 'lucide-react'

export type BulkActionTone = 'default' | 'primary' | 'danger'

export interface BulkAction {
  /** Stable id, used as React key. */
  id: string
  label: string
  /** lucide-react icon (size prop accepted). */
  icon?: ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>
  tone?: BulkActionTone
  disabled?: boolean
  /** Title attribute / tooltip. */
  title?: string
  onClick: () => void | Promise<void>
}

export interface BulkActionShellProps {
  /** Number of currently-selected rows. The bar hides itself when 0. */
  selectedCount: number
  /** Noun, e.g. "product", "listing", "row". Used in the count line. */
  noun?: string
  /** Clear-selection callback. */
  onClear: () => void
  /** Page-specific action buttons rendered right-aligned. */
  actions: ReadonlyArray<BulkAction>
  /** Optional in-flight indicator — shows a spinner + status text. */
  busy?: boolean
  status?: string | null
}

const TONE_CLASS: Record<BulkActionTone, string> = {
  default:
    'h-7 px-3 text-base bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border border-default dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800',
  primary:
    'h-7 px-3 text-base bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 border border-slate-900 dark:border-slate-100 hover:bg-slate-800 dark:hover:bg-slate-200',
  danger:
    'h-7 px-3 text-base bg-white dark:bg-slate-900 text-rose-700 dark:text-rose-400 border border-rose-200 dark:border-rose-900 hover:bg-rose-50 dark:hover:bg-rose-950/40',
}

/**
 * Shared bulk-action bar. Inline blue-tinted strip that appears when
 * the grid has at least one selected row. Page-specific actions plug
 * in via the `actions` array — each action renders as a button with a
 * consistent shape across grids.
 *
 * /products keeps its richer 1096-line BulkActionBar for now (status
 * flips, AI fill, schedule modal, etc.); /listings, /stock and
 * /replenishment standardise on this shell.
 */
export function BulkActionShell({
  selectedCount,
  noun,
  onClear,
  actions,
  busy,
  status,
}: BulkActionShellProps) {
  if (selectedCount === 0) return null

  return (
    <div className="bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 rounded-md px-3 py-2 flex items-center justify-between gap-3 flex-wrap">
      <div className="flex items-center gap-3 min-w-0">
        <div className="text-md text-slate-700 dark:text-slate-200">
          <span className="font-semibold tabular-nums">{selectedCount}</span>{' '}
          {noun ? `${noun}${selectedCount === 1 ? '' : 's'} selected` : 'selected'}
        </div>
        <button
          type="button"
          onClick={onClear}
          className="h-7 px-2 text-sm inline-flex items-center gap-1 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100"
          title="Clear selection"
          aria-label="Clear selection"
        >
          <X size={12} /> Clear
        </button>
        {busy && (
          <span className="inline-flex items-center gap-1 text-sm text-blue-700 dark:text-blue-300">
            <Loader2 size={12} className="animate-spin" />
            {status ?? 'Working…'}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 flex-wrap justify-end">
        {actions.map((a) => {
          const Icon = a.icon
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => { void a.onClick() }}
              disabled={a.disabled || busy}
              title={a.title ?? a.label}
              className={`${TONE_CLASS[a.tone ?? 'default']} rounded inline-flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              {Icon && <Icon size={12} aria-hidden="true" />} {a.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
