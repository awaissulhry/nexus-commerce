'use client'

/**
 * ACR.2.3 — Conflicts: which of OUR campaigns are contesting the same keyword, account-wide.
 *
 * The reason this is an account view and not a campaign one: the Family Cockpit measured
 * `Xavia GALE IT` and found **no internal contest at all**. Every one of GALE's contested terms
 * is against campaigns in OTHER portfolios — the pre-portfolio `GALE EXACT IT`, `IT_Gale`,
 * `Moss_Jacket` sets. A campaign page and a family cockpit are both inside one of the boxes, so
 * neither can render the collision. This page is the first surface that can.
 *
 * Two things the layout is built around, both from the measured data:
 *
 * 1. **Most contenders are dormant.** `giacca moto uomo` EXACT is claimed by 19 campaigns; four
 *    took an impression in 30 days. Listing nineteen equal-looking rows would bury the three
 *    that matter, so contenders with no traffic collapse behind a disclosure and the count is
 *    stated as "4 of 19 active" rather than "19".
 *
 * 2. **Champions decided by bid alone are not verdicts.** 138 of 294 contests have no
 *    performance signal, so the engine's `[acos, -spend]` ordering ties and `pickChampion`
 *    falls through to highest bid. Those rows are marked "no evidence" rather than dressed up
 *    with a crown an operator might act on — retiring a loser there is a coin toss.
 *
 * Light-only, self-contained CSS, read-only. Resolutions stay on the existing gated endpoints.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Info, RefreshCw, Search } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Contender {
  campaignId: string
  campaignName: string
  status: string
  portfolioId: string | null
  portfolioName: string
  bidCents: number
  impressions: number
  clicks: number
  spendCents: number
  salesCents: number
  orders: number
  acos: number | null
  cvr: number | null
  tosBias: number
}
interface Contest {
  term: string
  matchType: string
  contenders: Contender[]
  championId: string
  championReason: string
  crossPortfolio: boolean
  portfolios: number
  unportfolioed: boolean
  bothTop: boolean
  activeContenders: number
  championHasEvidence: boolean
  spend30dCents: number
  sales30dCents: number
  impressions30d: number
}
interface Board {
  marketplace: string
  windowDays: number
  daysWithData: number
  totals: {
    contested: number; crossPortfolio: number; portfolios: number
    unportfolioedCampaigns: boolean; campaigns: number
    spend30dCents: number; challengerSpend30dCents: number
  }
  contests: Contest[]
  notes: string[]
}

const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`)
const intl = (v: number) => v.toLocaleString('en-IE')

/**
 * A champion picked with no traffic to go on is a tie-break, not a finding.
 *
 * This used to string-match `championReason.startsWith('highest bid')` — coupling a safety
 * warning to human-readable prose, so rewording `pickChampion`'s reason would have silently
 * stopped tagging the rows an operator must not act on. The server now derives it from the
 * contenders and says so in a field.
 */
const isBlind = (c: Contest) => !c.championHasEvidence

export function ConflictsTab({ market }: { market: string }) {
  const [board, setBoard] = useState<Board | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [crossOnly, setCrossOnly] = useState(false)
  const [open, setOpen] = useState<Set<string>>(new Set())

  const load = useCallback(async (mkt: string) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ marketplace: mkt, limit: '300' })
      const r = await fetch(`${getBackendUrl()}/api/advertising/coverage/contests?${params}`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`contests: ${r.status}`)
      setBoard((await r.json()) as Board)
      setErr(null)
    } catch (e) {
      setErr((e as Error).message)
      setBoard(null)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void load(market) }, [load, market])

  const contests = useMemo(() => (board?.contests ?? []).filter((c) =>
    (!crossOnly || c.crossPortfolio) && (!q || c.term.toLowerCase().includes(q.toLowerCase()))), [board, crossOnly, q])

  const toggle = (k: string) => setOpen((prev) => {
    const next = new Set(prev)
    if (next.has(k)) next.delete(k); else next.add(k)
    return next
  })

  if (err) return <div className="cov-banner err" role="alert"><AlertTriangle size={15} /> {err}</div>
  if (!board) return <div className="cov-empty">{loading ? 'Loading…' : 'No data.'}</div>

  return (
    <>
      <div className="cov-top">
        <div className="cov-hero">
          <div className="cov-hero-k">Contested keywords · {board.marketplace} · {board.windowDays}d</div>
          <div className="cov-hero-v">
            {board.totals.crossPortfolio}
            <span className="cov-hero-sub">
              cross-portfolio, of {board.totals.contested} contested · {board.totals.campaigns} campaigns
              {' · '}{board.totals.portfolios} portfolios{board.totals.unportfolioedCampaigns ? ' + unfiled' : ''}
            </span>
          </div>
          <p className="cov-hero-note">
            {eur(board.totals.challengerSpend30dCents)} of {eur(board.totals.spend30dCents)} on contested
            terms went to a campaign the champion rule does not pick. That is the size of the
            consolidation question — not a bill to reclaim, since the same keyword across our
            campaigns enters the auction once.
          </p>
        </div>
        <div className="cov-controls">
          <label className="cvf-check">
            <input type="checkbox" checked={crossOnly} onChange={(e) => setCrossOnly(e.target.checked)} />
            <span>Cross-portfolio only</span>
          </label>
          <button type="button" className="cov-btn" onClick={() => void load(market)} disabled={loading}>
            <RefreshCw size={13} /> {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {board.notes.map((n) => (
        <div key={n.slice(0, 40)} className="cov-banner warn"><Info size={15} /><span>{n}</span></div>
      ))}

      <div className="cov-sec-head">
        <h2>Contests</h2>
        <span className="cov-sec-count">{contests.length} shown · worst first</span>
        <label className="cov-search">
          <Search size={13} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter terms" />
        </label>
      </div>

      <div className="cvf-list">
        {contests.map((c) => {
          const key = `${c.term}|${c.matchType}`
          const isOpen = open.has(key)
          const champ = c.contenders.find((x) => x.campaignId === c.championId)
          const active = c.contenders.filter((x) => x.impressions > 0)
          const dormant = c.contenders.filter((x) => x.impressions === 0)
          const shown = isOpen ? c.contenders : active
          return (
            <section className="cvf-card" key={key}>
              <header className="cvf-head">
                <button type="button" className="cvf-disc" onClick={() => toggle(key)}
                  aria-expanded={isOpen} aria-label={isOpen ? 'Hide dormant claims' : 'Show all claims'}>
                  {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
                <span className="cvf-term">{c.term}</span>
                <span className="cvf-match">{c.matchType}</span>
                {c.crossPortfolio && <span className="cvf-tag cross">{c.portfolios} portfolios</span>}
                {c.bothTop && <span className="cvf-tag top">both bidding top</span>}
                {isBlind(c) && <span className="cvf-tag blind">no evidence</span>}
                <span className="cvf-counts">{active.length} of {c.contenders.length} active</span>
                <span className="cvf-money">{eur(c.spend30dCents)} → {eur(c.sales30dCents)}</span>
              </header>

              <p className="cvf-champ">
                {isBlind(c) ? (
                  <>No campaign here has performance to rank on. The champion shown is the highest
                  bid — a tie-break, not a recommendation. <strong>Leave this one alone.</strong></>
                ) : (
                  <>Champion <strong>{champ?.campaignName}</strong>
                  {champ?.portfolioName ? <span className="cvf-pf"> · {champ.portfolioName}</span> : null}
                  {' — '}{c.championReason}</>
                )}
              </p>

              <table className="cvf-table">
                <thead>
                  <tr>
                    <th className="l">Campaign</th>
                    <th className="l">Portfolio</th>
                    <th>Bid</th>
                    <th>Impressions</th>
                    <th>Clicks</th>
                    <th>Spend</th>
                    <th>Sales</th>
                    <th>ACOS</th>
                    <th title="Top-of-search placement bias. Two contenders above 0% are pushing for the same slot.">ToS bias</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((x) => (
                    <tr key={x.campaignId} className={x.campaignId === c.championId ? 'champ' : x.impressions === 0 ? 'dormant' : undefined}>
                      <td className="l">
                        {x.campaignId === c.championId && !isBlind(c) && <span className="cvf-star" aria-label="champion">★</span>}
                        {x.campaignName}
                      </td>
                      <td className="l cvf-pfcell">{x.portfolioId ? x.portfolioName : <em>unfiled</em>}</td>
                      <td>{(x.bidCents / 100).toFixed(2)}</td>
                      <td>{intl(x.impressions)}</td>
                      <td>{intl(x.clicks)}</td>
                      <td>{eur(x.spendCents)}</td>
                      <td>{eur(x.salesCents)}</td>
                      <td className={x.acos != null && x.acos > 1 ? 'bad' : undefined}>{pct(x.acos)}</td>
                      <td className={x.tosBias > 0 ? 'tos' : undefined}>{x.tosBias > 0 ? `${x.tosBias}%` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {!isOpen && dormant.length > 0 && (
                <button type="button" className="cvf-more" onClick={() => toggle(key)}>
                  + {dormant.length} more {dormant.length === 1 ? 'campaign claims' : 'campaigns claim'} this term but took no impressions in {board.windowDays} days
                </button>
              )}
            </section>
          )
        })}
        {contests.length === 0 && <div className="cov-empty">No contests match this filter.</div>}
      </div>

      <p className="cov-foot">
        A contest is one (term × match type) held by two or more of our own campaigns. Metrics are
        the AD_TARGET grain over {board.windowDays} days ({board.daysWithData} days of data present).
        Champions come from the same <code>pickChampion</code> the campaign-level view uses, whose
        primary ordering is the rank engine&rsquo;s own <code>[ACOS, −spend]</code> — so this page and
        the engine cannot name different winners. Nothing here writes: resolutions stay on the
        existing gated endpoints.
      </p>
    </>
  )
}
