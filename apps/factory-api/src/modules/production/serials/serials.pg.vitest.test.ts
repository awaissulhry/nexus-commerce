import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase, type Prisma } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { parseScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { lockLabelCells } from './store'

/**
 * Batch or serial at the final operation and the garment labels behind the certificate gate (B-W1-44; MES-076, PRD-348,
 * QHS-051, PRD-331; PLAN §4.7 stage 13a-labels; Q31; A2 SCR-096, SCR-072) on the local stack with the app's real routes:
 * a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security, the column grants and
 * the GarmentSerial trigger are real), the factory-db seeds of two tenants up to production (plant A1 names workers, its
 * operator acknowledged the published worker notice, its team leader nothing; company A's floor is ready), the numbering
 * seed, two made-up certificates of the seeded jacket (one covers size 50, the other size 52), a made-up lot of large
 * black hides, made-up tablets at A1's sewing, inspection and packing stations and a made-up label printer at A1 (203 dpi,
 * 100 × 100 mm, FAKE relay). Released work orders are made through the work-order routes, cut, bundled and reported
 * through every operation (10 cut, 20 sew, 30 inspection, 40 pack: finished = packed) through the floor's routes. The
 * jacket traces by batch first (Q31 (a)); the serial tests then switch it to SERIAL (the database refuses that once its
 * work orders have labels, so the test proves the refusal and then flips it with triggers off, as a fixture), and take
 * the serials from the tenant's real GARMENT_SERIAL counter (platform/numbering allocateScanIds). Sessions come from the test authenticator. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs serials`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = { a: 'serials-a', b: 'serials-b' } as const
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
  sew1Station: idOf(ns.a, 'site:A1:station:SEW-01'),
  qcStation: idOf(ns.a, 'site:A1:station:QC-01'),
  packStation: idOf(ns.a, 'site:A1:station:PACK-01'),
  cutter: idOf(ns.a, 'device:A1:cutting'),
  deviceB1: idOf(ns.a, 'device:B1:cutting'),
  sew1: newId(),
  qc: newId(),
  pack: newId(),
  pack2: newId(),
  printer: newId(),
  operatorA1: idOf(ns.a, 'worker:A1:operator'),
  leadA1: idOf(ns.a, 'worker:A1:lead'),
  operatorB1: idOf(ns.a, 'worker:B1:operator'),
}
const B = { tenant: idOf(ns.b, 'tenant') }
const TAG = tenantTag(A.tenant)

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const FLOOR: Permission[] = ['floor.work', 'production.cut', 'production.bundles', 'production.scan', 'production.serials', 'inventory.issue', 'print.view', 'print.labels']
const floor = (siteId: string, deviceId: string, actorId: string, companyId: string, permissions = FLOOR): SessionContext => ({ audience: 'floor', tenantId: A.tenant, actorId, siteId, deviceId, grants: [grant(permissions, [companyId], [siteId])] })
const OFFICE_LABELS: Permission[] = ['workorders.view', 'production.serials', 'print.view', 'print.labels']
const SESSIONS: Record<string, SessionContext> = {
  planner: office(A.tenant, [grant(['workorders.view', 'workorders.manage', 'workorders.release'])]),
  /** The production manager: reads the labels, reprints and voids. */
  manager: office(A.tenant, [grant(OFFICE_LABELS)]),
  /** Reads the work orders only (no production.serials, no print.view). */
  viewer: office(A.tenant, [grant(['workorders.view'])]),
  companyB: office(A.tenant, [grant(OFFICE_LABELS, [A.companyB])]),
  otherTenant: office(B.tenant, [grant(OFFICE_LABELS)]),
  cutter: floor(A.siteA1, A.cutter, A.operatorA1, A.companyA),
  sew1: floor(A.siteA1, A.sew1, A.operatorA1, A.companyA),
  qc: floor(A.siteA1, A.qc, A.operatorA1, A.companyA),
  pack: floor(A.siteA1, A.pack, A.operatorA1, A.companyA),
  /** A second packing tablet (two benches print at once). */
  pack2: floor(A.siteA1, A.pack2, A.operatorA1, A.companyA),
  /** The packer without the label permission. */
  packNoLabels: floor(A.siteA1, A.pack, A.operatorA1, A.companyA, FLOOR.filter((permission) => permission !== 'production.serials')),
  /** The team leader on the packing tablet: has not acknowledged the information notice. */
  leadPack: floor(A.siteA1, A.pack, A.leadA1, A.companyA),
  floorB1: floor(A.siteB1, A.deviceB1, A.operatorB1, A.companyB),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `t-${run}-${++keys}`
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
const refusalOf = (error: Json): string => String(error.issues?.[0]?.path ?? '')
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

const viewUrl = (workOrderId: string) => `/production/serials/work-orders/${workOrderId}`
const printUrl = (workOrderId: string) => `/production/serials/work-orders/${workOrderId}/labels`
const print = (workOrderId: string, body: Json = {}, session = 'pack', key: string = freshKey()) => call(session, 'POST', printUrl(workOrderId), body, key)
const garmentJobs = (recordIds: string[]) => admin(`SELECT "recordType", "recordId", "scanId", copies, "labelKind", zpl FROM "PrintJob" WHERE "labelKind" = 'GARMENT' AND "recordId" = ANY($1::uuid[]) ORDER BY "createdAt", id`, [recordIds])
const logRows = (cellIds: string[]) =>
  admin(
    `SELECT id, kind::text AS kind, tracking::text AS tracking, "workOrderSizeId", quantity, "batchNumber", "serialIds", reason, "printerId", "deviceId", "createdById" FROM "GarmentLabelPrint" WHERE "workOrderSizeId" = ANY($1::uuid[]) ORDER BY "createdAt", id`,
    [cellIds],
  )
const serialsOf = (workOrderId: string) => admin(`SELECT id, serial, status::text AS status, "workOrderSizeId", "bundleId", "createdById", "voidReason" FROM "GarmentSerial" WHERE "workOrderId" = $1 ORDER BY "createdAt", serial`, [workOrderId])

// ---- made-up stock, work orders, cuts, bundles and scans -------------------------------------------------------------------------

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
      [newId(), A.tenant, A.companyA, A.siteA1, A.leather, A.leatherBLK, lotId, hideId, A.bin, `serial-test-${run}-${key}`],
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

async function releasedWorkOrder(lineId: string, sizes: Record<string, number>): Promise<Json> {
  const { workOrder } = await ok('planner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: lineId, sizes: Object.entries(sizes).map(([size, quantity]) => ({ size, quantity })) }] }, 201)
  const released = await ok('planner', 'POST', `/production/work-orders/${workOrder.id}/release`, { materialOverride: { reason: 'The rest of the leather arrives next week' } })
  expect(released.workOrder.status).toBe('RELEASED')
  return released.workOrder
}

const cellOf = (workOrder: Json, size = '50'): string => workOrder.cells.find((cell: Json) => cell.size === size).id
const opOf = (workOrder: Json, seq: number): string => (workOrder.spec.operations as Json[]).find((op) => op.seq === seq)!.id

/** Cuts every garment of the work order from one hide and makes its bundles (PDF tickets), through the floor's routes. */
async function cutAndBundle(workOrder: Json, hideKey: string, bundleSize: number): Promise<Json[]> {
  const cut = await call('cutter', 'POST', `/production/cutting/work-orders/${workOrder.id}/cuts`, { clientEventId: `ce-${run}-${++keys}`, code: hides[hideKey]!.code, lines: workOrder.cells.map((cell: Json) => ({ workOrderSizeId: cell.id, sets: cell.quantity })) }, freshKey())
  expect(cut.statusCode, cut.body).toBe(201)
  const made = await call('cutter', 'POST', `/production/bundles/work-orders/${workOrder.id}/bundles`, { bundleSize, printerId: null }, freshKey())
  expect(made.statusCode, made.body).toBe(201)
  return made.json().bundles
}

/** Reports a bundle at every operation up to `untilSeq` with `good` garments (the floor's scans, one station each). */
async function reportThrough(workOrder: Json, bundle: Json, good: number, untilSeq = 40) {
  const stations: [number, string][] = [
    [10, 'cutter'],
    [20, 'sew1'],
    [30, 'qc'],
    [40, 'pack'],
  ]
  for (const [seq, session] of stations) {
    if (seq > untilSeq) break
    const response = await call(session, 'POST', '/production/scans', { clientScanId: `sc-${run}-${++keys}`, code: bundle.code, workOrderOperationId: opOf(workOrder, seq), good })
    expect(response.statusCode, response.body).toBe(201)
  }
}

type Orders = 'batch' | 'race' | 'gate' | 'serial' | 'walls'
const WO = {} as Record<Orders, Json>
const BN = {} as Record<Orders, Json[]>
let certificate52 = ''

beforeAll(async () => {
  db = await migratedDatabase('serials')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 12 } })
  for (const namespace of [ns.a, ns.b]) {
    await seedCore({ db: database, namespace })
    await seedPrivacy({ db: database, namespace })
    await seedProduction({ db: database, namespace })
    await seedNumbering({ db: database, namespace })
  }
  certificate52 = newId()
  await asOffice(async (tx) => {
    for (const [certificateId, size] of [
      [newId(), '50'],
      [certificate52, '52'],
    ] as const) {
      await tx.certificate.create({
        data: {
          id: certificateId,
          holderPartyId: A.brand,
          standard: 'EN 17092-3:2020',
          ppeClass: 'AA',
          number: `T-${run}-CERT-${size}`,
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
      await tx.certificateCoverage.create({ data: { id: newId(), certificateId, styleId: A.style, sizes: [size] }, select: { id: true } })
    }
  })
  await addHides(6)
  for (const [deviceId, stationId, name] of [
    [A.sew1, A.sew1Station, 'Sewing tablet 1'],
    [A.qc, A.qcStation, 'Inspection tablet'],
    [A.pack, A.packStation, 'Packing tablet'],
    [A.pack2, A.packStation, 'Second packing tablet'],
  ] as const) {
    await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, $6, 'TABLET', 'ACTIVE', now())`, [deviceId, A.tenant, A.companyA, A.siteA1, stationId, name])
  }
  await admin(
    `INSERT INTO "Printer" (id, "tenantId", "companyId", "siteId", code, name, kind, relay, "relayTarget", dpi, "labelWidthMm", "labelHeightMm") VALUES ($1, $2, $3, $4, 'LBL-GA', 'Made-up garment label printer', 'LABEL_ZPL', 'FAKE', 'test-garment-printer:9100', 203, 100, 100)`,
    [A.printer, A.tenant, A.companyA, A.siteA1],
  )

  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  const line = await salesOrder({ '50': 60, '52': 20 })
  const plan: [Orders, Record<string, number>, string, number][] = [
    ['batch', { '50': 6, '52': 4 }, 'H01', 10],
    ['race', { '50': 4 }, 'H02', 10],
    ['gate', { '50': 3, '52': 3 }, 'H03', 10],
    ['serial', { '50': 6 }, 'H04', 5],
    ['walls', { '50': 2 }, 'H05', 10],
  ]
  for (const [name, sizes, hide, size] of plan) {
    WO[name] = await releasedWorkOrder(line, sizes)
    BN[name] = await cutAndBundle(WO[name], hide, size)
  }
  // Finished garments: batch 50 → 5 of 6 (one bundle of 6, 5 good all the way), 52 → 4; race 4; gate 3 + 3; serial: the
  // bundle of 5 packed, the bundle of 1 still at inspection; walls 2.
  const bundleOf = (name: Orders, size: string) => BN[name].find((bundle) => bundle.size === size)!
  await reportThrough(WO.batch, bundleOf('batch', '50'), 5)
  await reportThrough(WO.batch, bundleOf('batch', '52'), 4)
  await reportThrough(WO.race, BN.race[0]!, 4)
  await reportThrough(WO.gate, bundleOf('gate', '50'), 3)
  await reportThrough(WO.gate, bundleOf('gate', '52'), 3)
  await reportThrough(WO.serial, BN.serial.find((bundle) => bundle.quantity === 5)!, 5)
  await reportThrough(WO.serial, BN.serial.find((bundle) => bundle.quantity === 1)!, 1, 30)
  await reportThrough(WO.walls, BN.walls[0]!, 2)
}, 900_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

// ---- BATCH: the work order's batch number on every label -----------------------------------------------------------------------

describe('a batch-tracked style (Q31 (a)): the batch number on N labels, never more than finished', () => {
  let firstKey = ''
  let firstEntry = ''

  it('shows each size at the final operation: finished, labelled, to label, the certificate gate, the printer and the label', async () => {
    const view = await ok('pack', 'GET', `${viewUrl(WO.batch.id)}?cellId=${cellOf(WO.batch)}`)
    expect(view).toMatchObject({
      workOrder: { id: WO.batch.id, number: WO.batch.number, batchNumber: WO.batch.batchNumber, status: 'IN_PROGRESS' },
      tracking: 'BATCH',
      label: { status: 'ACTIVE' },
      finalOperation: { seq: 40 },
      blocked: null,
      printers: [{ id: A.printer, code: 'LBL-GA', holdsLabel: true }],
    })
    expect(view.cells.map((cell: Json) => [cell.size, cell.quantity, cell.finished, cell.labelled, cell.toLabel, cell.printable, cell.gate.outcome])).toEqual([
      ['50', 6, 5, 0, 5, true, 'covered'],
      ['52', 4, 4, 0, 4, true, 'covered'],
    ])
    expect(view.cells[0].gate.words).toBe(`EN 17092-3:2020 class AA · certificate T-${run}-CERT-50 valid until 2030-12-31.`)
    const batch = view.preview.blocks.find((block: Json) => block.field === 'batchOrSerial')
    expect(batch).toMatchObject({ value: WO.batch.batchNumber, placeholder: false })
    expect(view.preview.printable).toBe(true)
    expect(keysOf(view).filter((name) => MONEY.test(name))).toEqual([])
  })

  it('prints 3 labels of size 50 as one GARMENT job with the batch number, logs the print and emits the event', async () => {
    firstKey = freshKey()
    const response = await print(WO.batch.id, { cells: [{ workOrderSizeId: cellOf(WO.batch), count: 3 }] }, 'pack', firstKey)
    expect(response.statusCode, response.body).toBe(201)
    const answer = response.json()
    expect(answer).toMatchObject({ tracking: 'BATCH', printerId: A.printer, refused: [], replayed: false, workOrder: { batchNumber: WO.batch.batchNumber } })
    expect(answer.printed).toHaveLength(1)
    const [line] = answer.printed
    firstEntry = line.entryId
    expect(line).toMatchObject({ workOrderSizeId: cellOf(WO.batch), size: '50', count: 3, batchNumber: WO.batch.batchNumber, serials: [], problem: null, job: { status: 'QUEUED', labelKind: 'GARMENT', scanId: WO.batch.batchNumber, copies: 3 } })
    const jobs = await garmentJobs([cellOf(WO.batch)])
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ recordType: 'WorkOrderSize', scanId: WO.batch.batchNumber, copies: 3 })
    expect(jobs[0]!.zpl).toContain(WO.batch.batchNumber)
    expect(jobs[0]!.zpl).toContain('^PQ3')
    expect(answer.cells.find((cell: Json) => cell.size === '50')).toMatchObject({ finished: 5, labelled: 3, toLabel: 2 })
    const log = await logRows([cellOf(WO.batch)])
    expect(log).toEqual([
      { id: firstEntry, kind: 'PRINT', tracking: 'BATCH', workOrderSizeId: cellOf(WO.batch), quantity: 3, batchNumber: WO.batch.batchNumber, serialIds: [], reason: null, printerId: A.printer, deviceId: A.pack, createdById: A.operatorA1 },
    ])
    expect(await counts(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "recordType" = 'GarmentLabelPrint' AND "recordId" = $1`, [firstEntry])).toBe(1)
    expect(await counts(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'production.garment_labels_printed' AND payload->>'workOrderSizeId' = $1`, [cellOf(WO.batch)])).toBe(1)
  })

  it('answers a resend from its receipt: the same job, no second entry', async () => {
    const again = await print(WO.batch.id, { cells: [{ workOrderSizeId: cellOf(WO.batch), count: 3 }] }, 'pack', firstKey)
    expect(again.statusCode, again.body).toBe(200)
    expect(again.json()).toMatchObject({ replayed: true, printed: [{ entryId: firstEntry, count: 3 }] })
    expect(await garmentJobs([cellOf(WO.batch)])).toHaveLength(1)
    expect(await logRows([cellOf(WO.batch)])).toHaveLength(1)
  })

  it('refuses more labels than finished garments without one, in words, and writes nothing', async () => {
    const error = await refused('pack', 'POST', printUrl(WO.batch.id), { cells: [{ workOrderSizeId: cellOf(WO.batch), count: 3 }] }, 409)
    expect(refusalOf(error)).toBe('refusal/MORE_THAN_FINISHED')
    expect(error.message).toBe('BLK 50 has 5 garments finished and 3 of them labelled: 2 still need a label, not 3.')
    expect(error.issues[1]).toEqual({ path: 'fix', message: 'Print 2, or report more garments at Op 40 SEED-PACK first.' })
    expect(await logRows([cellOf(WO.batch)])).toHaveLength(1)
    expect(await garmentJobs([cellOf(WO.batch)])).toHaveLength(1)
  })

  it('"Print all" prints what each size still needs; then nothing is left', async () => {
    const answer = await ok('pack', 'POST', printUrl(WO.batch.id), {}, 201, freshKey())
    expect(answer.printed.map((line: Json) => [line.size, line.count, line.job?.copies])).toEqual([
      ['50', 2, 2],
      ['52', 4, 4],
    ])
    expect(answer.cells.map((cell: Json) => [cell.size, cell.labelled, cell.toLabel])).toEqual([
      ['50', 5, 0],
      ['52', 4, 0],
    ])
    const error = await refused('pack', 'POST', printUrl(WO.batch.id), {}, 409)
    expect(refusalOf(error)).toBe('refusal/NOTHING_TO_LABEL')
    expect(error.message).toBe(`Every finished garment of work order ${WO.batch.number} has its label (9 garments).`)
  })

  it('reprints labels with the batch number and a reason, at most those printed; the floor and the office alike', async () => {
    const url = `/production/serials/work-orders/${WO.batch.id}/reprint`
    const answer = await ok('pack', 'POST', url, { workOrderSizeId: cellOf(WO.batch), count: 2, reason: 'Smudged in the press' }, 201, freshKey())
    expect(answer.reprinted).toMatchObject({ count: 2, batchNumber: WO.batch.batchNumber, job: { copies: 2, scanId: WO.batch.batchNumber } })
    expect(answer.cells.find((cell: Json) => cell.size === '50')).toMatchObject({ labelled: 5, reprinted: 2, toLabel: 0 })
    const office = await ok('manager', 'POST', url, { workOrderSizeId: cellOf(WO.batch, '52'), count: 1, reason: 'Torn when sewn in' }, 201, freshKey())
    expect(office.reprinted).toMatchObject({ count: 1, size: '52' })
    const error = await refused('pack', 'POST', url, { workOrderSizeId: cellOf(WO.batch), count: 6, reason: 'Lost the roll' }, 409)
    expect(refusalOf(error)).toBe('refusal/MORE_THAN_PRINTED')
    expect(error.message).toBe('5 labels of BLK 50 were printed: a reprint replaces at most 5, not 6.')
    expect((await call('pack', 'POST', url, { workOrderSizeId: cellOf(WO.batch), count: 1 }, freshKey())).statusCode).toBe(400)
    const log = await logRows([cellOf(WO.batch), cellOf(WO.batch, '52')])
    expect(log.filter((row) => row.kind === 'REPRINT').map((row) => [row.reason, row.deviceId, row.quantity])).toEqual([
      ['Smudged in the press', A.pack, 2],
      ['Torn when sewn in', null, 1],
    ])
  })

  it("gives the office the work order's label log (with reasons, never who) and the jobs only with print.view", async () => {
    const answer = await ok('manager', 'GET', `/production/serials/work-orders/${WO.batch.id}/serials`)
    expect(answer).toMatchObject({ tracking: 'BATCH', serials: [] })
    expect(answer.log.map((entry: Json) => [entry.kind, entry.size, entry.quantity, entry.reason, entry.postedBy])).toEqual([
      ['REPRINT', '52', 1, 'Torn when sewn in', 'OFFICE'],
      ['REPRINT', '50', 2, 'Smudged in the press', 'FLOOR'],
      ['PRINT', '52', 4, null, 'FLOOR'],
      ['PRINT', '50', 2, null, 'FLOOR'],
      ['PRINT', '50', 3, null, 'FLOOR'],
    ])
    expect(answer.log[1].deviceId).toBe(A.pack)
    expect(answer.cells.find((cell: Json) => cell.size === '50').jobs.map((job: Json) => job.copies)).toEqual([2, 2, 3])
    const viewer = await ok('viewer', 'GET', `/production/serials/work-orders/${WO.batch.id}/serials`)
    expect(viewer.cells.every((cell: Json) => cell.jobs === null)).toBe(true)
    expect(keysOf(answer).filter((name) => MONEY.test(name) || /name$/i.test(name))).toEqual(['colourwayName', 'colourwayName'])
  })
})

describe('two benches at once: the cap holds under concurrency', () => {
  it('two tablets printing the same size together give its finished garments one label each, never more', async () => {
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let locked!: () => void
    const holding = new Promise<void>((resolve) => (locked = resolve))
    // Another request holds the cell's label lock until released: both tablets must wait for it, then take turns.
    const holder = asOffice(async (tx) => {
      await lockLabelCells(tx, A.tenant, A.siteA1, [cellOf(WO.race)])
      locked()
      await released
    })
    await holding
    const body = { cells: [{ workOrderSizeId: cellOf(WO.race), count: 3 }] }
    const one = print(WO.race.id, body, 'pack')
    await untilWaiting(1, 'the first tablet', 'advisory')
    const two = print(WO.race.id, body, 'pack2')
    await untilWaiting(2, 'the second tablet', 'advisory')
    release()
    await holder
    const [first, second] = await Promise.all([one, two])
    const statuses = [first.statusCode, second.statusCode].sort()
    expect(statuses, `${first.body} ${second.body}`).toEqual([201, 409])
    const loser = (first.statusCode === 409 ? first : second).json().error
    expect(refusalOf(loser)).toBe('refusal/MORE_THAN_FINISHED')
    expect(loser.message).toBe('BLK 50 has 4 garments finished and 3 of them labelled: 1 still needs a label, not 3.')
    const log = await logRows([cellOf(WO.race)])
    expect(log.reduce((sum, row) => sum + row.quantity, 0)).toBe(3)
  })
})

describe('the certificate gate at print (QHS-051): an expired certificate refuses its size only, in words', () => {
  it('prints the covered size and refuses the size whose certificate expired', async () => {
    // One label of size 52 while its certificate is valid; then the notified body's certificate expires.
    expect((await ok('pack', 'POST', printUrl(WO.gate.id), { cells: [{ workOrderSizeId: cellOf(WO.gate, '52'), count: 1 }] }, 201, freshKey())).printed[0].count).toBe(1)
    await admin(`UPDATE "Certificate" SET status = 'EXPIRED', "statusChangedAt" = now() WHERE id = $1`, [certificate52])
    const view = await ok('pack', 'GET', viewUrl(WO.gate.id))
    const c52 = view.cells.find((cell: Json) => cell.size === '52')
    expect(c52).toMatchObject({ printable: false, gate: { outcome: 'refused' }, refusal: { code: 'CERTIFICATE' } })
    expect(c52.gate.words).toMatch(new RegExp(`Certificate T-${run}-CERT-52 \\(EN 17092-3:2020, notified body 9999\\) expired: its last valid day was 2030-12-31\\.`))
    expect(view.cells.find((cell: Json) => cell.size === '50')).toMatchObject({ printable: true, refusal: null })

    const answer = await ok('pack', 'POST', printUrl(WO.gate.id), {}, 201, freshKey())
    expect(answer.printed.map((line: Json) => [line.size, line.count])).toEqual([['50', 3]])
    expect(answer.refused).toHaveLength(1)
    expect(answer.refused[0]).toMatchObject({ code: 'CERTIFICATE', workOrderSizeId: cellOf(WO.gate, '52'), fix: 'Tell quality: the labels of this size print only once a valid certificate covers it.' })
    expect(answer.refused[0].message).toMatch(/^No valid certificate covers BLK 52 of style SEED-JKT-02 on \d{4}-\d{2}-\d{2}: its garment label is not printed \(Reg\. \(EU\) 2016\/425 art\. 17\)\./)
    expect(answer.refused[0].message).toContain('expired')
    expect(answer.cells.map((cell: Json) => [cell.size, cell.labelled, cell.toLabel])).toEqual([
      ['50', 3, 0],
      ['52', 1, 2],
    ])
    expect(await garmentJobs([cellOf(WO.gate, '52')])).toHaveLength(1)
  })

  it('refuses a print of that size alone with 409 in the gate words, and writes nothing', async () => {
    const error = await refused('pack', 'POST', printUrl(WO.gate.id), { cells: [{ workOrderSizeId: cellOf(WO.gate, '52') }] }, 409)
    expect(refusalOf(error)).toBe('refusal/CERTIFICATE')
    expect(error.message).toContain(`Certificate T-${run}-CERT-52 (EN 17092-3:2020, notified body 9999) expired`)
    expect(await logRows([cellOf(WO.gate, '52')])).toHaveLength(1)
  })

  it('refuses a reprint of the refused size too: no label without a valid certificate', async () => {
    const error = await refused('manager', 'POST', `/production/serials/work-orders/${WO.gate.id}/reprint`, { workOrderSizeId: cellOf(WO.gate, '52'), count: 1, reason: 'Fell on the floor' }, 409)
    expect(refusalOf(error)).toBe('refusal/CERTIFICATE')
    expect(await garmentJobs([cellOf(WO.gate, '52')])).toHaveLength(1)
  })
})

describe('the floor rules: readiness, the notice, the permission, the printer', () => {
  it('holds labels while the site has no legal basis on record (FLOOR_NOT_READY)', async () => {
    const [basis] = await admin(`SELECT "monitoringBasis", "monitoringReference", "monitoringRecordedAt", "monitoringRecordedById" FROM "ProductionSettings" WHERE id = $1`, [A.siteA1])
    await admin(`UPDATE "ProductionSettings" SET "monitoringBasis" = NULL, "monitoringReference" = NULL, "monitoringRecordedAt" = NULL, "monitoringRecordedById" = NULL WHERE id = $1`, [A.siteA1])
    try {
      const error = await refused('pack', 'POST', printUrl(WO.walls.id), {}, 409)
      expect(refusalOf(error)).toBe('refusal/FLOOR_NOT_READY')
      expect(error.message).toMatch(/^Garment labels are held at this site until its floor is ready: Floor records name workers, but no legal basis is on record/)
      expect((await ok('pack', 'GET', viewUrl(WO.walls.id))).blocked).toMatchObject({ code: 'FLOOR_NOT_READY' })
    } finally {
      await admin(`UPDATE "ProductionSettings" SET "monitoringBasis" = $2, "monitoringReference" = $3, "monitoringRecordedAt" = $4, "monitoringRecordedById" = $5 WHERE id = $1`, [
        A.siteA1,
        basis!.monitoringBasis,
        basis!.monitoringReference,
        basis!.monitoringRecordedAt,
        basis!.monitoringRecordedById,
      ])
    }
    expect(await logRows([cellOf(WO.walls)])).toEqual([])
  })

  it('refuses a worker who has not acknowledged the worker notice', async () => {
    expect((await refused('leadPack', 'POST', printUrl(WO.walls.id), {}, 409)).message).toMatch(/acknowledge the information notice first/)
    expect(await logRows([cellOf(WO.walls)])).toEqual([])
  })

  it('needs production.serials; the office never prints, it reads and reprints', async () => {
    expect((await call('packNoLabels', 'POST', printUrl(WO.walls.id), {}, freshKey())).statusCode).toBe(403)
    expect((await call('packNoLabels', 'GET', viewUrl(WO.walls.id))).statusCode).toBe(403)
    expect((await call('manager', 'POST', printUrl(WO.walls.id), {}, freshKey())).statusCode).toBe(403)
    expect((await call('viewer', 'GET', viewUrl(WO.walls.id))).statusCode).toBe(403)
    expect((await call('pack', 'GET', `/production/serials/work-orders/${WO.walls.id}/serials`)).statusCode).toBe(403)
  })

  it('refuses a printer of the wrong kind, and prints only on a label printer of the site', async () => {
    expect((await call('pack', 'POST', printUrl(WO.walls.id), { printerId: newId() }, freshKey())).statusCode).toBe(404)
    await admin(`UPDATE "Printer" SET status = 'PAUSED' WHERE id = $1`, [A.printer])
    try {
      const error = await refused('pack', 'POST', printUrl(WO.walls.id), {}, 409)
      expect(refusalOf(error)).toBe('refusal/NO_PRINTER')
    } finally {
      await admin(`UPDATE "Printer" SET status = 'ACTIVE' WHERE id = $1`, [A.printer])
    }
  })
})

describe('tenant, company and site walls', () => {
  it("keeps another site's floor, another company's office and another tenant out", async () => {
    expect((await call('floorB1', 'GET', viewUrl(WO.walls.id))).statusCode).toBe(404)
    expect((await call('floorB1', 'POST', printUrl(WO.walls.id), {}, freshKey())).statusCode).toBe(404)
    expect((await call('companyB', 'GET', viewUrl(WO.walls.id))).statusCode).toBe(404)
    expect((await call('companyB', 'GET', `/production/serials/work-orders/${WO.walls.id}/serials`)).statusCode).toBe(404)
    expect((await call('otherTenant', 'GET', viewUrl(WO.walls.id))).statusCode).toBe(404)
    expect((await call('otherTenant', 'POST', `/production/serials/work-orders/${WO.walls.id}/reprint`, { workOrderSizeId: cellOf(WO.walls), count: 1, reason: 'Not ours' }, freshKey())).statusCode).toBe(404)
    expect((await call('floorB1', 'GET', `/production/serials/scan?code=${encodeURIComponent(BN.walls[0]!.code)}`)).statusCode).toBe(404)
  })

  it('finds a work order by its bundle ticket or its number for the labels screen', async () => {
    expect(await ok('pack', 'GET', `/production/serials/scan?code=${encodeURIComponent(BN.walls[0]!.code)}`)).toMatchObject({ kind: 'BUNDLE', workOrderId: WO.walls.id, workOrderSizeId: cellOf(WO.walls), bundle: { id: BN.walls[0]!.id } })
    expect(await ok('pack', 'GET', `/production/serials/scan?code=${encodeURIComponent(WO.walls.number)}`)).toMatchObject({ kind: 'WORK_ORDER', workOrderId: WO.walls.id, workOrderSizeId: null })
    expect((await call('pack', 'GET', '/production/serials/scan?code=NOTHING-HERE')).statusCode).toBe(404)
  })
})

// ---- SERIAL: a serial per garment ------------------------------------------------------------------------------------------------

describe('a serial-tracked style (Q31 (b)): a serial per finished garment, each with its own label', () => {
  let serials: Json[] = []

  beforeAll(async () => {
    // The jacket's work orders have batch labels now: the database keeps how it is traced (Q31; the
    // …_production_garment_labels_guards Style rule). A test fixture, not a path of the app: flip it with triggers off.
    await expect(admin(`UPDATE "Style" SET "garmentTracking" = 'SERIAL' WHERE id = $1`, [A.style])).rejects.toThrow(/has work orders with garment labels, serials or quality releases/)
    await admin(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE "Style" SET "garmentTracking" = 'SERIAL' WHERE id = '${A.style}'; COMMIT;`)
  })

  it('gives 5 finished garments 5 serials (MADE) from the tenant\'s GARMENT_SERIAL counter, each its own GARMENT job, with its bundle', async () => {
    const view = await ok('pack', 'GET', `${viewUrl(WO.serial.id)}?cellId=${cellOf(WO.serial)}`)
    expect(view).toMatchObject({ tracking: 'SERIAL' })
    expect(view.cells).toEqual([expect.objectContaining({ size: '50', quantity: 6, finished: 5, labelled: 0, toLabel: 5, printable: true })])
    expect(view.preview.blocks.find((block: Json) => block.field === 'batchOrSerial')).toMatchObject({ value: expect.stringMatching(/^SN-/), graphic: { kind: 'BARCODE' } })

    const answer = await ok('pack', 'POST', printUrl(WO.serial.id), { cells: [{ workOrderSizeId: cellOf(WO.serial) }] }, 201, freshKey())
    expect(answer.tracking).toBe('SERIAL')
    const [line] = answer.printed
    expect(line).toMatchObject({ count: 5, batchNumber: WO.serial.batchNumber, job: null, problem: null })
    expect(line.serials).toHaveLength(5)
    const fiveBundle = BN.serial.find((bundle) => bundle.quantity === 5)!
    const refs: number[] = []
    for (const serial of line.serials) {
      expect(serial).toMatchObject({ bundleId: fiveBundle.id, problem: null, job: { labelKind: 'GARMENT', scanId: serial.serial, copies: 1, status: 'QUEUED' } })
      const parsed = parseScanId(serial.serial, { tenantTag: TAG, types: ['SERIAL'] })
      expect(parsed).toMatchObject({ ok: true })
      if (parsed.ok) refs.push(parsed.ref)
    }
    // The real kind: one ONLINE block of the tenant's GARMENT_SERIAL counter, consecutive references.
    expect(refs).toEqual(Array.from({ length: 5 }, (_, index) => refs[0]! + index))
    expect(await admin(`SELECT purpose::text AS purpose, "fromRef", "toRef", "deviceId" FROM "NumberBlock" WHERE kind = 'GARMENT_SERIAL' AND "fromRef" <= $1 AND "toRef" >= $2`, [refs[0], refs[4]])).toEqual([
      { purpose: 'ONLINE', fromRef: refs[0], toRef: refs[4], deviceId: null },
    ])
    serials = await serialsOf(WO.serial.id)
    expect(serials.map((row) => [row.status, row.createdById, row.bundleId])).toEqual(Array.from({ length: 5 }, () => ['MADE', A.operatorA1, fiveBundle.id]))
    expect(new Set(serials.map((row) => row.serial))).toEqual(new Set(line.serials.map((serial: Json) => serial.serial)))
    const jobs = await garmentJobs(serials.map((row) => row.id))
    expect(jobs).toHaveLength(5)
    // Each label carries its serial once as text and once as Code 128 bars (packing scans it).
    expect(jobs.every((job) => job.recordType === 'GarmentSerial' && job.copies === 1 && job.zpl.includes(`^BCN`) && job.zpl.split(`^FD${job.scanId}^FS`).length === 3)).toBe(true)
    expect(answer.cells).toEqual([expect.objectContaining({ finished: 5, labelled: 5, toLabel: 0 })])
    const [entry] = await logRows([cellOf(WO.serial)])
    expect(entry).toMatchObject({ kind: 'PRINT', tracking: 'SERIAL', quantity: 5, batchNumber: WO.serial.batchNumber, deviceId: A.pack })
    expect([...entry!.serialIds].sort()).toEqual(serials.map((row) => row.id).sort())
  })

  it('never gives more serials than finished garments', async () => {
    expect(refusalOf(await refused('pack', 'POST', printUrl(WO.serial.id), {}, 409))).toBe('refusal/NOTHING_TO_LABEL')
    const error = await refused('pack', 'POST', printUrl(WO.serial.id), { cells: [{ workOrderSizeId: cellOf(WO.serial), count: 1 }] }, 409)
    expect(refusalOf(error)).toBe('refusal/NOTHING_TO_LABEL')
    expect(await serialsOf(WO.serial.id)).toHaveLength(5)
  })

  it("reprints a serial's label with the same serial and a reason", async () => {
    const first = serials[0]!
    const answer = await ok('pack', 'POST', `/production/serials/${first.id}/reprint`, { reason: 'Label torn' }, 201, freshKey())
    expect(answer.serial).toMatchObject({ id: first.id, serial: first.serial, status: 'MADE' })
    expect(answer.reprinted.serials).toEqual([expect.objectContaining({ id: first.id, serial: first.serial, job: expect.objectContaining({ scanId: first.serial }) })])
    expect((await garmentJobs([first.id])).map((job) => job.scanId)).toEqual([first.serial, first.serial])
    expect(await serialsOf(WO.serial.id)).toHaveLength(5)
  })

  it('voids a MADE serial with a reason before release; its garment gets a new serial, never the old one again', async () => {
    const second = serials[1]!
    const voided = await ok('pack', 'POST', `/production/serials/${second.id}/void`, { reason: 'Label spoilt at the press' }, 201, freshKey())
    expect(voided.serial).toMatchObject({ id: second.id, status: 'VOID', voidReason: 'Label spoilt at the press' })
    expect(voided.cell).toMatchObject({ finished: 5, labelled: 4, toLabel: 1 })
    expect(refusalOf(await refused('manager', 'POST', `/production/serials/${second.id}/void`, { reason: 'Again' }, 409))).toBe('refusal/SERIAL_VOID')
    expect(refusalOf(await refused('pack', 'POST', `/production/serials/${second.id}/reprint`, { reason: 'Again' }, 409))).toBe('refusal/SERIAL_VOID')
    const again = await ok('pack', 'POST', printUrl(WO.serial.id), {}, 201, freshKey())
    expect(again.printed[0].serials).toHaveLength(1)
    expect(again.printed[0].serials[0].serial).not.toBe(second.serial)
    expect(again.printed[0].serials[0].bundleId).toBe(BN.serial.find((bundle) => bundle.quantity === 5)!.id)
    expect((await serialsOf(WO.serial.id)).map((row) => row.status).sort()).toEqual(['MADE', 'MADE', 'MADE', 'MADE', 'MADE', 'VOID'])
  })

  it("lets the office reprint and void, and lists the serials with their bundles and the label log", async () => {
    const third = serials[2]!
    expect((await ok('manager', 'POST', `/production/serials/${third.id}/reprint`, { reason: 'Customer asked for a fresh one' }, 201, freshKey())).serial.serial).toBe(third.serial)
    expect((await ok('manager', 'POST', `/production/serials/${third.id}/void`, { reason: 'Garment scrapped after packing' }, 201, freshKey())).serial.status).toBe('VOID')
    const answer = await ok('manager', 'GET', `/production/serials/work-orders/${WO.serial.id}/serials`)
    expect(answer.tracking).toBe('SERIAL')
    expect(answer.serials).toHaveLength(6)
    expect(answer.serials.every((serial: Json) => serial.bundle?.code === BN.serial.find((bundle) => bundle.quantity === 5)!.code)).toBe(true)
    expect(answer.serials.find((serial: Json) => serial.id === serials[0]!.id).jobs).toHaveLength(2)
    expect(answer.log.map((entry: Json) => [entry.kind, entry.quantity, entry.reason, entry.postedBy])).toEqual([
      ['REPRINT', 1, 'Customer asked for a fresh one', 'OFFICE'],
      ['PRINT', 1, null, 'FLOOR'],
      ['REPRINT', 1, 'Label torn', 'FLOOR'],
      ['PRINT', 5, null, 'FLOOR'],
    ])
    expect(await counts(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'production.garment_serial_voided' AND payload->>'workOrderId' = $1`, [WO.serial.id])).toBe(2)
  })

  it('finds a garment by its serial label', async () => {
    const first = serials[0]!
    expect(await ok('pack', 'GET', `/production/serials/scan?code=${encodeURIComponent(first.serial)}`)).toMatchObject({
      kind: 'SERIAL',
      workOrderId: WO.serial.id,
      workOrderSizeId: cellOf(WO.serial),
      serial: { id: first.id, serial: first.serial, bundle: { id: BN.serial.find((bundle) => bundle.quantity === 5)!.id } },
    })
    expect((await call('floorB1', 'GET', `/production/serials/scan?code=${encodeURIComponent(first.serial)}`)).statusCode).toBe(404)
    expect((await call('floorB1', 'POST', `/production/serials/${first.id}/void`, { reason: 'Not ours' }, freshKey())).statusCode).toBe(404)
  })
})

// ---- the database's own rules (…_production_garment_labels_guards), for every login ---------------------------------------------

describe('the label log and the serials hold their rules in the database too', () => {
  const entry = (overrides: Json = {}) => {
    const row: Json = {
      id: newId(),
      companyId: A.companyA,
      siteId: A.siteA1,
      workOrderId: WO.serial.id,
      workOrderSizeId: cellOf(WO.serial),
      kind: 'REPRINT',
      tracking: 'SERIAL',
      quantity: 1,
      batchNumber: WO.serial.batchNumber,
      serialIds: [] as string[],
      reason: 'Torn',
      ...overrides,
    }
    return admin(
      `INSERT INTO "GarmentLabelPrint" (id, "tenantId", "companyId", "siteId", "workOrderId", "workOrderSizeId", kind, tracking, quantity, "batchNumber", "serialIds", reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7::"GarmentLabelPrintKind", $8::"GarmentTracking", $9, $10, $11::uuid[], $12)`,
      [row.id, A.tenant, row.companyId, row.siteId, row.workOrderId, row.workOrderSizeId, row.kind, row.tracking, row.quantity, row.batchNumber, row.serialIds, row.reason],
    )
  }

  it('takes a well-formed reprint, and refuses a missing reason, another batch, another tracking and a void serial', async () => {
    const rows = await serialsOf(WO.serial.id)
    const made = rows.find((row) => row.status === 'MADE')!
    const voided = rows.find((row) => row.status === 'VOID')!
    await entry({ serialIds: [made.id] })
    await expect(entry({ serialIds: [made.id], reason: null })).rejects.toThrow(/says why the labels are printed again/)
    await expect(entry({ serialIds: [made.id], kind: 'PRINT' })).rejects.toThrow(/only a reprint has a reason/)
    await expect(entry({ serialIds: [made.id], batchNumber: 'NOT-THE-BATCH' })).rejects.toThrow(/carries batch NOT-THE-BATCH/)
    await expect(entry({ tracking: 'BATCH' })).rejects.toThrow(/traces by SERIAL/)
    await expect(entry({ serialIds: [voided.id] })).rejects.toThrow(/are void or shipped/)
    await expect(entry({ serialIds: [made.id, made.id], quantity: 2 })).rejects.toThrow(/names each serial once/)
    await expect(entry({ serialIds: [made.id], quantity: 0 })).rejects.toThrow(/at least one label/)
    await expect(entry({ serialIds: [made.id], quantity: 2 })).rejects.toThrow(/one label per serial/)
  })

  it('never changes or removes an entry, and never moves a serial to another bundle', async () => {
    const [first] = await logRows([cellOf(WO.serial)])
    await expect(admin(`UPDATE "GarmentLabelPrint" SET reason = 'changed' WHERE id = $1`, [first!.id])).rejects.toThrow(/append-only: UPDATE on "GarmentLabelPrint" is refused/)
    await expect(admin(`DELETE FROM "GarmentLabelPrint" WHERE id = $1`, [first!.id])).rejects.toThrow(/append-only: DELETE on "GarmentLabelPrint" is refused/)
    const made = (await serialsOf(WO.serial.id)).find((row) => row.status === 'MADE')!
    const other = BN.serial.find((bundle) => bundle.quantity === 1)!
    await expect(admin(`UPDATE "GarmentSerial" SET "bundleId" = $2 WHERE id = $1`, [made.id, other.id])).rejects.toThrow(/is set when it is given and never changes/)
  })
})
