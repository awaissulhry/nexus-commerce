/**
 * R2 (MCP full control, part 06 gap 11) — every ads write carries the actor that caused it, in the two shapes the
 * readers understand: `automation:<engine or rule id>` for a machine and `user:<id>` for a person. The explain step
 * ("why did this bid move"), a rule's daily write cap, its "wrote" column and the Control Room's engine evidence all
 * match on that string exactly.
 *
 * What was wrong:
 *   · the budget-pool cron wrote `user:cron-budget-pool` — a PERSON named "cron-budget-pool"; the Control Room looks
 *     for `automation:budget-pool-rebalance`
 *   · budget pacing with no actor wrote the bare `budget-pacing` — also read as a person
 *   · the retail guard prefixed `automation:` again, so its rule wrote `automation:automation:<ruleId>`
 *   · a person's Apply on a recommendation, or a call to the bid-optimizer / pacing apply routes, carried no person:
 *     the writes said `automation:bid-optimizer` / `budget-pacing`, or whatever actor the request body named
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const db = vi.hoisted(() => ({
  budgetPool: { findMany: vi.fn(async () => [{ id: 'pool-1', dryRun: false }]) },
  // 1d — a live pool reads the account dial and today's changes first (ads-engine-guard.ts): AUTO, none yet.
  adsAutomationState: { upsert: vi.fn(async () => ({ autonomy: 'AUTO', halted: false })) },
  advertisingActionLog: { count: vi.fn(async () => 0) },
  // W1-6 — and each market's own cap per run from the ads strategy: none set.
  adsStrategy: { findMany: vi.fn(async () => []) },
}))
vi.mock('../../db.js', () => ({ default: db }))
vi.mock('./ads-mutation.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  bulkUpdateAdTargetBids: vi.fn(async () => ({ applied: 1, skipped: 0, failed: 0, outcomes: [], chunks: 1 })),
  updateCampaignWithSync: vi.fn(async () => ({ ok: true, outboundQueueId: 'q1' })),
}))
vi.mock('./ads-bid-suppression.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  suppressCampaignBids: vi.fn(async () => ({ ok: true })),
}))
vi.mock('./budget-pool-rebalancer.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  rebalanceAndAudit: vi.fn(async () => ({ ok: true, skipped: 'cool_down', proposed: [], totalShiftCents: 0, auditId: null })),
}))
// The routes plugin reaches the queue module; nothing here may open a Redis connection.
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
vi.mock('./ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined,
  putCached: () => undefined,
  flushAdsCache: async () => undefined,
}))

const { bulkUpdateAdTargetBids, updateCampaignWithSync } = await import('./ads-mutation.service.js')
const { suppressCampaignBids } = await import('./ads-bid-suppression.service.js')
const { rebalanceAndAudit } = await import('./budget-pool-rebalancer.service.js')
const { adsActorOf } = await import('./ads-actor.js')
const { applyPacing } = await import('./ads-budget-pacing.service.js')
const { applyRetailGuard } = await import('./ads-retail-readiness.service.js')
const { applyRecommendation } = await import('./ads-recommendations.service.js')
const { runBudgetPoolRebalanceOnce } = await import('../../jobs/budget-pool-rebalance.job.js')

const bidActor = () => vi.mocked(bulkUpdateAdTargetBids).mock.calls.at(-1)?.[0]?.actor
const budgetActor = () => (vi.mocked(updateCampaignWithSync).mock.calls.at(-1)?.[0] as { actor?: string } | undefined)?.actor
const suppressActor = () => (vi.mocked(suppressCampaignBids).mock.calls.at(-1)?.[1] as { actor?: string } | undefined)?.actor
const RULE = 'automation:cmehif9xk0001s6mvabcd1234'

beforeEach(() => vi.clearAllMocks())

describe('adsActorOf — one namespacing rule for every ads writer', () => {
  it('keeps a person and a machine as they are, namespaces a bare engine name once, and names the engine when absent', () => {
    expect(adsActorOf('user:u7', 'x')).toBe('user:u7')
    expect(adsActorOf(RULE, 'x')).toBe(RULE)
    expect(adsActorOf('automation:auto-bid', 'x')).toBe('automation:auto-bid')
    expect(adsActorOf('retail-guard-cron', 'x')).toBe('automation:retail-guard-cron')
    expect(adsActorOf(undefined, 'budget-pacing')).toBe('automation:budget-pacing')
    expect(adsActorOf(null, 'budget-pacing')).toBe('automation:budget-pacing')
    expect(adsActorOf('', 'budget-pacing')).toBe('automation:budget-pacing')
  })
})

describe('the engines name themselves', () => {
  it('the budget-pool cron writes as the engine the Control Room looks for, not as a person', async () => {
    await runBudgetPoolRebalanceOnce()
    expect(vi.mocked(rebalanceAndAudit)).toHaveBeenCalledWith(expect.objectContaining({ poolId: 'pool-1', triggeredBy: 'cron', actor: 'automation:budget-pool-rebalance' }))
  })

  it('budget pacing with no actor writes as the pacing engine; a rule and a person pass through unchanged', async () => {
    const one = [{ campaignId: 'c1', proposedBudgetCents: 1250 }]
    await applyPacing({ changes: one })
    expect(budgetActor()).toBe('automation:budget-pacing')
    await applyPacing({ changes: one, actor: RULE })
    expect(budgetActor()).toBe(RULE)
    await applyPacing({ changes: one, actor: 'user:u7' })
    expect(budgetActor()).toBe('user:u7')
  })

  it('the retail guard does not prefix its rule\'s actor twice; its cron and default keep their names', async () => {
    await applyRetailGuard({ campaignIds: ['c1'], actor: RULE })
    expect(suppressActor()).toBe(RULE)
    await applyRetailGuard({ campaignIds: ['c1'], actor: 'retail-guard-cron' })
    expect(suppressActor()).toBe('automation:retail-guard-cron')
    await applyRetailGuard({ campaignIds: ['c1'] })
    expect(suppressActor()).toBe('automation:retail-guard')
  })

  it('a recommendation applied for a person carries that person on its bid, budget and retail-guard writes', async () => {
    await applyRecommendation({ kind: 'bid', payload: { changes: [{ targetId: 't1', proposedBidCents: 30 }] }, userId: 'user:u7' })
    expect(bidActor()).toBe('user:u7')
    await applyRecommendation({ kind: 'budget', payload: { changes: [{ campaignId: 'c1', proposedBudgetCents: 1250 }] }, userId: 'user:u7' })
    expect(budgetActor()).toBe('user:u7')
    await applyRecommendation({ kind: 'retail-pause', payload: { campaignIds: ['c1'] }, userId: 'user:u7' })
    expect(suppressActor()).toBe('user:u7')
  })
})

describe('the apply routes write as the person who called them', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    const { default: advertisingRoutes } = await import('../../routes/advertising.routes.js')
    app = Fastify()
    await app.register(advertisingRoutes, { prefix: '/api' })
    await app.ready()
  }, 60_000)

  it('Apply on a recommendation', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/advertising/recommendations/apply', headers: { 'x-actor-id': 'u7' },
      payload: { kind: 'bid', payload: { changes: [{ targetId: 't1', proposedBidCents: 30 }] } },
    })
    expect(res.statusCode).toBe(200)
    expect(bidActor()).toBe('user:u7')
  })

  it('the bid-optimizer and pacing apply routes: the caller, never an actor named in the body', async () => {
    let res = await app.inject({
      method: 'POST', url: '/api/advertising/bid-optimizer/apply', headers: { 'x-actor-id': 'u7' },
      payload: { changes: [{ targetId: 't1', proposedBidCents: 30 }], actor: RULE },
    })
    expect(res.statusCode).toBe(200)
    expect(bidActor()).toBe('user:u7')
    res = await app.inject({
      method: 'POST', url: '/api/advertising/pacing/apply', headers: { 'x-actor-id': 'u7' },
      payload: { changes: [{ campaignId: 'c1', proposedBudgetCents: 1250 }], actor: RULE },
    })
    expect(res.statusCode).toBe(200)
    expect(budgetActor()).toBe('user:u7')
  })
})
