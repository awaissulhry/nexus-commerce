/**
 * Phase 10 — usePolledList hook.
 *
 * Centralises everything every Phase-10 page does to fetch a paginated
 * list with smart polling + ETag + visibility refresh + cross-page
 * invalidation. Each page provides a URL builder; the hook owns:
 *
 *   1. Initial fetch on mount + whenever URL changes
 *   2. Background poll every `intervalMs` while document is visible
 *   3. Refetch on visibilitychange and window focus
 *   4. ETag round-trip:
 *        send If-None-Match with the previous response's ETag
 *        on 304, keep the existing data; just bump lastFetchedAt
 *        on 200, replace data + capture the new ETag
 *   5. Invalidation subscription: when another tab / page emits an
 *      invalidation matching the page's `invalidationTypes`, refetch
 *      immediately (debounced 200ms so a flurry of invalidations
 *      coalesces into one round-trip)
 *
 * Why centralise
 * ──────────────
 * Phase 1 audit found polling intervals inconsistent across pages
 * (30s vs visibility-only vs none vs exponential). Pulling the
 * mechanism into one hook makes "you'll see updates within 30s on
 * every page" a property of the codebase rather than something each
 * page has to remember.
 *
 * Usage
 * ─────
 *   const { data, loading, error, lastFetchedAt, refetch } = usePolledList<MyResponse>({
 *     url: useMemo(() => `/api/things?${qs}`, [qs]),
 *     intervalMs: 30_000,
 *     invalidationTypes: ['product.updated', 'listing.updated'],
 *   })
 */

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { useInvalidationChannel } from './invalidation-channel'
import type { InvalidationType } from './invalidation-channel'

export interface UsePolledListOptions {
  /**
   * Path or absolute URL to fetch. The hook prepends getBackendUrl()
   * if the value starts with '/api/'. Pass `null` to suspend fetching
   * (e.g. while a precondition param is missing).
   */
  url: string | null
  /** Background poll interval in ms. Default 30_000. Pass 0 to disable polling. */
  intervalMs?: number
  /**
   * Invalidation event types this page cares about. When a matching
   * event arrives the hook triggers an immediate (debounced) refetch.
   */
  invalidationTypes?: InvalidationType[]
  /**
   * If false, the hook skips the visibility/focus refresh hooks. Rare —
   * default true matches what every Phase 10 page should want.
   */
  refreshOnFocus?: boolean
}

export interface UsePolledListResult<T> {
  data: T | null
  loading: boolean
  error: string | null
  lastFetchedAt: number | null
  /** Force an immediate refetch (used by manual refresh buttons). */
  refetch: () => void
}

/**
 * The fetch hook. Generic over the response shape so callers get a
 * typed `data` without casting at the call site.
 */
export function usePolledList<T = unknown>(
  opts: UsePolledListOptions,
): UsePolledListResult<T> {
  const {
    url,
    intervalMs = 30_000,
    invalidationTypes = [],
    refreshOnFocus = true,
  } = opts

  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null)

  // ETag for the most recent successful fetch. Sent as If-None-Match
  // on subsequent fetches so the server can respond 304 and we skip
  // the JSON parse / state update.
  const etagRef = useRef<string | null>(null)
  // Latest URL — captured in a ref so the various effects below don't
  // each have to depend on `url` directly (which would re-subscribe on
  // every render).
  const urlRef = useRef<string | null>(url)
  urlRef.current = url

  // AbortController per in-flight request so a stale response from a
  // previous URL/filters doesn't overwrite a fresh result.
  const abortRef = useRef<AbortController | null>(null)

  const doFetch = useCallback(async () => {
    const targetUrl = urlRef.current
    if (!targetUrl) return
    // Cancel any in-flight request before starting a new one.
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac

    const fullUrl = targetUrl.startsWith('/api/')
      ? `${getBackendUrl()}${targetUrl}`
      : targetUrl

    const headers: Record<string, string> = {}
    if (etagRef.current) headers['If-None-Match'] = etagRef.current

    setLoading(true)
    setError(null)
    try {
      const res = await fetch(fullUrl, {
        cache: 'no-store',
        headers,
        signal: ac.signal,
      })
      if (res.status === 304) {
        // Server says nothing changed — keep current data, just bump
        // the freshness timestamp so the indicator ticks down from now.
        setLastFetchedAt(Date.now())
        return
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      const newEtag = res.headers.get('ETag')
      if (newEtag) etagRef.current = newEtag
      const json = (await res.json()) as T
      setData(json)
      setLastFetchedAt(Date.now())
    } catch (err) {
      // Aborts are expected when the URL changes; not a real error.
      if (err instanceof DOMException && err.name === 'AbortError') return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      // Only clear loading if the controller is still ours (a newer
      // fetch may have replaced it).
      if (abortRef.current === ac) {
        setLoading(false)
      }
    }
  }, [])

  // Refetch whenever the URL changes. Reset the ETag so the new URL
  // doesn't accidentally reuse an unrelated cache key.
  useEffect(() => {
    etagRef.current = null
    if (url == null) {
      setData(null)
      setLastFetchedAt(null)
      return
    }
    doFetch()
  }, [url, doFetch])

  // Background polling while the document is visible. We don't poll
  // hidden tabs because the user can't see the data and the
  // visibilitychange listener will catch them up when they switch back.
  useEffect(() => {
    if (!intervalMs || intervalMs <= 0) return
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible' && urlRef.current) {
        doFetch()
      }
    }, intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs, doFetch])

  // Visibility / focus refresh — when the user comes back to the tab
  // after some time away, fetch fresh data immediately rather than
  // waiting for the next interval tick.
  useEffect(() => {
    if (!refreshOnFocus) return
    const onVis = () => {
      if (document.visibilityState === 'visible') doFetch()
    }
    const onFocus = () => doFetch()
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', onFocus)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', onFocus)
    }
  }, [refreshOnFocus, doFetch])

  // Cross-page invalidation. A flurry of invalidations (e.g. a bulk
  // job affecting many products) is debounced into one refetch.
  const invalidationDebounce = useRef<number | null>(null)
  useInvalidationChannel(invalidationTypes, () => {
    if (invalidationDebounce.current) {
      window.clearTimeout(invalidationDebounce.current)
    }
    invalidationDebounce.current = window.setTimeout(() => {
      doFetch()
    }, 200)
  })

  return { data, loading, error, lastFetchedAt, refetch: doFetch }
}
