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
import { seed as seedOptions, type OptionsSeed } from '../../../../../../packages/factory-db/seed/options'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seed as seedSubcontract } from '../../../../../../packages/factory-db/seed/subcontract'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * Planned work orders and planned subcontract orders (B-W2b-293; PLN-067, PLN-068, PLN-069, PLN-079, PLN-089; MR1:01,
 * MR1:02) on the local stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the
 * runtime login: row-level security, grants and the …_planning_depth_w2b_guards triggers are real), the factory-db seeds
 * up to production, numbering, subcontracting and the options library. Before SEED-JKT-01's revision is released here,
 * it gets the options seed's removable liner as a sub-assembly (SEED-LNR-01: grey lining and wadding) and its sewing step
 * goes to the workshop P2 (5 days away); SEED-SO-0001's black line chooses the name on the chest (5 m of contrast thread,
 * 4.5 m in 50, 5.5 m in 54). Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/planning/planned-orders`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let options: OptionsSeed

const ns = 'planned-a'
const idOf = (key: string) => seedUuid(ns, key)
const A = {
  tenant: idOf('tenant'),
  actor: idOf('actor'),
  companyA: idOf('company:A'),
  siteA1: idOf('site:A1'),
  workshop: idOf('party:P2'),
  jkt01: idOf('product:style:JKT-01'),
  jkt01Rev: idOf('product:revision:JKT-01:1'),
  so1Blk: idOf('sales:SO1:line:10'),
  so1Red: idOf('sales:SO1:line:20'),
  sewing: idOf('product:routing:JKT-01:1:SEED-SEW-ASM'),
}

const PLAN: Permission[] = ['planning.view', 'planning.run', 'planning.firm', 'planning.planned.convert', 'workorders.view', 'workorders.manage']
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  planner: office([grant(PLAN)]),
  // The planner who also releases and drafts subcontract orders (a buyer's permission).
  maker: office([grant([...PLAN, 'workorders.release', 'purchasing.view', 'purchasing.subcontract.manage', 'inventory.stock.view'])]),
  noWorkOrders: office([grant(['planning.view', 'planning.run', 'planning.planned.convert'])]),
  viewer: office([grant(['planning.view'])]),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const key = () => `planned-test-${run}-${++keys}`
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
const planned = async (query = '') => ok('planner', 'GET', `/planning/planned-orders?siteId=${A.siteA1}${query}`)
const lineOf = (plan: Json, itemId: string): Json | undefined => (plan.lines as Json[]).find((entry) => entry.item.id === itemId)
const ofLine = (rows: Json[], orderLineId: string): any[] => rows.filter((row) => row.demand.some((entry: Json) => entry.orderLineId === orderLineId))
const sizesOf = (row: Json) => row.sizes.map((size: Json) => `${size.size}x${size.quantity}`).join(' ')
const convert = (session: string, rows: Json[], extra: Json = {}, idempotencyKey?: string) => ok(session, 'POST', '/planning/planned-orders/convert', { rows: rows.map((row) => ({ id: row.id, version: row.version, ...(row.workOrderId ? { workOrderId: row.workOrderId } : {}) })), ...extra }, 200, idempotencyKey)

beforeAll(async () => {
  db = await migratedDatabase('planned_orders')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  await seedSubcontract({ db: database, namespace: ns })
  options = await seedOptions({ db: database, namespace: ns })
  // SEED-JKT-01 ready for a release (the subcontract case): a label template of its own (a copy of SEED-JKT-02's), a
  // made-up certificate covering every size, and SEED-SO-0001 without a deposit.
  const labelId = newId()
  await admin(
    `INSERT INTO "LabelTemplate" SELECT (jsonb_populate_record(NULL::"LabelTemplate", to_jsonb(t) || jsonb_build_object('id', $1::text, 'code', 'T-LBL-JKT-01', 'styleId', $2::text))).* FROM "LabelTemplate" t WHERE t.id = $3`,
    [labelId, A.jkt01, idOf('production:label:JKT-02:1')],
  )
  await admin(`UPDATE "StyleRevision" SET "labelTemplateId" = $2 WHERE id = $1`, [A.jkt01Rev, labelId])
  await database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, async (tx) => {
    const certificateId = newId()
    await tx.certificate.create({
      data: { id: certificateId, holderPartyId: idOf('party:P1'), standard: 'EN 17092-3:2020', ppeClass: 'AA', number: 'TEST-CERT-0293', notifiedBodyName: 'Made-up Notified Body', notifiedBodyNumber: '9999', modelReference: 'SEED-JKT-01', validFrom: new Date('2026-01-01T00:00:00.000Z'), validTo: new Date('2030-12-31T00:00:00.000Z'), status: 'VALID', statusChangedAt: new Date() },
      select: { id: true },
    })
    await tx.certificateCoverage.create({ data: { id: newId(), certificateId, styleId: A.jkt01, sizes: ['48', '50', '52', '54', '56'] }, select: { id: true } })
  })
  await admin(`UPDATE "SalesOrder" SET "depositRequired" = false WHERE id = $1`, [idOf('sales:SO1')])
  // SEED-JKT-01 revision 1 (still a DRAFT): the removable liner as a sub-assembly, its sewing step at the workshop P2.
  await admin(
    `INSERT INTO "BomLine" (id, "tenantId", "styleId", "revisionId", seq, "itemId", placement, qty, uom, section, "subAssemblyStyleId", "subAssemblyRevisionId")
     VALUES ($1, $2, $3, $4, 90, $5, 'Zipped in', 1, 'PCS', 'INSULATION', $6, $7)`,
    [newId(), A.tenant, A.jkt01, A.jkt01Rev, options.itemIds.linerComponent, options.linerStyleId, options.linerRevisionId],
  )
  await admin(`UPDATE "RoutingOperation" SET "supplierId" = $2, "transitDays" = 5, "pricePerPiece" = 4.5 WHERE id = $1`, [A.sewing, A.workshop])
  // B-W2b-321 (PLN-162): only a workshop qualified for the step gets planned work: P2 approved for sewing in company A (written as
  // the owner with the guards off; a decided qualification needs evidence files this test does not upload).
  await db.admin.query(
    `SET session_replication_role = replica; INSERT INTO "SupplierQualification" (id, "tenantId", "companyId", "partyId", "workCentreKinds", status, "validFrom", evidence, "decidedAt", "createdAt", "updatedAt") VALUES ('${newId()}', '${A.tenant}', '${A.companyA}', '${A.workshop}', '{SEWING}'::"WorkCentreKind"[], 'APPROVED', DATE '2026-01-01', '[{"recordType": "StoredFile", "recordId": "${newId()}"}]'::jsonb, now() - interval '1 hour', now(), now()); SET session_replication_role = origin;`,
  )
  await admin(`UPDATE "Style" SET status = 'ACTIVE' WHERE id = $1`, [A.jkt01])
  await admin(`UPDATE "StyleRevision" SET status = 'RELEASED', "releasedAt" = now(), "releasedById" = $2 WHERE id = $1`, [A.jkt01Rev, A.actor])
  // SEED-SO-0001's black line: the name on the chest (the style offered the group; the offer is archived since).
  const party = (await admin<{ partyId: string }>(`SELECT "partyId" FROM "SalesOrderLine" WHERE id = $1`, [A.so1Blk]))[0]!.partyId
  await admin(`INSERT INTO "SalesOrderLineOption" (id, "tenantId", "lineId", "partyId", "groupId", "valueId", "freeText") VALUES ($1, $2, $3, $4, $5, $6, 'ROSSI')`, [newId(), A.tenant, A.so1Blk, party, options.groupIds.name, options.valueIds.name])
  // The workshop may not get work at first: the plan makes everything in-house.
  await admin(`UPDATE "Party" SET status = 'BLOCKED' WHERE id = $1`, [A.workshop])
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

describe('the run on the multi-level explosion with the order line’s options (MR1:01, MR1:02, PLN-079)', { timeout: 90_000 }, () => {
  it('plans the liner as a part to make and buys its wadding; the chosen name adds its thread per size', async () => {
    await runPlan()
    const plan = await latest()
    const liner = lineOf(plan, options.itemIds.linerComponent)
    const wadding = lineOf(plan, options.itemIds.wadding)
    expect(liner).toMatchObject({ action: 'MAKE' })
    expect(wadding).toMatchObject({ action: 'BUY' })
    // 0.8 m² + 8 % per liner, for every liner the garments still need.
    expect(Number(wadding!.grossQuantity)).toBeCloseTo(Number(liner!.grossQuantity) * 0.864, 4)
    // SEED-SO-0001 black 50/52/54 = 2/4/2 with the name: 2 × 4.5 + 4 × 5 + 2 × 5.5 m.
    expect(lineOf(plan, options.itemIds.thread)).toMatchObject({ action: 'BUY', grossQuantity: '40.0000' })
  })

  it('a phantom liner passes its parts through: no part to make, the wadding still bought', async () => {
    const before = lineOf(await latest(), options.itemIds.wadding)!
    const rowId = newId()
    await admin(`INSERT INTO "ItemPlanning" (id, "tenantId", "companyId", "siteId", "itemId", phantom) VALUES ($1, $2, $3, $4, $5, true)`, [rowId, A.tenant, A.companyA, A.siteA1, options.itemIds.linerComponent])
    await runPlan()
    const plan = await latest()
    expect(lineOf(plan, options.itemIds.linerComponent)).toBeUndefined()
    expect(lineOf(plan, options.itemIds.wadding)).toMatchObject({ grossQuantity: before.grossQuantity })
    await admin(`DELETE FROM "ItemPlanning" WHERE id = $1`, [rowId])
  })
})

describe('planned work orders (PLN-067, PLN-068, PLN-089)', { timeout: 90_000 }, () => {
  it('the run proposes one grid per style, colourway and due date for the pieces no work order makes; a later run moves the same rows on', async () => {
    const { run: first } = await runPlan()
    const list = await planned()
    expect(list.run.id).toBe(first.id)
    const blk = ofLine(list.plannedOrders, A.so1Blk)
    const red = ofLine(list.plannedOrders, A.so1Red)
    expect(blk).toHaveLength(1)
    expect(red).toHaveLength(1)
    expect(blk[0]).toMatchObject({ kind: 'MAKE', status: 'PLANNED', runId: first.id, revision: null, plannedRevision: { id: A.jkt01Rev }, sizeGroup: null, firm: false, workshop: null, operations: [], held: null, may: { convert: true, firm: true } })
    expect(sizesOf(blk[0])).toBe('50x2 52x4 54x2')
    expect(sizesOf(red[0])).toBe('50x1 52x2 54x1')
    expect(blk[0].startDate <= blk[0].dueDate).toBe(true)
    // The workshop P2 is blocked: its sewing step is made in-house, and said.
    expect(blk[0].outsideStepsInHouse.map((step: Json) => step.seq)).toEqual([20])
    // The run's own audit row names the rows; the event.
    const audit = await admin(`SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND after ? 'plannedWorkOrders'`, [first.id])
    // (The rows were added by the runs above; this run moved them on.)
    const touched = [...audit[0]!.after.plannedWorkOrders.added, ...audit[0]!.after.plannedWorkOrders.moved]
    expect(touched).toEqual(expect.arrayContaining([blk[0].id, red[0].id]))
    const events = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'planned_work_orders.planned' AND subject = $1`, [first.id])
    expect(events[0]?.payload).toMatchObject({ runId: first.id, siteId: A.siteA1 })

    const { run: second } = await runPlan()
    const again = await planned()
    const blk2 = ofLine(again.plannedOrders, A.so1Blk)[0]
    expect(blk2).toMatchObject({ id: blk[0].id, runId: second.id, version: blk[0].version + 1 })
    expect((await ok('viewer', 'GET', `/planning/planned-orders/${blk[0].id}`)).plannedOrder).toMatchObject({ id: blk[0].id, may: { convert: false, firm: false } })
  })

  it('firm: the runs keep it as it is; the size-run rule splits the others by size group (PLN-068)', async () => {
    const list = await planned()
    const blk = ofLine(list.plannedOrders, A.so1Blk)[0]
    expect((await refused('viewer', 'POST', `/planning/planned-orders/${blk.id}/firm`, { version: blk.version }, 403)).code).toBe('forbidden')
    const firm = await ok('planner', 'POST', `/planning/planned-orders/${blk.id}/firm`, { version: blk.version })
    expect(firm.plannedOrder).toMatchObject({ firm: true, version: blk.version + 1 })
    expect((await refused('planner', 'POST', `/planning/planned-orders/${blk.id}/firm`, { version: blk.version + 1 }, 409)).message).toMatch(/firm already/)
    await admin(
      `INSERT INTO "PlanningSettings" (id, "tenantId", "companyId", "siteId", "sizeRunRule", "sizeGroups") VALUES ($1, $2, $3, $1, 'SIZE_GROUPS', '[["50","52"],["54","56"]]')
       ON CONFLICT (id) DO UPDATE SET "sizeRunRule" = 'SIZE_GROUPS', "sizeGroups" = '[["50","52"],["54","56"]]'`,
      [A.siteA1, A.tenant, A.companyA],
    )
    const { run: next } = await runPlan()
    const split = await planned()
    const kept = split.plannedOrders.find((row: Json) => row.id === blk.id)
    expect(kept).toMatchObject({ firm: true, runId: next.id, sizeGroup: null })
    expect(sizesOf(kept)).toBe('50x2 52x4 54x2')
    expect(ofLine(split.plannedOrders, A.so1Blk)).toHaveLength(1)
    const red = ofLine(split.plannedOrders, A.so1Red)
    expect(red.map((row: Json) => [row.sizeGroup, sizesOf(row)])).toEqual([
      ['50-52', '50x1 52x2'],
      ['54-56', '54x1'],
    ])
    expect(split.counts).toMatchObject({ make: 3, subcontract: 0, firm: 1 })
    const unfirm = await ok('planner', 'POST', `/planning/planned-orders/${blk.id}/unfirm`, { version: kept.version })
    expect(unfirm.plannedOrder.firm).toBe(false)
    await runPlan()
    const regrouped = await planned()
    expect(regrouped.plannedOrders.some((row: Json) => row.id === blk.id)).toBe(false)
    expect(ofLine(regrouped.plannedOrders, A.so1Blk).map((row: Json) => sizesOf(row))).toEqual(['50x2 52x4', '54x2'])
  })
})

describe('made real (PLN-067)', { timeout: 90_000 }, () => {
  it('a preview, then the DRAFT work order of its lines at the released revision; CONVERTED with it; the next run proposes nothing more for those pieces', async () => {
    const list = await planned()
    const red = ofLine(list.plannedOrders, A.so1Red).find((row: Json) => row.sizeGroup === '50-52')
    expect((await refused('viewer', 'POST', '/planning/planned-orders/convert', { rows: [{ id: red.id, version: red.version }] }, 403)).code).toBe('forbidden')
    const preview = await convert('planner', [red], { preview: true })
    expect(preview).toMatchObject({ preview: true, made: 0, held: 0 })
    expect(preview.results[0]).toMatchObject({ id: red.id, kind: 'MAKE', ok: true, problems: [], workOrder: { id: null, number: expect.any(String), revision: 1, dueDate: red.dueDate, cells: 2, pieces: 3 }, subcontractOrder: null })
    // Without workorders.manage: held, in words; nothing made.
    const missing = await convert('noWorkOrders', [red])
    expect(missing.results[0]).toMatchObject({ ok: false, error: 'forbidden', problems: [expect.stringMatching(/workorders.manage/)] })
    // A stale version: refused, nothing made.
    const stale = await convert('planner', [{ ...red, version: red.version - 1 }])
    expect(stale.results[0]).toMatchObject({ ok: false, error: 'conflict' })

    const made = await convert('planner', [red], {}, key())
    expect(made).toMatchObject({ preview: false, made: 1, held: 0 })
    const workOrder = made.results[0].workOrder
    expect(workOrder).toMatchObject({ id: expect.any(String), status: 'DRAFT', pieces: 3 })
    const { workOrder: record } = await ok('planner', 'GET', `/production/work-orders/${workOrder.id}`)
    expect(record.cells.map((cell: Json) => [cell.colourwayCode, cell.size, cell.quantity])).toEqual([
      ['RED', '50', 1],
      ['RED', '52', 2],
    ])
    expect(record).toMatchObject({ revision: { id: A.jkt01Rev }, dueDate: red.dueDate })
    const after = (await ok('planner', 'GET', `/planning/planned-orders/${red.id}`)).plannedOrder
    expect(after).toMatchObject({ status: 'CONVERTED', workOrder: { id: workOrder.id, status: 'DRAFT' }, convertedAt: expect.any(String), held: expect.stringMatching(/made real already/), may: { convert: false } })
    const events = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'planned_work_order.converted' AND subject = $1`, [red.id])
    expect(events[0]?.payload).toMatchObject({ plannedWorkOrderId: red.id, kind: 'MAKE', workOrderId: workOrder.id, subcontractOrderId: null, pieces: 3 })
    // Once more: it was made real already.
    const twice = await convert('planner', [after])
    expect(twice.results[0]).toMatchObject({ ok: false, error: 'invalid_state', problems: [expect.stringMatching(/made real already/)] })
    // The database keeps a CONVERTED row as it is.
    await expect(admin(`UPDATE "PlannedWorkOrder" SET quantity = 9 WHERE id = $1`, [red.id])).rejects.toThrow(/never changes/)

    await runPlan()
    const next = await planned()
    expect(ofLine(next.plannedOrders, A.so1Red).map((row: Json) => sizesOf(row))).toEqual(['54x1'])
    expect((await planned('&status=CONVERTED')).plannedOrders.map((row: Json) => row.id)).toEqual([red.id])
  })
})

describe('planned subcontract orders (PLN-069)', { timeout: 90_000 }, () => {
  it('a workshop that may get work again: the run proposes SUBCONTRACT orders with its steps and the kit time; made real, the work order is released and its subcontract order drafted', async () => {
    await admin(`UPDATE "Party" SET status = 'ACTIVE' WHERE id = $1`, [A.workshop])
    await runPlan()
    const list = await planned()
    expect(list.plannedOrders.every((row: Json) => row.kind === 'SUBCONTRACT')).toBe(true)
    const red = ofLine(list.plannedOrders, A.so1Red)[0]
    expect(red).toMatchObject({ workshop: { id: A.workshop }, operations: [{ seq: 20 }], kitDueAt: expect.any(String), outsideStepsInHouse: [] })
    expect(red.kitDueAt.slice(0, 10) <= red.dueDate).toBe(true)
    // The planner alone may not release nor draft for a workshop: held, in words.
    const preview = await convert('planner', [red], { preview: true })
    expect(preview.results[0].ok).toBe(false)
    expect(preview.results[0].problems.join(' ')).toMatch(/workorders.release.*purchasing.subcontract.manage/)
    const ready = await convert('maker', [red], { preview: true })
    expect(ready.results[0]).toMatchObject({ ok: true, subcontractOrder: { workshop: { id: A.workshop }, operations: [{ seq: 20 }] } })

    // The liner has no stock: the release is held by the material check; the DRAFT made from it is named.
    const held = await convert('maker', [red], {}, key())
    expect(held.results[0]).toMatchObject({ ok: false, error: 'conflict' })
    expect(held.results[0].problems[0]).toMatch(/stays a DRAFT/)
    const draft = (await admin<{ id: string; number: string }>(`SELECT w.id, w.number FROM "WorkOrder" w JOIN "WorkOrderSize" c ON c."workOrderId" = w.id WHERE c."salesOrderLineId" = $1 AND w.status = 'DRAFT' AND c.size = '54'`, [A.so1Red]))[0]!
    expect(held.results[0].problems[0]).toContain(draft.number)
    // Naming a work order that does not make what it pegs is refused.
    const other = (await admin<{ id: string }>(`SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND number = 'SEED-WO-0001'`, [A.tenant]))[0]!.id
    const wrong = await convert('maker', [{ ...red, workOrderId: other }])
    expect(wrong.results[0]).toMatchObject({ ok: false, error: 'conflict', problems: [expect.stringMatching(/not one of this site and style|does not make what this planned order pegs/)] })
    // Again, naming it, with the planner's override of the shortage.
    const made = await convert('maker', [{ ...red, workOrderId: draft.id }], { materialOverride: { reason: 'Liners come from the spring stock count' } }, key())
    expect(made.results[0], JSON.stringify(made.results[0])).toMatchObject({ ok: true, workOrder: { id: draft.id, status: 'RELEASED' }, subcontractOrder: { id: expect.any(String), number: expect.any(String) } })
    const scId = made.results[0].subcontractOrder.id
    const sc = (await admin(`SELECT status, "partyId", "workOrderId", "kitDueAt" FROM "SubcontractOrder" WHERE id = $1`, [scId]))[0]!
    expect(sc).toMatchObject({ status: 'DRAFT', partyId: A.workshop, workOrderId: draft.id })
    expect(sc.kitDueAt).not.toBeNull()
    const after = (await ok('planner', 'GET', `/planning/planned-orders/${red.id}`)).plannedOrder
    expect(after).toMatchObject({ status: 'CONVERTED', workOrder: { id: draft.id }, subcontractOrder: { id: scId, status: 'DRAFT' } })
  })
})
