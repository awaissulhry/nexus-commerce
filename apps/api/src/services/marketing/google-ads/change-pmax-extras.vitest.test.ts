/**
 * Google Ads programme 2 G14b (2026-10-16) — what Performance Max gained: text guidelines (term exclusions, messaging
 * restrictions), page feeds (URL inclusions: the feed itself, and its link to a campaign with Google's text customization
 * rule), and an asset group's own tracking. What Google is sent, in which order, what is refused first, what is SPENDS
 * MONEY, and the records undo reads. Made-up ids and names only.
 */
import { describe, expect, it } from 'vitest'
import { pmaxBuildDraft, type PmaxBuildCampaign, type PmaxBuildLive } from './build-pmax.js'
import { campaignFactsOf, groupFactsOf, pmaxChangeDraft, textGuidelinesOfAsk, type PmaxChangeLive, type PmaxChangeRecord } from './change-pmax.js'
import { pageFeedDraft, pageFeedNow, pageFeedRecordAfterRun, pageUrlProblem, type PageFeedLive, type PageFeedRecord } from './change-page-feeds.js'
import type { GoogleChangeDraft } from './change-draft.js'
import type { PmaxAssetGroup, PmaxCampaignLive } from './live-pmax.js'
import type { GoogleMutateOperation } from './write-client.js'

const C = 'customers/1234567890'
const kinds = (ops: GoogleMutateOperation[]) => ops.map((o) => Object.keys(o)[0])
const of = (ops: GoogleMutateOperation[], kind: string) => ops.filter((o) => kind in o).map((o) => o[kind] as Record<string, any>)
const draft = (d: GoogleChangeDraft | { refusal: string }): GoogleChangeDraft => { if ('refusal' in d) throw new Error(d.refusal); return d }
const refused = (d: GoogleChangeDraft | { refusal: string }): string => ('refusal' in d ? d.refusal : `not refused: ${d.summary}`)

const liveGroup = (over: Partial<PmaxAssetGroup> = {}): PmaxAssetGroup => ({
  assetGroupId: '41', name: 'Group A', status: 'ENABLED', finalUrls: ['https://shop.example/'], finalMobileUrls: [], path1: null, path2: null,
  trackingTemplate: '{lpurl}?g=1', finalUrlSuffix: null, customParameters: [{ key: 'grp', value: 'a' }], adStrength: 'GOOD', primaryStatus: 'ELIGIBLE',
  assets: [], tree: [], signals: [], ...over,
})
const liveCampaign = (over: Partial<PmaxCampaignLive> = {}): PmaxCampaignLive => ({
  campaignId: '21', name: 'PMax A', status: 'ENABLED', type: 'PERFORMANCE_MAX', biddingType: 'MAXIMIZE_CONVERSION_VALUE', targetCpaCents: null, targetRoas: 4,
  budget: { budgetId: '11', amountCents: 2500, shared: false }, start: '2026-01-01 00:00:00', end: null,
  retail: { merchantId: '555', feedLabel: null, localInventory: false }, brandGuidelines: true, brandStyle: null, euPoliticalAds: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
  locationOption: 'PRESENCE', trackingTemplate: null, finalUrlSuffix: null, customParameters: [], ignoreBrandExclusionsForShopping: false,
  excludedParentAssetFieldTypes: [], excludedParentAssetSetTypes: [],
  textGuidelines: { termExclusions: ['cheap', 'free'], messagingRestrictions: ['Never mention prices'] },
  automation: { FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION: 'OPTED_OUT', TEXT_ASSET_AUTOMATION: 'OPTED_IN' },
  campaignAssets: [], criteria: [], assetGroups: [liveGroup()], pageFeeds: [{ assetSetId: '77', name: 'Pages A' }], notRead: [],
  ...over,
})
const changeLive = (over: Partial<PmaxChangeLive> = {}): PmaxChangeLive => ({
  campaign: liveCampaign(), campaignNames: [], assets: [], audiences: [], brandLists: [], images: {},
  pageFeeds: [{ assetSetId: '77', name: 'Pages A' }, { assetSetId: '78', name: 'Pages B' }], ...over,
})

describe('text guidelines (set-google-pmax)', () => {
  it('each list is written whole under its own mask; a term taken away is SPENDS MONEY in an enabled campaign; undo reads the lists it wrote', () => {
    const d = draft(pmaxChangeDraft(C, 'EUR', { campaignId: '21', textGuidelines: { termExclusions: ['cheap', ' Free ', 'discount'] } }, changeLive()))
    expect(d.operations).toEqual([{ campaignOperation: { update: { resourceName: `${C}/campaigns/21`, textGuidelines: { termExclusions: ['cheap', 'Free', 'discount'] } }, updateMask: 'text_guidelines.term_exclusions' } }])
    // "free" became "Free" (the same term without case): nothing was taken away.
    expect(d.spendsMoney).toEqual([])
    const after = d.after as PmaxChangeRecord
    expect(after.campaign.textGuidelines).toEqual({ termExclusions: ['cheap', 'Free', 'discount'] })
    expect((d.before as PmaxChangeRecord).campaign.textGuidelines).toEqual({ termExclusions: ['cheap', 'free'] })
    expect(campaignFactsOf(liveCampaign({ textGuidelines: { termExclusions: ['cheap', 'Free', 'discount'], messagingRestrictions: ['x'] } }), after.campaign)).toEqual(after.campaign)

    const off = draft(pmaxChangeDraft(C, 'EUR', { campaignId: '21', textGuidelines: { messagingRestrictions: [] } }, changeLive()))
    expect(off.operations).toEqual([{ campaignOperation: { update: { resourceName: `${C}/campaigns/21`, textGuidelines: { messagingRestrictions: [] } }, updateMask: 'text_guidelines.messaging_restrictions' } }])
    expect(off.spendsMoney.join(' ')).toMatch(/Takes away the messaging restriction "Never mention prices": Google's generated text may say what it did not/)
    const added = draft(pmaxChangeDraft(C, 'EUR', { campaignId: '21', textGuidelines: { messagingRestrictions: ['Never mention prices', 'No superlatives'] } }, changeLive()))
    expect(of(added.operations, 'campaignOperation')[0].update.textGuidelines).toEqual({
      messagingRestrictions: [
        { restrictionText: 'Never mention prices', restrictionType: 'RESTRICTION_BASED_EXCLUSION' },
        { restrictionText: 'No superlatives', restrictionType: 'RESTRICTION_BASED_EXCLUSION' },
      ],
    })
    expect(added.spendsMoney).toEqual([])
  })

  it('Google\'s limits are refused first; the same lists are nothing to change; with Google writing no text it is said', () => {
    const problems: string[] = []
    textGuidelinesOfAsk({ termExclusions: [...Array.from({ length: 26 }, (_, i) => `term ${i}`), 'x'.repeat(31)], messagingRestrictions: ['y'.repeat(301), ' '] }, 'g', problems)
    expect(problems.join(' | ')).toMatch(/has 31 characters \(Google allows 30\)/)
    expect(problems.join(' | ')).toMatch(/27 term exclusions \(Google takes at most 25\)/)
    expect(problems.join(' | ')).toMatch(/has 301 characters \(Google allows 300\)/)
    expect(problems.join(' | ')).toMatch(/a messaging restriction is empty/)
    expect(refused(pmaxChangeDraft(C, 'EUR', { campaignId: '21', textGuidelines: { termExclusions: ['free', 'cheap'] } }, changeLive()))).toMatch(/Nothing to change/)
    const none = draft(pmaxChangeDraft(C, 'EUR', { campaignId: '21', textGuidelines: { termExclusions: ['cheap'] } }, changeLive({
      campaign: liveCampaign({ pageFeeds: [], automation: { FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION: 'OPTED_OUT', TEXT_ASSET_AUTOMATION: 'OPTED_OUT' } }),
    })))
    expect(none.warnings.join(' ')).toMatch(/with text customization and final URL expansion off, Google writes none here/)
  })
})

describe('page feeds linked to a Performance Max campaign (set-google-pmax)', () => {
  it('a link goes after the campaign\'s automation update and is SPENDS MONEY where it serves; an unlink goes FIRST, so text customization may turn off in the same change', () => {
    const link = draft(pmaxChangeDraft(C, 'EUR', { campaignId: '21', pageFeeds: { link: ['78'] }, automation: { imageEnhancement: false } }, changeLive()))
    expect(kinds(link.operations)).toEqual(['campaignOperation', 'campaignAssetSetOperation'])
    expect(of(link.operations, 'campaignAssetSetOperation')).toEqual([{ create: { campaign: `${C}/campaigns/21`, assetSet: `${C}/assetSets/78` } }])
    expect(link.spendsMoney.join(' ')).toMatch(/Links the page feed "Pages B": Google may send people to its pages and write ads from them/)
    expect((link.after as PmaxChangeRecord).campaign.pageFeeds).toEqual(['77', '78'])
    expect((link.before as PmaxChangeRecord).campaign.pageFeeds).toEqual(['77'])

    const off = draft(pmaxChangeDraft(C, 'EUR', { campaignId: '21', pageFeeds: { unlink: ['77'] }, automation: { textCustomization: false } }, changeLive()))
    expect(kinds(off.operations)).toEqual(['campaignAssetSetOperation', 'campaignOperation'])
    expect(off.operations[0]).toEqual({ campaignAssetSetOperation: { remove: `${C}/campaignAssetSets/21~77` } })
    expect(off.spendsMoney).toEqual([])
    expect(campaignFactsOf(liveCampaign({ pageFeeds: [] }), { pageFeeds: [] })).toEqual({ pageFeeds: [] })
  })

  it('refuses text customization off while a feed stays linked, a link with it off, an unknown feed; a feed already linked is skipped', () => {
    expect(refused(pmaxChangeDraft(C, 'EUR', { campaignId: '21', automation: { textCustomization: false } }, changeLive()))).toMatch(/unlink its page feeds \(pageFeeds.unlink\) to turn text customization off/)
    const textOff = liveCampaign({ pageFeeds: [], automation: { FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION: 'OPTED_OUT', TEXT_ASSET_AUTOMATION: 'OPTED_OUT' } })
    expect(refused(pmaxChangeDraft(C, 'EUR', { campaignId: '21', pageFeeds: { link: ['78'] } }, changeLive({ campaign: textOff })))).toMatch(/turn text customization on \(automation.textCustomization: true\) to link one/)
    // Both in one change: Google's update comes first, the link after it.
    const both = draft(pmaxChangeDraft(C, 'EUR', { campaignId: '21', pageFeeds: { link: ['78'] }, automation: { textCustomization: true } }, changeLive({ campaign: textOff })))
    expect(kinds(both.operations)).toEqual(['campaignOperation', 'campaignAssetSetOperation'])
    expect(refused(pmaxChangeDraft(C, 'EUR', { campaignId: '21', pageFeeds: { link: ['79'] } }, changeLive()))).toMatch(/page feed 79 is not a page feed of this account/)
    expect(refused(pmaxChangeDraft(C, 'EUR', { campaignId: '21', pageFeeds: { link: ['77'] } }, changeLive()))).toMatch(/Nothing to change.*page feed "Pages A" is already linked/)
  })
})

describe('an asset group\'s own tracking (set-google-pmax)', () => {
  it('template, suffix and parameters under their masks; "" and [] take them away; G3\'s rules first; undo reads them back', () => {
    const d = draft(pmaxChangeDraft(C, 'EUR', { campaignId: '21', assetGroups: [{ assetGroupId: '41', trackingTemplate: '', finalUrlSuffix: 'src=pmax', customParameters: [{ key: 'grp', value: 'b' }, { key: 'aa', value: '1' }] }] }, changeLive()))
    expect(d.operations).toEqual([{ assetGroupOperation: { update: { resourceName: `${C}/assetGroups/41`, finalUrlSuffix: 'src=pmax', urlCustomParameters: [{ key: 'aa', value: '1' }, { key: 'grp', value: 'b' }] }, updateMask: 'tracking_url_template,final_url_suffix,url_custom_parameters' } }])
    expect(d.spendsMoney).toEqual([])
    const after = d.after as PmaxChangeRecord
    expect(after.groups[0]).toEqual({ assetGroupId: '41', trackingTemplate: null, finalUrlSuffix: 'src=pmax', customParameters: [{ key: 'aa', value: '1' }, { key: 'grp', value: 'b' }] })
    expect((d.before as PmaxChangeRecord).groups[0]).toEqual({ assetGroupId: '41', trackingTemplate: '{lpurl}?g=1', finalUrlSuffix: null, customParameters: [{ key: 'grp', value: 'a' }] })
    const now = liveGroup({ trackingTemplate: null, finalUrlSuffix: 'src=pmax', customParameters: [{ key: 'grp', value: 'b' }, { key: 'aa', value: '1' }] })
    expect(groupFactsOf(now, after.groups[0])).toEqual(after.groups[0])
    expect(refused(pmaxChangeDraft(C, 'EUR', { campaignId: '21', assetGroups: [{ assetGroupId: '41', finalUrlSuffix: '?src=x' }] }, changeLive()))).toMatch(/cannot begin with "\?"/)
    expect(refused(pmaxChangeDraft(C, 'EUR', { campaignId: '21', assetGroups: [{ assetGroupId: '41', trackingTemplate: '{lpurl}?g=1' }] }, changeLive()))).toMatch(/Nothing to change/)
  })
})

describe('build-google-pmax: text guidelines and page feeds', () => {
  const build = (o: Partial<PmaxBuildCampaign> = {}): PmaxBuildCampaign => ({
    name: 'PMax Z', dailyBudgetCents: 2500, bidding: { strategy: 'MAXIMIZE_CONVERSIONS' }, brandGuidelines: false, locations: [{ id: '2380' }],
    assetGroups: [], ...o,
  })
  const live: PmaxBuildLive = { campaignNames: [], assets: [], audiences: [], brandLists: [], images: {}, pageFeeds: [{ assetSetId: '77', name: 'Pages A' }] }
  it('the campaign carries its text guidelines; a page feed is linked after the campaign is made, with text customization asked on', () => {
    const d = draft(pmaxBuildDraft(C, 'EUR', [build({ textGuidelines: { termExclusions: ['cheap'], messagingRestrictions: ['Never mention prices'] }, pageFeeds: ['77'], automation: { textCustomization: true } })], live))
    const campaign = of(d.operations, 'campaignOperation')[0].create
    expect(campaign.textGuidelines).toEqual({ termExclusions: ['cheap'], messagingRestrictions: [{ restrictionText: 'Never mention prices', restrictionType: 'RESTRICTION_BASED_EXCLUSION' }] })
    expect(of(d.operations, 'campaignAssetSetOperation')).toEqual([{ create: { campaign: campaign.resourceName, assetSet: `${C}/assetSets/77` } }])
    expect(kinds(d.operations).indexOf('campaignAssetSetOperation')).toBeGreaterThan(kinds(d.operations).indexOf('campaignOperation'))
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings.join(' ')).toMatch(/page feeds linked — once enabled/)
    expect(refused(pmaxBuildDraft(C, 'EUR', [build({ pageFeeds: ['77'] })], live))).toMatch(/a page feed needs text customization on/)
    expect(refused(pmaxBuildDraft(C, 'EUR', [build({ pageFeeds: ['79'], automation: { textCustomization: true } })], live))).toMatch(/page feed 79 is not a page feed of this account/)
    expect(refused(pmaxBuildDraft(C, 'EUR', [build({ textGuidelines: { termExclusions: ['x'.repeat(31)] } })], live))).toMatch(/Google allows 30/)
  })
})

describe('set-google-page-feed builder', () => {
  const feedLive = (o: Partial<PageFeedLive> = {}): PageFeedLive => ({
    feeds: [{ assetSetId: '77', name: 'Pages A' }],
    urls: [{ assetId: '401', url: 'https://shop.example/jackets', labels: ['sale'] }],
    campaigns: [{ campaignId: '21', name: 'PMax A', status: 'ENABLED', type: 'PERFORMANCE_MAX' }],
    ...o,
  })
  it('a new feed: the PAGE_FEED asset set, a page asset per URL with its labels, each linked to the set — in one request; it spends nothing (linked to no campaign)', () => {
    const d = draft(pageFeedDraft(C, { name: 'Pages B', addUrls: [{ url: 'https://shop.example/a', labels: ['sale', ' sale ', 'new'] }, { url: 'https://shop.example/b' }, { url: 'https://shop.example/a' }] }, { feeds: [{ assetSetId: '77', name: 'Pages A' }], urls: [], campaigns: [] }))
    expect(kinds(d.operations)).toEqual(['assetSetOperation', 'assetOperation', 'assetOperation', 'assetSetAssetOperation', 'assetSetAssetOperation'])
    const set = of(d.operations, 'assetSetOperation')[0].create
    expect(set).toEqual({ resourceName: `${C}/assetSets/-1`, name: 'Pages B', type: 'PAGE_FEED' })
    const assets = of(d.operations, 'assetOperation').map((o) => o.create)
    expect(assets).toEqual([
      { resourceName: `${C}/assets/-2`, pageFeedAsset: { pageUrl: 'https://shop.example/a', labels: ['sale', 'new'] } },
      { resourceName: `${C}/assets/-3`, pageFeedAsset: { pageUrl: 'https://shop.example/b' } },
    ])
    expect(of(d.operations, 'assetSetAssetOperation')).toEqual([
      { create: { assetSet: set.resourceName, asset: assets[0].resourceName } },
      { create: { assetSet: set.resourceName, asset: assets[1].resourceName } },
    ])
    expect(d.spendsMoney).toEqual([])
    const after = pageFeedRecordAfterRun(d.after as PageFeedRecord, [
      { assetSetResult: { resourceName: `${C}/assetSets/88` } }, { assetResult: { resourceName: `${C}/assets/501` } }, { assetResult: { resourceName: `${C}/assets/502` } }, {}, {},
    ])
    expect(after).toMatchObject({ pageFeedId: '88', created: true, added: [{ url: 'https://shop.example/a', assetId: '501' }, { url: 'https://shop.example/b', assetId: '502' }] })
  })

  it('an existing feed an enabled campaign uses: a page added is SPENDS MONEY; a page taken away unlinks its asset; a page there already is skipped; undo reads what still holds', () => {
    expect(refused(pageFeedDraft(C, { pageFeedId: '77', addUrls: [{ url: 'https://shop.example/jackets' }], removeUrls: ['https://shop.example/jackets'] }, feedLive()))).toMatch(/both added and taken away/)
    const add = draft(pageFeedDraft(C, { pageFeedId: '77', addUrls: [{ url: 'https://shop.example/gloves' }, { url: 'https://shop.example/jackets' }] }, feedLive()))
    expect(kinds(add.operations)).toEqual(['assetOperation', 'assetSetAssetOperation'])
    expect(of(add.operations, 'assetSetAssetOperation')[0].create.assetSet).toBe(`${C}/assetSets/77`)
    expect(add.skipped.join(' ')).toMatch(/jackets" is already in the feed \(labels sale\)/)
    expect(add.spendsMoney).toEqual(['Adds 1 page to the page feed "Pages A", which the enabled campaign "PMax A" uses: Google may send people to those pages and write ads from them.'])
    const rm = draft(pageFeedDraft(C, { pageFeedId: '77', removeUrls: ['https://shop.example/jackets', 'https://shop.example/none'] }, feedLive()))
    expect(rm.operations).toEqual([{ assetSetAssetOperation: { remove: `${C}/assetSetAssets/77~401` } }])
    expect(rm.spendsMoney).toEqual([])
    expect(rm.warnings.join(' ')).toMatch(/taken out of "Pages A".*narrower/)
    const rec = rm.after as PageFeedRecord
    expect(rec.removed).toEqual([{ url: 'https://shop.example/jackets', labels: ['sale'], assetId: '401' }])
    expect(pageFeedNow(rec, [])).toEqual(rec)
    expect(pageFeedNow(rec, [{ assetId: '402', url: 'https://shop.example/jackets', labels: [] }])).not.toEqual(rec)
    const paused = draft(pageFeedDraft(C, { pageFeedId: '77', addUrls: [{ url: 'https://shop.example/gloves' }] }, feedLive({ campaigns: [{ campaignId: '21', name: 'PMax A', status: 'PAUSED', type: 'PERFORMANCE_MAX' }] })))
    expect(paused.spendsMoney).toEqual([])
    expect(paused.warnings.join(' ')).toMatch(/linked to 1 campaign that do not serve now/)
  })

  it('refuses: an unknown feed, a new feed without a name or with a taken one, a page that is no web page, too many labels', () => {
    expect(refused(pageFeedDraft(C, { pageFeedId: '79', addUrls: [{ url: 'https://shop.example/a' }] }, feedLive()))).toMatch(/Page feed 79 is not a page feed of this account/)
    expect(refused(pageFeedDraft(C, { addUrls: [{ url: 'https://shop.example/a' }] }, feedLive()))).toMatch(/needs a name/)
    expect(refused(pageFeedDraft(C, { name: 'pages a', addUrls: [{ url: 'https://shop.example/a' }] }, feedLive()))).toMatch(/a page feed named "pages a" exists \(pageFeedId 77\)/)
    expect(refused(pageFeedDraft(C, { pageFeedId: '77', addUrls: [{ url: 'ftp://shop.example/a' }, { url: 'https://shop.example/"x' }, { url: 'https://shop.example/b', labels: Array.from({ length: 21 }, (_, i) => `l${i}`) }] }, feedLive()))).toMatch(/is not a web page.*no quote.*21 labels \(Google takes at most 20 per URL\)/)
    expect(pageUrlProblem('http://shop.example/a')).toBeNull()
  })
})
