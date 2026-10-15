/**
 * Google Ads changes (2026-10-15) — ad groups, keywords and negative keywords, built from a request and the live state
 * (pure): the exact Google operations (temporary ids, snake_case update masks, a Shopping ad group with its product ad),
 * what spends money (enabling, raises), what is skipped, what is refused before anything is sent, and the records undo
 * reads (with Google's ids after a run).
 */
import { describe, expect, it } from 'vitest'
import { adGroupChangeDraft, adGroupRecordAfterRun, type AdGroupChangeRecord, type AdGroupLiveState } from './change-ad-groups.js'
import {
  keywordChangeDraft, keywordRecordAfterRun, negativeChangeDraft, negativeRecordAfterRun,
  type KeywordChangeRecord, type KeywordLiveState, type NegativeChangeRecord, type NegativeLiveState,
} from './change-keywords.js'
import { liveAdGroupOf, liveKeywordOf, type LiveAdGroup, type LiveKeyword } from './live-keywords.js'
import type { LiveCampaign } from './live.js'

const C = 'customers/1234567890'
const campaign = (campaignId: string, name: string, status: string, type: string, extra: Partial<LiveCampaign> = {}): LiveCampaign => ({
  campaignId, name, status, servingStatus: null, primaryStatus: null, type, subType: null, bidding: 'MANUAL_CPC', start: null, end: null, shopping: null, budget: null, ...extra,
})
const SEARCH_PAUSED = campaign('21', 'Search A', 'PAUSED', 'SEARCH')
const SEARCH_ON = campaign('22', 'Search B', 'ENABLED', 'SEARCH')
const SHOP_ON = campaign('23', 'Shop C', 'ENABLED', 'SHOPPING')
const DISPLAY = campaign('24', 'Display D', 'PAUSED', 'DISPLAY')
const CAMPAIGNS = [SEARCH_PAUSED, SEARCH_ON, SHOP_ON, DISPLAY]
const group = (adGroupId: string, name: string, status: string, cpcBidCents: number | null, type = 'SEARCH_STANDARD'): LiveAdGroup => ({ adGroupId, name, status, type, cpcBidCents })
const keyword = (adGroupId: string, criterionId: string, text: string, matchType: 'EXACT' | 'PHRASE' | 'BROAD', cpcBidCents: number | null, extra: Partial<LiveKeyword> = {}): LiveKeyword => ({
  adGroupId, criterionId, keywordId: `${adGroupId}~${criterionId}`, text, matchType, negative: false, status: 'ENABLED', cpcBidCents, effectiveCpcBidCents: cpcBidCents, ...extra,
})

describe('live rows of ad groups and keywords', () => {
  it('a keyword without a bid of its own uses its ad group\'s default; its id is adGroupId~criterionId', () => {
    const k = liveKeywordOf({ adGroup: { id: '51' }, adGroupCriterion: { criterionId: '601', status: 'PAUSED', keyword: { text: 'Test term', matchType: 'PHRASE' }, effectiveCpcBidMicros: '400000' } })
    expect(k).toEqual({ adGroupId: '51', criterionId: '601', keywordId: '51~601', text: 'Test term', matchType: 'PHRASE', negative: false, status: 'PAUSED', cpcBidCents: null, effectiveCpcBidCents: 40 })
    expect(liveKeywordOf({ adGroup: { id: '51' }, adGroupCriterion: { criterionId: '602', negative: true, keyword: { text: 'free', matchType: 'EXACT' }, cpcBidMicros: '0' } })).toMatchObject({ negative: true, cpcBidCents: null })
    expect(liveAdGroupOf({ adGroup: { id: '51', name: 'Group A', status: 'ENABLED', type: 'SEARCH_STANDARD', cpcBidMicros: '300000' } }))
      .toEqual({ adGroupId: '51', name: 'Group A', status: 'ENABLED', type: 'SEARCH_STANDARD', cpcBidCents: 30 })
  })
})

describe('adGroupChangeDraft', () => {
  const live = (campaignId: string, adGroups: LiveAdGroup[]): AdGroupLiveState => ({ campaigns: CAMPAIGNS, adGroups: adGroups.map((g) => ({ ...g })) })

  it('a paused Search campaign: the new ad group is SEARCH_STANDARD and ENABLED (nothing serves), nothing spends', () => {
    const d = adGroupChangeDraft(C, 'EUR', { campaignId: '21', create: [{ name: ' Group B ', defaultBidCents: 40 }] }, live('21', [group('51', 'Group A', 'ENABLED', 30)]))
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([
      { adGroupOperation: { create: { resourceName: `${C}/adGroups/-1`, campaign: `${C}/campaigns/21`, name: 'Group B', type: 'SEARCH_STANDARD', status: 'ENABLED', cpcBidMicros: '400000' } } },
    ])
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings).toEqual(['New ad groups are made ENABLED: the campaign "Search A" is paused, so they show no ads until it is enabled.'])
    expect(d.changes['new ad group "Group B"']).toEqual({ from: '(none)', to: 'ENABLED, default max CPC EUR 0.40' })
    expect(d.after).toEqual({ campaignId: '21', adGroups: [], created: [{ adGroupId: 'new:0', name: 'Group B', type: 'SEARCH_STANDARD', status: 'ENABLED', defaultBidCents: 40 }] })
  })

  it('an enabled Shopping campaign: each new ad group PAUSED with its product ad in the same request; Google\'s ids after the run', () => {
    const d = adGroupChangeDraft(C, 'EUR', { campaignId: '23', create: [{ name: 'Group X', defaultBidCents: 25 }, { name: 'Group Y', defaultBidCents: 25 }] }, live('23', []))
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([
      { adGroupOperation: { create: { resourceName: `${C}/adGroups/-1`, campaign: `${C}/campaigns/23`, name: 'Group X', type: 'SHOPPING_PRODUCT_ADS', status: 'PAUSED', cpcBidMicros: '250000' } } },
      { adGroupAdOperation: { create: { adGroup: `${C}/adGroups/-1`, status: 'ENABLED', ad: { shoppingProductAd: {} } } } },
      { adGroupOperation: { create: { resourceName: `${C}/adGroups/-2`, campaign: `${C}/campaigns/23`, name: 'Group Y', type: 'SHOPPING_PRODUCT_ADS', status: 'PAUSED', cpcBidMicros: '250000' } } },
      { adGroupAdOperation: { create: { adGroup: `${C}/adGroups/-2`, status: 'ENABLED', ad: { shoppingProductAd: {} } } } },
    ])
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings).toEqual([
      'New ad groups are made PAUSED because the campaign "Shop C" is enabled: they show no ads until a person enables them (or ask again with enable: true).',
      'Each new Shopping ad group gets its product ad in this request, but no product groups: those are set in a separate change.',
    ])
    const after = adGroupRecordAfterRun(d.after as AdGroupChangeRecord, [
      { adGroupResult: { resourceName: `${C}/adGroups/71` } }, { adGroupAdResult: { resourceName: `${C}/adGroupAds/71~801` } },
      { adGroupResult: { resourceName: `${C}/adGroups/72` } }, { adGroupAdResult: { resourceName: `${C}/adGroupAds/72~802` } },
    ])
    expect(after.created).toEqual([
      { adGroupId: '71', adId: '801', name: 'Group X', type: 'SHOPPING_PRODUCT_ADS', status: 'PAUSED', defaultBidCents: 25 },
      { adGroupId: '72', adId: '802', name: 'Group Y', type: 'SHOPPING_PRODUCT_ADS', status: 'PAUSED', defaultBidCents: 25 },
    ])
  })

  it('enable: true in an enabled campaign makes it ENABLED and says SPENDS MONEY', () => {
    const d = adGroupChangeDraft(C, 'EUR', { campaignId: '22', create: [{ name: 'Group B', defaultBidCents: 40 }], enable: true }, live('22', []))
    if ('refusal' in d) throw new Error(d.refusal)
    expect((d.operations[0] as { adGroupOperation: { create: { status: string } } }).adGroupOperation.create.status).toBe('ENABLED')
    expect(d.spendsMoney).toEqual(['The new ad group "Group B" is made ENABLED in the enabled campaign "Search B": it can show ads (default max CPC EUR 0.40).'])
    // A Shopping ad group serves only once its product groups exist: the sentence says so.
    const shop = adGroupChangeDraft(C, 'EUR', { campaignId: '23', create: [{ name: 'Group X', defaultBidCents: 25 }], enable: true }, live('23', []))
    if ('refusal' in shop) throw new Error(shop.refusal)
    expect(shop.spendsMoney).toEqual(['The new ad group "Group X" is made ENABLED in the enabled campaign "Shop C": it can show ads once its product groups exist (default max CPC EUR 0.25).'])
  })

  it('renames go before creates (a name a rename frees can be taken); stands holds every name and only the named groups in full', () => {
    const d = adGroupChangeDraft(C, 'EUR', { campaignId: '21', create: [{ name: 'Group A', defaultBidCents: 30 }], change: [{ adGroupId: '51', name: 'Group A old' }] },
      live('21', [group('52', 'Group B', 'ENABLED', 30), group('51', 'Group A', 'ENABLED', 30)]))
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([
      { adGroupOperation: { update: { resourceName: `${C}/adGroups/51`, name: 'Group A old' }, updateMask: 'name' } },
      { adGroupOperation: { create: { resourceName: `${C}/adGroups/-1`, campaign: `${C}/campaigns/21`, name: 'Group A', type: 'SEARCH_STANDARD', status: 'ENABLED', cpcBidMicros: '300000' } } },
    ])
    expect((d.after as AdGroupChangeRecord).created![0].adGroupId).toBe('new:1')
    expect(d.stands).toEqual({
      campaign: { campaignId: '21', status: 'PAUSED', type: 'SEARCH', subType: null, bidding: 'MANUAL_CPC' },
      names: ['group a', 'group b'],
      adGroups: [{ adGroupId: '51', name: 'Group A', status: 'ENABLED', type: 'SEARCH_STANDARD', cpcBidCents: 30 }],
    })
  })

  it('a rename and a default bid raise: one update with both fields in the mask; the raise spends money; records for undo', () => {
    const d = adGroupChangeDraft(C, 'EUR', { campaignId: '22', change: [{ adGroupId: '51', name: 'Group Z', defaultBidCents: 45 }, { adGroupId: '52', defaultBidCents: 20 }] },
      live('22', [group('51', 'Group A', 'ENABLED', 30), group('52', 'Group B', 'ENABLED', 25)]))
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([
      { adGroupOperation: { update: { resourceName: `${C}/adGroups/51`, name: 'Group Z', cpcBidMicros: '450000' }, updateMask: 'name,cpc_bid_micros' } },
      { adGroupOperation: { update: { resourceName: `${C}/adGroups/52`, cpcBidMicros: '200000' }, updateMask: 'cpc_bid_micros' } },
    ])
    expect(d.spendsMoney).toEqual(['Raises the default max CPC of 1 ad group: "Group A" EUR 0.30 → EUR 0.45.'])
    expect(d.before).toEqual({ campaignId: '22', adGroups: [{ adGroupId: '51', name: 'Group A', defaultBidCents: 30 }, { adGroupId: '52', defaultBidCents: 25 }] })
    expect(d.after).toEqual({ campaignId: '22', adGroups: [{ adGroupId: '51', name: 'Group Z', defaultBidCents: 45 }, { adGroupId: '52', defaultBidCents: 20 }] })
    expect(d.summary).toBe('Google Ads ad groups in "Search B": rename 1 ad group; change the default max CPC of 2 ad groups.')
  })

  it('a raise in a paused campaign says nothing spends yet; a bid strategy other than Manual CPC is named', () => {
    const paused = adGroupChangeDraft(C, 'EUR', { campaignId: '21', change: [{ adGroupId: '51', defaultBidCents: 45 }] }, live('21', [group('51', 'Group A', 'ENABLED', 30)]))
    if ('refusal' in paused) throw new Error(paused.refusal)
    expect(paused.spendsMoney).toEqual(['Raises the default max CPC of 1 ad group: "Group A" EUR 0.30 → EUR 0.45 (the campaign is paused: nothing spends until it is enabled).'])
    const smart = adGroupChangeDraft(C, 'EUR', { campaignId: '25', change: [{ adGroupId: '51', defaultBidCents: 20 }] },
      { campaigns: [campaign('25', 'Search E', 'ENABLED', 'SEARCH', { bidding: 'TARGET_SPEND' })], adGroups: [group('51', 'Group A', 'ENABLED', 30)] })
    if ('refusal' in smart) throw new Error(smart.refusal)
    expect(smart.warnings).toEqual(['Campaign "Search E" bids with TARGET_SPEND, not Manual CPC: Google may not use the ad groups\' default max CPCs.'])
  })

  it('refused before anything is sent: duplicate names (Google refuses them), unknown ids, other campaign types', () => {
    const two = live('22', [group('51', 'Group A', 'ENABLED', 30), group('52', 'Group B', 'PAUSED', 30)])
    expect(adGroupChangeDraft(C, 'EUR', { campaignId: '22', create: [{ name: 'group a', defaultBidCents: 10 }] }, two)).toMatchObject({ refusal: expect.stringContaining('Google refuses duplicate ad group names') })
    expect(adGroupChangeDraft(C, 'EUR', { campaignId: '22', create: [{ name: 'New', defaultBidCents: 10 }, { name: 'NEW', defaultBidCents: 10 }] }, two)).toMatchObject({ refusal: expect.stringContaining('Two ad groups would be named') })
    expect(adGroupChangeDraft(C, 'EUR', { campaignId: '22', change: [{ adGroupId: '52', name: 'Group A' }] }, two)).toMatchObject({ refusal: expect.stringContaining('Two ad groups would be named "Group A"') })
    // A rename to the name another ad group holds is refused too.
    expect(adGroupChangeDraft(C, 'EUR', { campaignId: '22', change: [{ adGroupId: '51', name: 'Group B' }] }, two)).toMatchObject({ refusal: expect.stringContaining('duplicate') })
    expect(adGroupChangeDraft(C, 'EUR', { campaignId: '22', change: [{ adGroupId: '51', name: 'Group A' }] }, two)).toEqual({ refusal: 'Nothing to change: Ad group "Group A" already has that name.' })
    expect(adGroupChangeDraft(C, 'EUR', { campaignId: '22', change: [{ adGroupId: '99', defaultBidCents: 10 }] }, two)).toMatchObject({ refusal: expect.stringContaining('not in campaign "Search B"') })
    expect(adGroupChangeDraft(C, 'EUR', { campaignId: '22', create: [{ name: 'A\nB', defaultBidCents: 10 }] }, two)).toMatchObject({ refusal: expect.stringContaining('line break') })
    expect(adGroupChangeDraft(C, 'EUR', { campaignId: '24', create: [{ name: 'X', defaultBidCents: 10 }] }, live('24', []))).toMatchObject({ refusal: expect.stringContaining('only Search and Standard Shopping') })
    expect(adGroupChangeDraft(C, 'EUR', { campaignId: '99', create: [{ name: 'X', defaultBidCents: 10 }] }, live('99', []))).toMatchObject({ refusal: expect.stringContaining('not in this account') })
    expect(adGroupChangeDraft(C, 'EUR', { campaignId: '22' }, two)).toMatchObject({ refusal: expect.stringContaining('Say what to change') })
  })
})

describe('keywordChangeDraft', () => {
  const GROUPS = [group('51', 'Group A', 'ENABLED', 40), group('52', 'Group B', 'PAUSED', 30)]
  const KEYWORDS = [
    keyword('51', '601', 'test term', 'EXACT', 30),
    keyword('51', '602', 'other term', 'PHRASE', null, { effectiveCpcBidCents: 40 }),
    keyword('52', '603', 'third term', 'EXACT', 2, { status: 'PAUSED' }),
    keyword('51', '604', 'free', 'EXACT', null, { negative: true }),
  ]
  const live = (campaigns = CAMPAIGNS, extra: Partial<KeywordLiveState> = {}): KeywordLiveState => ({ campaigns, adGroups: GROUPS, keywords: KEYWORDS, ...extra })

  it('adds in an enabled campaign: PAUSED by default, exact operations, the one already there skipped, no money', () => {
    const d = keywordChangeDraft(C, 'EUR', { campaignId: '22', add: [
      { adGroupId: '51', text: 'new  term', matchType: 'EXACT', bidCents: 35 },
      { adGroupId: '51', text: 'another term', matchType: 'PHRASE' },
      { adGroupId: '51', text: 'Test Term', matchType: 'EXACT' },
    ] }, live())
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([
      { adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/51`, status: 'PAUSED', keyword: { text: 'new term', matchType: 'EXACT' }, cpcBidMicros: '350000' } } },
      { adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/51`, status: 'PAUSED', keyword: { text: 'another term', matchType: 'PHRASE' } } } },
    ])
    expect(d.skipped).toEqual(['[Test Term] is already in ad group "Group A".'])
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings[0]).toMatch(/made PAUSED because the campaign "Search B" is enabled/)
    expect(d.changes['add "another term" to "Group A"']).toEqual({ from: '(none)', to: 'PAUSED, max CPC its ad group\'s default EUR 0.40' })
    const after = keywordRecordAfterRun(d.after as KeywordChangeRecord, [
      { adGroupCriterionResult: { resourceName: `${C}/adGroupCriteria/51~701` } }, { adGroupCriterionResult: { resourceName: `${C}/adGroupCriteria/51~702` } },
    ])
    expect(after.added).toEqual([
      { keywordId: '51~701', adGroupId: '51', text: 'new term', matchType: 'EXACT', bidCents: 35, status: 'PAUSED' },
      { keywordId: '51~702', adGroupId: '51', text: 'another term', matchType: 'PHRASE', bidCents: null, status: 'PAUSED' },
    ])
  })

  it('enable: true in an enabled ad group of an enabled campaign SPENDS MONEY; BROAD needs allowBroad and is warned about', () => {
    expect(keywordChangeDraft(C, 'EUR', { campaignId: '22', add: [{ adGroupId: '51', text: 'wide', matchType: 'BROAD' }] }, live())).toMatchObject({ refusal: expect.stringContaining('BROAD only with allowBroad') })
    const d = keywordChangeDraft(C, 'EUR', { campaignId: '22', add: [{ adGroupId: '51', text: 'wide', matchType: 'BROAD' }], allowBroad: true, enable: true }, live())
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.spendsMoney).toEqual(['Adds 1 keyword that can show ads at once: ENABLED, in the enabled ad group "Group A" of the enabled campaign "Search B".'])
    expect(d.warnings).toContain('1 BROAD match keyword: it matches many more searches than EXACT or PHRASE (and can spend on them).')
  })

  it('bids by id: a raise SPENDS MONEY (from → to), a cut does not, null goes back to the ad group\'s default (mask, no value)', () => {
    const d = keywordChangeDraft(C, 'EUR', { campaignId: '22', bids: [{ keywordId: '51~601', bidCents: 45 }, { keywordId: '52~603', bidCents: 1 }, { keywordId: '51~602', bidCents: null }] }, live())
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([
      { adGroupCriterionOperation: { update: { resourceName: `${C}/adGroupCriteria/51~601`, cpcBidMicros: '450000' }, updateMask: 'cpc_bid_micros' } },
      { adGroupCriterionOperation: { update: { resourceName: `${C}/adGroupCriteria/52~603`, cpcBidMicros: '10000' }, updateMask: 'cpc_bid_micros' } },
    ])
    expect(d.skipped).toEqual(['1 keyword already has that max CPC.'])
    expect(d.spendsMoney).toEqual(['Raises the max CPC of 1 keyword: [test term] ("Group A") EUR 0.30 → EUR 0.45.'])
    expect(d.before).toEqual({ campaignId: '22', bids: [{ keywordId: '51~601', bidCents: 30 }, { keywordId: '52~603', bidCents: 2 }] })
    expect(d.totals).toMatchObject({ bidsRaised: 1, bidsLowered: 1 })
    const back = keywordChangeDraft(C, 'EUR', { campaignId: '22', bids: [{ keywordId: '51~601', bidCents: null }] }, live())
    if ('refusal' in back) throw new Error(back.refusal)
    expect(back.operations).toEqual([{ adGroupCriterionOperation: { update: { resourceName: `${C}/adGroupCriteria/51~601` }, updateMask: 'cpc_bid_micros' } }])
    // 30 own → the ad group's 40: a raise of the bid it uses.
    expect(back.spendsMoney).toEqual(['Raises the max CPC of 1 keyword: [test term] ("Group A") EUR 0.30 → EUR 0.40.'])
  })

  it('bulk by percent: of the bid each uses now (its own or its ad group\'s), whole cents, at least 1 cent; a paused campaign spends nothing yet', () => {
    const down = keywordChangeDraft(C, 'EUR', { campaignId: '21', bulk: { percent: -90 } }, live())
    if ('refusal' in down) throw new Error(down.refusal)
    // 30 → 3; 40 (the ad group's) → 4; 2 → 0.2 → the 1-cent floor. The negative keyword is never touched.
    expect(down.after).toEqual({ campaignId: '21', bids: [{ keywordId: '51~601', bidCents: 3 }, { keywordId: '51~602', bidCents: 4 }, { keywordId: '52~603', bidCents: 1 }] })
    expect(down.spendsMoney).toEqual([])
    const up = keywordChangeDraft(C, 'EUR', { campaignId: '21', bulk: { adGroupId: '51', matchType: 'PHRASE', percent: 10 } }, live())
    if ('refusal' in up) throw new Error(up.refusal)
    expect(up.after).toEqual({ campaignId: '21', bids: [{ keywordId: '51~602', bidCents: 44 }] })
    expect(up.spendsMoney).toEqual(['Raises the max CPC of 1 keyword: "other term" ("Group A") EUR 0.40 → EUR 0.44 (the campaign is paused: nothing spends until it is enabled).'])
    // Many raises: each from → to, and the whole picture (how much they go up together).
    const all = keywordChangeDraft(C, 'EUR', { campaignId: '22', bulk: { percent: 50 } }, live())
    if ('refusal' in all) throw new Error(all.refusal)
    expect(all.spendsMoney).toEqual([
      'Raises the max CPC of 3 keywords: [test term] ("Group A") EUR 0.30 → EUR 0.45; "other term" ("Group A") EUR 0.40 → EUR 0.60; [third term] ("Group B") EUR 0.02 → EUR 0.03 (2 of them can serve now: keyword and ad group enabled).',
      'In all, the max CPCs of 3 keywords go up by EUR 0.36 together (on average EUR 0.24 → EUR 0.36): each click on them can cost more.',
    ])
    const range = keywordChangeDraft(C, 'EUR', { campaignId: '21', bulk: { minBidCents: 25, maxBidCents: 35, bidCents: 20 }, bids: [{ keywordId: '52~603', bidCents: 5 }] }, live())
    if ('refusal' in range) throw new Error(range.refusal)
    expect(range.after).toEqual({ campaignId: '21', bids: [{ keywordId: '52~603', bidCents: 5 }, { keywordId: '51~601', bidCents: 20 }] })
  })

  it('more than 250 keywords in one request are refused; a Shopping campaign has no keywords', () => {
    const many = Array.from({ length: 251 }, (_, i) => keyword('51', String(1000 + i), `term ${i}`, 'EXACT', 30))
    expect(keywordChangeDraft(C, 'EUR', { campaignId: '22', bulk: { percent: -10 } }, { ...live(), keywords: many })).toMatchObject({ refusal: expect.stringContaining('at most 250 in one request') })
    expect(keywordChangeDraft(C, 'EUR', { campaignId: '23', bids: [{ keywordId: '51~601', bidCents: 10 }] }, live())).toMatchObject({ refusal: expect.stringContaining('Shopping campaign: it has no keywords') })
    expect(keywordChangeDraft(C, 'EUR', { campaignId: '22', bids: [{ keywordId: '51~604', bidCents: 10 }] }, live())).toMatchObject({ refusal: expect.stringContaining('or a negative') })
    expect(keywordChangeDraft(C, 'EUR', { campaignId: '22', add: [{ adGroupId: '51', text: 'a b c d e f g h i j k', matchType: 'EXACT' }] }, live())).toMatchObject({ refusal: expect.stringContaining('more than 10 words') })
    expect(keywordChangeDraft(C, 'EUR', { campaignId: '22', bulk: { percent: -10, bidCents: 5 } }, live())).toMatchObject({ refusal: expect.stringContaining('one of them') })
  })

  it('removeAdded removes only what the undone change added, and only while it is still as that change made it', () => {
    const made = { keywordId: '51~602', adGroupId: '51', text: 'other term', matchType: 'PHRASE' as const, bidCents: null, status: 'ENABLED' }
    const d = keywordChangeDraft(C, 'EUR', { campaignId: '22', removeAdded: ['51~602'] }, live(CAMPAIGNS, { addedByChange: [made] }))
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([{ adGroupCriterionOperation: { remove: `${C}/adGroupCriteria/51~602` } }])
    expect(d.before).toMatchObject({ removed: [{ keywordId: '51~602', adGroupId: '51', text: 'other term', matchType: 'PHRASE', bidCents: null, status: 'ENABLED' }] })
    expect(keywordChangeDraft(C, 'EUR', { campaignId: '22', removeAdded: ['51~601'] }, live(CAMPAIGNS, { addedByChange: [made] }))).toMatchObject({ refusal: expect.stringContaining('was not added by the change this undoes') })
    // Someone paused it and gave it a bid since: removing it would overwrite that — refused, saying what moved.
    expect(keywordChangeDraft(C, 'EUR', { campaignId: '22', removeAdded: ['51~602'] }, live(CAMPAIGNS, { addedByChange: [{ ...made, status: 'PAUSED', bidCents: 25 }] })))
      .toEqual({ refusal: 'Not removed: a keyword the undone change added moved since it ran — "other term" (51~602): status PAUSED → ENABLED, max CPC EUR 0.25 → its ad group\'s default EUR 0.40. Removing it would overwrite that later change.' })
  })

  it('an undo puts a keyword back with the status it had; an explicit ENABLED in an enabled campaign spends money', () => {
    const d = keywordChangeDraft(C, 'EUR', { campaignId: '22', add: [{ adGroupId: '51', text: 'kept paused', matchType: 'EXACT', status: 'PAUSED' }, { adGroupId: '51', text: 'kept on', matchType: 'EXACT', status: 'ENABLED' }] }, live())
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations.map((o) => (o as { adGroupCriterionOperation: { create: { status: string } } }).adGroupCriterionOperation.create.status)).toEqual(['PAUSED', 'ENABLED'])
    expect(d.spendsMoney).toEqual(['Adds 1 keyword that can show ads at once: ENABLED, in the enabled ad group "Group A" of the enabled campaign "Search B".'])
    expect(d.warnings).toEqual([])
    expect(d.summary).toBe('Google Ads keywords in "Search B": add 2 keywords (PAUSED and ENABLED).')
  })

  it('a campaign set to broad match for all keywords: adding needs allowBroad, and the preview says every new keyword acts as broad', () => {
    const ask = { campaignId: '22', add: [{ adGroupId: '51', text: 'new term', matchType: 'EXACT' as const }] }
    expect(keywordChangeDraft(C, 'EUR', ask, live(CAMPAIGNS, { keywordMatchType: 'BROAD' }))).toMatchObject({ refusal: expect.stringContaining('its keyword match type is BROAD') })
    const d = keywordChangeDraft(C, 'EUR', { ...ask, allowBroad: true }, live(CAMPAIGNS, { keywordMatchType: 'BROAD' }))
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.warnings[0]).toBe('Campaign "Search B" is set to broad match for all its keywords (keyword match type BROAD): every new keyword acts as broad match, whatever its own match type, and matches many more searches.')
    expect(d.stands).toMatchObject({ keywordMatchType: 'BROAD' })
  })

  it('the operations follow the keywords\' ids, never Google\'s row order', () => {
    const forward = keywordChangeDraft(C, 'EUR', { campaignId: '21', bulk: { percent: 10 } }, live())
    const backward = keywordChangeDraft(C, 'EUR', { campaignId: '21', bulk: { percent: 10 } }, { ...live(), keywords: [...KEYWORDS].reverse() })
    if ('refusal' in forward || 'refusal' in backward) throw new Error('refused')
    expect(backward.operations).toEqual(forward.operations)
    expect(backward.stands).toEqual(forward.stands)
  })
})

describe('negativeChangeDraft', () => {
  const live: NegativeLiveState = {
    campaigns: CAMPAIGNS,
    adGroups: [group('51', 'Group A', 'ENABLED', 40), group('61', 'Shop group', 'ENABLED', 25, 'SHOPPING_PRODUCT_ADS')],
    keywords: [keyword('51', '601', 'test term', 'EXACT', 30), keyword('51', '701', 'free', 'EXACT', null, { negative: true })],
    campaignNegatives: [{ criterionId: '901', text: 'cheap', matchType: 'PHRASE' }],
  }

  it('adds at the campaign and in an ad group, removes from both: exact operations, Google\'s ids after the run', () => {
    const d = negativeChangeDraft(C, { campaignId: '22', add: [{ text: 'used', matchType: 'PHRASE' }, { text: 'kids', matchType: 'EXACT', adGroupId: '51' }, { text: 'Cheap', matchType: 'PHRASE' }],
      remove: [{ text: 'cheap', matchType: 'EXACT' }, { text: 'free', matchType: 'EXACT', adGroupId: '51' }] }, live)
    // "cheap" PHRASE is both kept (already there: skipped) and asked to remove as EXACT (not there: skipped).
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([
      { campaignCriterionOperation: { create: { campaign: `${C}/campaigns/22`, negative: true, keyword: { text: 'used', matchType: 'PHRASE' } } } },
      { adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/51`, negative: true, keyword: { text: 'kids', matchType: 'EXACT' } } } },
      { adGroupCriterionOperation: { remove: `${C}/adGroupCriteria/51~701` } },
    ])
    expect(d.skipped).toEqual(['"Cheap" is already a negative keyword of campaign "Search B".', '[cheap] is not a negative keyword of campaign "Search B".'])
    expect(d.spendsMoney).toEqual(['Removes 1 negative keyword: more searches can show the ads of campaign "Search B".'])
    expect(d.warnings).toEqual([])
    const after = negativeRecordAfterRun(d.after as NegativeChangeRecord, [
      { campaignCriterionResult: { resourceName: `${C}/campaignCriteria/22~911` } }, { adGroupCriterionResult: { resourceName: `${C}/adGroupCriteria/51~712` } }, {},
    ])
    expect(after).toEqual({
      campaignId: '22',
      added: [{ adGroupId: null, text: 'used', matchType: 'PHRASE', criterionId: '911' }, { adGroupId: '51', text: 'kids', matchType: 'EXACT', criterionId: '712' }],
      removed: [{ adGroupId: '51', text: 'free', matchType: 'EXACT' }],
    })
    const off = negativeChangeDraft(C, { campaignId: '22', remove: [{ text: 'cheap', matchType: 'PHRASE' }] }, live)
    if ('refusal' in off) throw new Error(off.refusal)
    expect(off.operations).toEqual([{ campaignCriterionOperation: { remove: `${C}/campaignCriteria/22~901` } }])
    // A paused campaign: still named, with "nothing spends until it is enabled".
    const paused = negativeChangeDraft(C, { campaignId: '21', remove: [{ text: 'cheap', matchType: 'PHRASE' }] }, live)
    if ('refusal' in paused) throw new Error(paused.refusal)
    expect(paused.spendsMoney).toEqual(['Removes 1 negative keyword: more searches can show the ads of campaign "Search A" (the campaign is paused: nothing spends until it is enabled).'])
    // What it stands on: the negatives and the keywords of each place it touches.
    expect(off.stands).toEqual({
      campaign: { campaignId: '22', status: 'ENABLED', type: 'SEARCH' },
      negatives: [{ level: 'campaign', keys: ['PHRASE:cheap#901'] }],
      positives: [{ level: 'campaign', keys: ['51~601#EXACT:test term'] }],
    })
  })

  it('a negative that matches a keyword of the campaign is named; a Shopping campaign takes negatives too', () => {
    const d = negativeChangeDraft(C, { campaignId: '22', add: [{ text: 'Test Term', matchType: 'PHRASE' }] }, live)
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.warnings).toEqual(['A negative keyword can stop a keyword of the campaign from showing ads: "Test Term" blocks the keyword [test term] of ad group "Group A".'])
    const shop = negativeChangeDraft(C, { campaignId: '23', add: [{ text: 'repair', matchType: 'BROAD', adGroupId: '61' }] }, live)
    if ('refusal' in shop) throw new Error(shop.refusal)
    expect(shop.operations).toEqual([{ adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/61`, negative: true, keyword: { text: 'repair', matchType: 'BROAD' } } } }])
  })

  it('refused before anything is sent', () => {
    expect(negativeChangeDraft(C, { campaignId: '22' }, live)).toMatchObject({ refusal: expect.stringContaining('Say what to change') })
    expect(negativeChangeDraft(C, { campaignId: '22', add: [{ text: 'x', matchType: 'EXACT', adGroupId: '99' }] }, live)).toMatchObject({ refusal: expect.stringContaining('Ad group 99 is not in campaign') })
    expect(negativeChangeDraft(C, { campaignId: '22', add: [{ text: 'x', matchType: 'EXACT' }], remove: [{ text: 'X', matchType: 'EXACT' }] }, live)).toMatchObject({ refusal: expect.stringContaining('both added and removed') })
    expect(negativeChangeDraft(C, { campaignId: '24', add: [{ text: 'x', matchType: 'EXACT' }] }, live)).toMatchObject({ refusal: expect.stringContaining('only Search and Standard Shopping') })
    expect(negativeChangeDraft(C, { campaignId: '22', add: [{ text: 'cheap', matchType: 'PHRASE' }] }, live)).toMatchObject({ refusal: expect.stringContaining('Nothing to change') })
  })
})
