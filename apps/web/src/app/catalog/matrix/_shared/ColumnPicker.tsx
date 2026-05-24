'use client'

/**
 * PIM C.4 — Column picker modal.
 *
 * Stateless: parent owns the visible-set; this modal renders a list
 * with toggles. Closes via onClose. Reorder lands in C.6 (saved views).
 *
 * Two sections:
 *   Built-in    — the static SKU/Name/Brand/etc. columns
 *   Attributes  — dynamic categoryAttributes keys discovered at runtime
 *
 * Required columns (expand/sku/name/actions) appear muted and disabled
 * — they're structural and can't be hidden.
 */

import { useMemo } from 'react'
import { X, Eye, EyeOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ColumnDef } from './columnDefs'

interface Props {
  open: boolean
  onClose: () => void
  builtIn: ColumnDef[]
  dynamic: ColumnDef[]
  visibleIds: Set<string>
  onToggle: (id: string) => void
  /** Reset to default visibility (every non-required built-in,
   *  zero dynamic columns). */
  onResetToDefault: () => void
}

export default function ColumnPicker({
  open,
  onClose,
  builtIn,
  dynamic,
  visibleIds,
  onToggle,
  onResetToDefault,
}: Props) {
  // Backdrop click closes. ESC handled by the inner div's onKeyDown.
  const visibleCount = useMemo(() => visibleIds.size, [visibleIds])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <div
        className="bg-white dark:bg-zinc-900 rounded-lg shadow-xl w-full max-w-md max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="column-picker-title"
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
          <div>
            <h2
              id="column-picker-title"
              className="text-sm font-semibold text-zinc-900 dark:text-zinc-100"
            >
              Columns
            </h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              {visibleCount} visible · {builtIn.length + dynamic.length} available
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <Section
            title="Built-in"
            cols={builtIn}
            visibleIds={visibleIds}
            onToggle={onToggle}
          />

          {dynamic.length > 0 && (
            <Section
              title="Technical attributes"
              cols={dynamic}
              visibleIds={visibleIds}
              onToggle={onToggle}
              hint="Discovered from categoryAttributes across loaded products."
            />
          )}

          {dynamic.length === 0 && (
            <div className="mt-4 text-xs italic text-zinc-400 px-1">
              No dynamic attributes discovered yet. Add technical attributes on the Global tab
              of any product to surface them here.
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
          <button
            type="button"
            onClick={onResetToDefault}
            className="text-xs text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            Reset to default
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-xs px-3 py-1.5 rounded-md bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

function Section({
  title,
  cols,
  visibleIds,
  onToggle,
  hint,
}: {
  title: string
  cols: ColumnDef[]
  visibleIds: Set<string>
  onToggle: (id: string) => void
  hint?: string
}) {
  return (
    <div className="mb-4">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 mb-1.5">
        {title}
      </div>
      {hint && <div className="text-[11px] text-zinc-400 mb-2">{hint}</div>}
      <div className="flex flex-col">
        {cols.map((c) => {
          const visible = visibleIds.has(c.id)
          const disabled = c.required === true
          return (
            <button
              type="button"
              key={c.id}
              onClick={() => !disabled && onToggle(c.id)}
              disabled={disabled}
              className={cn(
                'flex items-center justify-between px-2 py-1.5 rounded text-sm',
                disabled
                  ? 'text-zinc-400 cursor-not-allowed'
                  : 'text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800',
              )}
            >
              <span className="flex items-center gap-2 truncate">
                {c.dynamic && (
                  <span className="text-[10px] font-mono text-zinc-400 px-1 rounded bg-zinc-100 dark:bg-zinc-800">
                    attr
                  </span>
                )}
                <span className="truncate">{c.label || c.id}</span>
                {disabled && <span className="text-[10px] text-zinc-400">(required)</span>}
              </span>
              {visible ? (
                <Eye className="w-3.5 h-3.5 text-emerald-600" />
              ) : (
                <EyeOff className="w-3.5 h-3.5 text-zinc-400" />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
