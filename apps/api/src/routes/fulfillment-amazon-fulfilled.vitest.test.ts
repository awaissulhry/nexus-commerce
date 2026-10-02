/**
 * MCP full control 07 O1 — Nexus never ships an order Amazon ships. Shipment create, bulk create and label purchase
 * did not ask who fulfils the order, so Nexus could create a parcel and buy a carrier label for an FBA order, or for
 * an eBay/Shopify order already sent to Amazon Multi-Channel Fulfilment (MCF) from FBA stock.
 *
 * The test is fail-closed (`isAmazonFulfilledOrder`): FBA/AFN, an active MCF shipment, or an Amazon order without
 * explicit merchant evidence (FBM/MFN) is refused. Controls: an Amazon FBM order and an eBay order whose MCF request
 * was cancelled still ship.
 *
 * Real SQL (PGlite with the production schema) and the real fulfilment route plugin. The label case uses the
 * MANUAL carrier, so the old code reached no carrier either: it marked the label printed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { isAmazonFulfilledOrder } from '../services/fulfillment/amazon-fulfilled-order.js'

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

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

describe('isAmazonFulfilledOrder — the fail-closed test', () => {
  it.each([
    [{ channel: 'AMAZON', fulfillmentMethod: 'FBA' }, 0, true],
    [{ channel: 'AMAZON', fulfillmentMethod: 'AFN' }, 0, true],
    [{ channel: 'AMAZON', fulfillmentMethod: 'AmazonFulfilled' }, 0, true],
    [{ channel: 'AMAZON', fulfillmentMethod: null }, 0, true],
    [{ channel: 'AMAZON', fulfillmentMethod: 'something new' }, 0, true],
    [{ channel: 'AMAZON', fulfillmentMethod: 'FBM' }, 0, false],
    [{ channel: 'AMAZON', fulfillmentMethod: 'MerchantFulfilled' }, 0, false],
    [{ channel: 'EBAY', fulfillmentMethod: 'MFN' }, 0, false],
    [{ channel: 'EBAY', fulfillmentMethod: 'MFN' }, 1, true],
    [{ channel: 'SHOPIFY', fulfillmentMethod: null }, 0, false],
    [{ channel: 'SHOPIFY', fulfillmentMethod: 'FBA' }, 0, true],
  ])('%o with %i active MCF shipment(s) → %s', (order, activeMcf, expected) => {
    expect(isAmazonFulfilledOrder(order, activeMcf)).toBe(expected)
  })
})

describe('07 O1 — shipment create, bulk create and label refuse an order Amazon ships', () => {
  let app: FastifyInstance
  let seq = 0
  const id: Record<string, string> = {}

  const order = (data: Record<string, unknown>) => inside(async () => (await database.client.order.create({
    data: {
      channel: 'AMAZON', channelOrderId: `TEST-O1-FBA-${++seq}`, marketplace: 'IT', status: 'PROCESSING',
      currencyCode: 'EUR', totalPrice: '10.00', customerName: 'Test Buyer', customerEmail: 'buyer@example.test',
      shippingAddress: { addressLine1: 'Via Test 1', city: 'Milano', postalCode: '20100', countryCode: 'IT' },
      purchaseDate: new Date(), items: { create: [{ sku: 'TEST-SKU-1', quantity: 1, price: '10.00' }] }, ...data,
    } as never,
  })).id)
  const shipmentsOf = (orderId: string) => inside(() => database.client.shipment.findMany({ where: { orderId }, select: { id: true, status: true } }))
  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object })

  beforeAll(async () => {
    database = await formulaDatabase()
    await inside(async () => {
      id.warehouse = (await database.client.warehouse.create({ data: { code: 'TEST-WH', name: 'Test warehouse', isDefault: true } as never })).id
    })
    id.fba = await order({ fulfillmentMethod: 'FBA' })
    id.amazonUnknown = await order({ fulfillmentMethod: null })
    id.fbm = await order({ fulfillmentMethod: 'FBM' })
    id.ebayMcf = await order({ channel: 'EBAY', fulfillmentMethod: 'MFN' })
    id.ebayMcfCancelled = await order({ channel: 'EBAY', fulfillmentMethod: 'MFN' })
    id.bulkFba = await order({ fulfillmentMethod: 'FBA' })
    id.bulkFbm = await order({ fulfillmentMethod: 'FBM' })
    id.labelFba = await order({ fulfillmentMethod: 'FBA' })
    await inside(async () => {
      await database.client.mCFShipment.create({ data: { orderId: id.ebayMcf, amazonFulfillmentOrderId: 'TEST-MCF-1', status: 'PROCESSING' } })
      await database.client.mCFShipment.create({ data: { orderId: id.ebayMcfCancelled, amazonFulfillmentOrderId: 'TEST-MCF-2', status: 'CANCELLED' } })
      // A shipment that already exists for an FBA order (made before this fix): no label may be bought for it.
      id.labelShipment = (await database.client.shipment.create({
        data: { orderId: id.labelFba, warehouseId: id.warehouse, carrierCode: 'MANUAL', status: 'DRAFT' } as never,
      })).id
    })
    app = Fastify()
    app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(business, done) })
    const { default: fulfillmentRoutes } = await import('./fulfillment.routes.js')
    await app.register(fulfillmentRoutes, { prefix: '/api' })
    await app.ready()
  }, 180_000)

  afterAll(async () => {
    await app?.close()
    await database?.close()
  })

  it.each([['fba'], ['amazonUnknown'], ['ebayMcf']])('POST /fulfillment/shipments refuses the %s order and creates no shipment', async (key) => {
    const response = await post('/api/fulfillment/shipments', { orderId: id[key] })
    expect(response.statusCode, response.body).toBe(400)
    expect(response.json().code).toBe('AMAZON_FULFILLED')
    expect(await shipmentsOf(id[key])).toEqual([])
  })

  it.each([['fbm'], ['ebayMcfCancelled']])('control: POST /fulfillment/shipments creates a shipment for the %s order', async (key) => {
    const response = await post('/api/fulfillment/shipments', { orderId: id[key] })
    expect(response.statusCode, response.body).toBe(200)
    expect(await shipmentsOf(id[key])).toHaveLength(1)
  })

  it('bulk create skips the FBA order with a reason and creates the FBM one', async () => {
    const response = await post('/api/fulfillment/shipments/bulk-create', { orderIds: [id.bulkFba, id.bulkFbm], warehouseId: id.warehouse, carrierCode: 'MANUAL' })
    expect(response.statusCode, response.body).toBe(200)
    const body = response.json() as { created: number; errors: Array<{ orderId: string; reason: string }> }
    expect(body.created).toBe(1)
    expect(body.errors).toEqual([{ orderId: id.bulkFba, reason: expect.stringContaining('Amazon ships this order') }])
    expect(await shipmentsOf(id.bulkFba)).toEqual([])
    expect(await shipmentsOf(id.bulkFbm)).toHaveLength(1)
  })

  it('print-label refuses a shipment of an FBA order and leaves it untouched', async () => {
    const response = await post(`/api/fulfillment/shipments/${id.labelShipment}/print-label`, {})
    expect(response.statusCode, response.body).toBe(400)
    expect(response.json().code).toBe('AMAZON_FULFILLED')
    expect(await shipmentsOf(id.labelFba)).toEqual([{ id: id.labelShipment, status: 'DRAFT' }])
  })
})
