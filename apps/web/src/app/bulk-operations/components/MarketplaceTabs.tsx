'use client'

import { useMemo } from 'react'
import { Globe } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { MarketplaceOption } from './MarketplaceSelector'

interface Props {
  options: MarketplaceOption[]
  /** `${channel}:${code}` of the currently primary target, or null
   *  for master view (no primary). */
  primaryKey: string | null
  onSelect: (
    channel: 'AMAZON' | 'EBAY' | null,
    marketplace: string,
  ) => void
}

/**
 * T.7 — quick-switch tabs for the active primary marketplace context.
 * Pulls from the same MarketplaceOption list the multi-select selector
 * uses, so adding a new marketplace there flows through here too.
 * Channels render in a fixed order (Amazon first, then eBay,
 * Shopify, etc.) so positions stay stable as the seller adds tabs.
 */
const CHANNEL_ORDER: ReadonlyArray<MarketplaceOption['channel']> = [
  'AMAZON',
  'EBAY',
]

export default function MarketplaceTabs({
  options,
  primaryKey,
  onSelect,
}: Props) {
  // Group + order channels deterministically. Marketplaces inside a
  // channel sort alphabetically by code.
  const grouped = useMemo(() => {
    const byChannel = new Map<MarketplaceOption['channel'], MarketplaceOption[]>()
    for (const o of options) {
      const arr = byChannel.get(o.channel) ?? []
      arr.push(o)
      byChannel.set(o.channel, arr)
    }
    for (const arr of byChannel.values()) arr.sort((a, b) => a.code.localeCompare(b.code))
    const orderedChannels = [
      ...CHANNEL_ORDER.filter((c) => byChannel.has(c)),
      ...Array.from(byChannel.keys()).filter(
        (c) => !CHANNEL_ORDER.includes(c),
      ),
    ]
    return orderedChannels.map((channel) => ({
      channel,
      marketplaces: byChannel.get(channel) ?? [],
    }))
  }, [options])

  if (options.length === 0) return null

  const isMaster = primaryKey === null

  return (
    <div className="flex-shrink-0 mb-2 flex items-center gap-1 overflow-x-auto border-b border-slate-200">
      <TabBtn
        active={isMaster}
        onClick={() => onSelect(null, '')}
        title="Master view — no marketplace context. Channel-prefixed columns become read-only placeholders."
      >
        <Globe className="w-3 h-3" />
        Master
      </TabBtn>
      {grouped.map(({ channel, marketplaces }) =>
        marketplaces.map((m) => {
          const key = `${m.channel}:${m.code}`
          return (
            <TabBtn
              key={key}
              active={primaryKey === key}
              onClick={() => onSelect(m.channel, m.code)}
              title={`${m.name} — ${m.currency} · ${m.language.toUpperCase()}`}
            >
              <span className="font-mono">{m.code}</span>
              <span className="text-slate-400 text-[10px] uppercase">
                {channel === 'AMAZON' ? 'amz' : 'ebay'}
              </span>
            </TabBtn>
          )
        }),
      )}
    </div>
  )
}

function TabBtn({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean
  onClick: () => void
  title?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'flex-shrink-0 inline-flex items-center gap-1.5 h-7 px-3 text-[12px] font-medium border-b-2 -mb-px transition-colors',
        active
          ? 'border-blue-600 text-blue-700 bg-white'
          : 'border-transparent text-slate-600 hover:text-slate-900 hover:bg-slate-50',
      )}
    >
      {children}
    </button>
  )
}
