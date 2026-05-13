'use client'

/**
 * ChannelStrip — channel-switcher nav bar (Amazon | eBay).
 *
 * Renders a single row of channel tabs. Market selection lives in
 * Bar 3 of each flat-file page's header (same position as Amazon).
 */

import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'

interface Props {
  channel: 'amazon' | 'ebay'
  marketplace: string
  familyId?: string
}

const CHANNEL_META = {
  amazon: {
    label: 'Amazon',
    icon: (
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current" aria-hidden="true">
        <path d="M18.42 14.74c-.16-.14-.38-.08-.55.03-1.56 1.18-4 1.85-6.04 1.85-2.87 0-5.45-1.06-7.4-2.78-.15-.13-.38-.03-.26.17.65 1.04 1.55 2.0 2.64 2.75 2.52 1.72 5.66 2.04 8.27 1.09 1.08-.4 2.0-1.03 2.57-1.73.23-.28.03-.72-.23-.38m1.18-1.65c-.22-.32-.48-.14-.56.1-.83 2.3-3.07 4.0-5.44 4.72-2.67.8-5.34.45-7.57-.82-.06-.03-.12.04-.08.09 1.5 2.1 4.14 3.4 6.86 3.4 3.27 0 6.38-1.8 7.72-4.86.23-.52.38-1.7-.93-2.63M12 0C5.37 0 0 5.37 0 12s5.37 12 12 12 12-5.37 12-12S18.63 0 12 0" />
      </svg>
    ),
  },
  ebay: {
    label: 'eBay',
    icon: (
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current" aria-hidden="true">
        <path d="M.43 8.65H3.6V16H.43V8.65zm5.9 0h1.16L9.3 14.33l1.82-5.68h1.19L9.9 16H8.75L6.33 8.65zM13.36 8.65h3.17c2.13 0 3.06 1.24 3.06 3.68 0 2.44-.93 3.67-3.06 3.67h-3.17V8.65zm1.17 6.35h1.87c1.38 0 1.95-.83 1.95-2.67 0-1.84-.57-2.68-1.95-2.68h-1.87v5.35zm5.56-6.35h1.14V16h-1.14V8.65zM2 5.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm19 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z" />
      </svg>
    ),
  },
}

export function ChannelStrip({ channel, marketplace, familyId }: Props) {
  const router = useRouter()

  function navigateTo(nextChannel: 'amazon' | 'ebay') {
    const path =
      nextChannel === 'amazon'
        ? '/products/amazon-flat-file'
        : '/products/ebay-flat-file'
    const qs = new URLSearchParams({ marketplace })
    if (familyId) qs.set('familyId', familyId)
    router.push(`${path}?${qs.toString()}`)
  }

  return (
    <div className="flex items-center gap-0 px-3 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
      {(['amazon', 'ebay'] as const).map((ch) => {
        const meta = CHANNEL_META[ch]
        const isActive = channel === ch
        return (
          <button
            key={ch}
            onClick={() => navigateTo(ch)}
            className={cn(
              'flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium border-b-2 transition-colors',
              isActive
                ? 'border-blue-600 text-blue-700 dark:text-blue-400'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200',
            )}
          >
            {meta.icon}
            {meta.label}
          </button>
        )
      })}
    </div>
  )
}
