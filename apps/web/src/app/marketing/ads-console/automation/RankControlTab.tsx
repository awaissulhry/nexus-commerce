'use client'

/**
 * Rank Control — set the EXACT placement bid adjustment you want (Amazon's
 * "Top of search (Page 1)" / "Product pages" / "Rest of search" %, 0–900%),
 * for the campaigns you pick, by market and (optionally) by day/hour. The % you
 * choose is sent verbatim to set_placement_multiplier (action.percentage) with
 * an explicit campaignId per campaign (the SCHEDULE context carries no campaign,
 * so the targeting must be explicit). An optional "hold the position" layer
 * nudges keyword bids up in small steps if you slip, capped at a €/day ceiling
 * so it wins for the LEAST cost. Created disabled + dry-run; enable in Active
 * rules. (Amazon is an auction — this maximises/defends the slot within your
 * cap; it can't pin a fixed rank.)
 */

import { useEffect, useMemo, useState } from 'react'
import { Crosshair, Check, Info, Clock, TrendingUp } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { RankKeywordsMode } from './RankKeywordsMode'
import { RankStrategyMode } from './RankStrategyMode'
import { RankConquestMode } from './RankConquestMode'
import { RankTosMode } from './RankTosMode'

const MARKETS = ['IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'SE', 'PL', 'IE', 'UK', 'All markets']
const PLACEMENTS = [
  { k: 'PLACEMENT_TOP', label: 'Top of search (Page 1)', hint: 'Above-the-fold, page 1 — the most visible, most competitive slot.', primary: true },
  { k: 'PLACEMENT_PRODUCT_PAGE', label: 'Product pages', hint: 'On competitors’ and related detail pages.' },
  { k: 'PLACEMENT_REST_OF_SEARCH', label: 'Rest of search', hint: 'Lower / later search results — cheapest reach.' },
]
const PRESETS = [
  { k: 'defend', label: 'Defend', top: 50 },
  { k: 'aggressive', label: 'Aggressive', top: 150 },
  { k: 'dominate', label: 'Dominate', top: 300 },
  { k: 'max', label: 'Max (+900%)', top: 900 },
]
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const WHENS = [
  { k: 'all', label: 'All day, every day' },
  { k: 'business', label: 'Business hours' },
  { k: 'evenings', label: 'Evenings' },
  { k: 'custom', label: 'Custom' },
]
const DP_STORE = 'ads-console:dayparting:v1'
const emptyGrid = () => Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0))
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`
const clampPct = (n: number) => Math.max(0, Math.min(900, Math.round(n)))

interface Camp { id: string; name: string; marketplace: string | null }

export function RankControlTab({ onSaved }: { onSaved: () => void }) {
  const [rcMode, setRcMode] = useState<'placement' | 'keywords' | 'strategy' | 'conquest' | 'tos'>('placement')
  const [market, setMarket] = useState('IT')
  const [camps, setCamps] = useState<Camp[]>([])
  const [selCamps, setSelCamps] = useState<Set<string>>(new Set())
  const [pct, setPct] = useState<Record<string, number>>({ PLACEMENT_TOP: 100, PLACEMENT_PRODUCT_PAGE: 0, PLACEMENT_REST_OF_SEARCH: 0 })
  const [autoDefend, setAutoDefend] = useState(true)
  const [defendStep, setDefendStep] = useState(15)
  const [ceiling, setCeiling] = useState('')
  const [retarget, setRetarget] = useState(false)
  const [when, setWhen] = useState('all')
  const [days, setDays] = useState<Set<number>>(new Set([0, 1, 2, 3, 4]))
  const [hStart, setHStart] = useState(8)
  const [hEnd, setHEnd] = useState(20)
  const [biasDp, setBiasDp] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    void fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setCamps((d.items ?? []).map((c: Record<string, unknown>) => ({ id: c.id as string, name: c.name as string, marketplace: (c.marketplace as string) ?? null }))))
      .catch(() => {})
  }, [])

  const marketCamps = useMemo(() => (market === 'All markets' ? camps : camps.filter((c) => c.marketplace === market)), [camps, market])
  // default: select every campaign in the chosen market
  useEffect(() => { setSelCamps(new Set(marketCamps.map((c) => c.id))) }, [market, camps]) // eslint-disable-line react-hooks/exhaustive-deps

  const topPct = pct.PLACEMENT_TOP ?? 0
  const setP = (k: string, v: number) => setPct((m) => ({ ...m, [k]: clampPct(v) }))
  const toggleCamp = (id: string) => setSelCamps((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const allCampsSel = marketCamps.length > 0 && marketCamps.every((c) => selCamps.has(c.id))

  const windowCells = (): Array<[number, number]> => {
    const cells: Array<[number, number]> = []
    const inHours = (h: number) => (hStart <= hEnd ? h >= hStart && h < hEnd : h >= hStart || h < hEnd)
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) {
      if (when === 'all') continue
      if (when === 'business' && d < 5 && h >= 8 && h < 20) cells.push([d, h])
      else if (when === 'evenings' && h >= 17 && h < 23) cells.push([d, h])
      else if (when === 'custom' && days.has(d) && inHours(h)) cells.push([d, h])
    }
    return cells
  }
  const cellCount = windowCells().length
  const whenLabel = when === 'all' ? 'all day, every day'
    : when === 'business' ? 'business hours (Mon–Fri, 08:00–20:00)'
    : when === 'evenings' ? 'evenings (17:00–23:00)'
    : `${DOW.filter((_, i) => days.has(i)).join(', ') || 'no days'} · ${hh(hStart)}–${hh(hEnd)}`
  const toggleDay = (i: number) => setDays((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n })

  const canActivate = topPct > 0 && selCamps.size > 0 && !busy

  const activate = async () => {
    if (!canActivate) { setMsg(topPct <= 0 ? 'Set a Top-of-Search % above 0.' : 'Pick at least one campaign.'); return }
    setBusy(true); setMsg('')
    try {
      const targets = marketCamps.filter((c) => selCamps.has(c.id))
      const activePlacements = PLACEMENTS.filter((p) => clampPct(pct[p.k] ?? 0) > 0)
      // explicit campaignId per action — SCHEDULE context has no campaign.
      const actions: Array<Record<string, unknown>> = []
      for (const c of targets) {
        for (const p of activePlacements) actions.push({ type: 'set_placement_multiplier', campaignId: c.id, placement: p.k, percentage: clampPct(pct[p.k] ?? 0) })
        if (autoDefend) actions.push({ type: 'raise_bids_for_rank_defense', campaignId: c.id, percent: defendStep })
      }
      actions.push({ type: 'notify', target: 'operator', message: `Rank control — Top of search +${topPct}% on ${targets.length} campaign(s) in ${market} (${whenLabel})` })
      const extras = activePlacements.filter((p) => !p.primary).map((p) => `${p.label} +${pct[p.k]}%`).join(', ')
      const r = await fetch(`${getBackendUrl()}/api/advertising/automation-rules`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Rank control — Top +${topPct}% · ${targets.length} campaign(s) (${market})${when !== 'all' ? ` · ${when}` : ''}`,
          description: `Sets Top of search (Page 1) to +${topPct}%${extras ? `, ${extras}` : ''} on ${targets.length} campaign(s) in ${market}${autoDefend ? `, then holds the slot with +${defendStep}% bid steps${ceiling ? ` capped at €${ceiling}/day` : ''}` : ''}, ${whenLabel}.${retarget ? ' Retargets prior PDP viewers where Sponsored Display supports it.' : ''}`,
          trigger: 'SCHEDULE', conditions: [], actions,
          scopeMarketplace: market === 'All markets' ? null : market,
          maxExecutionsPerDay: 24,
          maxDailyAdSpendCentsEur: ceiling ? Math.round(Number(ceiling) * 100) : null,
        }),
      })
      if (!r.ok) { setMsg('Could not create'); return }

      let biased = 0
      if (biasDp && when !== 'all') {
        const cells = windowCells()
        let grid: number[][]
        try { const s = localStorage.getItem(DP_STORE); const g = s ? JSON.parse(s) : null; grid = Array.isArray(g) && g.length === 7 ? g : emptyGrid() } catch { grid = emptyGrid() }
        const boost = topPct >= 300 ? 50 : 25
        for (const [d, h] of cells) { if ((grid[d]?.[h] ?? 0) < boost) { grid[d][h] = boost; biased++ } }
        try { localStorage.setItem(DP_STORE, JSON.stringify(grid)) } catch { /* ignore */ }
        await fetch(`${getBackendUrl()}/api/advertising/schedules`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'DAYPARTING', name: `Rank-control window — Top +${topPct}% ${market}`, grid }) }).catch(() => {})
      }
      setMsg(`Rank control created for ${targets.length} campaign(s) (disabled + dry-run)${biased ? ` · biased ${biased} Dayparting hour(s)` : ''} — enable it in Active rules.`)
      onSaved()
    } finally { setBusy(false) }
  }

  return (
    <div style={{ paddingTop: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 15 }}><Crosshair size={16} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />Rank Control</span>
        <span style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 6 }}>
          {([['placement', 'Placement %'], ['keywords', 'Keyword targeting'], ['strategy', 'Strategy & cost'], ['conquest', 'Conquesting'], ['tos', 'Top-of-Search IS']] as const).map(([k, l]) => (
            <button key={k} onClick={() => setRcMode(k)} className={`az-chip quick ${rcMode === k ? 'on' : ''}`}>{l}</button>
          ))}
        </div>
      </div>
      {rcMode === 'keywords' && <RankKeywordsMode />}
      {rcMode === 'strategy' && <RankStrategyMode />}
      {rcMode === 'conquest' && <RankConquestMode />}
      {rcMode === 'tos' && <RankTosMode onSaved={onSaved} />}
      {rcMode === 'placement' && <div style={{ maxWidth: 760 }}>
      <div style={{ color: 'var(--ink2)', fontSize: 12.5, marginBottom: 16, lineHeight: 1.55 }}>Set the exact <b>Top-of-Search bid adjustment %</b> you want (and the other placements) for the campaigns you choose, by market and time. The engine writes that placement % to Amazon and — with Hold-the-position on — nudges bids up only as needed to keep the slot, capped so you win for the least cost.</div>

      <div className="az-eng-card" style={{ marginBottom: 16 }}>
        <h4>1 · Market</h4>
        <select value={market} onChange={(e) => setMarket(e.target.value)} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', font: 'inherit', cursor: 'pointer', minWidth: 180 }}>{MARKETS.map((m) => <option key={m}>{m}</option>)}</select>
      </div>

      <div className="az-eng-card" style={{ marginBottom: 16 }}>
        <h4>2 · Campaigns <span style={{ color: 'var(--ink2)', fontWeight: 500, fontSize: 12 }}>· {selCamps.size} of {marketCamps.length} selected</span></h4>
        {marketCamps.length === 0
          ? <div style={{ color: 'var(--ink2)', fontSize: 12 }}>{camps.length === 0 ? 'Loading campaigns…' : `No campaigns in ${market}.`}</div>
          : <>
              <label className="az-rowstat" style={{ fontSize: 12, cursor: 'pointer', marginBottom: 8, display: 'inline-flex' }}><input type="checkbox" checked={allCampsSel} onChange={(e) => setSelCamps(e.target.checked ? new Set(marketCamps.map((c) => c.id)) : new Set())} style={{ marginRight: 6 }} />All campaigns in {market}</label>
              <div style={{ maxHeight: 180, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2, border: '1px solid var(--divider)', borderRadius: 8, padding: 8 }}>
                {marketCamps.map((c) => (
                  <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, padding: '3px 4px', cursor: 'pointer' }}>
                    <input type="checkbox" checked={selCamps.has(c.id)} onChange={() => toggleCamp(c.id)} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                    {c.marketplace && <span style={{ color: 'var(--ink3)', fontSize: 10.5 }}>{c.marketplace}</span>}
                  </label>
                ))}
              </div>
            </>}
      </div>

      <div className="az-eng-card" style={{ marginBottom: 16 }}>
        <h4>3 · Placement bid adjustments</h4>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
          <span style={{ fontSize: 11.5, color: 'var(--ink2)', alignSelf: 'center' }}>Quick-set Top of search:</span>
          {PRESETS.map((p) => (
            <button key={p.k} onClick={() => setP('PLACEMENT_TOP', p.top)} style={{ border: `1.5px solid ${topPct === p.top ? 'var(--navy)' : 'var(--border)'}`, background: topPct === p.top ? 'var(--bg2)' : '#fff', borderRadius: 8, padding: '5px 12px', cursor: 'pointer', fontWeight: 600, fontSize: 12 }}>{p.label}</button>
          ))}
        </div>
        {PLACEMENTS.map((p) => {
          const v = pct[p.k] ?? 0
          return (
            <div key={p.k} style={{ padding: p.primary ? '12px 14px' : '10px 14px', border: `1px solid ${p.primary ? 'var(--navy)' : 'var(--divider)'}`, borderRadius: 10, marginBottom: 10, background: p.primary ? 'var(--bg2)' : '#fff' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <span style={{ fontWeight: p.primary ? 700 : 600, fontSize: p.primary ? 13.5 : 12.5 }}>{p.label}</span>
                {p.primary && <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: 'var(--navy)', borderRadius: 4, padding: '1px 6px' }}>HEADLINE</span>}
                <span style={{ flex: 1 }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ color: 'var(--ink2)', fontWeight: 700 }}>+</span>
                  <input type="number" min={0} max={900} value={v} onChange={(e) => setP(p.k, Number(e.target.value))} style={{ width: 72, border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', font: 'inherit', fontWeight: 700, textAlign: 'right' }} />
                  <span style={{ color: 'var(--ink2)', fontWeight: 700 }}>%</span>
                </div>
              </div>
              <input type="range" min={0} max={900} step={5} value={v} onChange={(e) => setP(p.k, Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--navy)', cursor: 'pointer' }} aria-label={`${p.label} bid adjustment`} />
              <div style={{ color: 'var(--ink2)', fontSize: 11, marginTop: 2 }}>{p.hint}</div>
            </div>
          )
        })}
        <div style={{ color: 'var(--ink2)', fontSize: 11, marginTop: 2 }}><Info size={11} style={{ verticalAlign: 'text-bottom' }} /> A bid that wins Top of search is your base bid × (1 + this %). Amazon caps placement adjustments at +900%. Placements left at 0% are not changed.</div>
      </div>

      <div className="az-eng-card" style={{ marginBottom: 16 }}>
        <h4>4 · Hold the position — win for the least cost</h4>
        <label className="az-rowstat" style={{ fontSize: 12.5, cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}><input type="checkbox" checked={autoDefend} onChange={(e) => setAutoDefend(e.target.checked)} style={{ marginRight: 6 }} /><TrendingUp size={14} style={{ marginRight: 5 }} />Auto-defend the slot: nudge bids up in small steps if you start losing it</label>
        {autoDefend && (
          <div style={{ marginTop: 12, display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center' }}>
            <label style={{ fontSize: 12, color: 'var(--ink2)' }}>Bid step <input type="number" min={5} max={50} value={defendStep} onChange={(e) => setDefendStep(Math.max(5, Math.min(50, Number(e.target.value))))} style={{ width: 60, margin: '0 4px', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', font: 'inherit' }} />%</label>
            <label style={{ fontSize: 12, color: 'var(--ink2)' }}>Max €/day (cost cap) <input type="number" value={ceiling} placeholder="none" onChange={(e) => setCeiling(e.target.value)} style={{ width: 90, marginLeft: 6, border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', font: 'inherit' }} /></label>
          </div>
        )}
        <div style={{ marginTop: 12 }}>
          <label className="az-rowstat" style={{ fontSize: 12.5, cursor: 'pointer' }}><input type="checkbox" checked={retarget} onChange={(e) => setRetarget(e.target.checked)} style={{ marginRight: 6 }} />Boost shoppers who already viewed the product page</label>
          {retarget && <div style={{ color: 'var(--ink2)', fontSize: 11.5, marginTop: 8 }}><Info size={12} style={{ verticalAlign: 'text-bottom' }} /> PDP-viewer retargeting runs via Sponsored Display view-remarketing audiences where your account supports them.</div>}
        </div>
      </div>

      <div className="az-eng-card" style={{ marginBottom: 16 }}>
        <h4>5 · When to push hardest</h4>
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
        <b>Plan:</b> on <b>{selCamps.size} campaign(s)</b> in <b>{market}</b>, set <b>Top of search to +{topPct}%</b>{pct.PLACEMENT_PRODUCT_PAGE ? `, Product pages +${pct.PLACEMENT_PRODUCT_PAGE}%` : ''}{pct.PLACEMENT_REST_OF_SEARCH ? `, Rest of search +${pct.PLACEMENT_REST_OF_SEARCH}%` : ''}.{autoDefend ? <> Then <b>hold the slot</b> with +{defendStep}% bid steps{ceiling ? <>, capped at <b>€{ceiling}/day</b> (least cost)</> : ' (set a €/day cap to bound the cost)'}.</> : null} <b>{whenLabel}</b>.{when !== 'all' && biasDp ? <span style={{ color: 'var(--ink2)' }}> <Clock size={12} style={{ verticalAlign: 'text-bottom' }} /> Dayparting biased up for {cellCount} hour(s).</span> : null}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="az-btn dark" disabled={!canActivate} onClick={() => void activate()}><Check size={15} />{busy ? 'Creating…' : 'Activate rank control'}</button>
        {msg && <span style={{ color: msg.includes('created') ? 'var(--green)' : 'var(--ink2)', fontSize: 12, fontWeight: 600 }}>{msg}</span>}
      </div>
      </div>}
    </div>
  )
}
