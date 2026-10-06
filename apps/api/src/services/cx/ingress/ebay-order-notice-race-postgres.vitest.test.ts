/**
 * A signed ORDER_CONFIRMATION notice and the 5-minute poll write the SAME eBay order at the same
 * moment, on a real multi-connection PostgreSQL as a production-equivalent owner. The notice runs
 * its whole path (signed admission → routing by seller id → stored receipt → claim → one order read
 * with the account's own token → shared writer); the poll runs ingestEbayOrder, exactly as
 * EbayOrdersService.processOrder does. Expected for own stock AND for stock borrowed from another
 * business's pool: one order, each line once, the stock taken once.
 *
 * The race is forced, not hoped for: a holder locks the order's Product rows, both writers are
 * started and seen WAITING (pg_blocking_pids) before it lets go, in both arrival orders. eBay also
 * sends one ORDER_CONFIRMATION per line item, so the last case races two notices of one order with
 * the poll. Needs NEXUS_TEST_CONCURRENT_PG_URL; run by scripts/run-real-postgres-tests.mjs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => (database.client as any)[key] }) }))
vi.mock('./ebay-signature.js', () => ({ verifyEbayNotification: async () => ({ ok: true, reason: 'ok', kid: 'synthetic-public-key' }) }))
vi.mock('../apps.service.js', () => ({ getChannelApp: async () => ({ clientId: 'synthetic-app', clientSecret: 'synthetic-secret' }) }))
vi.mock('../../monitoring/alert.service.js', () => ({ alertService: { createAlert: vi.fn() }, AlertType: { CONNECTION_HEALTH: 'CONNECTION_HEALTH' } }))
vi.mock('../../../lib/cron/clustered.js', () => ({ default: {} }))
vi.mock('../../../utils/cron-observability.js', () => ({ recordCronRun: vi.fn() }))
vi.mock('../../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []) }
  return { addJobSafely: vi.fn(async () => undefined), outboundSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, channelSyncQueue: queue, bulkJobQueue: queue, redis: { connection: null } }
})
vi.mock('../../advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(), peekCached: async () => undefined, putCached: () => undefined, flushAdsCache: async () => undefined,
}))
const { storeGrant } = await import('../token.service.js')
const { receiveEbayNotice } = await import('./ebay-admission.js')
const { processEbayInbound } = await import('./ebay-processing.js')
const { ingestEbayOrder } = await import('../../ebay-order-writer.js')

const q = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const as = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const inContext = async (workspaceId: string, actor: string, statements: Array<[string, unknown[]]>) => {
  const client = await database.pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('nexus.workspace_id', $1, true), set_config('nexus.actor_id', $2, true)`, [workspaceId, actor])
    for (const [sql, params] of statements) await client.query(sql, params)
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

/** eBay's Fulfillment order, read back by the notice and listed by the poll: the same body. */
const fulfillmentOrder = (orderId: string, skus: string[]) => ({
  orderId, creationDate: '2026-10-06T09:15:00.000Z', orderPaymentStatus: 'PAID', orderFulfillmentStatus: 'NOT_STARTED',
  buyer: { username: 'race.buyer' }, pricingSummary: { total: { value: '20.00', currency: 'EUR' } },
  lineItems: skus.map((sku, i) => ({ lineItemId: `${orderId}-L${i + 1}`, sku, title: sku, quantity: 1, lineItemCost: { value: '10.00', currency: 'EUR' } })),
})
const orderUrl = (orderId: string) => `https://api.ebay.com/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}`
let served: Record<string, unknown> = {}
const reads: string[] = []
const fetchMock = vi.fn(async (input: unknown) => {
  const url = String(input)
  reads.push(url)
  const body = Object.entries(served).find(([orderId]) => url === orderUrl(orderId))?.[1]
  return new Response(JSON.stringify(body ?? {}), { status: body ? 200 : 404, headers: { 'Content-Type': 'application/json' } })
})

/** The signed body eBay POSTs: one notice per line item, each with its own notificationId. */
const signedNotice = (sellerId: string, orderId: string, line: string) => Buffer.from(JSON.stringify({
  metadata: { topic: 'ORDER_CONFIRMATION', schemaVersion: '1.0', deprecated: false },
  notification: { notificationId: randomUUID(), eventDate: '2026-10-06T09:15:00.000Z', publishDate: '2026-10-06T09:15:01.000Z', publishAttemptCount: 1,
    data: { user: { userId: sellerId, username: 'race-seller' }, order: { orderId, orderLineItems: [{ orderLineItemId: line, listingId: '101', quantity: 1 }] } } },
}))

let role = ''
/** Business A lends product x to business B (B's bx follows A's x); B also has its own product own. B sells on eBay. */
async function fixture() {
  const key = randomUUID().slice(0, 8), a = `race-a-${key}`, b = `race-b-${key}`, ownerA = randomUUID(), ownerB = randomUUID()
  const x = `X-${key}`, bx = `BX-${key}`, own = `OWN-${key}`, locationA = randomUUID(), locationB = randomUUID()
  for (const [workspace, owner, location] of [[a, ownerA, locationA], [b, ownerB, locationB]]) {
    await q(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1,$1,'active','test',$1,now())`, [workspace])
    await q(`INSERT INTO "UserProfile" (id,email,status,"updatedAt") VALUES ($1,$2,'active',now())`, [owner, `${owner}@example.test`])
    const warehouse = randomUUID()
    await q(`INSERT INTO "Warehouse" (id,"workspaceId",code,name,country,"isDefault","updatedAt") VALUES ($1,$2,'MAIN','Main','IT',true,now())`, [warehouse, workspace])
    await q(`INSERT INTO "StockLocation" (id,"workspaceId",type,code,name,"warehouseId","updatedAt") VALUES ($1,$2,'WAREHOUSE','MAIN','Main',$3,now())`, [location, workspace, warehouse])
  }
  for (const workspace of [a, b]) for (const owner of [ownerA, ownerB]) {
    const member = randomUUID()
    await q(`INSERT INTO "WorkspaceMembership" (id,"workspaceId","userId",status,"updatedAt") VALUES ($1,$2,$3,'active',now())`, [member, workspace, owner])
    await q(`INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)`, [member, role])
  }
  for (const [id, workspace, location] of [[x, a, locationA], [bx, b, locationB], [own, b, locationB]]) {
    await q(`INSERT INTO "Product" (id,"workspaceId",sku,name,"basePrice","totalStock","updatedAt") VALUES ($1,$2,$1,$1,10,10,now())`, [id, workspace])
    await q(`INSERT INTO "StockLevel" (id,"workspaceId","locationId","productId",quantity,reserved,available,"lastUpdatedAt") VALUES ($1,$2,$3,$4,10,0,10,now())`, [randomUUID(), workspace, location, id])
  }
  const assortment = randomUUID(), share = randomUUID(), grant = randomUUID(), catalog = randomUUID()
  await inContext(a, ownerA, [
    [`INSERT INTO "Assortment" (id,"workspaceId",name,selection,"updatedAt") VALUES ($1,$2,'Pool','list',now())`, [assortment, a]],
    [`INSERT INTO "AssortmentMember" (id,"workspaceId","assortmentId","productId",mode) VALUES ($1,$2,$3,$4,'include')`, [randomUUID(), a, assortment, x]],
    [`INSERT INTO "AssortmentShare" (id,"assortmentId","ownerWorkspaceId","workspaceId","fieldGroups","createdByUserId","updatedAt") VALUES ($1,$2,$3,$4,ARRAY['identity'],$5,now())`, [share, assortment, a, b, ownerA]],
    [`INSERT INTO "StockPoolGrant" (id,"ownerWorkspaceId","workspaceId","locationIds","createdByUserId","updatedAt") VALUES ($1,$2,$3,$4,$5,now())`, [grant, a, b, [locationA], ownerA]],
  ])
  await inContext(b, ownerB, [
    [`SELECT nexus_assortment_share_respond($1,'accept',1)`, [share]],
    [`SELECT nexus_stock_pool_grant_respond($1,'accept',1)`, [grant]],
    [`INSERT INTO "CatalogLink" (id,"shareId","sourceWorkspaceId","sourceProductId","targetWorkspaceId","targetProductId","linkedBy","sourceVersion","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,'created',1,now())`, [catalog, share, a, x, b, bx]],
    [`INSERT INTO "StockPoolLink" (id,"workspaceId","grantId","catalogLinkId","productId","sourceProductId","createdByUserId","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,now())`, [randomUUID(), b, grant, catalog, bx, x, ownerB]],
  ])
  // B's eBay account: its seller id is what eBay's notice names and what admission routes by.
  const account = randomUUID(), sellerId = `seller-${randomUUID()}`
  await q(`INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","managedBy","externalAccountId","isActive","authStatus","grantVersion","updatedAt") VALUES ($1,$2,'EBAY','oauth',$3,false,'connected',0,now())`, [account, b, sellerId])
  await as(b, () => storeGrant(account, { accessToken: `access-${account}`, refreshToken: `refresh-${account}`, expiresInSec: 7200, grantedScopes: [], identity: { userId: sellerId } }, { kind: 'operator' }, 'grant'))
  return { a, b, x, bx, own, account, sellerId }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

/** The notice's whole path. Admission must route it to B on B's account, by the seller id alone. */
async function notice(f: Fixture, orderId: string, line: string) {
  const admitted = await receiveEbayNotice({ rawBody: signedNotice(f.sellerId, orderId, line), header: 'synthetic-signature', environment: 'production' })
  if (admitted.kind !== 'accepted' || admitted.workspaceId !== f.b) throw new Error(`The order notice was not routed to its seller's business: ${admitted.kind}`)
  return { receiptId: admitted.receiptId, run: () => as(f.b, () => processEbayInbound(admitted.receiptId)) }
}
const poll = (f: Fixture, orderId: string) => as(f.b, () => ingestEbayOrder(served[orderId], f.account, { actor: 'ebay-orders-sync' }))

const waitingSessions = async () => (await q<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid)) > 0`))[0].n
async function untilWaiting(count: number): Promise<boolean> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await waitingSessions() >= count) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return false
}

/** Holds the order's Product rows, starts `first`, sees it wait, starts `second`, sees both wait, then lets go. */
async function forcedRace(productIds: string[], first: () => Promise<unknown>, second: () => Promise<unknown>) {
  const holder = await database.pool.connect()
  const running: Array<Promise<unknown>> = []
  let bothWaited = false
  try {
    await holder.query('BEGIN')
    await holder.query(`SELECT id FROM "Product" WHERE id = ANY($1::text[]) FOR NO KEY UPDATE`, [productIds])
    running.push(first())
    void running[0].catch(() => undefined)
    const firstWaited = await untilWaiting(1)
    running.push(second())
    void running[1].catch(() => undefined)
    bothWaited = firstWaited && await untilWaiting(2)
  } finally {
    await holder.query('COMMIT').catch(() => undefined)
    holder.release()
  }
  return { bothWaited, outcomes: await Promise.allSettled(running) }
}

const orderRows = (orderId: string) => q(`SELECT id, "workspaceId", "channelConnectionId" FROM "Order" WHERE channel='EBAY' AND "channelOrderId"=$1`, [orderId])
const lineRows = (orderId: string) => q(`SELECT i."externalLineItemId" FROM "OrderItem" i JOIN "Order" o ON o.id=i."orderId" WHERE o."channelOrderId"=$1 ORDER BY 1`, [orderId])
const levelOf = async (productId: string) => (await q<{ quantity: number }>(`SELECT quantity FROM "StockLevel" WHERE "productId"=$1`, [productId]))[0].quantity
/** Every taking movement for the order, own (in B, orderId) or from the pool (in A, consumerOrderRef). */
const takes = (orderDbId: string) => q(`SELECT "productId", change, actor FROM "StockMovement" WHERE ("orderId"=$1 OR "consumerOrderRef"=$1) AND change < 0 ORDER BY "productId"`, [orderDbId])
const rejected = (outcomes: PromiseSettledResult<unknown>[]) => outcomes.filter(o => o.status === 'rejected').map(o => String((o as PromiseRejectedResult).reason))
const fulfilled = (outcomes: PromiseSettledResult<unknown>[]) => outcomes.map(o => o.status === 'fulfilled' ? o.value : null)

describe.skipIf(!concurrentDatabaseUrl())('an eBay order notice racing the poll on one order (real PostgreSQL)', () => {
  const flag = process.env.NEXUS_WORKSPACES_ENABLED
  beforeAll(async () => {
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    vi.stubEnv('NEXUS_CX_TOKEN_SERVICE', '1')
    vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', randomBytes(32).toString('base64'))
    vi.stubEnv('NEXUS_KMS_KEY_ID', '')
    vi.stubGlobal('fetch', fetchMock)
    database = await concurrentDatabase({ maxConnections: 24 })
    await import('../connectors/ebay/spec.js')
    role = randomUUID()
    await q(`INSERT INTO "Role" (id,key,name,"isSystem","updatedAt") VALUES ($1,'OWNER','Owner',true,now()) ON CONFLICT (key) DO NOTHING`, [role])
    role = (await q('SELECT id FROM "Role" WHERE key=\'OWNER\''))[0].id
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_available_invariant" CHECK (available=quantity-reserved)`)
    await q(`CREATE UNIQUE INDEX "StockLevel_loc_prod_novar_unique" ON "StockLevel" ("workspaceId","locationId","productId") WHERE "variationId" IS NULL`)
  }, 180_000)
  beforeEach(() => {
    vi.stubEnv('NEXUS_ENABLE_EBAY_INBOUND_PROCESSING', '1'); vi.stubEnv('NEXUS_CX_TOKEN_SERVICE', '1'); vi.stubEnv('NEXUS_ENABLE_EBAY_ORDER_NOTICES', '1')
    reads.length = 0; fetchMock.mockClear()
  })
  afterAll(async () => {
    if (flag === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flag
    await database?.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
  }, 60_000)

  it.each([
    ['own stock', 'the notice', 'own'],
    ['own stock', 'the poll', 'own'],
    ['borrowed pool stock', 'the notice', 'pool'],
    ['borrowed pool stock', 'the poll', 'pool'],
  ] as const)('%s, %s first: one order, each line once, the stock taken once', async (_label, firstPath, stock) => {
    const f = await fixture(), orderId = `RACE-${stock}-${randomUUID().slice(0, 8)}`
    const sku = stock === 'own' ? f.own : f.bx, takenFrom = stock === 'own' ? f.own : f.x
    served[orderId] = fulfillmentOrder(orderId, [sku])
    const n = await notice(f, orderId, `${orderId}-L1`)
    const runs = firstPath === 'the notice' ? [n.run, () => poll(f, orderId)] : [() => poll(f, orderId), n.run]
    const { bothWaited, outcomes } = await forcedRace([f.own, f.bx, f.x], runs[0], runs[1])
    expect(bothWaited).toBe(true)
    expect(rejected(outcomes)).toEqual([])
    expect(fulfilled(outcomes)[firstPath === 'the notice' ? 0 : 1]).toEqual({ kind: 'done' })
    const orders = await orderRows(orderId)
    expect(orders).toEqual([{ id: expect.any(String), workspaceId: f.b, channelConnectionId: f.account }])
    expect(await lineRows(orderId)).toEqual([{ externalLineItemId: `${orderId}-L1` }])
    // Exactly one taking movement, written by whichever path reached the stock first.
    expect(await takes(orders[0].id)).toEqual([{ productId: takenFrom, change: -1, actor: firstPath === 'the notice' ? 'ebay-order-notice' : 'ebay-orders-sync' }])
    expect([await levelOf(f.own), await levelOf(f.bx), await levelOf(f.x)]).toEqual(stock === 'own' ? [9, 10, 10] : [10, 10, 9])
    expect(reads).toEqual([orderUrl(orderId)])
    expect(await q(`SELECT status FROM "WebhookEvent" WHERE id=$1`, [n.receiptId])).toEqual([{ status: 'done' }])
  })

  it('eBay\'s one notice per line and the poll, all at once on a mixed order: one order, each line once, each unit once', async () => {
    const f = await fixture(), orderId = `RACE-MIXED-${randomUUID().slice(0, 8)}`
    served[orderId] = fulfillmentOrder(orderId, [f.own, f.bx])
    const notices = [await notice(f, orderId, `${orderId}-L1`), await notice(f, orderId, `${orderId}-L2`)]
    const outcomes = await Promise.allSettled([...notices.map(n => n.run()), poll(f, orderId), poll(f, orderId)])
    expect(rejected(outcomes)).toEqual([])
    expect(fulfilled(outcomes).slice(0, 2)).toEqual([{ kind: 'done' }, { kind: 'done' }])
    const orders = await orderRows(orderId)
    expect(orders).toHaveLength(1)
    expect(await lineRows(orderId)).toEqual([{ externalLineItemId: `${orderId}-L1` }, { externalLineItemId: `${orderId}-L2` }])
    expect((await takes(orders[0].id)).map(({ productId, change }) => ({ productId, change }))).toEqual([{ productId: f.own, change: -1 }, { productId: f.x, change: -1 }].sort((l, r) => l.productId.localeCompare(r.productId)))
    expect([await levelOf(f.own), await levelOf(f.bx), await levelOf(f.x)]).toEqual([9, 10, 9])
  })
})
