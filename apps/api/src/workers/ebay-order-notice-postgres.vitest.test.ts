/**
 * eBay order notices, Phase 4 — "run this stored ORDER_CONFIRMATION now" on a real PostgreSQL, as a
 * production-equivalent owner. The worker's job (processEbayOrderNoticeNow) and the minute sweep (runInboundRetrySweep)
 * run against the same receipts; the only network is `fetch`, stubbed at the gateway's boundary.
 *
 * Receipts are stored as admission stores them: verified, unscheduled (queueForRetry false), bound to their account.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { concurrentDatabase, concurrentDatabaseUrl } from '../test-support/concurrent-database.js'
import { withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
const enqueue = vi.hoisted(() => vi.fn())
vi.mock('../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => (database.client as any)[key] }) }))
vi.mock('../services/cx/apps.service.js', () => ({ getChannelApp: async () => ({ clientId: 'synthetic-app', clientSecret: 'synthetic-secret' }) }))
vi.mock('../services/monitoring/alert.service.js', () => ({ alertService: { createAlert: vi.fn() }, AlertType: { CONNECTION_HEALTH: 'CONNECTION_HEALTH' } }))
vi.mock('../lib/cron/clustered.js', () => ({ default: {} }))
vi.mock('../utils/cron-observability.js', () => ({ recordCronRun: vi.fn() }))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []) }
  return { addJobSafely: enqueue, ebayOrderNoticeQueue: { name: 'ebay-order-notice' }, outboundSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue,
    channelSyncQueue: queue, bulkJobQueue: queue, redis: { connection: null } }
})
vi.mock('../services/advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(), peekCached: async () => undefined, putCached: () => undefined, flushAdsCache: async () => undefined,
}))
const { storeGrant } = await import('../services/cx/token.service.js')
const { recordInbound } = await import('../services/cx/ingress/ledger.js')
const { runInboundRetrySweep } = await import('../jobs/inbound-retry.job.js')
const { kickStoredEbayOrderNotice } = await import('../services/cx/ebay-order-notice-kick.js')
const { processEbayOrderNoticeNow } = await import('./ebay-order-notice.worker.js')

const OWNER = 'nexus_legacy_workspace'
const inBusiness = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const inOwner = <T>(work: () => Promise<T>) => inBusiness(OWNER, work)
const q = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
type Call = { url: string; authorization: string | null }
const calls: Call[] = []
let respond: (url: string) => Response | Promise<Response> = () => { throw new Error('No eBay response configured') }
const fetchMock = vi.fn(async (input: unknown, init: { headers?: Record<string, string> } = {}) => {
  const url = String(input)
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
  calls.push({ url, authorization: headers.authorization ?? null })
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
async function account() {
  const id = randomUUID()
  await q('INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","managedBy","externalAccountId","isActive","authStatus","grantVersion","updatedAt") VALUES ($1,$2,\'EBAY\',\'oauth\',$1,false,\'connected\',0,now())', [id, OWNER])
  await inOwner(() => storeGrant(id, { accessToken: `access-${id}`, refreshToken: `refresh-${id}`, expiresInSec: 7200, grantedScopes: [], identity: { userId: id } }, { kind: 'operator' }, 'grant'))
  return id
}
const fulfillmentOrder = (orderId: string, sku: string) => ({
  orderId, creationDate: '2026-10-06T10:00:00.000Z', orderPaymentStatus: 'PAID', orderFulfillmentStatus: 'NOT_STARTED',
  buyer: { username: 'notice.buyer' }, pricingSummary: { total: { value: '10.00', currency: 'EUR' } },
  lineItems: [{ lineItemId: `${orderId}-L1`, sku, title: sku, quantity: 1, lineItemCost: { value: '10.00', currency: 'EUR' } }],
})
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const body = (notificationId: string, data: unknown, topic = 'ORDER_CONFIRMATION') =>
  ({ metadata: { topic, schemaVersion: '1.0' }, notification: { notificationId, publishDate: '2026-10-06T10:00:01.000Z', data } })
/** As admission stores a routed notice: verified, unscheduled, bound to its account. */
async function stored(connectionId: string, data: unknown, topic = 'ORDER_CONFIRMATION') {
  const notificationId = randomUUID()
  const payload = body(notificationId, data, topic)
  const result = await inOwner(() => recordInbound({ channel: 'EBAY', eventType: topic, externalId: `ebay:production:${notificationId}`, connectionId,
    signatureOk: true, verifiedBy: 'ebay_ecdsa', queueForRetry: false, payload }))
  return { id: result.id!, raw: Buffer.from(JSON.stringify(payload)) }
}
const now = (id: string) => inOwner(() => processEbayOrderNoticeNow(id))
const sweep = () => inOwner(() => runInboundRetrySweep())
const receipt = async (id: string) => (await q('SELECT status, attempts, "isProcessed", "nextAttemptAt", "leaseToken" FROM "WebhookEvent" WHERE id=$1', [id]))[0]
const orders = (channelOrderId: string) => q(`SELECT id FROM "Order" WHERE channel='EBAY' AND "channelOrderId"=$1`, [channelOrderId])
const movements = (channelOrderId: string) => q(`SELECT "productId", change FROM "StockMovement" WHERE "orderId" IN (SELECT id FROM "Order" WHERE "channelOrderId"=$1)`, [channelOrderId])
const reads = (orderId: string) => calls.filter(call => call.url === orderUrl(orderId)).length

describe.skipIf(!concurrentDatabaseUrl())('run a stored eBay order notice now (worker job vs the minute sweep, PostgreSQL)', () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_CX_TOKEN_SERVICE', '1')
    vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', randomBytes(32).toString('base64'))
    vi.stubEnv('NEXUS_KMS_KEY_ID', '')
    vi.stubGlobal('fetch', fetchMock)
    database = await concurrentDatabase({ maxConnections: 12 })
    await import('../services/cx/connectors/ebay/spec.js')
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_available_invariant" CHECK ("available" = "quantity" - "reserved")`)
    const warehouse = randomUUID()
    await q(`INSERT INTO "Warehouse" (id, "workspaceId", code, name, country, "isDefault", "updatedAt") VALUES ($1,$2,'W-MAIN','Main','IT',true,now())`, [warehouse, OWNER])
    locationId = randomUUID()
    await q(`INSERT INTO "StockLocation" (id, "workspaceId", type, code, name, "warehouseId", "updatedAt") VALUES ($1,$2,'WAREHOUSE','W-MAIN','Main',$3,now())`, [locationId, OWNER, warehouse])
  }, 180_000)
  beforeEach(() => {
    vi.stubEnv('NEXUS_ENABLE_EBAY_INBOUND_PROCESSING', '1'); vi.stubEnv('NEXUS_ENABLE_EBAY_ORDER_NOTICES', '1'); vi.stubEnv('NEXUS_CX_TOKEN_SERVICE', '1')
    calls.length = 0; fetchMock.mockClear(); enqueue.mockReset()
    respond = () => { throw new Error('No eBay response configured') }
  })
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals() }, 60_000)

  it('a kick, a second kick and the minute sweep at the same moment: one claim wins, each order is read once and written once', async () => {
    const seller = await account()
    const items = await Promise.all(['RACE-A', 'RACE-B', 'RACE-C'].map(async (orderId) => {
      const item = await product(orderId, 5)
      return { orderId, item, receipt: (await stored(seller, { user: { userId: seller }, order: { orderId } })).id }
    }))
    // A slow read keeps the winner's lease live while the others try to claim.
    respond = async url => {
      await new Promise(resolve => setTimeout(resolve, 100))
      const match = items.find(entry => url === orderUrl(entry.orderId))
      return match ? json(fulfillmentOrder(match.orderId, match.item.sku)) : json({}, 500)
    }
    const [stats, ...kicks] = await Promise.all([sweep(), ...items.flatMap(entry => [now(entry.receipt), now(entry.receipt)])])
    const kickDone = kicks.filter(outcome => outcome.kind === 'done').length
    expect(kickDone + stats.succeeded).toBe(3)
    expect(kicks.every(outcome => outcome.kind === 'done' || outcome.kind === 'not_claimed')).toBe(true)
    for (const entry of items) {
      expect(reads(entry.orderId)).toBe(1)
      expect(calls.filter(call => call.url === orderUrl(entry.orderId)).every(call => call.authorization === `Bearer access-${seller}`)).toBe(true)
      expect(await receipt(entry.receipt)).toMatchObject({ status: 'done', isProcessed: true, attempts: 1, leaseToken: null })
      expect(await orders(entry.orderId)).toHaveLength(1)
      expect(await movements(entry.orderId)).toEqual([{ productId: entry.item.id, change: -1 }])
    }
  })

  it('a kick for a held notice does nothing: no claim, no attempt, no read; the sweep runs it once switched on', async () => {
    const seller = await account(), a = await product('HELD', 5)
    respond = url => url === orderUrl('N-HELD') ? json(fulfillmentOrder('N-HELD', a.sku)) : json({}, 500)
    const { id } = await stored(seller, { user: { userId: seller }, order: { orderId: 'N-HELD' } })
    vi.stubEnv('NEXUS_ENABLE_EBAY_ORDER_NOTICES', '0')
    expect(await now(id)).toEqual({ kind: 'held', reason: 'order_notices_disabled' })
    vi.stubEnv('NEXUS_ENABLE_EBAY_ORDER_NOTICES', '1'); vi.stubEnv('NEXUS_ENABLE_EBAY_INBOUND_PROCESSING', '0')
    expect(await now(id)).toEqual({ kind: 'held', reason: 'processing_disabled' })
    expect(await receipt(id)).toMatchObject({ status: 'pending', attempts: 0, isProcessed: false, nextAttemptAt: null, leaseToken: null })
    expect(calls).toEqual([])
    expect(await orders('N-HELD')).toEqual([])
    vi.stubEnv('NEXUS_ENABLE_EBAY_INBOUND_PROCESSING', '1')
    expect(await sweep()).toMatchObject({ succeeded: 1 })
    expect(await receipt(id)).toMatchObject({ status: 'done', attempts: 1 })
    expect(reads('N-HELD')).toBe(1)
  })

  it('a failed enqueue costs only time: the receipt is untouched and the minute sweep runs it', async () => {
    const seller = await account(), a = await product('ENQUEUE-FAIL', 5)
    respond = url => url === orderUrl('N-ENQUEUE') ? json(fulfillmentOrder('N-ENQUEUE', a.sku)) : json({}, 500)
    const { id, raw } = await stored(seller, { user: { userId: seller }, order: { orderId: 'N-ENQUEUE' } })
    enqueue.mockRejectedValueOnce(new Error('synthetic redis failure'))
    expect(await kickStoredEbayOrderNotice({ kind: 'accepted', receiptId: id, workspaceId: OWNER, duplicate: false }, raw)).toEqual({ kicked: false, reason: 'enqueue_failed' })
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(await receipt(id)).toMatchObject({ status: 'pending', attempts: 0, nextAttemptAt: null, leaseToken: null })
    expect(await sweep()).toMatchObject({ succeeded: 1 })
    expect(await receipt(id)).toMatchObject({ status: 'done', attempts: 1 })
    expect(await movements('N-ENQUEUE')).toEqual([{ productId: a.id, change: -1 }])
  })

  it('a late kick never runs a finished receipt again, and never jumps a failed receipt\'s backoff', async () => {
    const seller = await account(), a = await product('LATE', 5)
    respond = url => url === orderUrl('N-LATE') ? json(fulfillmentOrder('N-LATE', a.sku)) : json({}, 500)
    const { id: finished } = await stored(seller, { user: { userId: seller }, order: { orderId: 'N-LATE' } })
    expect(await now(finished)).toEqual({ kind: 'done' })
    expect(await now(finished)).toEqual({ kind: 'not_claimed' })
    expect(reads('N-LATE')).toBe(1)
    respond = () => json({ errors: [] }, 503)
    const { id: backedOff } = await stored(seller, { user: { userId: seller }, order: { orderId: 'N-BACKOFF' } })
    expect(await now(backedOff)).toEqual({ kind: 'retry' })
    expect(await now(backedOff)).toEqual({ kind: 'not_claimed' })
    expect(reads('N-BACKOFF')).toBe(1)
    expect(await receipt(backedOff)).toMatchObject({ status: 'failed', attempts: 1 })
  })

  // Last: it leaves two pristine receipts that a later sweep would pick up.
  it('runs only an order notice: a revocation receipt, or a receipt of another business, is left untouched', async () => {
    const seller = await account()
    const { id: revocation } = await stored(seller, { userId: seller, revocationDate: '2026-10-06T01:02:03Z' }, 'AUTHORIZATION_REVOCATION')
    expect(await now(revocation)).toEqual({ kind: 'skipped', reason: 'not_an_order_notice' })
    expect(await receipt(revocation)).toMatchObject({ status: 'pending', attempts: 0, leaseToken: null })
    const { id: order } = await stored(seller, { user: { userId: seller }, order: { orderId: 'N-OTHER-BUSINESS' } })
    const other = randomUUID()
    await q('INSERT INTO "Workspace" (id,name,"createdByUserId","creationKey","updatedAt") VALUES ($1,\'Other business fixture\',\'test\',$1,now())', [other])
    expect(await inBusiness(other, () => processEbayOrderNoticeNow(order))).toEqual({ kind: 'skipped', reason: 'not_an_order_notice' })
    expect(await receipt(order)).toMatchObject({ status: 'pending', attempts: 0, leaseToken: null })
    expect(calls).toEqual([])
  })
})
