'use client'

import Link from 'next/link'
import { AlertTriangle, ChevronRight, CircleDot } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/utils'
import { formatCurrency, NUM_FMT, PCT_FMT } from '../_lib/format'
import {
  CHANNEL_LABELS,
  CHANNEL_TONES,
  type OverviewPayload,
  type T,
} from '../_lib/types'

type HealthStatus = OverviewPayload['byChannel'][number]['health']['status']

const HEALTH_DOT: Record<HealthStatus, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  fail: 'bg-rose-500',
  inactive: 'bg-slate-300',
}

function relativeAgo(t: T, isoTs: string | null): string | null {
  if (!isoTs) return null
  const ms = Date.now() - new Date(isoTs).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const s = Math.floor(ms / 1000)
  if (s < 60) return t('overview.relTime.seconds', { n: s })
  const m = Math.floor(s / 60)
  if (m < 60) return t('overview.relTime.minutes', { n: m })
  const h = Math.floor(m / 60)
  if (h < 24) return t('overview.relTime.hours', { n: h })
  const d = Math.floor(h / 24)
  return t('overview.relTime.days', { n: d })
}

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
          const lastSyncLabel = relativeAgo(t, c.health.lastSyncAt)
          const channelHref = `/listings/${c.channel.toLowerCase()}`
          return (
            <Link
              key={c.channel}
              href={channelHref}
              className={cn(
                'group border rounded-lg px-3 py-2.5 transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
                tone.bg,
                'hover:border-slate-400 dark:hover:border-slate-500',
              )}
              aria-label={t('overview.channels.openAria', {
                channel: CHANNEL_LABELS[c.channel] ?? c.channel,
              })}
            >
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5">
                  <CircleDot
                    className={cn(
                      'w-2.5 h-2.5 rounded-full text-current',
                      HEALTH_DOT[c.health.status],
                    )}
                    aria-label={t(`overview.channels.health.${c.health.status}`)}
                  />
                  <span className={cn('text-base font-semibold', tone.text)}>
                    {CHANNEL_LABELS[c.channel] ?? c.channel}
                  </span>
                  <ChevronRight className="w-3 h-3 text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity" />
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
              <div className="mt-1.5 flex items-center gap-2 text-xs tabular-nums flex-wrap">
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
                {c.health.suppressions > 0 && (
                  <Badge variant="danger">
                    <span className="inline-flex items-center gap-0.5">
                      <AlertTriangle className="w-2.5 h-2.5" />
                      {t('overview.channels.suppressed', {
                        n: c.health.suppressions,
                      })}
                    </span>
                  </Badge>
                )}
                {c.health.buyBoxWinRate7d !== null &&
                  c.health.buyBoxObservations7d > 0 && (
                    <Badge
                      variant={
                        c.health.buyBoxWinRate7d >= 0.7
                          ? 'success'
                          : c.health.buyBoxWinRate7d >= 0.4
                          ? 'warning'
                          : 'danger'
                      }
                    >
                      {t('overview.channels.buyBox', {
                        rate: PCT_FMT.format(c.health.buyBoxWinRate7d),
                      })}
                    </Badge>
                  )}
              </div>
              {(lastSyncLabel || c.health.errors24h > 0) && (
                <div className="mt-1.5 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                  {lastSyncLabel && (
                    <span>
                      {t('overview.channels.lastSync', { ago: lastSyncLabel })}
                    </span>
                  )}
                  {c.health.errors24h > 0 && (
                    <span className="text-rose-600 dark:text-rose-400 font-medium">
                      ·{' '}
                      {t('overview.channels.errors24h', {
                        n: c.health.errors24h,
                      })}
                    </span>
                  )}
                </div>
              )}
            </Link>
          )
        })}
      </div>
    </div>
  )
}
