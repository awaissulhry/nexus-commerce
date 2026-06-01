'use client'

/**
 * Rank Control — Bidding strategy & cost control mode. Amazon's dynamic-bidding
 * strategy is the lever that decides HOW your bid flexes in the auction; pairing
 * it with a CPC ceiling is how you win rank without overpaying ("least cost").
 * Lets you set, per campaign (bulk): the strategy — Up & down (AUTO_FOR_SALES,
 * Amazon raises up to +100% when a click is likely to convert — most aggressive
 * for rank), Down only (LEGACY_FOR_SALES, conservative), or Fixed (MANUAL) — and
 * a CPC ceiling (cap clicks at N× the bid). Writes are queued (applyImmediately
 * false) via PATCH /campaigns/:id and /campaigns/:id/cpc-ceiling. Rows link to
 * the campaign.
 */

import { useEffect, useMemo, useState } from 'react'
import { Search, RefreshCw, Gauge } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { campaignHref } from './useCampaignMap'

const MARKETS = ['IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'SE', 'PL', 'IE', 'UK', 'All']
const STRATS = [
  { k: 'AUTO_FOR_SALES', label: 'Up & down', hint: 'Amazon raises bids up to +100% when a click is likely to convert — most aggressive for rank.' },
  { k: 'LEGACY_FOR_SALES', label: 'Down only', hint: 'Amazon only lowers bids when a click is less likely to convert — conservative.' },
  { k: 'MANUAL', label: 'Fixed', hint: 'Your exact bid, no Amazon adjustment.' },
]
const STRAT_LABEL: Record<string, string> = { AUTO_FOR_SALES: 'Up & down', LEGACY_FOR_SALES: 'Down only', MANUAL: 'Fixed' }
interface Camp { id: string; name: string; marketplace: string | null; biddingStrategy: string | null; dailyBudget: number | null; acos: number | null; roas: number | null }

const eur = (n: number | null) => (n == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n))
const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`)

export function RankStrategyMode() {
  const [market, setMarket] = useState('All')
  const [rows, setRows] = useState<Camp[] | null>(null)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [strat, setStrat] = useState('AUTO_FOR_SALES')
  const [ceilOn, setCeilOn] = useState(false)
  const [ceilMult, setCeilMult] = useState(1.5)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const load = () => {
    setRows(null); setSel(new Set())
    void fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setRows((d.items ?? []).map((c: Record<string, unknown>) => ({ id: c.id as string, name: c.name as string, marketplace: (c.marketplace as string) ?? null, biddingStrategy: (c.biddingStrategy as string) ?? null, dailyBudget: c.dailyBudget == null ? null : Number(c.dailyBudget), acos: c.acos == null ? null : Number(c.acos), roas: c.roas == null ? null : Number(c.roas) }))))
      .catch(() => setRows([]))
  }
  useEffect(load, [])

  const shown = useMemo(() => {
    const ql = q.trim().toLowerCase()
    return (rows ?? []).filter((c) => (market === 'All' || c.marketplace === market) && (!ql || c.name.toLowerCase().includes(ql)))
  }, [rows, market, q])
  const allSel = shown.length > 0 && shown.every((c) => sel.has(c.id))
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const apply = async () => {
    const targets = shown.filter((c) => sel.has(c.id))
    if (!targets.length) return
    setBusy(true); setMsg('')
    try {
      let ok = 0
      for (const c of targets) {
        const r1 = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ biddingStrategy: strat, reason: 'Rank Control strategy', applyImmediately: false }) }).then((x) => x.ok).catch(() => false)
        if (ceilOn) await fetch(`${getBackendUrl()}/api/advertising/campaigns/${c.id}/cpc-ceiling`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, multiple: ceilMult }) }).catch(() => {})
        if (r1) ok++
      }
      setMsg(`Queued ${STRAT_LABEL[strat]} strategy${ceilOn ? ` + ${ceilMult}× CPC ceiling` : ''} for ${ok}/${targets.length} campaign(s).`)
      setSel(new Set()); load()
    } finally { setBusy(false) }
  }

  return (
    <div style={{ paddingTop: 4 }}>
      <div style={{ color: 'var(--ink2)', fontSize: 12.5, marginBottom: 12, lineHeight: 1.5 }}>Set how each campaign’s bid flexes in the auction, and cap the cost. <b>Up &amp; down</b> is the aggressive rank strategy (Amazon raises bids up to +100% on likely conversions); a <b>CPC ceiling</b> keeps that from overpaying. Changes are queued (sandbox).</div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '0 2px 12px', flexWrap: 'wrap' }}>
        <select value={market} onChange={(e) => setMarket(e.target.value)} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 9px', font: 'inherit', cursor: 'pointer' }} aria-label="Market">{MARKETS.map((m) => <option key={m}>{m === 'All' ? 'All markets' : m}</option>)}</select>
        <div className="az-search" style={{ minWidth: 200, padding: '6px 10px' }}><Search size={14} /><input placeholder="Find a campaign" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <span style={{ flex: 1 }} />
        <button className="az-iconbtn" onClick={load} title="Refresh"><RefreshCw size={15} /></button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', border: '1px solid var(--divider)', borderRadius: 10, marginBottom: 12, flexWrap: 'wrap', background: 'var(--bg2)' }}>
        <span style={{ fontWeight: 700, fontSize: 12.5 }}>Strategy:</span>
        {STRATS.map((s) => (
          <button key={s.k} onClick={() => setStrat(s.k)} title={s.hint} style={{ border: `1.5px solid ${strat === s.k ? 'var(--navy)' : 'var(--border)'}`, background: strat === s.k ? '#fff' : 'transparent', borderRadius: 7, padding: '5px 12px', cursor: 'pointer', fontWeight: 600, fontSize: 12 }}>{s.label}</button>
        ))}
        <label className="az-rowstat" style={{ fontSize: 12, color: 'var(--ink2)', cursor: 'pointer', marginLeft: 6 }}><input type="checkbox" checked={ceilOn} onChange={(e) => setCeilOn(e.target.checked)} style={{ marginRight: 6 }} />CPC ceiling
          {ceilOn && <input type="number" step="0.1" min={1} max={10} value={ceilMult} onChange={(e) => setCeilMult(Math.max(1, Math.min(10, Number(e.target.value))))} style={{ width: 56, margin: '0 4px', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 6px', font: 'inherit' }} />}{ceilOn && '×'}
        </label>
        <span style={{ flex: 1 }} />
        <button className="az-btn dark" disabled={busy || sel.size === 0} onClick={() => void apply()}><Gauge size={14} />{busy ? 'Queuing…' : `Apply to ${sel.size}`}</button>
      </div>
      {msg && <div style={{ color: msg.includes('Queued') ? 'var(--green)' : '#cc1100', fontSize: 12, fontWeight: 600, marginBottom: 10 }}>{msg}</div>}

      <div className="az-tablewrap">
        <table className="az-table">
          <thead><tr>
            <th className="l" style={{ width: 32 }}><input type="checkbox" className="az-check" checked={allSel} onChange={(e) => setSel(e.target.checked ? new Set(shown.map((c) => c.id)) : new Set())} /></th>
            <th className="l">Campaign</th><th className="l">Market</th><th className="l">Current strategy</th><th>Daily budget</th><th>ACOS</th><th>ROAS</th>
          </tr></thead>
          <tbody>
            {rows === null && <tr><td className="az-empty" colSpan={7}>Loading campaigns…</td></tr>}
            {rows !== null && shown.length === 0 && <tr><td className="az-empty" colSpan={7}>No campaigns {market === 'All' ? '' : `in ${market}`} match.</td></tr>}
            {shown.map((c) => (
              <tr key={c.id} className={sel.has(c.id) ? 'sel' : ''}>
                <td className="l"><input type="checkbox" className="az-check" checked={sel.has(c.id)} onChange={() => toggle(c.id)} /></td>
                <td className="l" style={{ fontWeight: 500 }}><a className="cn" href={campaignHref(c.id)} target="_blank" rel="noopener noreferrer">{c.name}</a></td>
                <td className="l"><span className="sub">{c.marketplace ?? '—'}</span></td>
                <td className="l"><span className="az-badge" style={{ background: 'var(--bg3)', color: 'var(--ink2)' }}>{c.biddingStrategy ? (STRAT_LABEL[c.biddingStrategy] ?? c.biddingStrategy) : 'Default'}</span></td>
                <td className="num">{eur(c.dailyBudget)}</td>
                <td className="num">{pct(c.acos)}</td>
                <td className="num">{c.roas == null ? '—' : `${c.roas.toFixed(1)}×`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
