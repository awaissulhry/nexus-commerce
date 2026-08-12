'use client'

/**
 * APS.2a — the ads console's single answer to "which Amazon marketplace am I
 * working in".
 *
 * Before this, all five campaign-builder launch payloads hardcoded
 * `market: 'IT'` (SpSuperWizard ×2, Quick, Guided, Single). A German campaign
 * was not something the operator could get wrong — it was something they could
 * not express at all. Meanwhile each analytics page kept its own local market
 * filter derived from whichever campaigns happened to load, so nothing agreed
 * with anything else.
 *
 * CONNECTED is not LAUNCHABLE, and that distinction is load-bearing.
 * GET /advertising/connections returns nine rows; only the active + production
 * ones can actually receive a campaign — measured 2026-07-30: DE, ES, FR, IT
 * are production with writes enabled, while IE, NL, PL, SE and UK are sandbox.
 * Writing to a sandbox profile "succeeds" and produces a campaign no shopper
 * will ever see, which is the worst possible failure: silent.
 *
 * So sandbox markets stay VISIBLE in the picker — hiding them makes "why is
 * Poland missing?" unanswerable — but they are never selectable as a launch
 * target, and they say why.
 *
 * The provider deliberately reports `ready: false` until BOTH the connection
 * list and the persisted choice have resolved. A launch control must never
 * read a marketplace we are still guessing at.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react'
import { getBackendUrl } from '@/lib/backend-url'

const STORAGE_KEY = 'nexus.ads.marketplace'
/**
 * RA.SPINE S5 — a SECOND key, deliberately, for the analytics scope.
 *
 * Not a second copy of one fact: they are two different facts. `market` is *where a campaign would
 * launch* and can never be "all"; `scopeMarket` is *what an analytics page is currently reading*,
 * where "all markets" is the most common answer. Sharing one key would mean an operator switching
 * a grid to All markets silently repointed their launch target — or, worse, could not be expressed
 * at all, which is what happens today.
 */
const SCOPE_STORAGE_KEY = 'nexus.ads.scopeMarket'
/** Only used to break a tie when nothing is persisted — never to fabricate a market. */
const PREFERRED = 'IT'
/** The analytics sentinel. Mirrors `MarketSelect`'s `allowAll` and `marketLabel('all')`. */
export const ALL_MARKETS = 'all'

export interface AdsMarket {
  code: string
  label: string
  /** active + production. Anything else cannot receive a real campaign. */
  launchable: boolean
  mode: string
  writesEnabled: boolean
}

interface Ctx {
  /**
   * The selected LAUNCH marketplace, or '' while still resolving.
   *
   * 🔴 Never `'all'`. Five campaign builders read this field, and for them "all markets" must stay
   * inexpressible — a builder launching into "all" is the silent-failure class this provider exists
   * to remove. An analytics page wants `scopeMarket`.
   */
  market: string
  setMarket: (m: string) => void
  /**
   * RA.SPINE S5 — the ANALYTICS scope market, which **may be `'all'`**.
   *
   * The provider could not express "all markets" before this: after `ready` it held exactly one
   * launchable code, so the eleven Rules & Automation pages adopting it as-is would have silently
   * narrowed every one of them to IT — on an account whose 220 campaigns span four markets and
   * whose census is account-wide. `MarketSelect` already has `allowAll` and `marketLabel('all')`
   * already returns "All markets": the control modelled what the provider did not.
   *
   * Additive on purpose. `market` above is untouched, so the five builder consumers cannot see this
   * field and cannot be handed an `'all'` by a widened type.
   *
   * ⚠ This is a DEFAULT, not an authority. The URL wins: `?market=` present means that value, no
   * exceptions (`_shared/adsScope.ts`). A page reads this only to answer "what does an absent
   * `?market=` mean here", and only when its own policy allows `'all'`.
   */
  scopeMarket: string
  /**
   * Persists. Call it only when the OPERATOR MOVES THE CONTROL, never from a deep link — opening a
   * colleague's `?market=DE` link must not repoint your own default. That single rule is what stops
   * localStorage and the URL disagreeing.
   */
  setScopeMarket: (m: string) => void
  /** Every connection, launchable or not, sorted with launchable first. */
  markets: AdsMarket[]
  /** Just the codes that can receive a campaign. */
  launchable: string[]
  /** False until connections AND the persisted choice have resolved. */
  ready: boolean
  error: string | null
}

const MarketplaceCtx = createContext<Ctx | null>(null)

type RawConn = {
  marketplace?: string
  accountLabel?: string | null
  mode?: string
  isActive?: boolean
  writesEnabledAt?: string | null
}

export function AdsMarketplaceProvider({ children }: { children: ReactNode }) {
  const [markets, setMarkets] = useState<AdsMarket[]>([])
  const [market, setMarketState] = useState('')
  // Seeded to the sentinel rather than to '': an analytics page reading this before `ready` should
  // see "the whole account", which is true, rather than "no market", which would blank a grid.
  const [scopeMarket, setScopeMarketState] = useState(ALL_MARKETS)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    // Client-side fetch on purpose: SSR requests are anonymous and this
    // endpoint 401s silently for them.
    fetch(`${getBackendUrl()}/api/advertising/connections`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { items?: RawConn[] }) => {
        if (!alive) return
        const list: AdsMarket[] = (j.items ?? [])
          .filter((c) => c.marketplace)
          .map((c) => ({
            code: String(c.marketplace).toUpperCase(),
            label: c.accountLabel ?? '',
            mode: c.mode ?? 'sandbox',
            writesEnabled: !!c.writesEnabledAt,
            launchable: !!c.isActive && c.mode === 'production',
          }))
          // Launchable first, then alphabetical — the operator's real choices
          // sit at the top of the menu rather than interleaved with sandboxes.
          .sort((a, b) =>
            a.launchable === b.launchable ? a.code.localeCompare(b.code) : a.launchable ? -1 : 1,
          )
        setMarkets(list)

        const ok = list.filter((m) => m.launchable).map((m) => m.code)
        let stored: string | null = null
        try { stored = window.localStorage.getItem(STORAGE_KEY) } catch { /* private mode */ }

        // A persisted market that has since lost production access must not be
        // silently honoured — fall back rather than launch somewhere dead.
        const resolved =
          (stored && ok.includes(stored) && stored) ||
          (ok.includes(PREFERRED) ? PREFERRED : ok[0]) ||
          ''
        setMarketState(resolved)

        // The scope market takes its own persisted value and accepts the sentinel. A stored code
        // that has since lost production access falls back to "all markets" rather than to one
        // arbitrary survivor: for a filter, the account-wide view is the honest fallback, where for
        // a launch target it would be a fabrication.
        let storedScope: string | null = null
        try { storedScope = window.localStorage.getItem(SCOPE_STORAGE_KEY) } catch { /* private mode */ }
        setScopeMarketState(storedScope === ALL_MARKETS || (storedScope && ok.includes(storedScope)) ? storedScope : ALL_MARKETS)

        setReady(true)
      })
      .catch((e) => {
        if (!alive) return
        setError(e instanceof Error ? e.message : String(e))
        // Ready with no market: every launch control stays disabled and says why.
        setReady(true)
      })
    return () => { alive = false }
  }, [])

  const setMarket = useCallback((m: string) => {
    setMarketState(m)
    try { window.localStorage.setItem(STORAGE_KEY, m) } catch { /* private mode */ }
  }, [])

  const setScopeMarket = useCallback((m: string) => {
    setScopeMarketState(m)
    try { window.localStorage.setItem(SCOPE_STORAGE_KEY, m) } catch { /* private mode */ }
  }, [])

  const launchable = useMemo(
    () => markets.filter((m) => m.launchable).map((m) => m.code),
    [markets],
  )

  const value = useMemo<Ctx>(
    () => ({ market, setMarket, scopeMarket, setScopeMarket, markets, launchable, ready, error }),
    [market, setMarket, scopeMarket, setScopeMarket, markets, launchable, ready, error],
  )

  return <MarketplaceCtx.Provider value={value}>{children}</MarketplaceCtx.Provider>
}

/**
 * Read the console marketplace. Throws outside the provider rather than
 * returning a plausible default — a builder that silently fell back to 'IT'
 * is the exact bug APS.2a exists to remove.
 */
export function useAdsMarketplace(): Ctx {
  const ctx = useContext(MarketplaceCtx)
  if (!ctx) throw new Error('useAdsMarketplace must be used inside <AdsMarketplaceProvider>')
  return ctx
}
