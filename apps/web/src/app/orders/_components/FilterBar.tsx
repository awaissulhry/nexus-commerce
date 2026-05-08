'use client'

/**
 * O.8e — extracted from OrdersWorkspace.tsx. The FilterBar is the
 * Grid lens's filter accordion: search input, "Filters" toggle, and
 * (when expanded) per-dimension multi-select chip groups for
 * channel / marketplace / status / fulfillment / review-status,
 * plus three boolean toggles (has-return / has-refund / review-
 * eligible).
 *
 * State stays in the URL via `updateUrl` (passed from
 * OrdersWorkspace). Keeping a multi-dimension accordion was a user
 * preference — see feedback memory: rolled back the single-dim
 * popover redesign (E.8 → E.20).
 */

import { ChevronDown, Filter, Search, X } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { COUNTRY_NAMES } from '@/lib/country-names'

type Facet = { value: string; count: number }
type Facets = {
  channels: Facet[]
  marketplaces: Facet[]
  fulfillment: Facet[]
}

interface FilterBarProps {
  searchInput: string
  setSearchInput: (v: string) => void
  channelFilters: string[]
  marketplaceFilters: string[]
  statusFilters: string[]
  fulfillmentFilters: string[]
  reviewStatusFilters: string[]
  hasReturn: string | null
  hasRefund: string | null
  reviewEligible: boolean
  filterCount: number
  filtersOpen: boolean
  setFiltersOpen: (v: boolean) => void
  facets: Facets | null
  updateUrl: (patch: Record<string, string | undefined>) => void
}

export function FilterBar(props: FilterBarProps) {
  const {
    searchInput,
    setSearchInput,
    channelFilters,
    marketplaceFilters,
    statusFilters,
    fulfillmentFilters,
    reviewStatusFilters,
    hasReturn,
    hasRefund,
    reviewEligible,
    filterCount,
    filtersOpen,
    setFiltersOpen,
    facets,
    updateUrl,
  } = props
  const toggleArr = (current: string[], val: string) =>
    current.includes(val)
      ? current.filter((v: string) => v !== val)
      : [...current, val]

  return (
    <Card>
      <div className="space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex-1 min-w-[240px] max-w-md relative">
            <Search
              size={12}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <Input
              placeholder="Search order ID, customer, email, SKU…"
              value={searchInput}
              onChange={(e: any) => setSearchInput(e.target.value)}
              className="pl-7"
            />
          </div>
          <button
            onClick={() => setFiltersOpen(!filtersOpen)}
            className={`h-8 px-3 text-base border rounded inline-flex items-center gap-1.5 ${
              filtersOpen || filterCount > 0
                ? 'border-slate-300 bg-slate-50'
                : 'border-slate-200 hover:bg-slate-50'
            }`}
          >
            <Filter size={12} />
            Filters
            {filterCount > 0 && (
              <span className="bg-slate-700 text-white text-xs px-1.5 py-0.5 rounded-full font-semibold">
                {filterCount}
              </span>
            )}
            <ChevronDown
              size={12}
              className={
                filtersOpen
                  ? 'rotate-180 transition-transform'
                  : 'transition-transform'
              }
            />
          </button>
          {filterCount > 0 && (
            <button
              onClick={() =>
                updateUrl({
                  channel: '',
                  marketplace: '',
                  status: '',
                  fulfillment: '',
                  reviewStatus: '',
                  hasReturn: undefined,
                  hasRefund: undefined,
                  reviewEligible: undefined,
                  customerEmail: undefined,
                  page: undefined,
                })
              }
              className="h-8 px-2 text-base text-slate-500 hover:text-slate-900 inline-flex items-center gap-1"
            >
              <X size={12} /> Clear
            </button>
          )}
        </div>
        {filtersOpen && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 pt-2 border-t border-slate-100">
            <FilterGroup
              label="Channel"
              options={['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY', 'MANUAL']}
              selected={channelFilters}
              counts={facets?.channels.reduce((m: any, s: Facet) => {
                m[s.value] = s.count
                return m
              }, {})}
              onToggle={(v: string) =>
                updateUrl({
                  channel: toggleArr(channelFilters, v).join(',') || undefined,
                  page: undefined,
                })
              }
            />
            {facets && facets.marketplaces.length > 0 && (
              <FilterGroup
                label="Marketplace"
                options={facets.marketplaces.map((m: Facet) => m.value)}
                selected={marketplaceFilters}
                counts={facets.marketplaces.reduce((m: any, s: Facet) => {
                  m[s.value] = s.count
                  return m
                }, {})}
                renderLabel={(v: string) => `${v} · ${COUNTRY_NAMES[v] ?? ''}`.trim()}
                onToggle={(v: string) =>
                  updateUrl({
                    marketplace: toggleArr(marketplaceFilters, v).join(',') || undefined,
                    page: undefined,
                  })
                }
              />
            )}
            <FilterGroup
              label="Status"
              options={['PENDING', 'SHIPPED', 'DELIVERED', 'CANCELLED']}
              selected={statusFilters}
              onToggle={(v: string) =>
                updateUrl({
                  status: toggleArr(statusFilters, v).join(',') || undefined,
                  page: undefined,
                })
              }
            />
            <FilterGroup
              label="Fulfillment"
              options={['FBA', 'FBM']}
              selected={fulfillmentFilters}
              counts={facets?.fulfillment.reduce((m: any, s: Facet) => {
                m[s.value] = s.count
                return m
              }, {})}
              onToggle={(v: string) =>
                updateUrl({
                  fulfillment: toggleArr(fulfillmentFilters, v).join(',') || undefined,
                  page: undefined,
                })
              }
            />
            <FilterGroup
              label="Review status"
              options={['ELIGIBLE', 'SCHEDULED', 'SENT', 'SUPPRESSED', 'FAILED', 'SKIPPED']}
              selected={reviewStatusFilters}
              onToggle={(v: string) =>
                updateUrl({
                  reviewStatus: toggleArr(reviewStatusFilters, v).join(',') || undefined,
                  page: undefined,
                })
              }
            />
            <div className="md:col-span-2 lg:col-span-3 flex items-center gap-2 flex-wrap pt-2 border-t border-slate-100">
              <ToggleChip
                active={hasReturn === 'true'}
                label="Has return"
                tone="warning"
                onClick={() =>
                  updateUrl({
                    hasReturn: hasReturn === 'true' ? undefined : 'true',
                    page: undefined,
                  })
                }
              />
              <ToggleChip
                active={hasRefund === 'true'}
                label="Has refund"
                tone="danger"
                onClick={() =>
                  updateUrl({
                    hasRefund: hasRefund === 'true' ? undefined : 'true',
                    page: undefined,
                  })
                }
              />
              <ToggleChip
                active={reviewEligible}
                label="Review-eligible (delivered, no return/refund, no prior request)"
                tone="success"
                onClick={() =>
                  updateUrl({
                    reviewEligible: reviewEligible ? undefined : 'true',
                    page: undefined,
                  })
                }
              />
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}

interface FilterGroupProps {
  label: string
  options: string[]
  selected: string[]
  onToggle: (v: string) => void
  counts?: Record<string, number>
  renderLabel?: (v: string) => string
}

function FilterGroup({
  label,
  options,
  selected,
  onToggle,
  counts,
  renderLabel,
}: FilterGroupProps) {
  if (options.length === 0) return null
  return (
    <div>
      <div className="text-sm font-semibold uppercase tracking-wider text-slate-500 mb-1.5">
        {label}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        {options.map((opt: string) => {
          const active = selected.includes(opt)
          const count = counts?.[opt]
          return (
            <button
              key={opt}
              onClick={() => onToggle(opt)}
              className={`h-7 px-2 text-sm border rounded inline-flex items-center gap-1.5 ${
                active
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300'
              }`}
            >
              {renderLabel ? renderLabel(opt) : opt}
              {count != null && (
                <span className={active ? 'text-slate-300' : 'text-slate-400'}>
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

interface ToggleChipProps {
  active: boolean
  label: string
  onClick: () => void
  tone: 'danger' | 'warning' | 'success'
}

function ToggleChip({ active, label, onClick, tone }: ToggleChipProps) {
  const cls = active
    ? {
        danger: 'bg-rose-50 text-rose-700 border-rose-300',
        warning: 'bg-amber-50 text-amber-700 border-amber-300',
        success: 'bg-emerald-50 text-emerald-700 border-emerald-300',
      }[tone]
    : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'
  return (
    <button
      onClick={onClick}
      className={`h-7 px-3 text-sm border rounded-full font-medium ${cls}`}
    >
      {label}
    </button>
  )
}
