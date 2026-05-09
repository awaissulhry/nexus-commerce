'use client'

import Link from 'next/link'
import { Wifi, WifiOff } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/utils'
import { NUM_FMT } from '../_lib/format'
import {
  CHANNEL_LABELS,
  type OverviewPayload,
  type T,
} from '../_lib/types'

/**
 * Operational alerts panel: out-of-stock, low-stock, failed listings,
 * draft listings, pending orders. Each line is a deep-link into the
 * filtered detail view. Channel connectivity + headline catalog
 * touchpoints render below the alert list.
 */
export default function AlertsPanel({
  t,
  alerts,
  catalog,
}: {
  t: T
  alerts: OverviewPayload['alerts']
  catalog: OverviewPayload['catalog']
}) {
  const items: Array<{
    label: string
    count: number
    href: string
    tone: 'rose' | 'amber' | 'slate'
  }> = []
  if (alerts.outOfStock > 0)
    items.push({
      label: t('overview.alerts.outOfStock'),
      count: alerts.outOfStock,
      href: '/products?stock=out',
      tone: 'rose',
    })
  if (alerts.lowStock > 0)
    items.push({
      label: t('overview.alerts.lowStock'),
      count: alerts.lowStock,
      href: '/products?stock=low',
      tone: 'amber',
    })
  if (alerts.failedListings > 0)
    items.push({
      label: t('overview.alerts.failedListings'),
      count: alerts.failedListings,
      // C.4 — link to the master /listings filtered by status, not a
      // hardcoded /listings/amazon. Failures can be on any channel
      // and the master view shows them all with channel/marketplace
      // chips ready to drill down further.
      href: '/listings?listingStatus=ERROR',
      tone: 'rose',
    })
  if (alerts.draftListings > 0)
    items.push({
      label: t('overview.alerts.draftListings'),
      count: alerts.draftListings,
      href: '/listings?listingStatus=DRAFT',
      tone: 'amber',
    })
  if (alerts.pendingOrders > 0)
    items.push({
      label: t('overview.alerts.pendingOrders'),
      count: alerts.pendingOrders,
      href: '/orders',
      tone: 'amber',
    })
  return (
    <Card
      title={t('overview.alerts.heading')}
      action={
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {items.length === 0
            ? t('overview.alerts.allClear')
            : t('overview.alerts.activeCount', { n: items.length })}
        </span>
      }
    >
      <div className="space-y-2">
        {items.length === 0 && (
          <div className="text-sm text-slate-500 dark:text-slate-400 italic">
            {t('overview.alerts.empty')}
          </div>
        )}
        {items.map((it) => (
          <Link
            key={it.label}
            href={it.href}
            className={cn(
              'flex items-center justify-between gap-3 px-2.5 py-1.5 rounded-md border text-base hover:bg-slate-50 dark:hover:bg-slate-800',
              it.tone === 'rose'
                ? 'border-rose-200 dark:border-rose-900 bg-rose-50/40 dark:bg-rose-950/30'
                : it.tone === 'amber'
                ? 'border-amber-200 dark:border-amber-900 bg-amber-50/40 dark:bg-amber-950/30'
                : 'border-slate-200 dark:border-slate-700',
            )}
          >
            <span className="text-slate-800 dark:text-slate-200">
              {it.label}
            </span>
            <span className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">
              {NUM_FMT.format(it.count)}
            </span>
          </Link>
        ))}

        {/* Channel connectivity */}
        {alerts.channelConnections.length > 0 && (
          <div className="border-t border-slate-100 dark:border-slate-800 pt-2 mt-2">
            <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 font-semibold mb-1">
              {t('overview.alerts.connectionsHeading')}
            </div>
            <ul className="space-y-1">
              {alerts.channelConnections.map((c, idx) => (
                <li
                  key={idx}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-slate-700 dark:text-slate-300">
                    {CHANNEL_LABELS[c.channelType] ?? c.channelType}
                  </span>
                  <Badge variant={c.isActive ? 'success' : 'default'} size="sm">
                    <span className="inline-flex items-center gap-1">
                      {c.isActive ? (
                        <Wifi className="w-2.5 h-2.5" />
                      ) : (
                        <WifiOff className="w-2.5 h-2.5" />
                      )}
                      {c.isActive
                        ? t('overview.alerts.connected')
                        : t('overview.alerts.disconnected')}
                    </span>
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
        {/* Catalog touchpoints */}
        <div className="border-t border-slate-100 dark:border-slate-800 pt-2 mt-2 grid grid-cols-2 gap-2 text-sm text-slate-700 dark:text-slate-300">
          <div>
            <div className="text-slate-500 dark:text-slate-400 text-xs">
              {t('overview.alerts.liveListings')}
            </div>
            <div className="font-semibold tabular-nums">
              {NUM_FMT.format(catalog.liveListings)}
            </div>
          </div>
          <div>
            <div className="text-slate-500 dark:text-slate-400 text-xs">
              {t('overview.alerts.variants')}
            </div>
            <div className="font-semibold tabular-nums">
              {NUM_FMT.format(catalog.totalVariants)}
            </div>
          </div>
        </div>
      </div>
    </Card>
  )
}
