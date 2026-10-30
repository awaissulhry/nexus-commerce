import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedReturns, type ReturnsSeed } from '../../../../../../packages/factory-db/seed/returns'
import { seed as seedSchedule } from '../../../../../../packages/factory-db/seed/schedule'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * A repair work order from a repair order (B-W2a-12; MES-019) on the local stack, with the app's real routes: a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login, so row-level security and the wave 5 work order guard
 * with its REPAIR rules are real) and the factory-db seeds of tenant A up to returns: SEED-REP-0001 (RECEIVED, a PPE
 * jacket) from the RMA line that sent back the BLK 50 jacket of SEED-SO-0002; style SEED-JKT-02 revision 1 RELEASED with
 * its routing cut 10, sew 20, final inspection 30, pack 40 at A1's work centres; the WORK_ORDER and BATCH series. Every
 * name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs work-orders/repairs`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let returnsA: ReturnsSeed

const ns = { a: 'repairs-a', b: 'repairs-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const A = { tenant: idOf(ns.a, 'tenant'), companyA: idOf(ns.a, 'company:A'), companyB: idOf(ns.a, 'company:B'), siteA1: idOf(ns.a, 'site:A1'), brand: idOf(ns.a, 'party:P1') }
const B = { tenant: idOf(ns.b, 'tenant') }

const ALL: Permission[] = ['workorders.view', 'workorders.manage', 'workorders.release', 'production.finish']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  planner: office(A.tenant, [grant(ALL)]),
  viewer: office(A.tenant, [grant(['workorders.view'])]),
  companyB: office(A.tenant, [grant(ALL, [A.companyB])]),
  otherTenant: office(B.tenant, [grant(ALL)]),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
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

const repairId = () => returnsA.repairId
const salesOrderId = () => returnsA.money.shipping.quality.production.salesOrderId
const blkLine = async () => (await admin<{ id: string }>(`SELECT l.id FROM "SalesOrderLine" l JOIN "Colourway" c ON c.id = l."colourwayId" WHERE l."orderId" = $1 AND c.code = 'BLK'`, [salesOrderId()]))[0]!.id
const openBlk = async () => {
  const { lines } = await ok('planner', 'GET', `/production/work-orders/open-lines?salesOrderId=${salesOrderId()}`)
  return (lines as Json[]).flatMap((line) => line.sizes as Json[]).map((size) => [size.size, size.onWorkOrders])
}

let workOrderId = ''

beforeAll(async () => {
  db = await migratedDatabase('repairs')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  for (const namespace of [ns.a, ns.b]) await seedCore({ db: database, namespace })
  returnsA = await seedReturns({ db: database, namespace: ns.a })
  await seedSchedule({ db: database, namespace: ns.a })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 240_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('MES-019: a repair work order from a repair order', () => {
  it('the dialog: the garment from its RMA line, the revision and the steps the site can run', async () => {
    const options = await ok('planner', 'GET', `/production/work-orders/repair-options?repairOrderId=${repairId()}`)
    expect(options.repair).toMatchObject({ number: 'SEED-REP-0001', stage: 'RECEIVED', siteCode: 'A1' })
    expect(options.workOrder).toBeNull()
    expect(options.garment).toMatchObject({ from: 'RETURN_LINE', size: '50', kind: 'SIZE_GRID', problems: [] })
    expect(options.revision).toMatchObject({ revision: 1, status: 'RELEASED' })
    expect((options.steps as Json[]).map((step) => [step.seq, step.workCentreKind, step.available])).toEqual([
      [10, 'CUTTING', true],
      [20, 'SEWING', true],
      [30, 'INSPECTION', true],
      [40, 'PACKING', true],
    ])
    expect(options.blockers).toEqual([])
    expect((await refused('companyB', 'GET', `/production/work-orders/repair-options?repairOrderId=${repairId()}`, undefined, 404)).code).toBe('not_found')
    expect((await refused('otherTenant', 'GET', `/production/work-orders/repair-options?repairOrderId=${repairId()}`, undefined, 404)).code).toBe('not_found')
  })

  it('refuses in words: no right, no step, a step the routing has not', async () => {
    expect((await refused('viewer', 'POST', '/production/work-orders/repairs', { repairOrderId: repairId(), routingSeqs: [20] }, 403)).code).toBe('forbidden')
    const unknown = await refused('planner', 'POST', '/production/work-orders/repairs', { repairOrderId: repairId(), routingSeqs: [20, 99] }, 400)
    expect(unknown.issues).toEqual([{ path: 'body/routingSeqs/1', message: "Revision 1's routing has no step 99." }])
    expect(await admin(`SELECT 1 FROM "WorkOrder" WHERE kind = 'REPAIR'`)).toEqual([])
  })

  it('makes a DRAFT REPAIR of one garment with only the steps it needs, names it on the repair, and never counts it on the line', async () => {
    const before = await openBlk()
    const { workOrder } = await ok('planner', 'POST', '/production/work-orders/repairs', { repairOrderId: repairId(), routingSeqs: [20, 30], note: 'Re-sew the opened seam' }, 201)
    workOrderId = workOrder.id
    expect(workOrder).toMatchObject({ kind: 'REPAIR', status: 'DRAFT', pieces: 1, repairOrder: { id: repairId(), number: 'SEED-REP-0001', stage: 'RECEIVED' }, note: 'Re-sew the opened seam' })
    expect(workOrder.number).toMatch(/^WO-\d{5}$/)
    expect((workOrder.cells as Json[]).map((cell) => [cell.colourwayCode, cell.size, cell.quantity, cell.salesOrderLineId])).toEqual([['BLK', '50', 1, await blkLine()]])
    expect((workOrder.spec.operations as Json[]).map((op) => [op.routingSeq, op.code])).toEqual([
      [20, 'SEED-SEW-ASM'],
      [30, 'SEED-FIN-QC'],
    ])
    expect(workOrder.spec.materials).toEqual([])
    expect(await admin(`SELECT "workOrderId" FROM "RepairOrder" WHERE id = $1`, [repairId()])).toEqual([{ workOrderId }])
    expect(await admin(`SELECT payload->>'repairOrderId' AS repair FROM "OutboxEvent" WHERE type = 'workorder.created' AND payload->>'workOrderId' = $1`, [workOrderId])).toEqual([{ repair: repairId() }])
    expect(await openBlk()).toEqual(before)

    const again = await refused('planner', 'POST', '/production/work-orders/repairs', { repairOrderId: repairId(), routingSeqs: [20] }, 409)
    expect(again.message).toBe(`Repair SEED-REP-0001 already has repair work order ${workOrder.number} (DRAFT); cancel it first to make another.`)
  })

  it("the steps change while it is a DRAFT; its cell and revision never; the release check answers a repair's own way", async () => {
    const { workOrder } = await ok('planner', 'PUT', `/production/work-orders/${workOrderId}/repair-steps`, { routingSeqs: [20] })
    expect((workOrder.spec.operations as Json[]).map((op) => op.routingSeq)).toEqual([20])
    expect((await refused('planner', 'PUT', `/production/work-orders/${workOrderId}/cells`, { cells: [{ salesOrderLineId: await blkLine(), size: '52', quantity: 1 }] }, 409)).code).toBe('invalid_state')
    const check = await ok('planner', 'GET', `/production/work-orders/${workOrderId}/release-check`)
    expect(check.releasable).toBe(true)
    expect(Object.fromEntries((check.checks as Json[]).map((entry) => [entry.code, entry.state]))).toEqual({
      REVISION: 'OK',
      LABEL_TEMPLATE: 'OK',
      CERTIFICATE: 'NOT_REQUIRED',
      WORK_CENTRES: 'OK',
      BOM: 'NOT_REQUIRED',
      CELLS: 'OK',
      DEPOSIT: 'NOT_REQUIRED',
      MATERIAL: 'NOT_REQUIRED',
      BATCH_NUMBER: 'OK',
      // B-W2a-46 (MES-004): a repair takes the hold check like any work order.
      HOLDS: 'OK',
    })
    const sizeRun = (await admin<{ id: string }>(`SELECT id FROM "WorkOrder" WHERE kind = 'SIZE_GRID' AND status = 'DRAFT' LIMIT 1`))[0]!.id
    expect((await refused('planner', 'PUT', `/production/work-orders/${sizeRun}/repair-steps`, { routingSeqs: [20] }, 409)).message).toContain("it takes its revision's whole routing at the release; only a repair chooses its steps.")
  })

  it('the release freezes the chosen step only, with its batch number and no material; its garment never goes into finished goods', async () => {
    const { workOrder } = await ok('planner', 'POST', `/production/work-orders/${workOrderId}/release`, {})
    expect(workOrder).toMatchObject({ status: 'RELEASED', kind: 'REPAIR', spec: { frozen: true, materials: [] } })
    expect(workOrder.batchNumber).toEqual(expect.any(String))
    expect((workOrder.spec.operations as Json[]).map((op) => op.routingSeq)).toEqual([20])
    expect(await admin(`SELECT count(*)::int AS n FROM "WorkOrderMaterial" WHERE "workOrderId" = $1`, [workOrderId])).toEqual([{ n: 0 }])
    expect((await ok('planner', 'GET', `/production/work-orders?kind=REPAIR`)).workOrders.map((row: Json) => row.id)).toEqual([workOrderId])

    await ok('planner', 'POST', `/production/work-orders/${workOrderId}/start`, {})
    const view = (await ok('planner', 'GET', `/production/work-orders/${workOrderId}/finished`)).finished
    expect(view.blockers).toEqual([`Work order ${workOrder.number} repairs a customer's garment: it goes back with its repair's transport document (DDT), never into finished goods.`])
    expect((await refused('planner', 'POST', `/production/work-orders/${workOrderId}/finished`, {}, 409)).code).toBe('invalid_state')
  })

  it('a repair named by hand: the sold line asked, the customer checked; without one, said in words', async () => {
    const handMade = newId()
    await admin('BEGIN')
    await admin(
      `INSERT INTO "RepairOrder" (id, "tenantId", "companyId", "siteId", "partyId", number, kind, problem, stage, "receivedAt") VALUES ($1, $2, $3, $4, $5, 'T-REP-HAND', 'ALTERATION', 'Shorten the sleeves', 'RECEIVED', now())`,
      [handMade, A.tenant, A.companyA, A.siteA1, A.brand],
    )
    await admin(`INSERT INTO "RepairStageEvent" (id, "tenantId", "siteId", "repairId", stage, "repairVersion", at, "requestId") VALUES ($1, $2, $3, $4, 'RECEIVED', 1, now(), 'test-hand')`, [newId(), A.tenant, A.siteA1, handMade])
    await admin('COMMIT')
    const none = await refused('planner', 'POST', '/production/work-orders/repairs', { repairOrderId: handMade, routingSeqs: [20] }, 400)
    expect(none.message).toBe('The repair names no RMA line and no serial of one of our garments: name the sales order line (and size) the garment was sold on.')
    const size = await refused('planner', 'POST', '/production/work-orders/repairs', { repairOrderId: handMade, routingSeqs: [20], salesOrderLineId: await blkLine(), size: '58' }, 400)
    expect(size.issues).toEqual([{ path: 'body/salesOrderLineId/size', message: expect.stringMatching(/ sold no size 58\.$/) }])
    const { workOrder } = await ok('planner', 'POST', '/production/work-orders/repairs', { repairOrderId: handMade, routingSeqs: [20], salesOrderLineId: await blkLine(), size: '52' }, 201)
    expect(workOrder).toMatchObject({ kind: 'REPAIR', repairOrder: { number: 'T-REP-HAND' } })
  })
})
