'use client'

/**
 * RTC — Rank-target customizer. A modal to inspect + change what each paint swatch
 * actually does (Top-of-Search %, target IS%, ACOS cap, max CPC), add your own custom
 * swatches, and do it at the right SCOPE:
 *   • Scope view ("This product" / "This campaign") edits an OVERRIDE layer stored on
 *     the plan/schedule — affects only here. Empty field = inherit the global default.
 *   • Global view edits the shared library default (affects everywhere); built-ins can
 *     be Reset, customs deleted.
 * Custom swatches can be Global (everywhere) or Scope-only (just this product/campaign).
 * Effective at runtime = global ⊕ product ⊕ campaign (the engine merges; RTC.2).
 */

import { Fragment, useCallback, useEffect, useState } from 'react'
import { Save, Plus, Trash2, RotateCcw, Info, SlidersHorizontal } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface RankTarget { id: string; key: string; name: string; placement: string; targetISPct: number | null; acosCapPct: number | null; maxCpcCents: number | null; biasPct: number | null; pause: boolean; allOut: boolean; color: string | null; builtIn: boolean; scopeProductId: string | null; scopeCampaignId: string | null; jumpStartPct: number | null; stepUpPct: number | null; stepDownPct: number | null; maxBiasPct: number | null; keepClimbing: boolean }
type OvField = 'biasPct' | 'targetISPct' | 'acosCapPct' | 'maxCpcCents' | 'jumpStartPct' | 'stepUpPct' | 'stepDownPct' | 'maxBiasPct'
type Ov = Partial<Record<OvField, number>> & { keepClimbing?: boolean }
type OvMap = Record<string, Ov>
const api = (p: string) => `${getBackendUrl()}/api/advertising${p}`
const PLACE_LABEL: Record<string, string> = { PLACEMENT_TOP: 'Top of Search', PLACEMENT_REST_OF_SEARCH: 'Rest of Search', PLACEMENT_PRODUCT_PAGE: 'Product pages' }
const placeLabel = (p: string) => PLACE_LABEL[p] ?? p
const FIELDS: { f: OvField; label: string; unit: '%' | '€'; hint: string }[] = [
  { f: 'biasPct', label: 'Placement', unit: '%', hint: "bid multiplier 0–900% for THIS target's placement (Top or Rest of Search)" },
  { f: 'targetISPct', label: 'Target IS', unit: '%', hint: 'Impression share to chase when a Ceiling above Placement % is set. Top of Search uses Amazon Top-IS; Rest of Search uses SQP brand impression share.' },
  { f: 'acosCapPct', label: 'ACOS cap', unit: '%', hint: 'Ease off above this ACOS while climbing — only used when a Ceiling above Placement % is set.' },
  { f: 'maxCpcCents', label: 'Max CPC', unit: '€', hint: 'never bid above this' },
]
// MP v2 — motion profile: HOW the loop moves the bid. Blank everywhere = snap to Placement %
// both ways and hold (the bid you set is the bid you get).
const MOTION_FIELDS: { f: OvField; label: string; hint: string }[] = [
  { f: 'stepUpPct', label: 'Climb step', hint: 'Blank = SNAP up to Placement %. A number = ramp up +N%/cycle instead.' },
  { f: 'stepDownPct', label: 'Ease step', hint: 'Blank = SNAP down to Placement %. A number = ease down −N%/cycle instead. (The opposite of Climb step.)' },
  { f: 'maxBiasPct', label: 'Ceiling', hint: 'Blank = hold at Placement %, never above. Set ABOVE Placement % to let the bid climb up to here.' },
]
// MP v2 — one-click recipes that fill the knobs + keep-climbing. null = leave that knob blank.
type Motion = { stepUpPct: number | null; stepDownPct: number | null; maxBiasPct: number | null; keepClimbing: boolean }
const RECIPES: { id: string; label: string; hint: string; m: Motion }[] = [
  { id: 'hold', label: 'Hold', hint: 'Snap to Placement % and hold — the bid you set is the bid you get. (The default.)', m: { stepUpPct: null, stepDownPct: null, maxBiasPct: null, keepClimbing: false } },
  { id: 'gradual', label: 'Gradual', hint: 'Ramp ±15%/cycle to Placement % instead of snapping; still never above it.', m: { stepUpPct: 15, stepDownPct: 15, maxBiasPct: null, keepClimbing: false } },
  { id: 'chase', label: 'Chase', hint: 'Hold Placement %, but climb up to 300% when Amazon says you are winning (signal-driven), then ease back.', m: { stepUpPct: 15, stepDownPct: 15, maxBiasPct: 300, keepClimbing: false } },
  { id: 'push', label: 'Push', hint: 'Always climb to a 300% ceiling on its own (no signal needed), within the ACOS cap.', m: { stepUpPct: 25, stepDownPct: null, maxBiasPct: 300, keepClimbing: true } },
]

export function RankTargetEditor({ open, onClose, scopeKind, scopeLabel, scopeOverrides, onSaveScopeOverrides, productId, campaignId }: {
  open: boolean
  onClose: (changed: boolean) => void
  scopeKind: 'product' | 'campaign'
  scopeLabel: string
  scopeOverrides: OvMap
  onSaveScopeOverrides?: (map: OvMap) => Promise<void>
  productId?: string
  campaignId?: string
}) {
  const [view, setView] = useState<'scope' | 'global'>('scope')
  const [targets, setTargets] = useState<RankTarget[]>([])
  const [ov, setOv] = useState<OvMap>({})
  const [lib, setLib] = useState<Record<string, Partial<RankTarget>>>({}) // global-view drafts
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [changed, setChanged] = useState(false)
  const [adding, setAdding] = useState(false)
  const [motionOpen, setMotionOpen] = useState<Record<string, boolean>>({}) // per-target Motion drawer
  const [form, setForm] = useState<{ name: string; color: string; scope: 'global' | 'scope' } & Ov>({ name: '', color: '#3aa873', scope: scopeKind === 'campaign' ? 'scope' : 'scope' })

  const load = useCallback(() => {
    const qs = new URLSearchParams()
    if (productId) qs.set('productId', productId)
    if (campaignId) qs.set('campaignId', campaignId)
    fetch(api(`/rank-targets?${qs.toString()}`), { cache: 'no-store' }).then(r => r.json()).then(j => setTargets(j.items || [])).catch(() => {})
  }, [productId, campaignId])
  // Init ONLY when the modal opens (or its scope/product changes). scopeOverrides is a
  // fresh `{}` and onSaveScopeOverrides a fresh fn on every parent render — keeping them
  // in deps would re-run this on each parent re-render and wipe the operator's in-modal
  // edits. They're read here at open-time (and onSave is read live in save()).
  useEffect(() => { if (open) { load(); setOv({ ...(scopeOverrides || {}) }); setLib({}); setView(onSaveScopeOverrides ? 'scope' : 'global'); setMsg(''); setChanged(false); setAdding(false) } }, [open, load]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null

  const eur = (c: number | null | undefined) => (c == null ? '' : (c / 100).toFixed(2))
  const defOf = (t: RankTarget, f: OvField): number | null => (lib[t.id]?.[f] as number | null | undefined) ?? (t[f] as number | null)
  const effOf = (t: RankTarget, f: OvField): number | null => (view === 'scope' && ov[t.key]?.[f] != null ? ov[t.key]![f]! : defOf(t, f))
  const describe = (t: RankTarget): string => {
    if (t.pause) return 'Floors bids to ~€0.02 (campaign stays live, restorable) — never pauses'
    const p: string[] = []
    const isTop = t.placement === 'PLACEMENT_TOP'
    const b = effOf(t, 'biasPct'); if (b != null) p.push(`${placeLabel(t.placement)} +${b}%`)
    const ceil = effOf(t, 'maxBiasPct')
    // MP v2 — IS / ACOS only act when the bid is ALLOWED above Placement % (a Ceiling above it,
    // or all-out). Without a Ceiling the loop just snaps to Placement %, so don't advertise them.
    const canChase = t.allOut || (ceil != null && ceil > (b ?? 0))
    const is = effOf(t, 'targetISPct'); if (is != null && canChase) p.push(`hold ${is}% ${isTop ? 'IS' : 'SQP'}`)
    const a = effOf(t, 'acosCapPct'); if (a != null && isTop && canChase) p.push(`ease above ${a}% ACOS`)
    const c = effOf(t, 'maxCpcCents'); if (c != null) p.push(`max CPC €${(c / 100).toFixed(2)}`)
    if (t.allOut) p.push('all-out (ignore ACOS)')
    // MP v2 — motion summary (only the parts tuned away from snap-and-hold, to avoid clutter).
    const motion: string[] = []
    const up = effOf(t, 'stepUpPct'); if (up != null) motion.push(`ramp +${up}↑`)
    const down = effOf(t, 'stepDownPct'); if (down != null) motion.push(`ease −${down}↓`)
    if (ceil != null && ceil > (b ?? 0)) motion.push(effKeep(t) ? `push→${ceil}%` : `chase→${ceil}%`)
    else if (effKeep(t)) motion.push('keep-climbing')
    if (motion.length) p.push(motion.join(' '))
    return p.join(' · ') || 'baseline (no push)'
  }
  const hasOverride = (t: RankTarget) => !!ov[t.key] && Object.keys(ov[t.key]).length > 0
  // MP — effective keepClimbing (scope override wins → global draft → saved value).
  const effKeep = (t: RankTarget): boolean => {
    if (view === 'scope' && ov[t.key]?.keepClimbing !== undefined) return !!ov[t.key]!.keepClimbing
    if (lib[t.id]?.keepClimbing !== undefined) return !!lib[t.id]!.keepClimbing
    return !!t.keepClimbing
  }
  const setLibKeep = (id: string, checked: boolean) => { setChanged(true); setLib(m => ({ ...m, [id]: { ...(m[id] || {}), keepClimbing: checked } })) }
  // MP v2 — apply a recipe to the knobs + keep-climbing, in whichever view is active.
  const applyRecipe = (t: RankTarget, m: Motion) => {
    setChanged(true)
    const num: OvField[] = ['stepUpPct', 'stepDownPct', 'maxBiasPct']
    if (view === 'scope') {
      setOv(prev => {
        const next = { ...prev }; const cur = { ...(next[t.key] || {}) }
        for (const f of num) { if (m[f as keyof Motion] == null) delete cur[f]; else cur[f] = m[f as keyof Motion] as number }
        cur.keepClimbing = m.keepClimbing // a recipe makes an explicit choice at this scope
        next[t.key] = cur; return next
      })
    } else {
      setLib(prev => ({ ...prev, [t.id]: { ...(prev[t.id] || {}), stepUpPct: m.stepUpPct, stepDownPct: m.stepDownPct, maxBiasPct: m.maxBiasPct, keepClimbing: m.keepClimbing } }))
    }
  }
  const setScopeKeep = (key: string, val: '' | 'on' | 'off') => {
    setChanged(true)
    setOv(m => {
      const next = { ...m }; const cur = { ...(next[key] || {}) }
      if (val === '') delete cur.keepClimbing; else cur.keepClimbing = val === 'on'
      if (Object.keys(cur).length) next[key] = cur; else delete next[key]
      return next
    })
  }

  // scope-view: edit the override map (empty = inherit)
  const setScope = (key: string, f: OvField, raw: string) => {
    setChanged(true)
    setOv(m => {
      const next = { ...m }; const cur = { ...(next[key] || {}) }
      if (raw === '') delete cur[f]
      else cur[f] = f === 'maxCpcCents' ? Math.round(Number(raw) * 100) : Math.round(Number(raw))
      if (Object.keys(cur).length) next[key] = cur; else delete next[key]
      return next
    })
  }
  const clearOverride = (key: string) => { setChanged(true); setOv(m => { const n = { ...m }; delete n[key]; return n }) }
  // global-view: edit the library draft (saved via PATCH)
  const setLibField = (id: string, f: keyof RankTarget, raw: string | number) => {
    setChanged(true)
    setLib(m => ({ ...m, [id]: { ...(m[id] || {}), [f]: raw === '' ? null : (f === 'maxCpcCents' ? Math.round(Number(raw) * 100) : (f === 'name' || f === 'color' ? raw : Math.round(Number(raw)))) } }))
  }

  const save = async () => {
    setBusy(true); setMsg('')
    try {
      if (view === 'scope') { if (onSaveScopeOverrides) { await onSaveScopeOverrides(ov); setMsg(`Saved overrides for ${scopeLabel}.`) } }
      else {
        for (const [id, patch] of Object.entries(lib)) { if (Object.keys(patch).length) await fetch(api(`/rank-targets/${id}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }) }
        setLib({}); setMsg('Saved global defaults.'); load()
      }
      setChanged(false)
    } catch { setMsg('Save failed — try again.') } finally { setBusy(false) }
  }
  const resetTarget = async (id: string) => { setBusy(true); try { await fetch(api(`/rank-targets/${id}/reset`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); setChanged(true); setLib(m => { const n = { ...m }; delete n[id]; return n }); load() } finally { setBusy(false) } }
  const deleteTarget = async (id: string, name: string) => { if (typeof window !== 'undefined' && !window.confirm(`Delete custom target "${name}"? Windows using it fall back to baseline.`)) return; setBusy(true); try { await fetch(api(`/rank-targets/${id}`), { method: 'DELETE' }); setChanged(true); load() } finally { setBusy(false) } }
  const addCustom = async () => {
    if (!form.name.trim()) { setMsg('Name required.'); return }
    setBusy(true); setMsg('')
    try {
      const body: Record<string, unknown> = { name: form.name.trim(), color: form.color, biasPct: form.biasPct ?? null, targetISPct: form.targetISPct ?? null, acosCapPct: form.acosCapPct ?? null, maxCpcCents: form.maxCpcCents ?? null }
      if (form.scope === 'scope') { if (scopeKind === 'product' && productId) body.scopeProductId = productId; if (scopeKind === 'campaign' && campaignId) body.scopeCampaignId = campaignId }
      await fetch(api('/rank-targets'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      setChanged(true); setAdding(false); setForm({ name: '', color: '#3aa873', scope: 'scope' }); load()
    } catch { setMsg('Could not add target.') } finally { setBusy(false) }
  }

  const scopeAvailable = !!onSaveScopeOverrides
  return (
    <div className="az-rd-copymodal" role="dialog" aria-modal="true" aria-label="Edit rank targets" onClick={() => onClose(changed)}>
      <div className="box az-rte" onClick={e => e.stopPropagation()} style={{ width: 'min(680px, 95vw)' }}>
        <div className="hd">Rank targets — what each paint colour does<span className="grow" /><button type="button" className="az-kebab" onClick={() => onClose(changed)} aria-label="Close">✕</button></div>
        <div className="az-rte-scope">
          <span className="az-mode-seg az-scope-seg" role="tablist" style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
            <button type="button" role="tab" aria-selected={view === 'scope'} className={view === 'scope' ? 'on' : ''} disabled={!scopeAvailable} onClick={() => setView('scope')} title={scopeAvailable ? '' : `Save the ${scopeKind} first to set overrides here`}>{scopeKind === 'product' ? 'This product' : 'This campaign'}</button>
            <button type="button" role="tab" aria-selected={view === 'global'} className={view === 'global' ? 'on' : ''} onClick={() => setView('global')}>Global defaults</button>
          </span>
          <span className="az-rte-scopehint"><Info size={12} /> {view === 'scope' ? `Overrides apply only to ${scopeLabel}. Empty = use the global default.` : 'Editing the shared default — changes every product & campaign.'}</span>
        </div>
        <div className="list az-rte-list">
          <div className="az-rte-row az-rte-head"><span className="nm">Target</span>{FIELDS.map(f => <span key={f.f} className="fld" title={f.hint}>{f.label} {f.unit === '€' ? '€' : '%'}</span>)}<span className="act" /></div>
          {targets.map(t => {
            const scoped = !!t.scopeProductId || !!t.scopeCampaignId
            const mOpen = !!motionOpen[t.id]
            return (
              <Fragment key={t.id}>
              <div className={`az-rte-row ${view === 'scope' && hasOverride(t) ? 'ovr' : ''}`}>
                <span className="nm">
                  <i className="sw" style={{ background: t.color ?? '#999' }} />
                  {view === 'global' && !t.pause ? <input className="az-rte-name" value={(lib[t.id]?.name as string) ?? t.name} onChange={e => setLibField(t.id, 'name', e.target.value)} /> : <b>{t.name}</b>}
                  <span className="bdg">{t.builtIn ? 'default' : scoped ? 'scoped' : 'custom'}</span>
                  {!t.pause && <span className="bdg" style={{ background: '#eef2ff', color: '#3730a3' }}>{placeLabel(t.placement)}</span>}
                  {view === 'scope' && hasOverride(t) && <span className="bdg ov">override</span>}
                  <span className="desc">{describe(t)}</span>
                </span>
                {FIELDS.map(f => {
                  if (t.pause || (t.allOut && f.f === 'acosCapPct')) return <span key={f.f} className="fld">—</span>
                  // RM2 — Target IS is now fed by SQP brand impression share for Rest of Search, so
                  // it's editable for non-Top too; only ACOS stays n/a (Amazon exposes no Rest ACOS).
                  if (f.f === 'acosCapPct' && t.placement !== 'PLACEMENT_TOP')
                    return <span key={f.f} className="fld az-rte-na" title="Top of Search only — Amazon exposes no ACOS for Rest/Product placements">n/a</span>
                  if (view === 'scope') {
                    const v = ov[t.key]?.[f.f]
                    const ph = defOf(t, f.f)
                    return <span key={f.f} className="fld"><input type="number" disabled={!scopeAvailable} value={v == null ? '' : f.f === 'maxCpcCents' ? eur(v) : v} placeholder={ph == null ? '—' : f.f === 'maxCpcCents' ? eur(ph) : String(ph)} onChange={e => setScope(t.key, f.f, e.target.value)} step={f.f === 'maxCpcCents' ? '0.01' : '1'} /></span>
                  }
                  const lv = (lib[t.id]?.[f.f] as number | null | undefined)
                  const val = lv !== undefined ? lv : (t[f.f] as number | null)
                  return <span key={f.f} className="fld"><input type="number" value={val == null ? '' : f.f === 'maxCpcCents' ? eur(val) : val} onChange={e => setLibField(t.id, f.f, e.target.value)} step={f.f === 'maxCpcCents' ? '0.01' : '1'} /></span>
                })}
                <span className="act">
                  {!t.pause && <button type="button" className="az-kebab" title="Motion — how the bid moves (jump / climb / ease / ceiling)" aria-expanded={mOpen} style={mOpen ? { color: '#3730a3' } : undefined} onClick={() => setMotionOpen(m => ({ ...m, [t.id]: !m[t.id] }))}><SlidersHorizontal size={13} /></button>}
                  {view === 'scope' && hasOverride(t) && <button type="button" className="az-kebab" title="Clear override (use default)" onClick={() => clearOverride(t.key)}><RotateCcw size={13} /></button>}
                  {view === 'global' && t.builtIn && <button type="button" className="az-kebab" title="Reset to default" onClick={() => void resetTarget(t.id)}><RotateCcw size={13} /></button>}
                  {view === 'global' && !t.builtIn && <button type="button" className="az-kebab" title="Delete custom" style={{ color: '#cc1100' }} onClick={() => void deleteTarget(t.id, t.name)}><Trash2 size={13} /></button>}
                </span>
              </div>
              {mOpen && !t.pause && (
                <div className="az-rte-motion">
                  <div className="az-mtitle"><SlidersHorizontal size={12} /> Motion — how the bid moves{view === 'scope' ? ` · override for ${scopeLabel}` : ''}</div>
                  <div className="az-msub">Default: <b>snap to {effOf(t, 'biasPct') ?? 0}% Placement</b>, up or down, then hold. Tune below to ramp instead, or set a Ceiling to climb above it.</div>
                  <div className="az-mfields">
                    {MOTION_FIELDS.map(f => {
                      const ph = defOf(t, f.f)
                      const lv = lib[t.id]?.[f.f] as number | null | undefined
                      const v = view === 'scope' ? ov[t.key]?.[f.f] : (lv !== undefined ? lv : (t[f.f] as number | null))
                      return (
                        <label key={f.f} className="az-mfield" title={f.hint}>
                          <span>{f.label}</span>
                          <input type="number" min={0} max={900} disabled={view === 'scope' && !scopeAvailable}
                            value={v == null ? '' : v}
                            placeholder={view === 'scope' ? (ph == null ? '—' : String(ph)) : '—'}
                            onChange={e => view === 'scope' ? setScope(t.key, f.f, e.target.value) : setLibField(t.id, f.f, e.target.value)} />
                        </label>
                      )
                    })}
                    <label className="az-mfield az-mkeep" title="Climb to the Ceiling on its own every cycle, even with no signal (bounded by the Ceiling + ACOS cap). Off = only climb when Amazon's data says you're winning.">
                      <span>Keep climbing</span>
                      {view === 'scope'
                        ? <select disabled={!scopeAvailable} value={ov[t.key]?.keepClimbing === undefined ? '' : ov[t.key]!.keepClimbing ? 'on' : 'off'} onChange={e => setScopeKeep(t.key, e.target.value as '' | 'on' | 'off')}><option value="">inherit</option><option value="on">on</option><option value="off">off</option></select>
                        : <input type="checkbox" checked={effKeep(t)} onChange={e => setLibKeep(t.id, e.target.checked)} />}
                    </label>
                  </div>
                  <div className="az-mrecipes">
                    <span style={{ fontSize: 10, fontWeight: 700, color: '#3730a3' }}>Recipes:</span>
                    {RECIPES.map(r => <button key={r.id} type="button" className="az-rcp" disabled={view === 'scope' && !scopeAvailable} title={r.hint} onClick={() => applyRecipe(t, r.m)}>{r.label}</button>)}
                  </div>
                  <div className="az-mnote">Blank = snap to {effOf(t, 'biasPct') ?? 0}% Placement (up or down) and hold — never above it. Set a Ceiling above Placement % to let it climb.{effKeep(t) ? ' Keep-climbing ON → pushes to the Ceiling on its own.' : ''}</div>
                </div>
              )}
              </Fragment>
            )
          })}
          {adding && (
            <div className="az-rte-row az-rte-add">
              <span className="nm"><input className="az-rte-name" placeholder="New target name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /><input type="color" value={form.color} onChange={e => setForm(f => ({ ...f, color: e.target.value }))} style={{ width: 26, height: 22, padding: 0, border: '1px solid var(--border)', borderRadius: 4 }} /></span>
              {FIELDS.map(f => <span key={f.f} className="fld"><input type="number" placeholder={f.unit} value={(form[f.f] == null ? '' : f.f === 'maxCpcCents' ? eur(form[f.f]) : form[f.f]) as string | number} onChange={e => setForm(s => ({ ...s, [f.f]: e.target.value === '' ? undefined : f.f === 'maxCpcCents' ? Math.round(Number(e.target.value) * 100) : Math.round(Number(e.target.value)) }))} step={f.f === 'maxCpcCents' ? '0.01' : '1'} /></span>)}
              <span className="act" />
              <div className="az-rte-addscope">
                Add to: <label><input type="radio" checked={form.scope === 'scope'} onChange={() => setForm(f => ({ ...f, scope: 'scope' }))} disabled={scopeKind === 'product' ? !productId : !campaignId} /> {scopeKind === 'product' ? 'This product only' : 'This campaign only'}</label>
                <label><input type="radio" checked={form.scope === 'global'} onChange={() => setForm(f => ({ ...f, scope: 'global' }))} /> Global (everywhere)</label>
                <span className="grow" />
                <button type="button" className="az-btn dark sm" disabled={busy} onClick={() => void addCustom()}>Add target</button>
                <button type="button" className="az-btn sm" onClick={() => setAdding(false)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
        {msg && <div className="az-rp-msg" style={{ margin: '0 15px' }}>{msg}</div>}
        <div className="ft">
          {!adding && <button type="button" className="az-btn" onClick={() => setAdding(true)}><Plus size={13} /> Add target</button>}
          <span className="grow" />
          <button type="button" className="az-btn" onClick={() => onClose(changed)}>Close</button>
          {((view === 'scope' && scopeAvailable) || view === 'global') && <button type="button" className="az-btn dark" disabled={busy || !changed} onClick={() => void save()}><Save size={13} /> {busy ? 'Saving…' : view === 'scope' ? 'Save overrides' : 'Save defaults'}</button>}
        </div>
      </div>
    </div>
  )
}
