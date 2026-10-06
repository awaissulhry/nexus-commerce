'use client'

/**
 * SPW.4 — Step 2 "Campaign Setup" (Helium 10 match). The campaigns generated from the
 * step-1 structure render in an editable table: × delete · campaign-name input + ad-group
 * sub-row · Match/Keyword type · Default Bid + Budget (currency inputs; CC-9: their starting values are labelled
 * "Default", not "Suggested" — they are constants, not a suggestion) · Targeting / Negative Targeting (counts + Edit). Restore Default regenerates.
 * Per the build decision this is a purpose-built table (not AdsDataGrid — that grid is
 * hardwired for filter/sort/pager); the per-row Edit drawers land in SPW.5.
 */
import { type Dispatch, type SetStateAction, useState } from 'react'
import { X, Layers, Pencil, RotateCcw, Plus, Trash2, ChevronDown } from 'lucide-react'
import { Menu, Modal } from '@/design-system/components'
import { Button, Checkbox, Input, Radio, Textarea, ToolbarButton } from '@/design-system/primitives'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '../builder-ds.css'
import { AUTO_GROUP_MULT, applyAutoNegatives as applyFunnel, dedupeCI, generateCampaignRows, singleMatch, type AutoGroupKey, type NegKeyword, type NegMatch } from '@nexus/shared/ads-sp-wizard'
import { ProductSelection, type SpwProduct } from './ProductSelection'
import type { CustomKeywordType, TargetingKind } from './CustomScheme'

// AT.1 — Amazon SP Auto-targeting groups. Each is independently enable/disable-able
// and separately biddable (Amazon defaults all four on at the campaign bid).
export type { AutoGroupKey }
export type AutoGroup = { key: AutoGroupKey; enabled: boolean; bid: string }
export const AUTO_GROUP_META: Array<{ key: AutoGroupKey; label: string; desc: string }> = [
  { key: 'CLOSE_MATCH', label: 'Close match', desc: 'Shoppers using search terms closely related to your product.' },
  { key: 'LOOSE_MATCH', label: 'Loose match', desc: 'Shoppers using search terms loosely related to your product.' },
  { key: 'SUBSTITUTES', label: 'Substitutes', desc: 'Shoppers viewing detail pages of products similar to yours.' },
  { key: 'COMPLEMENTS', label: 'Complements', desc: 'Shoppers viewing detail pages of products that complement yours.' },
]
// AT.2 — intent-based smart default bids (× the campaign default, AUTO_GROUP_MULT in @nexus/shared/ads-sp-wizard).
export const defaultAutoGroups = (defaultBid: number): AutoGroup[] =>
  AUTO_GROUP_META.map((g) => ({ key: g.key, enabled: true, bid: (defaultBid * AUTO_GROUP_MULT[g.key]).toFixed(2) }))

// B-3 — a negative keyword (NegKeyword: its own match type; `auto` marks the funnel's) is the shared one.
export type { NegKeyword, NegMatch }

export type SpwCampaign = {
  id: string; name: string; adGroupName: string
  matchType: string; keywordType: string; kind: 'auto' | 'keyword' | 'pat'
  bid: string; budget: string; sugBid: number; sugBudget: number
  keywords: string[]; productTargets: SpwProduct[]; negKeywords: NegKeyword[]; negProducts: SpwProduct[]
  autoGroups: AutoGroup[]
}

const DEFAULT_BID = 0.75, DEFAULT_BUDGET = 10

export function generateCampaigns(grp: string, mode: 'standard' | 'advanced' | 'custom', customKeywordTypes: CustomKeywordType[], customTargetingTypes: TargetingKind[], customNameTokens: string[] = [], asin = ''): SpwCampaign[] {
  // B-3 — the rows and their names are the shared structure (@nexus/shared/ads-sp-wizard); the screen adds its defaults.
  return generateCampaignRows(grp, mode, customKeywordTypes, customTargetingTypes, customNameTokens, asin).map((r) => ({
    ...r,
    bid: DEFAULT_BID.toFixed(2), budget: DEFAULT_BUDGET.toFixed(2), sugBid: DEFAULT_BID, sugBudget: DEFAULT_BUDGET,
    productTargets: [], negKeywords: [], negProducts: [],
    autoGroups: r.kind === 'auto' ? defaultAutoGroups(DEFAULT_BID) : [],
  }))
}

/** Campaigns that won't run because they have no positive targeting (keyword campaigns
 *  with no keywords, PAT with no product targets). Auto campaigns self-target. */
export function campaignsMissingTargeting(cs: SpwCampaign[]): number {
  return cs.filter((c) => (c.kind === 'keyword' && c.keywords.length === 0) || (c.kind === 'pat' && c.productTargets.length === 0)).length
}

// ── NT.1 — Negative-keyword funnel (campaign isolation): the shared one (@nexus/shared/ads-sp-wizard, B-3) ──
export function applyAutoNegatives(campaigns: SpwCampaign[], enabled: boolean): SpwCampaign[] {
  return applyFunnel(campaigns, enabled)
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

  const upd = (id: string, patch: Partial<SpwCampaign>) => setCampaigns((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  const del = (id: string) => { setCampaigns((cs) => applyAutoNegatives(cs.filter((c) => c.id !== id), autoNegate)); setSelected((s) => { const n = new Set(s); n.delete(id); return n }) }

  // ── BA.1 — selection model ───────────────────────────────────────────
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const selectBy = (pred: (c: SpwCampaign) => boolean) => setSelected(new Set(campaigns.filter(pred).map((c) => c.id)))
  const clearSel = () => setSelected(new Set())
  const selCampaigns = campaigns.filter((c) => selected.has(c.id))
  const n = selCampaigns.length
  const allSel = n > 0 && n === campaigns.length
  const selKeyword = selCampaigns.filter((c) => c.kind === 'keyword').length
  const selPat = selCampaigns.filter((c) => c.kind === 'pat').length
  const selNegTargets = selCampaigns.filter((c) => c.kind !== 'pat').length

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
    }), autoNegate))
  }

  const tgtLabel = (c: SpwCampaign) => (c.kind === 'auto' ? `Auto : ${c.autoGroups.filter((g) => g.enabled).length}/4` : c.kind === 'pat' ? `Product : ${c.productTargets.length}` : `Keyword : ${c.keywords.length}`)
  const negLabels = (c: SpwCampaign) => (c.kind === 'pat' ? [`Product : ${c.negProducts.length}`] : c.kind === 'auto' ? [`Keyword : ${c.negKeywords.length}`, `Product : ${c.negProducts.length}`] : [`Keyword : ${c.negKeywords.length}`])

  return (
    <div className="h10-spw-cset-card">
      <div className={`h10-spw-cset-top ${n > 0 ? 'bulk' : ''}`}>
        {n > 0 ? (
          <>
            <span className="cnt sel">{n} selected</span>
            <Button disabled={!selKeyword} onClick={() => setBulk('keywords')}><Plus size={13} /> Keywords{selKeyword ? ` · ${selKeyword}` : ''}</Button>
            <Button disabled={!selNegTargets} onClick={() => setBulk('negatives')}><Plus size={13} /> Negatives</Button>
            <Menu
              label={<>Clear <ChevronDown size={13} /></>}
              items={[
                { id: 'kw', label: 'Keywords', disabled: !selKeyword, onSelect: () => bulkClear('keywords') },
                { id: 'neg', label: 'Negatives', disabled: !selNegTargets, onSelect: () => bulkClear('negatives') },
                { id: 'pat', label: 'Product targets', disabled: !selPat, onSelect: () => bulkClear('products') },
              ]}
            />
            <Button onClick={() => setBulk('bid')}>Set bid</Button>
            <Button onClick={() => setBulk('budget')}>Set budget</Button>
            <Button onClick={() => setBulk('adjustbid')}>Adjust bid %</Button>
            <Button disabled={!selPat} onClick={() => setBulk('products')}><Plus size={13} /> Products{selPat ? ` · ${selPat}` : ''}</Button>
            <Button onClick={() => setBulk('rename')}>Rename</Button>
            <Button variant="danger" onClick={bulkDelete}><Trash2 size={13} /> Delete</Button>
            <span className="grow" />
            <Button variant="link" className="back" onClick={clearSel}>Deselect</Button>
          </>
        ) : (
          <>
            <span className="cnt">{campaigns.length} Campaign{campaigns.length === 1 ? '' : 's'}</span>
            <Menu
              label={<>Select <ChevronDown size={13} /></>}
              items={[
                { id: 'all', label: 'All campaigns', onSelect: () => selectBy(() => true) },
                { id: 'kw', label: 'Keyword campaigns', onSelect: () => selectBy((c) => c.kind === 'keyword') },
                { id: 'auto', label: 'Auto', onSelect: () => selectBy((c) => c.kind === 'auto') },
                { id: 'pat', label: 'Product (PAT)', onSelect: () => selectBy((c) => c.kind === 'pat') },
                { id: 'sep', label: null, separator: true },
                { id: 'broad', label: 'Match type: Broad', onSelect: () => selectBy((c) => singleMatch(c.matchType) === 'BROAD') },
                { id: 'phrase', label: 'Match type: Phrase', onSelect: () => selectBy((c) => singleMatch(c.matchType) === 'PHRASE') },
                { id: 'exact', label: 'Match type: Exact', onSelect: () => selectBy((c) => singleMatch(c.matchType) === 'EXACT') },
              ]}
            />
            <span className="grow" />
            <Button variant="primary" onClick={onRestore}><RotateCcw size={14} /> Restore Default</Button>
          </>
        )}
      </div>
      <div className="h10-spw-cset-grid">
        <div className="h10-spw-cset-head">
          <span className="ck"><Checkbox checked={allSel} onChange={() => (allSel ? clearSel() : selectBy(() => true))} aria-label="Select all campaigns" /></span>
          <span>Ad Group</span><span>Match Type</span><span>Keyword Type</span><span>Default Bid</span><span>Budget</span><span>Targeting</span><span>Negative Targeting</span>
        </div>
        {campaigns.map((c) => (
          <div className={`h10-spw-cset-row ${selected.has(c.id) ? 'sel' : ''}`} key={c.id}>
            <div className="ck"><Checkbox checked={selected.has(c.id)} onChange={() => toggle(c.id)} aria-label={`Select ${c.name}`} /></div>
            <div className="ag">
              <ToolbarButton size="sm" tone="danger" tooltip={false} icon={<X size={16} />} label={`Remove ${c.name}`} onClick={() => del(c.id)} />
              <div className="spw-agb">
                <Input fieldClassName="spw-agbfield" value={c.name} onChange={(e) => upd(c.id, { name: e.target.value })} aria-label="Campaign name" />
                <div className="sub"><Layers size={13} /> {c.adGroupName}</div>
              </div>
            </div>
            <div className="mt">{c.matchType}</div>
            <div className="kt">{c.keywordType}</div>
            <div className="bid">
              <Input inputMode="decimal" prefix={currency} value={c.bid} onChange={(e) => upd(c.id, { bid: e.target.value })} aria-label="Default bid" fieldClassName="spw-field-money" />
              <div className="sug">Default: <b>{money(currency, c.sugBid)}</b></div>
            </div>
            <div className="bid">
              <Input inputMode="decimal" prefix={currency} value={c.budget} onChange={(e) => upd(c.id, { budget: e.target.value })} aria-label="Budget" fieldClassName="spw-field-money" />
              <div className="sug">Default: <b>{money(currency, c.sugBudget)}</b></div>
            </div>
            <div className="tgt">
              {tgtLabel(c) ? <><span className="ct">{tgtLabel(c)}</span><span><Button variant="link" onClick={() => onEditTargeting?.(c.id)}><Pencil size={12} /> Edit</Button></span></> : <span className="dash">-</span>}
            </div>
            <div className="tgt">
              {negLabels(c).map((l) => <span className="ct" key={l}>{l}</span>)}
              <span><Button variant="link" onClick={() => onEditNegative?.(c.id)}><Pencil size={12} /> Edit</Button></span>
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
