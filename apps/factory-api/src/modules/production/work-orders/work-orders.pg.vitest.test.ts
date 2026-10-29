import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase, type Prisma } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { MADE_TO_MEASURE_LATER } from '@nexus/factory-domain/production/work-orders/cells'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * Work orders from order lines with a frozen spec (B-W1-38; MES-001, MES-002, MES-005, MES-007, MES-076, MES-305; A1
 * §2.5 "Work order") on the local stack, with the app's real routes: a throwaway PostgreSQL 17 database from the
 * migrations (the runtime login, so row-level security, the column grants and the …_production_guards triggers are
 * real), the factory-db seeds of two tenants up to production (style SEED-JKT-02, PPE category II, sizes 50/52/54,
 * revision 1 RELEASED with its ACTIVE label template, BOM of leather per size and colour, lining and protectors, routing
 * cutting / sewing / final inspection / packing; plants A1 and B1 with CUT, SEW, QC and PACK work centres; WO-0001
 * released and in progress) and the numbering seed (WORK_ORDER WO-{N:5} and BATCH BA-/BB-{N:5}), and on top: a made-up
 * certificate covering SEED-JKT-02 in sizes 50 and 52 only, released leather, lining and protectors at A1 (black
 * leather only; the red leather waits for its Cr VI result) and a little at B1, and sales orders typed per test. Sessions
 * come from the test authenticator. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs work-orders`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = { a: 'work-orders-a', b: 'work-orders-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const lastId = (namespace: string, key: string) => `ffffffff${idOf(namespace, key).slice(8)}`
const A = {
  tenant: idOf(ns.a, 'tenant'),
  actor: idOf(ns.a, 'actor'),
  companyA: idOf(ns.a, 'company:A'),
  companyB: idOf(ns.a, 'company:B'),
  siteA1: idOf(ns.a, 'site:A1'),
  siteB1: idOf(ns.a, 'site:B1'),
  brand: idOf(ns.a, 'party:P1'),
  profile: idOf(ns.a, 'measurement:P1:rider:JACKET:1'),
  style: idOf(ns.a, 'production:style:JKT-02'),
  blk: idOf(ns.a, 'production:colourway:JKT-02:BLK'),
  red: idOf(ns.a, 'production:colourway:JKT-02:RED'),
  revision: lastId(ns.a, 'production:revision:JKT-02:1'),
  label: idOf(ns.a, 'production:label:JKT-02:1'),
  otherStyle: idOf(ns.a, 'product:style:JKT-01'),
  otherBlk: idOf(ns.a, 'product:colourway:JKT-01:BLK'),
  leather: idOf(ns.a, 'product:item:leather'),
  lining: idOf(ns.a, 'product:item:lining'),
  protector: idOf(ns.a, 'product:item:protector'),
  leatherBLK: idOf(ns.a, 'product:item-colour:leather:BLK'),
  leatherRED: idOf(ns.a, 'product:item-colour:leather:RED'),
  liningGRY: idOf(ns.a, 'product:item-colour:lining:GRY'),
  binA1: idOf(ns.a, 'inventory:location:A1-STORE-01'),
  storeB1: idOf(ns.a, 'inventory:location:B1-STORE'),
  packA1: idOf(ns.a, 'site:A1:work-centre:PACK'),
  seededWorkOrder: idOf(ns.a, 'production:work-order:WO-0001'),
}
const B = { tenant: idOf(ns.b, 'tenant') }

const ALL: Permission[] = ['workorders.view', 'workorders.manage', 'workorders.release']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  planner: office(A.tenant, [grant(ALL)]),
  manager: office(A.tenant, [grant(['workorders.view', 'workorders.manage'])]),
  viewer: office(A.tenant, [grant(['workorders.view'])]),
  companyB: office(A.tenant, [grant(ALL, [A.companyB])]),
  otherSite: office(A.tenant, [grant(ALL, [A.companyA], [idOf(ns.a, 'site:A2')])]),
  otherTenant: office(B.tenant, [grant(ALL)]),
  noWorkOrders: office(A.tenant, [grant(['planning.view'])]),
  floor: { audience: 'floor', tenantId: A.tenant, actorId: newId(), siteId: A.siteA1, deviceId: newId(), grants: [grant(['floor.work', ...ALL], [A.companyA], [A.siteA1])] },
  partner: { audience: 'partner', tenantId: A.tenant, actorId: newId(), partyId: A.brand, grants: [grant(ALL)] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
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
const asOffice = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>, tenantId = A.tenant) =>
  database.withScope({ audience: 'office', tenantId, actorId: A.actor }, (client) => client.$transaction(work))

/** A CONFIRMED sales order of company A (or B) for SEED-JKT-02 to the brand P1, typed by the office. */
let orders = 0
async function salesOrder(spec: {
  companyId?: string
  siteId?: string | null
  depositRequired?: boolean
  deposit?: 'OPEN' | 'PAID'
  promiseDate?: string
  lines: ({ colour: 'BLK' | 'RED'; sizes: Record<string, number>; styleId?: string; colourwayId?: string } | { madeToMeasure: true })[]
}): Promise<{ orderId: string; number: string; lineIds: string[]; depositId: string | null }> {
  const orderId = newId()
  const number = `T-${run}-SO-${++orders}`
  const lineIds: string[] = []
  let depositId: string | null = null
  await asOffice(async (tx) => {
    await tx.salesOrder.create({
      data: {
        id: orderId,
        companyId: spec.companyId ?? A.companyA,
        partyId: A.brand,
        number,
        status: 'CONFIRMED',
        orderDate: new Date('2026-10-20T00:00:00.000Z'),
        taxMode: 'IT_B2B',
        billTo: { legalName: 'Made-up customer' },
        shipTo: { name: 'Made-up workshop' },
        promiseDate: new Date(`${spec.promiseDate ?? '2026-12-10'}T00:00:00.000Z`),
        depositRequired: spec.depositRequired ?? false,
      },
      select: { id: true },
    })
    for (const [index, line] of spec.lines.entries()) {
      const lineId = newId()
      lineIds.push(lineId)
      const mtm = 'madeToMeasure' in line
      const pieces = mtm ? 1 : Object.values(line.sizes).reduce((sum, quantity) => sum + quantity, 0)
      await tx.salesOrderLine.create({
        data: {
          id: lineId,
          companyId: spec.companyId ?? A.companyA,
          orderId,
          partyId: A.brand,
          seq: (index + 1) * 10,
          kind: mtm ? 'MADE_TO_MEASURE' : 'SIZE_GRID',
          styleId: mtm ? A.style : (line.styleId ?? A.style),
          colourwayId: mtm ? A.blk : (line.colourwayId ?? (line.colour === 'BLK' ? A.blk : A.red)),
          measurementProfileId: mtm ? A.profile : null,
          baseSize: mtm ? '52' : null,
          quantity: pieces,
          unitPrice: '100.000000',
          netAmount: pieces * 10_000,
          vatRatePct: '22.00',
          vatAmount: pieces * 2_200,
          siteId: spec.siteId === undefined ? null : spec.siteId,
        },
        select: { id: true },
      })
      if (!mtm) await tx.salesOrderLineSize.createMany({ data: Object.entries(line.sizes).map(([size, quantity]) => ({ id: newId(), lineId, partyId: A.brand, size, quantity })) })
    }
    if (spec.deposit) {
      depositId = newId()
      await tx.depositRequest.create({
        data: {
          id: depositId,
          companyId: spec.companyId ?? A.companyA,
          partyId: A.brand,
          orderId,
          kind: 'ACCONTO',
          currency: 'EUR',
          amount: 30_000,
          dueDate: new Date('2026-11-20T00:00:00.000Z'),
          fiscalDocument: 'NONE',
          fiscalRule: 'MADE-UP-RULE',
          status: spec.deposit,
          paidAt: spec.deposit === 'PAID' ? new Date() : null,
        },
        select: { id: true },
      })
    }
  })
  return { orderId, number, lineIds, depositId }
}

/** A lot at a site with its stock in a location (leather: one hide), RELEASED or in quarantine waiting for Cr VI. */
async function stockLot(spec: { companyId: string; siteId: string; locationId: string; itemId: string; colourId: string | null; quantity: string; uom: string; leather?: 'PASS' | 'PENDING'; code: string }) {
  const lotId = newId()
  const leather = spec.leather !== undefined
  const pass = spec.leather === 'PASS' || !leather
  await admin(
    `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "qualityStatus", "qualityDecidedAt", "requiresCrViTest", "crViLimitMgKg", "crViStatus", "crViMgKg", "crViEvidence", "crViTestedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      lotId,
      A.tenant,
      spec.companyId,
      spec.siteId,
      spec.itemId,
      spec.colourId,
      spec.code,
      pass ? 'RELEASED' : 'QUARANTINE',
      pass ? new Date() : null,
      leather,
      leather ? '3.000' : null,
      leather ? (pass ? 'PASS' : 'PENDING') : 'NOT_REQUIRED',
      leather && pass ? '1.100' : null,
      leather && pass ? 'LOT_REPORT' : null,
      leather && pass ? '2026-10-01' : null,
    ],
  )
  const hideId = leather ? newId() : null
  if (hideId) {
    await admin(`INSERT INTO "Hide" (id, "tenantId", "siteId", "lotId", "itemId", code, area, "areaUom", "baseArea") VALUES ($1, $2, $3, $4, $5, $6, $7, 'FT2', $7)`, [hideId, A.tenant, spec.siteId, lotId, spec.itemId, `${spec.code}-H1`, spec.quantity])
  }
  await admin(
    `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "hideId", "toLocationId", quantity, uom, "baseQuantity", "idempotencyKey", "occurredAt")
     VALUES ($1, $2, $3, $4, 'OPENING', $5, $6, $7, $8, $9, $10, $11, $10, $12, now())`,
    [newId(), A.tenant, spec.companyId, spec.siteId, spec.itemId, spec.colourId, lotId, hideId, spec.locationId, spec.quantity, spec.uom, `work-orders-test-${spec.code}`],
  )
}

const create = (lines: { salesOrderLineId: string; sizes?: { size: string; quantity: number }[] }[], session = 'planner', more: Json = {}) => ok(session, 'POST', '/production/work-orders', { lines, ...more }, 201)
const release = (workOrderId: string, body: Json = {}, session = 'planner') => call(session, 'POST', `/production/work-orders/${workOrderId}/release`, body)
const releaseCheck = (workOrderId: string, session = 'planner') => ok(session, 'GET', `/production/work-orders/${workOrderId}/release-check`)
const checkOf = (answer: Json, code: string): Json => (answer.checks as Json[]).find((check) => check.code === code)!
/** A DRAFT of one order line's sizes. */
async function draft(lines: { colour: 'BLK' | 'RED'; sizes: Record<string, number> }[], spec: Omit<Parameters<typeof salesOrder>[0], 'lines'> = {}) {
  const order = await salesOrder({ ...spec, lines })
  const { workOrder } = await create(order.lineIds.map((salesOrderLineId) => ({ salesOrderLineId })))
  return { order, workOrder }
}

beforeAll(async () => {
  db = await migratedDatabase('work_orders')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 10 } })
  for (const namespace of [ns.a, ns.b]) {
    await seedCore({ db: database, namespace })
    await seedProduction({ db: database, namespace })
    await seedNumbering({ db: database, namespace })
  }
  // A certificate covering SEED-JKT-02 in sizes 50 and 52 (every colourway); size 54 is not covered.
  await asOffice(async (tx) => {
    const certificateId = newId()
    await tx.certificate.create({
      data: {
        id: certificateId,
        holderPartyId: A.brand,
        standard: 'EN 17092-3:2020',
        ppeClass: 'AA',
        number: 'TEST-CERT-0001',
        notifiedBodyName: 'Made-up Notified Body',
        notifiedBodyNumber: '9999',
        modelReference: 'SEED-JKT-02',
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
        validTo: new Date('2030-12-31T00:00:00.000Z'),
        status: 'VALID',
        statusChangedAt: new Date(),
      },
      select: { id: true },
    })
    await tx.certificateCoverage.create({ data: { id: newId(), certificateId, styleId: A.style, sizes: ['50', '52'] }, select: { id: true } })
  })
  // A1: plenty of black leather, lining and protectors; red leather only in quarantine (Cr VI pending).
  const atA1 = { companyId: A.companyA, siteId: A.siteA1, locationId: A.binA1 }
  await stockLot({ ...atA1, itemId: A.leather, colourId: A.leatherBLK, quantity: '2000.0000', uom: 'FT2', leather: 'PASS', code: `T-${run}-LEA-BLK` })
  await stockLot({ ...atA1, itemId: A.leather, colourId: A.leatherRED, quantity: '50.0000', uom: 'FT2', leather: 'PENDING', code: `T-${run}-LEA-RED` })
  await stockLot({ ...atA1, itemId: A.lining, colourId: A.liningGRY, quantity: '500.0000', uom: 'M', code: `T-${run}-LIN` })
  await stockLot({ ...atA1, itemId: A.protector, colourId: null, quantity: '1000.0000', uom: 'PCS', code: `T-${run}-PRO` })
  // B1: black leather for one of two small work orders only (150 ft²), lining and protectors for both.
  const atB1 = { companyId: A.companyB, siteId: A.siteB1, locationId: A.storeB1 }
  await stockLot({ ...atB1, itemId: A.leather, colourId: A.leatherBLK, quantity: '150.0000', uom: 'FT2', leather: 'PASS', code: `T-${run}-B-LEA` })
  await stockLot({ ...atB1, itemId: A.lining, colourId: A.liningGRY, quantity: '100.0000', uom: 'M', code: `T-${run}-B-LIN` })
  await stockLot({ ...atB1, itemId: A.protector, colourId: null, quantity: '100.0000', uom: 'PCS', code: `T-${run}-B-PRO` })
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

describe('a work order from order lines (MES-001, MES-002)', () => {
  it('makes a DRAFT of every open size, numbered, with the spec the release would freeze, audited and announced', async () => {
    const order = await salesOrder({ lines: [{ colour: 'BLK', sizes: { '50': 2, '52': 3 } }], promiseDate: '2026-12-10' })
    const { workOrder } = await create([{ salesOrderLineId: order.lineIds[0]! }])
    expect(workOrder).toMatchObject({
      number: 'WO-00001',
      batchNumber: null,
      status: 'DRAFT',
      kind: 'SIZE_GRID',
      version: 1,
      companyId: A.companyA,
      siteId: A.siteA1,
      site: { code: 'A1' },
      style: { id: A.style, code: 'SEED-JKT-02', ppeCategory: 'CATEGORY_II', sizes: ['50', '52', '54'] },
      revision: { id: A.revision, revision: 1, status: 'RELEASED' },
      labelTemplate: { id: A.label, code: 'SEED-LBL-JKT-02', status: 'ACTIVE' },
      dueDate: '2026-12-10',
      release: null,
      nextActions: ['RELEASED', 'CANCELLED'],
      orders: [{ id: order.orderId, number: order.number, partyId: A.brand, depositRequired: false }],
      pieces: 5,
      progress: { counted: false },
    })
    expect(workOrder.cells.map((cell: Json) => [cell.colourwayCode, cell.size, cell.quantity, cell.lineSeq, cell.progress])).toEqual([
      ['BLK', '50', 2, 10, { cut: null, sewn: null, finished: null }],
      ['BLK', '52', 3, 10, { cut: null, sewn: null, finished: null }],
    ])
    expect(workOrder.spec).toMatchObject({ frozen: false, frozenAt: null, standardMinutes: { perGarment: '122', allPieces: '610' } })
    expect(workOrder.spec.operations.map((op: Json) => [op.seq, op.code, op.standardMinutes, op.workCentreCode, op.id])).toEqual([
      [10, 'SEED-CUT-LEA', '14', 'CUT', null],
      [20, 'SEED-SEW-ASM', '96.5', 'SEW', null],
      [30, 'SEED-FIN-QC', '8', 'QC', null],
      [40, 'SEED-PACK', '3.5', 'PACK', null],
    ])
    // Leather: 43 × 1.12 × 2 + 45 × 1.12 × 3; lining 1.8 m × 1.05 × 5; protectors 2 × 5.
    expect(workOrder.spec.materials.map((material: Json) => [material.itemId, material.colourCode, material.planned, material.baseUom, material.issued])).toEqual([
      [A.leather, 'BLK', '247.52', 'FT2', '0'],
      [A.lining, 'GRY', '9.45', 'M', '0'],
      [A.protector, null, '10', 'PCS', '0'],
    ])
    const audit = await admin(`SELECT action, after FROM "AuditLog" WHERE "recordId" = $1`, [workOrder.id])
    expect(audit).toEqual([expect.objectContaining({ action: 'workorders.create', after: expect.objectContaining({ number: 'WO-00001', status: 'DRAFT', styleRevisionId: A.revision }) })])
    const [event] = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'workorder.created' AND subject = $1`, [workOrder.id])
    expect(event!.payload).toEqual({ workOrderId: workOrder.id, number: 'WO-00001', siteId: A.siteA1, styleId: A.style, salesOrderIds: [order.orderId], cells: 2, pieces: 5 })
    expect((await ok('viewer', 'GET', '/production/work-orders?late=true')).workOrders).toEqual([])
    // The seed's SEED-WO-0001 is in progress after its first cut.
    expect((await ok('viewer', 'GET', `/production/work-orders?status=IN_PROGRESS&styleId=${A.style}&siteId=${A.siteA1}`)).workOrders.map((row: Json) => row.number)).toEqual(['SEED-WO-0001'])
    const listed = await ok('viewer', 'GET', `/production/work-orders?salesOrderId=${order.orderId}`)
    expect(listed.workOrders).toEqual([expect.objectContaining({ id: workOrder.id, number: 'WO-00001', colourways: ['BLK'], pieces: 5, cells: 2, progress: null, daysLate: 0, orders: [expect.objectContaining({ number: order.number })] })])
  })

  it('takes only what is open on the line, one style, and refuses a made-to-measure line (deferred: 409)', async () => {
    const order = await salesOrder({ lines: [{ colour: 'BLK', sizes: { '50': 1, '52': 3 } }] })
    const line = order.lineIds[0]!
    await create([{ salesOrderLineId: line, sizes: [{ size: '52', quantity: 2 }] }])
    const open = await ok('viewer', 'GET', `/production/work-orders/open-lines?salesOrderId=${order.orderId}`)
    expect(open).toMatchObject({ numberPreview: 'WO-00003', lines: [{ id: line, madeToMeasure: false, sizes: [{ size: '50', ordered: 1, onWorkOrders: 0, open: 1 }, { size: '52', ordered: 3, onWorkOrders: 2, open: 1 }] }] })
    const tooMany = await refused('planner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: line, sizes: [{ size: '52', quantity: 2 }] }] }, 400)
    expect(tooMany.message).toBe(`${order.number} line 10 size 52: 3 ordered, 2 already on other work orders, so 1 can still be made; 2 asked.`)
    const notOrdered = await refused('planner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: line, sizes: [{ size: '54', quantity: 1 }] }] }, 400)
    expect(notOrdered.message).toBe(`${order.number} line 10 orders no size 54.`)
    // The rest of the line, then nothing is left.
    await create([{ salesOrderLineId: line }])
    expect((await refused('planner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: line }] }, 400)).message).toBe('Nothing is open to make on these order lines.')

    const mixed = await salesOrder({ lines: [{ colour: 'BLK', sizes: { '50': 1 } }, { colour: 'BLK', sizes: { '50': 1 }, styleId: A.otherStyle, colourwayId: A.otherBlk }] })
    const otherStyle = await refused('planner', 'POST', '/production/work-orders', { lines: mixed.lineIds.map((salesOrderLineId) => ({ salesOrderLineId })) }, 400)
    expect(otherStyle.issues).toContainEqual({ path: 'body/lines/1', message: `${mixed.number} line 20 is another style: a work order makes one style.` })

    const mtm = await salesOrder({ lines: [{ madeToMeasure: true }] })
    expect(await refused('planner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: mtm.lineIds[0]! }] }, 409)).toMatchObject({ code: 'conflict', message: MADE_TO_MEASURE_LATER })
    expect((await refused('viewer', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: line }] }, 403)).code).toBe('forbidden')
  })

  it("edits a DRAFT's cells and details under its version, and a cancelled one gives its pieces back", async () => {
    const order = await salesOrder({ lines: [{ colour: 'BLK', sizes: { '50': 2, '52': 3 } }, { colour: 'RED', sizes: { '50': 1 } }] })
    const [blkLine, redLine] = order.lineIds as [string, string]
    const { workOrder } = await create([{ salesOrderLineId: blkLine }])
    const url = `/production/work-orders/${workOrder.id}`
    const edited = await ok('manager', 'PUT', `${url}/cells`, {
      version: 1,
      cells: [
        { salesOrderLineId: blkLine, size: '50', quantity: 0 },
        { salesOrderLineId: blkLine, size: '52', quantity: 1 },
        { salesOrderLineId: redLine, size: '50', quantity: 1 },
      ],
    })
    expect(edited.workOrder.version).toBe(2)
    expect(edited.workOrder.cells.map((cell: Json) => [cell.colourwayCode, cell.size, cell.quantity])).toEqual([
      ['BLK', '52', 1],
      ['RED', '50', 1],
    ])
    expect(edited.workOrder.orders).toHaveLength(1)
    const stale = await refused('manager', 'PUT', `${url}/cells`, { version: 1, cells: [{ salesOrderLineId: blkLine, size: '52', quantity: 2 }] }, 409)
    expect(stale).toMatchObject({ code: 'conflict', message: expect.stringMatching(/now at version 2/) })
    const tooMany = await refused('manager', 'PUT', `${url}/cells`, { version: 2, cells: [{ salesOrderLineId: blkLine, size: '52', quantity: 4 }] }, 400)
    expect(tooMany.message).toMatch(/3 ordered, 0 already on other work orders, so 3 can still be made; 4 asked/)

    const details = await ok('manager', 'PATCH', url, { version: 2, dueDate: '2026-11-30', priority: 5, note: '  Rush for the fair  ' })
    expect(details.workOrder).toMatchObject({ version: 3, dueDate: '2026-11-30', priority: 5, note: 'Rush for the fair' })

    const cancelled = await ok('manager', 'POST', `${url}/cancel`, { version: 3, reason: 'Customer moved the sizes to another order' })
    expect(cancelled.workOrder).toMatchObject({ status: 'CANCELLED', cancelReason: 'Customer moved the sizes to another order', nextActions: [] })
    const open = await ok('viewer', 'GET', `/production/work-orders/open-lines?salesOrderId=${order.orderId}`)
    expect(open.lines.map((line: Json) => line.sizes.map((size: Json) => size.open))).toEqual([[2, 3], [1]])
    expect((await refused('manager', 'PUT', `${url}/cells`, { cells: [{ salesOrderLineId: blkLine, size: '52', quantity: 1 }] }, 409)).message).toMatch(/is CANCELLED; its cells are frozen/)
    const actions = await admin(`SELECT action FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at, id`, [workOrder.id])
    expect(actions.map((row) => row.action)).toEqual(['workorders.create', 'workorders.setCells', 'workorders.update', 'workorders.cancel'])
    const cellRows = await admin(`SELECT count(*)::int AS n FROM "AuditLog" WHERE action = 'workorders.setCell' AND coalesce(after, before)->>'salesOrderLineId' IN ($1, $2)`, [blkLine, redLine])
    expect(cellRows).toEqual([{ n: 3 }])
  })
})

describe('the release (MES-005, MES-076; A1 §2.5)', () => {
  let released: Json

  it('releases with everything in place: the frozen spec written, the label template frozen, a batch number, audited and announced', async () => {
    const { workOrder } = await draft([{ colour: 'BLK', sizes: { '50': 1, '52': 2 } }])
    const check = await releaseCheck(workOrder.id)
    expect(check).toMatchObject({ status: 'DRAFT', frozen: false, releasable: true, blockers: [] })
    expect(check.checks.map((entry: Json) => [entry.code, entry.state])).toEqual([
      ['REVISION', 'OK'],
      ['LABEL_TEMPLATE', 'OK'],
      ['CERTIFICATE', 'OK'],
      ['WORK_CENTRES', 'OK'],
      ['BOM', 'OK'],
      ['CELLS', 'OK'],
      ['DEPOSIT', 'NOT_REQUIRED'],
      ['MATERIAL', 'OK'],
      ['BATCH_NUMBER', 'OK'],
    ])
    expect(checkOf(check, 'CERTIFICATE').message).toBe("Certificate TEST-CERT-0001 (valid to 2030-12-31) covers every cell's colourway and size.")
    expect(check.materials.find((line: Json) => line.itemId === A.leather)).toMatchObject({ planned: '148.96', issued: '0', short: '0' })

    const response = await release(workOrder.id, { version: workOrder.version })
    expect(response.statusCode, response.body).toBe(200)
    released = response.json().workOrder
    expect(released).toMatchObject({
      status: 'RELEASED',
      batchNumber: 'BA-00001',
      version: workOrder.version + 1,
      revision: { id: A.revision, status: 'RELEASED' },
      labelTemplate: { id: A.label, status: 'ACTIVE' },
      release: { byId: expect.any(String), materialOverride: null },
      nextActions: ['IN_PROGRESS', 'CANCELLED'],
      spec: { frozen: true, frozenAt: expect.any(String) },
    })
    expect(released.spec.operations.every((op: Json) => typeof op.id === 'string')).toBe(true)
    const row = (await admin(`SELECT status, "batchNumber", "labelTemplateId", "styleRevisionId", "releasedAt" IS NOT NULL AS stamped FROM "WorkOrder" WHERE id = $1`, [workOrder.id]))[0]
    expect(row).toEqual({ status: 'RELEASED', batchNumber: 'BA-00001', labelTemplateId: A.label, styleRevisionId: A.revision, stamped: true })
    // One operation per routing step, copied exactly, at A1's work centres; BOM line × cell planned.
    const operations = await admin(
      `SELECT o.seq, o."routingSeq", o.code = r.code AND o.name = r.name AND o."standardMinutes" = r."standardMinutes" AND o."scanRequired" = r."scanRequired" AS copied, w.kind::text = r."workCentreKind"::text AS kind, w."siteId" = $2 AS here
         FROM "WorkOrderOperation" o JOIN "RoutingOperation" r ON r."revisionId" = o."styleRevisionId" AND r.seq = o."routingSeq" JOIN "WorkCentre" w ON w.id = o."workCentreId"
        WHERE o."workOrderId" = $1 ORDER BY o.seq`,
      [workOrder.id, A.siteA1],
    )
    expect(operations).toEqual([10, 20, 30, 40].map((seq) => ({ seq, routingSeq: seq, copied: true, kind: true, here: true })))
    const materials = await admin(`SELECT "itemId", quantity::text AS q FROM "WorkOrderMaterial" WHERE "workOrderId" = $1 ORDER BY "itemId", quantity`, [workOrder.id])
    expect(materials).toHaveLength(6)
    expect(materials.filter((m) => m.itemId === A.leather).map((m) => m.q)).toEqual(['48.1600', '100.8000'])
    expect(await admin(`SELECT kind::text, formatted FROM "NumberAllocation" WHERE "recordId" = $1 ORDER BY kind`, [workOrder.id])).toEqual([
      { kind: 'BATCH', formatted: 'BA-00001' },
      { kind: 'WORK_ORDER', formatted: workOrder.number },
    ])
    const audit = (await admin(`SELECT after, reason FROM "AuditLog" WHERE "recordId" = $1 AND action = 'workorders.release'`, [workOrder.id]))[0]!
    expect(audit).toMatchObject({ reason: null, after: { status: 'RELEASED', batchNumber: 'BA-00001', operations: 4, materials: 6, pieces: 3, materialOverride: null } })
    const [event] = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'workorder.released' AND subject = $1`, [workOrder.id])
    expect(event!.payload).toMatchObject({ number: workOrder.number, batchNumber: 'BA-00001', styleRevisionId: A.revision, labelTemplateId: A.label, cells: 2, pieces: 3, operations: 4, materials: 6, materialOverride: false })
    expect(await releaseCheck(workOrder.id)).toMatchObject({ status: 'RELEASED', frozen: true, releasable: false, checks: [] })
  })

  it('is frozen after the release: the API answers 409 before the database, which refuses any edit itself', async () => {
    const url = `/production/work-orders/${released.id}`
    expect((await refused('planner', 'PUT', `${url}/cells`, { cells: [{ salesOrderLineId: released.cells[0].salesOrderLineId, size: '50', quantity: 1 }] }, 409)).message).toMatch(/is RELEASED; its cells are frozen/)
    expect((await refused('planner', 'PATCH', url, { styleRevisionId: newId() }, 409)).message).toBe(`Work order ${released.number} is RELEASED; its revision is frozen (a different specification is a new work order).`)
    expect((await release(released.id)).statusCode).toBe(409)
    await expect(asOffice((tx) => tx.workOrderSize.update({ where: { id: released.cells[0].id }, data: { quantity: 5 } }))).rejects.toThrow(/frozen/)
    await expect(asOffice((tx) => tx.workOrderMaterial.updateMany({ where: { workOrderId: released.id }, data: { quantity: '1' } }))).rejects.toThrow(/frozen/)
    await expect(asOffice((tx) => tx.workOrderOperation.updateMany({ where: { workOrderId: released.id }, data: { name: 'Something else' } }))).rejects.toThrow(/frozen/)
    await expect(asOffice((tx) => tx.workOrder.update({ where: { id: released.id }, data: { batchNumber: 'BA-99999' } }))).rejects.toThrow(/never change/)
    // The due date and priority still move.
    expect((await ok('planner', 'PATCH', url, { dueDate: '2026-12-01', priority: 2 })).workOrder).toMatchObject({ dueDate: '2026-12-01', priority: 2 })
  })

  it('holds the release while the order waits for its deposit, and releases once it is paid (the deposit gate)', async () => {
    const { order, workOrder } = await draft([{ colour: 'BLK', sizes: { '50': 1 } }], { depositRequired: true, deposit: 'OPEN' })
    const error = await (async () => {
      const response = await release(workOrder.id)
      expect(response.statusCode, response.body).toBe(409)
      return response.json().error
    })()
    expect(error).toEqual({
      code: 'invalid_state',
      message: `Work order ${workOrder.number} cannot be released yet: 1 problem(s) to fix first (deposit).`,
      requestId: expect.any(String),
      issues: [{ path: `orders/${order.orderId}/deposit`, message: `${order.number} waits for its deposit (due 2026-11-20): production starts when it is paid or waived.` }],
    })
    expect((await admin(`SELECT status FROM "WorkOrder" WHERE id = $1`, [workOrder.id]))[0]).toEqual({ status: 'DRAFT' })
    await admin(`UPDATE "DepositRequest" SET status = 'PAID', "paidAt" = now() WHERE id = $1`, [order.depositId])
    expect(checkOf(await releaseCheck(workOrder.id), 'DEPOSIT')).toMatchObject({ state: 'OK', message: `${order.number}'s deposit is paid.` })
    expect((await release(workOrder.id)).statusCode).toBe(200)
  })

  it('refuses a cell no valid certificate covers (size 54), naming the cell', async () => {
    const { workOrder } = await draft([{ colour: 'BLK', sizes: { '52': 1, '54': 1 } }])
    const response = await release(workOrder.id)
    expect(response.statusCode, response.body).toBe(409)
    const error = response.json().error
    expect(error.message).toBe(`Work order ${workOrder.number} cannot be released yet: 1 problem(s) to fix first (certificate).`)
    const cell = workOrder.cells.find((entry: Json) => entry.size === '54')
    expect(error.issues).toEqual([{ path: `cells/${cell.id}/certificate`, message: 'BLK 54: Certificate TEST-CERT-0001 (EN 17092-3:2020, notified body 9999) does not cover size 54 of style SEED-JKT-02 (it covers 50, 52).' }])
  })

  it("refuses a short material without the planner's override, says why the stock there is not usable, and releases with a reason", async () => {
    const { workOrder } = await draft([{ colour: 'RED', sizes: { '50': 1 } }])
    const check = await releaseCheck(workOrder.id)
    expect(check.releasable).toBe(false)
    expect(checkOf(check, 'MATERIAL')).toMatchObject({ state: 'BLOCKED' })
    const red = check.materials.find((line: Json) => line.itemId === A.leather)
    // SEED-WO-0001 (released, in progress) still needs its red leather: 48.16 + 50.4 + 53.2.
    expect(red).toMatchObject({ planned: '48.16', usable: '0', committed: '151.76', short: '48.16', held: [{ reason: 'CR_VI_PENDING', quantity: '50' }] })
    const refusal = (await release(workOrder.id)).json().error
    expect(refusal.message).toMatch(/1 problem\(s\) to fix first \(material\)/)
    expect(refusal.issues).toEqual([
      {
        path: `materials/${A.leather}/${A.leatherRED}`,
        message: 'SEED-LEA-100 RED: 48.16 FT2 needed, 0 usable on hand and 151.76 promised to other released work orders, so 48.16 FT2 short. On hand but not usable: 50 FT2 no chromium VI test result yet.',
      },
    ])
    expect((await release(workOrder.id, { materialOverride: { reason: 'x' } })).statusCode).toBe(400)
    expect((await release(workOrder.id, {}, 'manager')).statusCode).toBe(403)
    const reason = 'The red lot passes its Cr VI test on Monday; cutting starts Tuesday'
    const response = await release(workOrder.id, { materialOverride: { reason } })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().workOrder.release).toMatchObject({ materialOverride: { reason, shortages: [expect.stringMatching(/^SEED-LEA-100 RED: 48.16 FT2 needed/)] } })
    const audit = (await admin(`SELECT reason, after->'materialOverride'->>'reason' AS override FROM "AuditLog" WHERE "recordId" = $1 AND action = 'workorders.release'`, [workOrder.id]))[0]
    expect(audit).toEqual({ reason, override: reason })
    const [event] = await admin(`SELECT payload->>'materialOverride' AS flag FROM "OutboxEvent" WHERE type = 'workorder.released' AND subject = $1`, [workOrder.id])
    expect(event).toEqual({ flag: 'true' })
    // The record reads it back from the audit row.
    expect((await ok('viewer', 'GET', `/production/work-orders/${workOrder.id}`)).workOrder.release.materialOverride).toMatchObject({ reason })
  })

  it('names a revision that is not released and its missing label template and routing', async () => {
    const revision2 = newId()
    await asOffice((tx) => tx.styleRevision.create({ data: { id: revision2, styleId: A.style, revision: 2, status: 'DRAFT', changeNote: 'Made-up next revision.' }, select: { id: true } }))
    const { workOrder } = await draft([{ colour: 'BLK', sizes: { '52': 1 } }])
    const changed = await ok('planner', 'PATCH', `/production/work-orders/${workOrder.id}`, { styleRevisionId: revision2 })
    expect(changed.workOrder).toMatchObject({ revision: { id: revision2, revision: 2, status: 'DRAFT' }, labelTemplate: null, spec: { operations: [], materials: [] } })
    const error = (await release(workOrder.id)).json().error
    expect(error.message).toBe(`Work order ${workOrder.number} cannot be released yet: 3 problem(s) to fix first (revision, label template, work centres).`)
    expect(error.issues).toEqual([
      { path: 'checks/REVISION', message: "Revision 2 is DRAFT; a work order is released only with a RELEASED revision. The style's released revision now is 1: choose it on the work order." },
      { path: 'checks/LABEL_TEMPLATE', message: 'Revision 2 names no garment label template: set one on the revision before it is released (Product › Labels).' },
      { path: 'checks/WORK_CENTRES', message: "The revision's routing has no step: the floor would have nothing to scan." },
    ])
    // The frozen spec against today's master: the draft's revision 2 against the released revision 1.
    const compare = await ok('viewer', 'GET', `/production/work-orders/${workOrder.id}/spec/compare`)
    expect(compare).toMatchObject({ revision: { revision: 2 }, master: { revision: { id: A.revision, revision: 1 } }, sameRevision: false, labelChanged: true })
    expect(compare.summary[0]).toBe("The style's released revision is now 1; the work order keeps revision 2.")
    expect(compare.bom.added).toHaveLength(3)
    expect(compare.routing.added.map((step: Json) => step.code)).toEqual(['SEED-CUT-LEA', 'SEED-SEW-ASM', 'SEED-FIN-QC', 'SEED-PACK'])
    // Back to the released revision: releasable again.
    await ok('planner', 'PATCH', `/production/work-orders/${workOrder.id}`, { styleRevisionId: A.revision })
    expect((await releaseCheck(workOrder.id)).releasable).toBe(true)
  })

  it('names a kind of work the site has no active work centre for', async () => {
    const { workOrder } = await draft([{ colour: 'BLK', sizes: { '50': 1 } }])
    await admin(`UPDATE "WorkCentre" SET status = 'ARCHIVED' WHERE id = $1`, [A.packA1])
    try {
      const error = (await release(workOrder.id)).json().error
      expect(error.issues).toEqual([{ path: 'checks/WORK_CENTRES/PACKING', message: 'No active PACKING work centre on site A1 for step 40 SEED-PACK (Pack).' }])
      expect(checkOf(await releaseCheck(workOrder.id), 'WORK_CENTRES').message).toBe('Site A1 has no active work centre for PACKING: add one, or release a routing the site can make.')
    } finally {
      await admin(`UPDATE "WorkCentre" SET status = 'ACTIVE' WHERE id = $1`, [A.packA1])
    }
    expect((await release(workOrder.id)).statusCode).toBe(200)
  })

  it('compares the frozen spec with the master: nothing changed while its revision is still released', async () => {
    const compare = await ok('viewer', 'GET', `/production/work-orders/${released.id}/spec/compare`)
    expect(compare).toMatchObject({ frozen: true, sameRevision: true, noMaster: false, labelChanged: false, summary: ["Revision 1 is still the style's released revision: nothing changed."], certificate: { state: 'OK' } })
    expect(compare.bom).toMatchObject({ added: [], removed: [], changed: [], unchanged: 3 })
  })
})

describe('the moves after the release (MES-007)', () => {
  it('starts, completes and closes with their times; cancels only with a reason; CLOSED is final', async () => {
    const { workOrder } = await draft([{ colour: 'BLK', sizes: { '52': 1 } }])
    const url = `/production/work-orders/${workOrder.id}`
    expect((await refused('planner', 'POST', `${url}/start`, {}, 409)).message).toBe('A work order in DRAFT cannot move to IN_PROGRESS (from DRAFT it can go to RELEASED, CANCELLED).')
    expect((await release(workOrder.id)).statusCode).toBe(200)
    expect((await ok('planner', 'POST', `${url}/start`, {})).workOrder).toMatchObject({ status: 'IN_PROGRESS', startedAt: expect.any(String) })
    expect((await refused('planner', 'POST', `${url}/cancel`, { reason: ' ' }, 400)).code).toBe('validation_failed')
    expect((await ok('planner', 'POST', `${url}/complete`, {})).workOrder).toMatchObject({ status: 'COMPLETED', completedAt: expect.any(String), daysLate: null })
    expect((await refused('planner', 'POST', `${url}/cancel`, { reason: 'Too late' }, 409)).message).toMatch(/cannot move to CANCELLED/)
    expect((await ok('planner', 'POST', `${url}/close`, {})).workOrder).toMatchObject({ status: 'CLOSED', closedAt: expect.any(String), nextActions: [] })
    expect((await refused('planner', 'PATCH', url, { priority: 9 }, 409)).message).toBe(`Work order ${workOrder.number} is CLOSED; only its note changes.`)
    expect((await ok('planner', 'PATCH', url, { note: 'Closed after the fair' })).workOrder.note).toBe('Closed after the fair')
    const events = await admin(`SELECT payload->>'to' AS "to" FROM "OutboxEvent" WHERE type = 'workorder.status_changed' AND subject = $1 ORDER BY "occurredAt", id`, [workOrder.id])
    expect(events.map((event) => event.to)).toEqual(['IN_PROGRESS', 'COMPLETED', 'CLOSED'])
  })
})

describe('the walls (A1 §2.2): tenant, company, site; the floor reads and never changes', () => {
  it('finds nothing of another tenant, company or site, and refuses the floor, partner and the unpermitted', async () => {
    const { order, workOrder } = await draft([{ colour: 'BLK', sizes: { '50': 1 } }])
    const url = `/production/work-orders/${workOrder.id}`
    expect((await refused('otherTenant', 'GET', url, undefined, 404)).message).toBe('Work order not found.')
    expect((await refused('companyB', 'GET', url, undefined, 404)).message).toBe('Work order not found.')
    expect((await refused('otherSite', 'GET', url, undefined, 404)).message).toBe('Work order not found.')
    // Tenant B sees its own seeded work orders only.
    const seenByB = (await ok('otherTenant', 'GET', '/production/work-orders')).workOrders as Json[]
    expect(seenByB.map((row) => row.id)).not.toContain(workOrder.id)
    expect(seenByB.some((row) => row.companyId === A.companyA || row.companyId === A.companyB)).toBe(false)
    expect((await ok('companyB', 'GET', '/production/work-orders')).workOrders.every((row: Json) => row.companyId === A.companyB)).toBe(true)
    expect((await ok('otherSite', 'GET', '/production/work-orders')).workOrders).toEqual([])
    expect((await refused('companyB', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: order.lineIds[0]! }] }, 404)).message).toBe('Sales order line not found.')
    expect((await refused('companyB', 'GET', `/production/work-orders/open-lines?salesOrderId=${order.orderId}`, undefined, 404)).message).toBe('Sales order not found.')
    for (const session of ['floor', 'partner', 'noWorkOrders']) {
      expect((await call(session, 'GET', url)).statusCode).toBe(403)
      expect((await call(session, 'POST', `${url}/release`, {})).statusCode).toBe(403)
    }
    expect((await call('viewer', 'POST', `${url}/release`, {})).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401)
  })

  it("lets a floor device read its own site's work orders through row-level security, and change none", async () => {
    const floor = (siteId: string) => ({ audience: 'floor' as const, tenantId: A.tenant, actorId: newId(), siteId })
    const seen = await database.withScope(floor(A.siteA1), (client) => client.workOrder.findMany({ select: { id: true, siteId: true } }))
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((row) => row.siteId === A.siteA1)).toBe(true)
    expect(seen.map((row) => row.id)).toContain(A.seededWorkOrder)
    expect(await database.withScope(floor(A.siteB1), (client) => client.workOrder.count({ where: { siteId: A.siteA1 } }))).toBe(0)
    await expect(database.withScope(floor(A.siteA1), (client) => client.workOrder.updateMany({ where: { id: A.seededWorkOrder }, data: { priority: 9 } }))).rejects.toThrow(/permission denied/)
    await expect(database.withScope(floor(A.siteA1), (client) => client.workOrderSize.deleteMany({ where: { workOrderId: A.seededWorkOrder } }))).rejects.toThrow(/permission denied/)
  })
})

describe('releases at once take their turns (one transaction each, the site release lock)', () => {
  it('releases one work order once when two releases of it race', async () => {
    const { workOrder } = await draft([{ colour: 'BLK', sizes: { '50': 1 } }])
    const answers = await Promise.all([release(workOrder.id), release(workOrder.id)])
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 409])
    expect(await admin(`SELECT count(*)::int AS n FROM "NumberAllocation" WHERE "recordId" = $1 AND kind = 'BATCH'`, [workOrder.id])).toEqual([{ n: 1 }])
    expect(await admin(`SELECT count(*)::int AS n FROM "WorkOrderOperation" WHERE "workOrderId" = $1`, [workOrder.id])).toEqual([{ n: 4 }])
  })

  it('releases one of two work orders of one order racing for leather enough for one, and refuses the other short', async () => {
    const order = await salesOrder({ companyId: A.companyB, siteId: A.siteB1, lines: [{ colour: 'BLK', sizes: { '50': 2, '52': 2 } }] })
    const line = order.lineIds[0]!
    // 96.32 ft² and 100.8 ft²: each fits in B1's 150 ft², both do not.
    const first = (await create([{ salesOrderLineId: line, sizes: [{ size: '50', quantity: 2 }] }])).workOrder
    const second = (await create([{ salesOrderLineId: line, sizes: [{ size: '52', quantity: 2 }] }])).workOrder
    expect(first).toMatchObject({ number: 'WO-00001', siteId: A.siteB1, companyId: A.companyB })
    expect((await releaseCheck(first.id)).releasable).toBe(true)
    expect((await releaseCheck(second.id)).releasable).toBe(true)
    const answers = await Promise.all([release(first.id), release(second.id)])
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 409])
    const refusal = answers.find((answer) => answer.statusCode === 409)!.json().error
    expect(refusal.message).toMatch(/\(material\)/)
    expect(refusal.issues[0].message).toMatch(/^SEED-LEA-100 BLK: (96.32|100.8) FT2 needed, 150 usable on hand and (100.8|96.32) promised to other released work orders/)
    const won = answers.find((answer) => answer.statusCode === 200)!.json().workOrder
    expect(won.batchNumber).toBe('BB-00001')
  })
})
