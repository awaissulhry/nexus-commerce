'use client'

// UC.1.3 / UC.3.A — Shared preview band primitive (Zone 2).
//
// Collapsible band pairing a live preview (left) with a health surface
// (right). Faithful to the Amazon band: title + subtitle on the left of
// the toggle bar, chevron on the right, and a two-column content grid
// whose right column width is configurable (Amazon 320px panel, eBay
// 280px rail). The preview + health renderers are slots so UC.7 / UC.8
// can swap in the shared frameworks behind them.

import type { ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/Card'

export interface CockpitPreviewBandProps {
  open: boolean
  onToggle: () => void
  /** Title text/label, e.g. "Live preview". */
  title: ReactNode
  /** Muted subtitle next to the title (e.g. the market code). */
  subtitle?: ReactNode
  /** Device toggle ([📱][💻]) — rendered next to the subtitle. */
  deviceToggle?: ReactNode
  /** The live preview renderer. */
  preview: ReactNode
  /** The health renderer (donut / rail / panel). Optional. */
  health?: ReactNode
  /** Fixed width of the health column on lg+ (e.g. "320px", "280px"). */
  healthWidth?: string
  /** Extra classes for the content area (e.g. a bg tint). */
  contentClassName?: string
}

export default function CockpitPreviewBand({
  open,
  onToggle,
  title,
  subtitle,
  deviceToggle,
  preview,
  health,
  healthWidth = '320px',
  contentClassName,
}: CockpitPreviewBandProps) {
  return (
    <Card noPadding>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full px-4 py-2.5 flex items-center justify-between text-left border-b border-slate-100 dark:border-slate-800"
      >
        <div className="flex items-center gap-2">
          <span className="text-md font-medium text-slate-900 dark:text-slate-100">
            {title}
          </span>
          {subtitle && (
            <span className="text-xs text-slate-500 dark:text-slate-400">{subtitle}</span>
          )}
          {deviceToggle}
        </div>
        {open ? (
          <ChevronUp className="w-4 h-4 text-slate-400" />
        ) : (
          <ChevronDown className="w-4 h-4 text-slate-400" />
        )}
      </button>

      {open && (
        <div
          className={cn('p-4 gap-4', health ? 'grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_var(--health-w)]' : 'block', contentClassName)}
          style={health ? ({ ['--health-w' as string]: healthWidth } as React.CSSProperties) : undefined}
        >
          <div className="min-w-0 max-w-full">{preview}</div>
          {health && <div className="min-w-0">{health}</div>}
        </div>
      )}
    </Card>
  )
}
