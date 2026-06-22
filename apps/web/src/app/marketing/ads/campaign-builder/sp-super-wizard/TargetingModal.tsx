'use client'

/**
 * SPW.5 / NT.3 — per-row Targeting / Negative-Targeting editor for Step 2.
 * Positive targeting edits a flat keyword list (the campaign's match type applies)
 * or product targets. Negative targeting edits match-typed negative keywords
 * (negative-exact / negative-phrase) — and shows, read-only, the negatives the
 * funnel added automatically (NT.1) so the operator sees the full isolation picture.
 * Reuses the established h10-neg-* staging pattern + the wizard's ProductSelection.
 */
import { useEffect, useState } from 'react'
import { X, Trash2, ChevronsUpDown } from 'lucide-react'
import { ProductSelection, type SpwProduct } from './ProductSelection'
import { AUTO_GROUP_META, type SpwCampaign, type NegKeyword, type NegMatch, type AutoGroup } from './CampaignSetup'

function KeywordEditor({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState('')
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
        <textarea className="h10-neg-ta" value={text} onChange={(e) => setText(e.target.value)} placeholder="Enter one keyword per line" aria-label="Keywords" />
        <button type="button" className="h10-neg-add" disabled={!text.trim()} onClick={stage}>Add Keyword</button>
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

const negMatchLabel = (m: NegMatch) => (m === 'EXACT' ? 'Neg Exact' : 'Neg Phrase')

/** Negative-keyword editor: each negative carries its own match type, and the
 *  funnel's auto-negatives render above your manual ones, read-only + badged. */
function NegKeywordEditor({ manual, auto, onChange }: { manual: NegKeyword[]; auto: NegKeyword[]; onChange: (v: NegKeyword[]) => void }) {
  const [text, setText] = useState('')
  const [mt, setMt] = useState<NegMatch>('EXACT')
  const stage = () => {
    const kws = text.split('\n').map((s) => s.trim()).filter(Boolean)
    if (!kws.length) return
    const seen = new Set(manual.map((v) => `${v.text.toLowerCase()}|${v.matchType}`))
    const next = [...manual]
    for (const kw of kws) { const k = `${kw.toLowerCase()}|${mt}`; if (!seen.has(k)) { seen.add(k); next.push({ text: kw, matchType: mt }) } }
    onChange(next); setText('')
  }
  return (
    <div className="h10-neg-cols">
      <div className="h10-neg-left">
        <div className="h10-neg-mt">
          <span className="lbl">Match Type:</span>
          <label className={mt === 'EXACT' ? 'on' : ''}><input type="radio" name="spwnegmt" checked={mt === 'EXACT'} onChange={() => setMt('EXACT')} /> Negative Exact</label>
          <label className={mt === 'PHRASE' ? 'on' : ''}><input type="radio" name="spwnegmt" checked={mt === 'PHRASE'} onChange={() => setMt('PHRASE')} /> Negative Phrase</label>
        </div>
        <textarea className="h10-neg-ta" value={text} onChange={(e) => setText(e.target.value)} placeholder="Enter one keyword per line" aria-label="Negative keywords" />
        <button type="button" className="h10-neg-add" disabled={!text.trim()} onClick={stage}>Add Keywords</button>
      </div>
      <div className="h10-neg-right">
        <div className="h10-neg-rh">
          <span>{manual.length} Added{auto.length ? ` · ${auto.length} auto` : ''}</span>
          <button type="button" className="h10-neg-rmall" disabled={!manual.length} onClick={() => onChange([])}><Trash2 size={14} /> Remove All</button>
        </div>
        <div className="h10-neg-lh"><span>Keyword</span><ChevronsUpDown size={13} /></div>
        <div className="h10-neg-list">
          {auto.length === 0 && manual.length === 0 ? <div className="h10-neg-empty">No data</div> : (
            <>
              {auto.map((n, i) => (
                <div className="h10-neg-row auto" key={`a|${n.text}|${n.matchType}|${i}`}>
                  <span className="kw" title={n.text}>{n.text}</span>
                  <span className={`h10-neg-mtag ${n.matchType === 'PHRASE' ? 'ph' : 'ex'}`}>{negMatchLabel(n.matchType)}</span>
                  <span className="h10-neg-auto" title="Added automatically by the negative funnel — toggle it off in Structure to drop these.">auto</span>
                </div>
              ))}
              {manual.map((n, i) => (
                <div className="h10-neg-row" key={`m|${n.text}|${n.matchType}|${i}`}>
                  <span className="kw" title={n.text}>{n.text}</span>
                  <span className={`h10-neg-mtag ${n.matchType === 'PHRASE' ? 'ph' : 'ex'}`}>{negMatchLabel(n.matchType)}</span>
                  <button type="button" className="rm" onClick={() => onChange(manual.filter((_, idx) => idx !== i))} aria-label={`Remove ${n.text}`}><X size={13} /></button>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** AT.1 — Auto-campaign targeting = the 4 Amazon auto groups, each with an on/off
 *  switch + its own bid (seeded by AT.2's intent-based smart defaults). */
function AutoTargetingEditor({ groups, currency, onChange }: { groups: AutoGroup[]; currency: string; onChange: (v: AutoGroup[]) => void }) {
  const toggle = (key: string) => onChange(groups.map((g) => (g.key === key ? { ...g, enabled: !g.enabled } : g)))
  const setBid = (key: string, bid: string) => onChange(groups.map((g) => (g.key === key ? { ...g, bid } : g)))
  return (
    <div className="h10-spw-auto-ed">
      {groups.map((g) => {
        const meta = AUTO_GROUP_META.find((m) => m.key === g.key)!
        return (
          <div className={`row ${g.enabled ? '' : 'off'}`} key={g.key}>
            <input type="checkbox" className="h10-spw-sw" checked={g.enabled} onChange={() => toggle(g.key)} aria-label={`Enable ${meta.label}`} />
            <div className="nm"><span className="t">{meta.label}</span><span className="d">{meta.desc}</span></div>
            <div className="bid">
              <div className="money"><span className="pf">{currency}</span><input inputMode="decimal" value={g.bid} disabled={!g.enabled} onChange={(e) => setBid(g.key, e.target.value)} aria-label={`${meta.label} bid`} /></div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function TargetingModal({ campaign, mode, autoNegate, currency = '€', onClose, onSave }: {
  campaign: SpwCampaign
  mode: 'targeting' | 'negative'
  autoNegate?: boolean
  currency?: string
  onClose: () => void
  onSave: (patch: Partial<SpwCampaign>) => void
}) {
  const isNeg = mode === 'negative'
  const isAutoTgt = !isNeg && campaign.kind === 'auto' // Auto's positive "targeting" = the 4 auto groups
  const [kw, setKw] = useState<string[]>(campaign.keywords)
  const [negKw, setNegKw] = useState<NegKeyword[]>(campaign.negKeywords.filter((n) => !n.auto))
  const [autoGroups, setAutoGroups] = useState<AutoGroup[]>(campaign.autoGroups)
  const autoNegs = campaign.negKeywords.filter((n) => n.auto)
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
    if (isNeg) onSave({ negKeywords: negKw, negProducts: prods })
    else if (isAutoTgt) onSave({ autoGroups })
    else if (productOnly) onSave({ productTargets: prods })
    else onSave({ keywords: kw })
    onClose()
  }

  const title = isNeg ? 'Set Negative Targeting' : isAutoTgt ? 'Set Auto Targeting' : 'Set Targeting'
  return (
    <div className="h10-modal-backdrop" onClick={onClose}>
      <div className={`h10-modal ${hasProduct ? 'wide' : 'neg'}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="h10-modal-h"><b>{title} — {campaign.name}</b><button type="button" className="h10-modal-x" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
        <div className="h10-modal-b">
          {isNeg && autoNegate && autoNegs.length > 0 && active === 'kw' && (
            <p className="h10-neg-autonote">{autoNegs.length} negative{autoNegs.length === 1 ? '' : 's'} added automatically by the funnel (badged <b>auto</b> below). Add your own on top — turn the funnel off in Structure to drop the auto ones.</p>
          )}
          {showTabs && (
            <div className="h10-spw-tgt-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === 'kw'} className={tab === 'kw' ? 'on' : ''} onClick={() => setTab('kw')}>Negative Keywords</button>
              <button type="button" role="tab" aria-selected={tab === 'prod'} className={tab === 'prod' ? 'on' : ''} onClick={() => setTab('prod')}>Negative Products</button>
            </div>
          )}
          {isAutoTgt && <p className="h10-neg-autonote">Amazon splits Auto targeting into 4 groups — toggle each on/off and bid it separately. Bids are pre-set by intent (Close &amp; Substitutes higher, Loose &amp; Complements lower); adjust as you like.</p>}
          {active === 'prod' ? (
            <ProductSelection products={prods} setProducts={setProds} />
          ) : isAutoTgt ? (
            <AutoTargetingEditor groups={autoGroups} currency={currency} onChange={setAutoGroups} />
          ) : isNeg ? (
            <NegKeywordEditor manual={negKw} auto={autoNegs} onChange={setNegKw} />
          ) : (
            <KeywordEditor value={kw} onChange={setKw} />
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
