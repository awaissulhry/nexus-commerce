'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { CircleDot, Pause, Play, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import RelativeTimestamp from './RelativeTimestamp'
import type { OverviewPayload, T } from '../_lib/types'

/**
 * Live cross-system activity feed. Seeds from the backend's
 * recentActivity (BulkOperation + AuditLog) and then streams
 * events from /api/dashboard/events (DO.14) — orders, shipments,
 * listings, inbound, sync. Newest at top, capped at MAX_EVENTS.
 *
 * Pause toggle closes the EventSource so the operator can study a
 * frozen list without it shifting under them; the streaming icon
 * goes dim, the buffer keeps its last contents. Resume re-opens
 * and starts appending again (events received while paused are
 * lost — that's the point of pause).
 *
 * Filter chips narrow to one or more categories. The empty filter
 * set means "all", so toggling each chip on then off returns to
 * the unfiltered view.
 */

type Category = 'order' | 'shipment' | 'listing' | 'inbound' | 'sync' | 'other'

interface FeedEvent {
  id: string
  category: Category
  ts: number
  summary: string
  href?: string
}

const MAX_EVENTS = 50

const CATEGORY_ORDER: Category[] = [
  'order',
  'shipment',
  'listing',
  'inbound',
  'sync',
]

const NAMED_EVENT_TYPES = [
  'order.created',
  'order.updated',
  'order.cancelled',
  'order.shipped',
  'return.created',
  'shipment.created',
  'shipment.updated',
  'shipment.deleted',
  'tracking.event',
  'listing.created',
  'listing.updated',
  'listing.deleted',
  'listing.synced',
  'listing.syncing',
  'wizard.submitted',
  'inbound.created',
  'inbound.updated',
  'inbound.received',
  'inbound.discrepancy',
  'inbound.cancelled',
  'api-call.recorded',
] as const

function categoryFor(eventType: string): Category {
  if (eventType.startsWith('order.') || eventType === 'return.created')
    return 'order'
  if (
    eventType.startsWith('shipment.') ||
    eventType === 'tracking.event'
  )
    return 'shipment'
  if (
    eventType.startsWith('listing.') ||
    eventType === 'wizard.submitted'
  )
    return 'listing'
  if (eventType.startsWith('inbound.')) return 'inbound'
  if (eventType.startsWith('api-call.')) return 'sync'
  return 'other'
}

interface AnyPayload {
  type: string
  ts?: number
  [key: string]: unknown
}

function formatEvent(t: T, payload: AnyPayload): string {
  const v = payload as Record<string, string | undefined>
  switch (payload.type) {
    case 'order.created':
      return t('overview.event.orderCreated', { channel: v.channel ?? '' })
    case 'order.updated':
      return t('overview.event.orderUpdated', { status: v.status ?? '' })
    case 'order.cancelled':
      return t('overview.event.orderCancelled')
    case 'order.shipped':
      return t('overview.event.orderShipped', { channel: v.channel ?? '' })
    case 'return.created':
      return t('overview.event.returnCreated', { channel: v.channel ?? '' })
    case 'shipment.created':
      return t('overview.event.shipmentCreated')
    case 'shipment.updated':
      return t('overview.event.shipmentUpdated', { status: v.status ?? '' })
    case 'shipment.deleted':
      return t('overview.event.shipmentDeleted')
    case 'tracking.event':
      return t('overview.event.trackingEvent', { code: v.code ?? '' })
    case 'listing.synced':
      return v.status === 'FAILED' || v.status === 'TIMEOUT'
        ? t('overview.event.listingSyncFailed', { status: v.status ?? '' })
        : t('overview.event.listingSynced')
    case 'listing.syncing':
      return t('overview.event.listingSyncing')
    case 'listing.created':
      return t('overview.event.listingCreated')
    case 'listing.updated':
      return t('overview.event.listingUpdated')
    case 'listing.deleted':
      return t('overview.event.listingDeleted')
    case 'wizard.submitted':
      return t('overview.event.wizardSubmitted')
    case 'inbound.created':
      return t('overview.event.inboundCreated')
    case 'inbound.updated':
      return t('overview.event.inboundUpdated')
    case 'inbound.received':
      return t('overview.event.inboundReceived')
    case 'inbound.discrepancy':
      return t('overview.event.inboundDiscrepancy')
    case 'inbound.cancelled':
      return t('overview.event.inboundCancelled')
    case 'api-call.recorded':
      return v.success === ('false' as unknown) || (payload as { success?: boolean }).success === false
        ? t('overview.event.apiFailed', {
            channel: v.channel ?? '',
            op: v.operation ?? '',
          })
        : t('overview.event.apiOk', {
            channel: v.channel ?? '',
            op: v.operation ?? '',
          })
    default:
      return payload.type
  }
}

function hrefFor(payload: AnyPayload): string | undefined {
  const v = payload as Record<string, string | undefined>
  if (payload.type.startsWith('order.') && v.orderId)
    return `/orders/${v.orderId}`
  if (payload.type === 'return.created') return '/fulfillment/returns'
  if (payload.type.startsWith('shipment.') || payload.type === 'tracking.event')
    return '/fulfillment/outbound'
  if (
    payload.type.startsWith('listing.') ||
    payload.type === 'wizard.submitted'
  )
    return '/listings'
  if (payload.type.startsWith('inbound.')) return '/fulfillment/inbound'
  if (payload.type === 'api-call.recorded') return '/sync-logs/api-calls'
  return undefined
}

export default function ActivityFeed({
  t,
  items,
}: {
  t: T
  items: OverviewPayload['recentActivity']
}) {
  // Seed buffer from the server-formatted snapshot. SSE events
  // prepend on top from this point on.
  const [events, setEvents] = useState<FeedEvent[]>(() =>
    items.map((a, i) => ({
      id: `seed:${i}:${a.ts}`,
      category: 'other' as Category,
      ts: Date.parse(a.ts),
      summary: a.summary,
    })),
  )
  const [paused, setPaused] = useState(false)
  const [connected, setConnected] = useState(false)
  const [filter, setFilter] = useState<Set<Category>>(new Set())
  const sourceRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (paused) return
    if (typeof window === 'undefined' || typeof EventSource === 'undefined')
      return

    const url = `${getBackendUrl()}/api/dashboard/events`
    const source = new EventSource(url, { withCredentials: false })
    sourceRef.current = source

    const handle = (e: MessageEvent) => {
      let payload: AnyPayload
      try {
        payload = JSON.parse(e.data) as AnyPayload
      } catch {
        return
      }
      if (payload.type === 'ping') return
      const summary = formatEvent(t, payload)
      if (!summary) return
      setEvents((prev) =>
        [
          {
            id: `live:${payload.ts ?? Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
            category: categoryFor(payload.type),
            ts: payload.ts ?? Date.now(),
            summary,
            href: hrefFor(payload),
          },
          ...prev,
        ].slice(0, MAX_EVENTS),
      )
    }

    for (const tt of NAMED_EVENT_TYPES) {
      source.addEventListener(tt, handle as EventListener)
    }
    source.addEventListener('message', handle)
    source.addEventListener('ping', () => setConnected(true))
    source.onopen = () => setConnected(true)
    source.onerror = () => setConnected(false)

    return () => {
      source.close()
      sourceRef.current = null
      setConnected(false)
    }
  }, [paused, t])

  const toggleCategory = (c: Category) => {
    setFilter((prev) => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      return next
    })
  }

  const visible = useMemo(
    () =>
      filter.size === 0
        ? events
        : events.filter((e) => filter.has(e.category)),
    [events, filter],
  )

  if (events.length === 0 && !connected) return null

  const liveBadge = connected && !paused ? (
    <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
      <CircleDot className="w-2.5 h-2.5 animate-pulse" />
      {t('overview.activity.live')}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs text-slate-400 dark:text-slate-500">
      <CircleDot className="w-2.5 h-2.5" />
      {paused ? t('overview.activity.paused') : t('overview.activity.connecting')}
    </span>
  )

  return (
    <Card
      title={t('overview.activity.heading')}
      action={liveBadge}
      noPadding
    >
      <div className="px-4 py-2 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          {CATEGORY_ORDER.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => toggleCategory(c)}
              className={cn(
                'h-6 px-2 text-xs rounded-full border transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
                filter.has(c)
                  ? 'bg-slate-900 dark:bg-slate-100 border-slate-900 dark:border-slate-100 text-white dark:text-slate-900 font-medium'
                  : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800',
              )}
            >
              {t(`overview.activity.cat.${c}`)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            title={paused ? t('overview.activity.resume') : t('overview.activity.pause')}
            aria-label={paused ? t('overview.activity.resume') : t('overview.activity.pause')}
            className="inline-flex items-center justify-center w-7 h-7 rounded text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          >
            {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => setEvents([])}
            title={t('overview.activity.clear')}
            aria-label={t('overview.activity.clear')}
            className="inline-flex items-center justify-center w-7 h-7 rounded text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      {visible.length === 0 ? (
        <div className="px-4 py-6 text-sm text-slate-500 dark:text-slate-400 italic text-center">
          {t('overview.activity.empty')}
        </div>
      ) : (
        <ul className="max-h-[260px] overflow-y-auto">
          {visible.map((a) => {
            const row = (
              <li
                key={a.id}
                className="px-4 py-2 border-b border-slate-100 dark:border-slate-800 last:border-b-0 flex items-start justify-between gap-3 hover:bg-slate-50/40 dark:hover:bg-slate-800/40"
              >
                <div className="flex items-start gap-2 flex-1 min-w-0">
                  <CategoryDot category={a.category} />
                  <div className="text-sm text-slate-700 dark:text-slate-300 break-words flex-1">
                    {a.summary}
                  </div>
                </div>
                <RelativeTimestamp t={t} at={a.ts} compact />
              </li>
            )
            return a.href ? (
              <Link key={a.id} href={a.href} className="block">
                {row}
              </Link>
            ) : (
              row
            )
          })}
        </ul>
      )}
    </Card>
  )
}

const CATEGORY_DOT: Record<Category, string> = {
  order: 'bg-emerald-500',
  shipment: 'bg-blue-500',
  listing: 'bg-violet-500',
  inbound: 'bg-amber-500',
  sync: 'bg-slate-400',
  other: 'bg-slate-300',
}

function CategoryDot({ category }: { category: Category }) {
  return (
    <span
      className={cn(
        'inline-block w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0',
        CATEGORY_DOT[category],
      )}
      aria-hidden="true"
    />
  )
}

// Mark Badge import as intentionally available for future per-event
// chips (e.g., "FAILED" tag on listing-sync-failed entries). Suppress
// unused-warning for now.
void Badge
