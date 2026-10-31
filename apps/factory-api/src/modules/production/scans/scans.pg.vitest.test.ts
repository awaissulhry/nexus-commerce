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
import { lockBundleScans } from './store'

/**
 * Operation scans on the floor, offline, with undo and corrections; WIP (B-W1-42; MES-069, MES-090, MES-095, MES-096,
 * MES-167, MES-308; PLAN §4.7 stage 12-scans, risk 17; A1 §3.8; A2 SCR-090, SCR-072, SCR-073, SCR-023) on the local
 * stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level
 * security, the column grants and the …_production_guards scan trigger are real), the factory-db seeds of two tenants up
 * to production (plant A1 names workers; its operator acknowledged the published worker notice, its team leader nothing;
 * company A's floor is ready), the numbering seed, a made-up certificate, a made-up lot of large black hides at A1, and
 * made-up tablets at A1's sewing stations (SEW-01 on line L1, SEW-02), its inspection and packing benches, and one with
 * no station. Released work orders of black jackets in size 50 are made through the work-order routes, cut through the
 * cutting routes and bundled through the bundles routes (no printer: PDF tickets). The seeded routing: 10 cut (CUTTING),
 * 20 sew (SEWING), 30 final inspection (INSPECTION), 40 pack (PACKING): finished = packed, sewn = 20. Sessions come
 * from the test authenticator. Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs scans`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = { a: 'scans-a', b: 'scans-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const A = {
  tenant: idOf(ns.a, 'tenant'),
  actor: idOf(ns.a, 'actor'),
  companyA: idOf(ns.a, 'company:A'),
  companyB: idOf(ns.a, 'company:B'),
  siteA1: idOf(ns.a, 'site:A1'),
  siteB1: idOf(ns.a, 'site:B1'),
  brand: idOf(ns.a, 'party:P1'),
  style: idOf(ns.a, 'production:style:JKT-02'),
  blk: idOf(ns.a, 'production:colourway:JKT-02:BLK'),
  leather: idOf(ns.a, 'product:item:leather'),
  leatherBLK: idOf(ns.a, 'product:item-colour:leather:BLK'),
  bin: idOf(ns.a, 'inventory:location:A1-STORE-01'),
  line: idOf(ns.a, 'site:A1:line:L1'),
  cutStation: idOf(ns.a, 'site:A1:station:CUT-01'),
  sew1Station: idOf(ns.a, 'site:A1:station:SEW-01'),
  sew2Station: idOf(ns.a, 'site:A1:station:SEW-02'),
  qcStation: idOf(ns.a, 'site:A1:station:QC-01'),
  packStation: idOf(ns.a, 'site:A1:station:PACK-01'),
  cutter: idOf(ns.a, 'device:A1:cutting'),
  deviceB1: idOf(ns.a, 'device:B1:cutting'),
  /** A second tablet at the cutting table (the seeded one carries the seed's scans, dated later than the tests). */
  cut2: newId(),
  sew1: newId(),
  sew2: newId(),
  qc: newId(),
  pack: newId(),
  roaming: newId(),
  operatorA1: idOf(ns.a, 'worker:A1:operator'),
  leadA1: idOf(ns.a, 'worker:A1:lead'),
  operatorB1: idOf(ns.a, 'worker:B1:operator'),
  /** The office account the A1 operator also is (Worker.userId): may not approve the operator's own scans. */
  operatorUser: newId(),
  supervisor: newId(),
}
const B = { tenant: idOf(ns.b, 'tenant') }

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (tenantId: string, grants: Grant[], actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId, actorId, grants })
const FLOOR: Permission[] = ['floor.work', 'production.cut', 'production.bundles', 'production.scan', 'inventory.issue', 'print.view', 'print.labels']
const floor = (siteId: string, deviceId: string, actorId: string, companyId: string): SessionContext => ({ audience: 'floor', tenantId: A.tenant, actorId, siteId, deviceId, grants: [grant(FLOOR, [companyId], [siteId])] })
const SUPERVISE: Permission[] = ['workorders.view', 'production.scan.correct', 'production.scan']
const SESSIONS: Record<string, SessionContext> = {
  planner: office(A.tenant, [grant(['workorders.view', 'workorders.manage', 'workorders.release'])]),
  supervisor: office(A.tenant, [grant(SUPERVISE)], A.supervisor),
  /** The operator's own office account: holds the same permission, decides nothing of the operator's own scans. */
  operatorOffice: office(A.tenant, [grant(SUPERVISE)], A.operatorUser),
  viewer: office(A.tenant, [grant(['workorders.view'])]),
  companyB: office(A.tenant, [grant(SUPERVISE, [A.companyB])]),
  otherTenant: office(B.tenant, [grant(SUPERVISE)]),
  cutter: floor(A.siteA1, A.cutter, A.operatorA1, A.companyA),
  cut2: floor(A.siteA1, A.cut2, A.operatorA1, A.companyA),
  sew1: floor(A.siteA1, A.sew1, A.operatorA1, A.companyA),
  /** The same operator on the second sewing tablet. */
  sew2: floor(A.siteA1, A.sew2, A.operatorA1, A.companyA),
  qc: floor(A.siteA1, A.qc, A.operatorA1, A.companyA),
  pack: floor(A.siteA1, A.pack, A.operatorA1, A.companyA),
  roaming: floor(A.siteA1, A.roaming, A.operatorA1, A.companyA),
  /** The team leader on the sewing tablet: has not acknowledged the information notice. */
  leadSew1: floor(A.siteA1, A.sew1, A.leadA1, A.companyA),
  leadCutter: floor(A.siteA1, A.cutter, A.leadA1, A.companyA),
  floorB1: floor(A.siteB1, A.deviceB1, A.operatorB1, A.companyB),
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

/** Waits until `n` sessions of this database wait for a lock (advisory, row or transaction). */
async function untilWaiting(n: number, what: string, locktype?: string) {
  for (let tries = 0; ; tries++) {
    const [row] = await admin<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND a.datname = current_database() ${locktype ? `AND l.locktype = '${locktype}'` : ''}`,
    )
    if (row!.n >= n) return
    if (tries > 400) throw new Error(`${what} never waited`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

// ---- made-up stock, work orders, cuts and bundles --------------------------------------------------------------------------------

const hides: Record<string, { id: string; code: string }> = {}

async function addHides(count: number) {
  const lotId = newId()
  await admin(
    `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "dyeBatch", "qualityStatus", "qualityDecidedAt", "requiresCrViTest", "crViLimitMgKg", "crViStatus", "crViMgKg", "crViEvidence", "crViTestedAt", "receivedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, '7731', 'RELEASED', now(), true, '3.000', 'PASS', '1.100', 'LOT_REPORT', '2026-10-01', '2026-10-05T08:00:00Z')`,
    [lotId, A.tenant, A.companyA, A.siteA1, A.leather, A.leatherBLK, `T-${run}-BIG`],
  )
  for (let index = 1; index <= count; index++) {
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
      [newId(), A.tenant, A.companyA, A.siteA1, A.leather, A.leatherBLK, lotId, hideId, A.bin, `scan-test-${run}-${key}`],
    )
  }
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
async function cutAndBundle(workOrder: Json, hideKey: string, bundleSize: number): Promise<Json[]> {
  const cut = await call('cutter', 'POST', `/production/cutting/work-orders/${workOrder.id}/cuts`, { clientEventId: clientId(), code: hides[hideKey]!.code, lines: workOrder.cells.map((cell: Json) => ({ workOrderSizeId: cell.id, sets: cell.quantity })) }, freshKey())
  expect(cut.statusCode, cut.body).toBe(201)
  const made = await call('cutter', 'POST', `/production/bundles/work-orders/${workOrder.id}/bundles`, { bundleSize, printerId: null }, freshKey())
  expect(made.statusCode, made.body).toBe(201)
  return made.json().bundles
}

const OPS = {} as Record<'cut' | 'sew' | 'qc' | 'pack', string>
/** A work order's own operation at a routing step (each work order has its own frozen operation rows). */
const opOf = (workOrder: Json, seq: number): string => (workOrder.spec.operations as Json[]).find((op) => op.seq === seq)!.id
type Orders = 'flow' | 'race' | 'offline' | 'tickets' | 'done' | 'late'
const WO = {} as Record<Orders, Json>
const BN = {} as Record<Orders, Json[]>

const T0 = Date.parse('2026-11-02T08:00:00.000Z')
const deviceAt = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()

const scanBody = (bundle: Json, good: number, extra: Json = {}) => ({ clientScanId: clientId(), code: bundle.code, good, ...extra })
const report = (session: string, body: Json) => call(session, 'POST', '/production/scans', body)
async function reported(session: string, body: Json, status = 201): Promise<Json> {
  const response = await report(session, body)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().scan
}
async function refusedReport(session: string, body: Json, status = 409): Promise<Json> {
  const response = await report(session, body)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const undo = (session: string, scanId: string, extra: Json = {}) => call(session, 'POST', `/production/scans/${scanId}/undo`, { clientScanId: clientId(), ...extra })
const askCorrection = (session: string, scanId: string, body: Json) => call(session, 'POST', `/production/scans/${scanId}/corrections`, { clientScanId: clientId(), ...body })
const wipOf = async (workOrderId: string, session = 'supervisor') => ok(session, 'GET', `/production/scans/work-orders/${workOrderId}/wip`)
const atOp = (wip: Json, operationId: string) => wip.operations.find((row: Json) => row.operationId === operationId)
const standingCount = async (bundleId: string, operationId: string) =>
  counts(
    `SELECT count(*)::int AS n FROM "OperationScan" s WHERE s."bundleId" = $1 AND s."workOrderOperationId" = $2 AND s.kind <> 'UNDO' AND NOT EXISTS (SELECT 1 FROM "OperationScan" v WHERE v."correctsId" = s.id)`,
    [bundleId, operationId],
  )

beforeAll(async () => {
  db = await migratedDatabase('scans')
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
  await addHides(6)
  // B-W2b-46: W1's strict order, a skipped operation held (PREVIOUS_NOT_REPORTED), is the site rule STRICT now (the default WARN lets it count and tells the team leader).
  await admin(`UPDATE "ProductionSettings" SET "skippedOperationRule" = 'STRICT' WHERE id = $1`, [A.siteA1])
  for (const [deviceId, stationId, name] of [
    [A.cut2, A.cutStation, 'Second cutting tablet'],
    [A.sew1, A.sew1Station, 'Sewing tablet 1'],
    [A.sew2, A.sew2Station, 'Sewing tablet 2'],
    [A.qc, A.qcStation, 'Inspection tablet'],
    [A.pack, A.packStation, 'Packing tablet'],
    [A.roaming, null, 'Roaming tablet'],
  ] as const) {
    await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, $6, 'TABLET', 'ACTIVE', now())`, [deviceId, A.tenant, A.companyA, A.siteA1, stationId, name])
  }
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, 'Made-up operator (office)', 'ACTIVE')`, [A.operatorUser, A.tenant, `operator-${run}@example.test`])
  await admin(`UPDATE "Worker" SET "userId" = $1 WHERE id = $2`, [A.operatorUser, A.operatorA1])

  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  const line = await salesOrder({ '50': 80 })
  const plan: [Orders, number, string, number][] = [
    ['flow', 12, 'H01', 5],
    ['race', 6, 'H02', 6],
    ['offline', 12, 'H03', 5],
    ['tickets', 12, 'H04', 4],
    ['done', 6, 'H05', 6],
    ['late', 6, 'H06', 3],
  ]
  for (const [name, pieces, hide, size] of plan) {
    WO[name] = await releasedWorkOrder(line, pieces)
    BN[name] = await cutAndBundle(WO[name], hide, size)
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

// ---- a bundle through the operations -------------------------------------------------------------------------------------------

describe('a bundle through its operations (MES-069, MES-090): one tap, each operation capped by what the one before passed', () => {
  it('opens the bundle card at a sewing station: nothing passed yet, so sewing waits for the cut', async () => {
    const card = await ok('sew1', 'GET', `/production/scans/card?code=${BN.flow[0]!.code}`)
    expect(card).toMatchObject({ scanned: BN.flow[0]!.code, refusal: null, bundle: { id: BN.flow[0]!.id, quantity: 5, part: null, colourwayCode: 'BLK', size: '50' }, station: { code: 'SEW-01', kind: 'SEWING' } })
    expect(card.operations.map((op: Json) => [op.seq, op.state, op.expected, op.final, op.sewn])).toEqual([
      [10, 'OPEN', 5, false, false],
      [20, 'NOT_REACHED', null, false, true],
      [30, 'NOT_REACHED', null, false, false],
      [40, 'NOT_REACHED', null, true, false],
    ])
    expect(card.next).toBe(opOf(WO.flow, 20))
    expect(card.reasons.map((reason: Json) => `${reason.kind}:${reason.code}`)).toContain('SCRAP:STAIN')
    const error = await refusedReport('sew1', scanBody(BN.flow[0]!, 5))
    expect(refusalOf(error)).toBe('refusal/PREVIOUS_NOT_REPORTED')
    expect(error.message).toBe(`Op 10 Cut leather panels has not passed bundle ${BN.flow[0]!.code} yet.`)
    expect(fixOf(error)).toMatch(/^Report it at Op 10 first/)
  })

  it('reports the cut at the cutting table in one tap, starts the work order, and keeps device and server time', async () => {
    expect((await admin(`SELECT status FROM "WorkOrder" WHERE id = $1`, [WO.flow.id]))[0]!.status).toBe('RELEASED')
    const scan = await reported('cutter', scanBody(BN.flow[0]!, 5, { occurredAt: deviceAt(0) }))
    expect(scan).toMatchObject({ kind: 'REPORT', bundleId: BN.flow[0]!.id, operation: { seq: 10, code: 'SEED-CUT-LEA' }, goodQuantity: 5, scrapQuantity: 0, reworkQuantity: 0, defects: [], deviceTime: deviceAt(0), stationId: A.cutStation, deviceId: A.cutter })
    expect(scan.undoUntil).not.toBeNull()
    const [row] = await admin(`SELECT "workerId", "stationId", "createdById", "deviceTime", "serverTime" FROM "OperationScan" WHERE id = $1`, [scan.id])
    expect(row).toMatchObject({ workerId: A.operatorA1, stationId: A.cutStation, createdById: A.operatorA1 })
    expect(row!.deviceTime.toISOString()).toBe(deviceAt(0))
    // Its first scan started the work order (as the system, after the commit).
    expect((await admin(`SELECT status, "startedAt" FROM "WorkOrder" WHERE id = $1`, [WO.flow.id]))[0]).toMatchObject({ status: 'IN_PROGRESS' })
    expect(await counts(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "recordType" = 'OperationScan' AND "recordId" = $1 AND action = 'production.reportScan'`, [scan.id])).toBe(1)
    const [event] = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'production.scan_recorded' AND payload->>'scanId' = $1`, [scan.id])
    expect(event!.payload).toMatchObject({ workOrderId: WO.flow.id, kind: 'REPORT', operationSeq: 10, goodQuantity: 5, postedBy: 'FLOOR' })
    expect(keysOf(scan)).not.toContain('workerId')
    await reported('cutter', scanBody(BN.flow[1]!, 5))
    await reported('cutter', scanBody(BN.flow[2]!, 2))
  })

  it('caps sewing at what the cut passed, counts scrap by reason, then inspection takes only the good', async () => {
    const over = await refusedReport('sew1', scanBody(BN.flow[0]!, 5, { scrap: [{ reason: 'STAIN', quantity: 1 }] }))
    expect(refusalOf(over)).toBe('refusal/MORE_THAN_PASSED')
    expect(over.message).toBe(`Op 10 Cut leather panels passed 5 garments of bundle ${BN.flow[0]!.code}; 6 reported here.`)
    expect(fixOf(over)).toMatch(/^Count again: at most 5/)
    // An unknown reason is refused in words.
    expect(refusalOf(await refusedReport('sew1', scanBody(BN.flow[0]!, 4, { scrap: [{ reason: 'RESTITCH', quantity: 1 }] })))).toBe('refusal/UNKNOWN_REASON')
    const sewn = await reported('sew1', scanBody(BN.flow[0]!, 4, { scrap: [{ reason: 'STAIN', quantity: 1 }] }))
    expect(sewn).toMatchObject({ operation: { seq: 20 }, goodQuantity: 4, scrapQuantity: 1, defects: [{ kind: 'SCRAP', reason: 'STAIN', quantity: 1 }] })
    expect((await admin(`SELECT "scrapReason" FROM "OperationScan" WHERE id = $1`, [sewn.id]))[0]!.scrapReason).toBe('STAIN')
    // Sewing passed 4 of the bundle's 5: inspection takes at most 4 (the bundle's garments are no cap here; the trigger
    // checks only those).
    const five = await refusedReport('qc', scanBody(BN.flow[0]!, 5))
    expect(refusalOf(five)).toBe('refusal/MORE_THAN_PASSED')
    expect(five.message).toBe(`Op 20 Sew and assemble the body passed 4 garments of bundle ${BN.flow[0]!.code}; 5 reported here.`)
    expect(refusalOf(await refusedReport('qc', scanBody(BN.flow[0]!, 4, { rework: [{ reason: 'RESTITCH', quantity: 1 }] })))).toBe('refusal/MORE_THAN_PASSED')
    const inspected = await reported('qc', scanBody(BN.flow[0]!, 4))
    expect(inspected.operation.seq).toBe(30)
    expect(refusalOf(await refusedReport('qc', scanBody(BN.flow[0]!, 1, { workOrderOperationId: OPS.qc })))).toBe('refusal/ALREADY_REPORTED')
    // Packing a bundle at an inspection bench needs a reason; with one it is taken and the reason kept.
    const atBench = await refusedReport('qc', scanBody(BN.flow[0]!, 4, { workOrderOperationId: OPS.pack }))
    expect(refusalOf(atBench)).toBe('refusal/OTHER_KIND')
    expect(atBench.message).toBe('QC-01 is an inspection station; Op 40 Pack is packing work.')
    expect(fixOf(atBench)).toBe('Report it at a packing station, or give the reason it is done here.')
  })

  it('counts WIP per operation and cell from the standing reports, output per line only, never per person', async () => {
    const wip = await wipOf(WO.flow.id)
    expect(atOp(wip, OPS.cut)).toMatchObject({ arrived: 12, good: 12, waiting: 0, bundles: { done: 3, waiting: 0, notReached: 0 }, lines: [] })
    expect(atOp(wip, OPS.sew)).toMatchObject({ arrived: 12, good: 4, scrap: 1, waiting: 7, bundles: { done: 1, waiting: 2, notReached: 0 }, sewn: true, lines: [{ lineId: A.line, code: 'L1', good: 4 }] })
    expect(atOp(wip, OPS.qc)).toMatchObject({ arrived: 4, good: 4, waiting: 0, bundles: { done: 1, waiting: 0, notReached: 2 } })
    expect(atOp(wip, OPS.pack)).toMatchObject({ arrived: 4, waiting: 4, final: true })
    expect(atOp(wip, OPS.sew).cells).toEqual([{ workOrderSizeId: WO.flow.cells[0].id, colourwayCode: 'BLK', size: '50', arrived: 12, waiting: 7, good: 4, scrap: 1, rework: 0, missing: 0 }])
    expect(wip.cells).toEqual([{ workOrderSizeId: WO.flow.cells[0].id, colourwayCode: 'BLK', size: '50', quantity: 12, bundled: 12, sewn: 4, finished: 0, scrapped: 1, inRework: 0 }])
    expect(wip).toMatchObject({ allFinished: false, readyToComplete: false, correctionsWaiting: 0 })
    expect(keysOf(wip).filter((name) => /worker|station/i.test(name) || MONEY.test(name))).toEqual([])
    // The work order record's size grid: cut, bundled, sewn and finished per cell.
    const { workOrder } = await ok('planner', 'GET', `/production/work-orders/${WO.flow.id}`)
    expect(workOrder.cells.map((cell: Json) => cell.progress)).toEqual([{ cut: 12, bundled: 12, sewn: 4, finished: 0 }])
    expect(workOrder.progress.counted).toBe(true)
    // The site's floor at a glance: every open work order with its operations.
    const site = await ok('supervisor', 'GET', `/production/scans/wip?siteId=${A.siteA1}`)
    const flowRow = site.workOrders.find((row: Json) => row.workOrder.id === WO.flow.id)
    expect(flowRow).toMatchObject({ siteCode: expect.any(String), style: { code: expect.any(String), name: expect.any(String) }, pieces: 12, finished: 0, priority: expect.any(Number) })
    expect(flowRow.operations.find((op: Json) => op.seq === 20).lines).toEqual([{ lineId: A.line, code: 'L1', name: expect.any(String), good: 4 }])
    expect(keysOf(site).filter((name) => /worker|station/i.test(name) || MONEY.test(name))).toEqual([])
    // The list's progress for the same work order: the record's cells summed.
    const listed = (await ok('planner', 'GET', `/production/work-orders?q=${encodeURIComponent(WO.flow.number)}`)).workOrders.find((row: Json) => row.id === WO.flow.id)
    expect(listed.progress).toEqual({ cut: 12, bundled: 12, sewn: 4, finished: 0 })
    expect(site.workOrders.find((row: Json) => row.workOrder.id === WO.flow.id).operations.map((op: Json) => [op.seq, op.waiting, op.good])).toEqual([
      [10, 0, 12],
      [20, 7, 4],
      [30, 0, 4],
      [40, 4, 0],
    ])
  })
})

// ---- one standing report per bundle and operation: two tablets at once ------------------------------------------------------------

describe('one report per bundle per operation (MES-069): two tablets at once take turns, one wins, no deadlock', () => {
  it('lets the first report stand and refuses the second in words', async () => {
    const bundle = BN.race[0]!
    await reported('cutter', scanBody(bundle, 6))
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let locked!: () => void
    const holding = new Promise<void>((resolve) => (locked = resolve))
    // Another request holds the bundle's scan lock until released.
    const holder = asOffice(async (tx) => {
      await lockBundleScans(tx, A.tenant, A.siteA1, bundle.id)
      locked()
      await released
    })
    await holding
    const one = report('sew1', scanBody(bundle, 6))
    await untilWaiting(1, 'the first tablet', 'advisory')
    const two = report('sew2', scanBody(bundle, 5, { scrap: [{ reason: 'TEAR', quantity: 1 }] }))
    await untilWaiting(2, 'the second tablet', 'advisory')
    release()
    await holder
    const answers = await Promise.all([one, two])
    expect(answers.map((response) => response.statusCode).sort(), answers.map((response) => response.body).join('\n')).toEqual([201, 409])
    const loser = answers.find((response) => response.statusCode === 409)!.json().error
    expect(refusalOf(loser)).toBe('refusal/ALREADY_REPORTED')
    expect(loser.message).toMatch(new RegExp(`^You reported bundle ${bundle.code} already at Op 20 at \\d\\d:\\d\\d on SEW-0[12]\\.$`))
    expect(await standingCount(bundle.id, opOf(WO.race, 20))).toBe(1)
  })
})

// ---- undo ---------------------------------------------------------------------------------------------------------------------

describe('undo (MES-095): the own last report on this tablet, right after it, before the next operation takes it', () => {
  it('undoes the last report on the device clock, then refuses an older one, another tablet and another person', async () => {
    const [, second, third] = BN.flow
    const first = await reported('sew1', scanBody(second!, 5, { occurredAt: deviceAt(100) }))
    const undone = await undo('sew1', first.id, { occurredAt: deviceAt(130) })
    expect(undone.statusCode, undone.body).toBe(201)
    expect(undone.json().scan).toMatchObject({ kind: 'UNDO', correctsId: first.id, goodQuantity: 0, reason: 'Undone on the floor right after the report.' })
    expect(await standingCount(second!.id, OPS.sew)).toBe(0)
    // Both rows stay (append-only); the undo names the report's worker and station.
    expect(await admin(`SELECT kind, "workerId", "stationId" FROM "OperationScan" WHERE id IN ($1, $2) ORDER BY "serverTime"`, [first.id, undone.json().scan.id])).toEqual([
      { kind: 'REPORT', workerId: A.operatorA1, stationId: A.sew1Station },
      { kind: 'UNDO', workerId: A.operatorA1, stationId: A.sew1Station },
    ])
    const again = await reported('sew1', scanBody(second!, 5))
    const next = await reported('sew1', scanBody(third!, 2))
    expect(refusalOf((await undo('sew1', again.id)).json().error)).toBe('refusal/NOT_LAST')
    expect(refusalOf((await undo('sew2', next.id)).json().error)).toBe('refusal/NOT_YOURS')
    const other = (await undo('leadSew1', next.id)).json().error
    expect(refusalOf(other)).toBe('refusal/NOT_YOURS')
    expect(JSON.stringify(other)).not.toContain(A.operatorA1)
    // The next operation took it: undone no more, a correction instead.
    await reported('qc', scanBody(third!, 2))
    const taken = (await undo('sew1', next.id)).json().error
    expect(refusalOf(taken)).toBe('refusal/NEXT_REPORTED')
    expect(fixOf(taken)).toBe('Ask a correction instead.')
  })

  it('refuses an undo more than two minutes after the report on the device clock, even when both arrive together', async () => {
    const bundle = BN.late[0]!
    const cut = await reported('cut2', scanBody(bundle, 3, { occurredAt: deviceAt(1000) }))
    const late = await undo('cut2', cut.id, { occurredAt: deviceAt(1000 + 121) })
    expect(late.statusCode, late.body).toBe(409)
    expect(refusalOf(late.json().error)).toBe('refusal/UNDO_TOO_LATE')
  })
})

// ---- corrections ------------------------------------------------------------------------------------------------------------------

describe('a correction (MES-096): asked by the one who took it, approved by another person, the original kept', () => {
  let sewn: Json
  let request: Json

  it('asks a correction of an older own report, and refuses a second one while it waits', async () => {
    const { scans } = await ok('supervisor', 'GET', `/production/scans/work-orders/${WO.flow.id}/scans?bundleId=${BN.flow[0]!.id}`)
    sewn = scans.find((scan: Json) => scan.operation.seq === 20 && scan.kind === 'REPORT')
    expect(sewn).toMatchObject({ goodQuantity: 4, scrapQuantity: 1, worker: { id: A.operatorA1, name: expect.any(String) }, station: { code: 'SEW-01' }, voidedById: null })
    // Same counts and reason: nothing to correct.
    const same = await askCorrection('sew1', sewn.id, { good: 4, scrap: [{ reason: 'STAIN', quantity: 1 }], reason: 'Counted again' })
    expect(refusalOf(same.json().error)).toBe('refusal/SAME_COUNTS')
    // Inspection took 4: the sewing good may not fall below it.
    const less = await askCorrection('sew1', sewn.id, { good: 3, scrap: [{ reason: 'STAIN', quantity: 2 }], reason: 'Two stains' })
    expect(refusalOf(less.json().error)).toBe('refusal/LESS_THAN_TAKEN')
    const asked = await askCorrection('sew1', sewn.id, { good: 5, reason: 'The stain came off with cleaning', occurredAt: deviceAt(2000) })
    expect(asked.statusCode, asked.body).toBe(201)
    request = asked.json().request
    expect(request).toMatchObject({ status: 'PENDING', scanId: sewn.id, goodQuantity: 5, scrapQuantity: 0, reworkQuantity: 0, reason: 'The stain came off with cleaning', deviceId: A.sew1, deviceTime: deviceAt(2000) })
    expect(refusalOf((await askCorrection('sew1', sewn.id, { good: 5, reason: 'Again' })).json().error)).toBe('refusal/ASKED_ALREADY')
    // A worker who has not acknowledged the notice asks nothing that names them.
    expect(refusalOf((await askCorrection('leadSew1', sewn.id, { good: 5, reason: 'Mine' })).json().error)).toBe('refusal/NOTICE_NOT_ACKNOWLEDGED')
    const mine = await ok('sew1', 'GET', '/production/scans/mine')
    expect(mine.requests.map((row: Json) => [row.id, row.status])).toContainEqual([request.id, 'PENDING'])
    expect(mine.reports.find((row: Json) => row.id === sewn.id)).toMatchObject({ standing: true, correctionPending: true })
  })

  it('lists it for the office without a name, shows who asked inside its record, and never lets the scanner approve it', async () => {
    const { requests } = await ok('supervisor', 'GET', `/production/scans/corrections?status=PENDING&workOrderId=${WO.flow.id}`)
    expect(requests).toEqual([expect.objectContaining({ id: request.id, bundleCode: BN.flow[0]!.code, operation: expect.objectContaining({ seq: 20 }), recorded: expect.objectContaining({ goodQuantity: 4, scrapQuantity: 1 }) })])
    expect(keysOf(requests).filter((name) => /worker|askedBy/i.test(name))).toEqual([])
    const { request: record } = await ok('supervisor', 'GET', `/production/scans/corrections/${request.id}`)
    expect(record).toMatchObject({ askedBy: { id: A.operatorA1 }, askedAt: { code: 'SEW-01' }, scan: { worker: { id: A.operatorA1 }, defects: [{ kind: 'SCRAP', reason: 'STAIN', quantity: 1 }] } })
    expect((await wipOf(WO.flow.id)).correctionsWaiting).toBe(1)
    // The operator's own office account may decide corrections, but not this one.
    const self = await call('operatorOffice', 'POST', `/production/scans/corrections/${request.id}/approve`, {})
    expect(self.statusCode, self.body).toBe(409)
    expect(refusalOf(self.json().error)).toBe('refusal/SELF_APPROVAL')
  })

  it('approves: a CORRECTION row voids the report (which stays), with its worker and station, and WIP follows', async () => {
    const approved = await call('supervisor', 'POST', `/production/scans/corrections/${request.id}/approve`, { note: 'Seen the jacket' }, freshKey())
    expect(approved.statusCode, approved.body).toBe(201)
    const { request: decided, scan } = approved.json()
    expect(decided).toMatchObject({ status: 'APPROVED', correctionScanId: scan.id, decisionNote: 'Seen the jacket' })
    expect(scan).toMatchObject({ kind: 'CORRECTION', correctsId: sewn.id, goodQuantity: 5, scrapQuantity: 0, deviceId: null, reason: 'The stain came off with cleaning' })
    const rows = await admin(`SELECT id, kind, "workerId", "stationId", "approvedById", "createdById" FROM "OperationScan" WHERE id IN ($1, $2) ORDER BY "serverTime"`, [sewn.id, scan.id])
    expect(rows).toEqual([
      { id: sewn.id, kind: 'REPORT', workerId: A.operatorA1, stationId: A.sew1Station, approvedById: null, createdById: A.operatorA1 },
      { id: scan.id, kind: 'CORRECTION', workerId: A.operatorA1, stationId: A.sew1Station, approvedById: A.supervisor, createdById: A.supervisor },
    ])
    const wip = await wipOf(WO.flow.id)
    // B1 5 (corrected), B2 5 (reported again after its undo), B3 2.
    expect(atOp(wip, OPS.sew)).toMatchObject({ good: 12, scrap: 0 })
    expect(wip.correctionsWaiting).toBe(0)
    const again = await call('supervisor', 'POST', `/production/scans/corrections/${request.id}/approve`, {})
    expect(refusalOf(again.json().error)).toBe('refusal/DECIDED_ALREADY')
    const [event] = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'production.scan_correction_decided' AND payload->>'requestId' = $1`, [request.id])
    expect(event!.payload).toMatchObject({ decision: 'APPROVED', correctionScanId: scan.id })
    const { scans } = await ok('supervisor', 'GET', `/production/scans/work-orders/${WO.flow.id}/scans?bundleId=${BN.flow[0]!.id}`)
    expect(scans.find((row: Json) => row.id === sewn.id).voidedById).toBe(scan.id)
  })

  it('refuses a request with a note; the floor sees the answer', async () => {
    const { scans } = await ok('supervisor', 'GET', `/production/scans/work-orders/${WO.flow.id}/scans?bundleId=${BN.flow[0]!.id}`)
    const inspected = scans.find((scan: Json) => scan.operation.seq === 30 && scan.kind === 'REPORT')
    const asked = await askCorrection('qc', inspected.id, { good: 3, rework: [{ reason: 'RESTITCH', quantity: 1 }], reason: 'One seam to redo' })
    expect(asked.statusCode, asked.body).toBe(201)
    const refused = await call('supervisor', 'POST', `/production/scans/corrections/${asked.json().request.id}/refuse`, { note: 'The seam is fine' })
    expect(refused.statusCode, refused.body).toBe(201)
    expect(refused.json().request).toMatchObject({ status: 'REFUSED', decisionNote: 'The seam is fine', correctionScanId: null })
    expect((await ok('qc', 'GET', '/production/scans/mine')).requests.find((row: Json) => row.id === asked.json().request.id)).toMatchObject({ status: 'REFUSED' })
  })
})

// ---- offline -----------------------------------------------------------------------------------------------------------------------

describe('the offline queue (A1 §3.8): a batch in device order, each action accepted, a duplicate or refused with one fix', () => {
  let first: Json
  let items: Json[]

  it('judges a sewing tablet’s queue item by item and keeps every refusal with its words and fix', async () => {
    const [b1, b2, b3] = BN.offline
    const cut = await ok('cutter', 'POST', '/production/scans/batch', {
      sentAt: deviceAt(3000),
      items: [b1, b2, b3].map((bundle, index) => ({ action: 'REPORT', clientScanId: clientId(), code: bundle!.code, good: bundle!.quantity, occurredAt: deviceAt(2900 + index), workerId: A.operatorA1 })),
    })
    expect(cut.items.map((item: Json) => item.status)).toEqual(['accepted', 'accepted', 'accepted'])
    const reportId = clientId()
    items = [
      { action: 'REPORT', clientScanId: reportId, code: b1!.code, good: 5, occurredAt: deviceAt(3100), workerId: A.operatorA1 },
      { action: 'UNDO', clientScanId: clientId(), undoesClientScanId: reportId, occurredAt: deviceAt(3120), workerId: A.operatorA1 },
      { action: 'REPORT', clientScanId: clientId(), code: b1!.code, good: 4, scrap: [{ reason: 'TEAR', quantity: 1 }], occurredAt: deviceAt(3140), workerId: A.operatorA1 },
      // Inspection at a sewing station, with the reason: taken past the kind check, but sewing has not passed it yet.
      { action: 'REPORT', clientScanId: clientId(), code: b2!.code, good: 5, workOrderOperationId: opOf(WO.offline, 30), kindReason: 'Covering the inspection bench', occurredAt: deviceAt(3160), workerId: A.operatorA1 },
      { action: 'REPORT', clientScanId: clientId(), code: 'BN-ZZ-000001-A', good: 1, occurredAt: deviceAt(3170), workerId: A.operatorA1 },
      { action: 'REPORT', clientScanId: clientId(), code: b3!.code, good: 3, occurredAt: deviceAt(3180), workerId: A.operatorA1 },
      { action: 'REPORT', clientScanId: clientId(), code: b2!.code, good: 5, occurredAt: deviceAt(3190), workerId: A.leadA1 },
    ]
    // The tablet's clock is 7 minutes behind the server's.
    first = await ok('sew1', 'POST', '/production/scans/batch', { sentAt: new Date(Date.now() - 7 * 60_000).toISOString(), items })
    expect(first.items.map((item: Json) => [item.action, item.status, item.refusal?.code ?? null, item.refusal?.final ?? null])).toEqual([
      ['REPORT', 'accepted', null, null],
      ['UNDO', 'accepted', null, null],
      ['REPORT', 'accepted', null, null],
      ['REPORT', 'refused', 'PREVIOUS_NOT_REPORTED', false],
      ['REPORT', 'refused', 'UNKNOWN_BUNDLE', true],
      ['REPORT', 'refused', 'MORE_THAN_PASSED', true],
      ['REPORT', 'refused', 'OTHER_WORKER', false],
    ])
    expect(first.items[2].scan).toMatchObject({ goodQuantity: 4, scrapQuantity: 1, defects: [{ kind: 'SCRAP', reason: 'TEAR', quantity: 1 }], deviceTime: deviceAt(3140) })
    expect(first.items[5].refusal).toMatchObject({ message: `Op 10 Cut leather panels passed 2 garments of bundle ${b3!.code}; 3 reported here.`, fix: 'Count again: at most 2, or ask a correction of Op 10 first.' })
    expect(first.clock).toMatchObject({ off: true, flagged: false })
    expect(Math.abs(first.clock.skewSeconds - 420)).toBeLessThan(30)
    expect(await standingCount(b1!.id, opOf(WO.offline, 20))).toBe(1)
  })

  it('answers the same batch sent again with duplicates and the same refusals: not one row more', async () => {
    const before = await counts(`SELECT count(*)::int AS n FROM "OperationScan" WHERE "workOrderId" = $1`, [WO.offline.id])
    const refusalsBefore = await counts(`SELECT count(*)::int AS n FROM "FloorScanRefusal" WHERE "siteId" = $1`, [A.siteA1])
    const again = await ok('sew1', 'POST', '/production/scans/batch', { items })
    expect(again.items.map((item: Json) => item.status)).toEqual(['duplicate', 'duplicate', 'duplicate', 'refused', 'refused', 'refused', 'refused'])
    expect(again.items.map((item: Json) => item.scan?.id ?? item.refusal?.refusalId)).toEqual(first.items.map((item: Json) => item.scan?.id ?? item.refusal?.refusalId))
    expect(await counts(`SELECT count(*)::int AS n FROM "OperationScan" WHERE "workOrderId" = $1`, [WO.offline.id])).toBe(before)
    expect(await counts(`SELECT count(*)::int AS n FROM "FloorScanRefusal" WHERE "siteId" = $1`, [A.siteA1])).toBe(refusalsBefore)
    // Sent online once more under the same client scan id: the same scan (200); the id for another action: refused.
    const online = await report('sew1', { clientScanId: items[2]!.clientScanId, code: BN.offline[0]!.code, good: 4, scrap: [{ reason: 'TEAR', quantity: 1 }], occurredAt: deviceAt(3140) })
    expect(online.statusCode, online.body).toBe(200)
    expect(online.json()).toMatchObject({ replayed: true, scan: { id: first.items[2].scan.id } })
    const reused = await report('sew1', { clientScanId: items[1]!.clientScanId, code: BN.offline[1]!.code, good: 5 })
    expect(refusalOf(reused.json().error)).toBe('refusal/CLIENT_ID_REUSED')
  })

  it('keeps the refusals for the office (no names in the list) and the tablet, resolves one sent again, and discards one', async () => {
    const { refusals } = await ok('supervisor', 'GET', `/production/scans/refusals?siteId=${A.siteA1}&deviceId=${A.sew1}`)
    expect(refusals.map((row: Json) => row.code).sort()).toEqual(['MORE_THAN_PASSED', 'OTHER_WORKER', 'PREVIOUS_NOT_REPORTED', 'UNKNOWN_BUNDLE'])
    expect(refusals.find((row: Json) => row.code === 'MORE_THAN_PASSED')).toMatchObject({ action: 'REPORT', bundleId: BN.offline[2]!.id, workOrderId: WO.offline.id, goodQuantity: 3, device: { id: A.sew1, name: 'Sewing tablet 1' }, deviceTime: deviceAt(3180) })
    expect(keysOf(refusals)).not.toContain('worker')
    const { refusal: record } = await ok('supervisor', 'GET', `/production/scans/refusals/${refusals[0].id}`)
    expect(record.worker).toMatchObject({ id: A.operatorA1 })
    const mine = await ok('sew1', 'GET', '/production/scans/mine')
    expect(mine.refused.map((row: Json) => row.code).sort()).toEqual(['MORE_THAN_PASSED', 'OTHER_WORKER', 'PREVIOUS_NOT_REPORTED', 'UNKNOWN_BUNDLE'])
    expect(mine.othersRefused).toBe(0)
    // The fix done: the count sent again under the same id is taken, and its refusal is resolved.
    const fixed = await ok('sew1', 'POST', '/production/scans/batch', { items: [{ ...items[5], good: 2 }] })
    expect(fixed.items[0].status).toBe('accepted')
    const unknown = refusals.find((row: Json) => row.code === 'UNKNOWN_BUNDLE')
    const discarded = await ok('sew1', 'POST', `/production/scans/mine/refusals/${unknown.id}/discard`)
    expect(discarded.refusal.discardedAt).not.toBeNull()
    expect((await ok('sew1', 'POST', `/production/scans/mine/refusals/${unknown.id}/discard`)).refusal.discardedAt).toBe(discarded.refusal.discardedAt)
    const open = await ok('supervisor', 'GET', `/production/scans/refusals?siteId=${A.siteA1}&deviceId=${A.sew1}`)
    expect(open.refusals.map((row: Json) => row.code).sort()).toEqual(['OTHER_WORKER', 'PREVIOUS_NOT_REPORTED'])
    const all = await ok('supervisor', 'GET', `/production/scans/refusals?siteId=${A.siteA1}&deviceId=${A.sew1}&all=true`)
    expect(all.refusals.find((row: Json) => row.code === 'MORE_THAN_PASSED').resolvedByScanId).toBe(fixed.items[0].scan.id)
    // Another tablet cannot discard this tablet's refusal.
    expect((await call('sew2', 'POST', `/production/scans/mine/refusals/${open.refusals[0].id}/discard`)).statusCode).toBe(404)
    expect((await admin(`SELECT "discardedById" FROM "FloorScanRefusal" WHERE id = $1`, [unknown.id]))[0]!.discardedById).toBe(A.operatorA1)
    // A worker who has not acknowledged the notice is not named on a refused scan of theirs (Statuto art. 4 c.3).
    const lead = await ok('leadSew1', 'POST', '/production/scans/batch', { items: [{ action: 'REPORT', clientScanId: clientId(), code: BN.offline[1]!.code, good: 5 }] })
    expect(lead.items[0].refusal.code).toBe('NOTICE_NOT_ACKNOWLEDGED')
    expect((await admin(`SELECT "workerId", "createdById" FROM "FloorScanRefusal" WHERE id = $1`, [lead.items[0].refusal.refusalId]))[0]).toEqual({ workerId: null, createdById: null })
  })
})

// ---- tickets, people and sites ----------------------------------------------------------------------------------------------------

describe('what a scan takes (lockBundleForScan, B-W1-41; the floor rules, B-W1-37; the notice, B-W1-36)', () => {
  it('refuses an old ticket with the new code, and a void bundle', async () => {
    const [t1, t2] = BN.tickets
    const reprinted = await call('cutter', 'POST', `/production/bundles/${t1!.id}/reprint`, { reason: 'Ticket torn', printerId: null }, freshKey())
    expect(reprinted.statusCode, reprinted.body).toBe(201)
    const newCode = reprinted.json().bundle.code
    const old = await refusedReport('cutter', scanBody(t1!, 4))
    expect(refusalOf(old)).toBe('refusal/REPLACED')
    expect(fixOf(old)).toBe(`Discard it and scan the new ticket ${newCode}.`)
    expect((await ok('cutter', 'GET', `/production/scans/card?code=${t1!.code}`)).refusal).toMatchObject({ code: 'REPLACED' })
    await reported('cutter', { clientScanId: clientId(), code: newCode, good: 4 })
    expect((await call('cutter', 'POST', `/production/bundles/${t2!.id}/void`, { reason: 'Made twice' }, freshKey())).statusCode).toBe(201)
    expect(refusalOf(await refusedReport('cutter', scanBody(t2!, 4)))).toBe('refusal/VOIDED')
  })

  it('refuses a worker who has not acknowledged the published notice, and holds scans while the floor is not ready', async () => {
    const t3 = BN.tickets[2]!
    const lead = await refusedReport('leadCutter', scanBody(t3, 4))
    expect(refusalOf(lead)).toBe('refusal/NOTICE_NOT_ACKNOWLEDGED')
    const [basis] = await admin(`SELECT "monitoringBasis", "monitoringReference", "monitoringRecordedAt", "monitoringRecordedById" FROM "ProductionSettings" WHERE id = $1`, [A.siteA1])
    await admin(`UPDATE "ProductionSettings" SET "monitoringBasis" = NULL, "monitoringReference" = NULL, "monitoringRecordedAt" = NULL, "monitoringRecordedById" = NULL WHERE id = $1`, [A.siteA1])
    try {
      const held = await refusedReport('cutter', scanBody(t3, 4))
      expect(refusalOf(held)).toBe('refusal/FLOOR_NOT_READY')
      expect(held.message).toMatch(/^Scans are held at this site until its floor is ready: /)
    } finally {
      await admin(`UPDATE "ProductionSettings" SET "monitoringBasis" = $2, "monitoringReference" = $3, "monitoringRecordedAt" = $4, "monitoringRecordedById" = $5 WHERE id = $1`, [A.siteA1, basis!.monitoringBasis, basis!.monitoringReference, basis!.monitoringRecordedAt, basis!.monitoringRecordedById])
    }
  })

  it('at a site that records the station, names the station only (no worker, no creator), and needs a tablet with one', async () => {
    const t3 = BN.tickets[2]!
    await admin(`UPDATE "ProductionSettings" SET "scanSubject" = 'STATION' WHERE id = $1`, [A.siteA1])
    try {
      expect(refusalOf(await refusedReport('roaming', scanBody(t3, 4, { workOrderOperationId: opOf(WO.tickets, 10) })))).toBe('refusal/NO_STATION')
      const scan = await reported('cut2', scanBody(t3, 4))
      expect(await admin(`SELECT "workerId", "stationId", "createdById" FROM "OperationScan" WHERE id = $1`, [scan.id])).toEqual([{ workerId: null, stationId: A.cutStation, createdById: null }])
      // The station's own work: listed on its tablet and undone there.
      const mine = await ok('cut2', 'GET', '/production/scans/mine')
      expect(mine.undo).toMatchObject({ scanId: scan.id })
      expect(mine.reports.map((row: Json) => row.id)).toContain(scan.id)
      const undone = await undo('cut2', scan.id)
      expect(undone.statusCode, undone.body).toBe(201)
      expect(undone.json().scan).toMatchObject({ kind: 'UNDO', stationId: A.cutStation })
    } finally {
      await admin(`UPDATE "ProductionSettings" SET "scanSubject" = 'WORKER' WHERE id = $1`, [A.siteA1])
    }
  })
})

// ---- the work order completes --------------------------------------------------------------------------------------------------------

describe('the work order completes when every garment is finished (by the office: the floor can still undo the last one until then)', () => {
  it('finishes every garment at the final operation, says so, and the office completes it; then no scan is taken', async () => {
    const bundle = BN.done[0]!
    await reported('cutter', scanBody(bundle, 6))
    await reported('sew2', scanBody(bundle, 6))
    await reported('qc', scanBody(bundle, 6))
    const packed = await reported('pack', scanBody(bundle, 6))
    const wip = await wipOf(WO.done.id)
    expect(wip.cells).toEqual([expect.objectContaining({ quantity: 6, sewn: 6, finished: 6 })])
    expect(wip).toMatchObject({ allFinished: true, readyToComplete: true })
    const { workOrder: record } = await ok('planner', 'GET', `/production/work-orders/${WO.done.id}`)
    expect(record.cells.map((cell: Json) => cell.progress)).toEqual([{ cut: 6, bundled: 6, sewn: 6, finished: 6 }])
    const completed = await ok('planner', 'POST', `/production/work-orders/${WO.done.id}/complete`, {})
    expect(completed.workOrder.status).toBe('COMPLETED')
    expect((await wipOf(WO.done.id)).readyToComplete).toBe(false)
    expect(refusalOf((await undo('pack', packed.id)).json().error)).toBe('refusal/WORK_ORDER_NOT_OPEN')
    expect(refusalOf(await refusedReport('pack', scanBody(bundle, 1, { workOrderOperationId: opOf(WO.done, 40) })))).toBe('refusal/WORK_ORDER_NOT_OPEN')
  })
})

// ---- the walls ---------------------------------------------------------------------------------------------------------------------------

describe('walls: a tablet works at its own site, the office within its companies and tenant; audiences hold', () => {
  it('does not find another site’s bundle for a tablet, another company’s or tenant’s work order for the office', async () => {
    const bundle = BN.flow[0]!
    expect((await call('floorB1', 'GET', `/production/scans/card?code=${bundle.code}`)).statusCode).toBe(404)
    expect((await report('floorB1', scanBody(bundle, 1))).statusCode).toBe(404)
    expect((await call('companyB', 'GET', `/production/scans/work-orders/${WO.flow.id}/wip`)).statusCode).toBe(404)
    expect((await call('otherTenant', 'GET', `/production/scans/work-orders/${WO.flow.id}/wip`)).statusCode).toBe(404)
    // The other tenant sees its own seeded records only.
    const theirs = await ok('otherTenant', 'GET', '/production/scans/corrections')
    expect(theirs.requests.length).toBeGreaterThan(0)
    expect(theirs.requests.filter((row: Json) => Object.values(WO).some((workOrder) => workOrder.id === row.workOrder.id))).toEqual([])
    expect((await ok('otherTenant', 'GET', '/production/scans/refusals')).refusals.filter((row: Json) => row.siteId === A.siteA1)).toEqual([])
    expect((await ok('companyB', 'GET', `/production/scans/refusals?siteId=${A.siteA1}`)).refusals).toEqual([])
  })

  it('keeps the audiences apart and answers without money', async () => {
    expect((await call('sew1', 'GET', `/production/scans/work-orders/${WO.flow.id}/wip`)).statusCode).toBe(403)
    expect((await call('supervisor', 'POST', '/production/scans', scanBody(BN.flow[0]!, 1))).statusCode).toBe(403)
    expect((await call('viewer', 'GET', '/production/scans/corrections')).statusCode).toBe(403)
    expect((await call('sew1', 'POST', '/production/scans', { code: BN.flow[0]!.code, good: 1 })).statusCode).toBe(400)
    // A hide tag (another kind of label) or another factory's ticket is a 400 in words (another site's bundle: 404, above).
    const hideTag = await report('sew1', { clientScanId: clientId(), code: hides.H01!.code, good: 1 })
    expect(hideTag.statusCode, hideTag.body).toBe(400)
    expect((await report('sew1', { clientScanId: clientId(), code: 'BN-ZZ-000001-A', good: 1 })).statusCode).toBe(400)
    const header = await call('sew1', 'POST', '/production/scans', scanBody(BN.flow[0]!, 1), 'another-key-123')
    expect(header.statusCode).toBe(400)
    const card = await ok('sew1', 'GET', `/production/scans/card?code=${BN.flow[0]!.code}`)
    expect(keysOf(card).filter((name) => MONEY.test(name) || name === 'workerId')).toEqual([])
  })
})

// ---- the tables' own rules (…_production_scan_records_guards), for every login ------------------------------------------------------

describe('the scan records hold their rules for every login, the owner included', () => {
  const seededRequest = idOf(ns.a, 'production:scan-correction:WO-0001:1')
  const seededRefusal = idOf(ns.a, 'production:scan-refusal:A1:1')

  it('keeps a scrap or rework line within its scan’s count, and never changes or removes one', async () => {
    const [scan] = await admin(`SELECT id, "siteId", "tenantId" FROM "OperationScan" WHERE "workOrderId" = $1 AND kind = 'REPORT' AND "scrapQuantity" = 0 LIMIT 1`, [WO.flow.id])
    await expect(admin(`INSERT INTO "OperationScanDefect" (id, "tenantId", "siteId", "scanId", kind, "reasonCode", quantity) VALUES ($1, $2, $3, $4, 'SCRAP', 'STAIN', 1)`, [newId(), scan!.tenantId, scan!.siteId, scan!.id])).rejects.toThrow(
      /counts 1 SCRAP garment\(s\); its scan or request counts 0/,
    )
    await expect(admin(`INSERT INTO "OperationScanDefect" (id, "tenantId", "siteId", kind, "reasonCode", quantity) VALUES ($1, $2, $3, 'SCRAP', 'STAIN', 1)`, [newId(), scan!.tenantId, scan!.siteId])).rejects.toThrow(/exactly one scan or one correction request/)
    const [line] = await admin(`SELECT id FROM "OperationScanDefect" WHERE "tenantId" = $1 LIMIT 1`, [A.tenant])
    await expect(admin(`UPDATE "OperationScanDefect" SET quantity = 2 WHERE id = $1`, [line!.id])).rejects.toThrow(/append-only: UPDATE on "OperationScanDefect" is refused/)
    await expect(admin(`DELETE FROM "OperationScanDefect" WHERE id = $1`, [line!.id])).rejects.toThrow(/append-only: DELETE on "OperationScanDefect" is refused/)
    await expect(admin(`UPDATE "ScrapReason" SET code = 'SPOT' WHERE "tenantId" = $1 AND code = 'STAIN'`, [A.tenant])).rejects.toThrow(/keeps its kind and code/)
  })

  it('decides a correction request once, never by the scanner or the asker (nor their office account)', async () => {
    await expect(admin(`UPDATE "ScanCorrectionRequest" SET status = 'REFUSED', "decidedById" = $2, "decidedAt" = now(), "decisionNote" = 'No' WHERE id = $1`, [seededRequest, A.operatorUser])).rejects.toThrow(/four eyes/)
    // The asker (the scanner too) deciding it, as a lead on the floor would: refused as well.
    await expect(admin(`UPDATE "ScanCorrectionRequest" SET status = 'REFUSED', "decidedById" = $2, "decidedAt" = now(), "decisionNote" = 'No' WHERE id = $1`, [seededRequest, A.operatorA1])).rejects.toThrow(/four eyes/)
    await expect(admin(`UPDATE "ScanCorrectionRequest" SET status = 'REFUSED', "decidedById" = $2, "decidedAt" = now() WHERE id = $1`, [seededRequest, A.supervisor])).rejects.toThrow(/says why/)
    await expect(admin(`UPDATE "ScanCorrectionRequest" SET "goodQuantity" = 2 WHERE id = $1`, [seededRequest])).rejects.toThrow(/changes only by its decision/)
    await expect(admin(`DELETE FROM "ScanCorrectionRequest" WHERE id = $1`, [seededRequest])).rejects.toThrow(/never deleted/)
  })

  it('keeps what a device sent in a refused scan, closes it once, and never removes it', async () => {
    await expect(admin(`UPDATE "FloorScanRefusal" SET code = 'OTHER' WHERE id = $1`, [seededRefusal])).rejects.toThrow(/keeps what the device sent/)
    await expect(admin(`UPDATE "FloorScanRefusal" SET "resolvedByScanId" = (SELECT id FROM "OperationScan" WHERE "workOrderId" = $2 LIMIT 1) WHERE id = $1`, [seededRefusal, WO.flow.id])).rejects.toThrow(/sent again under the same id/)
    await expect(admin(`DELETE FROM "FloorScanRefusal" WHERE id = $1`, [seededRefusal])).rejects.toThrow(/never deleted/)
  })
})
