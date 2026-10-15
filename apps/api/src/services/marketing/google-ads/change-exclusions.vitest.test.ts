/**
 * Google Ads changes, G7 (2026-10-15) — exclusions and exclusion lists, built from a request and the live state (pure):
 * the exact Google operations, what narrows (a warning) and what widens (SPENDS MONEY), what is skipped, what is refused
 * before anything is sent, the record undo reads; and the live reads' queries and mappers.
 */
import { describe, expect, it } from 'vitest'
import { accountExclusionDraft, campaignExclusionDraft } from './change-exclusions.js'
import { createdExclusionListId, exclusionListDraft, type ExclusionListLiveState } from './change-exclusion-lists.js'
import type { LiveCampaign } from './live.js'
import {
  brandSuggestionsOf, exclusionKey, exclusionListItemsOf, exclusionListsOf, LIVE_ACCOUNT_EXCLUSIONS_QUERY, LIVE_AD_GROUP_BRAND_LIST_LINKS_QUERY,
  LIVE_BRAND_LIST_LINKS_QUERY, LIVE_PLACEMENT_LIST_LINKS_QUERY, liveAccountExclusionsOf, liveCampaignExclusionsOf, liveCampaignExclusionsQuery,
  liveExclusionListItemsQuery, liveExclusionSetsQuery, normalizeExclusion, type LiveAccountExclusions, type LiveExclusionList,
} from './live-exclusions.js'

const C = 'customers/1234567890'
const campaign = (campaignId: string, name: string, status: string, type = 'SEARCH'): LiveCampaign => ({
  campaignId, name, status, servingStatus: null, primaryStatus: null, type, subType: null, bidding: 'MANUAL_CPC', start: null, end: null, shopping: null, budget: null,
})
const ACCOUNT: LiveAccountExclusions = {
  items: [
    { kind: 'placement', value: 'example.com', criterionId: '901', name: null },
    { kind: 'ip-block', value: '192.0.2.0/24', criterionId: '902', name: null },
  ],
  keywordList: null,
  placementLists: [],
  other: [],
}

describe('normalizeExclusion and exclusionKey', () => {
  it('takes YouTube links, app category resource names and lower-case labels; refuses what Google refuses', () => {
    expect(normalizeExclusion({ kind: 'youtube-video', value: 'https://www.youtube.com/watch?v=abcdefghijk&t=3' })).toEqual({ kind: 'youtube-video', value: 'abcdefghijk' })
    expect(normalizeExclusion({ kind: 'youtube-channel', value: 'https://www.youtube.com/channel/UCabc_def-1' })).toEqual({ kind: 'youtube-channel', value: 'UCabc_def-1' })
    expect(normalizeExclusion({ kind: 'app-category', value: 'mobileAppCategoryConstants/60008' })).toEqual({ kind: 'app-category', value: '60008' })
    expect(normalizeExclusion({ kind: 'content-label', value: 'tragedy' })).toEqual({ kind: 'content-label', value: 'TRAGEDY' })
    expect(normalizeExclusion({ kind: 'ip-block', value: '2001:DB8::/48' })).toEqual({ kind: 'ip-block', value: '2001:db8::/48' })
    expect(normalizeExclusion({ kind: 'mobile-app', value: '2-com.example.app' })).toEqual({ kind: 'mobile-app', value: '2-com.example.app' })
    expect(normalizeExclusion({ kind: 'placement', value: 'adsenseformobileapps.com' })).toMatchObject({ problem: expect.stringMatching(/adsenseformobileapps/) })
    expect(normalizeExclusion({ kind: 'placement', value: `x${'a'.repeat(250)}.com` })).toMatchObject({ problem: expect.stringMatching(/250/) })
    expect(normalizeExclusion({ kind: 'ip-block', value: '192.0.2.1/33' })).toMatchObject({ problem: expect.stringMatching(/0 to 32/) })
    expect(normalizeExclusion({ kind: 'ip-block', value: 'not-an-ip' })).toMatchObject({ problem: expect.any(String) })
    expect(normalizeExclusion({ kind: 'mobile-app', value: 'com.example.app' })).toMatchObject({ problem: expect.stringMatching(/2-<package name>/) })
    expect(normalizeExclusion({ kind: 'content-label', value: 'SCARY' })).toMatchObject({ problem: expect.stringMatching(/TRAGEDY/) })
  })

  it('the same website, address or label however it is written', () => {
    expect(exclusionKey({ kind: 'placement', value: 'https://Example.com/' })).toBe(exclusionKey({ kind: 'placement', value: 'example.com' }))
    expect(exclusionKey({ kind: 'ip-block', value: '192.0.2.1/32' })).toBe(exclusionKey({ kind: 'ip-block', value: '192.0.2.1' }))
    expect(exclusionKey({ kind: 'ip-block', value: '192.0.2.0/24' })).not.toBe(exclusionKey({ kind: 'ip-block', value: '192.0.2.0' }))
    expect(exclusionKey({ kind: 'youtube-video', value: 'abcdefghijk' })).not.toBe(exclusionKey({ kind: 'youtube-video', value: 'ABCDEFGHIJK' }))
  })
})

describe('accountExclusionDraft', () => {
  it('adds and removes in one request; adding narrows (a warning), removing SPENDS MONEY; the record is by value', () => {
    const d = accountExclusionDraft(C, {
      add: [{ kind: 'content-label', value: 'tragedy' }, { kind: 'placement', value: 'https://example.com/' }, { kind: 'youtube-video', value: 'abcdefghijk' }],
      remove: [{ kind: 'ip-block', value: '192.0.2.0/24' }],
    }, { account: ACCOUNT, campaigns: [campaign('21', 'Shop A', 'ENABLED')] })
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([
      { customerNegativeCriterionOperation: { create: { contentLabel: { type: 'TRAGEDY' } } } },
      { customerNegativeCriterionOperation: { create: { youtubeVideo: { videoId: 'abcdefghijk' } } } },
      { customerNegativeCriterionOperation: { remove: `${C}/customerNegativeCriteria/902` } },
    ])
    expect(d.skipped).toEqual(['website https://example.com/ is already excluded for the account.'])
    expect(d.warnings).toEqual(['Excludes 1 content label, 1 YouTube video for the account: every campaign of the account no longer shows ads there (fewer impressions there, and fewer sales from them).'])
    expect(d.spendsMoney).toEqual(['Removes 1 exclusion (IP address 192.0.2.0/24): every campaign of the account can show ads there again.'])
    expect(d.summary).toBe('Google Ads account exclusions: exclude 1 content label, 1 YouTube video, remove 1 exclusion.')
    expect(d.changes['content label TRAGEDY']).toEqual({ from: 'can show ads', to: 'excluded' })
    expect(d.changes['IP address 192.0.2.0/24']).toEqual({ from: 'excluded', to: 'can show ads' })
    expect(d.after).toEqual({ added: [{ kind: 'content-label', value: 'TRAGEDY' }, { kind: 'youtube-video', value: 'abcdefghijk' }], removed: [{ kind: 'ip-block', value: '192.0.2.0/24' }] })
    expect(d.before).toEqual({ removed: [{ kind: 'ip-block', value: '192.0.2.0/24' }] })
  })

  it('a removal says when no campaign is enabled; nothing to do, both ways, a bad value and too many IPs are refused', () => {
    const paused = accountExclusionDraft(C, { remove: [{ kind: 'placement', value: 'example.com' }] }, { account: ACCOUNT, campaigns: [campaign('21', 'Shop A', 'PAUSED')] })
    if ('refusal' in paused) throw new Error(paused.refusal)
    expect(paused.spendsMoney[0]).toMatch(/no campaign it reaches is enabled now: nothing spends until one is/)
    expect(accountExclusionDraft(C, { add: [{ kind: 'placement', value: 'example.com' }] }, { account: ACCOUNT, campaigns: [] }))
      .toEqual({ refusal: 'Nothing to change: website example.com is already excluded for the account.' })
    expect(accountExclusionDraft(C, { add: [{ kind: 'placement', value: 'a.example' }], remove: [{ kind: 'placement', value: 'A.example' }] }, { account: ACCOUNT, campaigns: [] }))
      .toEqual({ refusal: 'website a.example is both added and removed.' })
    expect(accountExclusionDraft(C, {}, { account: ACCOUNT, campaigns: [] })).toEqual({ refusal: 'Say what to change: add or remove exclusions.' })
    expect(accountExclusionDraft(C, { add: [{ kind: 'ip-block', value: '999.1.1.1' }] }, { account: ACCOUNT, campaigns: [] })).toMatchObject({ refusal: expect.stringMatching(/^Not queued: IP address/) })
    const full: LiveAccountExclusions = { ...ACCOUNT, items: Array.from({ length: 500 }, (_, i) => ({ kind: 'ip-block' as const, value: `10.0.${Math.floor(i / 250)}.${i % 250}`, criterionId: String(1000 + i), name: null })) }
    expect(accountExclusionDraft(C, { add: [{ kind: 'ip-block', value: '192.0.2.9' }] }, { account: full, campaigns: [] })).toMatchObject({ refusal: expect.stringMatching(/501 IP addresses: Google allows 500/) })
  })
})

describe('campaignExclusionDraft', () => {
  it('excludes for one campaign (negative criteria), removes by its criterion; the record names the campaign', () => {
    const d = campaignExclusionDraft(C, '21', { add: [{ kind: 'mobile-app', value: '1-476943146' }, { kind: 'app-category', value: '60008' }], remove: [{ kind: 'youtube-channel', value: 'UCabc' }] }, {
      campaign: campaign('21', 'Shop A', 'ENABLED'),
      exclusions: { items: [{ kind: 'youtube-channel', value: 'UCabc', criterionId: '77', name: null }], brandLists: [], targeted: 0 },
    })
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([
      { campaignCriterionOperation: { create: { campaign: `${C}/campaigns/21`, negative: true, mobileApplication: { appId: '1-476943146' } } } },
      { campaignCriterionOperation: { create: { campaign: `${C}/campaigns/21`, negative: true, mobileAppCategory: { mobileAppCategoryConstant: 'mobileAppCategoryConstants/60008' } } } },
      { campaignCriterionOperation: { remove: `${C}/campaignCriteria/21~77` } },
    ])
    expect(d.spendsMoney).toEqual(['Removes 1 exclusion (YouTube channel UCabc): "Shop A" can show ads there again.'])
    expect(d.after).toEqual({ campaignId: '21', added: [{ kind: 'mobile-app', value: '1-476943146' }, { kind: 'app-category', value: '60008' }], removed: [{ kind: 'youtube-channel', value: 'UCabc' }] })
    expect(d.summary).toBe('Google Ads exclusions of "Shop A": exclude 1 app, 1 app category, remove 1 exclusion.')
  })

  it('a campaign that is not there is refused', () => {
    expect(campaignExclusionDraft(C, '29', { add: [{ kind: 'content-label', value: 'TRAGEDY' }] }, { campaign: null, exclusions: { items: [], brandLists: [], targeted: 0 } }))
      .toMatchObject({ refusal: expect.stringMatching(/^Campaign 29 is not in this account/) })
  })
})

// ── lists ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const PLACEMENTS: LiveExclusionList = {
  listId: '41', name: 'Bad sites', type: 'NEGATIVE_PLACEMENTS', itemCount: 1,
  campaigns: [{ campaignId: '22', name: 'Display B', status: 'ENABLED', type: 'DISPLAY', mode: 'exclude', criterionId: null }],
  adGroups: [], account: null,
  items: [{ kind: 'placement', value: 'spam.example', criterionId: '501', name: null }],
}
const BRANDS: LiveExclusionList = {
  listId: '42', name: 'Rivals', type: 'BRANDS', itemCount: 1,
  campaigns: [
    { campaignId: '21', name: 'Search A', status: 'ENABLED', type: 'SEARCH', mode: 'exclude', criterionId: '601' },
    { campaignId: '23', name: 'Search C', status: 'PAUSED', type: 'SEARCH', mode: 'include', criterionId: '602' },
  ],
  adGroups: [], account: null,
  brands: [{ criterionId: '701', entityId: 'b-1', name: 'Brand A', status: 'ENABLED', url: null }],
}
const KEYWORDS: LiveExclusionList = {
  listId: '43', name: 'Account negatives', type: 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS', itemCount: 1,
  campaigns: [], adGroups: [], account: { criterionId: '903' },
  keywords: [{ criterionId: '801', text: 'free', matchType: 'BROAD' }],
}
const STATE = (lists: LiveExclusionList[], account: LiveAccountExclusions | null = null): ExclusionListLiveState => ({
  lists, account,
  campaigns: [campaign('21', 'Search A', 'ENABLED'), campaign('22', 'Display B', 'ENABLED', 'DISPLAY'), campaign('23', 'Search C', 'PAUSED'), campaign('24', 'Shopping D', 'ENABLED', 'SHOPPING')],
})

describe('exclusionListDraft', () => {
  it('a new placement list put on the account in one request: the list first (temporary id), then its items and the account link', () => {
    const d = exclusionListDraft(C, {
      create: { name: 'Kids sites', type: 'NEGATIVE_PLACEMENTS' },
      addItems: [{ kind: 'placement', value: 'kids.example' }, { kind: 'youtube-video', value: 'abcdefghijk' }],
      attachToAccount: true,
    }, STATE([PLACEMENTS], { ...ACCOUNT }))
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([
      { sharedSetOperation: { create: { resourceName: `${C}/sharedSets/-1`, name: 'Kids sites', type: 'NEGATIVE_PLACEMENTS' } } },
      { sharedCriterionOperation: { create: { sharedSet: `${C}/sharedSets/-1`, placement: { url: 'kids.example' } } } },
      { sharedCriterionOperation: { create: { sharedSet: `${C}/sharedSets/-1`, youtubeVideo: { videoId: 'abcdefghijk' } } } },
      { customerNegativeCriterionOperation: { create: { placementList: { sharedSet: `${C}/sharedSets/-1` } } } },
    ])
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings).toEqual(['Puts "Kids sites" on the account: no ads show on what it excludes.'])
    expect(d.after).toMatchObject({ listId: 'new', type: 'NEGATIVE_PLACEMENTS', created: true, addedItems: [{ kind: 'placement', value: 'kids.example' }, { kind: 'youtube-video', value: 'abcdefghijk' }], accountAttached: true })
    expect(createdExclusionListId([{ sharedSetResult: { resourceName: `${C}/sharedSets/49` } }], { create: { name: 'x', type: 'NEGATIVE_PLACEMENTS' } })).toBe('49')
  })

  it('a placement list: taking items out and off a campaign SPENDS MONEY; a Shopping campaign is refused; no content labels in a list', () => {
    const d = exclusionListDraft(C, { listId: '41', removeItems: [{ kind: 'placement', value: 'https://spam.example' }], detachCampaignIds: ['22'] }, STATE([PLACEMENTS]))
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([
      { sharedCriterionOperation: { remove: `${C}/sharedCriteria/41~501` } },
      { campaignSharedSetOperation: { remove: `${C}/campaignSharedSets/22~41` } },
    ])
    expect(d.spendsMoney).toEqual(['Takes "Bad sites" off 1 campaign: they can show ads on what it excludes again.'])
    expect(d.after).toMatchObject({ removedItems: [{ kind: 'placement', value: 'spam.example' }], detached: [{ campaignId: '22', mode: 'exclude' }] })
    const kept = exclusionListDraft(C, { listId: '41', removeItems: [{ kind: 'placement', value: 'spam.example' }] }, STATE([PLACEMENTS]))
    if ('refusal' in kept) throw new Error(kept.refusal)
    expect(kept.spendsMoney).toEqual(['Removes 1 exclusion (website spam.example) from "Bad sites", which 1 campaign uses: ads can show there again.'])
    expect(exclusionListDraft(C, { listId: '41', attachCampaigns: [{ campaignId: '24' }] }, STATE([PLACEMENTS]))).toMatchObject({ refusal: expect.stringMatching(/Shopping campaign: Google takes only negative keyword lists/) })
    expect(exclusionListDraft(C, { listId: '41', addItems: [{ kind: 'content-label', value: 'TRAGEDY' }] }, STATE([PLACEMENTS]))).toMatchObject({ refusal: expect.stringMatching(/not a content-label/) })
    expect(exclusionListDraft(C, { listId: '41', addKeywords: [{ text: 'x', matchType: 'EXACT' }] }, STATE([PLACEMENTS]))).toMatchObject({ refusal: expect.stringMatching(/holds no keywords/) })
  })

  it('a brand list: an exclusion and an inclusion; brands removed from an exclusion and added to an inclusion SPEND MONEY', () => {
    const d = exclusionListDraft(C, { listId: '42', addBrands: [{ entityId: 'b-2', name: 'Brand B' }], removeBrands: ['b-1'], attachCampaigns: [{ campaignId: '22', mode: 'include' }] }, STATE([BRANDS]))
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([
      { sharedCriterionOperation: { create: { sharedSet: `${C}/sharedSets/42`, brand: { entityId: 'b-2' } } } },
      { sharedCriterionOperation: { remove: `${C}/sharedCriteria/42~701` } },
      { campaignCriterionOperation: { create: { campaign: `${C}/campaigns/22`, negative: false, brandList: { sharedSet: `${C}/sharedSets/42` } } } },
    ])
    expect(d.spendsMoney).toEqual([
      'Removes 1 brand (Brand A (b-1)) from "Rivals", which 1 campaign excludes: they can show ads on searches about those brands again.',
      'Adds 1 brand (Brand B (b-2)) to "Rivals", which 1 campaign or ad group keeps to: they can show ads on searches about more brands (no campaign it reaches is enabled now: nothing spends until one is).',
    ])
    expect(d.warnings).toContain('Adds 1 brand to "Rivals", which 1 campaign excludes: they stop showing ads on searches about those brands.')
    expect(d.after).toMatchObject({ addedBrands: [{ entityId: 'b-2', name: 'Brand B' }], removedBrands: [{ entityId: 'b-1', name: 'Brand A' }], attached: [{ campaignId: '22', mode: 'include' }] })
    const off = exclusionListDraft(C, { listId: '42', detachCampaignIds: ['21', '23'] }, STATE([BRANDS]))
    if ('refusal' in off) throw new Error(off.refusal)
    expect(off.operations).toEqual([
      { campaignCriterionOperation: { remove: `${C}/campaignCriteria/21~601` } },
      { campaignCriterionOperation: { remove: `${C}/campaignCriteria/23~602` } },
    ])
    expect(off.spendsMoney).toHaveLength(2)
    expect(exclusionListDraft(C, { listId: '42', attachCampaigns: [{ campaignId: '21', mode: 'include' }] }, STATE([BRANDS]))).toMatchObject({ refusal: expect.stringMatching(/as an exclusion: detach it first/) })
    expect(exclusionListDraft(C, { listId: '42', attachToAccount: true }, STATE([BRANDS]))).toEqual({ refusal: 'A brand list goes on campaigns (attachCampaigns), not on the account.' })
  })

  it('the account negative keyword list: keywords out SPEND MONEY; one per account; never on campaigns', () => {
    const accountNow: LiveAccountExclusions = { ...ACCOUNT, keywordList: { criterionId: '903', listId: '43' } }
    const d = exclusionListDraft(C, { listId: '43', removeKeywords: [{ text: 'FREE', matchType: 'BROAD' }], addKeywords: [{ text: 'cheap', matchType: 'PHRASE' }] }, STATE([KEYWORDS], accountNow))
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([
      { sharedCriterionOperation: { create: { sharedSet: `${C}/sharedSets/43`, keyword: { text: 'cheap', matchType: 'PHRASE' } } } },
      { sharedCriterionOperation: { remove: `${C}/sharedCriteria/43~801` } },
    ])
    expect(d.spendsMoney).toEqual(['Removes 1 negative keyword (free) from the account\'s negative keyword list "Account negatives": every campaign can show ads on those searches again.'])
    const second = exclusionListDraft(C, { create: { name: 'Other', type: 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS' }, attachToAccount: true }, STATE([KEYWORDS], accountNow))
    expect(second).toMatchObject({ refusal: expect.stringMatching(/already uses "Account negatives" \(43\) as its negative keyword list, and Google allows one/) })
    expect(exclusionListDraft(C, { listId: '43', attachCampaigns: [{ campaignId: '21' }] }, STATE([KEYWORDS], accountNow))).toMatchObject({ refusal: expect.stringMatching(/goes on the whole account/) })
    const detach = exclusionListDraft(C, { listId: '43', detachFromAccount: true }, STATE([KEYWORDS], accountNow))
    if ('refusal' in detach) throw new Error(detach.refusal)
    expect(detach.operations).toEqual([{ customerNegativeCriterionOperation: { remove: `${C}/customerNegativeCriteria/903` } }])
    expect(detach.spendsMoney).toEqual(['Takes "Account negatives" off the account: its 1 negative keyword no longer blocks searches in any campaign.'])
    // A placement list on the whole account: the sentence says so.
    const onAccount = exclusionListDraft(C, { listId: '41', removeItems: [{ kind: 'placement', value: 'spam.example' }] }, STATE([{ ...PLACEMENTS, campaigns: [], account: { criterionId: '904' } }]))
    if ('refusal' in onAccount) throw new Error(onAccount.refusal)
    expect(onAccount.spendsMoney).toEqual(['Removes 1 exclusion (website spam.example) from "Bad sites", which is on the whole account: ads can show there again.'])
    expect(exclusionListDraft(C, { create: { name: 'New negatives', type: 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS' } }, STATE([]))).toMatchObject({ warnings: ['The new list is on no campaign and not on the account: it changes nothing until it is put somewhere (attachToAccount).'] })
  })

  it('a brand inclusion on a campaign that already keeps to another brand list (on it or an ad group) SPENDS MONEY; the other lists stand', () => {
    const OWN: LiveExclusionList = {
      listId: '44', name: 'Own brands', type: 'BRANDS', itemCount: 1,
      campaigns: [{ campaignId: '22', name: 'Display B', status: 'ENABLED', type: 'DISPLAY', mode: 'include', criterionId: '603' }],
      adGroups: [], account: null,
    }
    const ask = { listId: '42', attachCampaigns: [{ campaignId: '22', mode: 'include' as const }] }
    const d = exclusionListDraft(C, ask, STATE([BRANDS, OWN]))
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([{ campaignCriterionOperation: { create: { campaign: `${C}/campaigns/22`, negative: false, brandList: { sharedSet: `${C}/sharedSets/42` } } } }])
    expect(d.spendsMoney).toEqual(['Adds brands "Display B" may show ads for: it already keeps to "Own brands" (44) on the campaign, and Google may take the brands of both, so it can show ads on searches about the brands of "Rivals" too.'])
    expect(d.warnings).toEqual(['On a Search campaign Google takes a brand inclusion only with broad match (AI Max) on (its check says so).'])
    expect(d.stands).toMatchObject({ otherInclusions: ['22:44@campaign'] })
    // Another list kept to by one of its ad groups: the same; an exclusion elsewhere is not an inclusion.
    const onAdGroup: LiveExclusionList = { ...OWN, campaigns: [{ ...OWN.campaigns[0], mode: 'exclude' }], adGroups: [{ adGroupId: '51', name: 'G', status: 'ENABLED', campaignId: '22', campaignStatus: 'PAUSED' }] }
    const g = exclusionListDraft(C, ask, STATE([BRANDS, onAdGroup]))
    if ('refusal' in g) throw new Error(g.refusal)
    expect(g.spendsMoney).toEqual(['Adds brands "Display B" may show ads for: it already keeps to "Own brands" (44) on its ad group "G", and Google may take the brands of both, so it can show ads on searches about the brands of "Rivals" too.'])
    expect(g.stands).toMatchObject({ otherInclusions: ['22:44@51'] })
    // No other inclusion: it narrows (a warning) and nothing spends.
    const alone = exclusionListDraft(C, ask, STATE([BRANDS]))
    if ('refusal' in alone) throw new Error(alone.refusal)
    expect(alone.spendsMoney).toEqual([])
    expect(alone.warnings[0]).toBe('Keeps 1 campaign to the brands of "Rivals" (brand inclusion): their broad matching shows ads only on searches about those brands.')
    expect(alone.stands).toMatchObject({ otherInclusions: ['22:'] })
  })

  it('a brand list kept to by ad groups: a brand added SPENDS MONEY (noted when nothing it reaches is enabled); a brand removed narrows them', () => {
    const ON_AD_GROUPS: LiveExclusionList = {
      ...BRANDS, campaigns: [],
      adGroups: [{ adGroupId: '51', name: 'G', status: 'ENABLED', campaignId: '21', campaignStatus: 'ENABLED' }, { adGroupId: '52', name: 'H', status: 'PAUSED', campaignId: '21', campaignStatus: 'ENABLED' }],
    }
    const add = { listId: '42', addBrands: [{ entityId: 'b-2', name: 'Brand B' }] }
    const d = exclusionListDraft(C, add, STATE([ON_AD_GROUPS]))
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.spendsMoney).toEqual(['Adds 1 brand (Brand B (b-2)) to "Rivals", which 2 campaigns or ad groups keep to: they can show ads on searches about more brands.'])
    const pausedOnly = exclusionListDraft(C, add, STATE([{ ...ON_AD_GROUPS, adGroups: [{ ...ON_AD_GROUPS.adGroups[0], campaignStatus: 'PAUSED' }] }]))
    if ('refusal' in pausedOnly) throw new Error(pausedOnly.refusal)
    expect(pausedOnly.spendsMoney).toEqual(['Adds 1 brand (Brand B (b-2)) to "Rivals", which 1 campaign or ad group keeps to: they can show ads on searches about more brands (no campaign it reaches is enabled now: nothing spends until one is).'])
    const removed = exclusionListDraft(C, { listId: '42', removeBrands: ['b-1'] }, STATE([ON_AD_GROUPS]))
    if ('refusal' in removed) throw new Error(removed.refusal)
    expect(removed.spendsMoney).toEqual([])
    expect(removed.warnings).toEqual(['Removes 1 brand from "Rivals", which 2 campaigns or ad groups keep to: fewer searches show their ads.'])
  })

  it('a brand name given with its id is shown as given, not as Google\'s; a list still on the account does not widen when it leaves a campaign', () => {
    const given = exclusionListDraft(C, { listId: '42', addBrands: [{ entityId: 'b-3', name: 'Brand C', nameAsGiven: true }] }, STATE([BRANDS]))
    if ('refusal' in given) throw new Error(given.refusal)
    expect(given.changes['"Rivals" brands added']).toEqual({ from: 1, to: 'b-3 (name as given, not checked by Google: Brand C)' })
    expect(given.spendsMoney).toEqual(['Adds 1 brand (b-3 (name as given, not checked by Google: Brand C)) to "Rivals", which 1 campaign or ad group keeps to: they can show ads on searches about more brands (no campaign it reaches is enabled now: nothing spends until one is).'])
    expect(given.after).toMatchObject({ addedBrands: [{ entityId: 'b-3', name: 'Brand C', nameAsGiven: true }] })
    // Already in the list: Google's own name is shown.
    expect(exclusionListDraft(C, { listId: '42', addBrands: [{ entityId: 'b-1', name: 'Wrong', nameAsGiven: true }] }, STATE([BRANDS])))
      .toEqual({ refusal: 'Nothing to change: Brand A (b-1) is already in "Rivals".' })

    const both: LiveExclusionList = { ...PLACEMENTS, account: { criterionId: '904' } }
    const off = exclusionListDraft(C, { listId: '41', detachCampaignIds: ['22'] }, STATE([both]))
    if ('refusal' in off) throw new Error(off.refusal)
    expect(off.operations).toEqual([{ campaignSharedSetOperation: { remove: `${C}/campaignSharedSets/22~41` } }])
    expect(off.spendsMoney).toEqual([])
    expect(off.warnings).toEqual(['Takes "Bad sites" off 1 campaign: the list stays on the whole account, so they still exclude what it holds.'])
    // Off the account in the same request: both widen.
    const offBoth = exclusionListDraft(C, { listId: '41', detachCampaignIds: ['22'], detachFromAccount: true }, STATE([both]))
    if ('refusal' in offBoth) throw new Error(offBoth.refusal)
    expect(offBoth.spendsMoney).toEqual([
      'Takes "Bad sites" off 1 campaign: they can show ads on what it excludes again.',
      'Takes "Bad sites" off the account: every campaign can show ads on what it excludes again.',
    ])
  })

  it('names are unique per type; a rename is one update with the name mask; a new list on nothing says so', () => {
    expect(exclusionListDraft(C, { create: { name: 'bad SITES', type: 'NEGATIVE_PLACEMENTS' } }, STATE([PLACEMENTS]))).toMatchObject({ refusal: expect.stringMatching(/named "bad SITES" already exists/) })
    const sameNameOtherType = exclusionListDraft(C, { create: { name: 'Bad sites', type: 'BRANDS' } }, STATE([PLACEMENTS]))
    if ('refusal' in sameNameOtherType) throw new Error(sameNameOtherType.refusal)
    expect(sameNameOtherType.warnings).toEqual(['The new list is on no campaign and not on the account: it changes nothing until it is put somewhere (attachCampaigns).'])
    const rename = exclusionListDraft(C, { listId: '41', name: 'Blocked sites' }, STATE([PLACEMENTS]))
    if ('refusal' in rename) throw new Error(rename.refusal)
    expect(rename.operations).toEqual([{ sharedSetOperation: { update: { resourceName: `${C}/sharedSets/41`, name: 'Blocked sites' }, updateMask: 'name' } }])
    expect(rename.after).toMatchObject({ renamed: { from: 'Bad sites', to: 'Blocked sites' } })
    expect(exclusionListDraft(C, { listId: '99', name: 'x' }, STATE([PLACEMENTS]))).toMatchObject({ refusal: expect.stringMatching(/^Exclusion list 99 is not in this account/) })
  })
})

// ── live reads ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('live-exclusions queries and mappers', () => {
  it('every query selects what it filters on (Google refuses some filters on a field not selected)', () => {
    const where = (q: string) => [...q.slice(q.indexOf(' WHERE ')).matchAll(/([a-z_]+\.[a-z_.]+)\s*(?:=|!=|IN)/g)].map((m) => m[1])
    for (const q of [liveCampaignExclusionsQuery('21'), liveExclusionSetsQuery(), LIVE_PLACEMENT_LIST_LINKS_QUERY, LIVE_BRAND_LIST_LINKS_QUERY, LIVE_AD_GROUP_BRAND_LIST_LINKS_QUERY, liveExclusionListItemsQuery('41')]) {
      const select = q.slice(0, q.indexOf(' FROM '))
      for (const field of where(q)) expect(select, `${field} in ${q}`).toContain(field)
    }
    expect(LIVE_ACCOUNT_EXCLUSIONS_QUERY).not.toContain('WHERE')
    // SharedCriterion has no content label and no IP block (v25): Google refuses an unknown field in SELECT.
    expect(liveExclusionListItemsQuery('41')).not.toMatch(/shared_criterion\.(content_label|ip_block)/)
    expect(LIVE_ACCOUNT_EXCLUSIONS_QUERY).toContain('customer_negative_criterion.ip_block.ip_address')
    expect(() => liveCampaignExclusionsQuery('21 OR 1=1')).toThrow(/not a Google id/)
  })

  it('maps the account, a campaign, a list and its users', () => {
    const account = liveAccountExclusionsOf([
      { customerNegativeCriterion: { id: '901', type: 'PLACEMENT', placement: { url: 'example.com' } } },
      { customerNegativeCriterion: { id: '902', type: 'NEGATIVE_KEYWORD_LIST', negativeKeywordList: { sharedSet: `${C}/sharedSets/43` } } },
      { customerNegativeCriterion: { id: '904', type: 'PLACEMENT_LIST', placementList: { sharedSet: `${C}/sharedSets/41` } } },
      { customerNegativeCriterion: { id: '905', type: 'MOBILE_APP_CATEGORY', mobileAppCategory: { mobileAppCategoryConstant: 'mobileAppCategoryConstants/60008' } } },
    ])
    expect(account).toEqual({
      items: [{ kind: 'app-category', value: '60008', name: null, criterionId: '905' }, { kind: 'placement', value: 'example.com', name: null, criterionId: '901' }],
      keywordList: { criterionId: '902', listId: '43' },
      placementLists: [{ criterionId: '904', listId: '41' }],
      other: [],
    })
    expect(liveCampaignExclusionsOf([
      { campaignCriterion: { criterionId: '61', negative: true, contentLabel: { type: 'TRAGEDY' } } },
      { campaignCriterion: { criterionId: '62', negative: false, placement: { url: 'target.example' } } },
      { campaignCriterion: { criterionId: '63', negative: true, brandList: { sharedSet: `${C}/sharedSets/42` } } },
    ])).toEqual({ items: [{ kind: 'content-label', value: 'TRAGEDY', name: null, criterionId: '61' }], brandLists: [{ criterionId: '63', listId: '42', mode: 'exclude' }], targeted: 1 })
    const items = exclusionListItemsOf([{ sharedCriterion: { criterionId: '701', brand: { entityId: 'b-1', displayName: 'Brand A', status: 'ENABLED' } } }])
    const lists = exclusionListsOf(
      [{ sharedSet: { id: '42', name: 'Rivals', type: 'BRANDS', memberCount: '1' } }, { sharedSet: { id: '41', name: 'Bad sites', type: 'NEGATIVE_PLACEMENTS', memberCount: '0' } }],
      {
        account: { ...account },
        placementLinks: [{ campaign: { id: '22', name: 'Display B', status: 'ENABLED', advertisingChannelType: 'DISPLAY' }, sharedSet: { id: '41' } }],
        brandLinks: [{ campaign: { id: '23', name: 'Search C', status: 'PAUSED', advertisingChannelType: 'SEARCH' }, campaignCriterion: { criterionId: '602', negative: false, brandList: { sharedSet: `${C}/sharedSets/42` } } }],
        adGroupBrandLinks: [{ campaign: { id: '23', status: 'PAUSED' }, adGroup: { id: '51', name: 'G', status: 'ENABLED' }, adGroupCriterion: { brandList: { sharedSet: `${C}/sharedSets/42` } } }],
      },
      '42', items,
    )
    expect(lists.map((l) => [l.listId, l.type, l.campaigns.map((c) => `${c.campaignId}:${c.mode}`), l.account, l.adGroups.length])).toEqual([
      ['42', 'BRANDS', ['23:include'], null, 1],
      ['41', 'NEGATIVE_PLACEMENTS', ['22:exclude'], { criterionId: '904' }, 0],
    ])
    expect(lists[0].brands).toEqual([{ criterionId: '701', entityId: 'b-1', name: 'Brand A', status: 'ENABLED', url: null }])
    expect(brandSuggestionsOf({ brands: [{ id: '/m/0abc', name: 'Brand A', state: 'ENABLED', urls: ['https://brand-a.example'] }, { name: 'no id' }] }))
      .toEqual([{ entityId: '/m/0abc', name: 'Brand A', state: 'ENABLED', urls: ['https://brand-a.example'] }])
  })
})
