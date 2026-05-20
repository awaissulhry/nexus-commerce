'use client'

import { AlignJustify, Menu as MenuIcon, Equal } from 'lucide-react'

export type Density = 'compact' | 'comfortable' | 'spacious'

export interface DensityToggleProps {
  density: Density
  onChange: (d: Density) => void
  /** Optional className applied to the outer container for layout. */
  className?: string
}

const OPTIONS: ReadonlyArray<{ value: Density; Icon: typeof AlignJustify; label: string }> = [
  { value: 'compact',     Icon: AlignJustify, label: 'Compact row density' },
  { value: 'comfortable', Icon: MenuIcon,     label: 'Comfortable row density' },
  { value: 'spacious',    Icon: Equal,        label: 'Spacious row density' },
]

/**
 * Segmented density selector. Three icons side-by-side; the active one
 * is highlighted. Used in workspace headers across /products,
 * /listings, /fulfillment/stock, /fulfillment/replenishment so the
 * row-density preference is visible (not buried in a "..." menu).
 */
export function DensityToggle({ density, onChange, className }: DensityToggleProps) {
  return (
    <div
      className={`inline-flex items-center border border-slate-200 dark:border-slate-700 rounded-md overflow-hidden h-8 text-sm ${className ?? ''}`}
      role="group"
      aria-label="Row density"
    >
      {OPTIONS.map(({ value, Icon, label }) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          title={label}
          aria-label={label}
          aria-pressed={density === value}
          className={`px-2 h-full inline-flex items-center justify-center ${
            density === value
              ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
              : 'bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800'
          }`}
        >
          <Icon className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      ))}
    </div>
  )
}
