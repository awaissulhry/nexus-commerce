/**
 * MCP full control 07 O9 — the tracking upload to the channel has one writer (services/fulfillment/tracking-upload),
 * and it is no longer reached only from a Sendcloud SHIPPED webhook.
 *
 *   1. The webhook path is unchanged: a signed SHIPPED scan writes exactly the row it wrote before (snapshot written by
 *      the code before the change), and a repeated scan writes no second one.
 *   2. RED before O9: a MANUAL-carrier shipment never reached the channel — no route set its tracking number (the label
 *      step's hint promised one), and marking it shipped (one, bulk, or the Orders page's legacy bulk) queued nothing.
 *      Now: PATCH /fulfillment/shipments/:id/tracking sets it, and marking it shipped queues one upload.
 *   3. One upload per shipment: marking it shipped again queues no second one.
 *   4. An order Amazon ships never gets an upload from Nexus (FBA, MCF; fail closed), nor does a channel the upload job
 *      cannot serve (WooCommerce, manual orders). Etsy is served since O17 (order-ops.tools.vitest.test.ts).
 *
 * Real SQL (PGlite with the production schema) and the real route plugins.
 */
import { createHmac } from 'node:crypto'
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
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'disabled' }),
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

const SECRET = 'test-webhook-secret'
const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const ids: Record<string, string> = {}
const uploadsOf = (shipmentId: string) => inside(() => database.client.trackingMessageLog.findMany({
  where: { shipmentId }, select: { channel: true, marketplace: true, status: true, requestPayload: true },
}))

describe('07 O9 — tracking uploads', () => {
  let app: FastifyInstance
  const call = (method: 'POST' | 'PATCH', url: string, payload: unknown = {}) => app.inject({ method, url: `/api${url}`, payload: payload as object })

  beforeAll(async () => {
    vi.stubEnv('NEXUS_SENDCLOUD_WEBHOOK_SECRET', SECRET)
    database = await formulaDatabase()
    await inside(async () => {
      const order = async (key: string, data: Record<string, unknown> = {}) => (await database.client.order.create({
        data: {
          channel: 'EBAY', channelOrderId: `TEST-O9-${key}`, marketplace: 'IT', status: 'PROCESSING', currencyCode: 'EUR', totalPrice: '10.00',
          customerName: 'Test Buyer', customerEmail: 'buyer@example.test', shippingAddress: { city: 'Testville' }, fulfillmentMethod: 'MFN', ...data,
        } as never,
      })).id
      const shipment = async (orderId: string, data: Record<string, unknown>) => (await database.client.shipment.create({ data: { orderId, status: 'LABEL_PRINTED', ...data } as never })).id
      ids.webhook = await shipment(await order('WEBHOOK', { id: 'test-o9-order-webhook' }), { id: 'test-o9-shipment-webhook', carrierCode: 'SENDCLOUD', sendcloudParcelId: '424242', trackingNumber: 'TEST-SC-TRACK' })
      ids.manual = await shipment(await order('MANUAL'), { carrierCode: 'MANUAL' })
      ids.manualBulk = await shipment(await order('MANUAL-BULK'), { carrierCode: 'MANUAL', trackingNumber: 'TEST-MANUAL-BULK' })
      ids.legacyOrder = await order('LEGACY', { status: 'PENDING' })
      ids.legacy = await shipment(ids.legacyOrder, { carrierCode: 'MANUAL', trackingNumber: 'TEST-MANUAL-LEGACY' })
      ids.noTracking = await shipment(await order('NO-TRACKING'), { carrierCode: 'MANUAL' })
      ids.fba = await shipment(await order('FBA', { channel: 'AMAZON', fulfillmentMethod: 'FBA' }), { carrierCode: 'MANUAL', trackingNumber: 'TEST-FBA-TRACK' })
      ids.woo = await shipment(await order('WOO', { channel: 'WOOCOMMERCE', fulfillmentMethod: null }), { carrierCode: 'MANUAL', trackingNumber: 'TEST-WOO-TRACK' })
    })
    app = Fastify()
    app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(business, done) })
    const { default: fulfillmentRoutes } = await import('./fulfillment.routes.js')
    const { sendcloudWebhookRoutes } = await import('./sendcloud-webhooks.routes.js')
    const { ordersRoutes } = await import('./orders.routes.js')
    await app.register(fulfillmentRoutes, { prefix: '/api' })
    await app.register(sendcloudWebhookRoutes)
    await app.register(ordersRoutes)
    await app.ready()
  }, 180_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    await app?.close()
    await database?.close()
  })

  it('the webhook path is unchanged: a SHIPPED scan writes its one upload; a repeat writes none', async () => {
    const scan = async (timestamp: number) => {
      const body = JSON.stringify({ action: 'parcel_status_changed', timestamp, parcel: { id: 424242, tracking_number: 'TEST-SC-TRACK', tracking_url: 'https://track.example.test/1', status: { id: 3, message: 'Picked up' }, carrier: { code: 'brt' } } })
      return app.inject({ method: 'POST', url: '/api/webhooks/sendcloud', payload: body, headers: { 'content-type': 'application/json', 'sendcloud-signature': createHmac('sha256', SECRET).update(body).digest('hex') } })
    }
    expect((await scan(1775000000)).statusCode).toBe(200)
    expect((await scan(1775000600)).statusCode).toBe(200)
    expect(await uploadsOf(ids.webhook)).toMatchSnapshot()
  })

  it('a MANUAL shipment: its tracking number is set, and marking it shipped queues one upload; again, none more', async () => {
    const set = await call('PATCH', `/fulfillment/shipments/${ids.manual}/tracking`, { trackingNumber: ' TEST-MANUAL-1 ', carrierName: 'GLS' })
    expect(set.statusCode, set.body).toBe(200)
    expect(set.json()).toMatchObject({ trackingNumber: 'TEST-MANUAL-1' })
    expect((await call('POST', `/fulfillment/shipments/${ids.manual}/mark-shipped`)).statusCode).toBe(200)
    expect((await call('POST', `/fulfillment/shipments/${ids.manual}/mark-shipped`)).statusCode).toBe(200)
    expect(await uploadsOf(ids.manual)).toEqual([
      { channel: 'EBAY', marketplace: 'IT', status: 'PENDING', requestPayload: expect.objectContaining({ trackingNumber: 'TEST-MANUAL-1', carrierCode: 'MANUAL', shipmentId: ids.manual }) },
    ])
  })

  it('the bulk mark-shipped and the Orders page\'s legacy bulk queue the MANUAL uploads too', async () => {
    expect((await call('POST', '/fulfillment/shipments/bulk-mark-shipped', { shipmentIds: [ids.manualBulk] })).statusCode).toBe(200)
    expect(await uploadsOf(ids.manualBulk)).toEqual([expect.objectContaining({ status: 'PENDING', requestPayload: expect.objectContaining({ trackingNumber: 'TEST-MANUAL-BULK' }) })])
    expect((await call('POST', '/orders/bulk-mark-shipped', { orderIds: [ids.legacyOrder] })).statusCode).toBe(200)
    expect(await uploadsOf(ids.legacy)).toEqual([expect.objectContaining({ status: 'PENDING', requestPayload: expect.objectContaining({ trackingNumber: 'TEST-MANUAL-LEGACY' }) })])
  })

  it('no upload without a tracking number, for an order Amazon ships, or for a channel the job cannot serve', async () => {
    for (const id of [ids.noTracking, ids.fba, ids.woo]) {
      expect((await call('POST', `/fulfillment/shipments/${id}/mark-shipped`)).statusCode).toBe(200)
      expect(await uploadsOf(id)).toEqual([])
    }
  })

  it('the tracking number is refused for a shipment that is not MANUAL or has left', async () => {
    expect((await call('PATCH', `/fulfillment/shipments/${ids.webhook}/tracking`, { trackingNumber: 'X1' })).statusCode).toBe(400)
    expect((await call('PATCH', `/fulfillment/shipments/${ids.manual}/tracking`, { trackingNumber: 'X1' })).statusCode).toBe(400)
    expect((await call('PATCH', `/fulfillment/shipments/${ids.noTracking}/tracking`, { trackingNumber: '' })).statusCode).toBe(400)
    expect((await call('PATCH', '/fulfillment/shipments/test-shipment-none/tracking', { trackingNumber: 'X1' })).statusCode).toBe(404)
  })
})
