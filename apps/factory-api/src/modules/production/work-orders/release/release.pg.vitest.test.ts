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
import { seed as seedProduction } from '../../../../../../../packages/factory-db/seed/production'
import { seed as seedReasons } from '../../../../../../../packages/factory-db/seed/reasons'
import { seedUuid } from '../../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../../env'

/**
 * The release check with blockers (B-W2a-46; MES-004; design production.workorders wo-release, wo-hold, wo-grid
 * "Readiness (W2a word)") on the local stack with the app's real routes: a throwaway PostgreSQL 17 database from the
 * migrations (the runtime login, so row-level security and the …_production_guards / …_quality_plant_w2a_guards
 * triggers are real), the factory-db seeds of two tenants up to production (SEED-JKT-02, plants A1 and B1, SEED-WO-0001
 * in progress, the seed's plan run and purchase orders), the numbering and the reason lists, and on top: a made-up
 * certificate for SEED-JKT-02, released black leather, lining and protectors at A1 (the red leather waits for its Cr VI
 * result), sales orders typed per test and one made-up purchase order of red leather. Sessions come from the test
 * authenticator. Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs work-orders/release`.
 *
 *   - a quality hold on a DRAFT puts it ON_HOLD: its release check names the hold (HOLDS, never overridden), the release
 *     is refused with it, the record says why and since when, the tiles count it;
 *   - the plan's readiness sits beside the checks; a shortage the plan expects in time (a sent purchase order) passes
 *     MATERIAL, one only in a DRAFT purchase order holds it and passes with the planner's override and its reason;
 *   - the list's readiness word of many work orders, only those the caller may see.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = { a: 'wo-release-a', b: 'wo-release-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const A = {
  tenant: idOf(ns.a, 'tenant'),
  actor: idOf(ns.a, 'actor'),
  companyA: idOf(ns.a, 'company:A'),
  siteA1: idOf(ns.a, 'site:A1'),
  brand: idOf(ns.a, 'party:P1'),
  supplier: idOf(ns.a, 'party:P2'),
  style: idOf(ns.a, 'production:style:JKT-02'),
  blk: idOf(ns.a, 'production:colourway:JKT-02:BLK'),
  red: idOf(ns.a, 'production:colourway:JKT-02:RED'),
  leather: idOf(ns.a, 'product:item:leather'),
  lining: idOf(ns.a, 'product:item:lining'),
  protector: idOf(ns.a, 'product:item:protector'),
  leatherBLK: idOf(ns.a, 'product:item-colour:leather:BLK'),
  leatherRED: idOf(ns.a, 'product:item-colour:leather:RED'),
  liningGRY: idOf(ns.a, 'product:item-colour:lining:GRY'),
  binA1: idOf(ns.a, 'inventory:location:A1-STORE-01'),
  seededWorkOrder: idOf(ns.a, 'production:work-order:WO-0001'),
}
const B = { tenant: idOf(ns.b, 'tenant'), seededWorkOrder: idOf(ns.b, 'production:work-order:WO-0001') }

const ALL: Permission[] = ['workorders.view', 'workorders.manage', 'workorders.release', 'quality.holds.view', 'quality.holds.place']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  planner: office(A.tenant, [grant(ALL)]),
  viewer: office(A.tenant, [grant(['workorders.view'])]),
  otherSite: office(A.tenant, [grant(['workorders.view'], [A.companyA], [idOf(ns.a, 'site:A2')])]),
  noWorkOrders: office(A.tenant, [grant(['planning.view'])]),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
const call = (session: string, method: Method, url: string, payload?: unknown) => app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const asOffice = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) => client.$transaction(work))

/** A CONFIRMED sales order of company A for SEED-JKT-02, one line in one colour, at site A1. */
let orders = 0
async function salesOrder(colour: 'BLK' | 'RED', sizes: Record<string, number>): Promise<string> {
  const orderId = newId()
  const lineId = newId()
  const pieces = Object.values(sizes).reduce((sum, quantity) => sum + quantity, 0)
  await asOffice(async (tx) => {
    await tx.salesOrder.create({
      data: { id: orderId, companyId: A.companyA, partyId: A.brand, number: `T-${run}-SO-${++orders}`, status: 'CONFIRMED', orderDate: new Date('2026-10-20T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up workshop' }, promiseDate: new Date('2026-12-10T00:00:00.000Z'), depositRequired: false },
      select: { id: true },
    })
    await tx.salesOrderLine.create({
      data: { id: lineId, companyId: A.companyA, orderId, partyId: A.brand, seq: 10, kind: 'SIZE_GRID', styleId: A.style, colourwayId: colour === 'BLK' ? A.blk : A.red, quantity: pieces, unitPrice: '100.000000', netAmount: pieces * 10_000, vatRatePct: '22.00', vatAmount: pieces * 2_200, siteId: A.siteA1 },
      select: { id: true },
    })
    await tx.salesOrderLineSize.createMany({ data: Object.entries(sizes).map(([size, quantity]) => ({ id: newId(), lineId, partyId: A.brand, size, quantity })) })
  })
  return lineId
}

async function draft(colour: 'BLK' | 'RED', sizes: Record<string, number>): Promise<Json> {
  const salesOrderLineId = await salesOrder(colour, sizes)
  return (await ok('planner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId }] }, 201)).workOrder
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
    [newId(), A.tenant, A.companyA, A.siteA1, spec.itemId, spec.colourId, lotId, hideId, A.binA1, spec.quantity, spec.uom, `wo-release-test-${spec.code}`],
  )
}

/** A made-up DRAFT purchase order of red leather at A1, due 2026-11-15 (before every need). */
async function redLeatherOrder(): Promise<{ orderId: string; lineId: string }> {
  const status = 'DRAFT'
  const orderId = newId()
  const lineId = newId()
  await asOffice(async (tx) => {
    await tx.purchaseOrder.create({ data: { id: orderId, companyId: A.companyA, siteId: A.siteA1, number: `T-${run}-PO-${status}`, partyId: A.supplier, orderDate: new Date('2026-10-25T00:00:00.000Z'), requestedDate: new Date('2026-11-15T00:00:00.000Z'), netAmount: 420_000, createdById: A.actor }, select: { id: true } })
    await tx.purchaseOrderLine.create({
      data: { id: lineId, purchaseOrderId: orderId, partyId: A.supplier, siteId: A.siteA1, needDate: new Date('2026-11-15T00:00:00.000Z'), seq: 10, itemId: A.leather, itemColourId: A.leatherRED, quantity: '1000.0000', uom: 'FT2', baseQuantity: '1000.0000', unitPrice: '4.200000', netAmount: 420_000, requiresCrViTest: true, createdById: A.actor },
      select: { id: true },
    })
  })
  return { orderId, lineId }
}

/** The office sends it (SENT). */
const send = (orderId: string) => asOffice((tx) => tx.purchaseOrder.update({ where: { id: orderId }, data: { status: 'SENT', sentAt: new Date(), sentById: A.actor, version: 2 }, select: { id: true } }))
let redOrder: { orderId: string; lineId: string } | null = null

const releaseCheck = (workOrderId: string, session = 'planner') => ok(session, 'GET', `/production/work-orders/${workOrderId}/release-check`)
const release = (workOrderId: string, body: Json = {}) => call('planner', 'POST', `/production/work-orders/${workOrderId}/release`, body)
const checkOf = (answer: Json, code: string): Json => (answer.checks as Json[]).find((check) => check.code === code)!

beforeAll(async () => {
  db = await migratedDatabase('wo_release_blockers')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 10 } })
  for (const namespace of [ns.a, ns.b]) {
    await seedCore({ db: database, namespace })
    await seedProduction({ db: database, namespace })
    await seedNumbering({ db: database, namespace })
    await seedReasons({ db: database, namespace })
  }
  await asOffice(async (tx) => {
    const certificateId = newId()
    await tx.certificate.create({
      data: { id: certificateId, holderPartyId: A.brand, standard: 'EN 17092-3:2020', ppeClass: 'AA', number: 'TEST-CERT-0046', notifiedBodyName: 'Made-up Notified Body', notifiedBodyNumber: '9999', modelReference: 'SEED-JKT-02', validFrom: new Date('2026-01-01T00:00:00.000Z'), validTo: new Date('2030-12-31T00:00:00.000Z'), status: 'VALID', statusChangedAt: new Date() },
      select: { id: true },
    })
    await tx.certificateCoverage.create({ data: { id: newId(), certificateId, styleId: A.style, sizes: ['50', '52', '54'] }, select: { id: true } })
  })
  await stockLot({ itemId: A.leather, colourId: A.leatherBLK, quantity: '2000.0000', uom: 'FT2', leather: true, code: `T-${run}-LEA-BLK` })
  await stockLot({ itemId: A.lining, colourId: A.liningGRY, quantity: '500.0000', uom: 'M', code: `T-${run}-LIN` })
  await stockLot({ itemId: A.protector, colourId: null, quantity: '1000.0000', uom: 'PCS', code: `T-${run}-PRO` })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 240_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('holds block the release (MES-004, MES-008)', () => {
  it('a quality hold on a DRAFT: the check names it, the release is refused with it, the record says why and the tiles count it', async () => {
    const workOrder = await draft('BLK', { '50': 1 })
    expect(checkOf(await releaseCheck(workOrder.id), 'HOLDS')).toMatchObject({ state: 'OK', problems: [] })
    const placed = await ok('planner', 'POST', '/quality/holds', { subjectType: 'WorkOrder', subjectIds: [workOrder.id], reasonCode: 'QUALITY_CHECK', reasonNote: 'Stitching sample out of tolerance' }, 201)
    expect(placed.workOrdersHeld).toEqual([expect.objectContaining({ id: workOrder.id, from: 'DRAFT' })])

    const check = await releaseCheck(workOrder.id)
    expect(check).toMatchObject({ status: 'ON_HOLD', frozen: false, releasable: false })
    const holds = checkOf(check, 'HOLDS')
    expect(holds.state).toBe('BLOCKED')
    expect(holds.problems).toEqual([{ path: `holds/${placed.hold.id}`, message: expect.stringMatching(/^On hold since \d{4}-\d{2}-\d{2}: .+\. Quality releases the hold first\.$/) }])
    expect(check.holds).toEqual([{ holdId: placed.hold.id, reason: expect.any(String), placedAt: placed.hold.placedAt }])
    // Every other check is still answered (a hold is not the only thing to fix).
    expect(check.checks.map((entry: Json) => entry.code)).toEqual(['REVISION', 'LABEL_TEMPLATE', 'CERTIFICATE', 'WORK_CENTRES', 'BOM', 'CELLS', 'DEPOSIT', 'MATERIAL', 'BATCH_NUMBER', 'HOLDS'])

    const refusal = await release(workOrder.id, { materialOverride: { reason: 'An override never lifts a hold' } })
    expect(refusal.statusCode, refusal.body).toBe(409)
    expect(refusal.json().error.message).toMatch(/1 problem\(s\) to fix first \(holds\)/)
    expect(refusal.json().error.issues).toEqual([{ path: `holds/${placed.hold.id}`, message: expect.stringMatching(/^On hold since/) }])
    expect((await admin(`SELECT status::text FROM "WorkOrder" WHERE id = $1`, [workOrder.id]))[0]).toEqual({ status: 'ON_HOLD' })

    const record = (await ok('viewer', 'GET', `/production/work-orders/${workOrder.id}`)).workOrder
    expect(record.hold).toMatchObject({ fromStatus: 'DRAFT', recordType: 'QualityHold', recordId: placed.hold.id, at: expect.any(String) })
    expect(record.hold.reason).toMatch(/Stitching sample out of tolerance/)
    // Nothing is frozen before the release: the held draft still shows the spec the release would freeze.
    expect(record.spec.frozen).toBe(false)
    expect(record.spec.operations.length).toBeGreaterThan(0)
    expect((await ok('viewer', 'GET', '/production/work-orders/counts')).counts.onHold).toBe(1)
    expect((await ok('viewer', 'GET', '/production/work-orders?status=ON_HOLD')).workOrders.map((row: Json) => row.id)).toEqual([workOrder.id])
  })

  it('names the hold of a work order ON_HOLD under another record (an NCR) by its own reason', async () => {
    const workOrder = await draft('BLK', { '52': 1 })
    await admin(`UPDATE "WorkOrder" SET status = 'ON_HOLD', "heldFromStatus" = 'DRAFT', "heldAt" = now(), "holdReason" = 'Nonconformance NC-test: wrong lining', "holdRecordType" = 'Nonconformance', "holdRecordId" = $2 WHERE id = $1`, [workOrder.id, newId()])
    const holds = checkOf(await releaseCheck(workOrder.id), 'HOLDS')
    expect(holds).toMatchObject({ state: 'BLOCKED', problems: [{ path: 'checks/HOLDS', message: expect.stringContaining('Nonconformance NC-test: wrong lining') }] })
  })
})

describe('the plan\'s readiness beside the material check (PLN-086)', () => {
  it('answers the word with the check, and the list reads it for many work orders it may see', async () => {
    const workOrder = await draft('BLK', { '50': 1, '52': 1 })
    const check = await releaseCheck(workOrder.id)
    expect(checkOf(check, 'MATERIAL').state).toBe('OK')
    expect(check.readiness).toMatchObject({ word: expect.stringMatching(/^(NOT_BOOKED|RECEIVED|EXPECTED)$/), materials: expect.arrayContaining([expect.objectContaining({ itemId: A.leather, itemColourId: A.leatherBLK })]) })
    // No money and no person in it.
    expect(JSON.stringify(check.readiness)).not.toMatch(/price|cost|amount|worker|createdBy/i)

    const list = await ok('viewer', 'GET', `/production/work-orders/readiness?ids=${[workOrder.id, A.seededWorkOrder, B.seededWorkOrder].join(',')}`)
    expect(list.workOrders.map((row: Json) => row.workOrderId)).toEqual([workOrder.id, A.seededWorkOrder])
    expect(list.workOrders[0]).toMatchObject({ word: check.readiness.word, open: expect.any(Number), asOf: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) })
    expect((await ok('otherSite', 'GET', `/production/work-orders/readiness?ids=${workOrder.id}`)).workOrders).toEqual([])
    expect((await call('viewer', 'GET', '/production/work-orders/readiness?ids=not-a-uuid-at-all-but-thirty-six-chars')).statusCode).toBe(400)
    expect((await call('noWorkOrders', 'GET', `/production/work-orders/readiness?ids=${workOrder.id}`)).statusCode).toBe(403)
  })

  it('holds a shortage only in a DRAFT purchase order (REQUESTED); the override passes it with its reason', async () => {
    redOrder = await redLeatherOrder()
    const workOrder = await draft('RED', { '50': 1 })
    const check = await releaseCheck(workOrder.id)
    const material = checkOf(check, 'MATERIAL')
    expect(material.state).toBe('BLOCKED')
    expect(material.problems[0].path).toBe(`materials/${A.leather}/${A.leatherRED}`)
    const red = check.readiness.materials.find((entry: Json) => entry.itemId === A.leather && entry.itemColourId === A.leatherRED)
    expect(red.word).toBe('REQUESTED')
    expect((await release(workOrder.id)).statusCode).toBe(409)
    const released = await release(workOrder.id, { materialOverride: { reason: 'The red hides are ordered; cutting waits for them' } })
    expect(released.statusCode, released.body).toBe(200)
    expect(released.json().workOrder).toMatchObject({ status: 'RELEASED', release: { materialOverride: { reason: 'The red hides are ordered; cutting waits for them' } } })
  })

  it('lets a shortage pass that a sent purchase order brings in time (EXPECTED), without an override', async () => {
    const workOrder = await draft('RED', { '52': 1 })
    expect(checkOf(await releaseCheck(workOrder.id), 'MATERIAL').state).toBe('BLOCKED')
    await send(redOrder!.orderId)
    const check = await releaseCheck(workOrder.id)
    const red = check.readiness.materials.find((entry: Json) => entry.itemId === A.leather && entry.itemColourId === A.leatherRED)
    expect(red).toMatchObject({ word: 'EXPECTED', date: '2026-11-15' })
    // Still short on hand today (W1's numbers), but expected in time: the check passes.
    expect(check.materials.find((line: Json) => line.itemId === A.leather && line.itemColourId === A.leatherRED).short).not.toBe('0')
    expect(checkOf(check, 'MATERIAL')).toMatchObject({ state: 'OK', problems: [], message: expect.stringMatching(/expected in time \(the last by 2026-11-15\)/) })
    const released = await release(workOrder.id)
    expect(released.statusCode, released.body).toBe(200)
    expect(released.json().workOrder.release.materialOverride).toBeNull()
  })
})
