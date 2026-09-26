/**
 * E3 — a cancellation gives back exactly the units its order took AT INGEST from this business's own
 * shelves, and only while none of the order has shipped (R4, 2026-09-26 stock model), on a real
 * multi-connection PostgreSQL as a production-equivalent owner. The cascade is shared by eBay
 * (decrement at ingestion) and by Amazon FBM / Shopify (hold, then take out when shipped): the Amazon
 * and Shopify cases drive the same stock primitives those channels call (reserveOpenOrder,
 * consumeOpenOrder), as stock-pool-orders.vitest.test.ts does.
 *
 * Before E3 the own-stock branch restored every line's quantity unless an ORDER_CANCELLED movement
 * already existed for (order, product): lines that took nothing were "restored" (phantom stock), a
 * second line of one product was skipped (under-restore), and a second run after a released hold
 * restored units the order never took.
 *
 * R4 changed E3's scope: units taken when the order SHIPPED (a consumed hold) are never given back
 * automatically — they left the shelf; a return restocks them. Nor are units taken at ingest once the
 * order shows it shipped. A cancellation after (part of) the order shipped gives nothing back, releases
 * its open holds and tells the owners once.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_t, key) => (database.client as any)[key] }) }))
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []) }
  return { addJobSafely: vi.fn(async () => undefined), outboundSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, channelSyncQueue: queue, bulkJobQueue: queue, redis: { connection: null } }
})
vi.mock('../advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(), peekCached: async () => undefined, putCached: () => undefined, flushAdsCache: async () => undefined,
}))

const W = 'nexus_legacy_workspace'
const serverUrl = concurrentDatabaseUrl()
const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const inW = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: W, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const q = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
let locationId = ''
let connectionId = ''
let cancellation: typeof import('./index.js')
let levels: typeof import('../stock-level.service.js')
let movement: typeof import('../stock-movement.service.js')
let ebay: { processOrder: (order: unknown, connectionId: string) => Promise<{ id: string }> }
let ownerId = ''
/** The owners' notices about an order that was cancelled after it shipped. */
const shippedNotices = (orderId: string) => q<{ userId: string; severity: string }>(`SELECT "userId", severity FROM "Notification" WHERE type='channel-order-cancelled-after-shipment' AND "entityId"=$1`, [orderId])

async function product(label: string, quantity: number) {
  const id = randomUUID(), sku = `${label}-${id.slice(0, 8)}`
  await q(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "totalStock", "updatedAt") VALUES ($1,$2,$3,$3,10,$4,now())`, [id, W, sku, quantity])
  await q(`INSERT INTO "StockLevel" (id, "workspaceId", "locationId", "productId", quantity, reserved, available, "lastUpdatedAt") VALUES ($1,$2,$3,$4,$5,0,$5,now())`, [randomUUID(), W, locationId, id, quantity])
  return { id, sku }
}
const level = async (productId: string) => (await q<{ quantity: number; reserved: number }>(`SELECT quantity, reserved FROM "StockLevel" WHERE "productId"=$1`, [productId]))[0]
/** An order as another channel's ingestion writes it (Amazon, Shopify), with the channel's own line data when given. */
async function channelOrder(channel: 'AMAZON' | 'SHOPIFY', lines: Array<{ productId: string; quantity: number; amazonMetadata?: Record<string, unknown> }>, status = 'PENDING', shopifyMetadata?: Record<string, unknown>) {
  const orderId = randomUUID()
  await q(`INSERT INTO "Order" (id, "workspaceId", channel, "channelOrderId", status, "totalPrice", "customerName", "customerEmail", "shippingAddress", "shopifyMetadata", "updatedAt")
    VALUES ($1,$2,$3::"OrderChannel",$4,$5::"OrderStatus",10,'Buyer','buyer@example.test','{}'::jsonb,$6::jsonb,now())`, [orderId, W, channel, `CH-${orderId.slice(0, 8)}`, status, shopifyMetadata ? JSON.stringify(shopifyMetadata) : null])
  for (const [i, line] of lines.entries()) {
    await q(`INSERT INTO "OrderItem" (id, "workspaceId", "orderId", "productId", sku, quantity, price, "externalLineItemId", "amazonMetadata", "updatedAt") VALUES ($1,$2,$3,$4,'SKU',$5,10,$6,$7::jsonb,now())`,
      [randomUUID(), W, orderId, line.productId, line.quantity, `L${i}`, line.amazonMetadata ? JSON.stringify(line.amazonMetadata) : null])
  }
  return orderId
}
/** The notice about an order cancelled or refunded after (part of) it shipped, as its owner reads it. */
const shippedNotice = async (orderId: string) => (await q<{ title: string; body: string }>(`SELECT title, body FROM "Notification" WHERE type='channel-order-cancelled-after-shipment' AND "entityId"=$1`, [orderId]))[0]
const orderMovements = (orderId: string) => q<{ productId: string; change: number; reason: string }>(`SELECT "productId", change, reason::text AS reason FROM "StockMovement" WHERE "orderId"=$1 AND change <> 0 ORDER BY "productId", change`, [orderId])
const ebayOrder = (orderId: string, lines: Array<{ sku: string; quantity: number }>, extra: Record<string, unknown> = {}) => ({
  orderId, creationDate: '2026-09-23T10:00:00.000Z', orderPaymentStatus: 'PAID', orderFulfillmentStatus: 'NOT_STARTED',
  buyer: { username: 'cancel.buyer' }, pricingSummary: { total: { value: '20.00', currency: 'EUR' } },
  lineItems: lines.map((l, i) => ({ lineItemId: `${orderId}-L${i + 1}`, sku: l.sku, title: l.sku, quantity: l.quantity, lineItemCost: { value: '10.00', currency: 'EUR' } })),
  ...extra,
})
const ingest = (payload: unknown) => inW(() => ebay.processOrder(payload, connectionId))
const cancel = (orderId: string) => inW(() => cancellation.handleOrderCancelled(orderId))
const restores = (orderId: string) => q<{ productId: string; change: number; referenceType: string | null }>(`SELECT "productId", change, "referenceType" FROM "StockMovement" WHERE "orderId"=$1 AND reason='ORDER_CANCELLED' ORDER BY "productId", change`, [orderId])

describe.skipIf(!serverUrl)('order cancellation gives back exactly what the order took (real PostgreSQL)', () => {
  beforeAll(async () => {
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    database = await concurrentDatabase({ maxConnections: 16 })
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_available_invariant" CHECK ("available" = "quantity" - "reserved")`)
    const warehouse = randomUUID()
    await q(`INSERT INTO "Warehouse" (id, "workspaceId", code, name, country, "isDefault", "updatedAt") VALUES ($1,$2,'IT-MAIN','Main','IT',true,now())`, [warehouse, W])
    locationId = randomUUID()
    await q(`INSERT INTO "StockLocation" (id, "workspaceId", type, code, name, "warehouseId", "updatedAt") VALUES ($1,$2,'WAREHOUSE','IT-MAIN','Main',$3,now())`, [locationId, W, warehouse])
    // An owner, so a notice has someone to reach.
    ownerId = randomUUID()
    const role = randomUUID(), member = randomUUID()
    await q(`INSERT INTO "Role" (id,key,name,"isSystem","updatedAt") VALUES ($1,'OWNER','Owner',true,now())`, [role])
    await q(`INSERT INTO "UserProfile" (id,email,status,"updatedAt") VALUES ($1,$2,'active',now())`, [ownerId, `${ownerId}@example.test`])
    await q(`INSERT INTO "WorkspaceMembership" (id,"workspaceId","userId",status,"updatedAt") VALUES ($1,$2,$3,'active',now())`, [member, W, ownerId])
    await q(`INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)`, [member, role])
    connectionId = randomUUID()
    await q(`INSERT INTO "ChannelConnection" (id, "workspaceId", "channelType", "managedBy", "externalAccountId", "isActive", "connectionMetadata", "updatedAt") VALUES ($1,$2,'EBAY','oauth','seller-cancel',true,'{"environment":"production"}'::jsonb,now())`, [connectionId, W])
    cancellation = await import('./index.js')
    levels = await import('../stock-level.service.js')
    movement = await import('../stock-movement.service.js')
    const { EbayOrdersService } = await import('../ebay-orders.service.js')
    ebay = new EbayOrdersService() as unknown as typeof ebay
  }, 180_000)
  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  }, 60_000)

  it('eBay: two own lines of one product both come back, once, to where they left', async () => {
    const a = await product('TWO-LINES', 10)
    const order = await ingest(ebayOrder('E3-TWO', [{ sku: a.sku, quantity: 1 }, { sku: a.sku, quantity: 2 }]))
    expect(await level(a.id)).toMatchObject({ quantity: 7 })
    expect(await cancel(order.id)).toMatchObject({ itemsRestocked: 2, errors: [] })
    expect(await level(a.id)).toMatchObject({ quantity: 10 })
    expect(await cancel(order.id)).toMatchObject({ itemsRestocked: 0, errors: [] })
    expect(await level(a.id)).toMatchObject({ quantity: 10 })
    expect(await restores(order.id)).toEqual([{ productId: a.id, change: 1, referenceType: 'StockMovement' }, { productId: a.id, change: 2, referenceType: 'StockMovement' }])
  })

  it('eBay: a shortfall line took nothing and gets nothing back; the covered line comes back', async () => {
    const covered = await product('COVERED', 5), empty = await product('EMPTY', 0)
    const order = await ingest(ebayOrder('E3-SHORT', [{ sku: covered.sku, quantity: 2 }, { sku: empty.sku, quantity: 1 }]))
    expect([await level(covered.id), await level(empty.id)]).toMatchObject([{ quantity: 3 }, { quantity: 0 }])
    await cancel(order.id)
    expect([await level(covered.id), await level(empty.id)]).toMatchObject([{ quantity: 5 }, { quantity: 0 }])
  })

  it('eBay: an order that arrived cancelled took nothing and gets nothing back', async () => {
    const a = await product('ARRIVED', 4)
    const order = await ingest(ebayOrder('E3-ARRIVED', [{ sku: a.sku, quantity: 2 }], { cancelStatus: { cancelState: 'CANCELED' } }))
    expect(await cancel(order.id)).toMatchObject({ itemsRestocked: 0, errors: [] })
    expect(await level(a.id)).toMatchObject({ quantity: 4 })
  })

  it('Amazon FBM: a released hold gives back no quantity — on the first run or any later one', async () => {
    const a = await product('AMZ-HOLD', 6)
    const orderId = await channelOrder('AMAZON', [{ productId: a.id, quantity: 2 }])
    await inW(() => levels.reserveOpenOrder({ orderId, productId: a.id, locationId, quantity: 2, actor: 'amazon-orders' }))
    expect(await level(a.id)).toEqual({ quantity: 6, reserved: 2 })
    expect(await cancel(orderId)).toMatchObject({ reservationsReleased: 1, itemsRestocked: 0 })
    expect(await level(a.id)).toEqual({ quantity: 6, reserved: 0 })
    expect(await cancel(orderId)).toMatchObject({ reservationsReleased: 0, itemsRestocked: 0 })
    expect(await level(a.id)).toEqual({ quantity: 6, reserved: 0 })
  })

  // R4 (sanctioned change): before, this arm asserted the units came back (6). Units taken when the
  // order shipped left the shelf; only a return puts them back.
  it('Amazon FBM: a shipped (taken out) order cancelled later keeps its units deducted, and the owner is told once', async () => {
    const a = await product('AMZ-SHIPPED', 6)
    const orderId = await channelOrder('AMAZON', [{ productId: a.id, quantity: 2 }])
    await inW(() => levels.reserveOpenOrder({ orderId, productId: a.id, locationId, quantity: 2, actor: 'amazon-orders' }))
    await inW(() => levels.consumeOpenOrder({ orderId, actor: 'amazon-orders' }))
    expect(await level(a.id)).toEqual({ quantity: 4, reserved: 0 })
    expect(await cancel(orderId)).toMatchObject({ itemsRestocked: 0, shippedBeforeCancel: true, errors: [] })
    await cancel(orderId)
    expect(await level(a.id)).toEqual({ quantity: 4, reserved: 0 })
    expect(await restores(orderId)).toEqual([])
    expect(await shippedNotices(orderId)).toEqual([{ userId: ownerId, severity: 'warn' }])
  })

  // C1 (review 2026-09-26, sanctioned change): before, this arm asserted the hold was released ({6, 0}) —
  // which put the unit that had shipped back on sale. With no line data from the channel, the hold is
  // KEPT: never released into stock by a cancellation, nor by the reconcile. The stock-page release is
  // the owner's way out once the parcel is checked.
  it('C1: a partly shipped order with no line data keeps its hold through the cancellation and the reconcile; the owner is told how to release it', async () => {
    const a = await product('AMZ-PARTIAL', 6)
    const orderId = await channelOrder('AMAZON', [{ productId: a.id, quantity: 2 }], 'PARTIALLY_SHIPPED')
    await q(`UPDATE "Order" SET "shippedAt"=now() WHERE id=$1`, [orderId])
    const hold = await inW(() => levels.reserveOpenOrder({ orderId, productId: a.id, locationId, quantity: 2, actor: 'amazon-orders' }))
    await q(`UPDATE "Order" SET status='CANCELLED' WHERE id=$1`, [orderId])
    expect(await cancel(orderId)).toMatchObject({ reservationsReleased: 0, itemsRestocked: 0, shippedBeforeCancel: true, errors: [] })
    expect(await level(a.id)).toEqual({ quantity: 6, reserved: 2 })
    const { reconcileOpenOrderReservations } = await import('../reservation-reconcile.js')
    await inW(() => reconcileOpenOrderReservations())
    expect(await level(a.id)).toEqual({ quantity: 6, reserved: 2 })
    expect(await shippedNotices(orderId)).toEqual([{ userId: ownerId, severity: 'warn' }])
    const notice = await shippedNotice(orderId)
    expect(notice.title).toBe(`AMAZON order CH-${orderId.slice(0, 8)} was cancelled after (part of) it shipped`)
    expect(notice.body).toContain(`Nexus cannot tell from AMAZON whether 2 × ${a.sku} shipped, so they stay held for this order. If they did not ship, release this order's hold on the stock page.`)
    expect(notice.body).not.toMatch(/put back on sale/)
    // The owner checked the parcel: nothing shipped. The stock-page release frees it, once.
    await inW(() => levels.releaseReservation(hold.id, { actor: 'manual-release' }))
    await cancel(orderId)
    expect(await level(a.id)).toEqual({ quantity: 6, reserved: 0 })
    expect(await shippedNotices(orderId)).toHaveLength(1)
  })

  // C1 — the channel's own line data says which units shipped: those are taken, the rest released.
  it('C1 Amazon: a partly shipped order cancelled — the shipped quantity per line is taken, the rest released, once; told truthfully', async () => {
    const a = await product('AMZ-SPLIT-A', 6), b = await product('AMZ-SPLIT-B', 6)
    const orderId = await channelOrder('AMAZON', [
      { productId: a.id, quantity: 2, amazonMetadata: { QuantityOrdered: 2, QuantityShipped: 1 } },
      { productId: b.id, quantity: 1, amazonMetadata: { QuantityOrdered: 1, QuantityShipped: 0 } },
    ], 'PARTIALLY_SHIPPED')
    await q(`UPDATE "Order" SET "shippedAt"=now() WHERE id=$1`, [orderId])
    await inW(() => levels.reserveOpenOrder({ orderId, productId: a.id, locationId, quantity: 2, actor: 'amazon-orders' }))
    await inW(() => levels.reserveOpenOrder({ orderId, productId: b.id, locationId, quantity: 1, actor: 'amazon-orders' }))
    await q(`UPDATE "Order" SET status='CANCELLED' WHERE id=$1`, [orderId])
    expect(await cancel(orderId)).toMatchObject({ reservationsReleased: 1, itemsRestocked: 0, shippedBeforeCancel: true, errors: [] })
    expect(await cancel(orderId)).toMatchObject({ reservationsReleased: 0, itemsRestocked: 0, errors: [] })
    expect([await level(a.id), await level(b.id)]).toEqual([{ quantity: 5, reserved: 0 }, { quantity: 6, reserved: 0 }])
    expect(await orderMovements(orderId)).toEqual([{ productId: a.id, change: -1, reason: 'RESERVATION_CONSUMED' }])
    expect(await shippedNotices(orderId)).toEqual([{ userId: ownerId, severity: 'warn' }])
    const notice = await shippedNotice(orderId)
    expect(notice.body).toBe('Nothing that shipped was put back into stock; when a parcel comes back, book it in as a return to put its units back. 2 units that had not shipped were put back on sale.')
  })

  it('C1 eBay: the line statuses say which lines shipped; only the lines that did not ship come back, once', async () => {
    const a = await product('EBAY-SPLIT-A', 5), b = await product('EBAY-SPLIT-B', 5)
    const lines = [{ sku: a.sku, quantity: 1 }, { sku: b.sku, quantity: 2 }]
    const order = await ingest(ebayOrder('E3-SPLIT', lines))
    expect([await level(a.id), await level(b.id)]).toMatchObject([{ quantity: 4 }, { quantity: 3 }])
    const withStatuses = (extra: Record<string, unknown>) => {
      const payload = ebayOrder('E3-SPLIT', lines, extra) as { lineItems: Array<Record<string, unknown>> }
      payload.lineItems[0].lineItemFulfillmentStatus = 'FULFILLED'
      payload.lineItems[1].lineItemFulfillmentStatus = 'NOT_STARTED'
      return payload
    }
    await ingest(withStatuses({ orderFulfillmentStatus: 'IN_PROGRESS' }))
    await ingest(withStatuses({ cancelStatus: { cancelState: 'CANCELED' } }))
    await vi.waitFor(async () => expect(await shippedNotices(order.id)).toHaveLength(1))
    expect(await cancel(order.id)).toMatchObject({ itemsRestocked: 0, shippedBeforeCancel: true, errors: [] })
    expect([await level(a.id), await level(b.id)]).toMatchObject([{ quantity: 4 }, { quantity: 5 }])
    expect(await restores(order.id)).toEqual([{ productId: b.id, change: 2, referenceType: 'StockMovement' }])
    expect(await inW(() => cancellation.orderRestorePending(database.client, order.id))).toBe(false)
    expect((await shippedNotice(order.id)).body).toContain('2 units that had not shipped were put back on sale.')
  })

  // What an at-ingest take looks like in the own ledger (the eBay writer's ORDER_PLACED movement).
  const takeAtIngest = (orderId: string, productId: string, at: string, units: number) =>
    inW(() => movement.applyStockMovement({ productId, locationId: at, change: -units, reason: 'ORDER_PLACED', referenceType: 'ORDER', referenceId: orderId, orderId, actor: 'ebay-orders-sync' }))

  it('gives units back to the warehouse they left, not the default one', async () => {
    const warehouse = randomUUID(), other = randomUUID()
    await q(`INSERT INTO "Warehouse" (id, "workspaceId", code, name, country, "isDefault", "updatedAt") VALUES ($1,$2,'IT-SECOND','Second','IT',false,now())`, [warehouse, W])
    await q(`INSERT INTO "StockLocation" (id, "workspaceId", type, code, name, "warehouseId", "updatedAt") VALUES ($1,$2,'WAREHOUSE','IT-SECOND','Second',$3,now())`, [other, W, warehouse])
    const a = await product('ELSEWHERE', 2)
    await q(`INSERT INTO "StockLevel" (id, "workspaceId", "locationId", "productId", quantity, reserved, available, "lastUpdatedAt") VALUES ($1,$2,$3,$4,5,0,5,now())`, [randomUUID(), W, other, a.id])
    const orderId = await channelOrder('AMAZON', [{ productId: a.id, quantity: 3 }])
    await takeAtIngest(orderId, a.id, other, 3)
    await cancel(orderId)
    expect(await q(`SELECT sl.code, lv.quantity FROM "StockLevel" lv JOIN "StockLocation" sl ON sl.id=lv."locationId" WHERE lv."productId"=$1 ORDER BY sl.code`, [a.id])).toEqual([{ code: 'IT-MAIN', quantity: 2 }, { code: 'IT-SECOND', quantity: 5 }])
  })

  it('credits each taking movement once: a unit taken after an earlier restore comes back where it left', async () => {
    const warehouse = randomUUID(), third = randomUUID()
    await q(`INSERT INTO "Warehouse" (id, "workspaceId", code, name, country, "isDefault", "updatedAt") VALUES ($1,$2,'IT-THIRD','Third','IT',false,now())`, [warehouse, W])
    await q(`INSERT INTO "StockLocation" (id, "workspaceId", type, code, name, "warehouseId", "updatedAt") VALUES ($1,$2,'WAREHOUSE','IT-THIRD','Third',$3,now())`, [third, W, warehouse])
    const a = await product('LATE-TAKE', 4)
    await q(`INSERT INTO "StockLevel" (id, "workspaceId", "locationId", "productId", quantity, reserved, available, "lastUpdatedAt") VALUES ($1,$2,$3,$4,4,0,4,now())`, [randomUUID(), W, third, a.id])
    const orderId = await channelOrder('AMAZON', [{ productId: a.id, quantity: 1 }, { productId: a.id, quantity: 2 }])
    await takeAtIngest(orderId, a.id, locationId, 1)
    await cancel(orderId)
    await takeAtIngest(orderId, a.id, third, 2)
    await cancel(orderId)
    expect(await q(`SELECT sl.code, lv.quantity FROM "StockLevel" lv JOIN "StockLocation" sl ON sl.id=lv."locationId" WHERE lv."productId"=$1 ORDER BY sl.code`, [a.id])).toEqual([{ code: 'IT-MAIN', quantity: 4 }, { code: 'IT-THIRD', quantity: 4 }])
  })

  it('Amazon FBA: an order this business never took stock for gets nothing back', async () => {
    const a = await product('AMZ-FBA', 3)
    const orderId = await channelOrder('AMAZON', [{ productId: a.id, quantity: 2 }], 'CANCELLED')
    expect(await cancel(orderId)).toMatchObject({ itemsRestocked: 0 })
    expect(await level(a.id)).toEqual({ quantity: 3, reserved: 0 })
  })

  it('Shopify: a hold that failed for lack of stock took nothing, and nothing comes back', async () => {
    const a = await product('SHOP-SHORT', 1)
    const orderId = await channelOrder('SHOPIFY', [{ productId: a.id, quantity: 3 }])
    await expect(inW(() => levels.reserveOpenOrder({ orderId, productId: a.id, locationId, quantity: 3, actor: 'shopify-webhooks:order-create' }))).rejects.toThrow()
    await cancel(orderId)
    expect(await level(a.id)).toEqual({ quantity: 1, reserved: 0 })
  })

  // R4 (sanctioned change): before, this arm asserted both lines came back (9).
  it('Shopify: a fulfilled order cancelled later keeps its two lines of one product deducted, and the owner is told', async () => {
    const a = await product('SHOP-TWO', 9)
    const orderId = await channelOrder('SHOPIFY', [{ productId: a.id, quantity: 1 }, { productId: a.id, quantity: 3 }])
    await inW(() => levels.reserveOpenOrder({ orderId, productId: a.id, locationId, quantity: 4, actor: 'shopify-webhooks:order-create' }))
    await inW(() => levels.consumeOpenOrder({ orderId, actor: 'shopify-webhooks:fulfillment' }))
    expect(await level(a.id)).toEqual({ quantity: 5, reserved: 0 })
    await cancel(orderId)
    expect(await level(a.id)).toEqual({ quantity: 5, reserved: 0 })
    expect(await shippedNotices(orderId)).toHaveLength(1)
  })

  it('eBay: an order cancelled after it shipped keeps its units deducted; re-reads neither give back nor repeat the notice', async () => {
    const a = await product('EBAY-SHIPPED', 5)
    const lines = [{ sku: a.sku, quantity: 2 }]
    const order = await ingest(ebayOrder('E3-SHIPPED', lines))
    expect(await level(a.id)).toMatchObject({ quantity: 3 })
    await ingest(ebayOrder('E3-SHIPPED', lines, { orderFulfillmentStatus: 'IN_PROGRESS' }))
    expect(await q(`SELECT status::text, "shippedAt" IS NOT NULL AS shipped FROM "Order" WHERE id=$1`, [order.id])).toEqual([{ status: 'SHIPPED', shipped: true }])
    await ingest(ebayOrder('E3-SHIPPED', lines, { cancelStatus: { cancelState: 'CANCELED' } }))
    await vi.waitFor(async () => expect(await shippedNotices(order.id)).toHaveLength(1))
    await ingest(ebayOrder('E3-SHIPPED', lines, { cancelStatus: { cancelState: 'CANCELED' } }))
    expect(await cancel(order.id)).toMatchObject({ itemsRestocked: 0, shippedBeforeCancel: true, errors: [] })
    expect(await level(a.id)).toMatchObject({ quantity: 3 })
    expect(await restores(order.id)).toEqual([])
    expect(await shippedNotices(order.id)).toHaveLength(1)
    expect(await inW(() => cancellation.orderRestorePending(database.client, order.id))).toBe(false)
  })

  it('never gives back twice what a return, or an earlier restore, already gave back', async () => {
    const returned = await product('RETURNED', 5), legacy = await product('LEGACY', 5)
    const order = await ingest(ebayOrder('E3-RETURNED', [{ sku: returned.sku, quantity: 2 }, { sku: legacy.sku, quantity: 2 }]))
    const returnId = randomUUID()
    await q(`INSERT INTO "Return" (id, "workspaceId", "orderId", channel, "updatedAt") VALUES ($1,$2,$3,'EBAY',now())`, [returnId, W, order.id])
    await inW(() => movement.applyStockMovement({ productId: returned.id, locationId, change: 2, reason: 'RETURN_RESTOCKED', referenceType: 'Return', referenceId: returnId, actor: 'return-restock' }))
    // What the pre-E3 cascade wrote: one restore per (order, product), referenced to the order.
    await inW(() => movement.applyStockMovement({ productId: legacy.id, locationId, change: 2, reason: 'ORDER_CANCELLED', referenceType: 'Order', referenceId: order.id, orderId: order.id, actor: 'system' }))
    expect(await cancel(order.id)).toMatchObject({ itemsRestocked: 0, errors: [] })
    expect([await level(returned.id), await level(legacy.id)]).toMatchObject([{ quantity: 5 }, { quantity: 5 }])
  })

  it('two cancellations at once give each line back exactly once', async () => {
    const a = await product('RACE-A', 8), b = await product('RACE-B', 8)
    const order = await ingest(ebayOrder('E3-RACE', [{ sku: a.sku, quantity: 1 }, { sku: b.sku, quantity: 2 }, { sku: a.sku, quantity: 3 }]))
    const outcomes = await Promise.all([cancel(order.id), cancel(order.id), cancel(order.id)])
    expect(outcomes.flatMap(o => o.errors)).toEqual([])
    expect(outcomes.reduce((sum, o) => sum + o.itemsRestocked, 0)).toBe(3)
    expect([await level(a.id), await level(b.id)]).toMatchObject([{ quantity: 8 }, { quantity: 8 }])
  })

  it('a cancellation that failed part-way is completed by the next eBay read of the cancelled order, without repeating what came back', async () => {
    const a = await product('RERUN-A', 5), b = await product('RERUN-B', 5)
    const order = await ingest(ebayOrder('E3-RERUN', [{ sku: a.sku, quantity: 1 }, { sku: b.sku, quantity: 2 }]))
    await q(`CREATE FUNCTION test_fail_restore() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."productId" = '${b.id}' AND NEW.reason = 'ORDER_CANCELLED' THEN RAISE EXCEPTION 'injected restore failure'; END IF; RETURN NEW; END $$`)
    await q(`CREATE TRIGGER test_fail_restore BEFORE INSERT ON "StockMovement" FOR EACH ROW EXECUTE FUNCTION test_fail_restore()`)
    try {
      await q(`UPDATE "Order" SET status='CANCELLED' WHERE id=$1`, [order.id])
      const first = await cancel(order.id)
      expect(first.errors).toHaveLength(1)
      expect([await level(a.id), await level(b.id)]).toMatchObject([{ quantity: 5 }, { quantity: 3 }])
    } finally {
      await q('DROP TRIGGER IF EXISTS test_fail_restore ON "StockMovement"')
      await q('DROP FUNCTION IF EXISTS test_fail_restore()')
    }
    // The durable marker: B's taking movement has no restore yet, so the next read of the order finishes it.
    await ingest(ebayOrder('E3-RERUN', [{ sku: a.sku, quantity: 1 }, { sku: b.sku, quantity: 2 }], { cancelStatus: { cancelState: 'CANCELED' } }))
    expect([await level(a.id), await level(b.id)]).toMatchObject([{ quantity: 5 }, { quantity: 5 }])
    await ingest(ebayOrder('E3-RERUN', [{ sku: a.sku, quantity: 1 }, { sku: b.sku, quantity: 2 }], { cancelStatus: { cancelState: 'CANCELED' } }))
    expect(await restores(order.id)).toHaveLength(2)
  })
})
