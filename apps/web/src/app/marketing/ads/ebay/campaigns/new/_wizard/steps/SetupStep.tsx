'use client'

/**
 * ER2 — step ① Setup: marketplace (re-derive warning on change), name with
 * the grammar-assist chip (one-click suggestion, never forced), schedule.
 */
import type { CampaignPlan } from '../plan'
import { EBAY_MARKETS } from '../../../../_lib'

export function SetupStep({ plan, set, suggestedName, onMarketChange }: {
  plan: CampaignPlan
  set: (patch: Partial<CampaignPlan>) => void
  suggestedName: string | null
  onMarketChange: (m: string) => void
}) {
  return (
    <div className="h10-cd-card pad" style={{ maxWidth: 760 }}>
      <div className="eb-form-row">
        <div className="h10-cd-field s">
          <label>Marketplace</label>
          <select className="h10-cd-input" value={plan.marketplace} onChange={(e) => onMarketChange(e.target.value)}>
            {EBAY_MARKETS.filter((m) => m.id !== 'all').map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
        <div style={{ flex: 1 }} className="h10-cd-field">
          <label>Campaign name</label>
          <input value={plan.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} placeholder="name your campaign" />
          {suggestedName && plan.name !== suggestedName && (
            <button type="button" className="h10-am-link" style={{ marginTop: 6, fontSize: 12 }} onClick={() => set({ name: suggestedName })}>
              use suggestion: <code>{suggestedName}</code>
            </button>
          )}
        </div>
      </div>
      <div className="eb-form-row" style={{ marginTop: 14 }}>
        <div className="h10-cd-field s">
          <label>Start</label>
          <input value="now (on launch)" disabled />
        </div>
        <div className="h10-cd-field s">
          <label>End date — blank = never expires</label>
          <input type="date" min={new Date().toISOString().slice(0, 10)} value={plan.endDate} onChange={(e) => set({ endDate: e.target.value })} />
        </div>
      </div>
      {plan.template === 'clearance' && <p className="eb-be-hint" style={{ marginTop: 10 }}>Clear-stock template pre-set a 30-day end date — clearance campaigns should not run forever. Editable.</p>}
    </div>
  )
}
