/**
 * MCP full control 08 S2 (F7, F8) — a person's stock change never lands on a location another system owns, and a
 * transfer is one transaction.
 *
 *   F7  An AMAZON_FBA location mirrors Amazon (only the FBA inventory sync writes it: FBA quantity is untouchable) and
 *       a SHOPIFY_LOCATION holds Shopify's own number. Before, a transfer, a cycle-count reconcile, the adjust route
 *       (`POST /fulfillment/stock/:productId/adjust`) and a channel stock event could change either. Now every manual
 *       reason (adjust, count, write-off, transfer) is refused there, a channel stock event never changes the FBA
 *       mirror, and a Shopify location takes only Shopify's own events. Sync reasons keep writing the mirror.
 *   F8  `transferStock` was two transactions: when the second failed, the units had left the source and arrived
 *       nowhere. Now both movements commit together or not at all.
 *
 * Real SQL (PGlite with the production schema); the services and the route plugin are the real ones.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
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
vi.mock('./advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined,
  putCached: () => undefined,
  flushAdsCache: async () => undefined,
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

describe('08 S2 — protected locations (F7) and the one-transaction transfer (F8)', () => {
  let movement: typeof import('./stock-movement.service.js')
  let levels: typeof import('./stock-level.service.js')
  let cycleCount: typeof import('./cycle-count.service.js')
  let channelEvents: typeof import('./channel-stock-event.service.js')
  let app: FastifyInstance
  const loc: Record<'wh' | 'wh2' | 'fba' | 'shop', string> = { wh: '', wh2: '', fba: '', shop: '' }
  let fbaWarehouseId = ''

  /** A fresh product with its own levels: WH 10, WH2 0, FBA 7, Shopify 4. */
  const product = () => inside(async () => {
    const db = database.client
    const sku = `TEST-SKU-S2-${randomUUID().slice(0, 8)}`
    const { id } = await db.product.create({ data: { sku, name: sku, basePrice: '10.00', totalStock: 10 } })
    for (const [location, quantity] of [[loc.wh, 10], [loc.fba, 7], [loc.shop, 4]] as const) {
      await db.stockLevel.create({ data: { locationId: location, productId: id, quantity, reserved: 0, available: quantity } })
    }
    return { id, sku }
  })
  const quantities = (productId: string) => inside(async () => {
    const rows = await database.client.stockLevel.findMany({ where: { productId }, select: { locationId: true, quantity: true } })
    const at = (location: string) => rows.find((r) => r.locationId === location)?.quantity ?? 0
    return { wh: at(loc.wh), wh2: at(loc.wh2), fba: at(loc.fba), shop: at(loc.shop) }
  })
  const START = { wh: 10, wh2: 0, fba: 7, shop: 4 }
  const refused = { code: 'PROTECTED_LOCATION' }

  beforeAll(async () => {
    database = await formulaDatabase()
    await inside(async () => {
      const db = database.client
      fbaWarehouseId = (await db.warehouse.create({ data: { code: 'TEST-FBA-WH', name: 'Amazon FBA (test)' } as never })).id
      loc.wh = (await db.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'TEST-WH', name: 'Test warehouse' } })).id
      loc.wh2 = (await db.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'TEST-WH2', name: 'Second warehouse' } })).id
      loc.fba = (await db.stockLocation.create({ data: { type: 'AMAZON_FBA', code: 'TEST-FBA', name: 'Amazon FBA', warehouseId: fbaWarehouseId } as never })).id
      loc.shop = (await db.stockLocation.create({ data: { type: 'SHOPIFY_LOCATION', code: 'TEST-SHOP', name: 'Shopify shop' } })).id
    })
    movement = await import('./stock-movement.service.js')
    levels = await import('./stock-level.service.js')
    cycleCount = await import('./cycle-count.service.js')
    channelEvents = await import('./channel-stock-event.service.js')
    app = Fastify()
    app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(business, done) })
    const { default: fulfillmentRoutes } = await import('../routes/fulfillment.routes.js')
    await app.register(fulfillmentRoutes, { prefix: '/api' })
    await app.ready()
  }, 180_000)

  afterAll(async () => {
    await app?.close()
    await database?.close()
  })

  describe('F7 — manual reasons never change an FBA or Shopify location', () => {
    it.each([
      ['MANUAL_ADJUSTMENT', 'fba'], ['INVENTORY_COUNT', 'fba'], ['WRITE_OFF', 'fba'],
      ['MANUAL_ADJUSTMENT', 'shop'], ['INVENTORY_COUNT', 'shop'], ['WRITE_OFF', 'shop'],
    ] as const)('%s at the %s location is refused and changes nothing', async (reason, where) => {
      const p = await product()
      await expect(inside(() => movement.applyStockMovement({ productId: p.id, locationId: loc[where], change: -1, reason }))).rejects.toMatchObject(refused)
      expect(await quantities(p.id)).toEqual(START)
    })

    it('control: the FBA inventory sync (SYNC_RECONCILIATION) still writes the FBA mirror', async () => {
      const p = await product()
      await inside(() => movement.applyStockMovement({ productId: p.id, locationId: loc.fba, change: 2, reason: 'SYNC_RECONCILIATION' }))
      expect(await quantities(p.id)).toEqual({ ...START, fba: 9 })
    })

    it.each([['wh', 'fba'], ['fba', 'wh'], ['wh', 'shop'], ['shop', 'wh']] as const)(
      'a transfer %s → %s is refused and neither side changes', async (from, to) => {
        const p = await product()
        await expect(inside(() => levels.transferStock({ productId: p.id, fromLocationId: loc[from], toLocationId: loc[to], quantity: 2 }))).rejects.toMatchObject(refused)
        expect(await quantities(p.id)).toEqual(START)
      },
    )

    it('a cycle-count reconcile at the FBA location is refused; the item stays counted', async () => {
      const p = await product()
      const itemId = await inside(async () => {
        const count = await database.client.cycleCount.create({ data: { locationId: loc.fba, status: 'IN_PROGRESS' } })
        return (await database.client.cycleCountItem.create({
          data: { cycleCountId: count.id, productId: p.id, sku: p.sku, expectedQuantity: 7, countedQuantity: 5, status: 'COUNTED' },
        })).id
      })
      await expect(inside(() => cycleCount.reconcileItem({ itemId }))).rejects.toMatchObject(refused)
      expect(await quantities(p.id)).toEqual(START)
      expect((await inside(() => database.client.cycleCountItem.findUnique({ where: { id: itemId } })))?.status).toBe('COUNTED')
    })

    it('the adjust route refuses a warehouse whose location is the FBA mirror (400) and changes nothing', async () => {
      const p = await product()
      const response = await app.inject({ method: 'POST', url: `/api/fulfillment/stock/${p.id}/adjust`, payload: { change: 3, warehouseId: fbaWarehouseId } })
      expect(response.statusCode, response.body).toBe(400)
      expect(response.json()).toMatchObject(refused)
      expect(await quantities(p.id)).toEqual(START)
    })
  })

  describe('F7 — channel stock events', () => {
    const event = (productId: string, sku: string, channel: string, locationId: string, drift: number) => inside(async () => (await database.client.channelStockEvent.create({
      data: {
        channel, channelEventId: `TEST-EVT-${randomUUID()}`, productId, sku, locationId,
        channelReportedQty: 0, localQtyAtObservation: 0, drift, status: 'REVIEW_NEEDED',
      },
    })).id)
    const statusOf = (id: string) => inside(async () => (await database.client.channelStockEvent.findUnique({ where: { id } }))?.status)

    it('applying an event at the FBA location is refused; the event stays open', async () => {
      const p = await product()
      const id = await event(p.id, p.sku, 'AMAZON', loc.fba, -2)
      await expect(inside(() => channelEvents.applyChannelStockEvent(id, 'person'))).rejects.toMatchObject(refused)
      expect(await quantities(p.id)).toEqual(START)
      expect(await statusOf(id)).toBe('REVIEW_NEEDED')
    })

    it('applying another channel’s event at a Shopify location is refused', async () => {
      const p = await product()
      const id = await event(p.id, p.sku, 'EBAY', loc.shop, 1)
      await expect(inside(() => channelEvents.applyChannelStockEvent(id, 'person'))).rejects.toMatchObject(refused)
      expect(await quantities(p.id)).toEqual(START)
    })

    it('control: Shopify’s own event at its Shopify location still applies', async () => {
      const p = await product()
      const id = await event(p.id, p.sku, 'SHOPIFY', loc.shop, 1)
      await inside(() => channelEvents.applyChannelStockEvent(id, 'person'))
      expect(await quantities(p.id)).toEqual({ ...START, shop: 5 })
      expect(await statusOf(id)).toBe('APPLIED')
    })

    it('a small drift reported at the FBA location is not auto-applied: it is kept on record as Amazon\'s (S2b) and changes nothing', async () => {
      const p = await product()
      const out = await inside(() => channelEvents.recordChannelStockEvent({
        channel: 'AMAZON', channelEventId: `TEST-EVT-${randomUUID()}`, productId: p.id, channelReportedQty: 8, locationId: loc.fba,
      }))
      expect(out).toMatchObject({ status: 'IGNORED', drift: 1 })
      expect(await quantities(p.id)).toEqual(START)
    })

    it('control: a small drift Shopify reports at its own location is still auto-applied', async () => {
      const p = await product()
      const out = await inside(() => channelEvents.recordChannelStockEvent({
        channel: 'SHOPIFY', channelEventId: `TEST-EVT-${randomUUID()}`, productId: p.id, channelReportedQty: 5, locationId: loc.shop,
      }))
      expect(out).toMatchObject({ status: 'AUTO_APPLIED', drift: 1 })
      expect(await quantities(p.id)).toEqual({ ...START, shop: 5 })
    })
  })

  describe('F8 — a transfer is one transaction', () => {
    it('control: a transfer between two warehouses moves the units and records both movements with from and to', async () => {
      const p = await product()
      await inside(() => levels.transferStock({ productId: p.id, fromLocationId: loc.wh, toLocationId: loc.wh2, quantity: 3 }))
      expect(await quantities(p.id)).toEqual({ ...START, wh: 7, wh2: 3 })
      const moves = await inside(() => database.client.stockMovement.findMany({
        where: { productId: p.id }, orderBy: { change: 'asc' }, select: { reason: true, change: true, fromLocationId: true, toLocationId: true },
      }))
      expect(moves).toEqual([
        { reason: 'TRANSFER_OUT', change: -3, fromLocationId: loc.wh, toLocationId: loc.wh2 },
        { reason: 'TRANSFER_IN', change: 3, fromLocationId: loc.wh, toLocationId: loc.wh2 },
      ])
    })

    it('when the arriving side fails, the units never leave the source', async () => {
      const p = await product()
      // A destination that does not exist: the IN movement cannot be written.
      await expect(inside(() => levels.transferStock({ productId: p.id, fromLocationId: loc.wh, toLocationId: `missing-${randomUUID()}`, quantity: 2 }))).rejects.toThrow()
      expect(await quantities(p.id)).toEqual(START)
      expect(await inside(() => database.client.stockMovement.count({ where: { productId: p.id } }))).toBe(0)
    })
  })
})
