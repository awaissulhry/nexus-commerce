/**
 * Expected base — a person's absolute "set on-hand to N" names the on-hand it SAW, and a sale that lands while the
 * person types is never overwritten (checkSeenOnHand, location-adjustment.ts):
 *   - the inventory editor's batch and the single cell (`POST /api/stock/adjust-locations`, `/adjust-location`);
 *   - the Stock page's FBM cell (`setFbmOnHand`, behind `PATCH /api/products/:id/fbm-stock`);
 * and the FBA page's "Pause Listings" (`POST /api/stock/pause`) is a real, recorded stock change: one audited movement
 * per own-warehouse level, cascaded to the listings that follow stock, Amazon FBA units never written.
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
vi.mock('../advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined,
  putCached: () => undefined,
  flushAdsCache: async () => undefined,
}))
/** Products whose Pause movement fails (a stand-in for a lock timeout on one level): the other levels must go on. */
const failFor = vi.hoisted(() => new Set<string>())
vi.mock('../stock-movement.service.js', async (original) => {
  const real = await original<typeof import('../stock-movement.service.js')>()
  return {
    ...real,
    applyStockMovementInTx: async (...args: Parameters<typeof real.applyStockMovementInTx>) => {
      if (failFor.has(args[1].productId)) throw new Error('TEST lock timeout')
      return real.applyStockMovementInTx(...args)
    },
  }
})
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn(async () => undefined) } }))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client

type Json = any
const ids = { main: '', second: '', fba: '', shop: '', editor: '', fbm: '', parent: '', child: '', other: '', ebay: '', pinned: '', grand: '', mid: '', leaf: '', broken: '' }
let app: FastifyInstance

async function send(method: 'POST', url: string, payload?: unknown): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as never }) })
  return { status: response.statusCode, body: response.json() }
}
const qty = (productId: string, locationId: string) => inside(async () => (await db().stockLevel.findFirst({ where: { productId, locationId } }))?.quantity ?? null)
const movements = (productId: string) => inside(() => db().stockMovement.findMany({ where: { productId }, orderBy: { createdAt: 'asc' } }))
/** A sale lands: the order path's movement, through the same service every stock writer uses. */
async function sale(productId: string, locationId: string) {
  const { applyStockMovement } = await import('../stock-movement.service.js')
  await inside(() => applyStockMovement({ productId, locationId, change: -1, reason: 'ORDER_PLACED', actor: 'test-order' }))
}

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const d = db()
    const warehouse = await d.warehouse.create({ data: { code: 'TEST-EB-WH', name: 'Main', isDefault: true } as never })
    ids.main = (await d.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'TEST-EB-MAIN', name: 'Main warehouse', warehouseId: warehouse.id } })).id
    ids.second = (await d.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'TEST-EB-SECOND', name: 'Second warehouse' } })).id
    ids.fba = (await d.stockLocation.create({ data: { type: 'AMAZON_FBA', code: 'TEST-EB-FBA', name: 'Amazon FBA' } })).id
    ids.shop = (await d.stockLocation.create({ data: { type: 'SHOPIFY_LOCATION', code: 'TEST-EB-SHOP', name: 'Shopify shop' } })).id
    ids.editor = (await d.product.create({ data: { sku: 'TEST-SKU-EB-EDITOR', name: 'Test editor product', basePrice: '10.00' } })).id
    ids.fbm = (await d.product.create({ data: { sku: 'TEST-SKU-EB-FBM', name: 'Test FBM cell product', basePrice: '10.00' } })).id
    ids.parent = (await d.product.create({ data: { sku: 'TEST-SKU-EB-PARENT', name: 'Test FBA parent', basePrice: '10.00', isParent: true, fulfillmentMethod: 'FBA' } as never })).id
    ids.child = (await d.product.create({ data: { sku: 'TEST-SKU-EB-CHILD', name: 'Test FBA child', basePrice: '10.00', parentId: ids.parent, fulfillmentMethod: 'FBA' } as never })).id
    ids.other = (await d.product.create({ data: { sku: 'TEST-SKU-EB-OTHER', name: 'Test not selected', basePrice: '10.00' } })).id
    // A three-level family: the Pause of the top reaches the bottom.
    ids.grand = (await d.product.create({ data: { sku: 'TEST-SKU-EB-GRAND', name: 'Test family top', basePrice: '10.00', isParent: true } as never })).id
    ids.mid = (await d.product.create({ data: { sku: 'TEST-SKU-EB-MID', name: 'Test family middle', basePrice: '10.00', isParent: true, parentId: ids.grand } as never })).id
    ids.leaf = (await d.product.create({ data: { sku: 'TEST-SKU-EB-LEAF', name: 'Test family bottom', basePrice: '10.00', parentId: ids.mid } as never })).id
    ids.broken = (await d.product.create({ data: { sku: 'TEST-SKU-EB-BROKEN', name: 'Test level that fails', basePrice: '10.00' } })).id
    const levels: Array<[string, string, number, number]> = [
      [ids.editor, ids.main, 10, 0],
      [ids.fbm, ids.main, 6, 0], [ids.fbm, ids.second, 4, 0], [ids.fbm, ids.fba, 7, 0],
      [ids.child, ids.main, 10, 2], [ids.child, ids.second, 3, 0], [ids.child, ids.fba, 5, 0], [ids.child, ids.shop, 4, 0],
      [ids.parent, ids.second, 2, 0],
      [ids.other, ids.main, 9, 0],
      [ids.leaf, ids.main, 6, 0],
      [ids.broken, ids.main, 3, 0],
    ]
    for (const [productId, locationId, quantity, reserved] of levels) {
      await d.stockLevel.create({ data: { productId, locationId, quantity, reserved, available: quantity - reserved } })
    }
    const account = await d.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'TEST-EB-EBAY', isActive: true } })
    ids.ebay = (await d.channelListing.create({ data: {
      productId: ids.child, channel: 'EBAY', channelConnectionId: account.id, channelMarket: 'EBAY_IT', marketplace: 'IT', region: 'EU',
      price: 10, followMasterPrice: true, quantity: 11, followMasterQuantity: true, stockBuffer: 0, fulfillmentMethod: 'FBM',
      externalListingId: 'TEST-EB-ITEM-1', listingStatus: 'ACTIVE', isPublished: true,
    } as never })).id
    // A fixed number: this listing does not follow stock, so the Pause cannot reach it — the answer names it.
    ids.pinned = (await d.channelListing.create({ data: {
      productId: ids.child, channel: 'EBAY', channelConnectionId: account.id, channelMarket: 'EBAY_DE', marketplace: 'DE', region: 'EU',
      price: 10, followMasterPrice: true, quantity: 4, quantityOverride: 4, followMasterQuantity: false, stockBuffer: 0, fulfillmentMethod: 'FBM',
      externalListingId: 'TEST-EB-ITEM-2', listingStatus: 'ACTIVE', isPublished: true,
    } as never })).id
  })
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(business, done) })
  await app.register((await import('../../routes/stock.routes.js')).default, { prefix: '/api' })
  await app.ready()
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
})

describe('the inventory editor and the single cell: the on-hand the person saw', () => {
  it('a sale between the read and the save is kept: the save is refused with the current number, nothing is booked', async () => {
    // The person reads 10 and types 8 (−2). A sale lands meanwhile: 9.
    await sale(ids.editor, ids.main)
    const before = (await movements(ids.editor)).length
    const out = await send('POST', '/api/stock/adjust-locations', { reason: 'INVENTORY_COUNT', changes: [{ productId: ids.editor, locationId: ids.main, value: 8, expected: 10 }] })
    expect(out.status).toBe(200)
    expect(out.body).toEqual({
      ok: false,
      results: [{
        productId: ids.editor, locationId: ids.main, ok: false, code: 'STALE_ON_HAND', current: 9,
        error: 'On hand changed from 10 to 9 while you were editing (a sale, a return or another person). Nothing was saved: check the new number and save again.',
      }],
    })
    expect(await qty(ids.editor, ids.main)).toBe(9)
    expect((await movements(ids.editor)).length).toBe(before)

    // The single cell answers 409 with the same refusal.
    const single = await send('POST', '/api/stock/adjust-location', { productId: ids.editor, locationId: ids.main, value: 8, expected: 10 })
    expect(single).toMatchObject({ status: 409, body: { code: 'STALE_ON_HAND', current: 9 } })
    expect(await qty(ids.editor, ids.main)).toBe(9)
  })

  it('on the number the person saw, the save books new − seen; the same save sent twice books nothing', async () => {
    const before = (await movements(ids.editor)).length
    const first = await send('POST', '/api/stock/adjust-locations', { reason: 'INVENTORY_COUNT', changes: [{ productId: ids.editor, locationId: ids.main, value: 7, expected: 9 }] })
    expect(first.body).toEqual({ ok: true, results: [{ productId: ids.editor, locationId: ids.main, ok: true, noop: false, quantity: 7, reserved: 0, available: 7 }] })
    const booked = await movements(ids.editor)
    expect(booked.length).toBe(before + 1)
    expect(booked.at(-1)).toMatchObject({ change: -2, reason: 'INVENTORY_COUNT', actor: 'products-next-inventory-editor' })

    // A retried save (double click, network retry): the number is already there — nothing is booked, no refusal.
    const again = await send('POST', '/api/stock/adjust-locations', { reason: 'INVENTORY_COUNT', changes: [{ productId: ids.editor, locationId: ids.main, value: 7, expected: 9 }] })
    expect(again.body).toEqual({ ok: true, results: [{ productId: ids.editor, locationId: ids.main, ok: true, noop: true, quantity: 7, reserved: 0, available: 7 }] })
    expect(await qty(ids.editor, ids.main)).toBe(7)
    expect((await movements(ids.editor)).length).toBe(before + 1)
  })

  it('a base that is not a whole number is refused; a call without one answers as before', async () => {
    const bad = await send('POST', '/api/stock/adjust-location', { productId: ids.editor, locationId: ids.main, value: 5, expected: 'x' })
    expect(bad).toEqual({ status: 400, body: { error: 'The on-hand you saw must be a whole number of 0 or more.', code: 'INVALID_VALUE' } })
    const legacy = await send('POST', '/api/stock/adjust-location', { productId: ids.editor, locationId: ids.main, value: 6 })
    expect(legacy.body).toMatchObject({ ok: true, noop: false, movement: { change: -1 } })
    expect(await qty(ids.editor, ids.main)).toBe(6)
  })
})

describe('the Stock page FBM cell: the non-FBA total the person saw', () => {
  it('a sale between the read and the save is kept; on the seen total the delta lands; the same value twice books nothing; FBA untouched', async () => {
    const { setFbmOnHand, FbmOnHandError } = await import('./location-adjust.service.js')
    // The person reads FBM 10 (6 + 4) and types 12. A sale at the main warehouse lands meanwhile: 9.
    await sale(ids.fbm, ids.main)
    const before = (await movements(ids.fbm)).length
    const refused = await inside(() => setFbmOnHand({ productId: ids.fbm, value: 12, expected: 10, reason: 'MANUAL_ADJUSTMENT', actor: 'fbm-inline' })).catch((e) => e)
    expect(refused).toBeInstanceOf(FbmOnHandError)
    expect(refused).toMatchObject({ code: 'STALE_ON_HAND', stock: { fbaStock: 7, fbmStock: 9 } })
    expect(await qty(ids.fbm, ids.main)).toBe(5)
    expect((await movements(ids.fbm)).length).toBe(before)

    // Saved again on the number now shown (9): +3 lands on the biggest warehouse bucket.
    const saved = await inside(() => setFbmOnHand({ productId: ids.fbm, value: 12, expected: 9, reason: 'MANUAL_ADJUSTMENT', actor: 'fbm-inline' }))
    expect(saved).toMatchObject({ noChange: false, fbaStock: 7, fbmStock: 12, movement: { change: 3, actor: 'fbm-inline' } })
    const again = await inside(() => setFbmOnHand({ productId: ids.fbm, value: 12, expected: 9, reason: 'MANUAL_ADJUSTMENT', actor: 'fbm-inline' }))
    expect(again).toEqual({ noChange: true, movement: null, fbaStock: 7, fbmStock: 12 })
    expect((await movements(ids.fbm)).length).toBe(before + 1)
    expect(await qty(ids.fbm, ids.fba)).toBe(7)
  })
})

describe('the FBA page Pause: a real, recorded stock change', () => {
  it('own-warehouse levels of the product and its variations go to their reserved count, one audited movement each, cascaded; FBA and Shopify untouched', async () => {
    const { PAUSE_NOTE } = await import('./location-adjust.service.js')
    const out = await send('POST', '/api/stock/pause', { productIds: [ids.parent, 'not-a-product'] })
    expect(out).toEqual({ status: 200, body: { ok: true, products: 1, variations: 1, notFound: 1, paused: 3, units: 13, skipped: 0, failed: [], notFollowing: 1 } })
    // The child: main 10 → 2 (2 reserved for open orders stay), second 3 → 0; the parent's own second 2 → 0.
    expect(await qty(ids.child, ids.main)).toBe(2)
    expect(await qty(ids.child, ids.second)).toBe(0)
    expect(await qty(ids.parent, ids.second)).toBe(0)
    // Amazon FBA and the Shopify location are never written; a product not chosen is not touched.
    expect(await qty(ids.child, ids.fba)).toBe(5)
    expect(await qty(ids.child, ids.shop)).toBe(4)
    expect(await qty(ids.other, ids.main)).toBe(9)

    const rows = await inside(() => db().stockMovement.findMany({ where: { productId: { in: [ids.child, ids.parent] } } }))
    expect(rows).toHaveLength(3)
    for (const row of rows) expect(row).toMatchObject({ reason: 'MANUAL_ADJUSTMENT', notes: PAUSE_NOTE, actor: 'products-fba-pause' })
    expect(rows.some((r) => r.locationId === ids.fba || r.locationId === ids.shop)).toBe(false)
    expect((await inside(() => db().product.findUniqueOrThrow({ where: { id: ids.child } }))).totalStock).toBe(2)

    // The cascade: the eBay listing that follows stock now shows 0 and a quantity push waits for it.
    expect((await inside(() => db().channelListing.findUniqueOrThrow({ where: { id: ids.ebay } }))).quantity).toBe(0)
    const pushes = await inside(() => db().outboundSyncQueue.findMany({ where: { channelListingId: ids.ebay, syncType: 'QUANTITY_UPDATE' } }))
    expect(pushes.length).toBeGreaterThan(0)
    // The fixed-number listing keeps its quantity — and was counted in `notFollowing` above.
    expect((await inside(() => db().channelListing.findUniqueOrThrow({ where: { id: ids.pinned } }))).quantity).toBe(4)
  })

  it('the whole family, at any depth; a level that fails is reported by SKU and location while the others go on', async () => {
    failFor.add(ids.broken)
    try {
      const out = await send('POST', '/api/stock/pause', { productIds: [ids.grand, ids.broken] })
      expect(out).toEqual({ status: 200, body: {
        ok: true, products: 2, variations: 2, notFound: 0, paused: 1, units: 6, skipped: 0, notFollowing: 0,
        failed: [{ sku: 'TEST-SKU-EB-BROKEN', location: 'TEST-EB-MAIN', reason: 'TEST lock timeout' }],
      } })
    } finally {
      failFor.delete(ids.broken)
    }
    expect(await qty(ids.leaf, ids.main)).toBe(0) // two levels below the selected product
    expect(await qty(ids.broken, ids.main)).toBe(3) // rolled back, unchanged
    expect(await movements(ids.broken)).toHaveLength(0)
  })

  it('a sale after the pause is kept; pausing again books nothing; bad and too-large requests are refused before anything runs', async () => {
    await sale(ids.child, ids.main) // 2 → 1
    const before = (await movements(ids.child)).length
    const out = await send('POST', '/api/stock/pause', { productIds: [ids.parent] })
    expect(out.body).toMatchObject({ ok: true, paused: 0, units: 0, skipped: 3, failed: [] })
    expect(await qty(ids.child, ids.main)).toBe(1)
    expect((await movements(ids.child)).length).toBe(before)
    expect(await send('POST', '/api/stock/pause', {})).toEqual({ status: 400, body: { error: '`productIds` must be a list of product ids', code: 'MISSING_FIELDS' } })
    expect(await send('POST', '/api/stock/pause', { productIds: Array.from({ length: 201 }, (_, i) => `p${i}`) })).toEqual({ status: 400, body: {
      error: 'Pause takes at most 200 products at a time; 201 are selected. Select fewer and pause again.', code: 'TOO_MANY',
    } })
  })
})
