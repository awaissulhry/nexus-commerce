'use client'

/**
 * RC4.2 — Strategy & cost station. Absorbs the old "Strategy & cost" mode into the
 * unified cockpit: pick Amazon's bid strategy (Up&Down / Down-only / Fixed) and an
 * optional CPC ceiling for the selected campaign. Both writes are gated/staged
 * (the strategy via /campaigns/:id, the ceiling via /campaigns/:id/cpc-ceiling).
 */

import { useCallback, useEffect, useState } from 'react'
import { Sliders, Loader2, Check, ChevronDown, ChevronRight } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

const STRATS = [
  { k: 'AUTO_FOR_SALES', label: 'Up & down', hint: 'Amazon raises bids up to +100% when a click is likely to convert — most aggressive for rank.' },
  { k: 'LEGACY_FOR_SALES', label: 'Down only', hint: 'Amazon only lowers bids when a click is less likely to convert — conservative.' },
  { k: 'MANUAL', label: 'Fixed', hint: 'Your exact bid, no Amazon adjustment.' },
]
const STRAT_LABEL: Record<string, string> = { AUTO_FOR_SALES: 'Up & down', LEGACY_FOR_SALES: 'Down only', MANUAL: 'Fixed' }

export function StrategyStation({ campaignId, currentStrategy, onChanged }: { campaignId: string; currentStrategy: string | null; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [strat, setStrat] = useState(currentStrategy ?? 'AUTO_FOR_SALES')
  const [ceilOn, setCeilOn] = useState(false)
  const [ceilMult, setCeilMult] = useState(1.5)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => { setStrat(currentStrategy ?? 'AUTO_FOR_SALES') }, [currentStrategy, campaignId])
  useEffect(() => {
    if (!campaignId || !open) return
    const ac = new AbortController()
    void fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaignId}/placements`, { cache: 'no-store', signal: ac.signal }).then(r => r.json()).then(d => { if (d.cpcCeiling) { setCeilOn(!!d.cpcCeiling.enabled); setCeilMult(d.cpcCeiling.multiple ?? 1.5) } }).catch(() => {})
    return () => ac.abort()
  }, [campaignId, open])

  const apply = useCallback(async () => {
    if (!campaignId) return
    setBusy(true); setMsg('')
    try {
      const ok = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaignId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ biddingStrategy: strat, reason: 'Rank Control strategy (RC4.2)', applyImmediately: false }) }).then(x => x.ok).catch(() => false)
      await fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaignId}/cpc-ceiling`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: ceilOn, multiple: ceilMult }) }).catch(() => {})
      setMsg(ok ? `Staged ${STRAT_LABEL[strat]} strategy${ceilOn ? ` + ${ceilMult}× CPC ceiling` : ''} — open the write-gate to apply.` : 'Could not stage the strategy.')
      onChanged()
    } catch { setMsg('Could not stage the strategy.') }
    setBusy(false)
  }, [campaignId, strat, ceilOn, ceilMult, onChanged])

  return (
    <div className="az-station">
      <button type="button" className="az-station-head" onClick={() => setOpen(v => !v)} aria-expanded={open}>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />} <Sliders size={15} /> <b>Strategy &amp; cost</b>
        <span className="sub">how Amazon adjusts your bids{currentStrategy ? ` · now ${STRAT_LABEL[currentStrategy] ?? currentStrategy}` : ''}</span>
      </button>
      {open && (
        <div className="az-station-body">
          <div className="az-strat-row">
            <span className="lbl">Bidding</span>
            {STRATS.map(s => <button key={s.k} type="button" title={s.hint} className={`az-strat-btn ${strat === s.k ? 'on' : ''}`} onClick={() => setStrat(s.k)}>{s.label}</button>)}
          </div>
          <div className="az-cockpit-sub" style={{ marginTop: 4 }}>{STRATS.find(s => s.k === strat)?.hint}</div>
          <label className="az-strat-ceil"><input type="checkbox" checked={ceilOn} onChange={e => setCeilOn(e.target.checked)} /> Cap effective CPC at <input type="number" min={1} max={10} step={0.1} value={ceilMult} disabled={!ceilOn} onChange={e => setCeilMult(Math.max(1, Math.min(10, Number(e.target.value))))} />× the keyword&apos;s historical CPC</label>
          <div className="az-sched-actions">
            <button type="button" className="az-btn dark" disabled={busy} onClick={() => void apply()}>{busy ? <><Loader2 size={14} className="az-spin" /> Staging…</> : <><Check size={14} /> Stage strategy</>}</button>
            {msg && <span className="az-cockpit-sub" style={{ margin: 0 }}>{msg}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
