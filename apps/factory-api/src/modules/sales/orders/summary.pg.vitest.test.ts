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
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'

/**
 * T30 (B-TH-058; threads plan TH-4, SHEET-G08; features SHEET.overall-F02, -F03, -F08, -F11; wall surface W30): the overall
 * view's honest totals, GET /sales/orders/summary, on a throwaway PostgreSQL 17 database from the migrations (the runtime
 * login: row-level security is real) with the factory-db seeds up to money (customer A = SEED-C1 with its orders, one
 * copied in USD) and four made-up orders of customer B = SEED-R1: late (promised yesterday), at risk (promised in two days,
 * the ORDER_LATE_RISK rule says five), promised in a month, and one cancelled. Every name and number is made up.
 *
 *   - grouped by customer: one group per customer, by name, with its invoicing rhythm; every figure of every group and of the
 *     whole view opens exactly what it counts (its filter read through GET /sales/orders: the count of rows, or the sum of
 *     their pieces and nets);
 *   - money: the net per currency, never summed across currencies, and only with the price grain (absent, not empty);
 *   - the view's own terms carry into every door; a door the view already pins to another value counts nothing;
 *   - the wall (T30): a person limited to customer A reads A's figures and A's group only — no name, id or count of B.
 *
 * Run with `node scripts/factory/run-pg-tests.mjs modules/sales/orders/summary.pg`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const NS = 'th4-summary'
const id = (key: string): string => seedUuid(NS, key)
const tenant = id('tenant')
const C1 = id('party:P1')
const R1 = id('party:P4')
const TODAY = businessDate(new Date())

const grant = (permissions: readonly Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const office = (permissions: readonly Permission[], parties: Grant['parties'] = 'all') => (): SessionContext => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(permissions, parties)] })
const PRICE = 'money.price' as Permission
const SESSIONS: Record<string, () => SessionContext> = {
  all: office(['orders.view', PRICE]),
  noPrice: office(['orders.view']),
  onlyA: office(['orders.view', PRICE], [C1]),
  onlyB: office(['orders.view'], [R1]),
  noOrders: office(['quotes.view']),
  partner: () => ({ audience: 'partner', tenantId: tenant, actorId: newId(), partyId: C1, grants: [grant(['orders.view'], [C1])] }),
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-test-session': session } })
async function ok(session: string, url: string): Promise<Json> {
  const response = await call(session, url)
  expect(response.statusCode, `${session} ${url}: ${response.body.slice(0, 400)}`).toBe(200)
  return response.json()
}
const query = (terms: Record<string, string>): string => new URLSearchParams(terms).toString()

/** A version-4 UUID derived from an id and a salt (the copies' ids are valid UUIDs, as the contracts ask). */
const v4 = (expression: string, salt: string): string => {
  const hash = `md5(${expression}::text || '${salt}')`
  return `(substr(${hash}, 1, 8) || '-' || substr(${hash}, 9, 4) || '-4' || substr(${hash}, 14, 3) || '-8' || substr(${hash}, 18, 3) || '-' || substr(${hash}, 21, 12))::uuid`
}

/** SEED-SO-0001 copied for a customer as `number`: ordered, promised, its currency as given; CANCELLED after its lines are in. */
async function copyOrder(number: string, partyId: string, promiseDate: string, fields: { status?: string; currency?: string } = {}): Promise<void> {
  const salt = number.toLowerCase()
  await admin(
    `CREATE TEMP TABLE o AS SELECT * FROM "SalesOrder" WHERE "tenantId" = '${tenant}' AND number = 'SEED-SO-0001';
     CREATE TEMP TABLE l AS SELECT * FROM "SalesOrderLine" WHERE "orderId" = (SELECT id FROM o);
     CREATE TEMP TABLE s AS SELECT * FROM "SalesOrderLineSize" WHERE "lineId" IN (SELECT id FROM l);
     UPDATE s SET id = ${v4('id', salt)}, "lineId" = ${v4('"lineId"', salt)}, "partyId" = '${partyId}';
     UPDATE l SET id = ${v4('id', salt)}, "orderId" = ${v4('"orderId"', salt)}, "partyId" = '${partyId}', "quoteLineId" = NULL, "styleRevisionId" = NULL;
     UPDATE o SET id = ${v4('id', salt)}, "partyId" = '${partyId}', number = '${number}', "quoteVersionId" = NULL, "customerRef" = NULL, "customerSeq" = NULL,
       "orderDate" = '${TODAY}', "promiseDate" = '${promiseDate}', "originalPromiseDate" = '${promiseDate}', currency = '${fields.currency ?? 'EUR'}',
       status = 'CONFIRMED', "cancelReason" = NULL, "closedAt" = NULL, "createdAt" = now(), "updatedAt" = now();
     INSERT INTO "SalesOrder" SELECT * FROM o;
     INSERT INTO "SalesOrderLine" SELECT * FROM l;
     INSERT INTO "SalesOrderLineSize" SELECT * FROM s;
     DROP TABLE o, l, s;`,
  )
  // The lines go in while the order is CONFIRMED (the database's rule); then it is cancelled.
  if (fields.status === 'CANCELLED') await admin(`UPDATE "SalesOrder" SET status = 'CANCELLED', "cancelReason" = 'Made-up cancel', "closedAt" = now() WHERE "tenantId" = $1 AND number = $2`, [tenant, number])
}

/** Every row a door's filter opens (the list read one page of all of them). */
async function opened(session: string, filter: Record<string, string>): Promise<Json[]> {
  const answer = await ok(session, `/sales/orders?limit=200&${query(filter)}`)
  expect(answer.nextCursor, 'one page holds every row of the test').toBeNull()
  return answer.orders as Json[]
}

/** Every door of one figures block opens exactly what it counts (rows, or the sum of their pieces and nets). */
async function expectDoorsExact(session: string, figures: Json, label: string): Promise<void> {
  const sum = (rows: Json[], key: string) => rows.reduce((total, row) => total + Number(row[key] ?? 0), 0)
  const check = async (name: string, door: Json, measure: (rows: Json[]) => number) => {
    if (door.filter === null) {
      expect(door.count, `${label} ${name}: a door without a filter counts nothing`).toBe(0)
      return
    }
    expect(measure(await opened(session, door.filter)), `${label} ${name}`).toBe(door.count)
  }
  await check('orders', figures.orders, (rows) => rows.length)
  await check('pieces.ordered', figures.pieces.ordered, (rows) => sum(rows, 'units'))
  await check('pieces.shipped', figures.pieces.shipped, (rows) => sum(rows, 'shippedUnits'))
  await check('pieces.open', figures.pieces.open, (rows) => sum(rows, 'openUnits'))
  await check('late', figures.late, (rows) => rows.length)
  await check('atRisk', figures.atRisk, (rows) => rows.length)
  for (const state of ['NONE', 'PART', 'ALL']) await check(`invoiced.${state}`, figures.invoiced[state], (rows) => rows.length)
  for (const entry of (figures.net ?? []) as Json[]) {
    if (entry.filter === null) continue
    const rows = await opened(session, entry.filter)
    expect(new Set(rows.map((row) => row.currency)), `${label} net ${entry.currency}: its rows are of its currency`).toEqual(new Set(rows.length > 0 ? [entry.currency] : []))
    expect(sum(rows, 'netAmount'), `${label} net ${entry.currency}`).toBe(entry.amount)
  }
}

beforeAll(async () => {
  db = await migratedDatabase('orders_summary')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: NS })
  await seedMoney({ db: database, namespace: NS })
  await copyOrder('T058-A-USD', C1, addDays(TODAY, 40), { currency: 'USD' })
  await copyOrder('T058-B-LATE', R1, addDays(TODAY, -1))
  await copyOrder('T058-B-RISK', R1, addDays(TODAY, 2))
  await copyOrder('T058-B-LATER', R1, addDays(TODAY, 30))
  await copyOrder('T058-B-CANCELLED', R1, addDays(TODAY, 3), { status: 'CANCELLED' })
  // One ORDER_LATE_RISK rule for every company: five days before the promise (the seeds' own rules switched off).
  await admin(`UPDATE "AlertRule" SET enabled = false WHERE "tenantId" = $1 AND "ruleKind" = 'ORDER_LATE_RISK'`, [tenant])
  await admin(`INSERT INTO "AlertRule" (id, "tenantId", "ruleKind", trigger, name, threshold, enabled) VALUES ($1, $2, 'ORDER_LATE_RISK', 'CONDITION', 'Made-up risk rule', '{"daysBeforePromise": 5}'::jsonb, true)`, [newId(), tenant])
  await admin(`UPDATE "Party" SET "invoiceTiming" = 'MONTHLY' WHERE id = $1`, [R1])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET, rateLimit: { max: 10_000, timeWindowMs: 60_000 } },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('GET /sales/orders/summary (B-TH-058)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('grouped by customer: one group each, by name, with its invoicing rhythm; the whole view is every order the reader sees', async () => {
    const answer = await ok('all', '/sales/orders/summary?group=party')
    const [orders] = await admin<{ count: string }>(`SELECT count(*) FROM "SalesOrder" WHERE "tenantId" = $1`, [tenant])
    expect(answer.all.orders).toEqual({ count: Number(orders!.count), filter: {} })
    // By name: "Seed Customer One S.r.l." before "Seed Private Rider".
    expect(answer.groups.map((group: Json) => group.partyId)).toEqual([C1, R1])
    expect(answer.groups.map((group: Json) => group.name)).toEqual([...answer.groups.map((group: Json) => group.name)].sort(new Intl.Collator('it', { sensitivity: 'base', numeric: true }).compare))
    const rider = answer.groups.find((group: Json) => group.partyId === R1)
    expect(rider).toMatchObject({ code: 'SEED-R1', invoiceTiming: 'MONTHLY' })
    expect(answer.groups.find((group: Json) => group.partyId === C1)).toMatchObject({ code: 'SEED-C1', invoiceTiming: 'PER_SHIPMENT' })
    // B: four orders, one late, one at risk (two days left, the rule says five), the cancelled one owes no piece.
    expect(rider.figures.orders).toEqual({ count: 4, filter: { partyId: R1 } })
    expect(rider.figures.late).toEqual({ count: 1, filter: { partyId: R1, late: 'true' } })
    expect(rider.figures.atRisk).toEqual({ count: 1, filter: { partyId: R1, atRisk: 'true' } })
    expect(answer.limited).toBe(false)
    expect(answer.asOf).toEqual(expect.any(String))
    // Without group: no groups.
    expect((await ok('all', '/sales/orders/summary')).groups).toBeNull()
  })

  it('every figure of every group and of the whole view opens exactly what it counts (overall-F11)', async () => {
    const answer = await ok('all', '/sales/orders/summary?group=party')
    await expectDoorsExact('all', answer.all, 'all')
    for (const group of answer.groups as Json[]) await expectDoorsExact('all', group.figures, group.code)
    // The groups add up to the whole view (counts and pieces; money per currency).
    const groups = answer.groups as Json[]
    expect(groups.reduce((total, group) => total + group.figures.orders.count, 0)).toBe(answer.all.orders.count)
    expect(groups.reduce((total, group) => total + group.figures.pieces.open.count, 0)).toBe(answer.all.pieces.open.count)
  })

  it('money: the net per currency, never summed across currencies; absent without the price grain', async () => {
    const answer = await ok('all', '/sales/orders/summary?group=party')
    expect(answer.all.net.map((entry: Json) => entry.currency)).toEqual(['EUR', 'USD'])
    const [usd] = await admin<{ net: string }>(`SELECT sum("netAmount") AS net FROM "SalesOrder" WHERE "tenantId" = $1 AND currency = 'USD'`, [tenant])
    expect(answer.all.net.find((entry: Json) => entry.currency === 'USD')).toEqual({ currency: 'USD', amount: Number(usd!.net), filter: { currency: 'USD' } })
    // A's group holds both currencies apart; B's only euros.
    expect(answer.groups.find((group: Json) => group.partyId === C1).figures.net.map((entry: Json) => entry.currency)).toEqual(['EUR', 'USD'])
    expect(answer.groups.find((group: Json) => group.partyId === R1).figures.net.map((entry: Json) => entry.currency)).toEqual(['EUR'])
    // No price grain: no amount anywhere, every count stays.
    const blind = await ok('noPrice', '/sales/orders/summary?group=party')
    expect(JSON.stringify(blind)).not.toContain('"net"')
    expect(JSON.stringify(blind)).not.toContain('"amount"')
    expect(blind.all.orders.count).toBe(answer.all.orders.count)
    expect(blind.all.pieces).toEqual(answer.all.pieces)
  })

  it("the view's own terms carry into every door; a door the view pins to another value counts nothing", async () => {
    const late = await ok('all', '/sales/orders/summary?late=true&group=party')
    expect(late.all.orders.count).toBe(late.all.late.count)
    expect(late.all.late.filter).toEqual({ late: 'true' })
    expect(late.groups.map((group: Json) => group.partyId)).toEqual(expect.arrayContaining([R1]))
    await expectDoorsExact('all', late.all, 'late view')
    const none = await ok('all', '/sales/orders/summary?invoiced=NONE')
    expect(none.all.invoiced.PART).toEqual({ count: 0, filter: null })
    expect(none.all.invoiced.ALL).toEqual({ count: 0, filter: null })
    expect(none.all.invoiced.NONE.count).toBe(none.all.orders.count)
    await expectDoorsExact('all', none.all, 'invoiced view')
    // The board counts the same view: its states add up to the summary's orders under the same terms.
    for (const terms of [{ invoiced: 'NONE' }, { atRisk: 'true' }, { currency: 'USD' }] as Record<string, string>[]) {
      const board = await ok('all', `/sales/orders/board?${query(terms)}`)
      const summary = await ok('all', `/sales/orders/summary?${query(terms)}`)
      expect(board.byStatus.reduce((total: number, row: Json) => total + row.count, 0), JSON.stringify(terms)).toBe(summary.all.orders.count)
    }
    // A malformed term is refused like the list refuses it.
    expect((await call('all', '/sales/orders/summary?invoiced=SOME')).statusCode).toBe(400)
    expect((await call('all', '/sales/orders/summary?currency=euro')).statusCode).toBe(400)
    expect((await call('all', '/sales/orders/summary?group=company')).statusCode).toBe(400)
  })

  it('office only, with orders.view', async () => {
    expect((await call('noOrders', '/sales/orders/summary')).statusCode).toBe(403)
    expect((await call('partner', '/sales/orders/summary')).statusCode).toBe(403)
  })
})

describe('the brand wall (T30): a person limited to one customer', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it("limited to A: A's figures and A's group only; no name, id or count of B; the doors open A's rows only", async () => {
    const answer = await ok('onlyA', '/sales/orders/summary?group=party')
    expect(answer.limited).toBe(true)
    expect(answer.groups.map((group: Json) => group.partyId)).toEqual([C1])
    const [mine] = await admin<{ count: string }>(`SELECT count(*) FROM "SalesOrder" WHERE "tenantId" = $1 AND "partyId" = $2`, [tenant, C1])
    expect(answer.all.orders.count).toBe(Number(mine!.count))
    const text = JSON.stringify(answer)
    expect(text).not.toContain(R1)
    expect(text).not.toContain('Seed Private Rider')
    expect(text).not.toContain('SEED-R1')
    await expectDoorsExact('onlyA', answer.all, 'onlyA')
    // Asking for B's figures by its id: nothing at all, no group.
    const other = await ok('onlyA', `/sales/orders/summary?group=party&partyId=${R1}`)
    expect(other.groups).toEqual([])
    expect(other.all.orders.count).toBe(0)
    expect(other.all.net).toEqual([])
    // A search for B's name finds nothing either.
    expect((await ok('onlyA', '/sales/orders/summary?q=rider')).all.orders.count).toBe(0)
  })

  it("limited to B: B's group only, never A's", async () => {
    const answer = await ok('onlyB', '/sales/orders/summary?group=party')
    expect(answer.groups.map((group: Json) => group.partyId)).toEqual([R1])
    expect(answer.all.orders.count).toBe(4)
    expect(JSON.stringify(answer)).not.toContain('Seed Customer One')
    expect(JSON.stringify(answer)).not.toContain(C1)
  })
})
