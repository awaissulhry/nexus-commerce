import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { PARTY_WORK_GROUPS } from '@nexus/factory-domain/parties/contracts'
import { ORDER_PHASES } from '@nexus/factory-domain/production-brand/stages'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedMoney } from '../../../../../../packages/factory-db/seed/money'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor, command } from '../../../core/command'
import { completeContext, testAuthenticator, type RequestContext, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { customers as customersFile, suppliers as suppliersFile } from '../../../platform/exports/sources/parties'
import { ensureThread, writeMessage } from '../../../platform/threads/threads'

/**
 * B-CL-001 … B-CL-007 (customers list, 13-backend §1–§5, §7; 15-steps S1.3): where each customer's work stands — GET
 * /sales/orders/customers/work for a page of customers, and GET /parties' `band=true`, `work=` and `sort=needs` — on a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security is real), set up as its neighbour
 * ./customers.pg.vitest.test.ts: the factory-db seeds up to money (SEED-C1's orders SEED-SO-0001 / SEED-SO-0002; the customers
 * SEED-C1, SEED-C2 (no order) and SEED-R1), and made-up copies of SEED-SO-0001 for SEED-R1, each put in its state past the order's own
 * rules (the guards off: only the reads are under test):
 *
 *   TEST-SO-R1-LATE   ordered today, promised yesterday (late)        TEST-SO-R1-LATER  ordered 40 days ago, promised in 30 days
 *   T-CL-R1-CUT       in production, kept at CUTTING, our level HIGH, promised in 10 days
 *   T-CL-R1-YES       waiting for a yes, promised in 2 days (not an open order: never the next promise)
 *   T-CL-R1-DEP       confirmed, its deposit request OPEN, promised in 15 days
 *   T-CL-R1-TOP       confirmed, our level URGENT ("Top"), promised in 5 days (the next promise)
 *   T-CL-R1-DONE      delivered (Done)
 *   two OPEN customer requests (on TEST-SO-R1-LATER, two days ago; on T-CL-R1-CUT, today), and a reply waiting on SEED-R1's own
 *   conversation (the customer wrote last); a reply waiting on SEED-C1's own conversation too.
 *   B-CL-009: T-CL-Q-R1, an open (DRAFT) quote of SEED-R1 copied from the seeds' SEED-Q-0002.
 *
 * Sessions (each with parties.view): all (+ threads.read) · onlyR1 · onlyC1 · companyB · noOrders (parties and quotes, no orders) ·
 * partiesAllOrdersR1 (parties over every customer, orders over SEED-R1 only) · partner · sales (the real Sales template: the money
 * wall) · B-CL-009: quotes (quotes.view + sales.inquiries.view), quotesOnlyR1, quotesNoRequests. Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/orders/customer-work`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const NS = 'cl-customer-work'
const id = (key: string): string => seedUuid(NS, key)
const tenant = id('tenant')
const companyB = id('company:B')
const C1 = id('party:P1')
const C2 = id('party:P3')
const R1 = id('party:P4')
const TODAY = businessDate(new Date())
const DAY = 86_400_000
const writer = newId()

const grant = (permissions: readonly Permission[], parties: Grant['parties'] = 'all', companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties })
const office = (...grants: Grant[]) => (): SessionContext => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants })
const salesTemplate = (): Permission[] => {
  const template = templateOf('sales')!
  return [...template.permissions, ...template.grains.map((grain) => `money.${grain}`)] as Permission[]
}
const SESSIONS: Record<string, () => SessionContext> = {
  all: office(grant(['orders.view', 'parties.view', 'threads.read'])),
  onlyR1: office(grant(['orders.view', 'parties.view', 'threads.read'], [R1])),
  onlyC1: office(grant(['orders.view', 'parties.view'], [C1])),
  companyB: office(grant(['orders.view', 'parties.view'], 'all', [companyB])),
  noOrders: office(grant(['parties.view', 'quotes.view'])),
  partiesAllOrdersR1: office(grant(['parties.view', 'threads.read']), grant(['orders.view'], [R1])),
  partner: () => ({ audience: 'partner', tenantId: tenant, actorId: newId(), partyId: C1, grants: [grant(['orders.view', 'parties.view'], [C1])] }),
  sales: office(grant(salesTemplate())),
  // ── B-CL-009 (S1b): readers of the quotes and the requests (cq's two parts), over every customer or SEED-R1 only; quotes only ──
  quotes: office(grant(['orders.view', 'parties.view', 'quotes.view', 'sales.inquiries.view'])),
  quotesOnlyR1: office(grant(['orders.view', 'parties.view', 'quotes.view', 'sales.inquiries.view'], [R1])),
  quotesNoRequests: office(grant(['orders.view', 'parties.view', 'quotes.view'])),
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-test-session': session } })
async function ok(session: string, url: string): Promise<Json> {
  const response = await call(session, url)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
/** The rows a door of the customer's Work tab opens: the orders list's own terms (GET /sales/orders). */
const doorRows = async (session: string, query: string): Promise<number> => ((await ok(session, `/sales/orders?limit=200&${query}`)).orders as Json[]).length
const work = (session: string, ids: readonly string[]) => ok(session, `/sales/orders/customers/work?partyIds=${ids.join(',')}`)
const rowOf = (answer: Json, partyId: string): Json => (answer.customers as Json[]).find((row) => row.partyId === partyId)!
const partyIdsOf = (answer: Json): string[] => (answer.parties as Json[]).map((row) => row.id as string)
const CUSTOMERS = 'role=CUSTOMER,BRAND'

/** A made-up fact written past the order's own rules (the guards off: only the reads are under test). */
const rulesOff = (statements: string) => admin(`BEGIN; SET LOCAL session_replication_role = replica; ${statements} COMMIT;`)

/** A version-4 UUID derived from an id and a salt (the copies' ids are valid UUIDs, as the contracts ask). */
const v4 = (expression: string, salt: string): string => {
  const hash = `md5(${expression}::text || '${salt}')`
  return `(substr(${hash}, 1, 8) || '-' || substr(${hash}, 9, 4) || '-4' || substr(${hash}, 14, 3) || '-8' || substr(${hash}, 18, 3) || '-' || substr(${hash}, 21, 12))::uuid`
}

/** SEED-SO-0001 copied for SEED-R1 (or the customer given) as `number`, CONFIRMED, ordered and promised on the days given (its lines and sizes too). */
async function copyForRider(number: string, orderDate: string, promiseDate: string, partyId: string = R1): Promise<void> {
  const salt = number.toLowerCase()
  await admin(
    `CREATE TEMP TABLE o AS SELECT * FROM "SalesOrder" WHERE "tenantId" = '${tenant}' AND number = 'SEED-SO-0001';
     CREATE TEMP TABLE l AS SELECT * FROM "SalesOrderLine" WHERE "orderId" = (SELECT id FROM o);
     CREATE TEMP TABLE s AS SELECT * FROM "SalesOrderLineSize" WHERE "lineId" IN (SELECT id FROM l);
     UPDATE s SET id = ${v4('id', salt)}, "lineId" = ${v4('"lineId"', salt)}, "partyId" = '${partyId}';
     UPDATE l SET id = ${v4('id', salt)}, "orderId" = ${v4('"orderId"', salt)}, "partyId" = '${partyId}', "quoteLineId" = NULL, "styleRevisionId" = NULL;
     UPDATE o SET id = ${v4('id', salt)}, "partyId" = '${partyId}', number = '${number}', "quoteVersionId" = NULL, "customerRef" = NULL, "customerSeq" = NULL,
       status = 'CONFIRMED', "cancelReason" = NULL, "closedAt" = NULL,
       "orderDate" = '${orderDate}', "promiseDate" = '${promiseDate}', "originalPromiseDate" = '${promiseDate}', "createdAt" = now(), "updatedAt" = now();
     INSERT INTO "SalesOrder" SELECT * FROM o;
     INSERT INTO "SalesOrderLine" SELECT * FROM l;
     INSERT INTO "SalesOrderLineSize" SELECT * FROM s;
     DROP TABLE o, l, s;`,
  )
}
const orderSql = (number: string) => `"tenantId" = '${tenant}' AND number = '${number}'`
/** The order's status (closed, cancelled and delivered with nothing else) and our level, set by hand. */
const setOrder = (number: string, fields: { status?: string; level?: string }) =>
  rulesOff(
    [fields.status ? `UPDATE "SalesOrder" SET status = '${fields.status}' WHERE ${orderSql(number)};` : '', fields.level ? `UPDATE "SalesOrder" SET "priorityLevel" = '${fields.level}' WHERE ${orderSql(number)};` : ''].join(' '),
  )
/** The order's kept production row at a stage. */
const keep = (number: string, stage: string) =>
  rulesOff(`INSERT INTO "BrandOrderProduction" (id, "tenantId", "companyId", "partyId", "salesOrderId", key, stage, "stageAt")
    SELECT '${newId()}', o."tenantId", o."companyId", o."partyId", o.id, 'brand-production:' || o.id, '${stage}', now() FROM "SalesOrder" o WHERE o."tenantId" = '${tenant}' AND o.number = '${number}'
    ON CONFLICT ("tenantId", key) DO UPDATE SET stage = EXCLUDED.stage, "stageAt" = now();`)
/** An OPEN deposit request of the order (the deposit itself, no schedule step). */
const askDeposit = (number: string) =>
  rulesOff(`INSERT INTO "DepositRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, currency, amount, "dueDate", "fiscalDocument", "fiscalRule")
    SELECT '${newId()}', o."tenantId", o."companyId", o."partyId", o.id, 'ACCONTO', 'EUR', 30000, (now() + interval '10 days')::date, 'NONE', 'test.deposit.EU_B2B_VIES' FROM "SalesOrder" o WHERE o."tenantId" = '${tenant}' AND o.number = '${number}';`)
/** An OPEN customer request of the order, made `daysAgo` days ago. */
const askChange = (number: string, daysAgo: number) =>
  admin(
    `INSERT INTO "OrderChangeRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, status, "createdAt")
     SELECT $1, o."tenantId", o."companyId", o."partyId", o.id, 'RUSH', 'OPEN', now() - ($3::int * interval '1 day') FROM "SalesOrder" o WHERE o."tenantId" = $2 AND o.number = $4`,
    [newId(), tenant, daysAgo, number],
  )
/** A message the customer wrote on its own conversation (the newest shared one: it waits on us). */
async function customerWrote(partyId: string): Promise<void> {
  const context = { audience: 'office', tenantId: tenant, actorId: writer, grants: [grant(['threads.read', 'threads.post', 'parties.view'])], requestId: newId() } as RequestContext
  await command(callerFor(database, context), { name: 'threads.postNote', input: { record: { type: 'Party', id: partyId } } }, async (tools) => {
    const { thread } = await ensureThread(tools, { type: 'Party', id: partyId }, writer)
    await writeMessage(tools, thread, { direction: 'INBOUND', channel: 'EMAIL', author: { kind: 'PARTY', id: null, name: 'Made-up buyer' }, bodyText: 'Made-up: when does the order leave?', at: new Date(Date.now() - 2 * DAY) })
    return { done: true }
  })
}

beforeAll(async () => {
  db = await migratedDatabase('orders_customer_work')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: NS })
  await seedMoney({ db: database, namespace: NS })
  await copyForRider('TEST-SO-R1-LATE', TODAY, addDays(TODAY, -1))
  await copyForRider('TEST-SO-R1-LATER', addDays(TODAY, -40), addDays(TODAY, 30))
  await copyForRider('T-CL-R1-CUT', addDays(TODAY, -20), addDays(TODAY, 10))
  await setOrder('T-CL-R1-CUT', { status: 'IN_PRODUCTION', level: 'HIGH' })
  await keep('T-CL-R1-CUT', 'CUTTING')
  await copyForRider('T-CL-R1-YES', addDays(TODAY, -3), addDays(TODAY, 2))
  await setOrder('T-CL-R1-YES', { status: 'PENDING_APPROVAL' })
  await copyForRider('T-CL-R1-DEP', addDays(TODAY, -5), addDays(TODAY, 15))
  await askDeposit('T-CL-R1-DEP')
  await copyForRider('T-CL-R1-TOP', addDays(TODAY, -2), addDays(TODAY, 5))
  await setOrder('T-CL-R1-TOP', { level: 'URGENT' })
  await copyForRider('T-CL-R1-DONE', addDays(TODAY, -90), addDays(TODAY, -60))
  await setOrder('T-CL-R1-DONE', { status: 'DELIVERED' })
  await askChange('TEST-SO-R1-LATER', 2)
  await askChange('T-CL-R1-CUT', 0)
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, 'Made-up writer', 'ACTIVE')`, [writer, tenant, `cl-writer-${writer.slice(-6)}@example.com`])
  await customerWrote(R1)
  await customerWrote(C1)
  // B-CL-009: an open quote of SEED-R1 (SEED-Q-0002, a DRAFT of SEED-C1, copied; the guards and the customer's running number off).
  await rulesOff(`CREATE TEMP TABLE q AS SELECT * FROM "Quote" WHERE "tenantId" = '${tenant}' AND number = 'SEED-Q-0002';
    UPDATE q SET id = '${newId()}', "partyId" = '${R1}', number = 'T-CL-Q-R1', "contactId" = NULL, "customerSeq" = NULL, "customerRef" = NULL, status = 'DRAFT';
    INSERT INTO "Quote" SELECT * FROM q;
    DROP TABLE q;`)
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

describe('GET /sales/orders/customers/work — every count is the rows its door opens (B-CL-003, 13-backend §4)', () => {
  it('SEED-R1: the seven phases, late, waits for a yes, deposit open, the customer\'s urgency, Top / High, requests and replies each equal their door', async () => {
    const answer = await work('all', [R1])
    expect(answer).toMatchObject({ repliesComplete: true, withheld: [], limited: false, asOf: expect.any(String) })
    const row = rowOf(answer, R1)
    expect((row.phases as Json[]).map((entry) => entry.phase)).toEqual([...ORDER_PHASES])
    for (const { phase, count } of row.phases as Json[]) expect(count, phase).toBe(await doorRows('all', `partyId=${R1}&phase=${phase}`))
    expect(row.late).toBe(await doorRows('all', `partyId=${R1}&late=true`))
    expect(row.waitsForYes).toBe(await doorRows('all', `partyId=${R1}&status=PENDING_APPROVAL`))
    expect(row.depositOpen).toBe(await doorRows('all', `partyId=${R1}&deposit=OPEN`))
    expect(row.customerUrgent.count).toBe(await doorRows('all', `partyId=${R1}&customerUrgency=URGENT`))
    expect(row.customerUrgent.count).toBe((row.customerUrgent.byCompany as Json[]).reduce((sum, entry) => sum + (entry.count as number), 0))
    expect(row.priority.top).toBe(await doorRows('all', `partyId=${R1}&open=true&priority=URGENT`))
    expect(row.priority.high).toBe(await doorRows('all', `partyId=${R1}&open=true&priority=HIGH`))
    expect(row.orders).toBe(await doorRows('all', `partyId=${R1}`))
    // The phases add up to every order.
    expect((row.phases as Json[]).reduce((sum, entry) => sum + (entry.count as number), 0)).toBe(row.orders)
    // Requests: the OPEN ones, the oldest's id the review window's door (the Work strip's own where, counted here in SQL).
    const open = await admin<{ id: string }>(`SELECT id FROM "OrderChangeRequest" WHERE "tenantId" = $1 AND "partyId" = $2 AND status = 'OPEN' ORDER BY "createdAt", id`, [tenant, R1])
    expect(row.requests).toEqual({ open: open.length, firstId: open[0]?.id ?? null })
    // Replies: the customer side's waiting conversations of the customer (the dock's All of <customer>).
    expect(row.replies).toBe((await ok('all', `/threads/waiting?side=CUSTOMER&partyId=${R1}`)).count)
    // The made-up world counts something everywhere it should.
    expect(row).toMatchObject({ late: 1, waitsForYes: 1, depositOpen: 1, priority: { top: 1, high: 1 }, requests: { open: 2 }, replies: 1 })
    expect((row.phases as Json[]).find((entry) => entry.phase === 'IN_PRODUCTION')!.count).toBe(1)
    expect((row.phases as Json[]).find((entry) => entry.phase === 'DONE')!.count).toBe(1)
  })

  it('the next promise is the earliest from today among the open orders; the newest order by order date, then made; the last order date', async () => {
    const row = rowOf(await work('all', [R1]), R1)
    const [next] = await admin<{ day: string | null }>(
      `SELECT to_char(min("promiseDate"), 'YYYY-MM-DD') AS day FROM "SalesOrder" WHERE "tenantId" = $1 AND "partyId" = $2 AND status IN ('CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED') AND "promiseDate" >= $3::date`,
      [tenant, R1, TODAY],
    )
    expect(row.nextPromise).toBe(next!.day)
    expect(row.nextPromise).toBe(addDays(TODAY, 5)) // T-CL-R1-TOP; T-CL-R1-YES (in 2 days) waits for a yes, TEST-SO-R1-LATE's promise passed
    const [newest] = await admin<{ id: string; number: string }>(`SELECT id, number FROM "SalesOrder" WHERE "tenantId" = $1 AND "partyId" = $2 ORDER BY "orderDate" DESC, "createdAt" DESC, id DESC LIMIT 1`, [tenant, R1])
    expect(row.newestOrder).toEqual({ id: newest!.id, number: newest!.number })
    expect(row.newestOrder.number).toBe('TEST-SO-R1-LATE')
    expect(row.lastOrderDate).toBe(TODAY)
  })

  it('a reached customer with no order: present with zeros, no newest order, no promise; the order asked is kept; ids are each once', async () => {
    const answer = await work('all', [C2, R1, C2])
    expect((answer.customers as Json[]).map((row) => row.partyId)).toEqual([C2, R1])
    expect(rowOf(answer, C2)).toEqual({
      partyId: C2,
      orders: 0,
      phases: ORDER_PHASES.map((phase) => ({ phase, count: 0 })),
      late: 0,
      waitsForYes: 0,
      depositOpen: 0,
      requests: { open: 0, firstId: null },
      replies: 0,
      customerUrgent: { count: 0, byCompany: [] },
      priority: { top: 0, high: 0 },
      nextPromise: null,
      lastOrderDate: null,
      newestOrder: null,
      // B-CL-009: this reader holds neither quotes.view nor sales.inquiries.view: both parts are left out (never 0).
      beforeOrder: {},
    })
  })

  it('1 to 50 customer ids or a 400 in words; an unknown id is absent', async () => {
    const wrong = await call('all', '/sales/orders/customers/work?partyIds=not-an-id-but-long-enough-to-pass-the-length')
    expect(wrong.statusCode).toBe(400)
    expect(wrong.json().error.message).toBe('Name 1 to 50 customers by id, comma separated.')
    const many = Array.from({ length: 51 }, () => newId()).join(',')
    expect((await call('all', `/sales/orders/customers/work?partyIds=${many}`)).statusCode).toBe(400)
    expect((await call('all', '/sales/orders/customers/work')).statusCode).toBe(400)
    expect((await work('all', [newId()])).customers).toEqual([])
  })
})

describe('GET /parties: the band = the filter, the needs order (B-CL-002, 13-backend §1 rule 1)', () => {
  it('each group\'s customers equal the rows work=<group> keeps — plain, with a search, with a view term', async () => {
    for (const terms of [CUSTOMERS, `${CUSTOMERS}&q=seed`, `${CUSTOMERS}&status=ACTIVE`, `${CUSTOMERS}&q=rider`]) {
      const band = (await ok('all', `/parties?${terms}&band=true&limit=1`)).band
      expect((band.groups as Json[]).map((group) => group.group), terms).toEqual([...PARTY_WORK_GROUPS])
      for (const group of band.groups as Json[]) {
        const door = await ok('all', `/parties?${terms}&work=${group.group}&limit=200`)
        expect(door.count, `${terms} ${group.group}`).toBe(group.customers)
        expect(door.parties.length, `${terms} ${group.group}`).toBe(group.customers)
      }
    }
    const band = (await ok('all', `/parties?${CUSTOMERS}&band=true&limit=1`)).band
    expect(band.limited).toBe(false)
    // The band is the rows' own counts: the route over every customer of the view, summed (one function, never a second count).
    const listed = partyIdsOf(await ok('all', `/parties?${CUSTOMERS}&limit=200`))
    expect(listed).toEqual(expect.arrayContaining([C1, C2, R1]))
    const rows = (await work('all', listed)).customers as Json[]
    const sum = (of: (row: Json) => number): number => rows.reduce((total, row) => total + of(row), 0)
    const waits = (row: Json): boolean => (row.requests.open as number) + (row.replies as number) + (row.late as number) > 0
    const countOf = (row: Json, phase: string): number => (row.phases as Json[]).find((entry) => entry.phase === phase)!.count as number
    // SEED-R1 (late, requests, a reply) and SEED-C1 (a reply) wait on us.
    expect(rows.filter(waits).map((row) => row.partyId)).toEqual(expect.arrayContaining([C1, R1]))
    expect(band.groups.find((group: Json) => group.group === 'NEEDS_US')).toEqual({ group: 'NEEDS_US', customers: rows.filter(waits).length, orders: null })
    expect(band.needsUs).toEqual({ requests: sum((row) => row.requests.open), replies: sum((row) => row.replies), late: sum((row) => row.late), repliesComplete: true })
    expect(band.notSent.waitsForYes).toBe(sum((row) => row.waitsForYes))
    for (const group of band.groups as Json[]) {
      if (group.group === 'NEEDS_US') continue
      expect(group, group.group).toEqual({ group: group.group, customers: rows.filter((row) => countOf(row, group.group) > 0).length, orders: sum((row) => countOf(row, group.group)) })
    }
    // The band ignores only `work`: the band read with a door pressed says the same.
    expect((await ok('all', `/parties?${CUSTOMERS}&band=true&work=DONE&limit=1`)).band).toEqual(band)
  })

  it('most urgent first: SEED-R1 (waiting on us, our Top) before SEED-C1 before SEED-C2 (no order); page by page with limit=1 is the one page', async () => {
    const all = await ok('all', `/parties?${CUSTOMERS}&sort=needs&limit=200`)
    expect(all.sortedBy).toBe('needs')
    const ids = partyIdsOf(all)
    expect(ids[0]).toBe(R1)
    expect(ids.indexOf(C1)).toBeLessThan(ids.indexOf(C2))
    const paged: string[] = []
    let cursor: string | null = null
    for (let guard = 0; guard <= ids.length; guard++) {
      const page: Json = await ok('all', `/parties?${CUSTOMERS}&sort=needs&limit=1${cursor ? `&cursor=${cursor}` : ''}`)
      expect(page.count).toBe(all.count)
      paged.push(...partyIdsOf(page))
      cursor = page.nextCursor
      if (!cursor) break
    }
    expect(paged).toEqual(ids)
  })

  // ── T31 (walk W-4): the needs order's second key reads OPEN orders only, the set of the Top / High chips and their door ──
  it('T31: a Top order waiting for a yes does not put its customer above a customer with an open Top order', async () => {
    // T-CL-C1-YES-TOP: SEED-C1's order waiting for a yes at our level Top with a high priority number — it would sort SEED-C1 first
    // if it counted. Both customers wait on us (a reply each); SEED-R1's open Top order (T-CL-R1-TOP) puts SEED-R1 first.
    await copyForRider('T-CL-C1-YES-TOP', addDays(TODAY, -1), addDays(TODAY, 1), C1)
    await setOrder('T-CL-C1-YES-TOP', { status: 'PENDING_APPROVAL', level: 'URGENT' })
    await rulesOff(`UPDATE "SalesOrder" SET priority = 99 WHERE ${orderSql('T-CL-C1-YES-TOP')};`)
    const ids = partyIdsOf(await ok('all', `/parties?${CUSTOMERS}&sort=needs&limit=200`))
    expect(ids[0]).toBe(R1)
    expect(ids.indexOf(R1)).toBeLessThan(ids.indexOf(C1))
    // The chips say the same: SEED-C1's Top counts its open orders only (the door rows=open), the order waiting for a yes is "Waits for a yes".
    const c1 = rowOf(await work('all', [C1]), C1)
    expect(c1.priority.top).toBe(await doorRows('all', `partyId=${C1}&open=true&priority=URGENT`))
    expect(await doorRows('all', `partyId=${C1}&status=PENDING_APPROVAL&priority=URGENT`)).toBe(1)
    expect(c1.waitsForYes).toBe(await doorRows('all', `partyId=${C1}&status=PENDING_APPROVAL`))
    expect(c1.waitsForYes).toBeGreaterThanOrEqual(1)
  })
})

describe('the brand wall: a person limited to some customers (13-backend §7)', () => {
  it('limited to SEED-R1 asking SEED-C1 and SEED-R1: SEED-R1 only, with its own counts; not a word of SEED-C1', async () => {
    const answer = await work('onlyR1', [C1, R1])
    expect((answer.customers as Json[]).map((row) => row.partyId)).toEqual([R1])
    expect(answer.limited).toBe(true)
    expect(rowOf(answer, R1)).toEqual(rowOf(await work('all', [R1]), R1))
    const text = JSON.stringify(answer)
    for (const word of [C1, 'Seed Customer One', 'Seed Racing', 'SEED-SO-0001', 'SEED-SO-0002']) expect(text).not.toContain(word)
  })

  it('limited to SEED-R1: the band, every door and the needs order count SEED-R1 only', async () => {
    const band = (await ok('onlyR1', `/parties?${CUSTOMERS}&band=true&limit=1`)).band
    const r1 = rowOf(await work('all', [R1]), R1)
    expect(band.limited).toBe(true)
    expect(band.needsUs).toMatchObject({ requests: r1.requests.open, replies: r1.replies, late: r1.late })
    for (const group of band.groups as Json[]) {
      const door = await ok('onlyR1', `/parties?${CUSTOMERS}&work=${group.group}&limit=200`)
      expect(partyIdsOf(door).every((partyId) => partyId === R1), group.group).toBe(true)
      expect(door.count, group.group).toBe(group.customers)
      if (group.group !== 'NEEDS_US') expect(group.orders, group.group).toBe((r1.phases as Json[]).find((entry) => entry.phase === group.group)!.count)
    }
    expect(partyIdsOf(await ok('onlyR1', `/parties?${CUSTOMERS}&sort=needs&limit=200`))).toEqual([R1])
    expect(JSON.stringify(band)).not.toContain(C1)
  })

  it('limited to SEED-C1: never SEED-R1; a person of another company: zeros over its own company only, never an order of company A', async () => {
    expect((await work('onlyC1', [C1, R1])).customers.map((row: Json) => row.partyId)).toEqual([C1])
    const other = await work('companyB', [C1, R1])
    for (const row of other.customers as Json[]) {
      expect(row, row.partyId).toMatchObject({ orders: 0, late: 0, waitsForYes: 0, depositOpen: 0, requests: { open: 0, firstId: null }, priority: { top: 0, high: 0 }, nextPromise: null, lastOrderDate: null, newestOrder: null })
      expect((row.phases as Json[]).every((entry) => entry.count === 0)).toBe(true)
    }
    for (const word of ['TEST-SO-', 'T-CL-', 'SEED-SO-']) expect(JSON.stringify(other)).not.toContain(word)
    const band = (await ok('companyB', `/parties?${CUSTOMERS}&band=true&limit=1`)).band
    expect((band.groups as Json[]).every((group) => group.customers === 0)).toBe(true)
  })

  it('no orders.view: the route and the work terms are refused (403, in words for GET /parties); a portal person reaches none of it', async () => {
    expect((await call('noOrders', `/sales/orders/customers/work?partyIds=${R1}`)).statusCode).toBe(403)
    for (const query of ['band=true', 'work=NEEDS_US', 'sort=needs']) {
      const refused = await call('noOrders', `/parties?${CUSTOMERS}&${query}`)
      expect(refused.statusCode, query).toBe(403)
      expect(refused.json().error.message, query).toBe("Seeing where customers' work stands needs the right to see orders.")
    }
    expect((await call('partner', `/sales/orders/customers/work?partyIds=${C1}`)).statusCode).toBe(403)
    expect((await call('partner', `/parties?${CUSTOMERS}&band=true`)).statusCode).toBe(403)
  })

  it('parties over every customer, orders over SEED-R1 only: SEED-C1\'s row is listed with no facts — absent from the route, after every customer with work, in no group', async () => {
    const answer = await work('partiesAllOrdersR1', [C1, R1])
    expect((answer.customers as Json[]).map((row) => row.partyId)).toEqual([R1])
    const listed = await ok('partiesAllOrdersR1', `/parties?${CUSTOMERS}&sort=needs&band=true&limit=200`)
    const ids = partyIdsOf(listed)
    expect(ids).toEqual(expect.arrayContaining([C1, C2, R1]))
    expect(ids[0]).toBe(R1)
    // SEED-C1 has no facts for this reader: its key is the "no facts" one, so it sorts by code among the others without work.
    expect(ids.slice(1)).toEqual([...ids.slice(1)].sort((a, b) => {
      const code = (partyId: string) => (listed.parties as Json[]).find((row) => row.id === partyId)!.code as string
      return code(a) < code(b) ? -1 : code(a) > code(b) ? 1 : 0
    }))
    // Its reply waiting (its own conversation, read through parties.view + threads.read) counts nowhere: the band counts SEED-R1 only.
    expect(listed.band.limited).toBe(true)
    expect(listed.band.groups.find((group: Json) => group.group === 'NEEDS_US').customers).toBe(1)
    expect(listed.band.needsUs.replies).toBe(1)
    expect(partyIdsOf(await ok('partiesAllOrdersR1', `/parties?${CUSTOMERS}&work=NEEDS_US`))).toEqual([R1])
    for (const group of PARTY_WORK_GROUPS) expect(partyIdsOf(await ok('partiesAllOrdersR1', `/parties?${CUSTOMERS}&work=${group}`)), group).not.toContain(C1)
  })
})

describe('the money wall: the real Sales template reads no amount in the route or the band (13-backend §7)', () => {
  const keysOf = (value: unknown): string[] =>
    Array.isArray(value) ? value.flatMap(keysOf) : value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]) : []

  it('no amount, gross, net or price key anywhere; counts and days only', async () => {
    const route = await work('sales', [C1, C2, R1])
    const band = await ok('sales', `/parties?${CUSTOMERS}&band=true&sort=needs&limit=200`)
    expect(route.customers.length).toBe(3)
    for (const body of [route, band.band]) {
      const keys = keysOf(body)
      expect(keys.length).toBeGreaterThan(0)
      expect(keys.filter((key) => /amount|gross|price|^net/i.test(key))).toEqual([])
    }
  })
})

describe('the file holds the band door\'s rows (B-CL-007)', () => {
  it('Export of Customers with ?work=NOT_SENT holds the customers GET /parties?work=NOT_SENT shows; Suppliers never reads work', async () => {
    const reader = callerFor(database, completeContext(SESSIONS.all!(), `test-${newId()}`))
    const query = customersFile.query(new URLSearchParams('work=NOT_SENT'))
    expect(query).toMatchObject({ work: 'NOT_SENT' })
    const page = await customersFile.read(reader, query, null, 200)
    const screen = await ok('all', `/parties?${CUSTOMERS}&work=NOT_SENT&limit=200`)
    expect((page.rows as ReadonlyArray<{ readonly id: string }>).map((row) => row.id).sort()).toEqual(partyIdsOf(screen).sort())
    expect(partyIdsOf(screen)).toContain(R1)
    expect(suppliersFile.query(new URLSearchParams('work=NOT_SENT'))).not.toHaveProperty('work')
    expect(customersFile.query(new URLSearchParams('work=SOMEWHERE'))).not.toHaveProperty('work')
  })
})

// ── B-CL-009 (S1b; settle T19): "to answer" and "open quotes" per customer — cq's ONE rule, the reached customers only ──
/**
 * Stands on the seeds' SEED-Q-0001 (accepted) and SEED-Q-0002 (a draft) of SEED-C1 and T-CL-Q-R1, a draft of SEED-R1 (above). The
 * route's part of each customer is cq's single read (GET /sales/before-order/counts?partyId=…) as the same person: `toAnswer` =
 * groups.TO_ANSWER, `openQuotes` = openQuotes; a part the person holds no right of is absent, never 0.
 */
describe('beforeOrder: the route\'s "to answer" and "open quotes" are cq\'s single read (B-CL-009)', () => {
  /** cq's single read of one customer, as the route's two parts (a null part left out). */
  const single = async (session: string, partyId: string): Promise<Json> => {
    const answer = await ok(session, `/sales/before-order/counts?partyId=${partyId}`)
    return { ...(answer.groups.TO_ANSWER !== null ? { toAnswer: answer.groups.TO_ANSWER } : {}), ...(answer.openQuotes !== null ? { openQuotes: answer.openQuotes } : {}) }
  }

  it('each customer\'s part equals cq\'s single read; SEED-R1 and SEED-C1 have an open quote', async () => {
    for (const session of ['quotes', 'sales']) {
      const answer = await work(session, [C1, C2, R1])
      for (const partyId of [C1, C2, R1]) expect(rowOf(answer, partyId).beforeOrder, `${session} ${partyId}`).toEqual(await single(session, partyId))
    }
    const parts = await work('quotes', [C1, C2, R1])
    expect(rowOf(parts, R1).beforeOrder).toEqual({ toAnswer: 0, openQuotes: 1 })
    expect(rowOf(parts, C1).beforeOrder.openQuotes).toBeGreaterThanOrEqual(1)
    expect(rowOf(parts, C2).beforeOrder).toEqual({ toAnswer: 0, openQuotes: 0 })
  })

  it('a part without its right is absent, never 0: no quotes.view → no openQuotes; no requests right → no toAnswer', async () => {
    const noRequests = await work('quotesNoRequests', [C1, R1])
    for (const partyId of [C1, R1]) {
      const part = rowOf(noRequests, partyId).beforeOrder
      expect(part, partyId).not.toHaveProperty('toAnswer')
      expect(part.openQuotes, partyId).toEqual(expect.any(Number))
      expect(part, partyId).toEqual(await single('quotesNoRequests', partyId))
    }
    const neither = await work('all', [C1, R1])
    for (const partyId of [C1, R1]) expect(rowOf(neither, partyId).beforeOrder, partyId).toEqual({})
  })

  it('a person limited to SEED-R1 gets SEED-R1\'s part only — never SEED-C1\'s row or open quotes', async () => {
    const limited = await work('quotesOnlyR1', [C1, R1])
    expect((limited.customers as Json[]).map((row) => row.partyId)).toEqual([R1])
    expect(rowOf(limited, R1).beforeOrder).toEqual(await single('quotesOnlyR1', R1))
    expect(rowOf(limited, R1).beforeOrder).toEqual(rowOf(await work('quotes', [R1]), R1).beforeOrder)
    expect(JSON.stringify(limited)).not.toContain(C1)
    // cq's single read refuses the other customer as unknown (the same wall).
    expect((await call('quotesOnlyR1', `/sales/before-order/counts?partyId=${C1}`)).statusCode).toBe(404)
  })
})
// ── end B-CL-009 ──

