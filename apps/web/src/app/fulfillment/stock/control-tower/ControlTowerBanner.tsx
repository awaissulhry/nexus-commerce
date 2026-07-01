'use client'

/**
 * Phase 6 T5 — Control Tower live-events banner.
 *
 * Subscribes to /api/orders/events (same SSE bus as LiveActivityClient at
 * /sync-logs/live) and surfaces the 6 inventory-sync alert event types as
 * dismissible inline banners at the top of the Control Tower page.
 * Keeps at most 5 at a time (newest first, oldest auto-evicted).
 *
 * Subscribe-only — zero mutations.
 * EventSource lifecycle mirrors LiveActivityClient exactly (StrictMode-safe
 * double-mount: cleanup closes the socket before the second mount opens a
 * fresh one).
 */

import { useEffect, useState } from 'react'
import { Banner } from '@/design-system/components/Banner'
import { getBackendUrl } from '@/lib/backend-url'

// ── Event type specs ───────────────────────────────────────────────────────

type BannerTone = 'warning' | 'danger' | 'info'

interface BannerEventSpec {
  type: string
  tone: BannerTone
  message: (data: Record<string, unknown>) => string
}

/**
 * Field names taken directly from the OrderEvent union in
 * order-events.service.ts (server-of-record). Corrections vs the
 * original spec:
 *   latencyMs  → p95Ms            (sync.latency.breach)
 *   totalDrift → absDriftUnits    (sync.drift.cumulative)
 *   sync.conflict.stale has no sku/channel/localVersion/remoteVersion —
 *     uses count + olderThanDays instead.
 */
const BANNER_TYPES: BannerEventSpec[] = [
  {
    type: 'sync.oversell.clamped',
    tone: 'warning',
    message: (d) =>
      `Oversell clamped on ${d.channel} ${d.sku}: ${d.requested}→${d.clampedTo}`,
  },
  {
    type: 'sync.latency.breach',
    tone: 'warning',
    message: (d) =>
      `Sync latency breach: ${d.channel} at ${d.p95Ms}ms (threshold ${d.thresholdMs}ms)`,
  },
  {
    type: 'sync.realtime.degraded',
    tone: 'danger',
    message: (d) => `Realtime degraded: ${d.reason}`,
  },
  {
    type: 'sync.reconcile.drift',
    tone: 'warning',
    message: (d) =>
      `Reconcile drift ${d.metric} on ${d.marketplace ?? d.channel}: ${d.driftPct}%`,
  },
  {
    type: 'sync.drift.cumulative',
    tone: 'warning',
    message: (d) =>
      `Cumulative drift on ${d.channel}: ${d.absDriftUnits} units (${d.windowHours}h window)`,
  },
  {
    type: 'sync.conflict.stale',
    tone: 'info',
    message: (d) =>
      `Stale conflicts: ${d.count} unresolved older than ${d.olderThanDays}d`,
  },
]

const MAX_BANNERS = 5

// ── Types ──────────────────────────────────────────────────────────────────

interface LiveBannerItem {
  id: string
  type: string
  tone: BannerTone
  message: string
}

// ── Component ─────────────────────────────────────────────────────────────

export default function ControlTowerBanner() {
  const [items, setItems] = useState<LiveBannerItem[]>([])

  useEffect(() => {
    if (typeof window === 'undefined') return

    let es: EventSource | null = null
    try {
      es = new EventSource(`${getBackendUrl()}/api/orders/events`)
    } catch {
      return
    }

    const push = (type: string, data: unknown) => {
      const spec = BANNER_TYPES.find((s) => s.type === type)
      if (!spec) return
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      let message: string
      try {
        message = spec.message(data as Record<string, unknown>)
      } catch {
        message = type
      }
      setItems((prev) =>
        [{ id, type, tone: spec.tone, message }, ...prev].slice(0, MAX_BANNERS),
      )
    }

    for (const spec of BANNER_TYPES) {
      es.addEventListener(spec.type, (e: MessageEvent) => {
        try {
          push(spec.type, JSON.parse(e.data))
        } catch {
          push(spec.type, { raw: e.data })
        }
      })
    }

    // onerror: banner silently stops updating on disconnect.
    // Push-health chip in the global nav is the place for connection state.
    es.onerror = () => {
      /* noop */
    }

    return () => {
      try {
        es?.close()
      } catch {
        /* noop */
      }
    }
  }, [])

  const dismiss = (id: string) =>
    setItems((prev) => prev.filter((item) => item.id !== id))

  if (items.length === 0) return null

  return (
    <div className="space-y-2" role="region" aria-label="Live sync alerts">
      {items.map((item) => (
        <Banner
          key={item.id}
          tone={item.tone}
          title={item.message}
          onDismiss={() => dismiss(item.id)}
        />
      ))}
    </div>
  )
}
