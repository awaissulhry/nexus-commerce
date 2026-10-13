/**
 * Inbound receive — a screen sends the total it saw (expectedReceived) with the total it set, and the line must still
 * stand at the seen total.
 *
 * Before, the desk, the mobile page and the scan sent only a running total and the server booked target − current:
 * two receivers who both saw 0 and both counted 5 booked 5, not 10, and a screen still showing 0 that sent 3 over a
 * line at 5 booked −2. Now a line that moved meanwhile books nothing and the route answers 409 with its current
 * total; the screen re-reads and the person enters again. A fresh screen's own correction down still books, and a
 * caller that sends no seen total (Claude's receive-stock, the PO receive) books its total as before.
 *
 * Real SQL (PGlite with the production schema); the real route plugin in a Fastify app.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return {
    default: new Proxy({}, {
      get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property),
    }),
  }
})
vi.mock('../../lib/queue.js', () => {
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
const events = vi.hoisted(() => ({ inbound: [] as Array<{ type: string }> }))
vi.mock('../inbound-events.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../inbound-events.service.js')>()),
  publishInboundEvent: vi.fn((event: { type: string }) => { events.inbound.push(event) }),
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

type Json = any
const ids = { warehouse: '', location: '' }
let app: FastifyInstance
let made = 0

type Line = { itemId: string; quantityReceived: unknown; expectedReceived?: unknown; qcStatus?: string }
async function receive(shipmentId: string, items: Line[]): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method: 'POST', url: `/api/fulfillment/inbound/${shipmentId}/receive`, payload: { items } })
  return { status: response.statusCode, body: response.json() }
}
/** A supplier shipment that arrived, one line per SKU expecting 10, each SKU its own product (stock starts at 0). */
async function arrived(...skus: string[]) {
  return inside(async () => {
    const db = database.client
    made += 1
    const lines = []
    for (const sku of skus) {
      const product = await db.product.create({ data: { sku: `TEST-SKU-RECV-${made}-${sku}`, name: `Test ${sku}`, basePrice: '10.00' } })
      lines.push({ productId: product.id, sku: product.sku, quantityExpected: 10 })
    }
    const shipment = await db.inboundShipment.create({
      data: { type: 'SUPPLIER', status: 'ARRIVED', reference: `TEST-RECV-${made}`, warehouseId: ids.warehouse, items: { create: lines } },
      include: { items: { orderBy: { sku: 'asc' } } },
    })
    return { id: shipment.id, lines: shipment.items.map((i) => ({ itemId: i.id, productId: i.productId!, sku: i.sku })) }
  })
}
const stock = (productId: string) => inside(async () => (await database.client.stockLevel.findFirst({ where: { productId, locationId: ids.location } }))?.quantity ?? 0)
const line = (itemId: string) => inside(() => database.client.inboundShipmentItem.findUniqueOrThrow({ where: { id: itemId }, select: { quantityReceived: true, qcStatus: true } }))
const receipts = (itemId: string) => inside(async () => (await database.client.inboundReceipt.findMany({ where: { inboundShipmentItemId: itemId }, orderBy: { receivedAt: 'asc' }, select: { quantity: true } })).map((r) => r.quantity))
const movements = (productId: string) => inside(async () => (await database.client.stockMovement.findMany({ where: { productId }, orderBy: { createdAt: 'asc' }, select: { change: true } })).map((m) => m.change))

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const db = database.client
    ids.warehouse = (await db.warehouse.create({ data: { code: 'IT-MAIN', name: 'Test main warehouse', isDefault: true } })).id
    ids.location = (await db.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'IT-MAIN', name: 'Test main warehouse', warehouseId: ids.warehouse } })).id
  })
  app = Fastify()
  app.addHook('preHandler', (request, _reply, done) => { (request as { authUser?: { id: string } }).authUser = { id: 'u-receive-person' }; withWorkspace(business, done) })
  await app.register((await import('../../routes/fulfillment.routes.js')).default, { prefix: '/api' })
  await app.ready()
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
})

describe('inbound receive — the line must still stand at the total the screen saw', () => {
  it('two receivers in sequence on one line both count: the second is refused with the current total, then books its 5 on top', async () => {
    const { id, lines: [jacket] } = await arrived('JACKET')
    // Receiver A saw 0 and counted 5.
    expect((await receive(id, [{ itemId: jacket.itemId, quantityReceived: 5, expectedReceived: 0 }])).status).toBe(200)
    expect(await stock(jacket.productId)).toBe(5)

    // Receiver B's screen also saw 0 and counted 5 more. Before, this booked nothing and the 5 were lost.
    events.inbound.length = 0
    const refused = await receive(id, [{ itemId: jacket.itemId, quantityReceived: 5, expectedReceived: 0 }])
    expect(refused.status).toBe(409)
    expect(refused.body.conflicts).toEqual([{ itemId: jacket.itemId, sku: jacket.sku, quantityReceived: 5 }])
    expect(refused.body.error).toContain(`${jacket.sku} now shows 5 received`)
    expect(events.inbound.map((e) => e.type)).toEqual(['inbound.received'])
    expect(await stock(jacket.productId)).toBe(5)
    expect(await receipts(jacket.itemId)).toEqual([5])

    // B's screen re-read: 5 shown, B sets 10.
    expect((await receive(id, [{ itemId: jacket.itemId, quantityReceived: 10, expectedReceived: 5 }])).status).toBe(200)
    expect(await stock(jacket.productId)).toBe(10)
    expect(await line(jacket.itemId)).toMatchObject({ quantityReceived: 10 })
    expect(await receipts(jacket.itemId)).toEqual([5, 5])
    expect(await movements(jacket.productId)).toEqual([5, 5])
    expect(await inside(() => database.client.inboundShipment.findUniqueOrThrow({ where: { id }, select: { status: true } }))).toEqual({ status: 'RECEIVED' })
  })

  it('a stale screen never books a negative: a lower total or a QC-only change over a line that moved is refused, nothing moves', async () => {
    const { id, lines: [gloves] } = await arrived('GLOVES')
    expect((await receive(id, [{ itemId: gloves.itemId, quantityReceived: 5, expectedReceived: 0 }])).status).toBe(200)

    // A screen still showing 0 sends 3. Before, this booked −2.
    const lower = await receive(id, [{ itemId: gloves.itemId, quantityReceived: 3, expectedReceived: 0 }])
    expect(lower.status).toBe(409)
    expect(lower.body.conflicts).toEqual([{ itemId: gloves.itemId, sku: gloves.sku, quantityReceived: 5 }])
    // The same screen changes only QC (it sends the total it shows, 0). Before, this booked −5.
    const qcOnly = await receive(id, [{ itemId: gloves.itemId, quantityReceived: 0, expectedReceived: 0, qcStatus: 'HOLD' }])
    expect(qcOnly.status).toBe(409)

    expect(await stock(gloves.productId)).toBe(5)
    expect(await line(gloves.itemId)).toEqual({ quantityReceived: 5, qcStatus: null })
    expect(await receipts(gloves.itemId)).toEqual([5])
    expect(await movements(gloves.productId)).toEqual([5])
  })

  it("a fresh screen's correction down is the person's own and still books (5 seen, 4 set: −1)", async () => {
    const { id, lines: [boots] } = await arrived('BOOTS')
    expect((await receive(id, [{ itemId: boots.itemId, quantityReceived: 5, expectedReceived: 0 }])).status).toBe(200)
    expect((await receive(id, [{ itemId: boots.itemId, quantityReceived: 4, expectedReceived: 5 }])).status).toBe(200)
    expect(await stock(boots.productId)).toBe(4)
    expect(await receipts(boots.itemId)).toEqual([5, -1])
  })

  it('several lines: the ones still where the screen saw them are booked, the moved one is refused and named', async () => {
    const { id, lines: [a, b] } = await arrived('A', 'B')
    expect((await receive(id, [{ itemId: a.itemId, quantityReceived: 2, expectedReceived: 0 }])).status).toBe(200)

    const mixed = await receive(id, [
      { itemId: a.itemId, quantityReceived: 4, expectedReceived: 0 },
      { itemId: b.itemId, quantityReceived: 3, expectedReceived: 0 },
    ])
    expect(mixed.status).toBe(409)
    expect(mixed.body.conflicts).toEqual([{ itemId: a.itemId, sku: a.sku, quantityReceived: 2 }])
    expect(await stock(a.productId)).toBe(2)
    expect(await stock(b.productId)).toBe(3)
    expect(await line(b.itemId)).toMatchObject({ quantityReceived: 3 })
    expect(await inside(() => database.client.inboundShipment.findUniqueOrThrow({ where: { id }, select: { status: true } }))).toEqual({ status: 'PARTIALLY_RECEIVED' })
  })

  it('an unreadable seen total is refused, never booked blind', async () => {
    const { id, lines: [helmet] } = await arrived('HELMET')
    expect((await receive(id, [{ itemId: helmet.itemId, quantityReceived: 4, expectedReceived: 'zero' }])).status).toBe(409)
    expect(await stock(helmet.productId)).toBe(0)
    expect(await line(helmet.itemId)).toMatchObject({ quantityReceived: 0 })
  })

  it('a caller that sends no seen total (Claude, the PO receive) books its total as before', async () => {
    const { id, lines: [vest] } = await arrived('VEST')
    expect((await receive(id, [{ itemId: vest.itemId, quantityReceived: 5 }])).status).toBe(200)
    expect((await receive(id, [{ itemId: vest.itemId, quantityReceived: 7 }])).status).toBe(200)
    expect((await receive(id, [{ itemId: vest.itemId, quantityReceived: 7 }])).status).toBe(200)
    expect(await stock(vest.productId)).toBe(7)
    expect(await receipts(vest.itemId)).toEqual([5, 2])
  })
})
