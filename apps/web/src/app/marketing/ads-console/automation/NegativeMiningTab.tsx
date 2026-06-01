'use client'

/**
 * Negative-keyword mining — finds search terms burning spend without converting
 * (GET /advertising/reports/negative-keyword-candidates) and lets the operator
 * bulk-negate them (POST /advertising/negative-keywords per term, using the
 * term's external campaign/ad-group ids + marketplace). The manual companion to
 * the auto-negation automations.
 */

import { useEffect, useMemo, useState } from 'react'
import { Ban, RefreshCw, Check, Download } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { useCampaignMap, campaignHref } from './useCampaignMap'
import { TableSkel } from './_ui'
import { downloadCsv } from './_csv'

interface Cand { query: string; matchType: string; campaignId: string; adGroupId: string; marketplace: string; totalImpressions: number; totalClicks: number; totalCostUnits: number }
const num = (n: number) => new Intl.NumberFormat('en-US').format(Math.round(n))
const eur = (u: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(u)

export function NegativeMiningTab() {
  const [cands, setCands] = useState<Cand[]>([])
  const [minSpend, setMinSpend] = useState('3')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [done, setDone] = useState<Set<string>>(new Set())
  const campMap = useCampaignMap()
  const key = (c: Cand) => `${c.query}:${c.campaignId}:${c.adGroupId}`
  const load = () => { setLoading(true); void fetch(`${getBackendUrl()}/api/advertising/reports/negative-keyword-candidates?lookbackDays=30&minSpend=${minSpend || 0}&limit=300`, { cache: 'no-store' }).then((r) => r.json()).then((d) => { setCands(d.candidates ?? []); setSel(new Set()) }).catch(() => {}).finally(() => setLoading(false)) }
  useEffect(load, [minSpend])

  const negateOne = async (c: Cand): Promise<boolean> => {
    const r = await fetch(`${getBackendUrl()}/api/advertising/negative-keywords`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ externalCampaignId: c.campaignId, externalAdGroupId: c.adGroupId, keywordText: c.query, matchType: 'NEGATIVE_EXACT', scope: 'AD_GROUP', marketplace: c.marketplace }) }).catch(() => null)
    return !!r && r.ok
  }
  const negateSelected = async () => {
    const targets = cands.filter((c) => sel.has(key(c)) && !done.has(key(c)))
    if (!targets.length) return
    setBusy(true)
    try { const ok = new Set(done); for (const c of targets) { if (await negateOne(c)) ok.add(key(c)) } setDone(ok); setSel(new Set()) } finally { setBusy(false) }
  }
  const toggle = (c: Cand) => setSel((s) => { const n = new Set(s); const k = key(c); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const [mkt, setMkt] = useState('All')
  const markets = useMemo(() => Array.from(new Set(cands.map((c) => c.marketplace).filter(Boolean))) as string[], [cands])
  const shown = useMemo(() => (mkt === 'All' ? cands : cands.filter((c) => c.marketplace === mkt)), [cands, mkt])
  const wasted = useMemo(() => shown.reduce((s, c) => s + c.totalCostUnits, 0), [shown])
  const allSel = shown.length > 0 && shown.every((c) => sel.has(key(c)) || done.has(key(c)))

  return (
    <div style={{ paddingTop: 4 }}>
      <div className="az-hero">
        <div className="az-stat"><div className="k">Waste candidates</div><div className="v" style={{ color: shown.length ? '#cc1100' : 'var(--green)' }}>{shown.length}</div><div className="s">spend, no orders (30d)</div></div>
        <div className="az-stat"><div className="k">Wasted spend</div><div className="v">{eur(wasted)}</div><div className="s">recoverable by negating</div></div>
        <div className="az-stat"><div className="k">Negated</div><div className="v" style={{ color: 'var(--green)' }}>{done.size}</div><div className="s">this session</div></div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '6px 2px 10px', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700 }}><Ban size={15} style={{ verticalAlign: 'text-bottom', marginRight: 5 }} />Negative-keyword mining</span>
        <span className="ctl" style={{ cursor: 'default' }}>Min spend €<input type="number" value={minSpend} onChange={(e) => setMinSpend(e.target.value)} style={{ width: 56, marginLeft: 6, border: '1px solid var(--border)', borderRadius: 6, padding: '4px 6px', font: 'inherit' }} /></span>
        <select value={mkt} onChange={(e) => setMkt(e.target.value)} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', font: 'inherit', cursor: 'pointer' }} aria-label="Market"><option value="All">All markets</option>{markets.map((m) => <option key={m} value={m}>{m}</option>)}</select>
        <span style={{ flex: 1 }} />
        {sel.size > 0 && <button className="az-btn dark" disabled={busy} onClick={() => void negateSelected()}>{busy ? 'Negating…' : `Negate ${sel.size}`}</button>}
        <button className="az-iconbtn" onClick={() => downloadCsv('negative-keyword-candidates.csv', shown.map((c) => ({ query: c.query, matchType: c.matchType, campaign: campMap[c.campaignId]?.name ?? c.campaignId, marketplace: c.marketplace ?? '', adGroupId: c.adGroupId, impressions: c.totalImpressions, clicks: c.totalClicks, wastedSpendEur: c.totalCostUnits, status: done.has(key(c)) ? 'negated' : 'candidate' })))} title="Export CSV"><Download size={15} /></button>
        <button className="az-iconbtn" onClick={load} title="Refresh"><RefreshCw size={15} className={loading ? 'az-spin' : ''} /></button>
      </div>
      <div className="az-tablewrap">
        <table className="az-table">
          <thead><tr>
            <th className="l" style={{ width: 36 }}><input type="checkbox" className="az-check" checked={allSel} onChange={(e) => setSel(e.target.checked ? new Set(shown.filter((c) => !done.has(key(c))).map(key)) : new Set())} /></th>
            <th className="l">Search term</th><th className="l">Match</th><th className="l">Campaign · market</th><th>Impressions</th><th>Clicks</th><th>Wasted spend</th><th className="l">Status</th>
          </tr></thead>
          <tbody>
            {loading && <TableSkel cols={8} />}
            {!loading && shown.length === 0 && <tr><td className="az-empty" colSpan={8}>No wasted-spend terms above this threshold. Clean.</td></tr>}
            {shown.map((c, i) => { const k = key(c); const isDone = done.has(k); return (
              <tr key={`${k}-${i}`} className={sel.has(k) ? 'sel' : ''}>
                <td className="l"><input type="checkbox" className="az-check" disabled={isDone} checked={sel.has(k) || isDone} onChange={() => toggle(c)} /></td>
                <td className="l" style={{ fontWeight: 500 }}>{c.query}</td>
                <td className="l"><span className="az-badge paused">{(c.matchType || '').replace(/_/g, ' ').toLowerCase()}</span></td>
                <td className="l">{(() => { const cm = campMap[c.campaignId]; return cm ? <a className="cn" href={campaignHref(cm.id)} target="_blank" rel="noopener noreferrer">{cm.name}</a> : <span className="sub">{c.campaignId}</span> })()}<div className="sub">{c.marketplace} · AG {c.adGroupId}</div></td>
                <td className="num">{num(c.totalImpressions)}</td><td className="num">{num(c.totalClicks)}</td><td className="num">{eur(c.totalCostUnits)}</td>
                <td className="l">{isDone ? <span className="az-rowstat ok"><Check size={13} />Negated</span> : <span className="sub">candidate</span>}</td>
              </tr>
            ) })}
          </tbody>
        </table>
      </div>
      <div style={{ color: 'var(--ink2)', fontSize: 12, padding: '12px 2px' }}>Negatives are added as NEGATIVE_EXACT at the ad-group level (pending). Automate it with the <b>Negate wasted search terms</b> automation in the Library.</div>
    </div>
  )
}
