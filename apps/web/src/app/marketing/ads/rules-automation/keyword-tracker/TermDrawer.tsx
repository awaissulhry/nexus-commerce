'use client'

/**
 * KT.4 — one watched term: header · chart · our ASINs · the campaigns bidding it. In that order,
 * nothing else, read-only and quiet.
 *
 * 🔴 **This drawer portals to `document.body`**, which in this repo has meant a panel escaping the
 * light pin and rendering dark on a light page. So it declares its own colours explicitly rather
 * than inheriting, and the contrast probe measures the drawer's own stacking context, not the page's.
 *
 * Two shapes it is sized for, both measured on prod 2026-08-12:
 *   · **`giacca moto` — 53 campaigns and 73 ad groups.** A flat 73-row list inside a drawer is
 *     unusable, so campaigns are collapsed with their ad-group count and match types in the header
 *     and expand on demand. Designed for 53, not for 3.
 *   · **64 of IT's 97 watched terms have no campaign bidding them at all.** That is not an empty
 *     table, it is the most actionable sentence on the page for an Italian operator, so it is stated
 *     with the market count beside it.
 */

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, ChevronDown, ChevronRight, Info, X } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { TermChart, type TermPoint } from './TermChart'
import { BidAction } from './BidAction'
import { ChangeLog } from './ChangeLog'

interface TermPayload {
  term: string
  market: string
  scope: { boundBy: string; asinsInScope: number; campaignsInScope: number }
  period: string | null
  periodAgeDays: number | null
  periodTruncated: boolean
  header: {
    marketVolume: number | null; marketRank: number | null; share: number
    shareBound: number | null; bestAsin: string | null; asinsOnQuery: number
  } | null
  series: {
    points: TermPoint[]; shareWeeks: number; hasGaps: boolean
    lastShareWeek: string | null; lastSpendWeek: string | null
    shareTrailsSpendByDays: number | null; shareWeeksExcluded: number
  }
  asins: Array<{ asin: string; sku: string | null; name: string | null; share: number; clickShare: number; advertisedOnTerm: boolean }>
  bidCampaigns: Array<{
    id: string; name: string; status: string; adGroupCount: number; matchTypes: string[]
    adGroups: Array<{ id: string; name: string; matchTypes: string[]; targets: number; enabledTargets: number; minBidCents: number; maxBidCents: number }>
  }>
  bid: { campaigns: number; adGroups: number; matchTypes: string[]; unbid: boolean }
  funnel: { cartAddWeeks: number; purchaseWeeks: number; totalWeeks: number }
}

const num = (n: number) => n.toLocaleString('en-IE')
const pct = (v: number) => `${(v * 100).toFixed(2)}%`
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const dayMonth = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`)
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`
}

export function TermDrawer({
  term, market, scope, unbidInMarket, onClose,
}: {
  term: string
  market: string
  scope: { line: string; portfolio: string; campaign: string }
  /** how many of this market's watched terms have no campaign — the context the zero case needs */
  unbidInMarket: number | null
  onClose: () => void
}) {
  const [data, setData] = useState<TermPayload | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [mounted, setMounted] = useState(false)
  /** KT.7 — bumped when a write lands, so the change log refreshes without a page reload. */
  const [changeSeq, setChangeSeq] = useState(0)

  useEffect(() => { setMounted(true) }, [])

  const load = useCallback(async () => {
    setErr(null); setData(null)
    const q = new URLSearchParams({ market, kw: term })
    if (scope.line) q.set('line', scope.line)
    if (scope.portfolio) q.set('portfolio', scope.portfolio)
    if (scope.campaign) q.set('campaign', scope.campaign)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/keyword-tracker/term?${q}`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`Could not load this term (${r.status})`)
      setData(await r.json())
    } catch (e) { setErr((e as Error).message) }
  }, [term, market, scope.line, scope.portfolio, scope.campaign])

  useEffect(() => { void load() }, [load])

  // Escape closes. The drawer is read-only, so there is nothing to confirm and no overlay slot needed.
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onClose])

  if (!mounted) return null

  const s = data?.series
  const h = data?.header

  const body = (
    <>
      <button type="button" className="h10-kt-dr-back" aria-label="Close" onClick={onClose} />
      <aside className="h10-kt-dr" role="dialog" aria-label={`${term} — detail`}>
        <header className="h10-kt-drhead">
          <div>
            <h2>{term}</h2>
            {/* KT.5's vocabulary verbatim — one way of saying "as of" on this page, not two */}
            <p>
              {market}
              {h && <> · volume <b>{num(h.marketVolume ?? 0)}</b> · market rank <b>#{num(h.marketRank ?? 0)}</b></>}
              {h && <> · best ASIN’s share <b>{pct(h.share)}</b>{h.shareBound != null && <> <i title={`Our ${h.asinsOnQuery} ASINs on this query sum to ${pct(h.shareBound)} — an UPPER BOUND, not a total: two of our ASINs can appear in one search, so the parts overlap.`}>≤{pct(h.shareBound)}</i></>}</>}
              {data?.period && <> · week of <b>{dayMonth(data.period)}</b> ({data.periodAgeDays}d old)</>}
            </p>
          </div>
          <button type="button" className="h10-kt-dr-x" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </header>

        {err && <p className="h10-kt-blind"><AlertTriangle size={13} /><span>{err}</span></p>}
        {!data && !err && <p className="h10-kt-dr-load">Loading…</p>}

        {data && !h && (
          <p className="h10-kt-note">
            <Info size={13} />
            <span>Brand Analytics has no row for this term in the week of {data.period ? dayMonth(data.period) : '—'}. The history below is everything it has ever reported.</span>
          </p>
        )}

        {/* KT.6 — the only control on this page that can spend. Placed FIRST because it is now the
            reason the drawer is opened; the read-only sections that follow are the evidence for it.
            `unbid` comes from the payload the drawer already has, so no extra fetch decides the shape. */}
        {data && <BidAction term={term} market={market} unbid={data.bid.unbid} onWrite={() => setChangeSeq((n) => n + 1)} refreshKey={changeSeq} />}

        {/* KT.7 — what changed, scoped to this term's targets. Placed directly under the control that
            causes changes, so cause and effect are adjacent rather than in two different screens. */}
        {data && <ChangeLog term={term} market={market} refreshKey={changeSeq} onUndo={() => setChangeSeq((n) => n + 1)} />}

        {data && s && (
          <section className="h10-kt-drsec">
            <h3>Over time</h3>
            <TermChart points={s.points} lastShareWeek={s.lastShareWeek} shareWeeks={s.shareWeeks} market={market} />
            <p className="h10-kt-drfoot">
              {s.shareTrailsSpendByDays != null && s.shareTrailsSpendByDays > 0 && (
                <>Share stops <b>{s.shareTrailsSpendByDays} days</b> before spend does — Brand Analytics is weekly and has written nothing since {s.lastShareWeek ? dayMonth(s.lastShareWeek) : '—'}, while the search-term report is daily and current. </>
              )}
              {s.shareWeeksExcluded > 0 && (
                <>{s.shareWeeksExcluded} newer week{s.shareWeeksExcluded === 1 ? '' : 's'} {s.shareWeeksExcluded === 1 ? 'is' : 'are'} not drawn: the feed wrote too few rows for {s.shareWeeksExcluded === 1 ? 'it' : 'them'} to be comparable with the rest. </>
              )}
              {/* the funnel, as counts — never as a funnel. 5 rows in the whole dataset have a purchase. */}
              Cart-adds in <b>{s.shareWeeks ? `${data.funnel.cartAddWeeks} of ${data.funnel.totalWeeks}` : '0'}</b> weeks
              {' '}· purchases in <b>{data.funnel.purchaseWeeks}</b>
              {data.funnel.purchaseWeeks === 0 && <> — Brand Analytics reports a purchase on five rows across the whole watchlist, so no conversion rate is derived here</>}.
            </p>
          </section>
        )}

        {data && (
          <section className="h10-kt-drsec">
            <h3>Our ASINs on this query</h3>
            {data.asins.length === 0 ? (
              <p className="h10-kt-drempty">None of our ASINs holds this query in the week on screen.</p>
            ) : (
              <>
                <p className="h10-kt-drlead">
                  <b>{num(data.asins.length)} of our ASINs</b> hold this query. Best {pct(data.asins[0].share)}, worst{' '}
                  {pct(data.asins[data.asins.length - 1].share)}
                  {h?.shareBound != null && <> · combined <b>≤{pct(h.shareBound)}</b> (an upper bound, not a total)</>}.
                  {data.asins.length > 1 && <> They are splitting one query’s impressions.</>}
                </p>
                <table className="h10-kt-drtable">
                  <thead><tr><th>ASIN</th><th>Product</th><th className="n">Share</th><th className="n">Click share</th><th>On this term</th></tr></thead>
                  <tbody>
                    {data.asins.map((a) => (
                      <tr key={a.asin}>
                        <td className="mono">{a.asin}</td>
                        <td>{a.name ? <span title={a.name}>{a.sku ? `${a.sku} — ` : ''}{a.name}</span> : <span className="h10-kt-nd">not in the PIM</span>}</td>
                        <td className="n"><b>{pct(a.share)}</b></td>
                        <td className="n">{a.clickShare > 0 ? pct(a.clickShare) : <span className="h10-kt-nd">—</span>}</td>
                        <td>{a.advertisedOnTerm
                          ? <span className="h10-kt-drok">advertised</span>
                          : <span className="h10-kt-drno" title="This ASIN holds the query organically or via another campaign, but it is not in any ad group bidding this term.">not advertised on it</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </section>
        )}

        {data && (
          <section className="h10-kt-drsec">
            <h3>Campaigns bidding this term</h3>
            {data.bid.unbid ? (
              // 🔴 the headline for IT: 64 of 97. A finding, not an empty table.
              <p className="h10-kt-blind">
                <AlertTriangle size={13} />
                <span>
                  <b>No campaign bids this term.</b> It is on the watchlist and we are not buying it
                  {unbidInMarket != null && unbidInMarket > 1 && <> — along with {num(unbidInMarket - 1)} other watched {market} term{unbidInMarket - 1 === 1 ? '' : 's'}</>}.
                  Any share above is organic or comes from another term’s traffic.
                </span>
              </p>
            ) : (
              <>
                <p className="h10-kt-drlead">
                  <b>{num(data.bid.campaigns)} campaign{data.bid.campaigns === 1 ? '' : 's'}</b> ·{' '}
                  {num(data.bid.adGroups)} ad group{data.bid.adGroups === 1 ? '' : 's'} · match{' '}
                  {data.bid.matchTypes.join(' / ')}. Bids come from the target; its spend and impressions are
                  zero for every keyword target in the account, so no metric is shown from them.
                </p>
                <ul className="h10-kt-drcamps">
                  {data.bidCampaigns.map((c) => {
                    const isOpen = open.has(c.id)
                    return (
                      <li key={c.id}>
                        <button type="button" className="row" aria-expanded={isOpen}
                          onClick={() => setOpen((prev) => { const n = new Set(prev); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n })}>
                          {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          <span className="nm" title={c.name}>{c.name}</span>
                          <span className="st" data-s={c.status}>{c.status.toLowerCase()}</span>
                          <span className="ct">{c.adGroupCount} ad group{c.adGroupCount === 1 ? '' : 's'}</span>
                          <span className="mt">{c.matchTypes.join('/')}</span>
                        </button>
                        {isOpen && (
                          <ul className="groups">
                            {c.adGroups.map((g) => (
                              <li key={g.id}>
                                <span className="nm" title={g.name}>{g.name}</span>
                                <span className="mt">{g.matchTypes.join('/')}</span>
                                <span className="ct">{g.enabledTargets} of {g.targets} enabled</span>
                                <span className="bid">{g.minBidCents === g.maxBidCents ? eur(g.minBidCents) : `${eur(g.minBidCents)}–${eur(g.maxBidCents)}`}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </>
            )}
          </section>
        )}
      </aside>
    </>
  )

  return createPortal(body, document.body)
}
