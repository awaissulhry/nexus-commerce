import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedMoney } from '../../../../../../packages/factory-db/seed/money'
import { seed as seedOptions } from '../../../../../../packages/factory-db/seed/options'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
// B-SA-020: the file of the view (the export source read as the person).
import { callerFor } from '../../../core/command'
import { completeContext } from '../../../core/context'
import { exportSourceOf } from '../../../platform/exports/registry'
// B-CW-001 / B-CW-002 / B-CW-003: the phase rule, and the counts by phase read as a person (their where is the wall).
import { businessDate } from '@nexus/factory-domain/core/time'
import { ORDER_PHASES, type OrderPhase } from '@nexus/factory-domain/production-brand/stages'
import { officeContextOf } from './access'
import { whereOf } from './orders'
import { phaseCounts, phaseCountsByParty } from './production-columns'

/**
 * The orders sheet's own terms (threads plan TH-1a, pictures 23 + 24; B-TH-225 / B-TH-226, API part): `brand` narrows
 * GET /sales/orders and the board's counts to the orders with a line of a style of that label (a party id, or `own` = our
 * own collection), and GET /sales/orders/customers says whether the reader is limited to some customers (`limited`: the
 * switcher's "All my customers (n)" and a fixed label for one) without a word of the customers outside. On a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security is real) with the factory-db seeds up to
 * money and the options (the own-collection liner SEED-LNR-01): SEED-SO-0001 / SEED-SO-0002 of customer SEED-C1 (its
 * private-label jacket SEED-JKT-01), and TEST-SO-R1, a copy for customer SEED-R1 whose first line is the own-collection
 * liner and whose second keeps SEED-C1's jacket. B-SA-020 / B-SA-021: TEST-SO-MTM-C1 and TEST-SO-MTM-R1, copies of SEED-SO-0001 for
 * SEED-C1 and SEED-R1 whose first jacket line is one made-to-measure unit for the customer's own seeded rider (SEED-C1's "Seed Team
 * Rider", SEED-R1's "Seed Private Rider" revision 1). Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/sales/orders/sheet-terms.pg`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const NS = 'th1a-sheet-terms'
const id = (key: string): string => seedUuid(NS, key)
const tenant = id('tenant')
const C1 = id('party:P1')
const R1 = id('party:P4')

const grant = (permissions: readonly Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const SESSIONS: Record<string, () => SessionContext> = {
  all: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['orders.view'])] }),
  onlyR1: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['orders.view'], [R1])] }),
  // One grant limited to R1, another reaching every customer: not limited (any grant reaching all of them counts).
  mixed: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['orders.view'], [R1]), grant(['orders.view', 'quotes.view'])] }),
  // A grant naming customers that does not hold orders.view limits nothing of the orders.
  otherLimited: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['orders.view']), grant(['quotes.view'], [R1])] }),
  // B-SA-020 / B-SA-021: readers of measurements (the riders, the rider term), for every customer or only SEED-R1.
  measures: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['orders.view', 'sales.measurements.view'])] }),
  onlyR1Measures: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['orders.view', 'sales.measurements.view'], [R1])] }),
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
async function ok(session: string, url: string): Promise<Json> {
  const response = await app.inject({ method: 'GET', url, headers: { 'x-test-session': session } })
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
const numbers = async (session: string, query: string): Promise<string[]> => ((await ok(session, `/sales/orders?limit=200&${query}`)).orders as Json[]).map((row) => row.number as string).sort()
const boardTotal = async (session: string, query: string): Promise<number> => ((await ok(session, `/sales/orders/board?${query}`)).byStatus as Json[]).reduce((sum, entry) => sum + (entry.count as number), 0)
// ── B-SA-020: the file of a view (the export source's own read, as the person) and the made-to-measure truth in SQL ──
async function fileNumbers(session: string, address: string): Promise<string[]> {
  const source = exportSourceOf('sales.orders')!
  const reader = callerFor(database, completeContext(SESSIONS[session]!(), `test-${newId()}`))
  const page = await source.read(reader, source.query(new URLSearchParams(address)), null, 200)
  // The file's own Number cell (the source is wrapped with the custom fields, B-TH-057: its rows are { row, cells }).
  return page.rows.map((row) => source.columns.number!.value(row, (code) => code) as string).sort()
}
async function madeToMeasure(partyId?: string): Promise<string[]> {
  const rows = await admin<{ number: string }>(
    `SELECT DISTINCT o.number FROM "SalesOrder" o JOIN "SalesOrderLine" l ON l."orderId" = o.id
      WHERE o."tenantId" = $1 AND l.kind = 'MADE_TO_MEASURE' AND ($2::uuid IS NULL OR o."partyId" = $2::uuid) ORDER BY 1`,
    [tenant, partyId ?? null],
  )
  return rows.map((row) => row.number).sort()
}
// ── end B-SA-020 ──

/** The order numbers a label is on, counted here in SQL (a line of a style of that brand party; null = our own collection). */
async function labelled(brand: string | null, partyId?: string): Promise<string[]> {
  const rows = await admin<{ number: string }>(
    `SELECT DISTINCT o.number FROM "SalesOrder" o JOIN "SalesOrderLine" l ON l."orderId" = o.id JOIN "Style" st ON st.id = l."styleId"
      WHERE o."tenantId" = $1 AND st."brandPartyId" IS NOT DISTINCT FROM $2::uuid AND ($3::uuid IS NULL OR o."partyId" = $3::uuid) ORDER BY 1`,
    [tenant, brand, partyId ?? null],
  )
  return rows.map((row) => row.number).sort()
}

/** A version-4 UUID derived from an id and a salt (the copies' ids are valid UUIDs, as the contracts ask). */
const v4 = (expression: string, salt: string): string => {
  const hash = `md5(${expression}::text || '${salt}')`
  return `(substr(${hash}, 1, 8) || '-' || substr(${hash}, 9, 4) || '-4' || substr(${hash}, 14, 3) || '-8' || substr(${hash}, 18, 3) || '-' || substr(${hash}, 21, 12))::uuid`
}

/**
 * B-SA-020: SEED-SO-0001 copied for `partyId` as `number`, its first SEED-JKT-01 line one made-to-measure unit (one piece, no size
 * rows) of `profileId` (a profile of that customer: the line's own foreign key says so). The style is made to measure in the seed.
 */
async function mtmCopy(number: string, partyId: string, profileId: string): Promise<void> {
  const salt = number.toLowerCase()
  await admin(`
    CREATE TEMP TABLE o AS SELECT * FROM "SalesOrder" WHERE "tenantId" = '${tenant}' AND number = 'SEED-SO-0001';
    CREATE TEMP TABLE l AS SELECT * FROM "SalesOrderLine" WHERE "orderId" = (SELECT id FROM o);
    CREATE TEMP TABLE s AS SELECT * FROM "SalesOrderLineSize" WHERE "lineId" IN (SELECT id FROM l);
    CREATE TEMP TABLE u AS SELECT l.id FROM l JOIN "Style" st ON st.id = l."styleId" WHERE st.code = 'SEED-JKT-01' ORDER BY l.seq LIMIT 1;
    DELETE FROM s WHERE "lineId" IN (SELECT id FROM u);
    UPDATE l SET kind = 'MADE_TO_MEASURE', quantity = 1, "measurementProfileId" = '${profileId}', "baseSize" = '52' WHERE id IN (SELECT id FROM u);
    UPDATE s SET id = ${v4('id', salt)}, "lineId" = ${v4('"lineId"', salt)}, "partyId" = '${partyId}';
    UPDATE l SET id = ${v4('id', salt)}, "orderId" = ${v4('"orderId"', salt)}, "partyId" = '${partyId}', "quoteLineId" = NULL, "styleRevisionId" = NULL;
    UPDATE o SET id = ${v4('id', salt)}, "partyId" = '${partyId}', number = '${number}', "quoteVersionId" = NULL, "customerRef" = NULL;
    INSERT INTO "SalesOrder" SELECT * FROM o;
    INSERT INTO "SalesOrderLine" SELECT * FROM l;
    INSERT INTO "SalesOrderLineSize" SELECT * FROM s;
    DROP TABLE o, l, s, u;`)
}

// ── B-CW-002 / B-CW-021 (customer Work tab): made-up orders in a state, for the blocks at the end of the file ──
/** A made-up fact written past the order's own rules (the guards off: only the reads are under test). */
const rulesOff = (statements: string) => admin(`BEGIN; SET LOCAL session_replication_role = replica; ${statements} COMMIT;`)

/** SEED-SO-0001 copied for `partyId` as `number`, CONFIRMED with its lines and sizes (the copies above, without a change of line). */
async function plainCopy(number: string, partyId: string): Promise<void> {
  const salt = number.toLowerCase()
  await admin(`
    CREATE TEMP TABLE o AS SELECT * FROM "SalesOrder" WHERE "tenantId" = '${tenant}' AND number = 'SEED-SO-0001';
    CREATE TEMP TABLE l AS SELECT * FROM "SalesOrderLine" WHERE "orderId" = (SELECT id FROM o);
    CREATE TEMP TABLE s AS SELECT * FROM "SalesOrderLineSize" WHERE "lineId" IN (SELECT id FROM l);
    UPDATE s SET id = ${v4('id', salt)}, "lineId" = ${v4('"lineId"', salt)}, "partyId" = '${partyId}';
    UPDATE l SET id = ${v4('id', salt)}, "orderId" = ${v4('"orderId"', salt)}, "partyId" = '${partyId}', "quoteLineId" = NULL, "styleRevisionId" = NULL;
    UPDATE o SET id = ${v4('id', salt)}, "partyId" = '${partyId}', number = '${number}', "quoteVersionId" = NULL, "customerRef" = NULL, "customerSeq" = NULL,
      status = 'CONFIRMED', "cancelReason" = NULL, "closedAt" = NULL;
    INSERT INTO "SalesOrder" SELECT * FROM o;
    INSERT INTO "SalesOrderLine" SELECT * FROM l;
    INSERT INTO "SalesOrderLineSize" SELECT * FROM s;
    DROP TABLE o, l, s;`)
}
/** The order's status set by hand (closed and cancelled with their own columns). */
const setStatus = (number: string, status: string) =>
  rulesOff(`UPDATE "SalesOrder" SET status = '${status}', "closedAt" = ${status === 'CLOSED' || status === 'CANCELLED' ? 'now()' : 'NULL'}, "cancelReason" = ${status === 'CANCELLED' ? "'Made-up: the customer withdrew it.'" : 'NULL'} WHERE "tenantId" = '${tenant}' AND number = '${number}';`)
// ── end B-CW-002 / B-CW-021 ──

beforeAll(async () => {
  db = await migratedDatabase('orders_sheet_terms')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: NS })
  await seedMoney({ db: database, namespace: NS })
  await seedOptions({ db: database, namespace: NS })
  // TEST-SO-R1: SEED-SO-0001 copied for SEED-R1, its first line the own-collection liner, its second SEED-C1's jacket.
  const salt = 'test-so-r1'
  await admin(`
    CREATE TEMP TABLE o AS SELECT * FROM "SalesOrder" WHERE "tenantId" = '${tenant}' AND number = 'SEED-SO-0001';
    CREATE TEMP TABLE l AS SELECT * FROM "SalesOrderLine" WHERE "orderId" = (SELECT id FROM o);
    CREATE TEMP TABLE s AS SELECT * FROM "SalesOrderLineSize" WHERE "lineId" IN (SELECT id FROM l);
    UPDATE s SET id = ${v4('id', salt)}, "lineId" = ${v4('"lineId"', salt)}, "partyId" = '${R1}';
    UPDATE l SET id = ${v4('id', salt)}, "orderId" = ${v4('"orderId"', salt)}, "partyId" = '${R1}', "quoteLineId" = NULL, "styleRevisionId" = NULL;
    UPDATE l SET "styleId" = (SELECT id FROM "Style" WHERE "tenantId" = '${tenant}' AND code = 'SEED-LNR-01'),
      "colourwayId" = (SELECT c.id FROM "Colourway" c JOIN "Style" st ON st.id = c."styleId" WHERE st."tenantId" = '${tenant}' AND st.code = 'SEED-LNR-01' ORDER BY c.id LIMIT 1)
      WHERE seq = (SELECT min(seq) FROM l);
    UPDATE o SET id = ${v4('id', salt)}, "partyId" = '${R1}', number = 'TEST-SO-R1', "quoteVersionId" = NULL, "customerRef" = NULL;
    INSERT INTO "SalesOrder" SELECT * FROM o;
    INSERT INTO "SalesOrderLine" SELECT * FROM l;
    INSERT INTO "SalesOrderLineSize" SELECT * FROM s;
    DROP TABLE o, l, s;`)
  // B-SA-020 / B-SA-021: one made-to-measure order per customer, each unit made to that customer's own rider.
  await mtmCopy('TEST-SO-MTM-C1', C1, id('measurement:P1:rider:JACKET:1'))
  await mtmCopy('TEST-SO-MTM-R1', R1, id('measurement:P4:rider:JACKET:1'))
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('Brand narrows the sheet (B-TH-225)', () => {
  it('a label party: only the orders with a line of its styles, on the list and in the board counts', async () => {
    const expected = await labelled(C1)
    expect(expected).toEqual(expect.arrayContaining(['SEED-SO-0001', 'TEST-SO-R1']))
    expect(await numbers('all', `brand=${C1}`)).toEqual(expected)
    expect(await boardTotal('all', `brand=${C1}`)).toBe(expected.length)
    // The term keeps every other term: one customer's orders of that label (SEED-R1's: TEST-SO-R1 and, B-SA-020, its
    // made-to-measure copy of SEED-SO-0001, which keeps SEED-C1's jacket line).
    const r1 = await labelled(C1, R1)
    expect(r1).toEqual(['TEST-SO-MTM-R1', 'TEST-SO-R1'])
    expect(await numbers('all', `brand=${C1}&partyId=${R1}`)).toEqual(r1)
  })

  it('own: only the orders with a line of our own collection', async () => {
    const expected = await labelled(null)
    expect(expected).toEqual(['TEST-SO-R1'])
    expect(await numbers('all', 'brand=own')).toEqual(expected)
    expect(await boardTotal('all', 'brand=own')).toBe(1)
    // Without the term every order is on the sheet (the term narrows; it never drops a row by itself).
    expect((await numbers('all', '')).length).toBeGreaterThan(expected.length)
  })

  it('a person limited to SEED-R1 asking for SEED-C1\'s label sees R1\'s order only, never C1\'s', async () => {
    const r1 = await labelled(C1, R1) // TEST-SO-R1 and TEST-SO-MTM-R1 (B-SA-020)
    expect(await numbers('onlyR1', `brand=${C1}`)).toEqual(r1)
    expect(await boardTotal('onlyR1', `brand=${C1}`)).toBe(r1.length)
    expect(await numbers('onlyR1', 'brand=own')).toEqual(['TEST-SO-R1'])
  })

  it('a malformed brand is refused in words (400), never ignored', async () => {
    const response = await app.inject({ method: 'GET', url: '/sales/orders?brand=not-a-party', headers: { 'x-test-session': 'all' } })
    expect(response.statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/sales/orders/board?brand=OWN', headers: { 'x-test-session': 'all' } })).statusCode).toBe(400)
  })
})

describe('the Customer switcher knows a limited reader (B-TH-226)', () => {
  it('limited when every orders.view grant names its customers; the answer holds only those customers', async () => {
    const limited = await ok('onlyR1', '/sales/orders/customers')
    expect(limited).toMatchObject({ limited: true, total: 1 })
    expect(limited.customers.map((row: Json) => row.id)).toEqual([R1])
    expect(JSON.stringify(limited)).not.toContain(C1)
    expect(JSON.stringify(limited)).not.toContain('SEED-C1')
  })

  it('not limited for the factory (every customer), with one grant reaching every customer, or a limit on another right', async () => {
    const all = await ok('all', '/sales/orders/customers')
    expect(all).toMatchObject({ limited: false, total: 2 })
    expect((await ok('mixed', '/sales/orders/customers')).limited).toBe(false)
    expect((await ok('otherLimited', '/sales/orders/customers')).limited).toBe(false)
  })
})

// ── B-SA-020 (sales page plan N7, pick P12; 12-lists-board §4.1): kind=mtm, screen = file = count ──
describe('made-to-measure orders: kind=mtm narrows the list, the board, the totals, the switcher and the file alike (B-SA-020)', () => {
  it('the orders with a made-to-measure unit, the same rows and counts on every read', async () => {
    const expected = await madeToMeasure()
    expect(expected).toEqual(['TEST-SO-MTM-C1', 'TEST-SO-MTM-R1'])
    expect(await numbers('all', 'kind=mtm')).toEqual(expected)
    expect(await boardTotal('all', 'kind=mtm')).toBe(expected.length)
    const summary = await ok('all', '/sales/orders/summary?kind=mtm')
    expect(summary.all.orders.count).toBe(expected.length)
    // A total's door keeps the term (it opens exactly the rows it counts).
    expect(summary.all.orders.filter).toMatchObject({ kind: 'mtm' })
    const customers = await ok('all', '/sales/orders/customers?kind=mtm')
    expect((customers.customers as Json[]).map((row) => row.id).sort()).toEqual([C1, R1].sort())
    expect((customers.customers as Json[]).reduce((sum, row) => sum + (row.orders as number), 0)).toBe(expected.length)
    // The file holds the screen's rows (the copies are open: the file's default view is the open orders).
    expect(await fileNumbers('all', 'kind=mtm')).toEqual(expected)
    expect(await fileNumbers('all', 'kind=mtm&rows=all')).toEqual(expected)
    // Without the term every order (the term narrows; it never drops a row by itself).
    expect((await numbers('all', '')).length).toBeGreaterThan(expected.length)
  })

  it('a person limited to SEED-R1 reads only SEED-R1\'s made-to-measure orders and counts, never a word of SEED-C1\'s', async () => {
    const expected = await madeToMeasure(R1)
    expect(expected).toEqual(['TEST-SO-MTM-R1'])
    expect(await numbers('onlyR1', 'kind=mtm')).toEqual(expected)
    expect(await boardTotal('onlyR1', 'kind=mtm')).toBe(1)
    const summary = await ok('onlyR1', '/sales/orders/summary?kind=mtm&group=party')
    expect(summary.all.orders.count).toBe(1)
    expect((summary.groups as Json[]).map((group) => group.partyId)).toEqual([R1])
    const customers = await ok('onlyR1', '/sales/orders/customers?kind=mtm')
    expect((customers.customers as Json[]).map((row) => row.id)).toEqual([R1])
    expect(JSON.stringify(customers)).not.toContain(C1)
    expect(await fileNumbers('onlyR1', 'kind=mtm')).toEqual(expected)
    expect(await fileNumbers('onlyR1Measures', 'kind=mtm')).toEqual(expected)
  })

  it('a kind the sheet does not know is refused in words, on the list and for the file (never a file of every order)', async () => {
    expect((await app.inject({ method: 'GET', url: '/sales/orders?kind=MTM', headers: { 'x-test-session': 'all' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/sales/orders/board?kind=all', headers: { 'x-test-session': 'all' } })).statusCode).toBe(400)
    expect(() => exportSourceOf('sales.orders')!.query(new URLSearchParams('kind=units'))).toThrow('Not a kind: the file would hold more than the screen.')
  })

  it('the row\'s mark and the file\'s Made to measure column; the riders only for a reader of measurements', async () => {
    const row = async (session: string, number: string): Promise<Json> => ((await ok(session, '/sales/orders?limit=200&kind=mtm')).orders as Json[]).find((entry) => entry.number === number)!
    expect((await row('measures', 'TEST-SO-MTM-C1')).madeToMeasure).toMatchObject({ units: 1, riders: { names: ['Seed Team Rider'], count: 1 } })
    expect((await row('all', 'TEST-SO-MTM-C1')).madeToMeasure).toMatchObject({ units: 1, riders: null })
    expect(JSON.stringify(await ok('all', '/sales/orders?limit=200&kind=mtm'))).not.toContain('Seed Team Rider')
    // An order without a unit carries no mark.
    expect(((await ok('all', '/sales/orders?limit=200')).orders as Json[]).find((entry) => entry.number === 'SEED-SO-0001')!.madeToMeasure).toBeNull()
  })
})
// ── end B-SA-020 ──

// ── B-SA-021 (sales page plan N7, pick P12; 12-lists-board §4.2): a rider's orders, and the rider-name search ──
describe('the rider term and the rider-name search, only for a reader of measurements (B-SA-021)', () => {
  const P1_RIDER = id('measurement:P1:rider:JACKET:1')
  const P4_REV1 = id('measurement:P4:rider:JACKET:1')
  const P4_REV2 = id('measurement:P4:rider:JACKET:2')

  it('profile=: the orders with a unit of ANY revision of the rider\'s garment profile, on the list, the board, the totals and the file', async () => {
    // The unit is made to revision 1; revision 2 is the same rider's newer measures: both name the same orders.
    for (const profile of [P4_REV1, P4_REV2]) {
      expect(await numbers('measures', `profile=${profile}`), profile).toEqual(['TEST-SO-MTM-R1'])
      expect(await boardTotal('measures', `profile=${profile}`)).toBe(1)
      expect((await ok('measures', `/sales/orders/summary?profile=${profile}`)).all.orders.count).toBe(1)
      expect(await fileNumbers('measures', `profile=${profile}`)).toEqual(['TEST-SO-MTM-R1'])
    }
    expect(await numbers('measures', `profile=${P1_RIDER}&kind=mtm`)).toEqual(['TEST-SO-MTM-C1'])
  })

  it('without sales.measurements.view the term is refused in words (403) on every read, and the file is refused before anything is read', async () => {
    for (const url of [`/sales/orders?profile=${P4_REV1}`, `/sales/orders/board?profile=${P4_REV1}`, `/sales/orders/summary?profile=${P4_REV1}`]) {
      const response = await app.inject({ method: 'GET', url, headers: { 'x-test-session': 'all' } })
      expect(response.statusCode, url).toBe(403)
      expect(response.body, url).toContain('You may not narrow orders by rider.')
    }
    const source = exportSourceOf('sales.orders')!
    const query = source.query(new URLSearchParams(`profile=${P4_REV1}`))
    expect(source.refusal?.(completeContext(SESSIONS.all!(), 'test-refusal') as never, query)).toBe('You may not narrow orders by rider.')
    expect(source.refusal?.(completeContext(SESSIONS.measures!(), 'test-refusal') as never, query)).toBeNull()
    expect(() => source.query(new URLSearchParams('profile=Seed Team Rider'))).toThrow(/Not a rider/)
  })

  it('a SEED-R1-limited holder of the right naming SEED-C1\'s rider gets no row and no count — the same as a rider without orders', async () => {
    expect(await numbers('onlyR1Measures', `profile=${P1_RIDER}`)).toEqual([])
    expect(await boardTotal('onlyR1Measures', `profile=${P1_RIDER}`)).toBe(0)
    expect(await fileNumbers('onlyR1Measures', `profile=${P1_RIDER}`)).toEqual([])
    // An unknown profile answers the same.
    expect(await numbers('measures', `profile=${newId()}`)).toEqual([])
    // Its own rider: its order.
    expect(await numbers('onlyR1Measures', `profile=${P4_REV1}`)).toEqual(['TEST-SO-MTM-R1'])
  })

  it('the search finds an order by its unit\'s rider only for a reader of measurements of that customer', async () => {
    expect(await numbers('measures', 'q=Seed%20Team%20Rider')).toEqual(['TEST-SO-MTM-C1'])
    expect(await numbers('all', 'q=Seed%20Team%20Rider')).toEqual([])
    expect(await numbers('onlyR1Measures', 'q=Seed%20Team%20Rider')).toEqual([])
    // SEED-R1 is a private rider: "Seed Private Rider" is also the customer's legal name, so every reader of its orders finds them
    // all by the customer (B-TH-057) — the made-to-measure one among them; a reader of measurements finds nothing more.
    const privately = ['TEST-SO-MTM-R1', 'TEST-SO-R1']
    expect(await numbers('all', 'q=Seed%20Private%20Rider')).toEqual(privately)
    expect(await numbers('measures', 'q=Seed%20Private%20Rider')).toEqual(privately)
    expect(await numbers('onlyR1Measures', 'q=Seed%20Private%20Rider')).toEqual(privately)
  })
})
// ── end B-SA-021 ──

// ── B-SA-070 (sales page plan R5; 15-steps-notes §8.6): waiting=us — the customer's Work tab's "Waiting on us", screen = file = count ──
describe('waiting=us narrows the list, the board, the totals and the file alike, inside the reader\'s customers (B-SA-070)', () => {
  beforeAll(async () => {
    // TEST-SO-R1: the keeper says it waits on us. SEED-SO-0001: a customer request still OPEN on it. TEST-SO-MTM-C1: it waits on the customer.
    for (const [number, waitingOn] of [['TEST-SO-R1', 'US'], ['TEST-SO-MTM-C1', 'BRAND']] as const) {
      await admin(
        `INSERT INTO "BrandOrderProduction" (id, "tenantId", "companyId", "partyId", "salesOrderId", key, stage, "stageAt", "waitingOn", "waitingSince")
         SELECT $1, o."tenantId", o."companyId", o."partyId", o.id, 'brand-production:' || o.id, 'PREPARING', now(), $3::"WaitingOn", now() FROM "SalesOrder" o WHERE o."tenantId" = $2 AND o.number = $4
         ON CONFLICT ("tenantId", key) DO UPDATE SET "waitingOn" = $3::"WaitingOn", "waitingSince" = now()`,
        [newId(), tenant, waitingOn, number],
      )
    }
    await admin(`INSERT INTO "OrderChangeRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, status) SELECT $1, o."tenantId", o."companyId", o."partyId", o.id, 'RUSH', 'OPEN' FROM "SalesOrder" o WHERE o."tenantId" = $2 AND o.number = 'SEED-SO-0001'`, [newId(), tenant])
  })

  /**
   * The orders waiting on us, counted here in SQL: the keeper's waiting on us, or a customer request still OPEN.
   * B-CW-021: the keeper's word counts only while it still keeps the order (not shipped, delivered, closed or cancelled, nor
   * waiting for a yes); an OPEN request waits on us in any state.
   */
  async function waitingOnUs(partyId?: string): Promise<string[]> {
    const rows = await admin<{ number: string }>(
      `SELECT o.number FROM "SalesOrder" o WHERE o."tenantId" = $1 AND ($2::uuid IS NULL OR o."partyId" = $2::uuid)
        AND ((o.status IN ('CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED') AND EXISTS (SELECT 1 FROM "BrandOrderProduction" p WHERE p."salesOrderId" = o.id AND p."waitingOn" = 'US'))
             OR EXISTS (SELECT 1 FROM "OrderChangeRequest" r WHERE r."orderId" = o.id AND r.status = 'OPEN')) ORDER BY 1`,
      [tenant, partyId ?? null],
    )
    return rows.map((row) => row.number).sort()
  }

  it('the same rows and counts on the list, the board, the totals (their doors keep the term) and the file', async () => {
    const expected = await waitingOnUs()
    expect(expected).toEqual(expect.arrayContaining(['SEED-SO-0001', 'TEST-SO-R1']))
    expect(expected).not.toContain('TEST-SO-MTM-C1')
    expect(await numbers('all', 'waiting=us')).toEqual(expected)
    expect(await boardTotal('all', 'waiting=us')).toBe(expected.length)
    const summary = await ok('all', '/sales/orders/summary?waiting=us')
    expect(summary.all.orders.count).toBe(expected.length)
    expect(summary.all.orders.filter).toMatchObject({ waiting: 'us' })
    expect(await fileNumbers('all', 'waiting=us&rows=all')).toEqual(expected)
  })

  it('a person limited to SEED-R1 reads only SEED-R1\'s orders waiting on us, never a count of SEED-C1\'s', async () => {
    const expected = await waitingOnUs(R1)
    expect(expected).toEqual(['TEST-SO-R1'])
    expect(await numbers('onlyR1', 'waiting=us')).toEqual(expected)
    expect(await numbers('onlyR1', `waiting=us&partyId=${C1}`)).toEqual([])
    expect(await boardTotal('onlyR1', `waiting=us&partyId=${C1}`)).toBe(0)
    expect((await ok('onlyR1', `/sales/orders/summary?waiting=us&partyId=${C1}`)).all.orders.count).toBe(0)
    expect(await fileNumbers('onlyR1', 'waiting=us&rows=all')).toEqual(expected)
  })

  it('another value is refused in words, on the list and for the file', async () => {
    expect((await app.inject({ method: 'GET', url: '/sales/orders?waiting=them', headers: { 'x-test-session': 'all' } })).statusCode).toBe(400)
    expect(() => exportSourceOf('sales.orders')!.query(new URLSearchParams('waiting=customer'))).toThrow('Not a waiting term: the file would hold more than the screen.')
  })

  // ── B-CW-021 (customer Work tab plan §2.8, A2-B2): the keeper's "us" counts only while it still keeps the order ──
  // (last in this block, and both copies are SEED-C1's: the cases above count SEED-R1's rows exactly)
  it('a shipped order whose kept row still says us is out of the list, the board, the totals and the file; a shipped order with an OPEN request still waits on us (B-CW-021)', async () => {
    // T-CW-C1-GONE: the keeper says it waits on us. T-CW-C1-ASKS: a customer request still OPEN on it. Both made CONFIRMED, as the rows above.
    await plainCopy('T-CW-C1-GONE', C1)
    await plainCopy('T-CW-C1-ASKS', C1)
    await admin(
      `INSERT INTO "BrandOrderProduction" (id, "tenantId", "companyId", "partyId", "salesOrderId", key, stage, "stageAt", "waitingOn", "waitingSince")
       SELECT $1, o."tenantId", o."companyId", o."partyId", o.id, 'brand-production:' || o.id, 'PREPARING', now(), 'US'::"WaitingOn", now() FROM "SalesOrder" o WHERE o."tenantId" = $2 AND o.number = 'T-CW-C1-GONE'
       ON CONFLICT ("tenantId", key) DO UPDATE SET "waitingOn" = 'US'::"WaitingOn", "waitingSince" = now()`,
      [newId(), tenant],
    )
    await admin(`INSERT INTO "OrderChangeRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, status) SELECT $1, o."tenantId", o."companyId", o."partyId", o.id, 'RUSH', 'OPEN' FROM "SalesOrder" o WHERE o."tenantId" = $2 AND o.number = 'T-CW-C1-ASKS'`, [newId(), tenant])
    // While the keeper keeps them (CONFIRMED) both wait on us.
    expect(await numbers('all', 'waiting=us')).toEqual(expect.arrayContaining(['T-CW-C1-ASKS', 'T-CW-C1-GONE']))
    expect(await waitingOnUs()).toEqual(expect.arrayContaining(['T-CW-C1-ASKS', 'T-CW-C1-GONE']))
    // Both shipped: the keeper leaves its last row alone ("us" for ever) — only the OPEN request still waits on us.
    await setStatus('T-CW-C1-GONE', 'SHIPPED')
    await setStatus('T-CW-C1-ASKS', 'SHIPPED')
    expect((await admin(`SELECT 1 FROM "BrandOrderProduction" p JOIN "SalesOrder" o ON o.id = p."salesOrderId" WHERE o."tenantId" = $1 AND o.number = 'T-CW-C1-GONE' AND p."waitingOn" = 'US'`, [tenant])).length).toBe(1)
    const expected = await waitingOnUs()
    expect(expected).toContain('T-CW-C1-ASKS')
    expect(expected).not.toContain('T-CW-C1-GONE')
    expect(await numbers('all', 'waiting=us')).toEqual(expected)
    expect(await boardTotal('all', 'waiting=us')).toBe(expected.length)
    expect((await ok('all', '/sales/orders/summary?waiting=us')).all.orders.count).toBe(expected.length)
    expect(await fileNumbers('all', 'waiting=us&rows=all')).toEqual(expected)
    // The same for a closed and a cancelled order.
    for (const status of ['CLOSED', 'CANCELLED']) {
      await setStatus('T-CW-C1-GONE', status)
      expect(await numbers('all', 'waiting=us'), status).not.toContain('T-CW-C1-GONE')
      expect(await fileNumbers('all', 'waiting=us&rows=all'), status).not.toContain('T-CW-C1-GONE')
    }
    await setStatus('T-CW-C1-GONE', 'SHIPPED')
  })
  // ── end B-CW-021 ──
})
// ── end B-SA-070 ──

// ── B-CW-001 / B-CW-002 / B-CW-003 (customer Work tab plan §1; lead settle S17): the phase — screen = file = count ──
/**
 * Stands on made-up copies of the seeds' SEED-SO-0001 (customer SEED-C1, a deposit needed: the copies keep that), each made CONFIRMED
 * and then put in its state past the order's own rules (the guards off: only the reads are under test):
 *
 *   SEED-C1   T-CW-C1-YES waiting for a yes · T-CW-C1-DEP confirmed, its deposit request OPEN, a kept row at QUALITY (still not
 *             sent) · T-CW-C1-REL in production, no kept row · T-CW-C1-PREP in production, kept at PREPARING · T-CW-C1-CUT in
 *             production, kept at CUTTING, a deposit request OPEN · T-CW-C1-RDY ready · T-CW-C1-PART partly shipped ·
 *             T-CW-C1-SHIP shipped · T-CW-C1-CLOSED closed · T-CW-C1-CX cancelled
 *   SEED-R1   T-CW-R1-YES waiting for a yes · T-CW-R1-SEW in production, kept at SEWING
 */
describe('phase: the list, the totals and the file hold the same rows, and the board counts every phase (B-CW-002, B-CW-003)', () => {
  const sumOf = (counts: readonly number[]): number => counts.reduce((sum, count) => sum + count, 0)

  /** The order's kept production row at a stage (made, or moved to it). */
  const keep = (number: string, stage: string) =>
    rulesOff(`INSERT INTO "BrandOrderProduction" (id, "tenantId", "companyId", "partyId", "salesOrderId", key, stage, "stageAt")
      SELECT '${newId()}', o."tenantId", o."companyId", o."partyId", o.id, 'brand-production:' || o.id, '${stage}', now() FROM "SalesOrder" o WHERE o."tenantId" = '${tenant}' AND o.number = '${number}'
      ON CONFLICT ("tenantId", key) DO UPDATE SET stage = EXCLUDED.stage, "stageAt" = now();`)
  /** An OPEN deposit request of the order (no schedule step: the deposit itself, not a balance before shipping). */
  const askDeposit = (number: string) =>
    rulesOff(`INSERT INTO "DepositRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, currency, amount, "dueDate", "fiscalDocument", "fiscalRule")
      SELECT '${newId()}', o."tenantId", o."companyId", o."partyId", o.id, 'ACCONTO', 'EUR', 30000, (now() + interval '10 days')::date, 'NONE', 'test.deposit.EU_B2B_VIES' FROM "SalesOrder" o WHERE o."tenantId" = '${tenant}' AND o.number = '${number}';`)

  /** Each phase's order numbers, counted here in SQL: the status first; a kept row past PREPARING splits the status IN_PRODUCTION. */
  async function phaseTruth(partyId?: string): Promise<Record<OrderPhase, string[]>> {
    const rows = await admin<{ number: string; phase: OrderPhase }>(
      `SELECT o.number,
              CASE WHEN o.status IN ('PENDING_APPROVAL', 'CONFIRMED') THEN 'NOT_SENT'
                   WHEN o.status = 'IN_PRODUCTION' AND EXISTS (SELECT 1 FROM "BrandOrderProduction" p WHERE p."salesOrderId" = o.id AND p.stage <> 'PREPARING') THEN 'IN_PRODUCTION'
                   WHEN o.status = 'IN_PRODUCTION' THEN 'NOT_STARTED'
                   WHEN o.status = 'READY' THEN 'READY'
                   WHEN o.status IN ('PARTLY_SHIPPED', 'SHIPPED') THEN 'SHIPPED'
                   WHEN o.status IN ('DELIVERED', 'CLOSED') THEN 'DONE'
                   ELSE 'CANCELLED' END AS phase
         FROM "SalesOrder" o WHERE o."tenantId" = $1 AND ($2::uuid IS NULL OR o."partyId" = $2::uuid)`,
      [tenant, partyId ?? null],
    )
    const out: Record<OrderPhase, string[]> = { NOT_SENT: [], NOT_STARTED: [], IN_PRODUCTION: [], READY: [], SHIPPED: [], DONE: [], CANCELLED: [] }
    for (const row of rows) out[row.phase].push(row.number)
    for (const phase of ORDER_PHASES) out[phase].sort()
    return out
  }
  const countOf = (board: Json, phase: OrderPhase): number => (board.byPhase as Json[]).find((entry) => entry.phase === phase)!.count as number
  /** The orders CONFIRMED with a deposit needed and a deposit request still OPEN, counted here in SQL. */
  async function confirmedDepositOpen(partyId?: string): Promise<number> {
    const [row] = await admin<{ n: number }>(
      `SELECT count(*)::int AS n FROM "SalesOrder" o WHERE o."tenantId" = $1 AND ($2::uuid IS NULL OR o."partyId" = $2::uuid) AND o.status = 'CONFIRMED' AND o."depositRequired"
          AND EXISTS (SELECT 1 FROM "DepositRequest" r WHERE r."orderId" = o.id AND r.status = 'OPEN'
                        AND NOT EXISTS (SELECT 1 FROM "SalesOrderMilestone" m WHERE m."depositRequestId" = r.id AND m.kind = 'BEFORE_SHIPPING'))`,
      [tenant, partyId ?? null],
    )
    return row!.n
  }
  const waitingForYes = async (partyId?: string): Promise<number> =>
    (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "SalesOrder" o WHERE o."tenantId" = $1 AND ($2::uuid IS NULL OR o."partyId" = $2::uuid) AND o.status = 'PENDING_APPROVAL'`, [tenant, partyId ?? null]))[0]!.n

  beforeAll(async () => {
    const WORLD: readonly (readonly [number: string, party: string, status: string, stage: string | null])[] = [
      ['T-CW-C1-YES', C1, 'PENDING_APPROVAL', null],
      ['T-CW-C1-DEP', C1, 'CONFIRMED', 'QUALITY'],
      ['T-CW-C1-REL', C1, 'IN_PRODUCTION', null],
      ['T-CW-C1-PREP', C1, 'IN_PRODUCTION', 'PREPARING'],
      ['T-CW-C1-CUT', C1, 'IN_PRODUCTION', 'CUTTING'],
      ['T-CW-C1-RDY', C1, 'READY', 'READY'],
      ['T-CW-C1-PART', C1, 'PARTLY_SHIPPED', null],
      ['T-CW-C1-SHIP', C1, 'SHIPPED', null],
      ['T-CW-C1-CLOSED', C1, 'CLOSED', null],
      ['T-CW-C1-CX', C1, 'CANCELLED', null],
      ['T-CW-R1-YES', R1, 'PENDING_APPROVAL', null],
      ['T-CW-R1-SEW', R1, 'IN_PRODUCTION', 'SEWING'],
    ]
    for (const [number, party, status, stage] of WORLD) {
      await plainCopy(number, party)
      if (stage !== null) await keep(number, stage)
      if (status !== 'CONFIRMED') await setStatus(number, status)
    }
    await askDeposit('T-CW-C1-DEP')
    await askDeposit('T-CW-C1-CUT')
  }, 120_000)

  it('each phase: the same rows on the list, in the totals (their door keeps the term) and in the file; the board counts exactly them', async () => {
    const truth = await phaseTruth()
    // The made-up world has an order in every phase.
    for (const phase of ORDER_PHASES) expect(truth[phase].length, phase).toBeGreaterThan(0)
    expect(truth.NOT_SENT).toEqual(expect.arrayContaining(['T-CW-C1-DEP', 'T-CW-C1-YES', 'T-CW-R1-YES']))
    const board = await ok('all', '/sales/orders/board')
    expect((board.byPhase as Json[]).map((entry) => entry.phase)).toEqual([...ORDER_PHASES])
    for (const phase of ORDER_PHASES) {
      const expected = truth[phase]
      expect(await numbers('all', `phase=${phase}`), phase).toEqual(expected)
      const summary = await ok('all', `/sales/orders/summary?phase=${phase}`)
      expect(summary.all.orders.count, phase).toBe(expected.length)
      expect(summary.all.orders.filter, phase).toMatchObject({ phase })
      expect(await fileNumbers('all', `phase=${phase}&rows=all`), phase).toEqual(expected)
      expect(countOf(board, phase), phase).toBe(expected.length)
    }
    // Every order is in exactly one phase: the seven add up to the counts by status, and to every order of the list.
    const byStatus = sumOf((board.byStatus as Json[]).map((entry) => entry.count as number))
    expect(sumOf((board.byPhase as Json[]).map((entry) => entry.count as number))).toBe(byStatus)
    expect(byStatus).toBe((await numbers('all', '')).length)
    // The term keeps every other term: one customer's orders of a phase.
    expect(await numbers('all', `phase=IN_PRODUCTION&partyId=${R1}`)).toEqual(['T-CW-R1-SEW'])
    expect(await fileNumbers('all', `phase=IN_PRODUCTION&rows=all&party=${R1}`)).toEqual(['T-CW-R1-SEW'])
  })

  it('the kept stage splits only the orders in production: no kept row or PREPARING is not started, CUTTING moves the order; a confirmed order kept at QUALITY is still not sent', async () => {
    const before = await ok('all', '/sales/orders/board')
    expect(await numbers('all', 'phase=NOT_STARTED')).toEqual(expect.arrayContaining(['T-CW-C1-PREP', 'T-CW-C1-REL']))
    expect(await numbers('all', 'phase=IN_PRODUCTION')).toEqual(expect.arrayContaining(['T-CW-C1-CUT', 'T-CW-R1-SEW']))
    expect(await numbers('all', 'phase=IN_PRODUCTION')).not.toContain('T-CW-C1-PREP')
    expect(await numbers('all', 'phase=NOT_SENT')).toContain('T-CW-C1-DEP')
    expect(await numbers('all', 'phase=IN_PRODUCTION')).not.toContain('T-CW-C1-DEP')
    await keep('T-CW-C1-PREP', 'CUTTING')
    try {
      expect(await numbers('all', 'phase=IN_PRODUCTION')).toContain('T-CW-C1-PREP')
      expect(await numbers('all', 'phase=NOT_STARTED')).not.toContain('T-CW-C1-PREP')
      const after = await ok('all', '/sales/orders/board')
      expect(countOf(after, 'IN_PRODUCTION')).toBe(countOf(before, 'IN_PRODUCTION') + 1)
      expect(countOf(after, 'NOT_STARTED')).toBe(countOf(before, 'NOT_STARTED') - 1)
      // The status count did not move: the two phases are the status IN_PRODUCTION, split.
      const inProduction = (board: Json): number => (board.byStatus as Json[]).find((entry) => entry.status === 'IN_PRODUCTION')!.count as number
      expect(inProduction(after)).toBe(inProduction(before))
      expect(countOf(after, 'IN_PRODUCTION') + countOf(after, 'NOT_STARTED')).toBe(inProduction(after))
    } finally {
      await keep('T-CW-C1-PREP', 'PREPARING')
    }
    expect(await numbers('all', 'phase=NOT_STARTED')).toContain('T-CW-C1-PREP')
  })

  it('notSent: the two exact whys inside Not sent — waiting for a yes, and confirmed with the deposit still open (the deposit tile counts every state)', async () => {
    const board = await ok('all', '/sales/orders/board')
    const waitsForDeposit = await confirmedDepositOpen()
    expect(waitsForDeposit).toBeGreaterThan(0) // T-CW-C1-DEP
    expect(board.notSent).toEqual({ waitsForYes: await waitingForYes(), waitsForDeposit })
    expect(board.notSent.waitsForYes + board.notSent.waitsForDeposit).toBeLessThanOrEqual(countOf(board, 'NOT_SENT'))
    // T-CW-C1-CUT is in production with its deposit request still open: the tile counts it, the why of "Not sent" does not.
    const tile = (board.tiles as Json[]).find((entry) => entry.key === 'waitingForDeposit')!.count as number
    expect(tile).toBeGreaterThan(board.notSent.waitsForDeposit)
    expect(await numbers('all', 'deposit=OPEN')).toEqual(expect.arrayContaining(['T-CW-C1-CUT', 'T-CW-C1-DEP']))
    // Counts only: the picture holds no amount.
    expect(JSON.stringify({ byPhase: board.byPhase, notSent: board.notSent })).not.toMatch(/amount|net|gross|price/i)
  })

  it('another value is refused in words, on the list, in the totals and for the file (never a file of every order)', async () => {
    for (const url of ['/sales/orders?phase=NOPE', '/sales/orders/summary?phase=NOPE', '/sales/orders?phase=in_production']) {
      expect((await app.inject({ method: 'GET', url, headers: { 'x-test-session': 'all' } })).statusCode, url).toBe(400)
    }
    expect(() => exportSourceOf('sales.orders')!.query(new URLSearchParams('phase=NOPE'))).toThrow('Not a value of phase: the file would not follow the screen.')
  })

  it('a person limited to SEED-R1 reads the phases and the whys of its own customers only; naming SEED-C1 counts nothing', async () => {
    const mine = await phaseTruth(R1)
    expect(mine.IN_PRODUCTION).toEqual(['T-CW-R1-SEW'])
    const board = await ok('onlyR1', '/sales/orders/board')
    for (const phase of ORDER_PHASES) {
      expect(countOf(board, phase), phase).toBe(mine[phase].length)
      expect(await numbers('onlyR1', `phase=${phase}`), phase).toEqual(mine[phase])
      expect(await fileNumbers('onlyR1', `phase=${phase}&rows=all`), phase).toEqual(mine[phase])
      expect((await ok('onlyR1', `/sales/orders/summary?phase=${phase}`)).all.orders.count, phase).toBe(mine[phase].length)
    }
    expect(board.notSent).toEqual({ waitsForYes: await waitingForYes(R1), waitsForDeposit: await confirmedDepositOpen(R1) })
    expect(board.notSent.waitsForYes).toBe(1) // T-CW-R1-YES; SEED-C1's T-CW-C1-YES is not counted
    expect(JSON.stringify(board)).not.toContain(C1)
    // Naming the other customer: every phase 0, both whys 0, no row, no file row.
    const other = await ok('onlyR1', `/sales/orders/board?partyId=${C1}`)
    expect((other.byPhase as Json[]).map((entry) => entry.count)).toEqual(ORDER_PHASES.map(() => 0))
    expect(other.notSent).toEqual({ waitsForYes: 0, waitsForDeposit: 0 })
    expect(await numbers('onlyR1', `phase=IN_PRODUCTION&partyId=${C1}`)).toEqual([])
    expect((await ok('onlyR1', `/sales/orders/summary?phase=IN_PRODUCTION&partyId=${C1}`)).all.orders.count).toBe(0)
    expect(await fileNumbers('onlyR1', `phase=IN_PRODUCTION&rows=all&party=${C1}`)).toEqual([])
  })

  it('phaseCountsByParty: each customer reads phaseCounts narrowed to it, together they are phaseCounts; a limited reader\'s where gives its own customers only', async () => {
    const today = businessDate(new Date())
    const read = async (session: string) => {
      const reader = callerFor(database, completeContext(SESSIONS[session]!(), `test-${newId()}`))
      const where = whereOf(officeContextOf(reader), {}, today)
      return reader.withClient(async (client) => {
        const all = await phaseCounts(client, where)
        const byParty = await phaseCountsByParty(client, where)
        const narrowed = new Map<string, Record<OrderPhase, number>>()
        for (const partyId of byParty.keys()) narrowed.set(partyId, await phaseCounts(client, { AND: [where, { partyId }] }))
        return { all, byParty, narrowed }
      })
    }
    const every = await read('all')
    // A where over two customers (SEED-C1 and SEED-R1 both have orders).
    expect([...every.byParty.keys()]).toEqual(expect.arrayContaining([C1, R1]))
    for (const phase of ORDER_PHASES) expect(sumOf([...every.byParty.values()].map((counts) => counts[phase])), phase).toBe(every.all[phase])
    for (const [partyId, counts] of every.byParty) {
      expect(Object.keys(counts).sort(), partyId).toEqual([...ORDER_PHASES].sort())
      expect(counts, partyId).toEqual(every.narrowed.get(partyId))
    }
    // The same numbers as the truth in SQL and as the board's byPhase (one rule, never a third way to count).
    const truth = await phaseTruth()
    const board = await ok('all', '/sales/orders/board')
    for (const phase of ORDER_PHASES) {
      expect(every.all[phase], phase).toBe(truth[phase].length)
      expect(every.all[phase], phase).toBe(countOf(board, phase))
    }
    const r1 = await phaseTruth(R1)
    expect(every.byParty.get(R1)).toEqual(Object.fromEntries(ORDER_PHASES.map((phase) => [phase, r1[phase].length])))
    // The limited reader's where: its own customers only, with the same counts.
    const limited = await read('onlyR1')
    expect([...limited.byParty.keys()]).toEqual([R1])
    expect(limited.byParty.get(R1)).toEqual(every.byParty.get(R1))
    expect(limited.all).toEqual(every.byParty.get(R1))
  })
})
// ── end B-CW-001 / B-CW-002 / B-CW-003 ──

// ── B-CL-005 (customers list, 13-backend §5): priority=<LEVEL> — OUR level, the door of a customer's "Top n" / "High n"; screen = file = count ──
/**
 * Stands on the made-up orders of the B-CW block above (copies of SEED-SO-0001), three of them moved to a level of OUR priority past
 * the order's own rules: T-CW-R1-SEW (SEED-R1, in production) and T-CW-C1-RDY (SEED-C1, ready) to URGENT ("Top"), T-CW-C1-CUT
 * (SEED-C1, in production) to HIGH. Every other order keeps its level (the seeds' NORMAL). The truth is counted here in SQL.
 */
describe('priority: our level narrows the list, the totals and the file alike; another value is refused (B-CL-005)', () => {
  beforeAll(async () => {
    await rulesOff(`UPDATE "SalesOrder" SET "priorityLevel" = 'URGENT' WHERE "tenantId" = '${tenant}' AND number IN ('T-CW-R1-SEW', 'T-CW-C1-RDY');
      UPDATE "SalesOrder" SET "priorityLevel" = 'HIGH' WHERE "tenantId" = '${tenant}' AND number = 'T-CW-C1-CUT';`)
  })

  /** The order numbers at a level, counted here in SQL (one customer's, the open ones only: not shipped yet). */
  async function atLevel(level: string, partyId?: string, openOnly = false): Promise<string[]> {
    const rows = await admin<{ number: string }>(
      `SELECT o.number FROM "SalesOrder" o WHERE o."tenantId" = $1 AND o."priorityLevel"::text = $2 AND ($3::uuid IS NULL OR o."partyId" = $3::uuid)
          AND (NOT $4::boolean OR o.status IN ('CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'))`,
      [tenant, level, partyId ?? null, openOnly],
    )
    return rows.map((row) => row.number).sort()
  }

  it('each level: the same rows on the list, in the totals (their door keeps the term) and in the file; the row door (open, one customer) too', async () => {
    const top = await atLevel('URGENT')
    expect(top).toEqual(expect.arrayContaining(['T-CW-C1-RDY', 'T-CW-R1-SEW']))
    expect(await atLevel('HIGH')).toEqual(expect.arrayContaining(['T-CW-C1-CUT']))
    for (const level of ['LOW', 'NORMAL', 'HIGH', 'URGENT']) {
      const expected = await atLevel(level)
      expect(await numbers('all', `priority=${level}`), level).toEqual(expected)
      const summary = await ok('all', `/sales/orders/summary?priority=${level}`)
      expect(summary.all.orders.count, level).toBe(expected.length)
      expect(summary.all.orders.filter, level).toMatchObject({ priority: level })
      expect(await fileNumbers('all', `priority=${level}&rows=all`), level).toEqual(expected)
    }
    // The levels split every order (each has exactly one).
    const every = (await numbers('all', '')).length
    let summed = 0
    for (const level of ['LOW', 'NORMAL', 'HIGH', 'URGENT']) summed += (await atLevel(level)).length
    expect(summed).toBe(every)
    // A customer row's "Top n" door: that customer's OPEN orders at the level (the file's default view is the open orders too).
    expect(await numbers('all', `open=true&priority=URGENT&partyId=${R1}`)).toEqual(await atLevel('URGENT', R1, true))
    expect(await numbers('all', `open=true&priority=URGENT&partyId=${R1}`)).toEqual(['T-CW-R1-SEW'])
    expect(await numbers('all', `open=true&priority=HIGH&partyId=${C1}`)).toEqual(await atLevel('HIGH', C1, true))
    expect(await fileNumbers('all', 'priority=HIGH')).toEqual(await atLevel('HIGH', undefined, true))
  })

  it('a person limited to SEED-R1 reads its own orders at a level only; naming SEED-C1 counts nothing', async () => {
    expect(await numbers('onlyR1', 'priority=URGENT')).toEqual(await atLevel('URGENT', R1))
    expect(await numbers('onlyR1', 'priority=URGENT')).not.toContain('T-CW-C1-RDY')
    expect(await numbers('onlyR1', `priority=HIGH&partyId=${C1}`)).toEqual([])
    expect((await ok('onlyR1', `/sales/orders/summary?priority=URGENT&partyId=${C1}`)).all.orders.count).toBe(0)
    expect(await fileNumbers('onlyR1', 'priority=URGENT&rows=all')).toEqual(await atLevel('URGENT', R1))
  })

  it('another value is refused in words (400) on the list and in the totals, and by the file (never a file of every order)', async () => {
    for (const url of ['/sales/orders?priority=NOPE', '/sales/orders/summary?priority=NOPE', '/sales/orders?priority=urgent', '/sales/orders?priority=TOP']) {
      expect((await app.inject({ method: 'GET', url, headers: { 'x-test-session': 'all' } })).statusCode, url).toBe(400)
    }
    expect(() => exportSourceOf('sales.orders')!.query(new URLSearchParams('priority=NOPE'))).toThrow('Not a value of priority: the file would not follow the screen.')
  })
})
// ── end B-CL-005 ──

