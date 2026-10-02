/**
 * MCP full control 08 S10 — receiving, inbound shipments, product costs and replenishment actions Claude asks for, and
 * the routes whose work they share.
 *
 *   Tools (MCP full control S10): receive-stock (never more than is still expected; units that pass the quality check
 *   go into stock; holds released; discrepancies; FBA refused), update-inbound-shipment, set-product-costs (cost
 *   limits; landed cost copied from a received PO), replenishment-action — a dry run writes nothing; undo puts back.
 *
 *   Routes: an inbound shipment's costs (`PATCH /api/fulfillment/inbound/:id/costs`), a PO's receipt shipment
 *   (`POST /api/fulfillment/purchase-orders/:id/receive`) and the one-shot PO receive (`.../quick-receive`) keep their
 *   answers now that their work lives in services/supply/inbound-shipment.service.ts. Checked against the routes
 *   before the move and after it.
 *
 * Real SQL (PGlite with the production schema); the real route plugin in a Fastify app.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return {
    default: new Proxy({}, {
      get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property),
    }),
  }
})
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
const events = vi.hoisted(() => ({ po: [] as Array<{ type: string }>, inbound: [] as Array<{ type: string }> }))
vi.mock('../po-events.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../po-events.service.js')>()),
  publishPoEvent: vi.fn((event: { type: string }) => { events.po.push(event) }),
}))
vi.mock('../inbound-events.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../inbound-events.service.js')>()),
  publishInboundEvent: vi.fn((event: { type: string }) => { events.inbound.push(event) }),
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

type Json = any
const ids = { jacket: '', gloves: '', warehouse: '', location: '', supplier: '', po: '' }
let app: FastifyInstance

async function send(method: 'POST' | 'PATCH', url: string, payload?: unknown): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as never }) })
  return { status: response.statusCode, body: response.json() }
}
const level = (productId: string) => inside(async () => (await database.client.stockLevel.findFirst({ where: { productId, locationId: ids.location } }))?.quantity ?? 0)

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const db = database.client
    ids.jacket = (await db.product.create({ data: { sku: 'TEST-SKU-S10-JACKET', name: 'Test jacket', basePrice: '100.00', costPrice: '40.00' } })).id
    ids.gloves = (await db.product.create({ data: { sku: 'TEST-SKU-S10-GLOVES', name: 'Test gloves', basePrice: '20.00', costPrice: '8.00' } })).id
    ids.warehouse = (await db.warehouse.create({ data: { code: 'IT-MAIN', name: 'Test main warehouse', isDefault: true } })).id
    ids.location = (await db.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'IT-MAIN', name: 'Test main warehouse', warehouseId: ids.warehouse } })).id
    ids.supplier = (await db.supplier.create({ data: { name: 'TEST Supplier S10', email: 'po@s10.example.test' } })).id
    ids.po = (await db.purchaseOrder.create({
      data: {
        poNumber: 'TEST-PO-S10-1', supplierId: ids.supplier, warehouseId: ids.warehouse, status: 'SUBMITTED', totalCents: 5600, currencyCode: 'EUR',
        items: { create: [
          { productId: ids.jacket, sku: 'TEST-SKU-S10-JACKET', quantityOrdered: 10, unitCostCents: 400, lineOrder: 0 },
          { productId: ids.gloves, sku: 'TEST-SKU-S10-GLOVES', quantityOrdered: 4, unitCostCents: 400, lineOrder: 1 },
        ] },
      },
    })).id
  })
  app = Fastify()
  app.addHook('preHandler', (request, _reply, done) => { (request as { authUser?: { id: string } }).authUser = { id: 'u-s10-person' }; withWorkspace(business, done) })
  await app.register((await import('../../routes/fulfillment.routes.js')).default, { prefix: '/api' })
  await app.ready()
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
})

describe('08 S10 — the inbound and PO receive routes answer as before', () => {
  it("a PO's receipt shipment: a DRAFT supplier shipment with the open quantity and cost of each line", async () => {
    events.po.length = 0
    events.inbound.length = 0
    const created = await send('POST', `/api/fulfillment/purchase-orders/${ids.po}/receive`)
    expect(created.status).toBe(200)
    expect(created.body.items.map((i: Json) => [i.sku, i.quantityExpected, i.unitCostCents, i.quantityReceived])).toEqual([
      ['TEST-SKU-S10-JACKET', 10, 400, 0], ['TEST-SKU-S10-GLOVES', 4, 400, 0],
    ])
    const shipment = await inside(() => database.client.inboundShipment.findUnique({ where: { id: created.body.inboundShipmentId } }))
    expect(shipment).toMatchObject({ type: 'SUPPLIER', status: 'DRAFT', warehouseId: ids.warehouse, purchaseOrderId: ids.po, reference: 'Receipt for TEST-PO-S10-1', currencyCode: 'EUR' })
    expect(events.po.map((e) => e.type)).toEqual(['po.received'])
    expect(events.inbound.map((e) => e.type)).toEqual(['inbound.created'])
    expect((await send('POST', '/api/fulfillment/purchase-orders/nope/receive')).status).toBe(404)
  })

  it("an inbound shipment's costs: header costs and line unit costs are set; inbound.updated; unknown is a 404", async () => {
    const shipment = await inside(() => database.client.inboundShipment.findFirstOrThrow({ where: { purchaseOrderId: ids.po }, include: { items: true } }))
    events.inbound.length = 0
    const set = await send('PATCH', `/api/fulfillment/inbound/${shipment.id}/costs`, {
      currencyCode: 'EUR', shippingCostCents: 1400, dutiesCostCents: null, items: [{ id: shipment.items[0].id, unitCostCents: 420 }],
    })
    expect(set).toEqual({ status: 200, body: { ok: true } })
    const after = await inside(() => database.client.inboundShipment.findUniqueOrThrow({ where: { id: shipment.id }, include: { items: { orderBy: { sku: 'asc' } } } }))
    expect(after).toMatchObject({ shippingCostCents: 1400, dutiesCostCents: null, currencyCode: 'EUR' })
    expect(after.items.map((i) => [i.sku, i.unitCostCents])).toEqual([['TEST-SKU-S10-GLOVES', 400], ['TEST-SKU-S10-JACKET', 420]])
    expect(events.inbound).toEqual([expect.objectContaining({ type: 'inbound.updated', reason: 'costs' })])
    expect(await send('PATCH', '/api/fulfillment/inbound/nope/costs', { shippingCostCents: 1 })).toEqual({ status: 404, body: { error: 'Inbound shipment not found' } })
  })

  it('the one-shot PO receive: a shipment that arrived, the units in stock, the PO partly received; no lines is a 400', async () => {
    events.po.length = 0
    events.inbound.length = 0
    const received = await send('POST', `/api/fulfillment/purchase-orders/${ids.po}/quick-receive`, {
      items: [{ purchaseOrderItemId: (await inside(() => database.client.purchaseOrderItem.findFirstOrThrow({ where: { purchaseOrderId: ids.po, sku: 'TEST-SKU-S10-JACKET' } }))).id, quantityReceived: 6 }],
      reference: 'TEST delivery note', carrierCode: 'TEST-CARRIER',
    })
    expect(received.status).toBe(200)
    expect(received.body).toMatchObject({ ok: true })
    expect(await level(ids.jacket)).toBe(6)
    const shipment = await inside(() => database.client.inboundShipment.findUniqueOrThrow({ where: { id: received.body.inboundShipmentId }, include: { items: { orderBy: { sku: 'asc' } } } }))
    expect(shipment).toMatchObject({ type: 'SUPPLIER', status: 'PARTIALLY_RECEIVED', reference: 'TEST delivery note', carrierCode: 'TEST-CARRIER', purchaseOrderId: ids.po })
    expect(shipment.items.map((i) => [i.sku, i.quantityExpected, i.quantityReceived])).toEqual([['TEST-SKU-S10-GLOVES', 4, 0], ['TEST-SKU-S10-JACKET', 10, 6]])
    expect(await inside(() => database.client.purchaseOrder.findUniqueOrThrow({ where: { id: ids.po }, select: { status: true } }))).toEqual({ status: 'PARTIAL' })
    expect(events.po.map((e) => e.type)).toEqual(['po.received'])
    expect(events.inbound.map((e) => e.type)).toEqual(['inbound.created', 'inbound.received'])
    expect(await send('POST', `/api/fulfillment/purchase-orders/${ids.po}/quick-receive`, { items: [] })).toEqual({ status: 400, body: { error: 'items[] required' } })
  })
})

describe('08 S10 — the receiving, inbound, cost and replenishment tools', () => {
  type Tool = import('../agents/tool-types.js').AgentTool
  const tools: Record<string, Tool> = {}
  const person = (userId: string) => ({ userId, can: () => true, via: 'claude' as const })
  const db = () => database.client
  const ship = { partial: '', draft: '' }
  // Arguments are parsed as the door parses them (defaults, upper case) before the dry run or the run.
  const run = (name: string, raw: Record<string, unknown>, mode: 'handler' | 'execute' = 'handler') => {
    const args = tools[name].input.parse(raw) as Record<string, unknown>
    return inside(() => (mode === 'handler' ? tools[name].handler(args, person('u-ask')) : tools[name].execute!(args, person('u-approver'))))
  }

  beforeAll(async () => {
    const { getTool } = await import('../agents/tool-registry.js')
    for (const name of ['receive-stock', 'update-inbound-shipment', 'set-product-costs', 'replenishment-action']) tools[name] = getTool(name)!
    ship.partial = (await inside(() => db().inboundShipment.findFirstOrThrow({ where: { purchaseOrderId: ids.po, status: 'PARTIALLY_RECEIVED' } }))).id
    ship.draft = (await inside(() => db().inboundShipment.findFirstOrThrow({ where: { purchaseOrderId: ids.po, status: 'DRAFT' } }))).id
  })

  it('receive-stock: over-receiving is refused; a dry run writes nothing; units that pass go into stock, held ones do not; undo sets stock back', async () => {
    expect(await run('receive-stock', { shipmentId: ship.partial, lines: [{ productId: ids.jacket, quantity: 5 }] }))
      .toEqual({ ok: false, error: 'Not queued: TEST-SKU-S10-JACKET: 4 still expected, 5 is more (record an over-delivery with report-discrepancy)' })
    const args = { shipmentId: ship.partial, lines: [{ productId: ids.jacket, quantity: 3 }, { productId: ids.gloves, quantity: 4, qc: 'hold' }] }
    const dry = await run('receive-stock', args)
    expect(dry, dry.error).toMatchObject({
      ok: true,
      preview: {
        action: 'receive', shipment: { status: 'PARTIALLY_RECEIVED', purchaseOrder: 'TEST-PO-S10-1', location: 'IT-MAIN' },
        lines: [
          { sku: 'TEST-SKU-S10-JACKET', expected: 10, receivedBefore: 6, receiving: 3, receivedAfter: 9, qc: 'PASS', stockNow: 6, stockAfter: 9 },
          { sku: 'TEST-SKU-S10-GLOVES', expected: 4, receivedBefore: 0, receiving: 4, receivedAfter: 4, qc: 'HOLD', stockNow: 0, stockAfter: 0 },
        ],
        totals: { lines: 2, units: 7, unitsToStock: 3 },
      },
    })
    expect(await level(ids.jacket)).toBe(6)
    events.inbound.length = 0
    events.po.length = 0
    const ran = await run('receive-stock', args, 'execute')
    expect(ran, ran.error).toMatchObject({ ok: true, data: { lines: 2, unitsToStock: 3 } })
    expect(await level(ids.jacket)).toBe(9)
    expect(await level(ids.gloves)).toBe(0)
    const items = await inside(() => db().inboundShipmentItem.findMany({ where: { inboundShipmentId: ship.partial }, orderBy: { sku: 'asc' }, select: { sku: true, quantityReceived: true, qcStatus: true } }))
    expect(items).toEqual([{ sku: 'TEST-SKU-S10-GLOVES', quantityReceived: 4, qcStatus: 'HOLD' }, { sku: 'TEST-SKU-S10-JACKET', quantityReceived: 9, qcStatus: 'PASS' }])
    expect(events.inbound.map((e) => e.type)).toEqual(['inbound.received'])
    expect(events.po.map((e) => e.type)).toEqual(['po.received'])
    expect(await inside(() => tools['receive-stock'].undo!.current(ran.change!))).toEqual(ran.change!.after)
    expect(tools['receive-stock'].undo!.request(ran.change!)).toEqual({
      tool: 'set-stock', args: { items: [{ productId: ids.jacket, location: 'IT-MAIN', quantity: 6 }], reason: 'MANUAL_ADJUSTMENT', note: 'Undo of a receive (the shipment keeps its received count)' },
    })
  })

  it('receive-stock: a held line is released into stock; a discrepancy is recorded and moves nothing', async () => {
    const dry = await run('receive-stock', { action: 'release-hold', shipmentId: ship.partial, lines: [{ productId: ids.gloves }] })
    expect(dry, dry.error).toMatchObject({ ok: true, preview: { lines: [{ sku: 'TEST-SKU-S10-GLOVES', releasing: 4, heldAs: 'HOLD', stockNow: 0, stockAfter: 4 }] } })
    expect((await run('receive-stock', { action: 'release-hold', shipmentId: ship.partial, lines: [{ productId: ids.gloves }] }, 'execute')).ok).toBe(true)
    expect(await level(ids.gloves)).toBe(4)
    expect((await run('receive-stock', { action: 'release-hold', shipmentId: ship.partial, lines: [{ productId: ids.gloves }] })).error).toMatch(/not held \(quality check PASS\)/)
    events.inbound.length = 0
    const reported = await run('receive-stock', { action: 'report-discrepancy', shipmentId: ship.partial, reasonCode: 'damaged', description: 'TEST one box crushed', lines: [{ productId: ids.jacket, quantity: 1 }] }, 'execute')
    expect(reported, reported.error).toMatchObject({ ok: true, change: { before: { items: [] }, after: { items: [] } } })
    expect(await inside(() => db().inboundDiscrepancy.findFirst({ where: { inboundShipmentId: ship.partial }, select: { reasonCode: true, quantityImpact: true, description: true } })))
      .toEqual({ reasonCode: 'DAMAGED', quantityImpact: 1, description: 'TEST one box crushed' })
    expect(events.inbound.map((e) => e.type)).toEqual(['inbound.discrepancy'])
    expect(tools['receive-stock'].undo!.request(reported.change!)).toMatchObject({ refusal: expect.stringContaining('moved no stock') })
  })

  it('receive-stock: against a sent PO a receipt shipment is opened; the PO is then received; FBA is refused', async () => {
    const ran = await run('receive-stock', { purchaseOrderId: ids.po, lines: [{ productId: ids.jacket, quantity: 1 }], reference: 'TEST note 2' }, 'execute')
    expect(ran, ran.error).toMatchObject({ ok: true, data: { unitsToStock: 1 } })
    expect(await level(ids.jacket)).toBe(10)
    expect(await inside(() => db().inboundShipment.findUniqueOrThrow({ where: { id: (ran.data as { shipmentId: string }).shipmentId }, select: { reference: true, status: true } })))
      .toEqual({ reference: 'TEST note 2', status: 'RECEIVED' })
    expect(await inside(() => db().purchaseOrder.findUniqueOrThrow({ where: { id: ids.po }, select: { status: true } }))).toEqual({ status: 'RECEIVED' })
    const fba = await inside(() => db().inboundShipment.create({ data: { type: 'FBA', status: 'IN_TRANSIT', reference: 'TEST-FBA', items: { create: [{ productId: ids.jacket, sku: 'TEST-SKU-S10-JACKET', quantityExpected: 2 }] } } }))
    expect((await run('receive-stock', { shipmentId: fba.id, lines: [{ productId: ids.jacket, quantity: 1 }] })).error).toMatch(/goes to Amazon FBA: Amazon receives it/)
    const fbaWarehouse = await inside(async () => {
      const w = await db().warehouse.create({ data: { code: 'TEST-FBA-W', name: 'Test FBA warehouse' } })
      await db().stockLocation.create({ data: { type: 'AMAZON_FBA', code: 'TEST-FBA-LOC', name: 'Test FBA', warehouseId: w.id } })
      return db().inboundShipment.create({ data: { type: 'SUPPLIER', status: 'ARRIVED', reference: 'TEST-TO-FBA', warehouseId: w.id, items: { create: [{ productId: ids.jacket, sku: 'TEST-SKU-S10-JACKET', quantityExpected: 2 }] } } })
    })
    expect((await run('receive-stock', { shipmentId: fbaWarehouse.id, lines: [{ productId: ids.jacket, quantity: 1 }] })).error).toMatch(/Amazon FBA stock: Amazon owns that number/)
  })

  it('update-inbound-shipment: details and costs honour the version and undo; a status move; cancel announces it; a PO receipt is opened', async () => {
    const before = await inside(() => db().inboundShipment.findUniqueOrThrow({ where: { id: ship.draft }, select: { version: true } }))
    expect((await run('update-inbound-shipment', { shipmentId: ship.draft, version: before.version + 5, notes: 'x' })).error).toMatch(/changed since/)
    const details = await run('update-inbound-shipment', { shipmentId: ship.draft, trackingNumber: 'TEST-TRACK-1', expectedAt: '2026-11-02' }, 'execute')
    expect(details, details.error).toMatchObject({ ok: true, change: { before: { fields: { trackingNumber: null, expectedAt: null } }, after: { fields: { trackingNumber: 'TEST-TRACK-1', expectedAt: '2026-11-02' } } } })
    expect(await inside(() => tools['update-inbound-shipment'].undo!.current(details.change!))).toEqual(details.change!.after)
    const undo = tools['update-inbound-shipment'].undo!.request(details.change!) as { tool: string; args: Record<string, unknown> }
    expect(undo).toEqual({ tool: 'update-inbound-shipment', args: { action: 'details', shipmentId: ship.draft, trackingNumber: null, expectedAt: null } })
    expect((await run('update-inbound-shipment', undo.args, 'execute')).ok).toBe(true)
    expect(await inside(() => db().inboundShipment.findUniqueOrThrow({ where: { id: ship.draft }, select: { trackingNumber: true, expectedAt: true } }))).toEqual({ trackingNumber: null, expectedAt: null })

    const costs = await run('update-inbound-shipment', { action: 'costs', shipmentId: ship.draft, shippingCostCents: 2000, lineCosts: [{ productId: ids.jacket, unitCostCents: 450 }] }, 'execute')
    expect(costs, costs.error).toMatchObject({ ok: true, change: { before: { fields: { shippingCostCents: 1400 }, lineCosts: [{ productId: ids.jacket, unitCostCents: 420 }] } } })
    expect(tools['update-inbound-shipment'].undo!.request(costs.change!)).toEqual({ tool: 'update-inbound-shipment', args: { action: 'costs', shipmentId: ship.draft, shippingCostCents: 1400, lineCosts: [{ productId: ids.jacket, unitCostCents: 420 }] } })

    expect((await run('update-inbound-shipment', { action: 'status', shipmentId: ship.draft, status: 'arrived' })).error).toMatch(/is DRAFT: it cannot move to ARRIVED/)
    const moved = await run('update-inbound-shipment', { action: 'status', shipmentId: ship.draft, status: 'SUBMITTED' }, 'execute')
    expect(moved, moved.error).toMatchObject({ ok: true, data: { from: 'DRAFT', to: 'SUBMITTED' } })
    expect(tools['update-inbound-shipment'].undo!.request(moved.change!)).toMatchObject({ refusal: expect.stringContaining('not undone') })
    events.inbound.length = 0
    expect((await run('update-inbound-shipment', { action: 'status', shipmentId: ship.draft, status: 'CANCELLED' }, 'execute')).ok).toBe(true)
    expect(events.inbound.map((e) => e.type)).toEqual(['inbound.cancelled'])

    const po2 = await inside(() => db().purchaseOrder.create({ data: { poNumber: 'TEST-PO-S10-2', supplierId: ids.supplier, warehouseId: ids.warehouse, status: 'SUBMITTED', totalCents: 800, currencyCode: 'EUR', items: { create: [{ productId: ids.gloves, sku: 'TEST-SKU-S10-GLOVES', quantityOrdered: 2, unitCostCents: 400 }] } } }))
    expect((await run('update-inbound-shipment', { action: 'create', purchaseOrderId: ids.po })).error).toBe('TEST-PO-S10-1: nothing is still expected.')
    const opened = await run('update-inbound-shipment', { action: 'create', purchaseOrderId: po2.id, trackingNumber: 'TEST-TRACK-2' }, 'execute')
    expect(opened, opened.error).toMatchObject({ ok: true })
    const created = await inside(() => db().inboundShipment.findUniqueOrThrow({ where: { id: (opened.data as { shipmentId: string }).shipmentId }, include: { items: true } }))
    expect(created).toMatchObject({ status: 'DRAFT', trackingNumber: 'TEST-TRACK-2', purchaseOrderId: po2.id })
    expect(created.items.map((i) => [i.sku, i.quantityExpected])).toEqual([['TEST-SKU-S10-GLOVES', 2]])
    expect(tools['update-inbound-shipment'].undo!.request(opened.change!)).toEqual({ tool: 'update-inbound-shipment', args: { action: 'status', shipmentId: created.id, status: 'CANCELLED' } })
  })

  it('set-product-costs: a move is shown in percent and held to the limit; the undo puts the old cost back; a received PO\'s landed cost is copied', async () => {
    const dry = await run('set-product-costs', { costs: [{ productId: ids.jacket, costPrice: 44 }, { productId: ids.gloves, costPrice: 12 }] })
    expect(dry, dry.error).toMatchObject({ ok: true, preview: { costs: [{ sku: 'TEST-SKU-S10-JACKET', costPriceBefore: 40, costPrice: 44, changePercent: 10 }, { sku: 'TEST-SKU-S10-GLOVES', costPriceBefore: 8, costPrice: 12, changePercent: 50 }], totals: { products: 2 } } })
    const limits = tools['set-product-costs'].limits!.parse({})
    expect(tools['set-product-costs'].withinLimits!(dry.preview, limits)).toMatch(/TEST-SKU-S10-GLOVES's cost moves 50 %/)
    const one = await run('set-product-costs', { costs: [{ productId: ids.jacket, costPrice: 44 }] })
    expect(tools['set-product-costs'].withinLimits!(one.preview, limits)).toBeNull()
    const ran = await run('set-product-costs', { costs: [{ productId: ids.jacket, costPrice: 44 }] }, 'execute')
    expect(ran, ran.error).toMatchObject({ ok: true, data: { updated: 1 } })
    expect(Number((await inside(() => db().product.findUniqueOrThrow({ where: { id: ids.jacket }, select: { costPrice: true } }))).costPrice)).toBe(44)
    expect(await inside(() => tools['set-product-costs'].undo!.current(ran.change!))).toEqual(ran.change!.after)
    expect(tools['set-product-costs'].undo!.request(ran.change!)).toEqual({ tool: 'set-product-costs', args: { costs: [{ productId: ids.jacket, costPrice: 40 }] } })
    expect(await run('set-product-costs', { costs: [{ productId: ids.jacket, costPrice: 44 }] })).toEqual({ ok: false, error: 'Every product already has that cost. Nothing to change.' })

    const landed = await run('set-product-costs', { purchaseOrderId: ids.po })
    expect(landed, landed.error).toMatchObject({ ok: true, preview: { action: 'copy-landed-cost', purchaseOrder: { poNumber: 'TEST-PO-S10-1', supplier: 'TEST Supplier S10' }, landed: [{ sku: 'TEST-SKU-S10-JACKET', landedCostCentsBefore: null, landedCostCents: 400 }, { sku: 'TEST-SKU-S10-GLOVES', landedCostCentsBefore: null, landedCostCents: 400 }] } })
    expect((await run('set-product-costs', { purchaseOrderId: ids.po }, 'execute')).ok).toBe(true)
    expect(await inside(() => db().supplierProduct.findMany({ where: { supplierId: ids.supplier }, orderBy: { productId: 'asc' }, select: { productId: true, lastLandedCostCents: true } })))
      .toEqual([ids.jacket, ids.gloves].sort().map((productId) => ({ productId, lastLandedCostCents: 400 })))
  })

  it('replenishment-action: dismiss and restore, a preferred supplier, a substitution and cash on hand — each with its undo', async () => {
    await inside(() => db().replenishmentRecommendation.create({ data: { productId: ids.jacket, sku: 'TEST-SKU-S10-JACKET', velocity: '1', velocitySource: 'test', leadTimeDays: 10, leadTimeSource: 'test', safetyDays: 3, totalAvailable: 1, inboundWithinLeadTime: 0, effectiveStock: 1, reorderPoint: 5, reorderQuantity: 12, urgency: 'HIGH', needsReorder: true } }))
    const dismissed = await run('replenishment-action', { productIds: [ids.jacket], reason: 'TEST seasonal' }, 'execute')
    expect(dismissed, dismissed.error).toMatchObject({ ok: true, data: { dismissed: 1 } })
    expect(await inside(() => db().replenishmentRecommendation.findFirstOrThrow({ where: { productId: ids.jacket }, select: { status: true, dismissedReason: true, dismissedByUserId: true } }))).toEqual({ status: 'DISMISSED', dismissedReason: 'TEST seasonal', dismissedByUserId: 'u-approver' })
    expect(await inside(() => tools['replenishment-action'].undo!.current(dismissed.change!))).toEqual(dismissed.change!.after)
    const restore = tools['replenishment-action'].undo!.request(dismissed.change!) as { tool: string; args: Record<string, unknown> }
    expect(restore).toEqual({ tool: 'replenishment-action', args: { action: 'restore', productIds: [ids.jacket] } })
    expect((await run('replenishment-action', restore.args, 'execute')).ok).toBe(true)
    expect(await inside(() => db().replenishmentRecommendation.findFirstOrThrow({ where: { productId: ids.jacket }, select: { status: true } }))).toEqual({ status: 'ACTIVE' })
    expect((await run('replenishment-action', { productIds: [ids.gloves] })).error).toMatch(/TEST-SKU-S10-GLOVES has no open reorder suggestion/)

    const preferred = await run('replenishment-action', { action: 'preferred-supplier', preferred: [{ productId: ids.jacket, supplierId: ids.supplier }] }, 'execute')
    expect(preferred, preferred.error).toMatchObject({ ok: true })
    expect(await inside(() => db().replenishmentRule.findFirstOrThrow({ where: { productId: ids.jacket }, select: { preferredSupplierId: true } }))).toEqual({ preferredSupplierId: ids.supplier })
    const back = tools['replenishment-action'].undo!.request(preferred.change!) as { args: Record<string, unknown> }
    expect(back).toEqual({ tool: 'replenishment-action', args: { action: 'preferred-supplier', preferred: [{ productId: ids.jacket, supplierId: null }] } })
    expect((await run('replenishment-action', back.args, 'execute')).ok).toBe(true)
    expect(await inside(() => db().replenishmentRule.findFirstOrThrow({ where: { productId: ids.jacket }, select: { preferredSupplierId: true } }))).toEqual({ preferredSupplierId: null })

    const linked = await run('replenishment-action', { action: 'substitute', substitutions: [{ productId: ids.gloves, coveredBy: ids.jacket, fraction: 0.3 }] }, 'execute')
    expect(linked, linked.error).toMatchObject({ ok: true })
    expect(await inside(() => tools['replenishment-action'].undo!.current(linked.change!))).toEqual(linked.change!.after)
    const unlink = tools['replenishment-action'].undo!.request(linked.change!) as { args: Record<string, unknown> }
    expect((await run('replenishment-action', unlink.args, 'execute')).ok).toBe(true)
    expect(await inside(() => db().productSubstitution.count())).toBe(0)

    const cash = await run('replenishment-action', { action: 'cash-on-hand', cashOnHandCents: 500_000 })
    expect(tools['replenishment-action'].withinLimits!(cash.preview, tools['replenishment-action'].limits!.parse({}))).toBe('cash on hand is set by a person')
    const setCash = await run('replenishment-action', { action: 'cash-on-hand', cashOnHandCents: 500_000 }, 'execute')
    expect(setCash, setCash.error).toMatchObject({ ok: true, data: { cashOnHandCents: 500_000 } })
    expect(tools['replenishment-action'].undo!.request(setCash.change!)).toEqual({ tool: 'replenishment-action', args: { action: 'cash-on-hand', cashOnHandCents: null } })
  })
})
