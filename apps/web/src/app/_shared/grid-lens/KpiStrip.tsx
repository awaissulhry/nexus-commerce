'use client'

import type { ComponentType, SVGProps } from 'react'
import { Card } from '@/components/ui/Card'

export type KpiTone =
  | 'slate'
  | 'rose'
  | 'rose-severe'
  | 'orange'
  | 'amber'
  | 'emerald'
  | 'blue'
  | 'violet'

const TONE_CLASS: Record<KpiTone, string> = {
  slate:        'bg-slate-50 dark:bg-slate-800 text-slate-600',
  rose:         'bg-rose-50 text-rose-600 dark:bg-rose-950/40 dark:text-rose-400',
  'rose-severe':'bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300',
  orange:       'bg-orange-50 text-orange-600 dark:bg-orange-950/40 dark:text-orange-400',
  amber:        'bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400',
  emerald:      'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400',
  blue:         'bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-400',
  violet:       'bg-violet-50 text-violet-600 dark:bg-violet-950/40 dark:text-violet-400',
}

export interface KpiTileSpec {
  /** lucide-react icon component */
  icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>
  /** Short uppercase header */
  label: string
  /** Primary big number (already formatted) */
  value: string
  /** Optional second-line context ("12 of 280 SKUs · 4%") */
  detail?: string
  tone: KpiTone
  /** When set, the tile becomes a button that fires this callback. */
  onClick?: () => void
  /** Optional ring class for "this needs attention" emphasis. */
  ringClass?: string
  /** Override aria-label for screen readers (defaults to label + value). */
  ariaLabel?: string
}

export interface KpiStripProps {
  tiles: ReadonlyArray<KpiTileSpec>
  /** Optional className applied to the outer grid container. */
  className?: string
}

/**
 * Compact KPI strip used at the top of grid workspaces. Mirrors the
 * /fulfillment/stock pattern: icon + label + big number + detail.
 * Tiles with onClick become buttons that drive a filter on the grid
 * below; tiles without are decorative. Default 4-up responsive grid.
 */
export function KpiStrip({ tiles, className }: KpiStripProps) {
  return (
    <div className={`grid grid-cols-2 md:grid-cols-4 gap-3 ${className ?? ''}`}>
      {tiles.map((tile, i) => {
        const Icon = tile.icon
        const inner = (
          <div className="flex items-start gap-3">
            <div className={`w-9 h-9 rounded-md inline-flex items-center justify-center flex-shrink-0 ${TONE_CLASS[tile.tone]}`}>
              <Icon size={16} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">{tile.label}</div>
              <div className="text-[20px] font-semibold tabular-nums text-slate-900 dark:text-slate-100 mt-0.5">{tile.value}</div>
              {tile.detail && (
                <div className="text-sm text-slate-500 dark:text-slate-400 mt-0.5 truncate">{tile.detail}</div>
              )}
            </div>
          </div>
        )
        if (tile.onClick) {
          return (
            <Card key={i} className={tile.ringClass}>
              <button
                type="button"
                onClick={tile.onClick}
                aria-label={tile.ariaLabel ?? `${tile.label}: ${tile.value}`}
                className="w-full text-left rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                {inner}
              </button>
            </Card>
          )
        }
        return (
          <Card key={i} className={tile.ringClass}>
            {inner}
          </Card>
        )
      })}
    </div>
  )
}
