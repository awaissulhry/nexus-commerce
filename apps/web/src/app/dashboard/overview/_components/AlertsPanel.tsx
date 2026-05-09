'use client'

import Link from 'next/link'
import { Wifi, WifiOff } from 'lucide-react'
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
    <div className="border border-slate-200 rounded-lg bg-white">
      <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
        <h2 className="text-md font-semibold text-slate-900">
          {t('overview.alerts.heading')}
        </h2>
        <span className="text-xs text-slate-500">
          {items.length === 0
            ? t('overview.alerts.allClear')
            : t('overview.alerts.activeCount', { n: items.length })}
        </span>
      </div>
      <div className="px-4 py-3 space-y-2">
        {items.length === 0 && (
          <div className="text-sm text-slate-500 italic">
            {t('overview.alerts.empty')}
          </div>
        )}
        {items.map((it) => (
          <Link
            key={it.label}
            href={it.href}
            className={cn(
              'flex items-center justify-between gap-3 px-2.5 py-1.5 rounded-md border text-base hover:bg-slate-50',
              it.tone === 'rose'
                ? 'border-rose-200 bg-rose-50/40'
                : it.tone === 'amber'
                ? 'border-amber-200 bg-amber-50/40'
                : 'border-slate-200',
            )}
          >
            <span className="text-slate-800">{it.label}</span>
            <span className="font-semibold tabular-nums text-slate-900">
              {NUM_FMT.format(it.count)}
            </span>
          </Link>
        ))}

        {/* Channel connectivity */}
        {alerts.channelConnections.length > 0 && (
          <div className="border-t border-slate-100 pt-2 mt-2">
            <div className="text-xs uppercase tracking-wide text-slate-500 font-semibold mb-1">
              {t('overview.alerts.connectionsHeading')}
            </div>
            <ul className="space-y-1">
              {alerts.channelConnections.map((c, idx) => (
                <li
                  key={idx}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-slate-700">
                    {CHANNEL_LABELS[c.channelType] ?? c.channelType}
                  </span>
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-xs',
                      c.isActive
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                        : 'border-slate-200 text-slate-500',
                    )}
                  >
                    {c.isActive ? (
                      <Wifi className="w-2.5 h-2.5" />
                    ) : (
                      <WifiOff className="w-2.5 h-2.5" />
                    )}
                    {c.isActive
                      ? t('overview.alerts.connected')
                      : t('overview.alerts.disconnected')}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {/* Catalog touchpoints */}
        <div className="border-t border-slate-100 pt-2 mt-2 grid grid-cols-2 gap-2 text-sm text-slate-700">
          <div>
            <div className="text-slate-500 text-xs">
              {t('overview.alerts.liveListings')}
            </div>
            <div className="font-semibold tabular-nums">
              {NUM_FMT.format(catalog.liveListings)}
            </div>
          </div>
          <div>
            <div className="text-slate-500 text-xs">
              {t('overview.alerts.variants')}
            </div>
            <div className="font-semibold tabular-nums">
              {NUM_FMT.format(catalog.totalVariants)}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
