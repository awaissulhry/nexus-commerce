/**
 * ADS AUTONOMY W4-7 — the budget pool routes and the budget baseline restore answer byte for byte as before their logic
 * moved out of advertising.routes.ts into services, which Claude's set-budget-pool and restore-budget-baselines call:
 *   GET    /advertising/budget-pools                                 → listBudgetPools        (ads-budget-pool.service.ts)
 *   GET    /advertising/budget-pools/:id                             → getBudgetPool
 *   POST   /advertising/budget-pools                                 → createBudgetPool
 *   DELETE /advertising/budget-pools/:id                             → deleteBudgetPool
 *   POST   /advertising/budget-pools/:id/allocations                 → addPoolAllocation
 *   DELETE /advertising/budget-pools/:id/allocations/:allocationId   → removePoolAllocation
 *   POST   /advertising/budget-pools/:id/rebalance(?preview=1)       → rebalanceBudgetPool
 *   GET    /advertising/budget-pools/:id/history                     → budgetPoolHistory
 *   POST   /advertising/budget-baselines/restore                     → restoreBudgetBaselines (ads-budget-baseline.service.ts)
 *
 * The answers (status, the cache header where one is set, the body) AND the rows each request leaves (the pools, their
 * allocations and rebalances, the campaigns' budgets, every audit row) are recorded. On a real PostgreSQL (PGlite). The
 * snapshot beside this file was WRITTEN BY THE ROUTES BEFORE THE MOVE and is read unchanged after it.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
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
    redis: { connection: null },
  }
})
vi.mock('../services/advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined,
  putCached: () => undefined,
  flushAdsCache: async () => undefined,
}))
// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction; an ads
// row names no listing account anyway (the ads worker resolves its Amazon Ads profile).
vi.mock('../services/outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const ids = new Map<string, string>()
const normalise = (text: string) => text
  .replace(/\bc[a-z0-9]{24}\b/g, (id) => (ids.has(id) ? ids.get(id)! : (ids.set(id, `<id${ids.size + 1}>`), ids.get(id)!)))
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<time>')

let app: FastifyInstance
const answers: string[] = []
const rows = { pool: '', livePool: '', campaignA: '', campaignB: '', campaignC: '', campaignD: '' }

async function ask(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) {
  const res = await app.inject({ method, url, ...(payload ? { payload } : {}), headers: { 'x-actor-id': 'parity-person' } })
  const cache = res.headers['cache-control']
  answers.push(`${method} ${normalise(url)} → ${res.statusCode}${cache ? ` [${String(cache)}]` : ''} ${normalise(res.body)}`)
  return res
}

/** What a request left behind: the pools, their allocations and rebalances, the campaigns' budgets and every audit row. */
async function state(label: string) {
  const db = database.client
  const out = await inside(async () => ({
    pools: await db.budgetPool.findMany({ orderBy: { name: 'asc' }, select: { name: true, description: true, currency: true, totalDailyBudgetCents: true, strategy: true, coolDownMinutes: true, maxShiftPerRebalancePct: true, enabled: true, dryRun: true, createdBy: true, lastRebalancedAt: true } }),
    allocations: await db.budgetPoolAllocation.findMany({ orderBy: [{ marketplace: 'asc' }, { campaignId: 'asc' }], select: { budgetPoolId: true, marketplace: true, campaignId: true, targetSharePct: true, minDailyBudgetCents: true, maxDailyBudgetCents: true } }),
    rebalances: await db.budgetPoolRebalance.findMany({ orderBy: { createdAt: 'asc' }, select: { budgetPoolId: true, triggeredBy: true, inputs: true, outputs: true, dryRun: true, appliedAt: true, totalShiftCents: true } }),
    campaigns: await db.campaign.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, dailyBudget: true, budgetBaselineCents: true } }),
    audit: await db.advertisingActionLog.findMany({ orderBy: [{ createdAt: 'asc' }, { entityId: 'asc' }], select: { userId: true, actionType: true, entityType: true, entityId: true, payloadBefore: true, payloadAfter: true, amazonResponseStatus: true, executionId: true } }),
  }))
  answers.push(`  ${label}: ${normalise(JSON.stringify(out))}`)
}

beforeAll(async () => {
  database = await formulaDatabase()
  const { default: advertisingRoutes } = await import('./advertising.routes.js')
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(business, done))
  await app.register(advertisingRoutes, { prefix: '/api' })
  await app.ready()
  const db = database.client
  await inside(async () => {
    const campaign = (name: string, budget: string, extra: Record<string, unknown> = {}) => db.campaign.create({
      data: { name, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', dailyBudget: budget, startDate: new Date('2026-01-01T00:00:00Z'), marketplace: 'IT', externalCampaignId: `TEST-${name}`, ...extra },
    })
    rows.campaignA = (await campaign('PARITY A', '10.00', { budgetBaselineCents: 1500 })).id
    rows.campaignB = (await campaign('PARITY B', '20.00', { budgetBaselineCents: 2000 })).id
    rows.campaignC = (await campaign('PARITY C', '30.00')).id
    rows.campaignD = (await campaign('PARITY D', '40.00', { marketplace: null })).id
    // A pool switched on in dry run with two campaigns: its rebalance records a dry run and writes nothing.
    rows.livePool = (await db.budgetPool.create({ data: { name: 'PARITY live pool', totalDailyBudgetCents: 6000, enabled: true, dryRun: true } })).id
  })
}, 180_000)
afterAll(async () => {
  await app?.close()
  await database?.close()
}, 30_000)

describe('W4-7 — the budget pool routes and the baseline restore answer as before the move', () => {
  it('every outcome, and the rows each leaves', { timeout: 120_000 }, async () => {
    // ── Pools: list, create, read ──
    await ask('GET', '/api/advertising/budget-pools')
    await ask('POST', '/api/advertising/budget-pools', { name: 'PARITY pool' })
    await ask('POST', '/api/advertising/budget-pools', { totalDailyBudgetCents: 5000 })
    const created = await ask('POST', '/api/advertising/budget-pools', { name: 'PARITY pool', description: 'made for parity', totalDailyBudgetCents: 5000, strategy: 'PROFIT_WEIGHTED', coolDownMinutes: 120, maxShiftPerRebalancePct: 10, currency: 'EUR' })
    rows.pool = (JSON.parse(created.body) as { pool: { id: string } }).pool.id
    await ask('POST', '/api/advertising/budget-pools', { name: 'PARITY pool (defaults)', totalDailyBudgetCents: 3000 })
    await state('pools created')
    await ask('GET', '/api/advertising/budget-pools/nope')
    await ask('GET', `/api/advertising/budget-pools/${rows.pool}`)
    // ── Allocations ──
    await ask('POST', `/api/advertising/budget-pools/${rows.pool}/allocations`, { campaignId: 'nope' })
    await ask('POST', `/api/advertising/budget-pools/${rows.pool}/allocations`, { campaignId: rows.campaignD })
    await ask('POST', `/api/advertising/budget-pools/${rows.pool}/allocations`, { campaignId: rows.campaignA, targetSharePct: 60, minDailyBudgetCents: 200, maxDailyBudgetCents: 5000 })
    await ask('POST', `/api/advertising/budget-pools/${rows.pool}/allocations`, { campaignId: rows.campaignA })
    await ask('POST', `/api/advertising/budget-pools/${rows.livePool}/allocations`, { campaignId: rows.campaignB, targetSharePct: 50 })
    await ask('POST', `/api/advertising/budget-pools/${rows.livePool}/allocations`, { campaignId: rows.campaignC, targetSharePct: 50 })
    await state('allocations added')
    await ask('GET', `/api/advertising/budget-pools/${rows.livePool}`)
    await ask('GET', '/api/advertising/budget-pools')
    const allocation = (await inside(() => database.client.budgetPoolAllocation.findFirst({ where: { campaignId: rows.campaignA } })))!.id
    await ask('DELETE', `/api/advertising/budget-pools/${rows.livePool}/allocations/${allocation}`)
    await ask('DELETE', `/api/advertising/budget-pools/${rows.pool}/allocations/nope`)
    await ask('DELETE', `/api/advertising/budget-pools/${rows.pool}/allocations/${allocation}`)
    await state('allocation removed')
    // ── Rebalance: a disabled pool is skipped (409); a dry-run pool previews and records a dry run ──
    await ask('POST', `/api/advertising/budget-pools/${rows.pool}/rebalance?preview=1`)
    await ask('POST', `/api/advertising/budget-pools/${rows.pool}/rebalance`)
    await ask('POST', `/api/advertising/budget-pools/${rows.livePool}/rebalance?preview=1`)
    await ask('POST', `/api/advertising/budget-pools/${rows.livePool}/rebalance`)
    await state('rebalanced (dry run)')
    await ask('GET', `/api/advertising/budget-pools/${rows.livePool}/history`)
    await ask('GET', `/api/advertising/budget-pools/${rows.livePool}/history?limit=1`)
    await ask('GET', '/api/advertising/budget-pools/nope/history')
    // ── Delete ──
    await ask('DELETE', '/api/advertising/budget-pools/nope')
    await ask('DELETE', `/api/advertising/budget-pools/${rows.pool}`)
    await state('pool deleted')
    // ── Budget baselines: restore ──
    await ask('POST', '/api/advertising/budget-baselines/restore', {})
    await ask('POST', '/api/advertising/budget-baselines/restore', { campaignIds: [] })
    await ask('POST', '/api/advertising/budget-baselines/restore', { campaignIds: [rows.campaignA, rows.campaignB, rows.campaignC, 'nope'] })
    await state('baselines restored')
    await ask('POST', '/api/advertising/budget-baselines/restore', { campaignIds: [rows.campaignA] })
    expect(answers.join('\n')).toMatchSnapshot()
  })
})
