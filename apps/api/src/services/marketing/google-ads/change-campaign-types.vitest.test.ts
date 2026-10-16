/**
 * Google Ads changes (2026-10-15, programme 2 group G11) — the pure builders of Demand Gen, Display and App campaigns,
 * their ad groups and ads, and in-place ad edits: what Google is sent (one atomic request, temporary ids defined before
 * use, every new campaign PAUSED, Google acting on its own OFF unless asked), what is refused before anything is sent
 * (Google's rules per type), what is marked SPENDS MONEY, and the records undo reads.
 */
import { describe, expect, it } from 'vitest'
import {
  mediaNeeds, normalizeTarget, shapeProblem, targetKey, typedAddDraft, typedAddRecordAfterRun, typedBiddingSpends, typedCreateDraft,
  typedCreateRecordAfterRun, typedEditDraft, typedEditNow, typedEditRecordAfterRun, typedSettingsDraft, typedSettingsNow,
  type MediaLive, type TypedAddRecord, type TypedCampaignCreateRequest, type TypedCreateRecord, type TypedEditRecord, type TypedSettingsRecord,
} from './change-campaign-types.js'
import type { LiveMediaAsset, LiveTypedAd, LiveTypedAdGroup, LiveTypedCampaign, LiveTypedCriterion } from './live-campaign-types.js'
import type { GoogleChangeDraft } from './change-draft.js'

const C = 'customers/1234567890'
const sha = (c: string) => c.repeat(64).slice(0, 64)
const image = (width: number, height: number, s: string) => ({ source: `https://cdn.example/${s}.png`, label: s, mimeType: 'image/png' as const, bytes: 1000, width, height, sha256: sha(s), data: 'iVBORw0KGgo=' })
const asset = (assetId: string, type: string, width: number | null = null, height: number | null = null, youtubeVideoId: string | null = null): LiveMediaAsset =>
  ({ assetId, type, name: null, source: 'ADVERTISER', width, height, mimeType: null, youtubeVideoId, youtubeTitle: null })
const MEDIA: MediaLive = {
  images: {
    'url:https://cdn.example/land.png': image(1200, 628, 'a'),
    'url:https://cdn.example/square.png': image(1200, 1200, 'b'),
    'url:https://cdn.example/logo.png': image(512, 512, 'c'),
    'url:https://cdn.example/wide-logo.png': image(1200, 300, 'd'),
    'url:https://cdn.example/bad.png': image(1000, 1000, 'e'),
  },
  assets: [asset('301', 'IMAGE', 1200, 628), asset('302', 'IMAGE', 1200, 1200), asset('303', 'IMAGE', 128, 128), asset('401', 'YOUTUBE_VIDEO', null, null, 'abcdefghijk')],
  youtube: [],
}
const NAMES = { 'user-list|501': { name: 'Visitors', status: 'OPEN' }, 'audience|601': { name: 'Riders', status: 'ENABLED' } }
const kinds = (d: GoogleChangeDraft) => d.operations.map((op) => Object.keys(op)[0])
const opsOf = (d: GoogleChangeDraft, kind: string) => d.operations.filter((op) => kind in op).map((op) => (op as Record<string, any>)[kind])
const refused = (d: GoogleChangeDraft | { refusal: string }): string => ('refusal' in d ? d.refusal : `not refused: ${d.summary}`)
const draft = (d: GoogleChangeDraft | { refusal: string }): GoogleChangeDraft => { if ('refusal' in d) throw new Error(d.refusal); return d }

const createLive = { campaignNames: ['Search A'], sharedBudget: null, names: NAMES, media: MEDIA }

const multiAsset = {
  type: 'multi-asset' as const, finalUrl: 'https://shop.example/a', brandName: 'Shop A', headlines: ['Head one'], descriptions: ['Text one'],
  marketingImages: [{ imageUrl: 'https://cdn.example/land.png' }], logoImages: [{ imageUrl: 'https://cdn.example/logo.png' }],
}
const DG: TypedCampaignCreateRequest = {
  kind: 'DEMAND_GEN', name: 'DG A', dailyBudgetCents: 2000, bidding: { strategy: 'TARGET_CPA', targetCpaCents: 500 },
  locations: [{ id: '2380' }], languages: ['1004'],
  adGroups: [{
    name: 'Group A', channels: { selected: ['YOUTUBE_SHORTS', 'DISCOVER'] }, targeting: [{ kind: 'user-list', value: '501' }],
    ads: [
      multiAsset,
      { type: 'video', finalUrl: 'https://shop.example/a', brandName: 'Shop A', headlines: ['Video one'], videos: [{ youtubeVideoId: 'https://youtu.be/zyxwvutsrqp' }], logoImages: [{ imageUrl: 'https://cdn.example/logo.png' }] },
    ],
  }],
}

describe('create — Demand Gen', () => {
  it('one request: own budget, a PAUSED campaign, an untyped ad group with its channels and targeting, the assets, the ads — every id made before use', () => {
    const d = draft(typedCreateDraft(C, 'EUR', DG, createLive))
    expect(kinds(d)).toEqual([
      'campaignBudgetOperation', 'campaignOperation', 'adGroupOperation',
      'adGroupCriterionOperation', 'adGroupCriterionOperation', 'adGroupCriterionOperation',
      'assetOperation', 'assetOperation', 'assetOperation', 'adGroupAdOperation', 'adGroupAdOperation',
    ])
    const [budget] = opsOf(d, 'campaignBudgetOperation')
    expect(budget.create).toMatchObject({ explicitlyShared: false, amountMicros: '20000000', deliveryMethod: 'STANDARD' })
    const [campaign] = opsOf(d, 'campaignOperation')
    expect(campaign.create).toMatchObject({
      name: 'DG A', status: 'PAUSED', advertisingChannelType: 'DEMAND_GEN', campaignBudget: budget.create.resourceName,
      targetCpa: { targetCpaMicros: '5000000' }, containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
    })
    expect(campaign.create.advertisingChannelSubType).toBeUndefined()
    const [group] = opsOf(d, 'adGroupOperation')
    expect(group.create.type).toBeUndefined()
    expect(group.create.optimizedTargetingEnabled).toBe(false)
    expect(group.create.demandGenAdGroupSettings.channelControls.selectedChannels).toEqual({
      youtubeInStream: false, youtubeInFeed: false, youtubeShorts: true, discover: true, gmail: false, display: false, maps: false,
    })
    // Demand Gen holds locations and languages at the ad group (upgraded targeting).
    expect(opsOf(d, 'adGroupCriterionOperation').map((o) => o.create)).toEqual([
      { adGroup: group.create.resourceName, location: { geoTargetConstant: 'geoTargetConstants/2380' } },
      { adGroup: group.create.resourceName, language: { languageConstant: 'languageConstants/1004' } },
      { adGroup: group.create.resourceName, userList: { userList: `${C}/userLists/501` } },
    ])
    // The logo both ads use is made once; the YouTube video by its id (from the link).
    const assets = opsOf(d, 'assetOperation').map((o) => o.create)
    expect(assets.map((a) => a.type)).toEqual(['IMAGE', 'IMAGE', 'YOUTUBE_VIDEO'])
    expect(assets[2].youtubeVideoAsset).toEqual({ youtubeVideoId: 'zyxwvutsrqp' })
    const [image, video] = opsOf(d, 'adGroupAdOperation').map((o) => o.create)
    expect(image).toMatchObject({ adGroup: group.create.resourceName, status: 'ENABLED', ad: { finalUrls: ['https://shop.example/a'] } })
    expect(image.ad.demandGenMultiAssetAd).toEqual({
      headlines: [{ text: 'Head one' }], descriptions: [{ text: 'Text one' }], businessName: 'Shop A',
      marketingImages: [{ asset: assets[0].resourceName }], logoImages: [{ asset: assets[1].resourceName }],
    })
    expect(video.ad.demandGenVideoResponsiveAd).toEqual({
      headlines: [{ text: 'Video one' }], businessName: { text: 'Shop A' }, videos: [{ asset: assets[2].resourceName }], logoImages: [{ asset: assets[1].resourceName }],
    })
    // Temporary ids: negative, unique across the request.
    const temps = [budget.create.resourceName, campaign.create.resourceName, group.create.resourceName, ...assets.map((a) => a.resourceName)].map((r: string) => Number(r.slice(r.lastIndexOf('/') + 1)))
    expect(new Set(temps).size).toBe(temps.length)
    expect(temps.every((t) => t < 0)).toBe(true)
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings[0]).toMatch(/PAUSED: nothing spends until a person enables it/)
  })

  it('the record names what Google made, by the operation that made it', () => {
    const d = draft(typedCreateDraft(C, 'EUR', DG, createLive))
    const after = d.after as TypedCreateRecord
    expect(after).toMatchObject({ kind: 'DEMAND_GEN', campaignId: null, ownBudgetId: null, ops: { campaign: 1, budget: 0, assets: [6, 7, 8] } })
    const responses = d.operations.map((op, i) => {
      const kind = Object.keys(op)[0]
      const result = kind.replace('Operation', 'Result')
      const id = kind === 'adGroupAdOperation' ? `1~${900 + i}` : String(100 + i)
      return { [result]: { resourceName: `${C}/x/${id}` } }
    })
    const run = typedCreateRecordAfterRun(after, responses)
    expect(run).toMatchObject({ campaignId: '101', ownBudgetId: '100', adGroups: [{ name: 'Group A', adGroupId: '102' }] })
    expect(run.assets.map((a) => a.assetId)).toEqual(['106', '107', '108'])
  })

  it('a total budget for the whole campaign needs its dates; Demand Gen takes no shared budget and must say how it bids', () => {
    expect(refused(typedCreateDraft(C, 'EUR', { ...DG, dailyBudgetCents: null, totalBudgetCents: 50000 }, createLive))).toMatch(/needs startDate and endDate/)
    const total = draft(typedCreateDraft(C, 'EUR', { ...DG, dailyBudgetCents: null, totalBudgetCents: 50000, startDate: '2026-11-01', endDate: '2026-11-30' }, createLive))
    expect(opsOf(total, 'campaignBudgetOperation')[0].create).toMatchObject({ totalAmountMicros: '500000000', period: 'CUSTOM_PERIOD', explicitlyShared: false })
    expect(opsOf(total, 'campaignBudgetOperation')[0].create.amountMicros).toBeUndefined()
    expect(refused(typedCreateDraft(C, 'EUR', { ...DG, dailyBudgetCents: null, budgetId: '11' }, createLive))).toMatch(/cannot use a shared budget/)
    expect(refused(typedCreateDraft(C, 'EUR', { ...DG, bidding: null }, createLive))).toMatch(/say how the Demand Gen campaign bids/)
    expect(refused(typedCreateDraft(C, 'EUR', { ...DG, bidding: { strategy: 'MANUAL_CPC' } }, createLive))).toMatch(/bids with MAXIMIZE_CLICKS/)
  })

  it('refuses what Google would: a taken name, a wrong image shape, an unknown segment, an Audience mixed with segments, too few carousel cards', () => {
    expect(refused(typedCreateDraft(C, 'EUR', { ...DG, name: 'search a' }, createLive))).toMatch(/already exists/)
    const badLogo = { ...DG, adGroups: [{ name: 'G', ads: [{ ...multiAsset, logoImages: [{ imageUrl: 'https://cdn.example/land.png' }] }] }] }
    expect(refused(typedCreateDraft(C, 'EUR', badLogo, createLive))).toMatch(/must be square logo \(1:1\)/)
    const unknown = { ...DG, adGroups: [{ name: 'G', targeting: [{ kind: 'user-list' as const, value: '999' }] }] }
    expect(refused(typedCreateDraft(C, 'EUR', unknown, createLive))).toMatch(/user list 999 is not in this account/)
    const mixed = { ...DG, adGroups: [{ name: 'G', targeting: [{ kind: 'audience' as const, value: '601' }, { kind: 'user-list' as const, value: '501' }] }] }
    expect(refused(typedCreateDraft(C, 'EUR', mixed, createLive))).toMatch(/an Audience or audience segments, not both/)
    const carousel = { ...DG, adGroups: [{ name: 'G', ads: [{ type: 'carousel' as const, finalUrl: 'https://shop.example/a', brandName: 'Shop A', headlines: ['H'], descriptions: ['D'], logoImages: [{ assetId: '303' }], cards: [{ headline: 'Card', finalUrl: 'https://shop.example/c', squareMarketingImageAssetId: '302' }] }] }] }
    expect(refused(typedCreateDraft(C, 'EUR', carousel, createLive))).toMatch(/1 card \(a carousel takes 2 to 10\)/)
    const display = { ...DG, adGroups: [{ name: 'G', targeting: [{ kind: 'placement' as const, value: 'example.com' }] }] }
    expect(refused(typedCreateDraft(C, 'EUR', display, createLive))).toMatch(/cannot target a website/)
    const product = { ...DG, adGroups: [{ name: 'G', ads: [{ type: 'product' as const, brandName: 'Shop A', headlines: ['H'], descriptions: ['D'], logoImages: [{ assetId: '303' }] }] }] }
    expect(refused(typedCreateDraft(C, 'EUR', product, createLive))).toMatch(/product ad needs the campaign's product feed/)
  })

  it('an Audience makes the ad group audience-grouped; a carousel\'s cards are new assets on EXISTING images; a feed gives each ad group all products', () => {
    const r: TypedCampaignCreateRequest = {
      ...DG, merchant: { merchantId: '5550001', feedLabel: 'IT' },
      adGroups: [{
        name: 'G', targeting: [{ kind: 'audience', value: '601' }],
        ads: [
          { type: 'carousel', finalUrl: 'https://shop.example/a', brandName: 'Shop A', headlines: ['H'], descriptions: ['D'], logoImages: [{ assetId: '303' }], cards: [
            { headline: 'One', finalUrl: 'https://shop.example/1', marketingImageAssetId: '301' }, { headline: 'Two', finalUrl: 'https://shop.example/2', squareMarketingImageAssetId: '302', callToActionText: 'Shop now' },
          ] },
          { type: 'product', brandName: 'Shop A', headlines: ['H'], descriptions: ['D'], logoImages: [{ assetId: '303' }] },
        ],
      }],
    }
    const d = draft(typedCreateDraft(C, 'EUR', r, createLive))
    expect(opsOf(d, 'campaignOperation')[0].create.shoppingSetting).toEqual({ merchantId: '5550001', feedLabel: 'IT' })
    const [group] = opsOf(d, 'adGroupOperation')
    expect(group.create.audienceSetting).toEqual({ useAudienceGrouped: true })
    expect(opsOf(d, 'adGroupCriterionOperation').map((o) => o.create)).toContainEqual({ adGroup: group.create.resourceName, listingGroup: { type: 'UNIT' } })
    expect(opsOf(d, 'adGroupCriterionOperation').map((o) => o.create)).toContainEqual({ adGroup: group.create.resourceName, audience: { audience: `${C}/audiences/601` } })
    const cards = opsOf(d, 'assetOperation').map((o) => o.create)
    expect(cards.map((c) => c.demandGenCarouselCardAsset)).toEqual([
      { headline: 'One', marketingImageAsset: `${C}/assets/301` },
      { headline: 'Two', squareMarketingImageAsset: `${C}/assets/302`, callToActionText: 'Shop now' },
    ])
    const [carousel, product] = opsOf(d, 'adGroupAdOperation').map((o) => o.create.ad)
    expect(carousel.demandGenCarouselAd).toMatchObject({ headline: { text: 'H' }, description: { text: 'D' }, businessName: 'Shop A', logoImage: { asset: `${C}/assets/303` }, carouselCards: [{ asset: cards[0].resourceName }, { asset: cards[1].resourceName }] })
    expect(product).toEqual({ demandGenProductAd: { headline: { text: 'H' }, description: { text: 'D' }, businessName: { text: 'Shop A' }, logoImage: { asset: `${C}/assets/303` } } })
  })
})

describe('create — Display', () => {
  const rda = {
    finalUrl: 'https://shop.example/a', brandName: 'Shop A', headlines: ['Head one'], longHeadlines: ['A long headline'], descriptions: ['Text one'],
    marketingImages: [{ imageUrl: 'https://cdn.example/land.png' }], squareMarketingImages: [{ assetId: '302' }], logoImages: [{ imageUrl: 'https://cdn.example/wide-logo.png' }],
  }
  const DISPLAY: TypedCampaignCreateRequest = {
    kind: 'DISPLAY', name: 'Display A', dailyBudgetCents: 1500, locations: [{ id: '2380' }, { id: '2250', exclude: true }], languages: ['1004'],
    excludedContent: ['tragedy'],
    adGroups: [{
      name: 'Group A', defaultBidCents: 40,
      targeting: [
        { kind: 'placement', value: 'https://www.example.com/' }, { kind: 'youtube-video', value: 'https://www.youtube.com/watch?v=abcdefghijk' },
        { kind: 'keyword', value: 'riding  gloves' }, { kind: 'topic', value: 'topicConstants/66' }, { kind: 'placement', value: 'bad.example', exclude: true },
      ],
      ads: [rda],
    }],
  }
  it('Manual CPC by default, a DISPLAY_STANDARD ad group with its bid, the campaign\'s locations and content exclusions, every targeting kind, a responsive display ad with Google\'s enhancements OFF', () => {
    const d = draft(typedCreateDraft(C, 'EUR', DISPLAY, createLive))
    const [campaign] = opsOf(d, 'campaignOperation')
    expect(campaign.create).toMatchObject({ status: 'PAUSED', advertisingChannelType: 'DISPLAY', manualCpc: { enhancedCpcEnabled: false }, geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE', negativeGeoTargetType: 'PRESENCE' } })
    expect(opsOf(d, 'campaignCriterionOperation').map((o) => o.create)).toEqual([
      { campaign: campaign.create.resourceName, location: { geoTargetConstant: 'geoTargetConstants/2380' } },
      { campaign: campaign.create.resourceName, negative: true, location: { geoTargetConstant: 'geoTargetConstants/2250' } },
      { campaign: campaign.create.resourceName, language: { languageConstant: 'languageConstants/1004' } },
      { campaign: campaign.create.resourceName, negative: true, contentLabel: { type: 'TRAGEDY' } },
    ])
    const [group] = opsOf(d, 'adGroupOperation')
    expect(group.create).toMatchObject({ type: 'DISPLAY_STANDARD', cpcBidMicros: '400000', optimizedTargetingEnabled: false, status: 'ENABLED' })
    expect(opsOf(d, 'adGroupCriterionOperation').map((o) => { const { adGroup: _a, ...rest } = o.create; return rest })).toEqual([
      { placement: { url: 'https://www.example.com/' } },
      { youtubeVideo: { videoId: 'abcdefghijk' } },
      { keyword: { text: 'riding gloves', matchType: 'BROAD' } },
      { topic: { topicConstant: 'topicConstants/66' } },
      { negative: true, placement: { url: 'bad.example' } },
    ])
    const [ad] = opsOf(d, 'adGroupAdOperation').map((o) => o.create.ad)
    const assets = opsOf(d, 'assetOperation').map((o) => o.create)
    expect(ad.responsiveDisplayAd).toEqual({
      headlines: [{ text: 'Head one' }], longHeadline: { text: 'A long headline' }, descriptions: [{ text: 'Text one' }], businessName: 'Shop A',
      marketingImages: [{ asset: assets[0].resourceName }], squareMarketingImages: [{ asset: `${C}/assets/302` }], logoImages: [{ asset: assets[1].resourceName }],
      controlSpec: { enableAssetEnhancements: false, enableAutogenVideo: false },
    })
  })

  it('a shared budget may be used; a Manual CPC ad group without its bid, a 31-character headline, a missing square image, one colour are refused', () => {
    const shared = draft(typedCreateDraft(C, 'EUR', { ...DISPLAY, dailyBudgetCents: null, budgetId: '11' }, { ...createLive, sharedBudget: { budgetId: '11', name: 'Shared A', amountCents: 3000, shared: true } }))
    expect(kinds(shared)).not.toContain('campaignBudgetOperation')
    expect(opsOf(shared, 'campaignOperation')[0].create.campaignBudget).toBe(`${C}/campaignBudgets/11`)
    expect(refused(typedCreateDraft(C, 'EUR', { ...DISPLAY, adGroups: [{ ...DISPLAY.adGroups[0], defaultBidCents: null }] }, createLive))).toMatch(/needs its bid \(defaultBidCents\)/)
    const long = { ...DISPLAY, adGroups: [{ ...DISPLAY.adGroups[0], ads: [{ ...rda, headlines: ['x'.repeat(31)] }] }] }
    expect(refused(typedCreateDraft(C, 'EUR', long, createLive))).toMatch(/31 characters long: Google allows 30/)
    const square = { ...DISPLAY, adGroups: [{ ...DISPLAY.adGroups[0], ads: [{ ...rda, squareMarketingImages: [] }] }] }
    expect(refused(typedCreateDraft(C, 'EUR', square, createLive))).toMatch(/needs squareMarketingImages/)
    const colour = { ...DISPLAY, adGroups: [{ ...DISPLAY.adGroups[0], ads: [{ ...rda, mainColor: '#112233' }] }] }
    expect(refused(typedCreateDraft(C, 'EUR', colour, createLive))).toMatch(/mainColor and accentColor together/)
    expect(refused(typedCreateDraft(C, 'EUR', { ...DISPLAY, adGroups: [{ name: 'G', defaultBidCents: 40, targeting: [{ kind: 'location', value: '2380' }] }] }, createLive))).toMatch(/cannot target a location/)
  })
})

describe('create — App', () => {
  const APP: TypedCampaignCreateRequest = {
    kind: 'APP', name: 'App A', dailyBudgetCents: 3000, locations: [{ id: '2380' }],
    app: { appId: 'com.example.app', appStore: 'GOOGLE_APP_STORE', goal: 'OPTIMIZE_INSTALLS_TARGET_INSTALL_COST', targetCpaCents: 200 },
    adGroups: [{ name: 'Group A', ads: [{ headlines: ['Get the app'], descriptions: ['Track your rides'], images: [{ assetId: '302' }], videos: [{ assetId: '401' }] }] }],
  }
  it('MULTI_CHANNEL, the sub type and the bidding the goal ties, the app setting, an untyped ad group, an app ad without a final URL', () => {
    const d = draft(typedCreateDraft(C, 'EUR', APP, createLive))
    expect(opsOf(d, 'campaignOperation')[0].create).toMatchObject({
      status: 'PAUSED', advertisingChannelType: 'MULTI_CHANNEL', advertisingChannelSubType: 'APP_CAMPAIGN', targetCpa: { targetCpaMicros: '2000000' },
      appCampaignSetting: { appId: 'com.example.app', appStore: 'GOOGLE_APP_STORE', biddingStrategyGoalType: 'OPTIMIZE_INSTALLS_TARGET_INSTALL_COST' },
    })
    expect(opsOf(d, 'campaignBudgetOperation')[0].create.explicitlyShared).toBe(false)
    const [group] = opsOf(d, 'adGroupOperation')
    expect(group.create.type).toBeUndefined()
    expect(group.create.optimizedTargetingEnabled).toBeUndefined()
    expect(opsOf(d, 'adGroupAdOperation')[0].create.ad).toEqual({ appAd: { headlines: [{ text: 'Get the app' }], descriptions: [{ text: 'Track your rides' }], images: [{ asset: `${C}/assets/302` }], youtubeVideos: [{ asset: `${C}/assets/401` }] } })
  })

  it('engagement: its sub type, its conversion actions, a user list per ad group, app engagement ads; pre-registration: Google Play only, its goal setting', () => {
    const engagement: TypedCampaignCreateRequest = {
      ...APP, app: { appId: 'com.example.app', appStore: 'GOOGLE_APP_STORE', goal: 'OPTIMIZE_IN_APP_CONVERSIONS_TARGET_CONVERSION_COST', engagement: true, targetCpaCents: 300, conversionActionIds: ['71'] },
      adGroups: [{ name: 'Group A', targetCpaCents: 250, targeting: [{ kind: 'user-list', value: '501' }], ads: [{ headlines: ['Come back'], descriptions: ['New routes'] }] }],
    }
    const d = draft(typedCreateDraft(C, 'EUR', engagement, createLive))
    expect(opsOf(d, 'campaignOperation')[0].create).toMatchObject({ advertisingChannelSubType: 'APP_CAMPAIGN_FOR_ENGAGEMENT', selectiveOptimization: { conversionActions: [`${C}/conversionActions/71`] } })
    expect(opsOf(d, 'adGroupOperation')[0].create.targetCpaMicros).toBe('2500000')
    expect(Object.keys(opsOf(d, 'adGroupAdOperation')[0].create.ad)).toEqual(['appEngagementAd'])
    expect(refused(typedCreateDraft(C, 'EUR', { ...engagement, adGroups: [{ name: 'G', ads: [] }] }, createLive))).toMatch(/needs a user list/)
    expect(refused(typedCreateDraft(C, 'EUR', { ...engagement, app: { ...engagement.app!, conversionActionIds: [] } }, createLive))).toMatch(/needs the conversion actions/)
    expect(refused(typedCreateDraft(C, 'EUR', { ...APP, adGroups: [{ name: 'G', targetCpaCents: 250 }] }, createLive))).toMatch(/takes no ad group bid/)
    const pre: TypedCampaignCreateRequest = { ...APP, app: { appId: '12345', appStore: 'APPLE_APP_STORE', goal: 'OPTIMIZE_PRE_REGISTRATION_CONVERSION_VOLUME', targetCpaCents: 100 } }
    expect(refused(typedCreateDraft(C, 'EUR', pre, createLive))).toMatch(/pre-registration campaigns are for apps on Google Play/)
    const play = draft(typedCreateDraft(C, 'EUR', { ...pre, app: { ...pre.app!, appId: 'com.example.app', appStore: 'GOOGLE_APP_STORE' }, adGroups: [{ name: 'G', ads: [{ headlines: ['Soon'], descriptions: ['Sign up'] }] }] }, createLive))
    expect(opsOf(play, 'campaignOperation')[0].create).toMatchObject({ advertisingChannelSubType: 'APP_CAMPAIGN_FOR_PRE_REGISTRATION', optimizationGoalSetting: { optimizationGoalTypes: ['APP_PRE_REGISTRATION'] } })
    expect(Object.keys(opsOf(play, 'adGroupAdOperation')[0].create.ad)).toEqual(['appPreRegistrationAd'])
    expect(refused(typedCreateDraft(C, 'EUR', { ...APP, adGroups: [{ name: 'G', ads: [{ headlines: ['A'], descriptions: ['B'], finalUrl: 'https://shop.example/a' }] }] }, createLive))).toMatch(/has no final URL/)
    expect(refused(typedCreateDraft(C, 'EUR', { ...APP, bidding: { strategy: 'MAXIMIZE_CLICKS' } }, createLive))).toMatch(/bidding follows its goal/)
  })
})

// ── existing campaigns ───────────────────────────────────────────────────────────────────────────────────────────

const campaign = (o: Partial<LiveTypedCampaign> = {}): LiveTypedCampaign => ({
  campaignId: '21', name: 'DG Live', status: 'ENABLED', type: 'DEMAND_GEN', subType: null, bidding: 'TARGET_CPA', portfolioId: null, start: '2026-10-01 00:00:00', end: null,
  targetCpaCents: 500, targetRoas: null, maxCpcCents: null, targetCpcCents: null, app: null, merchantId: null, feedLabel: null, upgradedTargeting: true,
  conversionActionIds: [], optimizationGoals: [], budget: { budgetId: '14', amountCents: 2000, totalCents: null, period: 'DAILY', shared: false }, ...o,
})
const group = (o: Partial<LiveTypedAdGroup> = {}): LiveTypedAdGroup => ({
  adGroupId: '51', name: 'Group A', status: 'ENABLED', type: null, cpcBidCents: null, cpmBidCents: null, targetCpaCents: null, optimizedTargeting: false,
  audienceGrouped: false, channels: { strategy: 'ALL_OWNED_AND_OPERATED_CHANNELS' }, observation: [], ...o,
})
const crit = (criterionId: string, kind: LiveTypedCriterion['kind'], value: string, exclude = false, adGroupId = '51'): LiveTypedCriterion =>
  ({ adGroupId, criterionId, kind, value, exclude, status: 'ENABLED', name: null })

describe('add to an existing campaign', () => {
  const live = { campaign: campaign(), adGroups: [group()], names: NAMES, media: MEDIA }
  it('in an ENABLED campaign: new ad groups and new ads in an enabled ad group are made PAUSED; with enable: true they serve (SPENDS MONEY)', () => {
    const d = draft(typedAddDraft(C, 'EUR', { campaignId: '21', adGroups: [{ name: 'Group B', ads: [multiAsset] }], addAds: [{ adGroupId: '51', ads: [multiAsset] }] }, live))
    expect(opsOf(d, 'adGroupOperation')[0].create).toMatchObject({ campaign: `${C}/campaigns/21`, status: 'PAUSED', name: 'Group B' })
    const ads = opsOf(d, 'adGroupAdOperation').map((o) => o.create)
    expect(ads.map((a) => [a.adGroup.startsWith(`${C}/adGroups/-`) ? 'new' : a.adGroup, a.status])).toEqual([['new', 'ENABLED'], [`${C}/adGroups/51`, 'PAUSED']])
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings[0]).toMatch(/made PAUSED so nothing spends by itself/)
    const on = draft(typedAddDraft(C, 'EUR', { campaignId: '21', adGroups: [{ name: 'Group B', ads: [multiAsset] }], addAds: [{ adGroupId: '51', ads: [multiAsset] }], enable: true }, live))
    expect(opsOf(on, 'adGroupOperation')[0].create.status).toBe('ENABLED')
    expect(on.spendsMoney).toHaveLength(2)
  })

  it('Demand Gen: a new ad group without a location takes the locations and languages the campaign\'s ad groups share (said in the preview, kept in what the change stands on)', () => {
    const criteria = [crit('2', 'location', '2380'), crit('3', 'language', '1004'), crit('4', 'location', '2380', false, '52'), crit('5', 'language', '1004', false, '52'), crit('6', 'user-list', '502')]
    const two = { ...live, adGroups: [group(), group({ adGroupId: '52', name: 'Group B' })], criteria }
    const d = draft(typedAddDraft(C, 'EUR', { campaignId: '21', adGroups: [{ name: 'Group C', ads: [multiAsset] }] }, two))
    const newGroup = opsOf(d, 'adGroupOperation')[0].create.resourceName
    expect(opsOf(d, 'adGroupCriterionOperation').map((o) => o.create)).toEqual([
      { adGroup: newGroup, language: { languageConstant: 'languageConstants/1004' } },
      { adGroup: newGroup, location: { geoTargetConstant: 'geoTargetConstants/2380' } },
    ])
    expect(d.changes['"Group C" locations']).toEqual({ from: '(none)', to: 'locations 2380 (as the campaign\'s other ad groups)' })
    expect((d.stands as { places: string[] }).places).toEqual(['51:+language:1004|+location:2380', '52:+language:1004|+location:2380'])
    // Its own location: kept, and said.
    const own = draft(typedAddDraft(C, 'EUR', { campaignId: '21', adGroups: [{ name: 'Group C', targeting: [{ kind: 'location', value: '2250' }] }] }, two))
    expect(own.changes['"Group C" locations']).toEqual({ from: '(none)', to: 'locations 2250' })
    expect(opsOf(own, 'adGroupCriterionOperation')).toHaveLength(1)
    // Ad groups that differ, or none at all: refused until the request names its locations.
    const differ = { ...two, criteria: [crit('2', 'location', '2380'), crit('4', 'location', '2250', false, '52')] }
    expect(refused(typedAddDraft(C, 'EUR', { campaignId: '21', adGroups: [{ name: 'Group C' }] }, differ))).toMatch(/target different locations and languages: give location items/)
    expect(refused(typedAddDraft(C, 'EUR', { campaignId: '21', adGroups: [{ name: 'Group C' }] }, { ...live, adGroups: [] }))).toMatch(/no ad group to take locations from/)
    // A campaign that holds its own locations (no upgraded targeting): none at the ad group.
    const own2 = { ...live, campaign: campaign({ upgradedTargeting: false }) }
    expect(draft(typedAddDraft(C, 'EUR', { campaignId: '21', adGroups: [{ name: 'Group C' }] }, own2)).changes['"Group C" locations']).toBeUndefined()
    expect(refused(typedAddDraft(C, 'EUR', { campaignId: '21', adGroups: [{ name: 'Group C', targeting: [{ kind: 'location', value: '2250' }] }] }, own2))).toMatch(/holds its locations and languages at the campaign/)
  })

  it('App installs: an Audience makes the new ad group audience-grouped (a signal, docs/remarketing/audiences)', () => {
    const app = { ...live, campaign: campaign({ type: 'MULTI_CHANNEL', subType: 'APP_CAMPAIGN', bidding: 'TARGET_CPA', budget: null }) }
    const d = draft(typedAddDraft(C, 'EUR', { campaignId: '21', adGroups: [{ name: 'Group C', targeting: [{ kind: 'audience', value: '601' }], ads: [{ headlines: ['A'], descriptions: ['B'] }] }] }, app))
    expect(opsOf(d, 'adGroupOperation')[0].create.audienceSetting).toEqual({ useAudienceGrouped: true })
  })

  it('the record holds the ids Google gave (an ad by its adGroupId~adId); a taken name, a Video campaign and another campaign\'s ad group are refused', () => {
    const d = draft(typedAddDraft(C, 'EUR', { campaignId: '21', addAds: [{ adGroupId: '51', ads: [multiAsset] }] }, live))
    const responses = d.operations.map((op) => ('adGroupAdOperation' in op ? { adGroupAdResult: { resourceName: `${C}/adGroupAds/51~702` } } : { assetResult: { resourceName: `${C}/assets/309` } }))
    const after = typedAddRecordAfterRun(d.after as TypedAddRecord, responses)
    expect(after.ads).toEqual([{ adGroupId: '51', adId: '702', op: 2 }])
    expect(after.assets.map((a) => a.assetId)).toEqual(['309', '309'])
    expect(refused(typedAddDraft(C, 'EUR', { campaignId: '21', adGroups: [{ name: 'group a' }] }, live))).toMatch(/has an ad group of this name/)
    expect(refused(typedAddDraft(C, 'EUR', { campaignId: '21', adGroups: [{ name: 'X' }] }, { ...live, campaign: campaign({ type: 'VIDEO' }) }))).toMatch(/cannot add to a Video campaign/)
    expect(refused(typedAddDraft(C, 'EUR', { campaignId: '21', addAds: [{ adGroupId: '99', ads: [multiAsset] }] }, live))).toMatch(/ad group 99 is not in campaign/)
  })
})

describe('settings and targeting of an existing campaign', () => {
  const live = {
    campaign: campaign(), adGroups: [group(), group({ adGroupId: '52', name: 'Group B', status: 'PAUSED' })], campaignNames: ['DG Live', 'Search A'], names: NAMES,
    criteria: [crit('1', 'user-list', '502'), crit('2', 'location', '2380'), crit('3', 'location', '2250', true), crit('4', 'listing-group', 'UNIT')],
  }
  it('campaign: a higher target CPA, a later end and a bigger budget are SPENDS MONEY; a total budget changes total_amount_micros', () => {
    const d = draft(typedSettingsDraft(C, 'EUR', { campaignId: '21', name: 'DG New', bidding: { strategy: 'TARGET_CPA', targetCpaCents: 700 }, endDate: '2026-12-31', budgetCents: 2500 }, live))
    expect(d.operations[0]).toEqual({ campaignOperation: { update: { resourceName: `${C}/campaigns/21`, name: 'DG New', endDateTime: '2026-12-31 23:59:59', targetCpa: { targetCpaMicros: '7000000' } }, updateMask: 'name,end_date_time,target_cpa.target_cpa_micros' } })
    expect(d.operations[1]).toEqual({ campaignBudgetOperation: { update: { resourceName: `${C}/campaignBudgets/14`, amountMicros: '25000000' }, updateMask: 'amount_micros' } })
    expect(d.spendsMoney.join(' ')).toMatch(/Raises the target CPA EUR 5.00 → EUR 7.00/)
    expect(d.spendsMoney.join(' ')).toMatch(/Raises the daily budget/)
    expect(d.before).toEqual({ campaignId: '21', campaign: { name: 'DG Live', endDate: 'none', bidding: { strategy: 'TARGET_CPA', targetCpaCents: 500 }, budgetCents: 2000 }, adGroups: [] })
    const total = draft(typedSettingsDraft(C, 'EUR', { campaignId: '21', budgetCents: 40000 }, { ...live, campaign: campaign({ budget: { budgetId: '14', amountCents: null, totalCents: 50000, period: 'CUSTOM_PERIOD', shared: false } }) }))
    expect(total.operations[0]).toEqual({ campaignBudgetOperation: { update: { resourceName: `${C}/campaignBudgets/14`, totalAmountMicros: '400000000' }, updateMask: 'total_amount_micros' } })
    expect(total.spendsMoney).toEqual([])
  })

  it('ad groups: a channel added, optimized targeting on, one more audience segment, the last location taken away, an exclusion taken away — each SPENDS MONEY in a serving ad group', () => {
    const d = draft(typedSettingsDraft(C, 'EUR', {
      campaignId: '21',
      adGroups: [{
        adGroupId: '51', channels: { strategy: 'ALL_CHANNELS' }, optimizedTargeting: true,
        addTargeting: [{ kind: 'user-list', value: '501' }], removeTargeting: [{ kind: 'location', value: '2380' }, { kind: 'location', value: '2250', exclude: true }],
      }],
    }, live))
    expect(d.operations[0]).toEqual({ adGroupOperation: { update: { resourceName: `${C}/adGroups/51`, demandGenAdGroupSettings: { channelControls: { channelStrategy: 'ALL_CHANNELS' } }, optimizedTargetingEnabled: true }, updateMask: 'demand_gen_ad_group_settings.channel_controls.channel_strategy,optimized_targeting_enabled' } })
    expect(d.operations.slice(1)).toEqual([
      { adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/51`, userList: { userList: `${C}/userLists/501` } } } },
      { adGroupCriterionOperation: { remove: `${C}/adGroupCriteria/51~2` } },
      { adGroupCriterionOperation: { remove: `${C}/adGroupCriteria/51~3` } },
    ])
    expect(d.spendsMoney).toHaveLength(5)
    expect(d.spendsMoney.join(' ')).toMatch(/adds display/)
    expect(d.spendsMoney.join(' ')).toMatch(/takes away the last of its locations/)
    expect(d.spendsMoney.join(' ')).toMatch(/takes away 1 exclusion/)
    expect(d.after).toEqual({
      campaignId: '21', campaign: {},
      adGroups: [{ adGroupId: '51', settings: { channels: { strategy: 'ALL_CHANNELS' }, optimizedTargeting: true }, added: [{ kind: 'user-list', value: '501', exclude: false }], removed: [{ kind: 'location', value: '2380', exclude: false }, { kind: 'location', value: '2250', exclude: true }] }],
    })
  })

  it('the same in a paused ad group is said, not SPENDS MONEY; narrowing (picked channels, a first value of a kind) is safe', () => {
    const d = draft(typedSettingsDraft(C, 'EUR', { campaignId: '21', adGroups: [{ adGroupId: '52', channels: { selected: ['YOUTUBE_SHORTS'] }, optimizedTargeting: true, addTargeting: [{ kind: 'language', value: '1004' }] }] }, live))
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings.join(' ')).toMatch(/optimized targeting ON .*it does not serve now/)
    expect(d.warnings.join(' ')).toMatch(/targets languages from now — only those see the ads \(narrower\)/)
    expect(d.operations[0]).toMatchObject({ adGroupOperation: { updateMask: expect.stringContaining('selected_channels.youtube_shorts') } })
  })

  it('Display and App: the campaign\'s own locations and languages; one more location where it serves is SPENDS MONEY; Demand Gen keeps them at its ad groups', () => {
    const display = {
      ...live, campaign: campaign({ type: 'DISPLAY', bidding: 'MANUAL_CPC' }),
      campaignCriteria: [{ criterionId: '7', kind: 'location' as const, value: '2380', exclude: false }, { criterionId: '8', kind: 'language' as const, value: '1004', exclude: false }],
    }
    const d = draft(typedSettingsDraft(C, 'EUR', { campaignId: '21', addCampaignTargeting: [{ kind: 'location', value: '2250' }, { kind: 'location', value: '2276', exclude: true }], removeCampaignTargeting: [{ kind: 'language', value: '1004' }] }, display))
    expect(d.operations).toEqual([
      { campaignCriterionOperation: { create: { campaign: `${C}/campaigns/21`, location: { geoTargetConstant: 'geoTargetConstants/2250' } } } },
      { campaignCriterionOperation: { create: { campaign: `${C}/campaigns/21`, negative: true, location: { geoTargetConstant: 'geoTargetConstants/2276' } } } },
      { campaignCriterionOperation: { remove: `${C}/campaignCriteria/21~8` } },
    ])
    expect(d.spendsMoney.join(' ')).toMatch(/adds 1 location to the 1 it targets/)
    expect(d.spendsMoney.join(' ')).toMatch(/takes away the last of its languages/)
    const after = d.after as TypedSettingsRecord
    expect(after).toMatchObject({ campaignAdded: [{ kind: 'location', value: '2250', exclude: false }, { kind: 'location', value: '2276', exclude: true }], campaignRemoved: [{ kind: 'language', value: '1004', exclude: false }] })
    const moved = { ...display, campaignCriteria: [{ criterionId: '7', kind: 'location' as const, value: '2380', exclude: false }, { criterionId: '9', kind: 'location' as const, value: '2250', exclude: false }, { criterionId: '10', kind: 'location' as const, value: '2276', exclude: true }] }
    expect(typedSettingsNow(after, moved)).toEqual(after)
    expect(refused(typedSettingsDraft(C, 'EUR', { campaignId: '21', addCampaignTargeting: [{ kind: 'topic', value: '66' }] }, display))).toMatch(/takes locations/)
    expect(refused(typedSettingsDraft(C, 'EUR', { campaignId: '21', addCampaignTargeting: [{ kind: 'location', value: '2250' }] }, live))).toMatch(/holds its locations and languages at its ad groups/)
  })

  it('an ad group\'s own target CPA: below the campaign\'s is safe, above it SPENDS MONEY; a demographic is only ever excluded', () => {
    expect(draft(typedSettingsDraft(C, 'EUR', { campaignId: '21', adGroups: [{ adGroupId: '51', targetCpaCents: 400 }] }, live)).spendsMoney).toEqual([])
    expect(draft(typedSettingsDraft(C, 'EUR', { campaignId: '21', adGroups: [{ adGroupId: '51', targetCpaCents: 600 }] }, live)).spendsMoney[0]).toMatch(/EUR 5.00 → EUR 6.00/)
    const ex = draft(typedSettingsDraft(C, 'EUR', { campaignId: '21', adGroups: [{ adGroupId: '51', addTargeting: [{ kind: 'age-range', value: 'age_range_18_24', exclude: true }] }] }, live))
    expect(ex.operations).toEqual([{ adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/51`, negative: true, ageRange: { type: 'AGE_RANGE_18_24' } } } }])
    expect(ex.spendsMoney).toEqual([])
    expect(refused(typedSettingsDraft(C, 'EUR', { campaignId: '21', adGroups: [{ adGroupId: '51', addTargeting: [{ kind: 'gender', value: 'FEMALE' }] }] }, live))).toMatch(/cannot target a gender/)
    expect(refused(typedSettingsDraft(C, 'EUR', { campaignId: '21', adGroups: [{ adGroupId: '51', addTargeting: [{ kind: 'gender', value: 'OTHER', exclude: true }] }] }, live))).toMatch(/Google's values are FEMALE, MALE, UNDETERMINED/)
  })

  it('refuses: an Audience on an ad group made without audience grouping, an App strategy switch, an engagement ad group left without a user list, a Video campaign', () => {
    expect(refused(typedSettingsDraft(C, 'EUR', { campaignId: '21', adGroups: [{ adGroupId: '51', addTargeting: [{ kind: 'audience', value: '601' }] }] }, live))).toMatch(/made without audience grouping/)
    const app = { ...live, campaign: campaign({ type: 'MULTI_CHANNEL', subType: 'APP_CAMPAIGN_FOR_ENGAGEMENT', bidding: 'TARGET_CPA' }), criteria: [crit('1', 'user-list', '501')] }
    expect(refused(typedSettingsDraft(C, 'EUR', { campaignId: '21', bidding: { strategy: 'MAXIMIZE_CONVERSIONS' } }, app))).toMatch(/strategy follows its goal/)
    expect(refused(typedSettingsDraft(C, 'EUR', { campaignId: '21', adGroups: [{ adGroupId: '51', removeTargeting: [{ kind: 'user-list', value: '501' }] }] }, app))).toMatch(/needs a user list/)
    expect(draft(typedSettingsDraft(C, 'EUR', { campaignId: '21', bidding: { strategy: 'TARGET_CPA', targetCpaCents: 400 } }, app)).spendsMoney).toEqual([])
    expect(refused(typedSettingsDraft(C, 'EUR', { campaignId: '21', name: 'X' }, { ...live, campaign: campaign({ type: 'VIDEO' }) }))).toMatch(/cannot change a Video campaign/)
    expect(refused(typedSettingsDraft(C, 'EUR', { campaignId: '21', name: 'Search A' }, live))).toMatch(/another campaign is named/)
  })

  it('audiences in observation, and an App install campaign\'s audience signals, neither narrow nor widen: said, not SPENDS MONEY', () => {
    const display = { ...live, campaign: campaign({ type: 'DISPLAY', bidding: 'MANUAL_CPC' }), adGroups: [group({ channels: null, observation: ['AUDIENCE'] })], criteria: [crit('1', 'user-list', '502')] }
    const d = draft(typedSettingsDraft(C, 'EUR', { campaignId: '21', adGroups: [{ adGroupId: '51', addTargeting: [{ kind: 'user-list', value: '501' }] }] }, display))
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings.join(' ')).toMatch(/audiences are in observation \(bids only\)/)
    const app = { ...live, campaign: campaign({ type: 'MULTI_CHANNEL', subType: 'APP_CAMPAIGN', bidding: 'TARGET_CPA' }), adGroups: [group({ channels: null, audienceGrouped: true })], criteria: [] }
    const a = draft(typedSettingsDraft(C, 'EUR', { campaignId: '21', adGroups: [{ adGroupId: '51', addTargeting: [{ kind: 'audience', value: '601' }] }] }, app))
    expect(a.operations).toEqual([{ adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/51`, audience: { audience: `${C}/audiences/601` } } } }])
    expect(a.warnings.join(' ')).toMatch(/signals for Google/)
    expect(a.warnings.join(' ')).not.toMatch(/narrower/)
  })

  it('a Demand Gen campaign without upgraded targeting holds its locations at the campaign (and none at its ad groups)', () => {
    const own = { ...live, campaign: campaign({ upgradedTargeting: false }), campaignCriteria: [] }
    expect(draft(typedSettingsDraft(C, 'EUR', { campaignId: '21', addCampaignTargeting: [{ kind: 'location', value: '2380' }] }, own)).operations).toEqual([
      { campaignCriterionOperation: { create: { campaign: `${C}/campaigns/21`, location: { geoTargetConstant: 'geoTargetConstants/2380' } } } },
    ])
    expect(refused(typedSettingsDraft(C, 'EUR', { campaignId: '21', adGroups: [{ adGroupId: '51', addTargeting: [{ kind: 'location', value: '2250' }] }] }, own))).toMatch(/holds its locations and languages at the campaign/)
  })

  it('undo: what it wrote reads back the same from the live account (and not once it moved)', () => {
    const d = draft(typedSettingsDraft(C, 'EUR', { campaignId: '21', name: 'DG New', adGroups: [{ adGroupId: '51', optimizedTargeting: true, addTargeting: [{ kind: 'user-list', value: '501' }], removeTargeting: [{ kind: 'location', value: '2380' }] }] }, live))
    const after = d.after as TypedSettingsRecord
    const now = {
      ...live, campaign: campaign({ name: 'DG New' }), adGroups: [group({ optimizedTargeting: true })],
      criteria: [crit('1', 'user-list', '502'), crit('9', 'user-list', '501'), crit('3', 'location', '2250', true)],
    }
    expect(typedSettingsNow(after, now)).toEqual(after)
    expect(typedSettingsNow(after, { ...now, adGroups: [group()] })).not.toEqual(after)
  })
})

// ── edit ads in place ────────────────────────────────────────────────────────────────────────────────────────────

const liveAd = (o: Partial<LiveTypedAd>): LiveTypedAd => ({
  id: '51~701', adGroupId: '51', adId: '701', type: 'RESPONSIVE_DISPLAY_AD', status: 'ENABLED', adGroupStatus: 'ENABLED', campaignId: '21', campaignStatus: 'ENABLED',
  campaignType: 'DISPLAY', finalUrls: ['https://shop.example/a'], approval: 'APPROVED', info: {}, ...o,
})
const RDA_INFO = {
  headlines: [{ text: 'Old one' }], longHeadline: { text: 'Old long' }, descriptions: [{ text: 'Old text' }], businessName: 'Shop A',
  marketingImages: [{ asset: `${C}/assets/301` }], squareMarketingImages: [{ asset: `${C}/assets/302` }],
}

describe('edit ads in place', () => {
  it('a responsive display ad: only what changes is masked; a new image is made in the same request; the record names it until Google answers', () => {
    const live = { ads: [liveAd({ info: RDA_INFO })], media: MEDIA }
    const d = draft(typedEditDraft(C, { ads: [{ id: '51~701', headlines: ['New one', 'New two'], descriptions: ['Old text'], marketingImages: [{ imageUrl: 'https://cdn.example/land.png' }] }] }, live))
    expect(kinds(d)).toEqual(['assetOperation', 'adOperation'])
    const newImage = opsOf(d, 'assetOperation')[0].create.resourceName
    expect(d.operations[1]).toEqual({ adOperation: {
      update: { resourceName: `${C}/ads/701`, responsiveDisplayAd: { headlines: [{ text: 'New one' }, { text: 'New two' }], marketingImages: [{ asset: newImage }] } },
      updateMask: 'responsive_display_ad.headlines,responsive_display_ad.marketing_images',
    } })
    expect(d.before).toEqual({ ads: [{ id: '51~701', campaignId: '21', headlines: ['Old one'], marketingImages: [{ assetId: '301' }] }] })
    const after = d.after as TypedEditRecord
    expect(after.ads).toEqual([{ id: '51~701', campaignId: '21', headlines: ['New one', 'New two'], marketingImages: [{ assetId: 'op:0' }] }])
    const run = typedEditRecordAfterRun(after, [{ assetResult: { resourceName: `${C}/assets/377` } }, { adResult: { resourceName: `${C}/ads/701` } }])
    expect(run.ads[0].marketingImages).toEqual([{ assetId: '377' }])
    const edited = liveAd({ info: { ...RDA_INFO, headlines: [{ text: 'New one' }, { text: 'New two' }], marketingImages: [{ asset: `${C}/assets/377` }] } })
    expect(typedEditNow(run, [edited])).toEqual(run)
    expect(typedEditNow(run, [liveAd({ info: RDA_INFO })])).not.toEqual(run)
  })

  it('media an ad had none of opens new places: a video in a responsive display ad, vertical images in a Demand Gen image ad — SPENDS MONEY where it serves', () => {
    const rda = draft(typedEditDraft(C, { ads: [{ id: '51~701', videos: [{ assetId: '401' }] }] }, { ads: [liveAd({ info: RDA_INFO })], media: MEDIA }))
    expect(rda.spendsMoney).toEqual(['responsive display ad 51~701: adds YouTube videos (it can show as a video ad too) — the ad can show in new places.'])
    const paused = draft(typedEditDraft(C, { ads: [{ id: '51~701', videos: [{ assetId: '401' }] }] }, { ads: [liveAd({ info: RDA_INFO, campaignStatus: 'PAUSED' })], media: MEDIA }))
    expect(paused.spendsMoney).toEqual([])
    expect(paused.warnings.join(' ')).toMatch(/new places \(it does not serve now\)/)
    const dg = liveAd({ type: 'DEMAND_GEN_MULTI_ASSET_AD', info: { headlines: [{ text: 'H' }], descriptions: [{ text: 'D' }], businessName: 'Shop A', squareMarketingImages: [{ asset: `${C}/assets/302` }], logoImages: [{ asset: `${C}/assets/303` }] } })
    const media = { ...MEDIA, images: { ...MEDIA.images, 'url:https://cdn.example/tall.png': image(600, 1067, 'f') } }
    expect(draft(typedEditDraft(C, { ads: [{ id: '51~701', tallPortraitMarketingImages: [{ imageUrl: 'https://cdn.example/tall.png' }] }] }, { ads: [dg], media })).spendsMoney[0]).toMatch(/tall portrait images/)
  })

  it('a Video campaign\'s video responsive ad: its video, business name and logo always go along (Google requires them); one headline only', () => {
    const info = { headlines: [{ text: 'Old' }], businessName: { text: 'Shop A' }, videos: [{ asset: `${C}/assets/401` }], logoImages: [{ asset: `${C}/assets/303`, assetPerformanceLabel: 'GOOD' }] }
    const live = { ads: [liveAd({ type: 'VIDEO_RESPONSIVE_AD', campaignType: 'VIDEO', info })], media: MEDIA }
    const d = draft(typedEditDraft(C, { ads: [{ id: '51~701', headlines: ['New'], breadcrumb1: 'gloves' }] }, live))
    expect(d.operations[0]).toEqual({ adOperation: {
      update: { resourceName: `${C}/ads/701`, videoResponsiveAd: { headlines: [{ text: 'New' }], breadcrumb1: 'gloves', videos: [{ asset: `${C}/assets/401` }], businessName: { text: 'Shop A' }, logoImages: [{ asset: `${C}/assets/303` }] } },
      updateMask: 'video_responsive_ad.headlines,video_responsive_ad.breadcrumb1,video_responsive_ad.videos,video_responsive_ad.business_name,video_responsive_ad.logo_images',
    } })
    expect(refused(typedEditDraft(C, { ads: [{ id: '51~701', headlines: ['A', 'B'] }] }, live))).toMatch(/at most 1/)
    expect(refused(typedEditDraft(C, { ads: [{ id: '51~701', brandName: '' }] }, live))).toMatch(/cannot be emptied/)
  })

  it('clearing an optional text masks it with no value; a carousel takes ONE headline; an RSA is another tool\'s; a limited serving ad SPENDS MONEY', () => {
    const product = liveAd({ type: 'DEMAND_GEN_PRODUCT_AD', info: { headline: { text: 'H' }, description: { text: 'D' }, businessName: { text: 'Shop A' }, logoImage: { asset: `${C}/assets/303` }, breadcrumb1: 'gloves' } })
    const cleared = draft(typedEditDraft(C, { ads: [{ id: '51~701', breadcrumb1: '' }] }, { ads: [product], media: MEDIA }))
    expect(cleared.operations[0]).toEqual({ adOperation: { update: { resourceName: `${C}/ads/701` }, updateMask: 'demand_gen_product_ad.breadcrumb1' } })
    expect((cleared.after as TypedEditRecord).ads[0]).toEqual({ id: '51~701', campaignId: '21', breadcrumb1: null })
    const carousel = liveAd({ type: 'DEMAND_GEN_CAROUSEL_AD', info: { headline: { text: 'H' } } })
    expect(refused(typedEditDraft(C, { ads: [{ id: '51~701', headlines: ['A', 'B'] }] }, { ads: [carousel], media: MEDIA }))).toMatch(/ONE text \(2 given\)/)
    expect(refused(typedEditDraft(C, { ads: [{ id: '51~701', headlines: ['A'] }] }, { ads: [liveAd({ type: 'RESPONSIVE_SEARCH_AD', info: null })], media: MEDIA }))).toMatch(/edit-google-rsa/)
    const limited = draft(typedEditDraft(C, { ads: [{ id: '51~701', headlines: ['Fixed'] }] }, { ads: [liveAd({ info: RDA_INFO, approval: 'DISAPPROVED' })], media: MEDIA }))
    expect(limited.spendsMoney[0]).toMatch(/DISAPPROVED/)
    expect(refused(typedEditDraft(C, { ads: [{ id: '51~701', headlines: ['Old one'] }] }, { ads: [liveAd({ info: RDA_INFO })], media: MEDIA }))).toMatch(/already as asked/)
  })
})

describe('the parts', () => {
  it('image shapes ±1 %, the media a request names once each, target values as Google takes them', () => {
    expect(shapeProblem('x', 'marketing', 1200, 628)).toBeNull()
    expect(shapeProblem('x', 'marketing', 1200, 700)).toMatch(/landscape \(1.91:1\)/)
    expect(shapeProblem('x', 'tallPortrait', 600, 1067)).toBeNull()
    expect(shapeProblem('x', 'logo', 100, 100)).toMatch(/at least 128×128/)
    expect(mediaNeeds([multiAsset, { ...multiAsset, videos: [{ youtubeVideoId: 'https://youtu.be/abcdefghijk' }, { assetId: '401' }] }])).toEqual({
      imageSources: [{ imageUrl: 'https://cdn.example/land.png' }, { imageUrl: 'https://cdn.example/logo.png' }], assetIds: ['401'], youtubeIds: ['abcdefghijk'], bundleUrls: [],
    })
    expect(normalizeTarget({ kind: 'topic', value: 'topicConstants/66' })).toEqual({ kind: 'topic', value: '66', exclude: false })
    expect(normalizeTarget({ kind: 'youtube-channel', value: 'https://www.youtube.com/channel/UCabc' })).toEqual({ kind: 'youtube-channel', value: 'UCabc', exclude: false })
    expect('problem' in normalizeTarget({ kind: 'mobile-app', value: 'com.example' })).toBe(true)
    expect(targetKey({ kind: 'placement', value: 'https://Example.com/' })).toBe(targetKey({ kind: 'placement', value: 'example.com' }))
    expect(targetKey({ kind: 'keyword', value: 'Riding Gloves' })).toBe(targetKey({ kind: 'keyword', value: 'riding  gloves' }))
  })

  it('bidding: a switch to Google\'s bidding, a higher CPC / CPA ceiling, a lower ROAS spend more; lower targets do not', () => {
    expect(typedBiddingSpends({ strategy: 'MANUAL_CPC' }, { strategy: 'MAXIMIZE_CONVERSIONS' }, 'EUR')).toMatch(/Google sets the bids/)
    expect(typedBiddingSpends({ strategy: 'MAXIMIZE_CLICKS', maxCpcCents: 50 }, { strategy: 'MAXIMIZE_CLICKS' }, 'EUR')).toMatch(/no ceiling/)
    expect(typedBiddingSpends({ strategy: 'TARGET_ROAS', targetRoas: 4 }, { strategy: 'TARGET_ROAS', targetRoas: 3 }, 'EUR')).toMatch(/Lowers the target ROAS 400 % → 300 %/)
    expect(typedBiddingSpends({ strategy: 'TARGET_CPA', targetCpaCents: 500 }, { strategy: 'TARGET_CPA', targetCpaCents: 400 }, 'EUR')).toBeNull()
    expect(typedBiddingSpends({ strategy: 'TARGET_CPC', targetCpcCents: 30 }, { strategy: 'TARGET_CPC', targetCpcCents: 40 }, 'EUR')).toMatch(/Raises the target CPC/)
  })
})
