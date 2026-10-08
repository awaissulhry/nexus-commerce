/**
 * R7 (MCP full control, part 06) — what an automation did: runs, writes matched by its EXACT actor, refusals, and the
 * plain verdicts ("never written", "capped", "not running", "no runs").
 *
 * On a real PostgreSQL (PGlite, production schema). The writes are seeded under look-alike actors on purpose: a
 * sibling rule whose id extends this one's, another engine whose actor contains this rule's id, a person on the same
 * campaign. Only the rule's own actors may count.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
// No Redis in this test: nothing here queues.
vi.mock('../../lib/queue.js', () => {
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

import { automationAdapter, explainAutomation, verdictsOf } from './automation-explain.service.js'
import { callTool, type UserPrincipal } from '../agents/call-tool.js'

const A = LEGACY_WORKSPACE_ID
const OTHER = 'ws_r7_other'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const everything: UserPrincipal = {
  kind: 'user', userId: 'u-r7', label: 'R7 test', permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
  workspace: business(A), via: 'claude',
}

const saved = { cron: process.env.NEXUS_ENABLE_AMAZON_ADS_CRON, mode: process.env.NEXUS_AMAZON_ADS_MODE }
const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY)

const explain = (automation: string, rowId?: string, days = 7) => inside(() => explainAutomation(automationAdapter(automation)!, { rowId, days }))

beforeAll(async () => {
  database = await formulaDatabase()
  process.env.NEXUS_ENABLE_AMAZON_ADS_CRON = '1'
  process.env.NEXUS_AMAZON_ADS_MODE = 'live'
  const db = database.client
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`, [OTHER])
  await inside(async () => {
    await db.adsAutomationState.create({ data: { id: 'singleton', autonomy: 'AUTO' } })
    const rule = (id: string, data: Record<string, unknown> = {}) => db.automationRule.create({
      data: { id, domain: 'advertising', name: `TEST ${id}`, trigger: 'SCHEDULE', enabled: true, dryRun: false, autonomyLevel: 'AUTO', ...data } as never,
    })
    await rule('tst-abc')
    await rule('tst-abcd')
    await rule('tst-idle')
    await rule('tst-capped', { autonomyLevel: 'PROPOSE', dryRun: true })
    await rule('tst-off', { enabled: false })
    const run = (ruleId: string, startedAt: Date, status = 'SUCCESS', errorMessage: string | null = null) =>
      db.automationRuleExecution.create({ data: { ruleId, triggerData: {}, actionResults: [], dryRun: status === 'DRY_RUN', status, startedAt, errorMessage } })
    for (let i = 0; i < 3; i++) await run('tst-abc', ago(1))
    await run('tst-abc', ago(10))
    for (let i = 0; i < 4; i++) await run('tst-idle', ago(2))
    await run('tst-capped', ago(1), 'DRY_RUN')
    await run('tst-capped', ago(1), 'DRY_RUN', 'WRITE_CAP_REACHED')
    const log = (userId: string | null, actionType: string, createdAt: Date, entityId = 'cmp-1') => db.advertisingActionLog.create({
      data: { userId, actionType, entityType: 'CAMPAIGN', entityId, payloadBefore: {}, payloadAfter: {}, amazonResponseStatus: 'SUCCESS', createdAt },
    })
    await log('automation:tst-abc', 'bid_down', ago(1))
    await log('automation:tst-abc', 'bid_down', ago(2))
    await log('automation:tst-abc', 'bid_down', ago(20))
    // Its placement actions write as automation:rule-<ruleId>.
    await log('automation:rule-tst-abc', 'placement_apply', ago(1))
    // Look-alikes: a sibling whose id extends this one's, another engine whose actor holds this id, a person.
    await log('automation:tst-abcd', 'bid_up', ago(1))
    await log('automation:rank-defend-tst-abc', 'set_placement', ago(1))
    await log('user:someone', 'bid_down', ago(1))
    await log('automation:auto-bid', 'bid_down', ago(1))
    await log('automation:auto-bid', 'bid_up', ago(3))
    await log('automation:auto-bidder', 'bid_up', ago(1))
    const today = new Date().toISOString().slice(0, 10)
    await db.automationRefusalDaily.create({ data: { actorKind: 'rule', actorId: 'tst-capped', dayUtc: today, reason: 'DAILY_CAP_EXCEEDED', count: 5, lastAt: ago(0), lastReason: 'cap of 2 reached' } })
    await db.automationRefusalDaily.create({ data: { actorKind: 'rule', actorId: 'tst-capped', dayUtc: today, reason: 'VALUE_CAP_EXCEEDED', count: 2, lastAt: ago(0), lastReason: 'value cap 0' } })
  })
  await inside(() => db.automationRule.create({ data: { id: 'tst-other', domain: 'advertising', name: 'TEST other business', trigger: 'SCHEDULE' } }), OTHER)
}, 180_000)

afterAll(async () => {
  for (const [k, v] of [['NEXUS_ENABLE_AMAZON_ADS_CRON', saved.cron], ['NEXUS_AMAZON_ADS_MODE', saved.mode]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await database?.close()
}, 30_000)
afterEach(() => vi.useRealTimers())

describe('R7 — what an automation wrote, by its exact actor', () => {
  it("a rule's writes are its own actors only: not a sibling's, not another engine's, not a person's", async () => {
    const out = (await explain('A1', 'tst-abc'))!
    expect(out.row).toEqual({ id: 'tst-abc', name: 'TEST tst-abc', level: 'AUTO' })
    expect(out.writes).toMatchObject({
      actors: ['automation:tst-abc', 'automation:rule-tst-abc'],
      total: 3, byAction: { bid_down: 2, placement_apply: 1 }, everWritten: true,
    })
    // The 20-day-old write is outside the window but counts for "has it ever written".
    expect(out.writes!.last).toHaveLength(3)
    expect(out.runs).toMatchObject({ source: 'AutomationRuleExecution', total: 3, byStatus: { SUCCESS: 3 } })
    expect(out.verdicts.map((v) => v.code)).toEqual(['acting'])

    const sibling = (await explain('A1', 'tst-abcd'))!
    expect(sibling.writes).toMatchObject({ total: 1, byAction: { bid_up: 1 } })

    // The whole automation: every rule's own writes (3 + 1), none of the look-alikes.
    const all = (await explain('A1'))!
    expect(all.writes!.total).toBe(4)
    expect(all.row).toBeNull()
  })

  it('an engine by its fixed actor: auto-bid counts automation:auto-bid, never automation:auto-bidder', async () => {
    const out = (await explain('A4'))!
    expect(out.writes).toMatchObject({ actors: ['automation:auto-bid'], total: 2, byAction: { bid_down: 1, bid_up: 1 } })
    // It keeps its runs as CronRun rows; none in this business: it says so.
    expect(out.runs).toMatchObject({ source: 'CronRun (ads-auto-bid)', total: 0 })
    expect(out.verdicts.map((v) => v.code)).toContain('no-runs')
  })

  it('"never written": a rule that ran at AUTO and has never written anything says so', async () => {
    const out = (await explain('A1', 'tst-idle'))!
    expect(out.writes).toMatchObject({ total: 0, everWritten: false, lastEverAt: null })
    const verdict = out.verdicts.find((v) => v.code === 'never-written')
    expect(verdict?.says).toContain('never written anything, though it ran 4 times in 7 days — at AUTO')
  })

  it('"capped": its own caps, from the refusal record and the capped runs, said apart from failures', async () => {
    const out = (await explain('A1', 'tst-capped'))!
    expect(out.refusals).toMatchObject({ total: 7, byReason: { DAILY_CAP_EXCEEDED: 5, VALUE_CAP_EXCEEDED: 2 }, lastReason: expect.any(String) })
    expect(out.runs).toMatchObject({ total: 2, capped: 1 })
    const capped = out.verdicts.find((v) => v.code === 'capped')
    expect(capped?.says).toContain('Its own caps stopped it 8 times in 7 days (DAILY_CAP_EXCEEDED 5, VALUE_CAP_EXCEEDED 2)')
    expect(out.verdicts.map((v) => v.code)).not.toContain('failing')
  })

  it('"not running": a rule switched off says it is OFF', async () => {
    const out = (await explain('A1', 'tst-off'))!
    expect(out.verdicts[0]).toEqual({ code: 'not-running', says: 'It is OFF: this one is switched off.' })
  })

  it('through the tool: another business\'s rule is not found, and the window is bounded', async () => {
    const call = async (args: Record<string, unknown>) => (await callTool(everything, 'automation-activity', args)).visible
    expect(await call({ automation: 'A1', rowId: 'tst-other' })).toEqual({ ok: false, error: 'Amazon ads rules has no row tst-other in this business (not found).' })
    const own = await call({ automation: 'ads-rules', rowId: 'tst-abc', days: 30 }) as { ok: boolean; data: { writes: { total: number }; window: { days: number } } }
    // 30 days back takes in the 20-day-old write too.
    expect(own.data.writes.total).toBe(4)
    expect(own.data.window.days).toBe(30)
    await expect(callTool(everything, 'automation-activity', { automation: 'A1', days: 31 })).rejects.toMatchObject({ code: 'invalid_arguments' })
  })

  it('verdictsOf is pure and says nothing it cannot back: no writes record, no write verdict', () => {
    expect(verdictsOf('AUTO', 'x', { subject: null, runs: { source: 'CronRun (x)', total: 5, byStatus: { FAILED: 2, SUCCESS: 3 }, last: [] }, writes: null, refusals: null }, 7))
      .toEqual([{ code: 'failing', says: '2 of its 5 runs failed in 7 days.' }])
  })

  it('ONE BRAIN AB-6 — writes left to a product\'s brain are said per lever, apart from the caps and the refusals: not a failure', () => {
    const refusals = { total: 6, byReason: { 'LEVER_HELD:budgets': 3, 'LEVER_HELD:state': 1, DAILY_CAP_EXCEEDED: 2 }, lastAt: null, lastReason: null }
    expect(verdictsOf('AUTO', 'x', { subject: null, runs: null, writes: null, refusals }, 7)).toEqual([
      { code: 'capped', says: 'Its own caps stopped it 2 times in 7 days (DAILY_CAP_EXCEEDED 2): the cap, not the rule, decides how much it reaches.' },
      { code: 'lever-held', says: 'It left 4 writes alone in 7 days on levers a product\'s brain owns or the Owner holds at his own value (budgets 3, state 1): one owner per lever, not a failure.' },
    ])
  })
})
