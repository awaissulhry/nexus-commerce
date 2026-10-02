/**
 * MCP full control 07 O4 — `order-search` and `order-detail` v2, through the one door (call-tool.ts), on a real
 * PostgreSQL with the production schema and policies (PGlite).
 *
 *   - every order status is searchable, and with no status every status is a result (the Orders page's "All" tab
 *     hides cancelled, refunded and returned orders; Claude sees them); an unknown status is a wrong call
 *   - the page's filters: channel, marketplace, FBA/FBM, purchase dates, ship-by date, search text (order number,
 *     buyer, SKU, matched as typed)
 *   - a keyset cursor: every order once over the pages, none twice; a cursor with other filters is refused
 *   - the buyer is MASKED (O-1): first name, city, country, masked e-mail — never the surname, the street, the postal
 *     code, the phone or the e-mail
 *   - FBA and Multi-Channel Fulfilment orders: amazonShips (the fail-closed test), MCF requests read only
 *   - money: revenue, fees and net only with the financials permissions
 *   - another business's order is not found; an order in the bin is not a result
 */
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

import { callTool, ToolAccessError, type UserPrincipal } from '../call-tool.js'

const SECOND = 'test_o4_second_business'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const principal = (permissions: string[], workspaceId = LEGACY_WORKSPACE_ID): UserPrincipal => ({
  kind: 'user',
  userId: 'u-o4',
  label: '07 O4 test',
  permissions: { isOwner: false, permissions: new Set(permissions) },
  workspace: business(workspaceId),
  via: 'claude',
})
const everything = principal([...Object.values(FEATURES), ...Object.values(FIELDS)])
const noMoney = principal(Object.values(FEATURES))
type Out = { ok: boolean; error?: string; data?: Record<string, any> }
const call = async (tool: string, args: Record<string, unknown>, who: UserPrincipal = everything) =>
  (await callTool(who, tool, args)).visible as Out
const search = async (args: Record<string, unknown>, who?: UserPrincipal) => {
  const out = await call('order-search', args, who)
  expect(out.ok, out.error).toBe(true)
  return out.data!
}
const numbers = (data: Record<string, any>) => (data.orders as Array<{ channelOrderId: string }>).map((o) => o.channelOrderId)

const day = (n: number) => new Date(Date.UTC(2026, 3, n, 10))
const ids: Record<string, string> = {}

/** Personal data no answer may hold (O-1). */
const SECRETS = ['Rossi', 'Via Segreta 7', '00123', '+39 333 0000000', 'mario.rossi@example.test', 'RSSMRA80A01H501U']

beforeAll(async () => {
  database = await formulaDatabase()
  const db = database.client
  await db.workspace.create({ data: { id: SECOND, name: 'Second test business', createdByUserId: 'test', creationKey: 'test-o4-second' } })
  await withWorkspace(business(LEGACY_WORKSPACE_ID), async () => {
    const address = { name: 'Mario Rossi', line1: 'Via Segreta 7', postalCode: '00123', city: 'Testville', countryCode: 'IT', phone: '+39 333 0000000' }
    const make = async (key: string, data: Record<string, unknown>) => {
      const order = await db.order.create({
        data: {
          channel: 'EBAY', channelOrderId: `TEST-O4-${key}`, marketplace: 'IT', currencyCode: 'EUR', totalPrice: '10.00',
          customerName: 'Mario Rossi', customerEmail: 'mario.rossi@example.test', shippingAddress: address,
          codiceFiscale: 'RSSMRA80A01H501U', fulfillmentMethod: 'FBM', ...data,
        } as never,
      })
      ids[key] = order.id
      return order
    }
    // One order per status, a day apart (newest = RETURNED).
    const statuses = ['PENDING', 'AWAITING_PAYMENT', 'PROCESSING', 'ON_HOLD', 'PARTIALLY_SHIPPED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED', 'RETURNED']
    for (const [i, status] of statuses.entries()) await make(status, { status, purchaseDate: day(i + 1) })
    // Amazon FBA, Amazon FBM, an eBay order sent to MCF, and one whose MCF request was cancelled.
    await make('FBA', { channel: 'AMAZON', marketplace: 'DE', fulfillmentMethod: 'FBA', status: 'SHIPPED', purchaseDate: day(20), shipByDate: day(21) })
    await make('FBM', { channel: 'AMAZON', marketplace: 'DE', fulfillmentMethod: 'FBM', status: 'PROCESSING', purchaseDate: day(20), shipByDate: day(22) })
    await make('MCF', { status: 'PROCESSING', purchaseDate: day(19) })
    await db.mCFShipment.create({ data: { orderId: ids.MCF, amazonFulfillmentOrderId: 'TEST-MCF-1', status: 'PROCESSING', trackingNumber: 'TEST-MCF-TRACK' } })
    await make('MCF-CANCELLED', { status: 'PROCESSING', purchaseDate: day(18) })
    await db.mCFShipment.create({ data: { orderId: ids['MCF-CANCELLED'], amazonFulfillmentOrderId: 'TEST-MCF-2', status: 'CANCELLED' } })
    await make('BIN', { status: 'PROCESSING', purchaseDate: day(25), deletedAt: day(26) })
    await make('SKU', { status: 'PROCESSING', purchaseDate: day(17), customerEmail: 'j_smith@example.test' })
    await db.orderItem.create({ data: { orderId: ids.SKU, sku: 'TEST-O4-SKU_1', quantity: 1, price: '10.00' } as never })
    await db.orderItem.create({ data: { orderId: ids.FBA, sku: 'TEST-O4-SKU-FBA', quantity: 2, price: '5.00' } as never })
    await db.shipment.create({ data: { orderId: ids.SHIPPED, carrierCode: 'MANUAL', status: 'SHIPPED', trackingNumber: 'TEST-TRACK-1', shippedAt: day(7) } as never })
    await db.return.create({ data: { orderId: ids.RETURNED, channel: 'EBAY', rmaNumber: 'TEST-RMA-O4', status: 'RECEIVED', refundCents: 1000, receivedAt: day(12) } as never })
    await db.financialTransaction.create({ data: { orderId: ids.FBA, transactionType: 'Order', transactionDate: day(20), amount: '10.00', grossRevenue: '10.00', amazonFee: '1.50', fbaFee: '2.00', netRevenue: '6.50', status: 'Completed' } as never })
  })
  await withWorkspace(business(SECOND), async () => {
    const other = await db.order.create({
      data: {
        channel: 'EBAY', channelOrderId: 'TEST-O4-OTHER-BUSINESS', marketplace: 'IT', status: 'PROCESSING', currencyCode: 'EUR', totalPrice: '99.00',
        customerName: 'Other Buyer', customerEmail: 'other@example.test', shippingAddress: { city: 'Elsewhere' }, purchaseDate: day(15),
      } as never,
    })
    ids.OTHER = other.id
  })
}, 180_000)

afterAll(async () => {
  await database?.close()
}, 30_000)

describe('order-search v2', () => {
  it('every status is a result when none is named (cancelled, refunded and returned included); the bin is not', async () => {
    const data = await search({ limit: 100 })
    expect(new Set((data.orders as Array<{ status: string }>).map((o) => o.status))).toEqual(new Set([
      'PENDING', 'AWAITING_PAYMENT', 'PROCESSING', 'ON_HOLD', 'PARTIALLY_SHIPPED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED', 'RETURNED',
    ]))
    expect(numbers(data)).not.toContain('TEST-O4-BIN')
    expect(data.total).toBe(15)
  })

  it('each of the 10 statuses filters exactly its order; several at once; case does not matter; an unknown one is a wrong call', async () => {
    for (const status of ['PENDING', 'AWAITING_PAYMENT', 'ON_HOLD', 'PARTIALLY_SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED', 'RETURNED']) {
      expect(numbers(await search({ status }))).toEqual([`TEST-O4-${status}`])
    }
    expect(numbers(await search({ status: 'refunded,returned' }))).toEqual(['TEST-O4-RETURNED', 'TEST-O4-REFUNDED'])
    expect(numbers(await search({ status: ['cancelled'] }))).toEqual(['TEST-O4-CANCELLED'])
    await expect(callTool(everything, 'order-search', { status: 'lost' })).rejects.toMatchObject({ code: 'invalid_arguments' } satisfies Partial<ToolAccessError>)
  })

  it('channel, marketplace, FBA/FBM, purchase dates and ship-by date filter as the Orders page does', async () => {
    expect(numbers(await search({ channel: 'amazon' })).sort()).toEqual(['TEST-O4-FBA', 'TEST-O4-FBM'])
    expect(numbers(await search({ marketplace: 'de', fulfillment: 'FBA' }))).toEqual(['TEST-O4-FBA'])
    expect(numbers(await search({ dateFrom: '2026-04-02T00:00:00Z', dateTo: '2026-04-03T23:59:59Z' }))).toEqual(['TEST-O4-PROCESSING', 'TEST-O4-AWAITING_PAYMENT'])
    expect(numbers(await search({ shipByBefore: '2026-04-21T12:00:00Z' }))).toEqual(['TEST-O4-FBA'])
  })

  it('search finds an order number, a SKU and an e-mail, matched as typed (_ is a character)', async () => {
    expect(numbers(await search({ search: 'TEST-O4-ON_HOLD' }))).toEqual(['TEST-O4-ON_HOLD'])
    expect(numbers(await search({ search: 'SKU_1' }))).toEqual(['TEST-O4-SKU'])
    expect(numbers(await search({ buyer: 'j_smith' }))).toEqual(['TEST-O4-SKU'])
    expect(numbers(await search({ search: 'jxsmith' }))).toEqual([])
  })

  it('the cursor walks every order once, newest first; a cursor from other filters is refused', async () => {
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const data = await search({ limit: 4, ...(cursor ? { cursor } : {}) })
      seen.push(...numbers(data))
      cursor = data.nextCursor ?? undefined
      pages++
    } while (cursor && pages < 10)
    const all = numbers(await search({ limit: 100 }))
    expect(seen).toEqual(all)
    expect(new Set(seen).size).toBe(15)
    expect(pages).toBe(4)
    const first = await search({ limit: 4 })
    const wrong = await call('order-search', { limit: 4, channel: 'AMAZON', cursor: first.nextCursor })
    expect(wrong.ok).toBe(false)
    expect(wrong.error).toMatch(/cursor/)
  })

  it('the buyer is masked: first name, city, country and a masked e-mail; nothing else of them', async () => {
    const data = await search({ status: 'SHIPPED', channel: 'EBAY' })
    expect(data.orders[0].buyer).toEqual({ firstName: 'Mario', city: 'Testville', country: 'IT', email: 'm***@example.test' })
    const text = JSON.stringify(await search({ limit: 100 }))
    for (const secret of SECRETS) expect(text).not.toContain(secret)
  })

  it('FBA and an active MCF request: amazonShips; a cancelled MCF request and FBM: not', async () => {
    const byNumber = Object.fromEntries(((await search({ limit: 100 })).orders as Array<{ channelOrderId: string; amazonShips: boolean }>).map((o) => [o.channelOrderId, o.amazonShips]))
    expect(byNumber['TEST-O4-FBA']).toBe(true)
    expect(byNumber['TEST-O4-MCF']).toBe(true)
    expect(byNumber['TEST-O4-MCF-CANCELLED']).toBe(false)
    expect(byNumber['TEST-O4-FBM']).toBe(false)
  })

  it("another business's orders are never results", async () => {
    expect(numbers(await search({ limit: 100 }))).not.toContain('TEST-O4-OTHER-BUSINESS')
    expect(numbers(await search({ search: 'OTHER-BUSINESS' }))).toEqual([])
    // Control: inside that business, it is found.
    expect(numbers(await search({}, principal([...Object.values(FEATURES)], SECOND)))).toEqual(['TEST-O4-OTHER-BUSINESS'])
  })
})

describe('order-detail v2', () => {
  it('reads the order: status, dates, lines, shipments, returns, timeline; the buyer masked', async () => {
    const out = await call('order-detail', { orderId: ids.SHIPPED })
    expect(out.ok, out.error).toBe(true)
    expect(out.data).toMatchObject({
      channelOrderId: 'TEST-O4-SHIPPED', status: 'SHIPPED', fulfilment: { method: 'FBM', amazonShips: false, mcfRequests: [] },
      buyer: { firstName: 'Mario', city: 'Testville', country: 'IT', email: 'm***@example.test' },
      shipments: [{ carrier: 'MANUAL', status: 'SHIPPED', trackingNumber: 'TEST-TRACK-1' }],
    })
    expect(out.data!.timeline.map((e: { kind: string }) => e.kind)).toContain('shipment-shipped')
    const returned = await call('order-detail', { orderId: ids.RETURNED })
    expect(returned.data!.returns).toEqual([expect.objectContaining({ rmaNumber: 'TEST-RMA-O4', status: 'RECEIVED', refundCents: 1000 })])
    const text = JSON.stringify([out, returned])
    for (const secret of SECRETS) expect(text).not.toContain(secret)
  })

  it('an order Amazon ships via MCF shows its request read only', async () => {
    const out = await call('order-detail', { orderId: ids.MCF })
    expect(out.data!.fulfilment).toMatchObject({
      amazonShips: true,
      note: expect.stringMatching(/Nexus only reads it/),
      mcfRequests: [expect.objectContaining({ amazonFulfillmentOrderId: 'TEST-MCF-1', status: 'PROCESSING', trackingNumber: 'TEST-MCF-TRACK' })],
    })
  })

  it('money: revenue, fees and net only with the financials permissions; the order total always', async () => {
    const full = await call('order-detail', { orderId: ids.FBA })
    expect(full.data!.money).toMatchObject({ grossRevenue: 10, feesTotal: 3.5, netRevenue: 6.5, transactionCount: 1 })
    const limited = await call('order-detail', { orderId: ids.FBA }, noMoney)
    expect(limited.data!.money).not.toHaveProperty('grossRevenue')
    expect(limited.data!.money).not.toHaveProperty('feesTotal')
    expect(limited.data!.money).not.toHaveProperty('netRevenue')
    expect(limited.data!.totalPrice).toBe(10)
  })

  it("an order in the bin and another business's order are not found", async () => {
    expect(await call('order-detail', { orderId: ids.BIN })).toEqual({ ok: false, error: 'Order not found' })
    expect(await call('order-detail', { orderId: ids.OTHER })).toEqual({ ok: false, error: 'Order not found' })
  })

  it('without orders.view both tools are refused', async () => {
    const none = principal(Object.values(FEATURES).filter((p) => p !== FEATURES.ordersView))
    await expect(callTool(none, 'order-search', {})).rejects.toMatchObject({ code: 'forbidden' })
    await expect(callTool(none, 'order-detail', { orderId: ids.SHIPPED })).rejects.toMatchObject({ code: 'forbidden' })
  })
})
