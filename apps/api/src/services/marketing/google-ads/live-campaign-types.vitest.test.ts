/**
 * Google Ads changes (2026-10-15, programme 2 group G11) — the live reads of Demand Gen, Display, App and Video campaigns:
 * every field a WHERE names is selected too (Google refuses a filter on another resource's field it does not select), ids
 * are checked before anything is sent, and Google's JSON maps to what the builders take (defaults Google leaves out filled).
 */
import { describe, expect, it } from 'vitest'
import {
  liveAudiencesQuery, liveMediaAssetOf, liveMediaAssetsQuery, liveTypedAdGroupOf, liveTypedAdGroupsQuery, liveTypedAdOf, liveTypedAdsQuery,
  liveTypedCampaignOf, liveTypedCampaignQuery, liveTypedCriteriaQuery, liveTypedCriterionOf, liveYoutubeAssetsQuery, targetOf,
} from './live-campaign-types.js'

/** The fields a query's WHERE names that are not in its SELECT. */
function whereNotSelected(query: string): string[] {
  const select = query.slice(7, query.indexOf(' FROM ')).split(',').map((f) => f.trim())
  const where = query.slice(query.indexOf(' WHERE ') + 7)
  const fields = [...where.matchAll(/([a-z_]+(?:\.[a-z_0-9]+)+)\s*(?:=|!=|IN)/g)].map((m) => m[1])
  return fields.filter((f) => !select.includes(f))
}

describe('the queries', () => {
  it('select every field their WHERE names, and only take Google ids', () => {
    for (const q of [
      liveTypedCampaignQuery('21'), liveTypedAdGroupsQuery('21'), liveTypedCriteriaQuery('21'), liveTypedAdsQuery([['51', '701']]),
      liveMediaAssetsQuery(['301']), liveYoutubeAssetsQuery(['abcdefghijk']), liveAudiencesQuery(['601']),
    ]) expect(whereNotSelected(q), q).toEqual([])
    expect(() => liveTypedCampaignQuery('21 OR 1=1')).toThrow(/not a Google id/)
    expect(() => liveYoutubeAssetsQuery(["abc' OR '1"])).toThrow(/not a YouTube video id/)
    expect(liveTypedCriteriaQuery('21')).toContain("ad_group_criterion.type IN ('PLACEMENT', 'TOPIC', 'KEYWORD'")
    expect(liveTypedAdGroupsQuery('21')).toContain('ad_group.demand_gen_ad_group_settings.channel_controls.selected_channels.youtube_shorts')
  })
})

describe('the mappers', () => {
  it('a campaign: its bidding targets, app setting, feed, conversion actions and budget (a budget with no period is DAILY)', () => {
    const c = liveTypedCampaignOf({
      campaign: {
        id: '21', name: 'App A', status: 'PAUSED', advertisingChannelType: 'MULTI_CHANNEL', advertisingChannelSubType: 'APP_CAMPAIGN', biddingStrategyType: 'TARGET_CPA',
        targetCpa: { targetCpaMicros: '2000000' }, appCampaignSetting: { appId: 'com.example.app', appStore: 'GOOGLE_APP_STORE', biddingStrategyGoalType: 'OPTIMIZE_INSTALLS_TARGET_INSTALL_COST' },
        selectiveOptimization: { conversionActions: ['customers/1234567890/conversionActions/71'] },
      },
      campaignBudget: { id: '14', amountMicros: '30000000', explicitlyShared: false },
    })
    expect(c).toMatchObject({
      campaignId: '21', type: 'MULTI_CHANNEL', subType: 'APP_CAMPAIGN', bidding: 'TARGET_CPA', targetCpaCents: 200, portfolioId: null,
      app: { appId: 'com.example.app', appStore: 'GOOGLE_APP_STORE', goal: 'OPTIMIZE_INSTALLS_TARGET_INSTALL_COST' }, conversionActionIds: ['71'],
      budget: { budgetId: '14', amountCents: 3000, totalCents: null, period: 'DAILY', shared: false },
    })
    const dg = liveTypedCampaignOf({ campaign: { id: '22', advertisingChannelType: 'DEMAND_GEN', biddingStrategyType: 'MAXIMIZE_CONVERSIONS', maximizeConversions: { targetCpaMicros: '5000000' }, demandGenCampaignSettings: { upgradedTargeting: true }, shoppingSetting: { merchantId: '5550001' } }, campaignBudget: { id: '15', totalAmountMicros: '500000000', period: 'CUSTOM_PERIOD' } })
    expect(dg).toMatchObject({ targetCpaCents: 500, upgradedTargeting: true, merchantId: '5550001', budget: { totalCents: 50000, period: 'CUSTOM_PERIOD' } })
  })

  it('an ad group: Demand Gen channels (none sent = all channels), its strategy or its picked channels; other kinds have none', () => {
    const base = { id: '51', name: 'G', status: 'ENABLED', cpcBidMicros: '400000', optimizedTargetingEnabled: true, audienceSetting: { useAudienceGrouped: true } }
    expect(liveTypedAdGroupOf({ adGroup: base }, 'DEMAND_GEN')).toMatchObject({ channels: { strategy: 'ALL_CHANNELS' }, cpcBidCents: 40, optimizedTargeting: true, audienceGrouped: true })
    expect(liveTypedAdGroupOf({ adGroup: { ...base, demandGenAdGroupSettings: { channelControls: { channelStrategy: 'ALL_OWNED_AND_OPERATED_CHANNELS' } } } }, 'DEMAND_GEN').channels).toEqual({ strategy: 'ALL_OWNED_AND_OPERATED_CHANNELS' })
    expect(liveTypedAdGroupOf({ adGroup: { ...base, demandGenAdGroupSettings: { channelControls: { channelConfig: 'SELECTED_CHANNELS', selectedChannels: { youtubeShorts: true, gmail: true, display: false } } } } }, 'DEMAND_GEN').channels).toEqual({ selected: ['YOUTUBE_SHORTS', 'GMAIL'] })
    expect(liveTypedAdGroupOf({ adGroup: base }, 'DISPLAY').channels).toBeNull()
  })

  it('criteria: each kind to its value (resource names to ids); an ad with its info, review and AdGroupAd key; media assets', () => {
    expect(targetOf({ topic: { topicConstant: 'topicConstants/66' } })).toEqual({ kind: 'topic', value: '66' })
    expect(targetOf({ userList: { userList: 'customers/1234567890/userLists/501' } })).toEqual({ kind: 'user-list', value: '501' })
    expect(targetOf({ audience: { audience: 'customers/1234567890/audiences/601' } })).toEqual({ kind: 'audience', value: '601' })
    expect(targetOf({ mobileAppCategory: { mobileAppCategoryConstant: 'mobileAppCategoryConstants/60009' } })).toEqual({ kind: 'app-category', value: '60009' })
    expect(targetOf({ deviceType: {} })).toBeNull()
    expect(liveTypedCriterionOf({ adGroup: { id: '51' }, adGroupCriterion: { criterionId: '9', negative: true, status: 'ENABLED', placement: { url: 'example.com' } } }))
      .toEqual({ adGroupId: '51', criterionId: '9', kind: 'placement', value: 'example.com', exclude: true, status: 'ENABLED', name: null })
    const ad = liveTypedAdOf({
      adGroup: { id: '51', status: 'ENABLED' }, campaign: { id: '21', status: 'PAUSED', advertisingChannelType: 'DISPLAY' },
      adGroupAd: { status: 'ENABLED', policySummary: { approvalStatus: 'APPROVED_LIMITED' }, ad: { id: '701', type: 'RESPONSIVE_DISPLAY_AD', finalUrls: ['https://shop.example/a'], responsiveDisplayAd: { businessName: 'Shop A' } } },
    })
    expect(ad).toEqual({
      id: '51~701', adGroupId: '51', adId: '701', type: 'RESPONSIVE_DISPLAY_AD', status: 'ENABLED', adGroupStatus: 'ENABLED', campaignId: '21', campaignStatus: 'PAUSED',
      campaignType: 'DISPLAY', finalUrls: ['https://shop.example/a'], approval: 'APPROVED_LIMITED', info: { businessName: 'Shop A' },
    })
    expect(liveTypedAdOf({ adGroupAd: { ad: { id: '1', type: 'RESPONSIVE_SEARCH_AD' } } }).info).toBeNull()
    expect(liveMediaAssetOf({ asset: { id: '401', type: 'YOUTUBE_VIDEO', youtubeVideoAsset: { youtubeVideoId: 'abcdefghijk' } } })).toMatchObject({ assetId: '401', type: 'YOUTUBE_VIDEO', youtubeVideoId: 'abcdefghijk', width: null })
    expect(liveMediaAssetOf({ asset: { id: '301', type: 'IMAGE', imageAsset: { fullSize: { widthPixels: '1200', heightPixels: 628 } } } })).toMatchObject({ width: 1200, height: 628 })
  })
})
