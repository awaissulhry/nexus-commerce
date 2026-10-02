/**
 * MCP full control 07 — a Shopify refund in dry run moves no money, so the Returns page must not say it did (100 %
 * honest UI; lead ruling of 2026-10-02).
 *
 * RED before the fix: with NEXUS_ENABLE_SHOPIFY_REFUND off, the refund publisher answered a mock "OK" with a made-up
 * refund id, and the refund route (and the retry) marked the return REFUNDED with a POSTED Refund. Now the route
 * answers channelOutcome DRY_RUN ("dry run — no money moved"), writes no Refund, and the return stays as it was; the
 * retry of a failed Shopify refund does the same. With the switch on, the real path is unchanged (not called here).
 *
 * Real SQL (PGlite with the production schema), the real route plugin and the REAL publisher (its Shopify dry-run path
 * makes no network call).
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
vi.mock('../services/advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined,
  putCached: () => undefined,
  flushAdsCache: async () => undefined,
}))
vi.mock('../services/credit-note.service.js', () => ({ assignCreditNoteNumber: vi.fn(async () => null) }))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

describe('a Shopify refund in dry run: "dry run — no money moved", the return stays unrefunded', () => {
  let app: FastifyInstance
  const post = (url: string, payload: unknown = {}) => app.inject({ method: 'POST', url: `/api${url}`, payload: payload as object })
  const state = (id: string) => inside(() => database.client.return.findUnique({ where: { id }, select: { status: true, refundStatus: true, refundCents: true, channelRefundId: true } }))
  const refunds = (returnId: string) => inside(() => database.client.refund.findMany({ where: { returnId }, select: { channelStatus: true } }))

  beforeAll(async () => {
    vi.stubEnv('NEXUS_ENABLE_SHOPIFY_REFUND', '')
    database = await formulaDatabase()
    await inside(async () => {
      for (const key of ['fresh', 'failed']) {
        await database.client.order.create({
          data: {
            id: `test-order-${key}`, channel: 'SHOPIFY', channelOrderId: `TEST-SHOP-${key}`, marketplace: 'IT', status: 'DELIVERED', currencyCode: 'EUR', totalPrice: '40.00',
            customerName: 'Test Buyer', customerEmail: 'buyer@example.test', shippingAddress: { city: 'Testville' },
          } as never,
        })
      }
      await database.client.return.create({ data: { id: 'test-return-fresh', orderId: 'test-order-fresh', channel: 'SHOPIFY', rmaNumber: 'TEST-RMA-FRESH', status: 'RECEIVED' } as never })
      await database.client.return.create({ data: { id: 'test-return-failed', orderId: 'test-order-failed', channel: 'SHOPIFY', rmaNumber: 'TEST-RMA-FAILED', status: 'RECEIVED', refundStatus: 'CHANNEL_FAILED', refundCents: 1500 } as never })
    })
    app = Fastify()
    app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(business, done) })
    const { default: returnsRoutes } = await import('./returns.routes.js')
    await app.register(returnsRoutes, { prefix: '/api' })
    await app.ready()
  }, 180_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    await app?.close()
    await database?.close()
  })

  it('the refund answers DRY_RUN; no Refund is written; the return is untouched', async () => {
    const answer = await post('/fulfillment/returns/test-return-fresh/refund', { refundCents: 2000 })
    expect(answer.statusCode, answer.body).toBe(200)
    expect(answer.json()).toMatchObject({ channelOutcome: 'DRY_RUN', refundId: null, channelMessage: expect.stringMatching(/^Dry run — no money moved/), status: 'RECEIVED' })
    expect(await state('test-return-fresh')).toEqual({ status: 'RECEIVED', refundStatus: 'PENDING', refundCents: null, channelRefundId: null })
    expect(await refunds('test-return-fresh')).toEqual([])
  })

  it('the retry of a failed Shopify refund answers DRY_RUN too, and the return stays failed', async () => {
    const answer = await post('/fulfillment/returns/test-return-failed/refund/retry', { force: true })
    expect(answer.statusCode, answer.body).toBe(200)
    expect(answer.json()).toMatchObject({ outcome: 'DRY_RUN', channelMessage: expect.stringMatching(/^Dry run — no money moved/) })
    expect(await state('test-return-failed')).toEqual({ status: 'RECEIVED', refundStatus: 'CHANNEL_FAILED', refundCents: 1500, channelRefundId: null })
    expect(await refunds('test-return-failed')).toEqual([])
  })
})
