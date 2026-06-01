'use client'

/**
 * Retail readiness — don't pay for traffic you can't convert. Live from
 * GET /retail-readiness: campaigns whose advertised products are out of stock,
 * lost the Buy Box, or are uncompetitive, with a verdict. One-click pause the
 * flagged campaigns (POST /retail-readiness/apply), or automate it permanently
 * with the Retail-guard rule.
 */

import { useEffect, useMemo, useState } from 'react'
import { ShieldAlert, RefreshCw, PauseCircle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Camp { campaignId: string; name: string; marketplace: string; status: string; products: number; outOfStock: number; lostBuyBox: number; uncompetitive: number; unknown: number; verdict: string; reason: string }
const num = (n: number) => new Intl.NumberFormat('en-US').format(n)

export function RetailTab() {
  const [camps, setCamps] = useState<Camp[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const load = () => { setLoading(true); void fetch(`${getBackendUrl()}/api/advertising/retail-readiness`, { cache: 'no-store' }).then((r) => r.json()).then((d) => setCamps(d.campaigns ?? [])).catch(() => {}).finally(() => setLoading(false)) }
  useEffect(load, [])

  const flagged = useMemo(() => camps.filter((c) => c.verdict === 'pause'), [camps])
  const totalOOS = camps.reduce((s, c) => s + (c.outOfStock ?? 0), 0)
  const totalBB = camps.reduce((s, c) => s + (c.lostBuyBox ?? 0), 0)

  const applyAll = async () => {
    if (!flagged.length) return
    if (typeof window !== 'undefined' && !window.confirm(`Pause ${flagged.length} campaign(s) advertising unsellable products?`)) return
    setBusy(true); setMsg('')
    try { const r = await fetch(`${getBackendUrl()}/api/advertising/retail-readiness/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaignIds: flagged.map((c) => c.campaignId) }) }).then((x) => x.json()).catch(() => null); setMsg(r ? `Paused ${r.paused ?? r.applied ?? flagged.length} campaign(s) (pending)` : 'Applied'); load() } finally { setBusy(false) }
  }

  return (
    <div style={{ paddingTop: 4 }}>
      <div className="az-hero">
        <div className="az-stat"><div className="k">Wasting spend now</div><div className="v" style={{ color: flagged.length ? '#cc1100' : 'var(--green)' }}>{flagged.length}</div><div className="s">campaigns on unsellable products</div></div>
        <div className="az-stat"><div className="k">Out of stock</div><div className="v">{num(totalOOS)}</div><div className="s">advertised products</div></div>
        <div className="az-stat"><div className="k">Lost Buy Box</div><div className="v">{num(totalBB)}</div><div className="s">advertised products</div></div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 2px 10px', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700 }}><ShieldAlert size={15} style={{ verticalAlign: 'text-bottom', marginRight: 5 }} />Retail readiness</span>
        <span style={{ flex: 1 }} />
        {flagged.length > 0 && <button className="az-btn dark" disabled={busy} onClick={() => void applyAll()}><PauseCircle size={14} />Pause {flagged.length} flagged</button>}
        {msg && <span style={{ color: 'var(--ink2)', fontSize: 12 }}>{msg}</span>}
        <button className="az-iconbtn" onClick={load} title="Refresh"><RefreshCw size={15} /></button>
      </div>
      <div className="az-tablewrap">
        <table className="az-table">
          <thead><tr><th className="l">Campaign</th><th className="l">Market</th><th>Products</th><th>OOS</th><th>Lost BB</th><th>Uncompetitive</th><th className="l">Verdict</th><th className="l">Reason</th></tr></thead>
          <tbody>
            {loading && <tr><td className="az-empty" colSpan={8}>Loading…</td></tr>}
            {!loading && camps.length === 0 && <tr><td className="az-empty" colSpan={8}>All advertised products are sellable. 🎉</td></tr>}
            {camps.map((c) => (
              <tr key={c.campaignId} className={c.verdict === 'pause' ? 'sel' : ''}>
                <td className="l" style={{ fontWeight: 500 }}>{c.name}</td>
                <td className="l">{c.marketplace}</td>
                <td className="num">{c.products}</td>
                <td className="num" style={{ color: c.outOfStock ? '#cc1100' : undefined }}>{c.outOfStock}</td>
                <td className="num" style={{ color: c.lostBuyBox ? 'var(--amber)' : undefined }}>{c.lostBuyBox}</td>
                <td className="num">{c.uncompetitive}</td>
                <td className="l">{c.verdict === 'pause' ? <span className="az-badge warn">pause</span> : <span className="az-badge deliver">ok</span>}</td>
                <td className="l"><span className="sub">{c.reason}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ color: 'var(--ink2)', fontSize: 12, padding: '12px 2px' }}>Make this permanent: add the <b>Retail guard</b> automation (Library) to auto-pause &amp; auto-resume as stock and Buy Box change — every 15 minutes, hands-free.</div>
    </div>
  )
}
