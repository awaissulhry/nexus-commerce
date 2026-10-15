/**
 * Shopify order import starts at its start date (T0), per Shopify account (2026-10-15).
 *
 * What these arms hold the code to, on a real PostgreSQL through the real gate, the real order writer and the real
 * stock ledger (only queues and display caches are stood in):
 * - an account with no start date imports nothing;
 * - an order Shopify created before the start date leaves nothing in Nexus — not on orders/create, not on an
 *   orders/updated that used to fall through to a create, not on its fulfilment or refund: no order, no hold, no
 *   movement, no return;
 * - an order created at or after the start date is held and taken exactly as the writer does it without the gate;
 * - the start date is written once (five simultaneous starts give one row and one time) at a whole second;
 * - while the server switch is off an order webhook is held (InboundDeferred) and writes nothing.
 *
 * 🔴 Needs a MULTI-CONNECTION PostgreSQL. Without one the suite SKIPS. From the repo root:
 * `node scripts/run-real-postgres-tests.mjs` (registered).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { CONCURRENT_PG_ENV, concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>

vi.mock('../../db.js', () => ({
  default: new Proxy({} as Record<string, unknown>, {
    get: (_t, property) => (database.client as unknown as Record<string, unknown>)[property as string],
  }),
}))
// Post-commit BullMQ adds must not reach a real Redis (a local .env may name the shared one).
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []) }
  return { addJobSafely: vi.fn(async () => undefined), outboundSyncQueue: queue, readCacheQueue: queue,
    searchIndexQueue: queue, channelSyncQueue: queue, bulkJobQueue: queue, redis: { connection: null } }
})
vi.mock('../advertising/ads-cache.js', () => ({ cached: async (_k: string, _t: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined, putCached: () => undefined, flushAdsCache: async () => undefined }))
// Detached display refreshes, outside stock semantics; they would otherwise race teardown.
vi.mock('../product-read-cache.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../product-read-cache.service.js')>()),
  productReadCacheService: { refresh: vi.fn(async () => undefined) },
}))
vi.mock('../customer-cache.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../customer-cache.service.js')>()),
  linkAndRefreshCustomerForOrder: vi.fn(async () => undefined),
}))

const WS = 'nexus_legacy_workspace'
const FLAG = 'NEXUS_ENABLE_SHOPIFY_ORDER_INGEST'
const T0 = '2026-10-15T10:00:00.000Z'
const workspacesBefore = process.env.NEXUS_WORKSPACES_ENABLED
const inBusiness = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: WS, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const q = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]

describe.skipIf(!concurrentDatabaseUrl())(`Shopify order import from its start date (needs ${CONCURRENT_PG_ENV})`, () => {
  let shopify: typeof import('../../routes/shopify-webhooks.js')
  let ingest: typeof import('./order-ingest-switch.js')
  let ledger: typeof import('../cx/ingress/ledger.js')
  let mainId = ''

  const seedProduct = async (onHand = 10) => {
    const productId = randomUUID(), sku = `T0-${productId.slice(0, 8)}`
    await q(`INSERT INTO "Product" (id,"workspaceId",sku,name,"basePrice","totalStock","updatedAt") VALUES ($1,$2,$3,$3,10,$4,now())`, [productId, WS, sku, onHand])
    await q(`INSERT INTO "StockLevel" (id,"workspaceId","locationId","productId",quantity,reserved,available,"lastUpdatedAt") VALUES ($1,$2,$3,$4,$5,0,$5,now())`,
      [randomUUID(), WS, mainId, productId, onHand])
    return { productId, sku }
  }
  /** A Shopify account of this business; with `start`, its start date as the start action leaves it. */
  const shop = async (start?: string) => {
    const id = randomUUID()
    await q(`INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","externalAccountId","isActive","managedBy","authStatus","updatedAt") VALUES ($1,$2,'SHOPIFY',$3,true,'oauth','connected',now())`,
      [id, WS, `t0-${id.slice(0, 8)}.myshopify.com`])
    if (start) await q(`INSERT INTO "ShopifyOrderIngest" (id,"workspaceId","connectionId","activatedAt","activatedBy") VALUES ($1,$2,$3,$4,'person-test')`, [randomUUID(), WS, id, start])
    return id
  }
  const shopifyOrder = (sku: string, createdAt: string, extra: Record<string, unknown> = {}) => {
    const id = String(Date.now()) + String(Math.floor(Math.random() * 100000))
    return { id, created_at: createdAt, updated_at: createdAt, financial_status: 'paid', fulfillment_status: null,
      total_price: '20', currency: 'EUR', email: 'buyer@example.test', line_items: [{ id: Number(id.slice(-6)), sku, quantity: 2, price: '10' }], ...extra }
  }
  const level = async (productId: string) =>
    (await q(`SELECT quantity,reserved,available FROM "StockLevel" WHERE "productId"=$1 AND "locationId"=$2`, [productId, mainId]))[0]
  const nexusOrder = async (shopifyId: string) =>
    (await q<{ id: string; status: string }>(`SELECT id,status::text AS status FROM "Order" WHERE channel='SHOPIFY' AND "channelOrderId"=$1`, [shopifyId]))[0]
  const holds = (orderId: string) => q<{ quantity: number; state: string }>(
    `SELECT quantity,CASE WHEN "consumedAt" IS NOT NULL THEN 'consumed' WHEN "releasedAt" IS NOT NULL THEN 'released' ELSE 'open' END AS state
     FROM "StockReservation" WHERE "orderId"=$1 ORDER BY "createdAt",id`, [orderId])
  const taken = async (orderId: string) => Number((await q(
    `SELECT COALESCE(-SUM(change),0)::text AS s FROM "StockMovement" WHERE "orderId"=$1 AND reason='RESERVATION_CONSUMED'`, [orderId]))[0].s)
  /** Everything an order could have left behind for this product: holds, movements, a return line. */
  const traces = async (productId: string, refundId?: string) => ({
    holds: Number((await q(`SELECT count(*)::text AS n FROM "StockReservation" r JOIN "StockLevel" l ON l.id=r."stockLevelId" WHERE l."productId"=$1`, [productId]))[0].n),
    movements: Number((await q(`SELECT count(*)::text AS n FROM "StockMovement" WHERE "productId"=$1`, [productId]))[0].n),
    returns: refundId ? Number((await q(`SELECT count(*)::text AS n FROM "Return" WHERE channel='SHOPIFY' AND "channelReturnId"=$1`, [refundId]))[0].n) : 0,
  })

  beforeAll(async () => {
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    database = await concurrentDatabase({ maxConnections: 16 })
    // Deployed databases carry these; schema.prisma cannot express them.
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_available_invariant" CHECK ("available" = "quantity" - "reserved")`)
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_quantity_nonneg" CHECK ("quantity" >= 0)`)
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_reserved_nonneg" CHECK ("reserved" >= 0)`)
    await q(`ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_quantity_positive" CHECK ("quantity" > 0)`)
    await q(`CREATE UNIQUE INDEX "StockLevel_loc_prod_novar_unique" ON "StockLevel" ("workspaceId","locationId","productId") WHERE "variationId" IS NULL`)
    mainId = randomUUID()
    await q(`INSERT INTO "StockLocation" (id,"workspaceId",type,code,name,"updatedAt") VALUES ($1,$2,'WAREHOUSE','IT-MAIN','Main',now())`, [mainId, WS])
    shopify = await import('../../routes/shopify-webhooks.js')
    ingest = await import('./order-ingest-switch.js')
    ledger = await import('../cx/ingress/ledger.js')
  }, 180_000)

  afterAll(async () => {
    if (workspacesBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = workspacesBefore
    vi.unstubAllEnvs()
    await database?.close()
  }, 60_000)

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv(FLAG, '1')
  })

  it('1. an account with no start date imports nothing, whatever the order', async () => {
    const p = await seedProduct(), store = await shop()
    const order = shopifyOrder(p.sku, '2026-10-15T12:00:00Z')
    expect(await inBusiness(() => shopify.ingestShopifyOrderCreate(order as never, { connectionId: store }))).toEqual({ ignored: 'not_started' })
    expect(await inBusiness(() => shopify.ingestShopifyOrderUpdate({ ...order, fulfillment_status: 'fulfilled' } as never, { connectionId: store }))).toEqual({ ignored: 'not_started' })
    // A replay that names no account is never imported either.
    expect(await inBusiness(() => shopify.ingestShopifyOrderCreate(order as never))).toEqual({ ignored: 'not_started' })
    expect(await nexusOrder(order.id)).toBeUndefined()
    expect(await level(p.productId)).toEqual({ quantity: 10, reserved: 0, available: 10 })
    expect(await traces(p.productId)).toEqual({ holds: 0, movements: 0, returns: 0 })
  })

  it('2. an order created before the start date: create, updates, fulfilment and refund leave nothing in Nexus', async () => {
    const p = await seedProduct(), store = await shop(T0)
    const order = shopifyOrder(p.sku, '2026-10-15T09:59:59Z')
    const refundId = `R-${order.id}`
    const ctx = { connectionId: store }
    expect(await inBusiness(() => shopify.ingestShopifyOrderCreate(order as never, ctx))).toEqual({ ignored: 'before_start_date' })
    // An old order merely edited after the start: before, orders/updated for an unknown order fell through to a create.
    expect(await inBusiness(() => shopify.ingestShopifyOrderUpdate({ ...order, updated_at: '2026-10-16T08:00:00Z', note: 'edited' } as never, ctx))).toEqual({ ignored: 'before_start_date' })
    expect(await inBusiness(() => shopify.ingestShopifyOrderUpdate({ ...order, updated_at: '2026-10-16T09:00:00Z', fulfillment_status: 'fulfilled',
      fulfillments: [{ id: 77, status: 'success', line_items: [{ id: order.line_items[0].id, sku: p.sku, quantity: 2 }] }] } as never, ctx))).toEqual({ ignored: 'before_start_date' })
    expect(await inBusiness(() => shopify.ingestShopifyOrderUpdate({ ...order, updated_at: '2026-10-16T10:00:00Z', financial_status: 'voided', cancelled_at: '2026-10-16T10:00:00Z' } as never, ctx))).toEqual({ ignored: 'before_start_date' })
    expect(await inBusiness(() => shopify.ingestShopifyFulfillmentCreate({ id: 78, order_id: order.id, created_at: '2026-10-16T11:00:00Z',
      line_items: [{ id: order.line_items[0].id, sku: p.sku, quantity: 2 }] } as never, ctx))).toEqual({ ignored: 'order_not_in_nexus' })
    expect(await inBusiness(() => shopify.ingestShopifyRefundCreate({ id: refundId, order_id: order.id, created_at: '2026-10-16T12:00:00Z',
      refund_line_items: [{ quantity: 1, line_item: { sku: p.sku }, subtotal: '10' }] } as never, ctx))).toEqual({ ignored: 'order_not_in_nexus' })

    expect(await nexusOrder(order.id)).toBeUndefined()
    expect(await level(p.productId)).toEqual({ quantity: 10, reserved: 0, available: 10 })
    expect(await traces(p.productId, refundId)).toEqual({ holds: 0, movements: 0, returns: 0 })
  })

  it('3. an order created at or after the start date is held and taken exactly as the writer does it without the gate', async () => {
    const gated = await seedProduct(), twin = await seedProduct(), store = await shop(T0)
    const ctx = { connectionId: store }
    // Created in the start second itself: included (both clocks are whole seconds).
    const order = shopifyOrder(gated.sku, '2026-10-15T10:00:00Z')
    const plain = shopifyOrder(twin.sku, '2026-10-15T10:00:00Z')

    expect(await inBusiness(() => shopify.ingestShopifyOrderCreate(order as never, ctx))).toBeUndefined()
    await inBusiness(() => shopify.handleOrderCreate(plain as never, ctx))
    // Positive control: the gate let the order through to the writer, which held its two units.
    const imported = await nexusOrder(order.id), reference = await nexusOrder(plain.id)
    expect(imported).toBeDefined()
    expect(await level(gated.productId)).toEqual({ quantity: 10, reserved: 2, available: 8 })
    expect(await level(gated.productId)).toEqual(await level(twin.productId))
    expect(await holds(imported.id)).toEqual(await holds(reference.id))

    const fulfilled = (o: typeof order, sku: string) => ({ ...o, updated_at: '2026-10-15T11:00:00Z', fulfillment_status: 'fulfilled' })
    await inBusiness(() => shopify.ingestShopifyOrderUpdate(fulfilled(order, gated.sku) as never, ctx))
    await inBusiness(() => shopify.handleOrderUpdate(fulfilled(plain, twin.sku) as never, ctx))
    expect(await level(gated.productId)).toEqual({ quantity: 8, reserved: 0, available: 8 })
    expect(await level(gated.productId)).toEqual(await level(twin.productId))
    expect(await taken(imported.id)).toBe(2)
    expect(await holds(imported.id)).toEqual([{ quantity: 2, state: 'consumed' }])
    expect(await holds(imported.id)).toEqual(await holds(reference.id))
    expect((await nexusOrder(order.id)).status).toBe((await nexusOrder(plain.id)).status)

    // Its fulfilment is admitted (its order is in Nexus, created after the start) and takes nothing more.
    expect(await inBusiness(() => shopify.ingestShopifyFulfillmentCreate({ id: 91, order_id: order.id, created_at: '2026-10-15T11:00:00Z',
      line_items: [{ id: order.line_items[0].id, sku: gated.sku, quantity: 2 }] } as never, ctx))).toBeUndefined()
    expect(await level(gated.productId)).toEqual({ quantity: 8, reserved: 0, available: 8 })
    expect(await taken(imported.id)).toBe(2)
  })

  it('4. the start date is written once: five simultaneous starts give one row, one time, the first person', async () => {
    const store = await shop()
    expect(await inBusiness(() => ingest.shopifyOrderIngestStart(store))).toBeNull()
    const starts = await Promise.all(Array.from({ length: 5 }, (_, i) => inBusiness(() => ingest.recordShopifyOrderIngestStart(store, `person-${i}`))))
    expect(starts.filter((s) => s.newlyStarted)).toHaveLength(1)
    const first = starts.find((s) => s.newlyStarted)!
    for (const s of starts) expect({ since: s.since.toISOString(), by: s.by }).toEqual({ since: first.since.toISOString(), by: first.by })
    // The database clock's whole second.
    expect(first.since.getUTCMilliseconds()).toBe(0)
    expect(Math.abs(first.since.getTime() - Date.now())).toBeLessThan(60_000)
    // A later start keeps it.
    const again = await inBusiness(() => ingest.recordShopifyOrderIngestStart(store, 'person-late'))
    expect(again).toEqual({ since: first.since, by: first.by, newlyStarted: false })
    expect((await q(`SELECT count(*)::text AS n FROM "ShopifyOrderIngest" WHERE "connectionId"=$1`, [store]))[0].n).toBe('1')
  })

  it('5. while the server switch is off an order webhook is held and writes nothing', async () => {
    const p = await seedProduct(), store = await shop(T0)
    const order = shopifyOrder(p.sku, '2026-10-15T12:00:00Z')
    for (const value of ['', '0', 'true']) {
      vi.stubEnv(FLAG, value)
      await expect(inBusiness(() => shopify.ingestShopifyOrderCreate(order as never, { connectionId: store }))).rejects.toBeInstanceOf(ledger.InboundDeferred)
      await expect(inBusiness(() => shopify.ingestShopifyRefundCreate({ id: `R-${order.id}`, order_id: order.id } as never, { connectionId: store }))).rejects.toBeInstanceOf(ledger.InboundDeferred)
    }
    expect(await nexusOrder(order.id)).toBeUndefined()
    expect(await level(p.productId)).toEqual({ quantity: 10, reserved: 0, available: 10 })
    expect(await traces(p.productId, `R-${order.id}`)).toEqual({ holds: 0, movements: 0, returns: 0 })
  })
})
