'use client'

// UC.1.3 — Shared classic pass-through primitive (Zone 4, transitional).
//
// Collapsible container that hosts the existing classic editor at the
// bottom of the cockpit. It carries data-jump-target="classic" so the
// health panel's "fix in classic" jumps and the cockpit's "Classic view"
// link can scroll + expand it.
//
// NOTE: this is the migration-safe Zone 4. The AF track replaces the
// stacked editor with the grouped "All fields" drawer; until AF.5 flips
// the flag, this primitive keeps the full classic editor reachable so no
// field is ever lost.

import { forwardRef, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Card } from '@/components/ui/Card'

export interface CockpitClassicPassthroughProps {
  open: boolean
  onToggle: () => void
  /** Label, e.g. "Classic — Amazon flat-file editor". */
  label: ReactNode
  children: ReactNode
}

const CockpitClassicPassthrough = forwardRef<
  HTMLDivElement,
  CockpitClassicPassthroughProps
>(function CockpitClassicPassthrough({ open, onToggle, label, children }, ref) {
  return (
    <div ref={ref} data-jump-target="classic" className="min-w-0 max-w-full scroll-mt-32">
      <Card noPadding>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex w-full items-center gap-1 px-3 py-2 text-left text-sm font-medium text-slate-700 hover:text-slate-900 dark:text-slate-200 dark:hover:text-white"
        >
          {open ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
          {label}
        </button>
        {open && (
          <div className="border-t border-slate-100 p-3 dark:border-slate-800">
            {children}
          </div>
        )}
      </Card>
    </div>
  )
})

export default CockpitClassicPassthrough
