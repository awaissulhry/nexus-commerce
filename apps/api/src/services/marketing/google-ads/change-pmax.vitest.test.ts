/**
 * Google Ads Performance Max (programme 2, G10) — the pure builders: a build (campaign PAUSED, its own budget, brand
 * guidelines, asset groups with assets, product tree and signals, in the order Google needs), Google's minimums refused
 * in words, the change of a live campaign (asset group assets, product tree, signals, exclusions, automation, brand
 * assets) with what can spend money marked, and customer acquisition. Made-up ids and names only.
 */
import { describe, expect, it } from 'vitest'
import { pmaxBuildDraft, type PmaxBuildCampaign, type PmaxBuildLive } from './build-pmax.js'
import {
  idsFromRun, imageSlot, PMAX_KIND_ORDER, pmaxChangeDraft, pmaxRecordAfterRun, pmaxSnapshot, pmaxSpecOfSnapshot, pmaxTreeOfLive, pmaxTreeOfSpec, pmaxTreeOps,
  pmaxTreeWidens, youtubeIdOf, type PmaxChangeLive, type PmaxChangeRecord,
} from './change-pmax.js'
import { acquisitionDraft } from './change-acquisition.js'
import type { PreparedImage } from './asset-images.js'
import type { PmaxAssetGroup, PmaxCampaignLive, PmaxFilterNode, PmaxLink } from './live-pmax.js'
import type { GoogleMutateOperation } from './write-client.js'

const C = 'customers/1234567890'
const img = (width: number, height: number, sha: string): PreparedImage => ({ source: 'https://cdn.example/a.png', label: 'a', mimeType: 'image/png', bytes: 2000, width, height, sha256: sha.repeat(64).slice(0, 64), data: 'AAAA' })
const kinds = (ops: GoogleMutateOperation[]) => ops.map((o) => Object.keys(o)[0])
const of = (ops: GoogleMutateOperation[], kind: string) => ops.filter((o) => kind in o).map((o) => o[kind] as Record<string, any>)

const GROUP_ASSETS = {
  headlines: ['Race jackets', 'Leather suits', 'Fast delivery'],
  longHeadlines: ['Race-ready leather jackets for the track'],
  descriptions: ['Free returns within 30 days on every order.', 'Hand-made leather suits for track days and road riding, sized for you.'],
  images: [{ fieldType: 'MARKETING_IMAGE' as const, imageUrl: 'https://cdn.example/l.png' }, { fieldType: 'SQUARE_MARKETING_IMAGE' as const, imageUrl: 'https://cdn.example/s.png' }],
}

const buildLive = (images: PmaxBuildLive['images'] = {}): PmaxBuildLive => ({
  campaignNames: ['Shop A'],
  assets: [{ assetId: '901', type: 'YOUTUBE_VIDEO', name: null, text: null, width: null, height: null, mimeType: null, youtubeId: 'abcdefghijk', callToAction: null }],
  audiences: [{ audienceId: '71', name: 'Buyers', scope: 'CUSTOMER', assetGroupId: null }, { audienceId: '72', name: 'Group only', scope: 'ASSET_GROUP', assetGroupId: '41' }],
  brandLists: [{ listId: '61', name: 'Brands Z' }],
  images,
})

const retailBuild = (): PmaxBuildCampaign => ({
  name: 'PMax Z',
  dailyBudgetCents: 2500,
  bidding: { strategy: 'MAXIMIZE_CONVERSION_VALUE', targetRoas: 4 },
  retail: { merchantId: '555', feedLabel: 'IT' },
  locations: [{ id: '2380' }],
  languages: ['1004'],
  brandAssets: { adBusinessName: 'Shop Z', images: [{ fieldType: 'LOGO', imageUrl: 'https://cdn.example/logo.png' }] },
  urlExclusions: [{ contains: '/outlet' }],
  brandExclusions: ['61'],
  negativeKeywords: [{ text: 'cheap', matchType: 'PHRASE' }],
  assetGroups: [{
    name: 'Group A', finalUrls: ['https://shop.example/'], path1: 'jackets',
    assets: { ...GROUP_ASSETS, link: [{ assetId: '901', fieldType: 'YOUTUBE_VIDEO' }], callToAction: 'SHOP_NOW' },
    products: [{ split: 'BRAND' }, { parent: 0, value: 'Brand A' }, { parent: 0, everythingElse: true, excluded: true }],
    signals: { audiences: ['71'], newAudiences: [{ name: 'Visitors Z', segments: [{ kind: 'USER_LIST', id: '301' }] }], searchThemes: ['moto jacket'] },
  }],
})

const images = {
  [imageSlot('c0:brand', 0)]: img(512, 512, 'b'),
  [imageSlot('c0:g0', 0)]: img(1200, 628, 'c'),
  [imageSlot('c0:g0', 1)]: img(1200, 1200, 'd'),
}

describe('build-google-pmax builder', () => {
  it('a retail campaign in one request: PAUSED, its own budget, brand guidelines, assets before their links, a tree parents first, signals', () => {
    const draft = pmaxBuildDraft(C, 'EUR', [retailBuild()], buildLive(images))
    if ('refusal' in draft) throw new Error(draft.refusal)
    const ops = draft.operations
    // Kinds in Google's order, each kind together (asset group assets in ONE run: Google judges the minimums after it).
    const order = kinds(ops)
    const runs = order.filter((k, i) => i === 0 || order[i - 1] !== k)
    expect(new Set(runs).size).toBe(runs.length)
    expect([...runs].sort((a, b) => PMAX_KIND_ORDER.indexOf(a as never) - PMAX_KIND_ORDER.indexOf(b as never))).toEqual(runs)
    const budget = of(ops, 'campaignBudgetOperation')[0].create
    expect(budget).toMatchObject({ amountMicros: '25000000', explicitlyShared: false })
    const campaign = of(ops, 'campaignOperation')[0].create
    expect(campaign).toMatchObject({
      status: 'PAUSED', advertisingChannelType: 'PERFORMANCE_MAX', campaignBudget: budget.resourceName, brandGuidelinesEnabled: true,
      maximizeConversionValue: { targetRoas: 4 }, shoppingSetting: { merchantId: '555', feedLabel: 'IT', enableLocal: false },
      containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
      assetAutomationSettings: [
        { assetAutomationType: 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION', assetAutomationStatus: 'OPTED_OUT' },
        { assetAutomationType: 'TEXT_ASSET_AUTOMATION', assetAutomationStatus: 'OPTED_OUT' },
      ],
    })
    expect(campaign.advertisingChannelSubType).toBeUndefined()
    const criteria = of(ops, 'campaignCriterionOperation').map((c) => c.create)
    expect(criteria).toContainEqual({ campaign: campaign.resourceName, negative: true, webpage: { criterionName: 'Exclude contains:/outlet', conditions: [{ operand: 'URL', operator: 'CONTAINS', argument: '/outlet' }] } })
    expect(criteria).toContainEqual({ campaign: campaign.resourceName, negative: true, brandList: { sharedSet: `${C}/sharedSets/61` } })
    expect(criteria).toContainEqual({ campaign: campaign.resourceName, negative: true, keyword: { text: 'cheap', matchType: 'PHRASE' } })
    // The brand's assets on the campaign.
    expect(of(ops, 'campaignAssetOperation').map((a) => a.create.fieldType).sort()).toEqual(['BUSINESS_NAME', 'LOGO'])
    // The asset group and its assets: 3 + 1 + 2 texts, 2 images, a video by id, a call to action.
    const group = of(ops, 'assetGroupOperation')[0].create
    expect(group).toMatchObject({ campaign: campaign.resourceName, name: 'Group A', finalUrls: ['https://shop.example/'], path1: 'jackets', status: 'ENABLED' })
    const links = of(ops, 'assetGroupAssetOperation').map((a) => a.create)
    expect(links.map((l) => l.fieldType).sort()).toEqual(['CALL_TO_ACTION_SELECTION', 'DESCRIPTION', 'DESCRIPTION', 'HEADLINE', 'HEADLINE', 'HEADLINE', 'LONG_HEADLINE', 'MARKETING_IMAGE', 'SQUARE_MARKETING_IMAGE', 'YOUTUBE_VIDEO'])
    expect(links.every((l) => l.assetGroup === group.resourceName)).toBe(true)
    expect(links.find((l) => l.fieldType === 'YOUTUBE_VIDEO')!.asset).toBe(`${C}/assets/901`)
    const made = of(ops, 'assetOperation').map((a) => a.create)
    expect(made.find((a) => a.callToActionAsset)).toMatchObject({ callToActionAsset: { callToAction: 'SHOP_NOW' } })
    expect(made.filter((a) => a.imageAsset).every((a) => a.type === 'IMAGE' && a.imageAsset.data === 'AAAA')).toBe(true)
    // The product tree: the root split, Brand A included, everything else excluded — parents first, Shopping source.
    const tree = of(ops, 'assetGroupListingGroupFilterOperation').map((f) => f.create)
    expect(tree.map((f) => [f.type, f.caseValue ?? null, f.listingSource])).toEqual([
      ['SUBDIVISION', null, 'SHOPPING'], ['UNIT_INCLUDED', { productBrand: { value: 'Brand A' } }, 'SHOPPING'], ['UNIT_EXCLUDED', { productBrand: {} }, 'SHOPPING'],
    ])
    expect(tree[1].parentListingGroupFilter).toBe(tree[0].resourceName)
    expect(tree[0].resourceName).toMatch(new RegExp(`^${C}/assetGroupListingGroupFilters/-\\d+~-\\d+$`))
    // Signals: an existing audience, a new one (made in the request), a search theme.
    const audience = of(ops, 'audienceOperation')[0].create
    expect(audience).toMatchObject({ name: 'Visitors Z', dimensions: [{ audienceSegments: { segments: [{ userList: { userList: `${C}/userLists/301` } }] } }] })
    expect(of(ops, 'assetGroupSignalOperation').map((s) => s.create)).toEqual([
      { assetGroup: group.resourceName, audience: { audience: `${C}/audiences/71` } },
      { assetGroup: group.resourceName, audience: { audience: audience.resourceName } },
      { assetGroup: group.resourceName, searchTheme: { text: 'moto jacket' } },
    ])
    expect(draft.spendsMoney).toEqual([])
    expect(draft.warnings[0]).toMatch(/^Every campaign is made PAUSED/)
    const record = draft.after as { campaigns: Array<{ op: number; ownBudgetOp: number }> }
    expect(ops[record.campaigns[0].op]).toHaveProperty('campaignOperation')
    expect(ops[record.campaigns[0].ownBudgetOp]).toHaveProperty('campaignBudgetOperation')
  })

  it('Google\'s minimums and rules are refused in words before anything is sent', () => {
    const refusal = (c: Partial<PmaxBuildCampaign>, imgs = images) => {
      const d = pmaxBuildDraft(C, 'EUR', [{ ...retailBuild(), ...c }], buildLive(imgs))
      return 'refusal' in d ? d.refusal : 'accepted'
    }
    const group = retailBuild().assetGroups[0]
    expect(refusal({ assetGroups: [{ ...group, assets: { ...GROUP_ASSETS, headlines: ['A', 'B'] } }] })).toMatch(/2 headlines \(Google needs at least 3\)/)
    expect(refusal({ assetGroups: [{ ...group, assets: { ...GROUP_ASSETS, descriptions: [GROUP_ASSETS.descriptions[1], `${GROUP_ASSETS.descriptions[1]} More`] } }] })).toMatch(/SHORT_DESCRIPTION_REQUIRED/)
    expect(refusal({ assetGroups: [{ ...group, assets: { ...GROUP_ASSETS, headlines: ['{KeyWord:Jackets}', 'B', 'C'] } }] })).toMatch(/AD_CUSTOMIZER_NOT_SUPPORTED/)
    expect(refusal({ assetGroups: [{ ...group, assets: { ...GROUP_ASSETS, headlines: ['This headline is far too long for Google', 'B', 'C'] } }] })).toMatch(/Google allows 30/)
    expect(refusal({ brandAssets: { adBusinessName: 'Shop Z' } })).toMatch(/no logo \(brand guidelines need at least one square LOGO/)
    expect(refusal({ name: 'Shop A' })).toMatch(/already exists/)
    expect(refusal({ bidding: { strategy: 'PORTFOLIO', portfolioId: '81' } })).toMatch(/MAXIMIZE_CONVERSIONS .* only/)
    expect(refusal({ assetGroups: [{ ...group, products: [{ split: 'CHANNEL_EXCLUSIVITY' }] }] })).toMatch(/not by channel exclusivity/)
    expect(refusal({ assetGroups: [{ ...group, products: [{ split: 'BRAND' }, { parent: 0, value: 'Brand A' }] }] })).toMatch(/without "everything else"/)
    expect(refusal({}, { ...images, [imageSlot('c0:g0', 0)]: img(1200, 1200, 'e') })).toMatch(/landscape \(1\.91:1\)/)
    expect(refusal({ brandGuidelines: false })).toMatch(/with brand guidelines off the business name and logos go in each asset group/)
    expect(refusal({ brandExclusions: ['62'] })).toMatch(/brand list 62 is not a brand list/)
    expect(refusal({ assetGroups: [{ ...group, signals: { audiences: ['72'] } }] })).toMatch(/AUDIENCE_WITH_WRONG_ASSET_GROUP_ID/)
  })

  it('a retail asset group may hold no asset (Google makes ads from the feed), and then needs no brand assets', () => {
    const d = pmaxBuildDraft(C, 'EUR', [{ ...retailBuild(), brandAssets: undefined, assetGroups: [{ name: 'Feed only', finalUrls: ['https://shop.example/'] }] }], buildLive())
    if ('refusal' in d) throw new Error(d.refusal)
    expect(of(d.operations, 'assetGroupAssetOperation')).toEqual([])
    // The default tree: "All products" included.
    expect(of(d.operations, 'assetGroupListingGroupFilterOperation').map((f) => f.create.type)).toEqual(['UNIT_INCLUDED'])
    expect(d.warnings.join(' ')).toMatch(/holds no asset: Google makes its ads from the Merchant Center feed/)
    // A non-retail campaign with no brand assets is refused (brand guidelines on by default).
    const lead = pmaxBuildDraft(C, 'EUR', [{ name: 'Leads Z', dailyBudgetCents: 900, bidding: { strategy: 'MAXIMIZE_CONVERSIONS' }, assetGroups: [{ name: 'G', finalUrls: ['https://shop.example/'], assets: GROUP_ASSETS }] }], buildLive({ [imageSlot('c0:g0', 0)]: img(1200, 628, 'c'), [imageSlot('c0:g0', 1)]: img(1200, 1200, 'd') }))
    expect('refusal' in lead && lead.refusal).toMatch(/0 business names \(brand guidelines need exactly one/)
  })
})

// ── the change of a live campaign ──────────────────────────────────────────────────────────────────────────────

const link = (assetId: string, fieldType: string, text: string | null = null): PmaxLink => ({
  assetId, fieldType, status: 'ENABLED', source: 'ADVERTISER', type: fieldType.includes('IMAGE') || fieldType.includes('LOGO') ? 'IMAGE' : 'TEXT', name: null, text, width: null, height: null, mimeType: null, youtubeId: null, callToAction: null,
})
const node = (id: string, parentId: string | null, type: string, dimension: string | null = null, value: string | null = null): PmaxFilterNode => ({
  id, parentId, type, listingSource: 'SHOPPING', dimension, value,
  caseValue: dimension ? { [dimension]: value === null ? {} : { value } } : null,
})
const liveGroup = (over: Partial<PmaxAssetGroup> = {}): PmaxAssetGroup => ({
  assetGroupId: '41', name: 'Group A', status: 'ENABLED', finalUrls: ['https://shop.example/'], finalMobileUrls: [], path1: null, path2: null, adStrength: 'GOOD', primaryStatus: 'ELIGIBLE',
  assets: [
    link('301', 'HEADLINE', 'Race jackets'), link('302', 'HEADLINE', 'Leather suits'), link('303', 'HEADLINE', 'Fast delivery'),
    link('304', 'LONG_HEADLINE', 'Race-ready leather jackets'), link('305', 'DESCRIPTION', 'Free returns.'), link('306', 'DESCRIPTION', 'Hand-made leather suits for track days.'),
    link('307', 'MARKETING_IMAGE'), link('308', 'SQUARE_MARKETING_IMAGE'),
    { ...link('399', 'HEADLINE', 'Google wrote this'), source: 'AUTOMATICALLY_CREATED' },
  ],
  tree: [node('601', null, 'SUBDIVISION'), node('602', '601', 'UNIT_INCLUDED', 'productBrand', 'Brand A'), node('603', '601', 'UNIT_EXCLUDED', 'productBrand', null)],
  signals: [{ signalId: '41~701', audienceId: null, searchTheme: 'moto jacket', approval: 'APPROVED' }],
  ...over,
})
const liveCampaign = (over: Partial<PmaxCampaignLive> = {}): PmaxCampaignLive => ({
  campaignId: '21', name: 'PMax A', status: 'ENABLED', type: 'PERFORMANCE_MAX', biddingType: 'MAXIMIZE_CONVERSION_VALUE', targetCpaCents: null, targetRoas: 4,
  budget: { budgetId: '11', amountCents: 2500, shared: false }, start: '2026-01-01 00:00:00', end: null,
  retail: { merchantId: '555', feedLabel: null, localInventory: false }, brandGuidelines: true, brandStyle: null, euPoliticalAds: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
  locationOption: 'PRESENCE', trackingTemplate: null, finalUrlSuffix: null,
  automation: { FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION: 'OPTED_OUT', TEXT_ASSET_AUTOMATION: 'OPTED_IN', GENERATE_IMAGE_ENHANCEMENT: 'OPTED_IN' },
  campaignAssets: [link('201', 'BUSINESS_NAME', 'Shop A'), link('202', 'LOGO')],
  criteria: [
    { criterionId: '91', type: 'BRAND_LIST', negative: true, bidModifier: null, brandListId: '61' },
    { criterionId: '92', type: 'WEBPAGE', negative: true, bidModifier: null, webpage: { name: 'x', conditions: [{ operand: 'URL', operator: 'CONTAINS', argument: '/outlet' }] } },
  ],
  assetGroups: [liveGroup()],
  notRead: [],
  ...over,
})
const changeLive = (over: Partial<PmaxChangeLive> = {}): PmaxChangeLive => ({
  campaign: liveCampaign(), campaignNames: [], assets: [], audiences: [{ audienceId: '71', name: 'Buyers', scope: 'CUSTOMER', assetGroupId: null }], brandLists: [{ listId: '61', name: 'Brands Z' }], images: {}, ...over,
})

describe('set-google-pmax builder', () => {
  it('replaces a headline in one run of links, keeps the minimums, and marks what spends in an enabled campaign', () => {
    const d = pmaxChangeDraft(C, 'EUR', {
      campaignId: '21',
      automation: { finalUrlExpansion: true },
      brandExclusions: { remove: ['61'] },
      urlExclusions: { add: [{ equals: 'https://shop.example/sale' }] },
      assetGroups: [{ assetGroupId: '41', addAssets: { headlines: ['Track-day suits'] }, removeAssets: [{ assetId: '303', fieldType: 'HEADLINE' }], addSignals: { searchThemes: ['racing gloves'] } }],
    }, changeLive())
    if ('refusal' in d) throw new Error(d.refusal)
    const ops = d.operations
    const linkOps = kinds(ops).map((k, i) => (k === 'assetGroupAssetOperation' ? i : -1)).filter((i) => i >= 0)
    expect(linkOps).toEqual(Array.from({ length: linkOps.length }, (_, i) => linkOps[0] + i))
    expect(of(ops, 'assetGroupAssetOperation')).toEqual([
      { remove: `${C}/assetGroupAssets/41~303~HEADLINE` },
      { create: { assetGroup: `${C}/assetGroups/41`, asset: expect.stringMatching(/^customers\/1234567890\/assets\/-\d+$/), fieldType: 'HEADLINE' } },
    ])
    const campaign = of(ops, 'campaignOperation')[0]
    expect(campaign.updateMask).toBe('asset_automation_settings')
    expect(campaign.update.assetAutomationSettings).toEqual(expect.arrayContaining([
      { assetAutomationType: 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION', assetAutomationStatus: 'OPTED_IN' },
      { assetAutomationType: 'TEXT_ASSET_AUTOMATION', assetAutomationStatus: 'OPTED_IN' },
    ]))
    expect(of(ops, 'campaignCriterionOperation')).toContainEqual({ remove: `${C}/campaignCriteria/21~91` })
    expect(d.spendsMoney.join(' ')).toMatch(/final URL expansion/)
    expect(d.spendsMoney.join(' ')).toMatch(/brand exclusion "Brands Z" off/)
    expect(d.spendsMoney.join(' ')).toMatch(/Adds 1 signal to asset group "Group A"/)
    const after = d.after as PmaxChangeRecord
    expect(after.campaign).toMatchObject({ automation: { finalUrlExpansion: 'OPTED_IN' }, brandExclusions: [], urlExclusions: ['contains:/outlet', 'equals:https://shop.example/sale'] })
    expect(after.groups[0].links).toContain('301~HEADLINE')
    expect(after.groups[0].links!.some((l) => /^tmp:-\d+~HEADLINE$/.test(l))).toBe(true)
    expect(after.groups[0].signals).toEqual(['t:moto jacket', 't:racing gloves'])
  })

  it('the same change in a paused campaign spends nothing yet: warnings instead', () => {
    const d = pmaxChangeDraft(C, 'EUR', { campaignId: '21', automation: { finalUrlExpansion: true }, assetGroups: [{ assetGroupId: '41', addSignals: { audiences: ['71'] } }] }, changeLive({ campaign: liveCampaign({ status: 'PAUSED' }) }))
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings.join(' ')).toMatch(/final URL expansion.*the campaign is paused/)
  })

  it('refuses what Google would refuse, in words', () => {
    const refusal = (request: Parameters<typeof pmaxChangeDraft>[2], live = changeLive()) => { const d = pmaxChangeDraft(C, 'EUR', request, live); return 'refusal' in d ? d.refusal : 'accepted' }
    expect(refusal({ campaignId: '21', assetGroups: [{ assetGroupId: '41', removeAssets: [{ assetId: '303', fieldType: 'HEADLINE' }] }] })).toMatch(/2 headlines \(Google needs at least 3\)/)
    expect(refusal({ campaignId: '21', assetGroups: [{ assetGroupId: '41', addAssets: { link: [{ assetId: '501', fieldType: 'LOGO' }] } }] })).toMatch(/linked to the campaign with brand guidelines on/)
    expect(refusal({ campaignId: '21', brandAssets: { remove: [{ assetId: '201', fieldType: 'BUSINESS_NAME' }] } })).toMatch(/0 business names/)
    expect(refusal({ campaignId: '21', automation: { textCustomization: false, finalUrlExpansion: true } })).toMatch(/no way to opt out of text asset automation/)
    expect(refusal({ campaignId: '21', settings: { bidding: { strategy: 'MANUAL_CPC' } } })).toMatch(/MAXIMIZE_CONVERSIONS/)
    expect(refusal({ campaignId: '21' }, changeLive({ campaign: liveCampaign({ type: 'SEARCH' }) }))).toMatch(/set-google-pmax changes Performance Max campaigns/)
    expect(refusal({ campaignId: '21', assetGroups: [{ assetGroupId: '41', addSignals: { searchThemes: ['moto jacket'] } }] })).toMatch(/^Nothing to change in "PMax A": asset group "Group A": search theme "moto jacket" is already a signal/)
  })

  it('a new asset group in an enabled campaign is made PAUSED unless enable; its tree is "All products"', () => {
    const ask = { name: 'Group B', finalUrls: ['https://shop.example/b'] }
    const d = pmaxChangeDraft(C, 'EUR', { campaignId: '21', assetGroups: [ask] }, changeLive())
    if ('refusal' in d) throw new Error(d.refusal)
    expect(of(d.operations, 'assetGroupOperation')[0].create).toMatchObject({ name: 'Group B', status: 'PAUSED', campaign: `${C}/campaigns/21` })
    expect(of(d.operations, 'assetGroupListingGroupFilterOperation').map((f) => f.create.type)).toEqual(['UNIT_INCLUDED'])
    expect(d.spendsMoney).toEqual([])
    const on = pmaxChangeDraft(C, 'EUR', { campaignId: '21', assetGroups: [{ ...ask, enable: true }] }, changeLive())
    if ('refusal' in on) throw new Error(on.refusal)
    expect(of(on.operations, 'assetGroupOperation')[0].create.status).toBe('ENABLED')
    expect(on.spendsMoney.join(' ')).toMatch(/ENABLED in an enabled campaign/)
    expect((on.after as PmaxChangeRecord).groups[0]).toMatchObject({ created: true, status: 'ENABLED', name: 'Group B' })
  })

  it('a product tree change: what stays keeps its id, removals leaves first, and more products advertised is SPENDS MONEY', () => {
    const d = pmaxChangeDraft(C, 'EUR', { campaignId: '21', assetGroups: [{ assetGroupId: '41', products: [{ split: 'BRAND' }, { parent: 0, value: 'brand a' }, { parent: 0, value: 'Brand B' }, { parent: 0, everythingElse: true }] }] }, changeLive())
    if ('refusal' in d) throw new Error(d.refusal)
    const ops = of(d.operations, 'assetGroupListingGroupFilterOperation')
    // "everything else" goes from excluded to included: removed and made again; Brand B is new; the root and Brand A stay.
    expect(ops[0]).toEqual({ remove: `${C}/assetGroupListingGroupFilters/41~603` })
    expect(ops.slice(1).map((o) => [o.create.type, o.create.parentListingGroupFilter, o.create.caseValue])).toEqual([
      ['UNIT_INCLUDED', `${C}/assetGroupListingGroupFilters/41~601`, { productBrand: { value: 'Brand B' } }],
      ['UNIT_INCLUDED', `${C}/assetGroupListingGroupFilters/41~601`, { productBrand: {} }],
    ])
    expect(d.spendsMoney.join(' ')).toMatch(/Advertises more products in asset group "Group A": brand "Brand B"; everything else \(by brand\)/)
  })
})

describe('listing group trees (Performance Max)', () => {
  it('removes a split leaves first and never acts twice on one node', () => {
    const live = pmaxTreeOfLive([node('601', null, 'SUBDIVISION'), node('602', '601', 'SUBDIVISION', 'productBrand', 'Brand A'), node('604', '602', 'UNIT_INCLUDED', 'productCondition', 'NEW'), node('605', '602', 'UNIT_EXCLUDED', 'productCondition', null), node('603', '601', 'UNIT_EXCLUDED', 'productBrand', null)])
    if ('refusal' in live) throw new Error(live.refusal)
    let t = -1
    const plan = pmaxTreeOps(C, `${C}/assetGroups/41`, live.root, null, () => t--)
    expect(plan.removes.map((o) => (o.assetGroupListingGroupFilterOperation as { remove: string }).remove.split('~')[1])).toEqual(['604', '605', '602', '603', '601'])
    expect(plan.creates).toEqual([])
    const snap = pmaxSnapshot(live.root)!
    const spec = pmaxSpecOfSnapshot(snap)
    if ('refusal' in spec) throw new Error(spec.refusal)
    const again = pmaxTreeOfSpec(spec, 'tree')
    if ('refusal' in again) throw new Error(again.refusal)
    expect(pmaxSnapshot(again.root)).toEqual(snap)
    expect(pmaxTreeWidens(live.root, again.root)).toEqual([])
  })

  it('a YouTube link is read as its id', () => {
    expect(youtubeIdOf('https://www.youtube.com/watch?v=abcdefghijk')).toBe('abcdefghijk')
    expect(youtubeIdOf('https://youtu.be/abcdefghijk')).toBe('abcdefghijk')
    expect(youtubeIdOf('not a video')).toBeNull()
  })

  it('after the run every temporary id Google answered for is its id', () => {
    const ops: GoogleMutateOperation[] = [
      { assetOperation: { create: { resourceName: `${C}/assets/-3`, textAsset: { text: 'x' } } } },
      { assetGroupOperation: { create: { resourceName: `${C}/assetGroups/-4`, name: 'G' } } },
    ]
    const ids = idsFromRun(ops, [{ assetResult: { resourceName: `${C}/assets/801` } }, { assetGroupResult: { resourceName: `${C}/assetGroups/45` } }])
    expect(pmaxRecordAfterRun({ groups: [{ assetGroupId: 'tmp:-4', links: ['tmp:-3~HEADLINE'] }] }, ops, [{ assetResult: { resourceName: `${C}/assets/801` } }, { assetGroupResult: { resourceName: `${C}/assetGroups/45` } }]))
      .toEqual({ groups: [{ assetGroupId: '45', links: ['801~HEADLINE'] }] })
    expect(ids.get('tmp:-3')).toBe('801')
  })
})

describe('customer acquisition', () => {
  const campaign = { campaignId: '21', name: 'PMax A', status: 'ENABLED' }
  it('the account goal: made when there is none, its raise SPENDS MONEY', () => {
    const d = acquisitionDraft(C, 'EUR', { accountGoal: { newCustomerValueCents: 500 } }, { goal: null, config: null, campaign: null })
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([{ accountCall: { path: 'Goals:mutate', body: { operations: [{ create: { newCustomerAcquisitionGoalSettings: { valueSettings: { additionalValue: 5 } } } }] } } }])
    expect(d.spendsMoney).toHaveLength(1)
  })
  it('a campaign: BID_HIGHER makes its config (SPENDS MONEY when enabled), ONLY_NEW takes no override, OFF removes it', () => {
    const goal = { goalId: '81', resourceName: `${C}/goals/81`, eligibility: 'ELIGIBLE', valueCents: 500, highValueCents: null }
    const d = acquisitionDraft(C, 'EUR', { campaignId: '21', mode: 'BID_HIGHER', valueOverride: { newCustomerValueCents: 700 } }, { goal, config: null, campaign })
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations[0]).toEqual({ accountCall: { path: 'CampaignGoalConfigs:mutate', body: { operations: [{ create: { campaign: `${C}/campaigns/21`, goal: `${C}/goals/81`, campaignNewCustomerAcquisitionSettings: { targetOption: 'TARGET_ALL', valueSettingsOverride: { additionalValue: 7 } } } }] } } })
    expect(d.spendsMoney.join(' ')).toMatch(/bids higher for new customers/)
    const only = acquisitionDraft(C, 'EUR', { campaignId: '21', mode: 'ONLY_NEW', valueOverride: { newCustomerValueCents: 700 } }, { goal, config: null, campaign })
    expect('refusal' in only && only.refusal).toMatch(/TARGET_SPECIFIC_OPTION/)
    const config = { resourceName: `${C}/campaignGoalConfigs/21~81`, goalId: '81', mode: 'TARGET_SPECIFIC', valueCents: null, highValueCents: null }
    const off = acquisitionDraft(C, 'EUR', { campaignId: '21', mode: 'OFF' }, { goal, config, campaign })
    if ('refusal' in off) throw new Error(off.refusal)
    expect(off.operations[0]).toEqual({ accountCall: { path: 'CampaignGoalConfigs:mutate', body: { operations: [{ remove: `${C}/campaignGoalConfigs/21~81` }] } } })
    expect(off.spendsMoney.join(' ')).toMatch(/no longer kept to new customers only/)
    expect(acquisitionDraft(C, 'EUR', { campaignId: '21', mode: 'BID_HIGHER' }, { goal: null, config: null, campaign })).toEqual({ refusal: expect.stringMatching(/no new-customer acquisition goal yet/) })
    expect(acquisitionDraft(C, 'EUR', { accountGoal: { newCustomerValueCents: 5 }, campaignId: '21', mode: 'OFF' }, { goal, config, campaign })).toEqual({ refusal: expect.stringMatching(/two requests/) })
  })
})
