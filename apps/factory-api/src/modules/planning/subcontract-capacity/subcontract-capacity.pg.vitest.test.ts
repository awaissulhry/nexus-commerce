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
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPlanningDepth, type PlanningDepthSeed } from '../../../../../../packages/factory-db/seed/planning-depth'
import { seed as seedProduction, type ProductionSeed } from '../../../../../../packages/factory-db/seed/production'
import { seed as seedSubcontract, type SubcontractSeed } from '../../../../../../packages/factory-db/seed/subcontract'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * Work to subcontractors (B-W2b-321; PLN-117, PLN-124, PLN-162, PLN-164, PLN-165) on the local stack with the app's real
 * routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security, grants and the
 * planning-depth guards are real), the factory-db seeds up to production, numbering, subcontracting and planning depth
 * (P2's 2,400 sewing minutes and 60 garments a week; SEED-SC-0001's sewing of WO-0001 at P2; a planned subcontract order
 * at P2). P2's qualifications are written as the owner with the guards off (a decided qualification needs evidence files
 * this test does not upload: B-W2b-315's own test covers that path). Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/planning/subcontract-capacity`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let production: ProductionSeed
let subcontract: SubcontractSeed
let depth: PlanningDepthSeed

const ns = 'subcap-a'
const idOf = (key: string) => seedUuid(ns, key)
const A = { tenant: idOf('tenant'), companyA: idOf('company:A'), siteA1: idOf('site:A1'), P2: idOf('party:P2') }

const VIEW: Permission[] = ['planning.view', 'workorders.view']
const PLAN: Permission[] = [...VIEW, 'planning.subcontract.capacity', 'planning.subcontract.outsource', 'planning.schedule.manage']
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  viewer: office([grant(VIEW)]),
  planner: office([grant(PLAN)]),
  // The planner who also drafts subcontract orders (a buyer's permission).
  maker: office([grant([...PLAN, 'purchasing.view', 'purchasing.subcontract.manage', 'inventory.stock.view'])]),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const key = () => `subcap-test-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const refusalCodes = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => issue.path).filter((path: string) => path.startsWith('refusal/'))

/** P2 qualified for kinds of work in company A (written as the owner, the guards off: see above). */
async function qualify(kinds: string[]): Promise<void> {
  const ids = kinds.map(() => newId())
  const values = kinds.map((kind, index) => `('${ids[index]}', '${A.tenant}', '${A.companyA}', '${A.P2}', '{${kind}}'::"WorkCentreKind"[], 'APPROVED', DATE '2026-01-01', '[{"recordType": "StoredFile", "recordId": "${newId()}"}]'::jsonb, now() - interval '1 hour', now(), now())`).join(', ')
  await db.admin.query(`SET session_replication_role = replica; INSERT INTO "SupplierQualification" (id, "tenantId", "companyId", "partyId", "workCentreKinds", status, "validFrom", evidence, "decidedAt", "createdAt", "updatedAt") VALUES ${values}; SET session_replication_role = origin;`)
}

const workOrder = () => ok('planner', 'GET', `/planning/work-orders/${production.workOrderId}/workshops`)
const operationOf = async (id: string): Promise<Json> => (await admin(`SELECT id, version, outsourced, "subcontractOrderId" FROM "WorkOrderOperation" WHERE id = $1`, [id]))[0]!

beforeAll(async () => {
  db = await migratedDatabase('subcontract_capacity')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  production = await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  subcontract = await seedSubcontract({ db: database, namespace: ns })
  depth = await seedPlanningDepth({ db: database, namespace: ns })
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

describe('a workshop’s weekly capacity (PLN-124) and the heatmap (PLN-117)', () => {
  it('lists, adds, changes and removes capacity rows; refuses an overlap, another unit, a stale version and a reader', async () => {
    const list = await ok('viewer', 'GET', `/planning/subcontract-capacity?siteId=${A.siteA1}`)
    const rows = list.rows.filter((row: Json) => row.workshop.id === A.P2)
    expect(rows.map((row: Json) => `${row.workCentreKind ?? '*'} ${row.unit} ${row.perWeek}`).sort()).toEqual(['* PIECES 60', 'SEWING MINUTES 2400'])
    expect(list.workshops.find((workshop: Json) => workshop.id === A.P2).may.create).toBe(false)
    expect(rows.find((row: Json) => row.workCentreKind === 'SEWING').words).toBe('2,400 minutes a week for sewing')
    const overlap = await refused('planner', 'POST', '/planning/subcontract-capacity', { partyId: A.P2, workCentreKind: 'SEWING', unit: 'MINUTES', perWeek: 3000, validFrom: '2027-01-01' }, 409)
    expect(overlap.message).toMatch(/overlaps the capacity for sewing from 2026-11-01/)
    const unit = await refused('planner', 'POST', '/planning/subcontract-capacity', { partyId: A.P2, workCentreKind: 'SEWING', unit: 'PIECES', perWeek: 30, validFrom: '2027-01-01' }, 409)
    expect(unit.issues[0].path).toBe('body/unit')
    await refused('viewer', 'POST', '/planning/subcontract-capacity', { partyId: A.P2, workCentreKind: 'FINISHING', unit: 'MINUTES', perWeek: 1200, validFrom: '2026-11-01' }, 403)
    await refused('planner', 'POST', '/planning/subcontract-capacity', { partyId: production.workOrderId, unit: 'MINUTES', perWeek: 1200, validFrom: '2026-11-01' }, 404)
    const made = (await ok('planner', 'POST', '/planning/subcontract-capacity', { partyId: A.P2, workCentreKind: 'FINISHING', unit: 'MINUTES', perWeek: 1200, validFrom: '2026-11-01', note: 'Made-up' }, 201)).row
    expect(made).toMatchObject({ workCentreKind: 'FINISHING', perWeek: 1200, validTo: null, version: 1, may: { change: true } })
    await refused('planner', 'PATCH', `/planning/subcontract-capacity/${made.id}`, { version: 9, perWeek: 1000 }, 409)
    const edited = (await ok('planner', 'PATCH', `/planning/subcontract-capacity/${made.id}`, { version: made.version, perWeek: 1000, validTo: '2026-12-31' })).row
    expect(edited).toMatchObject({ perWeek: 1000, validTo: '2026-12-31', version: 2 })
    await ok('planner', 'DELETE', `/planning/subcontract-capacity/${made.id}?version=${edited.version}`)
    const audits = await admin(`SELECT action FROM "AuditLog" WHERE "recordId" = $1 AND action LIKE 'planning.subcontractCapacity.%' ORDER BY at, id`, [made.id])
    expect(audits.map((row) => row.action)).toEqual(['planning.subcontractCapacity.create', 'planning.subcontractCapacity.edit', 'planning.subcontractCapacity.delete'])
    const events = await admin(`SELECT payload->>'change' AS change FROM "OutboxEvent" WHERE type = 'subcontractor_capacity.changed' AND subject = $1 ORDER BY "occurredAt", id`, [made.id])
    expect(events.map((row) => row.change)).toEqual(['CREATED', 'EDITED', 'DELETED'])
  })

  it('shows the workshop rows on Capacity & load with the work behind a cell, and the heatmap with a number in every cell', async () => {
    const answer = await ok('viewer', 'GET', `/planning/capacity/subcontractors?siteId=${A.siteA1}&from=2026-11-16&to=2026-12-13&bucket=WEEK`)
    const sewing = answer.lanes.find((lane: Json) => lane.id === A.P2 && lane.workCentreKind === 'SEWING')
    const garments = answer.lanes.find((lane: Json) => lane.id === A.P2 && lane.workCentreKind === null)
    expect([sewing.unit, garments.unit]).toEqual(['MINUTES', 'PIECES'])
    expect(sewing.cells).toHaveLength(4)
    // A week of five open weekdays has the whole capacity; SEED-SC-0001's sewing books minutes, the planned order proposes more.
    expect(sewing.cells[1].available).toBe('2400.0')
    const booked = sewing.cells.reduce((sum: number, cell: Json) => sum + Number(cell.booked), 0)
    const proposed = sewing.cells.reduce((sum: number, cell: Json) => sum + Number(cell.proposed), 0)
    expect(booked).toBeGreaterThan(0)
    expect(proposed).toBeGreaterThan(0)
    expect(sewing.cells.find((cell: Json) => Number(cell.booked) > 0).loadPct).not.toBeNull()
    expect(answer.tiles).toHaveProperty('subcontractorsOverThisWeek')
    const busy = sewing.cells.find((cell: Json) => Number(cell.booked) > 0 || Number(cell.proposed) > 0)
    const detail = await ok('viewer', 'GET', `/planning/capacity/subcontractors/cell?siteId=${A.siteA1}&partyId=${A.P2}&workCentreKind=SEWING&from=2026-11-16&to=2026-12-13`)
    expect(detail.jobs.map((job: Json) => job.kind)).toEqual(expect.arrayContaining(['ORDER', 'PLANNED']))
    expect(detail.jobs.find((job: Json) => job.kind === 'ORDER')).toMatchObject({ id: subcontract.orderId, number: 'SEED-SC-0001', proposed: false })
    expect(detail.jobs.find((job: Json) => job.kind === 'PLANNED')).toMatchObject({ id: depth.plannedWorkOrderIds.subcontract, proposed: true })
    expect(busy).toBeDefined()
    const heat = await ok('viewer', 'GET', `/planning/heatmap?siteId=${A.siteA1}&from=2026-11-18&weeks=4`)
    expect(heat.from).toBe('2026-11-16')
    expect(heat.weeks).toHaveLength(4)
    expect(heat.legend.map((entry: Json) => entry.band)).toEqual(['LOW', 'MEDIUM', 'HIGH', 'OVER', 'UNKNOWN'])
    expect(new Set(heat.lanes.map((lane: Json) => lane.kind))).toEqual(new Set(['LINE', 'WORK_CENTRE', 'WORKSHOP']))
    for (const lane of heat.lanes) for (const cell of lane.cells) expect(cell.text).toBe(cell.loadPct === null ? '—' : `${Math.round(Number(cell.loadPct))}%`)
    await refused('viewer', 'GET', `/planning/heatmap?siteId=${A.siteA1}&weeks=27`, undefined, 400)
  })
})

describe('only approved workshops (PLN-162), kit timing (PLN-164), in-house or outside (PLN-165)', () => {
  it('holds a workshop not approved for the work, with the reason; offers it once it is', async () => {
    // Not said to be a subcontractor yet (its supplier kinds): the DURC is not checked.
    await admin(`UPDATE "Party" SET "supplierKinds" = '{}' WHERE id = $1`, [A.P2])
    const before = await ok('viewer', 'GET', `/planning/allocation/workshops?siteId=${A.siteA1}`)
    const p2 = before.workshops.find((workshop: Json) => workshop.id === A.P2)
    expect(p2.durc).toEqual({ checked: false, state: 'MISSING', expiresOn: null })
    expect(p2.qualifications.find((entry: Json) => entry.workCentreKind === 'SEWING')).toMatchObject({ qualified: false, standing: 'NONE' })
    const card = before.workOrders.find((entry: Json) => entry.workOrder.id === production.workOrderId)
    expect(card.operations.map((operation: Json) => operation.workCentreKind)).toEqual(['SEWING'])
    const verdict = card.workshops.find((entry: Json) => entry.partyId === A.P2)
    expect(verdict.offered).toBe(false)
    expect(verdict.held.map((reason: Json) => reason.code)).toEqual(['NOT_QUALIFIED'])
    expect(verdict.held[0].words).toMatch(/^Not approved for sewing \(Op 20 .+\): not qualified for this work: no qualification covers it\.$/)
    expect(verdict.warnings.map((warning: Json) => warning.code)).toContain('DURC_NOT_CHECKED')
    await qualify(['SEWING', 'INSPECTION'])
    const after = await workOrder()
    expect(after.workshops.find((entry: Json) => entry.id === A.P2)).toMatchObject({ offered: true, held: [], routing: false })
    // Said to be a subcontractor: the DURC is asked, and none is on file.
    await admin(`UPDATE "Party" SET "supplierKinds" = '{SUBCONTRACTOR}' WHERE id = $1`, [A.P2])
    const durc = (await workOrder()).workshops.find((entry: Json) => entry.id === A.P2)
    expect(durc.offered).toBe(false)
    expect(durc.held.map((reason: Json) => reason.code)).toEqual(['NO_VALID_DURC'])
    await admin(`UPDATE "Party" SET "supplierKinds" = '{}' WHERE id = $1`, [A.P2])
  })

  it('times the kit: two transport days before the start on our working days, the goods back after the work, the kit list', async () => {
    const timing = await ok('viewer', 'GET', `/planning/work-orders/${production.workOrderId}/kit-timing?partyId=${A.P2}&operationIds=${production.operationIds.qc}&start=2026-12-02`)
    expect(timing).toMatchObject({ start: '2026-12-02', startSource: 'GIVEN', workshop: { id: A.P2 }, operations: [{ id: production.operationIds.qc }] })
    expect(timing.kitShipOn < timing.start).toBe(true)
    expect(timing.backOn >= timing.start).toBe(true)
    expect(timing.words).toMatch(/^Send the kit on \d{4}-\d{2}-\d{2}: \d+ transport days? before the work starts at .+ on 2026-12-02\.$/)
    expect(Array.isArray(timing.kit.lines)).toBe(true)
    expect(timing.laterOperations.map((operation: Json) => operation.id)).toEqual([production.operationIds.pack])
    const late = await ok('viewer', 'GET', `/planning/work-orders/${production.workOrderId}/kit-timing?partyId=${A.P2}&operationIds=${production.operationIds.qc}&start=2026-01-07`)
    expect(late.late).toBe(true)
    await refused('viewer', 'GET', `/planning/work-orders/${production.workOrderId}/kit-timing?partyId=${A.P2}&operationIds=${newId()}`, undefined, 400)
  })

  it('sends one operation outside and back in: without an order, then with its draft subcontract order cancelled again', async () => {
    const qc = production.operationIds.qc
    const url = (what: string) => `/planning/work-orders/${production.workOrderId}/operations/${qc}/${what}`
    let operation = await operationOf(qc)
    // Not approved for packing: refused with the reason.
    const pack = await refused('planner', 'POST', `/planning/work-orders/${production.workOrderId}/operations/${production.operationIds.pack}/outside`, { version: (await operationOf(production.operationIds.pack)).version, partyId: A.P2 }, 409)
    expect(refusalCodes(pack)).toEqual(['refusal/NOT_QUALIFIED'])
    await refused('viewer', 'POST', url('outside'), { version: operation.version, partyId: A.P2 }, 403)
    // A planner without the subcontracting permission: outside, no order yet.
    const out = await ok('planner', 'POST', url('outside'), { version: operation.version, partyId: A.P2 })
    expect(out).toMatchObject({ operation: { id: qc, outsourced: true, subcontractOrderId: null }, order: null })
    expect(out.orderWords).toMatch(/purchasing\.subcontract\.manage/)
    operation = await operationOf(qc)
    await refused('planner', 'POST', url('outside'), { version: operation.version, partyId: A.P2 }, 409)
    await refused('planner', 'POST', url('in-house'), { version: operation.version + 5, reason: 'Back in' }, 409)
    const back = await ok('planner', 'POST', url('in-house'), { version: operation.version, reason: 'Our QC bench is free' })
    expect(back).toMatchObject({ operation: { outsourced: false, subcontractOrderId: null }, order: null })
    // With the subcontracting permission: the DRAFT order for 3 garments, its kit time set.
    operation = await operationOf(qc)
    const sent = await ok('maker', 'POST', url('outside'), { version: operation.version, partyId: A.P2, pieces: 3, start: '2026-12-02' })
    expect(sent.order).toMatchObject({ status: 'DRAFT' })
    expect(sent.operation).toMatchObject({ outsourced: true, subcontractOrderId: sent.order.id })
    const order = (await admin(`SELECT status, "kitDueAt", version FROM "SubcontractOrder" WHERE id = $1`, [sent.order.id]))[0]!
    expect(order.kitDueAt).not.toBeNull()
    const pieces = (await admin(`SELECT pieces FROM "SubcontractOperation" WHERE "subcontractOrderId" = $1`, [sent.order.id])).map((row) => row.pieces)
    expect(pieces).toEqual([3])
    // The kit's time, a term of the draft.
    await refused('maker', 'PUT', `/planning/subcontract-orders/${sent.order.id}/kit-due`, { version: order.version + 3, kitDueAt: '2026-12-01T07:00:00.000Z' }, 409)
    const timed = await ok('maker', 'PUT', `/planning/subcontract-orders/${sent.order.id}/kit-due`, { version: order.version, kitDueAt: '2026-12-01T07:00:00.000Z' })
    expect(timed.order).toMatchObject({ kitDueAt: '2026-12-01T07:00:00.000Z', version: order.version + 1 })
    const event = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'work_order_operation.outsourced' AND subject = $1 ORDER BY "occurredAt", id`, [qc])
    expect(event.map((row) => row.payload.outsourced)).toEqual([true, false, true])
    // Back in: the order carried only this operation, so it is cancelled.
    operation = await operationOf(qc)
    const home = await ok('maker', 'POST', url('in-house'), { version: operation.version, reason: 'The workshop is full' })
    expect(home).toMatchObject({ operation: { outsourced: false }, order: { id: sent.order.id, change: 'CANCELLED' } })
    expect((await admin(`SELECT status FROM "SubcontractOrder" WHERE id = $1`, [sent.order.id]))[0]!.status).toBe('CANCELLED')
  })

  it('creates the subcontract order of a workshop part on the allocation board (preview first)', async () => {
    // SEED-SC-0001 carries every garment of WO-0001's sewing: cancelled first, so the part is free to order.
    const seeded = (await ok('maker', 'GET', `/purchasing/subcontracting/orders/${subcontract.orderId}`)).order
    await ok('maker', 'POST', `/purchasing/subcontracting/orders/${subcontract.orderId}/cancel`, { version: seeded.version, reason: 'Made-up test' })
    const board = await ok('planner', 'GET', `/planning/allocation?siteId=${A.siteA1}`)
    const card = board.cards.find((entry: Json) => entry.workOrder.id === production.workOrderId)
    const placed = await ok('planner', 'PUT', `/planning/allocation/work-orders/${production.workOrderId}`, { version: card.workOrder.version, lineId: card.lane?.id ?? null, parts: [{ lane: { kind: 'WORKSHOP', id: A.P2 }, pieces: 4 }] })
    const slot = placed.cards.find((entry: Json) => entry.lane?.kind === 'WORKSHOP').slot
    const preview = await ok('maker', 'POST', '/planning/allocation/subcontract-orders', { siteId: A.siteA1, parts: [{ slotId: slot.id }, { slotId: newId() }], preview: true })
    expect(preview).toMatchObject({ preview: true, made: 0, held: 1 })
    expect(preview.results[0]).toMatchObject({ ok: true, pieces: 4, workshop: { id: A.P2 }, operations: [{ id: production.operationIds.sew }] })
    expect(preview.results[1].problems[0]).toMatch(/Not a part of a work order at a workshop/)
    const made = await ok('maker', 'POST', '/planning/allocation/subcontract-orders', { siteId: A.siteA1, parts: [{ slotId: slot.id }] })
    expect(made).toMatchObject({ preview: false, made: 1, held: 0 })
    const orderId = made.results[0].order.id
    expect((await operationOf(production.operationIds.sew)).subcontractOrderId).toBe(orderId)
    // Made once: the garments are on an order now.
    const again = await ok('maker', 'POST', '/planning/allocation/subcontract-orders', { siteId: A.siteA1, parts: [{ slotId: slot.id }], preview: true })
    expect(again.results[0].problems[0]).toMatch(/on a subcontract order already/)
  })
})
