/**
 * MCP full control 08 S4 — the supply reads, for the purchasing pages and for Claude.
 *
 *   Routes: they keep their answers now that their reads live in `services/supply/` (supplier.service.ts,
 *   purchase-order.service.ts, inbound-shipment.service.ts). Written against the routes BEFORE the move and unchanged
 *   after it: suppliers (`GET /api/fulfillment/suppliers`, `/:id`), purchase orders (`GET
 *   /api/fulfillment/purchase-orders`, `/:id`, `/:id/match`) and inbound shipments (`GET /api/fulfillment/inbound`,
 *   `/:id`). (Also checked once by hand on 2026-10-01: the full answers of 24 requests, ids and times normalised,
 *   were byte-identical before and after the move.)
 *   Tools: Claude's four supply reads, through the one door (call-tool.ts): what they show, and that costs, landed
 *   costs and PO totals are absent for a person without the money permission. The PO's acknowledgement link token is
 *   never in an answer.
 *
 * Real SQL (PGlite with the production schema); the real route plugin in a Fastify app.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../../lib/queue.js', () => {
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
vi.mock('../advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined,
  putCached: () => undefined,
  flushAdsCache: async () => undefined,
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

type Json = any
const ids = { supplier: '', idle: '', jacket: '', gloves: '', po: '', draft: '', shipment: '', poLine: '' }
let app: FastifyInstance

async function get(url: string): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method: 'GET', url })
  return { status: response.statusCode, body: response.json() }
}

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const db = database.client
    ids.jacket = (await db.product.create({ data: { sku: 'TEST-SKU-S4-JACKET', name: 'Test jacket', basePrice: '19.90', costPrice: '12.00' } })).id
    ids.gloves = (await db.product.create({ data: { sku: 'TEST-SKU-S4-GLOVES', name: 'Test gloves', basePrice: '9.90' } })).id
    ids.supplier = (await db.supplier.create({
      data: {
        name: 'TEST Supplier', email: 'orders@supplier.example.test', country: 'IT', paymentTerms: 'NET30', defaultCurrency: 'EUR', leadTimeDays: 30,
        contacts: { create: [{ name: 'Test Contact', email: 'contact@supplier.example.test', isPrimary: true }] },
        products: { create: [{ productId: ids.jacket, supplierSku: 'SUP-JACKET', costCents: 1200, currencyCode: 'EUR', moq: 10, isPrimary: true, lastLandedCostCents: 1450 }] },
      },
    })).id
    ids.idle = (await db.supplier.create({ data: { name: 'TEST Idle supplier', isActive: false, leadTimeDays: 14 } })).id
    const po = await db.purchaseOrder.create({
      data: {
        poNumber: 'TEST-PO-1', supplierId: ids.supplier, status: 'SUBMITTED', totalCents: 14500, currencyCode: 'EUR', notes: 'TEST order',
        expectedDeliveryDate: new Date('2026-01-15T00:00:00Z'), supplierAckToken: 'TEST-SECRET-ACK', approverAckToken: 'TEST-SECRET-APPROVER',
        items: { create: [
          { productId: ids.jacket, sku: 'TEST-SKU-S4-JACKET', supplierSku: 'SUP-JACKET', quantityOrdered: 10, unitCostCents: 1200, lineOrder: 0 },
          { productId: ids.gloves, sku: 'TEST-SKU-S4-GLOVES', quantityOrdered: 5, unitCostCents: 500, lineOrder: 1 },
        ] },
      },
      include: { items: true },
    })
    ids.po = po.id
    ids.poLine = po.items.find((i) => i.sku === 'TEST-SKU-S4-JACKET')!.id
    ids.draft = (await db.purchaseOrder.create({ data: { poNumber: 'TEST-PO-2', supplierId: ids.supplier, status: 'DRAFT', totalCents: 0, currencyCode: 'EUR' } })).id
    ids.shipment = (await db.inboundShipment.create({
      data: {
        type: 'SUPPLIER', status: 'PARTIALLY_RECEIVED', reference: 'TEST-INBOUND-1', purchaseOrderId: ids.po, currencyCode: 'EUR', exchangeRate: '1',
        shippingCostCents: 1200, customsCostCents: 300, expectedAt: new Date('2026-01-20T00:00:00Z'),
        items: { create: [{ productId: ids.jacket, sku: 'TEST-SKU-S4-JACKET', quantityExpected: 10, quantityReceived: 6, unitCostCents: 1250, purchaseOrderItemId: ids.poLine }] },
      },
    })).id
  })
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(business, done) })
  const { default: fulfillmentRoutes } = await import('../../routes/fulfillment.routes.js')
  await app.register(fulfillmentRoutes, { prefix: '/api' })
  await app.ready()
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
})

describe('08 S4 — the supply read routes answer as before', () => {
  it('GET /api/fulfillment/suppliers and /:id: the list with counts; one supplier with products, POs and contacts; 404', async () => {
    const list = await get('/api/fulfillment/suppliers')
    expect(list.status).toBe(200)
    expect(list.body.total).toBe(2)
    expect(list.body.items.map((s: Json) => [s.name, s.isActive, s._count])).toEqual([
      ['TEST Idle supplier', false, { products: 0, purchaseOrders: 0 }],
      ['TEST Supplier', true, { products: 1, purchaseOrders: 2 }],
    ])
    expect((await get('/api/fulfillment/suppliers?activeOnly=true&search=test')).body.items.map((s: Json) => s.name)).toEqual(['TEST Supplier'])
    const one = await get(`/api/fulfillment/suppliers/${ids.supplier}`)
    expect(one.status).toBe(200)
    expect(one.body).toMatchObject({ name: 'TEST Supplier', paymentTerms: 'NET30', leadTimeDays: 30 })
    expect(one.body.products).toEqual([expect.objectContaining({ productId: ids.jacket, costCents: 1200, moq: 10, lastLandedCostCents: 1450 })])
    expect(one.body.purchaseOrders.map((p: Json) => p.poNumber).sort()).toEqual(['TEST-PO-1', 'TEST-PO-2'])
    expect(one.body.contacts).toEqual([expect.objectContaining({ name: 'Test Contact', isPrimary: true })])
    expect(await get('/api/fulfillment/suppliers/nope')).toEqual({ status: 404, body: { error: 'Supplier not found' } })
  })

  it('GET /api/fulfillment/purchase-orders: live POs with supplier and lines, filtered by status, supplier and lateness', async () => {
    const list = await get('/api/fulfillment/purchase-orders')
    expect(list.status).toBe(200)
    expect(list.body.total).toBe(2)
    expect(list.body.items.map((p: Json) => [p.poNumber, p.status, p.totalCents, p.supplier.name, p.items.length]).sort()).toEqual([
      ['TEST-PO-1', 'SUBMITTED', 14500, 'TEST Supplier', 2], ['TEST-PO-2', 'DRAFT', 0, 'TEST Supplier', 0],
    ])
    expect((await get('/api/fulfillment/purchase-orders?status=SUBMITTED,PARTIAL')).body.items.map((p: Json) => p.poNumber)).toEqual(['TEST-PO-1'])
    expect((await get('/api/fulfillment/purchase-orders?lateOnly=true')).body.items.map((p: Json) => p.poNumber)).toEqual(['TEST-PO-1'])
    expect((await get(`/api/fulfillment/purchase-orders?supplierId=${ids.idle}`)).body).toEqual({ items: [], total: 0 })
    expect((await get('/api/fulfillment/purchase-orders?deleted=true')).body).toEqual({ items: [], total: 0 })
  })

  it('GET /api/fulfillment/purchase-orders/:id and /:id/match: the PO with lines, shipments and fiscal; the three-way match; 404', async () => {
    const one = await get(`/api/fulfillment/purchase-orders/${ids.po}`)
    expect(one.status).toBe(200)
    expect(one.body).toMatchObject({ poNumber: 'TEST-PO-1', fiscal: null, supplier: { name: 'TEST Supplier' }, attachments: [], revisions: [], comments: [] })
    expect(one.body.items.map((i: Json) => [i.sku, i.quantityOrdered, i.unitCostCents])).toEqual([['TEST-SKU-S4-JACKET', 10, 1200], ['TEST-SKU-S4-GLOVES', 5, 500]])
    expect(one.body.inboundShipments.map((s: Json) => s.reference)).toEqual(['TEST-INBOUND-1'])
    expect(await get('/api/fulfillment/purchase-orders/nope')).toEqual({ status: 404, body: { error: 'PO not found' } })
    const match = await get(`/api/fulfillment/purchase-orders/${ids.po}/match`)
    expect(match.status).toBe(200)
    expect(match.body).toMatchObject({
      poNumber: 'TEST-PO-1', currencyCode: 'EUR', linkedShipmentCount: 1,
      totals: { orderedQty: 15, receivedQty: 6, shortfallUnits: 9, orderedCents: 14500, receivedCents: 7500, varianceCents: -7000, withinTolerance: false },
      landed: { goodsEurCents: 7500, overheadShippingEurCents: 1200, overheadCustomsEurCents: 300, overheadTotalEurCents: 1500, totalEurCents: 9000 },
    })
    expect(match.body.lines.map((l: Json) => [l.sku, l.orderedQty, l.receivedQty, l.openQty, l.status, l.landedUnitCentsEur])).toEqual([
      ['TEST-SKU-S4-JACKET', 10, 6, 4, 'partial', 1500], ['TEST-SKU-S4-GLOVES', 5, 0, 5, 'pending', null],
    ])
    expect((await get('/api/fulfillment/purchase-orders/nope/match')).status).toBe(404)
  })

  it('GET /api/fulfillment/inbound and /:id: shipments with items, paged and filtered; one with its landed cost; 404', async () => {
    const list = await get('/api/fulfillment/inbound')
    expect(list.status).toBe(200)
    expect(list.body).toMatchObject({ total: 1, page: 1, pageSize: 50, totalPages: 1 })
    expect(list.body.items[0]).toMatchObject({ reference: 'TEST-INBOUND-1', status: 'PARTIALLY_RECEIVED', purchaseOrder: { poNumber: 'TEST-PO-1' }, _count: { attachments: 0, discrepancies: 0 } })
    expect((await get('/api/fulfillment/inbound?search=TEST-SKU-S4')).body.total).toBe(1)
    expect((await get('/api/fulfillment/inbound?status=CLOSED')).body.total).toBe(0)
    expect((await get('/api/fulfillment/inbound?delayed=true')).body.total).toBe(1)
    const one = await get(`/api/fulfillment/inbound/${ids.shipment}`)
    expect(one.status).toBe(200)
    expect(one.body.landedCost).toEqual({ currencyCode: 'EUR', exchangeRate: '1', goodsCents: 12500, shippingCents: 1200, customsCents: 300, dutiesCents: 0, insuranceCents: 0, totalCents: 14000 })
    expect(one.body.items).toEqual([expect.objectContaining({ sku: 'TEST-SKU-S4-JACKET', quantityExpected: 10, quantityReceived: 6, discrepancies: [], receipts: [] })])
    expect(await get('/api/fulfillment/inbound/nope')).toEqual({ status: 404, body: { error: 'Inbound shipment not found' } })
  })
})

// ── A PO's acknowledgement links are secrets ──────────────────────────────────────────────────────────

describe('08 — no PO answer carries the acknowledgement link tokens', () => {
  /**
   * `supplierAckToken` / `approverAckToken` are the secrets in the links e-mailed to the supplier and the approver:
   * whoever holds one can acknowledge or approve the PO without signing in. They were in every PO answer, so anyone
   * with po.view could read them. The web never uses them.
   */
  const secretFree = (body: unknown) => {
    const text = JSON.stringify(body)
    expect(text).not.toContain('TEST-SECRET-')
    expect(text).not.toMatch(/supplierAckToken|approverAckToken/)
  }

  it('the PO list, one PO, a supplier\'s POs and a shipment\'s PO', async () => {
    for (const url of ['/api/fulfillment/purchase-orders', `/api/fulfillment/purchase-orders/${ids.po}`, `/api/fulfillment/suppliers/${ids.supplier}`, `/api/fulfillment/inbound/${ids.shipment}`]) {
      const { status, body } = await get(url)
      expect(status, url).toBe(200)
      secretFree(body)
    }
  })

  it('a PO edit answers with the PO, without them; the tokens stay stored for the links', async () => {
    const before = await inside(() => database.client.purchaseOrder.findUniqueOrThrow({ where: { id: ids.draft } }))
    const response = await app.inject({ method: 'PATCH', url: `/api/fulfillment/purchase-orders/${ids.draft}`, payload: { version: before.version, notes: 'TEST edited' } })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({ id: ids.draft, notes: 'TEST edited' })
    secretFree(response.json())
    const stored = await inside(() => database.client.purchaseOrder.findUniqueOrThrow({ where: { id: ids.po } }))
    expect([stored.supplierAckToken, stored.approverAckToken]).toEqual(['TEST-SECRET-ACK', 'TEST-SECRET-APPROVER'])
  })
})

// ── Claude's supply reads ──────────────────────────────────────────────────────────────────────────────

describe("08 S4 — Claude's supply reads", () => {
  const person = (permissions: string[]) => ({
    kind: 'user' as const, userId: 'u-s4', label: 'S4 test', via: 'claude' as const, workspace: business,
    permissions: { isOwner: false, permissions: new Set<string>(permissions) },
  })
  /** Every action and every money field. */
  const cleared = person([...Object.values(FEATURES), ...Object.values(FIELDS)])
  /** Every action, no money field. */
  const operator = person(Object.values(FEATURES))
  const call = async (name: string, args: Record<string, unknown> = {}, who = cleared): Promise<Json> => {
    const { callTool } = await import('../agents/call-tool.js')
    return (await inside(() => callTool(who, name, args))).visible
  }
  const SECRET = 'TEST-SECRET-ACK'

  beforeAll(async () => {
    // A second, older shipment, so the list has two pages of one.
    await inside(() => database.client.inboundShipment.create({
      data: { type: 'TRANSFER', status: 'CLOSED', reference: 'TEST-INBOUND-0', currencyCode: 'EUR', createdAt: new Date('2025-12-01T00:00:00Z') },
    }))
    // Stored replenishment suggestions: the jacket must be reordered now, the gloves need nothing.
    const suggestion = (productId: string, sku: string, urgency: string, needsReorder: boolean, daysOfStockLeft: number) => ({
      productId, sku, velocity: '1.5', velocitySource: 'test', leadTimeDays: 30, leadTimeSource: 'test', safetyDays: 7, totalAvailable: 4,
      inboundWithinLeadTime: 4, effectiveStock: 8, reorderPoint: 55, reorderQuantity: 60, daysOfStockLeft, urgency, needsReorder, unitCostCents: 1200,
    })
    await inside(() => database.client.replenishmentRecommendation.create({ data: suggestion(ids.jacket, 'TEST-SKU-S4-JACKET', 'CRITICAL', true, 5) }))
    await inside(() => database.client.replenishmentRecommendation.create({ data: suggestion(ids.gloves, 'TEST-SKU-S4-GLOVES', 'LOW', false, 90) }))
  })

  it('supplier-search: the list; one supplier with its products and costs, contacts and POs; money only for a person who may see it', async () => {
    const list = await call('supplier-search', { activeOnly: true })
    expect(list.data).toMatchObject({ total: 1, suppliers: [{ name: 'TEST Supplier', products: 1, purchaseOrders: 2, leadTimeDays: 30 }] })
    const one = await call('supplier-search', { supplierId: ids.supplier })
    expect(one.data).toMatchObject({
      name: 'TEST Supplier', paymentTerms: 'NET30', contacts: [{ name: 'Test Contact', isPrimary: true }],
      products: [{ sku: 'TEST-SKU-S4-JACKET', supplierSku: 'SUP-JACKET', costCents: 1200, moq: 10, isPrimary: true, lastLandedCostCents: 1450 }],
    })
    expect(one.data.recentPurchaseOrders.map((p: Json) => [p.poNumber, p.totalCents]).sort()).toEqual([['TEST-PO-1', 14500], ['TEST-PO-2', 0]])
    const hidden = await call('supplier-search', { supplierId: ids.supplier }, operator)
    expect(hidden.data.products[0]).not.toHaveProperty('costCents')
    expect(hidden.data.products[0]).not.toHaveProperty('lastLandedCostCents')
    expect(hidden.data).not.toHaveProperty('paymentTerms')
    expect(hidden.data.recentPurchaseOrders[0]).not.toHaveProperty('totalCents')
    expect(await call('supplier-search', { supplierId: 'nope' })).toEqual({ ok: false, error: 'Supplier not found' })
  })

  it('purchase-orders: the list with lateness; one PO with its match and landed cost; totals and costs hidden without money; never the ack link', async () => {
    const list = await call('purchase-orders')
    expect(list.data.purchaseOrders.map((p: Json) => [p.poNumber, p.status, p.late, p.unitsOrdered, p.totalCents]).sort()).toEqual([
      ['TEST-PO-1', 'SUBMITTED', true, 15, 14500], ['TEST-PO-2', 'DRAFT', false, 0, 0],
    ])
    expect((await call('purchase-orders', { lateOnly: true })).data.purchaseOrders.map((p: Json) => p.poNumber)).toEqual(['TEST-PO-1'])
    const one = await call('purchase-orders', { purchaseOrderId: ids.po })
    expect(one.data).toMatchObject({
      poNumber: 'TEST-PO-1', status: 'SUBMITTED', supplier: { name: 'TEST Supplier' }, totalCents: 14500,
      totals: { orderedQty: 15, receivedQty: 6, shortfallUnits: 9, orderedCents: 14500, receivedCents: 7500, varianceCents: -7000 },
      landedCost: { totalEurCents: 9000 }, inboundShipments: [{ reference: 'TEST-INBOUND-1', status: 'PARTIALLY_RECEIVED' }],
    })
    expect(one.data.lines.map((l: Json) => [l.sku, l.ordered, l.received, l.open, l.match, l.unitCostCents, l.landedUnitCostCents])).toEqual([
      ['TEST-SKU-S4-JACKET', 10, 6, 4, 'partial', 1200, 1500], ['TEST-SKU-S4-GLOVES', 5, 0, 5, 'pending', 500, null],
    ])
    const hidden = await call('purchase-orders', { purchaseOrderId: ids.po }, operator)
    expect(hidden.data).not.toHaveProperty('totalCents')
    expect(hidden.data).not.toHaveProperty('landedCost')
    expect(hidden.data.totals).toEqual({ orderedQty: 15, receivedQty: 6, shortfallUnits: 9, withinTolerance: false })
    expect(Object.keys(hidden.data.lines[0]).sort()).toEqual(['match', 'open', 'ordered', 'productId', 'received', 'sku', 'supplierSku'])
    expect((await call('purchase-orders', {}, operator)).data.purchaseOrders[0]).not.toHaveProperty('totalCents')
    for (const out of [list, one, hidden]) expect(JSON.stringify(out)).not.toContain(SECRET)
    expect(await call('purchase-orders', { purchaseOrderId: 'nope' })).toEqual({ ok: false, error: 'Purchase order not found' })
  })

  it('inbound-shipments: newest first, paged; one shipment with lines and landed cost, hidden without money', async () => {
    const first = await call('inbound-shipments', { limit: 1 })
    expect(first.data).toMatchObject({ total: 2, items: [{ reference: 'TEST-INBOUND-1', unitsExpected: 10, unitsReceived: 6, delayed: true, purchaseOrder: 'TEST-PO-1' }] })
    const second = await call('inbound-shipments', { limit: 1, cursor: first.data.nextCursor })
    expect(second.data).toMatchObject({ items: [{ reference: 'TEST-INBOUND-0', delayed: false }], nextCursor: null })
    expect(await call('inbound-shipments', { limit: 2, cursor: first.data.nextCursor })).toMatchObject({ ok: false, error: expect.stringContaining('cursor') })
    expect((await call('inbound-shipments', { query: 'TEST-SKU-S4' })).data.items.map((s: Json) => s.reference)).toEqual(['TEST-INBOUND-1'])
    const one = await call('inbound-shipments', { shipmentId: ids.shipment })
    expect(one.data).toMatchObject({
      reference: 'TEST-INBOUND-1', lines: [{ sku: 'TEST-SKU-S4-JACKET', expected: 10, received: 6, open: 4, unitCostCents: 1250 }],
      landedCost: { currencyCode: 'EUR', exchangeRate: 1, goodsCents: 12500, totalCents: 14000 },
    })
    const hidden = await call('inbound-shipments', { shipmentId: ids.shipment }, operator)
    expect(hidden.data).not.toHaveProperty('landedCost')
    expect(hidden.data.lines[0]).not.toHaveProperty('unitCostCents')
  })

  it('product-costs: one product\'s cost, suppliers and PO lines; the list of what has no cost; refused without the cost permission', async () => {
    const one = await call('product-costs', { sku: 'TEST-SKU-S4-JACKET' })
    expect(one.data).toMatchObject({
      sku: 'TEST-SKU-S4-JACKET', costPrice: 12, costingMethod: 'WAC',
      suppliers: [{ supplier: 'TEST Supplier', costCents: 1200, lastLandedCostCents: 1450, isPrimary: true }],
      recentPurchaseLines: [{ poNumber: 'TEST-PO-1', ordered: 10, unitCostCents: 1200 }],
    })
    const missing = await call('product-costs', { missingOnly: true })
    expect(missing.data).toMatchObject({ missingCost: 1, total: 1, items: [{ sku: 'TEST-SKU-S4-GLOVES', costPrice: null }], nextCursor: null })
    const { callTool, ToolAccessError } = await import('../agents/call-tool.js')
    await expect(inside(() => callTool(operator, 'product-costs', { productId: ids.jacket }))).rejects.toBeInstanceOf(ToolAccessError)
  })

  it('replenishment-suggestions: what to reorder, most urgent first; one product with its suppliers ranked; costs only for a person who may see them', async () => {
    const list = await call('replenishment-suggestions')
    expect(list.data).toMatchObject({ total: 1, items: [{ sku: 'TEST-SKU-S4-JACKET', urgency: 'CRITICAL', reorderQuantity: 60, daysOfStockLeft: 5, unitsPerDay: 1.5, unitCostCents: 1200 }] })
    expect(list.data.stockoutsLast30Days).toMatchObject({ open: 0, lostUnits: 0, totalLostRevenueCents: 0 })
    expect((await call('replenishment-suggestions', { includeNotNeeded: true })).data.items.map((r: Json) => r.sku)).toEqual(['TEST-SKU-S4-JACKET', 'TEST-SKU-S4-GLOVES'])
    const one = await call('replenishment-suggestions', { productId: ids.jacket })
    expect(one.data).toMatchObject({
      suggestion: { urgency: 'CRITICAL', needsReorder: true },
      suppliers: [{ supplier: 'TEST Supplier', rank: 1, unitCostCentsEur: 1200, moq: 10, leadTimeDays: 30, preferred: false }],
      runsOut: expect.objectContaining({ basis: expect.any(String) }),
    })
    const hidden = await call('replenishment-suggestions', { productId: ids.jacket }, operator)
    expect(hidden.data.suppliers[0]).not.toHaveProperty('unitCostCentsEur')
    expect(hidden.data.suggestion).not.toHaveProperty('unitCostCents')
    expect((await call('replenishment-suggestions', {}, operator)).data.stockoutsLast30Days).not.toHaveProperty('totalLostRevenueCents')
  })
})
