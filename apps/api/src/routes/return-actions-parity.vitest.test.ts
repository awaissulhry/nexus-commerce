/**
 * MCP full control 07 O12 — the return writes and the refund that Claude's return tools use move out of the routes
 * into services/returns/return-actions.service.ts and services/refunds/issue-refund.service.ts with NO change to what
 * the routes do and answer for what they accepted before. The snapshots in
 * __snapshots__/return-actions-parity.vitest.test.ts.snap were written by the route code BEFORE the move: create (with
 * its idempotency replay), receive, inspect, restock, scrap (before and after a restock), warranty, the bulk
 * approve / deny / receive, and the refund (skip-channel, channel OK, Amazon manual, channel failure, its refusals) —
 * with the rows they leave.
 *
 * Real SQL (PGlite with the production schema) and the real route plugins; the channel refund publisher is mocked
 * (nothing leaves the machine). Ids, RMA numbers and times the database or the clock make are masked.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'disabled' }),
    resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
vi.mock('../services/advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined,
  putCached: () => undefined,
  flushAdsCache: async () => undefined,
}))
const channel = vi.hoisted(() => ({ outcome: {} as Record<string, unknown>, calls: [] as unknown[] }))
vi.mock('../services/refunds/refund-publisher.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  publishRefundToChannel: vi.fn(async (input: { returnId: string }) => {
    channel.calls.push(input)
    return channel.outcome[input.returnId] ?? { outcome: 'OK', channelRefundId: 'TEST-CH-REFUND-1', channelMessage: 'Test refund issued.' }
  }),
}))
vi.mock('../services/credit-note.service.js', () => ({ assignCreditNoteNumber: vi.fn(async () => null) }))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const MADE = new Set([
  'id', 'createdAt', 'updatedAt', 'workspaceId', 'rmaNumber', 'receivedAt', 'inspectedAt', 'restockedAt', 'refundedAt', 'channelRefundedAt',
  'channelPostedAt', 'defectReportedAt', 'refundId', 'existingRefundId', 'returnId',
])
const stable = (value: unknown) => JSON.parse(JSON.stringify(value, (key, v) => (MADE.has(key) && v !== null ? '<made>' : v)))

describe('07 O12 — return writes and the refund: the routes answer exactly as before the move', () => {
  let app: FastifyInstance
  const call = async (method: 'POST' | 'PATCH', url: string, payload: unknown = {}, headers: Record<string, string> = {}) => {
    const response = await app.inject({ method, url: `/api${url}`, payload: payload as object, headers })
    return { status: response.statusCode, replay: response.headers['idempotent-replay'] ?? null, body: stable(JSON.parse(response.body || '{}')) }
  }
  const statusOnly = async (method: 'POST' | 'PATCH', url: string, payload: unknown = {}) => (await app.inject({ method, url: `/api${url}`, payload: payload as object })).statusCode
  const movementsOf = async (returnId: string) => stable(await inside(() => database.client.stockMovement.findMany({
    where: { referenceId: returnId }, orderBy: [{ reason: 'asc' }, { change: 'asc' }], select: { productId: true, change: true, reason: true, referenceType: true, actor: true, notes: true },
  })))
  const refundsOf = async (returnId: string) => stable(await inside(() => database.client.refund.findMany({
    where: { returnId }, orderBy: { createdAt: 'asc' },
    select: { amountCents: true, currencyCode: true, kind: true, reason: true, perLineAmounts: true, notes: true, channel: true, channelStatus: true, channelRefundId: true, channelError: true, actor: true, attempts: { select: { outcome: true, channelRefundId: true, errorMessage: true } } },
  })))
  const returnOf = async (id: string) => stable(await inside(() => database.client.return.findUnique({
    where: { id }, select: { status: true, refundStatus: true, refundCents: true, channelRefundId: true, channelRefundError: true, version: true, warrantyStatus: true, warrantyResolution: true, manufacturerRef: true },
  })))
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    database = await formulaDatabase()
    await inside(async () => {
      await database.client.warehouse.create({ data: { id: 'test-wh', code: 'TEST-WH', name: 'Test warehouse', isDefault: true, addressLine1: 'Via Magazzino 1', city: 'Testville', postalCode: '00100', country: 'IT' } as never })
      await database.client.stockLocation.create({ data: { id: 'test-loc', code: 'TEST-WH-LOC', name: 'Test warehouse', type: 'WAREHOUSE', warehouseId: 'test-wh' } as never })
      await database.client.product.create({ data: { id: 'test-product-1', sku: 'TEST-SKU-1', name: 'Test jacket', basePrice: 50, costPrice: 20, totalStock: 0, fulfillmentMethod: 'FBM' } as never })
      const order = async (key: string, data: Record<string, unknown> = {}) => (await database.client.order.create({
        data: {
          id: `test-order-${key}`, channel: 'EBAY', channelOrderId: `TEST-${key}`, marketplace: 'IT', status: 'DELIVERED', currencyCode: 'EUR',
          totalPrice: '100.00', customerName: 'Test Buyer', customerEmail: 'buyer@example.test', shippingAddress: { city: 'Testville' }, fulfillmentMethod: 'MFN',
          items: { create: [{ id: `test-item-${key}`, sku: 'TEST-SKU-1', productId: 'test-product-1', quantity: 2, price: '50.00' }] }, ...data,
        } as never,
      })).id
      const ret = async (key: string, orderId: string, status: string, items: Array<Record<string, unknown>>, data: Record<string, unknown> = {}) => (await database.client.return.create({
        data: { id: `test-return-${key}`, orderId, channel: 'EBAY', marketplace: 'IT', rmaNumber: `TEST-RMA-${key}`, status, items: { create: items }, ...data } as never,
      })).id
      for (const key of ['create', 'flow', 'scrap', 'warranty', 'bulk', 'refund1', 'refund2', 'refund3', 'refund4']) ids[`order-${key}`] = await order(key)
      ids.amazonOrder = await order('amazon', { channel: 'AMAZON', fulfillmentMethod: 'FBM' })
      const line = (key: string, extra: Record<string, unknown> = {}) => ({ id: `test-ritem-${key}`, sku: 'TEST-SKU-1', productId: 'test-product-1', quantity: 1, ...extra })
      ids.flow = await ret('flow', ids['order-flow'], 'AUTHORIZED', [line('flow-a'), line('flow-b'), { id: 'test-ritem-flow-c', sku: 'TEST-SKU-LOOSE', quantity: 1 }])
      ids.scrapInspecting = await ret('scrap', ids['order-scrap'], 'INSPECTING', [line('scrap-a', { conditionGrade: 'DAMAGED' })])
      ids.warranty = await ret('warranty', ids['order-warranty'], 'RECEIVED', [line('warranty-a')], { returnType: 'WARRANTY', warrantyStatus: 'PENDING_DIAGNOSIS' })
      ids.bulkRequested = await ret('bulk-requested', ids['order-bulk'], 'REQUESTED', [line('bulk-a')])
      ids.bulkAuthorized = await ret('bulk-authorized', ids['order-bulk'], 'AUTHORIZED', [line('bulk-b')])
      ids.bulkDeny = await ret('bulk-deny', ids['order-bulk'], 'REQUESTED', [line('bulk-c')])
      ids.refundSkip = await ret('refund-skip', ids['order-refund1'], 'RECEIVED', [line('refund-skip')])
      ids.refundChannel = await ret('refund-channel', ids['order-refund2'], 'RECEIVED', [line('refund-channel-a'), line('refund-channel-b')])
      ids.refundFail = await ret('refund-fail', ids['order-refund3'], 'RECEIVED', [line('refund-fail')])
      ids.refundStaged = await ret('refund-staged', ids['order-refund4'], 'RECEIVED', [line('refund-staged')], { refundCents: 2500 })
      ids.refundAmazon = await ret('refund-amazon', ids.amazonOrder, 'RECEIVED', [line('refund-amazon')], { channel: 'AMAZON' })
    })
    channel.outcome[ids.refundFail] = { outcome: 'FAILED', error: 'Test channel refused the refund' }
    channel.outcome[ids.refundAmazon] = { outcome: 'OK_MANUAL_REQUIRED', channelMessage: 'Finish this refund in Seller Central.' }
    app = Fastify()
    app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(business, done) })
    const { default: returnsRoutes } = await import('./returns.routes.js')
    await app.register(returnsRoutes, { prefix: '/api' })
    await app.ready()
  }, 180_000)

  afterAll(async () => {
    await app?.close()
    await database?.close()
  })

  it('create: a refusal, a create with its idempotency key, its replay, a warranty return', async () => {
    const body = { orderId: ids['order-create'], channel: 'EBAY', marketplace: 'IT', reason: 'Too small', items: [{ orderItemId: 'test-item-create', productId: 'test-product-1', sku: 'TEST-SKU-1', quantity: 1 }] }
    expect([
      await call('POST', '/fulfillment/returns', {}),
      await call('POST', '/fulfillment/returns', body, { 'idempotency-key': 'test-key-1' }),
      await call('POST', '/fulfillment/returns', body, { 'idempotency-key': 'test-key-1' }),
      await call('POST', '/fulfillment/returns', { channel: 'SHOPIFY', returnType: 'WARRANTY', isFbaReturn: false, items: [] }),
    ]).toMatchSnapshot()
  })

  it('receive, inspect, restock, then scrap after the restock; scrap before any restock; their refusals', async () => {
    expect([
      await call('POST', `/fulfillment/returns/${ids.flow}/receive`, { warehouseId: 'test-wh' }),
      await movementsOf(ids.flow),
      await call('POST', `/fulfillment/returns/${ids.flow}/inspect`, {
        items: [
          { itemId: 'test-ritem-flow-a', conditionGrade: 'GOOD', notes: 'Fine' },
          { itemId: 'test-ritem-flow-b', conditionGrade: 'DAMAGED', scrapReason: 'Torn' },
          { itemId: 'test-ritem-flow-c', conditionGrade: 'LIKE_NEW', disposition: 'SECOND_QUALITY' },
        ],
        overallCondition: 'GOOD',
      }),
      await call('POST', `/fulfillment/returns/${ids.flow}/restock`, {}),
      await movementsOf(ids.flow),
      await inside(() => database.client.stockLevel.findMany({ where: { productId: 'test-product-1' }, select: { quantity: true, locationId: true } })),
      await call('POST', `/fulfillment/returns/${ids.flow}/scrap`, {}),
      await movementsOf(ids.flow),
      await call('POST', `/fulfillment/returns/${ids.scrapInspecting}/scrap`, {}),
      await movementsOf(ids.scrapInspecting),
      await call('POST', '/fulfillment/returns/test-return-none/restock', {}),
      await call('POST', '/fulfillment/returns/test-return-none/scrap', {}),
      await statusOnly('POST', '/fulfillment/returns/test-return-none/receive', {}),
      await statusOnly('POST', '/fulfillment/returns/test-return-none/inspect', { items: [] }),
    ]).toMatchSnapshot()
  })

  it('warranty: an update, nothing to update, unknown', async () => {
    expect([
      await call('PATCH', `/fulfillment/returns/${ids.warranty}/warranty`, { warrantyStatus: 'DIAGNOSED', warrantyResolution: 'REPAIR', manufacturerRef: 'TEST-MREF-1', defectReportedAt: '2026-04-02T10:00:00Z' }),
      await call('PATCH', `/fulfillment/returns/${ids.warranty}/warranty`, {}),
      await call('PATCH', '/fulfillment/returns/test-return-none/warranty', { manufacturerRef: 'X' }),
      await returnOf(ids.warranty),
    ]).toMatchSnapshot()
  })

  it('bulk approve, deny and receive', async () => {
    expect([
      await call('POST', '/fulfillment/returns/bulk/approve', { ids: [ids.bulkRequested, ids.bulkAuthorized, 'test-return-none'] }),
      await call('POST', '/fulfillment/returns/bulk/deny', { ids: [ids.bulkDeny, ids.bulkRequested] }),
      await call('POST', '/fulfillment/returns/bulk/receive', { ids: [ids.bulkRequested, ids.bulkDeny] }),
      await call('POST', '/fulfillment/returns/bulk/approve', {}),
      await returnOf(ids.bulkRequested),
      await returnOf(ids.bulkDeny),
    ]).toMatchSnapshot()
  })

  it('refund: refusals, skip-channel, a second one, channel OK with the fee note, Amazon manual, a channel failure, a staged amount', async () => {
    expect([
      await call('POST', '/fulfillment/returns/test-return-none/refund', { refundCents: 100 }),
      await call('POST', `/fulfillment/returns/${ids.refundSkip}/refund`, {}),
      await call('POST', `/fulfillment/returns/${ids.refundSkip}/refund`, { refundCents: 1000, perLineAmounts: { 'test-ritem-other': 500 } }),
      await call('POST', `/fulfillment/returns/${ids.refundSkip}/refund`, { refundCents: 1000, skipChannelPush: true, reason: 'Refunded on eBay already' }, { 'x-user-id': 'test-user-1' }),
      await call('POST', `/fulfillment/returns/${ids.refundSkip}/refund`, { refundCents: 1000, skipChannelPush: true }),
      await refundsOf(ids.refundSkip),
      await returnOf(ids.refundSkip),
      await call('POST', `/fulfillment/returns/${ids.refundChannel}/refund`, {
        refundCents: 8000, kind: 'CASH', reason: 'Item damaged', grossCents: 10000, restockingFeeCents: 1500, returnShippingFeeCents: 500,
        perLineAmounts: { 'test-ritem-refund-channel-a': 5000, 'test-ritem-refund-channel-b': 3000 },
      }),
      await refundsOf(ids.refundChannel),
      await returnOf(ids.refundChannel),
      await call('POST', `/fulfillment/returns/${ids.refundAmazon}/refund`, { refundCents: 4000 }),
      await refundsOf(ids.refundAmazon),
      await call('POST', `/fulfillment/returns/${ids.refundFail}/refund`, { refundCents: 3000 }),
      await refundsOf(ids.refundFail),
      await returnOf(ids.refundFail),
      await call('POST', `/fulfillment/returns/${ids.refundStaged}/refund`, { skipChannelPush: true }),
      await refundsOf(ids.refundStaged),
      channel.calls.map((c) => stable(c)),
    ]).toMatchSnapshot()
  })
})
