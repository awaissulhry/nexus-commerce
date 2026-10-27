'use client'

/**
 * Reviews area — the live review stream (SSE `GET /api/reviews/events`, published by review ingest, the spike
 * detector and reply send). The Overview's "Needs you" card and the Inbox call it to re-read when a review arrives,
 * turns negative or gets a reply; Insights › Alerts and the Overview's alert tile when the spike check opens an alert. The browser reconnects a dropped stream by itself; when the server closes it for
 * good (an error answer), this hook opens it again after a growing wait, so a page left open keeps updating.
 *
 * Against a local API the stream is off unless dev streams are on (lib/sync/dev-stream-gate.ts): an open stream holds
 * one of the browser's six connections to that address.
 */
import { useEffect, useRef } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { streamsEnabled } from '@/lib/sync/dev-stream-gate'

/** `review.spike.detected`: the hourly spike check opened an alert (Insights › Alerts and the Overview re-read on it). */
export type ReviewEventType = 'review.created' | 'review.negative' | 'review.responded' | 'review.spike.detected'

export interface ReviewEvent {
  type: ReviewEventType
  ts: number
  [key: string]: unknown
}

export const REVIEW_EVENT_TYPES: readonly ReviewEventType[] = ['review.created', 'review.negative', 'review.responded']

/** Wait before reopening a closed stream: 2 s, 4 s, 8 s … at most 60 s. */
export function reconnectDelay(attempt: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, attempt))
}

/** The event's payload, or null when it is not a review event this page asked for. */
export function parseReviewEvent(type: string, data: string, wanted: readonly string[]): ReviewEvent | null {
  if (!wanted.includes(type)) return null
  try {
    const parsed = JSON.parse(data) as Partial<ReviewEvent> | null
    if (!parsed || typeof parsed !== 'object') return null
    return { ...parsed, type: type as ReviewEventType, ts: typeof parsed.ts === 'number' ? parsed.ts : Date.now() }
  } catch {
    return null
  }
}

export function useReviewEvents(
  onEvent: (event: ReviewEvent) => void,
  options: { types?: readonly ReviewEventType[]; enabled?: boolean } = {},
): void {
  const { types = REVIEW_EVENT_TYPES, enabled = true } = options
  const callback = useRef(onEvent)
  useEffect(() => { callback.current = onEvent })
  const typesKey = [...types].sort().join(',')

  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || typeof EventSource === 'undefined' || !streamsEnabled()) return
    const wanted = typesKey.split(',')
    let source: EventSource | null = null
    let timer: number | null = null
    let attempt = 0
    let stopped = false

    const open = () => {
      if (stopped) return
      source = new EventSource(`${getBackendUrl()}/api/reviews/events`)
      source.addEventListener('ping', () => { attempt = 0 })
      for (const type of wanted) {
        source.addEventListener(type, (event) => {
          attempt = 0
          const parsed = parseReviewEvent(type, (event as MessageEvent<string>).data, wanted)
          if (parsed) callback.current(parsed)
        })
      }
      source.addEventListener('error', () => {
        // CONNECTING = the browser is retrying by itself; CLOSED = it gave up, so retry later.
        if (!source || source.readyState !== EventSource.CLOSED || stopped) return
        source.close()
        timer = window.setTimeout(open, reconnectDelay(attempt++))
      })
    }
    open()
    return () => {
      stopped = true
      if (timer !== null) window.clearTimeout(timer)
      source?.close()
    }
  }, [enabled, typesKey])
}
