'use client'

/**
 * ChannelStrip — channel switcher integrated into the flat file header.
 *
 * Sits as the first child inside the sticky <header> in both flat file
 * pages so it never scrolls away. Shows Amazon and eBay as a compact
 * segmented control; clicking either switches to that channel's flat
 * file while preserving the current ?marketplace= param.
 */

import { useRouter } from 'next/navigation'
import { ShoppingCart, Tag } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  channel: 'amazon' | 'ebay'
  marketplace: string
  familyId?: string
}

const CHANNELS = [
  {
    id: 'amazon' as const,
    label: 'Amazon',
    // ShoppingCart is clean, universally recognised as Amazon, no circle
    Icon: ShoppingCart,
    iconCls: 'text-orange-500',
    activeCls: 'bg-orange-50 dark:bg-orange-950/40 text-orange-700 dark:text-orange-300 border-orange-200 dark:border-orange-800',
    inactiveCls: 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/60',
  },
  {
    id: 'ebay' as const,
    label: 'eBay',
    Icon: Tag,
    iconCls: 'text-blue-500',
    activeCls: 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800',
    inactiveCls: 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/60',
  },
] as const

export function ChannelStrip({ channel, marketplace, familyId }: Props) {
  const router = useRouter()

  function go(next: 'amazon' | 'ebay') {
    if (next === channel) return
    const path = next === 'amazon' ? '/products/amazon-flat-file' : '/products/ebay-flat-file'
    const qs = new URLSearchParams({ marketplace })
    if (familyId) qs.set('familyId', familyId)
    router.push(`${path}?${qs.toString()}`)
  }

  return (
    <div className="px-3 h-8 flex items-center gap-1 border-b border-slate-100 dark:border-slate-800/60 bg-slate-50/60 dark:bg-slate-900/40">
      <span className="text-[10px] font-medium text-slate-400 dark:text-slate-500 uppercase tracking-wider mr-1 flex-shrink-0">
        Channel
      </span>

      {/* Segmented control */}
      <div className="flex items-center gap-0.5 p-0.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg">
        {CHANNELS.map(({ id, label, Icon, iconCls, activeCls, inactiveCls }) => {
          const isActive = channel === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => go(id)}
              className={cn(
                'flex items-center gap-1.5 h-6 px-3 rounded-md text-xs font-medium transition-all border',
                isActive
                  ? ['border', activeCls].join(' ')
                  : ['border-transparent', inactiveCls].join(' '),
              )}
              aria-current={isActive ? 'page' : undefined}
            >
              <Icon className={cn('w-3 h-3 flex-shrink-0', isActive ? iconCls : 'text-slate-400')} />
              {label}
              {isActive && (
                <span className={cn(
                  'text-[10px] font-mono px-1 py-px rounded',
                  id === 'amazon'
                    ? 'bg-orange-100 text-orange-600 dark:bg-orange-900/50 dark:text-orange-400'
                    : 'bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-400',
                )}>
                  {marketplace}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Navigation hint */}
      <span className="ml-2 text-[10px] text-slate-300 dark:text-slate-600 select-none">
        Switch channel to transfer your data
      </span>
    </div>
  )
}
