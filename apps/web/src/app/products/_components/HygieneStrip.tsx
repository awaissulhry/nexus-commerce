'use client'

/**
 * U.27 — catalog hygiene KPI strip.
 *
 * Surfaces the four hygiene gaps as one-click filter chips at the top
 * of /products. Driven by the B.2 audit finding that on Xavia's live
 * catalog (2026-05-08) 98% of products are missing brand, 100% have
 * poor description, and 100% have no GTIN — without this strip those
 * gaps are buried inside the Filters accordion and the daily "fix
 * what needs work" loop is friction-heavy.
 *
 * Each chip:
 *   - Shows the count of products missing that field
 *   - Tone is rose when count > 0 (call to action), slate when 0 (done)
 *   - Click → applies the corresponding `has<Field>=false` URL param,
 *     so the grid below filters to exactly those rows
 *   - Active state when the param is already 'false' (operator can
 *     click again to clear)
 *   - Hidden entirely when facets aren't loaded yet
 *
 * Lives above the FilterBar; hidden in the recycle-bin scope (deleted
 * rows aren't actionable for hygiene).
 */

import { AlertCircle, CheckCircle2 } from 'lucide-react'

interface HygieneCounts {
  total: number
  missingPhotos: number
  missingDescription: number
  missingBrand: number
  missingGtin: number
}

interface HygieneStripProps {
  hygiene: HygieneCounts | undefined
  hasPhotos: string | null | undefined
  hasDescription: string | null | undefined
  hasBrand: string | null | undefined
  hasGtin: string | null | undefined
  updateUrl: (params: Record<string, string | undefined>) => void
}

export function HygieneStrip({
  hygiene,
  hasPhotos,
  hasDescription,
  hasBrand,
  hasGtin,
  updateUrl,
}: HygieneStripProps) {
  if (!hygiene) return null

  const chips: Array<{
    key: string
    label: string
    count: number
    active: boolean
    paramKey: 'hasPhotos' | 'hasDescription' | 'hasBrand' | 'hasGtin'
  }> = [
    {
      key: 'photos',
      label: 'photos',
      count: hygiene.missingPhotos,
      active: hasPhotos === 'false',
      paramKey: 'hasPhotos',
    },
    {
      key: 'description',
      label: 'description',
      count: hygiene.missingDescription,
      active: hasDescription === 'false',
      paramKey: 'hasDescription',
    },
    {
      key: 'brand',
      label: 'brand',
      count: hygiene.missingBrand,
      active: hasBrand === 'false',
      paramKey: 'hasBrand',
    },
    {
      key: 'gtin',
      label: 'GTIN',
      count: hygiene.missingGtin,
      active: hasGtin === 'false',
      paramKey: 'hasGtin',
    },
  ]

  // Total tally for the header. When everything is at 0, the strip
  // collapses to a single "Catalog hygiene complete" badge.
  const totalGap =
    hygiene.missingPhotos +
    hygiene.missingDescription +
    hygiene.missingBrand +
    hygiene.missingGtin
  if (totalGap === 0) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 text-sm w-fit">
        <CheckCircle2 size={14} />
        <span className="font-medium">Catalog hygiene complete</span>
        <span className="text-emerald-700 dark:text-emerald-400">
          across {hygiene.total} products
        </span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="inline-flex items-center gap-1.5 text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
        <AlertCircle size={12} className="text-rose-500" />
        Hygiene gaps
      </div>
      {chips.map((c) => {
        const empty = c.count === 0
        const tone = empty
          ? 'border-slate-200 bg-white text-slate-400 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-500'
          : c.active
            ? 'border-rose-500 bg-rose-100 text-rose-800 dark:border-rose-400 dark:bg-rose-950/60 dark:text-rose-200'
            : 'border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300 dark:hover:bg-rose-900/40'
        return (
          <button
            key={c.key}
            type="button"
            onClick={() =>
              updateUrl({
                [c.paramKey]: c.active ? undefined : 'false',
                page: undefined,
              })
            }
            disabled={empty}
            aria-pressed={c.active}
            title={
              empty
                ? `Every product has ${c.label}`
                : c.active
                  ? `Clear filter — show all`
                  : `Show only the ${c.count} product${c.count === 1 ? '' : 's'} missing ${c.label}`
            }
            className={`min-h-11 sm:min-h-0 sm:h-7 px-3 text-sm border rounded-full inline-flex items-center gap-1.5 transition-colors disabled:cursor-not-allowed ${tone}`}
          >
            <span className="font-semibold tabular-nums">{c.count}</span>
            <span className="font-normal">missing {c.label}</span>
            {c.active && (
              <span className="text-xs ml-0.5 opacity-80">(active)</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
