import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import { fixedClock } from '@nexus/factory-domain/core/time'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { runNightlyPlans } from './nightly'
import { readinessFor } from './readiness/service'

/**
 * MRP every day (B-W2a-22; PLN-071 pegging, PLN-075 firm planned orders, PLN-085 the shortage list with its fixes,
 * PLN-086 material readiness, PLN-193 the exception list per run, the nightly run and "out of date since the run") on
 * the local stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login,
 * so row-level security, the grants and the …_stock_plan_w2a_guards triggers — pegging append-only, the firm columns,
 * the exceptions' life — are real), the factory-db seeds of two tenants up to production (W1's planning seeds:
 * SEED-SO-0002 BLK 1/2/1 RED 1/1/1 for 4 Dec on WO-0001 (53.2 ft² issued) and the DRAFT WO-0002 (BLK 52),
 * SEED-SO-0001 BLK 2/4/2 RED 1/2/1 for 18 Dec, SEED-HIDE-0002 of 51.8 ft² usable, PO1's 315 ft² of black leather open
 * and 24 protectors confirmed for 13 Nov, PO2's draft of 10 protectors for 1 Dec). Every name and number is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/planning/mrp`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = { a: 'mrp-a', b: 'mrp-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const A = {
  tenant: idOf(ns.a, 'tenant'),
  actor: idOf(ns.a, 'actor'),
  companyA: idOf(ns.a, 'company:A'),
  companyB: idOf(ns.a, 'company:B'),
  siteA1: idOf(ns.a, 'site:A1'),
  supplier: idOf(ns.a, 'party:P2'),
  leather: idOf(ns.a, 'product:item:leather'),
  leatherBLK: idOf(ns.a, 'product:item-colour:leather:BLK'),
  leatherRED: idOf(ns.a, 'product:item-colour:leather:RED'),
  jkt01: idOf(ns.a, 'product:style:JKT-01'),
  jkt01Rev: idOf(ns.a, 'product:revision:JKT-01:1'),
  hide2: idOf(ns.a, 'inventory:hide:H2'),
  po1Leather: idOf(ns.a, 'supply:PO1:10'),
  so1Red: idOf(ns.a, 'sales:SO1:line:20'),
  store: idOf(ns.a, 'inventory:location:A1-STORE-01'),
}
const B = { tenant: idOf(ns.b, 'tenant') }

const MRP: Permission[] = ['planning.view', 'planning.run', 'planning.decide', 'planning.firm', 'planning.exceptions.manage']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (tenantId: string, grants: Grant[], actorId = newId()): SessionContext => ({ audience: 'office', tenantId, actorId, grants })
const PLANNER_ID = newId()
const SESSIONS: Record<string, SessionContext> = {
  planner: office(A.tenant, [grant([...MRP, 'inventory.stock.view', 'inventory.reserve', 'workorders.view', 'workorders.manage'])], PLANNER_ID),
  buyer: office(A.tenant, [grant([...MRP, 'money.cost'])]),
  viewer: office(A.tenant, [grant(['planning.view'])]),
  companyB: office(A.tenant, [grant(MRP, [A.companyB])]),
  otherTenant: office(B.tenant, [grant(MRP)]),
  floor: { audience: 'floor', tenantId: A.tenant, actorId: newId(), siteId: A.siteA1, deviceId: newId(), grants: [grant(['floor.work', ...MRP], [A.companyA], [A.siteA1])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const key = () => `mrp-test-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown, idempotencyKey?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, idempotencyKey?: string): Promise<Json> {
  const response = await call(session, method, url, payload, idempotencyKey)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const runPlan = () => ok('planner', 'POST', '/planning/runs', { siteId: A.siteA1 }, 201)
const latest = (session = 'planner') => ok(session, 'GET', `/planning/runs/latest?siteId=${A.siteA1}`)
const lineOf = (plan: Json, itemId: string, itemColourId: string | null): Json => {
  const line = (plan.lines as Json[]).find((entry) => entry.item.id === itemId && (entry.colour?.id ?? null) === itemColourId)
  expect(line, `no line for ${itemId} ${itemColourId}`).toBeDefined()
  return line!
}
const sum = (values: readonly string[]) => values.reduce((total, value) => total + Math.round(Number(value) * 10_000), 0) / 10_000
const supplies = (demands: Json[]) => demands.flatMap((demand) => demand.supplies as Json[])
const workOrderId = async (number: string) => (await admin<{ id: string }>(`SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND number = $2`, [A.tenant, number]))[0]!.id
const exceptionsOf = async (query = '') => ok('planner', 'GET', `/planning/exceptions?siteId=${A.siteA1}${query}`)
const exceptionOf = (list: Json, kind: string, predicate: (row: Json) => boolean = () => true): Json | undefined => (list.exceptions as Json[]).find((row) => row.kind === kind && predicate(row))

/** A DRAFT purchase order of A1 to the supplier with one line of leather. */
async function draftPurchase(number: string, colourId: string, baseQuantity: string, needDate: string) {
  const orderId = newId()
  const lineId = newId()
  await admin(`INSERT INTO "PurchaseOrder" (id, "tenantId", "companyId", "siteId", number, "partyId", "orderDate") VALUES ($1, $2, $3, $4, $5, $6, '2026-10-29')`, [orderId, A.tenant, A.companyA, A.siteA1, number, A.supplier])
  await admin(
    `INSERT INTO "PurchaseOrderLine" (id, "tenantId", "purchaseOrderId", "partyId", "siteId", seq, "itemId", "itemColourId", quantity, uom, "baseQuantity", "unitPrice", "netAmount", "needDate", "requiresCrViTest")
     VALUES ($1, $2, $3, $4, $5, 10, $6, $7, $8, 'FT2', $8, '0', 0, $9, true)`,
    [lineId, A.tenant, orderId, A.supplier, A.siteA1, A.leather, colourId, baseQuantity, needDate],
  )
  return { orderId, lineId }
}

beforeAll(async () => {
  db = await migratedDatabase('mrp')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  for (const namespace of [ns.a, ns.b]) await seedCore({ db: database, namespace })
  await seedProduction({ db: database, namespace: ns.a })
  await seedProduction({ db: database, namespace: ns.b })
  await seedNumbering({ db: database, namespace: ns.a })
  // SEED-JKT-01's revision released: SEED-SO-0001 is planned too.
  await admin(`UPDATE "Style" SET status = 'ACTIVE' WHERE id = $1`, [A.jkt01])
  await admin(`UPDATE "StyleRevision" SET status = 'RELEASED', "releasedAt" = now(), "releasedById" = $2 WHERE id = $1`, [A.jkt01Rev, A.actor])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('pegging: every demand part to the supply that covers it (PLN-071)', () => {
  it('a run pegs each order line, size and work order; the rows add up to the gross, the planned ones to the net', async () => {
    const { run: planRun } = await runPlan()
    const black = lineOf(await latest(), A.leather, A.leatherBLK)
    expect(black).toMatchObject({ grossQuantity: '553.2800', usableStock: '51.8000', onOrder: '315.0000', netQuantity: '186.4800', firm: null })
    const { run, demands } = await ok('viewer', 'GET', `/planning/pegging?requirementId=${black.id}`)
    expect(run).toMatchObject({ id: planRun.id, status: 'DONE' })
    expect(sum(demands.map((demand: Json) => demand.quantity))).toBe(553.28)
    expect(sum(demands.map((demand: Json) => demand.planned))).toBe(186.48)
    const all = supplies(demands)
    expect(sum(all.filter((row) => row.kind === 'STOCK').map((row) => row.quantity))).toBe(51.8)
    expect(sum(all.filter((row) => row.kind === 'PURCHASE_ORDER').map((row) => row.quantity))).toBe(315)
    expect(all.filter((row) => row.kind === 'PURCHASE_ORDER').every((row) => row.purchaseOrder?.lineId === A.po1Leather && row.purchaseOrder.number === 'SEED-PO-0001' && row.date === '2026-11-13')).toBe(true)
    expect(all.filter((row) => row.kind === 'PLANNED').every((row) => row.date === black.needDate && row.firm === false)).toBe(true)
    // The earliest order (SEED-SO-0002, 4 Dec) takes the stock; its open work orders are named with the line they make.
    expect(demands[0]).toMatchObject({ order: { number: 'SEED-SO-0002' }, demandDate: '2026-12-04' })
    expect(demands[0].supplies[0]).toMatchObject({ kind: 'STOCK' })
    const onWorkOrders = demands.filter((demand: Json) => demand.kind === 'WORK_ORDER')
    expect(onWorkOrders.length).toBeGreaterThan(0)
    expect(onWorkOrders.every((demand: Json) => demand.workOrder?.number?.startsWith('SEED-WO-') && demand.orderLine?.id && demand.size)).toBe(true)
    expect(demands.filter((demand: Json) => demand.order.number === 'SEED-SO-0001').every((demand: Json) => demand.kind === 'ORDER_LINE' && demand.workOrder === null)).toBe(true)
    // The Why drawer carries the same tree.
    expect((await ok('viewer', 'GET', `/planning/requirements/${black.id}`)).pegging).toEqual(demands)
  })

  it('across many orders: which orders a purchase order line serves, and what an order line counts on', async () => {
    const { demands } = await ok('viewer', 'GET', `/planning/pegging?siteId=${A.siteA1}&purchaseOrderLineId=${A.po1Leather}`)
    expect(new Set(demands.map((demand: Json) => demand.order.number))).toEqual(new Set(['SEED-SO-0002', 'SEED-SO-0001']))
    expect(supplies(demands).every((row) => row.kind === 'PURCHASE_ORDER')).toBe(true)
    // An order line's demands over every material it takes (leather, lining, protectors), each with its supply.
    const { demands: line } = await ok('viewer', 'GET', `/planning/pegging?siteId=${A.siteA1}&salesOrderLineId=${A.so1Red}`)
    expect(line.every((demand: Json) => demand.orderLine.id === A.so1Red && demand.order.number === 'SEED-SO-0001')).toBe(true)
    expect(new Set(line.map((demand: Json) => demand.requirementId)).size).toBeGreaterThanOrEqual(3)
    expect(supplies(line).map((row) => row.kind)).toContain('PLANNED')
    expect((await refused('viewer', 'GET', `/planning/pegging?siteId=${A.siteA1}`, undefined, 400)).message).toMatch(/Name one of/)
  })

  it('pegging is append-only: the run writes it once, nobody changes it', async () => {
    await expect(admin(`UPDATE "RequirementPegging" SET quantity = quantity + 1 WHERE "tenantId" = $1`, [A.tenant])).rejects.toThrow(/append-only/)
    await expect(admin(`DELETE FROM "RequirementPegging" WHERE "tenantId" = $1`, [A.tenant])).rejects.toThrow(/append-only/)
  })
})

describe('reservations hold stock for their own demand (B-W2a-11 in the netting)', () => {
  it('a hide reserved for WO-0001 covers WO-0001 (not the earliest order); pegging names the reservation', async () => {
    const wo1 = await workOrderId('SEED-WO-0001')
    const { reservations } = await ok('planner', 'POST', '/inventory/reservations', { siteId: A.siteA1, workOrderId: wo1, lines: [{ hideId: A.hide2 }] }, 201)
    const reservationId = reservations[0].id
    await runPlan()
    const black = lineOf(await latest(), A.leather, A.leatherBLK)
    expect(black).toMatchObject({ usableStock: '51.8000', netQuantity: '186.4800' })
    const { demands } = await ok('viewer', 'GET', `/planning/pegging?requirementId=${black.id}`)
    const reserved = supplies(demands).filter((row) => row.kind === 'RESERVATION')
    expect(sum(reserved.map((row) => row.quantity))).toBe(51.8)
    expect(reserved.every((row) => row.reservation?.id === reservationId && row.reservation.hide?.id === A.hide2)).toBe(true)
    expect(demands.filter((demand: Json) => demand.supplies.some((row: Json) => row.kind === 'RESERVATION')).every((demand: Json) => demand.workOrder?.id === wo1)).toBe(true)
    expect(sum(supplies(demands).filter((row) => row.kind === 'STOCK').map((row) => row.quantity))).toBe(0)
    const why = await ok('viewer', 'GET', `/planning/requirements/${black.id}`)
    expect(why.now).toMatchObject({ reservedForOthers: '0.0000', usableStock: '51.8000', netQuantity: '186.4800', changedSinceRun: false })
    expect(why.pegging).toEqual(demands)
  })
})

describe('firm planned orders (PLN-075)', () => {
  let redFirm: Json
  it('a planner makes a line of the latest plan firm; it is audited and refused when stale, past, or not allowed', async () => {
    const red = lineOf(await latest(), A.leather, A.leatherRED)
    expect(red).toMatchObject({ action: 'BUY', netQuantity: '353.9200', suggestedQuantity: '7.0000', suggestedUom: 'HIDE', needDate: '2026-12-04' })
    await refused('viewer', 'POST', `/planning/requirements/${red.id}/firm`, { version: red.version, quantity: '4', date: '2026-12-10' }, 403)
    expect((await refused('planner', 'POST', `/planning/requirements/${red.id}/firm`, { version: red.version, quantity: '4', date: '2020-01-01' }, 400)).message).toMatch(/not dated in the past/)
    expect((await refused('planner', 'POST', `/planning/requirements/${red.id}/firm`, { version: red.version, quantity: '0', date: '2026-12-10' }, 400)).message).toMatch(/above 0/)
    expect((await refused('planner', 'POST', `/planning/requirements/${red.id}/firm`, { version: red.version + 5, quantity: '4', date: '2026-12-10' }, 409)).message).toMatch(/changed since it was read/)
    const { line } = await ok('planner', 'POST', `/planning/requirements/${red.id}/firm`, { version: red.version, quantity: '4', date: '2026-12-10' }, 200, key())
    expect(line.firm).toMatchObject({ quantity: '4.0000', uom: 'HIDE', baseQuantity: '210.0000', date: '2026-12-10', supplier: { id: A.supplier }, carried: false })
    expect(line.version).toBe(red.version + 1)
    expect((await latest()).summary.firm).toBe(1)
    expect(await admin(`SELECT action, after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'planning.firm'`, [red.id])).toEqual([{ action: 'planning.firm', after: { firmQuantity: '4.0000', firmBaseQuantity: '210.0000', firmDate: '2026-12-10', firmSupplierId: A.supplier } }])
    expect(await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'planning.requirement_firmed' AND payload->>'requirementId' = $1`, [red.id])).toEqual([{ payload: { runId: red.runId, siteId: A.siteA1, requirementId: red.id, firm: true } }])
    redFirm = line
  })

  it('the next run carries it as planned supply and plans only the rest; a firm order dated after a need is MOVE_EARLIER', async () => {
    await runPlan()
    const red = lineOf(await latest(), A.leather, A.leatherRED)
    expect(red.id).not.toBe(redFirm.id)
    expect(red.firm).toMatchObject({ quantity: '4.0000', uom: 'HIDE', baseQuantity: '210.0000', date: '2026-12-10', carried: true, firmedAt: redFirm.firm.firmedAt })
    // The plan still says its own suggestion for the whole net need (7 hides); the buyer buys the firm 4 (B-W2a-10), and
    // what the firm order does not cover (353.92 − 210 = 143.92) is a SHORT exception.
    expect(red).toMatchObject({ netQuantity: '353.9200', suggestedQuantity: '7.0000', suggestedUom: 'HIDE' })
    const { demands } = await ok('viewer', 'GET', `/planning/pegging?requirementId=${red.id}`)
    const planned = supplies(demands).filter((row) => row.kind === 'PLANNED')
    expect(sum(planned.filter((row) => row.date === '2026-12-10').map((row) => row.quantity))).toBe(210)
    expect(planned.every((row) => row.firm === true)).toBe(true)
    const list = await exceptionsOf()
    expect(exceptionOf(list, 'MOVE_EARLIER', (row) => row.colour?.id === A.leatherRED)).toMatchObject({ daysLate: 6, facts: { supplyDate: '2026-12-10', needDate: '2026-12-04', quantity: '151.7600' } })
    expect(exceptionOf(list, 'SHORT', (row) => row.colour?.id === A.leatherRED)).toMatchObject({ status: 'NEW', facts: { quantity: '143.9200', uom: 'FT2' }, requirementId: red.id })
    // A superseded plan's line is not made firm.
    expect((await refused('planner', 'POST', `/planning/requirements/${redFirm.id}/firm`, { version: redFirm.version, quantity: '4', date: '2026-12-10' }, 409)).message).toMatch(/newer plan replaced/)
  })

  it('a carried firm order is made planned again; the next run plans it freely', async () => {
    const red = lineOf(await latest(), A.leather, A.leatherRED)
    const { line } = await ok('planner', 'POST', `/planning/requirements/${red.id}/unfirm`, { version: red.version })
    expect(line.firm).toBeNull()
    expect((await refused('planner', 'POST', `/planning/requirements/${red.id}/unfirm`, { version: line.version }, 409)).message).toBe('The line is not firm.')
    await runPlan()
    expect(lineOf(await latest(), A.leather, A.leatherRED)).toMatchObject({ firm: null, suggestedQuantity: '7.0000' })
  })
})

describe('readiness and the shortage list (PLN-086, PLN-085)', () => {
  it('one readiness word per work order, with the reason: the worst material decides; an over-planned draft is NOT_PLANNED', async () => {
    const wo1 = await workOrderId('SEED-WO-0001')
    const wo2 = await workOrderId('SEED-WO-0002')
    const answer = await ok('viewer', 'GET', `/planning/readiness?siteId=${A.siteA1}`)
    const row = (answer.workOrders as Json[]).find((entry) => entry.workOrder.id === wo1)!
    // Black leather: the reserved hide, the rest on PO1 (13 Nov) before the order's 4 Dec.
    expect(row.materials.find((material: Json) => material.itemColourId === A.leatherBLK)).toMatchObject({ word: 'EXPECTED', date: '2026-11-13', reserved: '51.8000', short: '0.0000' })
    // Its red leather (SEED-SO-0002 line 20) has nothing ordered: the worst material decides.
    expect(row.materials.find((material: Json) => material.itemColourId === A.leatherRED)).toMatchObject({ word: 'NOT_ENOUGH' })
    expect(row).toMatchObject({ word: 'NOT_ENOUGH', label: 'Not enough', reason: expect.stringMatching(/^SEED-LEA-100 RED: .* short and nothing ordered for it yet\. \d+ more materials? needs? attention\.$/) })
    // WO-0002's one BLK 52 is over the order's two, which WO-0001 makes: the plan has no need for it.
    expect((answer.workOrders as Json[]).find((entry) => entry.workOrder.id === wo2)).toMatchObject({ word: 'NOT_PLANNED', materials: [] })
    expect(answer.counts.NOT_ENOUGH).toBeGreaterThan(0)
    const one = await ok('viewer', 'GET', `/planning/work-orders/${wo1}/readiness`)
    expect(one.readiness).toEqual(row)
    // The function B-W2a-46 and B-W2a-58 call, on their own client.
    const site = await database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) => client.site.findUniqueOrThrow({ where: { id: A.siteA1 }, select: { id: true, companyId: true, code: true, name: true, kind: true, status: true, timezone: true } }))
    const direct = await database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) => readinessFor(client, site, [wo1, newId()]))
    expect(direct.map((entry) => entry.word)).toEqual([row.word, 'NOT_PLANNED'])
  })

  it('a work order short of material is listed with its fixes: Buy from the plan, Expedite a late purchase order', async () => {
    const created = await ok('planner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: A.so1Red }] }, 201)
    const workOrder = created.workOrder ?? created
    await runPlan()
    const red = lineOf(await latest(), A.leather, A.leatherRED)
    let list = await ok('viewer', 'GET', `/planning/shortages?siteId=${A.siteA1}`)
    let row = (list.rows as Json[]).find((entry) => entry.workOrder.id === workOrder.id && entry.material.itemColourId === A.leatherRED)
    expect(row).toMatchObject({ word: 'NOT_ENOUGH', neededBy: '2026-12-18', expected: null })
    expect(Number(row!.short)).toBeGreaterThan(0)
    expect(row!.fixes).toEqual([{ kind: 'BUY', requirementId: red.id, purchaseOrder: null, words: expect.stringMatching(/^Buy SEED-LEA-100 RED/) }])
    // A purchase line for after the need: the work order waits for it (DELAYED), and it is to chase.
    const late = await draftPurchase('MRP-PO-LATE', A.leatherRED, '300.0000', '2027-01-15')
    await runPlan()
    list = await ok('viewer', 'GET', `/planning/shortages?siteId=${A.siteA1}`)
    row = (list.rows as Json[]).find((entry) => entry.workOrder.id === workOrder.id && entry.material.itemColourId === A.leatherRED)
    expect(row).toMatchObject({ word: 'DELAYED', expected: { date: '2027-01-15', purchaseOrderNumber: 'MRP-PO-LATE' } })
    expect(row!.fixes.map((fix: Json) => fix.kind)).toEqual(['BUY', 'EXPEDITE'])
    expect(row!.fixes[1]).toMatchObject({ purchaseOrder: { id: late.orderId, number: 'MRP-PO-LATE', lineId: late.lineId, dueDate: '2027-01-15' } })
    const exceptions = await exceptionsOf()
    expect(exceptionOf(exceptions, 'SUPPLY_LATE')).toMatchObject({ record: { type: 'PurchaseOrder', id: late.orderId, label: 'MRP-PO-LATE' }, facts: { supplyDate: '2027-01-15', needDate: '2026-12-04', purchaseOrderNumber: 'MRP-PO-LATE' }, daysLate: 42 })
  })
})

describe('the exception list of each run (PLN-193)', () => {
  it('acknowledged stays acknowledged across runs; snoozed until the next run wakes; resolved comes back as a new occurrence', async () => {
    let list = await exceptionsOf()
    const short = exceptionOf(list, 'SHORT', (row) => row.colour?.id === A.leatherRED)!
    expect(short).toMatchObject({ status: 'NEW', occurrence: 1, mine: false, owner: null, sentence: expect.stringMatching(/short/) })
    expect(list.tiles.new).toBeGreaterThanOrEqual(1)
    await refused('viewer', 'POST', '/planning/exceptions/acknowledge', { exceptions: [{ id: short.id, version: short.version }] }, 403)
    const acknowledged = await ok('planner', 'POST', '/planning/exceptions/acknowledge', { exceptions: [{ id: short.id, version: short.version }] })
    expect(acknowledged.exceptions[0]).toMatchObject({ status: 'ACKNOWLEDGED', mine: true, owner: { id: PLANNER_ID }, acknowledgedBy: { id: PLANNER_ID } })
    expect((await refused('planner', 'POST', '/planning/exceptions/acknowledge', { exceptions: [{ id: short.id, version: acknowledged.exceptions[0].version }] }, 409)).message).toBe('The exception is acknowledged already.')
    expect((await exceptionsOf('&mine=true')).exceptions.map((row: Json) => row.id)).toEqual([short.id])

    const before = await runPlan()
    list = await exceptionsOf()
    const again = exceptionOf(list, 'SHORT', (row) => row.colour?.id === A.leatherRED)!
    expect(again).toMatchObject({ id: short.id, status: 'ACKNOWLEDGED', lastRunId: before.run.id, firstRunId: short.firstRunId })

    const snoozed = await ok('planner', 'POST', `/planning/exceptions/${short.id}/snooze`, { version: again.version, until: null })
    expect(snoozed.exception).toMatchObject({ snoozed: true, snoozedUntil: null })
    expect((await exceptionsOf('&snoozed=true')).exceptions.map((row: Json) => row.id)).toContain(short.id)
    await runPlan()
    expect((await ok('viewer', 'GET', `/planning/exceptions/${short.id}`)).exception).toMatchObject({ snoozed: false, snoozedAt: null, status: 'ACKNOWLEDGED' })
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString()
    const later = await ok('planner', 'POST', `/planning/exceptions/${short.id}/snooze`, { version: (await ok('viewer', 'GET', `/planning/exceptions/${short.id}`)).exception.version, until: tomorrow })
    expect(later.exception).toMatchObject({ snoozed: true })
    expect((await refused('planner', 'POST', `/planning/exceptions/${short.id}/snooze`, { version: later.exception.version, until: '2020-01-01T00:00:00Z' }, 400)).message).toMatch(/later moment/)

    expect((await refused('planner', 'POST', `/planning/exceptions/${short.id}/resolve`, { version: later.exception.version, note: ' ' }, 400)).message).toMatch(/how it was handled/)
    const resolved = await ok('planner', 'POST', `/planning/exceptions/${short.id}/resolve`, { version: later.exception.version, note: 'Hides promised by phone for 2 Dec.' })
    expect(resolved.exception).toMatchObject({ status: 'RESOLVED', resolution: 'HANDLED', resolveNote: 'Hides promised by phone for 2 Dec.', resolvedBy: { id: PLANNER_ID } })
    expect(await admin(`SELECT action FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at`, [short.id])).toEqual([{ action: 'planning.acknowledgeException' }, { action: 'planning.snoozeException' }, { action: 'planning.snoozeException' }, { action: 'planning.resolveException' }])
    await runPlan()
    list = await exceptionsOf()
    const back = exceptionOf(list, 'SHORT', (row) => row.colour?.id === A.leatherRED)!
    expect(back).toMatchObject({ status: 'NEW', occurrence: 2 })
    expect(back.id).not.toBe(short.id)
  })

  it('a condition the run no longer finds is CLEARED by the run, with no person and no note', async () => {
    const late = exceptionOf(await exceptionsOf(), 'SUPPLY_LATE')!
    // The late purchase line is asked earlier now: it arrives in time.
    await admin(`UPDATE "PurchaseOrderLine" SET "needDate" = '2026-11-20' WHERE "purchaseOrderId" = $1`, [late.record.id])
    const { run: clearing } = await runPlan()
    const cleared = (await ok('viewer', 'GET', `/planning/exceptions/${late.id}`)).exception
    expect(cleared).toMatchObject({ status: 'RESOLVED', resolution: 'CLEARED', resolvedBy: null, resolveNote: null })
    expect(exceptionOf(await exceptionsOf(), 'SUPPLY_LATE')).toBeUndefined()
    const found = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'planning.exceptions_found' AND subject = $1`, [clearing.id])
    expect(found[0]!.payload).toMatchObject({ runId: clearing.id, siteId: A.siteA1, cleared: expect.any(Number) })
    expect(found[0]!.payload.cleared).toBeGreaterThanOrEqual(1)
    // Exceptions are resolved, never deleted.
    await expect(admin(`DELETE FROM "PlanningException" WHERE id = $1`, [late.id])).rejects.toThrow(/never deleted/)
  })
})

describe('out of date since the run, and the nightly run', () => {
  it('says what changed at the site after the plan finished', async () => {
    // (The seeds' records are dated in the seeds' future: they show as changed since any run made today.)
    await runPlan()
    const lotId = newId()
    await admin(
      `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "qualityStatus", "requiresCrViTest", "crViLimitMgKg", "crViStatus", "crViMgKg", "crViEvidence", "crViTestedAt")
       VALUES ($1, $2, $3, $4, $5, $6, 'MRP-LOT-Q', 'QUARANTINE', true, 3, 'PASS', '1.100', 'LOT_REPORT', '2026-11-01')`,
      [lotId, A.tenant, A.companyA, A.siteA1, A.leather, A.leatherBLK],
    )
    // Blocked after the plan finished (a made-up recall).
    await admin(`UPDATE "Lot" SET "qualityStatus" = 'BLOCKED', "qualityDecidedAt" = now() + interval '1 second', "qualityNote" = 'Made-up recall' WHERE id = $1`, [lotId])
    expect((await latest()).outOfDate).toMatchObject({ lotsHeld: [{ id: lotId, code: 'MRP-LOT-Q' }], ordersConfirmed: expect.any(Array), receiptsPosted: expect.any(Array) })
  })

  it('the scheduler runs each site at its nightly time, once a day, as the system', async () => {
    await admin(`INSERT INTO "PlanningSettings" (id, "tenantId", "companyId", "siteId", "scheduledRunTime") VALUES ($1, $2, $3, $1, '00:00') ON CONFLICT (id) DO UPDATE SET "scheduledRunTime" = '00:00'`, [A.siteA1, A.tenant, A.companyA])
    const log = { info: () => undefined, warn: () => undefined, error: () => undefined }
    const clock = fixedClock(new Date())
    const first = await runNightlyPlans({ database, log, clock })
    expect(first).toMatchObject({ due: 1, ran: 1, failed: 0 })
    const scheduled = await admin(`SELECT status, "createdById" FROM "PlanningRun" WHERE "siteId" = $1 AND trigger = 'SCHEDULED'`, [A.siteA1])
    expect(scheduled).toEqual([{ status: 'DONE', createdById: null }])
    expect(await runNightlyPlans({ database, log, clock })).toMatchObject({ due: 0, ran: 0 })
    expect((await latest()).run).toMatchObject({ trigger: 'SCHEDULED', createdById: null })
  })
})

describe('walls (A1 §2.2): tenant, company, audience', () => {
  it('another tenant or company does not see the new routes; the floor has none', async () => {
    const red = lineOf(await latest(), A.leather, A.leatherRED)
    await refused('otherTenant', 'GET', `/planning/pegging?requirementId=${red.id}`, undefined, 404)
    await refused('companyB', 'POST', `/planning/requirements/${red.id}/firm`, { version: red.version, quantity: '1', date: '2026-12-31' }, 404)
    await refused('companyB', 'GET', `/planning/exceptions?siteId=${A.siteA1}`, undefined, 404)
    await refused('otherTenant', 'GET', `/planning/readiness?siteId=${A.siteA1}`, undefined, 404)
    for (const url of [`/planning/readiness?siteId=${A.siteA1}`, `/planning/shortages?siteId=${A.siteA1}`, `/planning/exceptions?siteId=${A.siteA1}`, `/planning/pegging?requirementId=${red.id}`]) {
      await refused('floor', 'GET', url, undefined, 403)
    }
    // No money anywhere in the new answers, even for a buyer with the cost grain.
    const text = JSON.stringify([await ok('buyer', 'GET', `/planning/shortages?siteId=${A.siteA1}`), await ok('buyer', 'GET', `/planning/exceptions?siteId=${A.siteA1}`), await ok('buyer', 'GET', `/planning/readiness?siteId=${A.siteA1}`)])
    expect(text).not.toMatch(/unitPrice|unitCost|amount|EUR/)
  })
})
