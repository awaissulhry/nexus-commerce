'use client'

// UC.1.3 / UC.3.A — Shared card layout primitive (Zone 3).
//
// Two layouts cover both cockpits:
//   • 'grid'       — Amazon's responsive 2-up card grid
//                    (grid-cols-1 lg:grid-cols-2 gap-3).
//   • 'sequential' — eBay's full-width stacked cards (space-y-4).
//
// Cards pass through verbatim; this primitive only owns spacing + the
// overflow-safe min-w-0 track. Jump-to-card targeting (data-jump-target)
// stays on the individual cards.

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface CockpitCardGridProps {
  layout: 'grid' | 'sequential'
  children: ReactNode
  className?: string
}

export default function CockpitCardGrid({
  layout,
  children,
  className,
}: CockpitCardGridProps) {
  if (layout === 'sequential') {
    return <div className={cn('min-w-0 max-w-full space-y-4', className)}>{children}</div>
  }

  return (
    <div className={cn('grid grid-cols-1 lg:grid-cols-2 gap-3 min-w-0', className)}>
      {children}
    </div>
  )
}
