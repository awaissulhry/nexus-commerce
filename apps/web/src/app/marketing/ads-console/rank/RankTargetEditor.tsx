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

import { useCallback, useEffect, useState } from 'react'
import { Save, Plus, Trash2, RotateCcw, Info } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface RankTarget { id: string; key: string; name: string; placement: string; targetISPct: number | null; acosCapPct: number | null; maxCpcCents: number | null; biasPct: number | null; pause: boolean; allOut: boolean; color: string | null; builtIn: boolean; scopeProductId: string | null; scopeCampaignId: string | null }
type OvField = 'biasPct' | 'targetISPct' | 'acosCapPct' | 'maxCpcCents'
type Ov = Partial<Record<OvField, number>>
type OvMap = Record<string, Ov>
const api = (p: string) => `${getBackendUrl()}/api/advertising${p}`
const FIELDS: { f: OvField; label: string; unit: '%' | '€'; hint: string }[] = [
  { f: 'biasPct', label: 'Top-of-Search', unit: '%', hint: 'placement bid multiplier 0–900%' },
  { f: 'targetISPct', label: 'Target IS', unit: '%', hint: 'top-of-search impression share to hold' },
  { f: 'acosCapPct', label: 'ACOS cap', unit: '%', hint: 'ease off above this ACOS' },
  { f: 'maxCpcCents', label: 'Max CPC', unit: '€', hint: 'never bid above this' },
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
    const b = effOf(t, 'biasPct'); if (b != null) p.push(`Top-of-Search +${b}%`)
    const is = effOf(t, 'targetISPct'); if (is != null) p.push(`hold ${is}% IS`)
    const a = effOf(t, 'acosCapPct'); if (a != null) p.push(`ease above ${a}% ACOS`)
    const c = effOf(t, 'maxCpcCents'); if (c != null) p.push(`max CPC €${(c / 100).toFixed(2)}`)
    if (t.allOut) p.push('all-out (ignore ACOS)')
    return p.join(' · ') || 'baseline (no push)'
  }
  const hasOverride = (t: RankTarget) => !!ov[t.key] && Object.keys(ov[t.key]).length > 0

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
            return (
              <div key={t.id} className={`az-rte-row ${view === 'scope' && hasOverride(t) ? 'ovr' : ''}`}>
                <span className="nm">
                  <i className="sw" style={{ background: t.color ?? '#999' }} />
                  {view === 'global' && !t.pause ? <input className="az-rte-name" value={(lib[t.id]?.name as string) ?? t.name} onChange={e => setLibField(t.id, 'name', e.target.value)} /> : <b>{t.name}</b>}
                  <span className="bdg">{t.builtIn ? 'default' : scoped ? 'scoped' : 'custom'}</span>
                  {view === 'scope' && hasOverride(t) && <span className="bdg ov">override</span>}
                  <span className="desc">{describe(t)}</span>
                </span>
                {FIELDS.map(f => {
                  if (t.pause || (t.allOut && f.f === 'acosCapPct')) return <span key={f.f} className="fld">—</span>
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
                  {view === 'scope' && hasOverride(t) && <button type="button" className="az-kebab" title="Clear override (use default)" onClick={() => clearOverride(t.key)}><RotateCcw size={13} /></button>}
                  {view === 'global' && t.builtIn && <button type="button" className="az-kebab" title="Reset to default" onClick={() => void resetTarget(t.id)}><RotateCcw size={13} /></button>}
                  {view === 'global' && !t.builtIn && <button type="button" className="az-kebab" title="Delete custom" style={{ color: '#cc1100' }} onClick={() => void deleteTarget(t.id, t.name)}><Trash2 size={13} /></button>}
                </span>
              </div>
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
