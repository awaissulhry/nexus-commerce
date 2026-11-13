import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase, type Prisma } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../packages/factory-db/seed/numbering'
import { seed as seedOptions, type OptionsSeed } from '../../../../../packages/factory-db/seed/options'
import { seed as seedSubcontract, type SubcontractSeed } from '../../../../../packages/factory-db/seed/subcontract'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { SITE_COLUMNS } from './store'
import { readJobs } from './subcontract-capacity/store'

/**
 * Option steps in planning and production (B-W2b-365; follow-ups XF4:01-04 of B-W2b-F40, B-W2b-321 and B-W2b-338) on the
 * local stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login:
 * row-level security and the guards are real), the factory-db seeds up to production, numbering, subcontracting (P2's
 * location at A1, SEED-SC-0001) and the options library. The seed jacket SEED-JKT-05 (BLK; 50, 52, 54) has step 20
 * SEED-PERF only for front perforation (SEED-OG-PERF: FRONT); here its revision 1 is released (as the owner), step 20 goes
 * to the workshop P2 (3 days away; P2 approved for cutting in company A, written as the owner with the guards off: a decided
 * qualification needs evidence files this test does not upload) and a made-up certificate covers its sizes. Every name and
 * number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/planning/option-steps`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let options: OptionsSeed
let subcontract: SubcontractSeed

const ns = 'option-steps'
const idOf = (key: string) => seedUuid(ns, key)
const A = {
  tenant: idOf('tenant'),
  actor: idOf('actor'),
  companyA: idOf('company:A'),
  siteA1: idOf('site:A1'),
  P1: idOf('party:P1'),
  P2: idOf('party:P2'),
  blk: idOf('options:colourway:JKT-05:BLK'),
  centre: (code: string) => idOf(`site:A1:work-centre:${code}`),
}
const PERF = 20

const ALL: Permission[] = [
  'workorders.view',
  'workorders.manage',
  'workorders.release',
  'sales.samples.view',
  'sales.samples.manage',
  'planning.view',
  'planning.run',
  'planning.planned.convert',
  'planning.promise.view',
  'purchasing.view',
  'purchasing.subcontract.manage',
  'inventory.stock.view',
]
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const OFFICE_ACTOR = newId()
const SESSIONS: Record<string, SessionContext> = { office: { audience: 'office', tenantId: A.tenant, actorId: OFFICE_ACTOR, grants: [grant(ALL)] } }

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
const call = (method: Method, url: string, payload?: unknown) => app.inject({ method, url, headers: { 'x-test-session': 'office' }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const asOffice = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) => client.$transaction(work))
/** Test data past its guards (the owner, the triggers off). */
const forced = async (sql: string, values: unknown[] = []) => {
  await db.admin.query(`SET session_replication_role = replica`)
  try {
    await db.admin.query(sql, values)
  } finally {
    await db.admin.query(`SET session_replication_role = origin`)
  }
}
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
/** P2 approved for kinds of work in company A. */
const qualify = (kinds: string[]) =>
  forced(
    `INSERT INTO "SupplierQualification" (id, "tenantId", "companyId", "partyId", "workCentreKinds", status, "validFrom", evidence, "decidedAt", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5::"WorkCentreKind"[], 'APPROVED', DATE '2026-01-01', $6::jsonb, now() - interval '1 hour', now(), now())`,
    [newId(), A.tenant, A.companyA, A.P2, `{${kinds.join(',')}}`, JSON.stringify([{ recordType: 'StoredFile', recordId: newId() }])],
  )

/** A made-up CONFIRMED order of SEED-JKT-05 BLK at A1, a line per entry with its sizes and chosen options. */
let orders = 0
async function order(promiseDate: string, lines: { sizes: Record<string, number>; options?: string[] }[]): Promise<string[]> {
  const orderId = newId()
  const lineIds = lines.map(() => newId())
  await asOffice(async (tx) => {
    await tx.salesOrder.create({
      data: { id: orderId, companyId: A.companyA, partyId: A.P1, number: `T-${run}-SO-${++orders}`, status: 'CONFIRMED', orderDate: new Date(`${day(0)}T00:00:00.000Z`), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up workshop' }, promiseDate: new Date(`${promiseDate}T00:00:00.000Z`), depositRequired: false },
      select: { id: true },
    })
    for (const [index, line] of lines.entries()) {
      const pieces = Object.values(line.sizes).reduce((sum, quantity) => sum + quantity, 0)
      await tx.salesOrderLine.create({
        data: { id: lineIds[index]!, companyId: A.companyA, orderId, partyId: A.P1, seq: (index + 1) * 10, kind: 'SIZE_GRID', styleId: options.jacketStyleId, colourwayId: A.blk, quantity: pieces, unitPrice: '100.000000', netAmount: pieces * 10_000, vatRatePct: '22.00', vatAmount: pieces * 2_200, siteId: A.siteA1 },
        select: { id: true },
      })
      await tx.salesOrderLineSize.createMany({ data: Object.entries(line.sizes).map(([size, quantity]) => ({ id: newId(), lineId: lineIds[index]!, partyId: A.P1, size, quantity })) })
    }
  })
  for (const [index, line] of lines.entries()) {
    for (const valueId of line.options ?? []) {
      const [value] = await admin<{ groupId: string }>(`SELECT "groupId" FROM "OptionValue" WHERE id = $1`, [valueId])
      await admin(`INSERT INTO "SalesOrderLineOption" (id, "tenantId", "lineId", "partyId", "groupId", "valueId") VALUES ($1, $2, $3, $4, $5, $6)`, [newId(), A.tenant, lineIds[index], A.P1, value!.groupId, valueId])
    }
  }
  return lineIds
}

const routingOf = async (workOrderId: string) => (await ok('GET', `/production/work-orders/${workOrderId}/routing`)).routing as Json
const seqs = (rows: Json[]) => rows.map((row) => row.routingSeq ?? row.seq)

beforeAll(async () => {
  db = await migratedDatabase('option_steps')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  subcontract = await seedSubcontract({ db: database, namespace: ns })
  options = await seedOptions({ db: database, namespace: ns })
  // The office user the routes act as (rows name who made them).
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, 'Made-up planner', 'ACTIVE')`, [OFFICE_ACTOR, A.tenant, `w2b365-${run}@example.test`])
  // SEED-JKT-05 revision 1 released, its step 20 (front perforation only) at the workshop P2, 3 days away.
  await admin(`UPDATE "RoutingOperation" SET "supplierId" = $3, "transitDays" = 3 WHERE "revisionId" = $1 AND seq = $2`, [options.jacketRevisionId, PERF, A.P2])
  await admin(`UPDATE "Style" SET status = 'ACTIVE' WHERE id = $1`, [options.jacketStyleId])
  await admin(`UPDATE "StyleRevision" SET status = 'RELEASED', "releasedAt" = now(), "releasedById" = $2 WHERE id = $1`, [options.jacketRevisionId, A.actor])
  await qualify(['CUTTING'])
  // A made-up certificate covering the jacket's sizes (a promise is made only for certified sizes).
  await asOffice(async (tx) => {
    const certificateId = newId()
    await tx.certificate.create({
      data: { id: certificateId, holderPartyId: A.P1, standard: 'EN 17092-3:2020', ppeClass: 'AA', number: `TEST-CERT-0365-${run}`, notifiedBodyName: 'Made-up Notified Body', notifiedBodyNumber: '9999', modelReference: 'SEED-JKT-05', validFrom: new Date('2026-01-01T00:00:00.000Z'), validTo: new Date('2030-12-31T00:00:00.000Z'), status: 'VALID', statusChangedAt: new Date() },
      select: { id: true },
    })
    await tx.certificateCoverage.create({ data: { id: newId(), certificateId, styleId: options.jacketStyleId, sizes: ['50', '52', '54'] }, select: { id: true } })
  })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 480_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('XF4:01 the routing preview keeps the cells’ options', { timeout: 90_000 }, () => {
  it('a draft whose cell chose front perforation shows step 20 in its copy, by name; one without it leaves step 20 out', async () => {
    const [front, plain] = await order(day(45), [{ sizes: { '52': 1 }, options: [options.valueIds.perfFront] }, { sizes: { '52': 1 } }])
    const withFront = (await ok('POST', '/production/work-orders', { siteId: A.siteA1, lines: [{ salesOrderLineId: front }] }, 201)).workOrder
    const routing = await routingOf(withFront.id)
    expect(routing.frozen).toBe(false)
    expect(seqs(routing.operations)).toEqual([10, PERF, 30])
    expect(routing.leftOut).toEqual([])
    const perf = routing.operations.find((operation: Json) => operation.routingSeq === PERF)
    expect(perf).toMatchObject({ code: 'SEED-PERF', variants: { en: 'Only for option SEED-OG-PERF: FRONT' } })
    expect(perf.forCells).toHaveLength(1)

    const without = (await ok('POST', '/production/work-orders', { siteId: A.siteA1, lines: [{ salesOrderLineId: plain }] }, 201)).workOrder
    const other = await routingOf(without.id)
    expect(seqs(other.operations)).toEqual([10, 30])
    expect(other.leftOut).toEqual([expect.objectContaining({ seq: PERF, code: 'SEED-PERF', words: expect.objectContaining({ en: 'Only for option SEED-OG-PERF: FRONT: no cell of the work order.' }) })])
  })
})

describe('XF4:02 a sample round’s cells carry the configuration sampled', { timeout: 90_000 }, () => {
  it('the dialog lists the style’s option groups; the work order without an order line carries the options named and its copy gets step 20', async () => {
    const { round } = await ok('POST', '/sales/samples/rounds', { styleId: options.jacketStyleId, companyId: A.companyA, kind: 'FIT', cells: [{ colourwayId: A.blk, size: '52', quantity: 1 }] }, 201)
    const choices = await ok('GET', `/sales/samples/rounds/${round.id}/work-order-options`)
    expect(choices.withoutLine.allowed).toBe(true)
    expect(choices.withoutLine.options.map((group: Json) => group.code)).toEqual(['SEED-OG-LINER', 'SEED-OG-PERF', 'SEED-OG-NAME', 'SEED-OG-ARMOUR'])
    expect(choices.withoutLine.options.find((group: Json) => group.code === 'SEED-OG-ARMOUR')).toMatchObject({ minPicks: 1, maxPicks: 1, defaultValueId: options.valueIds.armourStd })
    expect(choices.withoutLine.options.find((group: Json) => group.code === 'SEED-OG-PERF').values.map((value: Json) => value.code)).toEqual(['FRONT', 'FULL'])

    // REFUSED: two options of a single-choice group; an option the style does not offer; options beside order lines.
    const twice = await ok('POST', `/sales/samples/rounds/${round.id}/work-orders`, { version: round.version, siteId: A.siteA1, optionValueIds: [options.valueIds.perfFront, options.valueIds.perfFull] }, 400)
    expect(twice.error.issues).toEqual([{ path: 'body/optionValueIds', message: 'SEED-OG-PERF takes 1 option at most (2 named).' }])
    const unknown = await ok('POST', `/sales/samples/rounds/${round.id}/work-orders`, { version: round.version, siteId: A.siteA1, optionValueIds: [newId()] }, 400)
    expect(unknown.error.issues[0]).toMatchObject({ path: 'body/optionValueIds/0', message: expect.stringContaining('Not an option the style offers') })
    const beside = await ok('POST', `/sales/samples/rounds/${round.id}/work-orders`, { version: round.version, lines: [{ salesOrderLineId: newId() }], optionValueIds: [options.valueIds.perfFront] }, 400)
    expect(beside.error.issues[0]).toMatchObject({ path: 'body/optionValueIds' })

    const made = await ok('POST', `/sales/samples/rounds/${round.id}/work-orders`, { version: round.version, siteId: A.siteA1, optionValueIds: [options.valueIds.perfFront, options.valueIds.armourStd] }, 201)
    const cells = await admin<{ optionValueIds: string[] }>(`SELECT "optionValueIds" FROM "WorkOrderSize" WHERE "workOrderId" = $1`, [made.workOrder.id])
    expect(cells).toEqual([{ optionValueIds: [options.valueIds.perfFront, options.valueIds.armourStd] }])
    const routing = await routingOf(made.workOrder.id)
    expect(seqs(routing.operations)).toEqual([10, PERF, 30])
    expect(routing.leftOut).toEqual([])
  })
})

describe('XF4:03 planned orders, promises and capacity read only the steps a cell is for', { timeout: 120_000 }, () => {
  let plain: string
  let front: string
  let mixed: Json

  it('the run sends work to P2 only for the order whose line chose front perforation; its workshop is booked for that cell only', async () => {
    plain = (await order(day(20), [{ sizes: { '50': 2 } }]))[0]!
    front = (await order(day(30), [{ sizes: { '54': 1 }, options: [options.valueIds.perfFront] }, { sizes: { '52': 2 } }]))[0]!
    await ok('POST', '/planning/runs', { siteId: A.siteA1 }, 201)
    const rows = (await ok('GET', `/planning/planned-orders?siteId=${A.siteA1}`)).plannedOrders as Json[]
    const of = (lineId: string) => rows.filter((row) => row.demand.some((entry: Json) => entry.orderLineId === lineId))
    // No line chose it: step 20 is for none of its cells, so nothing goes out.
    expect(of(plain)).toEqual([expect.objectContaining({ kind: 'MAKE', operations: [], outsideStepsInHouse: [], workshop: null, quantity: 2 })])
    mixed = of(front)[0]!
    expect(of(front)).toHaveLength(1)
    expect(mixed).toMatchObject({ kind: 'SUBCONTRACT', workshop: expect.objectContaining({ id: A.P2 }), quantity: 3, operations: [expect.objectContaining({ seq: PERF, code: 'SEED-PERF' })] })

    // Capacity: the planned subcontract order books P2's cutting for the one garment that chose it (6 minutes), not all three.
    const site = await database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) => client.site.findUniqueOrThrow({ where: { id: A.siteA1 }, select: SITE_COLUMNS }))
    const jobs = await database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) => readJobs(client, site, day(0)))
    expect(jobs.find((job) => job.kind === 'PLANNED' && job.id === mixed.id)).toMatchObject({ partyId: A.P2, garments: 3, operations: [{ workCentreKind: 'CUTTING', minutes: '6.000' }] })

    // Made real (preview): the subcontract order sends step 20.
    const preview = await ok('POST', '/planning/planned-orders/convert', { rows: [{ id: mixed.id, version: mixed.version }], preview: true })
    expect(preview.results[0].subcontractOrder.operations).toEqual([expect.objectContaining({ seq: PERF, code: 'SEED-PERF' })])
  })

  it('the line no longer chooses it: the planned order sends none of its steps, and books the workshop for nothing', async () => {
    await forced(`DELETE FROM "SalesOrderLineOption" WHERE "lineId" = $1`, [front])
    const row = (await ok('GET', `/planning/planned-orders/${mixed.id}`)).plannedOrder as Json
    expect(row).toMatchObject({ kind: 'SUBCONTRACT', operations: [] })
    const preview = await ok('POST', '/planning/planned-orders/convert', { rows: [{ id: mixed.id, version: mixed.version }], preview: true })
    expect(preview.results[0].subcontractOrder.operations).toEqual([])
    expect(preview.results[0].problems).toContain('Its revision has none of the routing steps it sends out.')
    const site = await database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) => client.site.findUniqueOrThrow({ where: { id: A.siteA1 }, select: SITE_COLUMNS }))
    const jobs = await database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) => readJobs(client, site, day(0)))
    expect(jobs.find((job) => job.kind === 'PLANNED' && job.id === mixed.id)).toMatchObject({ operations: [] })
  })

  it('the promise calculator walks step 20 only for a garment with front perforation; an option the style does not offer is refused', async () => {
    const ask = { siteId: A.siteA1, styleId: options.jacketStyleId, colourwayId: A.blk, sizes: [{ size: '52', quantity: 2 }] }
    const plainAnswer = (await ok('POST', '/planning/promise/calculate', ask)).answer
    expect(seqs(plainAnswer.steps)).toEqual([10, 30])
    const frontAnswer = (await ok('POST', '/planning/promise/calculate', { ...ask, optionValueIds: [options.valueIds.perfFront] })).answer
    expect(seqs(frontAnswer.steps)).toEqual([10, PERF, 30])
    expect(frontAnswer.steps.find((step: Json) => step.seq === PERF)).toMatchObject({ outside: true })
    const refused = await ok('POST', '/planning/promise/calculate', { ...ask, optionValueIds: [newId()] }, 400)
    expect(refused.error.issues[0]).toMatchObject({ path: 'body/optionValueIds/0' })
  })

  it('a released work order books step 20 on the cutting centre for the cell that chose it only', async () => {
    const due = day(12)
    const [two, three] = await order(day(40), [{ sizes: { '50': 2 } }, { sizes: { '54': 3 }, options: [options.valueIds.perfFront] }])
    const made = (await ok('POST', '/production/work-orders', { siteId: A.siteA1, dueDate: due, lines: [{ salesOrderLineId: two }, { salesOrderLineId: three }] }, 201)).workOrder
    // Released as the release copies it (the route's own checks are W1's and B-W2b-F40's tests): steps 10, 20, 30.
    const steps = await admin<{ seq: number; code: string; name: string; minutes: string; kind: string }>(`SELECT seq, code, name, "standardMinutes"::text AS minutes, "workCentreKind"::text AS kind FROM "RoutingOperation" WHERE "revisionId" = $1 ORDER BY seq`, [options.jacketRevisionId])
    for (const step of steps) {
      await forced(
        `INSERT INTO "WorkOrderOperation" (id, "tenantId", "siteId", "workOrderId", "styleRevisionId", seq, "routingSeq", code, name, "standardMinutes", "scanRequired", "workCentreId") VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9::numeric, true, $10)`,
        [newId(), A.tenant, A.siteA1, made.id, options.jacketRevisionId, step.seq, step.code, step.name, step.minutes, A.centre(step.kind === 'SEWING' ? 'SEW' : 'CUT')],
      )
    }
    await forced(`UPDATE "WorkOrder" SET status = 'RELEASED', "releasedAt" = now() WHERE id = $1`, [made.id])
    const cell = await ok('GET', `/planning/capacity/cell?siteId=${A.siteA1}&laneKind=WORK_CENTRE&laneId=${A.centre('CUT')}&from=${due}&to=${due}`)
    const mine = (cell.orders as Json[]).filter((entry) => entry.workOrder.id === made.id).map((entry) => [entry.operation.seq, entry.pieces])
    expect(mine.sort((a, b) => a[0] - b[0])).toEqual([
      [10, 5],
      [PERF, 3],
    ])
  })
})

describe('XF4:04 a subcontract order made by hand: a qualified workshop, its operations outsourced', { timeout: 90_000 }, () => {
  it('refuses P2 while it is not approved for packing; approved, the order is made and the packing goes outside naming it', async () => {
    const workOrderId = subcontract.production.workOrderId
    const pack = subcontract.production.operationIds.pack
    const body = { workOrderId, partyId: A.P2, operations: [{ workOrderOperationId: pack }], expectedBackDate: day(10) }
    const held = await ok('POST', '/purchasing/subcontracting/orders', body, 409)
    expect(held.error.issues.map((issue: Json) => issue.path)).toEqual(['refusal/NOT_QUALIFIED'])
    expect(held.error.message).toMatch(/is not approved for Op 40 .+: Not approved for packing \(Op 40 .+\): not qualified for this work: no qualification covers it\.$/)
    expect((await admin(`SELECT outsourced FROM "WorkOrderOperation" WHERE id = $1`, [pack]))[0]).toEqual({ outsourced: false })

    await qualify(['PACKING'])
    const { order } = await ok('POST', '/purchasing/subcontracting/orders', body, 201)
    expect(order).toMatchObject({ status: 'DRAFT', workshop: expect.objectContaining({ id: A.P2 }) })
    expect((await admin(`SELECT outsourced, "subcontractOrderId" FROM "WorkOrderOperation" WHERE id = $1`, [pack]))[0]).toEqual({ outsourced: true, subcontractOrderId: order.id })
    const events = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'work_order_operation.outsourced' AND subject = $1`, [pack])
    expect(events.map((event) => event.payload)).toEqual([{ workOrderId, workOrderOperationId: pack, siteId: A.siteA1, outsourced: true, partyId: A.P2, subcontractOrderId: order.id }])
  })
})
