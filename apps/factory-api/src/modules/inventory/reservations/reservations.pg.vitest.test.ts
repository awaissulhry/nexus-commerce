import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase, type Prisma } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { lockReservations } from './store'

/**
 * Stock every day (B-W2a-11; SCM-205, SCM-209, SCM-210, SCM-193, SCM-197, SCM-195) on the local stack, with the app's real
 * routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security, the grants and
 * the …_stock_plan_w2a_guards, …_production_w2a_guards and …_supply_guards triggers are real), the factory-db seeds of one
 * tenant up to production (SEED-JKT-02 with its released BOM of black leather by the hide, grey lining by the lot and
 * protectors; plant A1 with its cutting tablet), the numbering and reason seeds, and on top made-up stock at A1: a
 * released black leather lot of four hides, a black lot in quarantine, a released grey lining lot. Three released work
 * orders of one black jacket each are made through the work-order routes. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs reservations`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = 'stock-every-day-a'
const idOf = (key: string) => seedUuid(ns, key)
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
  leatherRED: idOf('product:item-colour:leather:RED'),
  liningGRY: idOf('product:item-colour:lining:GRY'),
  store: idOf('inventory:location:A1-STORE'),
  bin: idOf('inventory:location:A1-STORE-01'),
  deviceA1: idOf('device:A1:cutting'),
  operatorA1: idOf('worker:A1:operator'),
}

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  planner: office([grant(['workorders.view', 'workorders.manage', 'workorders.release'])]),
  /** The warehouse role: reserve, write off, reverse, issue; sees no cost. */
  warehouse: office([grant(['inventory.reserve', 'inventory.stock.view', 'inventory.scrap', 'inventory.reverse', 'inventory.issue', 'inventory.issue.over', 'files.upload'])]),
  /** The same with the cost grain. */
  owner: office([grant(['inventory.reserve', 'inventory.stock.view', 'inventory.scrap', 'inventory.reverse', 'inventory.issue', 'money.cost'])]),
  viewer: office([grant(['inventory.stock.view'])]),
  /** B-W2a-64: quality places holds (and sees stock). */
  quality: office([grant(['quality.holds.place', 'quality.holds.view', 'inventory.stock.view'])]),
  floor: {
    audience: 'floor',
    tenantId: A.tenant,
    actorId: A.operatorA1,
    siteId: A.siteA1,
    deviceId: A.deviceA1,
    grants: [grant(['floor.work', 'inventory.issue', 'inventory.locations.view'], [A.companyA], [A.siteA1])],
  },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `t-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown, key: string | undefined = freshKey()) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const asOffice = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) => client.$transaction(work))
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : []
const MONEY = /cost|price|margin|amount|wage|valuation|values/i

// ---- made-up stock and work orders ----------------------------------------------------------------------------------------

const hides: Record<string, string> = {}
const lots: Record<string, { id: string; code: string }> = {}

async function addLot(key: string, itemId: string, colourId: string | null, status: 'RELEASED' | 'QUARANTINE', stock: { quantity: string; uom: string; hide?: string }[]) {
  const lotId = newId()
  lots[key] = { id: lotId, code: `T-${run}-${key}` }
  const leather = itemId === A.leather
  await admin(
    `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "qualityStatus", "qualityDecidedAt", "requiresCrViTest", "crViLimitMgKg", "crViStatus", "crViMgKg", "crViEvidence", "crViTestedAt", "receivedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now() - interval '20 days')`,
    [lotId, A.tenant, A.companyA, A.siteA1, itemId, colourId, lots[key].code, status, status === 'RELEASED' ? new Date() : null, leather, leather ? '3.000' : null, leather ? (status === 'RELEASED' ? 'PASS' : 'PENDING') : 'NOT_REQUIRED', leather && status === 'RELEASED' ? '1.100' : null, leather && status === 'RELEASED' ? 'LOT_REPORT' : null, leather && status === 'RELEASED' ? '2026-10-01' : null],
  )
  for (const [index, entry] of stock.entries()) {
    const hideId = entry.hide ? newId() : null
    if (hideId) {
      hides[entry.hide!] = hideId
      await admin(`INSERT INTO "Hide" (id, "tenantId", "siteId", "lotId", "itemId", code, area, "areaUom", "baseArea") VALUES ($1, $2, $3, $4, $5, $6, $7, 'FT2', $7)`, [hideId, A.tenant, A.siteA1, lotId, itemId, `T-${run}-${entry.hide}`, entry.quantity])
    }
    // Opening stock 30 days ago (a known past for "stock as of a date").
    await admin(
      `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "hideId", "toLocationId", quantity, uom, "baseQuantity", "idempotencyKey", "occurredAt", note)
       VALUES ($1, $2, $3, $4, 'OPENING', $5, $6, $7, $8, $9, $10, $11, $10, $12, now() - interval '30 days', 'Made-up opening stock')`,
      [newId(), A.tenant, A.companyA, A.siteA1, itemId, colourId, lotId, hideId, A.bin, entry.quantity, entry.uom, `res-test-${lots[key].code}-${index}`],
    )
  }
}

async function salesOrder(suffix: string): Promise<string> {
  const orderId = newId()
  const lineId = newId()
  await asOffice(async (tx) => {
    await tx.salesOrder.create({
      data: { id: orderId, companyId: A.companyA, partyId: A.brand, number: `T-${run}-SO-${suffix}`, status: 'CONFIRMED', orderDate: new Date('2026-10-20T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up workshop' }, promiseDate: new Date('2026-12-10T00:00:00.000Z'), depositRequired: false },
      select: { id: true },
    })
    await tx.salesOrderLine.create({
      data: { id: lineId, companyId: A.companyA, orderId, partyId: A.brand, seq: 10, kind: 'SIZE_GRID', styleId: A.style, colourwayId: A.blk, quantity: 1, unitPrice: '100.000000', netAmount: 10_000, vatRatePct: '22.00', vatAmount: 2_200, siteId: A.siteA1 },
      select: { id: true },
    })
    await tx.salesOrderLineSize.create({ data: { id: newId(), lineId, partyId: A.brand, size: '50', quantity: 1 }, select: { id: true } })
  })
  return lineId
}

async function releasedWorkOrder(lineId: string): Promise<Json> {
  const { workOrder } = await ok('planner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: lineId, sizes: [{ size: '50', quantity: 1 }] }] }, 201)
  // The seed's own work orders already count on most of the leather: released on the planner's override (this file tests reservations).
  return (await ok('planner', 'POST', `/production/work-orders/${workOrder.id}/release`, { version: workOrder.version, materialOverride: { reason: 'Made-up test: reservations decide' } })).workOrder
}

const WO: Record<'one' | 'two' | 'three', Json> = {} as never
const LINE: Record<'one' | 'four', string> = {} as never

beforeAll(async () => {
  db = await migratedDatabase('stock_every_day')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 10 } })
  await seedCore({ db: database, namespace: ns })
  await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  await seedReasons({ db: database, namespace: ns })
  await asOffice(async (tx) => {
    const certificateId = newId()
    await tx.certificate.create({
      data: { id: certificateId, holderPartyId: A.brand, standard: 'EN 17092-3:2020', ppeClass: 'AA', number: `T-${run}-CERT`, notifiedBodyName: 'Made-up Notified Body', notifiedBodyNumber: '9999', modelReference: 'SEED-JKT-02', validFrom: new Date('2026-01-01T00:00:00.000Z'), validTo: new Date('2030-12-31T00:00:00.000Z'), status: 'VALID', statusChangedAt: new Date() },
      select: { id: true },
    })
    await tx.certificateCoverage.create({ data: { id: newId(), certificateId, styleId: A.style, sizes: ['50', '52'] }, select: { id: true } })
  })
  await addLot('BLK', A.leather, A.leatherBLK, 'RELEASED', [
    { quantity: '50.0000', uom: 'FT2', hide: 'H1' },
    { quantity: '45.0000', uom: 'FT2', hide: 'H2' },
    { quantity: '40.0000', uom: 'FT2', hide: 'H3' },
    { quantity: '35.0000', uom: 'FT2', hide: 'H4' },
  ])
  await addLot('HELD', A.leather, A.leatherBLK, 'QUARANTINE', [{ quantity: '60.0000', uom: 'FT2', hide: 'Q1' }])
  await addLot('LIN', A.lining, A.liningGRY, 'RELEASED', [{ quantity: '100.0000', uom: 'M' }])
  await addLot('PRO', A.protector, null, 'RELEASED', [{ quantity: '200.0000', uom: 'PCS' }])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
  LINE.one = await salesOrder('1')
  WO.one = await releasedWorkOrder(LINE.one)
  WO.two = await releasedWorkOrder(await salesOrder('2'))
  WO.three = await releasedWorkOrder(await salesOrder('3'))
  LINE.four = await salesOrder('4')
}, 120_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

const reserve = (session: string, body: Json) => call(session, 'POST', '/inventory/reservations', { siteId: A.siteA1, ...body })
const availabilityOfLeather = async () => (await ok('warehouse', 'GET', `/inventory/reservations/availability?siteId=${A.siteA1}&itemId=${A.leather}&itemColourId=${A.leatherBLK}`))
const issueTo = (workOrderId: string, body: Json, session = 'floor') => call(session, 'POST', `/inventory/picking/work-orders/${workOrderId}/issue`, body)

describe('reserve to an order, leather by area, named hides (SCM-205, SCM-209)', () => {
  it('reserves an area of a lot for a work order, from what is available (held stock is not)', async () => {
    const before = await availabilityOfLeather()
    // 170 ft² released (four hides) + the seed's 51.8 ft² hide, and 60 in quarantine.
    expect(before.figures).toMatchObject({ onHand: '281.8000', held: '60.0000', reserved: '0.0000', available: '221.8000', overReserved: false })
    const response = await reserve('warehouse', { workOrderId: WO.one.id, lines: [{ lotId: lots.BLK!.id, quantity: '60' }], note: 'Body panels' })
    expect(response.statusCode, response.body).toBe(201)
    const [reservation] = response.json().reservations
    expect(reservation).toMatchObject({ kind: 'AREA', status: 'ACTIVE', quantity: '60.0000', open: '60.0000', stale: false, lot: { code: lots.BLK!.code }, demand: { type: 'WorkOrder', number: WO.one.number } })
    const after = await availabilityOfLeather()
    expect(after.figures).toMatchObject({ reserved: '60.0000', available: '161.8000' })
    expect(after.lots.find((lot: Json) => lot.lot.id === lots.BLK!.id)).toMatchObject({ onHand: '170.0000', reserved: '60.0000', available: '110.0000' })
  })

  it('refuses more than is available, line by line in words, and held stock', async () => {
    const error = await refused('warehouse', 'POST', '/inventory/reservations', { siteId: A.siteA1, workOrderId: WO.two.id, lines: [{ itemId: A.leather, itemColourId: A.leatherBLK, quantity: '150' }, { itemId: A.leather, itemColourId: A.leatherBLK, quantity: '20' }] }, 409)
    expect(paths(error)).toEqual(['body/lines/1/refusal/NOT_AVAILABLE'])
    expect(error.message).toMatch(/11\.8000 FT2 available at this site .* 20\.0000 FT2 asked/)
    const held = await refused('warehouse', 'POST', '/inventory/reservations', { siteId: A.siteA1, workOrderId: WO.two.id, lines: [{ hideId: hides.Q1 }] }, 409)
    expect(paths(held)).toEqual(['body/lines/0/refusal/LOT_HELD'])
    // Nothing of the refused request was kept.
    expect((await availabilityOfLeather()).figures.reserved).toBe('60.0000')
  })

  it('holds a named hide for one work order only; a material the work order does not use is refused', async () => {
    const response = await reserve('warehouse', { workOrderId: WO.two.id, lines: [{ hideId: hides.H2 }] })
    expect(response.statusCode, response.body).toBe(201)
    expect(response.json().reservations[0]).toMatchObject({ kind: 'HIDE', quantity: '45.0000', hide: { id: hides.H2 } })
    const twice = await refused('warehouse', 'POST', '/inventory/reservations', { siteId: A.siteA1, workOrderId: WO.three.id, lines: [{ hideId: hides.H2 }] }, 409)
    expect(paths(twice)).toEqual(['body/lines/0/refusal/HIDE_RESERVED'])
    expect(twice.message).toContain(`work order ${WO.two.number}`)
    // The work order plans black leather only: red is refused (reserve what it uses).
    const red = await refused('warehouse', 'POST', '/inventory/reservations', { siteId: A.siteA1, workOrderId: WO.three.id, lines: [{ itemId: A.leather, itemColourId: A.leatherRED, quantity: '1' }] }, 400)
    expect(paths(red)).toEqual(['body/lines/0/itemId'])
  })

  it('two requests for the last free area at once: one is given it, the other is told (the reserve lock)', async () => {
    // Free now: 221.8 − 60 − 45 = 116.8 ft²: room for one request of 100. Another session holds the reserve lock of black
    // leather at A1 until both requests wait for it, so they truly overlap (without the lock both would read 116.8 free).
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let locked!: () => void
    const holding = new Promise<void>((resolve) => (locked = resolve))
    const holder = database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) =>
      client.$transaction(async (tx) => {
        await lockReservations(tx, A.tenant, [{ siteId: A.siteA1, itemId: A.leather, itemColourId: A.leatherBLK }])
        locked()
        await released
      }, { timeout: 20_000 }),
    )
    await holding
    const results = Promise.all([1, 2].map(() => reserve('warehouse', { workOrderId: WO.three.id, lines: [{ itemId: A.leather, itemColourId: A.leatherBLK, quantity: '100' }] })))
    const waiting = async () =>
      (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`))[0]!.n
    for (let tries = 0; (await waiting()) < 2; tries++) {
      if (tries > 250) throw new Error('the two requests never waited for the reserve lock')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    release()
    await holder
    const responses = await results
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409])
    expect(responses.find((response) => response.statusCode === 409)!.json().error.issues[0].path).toBe('body/lines/0/refusal/NOT_AVAILABLE')
    expect((await availabilityOfLeather()).figures).toMatchObject({ reserved: '205.0000', available: '16.8000', overReserved: false })
  })

  it('reserves for an order line before its work order exists, with the line\'s promised date', async () => {
    const response = await reserve('warehouse', { salesOrderLineId: LINE.four, lines: [{ lotId: lots.LIN!.id, quantity: '12.5' }] })
    expect(response.statusCode, response.body).toBe(201)
    expect(response.json().reservations[0]).toMatchObject({ kind: 'QUANTITY', demand: { type: 'SalesOrderLine', seq: 10 }, needDate: '2026-12-10' })
  })

  it('is the office\'s, with inventory.reserve', async () => {
    expect((await reserve('viewer', { workOrderId: WO.one.id, lines: [{ lotId: lots.LIN!.id, quantity: '1' }] })).statusCode).toBe(403)
    expect((await reserve('floor', { workOrderId: WO.one.id, lines: [{ lotId: lots.LIN!.id, quantity: '1' }] })).statusCode).toBe(403)
    const bad = await refused('warehouse', 'POST', '/inventory/reservations', { siteId: A.siteA1, workOrderId: WO.one.id, salesOrderLineId: LINE.four, lines: [{ lotId: lots.LIN!.id, quantity: '1' }] }, 400)
    expect(bad.message).toMatch(/one work order or one order line/)
  })
})

describe('issues count against their own work order\'s reservations, never another\'s', () => {
  it('refuses on the floor a hide reserved for another work order, in words', async () => {
    const response = await issueTo(WO.one.id, { hideId: hides.H2 })
    expect(response.statusCode, response.body).toBe(409)
    expect(paths(response.json().error)).toEqual(['refusal/RESERVED_FOR_OTHER'])
    expect(response.json().error.message).toContain(`work order ${WO.two.number}`)
  })

  it('issues the reserved hide to its own work order: the reservation is ISSUED', async () => {
    const response = await issueTo(WO.two.id, { hideId: hides.H2 })
    expect(response.statusCode, response.body).toBe(201)
    const [row] = await admin<{ status: string; issued: string }>(`SELECT status::text, "issuedQuantity"::text AS issued FROM "Reservation" WHERE "hideId" = $1`, [hides.H2])
    expect(row).toEqual({ status: 'ISSUED', issued: '45.0000' })
  })

  it('an issue from the lot counts against the work order\'s AREA reservation; its undo gives it back', async () => {
    const issued = await issueTo(WO.one.id, { hideId: hides.H1 })
    expect(issued.statusCode, issued.body).toBe(201)
    const [row] = await admin<{ id: string; status: string; issued: string }>(`SELECT id, status::text, "issuedQuantity"::text AS issued FROM "Reservation" WHERE "workOrderId" = $1 AND kind = 'AREA'`, [WO.one.id])
    expect(row).toMatchObject({ status: 'ACTIVE', issued: '50.0000' })
    const undo = await call('floor', 'POST', `/inventory/picking/issues/${issued.json().issue.id}/undo`, {})
    expect(undo.statusCode, undo.body).toBe(201)
    const [back] = await admin<{ issued: string }>(`SELECT "issuedQuantity"::text AS issued FROM "Reservation" WHERE id = $1`, [row!.id])
    expect(back!.issued).toBe('0.0000')
  })

  it('takes free stock only up to what the other reservations leave', async () => {
    // WO.three holds 100 ft² of any lot: its own reservation covers H3 (40 ft²), counted against it.
    const response = await issueTo(WO.three.id, { hideId: hides.H3 })
    expect(response.statusCode, response.body).toBe(201)
    const [row] = await admin<{ issued: string }>(`SELECT "issuedQuantity"::text AS issued FROM "Reservation" WHERE "workOrderId" = $1`, [WO.three.id])
    expect(row!.issued).toBe('40.0000')
  })
})

describe('release (SCM-210) and stale reservations', () => {
  it('releases with the reason; again is refused in words; a reason is required', async () => {
    const list = await ok('warehouse', 'GET', `/inventory/reservations?workOrderId=${WO.one.id}&status=ACTIVE`)
    const target = list.reservations[0]
    expect((await refused('warehouse', 'POST', '/inventory/reservations/release', { reservations: [{ id: target.id, version: target.version }], reason: ' ' }, 400)).issues).toBeTruthy()
    const stale = await refused('warehouse', 'POST', '/inventory/reservations/release', { reservations: [{ id: target.id, version: target.version + 5 }], reason: 'Wrong lot' }, 409)
    expect(stale.message).toMatch(/changed since you read it/)
    const released = await ok('warehouse', 'POST', '/inventory/reservations/release', { reservations: [{ id: target.id, version: target.version }], reason: 'Customer moved the order' })
    expect(released.reservations[0]).toMatchObject({ status: 'RELEASED', releaseReason: 'Customer moved the order', open: '0.0000' })
    const again = await refused('warehouse', 'POST', '/inventory/reservations/release', { reservations: [{ id: target.id, version: released.reservations[0].version }], reason: 'Again' }, 409)
    expect(again.message).toMatch(/released already/)
    expect((await call('viewer', 'POST', '/inventory/reservations/release', { reservations: [{ id: target.id, version: 1 }], reason: 'x' })).statusCode).toBe(403)
  })

  it('a reservation of a cancelled work order holds nothing: it is stale until released', async () => {
    const workOrder = await releasedWorkOrder(await salesOrder('5'))
    expect((await reserve('warehouse', { workOrderId: workOrder.id, lines: [{ lotId: lots.LIN!.id, quantity: '30' }] })).statusCode).toBe(201)
    const lining = () => ok('warehouse', 'GET', `/inventory/reservations/availability?siteId=${A.siteA1}&itemId=${A.lining}&itemColourId=${A.liningGRY}`)
    expect((await lining()).figures).toMatchObject({ reserved: '42.5000', available: '177.5000' })
    const [current] = await admin<{ version: number }>(`SELECT version FROM "WorkOrder" WHERE id = $1`, [workOrder.id])
    await ok('planner', 'POST', `/production/work-orders/${workOrder.id}/cancel`, { version: current!.version, reason: 'Made-up cancellation' })
    const stale = await ok('warehouse', 'GET', `/inventory/reservations?stale=true&siteId=${A.siteA1}`)
    expect(stale.reservations.map((row: Json) => row.demand.id)).toEqual([workOrder.id])
    expect(stale.reservations[0]).toMatchObject({ stale: true, status: 'ACTIVE', demand: { status: 'CANCELLED' } })
    // It holds nothing any more: only the order line's 12.5 m is reserved.
    expect((await lining()).figures).toMatchObject({ reserved: '12.5000', available: '207.5000' })
    // A stale reservation is released like any other.
    expect((await ok('warehouse', 'POST', '/inventory/reservations/release', { reservations: [{ id: stale.reservations[0].id, version: stale.reservations[0].version }], reason: 'Work order cancelled' })).reservations[0].status).toBe('RELEASED')
  })
})

describe('write-off with a reason and a photo (SCM-193)', () => {
  let writeOffId = ''

  it('refuses a hide a reservation holds, an unknown reason, and OTHER without its note', async () => {
    await reserve('warehouse', { workOrderId: WO.two.id, lines: [{ hideId: hides.H4 }] })
    const held = await refused('warehouse', 'POST', '/inventory/write-offs', { siteId: A.siteA1, reasonCode: 'DAMAGED', note: 'Cut', lines: [{ hideId: hides.H4 }] }, 409)
    expect(held.message).toContain(`work order ${WO.two.number}`)
    expect(paths(await refused('warehouse', 'POST', '/inventory/write-offs', { siteId: A.siteA1, reasonCode: 'NO_SUCH', lines: [{ hideId: hides.H1 }] }, 400))).toEqual(['body/reasonCode'])
    expect(paths(await refused('warehouse', 'POST', '/inventory/write-offs', { siteId: A.siteA1, reasonCode: 'OTHER', lines: [{ hideId: hides.H1 }] }, 400))).toEqual(['body/note'])
    expect(paths(await refused('warehouse', 'POST', '/inventory/write-offs', { siteId: A.siteA1, reasonCode: 'DAMAGED', lines: [{ hideId: hides.H1, quantity: '3' }] }, 400))).toEqual(['body/lines/0/quantity'])
  })

  it('writes a hide off whole and some lining by quantity: SCRAP moves with the code, the hide SCRAPPED, valued (cost grain)', async () => {
    const response = await call('owner', 'POST', '/inventory/write-offs', { siteId: A.siteA1, reasonCode: 'DAMAGED', note: 'Water stain on the back', lines: [{ hideId: hides.H1 }, { lotId: lots.LIN!.id, fromLocationId: A.bin, quantity: '2.5' }] })
    expect(response.statusCode, response.body).toBe(201)
    const body = response.json()
    writeOffId = body.writeOff.id
    expect(body.writeOff).toMatchObject({ reasonCode: 'DAMAGED', reasonLabel: 'Damaged', note: 'Water stain on the back', hideIds: [hides.H1] })
    expect(body.writeOff.moves.map((move: Json) => [move.reason, move.note, move.toLocationId])).toEqual([
      ['SCRAP', 'DAMAGED: Water stain on the back', null],
      ['SCRAP', 'DAMAGED: Water stain on the back', null],
    ])
    expect(body.writeOff.values).toMatchObject({ valued: 2, moves: 2 })
    // H4 (35, reserved for WO.two) and WO.three's 60 ft² still to issue now exceed the 86.8 ft² left: said, not refused.
    expect(body.overReserved).toEqual([{ itemId: A.leather, itemColourId: A.leatherBLK, available: '-8.2000', reserved: '95.0000' }])
    expect(body.writeOff.values.byCurrency[0].amount).toBeGreaterThan(0)
    const [hide] = await admin<{ state: string }>(`SELECT state::text FROM "Hide" WHERE id = $1`, [hides.H1])
    expect(hide!.state).toBe('SCRAPPED')
    // The warehouse (no cost grain) reads it without any value.
    const record = await ok('warehouse', 'GET', `/inventory/write-offs/${writeOffId}`)
    expect(record.writeOff).toMatchObject({ reasonCode: 'DAMAGED', reasonLabel: { en: 'Damaged', it: 'Danneggiato' }, photos: [] })
    expect(keysOf(record).filter((key) => MONEY.test(key))).toEqual([])
  })

  it('shows in the ledger and its tiles; its hide scrap is not reversed; photos need files.upload', async () => {
    const ledger = await ok('warehouse', 'GET', `/inventory/ledger?siteId=${A.siteA1}&writeOffs=true`)
    expect(ledger.moves.length).toBe(2)
    expect(ledger.moves.every((move: Json) => move.writeOff?.id === writeOffId && move.writeOff.reasonCode === 'DAMAGED')).toBe(true)
    expect(ledger.rowCount).toBe(2)
    expect((await ok('warehouse', 'GET', `/inventory/ledger/counts?siteId=${A.siteA1}`)).writeOffs30d).toBe(2)
    const hideMove = ledger.moves.find((move: Json) => move.hide?.id === hides.H1)
    const reversal = await refused('warehouse', 'POST', `/inventory/moves/${hideMove.id}/reverse`, { note: 'Mistake' }, 409)
    expect(reversal.message).toMatch(/SCRAPPED for good/)
    const photo = await call('owner', 'POST', `/inventory/write-offs/${writeOffId}/photos`, { originalName: 'stain.jpg', contentType: 'image/jpeg', sizeBytes: 10, sha256: 'a'.repeat(64) })
    expect(photo.statusCode, photo.body).toBe(403)
    expect((await call('warehouse', 'POST', `/inventory/write-offs/${newId()}/photos`, { originalName: 'x.jpg', contentType: 'image/jpeg', sizeBytes: 10, sha256: 'a'.repeat(64) })).statusCode).toBe(404)
  })
})

describe('stock as of a date (SCM-197) and the searchable ledger (SCM-195)', () => {
  it('shows the stock before the write-off and the issues, with nothing held or reserved as of then', async () => {
    const asOf = toUtcIso(new Date(Date.now() - 10 * 86_400_000))
    const past = await ok('warehouse', 'GET', `/inventory/stock?siteId=${A.siteA1}&itemId=${A.leather}&asOf=${encodeURIComponent(asOf)}`)
    expect(past.asOf).toBe(asOf)
    expect(past.rows.find((row: Json) => row.hide?.id === hides.H1)).toMatchObject({ onHand: '50.0000', held: null, reserved: null, available: null })
    const now = await ok('warehouse', 'GET', `/inventory/stock?siteId=${A.siteA1}&itemId=${A.leather}`)
    expect(now.asOf).toBeNull()
    expect(now.rows.find((row: Json) => row.hide?.id === hides.H1)).toBeUndefined()
    // H4 is held by WO.two's HIDE reservation: its row says so.
    expect(now.rows.find((row: Json) => row.hide?.id === hides.H4)).toMatchObject({ onHand: '35.0000', reserved: '35.0000', available: '0.0000' })
    expect(now.reservations.length).toBeGreaterThan(0)
    const before = await ok('warehouse', 'GET', `/inventory/stock/explain?siteId=${A.siteA1}&itemId=${A.leather}&hideId=${hides.H1}&asOf=${encodeURIComponent(asOf)}`)
    expect(before).toMatchObject({ onHand: '50.0000', addsUp: true, asOf })
  })

  it('finds moves by a hide code, a lot code or a work order number, with the count for the long grid', async () => {
    const byHide = await ok('warehouse', 'GET', `/inventory/ledger?q=${encodeURIComponent(`T-${run}-H2`)}`)
    expect(byHide.moves.length).toBeGreaterThanOrEqual(2)
    expect(byHide.moves.every((move: Json) => move.hide?.code === `T-${run}-H2`)).toBe(true)
    const byOrder = await ok('warehouse', 'GET', `/inventory/ledger?q=${encodeURIComponent(WO.two.number)}`)
    expect(byOrder.moves.some((move: Json) => move.document?.number === WO.two.number)).toBe(true)
    const page = await ok('warehouse', 'GET', `/inventory/ledger?siteId=${A.siteA1}&limit=2`)
    expect(page.rowCount).toBeGreaterThan(2)
    const next = await ok('warehouse', 'GET', `/inventory/ledger?siteId=${A.siteA1}&limit=2&cursor=${page.nextCursor}`)
    expect(next.rowCount).toBeNull()
  })
})

describe('the warehouse every day: reserved hides and held stock (B-W2a-64)', () => {
  it('says which work order holds each hide, on the list, the Reserved view and tile, and the record', async () => {
    const reserved = await ok('warehouse', 'GET', `/inventory/hides?siteId=${A.siteA1}&reserved=true`)
    expect(reserved.hides.map((hide: Json) => hide.id)).toEqual([hides.H4])
    expect(reserved.hides[0].reservedFor).toMatchObject({ demand: { type: 'WorkOrder', id: WO.two.id, number: WO.two.number }, stale: false })
    expect(reserved.counts.reserved).toEqual({ hides: 1, area: [{ uom: 'FT2', quantity: '35.0000' }] })
    const all = await ok('warehouse', 'GET', `/inventory/hides?siteId=${A.siteA1}`)
    // Q1 was never reserved; H2's reservation was ISSUED with the hide: it holds nothing.
    expect(all.hides.find((hide: Json) => hide.id === hides.Q1).reservedFor).toBeNull()
    expect(all.hides.find((hide: Json) => hide.id === hides.H2).reservedFor).toBeNull()
    expect(all.counts.reserved.hides).toBe(1)
    const record = await ok('warehouse', 'GET', `/inventory/hides/${hides.H4}`)
    expect(record.hide.reservedFor).toMatchObject({ demand: { number: WO.two.number }, version: expect.any(Number) })
  })

  it('refuses to write off stock under a quality hold, in words, before anything moves', async () => {
    await ok('quality', 'POST', '/quality/holds', { subjectType: 'Lot', subjectIds: [lots.LIN!.id], reasonCode: 'QUALITY_CHECK' }, 201)
    await ok('quality', 'POST', '/quality/holds', { subjectType: 'Hide', subjectIds: [hides.Q1], reasonCode: 'QUALITY_CHECK' }, 201)
    const before = (await ok('warehouse', 'GET', `/inventory/ledger?siteId=${A.siteA1}&writeOffs=true`)).rowCount
    const lot = await refused('warehouse', 'POST', '/inventory/write-offs', { siteId: A.siteA1, reasonCode: 'DAMAGED', note: 'Stained', lines: [{ lotId: lots.LIN!.id, fromLocationId: A.bin, quantity: '1' }] }, 409)
    expect(paths(lot)).toEqual(['body/lines/0/refusal/QUALITY_HOLD'])
    expect(lot.message).toMatch(new RegExp(`^Lot T-${run}-LIN is on hold \\(Quality check, since [^)]+\\): its stock is not written off until quality releases the hold\\.$`))
    const hide = await refused('warehouse', 'POST', '/inventory/write-offs', { siteId: A.siteA1, reasonCode: 'DAMAGED', note: 'Torn', lines: [{ hideId: hides.Q1 }] }, 409)
    expect(paths(hide)).toEqual(['body/lines/0/refusal/QUALITY_HOLD'])
    expect(hide.message).toMatch(new RegExp(`^Hide T-${run}-Q1 is on hold \\(Quality check`))
    // Nothing moved, and the hide is still in stock as it was.
    expect((await ok('warehouse', 'GET', `/inventory/ledger?siteId=${A.siteA1}&writeOffs=true`)).rowCount).toBe(before)
    const [state] = await admin<{ state: string }>(`SELECT state::text FROM "Hide" WHERE id = $1`, [hides.Q1])
    expect(state!.state).toBe('FULL')
  })
})
