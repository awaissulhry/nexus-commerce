'use client'

/**
 * EV1 — step ① Setup rebuilt as the section-outside-card exemplar (EV0 §1b):
 * shared .h10-spw-sec headers with subtitles OUTSIDE the white cards, InfoTips
 * on every field, consistent .h10-cd-input skins (incl. the date field). The
 * grammar-assist name chip stays (never forced).
 */
import type { CampaignPlan } from '../plan'
import { EBAY_MARKETS } from '../../../../_lib'
import { InfoTip } from '../../../../../campaigns/InfoTip'

export function SetupStep({ plan, set, suggestedName, onMarketChange }: {
  plan: CampaignPlan
  set: (patch: Partial<CampaignPlan>) => void
  suggestedName: string | null
  onMarketChange: (m: string) => void
}) {
  return (
    <div style={{ maxWidth: 860 }}>
      <section className="h10-spw-sec">
        <h2>Campaign identity</h2>
        <p>Where the campaign lives and what it is called.</p>
        <div className="h10-cd-card pad">
          <div className="eb-form-row">
            <div className="h10-cd-field s">
              <label>Marketplace <InfoTip tip="A campaign lives on one marketplace — its currency drives rates, bids and budgets. Changing it re-derives listings and suggestions." /></label>
              <select className="h10-cd-input" value={plan.marketplace} onChange={(e) => onMarketChange(e.target.value)}>
                {EBAY_MARKETS.filter((m) => m.id !== 'all').map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }} className="h10-cd-field">
              <label>Campaign name <InfoTip tip="Visible in Seller Hub too. The suggestion follows the console grammar (type-scope-market-sequence); one click applies it, editing stays free." /></label>
              <input className="h10-cd-input eb-input-full" value={plan.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} placeholder="name your campaign" />
              {suggestedName && plan.name !== suggestedName && (
                <button type="button" className="h10-am-link" style={{ marginTop: 6, fontSize: 12 }} onClick={() => set({ name: suggestedName })}>
                  use suggestion: <code>{suggestedName}</code>
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="h10-spw-sec">
        <h2>Schedule</h2>
        <p>Blank start = the campaign goes live the moment you launch; a future date schedules it. The end date is optional and stays editable on the Details tab.</p>
        <div className="h10-cd-card pad">
          <div className="eb-form-row">
            <div className="h10-cd-field s">
              <label>Start date <InfoTip tip="Blank = launches immediately. A future date creates the campaign as SCHEDULED on eBay — it activates by itself on that date and can still be edited or ended before then." /></label>
              <input className="h10-cd-input" type="date" min={new Date().toISOString().slice(0, 10)} value={plan.startDate} onChange={(e) => set({ startDate: e.target.value })} />
              {plan.startDate && <button type="button" className="h10-am-link" style={{ marginTop: 6, fontSize: 12 }} onClick={() => set({ startDate: '' })}>clear — start on launch</button>}
            </div>
            <div className="h10-cd-field s">
              <label>End date <InfoTip tip="Blank = never expires. ENDED is terminal on eBay — a campaign cannot be un-ended (clone it instead)." /></label>
              <input className="h10-cd-input" type="date" min={plan.startDate || new Date().toISOString().slice(0, 10)} value={plan.endDate} onChange={(e) => set({ endDate: e.target.value })} />
            </div>
          </div>
          {plan.template === 'clearance' && <p className="eb-be-hint" style={{ marginTop: 10 }}>Clear-stock template pre-set a 30-day end date — clearance campaigns should not run forever. Editable.</p>}
        </div>
      </section>
    </div>
  )
}
