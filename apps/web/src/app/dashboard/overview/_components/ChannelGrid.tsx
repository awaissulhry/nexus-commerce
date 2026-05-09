'use client'

import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
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
 * for any channel — the empty-state tile takes its place. The
 * tinted per-channel backgrounds (orange-50 for Amazon, blue-50 for
 * eBay…) are the brand-recognition cue, so the channel cards stay
 * custom rather than wearing the neutral Card chrome — the section
 * heading sits alongside as a header band.
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
      <Card title={t('overview.channels.heading')}>
        <div className="text-base text-slate-500 dark:text-slate-400 italic">
          {t('overview.channels.empty')}
        </div>
      </Card>
    )
  }
  return (
    <div>
      <h2 className="text-md font-semibold text-slate-900 dark:text-slate-100 mb-2">
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
              <div className="mt-1.5 flex items-center gap-2 text-xs tabular-nums">
                <Badge variant="success">
                  {t('overview.channels.live', { n: c.listings.live })}
                </Badge>
                <Badge variant="warning">
                  {t('overview.channels.draft', { n: c.listings.draft })}
                </Badge>
                {c.listings.failed > 0 && (
                  <Badge variant="danger">
                    {t('overview.channels.failed', { n: c.listings.failed })}
                  </Badge>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
