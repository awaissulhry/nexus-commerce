'use client'

/**
 * RT.18 — Live-pulse heartbeat indicator.
 *
 * A tiny dot that flashes whenever an event arrives on the SSE bus,
 * so the operator can feel the pipeline. Tooltip shows the rolling
 * events-per-minute rate. Mount on chrome surfaces where space is
 * tight — /orders header, /insights/live header, anywhere a full
 * PushHealthChip would be too heavy.
 *
 *   Green steady   — connected, low activity (<2 ev/min)
 *   Green pulsing  — connected, normal activity
 *   Amber pulsing  — connected, hot burst (>10 ev/min)
 *   Slate          — disconnected (EventSource closed)
 *
 * Independent EventSource — the connection cost is negligible (a
 * single HTTP/2 stream) and keeps this component drop-in anywhere
 * without coordinating with the workspace's existing SSE hook.
 */

import { useEffect, useRef, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'

const ROLLING_WINDOW_MS = 60_000
const FLASH_MS = 600

export function LivePulse() {
  const [connected, setConnected] = useState(false)
  const [flashing, setFlashing] = useState(false)
  const [rate, setRate] = useState(0)
  const recentRef = useRef<number[]>([])
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    let es: EventSource | null = null
    try {
      es = new EventSource(`${getBackendUrl()}/api/orders/events`)
    } catch {
      return
    }
    setConnected(true)

    const recordHit = () => {
      const now = Date.now()
      recentRef.current.push(now)
      const cutoff = now - ROLLING_WINDOW_MS
      while (recentRef.current.length > 0 && recentRef.current[0]! < cutoff) {
        recentRef.current.shift()
      }
      setRate(recentRef.current.length)
      setFlashing(true)
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
      flashTimerRef.current = setTimeout(() => setFlashing(false), FLASH_MS)
    }

    // Listen to every event-type by attaching to onmessage. SSE
    // events with a specific `event:` field don't fire onmessage,
    // so also attach to the most common ones. Ping heartbeats are
    // excluded — they're not real signal, just keep-alive.
    es.onmessage = recordHit
    const NAMES = [
      'order.created',
      'order.updated',
      'order.cancelled',
      'return.created',
      'analytics.salesReport.refreshed',
      'sync.dlq.threshold',
      'competitive.buyBoxLost',
      'listing.suppressed',
      'feed.processing.finished',
      'account.health.changed',
    ]
    for (const n of NAMES) es.addEventListener(n, recordHit)

    es.onerror = () => setConnected(false)

    // Decay timer — even with no events, sweep stale entries so
    // the rate ticks down over time. 5s cadence matches the
    // PushHealthChip's tick.
    const decay = setInterval(() => {
      const cutoff = Date.now() - ROLLING_WINDOW_MS
      while (recentRef.current.length > 0 && recentRef.current[0]! < cutoff) {
        recentRef.current.shift()
      }
      setRate(recentRef.current.length)
    }, 5000)

    return () => {
      clearInterval(decay)
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
      try {
        es?.close()
      } catch {
        /* noop */
      }
    }
  }, [])

  let dotClass: string
  let title: string
  if (!connected) {
    dotClass = 'bg-slate-300 dark:bg-slate-700'
    title = 'Live sync: disconnected (reconnecting)'
  } else if (rate > 10) {
    dotClass = flashing
      ? 'bg-amber-500 scale-150 ring-2 ring-amber-200 dark:ring-amber-900'
      : 'bg-amber-500'
    title = `Live · ${rate} events/min (busy)`
  } else if (rate > 0) {
    dotClass = flashing
      ? 'bg-emerald-500 scale-150 ring-2 ring-emerald-200 dark:ring-emerald-900'
      : 'bg-emerald-500'
    title = `Live · ${rate} events/min`
  } else {
    dotClass = 'bg-emerald-500 opacity-60'
    title = 'Live · idle'
  }

  return (
    <span
      className="inline-flex items-center"
      role="status"
      aria-label={title}
      title={title}
    >
      <span
        className={`inline-block w-2 h-2 rounded-full transition-all duration-300 ${dotClass}`}
        aria-hidden="true"
      />
    </span>
  )
}
