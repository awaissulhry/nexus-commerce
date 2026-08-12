'use client'

/**
 * RD.P0 — the page's URL state, read and written in one place.
 *
 * Before this, **nothing on Rank & Dayparting was linkable but the route itself** — verified, not
 * assumed: `useSearchParams` had zero hits across `dayparting/*` and the grid. Market, heatmap
 * scope, drawer and drawer tab were all `useState`, so "look at this schedule" could only ever be a
 * description of where to click.
 *
 * The idiom matches its neighbours (Negative Targeting, Keyword Tracker): the URL is the state,
 * there is no local mirror to fall out of sync with it, and an absent param means the default
 * rather than a remembered preference — so a link renders the same view for whoever opens it.
 *
 * **Replace vs push.** A filter is not a navigation: changing market or scope uses `replace`, so
 * Back leaves the page instead of walking backwards through eight filter states. Opening a row
 * inspector IS a navigation, so P3 passes `history: 'push'` and Back closes the drawer — which is
 * what an operator who just opened one will press.
 */
import { useCallback, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { applyUrlState, parseUrlState, type RdUrlState } from './scope'

export interface RdUrlApi {
  state: RdUrlState
  /** Patch one or more params. Defaults are removed from the URL rather than written. */
  set: (patch: Partial<RdUrlState>, opts?: { history?: 'replace' | 'push' }) => void
}

export function useRdUrlState(): RdUrlApi {
  const router = useRouter()
  const params = useSearchParams()

  const state = useMemo(() => parseUrlState(params), [params])

  const set = useCallback((patch: Partial<RdUrlState>, opts?: { history?: 'replace' | 'push' }) => {
    const qs = applyUrlState(new URLSearchParams(params?.toString() ?? ''), patch)
    const href = qs ? `?${qs}` : '?'
    // `scroll: false` throughout: re-filtering a grid must not throw the operator back to the top
    // of a page they have scrolled down through.
    if (opts?.history === 'push') router.push(href, { scroll: false })
    else router.replace(href, { scroll: false })
  }, [params, router])

  return { state, set }
}
