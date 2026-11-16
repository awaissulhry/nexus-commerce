import { fileURLToPath } from 'node:url'
import ExcelJS from 'exceljs'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { exportFileName } from '@nexus/factory-domain/views/exports'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../packages/factory-db/seed/auth'
import { seed as seedFiles } from '../../../../../packages/factory-db/seed/files'
import { seed as seedRoles } from '../../../../../packages/factory-db/seed/roles'
import { seed as seedSales } from '../../../../../packages/factory-db/seed/sales'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { callerFor, type CommandCaller } from '../../core/command'
import { completeContext, testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { SLOW_TEST_TIMEOUT_MS } from '../../testing/timeouts'
import { startHarness, type Harness } from '../auth/sessions/testing/harness'
import { viewIds } from '../notifications/view-follow/follow'
import { systemContext } from '../outbox/system'
import { exportSourceOf } from './registry'
import { runExport } from './worker'

/**
 * T19 (B-TH-008, WALL-G01 = SHEET-G02, SHEET-G14; wall surface W19) on the local stack with the core, roles, files and sales
 * seeds and the app's real routes and worker: screen = file on Sales › Orders. Customer A (the seed's SEED-C1 and its orders)
 * and customer B (another customer of the seed, three made-up orders of its own) share one tenant. The export of customer A's
 * sheet (`?party=<A>`, as the screen's address holds it) and its Pin to Today count hold only A's rows and name A; B's the same
 * for B; the company, the promise range and "Waiting for the customer" narrow the file as they narrow the screen; a malformed
 * term is refused, never dropped. The file and its Excel tab are named "Ordini - <customer> - N ordini" (the view's name when a
 * saved view was exported); a person limited to customer B who asks for A's sheet gets no row and a file that names no one.
 * Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs platform/exports`.
 */

type Json = Record<string, any>

const NS = 'exports-orders-th008'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const companyB = seedUuid(NS, 'company:B')

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

async function call(person: Person, method: 'GET' | 'POST', url: string, payload?: unknown): Promise<{ status: number; body: Json; raw: Buffer }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': person }, ...(payload === undefined ? {} : { payload: payload as object }) })
  return { status: response.statusCode, body: String(response.headers['content-type'] ?? '').includes('json') ? (response.json() as Json) : {}, raw: response.rawPayload }
}
async function ok(person: Person, method: 'GET' | 'POST', url: string, payload?: unknown, status = 200): Promise<Json> {
  const answer = await call(person, method, url, payload)
  expect(answer.status, `${person} ${method} ${url}: ${JSON.stringify(answer.body).slice(0, 500)}`).toBe(status)
  return answer.body
}

const COLUMNS = [
  { key: 'number', label: 'Numero' },
  { key: 'customer', label: 'Cliente' },
  { key: 'status', label: 'Stato' },
]
/** Asks for an export of Sales › Orders with the screen's address, runs the worker as its handler does: the finished job. */
async function exported(person: Person, query: string, extra: Json = {}): Promise<Json> {
  const { job } = await ok(person, 'POST', '/exports', { listKey: 'sales.orders', format: 'XLSX', query, columns: COLUMNS, title: 'Ordini di vendita', locale: 'it', ...extra }, 201)
  const outcome = await runExport(system(), job.id, { files: h.files })
  const done = (await ok(person, 'GET', `/exports/${job.id}`)).job
  expect(outcome, `${query}: ${done.failureReason}`).toBe('done')
  return done
}
/** The file's sheet: its tab's name and the order numbers of its rows (the header row first). */
async function sheetOf(person: Person, jobId: string): Promise<{ tab: string; numbers: string[]; customers: string[] }> {
  const { download } = await ok(person, 'GET', `/exports/${jobId}/download`)
  const got = await app.inject({ method: 'GET', url: download.url, headers: download.headers })
  expect(got.statusCode).toBe(200)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(got.rawPayload as unknown as ArrayBuffer)
  const sheet = workbook.worksheets[0]!
  const rows: string[][] = []
  sheet.eachRow((row) => rows.push((row.values as unknown[]).slice(1).map((value) => String(value ?? ''))))
  const header = rows.findIndex((row) => row[0] === 'Numero')
  const data = rows.slice(header + 1)
  return { tab: sheet.name, numbers: data.map((row) => row[0]!), customers: data.map((row) => row[1]!) }
}

/** A file's name without its day: what it is named after (`ordini-seed-customer-one-s-r-l-6-ordini`). */
const stem = (name: string): string => name.replace(/-\d{4}-\d{2}-\d{2}\.(xlsx|csv)$/, '')
const named = (title: string): string => stem(exportFileName(title, 'XLSX', '2000-01-01'))

let partyA: string
let partyB: string
let nameA: string
let nameB: string
let ordersA: string[]
const ordersB = { reaccept: 'TH008-B-0001', promised: 'TH008-B-0002', plain: 'TH008-B-0003' }

beforeAll(async () => {
  h = await startHarness('exports_orders_th008')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedFiles({ db: h.database, namespace: NS })
  await seedSales({ db: h.database, namespace: NS })
  const roleIds = new Map((await admin<{ id: string; key: string }>('SELECT id, key FROM "Role" WHERE "tenantId" = $1', [T])).map((row) => [row.key, row.id]))
  partyA = (await one<{ id: string }>('SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = \'SEED-C1\'', [T])).id
  partyB = (await one<{ id: string }>('SELECT id FROM "Party" WHERE "tenantId" = $1 AND \'CUSTOMER\' = ANY(roles::text[]) AND id <> $2 ORDER BY code LIMIT 1', [T, partyA])).id
  nameA = (await one<{ legalName: string }>('SELECT "legalName" FROM "Party" WHERE id = $1', [partyA])).legalName
  nameB = (await one<{ legalName: string }>('SELECT "legalName" FROM "Party" WHERE id = $1', [partyB])).legalName
  // Customer B's three orders (made-up), copied from the seed's first order: one waits for B to accept a change, one has its own
  // promise day, one plain.
  const source = 'SEED-SO-0001'
  for (const [number, promise, reaccept] of [
    [ordersB.reaccept, null, true],
    [ordersB.promised, '2031-03-14', false],
    [ordersB.plain, null, false],
  ] as const) {
    await admin(
      `INSERT INTO "SalesOrder" (id, "tenantId", "companyId", "partyId", number, "orderDate", "taxMode", "billTo", "shipTo", status, currency, "promiseDate", "reapprovalNeededAt")
       SELECT $1, "tenantId", "companyId", $2, $3, "orderDate", "taxMode", "billTo", "shipTo", 'CONFIRMED', currency, $4::date, $5::timestamptz FROM "SalesOrder" WHERE "tenantId" = $6 AND number = $7`,
      [newId(), partyB, number, promise, reaccept ? new Date().toISOString() : null, T, source],
    )
  }
  ordersA = (await admin<{ number: string }>('SELECT number FROM "SalesOrder" WHERE "tenantId" = $1 AND "partyId" = $2 ORDER BY id DESC', [T, partyA])).map((row) => row.number)
  expect(ordersA.length).toBeGreaterThan(0)
  // The owner sees every customer; "limited" is a sales person whose orders scope is customer B only (a sales rep's accounts).
  await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, \'ACTIVE\')', [PEOPLE.owner, T, `th008-owner-${PEOPLE.owner.slice(-6)}@example.com`, 'Made-up owner'])
  await admin('INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "validFrom") VALUES ($1, $2, $3, $4, true, now() - interval \'1 day\')', [newId(), T, PEOPLE.owner, roleIds.get('owner')])
  await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, \'ACTIVE\')', [PEOPLE.limited, T, `th008-limited-${PEOPLE.limited.slice(-6)}@example.com`, 'Made-up sales rep'])
  await admin('INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "partyIds", "validFrom") VALUES ($1, $2, $3, $4, true, $5::uuid[], now() - interval \'1 day\')', [newId(), T, PEOPLE.limited, roleIds.get('sales'), [partyB]])
  SESSIONS.owner = { audience: 'office', tenantId: T, actorId: PEOPLE.owner, companyId: companyA, grants: [grantOf('owner', 'all')] }
  SESSIONS.limited = { audience: 'office', tenantId: T, actorId: PEOPLE.limited, companyId: companyA, grants: [grantOf('sales', [partyB])] }
  await admin('UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1', [T])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET, rateLimit: { max: 10_000, timeWindowMs: 60_000 } },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session']) as Person] ?? null) },
  )
}, 300_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

beforeEach(async () => {
  // Each test starts with no export running (the limit of three at once).
  await admin('UPDATE "ExportJob" SET status = \'FAILED\', "finishedAt" = now(), "failureReason" = \'test reset\' WHERE status IN (\'QUEUED\', \'RUNNING\')')
})

describe('T19: screen = file on Sales › Orders (B-TH-008)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('customer A’s sheet: the file holds only A’s orders and is named after A with its rows, the tab keeping the count', async () => {
    const done = await exported('owner', `rows=all&party=${partyA}`)
    const sheet = await sheetOf('owner', done.id)
    expect(sheet.numbers.sort()).toEqual([...ordersA].sort())
    expect(new Set(sheet.customers)).toEqual(new Set([nameA]))
    for (const number of Object.values(ordersB)) expect(sheet.numbers).not.toContain(number)
    const rows = ordersA.length === 1 ? '1 ordine' : `${ordersA.length} ordini`
    // The file is named after what it holds; the job keeps what was asked (the screen's title).
    expect(stem(done.file.name)).toBe(named(`Ordini - ${nameA} - ${rows}`))
    expect(done.title).toBe('Ordini di vendita')
    expect(sheet.tab.length).toBeLessThanOrEqual(31)
    expect(sheet.tab.endsWith(` - ${rows}`)).toBe(true)
    expect(sheet.tab).not.toContain(nameB)
  })

  it('customer B’s sheet: only B’s orders, named after B; the API’s own `partyId` term reads the same', async () => {
    for (const term of ['party', 'partyId']) {
      const done = await exported('owner', `rows=all&${term}=${partyB}`)
      const sheet = await sheetOf('owner', done.id)
      expect(sheet.numbers.sort()).toEqual(Object.values(ordersB).sort())
      expect(stem(done.file.name)).toBe(named(`Ordini - ${nameB} - 3 ordini`))
      expect(JSON.stringify(sheet)).not.toContain(nameA)
    }
  })

  it('the company, the promise range and "Waiting for the customer" narrow the file as they narrow the screen', async () => {
    expect((await sheetOf('owner', (await exported('owner', `reaccept=true&party=${partyB}`)).id)).numbers).toEqual([ordersB.reaccept])
    expect((await sheetOf('owner', (await exported('owner', 'reaccept=true')).id)).numbers).toEqual([ordersB.reaccept])
    expect((await sheetOf('owner', (await exported('owner', 'rows=all&promiseFrom=2031-03-14&promiseTo=2031-03-14')).id)).numbers).toEqual([ordersB.promised])
    const elsewhere = await exported('owner', `rows=all&company=${companyB}`)
    expect((await sheetOf('owner', elsewhere.id)).numbers).toEqual([])
    expect(stem(elsewhere.file.name)).toBe('ordini-di-vendita')
    // Every customer: the screen's own title, as before.
    const all = await exported('owner', 'rows=all')
    expect((await sheetOf('owner', all.id)).numbers.sort()).toEqual([...ordersA, ...Object.values(ordersB)].sort())
    expect(stem(all.file.name)).toBe('ordini-di-vendita')
  })

  it('a saved view’s file is named after the view, with its rows', async () => {
    const done = await exported('owner', `rows=all&party=${partyB}`, { viewName: 'Brand Beta, all' })
    expect(stem(done.file.name)).toBe('brand-beta-all-3-ordini')
    expect((await sheetOf('owner', done.id)).tab).toBe('Brand Beta, all - 3 ordini')
  })

  it('a malformed customer, company or day is refused before anything runs (never a file of every customer)', async () => {
    for (const query of ['rows=all&party=SEED-C1', 'company=nope', 'rows=all&promiseFrom=2031-02-30', 'rows=all&promiseFrom=2031-03-15&promiseTo=2031-03-14']) {
      const answer = await call('owner', 'POST', '/exports', { listKey: 'sales.orders', format: 'CSV', query, columns: COLUMNS, title: 'Ordini di vendita', locale: 'it' })
      expect(answer.status, query).toBe(400)
    }
  })

  it('a person limited to customer B: A’s sheet holds no row and names no one; B’s sheet is B’s', async () => {
    const asked = await exported('limited', `rows=all&party=${partyA}`)
    expect((await sheetOf('limited', asked.id)).numbers).toEqual([])
    expect(stem(asked.file.name)).toBe('ordini-di-vendita')
    expect((await sheetOf('limited', asked.id)).tab).toBe('Ordini di vendita')
    expect(JSON.stringify(asked)).not.toContain(nameA)
    const own = await exported('limited', `rows=all&party=${partyB}`)
    expect((await sheetOf('limited', own.id)).numbers.sort()).toEqual(Object.values(ordersB).sort())
    expect(stem(own.file.name)).toBe(named(`Ordini - ${nameB} - 3 ordini`))
    // Every customer, as this person sees them: B's only.
    expect((await sheetOf('limited', (await exported('limited', 'rows=all')).id)).numbers.sort()).toEqual(Object.values(ordersB).sort())
  })

  it('Pin to Today counts the view through the same read: A’s view counts A’s orders, B’s view B’s', async () => {
    const source = exportSourceOf('sales.orders')!
    const reader = (person: Person) => callerFor(h.database, completeContext(SESSIONS[person]!, `test-${newId()}`))
    const idsOf = async (numbers: readonly string[]) => (await admin<{ id: string }>('SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = ANY($2::text[])', [T, numbers])).map((row) => row.id).sort()
    expect((await viewIds(reader('owner'), source, { query: `rows=all&party=${partyA}` })).ids.sort()).toEqual(await idsOf(ordersA))
    expect((await viewIds(reader('owner'), source, { query: `rows=all&party=${partyB}` })).ids.sort()).toEqual(await idsOf(Object.values(ordersB)))
    expect((await viewIds(reader('limited'), source, { query: `rows=all&party=${partyA}` })).ids).toEqual([])
  })
})
