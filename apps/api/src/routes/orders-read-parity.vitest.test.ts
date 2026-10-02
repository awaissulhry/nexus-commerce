/**
 * MCP full control 07 O4 — the order reads move from orders.routes.ts into services/orders/order-read.service.ts with
 * NO change to what the routes answer. The snapshots in __snapshots__/orders-read-parity.vitest.test.ts.snap were
 * written by the route code BEFORE the move (a characterization); after the move the same requests must give the
 * same bytes: the list (default "All" scope, filters, search, sort, paging, the bin), the detail, the timeline and the
 * financials, and the 404s.
 *
 * Real SQL (PGlite with the production schema) and the real route plugin. Every id, date and name is invented and
 * fixed; only the database's own clock columns (createdAt / updatedAt) are masked.
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
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []) }
  return {
    addJobSafely: vi.fn(async () => undefined),
    outboundSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, channelSyncQueue: queue, bulkJobQueue: queue,
    redis: { connection: null },
  }
})

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const at = (day: number, hour = 10) => new Date(Date.UTC(2026, 3, day, hour))

/** The answer as text, with the database's own clock columns masked. */
function stable(body: string): string {
  return JSON.stringify(JSON.parse(body), (key, value) => (key === 'createdAt' || key === 'updatedAt' ? '<clock>' : value), 2)
}

async function seed() {
  const db = database.client
  await inside(async () => {
    await db.product.create({ data: { id: 'test-product-1', sku: 'TEST-SKU-1', name: 'Test Jacket', basePrice: '49.90', amazonAsin: 'TESTASIN01' } as never })
    await db.tag.create({ data: { id: 'test-tag-1', name: 'VIP', color: '#ff0000' } as never })
    const orders = [
      { id: 'test-order-a', channel: 'AMAZON', channelOrderId: 'TEST-A-1', marketplace: 'IT', status: 'SHIPPED', fulfillmentMethod: 'FBM', totalPrice: '99.80', customerName: 'Mario Rossi', customerEmail: 'mario@example.test', purchaseDate: at(1), paidAt: at(1, 11), shippedAt: at(2), shipByDate: at(3), isPrime: true, amazonMetadata: { IsBusinessOrder: false } },
      { id: 'test-order-b', channel: 'EBAY', channelOrderId: 'TEST-B-1', marketplace: 'DE', status: 'PROCESSING', fulfillmentMethod: 'FBM', totalPrice: '25.00', customerName: 'Anna Bianchi', customerEmail: 'anna@example.test', purchaseDate: at(4), paidAt: at(4, 11) },
      { id: 'test-order-c', channel: 'SHOPIFY', channelOrderId: 'TEST-C-1', marketplace: 'IT', status: 'CANCELLED', totalPrice: '10.00', customerName: 'Mario Rossi', customerEmail: 'mario@example.test', purchaseDate: at(5), cancelledAt: at(6) },
      { id: 'test-order-d', channel: 'AMAZON', channelOrderId: 'TEST-D-1', marketplace: 'FR', status: 'DELIVERED', fulfillmentMethod: 'FBA', totalPrice: '60.00', customerName: 'Luc Martin', customerEmail: 'luc@example.test', purchaseDate: at(7), shippedAt: at(8), deliveredAt: at(9) },
      { id: 'test-order-bin', channel: 'EBAY', channelOrderId: 'TEST-BIN-1', marketplace: 'IT', status: 'PROCESSING', totalPrice: '5.00', customerName: 'Deleted Buyer', customerEmail: 'bin@example.test', purchaseDate: at(10), deletedAt: at(11) },
    ]
    for (const order of orders) {
      await db.order.create({ data: { currencyCode: 'EUR', shippingAddress: { city: 'Testville', countryCode: 'IT' }, ...order } as never })
    }
    await db.orderItem.create({ data: { id: 'test-item-a1', orderId: 'test-order-a', sku: 'TEST-SKU-1', productId: 'test-product-1', quantity: 2, price: '49.90' } as never })
    await db.orderItem.create({ data: { id: 'test-item-b1', orderId: 'test-order-b', sku: 'TEST-SKU-2', quantity: 1, price: '25.00' } as never })
    await db.orderItem.create({ data: { id: 'test-item-d1', orderId: 'test-order-d', sku: 'TEST-SKU-1', productId: 'test-product-1', quantity: 1, price: '60.00' } as never })
    await db.orderTag.create({ data: { orderId: 'test-order-a', tagId: 'test-tag-1' } as never })
    await db.shipment.create({ data: { id: 'test-shipment-a', orderId: 'test-order-a', carrierCode: 'MANUAL', status: 'SHIPPED', trackingNumber: 'TEST-TRACK-A', shippedAt: at(2), deliveredAt: at(3) } as never })
    await db.return.create({ data: { id: 'test-return-a', orderId: 'test-order-a', channel: 'AMAZON', rmaNumber: 'TEST-RMA-A', status: 'RECEIVED', receivedAt: at(5), refundedAt: at(6) } as never })
    await db.financialTransaction.create({ data: { id: 'test-tx-a1', orderId: 'test-order-a', transactionType: 'Order', transactionDate: at(1, 12), amount: '99.80', grossRevenue: '99.80', amazonFee: '15.00', fbaFee: '0', netRevenue: '84.80', status: 'Completed' } as never })
    await db.financialTransaction.create({ data: { id: 'test-tx-a2', orderId: 'test-order-a', transactionType: 'Refund', transactionDate: at(6, 12), amount: '-49.90', grossRevenue: '-49.90', netRevenue: '-49.90', status: 'Completed' } as never })
    await db.reviewRequest.create({ data: { id: 'test-review-a', orderId: 'test-order-a', channel: 'AMAZON', status: 'SENT', sentAt: at(9) } as never })
  })
}

describe('07 O4 — order reads: the routes answer exactly as before the move', () => {
  let app: FastifyInstance
  const get = async (url: string) => {
    const response = await app.inject({ method: 'GET', url })
    return { status: response.statusCode, body: stable(response.body) }
  }

  beforeAll(async () => {
    database = await formulaDatabase()
    await seed()
    app = Fastify()
    app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(business, done) })
    const { ordersRoutes } = await import('./orders.routes.js')
    await app.register(ordersRoutes)
    await app.ready()
  }, 180_000)

  afterAll(async () => {
    await app?.close()
    await database?.close()
  })

  it.each([
    ['default list (All scope hides cancelled)', '/api/orders'],
    ['explicit status and channel', '/api/orders?status=SHIPPED,DELIVERED&channel=AMAZON'],
    ['cancelled tab', '/api/orders?status=CANCELLED'],
    ['search by buyer, sorted by total, paged', '/api/orders?status=ALL&search=mario&sortBy=totalPrice&sortDir=asc&page=1&pageSize=1'],
    ['fulfilment and market', '/api/orders?fulfillment=FBA&marketplace=FR'],
    ['date range and has-return', '/api/orders?dateFrom=2026-04-01T00:00:00Z&dateTo=2026-04-05T00:00:00Z&hasReturn=false'],
    ['order type Prime and tag', '/api/orders?orderType=PRIME&tags=test-tag-1'],
    ['the bin', '/api/orders?deleted=true'],
  ])('list: %s', async (_label, url) => {
    const answer = await get(url)
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchSnapshot()
  })

  it.each(['test-order-a', 'test-order-b', 'test-order-d'])('detail, timeline and financials of %s', async (id) => {
    for (const path of ['', '/timeline', '/financials']) {
      const answer = await get(`/api/orders/${id}${path}`)
      expect(answer.status, path).toBe(200)
      expect(answer.body).toMatchSnapshot(path || 'detail')
    }
  })

  it('an unknown order: 404 for the detail and the timeline; the financials of nothing are empty', async () => {
    expect(await get('/api/orders/test-order-none')).toMatchSnapshot()
    expect(await get('/api/orders/test-order-none/timeline')).toMatchSnapshot()
    expect(await get('/api/orders/test-order-none/financials')).toMatchSnapshot()
  })
})
