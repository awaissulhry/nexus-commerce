/**
 * Google Ads changes (2026-10-15) — PR 5, create-google-rsa and set-google-assets as the approval gate uses them (Google,
 * the account and the live reads are stand-ins): the preview is built on Google's check (validate_only) and says what
 * spends money; a text Google would refuse is never queued (and Google is not even asked); a run happens only as a
 * request a person approved, as ONE request with validateOnly false, and answers the new ids by operation; undo pauses
 * the ads it made and unlinks / links again what it linked / unlinked, on the account the change was made on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  enqueue: vi.fn(async () => ({ queued: true, reason: null })),
  live: { place: null as unknown, ads: [] as unknown[], campaigns: [] as unknown[], assets: [] as unknown[], byId: [] as unknown[] },
}))
vi.mock('../../marketing/google-ads/change-account.js', () => ({
  googleChangeAccount: vi.fn(async () => ({
    target: { connectionId: 'g-1', customerId: '1234567890', loginCustomerId: null }, accountId: 'g-1', customerId: '1234567890', name: 'Shop', currency: 'EUR', timeZone: 'Europe/Rome',
  })),
}))
vi.mock('../../marketing/google-ads/live.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live.js')>()),
  liveCampaigns: vi.fn(async () => structuredClone(h.live.campaigns)),
  liveAds: vi.fn(async () => structuredClone(h.live.ads)),
  liveAssets: vi.fn(async () => structuredClone(h.live.assets)),
}))
vi.mock('../../marketing/google-ads/live-ads-assets.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live-ads-assets.js')>()),
  liveAdGroupPlace: vi.fn(async () => structuredClone(h.live.place)),
  liveAssetsById: vi.fn(async () => structuredClone(h.live.byId)),
}))
vi.mock('../../marketing/google-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/write-client.js')>()),
  mutateGoogleAds: h.mutate,
}))
vi.mock('../../marketing/google-ads/enqueue.js', () => ({ enqueueGoogleAdsSync: h.enqueue }))

import { GOOGLE_ADS_ADS_ASSETS_TOOLS } from './google-ads-ads-assets.tools.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import type { ToolContext } from '../tool-types.js'

const tool = (name: string) => GOOGLE_ADS_ADS_ASSETS_TOOLS.find((t) => t.name === name)!
/** The arguments as the call path hands them over: parsed by the tool's input (pins and field types upper-cased). */
const parsed = (name: string, args: Record<string, unknown>) => tool(name).input.parse(args) as Record<string, unknown>
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })
const ACCOUNT = { accountId: 'g-1', customerId: '1234567890' }

const CAMPAIGN = { campaignId: '21', name: 'Search A', status: 'ENABLED', servingStatus: null, primaryStatus: null, type: 'SEARCH', subType: null, bidding: 'MANUAL_CPC', start: null, end: null, shopping: null, budget: null }
const PLACE = { campaign: { campaignId: '21', name: 'Search A', status: 'ENABLED', type: 'SEARCH' }, adGroup: { adGroupId: '51', name: 'Jackets', status: 'ENABLED', type: 'SEARCH_STANDARD' } }
const liveAd = (adId: string, status: string) => ({
  adGroupId: '51', adId, status, type: 'RESPONSIVE_SEARCH_AD', finalUrls: [], headlines: [{ text: `Ad ${adId}`, pinned: null }], descriptions: [], path1: null, path2: null, strength: null, approval: null, review: null, policy: [],
})
const AD = {
  headlines: [{ text: 'Moto Jackets', pin: 'headline_1' }, { text: 'Free Returns' }, { text: 'Shop A Official' }],
  descriptions: [{ text: 'Leather and textile jackets.' }, { text: 'Ships in 24 hours.' }],
  path1: 'jackets',
  finalUrl: 'https://shop.example/jackets',
}

beforeEach(() => {
  h.mutate.mockReset()
  h.enqueue.mockClear()
  vi.unstubAllEnvs()
  h.live.place = structuredClone(PLACE)
  h.live.ads = [liveAd('700', 'ENABLED')]
  h.live.campaigns = [CAMPAIGN]
  h.live.assets = [{ campaignId: '21', assetId: '9', fieldType: 'CALLOUT', type: 'CALLOUT', status: 'ENABLED', primaryStatus: null, primaryStatusReasons: [], text: 'Free Returns', finalUrls: [], approval: null, review: null, policy: [] }]
  h.live.byId = []
})

describe('the PR 5 tools', () => {
  it('are Nexus changes a person approves: alwaysAsk, ask at most, reach Google, re-check fields declared, no money', () => {
    expect(GOOGLE_ADS_ADS_ASSETS_TOOLS.map((t) => t.name)).toEqual(['create-google-rsa', 'set-google-assets'])
    for (const t of GOOGLE_ADS_ADS_ASSETS_TOOLS) {
      expect(t).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', openWorld: true, readOnly: false, riskTier: 'high', requiresApprovalDefault: true, reversibility: 'full' })
      expect(MATERIAL_PREVIEW_FIELDS[t.name]).toEqual(['basis', 'plan', 'reach'])
      expect(t.restrictedFields).toBeUndefined()
    }
  })
})

describe('create-google-rsa', () => {
  it('preview in an enabled ad group of an enabled campaign: PAUSED by default; enable: true is SPENDS MONEY; Google checks it', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const quiet = await tool('create-google-rsa').handler(parsed('create-google-rsa', { campaignId: '21', adGroupId: '51', ads: [AD] }), asker)
    expect(quiet.preview).toMatchObject({ spendsMoney: false, operations: 1, googleCheck: { checked: true, accepted: true } })
    expect((h.mutate.mock.calls[0][1] as any)[0].adGroupAdOperation.create.status).toBe('PAUSED')
    expect((h.mutate.mock.calls[0][1] as any)[0].adGroupAdOperation.create.ad.responsiveSearchAd.headlines[0]).toEqual({ text: 'Moto Jackets', pinnedField: 'HEADLINE_1' })
    h.mutate.mockClear()
    const out = await tool('create-google-rsa').handler(parsed('create-google-rsa', { campaignId: '21', adGroupId: '51', ads: [AD], enable: true }), asker)
    expect(h.mutate.mock.calls[0][2]).toEqual({ validateOnly: true })
    expect(out.preview).toMatchObject({
      spendsMoney: true,
      spendsMoneyBecause: ['Makes 1 responsive search ad ENABLED in the enabled ad group "Jackets" of campaign "Search A": it shows (and spends) as soon as Google approves it.'],
      reach: { mode: 'live', ...ACCOUNT },
    })
  })

  it('a text Google would refuse is never queued, and Google is not asked', async () => {
    const out = await tool('create-google-rsa').handler(parsed('create-google-rsa', { campaignId: '21', adGroupId: '51', ads: [{ ...AD, headlines: [{ text: 'A headline that is far too long!' }, { text: 'B' }] }] }), asker)
    expect(out.ok).toBe(false)
    expect(out.error).toBe('Not queued — the ads break Google\'s rules (nothing was sent): ad 1: 2 headlines (Google needs at least 3); ad 1, headline 1 "A headline that is far too long!" is 32 characters long: Google allows 30.')
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('runs as ONE request a person approved; answers the new ad ids and the policy review; undo pauses them on the same account', async () => {
    const ask = parsed('create-google-rsa', { campaignId: '21', adGroupId: '51', ads: [AD], enable: true })
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const preview = (await tool('create-google-rsa').handler(ask, asker)).preview
    h.mutate.mockReset()
    h.mutate.mockResolvedValue({ responses: [{ adGroupAdResult: { resourceName: 'customers/1234567890/adGroupAds/51~901' } }], ops: 1, requestId: 'r' })
    const run = await tool('create-google-rsa').execute!(ask, approved(preview))
    expect(run.ok).toBe(true)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    expect(h.mutate.mock.calls[0][2]).toMatchObject({ validateOnly: false })
    expect(run.data).toMatchObject({ adIds: ['901'], status: 'ENABLED', review: expect.stringContaining('google-ads-live view ads (campaignId 21)') })
    expect(run.change).toEqual({
      before: { campaignId: '21', adGroupId: '51', ads: [], ...ACCOUNT },
      after: { campaignId: '21', adGroupId: '51', created: [{ adId: '901', status: 'ENABLED' }], paused: [], ...ACCOUNT },
    })
    // The ad is there and enabled: nothing moved since, so undo may run — it pauses the ad through the tool's other form.
    h.live.ads = [liveAd('700', 'ENABLED'), liveAd('901', 'ENABLED')]
    expect(await tool('create-google-rsa').undo!.current(run.change!)).toEqual(run.change!.after)
    const undo = tool('create-google-rsa').undo!.request(run.change!) as { tool: string; args: Record<string, unknown> }
    expect(undo).toMatchObject({ tool: 'create-google-rsa', args: { accountId: 'g-1', campaignId: '21', adGroupId: '51', pauseAdIds: ['901'] } })
    expect(tool('create-google-rsa').input.safeParse(undo.args).success).toBe(true)
    h.mutate.mockReset()
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const pausePreview = await tool('create-google-rsa').handler(undo.args, asker)
    expect(pausePreview.preview).toMatchObject({ spendsMoney: false, operations: 1, summary: 'Google Ads: pause 1 ad of ad group "Jackets" of campaign "Search A".' })
    expect(h.mutate.mock.calls[0][1]).toEqual([{ adGroupAdOperation: { update: { resourceName: 'customers/1234567890/adGroupAds/51~901', status: 'PAUSED' }, updateMask: 'status' } }])
    // A pause is not undone into an enable here (that spends money: its own change).
    expect(tool('create-google-rsa').undo!.request({ before: { campaignId: '21', adGroupId: '51', ads: [{ adId: '901', status: 'ENABLED' }] }, after: { campaignId: '21', adGroupId: '51', created: [], paused: ['901'] } }))
      .toMatchObject({ refusal: expect.stringContaining('showing them again is an enable') })
  })

  it('never by a rule: a run the business\'s rule decided is refused before anything is sent', async () => {
    const ask = parsed('create-google-rsa', { campaignId: '21', adGroupId: '51', ads: [AD] })
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const preview = (await tool('create-google-rsa').handler(ask, asker)).preview
    h.mutate.mockClear()
    const byRule = await tool('create-google-rsa').execute!(ask, { ...approved(preview), approvedByPerson: false, decidedVia: 'auto' })
    expect(byRule.error).toMatch(/never by a rule/)
    expect(h.mutate).not.toHaveBeenCalled()
  })
})

describe('set-google-assets', () => {
  const ask = parsed('set-google-assets', { campaignId: '21', callouts: ['Ships in 24h', 'free returns'], unlinkAssets: [{ assetId: '9', fieldType: 'callout' }] })

  it('makes and links, unlinks; runs as ONE request; undo unlinks what it linked and links again what it unlinked', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 3, requestId: null })
    const preview = (await tool('set-google-assets').handler(ask, asker)).preview
    expect(preview).toMatchObject({
      spendsMoney: false,
      operations: 3,
      skipped: ['A callout "free returns" is already linked to "Search A".'],
      warnings: ['Unlinking 1 asset from "Search A": its ads show without it (the asset stays in the account).'],
    })
    h.mutate.mockReset()
    h.mutate.mockResolvedValue({ responses: [{ assetResult: { resourceName: 'customers/1234567890/assets/301' } }, { campaignAssetResult: { resourceName: 'customers/1234567890/campaignAssets/21~301~CALLOUT' } }, {}], ops: 3, requestId: 'r' })
    const run = await tool('set-google-assets').execute!(ask, approved(preview))
    expect(run.ok).toBe(true)
    expect(h.mutate.mock.calls[0][1]).toEqual([
      { assetOperation: { create: { resourceName: 'customers/1234567890/assets/-1', calloutAsset: { calloutText: 'Ships in 24h' } } } },
      { campaignAssetOperation: { create: { campaign: 'customers/1234567890/campaigns/21', asset: 'customers/1234567890/assets/-1', fieldType: 'CALLOUT' } } },
      { campaignAssetOperation: { remove: 'customers/1234567890/campaignAssets/21~9~CALLOUT' } },
    ])
    const after = { campaignId: '21', linked: [{ assetId: '301', fieldType: 'CALLOUT', text: 'Ships in 24h' }], unlinked: [{ assetId: '9', fieldType: 'CALLOUT', text: 'Free Returns' }], ...ACCOUNT }
    expect(run.change).toEqual({ before: { campaignId: '21', links: [{ assetId: '9', fieldType: 'CALLOUT', text: 'Free Returns' }], ...ACCOUNT }, after })
    expect(run.data).toMatchObject({ linked: after.linked, review: expect.stringContaining('google-ads-live view assets') })
    // Now 301 is linked and 9 is not: nothing moved since, so undo may run.
    h.live.assets = [{ ...(h.live.assets[0] as object), assetId: '301', text: 'Ships in 24h' }]
    expect(await tool('set-google-assets').undo!.current(run.change!)).toEqual(after)
    const undo = tool('set-google-assets').undo!.request(run.change!) as { tool: string; args: Record<string, unknown> }
    expect(undo).toMatchObject({ tool: 'set-google-assets', args: { accountId: 'g-1', campaignId: '21', unlinkAssets: [{ assetId: '301', fieldType: 'CALLOUT' }], linkAssets: [{ assetId: '9', fieldType: 'CALLOUT' }] } })
    expect(tool('set-google-assets').input.safeParse(undo.args).success).toBe(true)
  })

  it('not sent when the campaign\'s assets moved since it was approved', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 3, requestId: null })
    const preview = (await tool('set-google-assets').handler(ask, asker)).preview
    h.live.assets = [...h.live.assets, { ...(h.live.assets[0] as object), assetId: '10', text: 'Gift wrap' }]
    h.mutate.mockClear()
    const run = await tool('set-google-assets').execute!(ask, approved(preview))
    expect(run.ok).toBe(false)
    expect(run.error).toMatch(/changed since this was approved/)
    expect(h.mutate).not.toHaveBeenCalled()
  })
})
