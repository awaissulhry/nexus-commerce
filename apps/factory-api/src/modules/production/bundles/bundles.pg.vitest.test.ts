import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase, type Prisma } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { formatScanId, parseScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { lockBundleForScan, lockCells } from './store'

/**
 * Bundles and bundle tickets from a cut (B-W1-41; MES-065, MES-066, MES-068, MES-073; PLAN §4.7 stage 12-scans; A2
 * SCR-095, SCR-072) on the local stack, with the app's real routes: a throwaway PostgreSQL 17 database from the
 * migrations (the runtime login: row-level security, the column grants and the …_production_guards Bundle and scan
 * triggers are real), the factory-db seeds of two tenants up to production (plant A1 names workers, its operator
 * acknowledged the published worker notice, its team leader nothing; company A's floor is ready: DPIA and notice from
 * the privacy seed), the numbering seed, a made-up certificate, a made-up lot of large black hides at A1 (1,000 ft²
 * each, so one hide cuts a whole work order), a made-up label printer at A1 (203 dpi, 100 × 100 mm, FAKE relay) and a
 * second cutting tablet. Released work orders of twelve black jackets in size 50 are made through the work-order routes
 * and cut through the cutting routes (twelve sets of 48.16 ft² from one hide). Sessions come from the test
 * authenticator. Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs bundles`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = { a: 'bundles-a', b: 'bundles-b' } as const
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
  station: idOf(ns.a, 'site:A1:station:CUT-01'),
  deviceA1: idOf(ns.a, 'device:A1:cutting'),
  deviceB1: idOf(ns.a, 'device:B1:cutting'),
  tablet2: newId(),
  printer: newId(),
  operatorA1: idOf(ns.a, 'worker:A1:operator'),
  leadA1: idOf(ns.a, 'worker:A1:lead'),
  operatorB1: idOf(ns.a, 'worker:B1:operator'),
}
const B = { tenant: idOf(ns.b, 'tenant') }
const TAG = tenantTag(A.tenant)

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const FLOOR: Permission[] = ['floor.work', 'production.cut', 'production.bundles', 'inventory.issue', 'print.view', 'print.labels']
const floor = (siteId: string, deviceId: string, actorId: string, companyId: string): SessionContext => ({ audience: 'floor', tenantId: A.tenant, actorId, siteId, deviceId, grants: [grant(FLOOR, [companyId], [siteId])] })
const OFFICE_BUNDLES: Permission[] = ['workorders.view', 'production.bundles', 'production.cut.correct', 'print.view', 'print.labels']
const SESSIONS: Record<string, SessionContext> = {
  /** Keeps the sites' floor rules (the standard bundle size). */
  settings: office(A.tenant, [grant(['production.settings.view', 'production.settings.manage'])]),
  /** Keeps the printers and the stations' label printers (MES-184). */
  printAdmin: office(A.tenant, [grant(['print.view', 'print.manage'])]),
  planner: office(A.tenant, [grant(['workorders.view', 'workorders.manage', 'workorders.release'])]),
  /** The production manager: reads a work order's bundles, reprints and voids them, corrects cuts. */
  manager: office(A.tenant, [grant(OFFICE_BUNDLES)]),
  /** Reads the work orders only (no print.view: the tickets' jobs are not shown). */
  viewer: office(A.tenant, [grant(['workorders.view'])]),
  companyB: office(A.tenant, [grant(OFFICE_BUNDLES, [A.companyB])]),
  otherTenant: office(B.tenant, [grant(OFFICE_BUNDLES)]),
  floor: floor(A.siteA1, A.deviceA1, A.operatorA1, A.companyA),
  /** The same operator on a second tablet at the cutting table. */
  tablet2: floor(A.siteA1, A.tablet2, A.operatorA1, A.companyA),
  /** The team leader on the cutting tablet: has not acknowledged the information notice. */
  floorLead: floor(A.siteA1, A.deviceA1, A.leadA1, A.companyA),
  floorB1: floor(A.siteB1, A.deviceB1, A.operatorB1, A.companyB),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `t-${run}-${++keys}`
let events = 0
const clientEvent = () => `ce-${run}-${++events}`
const call = (session: string, method: Method, url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key ?? freshKey())
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const asOffice = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) => client.$transaction(work, { timeout: 30_000 }))
const asFloor = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) =>
  database.withScope({ audience: 'floor', tenantId: A.tenant, actorId: A.operatorA1, siteId: A.siteA1 }, (client) => client.$transaction(work, { timeout: 30_000 }))
const refusalOf = (error: Json): string => String(error.issues?.[0]?.path ?? '')
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : []
const MONEY = /cost|price|margin|amount|wage|valuation/i
const counts = async (sql: string, values: unknown[]) => (await admin<{ n: number }>(sql, values))[0]!.n

const makeUrl = (workOrderId: string) => `/production/bundles/work-orders/${workOrderId}/bundles`
const make = (workOrderId: string, body: Json = {}, session = 'floor', key: string | undefined = freshKey()) => call(session, 'POST', makeUrl(workOrderId), body, key)
const refOf = (code: string) => {
  const scan = parseScanId(code, { tenantTag: TAG, types: ['BUNDLE'] })
  if (!scan.ok) throw new Error(`${code}: ${scan.message}`)
  return scan.ref
}
const activeSum = async (workOrderId: string) => counts(`SELECT coalesce(sum(quantity), 0)::int AS n FROM "Bundle" WHERE "workOrderId" = $1 AND status = 'ACTIVE'`, [workOrderId])

/** Waits until `n` sessions of this database wait for a lock (advisory, row or transaction). */
async function untilWaiting(n: number, what: string, locktype?: string) {
  for (let tries = 0; ; tries++) {
    // A row lock's wait is on the holder's transaction id, a lock with no database: the backend's database says whose it is.
    const [row] = await admin<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND a.datname = current_database() ${locktype ? `AND l.locktype = '${locktype}'` : ''}`,
    )
    if (row!.n >= n) return
    if (tries > 400) throw new Error(`${what} never waited`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

// ---- made-up stock, work orders and cuts ------------------------------------------------------------------------------------

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
      [newId(), A.tenant, A.companyA, A.siteA1, A.leather, A.leatherBLK, lotId, hideId, A.bin, `bundle-test-${run}-${key}`],
    )
  }
}

/** A CONFIRMED sales order of company A for black SEED-JKT-02 in sizes 50 and 52, typed by the office. */
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

/** A released work order of black jackets, made and released through the work-order routes. */
async function releasedWorkOrder(lineId: string, sizes: Record<string, number>): Promise<Json> {
  const { workOrder } = await ok('planner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: lineId, sizes: Object.entries(sizes).map(([size, quantity]) => ({ size, quantity })) }] }, 201)
  const released = await ok('planner', 'POST', `/production/work-orders/${workOrder.id}/release`, { materialOverride: { reason: 'The rest of the leather arrives next week' } })
  expect(released.workOrder.status).toBe('RELEASED')
  return released.workOrder
}

const cellOf = (workOrder: Json, size = '50'): string => workOrder.cells.find((cell: Json) => cell.size === size).id

/** Cuts every garment of the work order from one hide, through the cutting route (the floor). */
async function cutAll(workOrder: Json, hideKey: string): Promise<Json> {
  const response = await call('floor', 'POST', `/production/cutting/work-orders/${workOrder.id}/cuts`, { clientEventId: clientEvent(), code: hides[hideKey]!.code, lines: workOrder.cells.map((cell: Json) => ({ workOrderSizeId: cell.id, sets: cell.quantity })) }, freshKey())
  expect(response.statusCode, response.body).toBe(201)
  return response.json().cut
}

type Orders = 'main' | 'race' | 'pair' | 'part' | 'gate' | 'station' | 'size' | 'event' | 'printer'
const WO = {} as Record<Orders, Json>
const CUT = {} as Record<Orders, Json>
/** The Idempotency-Key of the first make of WO.main (replayed again after a reprint). */
let mainKey = ''

beforeAll(async () => {
  db = await migratedDatabase('bundles')
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
  await addHides(9)
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, 'Second cutting tablet', 'TABLET', 'ACTIVE', now())`, [A.tablet2, A.tenant, A.companyA, A.siteA1, A.station])
  await admin(
    `INSERT INTO "Printer" (id, "tenantId", "companyId", "siteId", code, name, kind, relay, "relayTarget", dpi, "labelWidthMm", "labelHeightMm") VALUES ($1, $2, $3, $4, 'LBL-BN', 'Made-up ticket printer', 'LABEL_ZPL', 'FAKE', 'test-ticket-printer:9100', 203, 100, 100)`,
    [A.printer, A.tenant, A.companyA, A.siteA1],
  )

  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  const line = await salesOrder({ '50': 120, '52': 6 })
  const plan: [Orders, Record<string, number>, string][] = [
    ['main', { '50': 12 }, 'H01'],
    ['race', { '50': 12 }, 'H02'],
    ['pair', { '50': 6, '52': 6 }, 'H03'],
    ['part', { '50': 12 }, 'H04'],
    ['gate', { '50': 12 }, 'H05'],
    ['station', { '50': 12 }, 'H06'],
    ['size', { '50': 12 }, 'H07'],
    ['event', { '50': 12 }, 'H08'],
    ['printer', { '50': 12 }, 'H09'],
  ]
  for (const [name, sizes, hide] of plan) {
    WO[name] = await releasedWorkOrder(line, sizes)
    CUT[name] = await cutAll(WO[name], hide)
  }
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

// ---- make and print ------------------------------------------------------------------------------------------------------------

describe('bundles from a cut (MES-065, MES-066): proposed, made and printed in one tap', () => {
  let made: Json
  let key: string

  it('lists the work orders whose cut waits for bundles and proposes bundles of the asked size', async () => {
    const { workOrders } = await ok('floor', 'GET', '/production/bundles/work-orders')
    const main = (workOrders as Json[]).find((row) => row.id === WO.main.id)
    expect(main).toMatchObject({ number: WO.main.number, toBundle: 12, cells: [{ workOrderSizeId: cellOf(WO.main), colourwayCode: 'BLK', size: '50', quantity: 12, cut: 12, bundled: 0, toBundle: 12 }] })
    expect((workOrders as Json[]).every((row) => row.siteId === A.siteA1)).toBe(true)
    // The seeded work order's cut is sleeves only: nothing whole to bundle; its traveller still finds it.
    expect((await ok('floor', 'GET', `/production/bundles/work-orders?number=${WO.main.number}`)).workOrders.map((row: Json) => row.id)).toEqual([WO.main.id])
    const view = await ok('floor', 'GET', `/production/bundles/work-orders/${WO.main.id}?bundleSize=5`)
    expect(view).toMatchObject({ bundleSize: 5, singlePiece: false, bundles: [], printers: [{ id: A.printer, code: 'LBL-BN' }] })
    expect(view.cells).toEqual([expect.objectContaining({ cut: 12, toBundle: 12, proposal: [5, 5, 2], parts: [{ part: 'Outer shell', pieces: 12, bundled: 0, toBundle: 12 }] })])
    expect(view.operations.map((operation: Json) => [operation.seq, operation.code])).toEqual([
      [10, 'SEED-CUT-LEA'],
      [20, 'SEED-SEW-ASM'],
      [30, 'SEED-FIN-QC'],
      [40, 'SEED-PACK'],
    ])
    expect(keysOf(view).filter((name) => MONEY.test(name))).toEqual([])
  })

  it('cuts 12 into 5 + 5 + 2 with the next codes of the tenant, names the cut, and queues three ZPL tickets', async () => {
    key = freshKey()
    mainKey = key
    const response = await make(WO.main.id, { bundleSize: 5 }, 'floor', key)
    expect(response.statusCode, response.body).toBe(201)
    made = response.json()
    expect(made.bundles.map((bundle: Json) => bundle.quantity)).toEqual([5, 5, 2])
    const refs = made.bundles.map((bundle: Json) => refOf(bundle.code))
    expect(refs).toEqual([refs[0], refs[0] + 1, refs[0] + 2])
    for (const bundle of made.bundles) {
      expect(bundle).toMatchObject({ workOrderId: WO.main.id, workOrderSizeId: cellOf(WO.main), colourwayCode: 'BLK', size: '50', part: null, status: 'ACTIVE', replacedCodes: [], cutLogIds: [CUT.main.id], deviceId: A.deviceA1 })
    }
    expect(made.cells).toEqual([expect.objectContaining({ cut: 12, bundled: 12, toBundle: 0 })])
    expect(made.replayed).toBe(false)
    // Three tickets on the site's only label printer: ZPL of the BUNDLE label with the operations below it.
    expect(made.tickets.map((ticket: Json) => [ticket.code, ticket.job?.status, ticket.job?.labelKind, ticket.job?.scanId, ticket.problem])).toEqual(made.bundles.map((bundle: Json) => [bundle.code, 'QUEUED', 'BUNDLE', bundle.code, null]))
    expect(made.tickets[2].ticket).toMatchObject({ workOrder: { number: WO.main.number, batchNumber: WO.main.batchNumber }, style: { code: 'SEED-JKT-02' }, colourway: { code: 'BLK' }, size: '50', quantity: 2, part: null })
    expect(made.tickets[2].label).toMatchObject({ kind: 'BUNDLE', scanId: made.bundles[2].code, fields: { size: '50', pieces: '2', operation: '10 · 20 · 30 · 40' } })
    const jobs = await admin(`SELECT "recordType", "recordId", "printerId", "labelKind", "scanId", zpl, status FROM "PrintJob" WHERE "recordType" = 'Bundle' AND "recordId" = ANY($1::uuid[]) ORDER BY "scanId"`, [made.bundles.map((bundle: Json) => bundle.id)])
    expect(jobs).toHaveLength(3)
    for (const job of jobs) {
      expect(job).toMatchObject({ printerId: A.printer, labelKind: 'BUNDLE', status: 'QUEUED' })
      expect(job.zpl).toContain(`^FD${job.scanId}^FS`)
      expect(job.zpl).toContain('^FD10 SEED-CUT-LEA Cut leather panels^FS')
      expect(job.zpl).toContain('^FD40 SEED-PACK Pack^FS')
    }
    // The rows: who made them (the acknowledged operator) and where; audited; announced.
    expect(await admin(`SELECT "createdById", "deviceId", quantity FROM "Bundle" WHERE "workOrderId" = $1 ORDER BY code`, [WO.main.id])).toEqual([5, 5, 2].map((quantity) => ({ createdById: A.operatorA1, deviceId: A.deviceA1, quantity })))
    expect(await counts(`SELECT count(*)::int AS n FROM "AuditLog" WHERE action = 'production.makeBundles' AND "idempotencyKey" = $1`, [key])).toBe(4)
    expect(await counts(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'production.bundle_created' AND "subject" = $1`, [WO.main.id])).toBe(3)
    expect(keysOf(made).filter((name) => MONEY.test(name))).toEqual([])
  })

  it('answers a repeated key from its receipt: the same bundles and the same print jobs, nothing new', async () => {
    const again = await ok('floor', 'POST', makeUrl(WO.main.id), { bundleSize: 5 }, 200, key)
    expect(again.replayed).toBe(true)
    expect(again.bundles.map((bundle: Json) => bundle.id)).toEqual(made.bundles.map((bundle: Json) => bundle.id))
    expect(again.tickets.map((ticket: Json) => ticket.job.id)).toEqual(made.tickets.map((ticket: Json) => ticket.job.id))
    expect(await counts(`SELECT count(*)::int AS n FROM "Bundle" WHERE "workOrderId" = $1`, [WO.main.id])).toBe(3)
    expect(await counts(`SELECT count(*)::int AS n FROM "PrintJob" WHERE "recordType" = 'Bundle' AND "recordId" = ANY($1::uuid[])`, [made.bundles.map((bundle: Json) => bundle.id)])).toBe(3)
    // A new key: all is bundled.
    expect(refusalOf(await refused('floor', 'POST', makeUrl(WO.main.id), { bundleSize: 5 }, 409))).toBe('refusal/NOTHING_TO_BUNDLE')
  })

  it('makes a part bundle (the outer shells on their own), counted against the whole garments', async () => {
    const response = await make(WO.part.id, { cells: [{ workOrderSizeId: cellOf(WO.part), part: 'Outer shell', quantity: 4, bundleSize: 4 }] })
    expect(response.statusCode, response.body).toBe(201)
    const answer = response.json()
    expect(answer.bundles).toEqual([expect.objectContaining({ part: 'Outer shell', quantity: 4 })])
    expect(answer.tickets[0].label.fields.pieces).toBe('4 · Outer shell')
    expect(answer.cells).toEqual([expect.objectContaining({ cut: 12, bundled: 0, toBundle: 8, parts: [{ part: 'Outer shell', pieces: 12, bundled: 4, toBundle: 8 }] })])
    expect(refusalOf(await refused('floor', 'POST', makeUrl(WO.part.id), { cells: [{ workOrderSizeId: cellOf(WO.part), part: 'Sleeve' }] }, 409))).toBe('refusal/NOT_A_PART')
    // Without a printer the ticket is the label for the browser's PDF.
    const pdf = await ok('floor', 'POST', makeUrl(WO.part.id), { cells: [{ workOrderSizeId: cellOf(WO.part), quantity: 3 }], printerId: null }, 201, freshKey())
    expect(pdf.tickets).toEqual([expect.objectContaining({ job: null, problem: 'No label printer is chosen: print the tickets as PDF.', label: expect.objectContaining({ kind: 'BUNDLE', scanId: pdf.bundles[0].code }) })])
  })
})

// ---- never more than was cut -----------------------------------------------------------------------------------------------------

describe('never more than was cut: a cell lock per cell, two tablets take turns', () => {
  it('refuses more garments than are cut and not bundled, in words', async () => {
    const error = await refused('floor', 'POST', makeUrl(WO.race.id), { cells: [{ workOrderSizeId: cellOf(WO.race), quantity: 13 }] }, 409)
    expect(refusalOf(error)).toBe('refusal/MORE_THAN_CUT')
    expect(error.message).toBe('BLK 50 has 12 cut garments not in bundles; 13 asked. A bundle never holds more than was cut.')
    expect(refusalOf(await refused('floor', 'POST', makeUrl(WO.race.id), { cells: [{ workOrderSizeId: cellOf(WO.race), quantities: [7, 6] }] }, 409))).toBe('refusal/MORE_THAN_CUT')
    // A request that does not hold together is a 400.
    expect((await call('floor', 'POST', makeUrl(WO.race.id), { cells: [{ workOrderSizeId: newId() }] }, freshKey())).statusCode).toBe(400)
    expect(await activeSum(WO.race.id)).toBe(0)
  })

  it('two tablets bundling one cell at once: one makes the bundles, the other is told nothing is left; no deadlock', async () => {
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let locked!: () => void
    const holding = new Promise<void>((resolve) => (locked = resolve))
    // Another request holds the cell's bundle lock until released.
    const holder = asOffice(async (tx) => {
      await lockCells(tx, A.tenant, A.siteA1, [cellOf(WO.race)])
      locked()
      await released
    })
    await holding
    const one = make(WO.race.id, { bundleSize: 6 }, 'floor')
    await untilWaiting(1, 'the first tablet', 'advisory')
    const two = make(WO.race.id, { bundleSize: 6 }, 'tablet2')
    await untilWaiting(2, 'the second tablet', 'advisory')
    release()
    await holder
    const answers = await Promise.all([one, two])
    expect(answers.map((response) => response.statusCode).sort(), answers.map((response) => response.body).join('\n')).toEqual([201, 409])
    expect(refusalOf(answers.find((response) => response.statusCode === 409)!.json().error)).toBe('refusal/NOTHING_TO_BUNDLE')
    expect(await activeSum(WO.race.id)).toBe(12)
    expect(await counts(`SELECT count(*)::int AS n FROM "Bundle" WHERE "workOrderId" = $1`, [WO.race.id])).toBe(2)
  })

  it('two tablets bundling two cells of one work order at once both make theirs', async () => {
    const answers = await Promise.all([
      make(WO.pair.id, { cells: [{ workOrderSizeId: cellOf(WO.pair, '50') }] }, 'floor'),
      make(WO.pair.id, { cells: [{ workOrderSizeId: cellOf(WO.pair, '52') }] }, 'tablet2'),
    ])
    expect(answers.map((response) => response.statusCode), answers.map((response) => response.body).join('\n')).toEqual([201, 201])
    const codes = answers.flatMap((response) => response.json().bundles.map((bundle: Json) => bundle.code))
    expect(new Set(codes).size).toBe(2)
    expect(await activeSum(WO.pair.id)).toBe(12)
  })
})

// ---- reprint, void, scan -----------------------------------------------------------------------------------------------------------

describe('a lost ticket reprinted with a new code; a bundle voided only before any scan (MES-073)', () => {
  const bundleOf = async (index: number): Promise<Json> => (await ok('floor', 'GET', `/production/bundles/work-orders/${WO.main.id}`)).bundles[index]

  it('reprints a ticket with the next code; the old code is refused when scanned, with the new one in the words', async () => {
    const before = await bundleOf(0)
    const [highest] = await admin<{ code: string }>(`SELECT code FROM "Bundle" WHERE "tenantId" = $1 AND code LIKE 'BN-%' ORDER BY length(code) DESC, code DESC LIMIT 1`, [A.tenant])
    const key = freshKey()
    const reprinted = await ok('floor', 'POST', `/production/bundles/${before.id}/reprint`, { reason: 'Lost' }, 201, key)
    expect(reprinted.replacedCode).toBe(before.code)
    expect(refOf(reprinted.bundle.code)).toBe(refOf(highest!.code) + 1)
    expect(reprinted.bundle).toMatchObject({ id: before.id, replacedCodes: [before.code], status: 'ACTIVE', quantity: 5 })
    expect(reprinted.ticket).toMatchObject({ code: reprinted.bundle.code, problem: null, job: { status: 'QUEUED', scanId: reprinted.bundle.code } })
    expect(await admin(`SELECT reason, "before", "after" FROM "AuditLog" WHERE action = 'production.reprintBundle' AND "recordType" = 'Bundle' AND "recordId" = $1`, [before.id])).toEqual([
      { reason: 'Lost', before: { code: before.code, replacedCodes: [] }, after: { code: reprinted.bundle.code, replacedCodes: [before.code] } },
    ])
    expect(await counts(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'production.bundle_reprinted' AND payload->>'bundleId' = $1`, [before.id])).toBe(1)
    // The first make sent again: the reprinted bundle's old ticket is not printed again; the others answer their jobs.
    const replay = await ok('floor', 'POST', makeUrl(WO.main.id), { bundleSize: 5 }, 200, mainKey)
    expect(replay.tickets[0]).toMatchObject({ code: before.code, job: null, problem: `Ticket ${before.code} was replaced by ${reprinted.bundle.code}: it is not printed again.` })
    expect(replay.tickets[1].job).toMatchObject({ status: 'QUEUED', scanId: replay.bundles[1].code })
    expect(await counts(`SELECT count(*)::int AS n FROM "PrintJob" WHERE "recordType" = 'Bundle' AND "recordId" = $1`, [before.id])).toBe(2)
    // The old ticket at a scanner: refused, with the new code.
    const old = await ok('floor', 'GET', `/production/bundles/scan?code=${before.code}`)
    expect(old.refusal).toEqual({ code: 'REPLACED', message: `Ticket ${before.code} was replaced by ${reprinted.bundle.code}: use the new ticket.` })
    expect(old.bundle.id).toBe(before.id)
    const current = await ok('floor', 'GET', `/production/bundles/scan?code=${reprinted.bundle.code.toLowerCase().replaceAll('-', '')}`)
    expect(current).toMatchObject({ scanned: reprinted.bundle.code, refusal: null, bundle: { id: before.id, scans: 0 }, workOrder: { id: WO.main.id } })
    expect(current.operations.map((operation: Json) => operation.done)).toEqual([false, false, false, false])
    // The scan's lock helper (B-W1-42) says the same inside a floor transaction.
    const locked = await asFloor((tx) => lockBundleForScan(tx, before.id, before.code))
    expect(locked).toMatchObject({ bundle: { id: before.id, status: 'ACTIVE', code: reprinted.bundle.code }, refusal: { code: 'REPLACED' } })
    expect((await asFloor((tx) => lockBundleForScan(tx, before.id)))!.refusal).toBeNull()
    // The office reprints too; with no printer the ticket is the PDF label.
    const office = await ok('manager', 'POST', `/production/bundles/${before.id}/reprint`, { reason: 'Damaged by oil', printerId: null }, 201)
    expect(office.bundle.replacedCodes).toEqual([before.code, reprinted.bundle.code])
    expect(office.ticket).toMatchObject({ job: null, label: { kind: 'BUNDLE', scanId: office.bundle.code } })
  })

  it('voids a bundle made by mistake before any scan: its garments wait for a bundle again', async () => {
    const last = await bundleOf(2)
    const voided = await ok('floor', 'POST', `/production/bundles/${last.id}/void`, { reason: 'Made by mistake' }, 201, freshKey())
    expect(voided.bundle).toMatchObject({ id: last.id, status: 'VOID', voidReason: 'Made by mistake', voidedAt: expect.any(String) })
    expect(voided.cell).toMatchObject({ cut: 12, bundled: 10, toBundle: 2 })
    expect(await counts(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'production.bundle_voided' AND payload->>'bundleId' = $1`, [last.id])).toBe(1)
    expect(refusalOf(await refused('floor', 'POST', `/production/bundles/${last.id}/void`, { reason: 'Again' }, 409))).toBe('refusal/VOIDED')
    expect(refusalOf(await refused('floor', 'POST', `/production/bundles/${last.id}/reprint`, { reason: 'Lost' }, 409))).toBe('refusal/VOIDED')
    expect((await ok('floor', 'GET', `/production/bundles/scan?code=${last.code}`)).refusal).toMatchObject({ code: 'VOIDED' })
    // The two garments are bundled again.
    const again = await ok('floor', 'POST', makeUrl(WO.main.id), {}, 201, freshKey())
    expect(again.bundles.map((bundle: Json) => bundle.quantity)).toEqual([2])
  })

  it('refuses to void a bundle a scan names (an inserted report at sewing), and shows the operation done', async () => {
    const second = await bundleOf(1)
    const view = await ok('floor', 'GET', `/production/bundles/work-orders/${WO.main.id}`)
    const sewing = view.operations.find((operation: Json) => operation.seq === 20).id
    await admin(
      `INSERT INTO "OperationScan" (id, "tenantId", "siteId", "workOrderId", "workOrderOperationId", "bundleId", kind, "goodQuantity", "workerId", "stationId", "deviceId", "clientScanId", "serverTime", "createdById")
       VALUES ($1, $2, $3, $4, $5, $6, 'REPORT', 5, $7, $8, $9, $10, now(), $7)`,
      [newId(), A.tenant, A.siteA1, WO.main.id, sewing, second.id, A.operatorA1, A.station, A.deviceA1, `scan-${run}-1`],
    )
    const error = await refused('floor', 'POST', `/production/bundles/${second.id}/void`, { reason: 'Made by mistake' }, 409)
    expect(refusalOf(error)).toBe('refusal/SCANNED')
    expect(error.message).toMatch(/was scanned already \(1 scan\)/)
    expect(await counts(`SELECT count(*)::int AS n FROM "Bundle" WHERE id = $1 AND status = 'ACTIVE'`, [second.id])).toBe(1)
    const card = await ok('floor', 'GET', `/production/bundles/scan?code=${second.code}`)
    expect(card.operations.map((operation: Json) => [operation.seq, operation.done])).toEqual([
      [10, false],
      [20, true],
      [30, false],
      [40, false],
    ])
  })

  it('a void waits for a scan that locked the bundle first (FOR SHARE), then sees the scan and refuses', async () => {
    const latest = (await ok('floor', 'GET', `/production/bundles/work-orders/${WO.main.id}`)).bundles.find((bundle: Json) => bundle.status === 'ACTIVE' && bundle.quantity === 2)
    const sewing = (await ok('floor', 'GET', `/production/bundles/work-orders/${WO.main.id}`)).operations.find((operation: Json) => operation.seq === 20).id
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let locked!: () => void
    const holding = new Promise<void>((resolve) => (locked = resolve))
    // B-W1-42's scan command: the bundle locked FOR SHARE, then its scan inserted, in one transaction.
    const scan = asFloor(async (tx) => {
      const found = await lockBundleForScan(tx, latest.id, latest.code)
      expect(found?.refusal).toBeNull()
      locked()
      await released
      await tx.operationScan.create({
        data: { id: newId(), siteId: A.siteA1, workOrderId: WO.main.id, workOrderOperationId: sewing, bundleId: latest.id, kind: 'REPORT', goodQuantity: 2, workerId: A.operatorA1, stationId: A.station, deviceId: A.deviceA1, clientScanId: `scan-${run}-2`, createdById: A.operatorA1 },
        select: { id: true },
      })
    })
    await holding
    const voiding = call('manager', 'POST', `/production/bundles/${latest.id}/void`, { reason: 'Made by mistake' }, freshKey())
    await untilWaiting(1, 'the void')
    release()
    await scan
    const response = await voiding
    expect(response.statusCode, response.body).toBe(409)
    expect(refusalOf(response.json().error)).toBe('refusal/SCANNED')
  })
})

// ---- the cut log and the bundles ------------------------------------------------------------------------------------------------

describe('the cut log and the bundles: a bundled cut is not reversed until its bundles are voided', () => {
  it('refuses to correct a cut whose pieces travel in our bundles, and lets it once they are voided', async () => {
    const view = await ok('manager', 'GET', `/production/bundles/work-orders/${WO.part.id}`)
    const codes = view.bundles.filter((bundle: Json) => bundle.status === 'ACTIVE').map((bundle: Json) => bundle.code).sort()
    const bundled = await refused('manager', 'POST', `/production/cutting/cuts/${CUT.part.id}/correct`, { reason: 'Logged on the wrong order' }, 409)
    expect(refusalOf(bundled)).toBe('refusal/IN_BUNDLE')
    expect(bundled.message).toContain(codes.join(', '))
    for (const bundle of view.bundles) await ok('manager', 'POST', `/production/bundles/${bundle.id}/void`, { reason: 'Cut logged on the wrong order' }, 201)
    await ok('manager', 'POST', `/production/cutting/cuts/${CUT.part.id}/correct`, { reason: 'Logged on the wrong order' }, 201)
    const after = await ok('manager', 'GET', `/production/bundles/work-orders/${WO.part.id}`)
    expect(after.cells).toEqual([expect.objectContaining({ cut: 0, bundled: 0, toBundle: 0 })])
    expect(refusalOf(await refused('floor', 'POST', makeUrl(WO.part.id), {}, 409))).toBe('refusal/NOTHING_TO_BUNDLE')
  })
})

// ---- who a bundle names, and the floor's readiness ------------------------------------------------------------------------------

describe('the floor gate and who a bundle names (Statuto dei Lavoratori art. 4; MES-278)', () => {
  it("holds bundles while the site's floor is not ready, in the gate's words; nothing is made", async () => {
    const [basis] = await admin(`SELECT "monitoringBasis", "monitoringReference", "monitoringRecordedAt", "monitoringRecordedById" FROM "ProductionSettings" WHERE id = $1`, [A.siteA1])
    expect(basis!.monitoringBasis).not.toBeNull()
    await admin(`UPDATE "ProductionSettings" SET "monitoringBasis" = NULL, "monitoringReference" = NULL, "monitoringRecordedAt" = NULL, "monitoringRecordedById" = NULL WHERE id = $1`, [A.siteA1])
    try {
      const error = await refused('floor', 'POST', makeUrl(WO.gate.id), {}, 409)
      expect(refusalOf(error)).toBe('refusal/FLOOR_NOT_READY')
      expect(error.message).toMatch(/^Bundles are held at this site until its floor is ready: Floor records name workers, but no legal basis is on record/)
      expect(await activeSum(WO.gate.id)).toBe(0)
    } finally {
      await admin(`UPDATE "ProductionSettings" SET "monitoringBasis" = $2, "monitoringReference" = $3, "monitoringRecordedAt" = $4, "monitoringRecordedById" = $5 WHERE id = $1`, [
        A.siteA1,
        basis!.monitoringBasis,
        basis!.monitoringReference,
        basis!.monitoringRecordedAt,
        basis!.monitoringRecordedById,
      ])
    }
  })

  it('refuses a worker who has not acknowledged the published worker notice', async () => {
    expect((await refused('floorLead', 'POST', makeUrl(WO.gate.id), {}, 409)).message).toMatch(/acknowledge the information notice first/)
    expect(await activeSum(WO.gate.id)).toBe(0)
  })

  it('at a site that records the station, a bundle names nobody', async () => {
    await admin(`UPDATE "ProductionSettings" SET "scanSubject" = 'STATION' WHERE id = $1`, [A.siteA1])
    try {
      const answer = await ok('tablet2', 'POST', makeUrl(WO.station.id), {}, 201, freshKey())
      expect(await admin(`SELECT "createdById", "deviceId" FROM "Bundle" WHERE id = ANY($1::uuid[])`, [answer.bundles.map((bundle: Json) => bundle.id)])).toEqual([
        { createdById: null, deviceId: A.tablet2 },
        { createdById: null, deviceId: A.tablet2 },
      ])
    } finally {
      await admin(`UPDATE "ProductionSettings" SET "scanSubject" = 'WORKER' WHERE id = $1`, [A.siteA1])
    }
  })
})

// ---- the office's list, and the walls ----------------------------------------------------------------------------------------------

describe("the office's bundles of a work order; the walls hold", () => {
  it('lists every bundle with its genealogy, scans and last scan (never who); the tickets only with print.view', async () => {
    const viewer = await ok('viewer', 'GET', `/production/bundles/work-orders/${WO.main.id}/bundles`)
    expect(viewer.cells).toEqual([expect.objectContaining({ cut: 12, bundled: 12, toBundle: 0 })])
    expect(viewer.bundles).toHaveLength(4)
    expect(viewer.bundles.every((bundle: Json) => bundle.tickets === null)).toBe(true)
    const scanned = viewer.bundles.find((bundle: Json) => bundle.scans === 1 && bundle.quantity === 5)
    expect(scanned).toMatchObject({ doneAt: [20], lastScan: { operation: { seq: 20, code: 'SEED-SEW-ASM' }, station: { id: A.station, code: 'CUT-01' } }, hides: [{ hideId: hides.H01!.id, code: hides.H01!.code }] })
    expect(keysOf(viewer).filter((name) => /worker|createdBy/i.test(name))).toEqual([])
    const manager = await ok('manager', 'GET', `/production/bundles/work-orders/${WO.main.id}/bundles`)
    const reprinted = manager.bundles.find((bundle: Json) => bundle.replacedCodes.length === 2)
    expect(reprinted.tickets.map((ticket: Json) => ticket.scanId)).toEqual([reprinted.replacedCodes[1], reprinted.replacedCodes[0]])
  })

  it('keeps a tablet to its site and the office to its companies and tenant; floor and office routes stay apart', async () => {
    const bundle = (await ok('manager', 'GET', `/production/bundles/work-orders/${WO.main.id}`)).bundles[0]
    expect((await call('floorB1', 'GET', `/production/bundles/work-orders/${WO.main.id}`)).statusCode).toBe(404)
    expect((await call('floorB1', 'POST', makeUrl(WO.gate.id), {}, freshKey())).statusCode).toBe(404)
    expect((await call('floorB1', 'GET', `/production/bundles/scan?code=${bundle.code}`)).statusCode).toBe(404)
    expect((await call('floorB1', 'POST', `/production/bundles/${bundle.id}/void`, { reason: 'Not ours' }, freshKey())).statusCode).toBe(404)
    expect((await call('companyB', 'GET', `/production/bundles/work-orders/${WO.main.id}/bundles`)).statusCode).toBe(404)
    expect((await call('companyB', 'POST', `/production/bundles/${bundle.id}/reprint`, { reason: 'Lost' }, freshKey())).statusCode).toBe(404)
    expect((await call('otherTenant', 'GET', `/production/bundles/work-orders/${WO.main.id}/bundles`)).statusCode).toBe(404)
    // Another factory's code is refused in words, before any lookup.
    const foreign = await call('floor', 'GET', `/production/bundles/scan?code=${formatScanId({ type: 'BUNDLE', tenantTag: TAG === '00' ? '11' : '00', ref: 1 })}`)
    expect(foreign.statusCode).toBe(400)
    expect(foreign.json().error.issues[0].message).toBe('This label belongs to another factory.')
    // The office's list is no floor route; the floor's make is no office route; a viewer changes nothing.
    expect((await call('floor', 'GET', `/production/bundles/work-orders/${WO.main.id}/bundles`)).statusCode).toBe(403)
    expect((await call('manager', 'POST', makeUrl(WO.gate.id), {}, freshKey())).statusCode).toBe(403)
    expect((await call('viewer', 'POST', `/production/bundles/${bundle.id}/void`, { reason: 'Mine' }, freshKey())).statusCode).toBe(403)
    // A floor write needs its Idempotency-Key.
    expect((await call('floor', 'POST', makeUrl(WO.gate.id), {})).statusCode).toBe(400)
    expect(await activeSum(WO.gate.id)).toBe(0)
  })
})

// ---- production leftovers: the standard bundle size, the floor queue's event, the reprint's reason, the station printer --

describe("the site's standard bundle size (MES-065; production settings): proposed and made when the floor names none", () => {
  it("bundles by the site's size, an asked one still wins, and the work order record counts the garments bundled", async () => {
    const before = await ok('settings', 'GET', `/production/settings/${A.siteA1}`)
    expect(before.rules.standardBundleSize).toBe(10)
    const changed = await ok('settings', 'POST', `/production/settings/${A.siteA1}/bundle-size`, { standardBundleSize: 4, version: before.rules.version })
    expect(changed).toMatchObject({ changed: true, change: null, rules: { standardBundleSize: 4, scanSubject: 'WORKER', version: before.rules.version + 1 } })
    try {
      expect((await ok('floor', 'GET', '/production/floor-rules')).standardBundleSize).toBe(4)
      const view = await ok('floor', 'GET', `/production/bundles/work-orders/${WO.size.id}`)
      expect(view).toMatchObject({ bundleSize: 4, standardBundleSize: 4, cells: [expect.objectContaining({ toBundle: 12, proposal: [4, 4, 4] })] })
      expect((await ok('floor', 'GET', `/production/bundles/work-orders/${WO.size.id}?bundleSize=5`)).cells[0].proposal).toEqual([5, 5, 2])
      const made = await ok('floor', 'POST', makeUrl(WO.size.id), {}, 201, freshKey())
      expect(made.bundles.map((bundle: Json) => bundle.quantity)).toEqual([4, 4, 4])
      // The work order record's progress: cut, bundled (ACTIVE whole-garment bundles), sewn and finished per cell.
      const { workOrder } = await ok('planner', 'GET', `/production/work-orders/${WO.size.id}`)
      expect(workOrder.cells.map((cell: Json) => cell.progress)).toEqual([{ cut: 12, bundled: 12, sewn: 0, finished: 0 }])
      await ok('floor', 'POST', `/production/bundles/${made.bundles[2].id}/void`, { reason: 'Made by mistake' }, 201, freshKey())
      expect((await ok('planner', 'GET', `/production/work-orders/${WO.size.id}`)).workOrder.cells[0].progress).toEqual({ cut: 12, bundled: 8, sewn: 0, finished: 0 })
    } finally {
      await ok('settings', 'POST', `/production/settings/${A.siteA1}/bundle-size`, { standardBundleSize: 10 })
    }
  })
})

describe("an event of the floor queue makes one bundle, once (Bundle.clientEventId; A1 §3.8)", () => {
  it('a resend under another key answers the bundle it made; the same id for another bundle is a conflict; one event, one bundle', async () => {
    const event = `ce-${run}-bundle-1`
    const body = { cells: [{ workOrderSizeId: cellOf(WO.event), quantities: [5] }], clientEventId: event }
    const first = await ok('floor', 'POST', makeUrl(WO.event.id), body, 201, freshKey())
    expect(first.bundles).toEqual([expect.objectContaining({ quantity: 5, clientEventId: event, status: 'ACTIVE' })])
    expect(first.tickets[0].job).toMatchObject({ status: 'QUEUED', scanId: first.bundles[0].code })
    const again = await ok('floor', 'POST', makeUrl(WO.event.id), body, 200, freshKey())
    expect(again).toMatchObject({ replayed: true, bundles: [{ id: first.bundles[0].id, code: first.bundles[0].code }], cells: [expect.objectContaining({ cut: 12, bundled: 5, toBundle: 7 })] })
    expect(again.tickets[0].job.id).toBe(first.tickets[0].job.id)
    expect(await counts(`SELECT count(*)::int AS n FROM "Bundle" WHERE "clientEventId" = $1`, [event])).toBe(1)
    expect(await counts(`SELECT count(*)::int AS n FROM "PrintJob" WHERE "recordType" = 'Bundle' AND "recordId" = $1`, [first.bundles[0].id])).toBe(1)
    // The same id for another bundle (a part bundle of the cell, a bundle of another work order): refused.
    expect((await call('floor', 'POST', makeUrl(WO.event.id), { cells: [{ workOrderSizeId: cellOf(WO.event), part: 'Outer shell', quantities: [5] }], clientEventId: event }, freshKey())).statusCode).toBe(409)
    expect((await call('floor', 'POST', makeUrl(WO.main.id), { clientEventId: event }, freshKey())).statusCode).toBe(409)
    // One event makes one bundle: two are a 400 in words, and nothing is made.
    const two = await refused('floor', 'POST', makeUrl(WO.event.id), { cells: [{ workOrderSizeId: cellOf(WO.event), quantities: [2, 2] }], clientEventId: `ce-${run}-bundle-2` }, 400)
    expect(two.issues).toEqual([{ path: 'body/clientEventId', message: expect.stringContaining('Send one event per bundle') }])
    expect(await activeSum(WO.event.id)).toBe(5)
  })

  it('records one bundle when the same event arrives twice at once under two keys', async () => {
    const event = `ce-${run}-bundle-3`
    const body = { cells: [{ workOrderSizeId: cellOf(WO.event), quantities: [3] }], clientEventId: event }
    const answers = await Promise.all([make(WO.event.id, body, 'floor'), make(WO.event.id, body, 'tablet2')])
    expect(answers.map((response) => response.statusCode).sort(), answers.map((response) => response.body).join('\n')).toEqual([200, 201])
    expect(new Set(answers.map((response) => response.json().bundles[0].id)).size).toBe(1)
    expect(await counts(`SELECT count(*)::int AS n FROM "Bundle" WHERE "clientEventId" = $1`, [event])).toBe(1)
    expect(await activeSum(WO.event.id)).toBe(8)
  })
})

describe('a reprint says why (BundleReprint; MES-073): a real row with the reason, and the database holds it', () => {
  it('keeps each reprint with its codes, reason, printer and device; the office list shows them (never who); a new code without one is refused', async () => {
    const bundle = (await ok('floor', 'GET', `/production/bundles/work-orders/${WO.event.id}`)).bundles.find((row: Json) => row.status === 'ACTIVE' && row.quantity === 5)
    const reprinted = await ok('floor', 'POST', `/production/bundles/${bundle.id}/reprint`, { reason: '  Unreadable after the press  ' }, 201, freshKey())
    expect(await admin(`SELECT code, "replacedCode", reason, "printerId", "deviceId", "createdById", "companyId", "workOrderId" FROM "BundleReprint" WHERE "bundleId" = $1`, [bundle.id])).toEqual([
      { code: reprinted.bundle.code, replacedCode: bundle.code, reason: 'Unreadable after the press', printerId: A.printer, deviceId: A.deviceA1, createdById: A.operatorA1, companyId: A.companyA, workOrderId: WO.event.id },
    ])
    const office = await ok('manager', 'POST', `/production/bundles/${bundle.id}/reprint`, { reason: 'Lost on the trolley', printerId: null }, 201)
    const list = await ok('viewer', 'GET', `/production/bundles/work-orders/${WO.event.id}/bundles`)
    expect(list.bundles.find((row: Json) => row.id === bundle.id).reprints).toEqual([
      { code: reprinted.bundle.code, replacedCode: bundle.code, reason: 'Unreadable after the press', printerId: A.printer, postedBy: 'FLOOR', at: expect.any(String) },
      { code: office.bundle.code, replacedCode: reprinted.bundle.code, reason: 'Lost on the trolley', printerId: null, postedBy: 'OFFICE', at: expect.any(String) },
    ])
    expect(keysOf(list).filter((name) => /worker|createdBy/i.test(name))).toEqual([])
    // A reprint names who reprinted: a worker who has not acknowledged the notice reprints nothing (Statuto art. 4 c.3).
    expect((await refused('floorLead', 'POST', `/production/bundles/${bundle.id}/reprint`, { reason: 'Lost' }, 409)).message).toMatch(/acknowledge the information notice first/)
    // The database, for every login: a new code without its reprint row (the reason) is refused.
    await expect(admin(`UPDATE "Bundle" SET code = 'T-NEW-CODE', "replacedCodes" = "replacedCodes" || code WHERE id = $1`, [bundle.id])).rejects.toThrow(/says why: its BundleReprint row/)
    expect(await counts(`SELECT count(*)::int AS n FROM "BundleReprint" WHERE "bundleId" = $1`, [bundle.id])).toBe(2)
  })
})

describe("the station label printer (MES-184): a station names its printer; its tablets' tickets print there", () => {
  it('pairs a station with a label printer of its site (print.manage, audited); tickets and reprints go there when the floor names none', async () => {
    const second = newId()
    const a4 = newId()
    await admin(
      `INSERT INTO "Printer" (id, "tenantId", "companyId", "siteId", code, name, kind, relay, "relayTarget", dpi, "labelWidthMm", "labelHeightMm") VALUES ($1, $2, $3, $4, 'LBL-CUT', 'Made-up cutting table printer', 'LABEL_ZPL', 'FAKE', 'test-cut-printer:9100', 203, 100, 100)`,
      [second, A.tenant, A.companyA, A.siteA1],
    )
    await admin(`INSERT INTO "Printer" (id, "tenantId", "companyId", "siteId", code, name, kind, relay, "relayTarget") VALUES ($1, $2, $3, $4, 'A4-T', 'Made-up office printer', 'A4_PDF', 'FAKE', 'test-a4')`, [a4, A.tenant, A.companyA, A.siteA1])
    const cells = { cells: [{ workOrderSizeId: cellOf(WO.printer), quantities: [4] }] }
    try {
      // Two label printers and no pairing: the tablet names one.
      expect((await call('floor', 'POST', makeUrl(WO.printer.id), cells, freshKey())).statusCode).toBe(400)
      const station = (await ok('printAdmin', 'GET', `/print/stations?siteId=${A.siteA1}`)).stations.find((row: Json) => row.id === A.station)
      expect(station).toMatchObject({ code: 'CUT-01', siteId: A.siteA1, labelPrinterId: null })
      const url = `/print/stations/${A.station}/label-printer`
      // Only a label printer of the station's site that is in use; only print.manage pairs.
      expect((await call('printAdmin', 'PUT', url, { printerId: a4, version: station.version })).statusCode).toBe(400)
      expect((await call('manager', 'PUT', url, { printerId: second, version: station.version })).statusCode).toBe(403)
      expect((await call('floor', 'PUT', url, { printerId: second, version: station.version })).statusCode).toBe(403)
      const paired = await ok('printAdmin', 'PUT', url, { printerId: second, version: station.version })
      expect(paired).toMatchObject({ changed: true, station: { id: A.station, labelPrinterId: second, version: station.version + 1 } })
      expect(await admin(`SELECT before, after FROM "AuditLog" WHERE action = 'print.setStationPrinter' AND "recordId" = $1`, [A.station])).toEqual([{ before: { labelPrinterId: null }, after: { labelPrinterId: second } }])
      expect((await ok('printAdmin', 'PUT', url, { printerId: second, version: paired.station.version })).changed).toBe(false)
      // The tablet at the station reads its site's stations, sees the pairing, and its tickets print there.
      expect((await ok('floor', 'GET', '/print/stations')).stations.every((row: Json) => row.siteId === A.siteA1)).toBe(true)
      expect(await ok('floor', 'GET', `/production/bundles/work-orders/${WO.printer.id}`)).toMatchObject({ stationPrinterId: second, defaultPrinterId: second })
      const made = await ok('floor', 'POST', makeUrl(WO.printer.id), cells, 201, freshKey())
      expect(made.tickets.map((ticket: Json) => ticket.job?.printerId)).toEqual([second])
      const reprinted = await ok('floor', 'POST', `/production/bundles/${made.bundles[0].id}/reprint`, { reason: 'Damaged' }, 201, freshKey())
      expect(reprinted.ticket.job.printerId).toBe(second)
      expect(await admin(`SELECT "printerId" FROM "BundleReprint" WHERE "bundleId" = $1`, [made.bundles[0].id])).toEqual([{ printerId: second }])
      // The office has no station: with two label printers it names one.
      expect((await call('manager', 'POST', `/production/bundles/${made.bundles[0].id}/reprint`, { reason: 'Lost' }, freshKey())).statusCode).toBe(400)
      // A paused station printer is said in words; nothing is made.
      await admin(`UPDATE "Printer" SET status = 'PAUSED' WHERE id = $1`, [second])
      expect((await refused('floor', 'POST', makeUrl(WO.printer.id), cells, 409)).message).toMatch(/^Printer LBL-CUT is paused/)
      expect(await activeSum(WO.printer.id)).toBe(4)
      await admin(`UPDATE "Printer" SET status = 'ACTIVE' WHERE id = $1`, [second])
      // The database holds the pairing for every login: never a PDF printer, never an archived one.
      await expect(admin(`UPDATE "Station" SET "labelPrinterId" = $2 WHERE id = $1`, [A.station, a4])).rejects.toThrow(/prints its tickets on a label printer that is in use/)
      // Unpaired again: the station's tablets name a printer (two at the site).
      const unpaired = await ok('printAdmin', 'PUT', url, { printerId: null, version: paired.station.version })
      expect(unpaired).toMatchObject({ changed: true, station: { labelPrinterId: null } })
      expect((await call('floor', 'POST', makeUrl(WO.printer.id), cells, freshKey())).statusCode).toBe(400)
    } finally {
      await admin(`UPDATE "Station" SET "labelPrinterId" = NULL WHERE id = $1`, [A.station])
      await admin(`UPDATE "Printer" SET status = 'ARCHIVED' WHERE id = ANY($1::uuid[])`, [[second, a4]])
    }
  })
})
