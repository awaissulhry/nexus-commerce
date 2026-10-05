/**
 * The eBay order writer on a real multi-connection PostgreSQL, run as a production-equivalent
 * owner: one transaction for the order, its unseen lines and their stock effect.
 *
 * Before this writer, ingestion inserted lines and then swallowed any stock failure: the order
 * and lines committed without a movement, and every later poll skipped the line as "seen". A
 * failure on a second line left the first line undeducted the same way. These cases are the
 * reproductions; they drive the production polling path (EbayOrdersService.processOrder).
 *
 * Needs NEXUS_TEST_CONCURRENT_PG_URL; run by scripts/run-real-postgres-tests.mjs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { concurrentDatabase, concurrentDatabaseUrl } from '../test-support/concurrent-database.js'
import { withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
const insideDomain = new AsyncLocalStorage<boolean>()
vi.mock('../db.js', () => ({ default: new Proxy({}, { get: (_t, key) => {
  if (insideDomain.getStore()) throw new Error('Global database client used inside domain transaction')
  return (database.client as any)[key]
} }) }))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []) }
  return {
    addJobSafely: vi.fn(async () => undefined),
    outboundSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, channelSyncQueue: queue, bulkJobQueue: queue,
    redis: { connection: null },
  }
})
vi.mock('./advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined, putCached: () => undefined, flushAdsCache: async () => undefined,
}))

const W = 'nexus_legacy_workspace'
const owners = [randomUUID(), randomUUID()]
const serverUrl = concurrentDatabaseUrl()
const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const inW = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: W, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const q = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]

let service: { processOrder: (order: unknown, connectionId: string) => Promise<{ id: string }> }
const ingest = (order: unknown, connectionId: string) => inW(() => service.processOrder(order, connectionId))

const conn: Record<string, string> = {}
let locationId = ''
async function product(label: string, quantity: number) {
  const id = randomUUID(), sku = `${label}-${id.slice(0, 8)}`
  await q(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "totalStock", "updatedAt") VALUES ($1,$2,$3,$3,10,$4,now())`, [id, W, sku, quantity])
  await q(`INSERT INTO "StockLevel" (id, "workspaceId", "locationId", "productId", quantity, reserved, available, "lastUpdatedAt") VALUES ($1,$2,$3,$4,$5,0,$5,now())`, [randomUUID(), W, locationId, id, quantity])
  return { id, sku }
}
const ebayOrder = (orderId: string, lines: Array<{ sku: string; quantity: number; lineItemId?: string; legacyItemId?: string }>, extra: Record<string, unknown> = {}) => ({
  orderId,
  creationDate: '2026-09-23T10:00:00.000Z',
  orderPaymentStatus: 'PAID',
  orderFulfillmentStatus: 'NOT_STARTED',
  buyer: { username: 'Buyer.Name_01' },
  pricingSummary: { total: { value: '20.00', currency: 'EUR' } },
  lineItems: lines.map((l, i) => ({ lineItemId: l.lineItemId ?? `${orderId}-L${i + 1}`, sku: l.sku, legacyItemId: l.legacyItemId, title: `Title ${i + 1}`, quantity: l.quantity, lineItemCost: { value: '10.00', currency: 'EUR' } })),
  ...extra,
})
// The columns the writer owns. (Post-commit customer/risk hooks touch updatedAt later, on their own.)
const orderRows = (channelOrderId: string) => q(`SELECT id, status::text AS status, "channelConnectionId", "customerName", "customerEmail", "totalPrice"::text AS "totalPrice", "shippingAddress", "ebayMetadata" FROM "Order" WHERE channel='EBAY' AND "channelOrderId"=$1`, [channelOrderId])
const itemRows = (channelOrderId: string) => q(`SELECT i."externalLineItemId", i."productId", i.quantity, i."ebayMetadata" FROM "OrderItem" i JOIN "Order" o ON o.id=i."orderId" WHERE o."channelOrderId"=$1 ORDER BY i."externalLineItemId"`, [channelOrderId])
const movementRows = (channelOrderId: string) => q(`SELECT m."productId", m.change, m.reason::text AS reason FROM "StockMovement" m WHERE m."orderId" IN (SELECT id FROM "Order" WHERE "channelOrderId"=$1) ORDER BY m."productId", m.change`, [channelOrderId])
const levelOf = async (productId: string) => (await q<{ quantity: number }>(`SELECT quantity FROM "StockLevel" WHERE "productId"=$1`, [productId]))[0]?.quantity
const shortfallNotices = (orderId: string) => q(`SELECT "userId", title, body, severity FROM "Notification" WHERE type='channel-order-stock-shortfall' AND "entityId"=$1 ORDER BY "userId"`, [orderId])
const effects = async (channelOrderId: string) => Object.fromEntries((await itemRows(channelOrderId)).map(row => [row.externalLineItemId, row.ebayMetadata?.stockEffect]))

let ownerRole = ''
/** A separate business with its own warehouses, owner and eBay account, for configuration refusals. */
async function business(label: string, warehouses: Array<{ code: string; isDefault?: boolean; isActive?: boolean; country?: string }>, status = 'active') {
  const id = `ws_${label}_${randomUUID().slice(0, 8)}`, owner = randomUUID(), membership = randomUUID(), connectionId = randomUUID()
  await q(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1,$1,'active','test',$1,now())`, [id])
  await q(`INSERT INTO "UserProfile" (id, email, status, "updatedAt") VALUES ($1,$2,'active',now())`, [owner, `${owner}@example.test`])
  await q(`INSERT INTO "WorkspaceMembership" (id, "workspaceId", "userId", status, "updatedAt") VALUES ($1,$2,$3,'active',now())`, [membership, id, owner])
  await q(`INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)`, [membership, ownerRole])
  for (const w of warehouses) {
    const warehouse = randomUUID()
    await q(`INSERT INTO "Warehouse" (id, "workspaceId", code, name, country, "isDefault", "isActive", "updatedAt") VALUES ($1,$2,$3,$3,$4,$5,$6,now())`, [warehouse, id, w.code, w.country ?? 'IT', w.isDefault ?? false, w.isActive ?? true])
    await q(`INSERT INTO "StockLocation" (id, "workspaceId", type, code, name, "warehouseId", "isActive", "updatedAt") VALUES ($1,$2,'WAREHOUSE',$3,$3,$4,$5,now())`, [randomUUID(), id, w.code, warehouse, w.isActive ?? true])
  }
  await q(`INSERT INTO "ChannelConnection" (id, "workspaceId", "channelType", "managedBy", "externalAccountId", "isActive", "connectionMetadata", "updatedAt") VALUES ($1,$2,'EBAY','oauth',$3,true,'{"environment":"production"}'::jsonb,now())`, [connectionId, id, `seller-${label}`])
  if (status !== 'active') await q(`UPDATE "Workspace" SET status=$2 WHERE id=$1`, [id, status])
  const inB = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: id, actorUserId: null, membershipId: null, roleKeys: [] }, work)
  return {
    id, owner, connectionId, inB,
    product: async (sku: string) => {
      const productId = randomUUID()
      await q(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "totalStock", "updatedAt") VALUES ($1,$2,$3,$3,10,5,now())`, [productId, id, sku])
      return { id: productId, sku }
    },
    ingest: (payload: unknown) => inB(() => service.processOrder(payload, connectionId)),
  }
}
const noticesOf = (type: string, workspaceId: string) => q(`SELECT "userId", title, body, "entityId", meta FROM "Notification" WHERE type=$1 AND "workspaceId"=$2 ORDER BY "userId", "createdAt"`, [type, workspaceId])

/** The writer's own backend, so a lock test waits for THAT transaction, not a post-commit hook of an earlier write. */
async function writeWithPid(payload: unknown, connectionId: string) {
  const { normalizeEbayOrder, writeEbayOrderInTx } = await import('./ebay-order-writer.js')
  let resolvePid!: (pid: number) => void
  const pid = new Promise<number>(resolve => { resolvePid = resolve })
  const done = inW(() => database.client.$transaction(async tx => {
    const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
    resolvePid(Number(row.pid))
    return writeEbayOrderInTx(tx, { order: normalizeEbayOrder(payload), connectionId, actor: 'ebay-orders-sync' })
  }, { isolationLevel: 'ReadCommitted' }))
  done.catch(() => undefined)
  return { pid: await pid, done }
}
/** The writer is waiting on a lock. (A post-commit hook of the earlier write may queue on the same row
 *  first, so the lock holder can block the writer through it: any blocker counts.) */
async function waitUntilWaiting(pid: number): Promise<boolean> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const [row] = await q<{ blocked: boolean }>('SELECT cardinality(pg_blocking_pids($1::int)) > 0 AS blocked', [pid])
    if (row.blocked) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return false
}

/** True once `count` sessions wait behind the holder's locks; false after `ms` (an assertion, never a test timeout). */
async function waitersBehind(holderPid: number, count: number, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const [row] = await q<{ n: number }>('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [holderPid])
    if (row.n >= count) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return false
}

describe.skipIf(!serverUrl)('transactional eBay order writer on real PostgreSQL', () => {
  beforeAll(async () => {
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    database = await concurrentDatabase({ maxConnections: 24 })
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_available_invariant" CHECK ("available" = "quantity" - "reserved")`)
    await q(`CREATE UNIQUE INDEX "StockLevel_loc_prod_novar_unique" ON "StockLevel" ("workspaceId", "locationId", "productId") WHERE "variationId" IS NULL`)
    const role = randomUUID()
    ownerRole = role
    await q(`INSERT INTO "Role" (id, key, name, "isSystem", "updatedAt") VALUES ($1,'OWNER','Owner',true,now())`, [role])
    for (const userId of owners) {
      const membership = randomUUID()
      await q(`INSERT INTO "UserProfile" (id, email, status, "updatedAt") VALUES ($1,$2,'active',now())`, [userId, `${userId}@example.test`])
      await q(`INSERT INTO "WorkspaceMembership" (id, "workspaceId", "userId", status, "updatedAt") VALUES ($1,$2,$3,'active',now())`, [membership, W, userId])
      await q(`INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)`, [membership, role])
    }
    const warehouse = randomUUID()
    await q(`INSERT INTO "Warehouse" (id, "workspaceId", code, name, country, "isDefault", "updatedAt") VALUES ($1,$2,'W-MAIN','Main','IT',true,now())`, [warehouse, W])
    locationId = randomUUID()
    await q(`INSERT INTO "StockLocation" (id, "workspaceId", type, code, name, "warehouseId", "updatedAt") VALUES ($1,$2,'WAREHOUSE','W-MAIN','Main',$3,now())`, [locationId, W, warehouse])
    // Two rows of seller X (the live one and an older row of the same seller) and one of seller Y.
    for (const [key, seller, active] of [['x', 'seller-x', true], ['xSibling', 'seller-x', false], ['y', 'seller-y', true]] as const) {
      conn[key] = randomUUID()
      await q(`INSERT INTO "ChannelConnection" (id, "workspaceId", "channelType", "managedBy", "externalAccountId", "isActive", "connectionMetadata", "updatedAt") VALUES ($1,$2,'EBAY','oauth',$3,$4,'{"environment":"production"}'::jsonb,now())`, [conn[key], W, seller, active])
    }
    const { EbayOrdersService } = await import('./ebay-orders.service.js')
    service = new EbayOrdersService() as unknown as typeof service
  }, 180_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  }, 60_000)

  it('writes the order, its lines and one movement per line together; a re-run changes nothing', async () => {
    const a = await product('ATOMIC-A', 10), b = await product('ATOMIC-B', 10)
    const payload = ebayOrder('ATOMIC-1', [{ sku: a.sku, quantity: 2 }, { sku: b.sku, quantity: 1 }])
    await ingest(payload, conn.x)
    await ingest(payload, conn.x)
    const [order] = await orderRows('ATOMIC-1')
    expect(await orderRows('ATOMIC-1')).toHaveLength(1)
    expect(order.channelConnectionId).toBe(conn.x)
    expect(order.ebayMetadata.buyer).toEqual({ username: 'Buyer.Name_01' })
    expect((await itemRows('ATOMIC-1')).map(row => [row.externalLineItemId, row.quantity])).toEqual([['ATOMIC-1-L1', 2], ['ATOMIC-1-L2', 1]])
    expect(await movementRows('ATOMIC-1')).toEqual([{ productId: a.id, change: -2, reason: 'ORDER_PLACED' }, { productId: b.id, change: -1, reason: 'ORDER_PLACED' }].sort((x, y) => x.productId.localeCompare(y.productId)))
    expect([await levelOf(a.id), await levelOf(b.id)]).toEqual([8, 9])
    expect(await effects('ATOMIC-1')).toEqual({ 'ATOMIC-1-L1': 'own_movement', 'ATOMIC-1-L2': 'own_movement' })
  })

  // R5 (review 2026-09-26) — an order with parts eBay sent unreadable is still a sale: it is recorded
  // with its readable lines, the unreadable parts are kept on the order as its disposition, and the
  // owners are told once. Before, one bad line refused the whole order and every line with it.
  it('R5: records an order with unreadable parts: readable lines and their stock, a disposition, one notice; a complete read later fills it in', async () => {
    const a = await product('UNREAD-A', 10), b = await product('UNREAD-B', 10)
    const id = `UNREAD-${randomUUID().slice(0, 6)}`
    const good = { lineItemId: `${id}-L1`, sku: a.sku, title: 'Readable', quantity: 1, lineItemCost: { value: '10.00', currency: 'EUR' } }
    const unreadable = {
      ...ebayOrder(id, []), creationDate: 'yesterday', pricingSummary: { total: { value: 'abc', currency: 'EUR' } },
      lineItems: [
        good,
        { lineItemId: '', sku: b.sku, quantity: 1, lineItemCost: { value: '5.00', currency: 'EUR' } },
        { lineItemId: `${id}-L1`, sku: b.sku, quantity: 3, lineItemCost: { value: '5.00', currency: 'EUR' } },
        { lineItemId: `${id}-L4`, sku: b.sku, quantity: 1.5, lineItemCost: { value: '5.00', currency: 'EUR' } },
        { lineItemId: `${id}-L5`, sku: b.sku, quantity: 2, lineItemCost: { value: 'x', currency: 'EUR' } },
      ],
    }
    await ingest(unreadable, conn.x)
    // Timestamps are read as text: the pg driver would read the UTC column as local time.
    const [order] = await q<{ id: string; totalPrice: string; purchaseDate: string; problems: unknown }>(`SELECT id, "totalPrice"::text AS "totalPrice", "purchaseDate"::text AS "purchaseDate", "ebayMetadata"->'problems' AS problems FROM "Order" WHERE "channelOrderId"=$1`, [id])
    expect(Number(order.totalPrice)).toBe(0)
    expect(order.problems).toEqual([
      { field: 'creation_date' }, { field: 'total' },
      { field: 'line_item_id', index: 1, lineItemId: null, sku: b.sku },
      { field: 'duplicate_line_item', index: 2, lineItemId: `${id}-L1`, sku: b.sku },
      { field: 'quantity', index: 3, lineItemId: `${id}-L4`, sku: b.sku },
      { field: 'line_cost', index: 4, lineItemId: `${id}-L5`, sku: b.sku },
    ])
    expect((await itemRows(id)).map(row => [row.externalLineItemId, row.productId, row.quantity, row.ebayMetadata.stockEffect])).toEqual([[`${id}-L1`, a.id, 1, 'own_movement']])
    expect(await movementRows(id)).toEqual([{ productId: a.id, change: -1, reason: 'ORDER_PLACED' }])
    expect([await levelOf(a.id), await levelOf(b.id)]).toEqual([9, 10])
    const notices = () => q<{ userId: string; title: string; body: string; severity: string }>(`SELECT "userId", title, body, severity FROM "Notification" WHERE type='channel-order-unreadable' AND "entityId"=$1 ORDER BY "userId"`, [order.id])
    expect((await notices()).map(n => n.userId)).toEqual([...owners].sort())
    expect((await notices())[0]).toMatchObject({ severity: 'danger', title: 'An eBay order was recorded, but parts of it could not be read' })
    expect((await notices())[0].body).toMatch(/Nothing was taken from stock for the lines that could not be read/)
    expect((await notices())[0].body).not.toMatch(/adjust|by hand/i)
    // The same read again: nothing new, the first read time stays the purchase date.
    await ingest(unreadable, conn.x)
    expect(await notices()).toHaveLength(owners.length)
    expect(await movementRows(id)).toEqual([{ productId: a.id, change: -1, reason: 'ORDER_PLACED' }])
    const [again] = await q<{ purchaseDate: string }>(`SELECT "purchaseDate"::text AS "purchaseDate" FROM "Order" WHERE id=$1`, [order.id])
    expect(again.purchaseDate).toBe(order.purchaseDate)
    // eBay later sends it complete: the missing line is recorded and takes its stock, once; the disposition clears.
    const complete = ebayOrder(id, [])
    complete.lineItems = [good, { lineItemId: `${id}-L5`, sku: b.sku, title: 'Later', quantity: 2, lineItemCost: { value: '5.00', currency: 'EUR' } }]
    await ingest(complete, conn.x)
    await ingest(complete, conn.x)
    const [filled] = await q<{ totalPrice: string; purchaseDate: string; problems: unknown }>(`SELECT "totalPrice"::text AS "totalPrice", "purchaseDate"::text AS "purchaseDate", "ebayMetadata"->'problems' AS problems FROM "Order" WHERE id=$1`, [order.id])
    expect([Number(filled.totalPrice), filled.purchaseDate, filled.problems]).toEqual([20, '2026-09-23 10:00:00', null])
    expect((await itemRows(id)).map(row => [row.externalLineItemId, row.quantity, row.ebayMetadata.stockEffect])).toEqual([[`${id}-L1`, 1, 'own_movement'], [`${id}-L5`, 2, 'own_movement']])
    expect([await levelOf(a.id), await levelOf(b.id)]).toEqual([9, 8])
    expect(await notices()).toHaveLength(owners.length)
  })

  it('R5: an order whose line list is unreadable is recorded without lines and told once; an order without an id is the one thing refused, and told', async () => {
    const id = `NOLINES-${randomUUID().slice(0, 6)}`
    await ingest({ ...ebayOrder(id, []), lineItems: 'nope' }, conn.x)
    const [order] = await q<{ id: string; problems: unknown }>(`SELECT id, "ebayMetadata"->'problems' AS problems FROM "Order" WHERE "channelOrderId"=$1`, [id])
    expect(order.problems).toEqual([{ field: 'line_items' }])
    expect(await itemRows(id)).toEqual([])
    expect(await q(`SELECT severity FROM "Notification" WHERE type='channel-order-unreadable' AND "entityId"=$1`, [order.id])).toEqual(owners.map(() => ({ severity: 'danger' })))
    const before = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM "Order"`))[0].n
    await expect(ingest({ ...ebayOrder('x', [{ sku: 'none', quantity: 1 }]), orderId: ' padded' }, conn.x)).rejects.toMatchObject({ name: 'EbayOrderInvalid', reason: 'order_id' })
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM "Order"`))[0].n).toBe(before)
    expect(await q(`SELECT 1 FROM "Notification" WHERE type='channel-order-ingest-failed' AND meta->>'errorClass'='EbayOrderInvalid:order_id'`)).toHaveLength(owners.length)
  })

  it('commits nothing when a stock movement fails, and deducts exactly once after the failure is gone', async () => {
    const a = await product('MOVE-FAIL', 10)
    await q(`CREATE FUNCTION test_fail_movement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."productId" = '${a.id}' THEN RAISE EXCEPTION 'injected stock movement failure'; END IF; RETURN NEW; END $$`)
    await q(`CREATE TRIGGER test_fail_movement BEFORE INSERT ON "StockMovement" FOR EACH ROW EXECUTE FUNCTION test_fail_movement()`)
    const payload = ebayOrder('MOVE-FAIL-1', [{ sku: a.sku, quantity: 3 }])
    const failed = () => q(`SELECT "userId", title, body FROM "Notification" WHERE type='channel-order-ingest-failed' AND meta->>'channelOrderId'='MOVE-FAIL-1' ORDER BY "userId"`)
    try {
      await expect(ingest(payload, conn.x)).rejects.toThrow(/injected stock movement failure/)
      expect(await orderRows('MOVE-FAIL-1')).toEqual([])
      expect(await itemRows('MOVE-FAIL-1')).toEqual([])
      expect(await movementRows('MOVE-FAIL-1')).toEqual([])
      expect(await levelOf(a.id)).toBe(10)
      // Told once, outside the failed transaction; the next failing poll does not repeat it.
      expect((await failed()).map(n => n.userId)).toEqual([...owners].sort())
      await expect(ingest(payload, conn.x)).rejects.toThrow(/injected stock movement failure/)
      expect(await failed()).toHaveLength(owners.length)
      expect((await failed())[0].body).toContain('MOVE-FAIL-1')
      expect(JSON.stringify(await failed())).not.toMatch(/injected stock movement failure|Buyer\.Name_01/)
    } finally {
      await q('DROP TRIGGER IF EXISTS test_fail_movement ON "StockMovement"')
      await q('DROP FUNCTION IF EXISTS test_fail_movement()')
    }
    await ingest(payload, conn.x)
    await ingest(payload, conn.x)
    expect(await orderRows('MOVE-FAIL-1')).toHaveLength(1)
    expect(await movementRows('MOVE-FAIL-1')).toEqual([{ productId: a.id, change: -3, reason: 'ORDER_PLACED' }])
    expect(await levelOf(a.id)).toBe(7)
  })

  it('a transient serialization failure rolls back and alerts nobody', async () => {
    const a = await product('TRANSIENT', 4)
    await q(`CREATE FUNCTION test_transient_movement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."productId" = '${a.id}' THEN RAISE EXCEPTION 'injected serialization failure' USING ERRCODE = '40001'; END IF; RETURN NEW; END $$`)
    await q(`CREATE TRIGGER test_transient_movement BEFORE INSERT ON "StockMovement" FOR EACH ROW EXECUTE FUNCTION test_transient_movement()`)
    try {
      await expect(ingest(ebayOrder('TRANSIENT-1', [{ sku: a.sku, quantity: 1 }]), conn.x)).rejects.toThrow()
      expect(await orderRows('TRANSIENT-1')).toEqual([])
      expect(await q(`SELECT 1 FROM "Notification" WHERE type='channel-order-ingest-failed' AND meta->>'channelOrderId'='TRANSIENT-1'`)).toEqual([])
    } finally {
      await q('DROP TRIGGER IF EXISTS test_transient_movement ON "StockMovement"')
      await q('DROP FUNCTION IF EXISTS test_transient_movement()')
    }
  })

  it('commits nothing when the second line fails to insert; the retry deducts both lines', async () => {
    const a = await product('LINE2-A', 10), b = await product('LINE2-B', 10)
    await q(`CREATE FUNCTION test_fail_line() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."externalLineItemId" = 'LINE2-1-L2' THEN RAISE EXCEPTION 'injected line failure'; END IF; RETURN NEW; END $$`)
    await q(`CREATE TRIGGER test_fail_line BEFORE INSERT ON "OrderItem" FOR EACH ROW EXECUTE FUNCTION test_fail_line()`)
    const payload = ebayOrder('LINE2-1', [{ sku: a.sku, quantity: 1 }, { sku: b.sku, quantity: 2 }])
    try {
      await expect(ingest(payload, conn.x)).rejects.toThrow(/injected line failure/)
      expect(await orderRows('LINE2-1')).toEqual([])
      expect(await itemRows('LINE2-1')).toEqual([])
      expect(await movementRows('LINE2-1')).toEqual([])
      expect([await levelOf(a.id), await levelOf(b.id)]).toEqual([10, 10])
    } finally {
      await q('DROP TRIGGER IF EXISTS test_fail_line ON "OrderItem"')
      await q('DROP FUNCTION IF EXISTS test_fail_line()')
    }
    await ingest(payload, conn.x)
    expect((await itemRows('LINE2-1')).map(row => row.externalLineItemId)).toEqual(['LINE2-1-L1', 'LINE2-1-L2'])
    expect([await levelOf(a.id), await levelOf(b.id)]).toEqual([9, 8])
    expect(await movementRows('LINE2-1')).toHaveLength(2)
  })

  it('records a sale larger than own stock with its shortfall and one owner notice, once', async () => {
    const short = await product('SHORT', 1), fine = await product('SHORT-OK', 5)
    const payload = ebayOrder('SHORT-1', [{ sku: short.sku, quantity: 3 }, { sku: fine.sku, quantity: 2 }])
    await ingest(payload, conn.x)
    await ingest(payload, conn.x)
    const [order] = await orderRows('SHORT-1')
    expect(order).toBeTruthy()
    expect(await effects('SHORT-1')).toEqual({ 'SHORT-1-L1': 'shortfall', 'SHORT-1-L2': 'own_movement' })
    expect(await movementRows('SHORT-1')).toEqual([{ productId: fine.id, change: -2, reason: 'ORDER_PLACED' }])
    expect([await levelOf(short.id), await levelOf(fine.id)]).toEqual([1, 3])
    const notices = await shortfallNotices(order.id)
    expect(notices.map(n => n.userId)).toEqual([...owners].sort())
    for (const notice of notices) {
      expect(notice.severity).toBe('danger')
      expect(notice.title).toContain(short.sku)
      expect(notice.body).toContain('1 in stock at W-MAIN')
      expect(`${notice.title} ${notice.body}`).not.toMatch(/Buyer\.Name_01|@/)
    }
  })

  it('five concurrent writers of one order: one order, each line once, each movement once, no unique-key error', async () => {
    const a = await product('RACE-A', 20), b = await product('RACE-B', 20)
    const payload = ebayOrder('RACE-1', [{ sku: a.sku, quantity: 2 }, { sku: b.sku, quantity: 3 }])
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => ingest(payload, conn.x)))
    expect(outcomes.filter(o => o.status === 'rejected').map(o => String((o as PromiseRejectedResult).reason))).toEqual([])
    expect(await orderRows('RACE-1')).toHaveLength(1)
    expect((await itemRows('RACE-1')).map(row => row.externalLineItemId)).toEqual(['RACE-1-L1', 'RACE-1-L2'])
    expect(await movementRows('RACE-1')).toHaveLength(2)
    expect([await levelOf(a.id), await levelOf(b.id)]).toEqual([18, 17])
  })

  it('refuses an order linked to a different seller with zero changes, and accepts a sibling row of the same seller', async () => {
    const a = await product('ATTR-A', 10), b = await product('ATTR-B', 10)
    await ingest(ebayOrder('ATTR-1', [{ sku: a.sku, quantity: 1 }]), conn.x)
    const before = { order: await orderRows('ATTR-1'), items: await itemRows('ATTR-1'), moves: await movementRows('ATTR-1') }
    const changed = ebayOrder('ATTR-1', [{ sku: a.sku, quantity: 1 }, { sku: b.sku, quantity: 2 }], { orderFulfillmentStatus: 'FULFILLED', buyer: { username: 'someone-else' } })
    await expect(ingest(changed, conn.y)).rejects.toMatchObject({ name: 'EbayOrderAttributionConflict' })
    expect({ order: await orderRows('ATTR-1'), items: await itemRows('ATTR-1'), moves: await movementRows('ATTR-1') }).toEqual(before)
    expect(await levelOf(b.id)).toBe(10)
    await ingest(ebayOrder('ATTR-1', [{ sku: a.sku, quantity: 1 }, { sku: b.sku, quantity: 2 }]), conn.xSibling)
    const [order] = await orderRows('ATTR-1')
    expect(order.channelConnectionId).toBe(conn.x)
    expect((await itemRows('ATTR-1')).map(row => row.externalLineItemId)).toEqual(['ATTR-1-L1', 'ATTR-1-L2'])
    expect([await levelOf(a.id), await levelOf(b.id)]).toEqual([9, 8])
  })

  it('an order that arrives cancelled records its lines and takes no stock', async () => {
    const a = await product('ARRIVED-CANCELLED', 4)
    await ingest(ebayOrder('CANCEL-1', [{ sku: a.sku, quantity: 2 }], { cancelStatus: { cancelState: 'CANCELED' } }), conn.x)
    expect((await orderRows('CANCEL-1')).map(row => row.status)).toEqual(['CANCELLED'])
    expect(await effects('CANCEL-1')).toEqual({ 'CANCEL-1-L1': 'arrived_cancelled' })
    expect(await movementRows('CANCEL-1')).toEqual([])
    expect(await levelOf(a.id)).toBe(4)
  })

  it('waits for a concurrent local change to the order, then keeps its cancellation', async () => {
    const a = await product('ROWLOCK-A', 5), b = await product('ROWLOCK-B', 5)
    await ingest(ebayOrder('ROWLOCK-1', [{ sku: a.sku, quantity: 1 }]), conn.x)
    const [order] = await orderRows('ROWLOCK-1')
    expect(order.status).toBe('PROCESSING')
    const client = await database.pool.connect()
    let pending: Promise<unknown> | null = null
    try {
      await client.query('BEGIN')
      await client.query(`UPDATE "Order" SET status='CANCELLED', "cancelledAt"=now() WHERE id=$1`, [order.id])
      const writer = await writeWithPid(ebayOrder('ROWLOCK-1', [{ sku: a.sku, quantity: 1 }, { sku: b.sku, quantity: 1 }]), conn.x)
      pending = writer.done
      expect(await waitUntilWaiting(writer.pid)).toBe(true)
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    await pending
    expect((await orderRows('ROWLOCK-1')).map(row => row.status)).toEqual(['CANCELLED'])
    expect(await effects('ROWLOCK-1')).toEqual({ 'ROWLOCK-1-L1': 'own_movement', 'ROWLOCK-1-L2': 'arrived_cancelled' })
    expect(await levelOf(b.id)).toBe(5)
  })

  it('records a sale whose stock has two default warehouses: lines kept, stock_blocked, one notice, re-run changes nothing', async () => {
    const b = await business('twodefaults', [{ code: 'A-MAIN', isDefault: true }, { code: 'B-MAIN', isDefault: true }])
    const p = await b.product('TWO-DEFAULTS')
    const payload = ebayOrder('BLOCK-2DEF', [{ sku: p.sku, quantity: 2 }])
    await b.ingest(payload)
    await b.ingest(payload)
    const [order] = await orderRows('BLOCK-2DEF')
    expect(order).toMatchObject({ status: 'PROCESSING', channelConnectionId: b.connectionId })
    expect((await itemRows('BLOCK-2DEF')).map(row => [row.externalLineItemId, row.ebayMetadata.stockEffect, row.ebayMetadata.stockBlockedCode])).toEqual([['BLOCK-2DEF-L1', 'stock_blocked', 'default_location_ambiguous']])
    expect(await movementRows('BLOCK-2DEF')).toEqual([])
    const notices = await noticesOf('channel-order-stock-blocked', b.id)
    expect(notices.map(n => [n.userId, n.entityId])).toEqual([[b.owner, order.id]])
    expect(notices[0].body).toMatch(/Choose one default warehouse/)
  })

  it.each([
    ['no warehouse at all', []],
    ['a deactivated default beside two others', [{ code: 'X-MAIN', isDefault: true, isActive: false }, { code: 'X-2' }, { code: 'X-3' }]],
    ['a non-Italian profile with several warehouses and no IT-MAIN', [{ code: 'DE-MAIN', country: 'DE' }, { code: 'DE-2', country: 'DE' }]],
  ])('records a sale whose stock has no default warehouse (%s) as stock_blocked, once', async (label, warehouses) => {
    const b = await business(label.split(' ')[1], warehouses as never)
    const p = await b.product(`MISSING-${randomUUID().slice(0, 6)}`)
    const orderId = `BLOCK-MISSING-${randomUUID().slice(0, 6)}`
    await b.ingest(ebayOrder(orderId, [{ sku: p.sku, quantity: 1 }, { sku: p.sku, quantity: 2, lineItemId: `${orderId}-SECOND` }]))
    await b.ingest(ebayOrder(orderId, [{ sku: p.sku, quantity: 1 }, { sku: p.sku, quantity: 2, lineItemId: `${orderId}-SECOND` }]))
    expect((await itemRows(orderId)).map(row => [row.ebayMetadata.stockEffect, row.ebayMetadata.stockBlockedCode])).toEqual([
      ['stock_blocked', 'default_location_missing'], ['stock_blocked', 'default_location_missing']])
    expect(await movementRows(orderId)).toEqual([])
    const notices = await noticesOf('channel-order-stock-blocked', b.id)
    expect(notices).toHaveLength(1)
    expect(notices[0].body).toMatch(/Choose a default warehouse/)
  })

  // R6 — a stock_blocked line is not a job for the owner's hands: a manual adjustment carries no order,
  // so a cancellation could never give it back and any later repair would deduct it twice. Once the
  // configuration resolves, the next read of the order takes the line itself, exactly once.
  it('R6: a stock_blocked line is taken by a later read once the default warehouse is fixed, exactly once, and a cancellation gives it back', async () => {
    const b = await business('r6fix', [{ code: 'R6-A', isDefault: true }, { code: 'R6-B', isDefault: true }])
    const p = await b.product(`R6-${randomUUID().slice(0, 6)}`)
    const orderId = `R6-FIX-${randomUUID().slice(0, 6)}`
    const payload = ebayOrder(orderId, [{ sku: p.sku, quantity: 2 }])
    await b.ingest(payload)
    expect((await itemRows(orderId)).map(row => row.ebayMetadata.stockEffect)).toEqual(['stock_blocked'])
    const notices = await noticesOf('channel-order-stock-blocked', b.id)
    expect(notices).toHaveLength(1)
    expect(notices[0].body).not.toMatch(/adjust the stock/i)
    expect(notices[0].body).toMatch(/takes the stock for this order automatically/)
    // The owner fixes the configuration; stock is there.
    const [a] = await q<{ id: string }>(`SELECT sl.id FROM "StockLocation" sl JOIN "Warehouse" w ON w.id=sl."warehouseId" WHERE w."workspaceId"=$1 AND w.code='R6-A'`, [b.id])
    await q(`UPDATE "Warehouse" SET "isDefault"=false WHERE "workspaceId"=$1 AND code='R6-B'`, [b.id])
    await q(`INSERT INTO "StockLevel" (id,"workspaceId","locationId","productId",quantity,reserved,available,"lastUpdatedAt") VALUES ($1,$2,$3,$4,5,0,5,now())`, [randomUUID(), b.id, a.id, p.id])
    await Promise.all([b.ingest(payload), b.ingest(payload), b.ingest(payload)])
    await b.ingest(payload)
    expect((await itemRows(orderId)).map(row => [row.ebayMetadata.stockEffect, row.ebayMetadata.stockRetriedFrom ?? null, row.ebayMetadata.stockBlockedCode ?? null])).toEqual([['own_movement', 'stock_blocked', null]])
    expect(await movementRows(orderId)).toEqual([{ productId: p.id, change: -2, reason: 'ORDER_PLACED' }])
    expect(await levelOf(p.id)).toBe(3)
    expect(await noticesOf('channel-order-stock-blocked', b.id)).toHaveLength(1)
    // The take is the order's own: a cancellation before shipment gives it back, once.
    const [order] = await orderRows(orderId)
    const { handleOrderCancelled } = await import('./order-cancellation/index.js')
    await q(`UPDATE "Order" SET status='CANCELLED' WHERE id=$1`, [order.id])
    expect(await b.inB(() => handleOrderCancelled(order.id))).toMatchObject({ itemsRestocked: 1, errors: [] })
    expect(await b.inB(() => handleOrderCancelled(order.id))).toMatchObject({ itemsRestocked: 0, errors: [] })
    expect(await levelOf(p.id)).toBe(5)
  })

  it('R6: a stock_blocked line of an order cancelled before the fix is never taken', async () => {
    const b = await business('r6cancel', [])
    const p = await b.product(`R6C-${randomUUID().slice(0, 6)}`)
    const orderId = `R6-CANCEL-${randomUUID().slice(0, 6)}`
    await b.ingest(ebayOrder(orderId, [{ sku: p.sku, quantity: 1 }]))
    expect((await itemRows(orderId)).map(row => row.ebayMetadata.stockEffect)).toEqual(['stock_blocked'])
    await b.ingest(ebayOrder(orderId, [{ sku: p.sku, quantity: 1 }], { cancelStatus: { cancelState: 'CANCELED' } }))
    const warehouse = randomUUID(), location = randomUUID()
    await q(`INSERT INTO "Warehouse" (id,"workspaceId",code,name,country,"isDefault","updatedAt") VALUES ($1,$2,'R6C-MAIN','Main','IT',true,now())`, [warehouse, b.id])
    await q(`INSERT INTO "StockLocation" (id,"workspaceId",type,code,name,"warehouseId","updatedAt") VALUES ($1,$2,'WAREHOUSE','R6C-MAIN','Main',$3,now())`, [location, b.id, warehouse])
    await q(`INSERT INTO "StockLevel" (id,"workspaceId","locationId","productId",quantity,reserved,available,"lastUpdatedAt") VALUES ($1,$2,$3,$4,5,0,5,now())`, [randomUUID(), b.id, location, p.id])
    await b.ingest(ebayOrder(orderId, [{ sku: p.sku, quantity: 1 }], { cancelStatus: { cancelState: 'CANCELED' } }))
    expect((await itemRows(orderId)).map(row => row.ebayMetadata.stockEffect)).toEqual(['stock_blocked'])
    expect(await movementRows(orderId)).toEqual([])
    expect(await levelOf(p.id)).toBe(5)
  })

  // R6 (review 2026-09-26) — the retry must not depend on eBay's 7-day poll window: an order eBay no
  // longer returns is retried from the database by the scheduled eBay order sync, as the notice says.
  it('R6: the scheduled eBay order sync takes a blocked line from the database although eBay returns no order; a cancelled order is never taken', async () => {
    const b = await business('r6tick', [{ code: 'R6T-A', isDefault: true }, { code: 'R6T-B', isDefault: true }])
    const p = await b.product(`R6T-${randomUUID().slice(0, 6)}`)
    const live = `R6-TICK-${randomUUID().slice(0, 6)}`, cancelled = `R6-TICKC-${randomUUID().slice(0, 6)}`
    await b.ingest(ebayOrder(live, [{ sku: p.sku, quantity: 2 }]))
    await b.ingest(ebayOrder(cancelled, [{ sku: p.sku, quantity: 1 }]))
    await b.ingest(ebayOrder(cancelled, [{ sku: p.sku, quantity: 1 }], { cancelStatus: { cancelState: 'CANCELED' } }))
    const notices = await noticesOf('channel-order-stock-blocked', b.id)
    expect(notices).toHaveLength(2)
    for (const notice of notices) expect(notice.body).toMatch(/the next scheduled eBay order sync takes the stock for this order automatically, however old the order is\. Do not change the stock by hand for it\./)
    const { ebayOrdersService } = await import('./ebay-orders.service.js')
    const { runOrdersPoll } = await import('../jobs/ebay-orders-sync.job.js')
    // eBay returns nothing: the order is outside its window.
    const sync = vi.spyOn(ebayOrdersService, 'syncEbayOrders').mockImplementation(async () => ({ syncId: 'none', status: 'SUCCESS', ordersFetched: 0, ordersCreated: 0, ordersUpdated: 0, itemsProcessed: 0, itemsLinked: 0, inventoryDeducted: 0, errors: [], startedAt: new Date(), completedAt: new Date() }))
    try {
      // Still blocked: the tick leaves the line as it is and tells nobody again.
      await b.inB(() => runOrdersPoll())
      expect(await effects(live)).toEqual({ [`${live}-L1`]: 'stock_blocked' })
      expect(await movementRows(live)).toEqual([])
      const [a] = await q<{ id: string }>(`SELECT sl.id FROM "StockLocation" sl JOIN "Warehouse" w ON w.id=sl."warehouseId" WHERE w."workspaceId"=$1 AND w.code='R6T-A'`, [b.id])
      await q(`UPDATE "Warehouse" SET "isDefault"=false WHERE "workspaceId"=$1 AND code='R6T-B'`, [b.id])
      await q(`INSERT INTO "StockLevel" (id,"workspaceId","locationId","productId",quantity,reserved,available,"lastUpdatedAt") VALUES ($1,$2,$3,$4,5,0,5,now())`, [randomUUID(), b.id, a.id, p.id])
      await b.inB(() => runOrdersPoll())
      await b.inB(() => runOrdersPoll())
      expect(sync.mock.calls.map(call => call[0])).toEqual([b.connectionId, b.connectionId, b.connectionId])
    } finally { sync.mockRestore() }
    expect((await itemRows(live)).map(row => [row.ebayMetadata.stockEffect, row.ebayMetadata.stockRetriedFrom ?? null, row.ebayMetadata.stockBlockedCode ?? null])).toEqual([['own_movement', 'stock_blocked', null]])
    expect(await movementRows(live)).toEqual([{ productId: p.id, change: -2, reason: 'ORDER_PLACED' }])
    expect(await effects(cancelled)).toEqual({ [`${cancelled}-L1`]: 'stock_blocked' })
    expect(await movementRows(cancelled)).toEqual([])
    expect(await levelOf(p.id)).toBe(3)
    expect(await noticesOf('channel-order-stock-blocked', b.id)).toHaveLength(2)
  })

  // R6 — the database sweep and a read of the same order both retry a blocked line. Forced: a gate
  // holds the order's identity lock until both have queued behind it in the named order; the sweep's
  // own report records which of them took the line. Exactly one take either way.
  it.each([['sweep first', 'sweep'], ['read first', 'read']] as const)('R6: the database sweep and a read of one order take a blocked line exactly once (%s, forced)', async (_label, first) => {
    const b = await business(`r6race${first}`, [{ code: 'R6R-A', isDefault: true }, { code: 'R6R-B', isDefault: true }])
    const p = await b.product(`R6R-${randomUUID().slice(0, 6)}`)
    const orderId = `R6-RACE-${randomUUID().slice(0, 6)}`
    const payload = ebayOrder(orderId, [{ sku: p.sku, quantity: 2 }])
    await b.ingest(payload)
    expect(await effects(orderId)).toEqual({ [`${orderId}-L1`]: 'stock_blocked' })
    const [a] = await q<{ id: string }>(`SELECT sl.id FROM "StockLocation" sl JOIN "Warehouse" w ON w.id=sl."warehouseId" WHERE w."workspaceId"=$1 AND w.code='R6R-A'`, [b.id])
    await q(`UPDATE "Warehouse" SET "isDefault"=false WHERE "workspaceId"=$1 AND code='R6R-B'`, [b.id])
    await q(`INSERT INTO "StockLevel" (id,"workspaceId","locationId","productId",quantity,reserved,available,"lastUpdatedAt") VALUES ($1,$2,$3,$4,5,0,5,now())`, [randomUUID(), b.id, a.id, p.id])
    const { retryBlockedEbayLines } = await import('./ebay-order-writer.js')
    const gate = await database.pool.connect()
    let swept: { resolved: number } | undefined
    try {
      await gate.query('BEGIN')
      await gate.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(['nexus-ebay-order', b.id, orderId])])
      const [{ pid }] = (await gate.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows
      const queued = (count: number) => waitersBehind(pid, count)
      const sweep = () => b.inB(() => retryBlockedEbayLines()).then(result => { swept = result })
      const read = () => b.ingest(payload)
      const one = first === 'sweep' ? sweep() : read()
      expect(await queued(1)).toBe(true)
      const two = first === 'sweep' ? read() : sweep()
      expect(await queued(2)).toBe(true)
      await gate.query('COMMIT')
      await Promise.all([one, two])
    } finally {
      // Never hand a connection with an open transaction back to the pool: later fixtures would run inside it.
      await gate.query('ROLLBACK').catch(() => undefined)
      gate.release()
    }
    // The interleaving that ran, from the sweep's own report: first through the gate takes the line.
    expect(swept).toMatchObject({ resolved: first === 'sweep' ? 1 : 0, stillBlocked: 0, failed: 0 })
    expect((await itemRows(orderId)).map(row => [row.ebayMetadata.stockEffect, row.ebayMetadata.stockRetriedFrom ?? null])).toEqual([['own_movement', 'stock_blocked']])
    expect(await movementRows(orderId)).toEqual([{ productId: p.id, change: -2, reason: 'ORDER_PLACED' }])
    expect(await levelOf(p.id)).toBe(3)
    expect(await noticesOf('channel-order-stock-blocked', b.id)).toHaveLength(1)
  }, 30_000)

  // R6 — the sweep lists an order, then waits for its lock; the order is cancelled meanwhile. Under the
  // lock the sweep reads it again and takes nothing: a cancelled order took nothing and owes nothing.
  it('R6: an order cancelled while the database sweep waits for its lock is not taken (forced)', async () => {
    const b = await business('r6late', [{ code: 'R6L-A', isDefault: true }, { code: 'R6L-B', isDefault: true }])
    const p = await b.product(`R6L-${randomUUID().slice(0, 6)}`)
    const orderId = `R6-LATE-${randomUUID().slice(0, 6)}`
    await b.ingest(ebayOrder(orderId, [{ sku: p.sku, quantity: 2 }]))
    const [a] = await q<{ id: string }>(`SELECT sl.id FROM "StockLocation" sl JOIN "Warehouse" w ON w.id=sl."warehouseId" WHERE w."workspaceId"=$1 AND w.code='R6L-A'`, [b.id])
    await q(`UPDATE "Warehouse" SET "isDefault"=false WHERE "workspaceId"=$1 AND code='R6L-B'`, [b.id])
    await q(`INSERT INTO "StockLevel" (id,"workspaceId","locationId","productId",quantity,reserved,available,"lastUpdatedAt") VALUES ($1,$2,$3,$4,5,0,5,now())`, [randomUUID(), b.id, a.id, p.id])
    const { retryBlockedEbayLines } = await import('./ebay-order-writer.js')
    const gate = await database.pool.connect()
    let swept: unknown
    try {
      await gate.query('BEGIN')
      await gate.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(['nexus-ebay-order', b.id, orderId])])
      const [{ pid }] = (await gate.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows
      const sweep = b.inB(() => retryBlockedEbayLines()).then(result => { swept = result })
      sweep.catch(() => undefined)
      expect(await waitersBehind(pid, 1)).toBe(true)
      await gate.query(`UPDATE "Order" SET status='CANCELLED' WHERE "workspaceId"=$1 AND channel='EBAY' AND "channelOrderId"=$2`, [b.id, orderId])
      await gate.query('COMMIT')
      await sweep
    } finally {
      await gate.query('ROLLBACK').catch(() => undefined)
      gate.release()
    }
    expect(swept).toEqual({ orders: 1, resolved: 0, stillBlocked: 0, failed: 0 })
    expect(await effects(orderId)).toEqual({ [`${orderId}-L1`]: 'stock_blocked' })
    expect(await movementRows(orderId)).toEqual([])
    expect(await levelOf(p.id)).toBe(5)
  }, 30_000)

  it('records a sale the own-stock guard refuses as pooled (PooledProductError) as stock_blocked, once', async () => {
    const a = await product('GUARD-POOLED', 5)
    await q('ALTER FUNCTION nexus_pool_available(text[]) RENAME TO nexus_pool_available_real')
    await q(`CREATE FUNCTION nexus_pool_available(product_ids text[]) RETURNS TABLE (product_id text, grant_id text, owner_workspace_id text, location_id text, location_code text, quantity integer, reserved integer, available integer)
      LANGUAGE sql AS $$ SELECT * FROM nexus_pool_available_real(product_ids) UNION ALL SELECT '${a.id}', 'g', 'o', 'l', 'L', 1, 0, 1 WHERE '${a.id}' = ANY(product_ids) $$`)
    try {
      await ingest(ebayOrder('GUARD-1', [{ sku: a.sku, quantity: 1 }]), conn.x)
      await ingest(ebayOrder('GUARD-1', [{ sku: a.sku, quantity: 1 }]), conn.x)
    } finally {
      await q('DROP FUNCTION IF EXISTS nexus_pool_available(text[])')
      await q('ALTER FUNCTION nexus_pool_available_real(text[]) RENAME TO nexus_pool_available')
    }
    const [order] = await orderRows('GUARD-1')
    expect((await itemRows('GUARD-1')).map(row => [row.ebayMetadata.stockEffect, row.ebayMetadata.stockBlockedCode])).toEqual([['stock_blocked', 'pooled_product']])
    expect(await movementRows('GUARD-1')).toEqual([])
    expect(await levelOf(a.id)).toBe(5)
    expect(await q(`SELECT "userId" FROM "Notification" WHERE type='channel-order-stock-blocked' AND "entityId"=$1 ORDER BY "userId"`, [order.id])).toEqual([...owners].sort().map(userId => ({ userId })))
  })

  it('an inactive business records nothing (the database refuses every write there) and says so', async () => {
    const b = await business('inactive', [{ code: 'I-MAIN', isDefault: true }], 'suspended')
    const p = await b.product('INACTIVE')
    await expect(b.ingest(ebayOrder('INACTIVE-1', [{ sku: p.sku, quantity: 1 }]))).rejects.toMatchObject({ name: 'EbayOrderBusinessInactive' })
    expect(await orderRows('INACTIVE-1')).toEqual([])
    expect(await q(`SELECT 1 FROM "Notification" WHERE "workspaceId"=$1`, [b.id])).toEqual([])
  })

  it('uses only its own transaction: no global database client inside the domain phase', async () => {
    const { normalizeEbayOrder, writeEbayOrderInTx, afterEbayOrderCommit } = await import('./ebay-order-writer.js')
    const a = await product('TX-ONLY', 5), empty = await product('TX-ONLY-EMPTY', 0)
    const order = normalizeEbayOrder(ebayOrder('TX-ONLY-1', [{ sku: a.sku, quantity: 1 }, { sku: empty.sku, quantity: 1 }, { sku: 'TX-ONLY-UNKNOWN', quantity: 1 }]))
    const result = await inW(() => database.client.$transaction(
      tx => insideDomain.run(true, () => writeEbayOrderInTx(tx, { order, connectionId: conn.x, actor: 'ebay-orders-sync' })),
      { isolationLevel: 'ReadCommitted' }))
    expect(result.lines.map(line => line.stockEffect)).toEqual(['own_movement', 'shortfall', 'unlinked'])
    await inW(() => afterEbayOrderCommit(result))
    expect(await levelOf(a.id)).toBe(4)
    expect(await shortfallNotices(result.order.id)).toHaveLength(owners.length)
  })

  it('a poll queues behind a replay that holds the account, instead of deadlocking on the order it waits for', async () => {
    const a = await product('LOCK-ORDER', 5)
    const client = await database.pool.connect()
    let pending: Promise<unknown> | null = null
    try {
      // What commitEbayInbound holds for a replay of this account: its row, FOR UPDATE; then the writer's order lock.
      await client.query('BEGIN')
      await client.query(`SELECT id FROM "ChannelConnection" WHERE id=$1 FOR UPDATE`, [conn.x])
      const writer = await writeWithPid(ebayOrder('LOCK-ORDER-1', [{ sku: a.sku, quantity: 1 }]), conn.x)
      pending = writer.done
      expect(await waitUntilWaiting(writer.pid)).toBe(true)
      await client.query(`SET LOCAL lock_timeout = '3s'`)
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [JSON.stringify(['nexus-ebay-order', W, 'LOCK-ORDER-1'])])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    await pending
    expect(await movementRows('LOCK-ORDER-1')).toEqual([{ productId: a.id, change: -1, reason: 'ORDER_PLACED' }])
  })

  it('updates, without relinking, an order linked to an account row with no seller identity, and tells the owners once', async () => {
    const a = await product('LEGACY-LINK', 5), b = await product('LEGACY-LINK-B', 5)
    const legacy = randomUUID()
    await q(`INSERT INTO "ChannelConnection" (id, "workspaceId", "channelType", "managedBy", "isActive", "updatedAt") VALUES ($1,$2,'EBAY','oauth',false,now())`, [legacy, W])
    await ingest(ebayOrder('LEGACY-1', [{ sku: a.sku, quantity: 1 }]), legacy)
    const later = ebayOrder('LEGACY-1', [{ sku: a.sku, quantity: 1 }, { sku: b.sku, quantity: 1 }], { orderFulfillmentStatus: 'FULFILLED' })
    await ingest(later, conn.x)
    await ingest(later, conn.x)
    const [order] = await orderRows('LEGACY-1')
    expect(order).toMatchObject({ status: 'DELIVERED', channelConnectionId: legacy })
    expect((await itemRows('LEGACY-1')).map(row => row.externalLineItemId)).toEqual(['LEGACY-1-L1', 'LEGACY-1-L2'])
    expect([await levelOf(a.id), await levelOf(b.id)]).toEqual([4, 4])
    const told = await q(`SELECT "userId", body FROM "Notification" WHERE type='channel-order-attribution-unverified' AND "entityId"=$1 ORDER BY "userId"`, [order.id])
    expect(told.map(n => n.userId)).toEqual([...owners].sort())
    expect(told[0].body).toContain('LEGACY-1')
  })

  it('links a line through an eBay listing row whose channel is empty only for the importing account', async () => {
    const mine = await product('NULLCH-MINE', 5), other = await product('NULLCH-OTHER', 5)
    for (const [target, account, sku] of [[mine, conn.x, 'NULLCH-SKU-MINE'], [other, conn.y, 'NULLCH-SKU-OTHER']] as const) {
      const variant = randomUUID()
      await q(`INSERT INTO "ProductVariation" (id, "workspaceId", "productId", sku, price, "updatedAt") VALUES ($1,$2,$3,$4,1,now())`, [variant, W, target.id, `${target.sku}-V`])
      await q(`INSERT INTO "VariantChannelListing" (id, "workspaceId", "variantId", "channelConnectionId", "externalSku", "channelPrice") VALUES ($1,$2,$3,$4,$5,1)`, [randomUUID(), W, variant, account, sku])
    }
    await ingest(ebayOrder('NULLCH-1', [{ sku: 'NULLCH-SKU-MINE', quantity: 1 }, { sku: 'NULLCH-SKU-OTHER', quantity: 1 }]), conn.x)
    expect((await itemRows('NULLCH-1')).map(row => [row.externalLineItemId, row.productId])).toEqual([['NULLCH-1-L1', mine.id], ['NULLCH-1-L2', null]])
    expect([await levelOf(mine.id), await levelOf(other.id)]).toEqual([4, 5])
  })

  it('fences explicit eBay listings by seller before the canonical SKU fallback', async () => {
    const mine = await product('ACCOUNT-CANONICAL', 5), other = await product('ACCOUNT-OTHER', 5)
    const variant = randomUUID()
    await q(`INSERT INTO "ProductVariation" (id, "workspaceId", "productId", sku, price, "updatedAt") VALUES ($1,$2,$3,$4,1,now())`, [variant, W, other.id, `${other.sku}-V`])
    await q(`INSERT INTO "VariantChannelListing" (id, "workspaceId", "variantId", channel, "channelConnectionId", "externalSku", "channelPrice") VALUES ($1,$2,$3,'EBAY',$4,$5,1)`, [randomUUID(), W, variant, conn.y, mine.sku])
    await ingest(ebayOrder('ACCOUNT-CANONICAL-1', [{ sku: mine.sku, quantity: 2 }]), conn.x)
    expect((await itemRows('ACCOUNT-CANONICAL-1')).map(row => row.productId)).toEqual([mine.id])
    expect([await levelOf(mine.id), await levelOf(other.id)]).toEqual([3, 5])
  })

  it('resolves the same external SKU separately for two eBay sellers and verified siblings', async () => {
    const mine = await product('ACCOUNT-MINE', 5), other = await product('ACCOUNT-THEIRS', 5)
    for (const [target, account] of [[other, conn.y], [mine, conn.xSibling]] as const) {
      const variant = randomUUID()
      await q(`INSERT INTO "ProductVariation" (id, "workspaceId", "productId", sku, price, "updatedAt") VALUES ($1,$2,$3,$4,1,now())`, [variant, W, target.id, `${target.sku}-V`])
      await q(`INSERT INTO "VariantChannelListing" (id, "workspaceId", "variantId", channel, "channelConnectionId", "externalSku", "channelPrice") VALUES ($1,$2,$3,'EBAY',$4,'ACCOUNT-SHARED-SKU',1)`, [randomUUID(), W, variant, account])
    }
    await ingest(ebayOrder('ACCOUNT-X-1', [{ sku: 'ACCOUNT-SHARED-SKU', quantity: 1 }]), conn.x)
    await ingest(ebayOrder('ACCOUNT-Y-1', [{ sku: 'ACCOUNT-SHARED-SKU', quantity: 2 }]), conn.y)
    expect((await itemRows('ACCOUNT-X-1')).map(row => row.productId)).toEqual([mine.id])
    expect((await itemRows('ACCOUNT-Y-1')).map(row => row.productId)).toEqual([other.id])
    expect([await levelOf(mine.id), await levelOf(other.id)]).toEqual([4, 3])
  })

  it('leaves ambiguous seller listing matches unlinked even when a canonical SKU matches', async () => {
    const mine = await product('ACCOUNT-AMBIGUOUS', 5), other = await product('ACCOUNT-AMBIGUOUS-OTHER', 5)
    for (const [target, account] of [[mine, conn.x], [other, conn.xSibling]] as const) {
      const variant = randomUUID()
      await q(`INSERT INTO "ProductVariation" (id, "workspaceId", "productId", sku, price, "updatedAt") VALUES ($1,$2,$3,$4,1,now())`, [variant, W, target.id, `${target.sku}-V`])
      await q(`INSERT INTO "VariantChannelListing" (id, "workspaceId", "variantId", channel, "channelConnectionId", "externalSku", "channelPrice") VALUES ($1,$2,$3,'EBAY',$4,$5,1)`, [randomUUID(), W, variant, account, mine.sku])
    }
    await ingest(ebayOrder('ACCOUNT-AMBIGUOUS-1', [{ sku: mine.sku, quantity: 2 }]), conn.x)
    expect((await itemRows('ACCOUNT-AMBIGUOUS-1')).map(row => row.productId)).toEqual([null])
    expect(await movementRows('ACCOUNT-AMBIGUOUS-1')).toEqual([])
    expect([await levelOf(mine.id), await levelOf(other.id)]).toEqual([5, 5])
  })

  it('marks a pool take the door reports as already made for the order pool_reused, uncounted; takes run in source order', async () => {
    const { normalizeEbayOrder, writeEbayOrderInTx } = await import('./ebay-order-writer.js')
    const made = [await product('ORDERED-A', 5), await product('ORDERED-B', 5), await product('ORDERED-C', 5)]
    const sorted = [...made].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    const reused = sorted[1]
    await q('ALTER FUNCTION nexus_pool_take(text, integer, text, text) RENAME TO nexus_pool_take_real')
    await q('CREATE TABLE test_pool_calls (seq serial PRIMARY KEY, pid text NOT NULL)')
    await q(`CREATE FUNCTION nexus_pool_take(product_id text, take_quantity integer, order_ref text, actor text DEFAULT NULL) RETURNS jsonb
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
      BEGIN
        INSERT INTO test_pool_calls (pid) VALUES ($1);
        IF $1 = '${reused.id}' THEN RETURN jsonb_build_object('taken', $2, 'reused', true); END IF;
        RETURN nexus_pool_take_real($1, $2, $3, $4);
      END $$`)
    let result: Awaited<ReturnType<typeof writeEbayOrderInTx>>
    try {
      const order = normalizeEbayOrder(ebayOrder('POOL-ORDER-1', [...sorted].reverse().map(p => ({ sku: p.sku, quantity: 1 }))))
      result = await inW(() => database.client.$transaction(tx => writeEbayOrderInTx(tx, { order, connectionId: conn.x, actor: 'ebay-orders-sync' }), { isolationLevel: 'ReadCommitted' }))
      expect((await q<{ pid: string }>('SELECT pid FROM test_pool_calls ORDER BY seq')).map(row => row.pid)).toEqual(sorted.map(p => p.id))
    } finally {
      await q('DROP FUNCTION IF EXISTS nexus_pool_take(text, integer, text, text)')
      await q('ALTER FUNCTION nexus_pool_take_real(text, integer, text, text) RENAME TO nexus_pool_take')
      await q('DROP TABLE IF EXISTS test_pool_calls')
    }
    expect(Object.fromEntries(result.lines.map(line => [line.productId, line.stockEffect]))).toEqual({ [sorted[0].id]: 'own_movement', [reused.id]: 'pool_reused', [sorted[2].id]: 'own_movement' })
    expect(result.stats.inventoryDeducted).toBe(2)
    expect((await movementRows('POOL-ORDER-1')).map(row => row.productId).sort()).toEqual([sorted[0].id, sorted[2].id].sort())
  })

  it('never links a line to another channel\'s listing through its eBay line id', async () => {
    const other = await product('D7-OTHER', 5)
    const variant = randomUUID()
    await q(`INSERT INTO "ProductVariation" (id, "workspaceId", "productId", sku, price, "updatedAt") VALUES ($1,$2,$3,$4,1,now())`, [variant, W, other.id, `${other.sku}-VAR`])
    await q(`INSERT INTO "VariantChannelListing" (id, "workspaceId", "variantId", channel, "externalListingId", "channelPrice") VALUES ($1,$2,$3,'AMAZON','D7-LINE-777',1)`, [randomUUID(), W, variant])
    await ingest(ebayOrder('D7-1', [{ sku: 'NO-SUCH-SKU-D7', quantity: 1, lineItemId: 'D7-LINE-777' }]), conn.x)
    expect((await itemRows('D7-1')).map(row => [row.externalLineItemId, row.productId])).toEqual([['D7-LINE-777', null]])
    expect(await effects('D7-1')).toEqual({ 'D7-LINE-777': 'unlinked' })
    expect(await levelOf(other.id)).toBe(5)
  })

  // S6 — one inbound match (services/listings/channel-sku-inbound.ts): a listing may carry its own eBay SKU on its account.
  const ebayListing = (productId: string, account: string, skus: { channelSku?: string; liveChannelSku?: string }, marketplace = 'IT', workspaceId = W) =>
    q(`INSERT INTO "ChannelListing" (id,"workspaceId","productId","channelMarket",channel,region,marketplace,"channelConnectionId","listingStatus","isPublished","channelSku","liveChannelSku","updatedAt")
       VALUES ($1,$2,$3,$4,'EBAY',$5,$5,$6,'ACTIVE',true,$7,$8,now())`, [randomUUID(), workspaceId, productId, `EBAY_${marketplace}`, marketplace, account, skus.channelSku ?? null, skus.liveChannelSku ?? null])

  it('S6: master SKU as before; the listing\'s own SKU and the SKU eBay still holds after a rename take THAT product\'s stock; another account\'s SKU and a SKU two products hold stay unlinked, the latter with the reason', async () => {
    const tag = randomUUID().slice(0, 8)
    const plain = await product('S6-PLAIN', 5), own = await product('S6-OWN', 5), renamed = await product('S6-NEW', 5)
    const otherAccount = await product('S6-OTHERACC', 5), ambA = await product('S6-AMB-A', 5), ambB = await product('S6-AMB-B', 5)
    await ebayListing(own.id, conn.x, { channelSku: `S6-OWN-EBAY-${tag}` })
    await ebayListing(renamed.id, conn.x, { channelSku: `S6-OLD-${tag}`, liveChannelSku: `S6-OLD-${tag}` })
    await ebayListing(otherAccount.id, conn.y, { channelSku: `S6-Y-${tag}` })
    await ebayListing(ambA.id, conn.x, { channelSku: `S6-AMB-${tag}` })
    await ebayListing(ambB.id, conn.x, { channelSku: `S6-AMB-${tag}` }, 'DE')
    const lines = [plain.sku, `S6-OWN-EBAY-${tag}`, `S6-OLD-${tag}`, `S6-Y-${tag}`, `S6-AMB-${tag}`].map(sku => ({ sku, quantity: 1 }))
    await ingest(ebayOrder(`S6-EBAY-${tag}`, lines), conn.x)
    const rows = await itemRows(`S6-EBAY-${tag}`)
    expect(rows.map(row => row.productId)).toEqual([plain.id, own.id, renamed.id, null, null])
    // The order line keeps the marketplace's own SKU text.
    expect((await q(`SELECT i.sku FROM "OrderItem" i JOIN "Order" o ON o.id=i."orderId" WHERE o."channelOrderId"=$1 ORDER BY i."externalLineItemId"`, [`S6-EBAY-${tag}`])).map(row => row.sku))
      .toEqual(lines.map(line => line.sku))
    expect(rows.map(row => row.ebayMetadata.stockEffect)).toEqual(['own_movement', 'own_movement', 'own_movement', 'unlinked', 'unlinked'])
    expect(rows[3].ebayMetadata.unlinkedReason).toBeUndefined()
    expect(rows[4].ebayMetadata.unlinkedReason).toBe(`The eBay SKU S6-AMB-${tag} matches more than one product (${[ambA, ambB].sort((x, y) => (x.id < y.id ? -1 : 1)).map(p => p.sku).join(', ')}). `
      + 'Nexus did not pick one, so this line is not linked to a product. Give each product its own SKU on this eBay account.')
    expect(await Promise.all([plain, own, renamed, otherAccount, ambA, ambB].map(p => levelOf(p.id)))).toEqual([4, 4, 4, 5, 5, 5])
    // The same SKU read through its own account links it.
    await ingest(ebayOrder(`S6-EBAY-Y-${tag}`, [{ sku: `S6-Y-${tag}`, quantity: 1 }]), conn.y)
    expect((await itemRows(`S6-EBAY-Y-${tag}`)).map(row => row.productId)).toEqual([otherAccount.id])
  })

  it('S6: 🔴 a listing SKU of another business never matches — its account, its product', async () => {
    const tag = randomUUID().slice(0, 8)
    const b = await business(`s6${tag}`, [{ code: 'S6-MAIN', isDefault: true }])
    const foreign = await b.product(`S6-FOREIGN-P-${tag}`)
    await ebayListing(foreign.id, b.connectionId, { channelSku: `S6-FOREIGN-${tag}` }, 'IT', b.id)
    await ingest(ebayOrder(`S6-EBAY-F-${tag}`, [{ sku: `S6-FOREIGN-${tag}`, quantity: 1 }, { sku: foreign.sku, quantity: 1 }]), conn.x)
    expect((await itemRows(`S6-EBAY-F-${tag}`)).map(row => row.productId)).toEqual([null, null])
    // Positive control: in its own business, through its own account, the listing SKU names it.
    await b.ingest(ebayOrder(`S6-EBAY-F2-${tag}`, [{ sku: `S6-FOREIGN-${tag}`, quantity: 1 }]))
    expect((await itemRows(`S6-EBAY-F2-${tag}`)).map(row => row.productId)).toEqual([foreign.id])
  })

  it('S6 parity: an order for a trashed product\'s master SKU links to it and takes its stock, exactly as before', async () => {
    const trashed = await product('S6-TRASHED', 5)
    await q(`UPDATE "Product" SET "deletedAt" = now() WHERE id = $1`, [trashed.id])
    const tag = randomUUID().slice(0, 8)
    await ingest(ebayOrder(`S6-EBAY-T-${tag}`, [{ sku: trashed.sku, quantity: 2 }]), conn.x)
    const rows = await itemRows(`S6-EBAY-T-${tag}`)
    expect(rows.map(row => [row.productId, row.ebayMetadata.stockEffect])).toEqual([[trashed.id, 'own_movement']])
    expect(await movementRows(`S6-EBAY-T-${tag}`)).toEqual([{ productId: trashed.id, change: -2, reason: 'ORDER_PLACED' }])
    expect(await levelOf(trashed.id)).toBe(3)
  })
})
