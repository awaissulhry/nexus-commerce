'use client'

/**
 * RTC — Rank-target customizer. A modal to inspect + change what each paint swatch
 * actually does (Placement %, max CPC, the Min-bid floor, a blend's lanes + base bid), add your
 * own custom swatches, and do it at the right SCOPE:
 *   • Scope view ("This product" / "This campaign") edits an OVERRIDE layer stored on
 *     the plan/schedule — affects only here. Empty field = inherit the global default.
 *   • Global view edits the shared library default (affects everywhere); built-ins can
 *     be Reset, customs deleted.
 * Custom swatches can be Global (everywhere) or Scope-only (just this product/campaign).
 * Effective at runtime = global ⊕ product ⊕ campaign (the engine merges; RTC.2).
 *
 * 2e (Owner D1 = A) — the engine holds each hour's FIXED values: it reads no impression share,
 * no ACoS and no rank, and it never climbs. So this modal no longer offers Target IS, ACOS cap,
 * the Motion knobs (climb/ease step, ceiling, keep climbing) or all-out. Those columns stay in
 * the database, unread and unshown.
 */

import { Fragment, useCallback, useEffect, useState } from 'react'
import { Save, Plus, Trash2, RotateCcw, Info, SlidersHorizontal, Layers, X } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { RankBlendEditor, type BlendLane } from './RankBlendEditor'
import { Button, Input, Radio, SegmentedControl, ToolbarButton } from '@/design-system/primitives'

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
    <Input
      size="xs"
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
// 2e — the two values a serving hour holds: its placement multiplier and the bid ceiling that caps it.
const FIELDS: { f: OvField; label: string; unit: '%' | '€'; hint: string }[] = [
  { f: 'biasPct', label: 'Placement', unit: '%', hint: "The placement multiplier 0–900% held for THIS target's placement in every hour it covers (Top or Rest of Search)" },
  { f: 'maxCpcCents', label: 'Max CPC', unit: '€', hint: 'Never bid above this: the placement % is lowered so base bid × placement stays under it' },
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
  const [motionOpen, setMotionOpen] = useState<Record<string, boolean>>({}) // per-target Min-bid drawer
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
      const parts = blend.lanes.map((l) => `${SHORT_PLACE[l.placement] ?? l.placement} +${l.biasPct ?? 0}%`)
      let bb = ''
      if (blend.bidMode === 'absolute' && blend.bidValueCents != null) bb = ` · base €${(blend.bidValueCents / 100).toFixed(2)}`
      else if (blend.bidMode === 'deltaPct' && blend.bidDeltaPct != null) bb = ` · base ${blend.bidDeltaPct >= 0 ? '+' : ''}${blend.bidDeltaPct}%`
      else if (blend.bidMode === 'suppress') bb = ' · base floored'
      return `blend: ${parts.join(' · ')}${bb}`
    }
    // 2e — what the hour holds, and nothing the engine does not read.
    const p: string[] = []
    const b = effOf(t, 'biasPct')
    p.push(`holds ${placeLabel(t.placement)} +${b ?? 0}%`)
    const c = effOf(t, 'maxCpcCents'); if (c != null) p.push(`max CPC €${(c / 100).toFixed(2)}`)
    return p.join(' · ')
  }
  const hasOverride = (t: RankTarget) => !!ov[t.key] && Object.keys(ov[t.key]).length > 0
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
      const body: Record<string, unknown> = { name: form.name.trim(), color: form.color, biasPct: form.biasPct ?? null, maxCpcCents: form.maxCpcCents ?? null }
      if (form.scope === 'scope') { if (scopeKind === 'product' && productId) body.scopeProductId = productId; if (scopeKind === 'campaign' && campaignId) body.scopeCampaignId = campaignId }
      await fetch(api('/rank-targets'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      setChanged(true); setAdding(false); setForm({ name: '', color: '#3aa873', scope: 'scope' }); load()
    } catch { setMsg('Could not add target.') } finally { setBusy(false) }
  }

  const scopeAvailable = !!onSaveScopeOverrides
  return (
    <div className="h10-rd-copymodal" role="dialog" aria-modal="true" aria-label="Edit rank targets" onClick={() => onClose(changed)}>
      <div className="box h10-rte" onClick={e => e.stopPropagation()} style={{ width: 'min(680px, 95vw)' }}>
        <div className="hd">Rank targets — what each paint colour does<span className="grow" /><ToolbarButton className="h10-kebab" icon={<X size={14} />} label="Close" tooltip={false} onClick={() => onClose(changed)} /></div>
        <div className="h10-rte-scope">
          {/* `SegmentedOption` carries no per-option `disabled` (DS-GAPS), and a disabled tab
              explaining itself only through a hover `title` was the weaker half of this control
              anyway. When the scope has nothing to override yet, the reachable option is the
              only one shown and the reason moves into the hint beside it, as visible text. */}
          <SegmentedControl
            ariaLabel="Which defaults to edit" size="sm"
            value={scopeAvailable ? view : 'global'}
            onChange={(v) => setView(v as 'scope' | 'global')}
            options={[
              ...(scopeAvailable ? [{ value: 'scope', label: scopeKind === 'product' ? 'This product' : 'This campaign' }] : []),
              { value: 'global', label: 'Global defaults' },
            ]}
          />
          <span className="h10-rte-scopehint"><Info size={12} /> {!scopeAvailable
            ? `Save the ${scopeKind} first to set overrides here — until then this edits the shared default, which changes every product & campaign.`
            : view === 'scope' ? `Overrides apply only to ${scopeLabel}. Empty = use the global default.` : 'Editing the shared default — changes every product & campaign.'}</span>
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
                  {view === 'global' && !t.pause ? <Input size="sm" fieldClassName="h10-rte-name" value={(lib[t.id]?.name as string) ?? t.name} onChange={e => setLibField(t.id, 'name', e.target.value)} aria-label="Rank target name" /> : <b>{t.name}</b>}
                  <span className="bdg">{t.builtIn ? 'default' : scoped ? 'scoped' : 'custom'}</span>
                  {!t.pause && !(blendLanes && blendLanes.length) && <span className="bdg" style={{ background: '#eef2ff', color: '#3730a3' }}>{placeLabel(t.placement)}</span>}
                  {!t.pause && blendLanes && blendLanes.length > 0 && <span className="bdg" style={{ background: '#f3e8ff', color: '#7c3aed' }} title={blendOverridden ? `${scopeLabel}-specific blend` : 'global blend'}>blend ×{blendLanes.length}{blendOverridden ? '*' : ''}</span>}
                  {view === 'scope' && hasOverride(t) && <span className="bdg ov">override</span>}
                  <span className="desc">{describe(t)}</span>
                </span>
                {FIELDS.map(f => {
                  // MB.2 — Placement % is the ONE editable field on a Min-bid row (it is the lever
                  // that decides what the floored bid actually costs); the floor lives in the
                  // drawer next to the explanation it needs.
                  if (t.pause) {
                    // Not a ceiling to set: floor × placement already determines the cost exactly.
                    // Putting that computed number under a "Max CPC" header would misname it.
                    if (f.f === 'maxCpcCents') return <span key={f.f} className="fld h10-rte-na" title={`No ceiling to set — the cost is fully determined: ${effCpcNote(t)}`}>n/a</span>
                    // biasPct falls through to the editable input below.
                  }
                  // MB.2 — blank on a Min-bid placement means "leave the multiplier alone", not
                  // "zero". A dash would read as the latter.
                  const blank = t.pause && f.f === 'biasPct' ? 'keep' : '—'
                  if (view === 'scope') {
                    const v = ov[t.key]?.[f.f]
                    const ph = defOf(t, f.f)
                    if (isEuro(f.f)) return <span key={f.f} className="fld"><EuroInput dkey={`s:${t.key}:${f.f}`} cents={v} placeholder={ph == null ? blank : eur(ph)} disabled={!scopeAvailable} draft={draft} setDraft={setDraft} onCommit={raw => setScope(t.key, f.f, raw)} /></span>
                    return <span key={f.f} className="fld"><Input size="xs" type="number" disabled={!scopeAvailable} value={v == null ? '' : v} placeholder={ph == null ? blank : String(ph)} onChange={e => setScope(t.key, f.f, e.target.value)} step="1" /></span>
                  }
                  const lv = (lib[t.id]?.[f.f] as number | null | undefined)
                  const val = lv !== undefined ? lv : (t[f.f] as number | null)
                  if (isEuro(f.f)) return <span key={f.f} className="fld"><EuroInput dkey={`g:${t.id}:${f.f}`} cents={val} placeholder={blank} draft={draft} setDraft={setDraft} onCommit={raw => setLibField(t.id, f.f, raw)} /></span>
                  return <span key={f.f} className="fld"><Input size="xs" type="number" value={val == null ? '' : val} placeholder={blank} onChange={e => setLibField(t.id, f.f, e.target.value)} step="1" /></span>
                })}
                <span className="act">
                  {/* MB.2 — Min bid gets the same drawer affordance as every other target; only its CONTENTS differ. */}
                  {t.pause && <ToolbarButton className="h10-kebab" icon={<SlidersHorizontal size={13} />} label="Min bid" description="The floor bids are held at, and what a click then costs" aria-expanded={mOpen} style={mOpen ? { color: '#c2410c' } : undefined} onClick={() => setMotionOpen(m => ({ ...m, [t.id]: !m[t.id] }))} />}
                  {!t.pause && <ToolbarButton className="h10-kebab" icon={<Layers size={13} />} label="Blend" description={view === 'scope' ? `For ${scopeLabel} only — drive Top + Rest of Search + Product pages at once (+ base bid)` : 'Drive Top + Rest of Search + Product pages at once (+ base bid)'} disabled={view === 'scope' && !scopeAvailable} aria-expanded={!!blendOpen[t.id]} style={blendOpen[t.id] ? { color: '#7c3aed' } : undefined} onClick={() => setBlendOpen(m => ({ ...m, [t.id]: !m[t.id] }))} />}
                  {view === 'scope' && hasOverride(t) && <ToolbarButton className="h10-kebab" icon={<RotateCcw size={13} />} label="Clear override" description="Use the default again" onClick={() => clearOverride(t.key)} />}
                  {view === 'global' && t.builtIn && <ToolbarButton className="h10-kebab" icon={<RotateCcw size={13} />} label="Reset to default" onClick={() => void resetTarget(t.id)} />}
                  {view === 'global' && !t.builtIn && <ToolbarButton className="h10-kebab" icon={<Trash2 size={13} />} label="Delete custom" style={{ color: '#cc1100' }} onClick={() => void deleteTarget(t.id, t.name)} />}
                </span>
              </div>
              {/*
                MB.2 — the Min-bid drawer. The floor lives HERE rather than as a sixth table column because
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
                    ? <>Set <b>Placement %</b> on this row to take control of the multiplier — leave it blank and these hours inherit whatever the previous hour left behind.</>
                    : <>Placement is pinned, so this cost is the whole story.</>} Floors under €0.02 are raised to €0.02 — Amazon rejects anything lower.</div>
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
              <span className="nm"><Input size="sm" fieldClassName="h10-rte-name" placeholder="New target name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} aria-label="New target name" />{/* DS-ALIGN — the only raw <input> left in this half. `type="color"` opens the platform's own
                colour picker; the design system has no primitive for it (logged in DS-GAPS), and wrapping
                it in `Input` would give it a text field's chrome around a swatch. Its inline style is a
                named class now, so the border is a token rather than a hex written at the call site. */}
              <input type="color" className="h10-rte-color" value={form.color} onChange={e => setForm(f => ({ ...f, color: e.target.value }))} aria-label="Target colour" /></span>
              {FIELDS.map(f => <span key={f.f} className="fld"><Input size="xs" type="number" placeholder={f.unit} value={(form[f.f] == null ? '' : f.f === 'maxCpcCents' ? eur(form[f.f]) : form[f.f]) as string | number} onChange={e => setForm(s => ({ ...s, [f.f]: e.target.value === '' ? undefined : f.f === 'maxCpcCents' ? Math.round(Number(e.target.value) * 100) : Math.round(Number(e.target.value)) }))} step={f.f === 'maxCpcCents' ? '0.01' : '1'} aria-label={f.label} /></span>)}
              <span className="act" />
              <div className="h10-rte-addscope">
                Add to: <Radio name="rte-addscope" checked={form.scope === 'scope'} onChange={() => setForm(f => ({ ...f, scope: 'scope' }))} disabled={scopeKind === 'product' ? !productId : !campaignId} label={scopeKind === 'product' ? 'This product only' : 'This campaign only'} />
                <Radio name="rte-addscope" checked={form.scope === 'global'} onChange={() => setForm(f => ({ ...f, scope: 'global' }))} label="Global (everywhere)" />
                <span className="grow" />
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void addCustom()}>Add target</Button>
        <Button size="sm" onClick={() => setAdding(false)}>Cancel</Button>
              </div>
            </div>
          )}
        </div>
        {msg && <div className="h10-rp-msg" style={{ margin: '0 15px' }}>{msg}</div>}
        <div className="ft">
     {!adding && <Button onClick={() => setAdding(true)}><Plus size={13} /> Add target</Button>}
          <span className="grow" />
     <Button onClick={() => onClose(changed)}>Close</Button>
     {((view === 'scope' && scopeAvailable) || view === 'global') && <Button variant="primary" disabled={busy || !changed} onClick={() => void save()}><Save size={13} /> {busy ? 'Saving…' : view === 'scope' ? 'Save overrides' : 'Save defaults'}</Button>}
        </div>
      </div>
    </div>
  )
}
