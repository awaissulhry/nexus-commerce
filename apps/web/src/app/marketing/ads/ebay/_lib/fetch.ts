'use client'

/**
 * ER1 — eBay ads fetch layer (split from _shared.tsx, C1). D1: the window
 * argument accepts a preset string (back-compat for pages awaiting their ER3
 * slot) OR a real {start,end} DateRange from the shared DateRangePicker —
 * ads-core/date-range.ts resolves either server-side.
 */
import { useCallback, useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'

export type EbayAdsWindow = string | { start: Date; end: Date }

const iso = (d: Date) => d.toISOString().slice(0, 10)
export function windowQuery(w: EbayAdsWindow): string {
  return typeof w === 'string' ? `preset=${w}` : `startDate=${iso(w.start)}&endDate=${iso(w.end)}`
}

export function useEbayAdsFetch<T>(path: string, market: string, window: EbayAdsWindow): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const windowKey = typeof window === 'string' ? window : `${iso(window.start)}..${iso(window.end)}`
  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const sep = path.includes('?') ? '&' : '?'
      const w: EbayAdsWindow = windowKey.includes('..') ? { start: new Date(windowKey.split('..')[0]!), end: new Date(windowKey.split('..')[1]!) } : windowKey
      const r = await fetch(`${getBackendUrl()}/api/ebay-ads${path}${sep}marketplace=${market}&${windowQuery(w)}`, { credentials: 'include' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setData((await r.json()) as T)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [path, market, windowKey])
  useEffect(() => { void load() }, [load])
  return { data, error, loading, reload: load }
}

/**
 * Pick the informative half of an error body.
 *
 * Fastify's default error envelope is
 * `{ statusCode, error: "Internal Server Error", message: "<the real cause>" }`
 * — so preferring `error` showed operators the useless half of every failure.
 * Our own ads handler puts the real sentence in `error`; this prefers whichever
 * is not a bare HTTP status title.
 */
const GENERIC_TITLE = /^(internal server error|bad request|unauthorized|forbidden|not found|conflict|unprocessable entity|too many requests)$/i
export function errorTextFrom(body: { error?: string; message?: string }, status: number): string {
  const { error, message } = body
  if (error && !GENERIC_TITLE.test(error.trim())) return error
  if (message && !GENERIC_TITLE.test(message.trim())) return message
  return error ?? message ?? `HTTP ${status}`
}

export async function postEbayAds<T>(path: string, body: unknown, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'POST'): Promise<T> {
  const r = await fetch(`${getBackendUrl()}/api/ebay-ads${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  })
  const j = (await r.json().catch(() => ({}))) as T & { error?: string; message?: string }
  if (!r.ok) throw new Error(errorTextFrom(j, r.status))
  return j
}

export async function getEbayAds<T>(path: string): Promise<T> {
  const r = await fetch(`${getBackendUrl()}/api/ebay-ads${path}`, { credentials: 'include' })
  const j = (await r.json().catch(() => ({}))) as T & { error?: string; message?: string }
  if (!r.ok) throw new Error(errorTextFrom(j, r.status))
  return j
}
