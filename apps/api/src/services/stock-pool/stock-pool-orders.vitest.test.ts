/**
 * Shared stock, step 4 — orders, cancellations and returns through the doors, end to end, on a real
 * multi-connection PostgreSQL with the generated policies, profiles ON. Contract:
 * docs/2026-09-19-shared-stock-build.md §4.
 *
 * Through the REAL order code: the eBay order ingest (EbayOrdersService.processOrder), the hold / take
 * out / give back functions every other channel calls (reserveOpenOrder, consumeOpenOrder,
 * releaseOpenOrder), the cancellation handler, the returns restock route, the manual hold route and
 * the reservation repair job. The lender A lends IT-MAIN (10 jackets; the outlet's 4 are not lent).
 * The borrower B sells its jacket from the pool; B's own shelves (3 jackets, 6 caps) must only move
 * for what is B's own.
 *
 * Needs NEXUS_TEST_CONCURRENT_PG_URL (a throwaway Docker PostgreSQL); SKIPS without it. Run by
 * scripts/run-real-postgres-tests.mjs before every push.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { CONCURRENT_PG_ENV, concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: Record<string, unknown> | null = null
  return {
    default: new Proxy({} as Record<string, unknown>, {
      get: (_t, property) => (wrapped ??= contextualDatabase(database.client as never) as unknown as Record<string, unknown>)[property as string],
    }),
  }
})
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []) }
  return {
    addJobSafely: vi.fn(async () => undefined),
    outboundSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, channelSyncQueue: queue, bulkJobQueue: queue,
    redis: { connection: null },
  }
})
// The product list caches through the ads cache, which writes to Redis; this suite has none. No cache here.
vi.mock('../advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined,
  putCached: () => undefined,
  flushAdsCache: async () => undefined,
}))

const A = 'ws_a_pool_orders'
const B = 'ws_b_pool_orders'
const serverUrl = concurrentDatabaseUrl()
const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED

describe.skipIf(!serverUrl)(`Shared stock step 4 — orders through the doors (needs ${CONCURRENT_PG_ENV})`, () => {
  let grants: typeof import('./pool-grants.service.js')
  let links: typeof import('./pool-links.service.js')
  let tasks: typeof import('./pool-tasks.js')
  let levels: typeof import('../stock-level.service.js')
  let movement: typeof import('../stock-movement.service.js')
  let cancellation: typeof import('../order-cancellation/index.js')
  let reconcile: typeof import('../reservation-reconcile.js')
  let ebay: InstanceType<typeof import('../ebay-orders.service.js').EbayOrdersService>
  let app: FastifyInstance
  const user = { ownerA: randomUUID(), ownerB: randomUUID() }
  const id: Record<string, string> = {}
  let grantId = ''
  let grantVersion = 0
  let membershipB = ''
  let membershipA = ''

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
  const as = <T>(workspaceId: string, actor: string | null, work: () => Promise<T>) =>
    withWorkspace({ workspaceId, actorUserId: actor, membershipId: null, roleKeys: [] }, work)
  const inContext = async (workspaceId: string, actor: string, statements: Array<[string, unknown[]]>) => {
    const client = await database.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('nexus.workspace_id', $1, true), set_config('nexus.actor_id', $2, true)`, [workspaceId, actor])
      for (const [text, params] of statements) await client.query(text, params)
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  const pendingTasks = async () => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM "StockPoolTask"`))[0].n)
  const drain = async () => {
    for (let i = 0; i < 5 && (await pendingTasks()) > 0; i++) await tasks.kickStockPoolWork()
    expect(await pendingTasks(), 'pool tasks left after the worker ran').toBe(0)
  }
  /** One level's numbers: [quantity, reserved, available]. */
  const level = async (productId: string, locationId: string) => {
    const [row] = await q<{ quantity: number; reserved: number; available: number }>(`SELECT quantity, reserved, available FROM "StockLevel" WHERE "productId" = $1 AND "locationId" = $2`, [productId, locationId])
    return row ? [row.quantity, row.reserved, row.available] : null
  }
  const shelves = async () => ({
    aMain: await level(id.jacket, id.aMain),
    aOutlet: await level(id.jacket, id.aOutlet),
    bJacket: await level(id.bJacket, id.bMain),
    bCap: await level(id.bCap, id.bMain),
    bFba: await level(id.bJacket, id.bFba),
  })
  const order = async (channel: string, status = 'PENDING') => {
    const oid = randomUUID()
    await q(`INSERT INTO "Order" (id, "workspaceId", channel, "channelOrderId", status, "totalPrice", "customerName", "customerEmail", "shippingAddress", "updatedAt")
      VALUES ($1,$2,$3::"OrderChannel",$4,$5::"OrderStatus",10,'Buyer','buyer@example.test','{}'::jsonb,now())`, [oid, B, channel, `CH-${oid.slice(0, 8)}`, status])
    return oid
  }
  const ebayOrder = (orderId: string, lines: Array<{ sku: string; quantity: number }>, extra: Record<string, unknown> = {}) => ({
    orderId,
    creationDate: new Date().toISOString(),
    orderPaymentStatus: 'PAID',
    orderFulfillmentStatus: 'NOT_STARTED',
    buyer: { username: 'buyer1' },
    pricingSummary: { total: { value: '20.00', currency: 'EUR' } },
    lineItems: lines.map((l, i) => ({ lineItemId: `${orderId}-L${i + 1}`, sku: l.sku, title: l.sku, quantity: l.quantity, lineItemCost: { value: '10.00', currency: 'EUR' } })),
    ...extra,
  })
  const ingestEbay = async (payload: ReturnType<typeof ebayOrder>) => as(B, null, async () => (ebay as unknown as { processOrder: (o: unknown, c: string) => Promise<{ id: string }> }).processOrder(payload, id.ebayConnection))
  const poolMovements = (orderRef: string) => q<{ reason: string; change: number; locationId: string }>(`SELECT reason::text AS reason, change, "locationId" FROM "StockMovement" WHERE "consumerWorkspaceId" = $1 AND "consumerOrderRef" = $2 ORDER BY "createdAt", id`, [B, orderRef])
  const ownMovements = (orderId: string) => q<{ reason: string; change: number; productId: string }>(`SELECT reason::text AS reason, change, "productId" FROM "StockMovement" WHERE "workspaceId" = $1 AND "orderId" = $2 ORDER BY "createdAt", id`, [B, orderId])
  const notices = (type: string) => q<{ userId: string; title: string; entityId: string }>(`SELECT "userId", title, "entityId" FROM "Notification" WHERE "workspaceId" = $1 AND type = $2 ORDER BY "createdAt"`, [B, type])

  beforeAll(async () => {
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    database = await concurrentDatabase({ maxConnections: 24 })
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_available_invariant" CHECK ("available" = "quantity" - "reserved")`)
    await q(`CREATE UNIQUE INDEX "StockLevel_loc_prod_novar_unique" ON "StockLevel" ("workspaceId", "locationId", "productId") WHERE "variationId" IS NULL`)

    const ownerRole = randomUUID()
    await q(`INSERT INTO "Role" (id, key, name, "isSystem", "updatedAt") VALUES ($1,'OWNER','Owner',true,now())`, [ownerRole])
    for (const [key, uid] of Object.entries(user)) await q(`INSERT INTO "UserProfile" (id, email, status, "updatedAt") VALUES ($1,$2,'active',now())`, [uid, `${key}@example.test`])
    await q(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1,'Lender A','active','e2e',$1,now()), ($2,'Borrower B','active','e2e',$2,now())`, [A, B])
    const member = async (workspaceId: string, userId: string) => {
      const mid = randomUUID()
      await q(`INSERT INTO "WorkspaceMembership" (id, "workspaceId", "userId", status, "updatedAt") VALUES ($1,$2,$3,'active',now())`, [mid, workspaceId, userId])
      await q(`INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)`, [mid, ownerRole])
      return mid
    }
    membershipA = await member(A, user.ownerA)
    await member(B, user.ownerA)
    membershipB = await member(B, user.ownerB)

    const location = async (workspaceId: string, code: string, type = 'WAREHOUSE', warehouseId: string | null = null) => {
      const lid = randomUUID()
      await q(`INSERT INTO "StockLocation" (id, "workspaceId", type, code, name, "warehouseId", "updatedAt") VALUES ($1,$2,$3,$4,$4,$5,now())`, [lid, workspaceId, type, code, warehouseId])
      return lid
    }
    id.bWarehouse = randomUUID()
    await q(`INSERT INTO "Warehouse" (id, "workspaceId", code, name, country, "isDefault", "updatedAt") VALUES ($1,$2,'B-MAIN','B main','DE',true,now())`, [id.bWarehouse, B])
    id.aWarehouse = randomUUID()
    await q(`INSERT INTO "Warehouse" (id, "workspaceId", code, name, "addressLine1", city, "postalCode", country, "isDefault", "updatedAt") VALUES ($1,$2,'IT-MAIN','Main warehouse','Via Roma 1','Milano','20100','IT',true,now())`, [id.aWarehouse, A])
    id.aMain = await location(A, 'IT-MAIN', 'WAREHOUSE', id.aWarehouse)
    id.aOutlet = await location(A, 'IT-OUTLET')
    id.bMain = await location(B, 'B-MAIN', 'WAREHOUSE', id.bWarehouse)
    id.bFba = await location(B, 'B-FBA', 'AMAZON_FBA')

    id.jacket = randomUUID(); id.bJacket = randomUUID(); id.bCap = randomUUID()
    await q(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "totalStock", "updatedAt") VALUES ($1,$2,'JACKET','Jacket',10,14,now())`, [id.jacket, A])
    await q(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "totalStock", "updatedAt") VALUES ($1,$2,'JACKET','Jacket',10,3,now()), ($3,$2,'CAP','Cap',5,6,now())`, [id.bJacket, B, id.bCap])
    const stock = async (workspaceId: string, locationId: string, productId: string, quantity: number) =>
      q(`INSERT INTO "StockLevel" (id, "workspaceId", "locationId", "productId", quantity, reserved, available, "lastUpdatedAt") VALUES ($1,$2,$3,$4,$5,0,$5,now())`, [randomUUID(), workspaceId, locationId, productId, quantity])
    await stock(A, id.aMain, id.jacket, 10)
    await stock(A, id.aOutlet, id.jacket, 4)
    await stock(B, id.bMain, id.bJacket, 3)
    await stock(B, id.bMain, id.bCap, 6)
    await stock(B, id.bFba, id.bJacket, 5)
    id.ebayConnection = randomUUID()
    await q(`INSERT INTO "ChannelConnection" (id, "workspaceId", "channelType", "updatedAt") VALUES ($1,$2,'EBAY',now())`, [id.ebayConnection, B])

    // The product share A → B and its catalog link, through the real AE.2 / AE.3 rules.
    const assortmentId = randomUUID(), shareId = randomUUID()
    await inContext(A, user.ownerA, [
      [`INSERT INTO "Assortment" (id, "workspaceId", name, selection, "updatedAt") VALUES ($1,$2,'For B','list',now())`, [assortmentId, A]],
      [`INSERT INTO "AssortmentMember" (id, "workspaceId", "assortmentId", "productId", mode) VALUES ($1,$2,$3,$4,'include')`, [randomUUID(), A, assortmentId, id.jacket]],
      [`INSERT INTO "AssortmentShare" (id, "assortmentId", "ownerWorkspaceId", "workspaceId", "fieldGroups", "createdByUserId", "updatedAt") VALUES ($1,$2,$3,$4,ARRAY['identity'],$5,now())`, [shareId, assortmentId, A, B, user.ownerA]],
    ])
    await inContext(B, user.ownerB, [
      [`SELECT nexus_assortment_share_respond($1,'accept',1)`, [shareId]],
      [`INSERT INTO "CatalogLink" (id, "shareId", "sourceWorkspaceId", "sourceProductId", "targetWorkspaceId", "targetProductId", "linkedBy", "sourceVersion", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,'created',1,now())`, [randomUUID(), shareId, A, id.jacket, B, id.bJacket]],
    ])

    grants = await import('./pool-grants.service.js')
    links = await import('./pool-links.service.js')
    tasks = await import('./pool-tasks.js')
    levels = await import('../stock-level.service.js')
    movement = await import('../stock-movement.service.js')
    cancellation = await import('../order-cancellation/index.js')
    reconcile = await import('../reservation-reconcile.js')
    const { EbayOrdersService } = await import('../ebay-orders.service.js')
    ebay = new EbayOrdersService()

    // Offer, accept, and the own-stock order made BEFORE the switch (an Amazon hold on B's own shelf).
    const offered = await as(A, user.ownerA, () => grants.offerGrant({ borrowerWorkspaceId: B, locationIds: [id.aMain] }))
    grantId = offered.id
    grantVersion = (await as(B, user.ownerB, () => grants.borrowerDecision(grantId, 'accept', { expectedVersion: 1 }))).version
    id.preSwitchOrder = await order('AMAZON')
    await as(B, null, () => levels.reserveOpenOrder({ orderId: id.preSwitchOrder, productId: id.bJacket, locationId: id.bMain, quantity: 1, actor: 'amazon-orders' }))
    expect(await as(B, user.ownerB, () => links.switchProducts({ productIds: [id.bJacket], to: 'pool', grantId }))).toEqual({ switched: 1, unchanged: 0 })
    await drain()

    app = Fastify()
    app.addHook('preHandler', (request, _reply, done) => {
      // Business B by default; `x-test-business: A` acts as the lender's owner (arm 12d).
      if (request.headers['x-test-business'] === 'A') {
        ;(request as unknown as { authUser: { id: string; email: string } }).authUser = { id: user.ownerA, email: 'ownerA@example.test' }
        withWorkspace({ workspaceId: A, actorUserId: user.ownerA, membershipId: membershipA, roleKeys: ['OWNER'] }, done)
        return
      }
      ;(request as unknown as { authUser: { id: string; email: string } }).authUser = { id: user.ownerB, email: 'ownerB@example.test' }
      withWorkspace({ workspaceId: B, actorUserId: user.ownerB, membershipId: membershipB, roleKeys: ['OWNER'] }, done)
    })
    const [{ default: returnsRoutes }, { default: stockRoutes }, { default: fulfillmentRoutes }] = await Promise.all([
      import('../../routes/returns.routes.js'), import('../../routes/stock.routes.js'), import('../../routes/fulfillment.routes.js'),
    ])
    await app.register(returnsRoutes, { prefix: '/api' })
    await app.register(stockRoutes, { prefix: '/api' })
    await app.register(fulfillmentRoutes, { prefix: '/api' })
    await app.ready()
  }, 180_000)

  afterAll(async () => {
    await app?.close()
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  }, 60_000)

  it('0. the start: A lends IT-MAIN (10); B has 3 jackets (1 held for an order made before the switch) and 6 caps of its own', async () => {
    expect(await shelves()).toEqual({ aMain: [10, 0, 10], aOutlet: [4, 0, 4], bJacket: [3, 1, 2], bCap: [6, 0, 6], bFba: [5, 0, 5] })
  })

  it('1. an eBay sale of the jacket is taken from the pool; a cap is taken from B\'s own shelf; a re-poll takes nothing again', async () => {
    const dbOrder = await ingestEbay(ebayOrder('EB-1', [{ sku: 'JACKET', quantity: 2 }, { sku: 'CAP', quantity: 1 }]))
    id.eb1 = dbOrder.id
    expect(await shelves()).toEqual({ aMain: [8, 0, 8], aOutlet: [4, 0, 4], bJacket: [3, 1, 2], bCap: [5, 0, 5], bFba: [5, 0, 5] })
    expect(await poolMovements(id.eb1)).toEqual([{ reason: 'ORDER_PLACED', change: -2, locationId: id.aMain }])
    expect((await ownMovements(id.eb1)).map((m) => [m.reason, m.change, m.productId])).toEqual([['ORDER_PLACED', -1, id.bCap]])
    await ingestEbay(ebayOrder('EB-1', [{ sku: 'JACKET', quantity: 2 }, { sku: 'CAP', quantity: 1 }]))
    expect(await shelves()).toMatchObject({ aMain: [8, 0, 8], bCap: [5, 0, 5] })
    // The lender's bookkeeping follows in the lender's own context.
    await drain()
    expect(await q(`SELECT "poolSettledAt" IS NOT NULL AS settled FROM "StockMovement" WHERE "consumerOrderRef" = $1`, [id.eb1])).toEqual([{ settled: true }])
  })

  it('1b. two lines of ONE product in one order (one variant in two eBay listings): taken, returned and cancelled as one', async () => {
    const five = await ingestEbay(ebayOrder('EB-5', [{ sku: 'JACKET', quantity: 1 }, { sku: 'JACKET', quantity: 2 }]))
    expect(await shelves()).toMatchObject({ aMain: [5, 0, 5], bJacket: [3, 1, 2] }) // 8 − 3, all of both lines
    expect((await poolMovements(five.id)).map((m) => [m.reason, m.change])).toEqual([['ORDER_PLACED', -3]])
    const rid = randomUUID()
    await q(`INSERT INTO "Return" (id, "workspaceId", "orderId", channel, "updatedAt") VALUES ($1,$2,$3,'EBAY',now())`, [rid, B, five.id])
    for (const quantity of [1, 2]) await q(`INSERT INTO "ReturnItem" (id, "workspaceId", "returnId", "productId", sku, quantity) VALUES ($1,$2,$3,$4,'JACKET',$5)`, [randomUUID(), B, rid, id.bJacket, quantity])
    expect((await app.inject({ method: 'POST', url: `/api/fulfillment/returns/${rid}/restock`, payload: {} })).statusCode).toBe(200)
    expect(await shelves()).toMatchObject({ aMain: [8, 0, 8], bJacket: [3, 1, 2] }) // both items back
    const six = await ingestEbay(ebayOrder('EB-6', [{ sku: 'JACKET', quantity: 1 }, { sku: 'JACKET', quantity: 1 }]))
    expect(await shelves()).toMatchObject({ aMain: [6, 0, 6] })
    expect(await as(B, null, () => cancellation.handleOrderCancelled(six.id))).toMatchObject({ reservationsReleased: 0, itemsRestocked: 1 })
    expect(await shelves()).toMatchObject({ aMain: [8, 0, 8], bJacket: [3, 1, 2] }) // both lines back
  })

  it('2. an eBay sale larger than the pool is refused: nothing is taken anywhere, and B\'s owners are told', async () => {
    const dbOrder = await ingestEbay(ebayOrder('EB-2', [{ sku: 'JACKET', quantity: 9 }]))
    id.eb2 = dbOrder.id
    expect(await shelves()).toMatchObject({ aMain: [8, 0, 8], bJacket: [3, 1, 2] })
    expect(await poolMovements(id.eb2)).toEqual([])
    expect(await ownMovements(id.eb2)).toEqual([])
    const told = await notices('stock-pool-order-refused')
    expect(told.map((n) => [n.entityId, n.title]).sort()).toEqual([
      [id.eb2, 'Shared stock refused the sale of 9 × JACKET'],
      [id.eb2, 'Shared stock refused the sale of 9 × JACKET'],
    ])
    expect(new Set(told.map((n) => n.userId))).toEqual(new Set([user.ownerA, user.ownerB]))
  })

  it('3. an Amazon hold is held in the pool; a re-poll holds nothing more; shipping takes it out; a re-poll after shipping never holds again', async () => {
    id.amz1 = await order('AMAZON')
    const hold = () => as(B, null, () => levels.reserveOpenOrder({ orderId: id.amz1, productId: id.bJacket, locationId: id.bMain, quantity: 3, actor: 'amazon-orders' }))
    await hold()
    await hold()
    expect(await shelves()).toMatchObject({ aMain: [8, 3, 5], bJacket: [3, 1, 2] })
    expect(await as(B, null, () => levels.consumeOpenOrder({ orderId: id.amz1, actor: 'amazon-orders' }))).toBe(1)
    expect(await shelves()).toMatchObject({ aMain: [5, 0, 5], bJacket: [3, 1, 2] })
    await hold() // the Amazon re-poll that used to hold a shipped order again (found while mapping, 1)
    expect(await shelves()).toMatchObject({ aMain: [5, 0, 5] })
    expect((await poolMovements(id.amz1)).map((m) => [m.reason, m.change])).toEqual([['RESERVATION_CREATED', 0], ['RESERVATION_CONSUMED', -3]])
  })

  it('4. an Amazon order cancelled before shipping gives its pool hold back (and restores nothing else)', async () => {
    id.amz2 = await order('AMAZON')
    await as(B, null, () => levels.reserveOpenOrder({ orderId: id.amz2, productId: id.bJacket, locationId: id.bMain, quantity: 2, actor: 'amazon-orders' }))
    expect(await shelves()).toMatchObject({ aMain: [5, 2, 3] })
    const cleanup = await as(B, null, () => cancellation.handleOrderCancelled(id.amz2))
    expect(cleanup).toMatchObject({ reservationsReleased: 1, itemsRestocked: 0 })
    expect(await shelves()).toMatchObject({ aMain: [5, 0, 5], bJacket: [3, 1, 2] })
  })

  it('5. an eBay sale cancelled after it was taken puts the units back into the pool, once', async () => {
    const items = await q<{ productId: string; quantity: number }>(`SELECT "productId", quantity FROM "OrderItem" WHERE "orderId" = $1 ORDER BY sku`, [id.eb1])
    expect(items.filter((i) => i.productId === id.bJacket).length).toBeGreaterThan(0)
    const first = await as(B, null, () => cancellation.handleOrderCancelled(id.eb1))
    expect(first).toMatchObject({ reservationsReleased: 0, itemsRestocked: 2 }) // the jacket to the pool, the cap to B's shelf
    expect(await shelves()).toMatchObject({ aMain: [7, 0, 7] }) // 5 + the 2 the order took
    expect((await poolMovements(id.eb1)).map((m) => [m.reason, m.change, m.locationId])).toEqual([['ORDER_PLACED', -2, id.aMain], ['ORDER_CANCELLED', 2, id.aMain]])
    // The cap was B's own: it comes back to B's own shelf, as before this work.
    expect(await shelves()).toMatchObject({ bCap: [6, 0, 6], bJacket: [3, 1, 2] })
    await as(B, null, () => cancellation.handleOrderCancelled(id.eb1))
    expect(await shelves()).toMatchObject({ aMain: [7, 0, 7], bCap: [6, 0, 6], bJacket: [3, 1, 2] })
  })

  it('6. a cancelled order whose pool sale was refused restores nothing (it took nothing)', async () => {
    const r = await as(B, null, () => cancellation.handleOrderCancelled(id.eb2))
    expect(r).toMatchObject({ reservationsReleased: 0, itemsRestocked: 0 })
    expect(await shelves()).toMatchObject({ aMain: [7, 0, 7], bJacket: [3, 1, 2] })
    expect(await ownMovements(id.eb2)).toEqual([])
  })

  it('7. a return of a pool sale goes back to the pool, once per return, never more than the order took', async () => {
    const dbOrder = await ingestEbay(ebayOrder('EB-3', [{ sku: 'JACKET', quantity: 2 }]))
    id.eb3 = dbOrder.id
    expect(await shelves()).toMatchObject({ aMain: [5, 0, 5] })
    const returnRow = async (quantity: number) => {
      const rid = randomUUID()
      await q(`INSERT INTO "Return" (id, "workspaceId", "orderId", channel, "updatedAt") VALUES ($1,$2,$3,'EBAY',now())`, [rid, B, id.eb3])
      await q(`INSERT INTO "ReturnItem" (id, "workspaceId", "returnId", "productId", sku, quantity) VALUES ($1,$2,$3,$4,'JACKET',$5)`, [randomUUID(), B, rid, id.bJacket, quantity])
      return rid
    }
    const restock = (rid: string) => app.inject({ method: 'POST', url: `/api/fulfillment/returns/${rid}/restock`, payload: {} })
    const r1 = await returnRow(1)
    expect((await restock(r1)).statusCode).toBe(200)
    expect(await shelves()).toMatchObject({ aMain: [6, 0, 6], bJacket: [3, 1, 2] })
    expect((await restock(r1)).statusCode).toBe(200) // the same return twice: once
    expect(await shelves()).toMatchObject({ aMain: [6, 0, 6] })
    const r2 = await returnRow(2) // the order took 2; 1 is back already
    expect((await restock(r2)).statusCode).toBe(200)
    expect(await shelves()).toMatchObject({ aMain: [6, 0, 6], bJacket: [3, 1, 2] }) // neither the pool nor B's own shelf
    expect((await poolMovements(id.eb3)).map((m) => [m.reason, m.change])).toEqual([['ORDER_PLACED', -2], ['RETURN_RESTOCKED', 1]])
    expect(await q(`SELECT 1 FROM "StockMovement" WHERE "workspaceId" = $1 AND reason = 'RETURN_RESTOCKED'`, [B])).toEqual([])
  })

  it('8. no path can sell or hold a pooled product from B\'s own shelf: the guard, the manual hold route', async () => {
    await expect(as(B, null, () => movement.applyStockMovement({ productId: id.bJacket, locationId: id.bMain, change: -1, reason: 'ORDER_PLACED', orderId: 'X-1' })))
      .rejects.toMatchObject({ code: 'pooled_product' })
    await expect(as(B, null, () => levels.reserveStock({ productId: id.bJacket, locationId: id.bMain, quantity: 1, orderId: 'X-2', reason: 'OPEN_ORDER' as never })))
      .rejects.toMatchObject({ code: 'pooled_product' })
    const manual = await app.inject({ method: 'POST', url: '/api/stock/reserve', payload: { productId: id.bJacket, locationId: id.bMain, quantity: 1, reason: 'MANUAL_HOLD' } })
    expect(manual.statusCode).toBe(409)
    expect(manual.json()).toMatchObject({ code: 'pooled_product' })
    // Not order-driven, or not pooled: unchanged.
    await as(B, null, () => movement.applyStockMovement({ productId: id.bCap, locationId: id.bMain, change: -1, reason: 'ORDER_PLACED', orderId: 'X-3' }))
    await as(B, null, () => movement.applyStockMovement({ productId: id.bJacket, locationId: id.bMain, change: 1, reason: 'INBOUND_RECEIVED' }))
    expect(await shelves()).toMatchObject({ aMain: [6, 0, 6], bJacket: [4, 1, 3], bCap: [5, 0, 5] })
    // An Amazon FBA (MCF) hold is B's own, never pooled.
    id.mcf = await order('EBAY')
    await as(B, null, () => levels.reserveOpenOrder({ orderId: id.mcf, productId: id.bJacket, locationId: id.bFba, quantity: 1, actor: 'amazon-mcf:create' }))
    expect(await shelves()).toMatchObject({ aMain: [6, 0, 6], bFba: [5, 1, 4] })
  })

  it('9. the order made before the switch still ships from B\'s own shelf', async () => {
    expect(await as(B, null, () => levels.consumeOpenOrder({ orderId: id.preSwitchOrder, actor: 'amazon-orders' }))).toBe(1)
    expect(await shelves()).toMatchObject({ aMain: [6, 0, 6], bJacket: [3, 0, 3] })
  })

  it('10. the repair job settles pool holds whose order moved on: shipped → taken out, cancelled → given back', async () => {
    id.amzShipped = await order('AMAZON')
    id.amzCancelled = await order('AMAZON')
    id.amzOpen = await order('AMAZON')
    for (const oid of [id.amzShipped, id.amzCancelled, id.amzOpen]) {
      await as(B, null, () => levels.reserveOpenOrder({ orderId: oid, productId: id.bJacket, locationId: id.bMain, quantity: 1, actor: 'amazon-orders' }))
    }
    expect(await shelves()).toMatchObject({ aMain: [6, 3, 3] })
    await q(`UPDATE "Order" SET status = 'SHIPPED' WHERE id = $1`, [id.amzShipped])
    await q(`UPDATE "Order" SET status = 'CANCELLED' WHERE id = $1`, [id.amzCancelled])
    const r = await as(B, null, () => reconcile.reconcileOpenOrderReservations({ actor: 'reservation-reconcile' }))
    expect(r).toMatchObject({ consumed: 1, released: 1 })
    expect(await shelves()).toMatchObject({ aMain: [5, 1, 4] })
    expect((await poolMovements(id.amzOpen)).map((m) => m.reason)).toEqual(['RESERVATION_CREATED'])
  })

  it('11. while the lender pauses, new sales use B\'s own stock; orders already held still ship from the pool', async () => {
    grantVersion = (await as(A, user.ownerA, () => grants.lenderAction(grantId, 'pause', { expectedVersion: grantVersion }))).version
    await drain()
    const dbOrder = await ingestEbay(ebayOrder('EB-4', [{ sku: 'JACKET', quantity: 1 }]))
    expect((await ownMovements(dbOrder.id)).map((m) => [m.reason, m.change])).toEqual([['ORDER_PLACED', -1]])
    expect(await shelves()).toMatchObject({ aMain: [5, 1, 4], bJacket: [2, 0, 2] })
    expect(await as(B, null, () => levels.consumeOpenOrder({ orderId: id.amzOpen, actor: 'amazon-orders' }))).toBe(1)
    expect(await shelves()).toMatchObject({ aMain: [4, 0, 4], bJacket: [2, 0, 2] })
    grantVersion = (await as(A, user.ownerA, () => grants.lenderAction(grantId, 'resume', { expectedVersion: grantVersion }))).version
    await drain()
  })

  it('12. the ledgers add up: every lender level is its start plus its movements; reserved = open holds', async () => {
    const check = await q<{ productId: string; locationId: string; quantity: number; moved: number; reserved: number; open: number }>(`
      SELECT lv."productId", lv."locationId", lv.quantity,
        COALESCE((SELECT SUM(m.change) FROM "StockMovement" m WHERE m."productId" = lv."productId" AND m."locationId" = lv."locationId"), 0)::int AS moved,
        lv.reserved,
        COALESCE((SELECT SUM(r.quantity) FROM "StockReservation" r WHERE r."stockLevelId" = lv.id AND r."releasedAt" IS NULL AND r."consumedAt" IS NULL), 0)::int AS open
      FROM "StockLevel" lv`)
    const start: Record<string, number> = { [`${id.jacket}|${id.aMain}`]: 10, [`${id.jacket}|${id.aOutlet}`]: 4, [`${id.bJacket}|${id.bMain}`]: 3, [`${id.bCap}|${id.bMain}`]: 6, [`${id.bJacket}|${id.bFba}`]: 5 }
    for (const row of check) {
      expect(row.quantity, `level ${row.productId}@${row.locationId}`).toBe(start[`${row.productId}|${row.locationId}`] + row.moved)
      expect(row.reserved, `reserved ${row.productId}@${row.locationId}`).toBe(row.open)
    }
  })

  it('12b. the stock page, the stock drawer and the product list show the pool beside B\'s own numbers, never added to them', async () => {
    const page = (await app.inject({ method: 'GET', url: '/api/stock/products?pageSize=50' })).json() as { items: Array<{ id: string; totalAvailable: number; poolSource: unknown }> }
    const jacket = page.items.find((row) => row.id === id.bJacket)
    const cap = page.items.find((row) => row.id === id.bCap)
    expect(jacket).toMatchObject({ totalAvailable: 6, poolSource: { lenderName: 'Lender A', quantity: 4, reserved: 0, available: 4 } }) // own: B-MAIN 2 + FBA 4 · pool 4, apart
    expect(cap?.poolSource).toBeNull()
    // The drawer's per-channel breakdown: B's eBay listing follows the pool (4, less its buffer 1 = 3,
    // what it shows: no drift). Its own B-MAIN (2) would have read as a false drift of -2. Amazon stays own.
    const ebayListing = 'cl-12b-ebay'
    const amazonListing = 'cl-12b-amazon'
    await q(`INSERT INTO "ChannelListing" (id, "workspaceId", "productId", channel, marketplace, region, "channelMarket", "listingStatus", quantity, "followMasterQuantity", "stockBuffer", "updatedAt")
      VALUES ($1,$3,$4,'EBAY','IT','IT','EBAY_IT','ACTIVE',3,true,1,now()), ($2,$3,$4,'AMAZON','IT','IT','AMAZON_IT','ACTIVE',4,true,0,now())`, [ebayListing, amazonListing, B, id.bJacket])
    try {
      const drawer = (await app.inject({ method: 'GET', url: `/api/stock/product/${id.bJacket}` })).json() as { poolSource: unknown; atpPerChannel: Array<Record<string, unknown>> }
      expect(drawer.poolSource).toMatchObject({ lenderName: 'Lender A', available: 4 })
      expect(drawer.atpPerChannel.find((row) => row.channelListingId === ebayListing)).toMatchObject({ source: 'SHARED_POOL', poolLenderName: 'Lender A', onHand: 4, reservedForChannel: 0, stockBuffer: 1, available: 3, channelQuantity: 3, drift: 0 })
      // Amazon keeps the own path unchanged: B-FBA serves no marketplace in this seed, so the S.26 rule
      // falls back to B's own warehouse (B-MAIN 2). Never the pool.
      expect(drawer.atpPerChannel.find((row) => row.channelListingId === amazonListing)).toMatchObject({ fulfillmentMethod: 'FBA', source: 'WAREHOUSE_DEFAULT', onHand: 2 })
      // The cap sells from its own stock: its listings still read the own rows.
      const capDrawer = (await app.inject({ method: 'GET', url: `/api/stock/product/${id.bCap}` })).json() as { poolSource: unknown; atpPerChannel: unknown[] }
      expect(capDrawer.poolSource).toBeNull()
    } finally {
      await q(`DELETE FROM "ChannelListing" WHERE id = ANY($1)`, [[ebayListing, amazonListing]])
    }
    const byProduct = (await app.inject({ method: 'GET', url: '/api/stock/by-product?pageSize=50' })).json() as { products: Array<{ id: string; poolSource: unknown }> }
    expect(byProduct.products.find((row) => row.id === id.bJacket)?.poolSource).toMatchObject({ lenderName: 'Lender A', available: 4 })
    expect(byProduct.products.find((row) => row.id === id.bCap)?.poolSource).toBeNull()
    // The product list's rows (a parent sums its pooled variations).
    const { loadPoolSources, summarizePoolSources } = await import('./pool-sources.js')
    const pools = await as(B, null, () => loadPoolSources(database.client as never, [id.bJacket, id.bCap]))
    expect([...pools.keys()]).toEqual([id.bJacket])
    expect(summarizePoolSources([id.bJacket, id.bCap], pools)).toMatchObject({ lenderName: 'Lender A', available: 4, products: 1 })
    expect(summarizePoolSources([id.bCap], pools)).toBeNull()
    const { listProducts } = await import('../products/list-products.service.js')
    const listed = await as(B, null, () => listProducts({}))
    expect(listed.status).toBe(200)
    const listRows = (listed as { body: { products: Array<{ id: string; poolSource: unknown }> } }).body.products
    expect(listRows.find((row) => row.id === id.bJacket)?.poolSource).toMatchObject({ lenderName: 'Lender A', available: 4, products: 1 })
    expect(listRows.find((row) => row.id === id.bCap)?.poolSource).toBeNull()
    // The lender borrows nothing: one count, and no pool anywhere.
    expect((await as(A, null, () => loadPoolSources(database.client as never, [id.jacket]))).size).toBe(0)
  })

  it('12c. the pool shows what is free (a hold counts), and a parent row adds up its pooled variation, child or grandchild', async () => {
    const poolOf = async () => ((await app.inject({ method: 'GET', url: `/api/stock/product/${id.bJacket}` })).json() as { poolSource: unknown }).poolSource
    // An open pool hold: 4 units in the pool, 1 held, 3 free. The drawer and the lists use what is free.
    const held = await order('EBAY')
    await as(B, null, () => levels.reserveOpenOrder({ orderId: held, productId: id.bJacket, locationId: id.bMain, quantity: 1, actor: 'ebay-orders' }))
    try {
      expect(await poolOf()).toMatchObject({ quantity: 4, reserved: 1, available: 3 })
    } finally {
      await as(B, null, () => levels.releaseOpenOrder({ orderId: held, actor: 'ebay-orders' }))
    }
    expect(await poolOf()).toMatchObject({ quantity: 4, reserved: 0, available: 4 })

    // The jacket under a family: first as its child, then as a grandchild (family → colour → jacket).
    const family = randomUUID()
    const colour = randomUUID()
    await q(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "totalStock", "isParent", "updatedAt")
      VALUES ($1,$3,'JACKET-FAMILY','Jacket family',10,0,true,now()), ($2,$3,'JACKET-BLACK','Jacket, black',10,0,true,now())`, [family, colour, B])
    const familyOnStockPage = async () => ((await app.inject({ method: 'GET', url: '/api/stock/products?pageSize=50' })).json() as { items: Array<{ id: string; poolSource: unknown }> })
      .items.find((row) => row.id === family)?.poolSource
    const { listProducts } = await import('../products/list-products.service.js')
    const familyOnProductList = async () => ((await as(B, null, () => listProducts({}))) as { body: { products: Array<{ id: string; poolSource: unknown }> } })
      .body.products.find((row) => row.id === family)?.poolSource
    try {
      await q(`UPDATE "Product" SET "parentId" = $1 WHERE id = $2`, [family, id.bJacket])
      expect(await familyOnStockPage()).toMatchObject({ lenderName: 'Lender A', available: 4, products: 1 })
      expect(await familyOnProductList()).toMatchObject({ lenderName: 'Lender A', available: 4, products: 1 })
      await q(`UPDATE "Product" SET "parentId" = $1 WHERE id = $2`, [colour, id.bJacket])
      await q(`UPDATE "Product" SET "parentId" = $1 WHERE id = $2`, [family, colour])
      expect(await familyOnStockPage()).toMatchObject({ lenderName: 'Lender A', available: 4, products: 1 })
    } finally {
      await q(`UPDATE "Product" SET "parentId" = NULL WHERE id = ANY($1)`, [[id.bJacket, colour]])
      await q(`DELETE FROM "Product" WHERE id = ANY($1)`, [[family, colour]])
    }
  })

  it('12d. the lender sees who sold what: what each borrowing business holds and sold, and each pool movement names it', async () => {
    type Drawer = { lentUsage: Array<{ businessName: string; heldNow: number; sold30d: number; putBack30d: number }>; movements: Array<{ change: number; usedBy: { businessName: string; orderRef: string | null } | null }> }
    const lenderDrawer = async () => (await app.inject({ method: 'GET', url: `/api/stock/product/${id.jacket}`, headers: { 'x-test-business': 'A' } })).json() as Drawer
    const before = await lenderDrawer()
    expect(before.lentUsage.map((row) => row.businessName)).toEqual(['Borrower B'])
    expect(before.movements.some((movement) => movement.usedBy)).toBe(true)
    expect(before.movements.filter((movement) => movement.usedBy).every((movement) => movement.usedBy!.businessName === 'Borrower B')).toBe(true)
    // One more sale and one more hold in B: A sees exactly one more sold and one more held.
    const sale = await ingestEbay(ebayOrder('EB-12D', [{ sku: 'JACKET', quantity: 1 }]))
    const held = await order('AMAZON')
    await as(B, null, () => levels.reserveOpenOrder({ orderId: held, productId: id.bJacket, locationId: id.bMain, quantity: 1, actor: 'amazon-orders' }))
    try {
      const after = await lenderDrawer()
      const [b0] = before.lentUsage
      expect(after.lentUsage).toEqual([{ ...b0, heldNow: b0.heldNow + 1, sold30d: b0.sold30d + 1 }])
      expect(after.movements.find((movement) => movement.usedBy?.orderRef === sale.id)).toMatchObject({ change: -1, usedBy: { businessName: 'Borrower B', orderRef: sale.id } })
      // The hold for B's order is named in A's list, and A cannot release it: only B's order ends it.
      const reservations = ((await app.inject({ method: 'GET', url: `/api/stock/product/${id.jacket}`, headers: { 'x-test-business': 'A' } })).json() as { reservations: Array<{ id: string; usedBy: { businessName: string; orderRef: string | null } | null }> }).reservations
      const hold = reservations.find((reservation) => reservation.usedBy?.orderRef === held)
      expect(hold?.usedBy).toEqual({ businessName: 'Borrower B', orderRef: held })
      const refused = await app.inject({ method: 'POST', url: `/api/stock/release/${hold!.id}`, headers: { 'x-test-business': 'A' } })
      expect(refused.statusCode).toBe(409)
      expect(refused.json()).toMatchObject({ code: 'pool_hold' })
      expect(await q(`SELECT "releasedAt" IS NULL AS open FROM "StockReservation" WHERE id = $1`, [hold!.id])).toEqual([{ open: true }])
      // B cancels the sale: the unit goes back to A, counted as put back, not as another sale.
      expect(await as(B, null, () => cancellation.handleOrderCancelled(sale.id))).toMatchObject({ itemsRestocked: 1 })
      expect((await lenderDrawer()).lentUsage).toEqual([{ ...b0, heldNow: b0.heldNow + 1, sold30d: b0.sold30d + 1, putBack30d: b0.putBack30d + 1 }])
    } finally {
      await as(B, null, () => levels.releaseOpenOrder({ orderId: held, actor: 'amazon-orders' }))
    }
    // A business that lends nothing sees no "lent stock".
    expect(((await app.inject({ method: 'GET', url: `/api/stock/product/${id.bJacket}` })).json() as Drawer).lentUsage).toEqual([])
  })

  it('12e. the stock page\'s cards, stockout list and days of stock judge a pooled product by the pool, not by its empty own shelf (step 7)', async () => {
    // A scarf B has none of: a stockout while it sells from its own shelf, 4 in A's pool once switched.
    const share = (await q<{ id: string; assortmentId: string }>(`SELECT id, "assortmentId" FROM "AssortmentShare" LIMIT 1`))[0]
    const aScarf = randomUUID(), bScarf = randomUUID()
    await q(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "totalStock", "updatedAt") VALUES ($1,$2,'SCARF','Scarf',10,4,now())`, [aScarf, A])
    await q(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "totalStock", "updatedAt") VALUES ($1,$2,'SCARF','Scarf',10,0,now())`, [bScarf, B])
    await q(`INSERT INTO "StockLevel" (id, "workspaceId", "locationId", "productId", quantity, reserved, available, "lastUpdatedAt") VALUES ($1,$2,$3,$4,4,0,4,now())`, [randomUUID(), A, id.aMain, aScarf])
    await inContext(A, user.ownerA, [[`INSERT INTO "AssortmentMember" (id, "workspaceId", "assortmentId", "productId", mode) VALUES ($1,$2,$3,$4,'include')`, [randomUUID(), A, share.assortmentId, aScarf]]])
    await inContext(B, user.ownerB, [[`INSERT INTO "CatalogLink" (id, "shareId", "sourceWorkspaceId", "sourceProductId", "targetWorkspaceId", "targetProductId", "linkedBy", "sourceVersion", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,'created',1,now())`, [randomUUID(), share.id, A, aScarf, B, bScarf]]])
    type Kpis = { stockouts: number; critical: number; sharedSkus: number }
    type Risk = { stockoutRisk: Array<{ sku: string; totalStock: number; poolLenderName: string | null }> }
    const kpis = async () => (await app.inject({ method: 'GET', url: '/api/stock/kpis' })).json() as Kpis
    const scarfRisk = async () => ((await app.inject({ method: 'GET', url: '/api/stock/insights' })).json() as Risk).stockoutRisk.filter((r) => r.sku === 'SCARF')
    // 30 sold yesterday: 1 a day over the last 30 days, so days of stock = the units that cover it.
    await q(`INSERT INTO "DailySalesAggregate" (id, "workspaceId", sku, channel, marketplace, day, "unitsSold", "updatedAt") VALUES ($1,$2,'SCARF','EBAY','IT',CURRENT_DATE - 1,30,now())`, [randomUUID(), B])
    const daysOfStock = async () => ((await app.inject({ method: 'GET', url: `/api/stock/product/${bScarf}` })).json() as { salesVelocity: { daysOfStock: number | null } }).salesVelocity.daysOfStock
    const own = await kpis()
    expect(await scarfRisk()).toEqual([expect.objectContaining({ totalStock: 0, poolLenderName: null })])
    expect(await daysOfStock()).toBe(0)
    expect(await as(B, user.ownerB, () => links.switchProducts({ productIds: [bScarf], to: 'pool', grantId }))).toEqual({ switched: 1, unchanged: 0 })
    await drain()
    try {
      const pooled = await kpis()
      expect([pooled.stockouts, pooled.critical, pooled.sharedSkus]).toEqual([own.stockouts - 1, own.critical + 1, own.sharedSkus + 1])
      expect(await scarfRisk()).toEqual([expect.objectContaining({ totalStock: 4, poolLenderName: 'Lender A' })])
      expect(await daysOfStock(), 'the drawer\'s days of stock count the pool').toBe(4)
    } finally {
      expect(await as(B, user.ownerB, () => links.switchProducts({ productIds: [bScarf], to: 'own' }))).toEqual({ switched: 1, unchanged: 0 })
      await drain()
    }
    expect((await kpis()).stockouts).toBe(own.stockouts)
  })

  it('12f. reordering knows the pool: the lender counts the borrower\'s pool sales, the borrower is not told to reorder, auto-PO skips it (step 7b)', async () => {
    type Cover = { channel: string; marketplace: string; available: number; source: string }
    type Page = { suggestions: Array<{ sku: string; unitsSold30d: number; channelCover: Cover[] }>; sharedStock: { products: number; lenders: string[] } | null }
    const page = async (business: 'A' | 'B') => {
      const response = await app.inject({ method: 'GET', url: '/api/fulfillment/replenishment', headers: business === 'A' ? { 'x-test-business': 'A' } : {} })
      expect(response.statusCode, response.body.slice(0, 300)).toBe(200)
      return response.json() as Page
    }
    const lenderJacket = async () => (await page('A')).suggestions.find((s) => s.sku === 'JACKET')!
    const sold = async () => (await lenderJacket()).unitsSold30d
    const before = await sold()
    // A new pool sale of 2 in B is demand on A's jacket, shown as its own row on the lent warehouse.
    const sale = await ingestEbay(ebayOrder('EB-7B', [{ sku: 'JACKET', quantity: 2 }]))
    expect(await sold()).toBe(before + 2)
    const pooledRow = (await lenderJacket()).channelCover.find((c) => c.channel === 'SHARED_POOL')
    expect(pooledRow).toMatchObject({ marketplace: 'Borrower B', source: 'SHARED_POOL', available: (await level(id.jacket, id.aMain))![2] })
    // A cancelled order is no sale (the rule of the business's own sales).
    await as(B, null, () => cancellation.handleOrderCancelled(sale.id))
    expect(await sold()).toBe(before)
    // A return does not unsell (the same rule again): the sale still counts once its unit is back in the pool.
    const kept = await ingestEbay(ebayOrder('EB-7C', [{ sku: 'JACKET', quantity: 1 }]))
    const returned = randomUUID()
    await q(`INSERT INTO "Return" (id, "workspaceId", "orderId", channel, "updatedAt") VALUES ($1,$2,$3,'EBAY',now())`, [returned, B, kept.id])
    await q(`INSERT INTO "ReturnItem" (id, "workspaceId", "returnId", "productId", sku, quantity) VALUES ($1,$2,$3,$4,'JACKET',1)`, [randomUUID(), B, returned, id.bJacket])
    expect((await app.inject({ method: 'POST', url: `/api/fulfillment/returns/${returned}/restock`, payload: {} })).statusCode).toBe(200)
    expect(await sold()).toBe(before + 1)

    // The borrower: its pooled jacket is the lender's to restock.
    const borrowerPage = await page('B')
    expect(borrowerPage.suggestions.map((s) => s.sku)).not.toContain('JACKET')
    expect(borrowerPage.sharedStock).toEqual({ products: 1, lenders: ['Lender A'] })

    // The lender's forecast has a series for the borrower's pool demand. A forecast reads history up to yesterday,
    // so the pool sales of this suite are moved one day back for it (and returned afterwards).
    const forecast = await import('../forecast.service.js')
    const shift = (days: number) => q(`UPDATE "StockMovement" SET "createdAt" = "createdAt" + make_interval(days => $3) WHERE "workspaceId" = $1 AND "consumerWorkspaceId" = $2`, [A, B, days])
    await shift(-1)
    try {
      // The product's forecast drawer: its past days carry the same pool demand as the reorder page, and its cover
      // list the same shared-stock row.
      const detail = (await app.inject({ method: 'GET', url: `/api/fulfillment/replenishment/${id.jacket}/forecast-detail`, headers: { 'x-test-business': 'A' } })).json() as { series: Array<{ actual: number | null }>; channelCover: Cover[] }
      expect(detail.series.reduce((sum, point) => sum + (point.actual ?? 0), 0)).toBe(await sold())
      expect(detail.channelCover.filter((c) => c.channel === 'SHARED_POOL').map((c) => [c.marketplace, c.source])).toEqual([['Borrower B', 'SHARED_POOL']])
      await as(A, null, () => forecast.generateForecastsForAll({ includeColdStart: true }))
    } finally {
      await shift(1)
    }
    const [series] = await q<{ n: number; units: string }>(`SELECT count(*)::int AS n, COALESCE(sum("forecastUnits"),0)::text AS units FROM "ReplenishmentForecast" WHERE "workspaceId" = $1 AND sku = 'JACKET' AND channel = 'SHARED_POOL' AND marketplace = $2`, [A, B])
    expect(series.n).toBe(90)
    expect(Number(series.units)).toBeGreaterThan(0)

    // Auto-PO in B: a recommendation made before the switch (the jacket) is skipped; the cap, B's own, is ordered.
    const supplier = randomUUID()
    await q(`INSERT INTO "Supplier" (id, "workspaceId", name, "autoTriggerEnabled", "updatedAt") VALUES ($1,$2,'Supplier B',true,now())`, [supplier, B])
    for (const [productId, sku] of [[id.bJacket, 'JACKET'], [id.bCap, 'CAP']]) {
      await q(`INSERT INTO "ReplenishmentRecommendation" (id, "workspaceId", "productId", sku, velocity, "velocitySource", "leadTimeDays", "leadTimeSource", "safetyDays", "totalAvailable", "inboundWithinLeadTime", "effectiveStock", "reorderPoint", "reorderQuantity", urgency, "needsReorder", "preferredSupplierId", "unitCostCents")
        VALUES ($1,$2,$3,$4,1,'TRAILING_VELOCITY',7,'FALLBACK',7,0,0,0,10,5,'CRITICAL',true,$5,100)`, [randomUUID(), B, productId, sku, supplier])
    }
    const autoPo = await import('../auto-po.service.js')
    const run = await as(B, user.ownerB, () => autoPo.runAutoPoSweep({ triggeredBy: 'manual', dryRun: true }))
    expect([run.eligibleCount, run.posCreated, run.totalUnitsCreated]).toEqual([2, 1, 5])
    const [log] = await q<{ notes: string }>(`SELECT notes FROM "AutoPoRunLog" WHERE id = $1`, [run.runLogId])
    expect(log.notes).toContain('1 recommendation(s) skipped: the product sells from shared stock of Lender A, who restocks it (JACKET)')
  })

  describe('the ship-from: B ships a pool order from its own copy of the lender\'s warehouse address', () => {
    let shared: typeof import('./shared-warehouses.js')
    let routing: typeof import('../order-routing.service.js')
    const copyOf = async () => (await q<{ id: string; code: string; name: string; addressLine1: string | null; city: string | null; postalCode: string | null; country: string; isActive: boolean; isDefault: boolean; kind: string | null }>(
      `SELECT id, code, name, "addressLine1", city, "postalCode", country, "isActive", "isDefault", kind FROM "Warehouse" WHERE "workspaceId" = $1 AND "sharedFromLocationId" = $2`, [B, id.aMain]))
    beforeAll(async () => {
      shared = await import('./shared-warehouses.js')
      routing = await import('../order-routing.service.js')
    })

    it('13. accepting made B a copy of the lent warehouse\'s address (only the lent one), an address and nothing else', async () => {
      const [copy] = await copyOf()
      expect(copy).toMatchObject({ code: 'SHARED-IT-MAIN', name: 'IT-MAIN — Lender A (shared stock)', addressLine1: 'Via Roma 1', city: 'Milano', postalCode: '20100', country: 'IT', isActive: true, isDefault: false, kind: 'SHARED_STOCK' })
      id.copy = copy.id
      expect(await q(`SELECT 1 FROM "Warehouse" WHERE "workspaceId" = $1 AND "sharedFromLocationId" = $2`, [B, id.aOutlet])).toEqual([])
      expect(await q(`SELECT 1 FROM "StockLocation" WHERE "warehouseId" = $1`, [id.copy])).toEqual([])
      // Idempotent.
      expect(await as(B, null, () => shared.syncSharedWarehouses())).toEqual({ created: 0, updated: 0, deactivated: 0 })
    })

    it('14. a pool order ships from the copy; an own order from B\'s own warehouse, even when the copy is nearer the buyer', async () => {
      const pooled = await as(B, null, () => routing.resolveWarehouseForOrder({ channel: 'EBAY', marketplace: 'EBAY-GLOBAL', shippingCountry: 'IT', orderId: id.eb3 }))
      expect(pooled).toMatchObject({ warehouseId: id.copy, source: 'SHARED_STOCK' })
      const own = await ingestEbay(ebayOrder('EB-OWN', [{ sku: 'CAP', quantity: 1 }]))
      const ownRoute = await as(B, null, () => routing.resolveWarehouseForOrder({ channel: 'EBAY', marketplace: 'EBAY-GLOBAL', shippingCountry: 'IT', orderId: own.id }))
      expect(ownRoute).toMatchObject({ warehouseId: id.bWarehouse, source: 'SCORED' })
      // A refused sale took nothing from the pool: it is not a pool order.
      expect(await as(B, null, () => shared.sharedWarehouseForOrder(id.eb2))).toBeNull()
      // Creating the shipment: the pool order's from the copy, the own order's from B's own warehouse.
      for (const [orderId, warehouseId] of [[id.eb3, id.copy], [own.id, id.bWarehouse]]) {
        const created = await app.inject({ method: 'POST', url: '/api/fulfillment/shipments', payload: { orderId } })
        expect(created.statusCode, created.body.slice(0, 200)).toBe(200)
        expect(await q(`SELECT "warehouseId" FROM "Shipment" WHERE "orderId" = $1`, [orderId])).toEqual([{ warehouseId }])
      }
    })

    it('14b. the pickers never offer the copy; a routing rule cannot name it, and an older rule that does is skipped', async () => {
      const listed = async (url: string) => ((await app.inject({ method: 'GET', url })).json() as { items: Array<{ id: string }> }).items.map((w) => w.id)
      expect(await listed('/api/fulfillment/warehouses')).toEqual([id.bWarehouse])
      expect((await listed('/api/fulfillment/warehouses?shared=include')).sort()).toEqual([id.bWarehouse, id.copy].sort())
      const rulesPage = (await app.inject({ method: 'GET', url: '/api/fulfillment/routing-rules' })).json() as { warehouses: Array<{ id: string }> }
      expect(rulesPage.warehouses.map((w) => w.id)).toEqual([id.bWarehouse])
      const refused = await app.inject({ method: 'POST', url: '/api/fulfillment/routing-rules', payload: { name: 'To the copy', warehouseId: id.copy } })
      expect(refused.statusCode).toBe(400)
      expect(refused.json()).toMatchObject({ code: 'shared_stock_address' })
      const made = await app.inject({ method: 'POST', url: '/api/fulfillment/routing-rules', payload: { name: 'Everything', warehouseId: id.bWarehouse } })
      expect(made.statusCode, made.body.slice(0, 200)).toBe(201)
      const ruleId = (made.json() as { rule: { id: string } }).rule.id
      const route = () => as(B, null, () => routing.resolveWarehouseForOrder({ channel: 'EBAY', marketplace: 'EBAY-GLOBAL', shippingCountry: 'IT' }))
      try {
        expect((await app.inject({ method: 'PATCH', url: `/api/fulfillment/routing-rules/${ruleId}`, payload: { warehouseId: id.copy } })).statusCode).toBe(400)
        expect(await route()).toMatchObject({ warehouseId: id.bWarehouse, source: 'RULE_MATCH', ruleId })
        // A rule saved before this guard that names the copy: never used; the order routes as if it were not there.
        await q(`UPDATE "OrderRoutingRule" SET "warehouseId" = $1 WHERE id = $2`, [id.copy, ruleId])
        expect(await route()).toMatchObject({ warehouseId: id.bWarehouse, source: 'SCORED' })
      } finally {
        await q(`DELETE FROM "OrderRoutingRule" WHERE id = $1`, [ruleId])
      }
    })

    it('15. stock is never written to the copy', async () => {
      await expect(as(B, null, () => movement.applyStockMovement({ productId: id.bCap, warehouseId: id.copy, change: 1, reason: 'INBOUND_RECEIVED' })))
        .rejects.toThrow(/address of another business's shared stock/)
      expect(await shelves()).toMatchObject({ bCap: [4, 0, 4] }) // unchanged (test 14 sold one)
    })

    it('16. the lender\'s address change reaches the copy; after the grant ends the copy is off, and an order already made still ships from it', async () => {
      await q(`UPDATE "Warehouse" SET city = 'Torino', "postalCode" = '10100' WHERE id = $1`, [id.aWarehouse])
      expect(await as(B, null, () => shared.syncSharedWarehouses())).toEqual({ created: 0, updated: 1, deactivated: 0 })
      expect((await copyOf())[0]).toMatchObject({ city: 'Torino', postalCode: '10100', isActive: true })
      await as(A, user.ownerA, () => grants.lenderAction(grantId, 'end', { expectedVersion: grantVersion }))
      await drain()
      expect(await as(B, null, () => shared.syncSharedWarehouses())).toEqual({ created: 0, updated: 0, deactivated: 1 })
      expect((await copyOf())[0]).toMatchObject({ isActive: false })
      expect(await as(B, null, () => routing.resolveWarehouseForOrder({ channel: 'EBAY', marketplace: 'EBAY-GLOBAL', shippingCountry: 'IT', orderId: id.eb3 })))
        .toMatchObject({ warehouseId: id.copy, source: 'SHARED_STOCK' })
    })
  })

})
