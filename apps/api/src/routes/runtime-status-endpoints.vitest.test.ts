/**
 * The operator status endpoints after the API / worker / scheduler split.
 *
 * Every arm plants what ANOTHER process knows — a runtime snapshot in Redis as the worker or the scheduler
 * publishes it, a CronRun row as recordCronRun writes it — and asks the API. Before the fix each endpoint read
 * the API's own memory, which since the split never scheduled a cron, ran the Autopilot or held a worker
 * circuit, so every arm here failed: "scheduled: false", "lastRunAt: null", "closed", "not-reached".
 *
 * Real SQL (PGlite with the production schema) and real route plugins. Redis is real when
 * NEXUS_TEST_REDIS_URL is set (CI's profiles-off pass) and an in-memory stand-in otherwise.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { Redis } from 'ioredis'
import { formulaDatabase } from '../test-support/formula-database.js'
import { FakeStatusRedis } from '../test-support/fake-status-redis.js'
import type { StatusRedis } from '../lib/runtime-status/process-snapshot.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Pick<Awaited<ReturnType<typeof formulaDatabase>>, 'client' | 'close'>
let statusClient: (StatusRedis & { get(key: string): Promise<string | null> }) | null = null

vi.mock('../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }),
    resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { get connection() { return statusClient } },
  }
})
vi.mock('../services/advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined,
  putCached: () => undefined,
  flushAdsCache: async () => undefined,
}))

// The pipeline arms run the real cron wrapper around a sweep the test controls.
const accuracySweep = vi.hoisted(() => ({ fail: null as string | null }))
vi.mock('../services/forecast-accuracy.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runForecastAccuracySweep: async () => {
    if (accuracySweep.fail) throw new Error(accuracySweep.fail)
    return { day: '2026-09-25', evaluated: 5, skippedNoForecast: 1 }
  },
}))

type Role = 'api' | 'worker' | 'scheduler'
type Sections = Record<string, unknown>

const realRedisUrl = process.env.NEXUS_TEST_REDIS_URL
let realRedis: Redis | null = null
let prefix = ''
let app: FastifyInstance
const loops: Array<() => void> = []

const keyOf = (suffix: string) => `${prefix}:${suffix}`
const OTHER_BUSINESS = 'runtime_status_other_business'
const inside = <T>(work: () => Promise<T>, workspaceId = LEGACY_WORKSPACE_ID) =>
  withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)

/** What another process's publisher writes (lib/runtime-status/process-snapshot.ts), written by hand. */
async function publishAs(role: Role, instanceId: string, sections: Sections, options: { ready?: boolean; startedAt?: string } = {}) {
  const member = `${role}:${instanceId}`
  const snapshot = {
    v: 1, role, instanceId, pid: 4242, startedAt: options.startedAt ?? '2026-09-26T08:00:00.000Z',
    publishedAt: new Date().toISOString(), ready: options.ready ?? true, sections,
  }
  await statusClient!.set(keyOf(`process:${member}`), JSON.stringify(snapshot), 'PX', 30_000)
  await statusClient!.sadd(keyOf('processes'), member)
}

const noCircuits = { channels: { AMAZON: {}, EBAY: {}, SHOPIFY: {} }, resetApplied: { AMAZON: 0, EBAY: 0, SHOPIFY: 0 } }
const openAmazon = (resetApplied = 0) => ({
  channels: { AMAZON: { 'A1SELLER:APJ6JRA9NG5V4': { state: 'open', failureCount: 3, openedAt: '2026-09-26T09:00:00.000Z' } }, EBAY: {}, SHOPIFY: {} },
  resetApplied: { AMAZON: resetApplied, EBAY: 0, SHOPIFY: 0 },
})

/** A process that applies circuit resets the way applyRequestedCircuitResets does, and republishes. */
function simulateProcess(role: Role, instanceId: string, sections: Sections, circuits: (applied: number) => unknown) {
  let applied = 0
  let stopped = false
  const run = async () => {
    while (!stopped) {
      const generation = Number((await statusClient!.get(keyOf('circuit-reset:AMAZON'))) ?? 0)
      if (generation > applied) applied = generation
      await publishAs(role, instanceId, { ...sections, circuits: circuits(applied) })
      await new Promise(resolve => setTimeout(resolve, 40))
    }
  }
  const done = run()
  loops.push(() => { stopped = true; void done })
  return done
}

const cronRun = (jobName: string, status: 'SUCCESS' | 'FAILED' | 'RUNNING', startedAt: string, extra: { outputSummary?: string; errorMessage?: string; finishedAt?: string | null; workspaceId?: string } = {}) =>
  inside(() => database.client.cronRun.create({
    data: {
      jobName, status, startedAt: new Date(startedAt), triggeredBy: 'cron',
      finishedAt: extra.finishedAt === null ? null : new Date(extra.finishedAt ?? new Date(Date.parse(startedAt) + 1_000).toISOString()),
      outputSummary: extra.outputSummary ?? null, errorMessage: extra.errorMessage ?? null,
    },
  }), extra.workspaceId)

const get = async (url: string) => {
  const response = await app.inject({ method: 'GET', url })
  expect(response.statusCode, `${url}: ${response.body.slice(0, 300)}`).toBe(200)
  return response.json() as Record<string, any>
}

describe('status endpoints answer from the process that owns the value', () => {
  beforeAll(async () => {
    database = await formulaDatabase()
    vi.stubEnv('REDIS_URL', realRedisUrl ?? 'redis://in-memory-stand-in')
    if (realRedisUrl) {
      realRedis = new Redis(realRedisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 })
      await realRedis.connect()
    }
    const owner = await database.client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active' } })
    await database.client.workspace.create({ data: { id: OTHER_BUSINESS, name: 'Other business', createdByUserId: owner.id, creationKey: randomUUID() } })
    app = Fastify()
    // Every request runs as the legacy business, as the verified-identity middleware would set it.
    app.addHook('preHandler', (_request, _reply, done) => {
      withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }, done)
    })
    const [{ default: dashboardRoutes }, { default: fulfillmentRoutes }, { default: stockRoutes }, { syncRoutes }, { default: advertisingRoutes }, { default: advertisingIntelRoutes }, { outboundRoutes }] = await Promise.all([
      import('./dashboard.routes.js'), import('./fulfillment.routes.js'), import('./stock.routes.js'), import('./sync.routes.js'),
      import('./advertising.routes.js'), import('./advertising-intel.routes.js'), import('./outbound.routes.js'),
    ])
    await app.register(dashboardRoutes, { prefix: '/api' })
    await app.register(fulfillmentRoutes, { prefix: '/api' })
    await app.register(stockRoutes, { prefix: '/api' })
    await app.register(syncRoutes, { prefix: '/api' })
    await app.register(advertisingRoutes, { prefix: '/api' })
    await app.register(advertisingIntelRoutes, { prefix: '/api' })
    await app.register(outboundRoutes)
    await app.ready()
  }, 180_000)

  afterAll(async () => {
    await app?.close()
    realRedis?.disconnect()
    await database?.close()
    vi.unstubAllEnvs()
  })

  beforeEach(async () => {
    prefix = `test:runtime-status:${randomUUID()}`
    statusClient = (realRedis as unknown as typeof statusClient) ?? new FakeStatusRedis()
    const { setStatusKeyPrefixForTests } = await import('../lib/runtime-status/process-snapshot.js').catch(() => ({ setStatusKeyPrefixForTests: undefined }))
    setStatusKeyPrefixForTests?.(prefix)
    for (const workspaceId of [LEGACY_WORKSPACE_ID, OTHER_BUSINESS]) await inside(() => database.client.cronRun.deleteMany(), workspaceId)
  })

  afterEach(async () => {
    loops.splice(0).forEach(stop => stop())
    await new Promise(resolve => setTimeout(resolve, 60))
    if (realRedis) {
      const keys = await realRedis.keys(`${prefix}:*`)
      if (keys.length) await realRedis.del(...keys)
    }
  })

  describe('publish circuit breakers', () => {
    it('reports a circuit the WORKER opened, not only the API\'s own', async () => {
      await publishAs('worker', 'w1', { circuits: openAmazon() })
      await publishAs('scheduler', 's1', { circuits: noCircuits })
      const body = await get('/api/dashboard/circuit-breakers')
      expect(body.AMAZON).toMatchObject({ state: 'open', failureCount: 3, openedAt: '2026-09-26T09:00:00.000Z', keyCount: 1, complete: true })
      expect(body.AMAZON.reporting.map((r: { role: string }) => r.role).sort()).toEqual(['api', 'scheduler', 'worker'])
      expect(body.EBAY).toMatchObject({ state: 'closed', complete: true, unknown: [] })
    })

    it('says UNKNOWN, naming the worker, when the worker is not reporting — never "closed"', async () => {
      await publishAs('scheduler', 's1', { circuits: noCircuits })
      const body = await get('/api/dashboard/circuit-breakers')
      for (const channel of ['AMAZON', 'EBAY', 'SHOPIFY']) {
        expect(body[channel].state).toBe('unknown')
        expect(body[channel].complete).toBe(false)
        expect(body[channel].unknown).toEqual([expect.objectContaining({ owner: 'worker', reason: expect.stringContaining('no live heartbeat from the worker') })])
      }
    })

    it('a reset reaches the worker and the scheduler, and says who applied it', async () => {
      void simulateProcess('worker', 'w1', {}, applied => (applied >= 1 ? { ...noCircuits, resetApplied: { AMAZON: applied, EBAY: 0, SHOPIFY: 0 } } : openAmazon(applied)))
      void simulateProcess('scheduler', 's1', {}, applied => ({ ...noCircuits, resetApplied: { AMAZON: applied, EBAY: 0, SHOPIFY: 0 } }))
      await new Promise(resolve => setTimeout(resolve, 100))
      expect((await get('/api/dashboard/circuit-breakers')).AMAZON.state).toBe('open')

      const response = await app.inject({ method: 'POST', url: '/api/dashboard/circuit-breakers/amazon/reset' })
      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body).toMatchObject({ ok: true, channel: 'AMAZON', state: 'closed', complete: true, generation: 1, pending: [] })
      expect(body.acknowledgedBy.map((p: { role: string }) => p.role).sort()).toEqual(['api', 'scheduler', 'worker'])
      expect(await statusClient!.get(keyOf('circuit-reset:AMAZON'))).toBe('1')
      expect((await get('/api/dashboard/circuit-breakers')).AMAZON.state).toBe('closed')
    })

    it('a reset the worker has not applied yet is reported as pending (202), not as closed', async () => {
      vi.stubEnv('NEXUS_CIRCUIT_RESET_WAIT_MS', '300')
      await publishAs('worker', 'w1', { circuits: openAmazon() })
      await publishAs('scheduler', 's1', { circuits: noCircuits })
      const response = await app.inject({ method: 'POST', url: '/api/dashboard/circuit-breakers/AMAZON/reset' })
      vi.stubEnv('NEXUS_CIRCUIT_RESET_WAIT_MS', '')
      expect(response.statusCode).toBe(202)
      expect(response.json()).toMatchObject({ ok: true, channel: 'AMAZON', state: 'open', complete: false, generation: 1 })
      expect(response.json().pending.map((p: { role: string }) => p.role).sort()).toEqual(['scheduler', 'worker'])
    })

    it('an unknown channel is still refused', async () => {
      expect((await app.inject({ method: 'POST', url: '/api/dashboard/circuit-breakers/ETSY/reset' })).statusCode).toBe(400)
    })
  })

  describe('cron status', () => {
    const scheduler = (modules: string[], flags: Record<string, string> = {}, ready = true) =>
      publishAs('scheduler', 's1', { scheduledJobs: modules, flags, circuits: noCircuits }, { ready })

    it('stockouts: scheduled and last run come from the scheduler and the CronRun table', async () => {
      await scheduler(['jobs/stockout-detector.job'])
      await cronRun('stockout-detector', 'SUCCESS', '2026-09-26T06:30:00.000Z', { outputSummary: 'opened=2 closed=1', finishedAt: '2026-09-26T06:30:04.000Z' })
      await cronRun('stockout-detector', 'FAILED', '2026-09-26T07:30:00.000Z', { errorMessage: 'boom' })
      const { cron } = await get('/api/fulfillment/replenishment/stockouts/status')
      expect(cron.scheduled).toBe(true)
      expect(cron.lastRunAt).toBe('2026-09-26T06:30:04.000Z')
      expect(cron.lastRun).toMatchObject({ status: 'FAILED', errorMessage: 'boom' })
      expect(cron.lastSummary).toBeNull()
      expect(cron.unknown).toEqual([expect.objectContaining({ field: 'cron.lastSummary', owner: 'scheduler' })])
    })

    it('runs are the caller\'s business\'s — not whichever business the scheduler ran last', async () => {
      await scheduler(['jobs/stockout-detector.job'])
      await cronRun('stockout-detector', 'SUCCESS', '2026-09-26T06:30:00.000Z')
      await cronRun('stockout-detector', 'FAILED', '2026-09-26T08:30:00.000Z', { errorMessage: 'other business', workspaceId: OTHER_BUSINESS })
      // Positive control: the later, failed run exists — in the other business.
      expect(await inside(() => database.client.cronRun.count({ where: { jobName: 'stockout-detector', status: 'FAILED' } }), OTHER_BUSINESS)).toBe(1)
      const { cron } = await get('/api/fulfillment/replenishment/stockouts/status')
      expect(cron.lastRunAt).toBe('2026-09-26T06:30:01.000Z')
      expect(cron.lastRun.status).toBe('SUCCESS')
    })

    it('without a scheduler heartbeat, "scheduled" is unknown with the reason — never false', async () => {
      const { cron } = await get('/api/fulfillment/replenishment/stockouts/status')
      expect(cron.scheduled).toBeNull()
      expect(cron.unknown).toContainEqual(expect.objectContaining({ field: 'cron.scheduled', owner: 'scheduler', reason: expect.stringContaining('no live heartbeat from the scheduler') }))
      expect(cron.lastRunAt).toBeNull()
    })

    it('a scheduler still registering its crons is not read as "not scheduled"', async () => {
      await scheduler(['jobs/auto-po-replenishment.job'], {}, false)
      const { cron } = await get('/api/fulfillment/replenishment/stockouts/status')
      expect(cron.scheduled).toBeNull()
      expect(cron.unknown).toContainEqual(expect.objectContaining({ field: 'cron.scheduled', reason: expect.stringContaining('still registering') }))
    })

    it('a started scheduler that did not register the job: scheduled is false', async () => {
      await scheduler(['jobs/auto-po-replenishment.job'])
      const { cron } = await get('/api/fulfillment/replenishment/stockouts/status')
      expect(cron.scheduled).toBe(false)
    })

    it('lead-time stats, auto-PO and FBA restock cards', async () => {
      await scheduler(['jobs/lead-time-stats.job', 'jobs/auto-po-replenishment.job', 'jobs/fba-restock-ingestion.job'])
      await cronRun('lead-time-stats', 'SUCCESS', '2026-09-26T06:00:00.000Z', { outputSummary: 'suppliersUpdated=4 errors=0' })
      await cronRun('auto-po', 'SUCCESS', '2026-09-26T05:00:00.000Z', { outputSummary: '3 POs from 12 eligible recs (errors=0)' })
      await cronRun('fba-restock-ingestion', 'SUCCESS', '2026-09-26T04:00:00.000Z', { outputSummary: 'marketplaces=2 totalRows=40 fatal=0' })
      const leadTime = (await get('/api/fulfillment/replenishment/lead-time-stats/status')).cron
      expect(leadTime).toMatchObject({ scheduled: true, lastRunAt: '2026-09-26T06:00:01.000Z', lastSummary: null })
      const autoPo = (await get('/api/fulfillment/replenishment/auto-po/status')).cron
      expect(autoPo).toMatchObject({ scheduled: true, lastRunAt: '2026-09-26T05:00:01.000Z', lastPosCreated: 3 })
      const restock = (await get('/api/fulfillment/replenishment/fba-restock/status')).cron
      expect(restock).toMatchObject({ scheduled: true, lastRunAt: '2026-09-26T04:00:01.000Z' })
    })

    it('automation rules card: the scheduler\'s flag, not the API\'s environment', async () => {
      vi.stubEnv('NEXUS_ENABLE_AUTOMATION_RULE_CRON', '0')
      await scheduler(['jobs/automation-rule-evaluator.job'], { NEXUS_ENABLE_AUTOMATION_RULE_CRON: '1' })
      await cronRun('automation-rule-evaluator', 'SUCCESS', '2026-09-26T09:15:00.000Z', { outputSummary: 'evals=7 matches=2 (rec_gen=7 stockout=0 cron_tick=0 spike=0 imbalance=0) durationMs=12' })
      const body = await get('/api/fulfillment/replenishment/automation/cron-status')
      vi.stubEnv('NEXUS_ENABLE_AUTOMATION_RULE_CRON', '')
      expect(body).toMatchObject({
        scheduled: true, enabledFlag: true, lastRunAt: '2026-09-26T09:15:01.000Z',
        lastSummary: 'evals=7 matches=2 (rec_gen=7 stockout=0 cron_tick=0 spike=0 imbalance=0) durationMs=12',
      })
    })

    it('automation rules card with no scheduler heartbeat: flag and schedule are unknown', async () => {
      const body = await get('/api/fulfillment/replenishment/automation/cron-status')
      expect(body).toMatchObject({ scheduled: null, enabledFlag: null })
      expect(body.unknown.map((u: { field: string }) => u.field).sort()).toEqual(['enabledFlag', 'scheduled'])
    })

    it('pipeline health: cron flags as the scheduler sees them', async () => {
      vi.stubEnv('NEXUS_ENABLE_FORECAST_CRON', '')
      await scheduler([], { NEXUS_ENABLE_FORECAST_CRON: '1', NEXUS_ENABLE_ABC_CRON: '0' })
      const { crons } = await get('/api/fulfillment/replenishment/pipeline/health')
      expect(crons.forecast.enabledFlag).toBe(true)
      expect(crons['forecast-accuracy'].enabledFlag).toBe(true)
      expect(crons['abc-classification'].enabledFlag).toBe(false)
    })

    it('pipeline health with no scheduler heartbeat: flags are unknown', async () => {
      const { crons } = await get('/api/fulfillment/replenishment/pipeline/health')
      expect(crons.forecast.enabledFlag).toBeNull()
      expect(crons.forecast.unknown).toEqual([expect.objectContaining({ owner: 'scheduler' })])
    })

    it('FBA status poll, drift detection and the ads rule evaluator', async () => {
      await scheduler(['jobs/fba-status-poll.job', 'jobs/sync-drift-detection.job', 'jobs/advertising-rule-evaluator.job'])
      await cronRun('fba-status-poll', 'SUCCESS', '2026-09-26T09:00:00.000Z', { outputSummary: 'scanned=5 updated=2 unchanged=3 skipped=0 errors=0' })
      await cronRun('sync-drift-detection', 'SUCCESS', '2026-09-26T09:00:00.000Z', { outputSummary: 'scanned=9 priceDrifts=1 qtyDrifts=0 logged=1 deduped=0 errors=0 durationMs=80' })
      await cronRun('advertising-rule-evaluator', 'SUCCESS', '2026-09-26T09:00:00.000Z', { outputSummary: 'fba=0 prof=1 cac=0 under=0 schedule=0 evals=1 matches=0 capped=0 failed=0 durationMs=5' })
      expect(await get('/api/fulfillment/fba/poll-status')).toMatchObject({ ok: true, scheduled: true, lastRunAt: '2026-09-26T09:00:01.000Z', lastUpdatedCount: 2 })
      const drift = await get('/api/sync/detect-drift/status')
      expect(drift).toMatchObject({ scheduled: true, lastRunAt: '2026-09-26T09:00:01.000Z', lastResult: null })
      expect(drift.lastRun.outputSummary).toContain('priceDrifts=1')
      expect(await get('/api/advertising/cron/advertising-rule-evaluator/status')).toMatchObject({
        scheduled: true, lastRunAt: '2026-09-26T09:00:01.000Z', lastSummary: 'fba=0 prof=1 cac=0 under=0 schedule=0 evals=1 matches=0 capped=0 failed=0 durationMs=5',
      })
    })

    it('pipeline run: a step carries the scheduler\'s schedule and the run it just recorded', async () => {
      accuracySweep.fail = null
      await scheduler(['jobs/forecast-accuracy.job', 'jobs/abc-classification.job'])
      const response = await app.inject({ method: 'POST', url: '/api/fulfillment/replenishment/pipeline/run', payload: { skipBackfill: true } })
      const accuracy = response.json().steps.find((step: { step: string }) => step.step === 'forecast-accuracy')
      expect(accuracy).toMatchObject({ ok: true, summary: { scheduled: true, lastEvaluated: 5, lastRun: { status: 'SUCCESS', outputSummary: 'day=2026-09-25 evaluated=5 skippedNoForecast=1' } } })
    })

    it('pipeline run: a step whose recorded run FAILED is reported as failed, not "ok"', async () => {
      accuracySweep.fail = 'accuracy sweep exploded'
      await scheduler(['jobs/forecast-accuracy.job'])
      const response = await app.inject({ method: 'POST', url: '/api/fulfillment/replenishment/pipeline/run', payload: { skipBackfill: true } })
      accuracySweep.fail = null
      expect(response.json().ok).toBe(false)
      expect(response.json().steps.find((step: { step: string }) => step.step === 'forecast-accuracy')).toMatchObject({ ok: false, error: 'accuracy sweep exploded' })
    })

    it('stock sync status: the reservation sweep', async () => {
      await scheduler(['jobs/reservation-sweep.job'])
      await cronRun('reservation-sweep', 'SUCCESS', '2026-09-26T09:05:00.000Z', { outputSummary: 'released=4' })
      const { reservationSweep } = await get('/api/stock/sync-status')
      expect(reservationSweep).toMatchObject({ scheduled: true, lastRunAt: '2026-09-26T09:05:01.000Z', lastReleasedCount: 4 })
    })
  })

  describe('process diagnostics', () => {
    it('ads cron-status reads the scheduler\'s startup step and flag, and the worker\'s poller', async () => {
      vi.stubEnv('NEXUS_ENABLE_AMAZON_ADS_CRON', '')
      await publishAs('scheduler', 's1', {
        flags: { NEXUS_ENABLE_AMAZON_ADS_CRON: 'true', NEXUS_AMAZON_ADS_MODE: 'live', ENABLE_QUEUE_WORKERS: '1' },
        cronStartup: { step: 'ads:done', updatedAt: '2026-09-26T08:00:05.000Z' },
      })
      await publishAs('worker', 'w1', { ams: { destinationArnSet: true, destinationArnIsSqs: true, explicitQueueUrlSet: false, queueUrlResolved: true, hasAwsAccessKey: true, hasAwsSecret: true, pollerActive: true } })
      const body = await get('/api/advertising/cron-status')
      expect(body).toMatchObject({
        adsCronEnabled: true, adsCronRaw: 'true', cronStartupStep: 'ads:done', cronStartupAt: '2026-09-26T08:00:05.000Z',
        adsMode: 'live', queueWorkersRaw: '1', unknown: [],
      })
      expect(body.ams.pollerActive).toBe(true)
      expect(body.processes.scheduler.reporting).toBe(true)
    })

    it('ads cron-status with neither process reporting: unknown, never "not-reached"', async () => {
      const body = await get('/api/advertising/cron-status')
      expect(body.cronStartupStep).toBeNull()
      expect(body.adsCronEnabled).toBeNull()
      expect(body.ams.pollerActive).toBeNull()
      expect(body.unknown.map((u: { owner: string }) => u.owner)).toEqual(expect.arrayContaining(['scheduler', 'worker']))
    })

    it('Autopilot worker status comes from the worker', async () => {
      await publishAs('worker', 'w1', { syncWorker: { isRunning: true, isProcessing: false, totalSyncsProcessed: 12, totalErrors: 1, lastProcessingTime: '2026-09-26T09:59:00.000Z', uptime: 'x' } })
      await publishAs('worker', 'w2', { syncWorker: { isRunning: true, isProcessing: true, totalSyncsProcessed: 3, totalErrors: 0, lastProcessingTime: '2026-09-26T10:00:00.000Z', uptime: 'x' } }, { startedAt: '2026-09-26T07:00:00.000Z' })
      const { status } = await get('/api/outbound/worker-status')
      expect(status).toMatchObject({ isRunning: true, isProcessing: true, totalSyncsProcessed: 15, totalErrors: 1, lastProcessingTime: '2026-09-26T10:00:00.000Z', uptime: '2026-09-26T07:00:00.000Z' })
    })

    it('outbound stats do not present counters nobody keeps as zeros', async () => {
      const { stats } = await get('/api/outbound/stats')
      expect(stats).toMatchObject({ processed: null, succeeded: null, failed: null, queuedScope: 'this API process since it started' })
      expect(stats.unknown.map((u: { field: string }) => u.field)).toEqual(['processed', 'succeeded', 'failed'])
    })

    it('Autopilot worker status with no worker heartbeat is unknown, not "running"', async () => {
      const { status } = await get('/api/outbound/worker-status')
      expect(status).toMatchObject({ isRunning: null, isProcessing: null, totalSyncsProcessed: null })
      expect(status.unknown).toEqual([expect.objectContaining({ owner: 'worker' })])
    })
  })
})
