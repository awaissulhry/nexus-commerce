/**
 * Google Ads changes (2026-10-15, programme 2 group G6) — add-google-assets and set-google-asset-links as the approval
 * gate uses them (Google, the account, the live reads and the image fetch are stand-ins): the preview is built on Google's
 * check (validate_only); a run happens only as a request a person approved, as ONE request with validateOnly false, and
 * its record holds the ids Google gave the new assets (never an image's bytes); undo takes off the links it made, or puts
 * every link back as it was — each undo request passes its target tool's own draft; an image that changed after the
 * approval is not sent; a library image needs the image library permission; the images one request carries are capped.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURES as F } from '@nexus/shared/permissions'

type Link = {
  level: 'account' | 'campaign' | 'ad-group'; campaignId: string | null; campaignName: string | null; campaignStatus: string | null
  adGroupId: string | null; adGroupName: string | null; adGroupStatus: string | null; assetId: string; fieldType: string; status: string
  source: string; primaryStatus: string | null; asset: Record<string, unknown>
}
const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  enqueue: vi.fn(async () => ({ queued: true, reason: null })),
  prepare: vi.fn(),
  live: { campaigns: [] as unknown[], adGroups: [] as Array<{ adGroupId: string }>, links: [] as Link[], assets: [] as Array<{ assetId: string }>, terms: true, accountAssets: [] as Array<{ type: string }> },
  accountReads: [] as string[][],
}))
vi.mock('../../marketing/google-ads/change-account.js', () => ({
  googleChangeAccount: vi.fn(async () => ({
    target: { connectionId: 'g-1', customerId: '1234567890', loginCustomerId: null }, accountId: 'g-1', customerId: '1234567890', name: 'Shop', currency: 'EUR', timeZone: 'Europe/Rome',
  })),
}))
vi.mock('../../marketing/google-ads/live.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live.js')>()),
  liveCampaigns: vi.fn(async () => structuredClone(h.live.campaigns)),
}))
vi.mock('../../marketing/google-ads/live-assets-all.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live-assets-all.js')>()),
  liveAdGroupsById: vi.fn(async (_t: unknown, ids: string[]) => structuredClone(h.live.adGroups.filter((g) => ids.includes(g.adGroupId)))),
  livePlaceLinks: vi.fn(async (_t: unknown, at: { account: boolean; campaignIds: string[]; adGroupIds: string[] }, filter: { fieldTypes?: string[]; assetIds?: string[] }) =>
    structuredClone(h.live.links.filter((l) =>
      ((l.level === 'account' && at.account) || (l.level === 'campaign' && at.campaignIds.includes(l.campaignId!)) || (l.level === 'ad-group' && at.adGroupIds.includes(l.adGroupId!)))
      && (!filter.fieldTypes || filter.fieldTypes.includes(l.fieldType)) && (!filter.assetIds || filter.assetIds.includes(l.assetId))))),
  liveAssetDetails: vi.fn(async (_t: unknown, ids: string[]) => structuredClone(h.live.assets.filter((a) => ids.includes(a.assetId)))),
  liveLeadFormTerms: vi.fn(async () => h.live.terms),
  liveAccountAssets: vi.fn(async (_t: unknown, types: string[]) => { h.accountReads.push(types); return structuredClone(h.live.accountAssets.filter((a) => types.includes(a.type))) }),
}))
vi.mock('../../marketing/google-ads/asset-images.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/asset-images.js')>()),
  prepareImage: h.prepare,
}))
vi.mock('../../marketing/google-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/write-client.js')>()),
  mutateGoogleAds: h.mutate,
}))
vi.mock('../../marketing/google-ads/enqueue.js', () => ({ enqueueGoogleAdsSync: h.enqueue }))

import { GOOGLE_ADS_ASSETS_ALL_TOOLS } from './google-ads-assets-all.tools.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import type { ToolContext } from '../tool-types.js'

const tool = (name: string) => GOOGLE_ADS_ASSETS_ALL_TOOLS.find((t) => t.name === name)!
const parsed = (name: string, args: Record<string, unknown>) => tool(name).input.parse(args) as Record<string, unknown>
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })
const ACCOUNT = { accountId: 'g-1', customerId: '1234567890' }
const C = 'customers/1234567890'

const campaign = (campaignId: string, name: string, status: string) => ({
  campaignId, name, status, servingStatus: null, primaryStatus: null, type: 'SEARCH', subType: null, bidding: 'MANUAL_CPC', start: null, end: null, shopping: null, budget: null,
})
const asset = (assetId: string, type: string, label: string, details: Record<string, unknown>) =>
  ({ assetId, type, name: null, source: 'ADVERTISER', label, finalUrls: [], approval: null, review: null, details })
const CALL = asset('302', 'CALL', '000 111 2222 (IT)', { countryCode: 'IT', phoneNumber: '000 111 2222' })
const CALLOUT = asset('9', 'CALLOUT', 'Free returns', { calloutText: 'Free returns' })
const linkAt = (level: Link['level'], where: { campaignId?: string; adGroupId?: string }, a: { assetId: string }, fieldType: string, status = 'ENABLED'): Link => ({
  level, campaignId: where.campaignId ?? null, campaignName: where.campaignId ? 'Search A' : null, campaignStatus: where.campaignId ? 'ENABLED' : null,
  adGroupId: where.adGroupId ?? null, adGroupName: where.adGroupId ? 'Jackets' : null, adGroupStatus: where.adGroupId ? 'ENABLED' : null,
  assetId: a.assetId, fieldType, status, source: 'ADVERTISER', primaryStatus: null, asset: a,
})
const IMAGE = { source: 'https://cdn.example/a.png', label: 'a', mimeType: 'image/png', bytes: 2048, width: 1200, height: 1200, sha256: 'ab'.repeat(32), data: 'iVBORw0KGgo=' }

beforeEach(() => {
  h.mutate.mockReset()
  h.enqueue.mockClear()
  h.prepare.mockReset()
  h.prepare.mockImplementation(async () => structuredClone(IMAGE))
  h.live.campaigns = [campaign('21', 'Search A', 'ENABLED'), campaign('22', 'Search B', 'PAUSED')]
  h.live.adGroups = [{ adGroupId: '51', name: 'Jackets', status: 'ENABLED', campaignId: '21', campaignName: 'Search A', campaignStatus: 'ENABLED', campaignType: 'SEARCH' } as never]
  h.live.links = []
  h.live.assets = [CALL, CALLOUT]
  h.live.terms = true
  h.live.accountAssets = []
  h.accountReads.length = 0
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

/** An undo request as the gate takes it: parsed by its TARGET tool's input and built by that tool's draft (accepted). */
async function undoDraft(undo: { tool: string; args: Record<string, unknown> }) {
  const args = tool(undo.tool).input.parse(undo.args) as Record<string, unknown>
  h.mutate.mockReset()
  h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
  const out = await tool(undo.tool).handler(args, asker)
  expect(out.error, `${undo.tool}: the undo request passes its draft`).toBeUndefined()
  return { preview: out.preview as Record<string, unknown>, sent: h.mutate.mock.calls[0][1] as unknown[] }
}

describe('the G6 tools', () => {
  it('are Nexus changes a person approves: alwaysAsk, ask at most, reach Google, re-check fields declared, undo', () => {
    expect(GOOGLE_ADS_ASSETS_ALL_TOOLS.map((t) => t.name)).toEqual(['add-google-assets', 'set-google-asset-links'])
    for (const t of GOOGLE_ADS_ASSETS_ALL_TOOLS) {
      expect(t).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', openWorld: true, readOnly: false, riskTier: 'high', requiresApprovalDefault: true })
      expect(MATERIAL_PREVIEW_FIELDS[t.name]).toEqual(['basis', 'plan', 'reach'])
      expect(t.undo).toBeDefined()
    }
    // Google never removes an asset: undo of new assets takes their links off (partial); links go back exactly (full).
    expect(GOOGLE_ADS_ASSETS_ALL_TOOLS.map((t) => t.reversibility)).toEqual(['partial', 'full'])
  })
})

describe('add-google-assets', () => {
  it('a call and a callout at the account and a campaign in ONE request; the call PAUSED where it serves; undo unlinks them', async () => {
    const ask = parsed('add-google-assets', { calls: [{ countryCode: 'it', phoneNumber: '000 111 2222' }], callouts: ['Free returns'], linkTo: [{ level: 'account' }, { level: 'campaign', campaignId: '21' }] })
    const { preview, sent, run } = await previewAndRun('add-google-assets', ask, [{ assetResult: { resourceName: `${C}/assets/301` } }, { assetResult: { resourceName: `${C}/assets/303` } }, {}, {}, {}, {}])
    expect(sent).toEqual([
      { assetOperation: { create: { resourceName: `${C}/assets/-1`, callAsset: { countryCode: 'IT', phoneNumber: '000 111 2222' } } } },
      { assetOperation: { create: { resourceName: `${C}/assets/-2`, calloutAsset: { calloutText: 'Free returns' } } } },
      { customerAssetOperation: { create: { asset: `${C}/assets/-1`, fieldType: 'CALL', status: 'PAUSED' } } },
      { campaignAssetOperation: { create: { campaign: `${C}/campaigns/21`, asset: `${C}/assets/-1`, fieldType: 'CALL', status: 'PAUSED' } } },
      { customerAssetOperation: { create: { asset: `${C}/assets/-2`, fieldType: 'CALLOUT' } } },
      { campaignAssetOperation: { create: { campaign: `${C}/campaigns/21`, asset: `${C}/assets/-2`, fieldType: 'CALLOUT' } } },
    ])
    expect(preview).toMatchObject({ spendsMoney: false, operations: 6, googleCheck: { checked: true, accepted: true } })
    expect(preview.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^Made PAUSED where it would serve/)]))
    expect(run.data).toMatchObject({ created: [{ assetId: '301', type: 'CALL' }, { assetId: '303', type: 'CALLOUT' }] })
    const linked = [
      { level: 'account', campaignId: null, adGroupId: null, assetId: '301', fieldType: 'CALL', status: 'PAUSED', text: '000 111 2222 (IT)' },
      { level: 'campaign', campaignId: '21', adGroupId: null, assetId: '301', fieldType: 'CALL', status: 'PAUSED', text: '000 111 2222 (IT)' },
      { level: 'account', campaignId: null, adGroupId: null, assetId: '303', fieldType: 'CALLOUT', status: 'ENABLED', text: 'Free returns' },
      { level: 'campaign', campaignId: '21', adGroupId: null, assetId: '303', fieldType: 'CALLOUT', status: 'ENABLED', text: 'Free returns' },
    ]
    expect(run.change).toEqual({ before: { created: [], linked: [], ...ACCOUNT }, after: { created: expect.any(Array), linked, ...ACCOUNT } })

    // The account reads as the change left it: undo may run, and unlinks every link it made (the assets stay).
    const call = { ...CALL, assetId: '301' }
    const callout = { ...CALLOUT, assetId: '303' }
    h.live.links = [linkAt('account', {}, call, 'CALL', 'PAUSED'), linkAt('campaign', { campaignId: '21' }, call, 'CALL', 'PAUSED'), linkAt('account', {}, callout, 'CALLOUT'), linkAt('campaign', { campaignId: '21' }, callout, 'CALLOUT')]
    expect(await tool('add-google-assets').undo!.current(run.change!)).toEqual(run.change!.after)
    const undo = tool('add-google-assets').undo!.request(run.change!) as { tool: string; args: Record<string, unknown> }
    expect(undo).toMatchObject({ tool: 'set-google-asset-links', args: { accountId: 'g-1', items: [
      { level: 'account', assetId: '301', fieldType: 'CALL', action: 'unlink' }, { level: 'campaign', campaignId: '21', assetId: '301', fieldType: 'CALL', action: 'unlink' },
      { level: 'account', assetId: '303', fieldType: 'CALLOUT', action: 'unlink' }, { level: 'campaign', campaignId: '21', assetId: '303', fieldType: 'CALLOUT', action: 'unlink' },
    ] } })
    expect((await undoDraft(undo)).sent).toEqual([
      { customerAssetOperation: { remove: `${C}/customerAssets/301~CALL` } },
      { campaignAssetOperation: { remove: `${C}/campaignAssets/21~301~CALL` } },
      { customerAssetOperation: { remove: `${C}/customerAssets/303~CALLOUT` } },
      { campaignAssetOperation: { remove: `${C}/campaignAssets/21~303~CALLOUT` } },
    ])
    // A person enabled the call at the account since: undo leaves that link alone.
    h.live.links[0].status = 'ENABLED'
    const now = await tool('add-google-assets').undo!.current(run.change!) as { linked: unknown[] }
    expect(now.linked).toHaveLength(3)
  })

  it('enable: true links the call ENABLED where it serves: SPENDS MONEY in the preview', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const out = await tool('add-google-assets').handler(parsed('add-google-assets', { calls: [{ countryCode: 'IT', phoneNumber: '000 111 2222' }], linkTo: [{ level: 'campaign', campaignId: '21' }], enable: true }), asker)
    expect(out.preview).toMatchObject({ spendsMoney: true, spendsMoneyBecause: [expect.stringContaining('Links the call asset "000 111 2222 (IT)" ENABLED to campaign "Search A"')] })
  })

  it('an image: its bytes go to Google, never into the record; an image that changed after the approval is not sent', async () => {
    const ask = parsed('add-google-assets', { images: [{ fieldType: 'AD_IMAGE', imageUrl: 'https://cdn.example/a.png' }], linkTo: [{ level: 'ad-group', adGroupId: '51' }] })
    const { sent, run } = await previewAndRun('add-google-assets', ask, [{ assetResult: { resourceName: `${C}/assets/401` } }, {}])
    expect(sent).toEqual([
      { assetOperation: { create: { resourceName: `${C}/assets/-1`, name: 'a abababab', type: 'IMAGE', imageAsset: { data: 'iVBORw0KGgo=' } } } },
      { adGroupAssetOperation: { create: { adGroup: `${C}/adGroups/51`, asset: `${C}/assets/-1`, fieldType: 'AD_IMAGE' } } },
    ])
    expect(h.prepare).toHaveBeenCalledWith({ fieldType: 'AD_IMAGE', imageUrl: 'https://cdn.example/a.png' })
    expect(JSON.stringify(run.change)).not.toContain('iVBORw0KGgo=')
    expect(run.change?.after).toMatchObject({ created: [{ assetId: '401', type: 'IMAGE', fieldType: 'AD_IMAGE', sha256: 'ab'.repeat(32), width: 1200, height: 1200 }] })

    // The file behind the link changed between the approval and the run: nothing is sent.
    h.mutate.mockReset()
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const preview = (await tool('add-google-assets').handler(ask, asker)).preview
    h.mutate.mockClear()
    h.prepare.mockImplementation(async () => ({ ...IMAGE, sha256: 'cd'.repeat(32), data: 'R0lGODlh' }))
    const late = await tool('add-google-assets').execute!(ask, approved(preview))
    expect(late.error).toMatch(/changed since this was approved/)
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('a library image needs the image library permission: refused before anything is read or sent', async () => {
    const ask = parsed('add-google-assets', { images: [{ fieldType: 'BUSINESS_LOGO', libraryImageId: 'da_1' }], linkTo: [{ level: 'account' }] })
    const noLibrary: ToolContext = { ...asker, can: (p: string) => p !== F.assetsManage }
    const out = await tool('add-google-assets').handler(ask, noLibrary)
    expect(out.error).toContain(F.assetsManage)
    expect(h.prepare).not.toHaveBeenCalled()
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('the images one request carries are capped: once they pass it the rest are not fetched, and nothing is sent', async () => {
    h.prepare.mockImplementation(async () => ({ ...IMAGE, bytes: 12 * 1024 * 1024 }))
    const ask = parsed('add-google-assets', { images: [1, 2, 3].map((i) => ({ fieldType: 'AD_IMAGE', imageUrl: `https://cdn.example/${i}.png` })), linkTo: [{ level: 'campaign', campaignId: '21' }] })
    const out = await tool('add-google-assets').handler(ask, asker)
    expect(out.error).toMatch(/image 3: not read: the images before it already pass what one request carries; the images are 24\.0 MB together: one request carries at most 20 MB of images/)
    expect(h.prepare).toHaveBeenCalledTimes(2)
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('linked nowhere, sent twice: an unknown outcome approved again makes nothing twice', async () => {
    const ask = parsed('add-google-assets', { callouts: ['Free returns'], businessNames: ['Shop A'] })
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const out = await tool('add-google-assets').handler(ask, asker)
    expect(out.ok).toBe(true)
    // With no place, the account's own assets of those types are read (a business name is a TEXT asset).
    expect(h.accountReads).toEqual([['TEXT', 'CALLOUT']])
    // The first run reached Google but its answer was lost; Google made both. Approved again: nothing is sent (the
    // builder finds both in the account; had only part of the content been there, the basis would refuse it).
    h.live.accountAssets = [CALLOUT, asset('7', 'TEXT', 'Shop A', { text: 'Shop A' })]
    h.mutate.mockClear()
    const again = await tool('add-google-assets').execute!(ask, approved(out.preview))
    expect(again.error).toMatch(/^Not run: Nothing to change: /)
    expect(h.mutate).not.toHaveBeenCalled()
    // Asked anew, both are already there.
    expect((await tool('add-google-assets').handler(ask, asker)).error).toMatch(/^Nothing to change: .*already in the account \(asset 7\).*already in the account \(asset 9\)/)
    // With a place, the links show what is there: no account-wide read.
    h.accountReads.length = 0
    await tool('add-google-assets').handler(parsed('add-google-assets', { callouts: ['Ships in 24h'], linkTo: [{ level: 'account' }] }), asker)
    expect(h.accountReads).toEqual([])
  })

  it('a lead form: refused until the account accepted Google\'s lead form terms (read live)', async () => {
    h.live.terms = false
    const form = { nameOnForm: 'Shop A', headline: 'Get a quote', description: 'Tell us your size', callToActionType: 'GET_QUOTE', callToActionDescription: 'Sizes in a day', privacyPolicyUrl: 'https://shop.example/privacy', finalUrl: 'https://shop.example', fields: [{ inputType: 'EMAIL' }] }
    const out = await tool('add-google-assets').handler(parsed('add-google-assets', { leadForms: [form], linkTo: [{ level: 'campaign', campaignId: '22' }] }), asker)
    expect(out.error).toMatch(/LEAD_FORM_MISSING_AGREEMENT/)
    expect(h.mutate).not.toHaveBeenCalled()
  })
})

describe('set-google-asset-links', () => {
  beforeEach(() => {
    h.live.links = [linkAt('account', {}, CALL, 'CALL'), linkAt('campaign', { campaignId: '21' }, CALLOUT, 'CALLOUT')]
  })

  it('pause, unlink and link at three levels in ONE request; undo puts every link back as it was (enabling the call again SPENDS MONEY)', async () => {
    const ask = parsed('set-google-asset-links', { items: [
      { level: 'account', assetId: '302', fieldType: 'call', action: 'pause' },
      { level: 'campaign', campaignId: '21', assetId: '9', fieldType: 'CALLOUT', action: 'unlink' },
      { level: 'ad-group', adGroupId: '51', assetId: '9', fieldType: 'CALLOUT', action: 'link' },
    ] })
    const { preview, sent, run } = await previewAndRun('set-google-asset-links', ask, [{}, {}, {}])
    expect(sent).toEqual([
      { customerAssetOperation: { update: { resourceName: `${C}/customerAssets/302~CALL`, status: 'PAUSED' }, updateMask: 'status' } },
      { campaignAssetOperation: { remove: `${C}/campaignAssets/21~9~CALLOUT` } },
      { adGroupAssetOperation: { create: { adGroup: `${C}/adGroups/51`, asset: `${C}/assets/9`, fieldType: 'CALLOUT' } } },
    ])
    expect(preview).toMatchObject({ spendsMoney: false, operations: 3 })
    const items = [
      { level: 'account', campaignId: null, adGroupId: null, assetId: '302', fieldType: 'CALL', text: '000 111 2222 (IT)', from: 'ENABLED', to: 'PAUSED' },
      { level: 'campaign', campaignId: '21', adGroupId: null, assetId: '9', fieldType: 'CALLOUT', text: 'Free returns', from: 'ENABLED', to: null },
      { level: 'ad-group', campaignId: '21', adGroupId: '51', assetId: '9', fieldType: 'CALLOUT', text: 'Free returns', from: null, to: 'ENABLED' },
    ]
    expect(run.change?.after).toEqual({ items, ...ACCOUNT })
    expect(run.change?.before).toMatchObject({ links: [{ assetId: '302', status: 'ENABLED' }, { assetId: '9', status: 'ENABLED' }, { assetId: '9', status: null }] })

    h.live.links = [linkAt('account', {}, CALL, 'CALL', 'PAUSED'), linkAt('ad-group', { campaignId: '21', adGroupId: '51' }, CALLOUT, 'CALLOUT')]
    expect(await tool('set-google-asset-links').undo!.current(run.change!)).toEqual(run.change!.after)
    const undo = tool('set-google-asset-links').undo!.request(run.change!) as { tool: string; args: Record<string, unknown> }
    expect(undo).toMatchObject({ tool: 'set-google-asset-links', args: { accountId: 'g-1', items: [
      { level: 'account', assetId: '302', fieldType: 'CALL', action: 'enable' },
      { level: 'campaign', campaignId: '21', assetId: '9', fieldType: 'CALLOUT', action: 'link', status: 'ENABLED' },
      { level: 'ad-group', adGroupId: '51', assetId: '9', fieldType: 'CALLOUT', action: 'unlink' },
    ] } })
    const back = await undoDraft(undo)
    expect(back.sent).toEqual([
      { customerAssetOperation: { update: { resourceName: `${C}/customerAssets/302~CALL`, status: 'ENABLED' }, updateMask: 'status' } },
      { campaignAssetOperation: { create: { campaign: `${C}/campaigns/21`, asset: `${C}/assets/9`, fieldType: 'CALLOUT' } } },
      { adGroupAssetOperation: { remove: `${C}/adGroupAssets/51~9~CALLOUT` } },
    ])
    expect(back.preview).toMatchObject({ spendsMoney: true, spendsMoneyBecause: [expect.stringContaining('Enables the call asset')] })
    // Changed again since (the callout taken off the ad group by hand): undo leaves it alone.
    h.live.links = [linkAt('account', {}, CALL, 'CALL', 'PAUSED')]
    expect((await tool('set-google-asset-links').undo!.current(run.change!) as { items: unknown[] }).items).toHaveLength(2)
  })

  it('unlinking the last call of a serving campaign: the account\'s call is read and named as what shows there instead', async () => {
    const own = { ...CALL, assetId: '303', label: '000 333 4444 (IT)' }
    h.live.links = [linkAt('account', {}, CALL, 'CALL'), linkAt('campaign', { campaignId: '21' }, own, 'CALL')]
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const out = await tool('set-google-asset-links').handler(parsed('set-google-asset-links', { items: [{ level: 'campaign', campaignId: '21', assetId: '303', fieldType: 'CALL', action: 'unlink' }] }), asker)
    expect(out.preview).toMatchObject({ spendsMoney: false, warnings: expect.arrayContaining([expect.stringContaining('campaign "Search A" keeps no enabled call asset of its own: the account\'s call asset "000 111 2222 (IT)" can show in its ads instead')]) })
  })

  it('never by a rule: a run the business\'s rule decided is refused before anything is sent', async () => {
    const ask = parsed('set-google-asset-links', { items: [{ level: 'account', assetId: '302', fieldType: 'CALL', action: 'pause' }] })
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const preview = (await tool('set-google-asset-links').handler(ask, asker)).preview
    h.mutate.mockClear()
    const byRule = await tool('set-google-asset-links').execute!(ask, { ...approved(preview), approvedByPerson: false, decidedVia: 'auto' })
    expect(byRule.error).toMatch(/never by a rule/)
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('a field type Google does not link at that level is refused by the builder before anything is sent', async () => {
    const out = await tool('set-google-asset-links').handler(parsed('set-google-asset-links', { items: [{ level: 'ad-group', adGroupId: '51', assetId: '9', fieldType: 'BUSINESS_NAME', action: 'link' }] }), asker)
    expect(out.error).toContain('Google links a business name (BUSINESS_NAME) to the account or a campaign, not to ad group "Jackets" (campaign "Search A")')
    expect(h.mutate).not.toHaveBeenCalled()
  })
})
