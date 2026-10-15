/**
 * Google Ads changes (2026-10-15, programme 2 group G3) — edit in place, URLs and tracking, replace and move, built from a
 * request and the live state (pure): the exact Google operations and update masks, what is refused before anything is
 * sent (every problem at once), what spends money, and the record undo reads. Also the live reads: each query selects
 * every field its WHERE names (Google refused a filter on a field it did not select, 2026-10-15), and rows map as read.
 */
import { describe, expect, it } from 'vitest'
import { adMoveDraft, adMoveRecordAfterRun, rsaEditDraft, type AdMoveLiveState } from './change-edit-ads.js'
import { assetEditDraft, assetEditRecordAfterRun, snippetLanguageOf, type AssetEditLiveState } from './change-edit-assets.js'
import { urlsChangeDraft, type UrlsLiveState } from './change-urls.js'
import { keywordReplaceDraft, keywordReplaceRecordAfterRun, type KeywordReplaceLiveState } from './change-replace-keywords.js'
import { budgetChangeDraft, budgetRecordAfterRun } from './change-budgets.js'
import { listChangeDraft } from './change-lists.js'
import { adGroupChangeDraft } from './change-ad-groups.js'
import {
  liveAdGroupAdsQuery, liveAdGroupRotationsQuery, liveAdGroupUrlsQuery, liveAssetAccountLinksQuery, liveAssetAdGroupLinksQuery,
  liveAssetCampaignLinksQuery, liveCampaignKeywordUrlsQuery, liveCampaignUrlsQuery, liveEditAdOf, liveEditAdsQuery, liveEditAssetOf,
  liveEditAssetsQuery, liveKeywordUrlsOf, liveKeywordUrlsQuery, type LiveEditAd, type LiveKeywordUrls,
} from './live-edit.js'
import type { LiveCampaign } from './live.js'

const C = 'customers/1234567890'
const NO_URLS = { trackingTemplate: null, finalUrlSuffix: null, customParameters: [] }

const ad = (adGroupId: string, adId: string, over: Partial<LiveEditAd> = {}): LiveEditAd => ({
  id: `${adGroupId}~${adId}`, adId, adGroupId, adGroupName: `Group ${adGroupId}`, adGroupStatus: 'ENABLED', campaignId: '21', campaignName: 'Search A',
  campaignStatus: 'ENABLED', campaignType: 'SEARCH', status: 'ENABLED', type: 'RESPONSIVE_SEARCH_AD',
  headlines: [{ text: 'Moto Jackets', pin: 'HEADLINE_1' }, { text: 'Free Returns', pin: null }, { text: 'Shop A', pin: null }],
  descriptions: [{ text: 'Leather jackets.', pin: null }, { text: 'Ships in 24 hours.', pin: null }],
  path1: 'jackets', path2: 'leather', finalUrls: ['https://shop.example/a'], finalMobileUrls: [], urls: NO_URLS, ...over,
})

// ── the live reads ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The fields a GAQL WHERE names, each of which the SELECT must hold. */
function whereFieldsSelected(query: string): string[] {
  const [select, rest] = query.split(/ FROM /)
  const selected = new Set(select.replace(/^SELECT /, '').split(',').map((f) => f.trim()))
  const where = rest.split(/ WHERE /)[1] ?? ''
  const named = [...where.matchAll(/\b([a-z_]+\.[a-z_.]+)\b(?=\s*(?:=|!=|IN\b|>|<|LIKE))/g)].map((m) => m[1])
  return named.filter((f) => !selected.has(f))
}

describe('live-edit.ts — the queries', () => {
  const queries = {
    ads: liveEditAdsQuery(['51~701', '52~702']),
    adGroupAds: liveAdGroupAdsQuery('51'),
    campaignUrls: liveCampaignUrlsQuery(['21']),
    adGroupUrls: liveAdGroupUrlsQuery(['51']),
    keywordUrls: liveKeywordUrlsQuery(['51~601']),
    campaignKeywords: liveCampaignKeywordUrlsQuery('21'),
    assets: liveEditAssetsQuery(['9']),
    campaignLinks: liveAssetCampaignLinksQuery(['9']),
    adGroupLinks: liveAssetAdGroupLinksQuery(['9']),
    accountLinks: liveAssetAccountLinksQuery(['9']),
    rotations: liveAdGroupRotationsQuery('21'),
  }

  it('every field a WHERE names is selected too (also of another resource)', () => {
    for (const [name, query] of Object.entries(queries)) expect(whereFieldsSelected(query), name).toEqual([])
  })

  it('ads by adGroupId~adId: both ids asked, removed ads left out; a malformed id or too many ids are refused before anything is sent', () => {
    expect(queries.ads).toContain('WHERE ad_group.id IN (51, 52) AND ad_group_ad.ad.id IN (701, 702) AND ad_group_ad.status != \'REMOVED\'')
    expect(() => liveEditAdsQuery(['701'])).toThrow(/not adGroupId~adId/)
    expect(() => liveCampaignUrlsQuery(Array.from({ length: 101 }, (_, i) => String(i + 1)))).toThrow(/Read 1 to 100/)
    expect(() => liveKeywordUrlsQuery(['51~x'])).toThrow(/not adGroupId~criterionId/)
  })

  it('rows map as Google sends them: pins, URLs, custom parameters sorted by key, an own bid of 0 = none', () => {
    const row = {
      campaign: { id: '21', name: 'Search A', status: 'ENABLED', advertisingChannelType: 'SEARCH' },
      adGroup: { id: '51', name: 'Group A', status: 'ENABLED' },
      adGroupAd: {
        status: 'PAUSED',
        ad: {
          id: '701', type: 'RESPONSIVE_SEARCH_AD', finalUrls: ['https://shop.example/a'], finalMobileUrls: ['https://m.shop.example/a'],
          trackingUrlTemplate: '{lpurl}?t=1', urlCustomParameters: [{ key: 'z', value: '2' }, { key: 'a', value: '1' }],
          responsiveSearchAd: { headlines: [{ text: 'H1', pinnedField: 'HEADLINE_1', assetPerformanceLabel: 'GOOD' }], descriptions: [{ text: 'D1' }], path1: 'p' },
        },
      },
    }
    expect(liveEditAdOf(row)).toMatchObject({
      id: '51~701', adId: '701', status: 'PAUSED', headlines: [{ text: 'H1', pin: 'HEADLINE_1' }], descriptions: [{ text: 'D1', pin: null }], path1: 'p', path2: null,
      finalMobileUrls: ['https://m.shop.example/a'], urls: { trackingTemplate: '{lpurl}?t=1', finalUrlSuffix: null, customParameters: [{ key: 'a', value: '1' }, { key: 'z', value: '2' }] },
    })
    const kw = liveKeywordUrlsOf({ adGroup: { id: '51' }, adGroupCriterion: { criterionId: '601', keyword: { text: 'x', matchType: 'EXACT' }, cpcBidMicros: '0', finalUrls: ['https://shop.example/k'] } })
    expect(kw).toMatchObject({ id: '51~601', cpcBidCents: null, finalUrls: ['https://shop.example/k'], urls: NO_URLS })
    expect(liveEditAssetOf({ asset: { id: '9', type: 'SITELINK', source: 'ADVERTISER', finalUrls: ['https://shop.example/s'], sitelinkAsset: { linkText: 'Sale' } } }))
      .toEqual({ assetId: '9', type: 'SITELINK', source: 'ADVERTISER', name: null, finalUrls: ['https://shop.example/s'], finalMobileUrls: [], linkText: 'Sale', description1: null, description2: null })
  })
})

// ── edit-google-rsa ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('rsaEditDraft — a responsive search ad edited in place', () => {
  const live = { ads: [ad('51', '701')] }

  it('the whole new headline list and a final URL: one AdOperation update, the mask names exactly those fields, nothing spends', () => {
    const d = rsaEditDraft(C, { ads: [{ id: '51~701', headlines: [{ text: 'Moto Jackets', pin: 'HEADLINE_1' }, { text: 'Free Returns' }, { text: 'Sale Now' }], finalUrl: 'https://shop.example/b' }] }, live)
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([{
      adOperation: {
        update: {
          resourceName: `${C}/ads/701`,
          responsiveSearchAd: { headlines: [{ text: 'Moto Jackets', pinnedField: 'HEADLINE_1' }, { text: 'Free Returns' }, { text: 'Sale Now' }] },
          finalUrls: ['https://shop.example/b'],
        },
        updateMask: 'responsive_search_ad.headlines,final_urls',
      },
    }])
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings[0]).toBe('Each ad keeps its id, so its numbers stay with it. Google reviews the changed ad again: google-ads-live view ads shows the review.')
    expect(d.before).toEqual({ ads: [{ id: '51~701', campaignId: '21', headlines: [{ text: 'Moto Jackets', pin: 'HEADLINE_1' }, { text: 'Free Returns' }, { text: 'Shop A' }], finalUrl: 'https://shop.example/a' }] })
    expect(d.after).toEqual({ ads: [{ id: '51~701', campaignId: '21', headlines: [{ text: 'Moto Jackets', pin: 'HEADLINE_1' }, { text: 'Free Returns' }, { text: 'Sale Now' }], finalUrl: 'https://shop.example/b' }] })
  })

  it('paths taken away: both masked and left out of the body (Google clears them); a mobile page set', () => {
    const d = rsaEditDraft(C, { ads: [{ id: '51~701', path1: null, path2: null, finalMobileUrl: 'https://m.shop.example/a' }] }, live)
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([{ adOperation: { update: { resourceName: `${C}/ads/701`, responsiveSearchAd: {}, finalMobileUrls: ['https://m.shop.example/a'] }, updateMask: 'responsive_search_ad.path1,responsive_search_ad.path2,final_mobile_urls' } }])
    expect(d.after).toEqual({ ads: [{ id: '51~701', campaignId: '21', path1: null, path2: null, finalMobileUrl: 'https://m.shop.example/a' }] })
  })

  it('refused before Google is asked, every problem at once: path2 without path1, a pin that leaves headline 2 empty, an http URL', () => {
    const d = rsaEditDraft(C, { ads: [{ id: '51~701', path1: null, headlines: [{ text: 'A', pin: 'HEADLINE_1' }, { text: 'B', pin: 'HEADLINE_1' }, { text: 'C', pin: 'HEADLINE_3' }], finalUrl: 'http://shop.example/a' }] }, live)
    expect(d).toEqual({ refusal: expect.stringContaining('Not queued — the edits break Google\'s rules') })
    const text = (d as { refusal: string }).refusal
    expect(text).toContain('the pins leave HEADLINE_2 with no headline to show')
    expect(text).toContain('path2 needs path1')
    expect(text).toContain('is not an https address')
  })

  it('an ad that is not there, not a responsive search ad, or already so', () => {
    expect(rsaEditDraft(C, { ads: [{ id: '51~799', finalUrl: 'https://shop.example/b' }] }, live)).toEqual({ refusal: expect.stringContaining('Ad 51~799 is not in this account') })
    expect(rsaEditDraft(C, { ads: [{ id: '51~701', finalUrl: 'https://shop.example/b' }] }, { ads: [ad('51', '701', { type: 'SHOPPING_PRODUCT_AD' })] })).toEqual({ refusal: expect.stringContaining('Nexus edits responsive search ads only') })
    expect(rsaEditDraft(C, { ads: [{ id: '51~701', finalUrl: 'https://shop.example/a', path1: 'jackets' }] }, live)).toEqual({ refusal: 'Nothing to change: Ad 51~701 already reads so (path1, final URL).' })
  })
})

// ── move-google-ads ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('adMoveDraft — ads into another ad group (made again there, removed here)', () => {
  const place = (adGroupId: string, status = 'ENABLED') => ({ campaign: { campaignId: '21', name: 'Search A', status: 'ENABLED', type: 'SEARCH' }, adGroup: { adGroupId, name: `Group ${adGroupId}`, status, type: 'SEARCH_STANDARD' } })
  const tracked = ad('51', '701', { urls: { trackingTemplate: '{lpurl}?t=1', finalUrlSuffix: 'src=g', customParameters: [{ key: 'k', value: 'v' }] } })
  const live: AdMoveLiveState = { from: place('51'), to: place('52'), fromAds: [tracked, ad('51', '702')], toAds: [ad('52', '801')] }

  it('the new ad first (texts, pins, paths, URLs, tracking, its status), the removal after; SPENDS MONEY into an enabled ad group', () => {
    const d = adMoveDraft(C, { campaignId: '21', adGroupId: '51', toAdGroupId: '52', adIds: ['701'] }, live)
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([
      {
        adGroupAdOperation: {
          create: {
            adGroup: `${C}/adGroups/52`,
            status: 'ENABLED',
            ad: {
              finalUrls: ['https://shop.example/a'], trackingUrlTemplate: '{lpurl}?t=1', finalUrlSuffix: 'src=g', urlCustomParameters: [{ key: 'k', value: 'v' }],
              responsiveSearchAd: {
                headlines: [{ text: 'Moto Jackets', pinnedField: 'HEADLINE_1' }, { text: 'Free Returns' }, { text: 'Shop A' }],
                descriptions: [{ text: 'Leather jackets.' }, { text: 'Ships in 24 hours.' }],
                path1: 'jackets', path2: 'leather',
              },
            },
          },
        },
      },
      { adGroupAdOperation: { remove: `${C}/adGroupAds/51~701` } },
    ])
    expect(d.spendsMoney).toEqual(['Moves 1 enabled ad into the enabled ad group "Group 52" of the enabled campaign "Search A": it shows (and spends) there as soon as Google approves it.'])
    expect(d.warnings[0]).toMatch(/The numbers \(clicks, cost, conversions\) stay with the removed ad/)
    expect(d.after).toEqual({ campaignId: '21', fromAdGroupId: '51', toAdGroupId: '52', moved: [{ fromAdId: '701', toAdId: 'op:0', status: 'ENABLED' }] })
    expect(adMoveRecordAfterRun(d.after as never, [{ adGroupAdResult: { resourceName: `${C}/adGroupAds/52~901` } }, {}]).moved).toEqual([{ fromAdId: '701', toAdId: '901', status: 'ENABLED' }])
  })

  it('Google\'s 3 enabled ads per ad group, the same ad group, and an ad not there are refused', () => {
    const full = { ...live, toAds: [ad('52', '801'), ad('52', '802'), ad('52', '803')] }
    expect(adMoveDraft(C, { campaignId: '21', adGroupId: '51', toAdGroupId: '52', adIds: ['701'] }, full)).toEqual({ refusal: expect.stringContaining('Google allows 3 enabled responsive search ads per ad group') })
    expect(adMoveDraft(C, { campaignId: '21', adGroupId: '51', toAdGroupId: '51', adIds: ['701'] }, live)).toEqual({ refusal: expect.stringContaining('already') })
    expect(adMoveDraft(C, { campaignId: '21', adGroupId: '51', toAdGroupId: '52', adIds: ['799'] }, live)).toEqual({ refusal: expect.stringContaining('Ad 799 is not in ad group "Group 51"') })
  })
})

// ── set-google-urls ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('urlsChangeDraft — URLs and tracking at every level', () => {
  const kw = (over: Partial<LiveKeywordUrls> = {}): LiveKeywordUrls => ({
    id: '51~601', adGroupId: '51', criterionId: '601', adGroupName: 'Group A', adGroupStatus: 'ENABLED', campaignId: '21', campaignName: 'Search A', campaignStatus: 'ENABLED',
    text: 'moto jacket', matchType: 'EXACT', negative: false, status: 'ENABLED', cpcBidCents: 30, effectiveCpcBidCents: 30, finalUrls: ['https://shop.example/k'], finalMobileUrls: [], urls: NO_URLS, ...over,
  })
  const live: UrlsLiveState = {
    campaigns: [{ campaignId: '21', name: 'Search A', status: 'ENABLED', urls: { trackingTemplate: '{lpurl}?old=1', finalUrlSuffix: null, customParameters: [{ key: 'src', value: 'a' }] } }],
    adGroups: [{ adGroupId: '51', name: 'Group A', status: 'ENABLED', campaignId: '21', campaignName: 'Search A', urls: NO_URLS }],
    keywords: [kw()],
    ads: [ad('51', '701')],
  }

  it('one update per item with its own operation kind and mask; null takes a value away (masked, left out)', () => {
    const d = urlsChangeDraft(C, {
      items: [
        { level: 'campaign', id: '21', trackingTemplate: null, customParameters: [{ key: 'src', value: 'b' }, { key: 'camp', value: 'x' }] },
        { level: 'ad-group', id: '51', finalUrlSuffix: 'utm_source=google' },
        { level: 'keyword', id: '51~601', finalUrl: null },
        { level: 'ad', id: '51~701', trackingTemplate: 'https://track.example/?u={lpurl}' },
      ],
    }, live)
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([
      { campaignOperation: { update: { resourceName: `${C}/campaigns/21`, urlCustomParameters: [{ key: 'camp', value: 'x' }, { key: 'src', value: 'b' }] }, updateMask: 'tracking_url_template,url_custom_parameters' } },
      { adGroupOperation: { update: { resourceName: `${C}/adGroups/51`, finalUrlSuffix: 'utm_source=google' }, updateMask: 'final_url_suffix' } },
      { adGroupCriterionOperation: { update: { resourceName: `${C}/adGroupCriteria/51~601` }, updateMask: 'final_urls' } },
      { adOperation: { update: { resourceName: `${C}/ads/701`, trackingUrlTemplate: 'https://track.example/?u={lpurl}' }, updateMask: 'tracking_url_template' } },
    ])
    expect(d.spendsMoney).toEqual([])
    expect(d.before).toEqual({ items: [
      { level: 'campaign', id: '21', trackingTemplate: '{lpurl}?old=1', customParameters: [{ key: 'src', value: 'a' }] },
      { level: 'ad-group', id: '51', finalUrlSuffix: null },
      { level: 'keyword', id: '51~601', finalUrl: 'https://shop.example/k' },
      { level: 'ad', id: '51~701', trackingTemplate: null },
    ] })
    expect(d.warnings).toEqual([
      'Taken away: campaign "Search A" tracking template. The setting of the level above (ad group, campaign, account) applies instead, if there is one; tracking that rests on it (sales tracking, analytics tags) can stop for these clicks.',
      'Google says a tracking template change can take 24–48 hours to reach the ads that serve.',
      'No own final URL any more: keyword [moto jacket] ("Group A"). Their clicks go to the ad\'s final URL.',
    ])
    expect(d.summary).toBe('Google Ads URLs and tracking: change 1 campaign, 1 ad group, 1 keyword, 1 ad.')
  })

  it('Google\'s rules checked first, every problem at once', () => {
    const d = urlsChangeDraft(C, { items: [
      { level: 'campaign', id: '21', trackingTemplate: 'track.example/?u={lpurl}', finalUrlSuffix: '?utm=1', customParameters: [{ key: 'my_key', value: 'v' }, ...Array.from({ length: 8 }, (_, i) => ({ key: `k${i}`, value: 'v' }))] },
      { level: 'ad', id: '51~701', finalUrl: 'https://shop.example/x' },
      { level: 'ad-group', id: '51', finalUrlSuffix: 'a={lpurl}' },
    ] }, live)
    const text = (d as { refusal: string }).refusal
    expect(text).toMatch(/^Not queued — the URLs break Google's rules/)
    for (const part of ['must start with http://, https:// or {lpurl}', 'cannot begin with "?" or "&"', '9 custom parameters (Google allows 8', 'name "my_key" must be 1 to 16 letters and digits', 'an ad\'s final URLs are changed with edit-google-rsa', 'cannot hold {lpurl} or {ignore} tags']) {
      expect(text).toContain(part)
    }
  })

  it('a negative keyword has no URLs; the same value is skipped, and nothing left is refused', () => {
    expect(urlsChangeDraft(C, { items: [{ level: 'keyword', id: '51~601', finalUrl: 'https://shop.example/x' }] }, { ...live, keywords: [kw({ negative: true })] })).toEqual({ refusal: 'Keyword 51~601 is a negative keyword: it has no URLs.' })
    expect(urlsChangeDraft(C, { items: [{ level: 'campaign', id: '21', customParameters: [{ key: 'src', value: 'a' }] }] }, live)).toEqual({ refusal: 'Nothing to change: campaign "Search A": the custom parameters are already so.' })
  })
})

// ── replace-google-keywords ─────────────────────────────────────────────────────────────────────────────────────────

describe('keywordReplaceDraft — a new text, match type or ad group: added anew, the old one removed', () => {
  const campaign: LiveCampaign = { campaignId: '21', name: 'Search A', status: 'ENABLED', servingStatus: null, primaryStatus: null, type: 'SEARCH', subType: null, bidding: 'MANUAL_CPC', start: null, end: null, shopping: null, budget: null }
  const kw = (id: string, text: string, matchType: 'EXACT' | 'PHRASE' | 'BROAD', over: Partial<LiveKeywordUrls> = {}): LiveKeywordUrls => {
    const [adGroupId, criterionId] = id.split('~')
    return { id, adGroupId, criterionId, adGroupName: '', adGroupStatus: 'ENABLED', campaignId: '21', campaignName: 'Search A', campaignStatus: 'ENABLED', text, matchType, negative: false, status: 'ENABLED', cpcBidCents: null, effectiveCpcBidCents: 40, finalUrls: [], finalMobileUrls: [], urls: NO_URLS, ...over }
  }
  const live: KeywordReplaceLiveState = {
    campaigns: [campaign],
    adGroups: [{ adGroupId: '51', name: 'Group A', status: 'ENABLED', type: 'SEARCH_STANDARD', cpcBidCents: 40 }, { adGroupId: '52', name: 'Group B', status: 'ENABLED', type: 'SEARCH_STANDARD', cpcBidCents: 60 }],
    keywords: [kw('51~601', 'moto jacket', 'EXACT', { cpcBidCents: 35, finalUrls: ['https://shop.example/k'], urls: { ...NO_URLS, finalUrlSuffix: 'k=1' } }), kw('51~602', 'leather jacket', 'PHRASE'), kw('52~603', 'gloves', 'EXACT')],
    keywordMatchType: null,
  }

  it('EXACT → PHRASE in place: the removal first, then the new keyword with the old max CPC, status, URLs and tracking; SPENDS MONEY (can serve, wider)', () => {
    const d = keywordReplaceDraft(C, 'EUR', { campaignId: '21', keywords: [{ keywordId: '51~601', matchType: 'PHRASE' }] }, live)
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([
      { adGroupCriterionOperation: { remove: `${C}/adGroupCriteria/51~601` } },
      { adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/51`, status: 'ENABLED', keyword: { text: 'moto jacket', matchType: 'PHRASE' }, cpcBidMicros: '350000', finalUrls: ['https://shop.example/k'], finalUrlSuffix: 'k=1' } } },
    ])
    expect(d.spendsMoney).toEqual([
      'Adds 1 keyword that can show ads at once (each in place of a removed one): ENABLED, in enabled ad groups of the enabled campaign "Search A" — [moto jacket] → "moto jacket".',
      '1 replacement has a wider match type, so it matches more searches: [moto jacket] → "moto jacket".',
    ])
    expect(d.after).toEqual({ campaignId: '21', replaced: [{ from: { keywordId: '51~601', adGroupId: '51', text: 'moto jacket', matchType: 'EXACT' }, to: { keywordId: 'new:1', adGroupId: '51', text: 'moto jacket', matchType: 'PHRASE' }, status: 'ENABLED', bidCents: 35 }] })
    const ran = keywordReplaceRecordAfterRun(d.after as never, [{}, { adGroupCriterionResult: { resourceName: `${C}/adGroupCriteria/51~777` } }])
    expect(ran.replaced[0].to.keywordId).toBe('51~777')
  })

  it('moved into an ad group with a higher default max CPC: the raise is said (SPENDS MONEY)', () => {
    const d = keywordReplaceDraft(C, 'EUR', { campaignId: '21', keywords: [{ keywordId: '51~602', toAdGroupId: '52' }] }, live)
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations[1]).toEqual({ adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/52`, status: 'ENABLED', keyword: { text: 'leather jacket', matchType: 'PHRASE' } } } })
    expect(d.spendsMoney.join(' ')).toContain('Raises the max CPC of 1 keyword: "leather jacket" → "leather jacket" ("Group B") EUR 0.40 → EUR 0.60')
  })

  it('refused: the same keyword, a keyword the ad group holds, BROAD without allowBroad, a negative', () => {
    expect(keywordReplaceDraft(C, 'EUR', { campaignId: '21', keywords: [{ keywordId: '51~601', text: 'Moto Jacket' }] }, live)).toEqual({ refusal: expect.stringContaining('would stay the same keyword') })
    expect(keywordReplaceDraft(C, 'EUR', { campaignId: '21', keywords: [{ keywordId: '51~601', text: 'leather jacket', matchType: 'PHRASE' }] }, live)).toEqual({ refusal: expect.stringContaining('already holds "leather jacket"') })
    expect(keywordReplaceDraft(C, 'EUR', { campaignId: '21', keywords: [{ keywordId: '51~601', matchType: 'BROAD' }] }, live)).toEqual({ refusal: expect.stringContaining('BROAD only with allowBroad') })
    expect(keywordReplaceDraft(C, 'EUR', { campaignId: '21', keywords: [{ keywordId: '51~601', matchType: 'PHRASE' }] }, { ...live, keywords: [kw('51~601', 'x', 'EXACT', { negative: true })] })).toEqual({ refusal: expect.stringContaining('or a negative keyword') })
  })

  it('a keyword may take the place of one the same request removes (removals go first)', () => {
    const d = keywordReplaceDraft(C, 'EUR', { campaignId: '21', keywords: [{ keywordId: '51~601', text: 'leather jacket', matchType: 'PHRASE' }, { keywordId: '51~602', text: 'jacket sale' }] }, live)
    expect('refusal' in d).toBe(false)
  })
})

// ── edit-google-assets ──────────────────────────────────────────────────────────────────────────────────────────────

describe('assetEditDraft — sitelinks, callouts and snippets in place, or replaced in one campaign', () => {
  const live: AssetEditLiveState = {
    assets: [
      { assetId: '9', type: 'SITELINK', source: 'ADVERTISER', name: null, finalUrls: ['https://shop.example/s'], finalMobileUrls: [], linkText: 'Sale', description1: 'Up to 30% off', description2: 'This week only' },
      { assetId: '10', type: 'CALLOUT', source: 'AUTOMATICALLY_CREATED', name: null, finalUrls: [], finalMobileUrls: [], calloutText: 'Fast shipping' },
      { assetId: '11', type: 'STRUCTURED_SNIPPET', source: 'ADVERTISER', name: null, finalUrls: [], finalMobileUrls: [], header: 'Tipi', values: ['Giacche', 'Guanti', 'Caschi'] },
    ],
    links: [
      { assetId: '9', level: 'campaign', fieldType: 'SITELINK', status: 'ENABLED', campaignId: '21', campaignName: 'Search A', campaignStatus: 'ENABLED' },
      { assetId: '9', level: 'account', fieldType: 'SITELINK', status: 'ENABLED' },
      { assetId: '10', level: 'campaign', fieldType: 'CALLOUT', status: 'PAUSED', campaignId: '21', campaignName: 'Search A', campaignStatus: 'ENABLED' },
      { assetId: '11', level: 'campaign', fieldType: 'STRUCTURED_SNIPPET', status: 'ENABLED', campaignId: '21', campaignName: 'Search A', campaignStatus: 'ENABLED' },
    ],
  }

  it('in place: one AssetOperation update, the mask names the inner fields; the preview names every place it is linked', () => {
    const d = assetEditDraft(C, { assets: [{ assetId: '9', linkText: 'Winter Sale', description1: null, description2: null }] }, live)
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([{ assetOperation: { update: { resourceName: `${C}/assets/9`, sitelinkAsset: { linkText: 'Winter Sale' } }, updateMask: 'sitelink_asset.link_text,sitelink_asset.description1,sitelink_asset.description2' } }])
    expect(d.warnings).toContain('Asset 9 ("Sale") is linked in 2 places — campaign "Search A", the account: the edit changes it in all of them. To change it in one campaign only, ask with onlyInCampaignId.')
    expect(d.before).toEqual({ mode: 'edit', assets: [{ assetId: '9', type: 'SITELINK', linkText: 'Sale', description1: 'Up to 30% off', description2: 'This week only' }] })
    expect(d.after).toEqual({ mode: 'edit', assets: [{ assetId: '9', type: 'SITELINK', linkText: 'Winter Sale', description1: null, description2: null }] })
  })

  it('a snippet header in its own language (Italian, read from the header it has); the record keeps the language for undo', () => {
    expect(snippetLanguageOf('Tipi')).toBe('it')
    const d = assetEditDraft(C, { assets: [{ assetId: '11', header: 'Models', values: ['Giacche', 'Guanti', 'Stivali'] }] }, live)
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([{ assetOperation: { update: { resourceName: `${C}/assets/11`, structuredSnippetAsset: { header: 'Modelli', values: ['Giacche', 'Guanti', 'Stivali'] } }, updateMask: 'structured_snippet_asset.header,structured_snippet_asset.values' } }])
    expect(d.before).toEqual({ mode: 'edit', assets: [{ assetId: '11', type: 'STRUCTURED_SNIPPET', header: 'Tipi', language: 'it', values: ['Giacche', 'Guanti', 'Caschi'] }] })
  })

  it('an asset Google made cannot be changed in place; replaced in one campaign: new asset, its link (the old link\'s status), the old link off', () => {
    expect(assetEditDraft(C, { assets: [{ assetId: '10', calloutText: 'Free shipping' }] }, live)).toEqual({ refusal: expect.stringContaining('Google does not let it be changed. Ask with onlyInCampaignId') })
    const d = assetEditDraft(C, { assets: [{ assetId: '10', calloutText: 'Free shipping' }], onlyInCampaignId: '21' }, live)
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([
      { assetOperation: { create: { resourceName: `${C}/assets/-1`, calloutAsset: { calloutText: 'Free shipping' } } } },
      { campaignAssetOperation: { create: { campaign: `${C}/campaigns/21`, asset: `${C}/assets/-1`, fieldType: 'CALLOUT', status: 'PAUSED' } } },
      { campaignAssetOperation: { remove: `${C}/campaignAssets/21~10~CALLOUT` } },
    ])
    expect(d.after).toEqual({ mode: 'replace', campaignId: '21', replaced: [{ oldAssetId: '10', newAssetId: 'op:0', fieldType: 'CALLOUT', status: 'PAUSED', text: 'Free shipping' }] })
    expect(assetEditRecordAfterRun(d.after as never, [{ assetResult: { resourceName: `${C}/assets/321` } }, {}, {}])).toMatchObject({ replaced: [{ newAssetId: '321' }] })
  })

  it('refused before Google is asked: a field of another kind, too long, one description line, a campaign it is not in', () => {
    expect(assetEditDraft(C, { assets: [{ assetId: '9', calloutText: 'x' }] }, live)).toEqual({ refusal: expect.stringContaining('is a sitelink: calloutText is not one of its fields') })
    const d = assetEditDraft(C, { assets: [{ assetId: '9', linkText: 'A link text far too long for Google', description1: null }] }, live)
    expect((d as { refusal: string }).refusal).toContain('is 35 characters long: Google allows 25')
    expect((d as { refusal: string }).refusal).toContain('both description lines or neither')
    expect(assetEditDraft(C, { assets: [{ assetId: '9', linkText: 'Sale B' }], onlyInCampaignId: '22' }, live)).toEqual({ refusal: expect.stringContaining('is not linked to campaign 22') })
  })
})

// ── renames and ad rotation (existing builders) ─────────────────────────────────────────────────────────────────────

describe('renames and ad rotation', () => {
  const budget = (budgetId: string, name: string | null, shared: boolean) => ({ budgetId, name, amountCents: 1000, shared, deliveryMethod: 'STANDARD', period: 'DAILY', usedBy: 0, campaigns: [] })

  it('a shared budget renamed and its amount changed: ONE update (mask amount_micros,name); the record keeps the names', () => {
    const d = budgetChangeDraft(C, 'EUR', { amounts: [{ budgetId: '14', budgetCents: 900 }], renames: [{ budgetId: '14', name: 'Shared B' }] }, { budgets: [budget('14', 'Shared A', true)], campaigns: [] })
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([{ campaignBudgetOperation: { update: { resourceName: `${C}/campaignBudgets/14`, amountMicros: '9000000', name: 'Shared B' }, updateMask: 'amount_micros,name' } }])
    expect(d.after).toMatchObject({ names: [{ budgetId: '14', name: 'Shared B' }] })
    expect(budgetRecordAfterRun(d.after as never, [{}]).names).toEqual([{ budgetId: '14', name: 'Shared B' }])
  })

  it('a negative keyword list renamed, keywords added in the same request', () => {
    const d = listChangeDraft(C, { listId: '31', name: 'Brand terms', addKeywords: [{ text: 'cheap', matchType: 'PHRASE' }] }, { lists: [{ listId: '31', name: 'Brand', keywordCount: 0, campaigns: [], keywords: [] }], campaigns: [] })
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations[0]).toEqual({ sharedSetOperation: { update: { resourceName: `${C}/sharedSets/31`, name: 'Brand terms' }, updateMask: 'name' } })
    expect(d.summary).toBe('Google Ads negative keyword list "Brand": rename it to "Brand terms", add 1 negative keyword.')
  })

  it('an ad group\'s name and ad rotation in one update', () => {
    const campaign: LiveCampaign = { campaignId: '21', name: 'Search A', status: 'PAUSED', servingStatus: null, primaryStatus: null, type: 'SEARCH', subType: null, bidding: 'MANUAL_CPC', start: null, end: null, shopping: null, budget: null }
    const d = adGroupChangeDraft(C, 'EUR', { campaignId: '21', change: [{ adGroupId: '51', name: 'Group Z', adRotation: 'OPTIMIZE' }] }, { campaigns: [campaign], adGroups: [{ adGroupId: '51', name: 'Group A', status: 'ENABLED', type: 'SEARCH_STANDARD', cpcBidCents: 40 }], rotations: { 51: 'ROTATE_FOREVER' } })
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([{ adGroupOperation: { update: { resourceName: `${C}/adGroups/51`, name: 'Group Z', adRotationMode: 'OPTIMIZE' }, updateMask: 'name,ad_rotation_mode' } }])
    expect(d.before).toEqual({ campaignId: '21', adGroups: [{ adGroupId: '51', name: 'Group A', adRotation: 'ROTATE_FOREVER' }] })
  })
})
