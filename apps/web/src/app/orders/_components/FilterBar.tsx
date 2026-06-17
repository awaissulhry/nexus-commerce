'use client'

/**
 * O.8e — extracted from OrdersWorkspace.tsx. The FilterBar holds the
 * search input + always-visible Channel / Marketplace quick-pick
 * chips. All other filter dimensions (status, fulfillment, review-
 * status, has-return, has-refund, review-eligible, order-type, date-
 * range) live in the toolbar's FilterPopover + DateRangePicker, so
 * this bar stays small and the operator never has to choose between
 * "two different ways to set the same filter".
 *
 * History:
 *   - Original (O.8e) had a collapsible accordion with multi-select
 *     chips for every dimension. The toolbar FilterPopover landed in
 *     R.1 and duplicated those controls.
 *   - OX.2/OX.3 added the status tab strip and Date Range dropdown
 *     above the bar — making the accordion fully redundant.
 *   - Removed in the OX.16 follow-up: one canonical place per
 *     dimension. Operators with saved views continue to work — the
 *     URL state shape is unchanged.
 */

import { Search } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import {
  MultiSelectChips,
  ACTIVE_CHANNELS_OPTIONS,
  ACTIVE_MARKETPLACES_OPTIONS,
} from '@/components/ui/MultiSelectChips'
import { useTranslations } from '@/lib/i18n/use-translations'

interface FilterBarProps {
  searchInput: string
  setSearchInput: (v: string) => void
  channelFilters: string[]
  marketplaceFilters: string[]
  updateUrl: (patch: Record<string, string | undefined>) => void
}

export function FilterBar(props: FilterBarProps) {
  const { t } = useTranslations()
  const { searchInput, setSearchInput, channelFilters, marketplaceFilters, updateUrl } = props

  return (
    <Card>
      <div className="space-y-3">
        <div className="flex items-center gap-x-5 gap-y-2 flex-wrap pb-3 border-b border-subtle dark:border-slate-800">
          <MultiSelectChips
            label={t('orders.filter.group.channel')}
            options={ACTIVE_CHANNELS_OPTIONS}
            value={channelFilters}
            onChange={(next) =>
              updateUrl({
                channel: next.join(',') || undefined,
                page: undefined,
              })
            }
          />
          <MultiSelectChips
            label={t('orders.filter.group.marketplace')}
            options={ACTIVE_MARKETPLACES_OPTIONS}
            value={marketplaceFilters}
            onChange={(next) =>
              updateUrl({
                marketplace: next.join(',') || undefined,
                page: undefined,
              })
            }
          />
        </div>
        <div className="relative max-w-md">
          <Search
            size={12}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-tertiary"
          />
          <Input
            id="orders-search"
            placeholder={t('orders.search.placeholder')}
            value={searchInput}
            onChange={(e: any) => setSearchInput(e.target.value)}
            className="pl-7"
          />
        </div>
      </div>
    </Card>
  )
}
