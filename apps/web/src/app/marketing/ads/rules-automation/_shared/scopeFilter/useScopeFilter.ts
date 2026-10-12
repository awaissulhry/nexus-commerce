'use client'

/**
 * The filter bar's state on a page (2026-10-12): the picks in the address, the lists of `GET /api/advertising/scope-options`
 * (read once per page load), and what every view needs from them. It holds no rules of its own — they are in
 * `scopeFilterModel.ts`. A filter change REPLACES the address (Back leaves the page; it does not walk the filters).
 *
 * Once the lists are read, the picks are the ones that still fit (`normalizePicks`): the views read with those at once,
 * and the address is written again (replace) when it held more — a pick of another market, a campaign whose portfolio was
 * un-picked, the Negative Targeting page's old `?scope=`.
 *
 * Every view takes `ScopeView` (`scope` prop): server views send `api`; the views filtered here keep the rows
 * `reach` reaches (`pending` while the lists are read, so a row is never shown that the filter would hide).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from '@/lib/workspaces/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import {
  LEGACY_PARAM, NO_PICKS, apiParams, buildIndex, normalizePicks, picksActive, picksCount, picksKey, reachOf, readPicks, samePicks, withPicks,
  type ScopeApi, type ScopeIndex, type ScopeKey, type ScopeListsState, type ScopeOptionsAnswer, type ScopePicks, type ScopeReach,
} from './scopeFilterModel'

/** What a view needs from the filter. */
export interface ScopeView {
  /** A pick is on. */
  active: boolean
  /** One string per set of picks (a read's key, an effect's dependency). */
  key: string
  /** The server's list params (`portfolioIds` …), only the lists with a pick. */
  api: ScopeApi
  /** What the picks reach, for a view filtered here; null = keep every row. */
  reach: ScopeReach | null
  /** The lists are still read: a view filtered here shows nothing yet. */
  pending: boolean
  /** Clear every pick — and, in the same address change, the view's own `extra` params (one write: two in one tick lose
   *  the first). */
  clear(extra?: Readonly<Record<string, string | null>>): void
}

export interface ScopeFilter extends ScopeView {
  picks: ScopePicks
  /** How many lists have a pick. */
  count: number
  index: ScopeIndex | null
  state: ScopeListsState
  error: string | null
  retry(): void
  set(key: ScopeKey, ids: readonly string[]): void
}

/** The page's market as the lists read it: a code, or every market. */
const marketKey = (m: string | null | undefined) => (m && m.trim() ? m.trim() : 'all')

export function useScopeFilter(market: string | null | undefined, opts: { clear?: readonly string[] } = {}): ScopeFilter {
  const router = useRouter()
  const params = useSearchParams()
  const search = params.toString()
  const raw = useMemo(() => readPicks(new URLSearchParams(search)), [search])
  const legacy = useMemo(() => new URLSearchParams(search).has(LEGACY_PARAM), [search])
  const clearKeys = useRef(opts.clear ?? [])
  clearKeys.current = opts.clear ?? []

  // ── the lists, once per page load ──
  const [options, setOptions] = useState<ScopeOptionsAnswer | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    setError(null)
    const read = async () => {
      try {
        const r = await fetch(`${getBackendUrl()}/api/advertising/scope-options`, { cache: 'no-store' })
        const body = (await r.json().catch(() => null)) as (ScopeOptionsAnswer & { error?: unknown }) | null
        if (!live) return
        if (!r.ok || !body || !Array.isArray(body.campaigns)) {
          setError(typeof body?.error === 'string' && body.error.trim() ? body.error.trim() : `HTTP ${r.status}`)
          return
        }
        setOptions(body)
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e))
      }
    }
    void read()
    return () => { live = false }
  }, [attempt])
  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  const m = marketKey(market)
  const index = useMemo(() => (options ? buildIndex(options, m) : null), [options, m])
  const rawKey = picksKey(raw)
  const picks = useMemo(() => (index ? normalizePicks(raw, index) : raw), [rawKey, index]) // eslint-disable-line react-hooks/exhaustive-deps
  const key = picksKey(picks)
  const picksRef = useRef(picks)
  picksRef.current = picks

  // The address follows the picks that fit: the old `?scope=` written in the new params, a stale pick dropped — once.
  useEffect(() => {
    if (!legacy && (!index || samePicks(raw, picks))) return
    const qs = withPicks(window.location.search, picks)
    router.replace(qs ? `?${qs}` : '?', { scroll: false })
  }, [legacy, rawKey, key, index]) // eslint-disable-line react-hooks/exhaustive-deps

  const write = useCallback((next: ScopePicks, extra?: Readonly<Record<string, string | null>>) => {
    const qs = withPicks(window.location.search, next, clearKeys.current, extra)
    router.replace(qs ? `?${qs}` : '?', { scroll: false })
  }, [router])
  const set = useCallback((k: ScopeKey, ids: readonly string[]) => {
    const next = { ...picksRef.current, [k]: [...ids] }
    write(index ? normalizePicks(next, index) : next)
  }, [index, write])
  const clear = useCallback((extra?: Readonly<Record<string, string | null>>) => write(NO_PICKS, extra), [write])

  const active = picksActive(picks)
  const reach = useMemo(() => (index ? reachOf(picks, index) : null), [key, index]) // eslint-disable-line react-hooks/exhaustive-deps
  const api = useMemo(() => apiParams(picks), [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const state: ScopeListsState = options ? 'ready' : error ? 'failed' : 'reading'

  return {
    picks, active, count: picksCount(picks), key, api, reach,
    // Lists that failed: the views filtered here cannot narrow — they show every row and the bar says why.
    pending: active && state === 'reading',
    index, state, error, retry, set, clear,
  }
}
