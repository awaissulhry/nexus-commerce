'use client'

/**
 * Trading Desk — Competitive (native). Two lenses:
 *  - Share of Voice: within-account share + cannibalization / outbid signals
 *    from search-term history (GET /advertising/share-of-voice). Honest: true
 *    competitor impression-share needs a Brand Analytics report sub.
 *  - Search Query Performance: Brand Analytics — our brand's impression / click
 *    / cart-add / purchase share per query (GET /advertising/search-query-performance);
 *    empty until SQP is ingested.
 */

import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface SovRow { query: string; impressions: number; clicks: number; costCents: number; orders: number; ctr: number | null; cvr: number | null; cpcCents: number | null; sovPct: number; campaignCount: number; topCampaignSharePct: number; cannibalized: boolean; flag: 'outbid' | 'weak-relevance' | null }
interface SovResult { windowDays: number; totalImpressions: number; queries: number; rows: SovRow[]; summary: { cannibalizedQueries: number; outbidQueries: number; weakRelevanceQueries: number } }
interface SqpRow { searchQuery: string; asin?: string | null; searchQueryVolume?: number | null; searchQueryRank?: number | null; impressionShare?: number | null; clickShare?: number | null; cartAddShare?: number | null; purchaseShare?: number | null }

const eur = (c: number | null | undefined) => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100))
const num = (n: number | null | undefined) => (n == null ? '—' : new Intl.NumberFormat('en-US').format(Math.round(n)))
const pctFrac = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)
const fmtShare = (v: number | null | undefined) => (v == null ? '—' : v <= 1 ? `${(v * 100).toFixed(1)}%` : `${v.toFixed(1)}%`)
const MARKETS = ['', 'IT', 'DE', 'FR', 'ES']

export function CompetitiveClient({ initialSov }: { initialSov: SovResult | null }) {
  const [tab, setTab] = useState<'sov' | 'sqp'>('sov')
  const [market, setMarket] = useState('')
  const [sov, setSov] = useState<SovResult | null>(initialSov)
  const [sovLoading, setSovLoading] = useState(false)
  const [sqp, setSqp] = useState<SqpRow[] | null>(null)
  const [sqpLoading, setSqpLoading] = useState(false)

  const loadSov = useCallback(async () => {
    setSovLoading(true)
    try { const d = await fetch(`${getBackendUrl()}/api/advertising/share-of-voice?windowDays=30&limit=200`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null); setSov(d as SovResult) } finally { setSovLoading(false) }
  }, [])
  const loadSqp = useCallback(async () => {
    setSqpLoading(true)
    try { const d = await fetch(`${getBackendUrl()}/api/advertising/search-query-performance?days=90&limit=300${market ? `&marketplace=${market}` : ''}`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ items: [] })); setSqp((d.items ?? []) as SqpRow[]) } finally { setSqpLoading(false) }
  }, [market])
  useEffect(() => { if (tab === 'sqp') void loadSqp() }, [tab, loadSqp])

  return (
    <>
      <div className="top">
        <div><h1>Competitive</h1><div className="sub">Share of Voice · Brand Analytics</div></div>
        <span className="spacer" />
        {tab === 'sqp' && (
          <select className="flt" value={market} onChange={(e) => { setMarket(e.target.value); setSqp(null) }} aria-label="Market">
            {MARKETS.map((m) => <option key={m} value={m}>{m || 'All markets'}</option>)}
          </select>
        )}
        <button className="ctl" onClick={() => (tab === 'sov' ? void loadSov() : void loadSqp())} title="Refresh"><RefreshCw size={14} className={(sovLoading || sqpLoading) ? 'spin' : ''} /></button>
      </div>

      <div className="scroll">
        <div className="cocktabs">
          <button className={tab === 'sov' ? 'on' : ''} onClick={() => setTab('sov')}>Share of Voice</button>
          <button className={tab === 'sqp' ? 'on' : ''} onClick={() => setTab('sqp')}>Search Query Performance</button>
        </div>

        {tab === 'sov' && (
          <div>
            <div className="statrow">
              <div className="stat"><div className="sv">{sov?.queries ?? '—'}</div><div className="sl">Queries tracked</div></div>
              <div className="stat"><div className="sv" style={{ color: 'var(--brand)' }}>{sov?.summary.cannibalizedQueries ?? '—'}</div><div className="sl">Cannibalized</div></div>
              <div className="stat"><div className="sv" style={{ color: 'var(--amber)' }}>{sov?.summary.outbidQueries ?? '—'}</div><div className="sl">Likely outbid</div></div>
              <div className="stat"><div className="sv" style={{ color: 'var(--slate)' }}>{sov?.summary.weakRelevanceQueries ?? '—'}</div><div className="sl">Weak relevance</div></div>
            </div>
            <div className="card">
              <div className="tablewrap"><table>
                <thead><tr><th className="l">Query</th><th>SOV</th><th>Impr.</th><th>Clicks</th><th>CTR</th><th>Orders</th><th>CVR</th><th>CPC</th><th>Campaigns</th><th className="l">Signal</th></tr></thead>
                <tbody>
                  {!sov && <tr><td colSpan={10} className="empty">Loading…</td></tr>}
                  {sov && sov.rows.length === 0 && <tr><td colSpan={10} className="empty">No search-term data in this window.</td></tr>}
                  {sov?.rows.map((r) => (
                    <tr key={r.query}>
                      <td className="l">{r.query}</td>
                      <td className="num">{pctFrac(r.sovPct)}</td>
                      <td className="num">{num(r.impressions)}</td>
                      <td className="num">{num(r.clicks)}</td>
                      <td className="num">{pctFrac(r.ctr)}</td>
                      <td className="num">{num(r.orders)}</td>
                      <td className="num">{pctFrac(r.cvr)}</td>
                      <td className="num">{eur(r.cpcCents)}</td>
                      <td className="num">{r.campaignCount}</td>
                      <td className="l">
                        {r.cannibalized && <span className="pill b" style={{ marginRight: 4 }}>Cannibalized</span>}
                        {r.flag === 'outbid' && <span className="pill a">Outbid</span>}
                        {r.flag === 'weak-relevance' && <span className="pill n">Weak rel.</span>}
                        {!r.cannibalized && !r.flag && <span className="sub">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
              <div className="legend" style={{ padding: '12px 14px' }}><span><b>Within-account</b> share + competitive signals from your search-term history. <b>Cannibalized</b> = ≥2 of your campaigns bidding the same query; <b>Outbid</b> = high CPC but low impressions. True competitor impression-share needs a Brand Analytics report subscription.</span></div>
            </div>
          </div>
        )}

        {tab === 'sqp' && (
          <div className="card">
            <div className="tablewrap"><table>
              <thead><tr><th className="l">Query</th><th className="l">ASIN</th><th>Volume</th><th>Rank</th><th>Impr. share</th><th>Click share</th><th>Cart-add share</th><th>Purchase share</th></tr></thead>
              <tbody>
                {sqp === null && <tr><td colSpan={8} className="empty">Loading…</td></tr>}
                {sqp && sqp.length === 0 && <tr><td colSpan={8} className="empty">No Brand Analytics SQP data yet. SQP requires Brand Analytics access + ingestion (sqp-ingest cron / classic tools). Once ingested, your brand&rsquo;s share of each query&rsquo;s impressions, clicks, cart-adds &amp; purchases appears here.</td></tr>}
                {sqp?.map((r, i) => (
                  <tr key={`${r.searchQuery}-${r.asin ?? i}`}>
                    <td className="l">{r.searchQuery}</td>
                    <td className="l"><span className="sub">{r.asin ?? '—'}</span></td>
                    <td className="num">{num(r.searchQueryVolume)}</td>
                    <td className="num">{r.searchQueryRank ?? '—'}</td>
                    <td className="num">{fmtShare(r.impressionShare)}</td>
                    <td className="num">{fmtShare(r.clickShare)}</td>
                    <td className="num">{fmtShare(r.cartAddShare)}</td>
                    <td className="num">{fmtShare(r.purchaseShare)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
            <div className="legend" style={{ padding: '12px 14px' }}><span><b>Brand Analytics</b> — your brand&rsquo;s share of each search query&rsquo;s total impressions / clicks / cart-adds / purchases (the real market view).</span></div>
          </div>
        )}
      </div>
    </>
  )
}
