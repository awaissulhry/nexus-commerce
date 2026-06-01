'use client'

/**
 * Rank Control — Top-of-Search IS mode (Option C front end). Shows Amazon's real
 * top-of-search impression share per campaign (topIS, ingested onto the TOP rows)
 * alongside the autonomous defense loop's recommendation for a target IS, and
 * lets you create a "hold this IS" automation — a SCHEDULE rule running the
 * defend_top_of_search action with your targetIS/targetAcos. The rule is created
 * disabled + dry-run; going live additionally needs per-campaign allowlisting.
 */

import { useEffect, useState } from 'react'
import { RefreshCw, Check } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { campaignHref } from './useCampaignMap'

const MARKETS = ['All', 'IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'SE', 'PL', 'IE', 'UK']
interface TosRow { campaignId: string; name: string; marketplace: string | null; topImpr: number; topSpendCents: number; topAcos: number | null; topIS: number | null; currentPct: number; recommendedPct: number; action: 'raise' | 'lower' | 'keep'; reason: string }
interface TosResp { windowDays: number; targetAcos: number; targetIS: number | null; rows: TosRow[] }

const pct = (v: number | null, dp = 0) => (v == null ? '—' : `${(v * 100).toFixed(dp)}%`)
const eur = (c: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100)
const actionColor = (a: string) => (a === 'raise' ? 'var(--green)' : a === 'lower' ? '#cc1100' : 'var(--ink2)')

export function RankTosMode({ onSaved }: { onSaved: () => void }) {
  const [market, setMarket] = useState('All')
  const [targetIS, setTargetIS] = useState(60)
  const [targetAcos, setTargetAcos] = useState(25)
  const [d, setD] = useState<TosResp | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const load = () => {
    setD(null)
    const mkt = market === 'All' ? '' : `&marketplace=${market}`
    void fetch(`${getBackendUrl()}/api/advertising/top-of-search?windowDays=30&targetIS=${targetIS / 100}&targetAcos=${targetAcos / 100}${mkt}`, { cache: 'no-store' })
      .then((r) => r.json()).then(setD).catch(() => setD({ windowDays: 30, targetAcos: targetAcos / 100, targetIS: targetIS / 100, rows: [] }))
  }
  useEffect(load, [market, targetIS, targetAcos]) // eslint-disable-line react-hooks/exhaustive-deps

  const rows = d?.rows ?? []
  const hasIS = rows.some((r) => r.topIS != null)

  const createRule = async () => {
    setBusy(true); setMsg('')
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/automation-rules`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Hold Top-of-Search IS ≥ ${targetIS}%${market === 'All' ? '' : ` (${market})`}`,
          description: `Holds top-of-search impression share at ≥ ${targetIS}% by tuning the PLACEMENT_TOP multiplier (±15%/run, ≤900%), bounded by ${targetAcos}% ACOS — raise while below target and in budget, ease off once above target or over ACOS (win the slot for the least cost).`,
          trigger: 'SCHEDULE', conditions: [],
          actions: [
            { type: 'defend_top_of_search', targetIS: targetIS / 100, targetAcos: targetAcos / 100, ...(market === 'All' ? {} : { marketplace: market }) },
            { type: 'notify', target: 'operator', message: `Top-of-Search IS defense holding ≥ ${targetIS}%` },
          ],
          scopeMarketplace: market === 'All' ? null : market,
          maxExecutionsPerDay: 48,
        }),
      })
      setMsg(r.ok ? `Created “Hold Top-of-Search IS ≥ ${targetIS}%” (disabled + dry-run). Enable it in Active rules and allowlist the campaigns to go live.` : 'Could not create')
      if (r.ok) onSaved()
    } finally { setBusy(false) }
  }

  return (
    <div style={{ paddingTop: 4 }}>
      <div style={{ color: 'var(--ink2)', fontSize: 12.5, marginBottom: 12, lineHeight: 1.5 }}>Your real <b>top-of-search impression share</b> per campaign (Amazon’s metric), with the autonomous loop’s recommendation to hold your target. Set the target, then create the hold-IS automation — it raises the Top-of-Search multiplier only while you’re below target and ACOS is in budget, and eases off otherwise (least cost).</div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 14px', border: '1px solid var(--divider)', borderRadius: 10, marginBottom: 12, flexWrap: 'wrap', background: 'var(--bg2)' }}>
        <select value={market} onChange={(e) => setMarket(e.target.value)} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 9px', font: 'inherit', cursor: 'pointer' }} aria-label="Market">{MARKETS.map((m) => <option key={m}>{m === 'All' ? 'All markets' : m}</option>)}</select>
        <label style={{ fontSize: 12.5, color: 'var(--ink2)' }}>Target IS <input type="number" min={1} max={100} value={targetIS} onChange={(e) => setTargetIS(Math.max(1, Math.min(100, Number(e.target.value))))} style={{ width: 60, margin: '0 4px', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 7px', font: 'inherit', fontWeight: 700 }} />%</label>
        <label style={{ fontSize: 12.5, color: 'var(--ink2)' }}>Max ACOS <input type="number" min={1} max={200} value={targetAcos} onChange={(e) => setTargetAcos(Math.max(1, Math.min(200, Number(e.target.value))))} style={{ width: 60, margin: '0 4px', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 7px', font: 'inherit' }} />%</label>
        <span style={{ flex: 1 }} />
        <button className="az-iconbtn" onClick={load} title="Refresh"><RefreshCw size={15} /></button>
        <button className="az-btn dark" disabled={busy} onClick={() => void createRule()}><Check size={14} />{busy ? 'Creating…' : 'Create hold-IS automation'}</button>
      </div>
      {msg && <div style={{ color: msg.includes('Created') ? 'var(--green)' : '#cc1100', fontSize: 12, fontWeight: 600, marginBottom: 10 }}>{msg}</div>}
      {!hasIS && rows.length > 0 && <div style={{ color: 'var(--ink2)', fontSize: 11.5, marginBottom: 10 }}>Top-of-Search IS isn’t populated yet — it fills in after the TOS-IS ingest runs. Recommendations fall back to ACOS until then.</div>}

      <div className="az-tablewrap">
        <table className="az-table">
          <thead><tr>
            <th className="l">Campaign</th><th className="l">Market</th><th>Top-of-Search IS</th><th>Top spend</th><th>Top ACOS</th><th>Current %</th><th>Recommended</th><th className="l">Action</th>
          </tr></thead>
          <tbody>
            {d === null && <tr><td className="az-empty" colSpan={8}>Loading…</td></tr>}
            {d !== null && rows.length === 0 && <tr><td className="az-empty" colSpan={8}>No top-of-search activity {market === 'All' ? '' : `in ${market}`} in the last 30 days.</td></tr>}
            {rows.map((r) => (
              <tr key={r.campaignId}>
                <td className="l" style={{ fontWeight: 500 }}><a className="cn" href={campaignHref(r.campaignId)} target="_blank" rel="noopener noreferrer">{r.name}</a></td>
                <td className="l"><span className="sub">{r.marketplace ?? '—'}</span></td>
                <td className="num" style={{ fontWeight: 700, color: r.topIS == null ? 'var(--ink3)' : r.topIS >= targetIS / 100 ? 'var(--green)' : '#cc6a00' }}>{pct(r.topIS)}</td>
                <td className="num">{eur(r.topSpendCents)}</td>
                <td className="num">{pct(r.topAcos)}</td>
                <td className="num">+{r.currentPct}%</td>
                <td className="num" style={{ fontWeight: r.action !== 'keep' ? 700 : 400 }}>{r.recommendedPct !== r.currentPct ? `+${r.recommendedPct}%` : '—'}</td>
                <td className="l"><span style={{ fontWeight: 700, fontSize: 11, textTransform: 'uppercase', color: actionColor(r.action) }}>{r.action}</span><div className="sub" style={{ maxWidth: 280, whiteSpace: 'normal' }}>{r.reason}</div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
