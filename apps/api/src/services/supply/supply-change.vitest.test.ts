/**
 * MCP full control 08 S9 — suppliers and purchase orders Claude asks for, and the routes whose work they share.
 *
 *   Tools (MCP full control S9): upsert-supplier, draft-purchase-order, advance-purchase-order, cancel-purchase-order —
 *   a dry run writes nothing; the run (after a person approved) writes through the same services; the workflow actor
 *   is the person who approved; a version read before is honoured; the PO card shows the supplier's e-mail, total,
 *   currency and whether the e-mail is live; the undo puts a supplier or a draft back.
 *
 *   Routes: supplier create and edit (`POST`/`PATCH /api/fulfillment/suppliers`), a supplier's products (`POST`,
 *   `PATCH /api/fulfillment/suppliers/:id/products`) and PO create (`POST /api/fulfillment/purchase-orders`) keep their
 *   answers now that their helpers live in services/supply (supplier and purchase-order services). Checked against
 *   the routes before the move and after it.
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
const mail = vi.hoisted(() => ({ supplier: [] as string[], approver: [] as string[] }))
vi.mock('../po-supplier-email.service.js', () => ({
  sendPoToSupplier: vi.fn(async (poId: string) => {
    mail.supplier.push(poId)
    return { ok: true, token: 'TEST-SECRET-TOKEN', ackUrl: 'https://example.test/ack/TEST-SECRET-TOKEN', emailDelivery: { sent: false, dryRun: true } }
  }),
}))
vi.mock('../po-approver-email.service.js', () => ({
  notifyApprover: vi.fn(async (poId: string) => {
    mail.approver.push(poId)
    return { ok: true, token: 'TEST-SECRET-TOKEN', approveUrl: 'https://example.test/approve/TEST-SECRET-TOKEN', emailDelivery: { sent: false, dryRun: true } }
  }),
}))
const events = vi.hoisted(() => ({ po: [] as Array<{ type: string; poId?: string }> }))
vi.mock('../po-events.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../po-events.service.js')>()),
  publishPoEvent: vi.fn((event: { type: string; poId?: string }) => { events.po.push(event) }),
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

type Json = any
const ids = { jacket: '', gloves: '', supplier: '' }
let app: FastifyInstance

async function send(method: 'POST' | 'PATCH', url: string, payload?: unknown): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as never }) })
  return { status: response.statusCode, body: response.json() }
}

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const db = database.client
    ids.jacket = (await db.product.create({ data: { sku: 'TEST-SKU-S9-JACKET', name: 'Test jacket', basePrice: '100.00', costPrice: '40.00' } })).id
    ids.gloves = (await db.product.create({ data: { sku: 'TEST-SKU-S9-GLOVES', name: 'Test gloves', basePrice: '20.00' } })).id
  })
  app = Fastify()
  app.addHook('preHandler', (request, _reply, done) => { (request as { authUser?: { id: string } }).authUser = { id: 'u-s9-person' }; withWorkspace(business, done) })
  await app.register((await import('../../routes/fulfillment.routes.js')).default, { prefix: '/api' })
  await app.ready()
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
})

describe('08 S9 — the supplier and PO routes answer as before', () => {
  it('suppliers: create and edit take only the allowed fields; a supplier product upsert sets cost, MOQ and the primary', async () => {
    const created = await send('POST', '/api/fulfillment/suppliers', { name: 'TEST Supplier S9', email: 'orders@s9.example.test', leadTimeDays: '21', productionTimeDays: '', autoTriggerEnabled: true, leadTimeSampleCount: 99 })
    expect(created.status).toBe(200)
    expect(created.body).toMatchObject({ name: 'TEST Supplier S9', email: 'orders@s9.example.test', leadTimeDays: 21, productionTimeDays: null, autoTriggerEnabled: false, leadTimeSampleCount: 0 })
    ids.supplier = created.body.id
    const edited = await send('PATCH', `/api/fulfillment/suppliers/${ids.supplier}`, { contactName: 'Test Contact', isActive: 0, autoTriggerMaxQtyPerPo: 5 })
    expect(edited.body).toMatchObject({ contactName: 'Test Contact', isActive: false, autoTriggerMaxQtyPerPo: null })
    await send('PATCH', `/api/fulfillment/suppliers/${ids.supplier}`, { isActive: true })

    const product = await send('POST', `/api/fulfillment/suppliers/${ids.supplier}/products`, { productId: ids.jacket, costEur: 12.5, moq: 5, currencyCode: 'eur', isPrimary: true, supplierSku: ' SUP-J ' })
    expect(product).toMatchObject({ status: 200, body: { ok: true, supplierProduct: { productId: ids.jacket, costCents: 1250, moq: 5, currencyCode: 'EUR', isPrimary: true, supplierSku: 'SUP-J' } } })
    expect((await inside(() => database.client.replenishmentRule.findFirst({ where: { productId: ids.jacket } })))?.preferredSupplierId).toBe(ids.supplier)
    expect(await send('POST', `/api/fulfillment/suppliers/${ids.supplier}/products`, { productId: ids.gloves, moq: 0 })).toEqual({ status: 400, body: { error: 'moq must be an integer >= 1' } })
    expect(await send('POST', `/api/fulfillment/suppliers/${ids.supplier}/products`, { sku: 'NOPE' })).toEqual({ status: 404, body: { error: 'product not found for sku NOPE' } })
    const patched = await send('PATCH', `/api/fulfillment/suppliers/${ids.supplier}/products/${ids.jacket}`, { costCents: 1300, casePack: '' })
    expect(patched.body.supplierProduct).toMatchObject({ costCents: 1300, casePack: null })
  })

  it('purchase orders: create makes a DRAFT with its lines and total and publishes po.created; no lines is a 400', async () => {
    events.po.length = 0
    const created = await send('POST', '/api/fulfillment/purchase-orders', {
      supplierId: ids.supplier, currencyCode: 'eur', notes: 'TEST S9 order',
      items: [{ productId: ids.jacket, sku: 'TEST-SKU-S9-JACKET', quantityOrdered: 10, unitCostCents: 1250 }, { sku: 'TEST-SKU-S9-GLOVES', quantityOrdered: 4 }],
    })
    expect(created.status).toBe(200)
    expect(created.body).toMatchObject({ status: 'DRAFT', currencyCode: 'EUR', totalCents: 12500, notes: 'TEST S9 order', supplierId: ids.supplier })
    expect(created.body.poNumber).toMatch(/^PO-\d{6}-[A-Z0-9]{4}$/)
    expect(created.body.items.map((i: Json) => [i.sku, i.quantityOrdered, i.unitCostCents, i.lineOrder])).toEqual([['TEST-SKU-S9-JACKET', 10, 1250, 0], ['TEST-SKU-S9-GLOVES', 4, 0, 1]])
    expect(events.po).toEqual([expect.objectContaining({ type: 'po.created', poId: created.body.id })])
    expect(await send('POST', '/api/fulfillment/purchase-orders', { items: [] })).toEqual({ status: 400, body: { error: 'items[] required' } })
  })
})

describe('08 S9 — the supplier and PO tools', () => {
  type Tool = import('../agents/tool-types.js').AgentTool
  const tools: Record<string, Tool> = {}
  const person = (userId: string, without: string[] = []) => ({ userId, can: (p: string) => !without.includes(p), via: 'claude' as const })
  const db = () => database.client
  const ids2 = { supplier: '', po: '', boots: '' }

  beforeAll(async () => {
    const { getTool } = await import('../agents/tool-registry.js')
    for (const name of ['upsert-supplier', 'draft-purchase-order', 'advance-purchase-order', 'cancel-purchase-order']) tools[name] = getTool(name)!
    await inside(async () => {
      ids2.boots = (await db().product.create({ data: { sku: 'TEST-SKU-S9-BOOTS', name: 'Test boots', basePrice: '80.00', costPrice: '30.00' } })).id
      await db().brandSettings.create({ data: { requireApprovalForPo: false, poApprovalThresholdCents: 50_000 } as never })
    })
  })

  it('upsert-supplier: a dry run writes nothing; the run creates it; its undo switches it off', async () => {
    const args = { name: 'TEST Supplier Tool', email: 'po@tool.example.test', leadTimeDays: 10, supplierProducts: [{ productId: ids.jacket, costCents: 1000, currencyCode: 'EUR', moq: 2, isPrimary: true }] }
    const dry = await inside(() => tools['upsert-supplier'].handler(args, person('u-ask')))
    expect(dry, dry.error).toMatchObject({ ok: true, preview: { action: 'create', supplier: { id: null, name: 'TEST Supplier Tool' }, products: [{ sku: 'TEST-SKU-S9-JACKET', change: 'add', costCents: 1000, isPrimary: true }], totals: { productsAdded: 1, maxCostChangePercent: null } } })
    expect(await inside(() => db().supplier.count({ where: { name: 'TEST Supplier Tool' } }))).toBe(0)
    const ran = await inside(() => tools['upsert-supplier'].execute!(args, person('u-approver')))
    expect(ran, ran.error).toMatchObject({ ok: true, data: { action: 'create' } })
    ids2.supplier = (ran.data as { supplierId: string }).supplierId
    expect(await inside(() => db().replenishmentRule.findFirst({ where: { productId: ids.jacket } }))).toMatchObject({ preferredSupplierId: ids2.supplier })
    expect(await inside(() => tools['upsert-supplier'].undo!.current(ran.change!))).toEqual(ran.change!.after)
    expect(tools['upsert-supplier'].undo!.request(ran.change!)).toEqual({ tool: 'upsert-supplier', args: { supplierId: ids2.supplier, isActive: false } })
  })

  it('upsert-supplier: a price move is shown in percent and held to the limit; the undo puts the old row and fields back', async () => {
    const args = { supplierId: ids2.supplier, leadTimeDays: 12, taxNumber: 'IT00000000000', supplierProducts: [{ productId: ids.jacket, costCents: 1300 }, { productId: ids.gloves, costCents: 500 }] }
    const dry = await inside(() => tools['upsert-supplier'].handler(args, person('u-ask')))
    expect(dry, dry.error).toMatchObject({ ok: true, preview: { action: 'update', changes: { leadTimeDays: { from: 10, to: 12 }, taxId: { from: null, to: 'IT00000000000' } }, totals: { productsAdded: 1, productsChanged: 1, maxCostChangePercent: 30 } } })
    const limits = tools['upsert-supplier'].limits!.parse({})
    expect(tools['upsert-supplier'].withinLimits!(dry.preview, limits)).toMatch(/30 %/)
    expect(tools['upsert-supplier'].withinLimits!(dry.preview, { maxCostChangePercent: 30 })).toBeNull()
    const ran = await inside(() => tools['upsert-supplier'].execute!(args, person('u-approver')))
    expect(ran.ok, ran.error).toBe(true)
    const undo = tools['upsert-supplier'].undo!.request(ran.change!) as { tool: string; args: Record<string, unknown> }
    expect(undo).toMatchObject({ tool: 'upsert-supplier', args: { supplierId: ids2.supplier, leadTimeDays: 10, taxNumber: null, removeProducts: [ids.gloves], supplierProducts: [{ productId: ids.jacket, costCents: 1000, moq: 2, isPrimary: true, currencyCode: 'EUR' }] } })
    expect(tools['upsert-supplier'].input.safeParse(undo.args).success).toBe(true)
    expect(await inside(() => tools['upsert-supplier'].undo!.current(ran.change!))).toEqual(ran.change!.after)
    const back = await inside(() => tools['upsert-supplier'].execute!(undo.args, person('u-approver')))
    expect(back.ok, back.error).toBe(true)
    const rows = await inside(() => db().supplierProduct.findMany({ where: { supplierId: ids2.supplier }, select: { productId: true, costCents: true } }))
    expect(rows).toEqual([{ productId: ids.jacket, costCents: 1000 }])
    expect(await inside(() => db().supplier.findUnique({ where: { id: ids2.supplier }, select: { leadTimeDays: true, taxId: true } }))).toEqual({ leadTimeDays: 10, taxId: null })
    // Nothing to change, a product it does not supply, a product that does not exist: refused, named.
    expect(await inside(() => tools['upsert-supplier'].handler({ supplierId: ids2.supplier, leadTimeDays: 10 }, person('u-ask')))).toEqual({ ok: false, error: 'Nothing to change on supplier "TEST Supplier Tool": name a field with a new value, or a product it supplies.' })
    expect(await inside(() => tools['upsert-supplier'].handler({ supplierId: ids2.supplier, removeProducts: [ids.gloves] }, person('u-ask')))).toEqual({ ok: false, error: "Not queued: TEST-SKU-S9-GLOVES is not one of this supplier's products" })
    expect(await inside(() => tools['upsert-supplier'].handler({ supplierId: ids2.supplier, removeProducts: ['nope'] }, person('u-ask')))).toEqual({ ok: false, error: 'Product not found' })
  })

  it('draft-purchase-order: lines priced from the supplier (else the cost price), the threshold shown; the run makes a DRAFT; its undo cancels it', async () => {
    const args = { supplierId: ids2.supplier, lines: [{ productId: ids.jacket, quantity: 10 }, { productId: ids2.boots, quantity: 20 }] }
    const dry = await inside(() => tools['draft-purchase-order'].handler(args, person('u-ask')))
    expect(dry, dry.error).toMatchObject({
      ok: true,
      preview: {
        action: 'create', purchaseOrder: { id: null, status: 'DRAFT', supplier: 'TEST Supplier Tool', currencyCode: 'EUR' },
        lines: [{ sku: 'TEST-SKU-S9-JACKET', quantity: 10, unitCostCents: 1000, lineTotalCents: 10_000 }, { sku: 'TEST-SKU-S9-BOOTS', quantity: 20, unitCostCents: 3000, lineTotalCents: 60_000 }],
        totals: { lines: 2, units: 30, totalCents: 70_000 },
        approval: { thresholdCents: 50_000, needsApprovalWhenSubmitted: true },
      },
    })
    // Above the PO threshold: never drafted without a person, whatever the business's own limit.
    expect(tools['draft-purchase-order'].withinLimits!(dry.preview, { maxTotalCents: 1_000_000, maxLines: 200 })).toMatch(/approval threshold/)
    expect(await inside(() => db().purchaseOrder.count({ where: { supplierId: ids2.supplier } }))).toBe(0)
    const ran = await inside(() => tools['draft-purchase-order'].execute!(args, person('u-approver')))
    expect(ran, ran.error).toMatchObject({ ok: true, data: { totalCents: 70_000 } })
    ids2.po = (ran.data as { purchaseOrderId: string }).purchaseOrderId
    expect(await inside(() => db().purchaseOrder.findUnique({ where: { id: ids2.po }, select: { status: true, version: true, totalCents: true } }))).toEqual({ status: 'DRAFT', version: 1, totalCents: 70_000 })
    expect(await inside(() => tools['draft-purchase-order'].undo!.current(ran.change!))).toEqual(ran.change!.after)
    expect(tools['draft-purchase-order'].undo!.request(ran.change!)).toEqual({ tool: 'cancel-purchase-order', args: { purchaseOrderId: ids2.po, reason: 'Undo of a draft asked for through Claude' } })
    // A product on two lines, an unknown supplier, nothing to order: refused.
    expect((await inside(() => tools['draft-purchase-order'].handler({ supplierId: ids2.supplier, lines: [{ productId: ids.jacket, quantity: 1 }, { productId: ids.jacket, quantity: 2 }] }, person('u-ask')))).error).toMatch(/two lines/)
    expect(await inside(() => tools['draft-purchase-order'].handler({ supplierId: 'nope', lines: [{ productId: ids.jacket, quantity: 1 }] }, person('u-ask')))).toEqual({ ok: false, error: 'Supplier not found' })
    expect(await inside(() => tools['draft-purchase-order'].handler({ supplierId: ids2.supplier, fromSuggestions: true }, person('u-ask')))).toEqual({ ok: false, error: 'No product of "TEST Supplier Tool" needs reordering now.' })
  })

  it('draft-purchase-order: a change of a DRAFT honours the version read; its undo puts the old lines back', async () => {
    const stale = await inside(() => tools['draft-purchase-order'].handler({ purchaseOrderId: ids2.po, version: 7, notes: 'TEST' }, person('u-ask')))
    expect(stale.error).toMatch(/changed since \(version 1, not 7\)/)
    const args = { purchaseOrderId: ids2.po, version: 1, lines: [{ productId: ids.jacket, quantity: 4, unitCostCents: 900 }], notes: 'TEST smaller' }
    const ran = await inside(() => tools['draft-purchase-order'].execute!(args, person('u-approver')))
    expect(ran, ran.error).toMatchObject({ ok: true, data: { purchaseOrderId: ids2.po, version: 2 } })
    const po = await inside(() => db().purchaseOrder.findUnique({ where: { id: ids2.po }, select: { totalCents: true, notes: true, items: { select: { sku: true, quantityOrdered: true, unitCostCents: true } } } }))
    expect(po).toEqual({ totalCents: 3600, notes: 'TEST smaller', items: [{ sku: 'TEST-SKU-S9-JACKET', quantityOrdered: 4, unitCostCents: 900 }] })
    const undo = tools['draft-purchase-order'].undo!.request(ran.change!) as { tool: string; args: Record<string, unknown> }
    expect(undo).toEqual({ tool: 'draft-purchase-order', args: { purchaseOrderId: ids2.po, version: 2, notes: null, lines: [{ productId: ids.jacket, quantity: 10, unitCostCents: 1000 }, { productId: ids2.boots, quantity: 20, unitCostCents: 3000 }] } })
    const back = await inside(() => tools['draft-purchase-order'].execute!(undo.args, person('u-approver')))
    expect(back.ok, back.error).toBe(true)
    expect(await inside(() => db().purchaseOrder.findUnique({ where: { id: ids2.po }, select: { totalCents: true, notes: true, version: true } }))).toEqual({ totalCents: 70_000, notes: null, version: 3 })
  })

  it('advance-purchase-order: the card shows supplier e-mail, total, currency and that e-mail is a dry run; the actor is the approver', async () => {
    const submit = await inside(() => tools['advance-purchase-order'].handler({ purchaseOrderId: ids2.po, transition: 'submit-for-review' }, person('u-ask')))
    // 700.00 is above the 500.00 threshold: it stops at REVIEW.
    expect(submit, submit.error).toMatchObject({ ok: true, preview: { action: 'submit-for-review', purchaseOrder: { status: 'DRAFT', version: 3, nextStatus: 'REVIEW' }, supplier: { name: 'TEST Supplier Tool', email: 'po@tool.example.test' }, totalCents: 70_000, currencyCode: 'EUR' } })
    expect((await inside(() => tools['advance-purchase-order'].execute!({ purchaseOrderId: ids2.po, transition: 'submit-for-review' }, person('u-approver')))).ok).toBe(true)
    // Approving and sending need po.approve — asked for, and again when it runs.
    expect((await inside(() => tools['advance-purchase-order'].handler({ purchaseOrderId: ids2.po, transition: 'approve' }, person('u-ask', ['po.approve'])))).error).toMatch(/permission to approve/)
    expect((await inside(() => tools['advance-purchase-order'].execute!({ purchaseOrderId: ids2.po, transition: 'approve' }, person('u-clerk', ['po.approve'])))).error).toMatch(/permission to approve/)
    // A version read before the PO moved is refused.
    expect((await inside(() => tools['advance-purchase-order'].handler({ purchaseOrderId: ids2.po, transition: 'approve', version: 3 }, person('u-ask')))).error).toMatch(/changed since \(version 4, not 3\)/)
    const approved = await inside(() => tools['advance-purchase-order'].execute!({ purchaseOrderId: ids2.po, transition: 'approve', version: 4 }, person('u-approver')))
    expect(approved, approved.error).toMatchObject({ ok: true, data: { from: 'REVIEW', to: 'APPROVED' } })
    const send = await inside(() => tools['advance-purchase-order'].handler({ purchaseOrderId: ids2.po, transition: 'send' }, person('u-ask')))
    expect(send, send.error).toMatchObject({ ok: true, preview: { purchaseOrder: { nextStatus: 'SUBMITTED' }, email: { to: 'po@tool.example.test', live: false, what: expect.stringContaining('dry run') } } })
    mail.supplier.length = 0
    events.po.length = 0
    const sent = await inside(() => tools['advance-purchase-order'].execute!({ purchaseOrderId: ids2.po, transition: 'send' }, person('u-sender')))
    expect(sent, sent.error).toMatchObject({ ok: true, data: { from: 'APPROVED', to: 'SUBMITTED', email: { sent: false, dryRun: true } } })
    expect(JSON.stringify(sent)).not.toContain('TEST-SECRET-TOKEN')
    expect(mail.supplier).toEqual([ids2.po])
    expect(events.po).toEqual([expect.objectContaining({ type: 'po.transitioned', poId: ids2.po, fromStatus: 'APPROVED', toStatus: 'SUBMITTED' })])
    expect(await inside(() => db().purchaseOrder.findUnique({ where: { id: ids2.po }, select: { reviewedByUserId: true, approvedByUserId: true, submittedByUserId: true } })))
      .toEqual({ reviewedByUserId: 'u-approver', approvedByUserId: 'u-approver', submittedByUserId: 'u-sender' })
  })

  it('cancel-purchase-order: a sent PO is refused; an unsent one is cancelled with its reason', async () => {
    expect((await inside(() => tools['cancel-purchase-order'].handler({ purchaseOrderId: ids2.po, reason: 'TEST' }, person('u-ask')))).error).toMatch(/is SUBMITTED: only a PO that has not been sent/)
    const draft = await inside(() => tools['draft-purchase-order'].execute!({ supplierId: ids2.supplier, lines: [{ productId: ids.jacket, quantity: 1 }] }, person('u-approver')))
    const id = (draft.data as { purchaseOrderId: string }).purchaseOrderId
    const dry = await inside(() => tools['cancel-purchase-order'].handler({ purchaseOrderId: id, reason: 'TEST not needed' }, person('u-ask')))
    expect(dry, dry.error).toMatchObject({ ok: true, preview: { action: 'cancel', purchaseOrder: { id, status: 'DRAFT' }, totalCents: 1000, reason: 'TEST not needed' } })
    const ran = await inside(() => tools['cancel-purchase-order'].execute!({ purchaseOrderId: id, reason: 'TEST not needed' }, person('u-approver')))
    expect(ran, ran.error).toMatchObject({ ok: true, data: { from: 'DRAFT', to: 'CANCELLED' } })
    expect(await inside(() => db().purchaseOrder.findUnique({ where: { id }, select: { status: true, cancelledReason: true } }))).toEqual({ status: 'CANCELLED', cancelledReason: 'TEST not needed' })
  })
})
