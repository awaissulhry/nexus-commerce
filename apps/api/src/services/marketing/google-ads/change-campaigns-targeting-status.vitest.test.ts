/**
 * Google Ads changes, PR 2 (2026-10-15) — campaigns, targeting, status and removal, built from a request and the live
 * state (pure): a new campaign is ALWAYS paused (Google's default is enabled) with the EU political ads declaration, its
 * own budget not shared, Google's automation off unless asked; a settings change sends only what moves, with snake_case
 * mask paths; what reaches more people or lets Google raise bids is SPENDS MONEY; enabling says when "everything else" is
 * open or no location is targeted; a removal of a budget or list in use is refused.
 */
import { describe, expect, it } from 'vitest'
import { campaignCreateDraft, campaignCreateRecordAfterRun, campaignSettingsDraft, scheduleCriteria } from './change-campaigns.js'
import { targetingDraft } from './change-targeting.js'
import { removeDraft, statusDraft } from './change-status.js'
import { lookupQuery } from './live-campaigns.js'
import type { LiveBudget, LiveCampaign, LiveCampaignDetail, LiveCriterion } from './live.js'

const C = 'customers/1234567890'
const camp = (campaignId: string, name: string, status: string, type = 'SEARCH', budget: LiveCampaign['budget'] = { budgetId: '12', name: null, amountCents: 700, shared: false }): LiveCampaign => ({
  campaignId, name, status, servingStatus: null, primaryStatus: null, type, subType: null, bidding: 'MANUAL_CPC', start: null, end: null,
  shopping: type === 'SHOPPING' ? { merchantId: '5', feedLabel: 'IT', priority: 'LOW' } : null, budget,
})
const SHARED: LiveBudget = { budgetId: '11', name: 'Shared A', amountCents: 1500, shared: true, deliveryMethod: 'STANDARD', period: 'DAILY', usedBy: 0, campaigns: [] }
const OWN: LiveBudget = { budgetId: '12', name: null, amountCents: 700, shared: false, deliveryMethod: 'STANDARD', period: 'DAILY', usedBy: 1, campaigns: [{ campaignId: '21', name: 'Search A', status: 'PAUSED' }] }
const settings = (over: Partial<LiveCampaignDetail['campaign']> = {}): LiveCampaignDetail['campaign'] => ({
  ...camp('21', 'Search A', 'PAUSED'),
  networks: { googleSearch: true, searchPartners: false, display: false, partnerSearch: false },
  locationOption: { include: 'PRESENCE', exclude: 'PRESENCE' }, audienceMode: [], euPoliticalAds: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
  aiMax: false, keywordMatchType: null, assetAutomation: [], manualCpcEnhanced: false, maxCpcCeilingCents: null, targetCpaCents: null, targetRoas: null,
  biddingStrategyId: null, localInventory: false, trackingTemplate: null, finalUrlSuffix: null, primaryStatusReasons: [],
  ...over,
})

describe('campaignCreateDraft', () => {
  it('a Standard Shopping campaign: PAUSED, priority as 0/1/2, shared budget, presence only, EU declaration, no search partners', () => {
    const d = campaignCreateDraft(C, 'EUR', {
      type: 'SHOPPING', name: 'Shop B', budgetId: '11', bidding: { strategy: 'MANUAL_CPC' }, startDate: '2026-10-16',
      shopping: { merchantId: '5', feedLabel: 'IT', priority: 'HIGH' }, locations: [{ id: '2380' }], schedule: [{ days: ['ALL'], from: '08:00', to: '24:00' }],
    }, { campaigns: [], budgets: [SHARED] })
    if ('refusal' in d) throw new Error(d.refusal)
    const create = (d.operations[0] as any).campaignOperation.create
    expect(create).toEqual({
      resourceName: `${C}/campaigns/-2`, name: 'Shop B', status: 'PAUSED', advertisingChannelType: 'SHOPPING', campaignBudget: `${C}/campaignBudgets/11`,
      manualCpc: { enhancedCpcEnabled: false },
      networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
      geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE', negativeGeoTargetType: 'PRESENCE' },
      containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING', startDateTime: '2026-10-16 00:00:00',
      shoppingSetting: { merchantId: '5', feedLabel: 'IT', campaignPriority: 2, enableLocal: false },
    })
    expect(d.operations[1]).toEqual({ campaignCriterionOperation: { create: { campaign: `${C}/campaigns/-2`, location: { geoTargetConstant: 'geoTargetConstants/2380' } } } })
    expect(d.operations).toHaveLength(1 + 1 + 7)
    expect((d.operations[2] as any).campaignCriterionOperation.create.adSchedule).toEqual({ dayOfWeek: 'MONDAY', startHour: 8, startMinute: 'ZERO', endHour: 24, endMinute: 'ZERO' })
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings[0]).toMatch(/made PAUSED/)
    expect(campaignCreateRecordAfterRun(d.after as never, [{ campaignResult: { resourceName: `${C}/campaigns/99` } }])).toEqual({ campaignId: '99', name: 'Shop B' })
  })

  it('a Search campaign: its own budget NOT shared first, Google\'s automation off, languages, audiences in observation', () => {
    const d = campaignCreateDraft(C, 'EUR', {
      type: 'SEARCH', name: 'Search B', dailyBudgetCents: 600, bidding: { strategy: 'MANUAL_CPC' }, languages: ['1004'], audiences: ['80000'], locations: [{ id: '2380' }],
    }, { campaigns: [], budgets: [] })
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations[0]).toEqual({ campaignBudgetOperation: { create: { resourceName: `${C}/campaignBudgets/-1`, amountMicros: '6000000', explicitlyShared: false, deliveryMethod: 'STANDARD' } } })
    const create = (d.operations[1] as any).campaignOperation.create
    expect(create).toMatchObject({
      status: 'PAUSED', campaignBudget: `${C}/campaignBudgets/-1`, aiMaxSetting: { enableAiMax: false },
      assetAutomationSettings: [
        { assetAutomationType: 'TEXT_ASSET_AUTOMATION', assetAutomationStatus: 'OPTED_OUT' },
        { assetAutomationType: 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION', assetAutomationStatus: 'OPTED_OUT' },
      ],
      targetingSetting: { targetRestrictions: [{ targetingDimension: 'AUDIENCE', bidOnly: true }] },
    })
    expect(create.keywordMatchType).toBeUndefined()
    expect(d.operations).toContainEqual({ campaignCriterionOperation: { create: { campaign: `${C}/campaigns/-2`, language: { languageConstant: 'languageConstants/1004' } } } })
    expect(d.operations).toContainEqual({ campaignCriterionOperation: { create: { campaign: `${C}/campaigns/-2`, userInterest: { userInterestCategory: `${C}/userInterests/80000` } } } })
    expect(campaignCreateRecordAfterRun(d.after as never, [{ campaignBudgetResult: { resourceName: `${C}/campaignBudgets/55` } }, { campaignResult: { resourceName: `${C}/campaigns/99` } }]))
      .toEqual({ campaignId: '99', name: 'Search B', ownBudgetId: '55' })
  })

  it('refused before anything is sent', () => {
    const live = { campaigns: [camp('21', 'Search A', 'PAUSED')], budgets: [SHARED, OWN] }
    const base = { type: 'SEARCH' as const, name: 'X', bidding: { strategy: 'MANUAL_CPC' as const } }
    expect(campaignCreateDraft(C, 'EUR', { ...base, name: 'search a', dailyBudgetCents: 100 }, live)).toMatchObject({ refusal: expect.stringContaining('already exists') })
    expect(campaignCreateDraft(C, 'EUR', base, live)).toMatchObject({ refusal: expect.stringContaining('one of them') })
    expect(campaignCreateDraft(C, 'EUR', { ...base, budgetId: '12' }, live)).toMatchObject({ refusal: expect.stringContaining('own budget') })
    expect(campaignCreateDraft(C, 'EUR', { ...base, type: 'SHOPPING', dailyBudgetCents: 100 }, live)).toMatchObject({ refusal: expect.stringContaining('merchantId') })
    expect(campaignCreateDraft(C, 'EUR', { ...base, dailyBudgetCents: 100, search: { finalUrlExpansion: true, textCustomization: false } }, live)).toMatchObject({ refusal: expect.stringContaining('text customization') })
    expect(campaignCreateDraft(C, 'EUR', { ...base, dailyBudgetCents: 100, schedule: [{ days: ['MONDAY'], from: '08:10', to: '12:00' }] }, live)).toMatchObject({ refusal: expect.stringContaining('minutes 00, 15, 30 or 45') })
    expect(scheduleCriteria([{ days: ['MONDAY'], from: '12:00', to: '08:00' }])).toMatchObject({ refusal: expect.stringContaining('ends before') })
  })
})

describe('campaignSettingsDraft', () => {
  const live = (over: Partial<LiveCampaignDetail['campaign']> = {}) => ({ campaign: settings(over), budget: OWN, campaigns: [camp('21', 'Search A', 'PAUSED')] })

  it('sends only what moves, with snake_case mask paths; turning things on and Google taking over bids is SPENDS MONEY', () => {
    const d = campaignSettingsDraft(C, 'EUR', '21', { searchPartners: true, aiMax: false, bidding: { strategy: 'MAXIMIZE_CLICKS', maxCpcCents: 45 }, dailyBudgetCents: 900 }, live())
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations[0]).toEqual({ campaignOperation: {
      update: { resourceName: `${C}/campaigns/21`, targetSpend: { cpcBidCeilingMicros: '450000' }, networkSettings: { targetSearchNetwork: true } },
      updateMask: 'target_spend.cpc_bid_ceiling_micros,network_settings.target_search_network',
    } })
    expect(d.operations[1]).toEqual({ campaignBudgetOperation: { update: { resourceName: `${C}/campaignBudgets/12`, amountMicros: '9000000' }, updateMask: 'amount_micros' } })
    expect(d.spendsMoney).toEqual([
      'Google sets the bids from now (Maximize clicks, max CPC EUR 0.45): cost per click can rise (the campaign is paused: nothing spends until it is enabled).',
      'Turns on search partners: ads can show in more places (the campaign is paused: nothing spends until it is enabled).',
      'Raises the daily budget EUR 7.00 → EUR 9.00 (the campaign is paused: nothing spends until it is enabled).',
    ])
    expect(d.before).toMatchObject({ campaignId: '21', settings: { searchPartners: false, bidding: { strategy: 'MANUAL_CPC' }, dailyBudgetCents: 700 } })
  })

  it('AI Max off turns text customization and final URL expansion off in the same request; URL expansion alone turns text on', () => {
    const on = [{ type: 'TEXT_ASSET_AUTOMATION', status: 'OPTED_IN' }, { type: 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION', status: 'OPTED_IN' }]
    const d = campaignSettingsDraft(C, 'EUR', '21', { aiMax: false }, live({ aiMax: true, assetAutomation: on }))
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations[0]).toEqual({ campaignOperation: {
      update: { resourceName: `${C}/campaigns/21`, aiMaxSetting: { enableAiMax: false }, assetAutomationSettings: [
        { assetAutomationType: 'TEXT_ASSET_AUTOMATION', assetAutomationStatus: 'OPTED_OUT' },
        { assetAutomationType: 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION', assetAutomationStatus: 'OPTED_OUT' },
      ] },
      updateMask: 'ai_max_setting.enable_ai_max,asset_automation_settings',
    } })
    expect(d.warnings).toContain('AI Max off also turns off text customization and final URL expansion: they serve only with AI Max.')
    const url = campaignSettingsDraft(C, 'EUR', '21', { finalUrlExpansion: true }, live({ aiMax: true }))
    if ('refusal' in url) throw new Error(url.refusal)
    expect((url.operations[0] as any).campaignOperation.update.assetAutomationSettings[0].assetAutomationStatus).toBe('OPTED_IN')
    expect(campaignSettingsDraft(C, 'EUR', '21', { textCustomization: false }, live({ assetAutomation: [{ type: 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION', status: 'OPTED_IN' }] })))
      .toMatchObject({ refusal: expect.stringContaining('final URL expansion') })
  })

  it('bidding: a leaf mask path even without a target (a message path is refused by Google); a portfolio reads as one; an unnamed strategy is refused', () => {
    const d = campaignSettingsDraft(C, 'EUR', '21', { bidding: { strategy: 'MAXIMIZE_CONVERSIONS' } }, live())
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations[0]).toEqual({ campaignOperation: { update: { resourceName: `${C}/campaigns/21`, maximizeConversions: {} }, updateMask: 'maximize_conversions.target_cpa_micros' } })
    expect(campaignSettingsDraft(C, 'EUR', '21', { bidding: { strategy: 'PORTFOLIO', portfolioId: '77' } }, live({ bidding: 'MAXIMIZE_CONVERSIONS', biddingStrategyId: '77' })))
      .toMatchObject({ refusal: expect.stringContaining('Nothing to change') })
    expect(campaignSettingsDraft(C, 'EUR', '21', { bidding: { strategy: 'MANUAL_CPC' } }, live({ bidding: 'TARGET_ROAS' })))
      .toMatchObject({ refusal: expect.stringContaining('cannot name') })
    const manual = campaignSettingsDraft(C, 'EUR', '21', { bidding: { strategy: 'MANUAL_CPC', maxCpcCents: 99 } }, live({ bidding: 'TARGET_SPEND' }))
    if ('refusal' in manual) throw new Error(manual.refusal)
    expect(manual.spendsMoney[0]).toMatch(/^Manual CPC from now/)
    expect((manual.after as any).settings.bidding).toEqual({ strategy: 'MANUAL_CPC' })
  })

  it('refused: a shared budget, Shopping-only and Search-only settings, nothing to change', () => {
    expect(campaignSettingsDraft(C, 'EUR', '21', { dailyBudgetCents: 900 }, { ...live(), budget: SHARED })).toMatchObject({ refusal: expect.stringContaining('set-google-budget') })
    expect(campaignSettingsDraft(C, 'EUR', '21', { priority: 'HIGH' }, live())).toMatchObject({ refusal: expect.stringContaining('Shopping') })
    expect(campaignSettingsDraft(C, 'EUR', '21', { searchPartners: false }, live())).toMatchObject({ refusal: expect.stringContaining('Nothing to change') })
  })
})

const crit = (criterionId: string, type: string, extra: Partial<LiveCriterion>): LiveCriterion => ({ criterionId, type, negative: false, name: null, bidModifier: null, ...extra })

describe('targetingDraft', () => {
  const live = (criteria: LiveCriterion[], status = 'ENABLED') => ({ campaign: settings({ status }), criteria })

  it('removing the LAST targeted location is SPENDS MONEY (every country); adding one is too', () => {
    const d = targetingDraft(C, '21', { removeLocations: [{ id: '2380' }] }, live([crit('7', 'LOCATION', { location: 'geoTargetConstants/2380' })]))
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([{ campaignCriterionOperation: { remove: `${C}/campaignCriteria/21~7` } }])
    expect(d.spendsMoney).toEqual(['Removes the LAST targeted location: the ads can show in EVERY country.'])
    expect(d.after).toMatchObject({ undo: { addLocations: [{ id: '2380' }] } })
  })

  it('the schedule is replaced as a whole (remove + create); more hours is SPENDS MONEY; undo keeps the old slots', () => {
    const now = [crit('8', 'AD_SCHEDULE', { schedule: { day: 'MONDAY', from: '08:00', to: '12:00' } })]
    const d = targetingDraft(C, '21', { schedule: [{ days: ['MONDAY'], from: '08:00', to: '24:00' }] }, live(now))
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([
      { campaignCriterionOperation: { remove: `${C}/campaignCriteria/21~8` } },
      { campaignCriterionOperation: { create: { campaign: `${C}/campaigns/21`, adSchedule: { dayOfWeek: 'MONDAY', startHour: 8, startMinute: 'ZERO', endHour: 24, endMinute: 'ZERO' } } } },
    ])
    expect(d.spendsMoney).toEqual(['The ads may show 12 more hours a week.'])
    expect(d.after).toMatchObject({ undo: { schedule: [{ days: ['MONDAY'], from: '08:00', to: '12:00' }] } })
  })

  it('audiences go in OBSERVATION; a campaign whose audiences TARGET is refused (Nexus never widens it by itself)', () => {
    const d = targetingDraft(C, '21', { addAudiences: ['80000'] }, { campaign: settings(), criteria: [] })
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations[0]).toEqual({ campaignOperation: { update: { resourceName: `${C}/campaigns/21`, targetingSetting: { targetRestrictions: [{ targetingDimension: 'AUDIENCE', bidOnly: true }] } }, updateMask: 'targeting_setting.target_restrictions' } })
    expect(targetingDraft(C, '21', { addAudiences: ['80000'] }, { campaign: settings({ audienceMode: [{ dimension: 'AUDIENCE', observationOnly: false }] }), criteria: [] }))
      .toMatchObject({ refusal: expect.stringContaining('TARGETING') })
  })

  it('schedule bid adjustments: kept, compared, a raise is SPENDS MONEY; a removed location comes back with its own', () => {
    const now = [crit('8', 'AD_SCHEDULE', { schedule: { day: 'MONDAY', from: '00:00', to: '08:00' }, bidModifier: 0.1 })]
    const d = targetingDraft(C, '21', { schedule: [{ days: ['MONDAY'], from: '00:00', to: '08:00' }] }, live(now))
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.spendsMoney).toEqual(['Raises the bid adjustment of 1 schedule slot.'])
    expect(d.after).toMatchObject({ undo: { schedule: [{ days: ['MONDAY'], from: '00:00', to: '08:00', bidModifier: 0.1 }] } })
    const same = targetingDraft(C, '21', { schedule: [{ days: ['MONDAY'], from: '00:00', to: '08:00', bidModifier: 0.1 }] }, live(now))
    expect(same).toMatchObject({ refusal: expect.stringContaining('already has this schedule') })
    const loc = targetingDraft(C, '21', { removeLocations: [{ id: '2380' }] }, live([crit('7', 'LOCATION', { location: 'geoTargetConstants/2380', bidModifier: 1.2 }), crit('9', 'LOCATION', { location: 'geoTargetConstants/2250' })]))
    if ('refusal' in loc) throw new Error(loc.refusal)
    expect(loc.after).toMatchObject({ undo: { addLocations: [{ id: '2380', bidModifier: 1.2 }] } })
  })
})

describe('statusDraft / removeDraft', () => {
  const campaigns = [camp('21', 'Shop A', 'PAUSED', 'SHOPPING'), camp('23', 'Search B', 'ENABLED')]

  it('pausing is a safe step; enabling is SPENDS MONEY and says when "everything else" is open or no location is targeted', () => {
    const d = statusDraft(C, { items: [{ kind: 'campaign', id: '21', status: 'ENABLED' }, { kind: 'campaign', id: '23', status: 'PAUSED' }] }, {
      campaigns, items: [], facts: { openEverythingElse: { 21: 1 }, noLocation: ['21'] },
    })
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([
      { campaignOperation: { update: { resourceName: `${C}/campaigns/21`, status: 'ENABLED' }, updateMask: 'status' } },
      { campaignOperation: { update: { resourceName: `${C}/campaigns/23`, status: 'PAUSED' }, updateMask: 'status' } },
    ])
    expect(d.spendsMoney).toEqual([
      'Enables the campaign "Shop A": it can spend its daily budget from now.',
      '"Shop A" leaves "everything else" open in 1 product group: it can advertise EVERY other product of the feed.',
    ])
    expect(d.warnings).toEqual(['"Shop A" targets no location: it can show in every country.'])
    expect(d.before).toEqual({ items: [{ kind: 'campaign', id: '21', status: 'PAUSED' }, { kind: 'campaign', id: '23', status: 'ENABLED' }] })
  })

  it('a keyword: its resource name; enabling it in a paused campaign says nothing serves yet', () => {
    const d = statusDraft(C, { items: [{ kind: 'keyword', id: '51~601' }], status: 'ENABLED' }, {
      campaigns, items: [{ kind: 'keyword', id: '51~601', name: 'jacket (EXACT)', status: 'PAUSED', campaignId: '21', campaignName: 'Shop A', campaignStatus: 'PAUSED', adGroupStatus: 'ENABLED' }], facts: { openEverythingElse: {}, noLocation: [] },
    })
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([{ adGroupCriterionOperation: { update: { resourceName: `${C}/adGroupCriteria/51~601`, status: 'ENABLED' }, updateMask: 'status' } }])
    expect(d.spendsMoney).toEqual(['Enables the keyword "jacket (EXACT)" (nothing serves until its campaign is enabled too).'])
  })

  it('remove: a negative keyword removed is SPENDS MONEY; budgets go after campaigns', () => {
    const d = removeDraft(C, { items: [{ kind: 'budget', id: '12' }, { kind: 'campaign', id: '21' }, { kind: 'keyword', id: '51~9' }] }, {
      campaigns, budgets: [OWN], lists: [],
      items: [{ kind: 'keyword', id: '51~9', name: 'cheap (PHRASE, negative)', status: 'ENABLED', campaignId: '23', campaignName: 'Search B', campaignStatus: 'ENABLED', adGroupStatus: 'ENABLED', negative: true }],
    })
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations.map((o) => Object.keys(o)[0])).toEqual(['campaignOperation', 'adGroupCriterionOperation', 'campaignBudgetOperation'])
    expect(d.spendsMoney).toEqual(['Removes the negative keyword cheap (PHRASE, negative) from "Search B": more searches can show the ads.'])
  })

  it('remove: never undone (said); a budget or list in use is refused', () => {
    const d = removeDraft(C, { items: [{ kind: 'campaign', id: '23' }] }, { campaigns, items: [], budgets: [], lists: [] })
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([{ campaignOperation: { remove: `${C}/campaigns/23` } }])
    expect(d.warnings[0]).toMatch(/cannot be undone/)
    expect(removeDraft(C, { items: [{ kind: 'budget', id: '12' }] }, { campaigns, items: [], budgets: [OWN], lists: [] })).toMatchObject({ refusal: expect.stringContaining('used by 1 campaign') })
    expect(removeDraft(C, { items: [{ kind: 'budget', id: '12' }, { kind: 'campaign', id: '21' }] }, { campaigns, items: [], budgets: [OWN], lists: [] })).not.toHaveProperty('refusal')
  })
})

describe('lookups', () => {
  it('a word of the name, quotes and wildcards taken out', () => {
    expect(lookupQuery('locations', "Italy")).toContain("WHERE geo_target_constant.name LIKE '%Italy%'")
    expect(lookupQuery('audiences', "Moto'rcycles%")).toContain("LIKE '%Moto rcycles%'")
    expect(() => lookupQuery('languages', "''")).toThrow(/Nothing was sent/)
  })
})
