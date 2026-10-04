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
    ids.graduate = (await rule('TEST graduate', [{ type: 'bid_up', percent: 5 }], { autonomyLevel: 'PROPOSE', createdAt: new Date(Date.now() - 20 * DAY), evaluationCount: 12, matchCount: 3 })).id
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

  it('AUTO only after the graduation gate (D-R1), and never inside the limits', async () => {
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
    expect(tool.withinLimits!(open.preview, tool.limits!.parse({}))).toBe('AUTO is never inside the limits: after the graduation gate, a person clicks it')
    expect(tool.withinLimits!({ to: 'PROPOSE' }, tool.limits!.parse({}))).toBeNull()
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
