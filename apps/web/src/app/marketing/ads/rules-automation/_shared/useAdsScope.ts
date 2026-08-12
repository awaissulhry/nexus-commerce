'use client'

/**
 * RA.SPINE S1 — the thin hook over `adsScope.ts`.
 *
 * **It holds no rules.** Every parse, normalisation, sentinel and round-trip rule lives in the pure
 * module next door, where it is a vitest case rather than a click on production. This file owns
 * exactly three things a pure module cannot: reading `useSearchParams`, choosing `replace` over
 * `push`, and rewriting a non-canonical URL once on mount.
 *
 * **`replace`, not `push`, and that is a decision.** A filter is not a navigation. Pushing a history
 * entry per control movement means the back button walks the operator backwards through their own
 * filtering instead of out of the page — six clicks to leave. Every routed page in this section
 * already made this choice independently (`budget-schedules`, `placement`, `bid`, `budget`,
 * `dayparting/_rd/useRdUrlState`); it is written down here so the seventh does not re-litigate it.
 *
 * ── Adopting this on a page ─────────────────────────────────────────────────────────────────────
 *
 *   const { scope, push, reach, grains } = useAdsScope(POLICY, { options })
 *
 * where `POLICY` is a module-level constant declaring what this page's URL carries — including its
 * **market policy**, which the page owns and the substrate does not (see `MarketPolicy`: Keyword
 * Tracker and Share of Voice default to `'IT'` and are right to).
 *
 * A page with its own params passes `extra` so a spine edit cannot drop them, and `extraKeys` so
 * the normalisation check shares the denominator of the value it guards — a guard counting fewer
 * keys than the writer writes will rewrite the URL on every render, forever.
 */

import { useCallback, useEffect, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  adsScopeNeedsNormalising, grainAvailability, parseAdsScope, patchAdsScope, resolveScopeReach,
  type AdsScope, type AdsScopePolicy, type GrainKey, type GrainState, type ScopeOptions, type ScopeReach,
} from './adsScope'

export interface UseAdsScopeInput {
  /** `GET /advertising/scope-options`, when the page has fetched it. Null → `reach` is null. */
  options?: ScopeOptions | null
  /**
   * The campaigns automation may write to, when the page knows. Omit it rather than passing an
   * empty set: `reach.writable` is `null` for "not known here" and must never read as `0`.
   * Source is `GET /advertising/control-room/guardrail-grid`, NOT `scope-options` — see
   * `ScopeReach.writable` for why the spec was wrong about that.
   */
  writableIds?: ReadonlySet<string> | null
  /** Write this page's own params through a spine edit, so they survive it. */
  extra?: (raw: URLSearchParams, out: URLSearchParams) => void
  /** This page's own param names, so the canonical-form check counts them too. */
  extraKeys?: readonly string[]
}

export interface UseAdsScopeResult {
  scope: AdsScope
  /** The single writer. `''` clears a param. Returns nothing; it navigates. */
  push: (patch: Record<string, string>) => void
  /** Null until `options` arrives. */
  reach: ScopeReach | null
  grains: Record<GrainKey, GrainState>
  /** The raw params, for a page reading its own. */
  params: URLSearchParams
}

export function useAdsScope(policy: AdsScopePolicy, input: UseAdsScopeInput = {}): UseAdsScopeResult {
  const router = useRouter()
  const params = useSearchParams()
  const { options = null, writableIds = null, extra, extraKeys } = input

  const searchKey = params.toString()
  const scope = useMemo(
    () => parseAdsScope(new URLSearchParams(searchKey), policy),
    // `policy` is a module-level constant on every caller; keying on it would re-parse per render
    // for a page that built it inline, which is the trap that makes a `defaultSort` effect loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchKey],
  )

  const push = useCallback((patch: Record<string, string>) => {
    const qs = patchAdsScope(new URLSearchParams(searchKey), patch, policy, extra)
    router.replace(qs ? `?${qs}` : '?', { scroll: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchKey, router, extra])

  /**
   * Rewrite a hand-typed or stale URL to the form the page actually used — once, and only when it
   * differs. A shared link and the view it produces must not disagree; the operator has no way to
   * tell which one is lying.
   */
  useEffect(() => {
    const current = new URLSearchParams(searchKey)
    if (!adsScopeNeedsNormalising(current, policy, extraKeys, extra)) return
    const qs = patchAdsScope(current, {}, policy, extra)
    router.replace(qs ? `?${qs}` : '?', { scroll: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchKey, router, extra, extraKeys])

  const reach = useMemo(
    () => resolveScopeReach(options, scope, writableIds),
    [options, scope, writableIds],
  )
  const grains = useMemo(() => grainAvailability(options), [options])

  return { scope, push, reach, grains, params }
}
