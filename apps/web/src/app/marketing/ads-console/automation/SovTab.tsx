'use client'

/**
 * Competitive — Share of Voice. Live from GET /share-of-voice: per search query,
 * your impression share, spend efficiency, how many of your own campaigns chase
 * it (cannibalisation), and relevance flags. The intelligence layer that tells
 * automation where to push, pull back, or consolidate.
 */

import { useEffect, useMemo, useState } from 'react'
import { Swords, RefreshCw } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface SovRow { query: string; impressions: number; clicks: number; costCents: number; orders: number; ctr: number; cvr: number; cpcCents: number; sovPct: number; campaignCount: number; topCampaignSharePct: number; cannibalized: boolean; flag?: string }
interface SovResp { windowDays: number; totalImpressions: number; queries: number; rows: SovRow[] }
const pct = (v: number, dp = 1) => `${(v * 100).toFixed(dp)}%`
const eur = (c: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100)
const num = (n: number) => new Intl.NumberFormat('en-US').format(Math.round(n))
const flagLabel: Record<string, string> = { 'weak-relevance': 'Weak relevance', 'high-sov': 'Dominating', 'low-sov': 'Low share', 'efficient': 'Efficient' }

export function SovTab() {
  const [d, setD] = useState<SovResp | null>(null)
  const [onlyFlags, setOnlyFlags] = useState(false)
  const load = () => void fetch(`${getBackendUrl()}/api/advertising/share-of-voice?limit=200`, { cache: 'no-store' }).then((r) => r.json()).then(setD).catch(() => {})
  useEffect(load, [])

  const rows = useMemo(() => (d?.rows ?? []).filter((r) => !onlyFlags || r.cannibalized || r.flag), [d, onlyFlags])
  const cannibalized = (d?.rows ?? []).filter((r) => r.cannibalized).length

  return (
    <div style={{ paddingTop: 4 }}>
      <div className="az-hero">
        <div className="az-stat"><div className="k">Search queries</div><div className="v">{d ? num(d.queries) : '…'}</div><div className="s">last {d?.windowDays ?? 30} days</div></div>
        <div className="az-stat"><div className="k">Total impressions</div><div className="v">{d ? num(d.totalImpressions) : '…'}</div><div className="s">across tracked queries</div></div>
        <div className="az-stat"><div className="k">Cannibalised</div><div className="v" style={{ color: cannibalized ? '#cc1100' : 'var(--green)' }}>{cannibalized}</div><div className="s">queries with overlapping campaigns</div></div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 2px 10px' }}>
        <span style={{ fontWeight: 700 }}><Swords size={15} style={{ verticalAlign: 'text-bottom', marginRight: 5 }} />Share of voice by query</span>
        <label className="az-rowstat" style={{ color: 'var(--ink2)', fontSize: 12, cursor: 'pointer' }}><input type="checkbox" checked={onlyFlags} onChange={(e) => setOnlyFlags(e.target.checked)} style={{ marginRight: 6 }} />Flagged only</label>
        <span style={{ flex: 1 }} />
        <button className="az-iconbtn" onClick={load} title="Refresh"><RefreshCw size={15} /></button>
      </div>
      <div className="az-tablewrap">
        <table className="az-table">
          <thead><tr><th className="l">Search query</th><th>SoV</th><th>Impressions</th><th>Clicks</th><th>CTR</th><th>CVR</th><th>CPC</th><th>Orders</th><th>Campaigns</th><th className="l">Flags</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td className="az-empty" colSpan={10}>{d ? 'No queries match.' : 'Loading…'}</td></tr>}
            {rows.map((r, i) => (
              <tr key={`${r.query}-${i}`}>
                <td className="l" style={{ fontWeight: 500 }}>{r.query}</td>
                <td className="num"><span style={{ fontWeight: 700 }}>{pct(r.sovPct)}</span></td>
                <td className="num">{num(r.impressions)}</td>
                <td className="num">{num(r.clicks)}</td>
                <td className="num">{pct(r.ctr, 2)}</td>
                <td className="num">{pct(r.cvr, 1)}</td>
                <td className="num">{eur(r.cpcCents)}</td>
                <td className="num">{num(r.orders)}</td>
                <td className="num">{r.campaignCount}{r.cannibalized ? '⚠' : ''}</td>
                <td className="l">
                  {r.cannibalized && <span className="az-badge warn" style={{ marginRight: 4 }}>cannibalised</span>}
                  {r.flag && <span className="az-badge paused">{flagLabel[r.flag] ?? r.flag}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ color: 'var(--ink2)', fontSize: 12, padding: '12px 2px' }}>Cannibalised queries (multiple of your campaigns bidding against each other) waste spend — consolidate them, then let harvesting + negation keep them clean.</div>
    </div>
  )
}
