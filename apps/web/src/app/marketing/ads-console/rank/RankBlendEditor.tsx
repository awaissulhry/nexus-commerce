'use client'

/**
 * BL — blended-target editor. Turns one RankTarget into a strategy that drives Top of
 * Search + Rest of Search + Product pages SIMULTANEOUSLY (each its own bias / ceiling /
 * target-IS), plus a base-bid lever the placement multipliers stack on. Empty (no lanes
 * enabled) = the target stays single-placement (legacy). Shown in Global defaults view —
 * a blend is a library-level strategy. Effective-bid preview (BL.5) is inline per lane.
 */
import { useState } from 'react'
import { Save, Layers } from 'lucide-react'

export interface BlendLane {
  placement: string
  biasPct: number | null
  maxBiasPct?: number | null
  targetISPct?: number | null
  acosCapPct?: number | null
  keepClimbing?: boolean
}

const LANES: { placement: string; label: string; signal: string; chase: boolean; acos: boolean; def: number }[] = [
  { placement: 'PLACEMENT_TOP', label: 'Top of Search', signal: 'Amazon Top-IS (closed-loop)', chase: true, acos: true, def: 100 },
  { placement: 'PLACEMENT_REST_OF_SEARCH', label: 'Rest of Search', signal: 'SQP brand share (approx)', chase: true, acos: false, def: 50 },
  { placement: 'PLACEMENT_PRODUCT_PAGE', label: 'Product pages', signal: 'open-loop (set & hold)', chase: false, acos: false, def: 30 },
]

export function RankBlendEditor({ target, busy, onSave, onClose }: {
  target: { id: string; name: string; lanes?: BlendLane[] | null; bidMode?: string | null; bidValueCents?: number | null; bidDeltaPct?: number | null }
  busy: boolean
  onSave: (patch: { lanes: BlendLane[]; bidMode: string | null; bidValueCents: number | null; bidDeltaPct: number | null }) => void
  onClose: () => void
}) {
  const seed = new Map((target.lanes ?? []).map((l) => [l.placement, l]))
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => Object.fromEntries(LANES.map((l) => [l.placement, seed.has(l.placement)])))
  const [vals, setVals] = useState<Record<string, BlendLane>>(() =>
    Object.fromEntries(LANES.map((l) => [l.placement, seed.get(l.placement) ?? { placement: l.placement, biasPct: null }])),
  )
  const [bidMode, setBidMode] = useState<string>(target.bidMode ?? 'hold')
  const [bidValueCents, setBidValueCents] = useState<number | null>(target.bidValueCents ?? null)
  const [bidDeltaPct, setBidDeltaPct] = useState<number | null>(target.bidDeltaPct ?? null)

  const num = (raw: string) => (raw === '' ? null : Math.max(0, Math.min(900, Math.round(Number(raw)))))
  const setLaneField = (p: string, f: keyof BlendLane, raw: string) => setVals((v) => ({ ...v, [p]: { ...v[p], [f]: num(raw) } }))
  const toggle = (p: string, on: boolean, def: number) => {
    setEnabled((s) => ({ ...s, [p]: on }))
    if (on) setVals((v) => (v[p]?.biasPct == null ? { ...v, [p]: { ...v[p], placement: p, biasPct: def } } : v)) // seed a sane default
  }

  const baseEur = bidMode === 'absolute' && bidValueCents != null ? bidValueCents / 100 : null
  const eff = (biasPct: number | null): string => {
    const b = biasPct ?? 0
    if (baseEur != null) return `€${(baseEur * (1 + b / 100)).toFixed(2)}`
    return `×${(1 + b / 100).toFixed(2)} base`
  }
  const enabledCount = LANES.filter((l) => enabled[l.placement]).length

  const save = () => {
    const lanes: BlendLane[] = LANES.filter((l) => enabled[l.placement]).map((l) => {
      const v = vals[l.placement] || { placement: l.placement, biasPct: l.def }
      return {
        placement: l.placement,
        biasPct: v.biasPct ?? 0,
        maxBiasPct: v.maxBiasPct ?? null,
        targetISPct: l.chase ? (v.targetISPct ?? null) : null,
        acosCapPct: l.acos ? (v.acosCapPct ?? null) : null,
        keepClimbing: !!v.keepClimbing,
      }
    })
    onSave({ lanes, bidMode, bidValueCents: bidMode === 'absolute' ? bidValueCents : null, bidDeltaPct: bidMode === 'deltaPct' ? bidDeltaPct : null })
  }

  return (
    <div className="az-rte-motion az-rte-blend">
      <div className="az-mtitle"><Layers size={12} /> Blend — run Top + Rest of Search + Product pages in the SAME window</div>
      <div className="az-msub">Toggle a placement to drive it. Each gets its own bias + ceiling + signal; the base bid (below) is what these % stack on. No lanes enabled = the target stays single-placement.</div>
      {LANES.map((l) => {
        const on = !!enabled[l.placement]
        const v = vals[l.placement] || { placement: l.placement, biasPct: null }
        return (
          <div key={l.placement} className={`az-blend-lane ${on ? 'on' : ''}`}>
            <label className="az-blend-en"><input type="checkbox" checked={on} onChange={(e) => toggle(l.placement, e.target.checked, l.def)} /> <b>{l.label}</b></label>
            <span className="az-blend-sig" title="The closed-loop feedback signal available for this placement">{l.signal}</span>
            {on && (
              <span className="az-blend-fields">
                <label className="az-mfield" title="Placement bid multiplier 0–900%"><span>Bias %</span><input type="number" min={0} max={900} value={v.biasPct ?? ''} onChange={(e) => setLaneField(l.placement, 'biasPct', e.target.value)} /></label>
                <label className="az-mfield" title="Blank = hold the bias. Set above it to let this lane climb toward the ceiling."><span>Ceiling %</span><input type="number" min={0} max={900} value={v.maxBiasPct ?? ''} placeholder="hold" onChange={(e) => setLaneField(l.placement, 'maxBiasPct', e.target.value)} /></label>
                {l.chase
                  ? <label className="az-mfield" title={l.placement === 'PLACEMENT_TOP' ? 'Top-of-Search impression share to chase (when a ceiling is set)' : 'SQP brand impression share to chase (approximate)'}><span>Target {l.placement === 'PLACEMENT_TOP' ? 'IS' : 'SQP'} %</span><input type="number" min={0} max={100} value={v.targetISPct ?? ''} placeholder="—" onChange={(e) => setLaneField(l.placement, 'targetISPct', e.target.value)} /></label>
                  : <span className="az-mfield az-rte-na" title="Amazon exposes no impression share for Product pages — this lane is set-and-hold (open-loop)">open-loop</span>}
                {l.acos && <label className="az-mfield" title="Ease off above this ACOS while climbing (Top only — Amazon exposes no ACOS for Rest/Product)"><span>ACOS cap %</span><input type="number" min={0} value={v.acosCapPct ?? ''} placeholder="—" onChange={(e) => setLaneField(l.placement, 'acosCapPct', e.target.value)} /></label>}
                <span className="az-blend-eff" title="Effective bid for this placement = base bid × (1 + bias%)">eff {eff(v.biasPct)}</span>
              </span>
            )}
          </div>
        )
      })}
      <div className="az-blend-base">
        <span className="az-blend-baselbl">Base bid</span>
        <select value={bidMode} onChange={(e) => setBidMode(e.target.value)}>
          <option value="hold">Hold — don&apos;t touch</option>
          <option value="absolute">Set to €…</option>
          <option value="deltaPct">Adjust ±%…</option>
          <option value="suppress">Suppress to ~€0.02</option>
        </select>
        {bidMode === 'absolute' && (
          <input type="number" step="0.01" min={0.02} placeholder="0.50" value={bidValueCents != null ? (bidValueCents / 100).toFixed(2) : ''} onChange={(e) => setBidValueCents(e.target.value === '' ? null : Math.round(Number(e.target.value) * 100))} />
        )}
        {bidMode === 'deltaPct' && (
          <label className="az-blend-delta" title="Scale every keyword + ad-group bid by this % from its stable baseline (−95…+300). Reverts to baseline when the window ends — never compounds.">
            <input type="number" step="5" min={-95} max={300} placeholder="+15" value={bidDeltaPct ?? ''} onChange={(e) => setBidDeltaPct(e.target.value === '' ? null : Math.max(-95, Math.min(300, Math.round(Number(e.target.value)))))} /> %
          </label>
        )}
        <span className="az-mnote">{bidMode === 'deltaPct'
          ? 'Adjust scales every keyword + ad-group bid ±% from its stable baseline (preserves your per-keyword tuning) and reverts when the window ends — never compounds.'
          : 'Absolute sets the ad-group default bid; the placement % above stack on it (preview updates live).'}</span>
      </div>
      <div className="az-mrecipes" style={{ justifyContent: 'flex-end', gap: 6 }}>
        <span className="grow" style={{ fontSize: 10, color: 'var(--muted)' }}>{enabledCount === 0 ? 'No lanes → single-placement (legacy)' : `${enabledCount} placement${enabledCount > 1 ? 's' : ''} driven at once`}</span>
        <button type="button" className="az-btn sm" onClick={onClose}>Cancel</button>
        <button type="button" className="az-btn dark sm" disabled={busy} onClick={save}><Save size={12} /> {busy ? 'Saving…' : 'Save blend'}</button>
      </div>
    </div>
  )
}
