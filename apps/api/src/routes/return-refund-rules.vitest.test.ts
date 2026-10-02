/**
 * MCP full control 07 O12 — what the return and refund services refuse, for the Returns page as for Claude.
 *
 *   1. RED before O12: a refund could be larger than the order paid. Now a refund is capped at what is still
 *      refundable on its order (what the order paid less the refunds of all its returns that are in progress or
 *      done); above it, 400 and nothing is recorded or sent.
 *   2. One refund at a time per return: the second gets 409 (the database's Refund_oneActivePerReturn index backs it).
 *   3. RED before O12: restocking a return of an order Amazon ships (an FBA return, or the order says FBA / has a live
 *      MCF request — the fail-closed test of amazon-fulfilled-order.ts) put units into Nexus's own warehouse. Amazon
 *      keeps those units: now 409 AMAZON_FULFILLED, and no stock moves.
 *   4. RED before O12: a refund that went through left no event. Now `refund.issued` (ids, channel, outcome only);
 *      a channel failure publishes none.
 *   7. RED (2026-10-02): a return refunded in Nexus left the order's scheduled review request to go out. Now the refund
 *      suppresses it, and the manual request counts a Nexus refund as a refund.
 *   6. RED (2026-10-02): a retried refund that went through left no event. Now it publishes `refund.issued` too.
 *   5. RED (2026-10-02): a new return was EUR whatever its order's currency, so a GBP order's refund went out in EUR.
 *      Now it takes its order's currency (EUR only without an order).
 *
 * Real SQL (PGlite with the production schema) and the real route plugin; the channel publisher is mocked.
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
const channel = vi.hoisted(() => ({ calls: [] as string[], fail: new Set<string>() }))
vi.mock('../services/refunds/refund-publisher.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  publishRefundToChannel: vi.fn(async (input: { returnId: string }) => {
    channel.calls.push(input.returnId)
    return channel.fail.has(input.returnId) ? { outcome: 'FAILED', error: 'Test channel refused' } : { outcome: 'OK', channelRefundId: `TEST-REFUND-${channel.calls.length}` }
  }),
}))
vi.mock('../services/credit-note.service.js', () => ({ assignCreditNoteNumber: vi.fn(async () => null) }))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

describe('07 O12 — refunds are capped, one at a time, evented; Amazon\'s returns are not restocked by Nexus', () => {
  let app: FastifyInstance
  const post = (url: string, payload: unknown = {}) => app.inject({ method: 'POST', url: `/api${url}`, payload: payload as object })
  const refundsOf = (returnId: string) => inside(() => database.client.refund.findMany({ where: { returnId }, select: { amountCents: true, channelStatus: true } }))
  const movementsOf = (returnId: string) => inside(() => database.client.stockMovement.findMany({ where: { referenceId: returnId }, select: { reason: true, change: true } }))
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    database = await formulaDatabase()
    await inside(async () => {
      await database.client.warehouse.create({ data: { id: 'test-wh', code: 'TEST-WH', name: 'Test warehouse', isDefault: true, addressLine1: 'Via Magazzino 1', city: 'Testville', postalCode: '00100', country: 'IT' } as never })
      await database.client.stockLocation.create({ data: { id: 'test-loc', code: 'TEST-WH-LOC', name: 'Test warehouse', type: 'WAREHOUSE', warehouseId: 'test-wh' } as never })
      await database.client.product.create({ data: { id: 'test-product-1', sku: 'TEST-SKU-1', name: 'Test jacket', basePrice: 50, costPrice: 20, totalStock: 0, fulfillmentMethod: 'FBM' } as never })
      const order = async (key: string, data: Record<string, unknown> = {}) => (await database.client.order.create({
        data: {
          id: `test-order-${key}`, channel: 'EBAY', channelOrderId: `TEST-${key}`, marketplace: 'IT', status: 'DELIVERED', currencyCode: 'EUR',
          totalPrice: '100.00', customerName: 'Test Buyer', customerEmail: 'buyer@example.test', shippingAddress: { city: 'Testville' }, fulfillmentMethod: 'MFN', ...data,
        } as never,
      })).id
      const ret = async (key: string, orderId: string, data: Record<string, unknown> = {}) => (await database.client.return.create({
        data: {
          id: `test-return-${key}`, orderId, channel: 'EBAY', rmaNumber: `TEST-RMA-${key}`, status: 'INSPECTING',
          items: { create: [{ sku: 'TEST-SKU-1', productId: 'test-product-1', quantity: 1, conditionGrade: 'GOOD' }] }, ...data,
        } as never,
      })).id
      ids.capOrder = await order('cap')
      ids.capA = await ret('cap-a', ids.capOrder)
      ids.capB = await ret('cap-b', ids.capOrder)
      ids.capC = await ret('cap-c', ids.capOrder)
      ids.failing = await ret('failing', await order('failing'))
      ids.fbaFlag = await ret('fba-flag', await order('fba-flag', { channel: 'AMAZON', fulfillmentMethod: 'FBM' }), { channel: 'AMAZON', isFbaReturn: true })
      ids.fbaOrder = await ret('fba-order', await order('fba-order', { channel: 'AMAZON', fulfillmentMethod: 'FBA' }), { channel: 'AMAZON' })
      ids.unknownAmazon = await ret('unknown-amazon', await order('unknown-amazon', { channel: 'AMAZON', fulfillmentMethod: null }), { channel: 'AMAZON' })
      ids.own = await ret('own', await order('own'))
      ids.reviewedOrder = await order('reviewed', { deliveredAt: new Date(Date.now() - 10 * 86_400_000) })
      ids.reviewed = await ret('reviewed', ids.reviewedOrder)
      await database.client.reviewRequest.create({ data: { orderId: ids.reviewedOrder, channel: 'EBAY', status: 'SCHEDULED', scheduledFor: new Date(Date.now() + 86_400_000) } as never })
      ids.retryOrder = await order('retry')
      ids.retry = await ret('retry', ids.retryOrder, { status: 'RECEIVED', refundStatus: 'CHANNEL_FAILED', refundCents: 500 })
      ids.retryFailing = await ret('retry-failing', await order('retry-failing'), { status: 'RECEIVED', refundStatus: 'CHANNEL_FAILED', refundCents: 500 })
    })
    channel.fail.add(ids.failing)
    channel.fail.add(ids.retryFailing)
    app = Fastify()
    app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(business, done) })
    const { default: returnsRoutes } = await import('./returns.routes.js')
    await app.register(returnsRoutes, { prefix: '/api' })
    await app.ready()
  }, 180_000)

  afterAll(async () => {
    await app?.close()
    await database?.close()
  })

  it('a refund above what the order paid is refused; refunds of the order\'s other returns count', async () => {
    const over = await post(`/fulfillment/returns/${ids.capA}/refund`, { refundCents: 10001 })
    expect(over.statusCode, over.body).toBe(400)
    expect(over.json()).toMatchObject({ code: 'OVER_REFUNDABLE', refundableCents: 10000, error: expect.stringMatching(/more than is still refundable on order TEST-cap: 100\.00 EUR/) })
    expect(await refundsOf(ids.capA)).toEqual([])
    expect((await post(`/fulfillment/returns/${ids.capA}/refund`, { refundCents: 6000, skipChannelPush: true })).statusCode).toBe(200)
    const second = await post(`/fulfillment/returns/${ids.capB}/refund`, { refundCents: 4001 })
    expect(second.statusCode).toBe(400)
    expect(second.json()).toMatchObject({ refundableCents: 4000 })
    expect((await post(`/fulfillment/returns/${ids.capB}/refund`, { refundCents: 4000 })).statusCode).toBe(200)
    expect((await post(`/fulfillment/returns/${ids.capC}/refund`, { refundCents: 1, skipChannelPush: true })).json()).toMatchObject({ refundableCents: 0 })
    expect(channel.calls).toEqual([ids.capB])
  })

  it('a second refund of one return is refused while the first is in progress or done', async () => {
    const again = await post(`/fulfillment/returns/${ids.capA}/refund`, { refundCents: 100, skipChannelPush: true })
    expect(again.statusCode).toBe(409)
    expect(await refundsOf(ids.capA)).toEqual([{ amountCents: 6000, channelStatus: 'POSTED' }])
  })

  it('a refund that goes through publishes refund.issued (no money, no text); a channel failure publishes none', async () => {
    expect((await post(`/fulfillment/returns/${ids.failing}/refund`, { refundCents: 500 })).statusCode).toBe(502)
    const events = await inside(() => database.client.eventOutbox.findMany({ where: { type: 'refund.issued' }, orderBy: { createdAt: 'asc' } }))
    expect(events.map((e) => e.payload)).toEqual([
      { refundId: expect.any(String), returnId: ids.capA, orderId: ids.capOrder, channel: 'EBAY', outcome: 'SKIPPED' },
      { refundId: expect.any(String), returnId: ids.capB, orderId: ids.capOrder, channel: 'EBAY', outcome: 'OK' },
    ])
  })

  it('a new return takes its order\'s currency, not EUR', async () => {
    await inside(() => database.client.order.create({
      data: {
        id: 'test-order-gbp', channel: 'EBAY', channelOrderId: 'TEST-GBP', marketplace: 'UK', status: 'DELIVERED', currencyCode: 'GBP', totalPrice: '30.00',
        customerName: 'Test Buyer', customerEmail: 'buyer@example.test', shippingAddress: { city: 'Testville' }, fulfillmentMethod: 'MFN',
      } as never,
    }))
    const made = await post('/fulfillment/returns', { orderId: 'test-order-gbp', channel: 'EBAY', marketplace: 'UK', items: [{ sku: 'TEST-SKU-1', quantity: 1 }] })
    expect(made.statusCode, made.body).toBe(200)
    expect(made.json()).toMatchObject({ orderId: 'test-order-gbp', currencyCode: 'GBP' })
    expect((await post('/fulfillment/returns', { channel: 'SHOPIFY', items: [] })).json()).toMatchObject({ orderId: null, currencyCode: 'EUR' })
  })

  it('a return of an order Amazon ships is not restocked into Nexus\'s warehouse; an own return is', async () => {
    for (const id of [ids.fbaFlag, ids.fbaOrder, ids.unknownAmazon]) {
      const refused = await post(`/fulfillment/returns/${id}/restock`, {})
      expect(refused.statusCode, refused.body).toBe(409)
      expect(refused.json()).toMatchObject({ code: 'AMAZON_FULFILLED' })
      expect(await movementsOf(id)).toEqual([])
      expect((await inside(() => database.client.return.findUnique({ where: { id }, select: { status: true } })))?.status).toBe('INSPECTING')
    }
    expect((await post(`/fulfillment/returns/${ids.own}/restock`, {})).statusCode).toBe(200)
    expect(await movementsOf(ids.own)).toEqual([{ reason: 'RETURN_RESTOCKED', change: 1 }])
  })
  it('a retried refund that goes through publishes refund.issued too; a failed retry publishes none', async () => {
    const before = (await inside(() => database.client.eventOutbox.findMany({ where: { type: 'refund.issued' } }))).length
    const retried = await post(`/fulfillment/returns/${ids.retry}/refund/retry`, { force: true })
    expect(retried.statusCode, retried.body).toBe(200)
    expect(retried.json()).toMatchObject({ outcome: 'OK' })
    expect((await post(`/fulfillment/returns/${ids.retryFailing}/refund/retry`, { force: true })).statusCode).toBe(502)
    const events = await inside(() => database.client.eventOutbox.findMany({ where: { type: 'refund.issued' }, orderBy: { createdAt: 'asc' } }))
    expect(events).toHaveLength(before + 1)
    expect(events.at(-1)!.payload).toEqual({ refundId: retried.json().refundId, returnId: ids.retry, orderId: ids.retryOrder, channel: 'EBAY', outcome: 'OK' })
  })
  it('a return refunded in Nexus stops the order\'s pending review request, and no new one is asked for', async () => {
    expect((await post(`/fulfillment/returns/${ids.reviewed}/refund`, { refundCents: 1000, skipChannelPush: true })).statusCode).toBe(200)
    expect(await inside(() => database.client.reviewRequest.findMany({ where: { orderId: ids.reviewedOrder }, select: { status: true, suppressedReason: true } })))
      .toEqual([{ status: 'SUPPRESSED', suppressedReason: expect.stringMatching(/^Order refunded in Nexus \(return TEST-RMA-reviewed\)/) }])
    const { reviewRequestCheck } = await import('../services/reviews/review-request.service.js')
    await inside(() => database.client.reviewRequest.deleteMany({ where: { orderId: ids.reviewedOrder } }))
    expect(await inside(() => reviewRequestCheck(ids.reviewedOrder))).toEqual({ ok: false, status: 400, error: 'Order has a refund — solicitation suppressed' })
  })
})
