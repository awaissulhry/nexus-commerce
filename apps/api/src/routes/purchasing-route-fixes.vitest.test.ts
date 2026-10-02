/**
 * S1 (MCP full control, section 08 §1.4 F3 and F10) — the purchasing routes that wrote outside their rules.
 *
 * 🔴 WHAT THIS GUARDS.
 *   - F3: `POST /fulfillment/purchase-orders/:id/submit` set SUBMITTED from ANY status (a cancelled PO too): no state
 *     machine, no approval threshold, no supplier e-mail, no actor, no event. Nothing in the app called it. Retired: 410.
 *   - F10: the bulk "draft POs from selection" published no `po.created` (the PO list stayed stale and the PO event log
 *     never recorded these POs); the per-product draft PO carried line cost 0 (no value, so no approval threshold); and
 *     a supplier create saved the request body as it came, so it could switch the auto-PO opt-in on.
 *
 * Real PostgreSQL in-process (PGlite), the real fulfilment routes through Fastify inject. Every id is invented.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { formulaDatabase } from '../test-support/formula-database.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({ default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }) }))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() }, redis: { connection: null },
  }
})
const events = vi.hoisted(() => ({ published: [] as Array<{ type: string; poId?: string; poNumber?: string }> }))
vi.mock('../services/po-events.service.js', () => ({
  publishPoEvent: (event: { type: string }) => { events.published.push(event) },
  subscribePoEvents: () => () => {},
  getPoListenerCount: () => 0,
  startPoEventIntake: async () => {},
  stopPoEventIntake: async () => {},
}))

import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

const BUSINESS = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const scoped = <T>(work: () => Promise<T>) => withWorkspace(BUSINESS, work)
let app: FastifyInstance
const db = () => database.client

beforeAll(async () => {
  database = await formulaDatabase()
  app = Fastify()
  app.addHook('onRequest', (_request, _reply, done) => { withWorkspace(BUSINESS, done) })
  await app.register((await import('./fulfillment.routes.js')).default, { prefix: '/api' })
  await app.ready()
}, 180_000)
afterAll(async () => { await app?.close(); await database?.close() }, 60_000)
beforeEach(() => { events.published.length = 0 })

const post = (url: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url, payload })

async function supplierWithCost(id: string, cost: { productId: string; costCents: number; currencyCode?: string }) {
  return scoped(async () => {
    await db().supplier.create({ data: { id, name: `Supplier ${id}`, defaultCurrency: 'EUR' } })
    await db().supplierProduct.create({ data: { supplierId: id, productId: cost.productId, costCents: cost.costCents, currencyCode: cost.currencyCode ?? 'EUR' } as never })
  })
}
const product = (id: string, costPrice: number | null = null) =>
  scoped(() => db().product.create({ data: { id, sku: `SKU-${id}`, name: id, basePrice: 20, costPrice } as never }))

describe('F3 — the legacy PO submit is retired', () => {
  it('🔴 answers 410 with where to go, and the PO keeps its status and version', async () => {
    const po = await scoped(() => db().purchaseOrder.create({ data: { poNumber: 'PO-TEST-F3', status: 'CANCELLED', totalCents: 0 } }))
    const res = await post(`/api/fulfillment/purchase-orders/${po.id}/submit`, {})
    expect(res.statusCode, res.body).toBe(410)
    expect(res.json()).toMatchObject({ code: 'ROUTE_RETIRED', replacement: '/api/fulfillment/purchase-orders/:id/transition' })
    expect(await scoped(() => db().purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, select: { status: true, version: true } })))
      .toEqual({ status: 'CANCELLED', version: po.version })
    expect(events.published).toEqual([])
  })
})

describe('F10 — draft POs', () => {
  it('🔴 the per-product draft carries the supplier\'s cost on the line and in the total, and publishes po.created', async () => {
    await product('f10-one')
    await supplierWithCost('f10-sup-one', { productId: 'f10-one', costCents: 1250 })
    const res = await post('/api/fulfillment/replenishment/f10-one/draft-po', { quantity: 4, supplierId: 'f10-sup-one' })
    expect(res.statusCode, res.body).toBe(200)
    const po = res.json()
    expect(po.items).toEqual([expect.objectContaining({ productId: 'f10-one', quantityOrdered: 4, unitCostCents: 1250 })])
    expect(po).toMatchObject({ totalCents: 5000, currencyCode: 'EUR', status: 'DRAFT' })
    expect(events.published).toEqual([expect.objectContaining({ type: 'po.created', poId: po.id, poNumber: po.poNumber })])
  })

  it('with no supplier price, the product\'s own cost price (master currency); with neither, 0 as before', async () => {
    await product('f10-own', 7.5)
    await product('f10-none')
    const own = (await post('/api/fulfillment/replenishment/f10-own/draft-po', { quantity: 2 })).json()
    expect(own).toMatchObject({ totalCents: 1500, items: [expect.objectContaining({ unitCostCents: 750 })] })
    const none = (await post('/api/fulfillment/replenishment/f10-none/draft-po', { quantity: 2 })).json()
    expect(none).toMatchObject({ totalCents: 0, items: [expect.objectContaining({ unitCostCents: 0 })] })
  })

  it('a supplier price in another currency than the PO is never mixed into it', async () => {
    await product('f10-cny', 3)
    await supplierWithCost('f10-sup-cny', { productId: 'f10-cny', costCents: 9900, currencyCode: 'CNY' })
    const po = (await post('/api/fulfillment/replenishment/f10-cny/draft-po', { quantity: 1, supplierId: 'f10-sup-cny' })).json()
    // The supplier invoices in EUR here (its default), so the CNY price is not this PO's; the master cost is.
    expect(po).toMatchObject({ currencyCode: 'EUR', totalCents: 300, items: [expect.objectContaining({ unitCostCents: 300 })] })
  })

  it('🔴 the bulk draft publishes po.created for every PO it makes, with line costs', async () => {
    await product('f10-bulk-a')
    await product('f10-bulk-b')
    await supplierWithCost('f10-sup-bulk', { productId: 'f10-bulk-a', costCents: 400 })
    await scoped(() => db().supplierProduct.create({ data: { supplierId: 'f10-sup-bulk', productId: 'f10-bulk-b', costCents: 600, currencyCode: 'EUR' } as never }))
    const res = await post('/api/fulfillment/replenishment/bulk-draft-po', { items: [
      { productId: 'f10-bulk-a', quantity: 3, supplierId: 'f10-sup-bulk' },
      { productId: 'f10-bulk-b', quantity: 1, supplierId: 'f10-sup-bulk' },
    ] })
    expect(res.statusCode, res.body).toBe(200)
    const created = res.json().createdPos as Array<{ id: string; poNumber: string }>
    expect(created).toHaveLength(1)
    expect(events.published).toEqual([expect.objectContaining({ type: 'po.created', poId: created[0].id, poNumber: created[0].poNumber })])
    const stored = await scoped(() => db().purchaseOrder.findUniqueOrThrow({ where: { id: created[0].id }, include: { items: true } }))
    expect(stored.totalCents).toBe(3 * 400 + 600)
    expect(stored.items.map((i) => [i.productId, i.unitCostCents]).sort()).toEqual([['f10-bulk-a', 400], ['f10-bulk-b', 600]])
  })
})

describe('F10 — a supplier create keeps to the edit\'s fields', () => {
  it('🔴 the auto-PO opt-in, its ceilings and the lead-time statistics in the body are not stored', async () => {
    const res = await post('/api/fulfillment/suppliers', {
      name: 'Opt-in attempt', email: 'buyer@example.test', leadTimeDays: 21,
      autoTriggerEnabled: true, autoTriggerMaxQtyPerPo: 100000, autoTriggerMaxCostCentsPerPo: 999999999, autoTriggerEventPrep: true,
      leadTimeSampleCount: 50, workspaceId: 'another-business',
    })
    expect(res.statusCode, res.body).toBe(200)
    const stored = await scoped(() => db().supplier.findUniqueOrThrow({ where: { id: res.json().id } }))
    expect(stored).toMatchObject({
      name: 'Opt-in attempt', email: 'buyer@example.test', leadTimeDays: 21,
      autoTriggerEnabled: false, autoTriggerMaxQtyPerPo: null, autoTriggerMaxCostCentsPerPo: null, autoTriggerEventPrep: false,
      leadTimeSampleCount: 0, workspaceId: LEGACY_WORKSPACE_ID,
    })
  })

  it('a name is still required', async () => {
    expect((await post('/api/fulfillment/suppliers', { email: 'x@example.test' })).statusCode).toBe(400)
  })
})
