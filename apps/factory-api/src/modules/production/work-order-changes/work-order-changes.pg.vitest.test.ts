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
import { LOCAL_COOKIE_SECRET, LOCAL_PIN_PEPPER } from '../../../env'
// op-fx3: the app's office sign-in carries the app's clock (platform/portal/tasks/clock appClock), which the sales routes read.
import { createOfficeAuth } from '../../../platform/auth/sessions/office-auth'
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
  // B-OP-012: the seeds' owner limited to Brand Alpha (a planner of one customer: never every customer).
  alphaPlanner: { audience: 'office', tenantId: A.tenant, actorId: A.actor, grants: [grant(WORK, [A.brand])] },
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
  // op-fx3: B-OP-012 accepts a customer's request (POST /sales/change-requests/:id/accept), a route on the app's clock: the app carries
  // the office sign-in as every test app of such routes does (it answered 503 "Office sign-in is not configured" without it). The
  // sessions stay the test's own; nothing here signs in or sends mail.
  const officeAuth = createOfficeAuth({ database, environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET, pinPepper: LOCAL_PIN_PEPPER, webOrigin: 'http://localhost:3200', mailer: { deliver: async () => {} } })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, officeAuth, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
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
    expect(materials.extra.pieces).toEqual([{ lineId: order.lineId, size: '52', count: 1, words: { en: '1 52 more than ordered: cut or planned to cut', it: "1 52 in più dell'ordine: tagliati o da tagliare" } }]) // B-OO-015: the words say what they count
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

// ── B-OP-012 (order page plan N2, decisions D1 + D3; review R-4, R-11, R-17): the work orders follow an office change in its command ──
/**
 * An office change of the order (here the amendment and Accept, the runner's callers) carries its work orders along in its own
 * command: a DRAFT for anyone who may change the order (Sales too), a released one only for a holder of workorders.manage (the
 * Owner, a planner), never below what is cut, never a mixed one; what may not follow waits, PROPOSED, with its words, and the office
 * change always lands.
 */
describe('B-OP-012: the work orders follow an office change in its command (R-4)', () => {
  const PRODUCTION = (number: string) => ({ en: `${number} is released: production applies the change (a planner or a production manager).`, it: `${number} è rilasciato: la modifica la applica la produzione (un pianificatore o un responsabile di produzione).` })
  const orderVersion = async (orderId: string) => (await admin<{ version: number }>(`SELECT version FROM "SalesOrder" WHERE id = $1`, [orderId]))[0]!.version
  /** The amendment of the order's one line to these sizes: its answer (201), or its refusal's error (any other status asked). */
  const amend = async (session: string, order: { orderId: string; lineId: string }, sizes: Record<string, number>, more: Json = {}, status = 201): Promise<Json> => {
    const body = { version: await orderVersion(order.orderId), reason: 'Made-up: the customer changed its sizes', lines: [{ id: order.lineId, sizes: Object.entries(sizes).map(([size, quantity]) => ({ size, quantity })) }], ...more }
    const response = await call(session, 'POST', `/sales/orders/${order.orderId}/amendments`, body)
    expect(response.statusCode, response.body).toBe(status)
    return status === 201 ? response.json() : response.json().error
  }
  /** A work order of the order's line making only these sizes, RELEASED when asked. */
  const workOrderFor = async (order: { lineId: string }, sizes: Record<string, number>, released = false): Promise<Json> => {
    const { workOrder } = await ok('planner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: order.lineId, sizes: Object.entries(sizes).map(([size, quantity]) => ({ size, quantity })) }] }, 201)
    return released ? (await ok('planner', 'POST', `/production/work-orders/${workOrder.id}/release`, {})).workOrder : workOrder
  }
  const quantityOf = async (cellId: string) => (await admin<{ quantity: number }>(`SELECT quantity FROM "WorkOrderSize" WHERE id = $1`, [cellId]))[0]?.quantity ?? null
  const changesOf = (orderId: string) => admin(`SELECT "workOrderId"::text AS "workOrderId", status::text AS status, "lastError" FROM "WorkOrderChange" WHERE "salesOrderId" = $1 ORDER BY "createdAt", id`, [orderId])

  it('Sales (orders.manage, no workorders.manage) amends: its DRAFT follows in the same command; its RELEASED one waits with words; nobody is asked to apply what was applied', async () => {
    const order = await salesOrder({ '50': 2, '52': 4 })
    const released = await workOrderFor(order, { '50': 2 }, true)
    const draft = await workOrderFor(order, { '52': 4 })
    await force(`INSERT INTO "RecordFollower" (id, "tenantId", "recordType", "recordId", "userId", reason) VALUES ($1, $2, 'WorkOrder', $3, $4, 'CHOSE')`, [newId(), A.tenant, draft.id, A.actor])
    const answer = await amend('sales', order, { '50': 1, '52': 3 })
    expect(answer.workOrders.applied).toEqual([{ changeId: expect.any(String), workOrderId: draft.id, number: draft.number, route: 'SET_DRAFT_CELLS', reprint: false }])
    expect(answer.workOrders.waiting).toEqual([{ changeId: expect.any(String), workOrderId: released.id, number: released.number, words: PRODUCTION(released.number) }])
    expect(await quantityOf(cellOf(draft, '52').id)).toBe(3)
    expect(await quantityOf(cellOf(released, '50').id)).toBe(2)
    expect(await changesOf(order.orderId)).toEqual(expect.arrayContaining([{ workOrderId: draft.id, status: 'APPLIED', lastError: null }, { workOrderId: released.id, status: 'PROPOSED', lastError: null }]))
    // The proposal's bell is never rung for a change applied in the same command (its follower would have been told).
    const appliedId = answer.workOrders.applied[0].changeId as string
    const [proposed] = await admin(`SELECT id::text AS id, type FROM "OutboxEvent" WHERE subject = $1 AND type = 'work_order_change.proposed'`, [appliedId])
    expect(await admin(`SELECT type FROM "OutboxEvent" WHERE subject = $1 AND type = 'work_order_change.applied'`, [appliedId])).toHaveLength(1)
    await fanOut(callerFor(database, systemContext(A.tenant, newId())), { eventId: proposed!.id, type: proposed!.type, payload: { changeId: appliedId, salesOrderId: order.orderId, workOrderId: draft.id, partyId: A.brand, kind: 'LOWER_TO_ORDER', requestId: null, amendmentId: answer.amendment.id, hasExtra: false } } as never)
    expect(await admin(`SELECT id FROM "Notification" WHERE "eventId" = $1`, [proposed!.id])).toEqual([])
    // Sales still decides nothing of the released one (workorders.manage over it).
    const waiting = (await ok('sales', 'GET', `/production/work-order-changes/${answer.workOrders.waiting[0].changeId}`)).change
    expect((await call('sales', 'POST', `/production/work-order-changes/${waiting.id}/apply`, { version: waiting.version })).statusCode).toBe(403)
  })

  it('the Owner (orders.manage and workorders.manage): both follow — the released one lowered with the reprint mark, the floor told by the applied event', async () => {
    const order = await salesOrder({ '50': 2, '52': 4 })
    const released = await workOrderFor(order, { '50': 2 }, true)
    const draft = await workOrderFor(order, { '52': 4 })
    const answer = await amend('planner', order, { '50': 1, '52': 3 })
    expect(answer.workOrders.waiting).toEqual([])
    expect(answer.workOrders.applied).toEqual(
      expect.arrayContaining([
        { changeId: expect.any(String), workOrderId: released.id, number: released.number, route: 'LOWER_RELEASED', reprint: true },
        { changeId: expect.any(String), workOrderId: draft.id, number: draft.number, route: 'SET_DRAFT_CELLS', reprint: false },
      ]),
    )
    expect(await quantityOf(cellOf(released, '50').id)).toBe(1)
    expect(await quantityOf(cellOf(draft, '52').id)).toBe(3)
    expect((await ok('planner', 'GET', `/production/work-orders/${released.id}`)).workOrder.status).toBe('RELEASED')
    // sales.orderChangeNotes writes the floor's STOP/CHECK note on these (work_order_change.applied), one per work order.
    const applied = await admin<{ subject: string }>(`SELECT subject::text AS subject FROM "OutboxEvent" WHERE type = 'work_order_change.applied' AND payload->>'salesOrderId' = $1`, [order.orderId])
    expect(applied.map((row) => row.subject).sort()).toEqual(answer.workOrders.applied.map((entry: Json) => entry.changeId).sort())
  })

  it('never below cut: the cell stops at what is cut, the rest are extra pieces with their outcome; without an outcome the amendment is held in words', async () => {
    const order = await salesOrder({ '52': 4 })
    const workOrder = await workOrderFor(order, { '52': 4 }, true)
    await ok('planner', 'POST', `/production/work-orders/${workOrder.id}/start`, {})
    await force(`INSERT INTO "Bundle" (id, "tenantId", "siteId", "workOrderId", "workOrderSizeId", code, quantity) VALUES ($1, $2, $3, $4, $5, $6, 3)`, [newId(), A.tenant, A.siteA1, workOrder.id, cellOf(workOrder, '52').id, `T-${run}-OP012-BN`])
    const held = await amend('planner', order, { '52': 1 }, {}, 409)
    expect(held.issues).toEqual([{ path: 'refusal/EXTRA_OUTCOME', message: 'Choose what happens to the 2 extra pieces' }])
    expect(await admin(`SELECT id FROM "SalesOrderAmendment" WHERE "orderId" = $1`, [order.orderId])).toEqual([])
    const answer = await amend('planner', order, { '52': 1 }, { extraOutcome: 'LEFTOVER' })
    expect(answer.workOrders.applied).toEqual([{ changeId: expect.any(String), workOrderId: workOrder.id, number: workOrder.number, route: 'LOWER_RELEASED', reprint: true }])
    expect(await quantityOf(cellOf(workOrder, '52').id)).toBe(3)
    const change = (await ok('planner', 'GET', `/production/work-order-changes/${answer.workOrders.applied[0].changeId}`)).change
    expect(change).toMatchObject({ status: 'APPLIED', extraOutcome: 'LEFTOVER', extra: [{ size: '52', count: 2 }] })
  })

  it('ON_HOLD: the change waits with the hold\'s words (kept on it) while the amendment lands', async () => {
    const order = await salesOrder({ '52': 4 })
    const workOrder = await workOrderFor(order, { '52': 4 }, true)
    // On hold (as a production hold leaves it).
    await force(`UPDATE "WorkOrder" SET status = 'ON_HOLD' WHERE id = $1`, [workOrder.id])
    const answer = await amend('planner', order, { '52': 2 })
    const onHold = { en: `${workOrder.number} is on hold: lift the hold first, then apply the change.`, it: `${workOrder.number} è in pausa: togli prima la pausa, poi applica la modifica.` }
    expect(answer.workOrders).toEqual({ applied: [], waiting: [{ changeId: expect.any(String), workOrderId: workOrder.id, number: workOrder.number, words: onHold }] })
    expect(answer.amendment).toMatchObject({ revision: 1 })
    expect(await admin(`SELECT quantity FROM "SalesOrderLineSize" WHERE "lineId" = $1 AND size = '52'`, [order.lineId])).toEqual([{ quantity: 2 }])
    expect(await quantityOf(cellOf(workOrder, '52').id)).toBe(4)
    expect(await changesOf(order.orderId)).toEqual([{ workOrderId: workOrder.id, status: 'PROPOSED', lastError: onHold.en }])
  })

  it('a mixed work order (made before the one-customer rule) always waits, the Owner\'s change too; a planner of one customer is told of "a work order", never its number (R-11, the wall)', async () => {
    const order = await salesOrder({ '52': 4 })
    const workOrder = await workOrderFor(order, { '52': 4 })
    // Made before the one-customer rule: no customer of its own (planted as such a work order is).
    await force(`UPDATE "WorkOrder" SET "partyId" = NULL WHERE id = $1`, [workOrder.id])
    const owners = await amend('planner', order, { '52': 3 })
    expect(owners.workOrders).toEqual({ applied: [], waiting: [{ changeId: expect.any(String), workOrderId: workOrder.id, number: workOrder.number, words: { en: `${workOrder.number} is shared with other customers: change it on its own page.`, it: `${workOrder.number} è condiviso con altri clienti: cambialo dalla sua pagina.` } }] })
    expect(await quantityOf(cellOf(workOrder, '52').id)).toBe(4)
    const alphas = await amend('alphaPlanner', order, { '52': 2 })
    expect(alphas.workOrders).toEqual({ applied: [], waiting: [{ changeId: expect.any(String), workOrderId: null, number: null, words: { en: 'A work order waits: production applies the change on its own page.', it: 'Un ordine di lavoro è in attesa: la modifica la applica la produzione dalla sua pagina.' } }] })
    expect(JSON.stringify(alphas.workOrders)).not.toContain(workOrder.number)
    expect(await quantityOf(cellOf(workOrder, '52').id)).toBe(4)
    // A person limited to another customer reaches neither the order nor its work orders.
    expect((await refused('betaPlanner', 'POST', `/sales/orders/${order.orderId}/amendments`, { version: await orderVersion(order.orderId), reason: 'Made-up', lines: [{ id: order.lineId, sizes: [{ size: '52', quantity: 1 }] }] }, 404)).message).toBe('Sales order not found.')
  })

  it('MAKE_MORE makes a new DRAFT, never a released one; a refused make waits with its words and the amendment still lands (the runner)', async () => {
    const order = await salesOrder({ '52': 2 })
    const released = await workOrderFor(order, { '52': 2 }, true)
    const answer = await amend('sales', order, { '52': 4 })
    expect(answer.workOrders.waiting).toEqual([])
    expect(answer.workOrders.applied).toEqual([{ changeId: expect.any(String), workOrderId: expect.any(String), number: expect.any(String), route: 'NEW_DRAFT', reprint: false }])
    const made = answer.workOrders.applied[0]
    expect(await admin(`SELECT status::text AS status FROM "WorkOrder" WHERE id = $1`, [made.workOrderId])).toEqual([{ status: 'DRAFT' }])
    expect(await admin(`SELECT size, quantity FROM "WorkOrderSize" WHERE "workOrderId" = $1`, [made.workOrderId])).toEqual([{ size: '52', quantity: 2 }])
    expect(await admin(`SELECT status::text AS status FROM "WorkOrder" WHERE id = $1`, [released.id])).toEqual([{ status: 'RELEASED' }])
    expect(await quantityOf(cellOf(released, '52').id)).toBe(2)
    // No number series: the new DRAFT cannot be made — the command runs again without it, the change waits with the words.
    const other = await salesOrder({ '52': 2 })
    const otherReleased = await workOrderFor(other, { '52': 2 }, true)
    const closed = await admin<{ id: string }>(`SELECT id::text AS id FROM "NumberSeries" WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'WORK_ORDER' AND status = 'ACTIVE'`, [A.tenant, A.companyA])
    await force(`UPDATE "NumberSeries" SET status = 'CLOSED' WHERE id = ANY($1::uuid[])`, [closed.map((row) => row.id)])
    try {
      const refusedMake = await amend('sales', other, { '52': 3 })
      expect(refusedMake.amendment).toMatchObject({ revision: 1 })
      expect(refusedMake.workOrders).toEqual({ applied: [], waiting: [{ changeId: expect.any(String), workOrderId: null, number: null, words: { en: 'The new work order waits: it could not be made now — see why on the change, then apply it again.', it: 'Il nuovo ordine di lavoro è in attesa: non si è potuto fare ora — vedi il perché sulla modifica, poi applicala di nuovo.' } }] })
      expect(await changesOf(other.orderId)).toEqual([{ workOrderId: null, status: 'PROPOSED', lastError: expect.stringMatching(/no active work order number series/) }])
      expect(await quantityOf(cellOf(otherReleased, '52').id)).toBe(2)
    } finally {
      await force(`UPDATE "NumberSeries" SET status = 'ACTIVE' WHERE id = ANY($1::uuid[])`, [closed.map((row) => row.id)])
    }
  })

  it('Accept with the work orders following, then "Stop now" (B1): Accept\'s answer names what it applied — never applied twice; the hold lands on the changed work order, and an apply on it is refused in words', async () => {
    const order = await salesOrder({ '52': 4 })
    const workOrder = await workOrderFor(order, { '52': 4 }, true)
    const requestId = newId()
    await force(`INSERT INTO "OrderChangeRequest" (id, "tenantId", "companyId", "orderId", "partyId", kind, status, version, "createdAt") VALUES ($1, $2, $3, $4, $5, 'CHANGE', 'OPEN', 1, $6)`, [requestId, A.tenant, A.companyA, order.orderId, A.brand, new Date('2026-11-12T09:00:00.000Z')])
    await force(`INSERT INTO "OrderChangeRequestLine" (id, "tenantId", "partyId", "requestId", "orderLineId", size, "quantityBefore", quantity) VALUES ($1, $2, $3, $4, $5, '52', 4, 2)`, [newId(), A.tenant, A.brand, requestId, order.lineId])
    const accepted = await ok('planner', 'POST', `/sales/change-requests/${requestId}/accept`, { version: 1, answer: 'Made-up: two fewer, done.' })
    expect(accepted.workOrders).toMatchObject({ proposed: [{ kind: 'LOWER_TO_ORDER', workOrderId: workOrder.id }], applied: [{ workOrderId: workOrder.id, route: 'LOWER_RELEASED', reprint: true }], waiting: [] })
    expect(await quantityOf(cellOf(workOrder, '52').id)).toBe(2)
    const change = (await ok('planner', 'GET', `/production/work-order-changes/${accepted.workOrders.applied[0].changeId}`)).change
    expect(change).toMatchObject({ status: 'APPLIED', requestId })
    // The review window's "Stop now" after Accept: the work order goes on hold, already changed; applying again is refused.
    await force(`UPDATE "WorkOrder" SET status = 'ON_HOLD' WHERE id = $1`, [workOrder.id])
    expect((await refused('planner', 'POST', `/production/work-order-changes/${change.id}/apply`, { version: change.version }, 409)).issues[0].path).toBe('refusal/DECIDED')
    expect(await quantityOf(cellOf(workOrder, '52').id)).toBe(2)
    // A later change of the held work order waits for the hold to be lifted, in words.
    await force(`UPDATE "SalesOrderLineSize" SET quantity = 1 WHERE "lineId" = $1 AND size = '52'`, [order.lineId])
    const fresh = (await ok('planner', 'GET', `/production/work-orders/${workOrder.id}`)).workOrder
    const later = (await propose(lowering(order, fresh, '52', 1))).change
    const onHold = await refused('planner', 'POST', `/production/work-order-changes/${later.id}/apply`, { version: later.version }, 409)
    expect(onHold.issues).toEqual([{ path: 'refusal/ON_HOLD', message: `${workOrder.number} is on hold: lift the hold first, then apply the change.` }])
  })
})
// ── end B-OP-012 ──
