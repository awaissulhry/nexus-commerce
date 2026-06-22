'use client'

/**
 * SPW.5 — per-row Targeting / Negative-Targeting editor for Step 2 (Helium 10-style).
 * Opened from a campaign row's "Edit". Reuses the established keyword-staging pattern
 * (h10-neg-*) for keywords and the wizard's ProductSelection two-panel for product
 * targets — keyword campaigns edit keywords, PAT campaigns edit products, and an Auto
 * campaign's negatives edit both (tabbed). Edits are local to the wizard draft (applied
 * at launch in SPW.7); counts on the table update live and clear the "not set" guard.
 * (This editor isn't shown in the recording — built from the existing H10 patterns.)
 */
import { useEffect, useState } from 'react'
import { X, Trash2, ChevronsUpDown } from 'lucide-react'
import { ProductSelection, type SpwProduct } from './ProductSelection'
import type { SpwCampaign } from './CampaignSetup'

function KeywordEditor({ value, onChange, negative }: { value: string[]; onChange: (v: string[]) => void; negative?: boolean }) {
  const [text, setText] = useState('')
  const [mt, setMt] = useState<'EXACT' | 'PHRASE'>('EXACT')
  const stage = () => {
    const kws = text.split('\n').map((s) => s.trim()).filter(Boolean)
    if (!kws.length) return
    const seen = new Set(value.map((v) => v.toLowerCase()))
    const next = [...value]
    for (const kw of kws) { if (!seen.has(kw.toLowerCase())) { seen.add(kw.toLowerCase()); next.push(kw) } }
    onChange(next); setText('')
  }
  return (
    <div className="h10-neg-cols">
      <div className="h10-neg-left">
        {negative && (
          <div className="h10-neg-mt">
            <span className="lbl">Match Type:</span>
            <label className={mt === 'EXACT' ? 'on' : ''}><input type="radio" name="spwnegmt" checked={mt === 'EXACT'} onChange={() => setMt('EXACT')} /> Negative Exact</label>
            <label className={mt === 'PHRASE' ? 'on' : ''}><input type="radio" name="spwnegmt" checked={mt === 'PHRASE'} onChange={() => setMt('PHRASE')} /> Negative Phrase</label>
          </div>
        )}
        <textarea className="h10-neg-ta" value={text} onChange={(e) => setText(e.target.value)} placeholder="Enter one keyword per line" aria-label="Keywords" />
        <button type="button" className="h10-neg-add" disabled={!text.trim()} onClick={stage}>Add Keyword{negative ? 's' : ''}</button>
      </div>
      <div className="h10-neg-right">
        <div className="h10-neg-rh">
          <span>{value.length} Keyword{value.length === 1 ? '' : 's'} Added</span>
          <button type="button" className="h10-neg-rmall" disabled={!value.length} onClick={() => onChange([])}><Trash2 size={14} /> Remove All</button>
        </div>
        <div className="h10-neg-lh"><span>Keyword</span><ChevronsUpDown size={13} /></div>
        <div className="h10-neg-list">
          {value.length === 0 ? <div className="h10-neg-empty">No data</div> : value.map((kw, i) => (
            <div className="h10-neg-row" key={`${kw}|${i}`}>
              <span className="kw" title={kw}>{kw}</span>
              <button type="button" className="rm" onClick={() => onChange(value.filter((_, idx) => idx !== i))} aria-label={`Remove ${kw}`}><X size={13} /></button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function TargetingModal({ campaign, mode, onClose, onSave }: {
  campaign: SpwCampaign
  mode: 'targeting' | 'negative'
  onClose: () => void
  onSave: (patch: Partial<SpwCampaign>) => void
}) {
  const isNeg = mode === 'negative'
  const [kw, setKw] = useState<string[]>(isNeg ? campaign.negKeywords : campaign.keywords)
  const [prods, setProds] = useState<SpwProduct[]>(isNeg ? campaign.negProducts : campaign.productTargets)
  const showTabs = isNeg && campaign.kind === 'auto' // Auto negatives = keywords + products
  const productOnly = campaign.kind === 'pat'
  const [tab, setTab] = useState<'kw' | 'prod'>(productOnly ? 'prod' : 'kw')
  const hasProduct = productOnly || showTabs
  const active: 'kw' | 'prod' = showTabs ? tab : productOnly ? 'prod' : 'kw'

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
  }, [onClose])

  const save = () => {
    if (isNeg) onSave({ negKeywords: kw, negProducts: prods })
    else if (productOnly) onSave({ productTargets: prods })
    else onSave({ keywords: kw })
    onClose()
  }

  const title = isNeg ? 'Set Negative Targeting' : 'Set Targeting'
  return (
    <div className="h10-modal-backdrop" onClick={onClose}>
      <div className={`h10-modal ${hasProduct ? 'wide' : 'neg'}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="h10-modal-h"><b>{title} — {campaign.name}</b><button type="button" className="h10-modal-x" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
        <div className="h10-modal-b">
          {showTabs && (
            <div className="h10-spw-tgt-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === 'kw'} className={tab === 'kw' ? 'on' : ''} onClick={() => setTab('kw')}>Negative Keywords</button>
              <button type="button" role="tab" aria-selected={tab === 'prod'} className={tab === 'prod' ? 'on' : ''} onClick={() => setTab('prod')}>Negative Products</button>
            </div>
          )}
          {active === 'prod' ? (
            <ProductSelection products={prods} setProducts={setProds} />
          ) : (
            <KeywordEditor value={kw} onChange={setKw} negative={isNeg} />
          )}
        </div>
        <div className="h10-modal-f">
          <button type="button" className="h10-am-btn" onClick={onClose}>Cancel</button>
          <span className="grow" />
          <button type="button" className="h10-am-btn primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  )
}
