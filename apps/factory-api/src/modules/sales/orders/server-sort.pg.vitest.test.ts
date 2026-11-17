import { fileURLToPath } from 'node:url'
import ExcelJS from 'exceljs'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedMoney } from '../../../../../../packages/factory-db/seed/money'
import { seed as seedOptions } from '../../../../../../packages/factory-db/seed/options'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor, type CommandCaller } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { systemContext } from '../../../platform/outbox/system'
import { runExport } from '../../../platform/exports/worker'
import { ORDER_SORTS } from './sort'

/**
 * T19 (B-TH-057; SHEET-G05, SHEET-G15, ORD-G07; wall surface W19) on the local stack with the core, auth, roles, money (the
 * sales seed inside) and options seeds and the app's real routes and export worker: Sales › Orders filters, searches and
 * sorts on the server, and its file follows the screen.
 *
 *   - every sort (customer, brand, promise, daysLate, ordered, each way round) reads the same rows in the same order page by
 *     page (2 a page, the cursor on the sort key and id) as in one page, for a person who sees every customer and for one
 *     limited to customer B; promise and days late keep the orders without one last, the label a reader may not see whose it
 *     is sorts as one group and never by its name;
 *   - the custom field filter `cf` narrows the list, its counts and its file alike; an unknown field is refused;
 *   - the search reads the customer, a line's style code and a label the reader may see — never a label it may not;
 *   - screen = file: the sorted and filtered file holds the screen's rows in the screen's order, customer A only.
 *
 * Customer A is the seed's SEED-C1 (its order SEED-SO-0001 and T057-A-01); customer B is the seed's SEED-R1 with four made-up
 * orders: T057-B-01 10 days late (a line of SEED-C1's private-label jacket), T057-B-02 3 days late (first line the
 * own-collection liner, then the jacket), T057-B-03 promised in 20 days and T057-B-04 without a promise (both without lines).
 * Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/orders/server-sort.pg`.
 */

type Json = Record<string, any>

const NS = 'orders-th057'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')

const PEOPLE = { owner: newId(), limited: newId() } as const
type Person = keyof typeof PEOPLE
const SESSIONS: Partial<Record<Person, SessionContext>> = {}
function grantOf(role: string, parties: 'all' | string[]): Grant {
  const template = templateOf(role)!
  return { permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties }
}

let h: Harness
let app: FastifyInstance
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const system = (): CommandCaller => callerFor(h.database, systemContext(T, newId()))

async function call(person: Person, method: 'GET' | 'POST', url: string, payload?: unknown): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': person }, ...(payload === undefined ? {} : { payload: payload as object }) })
  return { status: response.statusCode, body: String(response.headers['content-type'] ?? '').includes('json') ? (response.json() as Json) : {} }
}
async function ok(person: Person, method: 'GET' | 'POST', url: string, payload?: unknown, status = 200): Promise<Json> {
  const answer = await call(person, method, url, payload)
  expect(answer.status, `${person} ${method} ${url}: ${JSON.stringify(answer.body).slice(0, 500)}`).toBe(status)
  return answer.body
}

/** One read of the list (every row on one page): the numbers in the API's order. */
const listed = async (person: Person, query: string): Promise<string[]> => ((await ok(person, 'GET', `/sales/orders?limit=200&${query}`)).orders as Json[]).map((row) => row.number as string)
/** The list read 2 a page with the cursor until its end: the numbers in the API's order. */
async function paged(person: Person, query: string): Promise<string[]> {
  const out: string[] = []
  let cursor: string | null = null
  for (let page = 0; page < 50; page += 1) {
    const answer: Json = await ok(person, 'GET', `/sales/orders?limit=2&${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    out.push(...(answer.orders as Json[]).map((row) => row.number as string))
    cursor = answer.nextCursor as string | null
    if (!cursor) return out
  }
  throw new Error('the cursor never ended')
}
const boardTotal = async (person: Person, query: string): Promise<number> => ((await ok(person, 'GET', `/sales/orders/board?${query}`)).byStatus as Json[]).reduce((sum, entry) => sum + (entry.count as number), 0)

const COLUMNS = [
  { key: 'number', label: 'Numero' },
  { key: 'customer', label: 'Cliente' },
]
/**
 * The file of Sales › Orders for the screen's address with every order (`rows=all`, the screen's "All" view; the API's list reads
 * every order without `open`), the worker run as its handler does: its order numbers, in order.
 */
async function filed(person: Person, query: string): Promise<{ numbers: string[]; customers: string[] }> {
  const { job } = await ok(person, 'POST', '/exports', { listKey: 'sales.orders', format: 'XLSX', query: `rows=all${query ? `&${query}` : ''}`, columns: COLUMNS, title: 'Ordini di vendita', locale: 'it' }, 201)
  const outcome = await runExport(system(), job.id, { files: h.files })
  const done = (await ok(person, 'GET', `/exports/${job.id}`)).job
  expect(outcome, `${query}: ${done.failureReason}`).toBe('done')
  const { download } = await ok(person, 'GET', `/exports/${job.id}/download`)
  const got = await app.inject({ method: 'GET', url: download.url, headers: download.headers })
  expect(got.statusCode).toBe(200)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(got.rawPayload as unknown as ArrayBuffer)
  const rows: string[][] = []
  workbook.worksheets[0]!.eachRow((row) => rows.push((row.values as unknown[]).slice(1).map((value) => String(value ?? ''))))
  const data = rows.slice(rows.findIndex((row) => row[0] === 'Numero') + 1)
  return { numbers: data.map((row) => row[0]!), customers: data.map((row) => row[1]!) }
}

/** A version-4 UUID derived from an id and a salt (the copies' ids are valid UUIDs, as the contracts ask). */
const v4 = (expression: string, salt: string): string => {
  const hash = `md5(${expression}::text || '${salt}')`
  return `(substr(${hash}, 1, 8) || '-' || substr(${hash}, 9, 4) || '-4' || substr(${hash}, 14, 3) || '-8' || substr(${hash}, 18, 3) || '-' || substr(${hash}, 21, 12))::uuid`
}
const dayPlus = (days: number): string => {
  const at = new Date(`${businessDate(new Date())}T00:00:00.000Z`)
  at.setUTCDate(at.getUTCDate() + days)
  return at.toISOString().slice(0, 10)
}

/** SEED-SO-0001 copied for a customer as `number`, with its promise and order date; its lines as they are, the liner first, or none. */
async function copyOrder(number: string, partyId: string, promise: string | null, orderDate: string, lines: 'jacket' | 'liner-first' | 'none'): Promise<void> {
  const salt = number.toLowerCase()
  await admin(`
    CREATE TEMP TABLE o AS SELECT * FROM "SalesOrder" WHERE "tenantId" = '${T}' AND number = 'SEED-SO-0001';
    CREATE TEMP TABLE l AS SELECT * FROM "SalesOrderLine" WHERE "orderId" = (SELECT id FROM o) AND '${lines}' <> 'none';
    CREATE TEMP TABLE s AS SELECT * FROM "SalesOrderLineSize" WHERE "lineId" IN (SELECT id FROM l);
    UPDATE s SET id = ${v4('id', salt)}, "lineId" = ${v4('"lineId"', salt)}, "partyId" = '${partyId}';
    UPDATE l SET id = ${v4('id', salt)}, "orderId" = ${v4('"orderId"', salt)}, "partyId" = '${partyId}', "quoteLineId" = NULL, "styleRevisionId" = NULL;
    UPDATE l SET "styleId" = (SELECT id FROM "Style" WHERE "tenantId" = '${T}' AND code = 'SEED-LNR-01'),
      "colourwayId" = (SELECT c.id FROM "Colourway" c JOIN "Style" st ON st.id = c."styleId" WHERE st."tenantId" = '${T}' AND st.code = 'SEED-LNR-01' ORDER BY c.id LIMIT 1)
      WHERE '${lines}' = 'liner-first' AND seq = (SELECT min(seq) FROM l);
    UPDATE o SET id = ${v4('id', salt)}, "partyId" = '${partyId}', number = '${number}', "quoteVersionId" = NULL, "customerRef" = NULL,
      "promiseDate" = ${promise ? `'${promise}'::date` : 'NULL'}, "orderDate" = '${orderDate}'::date;
    INSERT INTO "SalesOrder" SELECT * FROM o;
    INSERT INTO "SalesOrderLine" SELECT * FROM l;
    INSERT INTO "SalesOrderLineSize" SELECT * FROM s;
    DROP TABLE o, l, s;`)
}

let partyA: string
let partyB: string
let nameA: string
let nameB: string
const B = ['T057-B-01', 'T057-B-02', 'T057-B-03', 'T057-B-04'] as const

beforeAll(async () => {
  h = await startHarness('orders_th057')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedMoney({ db: h.database, namespace: NS })
  await seedOptions({ db: h.database, namespace: NS })
  const roleIds = new Map((await admin<{ id: string; key: string }>('SELECT id, key FROM "Role" WHERE "tenantId" = $1', [T])).map((row) => [row.key, row.id]))
  partyA = (await one<{ id: string }>('SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = \'SEED-C1\'', [T])).id
  partyB = (await one<{ id: string }>('SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = \'SEED-R1\'', [T])).id
  nameA = (await one<{ legalName: string }>('SELECT "legalName" FROM "Party" WHERE id = $1', [partyA])).legalName
  nameB = (await one<{ legalName: string }>('SELECT "legalName" FROM "Party" WHERE id = $1', [partyB])).legalName
  // The jacket is customer A's private label; the liner is our own collection (the seeds' facts this test rests on).
  expect((await one<{ brand: string | null }>('SELECT "brandPartyId" AS brand FROM "Style" WHERE "tenantId" = $1 AND code = \'SEED-JKT-01\'', [T])).brand).toBe(partyA)
  expect((await one<{ brand: string | null }>('SELECT "brandPartyId" AS brand FROM "Style" WHERE "tenantId" = $1 AND code = \'SEED-LNR-01\'', [T])).brand).toBeNull()
  await copyOrder('T057-A-01', partyA, dayPlus(-5), dayPlus(-40), 'jacket')
  await copyOrder(B[0], partyB, dayPlus(-10), dayPlus(-30), 'jacket')
  await copyOrder(B[1], partyB, dayPlus(-3), dayPlus(-20), 'liner-first')
  await copyOrder(B[2], partyB, dayPlus(20), dayPlus(-10), 'none')
  await copyOrder(B[3], partyB, null, dayPlus(-1), 'none')
  // The owner sees every customer; "limited" is a sales person whose orders scope is customer B only.
  await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, \'ACTIVE\')', [PEOPLE.owner, T, `th057-owner-${PEOPLE.owner.slice(-6)}@example.com`, 'Made-up owner'])
  await admin('INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "validFrom") VALUES ($1, $2, $3, $4, true, now() - interval \'1 day\')', [newId(), T, PEOPLE.owner, roleIds.get('owner')])
  await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, \'ACTIVE\')', [PEOPLE.limited, T, `th057-limited-${PEOPLE.limited.slice(-6)}@example.com`, 'Made-up sales rep'])
  await admin('INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "partyIds", "validFrom") VALUES ($1, $2, $3, $4, true, $5::uuid[], now() - interval \'1 day\')', [newId(), T, PEOPLE.limited, roleIds.get('sales'), [partyB]])
  SESSIONS.owner = { audience: 'office', tenantId: T, actorId: PEOPLE.owner, companyId: companyA, grants: [grantOf('owner', 'all')] }
  SESSIONS.limited = { audience: 'office', tenantId: T, actorId: PEOPLE.limited, companyId: companyA, grants: [grantOf('sales', [partyB])] }
  // A custom field of the orders and its value on two of B's orders (the `cf` filter's facts).
  const field = newId()
  await admin(`INSERT INTO "CustomField" (id, "tenantId", "recordType", code, key, type, "labelIt", "labelEn", audience, "createdById") VALUES ($1, $2, 'SalesOrder', 'rush_note', 'field:SalesOrder:rush_note', 'TEXT', 'Nota urgenza', 'Rush note', 'INTERNAL', $3)`, [field, T, PEOPLE.owner])
  for (const number of [B[0], B[2]]) {
    const order = (await one<{ id: string }>('SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = $2', [T, number])).id
    await admin(`INSERT INTO "CustomFieldValue" (id, "tenantId", "fieldId", "recordType", "recordId", key, value, "changedAt", "changedById") VALUES ($1, $2, $3, 'SalesOrder', $4, $5, '"Made-up rush order"'::jsonb, now(), $6)`, [newId(), T, field, order, `value:${field}:${order}`, PEOPLE.owner])
  }
  await admin('UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1', [T])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET, rateLimit: { max: 10_000, timeWindowMs: 60_000 } },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session']) as Person] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

beforeEach(async () => {
  // Each test starts with no export running (the limit of three at once).
  await admin('UPDATE "ExportJob" SET status = \'FAILED\', "finishedAt" = now(), "failureReason" = \'test reset\' WHERE status IN (\'QUEUED\', \'RUNNING\')')
})

describe('B-TH-057 the orders sort on the server (SHEET-G15)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('every sort reads the same rows in the same order page by page as in one page, for every reader', async () => {
    for (const person of ['owner', 'limited'] as const) {
      const every = (await listed(person, '')).sort()
      for (const sort of ORDER_SORTS) {
        const whole = await listed(person, `sort=${sort}`)
        expect([...whole].sort(), `${person} ${sort}`).toEqual(every)
        expect(await paged(person, `sort=${sort}`), `${person} ${sort}`).toEqual(whole)
      }
    }
  })

  it('promise and days late: by their value, the orders without one last either way round', async () => {
    // Customer B's orders are this test's four (the seeds give SEED-R1 none).
    expect((await admin<{ number: string }>('SELECT number FROM "SalesOrder" WHERE "tenantId" = $1 AND "partyId" = $2 ORDER BY number', [T, partyB])).map((row) => row.number)).toEqual([...B])
    const own = `partyId=${partyB}`
    expect(await listed('owner', `${own}&sort=promise`)).toEqual([B[0], B[1], B[2], B[3]])
    expect(await listed('owner', `${own}&sort=-promise`)).toEqual([B[2], B[1], B[0], B[3]])
    // Most late first; on time (0 days) after the late ones; no promise last.
    expect(await listed('owner', `${own}&sort=-daysLate`)).toEqual([B[0], B[1], B[2], B[3]])
    expect(await listed('owner', `${own}&sort=daysLate`)).toEqual([B[2], B[1], B[0], B[3]])
    expect(await listed('owner', `${own}&sort=-ordered`)).toEqual([B[3], B[2], B[1], B[0]])
  })

  it('customer: by the customer’s name across customers', async () => {
    const rows = (await ok('owner', 'GET', '/sales/orders?limit=200&sort=customer')).orders as Json[]
    const names = rows.map((row) => row.partyName as string)
    expect(names).toEqual([...names].sort(new Intl.Collator('it', { sensitivity: 'base', numeric: true }).compare))
    expect([...new Set(names)]).toEqual(expect.arrayContaining([nameA, nameB]))
    // The other way round: the same names reversed.
    const back = ((await ok('owner', 'GET', '/sales/orders?limit=200&sort=-customer')).orders as Json[]).map((row) => row.partyName as string)
    expect(back).toEqual([...names].reverse())
  })

  it('brand: a label the reader may not see whose it is sorts as one group, never by its name (W19)', async () => {
    // Limited to B: B-02's first label is our own collection (its jacket's label is hidden), B-01's only label is hidden,
    // B-03 and B-04 have no line (last, newest id first when the sort runs the other way).
    const asc = await listed('limited', 'sort=brand')
    expect(asc.slice(0, 2)).toEqual([B[1], B[0]])
    expect(asc.slice(2).sort()).toEqual([B[2], B[3]])
    const desc = await listed('limited', 'sort=-brand')
    expect(desc.slice(0, 2)).toEqual([B[0], B[1]])
    // The rows never carry the hidden label's name.
    expect(JSON.stringify(await ok('limited', 'GET', '/sales/orders?limit=200&sort=brand'))).not.toContain(nameA)
  })

  it('a cursor of another sort, an unknown sort and a sort cursor without the sort are refused in words (400)', async () => {
    const first = await ok('owner', 'GET', '/sales/orders?limit=1&sort=promise')
    expect(first.nextCursor).toBeTruthy()
    for (const url of [`/sales/orders?limit=1&sort=customer&cursor=${encodeURIComponent(first.nextCursor)}`, '/sales/orders?sort=number', `/sales/orders?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`]) {
      const answer = await call('owner', 'GET', url)
      expect(answer.status, url).toBe(400)
      expect(String(answer.body.message ?? answer.body.error ?? JSON.stringify(answer.body)).length).toBeGreaterThan(0)
    }
  })
})

describe('B-TH-057 the custom field filter on the list (SHEET-G05)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('cf narrows the rows, the counts and the file alike; an unknown field is refused, never dropped', async () => {
    expect((await listed('owner', 'cf=rush_note:rush')).sort()).toEqual([B[0], B[2]])
    expect(await boardTotal('owner', 'cf=rush_note:rush')).toBe(2)
    expect(await listed('owner', 'cf=rush_note:rush&sort=-daysLate')).toEqual([B[0], B[2]])
    expect((await listed('owner', 'cf=rush_note:-')).sort()).not.toContain(B[0])
    expect((await filed('owner', 'cf=rush_note:rush&sort=-daysLate')).numbers).toEqual([B[0], B[2]])
    expect((await call('owner', 'GET', '/sales/orders?cf=no_such_field:x')).status).toBe(400)
    expect((await call('owner', 'GET', '/sales/orders/board?cf=no_such_field:x')).status).toBe(400)
  })
})

describe('B-TH-057 the search (ORD-G07)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('reads the customer, a line’s style code and a label the reader may see — never a label it may not', async () => {
    expect((await listed('owner', 'q=SEED-LNR-01')).sort()).toEqual([B[1]])
    expect((await listed('owner', `q=${encodeURIComponent(nameB)}`)).sort()).toEqual([...B].sort())
    // The owner finds B's orders carrying customer A's label by A's name; the person limited to B does not.
    const byLabel = await listed('owner', `q=${encodeURIComponent(nameA)}`)
    expect(byLabel).toEqual(expect.arrayContaining(['SEED-SO-0001', 'T057-A-01', B[0], B[1]]))
    expect(await listed('limited', `q=${encodeURIComponent(nameA)}`)).toEqual([])
    expect((await listed('limited', 'q=SEED-JKT-01')).sort()).toEqual([B[0], B[1]])
    expect(await boardTotal('limited', `q=${encodeURIComponent(nameA)}`)).toBe(0)
  })
})

describe('T19: the sorted and filtered file equals the screen, customer A only (W19)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('customer A’s sheet sorted by days late: the file holds A’s rows in the screen’s order', async () => {
    const query = `party=${partyA}&sort=-daysLate`
    const screen = await listed('owner', `partyId=${partyA}&sort=-daysLate`)
    expect(screen.length).toBeGreaterThanOrEqual(2)
    const file = await filed('owner', query)
    expect(file.numbers).toEqual(screen)
    expect(new Set(file.customers)).toEqual(new Set([nameA]))
    for (const number of B) expect(file.numbers).not.toContain(number)
  })

  it('every sort and the search: the file is the screen, row for row', async () => {
    for (const query of ['sort=customer', 'sort=-promise', 'sort=brand', `q=SEED-JKT-01&sort=ordered`]) {
      expect((await filed('owner', query)).numbers, query).toEqual(await listed('owner', query))
    }
    // The person limited to B: their file and their screen hold B's orders only, in the same order.
    const limited = await filed('limited', 'sort=-daysLate')
    expect(limited.numbers).toEqual(await listed('limited', 'sort=-daysLate'))
    expect(new Set(limited.customers)).toEqual(new Set([nameB]))
  })

  it('an unknown sort in the file’s address is refused, never dropped', async () => {
    const answer = await call('owner', 'POST', '/exports', { listKey: 'sales.orders', format: 'XLSX', query: 'sort=number', columns: COLUMNS, title: 'Ordini di vendita', locale: 'it' })
    expect(answer.status).toBe(400)
  })
})
