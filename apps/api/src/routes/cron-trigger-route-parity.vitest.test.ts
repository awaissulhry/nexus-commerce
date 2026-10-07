/**
 * ADS AUTONOMY W4-8 — POST /sync-logs/cron/:jobName/trigger (the Sync Logs hub's and the Ads Control Room's "Run now")
 * answers byte for byte as before its logic moved into startCronByHand (sync-logs/cron-trigger.service.ts), which Claude's
 * run-ad-engine-now uses to start an engine: one path, never a second.
 *
 * On a real PostgreSQL (PGlite) with the real run record (recordCronRun); the registry is stood in by two jobs, so the
 * test runs no real engine. The snapshot beside this file was WRITTEN BY THE ROUTE BEFORE THE MOVE and is read unchanged
 * after it; the run rows each answer leaves behind are part of it.
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
const JOBS: Record<string, () => Promise<unknown>> = {
  'parity-summary': async () => 'parity run: 3 changed',
  'parity-throws': async () => { throw new Error('parity run failed on purpose') },
}
vi.mock('../jobs/cron-registry.js', () => ({
  CRON_REGISTRY: JOBS,
  isKnownCron: (name: string) => Object.prototype.hasOwnProperty.call(JOBS, name),
  listKnownCrons: () => Object.keys(JOBS),
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

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

describe('W4-8 — the manual cron trigger answers as before the move', () => {
  it('every outcome, and the run row each leaves', async () => {
    const answers: string[] = []
    const runOf = async (jobName: string) => {
      let row: { status: string; triggeredBy: string; outputSummary: string | null; errorMessage: string | null; finished: boolean } | null = null
      await vi.waitFor(async () => {
        const found = await inside(() => database.client.cronRun.findFirst({ where: { jobName }, orderBy: { startedAt: 'desc' } }))
        expect(found?.status).not.toBe('RUNNING')
        row = found ? { status: found.status, triggeredBy: found.triggeredBy, outputSummary: found.outputSummary, errorMessage: found.errorMessage, finished: !!found.finishedAt } : null
      })
      return row
    }
    const send = async (jobName: string) => {
      const res = await app.inject({ method: 'POST', url: `/api/sync-logs/cron/${jobName}/trigger` })
      answers.push(`${res.statusCode} ${res.body}`)
      if (res.statusCode === 202) answers.push(`  run ${JSON.stringify(await runOf(jobName))}`)
    }
    await send('no-such-job')
    await send('parity-summary')
    await send('parity-throws')
    const registry = await app.inject({ method: 'GET', url: '/api/sync-logs/cron/registry' })
    answers.push(`${registry.statusCode} ${registry.body}`)
    expect(answers.join('\n')).toMatchSnapshot()
  })
})
