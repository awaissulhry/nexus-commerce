import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase, type Prisma } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Actor, Grant, Permission } from '@nexus/factory-domain/core/permissions'
// B-SA-004c: the office's live wall (what each person's live screen is sent of a work order change).
import { EVENT_CATALOGUE } from '@nexus/factory-domain/events/catalogue'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { liveMessageFor, liveViewFor } from '@nexus/factory-domain/events/live'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor, command } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { fanOut } from '../../../platform/notifications/fan-out'
import { systemContext } from '../../../platform/outbox/system'
import { staleChangesInCommand } from './decide'
await vi.hoisted(async () => (await import('@nexus/factory-db/testing')).seedsAsWritten())
vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-13T09:00:00.000Z'), shouldAdvanceTime: true })
afterAll(() => vi.useRealTimers())

/**
 * B-SA-041 — WorkOrderChange: the gap between an order and its work orders as a record (sales page plan, lead picks P6', R1;
 * 13-backend B4b), on the local stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the
 * runtime login: row-level security, the grants and the …_order_apply_guards are real), the factory-db seeds of two tenants up to
 * production (style SEED-JKT-02, sizes 50/52/54, revision 1 RELEASED, plant A1) with the seeds' office owner as the planner, a
 * made-up certificate of 50 and 52 and released stock at A1, sales orders typed per test. Brand Alpha = the seeds' customer P1;
 * "Brand Beta" = a person limited to another customer. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs work-order-changes`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = { a: 'wo-changes-a', b: 'wo-changes-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const A = {
  tenant: idOf(ns.a, 'tenant'),
  actor: idOf(ns.a, 'actor'),
  member: idOf(ns.a, 'user:member'),
  companyA: idOf(ns.a, 'company:A'),
  siteA1: idOf(ns.a, 'site:A1'),
  brand: idOf(ns.a, 'party:P1'),
  style: idOf(ns.a, 'production:style:JKT-02'),
  blk: idOf(ns.a, 'production:colourway:JKT-02:BLK'),
  leather: idOf(ns.a, 'product:item:leather'),
  lining: idOf(ns.a, 'product:item:lining'),
  protector: idOf(ns.a, 'product:item:protector'),
  leatherBLK: idOf(ns.a, 'product:item-colour:leather:BLK'),
  liningGRY: idOf(ns.a, 'product:item-colour:lining:GRY'),
  binA1: idOf(ns.a, 'inventory:location:A1-STORE-01'),
}
const BETA_PARTY = newId()

const WORK: Permission[] = ['workorders.view', 'workorders.manage', 'workorders.release', 'orders.view', 'orders.manage', 'threads.read', /* B-SA-043 */ 'costing.view']
const grant = (permissions: Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const SESSIONS: Record<string, SessionContext> = {
  planner: { audience: 'office', tenantId: A.tenant, actorId: A.actor, grants: [grant(WORK)] },
  member: { audience: 'office', tenantId: A.tenant, actorId: A.member, grants: [grant(WORK)] },
  // Sales proposes (orders.manage over the order, the work order reached with workorders.view) but never decides.
  sales: { audience: 'office', tenantId: A.tenant, actorId: A.member, grants: [grant(['orders.view', 'orders.manage', 'workorders.view'])] },
  betaPlanner: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(WORK, [BETA_PARTY])] },
  partner: { audience: 'partner', tenantId: A.tenant, actorId: newId(), partyId: A.brand, grants: [grant(WORK)] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
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

let orders = 0
/** A CONFIRMED order of company A to Brand Alpha (P1) of black SEED-JKT-02 in these sizes. */
async function salesOrder(sizes: Record<string, number>): Promise<{ orderId: string; number: string; lineId: string }> {
  const orderId = newId()
  const lineId = newId()
  const number = `T-${run}-SO-${++orders}`
  const pieces = Object.values(sizes).reduce((sum, quantity) => sum + quantity, 0)
  await asOffice(async (tx) => {
    await tx.salesOrder.create({ data: { id: orderId, companyId: A.companyA, partyId: A.brand, number, status: 'CONFIRMED', orderDate: new Date('2026-10-20T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up workshop' }, promiseDate: new Date('2026-12-10T00:00:00.000Z') }, select: { id: true } })
    await tx.salesOrderLine.create({ data: { id: lineId, companyId: A.companyA, orderId, partyId: A.brand, seq: 10, kind: 'SIZE_GRID', styleId: A.style, colourwayId: A.blk, quantity: pieces, unitPrice: '100.000000', netAmount: pieces * 10_000, vatRatePct: '22.00', vatAmount: pieces * 2_200 }, select: { id: true } })
    await tx.salesOrderLineSize.createMany({ data: Object.entries(sizes).map(([size, quantity]) => ({ id: newId(), lineId, partyId: A.brand, size, quantity })) })
  })
  return { orderId, number, lineId }
}
/** A DRAFT of the order's line (every open size), RELEASED when asked. */
async function workOrderOf(order: { lineId: string }, released = false): Promise<Json> {
  const { workOrder } = await ok('planner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: order.lineId }] }, 201)
  if (!released) return workOrder
  return (await ok('planner', 'POST', `/production/work-orders/${workOrder.id}/release`, {})).workOrder
}
const cellOf = (workOrder: Json, size: string): Json => (workOrder.cells as Json[]).find((cell) => cell.size === size)!
const propose = (body: Json, session = 'sales', status = 201) => ok(session, 'POST', '/production/work-order-changes', body, status)
const lowering = (order: { orderId: string; lineId: string }, workOrder: Json, size: string, to: number, more: Json = {}) => {
  const cell = cellOf(workOrder, size)
  return { salesOrderId: order.orderId, workOrderId: workOrder.id, kind: 'LOWER_TO_ORDER', cells: [{ salesOrderLineId: order.lineId, size, from: cell.quantity, to, workOrderSizeId: cell.id }], reason: 'Made-up: the customer ordered fewer', ...more }
}

beforeAll(async () => {
  db = await migratedDatabase('wo_changes')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 10 } })
  for (const namespace of [ns.a, ns.b]) {
    await seedCore({ db: database, namespace })
    await seedAuth({ db: database, namespace })
    // The seeds' owner holds the owner role (the bell reads a person's live roles, never the test session's grants).
    await seedRoles({ db: database, namespace })
    await seedProduction({ db: database, namespace })
    await seedNumbering({ db: database, namespace })
  }
  await asOffice(async (tx) => {
    const certificateId = newId()
    await tx.certificate.create({ data: { id: certificateId, holderPartyId: A.brand, standard: 'EN 17092-3:2020', ppeClass: 'AA', number: `TEST-CERT-${run}`, notifiedBodyName: 'Made-up Notified Body', notifiedBodyNumber: '9999', modelReference: 'SEED-JKT-02', validFrom: new Date('2026-01-01T00:00:00.000Z'), validTo: new Date('2030-12-31T00:00:00.000Z'), status: 'VALID', statusChangedAt: new Date() }, select: { id: true } })
    await tx.certificateCoverage.create({ data: { id: newId(), certificateId, styleId: A.style, sizes: ['50', '52'] }, select: { id: true } })
  })
  for (const [itemId, colourId, quantity, uom, leather] of [[A.leather, A.leatherBLK, '3000.0000', 'FT2', true], [A.lining, A.liningGRY, '800.0000', 'M', false], [A.protector, null, '2000.0000', 'PCS', false]] as const) {
    const lotId = newId()
    const code = `T-${run}-${uom}`
    await admin(
      `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "qualityStatus", "qualityDecidedAt", "requiresCrViTest", "crViLimitMgKg", "crViStatus", "crViMgKg", "crViEvidence", "crViTestedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'RELEASED', now(), $8, $9, $10, $11, $12, $13)`,
      [lotId, A.tenant, A.companyA, A.siteA1, itemId, colourId, code, leather, leather ? '3.000' : null, leather ? 'PASS' : 'NOT_REQUIRED', leather ? '1.100' : null, leather ? 'LOT_REPORT' : null, leather ? '2026-10-01' : null],
    )
    const hideId = leather ? newId() : null
    if (hideId) await admin(`INSERT INTO "Hide" (id, "tenantId", "siteId", "lotId", "itemId", code, area, "areaUom", "baseArea") VALUES ($1, $2, $3, $4, $5, $6, $7, 'FT2', $7)`, [hideId, A.tenant, A.siteA1, lotId, itemId, `${code}-H1`, quantity])
    await admin(
      `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "hideId", "toLocationId", quantity, uom, "baseQuantity", "idempotencyKey", "occurredAt")
       VALUES ($1, $2, $3, $4, 'OPENING', $5, $6, $7, $8, $9, $10, $11, $10, $12, now())`,
      [newId(), A.tenant, A.companyA, A.siteA1, itemId, colourId, lotId, hideId, A.binA1, quantity, uom, `wo-changes-test-${code}`],
    )
  }
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 240_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('a work-order change: proposed, applied, left as is, stale (B-SA-041)', () => {
  it('lowers a DRAFT in one command: proposed by sales, applied by the planner, audited and announced', async () => {
    const order = await salesOrder({ '50': 2, '52': 5 })
    const workOrder = await workOrderOf(order)
    const { change } = await propose(lowering(order, workOrder, '52', 3))
    expect(change).toMatchObject({ status: 'PROPOSED', kind: 'LOWER_TO_ORDER', partyId: A.brand, salesOrder: { id: order.orderId, number: order.number }, workOrder: { id: workOrder.id, status: 'DRAFT' }, cells: [{ size: '52', from: 5, to: 3, lineSeq: 10 }], extra: [], proposedBy: { id: A.member }, version: 1, mayDecide: false })
    expect(change.words.title).toEqual({ en: `Work order change · ${workOrder.number}`, it: `Modifica dell'ordine di lavoro · ${workOrder.number}` })
    const applied = await ok('planner', 'POST', `/production/work-order-changes/${change.id}/apply`, { version: change.version })
    expect(applied.change).toMatchObject({ status: 'APPLIED', decidedBy: { id: A.actor }, lastError: null })
    expect(applied.workOrder).toMatchObject({ id: workOrder.id, status: 'DRAFT' })
    expect(await admin(`SELECT quantity FROM "WorkOrderSize" WHERE id = $1`, [cellOf(workOrder, '52').id])).toEqual([{ quantity: 3 }])
    const events = await admin(`SELECT type, payload->>'partyId' AS "partyId" FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id`, [change.id])
    expect(events).toEqual([{ type: 'work_order_change.proposed', partyId: A.brand }, { type: 'work_order_change.applied', partyId: A.brand }])
    expect((await refused('planner', 'POST', `/production/work-order-changes/${change.id}/apply`, { version: applied.change.version }, 409)).issues[0].path).toBe('refusal/DECIDED')
  })

  it('lowers a released work order through Lower to the order; a cell changed since is refused in words and the change keeps the words', async () => {
    const order = await salesOrder({ '52': 4 })
    const workOrder = await workOrderOf(order, true)
    const { change } = await propose(lowering(order, workOrder, '52', 2))
    // The planner lowered it by hand meanwhile: the change was proposed on another figure.
    await ok('planner', 'POST', `/production/work-orders/${workOrder.id}/lower-to-order`, { cells: [{ workOrderSizeId: cellOf(workOrder, '52').id, quantity: 3 }] })
    const stale = await refused('planner', 'POST', `/production/work-order-changes/${change.id}/apply`, { version: change.version }, 409)
    expect(stale.issues).toEqual([{ path: 'refusal/CHANGED_SINCE', message: `${workOrder.number} changed since — propose again` }])
    const kept = (await ok('planner', 'GET', `/production/work-order-changes/${change.id}`)).change
    expect(kept).toMatchObject({ status: 'PROPOSED', lastError: `${workOrder.number} changed since — propose again`, version: change.version + 1 })
    // Proposed again on the figure it makes now, it goes through Lower to the order (the traveller marked for a reprint).
    const fresh = (await ok('planner', 'GET', `/production/work-orders/${workOrder.id}`)).workOrder
    const again = (await propose(lowering(order, fresh, '52', 2))).change
    const applied = await ok('planner', 'POST', `/production/work-order-changes/${again.id}/apply`, { version: again.version })
    expect(applied).toMatchObject({ change: { status: 'APPLIED' }, workOrder: { status: 'RELEASED' }, reprint: { traveller: true } })
    expect(await admin(`SELECT quantity FROM "WorkOrderSize" WHERE id = $1`, [cellOf(workOrder, '52').id])).toEqual([{ quantity: 2 }])
  })

  it('makes more: an open DRAFT grows, else a new DRAFT is made and named on the change', async () => {
    const order = await salesOrder({ '50': 2, '52': 2 })
    const draft = await workOrderOf(order)
    const cell = cellOf(draft, '52')
    // The order now wants 4 of 52 (made up: the line raised by hand).
    await force(`UPDATE "SalesOrderLineSize" SET quantity = 4 WHERE "lineId" = $1 AND size = '52'`, [order.lineId])
    const grow = (await propose({ salesOrderId: order.orderId, workOrderId: draft.id, kind: 'MAKE_MORE', cells: [{ salesOrderLineId: order.lineId, size: '52', from: 2, to: 4, workOrderSizeId: cell.id }], reason: 'Made-up: two more' })).change
    await ok('member', 'POST', `/production/work-order-changes/${grow.id}/apply`, { version: grow.version })
    expect(await admin(`SELECT quantity FROM "WorkOrderSize" WHERE id = $1`, [cell.id])).toEqual([{ quantity: 4 }])
    // Released, it makes no more: a new DRAFT of the two pieces the order still wants.
    const released = await ok('planner', 'POST', `/production/work-orders/${draft.id}/release`, {})
    expect(released.workOrder.status).toBe('RELEASED')
    await force(`UPDATE "SalesOrderLineSize" SET quantity = 6 WHERE "lineId" = $1 AND size = '52'`, [order.lineId])
    const fresh = (await propose({ salesOrderId: order.orderId, kind: 'MAKE_MORE', cells: [{ salesOrderLineId: order.lineId, size: '52', from: 0, to: 2, workOrderSizeId: null }], reason: 'Made-up: two more again' })).change
    expect(fresh).toMatchObject({ workOrder: null, madeWorkOrder: null })
    const applied = await ok('planner', 'POST', `/production/work-order-changes/${fresh.id}/apply`, { version: fresh.version })
    expect(applied.change).toMatchObject({ status: 'APPLIED', madeWorkOrder: { id: applied.workOrder.id } })
    expect(applied.workOrder).toMatchObject({ status: 'DRAFT' })
    expect(await admin(`SELECT size, quantity FROM "WorkOrderSize" WHERE "workOrderId" = $1`, [applied.workOrder.id])).toEqual([{ size: '52', quantity: 2 }])
  })

  it('leaves a change as is only with words (1 to 300), and makes the waiting ones of an amendment put back stale', async () => {
    const order = await salesOrder({ '52': 4 })
    const workOrder = await workOrderOf(order)
    const { change } = await propose(lowering(order, workOrder, '52', 2))
    expect((await refused('planner', 'POST', `/production/work-order-changes/${change.id}/decline`, { version: change.version, words: ' ' }, 400)).code).toBe('validation_failed')
    expect((await call('planner', 'POST', `/production/work-order-changes/${change.id}/decline`, { version: change.version, words: 'x'.repeat(301) })).statusCode).toBe(400)
    const declined = (await ok('planner', 'POST', `/production/work-order-changes/${change.id}/decline`, { version: change.version, words: 'Made-up: the customer takes them as they are' })).change
    expect(declined).toMatchObject({ status: 'DECLINED', decisionNote: 'Made-up: the customer takes them as they are', decidedBy: { id: A.actor } })
    expect(await admin(`SELECT quantity FROM "WorkOrderSize" WHERE id = $1`, [cellOf(workOrder, '52').id])).toEqual([{ quantity: 4 }])
    // An amendment of the order, its change proposed, then put back: the change is STALE, decided by nobody but the one who put it back.
    const amendmentId = newId()
    await force(
      `INSERT INTO "SalesOrderAmendment" (id, "tenantId", "companyId", "orderId", "partyId", revision, reason, before, after, "netAmountBefore", "netAmountAfter", "grossAmountBefore", "grossAmountAfter", "requestId") VALUES ($1, $2, $3, $4, $5, 1, 'Made-up', '{}', '{}', 0, 0, 0, 0, $6)`,
      [amendmentId, A.tenant, A.companyA, order.orderId, A.brand, newId() /* the command's request, as every amendment names */],
    )
    const waiting = (await propose(lowering(order, workOrder, '52', 1, { amendmentId }))).change
    const planner = callerFor(database, { ...(SESSIONS.planner as Extract<SessionContext, { audience: 'office' }>), requestId: newId() })
    const { result } = await command(planner, { name: 'orders.putBackChange', input: { amendmentId } }, (tools) => staleChangesInCommand(tools, { amendmentId }))
    expect(result).toBe(1)
    expect((await ok('planner', 'GET', `/production/work-order-changes/${waiting.id}`)).change).toMatchObject({ status: 'STALE', decidedBy: { id: A.actor } })
    expect(await admin(`SELECT type FROM "OutboxEvent" WHERE subject = $1 AND type = 'work_order_change.stale'`, [waiting.id])).toHaveLength(1)
  })

  it('carries out accepted requests only, and checks the cells against the work order as it is', async () => {
    const order = await salesOrder({ '52': 4 })
    const workOrder = await workOrderOf(order)
    const requestId = newId()
    await force(`INSERT INTO "OrderChangeRequest" (id, "tenantId", "companyId", "orderId", "partyId", kind, status) VALUES ($1, $2, $3, $4, $5, 'CHANGE', 'OPEN')`, [requestId, A.tenant, A.companyA, order.orderId, A.brand])
    expect((await refused('sales', 'POST', '/production/work-order-changes', lowering(order, workOrder, '52', 2, { requestId }), 409)).issues[0].path).toBe('refusal/REQUEST_NOT_ACCEPTED')
    const wrongFrom = lowering(order, workOrder, '52', 2)
    wrongFrom.cells[0]!.from = 5
    expect((await refused('sales', 'POST', '/production/work-order-changes', wrongFrom, 409)).issues[0].path).toBe('refusal/CHANGED_SINCE')
    const up = lowering(order, workOrder, '52', 6)
    expect((await refused('sales', 'POST', '/production/work-order-changes', up, 400)).code).toBe('validation_failed')
  })

  it('tells who may apply it (the bell), and the proposer once it is decided', async () => {
    const order = await salesOrder({ '52': 4 })
    const workOrder = await workOrderOf(order)
    await force(`INSERT INTO "RecordFollower" (id, "tenantId", "recordType", "recordId", "userId", reason) VALUES ($1, $2, 'WorkOrder', $3, $4, 'CHOSE')`, [newId(), A.tenant, workOrder.id, A.actor])
    const { change } = await propose(lowering(order, workOrder, '52', 2))
    const system = callerFor(database, systemContext(A.tenant, newId()))
    const [proposed] = await admin(`SELECT id::text AS id, type FROM "OutboxEvent" WHERE subject = $1 AND type = 'work_order_change.proposed'`, [change.id])
    await fanOut(system, { eventId: proposed!.id, type: proposed!.type, payload: { changeId: change.id, salesOrderId: order.orderId, workOrderId: workOrder.id, partyId: A.brand, kind: 'LOWER_TO_ORDER', requestId: null, amendmentId: null, hasExtra: false } } as never)
    expect(await admin(`SELECT "userId", category::text AS category, "messageKey" FROM "Notification" WHERE "eventId" = $1`, [proposed!.id])).toEqual([{ userId: A.actor, category: 'ASSIGNMENT', messageKey: 'notifications.production.workOrderChangeProposed' }])
  })

  // S7 end check: the rule read the resolver's `supervisorId`, which it never had (its person is `userId`), so a supervisor who
  // did not follow the work order was never told. Here nobody follows it: the customer's default supervisor alone is told.
  it("tells the work order's production supervisor (the customer's default), who does not follow it", async () => {
    const order = await salesOrder({ '52': 4 })
    const workOrder = await workOrderOf(order)
    const before = await admin<{ productionSupervisorId: string | null }>(`SELECT "productionSupervisorId" FROM "PortalSettings" WHERE id = $1`, [A.brand])
    // As PUT /production/brands/:partyId/supervisor writes it: one PortalSettings row per party, its id the party's (B-PR-42a).
    await admin(
      `INSERT INTO "PortalSettings" (id, "tenantId", "partyId", "portalOn", "productionSupervisorId", "productionSupervisorSetAt", "createdAt", "updatedAt")
       VALUES ($1, $2, $1, false, $3, now(), now(), now())
       ON CONFLICT (id) DO UPDATE SET "productionSupervisorId" = EXCLUDED."productionSupervisorId", "productionSupervisorSetAt" = EXCLUDED."productionSupervisorSetAt", version = "PortalSettings".version + 1, "updatedAt" = now()`,
      [A.brand, A.tenant, A.actor],
    )
    try {
      const { change } = await propose(lowering(order, workOrder, '52', 2))
      const system = callerFor(database, systemContext(A.tenant, newId()))
      const [proposed] = await admin(`SELECT id::text AS id, type FROM "OutboxEvent" WHERE subject = $1 AND type = 'work_order_change.proposed'`, [change.id])
      await fanOut(system, { eventId: proposed!.id, type: proposed!.type, payload: { changeId: change.id, salesOrderId: order.orderId, workOrderId: workOrder.id, partyId: A.brand, kind: 'LOWER_TO_ORDER', requestId: null, amendmentId: null, hasExtra: false } } as never)
      expect(await admin(`SELECT "userId", category::text AS category, "messageKey" FROM "Notification" WHERE "eventId" = $1`, [proposed!.id])).toEqual([{ userId: A.actor, category: 'ASSIGNMENT', messageKey: 'notifications.production.workOrderChangeProposed' }])
    } finally {
      // The world as it was: a PortalSettings row is never deleted by the app (its guard), so the test's own row goes with the rules off.
      if (before.length === 0) await force(`DELETE FROM "PortalSettings" WHERE id = $1`, [A.brand])
      else await admin(`UPDATE "PortalSettings" SET "productionSupervisorId" = $2::uuid, "productionSupervisorSetAt" = CASE WHEN $2::uuid IS NULL THEN NULL ELSE now() END WHERE id = $1`, [A.brand, before[0]!.productionSupervisorId])
    }
  })
})

describe('the wall: another customer reaches nothing of it (B-SA-041)', () => {
  it('a Beta-limited planner is not told it exists; the database refuses a Beta work order on an Alpha order', async () => {
    const order = await salesOrder({ '52': 4 })
    const workOrder = await workOrderOf(order)
    const { change } = await propose(lowering(order, workOrder, '52', 2))
    expect((await refused('betaPlanner', 'POST', `/production/work-order-changes/${change.id}/apply`, { version: change.version }, 404)).message).toBe('Work order change not found.')
    expect((await refused('betaPlanner', 'POST', `/production/work-order-changes/${newId()}/apply`, { version: 1 }, 404)).message).toBe('Work order change not found.')
    expect((await refused('betaPlanner', 'GET', `/production/work-order-changes/${change.id}`, undefined, 404)).message).toBe('Work order change not found.')
    expect((await ok('betaPlanner', 'GET', `/production/work-order-changes?salesOrderId=${order.orderId}&status=ALL`)).items).toEqual([])
    expect((await refused('betaPlanner', 'POST', '/production/work-order-changes', lowering(order, workOrder, '52', 2), 404)).message).toBe('Sales order not found.')
    expect((await call('partner', 'GET', `/production/work-order-changes/${change.id}`)).statusCode).toBe(403)
    // Sales reads it (the order's "Still to do") but may not decide it: workorders.manage over the work order.
    expect((await ok('sales', 'GET', `/production/work-order-changes?salesOrderId=${order.orderId}`)).items.map((item: Json) => item.id)).toEqual([change.id])
    expect((await call('sales', 'POST', `/production/work-order-changes/${change.id}/apply`, { version: change.version })).statusCode).toBe(403)
    // A work order of another customer (planted) on this customer's order: the database's guard refuses it, in words of neither.
    const beta = newId()
    await force(`INSERT INTO "WorkOrder" SELECT (jsonb_populate_record(NULL::"WorkOrder", to_jsonb(w) || jsonb_build_object('id', $1::text, 'number', $2::text, 'partyId', $3::text))).* FROM "WorkOrder" w WHERE w.id = $4::uuid`, [beta, `T-${run}-WO-BETA`, BETA_PARTY, workOrder.id])
    await expect(
      asOffice((tx) => tx.workOrderChange.create({ data: { id: newId(), companyId: A.companyA, partyId: A.brand, salesOrderId: order.orderId, siteId: A.siteA1, workOrderId: beta, kind: 'MAKE_MORE', cells: [{ salesOrderLineId: order.lineId, size: '54', from: 0, to: 1, workOrderSizeId: null }], reason: 'Made-up', proposedById: A.actor }, select: { id: true } })),
    ).rejects.toThrow(/names an open work order of its own order's customer/)
  })
})

// ── B-SA-043 (sales page plan R1; review P6-3, P6-4): extra pieces told honestly, office only ──
describe('extra pieces: named on the order\'s office reads, never hidden (B-SA-043)', () => {
  it('names the pieces cut beyond what the order now wants on the customer-materials card and as the margin\'s cost line', async () => {
    const order = await salesOrder({ '52': 4 })
    const workOrder = await workOrderOf(order, true)
    await ok('planner', 'POST', `/production/work-orders/${workOrder.id}/start`, {})
    await force(`INSERT INTO "Bundle" (id, "tenantId", "siteId", "workOrderId", "workOrderSizeId", code, quantity) VALUES ($1, $2, $3, $4, $5, $6, 3)`, [newId(), A.tenant, A.siteA1, workOrder.id, cellOf(workOrder, '52').id, `T-${run}-SA043-BN`])
    // The order now wants 2 of 52 (a change accepted after cutting): 3 cut, 1 made extra.
    await force(`UPDATE "SalesOrderLineSize" SET quantity = 2 WHERE "lineId" = $1 AND size = '52'`, [order.lineId])
    const materials = await ok('planner', 'GET', `/sales/orders/${order.orderId}/customer-materials`)
    expect(materials.extra.pieces).toEqual([{ lineId: order.lineId, size: '52', count: 1, words: { en: 'Made extra: 1 52', it: 'Fatti in più: 1 52' } }])
    const margin = await ok('planner', 'GET', `/costing/margins/orders/${order.orderId}`)
    expect(margin.extraPieces).toMatchObject({ count: 1, lines: [{ lineId: order.lineId, seq: 10, size: '52', count: 1 }], words: expect.stringContaining('cut beyond what the order now wants') })
    // Another customer's person reads neither.
    expect((await call('betaPlanner', 'GET', `/sales/orders/${order.orderId}/customer-materials`)).statusCode).toBe(404)
    expect((await call('betaPlanner', 'GET', `/costing/margins/orders/${order.orderId}`)).statusCode).toBe(404)
  })
})
// ── end B-SA-043 ──

// ── B-SA-004c (Sales lead's note: production staff see a new proposal live) ──
/**
 * work_order_change.* reach the order's readers (orders.view) AND its work order's (workorders.view, the rule's `also`): the
 * change's own read (./read.ts) is the one OR the other. A production person with workorders.view and no orders.view, limited
 * to the order's customer, is sent the proposal and its decision; one limited to another customer, or holding neither, is not.
 */
describe('live: a work order change reaches production staff without orders.view (B-SA-004c)', () => {
  type Row = { id: string; type: string; version: number; context: string; tenantId: string; companyId: string | null; siteId: string | null; subject: string; correlationId: string; causationId: string | null; source: string; occurredAt: Date; payload: Json }
  const envelopeOf = (row: Row): EventEnvelope => ({ eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload })
  const person = (permissions: Permission[], parties: Grant['parties']): Actor => ({ audience: 'office', tenantId: A.tenant, grants: [grant(permissions, parties)] })
  const sent = (row: Row, viewer: Actor) => liveViewFor(liveMessageFor(envelopeOf(row), EVENT_CATALOGUE.get(row.type, row.version))!, viewer, EVENT_CATALOGUE)

  it("the floor's supervisor (workorders.view, no orders.view) of the customer gets it; of another customer, or with neither right, not", async () => {
    const order = await salesOrder({ '52': 4 })
    const workOrder = await workOrderOf(order)
    const { change } = await propose(lowering(order, workOrder, '52', 2))
    const rows = await admin<Row>(`SELECT * FROM "OutboxEvent" WHERE subject = $1 AND type LIKE 'work_order_change.%' ORDER BY "occurredAt", id`, [change.id])
    expect(rows.map((row) => row.type)).toEqual(['work_order_change.proposed'])
    const [proposed] = rows
    expect(proposed!.payload.partyId).toBe(A.brand)
    expect(sent(proposed!, person(['workorders.view'], [A.brand]))).not.toBeNull()
    expect(sent(proposed!, person(['workorders.view'], 'all'))).not.toBeNull()
    expect(sent(proposed!, person(['workorders.view'], [BETA_PARTY]))).toBeNull()
    expect(sent(proposed!, person(['orders.view'], [A.brand]))).not.toBeNull()
    expect(sent(proposed!, person(['threads.read', 'costing.view'], 'all'))).toBeNull()
    const view = sent(proposed!, person(['workorders.view'], [A.brand]))!
    expect(view).not.toHaveProperty('partyIds')
    expect(view.fields).toEqual({ changeId: change.id, salesOrderId: order.orderId, workOrderId: workOrder.id, kind: 'LOWER_TO_ORDER' })
  })
})
// ── end B-SA-004c ──
