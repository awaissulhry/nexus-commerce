/**
 * Google Ads changes (2026-10-15, programme 2 group G3) — edit-google-rsa, edit-google-assets, set-google-urls,
 * replace-google-keywords and move-google-ads as the approval gate uses them (Google, the account and the live reads are
 * stand-ins): the preview is built on Google's check (validate_only); a request Nexus can see is wrong is refused before
 * anything is read or sent; a run happens only as a request a person approved, as ONE request with validateOnly false, and
 * its record holds the ids Google gave what it made; undo puts back the old texts, URLs and places exactly — every undo
 * request passes its target tool's own draft, not only its input — and a replacement or a move, being removals, are asked
 * for only with confirmRemove.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  enqueue: vi.fn(async () => ({ queued: true, reason: null })),
  live: {
    campaigns: [] as unknown[], campaignAssets: [] as unknown[], places: {} as Record<string, unknown>, adGroups: [] as unknown[],
    ads: [] as unknown[], campaignUrls: [] as unknown[], adGroupUrls: [] as unknown[], keywords: [] as unknown[], assets: [] as unknown[], links: [] as unknown[],
    byId: [] as unknown[], matchType: null as string | null,
  },
  reads: vi.fn(),
}))
vi.mock('../../marketing/google-ads/change-account.js', () => ({
  googleChangeAccount: vi.fn(async () => ({
    target: { connectionId: 'g-1', customerId: '1234567890', loginCustomerId: null }, accountId: 'g-1', customerId: '1234567890', name: 'Shop', currency: 'EUR', timeZone: 'Europe/Rome',
  })),
}))
vi.mock('../../marketing/google-ads/live.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live.js')>()),
  liveCampaigns: vi.fn(async () => structuredClone(h.live.campaigns)),
  liveAssets: vi.fn(async () => structuredClone(h.live.campaignAssets)),
}))
vi.mock('../../marketing/google-ads/live-ads-assets.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live-ads-assets.js')>()),
  liveAdGroupPlace: vi.fn(async (_t: unknown, _c: string, adGroupId: string) => structuredClone(h.live.places[adGroupId] ?? null)),
  liveAssetsById: vi.fn(async () => structuredClone(h.live.byId)),
}))
vi.mock('../../marketing/google-ads/live-keywords.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live-keywords.js')>()),
  liveAdGroups: vi.fn(async () => structuredClone(h.live.adGroups)),
  liveCampaignKeywordMatchType: vi.fn(async () => h.live.matchType),
}))
vi.mock('../../marketing/google-ads/live-edit.js', async (importActual) => {
  const read = <T>(what: string, value: () => T) => { h.reads(what); return structuredClone(value()) }
  const ads = () => h.live.ads as Array<{ id: string; adGroupId: string }>
  return {
    ...(await importActual<typeof import('../../marketing/google-ads/live-edit.js')>()),
    liveEditAds: vi.fn(async (_t: unknown, ids: string[]) => read('ads', () => ads().filter((a) => ids.includes(a.id)))),
    liveAdGroupAds: vi.fn(async (_t: unknown, adGroupId: string) => read('ad-group-ads', () => ads().filter((a) => a.adGroupId === adGroupId))),
    liveCampaignUrls: vi.fn(async () => read('campaigns', () => h.live.campaignUrls)),
    liveAdGroupUrls: vi.fn(async () => read('ad-groups', () => h.live.adGroupUrls)),
    liveKeywordUrls: vi.fn(async () => read('keywords', () => h.live.keywords)),
    liveCampaignKeywordUrls: vi.fn(async () => read('campaign-keywords', () => h.live.keywords)),
    liveEditAssets: vi.fn(async () => read('assets', () => ({ assets: h.live.assets, links: h.live.links }))),
    liveAssetsForEdit: vi.fn(async () => read('assets', () => h.live.assets)),
  }
})
vi.mock('../../marketing/google-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/write-client.js')>()),
  mutateGoogleAds: h.mutate,
}))
vi.mock('../../marketing/google-ads/enqueue.js', () => ({ enqueueGoogleAdsSync: h.enqueue }))

import { GOOGLE_ADS_EDIT_TOOLS } from './google-ads-edit.tools.js'
import { GOOGLE_ADS_ADS_ASSETS_TOOLS } from './google-ads-ads-assets.tools.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import type { ToolContext } from '../tool-types.js'

const tool = (name: string) => GOOGLE_ADS_EDIT_TOOLS.find((t) => t.name === name)!
const parsed = (name: string, args: Record<string, unknown>) => tool(name).input.parse(args) as Record<string, unknown>
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })
const ACCOUNT = { accountId: 'g-1', customerId: '1234567890' }
const C = 'customers/1234567890'
const NO_URLS = { trackingTemplate: null, finalUrlSuffix: null, customParameters: [] }

const CAMPAIGN = { campaignId: '21', name: 'Search A', status: 'ENABLED', servingStatus: null, primaryStatus: null, type: 'SEARCH', subType: null, bidding: 'MANUAL_CPC', start: null, end: null, shopping: null, budget: null }
const place = (adGroupId: string) => ({ campaign: { campaignId: '21', name: 'Search A', status: 'ENABLED', type: 'SEARCH' }, adGroup: { adGroupId, name: `Group ${adGroupId}`, status: 'PAUSED', type: 'SEARCH_STANDARD' } })
const ad = (adGroupId: string, adId: string, over: Record<string, unknown> = {}) => ({
  id: `${adGroupId}~${adId}`, adId, adGroupId, adGroupName: `Group ${adGroupId}`, adGroupStatus: 'PAUSED', campaignId: '21', campaignName: 'Search A', campaignStatus: 'ENABLED',
  campaignType: 'SEARCH', status: 'PAUSED', type: 'RESPONSIVE_SEARCH_AD', approval: 'APPROVED',
  headlines: [{ text: 'Moto Jackets', pin: null }, { text: 'Free Returns', pin: null }, { text: 'Shop A', pin: null }],
  descriptions: [{ text: 'Leather jackets.', pin: null }, { text: 'Ships in 24 hours.', pin: null }],
  path1: null, path2: null, finalUrls: ['https://shop.example/a'], finalMobileUrls: [], urls: NO_URLS, ...over,
})
const keyword = (id: string, text: string, matchType: string, over: Record<string, unknown> = {}) => {
  const [adGroupId, criterionId] = id.split('~')
  return { id, adGroupId, criterionId, adGroupName: '', adGroupStatus: 'PAUSED', campaignId: '21', campaignName: 'Search A', campaignStatus: 'ENABLED', text, matchType, negative: false, status: 'PAUSED', cpcBidCents: 30, effectiveCpcBidCents: 30, finalUrls: [], finalMobileUrls: [], urls: NO_URLS, ...over }
}

beforeEach(() => {
  h.mutate.mockReset()
  h.enqueue.mockClear()
  h.reads.mockClear()
  vi.unstubAllEnvs()
  h.live.campaigns = [CAMPAIGN]
  h.live.places = { 51: place('51'), 52: place('52') }
  h.live.adGroups = [{ adGroupId: '51', name: 'Group 51', status: 'PAUSED', type: 'SEARCH_STANDARD', cpcBidCents: 40 }, { adGroupId: '52', name: 'Group 52', status: 'PAUSED', type: 'SEARCH_STANDARD', cpcBidCents: 40 }]
  h.live.ads = [ad('51', '701')]
  h.live.campaignUrls = [{ campaignId: '21', name: 'Search A', status: 'ENABLED', urls: { ...NO_URLS, trackingTemplate: '{lpurl}?old=1' } }]
  h.live.adGroupUrls = []
  h.live.keywords = [keyword('51~601', 'moto jacket', 'EXACT', { finalUrls: ['https://shop.example/k'] })]
  h.live.assets = [{ assetId: '9', type: 'CALLOUT', source: 'ADVERTISER', name: null, finalUrls: [], finalMobileUrls: [], urls: NO_URLS, calloutText: 'Free returns' }]
  h.live.byId = [{ assetId: '9', type: 'CALLOUT', text: 'Free returns', finalUrls: [] }]
  h.live.matchType = null
  h.live.links = [{ assetId: '9', level: 'campaign', fieldType: 'CALLOUT', status: 'ENABLED', campaignId: '21', campaignName: 'Search A', campaignStatus: 'ENABLED' }]
  h.live.campaignAssets = [{ campaignId: '21', assetId: '9', fieldType: 'CALLOUT', type: 'CALLOUT', status: 'ENABLED' }]
})

/** Preview (Google's check), then a run as the person who approved it, answering `responses`. */
async function previewAndRun(name: string, args: Record<string, unknown>, responses: unknown[]) {
  h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
  const out = await tool(name).handler(args, asker)
  if (!out.ok) throw new Error(out.error)
  expect(h.mutate.mock.calls[0][2]).toEqual({ validateOnly: true })
  const sent = h.mutate.mock.calls[0][1]
  h.mutate.mockReset()
  h.mutate.mockResolvedValue({ responses, ops: 1, requestId: 'r' })
  const run = await tool(name).execute!(args, approved(out.preview))
  if (!run.ok) throw new Error(run.error)
  expect(h.mutate).toHaveBeenCalledTimes(1)
  expect(h.mutate.mock.calls[0][2]).toMatchObject({ validateOnly: false })
  expect(h.mutate.mock.calls[0][1]).toEqual(sent)
  return { preview: out.preview as Record<string, unknown>, sent, run }
}

const TARGETS = [...GOOGLE_ADS_EDIT_TOOLS, ...GOOGLE_ADS_ADS_ASSETS_TOOLS]
/**
 * An undo request as the gate takes it: parsed by its TARGET tool's input and built by that tool's draft on the account as
 * it is after the run — accepted (not only valid arguments). Returns the undo's preview and what it would send.
 */
async function undoDraft(undo: { tool: string; args: Record<string, unknown> }) {
  const target = TARGETS.find((t) => t.name === undo.tool)!
  const args = target.input.parse(undo.args) as Record<string, unknown>
  h.mutate.mockReset()
  h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
  const out = await target.handler(args, asker)
  expect(out.error, `${undo.tool}: the undo request passes its draft`).toBeUndefined()
  return { preview: out.preview as Record<string, unknown>, sent: h.mutate.mock.calls[0][1] as unknown[] }
}

describe('the G3 tools', () => {
  it('are Nexus changes a person approves: alwaysAsk, ask at most, reach Google, re-check fields declared', () => {
    expect(GOOGLE_ADS_EDIT_TOOLS.map((t) => t.name)).toEqual(['edit-google-rsa', 'edit-google-assets', 'set-google-urls', 'replace-google-keywords', 'move-google-ads'])
    for (const t of GOOGLE_ADS_EDIT_TOOLS) {
      expect(t).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', openWorld: true, readOnly: false, riskTier: 'high', requiresApprovalDefault: true })
      expect(MATERIAL_PREVIEW_FIELDS[t.name]).toEqual(['basis', 'plan', 'reach'])
      expect(t.undo).toBeDefined()
    }
    expect(GOOGLE_ADS_EDIT_TOOLS.map((t) => t.reversibility)).toEqual(['full', 'full', 'full', 'partial', 'partial'])
    // Only the keyword replacement carries bids: it cannot be judged without the ad spend.
    expect(tool('replace-google-keywords').requires).toContain('financials.adspend.view')
    expect(GOOGLE_ADS_EDIT_TOOLS.filter((t) => t.restrictedFields).map((t) => t.name)).toEqual(['replace-google-keywords'])
  })

  it('a replacement or a move is a removal: refused by the input without confirmRemove', () => {
    expect(tool('replace-google-keywords').input.safeParse({ campaignId: '21', keywords: [{ keywordId: '51~601', matchType: 'PHRASE' }] }).success).toBe(false)
    expect(tool('move-google-ads').input.safeParse({ campaignId: '21', adGroupId: '51', toAdGroupId: '52', adIds: ['701'] }).success).toBe(false)
  })
})

describe('edit-google-rsa', () => {
  it('previews on Google\'s check, runs as ONE AdOperation update, and undo puts the old headlines back in place', async () => {
    const ask = parsed('edit-google-rsa', { ads: [{ id: '51~701', headlines: [{ text: 'Moto Jackets', pin: 'headline_1' }, { text: 'Free Returns' }, { text: 'Winter Sale' }] }] })
    const { preview, sent, run } = await previewAndRun('edit-google-rsa', ask, [{ adResult: { resourceName: `${C}/ads/701` } }])
    expect(preview).toMatchObject({ spendsMoney: false, operations: 1, googleCheck: { checked: true, accepted: true } })
    expect(sent).toEqual([{ adOperation: { update: { resourceName: `${C}/ads/701`, responsiveSearchAd: { headlines: [{ text: 'Moto Jackets', pinnedField: 'HEADLINE_1' }, { text: 'Free Returns' }, { text: 'Winter Sale' }] } }, updateMask: 'responsive_search_ad.headlines' } }])
    const after = { ads: [{ id: '51~701', campaignId: '21', headlines: [{ text: 'Moto Jackets', pin: 'HEADLINE_1' }, { text: 'Free Returns' }, { text: 'Winter Sale' }] }], ...ACCOUNT }
    expect(run.change).toEqual({ before: { ads: [{ id: '51~701', campaignId: '21', headlines: [{ text: 'Moto Jackets' }, { text: 'Free Returns' }, { text: 'Shop A' }] }], ...ACCOUNT }, after })
    // The ad reads as the change wrote it: undo may run; it asks for the same tool with the old list.
    h.live.ads = [ad('51', '701', { headlines: [{ text: 'Moto Jackets', pin: 'HEADLINE_1' }, { text: 'Free Returns', pin: null }, { text: 'Winter Sale', pin: null }] })]
    expect(await tool('edit-google-rsa').undo!.current(run.change!)).toEqual(after)
    const undo = tool('edit-google-rsa').undo!.request(run.change!) as { tool: string; args: Record<string, unknown> }
    expect(undo).toMatchObject({ tool: 'edit-google-rsa', args: { accountId: 'g-1', ads: [{ id: '51~701', headlines: [{ text: 'Moto Jackets' }, { text: 'Free Returns' }, { text: 'Shop A' }] }] } })
    expect(tool('edit-google-rsa').input.safeParse(undo.args).success).toBe(true)
    expect((await undoDraft(undo)).sent).toEqual([{ adOperation: { update: { resourceName: `${C}/ads/701`, responsiveSearchAd: { headlines: [{ text: 'Moto Jackets' }, { text: 'Free Returns' }, { text: 'Shop A' }] } }, updateMask: 'responsive_search_ad.headlines' } }])
    // Edited again since: undo would overwrite that later change.
    h.live.ads = [ad('51', '701')]
    expect(await tool('edit-google-rsa').undo!.current(run.change!)).not.toEqual(after)
  })

  it('never by a rule: a run the business\'s rule decided is refused before anything is sent', async () => {
    const ask = parsed('edit-google-rsa', { ads: [{ id: '51~701', finalUrl: 'https://shop.example/b' }] })
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const preview = (await tool('edit-google-rsa').handler(ask, asker)).preview
    h.mutate.mockClear()
    const byRule = await tool('edit-google-rsa').execute!(ask, { ...approved(preview), approvedByPerson: false, decidedVia: 'auto' })
    expect(byRule.error).toMatch(/never by a rule/)
    expect(h.mutate).not.toHaveBeenCalled()
  })
})

describe('edit-google-assets', () => {
  it('in place: one AssetOperation update; undo puts the old text back through the same tool', async () => {
    const ask = parsed('edit-google-assets', { assets: [{ assetId: '9', calloutText: 'Free 30-day returns' }] })
    const { sent, run } = await previewAndRun('edit-google-assets', ask, [{ assetResult: { resourceName: `${C}/assets/9` } }])
    expect(sent).toEqual([{ assetOperation: { update: { resourceName: `${C}/assets/9`, calloutAsset: { calloutText: 'Free 30-day returns' } }, updateMask: 'callout_asset.callout_text' } }])
    h.live.assets = [{ ...(h.live.assets[0] as object), calloutText: 'Free 30-day returns' }]
    expect(await tool('edit-google-assets').undo!.current(run.change!)).toEqual(run.change!.after)
    const undo = tool('edit-google-assets').undo!.request(run.change!) as { tool: string; args: Record<string, unknown> }
    expect(undo).toMatchObject({ tool: 'edit-google-assets', args: { assets: [{ assetId: '9', calloutText: 'Free returns' }] } })
    expect(tool('edit-google-assets').input.safeParse(undo.args).success).toBe(true)
    expect((await undoDraft(undo)).sent).toEqual([{ assetOperation: { update: { resourceName: `${C}/assets/9`, calloutAsset: { calloutText: 'Free returns' } }, updateMask: 'callout_asset.callout_text' } }])
  })

  it('replaced in one campaign: the new asset\'s id from Google; undo links the old one again and unlinks the new one (set-google-assets)', async () => {
    const ask = parsed('edit-google-assets', { assets: [{ assetId: '9', calloutText: 'Free 30-day returns' }], onlyInCampaignId: '21' })
    const { run } = await previewAndRun('edit-google-assets', ask, [{ assetResult: { resourceName: `${C}/assets/321` } }, {}, {}])
    expect(run.data).toMatchObject({ campaignId: '21', replaced: [{ oldAssetId: '9', newAssetId: '321', fieldType: 'CALLOUT', status: 'ENABLED' }] })
    h.live.campaignAssets = [{ campaignId: '21', assetId: '321', fieldType: 'CALLOUT', type: 'CALLOUT', status: 'ENABLED' }]
    expect(await tool('edit-google-assets').undo!.current(run.change!)).toEqual(run.change!.after)
    const undo = tool('edit-google-assets').undo!.request(run.change!) as { tool: string; args: Record<string, unknown> }
    expect(undo).toMatchObject({ tool: 'set-google-assets', args: { campaignId: '21', linkAssets: [{ assetId: '9', fieldType: 'CALLOUT', status: 'ENABLED' }], unlinkAssets: [{ assetId: '321', fieldType: 'CALLOUT' }] } })
    expect((await undoDraft(undo)).sent).toEqual([
      { campaignAssetOperation: { create: { campaign: `${C}/campaigns/21`, asset: `${C}/assets/9`, fieldType: 'CALLOUT' } } },
      { campaignAssetOperation: { remove: `${C}/campaignAssets/21~321~CALLOUT` } },
    ])
  })
})

describe('set-google-urls', () => {
  it('an id that cannot be of its level is refused before anything is read', async () => {
    const out = await tool('set-google-urls').handler(parsed('set-google-urls', { items: [{ level: 'keyword', id: '601', finalUrl: 'https://shop.example/x' }] }), asker)
    expect(out.error).toBe('keyword "601": a keyword is adGroupId~criterionId.')
    expect(h.reads).not.toHaveBeenCalled()
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('campaign tracking and a keyword\'s own page in ONE request; undo puts both back exactly (null where there was none)', async () => {
    const ask = parsed('set-google-urls', { items: [{ level: 'campaign', id: '21', trackingTemplate: null, finalUrlSuffix: 'src=google' }, { level: 'keyword', id: '51~601', finalUrl: 'https://shop.example/k2' }] })
    const { sent, run } = await previewAndRun('set-google-urls', ask, [{}, {}])
    expect(sent).toEqual([
      { campaignOperation: { update: { resourceName: `${C}/campaigns/21`, finalUrlSuffix: 'src=google' }, updateMask: 'tracking_url_template,final_url_suffix' } },
      { adGroupCriterionOperation: { update: { resourceName: `${C}/adGroupCriteria/51~601`, finalUrls: ['https://shop.example/k2'] }, updateMask: 'final_urls' } },
    ])
    expect(h.reads.mock.calls.map((c) => c[0]).sort()).toEqual(['campaigns', 'campaigns', 'keywords', 'keywords'])
    h.live.campaignUrls = [{ campaignId: '21', name: 'Search A', status: 'ENABLED', urls: { ...NO_URLS, finalUrlSuffix: 'src=google' } }]
    h.live.keywords = [keyword('51~601', 'moto jacket', 'EXACT', { finalUrls: ['https://shop.example/k2'] })]
    expect(await tool('set-google-urls').undo!.current(run.change!)).toEqual(run.change!.after)
    const undo = tool('set-google-urls').undo!.request(run.change!) as { tool: string; args: Record<string, unknown> }
    expect(undo.args.items).toEqual([{ level: 'campaign', id: '21', trackingTemplate: '{lpurl}?old=1', finalUrlSuffix: null }, { level: 'keyword', id: '51~601', finalUrl: 'https://shop.example/k' }])
    expect(tool('set-google-urls').input.safeParse(undo.args).success).toBe(true)
    expect((await undoDraft(undo)).sent).toEqual([
      { campaignOperation: { update: { resourceName: `${C}/campaigns/21`, trackingUrlTemplate: '{lpurl}?old=1' }, updateMask: 'tracking_url_template,final_url_suffix' } },
      { adGroupCriterionOperation: { update: { resourceName: `${C}/adGroupCriteria/51~601`, finalUrls: ['https://shop.example/k'] }, updateMask: 'final_urls' } },
    ])
  })
})

describe('replace-google-keywords', () => {
  it('runs remove + add as ONE request; the record names the new keyword; undo replaces back (confirmRemove, the person asked)', async () => {
    const ask = parsed('replace-google-keywords', { campaignId: '21', keywords: [{ keywordId: '51~601', matchType: 'phrase' }], confirmRemove: true })
    const { preview, sent, run } = await previewAndRun('replace-google-keywords', ask, [{}, { adGroupCriterionResult: { resourceName: `${C}/adGroupCriteria/51~602` } }])
    expect(sent).toEqual([
      { adGroupCriterionOperation: { remove: `${C}/adGroupCriteria/51~601` } },
      { adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/51`, status: 'PAUSED', keyword: { text: 'moto jacket', matchType: 'PHRASE' }, cpcBidMicros: '300000', finalUrls: ['https://shop.example/k'] } } },
    ])
    // Paused, in a paused ad group: it cannot serve; a wider match type is still said.
    expect(preview.spendsMoneyBecause).toEqual(['1 replacement has a wider match type, so it matches more searches: [moto jacket] → "moto jacket".'])
    expect(run.data).toEqual(expect.objectContaining({ replaced: [{ from: '51~601', to: '51~602', text: 'moto jacket', matchType: 'PHRASE', adGroupId: '51', status: 'PAUSED' }] }))
    expect(run.change?.after).toMatchObject({ replaced: [{ status: 'PAUSED', fromStatus: 'PAUSED' }] })
    h.live.keywords = [keyword('51~602', 'moto jacket', 'PHRASE', { finalUrls: ['https://shop.example/k'] })]
    expect(await tool('replace-google-keywords').undo!.current(run.change!)).toEqual(run.change!.after)
    const undo = tool('replace-google-keywords').undo!.request(run.change!) as { tool: string; args: Record<string, unknown> }
    expect(undo).toMatchObject({ tool: 'replace-google-keywords', args: { campaignId: '21', keywords: [{ keywordId: '51~602', matchType: 'EXACT', status: 'PAUSED' }], confirmRemove: true } })
    expect(undo.args.enable).toBeUndefined()
    expect((await undoDraft(undo)).sent).toEqual([
      { adGroupCriterionOperation: { remove: `${C}/adGroupCriteria/51~602` } },
      { adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/51`, status: 'PAUSED', keyword: { text: 'moto jacket', matchType: 'EXACT' }, cpcBidMicros: '300000', finalUrls: ['https://shop.example/k'] } } },
    ])
  })

  it('an enabled keyword in an enabled ad group of the enabled campaign: PAUSED without enable; its undo gives it back ENABLED (enable, SPENDS MONEY said)', async () => {
    h.live.adGroups = [{ adGroupId: '51', name: 'Group 51', status: 'ENABLED', type: 'SEARCH_STANDARD', cpcBidCents: 40 }]
    h.live.keywords = [keyword('51~601', 'moto jacket', 'EXACT', { status: 'ENABLED', adGroupStatus: 'ENABLED' })]
    const ask = parsed('replace-google-keywords', { campaignId: '21', keywords: [{ keywordId: '51~601', text: 'moto jackets' }], confirmRemove: true })
    const { preview, run } = await previewAndRun('replace-google-keywords', ask, [{}, { adGroupCriterionResult: { resourceName: `${C}/adGroupCriteria/51~603` } }])
    expect(preview.warnings).toEqual(expect.arrayContaining([expect.stringContaining('the old keyword\'s traffic stops until a person enables the new one')]))
    h.live.keywords = [keyword('51~603', 'moto jackets', 'EXACT', { status: 'PAUSED', adGroupStatus: 'ENABLED' })]
    const undo = tool('replace-google-keywords').undo!.request(run.change!) as { tool: string; args: Record<string, unknown> }
    expect(undo.args).toMatchObject({ keywords: [{ keywordId: '51~603', text: 'moto jacket', status: 'ENABLED' }], enable: true })
    const back = await undoDraft(undo)
    expect((back.sent[1] as any).adGroupCriterionOperation.create.status).toBe('ENABLED')
    expect(back.preview.spendsMoney).toBe(true)
  })

  it('in a campaign set to broad match the change needed allowBroad, and so does its undo', async () => {
    h.live.matchType = 'BROAD'
    const ask = parsed('replace-google-keywords', { campaignId: '21', keywords: [{ keywordId: '51~601', text: 'moto jackets' }], allowBroad: true, confirmRemove: true })
    const { run } = await previewAndRun('replace-google-keywords', ask, [{}, { adGroupCriterionResult: { resourceName: `${C}/adGroupCriteria/51~603` } }])
    h.live.keywords = [keyword('51~603', 'moto jackets', 'EXACT', { finalUrls: ['https://shop.example/k'] })]
    const undo = tool('replace-google-keywords').undo!.request(run.change!) as { tool: string; args: Record<string, unknown> }
    expect(undo.args.allowBroad).toBe(true)
    await undoDraft(undo)
  })
})

describe('move-google-ads', () => {
  it('made again in the other ad group and removed here, in ONE request; undo moves it back', async () => {
    const ask = parsed('move-google-ads', { campaignId: '21', adGroupId: '51', toAdGroupId: '52', adIds: ['701'], confirmRemove: true })
    const { sent, run } = await previewAndRun('move-google-ads', ask, [{ adGroupAdResult: { resourceName: `${C}/adGroupAds/52~901` } }, {}])
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual({ adGroupAdOperation: { remove: `${C}/adGroupAds/51~701` } })
    expect(run.data).toMatchObject({ moved: [{ fromAdId: '701', toAdId: '901', status: 'PAUSED' }] })
    h.live.ads = [ad('52', '901')]
    expect(await tool('move-google-ads').undo!.current(run.change!)).toEqual(run.change!.after)
    const undo = tool('move-google-ads').undo!.request(run.change!) as { tool: string; args: Record<string, unknown> }
    expect(undo).toMatchObject({ tool: 'move-google-ads', args: { campaignId: '21', adGroupId: '52', toAdGroupId: '51', adIds: ['901'], statusOf: [{ adId: '901', status: 'PAUSED' }], confirmRemove: true } })
    expect(tool('move-google-ads').input.safeParse(undo.args).success).toBe(true)
    const back = await undoDraft(undo)
    expect(back.sent[1]).toEqual({ adGroupAdOperation: { remove: `${C}/adGroupAds/52~901` } })
    expect((back.sent[0] as any).adGroupAdOperation.create).toMatchObject({ adGroup: `${C}/adGroups/51`, status: 'PAUSED' })
  })
})
