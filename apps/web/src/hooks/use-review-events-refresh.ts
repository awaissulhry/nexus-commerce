'use client'

/**
 * RX.3 — live-refresh hook for review surfaces. Subscribes to
 * /api/reviews/events (the SSE bus that ingest + spike-detector + reply
 * send publish to). Mirrors use-order-events-refresh.ts.
 *
 * Two callbacks:
 *   - onRefresh: debounced "something changed, re-fetch your view"
 *   - onEvent:   per-event, undebounced — for toasts / browser
 *     notifications that need the individual payload (e.g. a new
 *     negative review).
 */

import { useEffect } from 'react'
import { getBackendUrl } from '@/lib/backend-url'

export type ReviewEventType =
  | 'review.created'
  | 'review.negative'
  | 'review.spike.detected'
  | 'review.responded'

export interface ReviewEventPayload {
  type: string
  ts: number
  [k: string]: unknown
}

export interface UseReviewEventsOptions {
  debounceMs?: number
  enabled?: boolean
  eventTypes?: ReviewEventType[]
  onEvent?: (event: ReviewEventPayload) => void
}

export function useReviewEventsRefresh(
  onRefresh: () => void,
  options: UseReviewEventsOptions = {},
): void {
  const {
    debounceMs = 2000,
    enabled = true,
    eventTypes = ['review.created', 'review.negative', 'review.spike.detected', 'review.responded'],
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

    const lastEventKey = 'nexus.reviews.events.lastTs.v1'
    const initialSince = (() => {
      const raw = sessionStorage.getItem(lastEventKey)
      const n = raw ? Number(raw) : NaN
      return Number.isFinite(n) && n > 0 ? n : null
    })()

    const handle = (e: MessageEvent) => {
      let data: ReviewEventPayload | null = null
      try {
        data = JSON.parse(e.data) as ReviewEventPayload
        if (typeof data.ts === 'number') {
          sessionStorage.setItem(lastEventKey, String(data.ts))
        }
      } catch {
        /* ignore */
      }
      if (data && onEvent) {
        try {
          onEvent(data)
        } catch {
          /* a bad consumer must not break the stream */
        }
      }
      debouncedRefresh()
    }

    const trackTs = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { ts?: number }
        if (typeof data.ts === 'number') sessionStorage.setItem(lastEventKey, String(data.ts))
      } catch {
        /* ignore */
      }
    }

    try {
      const url = initialSince
        ? `${getBackendUrl()}/api/reviews/events?since=${initialSince}`
        : `${getBackendUrl()}/api/reviews/events`
      es = new EventSource(url)
      for (const t of eventTypes) {
        es.addEventListener(t, handle as EventListener)
      }
      es.addEventListener('ping', trackTs as EventListener)
    } catch {
      /* EventSource unsupported / blocked — caller keeps its polling */
    }

    return () => {
      if (timer) clearTimeout(timer)
      try {
        es?.close()
      } catch {
        /* ignore */
      }
    }
  }, [onRefresh, debounceMs, enabled, eventTypes.join(','), onEvent])
}
