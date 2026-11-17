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

/**
 * The orders sheet's own terms (threads plan TH-1a, pictures 23 + 24; B-TH-225 / B-TH-226, API part): `brand` narrows
 * GET /sales/orders and the board's counts to the orders with a line of a style of that label (a party id, or `own` = our
 * own collection), and GET /sales/orders/customers says whether the reader is limited to some customers (`limited`: the
 * switcher's "All my customers (n)" and a fixed label for one) without a word of the customers outside. On a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security is real) with the factory-db seeds up to
 * money and the options (the own-collection liner SEED-LNR-01): SEED-SO-0001 / SEED-SO-0002 of customer SEED-C1 (its
 * private-label jacket SEED-JKT-01), and TEST-SO-R1, a copy for customer SEED-R1 whose first line is the own-collection
 * liner and whose second keeps SEED-C1's jacket. Every name and number is made up. Run with
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
    // The term keeps every other term: one customer's orders of that label.
    expect(await numbers('all', `brand=${C1}&partyId=${R1}`)).toEqual(['TEST-SO-R1'])
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
    expect(await numbers('onlyR1', `brand=${C1}`)).toEqual(['TEST-SO-R1'])
    expect(await boardTotal('onlyR1', `brand=${C1}`)).toBe(1)
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
