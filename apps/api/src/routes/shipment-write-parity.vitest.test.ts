/**
 * MCP full control 07 O8 — the shipment writes Claude's shipping tools use move out of the routes into
 * services/fulfillment/shipment.service.ts (and the return label into services/returns/return-label.service.ts) with
 * NO change to what the routes do and answer. The snapshots in __snapshots__/shipment-write-parity.vitest.test.ts.snap
 * were written by the route code BEFORE the move: create (one, bulk), print label (MANUAL, Sendcloud, Amazon Buy
 * Shipping, refusals), hold, release, service, void label, and the return label — with the rows they leave.
 *
 * Real SQL (PGlite with the production schema) and the real route plugins; the carriers are mocked (nothing leaves the
 * machine) and answer the same every run. Ids and times the database makes are masked.
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
const carrier = vi.hoisted(() => ({ parcels: [] as unknown[], voided: [] as unknown[], next: 7000 }))
vi.mock('../services/sendcloud/index.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveCredentials: vi.fn(async () => ({ publicKey: 'test', secretKey: 'test' })),
  resolveServiceMap: vi.fn(async () => null),
  getSendcloudMode: vi.fn(() => ({ dryRun: true, env: 'test' })),
  createParcel: vi.fn(async (_creds: unknown, input: Record<string, unknown>) => {
    carrier.parcels.push(input)
    const n = ++carrier.next
    return {
      id: n, tracking_number: `TEST-SC-${n}`, tracking_url: `https://track.example.test/${n}`,
      label: { normal_printer: [`https://label.example.test/${n}.pdf`] }, shipment: { name: 'Test Standard' }, status: { id: 1000 },
    }
  }),
  voidParcel: vi.fn(async (_creds: unknown, parcelId: number) => {
    carrier.voided.push(parcelId)
    return { ok: true }
  }),
}))
vi.mock('../services/amazon-pushback/buy-shipping.js', () => ({
  getEligibleShippingServices: vi.fn(async () => [
    { shippingServiceName: 'TEST GROUND', carrierName: 'DPD', shippingServiceId: 'TEST-SVC', shippingServiceOfferId: 'TEST-OFFER-1', rate: { currencyCode: 'EUR', amount: 5.5 } },
  ]),
  createShipment: vi.fn(async () => ({
    amazonShipmentId: 'TEST-AMZ-SHIP-1', shippingServiceId: 'TEST-SVC', carrierName: 'DPD', trackingId: 'TEST-BS-TRACK-1',
    labelData: 'JVBERi0xLjQ=', labelFormat: 'PDF', rate: { currencyCode: 'EUR', amount: 5.5 }, dryRun: true,
  })),
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const MADE = new Set(['id', 'external_reference', 'createdAt', 'updatedAt', 'labelPrintedAt', 'heldAt', 'returnLabelGeneratedAt', 'workspaceId', 'occurredAt', 'shipmentId', 'orderItemId'])
const stable = (value: unknown) => JSON.parse(JSON.stringify(value, (key, v) => (MADE.has(key) ? '<made>' : v)))
const ADDRESS = { AddressLine1: 'Via Test 1', City: 'Testville', PostalCode: '00100', CountryCode: 'IT' }

describe('07 O8 — shipment writes: the routes answer exactly as before the move', () => {
  let app: FastifyInstance
  const post = async (url: string, payload: unknown = {}, method: 'POST' | 'PATCH' = 'POST') => {
    const response = await app.inject({ method, url: `/api${url}`, payload: payload as object })
    return { status: response.statusCode, body: stable(JSON.parse(response.body || '{}')) }
  }
  const shipmentOf = async (orderId: string) => stable(await inside(() => database.client.shipment.findMany({
    where: { orderId }, select: { id: true, status: true, carrierCode: true, serviceCode: true, serviceName: true, trackingNumber: true, labelUrl: true, sendcloudParcelId: true, costCents: true, heldReason: true },
  })))
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    database = await formulaDatabase()
    await inside(async () => {
      ids.warehouse = (await database.client.warehouse.create({ data: { id: 'test-wh', code: 'TEST-WH', name: 'Test warehouse', isDefault: true, addressLine1: 'Via Magazzino 1', city: 'Testville', postalCode: '00100', country: 'IT' } as never })).id
      const order = async (key: string, data: Record<string, unknown> = {}) => (await database.client.order.create({
        data: {
          id: `test-order-${key}`, channel: 'EBAY', channelOrderId: `TEST-${key}`, marketplace: 'IT', status: 'PROCESSING', currencyCode: 'EUR',
          totalPrice: '20.00', customerName: 'Test Buyer', customerEmail: 'buyer@example.test', shippingAddress: ADDRESS, purchaseDate: new Date('2026-04-01T10:00:00Z'),
          items: { create: [{ id: `test-item-${key}`, sku: `TEST-SKU-${key}`, quantity: 1, price: '20.00' }] }, ...data,
        } as never,
      })).id
      for (const key of ['single', 'bulk1', 'bulk2', 'manual', 'sendcloud', 'hold', 'service']) ids[key] = await order(key)
      ids.amazon = await order('amazon', { channel: 'AMAZON', fulfillmentMethod: 'FBM' })
      ids.returned = await order('returned', { status: 'DELIVERED' })
      ids.ret = (await database.client.return.create({ data: { id: 'test-return-1', orderId: ids.returned, channel: 'EBAY', rmaNumber: 'TEST-RMA-1' } as never })).id
    })
    app = Fastify()
    app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(business, done) })
    const { default: fulfillmentRoutes } = await import('./fulfillment.routes.js')
    const { default: returnsRoutes } = await import('./returns.routes.js')
    await app.register(fulfillmentRoutes, { prefix: '/api' })
    await app.register(returnsRoutes, { prefix: '/api' })
    await app.ready()
  }, 180_000)

  afterAll(async () => {
    await app?.close()
    await database?.close()
  })

  it('create one, bulk create, and their refusals', async () => {
    expect([
      await post('/fulfillment/shipments', {}),
      await post('/fulfillment/shipments', { orderId: 'test-order-none' }),
      await post('/fulfillment/shipments', { orderId: ids.single, carrierCode: 'MANUAL' }),
      await post('/fulfillment/shipments/bulk-create', {}),
      await post('/fulfillment/shipments/bulk-create', { orderIds: [ids.bulk1, ids.bulk2, ids.single, 'test-order-none'], warehouseId: ids.warehouse }),
      await shipmentOf(ids.bulk1),
    ]).toMatchSnapshot()
  })

  it('print label: MANUAL, Sendcloud, Amazon Buy Shipping, a wrong channel, unknown', async () => {
    const make = (orderId: string, carrierCode: string) =>
      inside(() => database.client.shipment.create({ data: { orderId, warehouseId: ids.warehouse, carrierCode, status: 'DRAFT', weightGrams: 1200 } as never }))
    const manual = await make(ids.manual, 'MANUAL')
    const sendcloud = await make(ids.sendcloud, 'SENDCLOUD')
    const amazon = await make(ids.amazon, 'AMAZON_BUY_SHIPPING')
    const wrong = await make(ids.hold, 'AMAZON_BUY_SHIPPING')
    carrier.parcels.length = 0
    ids.labelled = sendcloud.id
    ids.wrong = wrong.id
    expect([
      await post(`/fulfillment/shipments/${manual.id}/print-label`),
      await post(`/fulfillment/shipments/${sendcloud.id}/print-label`),
      await post(`/fulfillment/shipments/${amazon.id}/print-label`),
      await post(`/fulfillment/shipments/${wrong.id}/print-label`),
      await post('/fulfillment/shipments/test-shipment-none/print-label'),
      stable(carrier.parcels),
      await shipmentOf(ids.sendcloud),
      await shipmentOf(ids.amazon),
    ]).toMatchSnapshot()
  })

  it('hold, release, service, void label', async () => {
    const draft = await inside(() => database.client.shipment.create({ data: { orderId: ids.service, carrierCode: 'SENDCLOUD', status: 'DRAFT' } as never }))
    carrier.voided.length = 0
    expect([
      await post(`/fulfillment/shipments/${draft.id}/hold`, { reason: '  Check the address  ' }),
      await post(`/fulfillment/shipments/${draft.id}/hold`, {}),
      await post(`/fulfillment/shipments/${draft.id}/release`),
      await post(`/fulfillment/shipments/${draft.id}/release`),
      await post(`/fulfillment/shipments/${ids.labelled}/hold`, {}),
      await post(`/fulfillment/shipments/${draft.id}/service`, { carrierCode: 'SENDCLOUD', serviceCode: '2001', serviceName: 'Test Standard' }, 'PATCH'),
      await post(`/fulfillment/shipments/${ids.labelled}/service`, { serviceCode: '2002' }, 'PATCH'),
      await post(`/fulfillment/shipments/${draft.id}/void-label`),
      await post(`/fulfillment/shipments/${ids.labelled}/void-label`),
      carrier.voided,
      await shipmentOf(ids.sendcloud),
      await post('/fulfillment/shipments/test-shipment-none/hold', {}),
    ]).toMatchSnapshot()
  })

  it('return label: generated once; a second time refused; unknown', async () => {
    carrier.parcels.length = 0
    expect([
      await post(`/fulfillment/returns/${ids.ret}/generate-label`),
      await post(`/fulfillment/returns/${ids.ret}/generate-label`),
      await post('/fulfillment/returns/test-return-none/generate-label'),
      stable(carrier.parcels),
    ]).toMatchSnapshot()
  })
})
