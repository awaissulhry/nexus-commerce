'use client'

/**
 * LS.3 — live-sync health badge on /orders.
 *
 * Tells the operator whether Amazon push notifications (SP-API
 * ORDER_CHANGE via SQS) are flowing in near-real-time, or whether
 * we're falling back to the 15-min cron.
 *
 *   ● Live · 12s ago    (emerald)  — push flowing, last event <60s
 *   ◐ Live · 4m ago     (amber)    — push enabled, last event 1-5min
 *   ◌ Push idle · 12h   (slate)    — push enabled but quiet (normal
 *                                    when no orders changed state
 *                                    in that window)
 *   ▣ Cron only         (amber)    — push disabled, polling 15-min
 *
 * Polls /api/orders/sync-health on a 30s tick (matches the SSE
 * heartbeat) and re-renders the "Xs ago" label every 5s without
 * re-fetching.
 */

import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'

type Health = {
  push: {
    enabled: boolean
    queueConfigured: boolean
    lastEventAt: string | null
    lastEventType: string | null
  }
  cron: {
    enabled: boolean
    lastUpdateAt: string | null
  }
  checkedAt: string
}

function relativeAgo(iso: string | null): { label: string; seconds: number } | null {
  if (!iso) return null
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (sec < 60) return { label: `${sec}s ago`, seconds: sec }
  const min = Math.floor(sec / 60)
  if (min < 60) return { label: `${min}m ago`, seconds: sec }
  const h = Math.floor(min / 60)
  if (h < 24) return { label: `${h}h ago`, seconds: sec }
  return { label: `${Math.floor(h / 24)}d ago`, seconds: sec }
}

export function LiveSyncBadge() {
  const [health, setHealth] = useState<Health | null>(null)
  const [, setTick] = useState(0)

  const load = async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/orders/sync-health`, { cache: 'no-store' })
      if (res.ok) setHealth(await res.json())
    } catch {}
  }

  useEffect(() => {
    load()
    const refresh = setInterval(load, 30_000)
    return () => clearInterval(refresh)
  }, [])

  // Re-tick the "Xs ago" label every 5s without re-fetching.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 5000)
    return () => clearInterval(t)
  }, [])

  if (!health) return null

  const pushAgo = relativeAgo(health.push.lastEventAt)
  const cronAgo = relativeAgo(health.cron.lastUpdateAt)

  let dot: string
  let label: string
  let tone: string
  let title: string

  if (!health.push.enabled || !health.push.queueConfigured) {
    // Push not configured at all — pure cron mode
    dot = '▣'
    label = `Cron · ${cronAgo?.label ?? 'never'}`
    tone = 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900'
    title = 'Live push (SP-API Notifications) is disabled. Falling back to the 15-min cron. Set NEXUS_ENABLE_AMAZON_SQS_POLL=1 to enable.'
  } else if (!pushAgo) {
    // Push configured but no event ever — usually means subscription
    // is brand new and waiting for the first transition
    dot = '◌'
    label = 'Push waiting'
    tone = 'bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
    title = 'Push notifications are subscribed but no ORDER_CHANGE event has landed yet. The first message will arrive when an order changes state.'
  } else if (pushAgo.seconds < 60) {
    dot = '●'
    label = `Live · ${pushAgo.label}`
    tone = 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900'
    title = `Last Amazon push: ${pushAgo.label} (${health.push.lastEventType ?? '—'})`
  } else if (pushAgo.seconds < 300) {
    dot = '◐'
    label = `Live · ${pushAgo.label}`
    tone = 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900'
    title = `Last Amazon push: ${pushAgo.label} (${health.push.lastEventType ?? '—'})`
  } else if (pushAgo.seconds < 3600) {
    dot = '◐'
    label = `Quiet · ${pushAgo.label}`
    tone = 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900'
    title = `Last Amazon push was ${pushAgo.label}. This is normal if no order changed state recently, but worth a glance after an hour of quiet during business hours.`
  } else {
    dot = '◌'
    label = `Idle · ${pushAgo.label}`
    tone = 'bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
    title = `Last Amazon push was ${pushAgo.label}. The 15-min cron is still running as a backstop.`
  }

  return (
    <span
      className={`inline-flex items-center gap-1 h-7 px-2 text-xs font-medium border rounded ${tone}`}
      title={title}
      aria-label={`Amazon sync: ${label}`}
    >
      <span aria-hidden="true">{dot}</span>
      {label}
    </span>
  )
}
