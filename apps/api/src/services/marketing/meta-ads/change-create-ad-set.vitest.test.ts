/**
 * Meta step 19 — create-meta-ad-set as a draft (pure): born PAUSED, Advantage+ audience said explicitly (0 unless asked),
 * the EU payer / beneficiary from the account default or the request (refused with neither), a budget at one of the two
 * levels, step 18's bid and ROAS rules, the promoted object's rules, and every request judged by the gateway's exact rule.
 * Made-up ids.
 */
import { describe, expect, it } from 'vitest'
import { adSetCreateDraft, createTargeting, type AdSetCreateLive, type AdSetCreateRequest } from './change-create-ad-set.js'
import type { MetaChangeDraft } from './change-draft.js'
import type { LiveCampaign } from './live-settings.js'
import { metaWriteVerdict } from '../../gateway/meta-calls.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../../meta/api-version.js'

const C = '120000000000001'
const CAMPAIGN: LiveCampaign = {
  id: C, name: 'Campaign A', status: 'PAUSED', effectiveStatus: 'PAUSED', objective: 'OUTCOME_SALES', buyingType: 'AUCTION', smartPromotionType: null,
  dailyBudget: null, lifetimeBudget: null, spendCap: null, canUseSpendCap: true, bidStrategy: null, pacingType: null, promotedObject: null,
  specialAdCategories: [], specialAdCategory: null, specialAdCategoryCountry: null, budgetSharing: false, budgetScheduling: null, reelsTrendingAds: null, advantageState: null,
}
const LIVE: AdSetCreateLive = { adAccountId: '1234567890', currency: 'EUR', campaign: CAMPAIGN, pixels: new Set(['120000000000050']), pageId: '120000000000080', dsaDefaults: { payor: 'Shop A', beneficiary: 'Shop A' }, capabilities: null }
const NOW = new Date('2026-10-21T08:00:00Z')
const BASE: AdSetCreateRequest = { campaignId: C, name: 'Ad set B', optimizationGoal: 'LINK_CLICKS', dailyBudgetCents: 2000, targeting: { countries: ['IT'] } }
const ok = (r: Partial<AdSetCreateRequest>, live: Partial<AdSetCreateLive> = {}) => {
  const d = adSetCreateDraft({ ...BASE, ...r }, { ...LIVE, ...live }, NOW)
  if ('refusal' in d) throw new Error(d.refusal)
  return d
}
const no = (r: Partial<AdSetCreateRequest>, live: Partial<AdSetCreateLive> = {}) => {
  const d = adSetCreateDraft({ ...BASE, ...r }, { ...LIVE, ...live }, NOW)
  return 'refusal' in d ? d.refusal : null
}
const judged = (d: MetaChangeDraft) => metaWriteVerdict({
  method: 'POST', url: `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}/${d.requests[0].objectId}/${d.requests[0].edge}`, kind: 'write',
  body: new URLSearchParams(d.requests[0].params).toString(), objectKind: d.requests[0].objectKind,
})

describe('create-meta-ad-set', () => {
  it('a traffic ad set with its own budget: PAUSED, billing and bid strategy and Advantage+ audience said explicitly, checked by Meta', () => {
    const d = ok({})
    expect(d.requests[0]).toMatchObject({ objectId: 'act_1234567890', objectKind: 'adaccount', edge: 'adsets', kind: 'adset', check: 'meta', recommendations: true, raisesSpend: false, budget: false })
    expect(d.requests[0].params).toEqual({
      name: 'Ad set B', campaign_id: C, optimization_goal: 'LINK_CLICKS', billing_event: 'IMPRESSIONS', daily_budget: '2000', bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      targeting: '{"geo_locations":{"countries":["IT"]},"targeting_automation":{"advantage_audience":0}}', status: 'PAUSED',
    })
    expect(Object.keys(d.changes).join(' ')).toMatch(/Advantage\+ audience \(sent explicitly\).*Placements/)
    expect(judged(d)).toMatchObject({ write: { rule: 'adset.create' } })
  })
  it('the EU: the account\'s saved payer / beneficiary (not sent: Meta fills them), else the request\'s, else refused in words', () => {
    expect(ok({}).requests[0].params).not.toHaveProperty('dsa_payor')
    expect(Object.values(ok({}).changes).map((c) => String(c.to)).join(' ')).toMatch(/saved defaults: Shop A \/ Shop A/)
    expect(no({}, { dsaDefaults: null })).toMatch(/EU Digital Services Act.*Name both/)
    const named = ok({ dsa: { payor: 'Shop A', beneficiary: 'Shop A' } }, { dsaDefaults: null })
    expect(named.requests[0].params).toMatchObject({ dsa_payor: 'Shop A', dsa_beneficiary: 'Shop A' })
    expect(judged(named)).toMatchObject({ write: { rule: 'adset.create' } })
    // A region key: Nexus cannot place it outside the EU.
    expect(no({ targeting: { regions: ['1000002'] } }, { dsaDefaults: null })).toMatch(/region or city key/)
    expect(ok({ targeting: { countries: ['US'] } }, { dsaDefaults: null }).requests[0].params).not.toHaveProperty('dsa_payor')
  })
  it('a budget at one level: its own without a campaign budget, a minimum / cap under one', () => {
    expect(no({ dailyBudgetCents: undefined })).toMatch(/name this ad set's own budget/)
    const cbo = { campaign: { ...CAMPAIGN, dailyBudget: '10000', bidStrategy: 'LOWEST_COST_WITHOUT_CAP' } }
    expect(no({}, cbo)).toMatch(/campaign budget: its ad sets take none of their own/)
    const d = ok({ dailyBudgetCents: undefined, minSpendTargetCents: 1000, spendCapCents: 4000 }, cbo)
    expect(d.requests[0].params).toMatchObject({ daily_min_spend_target: '1000', daily_spend_cap: '4000' })
    expect(d.requests[0].params).not.toHaveProperty('bid_strategy')
    expect(judged(d)).toMatchObject({ write: { rule: 'adset.create' } })
    expect(no({ dailyBudgetCents: undefined, lifetimeBudgetCents: 90000 })).toMatch(/needs an end time/)
    expect(no({ endTime: '2026-10-21T20:00:00Z' })).toMatch(/longer than 24 hours/)
  })
  it('bids: a cap needs its amount, a ROAS goal the VALUE goal; under a campaign ROAS goal each ad set sends its floor alone', () => {
    expect(no({ bidStrategy: 'COST_CAP' })).toMatch(/needs this ad set's cap/)
    expect(no({ bidStrategy: 'COST_CAP', bidAmountCents: 150, billingEvent: 'LINK_CLICKS' })).toMatch(/billing on impressions/)
    expect(ok({ bidStrategy: 'LOWEST_COST_WITH_BID_CAP', bidAmountCents: 150 }).requests[0].params.bid_amount).toBe('150')
    expect(no({ bidAmountCents: 150 })).toMatch(/bids automatically/)
    expect(no({ bidStrategy: 'LOWEST_COST_WITH_MIN_ROAS', roasGoal: 2 })).toMatch(/VALUE performance goal/)
    const roasCampaign = { campaign: { ...CAMPAIGN, dailyBudget: '10000', bidStrategy: 'LOWEST_COST_WITH_MIN_ROAS' } }
    const d = ok({ dailyBudgetCents: undefined, optimizationGoal: 'VALUE', roasGoal: 2.5, promotedObject: { pixelId: '120000000000050', customEventType: 'PURCHASE' } }, roasCampaign)
    expect(d.requests[0].params.bid_constraints).toBe('{"roas_average_floor":25000}')
    expect(judged(d)).toMatchObject({ write: { rule: 'adset.create' } })
    expect(no({ dailyBudgetCents: undefined, optimizationGoal: 'VALUE' }, roasCampaign)).toMatch(/minimum ROAS/)
  })
  it('promoted object: a Sales conversions ad set counts something; a pixel with its event; only the chosen Page; a boosted set with its product set', () => {
    expect(no({ optimizationGoal: 'OFFSITE_CONVERSIONS' })).toMatch(/needs what it counts/)
    expect(no({ optimizationGoal: 'OFFSITE_CONVERSIONS', promotedObject: { pixelId: '120000000000050' } })).toMatch(/conversion event/)
    expect(ok({ optimizationGoal: 'OFFSITE_CONVERSIONS', promotedObject: { pixelId: '120000000000050', customEventType: 'PURCHASE' } }).requests[0].params.promoted_object).toBe('{"pixel_id":"120000000000050","custom_event_type":"PURCHASE"}')
    expect(no({ promotedObject: { pageId: '120000000000089' } })).toMatch(/not the Facebook Page this business chose/)
    const leads = { campaign: { ...CAMPAIGN, objective: 'OUTCOME_LEADS' } }
    expect(no({ optimizationGoal: 'LEAD_GENERATION', destinationType: 'ON_AD' }, leads)).toMatch(/names its Page/)
    const lead = ok({ optimizationGoal: 'LEAD_GENERATION', destinationType: 'ON_AD', promotedObject: { pageId: '120000000000080' } }, leads)
    expect(judged(lead)).toMatchObject({ write: { ids: expect.arrayContaining([{ id: '120000000000080', kind: 'page' }]) } })
    expect(no({ promotedObject: { boostedProductSetId: '120000000000062' } })).toMatch(/goes with the catalog's product set/)
    expect(no({ promotedObject: { productSetId: '120000000000061' } }, { catalogProblem: 'Catalog 1 is not one the chosen ad account\'s business portfolio owns or was given, so it is not sent.' })).toMatch(/business portfolio/)
  })
  it('switching on is the person\'s decision; under a paused campaign it says nothing spends until the campaign is on', () => {
    const d = ok({ activate: true })
    expect(d.requests[0]).toMatchObject({ raisesSpend: true, params: expect.objectContaining({ status: 'ACTIVE' }) })
    expect(d.spendsMoney[0]).toMatch(/nothing spends until campaign "Campaign A" .* is on too/)
    expect(ok({ activate: true }, { campaign: { ...CAMPAIGN, status: 'ACTIVE' } }).spendsMoney[0]).toMatch(/spends once an ad under it is on/)
  })
  it('refuses an app campaign, a legacy campaign and a billing that does not fit the goal', () => {
    expect(no({}, { campaign: { ...CAMPAIGN, objective: 'OUTCOME_APP_PROMOTION' } })).toMatch(/no app/)
    expect(no({}, { campaign: { ...CAMPAIGN, smartPromotionType: 'AUTOMATED_SHOPPING_ADS' } })).toMatch(/legacy/)
    expect(no({ optimizationGoal: 'REACH', billingEvent: 'LINK_CLICKS' })).toMatch(/billing guide/)
  })
  it('dynamic creative and Advantage+ say what they mean; an Advantage+ audience ad set in a Sales campaign with a campaign budget makes it Advantage+', () => {
    expect(ok({ dynamicCreative: true }).warnings.join(' ')).toMatch(/placement asset customization cannot run in it/)
    const adv = ok({ dailyBudgetCents: undefined, targeting: { countries: ['IT'], advantageAudience: true } }, { campaign: { ...CAMPAIGN, dailyBudget: '10000', bidStrategy: 'LOWEST_COST_WITHOUT_CAP' } })
    expect(adv.requests[0].params.targeting).toContain('"advantage_audience":1')
    expect(adv.warnings.join(' ')).toMatch(/ADVANTAGE_PLUS_SALES/)
  })
})

describe('fix round 1', () => {
  it('review B2 / B7 — under ad set budget sharing the campaign\'s bid strategy, read live; another refused; a daily budget only', () => {
    const sharing = { campaign: { ...CAMPAIGN, budgetSharing: true, bidStrategy: 'COST_CAP' } }
    const d = ok({ bidAmountCents: 150 }, sharing)
    expect(d.requests[0].params).toMatchObject({ bid_strategy: 'COST_CAP', bid_amount: '150' })
    expect(no({ bidStrategy: 'LOWEST_COST_WITHOUT_CAP' }, sharing)).toMatch(/4834009/)
    expect(no({ dailyBudgetCents: undefined, lifetimeBudgetCents: 90000, endTime: '2026-12-01T00:00:00Z', bidAmountCents: 150 }, sharing)).toMatch(/daily budgets only/)
    expect(no({}, { campaign: { ...CAMPAIGN, budgetSharing: true, bidStrategy: null } })).toMatch(/could not read its bid strategy/)
  })
  it('review B3 — WhatsApp marketing messages: named for an onboarded account on an eligible goal; said when unread; nothing otherwise', () => {
    const onboarded = ok({}, { whatsApp: { status: 'MARKETING_MESSAGE_ONBOARDED' } })
    expect(Object.values(onboarded.changes).map((c) => String(c.to)).join(' ')).toMatch(/Meta adds WhatsApp marketing messages to this ad set's placements/)
    expect(ok({ activate: true }, { whatsApp: { status: 'MARKETING_MESSAGE_ONBOARDED' }, campaign: { ...CAMPAIGN, status: 'ACTIVE' } }).spendsMoney[0]).toMatch(/WhatsApp marketing messages/)
    expect(ok({}, { whatsApp: { unread: 'Permissions error.' } }).warnings.join(' ')).toMatch(/could not read whether this ad account is onboarded to WhatsApp marketing messages/)
    expect(Object.keys(ok({}, { whatsApp: { status: 'MARKETING_MESSAGE_NOT_ONBOARDED' } }).changes).join(' ')).not.toMatch(/WhatsApp/)
    // REACH is not an eligible goal: nothing said even for an onboarded account.
    expect(Object.keys(ok({ optimizationGoal: 'REACH' }, { whatsApp: { status: 'MARKETING_MESSAGE_ONBOARDED' } }).changes).join(' ')).not.toMatch(/WhatsApp/)
  })
  it('review A6 / B6 — the EU\'s outermost regions need the payer; under 18 refused in the EU, the EEA and CH', () => {
    expect(no({ targeting: { countries: ['RE'] } }, { dsaDefaults: null })).toMatch(/it reaches RE/)
    expect(() => createTargeting({ countries: ['NO'], ageMin: 16 })).toThrow(/EU, the EEA or Switzerland.*NO/)
    expect(() => createTargeting({ countries: ['CH'], ageMin: 17 })).toThrow(/CH/)
    expect(createTargeting({ countries: ['NO'] }).eu).toBe(false)
    expect(createTargeting({ countries: ['GP'] }).eu).toBe(true)
  })
})

describe('createTargeting', () => {
  it('one spelling the gateway takes; the EU and its minimum age; Advantage+ audience\'s age rules', () => {
    expect(createTargeting({ countries: ['it'], ageMin: 21, gender: 'female', customAudienceIds: ['120000000000070'] }).value)
      .toBe('{"geo_locations":{"countries":["IT"]},"age_min":21,"genders":[2],"custom_audiences":[{"id":"120000000000070"}],"targeting_automation":{"advantage_audience":0}}')
    expect(() => createTargeting({ countries: ['IT'], ageMin: 16 })).toThrow(/under 18 in the EU/)
    expect(createTargeting({ countries: ['US'], ageMin: 16 }).eu).toBe(false)
    expect(() => createTargeting({ countries: ['IT'], advantageAudience: true, ageMax: 40 })).toThrow(/leave ageMax out/)
    expect(() => createTargeting({})).toThrow(/countries, regions or cities/)
    expect(() => createTargeting({ cities: [{ key: '1000001', radiusKm: 5 }] })).toThrow(/17 to 80/)
    expect(() => createTargeting({ countries: ['IT'], customAudienceIds: ['1'], excludedCustomAudienceIds: ['1'] })).toThrow(/not both/)
  })
})
