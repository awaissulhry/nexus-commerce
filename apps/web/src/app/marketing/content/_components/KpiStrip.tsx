'use client'

// MC.1.1 — KPI strip for the DAM hub. Six tiles:
//   1. Total assets   2. Images   3. Videos
//   4. Storage used   5. In use   6. Needs attention
//
// Layout: 2 cols on mobile, 3 on tablet, 6 on desktop. Each tile is a
// Card + label + value + optional secondary line. Values are not
// links yet — MC.1.3 (filter sidebar) will wire `Needs attention` to
// a saved filter and `In use` / `Orphaned` to a usage filter.

import { type LucideIcon } from 'lucide-react'

interface TileProps {
  label: string
  value: string
  secondary?: string
  icon: LucideIcon
  tone?: 'default' | 'warn' | 'success'
}

const toneClasses: Record<NonNullable<TileProps['tone']>, string> = {
  default: 'text-slate-900 dark:text-slate-100',
  warn: 'text-amber-700 dark:text-amber-400',
  success: 'text-emerald-700 dark:text-emerald-400',
}

const iconToneClasses: Record<NonNullable<TileProps['tone']>, string> = {
  default: 'text-slate-400 dark:text-slate-500',
  warn: 'text-amber-500 dark:text-amber-400',
  success: 'text-emerald-500 dark:text-emerald-400',
}

function Tile({ label, value, secondary, icon: Icon, tone = 'default' }: TileProps) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3.5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400 truncate">
            {label}
          </p>
          <p className={`mt-1 text-xl font-semibold ${toneClasses[tone]}`}>
            {value}
          </p>
          {secondary && (
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 truncate">
              {secondary}
            </p>
          )}
        </div>
        <Icon className={`w-4 h-4 flex-shrink-0 ${iconToneClasses[tone]}`} />
      </div>
    </div>
  )
}

export interface KpiStripProps {
  tiles: TileProps[]
}

export default function KpiStrip({ tiles }: KpiStripProps) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {tiles.map((tile) => (
        <Tile key={tile.label} {...tile} />
      ))}
    </div>
  )
}
