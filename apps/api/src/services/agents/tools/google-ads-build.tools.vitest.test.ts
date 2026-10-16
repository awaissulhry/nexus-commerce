/**
 * Google Ads changes, PR 6 (2026-10-15) — build, copy and check, as the gate uses them (Google, the account and the live
 * reads are stand-ins): a copy reads the live campaign and makes it again PAUSED under the new name, with its tree, its
 * keywords and bids; the check runs a change tool's own preview on Google's check and asks for nothing; undo removes what
 * the build made, on the same account.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  mutate: vi.fn(), detail: null as unknown, tree: [] as unknown[],
  // G13: the parts a copy reads beyond the campaign detail (whose criteria rows hold devices, radius, audiences,
  // demographics, exclusions, brand lists and the inventory filter).
  groupCriteria: [] as unknown[], groupDevices: [] as unknown[], others: [] as unknown[], groupLinks: [] as unknown[], labels: [] as unknown[],
  labelLinks: [] as unknown[], goals: { level: 'CUSTOMER', customGoalId: null, goals: [] } as unknown,
  // G14b: a Search campaign's AI Max controls as liveSearchAi reads them; the account's page feeds.
  searchAi: {} as unknown, feeds: [] as unknown[],
}))
vi.mock('../../marketing/google-ads/live-search-ai.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live-search-ai.js')>()),
  liveSearchAi: vi.fn(async () => structuredClone(h.searchAi)),
}))
vi.mock('../../marketing/google-ads/live-pmax.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live-pmax.js')>()),
  livePageFeeds: vi.fn(async () => structuredClone(h.feeds)),
}))
vi.mock('../../marketing/google-ads/change-account.js', () => ({
  googleChangeAccount: vi.fn(async () => ({
    target: { connectionId: 'g-1', customerId: '1234567890', loginCustomerId: null }, accountId: 'g-1', customerId: '1234567890', name: 'Shop', currency: 'EUR', timeZone: 'Europe/Rome',
  })),
}))
vi.mock('../../marketing/google-ads/live.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live.js')>()),
  liveCampaigns: vi.fn(async () => [{ campaignId: '21', name: 'Shop A', status: 'PAUSED', type: 'SHOPPING', budget: { budgetId: '11', name: 'Shared A', amountCents: 1500, shared: true } }]),
  liveBudgets: vi.fn(async () => [{ budgetId: '11', name: 'Shared A', amountCents: 1500, shared: true, usedBy: 1, campaigns: [] }]),
  liveNegativeLists: vi.fn(async () => [{ listId: '31', name: 'List A', keywordCount: 1, campaigns: [] }]),
  liveCampaignDetail: vi.fn(async () => structuredClone(h.detail)),
}))
vi.mock('../../marketing/google-ads/live-targeting.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live-targeting.js')>()),
  liveAdGroupTargeting: vi.fn(async () => structuredClone(h.groupCriteria)),
  liveAdGroupDevices: vi.fn(async () => structuredClone(h.groupDevices)),
}))
vi.mock('../../marketing/google-ads/live-labels.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live-labels.js')>()),
  liveLabels: vi.fn(async () => structuredClone(h.labels)),
}))
vi.mock('../../marketing/google-ads/live-copy.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live-copy.js')>()),
  liveAdGroupOtherCriteria: vi.fn(async () => structuredClone(h.others)),
  liveCampaignAdGroupLinks: vi.fn(async () => structuredClone(h.groupLinks)),
  liveCampaignLabels: vi.fn(async () => structuredClone(h.labelLinks)),
  liveCampaignGoals: vi.fn(async () => structuredClone(h.goals)),
  // Every tree of the campaign in one read (ad group 51's).
  liveCampaignProductGroupNodes: vi.fn(async () => new Map([['51', structuredClone(h.tree)]])),
}))
vi.mock('../../marketing/google-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/write-client.js')>()),
  mutateGoogleAds: h.mutate,
}))
vi.mock('../../marketing/google-ads/enqueue.js', () => ({ enqueueGoogleAdsSync: vi.fn(async () => ({ queued: true, reason: null })) }))
vi.mock('../../marketing/google-ads/asset-images.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/asset-images.js')>()),
  prepareImage: vi.fn(async () => ({ source: 'https://shop.example/a.png', label: 'a', mimeType: 'image/png', bytes: 1000, width: 1200, height: 628, sha256: 'f00d', data: 'AAAA' })),
}))

import { GOOGLE_ADS_BUILD_TOOLS } from './google-ads-build.tools.js'
import type { ToolContext } from '../tool-types.js'

const tool = (name: string) => GOOGLE_ADS_BUILD_TOOLS.find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })

beforeEach(() => {
  h.mutate.mockReset()
  Object.assign(h, { groupCriteria: [], groupDevices: [], others: [], groupLinks: [], labels: [], labelLinks: [], goals: { level: 'CUSTOMER', customGoalId: null, goals: [] }, searchAi: {}, feeds: [] })
  h.detail = {
    campaign: {
      campaignId: '21', name: 'Shop A', status: 'ENABLED', type: 'SHOPPING', bidding: 'MANUAL_CPC', biddingStrategyId: null,
      shopping: { merchantId: '5', feedLabel: 'IT', priority: 'HIGH' }, budget: { budgetId: '11', name: 'Shared A', amountCents: 1500, shared: true },
      networks: { googleSearch: true, searchPartners: false, display: false, partnerSearch: false }, locationOption: { include: 'PRESENCE', exclude: 'PRESENCE' },
      audienceMode: [], euPoliticalAds: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING', aiMax: false, keywordMatchType: null, assetAutomation: [], localInventory: false,
      maxCpcCeilingCents: null, targetCpaCents: null, targetRoas: null, trackingTemplate: null, finalUrlSuffix: null, customParameters: [], ignoreBrandExclusions: false,
      experimentType: 'BASE', subType: null, manualCpcEnhanced: false,
    },
    criteria: { locations: [{ criterionId: '1', type: 'LOCATION', negative: false, location: 'geoTargetConstants/2380' }], languages: [], schedule: [{ criterionId: '2', type: 'AD_SCHEDULE', negative: false, schedule: { day: 'MONDAY', from: '08:00', to: '24:00' } }], audiences: [], negativeKeywords: [{ criterionId: '3', type: 'KEYWORD', negative: true, keyword: { text: 'used', matchType: 'PHRASE' } }], other: [] },
    negativeLists: [{ listId: '31', name: 'List A' }],
    otherSharedSets: [],
    adGroups: [{ adGroupId: '51', name: 'Group A', status: 'ENABLED', type: 'SHOPPING_PRODUCT_ADS', cpcBidCents: 25, targetCpaCents: null, targetRoas: null, rotation: null, urls: { trackingTemplate: null, finalUrlSuffix: null, customParameters: [] }, audienceMode: [] }],
    keywords: [{ adGroupId: '51', criterionId: '9', text: 'kids', matchType: 'PHRASE', negative: true, status: 'ENABLED', cpcBidCents: null, effectiveCpcBidCents: null, approval: null, finalUrls: [], finalMobileUrls: [], urls: { trackingTemplate: null, finalUrlSuffix: null, customParameters: [] } }],
    productGroups: [], ads: [], assets: [], notRead: [], criteriaRows: [],
  }
  h.tree = [
    { criterionId: '601', parentId: null, kind: 'SUBDIVISION', caseValue: null, dimension: null, value: null, excluded: false, bidCents: null },
    { criterionId: '602', parentId: '601', kind: 'UNIT', caseValue: { productItemId: {} }, dimension: 'productItemId', value: null, excluded: true, bidCents: null },
    { criterionId: '603', parentId: '601', kind: 'UNIT', caseValue: { productItemId: { value: 'sku-1' } }, dimension: 'productItemId', value: 'sku-1', excluded: false, bidCents: 25 },
  ]
})

describe('PR 6 tools', () => {
  it('copy-google-campaign: the live campaign again, PAUSED, same shared budget, its negatives, list, tree and bids', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const out = await tool('copy-google-campaign').handler({ campaignId: '21', name: 'Shop A copy' }, asker)
    expect(out.ok, String(out.error)).toBe(true)
    const ops = h.mutate.mock.calls[0][1] as Array<Record<string, any>>
    expect(h.mutate.mock.calls[0][2]).toEqual({ validateOnly: true })
    const campaign = ops.find((o) => o.campaignOperation)!.campaignOperation.create
    expect(campaign).toMatchObject({ name: 'Shop A copy', status: 'PAUSED', campaignBudget: 'customers/1234567890/campaignBudgets/11', shoppingSetting: { merchantId: '5', feedLabel: 'IT', campaignPriority: 2 } })
    expect(ops).toContainEqual({ campaignSharedSetOperation: { create: { campaign: campaign.resourceName, sharedSet: 'customers/1234567890/sharedSets/31' } } })
    expect(ops.filter((o) => o.campaignCriterionOperation?.create?.negative)).toHaveLength(1)
    const tree = ops.map((o) => o.adGroupCriterionOperation?.create).filter((c) => c?.listingGroup)
    expect(tree.map((t) => [t.listingGroup.type, t.negative ?? false, t.cpcBidMicros ?? null])).toEqual([['SUBDIVISION', false, null], ['UNIT', true, null], ['UNIT', false, '250000']])
    expect(ops.find((o) => o.adGroupCriterionOperation?.create?.keyword)!.adGroupCriterionOperation.create).toMatchObject({ negative: true, keyword: { text: 'kids', matchType: 'PHRASE' } })
  })

  it('build: a Shopping ad group\'s product groups as a tree of any shape (nodes) — checked against Google\'s rules, sent parents first; itemIds still works; both, or neither, refused', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const shopping = (productGroups: unknown) => ({ campaigns: [{ type: 'SHOPPING', name: 'Shop Z', budget: { dailyBudgetCents: 500 }, shopping: { merchantId: '5' }, adGroups: [{ name: 'Group Z', productGroups }] }] })
    const tree = { nodes: [
      { split: 'BRAND' },
      { parent: 0, value: 'Brand A', split: 'CUSTOM_LABEL_0' },
      { parent: 1, value: 'top', bidCents: 40 },
      { parent: 1, everythingElse: true, bidCents: 20 },
      { parent: 0, everythingElse: true, excluded: true },
    ] }
    const build = tool('build-google-campaigns')
    expect(build.input.safeParse(shopping(tree)).success).toBe(true)
    const out = await build.handler(shopping(tree), asker)
    expect(out.ok, String(out.error)).toBe(true)
    const ops = h.mutate.mock.calls[0][1] as Array<Record<string, any>>
    const made = ops.map((o) => o.adGroupCriterionOperation?.create).filter((c) => c?.listingGroup)
    expect(made.map((c) => [c.listingGroup.type, c.listingGroup.caseValue ?? null, c.negative ?? false, c.cpcBidMicros ?? null])).toEqual([
      ['SUBDIVISION', null, false, null],
      ['SUBDIVISION', { productBrand: { value: 'Brand A' } }, false, null],
      ['UNIT', { productCustomAttribute: { index: 'INDEX0', value: 'top' } }, false, '400000'],
      ['UNIT', { productCustomAttribute: { index: 'INDEX0' } }, false, '200000'],
      ['UNIT', { productBrand: {} }, true, null],
    ])
    expect(made[1].listingGroup.parentAdGroupCriterion).toBe(made[0].resourceName)
    expect(made[2].listingGroup.parentAdGroupCriterion).toBe(made[1].resourceName)
    h.mutate.mockClear()
    expect((await build.handler(shopping({ nodes: [{ split: 'BRAND' }, { parent: 0, value: 'A', bidCents: 5 }] }), asker)).error).toMatch(/Group Z": productGroups\.nodes\[0\] is split by brand without "everything else"/)
    expect((await build.handler(shopping({ ...tree, itemIds: ['sku-1'], bidCents: 5 }), asker)).error).toMatch(/itemIds \(with bidCents\) or as nodes, not both/)
    expect((await build.handler(shopping({ itemIds: ['sku-1'] }), asker)).error).toMatch(/give productGroups.itemIds with bidCents, or productGroups.nodes/)
    expect(h.mutate).not.toHaveBeenCalled()
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    expect((await build.handler(shopping({ itemIds: ['sku-1'], bidCents: 5 }), asker)).ok).toBe(true)
  })

  it('build: one Google check of the whole build; the run records the ids; undo removes the campaigns on the same account', async () => {
    const ask = { sharedBudgets: [{ ref: 'b', name: 'Shared Z', budgetCents: 1000 }], campaigns: [{ type: 'SEARCH', name: 'Search Z', budget: { ref: 'b' }, locations: [{ id: '2380' }] }] }
    h.mutate.mockResolvedValue({ responses: [], ops: 3, requestId: null })
    const out = await tool('build-google-campaigns').handler(ask, asker)
    expect(out.ok, String(out.error)).toBe(true)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    h.mutate.mockReset()
    h.mutate.mockResolvedValue({ responses: [{ campaignBudgetResult: { resourceName: 'customers/1234567890/campaignBudgets/77' } }, { campaignResult: { resourceName: 'customers/1234567890/campaigns/88' } }, {}], ops: 3, requestId: null })
    const run = await tool('build-google-campaigns').execute!(ask, approved(out.preview))
    expect(run.ok, String(run.error)).toBe(true)
    expect(run.change?.after).toMatchObject({ campaigns: [{ name: 'Search Z', campaignId: '88' }], sharedBudgets: [{ name: 'Shared Z', budgetId: '77' }], accountId: 'g-1' })
    expect(run.change?.before).toEqual({ campaigns: [], accountId: 'g-1', customerId: '1234567890' })
    const undo = tool('build-google-campaigns').undo!.request(run.change!)
    expect(undo).toMatchObject({ tool: 'remove-google-ads-items', args: { accountId: 'g-1', items: [{ kind: 'campaign', id: '88' }, { kind: 'budget', id: '77' }], confirmRemove: true } })
  })

  it('check-google-ads-build: the build\'s own preview on Google\'s check, nothing asked for; a refusal is an answer, not an error', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const out = await tool('check-google-ads-build').handler({ campaigns: [{ copyOf: '21', name: 'Shop A copy' }] }, asker)
    expect(out).toMatchObject({ ok: true, data: { checked: true, accepted: true, preview: { googleCheck: { checked: true } } } })
    expect(h.mutate.mock.calls[0][2]).toEqual({ validateOnly: true })
    expect((out.data as { note: string }).note).toMatch(/nothing was asked for/)
    const taken = await tool('check-google-ads-build').handler({ campaigns: [{ copyOf: '21', name: 'Shop A' }] }, asker)
    expect(taken).toMatchObject({ ok: true, data: { checked: true, accepted: false, why: expect.stringContaining('already exists') } })
    // Even inside a re-check context, the check asks Google (it is never a re-check itself).
    h.mutate.mockClear()
    await tool('check-google-ads-build').handler({ campaigns: [{ copyOf: '21', name: 'Shop A copy 2' }] }, { ...asker, approvalId: 'ap-x' })
    expect(h.mutate).toHaveBeenCalledTimes(1)
    expect(tool('check-google-ads-build')).toMatchObject({ readOnly: true })
  })

  // ── G13: build/copy parity ──────────────────────────────────────────────────────────────────────────────────────

  it('copy-google-campaign (G13): a Search campaign with every part the change tools set — all carried, PAUSED; only what Google cannot take is named, with its reason', async () => {
    const urls = (t: string | null) => ({ trackingTemplate: t, finalUrlSuffix: null, customParameters: [] as Array<{ key: string; value: string }> })
    const d = h.detail as Record<string, any>
    Object.assign(d.campaign, {
      type: 'SEARCH', shopping: null, keywordMatchType: 'BROAD', locationOption: { include: 'SEARCH_INTEREST', exclude: 'PRESENCE_OR_INTEREST' },
      audienceMode: [{ dimension: 'AUDIENCE', observationOnly: true }], customParameters: [{ key: 'src', value: 'g' }], finalUrlSuffix: 'a=b',
    })
    d.criteria.other = [
      { criterionId: '4', type: 'DEVICE', negative: false }, { criterionId: '5', type: 'PROXIMITY', negative: false }, { criterionId: '6', type: 'AGE_RANGE', negative: true },
      { criterionId: '7', type: 'PLACEMENT', negative: true }, { criterionId: '8', type: 'BRAND_LIST', negative: true }, { criterionId: '10', type: 'WEBPAGE', negative: false, name: 'a page' },
    ]
    d.criteria.audiences = [{ criterionId: '11', type: 'USER_LIST', negative: false, audience: 'customers/1234567890/userLists/41' }]
    d.otherSharedSets = [{ listId: '72', name: 'Sites', type: 'NEGATIVE_PLACEMENTS' }]
    d.adGroups = [{ adGroupId: '51', name: 'Group A', status: 'ENABLED', type: 'SEARCH_STANDARD', cpcBidCents: 25, targetCpaCents: 900, targetRoas: null, rotation: 'ROTATE_FOREVER', urls: urls('{lpurl}?g=1'), audienceMode: [] }]
    d.keywords = [{ adGroupId: '51', criterionId: '9', text: 'rain jacket', matchType: 'EXACT', negative: false, status: 'ENABLED', cpcBidCents: 40, effectiveCpcBidCents: 40, approval: null, finalUrls: ['https://shop.example/rain'], finalMobileUrls: [], urls: urls(null) }]
    d.ads = [
      { adGroupId: '51', adId: '91', status: 'PAUSED', type: 'RESPONSIVE_SEARCH_AD', finalUrls: ['https://shop.example/p'], finalMobileUrls: ['https://m.shop.example/p'], urls: urls('{lpurl}?a=1'),
        headlines: [{ text: 'One', pinned: null }, { text: 'Two', pinned: null }, { text: 'Three', pinned: null }], descriptions: [{ text: 'First line.', pinned: null }, { text: 'Second line.', pinned: null }], path1: null, path2: null },
      { adGroupId: '51', adId: '92', status: 'ENABLED', type: 'EXPANDED_TEXT_AD', finalUrls: ['https://shop.example/p'], finalMobileUrls: [], urls: urls(null), headlines: [], descriptions: [], path1: null, path2: null },
    ]
    d.assets = [
      { campaignId: '21', assetId: '81', fieldType: 'CALL', status: 'PAUSED', source: 'ADVERTISER' },
      { campaignId: '21', assetId: '82', fieldType: 'SITELINK', status: 'ENABLED', source: 'AUTOMATICALLY_CREATED' },
      // A field type Nexus does not link: named, never sent (one odd link must not block the whole copy).
      { campaignId: '21', assetId: '84', fieldType: 'HOTEL_CALLOUT', status: 'ENABLED', source: 'ADVERTISER' },
    ]
    // The detail's ONE criteria read, as Google sends the rows.
    d.criteriaRows = [
      { campaignCriterion: { criterionId: '4', type: 'DEVICE', bidModifier: 1.3, device: { type: 'MOBILE' } } },
      { campaignCriterion: { criterionId: '5', type: 'PROXIMITY', proximity: { geoPoint: { latitudeInMicroDegrees: 45_500_000, longitudeInMicroDegrees: 9_200_000 }, radius: 20, radiusUnits: 'KILOMETERS' } } },
      { campaignCriterion: { criterionId: '6', type: 'AGE_RANGE', negative: true, ageRange: { type: 'AGE_RANGE_18_24' } } },
      { campaignCriterion: { criterionId: '11', type: 'USER_LIST', bidModifier: 1.5, userList: { userList: 'customers/1234567890/userLists/41' } } },
      { campaignCriterion: { criterionId: '7', type: 'PLACEMENT', negative: true, placement: { url: 'example.com' } } },
      { campaignCriterion: { criterionId: '8', type: 'BRAND_LIST', negative: true, brandList: { sharedSet: 'customers/1234567890/sharedSets/71' } } },
    ]
    h.groupCriteria = [{ adGroupId: '51', criterionId: '12', type: 'GENDER', negative: true, bidModifier: null, demographic: { dimension: 'GENDER', value: 'FEMALE' } }]
    h.groupDevices = [{ adGroupId: '51', criterionId: '13', device: 'DESKTOP', bidModifier: 1.2 }]
    h.others = [
      { adGroupId: '51', criterionId: '14', type: 'BRAND_LIST', negative: false, name: null, listId: '74' },
      { adGroupId: '51', criterionId: '15', type: 'WEBPAGE', negative: false, name: 'all pages', listId: null },
    ]
    h.groupLinks = [{ level: 'ad-group', adGroupId: '51', assetId: '83', fieldType: 'PRICE', status: 'ENABLED', source: 'ADVERTISER' }]
    h.labels = [{ labelId: '61', name: 'L', color: null, description: null }]
    h.labelLinks = [
      { kind: 'campaign', id: '21', labelId: '61' }, { kind: 'ad-group', id: '51', labelId: '61' },
      { kind: 'keyword', id: '51~9', labelId: '61', criterionType: 'KEYWORD' }, { kind: 'ad', id: '51~91', labelId: '61' },
      // A label on an audience criterion goes with it; one on a brand list (not labelled by the copy) is named.
      { kind: 'keyword', id: '51~12', labelId: '61', criterionType: 'GENDER' }, { kind: 'keyword', id: '51~14', labelId: '61', criterionType: 'BRAND_LIST' },
    ]
    h.goals = { level: 'CAMPAIGN', customGoalId: '73', goals: [{ category: 'PURCHASE', origin: 'WEBSITE', biddable: true }] }
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const out = await tool('copy-google-campaign').handler({ campaignId: '21', name: 'Search A copy' }, asker)
    expect(out.ok, String(out.error)).toBe(true)
    const ops = h.mutate.mock.calls[0][1] as Array<Record<string, any>>
    const made = (kind: string) => ops.filter((o) => o[kind]?.create).map((o) => o[kind].create)
    const campaign = made('campaignOperation')[0]
    expect(campaign).toMatchObject({
      status: 'PAUSED', geoTargetTypeSetting: { positiveGeoTargetType: 'SEARCH_INTEREST', negativeGeoTargetType: 'PRESENCE_OR_INTEREST' },
      targetingSetting: { targetRestrictions: [{ targetingDimension: 'AUDIENCE', bidOnly: true }] }, urlCustomParameters: [{ key: 'src', value: 'g' }], finalUrlSuffix: 'a=b',
    })
    const criteria = made('campaignCriterionOperation')
    expect(criteria).toContainEqual({ campaign: campaign.resourceName, device: { type: 'MOBILE' }, bidModifier: 1.3 })
    expect(criteria).toContainEqual(expect.objectContaining({ proximity: expect.objectContaining({ radius: 20 }) }))
    expect(criteria).toContainEqual({ campaign: campaign.resourceName, negative: true, ageRange: { type: 'AGE_RANGE_18_24' } })
    expect(criteria).toContainEqual({ campaign: campaign.resourceName, bidModifier: 1.5, userList: { userList: 'customers/1234567890/userLists/41' } })
    expect(criteria).toContainEqual({ campaign: campaign.resourceName, negative: true, placement: { url: 'example.com' } })
    expect(criteria).toContainEqual({ campaign: campaign.resourceName, negative: true, brandList: { sharedSet: 'customers/1234567890/sharedSets/71' } })
    expect(made('campaignSharedSetOperation')).toContainEqual({ campaign: campaign.resourceName, sharedSet: 'customers/1234567890/sharedSets/72' })
    expect(made('campaignLabelOperation')).toHaveLength(1)
    expect(made('adGroupLabelOperation')).toHaveLength(1)
    expect(made('adGroupCriterionLabelOperation')).toHaveLength(2)
    const gender = made('adGroupCriterionOperation').find((c) => c.gender)
    expect(gender).toMatchObject({ resourceName: expect.stringMatching(/adGroupCriteria\/-\d+~-\d+$/), negative: true })
    expect(made('adGroupCriterionLabelOperation').map((l) => l.adGroupCriterion)).toContain(gender.resourceName)
    // The custom goal is never sent on the new campaign's temporary id.
    expect(ops.some((o) => o.conversionGoalCampaignConfigOperation)).toBe(false)
    expect(made('adGroupAdLabelOperation')).toHaveLength(1)
    const group = made('adGroupOperation')[0]
    expect(group).toMatchObject({ targetCpaMicros: '9000000', adRotationMode: 'ROTATE_FOREVER', trackingUrlTemplate: '{lpurl}?g=1' })
    expect(made('adGroupBidModifierOperation')).toEqual([{ adGroup: group.resourceName, device: { type: 'DESKTOP' }, bidModifier: 1.2 }])
    expect(made('adGroupCriterionOperation')).toContainEqual(expect.objectContaining({ adGroup: group.resourceName, negative: true, gender: { type: 'FEMALE' } }))
    expect(made('adGroupCriterionOperation')).toContainEqual({ adGroup: group.resourceName, brandList: { sharedSet: 'customers/1234567890/sharedSets/74' } })
    expect(made('adGroupCriterionOperation').find((c) => c.keyword)).toMatchObject({ finalUrls: ['https://shop.example/rain'], cpcBidMicros: '400000' })
    expect(made('adGroupAdOperation')).toEqual([expect.objectContaining({ status: 'PAUSED', ad: expect.objectContaining({ finalMobileUrls: ['https://m.shop.example/p'], trackingUrlTemplate: '{lpurl}?a=1' }) })])
    expect(made('campaignAssetOperation')).toEqual([{ campaign: campaign.resourceName, asset: 'customers/1234567890/assets/81', fieldType: 'CALL', status: 'PAUSED' }])
    expect(made('adGroupAssetOperation')).toEqual([{ adGroup: group.resourceName, asset: 'customers/1234567890/assets/83', fieldType: 'PRICE' }])
    const temp = campaign.resourceName.split('/').pop()
    expect(ops).toContainEqual({ campaignConversionGoalOperation: { update: { resourceName: `customers/1234567890/campaignConversionGoals/${temp}~PURCHASE~WEBSITE`, biddable: true }, updateMask: 'biddable' } })
    // Only what Google's API cannot take, or no Nexus tool sets, is named — each with its reason.
    const preview = out.preview as { skipped: string[]; spendsMoney: boolean }
    expect(preview.spendsMoney).toBe(false)
    expect(preview.skipped).toEqual([
      'Not copied — "Search A copy": the custom conversion goal 73 (no Nexus tool sets a custom goal, and Google shows no way to set one on a campaign made in the same request: set it in Google Ads after the copy).',
      'Not copied — "Search A copy": campaign-level broad match (Google Ads API v25 no longer lets it be set: CANNOT_SET_CAMPAIGN_KEYWORD_MATCH_TYPE).',
      'Not copied — "Search A copy": campaign criterion a page (WEBPAGE: no Nexus tool sets this kind).',
      'Not copied — "Search A copy": criterion all pages (WEBPAGE) of "Group A" (no Nexus tool sets this kind).',
      'Not copied — "Search A copy": ad 92 (EXPANDED_TEXT_AD) in "Group A" (Google no longer lets an expanded text ad be made).',
      'Not copied — "Search A copy": asset 82 (SITELINK) (Google linked it itself; it makes its own for the copy).',
      'Not copied — "Search A copy": asset 84 (HOTEL_CALLOUT) (no Nexus tool links this field type).',
      'Not copied — "Search A copy": label 61 on criterion 51~14 (BRAND_LIST) (it is on a part the copy does not carry).',
    ])
  })

  it('copy-google-campaign (G13): a Shopping campaign keeps its inventory filter, Shopping settings and product ad', async () => {
    const d = h.detail as Record<string, any>
    d.campaign.ignoreBrandExclusions = true
    d.ads = [{ adGroupId: '51', adId: '95', status: 'PAUSED', type: 'SHOPPING_PRODUCT_AD', finalUrls: [], finalMobileUrls: [], urls: { trackingTemplate: null, finalUrlSuffix: null, customParameters: [] }, headlines: [], descriptions: [], path1: null, path2: null }]
    d.criteriaRows = [{ campaignCriterion: { criterionId: '20', type: 'LISTING_SCOPE', listingScope: { dimensions: [{ productCustomAttribute: { index: 'INDEX0', value: 'top' } }] } } }]
    d.criteria.other = [{ criterionId: '20', type: 'LISTING_SCOPE', negative: false }]
    // A label on a product group node goes with the node.
    h.labels = [{ labelId: '62', name: 'L', color: null, description: null }]
    h.labelLinks = [{ kind: 'keyword', id: '51~603', labelId: '62', criterionType: 'LISTING_GROUP' }]
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const out = await tool('copy-google-campaign').handler({ campaignId: '21', name: 'Shop A copy' }, asker)
    expect(out.ok, String(out.error)).toBe(true)
    const ops = h.mutate.mock.calls[0][1] as Array<Record<string, any>>
    const campaign = ops.find((o) => o.campaignOperation)!.campaignOperation.create
    expect(campaign.shoppingSetting).toMatchObject({ ignoreBrandExclusionInShoppingAds: true })
    expect(ops.map((o) => o.campaignCriterionOperation?.create).filter((c) => c?.listingScope)).toEqual([{ campaign: campaign.resourceName, listingScope: { dimensions: [{ productCustomAttribute: { index: 'INDEX0', value: 'top' } }] } }])
    expect(ops.find((o) => o.adGroupAdOperation)!.adGroupAdOperation.create).toMatchObject({ status: 'PAUSED', ad: { shoppingProductAd: {} } })
    const sku = ops.map((o) => o.adGroupCriterionOperation?.create).find((c) => c?.listingGroup?.caseValue?.productItemId?.value === 'sku-1')
    expect(ops.filter((o) => o.adGroupCriterionLabelOperation).map((o) => o.adGroupCriterionLabelOperation.create)).toEqual([{ adGroupCriterion: sku.resourceName, label: 'customers/1234567890/labels/62' }])
    expect((out.preview as { skipped?: string[] }).skipped ?? []).toEqual([])
  })

  it('copy-google-campaign (G13): another campaign type is a plain refusal naming the tool for it; a Google draft is refused', async () => {
    const d = h.detail as Record<string, any>
    const ask = async () => (await tool('copy-google-campaign').handler({ campaignId: '21', name: 'Copy' }, asker)).error
    d.campaign.type = 'PERFORMANCE_MAX'
    expect(await ask()).toMatch(/Performance Max campaign: copy it with copy-google-pmax/)
    d.campaign.type = 'DEMAND_GEN'
    expect(await ask()).toMatch(/create-google-demand-gen-campaign/)
    d.campaign.type = 'DISPLAY'
    expect(await ask()).toMatch(/create-google-display-campaign/)
    d.campaign.type = 'MULTI_CHANNEL'
    expect(await ask()).toMatch(/App campaign: .*create-google-app-campaign/)
    d.campaign.type = 'VIDEO'
    expect(await ask()).toMatch(/Google's API cannot make Video campaigns/)
    d.campaign.type = 'SHOPPING'
    d.campaign.experimentType = 'DRAFT'
    expect(await ask()).toMatch(/is a Google draft .*Copy its base campaign/)
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('build (G13): new assets of every type at the campaign and its ad groups; a library image needs the image library permission', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const ask = { campaigns: [{
      type: 'SEARCH', name: 'Search N', budget: { dailyBudgetCents: 500 },
      assets: { images: [{ fieldType: 'AD_IMAGE', imageUrl: 'https://shop.example/a.png' }], businessNames: ['Shop'] },
      adGroups: [{ name: 'G', assets: { calls: [{ countryCode: 'IT', phoneNumber: '000 111 2222' }] } }],
    }] }
    const out = await tool('build-google-campaigns').handler(ask, asker)
    expect(out.ok, String(out.error)).toBe(true)
    const ops = h.mutate.mock.calls[0][1] as Array<Record<string, any>>
    const assets = ops.filter((o) => o.assetOperation).map((o) => o.assetOperation.create)
    expect(assets.map((a) => Object.keys(a).find((k) => k.endsWith('Asset')))).toEqual(['callAsset', 'imageAsset', 'textAsset'])
    expect(ops.filter((o) => o.campaignAssetOperation).map((o) => o.campaignAssetOperation.create.fieldType)).toEqual(['AD_IMAGE', 'BUSINESS_NAME'])
    expect(ops.filter((o) => o.adGroupAssetOperation).map((o) => o.adGroupAssetOperation.create.fieldType)).toEqual(['CALL'])
    expect((out.preview as { warnings: string[] }).warnings).toContain('Call or lead form assets are linked in the new campaigns: once a campaign is enabled, people can call or open the form from its ads, each charged like a click.')
    h.mutate.mockClear()
    const library = { campaigns: [{ type: 'SEARCH', name: 'Search L', budget: { dailyBudgetCents: 500 }, assets: { images: [{ fieldType: 'AD_IMAGE', libraryImageId: 'da_123' }] } }] }
    const refused = await tool('build-google-campaigns').handler(library, { ...asker, can: (p: string) => p !== 'assets.manage' && !p.includes('assets') })
    expect(refused.ok).toBe(false)
    expect(refused.error).toMatch(/image library/)
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('copy (G13 review): a standard Target CPA campaign is copied as Maximize conversions with the target, and the preview says so', async () => {
    const d = h.detail as Record<string, any>
    Object.assign(d.campaign, { type: 'SEARCH', shopping: null, bidding: 'TARGET_CPA', standardTargetCpaCents: 900 })
    d.adGroups = []
    d.keywords = []
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const out = await tool('copy-google-campaign').handler({ campaignId: '21', name: 'Search A copy' }, asker)
    expect(out.ok, String(out.error)).toBe(true)
    const campaign = (h.mutate.mock.calls[0][1] as Array<Record<string, any>>).find((o) => o.campaignOperation)!.campaignOperation.create
    expect(campaign.maximizeConversions).toEqual({ targetCpaMicros: '9000000' })
    expect((out.preview as { warnings: string[] }).warnings).toContain('Copy "Search A copy": "Shop A" bids with standard Target CPA, which v25 takes as a portfolio strategy only: the copy bids Maximize conversions with the same target CPA, Google\'s standard form of it.')
  })

  it('build (G13 review): a campaign\'s own conversion goals need the bids permission, as set-google-conversion-goals does', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const ask = { campaigns: [{ type: 'SEARCH', name: 'Search G', budget: { dailyBudgetCents: 500 }, conversionGoals: [{ category: 'PURCHASE', origin: 'WEBSITE', biddable: true }] }] }
    const refused = await tool('build-google-campaigns').handler(ask, { ...asker, can: (p: string) => p !== 'ads.bids.edit' && !p.includes('bids') })
    expect(refused.ok).toBe(false)
    expect(refused.error).toMatch(/conversionGoals\) need the .* permission/)
    expect(h.mutate).not.toHaveBeenCalled()
    expect((await tool('build-google-campaigns').handler(ask, asker)).ok).toBe(true)
  })
})

describe('G14b: AI Max\'s controls in a Search build and copy', () => {
  it('copy-google-campaign carries a Search campaign\'s text guidelines, page feeds, URL exclusions and an ad group\'s URL inclusions (none named as not copied)', async () => {
    const d = h.detail as Record<string, any>
    Object.assign(d.campaign, { type: 'SEARCH', shopping: null, aiMax: true, assetAutomation: [{ type: 'TEXT_ASSET_AUTOMATION', status: 'OPTED_IN' }] })
    d.criteria.other = [{ criterionId: '16', type: 'WEBPAGE', negative: true, name: 'x' }]
    d.adGroups = [{ adGroupId: '51', name: 'Group A', status: 'ENABLED', type: 'SEARCH_STANDARD', cpcBidCents: 25, targetCpaCents: null, targetRoas: null, rotation: null, urls: { trackingTemplate: null, finalUrlSuffix: null, customParameters: [] }, audienceMode: [] }]
    d.keywords = []; d.ads = []; d.assets = []; d.criteriaRows = []
    h.others = [{ adGroupId: '51', criterionId: '17', type: 'WEBPAGE', negative: false, name: 'Include', listId: null }]
    h.feeds = [{ assetSetId: '77', name: 'Pages A' }]
    h.searchAi = {
      textGuidelines: { termExclusions: ['cheap'], messagingRestrictions: ['Never mention prices'] },
      pageFeeds: [{ assetSetId: '77', name: 'Pages A' }],
      webpageCriteria: [{ criterionId: '16', type: 'WEBPAGE', negative: true, bidModifier: null, webpage: { name: 'x', conditions: [{ operand: 'URL', operator: 'CONTAINS', argument: '/outlet' }] } }],
      adGroups: [{ adGroupId: '51', name: 'Group A', status: 'ENABLED', type: 'SEARCH_STANDARD', rules: [{ criterionId: '17', name: 'Include', rule: { urlContains: ['/jackets'], labels: ['sale'] } }], otherWebpage: 0 }],
    }
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const out = await tool('copy-google-campaign').handler({ campaignId: '21', name: 'Search A copy' }, asker)
    expect(out.ok, String(out.error)).toBe(true)
    const ops = h.mutate.mock.calls[0][1] as Array<Record<string, any>>
    const made = (kind: string) => ops.filter((o) => o[kind]?.create).map((o) => o[kind].create)
    const campaign = made('campaignOperation')[0]
    expect(campaign.textGuidelines).toEqual({ termExclusions: ['cheap'], messagingRestrictions: [{ restrictionText: 'Never mention prices', restrictionType: 'RESTRICTION_BASED_EXCLUSION' }] })
    expect(made('campaignAssetSetOperation')).toEqual([{ campaign: campaign.resourceName, assetSet: 'customers/1234567890/assetSets/77' }])
    expect(made('campaignCriterionOperation')).toContainEqual({ campaign: campaign.resourceName, negative: true, webpage: { criterionName: 'Exclude contains:/outlet', conditions: [{ operand: 'URL', operator: 'CONTAINS', argument: '/outlet' }] } })
    const group = made('adGroupOperation')[0]
    expect(made('adGroupCriterionOperation')).toContainEqual({ adGroup: group.resourceName, webpage: { criterionName: 'Include URL contains "/jackets" and label "sale"', conditions: [{ operand: 'URL', operator: 'CONTAINS', argument: '/jackets' }, { operand: 'CUSTOM_LABEL', operator: 'EQUALS', argument: 'sale' }] } })
    expect(((out.preview as { skipped?: string[] }).skipped ?? []).filter((x) => /WEBPAGE/.test(x))).toEqual([])
  })

  it('copy-google-campaign: with AI Max off, URL inclusions the source still holds are named as not copied, and the rest is copied', async () => {
    const d = h.detail as Record<string, any>
    Object.assign(d.campaign, { type: 'SEARCH', shopping: null, aiMax: false, assetAutomation: [] })
    d.adGroups = [{ adGroupId: '51', name: 'Group A', status: 'ENABLED', type: 'SEARCH_STANDARD', cpcBidCents: 25, targetCpaCents: null, targetRoas: null, rotation: null, urls: { trackingTemplate: null, finalUrlSuffix: null, customParameters: [] }, audienceMode: [] }]
    d.keywords = []; d.ads = []; d.assets = []; d.criteriaRows = []
    h.others = [{ adGroupId: '51', criterionId: '17', type: 'WEBPAGE', negative: false, name: 'Include', listId: null }]
    h.searchAi = {
      textGuidelines: { termExclusions: [], messagingRestrictions: [] }, pageFeeds: [], webpageCriteria: [],
      adGroups: [{ adGroupId: '51', name: 'Group A', status: 'ENABLED', type: 'SEARCH_STANDARD', rules: [{ criterionId: '17', name: 'Include', rule: { urlContains: ['/jackets'] } }], otherWebpage: 0 }],
    }
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const out = await tool('copy-google-campaign').handler({ campaignId: '21', name: 'Search A copy' }, asker)
    expect(out.ok, String(out.error)).toBe(true)
    const ops = h.mutate.mock.calls[0][1] as Array<Record<string, any>>
    expect(ops.filter((o) => o.adGroupCriterionOperation?.create?.webpage)).toEqual([])
    expect(ops.filter((o) => o.adGroupOperation?.create)).toHaveLength(1)
    const skipped = (out.preview as { skipped?: string[] }).skipped ?? []
    expect(skipped.filter((x) => /URL inclusion/.test(x))).toEqual([expect.stringMatching(/1 URL inclusion of "Group A" \(URL contains "\/jackets"\): URL inclusions need AI Max on/)])
    // Named once: not again as a criterion no Nexus tool sets.
    expect(skipped.filter((x) => /WEBPAGE/.test(x))).toEqual([])
  })

  it('build-google-campaigns: URL inclusions need AI Max and text customization; a page feed must be one of the account\'s', async () => {
    h.feeds = [{ assetSetId: '77', name: 'Pages A' }]
    const base = { type: 'SEARCH', name: 'Search Z', budget: { dailyBudgetCents: 500 }, adGroups: [{ name: 'G', urlInclusions: [{ urlContains: ['/jackets'] }] }] }
    const off = await tool('build-google-campaigns').handler(tool('build-google-campaigns').input.parse({ campaigns: [base] }) as Record<string, unknown>, asker)
    expect(off).toMatchObject({ ok: false, error: expect.stringMatching(/URL inclusions only with AI Max and text customization on/) })
    const feed = await tool('build-google-campaigns').handler(tool('build-google-campaigns').input.parse({ campaigns: [{ ...base, adGroups: [], pageFeeds: ['79'] }] }) as Record<string, unknown>, asker)
    expect(feed).toMatchObject({ ok: false, error: expect.stringMatching(/page feed 79 is not a page feed of this account/) })
    expect(h.mutate).not.toHaveBeenCalled()
  })
})
