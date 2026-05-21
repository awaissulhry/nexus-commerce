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
  /** Which event types to react to. Default: all order lifecycle + returns. */
  eventTypes?: Array<'order.created' | 'order.updated' | 'order.cancelled' | 'return.created'>
}

export function useOrderEventsRefresh(
  onRefresh: () => void,
  options: UseOrderEventsRefreshOptions = {},
): void {
  const {
    debounceMs = 2000,
    enabled = true,
    eventTypes = ['order.created', 'order.updated', 'order.cancelled', 'return.created'],
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

    try {
      es = new EventSource(`${getBackendUrl()}/api/orders/events`)
      for (const t of eventTypes) {
        es.addEventListener(t, debouncedRefresh)
      }
    } catch {
      /* EventSource unsupported / network blocked — caller keeps
         whatever fetch-on-mount + polling it already has. */
    }

    return () => {
      if (timer) clearTimeout(timer)
      try { es?.close() } catch {}
    }
  }, [onRefresh, debounceMs, enabled, eventTypes.join(',')])
}
