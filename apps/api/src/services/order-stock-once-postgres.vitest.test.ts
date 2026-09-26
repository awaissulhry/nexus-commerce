/**
 * An order line's stock is taken ONCE (hotfix 2026-09-26).
 *
 * The defect: `reserveOpenOrder` counted an order line as held only while its hold was OPEN. The Amazon
 * poll re-reads FBM orders — also ones that shipped long ago and whose hold was already consumed — so
 * every re-read made a fresh hold, and the hourly reservation reconcile consumed it (the order is
 * SHIPPED/DELIVERED): the same units left stock again and again.
 *
 * The invariant these arms hold the code to: for any (order, product), units taken by the order's own
 * holds never exceed units ordered, and re-reading an order never holds units it already took.
 *
 * 🔴 Needs a MULTI-CONNECTION PostgreSQL (the locks and the race arm mean nothing on PGlite). Without
 * one the suite SKIPS. From the repo root: `node scripts/run-real-postgres-tests.mjs` (registered).
 * Only SP-API and the display caches are faked; the order writers, the stock ledger and the reconcile
 * are the real code.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { CONCURRENT_PG_ENV, concurrentDatabase, concurrentDatabaseUrl } from '../test-support/concurrent-database.js'
import { withWorkspace } from '../lib/workspace-context.js'
import { logger } from '../utils/logger.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
const upstream = vi.hoisted(() => ({ orders: [] as unknown[], items: new Map<string, unknown[]>() }))

vi.mock('../db.js', () => ({
  default: new Proxy({} as Record<string, unknown>, {
    get: (_t, property) => (database.client as unknown as Record<string, unknown>)[property as string],
  }),
}))
vi.mock('./marketplaces/amazon.service.js', () => ({
  AmazonService: class {
    async isConfigured() { return true }
    async fetchOrders() { return upstream.orders }
    async fetchOrderItems(amazonOrderId: string) { return upstream.items.get(amazonOrderId) ?? [] }
    async fetchOrderById() { return null }
  },
}))
// Pass-through: lets an arm see whether an Amazon read even ASKED for a hold.
vi.mock('./stock-level.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./stock-level.service.js')>()
  return { ...real, reserveOpenOrder: vi.fn(real.reserveOpenOrder) }
})
// Post-commit BullMQ adds must not reach a real Redis (a local .env may name the shared one).
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []) }
  return { addJobSafely: vi.fn(async () => undefined), outboundSyncQueue: queue, readCacheQueue: queue,
    searchIndexQueue: queue, channelSyncQueue: queue, bulkJobQueue: queue, redis: { connection: null } }
})
vi.mock('./advertising/ads-cache.js', () => ({ cached: async (_k: string, _t: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined, putCached: () => undefined, flushAdsCache: async () => undefined }))
// Detached display refreshes, outside stock semantics; they would otherwise race teardown.
vi.mock('./product-read-cache.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./product-read-cache.service.js')>()),
  productReadCacheService: { refresh: vi.fn(async () => undefined) },
}))
vi.mock('./customer-cache.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./customer-cache.service.js')>()),
  linkAndRefreshCustomerForOrder: vi.fn(async () => undefined),
}))

const WS = 'nexus_legacy_workspace'
const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const inBusiness = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: WS, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const q = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]

describe.skipIf(!concurrentDatabaseUrl())(`an order line's stock is taken once (needs ${CONCURRENT_PG_ENV})`, () => {
  let levels: typeof import('./stock-level.service.js')
  let reconciler: typeof import('./reservation-reconcile.js')
  let shopify: typeof import('../routes/shopify-webhooks.js')
  let mcf: typeof import('./amazon-mcf.service.js')
  let amazon: InstanceType<typeof import('./amazon-orders.service.js').AmazonOrdersService>
  let mainId = ''
  let fbaId = ''

  const seedProduct = async (locationId = mainId, onHand = 10) => {
    const productId = randomUUID(), sku = `ONCE-${productId.slice(0, 8)}`, stockLevelId = randomUUID()
    await q(`INSERT INTO "Product" (id,"workspaceId",sku,name,"basePrice","totalStock","updatedAt") VALUES ($1,$2,$3,$3,10,$4,now())`, [productId, WS, sku, onHand])
    await q(`INSERT INTO "StockLevel" (id,"workspaceId","locationId","productId",quantity,reserved,available,"lastUpdatedAt") VALUES ($1,$2,$3,$4,$5,0,$5,now())`,
      [stockLevelId, WS, locationId, productId, onHand])
    return { productId, sku, stockLevelId }
  }
  /** An order of another channel with these lines (the order the direct and MCF arms work on). */
  const seedOrder = async (lines: Array<{ productId: string; sku: string; quantity: number }>) => {
    const id = randomUUID()
    await q(`INSERT INTO "Order" (id,"workspaceId",channel,"channelOrderId","totalPrice","customerName","customerEmail","shippingAddress","updatedAt")
      VALUES ($1,$2,'EBAY',$1,20,'Buyer','buyer@example.test',$3::jsonb,now())`,
      [id, WS, JSON.stringify({ name: 'Buyer', addressLine1: 'Via Roma 1', city: 'Rimini', postalCode: '47921', countryCode: 'IT' })])
    for (const [i, line] of lines.entries()) {
      await q(`INSERT INTO "OrderItem" (id,"workspaceId","orderId","productId",sku,quantity,price,"externalLineItemId","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,10,$7,now())`,
        [randomUUID(), WS, id, line.productId, line.sku, line.quantity, `${id}-${i}`])
    }
    return id
  }
  /** An OPEN hold written straight into the ledger — the state the old re-read left behind in production. */
  const seedOpenHold = async (stockLevelId: string, orderId: string, quantity: number) => {
    const id = randomUUID()
    await q(`INSERT INTO "StockReservation" (id,"workspaceId","stockLevelId",quantity,"orderId",reason,kind,"expiresAt") VALUES ($1,$2,$3,$4,$5,'OPEN_ORDER','HARD',now() + interval '1 year')`,
      [id, WS, stockLevelId, quantity, orderId])
    await q(`UPDATE "StockLevel" SET reserved = reserved + $2, available = available - $2 WHERE id = $1`, [stockLevelId, quantity])
    return id
  }
  const level = async (productId: string, locationId = mainId) =>
    (await q(`SELECT quantity,reserved,available FROM "StockLevel" WHERE "productId"=$1 AND "locationId"=$2`, [productId, locationId]))[0]
  const holds = (orderId: string) => q<{ id: string; quantity: number; state: string }>(
    `SELECT id,quantity,CASE WHEN "consumedAt" IS NOT NULL THEN 'consumed' WHEN "releasedAt" IS NOT NULL THEN 'released' ELSE 'open' END AS state
     FROM "StockReservation" WHERE "orderId"=$1 ORDER BY "createdAt",id`, [orderId])
  /** Units the order's consumes took out of stock, read from the movement ledger. */
  const taken = async (orderId: string) => Number((await q(
    `SELECT COALESCE(-SUM(change),0)::text AS s FROM "StockMovement" WHERE "orderId"=$1 AND reason='RESERVATION_CONSUMED'`, [orderId]))[0].s)
  const reconcile = () => inBusiness(() => reconciler.reconcileOpenOrderReservations())
  const reserve = (orderId: string, productId: string, quantity: number, locationId = mainId) =>
    inBusiness(() => levels.reserveOpenOrder({ orderId, productId, locationId, quantity, actor: 'test' }))
  const consume = (orderId: string) => inBusiness(() => levels.consumeOpenOrder({ orderId, actor: 'test' }))

  const AMAZON_STATUS = { unshipped: 'Unshipped', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Canceled' } as const
  const amazonUpstream = (amazonOrderId: string, state: keyof typeof AMAZON_STATUS, lines: Array<{ sku: string; quantity: number }>) => {
    upstream.items.set(amazonOrderId, lines.map((line, i) => ({ OrderItemId: `${amazonOrderId}-${i}`, SellerSKU: line.sku, QuantityOrdered: line.quantity,
      ItemPrice: { Amount: String(10 * line.quantity), CurrencyCode: 'EUR' } })))
    upstream.orders = [{ AmazonOrderId: amazonOrderId, PurchaseDate: '2026-09-20T08:00:00Z', LastUpdateDate: '2026-09-21T08:00:00Z', OrderStatus: AMAZON_STATUS[state],
      FulfillmentChannel: 'MFN', MarketplaceId: 'APJ6JRA9NG5V4', OrderTotal: { Amount: '20', CurrencyCode: 'EUR' } }]
  }
  const poll = () => inBusiness(() => amazon.syncNewOrders(new Date('2026-09-01T00:00:00Z')))
  /** One Amazon poll that returns this order, through the real sync. */
  const amazonRead = async (amazonOrderId: string, state: keyof typeof AMAZON_STATUS, lines: Array<{ sku: string; quantity: number }>) => {
    amazonUpstream(amazonOrderId, state, lines)
    // Positive control: the read really ran and wrote the order and its lines.
    expect(await poll()).toMatchObject({ ordersFetched: 1, ordersUpserted: 1, ordersFailed: 0, itemsFailed: 0 })
    return (await q<{ id: string; status: string }>(`SELECT id,status::text AS status FROM "Order" WHERE channel='AMAZON' AND "channelOrderId"=$1`, [amazonOrderId]))[0]
  }

  beforeAll(async () => {
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    database = await concurrentDatabase({ maxConnections: 24 })
    // Deployed databases carry these; schema.prisma cannot express them.
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_available_invariant" CHECK ("available" = "quantity" - "reserved")`)
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_quantity_nonneg" CHECK ("quantity" >= 0)`)
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_reserved_nonneg" CHECK ("reserved" >= 0)`)
    await q(`ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_quantity_positive" CHECK ("quantity" > 0)`)
    await q(`CREATE UNIQUE INDEX "StockLevel_loc_prod_novar_unique" ON "StockLevel" ("workspaceId","locationId","productId") WHERE "variationId" IS NULL`)
    mainId = randomUUID()
    fbaId = randomUUID()
    await q(`INSERT INTO "StockLocation" (id,"workspaceId",type,code,name,"updatedAt") VALUES ($1,$3,'WAREHOUSE','IT-MAIN','Main',now()), ($2,$3,'AMAZON_FBA','AMAZON-EU-FBA','FBA',now())`, [mainId, fbaId, WS])
    levels = await import('./stock-level.service.js')
    reconciler = await import('./reservation-reconcile.js')
    shopify = await import('../routes/shopify-webhooks.js')
    mcf = await import('./amazon-mcf.service.js')
    const { AmazonOrdersService } = await import('./amazon-orders.service.js')
    amazon = new AmazonOrdersService()
  }, 180_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  }, 60_000)

  beforeEach(() => vi.clearAllMocks())

  it('1. Amazon FBM — re-reads of a shipped order hold nothing, and the reconcile takes nothing more', async () => {
    const p = await seedProduct()
    const amazonId = `AMZ-${randomUUID()}`, lines = [{ sku: p.sku, quantity: 2 }]
    const order = await amazonRead(amazonId, 'unshipped', lines)
    expect(await level(p.productId)).toEqual({ quantity: 10, reserved: 2, available: 8 })
    await amazonRead(amazonId, 'shipped', lines)
    expect(await level(p.productId)).toEqual({ quantity: 8, reserved: 0, available: 8 })

    vi.mocked(levels.reserveOpenOrder).mockClear()
    await amazonRead(amazonId, 'shipped', lines) // the next poll reads the shipped order again
    await reconcile()
    await amazonRead(amazonId, 'shipped', lines)
    await amazonRead(amazonId, 'delivered', lines)
    await reconcile()
    await amazonRead(amazonId, 'delivered', lines)
    await reconcile()
    expect(await level(p.productId)).toEqual({ quantity: 8, reserved: 0, available: 8 })
    expect(await taken(order.id)).toBe(2)
    expect((await holds(order.id)).map(({ quantity, state }) => ({ quantity, state }))).toEqual([{ quantity: 2, state: 'consumed' }])
    // And the read of a settled order no longer even asks for a hold.
    expect(vi.mocked(levels.reserveOpenOrder)).not.toHaveBeenCalled()
  })

  it('2. Amazon FBM — an order first read as SHIPPED is held and taken exactly once', async () => {
    const p = await seedProduct()
    const amazonId = `AMZ-${randomUUID()}`, lines = [{ sku: p.sku, quantity: 2 }]
    const order = await amazonRead(amazonId, 'shipped', lines)
    expect(await level(p.productId)).toEqual({ quantity: 8, reserved: 0, available: 8 })
    await amazonRead(amazonId, 'shipped', lines)
    await reconcile()
    expect(await level(p.productId)).toEqual({ quantity: 8, reserved: 0, available: 8 })
    expect(await taken(order.id)).toBe(2)
    expect((await holds(order.id)).map(({ quantity, state }) => ({ quantity, state }))).toEqual([{ quantity: 2, state: 'consumed' }])
  })

  it('3. Amazon FBM — a cancelled order is never held, on its first read or any re-read', async () => {
    const p = await seedProduct()
    const amazonId = `AMZ-${randomUUID()}`, lines = [{ sku: p.sku, quantity: 2 }]
    const order = await amazonRead(amazonId, 'cancelled', lines)
    expect(order.status).toBe('CANCELLED')
    await amazonRead(amazonId, 'cancelled', lines)
    await reconcile()
    expect(await holds(order.id)).toEqual([])
    expect(await level(p.productId)).toEqual({ quantity: 10, reserved: 0, available: 10 })
  })

  it('4. the reconcile never takes a hold beyond what the line still owes: that surplus is released, not consumed, and a warning names it', async () => {
    const p = await seedProduct()
    const amazonId = `AMZ-${randomUUID()}`, lines = [{ sku: p.sku, quantity: 2 }]
    await amazonRead(amazonId, 'unshipped', lines)
    const order = await amazonRead(amazonId, 'shipped', lines)
    expect(await level(p.productId)).toEqual({ quantity: 8, reserved: 0, available: 8 })
    const surplus = await seedOpenHold(p.stockLevelId, order.id, 2)
    expect(await level(p.productId)).toEqual({ quantity: 8, reserved: 2, available: 6 })

    const warn = vi.spyOn(logger, 'warn')
    try {
      await reconcile()
      expect(await level(p.productId)).toEqual({ quantity: 8, reserved: 0, available: 8 })
      expect(await taken(order.id)).toBe(2)
      expect((await holds(order.id)).find((h) => h.id === surplus)?.state).toBe('released')
      expect(await q(`SELECT change,notes FROM "StockMovement" WHERE "reservationId"=$1 AND reason='RESERVATION_RELEASED'`, [surplus]))
        .toEqual([{ change: 0, notes: expect.stringContaining('surplus') }])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('surplus'), expect.objectContaining({ reservationId: surplus, orderId: order.id, owed: 0 }))
    } finally {
      warn.mockRestore()
    }
  })

  it('4b. on an order of two products, a surplus hold of one is released and the other product is untouched', async () => {
    const p = await seedProduct()
    const other = await seedProduct()
    const amazonId = `AMZ-${randomUUID()}`, lines = [{ sku: p.sku, quantity: 1 }, { sku: other.sku, quantity: 2 }]
    await amazonRead(amazonId, 'unshipped', lines)
    const order = await amazonRead(amazonId, 'shipped', lines)
    expect(await level(p.productId)).toEqual({ quantity: 9, reserved: 0, available: 9 })
    expect(await level(other.productId)).toEqual({ quantity: 8, reserved: 0, available: 8 })
    const surplus = await seedOpenHold(p.stockLevelId, order.id, 1)
    await reconcile()
    expect(await level(p.productId)).toEqual({ quantity: 9, reserved: 0, available: 9 })
    expect(await level(other.productId)).toEqual({ quantity: 8, reserved: 0, available: 8 })
    expect((await holds(order.id)).find((h) => h.id === surplus)?.state).toBe('released')
    expect(await taken(order.id)).toBe(3)
  })

  it.each(['RETURNED', 'REFUNDED', 'CANCELLED'])('4c. Amazon FBM — a re-read of an order settled locally as %s holds nothing', async (local) => {
    const p = await seedProduct()
    const amazonId = `AMZ-${randomUUID()}`, lines = [{ sku: p.sku, quantity: 2 }]
    const order = await amazonRead(amazonId, 'shipped', lines)
    await q(`UPDATE "Order" SET status=$2::"OrderStatus" WHERE id=$1`, [order.id, local])
    vi.mocked(levels.reserveOpenOrder).mockClear()
    // Delivered is terminal too, so the status guard lets it through: only the settled check can stop the hold.
    expect((await amazonRead(amazonId, 'delivered', lines)).status).toBe('DELIVERED')
    await reconcile()
    expect(await level(p.productId)).toEqual({ quantity: 8, reserved: 0, available: 8 })
    expect((await holds(order.id)).map((h) => h.state)).toEqual(['consumed'])
    expect(vi.mocked(levels.reserveOpenOrder)).not.toHaveBeenCalled()
  })

  it('5. a partly taken line holds only what it still owes; once fully taken it holds nothing and returns the hold that took the rest', async () => {
    const p = await seedProduct()
    const order = await seedOrder([{ ...p, quantity: 3 }])
    await reserve(order, p.productId, 1)
    expect(await consume(order)).toBe(1) // a first part of the line left
    expect(await level(p.productId)).toEqual({ quantity: 9, reserved: 0, available: 9 })

    const rest = await reserve(order, p.productId, 3) // the whole line is read again
    expect(rest.quantity).toBe(2)
    expect(await level(p.productId)).toEqual({ quantity: 9, reserved: 2, available: 7 })
    expect(await consume(order)).toBe(1)
    expect(await level(p.productId)).toEqual({ quantity: 7, reserved: 0, available: 7 })

    await expect(reserve(order, p.productId, 3)).resolves.toMatchObject({ id: rest.id, quantity: 2 })
    expect(await consume(order)).toBe(0)
    expect(await level(p.productId)).toEqual({ quantity: 7, reserved: 0, available: 7 })
    expect(await taken(order)).toBe(3)
    expect((await holds(order)).map((h) => h.state)).toEqual(['consumed', 'consumed'])
  })

  it('6. what a line owes counts every order line of the product (two lines, 1 + 2 units)', async () => {
    const p = await seedProduct()
    const order = await seedOrder([{ ...p, quantity: 1 }, { ...p, quantity: 2 }])
    await seedOpenHold(p.stockLevelId, order, 1)
    await seedOpenHold(p.stockLevelId, order, 2)
    expect(await consume(order)).toBe(2)
    expect(await level(p.productId)).toEqual({ quantity: 7, reserved: 0, available: 7 })
    expect(await taken(order)).toBe(3)
  })

  it('7. a hold for a product the order has no line for: the first is taken, a later one is released as surplus', async () => {
    const p = await seedProduct()
    const other = await seedProduct()
    const order = await seedOrder([{ ...other, quantity: 1 }]) // the order's only line is another product
    await reserve(order, p.productId, 1)
    expect(await consume(order)).toBe(1)
    expect(await level(p.productId)).toEqual({ quantity: 9, reserved: 0, available: 9 })
    const again = await seedOpenHold(p.stockLevelId, order, 1)
    expect(await consume(order)).toBe(0)
    expect(await level(p.productId)).toEqual({ quantity: 9, reserved: 0, available: 9 })
    expect((await holds(order)).find((h) => h.id === again)?.state).toBe('released')
  })

  it('8. polls, re-holds and reconciles racing on one shipping line take it exactly once', async () => {
    const p = await seedProduct()
    const amazonId = `AMZ-${randomUUID()}`, lines = [{ sku: p.sku, quantity: 2 }]
    const order = await amazonRead(amazonId, 'unshipped', lines)
    expect(await level(p.productId)).toEqual({ quantity: 10, reserved: 2, available: 8 })
    amazonUpstream(amazonId, 'shipped', lines)
    // Five workers at once, each doing three rounds of poll / re-hold / reconcile in its own order, so
    // reads land before, during and after the consume that ships the line.
    const steps: Array<() => Promise<unknown>> = [poll, () => reserve(order.id, p.productId, 2), reconcile]
    const worker = async (offset: number) => {
      for (let round = 0; round < 3; round++) {
        for (let s = 0; s < steps.length; s++) await steps[(s + offset) % steps.length]()
      }
    }
    const settled = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => worker(i)))
    expect(settled.flatMap((r) => (r.status === 'rejected' ? [String(r.reason)] : []))).toEqual([])
    await reconcile() // settle whatever the race left open
    expect(await level(p.productId)).toEqual({ quantity: 8, reserved: 0, available: 8 })
    expect(await taken(order.id)).toBe(2)
    expect((await holds(order.id)).filter((h) => h.state === 'open')).toEqual([])
  })

  it('9. Shopify — the normal flow takes the line once, and a re-delivered orders/create after fulfilment holds nothing more', async () => {
    const p = await seedProduct()
    const shopifyId = String(Date.now()) + String(Math.floor(Math.random() * 1000))
    const created = { id: shopifyId, created_at: '2026-09-20T08:00:00Z', updated_at: '2026-09-20T08:00:00Z', financial_status: 'paid', fulfillment_status: null,
      total_price: '20', currency: 'EUR', email: 'buyer@example.test', line_items: [{ id: 1, sku: p.sku, quantity: 2, price: '10' }] }
    await inBusiness(() => shopify.handleOrderCreate(created))
    expect(await level(p.productId)).toEqual({ quantity: 10, reserved: 2, available: 8 })
    await inBusiness(() => shopify.handleOrderUpdate({ ...created, fulfillment_status: 'fulfilled', updated_at: '2026-09-21T08:00:00Z' }))
    expect(await level(p.productId)).toEqual({ quantity: 8, reserved: 0, available: 8 })

    await inBusiness(() => shopify.handleOrderCreate(created)) // Shopify re-delivers the original create
    await inBusiness(() => shopify.handleFulfillmentCreate({ order_id: shopifyId }))
    await reconcile()
    const order = (await q<{ id: string }>(`SELECT id FROM "Order" WHERE channel='SHOPIFY' AND "channelOrderId"=$1`, [shopifyId]))[0]
    expect(await level(p.productId)).toEqual({ quantity: 8, reserved: 0, available: 8 })
    expect(await taken(order.id)).toBe(2)
  })

  it('10. MCF — a fulfilment from FBA holds and takes the order units once; a cancelled one can be sent again', async () => {
    const p = await seedProduct(fbaId)
    const order = await seedOrder([{ ...p, quantity: 2 }])
    const adapter = {
      createFulfillmentOrder: async () => ({ amazonFulfillmentOrderId: `FO-${randomUUID()}`, raw: {} }),
      getFulfillmentOrder: async () => ({ status: 'COMPLETE', raw: {} }),
      cancelFulfillmentOrder: async () => ({ raw: {} }),
    }
    const first = await inBusiness(() => mcf.createMCFShipment(adapter, { orderId: order }))
    expect(await level(p.productId, fbaId)).toEqual({ quantity: 10, reserved: 2, available: 8 })
    await inBusiness(() => mcf.cancelMCFShipment(adapter, first.amazonFulfillmentOrderId))
    expect(await level(p.productId, fbaId)).toEqual({ quantity: 10, reserved: 0, available: 10 })

    // A released hold took nothing, so the order may hold again.
    const second = await inBusiness(() => mcf.createMCFShipment(adapter, { orderId: order }))
    expect(await level(p.productId, fbaId)).toEqual({ quantity: 10, reserved: 2, available: 8 })
    await inBusiness(() => mcf.syncMCFStatus(adapter, second.amazonFulfillmentOrderId))
    expect(await level(p.productId, fbaId)).toEqual({ quantity: 8, reserved: 0, available: 8 })
    await inBusiness(() => mcf.createMCFShipment(adapter, { orderId: order })) // returns the completed shipment
    await reconcile()
    expect(await level(p.productId, fbaId)).toEqual({ quantity: 8, reserved: 0, available: 8 })
    expect(await taken(order)).toBe(2)
  })
})
