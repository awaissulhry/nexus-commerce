/**
 * Stored ORDER_CONFIRMATION execution (held unless NEXUS_ENABLE_EBAY_ORDER_NOTICES=1) on a real
 * PostgreSQL as a production-equivalent owner. The only network is `fetch`, stubbed at the
 * gateway's boundary: one receipt may read exactly one order, with its own account's token, and
 * only when the notice's seller is that account's seller.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => (database.client as any)[key] }) }))
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
const { recordInbound } = await import('./ledger.js')
const { processEbayInbound, dueEbayInboundEvents } = await import('./ebay-processing.js')
const { inboundReceiptHandlerFor, canReplayInbound } = await import('./handlers.js')
const { replayInbound } = await import('./ledger.js')

const OWNER = 'nexus_legacy_workspace'
const inOwner = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: OWNER, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const q = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
type Call = { url: string; authorization: string | null; method: string }
const calls: Call[] = []
let respond: (url: string) => Response | Promise<Response> = () => { throw new Error('No eBay response configured') }
const fetchMock = vi.fn(async (input: unknown, init: { method?: string; headers?: Record<string, string> } = {}) => {
  const url = String(input)
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
  calls.push({ url, authorization: headers.authorization ?? null, method: init.method ?? 'GET' })
  return respond(url)
})
const orderUrl = (orderId: string) => `https://api.ebay.com/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}`
let locationId = ''
async function product(label: string, quantity: number) {
  const id = randomUUID(), sku = `${label}-${id.slice(0, 8)}`
  await q(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "totalStock", "updatedAt") VALUES ($1,$2,$3,$3,10,$4,now())`, [id, OWNER, sku, quantity])
  await q(`INSERT INTO "StockLevel" (id, "workspaceId", "locationId", "productId", quantity, reserved, available, "lastUpdatedAt") VALUES ($1,$2,$3,$4,$5,0,$5,now())`, [randomUUID(), OWNER, locationId, id, quantity])
  return { id, sku }
}
async function account(state = 'connected') {
  const id = randomUUID()
  await q('INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","managedBy","externalAccountId","isActive","authStatus","grantVersion","updatedAt") VALUES ($1,$2,\'EBAY\',\'oauth\',$1,false,$3,0,now())', [id, OWNER, state])
  if (state === 'connected') await inOwner(() => storeGrant(id, { accessToken: `access-${id}`, refreshToken: `refresh-${id}`, expiresInSec: 7200, grantedScopes: [], identity: { userId: id } }, { kind: 'operator' }, 'grant'))
  return id
}
const fulfillmentOrder = (orderId: string, lines: Array<{ sku: string; quantity: number }>) => ({
  orderId, creationDate: '2026-09-23T10:00:00.000Z', orderPaymentStatus: 'PAID', orderFulfillmentStatus: 'NOT_STARTED',
  buyer: { username: 'notice.buyer' }, pricingSummary: { total: { value: '20.00', currency: 'EUR' } },
  lineItems: lines.map((l, i) => ({ lineItemId: `${orderId}-L${i + 1}`, sku: l.sku, title: l.sku, quantity: l.quantity, lineItemCost: { value: '10.00', currency: 'EUR' } })),
})
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
/** An order notice names its account's seller (account() makes the seller id the account id) unless a case gives `user`. */
async function queued(connectionId: string, data: Record<string, unknown>, eventType = 'ORDER_CONFIRMATION') {
  if (eventType === 'ORDER_CONFIRMATION' && !('user' in data)) data = { user: { userId: connectionId, username: 'notice-seller' }, ...data }
  const notificationId = randomUUID()
  const result = await inOwner(() => recordInbound({ channel: 'EBAY', eventType, externalId: `ebay:production:${notificationId}`, connectionId,
    signatureOk: true, verifiedBy: 'ebay_ecdsa', queueForRetry: true,
    payload: { metadata: { topic: eventType, schemaVersion: '1.0' }, notification: { notificationId, publishDate: '2026-09-23T10:00:01.000Z', data } } }))
  return result.id!
}
const process = (id: string) => inOwner(() => processEbayInbound(id))
// Prisma stores UTC in timestamp-without-zone columns; read the instant as UTC, not as this machine's local time.
const receipt = async (id: string) => (await q('SELECT status, attempts, "isProcessed", (EXTRACT(EPOCH FROM "nextAttemptAt")*1000)::float8 AS "nextAttemptMs", "lastError" FROM "WebhookEvent" WHERE id=$1', [id]))[0]
const due = (id: string) => q('UPDATE "WebhookEvent" SET "nextAttemptAt"=clock_timestamp()-interval \'1 second\',"leaseUntil"=CASE WHEN "leaseToken" IS NULL THEN NULL ELSE clock_timestamp()-interval \'1 second\' END WHERE id=$1', [id])
const orders = (channelOrderId: string) => q(`SELECT id, status::text AS status, "channelConnectionId", "customerName" FROM "Order" WHERE channel='EBAY' AND "channelOrderId"=$1`, [channelOrderId])
const movements = (channelOrderId: string) => q(`SELECT "productId", change FROM "StockMovement" WHERE "orderId" IN (SELECT id FROM "Order" WHERE "channelOrderId"=$1)`, [channelOrderId])
const warnings = (id: string) => q(`SELECT id FROM "Notification" WHERE "entityId"=$1 AND type='channel-notification-unresolved'`, [id])

describe.skipIf(!concurrentDatabaseUrl())('stored eBay ORDER_CONFIRMATION execution in PostgreSQL', () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_CX_TOKEN_SERVICE', '1')
    vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', randomBytes(32).toString('base64'))
    vi.stubEnv('NEXUS_KMS_KEY_ID', '')
    vi.stubGlobal('fetch', fetchMock)
    database = await concurrentDatabase({ maxConnections: 12 })
    await import('../connectors/ebay/spec.js')
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_available_invariant" CHECK ("available" = "quantity" - "reserved")`)
    await q('INSERT INTO "UserProfile" (id,email,"displayName",status,"updatedAt") VALUES (\'order-owner\',\'order-owner@test.local\',\'Order Owner\',\'active\',now())')
    await q('INSERT INTO "Role" (id,key,name,permissions,"updatedAt") VALUES (\'order-role\',\'OWNER\',\'Owner\',ARRAY[]::text[],now()) ON CONFLICT (key) DO NOTHING')
    const role = (await q('SELECT id FROM "Role" WHERE key=\'OWNER\''))[0].id
    await q('INSERT INTO "WorkspaceMembership" (id,"workspaceId","userId",status,"updatedAt") VALUES (\'order-membership\',$1,\'order-owner\',\'active\',now())', [OWNER])
    await q('INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES (\'order-membership\',$1)', [role])
    const warehouse = randomUUID()
    await q(`INSERT INTO "Warehouse" (id, "workspaceId", code, name, country, "isDefault", "updatedAt") VALUES ($1,$2,'W-MAIN','Main','IT',true,now())`, [warehouse, OWNER])
    locationId = randomUUID()
    await q(`INSERT INTO "StockLocation" (id, "workspaceId", type, code, name, "warehouseId", "updatedAt") VALUES ($1,$2,'WAREHOUSE','W-MAIN','Main',$3,now())`, [locationId, OWNER, warehouse])
  }, 180_000)
  beforeEach(() => {
    vi.stubEnv('NEXUS_ENABLE_EBAY_INBOUND_PROCESSING', '1'); vi.stubEnv('NEXUS_CX_TOKEN_SERVICE', '1')
    // Order notices are held by default; the cases below that run them opt in explicitly.
    vi.stubEnv('NEXUS_ENABLE_EBAY_ORDER_NOTICES', '1')
    calls.length = 0; fetchMock.mockClear()
    respond = () => { throw new Error('No eBay response configured') }
  })
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals() }, 60_000)

  it('reads the nested order once with its own account and commits the order with its receipt', async () => {
    const a = await product('NOTICE', 5), seller = await account()
    respond = url => url === orderUrl('N-1') ? json(fulfillmentOrder('N-1', [{ sku: a.sku, quantity: 2 }])) : json({}, 500)
    const id = await queued(seller, { order: { orderId: 'N-1' } })
    expect(await process(id)).toEqual({ kind: 'done' })
    expect(calls).toEqual([{ url: orderUrl('N-1'), authorization: `Bearer access-${seller}`, method: 'GET' }])
    expect(await receipt(id)).toMatchObject({ status: 'done', isProcessed: true, attempts: 1 })
    expect(await orders('N-1')).toMatchObject([{ status: 'PROCESSING', channelConnectionId: seller, customerName: 'notice.buyer' }])
    expect(await movements('N-1')).toEqual([{ productId: a.id, change: -2 }])
  })

  it('is registered for replay but held until explicitly enabled: never claimed, dead-lettered or reset by a manual replay', async () => {
    expect(canReplayInbound('EBAY', 'ORDER_CONFIRMATION')).toBe(true)
    expect(await inboundReceiptHandlerFor('EBAY', 'ORDER_CONFIRMATION')).toBe(processEbayInbound)
    vi.stubEnv('NEXUS_ENABLE_EBAY_ORDER_NOTICES', '0')
    const a = await product('HELD', 5), seller = await account()
    respond = () => json(fulfillmentOrder('N-HELD', [{ sku: a.sku, quantity: 1 }]))
    const id = await queued(seller, { order: { orderId: 'N-HELD' } })
    const revocation = await queued(await account('disconnected'), { userId: 'x', revocationDate: '2026-09-23T01:02:03Z' }, 'AUTHORIZATION_REVOCATION')
    await q(`UPDATE "WebhookEvent" SET "nextAttemptAt"='2000-01-01T00:00:00Z' WHERE id=$1`, [revocation])
    await q(`UPDATE "WebhookEvent" SET "nextAttemptAt"='2000-01-02T00:00:00Z' WHERE id=$1`, [id])
    const dueIds = async () => (await inOwner(() => dueEbayInboundEvents())).map(row => row.id)
    expect(await dueIds()).toContain(revocation)
    expect(await dueIds()).not.toContain(id)
    for (let i = 0; i < 6; i++) expect(await process(id)).toEqual({ kind: 'held', reason: 'order_notices_disabled' })
    const handler = (await inboundReceiptHandlerFor('EBAY', 'ORDER_CONFIRMATION'))!
    expect(await inOwner(() => handler(id))).toEqual({ kind: 'held', reason: 'order_notices_disabled' })
    // A dead-lettered order notice stays exactly as it is while held: the operator's replay changes nothing.
    await q(`UPDATE "WebhookEvent" SET status='dlq', "nextAttemptAt"=NULL, attempts=5, "lastError"='earlier failure' WHERE id=$1`, [id])
    expect(await inOwner(() => replayInbound({ id }))).toEqual({ ok: false, reason: 'processing_held' })
    expect(await receipt(id)).toMatchObject({ status: 'dlq', attempts: 5, isProcessed: false, nextAttemptMs: null, lastError: 'earlier failure' })
    expect(calls).toEqual([])
    expect(await orders('N-HELD')).toEqual([])
    vi.stubEnv('NEXUS_ENABLE_EBAY_ORDER_NOTICES', '1')
    expect(await inOwner(() => replayInbound({ id }))).toMatchObject({ ok: true, eventType: 'ORDER_CONFIRMATION' })
    expect(await dueIds()).toContain(id)
    expect(await process(id)).toEqual({ kind: 'done' })
    expect(await orders('N-HELD')).toHaveLength(1)
  })

  it('refuses a notice for another seller than its account before any read', async () => {
    const a = await product('OTHER-SELLER-NOTICE', 5), seller = await account()
    respond = () => json(fulfillmentOrder('N-SELLER', [{ sku: a.sku, quantity: 1 }]))
    const id = await queued(seller, { user: { userId: randomUUID(), username: 'another-seller' }, order: { orderId: 'N-SELLER' } })
    expect(await process(id)).toEqual({ kind: 'dead_letter' })
    expect(calls).toEqual([])
    expect(await receipt(id)).toMatchObject({ status: 'dlq', isProcessed: false, lastError: expect.stringMatching(/different eBay seller than its account\. Nothing was changed\./) })
    expect(await warnings(id)).toHaveLength(1)
    expect(await orders('N-SELLER')).toEqual([])
    expect(await q('SELECT quantity FROM "StockLevel" WHERE "productId"=$1', [a.id])).toEqual([{ quantity: 5 }])
  })

  it('refuses a notice whose account was reconnected to another seller during the read, writing nothing', async () => {
    const a = await product('RECONNECTED', 5), seller = await account()
    respond = async () => {
      await q('UPDATE "ChannelConnection" SET "externalAccountId"=$2 WHERE id=$1', [seller, randomUUID()])
      return json(fulfillmentOrder('N-RECONNECTED', [{ sku: a.sku, quantity: 1 }]))
    }
    const id = await queued(seller, { order: { orderId: 'N-RECONNECTED' } })
    expect(await process(id)).toEqual({ kind: 'dead_letter' })
    expect(calls).toHaveLength(1)
    expect(await receipt(id)).toMatchObject({ status: 'dlq', lastError: expect.stringMatching(/different eBay seller than its account/) })
    expect(await orders('N-RECONNECTED')).toEqual([])
    expect(await q('SELECT quantity FROM "StockLevel" WHERE "productId"=$1', [a.id])).toEqual([{ quantity: 5 }])
  })

  it('dead-letters a notice without its seller id without reading anything', async () => {
    const id = await queued(await account(), { user: { username: 'only-a-name' }, order: { orderId: 'N-NO-SELLER' } })
    expect(await process(id)).toEqual({ kind: 'dead_letter' })
    expect(calls).toEqual([])
    expect(await receipt(id)).toMatchObject({ status: 'dlq', lastError: expect.stringMatching(/supported contract/) })
  })

  it('never uses another account\'s token and never lists orders', async () => {
    const a = await product('TWO-ACCOUNTS', 5), mine = await account(), other = await account()
    respond = url => url === orderUrl('N-2') ? json(fulfillmentOrder('N-2', [{ sku: a.sku, quantity: 1 }])) : json({ orders: [] })
    const id = await queued(mine, { order: { orderId: 'N-2' } })
    expect(await process(id)).toEqual({ kind: 'done' })
    expect(calls.length).toBe(1)
    expect(calls.every(call => call.url === orderUrl('N-2') && call.authorization === `Bearer access-${mine}`)).toBe(true)
    expect(calls.some(call => call.authorization === `Bearer access-${other}` || call.url.includes('/order?'))).toBe(false)
    expect(await q('SELECT 1 FROM "OutboundApiCallLog" WHERE "connectionId"=$1', [other])).toEqual([])
  })

  it('dead-letters a flat data.orderId without reading anything', async () => {
    const id = await queued(await account(), { orderId: 'N-FLAT' })
    expect(await process(id)).toEqual({ kind: 'dead_letter' })
    expect(calls).toEqual([])
    expect(await receipt(id)).toMatchObject({ status: 'dlq', isProcessed: false })
    expect(await warnings(id)).toHaveLength(1)
    expect(await orders('N-FLAT')).toEqual([])
  })

  it('dead-letters an order read back under a different id, writing nothing', async () => {
    const a = await product('MISMATCH', 5)
    respond = () => json(fulfillmentOrder('N-OTHER', [{ sku: a.sku, quantity: 1 }]))
    const id = await queued(await account(), { order: { orderId: 'N-3' } })
    expect(await process(id)).toEqual({ kind: 'dead_letter' })
    expect(calls).toHaveLength(1)
    expect([...await orders('N-3'), ...await orders('N-OTHER')]).toEqual([])
    expect(await q('SELECT quantity FROM "StockLevel" WHERE "productId"=$1', [a.id])).toEqual([{ quantity: 5 }])
  })

  it('trusts only the receipt reloaded under its lock: a stored notice changed during the read writes nothing', async () => {
    const a = await product('RELOADED', 5)
    let id = ''
    respond = async () => {
      await q(`UPDATE "WebhookEvent" SET payload=jsonb_set(payload,'{notification,data,order,orderId}','"N-RELOADED-X"') WHERE id=$1`, [id])
      return json(fulfillmentOrder('N-RELOADED', [{ sku: a.sku, quantity: 1 }]))
    }
    id = await queued(await account(), { order: { orderId: 'N-RELOADED' } })
    expect(await process(id)).toEqual({ kind: 'dead_letter' })
    expect(await orders('N-RELOADED')).toEqual([])
    expect(await q('SELECT quantity FROM "StockLevel" WHERE "productId"=$1', [a.id])).toEqual([{ quantity: 5 }])
  })

  it('keeps the receipt retryable and writes no order when the writer fails, then completes both once', async () => {
    const a = await product('WRITER-FAIL', 5), seller = await account()
    respond = () => json(fulfillmentOrder('N-4', [{ sku: a.sku, quantity: 1 }]))
    const id = await queued(seller, { order: { orderId: 'N-4' } })
    await q(`CREATE FUNCTION test_fail_notice_movement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."productId" = '${a.id}' THEN RAISE EXCEPTION 'injected stock movement failure'; END IF; RETURN NEW; END $$`)
    await q(`CREATE TRIGGER test_fail_notice_movement BEFORE INSERT ON "StockMovement" FOR EACH ROW EXECUTE FUNCTION test_fail_notice_movement()`)
    try {
      expect(await process(id)).toEqual({ kind: 'retry' })
      expect(await receipt(id)).toMatchObject({ status: 'failed', isProcessed: false, attempts: 1 })
      expect(await orders('N-4')).toEqual([])
    } finally {
      await q('DROP TRIGGER IF EXISTS test_fail_notice_movement ON "StockMovement"')
      await q('DROP FUNCTION IF EXISTS test_fail_notice_movement()')
    }
    await due(id)
    expect(await process(id)).toEqual({ kind: 'done' })
    expect(await receipt(id)).toMatchObject({ status: 'done', isProcessed: true, attempts: 2 })
    expect(await movements('N-4')).toEqual([{ productId: a.id, change: -1 }])
  })

  it('defers a rate limit without spending an attempt, honouring Retry-After', async () => {
    respond = () => json({ errors: [] }, 429, { 'Retry-After': '7200' })
    const id = await queued(await account(), { order: { orderId: 'N-5' } }), before = Date.now()
    expect(await process(id)).toEqual({ kind: 'deferred' })
    const stored = await receipt(id)
    expect(stored).toMatchObject({ status: 'failed', attempts: 0 })
    expect(stored.nextAttemptMs).toBeGreaterThanOrEqual(before + 7_200_000)
    expect(await orders('N-5')).toEqual([])
  })

  it('defers an expired authorization without spending an attempt', async () => {
    respond = () => json({ errors: [] }, 401)
    const id = await queued(await account(), { order: { orderId: 'N-6' } })
    expect(await process(id)).toEqual({ kind: 'deferred' })
    expect(await receipt(id)).toMatchObject({ status: 'failed', attempts: 0, lastError: expect.stringMatching(/reconnected/) })
  })

  it.each([[404, 'N-7'], [503, 'N-8']])('retries a %i within the bounded budget', async (status, orderId) => {
    respond = () => json({ errors: [] }, status)
    const id = await queued(await account(), { order: { orderId } })
    expect(await process(id)).toEqual({ kind: 'retry' })
    expect(await receipt(id)).toMatchObject({ status: 'failed', attempts: 1 })
    expect(calls).toHaveLength(1)
  })

  it('dead-letters an order already recorded for a different seller, leaving it unchanged', async () => {
    const a = await product('OTHER-SELLER', 5), first = await account(), second = await account()
    respond = () => json(fulfillmentOrder('N-9', [{ sku: a.sku, quantity: 1 }]))
    expect(await process(await queued(first, { order: { orderId: 'N-9' } }))).toEqual({ kind: 'done' })
    const before = await orders('N-9')
    const id = await queued(second, { order: { orderId: 'N-9' } })
    expect(await process(id)).toEqual({ kind: 'dead_letter' })
    expect(await orders('N-9')).toEqual(before)
    expect(await movements('N-9')).toEqual([{ productId: a.id, change: -1 }])
  })

  it('leaves authorization revocation exactly as it was: a terminal account completes without any read', async () => {
    const seller = await account('disconnected')
    const id = await queued(seller, { userId: seller, revocationDate: '2026-09-23T01:02:03Z' }, 'AUTHORIZATION_REVOCATION')
    expect(await process(id)).toEqual({ kind: 'done' })
    expect(calls).toEqual([])
    expect(await receipt(id)).toMatchObject({ status: 'done', isProcessed: true })
  })
})
