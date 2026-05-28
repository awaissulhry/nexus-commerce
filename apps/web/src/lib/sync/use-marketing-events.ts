'use client'

/**
 * UM-series (P3) — live-refresh hook for Unified Marketing OS surfaces.
 *
 * Subscribes to /api/marketing/os/events (the marketing-events SSE bus
 * that the backfill, forward sync, budget rebalancer, and automation
 * engine all publish to). Mirrors useOrderEventsRefresh: debounced
 * refresh + sessionStorage replay cursor so a reconnecting tab catches
 * up via ?since=<ts> rather than a heavy full re-fetch.
 *
 * Used by the cockpit roster (P3), calendar (P4), budget center (P7),
 * and automation studio (P6).
 */

import { useEffect } from 'react'
import { getBackendUrl } from '@/lib/backend-url'

export type MarketingEventType =
  | 'campaign.mutated'
  | 'campaign.metrics.refreshed'
  | 'budget.rebalanced'
  | 'rule.executed'

export interface UseMarketingEventsOptions {
  /** Debounce window in ms. Default 2000. */
  debounceMs?: number
  /** Whether to subscribe at all. Default true. */
  enabled?: boolean
  /** Which event types to react to. Default: all. */
  eventTypes?: MarketingEventType[]
}

const ALL_TYPES: MarketingEventType[] = [
  'campaign.mutated',
  'campaign.metrics.refreshed',
  'budget.rebalanced',
  'rule.executed',
]

export function useMarketingEvents(
  onRefresh: () => void,
  options: UseMarketingEventsOptions = {},
): void {
  const { debounceMs = 2000, enabled = true, eventTypes = ALL_TYPES } = options

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

    const lastEventKey = 'nexus.marketing.events.lastTs.v1'
    const initialSince = (() => {
      try {
        const raw = sessionStorage.getItem(lastEventKey)
        return raw ? Number(raw) : 0
      } catch {
        return 0
      }
    })()

    const rememberTs = (ts: number) => {
      try {
        sessionStorage.setItem(lastEventKey, String(ts))
      } catch {
        // sessionStorage unavailable (private mode) — replay just won't work
      }
    }

    const base = `${getBackendUrl()}/api/marketing/os/events`
    const url = initialSince > 0 ? `${base}?since=${initialSince}` : base
    es = new EventSource(url)

    const handle = (type: MarketingEventType) => (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data)
        if (typeof data?.ts === 'number') rememberTs(data.ts)
      } catch {
        // ignore malformed payloads — still refresh
      }
      if (eventTypes.includes(type)) debouncedRefresh()
    }

    for (const t of ALL_TYPES) es.addEventListener(t, handle(t) as EventListener)

    return () => {
      if (timer) clearTimeout(timer)
      es?.close()
    }
    // onRefresh intentionally excluded — callers pass a stable callback or
    // accept that re-subscribing on change is fine (matches useOrderEventsRefresh).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, debounceMs])
}
