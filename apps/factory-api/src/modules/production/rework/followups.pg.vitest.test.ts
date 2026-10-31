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
 * The production follow-ups (B-W2b-10) on the local stack with the app's real routes, as rework.pg.vitest.test.ts sets
 * them up (a throwaway PostgreSQL 17 database from the migrations, the runtime login, the factory-db seeds, made-up hides
 * and tablets, released work orders of black jackets in size 50 cut, bundled and scanned through the floor's routes):
 *   - WIP and work-order progress count rework orders (B-W2a-13's gap): an open rework holds its garments in rework, a
 *     split child is neither waiting nor missing where its parent passed it, a DONE rework gives back good and scrap;
 *   - a correction of a split parent is capped at its live garments, asked on the floor and approved in the office;
 *   - MES-125: a scrap reason keeps an icon, a colour, other languages and "needs detail", and the operation screen's
 *     tiles read them.
 * The seeded routing: 10 cut, 20 sew, 30 final check, 40 pack. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/production/rework/followups`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = { a: 'prodfollow-a', b: 'prodfollow-b' } as const
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

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (tenantId: string, grants: Grant[], actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId, actorId, grants })
const FLOOR: Permission[] = ['floor.work', 'production.cut', 'production.bundles', 'production.scan', 'production.rework', 'inventory.issue', 'print.view', 'print.labels']
const floor = (deviceId: string, permissions: Permission[] = FLOOR): SessionContext => ({ audience: 'floor', tenantId: A.tenant, actorId: A.operatorA1, siteId: A.siteA1, deviceId, grants: [grant(permissions, [A.companyA], [A.siteA1])] })
const MANAGE: Permission[] = ['workorders.view', 'production.rework', 'production.scrap.view', 'production.scrap', 'production.bundles', 'production.cutting.view', 'inventory.stock.view', 'inventory.reserve']
const SESSIONS: Record<string, SessionContext> = {
  planner: office(A.tenant, [grant(['workorders.view', 'workorders.manage', 'workorders.release'])]),
  manager: office(A.tenant, [grant(MANAGE)], A.manager),
  viewer: office(A.tenant, [grant(['workorders.view'])]),
  /** A team leader in the office: decides the floor's correction requests (never their own). */
  supervisor: office(A.tenant, [grant(['workorders.view', 'production.scan.correct'])]),
  /** Keeps the reason lists (MES-125: icon, colour, other languages, needs detail). */
  keeper: office(A.tenant, [grant(['reasons.view', 'reasons.manage'])]),
  cutter: floor(A.cutter),
  sew1: floor(A.sew1),
  qc: floor(A.qc),
  pack: floor(A.pack),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'
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
      [newId(), A.tenant, A.companyA, A.siteA1, A.leather, A.leatherBLK, lotId, hideId, A.bin, `prodfollow-test-${run}-${key}`],
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
type Orders = 'flow' | 'split'
const WO = {} as Record<Orders, Json>
const BN = {} as Record<Orders, Json[]>
const CUT = {} as Record<Orders, Json>

const report = (session: string, bundle: Json, good: number, extra: Json = {}) => call(session, 'POST', '/production/scans', { clientScanId: clientId(), code: bundle.code, good, ...extra })
async function reported(session: string, bundle: Json, good: number, extra: Json = {}): Promise<Json> {
  const response = await report(session, bundle, good, extra)
  expect(response.statusCode, response.body).toBe(201)
  return response.json().scan
}
const post = (session: string, url: string, body: Json) => call(session, 'POST', url, body, freshKey())

beforeAll(async () => {
  db = await migratedDatabase('production_followups')
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
  await addHides(2)
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
    ['flow', 6, 'H01', 6],
    ['split', 6, 'H02', 6],
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


const wipOf = async (workOrderId: string) => ok('manager', 'GET', `/production/scans/work-orders/${workOrderId}/wip`)
const opOf = (wip: Json, id: string) => (wip.operations as Json[]).find((row) => row.operationId === id)!

// ---- WIP and progress count rework orders (B-W2a-13's gap) -----------------------------------------------------------------

describe('WIP and work-order progress count rework orders (B-W2b-10)', () => {
  let rework: Json
  let child: Json

  it('an open rework holds its garments in rework where they were found; its bundle is neither waiting nor missing', async () => {
    const bundle = BN.flow[0]!
    await reported('cutter', bundle, 6, { workOrderOperationId: OPS.cut })
    const sew = await reported('sew1', bundle, 4, { rework: [{ reason: 'RESTITCH', quantity: 2 }] })
    const opened = await post('sew1', '/production/rework', { sourceScanId: sew.id, reworkAtOperationId: OPS.sew, quantity: 2, description: 'Seam to redo', printerId: null })
    expect(opened.statusCode, opened.body).toBe(201)
    rework = opened.json().rework
    child = opened.json().split.bundle
    const wip = await wipOf(WO.flow.id)
    // Op 10: the child's two garments passed with their parent before the split (W1 showed them waiting at Op 10).
    expect(opOf(wip, OPS.cut)).toMatchObject({ arrived: 6, good: 6, waiting: 0, missing: 0, bundles: { done: 2, waiting: 0, notReached: 0 } })
    // Op 20: four good, the two of the rework counted once, in rework (not waiting for a scan, not missing).
    expect(opOf(wip, OPS.sew)).toMatchObject({ arrived: 6, good: 4, rework: 2, waiting: 0, missing: 0 })
    expect(opOf(wip, OPS.qc)).toMatchObject({ arrived: 4, waiting: 4 })
    expect(wip.cells[0]).toMatchObject({ bundled: 6, sewn: 4, scrapped: 0, inRework: 2 })
    expect(wip.rework).toEqual({ open: 1, inRework: 2, done: 0, good: 0, scrapped: 0 })
  })

  it('a DONE rework gives back its good garments where the fault was found and counts its scrap; the next operation takes the good', async () => {
    expect((await post('sew1', `/production/rework/${rework.id}/start`, { version: 1 })).statusCode).toBe(201)
    const done = await post('sew1', `/production/rework/${rework.id}/done`, { version: 2, good: 1, scrap: 1 })
    expect(done.statusCode, done.body).toBe(201)
    const wip = await wipOf(WO.flow.id)
    expect(opOf(wip, OPS.sew)).toMatchObject({ arrived: 6, good: 5, scrap: 1, rework: 0, waiting: 0, missing: 0 })
    expect(opOf(wip, OPS.qc)).toMatchObject({ arrived: 5, waiting: 5, bundles: { done: 0, waiting: 2, notReached: 0 } })
    expect(wip.cells[0]).toMatchObject({ sewn: 5, scrapped: 1, inRework: 0 })
    expect(wip.rework).toEqual({ open: 0, inRework: 0, done: 1, good: 1, scrapped: 1 })
    // The work order record's size grid reads the same progress (sewn 5 of 6).
    const { workOrder } = await ok('manager', 'GET', `/production/work-orders/${WO.flow.id}`)
    expect(JSON.stringify(workOrder)).toContain('"sewn":5')
    // The rework child goes on: Op 30 takes its one good garment.
    await reported('qc', child, 1)
  })
})

// ---- corrections capped at the live garments of a split (B-W2a-13's gap) ------------------------------------------------------

describe('a correction of a split parent is capped at its live garments (B-W2b-10)', () => {
  let report: Json
  let request: Json

  it('the floor asks a correction of the parent’s report: more than the garments still in it is refused in words', async () => {
    const parent = BN.split[0]!
    report = await reported('cutter', parent, 6, { workOrderOperationId: (WO.split.spec.operations as Json[]).find((op) => op.seq === 10)!.id })
    const split = await post('cutter', `/production/bundles/${parent.id}/split`, { quantity: 2, reason: 'HOLD', note: 'Shade to check', printerId: null })
    expect(split.statusCode, split.body).toBe(201)
    // 5 good + 1 scrapped fits the bundle as cut (6): W1 took it; the parent holds 4 now.
    const over = await call('cutter', 'POST', `/production/scans/${report.id}/corrections`, { clientScanId: clientId(), good: 5, scrap: [{ reason: 'STAIN', quantity: 1 }], reason: 'One jacket was stained' })
    expect(over.statusCode, over.body).toBe(409)
    expect(refusalOf(over.json().error)).toBe('refusal/MORE_THAN_BUNDLE')
    expect(over.json().error.message).toBe(`Bundle ${parent.code} carries 4 garments; 6 reported.`)
    const asked = await call('cutter', 'POST', `/production/scans/${report.id}/corrections`, { clientScanId: clientId(), good: 3, scrap: [{ reason: 'STAIN', quantity: 1 }], reason: 'One jacket was stained' })
    expect(asked.statusCode, asked.body).toBe(201)
    request = asked.json().request
  })

  it('the office approves at the live garments it finds then: another split since the ask is refused in words', async () => {
    const parent = BN.split[0]!
    const second = await post('cutter', `/production/bundles/${parent.id}/split`, { quantity: 1, reason: 'RECUT', printerId: null })
    expect(second.statusCode, second.body).toBe(201)
    const refused = await call('supervisor', 'POST', `/production/scans/corrections/${request.id}/approve`, {}, freshKey())
    expect(refused.statusCode, refused.body).toBe(409)
    expect(refusalOf(refused.json().error)).toBe('refusal/MORE_THAN_BUNDLE')
    expect(refused.json().error.message).toBe(`Bundle ${parent.code} carries 3 garments; 4 reported.`)
    // Void the second child: the parent holds 4 again, and the approval goes through.
    const voided = await post('cutter', `/production/bundles/${second.json().bundle.id}/void`, { reason: 'Split by mistake' })
    expect(voided.statusCode, voided.body).toBe(201)
    const approved = await call('supervisor', 'POST', `/production/scans/corrections/${request.id}/approve`, { note: 'Seen the jacket' }, freshKey())
    expect(approved.statusCode, approved.body).toBe(201)
    expect(approved.json().scan).toMatchObject({ kind: 'CORRECTION', correctsId: report.id, goodQuantity: 3, scrapQuantity: 1, subcontractReceiptLineId: null })
  })
})

// ---- MES-125: scrap reasons with icons and words for the floor's tiles -----------------------------------------------------

describe('scrap reasons carry icon, colour, words per language and needs detail for the floor tiles (MES-125)', () => {
  it('the office sets a scrap reason’s look; the operation screen’s tiles and the bundle card read it; OTHER needs detail', async () => {
    const { lists } = await ok('keeper', 'GET', '/reasons/lists?list=SCRAP')
    const stain = (lists[0].reasons as Json[]).find((reason) => reason.code === 'STAIN')!
    expect(lists[0].fields).toEqual({ icon: true, colour: true, languages: true, needsDetail: true })
    const { reason } = await ok('keeper', 'PATCH', `/reasons/SCRAP/${stain.id}`, { version: stain.version, icon: 'alert', colour: '#E5484D', labelI18n: { ro: 'Pată' } }, 200, freshKey())
    expect(reason).toMatchObject({ icon: 'alert', colour: '#e5484d', labelI18n: { ro: 'Pată' }, needsDetail: false })
    const tiles = (await ok('cutter', 'GET', '/production/scans/reasons')).reasons as Json[]
    expect(tiles.find((tile) => tile.kind === 'SCRAP' && tile.code === 'STAIN')).toEqual({ kind: 'SCRAP', code: 'STAIN', label: { it: 'Macchia', en: 'Stain' }, sortOrder: 40, icon: 'alert', colour: '#e5484d', labelI18n: { ro: 'Pată' }, needsDetail: false })
    expect(tiles.find((tile) => tile.kind === 'SCRAP' && tile.code === 'OTHER')).toMatchObject({ icon: null, colour: null, labelI18n: {}, needsDetail: true })
    expect(tiles.find((tile) => tile.kind === 'REWORK' && tile.code === 'OTHER')).toMatchObject({ needsDetail: true })
    const card = await ok('qc', 'GET', `/production/scans/card?code=${BN.split[0]!.code}`)
    expect((card.reasons as Json[]).find((tile) => tile.code === 'STAIN')).toMatchObject({ icon: 'alert', labelI18n: { ro: 'Pată' } })
    // A picked icon outside the design system's set is refused in words, as for any list.
    const wrong = await call('keeper', 'PATCH', `/reasons/SCRAP/${stain.id}`, { version: reason.version, icon: 'rocket' }, freshKey())
    expect(wrong.statusCode, wrong.body).toBe(400)
    expect(wrong.json().error.issues).toEqual([expect.objectContaining({ path: 'body/icon' })])
  })
})
