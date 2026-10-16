/**
 * Google Ads programme 2 G14b (2026-10-16) — what the Demand Gen / Display builders gained: Display image ads and HTML5
 * ads, frequency caps (Display and Demand Gen), demographics TARGETED on Display ad groups with bid adjustments (changed
 * in place), and Google's own automation of new Demand Gen image and video ads OFF unless asked. What Google is sent,
 * what is refused first, what is SPENDS MONEY, and the records undo reads.
 */
import { describe, expect, it } from 'vitest'
import {
  frequencyCapsOfRequest, frequencyCapsSpend, typedAddDraft, typedCreateDraft, typedSettingsDraft, typedSettingsNow,
  type MediaLive, type TypedCampaignCreateRequest, type TypedSettingsRecord,
} from './change-campaign-types.js'
import type { LiveMediaAsset, LiveTypedAdGroup, LiveTypedCampaign, LiveTypedCriterion } from './live-campaign-types.js'
import type { GoogleChangeDraft } from './change-draft.js'

const C = 'customers/1234567890'
const sha = (c: string) => c.repeat(64).slice(0, 64)
const image = (width: number, height: number, s: string, bytes = 1000) => ({ source: `https://cdn.example/${s}.png`, label: s, mimeType: 'image/png' as const, bytes, width, height, sha256: sha(s), data: `${s}-bytes` })
const asset = (assetId: string, type: string, width: number | null = null, height: number | null = null, fileSize: number | null = null): LiveMediaAsset =>
  ({ assetId, type, name: null, source: 'ADVERTISER', width, height, mimeType: null, youtubeVideoId: null, youtubeTitle: null, fileSize })
const BUNDLE = { source: 'https://cdn.example/banner.zip', label: 'banner', bytes: 4096, sha256: sha('z'), files: 3, html: 'index.html', width: 300, height: 250, data: 'UEsDBA==' }
const MEDIA: MediaLive = {
  images: {
    'url:https://cdn.example/rect.png': image(300, 250, 'r'),
    'url:https://cdn.example/heavy.png': image(300, 250, 'h', 200 * 1024),
    'url:https://cdn.example/odd.png': image(1200, 628, 'o'),
    'url:https://cdn.example/land.png': image(1200, 628, 'a'),
    'url:https://cdn.example/square.png': image(1200, 1200, 'b'),
    'url:https://cdn.example/logo.png': image(512, 512, 'c'),
  },
  assets: [asset('311', 'IMAGE', 728, 90, 40_000), asset('312', 'IMAGE', 728, 90, 400_000), asset('321', 'MEDIA_BUNDLE'), asset('302', 'IMAGE', 1200, 1200)],
  youtube: [],
  bundles: { 'https://cdn.example/banner.zip': BUNDLE, 'https://cdn.example/bad.zip': { problem: 'https://cdn.example/bad.zip: it holds no HTML document (the primary asset)' } },
}
const kinds = (d: GoogleChangeDraft) => d.operations.map((op) => Object.keys(op)[0])
const opsOf = (d: GoogleChangeDraft, kind: string) => d.operations.filter((op) => kind in op).map((op) => (op as Record<string, any>)[kind])
const refused = (d: GoogleChangeDraft | { refusal: string }): string => ('refusal' in d ? d.refusal : `not refused: ${d.summary}`)
const draft = (d: GoogleChangeDraft | { refusal: string }): GoogleChangeDraft => { if ('refusal' in d) throw new Error(d.refusal); return d }
const createLive = { campaignNames: [], sharedBudget: null, names: {}, media: MEDIA }

const DISPLAY = (adGroups: TypedCampaignCreateRequest['adGroups'], o: Partial<TypedCampaignCreateRequest> = {}): TypedCampaignCreateRequest => ({
  kind: 'DISPLAY', name: 'Display A', dailyBudgetCents: 1500, locations: [{ id: '2380' }], adGroups, ...o,
})

describe('Display: image ads and HTML5 ads', () => {
  it('an image ad from a link goes as its bytes; one of an existing image asset points at it; both named, both with their final URL', () => {
    const d = draft(typedCreateDraft(C, 'EUR', DISPLAY([{
      name: 'Group A', defaultBidCents: 40,
      ads: [
        { type: 'image', name: 'Banner 300', finalUrl: 'https://shop.example/a', image: { imageUrl: 'https://cdn.example/rect.png' } },
        { type: 'image', finalUrl: 'https://shop.example/b', image: { assetId: '311' } },
      ],
    }]), createLive))
    expect(kinds(d)).not.toContain('assetOperation')
    const [a, b] = opsOf(d, 'adGroupAdOperation').map((o) => o.create.ad)
    expect(a).toEqual({ finalUrls: ['https://shop.example/a'], name: 'Banner 300', imageAd: { data: 'r-bytes' } })
    expect(b).toEqual({ finalUrls: ['https://shop.example/b'], imageAd: { imageAsset: { asset: `${C}/assets/311` } } })
    // No automation setting rides on an image ad (only Demand Gen image and video ads have Google's own automation here).
    expect(opsOf(d, 'adGroupAdOperation')[0].create.adGroupAdAssetAutomationSettings).toBeUndefined()
  })

  it('refuses an image ad of a size or weight Google does not take, without its image, or an image on another ad type', () => {
    const one = (ad: Record<string, unknown>) => refused(typedCreateDraft(C, 'EUR', DISPLAY([{ name: 'G', defaultBidCents: 40, ads: [ad as never] }]), createLive))
    expect(one({ type: 'image', finalUrl: 'https://shop.example/a', image: { imageUrl: 'https://cdn.example/odd.png' } })).toMatch(/1200×628: Google takes uploaded display ads of/)
    expect(one({ type: 'image', finalUrl: 'https://shop.example/a', image: { imageUrl: 'https://cdn.example/heavy.png' } })).toMatch(/200 KB: Google takes an image ad of at most 150 KB/)
    expect(one({ type: 'image', finalUrl: 'https://shop.example/a', image: { assetId: '312' } })).toMatch(/391 KB: Google takes an image ad of at most 150 KB/)
    expect(one({ type: 'image', finalUrl: 'https://shop.example/a' })).toMatch(/an image ad needs image/)
    expect(one({ type: 'image', image: { assetId: '311' } })).toMatch(/needs finalUrl/)
    expect(one({ type: 'image', finalUrl: 'https://shop.example/a', image: { assetId: '311' }, headlines: ['X'] })).toMatch(/has no headlines/)
    expect(one({ type: 'responsive-display', finalUrl: 'https://shop.example/a', image: { assetId: '311' } })).toMatch(/image is for an image ad/)
  })

  it('an HTML5 ad: its ZIP is a new MEDIA_BUNDLE asset (once), the ad a display upload ad of HTML5_UPLOAD_AD; an existing ZIP asset is pointed at; Google\'s access rule is said', () => {
    const html5 = (ref: Record<string, unknown>) => ({ type: 'html5-upload' as const, name: 'HTML5 A', finalUrl: 'https://shop.example/a', html5: ref })
    const d = draft(typedCreateDraft(C, 'EUR', DISPLAY([{ name: 'G', defaultBidCents: 40, ads: [html5({ zipUrl: 'https://cdn.example/banner.zip' }), html5({ zipUrl: 'https://cdn.example/banner.zip' }), html5({ assetId: '321' })] }]), createLive))
    const assets = opsOf(d, 'assetOperation').map((o) => o.create)
    expect(assets).toEqual([{ resourceName: expect.stringMatching(new RegExp(`^${C}/assets/-\\d+$`)), name: `banner ${sha('z').slice(0, 8)}`, type: 'MEDIA_BUNDLE', mediaBundleAsset: { data: 'UEsDBA==' } }])
    const ads = opsOf(d, 'adGroupAdOperation').map((o) => o.create.ad)
    expect(ads[0]).toEqual({ finalUrls: ['https://shop.example/a'], name: 'HTML5 A', displayUploadAd: { displayUploadProductType: 'HTML5_UPLOAD_AD', mediaBundle: { asset: assets[0].resourceName } } })
    expect(ads[1].displayUploadAd.mediaBundle.asset).toBe(assets[0].resourceName)
    expect(ads[2].displayUploadAd.mediaBundle.asset).toBe(`${C}/assets/321`)
    // The assets are made before the ads that point at them.
    expect(kinds(d).indexOf('assetOperation')).toBeLessThan(kinds(d).indexOf('adGroupAdOperation'))
    expect(d.warnings.filter((w) => /Apply for HTML5 access/.test(w))).toHaveLength(1)
    expect((d.after as { assets: unknown[] }).assets).toEqual([{ type: 'MEDIA_BUNDLE', assetId: expect.stringMatching(/^op:\d+$/), text: expect.stringContaining('300×250, 3 files'), sha256: sha('z') }])
    expect((d.stands as { images: string[] }).images).toEqual([sha('z')])
  })

  it('refuses an HTML5 ad whose ZIP Nexus could not take, a ZIP asset of another type, both or neither ref, and a Demand Gen HTML5 ad', () => {
    const one = (ad: Record<string, unknown>, o: Partial<TypedCampaignCreateRequest> = {}) => refused(typedCreateDraft(C, 'EUR', DISPLAY([{ name: 'G', defaultBidCents: 40, ads: [ad as never] }], o), createLive))
    expect(one({ type: 'html5-upload', finalUrl: 'https://shop.example/a', html5: { zipUrl: 'https://cdn.example/bad.zip' } })).toMatch(/holds no HTML document/)
    expect(one({ type: 'html5-upload', finalUrl: 'https://shop.example/a', html5: { assetId: '311' } })).toMatch(/asset 311 is IMAGE, not an HTML5 ZIP/)
    expect(one({ type: 'html5-upload', finalUrl: 'https://shop.example/a', html5: {} })).toMatch(/give zipUrl or assetId/)
    expect(one({ type: 'html5-upload', finalUrl: 'https://shop.example/a' })).toMatch(/needs html5/)
    const dg = refused(typedCreateDraft(C, 'EUR', { kind: 'DEMAND_GEN', name: 'DG', dailyBudgetCents: 2000, bidding: { strategy: 'MAXIMIZE_CLICKS' }, locations: [{ id: '2380' }], adGroups: [{ name: 'G', ads: [{ type: 'html5-upload', finalUrl: 'https://shop.example/a', html5: { assetId: '321' } }] }] }, createLive))
    expect(dg).toMatch(/a Demand Gen campaign takes multi-asset, carousel, video, product ads, not html5-upload/)
  })

  it('added to an ENABLED campaign an HTML5 ad is made PAUSED unless enable: true (SPENDS MONEY)', () => {
    const campaign: LiveTypedCampaign = { ...liveCampaign(), type: 'DISPLAY', bidding: 'MANUAL_CPC' }
    const live = { campaign, adGroups: [group({ type: 'DISPLAY_STANDARD', channels: null })], names: {}, media: MEDIA }
    const ad = { type: 'html5-upload' as const, finalUrl: 'https://shop.example/a', html5: { assetId: '321' } }
    const d = draft(typedAddDraft(C, 'EUR', { campaignId: '21', addAds: [{ adGroupId: '51', ads: [ad] }] }, live))
    expect(opsOf(d, 'adGroupAdOperation')[0].create.status).toBe('PAUSED')
    expect(d.spendsMoney).toEqual([])
    const on = draft(typedAddDraft(C, 'EUR', { campaignId: '21', addAds: [{ adGroupId: '51', ads: [ad] }], enable: true }, live))
    expect(on.spendsMoney.join(' ')).toMatch(/Adds an ENABLED HTML5 ad/)
  })
})

describe('Demand Gen: Google\'s own automation of new image and video ads is OFF unless asked', () => {
  const dgAds = (o: Record<string, unknown> = {}) => [
    { type: 'multi-asset' as const, finalUrl: 'https://shop.example/a', brandName: 'Shop A', headlines: ['Head one'], descriptions: ['Text one'], squareMarketingImages: [{ assetId: '302' }], logoImages: [{ imageUrl: 'https://cdn.example/logo.png' }], ...o },
    { type: 'video' as const, finalUrl: 'https://shop.example/a', brandName: 'Shop A', headlines: ['Video one'], videos: [{ youtubeVideoId: 'abcdefghijk' }], logoImages: [{ imageUrl: 'https://cdn.example/logo.png' }], ...o },
  ]
  const DG = (ads: unknown[]): TypedCampaignCreateRequest => ({ kind: 'DEMAND_GEN', name: 'DG A', dailyBudgetCents: 2000, bidding: { strategy: 'MAXIMIZE_CLICKS' }, locations: [{ id: '2380' }], adGroups: [{ name: 'G', ads: ads as never }] })
  const settings = (d: GoogleChangeDraft) => opsOf(d, 'adGroupAdOperation').map((o) => Object.fromEntries((o.create.adGroupAdAssetAutomationSettings ?? []).map((s: Record<string, string>) => [s.assetAutomationType, s.assetAutomationStatus])))

  it('each automation Google opts these ads into is said OPTED_OUT on the AdGroupAd', () => {
    expect(settings(draft(typedCreateDraft(C, 'EUR', DG(dgAds()), createLive)))).toEqual([
      { GENERATE_ANIMATED_IMAGES_FROM_OTHER_ASSETS: 'OPTED_OUT', GENERATE_DESIGN_VERSIONS_FOR_IMAGES: 'OPTED_OUT', GENERATE_VIDEOS_FROM_OTHER_ASSETS: 'OPTED_OUT' },
      { GENERATE_SHORTER_YOUTUBE_VIDEOS: 'OPTED_OUT', GENERATE_VERTICAL_YOUTUBE_VIDEOS: 'OPTED_OUT', GENERATE_LANDING_PAGE_TEXT: 'OPTED_OUT' },
    ])
  })

  it('asked for, they are OPTED_IN and said in the warnings; a carousel ad takes no such ask', () => {
    const on = draft(typedCreateDraft(C, 'EUR', DG(dgAds({ assetEnhancements: true, autogenVideo: false }).slice(0, 1)), createLive))
    expect(settings(on)).toEqual([{ GENERATE_ANIMATED_IMAGES_FROM_OTHER_ASSETS: 'OPTED_IN', GENERATE_DESIGN_VERSIONS_FOR_IMAGES: 'OPTED_IN', GENERATE_VIDEOS_FROM_OTHER_ASSETS: 'OPTED_OUT' }])
    expect(on.warnings.join(' ')).toMatch(/Google acts on its own — animated images from other assets, design versions for images/)
    const video = refused(typedCreateDraft(C, 'EUR', DG([{ ...dgAds()[1], autogenVideo: true }]), createLive))
    expect(video).toMatch(/videos made by Google are for responsive display ads and Demand Gen image ads/)
  })
})

describe('frequency caps (Display and Demand Gen)', () => {
  it('a new Display campaign carries its caps as Google\'s FrequencyCapEntry list; App campaigns, Display video views, a cap of 0 and two caps of one key are refused', () => {
    const d = draft(typedCreateDraft(C, 'EUR', DISPLAY([{ name: 'G', defaultBidCents: 40 }], { frequencyCaps: [{ events: 3, timeUnit: 'day' }, { events: 10, timeUnit: 'WEEK', level: 'AD_GROUP' }] }), createLive))
    expect(opsOf(d, 'campaignOperation')[0].create.frequencyCaps).toEqual([
      { key: { level: 'AD_GROUP', eventType: 'IMPRESSION', timeUnit: 'WEEK', timeLength: 1 }, cap: 10 },
      { key: { level: 'CAMPAIGN', eventType: 'IMPRESSION', timeUnit: 'DAY', timeLength: 1 }, cap: 3 },
    ])
    expect(String(d.changes['frequency caps'].to)).toMatch(/10 impressions a week per ad group; 3 impressions a day per campaign/)
    const problems: string[] = []
    frequencyCapsOfRequest('APP', [{ events: 3, timeUnit: 'DAY' }], problems)
    frequencyCapsOfRequest('DISPLAY', [{ events: 0, timeUnit: 'DAY' }, { events: 2, timeUnit: 'DAY', eventType: 'VIDEO_VIEW' }, { events: 4, timeUnit: 'DAY' }, { events: 5, timeUnit: 'DAY', level: 'CAMPAIGN' }], problems)
    expect(problems.join(' | ')).toMatch(/for Display and Demand Gen campaigns/)
    expect(problems.join(' | ')).toMatch(/at least 1/)
    expect(problems.join(' | ')).toMatch(/a Display campaign caps impressions/)
    expect(problems.join(' | ')).toMatch(/two caps of one key/)
    expect(frequencyCapsOfRequest('DEMAND_GEN', [{ events: 2, timeUnit: 'MONTH', eventType: 'video_view', timeLength: 2 }], [])).toEqual([{ events: 2, timeUnit: 'MONTH', timeLength: 2, level: 'CAMPAIGN', eventType: 'VIDEO_VIEW' }])
  })

  it('a cap raised or taken away is SPENDS MONEY (said with the campaign\'s state); a lower or a new cap is narrower; the whole list is written; undo reads it back', () => {
    // As the live read gives them: sorted by key (event, level, unit, length).
    const was = [{ events: 10, timeUnit: 'WEEK' as const, timeLength: 1, level: 'AD_GROUP' as const, eventType: 'IMPRESSION' as const }, { events: 3, timeUnit: 'DAY' as const, timeLength: 1, level: 'CAMPAIGN' as const, eventType: 'IMPRESSION' as const }]
    const live = { campaign: { ...liveCampaign(), type: 'DISPLAY', bidding: 'MANUAL_CPC', frequencyCaps: was }, adGroups: [], criteria: [], campaignNames: [], names: {} }
    const d = draft(typedSettingsDraft(C, 'EUR', { campaignId: '21', frequencyCaps: [{ events: 5, timeUnit: 'DAY' }] }, live))
    expect(d.operations).toEqual([{ campaignOperation: { update: { resourceName: `${C}/campaigns/21`, frequencyCaps: [{ key: { level: 'CAMPAIGN', eventType: 'IMPRESSION', timeUnit: 'DAY', timeLength: 1 }, cap: 5 }] }, updateMask: 'frequency_caps' } }])
    expect(d.spendsMoney).toEqual([
      'Takes the frequency cap "10 impressions a week per ad group" away — the same people can see the ads more often.',
      'Raises the frequency cap 3 impressions a day per campaign → 5.',
    ])
    const after = d.after as TypedSettingsRecord
    expect((d.before as TypedSettingsRecord).campaign.frequencyCaps).toEqual(was)
    expect(typedSettingsNow(after, { ...live, campaign: { ...live.campaign, frequencyCaps: after.campaign.frequencyCaps } })).toEqual(after)
    const none = draft(typedSettingsDraft(C, 'EUR', { campaignId: '21', frequencyCaps: [] }, live))
    expect(none.operations[0]).toEqual({ campaignOperation: { update: { resourceName: `${C}/campaigns/21`, frequencyCaps: [] }, updateMask: 'frequency_caps' } })
    expect(none.spendsMoney).toHaveLength(2)
    const paused = draft(typedSettingsDraft(C, 'EUR', { campaignId: '21', frequencyCaps: [{ events: 1, timeUnit: 'DAY' }, { events: 10, timeUnit: 'WEEK', level: 'AD_GROUP' }] }, { ...live, campaign: { ...live.campaign, status: 'PAUSED' } }))
    expect(paused.spendsMoney).toEqual([])
    expect(paused.warnings.join(' ')).toMatch(/1 impression a day per campaign — fewer showings to the same person \(narrower\)/)
    expect(refused(typedSettingsDraft(C, 'EUR', { campaignId: '21', frequencyCaps: [{ events: 3, timeUnit: 'DAY' }, { events: 10, timeUnit: 'WEEK', level: 'AD_GROUP' }] }, live))).toMatch(/Nothing to change/)
    expect(frequencyCapsSpend([], was)).toEqual([])
  })
})

describe('Display: demographics targeted with bid adjustments', () => {
  it('a new ad group targets age ranges (each with its adjustment) and excludes a gender; a demographic bid adjustment under Smart Bidding is said', () => {
    const d = draft(typedCreateDraft(C, 'EUR', DISPLAY([{
      name: 'G', defaultBidCents: 40,
      targeting: [
        { kind: 'age-range', value: 'AGE_RANGE_25_34', bidModifier: 1.2 }, { kind: 'age-range', value: 'age_range_35_44' }, { kind: 'age-range', value: 'AGE_RANGE_45_54', bidModifier: 1 },
        { kind: 'gender', value: 'UNDETERMINED', exclude: true }, { kind: 'user-list', value: '501', bidModifier: 0.8 },
      ],
    }]), { ...createLive, names: { 'user-list|501': { name: 'Visitors', status: 'OPEN' } } }))
    expect(opsOf(d, 'adGroupCriterionOperation').map((o) => { const { adGroup: _a, ...rest } = o.create; return rest })).toEqual([
      { bidModifier: 1.2, ageRange: { type: 'AGE_RANGE_25_34' } },
      { ageRange: { type: 'AGE_RANGE_35_44' } },
      { ageRange: { type: 'AGE_RANGE_45_54' } },
      { negative: true, gender: { type: 'UNDETERMINED' } },
      { bidModifier: 0.8, userList: { userList: `${C}/userLists/501` } },
    ])
    expect(Object.values(d.changes).map((c) => String(c.to)).join(' ')).toMatch(/age range AGE_RANGE_25_34 \(bid \+20 %\)/)
    expect(d.warnings.join(' ')).not.toMatch(/Smart Bidding/)
    const smart = draft(typedCreateDraft(C, 'EUR', DISPLAY([{ name: 'G', targeting: [{ kind: 'age-range', value: 'AGE_RANGE_25_34', bidModifier: 1.2 }] }], { bidding: { strategy: 'TARGET_CPA', targetCpaCents: 900 } }), createLive))
    expect(smart.warnings.join(' ')).toMatch(/"Display A" bids with TARGET_CPA: Google's Smart Bidding does not use these bid adjustments/)
  })

  it('refuses what Google refuses: only the unknown group, every group excluded, a group both targeted and excluded, a bid adjustment on an exclusion, a keyword or outside Display', () => {
    const one = (targeting: unknown[]) => refused(typedCreateDraft(C, 'EUR', DISPLAY([{ name: 'G', defaultBidCents: 40, targeting: targeting as never }]), createLive))
    expect(one([{ kind: 'gender', value: 'UNDETERMINED' }])).toMatch(/only the unknown gender group — Google refuses it \(CANNOT_TARGET_ONLY_UNDETERMINED\)/)
    expect(one([{ kind: 'parental-status', value: 'PARENT', exclude: true }, { kind: 'parental-status', value: 'NOT_A_PARENT', exclude: true }, { kind: 'parental-status', value: 'UNDETERMINED', exclude: true }])).toMatch(/every parental status group out — Google refuses it \(CANNOT_EXCLUDE_ALL_TARGETS/)
    expect(one([{ kind: 'gender', value: 'MALE' }, { kind: 'gender', value: 'MALE', exclude: true }])).toMatch(/gender MALE is both targeted and excluded/)
    expect(one([{ kind: 'gender', value: 'MALE', exclude: true, bidModifier: 1.5 }])).toMatch(/an excluded item has no bid adjustment/)
    expect(one([{ kind: 'keyword', value: 'gloves', bidModifier: 1.5 }])).toMatch(/not a keyword/)
    expect(one([{ kind: 'age-range', value: 'AGE_RANGE_25_34', bidModifier: 20 }])).toMatch(/between 0.1 and 10/)
    const dg = refused(typedCreateDraft(C, 'EUR', { kind: 'DEMAND_GEN', name: 'DG', dailyBudgetCents: 2000, bidding: { strategy: 'MAXIMIZE_CLICKS' }, locations: [{ id: '2380' }], adGroups: [{ name: 'G', targeting: [{ kind: 'age-range', value: 'AGE_RANGE_25_34' }] }] }, createLive))
    expect(dg).toMatch(/cannot target a age range/)
  })

  it('settings: another age range where it serves widens (SPENDS MONEY); a gender first narrows; an adjustment raised in place is SPENDS MONEY, lowered is not; undo puts the old adjustment back', () => {
    const live = {
      campaign: { ...liveCampaign(), type: 'DISPLAY', bidding: 'MANUAL_CPC' }, adGroups: [group({ type: 'DISPLAY_STANDARD', channels: null })], campaignNames: [], names: {},
      criteria: [crit('1', 'age-range', 'AGE_RANGE_25_34', false, 1.1), crit('2', 'age-range', 'AGE_RANGE_35_44')],
    }
    const d = draft(typedSettingsDraft(C, 'EUR', {
      campaignId: '21',
      adGroups: [{ adGroupId: '51', addTargeting: [{ kind: 'age-range', value: 'AGE_RANGE_45_54' }, { kind: 'gender', value: 'FEMALE' }, { kind: 'age-range', value: 'AGE_RANGE_25_34', bidModifier: 1.5 }, { kind: 'age-range', value: 'AGE_RANGE_35_44', bidModifier: 0.9 }] }],
    }, live))
    expect(d.operations).toEqual([
      { adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/51`, ageRange: { type: 'AGE_RANGE_45_54' } } } },
      { adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/51`, gender: { type: 'FEMALE' } } } },
      { adGroupCriterionOperation: { update: { resourceName: `${C}/adGroupCriteria/51~1`, bidModifier: 1.5 }, updateMask: 'bid_modifier' } },
      { adGroupCriterionOperation: { update: { resourceName: `${C}/adGroupCriteria/51~2`, bidModifier: 0.9 }, updateMask: 'bid_modifier' } },
    ])
    expect(d.spendsMoney).toEqual([
      'ad group "Group A": bids more for age range AGE_RANGE_25_34 (+10 % → +50 %).',
      'ad group "Group A": adds 1 age range to the 2 it targets — more people or places can see the ads.',
    ])
    expect(d.warnings.join(' ')).toMatch(/targets genders from now — only those see the ads \(narrower\)/)
    const after = d.after as TypedSettingsRecord
    expect(after.adGroups[0].rebid).toEqual([
      { item: { kind: 'age-range', value: 'AGE_RANGE_25_34', exclude: false }, from: 1.1, to: 1.5 },
      { item: { kind: 'age-range', value: 'AGE_RANGE_35_44', exclude: false }, from: null, to: 0.9 },
    ])
    const now = { ...live, criteria: [crit('1', 'age-range', 'AGE_RANGE_25_34', false, 1.5), crit('2', 'age-range', 'AGE_RANGE_35_44', false, 0.9), crit('7', 'age-range', 'AGE_RANGE_45_54'), crit('8', 'gender', 'FEMALE')] }
    expect(typedSettingsNow(after, now)).toEqual(after)
    expect(typedSettingsNow(after, { ...now, criteria: [crit('1', 'age-range', 'AGE_RANGE_25_34', false, 2), ...now.criteria.slice(1)] })).not.toEqual(after)
    // Removing the age range that had an adjustment records it, so an undo adds it back with it.
    const rm = draft(typedSettingsDraft(C, 'EUR', { campaignId: '21', adGroups: [{ adGroupId: '51', removeTargeting: [{ kind: 'age-range', value: 'AGE_RANGE_25_34' }] }] }, live))
    expect((rm.after as TypedSettingsRecord).adGroups[0].removed).toEqual([{ kind: 'age-range', value: 'AGE_RANGE_25_34', exclude: false, bidModifier: 1.1 }])
    expect(refused(typedSettingsDraft(C, 'EUR', { campaignId: '21', adGroups: [{ adGroupId: '51', addTargeting: [{ kind: 'age-range', value: 'AGE_RANGE_UNDETERMINED' }], removeTargeting: [{ kind: 'age-range', value: 'AGE_RANGE_25_34' }, { kind: 'age-range', value: 'AGE_RANGE_35_44' }] }] }, live))).toMatch(/only the unknown age range group/)
  })
})

describe('review fix: a new targeted item with a raise bids more', () => {
  const display = (o: { observation?: string[]; criteria?: LiveTypedCriterion[] } = {}) => ({
    campaign: { ...liveCampaign(), type: 'DISPLAY', bidding: 'MANUAL_CPC' }, adGroups: [group({ type: 'DISPLAY_STANDARD', observation: o.observation ?? [] })],
    campaignNames: [], names: { 'user-list|501': { name: 'Visitors', status: 'OPEN' } }, criteria: o.criteria ?? [],
  })
  it('the first of its dimension (narrower, and bids more: SPENDS MONEY where it serves; said in a paused ad group)', () => {
    const d = draft(typedSettingsDraft(C, 'EUR', { campaignId: '21', adGroups: [{ adGroupId: '51', addTargeting: [{ kind: 'age-range', value: 'AGE_RANGE_25_34', bidModifier: 1.3 }] }] }, display()))
    expect(d.spendsMoney).toEqual(['ad group "Group A": bids more for age range AGE_RANGE_25_34 (none → +30 %).'])
    expect(d.warnings.join(' ')).toMatch(/targets age ranges from now — only those see the ads \(narrower\)/)
    const paused = draft(typedSettingsDraft(C, 'EUR', { campaignId: '21', adGroups: [{ adGroupId: '51', addTargeting: [{ kind: 'age-range', value: 'AGE_RANGE_25_34', bidModifier: 1.3 }] }] }, { ...display(), adGroups: [group({ type: 'DISPLAY_STANDARD', status: 'PAUSED' })] }))
    expect(paused.spendsMoney).toEqual([])
    expect(paused.warnings.join(' ')).toMatch(/bids more for age range AGE_RANGE_25_34 \(none → \+30 %\) \(it does not serve now\)/)
    // A lower one bids less: no SPENDS MONEY line.
    expect(draft(typedSettingsDraft(C, 'EUR', { campaignId: '21', adGroups: [{ adGroupId: '51', addTargeting: [{ kind: 'age-range', value: 'AGE_RANGE_25_34', bidModifier: 0.7 }] }] }, display())).spendsMoney).toEqual([])
  })
  it('an audience in observation (it widens nothing, but its raise bids more)', () => {
    const d = draft(typedSettingsDraft(C, 'EUR', { campaignId: '21', adGroups: [{ adGroupId: '51', addTargeting: [{ kind: 'user-list', value: '501', bidModifier: 1.5 }] }] }, display({ observation: ['AUDIENCE'], criteria: [crit('3', 'user-list', '502')] })))
    expect(d.spendsMoney).toEqual(['ad group "Group A": bids more for user list 501 (Visitors) (none → +50 %).'])
    expect(d.warnings.join(' ')).toMatch(/audiences are in observation \(bids only\)/)
  })
})

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────────────────

function liveCampaign(): LiveTypedCampaign {
  return {
    campaignId: '21', name: 'Display Live', status: 'ENABLED', type: 'DEMAND_GEN', subType: null, bidding: 'TARGET_SPEND', portfolioId: null, start: null, end: null,
    targetCpaCents: null, targetRoas: null, maxCpcCents: null, targetCpcCents: null, app: null, merchantId: null, feedLabel: null, upgradedTargeting: true,
    conversionActionIds: [], optimizationGoals: [], budget: { budgetId: '14', amountCents: 2000, totalCents: null, period: 'DAILY', shared: false }, frequencyCaps: [],
  }
}
function group(o: Partial<LiveTypedAdGroup> = {}): LiveTypedAdGroup {
  return { adGroupId: '51', name: 'Group A', status: 'ENABLED', type: null, cpcBidCents: 40, cpmBidCents: null, targetCpaCents: null, optimizedTargeting: false, audienceGrouped: false, channels: null, observation: [], ...o }
}
function crit(criterionId: string, kind: LiveTypedCriterion['kind'], value: string, exclude = false, bidModifier: number | null = null): LiveTypedCriterion {
  return { adGroupId: '51', criterionId, kind, value, exclude, status: 'ENABLED', name: null, bidModifier }
}
