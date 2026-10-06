/**
 * MCP full control R14 — tune-ad-engine, through the one door, on a real PostgreSQL (PGlite).
 *
 * Proven, per setting: a change that cannot raise spend is inside the limits; one that can (a higher budget, cap,
 * target ACOS or breaker limit, a pool shift, a looser harvest, a lowering window removed, an eBay posture) is outside —
 * a person decides, and the preview says why. The write goes through the engine's own writer (the route's code), with
 * an audit row; undo puts the setting back (a harvest scope it gave a policy inherits again). Each setting's own route
 * permission is needed; another business's row is not found.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }),
    resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})

import { callTool, executeTool, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'

const A = LEGACY_WORKSPACE_ID
const OTHER = 'ws_r14_other'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const everything = new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)])
const personWith = (permissions: Set<string>): UserPrincipal => ({ kind: 'user', userId: 'u-r14', label: 'R14 test', permissions: { isOwner: false, permissions }, workspace: business(A), via: 'claude' })
const person = personWith(everything)
type Out = { ok: boolean; error?: string; preview?: Record<string, any>; data?: Record<string, any>; change?: { before: any; after: any } }
const dry = async (args: Record<string, unknown>, who = person) => (await callTool(who, 'tune-ad-engine', args)).raw as Out
const run = async (args: Record<string, unknown>) => (await executeTool(person, 'tune-ad-engine', args, { via: 'claude' })).raw as Out
const tool = () => getTool('tune-ad-engine')!
const inLimits = (preview: unknown) => tool().withinLimits!(preview, tool().limits!.parse({}))
const undoArgs = (change: Out['change']) => (tool().undo!.request(change!) as { tool: string; args: Record<string, unknown> })
const ids: Record<string, string> = {}

beforeAll(async () => {
  database = await formulaDatabase()
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`, [OTHER])
  await inside(async () => {
    const db = database.client
    ids.pool = (await db.budgetPool.create({ data: { name: 'TEST pool', totalDailyBudgetCents: 5000 } })).id
    ids.coverage = (await db.keywordCoverageSet.create({ data: { name: 'TEST coverage', portfolioId: 'TEST-PORTFOLIO-1', marketplace: 'IT', dailySpendCapCents: 2000, acosCapPct: 30 } })).id
    ids.target = (await db.rankTarget.create({ data: { key: 'test-target', name: 'TEST target', placement: 'PLACEMENT_TOP', maxCpcCents: 120, acosCapPct: 40 } as never })).id
    ids.builtIn = (await db.rankTarget.create({ data: { key: 'test-builtin', name: 'TEST built-in', placement: 'PLACEMENT_TOP', builtIn: true } as never })).id
    const campaign = await db.campaign.create({ data: { name: 'TEST CAMPAIGN', type: 'SP', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), marketplace: 'IT', externalCampaignId: 'TEST-CMP-1', portfolioId: 'TEST-PORTFOLIO-1' } })
    ids.campaign = campaign.id
    // AA-W2-11 — the pool acts on this campaign, in a market whose ads strategy lets Claude's rule make 100 changes a day.
    await db.budgetPoolAllocation.create({ data: { budgetPoolId: ids.pool, marketplace: 'IT', campaignId: campaign.id, targetSharePct: 1, minDailyBudgetCents: 100 } })
    await db.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Test market (IT)', claudeMaxChangesPerDay: 100, version: 1, updatedBy: 'user:test' } })
    ids.schedule = (await db.budgetSchedule.create({ data: { name: 'TEST budget schedule', kind: 'BUDGET', type: 'CAMPAIGN_BUDGET', campaigns: [{ id: campaign.id, dailyBudget: 10 }], windows: [{ day: 1, start: '22:00', end: '23:00', adj: 'decPct', value: 30 }], enabled: false } as never })).id
    ids.multiplier = (await db.budgetSchedule.create({ data: { name: 'TEST multiplier', kind: 'BUDGET', type: 'budget-multiplier', campaigns: [], windows: [], enabled: false } as never })).id
    const connection = await db.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'r14', isActive: true, externalAccountId: 'TEST-EBAY-SELLER', authStatus: 'connected', managedBy: 'oauth', region: 'IT' } as never })
    ids.ebay = (await db.ebayCampaign.create({ data: { channelConnectionId: connection.id, marketplace: 'EBAY_IT', externalCampaignId: 'TEST-EBAY-CMP-1', name: 'TEST eBay campaign', fundingStrategy: 'STANDARD', status: 'RUNNING', startDate: new Date('2026-01-01T00:00:00Z') } as never })).id
  })
  await inside(async () => { ids.otherPool = (await database.client.budgetPool.create({ data: { name: 'TEST other pool', totalDailyBudgetCents: 900 } })).id }, OTHER)
}, 180_000)
afterAll(async () => {
  await database?.close()
}, 30_000)

describe('R14 — tune-ad-engine', () => {
  it('a budget pool: a smaller shift is inside the limits; a bigger budget or a new strategy needs a person; undo puts it back', async () => {
    const smaller = await dry({ setting: 'budget-pool', subjectId: ids.pool, budgetPool: { maxShiftPerRebalancePct: 10 } })
    expect(smaller.preview).toMatchObject({ action: 'tune-ad-engine', automation: { id: 'A9' }, subject: { name: 'TEST pool' }, changes: { maxShiftPerRebalancePct: { from: 20, to: 10 } }, raises: [], spend: 'cannot-rise' })
    expect(inLimits(smaller.preview)).toBeNull()
    const bigger = await dry({ setting: 'budget-pool', subjectId: ids.pool, budgetPool: { totalDailyBudgetCents: 8000, strategy: 'PROFIT_WEIGHTED', coolDownMinutes: 30 } })
    expect(bigger.preview!.raises).toEqual([
      "the pool's daily budget rises from €50.00 to €80.00",
      'a new strategy (STATIC → PROFIT_WEIGHTED) moves budget between the pool\'s campaigns',
      'the pool rebalances more often (every 60 → 30 minutes)',
    ])
    // AA-W2-11 — a new strategy and a shorter cool-down have no percent: a person decides, whatever the limits say.
    expect(bigger.preview!.largestRaisePct).toBeNull()
    expect(inLimits(bigger.preview)).toMatch(/^it can raise spend in a way that has no percent \(the pool's daily budget rises .*\); a person decides$/)
    expect(tool().withinLimits!(bigger.preview, { ...tool().limits!.parse({}), maxRaisePct: 1000 })).toContain('has no percent')
    // One value rising from a value above 0 has a percent: 0 by default waits; the business's percent lets it run.
    const budget = await dry({ setting: 'budget-pool', subjectId: ids.pool, budgetPool: { totalDailyBudgetCents: 8000 } })
    expect(budget.preview).toMatchObject({ raises: ["the pool's daily budget rises from €50.00 to €80.00"], largestRaisePct: 60 })
    expect(inLimits(budget.preview)).toBe("it can raise spend by up to 60 % (the pool's daily budget rises from €50.00 to €80.00), more than the 0 % this tool's limits let run without a person (0: every raise waits for a person); a person decides")
    expect(tool().withinLimits!(budget.preview, { ...tool().limits!.parse({}), maxRaisePct: 59 })).toContain('more than the 59 %')
    expect(tool().withinLimits!(budget.preview, { ...tool().limits!.parse({}), maxRaisePct: 60 })).toBeNull()
    // The ads strategy where the pool acts (its campaign in IT) is in the preview.
    expect(budget.preview).toMatchObject({ automationScope: { placed: true, outside: false }, limitFacts: { tool: 'tune-ad-engine', action: 'automation', this: { markets: ['IT'], items: 1 } } })

    const done = await run({ setting: 'budget-pool', subjectId: ids.pool, budgetPool: { totalDailyBudgetCents: 8000 } })
    expect(done).toMatchObject({ ok: true, data: { setting: 'budget-pool', changes: { totalDailyBudgetCents: { from: 5000, to: 8000 } } } })
    expect(await inside(() => database.client.budgetPool.findUniqueOrThrow({ where: { id: ids.pool } }))).toMatchObject({ totalDailyBudgetCents: 8000, enabled: false, dryRun: true })
    expect(await inside(() => database.client.advertisingActionLog.findFirst({ where: { actionType: 'tune_engine_setting', entityId: ids.pool }, select: { userId: true, entityType: true, payloadAfter: true } })))
      .toMatchObject({ userId: 'user:u-r14', entityType: 'BUDGET_POOL', payloadAfter: { totalDailyBudgetCents: 8000 } })
    expect(await inside(() => tool().undo!.current(done.change!))).toEqual(done.change!.after)
    const undo = undoArgs(done.change)
    expect(undo).toEqual({ tool: 'tune-ad-engine', args: { setting: 'budget-pool', subjectId: ids.pool, budgetPool: { totalDailyBudgetCents: 5000, strategy: 'STATIC', coolDownMinutes: 60, maxShiftPerRebalancePct: 20 } } })
    expect(inLimits((await dry(undo.args)).preview)).toBeNull() // lowering it back is inside the limits
    expect((await run(undo.args)).ok).toBe(true)
    expect(await inside(() => database.client.budgetPool.findUniqueOrThrow({ where: { id: ids.pool } }))).toMatchObject({ totalDailyBudgetCents: 5000 })
  })

  it('a coverage set: a lower cap is inside; a cap cleared or a higher ACOS cap needs a person', async () => {
    expect((await dry({ setting: 'coverage-set', subjectId: ids.coverage, coverageSet: { dailySpendCapCents: 1500 } })).preview).toMatchObject({ raises: [], changes: { dailySpendCapCents: { from: 2000, to: 1500 } } })
    expect((await dry({ setting: 'coverage-set', subjectId: ids.coverage, coverageSet: { dailySpendCapCents: null, acosCapPct: 35.5 } })).preview!.raises)
      .toEqual(["the set's daily spend cap (€20.00) is cleared", "the set's ACOS cap rises from 30% to 35.5%"])
    const done = await run({ setting: 'coverage-set', subjectId: ids.coverage, coverageSet: { acosCapPct: 25 } })
    expect(done.ok).toBe(true)
    expect(await inside(() => tool().undo!.current(done.change!))).toEqual(done.change!.after)
    expect(undoArgs(done.change).args).toEqual({ setting: 'coverage-set', subjectId: ids.coverage, coverageSet: { dailySpendCapCents: 2000, acosCapPct: 30 } })
  })

  it('a rank target (2e: only what the hourly plan reads): a lower bid ceiling is inside; a higher placement %, a cleared ceiling or a higher floor needs a person; a built-in says so', async () => {
    expect((await dry({ setting: 'rank-target', subjectId: ids.target, rankTarget: { maxCpcCents: 90 } })).preview).toMatchObject({ raises: [], spend: 'cannot-rise' })
    expect((await dry({ setting: 'rank-target', subjectId: ids.target, rankTarget: { biasPct: 200, maxCpcCents: null, floorBidCents: 5 } })).preview!.raises).toEqual([
      'the placement percentage rises (none → 200)',
      'the bid ceiling (120) is cleared',
      'the floor bid rises (none → 5)',
    ])
    // The goal / ACoS / climb fields are not read by the engine any more, so they are not tunable here.
    expect(await dry({ setting: 'rank-target', subjectId: ids.target, rankTarget: { keepClimbing: true, acosCapPct: null, targetISPct: 30 } })).toMatchObject({ ok: false, error: expect.stringContaining('nothing to change') })
    expect((await dry({ setting: 'rank-target', subjectId: ids.builtIn, rankTarget: { maxCpcCents: 50 } })).preview!.effect).toContain('a built-in target: every plan and schedule using it changes')
    const done = await run({ setting: 'rank-target', subjectId: ids.target, rankTarget: { maxCpcCents: 90 } })
    expect(await inside(() => database.client.rankTarget.findUniqueOrThrow({ where: { id: ids.target } }))).toMatchObject({ maxCpcCents: 90, acosCapPct: 40, pause: false })
    expect(undoArgs(done.change).args).toMatchObject({ setting: 'rank-target', rankTarget: { maxCpcCents: 120 } })
  })

  it('a budget schedule: another lowering window is inside; removing the lowering window or a raise needs a person; the route\'s writer writes it', async () => {
    const lowering = { day: 1, start: '22:00', end: '23:00', adj: 'decPct', value: 30 }
    expect((await dry({ setting: 'budget-schedule', subjectId: ids.schedule, budgetSchedule: { windows: [lowering, { day: 2, adj: 'decPct', value: 10 }] } })).preview).toMatchObject({ raises: [] })
    expect((await dry({ setting: 'budget-schedule', subjectId: ids.schedule, budgetSchedule: { windows: [{ day: 3, start: '09:00', end: '12:00', adj: 'incPct', value: 20 }] } })).preview!.raises).toEqual([
      'window Wed 09:00–12:00 incPct 20 can raise a budget',
      'the lowering window Mon 22:00–23:00 decPct 30 goes: its budgets come back up',
    ])
    expect((await dry({ setting: 'budget-schedule', subjectId: ids.schedule, budgetSchedule: { windows: [{ day: 1, start: '09:00', adj: 'decPct', value: 5 }] } })).error).toContain('a window needs both start and end, or neither (all day)')
    expect((await dry({ setting: 'budget-schedule', subjectId: ids.multiplier, budgetSchedule: { windows: [{ day: 1, value: 12 }] } })).error).toContain("a multiplier schedule's window value is ×")
    expect((await dry({ setting: 'budget-schedule', subjectId: ids.multiplier, budgetSchedule: { windows: [{ day: 1, value: 0.8 }] } })).preview).toMatchObject({ raises: [] })
    const done = await run({ setting: 'budget-schedule', subjectId: ids.schedule, budgetSchedule: { windows: [lowering, { day: 2, adj: 'decPct', value: 10 }] } })
    expect(done.ok).toBe(true)
    expect(await inside(() => database.client.advertisingActionLog.findFirst({ where: { actionType: 'budget_schedule_update', entityId: ids.schedule }, select: { userId: true, payloadAfter: true } })))
      .toMatchObject({ userId: 'user:u-r14', payloadAfter: { fields: ['windows'] } })
    expect(await inside(() => tool().undo!.current(done.change!))).toEqual(done.change!.after)
    expect(undoArgs(done.change).args).toEqual({ setting: 'budget-schedule', subjectId: ids.schedule, budgetSchedule: { windows: [lowering] } })
  })

  it('a harvest policy: a stricter campaign policy is inside; a looser one needs a person; undo of a new one makes the scope inherit again', async () => {
    const stricter = await dry({ setting: 'harvest-policy', harvestPolicy: { scopeGrain: 'campaign', scopeId: ids.campaign, minOrders: 5 } })
    expect(stricter.preview).toMatchObject({ automation: { id: 'A14' }, subject: { id: null, name: 'harvest policy for TEST CAMPAIGN' }, raises: [], changes: { own: { from: false, to: true }, minOrders: { from: 2, to: 5 } } })
    const looser = await dry({ setting: 'harvest-policy', harvestPolicy: { scopeGrain: 'campaign', scopeId: ids.campaign, minOrders: 1, maxAcosPct: null, windowDays: 90, excludeExactMatched: false } })
    expect(looser.preview!.raises).toEqual(expect.arrayContaining(['fewer orders qualify a term (2 → 1)', 'a longer window qualifies more terms (60 → 90 days)', 'terms already matched exactly qualify again']))
    const created = await run({ setting: 'harvest-policy', harvestPolicy: { scopeGrain: 'campaign', scopeId: ids.campaign, minOrders: 5 } })
    expect(created.ok).toBe(true)
    expect(await inside(() => database.client.adsHarvestPolicy.findFirst({ where: { scopeGrain: 'campaign', scopeId: ids.campaign } }))).toMatchObject({ minOrders: 5, updatedBy: 'user:u-r14' })
    expect(await inside(() => tool().undo!.current(created.change!))).toEqual(created.change!.after)
    const undo = undoArgs(created.change)
    expect(undo.args).toEqual({ setting: 'harvest-policy', harvestPolicy: { scopeGrain: 'campaign', scopeId: ids.campaign, inherit: true } })
    // Back to inheriting can be looser: a person decides it.
    expect((await dry(undo.args)).preview!.raises).toEqual(['fewer orders qualify a term (5 → 2)', 'the scope falls back to the policy above it, which may be looser'])
    expect((await run(undo.args)).ok).toBe(true)
    expect(await inside(() => database.client.adsHarvestPolicy.count({ where: { scopeGrain: 'campaign', scopeId: ids.campaign } }))).toBe(0)
    expect((await dry({ setting: 'harvest-policy', harvestPolicy: { scopeGrain: 'campaign', scopeId: 'tst-no-such-campaign', minOrders: 5 } })).error).toBe('Harvest policy and destinations: there is no campaign tst-no-such-campaign in this business (not found).')
    expect((await dry({ setting: 'harvest-policy', harvestPolicy: { scopeGrain: 'campaign', scopeId: ids.campaign, inherit: true } })).error).toContain('has no policy of its own to remove')
  })

  it('an eBay campaign policy: a lower rate cap is inside; a posture change needs a person; a floor above the cap is refused', async () => {
    expect((await dry({ setting: 'ebay-campaign-policy', subjectId: ids.ebay, ebayCampaignPolicy: { rateCapPct: 8 } })).preview).toMatchObject({ automation: { id: 'E1' }, raises: [], changes: { rateCapPct: { from: null, to: 8 } } })
    expect((await dry({ setting: 'ebay-campaign-policy', subjectId: ids.ebay, ebayCampaignPolicy: { posture: 'OFF' } })).preview!.raises).toEqual(['its posture changes (INHERIT → OFF): which rules act on it changes, the rules that lower rates included'])
    expect((await dry({ setting: 'ebay-campaign-policy', subjectId: ids.ebay, ebayCampaignPolicy: { rateCapPct: 5, rateFloorPct: 6 } })).error).toBe('TEST eBay campaign: ebayCampaignPolicy: the rate floor cannot exceed the rate cap.')
    const done = await run({ setting: 'ebay-campaign-policy', subjectId: ids.ebay, ebayCampaignPolicy: { rateCapPct: 8.5 } })
    expect(done.ok).toBe(true)
    expect(await inside(() => database.client.campaignAction.findFirst({ where: { actionType: 'set_automation_policy' }, select: { userId: true, channel: true } }))).toEqual({ userId: 'u-r14', channel: 'EBAY' })
    expect(await inside(() => tool().undo!.current(done.change!))).toEqual(done.change!.after)
    expect(undoArgs(done.change).args).toEqual({ setting: 'ebay-campaign-policy', subjectId: ids.ebay, ebayCampaignPolicy: { posture: 'INHERIT', protected: false, rateCapPct: null, rateFloorPct: null, bidCapCents: null, bidFloorCents: null } })
  })

  it('the account target ACOS and the breaker: lower is inside; higher, new or back to the default needs a person', async () => {
    expect((await dry({ setting: 'account-target-acos', accountTargetAcos: { targetAcosPct: 30 } })).preview!.raises).toEqual([
      'the bid optimiser (auto-bid, autopilot plans, "Optimise bids to target ACOS" rules) moves every campaign without a target ACOS of its own toward 30% (unless a rule or plan sets its own), instead of profit data or a flat 30%',
      'target-ACOS bid rules without a target of their own start bidding to 30%',
    ])
    // W0 — a launch default above 100 % is a real choice: the optimiser reads it too.
    expect((await dry({ setting: 'account-target-acos', accountTargetAcos: { targetAcosPct: 150 } })).preview!.raises).toHaveLength(2)
    const set = await run({ setting: 'account-target-acos', accountTargetAcos: { targetAcosPct: 30 } })
    expect(set.ok).toBe(true)
    expect((await dry({ setting: 'account-target-acos', accountTargetAcos: { targetAcosPct: 25 } })).preview).toMatchObject({ raises: [] })
    expect((await dry({ setting: 'account-target-acos', accountTargetAcos: { targetAcosPct: 45 } })).preview!.raises).toEqual(['a higher target ACOS lets bids rise (30% → 45%)'])
    expect(undoArgs(set.change).args).toEqual({ setting: 'account-target-acos', accountTargetAcos: { targetAcosPct: null } })

    const lower = await run({ setting: 'breaker', breaker: { maxHourlySpendCentsEur: 20_000 } })
    expect(lower.ok).toBe(true)
    expect(inLimits((await dry({ setting: 'breaker', breaker: { maxActionsPerHour: 100 } })).preview)).toBeNull()
    expect((await dry({ setting: 'breaker', breaker: { maxHourlySpendCentsEur: null } })).preview!.raises).toEqual(['the breaker trips later: hourly spend €200.00 → €500.00'])
    expect(await inside(() => database.client.adsAutomationState.findUniqueOrThrow({ where: { id: 'singleton' } }))).toMatchObject({ maxHourlySpendCentsEur: 20_000, defaultTargetAcosPct: 30 })
  })

  it("each setting needs its own route's permission; nothing to change, no row named, or another business's row is refused", async () => {
    const noBudgets = personWith(new Set([...everything].filter((p) => p !== FEATURES.adsBudgetsEdit)))
    expect((await dry({ setting: 'budget-pool', subjectId: ids.pool, budgetPool: { maxShiftPerRebalancePct: 10 } }, noBudgets)).error).toBe('Tuning a budget-pool needs the ads.budgets.edit permission.')
    expect((await dry({ setting: 'rank-target', subjectId: ids.target, rankTarget: { maxCpcCents: 80 } }, noBudgets)).ok).toBe(true)
    expect((await dry({ setting: 'budget-pool', subjectId: ids.pool, budgetPool: { maxShiftPerRebalancePct: 20 } })).error).toBe('TEST pool: nothing to change — give the budget pool\'s new values.')
    expect((await dry({ setting: 'budget-pool', budgetPool: { maxShiftPerRebalancePct: 10 } })).error).toBe('Name the budget pool to tune (subjectId), from list-automations or automation-detail (A9).')
    expect((await dry({ setting: 'budget-pool', subjectId: ids.otherPool, budgetPool: { maxShiftPerRebalancePct: 10 } })).error).toBe(`Budget pools: there is no budget pool ${ids.otherPool} in this business (not found).`)
  })
})
