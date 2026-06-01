'use client'

/**
 * Harvest console — the manual companion to the harvest automation. Live from
 * GET /advertising/harvest/preview: search terms to GRADUATE (converting → new
 * exact keywords) and to NEGATE (wasted spend). One-click apply the whole batch
 * (POST /advertising/harvest/apply), or automate it from the Library.
 */

import { useEffect, useMemo, useState } from 'react'
import { Sprout, Ban, RefreshCw } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Term { query: string; externalCampaignId: string; externalAdGroupId: string; impressions: number; clicks: number; costCents: number; orders: number; salesCents: number }
const eur = (c: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100)
const num = (n: number) => new Intl.NumberFormat('en-US').format(n)

export function HarvestTab() {
  const [negatives, setNegatives] = useState<Term[]>([])
  const [graduations, setGraduations] = useState<Term[]>([])
  const [windowDays, setWindowDays] = useState(60)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const load = () => { setLoading(true); void fetch(`${getBackendUrl()}/api/advertising/harvest/preview?windowDays=${windowDays}`, { cache: 'no-store' }).then((r) => r.json()).then((d) => { setNegatives(d.negatives ?? []); setGraduations(d.graduations ?? []) }).catch(() => {}).finally(() => setLoading(false)) }
  useEffect(load, [windowDays])

  const applyAll = async () => {
    if (typeof window !== 'undefined' && !window.confirm(`Apply harvest: promote ${graduations.length} converting term(s) to exact keywords and negate ${negatives.length} wasteful term(s)? (Queued as pending.)`)) return
    setBusy(true); setMsg('')
    try { const r = await fetch(`${getBackendUrl()}/api/advertising/harvest/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ windowDays }) }).then((x) => x.json()).catch(() => null); setMsg(r ? (r.message ?? `Applied · ${r.promoted ?? r.graduated ?? 0} promoted, ${r.negated ?? 0} negated`) : 'Applied (pending)'); load() } finally { setBusy(false) }
  }
  const wastedTotal = useMemo(() => negatives.reduce((s, t) => s + t.costCents, 0), [negatives])

  const tbl = (terms: Term[], kind: 'grad' | 'neg') => (
    <div className="az-tablewrap" style={{ marginBottom: 18 }}>
      <table className="az-table">
        <thead><tr><th className="l">Search term</th><th>Impressions</th><th>Clicks</th><th>Spend</th><th>Orders</th><th>Sales</th></tr></thead>
        <tbody>
          {terms.length === 0 && <tr><td className="az-empty" colSpan={6}>{loading ? 'Loading…' : kind === 'grad' ? 'No converting terms to graduate right now.' : 'No wasteful terms to negate right now.'}</td></tr>}
          {terms.map((t, i) => (
            <tr key={`${t.query}-${i}`}>
              <td className="l" style={{ fontWeight: 500 }}>{t.query}</td>
              <td className="num">{num(t.impressions)}</td><td className="num">{num(t.clicks)}</td><td className="num">{eur(t.costCents)}</td>
              <td className="num" style={{ color: kind === 'grad' ? 'var(--green)' : undefined }}>{num(t.orders)}</td><td className="num">{eur(t.salesCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  return (
    <div style={{ paddingTop: 4 }}>
      <div className="az-hero">
        <div className="az-stat"><div className="k">To graduate</div><div className="v" style={{ color: 'var(--green)' }}>{graduations.length}</div><div className="s">converting terms → exact keywords</div></div>
        <div className="az-stat"><div className="k">To negate</div><div className="v" style={{ color: '#cc1100' }}>{negatives.length}</div><div className="s">wasteful terms</div></div>
        <div className="az-stat"><div className="k">Wasted spend found</div><div className="v">{eur(wastedTotal)}</div><div className="s">last {windowDays} days</div></div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '6px 2px 12px', flexWrap: 'wrap' }}>
        <span className="ctl" style={{ cursor: 'default' }}>Window
          <select value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))} style={{ marginLeft: 6, border: '1px solid var(--border)', borderRadius: 6, padding: '4px 6px', font: 'inherit', cursor: 'pointer' }}>{[14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}</select>
        </span>
        <span style={{ flex: 1 }} />
        <button className="az-btn dark" disabled={busy || (negatives.length + graduations.length === 0)} onClick={() => void applyAll()}>{busy ? 'Applying…' : `Apply harvest (${negatives.length + graduations.length})`}</button>
        {msg && <span style={{ color: 'var(--ink2)', fontSize: 12 }}>{msg}</span>}
        <button className="az-iconbtn" onClick={load} title="Refresh"><RefreshCw size={15} className={loading ? 'az-spin' : ''} /></button>
      </div>
      <h4 style={{ margin: '4px 2px 8px', fontSize: 13.5 }}><Sprout size={15} style={{ verticalAlign: 'text-bottom', marginRight: 5, color: 'var(--green)' }} />Graduate to exact keywords</h4>
      {tbl(graduations, 'grad')}
      <h4 style={{ margin: '4px 2px 8px', fontSize: 13.5 }}><Ban size={15} style={{ verticalAlign: 'text-bottom', marginRight: 5, color: '#cc1100' }} />Negate wasteful terms</h4>
      {tbl(negatives, 'neg')}
      <div style={{ color: 'var(--ink2)', fontSize: 12, padding: '2px 2px 14px' }}>Want this hands-free? Add the <b>Harvest &amp; negate</b> automation from the Library to run it on a schedule.</div>
    </div>
  )
}
