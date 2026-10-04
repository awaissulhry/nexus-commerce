/**
 * P1.8 review (2026-09-23) — the hub's manual trigger keeps a run's completed status.
 *
 * The trigger route records the run itself (one CronRun row, `recordCronRun(…, { triggeredBy: 'manual' })`)
 * and used to reduce every handler result to its summary string, so a PARTIAL contract run triggered by hand
 * would still have been written as SUCCESS. `recordCronRun` is stood in to capture what the route hands it.
 *
 * Group 1 (1e, review 2.4) — Run now on an ads engine passes what the tick passes: this business's switch, the arm flags
 * as the scheduler sees them, and the engine lock. Those entries run the real job functions here (the registry's own
 * lambdas, mirrored); the switch row, the scheduler's heartbeat and the lock's Redis are stand-ins.
 */
import { readFileSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  recorded: [] as Array<{ jobName: string; value: unknown; options: unknown }>,
  results: {} as Record<string, unknown>,
  handlers: {} as Record<string, () => Promise<unknown>>,
  switches: {} as Record<string, { mode: string; reason: string | null; setBy: string; setAt: Date }>,
}))
vi.mock('../db.js', () => ({
  default: { automationSwitch: { findUnique: async ({ where }: { where: { workspace_key: { key: string } } }) => h.switches[where.workspace_key.key] ?? null } },
}))
vi.mock('../services/sync-logs-events.service.js', () => ({ subscribeSyncLogEvents: vi.fn() }))
vi.mock('../jobs/cron-registry.js', () => ({
  CRON_REGISTRY: new Proxy({}, { get: (_target, name: string) => async () => (h.handlers[name] ? h.handlers[name]() : h.results[name]) }),
  isKnownCron: (name: string) => name in h.results || name in h.handlers,
  listKnownCrons: () => [...Object.keys(h.results), ...Object.keys(h.handlers)],
}))
// The engines' own work: stood in, so a Run now that stands down is told apart from one that ran.
const work = vi.hoisted(() => ({
  tos: vi.fn(async () => ({ evaluated: 0, changed: 0, applied: 0, skippedNotAllowlisted: 0 })),
  autoBid: vi.fn(async () => ({ proposed: 4, applied: 4, dryRun: false })),
}))
vi.mock('../services/advertising/ads-top-of-search.service.js', async (importOriginal) => ({ ...(await importOriginal<object>()), defendTopOfSearch: work.tos }))
vi.mock('../services/advertising/ads-auto-bid.service.js', () => ({ runAutoBidOnce: work.autoBid }))
// No real Redis: the job modules' imports reach the queue module; the lock and the heartbeat get stand-ins below.
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
vi.mock('../utils/cron-observability.js', () => ({
  recordCronRun: vi.fn(async (jobName: string, handler: () => Promise<unknown>, options: unknown) => {
    const value = await handler()
    h.recorded.push({ jobName, value, options })
    return value
  }),
}))
const Fastify = (await import('fastify')).default
const routes = (await import('./sync-logs.routes.js')).default

async function trigger(jobName: string) {
  const app = Fastify()
  await app.register(routes)
  try {
    const res = await app.inject({ method: 'POST', url: `/sync-logs/cron/${jobName}/trigger` })
    await vi.waitFor(() => expect(h.recorded.some((r) => r.jobName === jobName)).toBe(true))
    return { res, recorded: h.recorded.find((r) => r.jobName === jobName)! }
  } finally { await app.close() }
}

beforeEach(() => { h.recorded = []; h.results = {}; h.handlers = {}; h.switches = {} })

describe('manual trigger → recordCronRun', () => {
  it('a result carrying cronStatus reaches recordCronRun with it (PARTIAL stays PARTIAL)', async () => {
    h.results['channel-contract-run'] = { summary: '5/11 required operations proven — Partial, not green.', cronStatus: 'PARTIAL' }
    const { res, recorded } = await trigger('channel-contract-run')
    expect(res.statusCode).toBe(202)
    expect(recorded.value).toEqual({ summary: '5/11 required operations proven — Partial, not green.', cronStatus: 'PARTIAL' })
    expect(recorded.options).toEqual({ triggeredBy: 'manual' })
  })
  it('every other result shape is unchanged: a string, a {summary}, and nothing at all', async () => {
    h.results['a-string'] = 'did 3 things'
    h.results['a-summary'] = { summary: 'did 4 things', extra: 1 }
    h.results['nothing'] = undefined
    expect((await trigger('a-string')).recorded.value).toBe('did 3 things')
    expect((await trigger('a-summary')).recorded.value).toEqual({ summary: 'did 4 things' })
    expect((await trigger('nothing')).recorded.value).toBe('manual trigger')
  })
})

describe('1e — Run now honours the business switch, the scheduler\'s arm flag and the engine lock', async () => {
  const { setStatusRedisForTests } = await import('../lib/runtime-status/process-snapshot.js')
  const lock = await import('../services/advertising/ads-engine-lock.js')
  const { runTosDefenseOnce } = await import('../jobs/ads-tos-defense.job.js')
  const { runRankDefendOnce, rankDefendSummaryLine } = await import('../jobs/ad-rank-defend.job.js')
  const { runAutoBidLiveOnce } = await import('../jobs/ads-sync.job.js')
  const { LEGACY_WORKSPACE_ID } = await import('../lib/workspace-context.js')

  /** The scheduler's heartbeat, carrying the flags it sees. */
  const schedulerFlags = (flags: Record<string, string>) => {
    const snapshot = JSON.stringify({ v: 1, role: 'scheduler', instanceId: 'sched-1', pid: 1, startedAt: new Date().toISOString(), publishedAt: new Date().toISOString(), ready: true, sections: { flags } })
    setStatusRedisForTests({ status: 'ready', set: async () => 'OK', sadd: async () => 1, srem: async () => 1, del: async () => 1, incr: async () => 1, smembers: async () => ['scheduler:sched-1:1'], mget: async () => [snapshot] })
  }
  /** The lock's Redis: claim only when free, release only by the holder. `held` = a tick holds it now. */
  const lockRedis = (held: string[] = []) => {
    const keys = new Map(held.map((k) => [k, 'the-tick']))
    lock.setEngineLockStoreForTests({
      status: 'ready',
      eval: async (script: string, _n: number, key: string, token: string) => {
        if (script.includes("'NX'")) { if (keys.has(key)) return 0; keys.set(key, token); return 1 }
        if (keys.get(key) !== token) return 0
        if (script.includes("'del'")) keys.delete(key)
        return 1
      },
    })
    return keys
  }
  const ARMED = { NEXUS_ENABLE_AMAZON_ADS_CRON: 'true', NEXUS_ENABLE_RANK_DEFEND: '1' }

  beforeEach(() => { work.tos.mockClear(); work.autoBid.mockClear(); schedulerFlags(ARMED); lockRedis() })
  afterAll(() => { setStatusRedisForTests(undefined); lock.setEngineLockStoreForTests(undefined) })

  it('an engine switched OFF for this business: the run records "skipped: …" in words, and nothing runs', async () => {
    h.switches['tos-defense'] = { mode: 'OFF', reason: null, setBy: 'user:u-1e', setAt: new Date() }
    schedulerFlags({ ...ARMED, NEXUS_ENABLE_TOS_DEFENSE_CRON: '1' })
    h.handlers['top-of-search-defense'] = () => runTosDefenseOnce() // the registry's entry
    const { res, recorded } = await trigger('top-of-search-defense')
    expect(res.statusCode).toBe(202)
    expect(recorded.value).toBe('skipped: Top-of-Search defense is switched off for this business (by user:u-1e)')
    expect(recorded.options).toEqual({ triggeredBy: 'manual' })
    expect(work.tos).not.toHaveBeenCalled()
  })

  it('an engine the scheduler has not armed (top-of-search defense today): "skipped: … off on the server"', async () => {
    h.handlers['top-of-search-defense'] = () => runTosDefenseOnce()
    expect((await trigger('top-of-search-defense')).recorded.value).toBe("skipped: Top-of-Search defense is switched off on the server (the scheduler's NEXUS_ENABLE_TOS_DEFENSE_CRON is not on)")
    expect(work.tos).not.toHaveBeenCalled()
  })

  it('Run now while a tick holds the lock: "skipped: a run is already in progress" — never a second run beside it', async () => {
    lockRedis([lock.engineLockKey(LEGACY_WORKSPACE_ID, 'rank-defend')])
    h.handlers['ad-rank-defend'] = async () => rankDefendSummaryLine(await runRankDefendOnce()) // the registry's entry
    expect((await trigger('ad-rank-defend')).recorded.value).toBe('skipped: a run is already in progress')
  })

  it('on, armed and free: Run now runs exactly as before, and gives the lock back', async () => {
    const keys = lockRedis()
    h.handlers['ads-auto-bid'] = () => runAutoBidLiveOnce() // the registry's entry
    expect((await trigger('ads-auto-bid')).recorded.value).toBe('proposed=4 applied=4 dryRun=false')
    expect(work.autoBid).toHaveBeenCalledTimes(1)
    expect(keys.size).toBe(0)
  })

  it('the registry\'s ads entries are the guarded functions and the ticks\' own summary lines', () => {
    const registry = readFileSync(new URL('../jobs/cron-registry.ts', import.meta.url), 'utf8')
    expect(registry).toContain("'ad-rank-defend': () => import('./ad-rank-defend.job.js').then(async (m) => m.rankDefendSummaryLine(await m.runRankDefendOnce()))")
    expect(registry).toContain("'ad-dayparting': async () => daypartingSummaryLine(await runDaypartingOnce())")
    expect(registry).toContain("'ads-auto-bid': () => runAutoBidLiveOnce()")
    expect(registry).toContain("'top-of-search-defense': () => runTosDefenseOnce()")
    expect(registry).toContain("'ad-budget-enforce': () => import('./ad-budget-enforce.job.js').then((m) => m.runBudgetEnforceOnce())")
    // The unguarded auto-bid service is no longer called from here.
    expect(registry).not.toMatch(/runAutoBidOnce\(/)
  })
})
