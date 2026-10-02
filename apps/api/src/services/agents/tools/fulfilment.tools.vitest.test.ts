/**
 * MCP full control 07 O5 — `shipping-queue`, `shipment-detail` and `shipping-rates`, through the one door
 * (call-tool.ts), on a real PostgreSQL with the production schema and policies (PGlite).
 *
 *   - FBA is shown, never queued: every order Amazon ships (FBA, AFN, any case; an Amazon order without merchant
 *     evidence; a live MCF request) is under amazonShips and never in the queue; FBM, a Shopify order and an order
 *     whose MCF request was cancelled are queued
 *   - urgency, channel and search filters; a keyset cursor over the queue; an order in the bin is never queued
 *   - the buyer is masked (O-1)
 *   - shipment-detail: tracking events and tracking uploads; the label cost only with the costs permission
 *   - shipping-rates: the carrier read is MOCKED (nothing leaves the machine); refused for an FBA order's shipment
 *     before any carrier is asked
 *   - another business's shipment is not found; without outbound.manage the tools are refused
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
const carrier = vi.hoisted(() => ({ calls: [] as unknown[] }))
vi.mock('../../sendcloud/index.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveCredentials: vi.fn(async () => ({ publicKey: 'test', secretKey: 'test' })),
  listShippingMethods: vi.fn(async (_creds: unknown, filter: unknown) => {
    carrier.calls.push(filter)
    return [
      { id: 3002, name: 'Test Express', carrier: 'DHL', price: 12.5, minWeightKg: 0, maxWeightKg: 5 },
      { id: 3001, name: 'Test Standard', carrier: 'BRT', price: 4.2, minWeightKg: 0, maxWeightKg: 5 },
    ]
  }),
}))

import { callTool, type UserPrincipal } from '../call-tool.js'

const SECOND = 'test_o5_second_business'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const principal = (permissions: string[], workspaceId = LEGACY_WORKSPACE_ID): UserPrincipal => ({
  kind: 'user', userId: 'u-o5', label: '07 O5 test', permissions: { isOwner: false, permissions: new Set(permissions) },
  workspace: business(workspaceId), via: 'claude',
})
const everything = principal([...Object.values(FEATURES), ...Object.values(FIELDS)])
const noCosts = principal(Object.values(FEATURES))
type Out = { ok: boolean; error?: string; data?: Record<string, any> }
const call = async (tool: string, args: Record<string, unknown>, who: UserPrincipal = everything) => (await callTool(who, tool, args)).visible as Out
const queue = async (args: Record<string, unknown> = {}) => {
  const out = await call('shipping-queue', { limit: 100, ...args })
  expect(out.ok, out.error).toBe(true)
  return out.data!
}
const numbers = (orders: Array<{ channelOrderId: string }>) => orders.map((o) => o.channelOrderId)
const hours = (h: number) => new Date(Date.now() + h * 3_600_000)
const ids: Record<string, string> = {}
const SECRETS = ['Rossi', 'Via Segreta 7', '00123', '+39 333 0000000', 'mario.rossi@example.test']

beforeAll(async () => {
  database = await formulaDatabase()
  const db = database.client
  await db.workspace.create({ data: { id: SECOND, name: 'Second test business', createdByUserId: 'test', creationKey: 'test-o5-second' } })
  await withWorkspace(business(LEGACY_WORKSPACE_ID), async () => {
    const address = { name: 'Mario Rossi', line1: 'Via Segreta 7', postalCode: '00123', city: 'Testville', countryCode: 'IT', phone: '+39 333 0000000' }
    const make = async (key: string, data: Record<string, unknown>) => {
      ids[key] = (await db.order.create({
        data: {
          channel: 'EBAY', channelOrderId: `TEST-O5-${key}`, marketplace: 'IT', status: 'PROCESSING', currencyCode: 'EUR', totalPrice: '10.00',
          customerName: 'Mario Rossi', customerEmail: 'mario.rossi@example.test', shippingAddress: address, purchaseDate: hours(-48),
          items: { create: [{ sku: `TEST-O5-SKU-${key}`, quantity: 1, price: '10.00' }] }, ...data,
        } as never,
      })).id
    }
    // Queued (the business ships them), most urgent first.
    await make('OVERDUE-EBAY', { shipByDate: hours(-5), fulfillmentMethod: 'MFN' })
    await make('TODAY-SHOPIFY', { channel: 'SHOPIFY', shipByDate: hours(5), fulfillmentMethod: null })
    await make('TOMORROW-FBM', { channel: 'AMAZON', marketplace: 'DE', fulfillmentMethod: 'FBM', shipByDate: hours(30) })
    await make('WEEK-MCF-CANCELLED', { shipByDate: hours(100) })
    await make('NO-DATE', { shipByDate: null, status: 'PENDING' })
    // Amazon ships them: never queued.
    await make('FBA', { channel: 'AMAZON', fulfillmentMethod: 'FBA', shipByDate: hours(3) })
    await make('FBA-LOWER', { channel: 'AMAZON', fulfillmentMethod: 'fba', shipByDate: hours(4) })
    await make('AFN', { channel: 'AMAZON', fulfillmentMethod: 'AFN', shipByDate: hours(6) })
    await make('AMAZON-UNKNOWN', { channel: 'AMAZON', fulfillmentMethod: null, shipByDate: hours(7) })
    await make('AMAZON-NEW-WORD', { channel: 'AMAZON', fulfillmentMethod: 'something new', shipByDate: hours(8) })
    await make('EBAY-MCF', { shipByDate: hours(9) })
    await db.mCFShipment.create({ data: { orderId: ids['EBAY-MCF'], amazonFulfillmentOrderId: 'TEST-O5-MCF-1', status: 'PROCESSING' } })
    await db.mCFShipment.create({ data: { orderId: ids['WEEK-MCF-CANCELLED'], amazonFulfillmentOrderId: 'TEST-O5-MCF-2', status: 'CANCELLED' } })
    // Not in the queue at all: shipped, or with a live shipment.
    await make('SHIPPED', { status: 'SHIPPED', shipByDate: hours(-50) })
    await make('PACKED', { shipByDate: hours(1) })
    await make('IN-BIN', { shipByDate: hours(-3), deletedAt: new Date() })
    ids.warehouse = (await db.warehouse.create({ data: { code: 'TEST-O5-WH', name: 'Test warehouse', isDefault: true } as never })).id
    ids.shipment = (await db.shipment.create({
      data: {
        orderId: ids.PACKED, warehouseId: ids.warehouse, carrierCode: 'SENDCLOUD', status: 'SHIPPED', trackingNumber: 'TEST-O5-TRACK',
        weightGrams: 1800, costCents: 590, shippedAt: hours(-1), items: { create: [{ sku: 'TEST-O5-SKU-PACKED', quantity: 1 }] },
      } as never,
    })).id
    await db.trackingEvent.create({ data: { shipmentId: ids.shipment, occurredAt: hours(-1), code: 'IN_TRANSIT', description: 'Parcel in transit', location: 'Testville hub', source: 'SENDCLOUD' } })
    await db.trackingMessageLog.create({ data: { shipmentId: ids.shipment, channel: 'EBAY', marketplace: 'IT', status: 'FAILED', attemptCount: 2, lastError: 'test error', requestPayload: { buyer: 'mario.rossi@example.test' } } as never })
    // An FBA order that already has a shipment (made before 07 O1): no rates may be asked for it.
    await make('FBA-WITH-SHIPMENT', { channel: 'AMAZON', fulfillmentMethod: 'FBA', status: 'SHIPPED' })
    ids.fbaShipment = (await db.shipment.create({ data: { orderId: ids['FBA-WITH-SHIPMENT'], carrierCode: 'MANUAL', status: 'DRAFT' } as never })).id
    ids.binShipment = (await db.shipment.create({ data: { orderId: ids.SHIPPED, carrierCode: 'MANUAL', status: 'DRAFT', deletedAt: new Date() } as never })).id
  })
  await withWorkspace(business(SECOND), async () => {
    const other = await db.order.create({
      data: {
        channel: 'EBAY', channelOrderId: 'TEST-O5-OTHER', marketplace: 'IT', status: 'PROCESSING', currencyCode: 'EUR', totalPrice: '9.00',
        customerName: 'Other Buyer', customerEmail: 'other@example.test', shippingAddress: { city: 'Elsewhere' }, purchaseDate: new Date(), shipByDate: hours(2),
      } as never,
    })
    ids.otherShipment = (await db.shipment.create({ data: { orderId: other.id, carrierCode: 'MANUAL', status: 'DRAFT' } as never })).id
  })
}, 180_000)

afterAll(async () => {
  await database?.close()
}, 30_000)

describe('shipping-queue', () => {
  it('FBA is shown, never queued: every order Amazon ships is under amazonShips; the rest are queued, most urgent first', async () => {
    const data = await queue()
    expect(numbers(data.orders)).toEqual(['TEST-O5-OVERDUE-EBAY', 'TEST-O5-TODAY-SHOPIFY', 'TEST-O5-TOMORROW-FBM', 'TEST-O5-WEEK-MCF-CANCELLED', 'TEST-O5-NO-DATE'])
    expect(data.orders.map((o: { urgency: string }) => o.urgency)).toEqual(['OVERDUE', 'TODAY', 'TOMORROW', 'THIS_WEEK', 'UNKNOWN'])
    expect(data.total).toBe(5)
    expect(numbers(data.orders)).not.toContain('TEST-O5-IN-BIN')
    expect(data.amazonShips.total).toBe(6)
    expect(numbers(data.amazonShips.orders).sort()).toEqual(
      ['TEST-O5-AFN', 'TEST-O5-AMAZON-NEW-WORD', 'TEST-O5-AMAZON-UNKNOWN', 'TEST-O5-EBAY-MCF', 'TEST-O5-FBA', 'TEST-O5-FBA-LOWER'],
    )
  })

  it('urgency, channel and search filter the queue; the FBA list follows the same filters', async () => {
    expect(numbers((await queue({ urgency: 'overdue,unknown' })).orders)).toEqual(['TEST-O5-OVERDUE-EBAY', 'TEST-O5-NO-DATE'])
    const amazon = await queue({ channel: 'AMAZON' })
    expect(numbers(amazon.orders)).toEqual(['TEST-O5-TOMORROW-FBM'])
    expect(amazon.amazonShips.total).toBe(5)
    expect(numbers((await queue({ search: 'SKU-TODAY' })).orders)).toEqual(['TEST-O5-TODAY-SHOPIFY'])
  })

  it('the cursor walks the queue once, in order', async () => {
    const seen: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 5; page++) {
      const data = await queue({ limit: 2, ...(cursor ? { cursor } : {}) })
      seen.push(...numbers(data.orders))
      cursor = data.nextCursor ?? undefined
      if (!cursor) break
    }
    expect(seen).toEqual(numbers((await queue()).orders))
  })

  it('the buyer is masked', async () => {
    const data = await queue()
    expect(data.orders[0].buyer).toEqual({ firstName: 'Mario', city: 'Testville', country: 'IT', email: 'm***@example.test' })
    const text = JSON.stringify(data)
    for (const secret of SECRETS) expect(text).not.toContain(secret)
  })
})

describe('shipment-detail', () => {
  it('reads the shipment, its tracking events and its tracking uploads; the buyer masked; no upload payload', async () => {
    const out = await call('shipment-detail', { shipmentId: ids.shipment })
    expect(out.ok, out.error).toBe(true)
    expect(out.data).toMatchObject({
      status: 'SHIPPED', carrier: 'SENDCLOUD', trackingNumber: 'TEST-O5-TRACK', labelCostCents: 590, weightGrams: 1800,
      warehouse: { code: 'TEST-O5-WH' }, lines: [{ sku: 'TEST-O5-SKU-PACKED', quantity: 1 }],
      order: { channelOrderId: 'TEST-O5-PACKED', buyer: { firstName: 'Mario', city: 'Testville' } },
      trackingEvents: [expect.objectContaining({ code: 'IN_TRANSIT', location: 'Testville hub' })],
      trackingUploads: [expect.objectContaining({ channel: 'EBAY', status: 'FAILED', attemptCount: 2, lastError: 'test error' })],
    })
    const text = JSON.stringify(out)
    for (const secret of SECRETS) expect(text).not.toContain(secret)
  })

  it('the label cost only with the costs permission', async () => {
    const out = await call('shipment-detail', { shipmentId: ids.shipment }, noCosts)
    expect(out.ok).toBe(true)
    expect(out.data).not.toHaveProperty('labelCostCents')
  })

  it("a shipment in the bin and another business's shipment are not found", async () => {
    expect(await call('shipment-detail', { shipmentId: ids.binShipment })).toEqual({ ok: false, error: 'Shipment not found' })
    expect(await call('shipment-detail', { shipmentId: ids.otherShipment })).toEqual({ ok: false, error: 'Shipment not found' })
  })
})

describe('shipping-rates (carrier read mocked)', () => {
  it('Sendcloud rates, cheapest first, for the weight and destination; the modes said', async () => {
    carrier.calls.length = 0
    const out = await call('shipping-rates', { shipmentId: ids.shipment })
    expect(out.ok, out.error).toBe(true)
    expect(out.data!.rates.map((r: { serviceName: string; priceEur: number }) => [r.serviceName, r.priceEur])).toEqual([['Test Standard', 4.2], ['Test Express', 12.5]])
    expect(out.data).toMatchObject({ destinationCountry: 'IT', weightKg: 1.8, carrierModes: { sendcloud: 'sample rates (Sendcloud dry run)', amazonBuyShipping: 'not for this channel' } })
    expect(carrier.calls).toEqual([{ weightKg: 1.8, toCountry: 'IT' }])
  })

  it('refused for a shipment of an order Amazon ships, before any carrier is asked', async () => {
    carrier.calls.length = 0
    const out = await call('shipping-rates', { shipmentId: ids.fbaShipment })
    expect(out).toEqual({ ok: false, error: expect.stringContaining('Amazon ships this order') })
    expect(carrier.calls).toEqual([])
  })

  it("another business's shipment is not found, and no carrier is asked", async () => {
    carrier.calls.length = 0
    expect(await call('shipping-rates', { shipmentId: ids.otherShipment })).toEqual({ ok: false, error: 'Shipment not found' })
    expect(carrier.calls).toEqual([])
  })
})

describe('permissions', () => {
  it('without outbound.manage the three tools are refused', async () => {
    const none = principal(Object.values(FEATURES).filter((p) => p !== FEATURES.outboundManage))
    for (const [tool, args] of [['shipping-queue', {}], ['shipment-detail', { shipmentId: ids.shipment }], ['shipping-rates', { shipmentId: ids.shipment }]] as const) {
      await expect(callTool(none, tool, args)).rejects.toMatchObject({ code: 'forbidden' })
    }
  })
})
