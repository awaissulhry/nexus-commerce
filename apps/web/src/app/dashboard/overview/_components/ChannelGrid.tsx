'use client'

import { cn } from '@/lib/utils'
import { formatCurrency, NUM_FMT } from '../_lib/format'
import {
  CHANNEL_LABELS,
  CHANNEL_TONES,
  type OverviewPayload,
  type T,
} from '../_lib/types'

/**
 * Per-channel revenue cards. Hidden when no orders or listings exist
 * for any channel — the empty-state tile takes its place.
 */
export default function ChannelGrid({
  t,
  byChannel,
  currency,
}: {
  t: T
  byChannel: OverviewPayload['byChannel']
  currency: string
}) {
  const visible = byChannel.filter(
    (c) => c.orders > 0 || c.listings.total > 0,
  )
  if (visible.length === 0) {
    return (
      <div className="border border-slate-200 rounded-lg bg-white px-4 py-3">
        <h2 className="text-md font-semibold text-slate-900 mb-2">
          {t('overview.channels.heading')}
        </h2>
        <div className="text-base text-slate-500 italic">
          {t('overview.channels.empty')}
        </div>
      </div>
    )
  }
  return (
    <div>
      <h2 className="text-md font-semibold text-slate-900 mb-2">
        {t('overview.channels.heading')}
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {visible.map((c) => {
          const tone = CHANNEL_TONES[c.channel] ?? {
            bg: 'bg-slate-50 border-slate-200',
            text: 'text-slate-700',
          }
          return (
            <div
              key={c.channel}
              className={cn('border rounded-lg px-3 py-2.5', tone.bg)}
            >
              <div className="flex items-center justify-between">
                <span className={cn('text-base font-semibold', tone.text)}>
                  {CHANNEL_LABELS[c.channel] ?? c.channel}
                </span>
                <span className="text-xs text-slate-500 tabular-nums">
                  {t(
                    c.listings.total === 1
                      ? 'overview.channels.listing'
                      : 'overview.channels.listingPlural',
                    { n: NUM_FMT.format(c.listings.total) },
                  )}
                </span>
              </div>
              <div className="mt-1 flex items-baseline gap-3 flex-wrap">
                <div className="text-2xl font-semibold text-slate-900 tabular-nums">
                  {formatCurrency(c.revenue, currency)}
                </div>
                <div className="text-sm text-slate-600 tabular-nums">
                  {t(
                    c.orders === 1
                      ? 'overview.channels.order'
                      : 'overview.channels.orderPlural',
                    { n: NUM_FMT.format(c.orders) },
                  )}{' '}
                  ·{' '}
                  {t('overview.channels.aov', {
                    amount: formatCurrency(c.aov, currency),
                  })}
                </div>
              </div>
              <div className="mt-1.5 flex items-center gap-2 text-xs">
                <Pill tone="emerald">
                  {t('overview.channels.live', { n: c.listings.live })}
                </Pill>
                <Pill tone="amber">
                  {t('overview.channels.draft', { n: c.listings.draft })}
                </Pill>
                {c.listings.failed > 0 && (
                  <Pill tone="rose">
                    {t('overview.channels.failed', { n: c.listings.failed })}
                  </Pill>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Pill({
  tone,
  children,
}: {
  tone: 'emerald' | 'amber' | 'rose'
  children: React.ReactNode
}) {
  const cls =
    tone === 'emerald'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : tone === 'amber'
      ? 'bg-amber-50 text-amber-700 border-amber-200'
      : 'bg-rose-50 text-rose-700 border-rose-200'
  return (
    <span
      className={cn(
        'inline-flex items-center px-1.5 py-0.5 rounded border text-xs tabular-nums',
        cls,
      )}
    >
      {children}
    </span>
  )
}
