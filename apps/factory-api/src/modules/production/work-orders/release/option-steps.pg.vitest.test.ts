import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase, type Prisma } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../../packages/factory-db/seed/numbering'
import { seed as seedOptions, type OptionsSeed } from '../../../../../../../packages/factory-db/seed/options'
import { seed as seedProduction, type ProductionSeed } from '../../../../../../../packages/factory-db/seed/production'
import { seed as seedReasons } from '../../../../../../../packages/factory-db/seed/reasons'
import { seedUuid } from '../../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../../env'

/**
 * B-W2b-F40: a release whose cells skip a routing step only for some options (B-W2b-225's stepIsFor; CF1:03: an option-only
 * step applies only when a cell chose that option) answered 500, because …_production_guards' factory_work_order_guard
 * asked for every step of the revision. …_production_option_steps_w2b_guards asks only for the steps one of the cells is
 * for. On the local stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime
 * login: row-level security and the guards are real), the factory-db seeds up to production (SEED-JKT-02 revision 1
 * RELEASED: cut 10, sew 20, final inspection 30, pack 40 at plant A1), the options seed (SEED-OG-PERF FRONT / FULL,
 * SEED-OG-LINER, SEED-OG-ARMOUR and the library's SEED-PERF), the numbering and reason lists, a made-up certificate and
 * released stock. The fixture (the released routing is frozen: only the owner with the triggers off): SEED-JKT-02 r1 gets
 * step 15 SEED-PERF only for front perforation, as SEED-JKT-05's step 20; a cell's chosen options are set the same way (no
 * order line of SEED-JKT-02 offers them). Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs work-orders/release/option-steps`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let options: OptionsSeed
let production: ProductionSeed

const NS = 'wo-option-steps'
const idOf = (key: string) => seedUuid(NS, key)
const A = {
  tenant: idOf('tenant'),
  actor: idOf('actor'),
  companyA: idOf('company:A'),
  siteA1: idOf('site:A1'),
  brand: idOf('party:P1'),
  style: idOf('production:style:JKT-02'),
  blk: idOf('production:colourway:JKT-02:BLK'),
  leather: idOf('product:item:leather'),
  lining: idOf('product:item:lining'),
  protector: idOf('product:item:protector'),
  leatherBLK: idOf('product:item-colour:leather:BLK'),
  liningGRY: idOf('product:item-colour:lining:GRY'),
  binA1: idOf('inventory:location:A1-STORE-01'),
  centre: (code: string) => idOf(`site:A1:work-centre:${code}`),
}
const CENTRE_OF_KIND: Readonly<Record<string, string>> = { CUTTING: 'CUT', SEWING: 'SEW', INSPECTION: 'QC', PACKING: 'PACK' }
const PERF_STEP = 15

const ALL: Permission[] = ['workorders.view', 'workorders.manage', 'workorders.release']
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = { planner: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(ALL)] } }

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
const call = (method: Method, url: string, payload?: unknown) => app.inject({ method, url, headers: { 'x-test-session': 'planner' }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const asOffice = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) => client.$transaction(work))
/** A forced state (test data past its guards: a released revision is frozen, a cell's options come from its order line). */
const forced = async (sql: string, values: unknown[]) => {
  await db.admin.query(`SET session_replication_role = replica`)
  try {
    await db.admin.query(sql, values)
  } finally {
    await db.admin.query(`SET session_replication_role = origin`)
  }
}

/** A DRAFT work order through the route, from a made-up CONFIRMED order line of SEED-JKT-02 BLK (it fixes no revision). */
let orders = 0
async function draft(sizes: Record<string, number>): Promise<Json> {
  const orderId = newId()
  const lineId = newId()
  const pieces = Object.values(sizes).reduce((sum, quantity) => sum + quantity, 0)
  await asOffice(async (tx) => {
    await tx.salesOrder.create({
      data: { id: orderId, companyId: A.companyA, partyId: A.brand, number: `T-${run}-SO-${++orders}`, status: 'CONFIRMED', orderDate: new Date('2026-10-20T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up workshop' }, promiseDate: new Date('2026-12-10T00:00:00.000Z'), depositRequired: false },
      select: { id: true },
    })
    await tx.salesOrderLine.create({
      data: { id: lineId, companyId: A.companyA, orderId, partyId: A.brand, seq: 10, kind: 'SIZE_GRID', styleId: A.style, colourwayId: A.blk, quantity: pieces, unitPrice: '100.000000', netAmount: pieces * 10_000, vatRatePct: '22.00', vatAmount: pieces * 2_200, siteId: A.siteA1 },
      select: { id: true },
    })
    await tx.salesOrderLineSize.createMany({ data: Object.entries(sizes).map(([size, quantity]) => ({ id: newId(), lineId, partyId: A.brand, size, quantity })) })
  })
  return (await ok('POST', '/production/work-orders', { lines: [{ salesOrderLineId: lineId }] }, 201)).workOrder
}

/** The cells' chosen option values, as the order line's picks would give them (B-W2b-340's optionValueIdsOf). */
const choose = (workOrderId: string, valueIds: readonly string[]) => forced(`UPDATE "WorkOrderSize" SET "optionValueIds" = $2::uuid[] WHERE "workOrderId" = $1`, [workOrderId, valueIds])
const release = (workOrder: Json) => call('POST', `/production/work-orders/${workOrder.id}/release`, { version: workOrder.version, materialOverride: { reason: 'Made-up reason: the rest of the leather arrives next week.' } })
const stepsOf = async (workOrderId: string): Promise<number[]> =>
  (await admin<{ seq: number }>(`SELECT "routingSeq" AS seq FROM "WorkOrderOperation" WHERE "workOrderId" = $1 AND "routingSeq" IS NOT NULL ORDER BY "routingSeq"`, [workOrderId])).map((row) => row.seq)

/** The release's write without the API, as the runtime login: the operations of the given steps, then RELEASED (the guard is the last word). */
async function releaseBySql(workOrderId: string, seqs: readonly number[]): Promise<void> {
  const steps = await admin<{ seq: number; code: string; name: string; minutes: string; scan: boolean; kind: string }>(
    `SELECT seq, code, name, "standardMinutes"::text AS minutes, "scanRequired" AS scan, "workCentreKind"::text AS kind FROM "RoutingOperation" WHERE "revisionId" = $1 AND seq = ANY ($2::int[]) ORDER BY seq`,
    [production.revisionId, seqs],
  )
  const [revision] = await admin<{ label: string }>(`SELECT "labelTemplateId" AS label FROM "StyleRevision" WHERE id = $1`, [production.revisionId])
  await asOffice(async (tx) => {
    await tx.workOrderOperation.createMany({
      data: steps.map((step) => ({ id: newId(), siteId: A.siteA1, workOrderId, styleRevisionId: production.revisionId, seq: step.seq, routingSeq: step.seq, code: step.code, name: step.name, standardMinutes: step.minutes, scanRequired: step.scan, workCentreId: A.centre(CENTRE_OF_KIND[step.kind]!) })),
    })
    await tx.workOrder.update({ where: { id: workOrderId }, data: { status: 'RELEASED', labelTemplateId: revision!.label, batchNumber: `T-${run}-BT-${randomBytes(6).toString('hex')}`, releasedAt: new Date() }, select: { id: true } })
  })
}

/** A released lot with its stock at A1 (leather: one hide). */
async function stockLot(spec: { itemId: string; colourId: string | null; quantity: string; uom: string; leather?: boolean; code: string }) {
  const lotId = newId()
  await admin(
    `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "qualityStatus", "qualityDecidedAt", "requiresCrViTest", "crViLimitMgKg", "crViStatus", "crViMgKg", "crViEvidence", "crViTestedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'RELEASED', now(), $8, $9, $10, $11, $12, $13)`,
    [lotId, A.tenant, A.companyA, A.siteA1, spec.itemId, spec.colourId, spec.code, !!spec.leather, spec.leather ? '3.000' : null, spec.leather ? 'PASS' : 'NOT_REQUIRED', spec.leather ? '1.100' : null, spec.leather ? 'LOT_REPORT' : null, spec.leather ? '2026-10-01' : null],
  )
  const hideId = spec.leather ? newId() : null
  if (hideId) await admin(`INSERT INTO "Hide" (id, "tenantId", "siteId", "lotId", "itemId", code, area, "areaUom", "baseArea") VALUES ($1, $2, $3, $4, $5, $6, $7, 'FT2', $7)`, [hideId, A.tenant, A.siteA1, lotId, spec.itemId, `${spec.code}-H1`, spec.quantity])
  await admin(
    `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "hideId", "toLocationId", quantity, uom, "baseQuantity", "idempotencyKey", "occurredAt")
     VALUES ($1, $2, $3, $4, 'OPENING', $5, $6, $7, $8, $9, $10, $11, $10, $12, now())`,
    [newId(), A.tenant, A.companyA, A.siteA1, spec.itemId, spec.colourId, lotId, hideId, A.binA1, spec.quantity, spec.uom, `wo-option-steps-${spec.code}`],
  )
}

beforeAll(async () => {
  db = await migratedDatabase('wo_option_steps')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 10 } })
  await seedCore({ db: database, namespace: NS })
  production = await seedProduction({ db: database, namespace: NS })
  options = await seedOptions({ db: database, namespace: NS })
  await seedNumbering({ db: database, namespace: NS })
  await seedReasons({ db: database, namespace: NS })
  await asOffice(async (tx) => {
    const certificateId = newId()
    await tx.certificate.create({
      data: { id: certificateId, holderPartyId: A.brand, standard: 'EN 17092-3:2020', ppeClass: 'AA', number: `T-${run}-CERT`, notifiedBodyName: 'Made-up Notified Body', notifiedBodyNumber: '9999', modelReference: 'SEED-JKT-02', validFrom: new Date('2026-01-01T00:00:00.000Z'), validTo: new Date('2030-12-31T00:00:00.000Z'), status: 'VALID', statusChangedAt: new Date() },
      select: { id: true },
    })
    await tx.certificateCoverage.create({ data: { id: newId(), certificateId, styleId: A.style, sizes: ['50', '52', '54'] }, select: { id: true } })
  })
  await stockLot({ itemId: A.leather, colourId: A.leatherBLK, quantity: '2000.0000', uom: 'FT2', leather: true, code: `T-${run}-LEA-BLK` })
  await stockLot({ itemId: A.lining, colourId: A.liningGRY, quantity: '500.0000', uom: 'M', code: `T-${run}-LIN` })
  await stockLot({ itemId: A.protector, colourId: null, quantity: '1000.0000', uom: 'PCS', code: `T-${run}-PRO` })
  // The fixture: step 15 SEED-PERF (the library's perforation, at a cutting centre) only for front perforation, between
  // cutting and sewing, a copy of the cutting step's other columns.
  await forced(
    `INSERT INTO "RoutingOperation"
     SELECT (jsonb_populate_record(NULL::"RoutingOperation", to_jsonb(r) || jsonb_build_object('id', $2::text, 'seq', $3::int, 'operationId', $4::text, 'code', 'SEED-PERF', 'name', 'Perforate leather panels', 'appliesToOptionValueIds', jsonb_build_array($5::text)))).*
       FROM "RoutingOperation" r WHERE r."revisionId" = $1 AND r.seq = 10`,
    [production.revisionId, newId(), PERF_STEP, options.operationId, options.valueIds.perfFront],
  )
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
}, 240_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('a routing step only for some options (B-W2b-F40; PRD-128, CF1:03)', () => {
  it("releases (200) a work order whose cells chose none of the step's options, without that step's operation", async () => {
    expect((await admin<{ seqs: number[] }>(`SELECT array_agg(seq ORDER BY seq) AS seqs FROM "RoutingOperation" WHERE "revisionId" = $1`, [production.revisionId]))[0]!.seqs).toEqual([10, PERF_STEP, 20, 30, 40])
    // The cells chose the liner and the standard armour, no perforation (the case seen with SEED-JKT-05: a 500).
    const workOrder = await draft({ '50': 1, '52': 1 })
    await choose(workOrder.id, [options.valueIds.linerYes, options.valueIds.armourStd])
    const routing = (await ok('GET', `/production/work-orders/${workOrder.id}/routing`)).routing
    expect(routing.operations.map((op: Json) => op.routingSeq)).toEqual([10, 20, 30, 40])
    expect(routing.leftOut).toEqual([expect.objectContaining({ seq: PERF_STEP, code: 'SEED-PERF', words: expect.objectContaining({ en: expect.stringMatching(/^Only for 1 option: no cell of the work order\.$/) }) })])

    const released = await release(workOrder)
    expect(released.statusCode, released.body).toBe(200)
    expect(released.json().workOrder).toMatchObject({ status: 'RELEASED' })
    expect(await stepsOf(workOrder.id)).toEqual([10, 20, 30, 40])
    const [audit] = await admin<{ after: Json }>(`SELECT "after" FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'workorders.release' AND "recordId" = $2`, [A.tenant, workOrder.id])
    expect(audit!.after).toMatchObject({ status: 'RELEASED', operations: 4 })
    // The frozen copy says the step is not in it.
    expect((await ok('GET', `/production/work-orders/${workOrder.id}/routing`)).routing.leftOut).toEqual([expect.objectContaining({ seq: PERF_STEP, code: 'SEED-PERF' })])
  })

  it("keeps the step when a cell chose one of its options (one cell is enough)", async () => {
    const workOrder = await draft({ '50': 1, '54': 1 })
    await forced(`UPDATE "WorkOrderSize" SET "optionValueIds" = $2::uuid[] WHERE "workOrderId" = $1 AND size = '54'`, [workOrder.id, [options.valueIds.perfFront]])
    const released = await release(workOrder)
    expect(released.statusCode, released.body).toBe(200)
    expect(await stepsOf(workOrder.id)).toEqual([10, PERF_STEP, 20, 30, 40])
  })

  it('the database still refuses a release without a step one of its cells is for (no route leaves one out), and lets one out that none is for', async () => {
    // A step for every cell (sewing, no condition) left out: refused, whatever the options.
    const plain = await draft({ '52': 1 })
    await expect(releaseBySql(plain.id, [10, 30, 40])).rejects.toThrow(/every step of its revision's routing as an operation at a work centre of its site \(1 step\(s\) missing\), but a step only for sizes, colourways or options none of its cells has/)
    expect((await admin(`SELECT status::text FROM "WorkOrder" WHERE id = $1`, [plain.id]))[0]).toEqual({ status: 'DRAFT' })
    // The option step left out while a cell chose front perforation: refused.
    const chosen = await draft({ '52': 1 })
    await choose(chosen.id, [options.valueIds.perfFront])
    await expect(releaseBySql(chosen.id, [10, 20, 30, 40])).rejects.toThrow(/\(1 step\(s\) missing\)/)
    // Every step its cells are for, the option step none chose left out: released.
    await releaseBySql(plain.id, [10, 20, 30, 40])
    expect((await admin(`SELECT status::text FROM "WorkOrder" WHERE id = $1`, [plain.id]))[0]).toEqual({ status: 'RELEASED' })

    // Sizes and colourways read the same (stepIsFor): the final inspection only for size 54 and another colourway.
    await forced(`UPDATE "RoutingOperation" SET "appliesToSizes" = ARRAY['54'] WHERE "revisionId" = $1 AND seq = 30`, [production.revisionId])
    try {
      const small = await draft({ '50': 1 })
      await releaseBySql(small.id, [10, 20, 40])
      expect(await stepsOf(small.id)).toEqual([10, 20, 40])
      const large = await draft({ '54': 1 })
      await expect(releaseBySql(large.id, [10, 20, 40])).rejects.toThrow(/\(1 step\(s\) missing\)/)
      await forced(`UPDATE "RoutingOperation" SET "appliesToSizes" = '{}', "appliesToColourwayIds" = ARRAY[$2::uuid] WHERE "revisionId" = $1 AND seq = 30`, [production.revisionId, newId()])
      await releaseBySql(large.id, [10, 20, 40])
      expect(await stepsOf(large.id)).toEqual([10, 20, 40])
    } finally {
      await forced(`UPDATE "RoutingOperation" SET "appliesToSizes" = '{}', "appliesToColourwayIds" = '{}' WHERE "revisionId" = $1 AND seq = 30`, [production.revisionId])
    }
  })
})
