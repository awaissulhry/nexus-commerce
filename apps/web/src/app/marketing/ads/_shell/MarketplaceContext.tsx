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
/** Only used to break a tie when nothing is persisted — never to fabricate a market. */
const PREFERRED = 'IT'

export interface AdsMarket {
  code: string
  label: string
  /** active + production. Anything else cannot receive a real campaign. */
  launchable: boolean
  mode: string
  writesEnabled: boolean
}

interface Ctx {
  /** The selected marketplace, or '' while still resolving. */
  market: string
  setMarket: (m: string) => void
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

  const launchable = useMemo(
    () => markets.filter((m) => m.launchable).map((m) => m.code),
    [markets],
  )

  const value = useMemo<Ctx>(
    () => ({ market, setMarket, markets, launchable, ready, error }),
    [market, setMarket, markets, launchable, ready, error],
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
