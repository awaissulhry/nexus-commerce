/**
 * C6 — an approved change is not skipped as "the facts moved since you approved it" when nothing a person cares about
 * moved (production, 2026-10-07). PGlite, production schema; the job queue a stub; made-up names and ids.
 *
 *   rule basis   the ads rule evaluator writes every rule's evaluationCount / lastEvaluatedAt on every 15-minute tick, which moved
 *                `updatedAt`, the basis of turn-up-automation: 5 of 7 approved turn-ups of one plan were skipped. The basis
 *                is now the rule's settings: a tick between approval and run moves nothing; a person's edit of its
 *                conditions still skips it.
 *   chain        a later step of a plan was skipped for the change an EARLIER step of the same plan made (set-target-values
 *                then switch on, one hourly plan; campaigns moved into a portfolio, then the hourly plan bound to it). The
 *                plan runner takes such a step's basis again after the earlier step ran (AgentTool.planEntities): both
 *                run. A change made outside the plan between the steps still skips the later one.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { seedAdsFixture } from '../../test-support/ads-fixtures.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true, workersOff: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    readinessQueue: queue, agentPlanQueue: null, queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction.
vi.mock('../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
// A seam for "someone changes it outside the plan, just before this step is re-checked": runs once, then clears itself.
const hooks = vi.hoisted(() => ({ beforeCheck: null as null | ((toolName: string, args: Record<string, unknown>) => Promise<boolean>) }))
vi.mock('../agent-fleet/approval-inbox.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../agent-fleet/approval-inbox.service.js')>()
  return {
    ...real,
    previewStaleness: async (...a: Parameters<typeof real.previewStaleness>) => {
      if (hooks.beforeCheck && (await hooks.beforeCheck(a[0], a[1]))) hooks.beforeCheck = null
      return real.previewStaleness(...a)
    },
  }
})

import type { UserPrincipal } from './call-tool.js'
import { callTool } from './call-tool.js'
import { runOrQueueTool } from './approval-gate.service.js'
import { runPlan } from './change-plan.service.js'
import { commitScheduledApproval, decideFleetApproval } from '../agent-fleet/approval-inbox.service.js'
import { campaignSettingsEntities } from './tools/ads-campaign-settings.tools.js'
import { hourlyPlanEntities } from './tools/ads-hourly-plan.tools.js'
import { switchEntities } from './tools/automation-change.tools.js'
import { markGuardChecked } from '../advertising/ads-automation-state.service.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client as any
const EVERYTHING = new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)])
const people = { asker: '', approver: '' }
const principal = (userId: string, via: 'claude' | 'app'): UserPrincipal => ({
  kind: 'user', userId, label: `Person ${userId.slice(0, 6)}`, via, workspace: business, permissions: { isOwner: false, permissions: EVERYTHING },
})
type Row = Record<string, any>
const WEEK = [{ days: [1, 2, 3, 4, 5], startHour: 0, endHour: 6, targetKey: 'test-floor' }]
const ids: Record<string, string> = {}

/** Claude asks (a request or a plan), a person approves it in Nexus, the undo window closes and the commit takes it. */
async function askApproveCommit(args: Record<string, unknown>, tool = 'submit-change-plan'): Promise<string> {
  const asked = await inside(async () => {
    const run = await db().agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: people.asker } })
    return runOrQueueTool(tool, args, principal(people.asker, 'claude'), run.id, { forceAsk: true })
  }) as Row
  expect(asked, JSON.stringify(asked)).toMatchObject({ ok: true, mode: 'queued' })
  const parked = await inside(() => decideFleetApproval({ id: asked.approvalId, decision: 'approve', actor: principal(people.approver, 'app') })) as Row
  expect(parked, JSON.stringify(parked)).toMatchObject({ ok: true, status: 'scheduled' })
  return asked.approvalId as string
}
async function commit(approvalId: string): Promise<Row> {
  await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(approvalId)) as Promise<Row>
}
const steps = (approvalId: string) => inside(() => db().agentPlanStep.findMany({ where: { approvalId }, orderBy: { position: 'asc' } })) as Promise<Row[]>
const planRow = (id: string) => inside(() => db().rankScheduleGroup.findUnique({ where: { id } })) as Promise<Row>
const membersOf = async (groupId: string) => (await inside(() => db().adSchedule.findMany({ where: { groupId }, select: { campaignId: true, targetOverrides: true } })) as Row[])
/** What the ads rule evaluator writes on every tick of a rule (automation-rule.service.ts): the counter and the stamp. */
const evaluatorTick = (ruleId: string) => inside(() => db().automationRule.update({ where: { id: ruleId }, data: { evaluationCount: { increment: 1 }, lastEvaluatedAt: new Date() } }))
const rule = (name: string) => db().automationRule.create({
  data: { domain: 'advertising', name, trigger: 'KEYWORD_HIGH_ACOS', enabled: true, autonomyLevel: 'OBSERVE', conditions: [{ field: 'adTarget.acos', op: 'gt', value: 0.5 }], actions: [{ type: 'bid_up', percent: 5 }] },
})
const campaign = (id: string, extra: Record<string, unknown> = {}) => db().campaign.create({
  data: { id, name: `Test ${id}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`, dailyBudget: '12.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, ...extra },
})
/** An hourly plan of a person's (made on the page), switched off, over the campaigns given. */
async function hourlyPlan(name: string, members: string[], extra: Record<string, unknown> = {}) {
  const g = await db().rankScheduleGroup.create({ data: { name, marketplace: 'IT', windows: WEEK, defaultTargetKey: 'test-top', enabled: false, ...extra } })
  for (const c of members) await db().adSchedule.create({ data: { campaignId: c, name: `${name} member`, windows: WEEK, defaultTargetKey: 'test-top', enabled: false, groupId: g.id } })
  return g.id as string
}

beforeAll(async () => {
  database = await formulaDatabase()
  const c = database.client as any
  people.asker = (await c.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Test Asker' } })).id
  people.approver = (await c.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Test Approver' } })).id
  // The approver holds every permission in this business (the plan runner checks the decider's access again per step).
  const role = await c.role.create({ data: { key: `C6CH_${randomUUID().slice(0, 8)}`, name: 'Plan approver', description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
  await c.userRole.create({ data: { userId: people.approver, roleId: role.id } })
  const membership = await c.workspaceMembership.create({ data: { workspaceId: LEGACY_WORKSPACE_ID, userId: people.approver, status: 'active' } })
  await c.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  await inside(async () => {
    await seedAdsFixture(c)
    await c.rankTarget.create({ data: { key: 'test-floor', name: 'Test min bid', pause: true } })
    await c.rankTarget.create({ data: { key: 'test-top', name: 'Test top', biasPct: 50 } })
    ids.ruleTicked = (await rule('TEST rule the evaluator ticks')).id
    ids.ruleEdited = (await rule('TEST rule a person edits')).id
    ids.ruleAlone = (await rule('TEST rule asked alone')).id
    for (const id of ['c-h1', 'c-h2', 'c-pa', 'c-pb', 'c-pc']) await campaign(id)
    ids.twoSteps = await hourlyPlan('Test two steps', ['c-h1'])
    ids.outside = await hourlyPlan('Test outside change', ['c-h2'])
    // A portfolio Amazon holds (the fixture's IT profile), and a plan bound to it over the campaign already in it.
    await c.amazonAdsPortfolio.create({ data: { profileId: 'P-IT-TEST', externalPortfolioId: 'PF-JACKET-TEST', name: 'Test jacket portfolio', state: 'ENABLED' } })
    await db().campaign.update({ where: { id: 'c-pa' }, data: { portfolioId: 'PF-JACKET-TEST' } })
    ids.portfolioPlan = await hourlyPlan('Test portfolio plan', ['c-pa'], { portfolioId: 'PF-JACKET-TEST' })
    // The other rows an engine stamps on its own tick (one of each kind a switch or a tune reads).
    await c.adsAutomationState.create({ data: { id: 'singleton', autonomy: 'SUGGEST' } })
    await campaign('c-day')
    ids.dayparting = (await c.adSchedule.create({ data: { campaignId: 'c-day', name: 'TEST night', windows: [{ days: [1], startHour: 0, endHour: 6 }], enabled: true } })).id
    ids.budgetSchedule = (await c.budgetSchedule.create({ data: { name: 'TEST budget schedule', kind: 'BUDGET', type: 'CAMPAIGN_BUDGET', campaigns: [{ id: 'c-day', dailyBudget: 10 }], windows: [{ day: 1, start: '08:00', end: '12:00', adj: 'incPct', value: 50 }], enabled: true } })).id
    ids.pool = (await c.budgetPool.create({ data: { name: 'TEST pool', totalDailyBudgetCents: 5000, enabled: true, dryRun: true } })).id
    ids.autopilot = (await c.autopilotPlan.create({ data: { name: 'TEST autopilot', marketplace: 'IT', campaignIds: ['c-day'], enabled: true } })).id
    ids.ebay = (await c.ebayAdsRule.create({ data: { name: 'TEST eBay rule', enabled: true, mode: 'PROPOSE', trigger: { scope: 'CPS_AD', all: [] }, action: { type: 'adjust_ad_rate', deltaPct: 10 } } })).id
    const product = await c.product.create({ data: { sku: 'TEST-BASIS-1', name: 'Test basis jacket', basePrice: '100.00' } })
    ids.repricing = (await c.repricingRule.create({ data: { productId: product.id, channel: 'AMAZON', marketplace: 'IT', enabled: true, minPrice: '10.00', maxPrice: '200.00', strategy: 'match_buy_box' } })).id
  })
}, 180_000)
afterEach(() => { hooks.beforeCheck = null })
afterAll(async () => { await database?.close() }, 30_000)

describe('a rule\'s basis is its settings, not its evaluator\'s bookkeeping', () => {
  it('turn-up-automation and save-ad-rule preview the same basis across an evaluator tick; a person\'s edit moves it', async () => {
    const asker = principal(people.asker, 'claude')
    const basisOf = async (tool: string, args: Record<string, unknown>) => {
      const raw = (await inside(() => callTool(asker, tool, args))).raw as Row
      expect(raw.ok, raw.error).toBe(true)
      return raw.preview.basis as string
    }
    const up = { automation: 'A1', rowId: ids.ruleTicked, level: 'PROPOSE' }
    const save = { kind: 'amazon-ads', ruleId: ids.ruleTicked, name: 'TEST rule the evaluator ticks (renamed)', scope: { marketplace: 'IT' }, caps: { maxExecutionsPerDay: 50, maxWritesPerDay: 20, maxValueCentsEur: 500 } }
    const [upBefore, saveBefore] = [await basisOf('turn-up-automation', up), await basisOf('save-ad-rule', save)]
    expect(upBefore).toMatch(/^rule:/)
    expect(saveBefore).toMatch(/^rule:/)
    const was = (await inside(() => db().automationRule.findUniqueOrThrow({ where: { id: ids.ruleTicked } }))).updatedAt as Date
    await new Promise((r) => setTimeout(r, 5))
    const ticked = await evaluatorTick(ids.ruleTicked)
    expect(ticked.updatedAt.getTime()).toBeGreaterThan(was.getTime())
    expect(await basisOf('turn-up-automation', up)).toBe(upBefore)
    expect(await basisOf('save-ad-rule', save)).toBe(saveBefore)
    // Control: a change of what the rule does moves both.
    await inside(() => db().automationRule.update({ where: { id: ids.ruleTicked }, data: { actions: [{ type: 'bid_up', percent: 6 }] } }))
    expect(await basisOf('turn-up-automation', up)).not.toBe(upBefore)
    expect(await basisOf('save-ad-rule', save)).not.toBe(saveBefore)
  })

  it('an approved turn-up runs although the evaluator ticked the rule meanwhile (alone, and as a step of a plan)', async () => {
    const alone = await askApproveCommit({ automation: 'A1', rowId: ids.ruleAlone, level: 'PROPOSE' }, 'turn-up-automation')
    await evaluatorTick(ids.ruleAlone)
    const done = await commit(alone)
    expect(done, JSON.stringify(done)).toMatchObject({ ok: true, status: 'executed' })
    expect((await inside(() => db().automationRule.findUniqueOrThrow({ where: { id: ids.ruleAlone } }))).autonomyLevel).toBe('PROPOSE')

    const plan = await askApproveCommit({ title: 'Test turn-up', steps: [{ tool: 'turn-up-automation', args: { automation: 'A1', rowId: ids.ruleTicked, level: 'PROPOSE' } }] })
    await evaluatorTick(ids.ruleTicked)
    await evaluatorTick(ids.ruleTicked)
    expect(await commit(plan)).toMatchObject({ ok: true, status: 'executing' })
    expect(await inside(() => runPlan(plan))).toMatchObject({ finished: true, counts: { done: 1 } })
    expect((await inside(() => db().automationRule.findUniqueOrThrow({ where: { id: ids.ruleTicked } }))).autonomyLevel).toBe('PROPOSE')
  })

  it('control: a turn-up of a rule whose conditions a person changed after the approval is skipped, saying the facts moved', async () => {
    const plan = await askApproveCommit({ title: 'Test turn-up, edited rule', steps: [{ tool: 'turn-up-automation', args: { automation: 'A1', rowId: ids.ruleEdited, level: 'PROPOSE' } }] })
    await inside(() => db().automationRule.update({ where: { id: ids.ruleEdited }, data: { conditions: [{ field: 'adTarget.acos', op: 'gt', value: 0.2 }] } }))
    await commit(plan)
    expect(await inside(() => runPlan(plan))).toMatchObject({ finished: true, counts: { skipped: 1 } })
    const [step] = await steps(plan)
    expect(step.reason).toMatch(/^not run — the facts moved since you approved it — basis changed from "rule:/)
    expect((await inside(() => db().automationRule.findUniqueOrThrow({ where: { id: ids.ruleEdited } }))).autonomyLevel).toBe('OBSERVE')
  })
})

describe('a later step is not refused for what an earlier step of the same plan changed', () => {
  it('pure: the entities each step declares', () => {
    expect(hourlyPlanEntities({ op: 'switch', planId: 'g1', on: true }, { plan: { planId: 'g1', portfolioId: 'PF-1' }, campaignIds: ['c2', 'c1'] }))
      .toEqual({ reads: ['hourly-plan:g1', 'campaign:c1', 'campaign:c2', 'portfolio:PF-1'], writes: ['hourly-plan:g1', 'campaign:c1', 'campaign:c2'] })
    expect(campaignSettingsEntities({ campaignIds: ['c9'], portfolioId: 'PF-2' }, { items: [{ campaignId: 'c9', set: { portfolioId: { from: 'PF-1', to: 'PF-2' } } }] }))
      .toEqual({ reads: ['campaign:c9', 'portfolio:PF-1', 'portfolio:PF-2'], writes: ['campaign:c9', 'portfolio:PF-1', 'portfolio:PF-2'] })
    expect(switchEntities({ automation: 'ads-rules', rowId: 'r1', level: 'PROPOSE' }, { automation: { id: 'A1' }, row: { id: 'r1' } }))
      .toEqual({ reads: ['automation:A1:r1', 'automation-rule:r1'], writes: ['automation:A1:r1', 'automation-rule:r1'] })
  })

  it('two steps on ONE hourly plan (its own values, then switch it on): both run, and the second says its basis was taken again', async () => {
    const plan = await askApproveCommit({
      title: 'Test values then on',
      steps: [
        { tool: 'set-hourly-bid-plan', args: { op: 'set-target-values', planId: ids.twoSteps, values: [{ campaignId: 'c-h1', targetKey: 'test-top', placementPct: 30 }] } },
        { tool: 'set-hourly-bid-plan', args: { op: 'switch', planId: ids.twoSteps, on: true } },
      ],
    })
    expect(await commit(plan)).toMatchObject({ ok: true, status: 'executing' })
    const out = await inside(() => runPlan(plan))
    const rows = await steps(plan)
    expect(out, JSON.stringify(rows.map((s) => [s.status, s.reason]))).toMatchObject({ finished: true, counts: { done: 2 } })
    expect((await planRow(ids.twoSteps)).enabled).toBe(true)
    const [member] = await membersOf(ids.twoSteps)
    expect(member.targetOverrides).toMatchObject({ 'test-top': expect.anything() })
    const trace = await inside(() => db().agentControlAudit.findMany({ where: { action: 'basis_rebased' } })) as Row[]
    expect(trace.some((t) => t.toValue?.approvalId === plan && t.toValue?.step === 2 && /^step 1 \(set-hourly-bid-plan\) of this plan changed what it stands on/.test(t.note))).toBe(true)
  })

  it('control: a change made OUTSIDE the plan between the two steps still skips the second', async () => {
    const plan = await askApproveCommit({
      title: 'Test values then on, renamed meanwhile',
      steps: [
        { tool: 'set-hourly-bid-plan', args: { op: 'set-target-values', planId: ids.outside, values: [{ campaignId: 'c-h2', targetKey: 'test-top', placementPct: 30 }] } },
        { tool: 'set-hourly-bid-plan', args: { op: 'switch', planId: ids.outside, on: true } },
      ],
    })
    await commit(plan)
    // A person renames the plan on the Hourly Bids page after step 1 ran, just before step 2 is re-checked.
    hooks.beforeCheck = async (tool, args) => {
      if (tool !== 'set-hourly-bid-plan' || args.op !== 'switch') return false
      await db().rankScheduleGroup.update({ where: { id: ids.outside }, data: { name: 'Test outside change (renamed by a person)' } })
      return true
    }
    expect(await inside(() => runPlan(plan))).toMatchObject({ finished: true, counts: { done: 1, skipped: 1 } })
    const [first, second] = await steps(plan)
    expect(first.status).toBe('done')
    expect(second.reason).toMatch(/^not run — the facts moved since you approved it — basis changed/)
    expect((await planRow(ids.outside)).enabled).toBe(false)
  })

  it('campaigns moved into a portfolio, then the hourly plan bound to that portfolio changed: both run', async () => {
    const plan = await askApproveCommit({
      title: 'Test portfolio move, then its plan',
      steps: [
        { tool: 'set-campaign-settings', args: { campaignIds: ['c-pb'], portfolioId: 'PF-JACKET-TEST' } },
        { tool: 'set-hourly-bid-plan', args: { op: 'set-campaigns', planId: ids.portfolioPlan, add: ['c-pc'] } },
      ],
    })
    // At approval the plan's save would take in c-pa (the portfolio's) and c-pc; after step 1, c-pb too.
    const [, asked] = await steps(plan)
    expect(asked.preview.members).toMatchObject({ from: 1, to: 2 })
    expect(await commit(plan)).toMatchObject({ ok: true, status: 'executing' })
    const out = await inside(() => runPlan(plan))
    const rows = await steps(plan)
    expect(out, JSON.stringify(rows.map((s) => [s.status, s.reason]))).toMatchObject({ finished: true, counts: { done: 2 } })
    expect((await inside(() => db().campaign.findUniqueOrThrow({ where: { id: 'c-pb' } }))).portfolioId).toBe('PF-JACKET-TEST')
    expect((await membersOf(ids.portfolioPlan)).map((m) => m.campaignId).sort()).toEqual(['c-pa', 'c-pb', 'c-pc'])
  })
})

describe('the other rows an engine stamps on its own tick: their bases are their settings', () => {
  const asker = () => principal(people.asker, 'claude')
  const basisOf = async (tool: string, args: Record<string, unknown>) => {
    const raw = (await inside(() => callTool(asker(), tool, args))).raw as Row
    expect(raw.ok, `${tool} ${JSON.stringify(args)}: ${raw.error}`).toBe(true)
    return raw.preview.basis as string
  }
  const later = () => new Date(Date.now() + 60_000)
  // Each: the request, and exactly what the engine writes on its tick (the writer named beside it).
  const cases: Array<[string, () => [string, Record<string, unknown>], () => Promise<unknown>]> = [
    ['the ads dial (the anomaly guard\'s lastCheckedAt, every 10 minutes)', () => ['turn-down-automation', { automation: 'A3', level: 'OFF' }], () => inside(() => markGuardChecked())],
    ['a stop of Amazon ads (the same row)', () => ['stop-automation', { area: 'amazon-ads', reason: 'TEST spend spike' }], () => inside(() => markGuardChecked())],
    ['the account default target ACOS (the same row)', () => ['tune-ad-engine', { setting: 'account-target-acos', accountTargetAcos: { targetAcosPct: 25 } }], () => inside(() => markGuardChecked())],
    ['a dayparting schedule (ad-dayparting\'s lastApplied, lastEvaluatedAt)', () => ['turn-down-automation', { automation: 'A6', rowId: ids.dayparting, level: 'OFF' }],
      () => inside(() => db().adSchedule.update({ where: { id: ids.dayparting }, data: { lastApplied: 'window-1', lastEvaluatedAt: later(), originalBids: { 't-1': 40 } } }))],
    ['a budget schedule (ad-budget-schedule\'s lastApplied, lastEvaluatedAt)', () => ['turn-down-automation', { automation: 'A7', rowId: ids.budgetSchedule, level: 'OFF' }],
      () => inside(() => db().budgetSchedule.update({ where: { id: ids.budgetSchedule }, data: { lastApplied: { 'c-day': { budget: 15 } }, lastEvaluatedAt: later() } }))],
    ['a budget pool (the rebalancer\'s lastRebalancedAt)', () => ['turn-down-automation', { automation: 'A9', rowId: ids.pool, level: 'OFF' }],
      () => inside(() => db().budgetPool.update({ where: { id: ids.pool }, data: { lastRebalancedAt: later() } }))],
    ['a budget pool\'s tune (the same)', () => ['tune-ad-engine', { setting: 'budget-pool', subjectId: ids.pool, budgetPool: { totalDailyBudgetCents: 4000 } }],
      () => inside(() => db().budgetPool.update({ where: { id: ids.pool }, data: { lastRebalancedAt: later() } }))],
    ['an autopilot plan (ad-autopilot\'s lastEvaluatedAt, linkedRuleIds, lastDecisionAt)', () => ['turn-down-automation', { automation: 'A5', rowId: ids.autopilot, level: 'OFF' }],
      () => inside(() => db().autopilotPlan.update({ where: { id: ids.autopilot }, data: { lastEvaluatedAt: later(), lastDecisionAt: later(), linkedRuleIds: [{ ruleId: 'r-x' }] } }))],
    ['an eBay ads rule (the eBay ads automation\'s lastEvaluatedAt, cooldownUntil)', () => ['turn-down-automation', { automation: 'E1', rowId: ids.ebay, level: 'OFF' }],
      () => inside(() => db().ebayAdsRule.update({ where: { id: ids.ebay }, data: { lastEvaluatedAt: later(), cooldownUntil: later() } }))],
    ['a repricing rule (the repricing engine\'s last decision, every 5 minutes)', () => ['turn-down-automation', { automation: 'N1', rowId: ids.repricing, level: 'OFF' }],
      () => inside(() => db().repricingRule.update({ where: { id: ids.repricing }, data: { lastEvaluatedAt: later(), lastDecisionPrice: '99.90', lastDecisionReason: 'matched the buy box' } }))],
  ]
  for (const [what, request, stamp] of cases) {
    it(`${what}: a tick of its engine moves no basis`, async () => {
      const [tool, args] = request()
      const before = await basisOf(tool, args)
      await new Promise((r) => setTimeout(r, 5))
      await stamp()
      expect(await basisOf(tool, args)).toBe(before)
    })
  }

  it('control: a person\'s change of a setting still moves the basis (a pool\'s budget, the dial, a repricing rule\'s floor)', async () => {
    const pool = { automation: 'A9', rowId: ids.pool, level: 'OFF' }
    const dial = { automation: 'A3', level: 'OFF' }
    const repricing = { automation: 'N1', rowId: ids.repricing, level: 'OFF' }
    const [p, d, r] = [await basisOf('turn-down-automation', pool), await basisOf('turn-down-automation', dial), await basisOf('turn-down-automation', repricing)]
    await inside(() => db().budgetPool.update({ where: { id: ids.pool }, data: { totalDailyBudgetCents: 6000 } }))
    await inside(() => db().adsAutomationState.update({ where: { id: 'singleton' }, data: { maxActionsPerHour: 100 } }))
    await inside(() => db().repricingRule.update({ where: { id: ids.repricing }, data: { minPrice: '12.00' } }))
    expect(await basisOf('turn-down-automation', pool)).not.toBe(p)
    expect(await basisOf('turn-down-automation', dial)).not.toBe(d)
    expect(await basisOf('turn-down-automation', repricing)).not.toBe(r)
  })
})
