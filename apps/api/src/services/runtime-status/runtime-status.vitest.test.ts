/**
 * The runtime-status layer: what a process publishes, what a reader accepts, and how a circuit reset moves
 * between processes. The route-level arms are in routes/runtime-status-endpoints.vitest.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Redis } from 'ioredis'
import { FakeStatusRedis } from '../../test-support/fake-status-redis.js'
import {
  buildLocalSnapshot, flagSection, processIndexKey, readLiveProcesses, registerStatusSection, setStatusKeyPrefixForTests,
  setStatusRedisForTests, snapshotKey, type StatusRedis,
} from '../../lib/runtime-status/process-snapshot.js'
import {
  __resetCircuitGenerationsForTests, aggregateCircuits, applyRequestedCircuitResets, circuitResetKey, registerCircuitSection, requestCircuitReset,
} from './circuit-breakers.service.js'
import { CRON_JOBS, leadingCount, resolveScheduled, summaryCount } from './cron-status.service.js'
import { startRuntimeStatusPublisher } from './publisher.service.js'
import { checkAmazonCircuit, recordAmazonOutcome, __resetAmazonPublishGateForTests } from '../amazon-publish-gate.service.js'
import { checkEbayCircuit, recordEbayOutcome, __resetEbayPublishGateForTests } from '../ebay-publish-gate.service.js'
import { registeredCronModules, stopScheduledTasks } from '../../lib/cron/clustered.js'

// The job modules below import the queue module; this suite hands runtime-status its Redis directly.
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }),
    redis: { connection: null },
  }
})

const snapshotOf = (role: 'api' | 'worker' | 'scheduler', instanceId: string, sections: Record<string, unknown>, ready = true) => ({
  v: 1, role, instanceId, pid: 1, startedAt: '2026-09-26T08:00:00.000Z', publishedAt: new Date().toISOString(), ready, sections,
})

async function plant(redis: StatusRedis, snapshot: ReturnType<typeof snapshotOf>, ttlMs = 30_000) {
  const member = `${snapshot.role}:${snapshot.instanceId}`
  await redis.set(snapshotKey(member), JSON.stringify(snapshot), 'PX', ttlMs)
  await redis.sadd(processIndexKey(), member)
}

describe('runtime status (in-memory Redis stand-in)', () => {
  let redis: FakeStatusRedis
  let clock = Date.now()
  beforeEach(() => {
    redis = new FakeStatusRedis()
    clock = Date.now()
    redis.now = () => clock
    setStatusRedisForTests(redis)
    setStatusKeyPrefixForTests(`test:${randomUUID()}`)
    __resetCircuitGenerationsForTests()
    __resetAmazonPublishGateForTests()
  })
  afterEach(() => {
    setStatusRedisForTests(undefined)
    setStatusKeyPrefixForTests(undefined)
  })

  it('publishes only flag-shaped values, never a secret that shares the prefix', () => {
    const flags = flagSection({
      NEXUS_ENABLE_FORECAST_CRON: '1', NEXUS_DISABLE_OBSERVABILITY_RETENTION: 'true', ENABLE_QUEUE_WORKERS: '1',
      NEXUS_ENABLE_WEIRD: 'postgres://user:secret@host/db', AMAZON_REFRESH_TOKEN: 'Atzr|secret', DATABASE_URL: 'postgres://x',
    })
    expect(flags).toEqual({
      NEXUS_ENABLE_FORECAST_CRON: '1', NEXUS_DISABLE_OBSERVABILITY_RETENTION: 'true', ENABLE_QUEUE_WORKERS: '1', NEXUS_ENABLE_WEIRD: '[set]',
    })
  })

  it('a reader sees live snapshots, drops expired and malformed ones, and prunes the index', async () => {
    await plant(redis, snapshotOf('worker', 'w1', {}), 10_000)
    await plant(redis, snapshotOf('scheduler', 's1', {}), 60_000)
    await redis.set(snapshotKey('worker:bad'), '{"v":2}', 'PX', 60_000)
    await redis.sadd(processIndexKey(), 'worker:bad')
    let live = await readLiveProcesses()
    expect(live.snapshots.map(s => `${s.role}:${s.instanceId}`)).toEqual([`api:${buildLocalSnapshot().instanceId}`, 'worker:w1', 'scheduler:s1'])
    clock += 11_000
    live = await readLiveProcesses()
    expect(live.snapshots.map(s => s.role)).toEqual(['api', 'scheduler'])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(await redis.smembers(processIndexKey())).not.toContain('worker:w1')
  })

  it('with Redis out of reach, every other process is unknown and the reason says Redis', async () => {
    setStatusRedisForTests(null)
    registerCircuitSection()
    const live = await readLiveProcesses()
    expect(live.redisUnavailable).toBeTruthy()
    const circuits = aggregateCircuits(live)
    expect(circuits.AMAZON.state).toBe('unknown')
    expect(circuits.AMAZON.unknown.map(u => u.owner)).toEqual(['worker', 'scheduler'])
    expect(circuits.AMAZON.unknown[0].reason).toContain('Redis')
  })

  it('an open circuit anywhere wins; half-open outranks closed; the busiest closed key is reported', () => {
    const entry = (state: string, failureCount: number) => ({ state, failureCount, openedAt: state === 'closed' ? null : '2026-09-26T09:00:00.000Z' })
    const live = {
      redisUnavailable: null,
      snapshots: [
        snapshotOf('api', 'a', { circuits: { channels: { AMAZON: { k1: entry('closed', 2) }, EBAY: { k: entry('half-open', 3) }, SHOPIFY: {} } } }),
        snapshotOf('worker', 'w', { circuits: { channels: { AMAZON: { k2: entry('open', 3) }, EBAY: {}, SHOPIFY: { k: entry('closed', 1) } } } }),
        snapshotOf('scheduler', 's', { circuits: { channels: { AMAZON: {}, EBAY: {}, SHOPIFY: { k: entry('closed', 2) } } } }),
      ],
    } as Parameters<typeof aggregateCircuits>[0]
    const out = aggregateCircuits(live)
    expect(out.AMAZON).toMatchObject({ state: 'open', failureCount: 3, keyCount: 2, complete: true })
    expect(out.EBAY).toMatchObject({ state: 'half-open', failureCount: 3 })
    expect(out.SHOPIFY).toMatchObject({ state: 'closed', failureCount: 2, keyCount: 2 })
  })

  it('a process resets its own circuits when the reset generation moves, and publishes what it applied', async () => {
    registerCircuitSection()
    for (let i = 0; i < 3; i++) recordAmazonOutcome('SELLER', 'APJ6JRA9NG5V4', false)
    expect(checkAmazonCircuit('SELLER', 'APJ6JRA9NG5V4').ok).toBe(false)

    expect(await applyRequestedCircuitResets()).toEqual([]) // first contact only records the generations
    expect(checkAmazonCircuit('SELLER', 'APJ6JRA9NG5V4').ok).toBe(false)

    await redis.incr(circuitResetKey('AMAZON'))
    expect(await applyRequestedCircuitResets()).toEqual(['AMAZON'])
    expect(checkAmazonCircuit('SELLER', 'APJ6JRA9NG5V4')).toMatchObject({ ok: true, state: 'closed' })
    expect(buildLocalSnapshot().sections.circuits).toMatchObject({ resetApplied: { AMAZON: 1, EBAY: 0, SHOPIFY: 0 } })
    expect(await applyRequestedCircuitResets()).toEqual([])
  })

  it('requesting one channel\'s reset never replays another channel\'s old reset in this process', async () => {
    __resetEbayPublishGateForTests()
    registerCircuitSection()
    for (let i = 0; i < 3; i++) recordEbayOutcome('conn-1', 'EBAY_DE', false)
    await redis.incr(circuitResetKey('EBAY')) // an old eBay reset, from before this process first looked
    const outcome = await requestCircuitReset('AMAZON', { waitMs: 0 })
    expect(outcome).toMatchObject({ recorded: true, generation: 1 })
    await applyRequestedCircuitResets()
    expect(checkEbayCircuit('conn-1', 'EBAY_DE').ok).toBe(false)
  })

  it('without Redis a reset is not reported as recorded: only this process was reset', async () => {
    setStatusRedisForTests(null)
    for (let i = 0; i < 3; i++) recordAmazonOutcome('SELLER', 'APJ6JRA9NG5V4', false)
    const outcome = await requestCircuitReset('AMAZON', { waitMs: 0 })
    expect(outcome).toMatchObject({ recorded: false, generation: null, complete: false })
    expect(outcome.reason).toContain('only this api process was reset')
    expect(checkAmazonCircuit('SELLER', 'APJ6JRA9NG5V4').ok).toBe(true)
  })

  it('the publisher writes this process\'s snapshot and withdraws it on stop', async () => {
    registerStatusSection('probe', () => ({ ok: true }))
    const stop = startRuntimeStatusPublisher({ intervalMs: 60_000 })
    await vi.waitFor(async () => expect(await redis.smembers(processIndexKey())).toHaveLength(1))
    const [member] = await redis.smembers(processIndexKey())
    const snapshot = JSON.parse((await redis.get(snapshotKey(member)))!)
    expect(snapshot).toMatchObject({ v: 1, role: 'api', sections: { probe: { ok: true }, scheduledJobs: expect.any(Array), flags: expect.any(Object), circuits: expect.any(Object) } })
    await stop()
    expect(await redis.smembers(processIndexKey())).toEqual([])
    expect(await redis.get(snapshotKey(member))).toBeNull()
  })

  it('"scheduled" is true / false / unknown — never false for a scheduler that is not reporting or still starting', () => {
    const live = (snapshots: ReturnType<typeof snapshotOf>[]) => ({ redisUnavailable: null, snapshots: [snapshotOf('api', 'a', {}), ...snapshots] }) as Parameters<typeof resolveScheduled>[0]
    expect(resolveScheduled(live([]), 'jobs/x.job')).toMatchObject({ value: null, unknown: { owner: 'scheduler' } })
    expect(resolveScheduled(live([snapshotOf('scheduler', 's', { scheduledJobs: [] }, false)]), 'jobs/x.job').value).toBeNull()
    expect(resolveScheduled(live([snapshotOf('scheduler', 's', { scheduledJobs: ['jobs/x.job'] }, false)]), 'jobs/x.job').value).toBe(true)
    expect(resolveScheduled(live([snapshotOf('scheduler', 's', { scheduledJobs: [] })]), 'jobs/x.job').value).toBe(false)
    expect(resolveScheduled(live([snapshotOf('scheduler', 's', {})]), 'jobs/x.job').value).toBeNull() // an older scheduler without the list
  })

  it('reads counts from recorded summaries only where the job wrote them', () => {
    expect(summaryCount('released=4', 'released')).toBe(4)
    expect(summaryCount('scanned=5 updated=2 unchanged=3', 'updated')).toBe(2)
    expect(summaryCount('scanned=5 notupdated=2', 'updated')).toBeNull()
    expect(summaryCount(null, 'updated')).toBeNull()
    expect(leadingCount('3 POs from 12 eligible recs (errors=0)', /^(\d+) POs from/)).toBe(3)
    expect(leadingCount('no-summary', /^(\d+) POs from/)).toBeNull()
  })
})

describe('the cron modules the API reports are the ones the scheduler registers', () => {
  const start: Record<keyof typeof CRON_JOBS, () => Promise<void>> = {
    leadTimeStats: async () => (await import('../../jobs/lead-time-stats.job.js')).startLeadTimeStatsCron(),
    stockoutDetector: async () => (await import('../../jobs/stockout-detector.job.js')).startStockoutDetectorCron(),
    fbaRestock: async () => (await import('../../jobs/fba-restock-ingestion.job.js')).startFbaRestockCron(),
    autoPo: async () => (await import('../../jobs/auto-po-replenishment.job.js')).startAutoPoCron(),
    forecastAccuracy: async () => (await import('../../jobs/forecast-accuracy.job.js')).startForecastAccuracyCron(),
    abcClassification: async () => (await import('../../jobs/abc-classification.job.js')).startAbcClassificationCron(),
    automationRuleEvaluator: async () => (await import('../../jobs/automation-rule-evaluator.job.js')).startAutomationRuleEvaluatorCron(),
    fbaStatusPoll: async () => (await import('../../jobs/fba-status-poll.job.js')).startFbaStatusPollCron(),
    syncDriftDetection: async () => (await import('../../jobs/sync-drift-detection.job.js')).startSyncDriftDetectionCron(),
    reservationSweep: async () => (await import('../../jobs/reservation-sweep.job.js')).startReservationSweepCron(),
    advertisingRuleEvaluator: async () => (await import('../../jobs/advertising-rule-evaluator.job.js')).startAdvertisingRuleEvaluatorCron(),
  }
  afterAll(() => stopScheduledTasks())

  for (const [key, spec] of Object.entries(CRON_JOBS) as Array<[keyof typeof CRON_JOBS, (typeof CRON_JOBS)[keyof typeof CRON_JOBS]]>) {
    it(`${spec.module} registers as "${spec.module}" and records runs as "${spec.jobName}"`, async () => {
      await stopScheduledTasks()
      expect(registeredCronModules()).toEqual([])
      await start[key]()
      expect(registeredCronModules()).toEqual([spec.module])
      const source = readFileSync(fileURLToPath(new URL(`../../${spec.module}.ts`, import.meta.url)), 'utf8')
      expect(source).toContain(`recordCronRun('${spec.jobName}'`)
    }, 60_000)
  }

  it('the Autopilot sync worker adds its section to the snapshot where it starts', async () => {
    const { initializeSyncWorker } = await import('../../workers/sync.worker.js')
    expect(buildLocalSnapshot().sections.syncWorker).toBeUndefined()
    initializeSyncWorker()
    expect(buildLocalSnapshot().sections.syncWorker).toMatchObject({ isRunning: true, totalSyncsProcessed: 0 })
    expect(registeredCronModules()).toContain('workers/sync.worker')
  })
})

describe.skipIf(!process.env.NEXUS_TEST_REDIS_URL)('runtime status against Redis', () => {
  let redis: Redis
  const prefix = `test:runtime-status:${randomUUID()}`
  beforeAll(async () => {
    redis = new Redis(process.env.NEXUS_TEST_REDIS_URL!, { lazyConnect: true, maxRetriesPerRequest: 1 })
    await redis.connect()
    setStatusRedisForTests(redis as unknown as StatusRedis)
    setStatusKeyPrefixForTests(prefix)
    __resetCircuitGenerationsForTests()
    __resetAmazonPublishGateForTests()
  })
  afterAll(async () => {
    const keys = await redis.keys(`${prefix}:*`)
    if (keys.length) await redis.del(...keys)
    setStatusRedisForTests(undefined)
    setStatusKeyPrefixForTests(undefined)
    redis.disconnect()
  })

  it('a snapshot is visible while its key lives and gone once it expires', async () => {
    await plant(redis as unknown as StatusRedis, snapshotOf('worker', 'short', {}), 300)
    expect((await readLiveProcesses()).snapshots.map(s => s.instanceId)).toContain('short')
    await new Promise(resolve => setTimeout(resolve, 400))
    expect((await readLiveProcesses()).snapshots.map(s => s.instanceId)).not.toContain('short')
    await vi.waitFor(async () => expect(await redis.smembers(processIndexKey())).not.toContain('worker:short'))
  })

  it('a reset recorded by one process is applied by another on its next tick', async () => {
    registerCircuitSection()
    expect(await applyRequestedCircuitResets()).toEqual([])
    for (let i = 0; i < 3; i++) recordAmazonOutcome('SELLER', 'A1PA6795UKMFR9', false)
    expect(checkAmazonCircuit('SELLER', 'A1PA6795UKMFR9').ok).toBe(false)
    expect(await redis.incr(circuitResetKey('AMAZON'))).toBe(1)
    expect(await applyRequestedCircuitResets()).toEqual(['AMAZON'])
    expect(checkAmazonCircuit('SELLER', 'A1PA6795UKMFR9').ok).toBe(true)
  })
})
