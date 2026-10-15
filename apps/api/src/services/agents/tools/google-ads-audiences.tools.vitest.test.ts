/**
 * Google Ads changes, programme 2 G2 (2026-10-15) — the audience and demographics tools, and set-google-targeting's
 * devices and radius, as the approval gate uses them (Google, the account and the live reads are stand-ins): Google
 * checks each change first; an approved run records what it did on the account it ran on; undo asks for exactly the
 * opposite, parses as its tool's own arguments, and refuses once the account moved.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  live: { settings: null as unknown, criteria: [] as unknown[], adGroups: [] as unknown[], adGroupCriteria: [] as unknown[], adGroupDevices: [] as unknown[] },
}))
vi.mock('../../marketing/google-ads/change-account.js', () => ({
  googleChangeAccount: vi.fn(async () => ({
    target: { connectionId: 'g-1', customerId: '1234567890', loginCustomerId: null }, accountId: 'g-1', customerId: '1234567890', name: 'Shop', currency: 'EUR', timeZone: 'Europe/Rome',
  })),
}))
vi.mock('../../marketing/google-ads/live.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live.js')>()),
  liveCampaignSettings: vi.fn(async () => structuredClone(h.live.settings)),
}))
vi.mock('../../marketing/google-ads/live-targeting.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live-targeting.js')>()),
  liveTargetingCriteria: vi.fn(async () => structuredClone(h.live.criteria)),
  liveTargetingAdGroups: vi.fn(async () => structuredClone(h.live.adGroups)),
  liveAdGroupDevices: vi.fn(async () => structuredClone(h.live.adGroupDevices)),
  liveAdGroupTargetingState: vi.fn(async () => ({ adGroups: structuredClone(h.live.adGroups), adGroupCriteria: structuredClone(h.live.adGroupCriteria) })),
}))
vi.mock('../../marketing/google-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/write-client.js')>()),
  mutateGoogleAds: h.mutate,
}))
vi.mock('../../marketing/google-ads/enqueue.js', () => ({ enqueueGoogleAdsSync: vi.fn(async () => ({ queued: true, reason: null })) }))

import { GOOGLE_ADS_AUDIENCES_TOOLS } from './google-ads-audiences.tools.js'
import { GOOGLE_ADS_CAMPAIGN_TOOLS } from './google-ads-campaigns.tools.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import type { ToolContext } from '../tool-types.js'

const tool = (name: string) => [...GOOGLE_ADS_AUDIENCES_TOOLS, ...GOOGLE_ADS_CAMPAIGN_TOOLS].find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })
const SETTINGS = {
  campaignId: '21', name: 'Search A', status: 'PAUSED', servingStatus: null, primaryStatus: null, type: 'SEARCH', subType: null, bidding: 'MANUAL_CPC', start: null, end: null, shopping: null, budget: null,
  networks: { googleSearch: true, searchPartners: false, display: false, partnerSearch: false }, locationOption: { include: 'PRESENCE', exclude: 'PRESENCE' },
  audienceMode: [] as unknown[], euPoliticalAds: null, aiMax: false, keywordMatchType: null, assetAutomation: [], manualCpcEnhanced: false, maxCpcCeilingCents: null,
  targetCpaCents: null, targetRoas: null, biddingStrategyId: null, localInventory: false, trackingTemplate: null, finalUrlSuffix: null, primaryStatusReasons: [],
}
const AG = { adGroupId: '51', name: 'Jackets', status: 'ENABLED', audienceMode: [] }
const ok = (responses: unknown[] = []) => ({ responses, ops: 1, requestId: null })

beforeEach(() => {
  h.mutate.mockReset()
  h.live.settings = structuredClone(SETTINGS)
  h.live.criteria = []
  h.live.adGroups = [AG]
  h.live.adGroupCriteria = []
  h.live.adGroupDevices = []
})

/** Preview (Google's check), then the approved run; returns the run. */
async function previewAndRun(name: string, ask: Record<string, unknown>, responses: unknown[] = []) {
  h.mutate.mockResolvedValue(ok())
  const out = await tool(name).handler(ask, asker)
  if (!out.ok) throw new Error(out.error)
  expect(h.mutate.mock.calls[0][2]).toEqual({ validateOnly: true })
  h.mutate.mockReset()
  h.mutate.mockResolvedValue(ok(responses))
  const run = await tool(name).execute!(ask, approved(out.preview))
  if (!run.ok) throw new Error(run.error)
  expect(h.mutate.mock.calls[0][2]).toMatchObject({ validateOnly: false })
  return { out, run }
}

describe('the audience and demographics tools', () => {
  it('are Nexus changes a person approves: alwaysAsk, ask at most, reach Google, re-check fields declared, an undo each', () => {
    for (const t of GOOGLE_ADS_AUDIENCES_TOOLS) {
      expect(t).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', openWorld: true, readOnly: false, reversibility: 'full' })
      expect(MATERIAL_PREVIEW_FIELDS[t.name]).toEqual(['basis', 'plan', 'reach'])
      expect(t.undo).toBeDefined()
    }
  })

  it('set-google-audiences: Google checks it; the run records the account; undo takes the segment off again, and refuses once it moved', async () => {
    const ask = { campaignId: '21', add: [{ kind: 'user_list', id: '301', adGroupId: '51', bidModifier: 1.2 }] }
    const { out, run } = await previewAndRun('set-google-audiences', tool('set-google-audiences').input.parse(ask) as Record<string, unknown>)
    expect(out.preview).toMatchObject({ spendsMoney: true, googleCheck: { checked: true } })
    const change = run.change!
    expect(change.after).toMatchObject({ campaignId: '21', accountId: 'g-1', customerId: '1234567890', undo: { remove: [{ kind: 'USER_LIST', id: '301', adGroupId: '51' }], modes: [{ adGroupId: '51', mode: 'NONE' }] } })
    const undo = tool('set-google-audiences').undo!.request(change)
    expect(undo).toMatchObject({ tool: 'set-google-audiences', args: { accountId: 'g-1', campaignId: '21', remove: [{ kind: 'USER_LIST', id: '301', adGroupId: '51' }] } })
    expect(tool('set-google-audiences').input.safeParse((undo as { args: unknown }).args).success).toBe(true)
    // Now: the segment is there with its adjustment, the ad group observes → what the change wrote stands.
    h.live.adGroups = [{ ...AG, audienceMode: [{ dimension: 'AUDIENCE', observationOnly: true }] }]
    h.live.adGroupCriteria = [{ adGroupId: '51', criterionId: '9', type: 'USER_LIST', negative: false, name: null, bidModifier: 1.2, segment: { kind: 'USER_LIST', id: '301' } }]
    expect(await tool('set-google-audiences').undo!.current(change)).toEqual(change.after)
    h.live.adGroupCriteria = []
    expect(await tool('set-google-audiences').undo!.current(change)).toMatchObject({ moved: true })
  })

  it('set-google-demographics: refused without a Google check when every group would go; undo restores the exact criteria', async () => {
    h.live.adGroupCriteria = [{ adGroupId: '51', criterionId: 'g1', type: 'GENDER', negative: true, name: null, bidModifier: null, demographic: { dimension: 'GENDER', value: 'FEMALE' } }]
    h.mutate.mockResolvedValue(ok())
    const refused = await tool('set-google-demographics').handler({ campaignId: '21', changes: [{ dimension: 'GENDER', value: 'MALE', adGroupId: '51', exclude: true }] }, asker)
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining('unknown') })
    expect(h.mutate).not.toHaveBeenCalled()
    const ask = tool('set-google-demographics').input.parse({ campaignId: '21', changes: [{ dimension: 'gender', value: 'female', adGroupId: '51' }] }) as Record<string, unknown>
    const { run } = await previewAndRun('set-google-demographics', ask)
    const undo = tool('set-google-demographics').undo!.request(run.change!)
    expect(undo).toEqual({ tool: 'set-google-demographics', args: { accountId: 'g-1', campaignId: '21', restore: [{ dimension: 'GENDER', value: 'FEMALE', adGroupId: '51', criterion: 'EXCLUDED' }], why: 'undo of an earlier demographics change' } })
    expect(tool('set-google-demographics').input.safeParse((undo as { args: unknown }).args).success).toBe(true)
    h.live.adGroupCriteria = []
    expect(await tool('set-google-demographics').undo!.current(run.change!)).toEqual(run.change!.after)
  })

  it('set-google-targeting: a radius\'s new id is recorded after the run; devices undo to what was; undo parses and holds', async () => {
    h.live.criteria = [{ criterionId: '30001', type: 'DEVICE', negative: false, name: null, bidModifier: 1.1, device: 'MOBILE' }, { criterionId: '7', type: 'LOCATION', negative: false, name: null, bidModifier: null, location: 'geoTargetConstants/2380' }]
    const ask = tool('set-google-targeting').input.parse({ campaignId: '21', devices: [{ device: 'mobile', bidModifier: 1.4 }], addRadius: [{ latitude: 10.5, longitude: 20.25, radius: 10 }] }) as Record<string, unknown>
    const { run } = await previewAndRun('set-google-targeting', ask, [{ campaignCriterionResult: { resourceName: 'customers/1234567890/campaignCriteria/21~901' } }, { campaignCriterionResult: { resourceName: 'customers/1234567890/campaignCriteria/21~30001' } }])
    expect(run.data).toMatchObject({ radiusIds: ['901'] })
    expect(run.change!.after).toMatchObject({ undo: { removeRadius: ['901'], devices: [{ device: 'MOBILE', bidModifier: 1.1 }] }, set: { devices: [{ device: 'MOBILE', bidModifier: 1.4 }] } })
    const undo = tool('set-google-targeting').undo!.request(run.change!)
    expect(tool('set-google-targeting').input.safeParse((undo as { args: unknown }).args).success).toBe(true)
    h.live.criteria = [
      { criterionId: '30001', type: 'DEVICE', negative: false, name: null, bidModifier: 1.4, device: 'MOBILE' },
      { criterionId: '7', type: 'LOCATION', negative: false, name: null, bidModifier: null, location: 'geoTargetConstants/2380' },
      { criterionId: '901', type: 'PROXIMITY', negative: false, name: null, bidModifier: null, proximity: { latitudeMicro: 10500000, longitudeMicro: 20250000, radius: 10, units: 'KILOMETERS', address: null } },
    ]
    expect(await tool('set-google-targeting').undo!.current(run.change!)).toEqual(run.change!.after)
  })
})
