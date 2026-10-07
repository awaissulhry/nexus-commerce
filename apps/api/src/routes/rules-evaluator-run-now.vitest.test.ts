/**
 * ADS AUTONOMY W4-8 — "Run now" of the Amazon ads rules evaluator (the Sync Logs hub's trigger, which Claude's
 * run-ad-engine-now uses) records ONE honest run row: `manual`, with that run's own line.
 *
 * Before, the registry named the *Cron wrapper, so one hand-run wrote TWO rows — a `manual` one carrying the module's
 * last line (often a scheduled run's) and a nested `cron` one — and the wrapper's catch made a failed run read as a
 * success. Now it names the *Once form (the ACR.1.2d precedent, ads-sync-drain.job.ts).
 *
 * On a real PostgreSQL (PGlite) with the REAL registry and the real evaluator (no rule here, so it evaluates nothing).
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../services/sync-logs-events.service.js', () => ({ subscribeSyncLogEvents: vi.fn() }))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const JOB = 'advertising-rule-evaluator'

let app: FastifyInstance
beforeAll(async () => {
  database = await formulaDatabase()
  const { default: syncLogsRoutes } = await import('./sync-logs.routes.js')
  app = Fastify({ logger: false })
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(business, done))
  await app.register(syncLogsRoutes, { prefix: '/api' })
  await app.ready()
}, 180_000)
afterAll(async () => {
  await app?.close()
  await database?.close()
}, 30_000)

/** Start a hand-run and wait until no row of the job is open; every row of the job, oldest first. */
async function runByHand() {
  const res = await app.inject({ method: 'POST', url: `/api/sync-logs/cron/${JOB}/trigger` })
  expect(res.statusCode).toBe(202)
  let rows: Array<{ status: string; triggeredBy: string; outputSummary: string | null }> = []
  await vi.waitFor(async () => {
    rows = await inside(() => database.client.cronRun.findMany({ where: { jobName: JOB }, orderBy: { startedAt: 'asc' }, select: { status: true, triggeredBy: true, outputSummary: true } }))
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((r) => r.status === 'RUNNING')).toBe(false)
  }, { timeout: 60_000, interval: 200 })
  return rows
}

describe('W4-8 — Run now of the rules evaluator records one honest row', () => {
  it('halted: one manual row that says it evaluated nothing, and why', async () => {
    await inside(() => database.client.adsAutomationState.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', halted: true, haltReason: 'test halt' }, update: { halted: true, haltReason: 'test halt' } }))
    const rows = await runByHand()
    expect(rows).toEqual([{ status: 'SUCCESS', triggeredBy: 'manual', outputSummary: 'skipped: ads automation is halted, its autonomy is OFF, or its state could not be read — no rule evaluated' }])
    await inside(() => database.client.cronRun.deleteMany({ where: { jobName: JOB } }))
  }, 90_000)

  it('running: one manual row with this run’s own line (never a second, scheduled-looking row)', async () => {
    await inside(() => database.client.adsAutomationState.update({ where: { id: 'singleton' }, data: { halted: false, haltReason: null } }))
    const rows = await runByHand()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'SUCCESS', triggeredBy: 'manual' })
    expect(rows[0].outputSummary).toMatch(/^fba=\d+ prof=\d+ cac=\d+ under=\d+ schedule=\d+ evals=0 matches=0 capped=0 failed=0 durationMs=\d+$/)
  }, 120_000)
})
