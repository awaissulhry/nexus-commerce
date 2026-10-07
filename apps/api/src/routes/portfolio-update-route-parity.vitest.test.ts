/**
 * ADS AUTONOMY W4-3 — PATCH /advertising/portfolios/:id (the Portfolios page's Rename, Set budget and Archive) answers
 * byte for byte as before its body check moved into portfolioUpdateOf (ads-portfolio.service.ts), which set-portfolio
 * uses too: one set of rules, never a second.
 *
 * On a real PostgreSQL (PGlite). The snapshot beside this file was WRITTEN BY THE ROUTE BEFORE THE MOVE and is read
 * unchanged after it. Made-up names; no Amazon connection, so every write stays in Nexus (mode local).
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

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }

let app: FastifyInstance
beforeAll(async () => {
  database = await formulaDatabase()
  const { default: advertisingRoutes } = await import('./advertising.routes.js')
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(business, done))
  await app.register(advertisingRoutes, { prefix: '/api' })
  await app.ready()
  await withWorkspace(business, async () => {
    await database.client.amazonAdsPortfolio.create({ data: { profileId: 'TEST-PROFILE-1', externalPortfolioId: 'TEST-PF-1', name: 'PARITY portfolio', state: 'ENABLED' } })
  })
}, 180_000)
afterAll(async () => {
  await app?.close()
  await database?.close()
}, 30_000)

describe('W4-3 — the portfolio route answers as before the move', () => {
  it('every outcome, and what Nexus holds after', async () => {
    const answers: string[] = []
    const send = async (id: string, payload: object) => {
      const res = await app.inject({ method: 'PATCH', url: `/api/advertising/portfolios/${id}`, payload })
      answers.push(`${JSON.stringify(payload)} → ${res.statusCode} ${res.body}`)
    }
    await send('TEST-PF-1', {})
    await send('TEST-PF-1', { name: '   ' })
    await send('TEST-PF-1', { budget: { amount: 0, policy: 'monthlyRecurring' } })
    await send('TEST-PF-1', { budget: { amount: '50', policy: 'monthlyRecurring' } })
    await send('TEST-PF-1', { budget: { amount: 100, policy: 'weekly' } })
    await send('TEST-PF-1', { budget: { amount: 100, policy: 'dateRange', startDate: '2026-11-01' } })
    await send('TEST-PF-1', { budget: { amount: 100, policy: 'dateRange', endDate: '2026-11-30' } })
    await send('NO-SUCH-PF', { name: 'PARITY elsewhere' })
    await send('TEST-PF-1', { name: '  PARITY renamed  ', ignored: true })
    await send('TEST-PF-1', { budget: { amount: 250, policy: 'monthlyRecurring' } })
    await send('TEST-PF-1', { budget: { amount: 300.5, currencyCode: 'GBP', policy: 'dateRange', startDate: '2026-11-01', endDate: '2026-11-30' } })
    await send('TEST-PF-1', { state: 'archived' })
    const row = await withWorkspace(business, () => database.client.amazonAdsPortfolio.findFirstOrThrow({
      where: { externalPortfolioId: 'TEST-PF-1' },
      select: { name: true, state: true, budgetAmount: true, budgetCurrencyCode: true, budgetPolicy: true, startDate: true, endDate: true },
    }))
    answers.push(`row ${JSON.stringify(row)}`)
    expect(answers.join('\n')).toMatchSnapshot()
  })
})
