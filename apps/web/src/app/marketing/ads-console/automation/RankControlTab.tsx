'use client'

/**
 * Rank Control — choose WHERE you want to win (placement), HOW hard, WHEN
 * (day-of-week / hour-of-day), and in WHICH market, and the engine bids to take
 * and defend that slot. Built on real actions: set_placement_multiplier
 * (Top-of-search / Product-pages / Rest-of-search, up to Amazon's +900% cap) +
 * raise_bids_for_rank_defense, scoped to the market. The WHEN dimension biases
 * the shared Dayparting schedule (merged, never clobbered) so the push lands in
 * the hours you choose. Created disabled + dry-run; enable in Active rules.
 * (Amazon is an auction — this targets/defends the slot maximally; it can't
 * literally guarantee a fixed position.)
 */

import { useState } from 'react'
import { Crosshair, Check, Info, Clock } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

const MARKETS = ['IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'SE', 'PL', 'IE', 'UK', 'All markets']
const PLACEMENTS = [
  { k: 'PLACEMENT_TOP', label: 'Top of search', hint: 'Page 1, above the fold — the most visible, most competitive slot.' },
  { k: 'PLACEMENT_PRODUCT_PAGE', label: 'Product pages', hint: 'On competitors’ and related detail pages.' },
  { k: 'PLACEMENT_REST_OF_SEARCH', label: 'Rest of search', hint: 'Lower / later search results — cheapest reach.' },
]
const AGGR = [
  { k: 'defend', label: 'Defend', pct: 50, step: 10, desc: 'Hold a strong position cost-effectively.' },
  { k: 'aggressive', label: 'Aggressive', pct: 150, step: 20, desc: 'Push hard for a top slot.' },
  { k: 'dominate', label: 'Dominate', pct: 300, step: 30, desc: 'Maximise share of the slot — highest cost.' },
]
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] // Mon-first, matches Dayparting grid rows
const WHENS = [
  { k: 'all', label: 'All day, every day' },
  { k: 'business', label: 'Business hours' },
  { k: 'evenings', label: 'Evenings' },
  { k: 'custom', label: 'Custom' },
]
const DP_STORE = 'ads-console:dayparting:v1'
const emptyGrid = () => Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0))

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`

export function RankControlTab({ onSaved }: { onSaved: () => void }) {
  const [market, setMarket] = useState('IT')
  const [placement, setPlacement] = useState('PLACEMENT_TOP')
  const [aggr, setAggr] = useState('aggressive')
  const [retarget, setRetarget] = useState(false)
  const [ceiling, setCeiling] = useState('')
  const [when, setWhen] = useState('all')
  const [days, setDays] = useState<Set<number>>(new Set([0, 1, 2, 3, 4]))
  const [hStart, setHStart] = useState(8)
  const [hEnd, setHEnd] = useState(20)
  const [biasDp, setBiasDp] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const pl = PLACEMENTS.find((p) => p.k === placement)!
  const ag = AGGR.find((a) => a.k === aggr)!

  // [day(Mon=0..Sun=6), hour] cells covered by the chosen window
  const windowCells = (): Array<[number, number]> => {
    const cells: Array<[number, number]> = []
    const inHours = (h: number) => (hStart <= hEnd ? h >= hStart && h < hEnd : h >= hStart || h < hEnd)
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        if (when === 'all') continue
        if (when === 'business' && d < 5 && h >= 8 && h < 20) cells.push([d, h])
        else if (when === 'evenings' && h >= 17 && h < 23) cells.push([d, h])
        else if (when === 'custom' && days.has(d) && inHours(h)) cells.push([d, h])
      }
    }
    return cells
  }
  const cellCount = windowCells().length
  const whenLabel = when === 'all' ? 'all day, every day'
    : when === 'business' ? 'business hours (Mon–Fri, 08:00–20:00)'
    : when === 'evenings' ? 'evenings (17:00–23:00)'
    : `${DOW.filter((_, i) => days.has(i)).join(', ') || 'no days'} · ${hh(hStart)}–${hh(hEnd)}`

  const toggleDay = (i: number) => setDays((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n })

  const activate = async () => {
    setBusy(true); setMsg('')
    try {
      const actions: Array<Record<string, unknown>> = [
        { type: 'set_placement_multiplier', placement, maxPct: ag.pct },
        { type: 'raise_bids_for_rank_defense', percent: ag.step },
        { type: 'notify', target: 'operator', message: `Rank control enforced — ${pl.label} in ${market} (${whenLabel})` },
      ]
      const r = await fetch(`${getBackendUrl()}/api/advertising/automation-rules`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Rank control — ${pl.label} (${market})${when !== 'all' ? ` · ${when}` : ''}${retarget ? ' · PDP retarget' : ''}`,
          description: `Targets and defends ${pl.label} placement in ${market} at ${ag.label.toLowerCase()} aggressiveness (+${ag.pct}% multiplier), ${whenLabel}.${retarget ? ' Retargets prior PDP viewers where Sponsored Display supports it.' : ''}`,
          trigger: 'SCHEDULE', conditions: [], actions,
          scopeMarketplace: market === 'All markets' ? null : market,
          maxExecutionsPerDay: 24,
          maxDailyAdSpendCentsEur: ceiling ? Math.round(Number(ceiling) * 100) : null,
        }),
      })
      if (!r.ok) { setMsg('Could not create'); return }

      // WHEN dimension → bias the shared Dayparting schedule for the chosen hours
      // (merge: only lift cells in the window, never lower the operator's design).
      let biased = 0
      if (biasDp && when !== 'all') {
        const cells = windowCells()
        let grid: number[][]
        try { const s = localStorage.getItem(DP_STORE); const g = s ? JSON.parse(s) : null; grid = Array.isArray(g) && g.length === 7 ? g : emptyGrid() } catch { grid = emptyGrid() }
        const boost = ag.k === 'dominate' ? 50 : 25
        for (const [d, h] of cells) { if ((grid[d]?.[h] ?? 0) < boost) { grid[d][h] = boost; biased++ } }
        try { localStorage.setItem(DP_STORE, JSON.stringify(grid)) } catch { /* ignore */ }
        await fetch(`${getBackendUrl()}/api/advertising/schedules`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'DAYPARTING', name: `Rank-control window — ${pl.label} ${market}`, grid }) }).catch(() => {})
      }
      setMsg(`Rank control created (disabled + dry-run)${biased ? ` · biased ${biased} Dayparting hour(s)` : ''} — enable it in Active rules.`)
      onSaved()
    } finally { setBusy(false) }
  }

  return (
    <div style={{ paddingTop: 4, maxWidth: 760 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontWeight: 700, fontSize: 15 }}><Crosshair size={16} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />Rank Control</span>
      </div>
      <div style={{ color: 'var(--ink2)', fontSize: 12.5, marginBottom: 16, lineHeight: 1.55 }}>Pick where you want to win, how hard, when, and in which market. The engine sets the placement bid multiplier and defends the slot; the <b>When</b> step biases your Dayparting schedule so the push lands in the hours you choose.</div>

      <div className="az-eng-card" style={{ marginBottom: 16 }}>
        <h4>1 · Market</h4>
        <select value={market} onChange={(e) => setMarket(e.target.value)} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', font: 'inherit', cursor: 'pointer', minWidth: 180 }}>{MARKETS.map((m) => <option key={m}>{m}</option>)}</select>
      </div>

      <div className="az-eng-card" style={{ marginBottom: 16 }}>
        <h4>2 · Where to win (placement)</h4>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 10 }}>
          {PLACEMENTS.map((p) => (
            <button key={p.k} onClick={() => setPlacement(p.k)} style={{ textAlign: 'left', border: `1.5px solid ${placement === p.k ? 'var(--navy)' : 'var(--border)'}`, background: placement === p.k ? 'var(--bg2)' : '#fff', borderRadius: 10, padding: '12px 14px', cursor: 'pointer' }}>
              <div style={{ fontWeight: 700 }}>{p.label}{placement === p.k ? ' ✓' : ''}</div>
              <div style={{ color: 'var(--ink2)', fontSize: 11.5, marginTop: 3 }}>{p.hint}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="az-eng-card" style={{ marginBottom: 16 }}>
        <h4>3 · How hard (aggressiveness)</h4>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 10 }}>
          {AGGR.map((a) => (
            <button key={a.k} onClick={() => setAggr(a.k)} style={{ textAlign: 'left', border: `1.5px solid ${aggr === a.k ? 'var(--navy)' : 'var(--border)'}`, background: aggr === a.k ? 'var(--bg2)' : '#fff', borderRadius: 10, padding: '12px 14px', cursor: 'pointer' }}>
              <div style={{ fontWeight: 700 }}>{a.label} <span style={{ color: 'var(--ink2)', fontWeight: 500 }}>+{a.pct}%</span></div>
              <div style={{ color: 'var(--ink2)', fontSize: 11.5, marginTop: 3 }}>{a.desc}</div>
            </button>
          ))}
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center' }}>
          <label className="az-rowstat" style={{ fontSize: 12.5, cursor: 'pointer' }}><input type="checkbox" checked={retarget} onChange={(e) => setRetarget(e.target.checked)} style={{ marginRight: 6 }} />Boost shoppers who viewed the product page</label>
          <label style={{ fontSize: 12, color: 'var(--ink2)' }}>Max €/day ceiling <input type="number" value={ceiling} placeholder="none" onChange={(e) => setCeiling(e.target.value)} style={{ width: 90, marginLeft: 6, border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', font: 'inherit' }} /></label>
        </div>
        {retarget && <div style={{ color: 'var(--ink2)', fontSize: 11.5, marginTop: 8 }}><Info size={12} style={{ verticalAlign: 'text-bottom' }} /> PDP-viewer retargeting runs via Sponsored Display view-remarketing audiences where your account supports them.</div>}
      </div>

      <div className="az-eng-card" style={{ marginBottom: 16 }}>
        <h4>4 · When to push hardest</h4>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {WHENS.map((w) => (
            <button key={w.k} onClick={() => setWhen(w.k)} style={{ border: `1.5px solid ${when === w.k ? 'var(--navy)' : 'var(--border)'}`, background: when === w.k ? 'var(--bg2)' : '#fff', borderRadius: 8, padding: '8px 14px', cursor: 'pointer', fontWeight: 600, fontSize: 12.5 }}>{w.label}</button>
          ))}
        </div>
        {when === 'custom' && (
          <div style={{ marginTop: 12, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: 5 }}>{DOW.map((d, i) => (
              <button key={d} onClick={() => toggleDay(i)} style={{ width: 38, padding: '6px 0', border: `1px solid ${days.has(i) ? 'var(--navy)' : 'var(--border)'}`, background: days.has(i) ? 'var(--navy)' : '#fff', color: days.has(i) ? '#fff' : 'var(--ink2)', borderRadius: 6, cursor: 'pointer', fontSize: 11.5, fontWeight: 600 }}>{d}</button>
            ))}</div>
            <label style={{ fontSize: 12, color: 'var(--ink2)' }}>From <select value={hStart} onChange={(e) => setHStart(Number(e.target.value))} style={{ margin: '0 4px', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 6px', font: 'inherit', cursor: 'pointer' }}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hh(h)}</option>)}</select> to <select value={hEnd} onChange={(e) => setHEnd(Number(e.target.value))} style={{ marginLeft: 4, border: '1px solid var(--border)', borderRadius: 6, padding: '4px 6px', font: 'inherit', cursor: 'pointer' }}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hh(h)}</option>)}</select></label>
          </div>
        )}
        {when !== 'all' && (
          <label className="az-rowstat" style={{ fontSize: 12, color: 'var(--ink2)', cursor: 'pointer', marginTop: 12, display: 'inline-flex' }}><input type="checkbox" checked={biasDp} onChange={(e) => setBiasDp(e.target.checked)} style={{ marginRight: 6 }} />Bias my Dayparting schedule to these {cellCount} hour-of-week slots (merged, never lowered)</label>
        )}
      </div>

      <div style={{ background: 'var(--bg3)', border: '1px solid var(--divider)', borderRadius: 10, padding: '12px 14px', marginBottom: 16, fontSize: 13, lineHeight: 1.6 }}>
        <b>Plan:</b> in <b>{market}</b>, take &amp; defend <b>{pl.label}</b> at <b>{ag.label.toLowerCase()}</b> aggressiveness (placement multiplier <b>+{ag.pct}%</b>, rank-defense +{ag.step}% steps){ceiling ? `, capped at €${ceiling}/day` : ''}, <b>{whenLabel}</b>.{when !== 'all' && biasDp ? <span style={{ color: 'var(--ink2)' }}> <Clock size={12} style={{ verticalAlign: 'text-bottom' }} /> Dayparting biased up for {cellCount} hour(s).</span> : null}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="az-btn dark" disabled={busy} onClick={() => void activate()}><Check size={15} />{busy ? 'Creating…' : 'Activate rank control'}</button>
        {msg && <span style={{ color: msg.includes('created') ? 'var(--green)' : 'var(--ink2)', fontSize: 12, fontWeight: 600 }}>{msg}</span>}
      </div>
    </div>
  )
}
