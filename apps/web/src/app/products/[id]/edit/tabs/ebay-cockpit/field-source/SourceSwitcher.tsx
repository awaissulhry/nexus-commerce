'use client'

// EC.2.3 — SourceSwitcher dropdown.
//
// Renders the list of FieldSource options the card has declared as
// available (i.e. its resolveValue can produce a non-null value for
// that source). Clicking a source kicks off the diff flow via
// useFieldSource.switchSource. The currently active source is shown
// with a check.

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Check, Lock } from 'lucide-react'
import { cn } from '@/lib/utils'
import FieldSourceBadge from './FieldSourceBadge'
import { SOURCE_HINTS, SOURCE_LABELS, type FieldSource } from './types'

interface Props {
  current: FieldSource
  /** Sources the card is willing to expose. Order is honoured in the
   *  dropdown. Sources not in this list are hidden. */
  available: FieldSource[]
  locked: boolean
  onSwitch: (next: FieldSource) => void
  /** Optional preview function — when the dropdown is open, each row
   *  can show a short preview of what value that source would yield
   *  so the operator picks with confidence. */
  preview?: (source: FieldSource) => string | null
}

export default function SourceSwitcher({ current, available, locked, onSwitch, preview }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current) return
      if (rootRef.current.contains(e.target as Node)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex items-center gap-1 h-6 px-1.5 rounded text-[10.5px] border transition-colors',
          'border-default dark:border-slate-700 text-slate-600 dark:text-slate-400',
          'hover:bg-slate-50 dark:hover:bg-slate-800',
          locked && 'opacity-60 cursor-not-allowed',
        )}
        disabled={locked}
        title={locked ? 'Field is locked — unlock to change source' : 'Change source'}
      >
        Source <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-7 z-30 min-w-[280px] rounded-md border border-default dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg py-1"
        >
          {available.map((src) => {
            const isCurrent = src === current
            const previewText = preview ? preview(src) : null
            return (
              <button
                key={src}
                type="button"
                role="menuitemradio"
                aria-checked={isCurrent}
                onClick={() => {
                  setOpen(false)
                  if (!isCurrent) onSwitch(src)
                }}
                className={cn(
                  'w-full text-left px-2.5 py-2 flex items-start gap-2 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors',
                  isCurrent && 'bg-slate-50 dark:bg-slate-800/60',
                )}
              >
                <div className="pt-0.5">
                  <FieldSourceBadge source={src} compact />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                    {SOURCE_LABELS[src]}
                    {isCurrent && <Check className="w-3 h-3 text-emerald-600" />}
                  </div>
                  <div className="text-[10.5px] text-slate-500 dark:text-slate-400 mt-0.5">
                    {SOURCE_HINTS[src]}
                  </div>
                  {previewText && (
                    <div className="mt-1 text-[10.5px] text-slate-600 dark:text-slate-300 truncate font-mono">
                      → {previewText}
                    </div>
                  )}
                </div>
              </button>
            )
          })}
          {locked && (
            <div className="px-2.5 py-1.5 border-t border-subtle dark:border-slate-800 text-[10.5px] text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
              <Lock className="w-3 h-3" /> Unlock the field to change source
            </div>
          )}
        </div>
      )}
    </div>
  )
}
