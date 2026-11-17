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

const PEOPLE = { owner: newId(), planner: newId(), limited: newId() } as const
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
    expect(row.progress).toEqual({
      inWork: cells.reduce((total, cell) => total + cell.quantity, 0),
      cut: sumOrNull(cells.map((cell) => cell.progress.cut)),
      sewn: sumOrNull(cells.map((cell) => cell.progress.sewn)),
      finished: sumOrNull(cells.map((cell) => cell.progress.finished)),
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
    { key: 'atRisk', label: 'At risk' },
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
    expect(file.rows.find((row) => row.Number === 'T059-B-01')!['At risk']).toBe('At risk (2 days left)')
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
