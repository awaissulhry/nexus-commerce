/**
 * Step 2 "Sells from" — a sale takes its stock from the first location of its market's list that has enough, on a
 * REAL multi-connection PostgreSQL, through the real order writers (Amazon FBM poll, eBay writer) and the real stock
 * service. Owner rulings 2026-10-07: one order line is never split; none has enough → the first location (the
 * shortfall is reported as before); the listing's own list beats the market's list; a give-back returns the units to
 * the location the sale took them from.
 *
 * The race arm is why this needs a real server: the location is picked AFTER the order-stock lock, so orders racing
 * for the last units of the first location each see the others' holds and move on to the next location — none fails.
 * Picked before the lock, every order would choose the first location and all but one would fail.
 *
 * 🔴 Needs a MULTI-CONNECTION PostgreSQL; without one the suite SKIPS. From the repo root:
 * `node scripts/run-real-postgres-tests.mjs --suites '[{"name":"sells from","file":"src/services/stock/sale-location-postgres.vitest.test.ts","expect":6}]'`
 * Only SP-API, queues and display caches are faked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { CONCURRENT_PG_ENV, concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
const upstream = vi.hoisted(() => ({ orders: [] as unknown[], items: new Map<string, unknown[]>() }))

vi.mock('../../db.js', () => ({
  default: new Proxy({} as Record<string, unknown>, {
    get: (_t, property) => (database.client as unknown as Record<string, unknown>)[property as string],
  }),
}))
vi.mock('../marketplaces/amazon.service.js', () => ({
  AmazonService: class {
    async isConfigured() { return true }
    async fetchOrders() { return upstream.orders }
    async fetchOrderItems(amazonOrderId: string) { return upstream.items.get(amazonOrderId) ?? [] }
    async fetchOrderById() { return null }
  },
}))
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []) }
  return { addJobSafely: vi.fn(async () => undefined), outboundSyncQueue: queue, readCacheQueue: queue,
    searchIndexQueue: queue, channelSyncQueue: queue, bulkJobQueue: queue, redis: { connection: null } }
})
vi.mock('../advertising/ads-cache.js', () => ({ cached: async (_k: string, _t: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined, putCached: () => undefined, flushAdsCache: async () => undefined }))
vi.mock('../product-read-cache.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../product-read-cache.service.js')>()),
  productReadCacheService: { refresh: vi.fn(async () => undefined) },
}))
vi.mock('../customer-cache.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../customer-cache.service.js')>()),
  linkAndRefreshCustomerForOrder: vi.fn(async () => undefined),
}))

const WS = 'nexus_legacy_workspace'
const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const inBusiness = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: WS, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const q = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]

describe.skipIf(!concurrentDatabaseUrl())(`"Sells from": a sale takes stock from the first listed location with enough (needs ${CONCURRENT_PG_ENV})`, () => {
  let levels: typeof import('../stock-level.service.js')
  let amazon: InstanceType<typeof import('../amazon-orders.service.js').AmazonOrdersService>
  let ebay: { processOrder: (order: unknown, connectionId: string) => Promise<{ id: string }> }
  const loc: Record<'main' | 'tpl', string> = { main: '', tpl: '' }
  let amazonAccount = ''
  let ebayAccount = ''

  /** A product with stock at IT-MAIN (the default warehouse) and MI-3PL. */
  const seedProduct = async (main: number, tpl: number) => {
    const productId = randomUUID(), sku = `SF-${productId.slice(0, 8)}`
    await q(`INSERT INTO "Product" (id,"workspaceId",sku,name,"basePrice","totalStock","updatedAt") VALUES ($1,$2,$3,$3,10,$4,now())`, [productId, WS, sku, main + tpl])
    for (const [locationId, units] of [[loc.main, main], [loc.tpl, tpl]] as const) {
      await q(`INSERT INTO "StockLevel" (id,"workspaceId","locationId","productId",quantity,reserved,available,"lastUpdatedAt") VALUES ($1,$2,$3,$4,$5,0,$5,now())`,
        [randomUUID(), WS, locationId, productId, units])
    }
    return { productId, sku }
  }
  const listing = (productId: string, channel: 'AMAZON' | 'EBAY', marketplace: string, account: string, extra: { itemId?: string; codes?: string[] } = {}) =>
    q(`INSERT INTO "ChannelListing" (id,"workspaceId","productId","channelMarket",channel,region,marketplace,"channelConnectionId","listingStatus","isPublished","externalListingId","sourceLocationCodes","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$6,$7,'ACTIVE',true,$8,$9::text[],now())`,
    [randomUUID(), WS, productId, `${channel}_${marketplace}`, channel, marketplace, account, extra.itemId ?? null, extra.codes ?? []])
  const levelAt = async (productId: string, locationId: string) =>
    (await q<{ quantity: number; reserved: number; available: number }>(`SELECT quantity,reserved,available FROM "StockLevel" WHERE "productId"=$1 AND "locationId"=$2`, [productId, locationId]))[0]
  /** Where each open hold of the order sits, by location code. */
  const holdsAt = (orderId: string) => q<{ code: string; quantity: number }>(
    `SELECT l.code, r.quantity FROM "StockReservation" r JOIN "StockLevel" s ON s.id=r."stockLevelId" JOIN "StockLocation" l ON l.id=s."locationId"
     WHERE r."orderId"=$1 AND r."releasedAt" IS NULL ORDER BY l.code`, [orderId])

  const amazonRead = async (amazonOrderId: string, lines: Array<{ sku: string; quantity: number }>) => {
    upstream.items.set(amazonOrderId, lines.map((line, i) => ({ OrderItemId: `${amazonOrderId}-${i}`, SellerSKU: line.sku, QuantityOrdered: line.quantity,
      ItemPrice: { Amount: String(10 * line.quantity), CurrencyCode: 'EUR' } })))
    upstream.orders = [{ AmazonOrderId: amazonOrderId, PurchaseDate: '2026-10-07T08:00:00Z', LastUpdateDate: '2026-10-07T08:00:00Z', OrderStatus: 'Unshipped',
      FulfillmentChannel: 'MFN', MarketplaceId: 'APJ6JRA9NG5V4', OrderTotal: { Amount: '20', CurrencyCode: 'EUR' } }]
    const summary = await inBusiness(() => amazon.syncNewOrders(new Date('2026-10-01T00:00:00Z')))
    // Positive control: the read ran and wrote the order and its lines.
    expect(summary).toMatchObject({ ordersFetched: 1, ordersUpserted: 1, ordersFailed: 0, itemsFailed: 0 })
    const [order] = await q<{ id: string }>(`SELECT id FROM "Order" WHERE channel='AMAZON' AND "channelOrderId"=$1`, [amazonOrderId])
    return { orderId: order.id, summary }
  }

  beforeAll(async () => {
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    database = await concurrentDatabase({ maxConnections: 24 })
    // Deployed databases carry these; schema.prisma cannot express them.
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_available_invariant" CHECK ("available" = "quantity" - "reserved")`)
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_quantity_nonneg" CHECK ("quantity" >= 0)`)
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_reserved_nonneg" CHECK ("reserved" >= 0)`)
    await q(`CREATE UNIQUE INDEX "StockLevel_loc_prod_novar_unique" ON "StockLevel" ("workspaceId","locationId","productId") WHERE "variationId" IS NULL`)
    const mainWarehouse = randomUUID(), tplWarehouse = randomUUID()
    await q(`INSERT INTO "Warehouse" (id,"workspaceId",code,name,country,"isDefault","updatedAt") VALUES ($1,$3,'IT-MAIN','Main','IT',true,now()), ($2,$3,'MI-3PL','Milan 3PL','IT',false,now())`,
      [mainWarehouse, tplWarehouse, WS])
    loc.main = randomUUID(); loc.tpl = randomUUID()
    await q(`INSERT INTO "StockLocation" (id,"workspaceId",type,code,name,"warehouseId","updatedAt") VALUES ($1,$5,'WAREHOUSE','IT-MAIN','Main',$3,now()), ($2,$5,'WAREHOUSE','MI-3PL','Milan 3PL',$4,now())`,
      [loc.main, loc.tpl, mainWarehouse, tplWarehouse, WS])
    amazonAccount = randomUUID(); ebayAccount = randomUUID()
    await q(`INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","externalAccountId","isActive","managedBy","authStatus","updatedAt") VALUES ($1,$2,'AMAZON','SELLER-SF',true,'oauth','connected',now())`, [amazonAccount, WS])
    await q(`INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","managedBy","externalAccountId","isActive","connectionMetadata","updatedAt") VALUES ($1,$2,'EBAY','oauth','seller-sf',true,'{"environment":"production"}'::jsonb,now())`, [ebayAccount, WS])
    // The business's lists: Amazon IT sells from MI-3PL first, then IT-MAIN; eBay DE from MI-3PL only. eBay IT has
    // none, so its routes decide (every location; the default warehouse first).
    await q(`INSERT INTO "SyncChannelPolicy" (id,"workspaceId",channel,marketplace,"sourceLocationCodes","updatedAt") VALUES ($1,$3,'AMAZON','IT',ARRAY['MI-3PL','IT-MAIN'],now()), ($2,$3,'EBAY','DE',ARRAY['MI-3PL'],now())`,
      [randomUUID(), randomUUID(), WS])
    levels = await import('../stock-level.service.js')
    const { AmazonOrdersService } = await import('../amazon-orders.service.js')
    amazon = new AmazonOrdersService()
    const { EbayOrdersService } = await import('../ebay-orders.service.js')
    ebay = new EbayOrdersService() as unknown as typeof ebay
  }, 180_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  }, 60_000)

  beforeEach(() => vi.clearAllMocks())

  it('1. Amazon FBM — held at the first listed location (MI-3PL), not the default warehouse; a re-read holds nothing more', async () => {
    const p = await seedProduct(10, 10)
    const { orderId } = await amazonRead(`AMZ-${randomUUID()}`, [{ sku: p.sku, quantity: 2 }])
    expect(await holdsAt(orderId)).toEqual([{ code: 'MI-3PL', quantity: 2 }])
    expect(await levelAt(p.productId, loc.tpl)).toEqual({ quantity: 10, reserved: 2, available: 8 })
    expect(await levelAt(p.productId, loc.main)).toEqual({ quantity: 10, reserved: 0, available: 10 })
  })

  it('2. Amazon FBM — the first location with enough for the WHOLE line wins; none has enough → the first location, a shortfall, never a split', async () => {
    const short = await seedProduct(10, 1)
    const first = await amazonRead(`AMZ-${randomUUID()}`, [{ sku: short.sku, quantity: 2 }])
    expect(await holdsAt(first.orderId)).toEqual([{ code: 'IT-MAIN', quantity: 2 }])
    expect(await levelAt(short.productId, loc.tpl)).toEqual({ quantity: 1, reserved: 0, available: 1 })

    const none = await seedProduct(1, 1)
    const second = await amazonRead(`AMZ-${randomUUID()}`, [{ sku: none.sku, quantity: 2 }])
    expect(second.summary).toMatchObject({ fbmInsufficientStock: 1, fbmReservationsCreated: 0 })
    expect(await holdsAt(second.orderId)).toEqual([])
    expect(await levelAt(none.productId, loc.main)).toEqual({ quantity: 1, reserved: 0, available: 1 })
    expect(await levelAt(none.productId, loc.tpl)).toEqual({ quantity: 1, reserved: 0, available: 1 })
  })

  it('3. the listing\'s own list beats the market list (Amazon IT listing → IT-MAIN only)', async () => {
    const p = await seedProduct(10, 10)
    await listing(p.productId, 'AMAZON', 'IT', amazonAccount, { codes: ['IT-MAIN'] })
    const { orderId } = await amazonRead(`AMZ-${randomUUID()}`, [{ sku: p.sku, quantity: 3 }])
    expect(await holdsAt(orderId)).toEqual([{ code: 'IT-MAIN', quantity: 3 }])
  })

  it('4. orders racing for the last units of the first location: each sees the others\' holds, moves on to the next, and none fails', async () => {
    const p = await seedProduct(10, 3)
    const orders = Array.from({ length: 4 }, () => randomUUID())
    for (const id of orders) {
      await q(`INSERT INTO "Order" (id,"workspaceId",channel,"channelOrderId","totalPrice","customerName","customerEmail","shippingAddress","updatedAt") VALUES ($1,$2,'AMAZON',$1,20,'Buyer','b@example.test','{}'::jsonb,now())`, [id, WS])
      await q(`INSERT INTO "OrderItem" (id,"workspaceId","orderId","productId",sku,quantity,price,"externalLineItemId","updatedAt") VALUES ($1,$2,$3,$4,$5,2,10,$1,now())`, [randomUUID(), WS, id, p.productId, p.sku])
    }
    const results = await Promise.allSettled(orders.map((orderId) => inBusiness(() => levels.reserveOpenOrder({
      orderId, productId: p.productId, locationId: loc.main, quantity: 2, actor: 'test',
      sale: { channel: 'AMAZON', marketplace: 'IT', channelConnectionId: amazonAccount },
    }))))
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'])
    const placed = (await Promise.all(orders.map(holdsAt))).flat().map((h) => h.code).sort()
    expect(placed).toEqual(['IT-MAIN', 'IT-MAIN', 'IT-MAIN', 'MI-3PL'])
    expect(await levelAt(p.productId, loc.tpl)).toEqual({ quantity: 3, reserved: 2, available: 1 })
    expect(await levelAt(p.productId, loc.main)).toEqual({ quantity: 10, reserved: 6, available: 4 })
  })

  it('5. eBay — each line follows the listing it sold through (item id): DE takes from MI-3PL, IT (no list: routes) from the default warehouse', async () => {
    const p = await seedProduct(10, 10)
    const tag = randomUUID().slice(0, 8)
    await listing(p.productId, 'EBAY', 'IT', ebayAccount, { itemId: `IT-${tag}` })
    await listing(p.productId, 'EBAY', 'DE', ebayAccount, { itemId: `DE-${tag}` })
    const orderId = `EB-${tag}`
    await inBusiness(() => ebay.processOrder({
      orderId, creationDate: '2026-10-07T10:00:00.000Z', orderPaymentStatus: 'PAID', orderFulfillmentStatus: 'NOT_STARTED',
      buyer: { username: 'Buyer.Name_01' }, pricingSummary: { total: { value: '50.00', currency: 'EUR' } },
      lineItems: [
        { lineItemId: `${orderId}-1`, sku: p.sku, legacyItemId: `DE-${tag}`, title: 'DE', quantity: 3, lineItemCost: { value: '30.00', currency: 'EUR' } },
        { lineItemId: `${orderId}-2`, sku: p.sku, legacyItemId: `IT-${tag}`, title: 'IT', quantity: 2, lineItemCost: { value: '20.00', currency: 'EUR' } },
      ],
    }, ebayAccount))
    expect(await levelAt(p.productId, loc.tpl)).toEqual({ quantity: 7, reserved: 0, available: 7 })
    expect(await levelAt(p.productId, loc.main)).toEqual({ quantity: 8, reserved: 0, available: 8 })
    const moves = await q<{ code: string; change: number }>(`SELECT l.code, m.change FROM "StockMovement" m JOIN "StockLocation" l ON l.id=m."locationId"
      WHERE m."orderId"=(SELECT id FROM "Order" WHERE channel='EBAY' AND "channelOrderId"=$1) AND m.reason='ORDER_PLACED' ORDER BY l.code`, [orderId])
    expect(moves).toEqual([{ code: 'IT-MAIN', change: -2 }, { code: 'MI-3PL', change: -3 }])
  })

  it('6. a give-back returns the units to the location the sale took them from (hold released at MI-3PL, take restored to MI-3PL)', async () => {
    const p = await seedProduct(10, 10)
    const { orderId } = await amazonRead(`AMZ-${randomUUID()}`, [{ sku: p.sku, quantity: 2 }])
    expect(await holdsAt(orderId)).toEqual([{ code: 'MI-3PL', quantity: 2 }])
    expect(await inBusiness(() => levels.releaseOpenOrder({ orderId, actor: 'test' }))).toBe(1)
    expect(await levelAt(p.productId, loc.tpl)).toEqual({ quantity: 10, reserved: 0, available: 10 })

    const tag = randomUUID().slice(0, 8)
    await listing(p.productId, 'EBAY', 'DE', ebayAccount, { itemId: `DE-${tag}` })
    const ebayOrderId = `EB-${tag}`
    await inBusiness(() => ebay.processOrder({
      orderId: ebayOrderId, creationDate: '2026-10-07T10:00:00.000Z', orderPaymentStatus: 'PAID', orderFulfillmentStatus: 'NOT_STARTED',
      buyer: { username: 'Buyer.Name_01' }, pricingSummary: { total: { value: '10.00', currency: 'EUR' } },
      lineItems: [{ lineItemId: `${ebayOrderId}-1`, sku: p.sku, legacyItemId: `DE-${tag}`, title: 'DE', quantity: 1, lineItemCost: { value: '10.00', currency: 'EUR' } }],
    }, ebayAccount))
    expect(await levelAt(p.productId, loc.tpl)).toEqual({ quantity: 9, reserved: 0, available: 9 })
    const [order] = await q<{ id: string }>(`SELECT id FROM "Order" WHERE channel='EBAY' AND "channelOrderId"=$1`, [ebayOrderId])
    expect(await inBusiness(() => levels.giveBackOrderTakes(order.id, 'test'))).toMatchObject({ restored: 1, units: 1 })
    expect(await levelAt(p.productId, loc.tpl)).toEqual({ quantity: 10, reserved: 0, available: 10 })
    expect(await levelAt(p.productId, loc.main)).toEqual({ quantity: 10, reserved: 0, available: 10 })
  })
})
