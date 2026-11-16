import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedMoney } from '../../../../../../packages/factory-db/seed/money'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * The Customer switcher's numbers (B-TH-019; threads plan TH-1a, picture 24; wall test T30): GET /sales/orders/customers
 * and the board's customer term, on a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level
 * security is real) with the factory-db seeds up to money (the orders of customer SEED-C1) and two orders copied for the
 * second customer SEED-R1: one ordered today and late (promised yesterday), one promised later. Every name and
 * number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/orders`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const NS = 'th1a-customers'
const id = (key: string): string => seedUuid(NS, key)
const tenant = id('tenant')
const companyA = id('company:A')
const companyB = id('company:B')
const C1 = id('party:P1')
const R1 = id('party:P4')
const TODAY = businessDate(new Date())

const grant = (permissions: readonly Permission[], parties: Grant['parties'] = 'all', companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties })
const office = (permissions: readonly Permission[], parties: Grant['parties'] = 'all', companies: Grant['companies'] = 'all') => (): SessionContext => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(permissions, parties, companies)] })
const SESSIONS: Record<string, () => SessionContext> = {
  all: office(['orders.view']),
  onlyR1: office(['orders.view'], [R1]),
  onlyC1: office(['orders.view'], [C1]),
  companyB: office(['orders.view'], 'all', [companyB]),
  noOrders: office(['quotes.view']),
  partner: () => ({ audience: 'partner', tenantId: tenant, actorId: newId(), partyId: C1, grants: [grant(['orders.view'], [C1])] }),
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-test-session': session } })
async function ok(session: string, url: string): Promise<Json> {
  const response = await call(session, url)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

/** A version-4 UUID derived from an id and a salt (the copies' ids are valid UUIDs, as the contracts ask). */
const v4 = (expression: string, salt: string): string => {
  const hash = `md5(${expression}::text || '${salt}')`
  return `(substr(${hash}, 1, 8) || '-' || substr(${hash}, 9, 4) || '-4' || substr(${hash}, 14, 3) || '-8' || substr(${hash}, 18, 3) || '-' || substr(${hash}, 21, 12))::uuid`
}

/** SEED-SO-0001 copied for SEED-R1 as `number`, ordered and promised on the days given. */
async function copyForRider(number: string, orderDate: string, promiseDate: string): Promise<void> {
  const salt = number.toLowerCase()
  await admin(
    `CREATE TEMP TABLE o AS SELECT * FROM "SalesOrder" WHERE "tenantId" = '${tenant}' AND number = 'SEED-SO-0001';
     CREATE TEMP TABLE l AS SELECT * FROM "SalesOrderLine" WHERE "orderId" = (SELECT id FROM o);
     CREATE TEMP TABLE s AS SELECT * FROM "SalesOrderLineSize" WHERE "lineId" IN (SELECT id FROM l);
     UPDATE s SET id = ${v4('id', salt)}, "lineId" = ${v4('"lineId"', salt)}, "partyId" = '${R1}';
     UPDATE l SET id = ${v4('id', salt)}, "orderId" = ${v4('"orderId"', salt)}, "partyId" = '${R1}', "quoteLineId" = NULL, "styleRevisionId" = NULL;
     UPDATE o SET id = ${v4('id', salt)}, "partyId" = '${R1}', number = '${number}', "quoteVersionId" = NULL, "customerRef" = NULL,
       "orderDate" = '${orderDate}', "promiseDate" = '${promiseDate}', "originalPromiseDate" = '${promiseDate}', "createdAt" = now(), "updatedAt" = now();
     INSERT INTO "SalesOrder" SELECT * FROM o;
     INSERT INTO "SalesOrderLine" SELECT * FROM l;
     INSERT INTO "SalesOrderLineSize" SELECT * FROM s;
     DROP TABLE o, l, s;`,
  )
}

/** What the switcher must say of a customer, counted here in SQL with the same definitions. */
async function expected(partyId: string) {
  const [row] = await admin<{ orders: string; open: string; late: string }>(
    `SELECT count(*) AS orders,
            count(*) FILTER (WHERE status IN ('CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED')) AS open,
            count(*) FILTER (WHERE status IN ('CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED') AND "promiseDate" < $3::date) AS late
       FROM "SalesOrder" WHERE "tenantId" = $1 AND "partyId" = $2`,
    [tenant, partyId, TODAY],
  )
  return { orders: Number(row!.orders), open: Number(row!.open), late: Number(row!.late) }
}

beforeAll(async () => {
  db = await migratedDatabase('orders_customers')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: NS })
  await seedMoney({ db: database, namespace: NS })
  await copyForRider('TEST-SO-R1-LATE', TODAY, addDays(TODAY, -1))
  await copyForRider('TEST-SO-R1-LATER', addDays(TODAY, -40), addDays(TODAY, 30))
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

describe('GET /sales/orders/customers (B-TH-019)', () => {
  it('lists the customers with orders, most recent order first, with their open and late counts', async () => {
    const answer = await ok('all', '/sales/orders/customers')
    expect(answer.total).toBe(2)
    expect(answer.customers).toEqual([
      { id: R1, code: 'SEED-R1', name: 'Seed Private Rider', archived: false, ...(await expected(R1)), lastOrderDate: TODAY },
      { id: C1, code: 'SEED-C1', name: 'Seed Customer One S.r.l.', archived: false, ...(await expected(C1)), lastOrderDate: expect.any(String) },
    ])
    // The rider: two orders, both open, one late (promised yesterday, not shipped).
    expect(answer.customers[0]).toMatchObject({ orders: 2, open: 2, late: 1 })
    expect(answer.asOf).toEqual(expect.any(String))
  })

  it('finds a customer by name or code; the total says how many match beyond the limit', async () => {
    expect((await ok('all', '/sales/orders/customers?q=rider')).customers.map((row: Json) => row.id)).toEqual([R1])
    expect((await ok('all', '/sales/orders/customers?q=seed-c1')).customers.map((row: Json) => row.id)).toEqual([C1])
    expect(await ok('all', '/sales/orders/customers?q=nobody')).toMatchObject({ customers: [], total: 0 })
    const first = await ok('all', '/sales/orders/customers?limit=1')
    expect(first.customers.map((row: Json) => row.id)).toEqual([R1])
    expect(first.total).toBe(2)
  })

  it('narrows to a company; an archived customer is tagged', async () => {
    expect((await ok('all', `/sales/orders/customers?companyId=${companyB}`)).customers).toEqual([])
    expect((await ok('all', `/sales/orders/customers?companyId=${companyA}`)).total).toBe(2)
    await admin(`UPDATE "Party" SET status = 'ARCHIVED' WHERE id = $1`, [R1])
    try {
      expect((await ok('all', '/sales/orders/customers')).customers[0]).toMatchObject({ id: R1, archived: true })
    } finally {
      await admin(`UPDATE "Party" SET status = 'ACTIVE' WHERE id = $1`, [R1])
    }
  })

  it('office only, with orders.view', async () => {
    expect((await call('noOrders', '/sales/orders/customers')).statusCode).toBe(403)
    expect((await call('partner', '/sales/orders/customers')).statusCode).toBe(403)
  })
})

describe('the brand wall (T30): a person limited to one customer', () => {
  it('limited to SEED-R1: the switcher holds SEED-R1 only, with its own counts; no name or count of SEED-C1', async () => {
    const answer = await ok('onlyR1', '/sales/orders/customers')
    expect(answer).toMatchObject({ total: 1, customers: [{ id: R1, orders: 2, open: 2, late: 1 }] })
    expect(JSON.stringify(answer)).not.toContain('Seed Customer One')
    expect(JSON.stringify(answer)).not.toContain(C1)
    // A search for the other customer finds nothing (no hint it exists).
    expect(await ok('onlyR1', '/sales/orders/customers?q=customer%20one')).toMatchObject({ customers: [], total: 0 })
  })

  it('limited to SEED-C1: never SEED-R1; a person of another company: no customer at all', async () => {
    const answer = await ok('onlyC1', '/sales/orders/customers')
    expect(answer.customers.map((row: Json) => row.id)).toEqual([C1])
    expect(JSON.stringify(answer)).not.toContain('Seed Private Rider')
    expect(await ok('companyB', '/sales/orders/customers')).toMatchObject({ customers: [], total: 0 })
  })

  it('the board takes the same customer term: its counts are the customer\'s, and nothing of another customer leaks through it', async () => {
    const board = await ok('all', `/sales/orders/board?partyId=${R1}`)
    expect(board.tiles.find((tile: Json) => tile.key === 'late').count).toBe(1)
    expect(board.byStatus.find((row: Json) => row.status === 'CONFIRMED').count).toBe(2)
    const mine = await ok('onlyR1', '/sales/orders/board')
    expect(mine.byStatus.reduce((sum: number, row: Json) => sum + row.count, 0)).toBe(2)
    const other = await ok('onlyC1', `/sales/orders/board?partyId=${R1}`)
    expect(other.byStatus.every((row: Json) => row.count === 0)).toBe(true)
    expect(other.tiles.every((tile: Json) => tile.count === 0)).toBe(true)
  })
})
