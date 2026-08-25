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
import { Button, Input, Textarea, ToolbarButton } from '@/design-system/primitives'
import { Tabs } from '@/design-system/components/Tabs'
import './keyword-targeting.css'

export type KwMatch = 'BROAD' | 'PHRASE' | 'EXACT'
export type NegMatch = 'EXACT' | 'PHRASE'
export interface KwBid { text: string; matchType: KwMatch; bidEur: string }
export interface NegKw { text: string; matchType: NegMatch }

const MATCH_LABEL: Record<KwMatch, string> = { BROAD: 'Broad', PHRASE: 'Phrase', EXACT: 'Exact' }

export function KeywordTargetingPanel({ keywords, setKeywords, negKeywords, setNegKeywords, suggestions, defaultBid, currency = '€', lockedMatch, showBids, hideNegatives }: {
  keywords: KwBid[]
  setKeywords: (v: KwBid[]) => void
  negKeywords: NegKw[]
  setNegKeywords: (v: NegKw[]) => void
  suggestions: string[]
  defaultBid: string
  currency?: string
  // Adoption knobs (SP Super Wizard): campaign defines the match type → hide the selector;
  // ad-group bids → hide the per-keyword bid column; its own negative editor → hide negatives.
  lockedMatch?: KwMatch
  showBids?: boolean
  hideNegatives?: boolean
}) {
  const [tab, setTab] = useState<'suggested' | 'enter' | 'mylist'>('suggested')
  const [matchState, setMatchState] = useState<KwMatch>('BROAD')
  const match = lockedMatch ?? matchState
  const bids = showBids !== false
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
          {/* `.h10-spw-ps-tabs` dropped, not kept: its `button` rule (0,1,1) would restyle
              `.nds-tab`. Only its 14px bottom margin is re-homed here. */}
          <div style={{ marginBottom: 14 }}>
            <Tabs
              tabs={[{ id: 'suggested', label: 'Suggested Keywords' }, { id: 'enter', label: 'Enter New Keywords' }, { id: 'mylist', label: 'Add from My List' }]}
              active={tab}
              onChange={(id) => setTab(id as 'suggested' | 'enter' | 'mylist')}
            />
          </div>
          <div className="h10-scb-tgt-mt">
            {!lockedMatch && <>
              <span className="lbl">Match Type:</span>
              {(['BROAD', 'PHRASE', 'EXACT'] as KwMatch[]).map((m) => (
                <label key={m} className={match === m ? 'on' : ''}><input type="radio" name="scb-kwmatch" checked={match === m} onChange={() => setMatchState(m)} /> {MATCH_LABEL[m]}</label>
              ))}
            </>}
            <span className="grow" />
            <Button variant="link" size="xs" disabled={tab !== 'suggested' || !shown.length} onClick={() => addMany(shown)}><Plus size={13} /> Add All</Button>
          </div>
          {tab === 'suggested' ? (
            <div className="h10-spw-ps-list">
              {shown.length === 0 ? (
                <div className="h10-spw-ps-empty">{suggestions.length ? 'All suggested keywords added.' : 'Select products above to see suggested keywords.'}</div>
              ) : shown.map((s) => (
                <div className="row" key={s}>
                  <span className="h10-scb-tgt-kw" title={s}>{s}</span>
                  <Button variant="link" size="sm" onClick={() => addMany([s])}><Plus size={13} /> Add</Button>
                </div>
              ))}
            </div>
          ) : tab === 'enter' ? (
            <div className="h10-scb-tgt-enter">
              {/* minHeight pins the old 150px: the DS default is 168 and this textarea sits beside
                  a fixed-height basket, so the extra 18px would unbalance the two panels. */}
              <Textarea value={enterText} onChange={(e) => setEnterText(e.target.value)} placeholder="Enter one keyword per line" aria-label="Enter keywords" style={{ minHeight: 150 }} />
              <Button variant="primary" style={{ alignSelf: 'flex-start' }} disabled={!enterText.trim()} onClick={() => { addMany(enterText.split('\n')); setEnterText('') }}><Plus size={13} /> Add</Button>
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
          {bids ? (
            <div className="h10-spw-ps-rcol sv"><span className="pcol">Keyword <ChevronsUpDown size={11} /></span><span className="svcol">Bid</span></div>
          ) : (
            <div className="h10-spw-ps-rcol">Keyword <ChevronsUpDown size={11} /></div>
          )}
          <div className="h10-spw-ps-rlist">
            {keywords.length === 0 ? <div className="h10-spw-ps-nodata">No data</div> : keywords.map((k, i) => (
              <div className="row" key={`${k.text}|${k.matchType}|${i}`}>
                <span className="h10-scb-tgt-kw bskt" title={k.text}>{k.text} <span className={`h10-scb-tgt-mtag ${k.matchType.toLowerCase()}`}>{MATCH_LABEL[k.matchType]}</span></span>
                {bids && <Input prefix={currency} inputMode="decimal" value={k.bidEur} onChange={(e) => setKwBid(i, e.target.value)} placeholder="0.00" aria-label={`Bid for ${k.text}`} style={{ width: 56 }} />}
                <ToolbarButton size="sm" tooltip={false} icon={<X size={14} />} label={`Remove ${k.text}`} onClick={() => removeKw(i)} />
              </div>
            ))}
          </div>
        </div>
      </div>

      {!hideNegatives && (<>
      {/* The chevron rotates inline, not via `.h10-scb-tgt-adv svg.up`: that rule is scoped to the
          class this drops, so it would have become a silently static chevron. */}
      <Button variant="link" style={{ margin: '18px 0 14px', fontWeight: 700 }} aria-expanded={negOpen} onClick={() => setNegOpen((o) => !o)}>
        <ChevronDown size={15} style={{ transform: negOpen ? 'rotate(180deg)' : undefined, transition: 'transform .15s' }} /> Advanced Negative Keywords (Optional)
      </Button>
      {negOpen && (
        <div className="h10-spw-ps">
          <div className="h10-spw-ps-left">
            <div className="h10-scb-tgt-mt">
              <span className="lbl">Match Type:</span>
              <label className={negMatch === 'EXACT' ? 'on' : ''}><input type="radio" name="scb-negmatch" checked={negMatch === 'EXACT'} onChange={() => setNegMatch('EXACT')} /> Negative Exact</label>
              <label className={negMatch === 'PHRASE' ? 'on' : ''}><input type="radio" name="scb-negmatch" checked={negMatch === 'PHRASE'} onChange={() => setNegMatch('PHRASE')} /> Negative Phrase</label>
            </div>
            <div className="h10-scb-tgt-enter">
              <Textarea value={negText} onChange={(e) => setNegText(e.target.value)} placeholder="Enter or paste negative keywords here" aria-label="Negative keywords" style={{ minHeight: 150 }} />
              <Button variant="primary" style={{ alignSelf: 'flex-start' }} disabled={!negText.trim()} onClick={addNeg}>Add Negative Keywords</Button>
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
                  <ToolbarButton size="sm" tooltip={false} icon={<X size={14} />} label={`Remove ${n.text}`} onClick={() => setNegKeywords(negKeywords.filter((_, idx) => idx !== i))} />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      </>)}
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
