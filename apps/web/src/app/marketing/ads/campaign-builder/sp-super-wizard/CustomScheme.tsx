'use client'

/**
 * SPW.3 / CSW — Custom Scheme: a real campaign-structure builder (Helium 10 +).
 * Pick which Campaign Types to generate (Auto / Keyword / Product-PAT), and — per
 * Keyword Type (Brand/Competitor/Category/Other/custom) — which Match Types
 * (Broad/Phrase/Exact). The Campaign-Name tokens compose the generated names.
 * Campaigns = the cross-product (Auto + PAT + each keyword type × its match types).
 *
 * CSW.1: the structure fields (Campaign Types + per-keyword-type Match Types), built
 * on the design-system primitives (the H10 look as components). Per-type keywords land
 * in CSW.2; the token-driven naming + live preview in CSW.3.
 */
import { type Dispatch, type SetStateAction, Fragment, useEffect, useRef, useState } from 'react'
import { Info, Plus, X, ChevronDown } from 'lucide-react'
import { Checkbox } from '@/design-system/primitives'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'

export type MatchTypeKey = 'BROAD' | 'PHRASE' | 'EXACT'
export type TargetingKind = 'auto' | 'keyword' | 'product'
export type CustomKeywordType = { name: string; matchTypes: MatchTypeKey[]; keywords: string[] }

export const defaultCustomKeywordTypes = (): CustomKeywordType[] =>
  ['Brand', 'Competitor', 'Category', 'Other'].map((name) => ({ name, matchTypes: ['BROAD'] as MatchTypeKey[], keywords: [] }))
export const defaultCustomTargeting = (): TargetingKind[] => ['auto', 'keyword', 'product']

const MATCHES: Array<{ k: MatchTypeKey; label: string }> = [{ k: 'BROAD', label: 'Broad' }, { k: 'PHRASE', label: 'Phrase' }, { k: 'EXACT', label: 'Exact' }]
const TARGETS: Array<{ k: TargetingKind; label: string }> = [{ k: 'auto', label: 'Auto' }, { k: 'keyword', label: 'Keyword' }, { k: 'product', label: 'Product (PAT)' }]

export const TOKEN_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'campaignType', label: 'Campaign Type (SP)' },
  { value: 'targetingType', label: 'Targeting Type (Keyword)' },
  { value: 'matchType', label: 'Match Type' },
  { value: 'keywordType', label: 'Keyword Type' },
  { value: 'asin', label: 'Asin' },
  { value: 'customize', label: 'Customize' },
]

function TokenSelect({ value, onChange, onRemove }: { value: string; onChange: (v: string) => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  const label = TOKEN_OPTIONS.find((o) => o.value === value)?.label ?? 'Please Select'
  return (
    <span className="h10-spw-cs-token" ref={ref}>
      <button type="button" className={`sel ${open ? 'open' : ''}`} onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        <span className={value ? '' : 'ph'}>{label}</span>
        <ChevronDown size={14} />
      </button>
      <button type="button" className="x" onClick={onRemove} aria-label="Remove token"><X size={14} /></button>
      {open && (
        <div className="menu" role="listbox">
          {TOKEN_OPTIONS.map((o) => (
            <button type="button" key={o.value} role="option" aria-selected={o.value === value} className={o.value === value ? 'on' : ''} onClick={() => { onChange(o.value); setOpen(false) }}>{o.label}</button>
          ))}
        </div>
      )}
    </span>
  )
}

function KeywordPopup({ initial, onApply, onClose }: { initial: string[]; onApply: (kws: string[]) => void; onClose: () => void }) {
  const [text, setText] = useState(initial.join('\n'))
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
  }, [onClose])
  const apply = () => { onApply(Array.from(new Set(text.split('\n').map((s) => s.trim()).filter(Boolean)))); onClose() }
  return (
    <div className="h10-spw-cs-pop" role="dialog" aria-label="Edit keywords" onClick={(e) => e.stopPropagation()}>
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Please Enter one keyword per line" autoFocus />
      <div className="ft">
        <button type="button" className="cancel" onClick={onClose}>Cancel</button>
        <button type="button" className="apply" onClick={apply}>Apply</button>
      </div>
    </div>
  )
}

export function CustomScheme({ keywordTypes, setKeywordTypes, targetingTypes, setTargetingTypes, nameTokens, setNameTokens, previewNames, remember, setRemember }: {
  keywordTypes: CustomKeywordType[]
  setKeywordTypes: Dispatch<SetStateAction<CustomKeywordType[]>>
  targetingTypes: TargetingKind[]
  setTargetingTypes: Dispatch<SetStateAction<TargetingKind[]>>
  nameTokens: string[]
  setNameTokens: Dispatch<SetStateAction<string[]>>
  previewNames: string[]
  remember: boolean
  setRemember: (v: boolean) => void
}) {
  const [kwEditIdx, setKwEditIdx] = useState<number | null>(null)
  useEffect(() => {
    if (kwEditIdx === null) return
    const h = (e: MouseEvent) => { if (!(e.target as Element).closest('.h10-spw-cs-kwwrap')) setKwEditIdx(null) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [kwEditIdx])
  const toggleTarget = (t: TargetingKind) => setTargetingTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]))
  const toggleMatch = (idx: number, mt: MatchTypeKey) => setKeywordTypes((cur) => cur.map((kt, i) => (i === idx ? { ...kt, matchTypes: kt.matchTypes.includes(mt) ? kt.matchTypes.filter((m) => m !== mt) : [...kt.matchTypes, mt] } : kt)))
  const addKw = () => setKeywordTypes((cur) => [...cur, { name: `Custom ${cur.filter((k) => k.name.startsWith('Custom')).length + 1}`, matchTypes: ['BROAD'], keywords: [] }])
  const removeKw = (idx: number) => setKeywordTypes((cur) => cur.filter((_, i) => i !== idx))
  const setKeywords = (idx: number, kws: string[]) => setKeywordTypes((cur) => cur.map((kt, i) => (i === idx ? { ...kt, keywords: kws } : kt)))
  const renameKw = (idx: number, name: string) => setKeywordTypes((cur) => cur.map((kt, i) => (i === idx ? { ...kt, name } : kt)))
  const setToken = (i: number, v: string) => setNameTokens((cur) => cur.map((t, idx) => (idx === i ? v : t)))
  const removeToken = (i: number) => setNameTokens((cur) => cur.filter((_, idx) => idx !== i))
  const addToken = () => setNameTokens((cur) => [...cur, ''])
  const keywordOn = targetingTypes.includes('keyword')

  return (
    <div className="h10-spw-cs">
      <div className="h10-spw-cs-title">Structure Setting</div>
      <p className="h10-spw-cs-intro">Build your own campaign structure — choose the campaign types, set the keyword groups + match types for keyword campaigns, and the naming pattern. The preview at the bottom shows exactly what you&apos;ll get.</p>

      <div className="h10-spw-cs-field">
        <span className="lbl">Campaign Types <Info size={13} className="ic" /></span>
        <span className="h10-spw-cs-hint">The kinds of campaigns to create.</span>
        <div className="h10-spw-cs-targets">
          {TARGETS.map((t) => <Checkbox key={t.k} label={t.label} checked={targetingTypes.includes(t.k)} onChange={() => toggleTarget(t.k)} />)}
        </div>
      </div>

      {keywordOn && (
        <div className="h10-spw-cs-field">
          <span className="lbl">Keyword Groups <Info size={13} className="ic" /></span>
          <span className="h10-spw-cs-hint">Each group becomes a keyword campaign per ticked match type, targeting that group&apos;s keywords.</span>
          <div className="h10-spw-cs-ktrows">
            {keywordTypes.map((kt, idx) => (
              <div className={`h10-spw-cs-ktrow ${kt.matchTypes.length === 0 ? 'warn' : ''}`} key={idx}>
                <input className="chipname" value={kt.name} onChange={(e) => renameKw(idx, e.target.value)} aria-label="Keyword type name" />
                <span className="mtlbl">Match Types</span>
                <span className="mts">{MATCHES.map((m) => <Checkbox key={m.k} label={m.label} checked={kt.matchTypes.includes(m.k)} onChange={() => toggleMatch(idx, m.k)} />)}</span>
                {kt.matchTypes.length === 0 && <span className="h10-spw-cs-warn" role="alert">Pick a match type</span>}
                <span className="h10-spw-cs-kwwrap">
                  <button type="button" className={`kwbtn ${kt.keywords.length ? 'has' : ''}`} onClick={() => setKwEditIdx(kwEditIdx === idx ? null : idx)}>{kt.keywords.length > 0 ? `${kt.keywords.length} keyword${kt.keywords.length === 1 ? '' : 's'}` : '+ Keywords'}</button>
                  {kwEditIdx === idx && <KeywordPopup initial={kt.keywords} onApply={(kws) => setKeywords(idx, kws)} onClose={() => setKwEditIdx(null)} />}
                </span>
                <button type="button" className="rm" onClick={() => removeKw(idx)} aria-label={`Remove ${kt.name}`}><X size={14} /></button>
              </div>
            ))}
            <button type="button" className="h10-spw-cs-add" onClick={addKw}><Plus size={13} /> Add</button>
          </div>
        </div>
      )}

      <div className="h10-spw-cs-field">
        <span className="lbl">Campaign Name <Info size={13} className="ic" /></span>
        <span className="h10-spw-cs-hint">Each campaign&apos;s name is built from these parts, in order.</span>
        <div className="h10-spw-cs-tokens">
          {nameTokens.map((t, i) => (
            <Fragment key={i}>
              {i > 0 && <span className="dash">–</span>}
              <TokenSelect value={t} onChange={(v) => setToken(i, v)} onRemove={() => removeToken(i)} />
            </Fragment>
          ))}
        </div>
        <button type="button" className="h10-spw-cs-add mt" onClick={addToken}><Plus size={13} /> Add</button>
      </div>

      <div className="h10-spw-cs-preview">
        <div className="ph">This creates <b>{previewNames.length}</b> campaign{previewNames.length === 1 ? '' : 's'} <span className="arr">→</span></div>
        {previewNames.length === 0 && <div className="h10-spw-cs-pwarn" role="alert">Nothing to create yet — select at least one Campaign Type, and give each keyword type a match type.</div>}
        {previewNames.length > 40 && <div className="h10-spw-cs-pwarn caution">That&apos;s a lot of campaigns — consider trimming match types or keyword types.</div>}
        {previewNames.length > 0 && (
          <ul>
            {previewNames.slice(0, 12).map((n, i) => <li key={i}>{n}</li>)}
            {previewNames.length > 12 && <li className="more">+{previewNames.length - 12} more</li>}
          </ul>
        )}
      </div>

      <label className="h10-spw-cs-remember">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <span>Remember the current settings</span>
      </label>
      <p className="h10-spw-cs-note">The <b>custom scheme</b> products do not currently support AI control.</p>
    </div>
  )
}
