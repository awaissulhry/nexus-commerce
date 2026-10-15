/**
 * Google Ads changes, G5 (2026-10-15) — the portfolio bid strategy tools as the approval gate uses them (Google, the
 * account and the live reads are stand-ins): the preview is built on Google's check and says what spends money; the run
 * is ONE request of an approved change, as a person; undo puts the old targets and limits back; a strategy campaigns use
 * is never removed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  enqueue: vi.fn(async () => ({ queued: true, reason: null })),
  live: { strategies: [] as unknown[], campaigns: [] as unknown[] },
}))
vi.mock('../../marketing/google-ads/change-account.js', () => ({
  googleChangeAccount: vi.fn(async () => ({
    target: { connectionId: 'g-1', customerId: '1234567890', loginCustomerId: null }, accountId: 'g-1', customerId: '1234567890', name: 'Shop', currency: 'EUR', timeZone: 'Europe/Rome',
  })),
}))
vi.mock('../../marketing/google-ads/live-strategies.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live-strategies.js')>()),
  liveStrategies: vi.fn(async () => structuredClone(h.live.strategies)),
  liveStrategyCampaigns: vi.fn(async (_t: unknown, _c: string, ids: string[]) => structuredClone(h.live.campaigns).filter((c: any) => ids.includes(c.strategyId))),
}))
vi.mock('../../marketing/google-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/write-client.js')>()),
  mutateGoogleAds: h.mutate,
}))
vi.mock('../../marketing/google-ads/enqueue.js', () => ({ enqueueGoogleAdsSync: h.enqueue }))

import { GOOGLE_ADS_STRATEGY_TOOLS } from './google-ads-strategies.tools.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import type { ToolContext } from '../tool-types.js'

const tool = (name: string) => GOOGLE_ADS_STRATEGY_TOOLS.find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })
const S1 = { strategyId: '81', name: 'Strategy A', type: 'TARGET_CPA', scheme: 'TARGET_CPA', campaignCount: 1, currency: 'EUR', targetCpaCents: 900, targetRoas: null, maxCpcCents: 80, minCpcCents: null, location: null, impressionSharePercent: null }

beforeEach(() => {
  h.mutate.mockReset()
  h.enqueue.mockClear()
  vi.unstubAllEnvs()
  h.live.strategies = [S1]
  h.live.campaigns = [{ strategyId: '81', campaignId: '21', name: 'Search A', status: 'ENABLED' }]
})

describe('set-google-bid-strategy', () => {
  const ask = { change: [{ strategyId: '81', targetCpaCents: 1200, maxCpcCents: null }] }

  it('is a Nexus change a person approves; money keys and permission declared; its re-check fields declared', () => {
    for (const t of GOOGLE_ADS_STRATEGY_TOOLS) {
      expect(t).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', openWorld: true, readOnly: false, riskTier: 'high' })
      expect(t.requires).toContain('financials.adspend.view')
      expect(MATERIAL_PREVIEW_FIELDS[t.name]).toEqual(['basis', 'plan', 'reach'])
    }
    expect(tool('remove-google-bid-strategy').reversibility).toBe('none')
  })

  it('preview on Google\'s check with SPENDS MONEY; ONE request when approved; undo puts the old target and limit back', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const out = await tool('set-google-bid-strategy').handler(ask, asker)
    expect(h.mutate.mock.calls[0][2]).toEqual({ validateOnly: true })
    expect(out.preview).toMatchObject({ spendsMoney: true, operations: 1, googleCheck: { checked: true, accepted: true } })
    h.mutate.mockResolvedValue({ responses: [{ biddingStrategyResult: { resourceName: 'customers/1234567890/biddingStrategies/81' } }], ops: 1, requestId: 'r' })
    const run = await tool('set-google-bid-strategy').execute!(ask, approved(out.preview))
    expect(run.ok).toBe(true)
    expect(h.mutate.mock.calls.at(-1)![2]).toMatchObject({ validateOnly: false })
    expect(run.change!.after).toEqual({ strategies: [{ strategyId: '81', targetCpaCents: 1200, maxCpcCents: null }], accountId: 'g-1', customerId: '1234567890' })
    h.live.strategies = [{ ...S1, targetCpaCents: 1200, maxCpcCents: null }]
    expect(await tool('set-google-bid-strategy').undo!.current(run.change!)).toEqual(run.change!.after)
    const undo = tool('set-google-bid-strategy').undo!.request(run.change!)
    expect(undo).toEqual({ tool: 'set-google-bid-strategy', args: { accountId: 'g-1', change: [{ strategyId: '81', targetCpaCents: 900, maxCpcCents: 80 }], why: 'undo of an earlier bid strategy change' } })
    expect(tool('set-google-bid-strategy').input.safeParse((undo as { args: unknown }).args).success).toBe(true)
  })

  it('a strategy it only made: undo says there is nothing to put back', () => {
    const change = { before: { strategies: [] }, after: { strategies: [], created: { strategyId: '88', name: 'Top', scheme: 'MAXIMIZE_CLICKS' }, accountId: 'g-1' } }
    expect(tool('set-google-bid-strategy').undo!.request(change)).toEqual({ refusal: expect.stringMatching(/only made a portfolio bid strategy/) })
  })
})

describe('remove-google-bid-strategy', () => {
  it('refuses a strategy campaigns use, naming them, before anything is sent', async () => {
    const out = await tool('remove-google-bid-strategy').handler({ strategyIds: ['81'], confirmRemove: true }, asker)
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/used by 1 campaign \("Search A"\)/)
    expect(h.mutate).not.toHaveBeenCalled()
  })
})
