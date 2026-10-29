import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedProduction } from '../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { callerFor, command } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { orderRequirement, proposalFor, unorderRequirement } from './hooks'
import { usePlanningRunTimeout } from './run'

/**
 * What to buy and make (B-W1-29; PLN-062 to PLN-066; REACH Annex XVII entry 47) on the local stack, with the app's real
 * routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login, so row-level security, the column
 * grants and the …_supply_guards triggers are real), the factory-db seeds of two tenants up to production (SEED-SO-0001
 * of SEED-JKT-01 BLK 2/4/2 RED 1/2/1 for 18 Dec; SEED-SO-0002 of SEED-JKT-02 BLK 1/2/1 RED 1/1/1 for 4 Dec on
 * WO-0001, which was issued hide SEED-HIDE-0001 of 53.2 ft²; lot SEED-LOT-LEA-01 RELEASED with SEED-HIDE-0002 of 51.8 ft²
 * left; 120 m of lining; PO1's 420 ft² of black leather (105 received) and 24 protectors, confirmed for 13 Nov; PO2's
 * draft of 10 protectors for 1 Dec), and sessions from the test authenticator. Every name and number is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs planning`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = { a: 'planning-a', b: 'planning-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const A = {
  tenant: idOf(ns.a, 'tenant'),
  actor: idOf(ns.a, 'actor'),
  companyA: idOf(ns.a, 'company:A'),
  companyB: idOf(ns.a, 'company:B'),
  siteA1: idOf(ns.a, 'site:A1'),
  siteB1: idOf(ns.a, 'site:B1'),
  supplier: idOf(ns.a, 'party:P2'),
  brand: idOf(ns.a, 'party:P1'),
  leather: idOf(ns.a, 'product:item:leather'),
  lining: idOf(ns.a, 'product:item:lining'),
  protector: idOf(ns.a, 'product:item:protector'),
  leatherBLK: idOf(ns.a, 'product:item-colour:leather:BLK'),
  leatherRED: idOf(ns.a, 'product:item-colour:leather:RED'),
  jkt01: idOf(ns.a, 'product:style:JKT-01'),
  jkt01Rev: idOf(ns.a, 'product:revision:JKT-01:1'),
  store: idOf(ns.a, 'inventory:location:A1-STORE-01'),
  seededRun: idOf(ns.a, 'supply:run:1'),
}
const B = { tenant: idOf(ns.b, 'tenant'), siteA1: idOf(ns.b, 'site:A1') }

const PLANNING: Permission[] = ['planning.view', 'planning.run', 'planning.decide']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  planner: office(A.tenant, [grant(PLANNING)]),
  buyer: office(A.tenant, [grant([...PLANNING, 'money.cost'])]),
  viewer: office(A.tenant, [grant(['planning.view'])]),
  companyB: office(A.tenant, [grant(PLANNING, [A.companyB])]),
  otherSite: office(A.tenant, [grant(PLANNING, [A.companyA], [idOf(ns.a, 'site:A2')])]),
  otherTenant: office(B.tenant, [grant(PLANNING)]),
  noPlanning: office(A.tenant, [grant(['inventory.stock.view'])]),
  floor: { audience: 'floor', tenantId: A.tenant, actorId: newId(), siteId: A.siteA1, deviceId: newId(), grants: [grant(['floor.work', ...PLANNING], [A.companyA], [A.siteA1])] },
  partner: { audience: 'partner', tenantId: A.tenant, actorId: newId(), partyId: A.supplier, grants: [grant(PLANNING)] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
let keys = 0
const run = randomBytes(4).toString('hex')
const key = () => `planning-test-${run}-${++keys}`
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
const runPlan = (session = 'planner') => ok(session, 'POST', '/planning/runs', { siteId: A.siteA1 }, 201)
const latest = (session = 'planner', query = '') => ok(session, 'GET', `/planning/runs/latest?siteId=${A.siteA1}${query}`)
const lineOf = (plan: Json, itemId: string, itemColourId: string | null = null): Json => {
  const line = (plan.lines as Json[]).find((entry) => entry.item.id === itemId && (entry.colour?.id ?? null) === itemColourId)
  expect(line, `no line for ${itemId} ${itemColourId}`).toBeDefined()
  return line!
}
/** Holds the site's planning lock in another session, as a run that is going does. */
function holdPlanningLock(tenantId: string, siteId: string) {
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  let locked!: () => void
  const holding = new Promise<void>((resolve) => (locked = resolve))
  const holder = database.withScope({ audience: 'office', tenantId, actorId: newId() }, (client) =>
    client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.planning-run', ${tenantId}::uuid, ${siteId}::uuid), 0))`
        locked()
        await released
      },
      { timeout: 20_000 },
    ),
  )
  return { holding, release: async () => (release(), await holder) }
}

/** A lot of leather at A1's store with one hide, in quarantine (Cr VI pending) or blocked after release. */
async function leatherLot(code: string, colourId: string, area: string, state: 'CR_VI_PENDING' | 'BLOCKED') {
  const lotId = newId()
  const hideId = newId()
  const pass = state === 'BLOCKED'
  await admin(
    `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "qualityStatus", "requiresCrViTest", "crViLimitMgKg", "crViStatus", "crViMgKg", "crViEvidence", "crViTestedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'QUARANTINE', true, 3, $8, $9, $10, $11)`,
    [lotId, A.tenant, A.companyA, A.siteA1, A.leather, colourId, code, pass ? 'PASS' : 'PENDING', pass ? '1.100' : null, pass ? 'LOT_REPORT' : null, pass ? '2026-11-01' : null],
  )
  await admin(`INSERT INTO "Hide" (id, "tenantId", "siteId", "lotId", "itemId", code, area, "areaUom", "baseArea") VALUES ($1, $2, $3, $4, $5, $6, $7, 'FT2', $7)`, [hideId, A.tenant, A.siteA1, lotId, A.leather, `${code}-H1`, area])
  await admin(
    `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "hideId", "toLocationId", quantity, uom, "baseQuantity", "idempotencyKey", "occurredAt")
     VALUES ($1, $2, $3, $4, 'OPENING', $5, $6, $7, $8, $9, $10, 'FT2', $10, $11, now())`,
    [newId(), A.tenant, A.companyA, A.siteA1, A.leather, colourId, lotId, hideId, A.store, area, `planning-test-${code}`],
  )
  if (state === 'BLOCKED') await admin(`UPDATE "Lot" SET "qualityStatus" = 'BLOCKED', "qualityDecidedAt" = now(), "qualityNote" = 'Made-up recall' WHERE id = $1`, [lotId])
  return lotId
}

/** A DRAFT purchase order of A1 to the supplier with one line. */
async function draftPurchase(number: string, itemId: string, colourId: string | null, baseQuantity: string, needDate: string) {
  const orderId = newId()
  const lineId = newId()
  await admin(`INSERT INTO "PurchaseOrder" (id, "tenantId", "companyId", "siteId", number, "partyId", "orderDate") VALUES ($1, $2, $3, $4, $5, $6, '2026-10-29')`, [orderId, A.tenant, A.companyA, A.siteA1, number, A.supplier])
  await admin(
    `INSERT INTO "PurchaseOrderLine" (id, "tenantId", "purchaseOrderId", "partyId", "siteId", seq, "itemId", "itemColourId", quantity, uom, "baseQuantity", "unitPrice", "netAmount", "needDate", "requiresCrViTest")
     VALUES ($1, $2, $3, $4, $5, 10, $6, $7, $8, 'FT2', $8, '0', 0, $9, true)`,
    [lineId, A.tenant, orderId, A.supplier, A.siteA1, itemId, colourId, baseQuantity, needDate],
  )
  return { orderId, lineId }
}

beforeAll(async () => {
  db = await migratedDatabase('planning')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  for (const namespace of [ns.a, ns.b]) await seedCore({ db: database, namespace })
  await seedProduction({ db: database, namespace: ns.a })
  await seedProduction({ db: database, namespace: ns.b })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 180_000)

afterAll(async () => {
  usePlanningRunTimeout(undefined)
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('a run explodes the open orders through their released BOMs (PLN-062, PLN-063)', () => {
  it('plans what it can, warns in words about the rest, and supersedes the previous plan', async () => {
    // SEED-JKT-01 has no released revision yet: SEED-SO-0001 is not planned.
    const { run, replayed } = await runPlan()
    expect(replayed).toBe(false)
    expect(run).toMatchObject({ siteId: A.siteA1, companyId: A.companyA, status: 'DONE', trigger: 'MANUAL', orderLines: 2 })
    expect(run.warnings.map((warning: Json) => [warning.code, warning.message])).toEqual([
      ['NO_RELEASED_BOM', 'SEED-SO-0001 line 10 is not planned: its style has no released BOM.'],
      ['NO_RELEASED_BOM', 'SEED-SO-0001 line 20 is not planned: its style has no released BOM.'],
    ])
    expect((await admin('SELECT status FROM "PlanningRun" WHERE id = $1', [A.seededRun]))[0]).toEqual({ status: 'SUPERSEDED' })
    const plan = await latest()
    expect(plan.run.id).toBe(run.id)
    // SEED-SO-0002 BLK only: 48.16 + 100.8 + 53.2, less WO-0001's 53.2 issued.
    expect(lineOf(plan, A.leather, A.leatherBLK)).toMatchObject({ grossQuantity: '148.9600' })
    const audit = await admin('SELECT action, after FROM "AuditLog" WHERE "recordId" = $1', [run.id])
    expect(audit).toEqual([expect.objectContaining({ action: 'planning.run', after: expect.objectContaining({ status: 'DONE', orderLines: 2, superseded: [A.seededRun] }) })])
    expect(await admin(`SELECT type FROM "OutboxEvent" WHERE type = 'planning.run_finished' AND subject = $1`, [run.id])).toHaveLength(1)
  })

  it('PLN-063: leather per size and colour in ft² and hides, lining in metres, protectors per piece, netted and rounded to the terms', async () => {
    await admin(`UPDATE "Style" SET status = 'ACTIVE' WHERE id = $1`, [A.jkt01])
    await admin(`UPDATE "StyleRevision" SET status = 'RELEASED', "releasedAt" = now(), "releasedById" = $2 WHERE id = $1`, [A.jkt01Rev, A.actor])
    const { run } = await runPlan()
    expect(run).toMatchObject({ orderLines: 4, warnings: [], requirements: 4, short: 3 })
    const plan = await latest()

    const black = lineOf(plan, A.leather, A.leatherBLK)
    // SO-0002 (4 Dec) 148.96 + SO-0001 (18 Dec) 96.32 + 201.6 + 106.4; usable: SEED-HIDE-0002; on order: PO1's 420 − 105.
    expect(black).toMatchObject({
      action: 'BUY',
      uom: 'FT2',
      grossQuantity: '553.2800',
      usableStock: '51.8000',
      heldStock: '0.0000',
      onOrder: '315.0000',
      netQuantity: '186.4800',
      // 186.48 ft² is 3.55 hides of 52.5: 4 whole hides, raised to the supplier's minimum of 5.
      suggestedQuantity: '5.0000',
      suggestedUom: 'HIDE',
      suggestedBaseQuantity: '262.5000',
      estimatedHides: 5,
      needDate: '2026-12-18',
      orderBy: { date: '2026-12-04', leadTimeDays: 14, passed: expect.any(Boolean) },
      supplier: { id: A.supplier, code: 'SEED-S1', name: expect.any(String) },
      why: 'Need 553.28 − usable 51.8 − on order 315 = short 186.48 ft²',
      decision: 'OPEN',
    })
    expect(black.orders.map((order: Json) => order.number)).toEqual(['SEED-SO-0002', 'SEED-SO-0001'])
    expect(black.sources.map((source: Json) => [source.orderNumber, source.size, source.pieces, source.quantity, source.issued, source.workOrders])).toEqual([
      ['SEED-SO-0002', '50', 1, '48.1600', '48.1600', ['SEED-WO-0001']],
      ['SEED-SO-0002', '52', 2, '100.8000', '5.0400', ['SEED-WO-0001', 'SEED-WO-0002']],
      ['SEED-SO-0002', '54', 1, '53.2000', '0.0000', ['SEED-WO-0001']],
      ['SEED-SO-0001', '50', 2, '96.3200', '0.0000', []],
      ['SEED-SO-0001', '52', 4, '201.6000', '0.0000', []],
      ['SEED-SO-0001', '54', 2, '106.4000', '0.0000', []],
    ])
    // Red: 151.76 + 202.16, nothing usable or on order: 6.74 hides → 7.
    expect(lineOf(plan, A.leather, A.leatherRED)).toMatchObject({ grossQuantity: '353.9200', netQuantity: '353.9200', suggestedQuantity: '7.0000', suggestedUom: 'HIDE', needDate: '2026-12-04' })
    // 19 garments × 1.8 m × 1.05, covered by the 120 m in stock.
    expect(lineOf(plan, A.lining, idOf(ns.a, 'product:item-colour:lining:GRY'))).toMatchObject({ uom: 'M', grossQuantity: '35.9100', usableStock: '120.0000', netQuantity: '0.0000', suggestedQuantity: '0.0000', suggestedUom: 'ROLL' })
    // 38 protectors; PO1's 24 (13 Nov) and PO2's draft 10 (1 Dec) arrive in time; 4 short, sold in steps of 12; no lead
    // time on the item: the supplier's 21 days.
    expect(lineOf(plan, A.protector)).toMatchObject({ uom: 'PCS', grossQuantity: '38.0000', onOrder: '34.0000', netQuantity: '4.0000', suggestedQuantity: '12.0000', suggestedUom: 'PCS', needDate: '2026-12-18', orderBy: { date: '2026-11-27', leadTimeDays: 21 } })
    expect(plan.summary).toMatchObject({ toBuy: 3, toMake: 0, ordered: 0, setAside: 0, shortWithHeldStock: 0 })
    expect((await latest('planner', '&shortOnly=true')).lines).toHaveLength(3)
    expect((await latest('planner', `&itemId=${A.protector}`)).lines).toHaveLength(1)
  })

  it('PLN-064: work-order allocations are not double counted (issued material left stock and leaves the need once)', async () => {
    // WO-0001's 53.2 ft² went to SO-0002's BLK 50 (48.16) and 52 (5.04): the gross need is 553.28, not 606.48, and the
    // ledger no longer holds the hide (usable is SEED-HIDE-0002 alone).
    const black = lineOf(await latest(), A.leather, A.leatherBLK)
    const issued = (black.sources as Json[]).reduce((sum, source) => sum + Number(source.issued), 0)
    expect(issued.toFixed(4)).toBe('53.2000')
    expect(black).toMatchObject({ grossQuantity: '553.2800', usableStock: '51.8000' })
  })
})

describe('only usable stock is netted (PLN-065; REACH Annex XVII entry 47)', () => {
  it('a lot in quarantine (Cr VI pending) or blocked is shown with its reason, never netted', async () => {
    const pending = await leatherLot('PLAN-LOT-BLK-Q', A.leatherBLK, '60.0000', 'CR_VI_PENDING')
    const blocked = await leatherLot('PLAN-LOT-RED-B', A.leatherRED, '40.0000', 'BLOCKED')
    await runPlan()
    const plan = await latest()
    expect(lineOf(plan, A.leather, A.leatherBLK)).toMatchObject({ usableStock: '51.8000', heldStock: '60.0000', netQuantity: '186.4800' })
    expect(lineOf(plan, A.leather, A.leatherRED)).toMatchObject({ usableStock: '0.0000', heldStock: '40.0000', netQuantity: '353.9200' })
    expect(plan.summary.shortWithHeldStock).toBe(2)

    const unusable = await ok('viewer', 'GET', `/planning/unusable-stock?siteId=${A.siteA1}`)
    expect(unusable.lines.map((line: Json) => [line.lot.code, line.quantity, line.hides, line.reason, line.words, line.held])).toEqual([
      ['PLAN-LOT-BLK-Q', '60.0000', 1, 'CR_VI_PENDING', 'no chromium VI test result yet', true],
      ['PLAN-LOT-RED-B', '40.0000', 1, 'BLOCKED', 'blocked after release', true],
    ])
    expect(unusable.lines.map((line: Json) => line.lot.id)).toEqual([pending, blocked])
  })

  it('explains a line: the sentence, the ladder, each lot with its reason and each purchase line, as of now', async () => {
    const black = lineOf(await latest(), A.leather, A.leatherBLK)
    const why = await ok('viewer', 'GET', `/planning/requirements/${black.id}`)
    expect(why.sentence).toBe(
      'We need 553.28 ft² for 2 orders (53.2 ft² are already issued to their work orders). 51.8 ft² in stock can be used. ' +
        '60 ft² more are held (quality hold, chromium VI test or blocked) and not counted. 40 ft² are in another colour and not counted. ' +
        '315 ft² are already ordered and arrive in time. We are 186.48 ft² short. Buy 5 hides (about 262.5 ft²). ' +
        "Order by 2026-12-04 to have it by 2026-12-18 (14 days' lead time).",
    )
    expect(why.sentence).not.toMatch(/€|EUR|price|cost/i)
    expect(why.bridge.map((step: Json) => [step.step, step.quantity])).toEqual([
      ['NEED', '553.2800'],
      ['USABLE', '-51.8000'],
      ['ON_ORDER', '-315.0000'],
      ['SHORT', '186.4800'],
      ['ROUNDING', '76.0200'],
      ['BUY', '262.5000'],
    ])
    expect(why.rounding).toEqual([
      { rule: 'WHOLE_UNITS', quantity: '4.0000' },
      { rule: 'MINIMUM', quantity: '5.0000' },
    ])
    expect(why.now).toMatchObject({ usableStock: '51.8000', heldStock: '60.0000', onOrder: '315.0000', netQuantity: '186.4800', changedSinceRun: false })
    expect(why.now.stock.map((line: Json) => [line.lot?.code, line.colour?.code, line.quantity, line.reason])).toEqual([
      ['PLAN-LOT-BLK-Q', 'BLK', '60.0000', 'CR_VI_PENDING'],
      ['PLAN-LOT-RED-B', 'RED', '40.0000', 'OTHER_COLOUR'],
      ['SEED-LOT-LEA-01', 'BLK', '51.8000', null],
    ])
    expect(why.now.purchases).toEqual([expect.objectContaining({ purchaseOrderNumber: 'SEED-PO-0001', openQuantity: '315.0000', dueDate: '2026-11-13', confirmed: true, counted: '315.0000', why: null })])
  })
})

describe('open purchase orders reduce the shortage (PLN-064)', () => {
  it('counts a line due before the need, and says a later one arrives too late', async () => {
    await draftPurchase('PLAN-PO-1', A.leather, A.leatherRED, '100.0000', '2026-12-01')
    await draftPurchase('PLAN-PO-2', A.leather, A.leatherRED, '80.0000', '2027-01-15')
    await runPlan()
    const red = lineOf(await latest(), A.leather, A.leatherRED)
    expect(red).toMatchObject({ grossQuantity: '353.9200', onOrder: '100.0000', netQuantity: '253.9200', suggestedQuantity: '5.0000' })
    const why = await ok('planner', 'GET', `/planning/requirements/${red.id}`)
    expect(why.now.purchases.map((line: Json) => [line.purchaseOrderNumber, line.purchaseOrderStatus, line.counted, line.notCounted, line.why])).toEqual([
      ['PLAN-PO-1', 'DRAFT', '100.0000', '0.0000', null],
      ['PLAN-PO-2', 'DRAFT', '0.0000', '80.0000', 'TOO_LATE'],
    ])
    expect(why.sentence).toContain('80 ft² more on order arrive after they are needed and are not counted.')
  })
})

describe('two runs of one site never overlap (PLN-062)', () => {
  it('a second run while one runs is refused at once, not queued', async () => {
    const held = holdPlanningLock(A.tenant, A.siteA1)
    await held.holding
    try {
      const error = await refused('planner', 'POST', '/planning/runs', { siteId: A.siteA1 }, 409)
      expect(error.message).toMatch(/A planning run of this site is going/)
    } finally {
      await held.release()
    }
    // A RUNNING row (a run the lock does not cover) refuses it too; the partial unique index is the backstop.
    const stuck = newId()
    await admin(`INSERT INTO "PlanningRun" (id, "tenantId", "companyId", "siteId", trigger, status, "startedAt") VALUES ($1, $2, $3, $4, 'MANUAL', 'RUNNING', now())`, [stuck, A.tenant, A.companyA, A.siteA1])
    expect((await refused('planner', 'POST', '/planning/runs', { siteId: A.siteA1 }, 409)).message).toMatch(/is going since/)
    await expect(admin(`INSERT INTO "PlanningRun" (id, "tenantId", "companyId", "siteId", trigger, status, "startedAt") VALUES ($1, $2, $3, $4, 'MANUAL', 'RUNNING', now())`, [newId(), A.tenant, A.companyA, A.siteA1])).rejects.toThrow(/PlanningRun_one_running_per_site/)
    await admin(`UPDATE "PlanningRun" SET status = 'FAILED', "finishedAt" = now(), error = 'Stopped by the test' WHERE id = $1`, [stuck])
    // Another site plans meanwhile.
    expect((await ok('planner', 'POST', '/planning/runs', { siteId: A.siteB1 }, 201)).run).toMatchObject({ siteId: A.siteB1, status: 'DONE', orderLines: 0 })
  })

  it('a resent request with its Idempotency-Key answers the same run', async () => {
    const idempotencyKey = key()
    const first = await ok('planner', 'POST', '/planning/runs', { siteId: A.siteA1 }, 201, idempotencyKey)
    const again = await ok('planner', 'POST', '/planning/runs', { siteId: A.siteA1 }, 201, idempotencyKey)
    expect(again).toEqual({ ...first, replayed: true })
    expect((await latest()).run.id).toBe(first.run.id)
  })

  it('a run that cannot be finished is a FAILED run of its own; the previous plan stays', async () => {
    const before = (await latest()).run.id
    usePlanningRunTimeout(1)
    try {
      expect((await call('planner', 'POST', '/planning/runs', { siteId: A.siteA1 })).statusCode).toBe(500)
    } finally {
      usePlanningRunTimeout(undefined)
    }
    const plan = await latest()
    expect(plan.run.id).toBe(before)
    expect(plan.latestAttempt).toMatchObject({ status: 'FAILED', error: expect.stringMatching(/^The plan could not be finished \(request .+\)\. The previous plan stays/) })
    // Newest first (the seeded run, dated in the seed's future, aside).
    const history = (await ok('planner', 'GET', `/planning/runs?siteId=${A.siteA1}&limit=4`)).runs as Json[]
    expect(history.filter((entry) => entry.id !== A.seededRun).map((entry) => entry.status).slice(0, 3)).toEqual(['FAILED', 'DONE', 'FAILED'])
  })
})

describe('deciding lines (design 02: Set aside, Undo; B-W1-30 hook)', () => {
  it('sets lines aside with a reason, opens them again, and refuses a stale version or a superseded plan', async () => {
    const plan = await latest()
    const lining = lineOf(plan, A.lining, idOf(ns.a, 'product:item-colour:lining:GRY'))
    const aside = await ok('planner', 'POST', '/planning/requirements/set-aside', { lines: [{ id: lining.id, version: lining.version }], reason: 'CUSTOMER_SUPPLIES', note: 'The brand sends its own lining' })
    expect(aside).toEqual({ runId: plan.run.id, decision: 'IGNORED', lines: [{ id: lining.id, version: lining.version + 1 }], replayed: false })
    const after = lineOf(await latest(), A.lining, idOf(ns.a, 'product:item-colour:lining:GRY'))
    expect(after).toMatchObject({ decision: 'IGNORED', decisionReason: 'CUSTOMER_SUPPLIES', decisionNote: 'The brand sends its own lining', decidedAt: expect.any(String) })
    expect((await latest()).summary.setAside).toBe(1)
    expect((await refused('planner', 'POST', '/planning/requirements/reopen', { lines: [{ id: lining.id, version: lining.version }] }, 409)).message).toMatch(/changed since it was read/)
    expect((await refused('planner', 'POST', '/planning/requirements/set-aside', { lines: [{ id: lining.id, version: after.version }], reason: 'OTHER' }, 400)).message).toBe('Say why the lines are set aside.')
    expect(await ok('planner', 'POST', '/planning/requirements/reopen', { lines: [{ id: lining.id, version: after.version }] })).toMatchObject({ decision: 'OPEN' })
    expect(await admin(`SELECT action FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at`, [lining.id])).toEqual([{ action: 'planning.setAside' }, { action: 'planning.reopen' }])

    await runPlan()
    const old = (await admin<{ version: number }>('SELECT version FROM "MaterialRequirement" WHERE id = $1', [lining.id]))[0]!
    expect((await refused('planner', 'POST', '/planning/requirements/set-aside', { lines: [{ id: lining.id, version: old.version }], reason: 'SUBSTITUTE' }, 409)).message).toMatch(/A newer plan replaced this one/)
  })

  it('B-W1-30 hook: proposes the purchase line, orders it with a purchase order line of the same material, and opens it again', async () => {
    const plan = await latest()
    const black = lineOf(plan, A.leather, A.leatherBLK)
    const caller = callerFor(database, { audience: 'office', tenantId: A.tenant, actorId: A.actor, requestId: `planning-test-${run}`, grants: [grant(['purchasing.test' as Permission])] })
    const proposal = await caller.withClient((client) => client.$transaction((tx) => proposalFor(tx, black.id)))
    expect(proposal).toMatchObject({ supplierId: A.supplier, itemId: A.leather, itemColourId: A.leatherBLK, quantity: '5.0000', uom: 'HIDE', baseQuantity: '262.5000', needDate: '2026-12-18', estimatedHides: 5, requiresCrViTest: true })

    const po1Leather = idOf(ns.a, 'supply:PO1:10')
    const po1Protector = idOf(ns.a, 'supply:PO1:20')
    await expect(command(caller, { name: 'purchasing.test', input: { n: 1 } }, (tools) => orderRequirement(tools, { requirementId: black.id, purchaseOrderLineId: po1Protector }))).rejects.toThrow(/another material/)
    const { result } = await command(caller, { name: 'purchasing.test', input: { n: 2 } }, (tools) => orderRequirement(tools, { requirementId: black.id, purchaseOrderLineId: po1Leather, expectedVersion: black.version }))
    expect(result).toEqual({ id: black.id, version: black.version + 1 })
    const ordered = await latest()
    expect(lineOf(ordered, A.leather, A.leatherBLK)).toMatchObject({ decision: 'ORDERED', purchaseOrderLineId: po1Leather })
    expect(ordered.summary).toMatchObject({ ordered: 1, inDraftPurchaseOrder: 0, toBuy: 2 })
    expect((await refused('planner', 'POST', '/planning/requirements/set-aside', { lines: [{ id: black.id, version: black.version + 1 }], reason: 'SUBSTITUTE' }, 409)).message).toMatch(/ordered already/)
    await command(caller, { name: 'purchasing.test', input: { n: 3 } }, (tools) => unorderRequirement(tools, { requirementId: black.id }))
    expect(lineOf(await latest(), A.leather, A.leatherBLK)).toMatchObject({ decision: 'OPEN', purchaseOrderLineId: null })
  })
})

describe('walls (A1 §2.2, §2.6): tenant, company, site, audience, money', () => {
  it('another tenant, another company or another site does not see the plan; without planning nothing at all', async () => {
    expect((await refused('otherTenant', 'GET', `/planning/runs/latest?siteId=${A.siteA1}`, undefined, 404)).message).toBe('Site not found.')
    expect((await refused('companyB', 'GET', `/planning/runs/latest?siteId=${A.siteA1}`, undefined, 404)).message).toBe('Site not found.')
    await refused('otherSite', 'POST', '/planning/runs', { siteId: A.siteA1 }, 404)
    const black = lineOf(await latest(), A.leather, A.leatherBLK)
    await refused('otherTenant', 'GET', `/planning/requirements/${black.id}`, undefined, 404)
    await refused('companyB', 'GET', `/planning/requirements/${black.id}`, undefined, 404)
    await refused('companyB', 'GET', `/planning/runs/${black.runId}`, undefined, 404)
    expect((await ok('companyB', 'GET', '/planning/runs')).runs.every((entry: Json) => entry.companyId === A.companyB)).toBe(true)
    await refused('noPlanning', 'GET', `/planning/runs/latest?siteId=${A.siteA1}`, undefined, 403)
    // Tenant B's own plan is its own.
    expect((await ok('otherTenant', 'POST', '/planning/runs', { siteId: B.siteA1 }, 201)).run.siteId).toBe(B.siteA1)
  })

  it('a viewer reads but neither runs nor decides; the floor and a partner have no planning route', async () => {
    await refused('viewer', 'POST', '/planning/runs', { siteId: A.siteA1 }, 403)
    const lining = lineOf(await latest(), A.lining, idOf(ns.a, 'product:item-colour:lining:GRY'))
    await refused('viewer', 'POST', '/planning/requirements/set-aside', { lines: [{ id: lining.id, version: lining.version }], reason: 'SUBSTITUTE' }, 403)
    for (const session of ['floor', 'partner']) {
      await refused(session, 'GET', `/planning/runs/latest?siteId=${A.siteA1}`, undefined, 403)
      await refused(session, 'POST', '/planning/runs', { siteId: A.siteA1 }, 403)
      await refused(session, 'GET', `/planning/unusable-stock?siteId=${A.siteA1}`, undefined, 403)
    }
  })

  it('A1 §2.6: the expected cost reaches only a caller with the cost grain', async () => {
    const planner = lineOf(await latest('planner'), A.leather, A.leatherBLK)
    expect(planner).not.toHaveProperty('unitCost')
    expect(planner).not.toHaveProperty('expectedAmount')
    const buyer = lineOf(await latest('buyer'), A.leather, A.leatherBLK)
    // 4.2 €/ft² × 52.5 ft² per hide; 262.5 ft² × 4.2 € = 1102.50 €.
    expect(buyer).toMatchObject({ unitCost: '220.500000', expectedAmount: 110_250, currency: 'EUR' })
  })
})
