'use client'

/**
 * Generic live-refresh hook for any surface that should react to
 * order events. Subscribes to /api/orders/events (SSE bus that the
 * SP-API push + Shopify webhook + cron upsert all publish to).
 *
 * Used by:
 *   - /insights/* sub-pages (via useInsightsLiveRefresh re-export)
 *   - /fulfillment/stock (AL.2 — reservations update on order ingest)
 *   - any future surface that wants real-time order reactivity
 *
 * Debounced so a burst of order events (e.g. SQS draining 50 messages)
 * triggers ONE refresh after they settle — not 50 sequential ones.
 */

import { useEffect } from 'react'
import { getBackendUrl } from '@/lib/backend-url'

export interface UseOrderEventsRefreshOptions {
  /** Debounce window in ms. Default 2000. */
  debounceMs?: number
  /** Whether to subscribe at all. Default true — toggle off for kill-switch. */
  enabled?: boolean
  /**
   * Which event types to react to. Default: all order lifecycle + returns.
   * RT.15 added `feed.processing.finished` to the order-events bus so
   * the flat-file + images-tab UIs can refresh when Amazon SP-API
   * confirms a feed terminal status — opt in by listing it here.
   */
  eventTypes?: Array<
    | 'order.created'
    | 'order.updated'
    | 'order.cancelled'
    | 'return.created'
    | 'feed.processing.finished'
  >
  /**
   * FF-RT.1 — optional pre-refresh callback that receives the raw
   * SSE payload. Lets callers (e.g. AmazonFlatFileClient) inspect
   * the event's feedId and only act when it matches an in-flight
   * job they care about, instead of refreshing on every feed event
   * for unrelated jobs.
   */
  onEvent?: (event: { type: string; [key: string]: unknown }) => void
}

export function useOrderEventsRefresh(
  onRefresh: () => void,
  options: UseOrderEventsRefreshOptions = {},
): void {
  const {
    debounceMs = 2000,
    enabled = true,
    eventTypes = ['order.created', 'order.updated', 'order.cancelled', 'return.created'],
    onEvent,
  } = options

  useEffect(() => {
    if (!enabled) return
    if (typeof window === 'undefined') return

    let es: EventSource | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    const debouncedRefresh = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        onRefresh()
      }, debounceMs)
    }

    // RT.8 — track the timestamp of the last event we saw so the
    // SSE connection (which auto-reconnects on transient drops) can
    // request a replay of any events that landed during the gap.
    // sessionStorage so a hard reload re-fetches from scratch; tab
    // suspends + EventSource auto-reconnects share state.
    const lastEventKey = 'nexus.orders.events.lastTs.v1'
    const initialSince = (() => {
      const raw = typeof window !== 'undefined' ? sessionStorage.getItem(lastEventKey) : null
      const n = raw ? Number(raw) : NaN
      return Number.isFinite(n) && n > 0 ? n : null
    })()
    const trackTs = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { ts?: number }
        if (typeof data.ts === 'number') {
          sessionStorage.setItem(lastEventKey, String(data.ts))
        }
      } catch { /* ignore */ }
    }

    try {
      const url = initialSince
        ? `${getBackendUrl()}/api/orders/events?since=${initialSince}`
        : `${getBackendUrl()}/api/orders/events`
      es = new EventSource(url)
      for (const t of eventTypes) {
        es.addEventListener(t, (e: MessageEvent) => {
          trackTs(e)
          // FF-RT.1 — let the caller peek at the payload first.
          // Useful when the caller has its own in-flight set
          // (feedEntries) and wants to no-op when the event doesn't
          // belong to one of them. Default behaviour is still
          // refresh-on-event when no onEvent is passed.
          if (onEvent) {
            try {
              const parsed = JSON.parse(e.data) as { type: string; [key: string]: unknown }
              onEvent(parsed)
            } catch { /* ignore */ }
          }
          debouncedRefresh()
        })
      }
      // Also track ts on the ping heartbeat so a disconnect during
      // a quiet window still resumes from a recent point (not from
      // hours ago, which the buffer can't satisfy anyway).
      es.addEventListener('ping', trackTs)
    } catch {
      /* EventSource unsupported / network blocked — caller keeps
         whatever fetch-on-mount + polling it already has. */
    }

    return () => {
      if (timer) clearTimeout(timer)
      try { es?.close() } catch {}
    }
  }, [onRefresh, debounceMs, enabled, eventTypes.join(','), onEvent])
}
