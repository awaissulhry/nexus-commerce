'use client'

/**
 * SPW.3 — Custom Scheme (Helium 10 match). The naming-rule builder shown when the
 * Structure mode is "Custom Scheme": editable Keyword-Type chips (+ a keyword popup
 * on Add) and a Campaign-Name token sequence (Campaign Type / Targeting Type / Match
 * Type / Keyword Type / Asin / Customize, dash-joined, each removable). Custom scheme
 * does not support AI control (noted inline).
 */
import { type Dispatch, type SetStateAction, Fragment, useEffect, useRef, useState } from 'react'
import { Info, Plus, X, ChevronDown } from 'lucide-react'

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

function KeywordPopup({ onApply, onClose }: { onApply: (text: string) => void; onClose: () => void }) {
  const [text, setText] = useState('')
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="h10-spw-cs-pop" role="dialog" aria-label="Add keyword type">
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Please Enter one keyword per line" autoFocus />
      <div className="ft">
        <button type="button" className="cancel" onClick={onClose}>Cancel</button>
        <button type="button" className="apply" onClick={() => onApply(text)}>Apply</button>
      </div>
    </div>
  )
}

export function CustomScheme({ keywordTypes, setKeywordTypes, nameTokens, setNameTokens, remember, setRemember }: {
  keywordTypes: string[]
  setKeywordTypes: Dispatch<SetStateAction<string[]>>
  nameTokens: string[]
  setNameTokens: Dispatch<SetStateAction<string[]>>
  remember: boolean
  setRemember: (v: boolean) => void
}) {
  const [popup, setPopup] = useState(false)
  const removeKw = (k: string) => setKeywordTypes((cur) => cur.filter((x) => x !== k))
  const addKw = () => {
    setKeywordTypes((cur) => [...cur, `Custom ${cur.filter((k) => k.startsWith('Custom')).length + 1}`])
    setPopup(false)
  }
  const setToken = (i: number, v: string) => setNameTokens((cur) => cur.map((t, idx) => (idx === i ? v : t)))
  const removeToken = (i: number) => setNameTokens((cur) => cur.filter((_, idx) => idx !== i))
  const addToken = () => setNameTokens((cur) => [...cur, ''])

  return (
    <div className="h10-spw-cs">
      <div className="h10-spw-cs-title">Structure Setting</div>

      <div className="h10-spw-cs-field">
        <span className="lbl">Keyword Type <Info size={13} className="ic" /></span>
        <div className="h10-spw-cs-chips">
          {keywordTypes.map((k) => (
            <span className="chip" key={k}>{k}<button type="button" onClick={() => removeKw(k)} aria-label={`Remove ${k}`}><X size={12} /></button></span>
          ))}
          <span className="h10-spw-cs-addwrap">
            <button type="button" className="h10-spw-cs-add" onClick={() => setPopup(true)}><Plus size={13} /> Add</button>
            {popup && <KeywordPopup onApply={addKw} onClose={() => setPopup(false)} />}
          </span>
        </div>
      </div>

      <div className="h10-spw-cs-field">
        <span className="lbl">Campaign Name <Info size={13} className="ic" /></span>
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

      <label className="h10-spw-cs-remember">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <span>Remember the current settings</span>
      </label>
      <p className="h10-spw-cs-note">The <b>custom scheme</b> products do not currently support AI control.</p>
    </div>
  )
}
