/**
 * MCP full control 08 S3 — the stock reads, for the stock page and for Claude.
 *
 *   Routes: they keep their answers now that their reads live in `services/stock/stock-read.service.ts`. Written
 *   against the routes BEFORE the move and unchanged after it: the stock list (`GET /api/stock`), the locations
 *   (`GET /api/stock/locations`), one product's stock (`GET /api/stock/product/:id`), transfers, reservations and the
 *   cycle counts (`GET /api/fulfillment/cycle-counts`, `/:id`). (Also checked once by hand on 2026-10-01: the full
 *   answers of 18 requests, ids and times normalised, were byte-identical before and after the move.)
 *   Tools: Claude's eight stock reads, through the one door (call-tool.ts), on the same rows; none writes anything.
 *   Step 3 (cases): the product read carries each product's case sizes and the sealed cases of each size each level shows.
 *
 * Real SQL (PGlite with the production schema); the real route plugins in a Fastify app.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { FEATURES } from '@nexus/shared/permissions'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
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

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

type Json = any
const ids = { main: '', second: '', fba: '', jacket: '', gloves: '', count: '', reservation: '' }
let app: FastifyInstance

async function get(url: string): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method: 'GET', url })
  return { status: response.statusCode, body: response.json() }
}

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const db = database.client
    ids.main = (await db.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'TEST-MAIN', name: 'Main warehouse', servesMarketplaces: ['IT'] } })).id
    ids.second = (await db.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'TEST-SECOND', name: 'Second warehouse' } })).id
    ids.fba = (await db.stockLocation.create({ data: { type: 'AMAZON_FBA', code: 'TEST-FBA', name: 'Amazon FBA' } })).id
    const product = (sku: string, name: string) => db.product.create({ data: { sku, name, basePrice: '19.90', costPrice: '4.20', lowStockThreshold: 2 } })
    ids.jacket = (await product('TEST-SKU-S3-JACKET', 'Test jacket')).id
    ids.gloves = (await product('TEST-SKU-S3-GLOVES', 'Test gloves')).id
    for (const [productId, locationId, quantity] of [[ids.jacket, ids.main, 10], [ids.jacket, ids.fba, 5], [ids.gloves, ids.main, 0]] as const) {
      await db.stockLevel.create({ data: { productId, locationId, quantity, reserved: 0, available: quantity } })
    }
    await db.syncChannelPolicy.create({ data: { channel: 'EBAY', marketplace: 'IT', pushesPaused: true, newListingDefaultMode: 'FOLLOW' } })
  })
  const levels = await import('../stock-level.service.js')
  const cycleCounts = await import('../cycle-count.service.js')
  await inside(() => levels.transferStock({ productId: ids.jacket, fromLocationId: ids.main, toLocationId: ids.second, quantity: 2, notes: 'TEST transfer' }))
  ids.reservation = (await inside(() => levels.reserveStock({ productId: ids.jacket, locationId: ids.main, quantity: 1, reason: 'MANUAL_HOLD', actor: 'test' }))).id
  ids.count = (await inside(() => cycleCounts.createCycleCount({ locationId: ids.main, notes: 'TEST count' }))).id
  await inside(() => cycleCounts.startCycleCount(ids.count))
  const items = await inside(() => database.client.cycleCountItem.findMany({ where: { cycleCountId: ids.count }, orderBy: { sku: 'asc' } }))
  await inside(() => cycleCounts.recordCount({ itemId: items.find((i) => i.productId === ids.jacket)!.id, countedQuantity: 6 }))

  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(business, done) })
  const { default: stockRoutes } = await import('../../routes/stock.routes.js')
  const { default: fulfillmentRoutes } = await import('../../routes/fulfillment.routes.js')
  await app.register(stockRoutes, { prefix: '/api' })
  await app.register(fulfillmentRoutes, { prefix: '/api' })
  await app.ready()
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
})

describe('08 S3 — the stock read routes answer as before', () => {
  it('GET /api/stock: leaf stock rows with product and location, filtered by location and status, paged', async () => {
    const all = await get('/api/stock')
    expect(all.status).toBe(200)
    expect(all.body).toMatchObject({ total: 4, page: 1, pageSize: 50, totalPages: 1 })
    expect(all.body.items.map((r: Json) => [r.product.sku, r.location.code, r.quantity, r.reserved, r.available])).toEqual([
      ['TEST-SKU-S3-GLOVES', 'TEST-MAIN', 0, 0, 0],
      ['TEST-SKU-S3-JACKET', 'TEST-SECOND', 2, 0, 2],
      ['TEST-SKU-S3-JACKET', 'TEST-FBA', 5, 0, 5],
      ['TEST-SKU-S3-JACKET', 'TEST-MAIN', 8, 1, 7],
    ])
    expect(Object.keys(all.body.items[0]).sort()).toEqual([
      'available', 'id', 'lastSyncedAt', 'lastUpdatedAt', 'location', 'product', 'quantity', 'reorderQuantity', 'reorderThreshold',
      'reserved', 'syncStatus', 'variation',
    ])
    expect(all.body.items[0].product).toMatchObject({ costPrice: 4.2, basePrice: 19.9, thumbnailUrl: null, parentProduct: null })
    const out = await get('/api/stock?status=OUT_OF_STOCK&locationCode=TEST-MAIN')
    expect(out.body.items.map((r: Json) => r.product.sku)).toEqual(['TEST-SKU-S3-GLOVES'])
    expect((await get('/api/stock?locationCode=NOPE')).body).toEqual({ items: [], total: 0, page: 1, pageSize: 50, totalPages: 0 })
    expect((await get('/api/stock?locationType=AMAZON_FBA&search=jacket')).body.items.map((r: Json) => r.location.code)).toEqual(['TEST-FBA'])
    expect((await get('/api/stock?page=2&pageSize=3')).body).toMatchObject({ total: 4, page: 2, pageSize: 3, totalPages: 2, items: [{ quantity: 8 }] })
  })

  it('GET /api/stock/locations: every location with its totals', async () => {
    const { status, body } = await get('/api/stock/locations')
    expect(status).toBe(200)
    expect(body).toEqual({
      locations: [
        { id: ids.fba, code: 'TEST-FBA', name: 'Amazon FBA', type: 'AMAZON_FBA', isActive: true, servesMarketplaces: [], warehouseId: null, skuCount: 1, totalQuantity: 5, totalReserved: 0, totalAvailable: 5 },
        { id: ids.main, code: 'TEST-MAIN', name: 'Main warehouse', type: 'WAREHOUSE', isActive: true, servesMarketplaces: ['IT'], warehouseId: null, skuCount: 2, totalQuantity: 8, totalReserved: 1, totalAvailable: 7 },
        { id: ids.second, code: 'TEST-SECOND', name: 'Second warehouse', type: 'WAREHOUSE', isActive: true, servesMarketplaces: [], warehouseId: null, skuCount: 1, totalQuantity: 2, totalReserved: 0, totalAvailable: 2 },
      ],
    })
  })

  it('GET /api/stock/product/:id: levels, movements, reservations, costing and the rest; 404 when unknown', async () => {
    const { status, body } = await get(`/api/stock/product/${ids.jacket}`)
    expect(status).toBe(200)
    expect(Object.keys(body).sort()).toEqual([
      'atp', 'atpPerChannel', 'channelListings', 'costing', 'family', 'lentUsage', 'lots', 'movements', 'poolSource', 'product',
      'reservations', 'salesVelocity', 'serialCounts', 'serials', 'stockLevels',
    ])
    expect(body.product).toMatchObject({ id: ids.jacket, sku: 'TEST-SKU-S3-JACKET', basePrice: 19.9, costPrice: 4.2, thumbnailUrl: null })
    expect(body.stockLevels.map((l: Json) => [l.location.code, l.quantity, l.reserved, l.available, l.activeReservations])).toEqual([
      ['TEST-MAIN', 8, 1, 7, 1], ['TEST-FBA', 5, 0, 5, 0], ['TEST-SECOND', 2, 0, 2, 0],
    ])
    expect(body.movements.map((m: Json) => [m.reason, m.change])).toEqual(expect.arrayContaining([['TRANSFER_OUT', -2], ['TRANSFER_IN', 2]]))
    expect(body.reservations).toEqual([expect.objectContaining({ id: ids.reservation, quantity: 1, reason: 'MANUAL_HOLD', location: { id: ids.main, code: 'TEST-MAIN' }, usedBy: null })])
    expect(body).toMatchObject({ poolSource: null, lentUsage: [], family: null, lots: [], serials: [], serialCounts: {}, channelListings: [], atpPerChannel: [] })
    expect(body.salesVelocity).toMatchObject({ last30Units: 0, avgDailyUnits: 0, daysOfStock: null, totalAvailable: 14, dailyHistory: [] })
    expect(body.costing).toMatchObject({ method: 'WAC', layers: [expect.objectContaining({ locationCode: 'TEST-SECOND', unitCostCents: 420, unitsReceived: 2 })] })
    expect((await get('/api/stock/product/nope')).status).toBe(404)
    expect((await get('/api/stock/product/nope')).body).toEqual({ error: 'Product not found' })
  })

  it('GET /api/stock/transfers: one row per transfer, both sides named', async () => {
    const { status, body } = await get('/api/stock/transfers')
    expect(status).toBe(200)
    expect(body.count).toBe(1)
    expect(body.transfers).toEqual([expect.objectContaining({
      quantity: 2, notes: 'TEST transfer', status: 'COMPLETED',
      from: { id: ids.main, code: 'TEST-MAIN', name: 'Main warehouse', type: 'WAREHOUSE' },
      to: { id: ids.second, code: 'TEST-SECOND', name: 'Second warehouse', type: 'WAREHOUSE' },
      product: { id: ids.jacket, sku: 'TEST-SKU-S3-JACKET', name: 'Test jacket', amazonAsin: null, thumbnailUrl: null },
    })])
    expect(Object.keys(body.transfers[0]).sort()).toEqual(['actor', 'createdAt', 'from', 'id', 'notes', 'product', 'quantity', 'siblingOutId', 'startedAt', 'status', 'to'])
  })

  it('GET /api/stock/reservations: rows with status, location and product; filtered by status', async () => {
    const { status, body } = await get('/api/stock/reservations?status=active')
    expect(status).toBe(200)
    expect(body).toMatchObject({ count: 1, status: 'active' })
    expect(body.reservations).toEqual([expect.objectContaining({
      id: ids.reservation, quantity: 1, reason: 'MANUAL_HOLD', status: 'active', orderId: null,
      location: { id: ids.main, code: 'TEST-MAIN', name: 'Main warehouse', type: 'WAREHOUSE' },
      stockLevel: { quantity: 8, reserved: 1, available: 7 },
      product: { id: ids.jacket, sku: 'TEST-SKU-S3-JACKET', name: 'Test jacket', amazonAsin: null, thumbnailUrl: null },
    })])
    expect((await get('/api/stock/reservations?status=released')).body).toEqual({ reservations: [], count: 0, status: 'released' })
  })

  it('GET /api/fulfillment/cycle-counts and /:id: the counts with item totals, one count with its items; 404 when unknown', async () => {
    const list = await get('/api/fulfillment/cycle-counts')
    expect(list.status).toBe(200)
    expect(list.body.success).toBe(true)
    expect(list.body.counts).toEqual([expect.objectContaining({
      id: ids.count, status: 'IN_PROGRESS', notes: 'TEST count', totalItems: 2,
      itemTotals: { PENDING: 1, COUNTED: 1, RECONCILED: 0, IGNORED: 0 },
      location: { id: ids.main, code: 'TEST-MAIN', name: 'Main warehouse' },
    })])
    expect(list.body.counts[0]).not.toHaveProperty('items')
    expect((await get('/api/fulfillment/cycle-counts?status=COMPLETED')).body).toEqual({ success: true, counts: [] })
    const one = await get(`/api/fulfillment/cycle-counts/${ids.count}`)
    expect(one.status).toBe(200)
    expect(one.body.count.items.map((i: Json) => [i.sku, i.expectedQuantity, i.countedQuantity, i.variance, i.status, i.productName, i.lots])).toEqual([
      ['TEST-SKU-S3-GLOVES', 0, null, null, 'PENDING', 'Test gloves', []],
      ['TEST-SKU-S3-JACKET', 8, 6, -2, 'COUNTED', 'Test jacket', []],
    ])
    expect(await get('/api/fulfillment/cycle-counts/nope')).toEqual({ status: 404, body: { error: 'Cycle count not found' } })
  })
})

// ── Claude's stock reads ───────────────────────────────────────────────────────────────────────────────

describe("08 S3 — Claude's stock reads", () => {
  const claude = {
    kind: 'user' as const, userId: 'u-s3', label: 'S3 test', via: 'claude' as const, workspace: business,
    permissions: { isOwner: false, permissions: new Set<string>(Object.values(FEATURES)) },
  }
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Json> => {
    const { callTool } = await import('../agents/call-tool.js')
    return (await inside(() => callTool(claude, name, args))).visible
  }
  const ledger = () => inside(async () => ({
    levels: await database.client.stockLevel.findMany({ orderBy: { id: 'asc' }, select: { id: true, quantity: true, reserved: true, available: true } }),
    movements: await database.client.stockMovement.count(),
    reservations: await database.client.stockReservation.count(),
  }))
  let before: Awaited<ReturnType<typeof ledger>>
  beforeAll(async () => { before = await ledger() })

  it('stock-levels: per location with who owns the number (FBA read-only), totals, holds and the stock source', async () => {
    const out = await call('stock-levels', { productId: ids.jacket })
    expect(out.ok).toBe(true)
    expect(out.data.locations.map((l: Json) => [l.code, l.type, l.managedBy, l.readOnly, l.quantity, l.reserved, l.available])).toEqual([
      ['TEST-MAIN', 'WAREHOUSE', 'nexus', false, 8, 1, 7],
      ['TEST-FBA', 'AMAZON_FBA', 'amazon-fba', true, 5, 0, 5],
      ['TEST-SECOND', 'WAREHOUSE', 'nexus', false, 2, 0, 2],
    ])
    expect(out.data).toMatchObject({
      sku: 'TEST-SKU-S3-JACKET', stockSource: { kind: 'own' }, totals: { onHand: 15, reserved: 1, available: 14, fbaOnHand: 5 },
      reservations: [{ quantity: 1, reason: 'MANUAL_HOLD', location: 'TEST-MAIN', orderId: null }],
      note: expect.stringContaining('Amazon-managed'),
    })
    expect(JSON.stringify(out)).not.toMatch(/costPrice|weightedAvgCostCents|unitCostCents/)
    expect(await call('stock-levels', { productId: 'nope' })).toEqual({ ok: false, error: 'Product not found' })
  })

  it('stock-search: by band, location and own threshold; pages follow nextCursor with no row twice; a changed cursor is refused', async () => {
    const rows = (out: Json) => out.data.items.map((r: Json) => `${r.sku}@${r.location.code}`)
    expect(rows(await call('stock-search', { band: 'out' }))).toEqual(['TEST-SKU-S3-GLOVES@TEST-MAIN'])
    expect(rows(await call('stock-search', { location: 'TEST-FBA' }))).toEqual(['TEST-SKU-S3-JACKET@TEST-FBA'])
    expect(rows(await call('stock-search', { belowThreshold: true }))).toEqual(['TEST-SKU-S3-GLOVES@TEST-MAIN', 'TEST-SKU-S3-JACKET@TEST-SECOND'])
    expect((await call('stock-search', { query: 'gloves' })).data.items[0]).toMatchObject({ band: 'out', belowThreshold: true, location: { managedBy: 'nexus' } })
    const seen: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 6; page++) {
      const out = await call('stock-search', { limit: 1, ...(cursor ? { cursor } : {}) })
      seen.push(...rows(out))
      cursor = out.data.nextCursor ?? undefined
      if (!cursor) break
    }
    expect(seen).toEqual(['TEST-SKU-S3-GLOVES@TEST-MAIN', 'TEST-SKU-S3-JACKET@TEST-FBA', 'TEST-SKU-S3-JACKET@TEST-MAIN', 'TEST-SKU-S3-JACKET@TEST-SECOND'])
    const first = await call('stock-search', { limit: 1 })
    const other = await call('stock-search', { limit: 1, band: 'low', cursor: first.data.nextCursor })
    expect(other).toMatchObject({ ok: false, error: expect.stringContaining('cursor') })
  })

  it('stock-movements: the ledger newest first; transfers name from and to; one product; paged', async () => {
    const transfers = await call('stock-movements', { kind: 'transfers' })
    expect(transfers.data.items.map((m: Json) => [m.reason, m.change, m.from, m.to, m.sku]).sort()).toEqual([
      ['TRANSFER_IN', 2, 'TEST-MAIN', 'TEST-SECOND', 'TEST-SKU-S3-JACKET'],
      ['TRANSFER_OUT', -2, 'TEST-MAIN', 'TEST-SECOND', 'TEST-SKU-S3-JACKET'],
    ])
    expect((await call('stock-movements', { productId: ids.gloves })).data.items).toEqual([])
    const all = (await call('stock-movements', { productId: ids.jacket })).data.items.map((m: Json) => m.id)
    const paged: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page++) {
      const out = await call('stock-movements', { productId: ids.jacket, limit: 1, ...(cursor ? { cursor } : {}) })
      paged.push(...out.data.items.map((m: Json) => m.id))
      cursor = out.data.nextCursor ?? undefined
      if (!cursor) break
    }
    expect(paged).toEqual(all)
    expect(all.length).toBeGreaterThanOrEqual(2)
  })

  it('stock-locations: every location, who owns its number, routes and totals; the channel sync policies', async () => {
    const out = await call('stock-locations')
    expect(out.data.locations.map((l: Json) => [l.code, l.managedBy, l.readOnly, l.onHand, l.syncRoutes])).toEqual([
      ['TEST-FBA', 'amazon-fba', true, 5, []], ['TEST-MAIN', 'nexus', false, 8, []], ['TEST-SECOND', 'nexus', false, 2, []],
    ])
    expect(out.data.syncPolicies).toEqual([{ channel: 'EBAY', market: 'IT', account: 'every account', pushesPaused: true, newListingsStart: 'following stock' }])
  })

  it('stock-reservations and cycle-counts: the holds; the counts, one count with its variance, and what is due', async () => {
    expect((await call('stock-reservations')).data).toMatchObject({ status: 'active', count: 1, reservations: [{ quantity: 1, status: 'active', product: { sku: 'TEST-SKU-S3-JACKET' } }] })
    expect((await call('stock-reservations', { status: 'released' })).data.count).toBe(0)
    const counts = await call('cycle-counts')
    expect(counts.data.counts).toEqual([expect.objectContaining({ id: ids.count, status: 'IN_PROGRESS', totalItems: 2, items: { PENDING: 1, COUNTED: 1, RECONCILED: 0, IGNORED: 0 } })])
    const one = await call('cycle-counts', { countId: ids.count })
    expect(one.data.items.map((i: Json) => [i.sku, i.expected, i.counted, i.variance, i.status])).toEqual([
      ['TEST-SKU-S3-GLOVES', 0, null, null, 'PENDING'], ['TEST-SKU-S3-JACKET', 8, 6, -2, 'COUNTED'],
    ])
    expect(one.data.location).toMatchObject({ code: 'TEST-MAIN', managedBy: 'nexus' })
    expect((await call('cycle-counts', { dueAt: 'TEST-MAIN' })).data.dueForCount.products.map((p: Json) => p.sku).sort()).toEqual(['TEST-SKU-S3-GLOVES', 'TEST-SKU-S3-JACKET'])
    expect(await call('cycle-counts', { countId: 'nope' })).toEqual({ ok: false, error: 'Cycle count not found' })
  })

  it('shared-stock and fba-inventory: own stock by SKU; the FBA mirror, read-only', async () => {
    const shared = await call('shared-stock', { sku: 'TEST-SKU-S3' })
    expect(shared.data).toMatchObject({ lending: [], borrowing: [], oversold: [] })
    expect(shared.data.products.map((p: Json) => [p.sku, p.sellsFrom, p.own.onHand])).toEqual([['TEST-SKU-S3-GLOVES', 'own', 0], ['TEST-SKU-S3-JACKET', 'own', 10]])
    const fba = await call('fba-inventory', { productId: ids.jacket })
    expect(fba.data.items).toEqual([expect.objectContaining({ sku: 'TEST-SKU-S3-JACKET', quantity: 5, location: expect.objectContaining({ code: 'TEST-FBA', managedBy: 'amazon-fba', readOnly: true }) })])
    expect(fba.data).toMatchObject({ byFulfilmentCentre: [], restock: [], note: expect.stringContaining('no tool changes it') })
    expect((await call('fba-inventory')).data).toMatchObject({ items: [expect.objectContaining({ quantity: 5 })], byFulfilmentCentre: [], aged: [], unfulfillable: [] })
  })

  it('none of the reads changed a stock level, a movement or a hold', async () => {
    expect(await ledger()).toEqual(before)
  })
})


// ── Step 3: the stock editor reads case sizes and sealed cases ──────────────────────────────────────────

describe('Step 3 — GET /api/stock/product/:id carries the case sizes and the sealed cases of each size each level shows', () => {
  const box = { parent: '', red: '', blue: '', single: '' }
  const levelId = async (productId: string, locationId: string) =>
    (await database.client.stockLevel.findFirstOrThrow({ where: { productId, locationId }, select: { id: true } })).id

  beforeAll(async () => {
    await inside(async () => {
      const db = database.client
      const product = (sku: string, extra: Record<string, unknown> = {}) => db.product.create({ data: { sku, name: sku, basePrice: '9.00', ...extra } })
      box.parent = (await product('TEST-SKU-S3C-PARENT', { isParent: true })).id
      box.red = (await product('TEST-SKU-S3C-RED', { parentId: box.parent })).id
      box.blue = (await product('TEST-SKU-S3C-BLUE', { parentId: box.parent })).id
      box.single = (await product('TEST-SKU-S3C-SINGLE')).id
      for (const [productId, locationId, quantity] of [[box.red, ids.main, 27], [box.red, ids.fba, 12], [box.blue, ids.main, 5], [box.single, ids.main, 30]] as const) {
        await db.stockLevel.create({ data: { productId, locationId, quantity, reserved: 0, available: quantity } })
      }
      const red6 = (await db.productCaseSize.create({ data: { productId: box.red, unitsPerCase: 6 } })).id
      const red12 = (await db.productCaseSize.create({ data: { productId: box.red, unitsPerCase: 12, caseLengthCm: '60.0', caseWeightKg: '14.50' } })).id
      const single10 = (await db.productCaseSize.create({ data: { productId: box.single, unitsPerCase: 10 } })).id
      // Stored counts written straight (the keeper's job in production): red 1×12 + 2×6 fit 27; single 5 stored but only
      // 3 fit 30 at 10 / case (a sale between a pool door and its settle) — a reader clamps. Blue has no case size.
      await db.stockCaseCount.create({ data: { stockLevelId: await levelId(box.red, ids.main), caseSizeId: red12, cases: 1 } })
      await db.stockCaseCount.create({ data: { stockLevelId: await levelId(box.red, ids.main), caseSizeId: red6, cases: 2 } })
      await db.stockCaseCount.create({ data: { stockLevelId: await levelId(box.single, ids.main), caseSizeId: single10, cases: 5 } })
    })
  })

  it('a single product: product.caseSizes and stockLevels[].cases, clamped by the units', async () => {
    const { status, body } = await get(`/api/stock/product/${box.single}`)
    expect(status).toBe(200)
    expect(body.product.caseSizes).toEqual([10])
    expect(body.stockLevels.map((l: Json) => [l.location.code, l.quantity, l.cases])).toEqual([['TEST-MAIN', 30, [{ unitsPerCase: 10, cases: 3 }]]])
  })

  it('a product with no case size: caseSizes [] and no sealed cases anywhere', async () => {
    const { body } = await get(`/api/stock/product/${ids.jacket}`)
    expect(body.product.caseSizes).toEqual([])
    expect(body.stockLevels.map((l: Json) => l.cases)).toEqual([[], [], []])
  })

  it('a family: children[].caseSizes (biggest first) and children[].stockLevels[].cases per size (0 at FBA, [] without a case size)', async () => {
    const { status, body } = await get(`/api/stock/product/${box.parent}?family=true`)
    expect(status).toBe(200)
    expect(body.product.caseSizes).toEqual([])
    expect(body.family.children.map((c: Json) => [c.sku, c.caseSizes, c.stockLevels.map((l: Json) => [l.locationCode, l.quantity, l.cases])])).toEqual([
      ['TEST-SKU-S3C-BLUE', [], [['TEST-MAIN', 5, []]]],
      ['TEST-SKU-S3C-RED', [12, 6], [
        ['TEST-MAIN', 27, [{ unitsPerCase: 12, cases: 1 }, { unitsPerCase: 6, cases: 2 }]],
        ['TEST-FBA', 12, [{ unitsPerCase: 12, cases: 0 }, { unitsPerCase: 6, cases: 0 }]],
      ]],
    ])
    expect(Object.keys(body.family.children[0].stockLevels[0]).sort()).toEqual([
      'available', 'cases', 'lastUpdatedAt', 'locationCode', 'locationId', 'locationType', 'quantity', 'reserved', 'syncStatus',
    ])
  })
})
