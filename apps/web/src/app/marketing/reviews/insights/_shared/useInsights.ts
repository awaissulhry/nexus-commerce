'use client'

/**
 * Reviews › Insights — what every Insights page does the same way:
 *
 *   useInsightsScope()   the scope (channel, market, period) read once from the address on the client, and the page's
 *                        other address values with it (`initial`).
 *   useAddressSync()     writes the scope and the page's own values back to the address (`history.replaceState({}, …)`:
 *                        Next's own state object would make the app router skip it), so a reload shows the same thing.
 *   useInsightsRead()    one read of the Reviews API that refreshes every 60 s, when the tab comes back, and when this or
 *                        another tab changes what it shows (BroadcastChannel invalidations). A failed refresh keeps the
 *                        last answer on screen and says so; a failed first read is an error, never zeros.
 *   useScopeChoices()    the channel-and-market picker's choices: every channel and market with reviews or Amazon topics
 *                        in the period (`GET /api/reviews/spotlight/scopes`).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useInvalidationChannel, type InvalidationType } from '@/lib/sync/invalidation-channel'
import { reviewsGet } from '../../_lib/reviewsFetch'
import { withQuery, type LinkParams } from '../../_lib/reviewsLinks'
import { insightsSearch, parseInsightsScope, type InsightsPeriod, type InsightsScope, type ScopeChoice } from './insightsScope'

export const INSIGHTS_REFRESH_MS = 60_000

export interface InsightsAddress {
  /** Null until the address is read (the first client render). */
  scope: InsightsScope | null
  /** The address as the page opened, for the page's own values (`sort`, `status`, `product` …). */
  initial: URLSearchParams | null
  setScope: (next: Partial<InsightsScope>) => void
}

export function useInsightsScope(): InsightsAddress {
  const [state, setState] = useState<{ scope: InsightsScope; initial: URLSearchParams } | null>(null)
  useEffect(() => {
    const initial = new URLSearchParams(window.location.search)
    setState({ scope: parseInsightsScope(initial), initial })
  }, [])
  const setScope = useCallback((next: Partial<InsightsScope>) => {
    setState((s) => (s ? { ...s, scope: { ...s.scope, ...next } } : s))
  }, [])
  return { scope: state?.scope ?? null, initial: state?.initial ?? null, setScope }
}

/** Keep the address in step with the scope and the page's own values (nothing is written before the scope is read). */
export function useAddressSync(scope: InsightsScope | null, page: LinkParams = {}): void {
  const search = scope ? insightsSearch(scope, page) : null
  useEffect(() => {
    if (search == null) return
    const next = `${window.location.pathname}${search}`
    if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState({}, '', next)
  }, [search])
}

export interface InsightsRead<T> {
  data: T | null
  /** The last read failed (with `data`: an older answer is still shown). */
  error: string | null
  /** No answer yet for this request (first read, or the scope changed). */
  loading: boolean
  /** A read is on its way. */
  updating: boolean
  /** When the shown answer arrived (ms). */
  at: number | null
  reload: () => void
}

/**
 * One read that keeps itself fresh. `path` null = not yet (the scope is not read): nothing is fetched. A change of
 * `path` or `params` reads again and, until it answers, shows nothing of the old request (never one scope's numbers
 * under another scope's header) — unless `options.keep` names the same thing as before (the scope, while only a filter
 * or a sort changed): then the last answer stays on screen under "Updating…" until the new one arrives.
 */
export function useInsightsRead<T>(
  path: string | null,
  params: LinkParams,
  events: readonly InvalidationType[] = [],
  options: { keep?: string | null } = {},
): InsightsRead<T> {
  const key = path == null ? null : withQuery(path, params)
  const keep = options.keep ?? null
  const [state, setState] = useState<{ key: string | null; keep: string | null; data: T | null; error: string | null; at: number | null }>({ key: null, keep: null, data: null, error: null, at: null })
  const keepRef = useRef(keep)
  keepRef.current = keep
  const [updating, setUpdating] = useState(false)
  const seq = useRef(0)
  const keyRef = useRef(key)
  keyRef.current = key
  const paramsRef = useRef(params)
  paramsRef.current = params

  const read = useCallback(async () => {
    const current = keyRef.current
    if (current == null || path == null) return
    const mine = ++seq.current
    setUpdating(true)
    const res = await reviewsGet<T>(path, paramsRef.current)
    if (mine !== seq.current) return
    setUpdating(false)
    setState((prev) => {
      if (res.error) return prev.key === current && prev.data != null ? { ...prev, error: res.error } : { key: current, keep: keepRef.current, data: null, error: res.error, at: null }
      return { key: current, keep: keepRef.current, data: res.data, error: null, at: Date.now() }
    })
  }, [path])

  useEffect(() => {
    if (key == null) return
    void read()
  }, [key, read])

  useEffect(() => {
    if (key == null) return
    const id = window.setInterval(() => { if (document.visibilityState === 'visible') void read() }, INSIGHTS_REFRESH_MS)
    const onFocus = () => void read()
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('focus', onFocus)
    }
  }, [key, read])

  useInvalidationChannel([...events], () => void read())

  // The answer on screen is this request's — or, while it reads, the last answer of the same `keep` (the same scope:
  // a new filter or sort keeps the page steady instead of blanking it).
  const own = state.key === key || (keep != null && state.keep === keep && state.data != null)
  return {
    data: own ? state.data : null,
    error: own ? state.error : null,
    loading: key != null && (!own || (state.data == null && state.error == null)),
    updating,
    at: own ? state.at : null,
    reload: () => void read(),
  }
}

export interface ScopesAnswer {
  options: ScopeChoice[]
  limit: { perDay: number; usedToday: number; left: number }
  minReviews: number
  windowDays: number
}

/** The picker's choices for a period (read again when the period changes, and when a brief is written). */
export function useScopeChoices(period: InsightsPeriod | null): InsightsRead<ScopesAnswer> {
  return useInsightsRead<ScopesAnswer>(period ? '/reviews/spotlight/scopes' : null, { period }, ['review.brief.generated'])
}
