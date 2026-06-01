'use client'

/**
 * Rank Control — Keyword targeting mode. The thing the placement-% tool can't do:
 * pick the exact keywords you want to win and bid them to win it. Loads your real
 * keyword targets (/advertising/targets) joined with their Share-of-Voice
 * (/share-of-voice) so you see, per keyword: current bid, impressions, ACOS,
 * ROAS, and how much of the auction you hold. Select keywords, choose how to
 * push (boost %, set bid, or "bid to win" = beat the query's going CPC), and
 * apply via /ad-targets/bulk-bid (queued/sandbox by default — bids are clamped by
 * the CPC ceiling; live application stays gated). Navigable: each row links to
 * its campaign.
 */

import { useEffect, useMemo, useState } from 'react'
import { Search, RefreshCw, Zap } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { campaignHref } from './useCampaignMap'

const MARKETS = ['IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'SE', 'PL', 'IE', 'UK', 'All']
interface Target { id: string; text: string; kind: string; matchType: string | null; bidCents: number; status: string; campaignId: string; campaignName: string; marketplace: string | null; adGroupName: string; impressions: number; clicks: number; spendCents: number; salesCents: number; orders: number; acos: number | null; roas: number | null }
interface Sov { query: string; sovPct: number; cpcCents: number; impressions: number }

const eur = (c: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100)
const num = (n: number) => new Intl.NumberFormat('en-US').format(Math.round(n))
const pct = (v: number | null, dp = 0) => (v == null ? '—' : `${(v * 100).toFixed(dp)}%`)

export function RankKeywordsMode() {
  const [market, setMarket] = useState('All')
  const [rows, setRows] = useState<Target[] | null>(null)
  const [sov, setSov] = useState<Record<string, Sov>>({})
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<'boost' | 'set' | 'win'>('win')
  const [boostPct, setBoostPct] = useState(25)
  const [setEur, setSetEur] = useState('1.00')
  const [winMult, setWinMult] = useState(130) // % of going CPC to bid to win
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const load = () => {
    setRows(null); setSel(new Set())
    const mkt = market === 'All' ? '' : `&marketplace=${market}`
    void fetch(`${getBackendUrl()}/api/advertising/targets?windowDays=30&limit=400${mkt}`, { cache: 'no-store' })
      .then((r) => r.json()).then((d) => setRows((d.rows ?? []).filter((t: Target) => t.kind === 'KEYWORD' && t.text))).catch(() => setRows([]))
    void fetch(`${getBackendUrl()}/api/advertising/share-of-voice?windowDays=30&limit=400`, { cache: 'no-store' })
      .then((r) => r.json()).then((d) => { const m: Record<string, Sov> = {}; for (const s of (d.rows ?? [])) m[(s.query ?? '').toLowerCase()] = s; setSov(m) }).catch(() => {})
  }
  useEffect(load, [market]) // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    const ql = q.trim().toLowerCase()
    return (rows ?? []).filter((t) => (market === 'All' || t.marketplace === market) && (!ql || t.text.toLowerCase().includes(ql) || t.campaignName.toLowerCase().includes(ql)))
      .sort((a, b) => b.impressions - a.impressions)
  }, [rows, q])

  const sovFor = (t: Target) => sov[t.text.toLowerCase()]
  // target bid for a row given the current mode
  const targetBid = (t: Target): number => {
    if (mode === 'set') return Math.max(2, Math.round(Number(setEur) * 100))
    if (mode === 'boost') return Math.max(2, Math.round(t.bidCents * (1 + boostPct / 100)))
    const s = sovFor(t)
    const going = s?.cpcCents ?? t.bidCents
    return Math.max(t.bidCents, Math.round(going * (winMult / 100))) // bid to win = beat going CPC
  }

  const allSel = shown.length > 0 && shown.every((t) => sel.has(t.id))
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const apply = async () => {
    const targets = shown.filter((t) => sel.has(t.id))
    if (!targets.length) return
    setBusy(true); setMsg('')
    try {
      const entries = targets.map((t) => ({ adTargetId: t.id, bidCents: targetBid(t) }))
      const r = await fetch(`${getBackendUrl()}/api/advertising/ad-targets/bulk-bid`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries, reason: `Rank Control keyword boost (${mode})`, applyImmediately: false }),
      }).then((x) => x.json()).catch(() => null)
      if (r && r.ok !== false) { setMsg(`Queued bid changes for ${entries.length} keyword(s) — review in bid history, then go live.${r.clamps ? ` ${r.clamps} clamped by CPC ceiling.` : ''}`); setSel(new Set()); load() }
      else setMsg(r?.error ? `Could not apply: ${r.error}` : 'Could not apply')
    } finally { setBusy(false) }
  }

  return (
    <div style={{ paddingTop: 4 }}>
      <div style={{ color: 'var(--ink2)', fontSize: 12.5, marginBottom: 12, lineHeight: 1.5 }}>Pick the keywords you want to win and bid them to win it. Each row shows your bid, performance and how much of the auction you hold (Share of Voice). “Bid to win” beats the query’s going CPC; changes are queued (sandbox) + clamped by your CPC ceiling.</div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '0 2px 12px', flexWrap: 'wrap' }}>
        <select value={market} onChange={(e) => setMarket(e.target.value)} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 9px', font: 'inherit', cursor: 'pointer' }} aria-label="Market">{MARKETS.map((m) => <option key={m}>{m === 'All' ? 'All markets' : m}</option>)}</select>
        <div className="az-search" style={{ minWidth: 200, padding: '6px 10px' }}><Search size={14} /><input placeholder="Find a keyword" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <span style={{ flex: 1 }} />
        <button className="az-iconbtn" onClick={load} title="Refresh"><RefreshCw size={15} /></button>
      </div>

      {/* push controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', border: '1px solid var(--divider)', borderRadius: 10, marginBottom: 12, flexWrap: 'wrap', background: 'var(--bg2)' }}>
        <span style={{ fontWeight: 700, fontSize: 12.5 }}>Push:</span>
        {([['win', 'Bid to win'], ['boost', 'Boost %'], ['set', 'Set bid']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setMode(k)} style={{ border: `1.5px solid ${mode === k ? 'var(--navy)' : 'var(--border)'}`, background: mode === k ? '#fff' : 'transparent', borderRadius: 7, padding: '5px 12px', cursor: 'pointer', fontWeight: 600, fontSize: 12 }}>{l}</button>
        ))}
        {mode === 'boost' && <label style={{ fontSize: 12, color: 'var(--ink2)' }}>+<input type="number" value={boostPct} onChange={(e) => setBoostPct(Number(e.target.value))} style={{ width: 56, margin: '0 4px', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 6px', font: 'inherit' }} />% of current bid</label>}
        {mode === 'set' && <label style={{ fontSize: 12, color: 'var(--ink2)' }}>€<input type="number" step="0.05" value={setEur} onChange={(e) => setSetEur(e.target.value)} style={{ width: 70, margin: '0 4px', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 6px', font: 'inherit' }} /> per click</label>}
        {mode === 'win' && <label style={{ fontSize: 12, color: 'var(--ink2)' }}>bid <input type="number" value={winMult} onChange={(e) => setWinMult(Number(e.target.value))} style={{ width: 60, margin: '0 4px', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 6px', font: 'inherit' }} />% of the going CPC</label>}
        <span style={{ flex: 1 }} />
        <button className="az-btn dark" disabled={busy || sel.size === 0} onClick={() => void apply()}><Zap size={14} />{busy ? 'Queuing…' : `Apply to ${sel.size} keyword(s)`}</button>
      </div>
      {msg && <div style={{ color: msg.includes('Queued') ? 'var(--green)' : '#cc1100', fontSize: 12, fontWeight: 600, marginBottom: 10 }}>{msg}</div>}

      <div className="az-tablewrap">
        <table className="az-table">
          <thead><tr>
            <th className="l" style={{ width: 32 }}><input type="checkbox" className="az-check" checked={allSel} onChange={(e) => setSel(e.target.checked ? new Set(shown.map((t) => t.id)) : new Set())} /></th>
            <th className="l">Keyword</th><th className="l">Match</th><th className="l">Campaign · market</th><th>Bid</th><th>SoV</th><th>Impr.</th><th>ACOS</th><th>ROAS</th><th>New bid</th>
          </tr></thead>
          <tbody>
            {rows === null && <tr><td className="az-empty" colSpan={10}>Loading keywords…</td></tr>}
            {rows !== null && shown.length === 0 && <tr><td className="az-empty" colSpan={10}>No keyword targets {market === 'All' ? '' : `in ${market}`} match.</td></tr>}
            {shown.map((t) => { const s = sovFor(t); const nb = targetBid(t); const up = nb > t.bidCents; return (
              <tr key={t.id} className={sel.has(t.id) ? 'sel' : ''}>
                <td className="l"><input type="checkbox" className="az-check" checked={sel.has(t.id)} onChange={() => toggle(t.id)} /></td>
                <td className="l" style={{ fontWeight: 500 }}>{t.text}</td>
                <td className="l"><span className="sub">{(t.matchType ?? '').replace('SEARCH_', '').replace('_', ' ').toLowerCase() || '—'}</span></td>
                <td className="l"><a className="cn" href={campaignHref(t.campaignId)} target="_blank" rel="noopener noreferrer">{t.campaignName}</a><div className="sub">{t.marketplace ?? ''}</div></td>
                <td className="num">{eur(t.bidCents)}</td>
                <td className="num">{s ? pct(s.sovPct, 0) : '—'}</td>
                <td className="num">{num(t.impressions)}</td>
                <td className="num">{pct(t.acos, 0)}</td>
                <td className="num">{t.roas == null ? '—' : `${t.roas.toFixed(1)}×`}</td>
                <td className="num" style={{ fontWeight: 700, color: up ? 'var(--green)' : 'var(--ink2)' }}>{eur(nb)}{up ? ' ↑' : ''}</td>
              </tr>
            ) })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
