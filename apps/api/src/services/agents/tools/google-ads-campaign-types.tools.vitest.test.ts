/**
 * Google Ads changes (2026-10-15, programme 2 group G11) — the Demand Gen, Display and App tools as the approval gate uses
 * them (Google, the account, the live reads and the image fetch are stand-ins): the preview is built on Google's check
 * (validate_only); a run happens only as a request a person approved, as ONE request with validateOnly false, exactly what
 * was checked; its record holds the ids Google gave; undo asks for a request its target tool takes (removing what was
 * made, or putting settings, targeting and ad fields back) on the account the change was made on; a library image needs
 * the image library permission; an account that moved since the approval gets nothing sent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURES as F } from '@nexus/shared/permissions'

const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  prepare: vi.fn(),
  live: {
    campaigns: [] as unknown[], budgets: [] as unknown[], typed: null as unknown, adGroups: [] as unknown[], criteria: [] as unknown[], ads: [] as unknown[],
    assets: [] as Array<{ assetId: string }>, youtube: [] as unknown[], audiences: [] as unknown[], segments: {} as Record<string, unknown>,
  },
}))
vi.mock('../../marketing/google-ads/change-account.js', () => ({
  googleChangeAccount: vi.fn(async () => ({
    target: { connectionId: 'g-1', customerId: '1234567890', loginCustomerId: null }, accountId: 'g-1', customerId: '1234567890', name: 'Shop', currency: 'EUR', timeZone: 'Europe/Rome',
  })),
}))
vi.mock('../../marketing/google-ads/live.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live.js')>()),
  liveCampaigns: vi.fn(async () => structuredClone(h.live.campaigns)),
  liveBudgets: vi.fn(async () => structuredClone(h.live.budgets)),
}))
vi.mock('../../marketing/google-ads/live-campaign-types.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live-campaign-types.js')>()),
  liveTypedCampaign: vi.fn(async () => structuredClone(h.live.typed)),
  liveTypedAdGroups: vi.fn(async () => structuredClone(h.live.adGroups)),
  liveTypedCriteria: vi.fn(async () => structuredClone(h.live.criteria)),
  liveTypedAds: vi.fn(async (_t: unknown, ids: string[]) => structuredClone((h.live.ads as Array<{ id: string }>).filter((a) => ids.includes(a.id)))),
  liveMediaAssets: vi.fn(async (_t: unknown, ids: string[]) => structuredClone(h.live.assets.filter((a) => ids.includes(a.assetId)))),
  liveYoutubeAssets: vi.fn(async () => structuredClone(h.live.youtube)),
  liveAudiences: vi.fn(async () => structuredClone(h.live.audiences)),
}))
vi.mock('../../marketing/google-ads/live-targeting.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live-targeting.js')>()),
  liveSegmentNames: vi.fn(async () => structuredClone(h.live.segments)),
}))
vi.mock('../../marketing/google-ads/asset-images.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/asset-images.js')>()),
  prepareImage: h.prepare,
}))
vi.mock('../../marketing/google-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/write-client.js')>()),
  mutateGoogleAds: h.mutate,
}))
vi.mock('../../marketing/google-ads/enqueue.js', () => ({ enqueueGoogleAdsSync: vi.fn(async () => ({ queued: true, reason: null })) }))

import { GOOGLE_ADS_CAMPAIGN_TYPES_TOOLS } from './google-ads-campaign-types.tools.js'
import { GOOGLE_ADS_CAMPAIGN_TOOLS } from './google-ads-campaigns.tools.js'
import { GOOGLE_CHANGE_RULES } from './google-ads-kit.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import type { ToolChange, ToolContext } from '../tool-types.js'

const tool = (name: string) => [...GOOGLE_ADS_CAMPAIGN_TYPES_TOOLS, ...GOOGLE_ADS_CAMPAIGN_TOOLS].find((t) => t.name === name)!
const parsed = (name: string, args: Record<string, unknown>) => tool(name).input.parse(args) as Record<string, unknown>
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })
const C = 'customers/1234567890'
const IMAGE = { source: 'https://cdn.example/a.png', label: 'a', mimeType: 'image/png', bytes: 2048, width: 512, height: 512, sha256: 'ab'.repeat(32), data: 'iVBORw0KGgo=' }

const typedCampaign = (o: Record<string, unknown> = {}) => ({
  campaignId: '21', name: 'DG Live', status: 'ENABLED', type: 'DEMAND_GEN', subType: null, bidding: 'TARGET_SPEND', portfolioId: null, start: null, end: null,
  targetCpaCents: null, targetRoas: null, maxCpcCents: null, targetCpcCents: null, app: null, merchantId: null, feedLabel: null, upgradedTargeting: true,
  conversionActionIds: [], optimizationGoals: [], budget: { budgetId: '14', amountCents: 2000, totalCents: null, period: 'DAILY', shared: false }, ...o,
})
const adGroup = (o: Record<string, unknown> = {}) => ({
  adGroupId: '51', name: 'Group A', status: 'ENABLED', type: null, cpcBidCents: null, cpmBidCents: null, targetCpaCents: null, optimizedTargeting: false,
  audienceGrouped: false, channels: { strategy: 'ALL_CHANNELS' }, observation: [], ...o,
})
const multiAsset = {
  type: 'multi-asset', finalUrl: 'https://shop.example/a', brandName: 'Shop A', headlines: ['Head one'], descriptions: ['Text one'],
  squareMarketingImages: [{ assetId: '302' }], logoImages: [{ imageUrl: 'https://cdn.example/logo.png' }],
}

beforeEach(() => {
  h.mutate.mockReset()
  h.prepare.mockReset()
  h.prepare.mockImplementation(async () => structuredClone(IMAGE))
  h.live.campaigns = [{ campaignId: '9', name: 'Search A', status: 'ENABLED' }]
  h.live.budgets = []
  h.live.typed = typedCampaign()
  h.live.adGroups = [adGroup()]
  h.live.criteria = []
  h.live.ads = []
  h.live.assets = [{ assetId: '302', type: 'IMAGE', name: null, source: 'ADVERTISER', width: 1200, height: 1200, mimeType: 'IMAGE_PNG', youtubeVideoId: null, youtubeTitle: null } as never]
  h.live.youtube = []
  h.live.audiences = []
  h.live.segments = { 'USER_LIST|501': { name: 'Visitors', status: 'OPEN' } }
})

/** Preview (Google's check), then a run as the person who approved it, answering `responses`. */
async function previewAndRun(name: string, args: Record<string, unknown>, responses: unknown[]) {
  h.mutate.mockReset()
  h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
  const out = await tool(name).handler(args, asker)
  if (!out.ok) throw new Error(out.error)
  expect(h.mutate.mock.calls[0][2]).toEqual({ validateOnly: true })
  const sent = h.mutate.mock.calls[0][1] as Array<Record<string, any>>
  h.mutate.mockReset()
  h.mutate.mockResolvedValue({ responses, ops: 1, requestId: 'r' })
  const run = await tool(name).execute!(args, approved(out.preview))
  if (!run.ok) throw new Error(run.error)
  expect(h.mutate).toHaveBeenCalledTimes(1)
  expect(h.mutate.mock.calls[0][2]).toMatchObject({ validateOnly: false })
  expect(h.mutate.mock.calls[0][1]).toEqual(sent)
  return { preview: out.preview as Record<string, unknown>, sent, run }
}

/** An undo request as the gate takes it: parsed by its TARGET tool's input and built by that tool's draft (accepted). */
async function undoDraft(undo: { tool: string; args: Record<string, unknown> }) {
  const args = parsed(undo.tool, undo.args)
  h.mutate.mockReset()
  h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
  const out = await tool(undo.tool).handler(args, asker)
  expect(out.error, `${undo.tool}: the undo request passes its draft`).toBeUndefined()
  return { preview: out.preview as Record<string, unknown>, sent: h.mutate.mock.calls[0]?.[1] as Array<Record<string, any>> }
}

const resultOf = (sent: Array<Record<string, any>>, ids: Record<string, string>) => sent.map((op, i) => {
  const kind = Object.keys(op)[0]
  return { [kind.replace('Operation', 'Result')]: { resourceName: `${C}/x/${ids[kind] ?? String(800 + i)}` } }
})

describe('the G11 tools', () => {
  it('are Nexus changes a person approves: alwaysAsk, ask at most, reach Google, re-check fields declared, Google\'s rules in every description', () => {
    expect(GOOGLE_ADS_CAMPAIGN_TYPES_TOOLS.map((t) => t.name)).toEqual([
      'create-google-demand-gen-campaign', 'create-google-display-campaign', 'create-google-app-campaign',
      'add-google-campaign-type-ads', 'set-google-campaign-type', 'edit-google-campaign-type-ads',
    ])
    for (const t of GOOGLE_ADS_CAMPAIGN_TYPES_TOOLS) {
      expect(t).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', openWorld: true, riskTier: 'high', readOnly: false, requiresApprovalDefault: true })
      expect(t.undo, t.name).toBeDefined()
      expect(MATERIAL_PREVIEW_FIELDS[t.name]).toEqual(['basis', 'plan', 'reach'])
      expect(t.description.endsWith(GOOGLE_CHANGE_RULES), t.name).toBe(true)
    }
  })

  it('create-google-demand-gen-campaign: one request Google checked, a PAUSED campaign; the run records Google\'s ids; undo removes the campaign and its own budget', async () => {
    const args = parsed('create-google-demand-gen-campaign', {
      name: 'DG New', dailyBudgetCents: 2000, bidding: { strategy: 'MAXIMIZE_CLICKS' }, locations: [{ id: '2380' }],
      adGroups: [{ name: 'Group A', channels: { selected: ['youtube_shorts'] }, targeting: [{ kind: 'user-list', value: '501' }], ads: [multiAsset] }],
    })
    const { preview, sent, run } = await previewAndRun('create-google-demand-gen-campaign', args, [])
    expect(preview).toMatchObject({ spendsMoney: false, googleCheck: { checked: true, accepted: true }, reach: { mode: expect.any(String), accountId: 'g-1', customerId: '1234567890' } })
    expect(sent.find((op) => op.campaignOperation)!.campaignOperation.create).toMatchObject({ status: 'PAUSED', advertisingChannelType: 'DEMAND_GEN', targetSpend: {} })
    expect(h.prepare).toHaveBeenCalledWith({ imageUrl: 'https://cdn.example/logo.png', libraryImageId: null })
    // The run's answer comes from Google's results (this run answered nothing): the record still holds what to look for.
    expect(run.data).toMatchObject({ campaignId: null, status: 'PAUSED' })

    h.mutate.mockReset()
    h.mutate.mockResolvedValueOnce({ responses: [], ops: 1, requestId: null }).mockResolvedValueOnce({ responses: resultOf(sent, { campaignOperation: '77', campaignBudgetOperation: '66', adGroupOperation: '55' }), ops: 1, requestId: 'r' })
    const out = await tool('create-google-demand-gen-campaign').handler(args, asker)
    const ran = await tool('create-google-demand-gen-campaign').execute!(args, approved(out.preview))
    expect(ran.data).toMatchObject({ campaignId: '77', budgetId: '66', adGroups: [{ name: 'Group A', adGroupId: '55' }] })
    const change = { before: ran.change!.before, after: ran.change!.after } as ToolChange
    h.live.campaigns = [{ campaignId: '77', name: 'DG New', status: 'PAUSED' }]
    expect(await tool('create-google-demand-gen-campaign').undo!.current(change)).toEqual(change.after)
    const undo = tool('create-google-demand-gen-campaign').undo!.request(change)
    expect(undo).toMatchObject({ tool: 'remove-google-ads-items', args: { accountId: 'g-1', items: [{ kind: 'campaign', id: '77' }, { kind: 'budget', id: '66' }], confirmRemove: true } })
    expect(tool('remove-google-ads-items').input.safeParse((undo as { args: unknown }).args).success).toBe(true)
  })

  it('create-google-display-campaign and create-google-app-campaign pass Google\'s check; a library image needs the image library permission', async () => {
    const rda = {
      finalUrl: 'https://shop.example/a', brandName: 'Shop A', headlines: ['Head one'], longHeadlines: ['A long headline'], descriptions: ['Text one'],
      marketingImages: [{ libraryImageId: 'da_1' }], squareMarketingImages: [{ assetId: '302' }],
    }
    h.prepare.mockImplementation(async () => ({ ...IMAGE, width: 1200, height: 628 }))
    const display = parsed('create-google-display-campaign', { name: 'Display A', dailyBudgetCents: 1500, adGroups: [{ name: 'G', defaultBidCents: 40, targeting: [{ kind: 'topic', value: '66' }], ads: [rda] }] })
    const noLibrary: ToolContext = { ...asker, can: (p) => p !== F.assetsManage }
    expect((await tool('create-google-display-campaign').handler(display, noLibrary)).error).toMatch(/needs the .* permission/)
    expect(h.mutate).not.toHaveBeenCalled()
    const { sent } = await previewAndRun('create-google-display-campaign', display, [])
    expect(sent.find((op) => op.adGroupOperation)!.adGroupOperation.create).toMatchObject({ type: 'DISPLAY_STANDARD', cpcBidMicros: '400000' })

    const app = parsed('create-google-app-campaign', {
      name: 'App A', dailyBudgetCents: 3000, app: { appId: 'com.example.app', appStore: 'google_app_store', goal: 'optimize_installs_without_target_install_cost' },
      adGroups: [{ name: 'G', ads: [{ headlines: ['Get it'], descriptions: ['Ride on'] }] }],
    })
    const appRun = await previewAndRun('create-google-app-campaign', app, [])
    expect(appRun.sent.find((op) => op.campaignOperation)!.campaignOperation.create).toMatchObject({ advertisingChannelType: 'MULTI_CHANNEL', advertisingChannelSubType: 'APP_CAMPAIGN', maximizeConversions: {} })
  })

  it('add-google-campaign-type-ads: in an ENABLED campaign what is new is PAUSED; undo removes the ad group and the ad it made', async () => {
    const args = parsed('add-google-campaign-type-ads', { campaignId: '21', adGroups: [{ name: 'Group B', ads: [multiAsset] }], addAds: [{ adGroupId: '51', ads: [multiAsset] }] })
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const out = await tool('add-google-campaign-type-ads').handler(args, asker)
    expect(out.ok).toBe(true)
    const sent = h.mutate.mock.calls[0][1] as Array<Record<string, any>>
    expect(sent.find((op) => op.adGroupOperation)!.adGroupOperation.create.status).toBe('PAUSED')
    h.mutate.mockReset()
    const responses = sent.map((op) => (op.adGroupOperation ? { adGroupResult: { resourceName: `${C}/adGroups/52` } }
      : op.adGroupAdOperation ? { adGroupAdResult: { resourceName: op.adGroupAdOperation.create.adGroup.endsWith('/51') ? `${C}/adGroupAds/51~702` : `${C}/adGroupAds/52~703` } }
        : { assetResult: { resourceName: `${C}/assets/309` } }))
    h.mutate.mockResolvedValue({ responses, ops: 1, requestId: 'r' })
    const run = await tool('add-google-campaign-type-ads').execute!(args, approved(out.preview))
    expect(run.data).toMatchObject({ adGroups: [{ name: 'Group B', adGroupId: '52', status: 'PAUSED' }], ads: [{ adGroupId: '51', adId: '702' }] })
    const change = { before: run.change!.before, after: run.change!.after } as ToolChange
    h.live.adGroups = [adGroup(), adGroup({ adGroupId: '52', name: 'Group B', status: 'PAUSED' })]
    h.live.ads = [{ id: '51~702' }]
    expect(await tool('add-google-campaign-type-ads').undo!.current(change)).toEqual(change.after)
    const undo = tool('add-google-campaign-type-ads').undo!.request(change)
    expect(undo).toMatchObject({ tool: 'remove-google-ads-items', args: { items: [{ kind: 'ad-group', id: '52' }, { kind: 'ad', id: '51~702' }], confirmRemove: true } })
    expect(tool('remove-google-ads-items').input.safeParse((undo as { args: unknown }).args).success).toBe(true)
  })

  it('set-google-campaign-type: the run sends what was checked; undo puts settings and targeting back (its request passes its own draft)', async () => {
    h.live.criteria = [{ adGroupId: '51', criterionId: '2', kind: 'location', value: '2380', exclude: false, status: 'ENABLED', name: null }]
    const args = parsed('set-google-campaign-type', {
      campaignId: '21', name: 'DG New', bidding: { strategy: 'MAXIMIZE_CLICKS', maxCpcCents: 80 },
      adGroups: [{ adGroupId: '51', channels: { strategy: 'all_owned_and_operated_channels' }, addTargeting: [{ kind: 'user-list', value: '501' }], removeTargeting: [{ kind: 'location', value: '2380' }] }],
    })
    const { preview, run } = await previewAndRun('set-google-campaign-type', args, [])
    expect(preview.spendsMoney).toBe(true)
    // Now the account is as the change left it: undo reads it back the same and asks for the old settings and targeting.
    h.live.typed = typedCampaign({ name: 'DG New', maxCpcCents: 80 })
    h.live.adGroups = [adGroup({ channels: { strategy: 'ALL_OWNED_AND_OPERATED_CHANNELS' } })]
    h.live.criteria = [{ adGroupId: '51', criterionId: '9', kind: 'user-list', value: '501', exclude: false, status: 'ENABLED', name: null }]
    h.live.campaigns = [{ campaignId: '21', name: 'DG New', status: 'ENABLED' }]
    const change = { before: run.change!.before, after: run.change!.after } as ToolChange
    expect(await tool('set-google-campaign-type').undo!.current(change)).toEqual(change.after)
    const undo = tool('set-google-campaign-type').undo!.request(change) as { tool: string; args: Record<string, unknown> }
    expect(undo).toMatchObject({ tool: 'set-google-campaign-type', args: {
      accountId: 'g-1', campaignId: '21', name: 'DG Live', bidding: { strategy: 'MAXIMIZE_CLICKS' },
      adGroups: [{ adGroupId: '51', channels: { strategy: 'ALL_CHANNELS' }, addTargeting: [{ kind: 'location', value: '2380', exclude: false }], removeTargeting: [{ kind: 'user-list', value: '501', exclude: false }] }],
    } })
    const back = await undoDraft(undo)
    expect(back.sent.map((op) => Object.keys(op)[0])).toEqual(['campaignOperation', 'adGroupOperation', 'adGroupCriterionOperation', 'adGroupCriterionOperation'])
  })

  it('edit-google-campaign-type-ads: an RDA edited in place; undo puts the old texts back (its request passes its own draft)', async () => {
    const info = { headlines: [{ text: 'Old one' }], longHeadline: { text: 'Old long' }, descriptions: [{ text: 'Old text' }], businessName: 'Shop A', marketingImages: [{ asset: `${C}/assets/301` }], squareMarketingImages: [{ asset: `${C}/assets/302` }] }
    const ad = (i: Record<string, unknown>) => ({ id: '51~701', adGroupId: '51', adId: '701', type: 'RESPONSIVE_DISPLAY_AD', status: 'ENABLED', adGroupStatus: 'ENABLED', campaignId: '21', campaignStatus: 'ENABLED', campaignType: 'DISPLAY', finalUrls: ['https://shop.example/a'], approval: 'APPROVED', info: i })
    h.live.ads = [ad(info)]
    const args = parsed('edit-google-campaign-type-ads', { ads: [{ id: '51~701', headlines: ['New one'], finalUrl: 'https://shop.example/b' }] })
    const { sent, run } = await previewAndRun('edit-google-campaign-type-ads', args, [])
    expect(sent).toEqual([{ adOperation: { update: { resourceName: `${C}/ads/701`, finalUrls: ['https://shop.example/b'], responsiveDisplayAd: { headlines: [{ text: 'New one' }] } }, updateMask: 'final_urls,responsive_display_ad.headlines' } }])
    h.live.ads = [{ ...ad({ ...info, headlines: [{ text: 'New one' }] }), finalUrls: ['https://shop.example/b'] }]
    const change = { before: run.change!.before, after: run.change!.after } as ToolChange
    expect(await tool('edit-google-campaign-type-ads').undo!.current(change)).toEqual(change.after)
    const undo = tool('edit-google-campaign-type-ads').undo!.request(change) as { tool: string; args: Record<string, unknown> }
    expect(undo.args.ads).toEqual([{ id: '51~701', finalUrl: 'https://shop.example/a', headlines: ['Old one'] }])
    const back = await undoDraft(undo)
    expect(back.sent[0].adOperation.update.responsiveDisplayAd).toEqual({ headlines: [{ text: 'Old one' }] })
  })

  it('edit: what its SPENDS MONEY line rests on is checked again — a campaign enabled since the preview gets nothing sent', async () => {
    const info = { headlines: [{ text: 'Old one' }], longHeadline: { text: 'Old long' }, descriptions: [{ text: 'Old text' }], businessName: 'Shop A', marketingImages: [{ asset: `${C}/assets/301` }], squareMarketingImages: [{ asset: `${C}/assets/302` }] }
    const ad = (o: Record<string, unknown>) => ({ id: '51~701', adGroupId: '51', adId: '701', type: 'RESPONSIVE_DISPLAY_AD', status: 'ENABLED', adGroupStatus: 'ENABLED', campaignId: '21', campaignStatus: 'PAUSED', campaignType: 'DISPLAY', finalUrls: ['https://shop.example/a'], approval: 'DISAPPROVED', info, ...o })
    h.live.ads = [ad({})]
    const args = parsed('edit-google-campaign-type-ads', { ads: [{ id: '51~701', headlines: ['Fixed one'] }] })
    h.mutate.mockReset()
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const out = await tool('edit-google-campaign-type-ads').handler(args, asker)
    expect((out.preview as { spendsMoney: boolean }).spendsMoney).toBe(false)
    h.mutate.mockReset()
    h.live.ads = [ad({ campaignStatus: 'ENABLED' })]
    const run = await tool('edit-google-campaign-type-ads').execute!(args, approved(out.preview))
    expect(run.ok).toBe(false)
    expect(run.error ?? JSON.stringify(run)).toMatch(/changed since this was approved/)
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('undo leaves what had no value before as it is and says so: an edit\'s new brand name, a settings change\'s first ad group bid', () => {
    const edit = tool('edit-google-campaign-type-ads').undo!.request({
      before: { ads: [{ id: '51~701', campaignId: '21', brandName: null, headlines: ['Old one'] }] },
      after: { ads: [{ id: '51~701', campaignId: '21', brandName: 'Shop A', headlines: ['New one'] }], accountId: 'g-1', customerId: '1234567890' },
    } as ToolChange) as { tool: string; args: Record<string, unknown> }
    expect(edit.args.ads).toEqual([{ id: '51~701', headlines: ['Old one'] }])
    expect(edit.args.why).toMatch(/cannot take off what the ads did not have: 51~701: brand name/)
    expect(tool('edit-google-campaign-type-ads').input.safeParse(edit.args).success).toBe(true)
    const only = tool('edit-google-campaign-type-ads').undo!.request({ before: { ads: [{ id: '51~701', campaignId: '21', brandName: null }] }, after: { ads: [{ id: '51~701', campaignId: '21', brandName: 'Shop A' }] } } as ToolChange)
    expect(only).toMatchObject({ refusal: expect.stringMatching(/cannot be taken off/) })
    const settings = tool('set-google-campaign-type').undo!.request({
      before: { campaignId: '21', campaign: { name: 'Old' }, adGroups: [{ adGroupId: '51', settings: {}, added: [], removed: [] }] },
      after: { campaignId: '21', campaign: { name: 'New', startDate: '2026-11-01' }, adGroups: [{ adGroupId: '51', settings: { defaultBidCents: 40 }, added: [], removed: [] }], accountId: 'g-1', customerId: '1234567890' },
    } as ToolChange) as { tool: string; args: Record<string, unknown> }
    expect(settings.args).toMatchObject({ campaignId: '21', name: 'Old' })
    expect(settings.args.adGroups).toBeUndefined()
    expect(settings.args.why).toMatch(/not put back, they had no value before: the campaign's startDate, ad group 51's defaultBidCents/)
    expect(tool('set-google-campaign-type').input.safeParse(settings.args).success).toBe(true)
  })

  it('a run happens only as a person\'s approval, and never when the account moved since', async () => {
    const args = parsed('set-google-campaign-type', { campaignId: '21', name: 'DG New' })
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const out = await tool('set-google-campaign-type').handler(args, asker)
    h.mutate.mockReset()
    const byRule = await tool('set-google-campaign-type').execute!(args, { ...approved(out.preview), decidedVia: 'auto', approvedByPerson: false })
    expect(byRule.ok).toBe(false)
    h.live.typed = typedCampaign({ status: 'PAUSED' })
    const moved = await tool('set-google-campaign-type').execute!(args, approved(out.preview))
    expect(moved.ok).toBe(false)
    expect(moved.error ?? JSON.stringify(moved)).toMatch(/changed since this was approved/)
    expect(h.mutate).not.toHaveBeenCalled()
  })
})
