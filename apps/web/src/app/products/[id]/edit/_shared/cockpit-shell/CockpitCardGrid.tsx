'use client'

// UC.1.3 — Shared card layout primitive (Zone 3).
//
// Two layouts cover both cockpits without compromise:
//   • 'grid'       — Amazon's responsive card grid. Columns use
//                    minmax(0,1fr) so a wide card can never force the
//                    page into horizontal scroll (AC regression guard).
//   • 'sequential' — eBay's full-width stacked cards.
//
// Cards pass through verbatim; this primitive only owns spacing + the
// overflow-safe track. Jump-to-card targeting (data-jump-target) stays
// on the individual cards, not here.

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface CockpitCardGridProps {
  layout: 'grid' | 'sequential'
  children: ReactNode
  /** Min column width for the grid layout. Defaults to 22rem. */
  minColumn?: string
  className?: string
}

export default function CockpitCardGrid({
  layout,
  children,
  minColumn = '22rem',
  className,
}: CockpitCardGridProps) {
  if (layout === 'sequential') {
    return <div className={cn('min-w-0 max-w-full space-y-4', className)}>{children}</div>
  }

  return (
    <div
      className={cn('grid min-w-0 max-w-full gap-4', className)}
      style={{
        gridTemplateColumns: `repeat(auto-fill, minmax(min(${minColumn}, 100%), 1fr))`,
      }}
    >
      {children}
    </div>
  )
}
