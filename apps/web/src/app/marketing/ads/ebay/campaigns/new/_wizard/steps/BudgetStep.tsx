'use client'

/**
 * ER2 — Budget step (Priority): daily budget with our provenance formula,
 * eBay's suggest_budget where it answers, the 15-edits/day + 2×-daily /
 * 30.4×-monthly semantics stated before launch. PRI-smart also carries the
 * max-CPC field with eBay's suggestMaxCpc.
 */
import { useEffect, useState } from 'react'
import { money } from '../../../../../campaigns/_grid/format'
import { postEbayAds } from '../../../../_lib'
import type { CampaignPlan } from '../plan'

export function BudgetStep({ plan, set, showMaxCpc }: { plan: CampaignPlan; set: (patch: Partial<CampaignPlan>) => void; showMaxCpc: boolean }) {
  const [suggestion, setSuggestion] = useState<{ suggestedCents: number; formula: string; ebaySuggestedCents: number | null } | null>(null)
  const [cpcBusy, setCpcBusy] = useState(false)

  useEffect(() => {
    let alive = true
    postEbayAds<{ suggestedCents: number; formula: string; ebaySuggestedCents: number | null }>('/builder/budget-suggest', { marketplace: plan.marketplace, listingIds: plan.selected })
      .then((s) => { if (alive) setSuggestion(s) })
      .catch(() => {})
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.marketplace, plan.selected.join(',')])

  const suggestCpc = async () => {
    setCpcBusy(true)
    try {
      const out = await postEbayAds<Record<string, { value?: string } | undefined>>('/suggest/max-cpc', { marketplaceId: plan.marketplace, fundingStrategy: 'COST_PER_CLICK' })
      const v = out.maxCpc?.value ?? out.suggestedMaxCpc?.value ?? (out.suggestions as { suggestedMaxCpc?: { value?: string } } | undefined)?.suggestedMaxCpc?.value
      if (v != null) set({ maxCpcEur: Number(v).toFixed(2) })
    } catch { /* best-effort */ } finally { setCpcBusy(false) }
  }

  return (
    <div className="h10-cd-card pad" style={{ maxWidth: 760 }}>
      <div className="eb-form-row" style={{ alignItems: 'flex-end' }}>
        <div className="h10-cd-field s" style={{ maxWidth: 160 }}>
          <label>Daily budget (EUR)</label>
          <input type="number" min={1} step={0.5} value={plan.budgetEur} onChange={(e) => set({ budgetEur: e.target.value })} />
        </div>
        {suggestion && (
          <button type="button" className="h10-am-btn sm" onClick={() => set({ budgetEur: (suggestion.suggestedCents / 100).toFixed(2) })}>
            use suggestion {money(suggestion.suggestedCents)}
          </button>
        )}
        {suggestion?.ebaySuggestedCents != null && (
          <button type="button" className="h10-am-btn sm" onClick={() => set({ budgetEur: (suggestion.ebaySuggestedCents! / 100).toFixed(2) })}>
            eBay suggests {money(suggestion.ebaySuggestedCents)}
          </button>
        )}
      </div>
      {suggestion && <p className="eb-be-hint" style={{ marginTop: 8 }}>Provenance: <code>{suggestion.formula}</code>{suggestion.ebaySuggestedCents == null ? ' · eBay suggest_budget returned nothing for this scope.' : ''}</p>}
      <p className="eb-be-hint" style={{ marginTop: 8 }}>eBay may spend up to <b>2× the daily budget</b> on a single day (monthly cap = 30.4× daily) · budget edits are limited to <b>15/day per campaign</b> · minimum €3.</p>

      {showMaxCpc && (
        <div className="eb-form-row" style={{ marginTop: 16, alignItems: 'flex-end' }}>
          <div className="h10-cd-field s" style={{ maxWidth: 160 }}>
            <label>Max CPC (EUR) — your click-price cap</label>
            <input type="number" min={0.02} step={0.01} value={plan.maxCpcEur} onChange={(e) => set({ maxCpcEur: e.target.value })} />
          </div>
          <button type="button" className="h10-am-btn sm" disabled={cpcBusy} onClick={() => void suggestCpc()}>{cpcBusy ? '…' : "eBay's suggested max CPC"}</button>
          <span className="eb-be-hint">Smart targeting: eBay picks targets and bids under this cap. No keyword management exists on smart campaigns.</span>
        </div>
      )}
    </div>
  )
}
