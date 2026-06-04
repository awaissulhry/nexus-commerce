'use client'

/**
 * RC4.11 — Bulk apply station. Absorbs the old advanced-form / strategy mode's
 * multi-campaign reach: pick many campaigns in the market and set a Top-of-search
 * push (preset) + optional bidding strategy on all at once. Placement writes are
 * gated (local config until the write-gate opens); strategy writes stage in the
 * tray. Per-campaign fine-tuning still lives in the cockpit above.
 */

import { useCallback, useState } from 'react'
import { Layers, Loader2, Check, ChevronDown, ChevronRight } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Camp { id: string; name: string }
const PRESETS = [
  { k: 'off', label: 'Off', top: 0 },
  { k: 'defend', label: 'Defend', top: 50 },
  { k: 'aggressive', label: 'Aggressive', top: 150 },
  { k: 'dominate', label: 'Dominate', top: 300 },
  { k: 'max', label: 'Max', top: 900 },
]
const STRATS = [['', 'Leave as-is'], ['AUTO_FOR_SALES', 'Up & down'], ['LEGACY_FOR_SALES', 'Down only'], ['MANUAL', 'Fixed']] as const

export function BulkApplyStation({ campaigns, market, onChanged }: { campaigns: Camp[]; market: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [preset, setPreset] = useState('defend')
  const [strat, setStrat] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const allSel = campaigns.length > 0 && campaigns.every(c => sel.has(c.id))
  const top = PRESETS.find(p => p.k === preset)?.top ?? 0

  const apply = useCallback(async () => {
    const ids = campaigns.filter(c => sel.has(c.id)).map(c => c.id)
    if (!ids.length) return
    setBusy(true); setMsg('')
    let ok = 0
    for (const id of ids) {
      try {
        await fetch(`${getBackendUrl()}/api/advertising/campaigns/${id}/placements`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adjustments: [{ placement: 'PLACEMENT_TOP', percentage: top }, { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 0 }, { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 0 }] }) })
        if (strat) await fetch(`${getBackendUrl()}/api/advertising/campaigns/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ biddingStrategy: strat, reason: 'Rank Control bulk (RC4.11)', applyImmediately: false }) })
        ok += 1
      } catch { /* continue */ }
    }
    setMsg(`Staged Top +${top}%${strat ? ` + ${STRATS.find(s => s[0] === strat)?.[1]}` : ''} on ${ok}/${ids.length} campaign${ids.length === 1 ? '' : 's'} — open the write-gate to push.`)
    onChanged(); setBusy(false)
  }, [campaigns, sel, top, strat, onChanged])

  return (
    <div className="az-station">
      <button type="button" className="az-station-head" onClick={() => setOpen(v => !v)} aria-expanded={open}>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />} <Layers size={15} /> <b>Apply across campaigns</b>
        <span className="sub">set a Top-of-search push + strategy on many campaigns at once · {market}</span>
      </button>
      {open && (
        <div className="az-station-body">
          <div className="az-bulk-camps">
            <label className="all"><input type="checkbox" checked={allSel} onChange={e => setSel(e.target.checked ? new Set(campaigns.map(c => c.id)) : new Set())} /> All {campaigns.length} in {market}</label>
            <div className="list">
              {campaigns.length === 0 ? <span className="az-cockpit-sub">No campaigns in {market}.</span> : campaigns.map(c => <label key={c.id}><input type="checkbox" checked={sel.has(c.id)} onChange={() => setSel(x => { const n = new Set(x); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n })} /> <span>{c.name}</span></label>)}
            </div>
          </div>
          <div className="az-bulk-row"><span className="lbl">Top-of-search</span>{PRESETS.map(p => <button key={p.k} type="button" aria-pressed={preset === p.k} className={`az-strat-btn ${preset === p.k ? 'on' : ''}`} onClick={() => setPreset(p.k)}>{p.label}{p.top ? ` +${p.top}%` : ''}</button>)}</div>
          <div className="az-bulk-row"><span className="lbl">Strategy</span><select value={strat} onChange={e => setStrat(e.target.value)}>{STRATS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
          <div className="az-sched-actions">
            <button type="button" className="az-btn dark" disabled={busy || sel.size === 0} onClick={() => void apply()}>{busy ? <><Loader2 size={14} className="az-spin" /> …</> : <><Check size={14} /> Stage to {sel.size || ''} campaign{sel.size === 1 ? '' : 's'}</>}</button>
            {msg && <span className="az-cockpit-sub" style={{ margin: 0 }} role="status" aria-live="polite">{msg}</span>}
          </div>
          <div className="az-cockpit-note">Sets the Top-of-search bias (other placements → 0) + optional strategy on every selected campaign. Per-campaign fine-tuning stays in the cockpit above.</div>
        </div>
      )}
    </div>
  )
}
