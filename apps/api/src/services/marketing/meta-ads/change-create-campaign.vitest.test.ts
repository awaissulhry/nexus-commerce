/**
 * Meta step 19 — create-meta-campaign as a draft (pure): born PAUSED, the silent opt-ins said explicitly (special ad
 * category [], ad set budget sharing false, bid strategy), SPENDS MONEY only with activate, Meta's check with its
 * recommendations, the refusals in words (app promotion, political ads, a ROAS goal outside Sales, PCA before 2026-10-22).
 * Made-up ids.
 */
import { describe, expect, it } from 'vitest'
import { campaignCreateDraft, type CampaignCreateLive, type CampaignCreateRequest } from './change-create-campaign.js'
import type { MetaChangeDraft } from './change-draft.js'
import { META_PCA_UNIFIED_FROM } from '../../gateway/meta-create-rules.js'
import { metaWriteVerdict } from '../../gateway/meta-calls.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../../meta/api-version.js'

const LIVE: CampaignCreateLive = { adAccountId: '1234567890', currency: 'EUR', pixels: new Set(['120000000000050']), catalogProblem: undefined, capabilities: ['CAN_USE_BUDGET_SCHEDULING_API'], source: null }
const NOW = new Date('2026-10-21T08:00:00Z')
const ok = (r: CampaignCreateRequest, live: Partial<CampaignCreateLive> = {}, now = NOW) => {
  const d = campaignCreateDraft(r, { ...LIVE, ...live }, now)
  if ('refusal' in d) throw new Error(d.refusal)
  return d
}
const no = (r: CampaignCreateRequest, live: Partial<CampaignCreateLive> = {}, now = NOW) => {
  const d = campaignCreateDraft(r, { ...LIVE, ...live }, now)
  return 'refusal' in d ? d.refusal : null
}
/** The request as the gateway judges it (the draft's params are exactly what is sent). */
const judged = (d: MetaChangeDraft) => metaWriteVerdict({
  method: 'POST', url: `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}/${d.requests[0].objectId}/${d.requests[0].edge}`, kind: 'write',
  body: new URLSearchParams(d.requests[0].params).toString(), objectKind: d.requests[0].objectKind,
})

describe('create-meta-campaign', () => {
  it('a Sales campaign with a campaign budget: one request on the ad account\'s edge, PAUSED, Meta checks it with its recommendations', () => {
    const d = ok({ name: 'Shop A spring', objective: 'OUTCOME_SALES', dailyBudgetCents: 5000 })
    expect(d.requests).toHaveLength(1)
    expect(d.requests[0]).toMatchObject({ objectId: 'act_1234567890', objectKind: 'adaccount', edge: 'campaigns', kind: 'campaign', check: 'meta', recommendations: true, raisesSpend: false, operation: 'campaign.create' })
    expect(d.requests[0].params).toEqual({ name: 'Shop A spring', objective: 'OUTCOME_SALES', special_ad_categories: '[]', daily_budget: '5000', bid_strategy: 'LOWEST_COST_WITHOUT_CAP', status: 'PAUSED' })
    expect(d.spendsMoney).toEqual([])
    expect(d.requests[0].expect).toMatchObject({ status: 'PAUSED', objective: 'OUTCOME_SALES', daily_budget: '5000' })
    expect(judged(d)).toMatchObject({ write: { rule: 'campaign.create' } })
  })
  it('without a campaign budget, ad set budget sharing is said explicitly (false unless asked); with one, never sent', () => {
    const abo = ok({ name: 'A', objective: 'OUTCOME_TRAFFIC' })
    expect(abo.requests[0].params.is_adset_budget_sharing_enabled).toBe('false')
    expect(Object.keys(abo.changes).some((k) => /budget sharing \(sent explicitly/.test(k))).toBe(true)
    expect(judged(abo)).toMatchObject({ write: { rule: 'campaign.create' } })
    expect(ok({ name: 'A', objective: 'OUTCOME_TRAFFIC', budgetSharing: true }).requests[0].params.is_adset_budget_sharing_enabled).toBe('true')
    expect(no({ name: 'A', objective: 'OUTCOME_SALES', dailyBudgetCents: 5000, budgetSharing: true })).toMatch(/WITHOUT a campaign budget/)
  })
  it('a special ad category goes with its countries; none is [] sent explicitly', () => {
    const d = ok({ name: 'A', objective: 'OUTCOME_LEADS', specialAdCategories: ['EMPLOYMENT'], specialAdCategoryCountries: ['IT'], dailyBudgetCents: 5000 })
    expect(d.requests[0].params).toMatchObject({ special_ad_categories: '["EMPLOYMENT"]', special_ad_category_country: '["IT"]' })
    expect(no({ name: 'A', objective: 'OUTCOME_LEADS', specialAdCategories: ['HOUSING'] })).toMatch(/countries it applies to/)
    expect(no({ name: 'A', objective: 'OUTCOME_LEADS', specialAdCategoryCountries: ['IT'] })).toMatch(/Countries go with a special ad category/)
  })
  it('switching on is the person\'s decision: ACTIVE, SPENDS MONEY, and it says nothing spends until an ad set and an ad are on', () => {
    const d = ok({ name: 'A', objective: 'OUTCOME_SALES', dailyBudgetCents: 5000, activate: true })
    expect(d.requests[0].params.status).toBe('ACTIVE')
    expect(d.requests[0].raisesSpend).toBe(true)
    expect(d.spendsMoney[0]).toMatch(/nothing spends until they are made and switched on/)
  })
  it('refuses in words: app promotion, a ROAS goal outside Sales, reach and frequency with a cap or a category, both budgets', () => {
    expect(no({ name: 'A', objective: 'OUTCOME_APP_PROMOTION' })).toMatch(/no app/)
    expect(no({ name: 'A', objective: 'OUTCOME_TRAFFIC', bidStrategy: 'LOWEST_COST_WITH_MIN_ROAS', dailyBudgetCents: 5000 })).toMatch(/Sales/)
    expect(no({ name: 'A', objective: 'OUTCOME_SALES', buyingType: 'RESERVED', spendCapCents: 100000 })).toMatch(/no spend cap/)
    expect(no({ name: 'A', objective: 'OUTCOME_SALES', buyingType: 'RESERVED', specialAdCategories: ['HOUSING'], specialAdCategoryCountries: ['IT'] })).toMatch(/special ad category/)
    expect(no({ name: 'A', objective: 'OUTCOME_SALES', dailyBudgetCents: 1, lifetimeBudgetCents: 2 })).toMatch(/not both/)
    expect(no({ name: 'A', objective: 'OUTCOME_SALES', promotedObject: { pixelId: '120000000000050' } })).toMatch(/conversion event/)
    expect(no({ name: 'A', objective: 'OUTCOME_SALES', promotedObject: { pixelId: '120000000000051', customEventType: 'PURCHASE' } })).toMatch(/not one of the chosen ad account's own pixels/)
  })
  it('Advantage+ (CMP-028): a Sales or Leads campaign with a campaign budget; sends nothing of its own and says what its ad sets need', () => {
    const d = ok({ name: 'A', objective: 'OUTCOME_SALES', dailyBudgetCents: 5000, advantagePlus: true })
    expect(d.requests[0].params).not.toHaveProperty('advantage_state')
    expect(d.warnings.join(' ')).toMatch(/ADVANTAGE_PLUS_SALES .* Advantage\+ audience on/)
    expect(no({ name: 'A', objective: 'OUTCOME_SALES', advantagePlus: true })).toMatch(/campaign budget/)
    expect(no({ name: 'A', objective: 'OUTCOME_TRAFFIC', dailyBudgetCents: 5000, advantagePlus: true })).toMatch(/Sales or Leads/)
  })
  it('CMP-087 — the unified PCA flow from 2026-10-22 only, Sales only', () => {
    expect(no({ name: 'A', objective: 'OUTCOME_SALES', dailyBudgetCents: 5000, pcaUnified: true })).toMatch(/2026-10-22/)
    const after = new Date(META_PCA_UNIFIED_FROM)
    expect(ok({ name: 'A', objective: 'OUTCOME_SALES', dailyBudgetCents: 5000, pcaUnified: true }, {}, after).requests[0].params.is_pca_unified).toBe('true')
    expect(no({ name: 'A', objective: 'OUTCOME_TRAFFIC', dailyBudgetCents: 5000, pcaUnified: true }, {}, after)).toMatch(/Sales/)
  })
  it('scheduled increases (CMP-058): a campaign daily budget, the account\'s capability, whole currency units, within 8 daily budgets', () => {
    const d = ok({ name: 'A', objective: 'OUTCOME_SALES', dailyBudgetCents: 5000, budgetSchedules: [{ startTime: '2026-11-27T08:00:00Z', endTime: '2026-11-27T20:00:00Z', increaseCents: 2000 }] })
    expect(d.requests[0].params.budget_schedule_specs).toBe(JSON.stringify([{ time_start: Date.UTC(2026, 10, 27, 8) / 1000, time_end: Date.UTC(2026, 10, 27, 20) / 1000, budget_value: 20, budget_value_type: 'ABSOLUTE' }]))
    expect(judged(d)).toMatchObject({ write: { rule: 'campaign.create' } })
    expect(no({ name: 'A', objective: 'OUTCOME_SALES', lifetimeBudgetCents: 50000, budgetSchedules: [{ startTime: '2026-11-27T08:00:00Z', endTime: '2026-11-27T20:00:00Z', increasePercent: 50 }] })).toMatch(/daily budget/)
    expect(no({ name: 'A', objective: 'OUTCOME_SALES', dailyBudgetCents: 5000, budgetSchedules: [{ startTime: '2026-11-27T08:00:00Z', endTime: '2026-11-27T20:00:00Z', increaseCents: 50000 }] })).toMatch(/8 times the daily budget/)
    expect(no({ name: 'A', objective: 'OUTCOME_SALES', dailyBudgetCents: 5000, budgetSchedules: [{ startTime: '2026-11-27T08:00:00Z', endTime: '2026-11-27T20:00:00Z', increaseCents: 2050 }] })).toMatch(/whole/)
    expect(no({ name: 'A', objective: 'OUTCOME_SALES', dailyBudgetCents: 5000, budgetSchedules: [{ startTime: '2026-11-27T08:00:00Z', endTime: '2026-11-27T20:00:00Z', increasePercent: 50 }] }, { capabilities: [] })).toMatch(/CAN_USE_BUDGET_SCHEDULING_API/)
  })
  it('records nothing made before the run (the run records Meta\'s new id)', () => {
    const d = ok({ name: 'A', objective: 'OUTCOME_SALES', dailyBudgetCents: 5000 })
    expect(d.before).toEqual({ op: 'create', made: [], top: [], madeAt: '' })
  })
})
