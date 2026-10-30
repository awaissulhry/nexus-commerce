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
import { seed as seedPlant } from '../../../../../../packages/factory-db/seed/plant'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { lockHideCuts } from '../../inventory/issue/store'

/**
 * The cutting log per hide (B-W1-40; MES-051, MES-056, MES-058, SCM-194, SCM-253; PLAN §4.7 stage 11b-cut; A2 SCR-094)
 * on the local stack, with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime
 * login: row-level security, the column grants and the …_supply_guards and …_production_guards triggers are real), the
 * factory-db seeds of two tenants up to production (SEED-JKT-02 released, its black leather "Outer shell" 43 ft² × 1.12
 * per size-50 garment; plant A1 names workers, its operator acknowledged the PUBLISHED worker notice 2026-10 and its
 * team leader nothing; plant B1 records the station only; SEED-WO-0001 in progress with a seeded cut of its hide in two
 * bundles), the privacy seed (company A's stored DPIA and published worker notice: its floor is ready), the numbering seed,
 * the plant seed of tenant A (at the cutting table the press SEED-CP-01 locked as unsafe, the cutting table SEED-CT-01
 * running: the station cuts; B-W2a-35b), a made-up certificate, and made-up stock at A1: a lot of twelve black hides of 55 ft² RELEASED and a hide whose lot
 * waits for its chromium VI result. Released work orders of two black jackets in size 50 are made through the
 * work-order routes. Two more tablets at A1 (one at the cutting table, one without a station): the undo tests use them,
 * because the seeded cut of the A1 tablet carries a later server time than anything a test writes (serverTime orders the
 * cut log). Sessions come from the test authenticator. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs cutting`.
 *
 * One garment set of size 50 needs 48.16 ft² (the BOM's 43 ft² × 1.12): a 55 ft² hide gives one set and 6.84 ft² over.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = { a: 'cutting-a', b: 'cutting-b' } as const
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
  cutRack: idOf(ns.a, 'inventory:location:A1-CUT'),
  station: idOf(ns.a, 'site:A1:station:CUT-01'),
  deviceA1: idOf(ns.a, 'device:A1:cutting'),
  deviceB1: idOf(ns.a, 'device:B1:cutting'),
  tablet2: newId(),
  tablet3: newId(),
  roaming: newId(),
  operatorA1: idOf(ns.a, 'worker:A1:operator'),
  leadA1: idOf(ns.a, 'worker:A1:lead'),
  operatorB1: idOf(ns.a, 'worker:B1:operator'),
  seededWorkOrder: idOf(ns.a, 'production:work-order:WO-0001'),
  seededCut: idOf(ns.a, 'production:cut:H1:1'),
  /** The plant seed's cutting table SEED-CT-01 at CUT-01 (RUNNING; the press beside it is locked as unsafe). */
  cuttingTable: idOf(ns.a, 'plant:machine:SEED-CT-01'),
}
const B = { tenant: idOf(ns.b, 'tenant') }

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const floor = (siteId: string, deviceId: string, actorId: string, companyId: string): SessionContext => ({
  audience: 'floor',
  tenantId: A.tenant,
  actorId,
  siteId,
  deviceId,
  grants: [grant(['floor.work', 'production.cut', 'inventory.issue'], [companyId], [siteId])],
})
const OFFICE_CUT: Permission[] = ['workorders.view', 'production.cut', 'production.cut.correct']
const SESSIONS: Record<string, SessionContext> = {
  planner: office(A.tenant, [grant(['workorders.view', 'workorders.manage', 'workorders.release'])]),
  /** The production manager: reads the cut log and corrects it. */
  manager: office(A.tenant, [grant(OFFICE_CUT)]),
  /** Reads the work orders only. */
  viewer: office(A.tenant, [grant(['workorders.view'])]),
  companyB: office(A.tenant, [grant(OFFICE_CUT, [A.companyB])]),
  otherTenant: office(B.tenant, [grant(OFFICE_CUT)]),
  floor: floor(A.siteA1, A.deviceA1, A.operatorA1, A.companyA),
  /** The same operator on a second tablet at the cutting table. */
  tablet2: floor(A.siteA1, A.tablet2, A.operatorA1, A.companyA),
  /** And on a third one (the closing cut's tests: its last entry is its own). */
  tablet3: floor(A.siteA1, A.tablet3, A.operatorA1, A.companyA),
  /** A tablet without a station, and the team leader on it. */
  roaming: floor(A.siteA1, A.roaming, A.operatorA1, A.companyA),
  roamingLead: floor(A.siteA1, A.roaming, A.leadA1, A.companyA),
  /** The team leader on the cutting tablet: has not acknowledged the information notice. */
  floorLead: floor(A.siteA1, A.deviceA1, A.leadA1, A.companyA),
  floorB1: floor(A.siteB1, A.deviceB1, A.operatorB1, A.companyB),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
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
const asOffice = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) => client.$transaction(work))
const refusalOf = (error: Json): string => String(error.issues?.[0]?.path ?? '')
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : []
const MONEY = /cost|price|margin|amount|wage|valuation/i

const cutUrl = (workOrderId: string) => `/production/cutting/work-orders/${workOrderId}/cuts`
const cut = (workOrderId: string, body: Json, session = 'floor', key: string | undefined = freshKey()) => call(session, 'POST', cutUrl(workOrderId), { clientEventId: clientEvent(), ...body }, key)
const sets = (workOrder: Json, count = 1) => [{ workOrderSizeId: workOrder.cells[0].id, sets: count }]
const counts = async (sql: string, values: unknown[]) => (await admin<{ n: number }>(sql, values))[0]!.n
async function onHand(locationId: string, hideId: string): Promise<string> {
  const [row] = await admin<{ n: string }>(
    `SELECT coalesce(sum(CASE WHEN "toLocationId" = $1 THEN "baseQuantity" ELSE -"baseQuantity" END), 0)::numeric(18,4)::text AS n FROM "StockMove" WHERE ("toLocationId" = $1 OR "fromLocationId" = $1) AND "hideId" = $2`,
    [locationId, hideId],
  )
  return row!.n
}
const hideState = async (hideId: string) => (await admin<{ state: string }>(`SELECT state FROM "Hide" WHERE id = $1`, [hideId]))[0]!.state
const hideRow = async (hideId: string) => (await admin<{ state: string; closingCutLogId: string | null }>(`SELECT state::text AS state, "closingCutLogId" FROM "Hide" WHERE id = $1`, [hideId]))[0]
/** An admin INSERT of an entry's mirror (its reversal), as a login that skips the API but not the triggers. */
const mirrorSql = (cutLogId: string): [string, unknown[]] => [
  `INSERT INTO "CutLog" (id, "tenantId", "siteId", "workOrderId", "lotId", "hideId", uom, "areaUsed", "baseAreaUsed", "remnantArea", "baseRemnantArea", "reversalOfId", note, "workerId", "stationId", "clientEventId", "createdById")
   SELECT gen_random_uuid(), "tenantId", "siteId", "workOrderId", "lotId", "hideId", uom, "areaUsed", "baseAreaUsed", "remnantArea", "baseRemnantArea", id, 'A mirror typed in by hand.', "workerId", "stationId", 'mirror:' || id, "createdById"
     FROM "CutLog" WHERE id = $1`,
  [cutLogId],
]

// ---- made-up stock and work orders ----------------------------------------------------------------------------------------

const hides: Record<string, { id: string; code: string }> = {}
const lots: Record<string, { id: string; code: string }> = {}

async function addLot(key: string, status: 'RELEASED' | 'QUARANTINE', crVi: 'PASS' | 'PENDING', hideKeys: string[]) {
  const lotId = newId()
  const code = `T-${run}-${key}`
  lots[key] = { id: lotId, code }
  await admin(
    `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "dyeBatch", "qualityStatus", "qualityDecidedAt", "requiresCrViTest", "crViLimitMgKg", "crViStatus", "crViMgKg", "crViEvidence", "crViTestedAt", "receivedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, '7731', $8, $9, true, '3.000', $10, $11, $12, $13, '2026-10-05T08:00:00Z')`,
    [lotId, A.tenant, A.companyA, A.siteA1, A.leather, A.leatherBLK, code, status, status === 'RELEASED' ? new Date() : null, crVi, crVi === 'PASS' ? '1.100' : null, crVi === 'PASS' ? 'LOT_REPORT' : null, crVi === 'PASS' ? '2026-10-01' : null],
  )
  for (const hideKey of hideKeys) {
    const hideId = newId()
    hides[hideKey] = { id: hideId, code: `T-${run}-${hideKey}` }
    await admin(`INSERT INTO "Hide" (id, "tenantId", "siteId", "lotId", "itemId", code, area, "areaUom", "baseArea", grade, "thicknessMm") VALUES ($1, $2, $3, $4, $5, $6, '55.0000', 'FT2', '55.0000', 'A', '1.10')`, [
      hideId,
      A.tenant,
      A.siteA1,
      lotId,
      A.leather,
      hides[hideKey]!.code,
    ])
    await admin(
      `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "hideId", "toLocationId", quantity, uom, "baseQuantity", "idempotencyKey", "occurredAt")
       VALUES ($1, $2, $3, $4, 'OPENING', $5, $6, $7, $8, $9, '55.0000', 'FT2', '55.0000', $10, now())`,
      [newId(), A.tenant, A.companyA, A.siteA1, A.leather, A.leatherBLK, lotId, hideId, A.bin, `cut-test-${code}-${hideKey}`],
    )
  }
}

/** A CONFIRMED sales order of company A for black SEED-JKT-02 in size 50, typed by the office. */
async function salesOrder(pieces: number): Promise<string> {
  const orderId = newId()
  const lineId = newId()
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
    await tx.salesOrderLineSize.create({ data: { id: newId(), lineId, partyId: A.brand, size: '50', quantity: pieces }, select: { id: true } })
  })
  return lineId
}

/** A released work order of two black jackets in size 50, made and released through the work-order routes. */
async function releasedWorkOrder(lineId: string): Promise<Json> {
  const { workOrder } = await ok('planner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: lineId, sizes: [{ size: '50', quantity: 2 }] }] }, 201)
  // Ten work orders plan more black leather than the made-up lot holds: the planner releases them on an override.
  const released = await ok('planner', 'POST', `/production/work-orders/${workOrder.id}/release`, { materialOverride: { reason: 'The rest of the leather arrives next week' } })
  expect(released.workOrder.status).toBe('RELEASED')
  return released.workOrder
}

type Orders = 'main' | 'replay' | 'race' | 'raceA' | 'raceB' | 'station' | 'remnant' | 'consume' | 'consumeTwo' | 'closeLast' | 'undo' | 'correct' | 'held'
const WO = {} as Record<Orders, Json>

beforeAll(async () => {
  db = await migratedDatabase('cutting')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 12 } })
  for (const namespace of [ns.a, ns.b]) {
    await seedCore({ db: database, namespace })
    await seedPrivacy({ db: database, namespace })
    await seedProduction({ db: database, namespace })
    await seedNumbering({ db: database, namespace })
  }
  await seedPlant({ db: database, namespace: ns.a })
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
  await addLot('BLK', 'RELEASED', 'PASS', Array.from({ length: 14 }, (_, index) => `H${String(index + 1).padStart(2, '0')}`))
  await addLot('PEND', 'QUARANTINE', 'PENDING', ['PEND-H1'])
  // Two more tablets at A1: one at the cutting table, one without a station.
  for (const [deviceId, stationId, name] of [
    [A.tablet2, A.station, 'Second cutting tablet'],
    [A.tablet3, A.station, 'Third cutting tablet'],
    [A.roaming, null, 'Roaming tablet'],
  ] as const) {
    await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, $6, 'TABLET', 'ACTIVE', now())`, [deviceId, A.tenant, A.companyA, A.siteA1, stationId, name])
  }

  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  const line = await salesOrder(40)
  for (const name of ['main', 'replay', 'race', 'raceA', 'raceB', 'station', 'remnant', 'consume', 'consumeTwo', 'closeLast', 'undo', 'correct', 'held'] as const) WO[name] = await releasedWorkOrder(line)
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

// ---- reads ------------------------------------------------------------------------------------------------------------------------

describe('the cutting table reads (SCR-094, MES-051): work orders to cut, a scanned hide, a work order', () => {
  it('lists the released work orders of the floor site with what is left to cut, and finds one by its number', async () => {
    const { workOrders } = await ok('floor', 'GET', '/production/cutting/work-orders')
    const main = (workOrders as Json[]).find((row) => row.id === WO.main.id)
    expect(main).toMatchObject({ number: WO.main.number, status: 'RELEASED', pieces: 2, toCut: 2, sizesLeft: ['BLK 50'], colourways: ['BLK'], style: { code: 'SEED-JKT-02' } })
    expect((workOrders as Json[]).every((row) => row.siteId === A.siteA1)).toBe(true)
    expect((await ok('floor', 'GET', `/production/cutting/work-orders?number=${WO.main.number}`)).workOrders.map((row: Json) => row.id)).toEqual([WO.main.id])
    // Another site's tablet sees none of A1's.
    expect((await ok('floorB1', 'GET', '/production/cutting/work-orders')).workOrders.map((row: Json) => row.id)).not.toContain(WO.main.id)
  })

  it('shows a scanned hide in stock: area, grade, lot released, where it lies, and what it can cut for which work order', async () => {
    const scan = await ok('floor', 'GET', `/production/cutting/hides?code=${hides.H01!.code}&workOrderId=${WO.main.id}`)
    expect(scan.hide).toMatchObject({ code: hides.H01!.code, area: '55.0000', areaUom: 'FT2', baseUom: 'FT2', grade: 'A', thicknessMm: '1.10', state: 'FULL', lot: { code: lots.BLK!.code, dyeBatch: '7731', qualityStatus: 'RELEASED', usable: true, words: null } })
    expect(scan.onHand).toEqual([{ locationId: A.bin, locationCode: 'A1-STORE-01', onHand: '55.0000' }])
    expect(scan.lastCut).toBeNull()
    expect(scan.workOrders).toEqual([
      expect.objectContaining({
        id: WO.main.id,
        holdsHide: false,
        left: '55.0000',
        cuttable: true,
        refusal: null,
        cells: [expect.objectContaining({ colourwayCode: 'BLK', size: '50', quantity: 2, parts: ['Outer shell'], perGarment: '48.1600', cut: 0, toCut: 2 })],
      }),
    ])
    expect(keysOf(scan).filter((key) => MONEY.test(key))).toEqual([])
    // A hide whose lot waits for its chromium VI result: do not cut it.
    const held = await ok('floor', 'GET', `/production/cutting/hides?code=${hides['PEND-H1']!.code}&workOrderId=${WO.main.id}`)
    expect(held.hide.lot).toMatchObject({ usable: false, words: expect.stringContaining('Do not cut this hide') })
    expect(held.workOrders).toEqual([expect.objectContaining({ cuttable: false, refusal: expect.objectContaining({ code: 'CR_VI_PENDING' }) })])
    // Not a hide of the tablet's site.
    expect((await call('floorB1', 'GET', `/production/cutting/hides?code=${hides.H01!.code}`)).statusCode).toBe(404)
  })

  it("gives a work order's cells per material with the BOM's area per garment, and no hides yet", async () => {
    const view = await ok('floor', 'GET', `/production/cutting/work-orders/${WO.main.id}`)
    expect(view.workOrder).toMatchObject({ id: WO.main.id, cuttable: true, style: { code: 'SEED-JKT-02' } })
    expect(view.cells).toEqual([expect.objectContaining({ size: '50', quantity: 2, cut: 0, toCut: 2, materials: [expect.objectContaining({ itemId: A.leather, colourCode: 'BLK', parts: ['Outer shell'], perGarment: '48.1600' })] })])
    expect(view.hides).toEqual([])
    expect(view.undo).toBeNull()
  })
})

// ---- the cut --------------------------------------------------------------------------------------------------------------------

describe('a cut (MES-056, SCM-194): the scan issues the hide and logs the set in one command, never more than the hide has', () => {
  it('issues a hide still in stock and cuts one set from it in ONE command: audited, announced, the hide partly cut', async () => {
    const key = freshKey()
    const response = await cut(WO.main.id, { code: hides.H01!.code, lines: sets(WO.main), occurredAt: '2026-11-20T09:12:00.000Z' }, 'floor', key)
    expect(response.statusCode, response.body).toBe(201)
    const answer = response.json()
    expect(answer.issue).toMatchObject({ workOrderId: WO.main.id, hideId: hides.H01!.id, baseQuantity: '55.0000', startsWorkOrder: true })
    expect(answer.issue.moves).toEqual([expect.objectContaining({ reason: 'ISSUE', fromLocationId: A.bin, idempotencyKey: `production.cut:${key}:issue:1`, occurredAt: '2026-11-20T09:12:00.000Z' })])
    expect(answer.cut).toMatchObject({
      workOrderId: WO.main.id,
      hideId: hides.H01!.id,
      lotId: lots.BLK!.id,
      uom: 'FT2',
      areaUsed: '48.1600',
      baseAreaUsed: '48.1600',
      remnantArea: '0.0000',
      workerId: A.operatorA1,
      stationId: A.station,
      deviceId: A.deviceA1,
      deviceTime: '2026-11-20T09:12:00.000Z',
      pieces: [{ workOrderSizeId: WO.main.cells[0].id, part: 'Outer shell', pieces: 1 }],
    })
    expect(answer.hide).toEqual({ id: hides.H01!.id, code: hides.H01!.code, state: 'PARTLY_CUT', left: '6.8400', closed: false })
    expect(answer.cells).toEqual([expect.objectContaining({ size: '50', quantity: 2, cut: 1, toCut: 1 })])
    expect(answer.replayed).toBe(false)
    expect(keysOf(answer).filter((name) => MONEY.test(name))).toEqual([])
    expect(await onHand(A.bin, hides.H01!.id)).toBe('0.0000')
    expect(await hideState(hides.H01!.id)).toBe('PARTLY_CUT')
    const [row] = await admin(`SELECT "createdById", "clientEventId" FROM "CutLog" WHERE id = $1`, [answer.cut.id])
    expect(row!.createdById).toBe(A.operatorA1)
    // One transaction: the issue's audit row and the cut's share the command's key.
    const audits = await admin<{ action: string; recordType: string; audience: string; idempotencyKey: string }>(
      `SELECT action, "recordType", audience, "idempotencyKey" FROM "AuditLog" WHERE "idempotencyKey" = $1 ORDER BY action, "recordType"`,
      [key],
    )
    expect(audits.map((audit) => [audit.action, audit.recordType])).toEqual(
      expect.arrayContaining([
        ['inventory.issue', 'WorkOrder'],
        ['production.cut', 'CutLog'],
        ['production.cut', 'WorkOrder'],
        ['production.hideState', 'Hide'],
      ]),
    )
    expect(audits.every((audit) => audit.audience === 'FLOOR')).toBe(true)
    const [logged] = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'production.cut_logged' AND payload->>'cutLogId' = $1`, [answer.cut.id])
    expect(logged!.payload).toEqual({
      workOrderId: WO.main.id,
      number: WO.main.number,
      cutLogId: answer.cut.id,
      hideId: hides.H01!.id,
      lotId: lots.BLK!.id,
      baseAreaUsed: '48.1600',
      baseRemnantArea: '0.0000',
      cells: [{ workOrderSizeId: WO.main.cells[0].id, pieces: 1 }],
      issueId: answer.issue.id,
      closesHide: false,
      hideState: 'PARTLY_CUT',
      postedBy: 'FLOOR',
    })
    expect(await counts(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'inventory.issued' AND subject = $1`, [WO.main.id])).toBe(1)
  })

  it('refuses a cut of more area than the work order holds of the hide (409 in words; the database refuses it too)', async () => {
    const before = await counts(`SELECT count(*)::int AS n FROM "CutLog"`, [])
    const error = await refused('floor', 'POST', cutUrl(WO.main.id), { clientEventId: clientEvent(), code: hides.H01!.code, lines: sets(WO.main) }, 409)
    expect(refusalOf(error)).toBe('refusal/AREA_EXCEEDED')
    expect(error.message).toBe(`Hide ${hides.H01!.code} has 6.8400 FT2 left for work order ${WO.main.number}; these pieces need 48.1600 (the BOM). Log fewer pieces, or close the hide with Hide done.`)
    // A typed area for a single part is held to the same cap.
    const part = { clientEventId: clientEvent(), code: hides.H01!.code, lines: [{ workOrderSizeId: WO.main.cells[0].id, parts: [{ part: 'Collar', pieces: 1 }] }], area: { area: '7', uom: 'FT2' } }
    expect(refusalOf(await refused('floor', 'POST', cutUrl(WO.main.id), part, 409))).toBe('refusal/AREA_EXCEEDED')
    expect(await counts(`SELECT count(*)::int AS n FROM "CutLog"`, [])).toBe(before)
    // The …_production_guards trigger refuses the same entry for every login, written straight to the table.
    const insert = database.withScope({ audience: 'floor', tenantId: A.tenant, actorId: A.operatorA1, siteId: A.siteA1 }, (client) =>
      client.cutLog.create({
        data: { id: newId(), siteId: A.siteA1, workOrderId: WO.main.id, lotId: lots.BLK!.id, hideId: hides.H01!.id, uom: 'FT2', areaUsed: '7', baseAreaUsed: '7', workerId: A.operatorA1, deviceId: A.deviceA1, clientEventId: clientEvent() },
        select: { id: true },
      }),
    )
    await expect(insert).rejects.toThrow(/does not fit/)
    // What fits does: a part with its typed area within what is left.
    const fits = await cut(WO.main.id, { code: hides.H01!.code, lines: [{ workOrderSizeId: WO.main.cells[0].id, parts: [{ part: 'Collar', pieces: 1 }] }], area: { area: '2.5', uom: 'FT2' } })
    expect(fits.statusCode, fits.body).toBe(201)
    expect(fits.json()).toMatchObject({ issue: null, cut: { areaUsed: '2.5000', pieces: [{ part: 'Collar', pieces: 1 }] }, hide: { left: '4.3400' } })
  })

  it('holds a size that is all cut, and a hide of a held lot, in words', async () => {
    expect(refusalOf(await refused('floor', 'POST', cutUrl(WO.main.id), { clientEventId: clientEvent(), code: hides.H02!.code, lines: sets(WO.main, 2) }, 409))).toBe('refusal/CELL_ALL_CUT')
    const held = await refused('floor', 'POST', cutUrl(WO.main.id), { clientEventId: clientEvent(), code: hides['PEND-H1']!.code, lines: sets(WO.main) }, 409)
    expect(refusalOf(held)).toBe('refusal/CR_VI_PENDING')
    expect(held.message).toMatch(/Do not cut this hide/)
    // Not a cell of the work order; not a hide tag.
    expect((await refused('floor', 'POST', cutUrl(WO.main.id), { clientEventId: clientEvent(), code: hides.H02!.code, lines: sets(WO.replay) }, 400)).issues[0].path).toBe('body/lines/0/workOrderSizeId')
    expect((await refused('floor', 'POST', cutUrl(WO.main.id), { clientEventId: clientEvent(), code: 'NOT-A-TAG', lines: sets(WO.main) }, 400)).issues[0].path).toBe('body/code')
    expect(await onHand(A.bin, hides.H02!.id)).toBe('55.0000')
  })
})

// ---- offline -------------------------------------------------------------------------------------------------------------------

describe('offline (A1 §3.8): a resent event is recorded once, by its Idempotency-Key and by the device\'s client event id', () => {
  it('answers a replayed key from its receipt, a resend under another key with the entry recorded before, and refuses another cut under the same id', async () => {
    const event = clientEvent()
    const key = freshKey()
    const first = await call('floor', 'POST', cutUrl(WO.replay.id), { clientEventId: event, code: hides.H02!.code, lines: sets(WO.replay) }, key)
    expect(first.statusCode, first.body).toBe(201)
    // The same request again: the device's client event id answers it before the receipt would (the same entry).
    const sameKey = await call('floor', 'POST', cutUrl(WO.replay.id), { clientEventId: event, code: hides.H02!.code, lines: sets(WO.replay) }, key)
    expect(sameKey.statusCode, sameKey.body).toBe(200)
    expect(sameKey.json()).toMatchObject({ replayed: true, cut: { id: first.json().cut.id } })
    // The queue sent it again later under a new key (the first answer was lost): the same entry, nothing new.
    const resent = await call('floor', 'POST', cutUrl(WO.replay.id), { clientEventId: event, code: hides.H02!.code, lines: sets(WO.replay) }, freshKey())
    expect(resent.statusCode, resent.body).toBe(200)
    expect(resent.json()).toMatchObject({ replayed: true, cut: { id: first.json().cut.id }, hide: { left: '6.8400' }, cells: [expect.objectContaining({ cut: 1 })] })
    expect(await counts(`SELECT count(*)::int AS n FROM "CutLog" WHERE "deviceId" = $1 AND "clientEventId" = $2`, [A.deviceA1, event])).toBe(1)
    expect(await counts(`SELECT count(*)::int AS n FROM "StockMove" WHERE "hideId" = $1 AND reason = 'ISSUE'`, [hides.H02!.id])).toBe(1)
    // The same client event id for another cut is a conflict.
    expect((await call('floor', 'POST', cutUrl(WO.replay.id), { clientEventId: event, code: hides.H03!.code, lines: sets(WO.replay) }, freshKey())).statusCode).toBe(409)
    // A floor write without a key is refused.
    expect((await call('floor', 'POST', cutUrl(WO.replay.id), { clientEventId: clientEvent(), code: hides.H03!.code, lines: sets(WO.replay) })).statusCode).toBe(400)
  })

  it('records one entry when the same event arrives twice at once under two keys', async () => {
    const event = clientEvent()
    const body = { clientEventId: event, code: hides.H03!.code, lines: sets(WO.replay) }
    const both = await Promise.all([call('floor', 'POST', cutUrl(WO.replay.id), body, freshKey()), call('floor', 'POST', cutUrl(WO.replay.id), body, freshKey())])
    expect(both.map((response) => response.statusCode).sort(), both.map((response) => response.body).join('\n')).toEqual([200, 201])
    expect(new Set(both.map((response) => response.json().cut.id)).size).toBe(1)
    expect(await counts(`SELECT count(*)::int AS n FROM "CutLog" WHERE "deviceId" = $1 AND "clientEventId" = $2`, [A.deviceA1, event])).toBe(1)
  })
})

// ---- two tablets ---------------------------------------------------------------------------------------------------------------

describe('two tablets cutting one hide take turns on its cut lock: one waits, nobody deadlocks, the area is never used twice', () => {
  const waiting = async () =>
    (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`))[0]!.n
  async function untilWaiting(n: number, what: string) {
    for (let tries = 0; (await waiting()) < n; tries++) {
      if (tries > 250) throw new Error(`${what} never waited`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  it('a second tablet waits for the first one on the same hide, then is told what is left', async () => {
    // Another session holds the hide's cut lock (a cut in flight) until released.
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let locked!: () => void
    const holding = new Promise<void>((resolve) => (locked = resolve))
    const holder = asOffice(async (tx) => {
      await lockHideCuts(tx, A.tenant, A.siteA1, hides.H04!.id)
      locked()
      await released
    })
    await holding
    const one = cut(WO.race.id, { code: hides.H04!.code, lines: sets(WO.race) }, 'floor')
    await untilWaiting(1, 'the first tablet')
    const two = cut(WO.race.id, { code: hides.H04!.code, lines: sets(WO.race) }, 'tablet2')
    await untilWaiting(2, 'the second tablet')
    release()
    await holder
    const answers = await Promise.all([one, two])
    const codes = answers.map((response) => response.statusCode).sort()
    expect(codes, answers.map((response) => response.body).join('\n')).toEqual([201, 409])
    const loser = answers.find((response) => response.statusCode === 409)!.json().error
    expect(refusalOf(loser)).toBe('refusal/AREA_EXCEEDED')
    expect(loser.message).toContain('has 6.8400 FT2 left')
    expect(await counts(`SELECT count(*)::int AS n FROM "CutLog" WHERE "hideId" = $1 AND "workOrderId" = $2`, [hides.H04!.id, WO.race.id])).toBe(1)
    expect(await counts(`SELECT count(*)::int AS n FROM "StockMove" WHERE "hideId" = $1 AND reason = 'ISSUE'`, [hides.H04!.id])).toBe(1)
  })

  it('two tablets scanning one hide in stock for two work orders at once: one issues and cuts it, the other is told who has it', async () => {
    const answers = await Promise.all([cut(WO.raceA.id, { code: hides.H05!.code, lines: sets(WO.raceA) }, 'floor'), cut(WO.raceB.id, { code: hides.H05!.code, lines: sets(WO.raceB) }, 'tablet2')])
    const codes = answers.map((response) => response.statusCode).sort()
    expect(codes, answers.map((response) => response.body).join('\n')).toEqual([201, 409])
    const loser = answers.find((response) => response.statusCode === 409)!.json().error
    expect(refusalOf(loser)).toBe('refusal/ALREADY_ISSUED')
    expect(await counts(`SELECT count(*)::int AS n FROM "CutLog" WHERE "hideId" = $1`, [hides.H05!.id])).toBe(1)
    expect(await counts(`SELECT count(*)::int AS n FROM "StockMove" WHERE "hideId" = $1 AND reason = 'ISSUE'`, [hides.H05!.id])).toBe(1)
  })
})

// ---- who an entry names ----------------------------------------------------------------------------------------------------------

describe('who an entry names (Statuto dei Lavoratori art. 4; MES-278): the acknowledged worker, or only the station', () => {
  it("holds every cut while the site's floor is not ready (B-W1-36's gate and the floor rules), in the gate's words", async () => {
    const [basis] = await admin(`SELECT "monitoringBasis", "monitoringReference", "monitoringRecordedAt", "monitoringRecordedById" FROM "ProductionSettings" WHERE id = $1`, [A.siteA1])
    expect(basis!.monitoringBasis).not.toBeNull()
    await admin(`UPDATE "ProductionSettings" SET "monitoringBasis" = NULL, "monitoringReference" = NULL, "monitoringRecordedAt" = NULL, "monitoringRecordedById" = NULL WHERE id = $1`, [A.siteA1])
    try {
      const error = await refused('floor', 'POST', cutUrl(WO.station.id), { clientEventId: clientEvent(), code: hides.H06!.code, lines: sets(WO.station) }, 409)
      expect(refusalOf(error)).toBe('refusal/FLOOR_NOT_READY')
      expect(error.message).toMatch(/^Cutting is held at this site until its floor is ready: Floor records name workers, but no legal basis is on record/)
      expect(await onHand(A.bin, hides.H06!.id)).toBe('55.0000')
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

  it('refuses a worker who has not acknowledged the published worker notice, before anything is issued', async () => {
    const error = await refused('floorLead', 'POST', cutUrl(WO.station.id), { clientEventId: clientEvent(), code: hides.H06!.code, lines: sets(WO.station) }, 409)
    expect(error.message).toMatch(/acknowledge the information notice first/)
    expect(await onHand(A.bin, hides.H06!.id)).toBe('55.0000')
  })

  it('B-W2a-35b: cuts nothing at a cutting station whose machines are all do-not-use (Owner answer H1), before anything is issued', async () => {
    // The press is locked as unsafe; the office sets the cutting table beside it do-not-use too: no machine is left there.
    await admin(`UPDATE "Machine" SET status = 'DO_NOT_USE', "statusSince" = now(), "statusReason" = 'Blade guard cracked.' WHERE id = $1`, [A.cuttingTable])
    try {
      const error = await refused('floor', 'POST', cutUrl(WO.station.id), { clientEventId: clientEvent(), code: hides.H06!.code, lines: sets(WO.station) }, 409)
      expect(refusalOf(error)).toBe('refusal/MACHINE_UNSAFE')
      expect(error.message).toBe('Machines SEED-CP-01, SEED-CT-01 are marked do not use (unsafe): do not work on them. A technician checks the machine and signs it safe first (Owner answer H1; D.Lgs. 81/2008 art. 71).')
      expect(await onHand(A.bin, hides.H06!.id)).toBe('55.0000')
    } finally {
      // Running again: the next test cuts at the same station (tablet2).
      await admin(`UPDATE "Machine" SET status = 'RUNNING', "statusSince" = now(), "statusReason" = NULL WHERE id = $1`, [A.cuttingTable])
    }
  })

  it('at a site that records the station, names the station only (no worker, no creator), and needs a tablet with a station', async () => {
    await admin(`UPDATE "ProductionSettings" SET "scanSubject" = 'STATION' WHERE id = $1`, [A.siteA1])
    try {
      expect((await refused('roaming', 'POST', cutUrl(WO.station.id), { clientEventId: clientEvent(), code: hides.H06!.code, lines: sets(WO.station) }, 409)).message).toMatch(/This device has no station/)
      const response = await cut(WO.station.id, { code: hides.H06!.code, lines: sets(WO.station) }, 'tablet2')
      expect(response.statusCode, response.body).toBe(201)
      const { cut: entry } = response.json()
      expect(entry).toMatchObject({ workerId: null, stationId: A.station, deviceId: A.tablet2 })
      const [row] = await admin(`SELECT "workerId", "createdById" FROM "CutLog" WHERE id = $1`, [entry.id])
      expect(row).toEqual({ workerId: null, createdById: null })
      expect(await admin(`SELECT "createdById" FROM "CutLogPiece" WHERE "cutLogId" = $1`, [entry.id])).toEqual([{ createdById: null }])
      // The station-recorded entry is undone at the station's tablet.
      const undone = await call('tablet2', 'POST', `/production/cutting/cuts/${entry.id}/undo`, undefined, freshKey())
      expect(undone.statusCode, undone.body).toBe(201)
      expect(undone.json().reversal).toMatchObject({ workerId: null, stationId: A.station, reversalOfId: entry.id })
    } finally {
      await admin(`UPDATE "ProductionSettings" SET "scanSubject" = 'WORKER' WHERE id = $1`, [A.siteA1])
    }
  })
})

// ---- Hide done --------------------------------------------------------------------------------------------------------------------

describe('Hide done (MES-058, SCM-253): the remnant back to stock as a REMNANT, or the rest used and the hide used up', () => {
  it('returns the remnant with its measured area and logs the rest as used; the area bar balances', async () => {
    const first = await cut(WO.remnant.id, { code: hides.H07!.code, lines: sets(WO.remnant) }, 'tablet2')
    expect(first.statusCode, first.body).toBe(201)
    const url = `/production/cutting/work-orders/${WO.remnant.id}/hides/${hides.H07!.id}/remnant`
    expect(refusalOf(await refused('tablet2', 'POST', url, { clientEventId: clientEvent(), remnant: { area: '7', uom: 'FT2', toLocationId: A.cutRack } }, 409))).toBe('refusal/REMNANT_TOO_LARGE')
    const response = await call('tablet2', 'POST', url, { clientEventId: clientEvent(), remnant: { area: '5', uom: 'FT2', toLocationId: A.cutRack } }, freshKey())
    expect(response.statusCode, response.body).toBe(201)
    const done = response.json()
    expect(done.cut).toMatchObject({ areaUsed: '1.8400', remnantArea: '5.0000', pieces: [] })
    expect(done.remnant).toMatchObject({ reason: 'RETURN', toLocationId: A.cutRack, quantity: '5.0000', workOrderId: WO.remnant.id, idempotencyKey: `production.cut.remnant:${done.cut.id}` })
    expect(done.hide).toMatchObject({ state: 'REMNANT', left: '0.0000', closed: true })
    expect(await hideState(hides.H07!.id)).toBe('REMNANT')
    expect(await onHand(A.cutRack, hides.H07!.id)).toBe('5.0000')
    const [closed] = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'production.hide_closed' AND payload->>'hideId' = $1`, [hides.H07!.id])
    expect(closed!.payload).toMatchObject({ cutLogId: done.cut.id, remnantMoveId: done.remnant.id, baseRemnantArea: '5.0000', hideState: 'REMNANT' })
    // The office's cut log: the hide's bar is the set (cut), its offcut (waste), the remnant (returned) and nothing left.
    const log = await ok('manager', 'GET', `/production/cutting/work-orders/${WO.remnant.id}/cut-log`)
    expect(log.hides).toEqual([{ hideId: hides.H07!.id, code: hides.H07!.code, lotCode: lots.BLK!.code, state: 'REMNANT', issued: '55.0000', cut: '48.1600', waste: '1.8400', returned: '5.0000', left: '0.0000' }])
    expect(log.entries[0]).toMatchObject({ id: done.cut.id, pattern: '0.0000', live: true, worker: { id: A.operatorA1, name: expect.any(String) }, station: { id: A.station, code: 'CUT-01' } })
    expect(log.entries[1]).toMatchObject({ id: first.json().cut.id, pattern: '48.1600', cells: [{ workOrderSizeId: WO.remnant.cells[0].id, colourwayCode: 'BLK', size: '50' }] })
    expect(log.cells).toEqual([expect.objectContaining({ quantity: 2, cut: 1, toCut: 1, parts: [{ part: 'Outer shell', pieces: 1, planned: true }] })])
  })

  it("undoes Hide done on the tablet before the next cut: the entry is mirrored and the remnant goes back to the work order", async () => {
    const view = await ok('tablet2', 'GET', `/production/cutting/work-orders/${WO.remnant.id}`)
    expect(view.undo).toMatchObject({ remnantArea: '5.0000' })
    const response = await call('tablet2', 'POST', `/production/cutting/cuts/${view.undo.id}/undo`, undefined, freshKey())
    expect(response.statusCode, response.body).toBe(201)
    expect(response.json()).toMatchObject({ reversedId: view.undo.id, remnantReturnReversed: true, hide: { state: 'PARTLY_CUT', left: '6.8400' } })
    expect(await onHand(A.cutRack, hides.H07!.id)).toBe('0.0000')
    expect(await hideState(hides.H07!.id)).toBe('PARTLY_CUT')
  })

  let closing: Json

  it('closes a hide with the last set and no remnant in one tap: the rest is used, the hide is used up and names that entry as its closing one', async () => {
    const response = await cut(WO.consume.id, { code: hides.H08!.code, lines: sets(WO.consume), done: { remnant: null } })
    expect(response.statusCode, response.body).toBe(201)
    const answer = response.json()
    closing = answer.cut
    expect(answer.cut).toMatchObject({ areaUsed: '55.0000', remnantArea: '0.0000', pieces: [{ part: 'Outer shell', pieces: 1 }] })
    expect(answer).toMatchObject({ remnant: null, hide: { state: 'CONSUMED', left: '0.0000', closed: true } })
    expect(await hideRow(hides.H08!.id)).toEqual({ state: 'CONSUMED', closingCutLogId: answer.cut.id })
    // Nothing more is cut from it.
    expect(refusalOf(await refused('floor', 'POST', cutUrl(WO.consume.id), { clientEventId: clientEvent(), code: hides.H08!.code, lines: sets(WO.consume) }, 409))).toBe('refusal/HIDE_USED_UP')
    const log = await ok('manager', 'GET', `/production/cutting/work-orders/${WO.consume.id}/cut-log`)
    expect(log.hides).toEqual([expect.objectContaining({ issued: '55.0000', cut: '48.1600', waste: '6.8400', returned: '0.0000', left: '0.0000', state: 'CONSUMED' })])
    expect(log.entries.map((row: Json) => [row.id, row.closing])).toEqual([[answer.cut.id, true]])
  })

  it("corrects a wrong closing cut (B-W1-40's gap): the office's reversal opens the used-up hide again, and it closes again with the right remnant", async () => {
    const corrected = await ok('manager', 'POST', `/production/cutting/cuts/${closing.id}/correct`, { reason: 'A usable offcut was set aside, not wasted' }, 201)
    expect(corrected).toMatchObject({ reversedId: closing.id, hide: { id: hides.H08!.id, state: 'PARTLY_CUT', left: '55.0000' }, cells: [expect.objectContaining({ cut: 0, toCut: 2 })] })
    expect(await hideRow(hides.H08!.id)).toEqual({ state: 'PARTLY_CUT', closingCutLogId: null })
    const [audit] = await admin(`SELECT before, after FROM "AuditLog" WHERE action = 'production.hideState' AND "recordId" = $1 ORDER BY at DESC, id DESC LIMIT 1`, [hides.H08!.id])
    expect(audit).toEqual({ before: { state: 'CONSUMED', closingCutLogId: closing.id }, after: { state: 'PARTLY_CUT' } })
    const [reversed] = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'production.cut_reversed' AND payload->>'reversedId' = $1`, [closing.id])
    expect(reversed!.payload).toMatchObject({ undo: false, postedBy: 'OFFICE', hideState: 'PARTLY_CUT' })
    // The cutter logs the set again and closes the hide with the offcut set aside: a REMNANT now, nothing closing.
    const again = await cut(WO.consume.id, { code: hides.H08!.code, lines: sets(WO.consume), done: { remnant: { area: '6', uom: 'FT2', toLocationId: A.cutRack } } })
    expect(again.statusCode, again.body).toBe(201)
    expect(again.json().hide).toMatchObject({ state: 'REMNANT', left: '0.0000', closed: true })
    expect(await hideRow(hides.H08!.id)).toEqual({ state: 'REMNANT', closingCutLogId: null })
    expect(await onHand(A.cutRack, hides.H08!.id)).toBe('6.0000')
    expect(refusalOf(await refused('manager', 'POST', `/production/cutting/cuts/${closing.id}/correct`, { reason: 'Again' }, 409))).toBe('refusal/REVERSED_ALREADY')
    const log = await ok('manager', 'GET', `/production/cutting/work-orders/${WO.consume.id}/cut-log`)
    expect(log.hides).toEqual([expect.objectContaining({ issued: '55.0000', cut: '48.1600', waste: '0.8400', returned: '6.0000', left: '0.0000', state: 'REMNANT' })])
    expect(log.entries.every((row: Json) => row.closing === false)).toBe(true)
  })

  it("keeps a used-up hide's other cuts final, in words and in the database; the cutter's undo of the closing cut opens it too", async () => {
    const first = (await cut(WO.consumeTwo.id, { code: hides.H13!.code, lines: sets(WO.consumeTwo) }, 'tablet3')).json().cut
    const done = await call('tablet3', 'POST', `/production/cutting/work-orders/${WO.consumeTwo.id}/hides/${hides.H13!.id}/remnant`, { clientEventId: clientEvent(), remnant: null }, freshKey())
    expect(done.statusCode, done.body).toBe(201)
    const last = done.json().cut
    expect(last).toMatchObject({ areaUsed: '6.8400', pieces: [] })
    expect(await hideRow(hides.H13!.id)).toEqual({ state: 'CONSUMED', closingCutLogId: last.id })
    // The first cut of the used-up hide is final: in words, and in the database (a hand-made reversal of it).
    const error = await refused('manager', 'POST', `/production/cutting/cuts/${first.id}/correct`, { reason: 'Logged on the wrong order' }, 409)
    expect(error).toMatchObject({
      issues: [{ path: 'refusal/HIDE_USED_UP' }],
      message: `Hide ${hides.H13!.code} is used up: its cuts are final but its closing cut. Correct the closing cut first (that opens the hide again), then this one.`,
    })
    await expect(admin(...mirrorSql(first.id))).rejects.toThrow(/is used up; its cuts are final but its closing entry/)
    // The hide never leaves CONSUMED by itself: not to PARTLY_CUT while its closing entry stands, never to another state.
    await expect(admin(`UPDATE "Hide" SET state = 'PARTLY_CUT', "closingCutLogId" = NULL WHERE id = $1`, [hides.H13!.id])).rejects.toThrow(/opens again \(PARTLY_CUT\) only when its closing cut log entry .* is reversed/)
    await expect(admin(`UPDATE "Hide" SET state = 'REMNANT', "closingCutLogId" = NULL WHERE id = $1`, [hides.H13!.id])).rejects.toThrow(/it never changes, but back to PARTLY_CUT/)
    await expect(admin(`UPDATE "Hide" SET grade = 'B' WHERE id = $1`, [hides.H13!.id])).rejects.toThrow(/it never changes, but back to PARTLY_CUT/)
    // A reversal of the closing entry that leaves the hide used up is refused when its transaction commits.
    await admin('BEGIN')
    try {
      await admin(...mirrorSql(last.id))
      await expect(admin('COMMIT')).rejects.toThrow(/opens again \(PARTLY_CUT\) in the same transaction/)
    } finally {
      await admin('ROLLBACK').catch(() => undefined)
    }
    expect(await counts(`SELECT count(*)::int AS n FROM "CutLog" WHERE "reversalOfId" = $1`, [last.id])).toBe(0)
    // The cutter's own last entry, the closing one (a Hide done tapped too early), is undone on the tablet: open again.
    const undone = await call('tablet3', 'POST', `/production/cutting/cuts/${last.id}/undo`, undefined, freshKey())
    expect(undone.statusCode, undone.body).toBe(201)
    expect(undone.json()).toMatchObject({ reversedId: last.id, hide: { state: 'PARTLY_CUT', left: '6.8400' } })
    expect(await hideRow(hides.H13!.id)).toEqual({ state: 'PARTLY_CUT', closingCutLogId: null })
    // Open again, the first cut is corrected like any other.
    expect((await ok('manager', 'POST', `/production/cutting/cuts/${first.id}/correct`, { reason: 'Logged on the wrong order' }, 201)).hide).toMatchObject({ state: 'PARTLY_CUT', left: '55.0000' })
  })

  it('names the last cut as the closing one when Hide done used nothing more; correcting it opens the hide again', async () => {
    const all = await cut(WO.closeLast.id, { code: hides.H14!.code, lines: [{ workOrderSizeId: WO.closeLast.cells[0].id, parts: [{ part: 'Outer shell', pieces: 1 }] }], area: { area: '55', uom: 'FT2' } }, 'tablet3')
    expect(all.statusCode, all.body).toBe(201)
    const entry = all.json().cut
    expect(all.json().hide).toMatchObject({ state: 'PARTLY_CUT', left: '0.0000' })
    const done = await call('tablet3', 'POST', `/production/cutting/work-orders/${WO.closeLast.id}/hides/${hides.H14!.id}/remnant`, { clientEventId: clientEvent(), remnant: null }, freshKey())
    expect(done.statusCode, done.body).toBe(201)
    expect(done.json()).toMatchObject({ cut: null, hide: { state: 'CONSUMED', closed: true } })
    expect(await hideRow(hides.H14!.id)).toEqual({ state: 'CONSUMED', closingCutLogId: entry.id })
    const corrected = await ok('manager', 'POST', `/production/cutting/cuts/${entry.id}/correct`, { reason: 'A single part logged on the wrong hide' }, 201)
    expect(corrected.hide).toMatchObject({ state: 'PARTLY_CUT', left: '55.0000' })
    expect(await hideRow(hides.H14!.id)).toEqual({ state: 'PARTLY_CUT', closingCutLogId: null })
  })
})

// ---- undo and correction -------------------------------------------------------------------------------------------------------

describe('undo (the cutter, before the next cut) and correction (the office, with the reason): one mirror entry', () => {
  it("undoes the cutter's own last cut once; another worker, an older cut and a second undo are refused", async () => {
    const first = (await cut(WO.undo.id, { code: hides.H09!.code, lines: sets(WO.undo) }, 'roaming')).json()
    const second = await cut(WO.undo.id, { code: hides.H10!.code, lines: sets(WO.undo) }, 'roaming')
    expect(second.statusCode, second.body).toBe(201)
    const latest = second.json().cut
    // The older one is no longer the tablet's last action.
    expect(refusalOf(await refused('roaming', 'POST', `/production/cutting/cuts/${first.cut.id}/undo`, undefined, 409))).toBe('refusal/NOT_LAST_ACTION')
    // Another worker on the same tablet does not undo the operator's cut, nor does another tablet.
    expect(refusalOf(await refused('roamingLead', 'POST', `/production/cutting/cuts/${latest.id}/undo`, undefined, 409))).toBe('refusal/NOT_LAST_ACTION')
    expect(refusalOf(await refused('tablet2', 'POST', `/production/cutting/cuts/${latest.id}/undo`, undefined, 409))).toBe('refusal/NOT_LAST_ACTION')
    expect((await ok('roaming', 'GET', `/production/cutting/work-orders/${WO.undo.id}`)).undo).toMatchObject({ id: latest.id })
    const undone = await call('roaming', 'POST', `/production/cutting/cuts/${latest.id}/undo`, undefined, freshKey())
    expect(undone.statusCode, undone.body).toBe(201)
    expect(undone.json()).toMatchObject({
      reversal: { reversalOfId: latest.id, areaUsed: '48.1600', pieces: [], workerId: A.operatorA1, note: 'Undone by the cutter before the next cut (logged by mistake).' },
      remnantReturnReversed: false,
      hide: { id: hides.H10!.id, left: '55.0000' },
      cells: [expect.objectContaining({ cut: 1, toCut: 1 })],
    })
    expect(refusalOf(await refused('roaming', 'POST', `/production/cutting/cuts/${latest.id}/undo`, undefined, 409))).toBe('refusal/REVERSED_ALREADY')
    const [reversed] = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'production.cut_reversed' AND payload->>'reversedId' = $1`, [latest.id])
    expect(reversed!.payload).toMatchObject({ undo: true, postedBy: 'FLOOR', baseAreaUsed: '48.1600' })
    // The hide's area is back: the same set is cut again from it.
    expect((await cut(WO.undo.id, { code: hides.H10!.code, lines: sets(WO.undo) }, 'roaming')).statusCode).toBe(201)
  })

  it('lets the office correct any live entry with its reason, once; never a reversal, never one whose pieces travel in a bundle', async () => {
    const entry = (await cut(WO.correct.id, { code: hides.H11!.code, lines: sets(WO.correct) })).json().cut
    expect((await call('floor', 'POST', `/production/cutting/cuts/${entry.id}/correct`, { reason: 'Wrong size logged' }, freshKey())).statusCode).toBe(403)
    expect((await call('viewer', 'POST', `/production/cutting/cuts/${entry.id}/correct`, { reason: 'Wrong size logged' }, freshKey())).statusCode).toBe(403)
    const corrected = await ok('manager', 'POST', `/production/cutting/cuts/${entry.id}/correct`, { reason: 'Logged on the wrong order' }, 201)
    expect(corrected).toMatchObject({ reversedId: entry.id, reversal: { reversalOfId: entry.id, deviceId: null, workerId: A.operatorA1, note: 'Corrected by the office: Logged on the wrong order' }, cells: [expect.objectContaining({ cut: 0 })] })
    expect(await admin(`SELECT audience, reason FROM "AuditLog" WHERE action = 'production.correctCut' AND "recordType" = 'WorkOrder' AND "recordId" = $1`, [WO.correct.id])).toEqual([
      { audience: 'OFFICE', reason: 'Corrected by the office: Logged on the wrong order' },
    ])
    expect(refusalOf(await refused('manager', 'POST', `/production/cutting/cuts/${entry.id}/correct`, { reason: 'Again' }, 409))).toBe('refusal/REVERSED_ALREADY')
    expect(refusalOf(await refused('manager', 'POST', `/production/cutting/cuts/${corrected.reversal.id}/correct`, { reason: 'Undo the correction' }, 409))).toBe('refusal/NOT_A_CUT')
    // The seeded cut's pieces travel in two bundles: void them first (B-W1-41).
    const bundled = await refused('manager', 'POST', `/production/cutting/cuts/${A.seededCut}/correct`, { reason: 'Wrong size logged' }, 409)
    expect(refusalOf(bundled)).toBe('refusal/IN_BUNDLE')
    expect(bundled.message).toMatch(/SEED-BN-0001, SEED-BN-0002/)
    const log = await ok('manager', 'GET', `/production/cutting/work-orders/${WO.correct.id}/cut-log`)
    expect(log.entries.map((row: Json) => [row.id, row.live, row.reversedById])).toEqual([
      [corrected.reversal.id, false, null],
      [entry.id, false, corrected.reversal.id],
    ])
    expect(log.hides).toEqual([expect.objectContaining({ issued: '55.0000', cut: '0.0000', waste: '0.0000', left: '55.0000' })])
  })
})

// ---- the work order record, and the walls ------------------------------------------------------------------------------------------

describe('the work order record counts its cut garments; the walls hold', () => {
  it("replaces the record's null cut count with the cut log's, per cell", async () => {
    const { workOrder } = await ok('planner', 'GET', `/production/work-orders/${WO.main.id}`)
    // Sewn and finished are counted from the floor's scans (B-W1-42): none yet.
    expect(workOrder.cells.map((cell: Json) => cell.progress)).toEqual([{ cut: 1, bundled: 0, sewn: 0, finished: 0 }])
    // The seeded work order: its cut is sleeves only, so no garment of it is cut yet.
    const seeded = await ok('planner', 'GET', `/production/work-orders/${A.seededWorkOrder}`)
    expect(seeded.workOrder.cells.every((cell: Json) => cell.progress.cut === 0)).toBe(true)
  })

  it('keeps a tablet to its site and the office to its companies and tenant: another one is not found', async () => {
    expect((await call('floorB1', 'GET', `/production/cutting/work-orders/${WO.main.id}`)).statusCode).toBe(404)
    expect((await call('floorB1', 'POST', cutUrl(WO.main.id), { clientEventId: clientEvent(), code: hides.H12!.code, lines: sets(WO.main) }, freshKey())).statusCode).toBe(404)
    expect((await call('companyB', 'GET', `/production/cutting/work-orders/${WO.main.id}/cut-log`)).statusCode).toBe(404)
    expect((await call('otherTenant', 'GET', `/production/cutting/work-orders/${WO.main.id}/cut-log`)).statusCode).toBe(404)
    expect((await call('otherTenant', 'POST', `/production/cutting/cuts/${A.seededCut}/correct`, { reason: 'Not mine' }, freshKey())).statusCode).toBe(404)
    // The office's cut log is no floor route; the floor's cut is no office route.
    expect((await call('floor', 'GET', `/production/cutting/work-orders/${WO.main.id}/cut-log`)).statusCode).toBe(403)
    expect((await call('manager', 'POST', cutUrl(WO.main.id), { clientEventId: clientEvent(), code: hides.H12!.code, lines: sets(WO.main) }, freshKey())).statusCode).toBe(403)
    expect(await onHand(A.bin, hides.H12!.id)).toBe('55.0000')
  })
})

// ---- quality holds (B-W2a-F1) ------------------------------------------------------------------------------------------------------

describe('a cut of a held hide, or of a hide of a held lot, is refused in words before the database (holdOnCut; B-W2a-F1)', () => {
  beforeAll(async () => {
    await addLot('HOLD', 'RELEASED', 'PASS', ['HOLD-H1', 'HOLD-H2'])
  })
  /** An ACTIVE hold placed by the office, as POST /quality/holds writes it (the …_quality_plant_w2a_guards are real). */
  const placeHold = (subjectType: 'Hide' | 'Lot', subjectId: string) =>
    admin(
      `INSERT INTO "QualityHold" (id, "tenantId", "companyId", "siteId", "subjectType", "subjectIds", "reasonCode", "reasonNote", "placedAt", "placedById", "createdById")
       VALUES ($1, $2, $3, $4, $5, ARRAY[$6]::uuid[], 'QUALITY_CHECK', 'A grain crack seen at the table (made up).', '2026-11-21T09:00:00Z', $7, $7)`,
      [newId(), A.tenant, A.companyA, A.siteA1, subjectType, subjectId, A.actor],
    )
  const collar = (code: string) => ({ clientEventId: clientEvent(), code, lines: [{ workOrderSizeId: WO.held.cells[0].id, parts: [{ part: 'Collar', pieces: 1 }] }], area: { area: '2.5', uom: 'FT2' } })
  const entries = () => counts(`SELECT count(*)::int AS n FROM "CutLog"`, [])

  it("a hide at the work order, held after its first cut: 409 QUALITY_HOLD in the hold's words, nothing logged", async () => {
    const hide = hides['HOLD-H1']!
    const first = await cut(WO.held.id, { code: hide.code, lines: sets(WO.held) })
    expect(first.statusCode, first.body).toBe(201)
    await placeHold('Hide', hide.id)
    const before = await entries()
    const error = await refused('floor', 'POST', cutUrl(WO.held.id), collar(hide.code), 409)
    expect(refusalOf(error)).toBe('refusal/QUALITY_HOLD')
    expect(error.message).toMatch(new RegExp(`^Hide ${hide.code} is on hold \\(.+, since 21 Nov 2026\\): it is not cut until quality releases the hold\\.$`))
    expect(await entries()).toBe(before)
  })

  it("a hide at the work order whose lot is held: 409 in the lot's words, nothing logged", async () => {
    const hide = hides['HOLD-H2']!
    const first = await cut(WO.held.id, { code: hide.code, lines: sets(WO.held) })
    expect(first.statusCode, first.body).toBe(201)
    await placeHold('Lot', lots.HOLD!.id)
    const before = await entries()
    const error = await refused('floor', 'POST', cutUrl(WO.held.id), collar(hide.code), 409)
    expect(refusalOf(error)).toBe('refusal/QUALITY_HOLD')
    expect(error.message).toMatch(new RegExp(`^Lot ${lots.HOLD!.code} is on hold \\(.+, since 21 Nov 2026\\): its hides are not cut until quality releases the hold\\.$`))
    expect(await entries()).toBe(before)
  })
})
