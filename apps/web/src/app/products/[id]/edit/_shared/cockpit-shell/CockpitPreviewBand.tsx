'use client'

// UC.1.3 — Shared preview band primitive (Zone 2).
//
// Collapsible band that pairs a live preview (left) with a health
// surface (right). `healthVariant` covers both cockpits without
// compromise:
//   • 'panel' — health flows beside the preview, flexible width
//               (Amazon's current layout)
//   • 'rail'  — fixed-width right rail (eBay's HealthScoreRail)
//
// When collapsed it shrinks to just the title bar so the cards rise up.
// The actual preview + health renderers are slots; UC.7 / UC.8 swap in
// the shared health/preview frameworks behind these slots later.

import type { ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/Card'

export interface CockpitPreviewBandProps {
  open: boolean
  onToggle: () => void
  /** Title text/label, e.g. "Live preview". */
  title: ReactNode
  /** Device toggle ([📱][💻]) rendered next to the title. */
  deviceToggle?: ReactNode
  /** The live preview renderer. */
  preview: ReactNode
  /** The health renderer (donut / rail / panel). Optional. */
  health?: ReactNode
  /** How the health column sits beside the preview. */
  healthVariant?: 'panel' | 'rail'
}

export default function CockpitPreviewBand({
  open,
  onToggle,
  title,
  deviceToggle,
  preview,
  health,
  healthVariant = 'panel',
}: CockpitPreviewBandProps) {
  return (
    <Card noPadding>
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="inline-flex items-center gap-1 text-sm font-medium text-slate-700 hover:text-slate-900 dark:text-slate-200 dark:hover:text-white"
        >
          {open ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
          {title}
        </button>
        {deviceToggle && <div className="ml-2">{deviceToggle}</div>}
      </div>

      {open && (
        <div
          className={cn(
            'gap-4 border-t border-slate-100 p-3 dark:border-slate-800',
            health
              ? healthVariant === 'rail'
                ? 'grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_280px]'
                : 'grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]'
              : 'block',
          )}
        >
          <div className="min-w-0">{preview}</div>
          {health && <div className="min-w-0">{health}</div>}
        </div>
      )}
    </Card>
  )
}
