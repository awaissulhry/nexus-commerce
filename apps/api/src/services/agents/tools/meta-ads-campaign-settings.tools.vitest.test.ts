/**
 * Meta step 18 — set-meta-campaign, set-meta-ad-set and set-meta-budget-schedule as the approval gate uses them (Meta, the
 * account and the live reads are stand-ins): the change contract of every Meta change tool; a preview built from the live
 * state that says SPENDS MONEY and why Meta did not check it; a run only as a request a person approved, the request sent
 * as the kit builds it (its own gateway operation, read-back and judge), a read-back that does not show what was asked
 * never recorded as done; a restart's switch-on never sent after its end time failed; undo reads the fields live, puts
 * back what was replaced through the same tool, and refuses where Meta has no way back. Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  account: { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' } as Record<string, unknown> | { refusal: string },
  campaign: {} as Record<string, unknown>,
  adSet: {} as Record<string, unknown>,
  children: [] as Array<Record<string, unknown>>,
  ads: [] as string[],
  periods: [] as Array<Record<string, unknown>>,
  fieldValues: {} as Record<string, unknown>,
  capabilities: ['CAN_USE_BUDGET_SCHEDULING_API'] as string[] | null,
  refuseRead: null as string | null,
  check: vi.fn(async () => undefined),
  send: vi.fn(),
}))
vi.mock('../../marketing/meta-ads/change-account.js', () => ({ metaChangeAccount: vi.fn(async () => h.account) }))
vi.mock('../../marketing/meta-ads/live-settings.js', async (importActual) => {
  const actual = await importActual<typeof import('../../marketing/meta-ads/live-settings.js')>()
  const { MetaLiveRefusal } = await import('../../marketing/meta-ads/live.js')
  const refuse = () => { if (h.refuseRead) throw new MetaLiveRefusal(h.refuseRead) }
  return {
    ...actual,
    liveCampaign: vi.fn(async () => { refuse(); return structuredClone(h.campaign) }),
    liveCampaignAdSets: vi.fn(async () => ({ adSets: structuredClone(h.children), more: false })),
    liveAdSet: vi.fn(async () => { refuse(); return { adSet: structuredClone(h.adSet), campaign: structuredClone(h.campaign) } }),
    liveAdSetAds: vi.fn(async () => ({ ads: h.ads.map((id) => ({ id, status: 'ACTIVE' })), more: false })),
    liveBudgetSchedules: vi.fn(async () => structuredClone(h.periods)),
    liveAccountPixels: vi.fn(async () => new Set(['120000000000050'])),
    liveAccountCatalogs: vi.fn(async () => null),
    liveProductSetCatalog: vi.fn(async () => null),
    liveAccountCapabilities: vi.fn(async () => h.capabilities),
    liveFieldValues: vi.fn(async (_target: unknown, _id: string, fields: string[]) => Object.fromEntries(fields.map((f) => [f, h.fieldValues[f] ?? null]))),
  }
})
vi.mock('../../marketing/meta-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/write-client.js')>()),
  metaCheckChange: h.check,
  metaSendChange: h.send,
}))

import { META_ADS_CAMPAIGN_SETTINGS_TOOLS } from './meta-ads-campaign-settings.tools.js'
import { META_CHANGE_RULES } from './meta-ads-kit.js'
import { MetaWriteError } from '../../marketing/meta-ads/write-client.js'
import { localFailure } from '../../marketing/meta-ads/errors.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { __metaObjectLimitsTest } from '../../gateway/meta-object-limits.js'
import type { AgentTool, ToolContext, ToolResult } from '../tool-types.js'

const tool = (name: string) => META_ADS_CAMPAIGN_SETTINGS_TOOLS.find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const recheck: ToolContext = { can: () => true, via: 'system', approvalId: 'ap-1' }
const approved = (preview: unknown, extra: Partial<ToolContext> = {}): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview, ...extra })
const ask = (t: AgentTool, args: Record<string, unknown>) => t.input.parse(args) as Record<string, unknown>
const preview = async (name: string, args: Record<string, unknown>, ctx = asker) => (await tool(name).handler(ask(tool(name), args), ctx)) as ToolResult & { preview: Record<string, any> }
const run = async (name: string, args: Record<string, unknown>, p: unknown, extra: Partial<ToolContext> = {}) => (await tool(name).execute!(ask(tool(name), args), approved(p, extra))) as ToolResult & { data: Record<string, any> }

const C = '120000000000001'
const S = '120000000000002'
const P = '120000000000031'
const CAMPAIGN = {
  id: C, name: 'Campaign A', status: 'ACTIVE', effectiveStatus: 'ACTIVE', objective: 'OUTCOME_SALES', buyingType: 'AUCTION', smartPromotionType: null,
  dailyBudget: '5000', lifetimeBudget: null, spendCap: null, canUseSpendCap: true, bidStrategy: 'LOWEST_COST_WITHOUT_CAP', pacingType: ['standard'],
  promotedObject: null, specialAdCategories: [], specialAdCategory: 'NONE', specialAdCategoryCountry: null, budgetSharing: false, budgetScheduling: true,
  reelsTrendingAds: false, advantageState: 'DISABLED',
}
const AD_SET = {
  id: S, campaignId: C, name: 'Ad set B', status: 'PAUSED', effectiveStatus: 'PAUSED', optimizationGoal: 'OFFSITE_CONVERSIONS', optimizationSubEvent: null, billingEvent: 'IMPRESSIONS',
  bidStrategy: 'LOWEST_COST_WITHOUT_CAP', bidAmount: null, bidConstraints: null, dailyBudget: '2000', lifetimeBudget: null, budgetRemaining: null, dailyMinSpendTarget: null,
  lifetimeMinSpendTarget: null, dailySpendCap: null, lifetimeSpendCap: null, minBudgetSpendPercentage: null, maxBudgetSpendPercentage: null, startTime: '2026-09-01T00:00:00+0000',
  endTime: '2026-10-10T00:00:00+0000', pacingType: ['standard'], adsetSchedule: null, frequencyControlSpecs: null, attributionSpec: null, incrementalAttribution: null,
  promotedObject: null, dsaPayor: null, dsaBeneficiary: null, regionalRegulatedCategories: null, regionalRegulationIdentities: null, adSetGoal: null, creativeSequence: null,
  rotationBlocks: null, rotationIntervals: null, brandSafety: null, contextualBundling: null, fullFunnelExploration: null, automaticManualState: null, budgetScheduling: null,
  targetingCountries: ['IT'], unread: [],
}
const PERIOD = { id: P, budgetValue: 20, budgetValueType: 'ABSOLUTE', recurrenceType: 'ONE_TIME', timeStart: '2099-01-01T08:00:00+0000', timeEnd: '2099-01-01T20:00:00+0000' }

beforeEach(() => {
  __metaObjectLimitsTest.useMemory()
  vi.unstubAllEnvs()
  h.check.mockReset(); h.check.mockImplementation(async () => undefined)
  h.send.mockReset()
  h.account = { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' }
  h.campaign = structuredClone(CAMPAIGN)
  h.adSet = structuredClone(AD_SET)
  h.children = [{ id: S, name: 'Ad set B', status: 'PAUSED', dailyBudget: null, lifetimeBudget: null, bidAmount: null, endTime: null }]
  h.ads = []
  h.periods = [structuredClone(PERIOD)]
  h.fieldValues = {}
  h.capabilities = ['CAN_USE_BUDGET_SCHEDULING_API']
  h.refuseRead = null
})

describe('the tools', () => {
  it('each is a change a person always approves, with an undo, the #691 truth, money keys and its MATERIAL fields', () => {
    for (const name of ['set-meta-campaign', 'set-meta-ad-set', 'set-meta-budget-schedule']) {
      const t = tool(name)
      expect(t, name).toMatchObject({ readOnly: false, alwaysAsk: true, maxClaudeTrust: 'ask', riskTier: 'high', requiresApprovalDefault: true, openWorld: true, reversibility: 'partial', category: 'advertising' })
      expect(t.requires).toEqual(['ads.campaigns.manage', 'financials.adspend.view'])
      expect(t.undo, name).toBeDefined()
      expect(t.description.endsWith(META_CHANGE_RULES), name).toBe(true)
      expect(t.description, name).toMatch(/SPENDS MONEY/)
      expect(t.restrictedFields, name).toMatchObject({ changes: 'financials.adspend.view', spendsMoneyBecause: 'financials.adspend.view', steps: 'financials.adspend.view' })
      expect(MATERIAL_PREVIEW_FIELDS[name], name).toEqual(['basis', 'plan', 'reach'])
    }
    expect(tool('set-meta-budget-schedule').consequencesFor!({ action: 'create' })).toEqual({ reversibility: 'none' })
    expect(tool('set-meta-campaign').consequencesFor!({ campaignId: C, budgetSharing: false })).toEqual({ reversibility: 'none' })
    expect(tool('set-meta-campaign').consequencesFor!({ campaignId: C, name: 'x' })).toBeNull()
    expect(() => tool('set-meta-campaign').input.parse({ campaignId: C, budgetSharing: true })).toThrow()
    expect(() => tool('set-meta-campaign').input.parse({ campaignId: C, specialAdCategory: 'ISSUES_ELECTIONS_POLITICS' })).toThrow()
    expect(tool('set-meta-ad-set').description).toMatch(/Retail Media Network/)
    expect(tool('set-meta-campaign').description).toMatch(/set-meta-ad-set startTime/)
  })
})

describe('set-meta-campaign', () => {
  it('a budget raise: a preview from the live state, SPENDS MONEY, Meta\'s check not used yet (said), basis and plan stable', async () => {
    const out = await preview('set-meta-campaign', { campaignId: C, dailyBudgetCents: 7000 })
    expect(out.ok).toBe(true)
    expect(h.check).not.toHaveBeenCalled()
    expect(out.preview).toMatchObject({ spendsMoney: true, requests: [{ step: 1, metaCheck: 'not-used-yet' }], changes: { 'Campaign budget (daily)': { from: '50.00 EUR daily', to: '70.00 EUR daily' } } })
    expect(out.preview.metaCheck.sentence).toMatch(/not used for this change yet/)
    expect(out.preview.warnings[0]).toMatch(/^SPENDS MONEY \(your decision\): Raising/)
    const again = await preview('set-meta-campaign', { campaignId: C, dailyBudgetCents: 7000 }, recheck)
    expect([again.preview.basis, again.preview.plan]).toEqual([out.preview.basis, out.preview.plan])
  })
  it('runs as approved: the request as the kit builds it, read back, recorded; undo reads it live and puts the old budget back', async () => {
    const p = (await preview('set-meta-campaign', { campaignId: C, dailyBudgetCents: 7000 })).preview
    h.send.mockImplementationOnce(async () => ({ node: { id: C, daily_budget: '7000' }, readBack: 'same-request', waitedMs: 0 }))
    const ran = await run('set-meta-campaign', { campaignId: C, dailyBudgetCents: 7000 }, p)
    expect(ran.ok).toBe(true)
    expect(h.send.mock.calls[0][1]).toEqual({
      objectId: C, kind: 'campaign', params: { daily_budget: '7000' }, operation: 'campaign.settings', budget: false, readBackInPost: true,
      expect: { daily_budget: '7000' }, readBackFields: 'id,daily_budget',
    })
    expect(ran.data.steps[0]).toMatchObject({ outcome: 'done', sentence: expect.stringMatching(/it now reads daily_budget 7000/), values: { daily_budget: '7000' } })
    expect(ran.change!.after).toEqual({ kind: 'campaign', id: C, fields: { daily_budget: '7000' }, accountId: 'm-1', adAccountId: '1234567890' })
    expect(ran.change!.before).toMatchObject({ undo: { dailyBudgetCents: 5000 }, accountId: 'm-1' })
    const t = tool('set-meta-campaign')
    h.fieldValues = { daily_budget: '7000' }
    expect(await t.undo!.current(ran.change!)).toEqual(ran.change!.after)
    h.fieldValues = { daily_budget: '6500' }
    expect(await t.undo!.current(ran.change!)).not.toEqual(ran.change!.after)
    const back = t.undo!.request(ran.change!)
    expect(back).toEqual({ tool: 'set-meta-campaign', args: { connectionId: 'm-1', campaignId: C, dailyBudgetCents: 5000, why: 'undo of an earlier Meta change' } })
    expect(t.input.safeParse((back as { args: unknown }).args).success).toBe(true)
  })
  it('Meta said success but reads back another budget: not recorded as done, never sent again', async () => {
    const p = (await preview('set-meta-campaign', { campaignId: C, dailyBudgetCents: 7000 })).preview
    h.send.mockImplementationOnce(async () => ({ node: { id: C, daily_budget: '5000' }, readBack: 'same-request', waitedMs: 0 }))
    const ran = await run('set-meta-campaign', { campaignId: C, dailyBudgetCents: 7000 }, p)
    expect(ran).toEqual({ ok: false, error: expect.stringMatching(/^Not confirmed: 1\. .*reads back daily_budget 5000, not what was asked \(daily_budget\)/) })
    expect(h.send).toHaveBeenCalledTimes(1)
  })
  it('budget sharing off: no undo (Meta cannot switch it on again)', async () => {
    h.campaign = { ...CAMPAIGN, dailyBudget: null, budgetSharing: true }
    const p = (await preview('set-meta-campaign', { campaignId: C, budgetSharing: false })).preview
    expect(p.warnings.join(' ')).toMatch(/for good/)
    h.send.mockImplementationOnce(async () => ({ node: { id: C, is_adset_budget_sharing_enabled: false }, readBack: 'same-request', waitedMs: 0 }))
    const ran = await run('set-meta-campaign', { campaignId: C, budgetSharing: false }, p)
    expect(ran.change!.after).toMatchObject({ fields: { is_adset_budget_sharing_enabled: 'false' } })
    expect(tool('set-meta-campaign').undo!.request(ran.change!)).toEqual({ refusal: expect.stringMatching(/Meta cannot switch it on again/) })
  })
  it('an id of another account or another kind: refused in words before any change', async () => {
    h.refuseRead = 'Campaign 120000000000009 is not of the Meta ad account this business chose: Nexus changes nothing in another account.'
    expect(await preview('set-meta-campaign', { campaignId: '120000000000009', name: 'x' })).toEqual({ ok: false, error: expect.stringMatching(/not of the Meta ad account this business chose/) })
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe('set-meta-ad-set', () => {
  it('a restart: its end time, then the switch-on; the switch-on is never sent when the end time did not change', async () => {
    const args = { adSetId: S, restart: true, endTime: '2099-02-01T00:00:00Z' }
    const p = (await preview('set-meta-ad-set', args)).preview
    expect(p.requests.map((r: any) => [r.step, r.metaCheck])).toEqual([[1, 'no-check'], [2, 'no-check']])
    expect(p.spendsMoneyBecause.join(' ')).toMatch(/Restarting/)
    h.send.mockImplementationOnce(async () => { throw new MetaWriteError(localFailure('Meta refused it (100): x. Nothing was changed.', 'X'), 'w', 'refused') })
    const failed = await run('set-meta-ad-set', args, p)
    expect(failed).toEqual({ ok: false, error: expect.stringMatching(/^Not run: Meta changed nothing\..*2\. Switch on .*not sent — step 1 did not happen/) })
    expect(h.send).toHaveBeenCalledTimes(1)
    h.send.mockReset()
    h.send.mockImplementationOnce(async () => ({ node: { id: S, end_time: '2099-02-01T00:00:00+0000' }, readBack: 'second-read', waitedMs: 0 }))
      .mockImplementationOnce(async () => ({ node: { id: S, status: 'ACTIVE', effective_status: 'ACTIVE' }, readBack: 'second-read', waitedMs: 31_000 }))
    const ran = await run('set-meta-ad-set', args, p)
    expect(h.send.mock.calls.map((c) => [c[1].operation, c[1].params])).toEqual([['adset.settings', { end_time: String(Date.parse('2099-02-01T00:00:00Z') / 1000) }], ['adset.status', { status: 'ACTIVE' }]])
    expect(ran.data).toMatchObject({ done: 2, of: 2 })
    expect(ran.change!.after).toEqual({ kind: 'adset', id: S, fields: { end_time: String(Date.parse('2099-02-01T00:00:00Z') / 1000) }, unread: [], accountId: 'm-1', adAccountId: '1234567890' })
    expect(tool('set-meta-ad-set').undo!.request(ran.change!)).toEqual({ refusal: expect.stringMatching(/set-meta-status/) })
  })
  it('a bid raise under a cap: SPENDS MONEY, says nothing spends yet while the ad set is paused; undo through the same tool', async () => {
    h.campaign = { ...CAMPAIGN, dailyBudget: null }
    h.adSet = { ...AD_SET, bidStrategy: 'LOWEST_COST_WITH_BID_CAP', bidAmount: '100', endTime: null }
    const p = (await preview('set-meta-ad-set', { adSetId: S, bidAmountCents: 150 })).preview
    expect(p.spendsMoneyBecause[0]).toMatch(/nothing spends yet/)
    h.send.mockImplementationOnce(async () => ({ node: { id: S, bid_amount: 150 }, readBack: 'second-read', waitedMs: 0 }))
    const ran = await run('set-meta-ad-set', { adSetId: S, bidAmountCents: 150 }, p)
    expect(h.send.mock.calls[0][1]).toMatchObject({ kind: 'adset', operation: 'adset.settings', readBackInPost: false, readBackFields: 'id,bid_amount', expect: { bid_amount: '150' } })
    const back = tool('set-meta-ad-set').undo!.request(ran.change!)
    expect(back).toEqual({ tool: 'set-meta-ad-set', args: { connectionId: 'm-1', adSetId: S, bidAmountCents: 100, why: 'undo of an earlier Meta change' } })
    expect(tool('set-meta-ad-set').input.safeParse((back as { args: unknown }).args).success).toBe(true)
  })
  it('a field Meta does not read back (SDK only) is recorded as sent and undo cannot see it move', async () => {
    h.adSet = { ...AD_SET, fullFunnelExploration: 'NONE_EXPLORATION' }
    const p = (await preview('set-meta-ad-set', { adSetId: S, fullFunnelExploration: 'LIMITED_EXPLORATION' })).preview
    h.send.mockImplementationOnce(async () => ({ node: { id: S }, readBack: 'second-read', waitedMs: 0 }))
    const ran = await run('set-meta-ad-set', { adSetId: S, fullFunnelExploration: 'LIMITED_EXPLORATION' }, p)
    expect(ran.change!.after).toMatchObject({ fields: { full_funnel_exploration_mode: 'LIMITED_EXPLORATION' }, unread: ['full_funnel_exploration_mode'] })
    expect(await tool('set-meta-ad-set').undo!.current(ran.change!)).toEqual(ran.change!.after)
  })
})

describe('set-meta-budget-schedule', () => {
  it('a create: on the campaign\'s edge, the new period\'s id from Meta\'s answer; no undo', async () => {
    const args = { action: 'create', level: 'campaign', objectId: C, startTime: '2099-03-01T08:00:00Z', endTime: '2099-03-01T20:00:00Z', increaseCents: 2000 }
    const p = (await preview('set-meta-budget-schedule', args)).preview
    expect(p.spendsMoney).toBe(true)
    expect(p.requests[0].metaCheck).toBe('no-check')
    h.send.mockImplementationOnce(async () => ({ node: { id: '120000000000032', budget_value: 20, budget_value_type: 'ABSOLUTE', time_start: '2099-03-01T08:00:00+0000', time_end: '2099-03-01T20:00:00+0000' }, readBack: 'same-request', waitedMs: 0 }))
    const ran = await run('set-meta-budget-schedule', args, p)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: C, kind: 'campaign', edge: 'budget_schedules', operation: 'budgetSchedule.create', readBackInPost: true })
    expect(ran.data).toMatchObject({ periodId: '120000000000032' })
    expect(ran.change!.after).toMatchObject({ kind: 'highdemandperiod', id: '120000000000032', parent: { kind: 'campaign', id: C }, fields: { budget_value: '20', budget_value_type: 'ABSOLUTE' } })
    expect(tool('set-meta-budget-schedule').undo!.request(ran.change!)).toEqual({ refusal: expect.stringMatching(/cannot be taken back/) })
  })
  it('a delete (SDK only): DELETE of the period with its campaign; undo schedules it again; current sees it gone', async () => {
    const args = { action: 'delete', level: 'campaign', objectId: C, periodId: P }
    const p = (await preview('set-meta-budget-schedule', args)).preview
    expect(p.spendsMoney).toBe(false)
    h.send.mockImplementationOnce(async () => ({ node: { success: true }, readBack: 'none', waitedMs: 0 }))
    const ran = await run('set-meta-budget-schedule', args, p)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: P, kind: 'highdemandperiod', method: 'DELETE', parent: { kind: 'campaign', id: C }, operation: 'budgetSchedule.delete' })
    expect(ran.data.steps[0].sentence).toMatch(/Meta confirmed it\./)
    h.periods = []
    expect(await tool('set-meta-budget-schedule').undo!.current(ran.change!)).toEqual(ran.change!.after)
    const back = tool('set-meta-budget-schedule').undo!.request(ran.change!)
    expect(back).toMatchObject({ tool: 'set-meta-budget-schedule', args: { action: 'create', level: 'campaign', objectId: C, increaseCents: 2000, startTime: '2099-01-01T08:00:00.000Z' } })
    expect(tool('set-meta-budget-schedule').input.safeParse((back as { args: unknown }).args).success).toBe(true)
  })
  it('an account without Meta\'s budget-scheduling capability: refused in words', async () => {
    h.capabilities = ['CAN_CREATE_LOOKALIKES']
    expect(await preview('set-meta-budget-schedule', { action: 'switch', level: 'campaign', objectId: C, enabled: false })).toEqual({ ok: false, error: expect.stringMatching(/CAN_USE_BUDGET_SCHEDULING_API/) })
  })
})
