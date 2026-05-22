'use client'

/**
 * RT.19 — Live activity feed client.
 *
 * Subscribes to /api/orders/events and renders a rolling tail of
 * every event the SSE bus emits. Last 200 events kept in memory.
 *
 * Features:
 *   - Filter by event type (multi-select chip row)
 *   - Pause / resume autoscroll (so an operator can read past
 *     events without the new ones scrolling them off-screen)
 *   - Clear button (reset the tail)
 *   - Per-event copy button (JSON to clipboard)
 *   - Connection status pill (live / disconnected)
 *
 * Independent EventSource — keeps this page drop-in without
 * coordinating with workspaces.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pause, Play, Trash2, Copy, Check } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface Event {
  id: string
  type: string
  ts: number
  data: unknown
}

const KNOWN_TYPES: { type: string; label: string; tone: string }[] = [
  { type: 'order.created', label: 'Order created', tone: 'bg-emerald-500' },
  { type: 'order.updated', label: 'Order updated', tone: 'bg-blue-500' },
  { type: 'order.cancelled', label: 'Order cancelled', tone: 'bg-rose-500' },
  { type: 'return.created', label: 'Return created', tone: 'bg-amber-500' },
  { type: 'sync.dlq.threshold', label: 'DLQ alert', tone: 'bg-rose-600' },
  { type: 'competitive.buyBoxLost', label: 'Buy Box lost', tone: 'bg-amber-500' },
  { type: 'listing.suppressed', label: 'Listing suppressed', tone: 'bg-rose-500' },
  { type: 'feed.processing.finished', label: 'Feed finished', tone: 'bg-blue-500' },
  { type: 'account.health.changed', label: 'Account health', tone: 'bg-rose-700' },
  {
    type: 'analytics.salesReport.refreshed',
    label: 'Sales report refreshed',
    tone: 'bg-slate-500',
  },
]
const KNOWN_TYPE_SET = new Set(KNOWN_TYPES.map((k) => k.type))
const MAX_EVENTS = 200

function toneFor(type: string): string {
  return KNOWN_TYPES.find((k) => k.type === type)?.tone ?? 'bg-slate-400'
}

function labelFor(type: string): string {
  return KNOWN_TYPES.find((k) => k.type === type)?.label ?? type
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${d.toLocaleTimeString('it-IT', { hour12: false })}.${String(
    d.getMilliseconds(),
  ).padStart(3, '0')}`
}

export default function LiveActivityClient() {
  const [events, setEvents] = useState<Event[]>([])
  const [enabled, setEnabledTypes] = useState<Set<string>>(
    () => new Set(KNOWN_TYPES.map((k) => k.type)),
  )
  const [paused, setPaused] = useState(false)
  const [connected, setConnected] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  useEffect(() => {
    if (typeof window === 'undefined') return
    let es: EventSource | null = null
    try {
      es = new EventSource(`${getBackendUrl()}/api/orders/events`)
    } catch {
      return
    }
    setConnected(true)

    const push = (type: string, data: unknown) => {
      if (pausedRef.current) return
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const ts =
        typeof (data as any)?.ts === 'number' ? (data as any).ts : Date.now()
      setEvents((prev) => [{ id, type, ts, data }, ...prev].slice(0, MAX_EVENTS))
    }

    for (const k of KNOWN_TYPES) {
      es.addEventListener(k.type, (e: MessageEvent) => {
        try {
          push(k.type, JSON.parse(e.data))
        } catch {
          push(k.type, { raw: e.data })
        }
      })
    }
    es.onerror = () => setConnected(false)

    return () => {
      try {
        es?.close()
      } catch {
        /* noop */
      }
    }
  }, [])

  const toggleType = useCallback((type: string) => {
    setEnabledTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }, [])

  const visible = useMemo(
    () => events.filter((e) => enabled.has(e.type) || !KNOWN_TYPE_SET.has(e.type)),
    [events, enabled],
  )

  const copyJson = (e: Event) => {
    try {
      navigator.clipboard.writeText(JSON.stringify(e.data, null, 2))
      setCopiedId(e.id)
      setTimeout(() => setCopiedId(null), 1500)
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap p-3 rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <span
          className={cn(
            'inline-flex items-center gap-1.5 text-xs font-semibold px-2 py-1 rounded',
            connected
              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
              : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
          )}
        >
          <span
            className={cn(
              'inline-block w-1.5 h-1.5 rounded-full',
              connected ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400',
            )}
            aria-hidden="true"
          />
          {connected ? 'Live' : 'Disconnected'}
        </span>

        <button
          type="button"
          onClick={() => setPaused((p) => !p)}
          className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
        >
          {paused ? (
            <>
              <Play className="w-3 h-3" /> Resume
            </>
          ) : (
            <>
              <Pause className="w-3 h-3" /> Pause
            </>
          )}
        </button>
        <button
          type="button"
          onClick={() => setEvents([])}
          className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
        >
          <Trash2 className="w-3 h-3" /> Clear
        </button>

        <span className="text-xs text-slate-500 ml-auto tabular-nums">
          {visible.length} / {events.length} shown · max {MAX_EVENTS}
        </span>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {KNOWN_TYPES.map((k) => {
          const on = enabled.has(k.type)
          return (
            <button
              key={k.type}
              type="button"
              onClick={() => toggleType(k.type)}
              className={cn(
                'inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded border transition',
                on
                  ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100 border-slate-300 dark:border-slate-700'
                  : 'bg-white dark:bg-slate-900 text-slate-400 dark:text-slate-500 border-slate-200 dark:border-slate-800 line-through',
              )}
            >
              <span
                className={cn('inline-block w-1.5 h-1.5 rounded-full', k.tone)}
                aria-hidden="true"
              />
              {k.label}
            </button>
          )
        })}
      </div>

      {visible.length === 0 && (
        <div className="rounded border border-dashed border-slate-200 dark:border-slate-800 p-8 text-center text-sm text-slate-400">
          {paused
            ? 'Paused. Click Resume to start capturing again.'
            : 'Waiting for events...'}
        </div>
      )}

      <ul className="space-y-1 font-mono text-xs">
        {visible.map((e) => (
          <li
            key={e.id}
            className="flex items-start gap-2 px-3 py-1.5 rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800/50"
          >
            <span className="text-slate-400 tabular-nums shrink-0 w-24">
              {formatTime(e.ts)}
            </span>
            <span
              className={cn(
                'inline-block w-1.5 h-1.5 rounded-full mt-1.5 shrink-0',
                toneFor(e.type),
              )}
              aria-hidden="true"
            />
            <span className="font-semibold text-slate-700 dark:text-slate-300 shrink-0">
              {labelFor(e.type)}
            </span>
            <span className="text-slate-500 dark:text-slate-400 truncate flex-1">
              {summariseEvent(e)}
            </span>
            <button
              type="button"
              onClick={() => copyJson(e)}
              className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 shrink-0"
              title="Copy event JSON"
              aria-label="Copy event JSON"
            >
              {copiedId === e.id ? (
                <Check className="w-3 h-3 text-emerald-500" />
              ) : (
                <Copy className="w-3 h-3" />
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function summariseEvent(e: Event): string {
  const d = e.data as Record<string, unknown>
  // Try the most common identifying fields first.
  const parts: string[] = []
  for (const key of [
    'orderId',
    'channelOrderId',
    'channel',
    'asin',
    'sku',
    'marketplaceId',
    'feedId',
    'depth',
    'status',
    'accountStatus',
    'count',
  ]) {
    if (d?.[key] != null) parts.push(`${key}=${d[key]}`)
  }
  return parts.join(' · ') || JSON.stringify(d).slice(0, 120)
}
