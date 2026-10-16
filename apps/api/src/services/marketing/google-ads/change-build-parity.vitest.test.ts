/**
 * Google Ads programme 2 G13 (2026-10-16) — build/copy parity, pure: a build takes everything the newer change tools set
 * (devices, radius, audiences of every kind and the audience setting, demographics, labels on every level, URLs and
 * tracking at every level, ad rotation and ad group targets, the inventory filter, exclusions, brand and placement
 * lists, conversion goals, assets of every type at the campaign and its ad groups), still ONE request whose temporary
 * ids are unique and made before use, every campaign PAUSED, nothing in spendsMoney; and Google's rules are checked
 * before Google is asked. Made-up ids and names only.
 */
import { describe, expect, it } from 'vitest'
import { buildDraft, type BuildSpec } from './change-build.js'
import { copyBidding } from './build-copy.js'
import type { LiveBudget, LiveCampaign } from './live.js'

const C = 'customers/1234567890'
const live = { campaigns: [] as LiveCampaign[], budgets: [] as LiveBudget[], lists: [] }
const AD = {
  headlines: [{ text: 'Waterproof jacket' }, { text: 'Armour level 2' }, { text: 'Free returns' }],
  descriptions: [{ text: 'A jacket for every season.' }, { text: 'Sizes S to 5XL.' }],
  finalUrl: 'https://shop.example/p/jacket',
}
const params = [{ key: 'src', value: 'g' }]

const SPEC: BuildSpec = {
  campaigns: [
    {
      type: 'SEARCH', name: 'Search Y', budget: { dailyBudgetCents: 700 }, bidding: { strategy: 'MANUAL_CPC' },
      locations: [{ id: '2380', bidModifier: 1.2 }], locationOption: 'SEARCH_INTEREST', negativeLocationOption: 'PRESENCE_OR_INTEREST',
      trackingTemplate: '{lpurl}?t=1', finalUrlSuffix: 'a=b', customParameters: params,
      devices: [{ device: 'MOBILE', bidModifier: 1.3 }, { device: 'TABLET', bidModifier: 0 }],
      radius: [{ latitude: 45.5, longitude: 9.2, radius: 20, units: 'KILOMETERS', bidModifier: 1.1 }],
      audienceSegments: [{ kind: 'USER_LIST', id: '41', bidModifier: 1.5 }, { kind: 'USER_INTEREST', id: '42', exclude: true }],
      demographics: [{ dimension: 'AGE_RANGE', value: 'AGE_RANGE_18_24', exclude: true }],
      labels: ['61'],
      exclusions: [{ kind: 'placement', value: 'example.com' }, { kind: 'content-label', value: 'tragedy' }],
      brandLists: [{ listId: '71', mode: 'exclude' }],
      placementLists: ['72'],
      conversionGoals: [{ category: 'PURCHASE', origin: 'WEBSITE', biddable: true }, { category: 'PAGE_VIEW', origin: 'WEBSITE', biddable: false }],
      assets: { link: [{ assetId: '81', fieldType: 'CALL', status: 'PAUSED' }, { assetId: '82', fieldType: 'PROMOTION' }] },
      adGroups: [{
        name: 'Jackets', defaultBidCents: 30, targetCpaCents: 900, adRotation: 'ROTATE_FOREVER', finalUrlSuffix: 'g=1',
        devices: [{ device: 'DESKTOP', bidModifier: 1.2 }],
        audiences: [{ kind: 'CUSTOM_AUDIENCE', id: '43', bidModifier: 1.2 }],
        demographics: [{ dimension: 'GENDER', value: 'MALE', bidModifier: 1.1 }, { dimension: 'GENDER', value: 'FEMALE' }],
        brandLists: ['74'], labels: ['62'],
        keywords: [{ text: 'rain jacket', matchType: 'EXACT', bidCents: 40, finalUrl: 'https://shop.example/p/rain', customParameters: params, labels: ['63'] }],
        ads: [{ ...AD, finalMobileUrl: 'https://m.shop.example/p/jacket', trackingTemplate: '{lpurl}', labels: ['64'] }],
        assets: { callouts: ['Free returns'], link: [{ assetId: '83', fieldType: 'SITELINK' }] },
      }],
    },
    {
      type: 'SHOPPING', name: 'Shop Y', budget: { dailyBudgetCents: 500 }, bidding: { strategy: 'MANUAL_CPC' },
      shopping: { merchantId: '5', ignoreBrandExclusions: true }, inventoryFilter: [{ dimension: 'BRAND', value: 'Brand A' }],
      adGroups: [{ name: 'All', productGroups: { itemIds: ['sku-1'], bidCents: 20 }, productAdStatus: 'PAUSED', productAdLabels: ['65'] }],
    },
  ],
}

type Op = Record<string, any>
const kindsOf = (ops: Op[]) => ops.map((o) => Object.keys(o)[0])
const creates = (ops: Op[], kind: string) => ops.filter((o) => o[kind]?.create).map((o) => o[kind].create)

describe('build parity (G13)', () => {
  it('every part of the newer tools in ONE request: temp ids unique and made before use, grouped by kind, PAUSED, nothing spends', () => {
    const d = buildDraft(C, 'EUR', SPEC, live)
    if ('refusal' in d) throw new Error(d.refusal)
    const ops = d.operations as Op[]
    // Each temporary number belongs to one resource and is made before anything points at it.
    const owner = new Map<number, string>()
    const made = new Set<string>()
    for (const o of ops) {
      const c = Object.values(o)[0].create
      if (!c) continue
      for (const ref of JSON.stringify(c).match(/customers\/1234567890\/[A-Za-z]+\/[-~\d]*-\d+[-~\d]*/g) ?? []) {
        if (ref !== c.resourceName) expect(made.has(ref), `${ref} used before it is made`).toBe(true)
      }
      if (c.resourceName) {
        const last = Number(c.resourceName.split(/[/~]/).pop())
        if (last < 0) { expect(owner.has(last), `temp id ${last} used twice`).toBe(false); owner.set(last, c.resourceName) }
        made.add(c.resourceName)
      }
    }
    const kinds = kindsOf(ops)
    expect(kinds.filter((k, i) => k !== kinds[i - 1])).toEqual([...new Set(kinds)])
    // The new campaign's goals last, as Google's sample sends them; never a custom goal on a temporary id.
    expect(kinds.slice(-1)).toEqual(['campaignConversionGoalOperation'])
    expect(kinds).not.toContain('conversionGoalCampaignConfigOperation')
    expect(creates(ops, 'campaignOperation').map((c) => c.status)).toEqual(['PAUSED', 'PAUSED'])
    expect(d.spendsMoney).toEqual([])

    const [search, shop] = creates(ops, 'campaignOperation')
    expect(search).toMatchObject({
      geoTargetTypeSetting: { positiveGeoTargetType: 'SEARCH_INTEREST', negativeGeoTargetType: 'PRESENCE_OR_INTEREST' },
      trackingUrlTemplate: '{lpurl}?t=1', finalUrlSuffix: 'a=b', urlCustomParameters: params,
      // Positive segments without a setting: OBSERVATION (they never narrow who sees the ads).
      targetingSetting: { targetRestrictions: [{ targetingDimension: 'AUDIENCE', bidOnly: true }] },
    })
    expect(shop.shoppingSetting).toMatchObject({ merchantId: '5', ignoreBrandExclusionInShoppingAds: true })

    const criteria = creates(ops, 'campaignCriterionOperation')
    const ofSearch = criteria.filter((c) => c.campaign === search.resourceName)
    expect(ofSearch).toContainEqual({ campaign: search.resourceName, device: { type: 'MOBILE' }, bidModifier: 1.3 })
    expect(ofSearch).toContainEqual({ campaign: search.resourceName, device: { type: 'TABLET' }, bidModifier: 0 })
    expect(ofSearch).toContainEqual({ campaign: search.resourceName, proximity: { geoPoint: { latitudeInMicroDegrees: 45_500_000, longitudeInMicroDegrees: 9_200_000 }, radius: 20, radiusUnits: 'KILOMETERS' }, bidModifier: 1.1 })
    expect(ofSearch).toContainEqual({ campaign: search.resourceName, bidModifier: 1.5, userList: { userList: `${C}/userLists/41` } })
    expect(ofSearch).toContainEqual({ campaign: search.resourceName, negative: true, userInterest: { userInterestCategory: `${C}/userInterests/42` } })
    expect(ofSearch).toContainEqual({ campaign: search.resourceName, negative: true, ageRange: { type: 'AGE_RANGE_18_24' } })
    expect(ofSearch).toContainEqual({ campaign: search.resourceName, negative: true, placement: { url: 'example.com' } })
    expect(ofSearch).toContainEqual({ campaign: search.resourceName, negative: true, contentLabel: { type: 'TRAGEDY' } })
    expect(ofSearch).toContainEqual({ campaign: search.resourceName, negative: true, brandList: { sharedSet: `${C}/sharedSets/71` } })
    expect(ofSearch).toContainEqual({ campaign: search.resourceName, location: { geoTargetConstant: 'geoTargetConstants/2380' }, bidModifier: 1.2 })
    expect(criteria).toContainEqual({ campaign: shop.resourceName, listingScope: { dimensions: [{ productBrand: { value: 'Brand A' } }] } })
    expect(creates(ops, 'campaignSharedSetOperation')).toContainEqual({ campaign: search.resourceName, sharedSet: `${C}/sharedSets/72` })
    expect(creates(ops, 'campaignLabelOperation')).toEqual([{ campaign: search.resourceName, label: `${C}/labels/61` }])

    const campaignTemp = search.resourceName.split('/').pop()
    const goals = ops.filter((o) => o.campaignConversionGoalOperation).map((o) => o.campaignConversionGoalOperation)
    expect(goals).toEqual([
      { update: { resourceName: `${C}/campaignConversionGoals/${campaignTemp}~PURCHASE~WEBSITE`, biddable: true }, updateMask: 'biddable' },
      { update: { resourceName: `${C}/campaignConversionGoals/${campaignTemp}~PAGE_VIEW~WEBSITE`, biddable: false }, updateMask: 'biddable' },
    ])

    const [jackets, all] = creates(ops, 'adGroupOperation')
    expect(jackets).toMatchObject({ cpcBidMicros: '300000', targetCpaMicros: '9000000', adRotationMode: 'ROTATE_FOREVER', finalUrlSuffix: 'g=1' })
    expect(jackets.targetingSetting).toBeUndefined()
    expect(creates(ops, 'adGroupBidModifierOperation')).toEqual([{ adGroup: jackets.resourceName, device: { type: 'DESKTOP' }, bidModifier: 1.2 }])
    const groupCriteria = creates(ops, 'adGroupCriterionOperation').filter((c) => c.adGroup === jackets.resourceName)
    expect(groupCriteria).toContainEqual({ adGroup: jackets.resourceName, bidModifier: 1.2, customAudience: { customAudience: `${C}/customAudiences/43` } })
    expect(groupCriteria).toContainEqual({ adGroup: jackets.resourceName, bidModifier: 1.1, gender: { type: 'MALE' } })
    expect(groupCriteria).toContainEqual({ adGroup: jackets.resourceName, gender: { type: 'FEMALE' } })
    expect(groupCriteria).toContainEqual({ adGroup: jackets.resourceName, brandList: { sharedSet: `${C}/sharedSets/74` } })
    const keyword = groupCriteria.find((c) => c.keyword)
    expect(keyword).toMatchObject({ resourceName: expect.stringMatching(/adGroupCriteria\/-\d+~-\d+$/), finalUrls: ['https://shop.example/p/rain'], urlCustomParameters: params })
    const ad = creates(ops, 'adGroupAdOperation').find((a) => a.ad.responsiveSearchAd)
    expect(ad).toMatchObject({ resourceName: expect.stringMatching(/adGroupAds\/-\d+~-\d+$/), ad: { finalMobileUrls: ['https://m.shop.example/p/jacket'], trackingUrlTemplate: '{lpurl}' } })
    expect(creates(ops, 'adGroupLabelOperation')).toEqual([{ adGroup: jackets.resourceName, label: `${C}/labels/62` }])
    expect(creates(ops, 'adGroupCriterionLabelOperation')).toEqual([{ adGroupCriterion: keyword.resourceName, label: `${C}/labels/63` }])
    const productAd = creates(ops, 'adGroupAdOperation').find((a) => a.ad.shoppingProductAd)
    expect(productAd).toMatchObject({ adGroup: all.resourceName, status: 'PAUSED', resourceName: expect.stringMatching(/adGroupAds\/-\d+~-\d+$/) })
    expect(creates(ops, 'adGroupAdLabelOperation')).toEqual([{ adGroupAd: ad.resourceName, label: `${C}/labels/64` }, { adGroupAd: productAd.resourceName, label: `${C}/labels/65` }])

    expect(creates(ops, 'campaignAssetOperation')).toEqual([
      { campaign: search.resourceName, asset: `${C}/assets/81`, fieldType: 'CALL', status: 'PAUSED' },
      { campaign: search.resourceName, asset: `${C}/assets/82`, fieldType: 'PROMOTION' },
    ])
    const callout = creates(ops, 'assetOperation').find((a) => a.calloutAsset)
    expect(creates(ops, 'adGroupAssetOperation')).toEqual([
      { adGroup: jackets.resourceName, asset: callout.resourceName, fieldType: 'CALLOUT' },
      { adGroup: jackets.resourceName, asset: `${C}/assets/83`, fieldType: 'SITELINK' },
    ])
    expect(d.warnings).toContain('Call or lead form assets are linked in the new campaigns: once a campaign is enabled, people can call or open the form from its ads, each charged like a click.')
    expect(d.changes['campaign 1 conversion goals']).toEqual({ from: 'the account\'s', to: 'PURCHASE/WEBSITE biddable, PAGE_VIEW/WEBSITE not biddable' })
    // The table holds 20 lines (the rest counted); the inventory filter is said in the warnings too.
    expect(d.totals.linesNotShown).toBeGreaterThan(0)
    expect(d.warnings).toContain('campaign 2 "Shop Y": only products with brand = "Brand A" can be advertised (its product groups set the bids among them).')
  })

  it('the ad group\'s own audience setting is refused when the campaign has one; a copy\'s Google setting is written as it is', () => {
    const base = SPEC.campaigns[0]
    const both = buildDraft(C, 'EUR', { campaigns: [{ ...base, name: 'Both', audienceMode: 'TARGETING', adGroups: [{ name: 'G', audienceMode: 'OBSERVATION' }] }] }, live)
    expect('refusal' in both && both.refusal).toMatch(/audience setting on the campaign OR on its ad groups/)
    const copied = buildDraft(C, 'EUR', { campaigns: [{ ...base, name: 'Copy', audienceSegments: [{ kind: 'USER_LIST', id: '41' }], targetRestrictions: [], adGroups: [{ name: 'G', targetRestrictions: [{ dimension: 'AUDIENCE', observationOnly: false }] }] }] }, live)
    if ('refusal' in copied) throw new Error(copied.refusal)
    const ops = copied.operations as Op[]
    expect(creates(ops, 'campaignOperation')[0].targetingSetting).toBeUndefined()
    expect(creates(ops, 'adGroupOperation')[0].targetingSetting).toEqual({ targetRestrictions: [{ targetingDimension: 'AUDIENCE', bidOnly: false }] })
  })

  it('Google\'s rules are checked before Google is asked — every problem at once, nothing sent', () => {
    const d = buildDraft(C, 'EUR', {
      campaigns: [{
        type: 'SEARCH', name: 'Bad', budget: { dailyBudgetCents: 100 }, bidding: { strategy: 'MANUAL_CPC' },
        devices: [{ device: 'DESKTOP', bidModifier: 0 }, { device: 'MOBILE', bidModifier: 0 }, { device: 'TABLET', bidModifier: 0 }],
        audienceSegments: [{ kind: 'COMBINED_AUDIENCE', id: '44', exclude: true }],
        demographics: [{ dimension: 'GENDER', value: 'FEMALE', exclude: true }, { dimension: 'GENDER', value: 'MALE', exclude: true }, { dimension: 'GENDER', value: 'UNDETERMINED', exclude: true }],
        inventoryFilter: [{ dimension: 'BRAND', value: 'A' }],
        conversionGoals: [{ category: 'NOT_A_CATEGORY', origin: 'WEBSITE', biddable: true }],
        finalUrlSuffix: '?a=b',
        assets: { link: [{ assetId: '84', fieldType: 'LEAD_FORM' }] },
        adGroups: [{ name: 'G', devices: [{ device: 'TABLET', bidModifier: 1.2 }], assets: { link: [{ assetId: '85', fieldType: 'LEAD_FORM' }] } }],
      }],
    }, live)
    expect('refusal' in d).toBe(true)
    const why = (d as { refusal: string }).refusal
    expect(why).toMatch(/opted out of computers, mobile phones and tablets/)
    expect(why).toMatch(/cannot exclude a custom or combined segment/)
    expect(why).toMatch(/every GENDER group is excluded/)
    expect(why).toMatch(/an inventory filter is for a Shopping campaign/)
    expect(why).toMatch(/conversion goal NOT_A_CATEGORY\/WEBSITE is not a goal Google names/)
    expect(why).toMatch(/final URL suffix cannot begin with "\?" or "&"/)
    expect(why).toMatch(/opts out of tablets: Google does not use an ad group's adjustment/)
    expect(why).toMatch(/Google links a lead form at campaign level, not to an ad group/)
  })

  it('labels go on an ad group\'s audience and demographic criteria and on product group nodes (AdGroupCriterionLabel on their temporary ids)', () => {
    const d = buildDraft(C, 'EUR', { campaigns: [
      { type: 'SEARCH', name: 'L1', budget: { dailyBudgetCents: 100 }, bidding: { strategy: 'MANUAL_CPC' },
        adGroups: [{ name: 'G', audiences: [{ kind: 'USER_LIST', id: '41', labels: ['61'] }], demographics: [{ dimension: 'GENDER', value: 'MALE', exclude: true, labels: ['62'] }] }] },
      { type: 'SHOPPING', name: 'L2', budget: { dailyBudgetCents: 100 }, bidding: { strategy: 'MANUAL_CPC' }, shopping: { merchantId: '5' },
        adGroups: [{ name: 'S', productGroups: { nodes: [
          { parent: null, kind: 'SUBDIVISION', caseValue: null, excluded: false, bidCents: null, rest: false },
          { parent: 0, kind: 'UNIT', caseValue: { productItemId: {} }, excluded: true, bidCents: null, rest: true },
          { parent: 0, kind: 'UNIT', caseValue: { productItemId: { value: 'sku-1' } }, excluded: false, bidCents: 20, rest: false, labels: ['63'] },
        ] } }] },
    ] }, live)
    if ('refusal' in d) throw new Error(d.refusal)
    const ops = d.operations as Op[]
    const criteria = creates(ops, 'adGroupCriterionOperation')
    const links = creates(ops, 'adGroupCriterionLabelOperation')
    const res = (pick: (c: Op) => boolean) => criteria.find(pick)!.resourceName
    expect(links).toEqual([
      { adGroupCriterion: res((c) => !!c.userList), label: `${C}/labels/61` },
      { adGroupCriterion: res((c) => !!c.gender), label: `${C}/labels/62` },
      { adGroupCriterion: res((c) => c.listingGroup?.caseValue?.productItemId?.value === 'sku-1'), label: `${C}/labels/63` },
    ])
    expect(links.every((l) => /adGroupCriteria\/-\d+~-\d+$/.test(l.adGroupCriterion))).toBe(true)
  })

  it('bidding: Target impression share and enhanced CPC (Standard Shopping only) are made; a link of a field type Nexus does not link is refused', () => {
    const d = buildDraft(C, 'EUR', { campaigns: [
      { type: 'SEARCH', name: 'T1', budget: { dailyBudgetCents: 100 }, bidding: { strategy: 'TARGET_IMPRESSION_SHARE', location: 'TOP_OF_PAGE', impressionSharePercent: 65, maxCpcCents: 150 } },
      { type: 'SHOPPING', name: 'T2', budget: { dailyBudgetCents: 100 }, bidding: { strategy: 'MANUAL_CPC', enhancedCpc: true }, shopping: { merchantId: '5' } },
    ] }, live)
    if ('refusal' in d) throw new Error(d.refusal)
    const [tis, ecpc] = creates(d.operations as Op[], 'campaignOperation')
    expect(tis.targetImpressionShare).toEqual({ location: 'TOP_OF_PAGE', locationFractionMicros: '650000', cpcBidCeilingMicros: '1500000' })
    expect(ecpc.manualCpc).toEqual({ enhancedCpcEnabled: true })
    const search = buildDraft(C, 'EUR', { campaigns: [{ type: 'SEARCH', name: 'T3', budget: { dailyBudgetCents: 100 }, bidding: { strategy: 'MANUAL_CPC', enhancedCpc: true } }] }, live)
    expect('refusal' in search && search.refusal).toMatch(/Enhanced CPC goes with Manual CPC in a Standard Shopping campaign only/)
    const noCeiling = buildDraft(C, 'EUR', { campaigns: [{ type: 'SEARCH', name: 'T4', budget: { dailyBudgetCents: 100 }, bidding: { strategy: 'TARGET_IMPRESSION_SHARE', location: 'TOP_OF_PAGE', impressionSharePercent: 65 } }] }, live)
    expect('refusal' in noCeiling && noCeiling.refusal).toMatch(/needs bidding.maxCpcCents/)
    const odd = buildDraft(C, 'EUR', { campaigns: [{ type: 'SEARCH', name: 'T5', budget: { dailyBudgetCents: 100 }, bidding: { strategy: 'MANUAL_CPC' }, assets: { link: [{ assetId: '84', fieldType: 'HOTEL_CALLOUT' }] } }] }, live)
    expect('refusal' in odd && odd.refusal).toMatch(/HOTEL_CALLOUT is not a field type Nexus links/)
  })
})

describe('copy bidding (G13 review)', () => {
  const base = {
    campaignId: '21', name: 'Shop A', type: 'SEARCH', bidding: 'MANUAL_CPC', biddingStrategyId: null, manualCpcEnhanced: false, maxCpcCeilingCents: null,
    targetCpaCents: null, targetRoas: null, targetImpressionShare: null, standardTargetCpaCents: null, standardTargetRoas: null,
  } as unknown as Parameters<typeof copyBidding>[0]
  const of = (over: Record<string, unknown>) => copyBidding({ ...base, ...over } as Parameters<typeof copyBidding>[0])

  it('Target impression share as it is; standard Target CPA / ROAS as Maximize conversions / value with the target, said; anything else refused', () => {
    expect(of({ bidding: 'TARGET_IMPRESSION_SHARE', targetImpressionShare: { location: 'ABSOLUTE_TOP_OF_PAGE', fractionMicros: 655_000, ceilingCents: 120 } }))
      .toEqual({ bidding: { strategy: 'TARGET_IMPRESSION_SHARE', location: 'ABSOLUTE_TOP_OF_PAGE', impressionSharePercent: 65.5, maxCpcCents: 120 } })
    const cpa = of({ bidding: 'TARGET_CPA', standardTargetCpaCents: 900 })!
    expect(cpa.bidding).toEqual({ strategy: 'MAXIMIZE_CONVERSIONS', targetCpaCents: 900 })
    expect(cpa.note).toMatch(/standard Target CPA, which v25 takes as a portfolio strategy only: the copy bids Maximize conversions with the same target CPA/)
    expect(of({ bidding: 'TARGET_ROAS', standardTargetRoas: 4 })!.bidding).toEqual({ strategy: 'MAXIMIZE_CONVERSION_VALUE', targetRoas: 4 })
    expect(of({ bidding: 'MANUAL_CPM' })).toBeNull()
  })

  it('enhanced CPC: kept on Standard Shopping; on Search it is named (Google ignores it there)', () => {
    expect(of({ type: 'SHOPPING', manualCpcEnhanced: true })).toEqual({ bidding: { strategy: 'MANUAL_CPC', enhancedCpc: true } })
    expect(of({ manualCpcEnhanced: true })).toEqual({ bidding: { strategy: 'MANUAL_CPC' }, notCopied: expect.stringMatching(/Google deprecated it for Search: enhanced_cpc_enabled has no effect/) })
  })
})
