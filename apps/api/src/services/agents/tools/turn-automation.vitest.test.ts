/**
 * MCP full control R10 — turn-up-automation / turn-down-automation, through the one door, on a real PostgreSQL (PGlite).
 *
 * Proven: an ads rule climbs OBSERVE → PROPOSE; AUTO is refused without the graduation gate (D-R1) and allowed once the
 * gate is open, then audited; a pausing rule stays under its ceiling; eBay AUTO needs its own gate; a brake turned down
 * is outside the limits (a person decides), a non-brake inside; the ads dial moves and its undo moves it back; pools,
 * schedules and coverage sets switch; an env-only engine is refused, saying so; another business's row is not found.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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

// R14 — a budget schedule switched off gives back the budget it holds (W4): the give-back's write, observed here.
const mutation = vi.hoisted(() => ({ updateCampaignWithSync: vi.fn(async () => ({ ok: true })) }))
vi.mock('../../advertising/ads-mutation.service.js', async (importOriginal) => ({ ...(await importOriginal<object>()), updateCampaignWithSync: mutation.updateCampaignWithSync }))

import { callTool, executeTool, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'

const A = LEGACY_WORKSPACE_ID
const OTHER = 'ws_r10_other'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const person: UserPrincipal = {
  kind: 'user', userId: 'u-r10', label: 'R10 test', permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
  workspace: business(A), via: 'claude',
}
type Out = { ok: boolean; error?: string; preview?: Record<string, any>; data?: Record<string, any>; change?: { before: any; after: any } }
const dry = async (tool: string, args: Record<string, unknown>) => (await callTool(person, tool, args)).raw as Out
const run = async (tool: string, args: Record<string, unknown>) => (await executeTool(person, tool, args, { via: 'claude' })).raw as Out
const up = (args: Record<string, unknown>) => dry('turn-up-automation', args)
const down = (args: Record<string, unknown>) => dry('turn-down-automation', args)
const tool = (name: string) => getTool(name)!
const downLimits = (preview: unknown) => tool('turn-down-automation').withinLimits!(preview, tool('turn-down-automation').limits!.parse({}))
const DAY = 86_400_000
const ids: Record<string, string> = {}
const savedMode = process.env.NEXUS_AMAZON_ADS_MODE

beforeAll(async () => {
  database = await formulaDatabase()
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`, [OTHER])
  await inside(async () => {
    const db = database.client
    const campaign = await db.campaign.create({ data: { name: 'TEST CAMPAIGN', type: 'SP', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), marketplace: 'IT', externalCampaignId: 'TEST-CMP-1' } })
    const rule = (name: string, actions: object[], extra: Record<string, unknown> = {}) => db.automationRule.create({ data: { domain: 'advertising', name, trigger: 'KEYWORD_HIGH_ACOS', enabled: true, autonomyLevel: 'OBSERVE', conditions: [{ field: 'adTarget.acos', op: 'gt', value: 0.5 }], actions, ...extra } as never })
    ids.raiser = (await rule('TEST bid raiser', [{ type: 'bid_up', percent: 5 }])).id
    ids.lowerer = (await rule('TEST bid lowerer', [{ type: 'bid_down', percent: 5 }], { autonomyLevel: 'PROPOSE' })).id
    ids.pauser = (await rule('TEST pauser', [{ type: 'pause_campaign' }], { autonomyLevel: 'PROPOSE' })).id
    // Watched 20 days, 12 real runs, 3 matches: its gate opens once the connection is live.
    ids.graduate = (await rule('TEST graduate', [{ type: 'bid_up', percent: 5 }], { autonomyLevel: 'PROPOSE', createdAt: new Date(Date.now() - 20 * DAY), evaluationCount: 12, matchCount: 3, scopeMarketplace: 'IT' })).id
    // AA-W2-11 — an ads strategy for IT that lets Claude's rule make 100 changes a day there.
    ids.strategy = (await db.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Test market (IT)', claudeMaxChangesPerDay: 100, version: 1, updatedBy: 'user:test' } })).id
    ids.ebay = (await db.ebayAdsRule.create({ data: { name: 'TEST eBay rule', enabled: true, mode: 'PROPOSE', trigger: { scope: 'CPS_AD', all: [] }, action: { type: 'adjust_ad_rate', deltaPct: 10 } } })).id
    ids.pool = (await db.budgetPool.create({ data: { name: 'TEST pool', totalDailyBudgetCents: 5000, enabled: true, dryRun: true } })).id
    ids.schedule = (await db.adSchedule.create({ data: { campaignId: campaign.id, name: 'TEST night', windows: [{ days: [1], startHour: 0, endHour: 6 }], enabled: true } })).id
    ids.coverage = (await db.keywordCoverageSet.create({ data: { name: 'TEST coverage', portfolioId: 'TEST-PORTFOLIO-1', marketplace: 'IT', enabled: false } })).id
    // A budget schedule holding a boost: the campaign's base is 10, the schedule applied 15.
    const boosted = await db.campaign.create({ data: { name: 'TEST BOOSTED', type: 'SP', dailyBudget: '15.00', startDate: new Date('2026-01-01T00:00:00Z'), marketplace: 'IT', externalCampaignId: 'TEST-CMP-2' } })
    ids.boosted = boosted.id
    ids.budgetSchedule = (await db.budgetSchedule.create({ data: { name: 'TEST budget schedule', kind: 'BUDGET', type: 'CAMPAIGN_BUDGET', campaigns: [{ id: boosted.id, dailyBudget: 10 }], windows: [{ day: 1, start: '08:00', end: '12:00', adj: 'incPct', value: 50 }], enabled: true, lastApplied: { [boosted.id]: { budget: 15 } } } as never })).id
  })
  await inside(() => database.client.automationRule.create({ data: { id: 'tst-r10-other', domain: 'advertising', name: 'TEST other business rule', trigger: 'SCHEDULE' } }), OTHER)
}, 180_000)
afterEach(() => {
  if (savedMode === undefined) delete process.env.NEXUS_AMAZON_ADS_MODE
  else process.env.NEXUS_AMAZON_ADS_MODE = savedMode
})
afterAll(async () => {
  await database?.close()
}, 30_000)

describe('R10 — turn-up-automation / turn-down-automation', () => {
  it('an ads rule climbs OBSERVE → PROPOSE: the preview, the approved run, the audit row', async () => {
    expect((await up({ automation: 'A1', rowId: ids.raiser, level: 'PROPOSE' })).preview).toMatchObject({ action: 'turn-up-automation', from: 'OBSERVE', to: 'PROPOSE', brake: null, row: { name: 'TEST bid raiser' } })
    expect(await run('turn-up-automation', { automation: 'A1', rowId: ids.raiser, level: 'PROPOSE' })).toMatchObject({ ok: true, data: { level: 'PROPOSE' } })
    const audit = await inside(() => database.client.advertisingActionLog.findMany({ where: { entityId: ids.raiser } }))
    expect(audit.map((a) => [a.actionType, a.userId])).toEqual([['set_rule_autonomy', 'user:u-r10']])
  })

  it('AUTO only after the graduation gate (D-R1); by rule only when listed, its gate open and its own caps inside the limits (AA-W2-11)', async () => {
    const refused = await up({ automation: 'A1', rowId: ids.raiser, level: 'AUTO' })
    expect(refused.ok).toBe(false)
    expect(refused.error).toContain('TEST bid raiser: AUTO only after the graduation gate')
    expect(refused.error).toContain('0/14 days')
    // The gate opens: 20 days, 12 runs, 3 matches, a production connection with writes on, the live env.
    await inside(() => database.client.amazonAdsConnection.create({ data: { profileId: 'TEST-PROFILE-1', marketplace: 'IT', isActive: true, mode: 'production', writesEnabledAt: new Date() } as never }))
    process.env.NEXUS_AMAZON_ADS_MODE = 'live'
    const open = await up({ automation: 'A1', rowId: ids.graduate, level: 'AUTO' })
    expect(open.preview).toMatchObject({ from: 'PROPOSE', to: 'AUTO' })
    const tool = getTool('turn-up-automation')!
    // The preview carries the gate's evidence (the Control Room's eight checks) and the rule's own caps.
    expect(open.preview!.gate).toMatchObject({ open: true, caps: { maxWritesPerDay: null, maxValueCentsEur: null } })
    const defaults = tool.limits!.parse({}) as Record<string, unknown>
    expect(tool.withinLimits!(open.preview, defaults)).toBe('AUTO is above PROPOSE, the highest level allowed without a person')
    const auto = { ...defaults, maxLevel: 'AUTO' }
    expect(tool.withinLimits!(open.preview, auto)).toBe('Amazon ads rules is not on the automations Claude may take to AUTO without a person (automations): a person clicks it')
    const listed = { ...auto, automations: ['A1'], maxRuleWritesPerDay: 50, maxRuleValueCentsEur: 2000 }
    expect(tool.withinLimits!(open.preview, listed)).toContain('TEST graduate has no daily writes cap of its own')
    await inside(() => database.client.automationRule.update({ where: { id: ids.graduate }, data: { maxWritesPerDay: 40, maxValueCentsEur: 3000 } }))
    const capped = await up({ automation: 'ads-rules', rowId: ids.graduate, level: 'AUTO' })
    expect(tool.withinLimits!(capped.preview, listed)).toContain('TEST graduate may make up to 3000 euro cents in one run, more than the 2000')
    expect(tool.withinLimits!(capped.preview, { ...listed, maxRuleValueCentsEur: 3000 })).toBeNull()
    expect(tool.withinLimits!({ ...capped.preview, gate: { ...capped.preview!.gate, open: false, checks: [{ check: 'Rule has matched at least once', passed: false, detail: 'Zero matches' }] } }, { ...listed, maxRuleValueCentsEur: 3000 }))
      .toContain('the graduation gate of TEST graduate is not open (Rule has matched at least once: Zero matches')
    expect(tool.withinLimits!({ ...open.preview, to: 'PROPOSE' }, defaults)).toBeNull()
    expect(await run('turn-up-automation', { automation: 'A1', rowId: ids.graduate, level: 'AUTO' })).toMatchObject({ ok: true, data: { level: 'AUTO' } })
    expect(await inside(() => database.client.automationRule.findUniqueOrThrow({ where: { id: ids.graduate } }))).toMatchObject({ autonomyLevel: 'AUTO', dryRun: false })
  })

  it('a pausing rule stays under its graduation ceiling; eBay AUTO needs its own gate, and eBay has no OBSERVE', async () => {
    expect((await up({ automation: 'A1', rowId: ids.pauser, level: 'AUTO' })).error).toContain('Creates or destroys entities')
    expect((await up({ automation: 'E1', rowId: ids.ebay, level: 'AUTO' })).error).toContain('AUTO (AUTOPILOT) only after the graduation gate: 0/14 days watched, 0/10 real runs, no match yet.')
    expect((await down({ automation: 'E1', rowId: ids.ebay, level: 'OBSERVE' })).error).toBe('TEST eBay rule: eBay ads rules can be OFF, PROPOSE, AUTO — not OBSERVE.')
  })

  it('a brake turned down is outside the limits — a person decides; a non-brake is inside', async () => {
    const tool = getTool('turn-down-automation')!
    const brake = await down({ automation: 'A1', rowId: ids.lowerer, level: 'OFF' })
    expect(brake.preview).toMatchObject({ from: 'PROPOSE', to: 'OFF', brake: 'it holds spend down (bid_down): turning it down can raise spend' })
    expect(tool.withinLimits!(brake.preview, tool.limits!.parse({}))).toBe('turning a brake down can raise spend (it holds spend down (bid_down): turning it down can raise spend): a person decides')
    const schedule = await down({ automation: 'A6', rowId: ids.schedule, level: 'OFF' })
    // 2a — read from the release preview: nothing is floored on this campaign now, and the status is never touched.
    expect(schedule.preview!.brake).toBe("switched off, it floors no more bids in closed windows, and nothing it floored is floored now; placement percentages and the campaign's status stay as they are")
    const plain = await down({ automation: 'A1', rowId: ids.raiser, level: 'OFF' })
    expect(tool.withinLimits!(plain.preview, tool.limits!.parse({}))).toBeNull()
  })

  it('the ads dial moves, and its undo moves it back through the opposite tool', async () => {
    const out = await run('turn-down-automation', { automation: 'A3', level: 'OFF' })
    expect(out).toMatchObject({ ok: true, data: { from: 'PROPOSE', level: 'OFF' }, change: { before: { automation: 'ads-dial', rowId: null, level: 'PROPOSE' }, after: { level: 'OFF' } } })
    expect(await inside(() => database.client.adsAutomationState.findUniqueOrThrow({ where: { id: 'singleton' } }))).toMatchObject({ autonomy: 'OFF' })
    const tool = getTool('turn-down-automation')!
    expect(await inside(() => tool.undo!.current(out.change!))).toEqual(out.change!.after)
    const request = tool.undo!.request(out.change!)
    expect(request).toEqual({ tool: 'turn-up-automation', args: { automation: 'ads-dial', level: 'PROPOSE' } })
    expect(await run('turn-up-automation', (request as { args: Record<string, unknown> }).args)).toMatchObject({ ok: true, data: { level: 'PROPOSE' } })
    expect(await inside(() => database.client.adsAutomationState.findUniqueOrThrow({ where: { id: 'singleton' } }))).toMatchObject({ autonomy: 'SUGGEST' })
  })

  it('a pool, a schedule and a coverage set switch through their own writers', async () => {
    expect(await run('turn-up-automation', { automation: 'A9', rowId: ids.pool, level: 'AUTO' })).toMatchObject({ ok: true, data: { from: 'OBSERVE', level: 'AUTO' } })
    expect(await inside(() => database.client.budgetPool.findUniqueOrThrow({ where: { id: ids.pool } }))).toMatchObject({ enabled: true, dryRun: false })
    expect(await run('turn-down-automation', { automation: 'A6', rowId: ids.schedule, level: 'OFF' })).toMatchObject({ ok: true, data: { level: 'OFF' } })
    expect(await run('turn-up-automation', { automation: 'A12', rowId: ids.coverage, level: 'AUTO' })).toMatchObject({ ok: true, data: { level: 'AUTO' } })
  })

  it('a budget schedule switched off gives back the budget it holds, as the route does (W4)', async () => {
    mutation.updateCampaignWithSync.mockClear()
    expect(await run('turn-down-automation', { automation: 'A7', rowId: ids.budgetSchedule, level: 'OFF' })).toMatchObject({ ok: true, data: { level: 'OFF', note: 'gave back the base budget of 1 campaign(s)' } })
    expect(mutation.updateCampaignWithSync).toHaveBeenCalledTimes(1)
    expect(mutation.updateCampaignWithSync).toHaveBeenCalledWith(expect.objectContaining({ campaignId: ids.boosted, patch: { dailyBudget: 10 }, actor: `automation:budget-schedule-${ids.budgetSchedule}` }))
    const audit = await inside(() => database.client.advertisingActionLog.findMany({ where: { entityId: ids.budgetSchedule }, select: { actionType: true } }))
    expect(audit.map((row) => row.actionType).sort()).toEqual(['budget_schedule_update', 'set_automation_level'])
  })

  it('R16 — an engine\'s own switch: down for this business is inside the limits (a brake is not); up never past the env, never without a person; undo puts it back', async () => {
    // No row yet: the switch is open (the env alone decides). Turned down, this business's auto-bid stops at its next tick.
    const off = await down({ automation: 'A4', level: 'OFF' })
    expect(off.preview).toMatchObject({ action: 'turn-down-automation', row: { id: 'auto-bid', name: 'Auto-bid (this business\'s switch)' }, from: 'AUTO', to: 'OFF', brake: null, env: { ceiling: expect.any(String) } })
    expect(downLimits(off.preview)).toBeNull()
    const done = await run('turn-down-automation', { automation: 'A4', level: 'OFF' })
    expect(done).toMatchObject({ ok: true, data: { level: 'OFF' } })
    expect(await inside(() => database.client.automationSwitch.findFirst({ where: { key: 'auto-bid' }, select: { mode: true, setBy: true } }))).toEqual({ mode: 'OFF', setBy: 'user:u-r10' })
    // The catalog says so.
    const listed = (await dry('automation-detail', { automation: 'A4' })) as Out
    expect(JSON.stringify(listed)).toContain('"switch":{"key":"auto-bid","set":{"mode":"OFF"')

    // Up: only as far as the env allows, and never inside the limits.
    delete process.env.NEXUS_AMAZON_ADS_MODE
    const savedCron = process.env.NEXUS_ENABLE_AMAZON_ADS_CRON
    process.env.NEXUS_ENABLE_AMAZON_ADS_CRON = '0'
    expect((await up({ automation: 'A4', level: 'AUTO' })).error).toMatch(/^Auto-bid \(this business's switch\): the server env lets it go no higher than OFF/)
    if (savedCron === undefined) delete process.env.NEXUS_ENABLE_AMAZON_ADS_CRON
    else process.env.NEXUS_ENABLE_AMAZON_ADS_CRON = savedCron
    const back = tool('turn-down-automation').undo!.request(done.change!) as { tool: string; args: Record<string, unknown> }
    expect(back).toEqual({ tool: 'turn-up-automation', args: { automation: 'ads-auto-bid', level: 'AUTO' } })

    // Budget enforcement is a brake: turning it down needs a person.
    const brake = await down({ automation: 'A8', level: 'OBSERVE' })
    expect(brake.preview!.brake).toContain('it holds over-spending campaigns down')
    expect(downLimits(brake.preview)).toMatch(/^turning a brake down can raise spend/)
  })

  it('an env-only engine is refused, saying so; a wrong direction or level is refused; another business is not found', async () => {
    expect((await up({ automation: 'A5', rowId: 'tst-no-such-plan', level: 'AUTO' })).error).toContain('not found')
    expect((await up({ automation: 'A4', rowId: 'tst-any-row', level: 'AUTO' })).error).toBe('Auto-bid (the bid optimiser) switches as a whole: leave rowId out (its rows are set in Nexus).')
    expect((await up({ automation: 'A1', rowId: ids.lowerer, level: 'OBSERVE' })).error).toBe('TEST bid lowerer is PROPOSE: OBSERVE is down — use turn-down-automation.')
    expect((await up({ automation: 'A1', rowId: 'tst-r10-other', level: 'PROPOSE' })).error).toBe('Amazon ads rules has no row tst-r10-other in this business (not found).')
  })
})

/**
 * AA-W2-11 — the graduation gate of the automations that had none Claude's rule could read: an autopilot plan's decided
 * proposals, a pool's rebalances, a classic dayparting schedule's writes while it was on, the coverage engine's records
 * for a set. A person's own click is not held by them. The ads dial has no gate: its AUTO stays a person's click.
 */
describe('AA-W2-11 — gate evidence for plans, pools, schedules and coverage sets', () => {
  const tool = () => getTool('turn-up-automation')!
  const listed = (key: string) => ({ ...(tool().limits!.parse({}) as Record<string, unknown>), maxLevel: 'AUTO', automations: [key] })
  const old = () => new Date(Date.now() - 20 * DAY)

  it('a budget pool: closed until it has rebalanced 10 times over 14 days, once moving budget; then inside when listed', async () => {
    const pool = (await inside(() => database.client.budgetPool.create({ data: { name: 'TEST observed pool', totalDailyBudgetCents: 4000, enabled: true, dryRun: true, allocations: { create: [{ marketplace: 'IT', campaignId: ids.boosted, targetSharePct: 1, minDailyBudgetCents: 100 }] } } }))).id
    const closed = await up({ automation: 'A9', rowId: pool, level: 'AUTO' })
    expect(closed.preview!.gate).toMatchObject({ open: false, from: "the pool's rebalances (BudgetPoolRebalance)" })
    expect(closed.preview!.gate.checks.map((c: { detail: string }) => c.detail)).toEqual(['0/14 days since it was made', '0/10 rebalances (dry runs included)', '0 that would move budget'])
    expect(tool().withinLimits!(closed.preview, listed('A9'))).toContain('the graduation gate of TEST observed pool is not open')
    await inside(async () => {
      const db = database.client
      await db.budgetPool.update({ where: { id: pool }, data: { createdAt: old() } })
      for (let i = 0; i < 10; i++) await db.budgetPoolRebalance.create({ data: { budgetPoolId: pool, triggeredBy: 'test', inputs: {}, outputs: {}, dryRun: true, totalShiftCents: i === 0 ? 300 : 0 } })
    })
    const open = await up({ automation: 'A9', rowId: pool, level: 'AUTO' })
    expect(open.preview!.gate).toMatchObject({ open: true })
    expect(tool().withinLimits!(open.preview, listed('ads-budget-pools'))).toBeNull()
    expect(tool().withinLimits!(open.preview, listed('A12'))).toContain('is not on the automations Claude may take to AUTO')
  })

  it('an autopilot plan counts its decided proposals; a dayparting schedule its writes while on; a coverage set the engine\'s records', async () => {
    const plan = await inside(() => database.client.autopilotPlan.create({ data: { name: 'TEST plan', marketplace: 'IT', autonomy: 'SUGGEST', createdAt: old() } }))
    await inside(async () => {
      for (let i = 0; i < 10; i++) await database.client.autopilotDecision.create({ data: { planId: plan.id, cycle: 'slow', module: 'bid', action: 'BID_LOWER', reason: 'TEST', status: i < 2 ? 'APPLIED' : 'SKIPPED' } })
      await database.client.autopilotDecision.create({ data: { planId: plan.id, cycle: 'fast', module: 'bid', action: 'BID_RAISE', reason: 'TEST waiting', status: 'PROPOSED' } })
    })
    const autopilot = await up({ automation: 'A5', rowId: plan.id, level: 'AUTO' })
    expect(autopilot.preview!.gate).toMatchObject({ open: true, checks: [{ passed: true }, { detail: '10/10 decisions with an outcome' }, { detail: '2 applied' }] })

    const schedule = await inside(() => database.client.adSchedule.create({ data: { campaignId: ids.boosted, name: 'TEST off schedule', windows: [{ days: [1], startHour: 0, endHour: 6 }], enabled: false, createdAt: old() } }))
    const daypartingClosed = await up({ automation: 'A6', rowId: schedule.id, level: 'AUTO' })
    expect(daypartingClosed.preview!.gate).toMatchObject({ open: false, checks: [{ passed: true }, { detail: '0/10 writes' }, { detail: '0 writes' }] })
    await inside(async () => {
      for (let i = 0; i < 10; i++) await database.client.advertisingActionLog.create({ data: { userId: `automation:dayparting-${schedule.id}`, actionType: 'AD_BID_UPDATE', entityType: 'AD_TARGET', entityId: `TEST-T-${i}`, payloadBefore: {}, payloadAfter: {}, amazonResponseStatus: 'SUCCESS' } })
    })
    expect((await up({ automation: 'A6', rowId: schedule.id, level: 'AUTO' })).preview!.gate).toMatchObject({ open: true })

    const set = (await inside(() => database.client.keywordCoverageSet.create({ data: { name: 'TEST observed coverage', portfolioId: 'TEST-PORTFOLIO-2', marketplace: 'IT', enabled: false } }))).id
    const coverage = await up({ automation: 'A12', rowId: set, level: 'AUTO' })
    expect(coverage.preview!.gate).toMatchObject({ open: false, from: "the coverage engine's records for the set's terms (a would-do in observe mode, a bid in auto)" })
  })

  it('the ads dial has no gate Nexus can check: AUTO stays a person\'s click, listed or not', async () => {
    const dial = await up({ automation: 'A3', level: 'AUTO' })
    expect(dial.ok).toBe(true)
    expect(dial.preview!.gate).toBeNull()
    expect(tool().withinLimits!(dial.preview, listed('A3'))).toBe("Ads dial, halt and anomaly breaker reaches the whole account, so Nexus cannot tell which market's ads strategy covers it; a person decides")
    expect(tool().withinLimits!({ ...dial.preview, automationScope: { placed: true, outside: false, why: null } }, listed('A3'))).toBe("The account ads dial has no graduation gate Nexus can check (Ads dial, halt and anomaly breaker), so AUTO stays a person's click")
  })

  it('the ads strategy\'s `automation` kind narrows a move where the automation acts, at the door and in the limits', async () => {
    const { strategyLevelFor } = await import('../../advertising/ads-strategy/claude.js')
    const rule = await inside(() => database.client.automationRule.create({ data: { domain: 'advertising', name: 'TEST IT rule', trigger: 'KEYWORD_HIGH_ACOS', enabled: true, autonomyLevel: 'OBSERVE', scopeMarketplace: 'IT', conditions: [{ field: 'adTarget.acos', op: 'gt', value: 0.5 }], actions: [{ type: 'bid_down', percent: 5 }] } as never }))
    const args = { automation: 'A1', rowId: rule.id, level: 'PROPOSE' }
    expect(await inside(() => strategyLevelFor('turn-up-automation', args))).toBeNull() // no row speaks to the kind yet
    await inside(() => database.client.adsStrategy.update({ where: { id: ids.strategy }, data: { claudeAutonomy: { automation: 'ask' } } }))
    expect(await inside(() => strategyLevelFor('turn-up-automation', args))).toMatchObject({ action: 'automation', level: 'ask', market: 'IT', basis: 'market' })
    const preview = (await up(args)).preview
    expect(preview).toMatchObject({ automationScope: { placed: true }, limitFacts: { action: 'automation', this: { markets: ['IT'] } } })
    expect(tool().withinLimits!(preview, listed('A1'))).toContain('the ads strategy lets Claude only ask for turning ads automations up and tuning their settings')
    // A pool's move lands on its campaign; tune-ad-engine of the same pool is the same kind.
    const campaign = await inside(() => database.client.campaign.create({ data: { name: 'TEST POOLED', type: 'SP', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), marketplace: 'IT', externalCampaignId: 'TEST-CMP-9' } }))
    const pool = (await inside(() => database.client.budgetPool.create({ data: { name: 'TEST strategy pool', totalDailyBudgetCents: 4000, enabled: false, allocations: { create: [{ marketplace: 'IT', campaignId: campaign.id, targetSharePct: 1, minDailyBudgetCents: 100 }] } } }))).id
    expect(await inside(() => strategyLevelFor('tune-ad-engine', { setting: 'budget-pool', subjectId: pool, budgetPool: { totalDailyBudgetCents: 3000 } }))).toMatchObject({ action: 'automation', level: 'ask' })
    await inside(() => database.client.adsStrategy.update({ where: { id: ids.strategy }, data: { claudeAutonomy: {} } }))
  })
})

/**
 * W4-12b — an Amazon ads BUILDER rule carries a Manual/Automate setting (`actions[0].control`); on Manual the engine runs
 * it as a dry run whatever its level (automation-rule.service.ts EA3). The Rules screen flips it with the level when a
 * person sets Auto (RulesGrid.tsx setAutomation); turn-up-automation did not, so a builder rule Claude raised to AUTO
 * kept only proposing. Now the level tools move it the same way, through the rule drawer's own save and audit.
 */
describe('W4-12b — a builder rule\'s Manual/Automate setting moves with AUTO', () => {
  const control = async (id: string) => {
    const r = await inside(() => database.client.automationRule.findUniqueOrThrow({ where: { id }, select: { autonomyLevel: true, dryRun: true, actions: true } }))
    return { level: r.autonomyLevel, dryRun: r.dryRun, control: (r.actions as Array<{ control?: string }>)[0]?.control }
  }

  it('raised to AUTO it goes to Automate (said on the preview, audited as the drawer\'s save); turned down, back to Manual; the undo is that move', async () => {
    process.env.NEXUS_AMAZON_ADS_MODE = 'live'
    const rule = await inside(async () => {
      const db = database.client
      // The gate's live production connection (the graduation test above may have made it already).
      if (!(await db.amazonAdsConnection.findFirst({ where: { marketplace: 'IT', mode: 'production' } }))) {
        await db.amazonAdsConnection.create({ data: { profileId: 'TEST-PROFILE-1', marketplace: 'IT', isActive: true, mode: 'production', writesEnabledAt: new Date() } as never })
      }
      const campaign = await db.campaign.create({ data: { name: 'TEST BUILDER PICK', type: 'SP', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), marketplace: 'IT', externalCampaignId: 'TEST-CMP-B1' } })
      // Watched 20 days, 12 real runs, 3 matches: the graduation gate is open. Its bids go up 10 % when ACoS is under 20 %.
      return db.automationRule.create({ data: {
        domain: 'advertising', name: 'TEST builder bids', trigger: 'TARGET_PERFORMANCE', enabled: true, autonomyLevel: 'PROPOSE', dryRun: true,
        scopeMarketplace: 'IT', createdAt: new Date(Date.now() - 20 * DAY), evaluationCount: 12, matchCount: 3,
        conditions: [{ conditions: [{ metric: 'ACOS', op: 'lt', value: '20' }], action: { op: 'incPct', value: '10' } }],
        actions: [{ type: 'bid', control: 'manual', campaigns: [{ id: campaign.id, name: 'TEST BUILDER PICK' }] }],
      } as never })
    })

    const asked = await up({ automation: 'A1', rowId: rule.id, level: 'AUTO' })
    expect(asked.preview).toMatchObject({ from: 'PROPOSE', to: 'AUTO', changes: { level: { from: 'PROPOSE', to: 'AUTO' }, control: { from: 'manual', to: 'automate' } } })
    expect(asked.preview!.effect).toContain('Its Manual/Automate setting goes from Manual to Automate with it')

    const raised = await run('turn-up-automation', { automation: 'A1', rowId: rule.id, level: 'AUTO' })
    expect(raised).toMatchObject({ ok: true, data: { from: 'PROPOSE', level: 'AUTO' } })
    // Before W4-12b: AUTO with a Manual setting — a dry run on every tick, proposing only.
    expect(await control(rule.id)).toEqual({ level: 'AUTO', dryRun: false, control: 'automate' })
    const { automationAdapter } = await import('../../automation/automation-catalog.service.js')
    const board = await inside(() => automationAdapter('A1')!.rows!())
    expect(board.find((r) => r.id === rule.id)).toMatchObject({ level: 'AUTO', runsAs: 'AUTO' })
    // The same two audit rows as the screen's: the drawer's save (actions) and the level.
    const audit = await inside(() => database.client.advertisingActionLog.findMany({ where: { entityId: rule.id }, orderBy: { createdAt: 'asc' }, select: { actionType: true, userId: true } }))
    expect(audit).toEqual([{ actionType: 'update_rule', userId: 'user:u-r10' }, { actionType: 'set_rule_autonomy', userId: 'user:u-r10' }])

    // The undo of the raise is turn-down-automation to PROPOSE, which puts the setting back to Manual.
    const back = getTool('turn-up-automation')!.undo!.request(raised.change!) as { tool: string; args: Record<string, unknown> }
    expect(back).toEqual({ tool: 'turn-down-automation', args: { automation: 'ads-rules', rowId: rule.id, level: 'PROPOSE' } })
    const lowered = await down(back.args)
    expect(lowered.preview).toMatchObject({ changes: { control: { from: 'automate', to: 'manual' } } })
    expect(lowered.preview!.effect).toContain('Its Manual/Automate setting goes back from Automate to Manual')
    expect(await run('turn-down-automation', back.args)).toMatchObject({ ok: true, data: { level: 'PROPOSE' } })
    expect(await control(rule.id)).toEqual({ level: 'PROPOSE', dryRun: true, control: 'manual' })
  })

  it('a move below AUTO, or a rule with no Manual setting, changes no setting', async () => {
    const below = await inside(() => database.client.automationRule.create({ data: {
      domain: 'advertising', name: 'TEST builder observed', trigger: 'TARGET_PERFORMANCE', enabled: true, autonomyLevel: 'OBSERVE',
      conditions: [{ conditions: [{ metric: 'ACOS', op: 'lt', value: '20' }], action: { op: 'incPct', value: '10' } }],
      actions: [{ type: 'bid', control: 'manual', campaigns: [] }],
    } as never }))
    const propose = await up({ automation: 'A1', rowId: below.id, level: 'PROPOSE' })
    expect(propose.preview).toMatchObject({ changes: { level: { from: 'OBSERVE', to: 'PROPOSE' } } })
    expect(propose.preview!.changes.control).toBeUndefined()
    // TEST graduate went to AUTO above with no setting at all: turned down, none is added.
    const plain = await down({ automation: 'A1', rowId: ids.graduate, level: 'PROPOSE' })
    expect(plain.preview).toMatchObject({ from: 'AUTO', to: 'PROPOSE' })
    expect(plain.preview!.changes.control).toBeUndefined()
  })

  it('a rule a person set to Automate keeps it when Claude turns it down from AUTO: only a level move\'s Automate goes back', async () => {
    process.env.NEXUS_AMAZON_ADS_MODE = 'live'
    const rule = await inside(() => database.client.automationRule.create({ data: {
      domain: 'advertising', name: 'TEST builder chosen automate', trigger: 'TARGET_PERFORMANCE', enabled: true, autonomyLevel: 'PROPOSE', dryRun: true,
      scopeMarketplace: 'IT', createdAt: new Date(Date.now() - 20 * DAY), evaluationCount: 12, matchCount: 3,
      conditions: [{ conditions: [{ metric: 'ACOS', op: 'lt', value: '20' }], action: { op: 'incPct', value: '10' } }],
      actions: [{ type: 'bid', control: 'automate', campaigns: [] }],
    } as never }))
    const raise = await up({ automation: 'A1', rowId: rule.id, level: 'AUTO' })
    expect(raise.preview!.changes.control).toBeUndefined()
    expect(await run('turn-up-automation', { automation: 'A1', rowId: rule.id, level: 'AUTO' })).toMatchObject({ ok: true, data: { level: 'AUTO' } })
    const lower = await down({ automation: 'A1', rowId: rule.id, level: 'PROPOSE' })
    // Before the review: "goes back from Automate to Manual", although it was never Manual.
    expect(lower.preview!.changes.control).toBeUndefined()
    expect(await run('turn-down-automation', { automation: 'A1', rowId: rule.id, level: 'PROPOSE' })).toMatchObject({ ok: true, data: { level: 'PROPOSE' } })
    expect(await control(rule.id)).toEqual({ level: 'PROPOSE', dryRun: true, control: 'automate' })
  })

  it('an engine-shaped rule set to Manual moves too: the engine reads the same setting on every ads rule', async () => {
    process.env.NEXUS_AMAZON_ADS_MODE = 'live'
    const rule = await inside(() => database.client.automationRule.create({ data: {
      domain: 'advertising', name: 'TEST engine manual', trigger: 'KEYWORD_HIGH_ACOS', enabled: true, autonomyLevel: 'PROPOSE', scopeMarketplace: 'IT',
      createdAt: new Date(Date.now() - 20 * DAY), evaluationCount: 12, matchCount: 3,
      conditions: [{ field: 'adTarget.acos', op: 'gt', value: 0.5 }], actions: [{ type: 'bid_up', percent: 5, control: 'manual' }],
    } as never }))
    expect((await up({ automation: 'A1', rowId: rule.id, level: 'AUTO' })).preview).toMatchObject({ changes: { control: { from: 'manual', to: 'automate' } } })
    expect(await run('turn-up-automation', { automation: 'A1', rowId: rule.id, level: 'AUTO' })).toMatchObject({ ok: true, data: { level: 'AUTO' } })
    expect(await control(rule.id)).toEqual({ level: 'AUTO', dryRun: false, control: 'automate' })
  })
})
