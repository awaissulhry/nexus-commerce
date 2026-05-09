'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  CheckCircle2,
  Info,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import { NUM_FMT } from '../_lib/format'
import RelativeTimestamp from './RelativeTimestamp'
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
  // DO.22 — each alert carries label + count + impact line + action
  // label. Tone tints the row; rose=P0, amber=P1. The action label
  // is rendered as an inline pill that visually anchors the verb the
  // operator should perform (Process / Resolve / Inspect / Review).
  type AlertRow = {
    label: string
    count: number
    href: string
    tone: 'rose' | 'amber' | 'slate'
    impact: string
    actionLabel: string
  }
  const items: AlertRow[] = []
  if (alerts.outOfStock > 0)
    items.push({
      label: t('overview.alerts.outOfStock'),
      count: alerts.outOfStock,
      href: '/products?stock=out',
      tone: 'rose',
      impact: t('overview.alerts.impact.outOfStock'),
      actionLabel: t('overview.alerts.action.replenish'),
    })
  if (alerts.lowStock > 0)
    items.push({
      label: t('overview.alerts.lowStock'),
      count: alerts.lowStock,
      href: '/products?stock=low',
      tone: 'amber',
      impact: t('overview.alerts.impact.lowStock'),
      actionLabel: t('overview.alerts.action.review'),
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
      impact: t('overview.alerts.impact.failedListings'),
      actionLabel: t('overview.alerts.action.resolve'),
    })
  if (alerts.draftListings > 0)
    items.push({
      label: t('overview.alerts.draftListings'),
      count: alerts.draftListings,
      href: '/listings?listingStatus=DRAFT',
      tone: 'amber',
      impact: t('overview.alerts.impact.draftListings'),
      actionLabel: t('overview.alerts.action.publish'),
    })
  if (alerts.pendingOrders > 0)
    items.push({
      label: t('overview.alerts.pendingOrders'),
      count: alerts.pendingOrders,
      href: '/orders',
      tone: 'amber',
      impact: t('overview.alerts.impact.pendingOrders'),
      actionLabel: t('overview.alerts.action.process'),
    })
  // DO.21 — operational categories. Order matters: most-urgent first
  // (P0 risks at the top, P1/P2 below).
  if (alerts.lateShipments > 0)
    items.push({
      label: t('overview.alerts.lateShipments'),
      count: alerts.lateShipments,
      href: '/fulfillment/outbound',
      tone: 'rose',
      impact: t('overview.alerts.impact.lateShipments'),
      actionLabel: t('overview.alerts.action.shipNow'),
    })
  if (alerts.suppressions > 0)
    items.push({
      label: t('overview.alerts.suppressions'),
      count: alerts.suppressions,
      // Suppressions live across Amazon listings; the master view
      // filtered to suppressed status is the right drill-down.
      href: '/listings/amazon?suppressed=true',
      tone: 'rose',
      impact: t('overview.alerts.impact.suppressions'),
      actionLabel: t('overview.alerts.action.resolve'),
    })
  if (alerts.returnsBacklog > 0)
    items.push({
      label: t('overview.alerts.returnsBacklog'),
      count: alerts.returnsBacklog,
      href: '/fulfillment/returns',
      tone: 'amber',
      impact: t('overview.alerts.impact.returnsBacklog'),
      actionLabel: t('overview.alerts.action.inspect'),
    })
  if (alerts.syncFailures24h > 0)
    items.push({
      label: t('overview.alerts.syncFailures24h'),
      count: alerts.syncFailures24h,
      href: '/sync-logs',
      tone: 'rose',
      impact: t('overview.alerts.impact.syncFailures'),
      actionLabel: t('overview.alerts.action.investigate'),
    })
  if (alerts.rateLimitHits1h > 0)
    items.push({
      label: t('overview.alerts.rateLimitHits1h'),
      count: alerts.rateLimitHits1h,
      href: '/sync-logs/api-calls',
      tone: 'amber',
      impact: t('overview.alerts.impact.rateLimitHits'),
      actionLabel: t('overview.alerts.action.investigate'),
    })
  // DO.20 — local dismissal: marking a notification read on the
  // server is a fire-and-forget action; we hide it from the UI
  // immediately so the operator gets the satisfying acknowledgment
  // beat. The next dashboard fetch will reflect the server state.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const dismissNotification = (id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev)
      next.add(id)
      return next
    })
    void fetch(`${getBackendUrl()}/api/notifications/${id}/read`, {
      method: 'POST',
    }).catch(() => {
      // Network failure: the local dismissal still reduces noise
      // until the next refetch syncs reality back.
    })
  }
  const visibleNotifications = alerts.notifications.filter(
    (n) => !dismissed.has(n.id),
  )
  const totalActive = items.length + visibleNotifications.length
  return (
    <Card
      title={t('overview.alerts.heading')}
      action={
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {totalActive === 0
            ? t('overview.alerts.allClear')
            : t('overview.alerts.activeCount', { n: totalActive })}
        </span>
      }
    >
      <div className="space-y-2">
        {/* DO.20 — Notification rows render first because they are
            event-based (something just happened) vs the static
            count-based rows below (snapshot of system state). */}
        {visibleNotifications.length > 0 && (
          <ul className="space-y-1.5">
            {visibleNotifications.map((n) => (
              <NotificationRow
                key={n.id}
                t={t}
                notification={n}
                onDismiss={() => dismissNotification(n.id)}
              />
            ))}
          </ul>
        )}
        {totalActive === 0 && (
          <div className="text-sm text-slate-500 dark:text-slate-400 italic">
            {t('overview.alerts.empty')}
          </div>
        )}
        {items.map((it) => (
          <Link
            key={it.label}
            href={it.href}
            className={cn(
              'group block rounded-md border text-base px-2.5 py-2 transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
              it.tone === 'rose'
                ? 'border-rose-200 dark:border-rose-900 bg-rose-50/40 dark:bg-rose-950/30 hover:bg-rose-50/80 dark:hover:bg-rose-950/50'
                : it.tone === 'amber'
                ? 'border-amber-200 dark:border-amber-900 bg-amber-50/40 dark:bg-amber-950/30 hover:bg-amber-50/80 dark:hover:bg-amber-950/50'
                : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800',
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium text-slate-800 dark:text-slate-200">
                {it.label}
              </span>
              <span className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {NUM_FMT.format(it.count)}
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between gap-2">
              <span className="text-xs text-slate-600 dark:text-slate-400">
                {it.impact}
              </span>
              <span
                className={cn(
                  'inline-flex items-center gap-0.5 text-xs font-medium tabular-nums',
                  'transition-colors',
                  it.tone === 'rose'
                    ? 'text-rose-700 dark:text-rose-400 group-hover:text-rose-900 dark:group-hover:text-rose-200'
                    : it.tone === 'amber'
                    ? 'text-amber-700 dark:text-amber-400 group-hover:text-amber-900 dark:group-hover:text-amber-200'
                    : 'text-slate-600 dark:text-slate-400 group-hover:text-slate-900 dark:group-hover:text-slate-100',
                )}
              >
                {it.actionLabel} →
              </span>
            </div>
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

const SEVERITY_TONE: Record<
  string,
  { container: string; icon: string; Icon: typeof Info }
> = {
  danger: {
    container:
      'border-rose-200 dark:border-rose-900 bg-rose-50/40 dark:bg-rose-950/30',
    icon: 'text-rose-600 dark:text-rose-400',
    Icon: AlertCircle,
  },
  warn: {
    container:
      'border-amber-200 dark:border-amber-900 bg-amber-50/40 dark:bg-amber-950/30',
    icon: 'text-amber-600 dark:text-amber-400',
    Icon: AlertCircle,
  },
  success: {
    container:
      'border-emerald-200 dark:border-emerald-900 bg-emerald-50/40 dark:bg-emerald-950/30',
    icon: 'text-emerald-600 dark:text-emerald-400',
    Icon: CheckCircle2,
  },
  info: {
    container:
      'border-slate-200 dark:border-slate-700 bg-slate-50/40 dark:bg-slate-800/40',
    icon: 'text-slate-500 dark:text-slate-400',
    Icon: Info,
  },
}

function NotificationRow({
  t,
  notification,
  onDismiss,
}: {
  t: T
  notification: OverviewPayload['alerts']['notifications'][number]
  onDismiss: () => void
}) {
  const tone = SEVERITY_TONE[notification.severity] ?? SEVERITY_TONE.info
  const Icon = tone.Icon
  const ts = Date.parse(notification.createdAt)
  const inner = (
    <li
      className={cn(
        'group flex items-start gap-2 px-2.5 py-1.5 rounded-md border text-base',
        tone.container,
        notification.href && 'hover:bg-white/60 dark:hover:bg-slate-800/60',
      )}
    >
      <Icon className={cn('w-3.5 h-3.5 mt-0.5 flex-shrink-0', tone.icon)} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
          {notification.title}
        </div>
        {notification.body && (
          <div className="text-xs text-slate-600 dark:text-slate-400 truncate">
            {notification.body}
          </div>
        )}
        <RelativeTimestamp t={t} at={ts} compact />
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onDismiss()
        }}
        title={t('overview.alerts.dismiss')}
        aria-label={t('overview.alerts.dismiss')}
        className="opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center justify-center w-5 h-5 rounded text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:opacity-100"
      >
        <X className="w-3 h-3" />
      </button>
    </li>
  )
  return notification.href ? (
    <Link href={notification.href} className="block">
      {inner}
    </Link>
  ) : (
    inner
  )
}
