'use client'

/**
 * EV3 — Budget step (Priority) on the section pattern: daily budget with our
 * provenance formula + eBay's suggest_budget where it answers, both in the
 * Amazon "Suggested · Use" idiom; the 15-edits/day + 2×-daily / 30.4×-monthly
 * semantics stated before launch. PRI-smart also carries the max-CPC field
 * with eBay's suggestMaxCpc.
 */
import { useEffect, useState } from 'react'
import { money } from '../../../../../campaigns/_grid/format'
import { InfoTip } from '../../../../../campaigns/InfoTip'
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
    <div style={{ maxWidth: 860 }}>
      <section className="h10-spw-sec">
        <h2>Daily budget</h2>
        <p>What the campaign may spend on clicks per day, on average.</p>
        <div className="h10-cd-card pad">
          <div className="eb-form-row" style={{ alignItems: 'flex-end' }}>
            <div className="h10-cd-field s" style={{ maxWidth: 160 }}>
              <label>Daily budget (EUR) <InfoTip tip="eBay paces to the average: a single day may spend up to 2× this value, and the month caps at 30.4× the daily budget. Editable after launch (15 edits/day per campaign)." /></label>
              <input type="number" min={1} step={0.5} value={plan.budgetEur} onChange={(e) => set({ budgetEur: e.target.value })} />
            </div>
            {suggestion && (
              <span className="eb-be-hint">
                Suggested <b>{money(suggestion.suggestedCents)}</b> <InfoTip tip={`Our formula from your data: ${suggestion.formula}`} /> · <button type="button" className="h10-am-link" onClick={() => set({ budgetEur: (suggestion.suggestedCents / 100).toFixed(2) })}>Use</button>
              </span>
            )}
            {suggestion?.ebaySuggestedCents != null && (
              <span className="eb-be-hint">
                eBay suggests <b>{money(suggestion.ebaySuggestedCents)}</b> <InfoTip tip="eBay's own suggest_budget for this marketplace and funding model — their estimate, not ours." /> · <button type="button" className="h10-am-link" onClick={() => set({ budgetEur: (suggestion.ebaySuggestedCents! / 100).toFixed(2) })}>Use</button>
              </span>
            )}
          </div>
          {suggestion && suggestion.ebaySuggestedCents == null && <p className="eb-be-hint" style={{ marginTop: 8 }}>eBay&apos;s suggest_budget returned nothing for this scope — the formula above is our provenance-stated estimate from your trailing sales.</p>}
          <p className="eb-be-hint" style={{ marginTop: 8 }}>eBay may spend up to <b>2× the daily budget</b> on a single day (monthly cap = 30.4× daily) · budget edits are limited to <b>15/day per campaign</b> · minimum €3.</p>
        </div>
      </section>

      {showMaxCpc && (
        <section className="h10-spw-sec">
          <h2>Click-price cap</h2>
          <p>Smart targeting bids for you — this is the one lever you keep.</p>
          <div className="h10-cd-card pad">
            <div className="eb-form-row" style={{ alignItems: 'flex-end' }}>
              <div className="h10-cd-field s" style={{ maxWidth: 160 }}>
                <label>Max CPC (EUR) <InfoTip tip="The most a single click may cost. eBay picks targets and bids under this cap — there is no keyword management on smart campaigns by design." /></label>
                <input type="number" min={0.02} step={0.01} value={plan.maxCpcEur} onChange={(e) => set({ maxCpcEur: e.target.value })} />
              </div>
              <button type="button" className="h10-am-btn sm" disabled={cpcBusy} onClick={() => void suggestCpc()}>{cpcBusy ? '…' : "eBay's suggested max CPC"}</button>
              <span className="eb-be-hint">Smart targeting: eBay picks targets and bids under this cap.</span>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
