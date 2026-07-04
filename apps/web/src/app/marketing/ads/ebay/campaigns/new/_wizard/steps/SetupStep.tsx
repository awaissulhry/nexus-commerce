'use client'

/**
 * EV4a — step ① Setup with ZERO native browser controls: the marketplace
 * lives on the shared H10Select listbox, both schedule dates on EbDateField
 * (the console's own calendar popover — no dd/mm/yyyy browser chrome).
 * Section-outside-card pattern + InfoTips from EV1/EV3 unchanged.
 */
import type { CampaignPlan } from '../plan'
import { EBAY_MARKETS } from '../../../../_lib'
import { EbDateField } from '../../../../_lib/EbDateField'
import { InfoTip } from '../../../../../campaigns/InfoTip'
import { H10Select } from '../../../../../campaigns/FilterDropdown'

const todayIso = () => new Date().toISOString().slice(0, 10)

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
              <H10Select ariaLabel="Marketplace" width={200} value={plan.marketplace} onChange={onMarketChange}
                options={EBAY_MARKETS.filter((m) => m.id !== 'all').map((m) => ({ value: m.id, label: m.label }))} />
            </div>
            <div style={{ flex: 1 }} className="h10-cd-field">
              <label>Campaign name <InfoTip tip="Visible in Seller Hub too. The suggestion follows the console grammar (type-scope-market-sequence); one click applies it, editing stays free." /></label>
              <input className="h10-cd-input eb-input-full" type="text" value={plan.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} placeholder="name your campaign" />
              {suggestedName && plan.name !== suggestedName && (
                <button type="button" className="h10-am-link eb-suggest" onClick={() => set({ name: suggestedName })}>
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
              <EbDateField ariaLabel="Start date" width={170} value={plan.startDate} min={todayIso()}
                placeholder="on launch" clearLabel="clear — start on launch" onChange={(v) => set({ startDate: v })} />
            </div>
            <div className="h10-cd-field s">
              <label>End date <InfoTip tip="Blank = never expires. ENDED is terminal on eBay — a campaign cannot be un-ended (clone it instead)." /></label>
              <EbDateField ariaLabel="End date" width={170} value={plan.endDate} min={plan.startDate || todayIso()}
                placeholder="never" clearLabel="clear — no end date" onChange={(v) => set({ endDate: v })} />
            </div>
          </div>
          {plan.template === 'clearance' && <p className="eb-be-hint eb-gap-t">Clear-stock template pre-set a 30-day end date — clearance campaigns should not run forever. Editable.</p>}
        </div>
      </section>
    </div>
  )
}
