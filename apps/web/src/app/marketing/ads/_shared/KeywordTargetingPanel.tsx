'use client'

/**
 * Shared inline keyword-targeting panel (Helium 10 Single Campaign match). Add Keywords via
 * three tabs — Suggested Keywords (derived from the campaign's products) / Enter New Keywords /
 * Add from My List — with a Match Type (Broad / Phrase / Exact) + Add All, feeding a "Keywords
 * Added" basket where each keyword carries its own bid. A collapsible "Advanced Negative
 * Keywords (Optional)" adds negative-exact / negative-phrase terms to a second basket.
 *
 * Lives in _shared so the richer inline editor can later replace the SP Super Wizard's modal
 * KeywordEditor too. Reuses the proven `.h10-spw-ps-*` two-panel chrome for visual lockstep
 * with Product Selection; `.h10-scb-tgt-*` adds the match-type row, bid cell + match badges.
 */
import { useState } from 'react'
import { Trash2, X, ChevronsUpDown, ChevronDown, Plus } from 'lucide-react'

export type KwMatch = 'BROAD' | 'PHRASE' | 'EXACT'
export type NegMatch = 'EXACT' | 'PHRASE'
export interface KwBid { text: string; matchType: KwMatch; bidEur: string }
export interface NegKw { text: string; matchType: NegMatch }

const MATCH_LABEL: Record<KwMatch, string> = { BROAD: 'Broad', PHRASE: 'Phrase', EXACT: 'Exact' }

export function KeywordTargetingPanel({ keywords, setKeywords, negKeywords, setNegKeywords, suggestions, defaultBid, currency = '€' }: {
  keywords: KwBid[]
  setKeywords: (v: KwBid[]) => void
  negKeywords: NegKw[]
  setNegKeywords: (v: NegKw[]) => void
  suggestions: string[]
  defaultBid: string
  currency?: string
}) {
  const [tab, setTab] = useState<'suggested' | 'enter' | 'mylist'>('suggested')
  const [match, setMatch] = useState<KwMatch>('BROAD')
  const [enterText, setEnterText] = useState('')
  const [negOpen, setNegOpen] = useState(true)
  const [negMatch, setNegMatch] = useState<NegMatch>('EXACT')
  const [negText, setNegText] = useState('')

  const key = (t: string, m: KwMatch) => `${t.toLowerCase()}|${m}`
  const addedSet = new Set(keywords.map((k) => key(k.text, k.matchType)))
  const addMany = (texts: string[]) => {
    const seen = new Set(addedSet); const next = [...keywords]
    for (const t0 of texts) { const t = t0.trim(); if (!t) continue; const k = key(t, match); if (!seen.has(k)) { seen.add(k); next.push({ text: t, matchType: match, bidEur: defaultBid || '' }) } }
    setKeywords(next)
  }
  const removeKw = (i: number) => setKeywords(keywords.filter((_, idx) => idx !== i))
  const setKwBid = (i: number, bid: string) => setKeywords(keywords.map((k, idx) => (idx === i ? { ...k, bidEur: bid } : k)))
  const shown = suggestions.filter((s) => !addedSet.has(key(s, match)))

  const addNeg = () => {
    const toks = negText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean); if (!toks.length) return
    const seen = new Set(negKeywords.map((n) => `${n.text.toLowerCase()}|${n.matchType}`)); const next = [...negKeywords]
    for (const t of toks) { const k = `${t.toLowerCase()}|${negMatch}`; if (!seen.has(k)) { seen.add(k); next.push({ text: t, matchType: negMatch }) } }
    setNegKeywords(next); setNegText('')
  }

  return (
    <div className="h10-scb-tgt">
      <div className="h10-spw-ps">
        <div className="h10-spw-ps-left">
          <div className="h10-spw-ps-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'suggested'} className={tab === 'suggested' ? 'on' : ''} onClick={() => setTab('suggested')}>Suggested Keywords</button>
            <button type="button" role="tab" aria-selected={tab === 'enter'} className={tab === 'enter' ? 'on' : ''} onClick={() => setTab('enter')}>Enter New Keywords</button>
            <button type="button" role="tab" aria-selected={tab === 'mylist'} className={tab === 'mylist' ? 'on' : ''} onClick={() => setTab('mylist')}>Add from My List</button>
          </div>
          <div className="h10-scb-tgt-mt">
            <span className="lbl">Match Type:</span>
            {(['BROAD', 'PHRASE', 'EXACT'] as KwMatch[]).map((m) => (
              <label key={m} className={match === m ? 'on' : ''}><input type="radio" name="scb-kwmatch" checked={match === m} onChange={() => setMatch(m)} /> {MATCH_LABEL[m]}</label>
            ))}
            <span className="grow" />
            <button type="button" className="addall" disabled={tab !== 'suggested' || !shown.length} onClick={() => addMany(shown)}><Plus size={13} /> Add All</button>
          </div>
          {tab === 'suggested' ? (
            <div className="h10-spw-ps-list">
              {shown.length === 0 ? (
                <div className="h10-spw-ps-empty">{suggestions.length ? 'All suggested keywords added.' : 'Select products above to see suggested keywords.'}</div>
              ) : shown.map((s) => (
                <div className="row" key={s}>
                  <span className="h10-scb-tgt-kw" title={s}>{s}</span>
                  <button type="button" className="addbtn" onClick={() => addMany([s])}><Plus size={13} /> Add</button>
                </div>
              ))}
            </div>
          ) : tab === 'enter' ? (
            <div className="h10-scb-tgt-enter">
              <textarea value={enterText} onChange={(e) => setEnterText(e.target.value)} placeholder="Enter one keyword per line" aria-label="Enter keywords" />
              <button type="button" className="h10-scb-tgt-add" disabled={!enterText.trim()} onClick={() => { addMany(enterText.split('\n')); setEnterText('') }}><Plus size={13} /> Add</button>
            </div>
          ) : (
            <div className="h10-scb-tgt-mylist">No saved keyword lists yet. Build one from the keyword research tools, then add it here.</div>
          )}
        </div>

        <div className="h10-spw-ps-right">
          <div className="h10-spw-ps-rh">
            <b>{keywords.length} Keyword{keywords.length === 1 ? '' : 's'} Added</b>
            <button type="button" className="rm" disabled={!keywords.length} onClick={() => setKeywords([])}><Trash2 size={12} /> Remove All</button>
          </div>
          <div className="h10-spw-ps-rcol sv"><span className="pcol">Keyword <ChevronsUpDown size={11} /></span><span className="svcol">Bid</span></div>
          <div className="h10-spw-ps-rlist">
            {keywords.length === 0 ? <div className="h10-spw-ps-nodata">No data</div> : keywords.map((k, i) => (
              <div className="row" key={`${k.text}|${k.matchType}|${i}`}>
                <span className="h10-scb-tgt-kw bskt" title={k.text}>{k.text} <span className={`h10-scb-tgt-mtag ${k.matchType.toLowerCase()}`}>{MATCH_LABEL[k.matchType]}</span></span>
                <span className="h10-scb-tgt-bid"><span className="pf">{currency}</span><input inputMode="decimal" value={k.bidEur} onChange={(e) => setKwBid(i, e.target.value)} placeholder="0.00" aria-label={`Bid for ${k.text}`} /></span>
                <button type="button" className="x" onClick={() => removeKw(i)} aria-label={`Remove ${k.text}`}><X size={14} /></button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <button type="button" className="h10-scb-tgt-adv" aria-expanded={negOpen} onClick={() => setNegOpen((o) => !o)}><ChevronDown size={15} className={negOpen ? 'up' : ''} /> Advanced Negative Keywords (Optional)</button>
      {negOpen && (
        <div className="h10-spw-ps">
          <div className="h10-spw-ps-left">
            <div className="h10-scb-tgt-mt">
              <span className="lbl">Match Type:</span>
              <label className={negMatch === 'EXACT' ? 'on' : ''}><input type="radio" name="scb-negmatch" checked={negMatch === 'EXACT'} onChange={() => setNegMatch('EXACT')} /> Negative Exact</label>
              <label className={negMatch === 'PHRASE' ? 'on' : ''}><input type="radio" name="scb-negmatch" checked={negMatch === 'PHRASE'} onChange={() => setNegMatch('PHRASE')} /> Negative Phrase</label>
            </div>
            <div className="h10-scb-tgt-enter">
              <textarea value={negText} onChange={(e) => setNegText(e.target.value)} placeholder="Enter or paste negative keywords here" aria-label="Negative keywords" />
              <button type="button" className="h10-scb-tgt-add" disabled={!negText.trim()} onClick={addNeg}>Add Negative Keywords</button>
            </div>
          </div>
          <div className="h10-spw-ps-right">
            <div className="h10-spw-ps-rh">
              <b>{negKeywords.length} Negative Keyword{negKeywords.length === 1 ? '' : 's'} Added</b>
              <button type="button" className="rm" disabled={!negKeywords.length} onClick={() => setNegKeywords([])}><Trash2 size={12} /> Remove All</button>
            </div>
            <div className="h10-spw-ps-rcol">Keyword <ChevronsUpDown size={11} /></div>
            <div className="h10-spw-ps-rlist">
              {negKeywords.length === 0 ? <div className="h10-spw-ps-nodata">No data</div> : negKeywords.map((n, i) => (
                <div className="row" key={`${n.text}|${n.matchType}|${i}`}>
                  <span className="h10-scb-tgt-kw bskt" title={n.text}>{n.text} <span className={`h10-scb-tgt-mtag ${n.matchType === 'PHRASE' ? 'phrase' : 'exact'}`}>{n.matchType === 'PHRASE' ? 'Neg Phrase' : 'Neg Exact'}</span></span>
                  <button type="button" className="x" onClick={() => setNegKeywords(negKeywords.filter((_, idx) => idx !== i))} aria-label={`Remove ${n.text}`}><X size={14} /></button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** Derive suggested keyword phrases from the selected products' titles (bi/tri-grams, brand &
 *  stop-words stripped) — a data-grounded stand-in for Amazon's suggested keywords. */
export function deriveKeywordSuggestions(names: string[]): string[] {
  const STOP = new Set(['da', 'di', 'per', 'con', 'del', 'della', 'il', 'la', 'le', 'lo', 'un', 'una', 'uno', 'e', 'the', 'for', 'with', 'and', 'set', 'pz'])
  const BRAND = new Set(['xavia'])
  const phrases = new Set<string>()
  for (const name of names.slice(0, 10)) {
    const words = name.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w) && !BRAND.has(w) && !/^\d+$/.test(w))
    for (let i = 0; i < words.length - 1; i++) phrases.add(words.slice(i, i + 2).join(' '))
    for (let i = 0; i < words.length - 2; i++) phrases.add(words.slice(i, i + 3).join(' '))
  }
  return [...phrases].slice(0, 24)
}
