/**
 * Reviews Insights (PR E) — the routes in reviews.routes.ts reach their services and answer in words: the reads with
 * their scope, 404 for an unknown product, 400 for a bad bulk body, and every write's actor is the signed-in person —
 * a call without one (an API key) is refused with 403, never attributed to a body field. Real SQL (PGlite with the
 * production schema and policies) and the real route plugin; nothing leaves this machine.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
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
    redis: { connection: null },
  }
})

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }

describe('Reviews Insights routes', () => {
  let app: FastifyInstance
  let signedIn = true
  const call = async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => {
    const response = await app.inject({ method, url: `/api${url}`, ...(payload !== undefined ? { payload: payload as object } : {}) })
    return { status: response.statusCode, body: JSON.parse(response.body || '{}') }
  }

  beforeAll(async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    database = await formulaDatabase()
    await withWorkspace(business, async () => {
      await database.client.product.create({ data: { id: 'test-jacket', sku: 'TEST-JKT', name: 'Test jacket', basePrice: 10 } as never })
      await database.client.reviewSpike.create({
        data: { id: 's1', productId: 'test-jacket', marketplace: 'DE', category: 'FIT_SIZING', rate7dNumerator: 5, rate7dDenominator: 20, rate28dNumerator: 4, rate28dDenominator: 80, status: 'OPEN' } as never,
      })
    })
    const { default: reviewsRoutes } = await import('./reviews.routes.js')
    app = Fastify()
    app.addHook('preHandler', (request, _reply, done) => {
      if (signedIn) (request as unknown as { authUser: unknown }).authUser = { id: 'test-user', email: 'person@example.test' }
      withWorkspace(business, done)
    })
    await app.register(reviewsRoutes, { prefix: '/api' })
    await app.ready()
  }, 120_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    await app?.close()
    await database?.close()
  })

  it('reads answer with their scope', async () => {
    const themes = await call('GET', '/reviews/insights/themes?channel=amazon&market=nl&period=90d&sort=impact')
    expect(themes.status).toBe(200)
    expect(themes.body.scope).toEqual({ channel: 'AMAZON', market: 'NL', period: '90d', sort: 'impact' })
    expect(themes.body.amazon.notOffered).toMatch(/Amazon\.nl/)
    const products = await call('GET', '/reviews/insights/products?page=1&pageSize=10')
    expect(products).toMatchObject({ status: 200, body: { page: 1, pageSize: 10, families: [] } })
    expect((await call('GET', '/reviews/insights/products/nope')).status).toBe(404)
    const heat = await call('GET', '/reviews/heatmap?channel=EBAY&metric=negativeShare&period=7d')
    expect(heat.body).toMatchObject({ channel: 'EBAY', metric: 'negativeShare', sinceDays: 7 })
    const spikes = await call('GET', '/reviews/spikes?status=OPEN')
    expect(spikes.body).toMatchObject({ count: 1, counts: { open: 1 } })
    expect((await call('GET', '/reviews/action-items')).body).toMatchObject({ count: 0, counts: { OPEN: 0 } })
    expect((await call('GET', '/reviews/spotlight/scopes?period=7d')).body).toMatchObject({ windowDays: 7, minReviews: 20 })
    expect((await call('GET', '/reviews/spotlight/history')).body).toEqual({ items: [] })
  })

  it('writes take the signed-in person as the actor and refuse in words', async () => {
    expect(await call('PATCH', '/reviews/spikes/s1', { status: 'ACKNOWLEDGED', actor: 'someone-else' })).toMatchObject({ status: 200, body: { spike: { status: 'ACKNOWLEDGED', acknowledgedBy: 'test-user' } } })
    expect(await call('PATCH', '/reviews/spikes/s1', { status: 'ACKNOWLEDGED' })).toMatchObject({ status: 409, body: { error: 'Already acknowledged.' } })
    expect(await call('PATCH', '/reviews/spikes/s1', { status: 'DELETE' })).toMatchObject({ status: 400 })
    expect(await call('POST', '/reviews/spikes/bulk', { ids: ['s1'], action: 'acknowledge' })).toMatchObject({ status: 200, body: { changed: 0, held: [{ id: 's1', words: 'Already acknowledged.' }] } })
    expect(await call('POST', '/reviews/spikes/bulk', { action: 'resolve' })).toMatchObject({ status: 400, body: { error: 'ids: tick at least one row.' } })
    expect(await call('POST', '/reviews/action-items/suggest', {})).toMatchObject({ status: 400 })
    expect(await call('POST', '/reviews/action-items/nope/withdraw')).toMatchObject({ status: 404 })
    expect(await call('POST', '/reviews/spotlight/generate', {})).toMatchObject({ status: 409, body: { held: true, reason: 'too_few' } })
    signedIn = false
    try {
      expect(await call('PATCH', '/reviews/spikes/s1', { status: 'RESOLVED' })).toMatchObject({ status: 403 })
      expect(await call('POST', '/reviews/action-items/nope/task')).toMatchObject({ status: 403 })
      expect(await call('POST', '/reviews/spotlight/generate', {})).toMatchObject({ status: 403 })
    } finally {
      signedIn = true
    }
  })
})
