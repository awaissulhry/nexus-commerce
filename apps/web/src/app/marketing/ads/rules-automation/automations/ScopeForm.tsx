'use client'

/**
 * RA.GRAIN — bind a rule at any of the four grains, and say what it covers before you click.
 *
 * The operator's requirement was symmetry: one campaign, one portfolio, a whole market and a whole
 * product line must each be the same number of clicks. So this is two independent controls, not a
 * single "grain" dropdown — because market is not an alternative to the others, it composes with
 * them. `ruleMatchesScope` has always ANDed the dimensions; only the write route used to be
 * exclusive, which is why the UI could previously offer just portfolio-or-campaign.
 *
 *   WHERE   market  ×  (whole account | one portfolio | one campaign)
 *   WHAT    all products | one product line | one variation
 *
 * Portfolio ⇄ campaign stay mutually exclusive, and under AND that is provably right rather than a
 * shortcut: a campaign belongs to at most one portfolio, so holding both is redundant (it is in it)
 * or contradictory (it is not, and the rule could never fire).
 *
 * Reach is computed HERE, from `/advertising/scope-options`, using the same intersection the server
 * uses — so the number cannot disagree with enforcement, and there is no round-trip per dropdown
 * twiddle. The server still recomputes and refuses on write; this is the honest preview, not the
 * authority.
 */

import { useMemo, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { H10Select } from '../../campaigns/FilterDropdown'

export interface ScopeOptions {
  totalCampaigns: number
  campaigns: Array<{ id: string; name: string; marketplace: string | null; portfolioId: string | null }>
  portfolios: Array<{ externalPortfolioId: string; name: string }>
  campaignsWithoutPortfolio: number
  productLines: Array<{
    id: string; sku: string; name: string; variations: number; campaigns: string[]
    children: Array<{ id: string; sku: string; name: string; asins: string[]; campaigns: string[] }>
  }>
  unnamedAdRows: number
}

export interface ScopeValue {
  scopeMarketplace: string | null
  scopePortfolioId: string | null
  scopeCampaignId: string | null
  scopeProductId: string | null
}

const num = (n: number) => n.toLocaleString('en-IE')

export function ScopeForm({
  options, current, busy, onApply,
}: {
  options: ScopeOptions | null
  current: ScopeValue
  busy: boolean
  onApply: (next: ScopeValue) => void
}) {
  const [market, setMarket] = useState(current.scopeMarketplace ?? '')
  const [where, setWhere] = useState<'account' | 'portfolio' | 'campaign'>(
    current.scopeCampaignId ? 'campaign' : current.scopePortfolioId ? 'portfolio' : 'account',
  )
  const [pf, setPf] = useState(current.scopePortfolioId ?? '')
  const [cp, setCp] = useState(current.scopeCampaignId ?? '')
  // 'all' | 'line' | 'variation' — a variation is still one product id, just a child rather than
  // a parent, which is why both write the same column.
  const initialProductMode = (): 'all' | 'line' | 'variation' => {
    if (!current.scopeProductId) return 'all'
    return options?.productLines.some((l) => l.id === current.scopeProductId) ? 'line' : 'variation'
  }
  const [pMode, setPMode] = useState<'all' | 'line' | 'variation'>(initialProductMode)
  const [lineId, setLineId] = useState(() => {
    if (!current.scopeProductId) return ''
    const asLine = options?.productLines.find((l) => l.id === current.scopeProductId)
    if (asLine) return asLine.id
    return options?.productLines.find((l) => l.children.some((c) => c.id === current.scopeProductId))?.id ?? ''
  })
  const [variationId, setVariationId] = useState(
    current.scopeProductId && !options?.productLines.some((l) => l.id === current.scopeProductId)
      ? current.scopeProductId
      : '',
  )

  const productId = pMode === 'line' ? (lineId || null) : pMode === 'variation' ? (variationId || null) : null

  const next: ScopeValue = {
    scopeMarketplace: market || null,
    scopePortfolioId: where === 'portfolio' ? (pf || null) : null,
    scopeCampaignId: where === 'campaign' ? (cp || null) : null,
    scopeProductId: productId,
  }

  /** The same intersection the server performs, so the preview cannot lie about enforcement. */
  const reach = useMemo(() => {
    if (!options) return null
    const applied: string[] = []
    let ids = options.campaigns.map((c) => c.id)
    if (next.scopeMarketplace) {
      const m = next.scopeMarketplace
      ids = options.campaigns.filter((c) => c.marketplace === m).map((c) => c.id)
      applied.push(`market ${m}`)
    }
    if (next.scopeCampaignId) {
      ids = ids.filter((id) => id === next.scopeCampaignId)
      applied.push('one campaign')
    } else if (next.scopePortfolioId) {
      const p = next.scopePortfolioId
      const inPf = new Set(options.campaigns.filter((c) => c.portfolioId === p).map((c) => c.id))
      ids = ids.filter((id) => inPf.has(id))
      applied.push('one portfolio')
    }
    let variations: number | null = null
    if (next.scopeProductId) {
      const line = options.productLines.find((l) => l.id === next.scopeProductId)
      const child = line ? null : options.productLines.flatMap((l) => l.children).find((c) => c.id === next.scopeProductId)
      const allowed = new Set(line ? line.campaigns : child ? child.campaigns : [])
      ids = ids.filter((id) => allowed.has(id))
      variations = line ? line.variations : null
      applied.push(line ? 'one product line' : 'one product')
    }
    return { campaigns: ids.length, total: options.totalCampaigns, applied, variations }
  }, [options, next.scopeMarketplace, next.scopePortfolioId, next.scopeCampaignId, next.scopeProductId])

  const dirty =
    next.scopeMarketplace !== (current.scopeMarketplace ?? null) ||
    next.scopePortfolioId !== (current.scopePortfolioId ?? null) ||
    next.scopeCampaignId !== (current.scopeCampaignId ?? null) ||
    next.scopeProductId !== (current.scopeProductId ?? null)

  // A picker chosen but left empty is not a binding; it is an unfinished thought.
  const incomplete =
    (where === 'portfolio' && !pf) || (where === 'campaign' && !cp) ||
    (pMode === 'line' && !lineId) || (pMode === 'variation' && !variationId)

  const contradiction = reach && reach.campaigns === 0 && reach.applied.length > 0 && !incomplete
  const canApply = dirty && !incomplete && !contradiction && !busy

  const markets = useMemo(() => {
    if (!options) return [] as Array<{ code: string; n: number }>
    const m = new Map<string, number>()
    for (const c of options.campaigns) if (c.marketplace) m.set(c.marketplace, (m.get(c.marketplace) ?? 0) + 1)
    return [...m.entries()].map(([code, n]) => ({ code, n })).sort((a, b) => b.n - a.n)
  }, [options])

  const chosenLine = options?.productLines.find((l) => l.id === lineId)

  if (!options) return <p className="h10-au-note">Loading scope options…</p>

  return (
    <div className="h10-au-scope2">
      <div className="h10-au-scoperow">
        <span className="lbl">Where</span>
        <H10Select
          width={148} ariaLabel="Market" value={market} onChange={setMarket}
          options={[
            { value: '', label: `All markets (${num(options.totalCampaigns)})` },
            ...markets.map((m) => ({ value: m.code, label: `${m.code} (${m.n})` })),
          ]}
        />
        <H10Select
          width={150} ariaLabel="Campaign grain" value={where}
          onChange={(v) => setWhere(v as 'account' | 'portfolio' | 'campaign')}
          options={[
            { value: 'account', label: 'All campaigns' },
            { value: 'portfolio', label: 'One portfolio' },
            { value: 'campaign', label: 'One campaign' },
          ]}
        />
        {where === 'portfolio' && (
          <H10Select
            width={196} searchable ariaLabel="Portfolio" value={pf} onChange={setPf}
            options={options.portfolios.map((p) => {
              const n = options.campaigns.filter((c) => c.portfolioId === p.externalPortfolioId).length
              return { value: p.externalPortfolioId, label: `${p.name} (${n})` }
            })}
          />
        )}
        {where === 'campaign' && (
          <H10Select
            width={236} searchable ariaLabel="Campaign" value={cp} onChange={setCp}
            options={options.campaigns
              .filter((c) => !market || c.marketplace === market)
              .map((c) => ({ value: c.id, label: c.name }))}
          />
        )}
      </div>

      <div className="h10-au-scoperow">
        <span className="lbl">What</span>
        <H10Select
          width={148} ariaLabel="Product grain" value={pMode}
          onChange={(v) => setPMode(v as 'all' | 'line' | 'variation')}
          options={[
            { value: 'all', label: 'All products' },
            { value: 'line', label: 'One product line' },
            { value: 'variation', label: 'One variation' },
          ]}
        />
        {pMode !== 'all' && (
          <H10Select
            width={pMode === 'line' ? 300 : 196} searchable ariaLabel="Product line"
            value={lineId} onChange={(v) => { setLineId(v); setVariationId('') }}
            options={options.productLines.map((l) => ({
              value: l.id,
              label: `${l.sku} — ${l.variations} variation${l.variations === 1 ? '' : 's'} · ${l.campaigns.length} campaigns`,
            }))}
          />
        )}
        {pMode === 'variation' && chosenLine && (
          <H10Select
            width={260} searchable ariaLabel="Variation" value={variationId} onChange={setVariationId}
            options={chosenLine.children.map((c) => ({
              value: c.id,
              label: `${c.sku}${c.asins.length ? ` · ${c.asins.join(', ')}` : ''} (${c.campaigns.length})`,
            }))}
          />
        )}
      </div>

      {/* Reach, in visible text, before the click. Never a tooltip: portfolio reaching a third of
          the account and one line reaching 77 campaigns are both facts that change the decision. */}
      {reach && (
        <p className={`h10-au-reach${contradiction ? ' bad' : ''}`}>
          {contradiction ? <AlertTriangle size={13} aria-hidden /> : null}
          {incomplete
            ? <>Choose a {where === 'portfolio' && !pf ? 'portfolio' : where === 'campaign' && !cp ? 'campaign' : pMode === 'line' ? 'product line' : 'variation'} to see what this covers.</>
            : contradiction
              ? <><b>0 of {num(reach.total)} campaigns</b> — {reach.applied.join(' + ')} have no campaign in common, so a rule scoped this way could never fire.</>
              : <>
                Covers <b>{num(reach.campaigns)}</b> of {num(reach.total)} campaigns
                {reach.applied.length > 0 && <> · {reach.applied.join(' + ')}</>}
                {reach.variations != null && <> · {reach.variations} advertised variation{reach.variations === 1 ? '' : 's'}</>}
              </>}
        </p>
      )}

      {/* The blind spot, stated whenever the portfolio grain is in play — including when the chosen
          portfolio is healthy, because it is a fact about the grain, not about the selection. */}
      {where === 'portfolio' && options.campaignsWithoutPortfolio > 0 && (
        <p className="h10-au-note">
          {num(options.campaignsWithoutPortfolio)} of {num(options.totalCampaigns)} campaigns carry no
          portfolio at all, so no portfolio binding can ever reach them.
        </p>
      )}
      {pMode !== 'all' && options.unnamedAdRows > 0 && (
        <p className="h10-au-note">
          {num(options.unnamedAdRows)} advertised rows are not in the product catalogue, so they
          cannot be named here. Running the Amazon product import is what fixes that.
        </p>
      )}

      {dirty && (
        <button type="button" className="h10-am-btn primary sm" disabled={!canApply} onClick={() => onApply(next)}>
          {busy ? 'Binding…' : contradiction ? 'Cannot bind — nothing to cover' : incomplete ? 'Finish choosing' : 'Bind this scope'}
        </button>
      )}
    </div>
  )
}
