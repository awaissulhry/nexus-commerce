/**
 * Google Ads changes, PR 6 (2026-10-15) — build, copy and check, as the gate uses them (Google, the account and the live
 * reads are stand-ins): a copy reads the live campaign and makes it again PAUSED under the new name, with its tree, its
 * keywords and bids; the check runs a change tool's own preview on Google's check and asks for nothing; undo removes what
 * the build made, on the same account.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ mutate: vi.fn(), detail: null as unknown, tree: [] as unknown[] }))
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
vi.mock('../../marketing/google-ads/live-product-groups.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live-product-groups.js')>()),
  liveProductGroupTree: vi.fn(async () => ({ adGroup: null, nodes: structuredClone(h.tree) })),
}))
vi.mock('../../marketing/google-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/write-client.js')>()),
  mutateGoogleAds: h.mutate,
}))
vi.mock('../../marketing/google-ads/enqueue.js', () => ({ enqueueGoogleAdsSync: vi.fn(async () => ({ queued: true, reason: null })) }))

import { GOOGLE_ADS_BUILD_TOOLS } from './google-ads-build.tools.js'
import type { ToolContext } from '../tool-types.js'

const tool = (name: string) => GOOGLE_ADS_BUILD_TOOLS.find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })

beforeEach(() => {
  h.mutate.mockReset()
  h.detail = {
    campaign: {
      campaignId: '21', name: 'Shop A', status: 'ENABLED', type: 'SHOPPING', bidding: 'MANUAL_CPC', biddingStrategyId: null,
      shopping: { merchantId: '5', feedLabel: 'IT', priority: 'HIGH' }, budget: { budgetId: '11', name: 'Shared A', amountCents: 1500, shared: true },
      networks: { googleSearch: true, searchPartners: false, display: false, partnerSearch: false }, locationOption: { include: 'PRESENCE', exclude: 'PRESENCE' },
      audienceMode: [], euPoliticalAds: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING', aiMax: false, keywordMatchType: null, assetAutomation: [], localInventory: false,
      maxCpcCeilingCents: null, targetCpaCents: null, targetRoas: null,
    },
    criteria: { locations: [{ criterionId: '1', type: 'LOCATION', negative: false, location: 'geoTargetConstants/2380' }], languages: [], schedule: [{ criterionId: '2', type: 'AD_SCHEDULE', negative: false, schedule: { day: 'MONDAY', from: '08:00', to: '24:00' } }], audiences: [], negativeKeywords: [{ criterionId: '3', type: 'KEYWORD', negative: true, keyword: { text: 'used', matchType: 'PHRASE' } }], other: [] },
    negativeLists: [{ listId: '31', name: 'List A' }],
    otherSharedSets: [],
    adGroups: [{ adGroupId: '51', name: 'Group A', status: 'ENABLED', type: 'SHOPPING_PRODUCT_ADS', cpcBidCents: 25 }],
    keywords: [{ adGroupId: '51', criterionId: '9', text: 'kids', matchType: 'PHRASE', negative: true, status: 'ENABLED', cpcBidCents: null, effectiveCpcBidCents: null, approval: null }],
    productGroups: [], ads: [], assets: [], notRead: [],
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
})
