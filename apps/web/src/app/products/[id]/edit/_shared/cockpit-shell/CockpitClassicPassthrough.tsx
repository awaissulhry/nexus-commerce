'use client'

// UC.1.3 / UC.3.A — Shared classic pass-through primitive (Zone 4, transitional).
//
// Collapsible container hosting the existing classic editor at the
// bottom of the cockpit. Carries data-jump-target="classic" so the
// health panel's "fix in classic" jumps and the cockpit's "Classic view"
// link can scroll + expand it. Toggle bar mirrors CockpitPreviewBand
// (label left, chevron right) for a consistent look.
//
// NOTE: migration-safe Zone 4. The AF track replaces the stacked editor
// with the grouped "All fields" drawer; until AF.5 flips the flag this
// keeps the full classic editor reachable so no field is ever lost.

import { forwardRef, type ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Card } from '@/components/ui/Card'

export interface CockpitClassicPassthroughProps {
  open: boolean
  onToggle: () => void
  /** Label node — title + optional badge/subtitle, channel-built. */
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
          className="w-full px-4 py-2.5 flex items-center justify-between text-left border-b border-subtle dark:border-slate-800"
        >
          <div className="flex items-center gap-2">{label}</div>
          {open ? (
            <ChevronUp className="w-4 h-4 text-tertiary" />
          ) : (
            <ChevronDown className="w-4 h-4 text-tertiary" />
          )}
        </button>
        {open && <div className="p-4">{children}</div>}
      </Card>
    </div>
  )
})

export default CockpitClassicPassthrough
