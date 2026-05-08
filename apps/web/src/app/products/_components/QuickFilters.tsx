'use client'

/**
 * U.36 — quick-filters row.
 *
 * Pulls the four highest-frequency filter dimensions
 * (Status / Stock / Marketplace / Channels) out of the FilterBar
 * accordion so operators can apply them with zero clicks. The
 * accordion stays for advanced filters (Product type / Brand /
 * Tags / Fulfillment / Missing on…).
 *
 * Renders between HygieneStrip and the LensTabs. Hidden in the
 * recycle-bin scope (deleted rows aren't actionable for daily
 * filtering) and on non-grid lenses (those have their own UIs).
 *
 * Active-channel + active-marketplace lists mirror the FilterBar
 * fallbacks (per project memory: Amazon + eBay + Shopify only;
 * Xavia EU set IT/DE/FR/ES/UK).
 */

import { Filter } from 'lucide-react'

const ACTIVE_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY']
const ACTIVE_MARKETPLACES = ['IT', 'DE', 'FR', 'ES', 'UK']

const MARKETPLACE_LABELS: Record<string, string> = {
  IT: 'Italy',
  DE: 'Germany',
  FR: 'France',
  ES: 'Spain',
  UK: 'United Kingdom',
}

const CHANNEL_LABELS: Record<string, string> = {
  AMAZON: 'Amazon',
  EBAY: 'eBay',
  SHOPIFY: 'Shopify',
}

interface QuickFiltersProps {
  statusFilters: string[]
  stockLevel: string
  marketplaceFilters: string[]
  channelFilters: string[]
  updateUrl: (params: Record<string, string | undefined>) => void
}

function toggleArr(arr: string[], v: string) {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]
}

export function QuickFilters({
  statusFilters,
  stockLevel,
  marketplaceFilters,
  channelFilters,
  updateUrl,
}: QuickFiltersProps) {
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2 flex items-center gap-x-5 gap-y-2 flex-wrap">
      {/* Status — multi-select toggle chips. Matches the accordion's
          Status group; this surface just makes it always visible. */}
      <FilterPair label="Status">
        {(['ACTIVE', 'DRAFT', 'INACTIVE'] as const).map((s) => {
          const active = statusFilters.includes(s)
          return (
            <Chip
              key={s}
              active={active}
              onClick={() =>
                updateUrl({
                  status: toggleArr(statusFilters, s).join(',') || undefined,
                  page: undefined,
                })
              }
            >
              {s.charAt(0) + s.slice(1).toLowerCase()}
            </Chip>
          )
        })}
      </FilterPair>

      {/* Stock — single-select segmented (matches the existing
          stockLevel single-mode behavior). */}
      <FilterPair label="Stock">
        {(
          [
            { value: 'in', label: 'In' },
            { value: 'low', label: 'Low' },
            { value: 'out', label: 'Out' },
          ] as const
        ).map((opt) => {
          const active = stockLevel === opt.value
          return (
            <Chip
              key={opt.value}
              active={active}
              onClick={() =>
                updateUrl({
                  stockLevel: active ? undefined : opt.value,
                  page: undefined,
                })
              }
            >
              {opt.label}
            </Chip>
          )
        })}
      </FilterPair>

      {/* Marketplace — multi-select toggle chips. Static list from
          ACTIVE_MARKETPLACES; FilterBar accordion still merges in
          per-listing facet counts when available. */}
      <FilterPair label="Market">
        {ACTIVE_MARKETPLACES.map((m) => {
          const active = marketplaceFilters.includes(m)
          return (
            <Chip
              key={m}
              active={active}
              title={MARKETPLACE_LABELS[m] ?? m}
              onClick={() =>
                updateUrl({
                  marketplaces:
                    toggleArr(marketplaceFilters, m).join(',') || undefined,
                  page: undefined,
                })
              }
            >
              {m}
            </Chip>
          )
        })}
      </FilterPair>

      {/* Channel — multi-select toggle chips. */}
      <FilterPair label="Channel">
        {ACTIVE_CHANNELS.map((c) => {
          const active = channelFilters.includes(c)
          return (
            <Chip
              key={c}
              active={active}
              title={CHANNEL_LABELS[c] ?? c}
              onClick={() =>
                updateUrl({
                  channels:
                    toggleArr(channelFilters, c).join(',') || undefined,
                  page: undefined,
                })
              }
            >
              {CHANNEL_LABELS[c] ?? c}
            </Chip>
          )
        })}
      </FilterPair>

      {/* Hint that more filters live in the accordion below. */}
      <div className="ml-auto text-xs text-slate-400 dark:text-slate-500 inline-flex items-center gap-1">
        <Filter size={11} /> More in Filters below
      </div>
    </div>
  )
}

function FilterPair({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="inline-flex items-center gap-2">
      <span className="text-xs uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400">
        {label}
      </span>
      <div className="inline-flex items-center gap-1 flex-wrap">{children}</div>
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
      className={`min-h-11 sm:min-h-7 sm:h-7 px-2.5 text-sm border rounded-full inline-flex items-center transition-colors ${
        active
          ? 'bg-slate-900 text-white border-slate-900 dark:bg-slate-100 dark:text-slate-900 dark:border-slate-100'
          : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-700 dark:hover:bg-slate-800'
      }`}
    >
      {children}
    </button>
  )
}
