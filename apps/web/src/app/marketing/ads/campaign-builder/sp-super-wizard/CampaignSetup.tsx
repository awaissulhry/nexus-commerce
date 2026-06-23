'use client'

/**
 * SPW.4 — Step 2 "Campaign Setup" (Helium 10 match). The campaigns generated from the
 * step-1 structure render in an editable table: × delete · campaign-name input + ad-group
 * sub-row · Match/Keyword type · Default Bid + Budget (currency inputs with a Suggested
 * range) · Targeting / Negative Targeting (counts + Edit). Restore Default regenerates.
 * Per the build decision this is a purpose-built table (not AdsDataGrid — that grid is
 * hardwired for filter/sort/pager); the per-row Edit drawers land in SPW.5.
 */
import { type Dispatch, type SetStateAction, useEffect, useState } from 'react'
import { X, Layers, Pencil, RotateCcw, Plus, Trash2, ChevronDown } from 'lucide-react'
import { Modal } from '@/design-system/components'
import { Button, Input, Radio, Textarea } from '@/design-system/primitives'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import { standardRows, advancedRows } from './StructureSelection'
import { ProductSelection, type SpwProduct } from './ProductSelection'
import type { CustomKeywordType, TargetingKind, MatchTypeKey } from './CustomScheme'

// AT.1 — Amazon SP Auto-targeting groups. Each is independently enable/disable-able
// and separately biddable (Amazon defaults all four on at the campaign bid).
export type AutoGroupKey = 'CLOSE_MATCH' | 'LOOSE_MATCH' | 'SUBSTITUTES' | 'COMPLEMENTS'
export type AutoGroup = { key: AutoGroupKey; enabled: boolean; bid: string }
export const AUTO_GROUP_META: Array<{ key: AutoGroupKey; label: string; desc: string }> = [
  { key: 'CLOSE_MATCH', label: 'Close match', desc: 'Shoppers using search terms closely related to your product.' },
  { key: 'LOOSE_MATCH', label: 'Loose match', desc: 'Shoppers using search terms loosely related to your product.' },
  { key: 'SUBSTITUTES', label: 'Substitutes', desc: 'Shoppers viewing detail pages of products similar to yours.' },
  { key: 'COMPLEMENTS', label: 'Complements', desc: 'Shoppers viewing detail pages of products that complement yours.' },
]
// AT.2 — intent-based smart default bids (× the campaign default): Close & Substitutes
// lean higher (buy intent / conquesting), Loose & Complements lower (discovery / cross-sell).
const AUTO_GROUP_MULT: Record<AutoGroupKey, number> = { CLOSE_MATCH: 1.0, SUBSTITUTES: 1.1, LOOSE_MATCH: 0.65, COMPLEMENTS: 0.6 }
export const defaultAutoGroups = (defaultBid: number): AutoGroup[] =>
  AUTO_GROUP_META.map((g) => ({ key: g.key, enabled: true, bid: (defaultBid * AUTO_GROUP_MULT[g.key]).toFixed(2) }))

export type NegMatch = 'EXACT' | 'PHRASE'
/** A negative keyword carries its own match type (Amazon SP only supports
 *  negative-exact / negative-phrase). `auto` marks ones the funnel created — they
 *  show read-only + badged in the drawer and are recomputed, never hand-edited. */
export type NegKeyword = { text: string; matchType: NegMatch; auto?: boolean }

export type SpwCampaign = {
  id: string; name: string; adGroupName: string
  matchType: string; keywordType: string; kind: 'auto' | 'keyword' | 'pat'
  bid: string; budget: string; sugBid: number; sugBudget: number
  keywords: string[]; productTargets: SpwProduct[]; negKeywords: NegKeyword[]; negProducts: SpwProduct[]
  autoGroups: AutoGroup[]
}

const SUG_LOW = 0.727, SUG_HIGH = 1.273
const DEFAULT_BID = 0.75, DEFAULT_BUDGET = 10

const matchTok = (m: string) => (m === 'Broad & Phrase & Exact' ? '' : m)
function campaignName(grp: string, kind: SpwCampaign['kind'], m: string, k: string): string {
  const g = grp.trim() || 'Campaign'
  if (kind === 'auto') return `${g}-SP-Auto`
  if (kind === 'pat') return `${g}-SP-PAT`
  const tok = matchTok(m)
  return `${g}-SP-Keyword-${k}${tok ? `-${tok}` : ''}`
}

const matchLabel = (m: MatchTypeKey): string => (m === 'PHRASE' ? 'Phrase' : m === 'EXACT' ? 'Exact' : 'Broad')
/** Custom-scheme cross-product: Auto + PAT (if chosen) + each keyword type × each of its match types. */
type GenRow = { m: string; k: string; keywords?: string[]; name?: string }
type Kind = SpwCampaign['kind']
const TARGETING_LABEL: Record<Kind, string> = { auto: 'Auto', keyword: 'Keyword', pat: 'PAT' }
/** Token-driven custom name: walk the Campaign-Name tokens, resolve each to this
 *  campaign's value, then dash-join after the product-group prefix. */
function tokenName(grp: string, tokens: string[], kind: Kind, match: string, keywordType: string, asin: string): string {
  const g = grp.trim() || 'Campaign'
  const resolve = (t: string): string =>
    t === 'campaignType' ? 'SP'
      : t === 'targetingType' ? TARGETING_LABEL[kind]
        : t === 'matchType' ? (kind === 'keyword' ? match : '')
          : t === 'keywordType' ? (kind === 'keyword' ? keywordType : '')
            : t === 'asin' ? asin : '' // 'customize' free-text deferred
  const parts = tokens.map(resolve).filter(Boolean)
  return parts.length ? [g, ...parts].join('-') : g
}
function customRows(keywordTypes: CustomKeywordType[], targeting: TargetingKind[], tokens: string[], grp: string, asin: string): GenRow[] {
  const rows: GenRow[] = []
  const add = (kind: Kind, match: string, kwt: string, keywords: string[]) =>
    rows.push({ m: kind === 'auto' ? 'Auto' : kind === 'pat' ? 'PAT' : match, k: kwt || '-', keywords, name: tokenName(grp, tokens, kind, match, kwt, asin) })
  if (targeting.includes('auto')) add('auto', '', '', [])
  if (targeting.includes('keyword')) for (const kt of keywordTypes) for (const mt of kt.matchTypes) add('keyword', matchLabel(mt), kt.name, kt.keywords)
  if (targeting.includes('product')) add('pat', '', '', [])
  return rows
}

export function generateCampaigns(grp: string, mode: 'standard' | 'advanced' | 'custom', customKeywordTypes: CustomKeywordType[], customTargetingTypes: TargetingKind[], customNameTokens: string[] = [], asin = ''): SpwCampaign[] {
  const rows: GenRow[] =
    mode === 'advanced' ? advancedRows()
    : mode === 'custom' ? customRows(customKeywordTypes, customTargetingTypes, customNameTokens, grp, asin)
    : standardRows()
  return rows.map((r, i) => {
    const kind: SpwCampaign['kind'] = r.m === 'Auto' ? 'auto' : r.m === 'PAT' ? 'pat' : 'keyword'
    const name = r.name ?? campaignName(grp, kind, r.m, r.k)
    return {
      id: `cmp-${i}`, name, adGroupName: `${name} Ad Group`,
      matchType: r.m, keywordType: r.k, kind,
      bid: DEFAULT_BID.toFixed(2), budget: DEFAULT_BUDGET.toFixed(2), sugBid: DEFAULT_BID, sugBudget: DEFAULT_BUDGET,
      keywords: r.keywords ?? [], productTargets: [], negKeywords: [], negProducts: [],
      autoGroups: kind === 'auto' ? defaultAutoGroups(DEFAULT_BID) : [],
    }
  })
}

/** Campaigns that won't run because they have no positive targeting (keyword campaigns
 *  with no keywords, PAT with no product targets). Auto campaigns self-target. */
export function campaignsMissingTargeting(cs: SpwCampaign[]): number {
  return cs.filter((c) => (c.kind === 'keyword' && c.keywords.length === 0) || (c.kind === 'pat' && c.productTargets.length === 0)).length
}

// ── NT.1 — Negative-keyword funnel (campaign isolation) ──────────────────
// Two mechanisms, both writing ad-group-level negatives that carry a match type:
//  ① Match-type funnel — within a keyword group, a looser campaign negates its
//     tighter siblings' keywords so each search term serves from exactly one
//     campaign: Exact = none · Phrase = neg-exact · Broad = neg-exact + neg-phrase.
//  ② Auto-isolation — the Auto campaign neg-exacts every manual keyword so it only
//     discovers NEW search terms.
// `auto:true` negatives are derived (recomputed here); manual ones are preserved.
const RANK: Record<'BROAD' | 'PHRASE' | 'EXACT', number> = { BROAD: 1, PHRASE: 2, EXACT: 3 }
/** Single match type for a keyword campaign, or null for combined (Standard's
 *  "Broad & Phrase & Exact") / Auto / PAT — those don't take part in the funnel. */
function singleMatch(m: string): 'BROAD' | 'PHRASE' | 'EXACT' | null {
  const u = (m || '').toLowerCase()
  if (u.includes('&')) return null
  if (u.includes('phrase')) return 'PHRASE'
  if (u.includes('exact')) return 'EXACT'
  if (u.includes('broad')) return 'BROAD'
  return null
}
const dedupeCI = (xs: string[]): string[] => {
  const seen = new Set<string>(), out: string[] = []
  for (const x of xs) { const k = x.trim().toLowerCase(); if (x.trim() && !seen.has(k)) { seen.add(k); out.push(x.trim()) } }
  return out
}

export function applyAutoNegatives(campaigns: SpwCampaign[], enabled: boolean): SpwCampaign[] {
  // Always drop prior auto negatives first (so they never accumulate / go stale).
  const base = campaigns.map((c) => ({ ...c, negKeywords: c.negKeywords.filter((n) => !n.auto) }))
  if (!enabled) return base
  const keywordCampaigns = base.filter((c) => c.kind === 'keyword')
  const allKeywords = dedupeCI(keywordCampaigns.flatMap((c) => c.keywords))
  return base.map((c) => {
    let auto: NegKeyword[] = []
    if (c.kind === 'auto') {
      // ② Auto-isolation: neg-exact every manual keyword in the build.
      auto = allKeywords.map((text) => ({ text, matchType: 'EXACT' as NegMatch, auto: true }))
    } else if (c.kind === 'keyword') {
      // ① Funnel: negate same-group siblings that are TIGHTER than me.
      const my = singleMatch(c.matchType)
      if (my) {
        const sibs = keywordCampaigns.filter((s) => s.keywordType === c.keywordType && s.id !== c.id)
        const tighterKw = (mt: 'EXACT' | 'PHRASE') =>
          RANK[mt] > RANK[my] ? dedupeCI(sibs.filter((s) => singleMatch(s.matchType) === mt).flatMap((s) => s.keywords)) : []
        auto = [
          ...tighterKw('EXACT').map((text) => ({ text, matchType: 'EXACT' as NegMatch, auto: true })),
          ...tighterKw('PHRASE').map((text) => ({ text, matchType: 'PHRASE' as NegMatch, auto: true })),
        ]
      }
    }
    // Merge auto into manual; a manual negative for the same text+match wins (no dup).
    const seen = new Set(c.negKeywords.filter((n) => !n.auto).map((n) => `${n.text.toLowerCase()}|${n.matchType}`))
    const merged = [...c.negKeywords.filter((n) => !n.auto)]
    for (const a of auto) { const k = `${a.text.toLowerCase()}|${a.matchType}`; if (!seen.has(k)) { seen.add(k); merged.push(a) } }
    return { ...c, negKeywords: merged }
  })
}

const money = (cur: string, n: number) => `${cur}${n.toFixed(2)}`

// ── BA.2/BA.4/BA.5 — bulk-action modals, built on the design-system Modal + primitives ──
function BulkKeywordModal({ negative, count, onApply, onClose }: { negative: boolean; count: number; onApply: (lines: string[], mt: NegMatch) => void; onClose: () => void }) {
  const [text, setText] = useState('')
  const [mt, setMt] = useState<NegMatch>('EXACT')
  const apply = () => { const lines = dedupeCI(text.split('\n')); if (lines.length) onApply(lines, mt) }
  const title = negative ? 'Add negative keywords' : 'Add keywords'
  return (
    <Modal open onClose={onClose} size="md" title={title} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!text.trim()} onClick={apply}>Add</Button></>}>
      <p className="h10-spw-bulk-note">Adds to <b>{count}</b> selected {negative ? '' : 'keyword '}campaign{count === 1 ? '' : 's'} — duplicates skipped.</p>
      {negative && (
        <div className="h10-spw-bulk-mt">
          <span className="lbl">Match Type:</span>
          <Radio name="bulknegmt" label="Negative Exact" checked={mt === 'EXACT'} onChange={() => setMt('EXACT')} />
          <Radio name="bulknegmt" label="Negative Phrase" checked={mt === 'PHRASE'} onChange={() => setMt('PHRASE')} />
        </div>
      )}
      <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Enter one keyword per line" autoFocus aria-label={title} />
    </Modal>
  )
}

function BulkValueModal({ title, label, currency, percent, onApply, onClose }: { title: string; label: string; currency: string; percent?: boolean; onApply: (v: string) => void; onClose: () => void }) {
  const [v, setV] = useState('')
  return (
    <Modal open onClose={onClose} size="sm" title={title} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!v.trim()} onClick={() => onApply(v)}>Apply</Button></>}>
      <label className="h10-spw-bulk-field">
        <span className="l">{label}</span>
        <Input inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} placeholder={percent ? '±10' : '0.00'} autoFocus aria-label={label} prefix={percent ? undefined : currency} suffix={percent ? '%' : undefined} fieldClassName="h10-spw-bulk-numfield" />
      </label>
      {percent && <p className="h10-spw-bulk-hint">e.g. <b>10</b> raises by 10%, <b>-10</b> lowers by 10%. Floored at {currency}0.02.</p>}
    </Modal>
  )
}

function BulkRenameModal({ count, sample, onApply, onClose }: { count: number; sample: string; onApply: (prefix: string, suffix: string) => void; onClose: () => void }) {
  const [prefix, setPrefix] = useState('')
  const [suffix, setSuffix] = useState('')
  return (
    <Modal open onClose={onClose} size="sm" title="Rename campaigns" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!prefix && !suffix} onClick={() => onApply(prefix, suffix)}>Apply</Button></>}>
      <p className="h10-spw-bulk-note">Adds a prefix / suffix to <b>{count}</b> selected campaign{count === 1 ? '' : 's'}.</p>
      <label className="h10-spw-bulk-field"><span className="l">Prefix</span><Input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="e.g. Q1-" autoFocus aria-label="Name prefix" fieldClassName="h10-spw-bulk-txtfield" /></label>
      <label className="h10-spw-bulk-field gap"><span className="l">Suffix</span><Input value={suffix} onChange={(e) => setSuffix(e.target.value)} placeholder="e.g. -v2" aria-label="Name suffix" fieldClassName="h10-spw-bulk-txtfield" /></label>
      <p className="h10-spw-bulk-hint">Preview: <b>{prefix}{sample}{suffix}</b></p>
    </Modal>
  )
}

function BulkProductsModal({ count, onApply, onClose }: { count: number; onApply: (p: SpwProduct[]) => void; onClose: () => void }) {
  const [prods, setProds] = useState<SpwProduct[]>([])
  return (
    <Modal open onClose={onClose} size="lg" title="Add product targets" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!prods.length} onClick={() => onApply(prods)}>Add</Button></>}>
      <p className="h10-spw-bulk-note">Adds to <b>{count}</b> selected PAT campaign{count === 1 ? '' : 's'} — duplicates skipped.</p>
      <ProductSelection products={prods} setProducts={setProds} />
    </Modal>
  )
}

export function CampaignSetup({ campaigns, setCampaigns, currency, autoNegate, onRestore, onEditTargeting, onEditNegative }: {
  campaigns: SpwCampaign[]
  setCampaigns: Dispatch<SetStateAction<SpwCampaign[]>>
  currency: string
  autoNegate: boolean
  onRestore: () => void
  onEditTargeting?: (id: string) => void
  onEditNegative?: (id: string) => void
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulk, setBulk] = useState<null | 'keywords' | 'negatives' | 'bid' | 'budget' | 'products' | 'adjustbid' | 'rename'>(null)
  const [selOpen, setSelOpen] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)

  const upd = (id: string, patch: Partial<SpwCampaign>) => setCampaigns((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  const del = (id: string) => { setCampaigns((cs) => applyAutoNegatives(cs.filter((c) => c.id !== id), autoNegate)); setSelected((s) => { const n = new Set(s); n.delete(id); return n }) }

  // ── BA.1 — selection model ───────────────────────────────────────────
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const selectBy = (pred: (c: SpwCampaign) => boolean) => { setSelected(new Set(campaigns.filter(pred).map((c) => c.id))); setSelOpen(false) }
  const clearSel = () => setSelected(new Set())
  const selCampaigns = campaigns.filter((c) => selected.has(c.id))
  const n = selCampaigns.length
  const allSel = n > 0 && n === campaigns.length
  const selKeyword = selCampaigns.filter((c) => c.kind === 'keyword').length
  const selPat = selCampaigns.filter((c) => c.kind === 'pat').length
  const selNegTargets = selCampaigns.filter((c) => c.kind !== 'pat').length
  useEffect(() => {
    if (!selOpen) return
    const h = (e: MouseEvent) => { if (!(e.target as Element).closest('.h10-spw-cset-select')) setSelOpen(false) }
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h)
  }, [selOpen])
  useEffect(() => {
    if (!clearOpen) return
    const h = (e: MouseEvent) => { if (!(e.target as Element).closest('.h10-spw-bulk-clearwrap')) setClearOpen(false) }
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h)
  }, [clearOpen])

  // ── BA.2 / BA.3 / BA.4 — bulk apply ──────────────────────────────────
  const bulkKeywords = (lines: string[]) => { setCampaigns((cs) => applyAutoNegatives(cs.map((c) => (selected.has(c.id) && c.kind === 'keyword' ? { ...c, keywords: dedupeCI([...c.keywords, ...lines]) } : c)), autoNegate)); setBulk(null) }
  const bulkNegatives = (negs: NegKeyword[]) => {
    setCampaigns((cs) => applyAutoNegatives(cs.map((c) => {
      if (!selected.has(c.id) || c.kind === 'pat') return c
      const seen = new Set(c.negKeywords.filter((x) => !x.auto).map((x) => `${x.text.toLowerCase()}|${x.matchType}`))
      const add = negs.filter((ng) => { const k = `${ng.text.toLowerCase()}|${ng.matchType}`; if (seen.has(k)) return false; seen.add(k); return true })
      return add.length ? { ...c, negKeywords: [...c.negKeywords, ...add] } : c
    }), autoNegate)); setBulk(null)
  }
  const bulkProducts = (prods: SpwProduct[]) => {
    setCampaigns((cs) => cs.map((c) => {
      if (!selected.has(c.id) || c.kind !== 'pat') return c
      const seen = new Set(c.productTargets.map((p) => p.asin || p.sku || p.id))
      const add = prods.filter((p) => { const k = p.asin || p.sku || p.id; if (!k || seen.has(k)) return false; seen.add(k); return true })
      return add.length ? { ...c, productTargets: [...c.productTargets, ...add] } : c
    })); setBulk(null)
  }
  const bulkBid = (v: string) => { setCampaigns((cs) => cs.map((c) => (selected.has(c.id) ? { ...c, bid: v } : c))); setBulk(null) }
  const bulkBudget = (v: string) => { setCampaigns((cs) => cs.map((c) => (selected.has(c.id) ? { ...c, budget: v } : c))); setBulk(null) }
  const bulkDelete = () => { setCampaigns((cs) => applyAutoNegatives(cs.filter((c) => !selected.has(c.id)), autoNegate)); clearSel() }
  // BA.5 — adjust bid by %, rename (prefix/suffix), clear targets
  const bulkAdjustBid = (pct: string) => { const f = 1 + (Number(pct) || 0) / 100; setCampaigns((cs) => cs.map((c) => (selected.has(c.id) ? { ...c, bid: Math.max(0.02, (Number(c.bid) || 0) * f).toFixed(2) } : c))); setBulk(null) }
  const bulkRename = (prefix: string, suffix: string) => { setCampaigns((cs) => cs.map((c) => (selected.has(c.id) ? { ...c, name: `${prefix}${c.name}${suffix}`, adGroupName: `${prefix}${c.name}${suffix} Ad Group` } : c))); setBulk(null) }
  const bulkClear = (what: 'keywords' | 'negatives' | 'products') => {
    setCampaigns((cs) => applyAutoNegatives(cs.map((c) => {
      if (!selected.has(c.id)) return c
      if (what === 'keywords' && c.kind === 'keyword') return { ...c, keywords: [] }
      if (what === 'negatives') return { ...c, negKeywords: [] } // clears manual; auto funnel negs re-derive
      if (what === 'products' && c.kind === 'pat') return { ...c, productTargets: [] }
      return c
    }), autoNegate)); setClearOpen(false)
  }

  const tgtLabel = (c: SpwCampaign) => (c.kind === 'auto' ? `Auto : ${c.autoGroups.filter((g) => g.enabled).length}/4` : c.kind === 'pat' ? `Product : ${c.productTargets.length}` : `Keyword : ${c.keywords.length}`)
  const negLabels = (c: SpwCampaign) => (c.kind === 'pat' ? [`Product : ${c.negProducts.length}`] : c.kind === 'auto' ? [`Keyword : ${c.negKeywords.length}`, `Product : ${c.negProducts.length}`] : [`Keyword : ${c.negKeywords.length}`])

  return (
    <div className="h10-spw-cset-card">
      <div className={`h10-spw-cset-top ${n > 0 ? 'bulk' : ''}`}>
        {n > 0 ? (
          <>
            <span className="cnt sel">{n} selected</span>
            <button type="button" className="h10-spw-bulk-btn" disabled={!selKeyword} onClick={() => setBulk('keywords')}><Plus size={13} /> Keywords{selKeyword ? ` · ${selKeyword}` : ''}</button>
            <button type="button" className="h10-spw-bulk-btn" disabled={!selNegTargets} onClick={() => setBulk('negatives')}><Plus size={13} /> Negatives</button>
            <div className="h10-spw-bulk-clearwrap">
              <button type="button" className="h10-spw-bulk-btn" onClick={() => setClearOpen((o) => !o)} aria-haspopup="menu" aria-expanded={clearOpen}>Clear <ChevronDown size={13} /></button>
              {clearOpen && (
                <div className="menu" role="menu">
                  <button type="button" role="menuitem" disabled={!selKeyword} onClick={() => bulkClear('keywords')}>Keywords</button>
                  <button type="button" role="menuitem" disabled={!selNegTargets} onClick={() => bulkClear('negatives')}>Negatives</button>
                  <button type="button" role="menuitem" disabled={!selPat} onClick={() => bulkClear('products')}>Product targets</button>
                </div>
              )}
            </div>
            <button type="button" className="h10-spw-bulk-btn" onClick={() => setBulk('bid')}>Set bid</button>
            <button type="button" className="h10-spw-bulk-btn" onClick={() => setBulk('budget')}>Set budget</button>
            <button type="button" className="h10-spw-bulk-btn" onClick={() => setBulk('adjustbid')}>Adjust bid %</button>
            <button type="button" className="h10-spw-bulk-btn" disabled={!selPat} onClick={() => setBulk('products')}><Plus size={13} /> Products{selPat ? ` · ${selPat}` : ''}</button>
            <button type="button" className="h10-spw-bulk-btn" onClick={() => setBulk('rename')}>Rename</button>
            <button type="button" className="h10-spw-bulk-btn danger" onClick={bulkDelete}><Trash2 size={13} /> Delete</button>
            <span className="grow" />
            <button type="button" className="h10-spw-bulk-clear" onClick={clearSel}>Deselect</button>
          </>
        ) : (
          <>
            <span className="cnt">{campaigns.length} Campaign{campaigns.length === 1 ? '' : 's'}</span>
            <div className="h10-spw-cset-select">
              <button type="button" onClick={() => setSelOpen((o) => !o)} aria-haspopup="menu" aria-expanded={selOpen}>Select <ChevronDown size={13} /></button>
              {selOpen && (
                <div className="menu" role="menu">
                  <button type="button" role="menuitem" onClick={() => selectBy(() => true)}>All campaigns</button>
                  <button type="button" role="menuitem" onClick={() => selectBy((c) => c.kind === 'keyword')}>Keyword campaigns</button>
                  <button type="button" role="menuitem" onClick={() => selectBy((c) => c.kind === 'auto')}>Auto</button>
                  <button type="button" role="menuitem" onClick={() => selectBy((c) => c.kind === 'pat')}>Product (PAT)</button>
                  <div className="sep" />
                  <button type="button" role="menuitem" onClick={() => selectBy((c) => singleMatch(c.matchType) === 'BROAD')}>Match type: Broad</button>
                  <button type="button" role="menuitem" onClick={() => selectBy((c) => singleMatch(c.matchType) === 'PHRASE')}>Match type: Phrase</button>
                  <button type="button" role="menuitem" onClick={() => selectBy((c) => singleMatch(c.matchType) === 'EXACT')}>Match type: Exact</button>
                </div>
              )}
            </div>
            <span className="grow" />
            <button type="button" className="h10-spw-cset-restore" onClick={onRestore}><RotateCcw size={14} /> Restore Default</button>
          </>
        )}
      </div>
      <div className="h10-spw-cset-grid">
        <div className="h10-spw-cset-head">
          <span className="ck"><input type="checkbox" checked={allSel} onChange={() => (allSel ? clearSel() : selectBy(() => true))} aria-label="Select all campaigns" /></span>
          <span>Ad Group</span><span>Match Type</span><span>Keyword Type</span><span>Default Bid</span><span>Budget</span><span>Targeting</span><span>Negative Targeting</span>
        </div>
        {campaigns.map((c) => (
          <div className={`h10-spw-cset-row ${selected.has(c.id) ? 'sel' : ''}`} key={c.id}>
            <div className="ck"><input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} aria-label={`Select ${c.name}`} /></div>
            <div className="ag">
              <button type="button" className="del" onClick={() => del(c.id)} aria-label={`Remove ${c.name}`}><X size={16} /></button>
              <div className="agb">
                <input value={c.name} onChange={(e) => upd(c.id, { name: e.target.value })} aria-label="Campaign name" />
                <div className="sub"><Layers size={13} /> {c.adGroupName}</div>
              </div>
            </div>
            <div className="mt">{c.matchType}</div>
            <div className="kt">{c.keywordType}</div>
            <div className="bid">
              <div className="money"><span className="pf">{currency}</span><input inputMode="decimal" value={c.bid} onChange={(e) => upd(c.id, { bid: e.target.value })} aria-label="Default bid" /></div>
              <div className="sug">Suggested: <b>{money(currency, c.sugBid)}</b> ({money(currency, c.sugBid * SUG_LOW)} - {money(currency, c.sugBid * SUG_HIGH)})</div>
            </div>
            <div className="bid">
              <div className="money"><span className="pf">{currency}</span><input inputMode="decimal" value={c.budget} onChange={(e) => upd(c.id, { budget: e.target.value })} aria-label="Budget" /></div>
              <div className="sug">Suggested: <b>{money(currency, c.sugBudget)}</b> ({money(currency, c.sugBudget * SUG_LOW)} - {money(currency, c.sugBudget * SUG_HIGH)})</div>
            </div>
            <div className="tgt">
              {tgtLabel(c) ? <><span className="ct">{tgtLabel(c)}</span><button type="button" className="edit" onClick={() => onEditTargeting?.(c.id)}><Pencil size={12} /> Edit</button></> : <span className="dash">-</span>}
            </div>
            <div className="tgt">
              {negLabels(c).map((l) => <span className="ct" key={l}>{l}</span>)}
              <button type="button" className="edit" onClick={() => onEditNegative?.(c.id)}><Pencil size={12} /> Edit</button>
            </div>
          </div>
        ))}
      </div>

      {bulk === 'keywords' && <BulkKeywordModal negative={false} count={selKeyword} onApply={(lines) => bulkKeywords(lines)} onClose={() => setBulk(null)} />}
      {bulk === 'negatives' && <BulkKeywordModal negative count={selNegTargets} onApply={(lines, mt) => bulkNegatives(lines.map((t) => ({ text: t, matchType: mt, auto: false })))} onClose={() => setBulk(null)} />}
      {bulk === 'bid' && <BulkValueModal title="Set default bid" label="Default bid" currency={currency} onApply={bulkBid} onClose={() => setBulk(null)} />}
      {bulk === 'budget' && <BulkValueModal title="Set daily budget" label="Daily budget" currency={currency} onApply={bulkBudget} onClose={() => setBulk(null)} />}
      {bulk === 'adjustbid' && <BulkValueModal title="Adjust bid" label="Change bid by" currency={currency} percent onApply={bulkAdjustBid} onClose={() => setBulk(null)} />}
      {bulk === 'rename' && <BulkRenameModal count={n} sample={selCampaigns[0]?.name ?? 'Campaign'} onApply={bulkRename} onClose={() => setBulk(null)} />}
      {bulk === 'products' && <BulkProductsModal count={selPat} onApply={bulkProducts} onClose={() => setBulk(null)} />}
    </div>
  )
}
