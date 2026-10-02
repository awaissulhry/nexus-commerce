/**
 * MCP full control 08 S2b — an FBA stock number from Amazon never moves an own warehouse.
 *
 * Amazon's only stock notification, FBA_INVENTORY_AVAILABILITY_CHANGES, reports FBA fulfillable units per SKU and
 * carries no location. `amazon-sqs-poll.job.ts` records each one with `recordChannelStockEvent({ channel: 'AMAZON',
 * channelEventId, sku, channelReportedQty, rawPayload })` — no location. Before, that event was compared with the
 * product's stock in EVERY location (own warehouse + FBA mirror + Shopify) and a drift of 1 was applied, unasked, to
 * the default own warehouse (IT-MAIN); a bigger drift could be applied there by one click on the channel-drift page.
 * FBA quantity is the Owner's untouchable rule: now an Amazon event is compared with the FBA mirror, pinned to it, and
 * never applied anywhere (only the FBA inventory sync writes FBA stock).
 *
 * Real SQL (PGlite with the production schema); the service is the real one, called the way the SQS job calls it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
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

describe('08 S2b — an FBA stock event never moves an own warehouse', () => {
  let channelEvents: typeof import('./channel-stock-event.service.js')
  const loc = { main: '', fba: '' }

  /** A product with its own levels: own warehouse `main`, FBA mirror `fba` (0 = no FBA row). */
  const product = (main: number, fba: number) => inside(async () => {
    const db = database.client
    const sku = `TEST-SKU-S2B-${randomUUID().slice(0, 8)}`
    const { id } = await db.product.create({ data: { sku, name: sku, basePrice: '10.00', totalStock: main + fba } })
    await db.stockLevel.create({ data: { locationId: loc.main, productId: id, quantity: main, reserved: 0, available: main } })
    if (fba > 0) await db.stockLevel.create({ data: { locationId: loc.fba, productId: id, quantity: fba, reserved: 0, available: fba } })
    return { id, sku }
  })
  const quantities = (productId: string) => inside(async () => {
    const rows = await database.client.stockLevel.findMany({ where: { productId }, select: { locationId: true, quantity: true } })
    const at = (location: string) => rows.find((r) => r.locationId === location)?.quantity ?? 0
    const movements = await database.client.stockMovement.count({ where: { productId } })
    return { main: at(loc.main), fba: at(loc.fba), movements }
  })
  /** Exactly the call `amazon-sqs-poll.job.ts` makes for one SKU of an FBA_INVENTORY_AVAILABILITY_CHANGES message. */
  const fbaNotification = (sku: string, fulfillableQty: number) => inside(() => channelEvents.recordChannelStockEvent({
    channel: 'AMAZON',
    channelEventId: `TEST-MSG-${randomUUID()}:${sku}`,
    sku,
    channelReportedQty: Math.max(0, fulfillableQty),
    rawPayload: { sku, fulfillableQty },
  }))
  const eventRow = (id: string) => inside(() => database.client.channelStockEvent.findUnique({ where: { id } }))

  beforeAll(async () => {
    database = await formulaDatabase()
    await inside(async () => {
      const db = database.client
      // The default own warehouse a location-less movement lands on, and the FBA mirror the FBA inventory sync writes.
      loc.main = (await db.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'IT-MAIN', name: 'Own warehouse (test)' } })).id
      loc.fba = (await db.stockLocation.create({ data: { type: 'AMAZON_FBA', code: 'AMAZON-EU-FBA', name: 'Amazon FBA (test)' } })).id
    })
    channelEvents = await import('./channel-stock-event.service.js')
  }, 180_000)

  afterAll(async () => {
    await database?.close()
  })

  it('FBA gains one unit (mirror 6 → Amazon says 7): the own warehouse gains nothing; the drift is kept on record at the FBA mirror, settled as Amazon\'s', async () => {
    const p = await product(0, 6)
    const out = await fbaNotification(p.sku, 7)
    expect(await quantities(p.id)).toEqual({ main: 0, fba: 6, movements: 0 })
    expect(out).toMatchObject({ status: 'IGNORED', drift: 1, localQtyAtObservation: 6 })
    expect(await eventRow(out.id)).toMatchObject({
      locationId: loc.fba, resultingMovementId: null, status: 'IGNORED', resolution: 'Amazon owns the FBA number', resolvedByUserId: 'auto', resolvedAt: expect.any(Date),
    })
  })

  it('a big FBA drift (mirror 6 → Amazon says 2) waits for nobody either: recorded, settled as Amazon\'s, nothing moves', async () => {
    const p = await product(3, 6)
    const out = await fbaNotification(p.sku, 2)
    expect(out).toMatchObject({ status: 'IGNORED', drift: -4 })
    expect(await quantities(p.id)).toEqual({ main: 3, fba: 6, movements: 0 })
    const open = await inside(() => channelEvents.listChannelStockEvents({ status: 'OPEN' }))
    expect(open.map((e) => e.id)).not.toContain(out.id)
  })

  it('an FBA SKU with no FBA stock (Amazon says 0) leaves the one own unit alone: compared with the mirror there is no drift', async () => {
    const p = await product(1, 0)
    const out = await fbaNotification(p.sku, 0)
    expect(await quantities(p.id)).toEqual({ main: 1, fba: 0, movements: 0 })
    expect(out).toMatchObject({ status: 'APPLIED', drift: 0, localQtyAtObservation: 0 })
  })

  it('applying an Amazon event recorded before the fix (no location) is refused; the own warehouse and the event stay as they were', async () => {
    const p = await product(4, 6)
    const id = await inside(async () => (await database.client.channelStockEvent.create({
      data: {
        channel: 'AMAZON', channelEventId: `TEST-OLD-${randomUUID()}`, productId: p.id, sku: p.sku, locationId: null,
        channelReportedQty: 13, localQtyAtObservation: 10, drift: 3, status: 'REVIEW_NEEDED',
      },
    })).id)
    await expect(inside(() => channelEvents.applyChannelStockEvent(id, 'person'))).rejects.toMatchObject({
      code: 'PROTECTED_LOCATION', message: expect.stringContaining('never changes an own warehouse'),
    })
    expect(await quantities(p.id)).toEqual({ main: 4, fba: 6, movements: 0 })
    expect((await eventRow(id))?.status).toBe('REVIEW_NEEDED')
  })

  it('an Amazon event pinned to an own warehouse by hand is not auto-applied, and Apply refuses it', async () => {
    const p = await product(5, 0)
    const out = await inside(() => channelEvents.recordChannelStockEvent({
      channel: 'AMAZON', channelEventId: `TEST-EVT-${randomUUID()}`, sku: p.sku, channelReportedQty: 6, locationId: loc.main,
    }))
    expect(out).toMatchObject({ status: 'REVIEW_NEEDED', drift: 1 })
    await expect(inside(() => channelEvents.applyChannelStockEvent(out.id, 'person'))).rejects.toMatchObject({ code: 'PROTECTED_LOCATION' })
    expect(await quantities(p.id)).toEqual({ main: 5, fba: 0, movements: 0 })
  })

  it('control: an eBay event with no location still auto-applies a drift of 1 to the own warehouse (unchanged)', async () => {
    const p = await product(3, 0)
    const out = await inside(() => channelEvents.recordChannelStockEvent({
      channel: 'EBAY', channelEventId: `TEST-EVT-${randomUUID()}`, sku: p.sku, channelReportedQty: 4,
    }))
    expect(out).toMatchObject({ status: 'AUTO_APPLIED', drift: 1 })
    expect(await quantities(p.id)).toEqual({ main: 4, fba: 0, movements: 1 })
  })
})
