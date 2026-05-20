'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Filter, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChannelCode, InsightsFilterState } from './types'

const CHANNEL_LABELS: Record<ChannelCode, string> = {
  AMAZON: 'Amazon',
  EBAY: 'eBay',
  SHOPIFY: 'Shopify',
}

const MARKET_LABELS: Record<string, string> = {
  IT: 'Italy',
  DE: 'Germany',
  FR: 'France',
  ES: 'Spain',
  UK: 'UK',
  US: 'USA',
  NL: 'Netherlands',
  BE: 'Belgium',
  AT: 'Austria',
  CH: 'Switzerland',
  IE: 'Ireland',
  PL: 'Poland',
  SE: 'Sweden',
  TR: 'Turkey',
}

interface Props {
  channels: ChannelCode[]
  markets: string[]
  brands: string[]
  availableChannels: ChannelCode[]
  availableMarkets: string[]
  availableBrands: string[]
  onChange: (patch: Partial<InsightsFilterState>) => void
}

export function ChannelMarketFilter({
  channels,
  markets,
  brands,
  availableChannels,
  availableMarkets,
  availableBrands,
  onChange,
}: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const activeCount = channels.length + markets.length + brands.length

  function toggle<T extends string>(list: T[], item: T): T[] {
    return list.includes(item) ? list.filter((x) => x !== item) : [...list, item]
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex items-center gap-1.5 h-7 px-2.5 text-sm rounded-md border bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
          activeCount > 0
            ? 'border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300'
            : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300',
        )}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Filter className="w-3.5 h-3.5" />
        Filters
        {activeCount > 0 && (
          <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-semibold rounded-full bg-blue-600 text-white">
            {activeCount}
          </span>
        )}
        <ChevronDown className="w-3 h-3 opacity-70" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Insights filters"
          className="absolute right-0 top-full mt-1 z-30 w-80 max-h-[70vh] overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg"
        >
          <Section title="Channels">
            <div className="flex flex-wrap gap-1">
              {availableChannels.map((c) => {
                const on = channels.includes(c)
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() =>
                      onChange({ channels: toggle(channels, c) })
                    }
                    className={cn(
                      'inline-flex items-center gap-1 h-6 px-2 text-xs rounded-md border',
                      on
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                        : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800',
                    )}
                  >
                    {CHANNEL_LABELS[c]}
                    {on && <X className="w-3 h-3" />}
                  </button>
                )
              })}
            </div>
          </Section>
          <Section title="Markets">
            <div className="flex flex-wrap gap-1">
              {availableMarkets.map((m) => {
                const on = markets.includes(m)
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() =>
                      onChange({ markets: toggle(markets, m) })
                    }
                    className={cn(
                      'inline-flex items-center gap-1 h-6 px-2 text-xs rounded-md border',
                      on
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                        : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800',
                    )}
                  >
                    {MARKET_LABELS[m] ?? m}
                    {on && <X className="w-3 h-3" />}
                  </button>
                )
              })}
            </div>
          </Section>
          {availableBrands.length > 0 && (
            <Section title="Brands">
              <div className="flex flex-wrap gap-1">
                {availableBrands.map((b) => {
                  const on = brands.includes(b)
                  return (
                    <button
                      key={b}
                      type="button"
                      onClick={() =>
                        onChange({ brands: toggle(brands, b) })
                      }
                      className={cn(
                        'inline-flex items-center gap-1 h-6 px-2 text-xs rounded-md border',
                        on
                          ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                          : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800',
                      )}
                    >
                      {b}
                      {on && <X className="w-3 h-3" />}
                    </button>
                  )
                })}
              </div>
            </Section>
          )}
          {activeCount > 0 && (
            <div className="border-t border-slate-200 dark:border-slate-700 px-3 py-2">
              <button
                type="button"
                onClick={() =>
                  onChange({ channels: [], markets: [], brands: [] })
                }
                className="text-xs text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100"
              >
                Clear all filters
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 last:border-b-0">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1.5">
        {title}
      </div>
      {children}
    </div>
  )
}
