'use client'

/**
 * SPW.4 — Step 2 "Campaign Setup" (Helium 10 match). The campaigns generated from the
 * step-1 structure render in an editable table: × delete · campaign-name input + ad-group
 * sub-row · Match/Keyword type · Default Bid + Budget (currency inputs with a Suggested
 * range) · Targeting / Negative Targeting (counts + Edit). Restore Default regenerates.
 * Per the build decision this is a purpose-built table (not AdsDataGrid — that grid is
 * hardwired for filter/sort/pager); the per-row Edit drawers land in SPW.5.
 */
import { type Dispatch, type SetStateAction } from 'react'
import { X, Layers, Pencil, RotateCcw } from 'lucide-react'
import { standardRows, advancedRows } from './StructureSelection'
import type { SpwProduct } from './ProductSelection'

export type SpwCampaign = {
  id: string; name: string; adGroupName: string
  matchType: string; keywordType: string; kind: 'auto' | 'keyword' | 'pat'
  bid: string; budget: string; sugBid: number; sugBudget: number
  keywords: string[]; productTargets: SpwProduct[]; negKeywords: string[]; negProducts: SpwProduct[]
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

export function generateCampaigns(grp: string, mode: 'standard' | 'advanced' | 'custom', customKeywordTypes: string[]): SpwCampaign[] {
  const rows: Array<{ m: string; k: string }> =
    mode === 'advanced' ? advancedRows()
    : mode === 'custom' ? [{ m: 'Auto', k: '-' }, ...customKeywordTypes.map((k) => ({ m: 'Broad', k })), { m: 'PAT', k: '-' }]
    : standardRows()
  return rows.map((r, i) => {
    const kind: SpwCampaign['kind'] = r.m === 'Auto' ? 'auto' : r.m === 'PAT' ? 'pat' : 'keyword'
    const name = campaignName(grp, kind, r.m, r.k)
    return {
      id: `cmp-${i}`, name, adGroupName: `${name} Ad Group`,
      matchType: r.m, keywordType: r.k, kind,
      bid: DEFAULT_BID.toFixed(2), budget: DEFAULT_BUDGET.toFixed(2), sugBid: DEFAULT_BID, sugBudget: DEFAULT_BUDGET,
      keywords: [], productTargets: [], negKeywords: [], negProducts: [],
    }
  })
}

/** Campaigns that won't run because they have no positive targeting (keyword campaigns
 *  with no keywords, PAT with no product targets). Auto campaigns self-target. */
export function campaignsMissingTargeting(cs: SpwCampaign[]): number {
  return cs.filter((c) => (c.kind === 'keyword' && c.keywords.length === 0) || (c.kind === 'pat' && c.productTargets.length === 0)).length
}

const money = (cur: string, n: number) => `${cur}${n.toFixed(2)}`

export function CampaignSetup({ campaigns, setCampaigns, currency, onRestore, onEditTargeting, onEditNegative }: {
  campaigns: SpwCampaign[]
  setCampaigns: Dispatch<SetStateAction<SpwCampaign[]>>
  currency: string
  onRestore: () => void
  onEditTargeting?: (id: string) => void
  onEditNegative?: (id: string) => void
}) {
  const upd = (id: string, patch: Partial<SpwCampaign>) => setCampaigns((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  const del = (id: string) => setCampaigns((cs) => cs.filter((c) => c.id !== id))

  const tgtLabel = (c: SpwCampaign) => (c.kind === 'auto' ? null : c.kind === 'pat' ? `Product : ${c.productTargets.length}` : `Keyword : ${c.keywords.length}`)
  const negLabels = (c: SpwCampaign) => (c.kind === 'pat' ? [`Product : ${c.negProducts.length}`] : c.kind === 'auto' ? [`Keyword : ${c.negKeywords.length}`, `Product : ${c.negProducts.length}`] : [`Keyword : ${c.negKeywords.length}`])

  return (
    <div className="h10-spw-cset-card">
      <div className="h10-spw-cset-top">
        <span className="cnt">{campaigns.length} Campaign{campaigns.length === 1 ? '' : 's'}</span>
        <span className="grow" />
        <button type="button" className="h10-spw-cset-restore" onClick={onRestore}><RotateCcw size={14} /> Restore Default</button>
      </div>
      <div className="h10-spw-cset-grid">
        <div className="h10-spw-cset-head">
          <span>Ad Group</span><span>Match Type</span><span>Keyword Type</span><span>Default Bid</span><span>Budget</span><span>Targeting</span><span>Negative Targeting</span>
        </div>
        {campaigns.map((c) => (
          <div className="h10-spw-cset-row" key={c.id}>
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
    </div>
  )
}
