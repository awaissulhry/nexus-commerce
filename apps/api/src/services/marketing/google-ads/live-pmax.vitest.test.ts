/**
 * Google Ads Performance Max (programme 2, G10) — the live reads: one campaign with its asset groups, their assets, product
 * trees and signals, read as Google answers (REST JSON, camelCase; Google leaves default values out), a part Google
 * refuses named in notRead, every filtered field also selected, and customer acquisition.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rows: {} as Record<string, unknown[]>, queries: [] as string[], fail: new Set<string>() }))
vi.mock('./write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('./write-client.js')>()),
  liveRows: vi.fn(async (_t: unknown, query: string, operation: string) => {
    h.queries.push(query)
    if (h.fail.has(operation)) throw new Error('Google Ads refused the query')
    return structuredClone(h.rows[operation] ?? [])
  }),
}))

import {
  LIVE_ACQUISITION_GOAL_QUERY, liveAcquisition, liveAcquisitionConfigQuery, livePmaxCampaign, pmaxAssetGroupsQuery, pmaxCampaignAssetsQuery, pmaxCriteriaQuery,
  pmaxFiltersQuery, pmaxGroupAssetsQuery, pmaxSettingsQuery, pmaxSignalsQuery,
} from './live-pmax.js'

const T = { connectionId: 'g-1', customerId: '1234567890', loginCustomerId: null }
const C = 'customers/1234567890'

beforeEach(() => {
  h.queries = []
  h.fail.clear()
  h.rows = {
    'ads.search.live.pmax-campaign': [{
      campaign: {
        id: '21', name: 'PMax A', status: 'ENABLED', advertisingChannelType: 'PERFORMANCE_MAX', biddingStrategyType: 'MAXIMIZE_CONVERSION_VALUE',
        maximizeConversionValue: { targetRoas: 4 }, shoppingSetting: { merchantId: '555', feedLabel: 'IT' }, brandGuidelinesEnabled: true,
        assetAutomationSettings: [{ assetAutomationType: 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION', assetAutomationStatus: 'OPTED_OUT' }],
        startDateTime: '2026-01-01 00:00:00', containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
        urlCustomParameters: [{ key: 'camp', value: 'z' }], pmaxCampaignSettings: { brandTargetingOverrides: { ignoreExclusionsForShoppingAds: true } },
        excludedParentAssetFieldTypes: ['CALLOUT'],
      },
      campaignBudget: { id: '11', amountMicros: '25000000' },
    }],
    'ads.search.live.pmax-criteria': [
      { campaignCriterion: { criterionId: '91', type: 'BRAND_LIST', negative: true, brandList: { sharedSet: `${C}/sharedSets/61` } } },
      { campaignCriterion: { criterionId: '92', type: 'WEBPAGE', negative: true, webpage: { criterionName: 'x', conditions: [{ operand: 'URL', operator: 'CONTAINS', argument: '/outlet' }] } } },
      { campaignCriterion: { criterionId: '93', type: 'LOCATION', location: { geoTargetConstant: 'geoTargetConstants/2380' } } },
    ],
    'ads.search.live.pmax-campaign-assets': [
      { campaignAsset: { fieldType: 'BUSINESS_NAME', status: 'ENABLED', source: 'ADVERTISER' }, asset: { id: '201', type: 'TEXT', textAsset: { text: 'Shop A' } } },
    ],
    'ads.search.live.pmax-asset-groups': [{ assetGroup: { id: '41', name: 'Group A', status: 'ENABLED', finalUrls: ['https://shop.example/'], trackingUrlTemplate: '{lpurl}?g=1', finalUrlSuffix: 'src=g', urlCustomParameters: [{ key: 'grp', value: 'a' }] } }, { assetGroup: { id: '42', name: 'Group B', status: 'PAUSED' } }],
    'ads.search.live.pmax-asset-group-assets': [
      { assetGroup: { id: '41' }, assetGroupAsset: { fieldType: 'MARKETING_IMAGE', status: 'ENABLED', source: 'ADVERTISER' }, asset: { id: '307', type: 'IMAGE', imageAsset: { mimeType: 'IMAGE_PNG', fullSize: { widthPixels: '1200', heightPixels: '628' } } } },
      { assetGroup: { id: '41' }, assetGroupAsset: { fieldType: 'YOUTUBE_VIDEO', status: 'ENABLED', source: 'ADVERTISER' }, asset: { id: '901', type: 'YOUTUBE_VIDEO', youtubeVideoAsset: { youtubeVideoId: 'abcdefghijk' } } },
    ],
    'ads.search.live.pmax-listing-groups': [
      { assetGroup: { id: '41' }, assetGroupListingGroupFilter: { id: '601', type: 'SUBDIVISION', listingSource: 'SHOPPING' } },
      { assetGroup: { id: '41' }, assetGroupListingGroupFilter: { id: '602', type: 'UNIT_INCLUDED', listingSource: 'SHOPPING', parentListingGroupFilter: `${C}/assetGroupListingGroupFilters/41~601`, caseValue: { productType: { level: 'LEVEL1', value: 'jackets' } } } },
      { assetGroup: { id: '41' }, assetGroupListingGroupFilter: { id: '603', type: 'UNIT_EXCLUDED', listingSource: 'SHOPPING', parentListingGroupFilter: `${C}/assetGroupListingGroupFilters/41~601`, caseValue: { productType: { level: 'LEVEL1' } } } },
    ],
    'ads.search.live.pmax-signals': [
      { assetGroup: { id: '41' }, assetGroupSignal: { resourceName: `${C}/assetGroupSignals/41~701`, audience: { audience: `${C}/audiences/71` } } },
      { assetGroup: { id: '41' }, assetGroupSignal: { resourceName: `${C}/assetGroupSignals/41~702`, searchTheme: { text: 'moto jacket' }, approvalStatus: 'APPROVED' } },
    ],
  }
})

describe('livePmaxCampaign', () => {
  it('reads the campaign, its criteria, brand assets and asset groups with their assets, trees and signals', async () => {
    const c = await livePmaxCampaign(T, '21')
    expect(c).toMatchObject({
      campaignId: '21', type: 'PERFORMANCE_MAX', biddingType: 'MAXIMIZE_CONVERSION_VALUE', targetRoas: 4, budget: { budgetId: '11', amountCents: 2500, shared: false },
      retail: { merchantId: '555', feedLabel: 'IT', localInventory: false }, brandGuidelines: true,
      automation: { FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION: 'OPTED_OUT' },
      campaignAssets: [{ assetId: '201', fieldType: 'BUSINESS_NAME', text: 'Shop A', source: 'ADVERTISER' }],
      customParameters: [{ key: 'camp', value: 'z' }], ignoreBrandExclusionsForShopping: true, excludedParentAssetFieldTypes: ['CALLOUT'], excludedParentAssetSetTypes: [],
      notRead: [],
    })
    expect(c!.criteria).toEqual([
      { criterionId: '91', type: 'BRAND_LIST', negative: true, bidModifier: null, brandListId: '61' },
      { criterionId: '92', type: 'WEBPAGE', negative: true, bidModifier: null, webpage: { name: 'x', conditions: [{ operand: 'URL', operator: 'CONTAINS', argument: '/outlet' }] } },
      { criterionId: '93', type: 'LOCATION', negative: false, bidModifier: null, location: '2380' },
    ])
    const [a, b] = c!.assetGroups
    expect(a.assets.map((x) => [x.assetId, x.fieldType, x.width, x.mimeType, x.youtubeId])).toEqual([['307', 'MARKETING_IMAGE', 1200, 'image/png', null], ['901', 'YOUTUBE_VIDEO', null, null, 'abcdefghijk']])
    expect(a.tree).toEqual([
      { id: '601', parentId: null, type: 'SUBDIVISION', listingSource: 'SHOPPING', caseValue: null, dimension: null, value: null },
      { id: '602', parentId: '601', type: 'UNIT_INCLUDED', listingSource: 'SHOPPING', caseValue: { productType: { level: 'LEVEL1', value: 'jackets' } }, dimension: 'productType:LEVEL1', value: 'jackets' },
      { id: '603', parentId: '601', type: 'UNIT_EXCLUDED', listingSource: 'SHOPPING', caseValue: { productType: { level: 'LEVEL1' } }, dimension: 'productType:LEVEL1', value: null },
    ])
    expect(a.signals).toEqual([
      { signalId: '41~701', audienceId: '71', searchTheme: null, approval: null },
      { signalId: '41~702', audienceId: null, searchTheme: 'moto jacket', approval: 'APPROVED' },
    ])
    expect(a).toMatchObject({ trackingTemplate: '{lpurl}?g=1', finalUrlSuffix: 'src=g', customParameters: [{ key: 'grp', value: 'a' }] })
    expect(b).toMatchObject({ assetGroupId: '42', status: 'PAUSED', assets: [], tree: [], signals: [], finalUrls: [], trackingTemplate: null, customParameters: [] })
    expect(h.queries).toHaveLength(7)
  })

  it('a part Google refuses is named, not hidden; a campaign of another type reads its settings only; a removed one is null', async () => {
    h.fail.add('ads.search.live.pmax-signals')
    expect((await livePmaxCampaign(T, '21'))!.notRead).toEqual([{ part: 'signals', why: 'Google Ads refused the query' }])
    h.queries = []
    h.rows['ads.search.live.pmax-campaign'] = [{ campaign: { id: '21', name: 'S', status: 'ENABLED', advertisingChannelType: 'SEARCH' } }]
    expect(await livePmaxCampaign(T, '21')).toMatchObject({ type: 'SEARCH', assetGroups: [] })
    expect(h.queries).toHaveLength(1)
    h.rows['ads.search.live.pmax-campaign'] = []
    expect(await livePmaxCampaign(T, '21')).toBeNull()
  })

  it('every field a query filters on is also selected (Google refuses otherwise), and ids are digits only', () => {
    for (const q of [pmaxSettingsQuery('21'), pmaxCriteriaQuery('21'), pmaxCampaignAssetsQuery('21'), pmaxAssetGroupsQuery('21'), pmaxGroupAssetsQuery('21'), pmaxFiltersQuery('21'), pmaxSignalsQuery('21'), LIVE_ACQUISITION_GOAL_QUERY, liveAcquisitionConfigQuery('21')]) {
      const [select, where] = q.split(' WHERE ')
      const fields = new Set(select.replace(/^SELECT /, '').split(' FROM ')[0].split(', '))
      for (const f of where.match(/[a-z_]+\.[a-z_.]+(?= (=|!=|IN))/g) ?? []) expect(fields.has(f), `${f} in ${q.slice(0, 60)}`).toBe(true)
    }
    expect(() => pmaxSettingsQuery("21' OR 1=1")).toThrow(/not a Google id/)
  })
})

describe('liveAcquisition', () => {
  it('the account goal and one campaign\'s config, values in cents; no target option is Google\'s default TARGET_ALL', async () => {
    h.rows['ads.search.live.acquisition-goal'] = [{ goal: { resourceName: `${C}/goals/81`, goalId: '81', goalType: 'NEW_CUSTOMER_ACQUISITION', newCustomerAcquisitionGoalSettings: { valueSettings: { additionalValue: 5.5 } } } }]
    h.rows['ads.search.live.acquisition-config'] = [{ campaignGoalConfig: { resourceName: `${C}/campaignGoalConfigs/21~81`, goal: `${C}/goals/81`, campaignNewCustomerAcquisitionSettings: {} } }]
    expect(await liveAcquisition(T, '21')).toEqual({
      goal: { goalId: '81', resourceName: `${C}/goals/81`, eligibility: null, valueCents: 550, highValueCents: null },
      config: { resourceName: `${C}/campaignGoalConfigs/21~81`, goalId: '81', mode: 'TARGET_ALL', valueCents: null, highValueCents: null },
    })
  })
})
