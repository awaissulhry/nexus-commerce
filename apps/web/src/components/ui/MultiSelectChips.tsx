'use client'

/**
 * U.67 — shared multi-select chip row.
 *
 * Pattern: a leading [All] chip + N option chips.
 *   - When `value` is empty, [All] is bold/active and option chips are
 *     muted. State means "no filter — show everything."
 *   - Clicking [All] clears the array (returns to "show everything").
 *   - Clicking an option chip toggles it in/out of the array.
 *   - Clicking the only-active option chip clears the array, falling
 *     back to [All].
 *
 * Used by QuickFilters on every workspace page (/products, /listings,
 * /orders, /pricing, /fulfillment/*) so the multi-select UX stays
 * identical everywhere.
 */

import { cn } from '@/lib/utils'

export interface MultiSelectChipsOption {
  value: string
  label?: string
  /** Optional title attribute for hover tooltip. */
  title?: string
}

interface Props {
  /** Display label rendered before the chip row (e.g. "MARKET"). */
  label: string
  options: MultiSelectChipsOption[]
  /** Selected values. Empty = "all" (the [All] chip is active). */
  value: string[]
  onChange: (next: string[]) => void
  /** Optional override for the [All] chip text. */
  allLabel?: string
  /** Hide the [All] chip when single-select semantics are wanted. */
  hideAll?: boolean
  /**
   * 'multi' (default): clicking a chip toggles it in/out of the array.
   * 'single': clicking a chip REPLACES the array with [value]; clicking
   *   the only-active chip or the [All] chip clears it back to [].
   *   Use 'single' when the downstream consumer is single-value
   *   (single backend column / single URL param).
   */
  mode?: 'multi' | 'single'
  className?: string
}

export function MultiSelectChips({
  label,
  options,
  value,
  onChange,
  allLabel = 'All',
  hideAll = false,
  mode = 'multi',
  className,
}: Props) {
  const noneSelected = value.length === 0

  const toggle = (v: string) => {
    if (mode === 'single') {
      // Replace semantics: click X → [X]; click X again → [].
      onChange(value.includes(v) ? [] : [v])
      return
    }
    if (value.includes(v)) {
      // Removing the only-active chip → return to [All].
      onChange(value.filter((x) => x !== v))
    } else {
      onChange([...value, v])
    }
  }

  return (
    <div className={cn('inline-flex items-center gap-2', className)}>
      <span className="text-xs uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400">
        {label}
      </span>
      <div className="inline-flex items-center gap-1 flex-wrap">
        {!hideAll && (
          <Chip
            active={noneSelected}
            onClick={() => onChange([])}
            title={`Show all ${label.toLowerCase()}`}
          >
            {allLabel}
          </Chip>
        )}
        {options.map((opt) => {
          const active = value.includes(opt.value)
          return (
            <Chip
              key={opt.value}
              active={active}
              title={opt.title}
              onClick={() => toggle(opt.value)}
            >
              {opt.label ?? opt.value}
            </Chip>
          )
        })}
      </div>
    </div>
  )
}

function Chip({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean
  title?: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        'min-h-11 sm:min-h-7 sm:h-7 px-2.5 text-sm border rounded-full inline-flex items-center transition-colors',
        active
          ? 'bg-slate-900 text-white border-slate-900 dark:bg-slate-100 dark:text-slate-900 dark:border-slate-100'
          : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-700 dark:hover:bg-slate-800',
      )}
    >
      {children}
    </button>
  )
}

/**
 * Canonical option lists. Per project memory: only Amazon + eBay +
 * Shopify in scope; Xavia EU set IT/DE/FR/ES/UK.
 */
export const ACTIVE_CHANNELS_OPTIONS: MultiSelectChipsOption[] = [
  { value: 'AMAZON', label: 'Amazon' },
  { value: 'EBAY', label: 'eBay' },
  { value: 'SHOPIFY', label: 'Shopify' },
]

export const ACTIVE_MARKETPLACES_OPTIONS: MultiSelectChipsOption[] = [
  { value: 'IT', label: 'IT', title: 'Italy' },
  { value: 'DE', label: 'DE', title: 'Germany' },
  { value: 'FR', label: 'FR', title: 'France' },
  { value: 'ES', label: 'ES', title: 'Spain' },
  { value: 'UK', label: 'UK', title: 'United Kingdom' },
]
