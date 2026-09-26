/**
 * One stock model for every channel (2026-09-26, docs/channel-connections/2026-09-26-STOCK-MODEL.md).
 *
 * The arms here hold the CROSS-CHANNEL rules to the real code: the Amazon poll, the Shopify handlers,
 * the reservation reconcile, the cancellation cascade (E3) and the stock page's own release, against real
 * own and shared-stock (pool) ledgers with business profiles ON. Channel-specific arms live with their
 * writers (eBay writer, Etsy ingest, cancellation suites).
 *
 * 🔴 Needs a MULTI-CONNECTION PostgreSQL (locks and races mean nothing on PGlite). Without one the suite
 * SKIPS. From the repo root: `node scripts/run-real-postgres-tests.mjs` (registered). Only SP-API and the
 * detached display caches are faked. The pool fixture follows channel-retry-postgres (cancellation lane).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { concurrentDatabase, concurrentDatabaseUrl } from '../test-support/concurrent-database.js'
import { withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
const upstream = vi.hoisted(() => ({ items: new Map<string, unknown[]>(), failItems: new Set<string>(),
  afterItemUpsert: null as null | ((row: any, args: any) => Promise<void>), afterOrderRead: null as null | ((row: any, args: any) => Promise<void>),
  afterHoldList: null as null | ((rows: any[], args: any) => Promise<void>),
  afterHoldCreate: null as null | ((row: any, args: any) => Promise<void>),
  afterRaw: null as null | ((sql: string) => Promise<void>) }))
vi.mock('./marketplaces/amazon.service.js', () => ({ AmazonService: class {
  async fetchOrderItems(orderId: string) { if (upstream.failItems.has(orderId)) throw new Error('injected Amazon item fetch failure'); return upstream.items.get(orderId) ?? [] }
} }))
// Observers only schedule AFTER the real database call (a paused writer); they never replace one.
vi.mock('../db.js', () => {
  const observe = (client: any) => new Proxy(client, { get: (target, key) => {
    const value = target[key]
    if (key === 'orderItem' && upstream.afterItemUpsert) return new Proxy(value, { get: (delegate, method) => method !== 'upsert' ? delegate[method] : async (args: any) => {
      const row = await delegate.upsert(args)
      await upstream.afterItemUpsert?.(row, args)
      return row
    } })
    if (key === 'order' && upstream.afterOrderRead) return new Proxy(value, { get: (delegate, method) => method !== 'findUnique' ? delegate[method] : async (args: any) => {
      const row = await delegate.findUnique(args)
      await upstream.afterOrderRead?.(row, args)
      return row
    } })
    if (key === '$executeRaw' && upstream.afterRaw) return async (...args: any[]) => {
      const result = await Reflect.apply(value, target, args)
      await upstream.afterRaw?.(Array.isArray(args[0]) ? args[0].join('?') : String(args[0]))
      return result
    }
    if (key === 'stockReservation' && (upstream.afterHoldList || upstream.afterHoldCreate)) return new Proxy(value, { get: (delegate, method) => {
      if (method === 'findMany' && upstream.afterHoldList) return async (args: any) => {
        const rows = await delegate.findMany(args)
        await upstream.afterHoldList?.(rows, args)
        return rows
      }
      if (method === 'create' && upstream.afterHoldCreate) return async (args: any) => {
        const row = await delegate.create(args)
        await upstream.afterHoldCreate?.(row, args)
        return row
      }
      return delegate[method]
    } })
    return value
  } })
  return { default: new Proxy({}, { get: (_t, key) => {
    if (key === '$transaction' && (upstream.afterOrderRead || upstream.afterHoldCreate || upstream.afterHoldList || upstream.afterRaw)) return (work: any, options: any) => typeof work === 'function'
      ? database.client.$transaction((tx) => work(observe(tx)), options) : database.client.$transaction(work, options)
    return observe(database.client)[key]
  } }) }
})
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

const q = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const as = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const inContext = async (workspaceId: string, actor: string, statements: Array<[string, unknown[]]>) => {
  const client = await database.pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('nexus.workspace_id',$1,true),set_config('nexus.actor_id',$2,true)`, [workspaceId, actor])
    for (const [sql, params] of statements) await client.query(sql, params)
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

let role = ''
/** A lender with one lent product, and a borrower with its own product and a product that sells from the pool. */
async function fixture(ids: { source?: string; pooled?: string } = {}) {
  const lender = randomUUID(), borrower = randomUUID(), owner = randomUUID(), receiver = randomUUID()
  const source = ids.source ?? randomUUID(), pooled = ids.pooled ?? randomUUID(), own = randomUUID(), lenderLocation = randomUUID(), ownLocation = randomUUID()
  for (const [workspace, person, location] of [[lender, owner, lenderLocation], [borrower, receiver, ownLocation]]) {
    await q(`INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,'active','test',$1,now())`, [workspace])
    await q(`INSERT INTO "UserProfile" (id,email,status,"updatedAt") VALUES ($1,$2,'active',now())`, [person, `${person}@example.test`])
    const warehouse = randomUUID()
    await q(`INSERT INTO "Warehouse" (id,"workspaceId",code,name,country,"isDefault","updatedAt") VALUES ($1,$2,'IT-MAIN','Main','IT',true,now())`, [warehouse, workspace])
    await q(`INSERT INTO "StockLocation" (id,"workspaceId",type,code,name,"warehouseId","updatedAt") VALUES ($1,$2,'WAREHOUSE','IT-MAIN','Main',$3,now())`, [location, workspace, warehouse])
  }
  for (const [workspace, person] of [[lender, owner], [borrower, owner], [borrower, receiver]]) {
    const member = randomUUID()
    await q(`INSERT INTO "WorkspaceMembership" (id,"workspaceId","userId",status,"updatedAt") VALUES ($1,$2,$3,'active',now())`, [member, workspace, person])
    await q(`INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)`, [member, role])
  }
  for (const [id, workspace, location] of [[source, lender, lenderLocation], [pooled, borrower, ownLocation], [own, borrower, ownLocation]]) {
    await q(`INSERT INTO "Product" (id,"workspaceId",sku,name,"basePrice","totalStock","updatedAt") VALUES ($1,$2,$1,$1,10,10,now())`, [id, workspace])
    await q(`INSERT INTO "StockLevel" (id,"workspaceId","locationId","productId",quantity,reserved,available,"lastUpdatedAt") VALUES ($1,$2,$3,$4,10,0,10,now())`, [randomUUID(), workspace, location, id])
  }
  const assortment = randomUUID(), share = randomUUID(), grant = randomUUID(), catalog = randomUUID()
  await inContext(lender, owner, [
    [`INSERT INTO "Assortment" (id,"workspaceId",name,selection,"updatedAt") VALUES ($1,$2,'Pool','list',now())`, [assortment, lender]],
    [`INSERT INTO "AssortmentMember" (id,"workspaceId","assortmentId","productId",mode) VALUES ($1,$2,$3,$4,'include')`, [randomUUID(), lender, assortment, source]],
    [`INSERT INTO "AssortmentShare" (id,"assortmentId","ownerWorkspaceId","workspaceId","fieldGroups","createdByUserId","updatedAt") VALUES ($1,$2,$3,$4,ARRAY['identity'],$5,now())`, [share, assortment, lender, borrower, owner]],
    [`INSERT INTO "StockPoolGrant" (id,"ownerWorkspaceId","workspaceId","locationIds","createdByUserId","updatedAt") VALUES ($1,$2,$3,$4,$5,now())`, [grant, lender, borrower, [lenderLocation], owner]],
  ])
  await inContext(borrower, receiver, [
    [`SELECT nexus_assortment_share_respond($1,'accept',1)`, [share]],
    [`SELECT nexus_stock_pool_grant_respond($1,'accept',1)`, [grant]],
    [`INSERT INTO "CatalogLink" (id,"shareId","sourceWorkspaceId","sourceProductId","targetWorkspaceId","targetProductId","linkedBy","sourceVersion","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,'created',1,now())`, [catalog, share, lender, source, borrower, pooled]],
    [`INSERT INTO "StockPoolLink" (id,"workspaceId","grantId","catalogLinkId","productId","sourceProductId","createdByUserId","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,now())`, [randomUUID(), borrower, grant, catalog, pooled, source, receiver]],
  ])
  return { lender, borrower, source, pooled, own, ownLocation, owner, receiver, grant, share, assortment, lenderLocation }
}
/** A borrower product sold from its own stock until `link()` makes it sell from a new lent source. */
async function laterPooled(f: Fixture) {
  const later = randomUUID(), laterSource = randomUUID()
  await q(`INSERT INTO "Product" (id,"workspaceId",sku,name,"basePrice","totalStock","updatedAt") VALUES ($1,$2,$1,$1,10,10,now())`, [later, f.borrower])
  await q(`INSERT INTO "StockLevel" (id,"workspaceId","locationId","productId",quantity,reserved,available,"lastUpdatedAt") VALUES ($1,$2,$3,$4,10,0,10,now())`, [randomUUID(), f.borrower, f.ownLocation, later])
  await q(`INSERT INTO "Product" (id,"workspaceId",sku,name,"basePrice","totalStock","updatedAt") VALUES ($1,$2,$1,$1,10,10,now())`, [laterSource, f.lender])
  await q(`INSERT INTO "StockLevel" (id,"workspaceId","locationId","productId",quantity,reserved,available,"lastUpdatedAt") VALUES ($1,$2,$3,$4,10,0,10,now())`, [randomUUID(), f.lender, f.lenderLocation, laterSource])
  const link = async () => {
    const catalog = randomUUID()
    await inContext(f.lender, f.owner, [[`INSERT INTO "AssortmentMember" (id,"workspaceId","assortmentId","productId",mode) VALUES ($1,$2,$3,$4,'include')`, [randomUUID(), f.lender, f.assortment, laterSource]]])
    await inContext(f.borrower, f.receiver, [
      [`INSERT INTO "CatalogLink" (id,"shareId","sourceWorkspaceId","sourceProductId","targetWorkspaceId","targetProductId","linkedBy","sourceVersion","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,'created',1,now())`, [catalog, f.share, f.lender, laterSource, f.borrower, later]],
      [`INSERT INTO "StockPoolLink" (id,"workspaceId","grantId","catalogLinkId","productId","sourceProductId","createdByUserId","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,now())`, [randomUUID(), f.borrower, f.grant, catalog, later, laterSource, f.receiver]],
    ])
  }
  return { later, laterSource, link }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
type AmazonState = 'shipped' | 'cancelled' | 'stale' | 'pending' | 'partial' | 'delivered'
const AMAZON_STATUS: Record<AmazonState, string> = { shipped: 'Shipped', cancelled: 'Canceled', stale: 'Unshipped', pending: 'Pending', partial: 'PartiallyShipped', delivered: 'Delivered' }

let amazon: { upsertOrder: (raw: unknown, summary: Record<string, unknown>) => Promise<void> }
let reconciler: typeof import('./reservation-reconcile.js')
let cancellation: typeof import('./order-cancellation/index.js')
let shopify: typeof import('../routes/shopify-webhooks.js')
/** One Shopify create or update of this order, through the real handlers. */
async function readShopify(workspace: string, id: string, lines: Array<{ sku: string; quantity: number }>, state: 'paid' | 'fulfilled' | 'cancelled', create = false) {
  const raw = { id, created_at: '2026-09-25T00:00:00Z', updated_at: '2026-09-25T01:00:00Z', financial_status: state === 'cancelled' ? 'voided' : 'paid',
    fulfillment_status: state === 'fulfilled' ? 'fulfilled' : null, ...(state === 'cancelled' ? { cancelled_at: '2026-09-25T02:00:00Z' } : {}),
    total_price: '40', currency: 'EUR', line_items: lines.map((line, i) => ({ id: `${id}-L${i}`, sku: line.sku, quantity: line.quantity, price: '10' })) }
  await as(workspace, () => create ? shopify.handleOrderCreate(raw as never) : shopify.handleOrderUpdate(raw as never))
  return (await q<{ id: string; status: string }>(`SELECT id,status::text FROM "Order" WHERE "workspaceId"=$1 AND channel='SHOPIFY' AND "channelOrderId"=$2`, [workspace, id]))[0]
}
const summary = () => ({ itemsUpserted: 0, itemsFailed: 0, fbmReservationsCreated: 0, fbmReservationsConsumed: 0, fbmInsufficientStock: 0 })
/** One Amazon read of this order, through the real writer. `lines` are (sku, quantity) — the fixture's SKU is the product id. */
async function readAmazon(workspace: string, id: string, lines: Array<{ sku: string; quantity: number; shipped?: number }>, state: AmazonState) {
  upstream.items.set(id, lines.map((line, i) => ({ OrderItemId: `${id}-L${i}`, SellerSKU: line.sku, QuantityOrdered: line.quantity,
    ...(line.shipped === undefined ? {} : { QuantityShipped: line.shipped }), ItemPrice: { Amount: String(10 * line.quantity), CurrencyCode: 'EUR' } })))
  await as(workspace, () => amazon.upsertOrder({ AmazonOrderId: id, PurchaseDate: '2026-09-25T00:00:00Z', LastUpdateDate: '2026-09-25T01:00:00Z',
    OrderStatus: AMAZON_STATUS[state], FulfillmentChannel: 'MFN', MarketplaceId: 'APJ6JRA9NG5V4', OrderTotal: { Amount: '40', CurrencyCode: 'EUR' } }, summary()))
  return (await q<{ id: string; status: string }>(`SELECT id,status::text FROM "Order" WHERE "workspaceId"=$1 AND channel='AMAZON' AND "channelOrderId"=$2`, [workspace, id]))[0]
}
const twoEach = (products: string[]) => products.map((sku) => ({ sku, quantity: 2 }))
const reconcile = (workspace: string) => as(workspace, () => reconciler.reconcileOpenOrderReservations())
const level = async (productId: string) => (await q(`SELECT quantity,reserved,available FROM "StockLevel" WHERE "productId"=$1`, [productId]))[0]
const stockSnapshot = async (f: Fixture, orderId: string) => ({
  own: await level(f.own), source: await level(f.source), pooled: await level(f.pooled),
  holds: await q(`SELECT id,quantity,"consumedAt","releasedAt" FROM "StockReservation" WHERE "orderId"=$1 OR "consumerOrderRef"=$1 ORDER BY id`, [orderId]),
  movements: await q(`SELECT id,"productId",change,reason::text FROM "StockMovement" WHERE "orderId"=$1 OR "consumerOrderRef"=$1 ORDER BY id`, [orderId]),
})
const consumedUnits = async (orderId: string) => (await q<{ productId: string; units: number }>(
  `SELECT "productId",(-SUM(change))::int AS units FROM "StockMovement" WHERE ("orderId"=$1 OR "consumerOrderRef"=$1) AND reason='RESERVATION_CONSUMED' GROUP BY "productId" ORDER BY "productId"`, [orderId]))

/** True once `count` sessions wait (directly or transitively) on the holder's locks. */
async function waitForBlockedBy(holderPid: number, count: number): Promise<boolean> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const [row] = await q<{ count: number }>(`WITH RECURSIVE blocked(pid) AS (
      SELECT pid FROM pg_stat_activity WHERE backend_type='client backend' AND $1::int = ANY(pg_blocking_pids(pid))
      UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid = ANY(pg_blocking_pids(a.pid)) WHERE a.backend_type='client backend'
    ) SELECT count(*)::int AS count FROM blocked`, [holderPid])
    if (row.count >= count) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}
async function waitForBlock(pid: number): Promise<boolean> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const [row] = await q<{ blocked: boolean }>('SELECT cardinality(pg_blocking_pids($1::int)) > 0 AS blocked', [pid])
    if (row.blocked) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

const flag = process.env.NEXUS_WORKSPACES_ENABLED

describe.skipIf(!concurrentDatabaseUrl())('one stock model across channels (real PostgreSQL, profiles ON)', () => {
  beforeAll(async () => {
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    database = await concurrentDatabase({ maxConnections: 24 })
    role = randomUUID()
    await q(`INSERT INTO "Role" (id,key,name,"isSystem","updatedAt") VALUES ($1,'OWNER','Owner',true,now())`, [role])
    // Deployed databases carry these; schema.prisma cannot express them.
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_available_invariant" CHECK (available=quantity-reserved)`)
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_quantity_nonneg" CHECK ("quantity" >= 0)`)
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_reserved_nonneg" CHECK ("reserved" >= 0)`)
    await q(`ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_quantity_positive" CHECK ("quantity" > 0)`)
    await q(`CREATE UNIQUE INDEX "StockLevel_loc_prod_novar_unique" ON "StockLevel" ("workspaceId","locationId","productId") WHERE "variationId" IS NULL`)
    const { AmazonOrdersService } = await import('./amazon-orders.service.js')
    amazon = new AmazonOrdersService() as unknown as typeof amazon
    reconciler = await import('./reservation-reconcile.js')
    cancellation = await import('./order-cancellation/index.js')
    shopify = await import('../routes/shopify-webhooks.js')
  }, 180_000)
  afterEach(async () => { await (await import('./stock-pool/pool-tasks.js')).kickStockPoolWork() })
  afterAll(async () => {
    if (flag === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flag
    await database?.close()
  }, 60_000)

  // R8 — "order written SHIPPED, the process died before its stock work finished". No history reader:
  // the next poll re-reads the shipped order and holds only what the line still owes (R1), and the
  // reconcile consumes open holds of shipped orders, capped at what is owed. Exactly once, own and pool.
  it.each((['fetch', 'hold', 'consume'] as const).flatMap((failure) => (['own', 'pool', 'mixed'] as const).map((mode) => ({ failure, mode }))))(
    'R8 Amazon $failure dies after SHIPPED is written ($mode): the next poll and the reconcile take the line exactly once', async ({ failure, mode }) => {
    const f = await fixture(), channelId = `AMZ-${randomUUID()}`
    const products = mode === 'own' ? [f.own] : mode === 'pool' ? [f.pooled] : [f.own, f.pooled]
    const failing = mode === 'own' ? f.own : f.source
    const failingLevel = () => level(failing)
    if (failure === 'fetch') upstream.failItems.add(channelId)
    else if (failure === 'hold') {
      await q(`CREATE FUNCTION test_r8_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM "StockLevel" WHERE id=NEW."stockLevelId" AND "productId"='${failing}') THEN RAISE EXCEPTION 'injected hold failure'; END IF; RETURN NEW; END $$`)
      await q(`CREATE TRIGGER test_r8_failure BEFORE INSERT ON "StockReservation" FOR EACH ROW EXECUTE FUNCTION test_r8_failure()`)
    } else {
      await q(`CREATE FUNCTION test_r8_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."productId"='${failing}' AND NEW.reason='RESERVATION_CONSUMED' THEN RAISE EXCEPTION 'injected consume failure'; END IF; RETURN NEW; END $$`)
      await q(`CREATE TRIGGER test_r8_failure BEFORE INSERT ON "StockMovement" FOR EACH ROW EXECUTE FUNCTION test_r8_failure()`)
    }
    let orderId = ''
    try {
      const first = readAmazon(f.borrower, channelId, twoEach(products), 'shipped')
      if (failure === 'fetch') await expect(first).rejects.toThrow('injected Amazon item fetch failure')
      else await first
      const [row] = await q<{ id: string; status: string }>(`SELECT id,status::text FROM "Order" WHERE "workspaceId"=$1 AND "channelOrderId"=$2`, [f.borrower, channelId])
      orderId = row.id
      // The crash really happened: SHIPPED is written, the failing product's units did not leave.
      expect(row.status).toBe('SHIPPED')
      expect(await failingLevel()).toEqual({ quantity: 10, reserved: failure === 'consume' ? 2 : 0, available: failure === 'consume' ? 8 : 10 })
    } finally {
      upstream.failItems.delete(channelId)
      if (failure !== 'fetch') {
        await q(`DROP TRIGGER IF EXISTS test_r8_failure ON "${failure === 'hold' ? 'StockReservation' : 'StockMovement'}"`)
        await q('DROP FUNCTION IF EXISTS test_r8_failure()')
      }
    }
    // The next poll re-reads the shipped order: it holds what is still owed and takes nothing itself.
    await readAmazon(f.borrower, channelId, twoEach(products), 'shipped')
    expect(await failingLevel()).toEqual({ quantity: 10, reserved: 2, available: 8 })
    // The reconcile takes it: exactly once.
    await reconcile(f.borrower)
    expect(await level(f.own)).toEqual(mode === 'pool' ? { quantity: 10, reserved: 0, available: 10 } : { quantity: 8, reserved: 0, available: 8 })
    expect(await level(f.source)).toEqual(mode === 'own' ? { quantity: 10, reserved: 0, available: 10 } : { quantity: 8, reserved: 0, available: 8 })
    const healed = await stockSnapshot(f, orderId)
    expect(healed.holds.every((h) => h.consumedAt !== null)).toBe(true)
    expect(await consumedUnits(orderId)).toEqual(products.map((p) => ({ productId: p === f.pooled ? f.source : p, units: 2 })).sort((a, b) => (a.productId < b.productId ? -1 : 1)))
    // Later polls (two at once) and reconciles change nothing.
    await Promise.all([readAmazon(f.borrower, channelId, twoEach(products), 'shipped'), readAmazon(f.borrower, channelId, twoEach(products), 'shipped'), reconcile(f.borrower)])
    await readAmazon(f.borrower, channelId, twoEach(products), 'delivered')
    await reconcile(f.borrower)
    expect(await stockSnapshot(f, orderId)).toEqual(healed)
  })

  // Status under the order's write lock (ported from the cancellation lane, 016c34629): the state decision
  // and its write are one short transaction; stock work runs after, outside the lock.
  it.each([false, true])('Amazon competing shipped and stale writes keep SHIPPED and take the stock once (new order: %s)', async (fresh) => {
    const f = await fixture(), channelId = `AMZ-${randomUUID()}`, lines = twoEach([f.own, f.pooled])
    const existing = fresh ? null : await readAmazon(f.borrower, channelId, lines, 'stale')
    const holder = await database.pool.connect()
    const polls: Array<Promise<{ id: string; status: string }>> = []
    const seen: Array<string | null> = []
    upstream.afterOrderRead = async (row, args) => {
      if (args.select?.status && JSON.stringify(args.where).includes(channelId)) seen.push(row?.status ?? null)
    }
    try {
      await holder.query('BEGIN')
      if (existing) await holder.query(`SELECT id FROM "Order" WHERE id=$1 FOR NO KEY UPDATE`, [existing.id])
      else await holder.query('LOCK TABLE "Order" IN SHARE MODE')
      const pid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      const shipped = readAmazon(f.borrower, channelId, lines, 'shipped'); polls.push(shipped); void shipped.catch(() => undefined)
      expect(await waitForBlockedBy(pid, 1)).toBe(true)
      const stale = readAmazon(f.borrower, channelId, lines, 'stale'); polls.push(stale); void stale.catch(() => undefined)
      expect(await waitForBlockedBy(pid, 2)).toBe(true)
      await holder.query('COMMIT')
      const outcomes = await Promise.allSettled(polls)
      expect(outcomes.filter((row) => row.status === 'rejected').map((row) => String((row as PromiseRejectedResult).reason))).toEqual([])
      const rows = await q<{ id: string; status: string }>(`SELECT id,status::text FROM "Order" WHERE "workspaceId"=$1 AND channel='AMAZON' AND "channelOrderId"=$2`, [f.borrower, channelId])
      expect(rows).toHaveLength(1)
      expect(rows[0].status).toBe('SHIPPED')
      expect(seen).toEqual([fresh ? null : 'PROCESSING', 'SHIPPED'])
      await reconcile(f.borrower)
      expect(await level(f.own)).toEqual({ quantity: 8, reserved: 0, available: 8 })
      expect(await level(f.source)).toEqual({ quantity: 8, reserved: 0, available: 8 })
      expect(await consumedUnits(rows[0].id)).toEqual([{ productId: f.own, units: 2 }, { productId: f.source, units: 2 }].sort((a, b) => (a.productId < b.productId ? -1 : 1)))
    } finally {
      upstream.afterOrderRead = null
      await holder.query('ROLLBACK'); holder.release()
      await Promise.allSettled(polls)
    }
  })

  it('Amazon holds its order row across the status decision, so a concurrent local cancel is not overwritten', async () => {
    const f = await fixture(), channelId = `AMZ-${randomUUID()}`, lines = twoEach([f.own, f.pooled])
    const order = await readAmazon(f.borrower, channelId, lines, 'stale')
    let reached!: () => void, release!: () => void, observed = false
    const ready = new Promise<void>((r) => { reached = r }), gate = new Promise<void>((r) => { release = r })
    upstream.afterOrderRead = async (row, args) => {
      if (row?.id !== order.id || !args.select?.status || !JSON.stringify(args.where).includes(channelId)) return
      observed = true; reached(); await gate
    }
    const poll = readAmazon(f.borrower, channelId, lines, 'stale')
    void poll.catch(() => undefined)
    const local = await database.pool.connect()
    let update: Promise<unknown> | null = null
    try {
      await Promise.race([ready, poll])
      expect(observed).toBe(true)
      await local.query('BEGIN')
      const pid = Number((await local.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      update = local.query(`UPDATE "Order" SET status='CANCELLED',"cancelledAt"=now() WHERE id=$1`, [order.id])
      void update.catch(() => undefined)
      expect(await waitForBlock(pid)).toBe(true)
      upstream.afterOrderRead = null; release()
      await update
      await local.query('COMMIT')
      await poll
      expect(await q(`SELECT status::text FROM "Order" WHERE id=$1`, [order.id])).toEqual([{ status: 'CANCELLED' }])
      expect(await as(f.borrower, () => cancellation.handleOrderCancelled(order.id))).toMatchObject({ errors: [], itemsRestocked: 0 })
      expect(await level(f.own)).toEqual({ quantity: 10, reserved: 0, available: 10 })
      expect(await level(f.source)).toEqual({ quantity: 10, reserved: 0, available: 10 })
    } finally {
      upstream.afterOrderRead = null; release()
      await update?.catch(() => undefined)
      await local.query('COMMIT'); local.release()
      await poll.catch(() => undefined)
    }
  })

  it('Amazon stale pre-shipment reads never regress a shipped FBM order, and its events carry the stored status', async () => {
    const f = await fixture(), channelId = `AMZ-${randomUUID()}`, lines = twoEach([f.own, f.pooled])
    const order = await readAmazon(f.borrower, channelId, lines, 'shipped')
    const shipped = await stockSnapshot(f, order.id)
    const { subscribeOrderEvents } = await import('./order-events.service.js')
    const statuses: Array<string | undefined> = []
    const [member] = await q<{ id: string }>(`SELECT id FROM "WorkspaceMembership" WHERE "workspaceId"=$1 AND "userId"=$2`, [f.borrower, f.owner])
    const unsubscribe = withWorkspace({ workspaceId: f.borrower, actorUserId: f.owner, membershipId: member.id, roleKeys: ['OWNER'] }, () => subscribeOrderEvents((event) => {
      if (event.type === 'order.updated' && event.orderId === order.id) statuses.push(event.status)
    }))
    try {
      for (const state of ['pending', 'stale', 'partial', 'shipped'] as const) {
        expect((await readAmazon(f.borrower, channelId, lines, state)).status).toBe('SHIPPED')
        expect(await stockSnapshot(f, order.id)).toEqual(shipped)
      }
      await vi.waitFor(() => expect(statuses).toHaveLength(4))
      expect(statuses).toEqual(['SHIPPED', 'SHIPPED', 'SHIPPED', 'SHIPPED'])
    } finally { unsubscribe() }
  })

  it('Amazon keeps a taken line bound to its first product when the provider SKU changes', async () => {
    const f = await fixture(), channelId = `AMZ-${randomUUID()}`
    const order = await readAmazon(f.borrower, channelId, twoEach([f.own]), 'shipped')
    const before = await stockSnapshot(f, order.id)
    await readAmazon(f.borrower, channelId, twoEach([f.pooled]), 'shipped') // same external line id, another SKU
    await reconcile(f.borrower)
    expect(await stockSnapshot(f, order.id)).toEqual(before)
    expect(await q(`SELECT "productId" FROM "OrderItem" WHERE "orderId"=$1`, [order.id])).toEqual([{ productId: f.own }])
  })

  it('Amazon links a line that was unlinked when it shipped, and the next reconcile takes it once', async () => {
    const f = await fixture(), channelId = `AMZ-${randomUUID()}`
    const order = await readAmazon(f.borrower, channelId, [{ sku: 'unknown-sku', quantity: 2 }], 'shipped')
    expect(await q(`SELECT "productId" FROM "OrderItem" WHERE "orderId"=$1`, [order.id])).toEqual([{ productId: null }])
    await readAmazon(f.borrower, channelId, twoEach([f.own]), 'shipped')
    await reconcile(f.borrower)
    expect(await level(f.own)).toEqual({ quantity: 8, reserved: 0, available: 8 })
    expect(await q(`SELECT "productId" FROM "OrderItem" WHERE "orderId"=$1`, [order.id])).toEqual([{ productId: f.own }])
    const completed = await stockSnapshot(f, order.id)
    await readAmazon(f.borrower, channelId, twoEach([f.own]), 'shipped')
    await reconcile(f.borrower)
    expect(await stockSnapshot(f, order.id)).toEqual(completed)
  })

  it('Amazon never overwrites a product binding another writer filled after its line read', async () => {
    const f = await fixture(), channelId = `AMZ-${randomUUID()}`
    const order = await readAmazon(f.borrower, channelId, [{ sku: 'unknown-sku', quantity: 2 }], 'shipped')
    let reached!: () => void, release!: () => void, observed = false
    const ready = new Promise<void>((r) => { reached = r }), gate = new Promise<void>((r) => { release = r })
    upstream.afterItemUpsert = async (row) => {
      if (row.orderId !== order.id) return
      observed = true; reached(); await gate
    }
    const pending = readAmazon(f.borrower, channelId, twoEach([f.pooled]), 'shipped')
    void pending.catch(() => undefined)
    try {
      await Promise.race([ready, pending])
      expect(observed).toBe(true)
      expect(await as(f.borrower, () => database.client.orderItem.updateMany({ where: { orderId: order.id, productId: null }, data: { productId: f.own } }))).toEqual({ count: 1 })
      const { reserveOpenOrder, consumeOpenOrder } = await import('./stock-level.service.js')
      await as(f.borrower, () => reserveOpenOrder({ orderId: order.id, productId: f.own, locationId: f.ownLocation, quantity: 2 }))
      await as(f.borrower, () => consumeOpenOrder({ orderId: order.id }))
      const completed = await stockSnapshot(f, order.id)
      upstream.afterItemUpsert = null; release()
      await pending
      await reconcile(f.borrower)
      expect(await stockSnapshot(f, order.id)).toEqual(completed)
      expect(await q(`SELECT "productId" FROM "OrderItem" WHERE "orderId"=$1`, [order.id])).toEqual([{ productId: f.own }])
    } finally { upstream.afterItemUpsert = null; release(); await pending.catch(() => undefined) }
  })

  // R7 — one shortfall class, whichever primitive refuses: a caller's `instanceof` must not depend on
  // whether a hold or a movement ran out.
  it('R7 a hold and a movement beyond stock raise the same InsufficientStockError', async () => {
    const f = await fixture()
    const levels = await import('./stock-level.service.js'), movement = await import('./stock-movement.service.js')
    const hold = await as(f.borrower, () => levels.reserveStock({ productId: f.own, locationId: f.ownLocation, quantity: 11, actor: 'test' })).catch((e: unknown) => e)
    const sale = await as(f.borrower, () => movement.applyStockMovement({ productId: f.own, locationId: f.ownLocation, change: -11, reason: 'ORDER_PLACED', actor: 'test' })).catch((e: unknown) => e)
    expect(hold).toBeInstanceOf(movement.InsufficientStockError)
    expect(sale).toBeInstanceOf(movement.InsufficientStockError)
    expect(hold).toMatchObject({ code: 'insufficient_stock', need: 11, have: 10, productId: f.own, locationId: f.ownLocation })
    expect(sale).toMatchObject({ code: 'insufficient_stock', need: 11, have: 10, productId: f.own, locationId: f.ownLocation })
    // The messages callers and logs already match on are unchanged.
    expect(String((hold as Error).message)).toContain('reserveStock: insufficient available (need=11 have=10')
    expect(String((sale as Error).message)).toContain('applyStockMovement: would drive StockLevel quantity negative')
    expect(await level(f.own)).toEqual({ quantity: 10, reserved: 0, available: 10 })
  })

  // R10 — an order with several lines of one product holds and takes the product's TOTAL. The hold is
  // one per (order, product); the callers sum per product (before: only the first line was held).
  it.each(['own', 'pool'] as const)('R10 Amazon: two lines of one product (2 + 3) are held and taken as 5 (%s)', async (mode) => {
    const f = await fixture(), channelId = `AMZ-${randomUUID()}`
    const product = mode === 'own' ? f.own : f.pooled, stockOf = mode === 'own' ? f.own : f.source
    const lines = [{ sku: product, quantity: 2 }, { sku: product, quantity: 3 }]
    const order = await readAmazon(f.borrower, channelId, lines, 'stale')
    expect(await level(stockOf)).toEqual({ quantity: 10, reserved: 5, available: 5 })
    await readAmazon(f.borrower, channelId, lines, 'stale')
    expect(await level(stockOf)).toEqual({ quantity: 10, reserved: 5, available: 5 })
    await readAmazon(f.borrower, channelId, lines, 'shipped')
    expect(await level(stockOf)).toEqual({ quantity: 5, reserved: 0, available: 5 })
    await Promise.all([readAmazon(f.borrower, channelId, lines, 'shipped'), reconcile(f.borrower)])
    await readAmazon(f.borrower, channelId, lines, 'delivered')
    await reconcile(f.borrower)
    expect(await level(stockOf)).toEqual({ quantity: 5, reserved: 0, available: 5 })
    expect(await consumedUnits(order.id)).toEqual([{ productId: stockOf, units: 5 }])
  })

  it('R10 Shopify: two lines of one product (2 + 3) are held and taken as 5, and a re-delivered create holds nothing more', async () => {
    const f = await fixture(), shopifyId = String(Date.now()) + String(Math.floor(Math.random() * 1e6))
    const lines = [{ sku: f.own, quantity: 2 }, { sku: f.own, quantity: 3 }]
    const order = await readShopify(f.borrower, shopifyId, lines, 'paid', true)
    expect(await level(f.own)).toEqual({ quantity: 10, reserved: 5, available: 5 })
    await readShopify(f.borrower, shopifyId, lines, 'fulfilled')
    expect(await level(f.own)).toEqual({ quantity: 5, reserved: 0, available: 5 })
    await readShopify(f.borrower, shopifyId, lines, 'paid', true)
    await reconcile(f.borrower)
    expect(await level(f.own)).toEqual({ quantity: 5, reserved: 0, available: 5 })
    expect(await consumedUnits(order.id)).toEqual([{ productId: f.own, units: 5 }])
  })

  // Hold identity (the case Etsy's OrderLineHold covered, for every channel): an order's hold for a
  // product stays on the side it was first made. Door 2 answers "not pooled" before it looks for the
  // order's hold, and nothing looked at own holds before asking the pool: a re-read across a switch
  // held the order twice, and shipping took it from both.
  it.each(['paused', 'revoked'] as const)('an order held in the pool is not held again from own stock once the grant is %s, and ships once from the pool', async (change) => {
    const f = await fixture(), channelId = `AMZ-${randomUUID()}`, lines = twoEach([f.pooled])
    const order = await readAmazon(f.borrower, channelId, lines, 'stale')
    expect(await level(f.source)).toEqual({ quantity: 10, reserved: 2, available: 8 })
    await inContext(f.lender, f.owner, [[change === 'paused'
      ? `UPDATE "StockPoolGrant" SET status='paused',version=version+1,"pausedByUserId"=$1,"pausedAt"=now() WHERE id=$2`
      : `UPDATE "StockPoolGrant" SET status='revoked',version=version+1,"endedBySide"='owner',"endedByUserId"=$1,"endedAt"=now() WHERE id=$2`, [f.owner, f.grant]]])
    await readAmazon(f.borrower, channelId, lines, 'stale')
    await readAmazon(f.borrower, channelId, lines, 'stale')
    expect(await level(f.pooled)).toEqual({ quantity: 10, reserved: 0, available: 10 })
    expect(await level(f.source)).toEqual({ quantity: 10, reserved: 2, available: 8 })
    await readAmazon(f.borrower, channelId, lines, 'shipped')
    await reconcile(f.borrower)
    await readAmazon(f.borrower, channelId, lines, 'delivered')
    await reconcile(f.borrower)
    expect(await level(f.pooled)).toEqual({ quantity: 10, reserved: 0, available: 10 })
    expect(await level(f.source)).toEqual({ quantity: 8, reserved: 0, available: 8 })
    expect(await consumedUnits(order.id)).toEqual([{ productId: f.source, units: 2 }])
  })

  it('an order held from own stock is not held again in the pool once its product sells from shared stock, and ships once from own stock', async () => {
    const f = await fixture(), channelId = `AMZ-${randomUUID()}`
    const { later, laterSource, link } = await laterPooled(f)
    const lines = twoEach([later])
    const order = await readAmazon(f.borrower, channelId, lines, 'stale')
    expect(await level(later)).toEqual({ quantity: 10, reserved: 2, available: 8 })
    await link()
    await readAmazon(f.borrower, channelId, lines, 'stale')
    await readAmazon(f.borrower, channelId, lines, 'stale')
    expect(await level(laterSource)).toEqual({ quantity: 10, reserved: 0, available: 10 })
    await readAmazon(f.borrower, channelId, lines, 'shipped')
    await reconcile(f.borrower)
    expect(await level(later)).toEqual({ quantity: 8, reserved: 0, available: 8 })
    expect(await level(laterSource)).toEqual({ quantity: 10, reserved: 0, available: 10 })
    expect(await consumedUnits(order.id)).toEqual([{ productId: later, units: 2 }])
  })

  it('the pool order-hold read door answers only for the caller business, its members and its own orders', async () => {
    const f = await fixture(), channelId = `AMZ-${randomUUID()}`
    const order = await readAmazon(f.borrower, channelId, twoEach([f.pooled]), 'stale')
    const ask = (workspaceId: string, actor: string | null) => withWorkspace({ workspaceId, actorUserId: actor, membershipId: null, roleKeys: [] },
      () => database.client.$queryRaw<Array<{ result: Record<string, unknown> | null }>>`SELECT nexus_pool_order_hold(${order.id}, ${f.pooled}) AS result`)
    expect((await ask(f.borrower, null))[0].result).toMatchObject({ quantity: 2, state: 'open', reused: true })
    expect((await ask(f.borrower, f.receiver))[0].result).toMatchObject({ quantity: 2, state: 'open' })
    // The lender's own context names another business's order: nothing.
    expect((await ask(f.lender, null))[0].result).toBeNull()
    await expect(q(`SELECT nexus_pool_order_hold($1,$2)`, [order.id, f.pooled])).rejects.toThrow(/active business profile/)
    await expect(ask(f.borrower, randomUUID())).rejects.toThrow(/active business profile/)
  })

  // The in-transaction hold/consume/release (the Etsy writer's) follow the same rules as the wrappers,
  // with own and pool stock on the caller's transaction: a rollback leaves nothing anywhere.
  it('in one transaction: own and pool holds roll back together; committed, the whole order is taken out once and a re-hold holds nothing', async () => {
    const f = await fixture(), orderId = randomUUID()
    await q(`INSERT INTO "Order" (id,"workspaceId",channel,"channelOrderId","totalPrice","customerName","customerEmail","shippingAddress","updatedAt") VALUES ($1,$2,'ETSY',$1,20,'B','b@example.test','{}'::jsonb,now())`, [orderId, f.borrower])
    for (const [i, product] of [f.own, f.pooled].entries()) {
      await q(`INSERT INTO "OrderItem" (id,"workspaceId","orderId","productId",sku,quantity,price,"externalLineItemId","updatedAt") VALUES ($1,$2,$3,$4,$4,2,10,$5,now())`, [randomUUID(), f.borrower, orderId, product, `L${i}`])
    }
    const levels = await import('./stock-level.service.js')
    const holdAll = (tx: any) => Promise.all([f.own, f.pooled].sort().map(async (productId) => levels.reserveOpenOrderInTx(tx, { orderId, productId, locationId: f.ownLocation, quantity: 2, actor: 'test' })))
    const rolledBack = await as(f.borrower, () => database.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT nexus_lock_order_stock(${[f.own, f.pooled]}::text[])`
      for (const productId of [f.own, f.pooled].sort()) await levels.reserveOpenOrderInTx(tx, { orderId, productId, locationId: f.ownLocation, quantity: 2, actor: 'test' })
      throw new Error('roll back')
    })).catch((e: Error) => e.message)
    expect(rolledBack).toBe('roll back')
    expect([await level(f.own), await level(f.source), await level(f.pooled)]).toEqual([{ quantity: 10, reserved: 0, available: 10 }, { quantity: 10, reserved: 0, available: 10 }, { quantity: 10, reserved: 0, available: 10 }])
    const held = await as(f.borrower, () => database.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT nexus_lock_order_stock(${[f.own, f.pooled]}::text[])`
      const out = []
      for (const productId of [f.own, f.pooled].sort()) out.push(await levels.reserveOpenOrderInTx(tx, { orderId, productId, locationId: f.ownLocation, quantity: 2, actor: 'test' }))
      return out
    }))
    expect(held.map((h) => h.via).sort()).toEqual(['own', 'pool'])
    expect([await level(f.own), await level(f.source)]).toEqual([{ quantity: 10, reserved: 2, available: 8 }, { quantity: 10, reserved: 2, available: 8 }])
    const taken = await as(f.borrower, () => database.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT nexus_lock_order_stock(${[f.own, f.pooled]}::text[])`
      return levels.consumeOpenOrderInTx(tx, { orderId, actor: 'test' })
    }))
    expect(taken.consumed).toBe(2)
    await as(f.borrower, () => levels.afterOrderHoldsCommit(taken.after))
    // A re-hold after the take holds nothing (R1 own; door 2 once, ever, for the pool); a release gives nothing.
    const again = await as(f.borrower, () => database.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT nexus_lock_order_stock(${[f.own, f.pooled]}::text[])`
      await holdAll(tx)
      return levels.releaseOpenOrderInTx(tx, { orderId, actor: 'test' })
    }))
    expect(again.released).toBe(0)
    expect([await level(f.own), await level(f.source), await level(f.pooled)]).toEqual([{ quantity: 8, reserved: 0, available: 8 }, { quantity: 8, reserved: 0, available: 8 }, { quantity: 10, reserved: 0, available: 10 }])
    expect(await consumedUnits(orderId)).toEqual([{ productId: f.own, units: 2 }, { productId: f.source, units: 2 }].sort((a, b) => (a.productId < b.productId ? -1 : 1)))
  })

  // The race the review asked for: on ONE order, the Amazon poll, the hourly reconcile, an operator's
  // cancellation (E3) and a manual release on the stock page, all at once, own and pool stock. Whatever
  // the interleaving, each hold settles exactly once (released or taken, never both, never twice),
  // nothing shipped comes back (R4), and every level equals its start plus its movements.
  const ledgerHolds = async (f: Fixture, orderId: string) => {
    const [own] = await q<{ moved: number; quantity: number; reserved: number; open: number }>(`SELECT lv.quantity, lv.reserved,
      COALESCE((SELECT SUM(m.change) FROM "StockMovement" m WHERE m."productId" = lv."productId" AND m."locationId" = lv."locationId"), 0)::int AS moved,
      COALESCE((SELECT SUM(r.quantity) FROM "StockReservation" r WHERE r."stockLevelId" = lv.id AND r."releasedAt" IS NULL AND r."consumedAt" IS NULL), 0)::int AS open
      FROM "StockLevel" lv WHERE lv."productId" = $1`, [f.own])
    const [source] = await q<{ moved: number; quantity: number; reserved: number; open: number }>(`SELECT lv.quantity, lv.reserved,
      COALESCE((SELECT SUM(m.change) FROM "StockMovement" m WHERE m."productId" = lv."productId" AND m."locationId" = lv."locationId"), 0)::int AS moved,
      COALESCE((SELECT SUM(r.quantity) FROM "StockReservation" r WHERE r."stockLevelId" = lv.id AND r."releasedAt" IS NULL AND r."consumedAt" IS NULL), 0)::int AS open
      FROM "StockLevel" lv WHERE lv."productId" = $1`, [f.source])
    const holds = await q<{ consumed: boolean; released: boolean }>(`SELECT "consumedAt" IS NOT NULL AS consumed, "releasedAt" IS NOT NULL AS released FROM "StockReservation" WHERE "orderId" = $1 OR "consumerOrderRef" = $1`, [orderId])
    const restores = await q(`SELECT id FROM "StockMovement" WHERE ("orderId" = $1 OR "consumerOrderRef" = $1) AND reason = 'ORDER_CANCELLED'`, [orderId])
    return { own, source, holds, restores }
  }
  const expectConsistent = (l: Awaited<ReturnType<typeof ledgerHolds>>) => {
    for (const lv of [l.own, l.source]) {
      expect(lv.quantity).toBe(10 + lv.moved) // every level is its start plus its movements
      expect(lv.reserved).toBe(lv.open) // reserved is exactly its open holds
      expect(lv.reserved).toBe(0)
      expect([8, 10]).toContain(lv.quantity) // taken once or not at all — never twice
    }
    expect(l.holds).toHaveLength(2)
    for (const h of l.holds) expect([h.consumed, h.released]).not.toEqual([true, true])
    expect(l.holds.every((h) => h.consumed || h.released)).toBe(true)
    expect(l.restores).toEqual([]) // nothing shipped (or never taken) is ever given back
  }

  // B5 (review): the interleavings are forced, one per arm, and each arm records the order its steps
  // ran in (`trace`) and asserts the exact outcome — not "taken once or not at all".
  const shipPoll = (f: Fixture, channelId: string) => readAmazon(f.borrower, channelId, twoEach([f.own, f.pooled]), 'shipped')
  const operatorCancel = async (f: Fixture, orderId: string) => {
    await q(`UPDATE "Order" SET status='CANCELLED', "cancelledAt"=now() WHERE id=$1`, [orderId])
    return as(f.borrower, () => cancellation.handleOrderCancelled(orderId))
  }
  const stockPageRelease = async (f: Fixture, holdId: string) => {
    const { releaseReservation } = await import('./stock-level.service.js')
    return as(f.borrower, () => releaseReservation(holdId, { actor: 'manual-release' }))
  }
  const heldOrder = async (f: Fixture) => {
    const channelId = `AMZ-${randomUUID()}`
    const order = await readAmazon(f.borrower, channelId, twoEach([f.own, f.pooled]), 'stale')
    const [ownHold] = await q<{ id: string }>(`SELECT id FROM "StockReservation" WHERE "orderId" = $1`, [order.id])
    expect([await level(f.own), await level(f.source)]).toEqual([{ quantity: 10, reserved: 2, available: 8 }, { quantity: 10, reserved: 2, available: 8 }])
    return { channelId, order, ownHold }
  }
  /** One row per owner who was told; the borrower in this fixture has two owners. */
  const shippedNotices = (orderId: string) => q(`SELECT "userId", count(*)::int AS n FROM "Notification" WHERE type='channel-order-cancelled-after-shipment' AND "entityId"=$1 GROUP BY "userId"`, [orderId])

  it('race P→C→S→R (ship, then cancel, then a stock-page release, then the reconcile): both taken once, nothing back, one notice', async () => {
    const f = await fixture(), trace: string[] = []
    const { channelId, order, ownHold } = await heldOrder(f)
    await shipPoll(f, channelId); trace.push('P')
    expect(await operatorCancel(f, order.id)).toMatchObject({ itemsRestocked: 0, shippedBeforeCancel: true }); trace.push('C')
    await stockPageRelease(f, ownHold.id); trace.push('S')
    await reconcile(f.borrower); trace.push('R')
    expect(trace).toEqual(['P', 'C', 'S', 'R'])
    const l = await ledgerHolds(f, order.id)
    expectConsistent(l)
    expect([l.own.quantity, l.source.quantity]).toEqual([8, 8])
    expect(l.holds.map((h) => [h.consumed, h.released])).toEqual([[true, false], [true, false]])
    const told = await shippedNotices(order.id)
    expect(told.map((row) => row.n)).toEqual([1, 1]) // each owner told once
  })

  it('race C→P→S→R (cancel first; Amazon then reads Shipped): both released, nothing taken, the cancel stands, no notice', async () => {
    const f = await fixture(), trace: string[] = []
    const { channelId, order, ownHold } = await heldOrder(f)
    expect(await operatorCancel(f, order.id)).toMatchObject({ reservationsReleased: 2, itemsRestocked: 0, shippedBeforeCancel: false }); trace.push('C')
    expect((await shipPoll(f, channelId)).status).toBe('CANCELLED'); trace.push('P')
    await stockPageRelease(f, ownHold.id); trace.push('S')
    await reconcile(f.borrower); trace.push('R')
    expect(trace).toEqual(['C', 'P', 'S', 'R'])
    const l = await ledgerHolds(f, order.id)
    expectConsistent(l)
    expect([l.own.quantity, l.source.quantity]).toEqual([10, 10])
    expect(l.holds.map((h) => [h.consumed, h.released])).toEqual([[false, true], [false, true]])
    expect(await shippedNotices(order.id)).toHaveLength(0)
  })

  it('race S→P→R→C (a stock-page release first; the shipping read holds and takes the line again; cancel after): taken once each', async () => {
    const f = await fixture(), trace: string[] = []
    const { channelId, order, ownHold } = await heldOrder(f)
    await stockPageRelease(f, ownHold.id); trace.push('S')
    await shipPoll(f, channelId); trace.push('P')
    await reconcile(f.borrower); trace.push('R')
    expect(await operatorCancel(f, order.id)).toMatchObject({ itemsRestocked: 0, shippedBeforeCancel: true }); trace.push('C')
    expect(trace).toEqual(['S', 'P', 'R', 'C'])
    const [own] = await q<{ moved: number }>(`SELECT COALESCE(SUM(change),0)::int AS moved FROM "StockMovement" WHERE "orderId"=$1 AND "productId"=$2`, [order.id, f.own])
    expect(own.moved).toBe(-2)
    expect([await level(f.own), await level(f.source)]).toEqual([{ quantity: 8, reserved: 0, available: 8 }, { quantity: 8, reserved: 0, available: 8 }])
    expect(await q(`SELECT "consumedAt" IS NOT NULL AS consumed, "releasedAt" IS NOT NULL AS released FROM "StockReservation" WHERE "orderId"=$1 ORDER BY "createdAt"`, [order.id]))
      .toEqual([{ consumed: false, released: true }, { consumed: true, released: false }])
  })

  it('race P∥R (the poll paused after it listed its own holds; the reconcile takes them; the poll resumes): taken once', async () => {
    const f = await fixture(), trace: string[] = []
    const { channelId, order } = await heldOrder(f)
    let listed!: () => void, resume!: () => void
    const atList = new Promise<void>((r) => { listed = r }), gate = new Promise<void>((r) => { resume = r })
    upstream.afterHoldList = async (rows, args) => {
      if (args?.where?.orderId !== order.id || rows.length === 0) return
      upstream.afterHoldList = null
      trace.push('P listed'); listed(); await gate
    }
    const poll = shipPoll(f, channelId)
    void poll.catch(() => undefined)
    try {
      await atList
      await reconcile(f.borrower); trace.push('R')
      resume()
      await poll; trace.push('P done')
    } finally { upstream.afterHoldList = null; resume(); await poll.catch(() => undefined) }
    expect(trace).toEqual(['P listed', 'R', 'P done'])
    const l = await ledgerHolds(f, order.id)
    expectConsistent(l)
    expect([l.own.quantity, l.source.quantity]).toEqual([8, 8])
    expect(await consumedUnits(order.id)).toEqual([{ productId: f.own, units: 2 }, { productId: f.source, units: 2 }].sort((a, b) => (a.productId < b.productId ? -1 : 1)))
  })

  // Grant changes against a hold being made: the hold's transaction is paused right after its lock door.
  const holdPausedAfterDoor = (f: Fixture, channelId: string) => {
    let doorTaken!: () => void, resume!: () => void
    const atDoor = new Promise<void>((r) => { doorTaken = r }), gate = new Promise<void>((r) => { resume = r })
    upstream.afterRaw = async (sql) => {
      if (!sql.includes('nexus_lock_order_stock')) return
      upstream.afterRaw = null
      doorTaken(); await gate
    }
    const hold = readAmazon(f.borrower, channelId, twoEach([f.pooled]), 'stale')
    void hold.catch(() => undefined)
    return { hold, atDoor, resume }
  }
  const grantTo = (f: Fixture, status: 'paused' | 'revoked') => inContext(f.lender, f.owner, [[status === 'paused'
    ? `UPDATE "StockPoolGrant" SET status='paused',version=version+1,"pausedByUserId"=$1,"pausedAt"=now() WHERE id=$2`
    : `UPDATE "StockPoolGrant" SET status='revoked',version=version+1,"endedBySide"='owner',"endedByUserId"=$1,"endedAt"=now() WHERE id=$2`, [f.owner, f.grant]]])

  it.each(['paused', 'revoked'] as const)('race hold∥grant %s (the grant changes after the hold took its lock door, before the pool door): one hold, on own stock', async (change) => {
    const f = await fixture(), trace: string[] = [], channelId = `AMZ-${randomUUID()}`
    const { hold, atDoor, resume } = holdPausedAfterDoor(f, channelId)
    try {
      await atDoor; trace.push('H door')
      await grantTo(f, change); trace.push(`G ${change}`)
      resume()
      await hold; trace.push('H done')
    } finally { upstream.afterRaw = null; resume(); await hold.catch(() => undefined) }
    expect(trace).toEqual(['H door', `G ${change}`, 'H done'])
    // Door 2 reads the grant when it runs: no longer active, so the order is held on its own shelf. Once.
    expect([await level(f.pooled), await level(f.source)]).toEqual([{ quantity: 10, reserved: 2, available: 8 }, { quantity: 10, reserved: 0, available: 10 }])
    await readAmazon(f.borrower, channelId, twoEach([f.pooled]), 'stale')
    expect([await level(f.pooled), await level(f.source)]).toEqual([{ quantity: 10, reserved: 2, available: 8 }, { quantity: 10, reserved: 0, available: 10 }])
  })

  it('race hold→grant revoked (the grant ends after the hold committed in the pool): the order stays held in the pool, once, and ships from it', async () => {
    const f = await fixture(), trace: string[] = [], channelId = `AMZ-${randomUUID()}`
    const order = await readAmazon(f.borrower, channelId, twoEach([f.pooled]), 'stale'); trace.push('H')
    await grantTo(f, 'revoked'); trace.push('G revoked')
    await readAmazon(f.borrower, channelId, twoEach([f.pooled]), 'stale'); trace.push('H again')
    await readAmazon(f.borrower, channelId, twoEach([f.pooled]), 'shipped'); trace.push('P')
    await reconcile(f.borrower)
    expect(trace).toEqual(['H', 'G revoked', 'H again', 'P'])
    expect([await level(f.pooled), await level(f.source)]).toEqual([{ quantity: 10, reserved: 0, available: 10 }, { quantity: 8, reserved: 0, available: 8 }])
    expect(await consumedUnits(order.id)).toEqual([{ productId: f.source, units: 2 }])
  })

  // The two interleavings the race arms cannot force every time, made deterministic.
  it('a stock-page release of a hold that already shipped changes nothing', async () => {
    const f = await fixture(), channelId = `AMZ-${randomUUID()}`
    const order = await readAmazon(f.borrower, channelId, twoEach([f.own]), 'stale')
    const [hold] = await q<{ id: string }>(`SELECT id FROM "StockReservation" WHERE "orderId" = $1`, [order.id])
    await readAmazon(f.borrower, channelId, twoEach([f.own]), 'shipped')
    const { releaseReservation } = await import('./stock-level.service.js')
    await as(f.borrower, () => releaseReservation(hold.id, { actor: 'manual-release' }))
    expect(await level(f.own)).toEqual({ quantity: 8, reserved: 0, available: 8 })
    expect(await q(`SELECT "consumedAt" IS NOT NULL AS consumed, "releasedAt" IS NOT NULL AS released FROM "StockReservation" WHERE id = $1`, [hold.id])).toEqual([{ consumed: true, released: false }])
    expect(await q(`SELECT reason::text FROM "StockMovement" WHERE "reservationId" = $1 ORDER BY "createdAt"`, [hold.id])).toEqual([{ reason: 'RESERVATION_CREATED' }, { reason: 'RESERVATION_CONSUMED' }])
  })

  it('a consume that listed a hold just before a stock-page release took it back takes nothing', async () => {
    const f = await fixture(), channelId = `AMZ-${randomUUID()}`
    const order = await readAmazon(f.borrower, channelId, twoEach([f.own]), 'stale')
    const [hold] = await q<{ id: string }>(`SELECT id FROM "StockReservation" WHERE "orderId" = $1`, [order.id])
    const levels = await import('./stock-level.service.js')
    let reached!: () => void, release!: () => void
    const listed = new Promise<void>((r) => { reached = r }), gate = new Promise<void>((r) => { release = r })
    upstream.afterHoldList = async (rows, args) => {
      if (args?.where?.orderId !== order.id || !rows.some((row) => row.id === hold.id)) return
      upstream.afterHoldList = null
      reached(); await gate
    }
    const consuming = as(f.borrower, () => levels.consumeOpenOrder({ orderId: order.id, actor: 'reconcile' }))
    void consuming.catch(() => undefined)
    try {
      await listed // the consumer holds the list; the stock page releases the hold now
      await as(f.borrower, () => levels.releaseReservation(hold.id, { actor: 'manual-release' }))
      release()
      expect(await consuming).toBe(0)
    } finally { upstream.afterHoldList = null; release(); await consuming.catch(() => undefined) }
    expect(await level(f.own)).toEqual({ quantity: 10, reserved: 0, available: 10 })
    expect(await q(`SELECT "consumedAt" IS NOT NULL AS consumed, "releasedAt" IS NOT NULL AS released FROM "StockReservation" WHERE id = $1`, [hold.id])).toEqual([{ consumed: false, released: true }])
  })

  // B1 (review, HIGH): a hold decided its side outside any lock, so a link switch between that decision
  // and the own hold's commit let a second read hold the order again in the pool. The hold now runs in
  // ONE transaction behind the order-stock lock door, which holds the pool-link lock: a link switch
  // waits for the hold to commit, and the next read sees it.
  it('B1: a link created while an own hold is being made waits for it; the next read holds nothing more', async () => {
    const f = await fixture(), channelId = `AMZ-${randomUUID()}`
    const { later, laterSource } = await laterPooled(f)
    const lines = twoEach([later])
    let reached!: () => void, release!: () => void
    const created = new Promise<void>((r) => { reached = r }), gate = new Promise<void>((r) => { release = r })
    upstream.afterHoldCreate = async (row) => {
      if (row.quantity !== 2) return
      upstream.afterHoldCreate = null
      reached(); await gate
    }
    const first = readAmazon(f.borrower, channelId, lines, 'stale')
    void first.catch(() => undefined)
    const catalog = randomUUID()
    let linking: Promise<unknown> | null = null
    const other = await database.pool.connect()
    try {
      await created // the own hold is written, not committed
      await inContext(f.lender, f.owner, [[`INSERT INTO "AssortmentMember" (id,"workspaceId","assortmentId","productId",mode) VALUES ($1,$2,$3,$4,'include')`, [randomUUID(), f.lender, f.assortment, laterSource]]])
      await other.query('BEGIN')
      await other.query(`SELECT set_config('nexus.workspace_id',$1,true),set_config('nexus.actor_id',$2,true)`, [f.borrower, f.receiver])
      await other.query(`INSERT INTO "CatalogLink" (id,"shareId","sourceWorkspaceId","sourceProductId","targetWorkspaceId","targetProductId","linkedBy","sourceVersion","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,'created',1,now())`, [catalog, f.share, f.lender, laterSource, f.borrower, later])
      const pid = Number((await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      linking = other.query(`INSERT INTO "StockPoolLink" (id,"workspaceId","grantId","catalogLinkId","productId","sourceProductId","createdByUserId","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,now())`, [randomUUID(), f.borrower, f.grant, catalog, later, laterSource, f.receiver])
      void linking.catch(() => undefined)
      // The switch must wait for the hold that is being made (the pool-link lock).
      expect(await waitForBlock(pid)).toBe(true)
      release()
      const order = await first
      await linking
      await other.query('COMMIT')
      // The product sells from the pool now; the next read keeps the order where it was first held.
      await readAmazon(f.borrower, channelId, lines, 'stale')
      expect(await level(later)).toEqual({ quantity: 10, reserved: 2, available: 8 })
      expect(await level(laterSource)).toEqual({ quantity: 10, reserved: 0, available: 10 })
      await readAmazon(f.borrower, channelId, lines, 'shipped')
      await reconcile(f.borrower)
      expect(await consumedUnits(order.id)).toEqual([{ productId: later, units: 2 }])
    } finally {
      upstream.afterHoldCreate = null; release()
      await linking?.catch(() => undefined)
      await other.query('ROLLBACK').catch(() => undefined); other.release()
      await first.catch(() => undefined)
    }
  })

  // B1 (review): the own-stock consume cap counts what the order took from shared stock, and pool holds
  // are taken out first — so a product held on both sides (a pre-fix double hold, or any future path
  // that makes one) is taken at most what was ordered.
  it('B1: an order held on both ledgers for one product is taken once: the pool takes, the own hold is released as surplus', async () => {
    const f = await fixture(), channelId = `AMZ-${randomUUID()}`
    const order = await readAmazon(f.borrower, channelId, twoEach([f.pooled]), 'stale')
    expect(await level(f.source)).toEqual({ quantity: 10, reserved: 2, available: 8 })
    // The double hold the old path could make: the same order held again on the borrower's own shelf.
    const [lvl] = await q<{ id: string }>(`SELECT id FROM "StockLevel" WHERE "productId" = $1`, [f.pooled])
    await q(`INSERT INTO "StockReservation" (id,"workspaceId","stockLevelId",quantity,"orderId",reason,kind,"expiresAt") VALUES ($1,$2,$3,2,$4,'OPEN_ORDER','HARD',now() + interval '1 year')`, [randomUUID(), f.borrower, lvl.id, order.id])
    await q(`UPDATE "StockLevel" SET reserved = reserved + 2, available = available - 2 WHERE id = $1`, [lvl.id])
    await q(`UPDATE "Order" SET status = 'SHIPPED' WHERE id = $1`, [order.id])
    await reconcile(f.borrower)
    expect(await level(f.source)).toEqual({ quantity: 8, reserved: 0, available: 8 })
    expect(await level(f.pooled)).toEqual({ quantity: 10, reserved: 0, available: 10 })
    expect(await consumedUnits(order.id)).toEqual([{ productId: f.source, units: 2 }])
    expect(await q(`SELECT "releasedAt" IS NOT NULL AS released FROM "StockReservation" WHERE "orderId" = $1`, [order.id])).toEqual([{ released: true }])
  })

  // B2 (review): the lock door locked the sources of ACTIVE links only, while doors 3/4a lock the source
  // of every open pool hold. An order whose link ended took its product first and the lender's source
  // later — against every writer that locks one sorted set (source before product here): a deadlock.
  // The door now locks the sources of all the product's links, so both take the source first.
  it('B2: taking out a pool hold whose link ended does not deadlock against a writer locking in sorted order', async () => {
    const f = await fixture({ source: `0${randomUUID().slice(1)}`, pooled: `f${randomUUID().slice(1)}` })
    const channelId = `AMZ-${randomUUID()}`
    const order = await readAmazon(f.borrower, channelId, twoEach([f.pooled]), 'stale')
    expect(await level(f.source)).toEqual({ quantity: 10, reserved: 2, available: 8 })
    await inContext(f.lender, f.owner, [[`UPDATE "StockPoolGrant" SET status='revoked',version=version+1,"endedBySide"='owner',"endedByUserId"=$1,"endedAt"=now() WHERE id=$2`, [f.owner, f.grant]]])
    const levels = await import('./stock-level.service.js')
    let doorTaken!: () => void, resume!: () => void
    const took = new Promise<void>((r) => { doorTaken = r }), gate = new Promise<void>((r) => { resume = r })
    const writer = as(f.borrower, () => database.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT nexus_lock_order_stock(${[f.pooled]}::text[])`
      doorTaken(); await gate
      return levels.consumeOpenOrderInTx(tx, { orderId: order.id, actor: 'test' })
    }, { isolationLevel: 'ReadCommitted', timeout: 30_000 }))
    void writer.catch(() => undefined)
    const other = await database.pool.connect()
    try {
      await took
      await other.query('BEGIN')
      const pid = Number((await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      const sorted = (async () => {
        await other.query(`SELECT id FROM "Product" WHERE id = $1 FOR NO KEY UPDATE`, [f.source])
        await other.query(`SELECT id FROM "Product" WHERE id = $1 FOR NO KEY UPDATE`, [f.pooled])
      })()
      void sorted.catch(() => undefined)
      expect(await waitForBlock(pid)).toBe(true) // the sorted writer waits on the order writer
      resume()
      const outcomes = await Promise.allSettled([writer, sorted])
      expect(outcomes.map((o) => (o.status === 'rejected' ? String((o as PromiseRejectedResult).reason) : 'ok'))).toEqual(['ok', 'ok'])
      await other.query('COMMIT')
    } finally {
      resume()
      await other.query('ROLLBACK').catch(() => undefined); other.release()
      await writer.catch(() => undefined)
    }
    expect(await level(f.source)).toEqual({ quantity: 8, reserved: 0, available: 8 })
    expect(await consumedUnits(order.id)).toEqual([{ productId: f.source, units: 2 }])
  })

  // B4 (review): shipment evidence read only the borrower's own ledger, while door 5 counts consumed
  // pool holds as taken: an order whose only trace of shipping is a consumed POOL hold was "not shipped",
  // and a cancellation put the shipped units back into the lender's stock.
  it('B4: a cancellation after a pool hold was taken out (shipped) puts nothing back, even with no shipped time on the order', async () => {
    const f = await fixture(), channelId = `AMZ-${randomUUID()}`
    const order = await readAmazon(f.borrower, channelId, twoEach([f.pooled]), 'stale')
    await readAmazon(f.borrower, channelId, twoEach([f.pooled]), 'shipped')
    expect(await level(f.source)).toEqual({ quantity: 8, reserved: 0, available: 8 })
    // Only the pool ledger shows the shipment now.
    await q(`UPDATE "Order" SET "shippedAt" = NULL, "deliveredAt" = NULL, status = 'CANCELLED', "cancelledAt" = now() WHERE id = $1`, [order.id])
    expect(await as(f.borrower, () => cancellation.handleOrderCancelled(order.id))).toMatchObject({ itemsRestocked: 0, shippedBeforeCancel: true, errors: [] })
    expect(await level(f.source)).toEqual({ quantity: 8, reserved: 0, available: 8 })
    expect(await q(`SELECT id FROM "StockMovement" WHERE "consumerOrderRef" = $1 AND reason = 'ORDER_CANCELLED'`, [order.id])).toEqual([])
  })

  it('B4: a Shopify order created already fulfilled records when it shipped', async () => {
    const f = await fixture(), shopifyId = String(Date.now()) + String(Math.floor(Math.random() * 1e6))
    const order = await readShopify(f.borrower, shopifyId, [{ sku: f.own, quantity: 2 }], 'fulfilled', true)
    expect(order.status).toBe('SHIPPED')
    expect(await q(`SELECT "shippedAt" IS NOT NULL AS shipped FROM "Order" WHERE id = $1`, [order.id])).toEqual([{ shipped: true }])
    expect(await level(f.own)).toEqual({ quantity: 8, reserved: 0, available: 8 })
  })

  // C6 (review): a pool hold that was given back pinned the order to the pool forever (released own
  // holds never did): once the product left the pool, the order could not be held anywhere.
  it('C6: a pool hold that was given back does not pin the order: once the product leaves the pool, it is held on its own shelf', async () => {
    const f = await fixture(), channelId = `AMZ-${randomUUID()}`, lines = twoEach([f.pooled])
    const order = await readAmazon(f.borrower, channelId, lines, 'stale')
    const { releaseOpenOrder } = await import('./stock-level.service.js')
    expect(await as(f.borrower, () => releaseOpenOrder({ orderId: order.id, actor: 'test' }))).toBe(1)
    expect(await level(f.source)).toEqual({ quantity: 10, reserved: 0, available: 10 })
    await grantTo(f, 'revoked')
    await readAmazon(f.borrower, channelId, lines, 'stale')
    expect([await level(f.pooled), await level(f.source)]).toEqual([{ quantity: 10, reserved: 2, available: 8 }, { quantity: 10, reserved: 0, available: 10 }])
    await readAmazon(f.borrower, channelId, lines, 'shipped')
    await reconcile(f.borrower)
    expect(await consumedUnits(order.id)).toEqual([{ productId: f.pooled, units: 2 }])
  })

  // C1 (review 2026-09-26) — a cancellation or refund after a PARTIAL shipment: the channel's line data
  // says which units shipped. Those are taken, the rest given back; with no line data the hold is kept.
  it('C1 Shopify: fulfilments say which units shipped; a refund after a partial fulfilment takes those, releases the rest, and is told as a refund', async () => {
    const f = await fixture(), shopifyId = String(Date.now()) + String(Math.floor(Math.random() * 1e6))
    const base = { id: shopifyId, created_at: '2026-09-25T00:00:00Z', total_price: '30', currency: 'EUR', line_items: [{ id: `${shopifyId}-L0`, sku: f.own, quantity: 3, price: '10' }] }
    const fulfilments = [{ id: 1, status: 'success', line_items: [{ id: `${shopifyId}-L0`, quantity: 1 }] }]
    await as(f.borrower, () => shopify.handleOrderCreate({ ...base, updated_at: '2026-09-25T01:00:00Z', financial_status: 'paid', fulfillment_status: null } as never))
    expect(await level(f.own)).toEqual({ quantity: 10, reserved: 3, available: 7 })
    await as(f.borrower, () => shopify.handleOrderUpdate({ ...base, updated_at: '2026-09-25T02:00:00Z', financial_status: 'paid', fulfillment_status: 'partial', fulfillments: fulfilments } as never))
    // Re-review (2026-09-26): the partial fulfilment's unit is taken when it is read; the rest stays held.
    expect(await level(f.own)).toEqual({ quantity: 9, reserved: 2, available: 7 })
    await as(f.borrower, () => shopify.handleOrderUpdate({ ...base, updated_at: '2026-09-25T03:00:00Z', financial_status: 'refunded', fulfillment_status: 'partial', fulfillments: fulfilments } as never))
    const [order] = await q<{ id: string; status: string }>(`SELECT id, status::text FROM "Order" WHERE "workspaceId"=$1 AND channel='SHOPIFY' AND "channelOrderId"=$2`, [f.borrower, shopifyId])
    expect(order.status).toBe('CANCELLED')
    await vi.waitFor(async () => expect(await shippedNotices(order.id)).toHaveLength(2))
    await as(f.borrower, () => cancellation.handleOrderCancelled(order.id))
    await reconcile(f.borrower)
    expect(await level(f.own)).toEqual({ quantity: 9, reserved: 0, available: 9 })
    expect(await consumedUnits(order.id)).toEqual([{ productId: f.own, units: 1 }])
    const [notice] = await q<{ title: string; body: string }>(`SELECT title, body FROM "Notification" WHERE type='channel-order-cancelled-after-shipment' AND "entityId"=$1 LIMIT 1`, [order.id])
    expect(notice).toEqual({ title: `SHOPIFY order ${shopifyId} was refunded after (part of) it shipped`,
      body: 'Nothing that shipped was put back into stock; when a parcel comes back, book it in as a return to put its units back. 2 units that had not shipped were put back on sale.' })
  })

  // Re-review (2026-09-26): Shopify's own sequence. `fulfillments/create` arrives for each fulfilment; the
  // first one set the whole order SHIPPED and took every hold, so a refund after a PARTIAL fulfilment
  // found nothing left to give back. Now each fulfilment takes only its units, line by line.
  const shopifyOrderOf = async (f: Fixture, shopifyId: string) => (await q<{ id: string; status: string; shipped: boolean }>(
    `SELECT id, status::text AS status, "shippedAt" IS NOT NULL AS shipped FROM "Order" WHERE "workspaceId"=$1 AND channel='SHOPIFY' AND "channelOrderId"=$2`, [f.borrower, shopifyId]))[0]
  const fulfil = (f: Fixture, payload: Record<string, unknown>) => as(f.borrower, () => shopify.handleFulfillmentCreate(payload as never))

  it('C1 Shopify fulfillments/create: a partial fulfilment takes only its units and keeps the rest held; duplicate deliveries take nothing; the refund gives back the rest', async () => {
    const f = await fixture(), shopifyId = String(Date.now()) + String(Math.floor(Math.random() * 1e6)), lineId = `${shopifyId}-L0`
    const base = { id: shopifyId, created_at: '2026-09-25T00:00:00Z', total_price: '30', currency: 'EUR', line_items: [{ id: lineId, sku: f.own, quantity: 3, price: '10' }] }
    await as(f.borrower, () => shopify.handleOrderCreate({ ...base, updated_at: '2026-09-25T01:00:00Z', financial_status: 'paid', fulfillment_status: null } as never))
    expect(await level(f.own)).toEqual({ quantity: 10, reserved: 3, available: 7 })
    const first = { id: 7001, order_id: shopifyId, status: 'success', created_at: '2026-09-25T02:00:00Z', line_items: [{ id: lineId, quantity: 1 }] }
    await fulfil(f, first)
    expect(await level(f.own)).toEqual({ quantity: 9, reserved: 2, available: 7 })
    expect(await shopifyOrderOf(f, shopifyId)).toMatchObject({ status: 'PARTIALLY_SHIPPED', shipped: true })
    await Promise.all([fulfil(f, first), fulfil(f, first), fulfil(f, first)])
    expect(await level(f.own)).toEqual({ quantity: 9, reserved: 2, available: 7 })
    const order = await shopifyOrderOf(f, shopifyId)
    expect(await consumedUnits(order.id)).toEqual([{ productId: f.own, units: 1 }])
    // Refunded in Shopify: its orders/updated lists the one fulfilment.
    await as(f.borrower, () => shopify.handleOrderUpdate({ ...base, updated_at: '2026-09-25T03:00:00Z', financial_status: 'refunded', fulfillment_status: 'partial', fulfillments: [first] } as never))
    expect((await shopifyOrderOf(f, shopifyId)).status).toBe('CANCELLED')
    await vi.waitFor(async () => expect(await shippedNotices(order.id)).toHaveLength(2))
    await as(f.borrower, () => cancellation.handleOrderCancelled(order.id))
    await reconcile(f.borrower)
    expect(await level(f.own)).toEqual({ quantity: 9, reserved: 0, available: 9 })
    expect(await consumedUnits(order.id)).toEqual([{ productId: f.own, units: 1 }])
    const [notice] = await q<{ title: string; body: string }>(`SELECT title, body FROM "Notification" WHERE type='channel-order-cancelled-after-shipment' AND "entityId"=$1 LIMIT 1`, [order.id])
    expect(notice).toEqual({ title: `SHOPIFY order ${shopifyId} was refunded after (part of) it shipped`,
      body: 'Nothing that shipped was put back into stock; when a parcel comes back, book it in as a return to put its units back. 2 units that had not shipped were put back on sale.' })
  })

  it('C1 Shopify fulfillments/create: a second fulfilment completes the order — each takes its own units, shared stock when its line is complete; SHIPPED once, taken once', async () => {
    const f = await fixture(), shopifyId = String(Date.now()) + String(Math.floor(Math.random() * 1e6))
    const own = `${shopifyId}-L0`, pooled = `${shopifyId}-L1`
    const base = { id: shopifyId, created_at: '2026-09-25T00:00:00Z', total_price: '30', currency: 'EUR',
      line_items: [{ id: own, sku: f.own, quantity: 2, price: '10' }, { id: pooled, sku: f.pooled, quantity: 1, price: '10' }] }
    await as(f.borrower, () => shopify.handleOrderCreate({ ...base, updated_at: '2026-09-25T01:00:00Z', financial_status: 'paid', fulfillment_status: null } as never))
    expect([await level(f.own), await level(f.source)]).toEqual([{ quantity: 10, reserved: 2, available: 8 }, { quantity: 10, reserved: 1, available: 9 }])
    // The first fulfilment completes the pooled line (its pool hold is taken whole) and half the own line.
    const a = { id: 8001, order_id: shopifyId, status: 'success', line_items: [{ id: own, quantity: 1 }, { id: pooled, quantity: 1 }] }
    const b = { id: 8002, order_id: shopifyId, status: 'success', line_items: [{ id: own, quantity: 1 }] }
    await fulfil(f, a)
    expect([await level(f.own), await level(f.source)]).toEqual([{ quantity: 9, reserved: 1, available: 8 }, { quantity: 9, reserved: 0, available: 9 }])
    expect((await shopifyOrderOf(f, shopifyId)).status).toBe('PARTIALLY_SHIPPED')
    await fulfil(f, b)
    await fulfil(f, b)
    expect([await level(f.own), await level(f.source)]).toEqual([{ quantity: 8, reserved: 0, available: 8 }, { quantity: 9, reserved: 0, available: 9 }])
    expect((await shopifyOrderOf(f, shopifyId)).status).toBe('SHIPPED')
    // Shopify's orders/updated for the completed order takes nothing more.
    await as(f.borrower, () => shopify.handleOrderUpdate({ ...base, updated_at: '2026-09-25T04:00:00Z', financial_status: 'paid', fulfillment_status: 'fulfilled', fulfillments: [a, b] } as never))
    expect([await level(f.own), await level(f.source)]).toEqual([{ quantity: 8, reserved: 0, available: 8 }, { quantity: 9, reserved: 0, available: 9 }])
    const order = await shopifyOrderOf(f, shopifyId)
    expect(order.status).toBe('SHIPPED')
    expect(await consumedUnits(order.id)).toEqual([{ productId: f.own, units: 2 }, { productId: f.source, units: 1 }].sort((x, y) => (x.productId < y.productId ? -1 : 1)))
  })

  // Re-review (2026-09-26): a pool hold kept for lack of line data has a way out. The lender's stock
  // page lists it with a Release action (with its confirmation); that action now works for exactly this
  // case — the borrowing business's order is cancelled or refunded — for the lender only, audited.
  it('C1 pool kept: the lender releases the kept hold from its stock page once the order is cancelled; never while it is open, never twice, never the borrower', async () => {
    const f = await fixture(), channelId = `AMZ-${randomUUID()}`, lines = [{ sku: f.pooled, quantity: 2 }]
    await readAmazon(f.borrower, channelId, lines, 'stale')
    const order = await readAmazon(f.borrower, channelId, lines, 'partial')
    const [hold] = await q<{ id: string }>(`SELECT id FROM "StockReservation" WHERE "consumerOrderRef"=$1`, [order.id])
    const { releaseReservationFromStockPage } = await import('./stock-level.service.js')
    const [lenderMember] = await q<{ id: string }>(`SELECT id FROM "WorkspaceMembership" WHERE "workspaceId"=$1 AND "userId"=$2`, [f.lender, f.owner])
    const asLender = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: f.lender, actorUserId: f.owner, membershipId: lenderMember.id, roleKeys: ['OWNER'] }, work)
    // The order is still open: the lender cannot take the hold away from it.
    await expect(asLender(() => releaseReservationFromStockPage(hold.id, { actor: 'manual-release' }))).rejects.toMatchObject({ code: 'pool_hold' })
    expect(await level(f.source)).toEqual({ quantity: 10, reserved: 2, available: 8 })
    const cancelled = await readAmazon(f.borrower, channelId, lines, 'cancelled')
    expect(cancelled.status).toBe('CANCELLED')
    await vi.waitFor(async () => expect(await shippedNotices(order.id)).toHaveLength(2))
    await as(f.borrower, () => cancellation.handleOrderCancelled(order.id))
    await reconcile(f.borrower)
    expect(await level(f.source)).toEqual({ quantity: 10, reserved: 2, available: 8 })
    const [notice] = await q<{ body: string }>(`SELECT body FROM "Notification" WHERE type='channel-order-cancelled-after-shipment' AND "entityId"=$1 LIMIT 1`, [order.id])
    expect(notice.body).toContain(`so they stay held in shared stock for this order. If they did not ship, ask the business that lends you this stock to release this order's hold on its Stock → Reservations page.`)
    // The borrower cannot see, so cannot release, the lender's row.
    await expect(as(f.borrower, () => releaseReservationFromStockPage(hold.id, { actor: 'manual-release' }))).rejects.toThrow(/not found/)
    await expect(asLender(() => releaseReservationFromStockPage(hold.id, { actor: 'manual-release' }))).resolves.toMatchObject({ id: hold.id })
    expect(await level(f.source)).toEqual({ quantity: 10, reserved: 0, available: 10 })
    await asLender(() => releaseReservationFromStockPage(hold.id, { actor: 'manual-release' }))
    expect(await level(f.source)).toEqual({ quantity: 10, reserved: 0, available: 10 })
    expect(await q(`SELECT change, reason::text AS reason, actor, "consumerOrderRef" = $2 AS "forOrder", notes FROM "StockMovement" WHERE "reservationId"=$1 AND reason='RESERVATION_RELEASED'`, [hold.id, order.id]))
      .toEqual([{ change: 0, reason: 'RESERVATION_RELEASED', actor: 'manual-release', forOrder: true,
        notes: 'Released by the lender from its stock page: the borrowing business cancelled or refunded the order and could not tell whether these units shipped' }])
  })

  // DB/locks re-review (2026-09-26): a cancellation locked its line and own-hold products, then door 3
  // gave back EVERY pool hold of the order, including one whose product is on no line: its source was
  // locked late, out of order. Forced: the settlement pauses right after its lock door; an order writer
  // then locks [source, own] in sorted order. Before, the writer took the source and waited on own, and
  // the settlement then waited on the source: a deadlock. Now the lock door locks the sources of the
  // order's open pool holds too, so the writer waits for the whole settlement.
  it('lock gap: a cancellation locks the source of a pool hold whose product is on no line, before door 3 (forced deadlock shape)', async () => {
    const f = await fixture({ source: `00000000-${randomUUID().slice(9)}` }), trace: string[] = []
    expect(f.source < f.own).toBe(true)
    const channelId = `AMZ-${randomUUID()}`
    const order = await readAmazon(f.borrower, channelId, twoEach([f.own, f.pooled]), 'stale')
    expect([await level(f.own), await level(f.source)]).toEqual([{ quantity: 10, reserved: 2, available: 8 }, { quantity: 10, reserved: 2, available: 8 }])
    // The pooled line is unlinked later (its SKU changed): its pool hold now matches no line.
    await q(`UPDATE "OrderItem" SET "productId"=NULL WHERE "orderId"=$1 AND "productId"=$2`, [order.id, f.pooled])
    await q(`UPDATE "Order" SET status='CANCELLED', "cancelledAt"=now() WHERE id=$1`, [order.id])
    let locked!: () => void, resume!: () => void
    const atLock = new Promise<void>((r) => { locked = r }), gate = new Promise<void>((r) => { resume = r })
    upstream.afterRaw = async (sql) => {
      if (!sql.includes('nexus_lock_order_stock')) return
      upstream.afterRaw = null
      trace.push('settlement locked'); locked(); await gate
    }
    const settling = as(f.borrower, () => cancellation.handleOrderCancelled(order.id))
    void settling.catch(() => undefined)
    const writer = await database.pool.connect()
    let writerError: unknown = null
    try {
      await atLock
      await writer.query('BEGIN')
      await writer.query(`SELECT set_config('nexus.workspace_id',$1,true),set_config('nexus.actor_id',$2,true)`, [f.borrower, f.receiver])
      const [{ pid }] = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows
      const writing = writer.query('SELECT nexus_lock_order_stock($1::text[])', [[f.pooled, f.own]]).then(() => { trace.push('writer locked') }, (error) => { writerError = error })
      expect(await waitForBlock(pid)).toBe(true)
      trace.push('writer waits')
      resume()
      const result = await settling
      await writing
      if (!writerError) await writer.query('COMMIT')
      expect(result).toMatchObject({ reservationsReleased: 2, errors: [] })
    } finally {
      upstream.afterRaw = null; resume()
      await writer.query('ROLLBACK').catch(() => undefined)
      writer.release()
      await settling.catch(() => undefined)
    }
    expect(writerError).toBeNull()
    // The writer waited for the whole settlement (blocked before it resumed, locked only after it ended).
    expect(trace).toEqual(['settlement locked', 'writer waits', 'writer locked'])
    expect([await level(f.own), await level(f.source)]).toEqual([{ quantity: 10, reserved: 0, available: 10 }, { quantity: 10, reserved: 0, available: 10 }])
  })

  it('C1 pool: a partly shipped Amazon order cancelled — the shipped unit is taken from shared stock, the rest put back; with no line data the pool hold is kept, also by the reconcile', async () => {
    const f = await fixture(), known = `AMZ-${randomUUID()}`, unknown = `AMZ-${randomUUID()}`
    const settled = async (channelId: string, lines: Array<{ sku: string; quantity: number; shipped?: number }>) => {
      await readAmazon(f.borrower, channelId, lines, 'stale')
      await readAmazon(f.borrower, channelId, lines, 'partial')
      const order = await readAmazon(f.borrower, channelId, lines, 'cancelled')
      expect(order.status).toBe('CANCELLED')
      await vi.waitFor(async () => expect(await shippedNotices(order.id)).toHaveLength(2))
      await as(f.borrower, () => cancellation.handleOrderCancelled(order.id))
      await reconcile(f.borrower)
      return order
    }
    const first = await settled(known, [{ sku: f.pooled, quantity: 2, shipped: 1 }])
    expect(await level(f.source)).toEqual({ quantity: 9, reserved: 0, available: 9 })
    expect(await q(`SELECT change, reason::text AS reason FROM "StockMovement" WHERE "consumerOrderRef"=$1 AND change <> 0 ORDER BY change`, [first.id]))
      .toEqual([{ change: -2, reason: 'RESERVATION_CONSUMED' }, { change: 1, reason: 'ORDER_CANCELLED' }])
    const second = await settled(unknown, [{ sku: f.pooled, quantity: 2 }])
    expect(await level(f.source)).toEqual({ quantity: 9, reserved: 2, available: 7 })
    const [notice] = await q<{ body: string }>(`SELECT body FROM "Notification" WHERE type='channel-order-cancelled-after-shipment' AND "entityId"=$1 LIMIT 1`, [second.id])
    expect(notice.body).toBe(`Nothing that shipped was put back into stock; when a parcel comes back, book it in as a return to put its units back. Nexus cannot tell from AMAZON whether 2 × ${f.pooled} shipped, so they stay held in shared stock for this order. If they did not ship, ask the business that lends you this stock to release this order's hold on its Stock → Reservations page.`)
  })

  // The same settlement when only the hourly reconcile sees the cancellation (the cascade never ran): the
  // pool hold is taken whole and the unshipped rest put back by the settlement itself, once.
  it('C1 pool: the reconcile alone settles a partly shipped pooled order — the shipped unit taken, the rest put back, once', async () => {
    const f = await fixture(), channelId = `AMZ-${randomUUID()}`, lines = [{ sku: f.pooled, quantity: 2, shipped: 1 }]
    await readAmazon(f.borrower, channelId, lines, 'stale')
    const order = await readAmazon(f.borrower, channelId, lines, 'partial')
    expect(await level(f.source)).toEqual({ quantity: 10, reserved: 2, available: 8 })
    await q(`UPDATE "Order" SET status='CANCELLED', "cancelledAt"=now() WHERE id=$1`, [order.id])
    await reconcile(f.borrower)
    await reconcile(f.borrower)
    expect(await level(f.source)).toEqual({ quantity: 9, reserved: 0, available: 9 })
    expect(await q(`SELECT change, reason::text AS reason FROM "StockMovement" WHERE "consumerOrderRef"=$1 AND change <> 0 ORDER BY change`, [order.id]))
      .toEqual([{ change: -2, reason: 'RESERVATION_CONSUMED' }, { change: 1, reason: 'ORDER_CANCELLED' }])
    expect(await shippedNotices(order.id)).toHaveLength(2)
  })

  // C5 (review 2026-09-26) — Shopify's own restock of a refunded unit arrives through its inventory
  // webhook and is applied to the Shopify location, a channel-side mirror that is not part of the stock
  // that sells (Product.totalStock is warehouses only); the booked-in return restocks the warehouse. One
  // physical unit is therefore counted once in what Nexus sells.
  it('C5 Shopify: its own restock (inventory webhook, auto-applied) and a booked-in return count the unit once in the stock that sells', async () => {
    const f = await fixture(), shopifyId = String(Date.now()) + String(Math.floor(Math.random() * 1e6))
    const shopLocation = randomUUID(), externalLocation = String(Math.floor(Math.random() * 1e9)), inventoryItem = String(Math.floor(Math.random() * 1e9))
    await q(`INSERT INTO "StockLocation" (id,"workspaceId",type,code,name,"externalChannel","externalLocationId","updatedAt") VALUES ($1,$2,'SHOPIFY_LOCATION',$3,'Shopify shop','SHOPIFY',$4,now())`, [shopLocation, f.borrower, `SHOPIFY-${externalLocation}`, externalLocation])
    await q(`INSERT INTO "ChannelListing" (id,"workspaceId","productId","channelMarket",channel,region,"platformAttributes","updatedAt") VALUES ($1,$2,$3,'SHOPIFY_IT','SHOPIFY','IT',$4::jsonb,now())`, [randomUUID(), f.borrower, f.own, JSON.stringify({ inventoryItemId: inventoryItem })])
    const counts = async () => {
      const [row] = await q<{ warehouse: number; shopify: number; total: number }>(`SELECT
        (SELECT quantity FROM "StockLevel" WHERE "productId"=$1 AND "locationId"=$2) AS warehouse,
        (SELECT quantity FROM "StockLevel" WHERE "productId"=$1 AND "locationId"=$3) AS shopify,
        (SELECT "totalStock" FROM "Product" WHERE id=$1) AS total`, [f.own, f.ownLocation, shopLocation])
      return row
    }
    await readShopify(f.borrower, shopifyId, [{ sku: f.own, quantity: 1 }], 'paid', true)
    const order = await readShopify(f.borrower, shopifyId, [{ sku: f.own, quantity: 1 }], 'fulfilled')
    // Shopify's location follows the sale (its own count, mirrored).
    await q(`INSERT INTO "StockLevel" (id,"workspaceId","locationId","productId",quantity,reserved,available,"lastUpdatedAt") VALUES ($1,$2,$3,$4,9,0,9,now())`, [randomUUID(), f.borrower, shopLocation, f.own])
    expect(await counts()).toEqual({ warehouse: 9, shopify: 9, total: 9 })
    // Refunded in Shopify with restock: Shopify's count goes to 10 and its webhook is applied (drift 1).
    await as(f.borrower, () => shopify.handleInventoryUpdate({ inventory_item_id: Number(inventoryItem), location_id: Number(externalLocation), available: 10, updated_at: '2026-09-25T05:00:00Z' } as never))
    expect(await counts()).toEqual({ warehouse: 9, shopify: 10, total: 9 })
    expect(await q(`SELECT status::text AS status FROM "ChannelStockEvent" WHERE "productId"=$1`, [f.own])).toEqual([{ status: 'AUTO_APPLIED' }])
    // The parcel is booked in as a return: the unit is back in the warehouse, and counted once.
    const returnId = randomUUID()
    await q(`INSERT INTO "Return" (id,"workspaceId","orderId",channel,"updatedAt") VALUES ($1,$2,$3,'SHOPIFY',now())`, [returnId, f.borrower, order.id])
    const { applyStockMovement } = await import('./stock-movement.service.js')
    await as(f.borrower, () => applyStockMovement({ productId: f.own, locationId: f.ownLocation, change: 1, reason: 'RETURN_RESTOCKED', referenceType: 'Return', referenceId: returnId, actor: 'return-restock' }))
    expect(await counts()).toEqual({ warehouse: 10, shopify: 10, total: 10 })
  })
})
