/**
 * Google Ads programme 2 G14b leftovers (2026-10-16) — a Search campaign's AI Max controls through set-google-campaign's
 * builder: text guidelines, page feeds linked, URL exclusions and an ad group's URL inclusions. What Google is sent (and in
 * which order), what is refused first (Google's rules), what is SPENDS MONEY, and the values undo reads back. Made-up ids.
 */
import { describe, expect, it } from 'vitest'
import { campaignSettingsDraft, campaignSettingsNow, type CampaignSettingsRecord } from './change-campaigns.js'
import { normalizeUrlRule, urlRuleBody, urlRuleProblem } from './change-search-ai.js'
import { urlRuleOf, type SearchAiLive } from './live-search-ai.js'
import type { GoogleChangeDraft } from './change-draft.js'
import type { LiveBudget, LiveCampaign, LiveCampaignDetail } from './live.js'

const C = 'customers/1234567890'
const camp = (status = 'ENABLED'): LiveCampaign => ({
  campaignId: '21', name: 'Search A', status, servingStatus: null, primaryStatus: null, type: 'SEARCH', subType: null, bidding: 'MANUAL_CPC', start: null, end: null,
  shopping: null, budget: { budgetId: '12', name: null, amountCents: 700, shared: false },
})
const OWN: LiveBudget = { budgetId: '12', name: null, amountCents: 700, shared: false, deliveryMethod: 'STANDARD', period: 'DAILY', usedBy: 1, campaigns: [] }
const settings = (over: Partial<LiveCampaignDetail['campaign']> = {}): LiveCampaignDetail['campaign'] => ({
  ...camp(),
  networks: { googleSearch: true, searchPartners: false, display: false, partnerSearch: false },
  locationOption: { include: 'PRESENCE', exclude: 'PRESENCE' }, audienceMode: [], euPoliticalAds: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
  aiMax: true, keywordMatchType: null, assetAutomation: [{ type: 'TEXT_ASSET_AUTOMATION', status: 'OPTED_IN' }, { type: 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION', status: 'OPTED_IN' }],
  manualCpcEnhanced: false, maxCpcCeilingCents: null, targetCpaCents: null, targetRoas: null,
  biddingStrategyId: null, localInventory: false, trackingTemplate: null, finalUrlSuffix: null, primaryStatusReasons: [],
  ...over,
} as LiveCampaignDetail['campaign'])
const AI: SearchAiLive & { accountFeeds: Array<{ assetSetId: string; name: string | null }> } = {
  textGuidelines: { termExclusions: ['cheap'], messagingRestrictions: ['Never mention prices'] },
  pageFeeds: [{ assetSetId: '77', name: 'Pages A' }],
  webpageCriteria: [{ criterionId: '16', type: 'WEBPAGE', negative: true, bidModifier: null, webpage: { name: 'x', conditions: [{ operand: 'URL', operator: 'CONTAINS', argument: '/outlet' }] } }],
  adGroups: [
    { adGroupId: '51', name: 'Group A', status: 'ENABLED', type: 'SEARCH_STANDARD', rules: [{ criterionId: '17', name: 'Include', rule: { urlContains: ['/jackets'] } }], otherWebpage: 0 },
    { adGroupId: '52', name: 'Group B', status: 'ENABLED', type: 'SEARCH_STANDARD', rules: [], otherWebpage: 0 },
    { adGroupId: '53', name: 'Group C', status: 'ENABLED', type: 'SEARCH_STANDARD', rules: [{ criterionId: '18', name: 'Title', rule: null }], otherWebpage: 0 },
  ],
  accountFeeds: [{ assetSetId: '77', name: 'Pages A' }, { assetSetId: '78', name: 'Pages B' }],
}
const live = (over: Partial<LiveCampaignDetail['campaign']> = {}) => ({ campaign: settings(over), budget: OWN, campaigns: [camp()], ai: structuredClone(AI) })
const draft = (d: GoogleChangeDraft | { refusal: string }): GoogleChangeDraft => { if ('refusal' in d) throw new Error(d.refusal); return d }
const refused = (d: GoogleChangeDraft | { refusal: string }): string => ('refusal' in d ? d.refusal : `not refused: ${d.summary}`)
const kinds = (d: GoogleChangeDraft) => d.operations.map((o) => Object.keys(o)[0])

describe('a Search campaign\'s AI Max controls (set-google-campaign)', () => {
  it('text guidelines: each list whole under its own mask; a term taken away is SPENDS MONEY in an enabled campaign', () => {
    const d = draft(campaignSettingsDraft(C, 'EUR', '21', { termExclusions: [], messagingRestrictions: ['Never mention prices', 'No superlatives'] }, live()))
    expect(d.operations).toEqual([{ campaignOperation: { update: {
      resourceName: `${C}/campaigns/21`,
      textGuidelines: { termExclusions: [], messagingRestrictions: [{ restrictionText: 'Never mention prices', restrictionType: 'RESTRICTION_BASED_EXCLUSION' }, { restrictionText: 'No superlatives', restrictionType: 'RESTRICTION_BASED_EXCLUSION' }] },
    }, updateMask: 'text_guidelines.term_exclusions,text_guidelines.messaging_restrictions' } }])
    expect(d.spendsMoney).toEqual(['Takes away the term exclusion "cheap": Google\'s generated text may say what it did not.'])
    expect((d.before as CampaignSettingsRecord).settings).toEqual({ termExclusions: ['cheap'], messagingRestrictions: ['Never mention prices'] })
    expect(refused(campaignSettingsDraft(C, 'EUR', '21', { termExclusions: ['x'.repeat(31)] }, live()))).toMatch(/Google allows 30/)
  })

  it('page feeds: a link goes after the campaign update and SPENDS MONEY; an unlink goes first (narrower); an unknown feed is refused', () => {
    const d = draft(campaignSettingsDraft(C, 'EUR', '21', { pageFeeds: ['78'], textCustomization: false, finalUrlExpansion: false }, live()))
    expect(kinds(d)).toEqual(['campaignAssetSetOperation', 'campaignOperation', 'campaignAssetSetOperation'])
    expect(d.operations[0]).toEqual({ campaignAssetSetOperation: { remove: `${C}/campaignAssetSets/21~77` } })
    expect(d.operations[2]).toEqual({ campaignAssetSetOperation: { create: { campaign: `${C}/campaigns/21`, assetSet: `${C}/assetSets/78` } } })
    expect(d.spendsMoney.join(' ')).toMatch(/Links the page feed "Pages B"/)
    expect(d.warnings.join(' ')).toMatch(/Unlinks the page feed "Pages A".*narrower/)
    expect(d.warnings.join(' ')).toMatch(/with text customization and final URL expansion off here, it changes nothing yet/)
    expect((d.after as CampaignSettingsRecord).settings.pageFeeds).toEqual(['78'])
    expect(refused(campaignSettingsDraft(C, 'EUR', '21', { pageFeeds: ['77', '79'] }, live()))).toMatch(/page feed 79 is not a page feed of this account/)
  })

  it('URL exclusions: a new one is a negative WEBPAGE criterion; one taken off SPENDS MONEY in an enabled campaign, final URL expansion on or off (they also keep pages from Dynamic Search Ads)', () => {
    const d = draft(campaignSettingsDraft(C, 'EUR', '21', { urlExclusions: [{ equals: 'https://shop.example/thanks' }] }, live()))
    expect(d.operations).toEqual([
      { campaignCriterionOperation: { create: { campaign: `${C}/campaigns/21`, negative: true, webpage: { criterionName: 'Exclude equals:https://shop.example/thanks', conditions: [{ operand: 'URL', operator: 'EQUALS', argument: 'https://shop.example/thanks' }] } } } },
      { campaignCriterionOperation: { remove: `${C}/campaignCriteria/21~16` } },
    ])
    expect(d.spendsMoney.join(' ')).toMatch(/Takes the URL exclusion contains:\/outlet off/)
    const off = draft(campaignSettingsDraft(C, 'EUR', '21', { urlExclusions: [] }, live({ assetAutomation: [{ type: 'TEXT_ASSET_AUTOMATION', status: 'OPTED_IN' }] })))
    expect(off.spendsMoney).toEqual(['Takes the URL exclusion contains:/outlet off: Google may send people to those pages again (final URL expansion, Dynamic Search Ads).'])
  })

  it('URL inclusions in mixed case: the record, the before and what is read back keep ONE order (undo\'s compare and the undo\'s own undo)', () => {
    const base = live()
    base.ai.adGroups![1].rules = [{ criterionId: '30', name: null, rule: { urlContains: ['Zip'] } }, { criterionId: '31', name: null, rule: { urlContains: ['alpha'] } }]
    const d = draft(campaignSettingsDraft(C, 'EUR', '21', { urlInclusions: [{ adGroupId: '52', rules: [{ urlContains: ['boots'] }, { urlContains: ['Sale'] }] }] }, base))
    const after = (d.after as CampaignSettingsRecord).settings.urlInclusions
    const before = (d.before as CampaignSettingsRecord).settings.urlInclusions
    // Read back in Google's order (any order): the same as the record.
    const ran: SearchAiLive = { ...structuredClone(AI), adGroups: [AI.adGroups![0], { ...AI.adGroups![1], rules: [
      { criterionId: '41', name: null, rule: { urlContains: ['boots'] } }, { criterionId: '40', name: null, rule: { urlContains: ['Sale'] } },
    ] }] }
    expect(campaignSettingsNow(settings(), OWN, ran, ['52']).urlInclusions).toEqual(after)
    expect(campaignSettingsNow(settings(), OWN, base.ai, ['52']).urlInclusions).toEqual(before)
    expect(after).toEqual([{ adGroupId: '52', rules: [{ urlContains: ['Sale'] }, { urlContains: ['boots'] }] }])
  })

  it('an ad group named for URL inclusions is in what the change stands on: enabled since the preview, the run is refused as moved', () => {
    const paused = live()
    paused.ai.adGroups![1].status = 'PAUSED'
    const ask = { urlInclusions: [{ adGroupId: '52', rules: [{ labels: ['sale'] }] }] }
    const d = draft(campaignSettingsDraft(C, 'EUR', '21', ask, paused))
    expect(d.stands).toMatchObject({ adGroups: ['52:PAUSED:SEARCH_STANDARD'] })
    expect(draft(campaignSettingsDraft(C, 'EUR', '21', ask, live())).stands).toMatchObject({ adGroups: ['52:ENABLED:SEARCH_STANDARD'] })
    expect(draft(campaignSettingsDraft(C, 'EUR', '21', { termExclusions: [] }, live())).stands).toMatchObject({ adGroups: undefined })
  })

  it('URL inclusions: a rule added where the ad group keeps to a list SPENDS MONEY, the last taken away too, a first one narrows; a rule changed is removed and made again', () => {
    const d = draft(campaignSettingsDraft(C, 'EUR', '21', { urlInclusions: [{ adGroupId: '51', rules: [{ urlContains: ['/jackets'] }, { labels: ['sale'] }] }, { adGroupId: '52', rules: [{ urlEquals: 'https://shop.example/a' }] }] }, live()))
    expect(d.operations).toEqual([
      { adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/51`, webpage: { criterionName: 'Include label "sale"', conditions: [{ operand: 'CUSTOM_LABEL', operator: 'EQUALS', argument: 'sale' }] } } } },
      { adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/52`, webpage: { criterionName: 'Include the page https://shop.example/a', conditions: [{ operand: 'URL', operator: 'EQUALS', argument: 'https://shop.example/a' }] } } } },
    ])
    expect(d.spendsMoney).toEqual(['ad group "Group A": adds 1 URL inclusion to the 1 it keeps to — Google may send people to more pages.'])
    expect(d.warnings.join(' ')).toMatch(/ad group "Group B": keeps to 1 URL inclusion from now — only those pages are used \(narrower\)/)
    const after = d.after as CampaignSettingsRecord
    // Each ad group's rules in a stable order (by what each rule is).
    expect(after.settings.urlInclusions).toEqual([{ adGroupId: '51', rules: [{ labels: ['sale'] }, { urlContains: ['/jackets'] }] }, { adGroupId: '52', rules: [{ urlEquals: 'https://shop.example/a' }] }])
    // Read back from the account as the change left it: the same (undo's compare).
    const now: SearchAiLive = { ...structuredClone(AI), adGroups: [
      { ...AI.adGroups![0], rules: [...AI.adGroups![0].rules, { criterionId: '19', name: null, rule: { labels: ['sale'] } }] },
      { ...AI.adGroups![1], rules: [{ criterionId: '20', name: null, rule: { urlEquals: 'https://shop.example/a' } }] },
    ] }
    const back = campaignSettingsNow(settings(), OWN, now, ['51', '52'])
    expect(back.urlInclusions).toEqual(after.settings.urlInclusions)

    const last = draft(campaignSettingsDraft(C, 'EUR', '21', { urlInclusions: [{ adGroupId: '51', rules: [] }] }, live()))
    expect(last.operations).toEqual([{ adGroupCriterionOperation: { remove: `${C}/adGroupCriteria/51~17` } }])
    expect(last.spendsMoney.join(' ')).toMatch(/takes away its last URL inclusion — Google may send people to any page/)
  })

  it('refuses what Google refuses: inclusions without AI Max and text customization, a rule of more than three conditions, an exact URL with others, a rule Nexus cannot name, a Shopping campaign', () => {
    expect(refused(campaignSettingsDraft(C, 'EUR', '21', { urlInclusions: [{ adGroupId: '52', rules: [{ labels: ['sale'] }] }] }, live({ aiMax: false, assetAutomation: [] }))))
      .toMatch(/only with AI Max on and text customization on/)
    // Turning both on in the same change is enough: the update goes before the new rule.
    const on = draft(campaignSettingsDraft(C, 'EUR', '21', { aiMax: true, textCustomization: true, urlInclusions: [{ adGroupId: '52', rules: [{ labels: ['sale'] }] }] }, live({ aiMax: false, assetAutomation: [] })))
    expect(kinds(on)).toEqual(['campaignOperation', 'adGroupCriterionOperation'])
    expect(refused(campaignSettingsDraft(C, 'EUR', '21', { urlInclusions: [{ adGroupId: '52', rules: [{ urlContains: ['/a', '/b'], labels: ['x', 'y'] }] }] }, live()))).toMatch(/at most 3 conditions/)
    expect(refused(campaignSettingsDraft(C, 'EUR', '21', { urlInclusions: [{ adGroupId: '52', rules: [{ urlEquals: 'https://shop.example/a', labels: ['x'] }] }] }, live()))).toMatch(/takes no other condition/)
    expect(refused(campaignSettingsDraft(C, 'EUR', '21', { urlInclusions: [{ adGroupId: '53', rules: [] }] }, live()))).toMatch(/a page rule Nexus cannot name/)
    const shopping = { ...live(), campaign: settings({ type: 'SHOPPING', shopping: { merchantId: '5', feedLabel: 'IT', priority: 'LOW' } } as never) }
    expect(refused(campaignSettingsDraft(C, 'EUR', '21', { pageFeeds: ['77'] }, shopping))).toMatch(/are Search campaign settings here/)
  })
})

describe('the parts', () => {
  it('a rule from Google\'s conditions (a default operator left out; another operand is none Nexus names); its body; its problems', () => {
    expect(urlRuleOf([{ operand: 'URL', argument: '/a' }, { operand: 'CUSTOM_LABEL', argument: 'sale' }])).toEqual({ urlContains: ['/a'], labels: ['sale'] })
    expect(urlRuleOf([{ operand: 'URL', operator: 'EQUALS', argument: 'https://shop.example/a' }])).toEqual({ urlEquals: 'https://shop.example/a' })
    expect(urlRuleOf([{ operand: 'PAGE_TITLE', operator: 'CONTAINS', argument: 'jackets' }])).toBeNull()
    expect(urlRuleOf([])).toBeNull()
    expect(normalizeUrlRule({ urlContains: [' /b', '/a'], labels: ['z'] })).toEqual({ urlContains: ['/a', '/b'], labels: ['z'] })
    expect(urlRuleBody({ urlEquals: 'https://shop.example/a' })).toEqual({ criterionName: 'Include the page https://shop.example/a', conditions: [{ operand: 'URL', operator: 'EQUALS', argument: 'https://shop.example/a' }] })
    expect(urlRuleProblem({ urlEquals: '/relative' })).toMatch(/not a full http/)
    expect(urlRuleProblem({})).toMatch(/needs a URL/)
  })
})
