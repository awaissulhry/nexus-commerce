/**
 * Google Ads changes, G5 (2026-10-15) — the recommendation tools as the approval gate uses them (Google, the account and
 * the live reads are stand-ins). Apply and dismiss: Google cannot check them first, so the preview says so and sends
 * nothing to Google; the run reads each recommendation again and sends it only when it is still there, unchanged, as ONE
 * request. Undo of an apply: the old daily amount of a budget recommendation; any other type is refused with the reason.
 * Auto-apply: Google's check (validate_only); ON for a type that spends is SPENDS MONEY.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  send: vi.fn(),
  enqueue: vi.fn(async () => ({ queued: true, reason: null })),
  live: { recommendations: [] as unknown[], campaigns: [] as unknown[], budgets: [] as unknown[], subscriptions: [] as unknown[] },
}))
vi.mock('../../marketing/google-ads/change-account.js', () => ({
  googleChangeAccount: vi.fn(async () => ({
    target: { connectionId: 'g-1', customerId: '1234567890', loginCustomerId: null }, accountId: 'g-1', customerId: '1234567890', name: 'Shop', currency: 'EUR', timeZone: 'Europe/Rome',
  })),
}))
vi.mock('../../marketing/google-ads/live-recommendations.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live-recommendations.js')>()),
  liveRecommendations: vi.fn(async (_t: unknown, _c: string, ids: string[]) => ({ recommendations: structuredClone(h.live.recommendations).filter((r: any) => ids.includes(r.recommendationId)), detailsRead: true })),
  liveAutoApply: vi.fn(async () => structuredClone(h.live.subscriptions)),
}))
vi.mock('../../marketing/google-ads/live.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live.js')>()),
  liveCampaigns: vi.fn(async () => structuredClone(h.live.campaigns)),
  liveBudgets: vi.fn(async () => structuredClone(h.live.budgets)),
}))
vi.mock('../../marketing/google-ads/recommendation-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/recommendation-client.js')>()),
  sendRecommendations: h.send,
}))
vi.mock('../../marketing/google-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/write-client.js')>()),
  mutateGoogleAds: h.mutate,
}))
vi.mock('../../marketing/google-ads/enqueue.js', () => ({ enqueueGoogleAdsSync: h.enqueue }))

import { GOOGLE_ADS_RECOMMENDATIONS_TOOLS } from './google-ads-recommendations.tools.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import type { ToolContext } from '../tool-types.js'

const tool = (name: string) => GOOGLE_ADS_RECOMMENDATIONS_TOOLS.find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const recheck: ToolContext = { can: () => true, via: 'system', approvalId: 'ap-1' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })

const C1 = { campaignId: '21', name: 'Search A', status: 'ENABLED', servingStatus: null, primaryStatus: null, type: 'SEARCH', subType: null, bidding: 'MANUAL_CPC', start: null, end: null, shopping: null, budget: { budgetId: '11', name: 'Budget A', amountCents: 1000, shared: false } }
const B1 = { budgetId: '11', name: 'Budget A', amountCents: 1000, shared: false, deliveryMethod: 'STANDARD', period: 'DAILY', usedBy: 1, campaigns: [{ campaignId: '21', name: 'Search A', status: 'ENABLED' }] }
const REC = {
  recommendationId: 'r-1', resourceName: 'customers/1234567890/recommendations/r-1', type: 'CAMPAIGN_BUDGET', dismissed: false, campaignId: '21', adGroupId: null,
  budgetId: '11', impact: null, budget: { currentCents: 1000, recommendedCents: 1800 }, excessBudgetId: null, keyword: null, targetCpaCents: null, targetRoas: null,
  adjustment: null, requiredBudgetCents: null, broadMatchKeywords: null,
}

beforeEach(() => {
  h.mutate.mockReset()
  h.send.mockReset()
  h.enqueue.mockClear()
  vi.unstubAllEnvs()
  h.live.recommendations = [REC]
  h.live.campaigns = [C1]
  h.live.budgets = [B1]
  h.live.subscriptions = []
})

describe('apply-google-recommendations', () => {
  const ask = { recommendations: [{ recommendationId: 'r-1' }] }

  it('is a Nexus change a person approves; partly reversible; its re-check fields declared', () => {
    for (const t of GOOGLE_ADS_RECOMMENDATIONS_TOOLS) {
      expect(t).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', openWorld: true, readOnly: false, riskTier: 'high' })
      expect(MATERIAL_PREVIEW_FIELDS[t.name]).toEqual(['basis', 'plan', 'reach'])
    }
    expect(tool('apply-google-recommendations').reversibility).toBe('partial')
    expect(tool('dismiss-google-recommendations').reversibility).toBe('none')
  })

  it('the preview says plainly Google cannot check it first, sends nothing to Google, and says what spends money', async () => {
    const out = await tool('apply-google-recommendations').handler(ask, asker)
    expect(out.ok).toBe(true)
    expect(h.mutate).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
    expect(out.preview).toMatchObject({
      googleCheck: { checked: false, sentence: expect.stringMatching(/^Google cannot check an apply first/) },
      spendsMoney: true,
      spendsMoneyBecause: ['Raises the daily budget "Budget A" from EUR 10.00 to EUR 18.00 (1 enabled campaign on it).'],
      operations: 1,
    })
    // The gate's re-check reads again and reaches the same facts.
    const again = await tool('apply-google-recommendations').handler(ask, recheck)
    const pick = (p: unknown) => { const { basis, plan, reach } = p as Record<string, unknown>; return { basis, plan, reach } }
    expect(pick(again.preview)).toEqual(pick(out.preview))
  })

  it('runs as ONE apply after reading the recommendation again; undo sets the old daily amount through set-google-budget', async () => {
    const preview = (await tool('apply-google-recommendations').handler(ask, asker)).preview
    expect((await tool('apply-google-recommendations').execute!(ask, asker)).error).toMatch(/runs only as an approved request/)
    h.send.mockResolvedValue({ responses: [{ recommendationResult: { resourceName: REC.resourceName } }], ops: 1 })
    const run = await tool('apply-google-recommendations').execute!(ask, approved(preview))
    expect(run.ok).toBe(true)
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.send.mock.calls[0].slice(1)).toEqual(['apply', [{ resourceName: REC.resourceName }]])
    expect(h.mutate).not.toHaveBeenCalled()
    expect(run.change).toEqual({
      before: { applied: [{ recommendationId: 'r-1', type: 'CAMPAIGN_BUDGET', campaignId: '21', budgetId: '11', budgetCents: 1000 }], accountId: 'g-1', customerId: '1234567890' },
      after: { applied: [{ recommendationId: 'r-1', type: 'CAMPAIGN_BUDGET', campaignId: '21', budgetId: '11', budgetCents: 1800 }], accountId: 'g-1', customerId: '1234567890' },
    })
    h.live.budgets = [{ ...B1, amountCents: 1800 }]
    expect(await tool('apply-google-recommendations').undo!.current(run.change!)).toEqual(run.change!.after)
    expect(tool('apply-google-recommendations').undo!.request(run.change!)).toEqual({
      tool: 'set-google-budget',
      args: { accountId: 'g-1', amounts: [{ budgetId: '11', budgetCents: 1000 }], why: 'undo of an applied Google budget recommendation (the old daily amount)' },
    })
  })

  it('not sent when Google withdrew or changed the recommendation since it was approved', async () => {
    const preview = (await tool('apply-google-recommendations').handler(ask, asker)).preview
    h.live.recommendations = [{ ...REC, budget: { currentCents: 1000, recommendedCents: 2500 } }]
    const moved = await tool('apply-google-recommendations').execute!(ask, approved(preview))
    expect(moved.error).toMatch(/changed since this was approved/)
    h.live.recommendations = []
    const gone = await tool('apply-google-recommendations').execute!(ask, approved(preview))
    expect(gone.error).toMatch(/applied, replaced or withdrew it/)
    expect(h.send).not.toHaveBeenCalled()
  })

  it('the undo of another type is refused with the reason (Google cannot un-apply)', () => {
    const change = { before: { applied: [{ recommendationId: 'r-2', type: 'KEYWORD', campaignId: '21' }], accountId: 'g-1' }, after: { applied: [{ recommendationId: 'r-2', type: 'KEYWORD', campaignId: '21' }], accountId: 'g-1' } }
    expect(tool('apply-google-recommendations').undo!.request(change)).toEqual({ refusal: expect.stringMatching(/Google cannot un-apply a recommendation, and a keyword one/) })
  })
})

describe('dismiss-google-recommendations', () => {
  it('no check first; runs as one dismiss; nothing spends', async () => {
    const ask = { recommendationIds: ['r-1'] }
    const out = await tool('dismiss-google-recommendations').handler(ask, asker)
    expect(out.preview).toMatchObject({ spendsMoney: false, googleCheck: { checked: false, sentence: expect.stringMatching(/^Google cannot check a dismiss first/) } })
    h.send.mockResolvedValue({ responses: [{ recommendationResult: { resourceName: REC.resourceName } }], ops: 1 })
    const run = await tool('dismiss-google-recommendations').execute!(ask, approved(out.preview))
    expect(run.ok).toBe(true)
    expect(h.send.mock.calls[0].slice(1)).toEqual(['dismiss', [{ resourceName: REC.resourceName }]])
  })
})

describe('set-google-auto-apply', () => {
  it('Google checks it; ON for a type that spends is SPENDS MONEY; undo of a setting never made is PAUSED', async () => {
    const ask = { types: [{ type: 'KEYWORD', status: 'ENABLED' }] }
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const out = await tool('set-google-auto-apply').handler(ask, asker)
    expect(h.mutate.mock.calls[0][2]).toEqual({ validateOnly: true })
    expect(out.preview).toMatchObject({ spendsMoney: true, googleCheck: { checked: true, accepted: true } })
    h.mutate.mockResolvedValue({ responses: [{}], ops: 1, requestId: null })
    const run = await tool('set-google-auto-apply').execute!(ask, approved(out.preview))
    expect(run.ok).toBe(true)
    h.live.subscriptions = [{ type: 'KEYWORD', status: 'ENABLED' }]
    expect(await tool('set-google-auto-apply').undo!.current(run.change!)).toEqual(run.change!.after)
    const undo = tool('set-google-auto-apply').undo!.request(run.change!)
    expect(undo).toMatchObject({ tool: 'set-google-auto-apply', args: { types: [{ type: 'KEYWORD', status: 'PAUSED' }] } })
    expect(tool('set-google-auto-apply').input.safeParse((undo as { args: unknown }).args).success).toBe(true)
  })
})
