/**
 * Google Ads Performance Max (programme 2, G10) — the four tools as the gate uses them (Google, the account, the live reads
 * and the image fetch are stand-ins): one Google check per preview, the run as the approver, the ids Google gave in the
 * record, undo on the same account (current = the record while nothing moved; the inverse parses as the tool's arguments).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PmaxAssetGroup, PmaxCampaignLive, PmaxLink } from '../../marketing/google-ads/live-pmax.js'

const h = vi.hoisted(() => ({ mutate: vi.fn(), send: vi.fn(), check: vi.fn(), campaign: null as unknown, acquisition: { goal: null as unknown, config: null as unknown } }))
vi.mock('../../marketing/google-ads/change-account.js', () => ({
  googleChangeAccount: vi.fn(async () => ({
    target: { connectionId: 'g-1', customerId: '1234567890', loginCustomerId: null }, accountId: 'g-1', customerId: '1234567890', name: 'Shop', currency: 'EUR', timeZone: 'Europe/Rome',
  })),
}))
vi.mock('../../marketing/google-ads/live.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live.js')>()),
  liveCampaigns: vi.fn(async () => [{ campaignId: '21', name: 'PMax A', status: 'ENABLED', type: 'PERFORMANCE_MAX', budget: null }]),
}))
vi.mock('../../marketing/google-ads/live-pmax.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live-pmax.js')>()),
  livePmaxCampaign: vi.fn(async () => structuredClone(h.campaign)),
  livePmaxAssets: vi.fn(async (_t: unknown, ids: string[]) => ids.filter((id) => id === '901').map((id) => ({ assetId: id, type: 'YOUTUBE_VIDEO', name: null, text: null, width: null, height: null, mimeType: null, youtubeId: 'abcdefghijk', callToAction: null }))),
  livePmaxAudiences: vi.fn(async () => [{ audienceId: '71', name: 'Buyers', scope: 'CUSTOMER', assetGroupId: null }, { audienceId: '72', name: 'Group only', scope: 'ASSET_GROUP', assetGroupId: '41' }]),
  liveBrandLists: vi.fn(async () => [{ listId: '61', name: 'Brands Z' }]),
  liveAcquisition: vi.fn(async () => structuredClone(h.acquisition)),
}))
vi.mock('../../marketing/google-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/write-client.js')>()),
  mutateGoogleAds: h.mutate,
}))
vi.mock('../../marketing/google-ads/account-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/account-client.js')>()),
  sendAccountOperations: h.send,
  checkAccountOperations: h.check,
}))
vi.mock('../../marketing/google-ads/asset-images.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/asset-images.js')>()),
  prepareImage: vi.fn(async (s: { imageUrl?: string }) => {
    const [w, hgt] = s.imageUrl?.includes('square') ? [1200, 1200] : s.imageUrl?.includes('logo') ? [512, 512] : [1200, 628]
    return { source: s.imageUrl, label: 'img', mimeType: 'image/png', bytes: 2000, width: w, height: hgt, sha256: (s.imageUrl ?? 'x').padEnd(64, '0').slice(0, 64), data: 'AAAA' }
  }),
}))
vi.mock('../../marketing/google-ads/enqueue.js', () => ({ enqueueGoogleAdsSync: vi.fn(async () => ({ queued: true, reason: null })) }))

import { GOOGLE_ADS_PMAX_TOOLS } from './google-ads-pmax.tools.js'
import { GOOGLE_CHANGE_RULES } from './google-ads-kit.js'
import type { ToolContext } from '../tool-types.js'

const C = 'customers/1234567890'
const tool = (name: string) => GOOGLE_ADS_PMAX_TOOLS.find((t) => t.name === name)!
const parsed = (name: string, args: Record<string, unknown>) => tool(name).input.parse(args) as Record<string, unknown>
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })

const link = (assetId: string, fieldType: string, text: string | null = null, over: Partial<PmaxLink> = {}): PmaxLink => ({
  assetId, fieldType, status: 'ENABLED', source: 'ADVERTISER', type: /IMAGE|LOGO/.test(fieldType) ? 'IMAGE' : 'TEXT', name: null, text, width: null, height: null, mimeType: null, youtubeId: null, callToAction: null, ...over,
})
const group = (): PmaxAssetGroup => ({
  assetGroupId: '41', name: 'Group A', status: 'ENABLED', finalUrls: ['https://shop.example/'], finalMobileUrls: [], path1: null, path2: null, adStrength: 'GOOD', primaryStatus: 'ELIGIBLE',
  assets: [
    link('301', 'HEADLINE', 'Race jackets'), link('302', 'HEADLINE', 'Leather suits'), link('303', 'HEADLINE', 'Fast delivery'), link('304', 'LONG_HEADLINE', 'Race-ready jackets'),
    link('305', 'DESCRIPTION', 'Free returns.'), link('306', 'DESCRIPTION', 'Hand-made suits.'), link('307', 'MARKETING_IMAGE'), link('308', 'SQUARE_MARKETING_IMAGE'),
    link('399', 'HEADLINE', 'Google wrote this', { source: 'AUTOMATICALLY_CREATED' }),
  ],
  tree: [
    { id: '601', parentId: null, type: 'SUBDIVISION', listingSource: 'SHOPPING', caseValue: null, dimension: null, value: null },
    { id: '602', parentId: '601', type: 'UNIT_INCLUDED', listingSource: 'SHOPPING', caseValue: { productBrand: { value: 'Brand A' } }, dimension: 'productBrand', value: 'Brand A' },
    { id: '603', parentId: '601', type: 'UNIT_EXCLUDED', listingSource: 'SHOPPING', caseValue: { productBrand: {} }, dimension: 'productBrand', value: null },
  ],
  signals: [{ signalId: '41~701', audienceId: '71', searchTheme: null, approval: null }, { signalId: '41~702', audienceId: '72', searchTheme: null, approval: null }, { signalId: '41~703', audienceId: null, searchTheme: 'moto jacket', approval: 'APPROVED' }],
})
const campaign = (): PmaxCampaignLive => ({
  campaignId: '21', name: 'PMax A', status: 'ENABLED', type: 'PERFORMANCE_MAX', biddingType: 'MAXIMIZE_CONVERSION_VALUE', targetCpaCents: null, targetRoas: 4,
  budget: { budgetId: '11', amountCents: 2500, shared: false }, start: '2026-01-01 00:00:00', end: null,
  retail: { merchantId: '555', feedLabel: 'IT', localInventory: false }, brandGuidelines: true, brandStyle: null, euPoliticalAds: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
  locationOption: 'PRESENCE', trackingTemplate: null, finalUrlSuffix: null,
  automation: { FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION: 'OPTED_OUT', TEXT_ASSET_AUTOMATION: 'OPTED_IN' },
  campaignAssets: [link('201', 'BUSINESS_NAME', 'Shop A'), link('202', 'LOGO'), link('203', 'SITELINK', null, { type: 'SITELINK' })],
  criteria: [
    { criterionId: '81', type: 'LOCATION', negative: false, bidModifier: null, location: '2380' },
    { criterionId: '91', type: 'BRAND_LIST', negative: true, bidModifier: null, brandListId: '61' },
    { criterionId: '92', type: 'WEBPAGE', negative: true, bidModifier: null, webpage: { name: 'x', conditions: [{ operand: 'URL', operator: 'CONTAINS', argument: '/outlet' }] } },
    { criterionId: '93', type: 'DEVICE', negative: false, bidModifier: null },
  ],
  assetGroups: [group()],
  notRead: [],
})

beforeEach(() => {
  h.mutate.mockReset(); h.send.mockReset(); h.check.mockReset()
  h.campaign = campaign()
  h.acquisition = { goal: null, config: null }
})

describe('G10 tools', () => {
  it('are person-approved Google changes, never by rule', () => {
    expect(GOOGLE_ADS_PMAX_TOOLS.map((t) => t.name)).toEqual(['build-google-pmax', 'copy-google-pmax', 'set-google-pmax', 'set-google-customer-acquisition'])
    for (const t of GOOGLE_ADS_PMAX_TOOLS) {
      expect(t, t.name).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', riskTier: 'high', requiresApprovalDefault: true, openWorld: true, readOnly: false })
      expect(t.description.endsWith(GOOGLE_CHANGE_RULES), t.name).toBe(true)
      expect(t.undo, t.name).toBeDefined()
    }
  })
})

describe('build-google-pmax', () => {
  const ask = {
    campaigns: [{
      name: 'PMax Z', dailyBudgetCents: 2500, bidding: { strategy: 'MAXIMIZE_CONVERSIONS' }, retail: { merchantId: '555' },
      brandAssets: { adBusinessName: 'Shop Z', images: [{ fieldType: 'LOGO', imageUrl: 'https://cdn.example/logo.png' }] },
      assetGroups: [{
        name: 'Group Z', finalUrls: ['https://shop.example/'],
        assets: {
          headlines: ['Race jackets', 'Leather suits', 'Fast delivery'], longHeadlines: ['Race-ready leather jackets'], descriptions: ['Free returns.', 'Hand-made leather suits for the track.'],
          images: [{ fieldType: 'MARKETING_IMAGE', imageUrl: 'https://cdn.example/wide.png' }, { fieldType: 'SQUARE_MARKETING_IMAGE', imageUrl: 'https://cdn.example/square.png' }],
          link: [{ assetId: '901', fieldType: 'YOUTUBE_VIDEO' }],
        },
        signals: { audiences: ['71'], searchThemes: ['moto jacket'] },
      }],
    }],
  }

  it('one Google check of the whole build; the run records the ids; undo removes the campaign and its own budget', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const args = parsed('build-google-pmax', ask)
    const out = await tool('build-google-pmax').handler(args, asker)
    expect(out.ok, String(out.error)).toBe(true)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    expect(h.mutate.mock.calls[0][2]).toEqual({ validateOnly: true })
    const ops = h.mutate.mock.calls[0][1] as Array<Record<string, any>>
    expect(ops.find((o) => o.campaignOperation).campaignOperation.create).toMatchObject({ name: 'PMax Z', status: 'PAUSED', advertisingChannelType: 'PERFORMANCE_MAX' })
    const preview = out.preview as { spendsMoney: boolean; warnings: string[] }
    expect(preview.spendsMoney).toBe(false)
    h.mutate.mockReset()
    const budgetAt = ops.findIndex((o) => o.campaignBudgetOperation)
    const campaignAt = ops.findIndex((o) => o.campaignOperation)
    const responses = ops.map((_, i) => (i === budgetAt ? { campaignBudgetResult: { resourceName: `${C}/campaignBudgets/14` } } : i === campaignAt ? { campaignResult: { resourceName: `${C}/campaigns/24` } } : {}))
    h.mutate.mockResolvedValue({ responses, ops: ops.length, requestId: null })
    const run = await tool('build-google-pmax').execute!(args, approved(out.preview))
    expect(run.ok, String(run.error)).toBe(true)
    expect(h.mutate.mock.calls[0][2]).toMatchObject({ validateOnly: false })
    expect(run.change?.after).toMatchObject({ campaigns: [{ name: 'PMax Z', campaignId: '24', ownBudgetId: '14' }], accountId: 'g-1', customerId: '1234567890' })
    expect(tool('build-google-pmax').undo!.request(run.change!)).toEqual({
      tool: 'remove-google-ads-items',
      args: { accountId: 'g-1', items: [{ kind: 'campaign', id: '24' }, { kind: 'budget', id: '14' }], confirmRemove: true, why: expect.any(String) },
    })
    expect(await tool('build-google-pmax').undo!.current(run.change!)).not.toEqual(run.change!.after)
  })

  it('an image of the Nexus image library needs the image library permission', async () => {
    const lib = structuredClone(ask)
    lib.campaigns[0].assetGroups[0].assets.images[0] = { fieldType: 'MARKETING_IMAGE', libraryImageId: 'da_1' } as never
    const out = await tool('build-google-pmax').handler(parsed('build-google-pmax', lib), { ...asker, can: (p: string) => p !== 'assets.manage' } as ToolContext)
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/image library needs the assets.manage permission/) })
    expect(h.mutate).not.toHaveBeenCalled()
  })
})

describe('copy-google-pmax', () => {
  it('the live campaign again, PAUSED: the same assets linked, its tree, its signals; what it cannot copy is named', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const out = await tool('copy-google-pmax').handler(parsed('copy-google-pmax', { campaignId: '21', name: 'PMax A copy' }), asker)
    expect(out.ok, String(out.error)).toBe(true)
    const ops = h.mutate.mock.calls[0][1] as Array<Record<string, any>>
    const created = ops.find((o) => o.campaignOperation).campaignOperation.create
    expect(created).toMatchObject({ name: 'PMax A copy', status: 'PAUSED', brandGuidelinesEnabled: true, maximizeConversionValue: { targetRoas: 4 }, shoppingSetting: { merchantId: '555', feedLabel: 'IT' } })
    // Google's switches as the source has them; one Google left out is at its Performance Max default (on).
    expect(created.assetAutomationSettings).toEqual([
      { assetAutomationType: 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION', assetAutomationStatus: 'OPTED_OUT' },
      { assetAutomationType: 'TEXT_ASSET_AUTOMATION', assetAutomationStatus: 'OPTED_IN' },
      { assetAutomationType: 'GENERATE_IMAGE_ENHANCEMENT', assetAutomationStatus: 'OPTED_IN' },
      { assetAutomationType: 'GENERATE_ENHANCED_YOUTUBE_VIDEOS', assetAutomationStatus: 'OPTED_IN' },
    ])
    expect(ops.filter((o) => o.assetOperation)).toEqual([])
    expect(ops.filter((o) => o.campaignAssetOperation).map((o) => [o.campaignAssetOperation.create.asset, o.campaignAssetOperation.create.fieldType])).toEqual([
      [`${C}/assets/201`, 'BUSINESS_NAME'], [`${C}/assets/202`, 'LOGO'], [`${C}/assets/203`, 'SITELINK'],
    ])
    const links = ops.filter((o) => o.assetGroupAssetOperation).map((o) => o.assetGroupAssetOperation.create.asset)
    expect(links).toHaveLength(8)
    expect(links).not.toContain(`${C}/assets/399`)
    expect(ops.filter((o) => o.assetGroupListingGroupFilterOperation).map((o) => o.assetGroupListingGroupFilterOperation.create.type)).toEqual(['SUBDIVISION', 'UNIT_INCLUDED', 'UNIT_EXCLUDED'])
    expect(ops.filter((o) => o.assetGroupSignalOperation).map((o) => o.assetGroupSignalOperation.create.audience?.audience ?? o.assetGroupSignalOperation.create.searchTheme.text)).toEqual([`${C}/audiences/71`, 'moto jacket'])
    expect(ops.filter((o) => o.campaignCriterionOperation).map((o) => Object.keys(o.campaignCriterionOperation.create).filter((k) => k !== 'campaign' && k !== 'negative')[0])).toEqual(['location', 'webpage', 'brandList'])
    const warnings = (out.preview as { warnings: string[] }).warnings.join(' ')
    expect(warnings).toMatch(/Not copied.*conversion goals.*customer acquisition.*campaign criterion 93 \(DEVICE\).*audience Group only of "Group A" \(it belongs to that asset group alone\)/)
  })

  it('a copy takes its name, budget and dates only', async () => {
    const out = await tool('build-google-pmax').handler(parsed('build-google-pmax', { campaigns: [{ copyOf: '21', name: 'X', retail: { merchantId: '555' } }] }), asker)
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/a copy takes name, dailyBudgetCents, startDate and endDate \(not retail\)/) })
  })
})

describe('set-google-pmax', () => {
  it('previews on Google\'s check, runs as the approver, records the new asset\'s id; undo puts the headline, signals and automation back', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const args = parsed('set-google-pmax', {
      campaignId: '21',
      automation: { finalUrlExpansion: true },
      assetGroups: [{ assetGroupId: '41', addAssets: { headlines: ['Track-day suits'] }, removeAssets: [{ assetId: '303', fieldType: 'HEADLINE' }], addSignals: { searchThemes: ['racing gloves'] }, removeSignals: { audiences: ['71'] } }],
    })
    const out = await tool('set-google-pmax').handler(args, asker)
    expect(out.ok, String(out.error)).toBe(true)
    expect((out.preview as { spendsMoney: boolean }).spendsMoney).toBe(true)
    const ops = h.mutate.mock.calls[0][1] as Array<Record<string, any>>
    h.mutate.mockReset()
    const assetAt = ops.findIndex((o) => o.assetOperation)
    h.mutate.mockResolvedValue({ responses: ops.map((_, i) => (i === assetAt ? { assetResult: { resourceName: `${C}/assets/801` } } : {})), ops: ops.length, requestId: null })
    const run = await tool('set-google-pmax').execute!(args, approved(out.preview))
    expect(run.ok, String(run.error)).toBe(true)
    expect(run.change?.after).toMatchObject({ campaignId: '21', campaign: { automation: { finalUrlExpansion: 'OPTED_IN' } }, groups: [{ assetGroupId: '41', links: expect.arrayContaining(['801~HEADLINE']) }] })
    // Nothing moved since: current is exactly the record.
    const now = campaign()
    now.automation.FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION = 'OPTED_IN'
    now.assetGroups[0].assets = [...now.assetGroups[0].assets.filter((a) => a.assetId !== '303'), link('801', 'HEADLINE', 'Track-day suits')]
    now.assetGroups[0].signals = [{ signalId: '41~702', audienceId: '72', searchTheme: null, approval: null }, { signalId: '41~703', audienceId: null, searchTheme: 'moto jacket', approval: null }, { signalId: '41~704', audienceId: null, searchTheme: 'racing gloves', approval: null }]
    h.campaign = now
    expect(await tool('set-google-pmax').undo!.current(run.change!)).toEqual(run.change!.after)
    const undo = tool('set-google-pmax').undo!.request(run.change!) as { tool: string; args: Record<string, unknown> }
    expect(undo.tool).toBe('set-google-pmax')
    expect(undo.args).toMatchObject({
      accountId: 'g-1', campaignId: '21', automation: { finalUrlExpansion: false },
      assetGroups: [{ assetGroupId: '41', addAssets: { link: [{ assetId: '303', fieldType: 'HEADLINE' }] }, removeAssets: [{ assetId: '801', fieldType: 'HEADLINE' }], addSignals: { audiences: ['71'] }, removeSignals: { searchThemes: ['racing gloves'] } }],
    })
    expect(tool('set-google-pmax').input.safeParse(undo.args).success).toBe(true)
    // Something moved (another headline): undo would overwrite it, and says so through current.
    now.assetGroups[0].assets.push(link('802', 'HEADLINE', 'Someone else'))
    expect(await tool('set-google-pmax').undo!.current(run.change!)).not.toEqual(run.change!.after)
  })

  it('a change that is not a Performance Max campaign, or that breaks Google\'s minimums, is refused before Google is asked', async () => {
    const search = campaign(); search.type = 'SEARCH'; h.campaign = search
    expect(await tool('set-google-pmax').handler(parsed('set-google-pmax', { campaignId: '21', automation: { finalUrlExpansion: false } }), asker)).toMatchObject({ ok: false, error: expect.stringMatching(/changes Performance Max campaigns/) })
    h.campaign = campaign()
    expect(await tool('set-google-pmax').handler(parsed('set-google-pmax', { campaignId: '21', assetGroups: [{ assetGroupId: '41', removeAssets: [{ assetId: '307', fieldType: 'MARKETING_IMAGE' }] }] }), asker))
      .toMatchObject({ ok: false, error: expect.stringMatching(/0 landscape images \(Google needs at least 1\)/) })
    expect(h.mutate).not.toHaveBeenCalled()
  })
})

describe('set-google-customer-acquisition', () => {
  it('Google checks it with its own validate_only (not a mutate); the run sends one call; undo sets the old mode back', async () => {
    h.acquisition = { goal: { goalId: '81', resourceName: `${C}/goals/81`, eligibility: 'ELIGIBLE', valueCents: 500, highValueCents: null }, config: null }
    h.check.mockResolvedValue({ resourceName: null, review: null })
    const args = parsed('set-google-customer-acquisition', { campaignId: '21', mode: 'BID_HIGHER' })
    const out = await tool('set-google-customer-acquisition').handler(args, asker)
    expect(out.ok, String(out.error)).toBe(true)
    expect(h.check).toHaveBeenCalledTimes(1)
    expect(h.mutate).not.toHaveBeenCalled()
    expect(h.check.mock.calls[0][1]).toEqual([{ accountCall: { path: 'CampaignGoalConfigs:mutate', body: { operations: [{ create: { campaign: `${C}/campaigns/21`, goal: `${C}/goals/81`, campaignNewCustomerAcquisitionSettings: { targetOption: 'TARGET_ALL' } } }] } } }])
    expect((out.preview as { spendsMoney: boolean }).spendsMoney).toBe(true)
    h.send.mockResolvedValue({ responses: [{ accountResult: { resourceName: `${C}/campaignGoalConfigs/21~81` } }] })
    const run = await tool('set-google-customer-acquisition').execute!(args, approved(out.preview))
    expect(run.ok, String(run.error)).toBe(true)
    expect(h.send).toHaveBeenCalledTimes(1)
    h.acquisition = { goal: h.acquisition.goal, config: { resourceName: `${C}/campaignGoalConfigs/21~81`, goalId: '81', mode: 'TARGET_ALL', valueCents: null, highValueCents: null } }
    expect(await tool('set-google-customer-acquisition').undo!.current(run.change!)).toEqual(run.change!.after)
    const undo = tool('set-google-customer-acquisition').undo!.request(run.change!) as { tool: string; args: Record<string, unknown> }
    expect(undo).toMatchObject({ tool: 'set-google-customer-acquisition', args: { accountId: 'g-1', campaignId: '21', mode: 'OFF' } })
    expect(tool('set-google-customer-acquisition').input.safeParse(undo.args).success).toBe(true)
  })
})
