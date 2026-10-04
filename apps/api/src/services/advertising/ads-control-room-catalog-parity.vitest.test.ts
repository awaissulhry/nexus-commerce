/**
 * 7a (review 8.1, 8.2, 8.3) — the Control Room's engines and the automation catalog (MCP list-automations) are one
 * reading, on a real PostgreSQL with the production schema (PGlite).
 *
 *   8.1  Classic dayparting read AUTO with no schedule, budget enforcement AUTO with no plan, pools AUTO when any pool
 *        existed; the catalog said OFF. The board now takes each engine's env and own rows from the catalog: an engine
 *        allowed to act with nothing set up is "ready", and only an engine with something to act on "acts".
 *   8.2  "Writing to Amazon" counted every engine on Auto, the breaker and write delivery included. Neither changes
 *        Amazon by itself (`writesOnOwn: false`, group "never").
 *   8.3  Autopilot plans and budget schedules write and had no row.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
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

import { engineExposure, getEngineLevers, type EngineLever } from './ads-control-room.service.js'
import { getAutomationCatalog } from '../automation/automation-catalog.service.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const KEYS = [
  'NEXUS_ENABLE_AMAZON_ADS_CRON', 'NEXUS_AMAZON_ADS_MODE', 'NEXUS_ADS_AUTOMATION_KILL', 'NEXUS_BUDGET_ENFORCE_APPLY',
  'NEXUS_ENABLE_RANK_DEFEND', 'NEXUS_ENABLE_TOS_DEFENSE_CRON', 'NEXUS_COVERAGE_ENGINE_MODE', 'NEXUS_ENABLE_FLEET_SWEEP_CRON',
] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
const set = (values: Partial<Record<(typeof KEYS)[number], string>>) => {
  for (const k of KEYS) delete process.env[k]
  Object.assign(process.env, values)
}
/** Today's live env (2026-10-04): the ads crons on and live, enforcement and the hourly plans armed, ToS off, coverage in observe. */
const LIVE_TODAY = {
  NEXUS_ENABLE_AMAZON_ADS_CRON: '1', NEXUS_AMAZON_ADS_MODE: 'live', NEXUS_BUDGET_ENFORCE_APPLY: '1', NEXUS_ENABLE_RANK_DEFEND: '1',
} as const

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(() => database.client.adsAutomationState.create({ data: { id: 'singleton', autonomy: 'AUTO' } }))
}, 180_000)
afterEach(async () => {
  set(saved as never)
  await inside(async () => {
    await database.client.adBudgetPlan.deleteMany({})
    await database.client.budgetPool.deleteMany({})
    await database.client.advertisingActionLog.deleteMany({})
    await database.client.cronRun.deleteMany({})
  })
})
afterAll(async () => {
  set(saved as never)
  await database?.close()
}, 30_000)

const board = async () => {
  const { levers } = await inside(() => getEngineLevers())
  return new Map(levers.map((l) => [l.key, l]))
}
const catalog = async () => new Map((await inside(() => getAutomationCatalog())).map((e) => [e.id as string, e]))
const groups = (levers: Map<string, EngineLever>) => Object.fromEntries([...levers.values()].map((l) => [l.key, l.exposure.group]))

describe('7a — the levers and the automation catalog are one reading', () => {
  it("THE FINDING (8.1, 8.2): with today's env and nothing set up, only the engines with something to act on change Amazon", async () => {
    set(LIVE_TODAY)
    const levers = await board()
    expect(groups(levers)).toEqual({
      'rank-defend': 'ready', dayparting: 'ready', 'budget-enforce': 'ready', 'budget-schedules': 'ready', 'budget-pools': 'ready',
      'auto-bid': 'acts', autopilot: 'ready', 'anomaly-guard': 'never', 'tos-defense': 'server-off', 'write-delivery': 'never',
      'coverage-engine': 'server-off', 'structural-reconcile': 'never', 'fleet-analysts': 'server-off',
    })
    // Nothing vanishes: every engine is still on the board, on the mode the env, the switch and the dial allow.
    expect(levers.get('dayparting')).toMatchObject({ mode: 'AUTO', modeReason: expect.stringContaining('No classic dayparting schedules'), exposure: { label: 'Ready — nothing set up', start: expect.stringContaining('classic dayparting schedule') } })
    expect(levers.get('budget-enforce')).toMatchObject({ mode: 'AUTO', modeReason: expect.stringContaining('No budget plan for this month'), scope: 'No budget plans for this month' })
    expect(levers.get('anomaly-guard')).toMatchObject({ mode: 'AUTO', writesOnOwn: false, exposure: { label: 'Always on — never changes Amazon by itself' } })
    expect(levers.get('write-delivery')).toMatchObject({ mode: 'AUTO', writesOnOwn: false })
    expect(levers.get('tos-defense')).toMatchObject({ mode: 'OFF', modeReason: expect.stringContaining('NEXUS_ENABLE_TOS_DEFENSE_CRON') })
    expect(levers.get('coverage-engine')).toMatchObject({ mode: 'OBSERVE', modeReason: expect.stringContaining('NEXUS_COVERAGE_ENGINE_MODE is observe') })
    // The old name reads as the catalog names it.
    expect(levers.get('rank-defend')!.name).toBe('Hourly bid plans')
  })

  it('every engine the catalog describes has the env ceiling the catalog reads, and "acts" exactly where the catalog says AUTO', async () => {
    set({ ...LIVE_TODAY, NEXUS_ENABLE_TOS_DEFENSE_CRON: '1', NEXUS_COVERAGE_ENGINE_MODE: 'auto' })
    await inside(() => database.client.adBudgetPlan.create({ data: { marketplace: 'IT', month: new Date().toISOString().slice(0, 7), monthlyBudgetCents: 100_000, autoPacing: true } }))
    await inside(() => database.client.budgetPool.create({ data: { name: 'Dry pool', totalDailyBudgetCents: 5_000, enabled: true, dryRun: true } }))
    const [levers, entries] = await Promise.all([board(), catalog()])
    const checked: string[] = []
    for (const lever of levers.values()) {
      if (!lever.catalogId || lever.catalogId === 'A3') continue
      const entry = entries.get(lever.catalogId)!
      expect(lever.control.env.mode, lever.key).toBe(entry.env.ceiling)
      expect(lever.exposure.group === 'acts', `${lever.key} acts ⇔ ${lever.catalogId} is AUTO`).toBe(entry.level === 'AUTO')
      checked.push(lever.catalogId)
    }
    expect(checked.sort()).toEqual(['A10', 'A11', 'A12', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9'])
    // A plan this month with pacing on: enforcement has something to act on. A pool in dry run: switched on to nothing.
    expect(levers.get('budget-enforce')).toMatchObject({ exposure: { group: 'acts', label: 'Changes Amazon on its own' }, scope: '1 of 1 budget plans for this month switched on' })
    expect(levers.get('budget-pools')).toMatchObject({ mode: 'AUTO', exposure: { group: 'ready', label: 'Ready — nothing switched on' } })
    expect(entries.get('A9')!.level).toBe('OBSERVE')
  })

  it('the dial, a halt and the kill switch hold engines back, and the breaker keeps watching', async () => {
    set(LIVE_TODAY)
    const dial = (data: Record<string, unknown>) => inside(() => database.client.adsAutomationState.update({ where: { id: 'singleton' }, data }))
    try {
      await dial({ autonomy: 'SUGGEST' })
      let levers = await board()
      expect(levers.get('auto-bid')).toMatchObject({ mode: 'PROPOSE', exposure: { group: 'held', label: 'Held back in Nexus' } })
      // Write delivery still sends what people approved: it never changes Amazon by itself.
      expect(levers.get('write-delivery')!.exposure.group).toBe('never')
      await dial({ autonomy: 'AUTO', halted: true, haltReason: 'TEST halt' })
      levers = await board()
      expect(levers.get('auto-bid')).toMatchObject({ mode: 'OFF', exposure: { group: 'held' } })
      expect(levers.get('write-delivery')!.exposure.group).toBe('held')
      expect(levers.get('anomaly-guard')).toMatchObject({ mode: 'AUTO', exposure: { group: 'never' } })
    } finally {
      await dial({ autonomy: 'AUTO', halted: false, haltReason: null })
    }
    set({ ...LIVE_TODAY, NEXUS_ADS_AUTOMATION_KILL: '1' })
    expect((await board()).get('auto-bid')!.exposure.group).toBe('server-off')
  })

  it('8.3 — autopilot and budget-schedule writes land on their own rows, with the activity of the last 7 days', async () => {
    set(LIVE_TODAY)
    await inside(async () => {
      for (const userId of ['automation:autopilot-plan-1', 'automation:autopilot-plan-1', 'automation:budget-schedule-s1', 'automation:auto-bid']) {
        await database.client.advertisingActionLog.create({ data: { userId, actionType: 'bid_down', entityType: 'CAMPAIGN', entityId: 'c1', payloadBefore: {}, payloadAfter: {} } })
      }
      await database.client.cronRun.create({ data: { jobName: 'ad-dayparting', status: 'SUCCESS', finishedAt: new Date() } })
    })
    const levers = await board()
    expect(levers.get('autopilot')).toMatchObject({ catalogId: 'A5', writes7d: 2, activity: 'acted', cron: 'ad-autopilot' })
    expect(levers.get('budget-schedules')).toMatchObject({ catalogId: 'A7', writes7d: 1, activity: 'acted', cron: 'ad-budget-schedule' })
    expect(levers.get('auto-bid')).toMatchObject({ writes7d: 1, activity: 'acted' })
    expect(levers.get('dayparting')).toMatchObject({ writes7d: 0, activity: 'idle' })
    expect(levers.get('rank-defend')).toMatchObject({ writes7d: 0, activity: 'never-ran' })
  })
})

describe('7a — engineExposure, the groups in one place', () => {
  const base = { writesOnOwn: true, env: 'AUTO' as const, switchedDown: false, dialHolds: false, rows: null, mode: 'AUTO' as const }
  it('a server switch comes first, then this business and the dial, then its own rows', () => {
    expect(engineExposure({ ...base, env: 'OBSERVE', switchedDown: true, dialHolds: true }).group).toBe('server-off')
    expect(engineExposure({ ...base, switchedDown: true, rows: { total: 0, auto: 0 } }).group).toBe('held')
    expect(engineExposure({ ...base, dialHolds: true, rows: { total: 0, auto: 0 } }).group).toBe('held')
    expect(engineExposure({ ...base, rows: { total: 0, auto: 0 } })).toEqual({ group: 'ready', label: 'Ready — nothing set up' })
    expect(engineExposure({ ...base, rows: { total: 3, auto: 0 } })).toEqual({ group: 'ready', label: 'Ready — nothing switched on' })
    expect(engineExposure({ ...base, rows: { total: 3, auto: 1 } }).group).toBe('acts')
    expect(engineExposure({ ...base, rows: 'unreadable' }).group).toBe('unknown')
    expect(engineExposure({ ...base, unknown: true }).group).toBe('unknown')
  })
  it('an engine that never writes by itself is "never" while it runs, and is never counted as acting', () => {
    expect(engineExposure({ ...base, writesOnOwn: false }).group).toBe('never')
    expect(engineExposure({ ...base, writesOnOwn: false, env: 'OBSERVE', mode: 'OBSERVE' }).group).toBe('never')
    expect(engineExposure({ ...base, writesOnOwn: false, env: 'OFF', mode: 'OFF' }).group).toBe('server-off')
    expect(engineExposure({ ...base, writesOnOwn: false, env: 'OBSERVE', mode: 'OFF' }).group).toBe('ready')
  })
})
