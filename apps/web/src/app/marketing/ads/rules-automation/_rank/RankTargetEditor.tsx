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
import { Save, Plus, Trash2, RotateCcw, Info, SlidersHorizontal, Layers } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { RankBlendEditor, type BlendLane } from './RankBlendEditor'

interface RankTarget { id: string; key: string; name: string; placement: string; targetISPct: number | null; acosCapPct: number | null; maxCpcCents: number | null; biasPct: number | null; pause: boolean; floorBidCents: number | null; allOut: boolean; color: string | null; builtIn: boolean; scopeProductId: string | null; scopeCampaignId: string | null; jumpStartPct: number | null; stepUpPct: number | null; stepDownPct: number | null; maxBiasPct: number | null; keepClimbing: boolean; lanes?: BlendLane[] | null; bidMode?: string | null; bidValueCents?: number | null; bidDeltaPct?: number | null }
type OvField = 'biasPct' | 'targetISPct' | 'acosCapPct' | 'maxCpcCents' | 'floorBidCents' | 'jumpStartPct' | 'stepUpPct' | 'stepDownPct' | 'maxBiasPct'
// MB.2 — fields stored in CENTS and edited in euros. Every ×100 / ÷100 in this file reads
// this set, so adding the Min-bid floor could not leave one conversion behind.
const EURO_FIELDS = new Set<OvField>(['maxCpcCents', 'floorBidCents'])
const isEuro = (f: OvField) => EURO_FIELDS.has(f)
// MB.1 — the engine's legacy floor: what a Min-bid target holds when nothing is set. Also
// Amazon's own SP minimum, which normaliseFloorCents clamps up to — mirrored here so the
// readouts can never promise a floor the engine will refuse to use.
const DEFAULT_FLOOR_CENTS = 2
const eurStr = (c: number | null | undefined) => (c == null ? '' : (c / 100).toFixed(2))
/**
 * MB.2 — euros → cents, accepting BOTH decimal separators.
 *
 * These fields are `type="text"` rather than `type="number"` on purpose: a number input
 * renders its value through the browser's locale, so on a comma-decimal locale the "." key
 * is dropped and "0.10" lands as 0. Parsing both separators ourselves is the only way the
 * same keystrokes mean the same money everywhere.
 */
const parseEuro = (raw: string): number | null => {
  const s = raw.trim().replace(',', '.')
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

/**
 * MB.2 — a money field that lets you type.
 *
 * The previous inputs were controlled on the CANONICAL value: every keystroke re-rendered
 * `(cents/100).toFixed(2)`, so the moment you typed "0" the box became "0.00" and the caret
 * jumped — "0.10" was unenterable. Holding the raw keystrokes in a draft while committing
 * the parsed value on each change keeps the field editable and the state correct; the draft
 * is dropped on blur so the box settles back to canonical form.
 */
function EuroInput({ dkey, cents, placeholder, disabled, draft, setDraft, onCommit }: {
  dkey: string
  cents: number | null | undefined
  placeholder?: string
  disabled?: boolean
  draft: Record<string, string>
  setDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>
  onCommit: (raw: string) => void
}) {
  return (
    <input
      type="text"
      inputMode="decimal"
      disabled={disabled}
      value={draft[dkey] ?? eurStr(cents)}
      placeholder={placeholder}
      onChange={e => { const v = e.target.value; setDraft(d => ({ ...d, [dkey]: v })); onCommit(v) }}
      onBlur={() => setDraft(d => { const n = { ...d }; delete n[dkey]; return n })}
    />
  )
}
// BL.9 — a scope override can also carry a per-product/campaign BLEND (its own lanes +
// base-bid), so a blend can be campaign-specific, not just the global library default.
type Ov = Partial<Record<OvField, number>> & { keepClimbing?: boolean; lanes?: BlendLane[]; bidMode?: string | null; bidValueCents?: number | null; bidDeltaPct?: number | null }
export type OvMap = Record<string, Ov>
const api = (p: string) => `${getBackendUrl()}/api/advertising${p}`
const PLACE_LABEL: Record<string, string> = { PLACEMENT_TOP: 'Top of Search', PLACEMENT_REST_OF_SEARCH: 'Rest of Search', PLACEMENT_PRODUCT_PAGE: 'Product pages' }
const placeLabel = (p: string) => PLACE_LABEL[p] ?? p
const SHORT_PLACE: Record<string, string> = { PLACEMENT_TOP: 'Top', PLACEMENT_REST_OF_SEARCH: 'Rest', PLACEMENT_PRODUCT_PAGE: 'Product' }
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
  const [draft, setDraft] = useState<Record<string, string>>({}) // MB.2 — in-flight money keystrokes
  const [blendOpen, setBlendOpen] = useState<Record<string, boolean>>({}) // BL — per-target Blend drawer
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
  useEffect(() => { if (open) { load(); setOv({ ...(scopeOverrides || {}) }); setLib({}); setDraft({}); setView(onSaveScopeOverrides ? 'scope' : 'global'); setMsg(''); setChanged(false); setAdding(false) } }, [open, load]) // eslint-disable-line react-hooks/exhaustive-deps
  // RGD.6 — Esc closes the modal (a11y)
  useEffect(() => { if (!open) return; const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(changed) }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k) }, [open, changed, onClose])

  if (!open) return null

  const eur = (c: number | null | undefined) => (c == null ? '' : (c / 100).toFixed(2))
  const eurLbl = (c: number) => `€${(c / 100).toFixed(2)}` // MB.2 — read-only computed cell
  const defOf = (t: RankTarget, f: OvField): number | null => (lib[t.id]?.[f] as number | null | undefined) ?? (t[f] as number | null)
  const effOf = (t: RankTarget, f: OvField): number | null => (view === 'scope' && ov[t.key]?.[f] != null ? ov[t.key]![f]! : defOf(t, f))
  // MB.2 — the effective floor for a Min-bid target at the active scope (blank = the 2¢ the
  // engine has always used). Clamped exactly as normaliseFloorCents clamps it server-side:
  // typing 0.00 must not let this page report a €0.00 floor the engine will never apply.
  const floorOf = (t: RankTarget): number => Math.max(DEFAULT_FLOOR_CENTS, effOf(t, 'floorBidCents') ?? DEFAULT_FLOOR_CENTS)
  // Did the operator ask for something below Amazon's minimum? Then say so, rather than
  // silently showing the clamped number as though it were what they typed.
  const floorClamped = (t: RankTarget): boolean => { const v = effOf(t, 'floorBidCents'); return v != null && v < DEFAULT_FLOOR_CENTS }
  /**
   * MB.2 — what a click actually costs in a Min-bid hour.
   *
   * The floor is a BASE bid; Amazon charges base × (1 + placement %). With the placement
   * left alone — every schedule saved before MB.3 — the multiplier is whatever the previous
   * window happened to leave behind, which can be +300%. Stating "€0.02" alone would be the
   * same half-truth the row told before, so the unknown is named rather than hidden.
   */
  const effCpcNote = (t: RankTarget): string => {
    const f = floorOf(t)
    const b = effOf(t, 'biasPct')
    if (b == null) return `€${(f / 100).toFixed(2)} base · × whatever multiplier the previous window left`
    return `≈ €${((f * (100 + b)) / 10000).toFixed(2)} per click · €${(f / 100).toFixed(2)} base at ${placeLabel(t.placement)} +${b}%`
  }
  const describe = (t: RankTarget): string => {
    if (t.pause) {
      const b = effOf(t, 'biasPct')
      const f = floorOf(t)
      const place = b == null ? 'placement left unchanged' : `${placeLabel(t.placement)} → ${b}% · ≈ €${((f * (100 + b)) / 10000).toFixed(2)}/click`
      return `Floors bids to €${(f / 100).toFixed(2)} · ${place} · campaign stays live, restorable — never pauses`
    }
    // BL — a blended target drives multiple placements at once; summarise the blend.
    // BL.9 — in scope view a per-campaign/product override blend wins over the global one.
    const blend = effBlend(t)
    if (blend.lanes && blend.lanes.length) {
      const parts = blend.lanes.map((l) => `${SHORT_PLACE[l.placement] ?? l.placement} +${l.biasPct ?? 0}%${l.maxBiasPct != null && l.maxBiasPct > (l.biasPct ?? 0) ? `→${l.maxBiasPct}` : ''}`)
      let bb = ''
      if (blend.bidMode === 'absolute' && blend.bidValueCents != null) bb = ` · base €${(blend.bidValueCents / 100).toFixed(2)}`
      else if (blend.bidMode === 'deltaPct' && blend.bidDeltaPct != null) bb = ` · base ${blend.bidDeltaPct >= 0 ? '+' : ''}${blend.bidDeltaPct}%`
      else if (blend.bidMode === 'suppress') bb = ' · base floored'
      return `blend: ${parts.join(' · ')}${bb}`
    }
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
  // BL.9 — effective blend: in scope view a saved override blend wins over the global one.
  const effBlend = (t: RankTarget): { lanes: BlendLane[] | null | undefined; bidMode: string | null | undefined; bidValueCents: number | null | undefined; bidDeltaPct: number | null | undefined } => {
    if (view === 'scope' && ov[t.key]?.lanes !== undefined) {
      const o = ov[t.key]!
      return { lanes: o.lanes, bidMode: o.bidMode, bidValueCents: o.bidValueCents, bidDeltaPct: o.bidDeltaPct }
    }
    return { lanes: t.lanes, bidMode: t.bidMode, bidValueCents: t.bidValueCents, bidDeltaPct: t.bidDeltaPct }
  }
  // BL.9 — save a blend at the active scope: Global view PATCHes the library target;
  // scope view stages it into the override map (persisted by the main Save button).
  const onBlendSave = (t: RankTarget, patch: { lanes: BlendLane[]; bidMode: string | null; bidValueCents: number | null; bidDeltaPct: number | null }) => {
    if (view === 'global') { void saveBlend(t.id, patch); return }
    setChanged(true)
    setOv((m) => {
      const next = { ...m }
      next[t.key] = { ...(next[t.key] || {}), lanes: patch.lanes, bidMode: patch.bidMode, bidValueCents: patch.bidValueCents, bidDeltaPct: patch.bidDeltaPct }
      return next
    })
    setBlendOpen((m) => ({ ...m, [t.id]: false }))
    setMsg(`Staged a ${scopeLabel}-specific blend — click Save overrides to apply.`)
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
      if (raw.trim() === '') delete cur[f]
      else if (isEuro(f)) { const c = parseEuro(raw); if (c != null) cur[f] = c }
      else cur[f] = Math.round(Number(raw))
      if (Object.keys(cur).length) next[key] = cur; else delete next[key]
      return next
    })
  }
  const clearOverride = (key: string) => { setChanged(true); setOv(m => { const n = { ...m }; delete n[key]; return n }) }
  // global-view: edit the library draft (saved via PATCH)
  const setLibField = (id: string, f: keyof RankTarget, raw: string | number) => {
    setChanged(true)
    if (isEuro(f as OvField)) {
      // A half-typed value ("0.") parses to a number and commits; genuinely unparseable
      // input leaves the last good value in place while the draft keeps the keystrokes.
      const c = typeof raw === 'string' && raw.trim() === '' ? null : parseEuro(String(raw))
      if (c === null && String(raw).trim() !== '') return
      setLib(m => ({ ...m, [id]: { ...(m[id] || {}), [f]: c } }))
      return
    }
    setLib(m => ({ ...m, [id]: { ...(m[id] || {}), [f]: raw === '' ? null : (f === 'name' || f === 'color' ? raw : Math.round(Number(raw))) } }))
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
  // BL — save a blended strategy (lanes + base-bid) onto a library target, then reload.
  const saveBlend = async (id: string, patch: { lanes: BlendLane[]; bidMode: string | null; bidValueCents: number | null; bidDeltaPct: number | null }) => {
    setBusy(true); setMsg('')
    try { await fetch(api(`/rank-targets/${id}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }); setChanged(true); setBlendOpen(m => ({ ...m, [id]: false })); setMsg(patch.lanes.length ? 'Saved blend.' : 'Cleared blend (back to single-placement).'); load() }
    catch { setMsg('Could not save blend.') } finally { setBusy(false) }
  }
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
    <div className="h10-rd-copymodal" role="dialog" aria-modal="true" aria-label="Edit rank targets" onClick={() => onClose(changed)}>
      <div className="box h10-rte" onClick={e => e.stopPropagation()} style={{ width: 'min(680px, 95vw)' }}>
        <div className="hd">Rank targets — what each paint colour does<span className="grow" /><button type="button" className="h10-kebab" onClick={() => onClose(changed)} aria-label="Close">✕</button></div>
        <div className="h10-rte-scope">
          <span className="h10-mode-seg h10-scope-seg" role="tablist" style={{ display: 'inline-flex', border: '1px solid #d8dde4', borderRadius: 6, overflow: 'hidden' }}>
            <button type="button" role="tab" aria-selected={view === 'scope'} className={view === 'scope' ? 'on' : ''} disabled={!scopeAvailable} onClick={() => setView('scope')} title={scopeAvailable ? '' : `Save the ${scopeKind} first to set overrides here`}>{scopeKind === 'product' ? 'This product' : 'This campaign'}</button>
            <button type="button" role="tab" aria-selected={view === 'global'} className={view === 'global' ? 'on' : ''} onClick={() => setView('global')}>Global defaults</button>
          </span>
          <span className="h10-rte-scopehint"><Info size={12} /> {view === 'scope' ? `Overrides apply only to ${scopeLabel}. Empty = use the global default.` : 'Editing the shared default — changes every product & campaign.'}</span>
        </div>
        <div className="list h10-rte-list">
          <div className="h10-rte-row h10-rte-head"><span className="nm">Target</span>{FIELDS.map(f => <span key={f.f} className="fld" title={f.hint}>{f.label} {f.unit === '€' ? '€' : '%'}</span>)}<span className="act" /></div>
          {targets.map(t => {
            const scoped = !!t.scopeProductId || !!t.scopeCampaignId
            const mOpen = !!motionOpen[t.id]
            const eb = effBlend(t) // BL.9 — scope override wins over global
            const blendLanes = eb.lanes
            const blendOverridden = view === 'scope' && ov[t.key]?.lanes !== undefined
            return (
              <Fragment key={t.id}>
              <div className={`h10-rte-row ${view === 'scope' && hasOverride(t) ? 'ovr' : ''}`}>
                <span className="nm">
                  <i className="sw" style={{ background: t.color ?? '#999' }} />
                  {view === 'global' && !t.pause ? <input className="h10-rte-name" value={(lib[t.id]?.name as string) ?? t.name} onChange={e => setLibField(t.id, 'name', e.target.value)} /> : <b>{t.name}</b>}
                  <span className="bdg">{t.builtIn ? 'default' : scoped ? 'scoped' : 'custom'}</span>
                  {!t.pause && !(blendLanes && blendLanes.length) && <span className="bdg" style={{ background: '#eef2ff', color: '#3730a3' }}>{placeLabel(t.placement)}</span>}
                  {!t.pause && blendLanes && blendLanes.length > 0 && <span className="bdg" style={{ background: '#f3e8ff', color: '#7c3aed' }} title={blendOverridden ? `${scopeLabel}-specific blend` : 'global blend'}>blend ×{blendLanes.length}{blendOverridden ? '*' : ''}</span>}
                  {view === 'scope' && hasOverride(t) && <span className="bdg ov">override</span>}
                  <span className="desc">{describe(t)}</span>
                </span>
                {FIELDS.map(f => {
                  // MB.2 — a Min-bid row used to render four dashes: no floor, no placement, no
                  // control of any kind. Placement % is now the ONE editable field here (it is
                  // the lever that decides what the floored bid actually costs), the floor lives
                  // in the drawer next to the explanation it needs, and the two chase knobs stay
                  // n/a because Min bid holds no share — but they now say WHY.
                  if (t.pause) {
                    if (f.f === 'targetISPct') return <span key={f.f} className="fld h10-rte-na" title="Min bid holds no impression share — there is nothing to chase, so no target to set">n/a</span>
                    if (f.f === 'acosCapPct') return <span key={f.f} className="fld h10-rte-na" title="An ACOS cap only eases a climbing bid. Min bid never climbs.">n/a</span>
                    // Not a ceiling to set: floor × placement already determines the cost exactly.
                    // Putting that computed number under a "Max CPC" header would misname it.
                    if (f.f === 'maxCpcCents') return <span key={f.f} className="fld h10-rte-na" title={`No ceiling to set — the cost is fully determined: ${effCpcNote(t)}`}>n/a</span>
                    // biasPct falls through to the editable input below.
                  }
                  if (t.allOut && f.f === 'acosCapPct') return <span key={f.f} className="fld">—</span>
                  // RM2 — Target IS is now fed by SQP brand impression share for Rest of Search, so
                  // it's editable for non-Top too; only ACOS stays n/a (Amazon exposes no Rest ACOS).
                  if (f.f === 'acosCapPct' && t.placement !== 'PLACEMENT_TOP')
                    return <span key={f.f} className="fld h10-rte-na" title="Top of Search only — Amazon exposes no ACOS for Rest/Product placements">n/a</span>
                  // MB.2 — blank on a Min-bid placement means "leave the multiplier alone", not
                  // "zero". A dash would read as the latter.
                  const blank = t.pause && f.f === 'biasPct' ? 'keep' : '—'
                  if (view === 'scope') {
                    const v = ov[t.key]?.[f.f]
                    const ph = defOf(t, f.f)
                    if (isEuro(f.f)) return <span key={f.f} className="fld"><EuroInput dkey={`s:${t.key}:${f.f}`} cents={v} placeholder={ph == null ? blank : eur(ph)} disabled={!scopeAvailable} draft={draft} setDraft={setDraft} onCommit={raw => setScope(t.key, f.f, raw)} /></span>
                    return <span key={f.f} className="fld"><input type="number" disabled={!scopeAvailable} value={v == null ? '' : v} placeholder={ph == null ? blank : String(ph)} onChange={e => setScope(t.key, f.f, e.target.value)} step="1" /></span>
                  }
                  const lv = (lib[t.id]?.[f.f] as number | null | undefined)
                  const val = lv !== undefined ? lv : (t[f.f] as number | null)
                  if (isEuro(f.f)) return <span key={f.f} className="fld"><EuroInput dkey={`g:${t.id}:${f.f}`} cents={val} placeholder={blank} draft={draft} setDraft={setDraft} onCommit={raw => setLibField(t.id, f.f, raw)} /></span>
                  return <span key={f.f} className="fld"><input type="number" value={val == null ? '' : val} placeholder={blank} onChange={e => setLibField(t.id, f.f, e.target.value)} step="1" /></span>
                })}
                <span className="act">
                  {/* MB.2 — Min bid gets the same drawer affordance as every other target; only its CONTENTS differ. */}
                  <button type="button" className="h10-kebab" title={t.pause ? 'Min bid — the floor bids are held at, and what a click then costs' : 'Motion — how the bid moves (jump / climb / ease / ceiling)'} aria-expanded={mOpen} style={mOpen ? { color: t.pause ? '#c2410c' : '#3730a3' } : undefined} onClick={() => setMotionOpen(m => ({ ...m, [t.id]: !m[t.id] }))}><SlidersHorizontal size={13} /></button>
                  {!t.pause && <button type="button" className="h10-kebab" disabled={view === 'scope' && !scopeAvailable} title={view === 'scope' ? `Blend for ${scopeLabel} — drive Top + Rest of Search + Product pages at once (+ base bid), just here` : 'Blend — drive Top + Rest of Search + Product pages at once (+ base bid)'} aria-expanded={!!blendOpen[t.id]} style={blendOpen[t.id] ? { color: '#7c3aed' } : undefined} onClick={() => setBlendOpen(m => ({ ...m, [t.id]: !m[t.id] }))}><Layers size={13} /></button>}
                  {view === 'scope' && hasOverride(t) && <button type="button" className="h10-kebab" title="Clear override (use default)" onClick={() => clearOverride(t.key)}><RotateCcw size={13} /></button>}
                  {view === 'global' && t.builtIn && <button type="button" className="h10-kebab" title="Reset to default" onClick={() => void resetTarget(t.id)}><RotateCcw size={13} /></button>}
                  {view === 'global' && !t.builtIn && <button type="button" className="h10-kebab" title="Delete custom" style={{ color: '#cc1100' }} onClick={() => void deleteTarget(t.id, t.name)}><Trash2 size={13} /></button>}
                </span>
              </div>
              {/*
                MB.2 — the Min-bid drawer. Sibling of the Motion drawer below, deliberately in
                the same idiom. The floor lives HERE rather than as a sixth table column because
                it is the one field only this row can use, and because the number is meaningless
                without the sentence next to it: €0.02 is a BASE bid, and what it costs per click
                depends on a placement multiplier this modal cannot see until MB.3 sets one.
              */}
              {mOpen && t.pause && (
                <div className="h10-rte-motion h10-rte-minbid">
                  <div className="h10-mtitle"><SlidersHorizontal size={12} /> Min bid — what these hours do{view === 'scope' ? ` · override for ${scopeLabel}` : ''}</div>
                  <div className="h10-msub">Every bid in the campaign drops to the floor and the campaign stays <b>ENABLED</b> — it is never paused, because a real pause disrupts Amazon&apos;s algorithm. Each prior bid is remembered and restored exactly when a serving target takes over.</div>
                  <div className="h10-mfields">
                    <label className="h10-mfield" title="The bid every keyword and ad group is held at during these hours. Blank = €0.02, the engine's long-standing floor and Amazon's own minimum.">
                      <span>Floor €</span>
                      {view === 'scope'
                        ? <EuroInput dkey={`s:${t.key}:floorBidCents`} cents={ov[t.key]?.floorBidCents} placeholder={eur(defOf(t, 'floorBidCents')) || '0.02'} disabled={!scopeAvailable} draft={draft} setDraft={setDraft} onCommit={raw => setScope(t.key, 'floorBidCents', raw)} />
                        : <EuroInput dkey={`g:${t.id}:floorBidCents`} cents={(lib[t.id]?.floorBidCents as number | null | undefined) !== undefined ? (lib[t.id]!.floorBidCents as number | null) : t.floorBidCents} placeholder="0.02" draft={draft} setDraft={setDraft} onCommit={raw => setLibField(t.id, 'floorBidCents', raw)} />}
                    </label>
                    <label className="h10-mfield h10-mcalc" title="Amazon charges base bid × (1 + placement %). This is that arithmetic, not a setting.">
                      <span>Per click</span>
                      <b>{eurLbl(floorOf(t) * (100 + (effOf(t, 'biasPct') ?? 0)) / 100)}</b>
                    </label>
                  </div>
                  {floorClamped(t) && <div className="h10-mwarn">That is under Amazon&apos;s €0.02 minimum — the engine will hold €0.02, which is what the figures here show.</div>}
                  <div className="h10-mnote">{effCpcNote(t)}. {effOf(t, 'biasPct') == null
                    ? <>Set <b>Placement %</b> on this row to take control of the multiplier — leave it blank and these hours inherit whatever the previous window left behind (an all-out hour can leave +300%).</>
                    : <>Placement is pinned, so this cost is the whole story.</>} Floors under €0.02 are raised to €0.02 — Amazon rejects anything lower.</div>
                </div>
              )}
              {mOpen && !t.pause && (
                <div className="h10-rte-motion">
                  <div className="h10-mtitle"><SlidersHorizontal size={12} /> Motion — how the bid moves{view === 'scope' ? ` · override for ${scopeLabel}` : ''}</div>
                  <div className="h10-msub">Default: <b>snap to {effOf(t, 'biasPct') ?? 0}% Placement</b>, up or down, then hold. Tune below to ramp instead, or set a Ceiling to climb above it.</div>
                  <div className="h10-mfields">
                    {MOTION_FIELDS.map(f => {
                      const ph = defOf(t, f.f)
                      const lv = lib[t.id]?.[f.f] as number | null | undefined
                      const v = view === 'scope' ? ov[t.key]?.[f.f] : (lv !== undefined ? lv : (t[f.f] as number | null))
                      return (
                        <label key={f.f} className="h10-mfield" title={f.hint}>
                          <span>{f.label}</span>
                          <input type="number" min={0} max={900} disabled={view === 'scope' && !scopeAvailable}
                            value={v == null ? '' : v}
                            placeholder={view === 'scope' ? (ph == null ? '—' : String(ph)) : '—'}
                            onChange={e => view === 'scope' ? setScope(t.key, f.f, e.target.value) : setLibField(t.id, f.f, e.target.value)} />
                        </label>
                      )
                    })}
                    <label className="h10-mfield h10-mkeep" title="Climb to the Ceiling on its own every cycle, even with no signal (bounded by the Ceiling + ACOS cap). Off = only climb when Amazon's data says you're winning.">
                      <span>Keep climbing</span>
                      {view === 'scope'
                        ? <select disabled={!scopeAvailable} value={ov[t.key]?.keepClimbing === undefined ? '' : ov[t.key]!.keepClimbing ? 'on' : 'off'} onChange={e => setScopeKeep(t.key, e.target.value as '' | 'on' | 'off')}><option value="">inherit</option><option value="on">on</option><option value="off">off</option></select>
                        : <input type="checkbox" checked={effKeep(t)} onChange={e => setLibKeep(t.id, e.target.checked)} />}
                    </label>
                  </div>
                  <div className="h10-mrecipes">
                    <span style={{ fontSize: 10, fontWeight: 700, color: '#3730a3' }}>Recipes:</span>
                    {RECIPES.map(r => <button key={r.id} type="button" className="h10-rcp" disabled={view === 'scope' && !scopeAvailable} title={r.hint} onClick={() => applyRecipe(t, r.m)}>{r.label}</button>)}
                  </div>
                  <div className="h10-mnote">Blank = snap to {effOf(t, 'biasPct') ?? 0}% Placement (up or down) and hold — never above it. Set a Ceiling above Placement % to let it climb.{effKeep(t) ? ' Keep-climbing ON → pushes to the Ceiling on its own.' : ''}</div>
                </div>
              )}
              {!!blendOpen[t.id] && !t.pause && (
                <RankBlendEditor
                  target={{ id: t.id, name: t.name, lanes: blendLanes, bidMode: eb.bidMode, bidValueCents: eb.bidValueCents, bidDeltaPct: eb.bidDeltaPct }}
                  busy={busy}
                  scopeNote={view === 'scope' ? scopeLabel : undefined}
                  onSave={(patch) => onBlendSave(t, patch)}
                  onClose={() => setBlendOpen(m => ({ ...m, [t.id]: false }))}
                />
              )}
              </Fragment>
            )
          })}
          {adding && (
            <div className="h10-rte-row h10-rte-add">
              <span className="nm"><input className="h10-rte-name" placeholder="New target name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /><input type="color" value={form.color} onChange={e => setForm(f => ({ ...f, color: e.target.value }))} style={{ width: 26, height: 22, padding: 0, border: '1px solid #d8dde4', borderRadius: 4 }} /></span>
              {FIELDS.map(f => <span key={f.f} className="fld"><input type="number" placeholder={f.unit} value={(form[f.f] == null ? '' : f.f === 'maxCpcCents' ? eur(form[f.f]) : form[f.f]) as string | number} onChange={e => setForm(s => ({ ...s, [f.f]: e.target.value === '' ? undefined : f.f === 'maxCpcCents' ? Math.round(Number(e.target.value) * 100) : Math.round(Number(e.target.value)) }))} step={f.f === 'maxCpcCents' ? '0.01' : '1'} /></span>)}
              <span className="act" />
              <div className="h10-rte-addscope">
                Add to: <label><input type="radio" checked={form.scope === 'scope'} onChange={() => setForm(f => ({ ...f, scope: 'scope' }))} disabled={scopeKind === 'product' ? !productId : !campaignId} /> {scopeKind === 'product' ? 'This product only' : 'This campaign only'}</label>
                <label><input type="radio" checked={form.scope === 'global'} onChange={() => setForm(f => ({ ...f, scope: 'global' }))} /> Global (everywhere)</label>
                <span className="grow" />
                <button type="button" className="h10-btn dark sm" disabled={busy} onClick={() => void addCustom()}>Add target</button>
                <button type="button" className="h10-btn sm" onClick={() => setAdding(false)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
        {msg && <div className="h10-rp-msg" style={{ margin: '0 15px' }}>{msg}</div>}
        <div className="ft">
          {!adding && <button type="button" className="h10-btn" onClick={() => setAdding(true)}><Plus size={13} /> Add target</button>}
          <span className="grow" />
          <button type="button" className="h10-btn" onClick={() => onClose(changed)}>Close</button>
          {((view === 'scope' && scopeAvailable) || view === 'global') && <button type="button" className="h10-btn dark" disabled={busy || !changed} onClick={() => void save()}><Save size={13} /> {busy ? 'Saving…' : view === 'scope' ? 'Save overrides' : 'Save defaults'}</button>}
        </div>
      </div>
    </div>
  )
}
