import { fileURLToPath } from 'node:url'
import ExcelJS from 'exceljs'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../packages/factory-db/seed/auth'
import { seed as seedMoney } from '../../../../../packages/factory-db/seed/money'
import { seed as seedOptions } from '../../../../../packages/factory-db/seed/options'
import { seed as seedRoles } from '../../../../../packages/factory-db/seed/roles'
import { seed as seedSalesIntake } from '../../../../../packages/factory-db/seed/sales-intake'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { callerFor, type CommandCaller } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { SLOW_TEST_TIMEOUT_MS } from '../../testing/timeouts'
import { startHarness, type Harness } from '../auth/sessions/testing/harness'
import { systemContext } from '../outbox/system'
import { runExport } from './worker'

/**
 * T19 on the new columns (B-TH-018, ORD-G01, N22; threads plan TH-1a, picture 23; wall surface W19) on the local stack with the
 * core, auth, roles, money (sales, shipping, files), options and sales-intake seeds and the app's real routes and worker: the
 * orders file writes what the sheet shows. Customer A is the seed's SEED-C1 (its orders SEED-SO-0001 — season FW27 — and
 * SEED-SO-0002, whose TD24 of 2 of its 7 jackets is issued here: Invoiced Part), its jacket SEED-JKT-01 is A's private label.
 * Customer B is SEED-R1 with TH018-B-0001, a copy whose first line is our own liner SEED-LNR-01 and whose second keeps A's
 * jacket. Brand A's file names only brand A; a person limited to customer B gets B's order with A's label as "label not shown";
 * the production manager's file has Invoiced as a word and no amount, no gross (named as left out); priority, season, company,
 * customer PO, requested date and days late are written; `brand=` narrows the file as it narrows the screen. Every name and
 * number is made up. Run with `node scripts/factory/run-pg-tests.mjs platform/exports/sales-orders-columns.pg`.
 */

type Json = Record<string, any>

const NS = 'exports-orders-th018'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const C1 = seedUuid(NS, 'party:P1')
const R1 = seedUuid(NS, 'party:P4')

const PEOPLE = { owner: newId(), manager: newId(), limitedB: newId() } as const
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

async function ok(person: Person, method: 'GET' | 'POST', url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': person }, ...(payload === undefined ? {} : { payload: payload as object }) })
  expect(response.statusCode, `${person} ${method} ${url}: ${response.body.slice(0, 500)}`).toBe(status)
  return response.json() as Json
}

/** The sheet's columns, left to right, as the English screen names them. */
const COLUMNS = [
  { key: 'picture', label: 'Picture' },
  { key: 'number', label: 'Number' },
  { key: 'customerRef', label: 'Customer PO' },
  { key: 'customer', label: 'Customer' },
  { key: 'company', label: 'Company' },
  { key: 'brand', label: 'Brand' },
  { key: 'status', label: 'Status' },
  { key: 'units', label: 'Pieces' },
  { key: 'requested', label: 'Requested' },
  { key: 'promised', label: 'Promised' },
  { key: 'daysLate', label: 'Days late' },
  { key: 'invoiced', label: 'Invoiced' },
  { key: 'invoicedAmount', label: 'Invoiced amount' },
  { key: 'net', label: 'Net' },
  { key: 'gross', label: 'Gross' },
  { key: 'priority', label: 'Priority' },
  { key: 'season', label: 'Season' },
]

/** Asks for the file of the sheet's address as `person` (English), runs the worker: the finished job and its rows by heading. */
async function fileOf(person: Person, query: string): Promise<{ job: Json; rows: Record<string, string>[]; text: string }> {
  const { job } = await ok(person, 'POST', '/exports', { listKey: 'sales.orders', format: 'XLSX', query, columns: COLUMNS, title: 'Orders', locale: 'en' }, 201)
  const outcome = await runExport(system(), job.id, { files: h.files })
  const done = (await ok(person, 'GET', `/exports/${job.id}`)).job
  expect(outcome, `${query}: ${done.failureReason}`).toBe('done')
  const { download } = await ok(person, 'GET', `/exports/${job.id}/download`)
  const got = await app.inject({ method: 'GET', url: download.url, headers: download.headers })
  expect(got.statusCode).toBe(200)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(got.rawPayload as unknown as ArrayBuffer)
  const sheet = workbook.worksheets[0]!
  const lines: string[][] = []
  sheet.eachRow((row) => lines.push((row.values as unknown[]).slice(1).map((value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '')))))
  const header = lines.findIndex((line) => line.includes('Number'))
  // A money column's heading names its one currency ("Net (EUR)"): read it by the screen's heading.
  const heads = lines[header]!.map((head) => head.replace(/ \([A-Z]{3}\)$/, ''))
  const rows = lines.slice(header + 1).map((line) => Object.fromEntries(heads.map((head, index) => [head, line[index] ?? ''])))
  return { job: done, rows, text: JSON.stringify(lines) }
}
const rowOf = (file: { rows: Record<string, string>[] }, number: string): Record<string, string> => {
  const row = file.rows.find((entry) => entry.Number === number)
  expect(row, `${number} in the file`).toBeDefined()
  return row!
}

/** Issues the seed's draft TD24 (2 of SEED-SO-0002's jackets) as the issue does: its series' next number, the allocation, the series on. */
const ISSUE_TD24 = `
  DO $issue$
  DECLARE inv record; ser record; formatted text;
  BEGIN
    SELECT * INTO inv FROM "Invoice" WHERE "tenantId" = '${T}' AND "docType" = 'TD24' AND status = 'DRAFT' LIMIT 1;
    SELECT * INTO ser FROM "NumberSeries" WHERE "tenantId" = '${T}' AND "companyId" = inv."companyId" AND kind = 'INVOICE' AND status = 'ACTIVE' LIMIT 1;
    formatted := 'FT-' || to_char(current_date, 'YYYY') || '-' || lpad(ser."nextValue"::text, 5, '0');
    INSERT INTO "NumberAllocation" (id, "tenantId", "companyId", "seriesId", kind, value, formatted, "documentDate", "recordType", "recordId", "allocatedAt", "allocatedById", "requestId")
      VALUES (gen_random_uuid(), inv."tenantId", inv."companyId", ser.id, 'INVOICE', ser."nextValue", formatted, current_date, 'Invoice', inv.id, now(), '${PEOPLE.owner}', 'test-th018-issue');
    UPDATE "NumberSeries" SET "nextValue" = ser."nextValue" + 1, "lastIssuedDate" = current_date WHERE id = ser.id;
    UPDATE "Invoice" SET status = 'ISSUED', "numberSeriesId" = ser.id, number = formatted, year = extract(year FROM current_date)::int, "issueDate" = current_date,
      "issuedAt" = now(), "issuedById" = '${PEOPLE.owner}', "partyId" = inv."buyerPartyId", version = inv.version + 1,
      seller = (SELECT seller FROM "Invoice" WHERE "tenantId" = '${T}' AND "docType" = 'TD01' AND status <> 'DRAFT' LIMIT 1)
      WHERE id = inv.id;
  END
  $issue$;`

/** A version-4 UUID derived from an id and a salt (the copies' ids are valid UUIDs, as the contracts ask). */
const v4 = (expression: string, salt: string): string => {
  const hash = `md5(${expression}::text || '${salt}')`
  return `(substr(${hash}, 1, 8) || '-' || substr(${hash}, 9, 4) || '-4' || substr(${hash}, 14, 3) || '-8' || substr(${hash}, 18, 3) || '-' || substr(${hash}, 21, 12))::uuid`
}

let nameA: string
let nameB: string
let companyName: string

beforeAll(async () => {
  h = await startHarness('exports_orders_th018')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedMoney({ db: h.database, namespace: NS })
  await seedOptions({ db: h.database, namespace: NS })
  await seedSalesIntake({ db: h.database, namespace: NS })
  nameA = (await one<{ legalName: string }>('SELECT "legalName" FROM "Party" WHERE id = $1', [C1])).legalName
  nameB = (await one<{ legalName: string }>('SELECT "legalName" FROM "Party" WHERE id = $1', [R1])).legalName
  companyName = (await one<{ name: string }>('SELECT coalesce("tradeName", "legalName") AS name FROM "Company" WHERE id = $1', [companyA])).name
  // TH018-B-0001: SEED-SO-0001 copied for customer B (SEED-R1), its first line our own liner, its second A's jacket; promised
  // three days ago and not shipped (late), with B's purchase-order reference and a high priority.
  const salt = 'th018-b-0001'
  await admin(`
    CREATE TEMP TABLE o AS SELECT * FROM "SalesOrder" WHERE "tenantId" = '${T}' AND number = 'SEED-SO-0001';
    CREATE TEMP TABLE l AS SELECT * FROM "SalesOrderLine" WHERE "orderId" = (SELECT id FROM o);
    CREATE TEMP TABLE s AS SELECT * FROM "SalesOrderLineSize" WHERE "lineId" IN (SELECT id FROM l);
    UPDATE s SET id = ${v4('id', salt)}, "lineId" = ${v4('"lineId"', salt)}, "partyId" = '${R1}';
    UPDATE l SET id = ${v4('id', salt)}, "orderId" = ${v4('"orderId"', salt)}, "partyId" = '${R1}', "quoteLineId" = NULL, "styleRevisionId" = NULL;
    UPDATE l SET "styleId" = (SELECT id FROM "Style" WHERE "tenantId" = '${T}' AND code = 'SEED-LNR-01'),
      "colourwayId" = (SELECT c.id FROM "Colourway" c JOIN "Style" st ON st.id = c."styleId" WHERE st."tenantId" = '${T}' AND st.code = 'SEED-LNR-01' ORDER BY c.id LIMIT 1)
      WHERE seq = (SELECT min(seq) FROM l);
    UPDATE o SET id = ${v4('id', salt)}, "partyId" = '${R1}', number = 'TH018-B-0001', "quoteVersionId" = NULL, "customerRef" = 'B-PO-TH018', "seasonId" = NULL,
      status = 'CONFIRMED', "promiseDate" = current_date - 3, "originalPromiseDate" = current_date - 3, "priorityLevel" = 'HIGH';
    INSERT INTO "SalesOrder" SELECT * FROM o;
    INSERT INTO "SalesOrderLine" SELECT * FROM l;
    INSERT INTO "SalesOrderLineSize" SELECT * FROM s;
    DROP TABLE o, l, s;`)
  await admin(ISSUE_TD24)
  const roleIds = new Map((await admin<{ id: string; key: string }>('SELECT id, key FROM "Role" WHERE "tenantId" = $1', [T])).map((row) => [row.key, row.id]))
  for (const [person, role, parties] of [
    ['owner', 'owner', null],
    ['manager', 'production_manager', null],
    ['limitedB', 'sales', [R1]],
  ] as const) {
    await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, \'ACTIVE\')', [PEOPLE[person], T, `th018-${person.toLowerCase()}-${PEOPLE[person].slice(-6)}@example.com`, `Made-up ${person}`])
    await admin('INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "partyIds", "validFrom") VALUES ($1, $2, $3, $4, true, $5::uuid[], now() - interval \'1 day\')', [newId(), T, PEOPLE[person], roleIds.get(role), parties ?? []])
    SESSIONS[person] = { audience: 'office', tenantId: T, actorId: PEOPLE[person], companyId: companyA, grants: [grantOf(role, parties ? [...parties] : 'all')] }
  }
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

describe('T19 on the new columns: the orders file writes what the sheet shows (B-TH-018)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('the owner’s file: Picture, customer PO, company, Brand, Invoiced and its amount, requested, gross, days late, priority, season', async () => {
    const file = await fileOf('owner', 'rows=all')
    const seed1 = rowOf(file, 'SEED-SO-0001')
    expect(seed1.Picture).toMatch(/^SEED-JKT-01 /)
    expect(seed1.Brand).toBe(nameA)
    expect(seed1.Company).toBe(companyName)
    expect(seed1.Season).toBe('FW27')
    expect(seed1.Invoiced).toBe('None')
    expect(seed1['Invoiced amount']).toBe('0')
    expect(seed1.Priority).toBe('Normal')
    const seed2 = rowOf(file, 'SEED-SO-0002')
    // The issued TD24 bills 2 of its 7 jackets: Part, with the amount it bills.
    expect(seed2.Invoiced).toBe('Part')
    expect(Number(seed2['Invoiced amount'])).toBeGreaterThan(0)
    const own = (await one<{ requestedDate: Date | null; grossAmount: string }>('SELECT "requestedDate", "grossAmount" FROM "SalesOrder" WHERE "tenantId" = $1 AND number = \'SEED-SO-0002\'', [T]))
    expect(Number(seed2.Gross)).toBeCloseTo(Number(own.grossAmount) / 100, 2)
    if (own.requestedDate) expect(seed2.Requested).toBe(own.requestedDate.toISOString().slice(0, 10))
    const b = rowOf(file, 'TH018-B-0001')
    // Two styles: the liner first, "+1" more; our own collection and A's label, in the sheet's order.
    expect(b.Picture).toMatch(/^SEED-LNR-01 .* \(\+1\)$/)
    expect(b.Brand).toBe(`${nameA}, Own collection`)
    expect(b['Customer PO']).toBe('B-PO-TH018')
    expect(b['Days late']).toBe('3')
    expect(b.Priority).toBe('High')
    expect(b.Season).toBe('')
    expect(b.Customer).toBe(nameB)
  })

  it('brand A’s file (?brand=<A>): only orders that carry A’s label, its brand column names only brand A', async () => {
    const file = await fileOf('owner', `rows=all&brand=${C1}`)
    const numbers = file.rows.map((row) => row.Number).sort()
    const expected = (await admin<{ number: string }>(
      `SELECT DISTINCT o.number FROM "SalesOrder" o JOIN "SalesOrderLine" l ON l."orderId" = o.id JOIN "Style" st ON st.id = l."styleId" WHERE o."tenantId" = $1 AND st."brandPartyId" = $2 ORDER BY 1`,
      [T, C1],
    )).map((row) => row.number).sort()
    expect(numbers).toEqual(expected)
    for (const row of file.rows) expect((row.Brand ?? '').split(', ').filter((label) => label !== 'Own collection')).toEqual([nameA])
    // Our own collection: the copy for B only.
    expect((await fileOf('owner', 'rows=all&brand=own')).rows.map((row) => row.Number)).toEqual(['TH018-B-0001'])
    // A malformed brand is refused before anything runs.
    const refused = await app.inject({ method: 'POST', url: '/exports', headers: { 'x-test-session': 'owner' }, payload: { listKey: 'sales.orders', format: 'CSV', query: 'brand=Brand Alpha', columns: COLUMNS, title: 'Orders', locale: 'en' } })
    expect(refused.statusCode).toBe(400)
  })

  it('a person limited to customer B: B’s order only, A’s label as "label not shown" — the file never names customer A', async () => {
    const file = await fileOf('limitedB', 'rows=all')
    expect(file.rows.map((row) => row.Number)).toEqual(['TH018-B-0001'])
    expect(rowOf(file, 'TH018-B-0001').Brand).toBe('Label not shown, Own collection')
    expect(file.text).not.toContain(nameA)
    expect(file.text).not.toContain('SEED-SO-000')
    // Asking for A's label: B's own order (it carries the label), nothing of A's.
    const asked = await fileOf('limitedB', `rows=all&brand=${C1}`)
    expect(asked.rows.map((row) => row.Number)).toEqual(['TH018-B-0001'])
    expect(asked.text).not.toContain(nameA)
  })

  it('the production manager: Invoiced as a word, no amount and no gross (left out by the price grain, named)', async () => {
    const file = await fileOf('manager', 'rows=all')
    expect(rowOf(file, 'SEED-SO-0002').Invoiced).toBe('Part')
    expect(Object.keys(file.rows[0]!)).not.toContain('Invoiced amount')
    expect(Object.keys(file.rows[0]!)).not.toContain('Gross')
    expect(Object.keys(file.rows[0]!)).not.toContain('Net')
    expect(file.job.omitted.map((column: Json) => column.key).sort()).toEqual(['gross', 'invoicedAmount', 'net'])
  })
})
