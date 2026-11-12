import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seed as seedSubcontract } from '../../../../../../packages/factory-db/seed/subcontract'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * MRP you can trust (B-W2b-306; PLN-072, PLN-073, PLN-076, PLN-078, PLN-083, PLN-095) on the local stack with the app's real
 * routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security, grants and the
 * …_planning_depth_w2b_guards triggers are real), the factory-db seeds up to production, numbering and subcontracting.
 * SEED-JKT-01's revision 1 is released here (by SQL), so SEED-SO-0001's black and red lines (2/4/2 and 1/2/1, for 18 Dec)
 * are proposed as planned work orders. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/planning/actions`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = 'mrp-trust-a'
const idOf = (key: string) => seedUuid(ns, key)
const A = {
  tenant: idOf('tenant'),
  actor: idOf('actor'),
  companyA: idOf('company:A'),
  siteA1: idOf('site:A1'),
  lineL1: idOf('site:A1:line:L1'),
  supplier: idOf('party:P2'),
  leather: idOf('product:item:leather'),
  leatherBLK: idOf('product:item-colour:leather:BLK'),
  jkt01: idOf('product:style:JKT-01'),
  jkt01Rev: idOf('product:revision:JKT-01:1'),
  so1: idOf('sales:SO1'),
  so1Blk: idOf('sales:SO1:line:10'),
  so1Red: idOf('sales:SO1:line:20'),
}

const PLAN: Permission[] = ['planning.view', 'planning.run', 'planning.decide', 'planning.firm', 'planning.planned.edit', 'planning.actions.manage']
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  planner: office([grant(PLAN)]),
  viewer: office([grant(['planning.view'])]),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const key = () => `mrp-trust-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown, idempotencyKey?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, idempotencyKey?: string): Promise<Json> {
  const response = await call(session, method, url, payload, idempotencyKey)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const runPlan = () => ok('planner', 'POST', '/planning/runs', { siteId: A.siteA1 }, 201)
const latest = () => ok('planner', 'GET', `/planning/runs/latest?siteId=${A.siteA1}`)
const planned = async () => (await ok('planner', 'GET', `/planning/planned-orders?siteId=${A.siteA1}`)).plannedOrders as Json[]
const ofLine = (rows: Json[], orderLineId: string): Json => {
  const row = rows.find((entry) => entry.demand.some((demand: Json) => demand.orderLineId === orderLineId))
  expect(row, `no planned order for ${orderLineId}`).toBeDefined()
  return row!
}
const messages = async (query = '') => ok('planner', 'GET', `/planning/action-messages?siteId=${A.siteA1}${query}`)
const today = () => businessDate(new Date(), 'Europe/Rome')

beforeAll(async () => {
  db = await migratedDatabase('mrp_trust')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  await seedSubcontract({ db: database, namespace: ns })
  // SEED-JKT-01 revision 1 released: SEED-SO-0001's lines are planned work (no work order makes them).
  await admin(`UPDATE "Style" SET status = 'ACTIVE' WHERE id = $1`, [A.jkt01])
  await admin(`UPDATE "StyleRevision" SET status = 'RELEASED', "releasedAt" = now(), "releasedById" = $2 WHERE id = $1`, [A.jkt01Rev, A.actor])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 480_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('MRP you can trust', { timeout: 120_000 }, () => {
  it('the run log: what the run read, its warnings and why each proposal exists (PLN-095)', async () => {
    const { run: first } = await runPlan()
    const log = await ok('planner', 'GET', `/planning/runs/${first.id}/log`)
    expect(log.run.id).toBe(first.id)
    expect(log.inputs).toMatchObject({ version: 1, runDate: today(), explosion: 'MULTI_LEVEL', previousRunId: null })
    expect(log.inputs.counts.orderLinesPlanned).toBe(first.orderLines)
    expect(log.inputs.counts.purchaseLines).toBeGreaterThan(0)
    expect(log.sentence).toContain(`of ${log.inputs.counts.orderLines} order line`)
    expect(log.proposals.requirements).toHaveLength(first.requirements)
    expect(log.proposals.requirements.every((row: Json) => row.reason.length > 20)).toBe(true)
    const make = (log.proposals.plannedOrders as Json[]).filter((row) => row.label.startsWith('SEED-JKT-01'))
    expect(make.length).toBeGreaterThanOrEqual(2)
    expect(make[0]!.reason).toMatch(/^Make \d+ SEED-JKT-01/)
    // A second run names the run it superseded.
    const { run: second } = await runPlan()
    expect((await ok('planner', 'GET', `/planning/runs/${second.id}/log`)).inputs.previousRunId).toBe(first.id)
    expect((await refused('planner', 'GET', `/planning/runs/${newId()}/log`, undefined, 404)).code).toBe('not_found')
  })

  it("a planner's edit is kept by the next run, the rest follows the plan; Reset to plan puts the plan back (PLN-076)", async () => {
    const rows = await planned()
    const blk = ofLine(rows, A.so1Blk)
    const red = ofLine(rows, A.so1Red)
    expect([blk.protectedFields, blk.may.edit, blk.late]).toEqual([[], true, null])
    const later = plusDays(blk.dueDate, 3)
    const edited = await ok('planner', 'PATCH', `/planning/planned-orders/${blk.id}`, { version: blk.version, dueDate: later }, 200, key())
    expect([edited.protectedNow, edited.plannedOrder.dueDate]).toEqual([['dueDate'], later])
    const onLine = await ok('planner', 'PATCH', `/planning/planned-orders/${red.id}`, { version: red.version, lineId: A.lineL1 })
    expect(onLine.plannedOrder.protectedFields).toEqual(['lineId'])
    // A field NOT protected that drifted (here by SQL) is the plan's again after the run.
    await admin(`UPDATE "PlannedWorkOrder" SET "startDate" = "dueDate" WHERE id = $1`, [red.id])
    const { run: next } = await runPlan()
    const after = await planned()
    const blk2 = after.find((row) => row.id === blk.id)!
    const red2 = after.find((row) => row.id === red.id)!
    expect([blk2.runId, blk2.dueDate, blk2.protectedFields, blk2.plan]).toEqual([next.id, later, ['dueDate'], { dueDate: blk.dueDate }])
    expect([red2.runId, red2.line?.id, red2.startDate, red2.dueDate, red2.protectedFields]).toEqual([next.id, A.lineL1, red.startDate, red.dueDate, ['lineId']])
    // The plan says what it would do with the protected due date.
    const list = await messages('&recordType=PlannedWorkOrder')
    const expedite = (list.messages as Json[]).find((row) => row.record.id === blk.id && row.action === 'EXPEDITE')
    expect(expedite).toMatchObject({ fromDate: later, toDate: blk.dueDate, status: 'OPEN', may: { decide: true } })
    expect(expedite!.message).toContain('you protected its due date')
    // Reset to plan: the plan's value comes back at once.
    const reset = await ok('planner', 'POST', `/planning/planned-orders/${blk.id}/reset`, { version: blk2.version })
    expect([reset.reset, reset.restored, reset.plannedOrder.dueDate, reset.plannedOrder.protectedFields]).toEqual([['dueDate'], true, blk.dueDate, []])
    expect((await refused('planner', 'POST', `/planning/planned-orders/${blk.id}/reset`, { version: reset.plannedOrder.version }, 409)).message).toContain('Nothing of it is protected')
    // Refusals: before today, the start after the due date, a stale version, no permission.
    const past = await refused('planner', 'PATCH', `/planning/planned-orders/${blk.id}`, { version: reset.plannedOrder.version, startDate: plusDays(today(), -1) }, 400)
    expect(past.message).toContain('Nothing is planned before today')
    expect((await refused('planner', 'PATCH', `/planning/planned-orders/${blk.id}`, { version: reset.plannedOrder.version, startDate: plusDays(blk.dueDate, 1) }, 400)).message).toContain('after it is due')
    await refused('planner', 'PATCH', `/planning/planned-orders/${blk.id}`, { version: 1, dueDate: later }, 409)
    await refused('viewer', 'PATCH', `/planning/planned-orders/${blk.id}`, { version: reset.plannedOrder.version, dueDate: later }, 403)
    const audit = await admin<{ n: string }>(`SELECT count(*)::text AS n FROM "AuditLog" WHERE "recordId" = $1 AND action IN ('planning.plannedOrders.edit', 'planning.plannedOrders.reset')`, [blk.id])
    expect(audit[0]!.n).toBe('2')
  })

  it('bulk edit with one review: a preview writes nothing; all or nothing (PLN-078)', async () => {
    const rows = await planned()
    const blk = ofLine(rows, A.so1Blk)
    const red = ofLine(rows, A.so1Red)
    const body = { siteId: A.siteA1, shiftDays: 2, rows: [blk, red].map((row) => ({ id: row.id, version: row.version })) }
    const preview = await ok('planner', 'POST', '/planning/planned-orders/bulk', { ...body, preview: true })
    expect([preview.preview, preview.changed]).toEqual([true, 2])
    expect(preview.rows[0].changes).toEqual([
      { field: 'startDate', from: blk.startDate, to: plusDays(blk.startDate, 2) },
      { field: 'dueDate', from: blk.dueDate, to: plusDays(blk.dueDate, 2) },
    ])
    expect((await planned()).find((row) => row.id === blk.id)!.version).toBe(blk.version)
    // One stale row: nothing is written, every problem said.
    const stale = await refused('planner', 'POST', '/planning/planned-orders/bulk', { ...body, rows: [{ id: blk.id, version: blk.version }, { id: red.id, version: red.version + 5 }] }, 400)
    expect(stale.message).toContain('changed since you read it')
    expect((await planned()).find((row) => row.id === blk.id)!.dueDate).toBe(blk.dueDate)
    const applied = await ok('planner', 'POST', '/planning/planned-orders/bulk', body, 200, key())
    expect([applied.preview, applied.changed]).toEqual([false, 2])
    const blkAfter = applied.rows.find((row: Json) => row.id === blk.id).plannedOrder
    const redAfter = applied.rows.find((row: Json) => row.id === red.id).plannedOrder
    expect([blkAfter.dueDate, blkAfter.protectedFields]).toEqual([plusDays(blk.dueDate, 2), ['startDate', 'dueDate']])
    expect(redAfter.protectedFields).toEqual(['startDate', 'dueDate', 'lineId'])
    // Back to the plan for what follows.
    await ok('planner', 'POST', `/planning/planned-orders/${blk.id}/reset`, { version: blkAfter.version })
    await ok('planner', 'POST', `/planning/planned-orders/${red.id}/reset`, { version: redAfter.version })
  })

  it('nothing planned before today: late demand starts today, with a LATE warning (PLN-083)', async () => {
    const past = plusDays(today(), -3)
    await admin(`UPDATE "SalesOrder" SET "promiseDate" = $2 WHERE id = $1`, [A.so1, past])
    try {
      const { run: late } = await runPlan()
      const warnings = (late.warnings as Json[]).filter((warning) => warning.code === 'LATE')
      const mine = warnings.filter((warning) => warning.orderLineId === A.so1Blk || warning.orderLineId === A.so1Red)
      expect(mine.map((warning) => warning.orderLineId).sort()).toEqual([A.so1Blk, A.so1Red].sort())
      expect(mine[0]!.message).toContain('3 days ago')
      const rows = (await planned()).filter((row) => row.demand.some((demand: Json) => demand.orderId === A.so1))
      expect(rows.length).toBeGreaterThanOrEqual(2)
      for (const row of rows) {
        expect(row.startDate >= today() && row.dueDate >= today(), `${row.startDate} ${row.dueDate}`).toBe(true)
        expect(row.late).toMatchObject({ needDate: past })
        expect(row.late.daysLate).toBeGreaterThanOrEqual(3)
        expect(row.late.reason).toContain(`needs it on ${past}`)
      }
      const plan = await latest()
      expect((plan.lines as Json[]).every((line) => line.planned.date >= today())).toBe(true)
      expect((plan.lines as Json[]).some((line) => line.planned.daysLate === 3)).toBe(true)
      const log = await ok('planner', 'GET', `/planning/runs/${late.id}/log`)
      expect(log.inputs.counts.lateOrderLines).toBe(warnings.length)
      expect(log.warningCounts).toContainEqual({ code: 'LATE', count: warnings.length })
    } finally {
      await admin(`UPDATE "SalesOrder" SET "promiseDate" = '2026-12-18' WHERE id = $1`, [A.so1])
    }
  })

  it('order-specific supply: a material kept for one order line is a line of its own from the next run (PLN-072)', async () => {
    await runPlan()
    const plan = await latest()
    const shared = (plan.lines as Json[]).find((line) => line.sources.some((source: Json) => source.orderLineId === A.so1Blk) && line.sources.some((source: Json) => source.orderLineId === A.so1Red))
    expect(shared, 'a material both SO-0001 lines need').toBeDefined()
    expect(shared!.orderSpecific).toBeNull()
    const pegged = await ok('planner', 'POST', `/planning/requirements/${shared!.id}/order-specific`, { version: shared!.version, orderLineId: A.so1Red }, 200, key())
    expect(pegged.line.orderSpecific).toMatchObject({ orderLineId: A.so1Red, orderNumber: 'SEED-SO-0001' })
    expect(pegged.words).toContain('line of its own')
    expect((await refused('planner', 'POST', `/planning/requirements/${shared!.id}/order-specific`, { version: pegged.line.version, orderLineId: A.so1Red }, 409)).message).toContain('already')
    expect((await refused('planner', 'POST', `/planning/requirements/${shared!.id}/order-specific`, { version: pegged.line.version, orderLineId: newId() }, 409)).message).toContain('does not need')
    await refused('viewer', 'POST', `/planning/requirements/${shared!.id}/order-specific`, { version: pegged.line.version, orderLineId: null }, 403)
    await runPlan()
    const split = ((await latest()).lines as Json[]).filter((line) => line.item.id === shared!.item.id && (line.colour?.id ?? null) === (shared!.colour?.id ?? null))
    expect(split).toHaveLength(2)
    const own = split.find((line) => line.orderSpecific !== null)!
    const rest = split.find((line) => line.orderSpecific === null)!
    expect(own.orderSpecific.orderLineId).toBe(A.so1Red)
    expect(own.sources.every((source: Json) => source.orderLineId === A.so1Red)).toBe(true)
    expect(rest.sources.some((source: Json) => source.orderLineId === A.so1Red)).toBe(false)
    // Its own stock only: nothing reserved for it, so no free stock is counted.
    expect(own.usableStock).toBe('0.0000')
    const stored = await admin<{ orderSpecific: boolean; reservedForPartyId: string | null }>(`SELECT "orderSpecific", "reservedForPartyId" FROM "MaterialRequirement" WHERE id = $1`, [own.id])
    expect(stored[0]!.orderSpecific).toBe(true)
    expect(stored[0]!.reservedForPartyId).not.toBeNull()
    // For every order again: the next run has one line.
    await ok('planner', 'POST', `/planning/requirements/${own.id}/order-specific`, { version: own.version, orderLineId: null })
    await runPlan()
    expect(((await latest()).lines as Json[]).filter((line) => line.item.id === shared!.item.id && (line.colour?.id ?? null) === (shared!.colour?.id ?? null))).toHaveLength(1)
  })

  it('action messages on existing orders: in words, done or ignored; an ignored one is not raised again (PLN-073)', async () => {
    // A draft purchase line of far more black leather than the orders need.
    const orderId = newId()
    const lineId = newId()
    await admin(`INSERT INTO "PurchaseOrder" (id, "tenantId", "companyId", "siteId", number, "partyId", "orderDate") VALUES ($1, $2, $3, $4, 'TRUST-PO-1', $5, '2026-10-29')`, [orderId, A.tenant, A.companyA, A.siteA1, A.supplier])
    await admin(
      `INSERT INTO "PurchaseOrderLine" (id, "tenantId", "purchaseOrderId", "partyId", "siteId", seq, "itemId", "itemColourId", quantity, uom, "baseQuantity", "unitPrice", "netAmount", "needDate", "requiresCrViTest")
       VALUES ($1, $2, $3, $4, $5, 10, $6, $7, 90000, 'FT2', 90000, '0', 0, $8, true)`,
      [lineId, A.tenant, orderId, A.supplier, A.siteA1, A.leather, A.leatherBLK, plusDays(today(), 1)],
    )
    const { run: raised } = await runPlan()
    const list = await messages()
    expect(list.run.id).toBe(raised.id)
    expect(list.counts.open).toBe(list.messages.length)
    // Partly needed: a decrease; not needed at all (an earlier line covers the orders): a cancel.
    const decrease = (list.messages as Json[]).find((row) => row.record.id === lineId && (row.action === 'DECREASE' || row.action === 'CANCEL'))
    expect(decrease).toMatchObject({ record: { type: 'PurchaseOrderLine', label: 'TRUST-PO-1 line 10', open: { type: 'PurchaseOrder', id: orderId } }, fromQuantity: '90000.0000', uom: 'FT2', status: 'OPEN' })
    if (decrease!.action === 'DECREASE') expect(Number(decrease!.toQuantity)).toBeLessThan(90000)
    expect(decrease!.message).toMatch(/^(Decrease|Cancel) TRUST-PO-1 line 10/)
    expect(JSON.stringify(decrease!.facts)).not.toMatch(/price|cost|amount/i)
    // Ignore it with a note; refusals: twice, and without the permission.
    const ignored = await ok('planner', 'POST', '/planning/action-messages/decide', { messages: [{ id: decrease!.id, version: decrease!.version }], status: 'IGNORED', note: 'Agreed with the tannery.' }, 200, key())
    expect(ignored.messages[0]).toMatchObject({ status: 'IGNORED', decisionNote: 'Agreed with the tannery.', may: { decide: false } })
    expect((await refused('planner', 'POST', '/planning/action-messages/decide', { messages: [{ id: decrease!.id, version: ignored.messages[0].version }], status: 'DONE' }, 409)).message).toContain('ignored already')
    const other = (list.messages as Json[]).find((row) => row.id !== decrease!.id)
    if (other) {
      await refused('viewer', 'POST', '/planning/action-messages/decide', { messages: [{ id: other.id, version: other.version }], status: 'DONE' }, 403)
      const done = await ok('planner', 'POST', '/planning/action-messages/decide', { messages: [{ id: other.id, version: other.version }], status: 'DONE' })
      expect(done.messages[0].status).toBe('DONE')
    }
    // The next run asks the same: not raised again; an OPEN message of the superseded run is not decided any more.
    const stillOpen = (list.messages as Json[]).find((row) => row.status === 'OPEN' && row.id !== decrease!.id && row.id !== other?.id)
    const { run: again } = await runPlan()
    const next = await messages('&status=OPEN,DONE,IGNORED')
    expect(next.run.id).toBe(again.id)
    expect((next.messages as Json[]).some((row) => row.record.id === lineId && row.action === decrease!.action)).toBe(false)
    if (stillOpen) expect((await refused('planner', 'POST', '/planning/action-messages/decide', { messages: [{ id: stillOpen.id, version: stillOpen.version }], status: 'DONE' }, 409)).message).toContain('newer plan')
    const events = await admin<{ type: string; n: string }>(`SELECT type, count(*)::text AS n FROM "OutboxEvent" WHERE type IN ('mrp_action_messages.raised', 'mrp_action_messages.decided', 'planned_work_orders.edited', 'material_requirement.pegged') GROUP BY type ORDER BY type`)
    expect(events.map((row) => row.type)).toEqual(['material_requirement.pegged', 'mrp_action_messages.decided', 'mrp_action_messages.raised', 'planned_work_orders.edited'])
  })
})
