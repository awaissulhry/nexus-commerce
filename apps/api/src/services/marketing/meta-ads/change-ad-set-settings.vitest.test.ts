/**
 * Meta step 18 — set-meta-ad-set as a pure draft: Meta's rules per field (budgets only without a campaign budget, 110% of
 * what was spent, the ROAS goal × 10,000, COST_CAP's billing and pacing, frequency caps on REACH / THRUPLAY only, the
 * attribution table, a promoted object Meta keeps as it is, a customer goal only for Sales, ad scheduling on lifetime
 * budgets), SPENDS MONEY on every raise, and a restart as two requests (the end time, then the switch-on). Made-up ids.
 */
import { describe, expect, it } from 'vitest'
import { adSetSettingsDraft, allowedAttribution, attributionPresetOf, type AdSetSettingsLive } from './change-ad-set-settings.js'
import type { LiveAdSet, LiveCampaign } from './live-settings.js'
import type { MetaChangeDraft } from './change-draft.js'
import type { SettingsRecord } from './change-settings-common.js'

const S = '120000000000002'
const NOW = new Date('2026-10-21T00:00:00Z')
const campaign = (over: Partial<LiveCampaign> = {}): LiveCampaign => ({
  id: '120000000000001', name: 'Campaign A', status: 'ACTIVE', effectiveStatus: 'ACTIVE', objective: 'OUTCOME_SALES', buyingType: 'AUCTION', smartPromotionType: null,
  dailyBudget: null, lifetimeBudget: null, spendCap: null, canUseSpendCap: true, bidStrategy: null, pacingType: null, promotedObject: null, specialAdCategories: [],
  specialAdCategory: 'NONE', specialAdCategoryCountry: null, budgetSharing: false, budgetScheduling: false, reelsTrendingAds: false, advantageState: 'DISABLED', ...over,
})
const adSet = (over: Partial<LiveAdSet> = {}): LiveAdSet => ({
  id: S, campaignId: '120000000000001', name: 'Ad set B', status: 'ACTIVE', effectiveStatus: 'ACTIVE', optimizationGoal: 'OFFSITE_CONVERSIONS', optimizationSubEvent: null,
  billingEvent: 'IMPRESSIONS', bidStrategy: 'LOWEST_COST_WITHOUT_CAP', bidAmount: null, bidConstraints: null, dailyBudget: '2000', lifetimeBudget: null, budgetRemaining: '1500',
  dailyMinSpendTarget: null, lifetimeMinSpendTarget: null, dailySpendCap: null, lifetimeSpendCap: null, minBudgetSpendPercentage: null, maxBudgetSpendPercentage: null,
  startTime: '2026-10-01T00:00:00+0000', endTime: null, pacingType: ['standard'], adsetSchedule: null, frequencyControlSpecs: null,
  attributionSpec: [{ event_type: 'CLICK_THROUGH', window_days: 7 }, { event_type: 'VIEW_THROUGH', window_days: 1 }], incrementalAttribution: false,
  promotedObject: { pixel_id: '120000000000050', custom_event_type: 'PURCHASE' }, dsaPayor: 'Shop A', dsaBeneficiary: 'Shop A', regionalRegulatedCategories: null,
  regionalRegulationIdentities: null, adSetGoal: { type: 0 }, creativeSequence: null, sequenceRepetition: null, rotationBlocks: null, rotationIntervals: null, brandSafety: null,
  contextualBundling: { status: 'OPT_OUT' }, fullFunnelExploration: null, automaticManualState: null, budgetScheduling: null, targetingCountries: ['IT'], unread: [], ...over,
})
const live = (over: Partial<AdSetSettingsLive> = {}): AdSetSettingsLive => ({
  adSet: adSet(), campaign: campaign(), currency: 'EUR', ads: ['120000000000003', '120000000000005'], pixels: new Set(['120000000000050', '120000000000051']), ...over,
})
const ok = (d: MetaChangeDraft | { refusal: string }): MetaChangeDraft => { if ('refusal' in d) throw new Error(d.refusal); return d }
const refusal = (d: MetaChangeDraft | { refusal: string }) => ('refusal' in d ? d.refusal : null)
const draft = (request: Record<string, unknown>, l: AdSetSettingsLive = live()) => adSetSettingsDraft({ adSetId: S, ...request }, l, NOW)

describe('budget and spend limits', () => {
  it('a raise of its daily budget: a budget change (4 an hour), SPENDS MONEY, no Meta check; undo the old amount', () => {
    const d = ok(draft({ dailyBudgetCents: 3000 }))
    expect(d.requests[0]).toMatchObject({ kind: 'adset', params: { daily_budget: '3000' }, budget: true, check: 'none', readBackInPost: false, raisesSpend: true, expect: { daily_budget: '3000' } })
    expect(d.spendsMoney[0]).toMatch(/from 20\.00 EUR to 30\.00 EUR: the ad set and its campaign are on/)
    expect(d.warnings.join(' ')).toMatch(/4 budget changes of an ad set an hour/)
    expect((d.before as SettingsRecord).undo).toEqual({ dailyBudgetCents: 2000 })
  })
  it('under a campaign budget: no own budget; a minimum spend (SPENDS) and a spend cap of the campaign\'s kind instead', () => {
    const cbo = live({ campaign: campaign({ dailyBudget: '10000' }) })
    expect(refusal(draft({ dailyBudgetCents: 3000 }, cbo))).toMatch(/budget is the campaign's/)
    const d = ok(draft({ minSpendTargetCents: 1000, spendCapCents: 4000 }, cbo))
    expect(d.requests[0].params).toEqual({ daily_min_spend_target: '1000', daily_spend_cap: '4000' })
    expect(d.requests[0].budget).toBe(false)
    expect(d.spendsMoney[0]).toMatch(/minimum spend of 10\.00 EUR steers more/)
    const remove = ok(draft({ spendCapCents: null }, live({ campaign: campaign({ lifetimeBudget: '900000' }), adSet: adSet({ dailyBudget: null, lifetimeSpendCap: '4000' }) })))
    expect(remove.requests[0].params).toEqual({ lifetime_spend_cap: '922337203685478' })
    expect(remove.spendsMoney[0]).toMatch(/Removing/)
    expect(refusal(draft({ minSpendTargetCents: 1000 }))).toMatch(/has its own budget/)
  })
  it('a lifetime budget needs an end time and stays ≥ 110% of what was spent', () => {
    expect(refusal(draft({ lifetimeBudgetCents: 50000 }))).toMatch(/needs an end time/)
    const life = live({ adSet: adSet({ dailyBudget: null, lifetimeBudget: '100000', budgetRemaining: '70000', endTime: '2026-12-01T00:00:00+0000' }) })
    expect(refusal(draft({ lifetimeBudgetCents: 30000 }, life))).toMatch(/spent 300\.00 EUR, so its lifetime budget can go down to 330\.00 EUR/)
    expect(ok(draft({ lifetimeBudgetCents: 40000 }, life)).spendsMoney).toEqual([])
  })
  it('the basis does not move while the ad set spends (budget left), and moves on a real change', () => {
    const a = ok(draft({ name: 'Ad set C' }))
    expect(JSON.stringify(ok(draft({ name: 'Ad set C' }, live({ adSet: adSet({ budgetRemaining: '900', effectiveStatus: 'WITH_ISSUES' }) }))).stands)).toBe(JSON.stringify(a.stands))
    expect(JSON.stringify(ok(draft({ name: 'Ad set C' }, live({ adSet: adSet({ dailyBudget: '2500' }) }))).stands)).not.toBe(JSON.stringify(a.stands))
  })
  it('review A2 — an earlier start and a longer run are raises even while paused (said: nothing spends yet)', () => {
    const paused = live({ adSet: adSet({ status: 'PAUSED', startTime: '2026-11-10T00:00:00+0000', endTime: '2026-11-20T00:00:00+0000' }) })
    const earlier = ok(draft({ startTime: '2026-11-01T00:00:00Z' }, paused))
    expect(earlier.spendsMoney[0]).toMatch(/starts earlier .*more days of delivery — nothing spends yet/)
    expect(earlier.requests[0].raisesSpend).toBe(true)
    const longer = ok(draft({ endTime: '2026-11-30T00:00:00Z' }, paused))
    expect(longer.spendsMoney[0]).toMatch(/runs longer: more days of delivery — nothing spends yet/)
    expect(ok(draft({ startTime: '2026-11-12T00:00:00Z' }, paused)).spendsMoney).toEqual([])
  })
  it('daily → lifetime (AS-046, unverified): sent alone with its end, SPENDS (said), Meta decides', () => {
    const d = ok(draft({ lifetimeBudgetCents: 100000, endTime: '2026-12-01T00:00:00Z' }))
    expect(d.requests[0].params).toMatchObject({ lifetime_budget: '100000', end_time: String(Date.parse('2026-12-01T00:00:00Z') / 1000) })
    expect(d.warnings.join(' ')).toMatch(/not how/)
  })
})

describe('bids and the ROAS goal', () => {
  it('a bid only with a cap; a raise SPENDS (per 1,000 impressions when billed on impressions)', () => {
    expect(refusal(draft({ bidAmountCents: 150 }))).toMatch(/1885204/)
    const capped = live({ adSet: adSet({ bidStrategy: 'LOWEST_COST_WITH_BID_CAP', bidAmount: '100' }) })
    const d = ok(draft({ bidAmountCents: 150 }, capped))
    expect(d.requests[0].params).toEqual({ bid_amount: '150' })
    expect(d.spendsMoney[0]).toMatch(/from 1\.00 EUR to 1\.50 EUR \(per 1,000 impressions\)/)
  })
  it('COST_CAP needs impressions billing and standard pacing; MIN_ROAS needs VALUE and a floor', () => {
    expect(refusal(draft({ bidStrategy: 'COST_CAP', bidAmountCents: 900 }, live({ adSet: adSet({ billingEvent: 'LINK_CLICKS' }) })))).toMatch(/billing on impressions and standard pacing/)
    expect(refusal(draft({ bidStrategy: 'LOWEST_COST_WITH_MIN_ROAS' }))).toMatch(/needs the minimum ROAS/)
    expect(refusal(draft({ roasGoal: 2 }))).toMatch(/needs the VALUE performance goal/)
    const d = ok(draft({ roasGoal: 2.5 }, live({ adSet: adSet({ optimizationGoal: 'VALUE' }) })))
    expect(d.requests[0].params).toEqual({ bid_strategy: 'LOWEST_COST_WITH_MIN_ROAS', bid_constraints: '{"roas_average_floor":25000}' })
    expect((d.before as SettingsRecord).undo).toEqual({ bidStrategy: 'LOWEST_COST_WITHOUT_CAP' })
  })
  it('lowering a ROAS floor SPENDS; under a campaign budget only the floor is sent; removing it there is refused (AS-051)', () => {
    const cbo = live({ campaign: campaign({ dailyBudget: '10000', bidStrategy: 'LOWEST_COST_WITH_MIN_ROAS' }), adSet: adSet({ optimizationGoal: 'VALUE', bidStrategy: null, bidConstraints: { roas_average_floor: 30000 } }) })
    const d = ok(draft({ roasGoal: 2 }, cbo))
    expect(d.requests[0].params).toEqual({ bid_constraints: '{"roas_average_floor":20000}' })
    expect(d.spendsMoney[0]).toMatch(/Lowering .*minimum ROAS from 3 to 2/)
    expect((d.before as SettingsRecord).undo).toEqual({ roasGoal: 3 })
    expect(refusal(draft({ removeRoasGoal: true }, cbo))).toMatch(/cannot currently switch/)
    const abo = ok(draft({ removeRoasGoal: true }, live({ adSet: adSet({ optimizationGoal: 'VALUE', bidStrategy: 'LOWEST_COST_WITH_MIN_ROAS', bidConstraints: { roas_average_floor: 30000 } }) })))
    expect(abo.requests[0].params).toEqual({ bid_strategy: 'LOWEST_COST_WITHOUT_CAP', bid_constraints: '{}' })
    expect(abo.spendsMoney[0]).toMatch(/Removing .*ROAS goal/)
    expect((abo.before as SettingsRecord).undo).toEqual({ bidStrategy: 'LOWEST_COST_WITH_MIN_ROAS', roasGoal: 3 })
  })
})

describe('times, restart, scheduling, frequency, attribution', () => {
  it('a later end SPENDS when on; an end in the past is refused; no end only for daily budgets', () => {
    const d = ok(draft({ endTime: null }, live({ adSet: adSet({ endTime: '2026-11-01T00:00:00+0000' }) })))
    expect(d.requests[0].params).toEqual({ end_time: '0' })
    expect(d.spendsMoney[0]).toMatch(/runs without an end/)
    expect(refusal(draft({ endTime: '2026-10-01T00:00:00Z' }))).toMatch(/1487033/)
  })
  it('a restart (AS-056): the end time, then the switch-on — the switch-on is the spending request', () => {
    const ended = live({ adSet: adSet({ status: 'PAUSED', endTime: '2026-10-10T00:00:00+0000' }) })
    expect(refusal(draft({ restart: true }, ended))).toMatch(/needs a new end time/)
    const d = ok(draft({ restart: true, endTime: '2026-11-30T00:00:00Z' }, ended))
    // Review A2 — the later end is a raise even while paused; review A7 — the end is judged on the read-back.
    expect(d.requests.map((r) => [r.step, r.params, r.raisesSpend])).toEqual([[1, { end_time: String(Date.parse('2026-11-30T00:00:00Z') / 1000) }, true], [2, { status: 'ACTIVE' }, true]])
    expect(d.requests[0].expect).toEqual({ end_time: String(Date.parse('2026-11-30T00:00:00Z') / 1000) })
    expect(d.spendsMoney.join(' ')).toMatch(/Restarting .*delivers and spends at once/)
    // Review A6 — one story: the restart switches it on, so every line says it spends at once (never "nothing spends yet").
    const raised = ok(draft({ restart: true, endTime: '2026-11-30T00:00:00Z', dailyBudgetCents: 3000 }, ended))
    expect(raised.spendsMoney.length).toBeGreaterThan(1)
    expect(raised.spendsMoney.join(' ')).not.toMatch(/nothing spends yet/)
    expect(raised.spendsMoney.join(' ')).toMatch(/the restart switches it on and its campaign is on/)
    expect(refusal(draft({ restart: true, endTime: '2026-11-30T00:00:00Z' }))).toMatch(/has not ended/)
  })
  it('ad scheduling on a lifetime budget (off = standard + []), under a campaign budget the schedule only', () => {
    expect(refusal(draft({ dayparting: { blocks: [{ days: [1], startHour: 9, endHour: 12 }] } }))).toMatch(/needs a lifetime budget/)
    const life = live({ adSet: adSet({ dailyBudget: null, lifetimeBudget: '100000', endTime: '2026-12-01T00:00:00+0000' }) })
    const on = ok(draft({ dayparting: { blocks: [{ days: [5, 1], startHour: 9, endHour: 12 }] } }, life))
    expect(on.requests[0].params).toEqual({ pacing_type: '["day_parting"]', adset_schedule: '[{"start_minute":540,"end_minute":720,"days":[1,5],"timezone_type":"USER"}]' })
    expect((on.before as SettingsRecord).undo).toEqual({ dayparting: { off: true } })
    const scheduled = live({ adSet: adSet({ dailyBudget: null, lifetimeBudget: '100000', pacingType: ['day_parting'], adsetSchedule: [{ start_minute: 540, end_minute: 720, days: [1], timezone_type: 'USER' }] }) })
    const off = ok(draft({ dayparting: { off: true } }, scheduled))
    expect(off.requests[0].params).toEqual({ pacing_type: '["standard"]', adset_schedule: '[]' })
    expect((off.before as SettingsRecord).undo).toEqual({ dayparting: { blocks: [{ days: [1], startHour: 9, endHour: 12, timezone: 'USER' }] } })
    const cbo = live({ campaign: campaign({ lifetimeBudget: '900000', pacingType: ['day_parting'] }) })
    expect(ok(draft({ dayparting: { blocks: [{ days: [1], startHour: 9, endHour: 12 }] } }, cbo)).requests[0].params).toEqual({ adset_schedule: '[{"start_minute":540,"end_minute":720,"days":[1],"timezone_type":"USER"}]' })
  })
  it('a wider schedule, a looser cap, fewer exclusions, more exploration, an automatic setup: SPENDS MONEY when on', () => {
    const scheduled = live({ adSet: adSet({ dailyBudget: null, lifetimeBudget: '100000', pacingType: ['day_parting'], adsetSchedule: [{ start_minute: 540, end_minute: 720, days: [1], timezone_type: 'USER' }] }) })
    expect(ok(draft({ dayparting: { blocks: [{ days: [1, 2], startHour: 9, endHour: 12 }] } }, scheduled)).spendsMoney[0]).toMatch(/6 hours a week instead of 3/)
    expect(ok(draft({ dayparting: { blocks: [{ days: [1], startHour: 9, endHour: 10 }] } }, scheduled)).spendsMoney).toEqual([])
    const capped = live({ adSet: adSet({ optimizationGoal: 'REACH', frequencyControlSpecs: [{ event: 'IMPRESSIONS', interval_days: 7, max_frequency: 2 }] }) })
    expect(ok(draft({ frequencyCaps: [{ intervalDays: 7, maxFrequency: 4 }] }, capped)).spendsMoney[0]).toMatch(/looser frequency cap/)
    expect(ok(draft({ frequencyCaps: [{ intervalDays: 7, maxFrequency: 1 }] }, capped)).spendsMoney).toEqual([])
    const goal = live({ adSet: adSet({ adSetGoal: { type: 2, existing_customers_exclusions: ['120000000000070', '120000000000072'] } }) })
    expect(ok(draft({ customerGoal: { type: 'exclude-existing', existingCustomerAudienceIds: ['120000000000070'] } }, goal)).spendsMoney[0]).toMatch(/excludes fewer people/)
    expect(ok(draft({ fullFunnelExploration: 'EXTENDED_EXPLORATION' })).spendsMoney[0]).toMatch(/More exploration/)
    expect(ok(draft({ setupState: 'AUTOMATIC' })).spendsMoney[0]).toMatch(/automatic setup/)
    expect(ok(draft({ setupState: 'MANUAL' })).spendsMoney).toEqual([])
  })
  it('frequency caps only on REACH / THRUPLAY goals (CMP-072 corrected)', () => {
    expect(refusal(draft({ frequencyCaps: [{ intervalDays: 7, maxFrequency: 2 }] }))).toMatch(/REACH or THRUPLAY/)
    const d = ok(draft({ frequencyCaps: [{ intervalDays: 7, maxFrequency: 2 }] }, live({ adSet: adSet({ optimizationGoal: 'REACH' }) })))
    expect(d.requests[0].params).toEqual({ frequency_control_specs: '[{"event":"IMPRESSIONS","interval_days":7,"max_frequency":2}]' })
    expect((d.before as SettingsRecord).undo).toEqual({ frequencyCaps: [] })
  })
  it('attribution by Meta\'s table', () => {
    expect(allowedAttribution('OUTCOME_SALES', 'OFFSITE_CONVERSIONS')).toHaveLength(4)
    expect(allowedAttribution('OUTCOME_TRAFFIC', 'OFFSITE_CONVERSIONS')).toEqual(['1d_click', '7d_click'])
    expect(allowedAttribution('OUTCOME_TRAFFIC', 'LINK_CLICKS')).toEqual(['1d_click'])
    // Review B4 — the four only for OFFSITE_CONVERSIONS; VALUE and every other goal: 1-day click only.
    expect(allowedAttribution('OUTCOME_SALES', 'VALUE')).toEqual(['1d_click'])
    expect(attributionPresetOf([{ event_type: 'CLICK_THROUGH', window_days: 7, weight: 100 }, { event_type: 'VIEW_THROUGH', window_days: 1 }])).toBe('7d_click_1d_view')
    const d = ok(draft({ attribution: '1d_click' }))
    expect(d.requests[0].params).toEqual({ attribution_spec: '[{"event_type":"CLICK_THROUGH","window_days":1}]' })
    expect((d.before as SettingsRecord).undo).toEqual({ attribution: '7d_click_1d_view' })
    expect(refusal(draft({ attribution: '7d_click' }, live({ adSet: adSet({ optimizationGoal: 'LINK_CLICKS' }) })))).toMatch(/allows 1d_click/)
  })
})

describe('review A9 and B7', () => {
  it('scheduling turned on from accelerated: undo goes back to accelerated; off may name its pacing (accelerated SPENDS)', () => {
    const fast = live({ adSet: adSet({ dailyBudget: null, lifetimeBudget: '100000', endTime: '2026-12-01T00:00:00+0000', pacingType: ['no_pacing'] }) })
    expect((ok(draft({ dayparting: { blocks: [{ days: [1], startHour: 9, endHour: 12 }] } }, fast)).before as SettingsRecord).undo).toEqual({ dayparting: { off: true, pacing: 'no_pacing' } })
    const scheduled = live({ adSet: adSet({ dailyBudget: null, lifetimeBudget: '100000', pacingType: ['day_parting'], adsetSchedule: [{ start_minute: 540, end_minute: 720, days: [1], timezone_type: 'USER' }] }) })
    const off = ok(draft({ dayparting: { off: true, pacing: 'no_pacing' } }, scheduled))
    expect(off.requests[0].params).toEqual({ pacing_type: '["no_pacing"]', adset_schedule: '[]' })
    expect(off.spendsMoney[0]).toMatch(/as fast as Meta can/)
    expect(refusal(draft({ dayparting: { blocks: [{ days: [1], startHour: 9, endHour: 12 }], pacing: 'no_pacing' } }, fast))).toMatch(/only with dayparting off/)
  })
  it('a sequence\'s repetition pattern goes back on undo; one Meta did not answer is said', () => {
    const seq = live({ adSet: adSet({ creativeSequence: ['120000000000003'], sequenceRepetition: 'LAST_AD' }) })
    expect((ok(draft({ creativeSequence: { adIds: ['120000000000005'], repetition: 'FULL_SEQUENCE' } }, seq)).before as SettingsRecord).undo).toEqual({ creativeSequence: { adIds: ['120000000000003'], repetition: 'LAST_AD' } })
    expect((ok(draft({ creativeSequence: { adIds: ['120000000000005'], repetition: 'FULL_SEQUENCE' } })).before as SettingsRecord).noUndo?.join(' ')).toMatch(/repetition pattern was not readable/)
  })
  it('a maximum budget share raise is flagged even when the old one could not be read', () => {
    const cbo = live({ campaign: campaign({ dailyBudget: '10000' }) })
    expect(ok(draft({ budgetSharePercent: { max: 80 } }, cbo)).spendsMoney[0]).toMatch(/from a value Nexus could not read/)
  })
  it('review B7 — no ad set bid strategy change while the campaign shares budget (4834006)', () => {
    expect(refusal(draft({ bidStrategy: 'COST_CAP', bidAmountCents: 900 }, live({ campaign: campaign({ budgetSharing: true }) })))).toMatch(/4834006/)
  })
})

describe('promoted object, EU payer, customer goal, sequence, the rest', () => {
  it('a new pixel event of a conversions ad set; anything else Meta keeps; a first catalog has no undo', () => {
    const d = ok(draft({ promotedObject: { customEventType: 'ADD_TO_CART' } }))
    expect(JSON.parse(d.requests[0].params.promoted_object)).toEqual({ pixel_id: '120000000000050', custom_event_type: 'ADD_TO_CART' })
    expect(refusal(draft({ promotedObject: { customEventType: 'LEAD' } }, live({ adSet: adSet({ optimizationGoal: 'LINK_CLICKS' }) })))).toMatch(/only for a sales campaign with the OFFSITE_CONVERSIONS goal/)
    expect(refusal(draft({ promotedObject: { valueSemanticType: 'MARGIN' } }))).toMatch(/cannot change/)
    expect(refusal(draft({ promotedObject: { productCatalogId: '120000000000060' } }, live({ catalogProblem: 'Another business in Nexus uses an ad account of this Meta business portfolio.' })))).toMatch(/Another business in Nexus/)
    const cat = ok(draft({ promotedObject: { productCatalogId: '120000000000060' } }, live({ catalogProblem: null })))
    expect((cat.before as SettingsRecord).undo).toBeNull()
    expect((cat.before as SettingsRecord).noUndo?.join(' ')).toMatch(/may not be removable/)
  })
  it('EU payer and beneficiary always together; a non-EU ad set is warned Meta does not keep them', () => {
    const d = ok(draft({ dsa: { payor: 'Shop B', beneficiary: 'Shop B' } }))
    expect(d.requests[0].params).toEqual({ dsa_payor: 'Shop B', dsa_beneficiary: 'Shop B' })
    expect((d.before as SettingsRecord).undo).toEqual({ dsa: { payor: 'Shop A', beneficiary: 'Shop A' } })
    expect(ok(draft({ dsa: { payor: 'Shop B', beneficiary: 'Shop B' } }, live({ adSet: adSet({ targetingCountries: ['US'] }) }))).warnings.join(' ')).toMatch(/does not target the EU/)
  })
  it('a customer goal: Sales only, broad in a special category; Meta merges, so Nexus clears what must go; broad SPENDS', () => {
    expect(refusal(draft({ customerGoal: { type: 'exclude-existing', existingCustomerAudienceIds: ['120000000000070'] } }, live({ campaign: campaign({ objective: 'OUTCOME_TRAFFIC' }) })))).toMatch(/1870252/)
    expect(refusal(draft({ customerGoal: { type: 'exclude-existing', existingCustomerAudienceIds: ['120000000000070'] } }, live({ campaign: campaign({ specialAdCategories: ['HOUSING'] }) })))).toMatch(/restricted special ad category .*1870261/)
    // Review B9 — a political category is not a restricted one for this rule.
    expect(ok(draft({ customerGoal: { type: 'exclude-existing', existingCustomerAudienceIds: ['120000000000070'] } }, live({ campaign: campaign({ specialAdCategories: ['ISSUES_ELECTIONS_POLITICS'] }) }))).requests).toHaveLength(1)
    expect(refusal(draft({ customerGoal: { type: 'exclude-existing' } }))).toMatch(/needs their audiences/)
    const d = ok(draft({ customerGoal: { type: 'exclude-existing', existingCustomerAudienceIds: ['120000000000070'] } }, live({ adSet: adSet({ adSetGoal: { type: 1, existing_customers_exclusions: ['120000000000070'], engaged_audiences_exclusions: ['120000000000071'] } }) })))
    expect(JSON.parse(d.requests[0].params.ad_set_goal)).toEqual({ type: 2, existing_customers_exclusions: ['120000000000070'], existing_customers_audience_label_exclusions: [], engaged_audiences_exclusions: [] })
    expect((d.before as SettingsRecord).undo).toEqual({ customerGoal: { type: 'exclude-existing-and-engaged', existingCustomerAudienceIds: ['120000000000070'], engagedAudienceIds: ['120000000000071'] } })
    const broad = ok(draft({ customerGoal: { type: 'broad' } }, live({ adSet: adSet({ adSetGoal: { type: 2, existing_customers_exclusions: ['120000000000070'] } }) })))
    expect(JSON.parse(broad.requests[0].params.ad_set_goal)).toEqual({ type: 0, existing_customers_exclusions: [] })
    expect(broad.spendsMoney[0]).toMatch(/wider audience/)
  })
  it('a sequence of its own ads only; rotation ranges from its start to an hour before its end', () => {
    expect(refusal(draft({ creativeSequence: { adIds: ['120000000000099'] } }))).toMatch(/Not ads of/)
    expect(ok(draft({ creativeSequence: { adIds: ['120000000000005', '120000000000003'] } })).requests[0].params).toEqual({ creative_sequence: '["120000000000005","120000000000003"]' })
    const ending = live({ adSet: adSet({ endTime: '2026-10-31T00:00:00+0000' }) })
    expect(refusal(draft({ adRotation: { blocks: [{ startTime: '2026-10-02T00:00:00Z', adIds: ['120000000000003'] }, { startTime: '2026-10-15T00:00:00Z', adIds: ['120000000000005'] }] } }, ending))).toMatch(/starts with the ad set/)
    const d = ok(draft({ adRotation: { blocks: [{ startTime: '2026-10-01T00:00:00Z', adIds: ['120000000000003'] }, { startTime: '2026-10-15T00:00:00Z', adIds: ['120000000000005', '120000000000003'] }] } }, ending))
    expect(d.requests[0].params).toMatchObject({ time_based_ad_rotation_id_blocks: '[[120000000000003],[120000000000005,120000000000003]]' })
  })
  it('contextual bundles opt-in SPENDS; comments off is said; SDK-only switches warn; archived takes a name only', () => {
    expect(ok(draft({ contextualBundling: 'OPT_IN' })).spendsMoney[0]).toMatch(/more Facebook placements/)
    expect(ok(draft({ comments: 'off' })).requests[0].params).toEqual({ brand_safety_config: '{"comment_moderation_filter":"AD_DISABLED"}' })
    expect(ok(draft({ fullFunnelExploration: 'LIMITED_EXPLORATION' })).warnings.join(' ')).toMatch(/SDK only/)
    expect(refusal(draft({ dailyBudgetCents: 3000 }, live({ adSet: adSet({ status: 'ARCHIVED' }) })))).toMatch(/only its name/)
    expect(refusal(draft({}))).toMatch(/Retail Media Network/)
  })
  it('goal and billing changes warn of review; a billing pair outside Meta\'s guide is warned', () => {
    const d = ok(draft({ optimizationGoal: 'LINK_CLICKS', billingEvent: 'THRUPLAY' }))
    expect(d.warnings.join(' ')).toMatch(/back to Meta's review/)
    expect(d.warnings.join(' ')).toMatch(/pairs the LINK_CLICKS goal with LINK_CLICKS or IMPRESSIONS/)
  })
})
