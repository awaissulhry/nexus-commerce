/**
 * MCP full control 07 O6 — `return-search`, `customer-lookup`, `review-search`, `order-report`, `privacy-requests`,
 * through the one door (call-tool.ts), on a real PostgreSQL with the production schema and policies (PGlite).
 *
 * Per tool: refused without its permission; no personal data (O-1: first name, city, country, masked e-mail at most);
 * a keyset cursor that walks every row once; another business's rows never come back. order-report: each kind, the
 * extra permission each kind needs, revenue only with the revenue permission. privacy-requests: no personal data at all.
 */
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))

import { callTool, type UserPrincipal } from '../call-tool.js'

const SECOND = 'test_o6_second_business'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const principal = (permissions: string[], workspaceId = LEGACY_WORKSPACE_ID): UserPrincipal => ({
  kind: 'user', userId: 'u-o6', label: '07 O6 test', permissions: { isOwner: false, permissions: new Set(permissions) },
  workspace: business(workspaceId), via: 'claude',
})
const everything = principal([...Object.values(FEATURES), ...Object.values(FIELDS)])
const noMoney = principal(Object.values(FEATURES))
const without = (permission: string) => principal([...Object.values(FEATURES), ...Object.values(FIELDS)].filter((p) => p !== permission))
type Out = { ok: boolean; error?: string; data?: Record<string, any> }
const call = async (tool: string, args: Record<string, unknown>, who: UserPrincipal = everything) => (await callTool(who, tool, args)).visible as Out
const read = async (tool: string, args: Record<string, unknown>, who?: UserPrincipal) => {
  const out = await call(tool, args, who)
  expect(out.ok, out.error).toBe(true)
  return out.data!
}
/** Walks every page of a list tool with `limit`, and returns the ids in order. */
async function walk(tool: string, list: string, args: Record<string, unknown>, limit: number): Promise<string[]> {
  const seen: string[] = []
  let cursor: string | undefined
  for (let page = 0; page < 20; page++) {
    const data = await read(tool, { ...args, limit, ...(cursor ? { cursor } : {}) })
    seen.push(...(data[list] as Array<{ id: string }>).map((row) => row.id))
    cursor = data.nextCursor ?? undefined
    if (!cursor) return seen
  }
  throw new Error('too many pages')
}

const day = (n: number) => new Date(Date.now() - n * 86_400_000)

/**
 * A verified eBay deletion notice matched to an eBay order of the business, inserted as the database owner (only the
 * ingress may write these; the guards ask for an OAuth eBay connection, the buyer's eBay user name on the order and a
 * retained verified notice). Returns the request id.
 */
async function erasureRequest(workspaceId: string, orderId: string): Promise<string> {
  const sql = (text: string, params: unknown[]) => database.db.query(text, params)
  const connection = randomUUID()
  await sql(`INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","externalAccountId","managedBy","authStatus","isActive","connectionMetadata","updatedAt")
    VALUES ($1,$2,'EBAY',$3,'oauth','connected',true,'{"environment":"production"}'::jsonb,now())`, [connection, workspaceId, `seller-${connection}`])
  await sql(`UPDATE "Order" SET "channelConnectionId"=$2, "ebayMetadata"='{"buyer":{"username":"test-user"}}'::jsonb WHERE id=$1`, [orderId, connection])
  const notice = randomUUID()
  await sql(`INSERT INTO "EbayNoticeQuarantine" (id,environment,"signatureOk","externalId",topic,"payloadEnc","payloadKeyId","payloadDigest",reason)
    VALUES ($1,'production',true,$1,'MARKETPLACE_ACCOUNT_DELETION','v1:synthetic','env',$2,'account_deletion_review_required')`, [notice, createHash('sha256').update(notice).digest('hex')])
  const id = randomUUID()
  await sql(`INSERT INTO "ErasureRequest" (id,"workspaceId","quarantineId","evidenceOrderId",channel,environment,"matchBasis",status)
    VALUES ($1,$2,$3,$4,'EBAY','production','username','REVIEW_REQUIRED')`, [id, workspaceId, notice, orderId])
  return id
}
const ids: Record<string, string> = {}
/** Personal data no answer may hold. */
const SECRETS = ['Rossi', 'Bianchi', 'Via Segreta 7', '00123', '+39 333 0000000', 'mario.rossi@example.test', 'anna.bianchi@example.test', 'RSSMRA80A01H501U']

beforeAll(async () => {
  database = await formulaDatabase()
  const db = database.client
  await db.workspace.create({ data: { id: SECOND, name: 'Second test business', createdByUserId: 'test', creationKey: 'test-o6-second' } })
  await withWorkspace(business(LEGACY_WORKSPACE_ID), async () => {
    // The business's company identity (Settings › Company): the corrispettivi preview carries its P.IVA. Invented.
    await db.brandSettings.create({ data: { companyName: 'Test Company S.r.l.', piva: 'IT11111111111', addressLines: ['Via Prova 9', '47999 Testborgo (RN)'] } })
    const address = { name: 'Mario Rossi', line1: 'Via Segreta 7', postalCode: '00123', city: 'Testville', countryCode: 'IT', phone: '+39 333 0000000' }
    ids.customer = (await db.customer.create({
      data: {
        id: 'test-o6-customer-mario', email: 'mario.rossi@example.test', name: 'Mario Rossi', codiceFiscale: 'RSSMRA80A01H501U', totalOrders: 2,
        totalSpentCents: 4999n, lastOrderAt: day(1), firstOrderAt: day(40), tags: ['vip'], riskFlag: 'LOW',
        addresses: { create: [{ type: 'SHIPPING', isPrimary: true, recipient: 'Mario Rossi', line1: 'Via Segreta 7', city: 'Testville', postalCode: '00123', country: 'IT', phone: '+39 333 0000000' }] },
      } as never,
    })).id
    for (const [n, name, email, last] of [[2, 'Anna Bianchi', 'anna.bianchi@example.test', 3], [3, 'Luca Verdi', 'luca@example.test', 5], [4, 'Sara Neri', 'sara@example.test', null]] as const) {
      await db.customer.create({ data: { id: `test-o6-customer-${n}`, email, name, lastOrderAt: last == null ? null : day(last), totalOrders: 1 } as never })
    }
    const order = async (key: string, data: Record<string, unknown>) => {
      ids[key] = (await db.order.create({
        data: {
          channel: 'EBAY', channelOrderId: `TEST-O6-${key}`, marketplace: 'IT', status: 'DELIVERED', currencyCode: 'EUR', totalPrice: '25.00',
          customerName: 'Mario Rossi', customerEmail: 'mario.rossi@example.test', shippingAddress: address, purchaseDate: day(10),
          customerId: ids.customer, ...data,
        } as never,
      })).id
    }
    await order('A', {})
    await order('B', { channel: 'SHOPIFY', totalPrice: '24.99', purchaseDate: day(2), status: 'PROCESSING', shipByDate: day(1), fulfillmentMethod: null, items: { create: [{ sku: 'TEST-O6-SKU-B', quantity: 1, price: '24.99' }] } })
    // Returns: one received 20 days ago (refund overdue), one received 12 days ago (due soon), one refunded, one FBA.
    const ret = async (key: string, data: Record<string, unknown>) => {
      ids[key] = (await db.return.create({
        data: { orderId: ids.A, channel: 'EBAY', marketplace: 'IT', rmaNumber: `TEST-RMA-${key}`, reason: 'Wrong size', refundCents: 2500, ...data, items: { create: [{ sku: `TEST-O6-SKU-${key}`, quantity: 1 }] } } as never,
      })).id
    }
    await ret('OVERDUE', { status: 'RECEIVED', receivedAt: day(20), createdAt: day(25) })
    await ret('DUE-SOON', { status: 'INSPECTING', receivedAt: day(12), createdAt: day(14) })
    await ret('REFUNDED', { status: 'REFUNDED', receivedAt: day(9), refundedAt: day(8), refundStatus: 'REFUNDED', createdAt: day(11) })
    await ret('FBA', { channel: 'AMAZON', marketplace: 'DE', status: 'REQUESTED', isFbaReturn: true, reason: 'Defective', createdAt: day(3) })
    await db.refund.create({ data: { returnId: ids.REFUNDED, amountCents: 2500, channel: 'EBAY', channelStatus: 'POSTED' } as never })
    // Reviews: 5, 2 (answered), 1 (unanswered).
    const product = await db.product.create({ data: { sku: 'TEST-O6-SKU-REVIEW', name: 'Test jacket', basePrice: '25.00' } as never })
    ids.product = product.id
    const review = async (key: string, rating: number, posted: number, extra: Record<string, unknown> = {}) => {
      ids[key] = (await db.review.create({
        data: { channel: 'EBAY', marketplace: 'IT', externalReviewId: `TEST-REV-${key}`, productId: product.id, sku: product.sku, rating, title: `Title ${key}`, body: `Body ${key} about the zipper`, authorName: 'Anna Bianchi', postedAt: day(posted), ...extra } as never,
      })).id
    }
    await review('FIVE', 5, 1)
    await review('TWO', 2, 2)
    await review('ONE', 1, 3, { body: 'x'.repeat(900) })
    await db.reviewResponse.create({ data: { reviewId: ids.TWO, channel: 'EBAY', body: 'Sorry to hear it', status: 'SENT', sentAt: day(1) } as never })
    await db.reviewRequest.create({ data: { orderId: ids.A, channel: 'EBAY', status: 'SENT', sentAt: day(5) } as never })
  })
  await withWorkspace(business(SECOND), async () => {
    const other = await db.order.create({
      data: { channel: 'EBAY', channelOrderId: 'TEST-O6-OTHER', marketplace: 'IT', status: 'DELIVERED', currencyCode: 'EUR', totalPrice: '9.00', customerName: 'Other Buyer', customerEmail: 'other@example.test', shippingAddress: { city: 'Elsewhere' }, purchaseDate: day(1) } as never,
    })
    ids.otherReturn = (await db.return.create({ data: { orderId: other.id, channel: 'EBAY', rmaNumber: 'TEST-RMA-OTHER' } as never })).id
    ids.otherCustomer = (await db.customer.create({ data: { id: 'test-o6-customer-other', email: 'other@example.test', name: 'Other Buyer' } as never })).id
    await db.review.create({ data: { channel: 'EBAY', externalReviewId: 'TEST-REV-OTHER', rating: 3, body: 'Other business review', postedAt: day(1) } as never })
    ids.otherOrder = other.id
  })
  // Privacy notices matched to an order: two in this business, one in the other.
  ids.erasure = await erasureRequest(LEGACY_WORKSPACE_ID, ids.A)
  ids.erasureB = await erasureRequest(LEGACY_WORKSPACE_ID, ids.A)
  await erasureRequest(SECOND, ids.otherOrder)
}, 180_000)

afterAll(async () => {
  await database?.close()
}, 30_000)

describe('return-search', () => {
  it('filters by status, channel, FBA and search; lines, refunds and the order with the buyer masked', async () => {
    expect((await read('return-search', {})).total).toBe(4)
    expect((await read('return-search', { status: 'received,inspecting' })).returns.map((r: { rmaNumber: string }) => r.rmaNumber)).toEqual(['TEST-RMA-DUE-SOON', 'TEST-RMA-OVERDUE'])
    expect((await read('return-search', { fba: true })).returns.map((r: { rmaNumber: string }) => r.rmaNumber)).toEqual(['TEST-RMA-FBA'])
    expect((await read('return-search', { fba: 'false' })).total).toBe(3)
    expect((await read('return-search', { channel: 'AMAZON' })).total).toBe(1)
    const found = await read('return-search', { search: 'SKU-REFUNDED' })
    expect(found.returns).toEqual([expect.objectContaining({
      rmaNumber: 'TEST-RMA-REFUNDED', status: 'REFUNDED', items: [expect.objectContaining({ sku: 'TEST-O6-SKU-REFUNDED' })],
      refunds: [expect.objectContaining({ amountCents: 2500, channelStatus: 'POSTED' })],
      order: { id: ids.A, channelOrderId: 'TEST-O6-A', buyer: { firstName: 'Mario', city: 'Testville', country: 'IT', email: 'm***@example.test' } },
    })])
  })

  it('pages every return once; no personal data; never another business', async () => {
    const all = (await read('return-search', { limit: 100 })).returns.map((r: { id: string }) => r.id)
    expect(await walk('return-search', 'returns', {}, 1)).toEqual(all)
    const text = JSON.stringify(await read('return-search', { limit: 100 }))
    for (const secret of SECRETS) expect(text).not.toContain(secret)
    expect(all).not.toContain(ids.otherReturn)
  })

  it('refused without returns.view', async () => {
    await expect(callTool(without(FEATURES.returnsView), 'return-search', {})).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('customer-lookup', () => {
  it('a customer masked: first name, city, country, masked e-mail; recent orders by customerId', async () => {
    const data = await read('customer-lookup', { customerId: ids.customer })
    expect(data.customers).toEqual([expect.objectContaining({
      id: ids.customer, firstName: 'Mario', email: 'm***@example.test', city: 'Testville', country: 'IT', totalOrders: 2, totalSpentCents: 4999, tags: ['vip'], riskFlag: 'LOW',
    })])
    expect(data.recentOrders.map((o: { channelOrderId: string }) => o.channelOrderId)).toEqual(['TEST-O6-B', 'TEST-O6-A'])
    const text = JSON.stringify(data)
    for (const secret of SECRETS) expect(text).not.toContain(secret)
  })

  it('search, paging (most recent buyer first, no last order last), and total spend only with the revenue permission', async () => {
    expect((await read('customer-lookup', { search: 'bianchi' })).customers.map((c: { firstName: string }) => c.firstName)).toEqual(['Anna'])
    expect(await walk('customer-lookup', 'customers', {}, 1)).toEqual(['test-o6-customer-mario', 'test-o6-customer-2', 'test-o6-customer-3', 'test-o6-customer-4'])
    expect((await read('customer-lookup', { customerId: ids.customer }, noMoney)).customers[0]).not.toHaveProperty('totalSpentCents')
  })

  it("another business's customer is not found; refused without customers.view", async () => {
    expect(await call('customer-lookup', { customerId: ids.otherCustomer })).toEqual({ ok: false, error: 'Customer not found' })
    await expect(callTool(without(FEATURES.customersView), 'customer-lookup', {})).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('review-search', () => {
  it('rating, unanswered and words filter; the reviewer is a first name; long text is cut; the average of all that match', async () => {
    const all = await read('review-search', {})
    expect(all.total).toBe(3)
    expect(all.averageRating).toBe(2.67)
    expect(all.reviews[0]).toMatchObject({ reviewer: 'Anna', rating: 5, sku: 'TEST-O6-SKU-REVIEW' })
    expect((await read('review-search', { maxRating: 2 })).reviews.map((r: { id: string }) => r.id)).toEqual([ids.TWO, ids.ONE])
    expect((await read('review-search', { maxRating: 2, unanswered: true })).reviews.map((r: { id: string }) => r.id)).toEqual([ids.ONE])
    expect((await read('review-search', { search: 'zipper' })).total).toBe(2)
    const long = (await read('review-search', { maxRating: 1 })).reviews[0]
    expect(long.body).toHaveLength(601)
    expect(JSON.stringify(all)).not.toContain('Bianchi')
  })

  it('pages every review once; never another business; refused without reviews.view', async () => {
    expect(await walk('review-search', 'reviews', {}, 2)).toEqual([ids.FIVE, ids.TWO, ids.ONE])
    expect(JSON.stringify(await read('review-search', { limit: 100 }))).not.toContain('Other business review')
    await expect(callTool(without(FEATURES.reviewsView), 'review-search', {})).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('order-report', () => {
  it('orders: by status, channel and marketplace; to ship and late; sales only with the revenue permission', async () => {
    const data = await read('order-report', { kind: 'orders', days: 30 })
    expect(data).toMatchObject({ kind: 'orders', total: 2, byStatus: { DELIVERED: 1, PROCESSING: 1 }, byChannel: { EBAY: 1, SHOPIFY: 1 }, byMarketplace: { IT: 2 }, toShip: 1, lateToShip: 1 })
    expect(data.salesByCurrency).toEqual({ EUR: 49.99 })
    expect(await read('order-report', { kind: 'orders' }, noMoney)).not.toHaveProperty('salesByCurrency')
  })

  it('refund-deadlines: overdue, due soon, later against 14 days from receipt', async () => {
    const data = await read('order-report', { kind: 'refund-deadlines' })
    expect(data).toMatchObject({ open: 2, overdue: 1, dueSoon: 1, later: 0 })
    expect(data.mostUrgent.map((r: { rmaNumber: string }) => r.rmaNumber)).toEqual(['TEST-RMA-OVERDUE', 'TEST-RMA-DUE-SOON'])
  })

  it('returns, review-requests, shipping, sync-health and corrispettivi run', async () => {
    expect(await read('order-report', { kind: 'returns', days: 30 })).toMatchObject({ total: 4, fbaReturns: 1, byStatus: { RECEIVED: 1, INSPECTING: 1, REFUNDED: 1, REQUESTED: 1 }, topReasons: [{ reason: 'Wrong size', count: 3 }, { reason: 'Defective', count: 1 }] })
    expect(await read('order-report', { kind: 'review-requests' })).toMatchObject({ byStatus: { SENT: 1 }, byChannel: { EBAY: 1 } })
    expect(await read('order-report', { kind: 'shipping' })).toMatchObject({ queue: { overdue: 1 }, amazonShipsNotQueued: 0 })
    expect((await read('order-report', { kind: 'sync-health' })).channels.map((c: { channel: string }) => c.channel).sort()).toEqual(['EBAY', 'SHOPIFY'])
    const corrispettivi = await read('order-report', { kind: 'corrispettivi', date: day(2).toISOString().slice(0, 10) })
    expect(corrispettivi).toMatchObject({ orderCount: 1, grandTotal: 24.99 })
    expect(corrispettivi).not.toHaveProperty('xml')
  })

  it('each kind needs its own permission on top of orders.view', async () => {
    for (const [kind, permission] of [['shipping', FEATURES.outboundManage], ['returns', FEATURES.returnsView], ['refund-deadlines', FEATURES.returnsView], ['review-requests', FEATURES.reviewsView], ['corrispettivi', FEATURES.ordersExport], ['corrispettivi', FIELDS.financialsRevenueView]] as const) {
      const out = await call('order-report', { kind }, without(permission))
      expect({ kind, ok: out.ok, error: out.error }).toEqual({ kind, ok: false, error: expect.stringContaining(permission) })
    }
    await expect(callTool(without(FEATURES.ordersView), 'order-report', { kind: 'orders' })).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('privacy-requests', () => {
  it('lists the requests with no personal data, the count waiting for a decision, and pages', async () => {
    const data = await read('privacy-requests', {})
    expect(data).toMatchObject({ total: 2, byStatus: { REVIEW_REQUIRED: 2 } })
    const matched = data.requests.find((r: { id: string }) => r.id === ids.erasure)
    expect(matched).toMatchObject({ channel: 'EBAY', matchBasis: 'username', status: 'REVIEW_REQUIRED', evidenceOrder: { id: ids.A, channelOrderId: 'TEST-O6-A' } })
    expect((await read('privacy-requests', { status: 'HELD' })).total).toBe(0)
    expect(JSON.stringify(data)).not.toContain('test-user')
    expect((await walk('privacy-requests', 'requests', {}, 1)).sort()).toEqual(data.requests.map((r: { id: string }) => r.id).sort())
    const text = JSON.stringify(data)
    for (const secret of SECRETS) expect(text).not.toContain(secret)
    expect(text).not.toContain('TEST-O6-OTHER')
  })

  it('refused without customers.view', async () => {
    await expect(callTool(without(FEATURES.customersView), 'privacy-requests', {})).rejects.toMatchObject({ code: 'forbidden' })
  })
})
