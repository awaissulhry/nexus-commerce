'use client'

/**
 * RA.SB — the one scope control for the whole Rules & Automation section.
 *
 *   [ Market ▾ ]   [ Scope ▾  (+ target ▾) ]   [ Dates ▾ ]   …what that reaches
 *
 * Rendered once per page, reading and writing the URL through `useAdsScope`, so
 * every page in the section answers the same question the same way and no page
 * keeps a private copy of market, grain or dates.
 *
 * Three things it deliberately does:
 *
 *  · **Market is separate from grain.** It composes with all of them — "the DE
 *    view" is market=DE + Entire account; "this portfolio in DE" is market=DE +
 *    that portfolio. See SCOPE_GRAINS for why a Market *grain* would be wrong.
 *
 *  · **It states what a scope reaches, in visible text, not a tooltip.** Portfolio
 *    scope reaches 72 of 220 campaigns on prod — 148 carry no portfolioId at all
 *    — so an unqualified "Portfolio" would silently under-apply every action
 *    taken through it. A number a beginner can read beats a number they have to
 *    hover to find.
 *
 *  · **It never offers a grain it cannot resolve.** Product line is present and
 *    disabled with its reason, rather than hidden (which loses the promise) or
 *    enabled against a resolver that does not exist yet (which fabricates one).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { MarketSelect } from '../../_shell/MarketSelect'
import { useAdsMarketplace } from '../../_shell/MarketplaceContext'
import {
  SCOPE_GRAINS, SCOPE_PRESETS, useAdsScope, type ScopeGrain, type ScopePreset,
} from './ads-scope'

interface PortfolioOpt { id: string; label: string; campaigns: number }
interface CampaignOpt { id: string; label: string }

/**
 * Product line is not selectable yet, and the reason is concrete rather than
 * "coming soon": `AutomationRule` has no product scope column, `ContextIdentity`
 * carries no ASIN, and 274 of 4,485 ad-product rows (the AIREON B0H8* block) are
 * not in the Product catalogue, so a picker could not even name them.
 */
const PRODUCT_PENDING = 'Product line needs the ASIN→campaign resolver and the AIREON catalogue import — not wired yet'

export function ScopeBar() {
  const { scope, setScope } = useAdsScope()
  const { markets, ready } = useAdsMarketplace()

  const [portfolios, setPortfolios] = useState<PortfolioOpt[] | null>(null)
  const [campaigns, setCampaigns] = useState<CampaignOpt[] | null>(null)
  /** Total campaigns in the current market — the denominator every reach is out of. */
  const [totalCampaigns, setTotalCampaigns] = useState<number | null>(null)

  const marketQ = scope.market ? `&marketplace=${encodeURIComponent(scope.market)}` : ''

  // Campaigns power both the campaign picker and every reach denominator, so
  // they load regardless of grain.
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const j = await fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500${marketQ}`, { cache: 'no-store' }).then((r) => r.json())
        const items = (Array.isArray(j?.items) ? j.items : []) as Array<{ id: string; name: string; marketplace?: string | null }>
        if (!alive) return
        setCampaigns(items.map((c) => ({ id: c.id, label: c.marketplace ? `${c.name} · ${c.marketplace}` : c.name })))
        setTotalCampaigns(items.length)
      } catch { if (alive) { setCampaigns([]); setTotalCampaigns(null) } }
    })()
    return () => { alive = false }
  }, [marketQ])

  useEffect(() => {
    if (scope.grain !== 'portfolio' || portfolios != null) return
    let alive = true
    ;(async () => {
      try {
        const j = await fetch(`${getBackendUrl()}/api/advertising/portfolios`, { cache: 'no-store' }).then((r) => r.json())
        const items = (Array.isArray(j?.items) ? j.items : []) as Array<{ portfolioId: string; name: string; campaignCount?: number }>
        if (!alive) return
        // Names, never ids. The Apply-Rules filter has always listed raw Amazon
        // portfolio ids as its labels, which is unreadable and unsearchable.
        setPortfolios(items.map((p) => ({ id: p.portfolioId, label: p.name, campaigns: p.campaignCount ?? 0 })))
      } catch { if (alive) setPortfolios([]) }
    })()
    return () => { alive = false }
  }, [scope.grain, portfolios])

  const setGrain = useCallback((g: ScopeGrain) => setScope({ grain: g, id: null }), [setScope])

  /** One sentence saying what the current selection actually covers. */
  const reach = useMemo(() => {
    const where = scope.market ? `in ${scope.market}` : 'across all markets'
    if (totalCampaigns == null) return null
    if (scope.grain === 'account') return `${totalCampaigns} campaigns ${where}`
    if (scope.grain === 'campaign') return scope.id ? `1 campaign ${where}` : `choose a campaign`
    if (scope.grain === 'portfolio') {
      if (!scope.id) {
        const covered = (portfolios ?? []).reduce((n, p) => n + p.campaigns, 0)
        return portfolios == null ? 'choose a portfolio'
          : `choose a portfolio — portfolios cover ${covered} of ${totalCampaigns} campaigns`
      }
      const p = (portfolios ?? []).find((x) => x.id === scope.id)
      return p ? `${p.campaigns} of ${totalCampaigns} campaigns ${where}` : null
    }
    return null
  }, [scope, portfolios, totalCampaigns])

  const targetOptions: Array<{ id: string; label: string }> | null =
    scope.grain === 'portfolio' ? (portfolios ?? []).map((p) => ({ id: p.id, label: `${p.label} (${p.campaigns})` }))
      : scope.grain === 'campaign' ? (campaigns ?? [])
        : null

  return (
    <div className="ra-scopebar" role="group" aria-label="Scope and date range">
      <span className="ra-scope-fld">
        <label className="ra-scope-lbl" htmlFor="ra-scope-market">Market</label>
        {/* MarketSelect renders sandbox connections visibly but unselectable, and
            says why — that behaviour predates this bar and is left alone. */}
        <MarketSelect
          markets={markets}
          value={scope.market}
          onChange={(code) => setScope({ market: code })}
          allowAll
          disabled={!ready}
        />
      </span>

      <span className="ra-scope-fld">
        <label className="ra-scope-lbl" htmlFor="ra-scope-grain">Scope</label>
        <select
          id="ra-scope-grain"
          className="ra-scope-sel"
          value={scope.grain}
          onChange={(e) => setGrain(e.target.value as ScopeGrain)}
        >
          {SCOPE_GRAINS.map((g) => (
            <option key={g.key} value={g.key} disabled={g.key === 'product'}>
              {g.label}{g.key === 'product' ? ' — not wired yet' : ''}
            </option>
          ))}
        </select>
      </span>

      {targetOptions != null && (
        <span className="ra-scope-fld">
          <label className="ra-scope-lbl" htmlFor="ra-scope-target">
            {scope.grain === 'portfolio' ? 'Portfolio' : 'Campaign'}
          </label>
          <select
            id="ra-scope-target"
            className="ra-scope-sel wide"
            value={scope.id ?? ''}
            onChange={(e) => setScope({ id: e.target.value || null })}
          >
            <option value="">Choose one…</option>
            {targetOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </span>
      )}

      <span className="ra-scope-fld">
        <label className="ra-scope-lbl" htmlFor="ra-scope-dates">Dates</label>
        <select
          id="ra-scope-dates"
          className="ra-scope-sel"
          value={scope.preset}
          onChange={(e) => setScope({ preset: e.target.value as ScopePreset, start: null, end: null })}
        >
          {SCOPE_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          {scope.preset === 'custom' && <option value="custom">Custom range</option>}
        </select>
      </span>

      {reach && <span className="ra-scope-reach">{reach}</span>}

      {scope.grain === 'product' && <span className="ra-scope-note">{PRODUCT_PENDING}</span>}
    </div>
  )
}
