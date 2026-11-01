import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase, type Prisma } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCalendar } from '../../../../../../packages/factory-db/seed/calendar'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedSchedule } from '../../../../../../packages/factory-db/seed/schedule'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * Work orders every shift (B-W2b-51; MES-009 priority and rush, MES-010 split, MES-014 traveller, MES-017 bulk actions)
 * through the app's real routes on a throwaway PostgreSQL 17 database from the migrations (the runtime and floor logins:
 * row-level security, the column grants and the work order guards are real): the factory-db seeds up to the W2a schedule
 * (plant A1, style SEED-JKT-02 in sizes 50/52/54, SEED-WO-0001 in progress, cut, sewn on line L1 in v1 published for 16-20
 * Nov) and numbering (WORK_ORDER WO-{N:5}, BATCH BA-{N:5}); on top a made-up certificate covering SEED-JKT-02 in sizes 50
 * and 52 only, plenty of released leather, lining and protectors at A1, sales orders typed per test, and a tablet at
 * station SEW-01. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/production/work-orders/every-shift`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const NS = 'w2b51-every-shift'
const idOf = (key: string) => seedUuid(NS, key)
const A = {
  tenant: idOf('tenant'),
  actor: idOf('actor'),
  company: idOf('company:A'),
  site: idOf('site:A1'),
  line: idOf('site:A1:line:L1'),
  brand: idOf('party:P1'),
  style: idOf('production:style:JKT-02'),
  blk: idOf('production:colourway:JKT-02:BLK'),
  leather: idOf('product:item:leather'),
  lining: idOf('product:item:lining'),
  protector: idOf('product:item:protector'),
  leatherBLK: idOf('product:item-colour:leather:BLK'),
  liningGRY: idOf('product:item-colour:lining:GRY'),
  bin: idOf('inventory:location:A1-STORE-01'),
}
const tablet = newId()

const ALL: Permission[] = ['workorders.view', 'workorders.manage', 'workorders.release']
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (permissions: Permission[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(permissions)] })
const SESSIONS: Record<string, SessionContext> = {
  planner: office(ALL),
  manager: office(['workorders.view', 'workorders.manage']),
  viewer: office(['workorders.view']),
  stranger: office(['planning.view']),
  sewing: { audience: 'floor', tenantId: A.tenant, actorId: newId(), siteId: A.site, deviceId: tablet, grants: [{ permissions: ['floor.work', ...ALL], companies: [A.company], sites: [A.site], parties: 'all' }] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
const call = (session: string, method: Method, url: string, payload?: unknown) => app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const asOffice = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) => client.$transaction(work))
const events = (type: string, subject: string) => admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2 ORDER BY "occurredAt", id`, [type, subject])
const wo = (number: string) => admin<{ id: string }>(`SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND number = $2`, [A.tenant, number]).then((rows) => rows[0]!.id)

/** A CONFIRMED sales order of company A for SEED-JKT-02 (black) to the brand P1: one line with these sizes. */
let orders = 0
async function salesOrder(sizes: Record<string, number>, promiseDate = '2026-12-10'): Promise<{ orderId: string; lineId: string }> {
  const orderId = newId()
  const lineId = newId()
  const pieces = Object.values(sizes).reduce((sum, quantity) => sum + quantity, 0)
  await asOffice(async (tx) => {
    await tx.salesOrder.create({
      data: { id: orderId, companyId: A.company, partyId: A.brand, number: `T-${run}-SO-${++orders}`, status: 'CONFIRMED', orderDate: new Date('2026-10-20T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up workshop' }, promiseDate: new Date(`${promiseDate}T00:00:00.000Z`) },
      select: { id: true },
    })
    await tx.salesOrderLine.create({
      data: { id: lineId, companyId: A.company, orderId, partyId: A.brand, seq: 10, kind: 'SIZE_GRID', styleId: A.style, colourwayId: A.blk, quantity: pieces, unitPrice: '100.000000', netAmount: pieces * 10_000, vatRatePct: '22.00', vatAmount: pieces * 2_200 },
      select: { id: true },
    })
    await tx.salesOrderLineSize.createMany({ data: Object.entries(sizes).map(([size, quantity]) => ({ id: newId(), lineId, partyId: A.brand, size, quantity })) })
  })
  return { orderId, lineId }
}

/** A DRAFT work order of every size of a new order line. */
async function draft(sizes: Record<string, number>, more: Json = {}): Promise<Json> {
  const order = await salesOrder(sizes)
  return (await ok('planner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: order.lineId }], siteId: A.site, ...more }, 201)).workOrder
}

async function stockLot(spec: { itemId: string; colourId: string | null; quantity: string; uom: string; leather?: boolean; code: string }) {
  const lotId = newId()
  const leather = spec.leather === true
  await admin(
    `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "qualityStatus", "qualityDecidedAt", "requiresCrViTest", "crViLimitMgKg", "crViStatus", "crViMgKg", "crViEvidence", "crViTestedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'RELEASED', now(), $8, $9, $10, $11, $12, $13)`,
    [lotId, A.tenant, A.company, A.site, spec.itemId, spec.colourId, spec.code, leather, leather ? '3.000' : null, leather ? 'PASS' : 'NOT_REQUIRED', leather ? '1.100' : null, leather ? 'LOT_REPORT' : null, leather ? '2026-10-01' : null],
  )
  const hideId = leather ? newId() : null
  if (hideId) await admin(`INSERT INTO "Hide" (id, "tenantId", "siteId", "lotId", "itemId", code, area, "areaUom", "baseArea") VALUES ($1, $2, $3, $4, $5, $6, $7, 'FT2', $7)`, [hideId, A.tenant, A.site, lotId, spec.itemId, `${spec.code}-H1`, spec.quantity])
  await admin(
    `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "hideId", "toLocationId", quantity, uom, "baseQuantity", "idempotencyKey", "occurredAt")
     VALUES ($1, $2, $3, $4, 'OPENING', $5, $6, $7, $8, $9, $10, $11, $10, $12, now())`,
    [newId(), A.tenant, A.company, A.site, spec.itemId, spec.colourId, lotId, hideId, A.bin, spec.quantity, spec.uom, `every-shift-test-${spec.code}`],
  )
}

beforeAll(async () => {
  db = await migratedDatabase('wo_every_shift')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  await seedCalendar({ db: database, namespace: NS })
  await seedSchedule({ db: database, namespace: NS })
  await seedNumbering({ db: database, namespace: NS })
  // A certificate covering SEED-JKT-02 in sizes 50 and 52 (every colourway); size 54 is not covered.
  await asOffice(async (tx) => {
    const certificateId = newId()
    await tx.certificate.create({
      data: { id: certificateId, holderPartyId: A.brand, standard: 'EN 17092-3:2020', ppeClass: 'AA', number: `TEST-CERT-${run}`, notifiedBodyName: 'Made-up Notified Body', notifiedBodyNumber: '9999', modelReference: 'SEED-JKT-02', validFrom: new Date('2026-01-01T00:00:00.000Z'), validTo: new Date('2030-12-31T00:00:00.000Z'), status: 'VALID', statusChangedAt: new Date() },
      select: { id: true },
    })
    await tx.certificateCoverage.create({ data: { id: newId(), certificateId, styleId: A.style, sizes: ['50', '52'] }, select: { id: true } })
  })
  await stockLot({ itemId: A.leather, colourId: A.leatherBLK, quantity: '6000.0000', uom: 'FT2', leather: true, code: `T-${run}-LEA` })
  await stockLot({ itemId: A.lining, colourId: A.liningGRY, quantity: '800.0000', uom: 'M', code: `T-${run}-LIN` })
  await stockLot({ itemId: A.protector, colourId: null, quantity: '2000.0000', uom: 'PCS', code: `T-${run}-PRO` })
  const [station] = await admin<{ id: string }>('SELECT id FROM "Station" WHERE "tenantId" = $1 AND "siteId" = $2 AND code = $3', [A.tenant, A.site, 'SEW-01'])
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, 'Sewing tablet', 'TABLET', 'ACTIVE', now())`, [tablet, A.tenant, A.company, A.site, station!.id])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  vi.useRealTimers()
  await app?.close()
  await database?.close()
  await db?.close()
}, 180_000)

describe('priority and the rush flag (MES-009)', () => {
  it('makes a rush work order, filters the list by the flag, and changes it with the priority, audited and announced to the floor', async () => {
    const made = await draft({ '50': 1 }, { rush: true, priority: 2 })
    expect(made).toMatchObject({ rush: true, priority: 2, splitFrom: null, splits: [] })
    const rush = await ok('viewer', 'GET', '/production/work-orders?rush=true&limit=200')
    expect(rush.workOrders.map((row: Json) => row.id)).toContain(made.id)
    expect(rush.workOrders.every((row: Json) => row.rush === true)).toBe(true)
    const normal = await ok('viewer', 'GET', '/production/work-orders?rush=false&limit=200')
    expect(normal.workOrders.map((row: Json) => row.id)).not.toContain(made.id)

    const { workOrder } = await ok('manager', 'PATCH', `/production/work-orders/${made.id}`, { version: made.version, rush: false, priority: 7 })
    expect(workOrder).toMatchObject({ rush: false, priority: 7, version: made.version + 1 })
    const [audit] = await admin(`SELECT before, after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'workorders.update'`, [made.id])
    expect(audit).toMatchObject({ before: { rush: true, priority: 2 }, after: { rush: false, priority: 7 } })
    expect((await events('workorder.priority_changed', made.id)).map((row) => row.payload)).toEqual([{ workOrderId: made.id, number: made.number, siteId: A.site, priority: 7, rush: false, previousPriority: 2, previousRush: true }])
    // A note alone tells the floor nothing.
    await ok('manager', 'PATCH', `/production/work-orders/${made.id}`, { version: workOrder.version, note: 'Pack in pairs' })
    expect(await events('workorder.priority_changed', made.id)).toHaveLength(1)
  })

  it('keeps the flag of a cancelled work order, and is the office’s with workorders.manage', async () => {
    const made = await draft({ '50': 1 })
    expect(made.rush).toBe(false)
    expect((await refused('viewer', 'PATCH', `/production/work-orders/${made.id}`, { rush: true }, 403)).code).toBe('forbidden')
    const { workOrder } = await ok('manager', 'POST', `/production/work-orders/${made.id}/cancel`, { reason: 'Made by mistake' })
    const error = await refused('manager', 'PATCH', `/production/work-orders/${made.id}`, { version: workOrder.version, rush: true }, 409)
    expect(error.message).toBe(`Work order ${made.number} is CANCELLED; only its note changes.`)
  })

  it('changes the rush flag of the selected rows through the list frame (Edit N), a cancelled one held', async () => {
    const first = await draft({ '50': 1 })
    const second = await draft({ '52': 1 })
    const cancelled = await draft({ '50': 1 })
    await ok('manager', 'POST', `/production/work-orders/${cancelled.id}/cancel`, { reason: 'Not needed' })
    const preview = await ok('manager', 'POST', '/views/bulk/preview', { listKey: 'production.work-orders', ids: [first.id, second.id, cancelled.id], changes: { rush: 'RUSH', priority: 4 } })
    expect(preview.rows.map((row: Json) => [row.label, row.changes, row.refusal])).toEqual([
      [first.number, [{ field: 'rush', now: 'NORMAL', next: 'RUSH' }, { field: 'priority', now: 0, next: 4 }], null],
      [second.number, [{ field: 'rush', now: 'NORMAL', next: 'RUSH' }, { field: 'priority', now: 0, next: 4 }], null],
      [cancelled.number, [{ field: 'rush', now: 'NORMAL', next: 'RUSH' }, { field: 'priority', now: 0, next: 4 }], { code: 'held', field: null, status: 'CANCELLED' }],
    ])
    const applied = await ok('manager', 'POST', '/views/bulk/apply', { listKey: 'production.work-orders', rows: preview.rows.slice(0, 2).map((row: Json) => ({ id: row.id, version: row.version, changes: { rush: 'RUSH', priority: 4 } })) })
    expect(applied.results.map((row: Json) => [row.ok, row.after])).toEqual([
      [true, { rush: 'RUSH', priority: 4 }],
      [true, { rush: 'RUSH', priority: 4 }],
    ])
    expect(await admin(`SELECT rush, priority FROM "WorkOrder" WHERE id IN ($1, $2)`, [first.id, second.id])).toEqual([
      { rush: true, priority: 4 },
      { rush: true, priority: 4 },
    ])
    // Not a choice of the field: a 400 in words.
    expect((await refused('manager', 'POST', '/views/bulk/preview', { listKey: 'production.work-orders', ids: [first.id], changes: { rush: 'yes' } }, 400)).message).toBe('Not one of the choices.')
  })

  it('shows the rush flag on the dispatch board and on the tablet’s My work (rush first)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-17T09:00:00.000Z') })
    try {
      const id = await wo('SEED-WO-0001')
      const before = await ok('sewing', 'GET', '/production/dispatch/station')
      expect(before.entries.map((entry: Json) => [entry.workOrder.number, entry.workOrder.rush])).toEqual([['SEED-WO-0001', false]])
      const [row] = await admin<{ version: number }>(`SELECT version FROM "WorkOrder" WHERE id = $1`, [id])
      await ok('manager', 'PATCH', `/production/work-orders/${id}`, { version: row!.version, rush: true })
      const tablet = await ok('sewing', 'GET', '/production/dispatch/station')
      expect(tablet.entries[0].workOrder).toMatchObject({ number: 'SEED-WO-0001', rush: true, priority: 0 })
      const board = await ok('viewer', 'GET', `/production/dispatch?lineId=${A.line}`)
      expect(board.entries[0].workOrder).toMatchObject({ number: 'SEED-WO-0001', rush: true })
      const [event] = await events('workorder.priority_changed', id)
      expect(event!.payload).toMatchObject({ rush: true, previousRush: false })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('split a work order (MES-010)', () => {
  it('previews what each side keeps and gets, with the materials planned from its cells', async () => {
    const parent = await draft({ '50': 4, '52': 6 })
    const [c50, c52] = parent.cells as Json[]
    const preview = await ok('manager', 'POST', `/production/work-orders/${parent.id}/split/preview`, { cells: [{ cellId: c50!.id, quantity: 4 }, { cellId: c52!.id, quantity: 2 }] })
    expect(preview).toMatchObject({ workOrderId: parent.id, number: parent.number, status: 'DRAFT', refusal: null, problems: [], numberPreview: expect.stringMatching(/^WO-\d{5}$/) })
    expect(preview.parent.cells.map((cell: Json) => [cell.cellId, cell.size, cell.quantity])).toEqual([[c52!.id, '52', 4]])
    expect(preview.child.cells.map((cell: Json) => [cell.cellId, cell.fromCellId, cell.size, cell.quantity])).toEqual([
      [null, c50!.id, '50', 4],
      [null, c52!.id, '52', 2],
    ])
    expect([preview.parent.pieces, preview.child.pieces]).toEqual([4, 6])
    // Leather 45 ft² × 1.12 a 52 (4 kept); 43 × 1.12 × 4 + 45 × 1.12 × 2 moved; protectors 2 a garment.
    const planned = (side: Json, itemId: string) => side.materials.find((material: Json) => material.itemId === itemId)?.planned
    expect([planned(preview.parent, A.leather), planned(preview.child, A.leather)]).toEqual(['201.6', '293.44'])
    expect([planned(preview.parent, A.protector), planned(preview.child, A.protector)]).toEqual(['8', '12'])
    // Nothing was written.
    expect(await admin(`SELECT count(*)::int AS n FROM "WorkOrder" WHERE "splitFromId" = $1`, [parent.id])).toEqual([{ n: 0 }])
    // What is wrong comes back in words, per path.
    const wrong = await ok('manager', 'POST', `/production/work-orders/${parent.id}/split/preview`, { cells: [{ cellId: c50!.id, quantity: 9 }] })
    expect(wrong).toMatchObject({ parent: null, child: null, problems: [{ path: 'body/cells/0/quantity', message: 'BLK 50 has 4 piece(s): move at most 4.' }] })
  })

  it('splits a DRAFT in ONE command: the new draft names its parent, the pieces move, the order line makes the same, audited and announced', async () => {
    const order = await salesOrder({ '50': 4, '52': 6 }, '2026-12-15')
    const parent = (await ok('planner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: order.lineId }], siteId: A.site, priority: 3, rush: true }, 201)).workOrder
    const [c50, c52] = parent.cells as Json[]
    const answer = await ok('manager', 'POST', `/production/work-orders/${parent.id}/split`, { version: parent.version, cells: [{ cellId: c50!.id, quantity: 4 }, { cellId: c52!.id, quantity: 2 }], note: 'First half for the trade fair' }, 201)
    const child = answer.workOrder
    expect(child).toMatchObject({ status: 'DRAFT', kind: 'SIZE_GRID', siteId: A.site, dueDate: '2026-12-15', priority: 3, rush: true, note: 'First half for the trade fair', splitFrom: { id: parent.id, number: parent.number, status: 'DRAFT' }, splits: [], pieces: 6 })
    expect(child.number).toMatch(/^WO-\d{5}$/)
    expect(child.cells.map((cell: Json) => [cell.size, cell.quantity, cell.salesOrderLineId])).toEqual([
      ['50', 4, order.lineId],
      ['52', 2, order.lineId],
    ])
    expect(answer.parent).toMatchObject({ id: parent.id, version: parent.version + 1, pieces: 4, splits: [{ id: child.id, number: child.number, status: 'DRAFT', pieces: 6 }] })
    expect(answer.parent.cells.map((cell: Json) => [cell.id, cell.size, cell.quantity])).toEqual([[c52!.id, '52', 4]])
    // The order line's pieces are the same, on two work orders.
    expect(await admin(`SELECT sum(quantity)::int AS n FROM "WorkOrderSize" WHERE "salesOrderLineId" = $1`, [order.lineId])).toEqual([{ n: 10 }])
    const open = await ok('viewer', 'GET', `/production/work-orders/open-lines?salesOrderId=${order.orderId}`)
    expect(open.lines[0].sizes.map((size: Json) => [size.size, size.onWorkOrders, size.open])).toEqual([
      ['50', 4, 0],
      ['52', 6, 0],
    ])
    expect(await admin(`SELECT "splitFromId" FROM "WorkOrder" WHERE id = $1`, [child.id])).toEqual([{ splitFromId: parent.id }])
    const audits = await admin(`SELECT "recordId", after FROM "AuditLog" WHERE action = 'workorders.split' AND "recordId" IN ($1, $2) ORDER BY "recordId" = $1 DESC`, [parent.id, child.id])
    expect(audits.map((row) => row.recordId)).toEqual([parent.id, child.id])
    expect(audits[0]!.after).toMatchObject({ splitTo: { id: child.id, number: child.number }, pieces: { moved: 6, kept: 4 } })
    expect(audits[1]!.after).toMatchObject({ status: 'DRAFT', splitFromId: parent.id, rush: true, priority: 3 })
    expect((await events('workorder.created', child.id))[0]!.payload).toMatchObject({ splitFromId: parent.id, salesOrderIds: [order.orderId], cells: 2, pieces: 6 })
    expect((await events('workorder.changed', parent.id)).at(-1)!.payload).toMatchObject({ changes: ['cells', 'split'], cells: 1, pieces: 4 })
    // The new draft is released on its own (sizes 50 and 52 are covered).
    const released = await ok('planner', 'POST', `/production/work-orders/${child.id}/release`, { version: child.version })
    expect(released.workOrder).toMatchObject({ status: 'RELEASED', batchNumber: expect.stringMatching(/^BA-\d{5}$/) })
  })

  it('takes its own due date, priority and rush flag', async () => {
    const parent = await draft({ '50': 2, '52': 2 })
    const [c50] = parent.cells as Json[]
    const { workOrder } = await ok('manager', 'POST', `/production/work-orders/${parent.id}/split`, { cells: [{ cellId: c50!.id, quantity: 1 }], dueDate: '2026-11-25', priority: 9, rush: true }, 201)
    expect(workOrder).toMatchObject({ dueDate: '2026-11-25', priority: 9, rush: true, pieces: 1 })
    const list = await ok('viewer', 'GET', '/production/work-orders?rush=true&limit=200')
    expect(list.workOrders.find((row: Json) => row.id === workOrder.id)).toMatchObject({ splitFrom: { id: parent.id, number: parent.number } })
  })

  it('refuses a released work order, moving everything, a stale version and a person without workorders.manage', async () => {
    const running = await wo('SEED-WO-0001')
    const record = (await ok('viewer', 'GET', `/production/work-orders/${running}`)).workOrder
    const cell = record.cells[0]
    const refusal = 'Work order SEED-WO-0001 is IN_PROGRESS; its sizes were frozen at its release (MES-005), so only a DRAFT is split. Make a new work order for what is still open on the order lines instead.'
    expect((await refused('manager', 'POST', `/production/work-orders/${running}/split`, { cells: [{ cellId: cell.id, quantity: 1 }] }, 409)).message).toBe(refusal)
    expect(await ok('manager', 'POST', `/production/work-orders/${running}/split/preview`, { cells: [{ cellId: cell.id, quantity: 1 }] })).toMatchObject({ refusal, parent: null, child: null })
    const parent = await draft({ '50': 1, '52': 1 })
    const [c50, c52] = parent.cells as Json[]
    const all = await refused('manager', 'POST', `/production/work-orders/${parent.id}/split`, { cells: [{ cellId: c50!.id, quantity: 1 }, { cellId: c52!.id, quantity: 1 }] }, 400)
    expect(all.message).toMatch(/^Keep at least one piece on this work order/)
    expect((await refused('manager', 'POST', `/production/work-orders/${parent.id}/split`, { version: parent.version + 5, cells: [{ cellId: c50!.id, quantity: 1 }] }, 409)).code).toBe('conflict')
    expect((await refused('viewer', 'POST', `/production/work-orders/${parent.id}/split`, { cells: [{ cellId: c50!.id, quantity: 1 }] }, 403)).code).toBe('forbidden')
    expect((await refused('sewing', 'POST', `/production/work-orders/${parent.id}/split`, { cells: [{ cellId: c50!.id, quantity: 1 }] }, 403)).code).toBe('forbidden')
    // Nothing moved.
    expect(await admin(`SELECT count(*)::int AS n FROM "WorkOrder" WHERE "splitFromId" = $1`, [parent.id])).toEqual([{ n: 0 }])
  })
})

describe('the traveller with its QR code (MES-014)', () => {
  it('prints one work order, and several in one PDF, inline and stored nowhere', async () => {
    const made = await draft({ '50': 1 })
    const one = await call('viewer', 'GET', `/production/work-orders/${made.id}/traveller?language=en`)
    expect(one.statusCode, one.body).toBe(200)
    expect(one.headers['content-type']).toBe('application/pdf')
    expect(one.headers['content-disposition']).toBe(`inline; filename="Work order traveller ${made.number}.pdf"; filename*=UTF-8''Work%20order%20traveller%20${made.number}.pdf`)
    expect(one.headers['cache-control']).toBe('no-store')
    expect(one.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    const running = await wo('SEED-WO-0001')
    const both = await call('viewer', 'GET', `/production/work-orders/travellers?ids=${made.id},${running}`)
    expect(both.statusCode, both.body).toBe(200)
    expect(both.rawPayload.toString('latin1').match(/\/Type \/Page\b/g)!.length).toBeGreaterThanOrEqual(2)
    expect(await admin(`SELECT count(*)::int AS n FROM "StoredFile" WHERE "recordId" = $1`, [made.id])).toEqual([{ n: 0 }])
  })

  it('refuses a work order nobody may see, the floor, a person without workorders.view and a repeated id', async () => {
    const made = await draft({ '50': 1 })
    const ghost = newId()
    expect((await refused('viewer', 'GET', `/production/work-orders/${ghost}/traveller`, undefined, 404)).message).toBe('Work order not found.')
    expect((await refused('viewer', 'GET', `/production/work-orders/travellers?ids=${made.id},${ghost}`, undefined, 404)).message).toBe(`Work order ${ghost} not found.`)
    expect((await refused('sewing', 'GET', `/production/work-orders/${made.id}/traveller`, undefined, 403)).code).toBe('forbidden')
    expect((await refused('stranger', 'GET', `/production/work-orders/${made.id}/traveller`, undefined, 403)).code).toBe('forbidden')
    expect((await refused('viewer', 'GET', `/production/work-orders/travellers?ids=${made.id},${made.id}`, undefined, 400)).code).toBe('validation_failed')
  })
})

describe('bulk release with per-row blockers (MES-017)', () => {
  const listKey = 'production.work-orders.release'

  it('previews each row with its blockers, releases the ones that pass through their own command, and refuses the rest with why', async () => {
    const ready = await draft({ '50': 1, '52': 1 })
    const uncovered = await draft({ '54': 1 })
    const done = await draft({ '52': 1 })
    await ok('planner', 'POST', `/production/work-orders/${done.id}/release`, { version: done.version })
    const cancelled = await draft({ '50': 1 })
    await ok('manager', 'POST', `/production/work-orders/${cancelled.id}/cancel`, { reason: 'Not needed' })
    const ids = [ready.id, uncovered.id, done.id, cancelled.id]
    const preview = await ok('planner', 'POST', '/views/bulk/preview', { listKey, ids, changes: { status: 'RELEASED' } })
    expect(preview.rows.map((row: Json) => [row.label, row.changes, row.refusal])).toEqual([
      [ready.number, [{ field: 'status', now: 'DRAFT', next: 'RELEASED' }], null],
      [uncovered.number, [{ field: 'status', now: 'DRAFT', next: 'RELEASED' }], { code: 'held', field: 'status', status: 'DRAFT', reasons: ['CERTIFICATE'] }],
      [done.number, [], null],
      [cancelled.number, [{ field: 'status', now: 'CANCELLED', next: 'RELEASED' }], { code: 'held', field: null, status: 'CANCELLED' }],
    ])
    // The review applies only the rows that change and pass; the uncovered one is sent too: checked again, held with why.
    const rows = [ready, uncovered].map((row) => ({ id: row.id, version: preview.rows.find((entry: Json) => entry.id === row.id).version, changes: { status: 'RELEASED' } }))
    const applied = await ok('planner', 'POST', '/views/bulk/apply', { listKey, rows })
    expect(applied.results.map((row: Json) => [row.label, row.ok, row.after, row.refusal])).toEqual([
      [ready.number, true, { status: 'RELEASED' }, null],
      [uncovered.number, false, { status: 'DRAFT' }, { code: 'held', field: 'status', status: 'DRAFT', reasons: ['CERTIFICATE'] }],
    ])
    expect(await admin(`SELECT status, "batchNumber" IS NOT NULL AS batch FROM "WorkOrder" WHERE id = $1`, [ready.id])).toEqual([{ status: 'RELEASED', batch: true }])
    expect(await admin(`SELECT status FROM "WorkOrder" WHERE id = $1`, [uncovered.id])).toEqual([{ status: 'DRAFT' }])
    expect(await events('workorder.released', ready.id)).toHaveLength(1)
    expect(await admin(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "recordId" = $1 AND action = 'workorders.release'`, [ready.id])).toEqual([{ n: 1 }])
  })

  it('is for people with workorders.release, and reaches at most 50 rows at once', async () => {
    const made = await draft({ '50': 1 })
    expect((await refused('manager', 'POST', '/views/bulk/preview', { listKey, ids: [made.id], changes: { status: 'RELEASED' } }, 403)).code).toBe('forbidden')
    const many = Array.from({ length: 51 }, () => newId())
    expect((await refused('planner', 'POST', '/views/bulk/preview', { listKey, ids: many, changes: { status: 'RELEASED' } }, 400)).message).toBe('Up to 50 rows at once here.')
    expect((await refused('planner', 'POST', '/views/bulk/preview', { listKey, ids: [made.id], changes: { status: 'IN_PROGRESS' } }, 400)).message).toBe('Not one of the choices.')
  })
})
