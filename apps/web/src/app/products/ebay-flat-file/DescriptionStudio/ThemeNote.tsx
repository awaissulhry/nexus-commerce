'use client'

/**
 * DS-6 — theme-note renderer: ⚠ flags always in full, the long-form record
 * behind a disclosure. See ./noteSplit.ts for the split rule and why it exists.
 */

import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { splitThemeNote } from './noteSplit'

export { splitThemeNote, noteIsFlagged, type SplitNote } from './noteSplit'

export function ThemeNote({ notes, className, defaultOpen = false }: {
  notes?: string | null
  className?: string
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const { flags, detail } = splitThemeNote(notes)
  if (flags.length === 0 && !detail) return null

  // With no ⚠ at all the detail IS the headline, so show a two-line preview
  // rather than nothing but a disclosure button.
  const detailIsHeadline = flags.length === 0
  const showToggle = !!detail && (!detailIsHeadline || detail.length > 190)

  return (
    <div className={cn('flex flex-col gap-1.5 min-w-0', className)}>
      {flags.map((f, i) => (
        <p key={i} className="text-[11.5px] font-semibold leading-5 whitespace-pre-wrap break-words">
          ⚠ {f}
        </p>
      ))}
      {detailIsHeadline && (
        <p className={cn('text-[11.5px] leading-5 whitespace-pre-wrap break-words',
          open ? 'max-h-44 overflow-y-auto' : 'line-clamp-2')}>
          {detail}
        </p>
      )}
      {showToggle && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="self-start inline-flex items-center gap-1 text-[11px] font-medium underline underline-offset-2 opacity-80 hover:opacity-100"
        >
          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          {open
            ? 'Hide the full theme note'
            : `Show the full theme note (${detail.length.toLocaleString()} characters)`}
        </button>
      )}
      {open && !detailIsHeadline && (
        <div className="max-h-44 overflow-y-auto rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-[11px] leading-5 whitespace-pre-wrap break-words">
          {detail}
        </div>
      )}
    </div>
  )
}
