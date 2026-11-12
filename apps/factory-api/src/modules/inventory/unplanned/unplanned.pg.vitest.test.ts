import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seed as seedWarehouseDepth } from '../../../../../../packages/factory-db/seed/warehouse-depth'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * Goods without a purchase order and the reception report (B-W2b-300; SCM-122, SCM-119) on the local stack with the app's real
 * routes: a throwaway PostgreSQL 17 database from the migrations (the runtime logins: row-level security, the floor's grants and
 * the …_warehouse_depth_w2b_guards triggers are real), the factory-db seeds up to the warehouse in depth (its holding place
 * A1-HOLD, its goods without a PO SEED-GR-W36-01, SEED-WO-0001 planning the grey lining) and the system roles. Purchase orders to
 * the seeded supplier P2 are made up here. Every name, number and quantity is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/inventory/unplanned`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = 'unplanned-a'
const idOf = (key: string) => seedUuid(ns, key)
const A = {
  tenant: idOf('tenant'),
  owner: idOf('actor'),
  member: idOf('user:member'),
  companyA: idOf('company:A'),
  siteA1: idOf('site:A1'),
  supplier: idOf('party:P2'),
  customer: idOf('party:P1'),
  lining: idOf('product:item:lining'),
  liningGRY: idOf('product:item-colour:lining:GRY'),
  protector: idOf('product:item:protector'),
  holding: idOf('warehouse:location:A1-HOLD'),
  transit: idOf('warehouse:location:A1-TRANSIT-B1'),
  deviceA1: idOf('device:A1:cutting'),
  operatorA1: idOf('worker:A1:operator'),
}

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const RECEIVER: Permission[] = ['floor.work', 'inventory.receive', 'inventory.locations.view']
const SESSIONS: Record<string, SessionContext> = {
  floor: { audience: 'floor', tenantId: A.tenant, actorId: A.operatorA1, siteId: A.siteA1, deviceId: A.deviceA1, grants: [grant(RECEIVER, [A.companyA], [A.siteA1])] },
  picker: { audience: 'floor', tenantId: A.tenant, actorId: A.operatorA1, siteId: A.siteA1, deviceId: A.deviceA1, grants: [grant(['floor.work', 'inventory.issue'], [A.companyA], [A.siteA1])] },
  /** The buyer (a real person of the seed: the member). */
  buyer: { audience: 'office', tenantId: A.tenant, actorId: A.member, grants: [grant(['inventory.stock.view', 'inventory.unplanned.decide', 'inventory.reserve', 'threads.read', 'threads.post', 'tasks.manage', 'home.view'])] },
  /** The warehouse reads but may not decide. */
  reader: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(['inventory.stock.view'])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let counter = 0
const freshKey = () => `up-${run}-${++counter}`
const call = (session: string, method: Method, url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key ?? (method === 'POST' ? freshKey() : undefined))
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const keysOf = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : [])
const moneyKeys = (value: unknown) => keysOf(value).filter((key) => /value|cost|price|amount/i.test(key))

let orders = 0
/** A CONFIRMED purchase order of company A for site A1 to P2, made by the owner (the buyer the task goes to). */
async function makeOrder(lines: readonly { itemId: string; colourId: string | null; quantity: string; uom: string }[]): Promise<{ id: string; number: string; lines: string[] }> {
  const id = newId()
  const number = `T-PO-${run}-${++orders}`
  await admin(`INSERT INTO "PurchaseOrder" (id, "tenantId", "companyId", "siteId", number, "partyId", "orderDate", "createdById") VALUES ($1, $2, $3, $4, $5, $6, current_date, $7)`, [id, A.tenant, A.companyA, A.siteA1, number, A.supplier, A.owner])
  const lineIds: string[] = []
  for (const [index, line] of lines.entries()) {
    const lineId = newId()
    lineIds.push(lineId)
    await admin(
      `INSERT INTO "PurchaseOrderLine" (id, "tenantId", "purchaseOrderId", "partyId", "siteId", seq, "itemId", "itemColourId", quantity, uom, "baseQuantity", "unitPrice", "netAmount", "needDate")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::"Uom", $9, '2.100000', 0, current_date + 20)`,
      [lineId, A.tenant, id, A.supplier, A.siteA1, (index + 1) * 10, line.itemId, line.colourId, line.quantity, line.uom],
    )
  }
  await admin(`UPDATE "PurchaseOrder" SET status = 'SENT', "sentAt" = now(), "sentById" = $2, version = 2 WHERE id = $1`, [id, A.owner])
  await admin(`UPDATE "PurchaseOrder" SET status = 'CONFIRMED', "confirmedAt" = now(), "confirmedVia" = 'OFFICE', version = 3 WHERE id = $1`, [id])
  return { id, number, lines: lineIds }
}
const receiptOf = async (id: string) => (await admin<{ status: string; kind: string; purchaseOrderId: string | null; holdingLocationId: string | null; buyerTaskId: string | null; version: number; note: string | null }>('SELECT status::text AS status, kind::text AS kind, "purchaseOrderId", "holdingLocationId", "buyerTaskId", version, note FROM "GoodsReceipt" WHERE id = $1', [id]))[0]!
const movesOf = async (receiptId: string) => admin<{ reason: string; toLocationId: string; baseQuantity: string }>('SELECT m.reason::text AS reason, m."toLocationId", m."baseQuantity"::text AS "baseQuantity" FROM "StockMove" m JOIN "GoodsReceiptLine" l ON l.id = m."receiptLineId" WHERE l."receiptId" = $1', [receiptId])
const taskOf = async (id: string) => (await admin<{ status: string; assigneeId: string | null; recordType: string; recordId: string; title: string }>('SELECT status::text AS status, "assigneeId", "recordType", "recordId", title FROM "Task" WHERE id = $1', [id]))[0]
const lining = (quantity: string) => ({ supplierId: A.supplier, holdingLocationId: A.holding, supplierDdtNumber: `DDT-T-${run}`, supplierDdtDate: '2026-11-10', lines: [{ itemId: A.lining, itemColourId: A.liningGRY, quantity }] })

beforeAll(async () => {
  db = await migratedDatabase('unplanned')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 10 } })
  await seedCore({ db: database, namespace: ns })
  await seedWarehouseDepth({ db: database, namespace: ns })
  await seedRoles({ db: database, namespace: ns })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('the floor takes goods without a PO in: a holding place, no stock, a buyer asked', () => {
  let receiptId: string

  it('suggests the holding place the last goods waited in and lists our suppliers, without money', async () => {
    const start = await ok('floor', 'GET', '/inventory/receiving/unplanned/start')
    expect(start.holding).toMatchObject({ id: A.holding, code: 'A1-HOLD' })
    expect((start.suppliers as Json[]).map((row) => row.id)).toContain(A.supplier)
    expect((start.suppliers as Json[]).map((row) => row.id)).not.toContain(A.customer)
    const items = await ok('floor', 'GET', '/inventory/receiving/unplanned/items?q=lin')
    expect((items.items as Json[]).find((row) => row.id === A.lining)).toMatchObject({ tracking: 'LOT', colours: expect.arrayContaining([expect.objectContaining({ id: A.liningGRY })]) })
    expect(moneyKeys(start)).toEqual([])
    expect(moneyKeys(items)).toEqual([])
  })

  it('takes them in: ONE receipt OPEN in the holding place, its lines, no move; the buyer\'s task on it, assigned', async () => {
    const key = freshKey()
    const answer = await ok('floor', 'POST', '/inventory/receiving/unplanned', lining('15'), 201, key)
    receiptId = answer.receipt.id
    expect(answer.receipt).toMatchObject({ state: 'WAITING', supplier: { id: A.supplier }, holding: { id: A.holding, code: 'A1-HOLD' }, buyerAsked: true, lines: [{ seq: 10, quantity: '15.0000', uom: 'M', colour: { code: 'GRY' } }] })
    expect(moneyKeys(answer)).toEqual([])
    const row = await receiptOf(receiptId)
    expect(row).toMatchObject({ status: 'OPEN', kind: 'UNPLANNED', purchaseOrderId: null, holdingLocationId: A.holding })
    expect(await movesOf(receiptId)).toEqual([])
    expect(await taskOf(row.buyerTaskId!)).toMatchObject({ status: 'OPEN', assigneeId: A.owner, recordType: 'GoodsReceipt', recordId: receiptId })
    // A resend of the same request is answered, never taken in twice.
    const again = await ok('floor', 'POST', '/inventory/receiving/unplanned', lining('15'), 201, key)
    expect(again.receipt.id).toBe(receiptId)
    const events = await admin<{ type: string }>(`SELECT type FROM "OutboxEvent" WHERE subject = ANY($1::text[]) ORDER BY "occurredAt", id`, [[receiptId, row.buyerTaskId]])
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['inventory.unplanned_changed', 'task.created', 'task.assigned']))
  })

  it('takes the holding place by its scanned label; refuses a transit place, a party that is no supplier and a tablet that does not receive', async () => {
    const scanned = await ok('floor', 'POST', '/inventory/receiving/unplanned', { ...lining('2'), holdingLocationId: undefined, placeCode: 'bin-a1-hold' }, 201)
    expect(scanned.receipt.holding.code).toBe('A1-HOLD')
    const transit = await call('floor', 'POST', '/inventory/receiving/unplanned', { ...lining('2'), holdingLocationId: A.transit }, freshKey())
    expect(transit.statusCode, transit.body).toBe(400)
    expect(transit.json().error.message).toMatch(/no place for goods without a PO/)
    const customer = await call('floor', 'POST', '/inventory/receiving/unplanned', { ...lining('2'), supplierId: A.customer }, freshKey())
    expect(customer.statusCode, customer.body).toBe(400)
    expect((await call('picker', 'POST', '/inventory/receiving/unplanned', lining('2'), freshKey())).statusCode).toBe(403)
    const colourless = await call('floor', 'POST', '/inventory/receiving/unplanned', { ...lining('2'), lines: [{ itemId: A.lining, quantity: '2' }] }, freshKey())
    expect(colourless.statusCode).toBe(400)
    expect(colourless.json().error.issues).toEqual([expect.objectContaining({ path: 'body/lines/0/itemColourId' })])
  })

  it('the database refuses to post goods without a PO before an order names them', async () => {
    await expect(admin(`UPDATE "GoodsReceipt" SET status = 'POSTED', "postedAt" = now() WHERE id = $1`, [receiptId])).rejects.toThrow(/posted once a purchase order names them/)
  })

  it('the office reads them with the supplier\'s open orders that fit, and the buyer names one: posted into the holding place, the task done', async () => {
    const order = await makeOrder([{ itemId: A.lining, colourId: A.liningGRY, quantity: '40', uom: 'M' }])
    const detail = await ok('buyer', 'GET', `/inventory/unplanned/${receiptId}`)
    expect(detail.receipt).toMatchObject({ state: 'WAITING', holding: { code: 'A1-HOLD' }, supplierDdtNumber: `DDT-T-${run}` })
    expect(detail.buyerTask).toMatchObject({ status: 'OPEN', assignee: { id: A.owner } })
    const mine = (detail.orders as Json[]).find((row) => row.id === order.id)!
    expect(mine.fits).toEqual([{ receiptLineId: detail.lines[0].id, purchaseOrderLineIds: [order.lines[0]] }])
    expect(detail.can).toEqual({ decide: true, askBuyer: false })
    expect((await call('reader', 'POST', `/inventory/unplanned/${receiptId}/order`, { version: detail.receipt.version, purchaseOrderId: order.id, lines: [] }, freshKey())).statusCode).toBe(403)

    // Stale: the version read before is refused once it moved.
    const stale = await call('buyer', 'POST', `/inventory/unplanned/${receiptId}/order`, { version: detail.receipt.version - 1, purchaseOrderId: order.id, lines: [{ receiptLineId: detail.lines[0].id, purchaseOrderLineId: order.lines[0] }] }, freshKey())
    expect(stale.statusCode).toBe(409)
    const named = await ok('buyer', 'POST', `/inventory/unplanned/${receiptId}/order`, { version: detail.receipt.version, purchaseOrderId: order.id, lines: [{ receiptLineId: detail.lines[0].id, purchaseOrderLineId: order.lines[0], supplierLotRef: 'SUP-LOT-9' }] })
    expect(named).toMatchObject({ receiptId, purchaseOrder: { id: order.id, status: 'PARTLY_RECEIVED' } })
    expect(await receiptOf(receiptId)).toMatchObject({ status: 'POSTED', kind: 'UNPLANNED', purchaseOrderId: order.id })
    expect(await movesOf(receiptId)).toEqual([{ reason: 'RECEIPT', toLocationId: A.holding, baseQuantity: '15.0000' }])
    expect(await taskOf((await receiptOf(receiptId)).buyerTaskId!)).toMatchObject({ status: 'DONE' })
    expect((await admin<{ status: string }>('SELECT status::text AS status FROM "PurchaseOrder" WHERE id = $1', [order.id]))[0]!.status).toBe('PARTLY_RECEIVED')
    // Named once: a second naming is refused in words.
    const twice = await call('buyer', 'POST', `/inventory/unplanned/${receiptId}/order`, { version: named.moves, purchaseOrderId: order.id, lines: [{ receiptLineId: detail.lines[0].id, purchaseOrderLineId: order.lines[0] }] }, freshKey())
    expect(twice.statusCode).toBe(409)
  })

  it('refuses an order of another material or colour, and sends goods back with the reason', async () => {
    const goods = await ok('floor', 'POST', '/inventory/receiving/unplanned', lining('3'), 201)
    const order = await makeOrder([{ itemId: A.protector, colourId: null, quantity: '10', uom: 'PCS' }])
    const detail = await ok('buyer', 'GET', `/inventory/unplanned/${goods.receipt.id}`)
    const wrong = await call('buyer', 'POST', `/inventory/unplanned/${goods.receipt.id}/order`, { version: detail.receipt.version, purchaseOrderId: order.id, lines: [{ receiptLineId: detail.lines[0].id, purchaseOrderLineId: order.lines[0] }] }, freshKey())
    expect(wrong.statusCode).toBe(400)
    expect(wrong.json().error.issues).toEqual([expect.objectContaining({ path: 'body/lines/0/purchaseOrderLineId', message: expect.stringMatching(/another material or colour/) })])
    expect((await call('buyer', 'POST', `/inventory/unplanned/${goods.receipt.id}/return`, { version: detail.receipt.version, reason: ' ' }, freshKey())).statusCode).toBe(400)
    const back = await ok('buyer', 'POST', `/inventory/unplanned/${goods.receipt.id}/return`, { version: detail.receipt.version, reason: 'Not ours: another customer\'s delivery' })
    expect(back.status).toBe('CANCELLED')
    const row = await receiptOf(goods.receipt.id)
    expect(row.status).toBe('CANCELLED')
    expect(row.note).toMatch(/Sent back to the supplier \(goods without a PO\): Not ours/)
    expect(await taskOf(row.buyerTaskId!)).toMatchObject({ status: 'DONE' })
    expect(await movesOf(goods.receipt.id)).toEqual([])
  })
})

describe('the reception report: which work orders the goods serve, reserved in one step, sent to the buyer', () => {
  it('holds an open receipt, then reports the posted one against the work order that needs the lining', async () => {
    const waiting = await ok('floor', 'POST', '/inventory/receiving/unplanned', lining('5'), 201)
    const held = await ok('buyer', 'GET', `/inventory/receipts/${waiting.receipt.id}/reception-report`)
    expect(held).toMatchObject({ held: 'NOT_POSTED', lines: [], can: { reserve: false, send: false } })

    const order = await makeOrder([{ itemId: A.lining, colourId: A.liningGRY, quantity: '20', uom: 'M' }])
    const detail = await ok('buyer', 'GET', `/inventory/unplanned/${waiting.receipt.id}`)
    await ok('buyer', 'POST', `/inventory/unplanned/${waiting.receipt.id}/order`, { version: detail.receipt.version, purchaseOrderId: order.id, lines: [{ receiptLineId: detail.lines[0].id, purchaseOrderLineId: order.lines[0] }] })

    const report = await ok('buyer', 'GET', `/inventory/receipts/${waiting.receipt.id}/reception-report`)
    expect(report).toMatchObject({ held: null, buyer: { id: A.owner }, receipt: { purchaseOrder: { id: order.id } } })
    const line = report.lines[0]
    expect(line).toMatchObject({ received: '5.0000', item: { id: A.lining }, colour: { code: 'GRY' } })
    expect(line.lots).toEqual([expect.objectContaining({ free: '5.0000', held: false })])
    // The seed's open work orders plan the grey lining (SEED-WO-0001 among them): the one due first takes the 5 m.
    expect((line.serves as Json[]).some((entry) => entry.kind === 'WORK_ORDER' && entry.why === 'NEEDS')).toBe(true)
    const serve = (line.serves as Json[]).find((entry) => Number(entry.proposed) > 0)
    expect(serve).toMatchObject({ kind: 'WORK_ORDER', why: 'NEEDS', held: null })
    expect(report.can).toEqual({ reserve: true, send: true })
    expect(moneyKeys(report)).toEqual([])

    // Reserve for it and tell the buyer, in ONE step.
    const done = await ok('buyer', 'POST', `/inventory/receipts/${waiting.receipt.id}/reception-report/reserve`, { demands: [{ receiptLineId: line.receiptLineId, key: serve!.key }], tellBuyer: true, note: 'Cut it first' })
    expect(done.reservationIds).toHaveLength(1)
    expect(done.sent).toMatchObject({ buyerTold: true })
    const reservation = (await admin<{ status: string; workOrderId: string; lotId: string; quantity: string }>('SELECT status::text AS status, "workOrderId", "lotId", quantity::text AS quantity FROM "Reservation" WHERE id = $1', [done.reservationIds[0]]))[0]!
    expect(reservation).toMatchObject({ status: 'ACTIVE', workOrderId: serve!.workOrder.id, lotId: line.lots[0].id, quantity: Number(serve!.proposed).toFixed(4) })
    const note = (await admin<{ bodyText: string; mentionedUserIds: string[] }>('SELECT m."bodyText", m."mentionedUserIds" FROM "Message" m WHERE m.id = $1', [done.sent.messageId]))[0]!
    expect(note.mentionedUserIds).toEqual([A.owner])
    expect(note.bodyText).toContain(order.number)
    expect(note.bodyText).toContain(serve!.workOrder.number)
    expect(note.bodyText).toContain('Cut it first')

    // Read again: what was reserved is no longer proposed.
    const after = await ok('buyer', 'GET', `/inventory/receipts/${waiting.receipt.id}/reception-report`)
    const again = (after.lines[0].serves as Json[]).find((entry) => entry.key === serve!.key)
    expect(again?.reservedHere ?? '0.0000').toBe(Number(serve!.proposed).toFixed(4))
    // Nothing left to reserve for it from this receipt (and no note asked): refused in words.
    const nothing = await call('buyer', 'POST', `/inventory/receipts/${waiting.receipt.id}/reception-report/reserve`, { demands: [{ receiptLineId: line.receiptLineId, key: serve!.key }] }, freshKey())
    expect(nothing.statusCode, nothing.body).toBe(409)
    // The report alone goes to the buyer again.
    expect((await ok('buyer', 'POST', `/inventory/receipts/${waiting.receipt.id}/reception-report/send`, {})).sent).toMatchObject({ buyerTold: true })
    expect((await call('reader', 'POST', `/inventory/receipts/${waiting.receipt.id}/reception-report/reserve`, { demands: [{ receiptLineId: line.receiptLineId, key: serve!.key }] }, freshKey())).statusCode).toBe(403)
  })
})
