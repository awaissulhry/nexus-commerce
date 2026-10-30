import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase, type Prisma } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * Scrap, rework, split and yield (B-W2a-13; MES-071, MES-126, MES-129, MES-130, MES-057) on the local stack with the
 * app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security, the
 * column grants and the …_production_guards and …_production_w2a_guards triggers are real), the factory-db seeds of two
 * tenants up to production (plant A1 names workers; its operator acknowledged the worker notice; company A's floor is
 * ready), the numbering seed, a made-up certificate, made-up lots of large black hides at A1, and made-up tablets at
 * A1's cutting table, sewing station SEW-01, inspection and packing benches. Released work orders of black jackets in
 * size 50 are made through the work-order routes, cut, bundled (PDF tickets) and scanned through the floor's routes. The
 * seeded routing: 10 cut, 20 sew, 30 final check, 40 pack. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/production/rework`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = { a: 'rework-a', b: 'rework-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const A = {
  tenant: idOf(ns.a, 'tenant'),
  actor: idOf(ns.a, 'actor'),
  companyA: idOf(ns.a, 'company:A'),
  companyB: idOf(ns.a, 'company:B'),
  siteA1: idOf(ns.a, 'site:A1'),
  brand: idOf(ns.a, 'party:P1'),
  style: idOf(ns.a, 'production:style:JKT-02'),
  blk: idOf(ns.a, 'production:colourway:JKT-02:BLK'),
  leather: idOf(ns.a, 'product:item:leather'),
  leatherBLK: idOf(ns.a, 'product:item-colour:leather:BLK'),
  bin: idOf(ns.a, 'inventory:location:A1-STORE-01'),
  cutStation: idOf(ns.a, 'site:A1:station:CUT-01'),
  sew1Station: idOf(ns.a, 'site:A1:station:SEW-01'),
  qcStation: idOf(ns.a, 'site:A1:station:QC-01'),
  packStation: idOf(ns.a, 'site:A1:station:PACK-01'),
  cutter: idOf(ns.a, 'device:A1:cutting'),
  sew1: newId(),
  qc: newId(),
  pack: newId(),
  operatorA1: idOf(ns.a, 'worker:A1:operator'),
  manager: newId(),
  approver: newId(),
  approver2: newId(),
}
const B = { tenant: idOf(ns.b, 'tenant') }

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (tenantId: string, grants: Grant[], actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId, actorId, grants })
const FLOOR: Permission[] = ['floor.work', 'production.cut', 'production.bundles', 'production.scan', 'production.rework', 'inventory.issue', 'print.view', 'print.labels']
const floor = (deviceId: string, permissions: Permission[] = FLOOR): SessionContext => ({ audience: 'floor', tenantId: A.tenant, actorId: A.operatorA1, siteId: A.siteA1, deviceId, grants: [grant(permissions, [A.companyA], [A.siteA1])] })
const MANAGE: Permission[] = ['workorders.view', 'production.rework', 'production.scrap.view', 'production.scrap', 'production.bundles', 'production.cutting.view', 'inventory.stock.view', 'inventory.reserve']
const SESSIONS: Record<string, SessionContext> = {
  planner: office(A.tenant, [grant(['workorders.view', 'workorders.manage', 'workorders.release'])]),
  manager: office(A.tenant, [grant(MANAGE)], A.manager),
  /** A planner: asks and approves lower order quantities (never their own: four eyes). */
  approver: office(A.tenant, [grant(['production.scrap.view', 'production.scrap', 'production.scrap.approve'])], A.approver),
  approver2: office(A.tenant, [grant(['production.scrap.view', 'production.scrap.approve'])], A.approver2),
  /** The manager's grants with the cost grain: sees the scrap's value. */
  costs: office(A.tenant, [grant([...MANAGE, 'money.cost'])], A.manager),
  viewer: office(A.tenant, [grant(['workorders.view'])]),
  companyB: office(A.tenant, [grant(MANAGE, [A.companyB])]),
  otherTenant: office(B.tenant, [grant(MANAGE)]),
  cutter: floor(A.cutter),
  sew1: floor(A.sew1),
  qc: floor(A.qc),
  pack: floor(A.pack),
  /** A floor device without production.rework. */
  noRework: floor(A.pack, ['floor.work', 'production.scan']),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `t-${run}-${++keys}`
let scansSent = 0
const clientId = () => `sc-${run}-${++scansSent}`
const call = (session: string, method: Method, url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const refusalOf = (error: Json): string => String(error.issues?.[0]?.path ?? '')
const fixOf = (error: Json): string => String(error.issues?.find((issue: Json) => issue.path === 'fix')?.message ?? '')
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : []
const MONEY = /cost|price|margin|amount|wage|valuation/i
const counts = async (sql: string, values: unknown[]) => (await admin<{ n: number }>(sql, values))[0]!.n
const asOffice = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) => client.$transaction(work, { timeout: 30_000 }))

// ---- made-up stock, work orders, cuts and bundles --------------------------------------------------------------------------------

const hides: Record<string, { id: string; code: string }> = {}

async function addHides(count: number, from = 1, lotKey = 'BIG') {
  const lotId = newId()
  await admin(
    `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "dyeBatch", "qualityStatus", "qualityDecidedAt", "requiresCrViTest", "crViLimitMgKg", "crViStatus", "crViMgKg", "crViEvidence", "crViTestedAt", "receivedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, '7731', 'RELEASED', now(), true, '3.000', 'PASS', '1.100', 'LOT_REPORT', '2026-10-01', '2026-10-05T08:00:00Z')`,
    [lotId, A.tenant, A.companyA, A.siteA1, A.leather, A.leatherBLK, `T-${run}-${lotKey}`],
  )
  for (let index = from; index < from + count; index++) {
    const key = `H${String(index).padStart(2, '0')}`
    const hideId = newId()
    hides[key] = { id: hideId, code: `T-${run}-${key}` }
    await admin(`INSERT INTO "Hide" (id, "tenantId", "siteId", "lotId", "itemId", code, area, "areaUom", "baseArea", grade, "thicknessMm") VALUES ($1, $2, $3, $4, $5, $6, '1000.0000', 'FT2', '1000.0000', 'A', '1.10')`, [
      hideId,
      A.tenant,
      A.siteA1,
      lotId,
      A.leather,
      hides[key]!.code,
    ])
    await admin(
      `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "hideId", "toLocationId", quantity, uom, "baseQuantity", "idempotencyKey", "occurredAt")
       VALUES ($1, $2, $3, $4, 'OPENING', $5, $6, $7, $8, $9, '1000.0000', 'FT2', '1000.0000', $10, now())`,
      [newId(), A.tenant, A.companyA, A.siteA1, A.leather, A.leatherBLK, lotId, hideId, A.bin, `rework-test-${run}-${key}`],
    )
  }
  return lotId
}

/** A CONFIRMED sales order line of company A for black SEED-JKT-02, typed by the office. */
async function salesOrder(sizes: Record<string, number>): Promise<string> {
  const orderId = newId()
  const lineId = newId()
  const pieces = Object.values(sizes).reduce((sum, value) => sum + value, 0)
  await asOffice(async (tx) => {
    await tx.salesOrder.create({
      data: {
        id: orderId,
        companyId: A.companyA,
        partyId: A.brand,
        number: `T-${run}-SO`,
        status: 'CONFIRMED',
        orderDate: new Date('2026-10-20T00:00:00.000Z'),
        taxMode: 'IT_B2B',
        billTo: { legalName: 'Made-up customer' },
        shipTo: { name: 'Made-up workshop' },
        promiseDate: new Date('2026-12-10T00:00:00.000Z'),
        depositRequired: false,
      },
      select: { id: true },
    })
    await tx.salesOrderLine.create({
      data: { id: lineId, companyId: A.companyA, orderId, partyId: A.brand, seq: 10, kind: 'SIZE_GRID', styleId: A.style, colourwayId: A.blk, quantity: pieces, unitPrice: '100.000000', netAmount: pieces * 10_000, vatRatePct: '22.00', vatAmount: pieces * 2_200, siteId: A.siteA1 },
      select: { id: true },
    })
    for (const [size, quantity] of Object.entries(sizes)) await tx.salesOrderLineSize.create({ data: { id: newId(), lineId, partyId: A.brand, size, quantity }, select: { id: true } })
  })
  return lineId
}

async function releasedWorkOrder(lineId: string, size50: number): Promise<Json> {
  const { workOrder } = await ok('planner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: lineId, sizes: [{ size: '50', quantity: size50 }] }] }, 201)
  const released = await ok('planner', 'POST', `/production/work-orders/${workOrder.id}/release`, { materialOverride: { reason: 'The rest of the leather arrives next week' } })
  expect(released.workOrder.status).toBe('RELEASED')
  return released.workOrder
}

/** Cuts every garment of the work order from one hide and makes its bundles (PDF tickets), through the floor's routes. */
async function cutAndBundle(workOrder: Json, hideKey: string, bundleSize: number): Promise<{ bundles: Json[]; cut: Json }> {
  const cut = await call('cutter', 'POST', `/production/cutting/work-orders/${workOrder.id}/cuts`, { clientEventId: clientId(), code: hides[hideKey]!.code, lines: workOrder.cells.map((cell: Json) => ({ workOrderSizeId: cell.id, sets: cell.quantity })) }, freshKey())
  expect(cut.statusCode, cut.body).toBe(201)
  const made = await call('cutter', 'POST', `/production/bundles/work-orders/${workOrder.id}/bundles`, { bundleSize, printerId: null }, freshKey())
  expect(made.statusCode, made.body).toBe(201)
  return { bundles: made.json().bundles, cut: cut.json().cut }
}

const OPS = {} as Record<'cut' | 'sew' | 'qc' | 'pack', string>
type Orders = 'flow' | 'held' | 'stock'
const WO = {} as Record<Orders, Json>
const BN = {} as Record<Orders, Json[]>
const CUT = {} as Record<Orders, Json>
let bigLot = ''

const report = (session: string, bundle: Json, good: number, extra: Json = {}) => call(session, 'POST', '/production/scans', { clientScanId: clientId(), code: bundle.code, good, ...extra })
async function reported(session: string, bundle: Json, good: number, extra: Json = {}): Promise<Json> {
  const response = await report(session, bundle, good, extra)
  expect(response.statusCode, response.body).toBe(201)
  return response.json().scan
}
async function refusedReport(session: string, bundle: Json, good: number, extra: Json = {}): Promise<Json> {
  const response = await report(session, bundle, good, extra)
  expect(response.statusCode, response.body).toBe(409)
  return response.json().error
}
const post = (session: string, url: string, body: Json) => call(session, 'POST', url, body, freshKey())

beforeAll(async () => {
  db = await migratedDatabase('rework')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 12 } })
  for (const namespace of [ns.a, ns.b]) {
    await seedCore({ db: database, namespace })
    await seedPrivacy({ db: database, namespace })
    await seedProduction({ db: database, namespace })
    await seedNumbering({ db: database, namespace })
  }
  await asOffice(async (tx) => {
    const certificateId = newId()
    await tx.certificate.create({
      data: {
        id: certificateId,
        holderPartyId: A.brand,
        standard: 'EN 17092-3:2020',
        ppeClass: 'AA',
        number: `T-${run}-CERT`,
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
  bigLot = await addHides(3)
  // Two hides of their own lot for the stock scrap (the reservation and the refusal).
  await addHides(2, 8, 'SCRAP')
  for (const [deviceId, stationId, name] of [
    [A.sew1, A.sew1Station, 'Sewing tablet 1'],
    [A.qc, A.qcStation, 'Inspection tablet'],
    [A.pack, A.packStation, 'Packing tablet'],
  ] as const) {
    await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, $6, 'TABLET', 'ACTIVE', now())`, [deviceId, A.tenant, A.companyA, A.siteA1, stationId, name])
  }
  for (const [id, name] of [
    [A.manager, 'Made-up production manager'],
    [A.approver, 'Made-up planner'],
    [A.approver2, 'Made-up second planner'],
  ] as const) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [id, A.tenant, `${id}-${run}@example.test`, name])
  }

  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  const line = await salesOrder({ '50': 40 })
  for (const [name, pieces, hide, size] of [
    ['flow', 12, 'H01', 6],
    ['held', 6, 'H02', 6],
    ['stock', 6, 'H03', 6],
  ] as [Orders, number, string, number][]) {
    WO[name] = await releasedWorkOrder(line, pieces)
    const made = await cutAndBundle(WO[name], hide, size)
    BN[name] = made.bundles
    CUT[name] = made.cut
  }
  const operations = WO.flow.spec.operations as Json[]
  OPS.cut = operations.find((op) => op.seq === 10)!.id
  OPS.sew = operations.find((op) => op.seq === 20)!.id
  OPS.qc = operations.find((op) => op.seq === 30)!.id
  OPS.pack = operations.find((op) => op.seq === 40)!.id
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

// ---- split a bundle (MES-071) ---------------------------------------------------------------------------------------------------

describe('split a bundle (MES-071): pieces off into a child bundle with its own ticket', () => {
  let child: Json

  it('splits garments off on the floor: a new ticket, the parent keeps its genealogy and quantity as cut', async () => {
    const parent = BN.flow[0]!
    const response = await post('cutter', `/production/bundles/${parent.id}/split`, { quantity: 2, reason: 'HOLD', note: 'Shade to check', printerId: null })
    expect(response.statusCode, response.body).toBe(201)
    const split = response.json()
    child = split.bundle
    expect(child).toMatchObject({ parentBundleId: parent.id, quantity: 2, workOrderSizeId: parent.workOrderSizeId, part: null, status: 'ACTIVE', cutLogIds: parent.cutLogIds })
    expect(child.code).not.toBe(parent.code)
    expect(split.parent).toMatchObject({ id: parent.id, quantity: 6, live: 4 })
    expect(split.ticket).toMatchObject({ bundleId: child.id, code: child.code, job: null })
    // The cell's bundled garments stay 12 (the child's are the parent's).
    const view = await ok('cutter', 'GET', `/production/bundles/work-orders/${WO.flow.id}`)
    expect(view.cells[0]).toMatchObject({ bundled: 12, toBundle: 0 })
    expect(await counts(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'production.bundle_split' AND payload->>'bundleId' = $1`, [child.id])).toBe(1)
  })

  it('refuses a split that leaves no garment in the parent, in words', async () => {
    const response = await post('cutter', `/production/bundles/${BN.flow[0]!.id}/split`, { quantity: 4, reason: 'RECUT', printerId: null })
    expect(response.statusCode, response.body).toBe(409)
    expect(refusalOf(response.json().error)).toBe('refusal/SPLIT_TOO_MANY')
    expect(response.json().error.message).toBe(`Bundle ${BN.flow[0]!.code} carries 4 garments: split off 1 to 3 (at least one stays); 4 asked.`)
  })

  it('the scans count the parent’s live garments and the child’s own (the scan hook)', async () => {
    const parent = BN.flow[0]!
    const over = await refusedReport('cutter', parent, 6, { workOrderOperationId: OPS.cut })
    expect(refusalOf(over)).toBe('refusal/MORE_THAN_BUNDLE')
    expect(over.message).toBe(`Bundle ${parent.code} carries 4 garments; 6 reported.`)
    await reported('cutter', parent, 4, { workOrderOperationId: OPS.cut })
    await reported('cutter', child, 2, { workOrderOperationId: OPS.cut })
    // The card shows the child at Op 10 done, Op 20 open with its 2 garments.
    const card = await ok('sew1', 'GET', `/production/scans/card?code=${child.code}`)
    expect(card.operations.find((op: Json) => op.seq === 20)).toMatchObject({ state: 'OPEN', expected: 2 })
  })
})

// ---- the rework loop (MES-126) -------------------------------------------------------------------------------------------------

describe('the rework loop (MES-126): garments go back to an operation and return', () => {
  let rework: Json
  let reworkChild: Json
  let qcScan: Json

  it('opens rework from a scan’s rework count, splitting the garments off into a bundle of their own', async () => {
    const bundle = BN.flow[1]!
    await reported('cutter', bundle, 6, { workOrderOperationId: OPS.cut })
    await reported('sew1', bundle, 6)
    qcScan = await reported('qc', bundle, 4, { rework: [{ reason: 'RESTITCH', quantity: 2 }] })
    const response = await post('qc', '/production/rework', { sourceScanId: qcScan.id, reworkAtOperationId: OPS.sew, quantity: 2, description: 'Collar seam open', printerId: null })
    expect(response.statusCode, response.body).toBe(201)
    const opened = response.json()
    rework = opened.rework
    reworkChild = opened.split.bundle
    expect(rework).toMatchObject({ status: 'OPEN', quantity: 2, reasonCode: 'RESTITCH', sourceScanId: qcScan.id, foundAt: { seq: 30 }, reworkAt: { seq: 20 }, bundle: { id: reworkChild.id, parentBundleId: bundle.id }, createdBy: null, replacements: null })
    expect(opened.split.parent).toMatchObject({ id: bundle.id, live: 4 })
    expect(opened.ticket).toMatchObject({ bundleId: reworkChild.id })
    // No worker named on a floor rework (Statuto dei Lavoratori art. 4).
    expect(await counts(`SELECT count(*)::int AS n FROM "ReworkOrder" WHERE id = $1 AND "createdById" IS NULL`, [rework.id])).toBe(1)
  })

  it('sends back no more than the scan counted', async () => {
    const response = await post('qc', '/production/rework', { sourceScanId: qcScan.id, reworkAtOperationId: OPS.sew, quantity: 1 })
    expect(response.statusCode, response.body).toBe(409)
    expect(refusalOf(response.json().error)).toBe('refusal/MORE_THAN_COUNTED')
    expect(response.json().error.message).toBe('Every garment that scan counted as rework (2) is sent back already.')
  })

  it('the parent goes on with its good garments; the rework bundle waits for its rework, in words', async () => {
    const parent = BN.flow[1]!
    const over = await refusedReport('pack', parent, 5)
    expect(refusalOf(over)).toBe('refusal/MORE_THAN_PASSED')
    await reported('pack', parent, 4)
    const held = await refusedReport('pack', reworkChild, 2)
    expect(refusalOf(held)).toBe('refusal/PREVIOUS_NOT_REPORTED')
    expect(held.message).toBe(`Bundle ${reworkChild.code} is in rework (RESTITCH): back to Op 20 Sew and assemble the body, found at Op 30 Final inspection.`)
    expect(fixOf(held)).toBe('It moves on when its rework is done: finish the rework first (Scrap & rework).')
  })

  it('starts and finishes the rework (good + scrapped = its garments); the good ones rejoin at the final check', async () => {
    const short = await post('sew1', `/production/rework/${rework.id}/done`, { version: 1, good: 1, scrap: 0 })
    expect(short.statusCode, short.body).toBe(409)
    expect(refusalOf(short.json().error)).toBe('refusal/COUNTS_DO_NOT_ADD_UP')
    const started = await post('sew1', `/production/rework/${rework.id}/start`, { version: 1 })
    expect(started.statusCode, started.body).toBe(201)
    expect(started.json().rework).toMatchObject({ status: 'IN_PROGRESS', version: 2 })
    const stale = await post('sew1', `/production/rework/${rework.id}/done`, { version: 1, good: 1, scrap: 1 })
    expect(stale.statusCode, stale.body).toBe(409)
    const done = await post('sew1', `/production/rework/${rework.id}/done`, { version: 2, good: 1, scrap: 1 })
    expect(done.statusCode, done.body).toBe(201)
    expect(done.json().rework).toMatchObject({ status: 'DONE', goodQuantity: 1, scrapQuantity: 1 })
    // Op 30 passed one of the rework bundle: Op 40 takes one.
    const over = await refusedReport('pack', reworkChild, 2)
    expect(refusalOf(over)).toBe('refusal/MORE_THAN_PASSED')
    await reported('pack', reworkChild, 1)
    expect(await counts(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'production.rework_moved' AND payload->>'reworkId' = $1`, [rework.id])).toBe(2)
  })

  it('reads the rework on the floor (its site) and in the office (production.scrap.view), never another company’s', async () => {
    const floorList = await ok('qc', 'GET', `/production/rework?workOrderId=${WO.flow.id}`)
    expect(floorList.rework.map((row: Json) => row.id)).toContain(rework.id)
    expect(floorList.rework[0].replacements).toBeNull()
    const record = await ok('manager', 'GET', `/production/rework/${rework.id}`)
    expect(record.rework).toMatchObject({ id: rework.id, status: 'DONE', replacements: [] })
    expect((await call('companyB', 'GET', `/production/rework/${rework.id}`)).statusCode).toBe(404)
    expect((await call('otherTenant', 'GET', `/production/rework/${rework.id}`)).statusCode).toBe(404)
    expect((await call('noRework', 'GET', '/production/rework')).statusCode).toBe(403)
  })

  it('a held work order takes new rework; none moves on until the hold is lifted (in words)', async () => {
    const bundle = BN.held[0]!
    const opened = await post('manager', '/production/rework', { workOrderId: WO.held.id, bundleId: bundle.id, reworkAtOperationId: OPS.cut === WO.held.spec.operations[0].id ? WO.held.spec.operations[0].id : (WO.held.spec.operations as Json[]).find((op) => op.seq === 10)!.id, quantity: 6, reasonCode: 'CLEANING', description: 'Glue marks' })
    expect(opened.statusCode, opened.body).toBe(201)
    const held = opened.json().rework
    expect(held).toMatchObject({ bundle: { id: bundle.id }, createdBy: { id: A.manager, name: 'Made-up production manager' } })
    await admin(`UPDATE "WorkOrder" SET status = 'ON_HOLD', "heldFromStatus" = status, "heldAt" = now(), "holdReason" = 'Made-up quality hold', "heldById" = $2 WHERE id = $1`, [WO.held.id, A.manager])
    const refused = await post('manager', `/production/rework/${held.id}/start`, { version: 1 })
    expect(refused.statusCode, refused.body).toBe(409)
    expect(refusalOf(refused.json().error)).toBe('refusal/WORK_ORDER_ON_HOLD')
    expect(refused.json().error.message).toBe(`Work order ${WO.held.number} is on hold (Made-up quality hold): its rework moves on once the hold is lifted.`)
    const split = await post('manager', `/production/bundles/${BN.held[0]!.id}/split`, { quantity: 1, reason: 'HOLD', printerId: null })
    expect(split.statusCode, split.body).toBe(409)
    expect(refusalOf(split.json().error)).toBe('refusal/WORK_ORDER_ON_HOLD')
    await admin(`UPDATE "WorkOrder" SET status = "heldFromStatus", "heldFromStatus" = NULL, "heldAt" = NULL, "holdReason" = NULL, "heldById" = NULL WHERE id = $1`, [WO.held.id])
    const cancelled = await post('manager', `/production/rework/${held.id}/cancel`, { version: 1, reason: 'Opened on the wrong bundle' })
    expect(cancelled.statusCode, cancelled.body).toBe(201)
    expect(cancelled.json().rework).toMatchObject({ status: 'CANCELLED', cancelReason: 'Opened on the wrong bundle' })
  })
})

// ---- replace scrapped quantity (MES-130) ---------------------------------------------------------------------------------------------

describe('replace scrapped quantity (MES-130): a recut, or a lower order quantity a second person approves', () => {
  let reduce: Json
  let scrapScan: Json

  it('asks a recut for the rework’s scrap and lists it for the cutting room; never more than was scrapped', async () => {
    const [rework] = (await ok('manager', 'GET', `/production/rework?workOrderId=${WO.flow.id}&status=DONE`)).rework
    const asked = await post('manager', '/production/replacements', { kind: 'RECUT', quantity: 1, reworkOrderId: rework.id, reason: 'Collar panel burnt in the rework' })
    expect(asked.statusCode, asked.body).toBe(201)
    const recut = asked.json().replacement
    expect(recut).toMatchObject({ kind: 'RECUT', status: 'OPEN', quantity: 1, reworkOrderId: rework.id, cell: { size: '50' }, createdBy: { id: A.manager } })
    const again = await post('manager', '/production/replacements', { kind: 'RECUT', quantity: 1, reworkOrderId: rework.id, reason: 'Twice' })
    expect(again.statusCode, again.body).toBe(409)
    expect(refusalOf(again.json().error)).toBe('refusal/MORE_THAN_SCRAPPED')
    const list = await ok('manager', 'GET', `/production/replacements?kind=RECUT&status=OPEN&workOrderId=${WO.flow.id}`)
    expect(list.replacements.map((row: Json) => row.id)).toEqual([recut.id])
    // Done by the cut log entry that cut the cell (of this work order, live).
    const done = await post('manager', `/production/replacements/${recut.id}/done`, { version: 1, cutLogId: CUT.flow.id })
    expect(done.statusCode, done.body).toBe(201)
    expect(done.json().replacement).toMatchObject({ status: 'DONE', cutLogId: CUT.flow.id })
    const wrong = await post('manager', '/production/replacements', { kind: 'RECUT', quantity: 1, workOrderId: WO.flow.id, workOrderSizeId: WO.flow.cells[0].id, part: 'collar', reason: 'By hand' })
    expect(wrong.statusCode, wrong.body).toBe(409)
    expect(refusalOf(wrong.json().error)).toBe('refusal/NOT_A_PART')
  })

  it('a lower order quantity is approved by another person, never by the one who asked', async () => {
    const parent = BN.flow[0]!
    scrapScan = await reported('sew1', parent, 3, { scrap: [{ reason: 'STAIN', quantity: 1 }] })
    const asked = await post('approver', '/production/replacements', { kind: 'REDUCE', quantity: 1, sourceScanId: scrapScan.id, reason: 'The customer takes one less' })
    expect(asked.statusCode, asked.body).toBe(201)
    reduce = asked.json().replacement
    expect((await post('manager', `/production/replacements/${reduce.id}/approve`, { version: 1 })).statusCode).toBe(403)
    const own = await post('approver', `/production/replacements/${reduce.id}/approve`, { version: 1 })
    expect(own.statusCode, own.body).toBe(409)
    expect(refusalOf(own.json().error)).toBe('refusal/SELF_DECISION')
    const unexplained = await post('approver2', `/production/replacements/${reduce.id}/refuse`, { version: 1 })
    expect(unexplained.statusCode).toBe(400)
    const approved = await post('approver2', `/production/replacements/${reduce.id}/approve`, { version: 1, note: 'Agreed with sales' })
    expect(approved.statusCode, approved.body).toBe(201)
    expect(approved.json().replacement).toMatchObject({ status: 'APPROVED', createdBy: { id: A.approver }, decidedBy: { id: A.approver2, name: 'Made-up second planner' }, decisionNote: 'Agreed with sales' })
  })
})

// ---- scrap posts stock and cost by lot (MES-129) -------------------------------------------------------------------------------------

describe('scrap by lot (MES-129): the leather of scrapped garments, and material scrapped out of stock', () => {
  it('lists every scrap with the lot, hide and area it held, its replacements, and rework; the value only with the cost grain', async () => {
    const list = await ok('manager', 'GET', `/production/scrap?workOrderId=${WO.flow.id}`)
    const scanRow = list.rows.find((row: Json) => row.kind === 'SCRAP' && row.source.type === 'SCAN')
    expect(scanRow).toMatchObject({ pieces: 1, reasonCode: 'STAIN', reasonLabel: { en: 'Stain' }, operation: { seq: 20 }, bundle: { id: BN.flow[0]!.id }, cell: { size: '50' }, station: { code: 'SEW-01' } })
    // One garment of 48.16 ft², all from H01 (the bundle's one cut log entry).
    expect(scanRow.materials).toEqual([expect.objectContaining({ hideId: hides.H01!.id, hideCode: hides.H01!.code, area: '48.1600', uom: 'FT2' })])
    expect(scanRow.replacements).toEqual([expect.objectContaining({ kind: 'REDUCE', status: 'APPROVED', quantity: 1 })])
    const reworkScrap = list.rows.find((row: Json) => row.kind === 'SCRAP' && row.source.type === 'REWORK')
    expect(reworkScrap).toMatchObject({ pieces: 1, reasonCode: 'RESTITCH', status: 'DONE', materials: [expect.objectContaining({ area: '48.1600' })] })
    expect(list.rows.filter((row: Json) => row.kind === 'REWORK').map((row: Json) => row.status)).toEqual(['DONE'])
    expect(list.tiles).toMatchObject({ scrapToday: 2, reworkOpen: 0, recutsToCut: 0, reductionsToApprove: 0 })
    // No money without the cost grain; never a person.
    expect(keysOf(list).filter((key) => MONEY.test(key) || key === 'currency')).toEqual([])
    expect(keysOf(list).filter((key) => /worker|createdBy/i.test(key))).toEqual([])
    const withCost = await ok('costs', 'GET', `/production/scrap?workOrderId=${WO.flow.id}`)
    expect(withCost.rows.find((row: Json) => row.id === scanRow.id)).toHaveProperty('value')
    expect((await call('viewer', 'GET', '/production/scrap')).statusCode).toBe(403)
  })

  it('posts material scrapped for a work order out of stock by lot, and says in words what it leaves over-reserved', async () => {
    // H08 reserved whole for this work order; 100 ft² of it scrapped: the reservation stays, over the stock left.
    const reserved = await call('manager', 'POST', '/inventory/reservations', { siteId: A.siteA1, workOrderId: WO.stock.id, lines: [{ hideId: hides.H08!.id }] }, freshKey())
    expect(reserved.statusCode, reserved.body).toBe(201)
    const response = await post('manager', '/production/scrap/stock', { workOrderId: WO.stock.id, reasonCode: 'LEATHER_FLAW', note: 'Brand mark across the back', lines: [{ hideId: hides.H08!.id, quantity: '100.0000' }] })
    expect(response.statusCode, response.body).toBe(201)
    const posted = response.json()
    expect(posted.scrap).toMatchObject({ workOrderId: WO.stock.id, reasonCode: 'LEATHER_FLAW', note: 'LEATHER_FLAW: Brand mark across the back', scrappedHides: [], moves: [expect.objectContaining({ hideId: hides.H08!.id, quantity: '100.0000', baseQuantity: '100.0000' })] })
    expect(posted.overReserved).toEqual([expect.objectContaining({ itemId: A.leather, hideId: hides.H08!.id, reserved: '1000.0000', available: '900.0000' })])
    expect(posted.overReserved[0].words).toBe(`Hide ${hides.H08!.code} is reserved whole (1000.0000 FT2) but holds 900.0000 FT2 after this scrap: the reservation stays; release it or reserve more for the rest.`)
    const [move] = await admin(`SELECT reason::text, "workOrderId", "fromLocationId", reference FROM "StockMove" WHERE id = $1`, [posted.scrap.id])
    expect(move).toMatchObject({ reason: 'SCRAP', workOrderId: WO.stock.id, fromLocationId: A.bin, reference: WO.stock.number })
    expect(await counts(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'production.scrap_posted' AND payload->>'scrapId' = $1`, [posted.scrap.id])).toBe(1)
    expect(await counts(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "recordType" = 'ProductionScrap' AND "recordId" = $1`, [posted.scrap.id])).toBe(1)
  })

  it('refuses a hide another work order reserves, in words; scraps a hide left with nothing for good', async () => {
    // H08's reservation released first (it would take the leather H09's reservation needs).
    const [held] = (await ok('manager', 'GET', `/inventory/reservations?hideId=${hides.H08!.id}&status=ACTIVE`)).reservations
    expect((await call('manager', 'POST', '/inventory/reservations/release', { reservations: [{ id: held.id, version: held.version }], reason: 'The hide is scrapped' }, freshKey())).statusCode).toBe(200)
    const reserved = await call('manager', 'POST', '/inventory/reservations', { siteId: A.siteA1, workOrderId: WO.flow.id, lines: [{ hideId: hides.H09!.id }] }, freshKey())
    expect(reserved.statusCode, reserved.body).toBe(201)
    const refused = await post('manager', '/production/scrap/stock', { workOrderId: WO.stock.id, reasonCode: 'TEAR', lines: [{ hideId: hides.H09!.id }] })
    expect(refused.statusCode, refused.body).toBe(409)
    expect(refused.json().error.message).toBe(`Hide ${hides.H09!.code} is reserved for work order ${WO.flow.number}: release that reservation first.`)
    const whole = await post('manager', '/production/scrap/stock', { workOrderId: WO.stock.id, reasonCode: 'TEAR', lines: [{ hideId: hides.H08!.id }] })
    expect(whole.statusCode, whole.body).toBe(201)
    expect(whole.json().scrap.scrappedHides).toEqual([hides.H08!.id])
    expect((await admin(`SELECT state::text FROM "Hide" WHERE id = $1`, [hides.H08!.id]))[0]).toEqual({ state: 'SCRAPPED' })
  })
})

// ---- hide yield (MES-057) --------------------------------------------------------------------------------------------------------------

describe('hide yield (MES-057): area in, pattern area cut, remnant and waste; planned against actual', () => {
  it('per work order: each hide and the whole, against the plan', async () => {
    const result = await ok('viewer', 'GET', `/production/yield/work-orders/${WO.flow.id}`)
    expect(result.hides).toHaveLength(1)
    // 12 sets of 48.16 ft² (45 × 1.07 per size … the BOM's need with 12% wastage): pattern = 577.92 / 1.12 = 516.
    expect(result.hides[0]).toMatchObject({ hide: { id: hides.H01!.id }, areaIn: '1000.0000', used: '577.9200', pattern: '516.0000', waste: '61.9200', remnant: '0.0000', yieldPct: '89.29', wastePct: '10.71' })
    // Planned: the style revision's 75 % hide yield.
    expect(result.plannedSource).toBe('STYLE')
    expect(result.overall).toMatchObject({ yieldPct: '89.29', plannedPct: '75.00', variancePct: '14.29' })
    expect(keysOf(result).filter((key) => /worker|cutter|station/i.test(key))).toEqual([])
  })

  it('across work orders per style and supplier lot (production.cutting.view)', async () => {
    const result = await ok('manager', 'GET', `/production/yield?siteId=${A.siteA1}`)
    const flowLot = result.byStyleAndLot.find((row: Json) => row.style.id === A.style && row.lot.id === bigLot)
    expect(flowLot).toMatchObject({ style: { code: 'SEED-JKT-02' }, hides: 3, used: '1155.8400', yieldPct: '89.29', plannedPct: '75.00', variancePct: '14.29' })
    expect(result.hides.map((row: Json) => row.hide.id)).toEqual(expect.arrayContaining([hides.H01!.id, hides.H02!.id, hides.H03!.id]))
    expect((await call('viewer', 'GET', '/production/yield')).statusCode).toBe(403)
  })
})
