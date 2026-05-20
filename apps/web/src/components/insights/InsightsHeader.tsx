'use client'

import { useCallback, useMemo } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Download, RefreshCw } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { cn } from '@/lib/utils'
import { ChannelMarketFilter } from './ChannelMarketFilter'
import type {
  ChannelCode,
  CompareKey,
  InsightsFilterState,
  WindowKey,
} from './types'

const WINDOWS: { id: WindowKey; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
  { id: '90d', label: '90d' },
  { id: 'mtd', label: 'MTD' },
  { id: 'qtd', label: 'QTD' },
  { id: 'ytd', label: 'YTD' },
  { id: 'custom', label: 'Custom' },
]

const COMPARES: { id: CompareKey; label: string }[] = [
  { id: 'prev', label: 'vs Prev' },
  { id: 'wow', label: 'WoW' },
  { id: 'mom', label: 'MoM' },
  { id: 'yoy', label: 'YoY' },
  { id: 'none', label: 'None' },
]

const ALL_CHANNELS: ChannelCode[] = ['AMAZON', 'EBAY', 'SHOPIFY']

const PRIMARY_MARKETS = ['IT', 'DE', 'FR', 'ES', 'UK', 'US']

export function readFilterState(
  params: URLSearchParams,
): InsightsFilterState {
  const channels = (params.get('channels') ?? '')
    .split(',')
    .filter(Boolean)
    .filter((c): c is ChannelCode => ALL_CHANNELS.includes(c as ChannelCode))
  const markets = (params.get('markets') ?? '').split(',').filter(Boolean)
  const brands = (params.get('brands') ?? '').split(',').filter(Boolean)
  return {
    window: (params.get('window') as WindowKey) || '30d',
    from: params.get('from'),
    to: params.get('to'),
    compare: (params.get('compare') as CompareKey) || 'prev',
    channels,
    markets,
    brands,
  }
}

export function serializeFilterState(
  state: Partial<InsightsFilterState>,
  base: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(base.toString())
  if (state.window) next.set('window', state.window)
  if (state.from) next.set('from', state.from)
  else if (state.from === null) next.delete('from')
  if (state.to) next.set('to', state.to)
  else if (state.to === null) next.delete('to')
  if (state.compare) next.set('compare', state.compare)
  if (state.channels) {
    if (state.channels.length === 0) next.delete('channels')
    else next.set('channels', state.channels.join(','))
  }
  if (state.markets) {
    if (state.markets.length === 0) next.delete('markets')
    else next.set('markets', state.markets.join(','))
  }
  if (state.brands) {
    if (state.brands.length === 0) next.delete('brands')
    else next.set('brands', state.brands.join(','))
  }
  return next
}

interface InsightsHeaderProps {
  title: string
  description?: string
  filterState: InsightsFilterState
  availableBrands?: string[]
  availableMarkets?: string[]
  refreshing?: boolean
  onRefresh?: () => void
  onExport?: () => void
  exportLabel?: string
  rightExtra?: React.ReactNode
}

export function InsightsHeader({
  title,
  description,
  filterState,
  availableBrands = [],
  availableMarkets = PRIMARY_MARKETS,
  refreshing = false,
  onRefresh,
  onExport,
  exportLabel = 'Export',
  rightExtra,
}: InsightsHeaderProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const update = useCallback(
    (patch: Partial<InsightsFilterState>) => {
      const base = new URLSearchParams(searchParams?.toString() ?? '')
      const next = serializeFilterState(patch, base)
      router.replace(`${pathname}?${next.toString()}`, { scroll: false })
    },
    [pathname, router, searchParams],
  )

  const customActive = filterState.window === 'custom'

  const actions = useMemo(
    () => (
      <div className="flex items-center gap-2 flex-wrap">
        <div
          role="tablist"
          aria-label="Time window"
          className="inline-flex items-center border border-slate-200 dark:border-slate-700 rounded-md p-0.5 bg-white dark:bg-slate-900"
        >
          {WINDOWS.map((w) => (
            <button
              key={w.id}
              type="button"
              role="tab"
              aria-selected={w.id === filterState.window}
              onClick={() => update({ window: w.id })}
              className={cn(
                'h-6 px-2.5 text-sm rounded transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
                w.id === filterState.window
                  ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-semibold'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100',
              )}
            >
              {w.label}
            </button>
          ))}
        </div>
        {customActive && (
          <div className="inline-flex items-center gap-1">
            <input
              type="date"
              aria-label="From"
              value={filterState.from ?? ''}
              max={filterState.to ?? undefined}
              onChange={(e) => update({ from: e.target.value || null })}
              className="h-7 px-2 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            />
            <span className="text-xs text-slate-400">→</span>
            <input
              type="date"
              aria-label="To"
              value={filterState.to ?? ''}
              min={filterState.from ?? undefined}
              onChange={(e) => update({ to: e.target.value || null })}
              className="h-7 px-2 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            />
          </div>
        )}
        <select
          aria-label="Comparison period"
          value={filterState.compare}
          onChange={(e) => update({ compare: e.target.value as CompareKey })}
          className="h-7 px-2 pr-7 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
        >
          {COMPARES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <ChannelMarketFilter
          channels={filterState.channels}
          markets={filterState.markets}
          brands={filterState.brands}
          availableChannels={ALL_CHANNELS}
          availableMarkets={availableMarkets}
          availableBrands={availableBrands}
          onChange={(patch) => update(patch)}
        />
        {rightExtra}
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 h-7 px-2.5 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
            Refresh
          </button>
        )}
        {onExport && (
          <button
            type="button"
            onClick={onExport}
            className="inline-flex items-center gap-1.5 h-7 px-2.5 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          >
            <Download className="w-3.5 h-3.5" />
            {exportLabel}
          </button>
        )}
      </div>
    ),
    [
      filterState,
      customActive,
      availableBrands,
      availableMarkets,
      onRefresh,
      onExport,
      exportLabel,
      refreshing,
      rightExtra,
      update,
    ],
  )

  return <PageHeader title={title} description={description} actions={actions} />
}
