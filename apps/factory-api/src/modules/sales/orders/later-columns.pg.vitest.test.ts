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
import { useCustomerUrgency } from './customer-urgency'
// B-CW-010: the production lane's real reader (the first urgency case below takes the registered one away).
import { customerUrgencySource } from '../../production/brand/urgency-of'

/**
 * The later orders columns (B-TH-059; threads plan TH-4; N23, ORD-G08; features O-SAL-ORD-LIST.grid-F16/F17/F18,
 * O-SAL-ORD-LIST.tiles-F05; wall W27) on the local stack with the core, auth, roles and money seeds (production and shipping
 * inside: SEED-SO-0002 with its work order SEED-WO-0001 cut and scanned, its shipment SH-0001; SEED-SO-0001 with its deposit
 * paid), the app's real routes and export worker:
 *
 *   - progress (asked with progress=true): the order's cells in work orders past DRAFT, summed — the work order record's own
 *     counts; none asked: no progress key; no work order: null;
 *   - paid and balance (price grain): what the order's deposit requests and invoices received, what is still to pay; absent
 *     for a reader without the price grain;
 *   - open pieces, sites, the order note and the office's priority; At risk from the ORDER_LATE_RISK rule's own threshold
 *     (switched off: nobody is at risk); the Invoiced and At risk terms keep exactly the rows the columns say;
 *   - the customer's own urgency: read-only, null and no row until the production lane's reader is registered;
 *   - the file writes the later columns (money only with the grain) and follows the screen's new terms;
 *   - the wall (W27): a person limited to customer B reads B's rows only — nothing of A's notes or sites.
 *
 * Customer A is SEED-C1, B is SEED-R1 with one made-up order (T059-B-01, promised in two days). Every name and number is
 * made up. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/orders/later-columns.pg`.
 */

type Json = Record<string, any>

const NS = 'orders-th059'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')

// B-SA-070: + noWork, a Sales reader without workorders.view (the session alone: no assignment needed for a read).
const PEOPLE = { owner: newId(), planner: newId(), limited: newId(), noWork: newId() } as const
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
/** The screen's rows of an address (the screen's "All" view, `rows=all`, is the API's list without `open`). */
const rows = async (person: Person, address = ''): Promise<Json[]> => {
  const query = address.split('&').filter((term) => term !== '' && term !== 'rows=all').join('&')
  const answer = await ok(person, 'GET', `/sales/orders?limit=200${query ? `&${query}` : ''}`)
  expect(answer.nextCursor).toBeNull()
  return answer.orders as Json[]
}
const rowOf = async (person: Person, number: string, query = ''): Promise<Json> => (await rows(person, `q=${number}${query ? `&${query}` : ''}`)).find((row) => row.number === number)!

const dayPlus = (days: number): string => {
  const at = new Date(`${businessDate(new Date())}T00:00:00.000Z`)
  at.setUTCDate(at.getUTCDate() + days)
  return at.toISOString().slice(0, 10)
}
/** A version-4 UUID derived from an id and a salt. */
const v4 = (expression: string, salt: string): string => {
  const hash = `md5(${expression}::text || '${salt}')`
  return `(substr(${hash}, 1, 8) || '-' || substr(${hash}, 9, 4) || '-4' || substr(${hash}, 14, 3) || '-8' || substr(${hash}, 18, 3) || '-' || substr(${hash}, 21, 12))::uuid`
}
async function copyOrder(number: string, partyId: string, promise: string): Promise<string> {
  const salt = number.toLowerCase()
  await admin(`
    CREATE TEMP TABLE o AS SELECT * FROM "SalesOrder" WHERE "tenantId" = '${T}' AND number = 'SEED-SO-0001';
    CREATE TEMP TABLE l AS SELECT * FROM "SalesOrderLine" WHERE "orderId" = (SELECT id FROM o);
    CREATE TEMP TABLE s AS SELECT * FROM "SalesOrderLineSize" WHERE "lineId" IN (SELECT id FROM l);
    UPDATE s SET id = ${v4('id', salt)}, "lineId" = ${v4('"lineId"', salt)}, "partyId" = '${partyId}';
    UPDATE l SET id = ${v4('id', salt)}, "orderId" = ${v4('"orderId"', salt)}, "partyId" = '${partyId}', "quoteLineId" = NULL, "styleRevisionId" = NULL;
    UPDATE o SET id = ${v4('id', salt)}, "partyId" = '${partyId}', number = '${number}', "quoteVersionId" = NULL, "customerRef" = NULL, "customerSeq" = NULL,
      status = 'CONFIRMED', "promiseDate" = '${promise}'::date, "originalPromiseDate" = '${promise}'::date, "orderDate" = '${dayPlus(-5)}'::date;
    INSERT INTO "SalesOrder" SELECT * FROM o;
    INSERT INTO "SalesOrderLine" SELECT * FROM l;
    INSERT INTO "SalesOrderLineSize" SELECT * FROM s;
    DROP TABLE o, l, s;`)
  return (await one<{ id: string }>('SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = $2', [T, number])).id
}

/** The file of Sales › Orders for an address, the worker run as its handler does: its rows by header, and the columns left out. */
async function filed(person: Person, query: string, columns: { key: string; label: string }[]): Promise<{ rows: Record<string, string>[]; omitted: string[] }> {
  const { job } = await ok(person, 'POST', '/exports', { listKey: 'sales.orders', format: 'XLSX', query, columns, title: 'Orders', locale: 'en' }, 201)
  const outcome = await runExport(system(), job.id, { files: h.files })
  const done = (await ok(person, 'GET', `/exports/${job.id}`)).job
  expect(outcome, `${query}: ${done.failureReason}`).toBe('done')
  const { download } = await ok(person, 'GET', `/exports/${job.id}/download`)
  const got = await app.inject({ method: 'GET', url: download.url, headers: download.headers })
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(got.rawPayload as unknown as ArrayBuffer)
  const lines: string[][] = []
  workbook.worksheets[0]!.eachRow((row) => lines.push((row.values as unknown[]).slice(1).map((value) => (value && typeof value === 'object' && 'text' in value ? String((value as { text: unknown }).text) : String(value ?? '')))))
  const head = lines.findIndex((line) => line[0] === 'Number')
  const header = lines[head]!
  return { rows: lines.slice(head + 1).map((line) => Object.fromEntries(header.map((label, index) => [label, line[index] ?? '']))), omitted: ((job.omitted ?? []) as Json[]).map((column) => column.key as string) }
}

let partyA: string
let partyB: string
let orderB: string
let order1: string
let order2: string
let riskRule: string

beforeAll(async () => {
  h = await startHarness('orders_th059')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedMoney({ db: h.database, namespace: NS })
  const roleIds = new Map((await admin<{ id: string; key: string }>('SELECT id, key FROM "Role" WHERE "tenantId" = $1', [T])).map((row) => [row.key, row.id]))
  partyA = (await one<{ id: string }>('SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = \'SEED-C1\'', [T])).id
  partyB = (await one<{ id: string }>('SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = \'SEED-R1\'', [T])).id
  order1 = (await one<{ id: string }>('SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = \'SEED-SO-0001\'', [T])).id
  order2 = (await one<{ id: string }>('SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = \'SEED-SO-0002\'', [T])).id
  orderB = await copyOrder('T059-B-01', partyB, dayPlus(2))
  await admin(`UPDATE "SalesOrder" SET "internalNote" = 'Made-up office note of customer A', "priorityLevel" = 'HIGH', priority = 7 WHERE id = $1`, [order1])
  // One ORDER_LATE_RISK rule for every company, five days (the seeds' own switched off).
  await admin(`UPDATE "AlertRule" SET enabled = false WHERE "tenantId" = $1 AND "ruleKind" = 'ORDER_LATE_RISK'`, [T])
  riskRule = newId()
  await admin(`INSERT INTO "AlertRule" (id, "tenantId", "ruleKind", trigger, name, threshold, enabled) VALUES ($1, $2, 'ORDER_LATE_RISK', 'CONDITION', 'Made-up risk rule', '{"daysBeforePromise": 5}'::jsonb, true)`, [riskRule, T])
  for (const [person, role, parties] of [['owner', 'owner', null], ['planner', 'planner', null], ['limited', 'sales', [partyB]]] as const) {
    await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, \'ACTIVE\')', [PEOPLE[person], T, `th059-${person}-${PEOPLE[person].slice(-6)}@example.com`, `Made-up ${person}`])
    await admin('INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "partyIds", "validFrom") VALUES ($1, $2, $3, $4, true, $5::uuid[], now() - interval \'1 day\')', [newId(), T, PEOPLE[person], roleIds.get(role), parties ?? []])
    SESSIONS[person] = { audience: 'office', tenantId: T, actorId: PEOPLE[person], companyId: companyA, grants: [grantOf(role, parties ? [...parties] : 'all')] }
  }
  await admin('UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1', [T])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET, rateLimit: { max: 10_000, timeWindowMs: 60_000 } },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session']) as Person] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  useCustomerUrgency(undefined)
  await app?.close()
  await h?.close()
}, 60_000)

beforeEach(async () => {
  await admin('UPDATE "ExportJob" SET status = \'FAILED\', "finishedAt" = now(), "failureReason" = \'test reset\' WHERE status IN (\'QUEUED\', \'RUNNING\')')
})

describe('B-TH-059 progress (N23, grid-F16)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it("the order's cells in work orders past DRAFT, summed: the work order record's own counts", async () => {
    const workOrders = await admin<{ id: string }>(
      `SELECT DISTINCT wo.id FROM "WorkOrder" wo JOIN "WorkOrderSize" c ON c."workOrderId" = wo.id JOIN "SalesOrderLine" l ON l.id = c."salesOrderLineId"
        WHERE l."orderId" = $1 AND wo.status NOT IN ('DRAFT', 'CANCELLED') AND wo.kind <> 'REPAIR'`,
      [order2],
    )
    expect(workOrders.length).toBeGreaterThan(0)
    const cells: Json[] = []
    for (const workOrder of workOrders) cells.push(...((await ok('owner', 'GET', `/production/work-orders/${workOrder.id}`)).workOrder.cells as Json[]).filter((cell) => cell.salesOrderId === order2))
    const sumOrNull = (values: (number | null)[]) => values.reduce<number | null>((total, value) => (value === null ? total : (total ?? 0) + value), null)
    const row = await rowOf('owner', 'SEED-SO-0002', 'progress=true')
    // B-CW-015: + the pieces ORDERED (its lines' quantities, a fee left out), counted here in SQL — the order page's base.
    const ordered = Number((await one<{ pieces: string }>(`SELECT coalesce(sum(quantity), 0) AS pieces FROM "SalesOrderLine" WHERE "orderId" = $1 AND kind <> 'FEE'`, [order2])).pieces)
    expect(ordered).toBeGreaterThan(0)
    expect(row.progress).toEqual({
      inWork: cells.reduce((total, cell) => total + cell.quantity, 0),
      cut: sumOrNull(cells.map((cell) => cell.progress.cut)),
      sewn: sumOrNull(cells.map((cell) => cell.progress.sewn)),
      finished: sumOrNull(cells.map((cell) => cell.progress.finished)),
      ordered,
    })
    // An order without a work order past DRAFT: null; not asked: no progress at all.
    expect((await rowOf('owner', 'T059-B-01', 'progress=true')).progress).toBeNull()
    expect(await rowOf('owner', 'SEED-SO-0002')).not.toHaveProperty('progress')
  })
})

describe('B-TH-059 paid and balance (grid-F17, price grain)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it("what the order's deposit requests and invoices received, and what is still to pay", async () => {
    for (const orderId of [order1, order2]) {
      const order = await one<{ number: string; gross: number }>('SELECT number, "grossAmount" AS gross FROM "SalesOrder" WHERE id = $1', [orderId])
      const deposits = await one<{ paid: string }>(`SELECT coalesce(sum(a.amount), 0) AS paid FROM "PaymentAllocation" a JOIN "DepositRequest" r ON r.id = a."depositRequestId" WHERE r."orderId" = $1`, [orderId])
      const invoices = await admin<{ id: string }>(
        `SELECT DISTINCT i.id FROM "Invoice" i LEFT JOIN "InvoiceLine" il ON il."invoiceId" = i.id LEFT JOIN "SalesOrderLine" l ON l.id = il."salesOrderLineId"
          WHERE i."docType" IN ('TD01', 'TD24', 'TD05') AND i.status <> 'DRAFT' AND (i."salesOrderId" = $1 OR l."orderId" = $1)`,
        [orderId],
      )
      // The seeds' invoices of these orders bill them alone, and nothing is credited or closed short.
      for (const invoice of invoices) expect((await admin(`SELECT DISTINCT l."orderId" FROM "InvoiceLine" il JOIN "SalesOrderLine" l ON l.id = il."salesOrderLineId" WHERE il."invoiceId" = $1 AND l."orderId" <> $2`, [invoice.id, orderId])).length).toBe(0)
      const placed = invoices.length > 0 ? Number((await one<{ paid: string }>(`SELECT coalesce(sum(amount), 0) AS paid FROM "PaymentAllocation" WHERE "invoiceId" = ANY($1::uuid[])`, [invoices.map((invoice) => invoice.id)])).paid) : 0
      expect((await admin(`SELECT 1 FROM "SalesOrderLine" WHERE "orderId" = $1 AND "closedShortQuantity" IS NOT NULL`, [orderId])).length).toBe(0)
      const paid = Number(deposits.paid) + placed
      const row = await rowOf('owner', order.number)
      expect({ paid: row.paid, balance: row.balance }, order.number).toEqual({ paid, balance: Math.max(0, order.gross - paid) })
    }
    // SEED-SO-0001's deposit is paid: the column says so.
    expect((await rowOf('owner', 'SEED-SO-0001')).paid).toBeGreaterThan(0)
  })

  it('absent without the price grain (never an empty 0)', async () => {
    const row = await rowOf('planner', 'SEED-SO-0001')
    expect(row).not.toHaveProperty('paid')
    expect(row).not.toHaveProperty('balance')
    expect(row).not.toHaveProperty('netAmount')
    expect(row.openUnits).toEqual(expect.any(Number))
  })
})

describe('B-TH-059 open pieces, sites, note, priority', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('open pieces: an open order owes its pieces less those that left', async () => {
    for (const row of await rows('owner', 'rows=all')) {
      const open = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'].includes(row.status)
      expect(row.openUnits, row.number).toBe(open ? Math.max(0, row.units - row.shippedUnits) : 0)
    }
    const shipped = await rowOf('owner', 'SEED-SO-0002')
    expect(shipped.shippedUnits).toBeGreaterThan(0)
  })

  it("sites: the sites of the order's lines and work orders; the order note and the office's priority", async () => {
    const expected = await admin<{ id: string; code: string; name: string }>(
      `SELECT DISTINCT s.id, s.code, s.name FROM "Site" s WHERE s.id IN (
         SELECT l."siteId" FROM "SalesOrderLine" l WHERE l."orderId" = $1 AND l."siteId" IS NOT NULL
         UNION SELECT wo."siteId" FROM "WorkOrder" wo JOIN "WorkOrderSize" c ON c."workOrderId" = wo.id JOIN "SalesOrderLine" l ON l.id = c."salesOrderLineId"
           WHERE l."orderId" = $1 AND wo.status <> 'CANCELLED' AND wo.kind <> 'REPAIR') ORDER BY s.code`,
      [order2],
    )
    expect(expected.length).toBeGreaterThan(0)
    expect((await rowOf('owner', 'SEED-SO-0002')).sites).toEqual(expected)
    const first = await rowOf('owner', 'SEED-SO-0001')
    expect(first.internalNote).toBe('Made-up office note of customer A')
    expect(first.priority).toEqual({ level: 'HIGH', words: { en: 'High', it: 'Alta' }, number: 7, urgentReason: null })
    expect((await rowOf('owner', 'T059-B-01')).priority).toMatchObject({ level: 'NORMAL' })
  })
})

describe('B-TH-059 At risk (tiles-F05, ORD-G08) and the terms that open exactly the rows', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it("the ORDER_LATE_RISK rule's own threshold; switched off, nobody is at risk", async () => {
    expect((await rowOf('owner', 'T059-B-01')).atRisk).toEqual({ daysLeft: 2, daysBeforePromise: 5 })
    const flagged = (await rows('owner', 'rows=all')).filter((row) => row.atRisk !== null).map((row) => row.number).sort()
    expect(flagged).toContain('T059-B-01')
    expect((await rows('owner', 'atRisk=true')).map((row) => row.number).sort()).toEqual(flagged)
    // A company rule of one day takes nothing away (the widest covering threshold counts).
    await admin(`INSERT INTO "AlertRule" (id, "tenantId", "ruleKind", trigger, name, threshold, "companyId", enabled) VALUES ($1, $2, 'ORDER_LATE_RISK', 'CONDITION', 'Made-up company rule', '{"daysBeforePromise": 1}'::jsonb, $3, true)`, [newId(), T, companyA])
    expect((await rowOf('owner', 'T059-B-01')).atRisk).toEqual({ daysLeft: 2, daysBeforePromise: 5 })
    await admin(`UPDATE "AlertRule" SET enabled = false WHERE "tenantId" = $1 AND "ruleKind" = 'ORDER_LATE_RISK'`, [T])
    try {
      expect((await rowOf('owner', 'T059-B-01')).atRisk).toBeNull()
      expect(await rows('owner', 'atRisk=true')).toEqual([])
    } finally {
      await admin(`UPDATE "AlertRule" SET enabled = true WHERE id = $1`, [riskRule])
    }
  })

  it('Invoiced: each state keeps exactly the rows whose Invoiced says it, together every row', async () => {
    const every = await rows('owner', 'rows=all')
    const seen: string[] = []
    for (const state of ['NONE', 'PART', 'ALL']) {
      const kept = await rows('owner', `invoiced=${state}`)
      for (const row of kept) expect(row.invoiced.state, row.number).toBe(state)
      expect(kept.map((row) => row.number).sort()).toEqual(every.filter((row) => row.invoiced.state === state).map((row) => row.number).sort())
      seen.push(...kept.map((row) => row.number))
    }
    expect(seen.sort()).toEqual(every.map((row) => row.number).sort())
  })
})

describe("B-TH-059 the customer's own urgency (agreement T10): read-only", { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it("none until the production lane's reader is registered; then the column and the filter say the same", async () => {
    expect((await rows('owner', 'rows=all')).every((row) => row.customerUrgency === null)).toBe(true)
    expect(await rows('owner', 'customerUrgency=URGENT')).toEqual([])
    useCustomerUrgency({
      of: async (_db, ids) => new Map(ids.filter((id) => id === orderB).map((id) => [id, 'URGENT' as const])),
      where: (urgency) => (urgency === 'URGENT' ? { id: { in: [orderB] } } : { id: { notIn: [orderB] } }),
    })
    try {
      expect((await rowOf('owner', 'T059-B-01')).customerUrgency).toBe('URGENT')
      expect((await rows('owner', 'customerUrgency=URGENT')).map((row) => row.number)).toEqual(['T059-B-01'])
      expect((await rows('owner', 'customerUrgency=REGULAR&rows=all')).map((row) => row.number)).not.toContain('T059-B-01')
    } finally {
      useCustomerUrgency(undefined)
    }
    expect((await call('owner', 'GET', '/sales/orders?customerUrgency=SOON')).status).toBe(400)
  })
})

describe('B-TH-059 the file writes the later columns and follows the new terms', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const COLUMNS = [
    { key: 'number', label: 'Number' },
    { key: 'openUnits', label: 'Open pcs' },
    { key: 'progress', label: 'Progress' },
    { key: 'paid', label: 'Paid' },
    { key: 'balance', label: 'Balance' },
    { key: 'site', label: 'Site' },
    { key: 'note', label: 'Order note' },
    { key: 'priority', label: 'Priority' },
    { key: 'atRisk', label: 'Close to promise' }, // F-SA-216 (P15): the list rule's word ("At risk" is order health)
    { key: 'customerUrgency', label: 'Customer urgency' },
  ]

  it('every later column for the owner; money left out for a reader without the price grain', async () => {
    const file = await filed('owner', 'rows=all', COLUMNS)
    const screen = await rows('owner', 'rows=all&progress=true')
    expect(file.omitted).toEqual([])
    const second = file.rows.find((row) => row.Number === 'SEED-SO-0002')!
    const row2 = screen.find((row) => row.number === 'SEED-SO-0002')!
    expect(second['Open pcs']).toBe(String(row2.openUnits))
    expect(second.Progress).toBe(`Cut ${row2.progress.cut ?? '—'} · Sewn ${row2.progress.sewn ?? '—'} · Finished ${row2.progress.finished ?? '—'} of ${row2.progress.inWork}`)
    expect(second.Site).toBe(row2.sites.map((site: Json) => site.name).join(', '))
    const first = file.rows.find((row) => row.Number === 'SEED-SO-0001')!
    expect(first['Order note']).toBe('Made-up office note of customer A')
    expect(first.Priority).toBe('High')
    expect(first.Paid).not.toBe('')
    // F-SA-216 (sales page plan P15, P25): the ORDER_LATE_RISK rule's cell reads "Close to promise"; "At risk" is order health only.
    expect(file.rows.find((row) => row.Number === 'T059-B-01')!['Close to promise']).toBe('Close to promise (2 days left)')
    const blind = await filed('planner', 'rows=all', COLUMNS)
    expect(blind.omitted.sort()).toEqual(['balance', 'paid'])
  })

  it('the Invoiced and At risk terms narrow the file as they narrow the screen; a malformed one is refused', async () => {
    for (const query of ['invoiced=NONE', 'atRisk=true', 'rows=all&currency=EUR']) {
      expect((await filed('owner', query, COLUMNS.slice(0, 1))).rows.map((row) => row.Number).sort(), query).toEqual((await rows('owner', query)).map((row) => row.number).sort())
    }
    for (const query of ['invoiced=SOME', 'atRisk=maybe', 'currency=euro', 'customerUrgency=SOON']) {
      expect((await call('owner', 'POST', '/exports', { listKey: 'sales.orders', format: 'XLSX', query, columns: COLUMNS.slice(0, 1), title: 'Orders', locale: 'en' })).status, query).toBe(400)
    }
  })
})

describe('W27: the later columns stay inside the reader’s customers', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it("a person limited to customer B reads B's rows only: nothing of A's note, sites or orders", async () => {
    const mine = await rows('limited', 'rows=all&progress=true')
    expect(mine.map((row) => row.partyId)).toEqual(mine.map(() => partyB))
    expect(mine.map((row) => row.number)).toContain('T059-B-01')
    const text = JSON.stringify(mine)
    expect(text).not.toContain('Made-up office note of customer A')
    expect(text).not.toContain('SEED-SO-0001')
    expect(text).not.toContain(partyA)
    expect(await rows('limited', `atRisk=true&partyId=${partyA}`)).toEqual([])
  })
})

// ── B-SA-070 (sales page plan N5, picks R5, P10; 13-backend B2): the production columns of a row, `ids=`, and the wall ──
describe('B-SA-070 the production columns (production=true)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const today = () => businessDate(new Date())
  beforeAll(async () => {
    const sales = grantOf('sales', 'all')
    SESSIONS.noWork = { audience: 'office', tenantId: T, actorId: PEOPLE.noWork, companyId: companyA, grants: [{ ...sales, permissions: sales.permissions.filter((permission) => permission !== 'workorders.view') }] }
    // The file is written by the worker as the person with their LIVE roles (exports/worker requesterOf): noWork is a person of the
    // tenant holding the Sales template without workorders.view (a made-up custom role), as its session says.
    const template = templateOf('sales')!
    const noWorkRole = newId()
    await admin(`INSERT INTO "Role" (id, "tenantId", key, name, audience, permissions, grains) VALUES ($1, $2, 'custom.sa070-no-work', 'Made-up Sales without work orders', 'OFFICE', $3::text[], $4::text[])`, [noWorkRole, T, template.permissions.filter((permission) => permission !== 'workorders.view'), [...template.grains]])
    await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, \'ACTIVE\')', [PEOPLE.noWork, T, `sa070-nowork-${PEOPLE.noWork.slice(-6)}@example.com`, 'Made-up noWork'])
    await admin('INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "partyIds", "validFrom") VALUES ($1, $2, $3, $4, true, $5::uuid[], now() - interval \'1 day\')', [newId(), T, PEOPLE.noWork, noWorkRole, []])
    // SEED-SO-0002's stored production state: Sewing since today, computed On track raised to At risk (a raise standing 7 days),
    // waiting on us since now, the owner its own supervisor. T059-B-01: Preparing, no raise, waiting on the customer.
    await admin(
      `INSERT INTO "BrandOrderProduction" (id, "tenantId", "companyId", "partyId", "salesOrderId", key, stage, "stageAt", health, "healthAt",
         "healthSet", "healthReasonCode", "healthSetAt", "healthSetById", "healthSetUntil", "waitingOn", "waitingSince", "supervisorId", "supervisorAssignedAt")
       SELECT $1, o."tenantId", o."companyId", o."partyId", o.id, 'brand-production:' || o.id, 'SEWING', now(), 'ON_TRACK', now(),
         'AT_RISK', 'MATERIAL_LATE', now(), $3, ($4::date + 7), 'US', now(), $3, now() FROM "SalesOrder" o WHERE o.id = $2
       ON CONFLICT ("tenantId", key) DO UPDATE SET stage = 'SEWING', "stageAt" = now(), health = 'ON_TRACK', "healthAt" = now(), "healthSet" = 'AT_RISK',
         "healthReasonCode" = 'MATERIAL_LATE', "healthSetAt" = now(), "healthSetById" = $3, "healthSetUntil" = ($4::date + 7), "waitingOn" = 'US',
         "waitingSince" = now(), "supervisorId" = $3, "supervisorAssignedAt" = now()`,
      [newId(), order2, PEOPLE.owner, today()],
    )
    await admin(
      `INSERT INTO "BrandOrderProduction" (id, "tenantId", "companyId", "partyId", "salesOrderId", key, stage, "stageAt", health, "healthAt", "waitingOn", "waitingSince")
       SELECT $1, o."tenantId", o."companyId", o."partyId", o.id, 'brand-production:' || o.id, 'PREPARING', now(), 'AT_RISK', now(), 'BRAND', now() FROM "SalesOrder" o WHERE o.id = $2
       ON CONFLICT ("tenantId", key) DO UPDATE SET stage = 'PREPARING', health = 'AT_RISK', "waitingOn" = 'BRAND', "waitingSince" = now(), "supervisorId" = NULL, "supervisorAssignedAt" = NULL`,
      [newId(), orderB],
    )
    // One open customer request on T059-B-01 (a RUSH ask: waiting on us).
    await admin(`INSERT INTO "OrderChangeRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, status) SELECT $1, o."tenantId", o."companyId", o."partyId", o.id, 'RUSH', 'OPEN' FROM "SalesOrder" o WHERE o.id = $2`, [newId(), orderB])
  })

  it("the keeper's stored stage, the shown health (a standing raise counts), who it waits on, the mark and the open requests", async () => {
    const row = await rowOf('owner', 'SEED-SO-0002', 'production=true')
    expect(row.production).toMatchObject({ stage: 'SEWING', stageSince: today(), health: 'AT_RISK', waitingOn: 'US', held: false, supervisorMark: 'ME', openRequests: 0, openIssues: 0, withheld: [] })
    expect(row.production.since).toEqual(expect.any(String))
    // The planner (workorders.view) reads the same order as "Someone else"; never a name on a list.
    const planner = await rowOf('planner', 'SEED-SO-0002', 'production=true')
    expect(planner.production.supervisorMark).toBe('SOMEONE_ELSE')
    expect(JSON.stringify(planner)).not.toContain('Made-up owner')
    const b = await rowOf('owner', 'T059-B-01', 'production=true')
    expect(b.production).toMatchObject({ stage: 'PREPARING', health: 'AT_RISK', waitingOn: 'BRAND', supervisorMark: 'NOT_SET', openRequests: 1 })
    // An order with no stored state yet: nulls, never a made-up stage.
    const first = await rowOf('owner', 'SEED-SO-0001', 'production=true')
    if ((await admin('SELECT 1 FROM "BrandOrderProduction" WHERE "salesOrderId" = $1', [order1])).length === 0) expect(first.production).toMatchObject({ stage: null, stageSince: null, health: null, waitingOn: null, since: null })
    // Not asked: no production part at all.
    expect(await rowOf('owner', 'SEED-SO-0002')).not.toHaveProperty('production')
  })

  it('the supervisor mark and the open issues only with workorders.view: else null, named in withheld', async () => {
    const row = await rowOf('noWork', 'SEED-SO-0002', 'production=true')
    // B-CW-014: + when the oldest open issue was raised, withheld with the count (the name `openIssues` covers both).
    expect(row.production).toMatchObject({ stage: 'SEWING', health: 'AT_RISK', supervisorMark: null, openIssues: null, openIssuesSince: null, withheld: ['supervisorMark', 'openIssues'] })
  })

  it('held: a live work order that makes a line of the order is on hold', async () => {
    const held = await admin<{ id: string; status: string }>(
      `SELECT DISTINCT wo.id, wo.status FROM "WorkOrder" wo JOIN "WorkOrderSize" c ON c."workOrderId" = wo.id JOIN "SalesOrderLine" l ON l.id = c."salesOrderLineId"
        WHERE l."orderId" = $1 AND wo.status = 'ON_HOLD' AND wo.kind <> 'REPAIR'`,
      [order2],
    )
    expect((await rowOf('owner', 'SEED-SO-0002', 'production=true')).production.held).toBe(held.length > 0)
  })

  it('ids= re-reads only the rows named (at most 50); a malformed or longer list is refused in words', async () => {
    const only = await rows('owner', `rows=all&production=true&ids=${order1},${order2}`)
    expect(only.map((row) => row.number).sort()).toEqual(['SEED-SO-0001', 'SEED-SO-0002'])
    const many = Array.from({ length: 51 }, () => newId()).join(',')
    const refused = await call('owner', 'GET', `/sales/orders?ids=${many}`)
    expect(refused.status).toBe(400)
    expect((await call('owner', 'GET', '/sales/orders?ids=not-an-order-id-but-long-enough-to-pass-36')).status).toBe(400)
  })

  it('the file writes the production columns (the supervisor only with workorders.view)', async () => {
    const columns = [
      { key: 'number', label: 'Number' },
      { key: 'whereItIs', label: 'Where it is' },
      { key: 'waitingOn', label: 'Waiting on' },
      { key: 'supervisor', label: 'Supervisor' },
    ]
    const file = await filed('owner', 'rows=all', columns)
    const second = file.rows.find((row) => row.Number === 'SEED-SO-0002')!
    expect(second['Where it is']).toBe('Sewing · At risk')
    expect(second['Waiting on']).toBe('Waiting on us')
    expect(second.Supervisor).toBe('Me')
    expect((await filed('noWork', 'rows=all', columns)).omitted).toEqual(['supervisor'])
  })

  it("wall: a person limited to customer B naming A gets zero rows and zero counts, also with A's ids", async () => {
    expect(await rows('limited', `rows=all&partyId=${partyA}&production=true`)).toEqual([])
    expect(await rows('limited', `rows=all&production=true&ids=${order1},${order2}`)).toEqual([])
    const board = await ok('limited', 'GET', `/sales/orders/board?partyId=${partyA}&waiting=us`)
    expect((board.byStatus as Json[]).reduce((sum, entry) => sum + (entry.count as number), 0)).toBe(0)
    const mine = await rows('limited', 'rows=all&production=true')
    expect(mine.map((row) => row.partyId)).toEqual(mine.map(() => partyB))
    expect(JSON.stringify(mine)).not.toContain(order2)
  })
})
// ── end B-SA-070 ──

// ── B-CW-010 / B-CW-011 / B-CW-012 / B-CW-014 / B-CW-015 (customer Work tab plan §2): the row's new facts ──
/**
 * Stands on made-up copies of the seeds' SEED-SO-0001 for customer A (SEED-C1; CONFIRMED, a deposit needed: the copies keep that)
 * and on T059-B-01 of customer B (SEED-R1), each given its facts past the order's own rules (the guards off: only the read is
 * under test). Customer A's urgency switch is ON, customer B's is OFF.
 *
 *   T-CW-A-U2    kept Urgent, place 2 (its own mark) · T-CW-A-ASK kept Regular, an "Urgent – asked" (RUSH request) OPEN on it, two
 *   production issues OPEN on it (the older raised two days ago) and one ANSWERED older still · T-CW-A-BACK kept Regular, set by us ·
 *   T-CW-A-LOCK kept Regular, locked by us · T-CW-A-REG kept Regular, its own · T-CW-A-XDEP needs NO deposit, an extra deposit
 *   request OPEN (due in 9 days), no kept row · T-CW-A-DEP its deposit request OPEN (due in 4 days) · T-CW-A-YES a change waits for
 *   the customer's new yes · T-CW-A-GONE the same mark on a CANCELLED order · T059-B-01 kept Urgent, place 1 (the switch is off).
 */
describe('B-CW-010…015 the row: the urgency state, a new yes, an extra deposit, asked production since', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const rulesOff = (statements: string) => admin(`BEGIN; SET LOCAL session_replication_role = replica; ${statements} COMMIT;`)
  const made = { u2: '', ask: '', back: '', lock: '', reg: '', xdep: '', dep: '', yes: '', gone: '' }
  const ask = newId()
  const older = new Date(Date.now() - 2 * 86_400_000)
  const newer = new Date(Date.now() - 3_600_000)
  const numbersOf = (list: Json[]): string[] => list.map((row) => row.number as string).sort()

  /** The customer's urgency switch (one PortalSettings row per party, its id the party's). */
  const urgencySwitch = (partyId: string, on: boolean) =>
    rulesOff(`INSERT INTO "PortalSettings" (id, "tenantId", "partyId", "portalOn", "productionUrgencyOn", "createdAt", "updatedAt") VALUES ('${partyId}', '${T}', '${partyId}', false, ${on}, now(), now())
      ON CONFLICT (id) DO UPDATE SET "productionUrgencyOn" = EXCLUDED."productionUrgencyOn", version = "PortalSettings".version + 1, "updatedAt" = now();`)
  /** The urgency columns of an order's kept production row (the row made at PREPARING, or only these columns moved). */
  const mark = (orderId: string, urgency: { urgency: 'URGENT' | 'REGULAR'; rank?: number; setBy?: 'BRAND' | 'FACTORY'; locked?: boolean }) =>
    rulesOff(`INSERT INTO "BrandOrderProduction" (id, "tenantId", "companyId", "partyId", "salesOrderId", key, stage, "stageAt", urgency, "urgentRank", "urgencySetAt", "urgencySetBy", "urgencyLocked", "urgencyLockReason", "urgencyLockedAt")
      SELECT '${newId()}', o."tenantId", o."companyId", o."partyId", o.id, 'brand-production:' || o.id, 'PREPARING', now(), '${urgency.urgency}', ${urgency.rank ?? 'NULL'}, ${urgency.setBy ? 'now()' : 'NULL'}, ${urgency.setBy ? `'${urgency.setBy}'` : 'NULL'},
             ${urgency.locked === true}, ${urgency.locked ? "'Made-up: the leather is late.'" : 'NULL'}, ${urgency.locked ? 'now()' : 'NULL'}
        FROM "SalesOrder" o WHERE o.id = '${orderId}'
      ON CONFLICT ("tenantId", key) DO UPDATE SET urgency = EXCLUDED.urgency, "urgentRank" = EXCLUDED."urgentRank", "urgencySetAt" = EXCLUDED."urgencySetAt", "urgencySetBy" = EXCLUDED."urgencySetBy",
        "urgencyLocked" = EXCLUDED."urgencyLocked", "urgencyLockReason" = EXCLUDED."urgencyLockReason", "urgencyLockedAt" = EXCLUDED."urgencyLockedAt";`)
  /** A deposit request of the order (no schedule step: a deposit, not a balance before shipping), OPEN, due that day. */
  const askDeposit = (orderId: string, due: string) =>
    rulesOff(`INSERT INTO "DepositRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, currency, amount, "dueDate", "fiscalDocument", "fiscalRule")
      SELECT '${newId()}', o."tenantId", o."companyId", o."partyId", o.id, 'ACCONTO', 'EUR', 30000, '${due}'::date, 'NONE', 'test.deposit.EU_B2B_VIES' FROM "SalesOrder" o WHERE o.id = '${orderId}';`)
  /** A production issue of the order (a made-up task and message: only the row's count and time are read here). */
  const issue = (orderId: string, status: 'OPEN' | 'ANSWERED', raisedAt: Date) =>
    rulesOff(`INSERT INTO "ProductionIssue" (id, "tenantId", "companyId", "partyId", "recordType", "recordId", "salesOrderId", "taskId", "messageId", source, status, "raisedAt", "dueDate", "answeredAt", version, "createdAt", "updatedAt")
      SELECT '${newId()}', o."tenantId", o."companyId", o."partyId", 'SalesOrder', o.id, o.id, '${newId()}', '${newId()}', 'OFFICE', '${status}', '${raisedAt.toISOString()}'::timestamptz, (now() + interval '2 days')::date, ${status === 'ANSWERED' ? 'now()' : 'NULL'}, 1, now(), now()
        FROM "SalesOrder" o WHERE o.id = '${orderId}';`)
  const urgencyOf = async (number: string): Promise<{ state: Json | null; mark: string | null }> => {
    const row = await rowOf('owner', number)
    return { state: row.customerUrgencyState, mark: row.customerUrgency }
  }

  beforeAll(async () => {
    // A Sales reader without workorders.view (the session alone is enough for a read; the block above makes the same one).
    const sales = grantOf('sales', 'all')
    SESSIONS.noWork ??= { audience: 'office', tenantId: T, actorId: PEOPLE.noWork, companyId: companyA, grants: [{ ...sales, permissions: sales.permissions.filter((permission) => permission !== 'workorders.view') }] }
    made.u2 = await copyOrder('T-CW-A-U2', partyA, dayPlus(30))
    made.ask = await copyOrder('T-CW-A-ASK', partyA, dayPlus(31))
    made.back = await copyOrder('T-CW-A-BACK', partyA, dayPlus(32))
    made.lock = await copyOrder('T-CW-A-LOCK', partyA, dayPlus(33))
    made.reg = await copyOrder('T-CW-A-REG', partyA, dayPlus(34))
    made.xdep = await copyOrder('T-CW-A-XDEP', partyA, dayPlus(35))
    made.dep = await copyOrder('T-CW-A-DEP', partyA, dayPlus(36))
    made.yes = await copyOrder('T-CW-A-YES', partyA, dayPlus(37))
    made.gone = await copyOrder('T-CW-A-GONE', partyA, dayPlus(38))
    await urgencySwitch(partyA, true)
    await urgencySwitch(partyB, false)
    await mark(made.u2, { urgency: 'URGENT', rank: 2, setBy: 'BRAND' })
    await mark(made.ask, { urgency: 'REGULAR' })
    await mark(made.back, { urgency: 'REGULAR', setBy: 'FACTORY' })
    await mark(made.lock, { urgency: 'REGULAR', setBy: 'FACTORY', locked: true })
    await mark(made.reg, { urgency: 'REGULAR', setBy: 'BRAND' })
    await mark(orderB, { urgency: 'URGENT', rank: 1, setBy: 'BRAND' })
    // The "Urgent – asked" of T-CW-A-ASK: an OPEN RUSH request (as the block above asks one of T059-B-01).
    await admin(`INSERT INTO "OrderChangeRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, status) SELECT $1, o."tenantId", o."companyId", o."partyId", o.id, 'RUSH', 'OPEN' FROM "SalesOrder" o WHERE o.id = $2`, [ask, made.ask])
    await issue(made.ask, 'OPEN', older)
    await issue(made.ask, 'OPEN', newer)
    await issue(made.ask, 'ANSWERED', new Date(older.getTime() - 5 * 86_400_000))
    await rulesOff(`UPDATE "SalesOrder" SET "depositRequired" = false WHERE id = '${made.xdep}';`)
    await askDeposit(made.xdep, dayPlus(9))
    await askDeposit(made.dep, dayPlus(4))
    await rulesOff(`UPDATE "SalesOrder" SET "reapprovalNeededAt" = now() WHERE id IN ('${made.yes}', '${made.gone}');`)
    await rulesOff(`UPDATE "SalesOrder" SET status = 'CANCELLED', "cancelReason" = 'Made-up: the customer withdrew it.', "closedAt" = now() WHERE id = '${made.gone}';`)
    useCustomerUrgency(customerUrgencySource)
  }, 120_000)

  afterAll(() => {
    // As the cases after this block found it (the first urgency case took the reader away).
    useCustomerUrgency(undefined)
  })

  it('B-CW-010 the state of four with its place, our lock and the open "Urgent – asked"; the mark is the state\'s', async () => {
    expect(await urgencyOf('T-CW-A-U2')).toEqual({ state: { state: 'URGENT', urgentRank: 2, locked: false, requestId: null }, mark: 'URGENT' })
    expect(await urgencyOf('T-CW-A-ASK')).toEqual({ state: { state: 'ASKED', urgentRank: null, locked: false, requestId: ask }, mark: 'REGULAR' })
    expect(await urgencyOf('T-CW-A-BACK')).toEqual({ state: { state: 'SET_BACK', urgentRank: null, locked: false, requestId: null }, mark: 'REGULAR' })
    expect(await urgencyOf('T-CW-A-LOCK')).toEqual({ state: { state: 'SET_BACK', urgentRank: null, locked: true, requestId: null }, mark: 'REGULAR' })
    expect(await urgencyOf('T-CW-A-REG')).toEqual({ state: { state: 'REGULAR', urgentRank: null, locked: false, requestId: null }, mark: 'REGULAR' })
    // No kept row yet: none, never a made-up Regular.
    expect(await urgencyOf('T-CW-A-XDEP')).toEqual({ state: null, mark: null })
    // A cancelled order is no longer kept: none, though its row is still there.
    await mark(made.gone, { urgency: 'URGENT', rank: 3, setBy: 'BRAND' })
    expect(await urgencyOf('T-CW-A-GONE')).toEqual({ state: null, mark: null })
    // The filter keeps exactly the rows the column says (the mark is derived from the state: they never differ).
    const urgent = await rows('owner', 'customerUrgency=URGENT')
    expect(numbersOf(urgent)).toContain('T-CW-A-U2')
    for (const row of urgent) expect(row.customerUrgencyState?.state, row.number).toBe('URGENT')
    const regular = await rows('owner', 'customerUrgency=REGULAR')
    expect(numbersOf(regular)).toEqual(expect.arrayContaining(['T-CW-A-ASK', 'T-CW-A-BACK', 'T-CW-A-LOCK', 'T-CW-A-REG']))
    for (const row of regular) expect(['ASKED', 'REGULAR', 'SET_BACK'], row.number).toContain(row.customerUrgencyState?.state)
    // Who set or locked it is never sent (worker privacy): the state holds these four fields only.
    expect(Object.keys((await rowOf('owner', 'T-CW-A-LOCK')).customerUrgencyState).sort()).toEqual(['locked', 'requestId', 'state', 'urgentRank'])
  })

  it('B-CW-010 the customer\'s switch off: no state and no mark, though the kept row says Urgent; a reader without states keeps the old mark', async () => {
    // Customer B's switch is off: its order's Urgent 1 counts for nothing.
    expect(await urgencyOf('T059-B-01')).toEqual({ state: null, mark: null })
    await urgencySwitch(partyA, false)
    try {
      for (const number of ['T-CW-A-U2', 'T-CW-A-ASK', 'T-CW-A-LOCK']) expect(await urgencyOf(number), number).toEqual({ state: null, mark: null })
    } finally {
      await urgencySwitch(partyA, true)
    }
    expect((await urgencyOf('T-CW-A-U2')).state).toMatchObject({ state: 'URGENT', urgentRank: 2 })
    // The hook's old shape (no `states`): the row falls back to `of` — the mark as before, no state.
    useCustomerUrgency({
      of: async (_db, ids) => new Map(ids.filter((id) => id === made.u2).map((id) => [id, 'URGENT' as const])),
      where: () => ({ id: { in: [] } }),
    })
    try {
      expect(await urgencyOf('T-CW-A-U2')).toEqual({ state: null, mark: 'URGENT' })
      expect(await urgencyOf('T-CW-A-REG')).toEqual({ state: null, mark: null })
    } finally {
      useCustomerUrgency(customerUrgencySource)
    }
  })

  it('B-CW-011 reaccept: a change waits for the customer\'s new yes — the rows the reaccept term keeps; never a cancelled order', async () => {
    expect((await rowOf('owner', 'T-CW-A-YES')).reaccept).toBe(true)
    expect((await rowOf('owner', 'T-CW-A-U2')).reaccept).toBe(false)
    expect((await rowOf('owner', 'T-CW-A-GONE')).reaccept).toBe(false)
    const every = await rows('owner', 'rows=all')
    const waiting = every.filter((row) => row.reaccept === true)
    expect(numbersOf(waiting)).toContain('T-CW-A-YES')
    expect(numbersOf(await rows('owner', 'reaccept=true'))).toEqual(numbersOf(waiting))
  })

  it('B-CW-012 an extra deposit still open on an order that needs none: its due day, the state stays Not needed; a day, never an amount', async () => {
    const extra = (await rowOf('owner', 'T-CW-A-XDEP')).deposit
    expect(extra).toEqual({ state: 'NOT_NEEDED', dueDate: dayPlus(9), extraOpenDue: dayPlus(9) })
    // The order's own deposit, its request open: the deposit itself, no extra.
    expect((await rowOf('owner', 'T-CW-A-DEP')).deposit).toEqual({ state: 'OPEN', dueDate: dayPlus(4), extraOpenDue: null })
    // Needed and not asked yet: nothing open, no extra.
    expect((await rowOf('owner', 'T-CW-A-U2')).deposit).toEqual({ state: 'MISSING', dueDate: null, extraOpenDue: null })
    // A reader without the price grain reads the same words and day (nothing of it is an amount).
    expect((await rowOf('planner', 'T-CW-A-XDEP')).deposit).toEqual(extra)
    expect(JSON.stringify(extra)).not.toContain('30000')
  })

  it('B-CW-014 asked production since: when the oldest OPEN issue was raised; withheld with the count without workorders.view', async () => {
    const row = await rowOf('owner', 'T-CW-A-ASK', 'production=true')
    expect(row.production).toMatchObject({ openIssues: 2, openIssuesSince: older.toISOString(), withheld: [] })
    // No open issue: 0 and no time.
    expect((await rowOf('owner', 'T-CW-A-REG', 'production=true')).production).toMatchObject({ openIssues: 0, openIssuesSince: null })
    const blind = await rowOf('noWork', 'T-CW-A-ASK', 'production=true')
    expect(blind.production).toMatchObject({ supervisorMark: null, openIssues: null, openIssuesSince: null, withheld: ['supervisorMark', 'openIssues'] })
    expect(JSON.stringify(blind)).not.toContain(older.toISOString())
    // The open customer request is counted for everyone (it waits on us): not an office-only fact.
    expect(blind.production.openRequests).toBe(1)
  })

  it('B-CW-015 the pieces ordered are the lines\' own (a fee left out), whatever the work orders hold; no work order past DRAFT: no progress at all', async () => {
    // T-CW-A-U2 has no work order: the row's progress stays null (the pieces line needs the floor's counts).
    expect((await rowOf('owner', 'T-CW-A-U2', 'progress=true')).progress).toBeNull()
    const row = await rowOf('owner', 'SEED-SO-0002', 'progress=true')
    const goods = Number((await one<{ pieces: string }>(`SELECT coalesce(sum(quantity), 0) AS pieces FROM "SalesOrderLine" WHERE "orderId" = $1 AND kind <> 'FEE'`, [order2])).pieces)
    expect(row.progress.ordered).toBe(goods)
    // The order read (the order page's source) says the same pieces ordered.
    expect((await ok('owner', 'GET', `/sales/orders/${order2}`)).order.progress.ordered).toBe(goods)
  })
})
// ── end B-CW-010 / B-CW-011 / B-CW-012 / B-CW-014 / B-CW-015 ──

// ── B-CW-013 / B-CW-020 (customer Work tab plan §2, §2.8): ready now; nothing is "now" unless the order's stage is current ──
/**
 * Stands on T-CW-A-NOW, a made-up copy of the seeds' SEED-SO-0001 for customer A (CONFIRMED) whose kept row says Ready to ship,
 * Late, waiting on us, with one customer request OPEN on it; and on the seeds' SEED-SO-0002 (its work order SEED-WO-0001 in
 * progress, one released garment on no shipment). States are set past the order's own rules (the guards off: only the read is
 * under test) and put back.
 */
describe('B-CW-013 / B-CW-020 ready now; nothing is "now" for an order waiting for a yes, shipped, delivered, closed or cancelled', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const rulesOff = (statements: string) => admin(`BEGIN; SET LOCAL session_replication_role = replica; ${statements} COMMIT;`)
  const today = () => businessDate(new Date())
  const setStatus = (orderId: string, status: string) =>
    rulesOff(`UPDATE "SalesOrder" SET status = '${status}', "closedAt" = ${status === 'CLOSED' || status === 'CANCELLED' ? 'now()' : 'NULL'}, "cancelReason" = ${status === 'CANCELLED' ? "'Made-up: the customer withdrew it.'" : 'NULL'} WHERE id = '${orderId}';`)
  const COLUMNS = [
    { key: 'number', label: 'Number' },
    { key: 'whereItIs', label: 'Where it is' },
    { key: 'waitingOn', label: 'Waiting on' },
    { key: 'held', label: 'On hold' },
  ]
  let nowOrder: string

  beforeAll(async () => {
    const sales = grantOf('sales', 'all')
    SESSIONS.noWork ??= { audience: 'office', tenantId: T, actorId: PEOPLE.noWork, companyId: companyA, grants: [{ ...sales, permissions: sales.permissions.filter((permission) => permission !== 'workorders.view') }] }
    nowOrder = await copyOrder('T-CW-A-NOW', partyA, dayPlus(40))
    await rulesOff(`INSERT INTO "BrandOrderProduction" (id, "tenantId", "companyId", "partyId", "salesOrderId", key, stage, "stageAt", health, "healthAt", "waitingOn", "waitingSince")
      SELECT '${newId()}', o."tenantId", o."companyId", o."partyId", o.id, 'brand-production:' || o.id, 'READY', now(), 'LATE', now(), 'US', now() FROM "SalesOrder" o WHERE o.id = '${nowOrder}';`)
    await admin(`INSERT INTO "OrderChangeRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, status) SELECT $1, o."tenantId", o."companyId", o."partyId", o.id, 'RUSH', 'OPEN' FROM "SalesOrder" o WHERE o.id = $2`, [newId(), nowOrder])
  }, 120_000)

  it('B-CW-020 current: the kept stage, health and wait; any other state: all null, not held, 0 ready — the open request and the mark stay; the file\'s cells are empty', async () => {
    const current = (await rowOf('owner', 'T-CW-A-NOW', 'production=true')).production
    expect(current).toMatchObject({ stage: 'READY', stageSince: today(), stageByHand: null, health: 'LATE', waitingOn: 'US', held: false, openRequests: 1, openIssues: 0, readyNow: 0, withheld: [] })
    expect(current.since).toEqual(expect.any(String))
    const before = (await filed('owner', 'rows=all', COLUMNS)).rows.find((row) => row.Number === 'T-CW-A-NOW')!
    expect(before['Where it is']).toBe('Ready to ship · Late')
    expect(before['Waiting on']).toBe('Waiting on us')
    try {
      for (const status of ['PENDING_APPROVAL', 'SHIPPED', 'DELIVERED', 'CLOSED', 'CANCELLED']) {
        await setStatus(nowOrder, status)
        const row = await rowOf('owner', 'T-CW-A-NOW', 'production=true')
        expect(row.status, status).toBe(status)
        expect(row.production, status).toMatchObject({ stage: null, stageSince: null, stageByHand: null, health: null, waitingOn: null, since: null, held: false, readyNow: 0 })
        // A request still waits, and the office-only parts stay as they were.
        expect(row.production, status).toMatchObject({ openRequests: 1, openIssues: 0, supervisorMark: current.supervisorMark, withheld: [] })
      }
      // Cancelled: the file writes nothing for "now" (its Status column says where the order is).
      const after = (await filed('owner', 'rows=all', COLUMNS)).rows.find((row) => row.Number === 'T-CW-A-NOW')!
      expect({ where: after['Where it is'], waiting: after['Waiting on'], held: after['On hold'] }).toEqual({ where: '', waiting: '', held: '' })
    } finally {
      await setStatus(nowOrder, 'CONFIRMED')
    }
    // Back to confirmed: the kept row was never touched (the read alone changed).
    expect((await rowOf('owner', 'T-CW-A-NOW', 'production=true')).production).toMatchObject({ stage: 'READY', health: 'LATE', waitingOn: 'US' })
  })

  it("B-CW-013 ready now is the order read's own number for every reader of the order; with a work order on hold the row is held — both only while current", async () => {
    for (const [number, orderId] of [['SEED-SO-0002', order2], ['SEED-SO-0001', order1], ['T-CW-A-NOW', nowOrder]] as const) {
      const row = await rowOf('owner', number, 'production=true')
      expect(row.production.readyNow, number).toBe((await ok('owner', 'GET', `/sales/orders/${orderId}`)).order.progress.readyNow)
    }
    const second = (await rowOf('owner', 'SEED-SO-0002', 'production=true')).production
    expect(second.readyNow).toBeGreaterThan(0) // the seeds: one released garment of SEED-SO-0002 is on no shipment
    // No shipping right and no workorders.view needed: the order read gives the number to every reader of the order.
    expect((await rowOf('noWork', 'SEED-SO-0002', 'production=true')).production.readyNow).toBe(second.readyNow)
    expect((await rowOf('planner', 'SEED-SO-0002', 'production=true')).production.readyNow).toBe(second.readyNow)
    // One live work order of it put on hold, then the order shipped: held and ready only while current.
    const [workOrder] = await admin<{ id: string; status: string }>(
      `SELECT DISTINCT wo.id, wo.status::text AS status FROM "WorkOrder" wo JOIN "WorkOrderSize" c ON c."workOrderId" = wo.id JOIN "SalesOrderLine" l ON l.id = c."salesOrderLineId"
        WHERE l."orderId" = $1 AND wo.kind <> 'REPAIR' AND wo.status NOT IN ('DRAFT', 'CANCELLED', 'ON_HOLD') ORDER BY wo.id LIMIT 1`,
      [order2],
    )
    expect(workOrder).toBeDefined()
    const order = await one<{ status: string }>('SELECT status::text AS status FROM "SalesOrder" WHERE id = $1', [order2])
    await rulesOff(`UPDATE "WorkOrder" SET "heldFromStatus" = status, status = 'ON_HOLD' WHERE id = '${workOrder!.id}';`)
    try {
      expect((await rowOf('owner', 'SEED-SO-0002', 'production=true')).production).toMatchObject({ held: true, readyNow: second.readyNow })
      await rulesOff(`UPDATE "SalesOrder" SET status = 'SHIPPED' WHERE id = '${order2}';`)
      expect((await rowOf('owner', 'SEED-SO-0002', 'production=true')).production).toMatchObject({ stage: null, health: null, waitingOn: null, since: null, held: false, readyNow: 0 })
    } finally {
      await rulesOff(`UPDATE "SalesOrder" SET status = '${order.status}' WHERE id = '${order2}'; UPDATE "WorkOrder" SET status = '${workOrder!.status}', "heldFromStatus" = NULL WHERE id = '${workOrder!.id}';`)
    }
    // Put back: as it read before the hold.
    expect((await rowOf('owner', 'SEED-SO-0002', 'production=true')).production).toMatchObject({ held: second.held, readyNow: second.readyNow })
  })
})
// ── end B-CW-013 / B-CW-020 ──

// ── B-OM-002 (order money tab M1-B3, B9): ONE still-to-pay rule — the row, the order read's `money`; a cancelled order owes 0 ──
// (last in the file: its cancelled copy of an order is no row of the cases above)
describe('B-OM-002 the order read says the row\'s still to pay; a cancelled order owes nothing', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('the Owner reads the same paid and still to pay on the order as on its row; the real Sales and Planner templates read no money', async () => {
    const row = await rowOf('owner', 'SEED-SO-0001')
    const read = (await ok('owner', 'GET', `/sales/orders/${order1}`)).order
    expect(read.money).toMatchObject({ stillToPay: row.balance, paid: row.paid })
    expect(read.money.depositsPaid).toBeGreaterThan(0)
    expect((await ok('limited', 'GET', `/sales/orders/${orderB}`)).order).not.toHaveProperty('money')
    expect((await ok('planner', 'GET', `/sales/orders/${order1}`)).order).not.toHaveProperty('money')
  })

  it('a cancelled order: still to pay 0 on its row and in its read (before: its whole gross for ever)', async () => {
    const cancelled = await copyOrder('T059-A-CX', partyA, dayPlus(20))
    const before = await rowOf('owner', 'T059-A-CX')
    expect(before.balance).toBeGreaterThan(0)
    const order = (await ok('owner', 'GET', `/sales/orders/${cancelled}`)).order
    await ok('owner', 'POST', `/sales/orders/${cancelled}/cancel`, { version: order.version, reason: 'Made-up: the customer stopped the line.' })
    expect((await rowOf('owner', 'T059-A-CX')).balance).toBe(0)
    expect((await ok('owner', 'GET', `/sales/orders/${cancelled}`)).order.money).toMatchObject({ stillToPay: 0, paid: 0 })
  })
})
// ── end B-OM-002 ──
