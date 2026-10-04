/**
 * R16 (MCP full control, decision D-R2) — the per-business engine switch, on a real PostgreSQL (PGlite).
 *
 * Proven: no row = the env alone decides (unchanged behaviour); a switch can only lower what the env allows (env off
 * wins over a switch on); the top level removes the row; each engine's own tick reads the switch in its business and
 * stands down (OFF) or stays dry (OBSERVE) — rank-defend, budget enforcement, auto-bid, top-of-search defense, the
 * coverage engine, the analyst fleet sweep and the snapshot repricer; a switch in one business never touches another.
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
// The engines' work itself is not what this file proves: each is stubbed to say it ran, so a tick that stands down
// is told apart from one that worked. The switch reads and the tick wrappers are the real ones.
const work = vi.hoisted(() => ({
  autoBid: vi.fn(async () => ({ proposed: 0, applied: 0, dryRun: true })),
  tos: vi.fn(async () => ({ evaluated: 0, changed: 0, applied: 0, skippedNotAllowlisted: 0 })),
  fleet: vi.fn(async () => ({ orchestrationId: 'orch-r16' })),
  enforce: vi.fn(async (opts: { dryRun: boolean }) => ({ result: { totals: { plans: 0, budgetChanges: 0 } }, budgetApplied: 0, suppressed: 0, restored: 0, failed: 0, dryRun: opts.dryRun })),
}))
vi.mock('../advertising/ads-auto-bid.service.js', () => ({ runAutoBidOnce: work.autoBid }))
vi.mock('../advertising/ads-top-of-search.service.js', async (importOriginal) => ({ ...(await importOriginal<object>()), defendTopOfSearch: work.tos }))
vi.mock('../advertising/ads-budget-enforce.service.js', async (importOriginal) => ({ ...(await importOriginal<object>()), applyBudgetEnforcement: work.enforce }))
vi.mock('../agent-fleet/orchestrator.js', async (importOriginal) => ({ ...(await importOriginal<object>()), runFleet: work.fleet }))
// 1e — the engine lock and the scheduler's arm flags are proven in ads-engine-lock.vitest.test.ts; every run gets through them here.
vi.mock('../advertising/ads-engine-lock.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  guardLiveRun: async (_engine: string, fn: () => Promise<unknown>) => ({ ran: true, value: await fn() }),
  withEngineLock: async (_workspaceId: string, _engine: string, fn: () => Promise<unknown>) => ({ ran: true, value: await fn() }),
}))

const svc = await import('./engine-switch.service.js')

const A = LEGACY_WORKSPACE_ID
const OTHER = 'ws_r16_other'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const lastRun = (jobName: string, workspaceId = A) => inside(() => database.client.cronRun.findFirst({ where: { jobName }, orderBy: { startedAt: 'desc' }, select: { outputSummary: true, status: true } }), workspaceId)
const ENV = ['NEXUS_BUDGET_ENFORCE_APPLY', 'NEXUS_COVERAGE_ENGINE_MODE', 'NEXUS_REPRICER_LIVE'] as const
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]))

beforeAll(async () => {
  database = await formulaDatabase()
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`, [OTHER])
}, 180_000)
afterEach(async () => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  await inside(() => database.client.automationSwitch.deleteMany({}))
  await inside(() => database.client.automationSwitch.deleteMany({}), OTHER)
})
afterAll(async () => {
  await database?.close()
}, 30_000)

describe('R16 — the per-business engine switch', () => {
  it('no row: every engine reads exactly what its env gives it', async () => {
    for (const key of svc.ENGINE_KEYS) {
      for (const env of ['OFF', 'OBSERVE', 'AUTO'] as const) {
        expect(await inside(() => svc.engineMode(key, env)), `${key} ${env}`).toEqual({ mode: env, switched: null, note: null })
      }
    }
  })

  it('a switch only lowers: env off wins over a switch on; the top level removes the row; one business never touches another', async () => {
    await inside(() => svc.setEngineSwitch('budget-enforce', 'OBSERVE', 'user:u-r16', 'test'))
    expect(await inside(() => svc.engineMode('budget-enforce', 'AUTO'))).toMatchObject({ mode: 'OBSERVE', note: 'switched to OBSERVE for this business by user:u-r16' })
    expect(await inside(() => svc.engineMode('budget-enforce', 'OFF'))).toMatchObject({ mode: 'OFF', note: null })
    expect(await inside(() => svc.engineMode('budget-enforce', 'AUTO'), OTHER)).toEqual({ mode: 'AUTO', switched: null, note: null })
    await inside(() => svc.setEngineSwitch('budget-enforce', 'AUTO', 'user:u-r16'))
    expect(await inside(() => database.client.automationSwitch.count())).toBe(0)
    await expect(inside(() => svc.setEngineSwitch('fleet-analysts', 'AUTO', 'user:u-r16'))).rejects.toThrow('Analyst fleet sweep can be OFF, OBSERVE — not AUTO')
  })

  it('rank-defend, auto-bid and top-of-search defense: a tick switched OFF stands down and says so; the other business runs', async () => {
    const { runRankDefendCron } = await import('../../jobs/ad-rank-defend.job.js')
    const { runAutoBidCron } = await import('../../jobs/ads-sync.job.js')
    const { runTosDefenseCron } = await import('../../jobs/ads-tos-defense.job.js')
    for (const key of ['rank-defend', 'auto-bid', 'tos-defense'] as const) await inside(() => svc.setEngineSwitch(key, 'OFF', 'user:u-r16'))
    await inside(() => runRankDefendCron())
    await inside(() => runAutoBidCron())
    await inside(() => runTosDefenseCron())
    for (const job of ['ad-rank-defend', 'ads-auto-bid', 'top-of-search-defense']) {
      expect(await lastRun(job), job).toMatchObject({ status: 'SUCCESS', outputSummary: expect.stringMatching(/^skipped: switched to OFF for this business by user:u-r16/) })
    }
    expect(work.autoBid).not.toHaveBeenCalled()
    expect(work.tos).not.toHaveBeenCalled()
    await inside(() => runAutoBidCron(), OTHER)
    await inside(() => runTosDefenseCron(), OTHER)
    expect(work.autoBid).toHaveBeenCalledTimes(1)
    expect(work.tos).toHaveBeenCalledTimes(1)
    expect((await lastRun('ad-rank-defend', OTHER))).toBeNull() // not run there by this test
  })

  it('budget enforcement: OBSERVE keeps it dry even when the env applies; OFF stands it down', async () => {
    const { runBudgetEnforceOnce } = await import('../../jobs/ad-budget-enforce.job.js')
    process.env.NEXUS_BUDGET_ENFORCE_APPLY = '1'
    expect(await inside(() => runBudgetEnforceOnce())).toContain('(LIVE)')
    await inside(() => svc.setEngineSwitch('budget-enforce', 'OBSERVE', 'user:u-r16'))
    expect(await inside(() => runBudgetEnforceOnce())).toContain('(dry-run)')
    expect(work.enforce).toHaveBeenLastCalledWith(expect.objectContaining({ dryRun: true }))
    await inside(() => svc.setEngineSwitch('budget-enforce', 'OFF', 'user:u-r16'))
    work.enforce.mockClear()
    expect(await inside(() => runBudgetEnforceOnce())).toMatch(/^skipped: switched to OFF/)
    expect(work.enforce).not.toHaveBeenCalled()
  })

  it('the coverage engine runs at the lower of its env mode and the switch', async () => {
    const { runCoverageEngineOnce } = await import('../advertising/ads-coverage-engine.service.js')
    process.env.NEXUS_COVERAGE_ENGINE_MODE = 'auto'
    expect((await inside(() => runCoverageEngineOnce())).mode).toBe('auto')
    await inside(() => svc.setEngineSwitch('coverage-engine', 'OBSERVE', 'user:u-r16'))
    expect((await inside(() => runCoverageEngineOnce())).mode).toBe('observe')
    await inside(() => svc.setEngineSwitch('coverage-engine', 'OFF', 'user:u-r16'))
    expect((await inside(() => runCoverageEngineOnce())).mode).toBe('off')
    process.env.NEXUS_COVERAGE_ENGINE_MODE = 'off'
    await inside(() => svc.setEngineSwitch('coverage-engine', 'AUTO', 'user:u-r16'))
    expect((await inside(() => runCoverageEngineOnce())).mode).toBe('off') // env off wins
  })

  it('the analyst fleet sweep and the snapshot repricer stand down when switched off; the repricer stays dry at OBSERVE', async () => {
    const { runFleetSweepCron } = await import('../../jobs/fleet-sweep.job.js')
    const { runRepricerCronTick } = await import('../../jobs/repricer.job.js')
    await inside(() => svc.setEngineSwitch('fleet-analysts', 'OFF', 'user:u-r16'))
    await inside(() => runFleetSweepCron())
    expect(await lastRun('fleet-sweep')).toMatchObject({ outputSummary: expect.stringMatching(/^skipped: switched to OFF/) })
    expect(work.fleet).not.toHaveBeenCalled()

    process.env.NEXUS_REPRICER_LIVE = '1'
    await inside(() => runRepricerCronTick())
    expect(await lastRun('repricer')).toMatchObject({ outputSummary: expect.stringContaining('live=true') })
    await inside(() => svc.setEngineSwitch('repricer', 'OBSERVE', 'user:u-r16'))
    await inside(() => runRepricerCronTick())
    expect(await lastRun('repricer')).toMatchObject({ outputSummary: expect.stringContaining('live=false') })
    await inside(() => svc.setEngineSwitch('repricer', 'OFF', 'user:u-r16'))
    await inside(() => runRepricerCronTick())
    expect(await lastRun('repricer')).toMatchObject({ outputSummary: expect.stringMatching(/^skipped: switched to OFF/) })
  })
})
