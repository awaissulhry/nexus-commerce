/**
 * MCP full control 07 O5 — the ship queue, the shipment read and the rate shop move from fulfillment.routes.ts into
 * services/fulfillment/shipment-read.service.ts with NO change to what the routes answer. The snapshots in
 * __snapshots__/fulfillment-read-parity.vitest.test.ts.snap were written by the route code BEFORE the move (a
 * characterization): GET /fulfillment/outbound/pending-orders (filters, urgency, search, sorts, paging),
 * GET /fulfillment/shipments/:id and GET /fulfillment/shipments/:id/rates (Sendcloud mocked; Buy Shipping off), and
 * their 404 / 400 answers.
 *
 * One intended change since (07, lead review step 0): the ship queue no longer lists an order Amazon ships or one in
 * the bin (fulfillment-queue-amazon.vitest.test.ts); the queue snapshots were updated for exactly that — the FBA order
 * left the lists, its counts and the pages after it, nothing else moved.
 *
 * Real SQL (PGlite with the production schema) and the real route plugin. The clock is fixed (urgency buckets);
 * every id, date and name is invented; only the database's own clock columns are masked.
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
// The carrier read: Sendcloud answers two methods for any weight and country; nothing leaves the machine.
const carrier = vi.hoisted(() => ({ calls: [] as unknown[] }))
vi.mock('../services/sendcloud/index.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveCredentials: vi.fn(async () => ({ publicKey: 'test', secretKey: 'test' })),
  listShippingMethods: vi.fn(async (_creds: unknown, filter: unknown) => {
    carrier.calls.push(filter)
    return [
      { id: 2002, name: 'Test Express', carrier: 'DHL', price: 12.5, minWeightKg: 0, maxWeightKg: 5 },
      { id: 2001, name: 'Test Standard', carrier: 'BRT', price: 4.2, minWeightKg: 0, maxWeightKg: 5 },
    ]
  }),
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const NOW = new Date(Date.UTC(2026, 3, 10, 12))
const hours = (h: number) => new Date(NOW.getTime() + h * 3_600_000)

function stable(body: string): string {
  return JSON.stringify(JSON.parse(body), (key, value) => (key === 'createdAt' || key === 'updatedAt' ? '<clock>' : value), 2)
}

async function seed() {
  const db = database.client
  await inside(async () => {
    await db.warehouse.create({ data: { id: 'test-wh-1', code: 'TEST-WH', name: 'Test warehouse', isDefault: true, addressLine1: 'Via Magazzino 1', city: 'Testville', postalCode: '00000', country: 'IT' } as never })
    const orders: Array<[string, Record<string, unknown>]> = [
      ['q-overdue', { channel: 'EBAY', marketplace: 'IT', status: 'PROCESSING', shipByDate: hours(-5), purchaseDate: hours(-50), totalPrice: '30.00', customerName: 'Anna Bianchi' }],
      ['q-today', { channel: 'SHOPIFY', marketplace: 'IT', status: 'PENDING', shipByDate: hours(5), purchaseDate: hours(-20), totalPrice: '80.00', customerName: 'Mario Rossi' }],
      ['q-tomorrow', { channel: 'AMAZON', marketplace: 'DE', status: 'PROCESSING', fulfillmentMethod: 'FBM', shipByDate: hours(30), purchaseDate: hours(-10), totalPrice: '15.00', customerName: 'Hans Muller' }],
      ['q-week', { channel: 'EBAY', marketplace: 'DE', status: 'PROCESSING', shipByDate: hours(100), purchaseDate: hours(-5), totalPrice: '22.00', customerName: 'Eva Weber' }],
      ['q-later', { channel: 'EBAY', marketplace: 'IT', status: 'PROCESSING', shipByDate: hours(300), purchaseDate: hours(-2), totalPrice: '9.00', customerName: 'Luca Verdi' }],
      ['q-unknown', { channel: 'SHOPIFY', marketplace: 'IT', status: 'PROCESSING', shipByDate: null, purchaseDate: hours(-1), totalPrice: '41.00', customerName: 'Sara Neri' }],
      ['q-fba', { channel: 'AMAZON', marketplace: 'FR', status: 'PROCESSING', fulfillmentMethod: 'FBA', shipByDate: hours(10), purchaseDate: hours(-3), totalPrice: '33.00', customerName: 'Luc Martin' }],
      ['q-shipped', { channel: 'EBAY', marketplace: 'IT', status: 'SHIPPED', shipByDate: hours(-30), purchaseDate: hours(-60), totalPrice: '12.00', customerName: 'Done Buyer' }],
      ['q-has-shipment', { channel: 'EBAY', marketplace: 'IT', status: 'PROCESSING', shipByDate: hours(2), purchaseDate: hours(-4), totalPrice: '18.00', customerName: 'Packed Buyer' }],
    ]
    for (const [id, data] of orders) {
      await db.order.create({ data: {
        id, channelOrderId: `TEST-${id.toUpperCase()}`, currencyCode: 'EUR', customerEmail: `${id}@example.test`,
        shippingAddress: { line1: 'Via Test 1', city: 'Testville', countryCode: id === 'q-tomorrow' ? 'DE' : 'IT' }, ...data,
        items: { create: [{ id: `item-${id}`, sku: `TEST-SKU-${id.toUpperCase()}`, quantity: 1, price: data.totalPrice as string }] },
      } as never })
    }
    await db.shipment.create({ data: {
      id: 'test-shipment-1', orderId: 'q-has-shipment', warehouseId: 'test-wh-1', carrierCode: 'SENDCLOUD', status: 'READY_TO_PICK',
      weightGrams: 2500, serviceName: 'Test Standard', items: { create: [{ id: 'test-shipment-item-1', sku: 'TEST-SKU-Q-HAS-SHIPMENT', quantity: 1 }] },
    } as never })
    await db.shipment.create({ data: { id: 'test-shipment-orphan', carrierCode: 'MANUAL', status: 'DRAFT' } as never })
  })
}

describe('07 O5 — fulfilment reads: the routes answer exactly as before the move', () => {
  let app: FastifyInstance
  const get = async (url: string) => {
    const response = await app.inject({ method: 'GET', url: `/api${url}` })
    return { status: response.statusCode, body: stable(response.body) }
  }

  beforeAll(async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    database = await formulaDatabase()
    await seed()
    app = Fastify()
    app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(business, done) })
    const { default: fulfillmentRoutes } = await import('./fulfillment.routes.js')
    await app.register(fulfillmentRoutes, { prefix: '/api' })
    await app.ready()
  }, 180_000)

  afterAll(async () => {
    vi.useRealTimers()
    await app?.close()
    await database?.close()
  })

  it.each([
    ['default (ship-by first)', '/fulfillment/outbound/pending-orders'],
    ['channel and market', '/fulfillment/outbound/pending-orders?channel=EBAY&marketplace=IT,DE'],
    ['urgency and search', '/fulfillment/outbound/pending-orders?urgency=overdue,today,unknown&search=test-q'],
    ['value sort, paged', '/fulfillment/outbound/pending-orders?sort=value-desc&page=2&pageSize=3'],
    ['age sort', '/fulfillment/outbound/pending-orders?sort=age-desc'],
  ])('ship queue: %s', async (_label, url) => {
    const answer = await get(url)
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchSnapshot()
  })

  it('shipment: found, and not found', async () => {
    expect(await get('/fulfillment/shipments/test-shipment-1')).toMatchSnapshot()
    expect(await get('/fulfillment/shipments/test-shipment-none')).toMatchSnapshot()
  })

  it('rates: Sendcloud methods cheapest first; 404 and a shipment without an order', async () => {
    carrier.calls.length = 0
    expect(await get('/fulfillment/shipments/test-shipment-1/rates')).toMatchSnapshot()
    expect(carrier.calls).toEqual([{ weightKg: 2.5, toCountry: 'IT' }])
    expect(await get('/fulfillment/shipments/test-shipment-none/rates')).toMatchSnapshot()
    expect(await get('/fulfillment/shipments/test-shipment-orphan/rates')).toMatchSnapshot()
  })
})
