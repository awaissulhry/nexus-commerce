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
 * U.67 — migrated to the shared MultiSelectChips primitive so the
 * [All]-chip-clears-all pattern matches every other workspace.
 */

import { Filter } from 'lucide-react'
import {
  MultiSelectChips,
  ACTIVE_CHANNELS_OPTIONS,
  ACTIVE_MARKETPLACES_OPTIONS,
} from '@/components/ui/MultiSelectChips'
import { useTranslations } from '@/lib/i18n/use-translations'

interface QuickFiltersProps {
  statusFilters: string[]
  stockLevel: string
  marketplaceFilters: string[]
  channelFilters: string[]
  updateUrl: (params: Record<string, string | undefined>) => void
}

export function QuickFilters({
  statusFilters,
  stockLevel,
  marketplaceFilters,
  channelFilters,
  updateUrl,
}: QuickFiltersProps) {
  const { t } = useTranslations()
  const STATUS_OPTIONS = [
    { value: 'ACTIVE', label: t('products.status.active') },
    { value: 'DRAFT', label: t('products.status.draft') },
    { value: 'INACTIVE', label: t('products.status.inactive') },
  ]
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2 flex items-center gap-x-5 gap-y-2 flex-wrap">
      <MultiSelectChips
        label={t('products.quickFilters.status')}
        options={STATUS_OPTIONS}
        value={statusFilters}
        onChange={(next) =>
          updateUrl({
            status: next.join(',') || undefined,
            page: undefined,
          })
        }
      />

      {/* Stock — single-select segmented (matches the existing
          stockLevel single-mode behaviour). Implemented inline because
          MultiSelectChips is multi-select; stock has no [All] equivalent
          (empty already means "any stock"). */}
      <StockSingleSelect
        value={stockLevel}
        onChange={(v) =>
          updateUrl({ stockLevel: v || undefined, page: undefined })
        }
      />

      <MultiSelectChips
        label={t('products.quickFilters.market')}
        options={ACTIVE_MARKETPLACES_OPTIONS}
        value={marketplaceFilters}
        onChange={(next) =>
          updateUrl({
            marketplaces: next.join(',') || undefined,
            page: undefined,
          })
        }
      />

      <MultiSelectChips
        label={t('products.quickFilters.channel')}
        options={ACTIVE_CHANNELS_OPTIONS}
        value={channelFilters}
        onChange={(next) =>
          updateUrl({
            channels: next.join(',') || undefined,
            page: undefined,
          })
        }
      />

      {/* Hint that more filters live in the accordion below. */}
      <div className="ml-auto text-xs text-slate-500 dark:text-slate-400 inline-flex items-center gap-1">
        <Filter size={11} /> {t('products.quickFilters.moreHint')}
      </div>
    </div>
  )
}

function StockSingleSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const { t } = useTranslations()
  const opts = [
    { value: 'in', label: t('products.quickFilters.stock.in') },
    { value: 'low', label: t('products.quickFilters.stock.low') },
    { value: 'out', label: t('products.quickFilters.stock.out') },
  ]
  return (
    <div className="inline-flex items-center gap-2">
      <span className="text-xs uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400">
        {t('products.quickFilters.stock')}
      </span>
      <div className="inline-flex items-center gap-1 flex-wrap">
        <Pill
          active={!value}
          onClick={() => onChange('')}
          title={t('products.quickFilters.stock.allTitle')}
        >
          {t('products.quickFilters.stock.all')}
        </Pill>
        {opts.map((opt) => {
          const active = value === opt.value
          return (
            <Pill
              key={opt.value}
              active={active}
              onClick={() => onChange(active ? '' : opt.value)}
            >
              {opt.label}
            </Pill>
          )
        })}
      </div>
    </div>
  )
}

function Pill({
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
