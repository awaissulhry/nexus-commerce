'use client'

/**
 * BL — blended-target editor. Turns one RankTarget into a strategy that sets Top of
 * Search + Rest of Search + Product pages SIMULTANEOUSLY (each its own Placement %), plus a
 * base-bid lever the placement multipliers stack on. Empty (no lanes enabled) = the target
 * stays single-placement (legacy). Effective-bid preview (BL.5) is inline per lane.
 *
 * 2e (Owner D1 = A) — each lane holds a FIXED Placement % for the hours the target covers. The
 * engine reads no impression share or ACoS and never climbs, so the lane ceiling, target IS/SQP
 * and ACOS cap inputs are gone; saving a lane stores only its placement and %.
 */
import { useState } from 'react'
import { Save, Layers } from 'lucide-react'
import { Button, Checkbox, Input, Select } from '@/design-system/primitives'

export interface BlendLane {
  placement: string
  biasPct: number | null
  // Stored by blends saved before 2e; not read by the engine and not shown.
  maxBiasPct?: number | null
  targetISPct?: number | null
  acosCapPct?: number | null
  keepClimbing?: boolean
}

const LANES: { placement: string; label: string; def: number }[] = [
  { placement: 'PLACEMENT_TOP', label: 'Top of Search', def: 100 },
  { placement: 'PLACEMENT_REST_OF_SEARCH', label: 'Rest of Search', def: 50 },
  { placement: 'PLACEMENT_PRODUCT_PAGE', label: 'Product pages', def: 30 },
]

export function RankBlendEditor({ target, busy, scopeNote, onSave, onClose }: {
  target: { id: string; name: string; lanes?: BlendLane[] | null; bidMode?: string | null; bidValueCents?: number | null; bidDeltaPct?: number | null }
  busy: boolean
  scopeNote?: string // BL.9 — when set, this blend is specific to that product/campaign scope
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
      return { placement: l.placement, biasPct: v.biasPct ?? 0 }
    })
    onSave({ lanes, bidMode, bidValueCents: bidMode === 'absolute' ? bidValueCents : null, bidDeltaPct: bidMode === 'deltaPct' ? bidDeltaPct : null })
  }

  return (
    <div className="h10-rte-motion h10-rte-blend">
      <div className="h10-mtitle"><Layers size={12} /> Blend — run Top + Rest of Search + Product pages in the SAME window{scopeNote ? <span style={{ color: '#7c3aed', fontWeight: 700 }}> · for {scopeNote}</span> : ''}</div>
      <div className="h10-msub">Toggle a placement to set it. Each holds its own Placement % in every hour this target covers; the base bid (below) is what these % stack on. No lanes enabled = {scopeNote ? `${scopeNote} uses single-placement` : 'the target stays single-placement'}.</div>
      {LANES.map((l) => {
        const on = !!enabled[l.placement]
        const v = vals[l.placement] || { placement: l.placement, biasPct: null }
        return (
          <div key={l.placement} className={`h10-blend-lane ${on ? 'on' : ''}`}>
            <Checkbox className="h10-blend-en" checked={on} onChange={(e) => toggle(l.placement, e.target.checked, l.def)} label={<b>{l.label}</b>} />
            {on && (
              <span className="h10-blend-fields">
                <label className="h10-mfield" title="The placement multiplier 0–900% this lane holds in every hour the target covers"><span>Placement %</span><Input size="xs" type="number" min={0} max={900} value={v.biasPct ?? ''} onChange={(e) => setLaneField(l.placement, 'biasPct', e.target.value)} /></label>
                <span className="h10-blend-eff" title="Effective bid for this placement = base bid × (1 + Placement %)">eff {eff(v.biasPct)}</span>
              </span>
            )}
          </div>
        )
      })}
      <div className="h10-blend-base">
        <span className="h10-blend-baselbl">Base bid</span>
        <Select size="xs" value={bidMode} onChange={(e) => setBidMode(e.target.value)}>
          <option value="hold">Hold — don&apos;t touch</option>
          <option value="absolute">Set to €…</option>
          <option value="deltaPct">Adjust ±%…</option>
          <option value="suppress">Suppress to ~€0.02</option>
        </Select>
        {bidMode === 'absolute' && (
          <Input size="xs" type="number" step="0.01" min={0.02} placeholder="0.50" fieldClassName="h10-blend-num" value={bidValueCents != null ? (bidValueCents / 100).toFixed(2) : ''} onChange={(e) => setBidValueCents(e.target.value === '' ? null : Math.round(Number(e.target.value) * 100))} />
        )}
        {bidMode === 'deltaPct' && (
          <label className="h10-blend-delta" title="Scale every keyword + ad-group bid by this % from its stable baseline (−95…+300). Reverts to baseline when the window ends — never compounds.">
            <Input size="xs" fieldClassName="h10-blend-deltain" type="number" step="5" min={-95} max={300} placeholder="+15" value={bidDeltaPct ?? ''} onChange={(e) => setBidDeltaPct(e.target.value === '' ? null : Math.max(-95, Math.min(300, Math.round(Number(e.target.value)))))} /> %
          </label>
        )}
        <span className="h10-mnote">{bidMode === 'deltaPct'
          ? 'Adjust scales every keyword + ad-group bid ±% from its stable baseline (preserves your per-keyword tuning) and reverts when the window ends — never compounds.'
          : 'Absolute sets the ad-group default bid; the placement % above stack on it (preview updates live).'}</span>
      </div>
      <div className="h10-mrecipes" style={{ justifyContent: 'flex-end', gap: 6 }}>
        <span className="grow" style={{ fontSize: 10, color: '#8a93a1' }}>{enabledCount === 0 ? 'No lanes → single-placement (legacy)' : `${enabledCount} placement${enabledCount > 1 ? 's' : ''} driven at once`}</span>
    <Button size="sm" onClick={onClose}>Cancel</Button>
    <Button variant="primary" size="sm" disabled={busy} onClick={save}><Save size={12} /> {busy ? 'Saving…' : 'Save blend'}</Button>
      </div>
    </div>
  )
}
