/**
 * Google Ads changes, programme 2 G2 (2026-10-15) — devices, location and radius bid adjustments, radius targeting,
 * audience segments and demographics, built from a request and the live state (pure). What reaches more people or bids
 * more is SPENDS MONEY; narrowing is a warning; Google's own refusals (a device criterion is never removed, the targeting
 * setting on one level only, every demographic group excluded) are said before Google is asked; undo puts back exactly
 * what the change did.
 */
import { describe, expect, it } from 'vitest'
import { targetingDraft, targetingRecordAfterRun, type TargetingRecord } from './change-targeting.js'
import { audienceDraft, audienceRecordHolds, type AudienceLive, type AudienceRecord } from './change-audiences.js'
import { demographicRecordHolds, demographicsDraft, type DemographicRecord } from './change-demographics.js'
import {
  adGroupTargetingCriterionOf, adjustmentWords, liveAdGroupDevicesQuery, liveAdGroupTargetingQuery, liveTargetingAdGroupsQuery,
  liveTargetingCriteriaQuery, targetingCriterionOf, type AdGroupTargetingCriterion, type AudienceKind, type TargetingCriterion,
} from './live-targeting.js'
import type { LiveCampaignDetail } from './live.js'

const C = 'customers/1234567890'
const campaign = (over: Partial<LiveCampaignDetail['campaign']> = {}): LiveCampaignDetail['campaign'] => ({
  campaignId: '21', name: 'Search A', status: 'ENABLED', servingStatus: null, primaryStatus: null, type: 'SEARCH', subType: null, bidding: 'MANUAL_CPC',
  start: null, end: null, shopping: null, budget: null,
  networks: { googleSearch: true, searchPartners: false, display: false, partnerSearch: false },
  locationOption: { include: 'PRESENCE', exclude: 'PRESENCE' }, audienceMode: [], euPoliticalAds: null, aiMax: false, keywordMatchType: null,
  assetAutomation: [], manualCpcEnhanced: false, maxCpcCeilingCents: null, targetCpaCents: null, targetRoas: null, biddingStrategyId: null,
  localInventory: false, trackingTemplate: null, finalUrlSuffix: null, primaryStatusReasons: [],
  ...over,
})
const crit = (criterionId: string, type: string, extra: Partial<TargetingCriterion> = {}): TargetingCriterion => ({ criterionId, type, negative: false, name: null, bidModifier: null, ...extra })
const agCrit = (adGroupId: string, criterionId: string, type: string, extra: Partial<AdGroupTargetingCriterion> = {}): AdGroupTargetingCriterion => ({ adGroupId, criterionId, type, negative: false, name: null, bidModifier: null, ...extra })
const AG = { adGroupId: '51', name: 'Jackets', status: 'ENABLED', audienceMode: [] }
const AG2 = { adGroupId: '52', name: 'Gloves', status: 'ENABLED', audienceMode: [] }

describe('live-targeting reads', () => {
  it('every field of another resource in a WHERE is selected too; types listed; ids checked', () => {
    expect(liveTargetingCriteriaQuery('21')).toMatch(/^SELECT campaign\.id, /)
    expect(liveTargetingCriteriaQuery('21')).toContain("campaign_criterion.type IN ('LOCATION', 'PROXIMITY', 'LANGUAGE', 'AD_SCHEDULE', 'DEVICE', 'USER_LIST', 'USER_INTEREST', 'CUSTOM_AUDIENCE', 'COMBINED_AUDIENCE', 'LIFE_EVENT', 'AGE_RANGE', 'GENDER', 'PARENTAL_STATUS', 'INCOME_RANGE')")
    for (const q of [liveAdGroupTargetingQuery('21'), liveAdGroupDevicesQuery('21')]) expect(q).toMatch(/^SELECT campaign\.id, ad_group\.id, ad_group\.status, /)
    expect(liveTargetingAdGroupsQuery('21')).toMatch(/^SELECT campaign\.id, ad_group\.id, ad_group\.name, ad_group\.status, ad_group\.targeting_setting\.target_restrictions FROM ad_group/)
    expect(() => liveTargetingCriteriaQuery('21 OR 1=1')).toThrow(/Nothing was sent/)
  })

  it('maps devices, radii (default KILOMETERS), demographics and every audience kind; a FLOAT adjustment is rounded', () => {
    expect(targetingCriterionOf({ campaignCriterion: { criterionId: '30001', type: 'DEVICE', bidModifier: 1.2000000476837158, device: { type: 'MOBILE' } } }))
      .toMatchObject({ criterionId: '30001', device: 'MOBILE', bidModifier: 1.2 })
    expect(targetingCriterionOf({ campaignCriterion: { criterionId: '7', type: 'PROXIMITY', proximity: { geoPoint: { latitudeInMicroDegrees: 10500000, longitudeInMicroDegrees: 20250000 }, radius: 10, address: { cityName: 'Town' } } } }))
      .toMatchObject({ proximity: { latitudeMicro: 10500000, longitudeMicro: 20250000, radius: 10, units: 'KILOMETERS', address: 'Town' } })
    expect(targetingCriterionOf({ campaignCriterion: { criterionId: '8', type: 'USER_LIST', negative: true, userList: { userList: `${C}/userLists/301` } } }))
      .toMatchObject({ negative: true, segment: { kind: 'USER_LIST', id: '301' }, audience: `${C}/userLists/301` })
    expect(adGroupTargetingCriterionOf({ adGroup: { id: '51' }, adGroupCriterion: { criterionId: '9', type: 'LIFE_EVENT', lifeEvent: { lifeEventId: '444' } } })).toMatchObject({ adGroupId: '51', segment: { kind: 'LIFE_EVENT', id: '444' } })
    expect(adGroupTargetingCriterionOf({ adGroup: { id: '51' }, adGroupCriterion: { criterionId: '503002', type: 'AGE_RANGE', bidModifier: 1.3, ageRange: { type: 'AGE_RANGE_25_34' } } }))
      .toMatchObject({ demographic: { dimension: 'AGE_RANGE', value: 'AGE_RANGE_25_34' }, bidModifier: 1.3 })
    expect([adjustmentWords(1.2), adjustmentWords(0.8), adjustmentWords(0), adjustmentWords(null)]).toEqual(['+20 %', '−20 %', '−100 % (excluded)', 'none'])
  })
})

describe('targetingDraft — devices, location and radius bid adjustments, radius targeting', () => {
  const live = (criteria: TargetingCriterion[], over: Partial<LiveCampaignDetail['campaign']> = {}, extra = {}) => ({ campaign: campaign(over), criteria, ...extra })

  it('a campaign device: update where Google has the criterion, create where not; a raise and a device shown again are SPENDS MONEY; undo keeps the old factors', () => {
    const d = targetingDraft(C, '21', { devices: [{ device: 'MOBILE', bidModifier: 1.3 }, { device: 'TABLET', bidModifier: 1 }, { device: 'DESKTOP', bidModifier: 0.5 }] },
      live([crit('30001', 'DEVICE', { device: 'MOBILE', bidModifier: 1.1 }), crit('30002', 'DEVICE', { device: 'TABLET', bidModifier: 0 })]))
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([
      { campaignCriterionOperation: { update: { resourceName: `${C}/campaignCriteria/21~30001`, bidModifier: 1.3 }, updateMask: 'bid_modifier' } },
      { campaignCriterionOperation: { update: { resourceName: `${C}/campaignCriteria/21~30002`, bidModifier: 1 }, updateMask: 'bid_modifier' } },
      { campaignCriterionOperation: { create: { campaign: `${C}/campaigns/21`, device: { type: 'DESKTOP' }, bidModifier: 0.5 } } },
    ])
    expect(d.spendsMoney).toEqual([
      'Raises the mobile phones bid adjustment (+10 % → +30 %).',
      'Shows the ads on tablets again (they were excluded).',
    ])
    expect(d.after).toMatchObject({ undo: { devices: [{ device: 'MOBILE', bidModifier: 1.1 }, { device: 'TABLET', bidModifier: 0 }, { device: 'DESKTOP', bidModifier: null }] } })
  })

  it('opting out of every computer, phone and tablet is refused; Smart Bidding is warned about', () => {
    const now = [crit('30000', 'DEVICE', { device: 'DESKTOP', bidModifier: 0 }), crit('30002', 'DEVICE', { device: 'TABLET', bidModifier: 0 })]
    expect(targetingDraft(C, '21', { devices: [{ device: 'MOBILE', bidModifier: 0 }] }, live(now))).toMatchObject({ refusal: expect.stringContaining('could show nowhere') })
    const smart = targetingDraft(C, '21', { devices: [{ device: 'MOBILE', bidModifier: 1.2 }] }, live([], { bidding: 'MAXIMIZE_CONVERSIONS' }))
    if ('refusal' in smart) throw new Error(smart.refusal)
    expect(smart.warnings).toEqual(['"Search A" bids with MAXIMIZE_CONVERSIONS: Google\'s Smart Bidding uses a device bid adjustment only as −100 % (opt out); other device adjustments are not used.'])
    // With a CPA target, a device adjustment changes the CPA target for that device (Google Ads Help 2732132).
    for (const over of [{ bidding: 'TARGET_CPA' }, { bidding: 'MAXIMIZE_CONVERSIONS', targetCpaCents: 900 }]) {
      const cpa = targetingDraft(C, '21', { devices: [{ device: 'MOBILE', bidModifier: 1.2 }], locationBids: [{ id: '2380', bidModifier: 1.1 }] }, live([crit('7', 'LOCATION', { location: 'geoTargetConstants/2380' })], over))
      if ('refusal' in cpa) throw new Error(cpa.refusal)
      expect(cpa.warnings).toEqual([
        `"Search A" bids with ${over.bidding} and a CPA target: Google applies a device bid adjustment to the CPA target for that device, not to the bids (−100 % still opts out).`,
        `"Search A" bids with ${over.bidding}: Google's Smart Bidding does not use location and radius bid adjustments (exclusions and targeting still apply).`,
      ])
    }
  })

  it('an ad group\'s own device adjustment: create, update, remove (follow the campaign); refused while the campaign opts out', () => {
    const extra = { adGroups: [AG], adGroupDevices: [{ adGroupId: '51', criterionId: '30002', device: 'TABLET', bidModifier: 0.7 }] }
    const d = targetingDraft(C, '21', { devices: [{ device: 'MOBILE', adGroupId: '51', bidModifier: 1.5 }, { device: 'TABLET', adGroupId: '51', bidModifier: null }] },
      live([crit('30001', 'DEVICE', { device: 'MOBILE', bidModifier: 1.2 })], {}, extra))
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([
      { adGroupBidModifierOperation: { create: { adGroup: `${C}/adGroups/51`, device: { type: 'MOBILE' }, bidModifier: 1.5 } } },
      { adGroupBidModifierOperation: { remove: `${C}/adGroupBidModifiers/51~30002` } },
    ])
    // Mobile: the ad group's +50 % replaces the campaign's +20 %; tablets: −30 % gone, the campaign's none applies.
    expect(d.spendsMoney).toEqual([
      'Raises the mobile phones bid adjustment of ad group "Jackets" (+20 % → +50 %).',
      'Raises the tablets bid adjustment of ad group "Jackets" (−30 % → none).',
    ])
    expect(d.after).toMatchObject({ undo: { devices: [{ device: 'MOBILE', adGroupId: '51', bidModifier: null }, { device: 'TABLET', adGroupId: '51', bidModifier: 0.7 }] } })
    expect(targetingDraft(C, '21', { devices: [{ device: 'MOBILE', adGroupId: '51', bidModifier: 1.5 }] }, live([crit('30001', 'DEVICE', { device: 'MOBILE', bidModifier: 0 })], {}, extra)))
      .toMatchObject({ refusal: expect.stringContaining('opts out of mobile phones') })
    expect(targetingDraft(C, '21', { devices: [{ device: 'MOBILE', adGroupId: '99', bidModifier: 1.5 }] }, live([], {}, extra))).toMatchObject({ refusal: expect.stringContaining('Ad group 99') })
  })

  it('a targeted location\'s bid adjustment is an update; a radius\'s too; an excluded location has none', () => {
    const now = [crit('7', 'LOCATION', { location: 'geoTargetConstants/2380', bidModifier: 1.1, name: 'Italy' }), crit('8', 'PROXIMITY', { proximity: { latitudeMicro: 1, longitudeMicro: 2, radius: 5, units: 'KILOMETERS', address: null } }), crit('9', 'LOCATION', { location: 'geoTargetConstants/2250', negative: true })]
    const d = targetingDraft(C, '21', { locationBids: [{ id: '2380', bidModifier: 0.9 }, { radiusId: '8', bidModifier: 1.4 }] }, live(now, { status: 'PAUSED' }))
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([
      { campaignCriterionOperation: { update: { resourceName: `${C}/campaignCriteria/21~7`, bidModifier: 0.9 }, updateMask: 'bid_modifier' } },
      { campaignCriterionOperation: { update: { resourceName: `${C}/campaignCriteria/21~8`, bidModifier: 1.4 }, updateMask: 'bid_modifier' } },
    ])
    expect(d.spendsMoney).toEqual(['Raises the bid adjustment of radius 8 (none → +40 %) (the campaign is paused: nothing spends until it is enabled).'])
    expect(d.after).toMatchObject({ undo: { locationBids: [{ id: '2380', bidModifier: 1.1 }, { radiusId: '8', bidModifier: null }] }, set: { locationBids: [{ id: '2380', bidModifier: 0.9 }, { radiusId: '8', bidModifier: 1.4 }] } })
    expect(targetingDraft(C, '21', { locationBids: [{ id: '2250', bidModifier: 1.2 }] }, live(now))).toMatchObject({ refusal: expect.stringContaining('excluded location has no bid adjustment') })
  })

  it('a radius is a targeted place: added (point or address), removed with undo by its spec, its new id recorded after the run', () => {
    const d = targetingDraft(C, '21', { addRadius: [{ latitude: 10.5, longitude: 20.25, radius: 10 }, { address: { city: 'Town', countryCode: 'it' }, radius: 5, units: 'MILES', bidModifier: 1.2 }] },
      live([crit('7', 'LOCATION', { location: 'geoTargetConstants/2380' })]))
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([
      { campaignCriterionOperation: { create: { campaign: `${C}/campaigns/21`, proximity: { geoPoint: { latitudeInMicroDegrees: 10500000, longitudeInMicroDegrees: 20250000 }, radius: 10, radiusUnits: 'KILOMETERS' } } } },
      { campaignCriterionOperation: { create: { campaign: `${C}/campaigns/21`, proximity: { address: { cityName: 'Town', countryCode: 'IT' }, radius: 5, radiusUnits: 'MILES' }, bidModifier: 1.2 } } },
    ])
    expect(d.spendsMoney).toEqual(['Bids +20 % in the new 5 miles radius.', 'Targets 2 more locations: the ads can reach more people.'])
    const record = targetingRecordAfterRun(d.after as TargetingRecord, [{ campaignCriterionResult: { resourceName: `${C}/campaignCriteria/21~901` } }, { campaignCriterionResult: { resourceName: `${C}/campaignCriteria/21~902` } }])
    expect(record).toEqual({ campaignId: '21', undo: { removeRadius: ['901', '902'] } })

    const r = targetingDraft(C, '21', { removeRadius: ['8'] }, live([crit('8', 'PROXIMITY', { bidModifier: 1.2, proximity: { latitudeMicro: 10500000, longitudeMicro: 20250000, radius: 10, units: 'KILOMETERS', address: null } })]))
    if ('refusal' in r) throw new Error(r.refusal)
    expect(r.operations).toEqual([{ campaignCriterionOperation: { remove: `${C}/campaignCriteria/21~8` } }])
    expect(r.spendsMoney).toEqual(['Removes the LAST targeted location: the ads can show in EVERY country.'])
    expect(r.after).toMatchObject({ undo: { addRadius: [{ latitude: 10.5, longitude: 20.25, radius: 10, units: 'KILOMETERS', bidModifier: 1.2 }] } })
    expect(targetingDraft(C, '21', { addRadius: [{ latitude: 10.5, radius: 10 }] }, live([]))).toMatchObject({ refusal: expect.stringContaining('both latitude and longitude') })
  })

  const names = { segmentNames: { 'USER_INTEREST|80000': { name: 'Motorcycles', status: null } } }
  const interest = (extra: Partial<TargetingCriterion> = {}) => crit('5', 'USER_INTEREST', { audience: `${C}/userInterests/80000`, segment: { kind: 'USER_INTEREST', id: '80000' }, ...extra })
  const OBSERVES = { audienceMode: [{ dimension: 'AUDIENCE', observationOnly: true }] }

  it('interests: never turns segments that narrow into observation by itself — at the campaign or at an ad group', () => {
    expect(targetingDraft(C, '21', { addAudiences: ['80000'] }, live([crit('5', 'USER_LIST', { segment: { kind: 'USER_LIST', id: '301' } })], {}, { ...names, adGroups: [], adGroupCriteria: [] })))
      .toMatchObject({ refusal: expect.stringContaining('set-google-audiences') })
    // An ad group's segment with no setting is TARGETING (Google's default): observation at the campaign would widen it.
    const agSegment = { adGroupId: '51', criterionId: '9', type: 'USER_LIST', negative: false, name: null, bidModifier: null, segment: { kind: 'USER_LIST' as const, id: '301' } }
    expect(targetingDraft(C, '21', { addAudiences: ['80000'] }, live([], {}, { ...names, adGroups: [AG], adGroupCriteria: [agSegment] })))
      .toMatchObject({ refusal: expect.stringContaining('at the campaign or its ad groups') })
    // An ad group with its own setting: Google keeps it on one level.
    expect(targetingDraft(C, '21', { addAudiences: ['80000'] }, live([], {}, { ...names, adGroups: [{ ...AG, audienceMode: [{ dimension: 'AUDIENCE', observationOnly: true }] }], adGroupCriteria: [] })))
      .toMatchObject({ refusal: expect.stringContaining('not both') })
    // An id Google does not know is refused; a known one is named in the preview.
    expect(targetingDraft(C, '21', { addAudiences: ['80001'] }, live([], {}, { ...names, adGroups: [], adGroupCriteria: [] }))).toMatchObject({ refusal: expect.stringContaining('lookup audiences') })
  })

  it('interests: the first one sets observation where nothing narrows, and undo takes that setting off again', () => {
    const d = targetingDraft(C, '21', { addAudiences: ['80000'] }, live([], {}, { ...names, adGroups: [AG], adGroupCriteria: [] }))
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.changes).toMatchObject({ 'interest "Motorcycles" (80000)': { from: '—', to: 'observed' }, 'audience setting': { from: 'none (Google: targeting)', to: 'observation (bids only)' } })
    expect(d.after).toMatchObject({ undo: { removeAudiences: ['80000'], clearAudienceSetting: true }, set: { audienceSetting: 'OBSERVATION' } })
    const back = targetingDraft(C, '21', { removeAudiences: ['80000'], clearAudienceSetting: true }, live([interest()], OBSERVES, { adGroups: [AG], adGroupCriteria: [] }))
    if ('refusal' in back) throw new Error(back.refusal)
    expect(back.operations).toEqual([
      { campaignCriterionOperation: { remove: `${C}/campaignCriteria/21~5` } },
      { campaignOperation: { update: { resourceName: `${C}/campaigns/21`, targetingSetting: { targetRestrictions: [] } }, updateMask: 'targeting_setting.target_restrictions' } },
    ])
    expect(back.spendsMoney).toEqual([])
    // A segment left would then narrow: refused.
    expect(targetingDraft(C, '21', { clearAudienceSetting: true }, live([interest()], OBSERVES, { adGroups: [AG], adGroupCriteria: [] }))).toMatchObject({ refusal: expect.stringContaining('still has 1 audience segment') })
  })

  it('interests: removes only an observed, unadjusted interest; an exclusion, TARGETING and a bid adjustment go to set-google-audiences', () => {
    const extra = { adGroups: [AG], adGroupCriteria: [] }
    const d = targetingDraft(C, '21', { removeAudiences: ['80000'] }, live([interest()], OBSERVES, extra))
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([{ campaignCriterionOperation: { remove: `${C}/campaignCriteria/21~5` } }])
    expect(d.spendsMoney).toEqual([])
    expect(d.after).toMatchObject({ undo: { addAudiences: ['80000'] } })
    expect(targetingDraft(C, '21', { removeAudiences: ['80000'] }, live([interest({ negative: true })], OBSERVES, extra))).toMatchObject({ refusal: expect.stringContaining('is an exclusion') })
    expect(targetingDraft(C, '21', { removeAudiences: ['80000'] }, live([interest()], {}, extra))).toMatchObject({ refusal: expect.stringContaining('TARGETING') })
    expect(targetingDraft(C, '21', { removeAudiences: ['80000'] }, live([interest()], { audienceMode: [{ dimension: 'AUDIENCE', observationOnly: false }] }, extra))).toMatchObject({ refusal: expect.stringContaining('TARGETING') })
    expect(targetingDraft(C, '21', { removeAudiences: ['80000'] }, live([interest({ bidModifier: 0.8 })], OBSERVES, extra))).toMatchObject({ refusal: expect.stringContaining('bid adjustment') })
    expect(targetingDraft(C, '21', { addAudiences: ['80000'] }, live([interest({ negative: true })], OBSERVES, { ...extra, ...names }))).toMatchObject({ refusal: expect.stringContaining('is excluded') })
  })
})

describe('audienceDraft', () => {
  const NAMES = {
    'USER_LIST|301': { name: 'Site visitors', status: 'OPEN' }, 'LIFE_EVENT|444': { name: 'Moving soon', status: null }, 'CUSTOM_AUDIENCE|601': { name: 'Riders', status: 'ENABLED' },
    'USER_INTEREST|80000': { name: 'Motorcycles', status: null }, 'COMBINED_AUDIENCE|7': { name: 'Riders and visitors', status: 'ENABLED' }, 'CUSTOM_AUDIENCE|602': { name: 'Old', status: 'REMOVED' },
  }
  const live = (over: Partial<AudienceLive> = {}, camp: Partial<LiveCampaignDetail['campaign']> = {}): AudienceLive => ({ campaign: campaign(camp), criteria: [], adGroups: [AG, AG2], adGroupCriteria: [], segmentNames: NAMES, ...over })
  const seg = (kind: AudienceKind, id: string) => ({ segment: { kind, id } })

  it('a first segment where nothing narrows goes in OBSERVATION: the setting is set in the same request (first), every kind\'s resource name', () => {
    const d = audienceDraft(C, '21', { add: [{ kind: 'USER_LIST', id: '301', bidModifier: 1.2 }, { kind: 'LIFE_EVENT', id: '444' }, { kind: 'CUSTOM_AUDIENCE', id: '601' }] }, live())
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([
      { campaignOperation: { update: { resourceName: `${C}/campaigns/21`, targetingSetting: { targetRestrictions: [{ targetingDimension: 'AUDIENCE', bidOnly: true }] } }, updateMask: 'targeting_setting.target_restrictions' } },
      { campaignCriterionOperation: { create: { campaign: `${C}/campaigns/21`, bidModifier: 1.2, userList: { userList: `${C}/userLists/301` } } } },
      { campaignCriterionOperation: { create: { campaign: `${C}/campaigns/21`, lifeEvent: { lifeEventId: '444' } } } },
      { campaignCriterionOperation: { create: { campaign: `${C}/campaigns/21`, customAudience: { customAudience: `${C}/customAudiences/601` } } } },
    ])
    expect(d.spendsMoney).toEqual(['"Search A": bids more for people in 1 audience.'])
    expect(d.warnings).toEqual([])
    expect(d.after).toMatchObject({ undo: { remove: [{ kind: 'USER_LIST', id: '301' }, { kind: 'LIFE_EVENT', id: '444' }, { kind: 'CUSTOM_AUDIENCE', id: '601' }], modes: [{ mode: 'NONE' }] } })
    // Each new segment by its name, read live.
    expect(d.changes).toMatchObject({
      'your data segment "Site visitors" (301), "Search A"': { from: '—', to: 'observed, +20 %' },
      'life event "Moving soon" (444), "Search A"': { from: '—', to: 'observed' },
    })
  })

  it('an id Google does not know, or a removed segment, is refused before Google is asked', () => {
    expect(audienceDraft(C, '21', { add: [{ kind: 'USER_LIST', id: '399' }] }, live())).toMatchObject({ refusal: expect.stringContaining('lookup user-lists') })
    expect(audienceDraft(C, '21', { add: [{ kind: 'LIFE_EVENT', id: '445' }] }, live())).toMatchObject({ refusal: expect.stringContaining('lookup life-events') })
    expect(audienceDraft(C, '21', { add: [{ kind: 'CUSTOM_AUDIENCE', id: '602' }] }, live())).toMatchObject({ refusal: expect.stringContaining('is removed') })
  })

  it('where segments narrow (TARGETING, said or Google\'s default), the mode must be named; TARGETING → OBSERVATION is SPENDS MONEY', () => {
    const narrowing = live({ criteria: [crit('5', 'USER_LIST', seg('USER_LIST', '301'))] })
    expect(audienceDraft(C, '21', { add: [{ kind: 'USER_INTEREST', id: '80000' }] }, narrowing)).toMatchObject({ refusal: expect.stringContaining('Name the mode') })
    const d = audienceDraft(C, '21', { modes: [{ mode: 'OBSERVATION' }] }, narrowing)
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.spendsMoney).toEqual(['"Search A": its audiences stop narrowing who sees the ads (TARGETING → OBSERVATION) — they can show to everyone.'])
    expect(d.after).toMatchObject({ undo: { modes: [{ mode: 'NONE' }] }, set: { modes: [{ mode: 'OBSERVATION' }] } })
    // More segments in TARGETING reach more people.
    const t = audienceDraft(C, '21', { add: [{ kind: 'USER_INTEREST', id: '80000' }], modes: [{ mode: 'TARGETING' }] }, narrowing)
    if ('refusal' in t) throw new Error(t.refusal)
    expect(t.spendsMoney).toEqual(['"Search A": the ads reach people in 1 more audience (TARGETING).'])
  })

  it('narrowing is a warning: OBSERVATION → TARGETING, the first segment in TARGETING; the last segment of a TARGETING level removed is SPENDS MONEY', () => {
    const observed = live({ adGroupCriteria: [agCrit('51', '7', 'USER_LIST', seg('USER_LIST', '301'))], adGroups: [{ ...AG, audienceMode: [{ dimension: 'AUDIENCE', observationOnly: true }] }, AG2] })
    const d = audienceDraft(C, '21', { modes: [{ adGroupId: '51', mode: 'TARGETING' }] }, observed)
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([{ adGroupOperation: { update: { resourceName: `${C}/adGroups/51`, targetingSetting: { targetRestrictions: [{ targetingDimension: 'AUDIENCE', bidOnly: false }] } }, updateMask: 'targeting_setting.target_restrictions' } }])
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings).toEqual(['ad group "Jackets": from now the ads show ONLY to people in 1 audience (TARGETING).'])
    const targeting = live({ adGroupCriteria: [agCrit('51', '7', 'USER_LIST', seg('USER_LIST', '301'))], adGroups: [{ ...AG, audienceMode: [{ dimension: 'AUDIENCE', observationOnly: false }] }, AG2] })
    const r = audienceDraft(C, '21', { remove: [{ kind: 'USER_LIST', id: '301', adGroupId: '51' }] }, targeting)
    if ('refusal' in r) throw new Error(r.refusal)
    expect(r.operations).toEqual([{ adGroupCriterionOperation: { remove: `${C}/adGroupCriteria/51~7` } }])
    expect(r.spendsMoney).toEqual(['ad group "Jackets": no audience narrows who sees the ads any more — they can show to everyone.'])
    expect(r.after).toMatchObject({ undo: { add: [{ kind: 'USER_LIST', id: '301', adGroupId: '51' }] } })
  })

  it('exclusions: added is safe, removed is SPENDS MONEY; custom and combined segments cannot be excluded; switching is remove + create', () => {
    const now = live({ criteria: [crit('6', 'USER_INTEREST', { ...seg('USER_INTEREST', '80000'), negative: true })] }, { audienceMode: [{ dimension: 'AUDIENCE', observationOnly: true }] })
    const d = audienceDraft(C, '21', { remove: [{ kind: 'USER_INTEREST', id: '80000', exclude: true }], add: [{ kind: 'USER_INTEREST', id: '80000' }] }, now)
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([
      { campaignCriterionOperation: { remove: `${C}/campaignCriteria/21~6` } },
      { campaignCriterionOperation: { create: { campaign: `${C}/campaigns/21`, userInterest: { userInterestCategory: `${C}/userInterests/80000` } } } },
    ])
    expect(d.spendsMoney).toEqual(['"Search A": people in 1 excluded audience can see the ads again.'])
    expect(audienceDraft(C, '21', { add: [{ kind: 'COMBINED_AUDIENCE', id: '7', exclude: true }] }, live())).toMatchObject({ refusal: expect.stringContaining('cannot exclude') })
    expect(audienceDraft(C, '21', { add: [{ kind: 'USER_INTEREST', id: '80000' }] }, now)).toMatchObject({ refusal: expect.stringContaining('remove it in the same request') })
  })

  it('bid adjustments of segments there: an update, a raise is SPENDS MONEY, undo keeps the old one; the setting stays on one level', () => {
    const now = live({ criteria: [crit('6', 'USER_LIST', { ...seg('USER_LIST', '301'), bidModifier: 1.1, name: 'Buyers' })] }, { audienceMode: [{ dimension: 'AUDIENCE', observationOnly: true }] })
    const d = audienceDraft(C, '21', { bids: [{ kind: 'USER_LIST', id: '301', bidModifier: 1.5 }] }, now)
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([{ campaignCriterionOperation: { update: { resourceName: `${C}/campaignCriteria/21~6`, bidModifier: 1.5 }, updateMask: 'bid_modifier' } }])
    expect(d.spendsMoney).toEqual(['"Search A": bids more for people in 1 audience.'])
    expect(d.after).toMatchObject({ undo: { bids: [{ kind: 'USER_LIST', id: '301', bidModifier: 1.1 }] } })
    expect(audienceRecordHolds(d.after as AudienceRecord, { ...now, criteria: [crit('6', 'USER_LIST', { ...seg('USER_LIST', '301'), bidModifier: 1.5 })] })).toBe(true)
    expect(audienceRecordHolds(d.after as AudienceRecord, now)).toBe(false)
    // An ad group's own setting while the campaign has one: refused (Google keeps it on one level).
    expect(audienceDraft(C, '21', { modes: [{ adGroupId: '51', mode: 'OBSERVATION' }] }, now)).toMatchObject({ refusal: expect.stringContaining('not both') })
  })

  it('moving the setting from an ad group to the campaign: the ad group\'s is cleared first, in the same request', () => {
    const now = live({ adGroups: [{ ...AG, audienceMode: [{ dimension: 'AUDIENCE', observationOnly: true }] }, AG2] })
    const d = audienceDraft(C, '21', { modes: [{ mode: 'OBSERVATION' }, { adGroupId: '51', mode: 'NONE' }] }, now)
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations.map((o) => Object.keys(o)[0])).toEqual(['adGroupOperation', 'campaignOperation'])
    expect(d.after).toMatchObject({ undo: { modes: [{ mode: 'NONE' }, { adGroupId: '51', mode: 'OBSERVATION' }] } })
  })
})

describe('demographicsDraft', () => {
  const live = (adGroupCriteria: AdGroupTargetingCriterion[] = [], criteria: TargetingCriterion[] = [], camp: Partial<LiveCampaignDetail['campaign']> = {}): AudienceLive =>
    ({ campaign: campaign(camp), criteria, adGroups: [AG, AG2], adGroupCriteria })
  const age = (adGroupId: string, value: string, extra: Partial<AdGroupTargetingCriterion> = {}) => agCrit(adGroupId, `c-${value}`, 'AGE_RANGE', { demographic: { dimension: 'AGE_RANGE', value }, ...extra })

  it('a bid adjustment on one age group keeps every other group shown: a positive criterion for each (the ad group\'s own exclusion left out, the campaign\'s kept)', () => {
    const campaignExcludes = crit('c1', 'AGE_RANGE', { negative: true, demographic: { dimension: 'AGE_RANGE', value: 'AGE_RANGE_18_24' } })
    const d = demographicsDraft(C, '21', { changes: [{ dimension: 'AGE_RANGE', value: 'AGE_RANGE_25_34', adGroupId: '51', bidModifier: 1.3 }] }, live([age('51', 'AGE_RANGE_65_UP', { negative: true })], [campaignExcludes]))
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toHaveLength(6)
    // The group the campaign excludes gets its ad group criterion too (the campaign's exclusion still applies on top).
    expect(d.operations).toContainEqual({ adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/51`, ageRange: { type: 'AGE_RANGE_18_24' } } } })
    expect(d.operations).toContainEqual({ adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/51`, bidModifier: 1.3, ageRange: { type: 'AGE_RANGE_25_34' } } } })
    expect(d.operations).toContainEqual({ adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/51`, ageRange: { type: 'AGE_RANGE_UNDETERMINED' } } } })
    expect(d.operations).not.toContainEqual(expect.objectContaining({ adGroupCriterionOperation: { create: expect.objectContaining({ ageRange: { type: 'AGE_RANGE_65_UP' } }) } }))
    expect(d.spendsMoney).toEqual(['ad group "Jackets": bids more for 25–34 (none → +30 %).'])
    expect(d.warnings).toEqual([])
    // Undo removes exactly the criteria it made.
    expect((d.after as DemographicRecord).restore).toHaveLength(6)
    expect((d.after as DemographicRecord).restore.every((r) => r.criterion === 'NONE')).toBe(true)
  })

  it('a group the campaign excludes is not "already shown" at an ad group: the preview says the campaign still hides it', () => {
    const campaignExcludes = crit('c1', 'GENDER', { negative: true, demographic: { dimension: 'GENDER', value: 'MALE' } })
    expect(demographicsDraft(C, '21', { changes: [{ dimension: 'GENDER', value: 'MALE', adGroupId: '51' }] }, live([], [campaignExcludes])))
      .toMatchObject({ refusal: expect.stringContaining('the campaign excludes it, so it stays hidden there') })
    const adGroupToo = [agCrit('51', 'g2', 'GENDER', { negative: true, demographic: { dimension: 'GENDER', value: 'MALE' } })]
    const d = demographicsDraft(C, '21', { changes: [{ dimension: 'GENDER', value: 'MALE', adGroupId: '51' }] }, live(adGroupToo, [campaignExcludes]))
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([{ adGroupCriterionOperation: { remove: `${C}/adGroupCriteria/51~g2` } }])
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings).toContain('male at ad group "Jackets": the campaign excludes it, so it stays hidden there until the campaign shows it again (this tool without adGroupId).')
  })

  it('exclude at an ad group (a targeted group: remove + create negative); the campaign only excludes; excluding every group is refused', () => {
    const all = ['AGE_RANGE_18_24', 'AGE_RANGE_25_34', 'AGE_RANGE_35_44', 'AGE_RANGE_45_54', 'AGE_RANGE_55_64', 'AGE_RANGE_65_UP', 'AGE_RANGE_UNDETERMINED']
    const complete = all.map((v) => age('51', v, v === 'AGE_RANGE_18_24' ? { bidModifier: 1.2 } : {}))
    const d = demographicsDraft(C, '21', { changes: [{ dimension: 'AGE_RANGE', value: 'AGE_RANGE_18_24', adGroupId: '51', exclude: true }] }, live(complete))
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([
      { adGroupCriterionOperation: { remove: `${C}/adGroupCriteria/51~c-AGE_RANGE_18_24` } },
      { adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/51`, negative: true, ageRange: { type: 'AGE_RANGE_18_24' } } } },
    ])
    expect(d.warnings).toEqual(['ad group "Jackets": 18–24 no longer sees the ads.'])
    expect(d.after).toMatchObject({ restore: [{ dimension: 'AGE_RANGE', value: 'AGE_RANGE_18_24', adGroupId: '51', criterion: 'TARGETED', bidModifier: 1.2 }] })
    expect(demographicsDraft(C, '21', { changes: [{ dimension: 'GENDER', value: 'MALE', bidModifier: 1.2 }] }, live())).toMatchObject({ refusal: expect.stringContaining('per ad group') })
    const c = demographicsDraft(C, '21', { changes: [{ dimension: 'GENDER', value: 'MALE', exclude: true }] }, live())
    if ('refusal' in c) throw new Error(c.refusal)
    expect(c.operations).toEqual([{ campaignCriterionOperation: { create: { campaign: `${C}/campaigns/21`, negative: true, gender: { type: 'MALE' } } } }])
    const twoOut = [agCrit('51', 'g1', 'GENDER', { negative: true, demographic: { dimension: 'GENDER', value: 'FEMALE' } }), agCrit('51', 'g2', 'GENDER', { negative: true, demographic: { dimension: 'GENDER', value: 'MALE' } })]
    expect(demographicsDraft(C, '21', { changes: [{ dimension: 'GENDER', value: 'UNDETERMINED', adGroupId: '51', exclude: true }] }, live(twoOut))).toMatchObject({ refusal: expect.stringContaining('every gender group excluded') })
    expect(demographicsDraft(C, '21', { changes: [{ dimension: 'GENDER', value: 'MALE', adGroupId: '51', exclude: true }] }, live([twoOut[0]]))).toMatchObject({ refusal: expect.stringContaining('only to "gender unknown"') })
  })

  it('a group shown again is SPENDS MONEY; restore puts exact criteria back; holds reads what it set', () => {
    const now = [agCrit('51', 'i1', 'INCOME_RANGE', { negative: true, demographic: { dimension: 'INCOME_RANGE', value: 'INCOME_RANGE_0_50' } })]
    const d = demographicsDraft(C, '21', { changes: [{ dimension: 'INCOME_RANGE', value: 'INCOME_RANGE_0_50', adGroupId: '51' }] }, live(now, [], { status: 'PAUSED' }))
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([{ adGroupCriterionOperation: { remove: `${C}/adGroupCriteria/51~i1` } }])
    expect(d.spendsMoney).toEqual(['ad group "Jackets": income lower 50 % can see the ads again (the campaign is paused: nothing spends until it is enabled).'])
    const record = d.after as DemographicRecord
    expect(record.restore).toEqual([{ dimension: 'INCOME_RANGE', value: 'INCOME_RANGE_0_50', adGroupId: '51', criterion: 'EXCLUDED' }])
    expect(demographicRecordHolds(record, { criteria: [], adGroupCriteria: [] })).toBe(true)
    expect(demographicRecordHolds(record, { criteria: [], adGroupCriteria: now })).toBe(false)
    const back = demographicsDraft(C, '21', { restore: record.restore }, live([]))
    if ('refusal' in back) throw new Error(back.refusal)
    expect(back.operations).toEqual([{ adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/51`, negative: true, incomeRange: { type: 'INCOME_RANGE_0_50' } } } }])
  })
})
